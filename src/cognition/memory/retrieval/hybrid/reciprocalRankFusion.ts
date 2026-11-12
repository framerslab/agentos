/**
 * @file reciprocalRankFusion.ts
 * @description Rank-based fusion of two ranked document lists using
 * the Reciprocal Rank Fusion (RRF) algorithm (Cormack et al. 2009).
 *
 * ## What this does
 *
 * Takes two 1-based ranked lists of document ids (one from dense
 * retrieval, one from sparse retrieval) and merges them into a single
 * ranked list via:
 *
 * ```
 * score(d) = w_dense / (k + rank_dense(d)) + w_sparse / (k + rank_sparse(d))
 * ```
 *
 * Missing ranks (a doc appearing on only one side) contribute zero
 * from the other side.
 *
 * ## Why rank-based (not score-based)
 *
 * Dense scorers (cosine similarity, cognitive composites) and sparse
 * scorers (BM25) produce values on different scales with different
 * distributions. Score-weighted fusion requires calibration; rank
 * fusion sidesteps this entirely. Published RAG literature
 * consistently prefers RRF over weighted-sum for heterogeneous
 * retrievers.
 *
 * ## Stable ordering
 *
 * When two documents have identical RRF scores, they are ordered by
 * id ascending. Deterministic across process restarts.
 *
 * @module agentos/memory/retrieval/hybrid/reciprocalRankFusion
 */

/**
 * One document's position in a ranked retrieval result.
 */
export interface RankedDoc {
  id: string;
  /** 1-based rank. First result has rank 1. */
  rank: number;
}

/**
 * Options for {@link reciprocalRankFusion}.
 */
export interface RRFOptions {
  /** Weight on the dense-side rank contribution. Default 0.7. */
  denseWeight?: number;
  /** Weight on the sparse-side rank contribution. Default 0.3. */
  sparseWeight?: number;
  /**
   * RRF smoothing constant. Larger k flattens rank differences.
   * Default 60 per Cormack et al. 2009.
   */
  k?: number;
}

/**
 * One merged result from {@link reciprocalRankFusion}.
 */
export interface RRFResult {
  id: string;
  /** Fused score; higher = more relevant. */
  score: number;
  /** Rank in the dense list (undefined if doc was sparse-only). */
  denseRank?: number;
  /** Rank in the sparse list (undefined if doc was dense-only). */
  sparseRank?: number;
}

/**
 * Merge two ranked retrieval results via Reciprocal Rank Fusion.
 *
 * @param denseRanked - 1-based ranked list from dense retrieval.
 * @param sparseRanked - 1-based ranked list from sparse retrieval.
 * @param options - {@link RRFOptions}; defaults to w_dense=0.7, w_sparse=0.3, k=60.
 * @returns Merged results sorted by fused score descending, stable
 *          tiebreak by id ascending.
 *
 * @example
 * ```ts
 * const dense = [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }];
 * const sparse = [{ id: 'b', rank: 1 }, { id: 'c', rank: 2 }];
 * const merged = reciprocalRankFusion(dense, sparse);
 * // => [{ id: 'b', score: 0.0162, denseRank: 2, sparseRank: 1 }, ...]
 * ```
 */
export function reciprocalRankFusion(
  denseRanked: RankedDoc[],
  sparseRanked: RankedDoc[],
  options: RRFOptions = {},
): RRFResult[] {
  const wDense = options.denseWeight ?? 0.7;
  const wSparse = options.sparseWeight ?? 0.3;
  const k = options.k ?? 60;

  const byId = new Map<string, RRFResult>();

  for (const { id, rank } of denseRanked) {
    const prev = byId.get(id);
    const denseContribution = wDense / (k + rank);
    if (prev) {
      prev.score += denseContribution;
      prev.denseRank = rank;
    } else {
      byId.set(id, { id, score: denseContribution, denseRank: rank });
    }
  }

  for (const { id, rank } of sparseRanked) {
    const prev = byId.get(id);
    const sparseContribution = wSparse / (k + rank);
    if (prev) {
      prev.score += sparseContribution;
      prev.sparseRank = rank;
    } else {
      byId.set(id, { id, score: sparseContribution, sparseRank: rank });
    }
  }

  const merged = Array.from(byId.values());
  // Sort by score desc, stable tiebreak by id asc for determinism.
  merged.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return merged;
}

/** One fused document of {@link fuseRankedLists}: its score and its rank in each list, in the lists' order. */
export interface FusedDoc {
  id: string;
  score: number;
  /** The document's rank in each list, `undefined` where a list did not hold it. */
  ranks: Array<number | undefined>;
}

/**
 * Reciprocal Rank Fusion over any number of weighted ranked lists:
 *
 * ```
 * score(d) = Σ weight_i / (k + rank_i(d))
 * ```
 *
 * A list that holds an id twice counts it once, at its first rank. A list of weight 0 adds its ids at no score and
 * moves no other score. With two lists of weights 0.7 and 0.3, and no id repeated within a list, it equals
 * {@link reciprocalRankFusion} id for id and score for score.
 *
 * @param lists - The ranked lists (1-based ranks) and their weights.
 * @param options.k - Smoothing constant (default 60).
 * @returns Sorted by score descending, equal scores by id ascending.
 *
 * @example
 * ```ts
 * fuseRankedLists([
 *   { ranked: [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }], weight: 0.7 },
 *   { ranked: [{ id: 'b', rank: 1 }], weight: 0.3 },
 * ]);
 * // => [{ id: 'b', score: 0.0162, ranks: [2, 1] }, { id: 'a', score: 0.0115, ranks: [1, undefined] }]
 * ```
 */
export function fuseRankedLists(
  lists: ReadonlyArray<{ ranked: ReadonlyArray<RankedDoc>; weight: number }>,
  options: { k?: number } = {},
): FusedDoc[] {
  const k = options.k ?? 60;
  const byId = new Map<string, FusedDoc>();
  lists.forEach(({ ranked, weight }, list) => {
    for (const { id, rank } of ranked) {
      let doc = byId.get(id);
      if (!doc) {
        doc = { id, score: 0, ranks: lists.map(() => undefined) };
        byId.set(id, doc);
      }
      if (doc.ranks[list] !== undefined) continue;
      doc.ranks[list] = rank;
      doc.score += weight / (k + rank);
    }
  });
  return [...byId.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
