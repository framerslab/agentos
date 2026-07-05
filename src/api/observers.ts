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
   * Mirrors the `finishReason` on the GenerateText result so observers
   * can distinguish a clean stop from a token-cap truncation.
   */
  finishReason?: string;
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

/**
 * Internal dispatcher called by every agentos LLM-resolving surface
 * (generateText/generateObject/etc.) immediately before returning to
 * the caller. Fire-and-forget — errors thrown by the host observer
 * are caught + logged to stderr so a misbehaving observer can never
 * crash the LLM call path.
 *
 * No-op when no observer is registered.
 *
 * @internal
 */
export function fireLlmUsageObserver(event: LlmUsageEvent): void {
  const cb = globalObserver;
  if (!cb) return;
  try {
    const result = cb(event);
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
