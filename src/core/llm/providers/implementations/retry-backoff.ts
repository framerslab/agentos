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

/**
 * Waits `ms` before a retry, or less when `signal` fires first: the caller's
 * abort ends the wait at once, so the retry loop's own abort check reports it
 * instead of sleeping out a long Retry-After. Resolves at once for a signal
 * that has already fired or a wait of zero or less.
 */
export function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || !(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The most requests one call may send, a first and its retries together: the
 * call's own `maxAttempts` when it names one, else the provider's configured
 * count. Key hops inside an attempt are not counted here.
 *
 * @param requested The call's `ModelCompletionOptions.maxAttempts`.
 * @param configured The provider's own count, used when `requested` is left out.
 * @throws {RangeError} When `requested` is not a whole number of 1 or more; nothing is sent.
 */
export function resolveAttemptCount(requested: number | undefined, configured: number): number {
  if (requested === undefined) return configured;
  if (!Number.isInteger(requested) || requested < 1) throw new RangeError('maxAttempts is a whole number, 1 or more');
  return requested;
}

/**
 * The attempts one request has sent, filled in by a provider's request loop
 * (key hops inside an attempt are not counted). A call that sends a request
 * again on another route after it failed (a retired model id's alias, a
 * request without its schema) gives that request only what is left of the
 * call's count.
 */
export interface AttemptTally {
  /** Attempts sent so far, a first and its retries together. */
  sent: number;
}
