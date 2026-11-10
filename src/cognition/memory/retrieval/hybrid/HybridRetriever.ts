/**
 * @file HybridRetriever.ts
 * @description Hybrid BM25 + dense retrieval for memory-domain traces.
 * Dense side uses {@link MemoryStore} (preserves 6-signal cognitive
 * scoring). Sparse side uses a per-instance {@link BM25Index}. RRF
 * merges by rank. Optional {@link RerankerService} runs over the
 * merged pool.
 *
 * ## What this does
 *
 * Given a query, runs dense retrieval through `MemoryStore.query`
 * (cognitive-scored traces) and sparse retrieval through an owned
 * `BM25Index` (keyword-matched trace content). Fuses the two ranked
 * lists via Reciprocal Rank Fusion, optionally reranks the merged
 * pool with a neural cross-encoder, and returns a standard
 * `CognitiveRetrievalResult` so downstream consumers (prompt
 * assembly, bench adapters) don't change shape.
 *
 * ## Why a separate class, not a `CognitiveMemoryManager` option
 *
 * Keeps the existing manager retrieval path untouched (same reason
 * as SessionRetriever in Step 2). MVP ships as opt-in.
 *
 * ## Rerank integration is mandatory-wired from the bench
 *
 * Per the Step 2 post-mortem (rerank-skip was the root cause of
 * that step's RED verdict), Step 3 threads rerank from day 1 when
 * the bench is configured with a reranker. `rerankerService` takes a
 * `RerankerService` with any provider (local cross-encoder, Cohere,
 * LLM judge); pass `undefined` to skip rerank explicitly.
 *
 * ## Sparse-only documents are skipped in MVP
 *
 * A document that appears in `bm25.search` results but NOT in the
 * dense over-fetch pool is skipped. Rationale: at the default
 * over-fetch=3 and K=10 (30 dense candidates), a doc ranked top-30
 * on sparse is very likely in dense's top-30 on any coherent query.
 * Measured impact is expected to be negligible. If Tier A surfaces
 * a meaningful drop rate, the fix is to add a
 * `memoryStore.getTrace(id)` hydration path.
 *
 * @module agentos/memory/retrieval/hybrid/HybridRetriever
 */

import { BM25Index, type BM25Config } from '../../../rag/search/BM25Index.js';
import { reciprocalRankFusion, type RankedDoc } from './reciprocalRankFusion.js';
import type { MemoryStore } from '../store/MemoryStore.js';
import type { RerankerService } from '../../../rag/reranking/RerankerService.js';
import type { HydeRetriever } from '../../../rag/HydeRetriever.js';
import type {
  CognitiveRetrievalResult,
  MemoryScope,
  ScoredMemoryTrace,
} from '../../core/types.js';
import type { PADState } from '../../core/config.js';
import type { FactStore } from '../fact-graph/FactStore.js';
import type { Fact } from '../fact-graph/types.js';
import { PREDICATE_SCHEMA, hashPredicate, hashSubject } from '../fact-graph/canonicalization.js';

/**
 * Options for constructing a {@link HybridRetriever}.
 */
