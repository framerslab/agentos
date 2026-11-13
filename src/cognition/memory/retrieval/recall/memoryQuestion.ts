/**
 * @fileoverview The memory-question reserve of `retrieval: 'hybrid'`: whether a turn asks about something said before,
 * and the exact-words candidates such a turn reserves room for.
 *
 * @module agentos/cognition/memory/retrieval/recall/memoryQuestion
 */
import type { PoolEntry } from './fuse.js';

/** The fixed English list a turn's lower-cased text is matched against, each at a word boundary. */
const MEMORY_QUESTION: readonly RegExp[] = [
  /\bremember\b/,
  /\brecall\b/,
  /\bremind me\b/,
  /\bdid i (say|tell|mention)\b/,
  /\bhave i (told|mentioned|said)\b/,
  /\bwhat did i (say|tell)\b/,
  /\bwhat was my\b/,
  /\bwhat('s| is) my\b.*\b(name|favou?rite|birthday)\b/,
  /\blast time\b/,
  /\bearlier (i|you) (said|mentioned)\b/,
  /\byou (said|told me)\b/,
];

/**
 * Whether a turn asks about something said before: its lower-cased text holds, at a word boundary, one of `remember`,
 * `recall`, `remind me`, `did i (say|tell|mention)`, `have i (told|mentioned|said)`, `what did i (say|tell)`,
 * `what was my`, `what('s| is) my … (name|favou?rite|birthday)`, `last time`, `earlier (i|you) (said|mentioned)` or
 * `you (said|told me)`, a typographic apostrophe read as `'`. Deterministic, with no model call. English only: a host
 * replaces it with the manager's `recall.memoryQuestion`.
 *
 * @param turnText - The turn's text.
 */
export function isMemoryQuestion(turnText: string): boolean {
  // A phone keyboard types the typographic apostrophe: "What’s my sister’s name?" asks as "What's" does.
  const text = typeof turnText === 'string' ? turnText.toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'") : '';
  return MEMORY_QUESTION.some((pattern) => pattern.test(text));
}

/**
 * The pool entries a memory question reserves room for: found by exact words and not returned by the dense leg (a
 * recency rank beside the exact-words one counts, since the recency leg moves no fused score at the starting weights),
 * and left out by the cut at `topK`; in exact-words rank order; at most one slot in ten of `topK`, and at least one.
 *
 * @param pool - The deduped pool, in fused order.
 * @param topK - The cut.
 */
export function reserveFor<E extends Pick<PoolEntry, 'id' | 'ranks'>>(pool: readonly E[], topK: number): E[] {
  return pool
    .slice(topK)
    .filter((entry) => entry.ranks.exact_words !== undefined && entry.ranks.dense === undefined)
    .sort((a, b) => a.ranks.exact_words! - b.ranks.exact_words!)
    .slice(0, Math.max(1, Math.floor(topK / 10)));
}
