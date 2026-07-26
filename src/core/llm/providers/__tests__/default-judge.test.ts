/**
 * @fileoverview Env-valve matrix tests for the central judge resolver and
 * the shared caller-wins resolution (spec batch-1 C3).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resolveDefaultJudgeModel } from '../default-judge.js';
import { resolveJudgeLlm } from '../judge-config.js';

const ENV = ['AGENTOS_JUDGE_MODEL', 'AGENTOS_JUDGE_PROVIDER', 'AGENTOS_JUDGE_EFFORT'] as const;
// Save/restore the real environment so this suite cannot leak valve state
// into other suites (or inherit a developer's local valves).
const originalEnv = new Map(ENV.map((key) => [key, process.env[key]]));
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
});
afterAll(() => {
  for (const k of ENV) {
    const value = originalEnv.get(k);
    if (value === undefined) delete process.env[k];
    else process.env[k] = value;
  }
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

describe('gpt-5.6 chat effort ceiling (probe regression pin)', () => {
  it('clamps agentos max to xhigh on the gpt-5.6 family (proven 2026-07-20: reasoning_effort rejects "max" with unsupported_value)', async () => {
    const { mapEffortToOpenAiReasoningEffortForModel } = await import('../model-effort.js');
    expect(mapEffortToOpenAiReasoningEffortForModel('max', 'gpt-5.6')).toBe('xhigh');
    expect(mapEffortToOpenAiReasoningEffortForModel('max', 'gpt-5.6-sol')).toBe('xhigh');
    expect(mapEffortToOpenAiReasoningEffortForModel('high', 'gpt-5.6')).toBe('high');
  });
});

describe('layered resolution (env valves never leak into the caller rule)', () => {
  it('caller pinning the code-default provider ignores an env pair for a different provider', () => {
    process.env.AGENTOS_JUDGE_PROVIDER = 'anthropic';
    process.env.AGENTOS_JUDGE_MODEL = 'claude-sonnet-5';
    expect(resolveJudgeLlm({ provider: 'openai' })).toEqual({
      provider: 'openai',
      model: 'gpt-5.6',
      effort: 'max',
    });
  });

  it('caller pinning a non-default provider still requires a caller model even when the env pair matches', () => {
    process.env.AGENTOS_JUDGE_PROVIDER = 'anthropic';
    process.env.AGENTOS_JUDGE_MODEL = 'claude-sonnet-5';
    expect(() => resolveJudgeLlm({ provider: 'anthropic' })).toThrow(/explicit model/);
  });

  it('an unrecognized env provider disables both valves', () => {
    process.env.AGENTOS_JUDGE_PROVIDER = 'my-custom-llm';
    process.env.AGENTOS_JUDGE_MODEL = 'whatever-1';
    expect(resolveDefaultJudgeModel()).toEqual({ provider: 'openai', model: 'gpt-5.6', effort: 'max' });
  });
});