export interface HybridRetrieverOptions {
  memoryStore: MemoryStore;
  /** BM25 config (k1, b, optional tokenizer). Defaults match BM25Index. */
  bm25Config?: BM25Config;
  /**
   * Optional neural reranker. When provided, the merged pool is
   * reranked before truncation. Passing the same reranker the
   * baseline uses is the matched-ablation path.
   */
  rerankerService?: RerankerService;
  /**
   * Optional HyDE retriever for query expansion (Step 4). When set,
   * each `retrieve()` call generates a hypothesis and uses it as the
   * query for BOTH dense (`memoryStore.query`) and sparse
   * (`bm25.search`). The reranker continues to use the ORIGINAL user
   * query so it scores documents against real user intent, not the
   * hypothesis. HyDE generation is non-critical — errors fall back
   * to the raw query without aborting retrieval.
   */
  hydeRetriever?: HydeRetriever;
  /**
   * Step-6: enable split-on-ambiguous rerank refinement. When set to a
   * value in (0, 1], the bottom fraction of traces by first-pass
   * rerank score are split at sentence boundaries, rescored with a
   * second rerank call (same query), and replaced by their better
   * half ONLY IF the better half outscores the original. Monotonic.
   *
   * Default: undefined (no split, Step 3 behavior preserved).
   */
  splitAmbiguousThreshold?: number;
  /** Default dense weight in RRF. @default 0.7 */
  defaultDenseWeight?: number;
  /** Default sparse weight in RRF. @default 0.3 */
  defaultSparseWeight?: number;
  /** Default RRF constant. @default 60 */
  defaultRrfK?: number;
  /**
   * Step-9: optional {@link FactStore} of `(subject, predicate) → Fact[]`
   * tuples extracted at session-ingest time. When present AND the query
   * classifier extracts at least one `(subject, predicate)` pair from
   * the query, the latest fact per pair is prepended as a synthetic
   * {@link ScoredMemoryTrace} (retrievalScore: 1.0, sourceType:
   * 'fact_graph') to the merged pool BEFORE rerank. Preserves literal
   * `object` tokens where summary-based approaches (Steps 5/7/8)
   * paraphrased them away.
   */
  factStore?: FactStore;
  /**
   * Step-9: optional query classifier. Given the user's query, returns
   * `(subject, predicate)` pairs to look up in the {@link factStore},
   * plus whether the query is temporal (in which case ALL facts for a
   * subject are prepended, not just the latest). When absent and
   * `factStore` is set, a keyword-based default is used.
   */
  factGraphQueryClassifier?: FactGraphQueryClassifier;
}

/** Return type of a fact-graph query classifier. */
export interface FactGraphClassification {
  isTemporalQuestion: boolean;
  extractedSubjectPredicates: Array<{ subject: string; predicate: string }>;
}

export type FactGraphQueryClassifier = (query: string) => FactGraphClassification;

/**
 * Per-call options for {@link HybridRetriever.retrieve}.
 */
export interface HybridRetrieveOptions {
  /** Final truncation after merge + rerank. @default 10 */
  recallTopK?: number;
  /** Over-fetch multiplier for each side before merge. @default 3 */
  overFetchMultiplier?: number;
  denseWeight?: number;
  sparseWeight?: number;
  rrfK?: number;
}

/**
 * Hybrid BM25 + dense retriever.
 *
 * @example
 * ```ts
 * const hybrid = new HybridRetriever({ memoryStore, rerankerService });
 * // At ingest:
 * hybrid.bm25.addDocument(trace.id, trace.content, { tag: 'bench-session:s-1' });
 * // At query time:
 * const result = await hybrid.retrieve(
 *   'What did the user say about their mortgage?',
 *   { valence: 0, arousal: 0, dominance: 0 },
 *   { scope: 'user', scopeId: 'u1' },
 *   { recallTopK: 10 },
 * );
 * ```
 */
export class HybridRetriever {
  readonly bm25: BM25Index;

  private readonly memoryStore: MemoryStore;
  private readonly rerankerService?: RerankerService;
  private readonly hydeRetriever?: HydeRetriever;
  private readonly splitAmbiguousThreshold?: number;
  private readonly defaultDenseWeight: number;
  private readonly defaultSparseWeight: number;
  private readonly defaultRrfK: number;
  private readonly factStore?: FactStore;
  private readonly factGraphQueryClassifier: FactGraphQueryClassifier;

  constructor(opts: HybridRetrieverOptions) {
    this.memoryStore = opts.memoryStore;
    this.bm25 = new BM25Index(opts.bm25Config);
    this.rerankerService = opts.rerankerService;
    this.hydeRetriever = opts.hydeRetriever;
    this.splitAmbiguousThreshold = opts.splitAmbiguousThreshold;
    this.defaultDenseWeight = opts.defaultDenseWeight ?? 0.7;
    this.defaultSparseWeight = opts.defaultSparseWeight ?? 0.3;
    this.defaultRrfK = opts.defaultRrfK ?? 60;
    this.factStore = opts.factStore;
    this.factGraphQueryClassifier =
      opts.factGraphQueryClassifier ?? defaultKeywordFactGraphClassifier;
  }

