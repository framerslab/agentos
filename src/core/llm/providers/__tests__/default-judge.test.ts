/**
 * @fileoverview Env-valve matrix tests for the central judge resolver and
 * the shared caller-wins resolution (spec batch-1 C3).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveDefaultJudgeModel } from '../default-judge.js';
import { resolveJudgeLlm } from '../judge-config.js';

const ENV = ['AGENTOS_JUDGE_MODEL', 'AGENTOS_JUDGE_PROVIDER', 'AGENTOS_JUDGE_EFFORT'] as const;
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

describe('resolveDefaultJudgeModel', () => {
  it('code default', () => {
    expect(resolveDefaultJudgeModel()).toEqual({ provider: 'openai', model: 'gpt-5.6', effort: 'max' });
  });

  it('model valve applies to the default provider', () => {
    process.env.AGENTOS_JUDGE_MODEL = 'gpt-5.5';
    expect(resolveDefaultJudgeModel()).toEqual({ provider: 'openai', model: 'gpt-5.5', effort: 'max' });
  });

  it('provider + model valves together select a non-default provider', () => {
    process.env.AGENTOS_JUDGE_PROVIDER = 'anthropic';
    process.env.AGENTOS_JUDGE_MODEL = 'claude-sonnet-5';
    expect(resolveDefaultJudgeModel()).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5', effort: 'max' });
  });

  it('provider valve without a model is ignored entirely (no cross-provider mix)', () => {
    process.env.AGENTOS_JUDGE_PROVIDER = 'anthropic';
    expect(resolveDefaultJudgeModel()).toEqual({ provider: 'openai', model: 'gpt-5.6', effort: 'max' });
  });

  it('invalid effort valve keeps the default with a warning', () => {
    process.env.AGENTOS_JUDGE_EFFORT = 'ultra';
    expect(resolveDefaultJudgeModel().effort).toBe('max');
  });

  it('valid effort valve applies', () => {
    process.env.AGENTOS_JUDGE_EFFORT = 'high';
    expect(resolveDefaultJudgeModel().effort).toBe('high');
  });
});

describe('resolveJudgeLlm', () => {
  it('no config → resolver default with effort', () => {
    expect(resolveJudgeLlm(undefined)).toEqual({ provider: 'openai', model: 'gpt-5.6', effort: 'max' });
  });

  it('caller-pinned model gets NO injected effort (zero-change)', () => {
    const sel = resolveJudgeLlm({ model: 'gpt-4o' });
    expect(sel).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect('effort' in sel).toBe(false);
  });

  it('caller-pinned model + explicit effort keeps both', () => {
    expect(resolveJudgeLlm({ model: 'gpt-4o', effort: 'high' })).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      effort: 'high',
    });
  });

  it('pinned non-default provider without a model throws', () => {
    expect(() => resolveJudgeLlm({ provider: 'anthropic' })).toThrow(/explicit model/);
  });

  it('pinned non-default provider with a model resolves without injected effort', () => {
    expect(resolveJudgeLlm({ provider: 'anthropic', model: 'claude-sonnet-5' })).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
  });

  it('empty-string model is treated as absent', () => {
    expect(resolveJudgeLlm({ model: '  ' })).toEqual({ provider: 'openai', model: 'gpt-5.6', effort: 'max' });
  });
});
