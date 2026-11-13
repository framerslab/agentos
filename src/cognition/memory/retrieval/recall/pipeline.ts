/**
 * @fileoverview A memory manager's recall pipeline: the legs it runs for a turn, the pool it fuses them into under
 * `retrieval: 'hybrid'`, and what it reports of them.
 *
 * @module agentos/cognition/memory/retrieval/recall/pipeline
 */
import type { ManagerRecallConfig, MemoryGraphConfig, PADState } from '../../core/config.js';
import type { CognitiveRetrievalOptions, MemoryTrace, PartiallyRetrievedTrace, ScoredMemoryTrace } from '../../core/types.js';
import type { IMemoryGraph } from '../graph/IMemoryGraph.js';
import { isQueryEmbeddingFailure, type MemoryStore } from '../store/MemoryStore.js';
import type { MemoryRecallCapture, MemoryRecallReranker, RankedRecallCandidate } from './capture.js';
import { dedupePool } from './dedupe.js';
import { fuseLegs, RECALL_CONSTANTS, type PoolEntry, type RecallConstants } from './fuse.js';
import { ScopedLexicalIndex } from './lexical.js';
import { denseLeg, type DenseLegResult } from './legs/dense.js';
import { exactWordsLeg, lexicalBackendOf } from './legs/exactWords.js';
import type { LegQuery } from './legs/leg.js';
import { recencyLeg } from './legs/recency.js';
import { oncePerProcess, recallLog } from './log.js';
import { isMemoryQuestion, reserveFor } from './memoryQuestion.js';
import { RecallReranker, RERANK_DEFAULTS } from './rerank.js';
import { admitSupplied } from './supplied.js';

/** What a pipeline reads, each at every run: a manager's store, graph and settings can change after it is made. */
export interface RecallPipelineDeps {
  store: () => MemoryStore;
  graph: () => IMemoryGraph | null;
  graphConfig: () => Partial<MemoryGraphConfig> | undefined;
  /** The manager's recall settings (`retrieval`, `constants`, `rerank`); unset is `retrieval: 'dense'` with no rerank. */
  recall?: () => ManagerRecallConfig | undefined;
}

/** What one recall run returns. */
export interface RecallRun {
  /**
   * The recalled traces, best first: under `hybrid`, the deduped pool cut at `topK`, then the candidates a memory
   * question reserved room for (`reserve.ids`). A rerank that answered has reordered the candidates it scored.
   */
  scored: ScoredMemoryTrace[];
  /** Under `dense`: the ids of the dense leg's traces in its own order, before any rerank. */
  denseOrder?: string[];
  /** The reranker that scored the candidates, or `none` with the reason (`none_configured` with no `recall.rerank`). */
  reranker: MemoryRecallReranker;
  /** Each candidate the reranker scored, with the score it gave before the blend; absent when no rerank answered. */
  rerankScores?: Record<string, number>;
  /** Milliseconds the rerank took, whether it answered or not; 0 with no reranker. */
  rerankMs: number;
  /** The store's partially retrieved traces. */
  partial: PartiallyRetrievedTrace[];
  /** The store's own timings. */
  storeTimings: { vectorSearchMs: number; scoringMs: number };
  /** Each leg the run ran or could not run, as the recall capture reports it. */
  legs: MemoryRecallCapture['legs'];
  /** Which recall ran. */
  retrieval: 'dense' | 'hybrid';
  /**
   * Under `hybrid`: the whole pool in fused order, a candidate the dedupe dropped with `duplicateOf`. A rerank that
   * answered lists the cut's candidates in the order it gave them, in the places the cut holds in that list.
   */
  ranked?: RankedRecallCandidate[];
  /** Under `hybrid`: the full-text backend the exact-words leg read, `none` when it did not run. */
  lexicalBackend?: MemoryRecallCapture['lexicalBackend'];
  /** Under `hybrid`: milliseconds of the legs (run together), the fusion and the dedupe. */
  timings?: { legsMs: number; fuseMs: number; dedupeMs: number };
  /** Whether the turn was a memory question, and the ids `scored` holds past the cut for it, in reserve order. */
  reserve: { fired: boolean; ids: string[] };
  /** The ids in `scored` of supplied candidates (`CognitiveRetrievalOptions.supplied`): written nowhere. */
  suppliedIds: string[];
  /** Counts of the call's supplied candidates that were refused, set only when one was. */
  suppliedRejected?: { outOfScope: number; ineligible: number };
}

