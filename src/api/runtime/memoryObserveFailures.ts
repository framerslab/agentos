/**
 * @file memoryObserveFailures.ts
 * Calls `memoryProvider.observe` for one side of an answered turn without the
 * turn waiting for it, and logs a failure to record the turn.
 *
 * A turn is answered before its memory provider records it, so a store that
 * fails never changes the turn's result. The failure is logged on a provider's
 * first failure and then at its 10th, 100th, 1000th and so on, so a broken
 * store cannot flood the log.
 *
 * @module api/runtime/memoryObserveFailures
 */
import type { AgentMemoryProvider, MemoryHookContext } from '../agent.js';

/** How many times each provider's `observe` has failed, keyed by the provider object. */
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
 * Count one failure of `provider.observe` and log it when it is the provider's
 * first failure or its 10th, 100th, 1000th and so on.
 *
 * @param provider - The memory provider whose `observe` failed.
 * @param error - What it threw or rejected with.
 */
export function reportObserveFailure(provider: AgentMemoryProvider, error: unknown): void {
  const count = (failureCounts.get(provider) ?? 0) + 1;
  failureCounts.set(provider, count);
  if (!isLoggedFailure(count)) return;
  const which = count === 1 ? '' : ` (failure ${count} of this provider; logged at the 1st, 10th, 100th and so on)`;
  // The reason goes in as text alone: the console's inspection of an error can throw, and this runs in the handler
  // of a promise no one waits for.
  console.warn(`[agentos] The turn was answered, but the memory provider failed to record it${which}: ${messageOf(error)}`);
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
 */
export function observeWithoutWaiting(
  provider: AgentMemoryProvider,
  role: 'user' | 'assistant',
  text: string,
  context?: MemoryHookContext,
): void {
  try {
    void Promise.resolve(provider.observe?.(role, text, context)).catch((error: unknown) => reportObserveFailure(provider, error));
  } catch (error) {
    reportObserveFailure(provider, error);
  }
}
