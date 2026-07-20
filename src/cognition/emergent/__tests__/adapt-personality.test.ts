/**
 * @fileoverview Tests for AdaptPersonalityTool.
 *
 * Covers:
 *  1. Mutate trait within budget
 *  2. Clamp delta when exceeding budget
 *  3. Track session total across multiple mutations
 *  4. Remaining budget decreases correctly
 *  5. Reject invalid trait name
 *  6. Reject missing/empty reasoning
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AdaptPersonalityTool,
  type PersonalityMutationStore,
  type AdaptPersonalityDeps,
} from '../AdaptPersonalityTool.js';
import type { ToolExecutionContext } from '../../../core/tools/ITool.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ToolExecutionContext for testing. */
function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    gmiId: 'test-gmi',
    personaId: 'test-persona',
    userContext: { userId: 'test-user' } as any,
    correlationId: 'test-session',
    ...overrides,
  };
}

/** Build default deps with an in-memory personality map. */
function makeDeps(overrides?: Partial<AdaptPersonalityDeps>): AdaptPersonalityDeps {
  const personality: Record<string, number> = {
    openness: 0.5,
    conscientiousness: 0.5,
    emotionality: 0.5,
    extraversion: 0.5,
    agreeableness: 0.5,
    honesty: 0.5,
  };

  return {
    config: { maxDeltaPerSession: 0.3 },
    mutationStore: { record: vi.fn().mockResolvedValue('pm_test') } as PersonalityMutationStore,
    getPersonality: () => personality,
    setPersonality: (trait, value) => {
      personality[trait] = value;
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdaptPersonalityTool', () => {
  let tool: AdaptPersonalityTool;
  let deps: AdaptPersonalityDeps;
  const ctx = makeContext();

  beforeEach(() => {
    deps = makeDeps();
    tool = new AdaptPersonalityTool(deps);
  });

  it('should mutate a trait within budget', async () => {
    const mutationStore = deps.mutationStore!;
    const result = await tool.execute(
      { trait: 'openness', delta: 0.1, reasoning: 'User likes creativity.' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.output!.trait).toBe('openness');
    expect(result.output!.previousValue).toBe(0.5);
    expect(result.output!.newValue).toBeCloseTo(0.6);
    expect(result.output!.delta).toBeCloseTo(0.1);
    expect(result.output!.clamped).toBe(false);
    expect(mutationStore.record).toHaveBeenCalledOnce();
    expect(mutationStore.record).toHaveBeenCalledWith({
      agentId: 'test-gmi',
      trait: 'openness',
      delta: 0.1,
      reasoning: 'User likes creativity.',
      baselineValue: 0.5,
      mutatedValue: 0.6,
    });
  });

  it('should clamp delta when exceeding session budget', async () => {
    // Budget is 0.3, request delta of 0.5 — should clamp to 0.3
    const result = await tool.execute(
      { trait: 'openness', delta: 0.5, reasoning: 'Big shift needed.' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output!.delta).toBeCloseTo(0.3);
    expect(result.output!.clamped).toBe(true);
    expect(result.output!.newValue).toBeCloseTo(0.8);
    expect(result.output!.remainingBudget).toBeCloseTo(0);
  });

  it('should track session total across multiple mutations', async () => {
    // First mutation: +0.1
    await tool.execute(
      { trait: 'openness', delta: 0.1, reasoning: 'Step 1.' },
      makeContext({
        correlationId: 'call-1',
        sessionData: { sessionId: 'shared-session' },
      }),
    );

    // Second mutation: +0.1 (total = 0.2)
    const result = await tool.execute(
      { trait: 'openness', delta: 0.1, reasoning: 'Step 2.' },
      makeContext({
        correlationId: 'call-2',
        sessionData: { sessionId: 'shared-session' },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.output!.sessionTotal).toBeCloseTo(0.2);
  });

  it('should isolate session budgets across different sessions', async () => {
    await tool.execute(
      { trait: 'openness', delta: 0.2, reasoning: 'Session one.' },
      makeContext({
        correlationId: 'call-1',
        sessionData: { sessionId: 'session-one' },
      }),
    );

    const result = await tool.execute(
      { trait: 'openness', delta: 0.2, reasoning: 'Session two.' },
      makeContext({
        correlationId: 'call-1',
        sessionData: { sessionId: 'session-two' },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.output!.delta).toBeCloseTo(0.2);
    expect(result.output!.sessionTotal).toBeCloseTo(0.2);
  });

  it('should report correct remaining budget after mutations', async () => {
    // First mutation: +0.15
    await tool.execute(
      { trait: 'extraversion', delta: 0.15, reasoning: 'Be more social.' },
      ctx,
    );

    // Second mutation: check remaining budget = 0.3 - 0.15 = 0.15
    const result = await tool.execute(
      { trait: 'extraversion', delta: 0.05, reasoning: 'A bit more.' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output!.remainingBudget).toBeCloseTo(0.1);
  });

  it('should reject an invalid trait name', async () => {
    const result = await tool.execute(
      { trait: 'charisma', delta: 0.1, reasoning: 'Not a HEXACO trait.' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid trait');
    expect(result.error).toContain('charisma');
  });

  it('should reject missing or empty reasoning', async () => {
    const result = await tool.execute(
      { trait: 'openness', delta: 0.1, reasoning: '' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('reasoning');

    const result2 = await tool.execute(
      { trait: 'openness', delta: 0.1, reasoning: '   ' },
      ctx,
    );

    expect(result2.success).toBe(false);
    expect(result2.error).toContain('reasoning');
  });

  it('should reject a non-finite delta', async () => {
    const result = await tool.execute(
      { trait: 'openness', delta: Number.NaN, reasoning: 'Bad delta.' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('finite number');
  });
});

describe('decay-on-adapt (spec batch-1 C6)', () => {
  it('ages stored strengths for this agent before recording, once per UTC day', async () => {
    const decayForAgent = vi.fn().mockResolvedValue({ decayed: 1, pruned: 0 });
    const deps = makeDeps({
      config: { maxDeltaPerSession: 0.3, persistWithDecay: true, decayRate: 0.05 },
      mutationStore: {
        record: vi.fn().mockResolvedValue('pm_test'),
        decayForAgent,
      } as PersonalityMutationStore,
    });
    const tool = new AdaptPersonalityTool(deps);

    await tool.execute(
      { trait: 'openness', delta: 0.1, reasoning: 'test' },
      makeContext({ gmiId: 'agent-decay' }),
    );

    const expectedCycle = 'day:' + new Date().toISOString().slice(0, 10);
    expect(decayForAgent).toHaveBeenCalledWith('agent-decay', 0.05, expectedCycle);
    const order =
      decayForAgent.mock.invocationCallOrder[0]! <
      (deps.mutationStore!.record as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(order).toBe(true);
  });

  it('persistWithDecay false performs zero decay calls', async () => {
    const decayForAgent = vi.fn();
    const deps = makeDeps({
      config: { maxDeltaPerSession: 0.3, persistWithDecay: false },
      mutationStore: {
        record: vi.fn().mockResolvedValue('pm_test'),
        decayForAgent,
      } as PersonalityMutationStore,
    });
    const tool = new AdaptPersonalityTool(deps);

    await tool.execute({ trait: 'openness', delta: 0.1, reasoning: 'test' }, makeContext());

    expect(decayForAgent).not.toHaveBeenCalled();
  });

  it('a store without decayForAgent skips decay and the adapt still succeeds', async () => {
    const deps = makeDeps({
      config: { maxDeltaPerSession: 0.3, persistWithDecay: true, decayRate: 0.05 },
      mutationStore: { record: vi.fn().mockResolvedValue('pm_test') } as PersonalityMutationStore,
    });
    const tool = new AdaptPersonalityTool(deps);

    const result = await tool.execute(
      { trait: 'openness', delta: 0.1, reasoning: 'test' },
      makeContext(),
    );

    expect((result as { success: boolean }).success).toBe(true);
  });

  it('a decay failure never blocks the adapt', async () => {
    const deps = makeDeps({
      config: { maxDeltaPerSession: 0.3, persistWithDecay: true, decayRate: 0.05 },
      mutationStore: {
        record: vi.fn().mockResolvedValue('pm_test'),
        decayForAgent: vi.fn().mockRejectedValue(new Error('db down')),
      } as PersonalityMutationStore,
    });
    const tool = new AdaptPersonalityTool(deps);

    const result = await tool.execute(
      { trait: 'openness', delta: 0.1, reasoning: 'test' },
      makeContext(),
    );

    expect((result as { success: boolean }).success).toBe(true);
  });
});