/** Writes the line for refused supplied candidates: counts, never an id. */
function logSuppliedRejected(outOfScope: number, ineligible: number): void {
  if (outOfScope + ineligible > 0) recallLog.warn('memory.recall.supplied_rejected', { out_of_scope: outOfScope, ineligible });
}

/** The defined values of a manager's `recall.constants`, over the starting ones. */
function constantsOf(settings: ManagerRecallConfig | undefined): RecallConstants {
  const c: RecallConstants = { ...RECALL_CONSTANTS };
  for (const [name, value] of Object.entries(settings?.constants ?? {})) {
    if (typeof value === 'number' && name in c) c[name as keyof RecallConstants] = value;
  }
  return c;
}

/** The capture's entry for a leg. */
function legEntry(leg: { leg: MemoryRecallCapture['legs'][number]['leg']; ran: boolean; reason?: MemoryRecallCapture['legs'][number]['reason']; traces: readonly unknown[]; ineligible: number; ms: number }): MemoryRecallCapture['legs'][number] {
  return { leg: leg.leg, ran: leg.ran, ...(leg.reason ? { reason: leg.reason } : {}), candidates: leg.traces.length, ineligible: leg.ineligible, ms: leg.ms };
}

/**
 * One memory manager's recall.
 *
 * Under `retrieval: 'dense'` (the default) it runs the dense leg: the store's vector query, the trust-policy filter
 * and the memory graph's activation, and the dense leg's failure fails the recall, as `retrieve()` did before the
 * pipeline. Under `'hybrid'` it runs the dense leg on `topK × overFetch`, the exact-words leg on as many and the
 * recency leg on `recentTopK` together, scores the traces only the other two legs found
 * ({@link MemoryStore.scoreForRecall}), fuses the three by reciprocal rank ({@link fuseLegs}), drops near-duplicate
 * memories ({@link dedupePool}) and cuts the pool at `topK`. A leg that fails under `'hybrid'` is absent for the turn
 * and the others go on. A leg that could not run writes one `memory.recall.leg_absent` line per process for its
 * reason.
 *
 * With a `recall.rerank` that names a provider ({@link RecallReranker}), the best candidates are scored against the
 * turn's own text and reordered by the blend of the score each holds and its rerank score
 * (`0.7 × score + 0.3 × rerank score`); the candidates the reranker was not sent keep their order after them. Under
 * `'dense'` the score is the trace's retrieval score, which the blend replaces. Under `'hybrid'` it is the fused score
 * over the best fused score of the cut's recalled candidates, at most 1 (a supplied candidate's score, on the caller's
 * scale, is never read as the best), so both terms run from 0 to 1 as under `'dense'`; the cut at `topK` is what is
 * reranked, a supplied candidate in it included, the fused scores and each trace's retrieval score stay, and a memory
 * question's reserved candidates follow, unscored. A rerank that does not answer leaves the order as it was. The
 * reranker is built by {@link RecallPipeline.configureRerank}, never by a run.
 */
export class RecallPipeline {
  /** The in-process exact-words index of a store with no Brain, and the store it follows. */
  private lexical: { store: MemoryStore; index: ScopedLexicalIndex } | null = null;
  /** The reranker `recall.rerank` named when {@link configureRerank} last ran; null for `'none'`. */
  private reranker: RecallReranker | null = null;

  constructor(private readonly deps: RecallPipelineDeps) {}

