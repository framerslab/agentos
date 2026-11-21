/**
 * @file memoryWriteRecord.ts
 * The record of one session turn's memory writes, which the turn's result carries as `memoryWrite`: for each side of
 * the turn that had text, whether it was written, skipped or failed. It holds trace ids, outcomes, reasons and error
 * class names, never the turn's text and never an error's message.
 *
 * @module api/runtime/memoryWriteRecord
 */

/**
 * What became of one side of a turn in memory.
 *
 * - `written`: the side was filed as the trace `traceId`.
 * - `skipped`: the agent's rules filed nothing, for `reason`:
 *   - `policy_off`: the account's policy keeps no long-term memory.
 *   - `policy_failed`: the host's policy hook threw, timed out or answered something else.
 *   - `minor_no_retention`: the policy marks the person a minor, on a store that would keep their memory until
 *     deletion.
 *   - `screened`: the host's screen hook dropped the text.
 *   - `screen_failed`: the host's screen hook threw, timed out or answered something else.
 *   - `forgotten`: the person was forgotten, before the write or while it ran; nothing of it is left.
 *   - `no_subject`: the turn names nobody memory can be kept for, or an id no memory key can be built from.
 *   - `corrected`: a correction of the person's memory finished while the turn ran.
 * - `failed`: the write threw. `errorName` is the error's class name; its message, which can quote the text, is left
 *   out.
 */
export type MemoryWriteEntry =
  | { role: 'user' | 'assistant'; outcome: 'written'; traceId: string }
  | {
      role: 'user' | 'assistant';
      outcome: 'skipped';
      reason: 'policy_off' | 'policy_failed' | 'minor_no_retention' | 'screened' | 'screen_failed' | 'forgotten' | 'no_subject' | 'corrected';
    }
  | { role: 'user' | 'assistant'; outcome: 'failed'; errorName: string };

/** Why a side of a turn was not filed. */
type SkipReason = Extract<MemoryWriteEntry, { outcome: 'skipped' }>['reason'];

/**
 * One turn's memory writes: an entry for each side that had text and whose write answered one, the user's message
 * first, then the reply. Empty when the turn was not filed (it ended in an error, was stopped, or an input guard
 * rewrote or replaced it) and when the memory provider's `observe` resolved with nothing.
 */
export interface MemoryWriteRecord {
  entries: MemoryWriteEntry[];
}

const SKIP_REASONS: ReadonlySet<string> = new Set<SkipReason>([
  'policy_off',
  'policy_failed',
  'minor_no_retention',
  'screened',
  'screen_failed',
  'forgotten',
  'no_subject',
  'corrected',
]);

/** What an error's class name may look like to be written down: an identifier, never a sentence. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The name of an error's class, for a record or a trace entry: a store's or a provider's message can quote the text
 * it was given, so the name is all that is kept. Never throws.
 *
 * @param error - What a call threw or rejected with.
 * @returns The error's `name` when it reads as a class name, else `'Error'`.
 */
export function errorNameOf(error: unknown): string {
  try {
    const name = (error as { name?: unknown } | null | undefined)?.name;
    return typeof name === 'string' && ERROR_NAME.test(name) ? name : 'Error';
  } catch {
    return 'Error';
  }
}

/**
 * The entry for a side whose write threw `error`.
 *
 * @param role - Which side of the turn it was.
 * @param error - What the write threw or rejected with.
 */
export function failedWriteEntry(role: 'user' | 'assistant', error: unknown): MemoryWriteEntry {
  return { role, outcome: 'failed', errorName: errorNameOf(error) };
}

/**
 * The entry a provider's `observe` resolved with, as the record keeps it: the side's own role, and the fields of its
 * outcome alone, so nothing else a provider answers reaches the record. Never throws.
 *
 * @param role - Which side of the turn was observed.
 * @param answer - What `observe` resolved with.
 * @returns The entry, or undefined when the answer is not one (a provider that resolves with nothing).
 */
export function writeEntryOf(role: 'user' | 'assistant', answer: unknown): MemoryWriteEntry | undefined {
  try {
    if (typeof answer !== 'object' || answer === null) return undefined;
    const given = answer as { outcome?: unknown; traceId?: unknown; reason?: unknown; errorName?: unknown };
    if (given.outcome === 'written') {
      return typeof given.traceId === 'string' ? { role, outcome: 'written', traceId: given.traceId } : undefined;
    }
    if (given.outcome === 'skipped') {
      return typeof given.reason === 'string' && SKIP_REASONS.has(given.reason)
        ? { role, outcome: 'skipped', reason: given.reason as SkipReason }
        : undefined;
    }
    if (given.outcome === 'failed') {
      return { role, outcome: 'failed', errorName: typeof given.errorName === 'string' && ERROR_NAME.test(given.errorName) ? given.errorName : 'Error' };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The record of a turn from what each of its sides answered, in the order the sides were handed over. It settles once
 * every side has, and never rejects.
 *
 * @param sides - Each side's entry, or undefined for a side that answered none; promises that never reject.
 */
export function memoryWriteRecordOf(sides: ReadonlyArray<Promise<MemoryWriteEntry | undefined>>): Promise<MemoryWriteRecord> {
  return Promise.all(sides).then(
    (answered) => ({ entries: answered.filter((entry): entry is MemoryWriteEntry => entry !== undefined) }),
    () => ({ entries: [] }),
  );
}

/** The record of a turn that was not filed. */
export function emptyMemoryWriteRecord(): MemoryWriteRecord {
  return { entries: [] };
}
