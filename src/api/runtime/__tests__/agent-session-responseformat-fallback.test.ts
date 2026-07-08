/**
 * @file agent-session-responseformat-fallback.test.ts
 * AgentSession.send({responseSchema}) must rebuild the structured-output
 * payload per fallback leg (the second first-party structured-output caller
 * after generateObject) — a foreign leg must not inherit the primary's
 * provider-shaped payload verbatim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { z } from 'zod';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return {
    generateCompletion,
    getProvider,
    createProviderManager,
  };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4.1-mini' })),
  resolveProvider: vi.fn(() => ({
    providerId: 'openai',
    modelId: 'gpt-4.1-mini',
    apiKey: 'test-key',
  })),
  createProviderManager: hoisted.createProviderManager,
}));

import { agent } from '../../agent.js';
import { resolveModelOption, resolveProvider } from '../../model.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

function okResponse(modelId: string, text: string) {
  return {
    modelId,
    usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    choices: [{ message: { role: 'assistant', content: text }, finishReason: 'stop' }],
  };
}

describe('AgentSession.send responseSchema fallback rebuild (2026-07-07)', () => {
  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
    (resolveModelOption as unknown as Mock).mockImplementation(
      (opts: { provider?: string; model?: string }) => ({
        providerId: opts?.provider ?? 'openai',
        modelId: opts?.model ?? 'gpt-4.1-mini',
      }),
    );
    (resolveProvider as unknown as Mock).mockImplementation(
      (providerId: string, modelId: string) => ({
        providerId,
        modelId: modelId || 'default-model',
        apiKey: 'test-key',
      }),
    );
    globalLLMProviderHealth.reset();
  });

  it('anthropic primary down -> openai leg receives an OpenAI-shaped responseFormat', async () => {
    hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
      if (modelId === 'gpt-4o-mini') return okResponse(modelId, '{"title":"x"}');
      throw new Error('503 overloaded');
    });

    const a = agent({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      memory: false,
      fallbackProviders: [{ provider: 'openai', model: 'gpt-4o-mini' }],
    });
    const session = a.session();
    const result = await session.send('hi', {
      responseSchema: z.object({ title: z.string() }),
      schemaName: 'titled',
    });

    expect((result as { object?: unknown }).object).toEqual({ title: 'x' });
    const calls = hoisted.generateCompletion.mock.calls as unknown[][];
    // Primary call carried the anthropic forced-tool marker…
    const primaryOptions = (calls.find((c) => c[0] === 'claude-opus-4-8')?.[2] ?? {}) as {
      responseFormat?: Record<string, unknown>;
    };
    expect(primaryOptions.responseFormat?._agentosUseToolForStructuredOutput).toBe(true);
    // …and the openai LEG was rebuilt to the OpenAI shape: a plain object
    // schema passes the strict gate -> json_schema, NOT the anthropic marker.
    const legOptions = (calls.find((c) => c[0] === 'gpt-4o-mini')?.[2] ?? {}) as {
      responseFormat?: Record<string, unknown>;
    };
    expect(legOptions.responseFormat?.type).toBe('json_schema');
    expect(legOptions.responseFormat?._agentosUseToolForStructuredOutput).toBeUndefined();
  });
});
