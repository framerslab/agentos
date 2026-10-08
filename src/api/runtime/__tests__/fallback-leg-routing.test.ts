/**
 * @file fallback-leg-routing.test.ts
 * A fallback leg on a gateway stays on the gateway: `{ provider: 'openrouter',
 * model: 'openai/gpt-5.6-sol' }` must reach OpenRouter with that model id, not
 * OpenAI's own API as `gpt-5.6-sol`. The pinned OpenRouter leg of the default
 * fallback chain is written that way, so when OpenAI was the failing primary,
 * the leg retried OpenAI.
 *
 * Runs generateText's fallback walker against the real model resolution
 * (resolveModelOption, resolveProvider); only the provider manager is faked,
 * so the test sees which provider and model each hop asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const requests: Array<{ providerId: string; modelId: string }> = [];
  const createProviderManager = vi.fn(async (resolved: { providerId: string }) => ({
    getProvider: () => ({
      generateCompletion: async (modelId: string) => {
        requests.push({ providerId: resolved.providerId, modelId });
        if (resolved.providerId === 'openai') throw new Error('429 rate limit exceeded');
        return {
          id: 'gateway-reply',
          object: 'chat.completion',
          created: 1,
          modelId,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          choices: [{ index: 0, message: { role: 'assistant', content: 'from the gateway' }, finishReason: 'stop' }],
        };
      },
    }),
  }));
  return { requests, createProviderManager };
});

vi.mock('../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../model.js')>()),
  createProviderManager: hoisted.createProviderManager,
}));

import { generateText } from '../../generateText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

beforeEach(() => {
  hoisted.requests.length = 0;
  globalLLMProviderHealth.reset();
  vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a gateway fallback leg', () => {
  it('reaches the gateway with its vendor-prefixed model id', async () => {
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      prompt: 'Hello?',
      fallbackProviders: [{ provider: 'openrouter', model: 'openai/gpt-5.6-sol' }],
    });

    expect(hoisted.requests).toEqual([
      { providerId: 'openai', modelId: 'gpt-5.6-sol' },
      { providerId: 'openrouter', modelId: 'openai/gpt-5.6-sol' },
    ]);
    expect(result.text).toBe('from the gateway');
    expect(result.provider).toBe('openrouter');
  });
});
