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
 * Drops near-duplicate texts from a pool in fused order, so that no two candidates kept are one memory. Candidates are
 * taken by fused score, then the newer (`createdAt`) first, and one is kept unless it repeats a candidate already
 * kept: of two that are one memory the higher fused score stays, and on equal scores the newer, in the older one's
 * place in the fused order. Each dropped candidate names, in `duplicateOf`, the kept candidate it repeats. Near-
 * duplicates are not transitive (A and C can be two memories that B repeats both of), so a kept candidate can drop
 * several that are apart from each other.
 *
 * @param pool - The pool, in fused order.
 * @param threshold - The Jaccard index at which two texts are one ({@link nearDuplicate}).
 * @returns The candidates kept, in fused order, and the ones dropped, in the pool's order.
 */
export function dedupePool<E extends { trace: { id: string; content: string; createdAt: number }; fusedScore: number }>(
  pool: readonly E[],
  threshold: number,
): { kept: E[]; dropped: Array<{ entry: E; duplicateOf: string }> } {
  const items = pool.map((entry, index) => ({ entry, index, tokens: dedupeTokens(entry.trace.content) }));
  const byPreference = [...items].sort(
    (a, b) => b.entry.fusedScore - a.entry.fusedScore || b.entry.trace.createdAt - a.entry.trace.createdAt || a.index - b.index,
  );
  const kept: Array<(typeof items)[number] & { place: number }> = [];
  const dropped: Array<{ entry: E; index: number; holder: { entry: E } }> = [];
  for (const item of byPreference) {
    const holder = kept.find((k) => nearDuplicate(k.tokens, item.tokens, threshold));
    if (!holder) {
      kept.push({ ...item, place: item.index });
      continue;
    }
    // A newer candidate of an equal score takes the place of the older one it repeats.
    holder.place = Math.min(holder.place, item.index);
    dropped.push({ entry: item.entry, index: item.index, holder });
  }
  return {
    kept: kept.sort((a, b) => a.place - b.place).map((k) => k.entry),
    dropped: dropped.sort((a, b) => a.index - b.index).map((d) => ({ entry: d.entry, duplicateOf: d.holder.entry.trace.id })),
  };
}
