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
import type { MemoryRecallCapture, RankedRecallCandidate } from './capture.js';
import { dedupePool } from './dedupe.js';
import { fuseLegs, RECALL_CONSTANTS, type RecallConstants } from './fuse.js';
import { ScopedLexicalIndex } from './lexical.js';
import { denseLeg, type DenseLegResult } from './legs/dense.js';
import { exactWordsLeg, lexicalBackendOf } from './legs/exactWords.js';
import type { LegQuery } from './legs/leg.js';
import { recencyLeg } from './legs/recency.js';
import { oncePerProcess, recallLog } from './log.js';

/** What a pipeline reads, each at every run: a manager's store, graph and settings can change after it is made. */
export interface RecallPipelineDeps {
  store: () => MemoryStore;
  graph: () => IMemoryGraph | null;
  graphConfig: () => Partial<MemoryGraphConfig> | undefined;
  /** The manager's recall settings (`retrieval`, `constants`); unset is `retrieval: 'dense'`. */
  recall?: () => ManagerRecallConfig | undefined;
}

/** What one recall run returns. */
export interface RecallRun {
  /** The recalled traces, best first: under `hybrid`, the deduped pool cut at `topK`. */
  scored: ScoredMemoryTrace[];
  /** The store's partially retrieved traces. */
  partial: PartiallyRetrievedTrace[];
  /** The store's own timings. */
  storeTimings: { vectorSearchMs: number; scoringMs: number };
  /** Each leg the run ran or could not run, as the recall capture reports it. */
  legs: MemoryRecallCapture['legs'];
  /** Which recall ran. */
  retrieval: 'dense' | 'hybrid';
  /** Under `hybrid`: the whole pool in fused order, a candidate the dedupe dropped with `duplicateOf`. */
  ranked?: RankedRecallCandidate[];
  /** Under `hybrid`: the full-text backend the exact-words leg read, `none` when it did not run. */
  lexicalBackend?: MemoryRecallCapture['lexicalBackend'];
  /** Under `hybrid`: milliseconds of the legs (run together), the fusion and the dedupe. */
  timings?: { legsMs: number; fuseMs: number; dedupeMs: number };
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
 */
export class RecallPipeline {
  /** The in-process exact-words index of a store with no Brain, and the store it follows. */
  private lexical: { store: MemoryStore; index: ScopedLexicalIndex } | null = null;

  constructor(private readonly deps: RecallPipelineDeps) {}

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
    if (settings?.retrieval === 'hybrid') return this.runHybrid(input, constantsOf(settings));
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
    return {
      scored: dense.traces,
      partial: dense.partial,
      storeTimings: dense.storeTimings,
      legs: [legEntry(dense)],
      retrieval: 'dense',
    };
  }

  /** Stops the in-process exact-words index following its store. */
  dispose(): void {
    this.lexical?.index.dispose();
    this.lexical = null;
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
    const pool = fuseLegs(
      { dense: dense.traces.filter(live), exactWords: asScored(words.traces).filter(live), recency: asScored(recent.traces).filter(live) },
      c,
    );
    const fuseMs = Math.round(performance.now() - fuseStarted);

    const dedupeStarted = performance.now();
    const { kept, dropped } = dedupePool(pool, c.nearDuplicate);
    const dedupeMs = Math.round(performance.now() - dedupeStarted);
    const duplicateOf = new Map(dropped.map((d) => [d.entry.id, d.duplicateOf]));
    // A newer text that took an older one's place carries that one's fused score and ranks.
    const keptAs = new Map(kept.map((entry) => [entry.id, entry]));

    return {
      scored: kept.slice(0, topK).map((entry) => entry.trace),
      partial: dense.partial,
      storeTimings: dense.storeTimings,
      legs: [legEntry(dense), legEntry(words), legEntry(recent)],
      retrieval: 'hybrid',
      // The whole pool by fused score, a kept candidate with the score it holds; equal scores keep the pool's order.
      ranked: pool
        .map(({ id, ranks, fusedScore }) => ({
          id,
          ranks: keptAs.get(id)?.ranks ?? ranks,
          fusedScore: keptAs.get(id)?.fusedScore ?? fusedScore,
          ...(duplicateOf.has(id) ? { duplicateOf: duplicateOf.get(id)! } : {}),
        }))
        .sort((a, b) => b.fusedScore - a.fusedScore),
      lexicalBackend: words.ran ? lexicalBackendOf(store, lexical) : 'none',
      timings: { legsMs, fuseMs, dedupeMs },
    };
  }
}
