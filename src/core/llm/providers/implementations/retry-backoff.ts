/**
 * @module core/llm/providers/implementations/retry-backoff
 *
 * Shared backoff timing for provider HTTP retry loops. Uses **equal jitter**
 * (AWS "Exponential Backoff And Jitter"): wait at least half the exponential
 * window, then jitter across the upper half. Two properties matter for an
 * overloaded LLM API:
 *
 * 1. The floor (half the exponential) means a 429/529 is never retried
 *    near-instantly — we back off meaningfully before re-hitting a throttled
 *    server.
 * 2. The jitter means a burst of concurrent callers that all 429/529 at the
 *    same moment do NOT retry in lockstep — they spread across the window
 *    instead of re-colliding with the same overload (thundering herd). A bare
 *    `2 ** attempt * 1000` makes every caller wake at the same instant, which
 *    is exactly the failure mode that re-trips a 529 (Anthropic
 *    `overloaded_error`) under a synchronized fan-out.
 *
 * `Retry-After` (when the server sends it) stays authoritative — callers
 * should use the header when present and fall back to this helper otherwise.
 */
export interface RetryBackoffOptions {
  /** First-attempt window before jitter (ms). Default 1000. */
  baseMs?: number;
  /** Hard ceiling on the exponential window (ms). Default 30000. */
  capMs?: number;
  /** Injectable RNG for deterministic tests. Default Math.random. */
  random?: () => number;
}

/**
 * Equal-jitter exponential backoff: returns a delay in `[ceiling/2, ceiling]`
 * where `ceiling = min(capMs, baseMs * 2 ** attempt)`.
 *
 * @param attempt Zero-based retry index (negatives clamp to 0).
 */
export function computeRetryBackoffMs(attempt: number, opts: RetryBackoffOptions = {}): number {
  const baseMs = opts.baseMs ?? 1000;
  const capMs = opts.capMs ?? 30000;
  const random = opts.random ?? Math.random;
  const safeAttempt = Math.max(0, Math.floor(attempt));
  // 2 ** safeAttempt can overflow to Infinity for huge attempts; Math.min with
  // the cap collapses Infinity back to capMs, so the result stays finite.
  const ceiling = Math.min(capMs, baseMs * 2 ** safeAttempt);
  const half = ceiling / 2;
  return Math.round(half + random() * half);
}
