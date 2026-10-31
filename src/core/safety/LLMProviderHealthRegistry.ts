/**
 * @file LLMProviderHealthRegistry.ts
 * @module @framers/agentos/core/safety/LLMProviderHealthRegistry
 * @description
 * Process-lifetime memory of LLM provider health, indexed by `providerId`.
 *
 * **The problem this solves.** The `generateText` / `streamText` fallback
 * chain walks providers correctly inside a single call (try OpenRouter ->
 * on 402, fall back to OpenAI). But each *new* call starts over from
 * scratch. When OpenRouter is in a sustained 402 state (credits
 * exhausted), every subsequent call still tries OpenRouter first, eats
 * the TLS round-trip + the 402 response, then falls back. Across a long
 * batch job (compile-time enrichment, backfill sweeps), this stacks up
 * to minutes of pure wasted latency.
 *
 * **What this adds.** A status-aware circuit breaker per provider.
 * After the first 402 / 401 / 403, subsequent `isOpen()` checks return
 * `true` for a cooldown window, so the caller can skip that provider
 * entirely without retrying. Transient classes (429, 5xx) require a
 * small streak before tripping the breaker, matching the "still worth
 * trying" semantics of rate limits and intermittent server errors.
 *
 * | Error class                | Threshold | Cooldown |
 * | -------------------------- | --------- | -------- |
 * | 402 insufficient credits   | 1 fail    | 5 min    |
 * | 401, 403 auth/forbidden    | 1 fail    | 30 min   |
 * | 429 rate limit             | 3 fails   | 30 s     |
 * | 5xx + unclassifiable       | 5 fails   | 60 s     |
 *
 * The cooldown numbers reflect operational realities: a 402 might
 * resolve in minutes once the operator tops up credits, while a 401
 * usually means a bad key that needs an env change + redeploy, so a
 * longer cool-down avoids hammering the provider while the human fix
 * is in flight. 429 cool-downs are intentionally short because rate
 * limits typically lift in a single billing interval.
 *
 * **Design constraints.**
 * - Pure in-process state. No external store, no IPC. The registry is
 *   reset on every server restart by design: provider state is
 *   ephemeral and rediscovered on the next call.
 * - Time-source via `Date.now()` so vitest's `vi.useFakeTimers()` can
 *   advance the clock deterministically in tests.
 * - The error classifier is intentionally forgiving: it reads from a
 *   `[NNN]` prefix in the message (the shape `OpenRouterProvider`
 *   already emits), from `error.statusCode`, OR from `error.status`
 *   (the Anthropic SDK shape). An error with no extractable code is
 *   treated as transient: better to under-protect than to lock out a
 *   healthy provider on a one-off network blip.
 * - `recordSuccess()` clears the streak counter but does NOT shorten a
 *   currently-open cooldown. The breaker stays open until the cooldown
 *   expires; a successful probe doesn't reset the wall clock, since
 *   the breaker is open precisely because we want to stop probing for
 *   a window.
 *
 * **Why not reuse the existing `CircuitBreaker`?** That primitive uses
 * a single failure-threshold + cooldown pair per instance. The
 * status-aware policy here needs per-error-class behavior: a single
 * config can't express "open on 1 failure for 402 but 3 for 429" with
 * the same instance. A bespoke registry is shorter and clearer than
 * juggling four breakers per provider.
 *
 * @example Wiring into the fallback router
 * ```ts
 * import { globalLLMProviderHealth } from '@framers/agentos/core/safety/LLMProviderHealthRegistry';
 *
 * // Before the primary call:
 * if (globalLLMProviderHealth.isOpen(primaryProviderId)) {
 *   // Skip the primary entirely; go straight to the fallback chain.
 *   return tryFallbackChain(...);
 * }
 *
 * try {
 *   const result = await callPrimary();
 *   globalLLMProviderHealth.recordSuccess(primaryProviderId);
 *   return result;
 * } catch (err) {
 *   globalLLMProviderHealth.recordFailure(primaryProviderId, err);
 *   throw err;
 * }
 * ```
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE } from '../llm/providers/errors/errorCodes.js';
import { classifyKeyFailure } from '../providers/quotaErrors.js';
import { createContentSafeConsole } from '../logging/contentSafeConsole.js';

/** This module's fixed diagnostic origin; no runtime name enters telemetry. */
const console = createContentSafeConsole('provider_health');

