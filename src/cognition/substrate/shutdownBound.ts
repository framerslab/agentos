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
 * Waits for `work` at most `ms` milliseconds.
 *
 * @returns `true` once `work` settles within the bound, `false` when it has
 *   not by then. A rejection of `work` within the bound rejects.
 */
export async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}
