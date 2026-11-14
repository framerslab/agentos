/**
 * @file observers.ts
 * @description Global observer registration for AgentOS LLM usage events.
 *
 * Hosts (Next.js apps, CLI tools, long-running services) register a
 * single callback at boot time. Every {@link generateText} /
 * {@link generateObject} / streamText / streamObject completion fires
 * the callback with the resolved provider, model, usage metrics, and
 * caller-supplied source label.
 *
 * Rationale: pre-2026-05-29, every host that wanted per-call cost
 * telemetry had to wrap each LLM callsite in its own emitter. wilds-ai
 * (50+ callsites across narrator / companion / world-compile / asset
 * judge / etc.) was the canonical example of this duplication. The
 * global observer pattern lets the host register once:
 *
 *   import { setGlobalLlmObserver } from '@framers/agentos';
 *   setGlobalLlmObserver((event) => {
 *     recordFoundationUsageEvent({
 *       meterKey: event.source ?? 'llm.call',
 *       providerKey: event.provider,
 *       modelKey: event.model,
 *       quantity: event.usage.costUSD ?? 0,
 *       unit: 'usd',
 *       ...
 *     });
 *   });
 *
 * And every downstream agentos call automatically flows through. No
 * per-callsite wrappers required.
 *
 * Observer call is fire-and-forget: errors thrown by the host callback
 * are swallowed so telemetry never crashes the LLM call path.
 *
 * @module agentos/api/observers
 */
import type { TokenUsage } from './generateText.js';
import type { SpendBudget } from './runtime/spendBudget.js';
import { createContentSafeConsole } from '../core/logging/contentSafeConsole.js';
import { isContentSafeTelemetryEnabled } from '../core/logging/contentSafeTelemetry.js';

/** This module's fixed diagnostic origin; no runtime name enters telemetry. */
const console = createContentSafeConsole('observers');

/**
 * Payload delivered to a registered usage observer once an LLM call
 * resolves. Mirrors the agentos-side fields that downstream cost /
 * billing systems care about.
 */
