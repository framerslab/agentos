/**
 * @fileoverview Integration tests for cognitive mechanisms wired into the
 * memory pipeline (MemoryStore, MemoryPromptAssembler).
 *
 * These tests verify that the lifecycle hooks actually fire through the
 * real pipeline objects, not just in isolation.
 *
 * @module memory/mechanisms/__tests__/integration.test
 */

import { describe, it, expect, vi } from 'vitest';
import { CognitiveMechanismsEngine } from '../CognitiveMechanismsEngine.js';
import { assembleMemoryContext } from '../../core/prompt/MemoryPromptAssembler.js';
import type { MemoryTrace, ScoredMemoryTrace } from '../../core/types.js';
import type { PADState, HexacoTraits } from '../../core/config.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function makeTrace(overrides: Partial<MemoryTrace> = {}): MemoryTrace {
  return {
    id: `mt_${Math.random().toString(36).slice(2)}`,
    type: 'episodic',
    scope: 'user',
    scopeId: 'u1',
    content: 'integration test memory content',
    entities: ['deployment'],
    tags: ['test'],
    provenance: {
      sourceType: 'user_statement',
      confidence: 0.8,
      verificationCount: 0,
      sourceTimestamp: Date.now(),
    },
    emotionalContext: {
      valence: -0.3,
      arousal: 0.5,
      dominance: 0.0,
      intensity: 0.15,
      gmiMood: 'NEUTRAL',
    },
    encodingStrength: 0.5,
    stability: 3_600_000,
    retrievalCount: 2,
    lastAccessedAt: Date.now() - DAY_MS,
    accessCount: 3,
    reinforcementInterval: 3_600_000,
    associatedTraceIds: [],
    updatedAt: Date.now(),
    createdAt: Date.now() - 7 * DAY_MS,
    isActive: true,
    ...overrides,
  } as MemoryTrace;
}

function makeScoredTrace(overrides: Partial<ScoredMemoryTrace> = {}): ScoredMemoryTrace {
  return {
    ...makeTrace(),
    retrievalScore: 0.7,
    scoreBreakdown: {
      strengthScore: 0.5,
      similarityScore: 0.8,
      recencyScore: 0.3,
      emotionalCongruenceScore: 0.3,
      graphActivationScore: 0.0,
      importanceScore: 0.5,
    },
    ...overrides,
  };
}

const happyMood: PADState = { valence: 0.7, arousal: 0.3, dominance: 0.2 };

// ---------------------------------------------------------------------------
// Pipeline integration: onAccess through engine
// ---------------------------------------------------------------------------

describe('Pipeline integration: reconsolidation via onAccess', () => {
  it('engine.onAccess drifts trace emotional context toward current mood', () => {
    const engine = new CognitiveMechanismsEngine({});
    const trace = makeTrace({
      emotionalContext: { valence: -0.5, arousal: 0.8, dominance: -0.2, intensity: 0.4, gmiMood: 'NEUTRAL' },
    });
    const beforeV = trace.emotionalContext.valence;
    const beforeA = trace.emotionalContext.arousal;

    engine.onAccess(trace, happyMood);

    // Valence should move toward 0.7 (happy mood)
    expect(trace.emotionalContext.valence).toBeGreaterThan(beforeV);
    // Arousal should move toward 0.3 (lower than 0.8)
    expect(trace.emotionalContext.arousal).toBeLessThan(beforeA);
  });

  it('HEXACO high emotionality causes stronger drift', () => {
    const lowE = new CognitiveMechanismsEngine({}, { emotionality: 0.1 });
    const highE = new CognitiveMechanismsEngine({}, { emotionality: 0.9 });

    const traceLow = makeTrace({
      emotionalContext: { valence: -0.5, arousal: 0.5, dominance: 0.0, intensity: 0.25, gmiMood: 'NEUTRAL' },
    });
    const traceHigh = makeTrace({
      emotionalContext: { valence: -0.5, arousal: 0.5, dominance: 0.0, intensity: 0.25, gmiMood: 'NEUTRAL' },
    });

    lowE.onAccess(traceLow, happyMood);
    highE.onAccess(traceHigh, happyMood);

    const driftLow = Math.abs(traceLow.emotionalContext.valence - (-0.5));
    const driftHigh = Math.abs(traceHigh.emotionalContext.valence - (-0.5));
    expect(driftHigh).toBeGreaterThan(driftLow);
  });
});

