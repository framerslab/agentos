/**
 * @file generateText-responseFormatBuilder.test.ts
 * Per-leg structured-output rebuild: fallback legs rebuild `_responseFormat`
 * via the caller-supplied `_responseFormatBuilder`; absent builder keeps the
 * legacy verbatim carry; a throwing builder overrides with an EXPLICIT
 * `undefined` (the stale primary payload must never leak into the leg
 * through the `...opts` spread). A call a model router moves is rebuilt the
 * same way for the router's pick, and a call the router leaves on its own
 * provider and model keeps the caller's payload.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

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

import { generateText } from '../generateText.js';
import { resolveModelOption, resolveProvider } from '../../model.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import type { IModelRouter } from '../../../core/llm/routing/IModelRouter.js';

const ANTHROPIC_MARKER = {
  _agentosUseToolForStructuredOutput: true,
  tool: { name: 'testSchema', input_schema: { type: 'object' } },
};

function okResponse(modelId: string, text: string) {
  return {
    modelId,
    usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    choices: [{ message: { role: 'assistant', content: text }, finishReason: 'stop' }],
  };
}

describe('generateText fallback legs with _responseFormatBuilder', () => {
  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
    // Echo the requested provider/model through resolution so the anthropic
    // primary and the openai leg each resolve as themselves.
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

  it('rebuilds the payload for the leg provider (not the primary marker)', async () => {
    hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
      if (modelId === 'gpt-4o-mini') return okResponse(modelId, '{"a":1}');
      throw new Error('503 upstream unavailable');
    });
    const builder = vi.fn(() => ({ type: 'json_object' }));

    const result = await generateText({
      provider: 'anthropic',
      model: 'claude-primary',
      prompt: 'p',
      fallbackProviders: [{ provider: 'openai', model: 'gpt-4o-mini' }],
      _responseFormat: ANTHROPIC_MARKER,
      _responseFormatBuilder: builder,
    });

    expect(result.text).toBe('{"a":1}');
    expect(builder).toHaveBeenCalledWith('openai', 'gpt-4o-mini');
    const calls = hoisted.generateCompletion.mock.calls as unknown[][];
    const legOptions = (calls.find((c) => c[0] === 'gpt-4o-mini')?.[2] ?? {}) as {
      responseFormat?: unknown;
    };
    expect(legOptions.responseFormat).toEqual({ type: 'json_object' });
    // The primary hop still carried the caller's payload untouched.
    const primaryOptions = (calls.find((c) => c[0] === 'claude-primary')?.[2] ?? {}) as {
      responseFormat?: unknown;
    };
    expect(primaryOptions.responseFormat).toEqual(ANTHROPIC_MARKER);
  });

  it('without a builder the leg receives the verbatim primary payload (legacy carry)', async () => {
    hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
      if (modelId === 'gpt-4o-mini') return okResponse(modelId, '{"a":1}');
      throw new Error('503 upstream unavailable');
    });

    await generateText({
      provider: 'anthropic',
      model: 'claude-primary',
      prompt: 'p',
      fallbackProviders: [{ provider: 'openai', model: 'gpt-4o-mini' }],
      _responseFormat: ANTHROPIC_MARKER,
    });

    const calls = hoisted.generateCompletion.mock.calls as unknown[][];
    const legOptions = (calls.find((c) => c[0] === 'gpt-4o-mini')?.[2] ?? {}) as {
      responseFormat?: unknown;
    };
    expect(legOptions.responseFormat).toEqual(ANTHROPIC_MARKER);
  });

  it('builder throwing -> leg runs with NO responseFormat (stale payload must not leak)', async () => {
    hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
      if (modelId === 'gpt-4o-mini') return okResponse(modelId, '{"a":1}');
      throw new Error('503 upstream unavailable');
    });

    const result = await generateText({
      provider: 'anthropic',
      model: 'claude-primary',
      prompt: 'p',
      fallbackProviders: [{ provider: 'openai', model: 'gpt-4o-mini' }],
      _responseFormat: ANTHROPIC_MARKER,
      _responseFormatBuilder: () => {
        throw new Error('builder bug');
      },
    });

    expect(result.text).toBe('{"a":1}');
    const calls = hoisted.generateCompletion.mock.calls as unknown[][];
    const legOptions = (calls.find((c) => c[0] === 'gpt-4o-mini')?.[2] ?? {}) as {
      responseFormat?: unknown;
    };
    expect(legOptions.responseFormat).toBeUndefined();
  });

  it('entry without a model calls the builder with an empty-string modelId', async () => {
    hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
      if (modelId === 'claude-primary') throw new Error('503 upstream unavailable');
      return okResponse(String(modelId), 'x');
    });
    const builder = vi.fn(() => undefined);

    await generateText({
      provider: 'anthropic',
      model: 'claude-primary',
      prompt: 'p',
      fallbackProviders: [{ provider: 'openai' }],
      _responseFormatBuilder: builder,
    });

    expect(builder).toHaveBeenCalledWith('openai', '');
  });
});

describe('generateText calls a model router picks for, with _responseFormatBuilder', () => {
  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
    (resolveModelOption as unknown as Mock).mockImplementation(
      (opts: { provider?: string; model?: string }) => ({
        providerId: opts?.provider ?? 'openai',
        modelId: opts?.model ?? 'gpt-4.1-mini',
      }),
    );
    (resolveProvider as unknown as Mock).mockImplementation(
      (providerId: string, modelId: string) => ({ providerId, modelId, apiKey: 'test-key' }),
    );
    globalLLMProviderHealth.reset();
    hoisted.generateCompletion.mockImplementation(async (modelId: string) => okResponse(modelId, '{"a":1}'));
  });

  /** A model router that sends every call to `modelId` on `providerId`. */
  const routerTo = (providerId: string, modelId: string): IModelRouter =>
    ({
      routerId: `to-${providerId}`,
      initialize: async () => undefined,
      selectModel: async () => ({ modelId, modelInfo: { providerId } }),
    }) as unknown as IModelRouter;

  /** The system messages' text of the one provider call. */
  const systemText = (): string =>
    ((hoisted.generateCompletion.mock.calls[0]?.[1] ?? []) as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === 'system')
      .map((m) => String(m.content))
      .join('\n');

  it("a router that picks the call's own provider and model leaves the caller's payload as it is", async () => {
    const builder = vi.fn(() => ({ type: 'json_object' }));

    await generateText({
      provider: 'anthropic',
      model: 'claude-primary',
      prompt: 'p',
      router: routerTo('anthropic', 'claude-primary'),
      fallbackProviders: [],
      _responseFormat: ANTHROPIC_MARKER,
      _responseFormatBuilder: builder,
    });

    expect(builder).not.toHaveBeenCalled();
    const options = (hoisted.generateCompletion.mock.calls[0]?.[2] ?? {}) as { responseFormat?: unknown };
    expect(options.responseFormat).toBe(ANTHROPIC_MARKER);
  });

  it('a routed call whose builder throws runs with no payload and the schema instructions in its system prompt', async () => {
    await generateText({
      provider: 'anthropic',
      model: 'claude-primary',
      prompt: 'p',
      router: routerTo('openrouter', 'vendor/routed-model'),
      fallbackProviders: [],
      // The primary's marker carries the schema, so it alone would keep the
      // instructions out of the prompt.
      _responseFormat: ANTHROPIC_MARKER,
      _responseFormatBuilder: () => {
        throw new Error('builder bug');
      },
      _schemaInstruction: 'Answer in the routed schema.',
    });

    const [modelId, , options] = hoisted.generateCompletion.mock.calls[0] as [string, unknown, { responseFormat?: unknown }];
    expect(modelId).toBe('vendor/routed-model');
    expect(options.responseFormat).toBeUndefined();
    expect(systemText()).toContain('Answer in the routed schema.');
  });
});