  async retrieve(
    query: string,
    mood: PADState,
    scope: { scope: MemoryScope; scopeId: string },
    options: HybridRetrieveOptions = {},
  ): Promise<CognitiveRetrievalResult> {
    const startTime = Date.now();
    const recallTopK = options.recallTopK ?? 10;
    const overFetchMultiplier = options.overFetchMultiplier ?? 3;
    const overFetchTopK = recallTopK * overFetchMultiplier;
    const wDense = options.denseWeight ?? this.defaultDenseWeight;
    const wSparse = options.sparseWeight ?? this.defaultSparseWeight;
    const rrfK = options.rrfK ?? this.defaultRrfK;

    // Per-stage ranked ID accumulators. Filled as each stage runs so
    // the final diagnostics carry a full trace of where each candidate
    // lived at every step of the pipeline.
    const stageIds: {
      dense: string[];
      sparse: string[];
      merged: string[];
      reranked: string[];
      final: string[];
    } = { dense: [], sparse: [], merged: [], reranked: [], final: [] };

    // Step-9: build synthetic fact-graph traces to prepend before
    // rerank. Empty array when factStore is unset or the classifier
    // extracts no (subject, predicate) pairs from the query.
    const factGraphTraces =
      this.factStore
        ? this.buildFactGraphTraces(query, scope)
        : [];

    // HyDE expansion (Step 4): when a hydeRetriever is attached,
    // generate a hypothetical answer and use it as the query for BOTH
    // dense and sparse sides. The reranker (below) keeps the ORIGINAL
    // query so it scores documents against the user's real intent,
    // not the hypothesis. Errors are non-critical — fall back to raw.
    let effectiveQuery = query;
    let hypothesisDiagnostic: string | undefined;
    if (this.hydeRetriever) {
      try {
        const hypo = await this.hydeRetriever.generateHypothesis(query);
        if (hypo.hypothesis && hypo.hypothesis.trim().length > 0) {
          effectiveQuery = hypo.hypothesis;
          hypothesisDiagnostic = hypo.hypothesis.slice(0, 120);
        }
      } catch {
        // HyDE generation failed — raw query fallback.
      }
    }

    // Dense side: use MemoryStore.query so we keep the 6-signal
    // cognitive scoring (strength, recency, etc.) — matches baseline.
    const { scored: denseScored, timings: denseTimings } = await this.memoryStore.query(
      effectiveQuery,
      mood,
      { topK: overFetchTopK, scopes: [scope] },
    );
    stageIds.dense = denseScored.map((t) => t.id);

    // Sparse side: BM25 over the per-instance index.
    const sparseResults = this.bm25.search(effectiveQuery, overFetchTopK);
    stageIds.sparse = sparseResults.map((r) => r.id);

    // Fallback: empty BM25 index or zero sparse hits => dense-only
    // with explicit escalation diagnostic. Fact-graph synthetic traces
    // still prepend (Step 9) since they're an additive signal independent
    // of BM25.
    if (sparseResults.length === 0) {
      const combined = [...factGraphTraces, ...denseScored];
      const denseFinal = combined.slice(0, recallTopK);
      stageIds.final = denseFinal.map((t) => t.id);
      return this.buildResult(denseFinal, {
        escalations: ['hybrid-retriever:sparse-empty'],
        candidatesScanned: combined.length,
        vectorSearchMs: denseTimings.vectorSearchMs,
        scoringMs: denseTimings.scoringMs,
        totalMs: Date.now() - startTime,
        hypothesis: hypothesisDiagnostic,
        stageIds,
      });
    }

    // Build 1-based ranked lists for RRF.
    const denseRanked: RankedDoc[] = denseScored.map((t, i) => ({ id: t.id, rank: i + 1 }));
    const sparseRanked: RankedDoc[] = sparseResults.map((r, i) => ({ id: r.id, rank: i + 1 }));
    const merged = reciprocalRankFusion(denseRanked, sparseRanked, {
      denseWeight: wDense,
      sparseWeight: wSparse,
      k: rrfK,
    });
    stageIds.merged = merged.map((m) => m.id);

    // Hydrate: resolve each RRFResult.id to the ScoredMemoryTrace from
    // the dense side. Skip sparse-only docs (see file docstring).
    const denseById = new Map(denseScored.map((t) => [t.id, t]));
    const hydrated: ScoredMemoryTrace[] = [];
    // Step-9: prepend synthetic fact-graph traces BEFORE the rerank
    // pass. Each synthetic trace carries retrievalScore: 1.0 so it
    // enters the rerank input at the top; rerank can still downrank it
    // if it genuinely misses the query, in which case the blend
    // reflects that. This is the composition discipline that let Step 3
    // Hybrid ship — additive signal, not destructive replacement.
    for (const synthetic of factGraphTraces) {
      hydrated.push(synthetic);
    }
    for (const m of merged) {
      const trace = denseById.get(m.id);
      if (trace) {
        hydrated.push(trace);
      }
      // MVP: sparse-only docs (not in denseById) are skipped.
    }

    // Optional rerank: same 0.7 cognitive + 0.3 neural blend as baseline.
    let splitDiagnostic: { threshold: number; candidateCount: number; replacedIds: string[] } | undefined;
    if (this.rerankerService && hydrated.length > 0) {
      try {
        const rerankerOutput = await this.rerankerService.rerank(
          {
            query,
            documents: hydrated.map((t) => ({
              id: t.id,
              content: t.content,
              originalScore: t.retrievalScore,
            })),
          },
          { topN: hydrated.length },
        );
        const neuralScores = new Map(
          rerankerOutput.results.map((r) => [r.id, r.relevanceScore]),
        );
        for (const trace of hydrated) {
          const neural = neuralScores.get(trace.id);
          if (neural !== undefined) {
            trace.retrievalScore = 0.7 * trace.retrievalScore + 0.3 * neural;
          }
        }

        // Step-6: split-on-ambiguous refinement.
        if (
          this.splitAmbiguousThreshold !== undefined &&
          this.splitAmbiguousThreshold > 0 &&
          hydrated.length > 0
        ) {
          splitDiagnostic = await this.refineAmbiguous(
            hydrated,
            neuralScores,
            query,
            this.splitAmbiguousThreshold,
          );
        }

        hydrated.sort((a, b) => b.retrievalScore - a.retrievalScore);
        stageIds.reranked = hydrated.map((t) => t.id);
      } catch {
        // Reranker errors are non-critical: keep RRF ordering.
      }
    }

    // Truncate to recallTopK.
    const truncated = hydrated.slice(0, recallTopK);
    stageIds.final = truncated.map((t) => t.id);
    return this.buildResult(truncated, {
      candidatesScanned: denseScored.length + sparseResults.length,
      vectorSearchMs: denseTimings.vectorSearchMs,
      scoringMs: denseTimings.scoringMs,
      totalMs: Date.now() - startTime,
      hypothesis: hypothesisDiagnostic,
      splitOnAmbiguous: splitDiagnostic,
      stageIds,
    });
  }

