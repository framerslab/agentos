/**
 * @fileoverview The recall pool of `retrieval: 'hybrid'`: the dense, exact-words and recency legs fused by reciprocal
 * rank into one ordered list, and the constants it is built with.
 *
 * @module agentos/cognition/memory/retrieval/recall/fuse
 */
import type { MemoryTrace } from '../../core/types.js';
import { fuseRankedLists } from '../hybrid/reciprocalRankFusion.js';
import type { RecallLeg } from './capture.js';

/**
 * The starting constants of the hybrid recall, each AgentOS's own: `HybridRetriever`'s `k`, weights, over-fetch and
 * recall size, and the store's `topK`. `recencyWeight` 0 lets the recency leg add candidates without moving the fused
 * order of the other two. `nearDuplicate` is the token-set Jaccard index at which two memories are one. They move only
 * through measured runs.
 */
export const RECALL_CONSTANTS = {
  rrfK: 60,
  denseWeight: 0.7,
  sparseWeight: 0.3,
  recencyWeight: 0,
  overFetch: 3,
  topK: 20,
  nearDuplicate: 0.8,
  recentTopK: 10,
} as const;

/** The hybrid recall's constants, as numbers ({@link RECALL_CONSTANTS} holds the starting ones). */
export type RecallConstants = { -readonly [K in keyof typeof RECALL_CONSTANTS]: number };

/** One candidate of the recall pool: its trace, its 1-based rank in each leg that returned it, and its fused score. */
export interface PoolEntry<T extends MemoryTrace = MemoryTrace> {
  id: string;
  trace: T;
  ranks: Partial<Record<RecallLeg, number>>;
  fusedScore: number;
}

/**
 * Fuses the legs' ranked traces into one pool, every candidate of every leg kept:
 * `fusedScore = denseWeight / (rrfK + denseRank) + sparseWeight / (rrfK + exactWordsRank) + recencyWeight / (rrfK + recencyRank)`,
 * a leg that did not return a trace adding nothing. Equal fused scores keep a fixed order: by exact-words rank, then
 * by recency rank (newest first), then by id. With `recencyWeight` 0 the recency leg moves no fused score, so its
 * candidates that no other leg returned follow every candidate another leg returned.
 *
 * A trace two legs returned is the dense leg's object when the dense leg returned it, so its cognitive score is the
 * vector query's.
 *
 * @param legs - Each leg's traces, best first.
 * @param c - The constants.
 */
export function fuseLegs<T extends MemoryTrace>(
  legs: { dense: readonly T[]; exactWords: readonly T[]; recency: readonly T[] },
  c: Pick<RecallConstants, 'rrfK' | 'denseWeight' | 'sparseWeight' | 'recencyWeight'>,
): PoolEntry<T>[] {
  const ranked = (traces: readonly T[]) => traces.map((trace, i) => ({ id: trace.id, rank: i + 1 }));
  const traceOf = new Map<string, T>();
  for (const trace of [...legs.recency, ...legs.exactWords, ...legs.dense]) traceOf.set(trace.id, trace);
  const fused = fuseRankedLists(
    [
      { ranked: ranked(legs.dense), weight: c.denseWeight },
      { ranked: ranked(legs.exactWords), weight: c.sparseWeight },
      { ranked: ranked(legs.recency), weight: c.recencyWeight },
    ],
    { k: c.rrfK },
  );
  const pool: PoolEntry<T>[] = fused.map(({ id, score, ranks: [dense, exactWords, recency] }) => ({
    id,
    trace: traceOf.get(id)!,
    fusedScore: score,
    ranks: {
      ...(dense !== undefined ? { dense } : {}),
      ...(exactWords !== undefined ? { exact_words: exactWords } : {}),
      ...(recency !== undefined ? { recency } : {}),
    },
  }));
  // Two infinite ranks subtract to NaN, which `||` passes over to the next key.
  const rankOr = (n: number | undefined) => n ?? Number.POSITIVE_INFINITY;
  return pool.sort(
    (a, b) =>
      b.fusedScore - a.fusedScore ||
      rankOr(a.ranks.exact_words) - rankOr(b.ranks.exact_words) ||
      rankOr(a.ranks.recency) - rankOr(b.ranks.recency) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
