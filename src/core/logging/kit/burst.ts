/**
 * @fileoverview The burst budgets every allow-list kit in the process shares.
 *
 * Each declared event, and each refusal reason, writes the first `limit` lines of a minute;
 * the rest are held, and once the minute has turned one `log_held` line gives the name and
 * the count held. The budgets live in the process-wide logging state, so every kit instance,
 * child, adapter and lazy handle that writes through a kit counts against the same minute.
 * The timer that reports held lines is unreferenced, so it never holds the process open, and
 * closing the last kit clears it with the counters.
 *
 * @module agentos/core/logging/kit/burst
 */

import { getLoggingState } from '../state.js';

// Ends every minute that has turned and reports what it held through the writer of the kit that opened it, or,
// when that kit has closed, through any kit still open.
function flush(): void {
  const state = getLoggingState(); const now = Date.now();
  for (const [key, minute] of state.minutes) {
    if (now - minute.start < 60_000) continue;
    state.minutes.delete(key);
    const emit = state.owners.get(minute.owner) ?? state.owners.values().next().value;
    if (minute.held) emit?.(minute.name, minute.held);
  }
}

// Keeps one unreferenced timer for the earliest minute that holds lines, and none when no minute holds any or no
// kit is open to report it.
function schedule(): void {
  const state = getLoggingState();
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  const ends = [...state.minutes.values()].filter(m => m.held > 0).map(m => m.start + 60_000);
  if (!ends.length || !state.owners.size) return;
  const delay = Math.min(60_000, Math.max(0, Math.min(...ends) - Date.now()));
  state.timer = setTimeout(() => { state.timer = undefined; flush(); schedule(); }, delay);
  state.timer.unref();
}

/**
 * Registers a kit as an owner of burst budgets.
 *
 * @param emit - Writes the kit's `log_held` line: the event or refusal reason held, and how many lines were held.
 * @returns The owner's key, which {@link admit} and {@link closeOwner} take.
 */
export function burstOwner(emit: (name: string, n: number) => void): symbol {
  const owner = Symbol(); getLoggingState().owners.set(owner, emit); return owner;
}

/**
 * Counts one line against its minute's budget. A budget's bound is the smallest any kit asked
 * for in that minute.
 *
 * @param owner - The kit writing the line; a minute it opens reports its held lines through it.
 * @param key - The budget's key, built from a declared event's name or a fixed refusal reason, so the keys are finite.
 * @param name - The event's name or the refusal reason, as the `log_held` line gives it.
 * @param limit - The kit's bound on lines a minute.
 * @returns `true` when the line may be written, `false` when it is held.
 */
export function admit(owner: symbol, key: string, name: string, limit: number): boolean {
  const state = getLoggingState(); flush();
  const minute = state.minutes.get(key) ?? { start: Date.now(), written: 0, held: 0, limit, owner, name };
  minute.limit = Math.min(minute.limit, limit);
  state.minutes.set(key, minute);
  if (minute.written < minute.limit) { minute.written++; schedule(); return true; }
  minute.held++; schedule(); return false;
}

/**
 * Removes a kit from the owners. A minute it opened still reports through a kit that remains
 * open; when no kit remains, the counters and the timer are cleared.
 *
 * @param owner - The key {@link burstOwner} returned.
 */
export function closeOwner(owner: symbol): void {
  const state = getLoggingState(); state.owners.delete(owner);
  if (!state.owners.size) state.minutes.clear();
  schedule();
}