/** Snapshot of breaker state for a single provider. */
export interface LLMProviderHealthStats {
  /** Provider id this snapshot describes. */
  providerId: string;
  /** Whether the breaker is currently open. */
  state: 'closed' | 'open';
  /** Milliseconds remaining until the breaker re-closes (0 when closed). */
  cooldownRemainingMs: number;
  /** Number of failures accumulated within the streak window. */
  failureCount: number;
  /** Last HTTP status code observed for this provider (null if never failed). */
  lastStatusCode: number | null;
  /** Wall-clock ms when the last failure was recorded. */
  lastFailureAt: number | null;
  /** Total number of times this provider has tripped open. */
  totalTrips: number;
}

interface ProviderHealthRecord {
  /** Wall-clock ms when the breaker re-closes (0 = closed). */
  openUntil: number;
  /** Failure streak count toward the threshold. */
  failureCount: number;
  /** Last HTTP status code observed. */
  lastStatusCode: number | null;
  /** Wall-clock ms of the most recent failure. */
  lastFailureAt: number | null;
  /** Total number of open transitions seen for this provider. */
  totalTrips: number;
}

interface ErrorPolicy {
  /** Number of failures before the breaker trips. */
  threshold: number;
  /** Cooldown applied when the breaker trips. */
  cooldownMs: number;
}

const POLICY_402: ErrorPolicy = { threshold: 1, cooldownMs: 5 * 60_000 };
const POLICY_AUTH: ErrorPolicy = { threshold: 1, cooldownMs: 30 * 60_000 };
const POLICY_429: ErrorPolicy = { threshold: 3, cooldownMs: 30_000 };
const POLICY_TRANSIENT: ErrorPolicy = { threshold: 5, cooldownMs: 60_000 };

/**
 * Extract an HTTP status code from a thrown error. Reads, in order:
 * 1. `[NNN] ...` prefix in `error.message`: matches the shape
 *    `OpenRouterProvider` decorates its errors with so the existing
 *    `isRetryableError` regex can route on them.
 * 2. `error.statusCode` numeric property: `OpenRouterProviderError`
 *    sets this explicitly.
 * 3. `error.status` numeric property: the Anthropic / OpenAI SDK
 *    shape.
 *
 * Returns `null` when no status code can be extracted; the caller
 * treats that as the conservative transient class.
 *
 * @internal
 */
export function classifyErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const obj = error as {
    message?: unknown;
    statusCode?: unknown;
    status?: unknown;
    httpStatus?: unknown;
  };
  // 1. Prefix in message
  if (typeof obj.message === 'string') {
    const match = obj.message.match(/^\[(\d{3})\]/);
    if (match) {
      const code = parseInt(match[1]!, 10);
      if (Number.isFinite(code) && code >= 100 && code < 600) return code;
    }
  }
  // 2. statusCode property
  if (typeof obj.statusCode === 'number' && obj.statusCode >= 100 && obj.statusCode < 600) {
    return obj.statusCode;
  }
  // 3. status property
  if (typeof obj.status === 'number' && obj.status >= 100 && obj.status < 600) {
    return obj.status;
  }
  // 4. httpStatus property: OpenAIProviderError carries the HTTP status
  //    here (and no [NNN] message prefix) — without this shape a direct
  //    OpenAI failure classified null/transient, which is exactly how
  //    the 2026-07-20..26 quota outage dodged the billing breaker.
  if (typeof obj.httpStatus === 'number' && obj.httpStatus >= 100 && obj.httpStatus < 600) {
    return obj.httpStatus;
  }
  return null;
}

/**
 * Detect billing/quota exhaustion hiding behind a 429. OpenAI reports a
 * dead account (`insufficient_quota`) with HTTP 429 — the same status as
 * a transient rate limit — but the semantics are a billing outage: it
 * does not lift until a human tops up the account. Left in the 429
 * class the breaker flaps on a 30s cooldown forever (observed 6 days of
 * quiet cross-provider divert, 2026-07-20..26, thousands of uncacheable
 * fallback-leg calls), so it must ride the 402 billing class instead:
 * single-failure trip, minutes-long window, error-level loud event.
 *
 * Reads the OpenAI SDK error shape (`code` / `type`, incl. the nested
 * `error.error.code` body) and falls back to the distinctive message.
 * Anthropic reports the same billing outage as HTTP 400
 * invalid_request_error ("credit balance is too low"; some surfaces use
 * a `billing_error` type) — matched here so a client-error transport
 * status cannot smuggle a dead account past the breaker as a caller bug.
 * Its spend limits are matched the same way: the HTTP 400 "You have
 * reached your specified (workspace) API usage limits" for a limit the
 * operator set, and the HTTP 429 "You have reached your API usage limits"
 * (`error.details.error_code` `enforced_spend_limit_reached`) for the
 * tier's monthly cap, which the 429 class would flap on every 30 seconds
 * until the month turns. The message is matched by the documented
 * opening ("You have reached your [specified [workspace]] API usage
 * limits"), never by "api usage limits" alone, so a request's own 400
 * that names such a parameter stays the caller's. A 400 or 429 whose
 * `details` carry the answer's error envelope is also read by the key
 * pool's own classifier, so the breaker and the pool cannot name a
 * billing answer differently.
 *
 * @internal
 */
