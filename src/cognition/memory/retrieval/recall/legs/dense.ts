/**
 * @fileoverview The dense recall leg: the store's vector query with its cognitive ranking, the trust-policy filter and
 * the memory graph's spreading-activation re-score.
 *
 * @module agentos/cognition/memory/retrieval/recall/legs/dense
 */
import type { MemoryGraphConfig, PADState } from '../../../core/config.js';
import { canUseFor, type CognitiveRetrievalOptions, type PartiallyRetrievedTrace, type ScoredMemoryTrace } from '../../../core/types.js';
import type { IMemoryGraph } from '../../graph/IMemoryGraph.js';
import type { MemoryStore } from '../../store/MemoryStore.js';
import type { LegResult } from './leg.js';

/** What the dense leg reads. */
export interface DenseLegDeps {
  store: MemoryStore;
  /** The manager's memory graph, if it has one. */
  graph: IMemoryGraph | null;
  /** The manager's graph settings. */
  graphConfig?: Partial<MemoryGraphConfig>;
}

/** What the dense leg answers, beside its ranked traces. */
export interface DenseLegResult extends LegResult<ScoredMemoryTrace> {
  /** The store's partially retrieved traces (tip of the tongue). */
  partial: PartiallyRetrievedTrace[];
  /** The store's own timings. */
  storeTimings: { vectorSearchMs: number; scoringMs: number };
}

/** The weights of the score the graph's activation re-computes. */
const ACTIVATION_WEIGHTS = {
  strength: 0.25,
  similarity: 0.35,
  recency: 0.1,
  emotionalCongruence: 0.15,
  graphActivation: 0.1,
  importance: 0.05,
};

/**
 * The dense leg: the store's vector query with its six-signal ranking; the trust-policy filter, which drops a trace
 * whose policy does not allow every `usableFor` capability (counted in `ineligible`); then, with a memory graph, the
 * spreading activation from the five best traces, which re-scores and re-sorts them, and the co-activation it records.
 * `ms` covers the query (its embedding, the vector search, the scoring), the filter and the activation, not the
 * co-activation write.
 *
 * @param deps - The store and the manager's graph.
 * @param query - The text the store embeds: the turn's, or a hypothesis written from it.
 * @param mood - The current mood, for the mood-congruence signal.
 * @param options - The turn's retrieval options, as the store reads them.
 * @returns `ran: false` with `no_embedder` when the embedding manager gave the query no vector.
 * @throws What `MemoryStore.query` throws, the embedder's error among it.
 */
export async function denseLeg(deps: DenseLegDeps, query: string, mood: PADState, options: CognitiveRetrievalOptions): Promise<DenseLegResult> {
  const started = performance.now();
  const { scored, partial, timings, emptyQueryVector } = await deps.store.query(query, mood, options);

  // The trust-policy filter: post-store rather than pre-store keeps the policy out of the vector layer, at the cost of
  // trimming results after the topK cut.
  let ineligible = 0;
  if (options.usableFor !== undefined) {
    const required = Array.isArray(options.usableFor) ? options.usableFor : [options.usableFor];
    const now = Date.now();
    const allowed = scored.filter((trace) => required.every((capability) => canUseFor(trace, capability, now)));
    ineligible = scored.length - allowed.length;
    scored.length = 0;
    scored.push(...allowed);
  }
  let ms = performance.now() - started;

  const { graph, graphConfig } = deps;
  if (graph && scored.length > 0) {
    const graphStartedAt = performance.now();
    let rankedAt: number | undefined;
    try {
      const activated = await graph.spreadingActivation(
        scored.slice(0, 5).map((t) => t.id),
        {
          maxDepth: graphConfig?.maxDepth,
          decayPerHop: graphConfig?.decayPerHop,
          activationThreshold: graphConfig?.activationThreshold,
        },
      );
      for (const node of activated) {
        const match = scored.find((s) => s.id === node.memoryId);
        if (match) {
          match.scoreBreakdown.graphActivationScore = node.activation;
          const w = ACTIVATION_WEIGHTS;
          match.retrievalScore = Math.max(
            0,
            Math.min(
              1,
              w.strength * match.scoreBreakdown.strengthScore +
                w.similarity * match.scoreBreakdown.similarityScore +
                w.recency * match.scoreBreakdown.recencyScore +
                w.emotionalCongruence * match.scoreBreakdown.emotionalCongruenceScore +
                w.graphActivation * node.activation +
                w.importance * match.scoreBreakdown.importanceScore,
            ),
          );
        }
      }
      scored.sort((a, b) => b.retrievalScore - a.retrievalScore);
      rankedAt = performance.now();
      // Co-activation for Hebbian learning: after the ranking, outside the leg's time.
      await graph.recordCoActivation(
        scored.slice(0, 5).map((t) => t.id),
        graphConfig?.hebbianLearningRate ?? 0.1,
      );
    } catch {
      // Graph operations are non-critical.
    }
    ms += (rankedAt ?? performance.now()) - graphStartedAt;
  }

  return {
    leg: 'dense',
    ran: !emptyQueryVector,
    ...(emptyQueryVector ? { reason: 'no_embedder' as const } : {}),
    traces: scored,
    ineligible,
    partial,
    storeTimings: timings,
    ms: Math.round(ms),
  };
}
