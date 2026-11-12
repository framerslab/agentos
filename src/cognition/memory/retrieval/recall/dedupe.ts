/**
 * @fileoverview The near-duplicate dedupe of the hybrid recall pool: two memories whose words are the same, or nearly
 * the same, are one.
 *
 * @module agentos/cognition/memory/retrieval/recall/dedupe
 */
import { recallTokens } from './lexical.js';

/**
 * Whether two token sets are one memory: equal, or a Jaccard index (shared tokens over all tokens) of at least
 * `threshold`. Two empty sets are not.
 *
 * @param a - One text's tokens ({@link recallTokens}).
 * @param b - The other's.
 * @param threshold - The index at which they are one (the recall's `nearDuplicate`, 0.80 to start).
 */
export function nearDuplicate(a: ReadonlySet<string>, b: ReadonlySet<string>, threshold: number): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared) >= threshold;
}

/** The words of a memory's text as the dedupe compares them. */
export function dedupeTokens(text: string): Set<string> {
  return new Set(recallTokens(text));
}

/**
 * Drops near-duplicate texts from a pool in fused order. Of two candidates that are one memory the higher fused score
 * stays; on equal scores the newer (`createdAt`) stays, in the older one's place. Each dropped candidate names, in
 * `duplicateOf`, the candidate that holds that place once the whole pool is read.
 *
 * @param pool - The pool, in fused order.
 * @param threshold - The Jaccard index at which two texts are one ({@link nearDuplicate}).
 * @returns The candidates kept, in fused order, and the ones dropped, in the order they were dropped.
 */
export function dedupePool<E extends { trace: { id: string; content: string; createdAt: number }; fusedScore: number }>(
  pool: readonly E[],
  threshold: number,
): { kept: E[]; dropped: Array<{ entry: E; duplicateOf: string }> } {
  const kept: Array<{ entry: E; tokens: Set<string> }> = [];
  const dropped: Array<{ entry: E; slot: number }> = [];
  for (const entry of pool) {
    const tokens = dedupeTokens(entry.trace.content);
    const slot = kept.findIndex((k) => nearDuplicate(k.tokens, tokens, threshold));
    if (slot < 0) {
      kept.push({ entry, tokens });
      continue;
    }
    const held = kept[slot].entry;
    if (entry.fusedScore === held.fusedScore && entry.trace.createdAt > held.trace.createdAt) {
      kept[slot] = { entry, tokens };
      dropped.push({ entry: held, slot });
    } else {
      dropped.push({ entry, slot });
    }
  }
  return {
    kept: kept.map((k) => k.entry),
    dropped: dropped.map(({ entry, slot }) => ({ entry, duplicateOf: kept[slot].entry.trace.id })),
  };
}