// ---------------------------------------------------------------------------
// Pipeline integration: onRetrieval through engine
// ---------------------------------------------------------------------------

describe('Pipeline integration: RIF + FOK via onRetrieval', () => {
  it('suppresses competitors and detects FOK signals in one call', () => {
    const engine = new CognitiveMechanismsEngine({});
    const winner = makeScoredTrace({ id: 'winner', retrievalScore: 0.8 });
    const competitor = {
      trace: makeTrace({ id: 'comp', stability: 100_000 }),
      vectorSimilarity: 0.6,
    };
    const partial = {
      trace: makeTrace({ id: 'partial', entities: ['deployment'] }),
      vectorSimilarity: 0.9, // approx score 0.315, in partial zone for cutoff 0.8
    };

    const { suppressedIds, metacognitiveSignals } = engine.onRetrieval(
      [winner],
      [{ trace: winner, vectorSimilarity: 0.9 }, competitor, partial],
      0.8,
      ['deployment'],
    );

    expect(suppressedIds).toContain('comp');
    expect(metacognitiveSignals.length).toBeGreaterThanOrEqual(1);
    expect(metacognitiveSignals.some((s) => s.traceId === 'partial')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pipeline integration: onEncoding through engine
// ---------------------------------------------------------------------------

describe('Pipeline integration: schema encoding via onEncoding', () => {
  it('applies novelty boost when no matching cluster exists', () => {
    const engine = new CognitiveMechanismsEngine({});
    engine.setClusterCentroids(new Map([['existing', [1, 0, 0, 0]]]));

    const trace = makeTrace({ encodingStrength: 0.5 });
    engine.onEncoding(trace, [0.1, 0.1, 0.9, 0.1]); // novel direction

    expect(trace.encodingStrength).toBeGreaterThan(0.5);
  });

  it('applies congruency discount when matching cluster exists', () => {
    const engine = new CognitiveMechanismsEngine({});
    engine.setClusterCentroids(new Map([['existing', [1, 0, 0, 0]]]));

    const trace = makeTrace({ encodingStrength: 0.6 });
    engine.onEncoding(trace, [0.98, 0.05, 0.0, 0.0]); // very close to cluster

    expect(trace.encodingStrength).toBeLessThan(0.6);
  });

  it('HEXACO high openness amplifies novelty boost', () => {
    const lowO = new CognitiveMechanismsEngine({}, { openness: 0.1 });
    const highO = new CognitiveMechanismsEngine({}, { openness: 0.9 });

    lowO.setClusterCentroids(new Map([['c1', [1, 0, 0, 0]]]));
    highO.setClusterCentroids(new Map([['c1', [1, 0, 0, 0]]]));

    const traceLow = makeTrace({ encodingStrength: 0.5 });
    const traceHigh = makeTrace({ encodingStrength: 0.5 });

    lowO.onEncoding(traceLow, [0.1, 0.1, 0.9, 0.1]);
    highO.onEncoding(traceHigh, [0.1, 0.1, 0.9, 0.1]);

    expect(traceHigh.encodingStrength).toBeGreaterThan(traceLow.encodingStrength);
  });
});

// ---------------------------------------------------------------------------
// Pipeline integration: onConsolidation through engine
// ---------------------------------------------------------------------------

describe('Pipeline integration: consolidation mechanisms via onConsolidation', () => {
  it('runs all three consolidation mechanisms and returns aggregate counts', async () => {
    const engine = new CognitiveMechanismsEngine({});

    const oldLowRetrieval = makeTrace({
      createdAt: Date.now() - 90 * DAY_MS,
      retrievalCount: 0,
      encodingStrength: 0.5,
    });

    const reflection = makeTrace({
      provenance: { sourceType: 'reflection', confidence: 0.5, verificationCount: 0, sourceTimestamp: Date.now() },
      stability: 100_000,
    });

    const intense = makeTrace({
      emotionalContext: { valence: -0.9, arousal: 0.85, dominance: 0.0, intensity: 0.765, gmiMood: 'FRUSTRATED' },
      encodingStrength: 0.5,
    });

    const result = await engine.onConsolidation([oldLowRetrieval, reflection, intense]);

    expect(result.gistedCount).toBe(1);
    expect(result.sourceDecayedCount).toBe(1);
    expect(result.regulatedCount).toBe(1);

    // Verify mutations happened
    expect((oldLowRetrieval.structuredData?.mechanismMetadata as any)?.gisted).toBe(true);
    expect(reflection.stability).toBeLessThan(100_000);
    expect(Math.abs(intense.emotionalContext.valence)).toBeLessThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// Pipeline integration: involuntary recall via MemoryPromptAssembler
// ---------------------------------------------------------------------------

describe('Pipeline integration: involuntary recall via assembleMemoryContext', () => {
  it('injects spontaneous memory section when engine returns one', () => {
    const engine = new CognitiveMechanismsEngine({
      involuntaryRecall: { probability: 1.0 }, // force trigger
    });

    const oldVividTrace = makeTrace({
      id: 'old_vivid',
      createdAt: Date.now() - 30 * DAY_MS,
      encodingStrength: 0.6,
      content: 'That time we fixed the production outage at 2am',
      emotionalContext: { valence: 0.8, arousal: 0.9, dominance: 0.5, intensity: 0.72, gmiMood: 'FOCUSED' },
    });

    const result = assembleMemoryContext({
      totalTokenBudget: 2000,
      traits: { openness: 0.7, conscientiousness: 0.6 },
      retrievedTraces: [makeScoredTrace({ id: 'retrieved_1' })],
      mechanismsEngine: engine,
      allTraces: [oldVividTrace],
    });

    expect(result.contextText).toContain('Something This Reminds Me Of');
    expect(result.contextText).toContain('spontaneous memory');
    expect(result.includedMemoryIds).toContain('old_vivid');
  });

  it('does not inject when engine returns null (probability 0)', () => {
    const engine = new CognitiveMechanismsEngine({
      involuntaryRecall: { probability: 0 },
    });

    const result = assembleMemoryContext({
      totalTokenBudget: 2000,
      traits: { openness: 0.7 },
      retrievedTraces: [],
      mechanismsEngine: engine,
      allTraces: [makeTrace({ createdAt: Date.now() - 30 * DAY_MS })],
    });

    expect(result.contextText).not.toContain('Something This Reminds Me Of');
  });

  it("shows a reply of the agent's own as its words, and a host's own inference as it is", () => {
    const old = {
      createdAt: Date.now() - 30 * DAY_MS,
      encodingStrength: 0.6,
      emotionalContext: { valence: 0.8, arousal: 0.9, dominance: 0.5, intensity: 0.72, gmiMood: 'FOCUSED' },
    };
    const provenance = { sourceType: 'agent_inference' as const, confidence: 0.8, verificationCount: 0, sourceTimestamp: Date.now() };
    // A GMI files its reply so: semantic, agent_inference, the bridge's tags with the role first.
    const reply = makeTrace({
      ...old,
      id: 'old_reply',
      type: 'semantic',
      content: 'I promised to look at the outage report with you',
      tags: ['assistant', 'ops', 'u1'],
      provenance,
    });
    // A conclusion a host filed itself with the same sourceType and without the tag.
    const inference = makeTrace({
      ...old,
      id: 'host_inference',
      type: 'semantic',
      content: 'The user probably works night shifts',
      tags: [],
      provenance,
    });
    const recall = (trace: MemoryTrace) =>
      assembleMemoryContext({
        totalTokenBudget: 2000,
        traits: { openness: 0.7, conscientiousness: 0.6 },
        retrievedTraces: [],
        mechanismsEngine: new CognitiveMechanismsEngine({ involuntaryRecall: { probability: 1.0 } }),
        allTraces: [trace],
      }).contextText;

    const withReply = recall(reply);
    expect(withReply).toContain('Something This Reminds Me Of');
    expect(withReply).toContain(`You said: ${reply.content}`);

    const withInference = recall(inference);
    expect(withInference).toContain('Something This Reminds Me Of');
    expect(withInference).toContain(inference.content);
    expect(withInference).not.toContain(`You said: ${inference.content}`);
  });

  it('does not inject when no engine provided (backward compatible)', () => {
    const result = assembleMemoryContext({
      totalTokenBudget: 2000,
      traits: {},
      retrievedTraces: [],
    });

    expect(result.contextText).not.toContain('spontaneous memory');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: full personality-modulated pipeline
// ---------------------------------------------------------------------------

describe('End-to-end: HEXACO-modulated mechanisms through full pipeline', () => {
  it('high-emotionality high-openness agent has stronger drift + more involuntary recall', () => {
    const traits: HexacoTraits = {
      emotionality: 0.9,
      openness: 0.9,
      conscientiousness: 0.5,
      agreeableness: 0.5,
      honesty: 0.5,
      extraversion: 0.5,
    };
    const engine = new CognitiveMechanismsEngine({}, traits);
    const cfg = engine.getConfig();

    // High emotionality → stronger reconsolidation
    expect(cfg.reconsolidation.driftRate).toBeGreaterThan(0.05);

    // High openness → more involuntary recall
    expect(cfg.involuntaryRecall.probability).toBeGreaterThan(0.08);

    // High openness → stronger novelty boost
    expect(cfg.schemaEncoding.noveltyBoost).toBeGreaterThan(1.3);

    // Verify drift actually works stronger
    const trace = makeTrace({
      emotionalContext: { valence: -0.5, arousal: 0.5, dominance: 0.0, intensity: 0.25, gmiMood: 'NEUTRAL' },
    });
    engine.onAccess(trace, happyMood);
    const drift = trace.emotionalContext.valence - (-0.5);
    expect(drift).toBeGreaterThan(0.05 * 1.2); // at least default * 1.2
  });

  it('high-honesty agent is more skeptical of own reflections', () => {
    const traits: HexacoTraits = { honesty: 0.95 };
    const engine = new CognitiveMechanismsEngine({}, traits);
    const cfg = engine.getConfig();

    expect(cfg.sourceConfidenceDecay.decayMultipliers.reflection).toBeLessThan(0.75);
    expect(cfg.sourceConfidenceDecay.decayMultipliers.agent_inference).toBeLessThan(0.80);
    // But user_statement stays at 1.0
    expect(cfg.sourceConfidenceDecay.decayMultipliers.user_statement).toBe(1.0);
  });

  it('low-trait agent has weaker mechanism effects', () => {
    const traits: HexacoTraits = {
      emotionality: 0.1,
      openness: 0.1,
      conscientiousness: 0.1,
      agreeableness: 0.1,
      honesty: 0.1,
      extraversion: 0.1,
    };
    const engine = new CognitiveMechanismsEngine({}, traits);
    const cfg = engine.getConfig();

    // All personality-modulated params should be below defaults
    expect(cfg.reconsolidation.driftRate).toBeLessThan(0.05);
    expect(cfg.involuntaryRecall.probability).toBeLessThan(0.08);
    expect(cfg.retrievalInducedForgetting.suppressionFactor).toBeLessThan(0.12);
    expect(cfg.emotionRegulation.reappraisalRate).toBeLessThan(0.15);
  });
});