export function isQuotaExhaustion(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const obj = error as {
    code?: unknown;
    type?: unknown;
    message?: unknown;
    error?: { code?: unknown; type?: unknown } | null;
    openaiErrorCode?: unknown;
    openaiErrorType?: unknown;
  };
  const marks = [
    obj.code,
    obj.type,
    obj.error?.code,
    obj.error?.type,
    // OpenAIProviderError's own field names for the same signals.
    obj.openaiErrorCode,
    obj.openaiErrorType,
  ];
  if (marks.some((m) => m === 'insufficient_quota' || m === 'billing_error')) return true;
  if (
    typeof obj.message === 'string' &&
    /insufficient_quota|exceeded your current quota|credit balance is too low|you have reached your (?:specified (?:workspace )?)?api usage limits/i.test(
      obj.message,
    )
  ) {
    return true;
  }
  return isBillingEnvelope(error);
}

/**
 * Whether a 400 or 429 provider error carries, in `details`, an answer body
 * the key pool's {@link classifyKeyFailure} reads as `billing`. Every other
 * status already rides the policy its class needs. A `details` that does not
 * serialize (a circular transport object) is no evidence.
 */
function isBillingEnvelope(error: object): boolean {
  const { httpStatus, details } = error as { httpStatus?: unknown; details?: unknown };
  if (typeof httpStatus !== 'number' || (httpStatus !== 400 && httpStatus !== 429)) return false;
  if (!details || typeof details !== 'object') return false;
  let body: string;
  try {
    body = JSON.stringify(details);
  } catch {
    return false;
  }
  return classifyKeyFailure(httpStatus, body) === 'billing';
}

function policyForStatus(status: number | null): ErrorPolicy {
  if (status === 402) return POLICY_402;
  if (status === 401 || status === 403) return POLICY_AUTH;
  if (status === 429) return POLICY_429;
  // 5xx + null (unclassifiable) all fall through to transient.
  return POLICY_TRANSIENT;
}

/**
 * A 4xx that reflects a bad request rather than provider health — the provider
 * is up and answering; the CALLER's request was wrong (malformed body, unknown
 * model, unprocessable params). These must not count toward the breaker, or a
 * caller bug would disable a healthy provider (and would inflate the streak a
 * later transient 5xx then trips on). Account-level (401/402/403), request
 * timeout (408), and rate-limit (429) are deliberately excluded — those DO
 * warrant failover and keep their own policies.
 */
function isNonHealthClientError(status: number | null): boolean {
  if (status === null || status < 400 || status >= 500) return false;
  return status !== 401 && status !== 402 && status !== 403 && status !== 408 && status !== 429;
}

/** `code` / `type` values a provider puts on a content-policy decline. */
const CONTENT_POLICY_MARKS: ReadonlySet<string> = new Set([
  'content_filter',
  'content_policy_violation',
  'safety_violations',
]);

/**
 * A request larger than the model's context window is a verdict on the
 * request: the provider answered, or was never asked. Counting it would trip
 * a healthy provider's breaker on long conversations.
 */
function isRequestTooLarge(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === CONTEXT_WINDOW_EXCEEDED_CODE
  );
}

/**
 * A content-policy decline (an Anthropic refusal, a Gemini safety block, an
 * OpenAI content-policy rejection) is a verdict on the request: the provider
 * is up and answered. These errors often carry no HTTP status, which
 * classifies as the transient class, so without this check five refused
 * prompts in a row would open the breaker and divert every later call away
 * from a healthy provider.
 */
