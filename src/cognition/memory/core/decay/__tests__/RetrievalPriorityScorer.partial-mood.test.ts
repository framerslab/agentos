import { describe, it, expect } from 'vitest';
import { detectPartiallyRetrieved } from '../RetrievalPriorityScorer.js';
import type { CandidateTrace, ScoringContext } from '../RetrievalPriorityScorer.js';
import type { MemoryTrace } from '../../types.js';

// #16: mood-aware FOK (tip-of-tongue) cues. detectPartiallyRetrieved gains an
// optional ScoringContext; a non-neutral mood congruence-weights confidence and
// sorts desc. Neutral / absent context / zero-valence mood must be byte-identical
// (the qualify gate is unchanged). These are pure-function tests — no DB.

// Minimal trace: only the fields detectPartiallyRetrieved + computeCurrentStrength read.
// provenance.confidence = 0.3 (< 0.4) → qualifies as partial regardless of strength;
// encodingStrength 0.1 + stability 1000 + old lastAccessedAt → computeCurrentStrength ≈ 0.
function trace(id: string, valence: number): MemoryTrace {
  return {
    id,
    content: `trace ${id}`,
    tags: ['t'],
    emotionalContext: { valence, arousal: 0, dominance: 0, intensity: 0, gmiMood: 'neutral' },
    provenance: { confidence: 0.3 },
    encodingStrength: 0.1,
    stability: 1000,
    lastAccessedAt: 0,
    createdAt: 0,
    accessCount: 0,
  } as unknown as MemoryTrace;
}
// vectorSimilarity 0.7 > 0.6 so all qualify.
function cand(id: string, valence: number, sim = 0.7): CandidateTrace {
  return { trace: trace(id, valence), vectorSimilarity: sim };
}
const NOW = 1_000_000;

describe('detectPartiallyRetrieved — mood-aware FOK', () => {
  const pos = cand('pos', +0.63); // congruent with a positive mood
  const neg = cand('neg', -0.63); // incongruent with a positive mood
  const candidates = [neg, pos]; // insertion order: neg first (mood-off baseline)

  it('non-neutral positive mood sorts congruent (pos) above incongruent (neg)', () => {
    const ctx: ScoringContext = { currentMood: { valence: 0.7, arousal: 0, dominance: 0 }, now: NOW };
    const out = detectPartiallyRetrieved(candidates, NOW, ctx);
    expect(out.map((p) => p.traceId)).toEqual(['pos', 'neg']);
    // base = min(provConfidence 0.3, sim*0.5 = 0.35) = 0.3; factor = 1 + max(0, 0.7*0.63)*0.25
    const posOut = out.find((p) => p.traceId === 'pos')!;
    expect(posOut.confidence).toBeCloseTo(0.3 * (1 + 0.7 * 0.63 * 0.25), 5);
    // neg gets factor 1.0 (mismatched sign → max(0, …) = 0)
    const negOut = out.find((p) => p.traceId === 'neg')!;
    expect(negOut.confidence).toBeCloseTo(0.3, 5);
  });

  it('neutral mood (valence 0) is byte-identical to the 2-arg call (order + values)', () => {
    const ctx: ScoringContext = { currentMood: { valence: 0, arousal: 0, dominance: 0 }, now: NOW };
    expect(detectPartiallyRetrieved(candidates, NOW, ctx)).toEqual(detectPartiallyRetrieved(candidates, NOW));
  });

  it('neutralMood:true is byte-identical even with a non-zero mood valence', () => {
    const ctx: ScoringContext = {
      currentMood: { valence: 0.7, arousal: 0, dominance: 0 },
      now: NOW,
      neutralMood: true,
    };
    expect(detectPartiallyRetrieved(candidates, NOW, ctx)).toEqual(detectPartiallyRetrieved(candidates, NOW));
  });

  it('absent context (2-arg) preserves insertion order [neg, pos]', () => {
    expect(detectPartiallyRetrieved(candidates, NOW).map((p) => p.traceId)).toEqual(['neg', 'pos']);
  });
});
