/**
 * @file agent-session-responseformat-fallback.test.ts
 * AgentSession.send({responseSchema}) must rebuild the structured-output
 * payload per fallback leg (the second first-party structured-output caller
 * after generateObject) — a foreign leg must not inherit the primary's
 * provider-shaped payload verbatim. The same holds for a send the agent's
 * model router moves to another provider or model: it is sent the payload of
 * the router's pick, and the schema in its system prompt when that payload
 * carries none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { IModelRouter } from '../../../core/llm/routing/IModelRouter.js';

/** The system prompt a provider call sent: the text of its system messages. */
function systemOf(call: unknown[] | undefined): string {
  const messages = (call?.[1] ?? []) as Array<{ role: string; content: unknown }>;
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

/** The line generateObject's schema instructions carry, which session.send repeats when nothing else carries the schema. */
const SCHEMA_LINE = 'The JSON MUST conform to this JSON Schema:';

function okResponse(modelId: string, text: string) {
  return {
    modelId,
    usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    choices: [{ message: { role: 'assistant', content: text }, finishReason: 'stop' }],
  };
}

/** Resolution echoes the provider and model it is given, so each call is sent as itself. */
function resetHarness(): void {
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
}

/** A model router that sends every call to `modelId` on `providerId`. */
function routerTo(providerId: string, modelId: string): IModelRouter {
  return {
    routerId: `to-${providerId}`,
    initialize: async () => undefined,
    selectModel: async () => ({ modelId, modelInfo: { providerId } }),
  } as unknown as IModelRouter;
}

/** The structured-output payload a provider call carried. */
function payloadOf(call: unknown[] | undefined): unknown {
  return (call?.[2] as { responseFormat?: unknown } | undefined)?.responseFormat;
}

describe('AgentSession.send responseSchema fallback rebuild (2026-07-07)', () => {
  beforeEach(resetHarness);

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

  it('Fable primary sends the JSON output format marker (route json_schema) and no schema text', async () => {
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
    // Fable has the JSON output format: the marker carries the schema with
    // route json_schema, so the system prompt does not repeat it.
    expect(primaryOptions.responseFormat).toMatchObject({ _agentosUseToolForStructuredOutput: true, route: 'json_schema' });
    const system = systemOf(hoisted.generateCompletion.mock.calls[0] as unknown[]);
    expect(system).not.toContain(SCHEMA_LINE);
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
    // JSON mode carries no schema, so the system prompt does.
    const system = systemOf(hoisted.generateCompletion.mock.calls[0] as unknown[]);
    expect(system).toContain(SCHEMA_LINE);
    expect(system).toContain('"palette"');
  });

  it('each leg decides for its own payload: a strict primary and a Claude Sonnet 5.5 leg (the JSON output format) each carry the schema, so neither gets schema text', async () => {
    hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
      if (modelId === 'claude-sonnet-5-5') return okResponse(modelId, '{"title":"x"}');
      throw new Error('503 overloaded');
    });

    const a = agent({
      provider: 'openai',
      model: 'gpt-4o-mini',
      memory: false,
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }],
    });
    const result = await a.session().send('hi', {
      responseSchema: z.object({ title: z.string() }),
      schemaName: 'titled',
    });

    expect((result as { object?: unknown }).object).toEqual({ title: 'x' });
    const calls = hoisted.generateCompletion.mock.calls as unknown[][];
    const primary = calls.find((c) => c[0] === 'gpt-4o-mini');
    const leg = calls.find((c) => c[0] === 'claude-sonnet-5-5');
    expect((primary?.[2] as { responseFormat?: { type?: string } } | undefined)?.responseFormat?.type).toBe('json_schema');
    expect(systemOf(primary)).not.toContain(SCHEMA_LINE);
    expect(leg).toBeDefined();
    expect((leg?.[2] as { responseFormat?: unknown } | undefined)?.responseFormat).toMatchObject({
      _agentosUseToolForStructuredOutput: true,
      route: 'json_schema',
    });
    expect(systemOf(leg)).not.toContain(SCHEMA_LINE);
  });
});