function isContentPolicyDecline(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, type } = error as { code?: unknown; type?: unknown };
  return [code, type].some(
    (mark) => typeof mark === 'string' && CONTENT_POLICY_MARKS.has(mark.toLowerCase()),
  );
}

/**
 * A provider's `ALL_KEYS_FAILED` whose `details.retryAfterMs` is 0: every key
 * of its pool is out, but a key's recheck is due, so a probe was just started
 * or is running and may bring the key back at once. That is no verdict on the
 * provider yet: counted, it would re-open the breaker for another full window
 * at the very call that half-closed it, while the probe passes a second later.
 * Once the probe fails, the key's next recheck is later, `retryAfterMs` is
 * above 0, and the next such error trips the breaker as before.
 */
function isRecheckDue(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, details } = error as { code?: unknown; details?: unknown };
  if (code !== 'ALL_KEYS_FAILED' || !details || typeof details !== 'object') return false;
  return (details as { retryAfterMs?: unknown }).retryAfterMs === 0;
}

/**
 * The most per-credential records the registry keeps: one for each key or
 * base URL of a caller's own that failed (see `providerHealthKey`). A
 * service that passes each tenant's key would otherwise keep one per key for
 * the life of the process.
 */
export const MAX_SCOPED_HEALTH_RECORDS = 256;

/**
 * Per-process registry of provider health. Construct once per agentos
 * runtime; the module-level `globalLLMProviderHealth` singleton is
 * what the in-tree router code uses. Tests instantiate their own
 * registry to keep state isolated per test case.
 *
 * @public
 */
export class LLMProviderHealthRegistry {
  private readonly records: Map<string, ProviderHealthRecord> = new Map();

  /**
   * Drops the per-credential records (ids with an `@` scope, from
   * `providerHealthKey`) that failed least recently, past
   * {@link MAX_SCOPED_HEALTH_RECORDS}. A dropped key's next call is tried
   * again. The providers' own records are kept.
   */
  private evictScopedRecords(): void {
    let scoped = 0;
    for (const id of this.records.keys()) if (id.includes('@')) scoped += 1;
    for (const id of this.records.keys()) {
      if (scoped <= MAX_SCOPED_HEALTH_RECORDS) return;
      if (id.includes('@')) {
        this.records.delete(id);
        scoped -= 1;
      }
    }
  }

  /**
   * Returns `true` when the named provider's breaker is open. Callers
   * should skip the provider entirely while open: going past `isOpen`
   * defeats the whole point of the registry (paying the network
   * round-trip for a known-bad provider).
   */
  isOpen(providerId: string): boolean {
    const record = this.records.get(providerId);
    if (!record) return false;
    if (record.openUntil === 0) return false;
    if (Date.now() >= record.openUntil) {
      // Cooldown elapsed: half-close: reset the breaker so the next
      // failure starts a fresh streak count, but allow the call through.
      record.openUntil = 0;
      record.failureCount = 0;
      return false;
    }
    return true;
  }

