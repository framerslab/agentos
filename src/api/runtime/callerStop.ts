/**
 * @file callerStop.ts
 * @description A call the caller stopped: refused by its spend budget, or
 * stopped by a generation or tool hook under `hookErrors: 'throw'`. Such an
 * error says nothing about the provider, so the generation helpers neither
 * count it against the provider's health nor try the call on a fallback
 * provider.
 */

/** Property key that marks an error a hook stopped a call with. */
const STOPPED_BY_HOOK = Symbol.for('agentos.generateText.stoppedByHook');

/**
 * Marks `error`, thrown by a generation or tool hook under
 * `hookErrors: 'throw'`, as the caller's stop. A non-object is wrapped in an
 * Error first.
 *
 * @returns The marked error, for the caller to throw.
 * @internal Shared by generateText, streamText and the prompt-tool loop.
 */
export function markHookStop(error: unknown): unknown {
  const target = error !== null && typeof error === 'object' ? error : new Error(String(error));
  try {
    Object.defineProperty(target, STOPPED_BY_HOOK, { value: true, configurable: true });
  } catch {
    // A frozen error cannot carry the mark.
  }
  return target;
}

/**
 * Whether the caller stopped the call: its spend budget refused it
 * (`CostCapExceededError`, `UnpricedModelError`) or a hook stopped it
 * ({@link markHookStop}).
 *
 * @internal Shared by generateText and streamText.
 */
export function isCallerStop(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return (
    name === 'CostCapExceededError' ||
    name === 'UnpricedModelError' ||
    (error as Record<symbol, unknown>)[STOPPED_BY_HOOK] === true
  );
}
