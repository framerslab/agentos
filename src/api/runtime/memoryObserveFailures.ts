/**
 * @file memoryObserveFailures.ts
 * Calls `memoryProvider.observe` for one side of an answered turn without the
 * turn waiting for it, answers what became of the write, and logs a failure to
 * record the turn.
 *
 * A turn is answered before its memory provider records it, so a store that
 * fails never changes the turn's result. The failure is a `memory.hook_failed`
 * event with the error's type and code, never its message, written on a
 * provider's first failure and then at its 10th, 100th, 1000th and so on, so a
 * broken store cannot flood the log. The turn's write record carries it too, as
 * a `failed` entry with the error's class name.
 *
 * @module api/runtime/memoryObserveFailures
 */
import type { AgentMemoryProvider, MemoryHookContext } from '../agent.js';
import { listedErrorFields } from '../../core/logging/events.js';
import { memoryLog } from '../../cognition/memory/log.js';
import { failedWriteEntry, writeEntryOf, type MemoryWriteEntry } from './memoryWriteRecord.js';

/** How many times each provider's `observe`, or each souled agent's mind, has failed, keyed by the object counted. */
const failureCounts = new WeakMap<object, number>();

/** True for the failure counts that are logged: 1, then each power of ten. */
function isLoggedFailure(count: number): boolean {
  let logged = 1;
  while (logged < count) logged *= 10;
  return logged === count;
}

/**
 * The error's message, or the value as text when it is not an Error. Never throws: a value `String()` cannot turn
 * into text, such as an object with no prototype, is named as such, since a throw here would reject the handler of
 * a promise no one waits for, or fail the turn the failure was to leave as it is.
 *
 * @param error - What a call threw or rejected with.
 * @returns Text that names it.
 */
export function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return 'a value that cannot be shown as text';
  }
}

/**
 * Count one failure of `provider.observe` and write a `memory.hook_failed`
 * event when it is the provider's first failure or its 10th, 100th, 1000th and
 * so on.
 *
 * @param provider - The memory provider whose `observe` failed.
 * @param error - What it threw or rejected with.
 */
export function reportObserveFailure(provider: AgentMemoryProvider, error: unknown): void {
  reportSparsely(provider, 'observe', error);
}

/**
 * Count one failure of a souled agent's mind to store a side of a turn, and write a `memory.hook_failed` event with
 * the hook `soulMemory` on the mind's first failure and its 10th, 100th, 1000th and so on, as
 * {@link reportObserveFailure} writes a provider's.
 *
 * @param mind - What the failures are counted by: one object for the agent's mind.
 * @param error - What the write threw or rejected with.
 */
export function reportMindWriteFailure(mind: object, error: unknown): void {
  reportSparsely(mind, 'soulMemory', error);
}

/** Counts one failure of `counted` and writes its `memory.hook_failed` line at the 1st, 10th, 100th failure and so on. */
function reportSparsely(counted: object, hook: 'observe' | 'soulMemory', error: unknown): void {
  const count = (failureCounts.get(counted) ?? 0) + 1;
  failureCounts.set(counted, count);
  if (!isLoggedFailure(count)) return;
  // The error's type and code alone: its message can hold what the turn said, and reading them never throws.
  memoryLog.warn('memory.hook_failed', { hook, ...listedErrorFields(error) });
}

/**
 * Call `provider.observe(role, text, context)` on the provider, so a provider
 * built from a class reads `this`, without waiting for it. A synchronous throw
 * or a rejection is reported through {@link reportObserveFailure}, never thrown.
 *
 * @param provider - The memory provider.
 * @param role - Which side of the turn `text` is.
 * @param text - The turn's text for that side.
 * @param context - Which session, user and agent the turn serves.
 * @returns What became of the write, once `observe` settles: the entry it resolved with, a `failed` entry when it
 *   threw or rejected, undefined when it resolved with nothing. The promise never rejects.
 */
export function observeWithoutWaiting(
  provider: AgentMemoryProvider,
  role: 'user' | 'assistant',
  text: string,
  context?: MemoryHookContext,
): Promise<MemoryWriteEntry | undefined> {
  const failed = (error: unknown): MemoryWriteEntry => {
    try {
      reportObserveFailure(provider, error);
    } catch {
      // A logger that throws leaves the record to say the write failed.
    }
    return failedWriteEntry(role, error);
  };
  try {
    // A call with no context passes two arguments, as before contexts existed.
    const observed = context === undefined ? provider.observe?.(role, text) : provider.observe?.(role, text, context);
    return Promise.resolve(observed).then((answer) => writeEntryOf(role, answer), failed);
  } catch (error) {
    return Promise.resolve(failed(error));
  }
}
