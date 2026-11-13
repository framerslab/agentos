/**
 * @fileoverview The time limit `GMIManager` and `GMI` put on each wait during
 * shutdown, so one GMI that does not finish cannot hold a host's shutdown open.
 * @module backend/agentos/cognitive_substrate/shutdownBound
 */

/** Default bound on a wait during shutdown, in milliseconds (`GMIManagerConfig.shutdownTimeoutMs`). */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;

/** The longest delay setTimeout keeps; Node fires a longer one after 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * `value` when it is a positive number of milliseconds (at most the longest
 * timer delay), else {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}.
 */
export function shutdownTimeoutOrDefault(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_TIMER_DELAY_MS)
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

/**
 * Waits for `work` at most `ms` milliseconds, and no longer than until
 * `signal` aborts.
 *
 * @param work - What to wait for.
 * @param ms - The bound, in milliseconds.
 * @param signal - Ends the wait when it aborts, or at once when it has
 *   aborted already.
 * @returns `true` once `work` settles within the bound, `false` when it has
 *   not by then or `signal` aborted first. A rejection of `work` within the
 *   bound rejects.
 */
export async function settlesWithin(work: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped: (() => void) | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    if (!signal) return;
    stopped = () => resolve(false);
    if (signal.aborted) stopped();
    else signal.addEventListener('abort', stopped, { once: true });
  });
  try {
    return await Promise.race([work.then(() => true as const), expired]);
  } finally {
    clearTimeout(timer);
    if (stopped) signal?.removeEventListener('abort', stopped);
  }
}