  /**
   * Builds the reranker the settings' `rerank` names and starts its load, in place of the one built before, whose
   * late answers are dropped. The manager calls it when it initialises and when `applyRecallConfig()` changes the
   * setting; a turn never does, so a value written to the configuration is not read until then.
   */
  configureRerank(): void {
    const previous = this.reranker;
    const setting = this.deps.recall?.()?.rerank;
    this.reranker = setting != null && typeof setting === 'object' ? new RecallReranker(setting) : null;
    this.reranker?.start();
    void previous?.dispose();
  }

  /** Resolves when the reranker's model has loaded or been found unavailable; at once with no reranker. */
  ready(): Promise<void> {
    return this.reranker?.ready() ?? Promise.resolve();
  }

  /**
   * Reorders the head of `cut`, the candidates the reranker scored, by the blend of each one's score and its rerank
   * score; the rest keep their order after it. With no reranker, or one that did not answer, `cut` is returned as it
   * was, with the reason.
   *
   * @param query - The turn's own text.
   * @param cut - The candidates, best first.
   * @param scoreOf - The score a candidate holds, on a 0 to 1 scale.
   * @param apply - Told each scored candidate's blended score.
   */
  private async rerankCut<E extends { id: string; trace: ScoredMemoryTrace }>(
    query: string,
    cut: E[],
    scoreOf: (entry: E) => number,
    apply: (entry: E, blended: number) => void,
  ): Promise<{ cut: E[]; record: MemoryRecallReranker; scores: Map<string, number>; ms: number }> {
    if (!this.reranker) return { cut, record: { provider: 'none', reason: 'none_configured' }, scores: new Map(), ms: 0 };
    const started = performance.now();
    const { record, scores } = await this.reranker.rerank(
      query,
      cut.map((entry) => ({ id: entry.id, content: entry.trace.content, score: scoreOf(entry) })),
    );
    // The reranker's own time when it answered; the time the attempt took when it did not.
    const ms = record.ms ?? Math.round(performance.now() - started);
    if (scores.size === 0) return { cut, record, scores, ms };
    const head = cut.filter((entry) => scores.has(entry.id));
    const blended = new Map(head.map((entry) => [entry.id, RERANK_DEFAULTS.blendScore * scoreOf(entry) + RERANK_DEFAULTS.blendRerank * scores.get(entry.id)!]));
    for (const entry of head) apply(entry, blended.get(entry.id)!);
    // Stable: equal blends keep the order the candidates came in.
    head.sort((a, b) => blended.get(b.id)! - blended.get(a.id)!);
    return { cut: [...head, ...cut.filter((entry) => !scores.has(entry.id))], record, scores, ms };
  }

  /**
   * Runs the turn's recall.
   *
   * @param input.denseQuery - The text the dense leg embeds: the turn's, or a hypothesis written from it.
   * @param input.query - The turn's text, which the exact-words leg reads (default `denseQuery`).
   * @param input.mood - The current mood.
   * @param input.options - The turn's retrieval options.
   * @throws Under `'dense'`, what the dense leg throws.
   */
  async run(input: { denseQuery: string; query?: string; mood: PADState; options: CognitiveRetrievalOptions }): Promise<RecallRun> {
    const settings = this.deps.recall?.();
    if (settings?.retrieval === 'hybrid') return this.runHybrid(input, constantsOf(settings), settings);
    const dense = await denseLeg(
      { store: this.deps.store(), graph: this.deps.graph(), graphConfig: this.deps.graphConfig() },
      input.denseQuery,
      input.mood,
      input.options,
    );
    if (!dense.ran && dense.reason) {
      const reason = dense.reason;
      oncePerProcess(`dense:${reason}`, () => recallLog.warn('memory.recall.leg_absent', { leg: 'dense', reason }));
    }
    // Dense recall has no pool: supplied candidates are not read, and are counted so the call is never silent.
    const supplied = Array.isArray(input.options.supplied) ? input.options.supplied.length : 0;
    logSuppliedRejected(0, supplied);
    // The rerank blends each scored trace's retrieval score with its rerank score, and the blend orders them.
    const denseOrder = dense.traces.map((trace) => trace.id);
    const reranked = await this.rerankCut(
      input.query ?? input.denseQuery,
      dense.traces.map((trace) => ({ id: trace.id, trace })),
      (entry) => entry.trace.retrievalScore,
      (entry, blended) => {
        entry.trace.retrievalScore = blended;
      },
    );
    return {
      scored: reranked.cut.map((entry) => entry.trace),
      denseOrder,
      partial: dense.partial,
      storeTimings: dense.storeTimings,
      legs: [legEntry(dense)],
      retrieval: 'dense',
      reranker: reranked.record,
      ...(reranked.scores.size > 0 ? { rerankScores: Object.fromEntries(reranked.scores) } : {}),
      rerankMs: reranked.ms,
      reserve: { fired: false, ids: [] },
      suppliedIds: [],
      ...(supplied > 0 ? { suppliedRejected: { outOfScope: 0, ineligible: supplied } } : {}),
    };
  }

