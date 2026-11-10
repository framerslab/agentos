/**
 * @fileoverview The recall module's event handle. Each line is one of the `memory.recall.*` events in
 * `AGENTOS_EVENTS`: a leg, a reason, a count or a token amount, never memory text, query text or an id.
 *
 * @module agentos/cognition/memory/retrieval/recall/log
 */
import { moduleLogger } from '../../../../core/logging/loggerFactory.js';

/** Writes the `memory.recall.*` events to the logger current when each is written. */
export const recallLog = moduleLogger('memory.recall', 'cognitive_memory');

const written = new Set<string>();

/**
 * Runs `write` the first time `key` is seen in this process: the absence lines are one per process per (leg, reason).
 *
 * @param key - What the line is about, such as `exact_words:no_index`.
 * @param write - Writes the line.
 */
export function oncePerProcess(key: string, write: () => void): void {
  if (written.has(key)) return;
  written.add(key);
  write();
}

/** Forgets what {@link oncePerProcess} has seen. For tests. @internal */
export function resetRecallLogOnce(): void {
  written.clear();
}
