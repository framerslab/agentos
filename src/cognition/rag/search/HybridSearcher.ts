/**
 * @fileoverview Hybrid dense+sparse searcher combining vector embeddings with BM25.
 *
 * Uses Reciprocal Rank Fusion (RRF) to merge results from both systems:
 * - Dense: semantic understanding, handles paraphrasing and conceptual similarity
 * - Sparse: keyword matching, handles exact terms, error codes, function names
 *
 * RRF formula (Cormack et al. 2009):
 * ```
 * score(d) = sum_{i} weight_i / (k + rank_i(d))
 * ```
 * where `k=60` (standard constant) and `rank_i(d)` is the rank of document `d`
 * in result set `i`. Documents not present in a result set are assigned rank infinity.
 *
 * Alternative fusion methods:
 * - **weighted-sum**: `score(d) = w_dense * norm_score_dense(d) + w_sparse * norm_score_sparse(d)`
 * - **interleave**: Round-robin from each result set, deduplicating
 *
 * @module agentos/rag/search/HybridSearcher
 * @see BM25Index for the sparse keyword index
 * @see IVectorStore for the dense vector store interface
 */

import type { IVectorStore, QueryOptions, QueryResult, RetrievedVectorDocument } from '../IVectorStore.js';
import type { IEmbeddingManager } from '../IEmbeddingManager.js';
import { BM25Index, type BM25Result } from './BM25Index.js';

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * Configuration for the hybrid searcher.
 *
 * @interface HybridSearcherConfig
 */
export interface HybridSearcherConfig {
  /** Weight for dense (vector) results. Range: 0-1. Default: 0.7. */
  denseWeight?: number;
  /** Weight for sparse (BM25) results. Range: 0-1. Default: 0.3. */
  sparseWeight?: number;
  /** RRF constant k. Higher values flatten score differences. Default: 60. */
  rrfK?: number;
  /** Fusion method for merging ranked lists. Default: 'rrf'. */
  fusionMethod?: 'rrf' | 'weighted-sum' | 'interleave';
}

/**
 * A hybrid search result combining dense and sparse signals.
 *
 * @interface HybridResult
 * @property {string} id - Document identifier.
 * @property {number} score - Fused relevance score.
 * @property {number} [denseScore] - Score from vector search (if present).
 * @property {number} [sparseScore] - Score from BM25 search (if present).
 * @property {number} [denseRank] - Rank in vector search results (1-based).
 * @property {number} [sparseRank] - Rank in BM25 search results (1-based).
 * @property {string} [textContent] - Document text content if available.
 * @property {Record<string, unknown>} [metadata] - Document metadata.
 */
export interface HybridResult {
  /** Document identifier. */
  id: string;
  /** Fused relevance score (higher = more relevant). */
  score: number;
  /** Score from the dense (vector) search, if this document appeared in dense results. */
  denseScore?: number;
  /** Score from the sparse (BM25) search, if this document appeared in sparse results. */
  sparseScore?: number;
  /** 1-based rank in the dense search results. */
  denseRank?: number;
  /** 1-based rank in the sparse search results. */
  sparseRank?: number;
  /** Document text content if available from the vector store. */
  textContent?: string;
  /** Document metadata merged from both sources. */
  metadata?: Record<string, unknown>;
}

// ── Hybrid Searcher ───────────────────────────────────────────────────────

/**
 * Hybrid dense+sparse searcher combining vector embeddings with BM25.
 *
 * Uses Reciprocal Rank Fusion (RRF) to merge results from both retrieval
 * systems, capturing both semantic similarity and exact keyword matches.
 *
 * @example Basic usage
 * ```typescript
 * const bm25 = new BM25Index();
 * bm25.addDocuments(documents);
 *
 * const hybrid = new HybridSearcher(vectorStore, embeddingManager, bm25, {
 *   denseWeight: 0.7,
 *   sparseWeight: 0.3,
 *   fusionMethod: 'rrf',
 * });
 *
 * const results = await hybrid.search(
 *   'error TS2304 type declarations',
 *   'my-collection',
 *   10,
 * );
 * ```
 *
 * @example Weighted sum fusion (when you have calibrated scores)
 * ```typescript
 * const hybrid = new HybridSearcher(vectorStore, embeddingManager, bm25, {
 *   fusionMethod: 'weighted-sum',
 *   denseWeight: 0.6,
 *   sparseWeight: 0.4,
 * });
 * ```
 */
