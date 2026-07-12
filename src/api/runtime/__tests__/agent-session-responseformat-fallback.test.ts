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

  it('no-provider agent: the primary payload follows env/model resolution, not an openai default', async () => {
    // The agent sets NO provider/model; resolution (env keys) lands on
    // anthropic. The primary structured-output payload must be shaped for
    // the provider that actually serves the call — an OpenAI json_schema
    // sent to AnthropicProvider is silently ignored (schema unenforced,
    // ObjectGenerationError on prose).
    (resolveModelOption as unknown as Mock).mockImplementation(() => ({
      providerId: 'anthropic',
      modelId: 'claude-opus-4-8',
    }));
    hoisted.generateCompletion.mockImplementation(async (modelId: string) =>
      okResponse(modelId, '{"title":"x"}'),
    );

    const a = agent({ memory: false, fallbackProviders: [] });
    const result = await a.session().send('hi', {
      responseSchema: z.object({ title: z.string() }),
      schemaName: 'titled',
    });

    expect((result as { object?: unknown }).object).toEqual({ title: 'x' });
    const primaryOptions = (hoisted.generateCompletion.mock.calls[0]?.[2] ?? {}) as {
      responseFormat?: Record<string, unknown>;
    };
    expect(primaryOptions.responseFormat?._agentosUseToolForStructuredOutput).toBe(true);
    expect(primaryOptions.responseFormat?.type).toBeUndefined();
  });

  it('Fable primary degrades to the prompt-only JSON path (no forced-tool marker)', async () => {
    hoisted.generateCompletion.mockImplementation(async (modelId: string) =>
      okResponse(modelId, '{"title":"x"}'),
    );

    const a = agent({
      provider: 'anthropic',
      model: 'claude-fable-5',
      memory: false,
      fallbackProviders: [],
    });
    const result = await a.session().send('hi', {
      responseSchema: z.object({ title: z.string() }),
      schemaName: 'titled',
    });

    expect((result as { object?: unknown }).object).toEqual({ title: 'x' });
    const primaryOptions = (hoisted.generateCompletion.mock.calls[0]?.[2] ?? {}) as {
      responseFormat?: unknown;
    };
    // Fable rejects a forced tool_choice at the API level; the primary must
    // run schema-in-prompt only, exactly like generateObject's primary path.
    expect(primaryOptions.responseFormat).toBeUndefined();
  });

  it('record schema on an openai primary degrades to json_object (strict gate)', async () => {
    hoisted.generateCompletion.mockImplementation(async (modelId: string) =>
      okResponse(modelId, '{"palette":{"primary":"#aabbcc"}}'),
    );

    const a = agent({
      provider: 'openai',
      model: 'gpt-4o-mini',
      memory: false,
      fallbackProviders: [],
    });
    const result = await a.session().send('hi', {
      // z.record lowers to a schema-valued additionalProperties -> fails the
      // strict validator; an ungated strict json_schema payload 400s.
      responseSchema: z.object({ palette: z.record(z.string(), z.string()) }),
      schemaName: 'palette',
    });

    expect((result as { object?: unknown }).object).toEqual({
      palette: { primary: '#aabbcc' },
    });
    const primaryOptions = (hoisted.generateCompletion.mock.calls[0]?.[2] ?? {}) as {
      responseFormat?: Record<string, unknown>;
    };
    expect(primaryOptions.responseFormat).toEqual({ type: 'json_object' });
  });
});