  /** Assemble the CognitiveRetrievalResult shape. */
  private buildResult(
    retrieved: ScoredMemoryTrace[],
    d: {
      escalations?: string[];
      candidatesScanned: number;
      vectorSearchMs: number;
      scoringMs: number;
      totalMs: number;
      hypothesis?: string;
      splitOnAmbiguous?: { threshold: number; candidateCount: number; replacedIds: string[] };
      stageIds?: {
        dense: string[];
        sparse: string[];
        merged: string[];
        reranked: string[];
        final: string[];
      };
    },
  ): CognitiveRetrievalResult {
    return {
      retrieved,
      partiallyRetrieved: [],
      diagnostics: {
        candidatesScanned: d.candidatesScanned,
        vectorSearchTimeMs: d.vectorSearchMs,
        scoringTimeMs: d.scoringMs,
        totalTimeMs: d.totalMs,
        ...(d.escalations ? { escalations: d.escalations } : {}),
        ...(d.hypothesis ? { hyde: { hypothesis: d.hypothesis } } : {}),
        ...(d.splitOnAmbiguous ? { splitOnAmbiguous: d.splitOnAmbiguous } : {}),
        ...(d.stageIds ? { stageIds: d.stageIds } : {}),
      },
    };
  }

  /**
   * Step-6: split bottom-fraction traces by neural score, rescore the
   * halves, replace a trace's content with its better half IFF the
   * better half's neural score outranks the original's. Monotonic.
   *
   * Modifies `hydrated` in place: `trace.content` and `trace.retrievalScore`
   * are updated for replaced traces. Returns a diagnostic summary.
   */
  private async refineAmbiguous(
    hydrated: ScoredMemoryTrace[],
    neuralScores: Map<string, number>,
    query: string,
    threshold: number,
  ): Promise<{ threshold: number; candidateCount: number; replacedIds: string[] }> {
    const replacedIds: string[] = [];

    const sortedByNeural = hydrated
      .map((t) => ({ trace: t, neural: neuralScores.get(t.id) ?? 0 }))
      .sort((a, b) => a.neural - b.neural);
    const candidateCount = Math.ceil(hydrated.length * threshold);
    const candidates = sortedByNeural.slice(0, candidateCount);

    type Split = { traceId: string; halfAId: string; halfBId: string; halfA: string; halfB: string; originalNeural: number };
    const splits: Split[] = [];
    for (const { trace, neural } of candidates) {
      const halves = this.splitAtMidpointSentence(trace.content);
      if (!halves) continue;
      splits.push({
        traceId: trace.id,
        halfAId: `${trace.id}::a`,
        halfBId: `${trace.id}::b`,
        halfA: halves[0],
        halfB: halves[1],
        originalNeural: neural,
      });
    }

    if (splits.length === 0) {
      return { threshold, candidateCount, replacedIds };
    }

    const halfDocs = splits.flatMap((s) => [
      { id: s.halfAId, content: s.halfA },
      { id: s.halfBId, content: s.halfB },
    ]);
    let halfScores: Map<string, number>;
    try {
      const halfOut = await this.rerankerService!.rerank(
        { query, documents: halfDocs },
        { topN: halfDocs.length },
      );
      halfScores = new Map(halfOut.results.map((r) => [r.id, r.relevanceScore]));
    } catch {
      return { threshold, candidateCount, replacedIds };
    }

    const traceById = new Map(hydrated.map((t) => [t.id, t]));
    for (const s of splits) {
      const a = halfScores.get(s.halfAId) ?? -Infinity;
      const b = halfScores.get(s.halfBId) ?? -Infinity;
      const winningScore = Math.max(a, b);
      if (winningScore <= s.originalNeural) continue;
      const winningText = a >= b ? s.halfA : s.halfB;
      const trace = traceById.get(s.traceId);
      if (!trace) continue;
      trace.content = winningText;
      trace.retrievalScore += 0.3 * (winningScore - s.originalNeural);
      replacedIds.push(s.traceId);
    }

    return { threshold, candidateCount, replacedIds };
  }