  /** Stops the in-process exact-words index following its store, and the reranker. */
  dispose(): void {
    this.lexical?.index.dispose();
    this.lexical = null;
    void this.reranker?.dispose();
    this.reranker = null;
  }

  /** The in-process exact-words index of `store`, built at its first hybrid turn; null for a store with a Brain. */
  private lexicalIndex(store: MemoryStore): ScopedLexicalIndex | null {
    if (store.getBrain()) return null;
    if (this.lexical?.store !== store) {
      this.lexical?.index.dispose();
      this.lexical = { store, index: new ScopedLexicalIndex(store) };
    }
    return this.lexical.index;
  }

  private async runHybrid(
    input: { denseQuery: string; query?: string; mood: PADState; options: CognitiveRetrievalOptions },
    c: RecallConstants,
    settings: ManagerRecallConfig,
  ): Promise<RecallRun> {
    const { options } = input;
    const store = this.deps.store();
    const now = Date.now();
    const topK = options.topK ?? c.topK;
    const fetch = topK * c.overFetch;
    const legQuery: LegQuery = {
      query: input.query ?? input.denseQuery,
      scopes: options.scopes ?? [],
      types: options.types,
      minConfidence: options.minConfidence,
      after: options.timeRange?.after,
      limit: fetch,
      now,
      usableFor: options.usableFor === undefined ? undefined : Array.isArray(options.usableFor) ? options.usableFor : [options.usableFor],
    };
    const lexical = this.lexicalIndex(store);
    const legsStarted = performance.now();
    const [dense, words, recent] = await Promise.all([
      denseLeg({ store, graph: this.deps.graph(), graphConfig: this.deps.graphConfig() }, input.denseQuery, input.mood, {
        ...options,
        topK: fetch,
      }).catch(
        (error: unknown): DenseLegResult => ({
          leg: 'dense',
          ran: false,
          reason: isQueryEmbeddingFailure(error) ? 'no_embedder' : 'query_error',
          traces: [],
          ineligible: 0,
          partial: [],
          storeTimings: { vectorSearchMs: 0, scoringMs: 0 },
          ms: Math.round(performance.now() - legsStarted),
        }),
      ),
      exactWordsLeg({ store, lexical }, legQuery),
      recencyLeg({ store }, { ...legQuery, limit: c.recentTopK }),
    ]);
    const legsMs = Math.round(performance.now() - legsStarted);
    for (const leg of [dense, words, recent]) {
      if (leg.ran || !leg.reason) continue;
      const { leg: name, reason } = leg;
      oncePerProcess(`${name}:${reason}`, () => recallLog.warn('memory.recall.leg_absent', { leg: name, reason }));
    }

    const fuseStarted = performance.now();
    // A trace the dense leg returned keeps its cognitive score; one only the other legs found is scored by the store
    // with similarity 0, so its line shows a relevance and never a rank-fusion score.
    const byDense = new Map(dense.traces.map((trace) => [trace.id, trace]));
    const others = new Map<string, MemoryTrace>();
    for (const trace of [...words.traces, ...recent.traces]) if (!byDense.has(trace.id)) others.set(trace.id, trace);
    const scoredOthers = new Map(
      store
        .scoreForRecall([...others.values()], input.mood, { neutralMood: options.neutralMood, scoringWeights: options.scoringWeights, now })
        .map((trace) => [trace.id, trace]),
    );
    const asScored = (traces: readonly MemoryTrace[]): ScoredMemoryTrace[] =>
      traces.flatMap((trace) => {
        const scored = byDense.get(trace.id) ?? scoredOthers.get(trace.id);
        return scored ? [scored] : [];
      });
    // A trace deleted while the legs ran (this process's soft delete, or a tombstone) leaves the pool.
    const live = (trace: MemoryTrace): boolean => !store.isDeleted(trace.id) && store.getTrace(trace.id)?.isActive !== false;
    const pool: Array<PoolEntry<ScoredMemoryTrace> & { undated?: boolean }> = fuseLegs(
      { dense: dense.traces.filter(live), exactWords: asScored(words.traces).filter(live), recency: asScored(recent.traces).filter(live) },
      c,
    );
    // Supplied candidates join the pool before the dedupe and the cut, each at its own score or the pool's lowest. One
    // whose id names a memory the pool or the store holds is that memory, and is not added: it would otherwise share
    // the id of a stored trace, and hide that trace's graph association. One the pool holds is shown as that memory;
    // one only the store holds is counted as ineligible. At most `topK × overFetch` are added, as many as a leg
    // returns, the best-scored first (an unscored one after every scored one); the rest count as ineligible.
    const supplied = Array.isArray(options.supplied) && options.supplied.length > 0 ? admitSupplied(options, now) : null;
    const suppliedIds: string[] = [];
    if (supplied) {
      const held = new Set(pool.map((entry) => entry.id));
      const floor = pool.reduce((low, entry) => Math.min(low, entry.fusedScore), pool.length > 0 ? Number.POSITIVE_INFINITY : 0);
      const notHeld = supplied.kept.filter(({ trace }) => !held.has(trace.id));
      const fresh = notHeld
        .filter(({ trace }) => store.getTrace(trace.id) === undefined)
        .sort((a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY) || 0);
      const admitted = fresh.slice(0, fetch);
      supplied.ineligible += notHeld.length - admitted.length;
      for (const { trace, score, undated } of admitted) {
        suppliedIds.push(trace.id);
        pool.push({ id: trace.id, trace, ranks: { supplied: suppliedIds.length }, fusedScore: score ?? floor, ...(undated ? { undated: true } : {}) });
      }
      // Stable: equal scores keep the fused order, the supplied ones after it.
      pool.sort((a, b) => b.fusedScore - a.fusedScore);
      logSuppliedRejected(supplied.outOfScope, supplied.ineligible);
    }
    const fuseMs = Math.round(performance.now() - fuseStarted);

    const dedupeStarted = performance.now();
    const { kept, dropped } = dedupePool(pool, c.nearDuplicate);
    const dedupeMs = Math.round(performance.now() - dedupeStarted);
    const duplicateOf = new Map(dropped.map((d) => [d.entry.id, d.duplicateOf]));
    // A newer text that took an older one's place carries that one's fused score.
    const keptScore = new Map(kept.map((entry) => [entry.id, entry.fusedScore]));

    // A memory question reserves room for the exact-words hits the cut left out. A predicate that throws is a no, and
    // so is one that returns a promise, whose rejection is handled here.
    let asked = false;
    try {
      const answer: unknown = (settings.memoryQuestion ?? isMemoryQuestion)(legQuery.query);
      if (answer !== null && typeof answer === 'object' && typeof (answer as { then?: unknown }).then === 'function') {
        Promise.resolve(answer).catch(() => undefined);
      }
      asked = answer === true;
    } catch {
      asked = false;
    }
    const reserved = asked ? reserveFor(kept, topK) : [];
    const reservedIds = new Set(reserved.map((entry) => entry.id));
    const rejected = supplied && supplied.outOfScope + supplied.ineligible > 0 ? { outOfScope: supplied.outOfScope, ineligible: supplied.ineligible } : null;
    const shownSupplied = new Set(suppliedIds);

    // The rerank orders the cut, the reserved candidates after it. A fused score is at most `1 / (rrfK + 1)`, so it is
    // blended as its share of the best fused score among the cut's recalled candidates: both terms then run from 0 to
    // 1, as under dense. A supplied candidate's score is on the caller's own scale, so it is not read as the best (it
    // would shrink every recalled share), and its own share is at most 1. Each fused score and each trace's retrieval
    // score stay as they were; only the order changes.
    const cut = kept.slice(0, topK);
    const bestOf = (entries: typeof cut): number => entries.reduce((best, entry) => Math.max(best, entry.fusedScore), 0);
    const bestFused = bestOf(cut.filter((entry) => entry.ranks.supplied === undefined)) || bestOf(cut);
    const reranked = await this.rerankCut(
      legQuery.query,
      cut,
      (entry) => (bestFused > 0 ? Math.min(1, entry.fusedScore / bestFused) : 0),
      () => undefined,
    );

    // The whole pool by fused score, a kept candidate with the score it holds; equal scores keep the pool's order.
    const byFused: RankedRecallCandidate[] = pool
      .map(({ id, ranks, fusedScore }) => ({
        id,
        ranks,
        fusedScore: keptScore.get(id) ?? fusedScore,
        ...(reranked.scores.has(id) ? { rerankScore: reranked.scores.get(id)! } : {}),
        ...(duplicateOf.has(id) ? { duplicateOf: duplicateOf.get(id)! } : {}),
        ...(reservedIds.has(id) ? { reserve: true } : {}),
      }))
      .sort((a, b) => b.fusedScore - a.fusedScore);
    // A rerank that answered reordered the cut: its candidates hold the places the cut holds in the list, in the
    // order the rerank gave them, so the record lists them as the block shows them. The rest keep their places.
    let ranked = byFused;
    if (reranked.scores.size > 0) {
      const inCut = new Set(cut.map((entry) => entry.id));
      const entryOf = new Map(byFused.map((candidate) => [candidate.id, candidate]));
      const order = reranked.cut.map((entry) => entryOf.get(entry.id)).filter((candidate): candidate is RankedRecallCandidate => candidate !== undefined);
      let next = 0;
      ranked = byFused.map((candidate) => (inCut.has(candidate.id) && next < order.length ? order[next++] : candidate));
    }

    return {
      scored: [...reranked.cut, ...reserved].map((entry) => entry.trace),
      reranker: reranked.record,
      ...(reranked.scores.size > 0 ? { rerankScores: Object.fromEntries(reranked.scores) } : {}),
      rerankMs: reranked.ms,
      partial: dense.partial,
      storeTimings: dense.storeTimings,
      legs: [
        legEntry(dense),
        legEntry(words),
        legEntry(recent),
        ...(supplied ? [{ leg: 'supplied' as const, ran: true, candidates: suppliedIds.length, ineligible: supplied.ineligible, ms: 0 }] : []),
      ],
      retrieval: 'hybrid',
      ranked,
      lexicalBackend: words.ran ? lexicalBackendOf(store, lexical) : 'none',
      timings: { legsMs, fuseMs, dedupeMs },
      reserve: { fired: asked, ids: [...reservedIds] },
      // The supplied candidates the call shows or may show: those the dedupe kept.
      suppliedIds: kept.filter((entry) => shownSupplied.has(entry.id)).map((entry) => entry.id),
      ...(rejected ? { suppliedRejected: rejected } : {}),
    };
  }
}
