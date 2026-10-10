import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, getProvider, createProviderManager };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn((opts: { model?: string }, task?: string) =>
    task === 'embedding' ? { providerId: 'openai', modelId: 'text-embedding-3-small' } : { providerId: 'openai', modelId: 'gpt-6-luna' }),
  resolveProvider: vi.fn((providerId: string, modelId: string) => ({ providerId, modelId, apiKey: 'sk-test-not-a-real-key' })),
  createProviderManager: hoisted.createProviderManager,
}));

import { z } from 'zod';
import { CostCapExceededError } from '../../../safety/runtime/CostGuard.js';
import { agent } from '../../agent.js';
import { embedText } from '../../embedText.js';
import { generateObject } from '../../generateObject.js';
import { generateText } from '../../generateText.js';
import { SpendBudget, UnpricedModelError } from '../spendBudget.js';
import { resolveModelOption } from '../../model.js';
import type { Mock } from 'vitest';

/** One assistant reply that reports what it cost. */
function reply(text: string, costUSD: number) {
  return {
    modelId: 'gpt-6-luna',
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, costUSD },
    choices: [{ message: { role: 'assistant', content: text }, finishReason: 'stop' }],
  };
}

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a spend budget through the call paths', () => {
  it('refuses the second generateText before the provider is called once the first has spent the budget', async () => {
    hoisted.generateCompletion.mockResolvedValue(reply('ok', 0.0006));
    const budget = new SpendBudget({ maxCostUSD: 0.0006 });
    await generateText({ provider: 'openai', model: 'gpt-6-luna', prompt: 'hello', maxTokens: 100, budget });
    await expect(generateText({ provider: 'openai', model: 'gpt-6-luna', prompt: 'hello', maxTokens: 100, budget })).rejects.toBeInstanceOf(
      CostCapExceededError,
    );
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
    expect(budget.spentUSD()).toBeCloseTo(0.0006, 10);
  });

  it('stops generateObject at the cap without another attempt', async () => {
    hoisted.generateCompletion.mockResolvedValue(reply('not json', 0.0006));
    const budget = new SpendBudget({ maxCostUSD: 0.0006 });
    await expect(
      generateObject({ provider: 'openai', model: 'gpt-6-luna', schema: z.object({ a: z.string() }), prompt: 'give a', maxTokens: 100, maxRetries: 3, budget }),
    ).rejects.toBeInstanceOf(CostCapExceededError);
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it("counts an embedding's tokens at the table's rate and refuses past the cap", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }], model: 'text-embedding-3-small', usage: { prompt_tokens: 1000, total_tokens: 1000 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const budget = new SpendBudget({ maxCostUSD: 0.00002 });
    const first = await embedText({ provider: 'openai', model: 'text-embedding-3-small', input: 'x'.repeat(4000), budget });
    expect(first.usage.costUSD).toBeCloseTo(0.00002, 12);
    await expect(embedText({ provider: 'openai', model: 'text-embedding-3-small', input: 'x', budget })).rejects.toBeInstanceOf(CostCapExceededError);
  });

  it("charges an agent session's own outside costs to its budget", async () => {
    hoisted.generateCompletion.mockResolvedValue(reply('ok', 0.0001));
    const helper = agent({ provider: 'openai', model: 'gpt-6-luna', maxTokens: 100, budget: { maxCostUSD: 0.001 } });
    const session = helper.session('s1');
    await session.send('hello');
    session.recordExternalCost(0.0009, { kind: 'stt' });
    await expect(session.send('again')).rejects.toBeInstanceOf(CostCapExceededError);
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it('refuses a model with no price row before the provider is called', async () => {
    (resolveModelOption as Mock).mockReturnValueOnce({ providerId: 'openai', modelId: 'no-such-model' });
    const budget = new SpendBudget({ maxCostUSD: 1 });
    await expect(generateText({ provider: 'openai', model: 'no-such-model', prompt: 'hello', budget })).rejects.toBeInstanceOf(UnpricedModelError);
    expect(hoisted.generateCompletion).not.toHaveBeenCalled();
  });

  it("lets a guard hook stop a call when hookErrors is 'throw', and only logs it otherwise", async () => {
    hoisted.generateCompletion.mockResolvedValue(reply('ok', 0));
    const stop = async () => {
      throw new Error('stopped by the guard');
    };
    await expect(generateText({ provider: 'openai', model: 'gpt-6-luna', prompt: 'hello', onBeforeGeneration: stop, hookErrors: 'throw' })).rejects.toThrow(
      'stopped by the guard',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(generateText({ provider: 'openai', model: 'gpt-6-luna', prompt: 'hello', onBeforeGeneration: stop })).resolves.toMatchObject({ text: 'ok' });
    warn.mockRestore();
  });
});