  /**
   * Step-9: build synthetic `ScoredMemoryTrace[]` from the fact-graph.
   * Uses the configured classifier to extract (subject, predicate)
   * pairs from the query. For temporal questions, returns ALL facts
   * for each extracted subject (time-ordered ascending). For non-
   * temporal questions, returns only the LATEST fact per (subject,
   * predicate) pair.
   */
  private buildFactGraphTraces(
    query: string,
    scope: { scope: MemoryScope; scopeId: string },
  ): ScoredMemoryTrace[] {
    if (!this.factStore) return [];
    const classification = this.factGraphQueryClassifier(query);
    const out: ScoredMemoryTrace[] = [];
    const seenFactIds = new Set<string>();

    for (const { subject, predicate } of classification.extractedSubjectPredicates) {
      if (classification.isTemporalQuestion) {
        // Temporal: include all facts for the subject across all predicates
        // in the schema — temporal reasoning often spans multiple facts.
        const all = this.factStore.getAllTimeOrdered(scope.scope, scope.scopeId, subject);
        for (const fact of all) {
          const id = this.factTraceId(fact);
          if (seenFactIds.has(id)) continue;
          seenFactIds.add(id);
          out.push(this.factToScoredTrace(fact, scope));
        }
      } else {
        const latest = this.factStore.getLatest(
          scope.scope,
          scope.scopeId,
          subject,
          predicate,
        );
        if (!latest) continue;
        const id = this.factTraceId(latest);
        if (seenFactIds.has(id)) continue;
        seenFactIds.add(id);
        out.push(this.factToScoredTrace(latest, scope));
      }
    }
    return out;
  }

  private factTraceId(fact: Fact): string {
    return `fact-graph:${hashSubject(fact.subject)}:${hashPredicate(fact.predicate)}:${fact.timestamp}`;
  }