export class HybridSearcher {
  /** Dense vector store for semantic retrieval. */
  private vectorStore: IVectorStore;

  /** Embedding manager for generating query embeddings. */
  private embeddingManager: IEmbeddingManager;

  /** Sparse BM25 index for keyword retrieval. */
  private bm25Index: BM25Index;

  /** Resolved configuration with defaults applied. */
  private config: Required<HybridSearcherConfig>;

  /**
   * Creates a new HybridSearcher.
   *
   * @param {IVectorStore} vectorStore - Dense vector store for semantic search.
   * @param {IEmbeddingManager} embeddingManager - Manager for generating query embeddings.
   * @param {BM25Index} bm25Index - BM25 sparse keyword index.
   * @param {HybridSearcherConfig} [config] - Optional configuration overrides.
   *
   * @example
   * ```typescript
   * const searcher = new HybridSearcher(store, embeddings, bm25, {
   *   denseWeight: 0.7,
   *   sparseWeight: 0.3,
   * });
   * ```
   */
  constructor(
    vectorStore: IVectorStore,
    embeddingManager: IEmbeddingManager,
    bm25Index: BM25Index,
    config?: HybridSearcherConfig,
  ) {
    this.vectorStore = vectorStore;
    this.embeddingManager = embeddingManager;
    this.bm25Index = bm25Index;
    this.config = {
      denseWeight: config?.denseWeight ?? 0.7,
      sparseWeight: config?.sparseWeight ?? 0.3,
      rrfK: config?.rrfK ?? 60,
      fusionMethod: config?.fusionMethod ?? 'rrf',
    };
  }

  /**
   * Searches both dense and sparse indexes, then fuses results.
   *
   * Pipeline:
   * 1. Generate query embedding via the embedding manager
   * 2. Query the dense vector store for semantically similar documents
   * 3. Query the BM25 sparse index for keyword-matching documents
   * 4. Fuse both result sets using the configured fusion method (RRF by default)
   * 5. Return the top K results sorted by fused score
   *
   * @param {string} query - The search query text.
   * @param {string} collectionName - Vector store collection to search.
   * @param {number} [topK=10] - Maximum number of results to return.
   * @param {Partial<QueryOptions>} [queryOptions] - Additional options for the vector store query.
   * @returns {Promise<HybridResult[]>} Fused results sorted by relevance.
   * @throws {Error} If embedding generation fails.
   *
   * @example
   * ```typescript
   * const results = await hybrid.search('error TS2304', 'knowledge-base', 5);
   * for (const r of results) {
   *   console.log(`${r.id}: fused=${r.score.toFixed(4)} dense=${r.denseRank} sparse=${r.sparseRank}`);
   * }
   * ```
   */
  async search(
    query: string,
    collectionName: string,
    topK: number = 10,
    queryOptions?: Partial<QueryOptions>,
  ): Promise<HybridResult[]> {
    // Fetch more candidates from each system to improve fusion quality
    const candidateMultiplier = 3;
    const candidateK = topK * candidateMultiplier;

    // 1. Generate query embedding
    const embeddingResponse = await this.embeddingManager.generateEmbeddings({
      texts: [query],
    });

    if (
      !embeddingResponse.embeddings?.[0] ||
      embeddingResponse.embeddings[0].length === 0
    ) {
      throw new Error('HybridSearcher: Failed to generate query embedding.');
    }

    const queryEmbedding = embeddingResponse.embeddings[0];

    // 2. Execute both searches in parallel
    const [denseResult, sparseResults] = await Promise.all([
      this.vectorStore.query(collectionName, queryEmbedding, {
        topK: candidateK,
        includeTextContent: true,
        includeMetadata: true,
        ...queryOptions,
      }),
      Promise.resolve(this.bm25Index.search(query, candidateK)),
    ]);

    // 3. Fuse results
    let results: HybridResult[];
    switch (this.config.fusionMethod) {
      case 'weighted-sum':
        results = this.fuseWeightedSum(denseResult.documents, sparseResults, topK);
        break;
      case 'interleave':
        results = this.fuseInterleave(denseResult.documents, sparseResults, topK);
        break;
      case 'rrf':
      default:
        results = this.fuseRRF(denseResult.documents, sparseResults, topK);
        break;
    }

    // 4. Hydrate sparse-only winners by primary key. BM25 results carry no
    //    `textContent`, so a winner that came in on the sparse leg only
    //    would be returned text-content-less. A second similarity query
    //    would return the next-K dense rows (not the specific BM25 ids),
    //    so PK fetch is the only correct hydration path. Store types that
    //    don't implement `fetchByIds` keep the legacy "no textContent on
    //    sparse-only winners" behaviour.
    return this.hydrateSparseOnly(results, collectionName);
  }

