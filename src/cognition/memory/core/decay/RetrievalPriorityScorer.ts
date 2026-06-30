/**
 * @fileoverview Composite retrieval priority scoring.
 *
 * Combines multiple signals into a single score for ranking memory traces:
 * - Current strength (Ebbinghaus decay)
 * - Vector similarity (semantic relevance)
 * - Recency boost (temporal proximity)
 * - Emotional congruence (mood-congruent recall)
 * - Graph activation (spreading activation — 0 in Batch 1)
 * - Importance (inherent importance of the memory)
 *
 * @module agentos/memory/decay/RetrievalPriorityScorer
 */

import type { MemoryTrace, ScoredMemoryTrace, PartiallyRetrievedTrace } from '../types.js';
import type { PADState, DecayConfig } from '../config.js';
import { DEFAULT_DECAY_CONFIG } from '../config.js';
import { computeCurrentStrength } from './DecayModel.js';

// ---------------------------------------------------------------------------
// Score weights
// ---------------------------------------------------------------------------

export interface ScoringWeights {
  strength: number;
  similarity: number;
  recency: number;
  emotionalCongruence: number;
  graphActivation: number;
  importance: number;
}

/**
 * Name of a single retrieval signal. Enables ablation studies — zero
 * one weight at a time and measure Δaccuracy.
 */
export type SignalName = keyof ScoringWeights;

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  strength: 0.25,
  similarity: 0.35,
  recency: 0.10,
  emotionalCongruence: 0.15,
  graphActivation: 0.10,
  importance: 0.05,
};

// ---------------------------------------------------------------------------
// Individual score components
// ---------------------------------------------------------------------------

/**
 * Recency boost: exponential decay from recent events.
 * Recent memories (within the half-life window) get a small bonus.
 *
 * boost = 1 + 0.2 · e^(-elapsed / halfLife)
 */
export function computeRecencyBoost(
  lastAccessedAt: number,
  now: number,
  halfLifeMs: number = DEFAULT_DECAY_CONFIG.recencyHalfLifeMs,
): number {
  const elapsed = Math.max(0, now - lastAccessedAt);
  return 1 + 0.2 * Math.exp(-elapsed / halfLifeMs);
}

/**
 * Mood-congruent recall: current mood biases retrieval toward memories
 * with matching emotional valence.
 *
 * congruence = 1 + max(0, currentValence · traceValence) · 0.25
 */
export function computeEmotionalCongruence(
  currentMood: PADState,
  traceValence: number,
): number {
  const match = Math.max(0, currentMood.valence * traceValence);
  return 1 + match * 0.25;
}

// ---------------------------------------------------------------------------
// Composite scorer
// ---------------------------------------------------------------------------

export interface ScoringContext {
  currentMood: PADState;
  now: number;
  /** Set to true to disable emotional congruence bias. */
  neutralMood?: boolean;
  decayConfig?: DecayConfig;
  weights?: ScoringWeights;
}

export interface CandidateTrace {
  trace: MemoryTrace;
  /** Cosine similarity from vector search (0-1). */
  vectorSimilarity: number;
  /** Activation level from spreading activation (0-1). 0 if graph not available. */
  graphActivation?: number;
}

/**
 * Score a batch of candidate traces and return them sorted by priority.
 */
export function scoreAndRankTraces(
  candidates: CandidateTrace[],
  context: ScoringContext,
): ScoredMemoryTrace[] {
  const w = context.weights ?? DEFAULT_SCORING_WEIGHTS;
  const config = context.decayConfig ?? DEFAULT_DECAY_CONFIG;

  const scored: ScoredMemoryTrace[] = candidates.map(({ trace, vectorSimilarity, graphActivation }) => {
    const strengthScore = computeCurrentStrength(trace, context.now);
    const similarityScore = vectorSimilarity;
    const recencyScore = computeRecencyBoost(trace.lastAccessedAt, context.now, config.recencyHalfLifeMs);
    const emotionalCongruenceScore = context.neutralMood
      ? 1.0
      : computeEmotionalCongruence(context.currentMood, trace.emotionalContext.valence);
    const graphActivationScore = graphActivation ?? 0;
    const importanceScore = trace.provenance.confidence * 0.5 + 0.5; // blend confidence with base

    // Normalise recency and emotional congruence to ~0-1 range for weighted sum
    const normRecency = (recencyScore - 1.0) / 0.2; // 0 when no boost, 1 when max boost
    const normEmotional = (emotionalCongruenceScore - 1.0) / 0.25;

    const compositeScore =
      w.strength * strengthScore +
      w.similarity * similarityScore +
      w.recency * normRecency +
      w.emotionalCongruence * normEmotional +
      w.graphActivation * graphActivationScore +
      w.importance * importanceScore;

    return {
      ...trace,
      retrievalScore: Math.max(0, Math.min(1, compositeScore)),
      scoreBreakdown: {
        strengthScore,
        similarityScore,
        recencyScore: normRecency,
        emotionalCongruenceScore: normEmotional,
        graphActivationScore,
        importanceScore,
      },
    };
  });

  // Sort descending by composite score
  scored.sort((a, b) => b.retrievalScore - a.retrievalScore);
  return scored;
}

// ---------------------------------------------------------------------------
// Tip-of-the-tongue detection
// ---------------------------------------------------------------------------

/**
 * Detect partially-accessible memories (high relevance but low strength).
 * These are memories the agent "almost" remembers — like tip-of-the-tongue states.
 */
export function detectPartiallyRetrieved(
  candidates: CandidateTrace[],
  now: number,
  scoringContext?: ScoringContext,
): PartiallyRetrievedTrace[] {
  // #16: when a non-neutral mood is supplied, weight FOK confidence by emotional
  // congruence and sort desc so mood-congruent tip-of-tongue cues surface first.
  // Absent context / neutralMood / zero-valence mood → byte-identical (factor 1.0,
  // no sort): the qualify gate below is unchanged.
  const moodActive =
    !!scoringContext && !scoringContext.neutralMood && scoringContext.currentMood.valence !== 0;
  const partials = candidates
    .filter(({ trace, vectorSimilarity }) => {
      const strength = computeCurrentStrength(trace, now);
      return vectorSimilarity > 0.6 && (strength < 0.3 || trace.provenance.confidence < 0.4);
    })
    .map(({ trace, vectorSimilarity }) => {
      const base = Math.min(trace.provenance.confidence, vectorSimilarity * 0.5);
      const factor = moodActive
        ? computeEmotionalCongruence(scoringContext!.currentMood, trace.emotionalContext.valence)
        : 1.0;
      return {
        traceId: trace.id,
        confidence: Math.min(1.0, base * factor),
        partialContent: trace.content.length > 100
          ? trace.content.substring(0, 100) + '...'
          : trace.content,
        suggestedCues: trace.tags.slice(0, 3),
      };
    });
  if (moodActive) partials.sort((a, b) => b.confidence - a.confidence);
  return partials;
}