export interface LlmUsageEvent {
  /** Resolved provider id (e.g. 'openai', 'anthropic', 'openrouter'). */
  provider: string;
  /** Resolved model id (e.g. 'gpt-4o', 'claude-sonnet-4-6'). */
  model: string;
  /**
   * Aggregated token usage for the call — promptTokens, completionTokens,
   * totalTokens, costUSD, cacheReadTokens, cacheCreationTokens.
   * Mirrors the `usage` field on the GenerateText/Object result.
   */
  usage: TokenUsage;
  /**
   * Opt-in source label set by the caller via the `source` option
   * (e.g. 'narrator_turn', 'companion_reply', 'world_compile_job').
   * Hosts use this to tag emitted rows with their own meter_key.
   */
  source?: string;
  /**
   * Set (>= 1) when this event was served by a provider-fallback leg
   * rather than the requested primary; the value is the hop number.
   * Absent on primary-served calls. Lets hosts tell a leg row from a
   * primary row instead of inferring it from paired token counts —
   * during the 2026-07-20..26 quota outage every diverted call was
   * indistinguishable from primary traffic in cost telemetry.
   */
  fallbackDepth?: number;
  /**
   * Mirrors the `finishReason` on the GenerateText result so observers
   * can distinguish a clean stop from a token-cap truncation.
   */
  finishReason?: string;
  /**
   * True when the model refused the request with a refusal message (OpenAI's refusal), the result's `refusal` being
   * set. `finishReason` is the reason that result reports: `'stop'`, or `'length'` when the output cap cut the message
   * off. Absent on a call the model did not refuse, and on a `streamText` call whose model stream ended on an error
   * or an abort. With `guards` set, the output guards judge the refusal message before the event fires: when they
   * block it, the call rejects (in `streamText`, ends on an `error` part) and the event says `refused: true` beside
   * `finishReason: 'error'`, the one event with both, and the root span has `agentos.api.guard_blocked`. A caller
   * abort while they judge it reports `finishReason: 'error'` with no `refused` (and, in `streamText`, `aborted`).
   * A reply that is not a refusal is reported as the model gave it, whatever the guards then decide.
   */
  refused?: true;
  /**
   * True when the caller's `abortSignal` ended a `streamText` call (`finishReason` is then `'error'`). An aborted call fires an
   * event when it used anything: a stream aborted after the provider read the request reports the input it billed and
   * the output streamed before the abort. Absent on a call that was not aborted.
   */
  aborted?: true;
  /**
   * True when `usage.completionTokens` holds an estimate rather than the provider's count
   * (`usage.completionTokensEstimated`): a stream aborted before the provider sent its output count reports the
   * characters it had streamed at four characters a token. Anthropic sends the output count only on its final
   * `message_delta`, so an Anthropic stream aborted after `message_start` reports its input and cache counts exactly
   * and its output this way. Absent when every count in `usage` is the provider's own.
   */
  usageEstimated?: true;
  /**
   * Which agentos surface fired the event. Lets a single observer
   * route generateText, generateObject, generateImage, embedText, etc.
   * into different meters when needed.
   */
  surface:
    | 'generateText'
    | 'generateObject'
    | 'streamText'
    | 'streamObject'
    | 'embedText'
    | 'generateImage';
  /**
   * Wall-clock duration of the whole call in milliseconds, measured from
   * surface entry (post-option parse, pre-routing) to the moment the
   * observer fires. For streaming surfaces this spans the full stream —
   * first byte through final chunk — not just time-to-first-token.
   *
   * Fallback semantics: on a provider-fallback, `generateText` fires ONE
   * event (from the winning hop) whose `durationMs` is threaded to span the
   * whole call — failed primary attempts included — so a slow fallback turn
   * reads as slow. `streamText` instead fires one event per hop: the inner
   * hop event times that hop, and an aggregate outer event times the whole
   * call. Either way `durationMs` is never less than the time the caller
   * actually waited on the event that carries the final result.
   *
   * Optional so hosts tolerate events from older agentos versions.
   */
  durationMs?: number;
  /**
   * Time-to-first-part for streaming surfaces, in milliseconds: surface
   * entry to the first StreamPart yielded to the consumer (text or
   * tool-call alike). Undefined on non-streaming surfaces and when the
   * stream errored before producing any part. The latency triage
   * counterpart to `durationMs` — a high ttfb with a short remainder
   * points at routing/prefill; the inverse points at generation length.
   */
  ttfbMs?: number;
  /**
   * Upstream host that actually served the call when the provider is an
   * aggregator (OpenRouter: Groq, DeepInfra, ...). Mirrors the
   * `servingProvider` response telemetry; absent for direct providers
   * and surfaces that don't track it.
   */
  servingProvider?: string;
  /**
   * The account the call ran for: the account its spend budget names
   * (`SpendBudgetOptions.accountId`, the nearest one up the `parent` chain), or
   * else what the call's `accountIdOf` option answers. Absent when neither names one,
   * so a host can tag its rows without inferring the account.
   */
  accountId?: string;
}

/** What a call's `accountIdOf` option is told about the usage event it names an account for. */
export interface LlmUsageAccountContext {
  /** The event's provider id. */
  provider: string;
  /** The event's model id. */
  model: string;
  /** The event's source label, when the call set one. */
  source?: string;
  /** The surface firing the event. */
  surface: LlmUsageEvent['surface'];
}

/**
 * Names the account of a call whose spend budget names none. Asked for each usage event that is about to reach an
 * observer, so it runs on the LLM call path and returns at once. Returning `undefined` or an empty string leaves
 * {@link LlmUsageEvent.accountId} absent, and so does throwing: the throw is logged by its built-in error type alone
 * and the call goes on. A promise is no account either; one that rejects is handled and logged the same way.
 */
export type LlmUsageAccountResolver = (context: LlmUsageAccountContext) => string | undefined;

/**
 * Where a call's usage events read their account.
 *
 * @internal
 */
export interface LlmUsageAccountSource {
  /** The call's spend budget. */
  budget?: SpendBudget;
  /** The call's `accountIdOf` option. */
  accountIdOf?: LlmUsageAccountResolver;
}

/**
 * Observer callback signature. May return a promise; agentos waits on
 * it only with `void` (no backpressure on the LLM call path).
 */
export type LlmUsageObserver = (event: LlmUsageEvent) => void | Promise<void>;

let globalObserver: LlmUsageObserver | null = null;