  /**
   * Fill in `textContent` (and `metadata` when missing) for results that
   * came in on the sparse leg only by issuing a primary-key fetch to the
   * vector store. If the store doesn't implement `fetchByIds`, results
   * pass through unchanged.
   */
  private async hydrateSparseOnly(
    results: HybridResult[],
    collectionName: string,
  ): Promise<HybridResult[]> {
    if (!this.vectorStore.fetchByIds) return results;
    const needs = results.filter((r) => r.textContent === undefined);
    if (needs.length === 0) return results;

    const hydrated = await this.vectorStore.fetchByIds(
      collectionName,
      needs.map((r) => r.id),
      { includeMetadata: true, includeTextContent: true },
    );
    const byId = new Map(hydrated.map((d) => [d.id, d]));
    for (const r of results) {
      if (r.textContent !== undefined) continue;
      const h = byId.get(r.id);
      if (!h) continue;
      if (h.textContent !== undefined) r.textContent = h.textContent;
      if (r.metadata === undefined && h.metadata !== undefined) {
        r.metadata = h.metadata as Record<string, unknown>;
      }
    }
    return results;
  }

  /**
   * Fuses results using Reciprocal Rank Fusion (RRF).
   *
   * Formula: `score(d) = sum_i weight_i / (k + rank_i(d))`
   *
   * Documents appearing in both result sets get contributions from both,
   * naturally boosting documents ranked highly by both systems.
   *
   * @param {RetrievedVectorDocument[]} denseResults - Dense vector search results.
   * @param {BM25Result[]} sparseResults - BM25 sparse search results.
   * @param {number} topK - Maximum results to return.
   * @returns {HybridResult[]} Fused results sorted by RRF score.
   */
  private fuseRRF(
    denseResults: RetrievedVectorDocument[],
    sparseResults: BM25Result[],
    topK: number,
  ): HybridResult[] {
    const resultMap = new Map<string, HybridResult>();
    const k = this.config.rrfK;

    // Score from dense results
    for (let rank = 0; rank < denseResults.length; rank++) {
      const doc = denseResults[rank];
      const rrfScore = this.config.denseWeight / (k + rank + 1); // rank is 1-based in formula
      const existing = resultMap.get(doc.id);
      if (existing) {
        existing.score += rrfScore;
        existing.denseScore = doc.similarityScore;
        existing.denseRank = rank + 1;
        existing.textContent = existing.textContent ?? doc.textContent;
      } else {
        resultMap.set(doc.id, {
          id: doc.id,
          score: rrfScore,
          denseScore: doc.similarityScore,
          denseRank: rank + 1,
          textContent: doc.textContent,
          metadata: doc.metadata as Record<string, unknown>,
        });
      }
    }

    // Score from sparse results
    for (let rank = 0; rank < sparseResults.length; rank++) {
      const result = sparseResults[rank];
      const rrfScore = this.config.sparseWeight / (k + rank + 1);
      const existing = resultMap.get(result.id);
      if (existing) {
        existing.score += rrfScore;
        existing.sparseScore = result.score;
        existing.sparseRank = rank + 1;
        existing.metadata = existing.metadata ?? result.metadata;
      } else {
        resultMap.set(result.id, {
          id: result.id,
          score: rrfScore,
          sparseScore: result.score,
          sparseRank: rank + 1,
          metadata: result.metadata,
        });
      }
    }

    // Sort by fused score descending and return top K
    return Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Fuses results using weighted score summation with min-max normalization.
   *
   * Both score distributions are normalized to [0, 1] before weighting
   * to account for the different scoring scales of dense (cosine similarity)
   * and sparse (BM25 score) systems.
   *
   * @param {RetrievedVectorDocument[]} denseResults - Dense vector search results.
   * @param {BM25Result[]} sparseResults - BM25 sparse search results.
   * @param {number} topK - Maximum results to return.
   * @returns {HybridResult[]} Fused results sorted by weighted score.
   */
  private fuseWeightedSum(
    denseResults: RetrievedVectorDocument[],
    sparseResults: BM25Result[],
    topK: number,
  ): HybridResult[] {
    // Normalize dense scores to [0, 1]
    const denseScores = denseResults.map((d) => d.similarityScore);
    const denseMin = Math.min(...denseScores, 0);
    const denseMax = Math.max(...denseScores, 1);
    const denseRange = denseMax - denseMin || 1;

    // Normalize sparse scores to [0, 1]
    const sparseScores = sparseResults.map((r) => r.score);
    const sparseMin = Math.min(...sparseScores, 0);
    const sparseMax = Math.max(...sparseScores, 1);
    const sparseRange = sparseMax - sparseMin || 1;

    const resultMap = new Map<string, HybridResult>();

    for (const doc of denseResults) {
      const normalizedScore = (doc.similarityScore - denseMin) / denseRange;
      resultMap.set(doc.id, {
        id: doc.id,
        score: this.config.denseWeight * normalizedScore,
        denseScore: doc.similarityScore,
        textContent: doc.textContent,
        metadata: doc.metadata as Record<string, unknown>,
      });
    }

    for (const result of sparseResults) {
      const normalizedScore = (result.score - sparseMin) / sparseRange;
      const existing = resultMap.get(result.id);
      if (existing) {
        existing.score += this.config.sparseWeight * normalizedScore;
        existing.sparseScore = result.score;
        existing.metadata = existing.metadata ?? result.metadata;
      } else {
        resultMap.set(result.id, {
          id: result.id,
          score: this.config.sparseWeight * normalizedScore,
          sparseScore: result.score,
          metadata: result.metadata,
        });
      }
    }

    return Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Fuses results using round-robin interleaving with deduplication.
   *
   * Alternates between picking the next-best dense result and the
   * next-best sparse result, skipping documents already included.
   * This provides a simple diversity-preserving fusion.
   *
   * @param {RetrievedVectorDocument[]} denseResults - Dense vector search results.
   * @param {BM25Result[]} sparseResults - BM25 sparse search results.
   * @param {number} topK - Maximum results to return.
   * @returns {HybridResult[]} Interleaved results.
   */
  private fuseInterleave(
    denseResults: RetrievedVectorDocument[],
    sparseResults: BM25Result[],
    topK: number,
  ): HybridResult[] {
    const results: HybridResult[] = [];
    const seen = new Set<string>();
    let di = 0;
    let si = 0;

    while (results.length < topK && (di < denseResults.length || si < sparseResults.length)) {
      // Pick from dense
      while (di < denseResults.length && results.length < topK) {
        const doc = denseResults[di++];
        if (!seen.has(doc.id)) {
          seen.add(doc.id);
          results.push({
            id: doc.id,
            score: doc.similarityScore,
            denseScore: doc.similarityScore,
            denseRank: di,
            textContent: doc.textContent,
            metadata: doc.metadata as Record<string, unknown>,
          });
          break;
        }
      }

      // Pick from sparse
      while (si < sparseResults.length && results.length < topK) {
        const result = sparseResults[si++];
        if (!seen.has(result.id)) {
          seen.add(result.id);
          results.push({
            id: result.id,
            score: result.score,
            sparseScore: result.score,
            sparseRank: si,
            metadata: result.metadata,
          });
          break;
        }
      }
    }

    return results;
  }
}
