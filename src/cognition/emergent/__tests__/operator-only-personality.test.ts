import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext } from '../../../core/tools/ITool.js';
import type { HexacoTraitKey } from '../../substrate/personas/hexaco.js';
import { NOTETAKER_PERSONA } from '../../substrate/personas/notetaker.js';
import { applyTraitOverlay, OPERATOR_ONLY_TRAITS } from '../../substrate/personas/personalityPrompt.js';
import { AdaptPersonalityTool } from '../AdaptPersonalityTool.js';

beforeEach(() => vi.stubEnv('AGENTOS_LEARNING_FREEZE', '0'));
afterEach(() => vi.unstubAllEnvs());

/** Builds a tool call context, with or without a learning layer. */
function context(withLearning: boolean): ToolExecutionContext {
  return {
    gmiId: 'fixture-gmi',
    personaId: 'notetaker',
    userContext: { userId: 'fixture-user' },
    correlationId: 'fixture-call',
    sessionData: {
      sessionId: 'fixture-session',
      ...(withLearning ? { learning: { learner: 'bound', mode: 'on' } } : {}),
    },
  };
}

/** Builds the tool over a notetaker trait map with spied dependencies. */
function harness() {
  const traits: Record<string, number> = { ...NOTETAKER_PERSONA };
  const getPersonality = vi.fn(() => traits);
  const setPersonality = vi.fn((trait: string, value: number) => { traits[trait] = value; });
  const record = vi.fn(() => 'fixture-mutation');
  const decayForAgent = vi.fn(async () => ({ decayed: 0, pruned: 0 }));
  const tool = new AdaptPersonalityTool({
    config: { maxDeltaPerSession: 0.3, persistWithDecay: true },
    getPersonality,
    setPersonality,
    mutationStore: { record, decayForAgent },
  });
  return { tool, traits, getPersonality, setPersonality, record, decayForAgent };
}

describe('operator-only personality traits on every host', () => {
  it('uses the two authored traits as the shared lock list', () => {
    expect(OPERATOR_ONLY_TRAITS).toEqual(['honesty', 'emotionality']);
  });

  for (const withLearning of [false, true]) {
    for (const trait of ['honesty', 'emotionality'] as const) {
      for (const delta of [-0.2, -0.01, 0, 0.01, 0.2]) {
        it(`refuses ${trait} delta ${delta}, learning ${withLearning}, before any side effect`, async () => {
          const h = harness();
          const result = await h.tool.execute({ trait, delta, reasoning: 'Fixture request.' }, context(withLearning));
          expect(result).toEqual({
            success: false,
            error: `adapt_personality refused (operator_only): only the persona definition sets ${trait}; nothing was changed.`,
            details: { status: 'rejected', reason: 'operator_only' },
          });
          expect(h.traits).toEqual(NOTETAKER_PERSONA);
          expect(h.getPersonality).not.toHaveBeenCalled();
          expect(h.setPersonality).not.toHaveBeenCalled();
          expect(h.record).not.toHaveBeenCalled();
          expect(h.decayForAgent).not.toHaveBeenCalled();
        });
      }
    }
  }

  it('leaves the four editable traits and no-layer budgets unchanged', async () => {
    for (const trait of ['extraversion', 'agreeableness', 'conscientiousness', 'openness'] as const) {
      const h = harness();
      const result = await h.tool.execute({ trait, delta: -0.1, reasoning: 'Fixture request.' }, context(false));
      expect(result.success).toBe(true);
      expect(result.output?.newValue).toBeCloseTo(NOTETAKER_PERSONA[trait] - 0.1);
      expect(result.output?.sessionTotal).toBeCloseTo(0.1);
      expect(result.output?.remainingBudget).toBeCloseTo(0.2);
      expect(h.record).toHaveBeenCalledOnce();
      expect(h.decayForAgent).toHaveBeenCalledOnce();
    }
  });

  it('spends no learning call allowance on a protected-trait refusal', async () => {
    const h = harness();
    const ctx = context(true);
    for (const trait of ['honesty', 'emotionality']) {
      await h.tool.execute({ trait, delta: 0.01, reasoning: 'Fixture request.' }, ctx);
    }
    for (let call = 0; call < 3; call += 1) {
      const result = await h.tool.execute({ trait: 'openness', delta: 0.01, reasoning: 'Fixture request.' }, ctx);
      expect(result.success).toBe(true);
    }
    const refused = await h.tool.execute({ trait: 'openness', delta: 0.01, reasoning: 'Fixture request.' }, ctx);
    expect(refused.details).toMatchObject({ reason: 'call_limit' });
    expect(h.record).toHaveBeenCalledTimes(3);
  });

  it('retains the learning step bound for an editable trait', async () => {
    const h = harness();
    const result = await h.tool.execute({ trait: 'openness', delta: 0.03, reasoning: 'Fixture request.' }, context(true));
    expect(result.details).toMatchObject({ reason: 'step_bound' });
    expect(h.getPersonality).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('keeps process freeze ahead of trait checks', async () => {
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    for (const withLearning of [false, true]) {
      const h = harness();
      const result = await h.tool.execute({ trait: 'honesty', delta: -0.2, reasoning: 'Fixture request.' }, context(withLearning));
      expect(result.details).toMatchObject({ reason: 'frozen' });
      expect(h.getPersonality).not.toHaveBeenCalled();
      expect(h.setPersonality).not.toHaveBeenCalled();
      expect(h.record).not.toHaveBeenCalled();
    }
  });

  it('keeps the lock list fixed at runtime, so a mutation attempt lifts neither guard on either host', async () => {
    // `readonly` binds TypeScript callers only: a JavaScript caller holds the array both guards read.
    const list = OPERATOR_ONLY_TRAITS as HexacoTraitKey[];
    expect(Object.isFrozen(OPERATOR_ONLY_TRAITS)).toBe(true);
    expect(() => list.splice(0)).toThrow(TypeError);
    expect(() => list.push('openness')).toThrow(TypeError);
    expect(OPERATOR_ONLY_TRAITS).toEqual(['honesty', 'emotionality']);
    for (const withLearning of [false, true]) {
      for (const trait of ['honesty', 'emotionality'] as const) {
        const h = harness();
        const result = await h.tool.execute({ trait, delta: 0.01, reasoning: 'Fixture request.' }, context(withLearning));
        expect(result.details).toEqual({ status: 'rejected', reason: 'operator_only' });
        expect(h.getPersonality).not.toHaveBeenCalled();
        expect(h.setPersonality).not.toHaveBeenCalled();
      }
    }
    expect(applyTraitOverlay(NOTETAKER_PERSONA, { honesty: 0.1, emotionality: 0.9 })).toEqual({
      traits: { ...NOTETAKER_PERSONA },
      dropped: ['honesty', 'emotionality'],
    });
  });
});
