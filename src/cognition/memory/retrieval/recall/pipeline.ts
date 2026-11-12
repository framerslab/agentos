/**
 * @fileoverview A memory manager's recall pipeline: the legs it runs for a turn and what it reports of them.
 *
 * @module agentos/cognition/memory/retrieval/recall/pipeline
 */
import type { MemoryGraphConfig, PADState } from '../../core/config.js';
import type { CognitiveRetrievalOptions, PartiallyRetrievedTrace, ScoredMemoryTrace } from '../../core/types.js';
import type { IMemoryGraph } from '../graph/IMemoryGraph.js';
import type { MemoryStore } from '../store/MemoryStore.js';
import type { MemoryRecallCapture } from './capture.js';
import { denseLeg } from './legs/dense.js';
import { oncePerProcess, recallLog } from './log.js';

/** What a pipeline reads, each at every run: a manager's store, graph and graph settings can change after it is made. */
export interface RecallPipelineDeps {
  store: () => MemoryStore;
  graph: () => IMemoryGraph | null;
  graphConfig: () => Partial<MemoryGraphConfig> | undefined;
}

/** What one recall run returns. */
export interface RecallRun {
  /** The recalled traces, best first. */
  scored: ScoredMemoryTrace[];
  /** The store's partially retrieved traces. */
  partial: PartiallyRetrievedTrace[];
  /** The store's own timings. */
  storeTimings: { vectorSearchMs: number; scoringMs: number };
  /** Each leg the run ran or could not run, as the recall capture reports it. */
  legs: MemoryRecallCapture['legs'];
}

/**
 * One memory manager's recall. It runs the dense leg: the store's vector query, the trust-policy filter and the
 * memory graph's activation. A leg that could not run writes one `memory.recall.leg_absent` line per process for its
 * reason.
 */
export class RecallPipeline {
  constructor(private readonly deps: RecallPipelineDeps) {}

  /**
   * Runs the turn's recall.
   *
   * @param input.denseQuery - The text the dense leg embeds: the turn's, or a hypothesis written from it.
   * @param input.mood - The current mood.
   * @param input.options - The turn's retrieval options.
   * @throws What the dense leg throws: with one leg, its failure fails the recall, as `retrieve()` did before the
   *   pipeline.
   */
  async run(input: { denseQuery: string; mood: PADState; options: CognitiveRetrievalOptions }): Promise<RecallRun> {
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
      legs: [
        {
          leg: 'dense',
          ran: dense.ran,
          ...(dense.reason ? { reason: dense.reason } : {}),
          candidates: dense.traces.length,
          ineligible: dense.ineligible,
          ms: dense.ms,
        },
      ],
    };
  }
}