/**
 * Register (or clear) the process-wide LLM usage observer.
 *
 * Hosts typically call this once at app boot:
 *
 *   ```ts
 *   setGlobalLlmObserver((event) => {
 *     recordFoundationUsageEvent({
 *       meterKey: event.source ?? 'llm.call',
 *       providerKey: event.provider,
 *       modelKey: event.model,
 *       quantity: event.usage.costUSD ?? 0,
 *       unit: 'usd',
 *     });
 *   });
 *   ```
 *
 * Passing `null` clears the observer (useful in tests).
 *
 * While content-safe telemetry is on (`enableContentSafeTelemetry`), the observer is not called;
 * read usage from the call's result instead.
 *
 * @param observer - The observer callback, or null to clear.
 */
export function setGlobalLlmObserver(observer: LlmUsageObserver | null): void {
  globalObserver = observer;
}

/**
 * Returns the currently-registered global observer, or null when
 * unregistered. Exposed so internal agentos code can short-circuit
 * the dispatcher when nothing is wired (saves the allocation +
 * try/catch on every LLM call).
 *
 * @internal
 */
export function getGlobalLlmObserver(): LlmUsageObserver | null {
  return globalObserver;
}

/** The account an event's call names: its budget's, or else its resolver's, whose failure leaves the event without one. */
function accountIdOfEvent(event: LlmUsageEvent, account: LlmUsageAccountSource): string | undefined {
  const fromBudget = account.budget?.accountIdForUsage();
  if (fromBudget !== undefined || !account.accountIdOf) return fromBudget;
  try {
    const named: unknown = account.accountIdOf({
      provider: event.provider,
      model: event.model,
      ...(event.source !== undefined ? { source: event.source } : {}),
      surface: event.surface,
    });
    if (named !== null && (typeof named === 'object' || typeof named === 'function') && typeof (named as { then?: unknown }).then === 'function') {
      // A promise is no account, and a rejected one must not become an unhandled rejection.
      void Promise.resolve(named).catch((err: unknown) => warnResolverFailed('rejected', err));
      return undefined;
    }
    return typeof named === 'string' && named !== '' ? named : undefined;
  } catch (err) {
    warnResolverFailed('threw', err);
    return undefined;
  }
}

/**
 * Logs one line for a failed `accountIdOf`, naming a fixed error type alone: the message, and the `name` a host can
 * set on its error, can hold the account or a person's details.
 */
function warnResolverFailed(how: 'threw' | 'rejected', err: unknown): void {
  let kind: string;
  try {
    kind =
      err instanceof TypeError ? 'TypeError'
      : err instanceof RangeError ? 'RangeError'
      : err instanceof SyntaxError ? 'SyntaxError'
      : err instanceof ReferenceError ? 'ReferenceError'
      : err instanceof URIError ? 'URIError'
      : err instanceof EvalError ? 'EvalError'
      : err instanceof Error ? 'Error'
      : typeof err;
  } catch {
    // `instanceof` throws for a revoked proxy; `typeof` never throws.
    kind = typeof err;
  }
  // eslint-disable-next-line no-console
  console.warn(`[agentos.onUsage] accountIdOf ${how} ${kind}; the event carries no accountId`);
}

/**
 * Internal dispatcher called by every agentos LLM-resolving surface
 * (generateText/generateObject/etc.) immediately before returning to
 * the caller. Fire-and-forget — errors thrown by the host observer
 * are caught + logged to stderr so a misbehaving observer can never
 * crash the LLM call path.
 *
 * No-op when no observer is registered, and while content-safe telemetry is on.
 *
 * @param event - The event. An `accountId` set on it stays.
 * @param account - Where the event reads its account when it carries none: read only here, past the no-op checks, so a
 *   host's `accountIdOf` is not asked for an event nothing will hear.
 *
 * @internal
 */
export function fireLlmUsageObserver(event: LlmUsageEvent, account?: LlmUsageAccountSource): void {
  if (isContentSafeTelemetryEnabled()) return;
  const cb = globalObserver;
  if (!cb) return;
  try {
    const accountId = event.accountId === undefined && account ? accountIdOfEvent(event, account) : undefined;
    const result = cb(accountId === undefined ? event : { ...event, accountId });
    if (result && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[agentos.onUsage] observer promise rejected:', err);
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[agentos.onUsage] observer threw synchronously:', err);
  }
}
