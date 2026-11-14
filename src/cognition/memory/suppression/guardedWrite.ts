/**
 * @module memory/suppression/guardedWrite
 *
 * One write of a subject's memory, checked against the forgotten-user ledger before it is made and again after it
 * lands, so a write that was already running when the subject was forgotten does not stay.
 */
import type { ForgottenLedger, SuppressionSubject } from './ForgottenLedger.js';

/**
 * One write of a subject's memory: the tombstone is read, the write is made, the tombstone is read again, and a write
 * that landed after a tombstone is taken back. A second read that fails takes the write back and rethrows.
 *
 * @param ledger - Where the subject's tombstone is read.
 * @param subject - Whose memory the write is.
 * @param write - Makes the write; not called when the subject is already forgotten.
 * @param takeBack - Deletes what `write` made, for good.
 * @returns `written` with the write's result, or `refused` when the subject was forgotten before the write or while
 *   it ran (then nothing of it is left).
 * @throws What the first read or the write throws (nothing is left to take back), or what the second read throws once
 *   the write is taken back.
 */
export async function guardedWrite<T>(
  ledger: Pick<ForgottenLedger, 'isForgotten'>,
  subject: SuppressionSubject,
  write: () => Promise<T>,
  takeBack: (result: T) => Promise<void>,
): Promise<{ status: 'written'; result: T } | { status: 'refused' }> {
  if (await ledger.isForgotten(subject)) return { status: 'refused' };
  const result = await write();
  let forgotten: boolean;
  try {
    forgotten = await ledger.isForgotten(subject);
  } catch (error) {
    // Unknown whether the subject was forgotten meanwhile: the write does not stay.
    await takeBack(result);
    throw error;
  }
  if (!forgotten) return { status: 'written', result };
  await takeBack(result);
  return { status: 'refused' };
}