  private factToScoredTrace(
    fact: Fact,
    scope: { scope: MemoryScope; scopeId: string },
  ): ScoredMemoryTrace {
    const id = this.factTraceId(fact);
    return {
      id,
      type: 'semantic',
      scope: scope.scope,
      scopeId: scope.scopeId,
      content: `${fact.subject} ${fact.predicate} ${fact.object} (as of ${new Date(fact.timestamp).toISOString()}).`,
      entities: [fact.subject],
      tags: ['fact-graph', `predicate:${fact.predicate}`],
      provenance: {
        sourceType: 'fact_graph',
        sourceTimestamp: fact.timestamp,
        confidence: 1,
        verificationCount: 0,
      },
      emotionalContext: {
        valence: 0,
        arousal: 0,
        dominance: 0,
        intensity: 0,
        gmiMood: '',
      },
      encodingStrength: 1,
      stability: 1,
      retrievalCount: 0,
      lastAccessedAt: fact.timestamp,
      accessCount: 0,
      reinforcementInterval: 0,
      associatedTraceIds: [],
      createdAt: fact.timestamp,
      updatedAt: fact.timestamp,
      isActive: true,
      retrievalScore: 1,
      scoreBreakdown: {
        strengthScore: 1,
        similarityScore: 1,
        recencyScore: 1,
        emotionalCongruenceScore: 0,
        graphActivationScore: 0,
        importanceScore: 1,
      },
    };
  }

  /**
   * Split a string at the sentence boundary nearest its midpoint.
   * Returns [firstHalf, secondHalf] or null if the string is too short
   * or no valid boundary is found.
   */
  private splitAtMidpointSentence(text: string): [string, string] | null {
    if (text.length < 50) return null;
    const mid = Math.floor(text.length / 2);
    const window = Math.floor(text.length * 0.4);
    const lo = Math.max(0, mid - window);
    const hi = Math.min(text.length, mid + window);
    for (let offset = 0; offset <= window; offset++) {
      for (const sign of [-1, 1] as const) {
        const i = mid + sign * offset;
        if (i < lo || i > hi) continue;
        if (
          i > 0 &&
          i < text.length - 1 &&
          /[.!?]/.test(text[i]) &&
          /\s/.test(text[i + 1])
        ) {
          return [text.slice(0, i + 1).trim(), text.slice(i + 1).trim()];
        }
      }
    }
    const spaceIdx = text.indexOf(' ', mid);
    if (spaceIdx === -1 || spaceIdx >= text.length - 1) return null;
    return [text.slice(0, spaceIdx).trim(), text.slice(spaceIdx + 1).trim()];
  }
}

// ---------------------------------------------------------------------------
// Default fact-graph query classifier (keyword-based, zero-LLM MVP)
// ---------------------------------------------------------------------------

const TEMPORAL_MARKERS =
  /\b(first|last|when|before|after|most recent|originally|initially|latest)\b/i;
const FIRST_PERSON_IN_QUERY = /\b(i|my|me|user)\b/i;

/**
 * Default keyword-based classifier for fact-graph query expansion.
 * Recognizes:
 * - Temporal markers ("first", "last", "when", "before", "after", ...)
 * - First-person references ("I", "my", "me", "user") → subject "user"
 * - Predicate stems present in the query
 *
 * MVP-scoped: LLM-based classification is a follow-up experiment if this
 * keyword path misses on Tier A. The priority is keeping query-time zero
 * LLM overhead on queries the classifier skips.
 */
export function defaultKeywordFactGraphClassifier(
  query: string,
): FactGraphClassification {
  const isTemporalQuestion = TEMPORAL_MARKERS.test(query);
  const extractedSubjectPredicates: Array<{ subject: string; predicate: string }> = [];

  if (!FIRST_PERSON_IN_QUERY.test(query)) {
    return { isTemporalQuestion, extractedSubjectPredicates };
  }
  const lowerQuery = query.toLowerCase();
  for (const predicate of PREDICATE_SCHEMA) {
    // Match the predicate stem OR its common inflections. A cheap
    // substring check beats regex compilation per query.
    const stem = predicate.toLowerCase();
    if (lowerQuery.includes(stem)) {
      extractedSubjectPredicates.push({ subject: 'user', predicate });
    }
  }
  return { isTemporalQuestion, extractedSubjectPredicates };
}
