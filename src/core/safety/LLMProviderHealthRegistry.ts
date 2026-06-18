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
  const obj = error as { message?: unknown; statusCode?: unknown; status?: unknown };
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
  return null;
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
   */
  recordFailure(providerId: string, error: unknown): void {
    const status = classifyErrorStatus(error);
    // A client-error 4xx (bad request / unknown model / unprocessable) is the
    // caller's fault, not a provider-health signal — ignore it entirely so it
    // neither trips the breaker nor inflates the streak.
    if (isNonHealthClientError(status)) return;
    const policy = policyForStatus(status);
    const record = this.records.get(providerId) ?? this.makeRecord();
    record.failureCount += 1;
    record.lastStatusCode = status;
    record.lastFailureAt = Date.now();
    if (record.failureCount >= policy.threshold) {
      // Trip: but only count this as a new trip event if the
      // breaker was previously closed.
      if (record.openUntil === 0 || Date.now() >= record.openUntil) {
        record.totalTrips += 1;
      }
      record.openUntil = Date.now() + policy.cooldownMs;
    }
    this.records.set(providerId, record);
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