  /**
   * Record a failed attempt against the provider. Classifies the
   * error by HTTP status (see {@link classifyErrorStatus}) and either
   * trips the breaker (for permanent classes 401/402/403) or
   * increments the streak counter toward the threshold for transient
   * classes (429, 5xx, unclassifiable).
   *
   * Safe to call regardless of whether the breaker is already open:
   * a repeat failure on an open breaker just refreshes the
   * cooldown for the new error class.
   *
   * A content-policy decline, a context-window rejection and a key pool's
   * `ALL_KEYS_FAILED` whose `retryAfterMs` is 0 (a key's probe is due or
   * running) are ignored entirely (see {@link isContentPolicyDecline},
   * {@link isRequestTooLarge} and {@link isRecheckDue}): they neither trip the
   * breaker nor count toward a streak.
   */
  recordFailure(providerId: string, error: unknown): void {
    if (isContentPolicyDecline(error)) return;
    if (isRequestTooLarge(error)) return;
    if (isRecheckDue(error)) return;
    const status = classifyErrorStatus(error);
    // Billing/quota exhaustion is provider health regardless of the
    // transport status it wears: OpenAI reports it as 429, Anthropic as
    // 400 invalid_request_error ("credit balance is too low"). Detect it
    // BEFORE the client-error drop — classifying by status first routed
    // Anthropic credit exhaustion into the 4xx ignore branch, leaving the
    // breaker fully blind to an Anthropic billing outage.
    const quotaExhausted = isQuotaExhaustion(error);
    // A client-error 4xx (bad request / unknown model / unprocessable) is the
    // caller's fault, not a provider-health signal — ignore it entirely so it
    // neither trips the breaker nor inflates the streak. Quota exhaustion is
    // exempt: it wears client-error statuses but is an account-level outage.
    if (!quotaExhausted && isNonHealthClientError(status)) return;
    const policy = quotaExhausted ? POLICY_402 : policyForStatus(status);
    const record = this.records.get(providerId) ?? this.makeRecord();
    record.failureCount += 1;
    record.lastStatusCode = status;
    record.lastFailureAt = Date.now();
    if (record.failureCount >= policy.threshold) {
      // Trip: but only count this as a new trip event if the
      // breaker was previously closed.
      if (record.openUntil === 0 || Date.now() >= record.openUntil) {
        record.totalTrips += 1;
        // Loud, structured trip event. The policy classes (401/403 bad
        // key, 402 billing) open a 5-30 minute breaker after a SINGLE
        // failure and silently divert every call cross-provider for the
        // whole cooldown — ops must see the moment it opens, not
        // discover the divert in cost attribution later. Availability
        // trips stay at warn.
        const isPolicyClass =
          quotaExhausted || status === 401 || status === 402 || status === 403;
        const detail = {
          event: 'provider_breaker_open',
          providerId,
          statusCode: status ?? null,
          cooldownMs: policy.cooldownMs,
          totalTrips: record.totalTrips,
        };
        if (isPolicyClass) {
          const classLabel = quotaExhausted ? 'quota exhausted' : `auth/billing class ${status}`;
          console.error(
            `[agentos] provider breaker OPEN for '${providerId}' (${classLabel}): ` +
              `ALL traffic diverts to fallbacks for ${Math.round(policy.cooldownMs / 60_000)} min`,
            detail,
          );
        } else {
          console.warn(
            `[agentos] provider breaker OPEN for '${providerId}' (status ${status ?? 'network'})`,
            detail,
          );
        }
      }
      record.openUntil = Date.now() + policy.cooldownMs;
    }
    // Most recent failure last: the map's order is the order the
    // per-credential records are dropped in.
    this.records.delete(providerId);
    this.records.set(providerId, record);
    if (providerId.includes('@')) this.evictScopedRecords();
  }

  /**
   * Record a successful attempt against the provider. Resets the
   * streak counter so a future transient failure starts fresh, but
   * does NOT shorten an already-open cooldown (the breaker is open
   * precisely because we want to stop probing).
   */
  recordSuccess(providerId: string): void {
    const record = this.records.get(providerId);
    if (!record) return;
    record.failureCount = 0;
  }

  /**
   * Clear all state for a single provider, or for every provider
   * when called without an id. Used by tests to isolate state across
   * cases; production callers generally don't need this: the
   * cooldown logic + success path handles everything.
   */
  reset(providerId?: string): void {
    if (providerId === undefined) {
      this.records.clear();
      return;
    }
    this.records.delete(providerId);
  }

  /**
   * Read-only snapshot for diagnostics / admin endpoints. Returns
   * `null` when the provider has never been touched (no failures, no
   * successes recorded).
   */
  getStats(providerId: string): LLMProviderHealthStats | null {
    const record = this.records.get(providerId);
    if (!record) return null;
    const now = Date.now();
    const cooldownRemainingMs = Math.max(0, record.openUntil - now);
    const state: 'closed' | 'open' = cooldownRemainingMs > 0 ? 'open': 'closed';
    return {
      providerId,
      state,
      cooldownRemainingMs,
      failureCount: record.failureCount,
      lastStatusCode: record.lastStatusCode,
      lastFailureAt: record.lastFailureAt,
      totalTrips: record.totalTrips,
    };
  }

  private makeRecord(): ProviderHealthRecord {
    return {
      openUntil: 0,
      failureCount: 0,
      lastStatusCode: null,
      lastFailureAt: null,
      totalTrips: 0,
    };
  }
}

/**
 * Process-singleton registry that the in-tree `generateText` /
 * `streamText` fallback router consults before every primary-provider
 * attempt. Tests should construct their own `LLMProviderHealthRegistry`
 * instance and inject it via the dependency-injected `opts.healthRegistry`
 * field rather than reaching into this singleton: that keeps the
 * global state stable across the test run.
 */
export const globalLLMProviderHealth: LLMProviderHealthRegistry = new LLMProviderHealthRegistry();