describe('AgentSession.send responseSchema when the model router moves the send', () => {
  beforeEach(resetHarness);

  let warnSpy: { mockRestore(): void } | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    warnSpy?.mockRestore();
    warnSpy = undefined;
  });

  /**
   * The real resolver, with no Anthropic key or base URL and an OpenRouter
   * key in the environment: it sends an Anthropic call to OpenRouter's
   * Anthropic slug.
   */
  async function resolveWithoutAnthropicKey(): Promise<void> {
    const actual = await vi.importActual<typeof import('../../model.js')>('../../model.js');
    (resolveProvider as unknown as Mock).mockImplementation(actual.resolveProvider);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    // The resolver's notice that the call goes to OpenRouter.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  }

  it('a send moved to a provider whose route is the prompt is sent no payload and the schema in its system prompt', async () => {
    hoisted.generateCompletion.mockImplementation(async (modelId: string) =>
      okResponse(modelId, '{"title":"x"}'),
    );

    // The agent's own provider takes a strict json_schema payload, which
    // carries the schema; the router's pick has no structured-output payload.
    const a = agent({
      provider: 'openai',
      model: 'gpt-4o-mini',
      router: routerTo('groq', 'llama-3.3-70b-versatile'),
      memory: false,
      fallbackProviders: [],
    });
    const result = await a.session().send('hi', {
      responseSchema: z.object({ title: z.string() }),
      schemaName: 'titled',
    });

    expect((result as { object?: unknown }).object).toEqual({ title: 'x' });
    const call = hoisted.generateCompletion.mock.calls[0] as unknown[];
    expect(call[0]).toBe('llama-3.3-70b-versatile');
    expect(payloadOf(call)).toBeUndefined();
    expect(systemOf(call)).toContain(SCHEMA_LINE);
    expect(systemOf(call)).toContain('"title"');
  });

  it('a send moved to an Anthropic model that resolves to OpenRouter (no Anthropic key) is sent OpenRouter\'s payload', async () => {
    await resolveWithoutAnthropicKey();
    hoisted.generateCompletion.mockImplementation(async (modelId: string) =>
      okResponse(modelId, '{"title":"x"}'),
    );

    const a = agent({
      provider: 'openai',
      model: 'gpt-4o-mini',
      router: routerTo('anthropic', 'claude-sonnet-4-6'),
      memory: false,
      fallbackProviders: [],
    });
    const result = await a.session().send('hi', {
      responseSchema: z.object({ title: z.string() }),
      schemaName: 'titled',
    });

    expect((result as { object?: unknown }).object).toEqual({ title: 'x' });
    const call = hoisted.generateCompletion.mock.calls[0] as unknown[];
    expect(call[0]).toBe('anthropic/claude-sonnet-4-6');
    // OpenRouter forwards a json_schema payload; an Anthropic marker would be
    // dropped while still keeping the schema out of the prompt.
    expect(payloadOf(call)).toMatchObject({ type: 'json_schema', json_schema: { name: 'titled', strict: true } });
    expect((payloadOf(call) as Record<string, unknown>)._agentosUseToolForStructuredOutput).toBeUndefined();
    expect(systemOf(call)).not.toContain(SCHEMA_LINE);
  });

  it("an Anthropic agent's send with no Anthropic key goes to OpenRouter with OpenRouter's payload, with or without a router that keeps it", async () => {
    await resolveWithoutAnthropicKey();
    hoisted.generateCompletion.mockImplementation(async (modelId: string) =>
      okResponse(modelId, '{"title":"x"}'),
    );

    for (const router of [undefined, routerTo('anthropic', 'claude-opus-4-8')]) {
      const a = agent({
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        ...(router ? { router } : {}),
        memory: false,
        fallbackProviders: [],
      });
      const result = await a.session().send('hi', {
        responseSchema: z.object({ title: z.string() }),
        schemaName: 'titled',
      });
      expect((result as { object?: unknown }).object).toEqual({ title: 'x' });
    }

    const calls = hoisted.generateCompletion.mock.calls as unknown[][];
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[0]).toBe('anthropic/claude-opus-4-8');
      expect(payloadOf(call)).toMatchObject({ type: 'json_schema', json_schema: { name: 'titled', strict: true } });
      expect((payloadOf(call) as Record<string, unknown>)._agentosUseToolForStructuredOutput).toBeUndefined();
      expect(systemOf(call)).not.toContain(SCHEMA_LINE);
    }
  });

  it("a send the router leaves on the agent's own provider and model is sent as it is without a router", async () => {
    hoisted.generateCompletion.mockImplementation(async (modelId: string) =>
      okResponse(modelId, '{"title":"x"}'),
    );
    const send = async (router?: IModelRouter): Promise<void> => {
      const a = agent({
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        ...(router ? { router } : {}),
        memory: false,
        fallbackProviders: [],
      });
      await a.session().send('hi', {
        responseSchema: z.object({ title: z.string() }),
        schemaName: 'titled',
      });
    };

    await send();
    await send(routerTo('anthropic', 'claude-opus-4-8'));

    const [unrouted, routed] = hoisted.generateCompletion.mock.calls as unknown[][];
    expect(routed[0]).toBe('claude-opus-4-8');
    expect(payloadOf(routed)).toMatchObject({ _agentosUseToolForStructuredOutput: true });
    expect(payloadOf(routed)).toEqual(payloadOf(unrouted));
    expect(systemOf(routed)).toBe(systemOf(unrouted));
  });

  it("a routed send whose pick fails falls back with the leg's own payload", async () => {
    hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
      if (modelId === 'claude-sonnet-5-5') return okResponse(modelId, '{"title":"x"}');
      throw new Error('503 overloaded');
    });

    const a = agent({
      provider: 'openai',
      model: 'gpt-4o-mini',
      router: routerTo('groq', 'llama-3.3-70b-versatile'),
      memory: false,
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }],
    });
    const result = await a.session().send('hi', {
      responseSchema: z.object({ title: z.string() }),
      schemaName: 'titled',
    });

    expect((result as { object?: unknown }).object).toEqual({ title: 'x' });
    const calls = hoisted.generateCompletion.mock.calls as unknown[][];
    const routed = calls.find((c) => c[0] === 'llama-3.3-70b-versatile');
    const leg = calls.find((c) => c[0] === 'claude-sonnet-5-5');
    expect(routed).toBeDefined();
    expect(payloadOf(routed)).toBeUndefined();
    expect(systemOf(routed)).toContain(SCHEMA_LINE);
    // The leg is built for its own provider and model, as it is without a router.
    expect(leg).toBeDefined();
    expect(payloadOf(leg)).toMatchObject({ _agentosUseToolForStructuredOutput: true, route: 'json_schema' });
    expect(systemOf(leg)).not.toContain(SCHEMA_LINE);
  });
});
