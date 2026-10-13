/**
 * The sends an outbox's `sendClaimed` has under way, by run, so that `purgeContent` for a run can abort the ones that
 * have not written their body yet. Shared by the built-in outboxes; not part of the barrel.
 */

/** The sends under way, by run: the controller of each, which a purge of its run aborts. */
export type ClaimedSends = Map<string, Set<AbortController>>;

/**
 * Runs `work`, one claimed send of a delivery of `runId`, with a signal that {@link abortClaimedSends} for the run
 * aborts; registered before `work` starts, so a purge that lands while `work` re-reads its row reaches it too. Answers
 * what `work` answers. A rejection after that abort answers false, a send the purge cancelled; any other rejection is
 * `work`'s.
 *
 * @param claims - The outbox's sends under way.
 * @param runId - The run of the delivery `work` sends.
 * @param work - Re-reads the delivery and sends it under the signal; true when it sent, false when it skipped it.
 */
export async function runClaimedSend(claims: ClaimedSends, runId: string, work: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
  const controller = new AbortController();
  const running = claims.get(runId) ?? new Set<AbortController>();
  claims.set(runId, running.add(controller));
  try {
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return false;
    throw error;
  } finally {
    running.delete(controller);
    if (running.size === 0 && claims.get(runId) === running) claims.delete(runId);
  }
}

/**
 * Aborts every claimed send of `runId` under way.
 *
 * @param claims - The outbox's sends under way.
 * @param runId - The run a purge emptied.
 */
export function abortClaimedSends(claims: ClaimedSends, runId: string): void {
  for (const controller of claims.get(runId) ?? []) controller.abort();
}
