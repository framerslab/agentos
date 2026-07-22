/**
 * @fileoverview Judge-site assertion for the safety LLMJudge (queue item:
 * only hitl had a site-level test): the central resolver default
 * (gpt-5.6 @ max effort) must reach the provider call, and a caller-pinned
 * model must pass through with NO injected effort (zero request-shape
 * change for pinned callers).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { LLMJudge } from '../LLMJudge';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';

const ENV = ['AGENTOS_JUDGE_MODEL', 'AGENTOS_JUDGE_PROVIDER', 'AGENTOS_JUDGE_EFFORT'] as const;
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

function makeManager() {
  const generateCompletion = vi.fn().mockResolvedValue({
    choices: [
      {
        message: {
          content:
            '{"overallScore":0.9,"confidence":0.8,"reasoning":"ok","criteriaScores":{},"feedback":[]}',
        },
      },
    ],
  });
  const getProvider = vi.fn(() => ({ generateCompletion }));
  return {
    manager: { getProvider } as unknown as AIModelProviderManager,
    generateCompletion,
    getProvider,
  };
}

describe('LLMJudge default judge selection (spec batch-1 C3)', () => {
  it('routes the default judge call to gpt-5.6 on openai with effort max', async () => {
    const { manager, generateCompletion, getProvider } = makeManager();
    const judge = new LLMJudge({ llmProvider: manager });

    await judge.judge('input', 'output');

    expect(getProvider).toHaveBeenCalledWith('openai');
    expect(generateCompletion).toHaveBeenCalledWith(
      'gpt-5.6',
      expect.anything(),
      expect.objectContaining({ effort: 'max' }),
    );
  });

  it('a caller-pinned modelId passes through with NO injected effort', async () => {
    const { manager, generateCompletion } = makeManager();
    const judge = new LLMJudge({ llmProvider: manager, modelId: 'gpt-4o' });

    await judge.judge('input', 'output');

    const call = generateCompletion.mock.calls.at(-1)!;
    expect(call[0]).toBe('gpt-4o');
    expect('effort' in (call[2] as Record<string, unknown>)).toBe(false);
  });
});
