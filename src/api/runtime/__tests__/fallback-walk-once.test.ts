/**
 * @file fallback-walk-once.test.ts
 * generateText's fallback walker tries each leg of the chain exactly once, and
 * an overloaded primary (HTTP 529) walks its chain.
 *
 * Each leg's own call walks the entries after it (that is how a leg's
 * completed tool rounds continue on the next provider). When that walk failed,
 * the outer loop used to try the same entries again: on a full outage leg k ran
 * up to 2^(k-1) times, every attempt on the visible request path. A leg that
 * walked the rest of the chain now throws a chain-walked error and the outer
 * loop stops; a leg that failed without walking on (a non-retryable error)
 * still hands the walk to the next leg. And a 529 was not retryable, so an
 * overloaded primary never reached its fallbacks.
 *
 * Runs the real walker and model resolution; only the provider manager is
 * faked, so the test sees every request each hop made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Behavior = 'ok' | { status: number; message: string };

const hoisted = vi.hoisted(() => {
  const requests: Array<{ providerId: string; modelId: string }> = [];
  const behavior: Record<string, Behavior> = {};
  const createProviderManager = vi.fn(async (resolved: { providerId: string }) => ({
    getProvider: () => ({
      generateCompletion: async (modelId: string) => {
        requests.push({ providerId: resolved.providerId, modelId });
        const b = behavior[resolved.providerId] ?? 'ok';
        if (b !== 'ok') throw Object.assign(new Error(b.message), { httpStatus: b.status });
        return {
          id: `${resolved.providerId}-reply`,
          object: 'chat.completion',
          created: 1,
          modelId,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `from ${resolved.providerId}` },
              finishReason: 'stop',
            },
          ],
        };
      },
    }),
  }));
  return { requests, behavior, createProviderManager };
});

vi.mock('../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../model.js')>()),
  createProviderManager: hoisted.createProviderManager,
}));

import { generateText } from '../../generateText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

const UNAVAILABLE = { status: 503, message: 'HTTP 503: Service Unavailable' } as const;

/** Two pinned legs behind an OpenAI primary. */
const CHAIN = [
  { provider: 'openrouter', model: 'openai/gpt-5.6-sol' },
  { provider: 'gemini', model: 'gemini-3.1-pro-preview' },
];

beforeEach(() => {
  hoisted.requests.length = 0;
  for (const key of Object.keys(hoisted.behavior)) delete hoisted.behavior[key];
  globalLLMProviderHealth.reset();
  vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the generateText fallback walker', () => {
  it('tries each leg once when every provider is down', async () => {
    hoisted.behavior.openai = UNAVAILABLE;
    hoisted.behavior.openrouter = UNAVAILABLE;
    hoisted.behavior.gemini = UNAVAILABLE;

    const onFallback = vi.fn();
    await expect(
      generateText({
        provider: 'openai',
        model: 'gpt-5.6-sol',
        prompt: 'Hello?',
        fallbackProviders: CHAIN,
        onFallback,
      }),
    ).rejects.toThrow();

    expect(hoisted.requests.map((r) => r.providerId)).toEqual(['openai', 'openrouter', 'gemini']);
    // The caller hears about each hop once, the nested one included.
    expect(onFallback.mock.calls.map(([, provider]) => provider)).toEqual(['openrouter', 'gemini']);
  });

  it('moves on to the next leg after a leg fails with a non-retryable error', async () => {
    hoisted.behavior.openai = UNAVAILABLE;
    hoisted.behavior.openrouter = { status: 400, message: 'invalid_request_error: bad parameter' };

    const result = await generateText({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      prompt: 'Hello?',
      fallbackProviders: CHAIN,
    });

    expect(hoisted.requests.map((r) => r.providerId)).toEqual(['openai', 'openrouter', 'gemini']);
    expect(result.text).toBe('from gemini');
    // The failed primary is the first hop, then each leg once.
    expect(result.fallback?.hops).toEqual([
      expect.objectContaining({ provider: 'openai', ok: false }),
      { provider: 'openrouter', model: 'openai/gpt-5.6-sol', ok: false },
      expect.objectContaining({ provider: 'gemini', ok: true }),
    ]);
  });

  it('walks the chain when the primary is overloaded (HTTP 529)', async () => {
    hoisted.behavior.openai = { status: 529, message: 'Overloaded' };

    const result = await generateText({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      prompt: 'Hello?',
      fallbackProviders: CHAIN,
    });

    expect(hoisted.requests.map((r) => r.providerId)).toEqual(['openai', 'openrouter']);
    expect(result.text).toBe('from openrouter');
  });
});
