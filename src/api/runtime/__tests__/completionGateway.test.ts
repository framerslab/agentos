/**
 * @file completionGateway.test.ts
 * The completion gateway resolves a turn's hop before the GMI builds its
 * prompt: router, primary, then the fallback chain, each hop's provider
 * initialised inside the protected attempt, its context window and
 * capabilities read from the initialised manager. It then streams one
 * attempt per hop behind a delivery boundary: a failure before the first
 * content chunk yields nothing and settles `hopFailed`. Only the provider
 * manager and credential lookup are faked; model resolution, the fallback
 * helpers, the retry classifier and the health registry are the real ones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager.js';

const created: Array<{ providerId: string; modelId: string; apiKey?: string; baseUrl?: string }> = [];
const failInit = new Set<string>();
/** A provider resolveProvider serves through another one, as it serves anthropic through openrouter when only OPENROUTER_API_KEY is set. */
const servedBy: Record<string, string> = {};
const windows: Record<string, number> = { openai: 128_000, anthropic: 200_000, openrouter: 64_000 };

vi.mock('../../model.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../model.js')>();
  return {
    ...real,
    resolveProvider: (providerId: string, modelId: string, overrides?: { apiKey?: string; baseUrl?: string }) => {
      if (providerId === 'nokey') throw new Error('No API key for nokey. Set NOKEY_API_KEY or pass apiKey.');
      const served = servedBy[providerId] ?? providerId;
      return { providerId: served, modelId, apiKey: overrides?.apiKey ?? `env-key-${served}`, baseUrl: overrides?.baseUrl };
    },
    createProviderManager: async (resolved: { providerId: string; modelId: string; apiKey?: string; baseUrl?: string }) => {
      created.push({ providerId: resolved.providerId, modelId: resolved.modelId, apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });
      if (resolved.providerId === 'ollama') throw new Error('No API key configured for provider ollama');
      if (failInit.has(resolved.providerId)) {
        throw new real.ProviderInitializationError(resolved.providerId, Object.assign(new Error('invalid key'), { httpStatus: 401 }));
      }
      const info = { modelId: resolved.modelId, providerId: resolved.providerId, contextWindowSize: windows[resolved.providerId], capabilities: ['chat', 'tool_use'] };
      return { getProvider: () => undefined, getModelInfo: async () => info } as unknown as AIModelProviderManager;
    },
  };
});

import { createCompletionGateway, type CompletionResolution } from '../completionGateway.js';

const chain = (...entries: Array<[string, string]>) => entries.map(([provider, model]) => ({ provider, model }));

beforeEach(() => {
  created.length = 0;
  failInit.clear();
  for (const key of Object.keys(servedBy)) delete servedBy[key];
  globalLLMProviderHealth.reset();
});

describe('CompletionGateway.resolve', () => {
  it('resolves the primary with its context window, capabilities, tool format and the route credentials', async () => {
    const gateway = createCompletionGateway();
    const r = await gateway.resolve({ providerId: 'openai', modelId: 'gpt-4o', messages: [], apiKey: 'k1', baseUrl: 'http://stub.local/v1', fallbackProviders: chain(['anthropic', 'claude-x']) });
    expect(r).toMatchObject({ providerId: 'openai', modelId: 'gpt-4o', hop: 0, maxContextTokens: 128_000, toolFormat: 'openai_functions', optionOverrides: {} });
    expect(r?.capabilities).toContain('tool_use');
    expect(created).toEqual([{ providerId: 'openai', modelId: 'gpt-4o', apiKey: 'k1', baseUrl: 'http://stub.local/v1' }]);
  });

  it('moves past a primary that fails to initialise; the next hop uses environment credentials and its overrides', async () => {
    failInit.add('openai');
    const failures: string[] = [];
    const fallbacks: Array<{ from: string; to: string; hop: number }> = [];
    const gateway = createCompletionGateway();
    const r = await gateway.resolve({
      providerId: 'openai', modelId: 'gpt-4o', messages: [], apiKey: 'k1', baseUrl: 'http://stub.local/v1',
      callOptions: { maxTokens: 1000 },
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-x', cache: false, maxTokensHeadroom: 24 }],
      onHopFailure: ({ providerId }) => failures.push(providerId),
      onFallback: ({ from, to, hop }) => fallbacks.push({ from, to, hop }),
    });
    expect(r).toMatchObject({ providerId: 'anthropic', modelId: 'claude-x', hop: 1, maxContextTokens: 200_000, toolFormat: 'anthropic_tools' });
    expect(r?.optionOverrides).toEqual({ maxTokens: 1024, cache: false });
    expect(created[1]).toEqual({ providerId: 'anthropic', modelId: 'claude-x', apiKey: 'env-key-anthropic', baseUrl: undefined });
    expect(failures).toEqual(['openai']);
    expect(fallbacks).toEqual([{ from: 'openai', to: 'anthropic', hop: 1 }]);
  });

  it('returns null when every hop fails, after reporting each failure', async () => {
    failInit.add('openai');
    failInit.add('anthropic');
    const failures: string[] = [];
    const gateway = createCompletionGateway();
    const r = await gateway.resolve({ providerId: 'openai', modelId: 'gpt-4o', messages: [], fallbackProviders: chain(['anthropic', 'claude-x']), onHopFailure: ({ providerId }) => failures.push(providerId) });
    expect(r).toBeNull();
    expect(failures).toEqual(['openai', 'anthropic']);
  });

  it('walks forward from a given hop over the chain fixed by the first resolve', async () => {
    const gateway = createCompletionGateway();
    const route = { providerId: 'openai', modelId: 'gpt-4o', messages: [], fallbackProviders: chain(['anthropic', 'claude-x'], ['openrouter', 'x/y']) };
    const first = await gateway.resolve(route);
    const second = await gateway.resolve(route, first!);
    const third = await gateway.resolve(route, second!);
    expect([first?.hop, second?.hop, third?.hop]).toEqual([0, 1, 2]);
    expect([first?.providerId, second?.providerId, third?.providerId]).toEqual(['openai', 'anthropic', 'openrouter']);
    expect(await gateway.resolve(route, third!)).toBeNull();
  });

  it('skips a hop whose circuit is open without initialising it', async () => {
    for (let i = 0; i < 3; i++) globalLLMProviderHealth.recordFailure('openai', Object.assign(new Error('429'), { httpStatus: 429 }));
    const gateway = createCompletionGateway();
    const r = await gateway.resolve({ providerId: 'openai', modelId: 'gpt-4o', messages: [], fallbackProviders: chain(['anthropic', 'claude-x']) });
    expect(r?.providerId).toBe('anthropic');
    expect(created.map((c) => c.providerId)).toEqual(['anthropic']);
  });

  it('checks the circuit of the provider that serves the hop', async () => {
    servedBy.anthropic = 'openrouter';
    globalLLMProviderHealth.recordFailure('openrouter', Object.assign(new Error('402'), { httpStatus: 402 }));
    const gateway = createCompletionGateway();
    const r = await gateway.resolve({ providerId: 'anthropic', modelId: 'claude-x', messages: [], fallbackProviders: chain(['openai', 'gpt-4o']) });
    expect(r?.providerId).toBe('openai');
    expect(created.map((c) => c.providerId)).toEqual(['openai']);
  });

  it('throws the primary configuration error that is not retryable', async () => {
    const gateway = createCompletionGateway();
    await expect(gateway.resolve({ providerId: 'ollama', modelId: 'llama3', messages: [], fallbackProviders: chain(['anthropic', 'claude-x']) })).rejects.toThrow(/No API key/);
  });

  it('keeps throwing a primary without credentials and never counts that against the provider', async () => {
    const gateway = createCompletionGateway();
    const route = { providerId: 'nokey', modelId: 'some-model', messages: [], fallbackProviders: chain(['anthropic', 'claude-x']) };
    for (let i = 0; i < 6; i++) await expect(gateway.resolve(route)).rejects.toThrow(/No API key for nokey/);
    expect(globalLLMProviderHealth.getStats('nokey')).toBeNull();
    expect(created).toEqual([]);
  });

  it('applies the gateway defaults under the call route', async () => {
    const gateway = createCompletionGateway({ apiKey: 'default-key', fallbackProviders: chain(['anthropic', 'claude-x']) });
    const r = await gateway.resolve({ providerId: 'openai', modelId: 'gpt-4o', messages: [] });
    expect(created[0].apiKey).toBe('default-key');
    expect(r?.chain.map((h) => h.provider)).toEqual(['openai', 'anthropic']);
  });

  it('lets a router pick the primary, with the task hint from the last user message', async () => {
    const selectModel = vi.fn(async (_params: unknown) => ({ modelId: 'claude-routed', modelInfo: { providerId: 'anthropic' } }));
    const gateway = createCompletionGateway({ router: { routerId: 'test', initialize: async () => undefined, selectModel } as never });
    const r = await gateway.resolve({ providerId: 'openai', modelId: 'gpt-4o', messages: [{ role: 'user', content: 'summarise the attached report' }], fallbackProviders: [] });
    expect(r).toMatchObject({ providerId: 'anthropic', modelId: 'claude-routed', hop: 0 });
    expect(selectModel.mock.calls[0][0]).toMatchObject({ taskHint: 'summarise the attached report', optimizationPreference: 'balanced' });
  });
});

function resolutionWith(
  gen: (options: Record<string, unknown>) => AsyncGenerator<Record<string, unknown>>,
  overrides: Partial<CompletionResolution> = {},
): CompletionResolution {
  const provider = { providerId: 'openai', generateCompletionStream: (_m: string, _msgs: unknown, options: Record<string, unknown>) => gen(options) };
  return {
    providerId: 'openai', modelId: 'gpt-4o', hop: 0, maxContextTokens: 128_000, capabilities: ['tool_use'], toolFormat: 'openai_functions',
    optionOverrides: {}, chain: [{ provider: 'openai', model: 'gpt-4o' }],
    providerManager: { getProvider: () => provider } as unknown as AIModelProviderManager,
    ...overrides,
  };
}

async function drain(attempt: AsyncIterable<unknown>): Promise<Array<Record<string, any>>> {
  const seen: Array<Record<string, any>> = [];
  for await (const chunk of attempt) seen.push(chunk as Record<string, any>);
  return seen;
}

const stop = (content: string, usage?: Record<string, number>) => ({ isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content }, finishReason: 'stop' }], ...(usage ? { usage } : {}) });

describe('CompletionGateway.stream', () => {
  it('delivers from the first content chunk on and settles delivered', async () => {
    const gateway = createCompletionGateway();
    const attempt = gateway.stream(resolutionWith(async function* () { yield { responseTextDelta: 'Hi' }; yield stop('Hi', { promptTokens: 1, completionTokens: 1, totalTokens: 2 }); }), [], {});
    expect((await drain(attempt)).length).toBe(2);
    expect(await attempt.outcome).toEqual({ kind: 'delivered' });
  });

  it('a retryable throw before any content yields nothing and settles hopFailed', async () => {
    const gateway = createCompletionGateway();
    const attempt = gateway.stream(resolutionWith(async function* () { throw Object.assign(new Error('overloaded'), { httpStatus: 529 }); }), [], {});
    expect(await drain(attempt)).toEqual([]);
    expect(await attempt.outcome).toMatchObject({ kind: 'hopFailed', retryable: true });
  });

  it('an in-band error chunk before content is a hop failure too', async () => {
    const gateway = createCompletionGateway();
    const attempt = gateway.stream(resolutionWith(async function* () { yield { isFinal: true, choices: [], error: { message: 'rate limited', type: 'rate_limit' } }; }), [], {});
    expect(await drain(attempt)).toEqual([]);
    expect(await attempt.outcome).toMatchObject({ kind: 'hopFailed', retryable: true });
  });

  it('reads a numeric in-band error code as its HTTP status, as streamText does', async () => {
    const gateway = createCompletionGateway();
    const attempt = gateway.stream(resolutionWith(async function* () { yield { isFinal: true, choices: [], error: { message: 'Internal error encountered.', type: 'INTERNAL', code: 500 } }; }), [], {});
    expect(await drain(attempt)).toEqual([]);
    expect(await attempt.outcome).toMatchObject({ kind: 'hopFailed', retryable: true, error: expect.objectContaining({ httpStatus: 500 }) });
  });

  it('a non-retryable failure before content settles hopFailed with retryable false', async () => {
    const gateway = createCompletionGateway();
    const attempt = gateway.stream(resolutionWith(async function* () { throw new Error('400 invalid_request: bad schema'); }), [], {});
    await drain(attempt);
    expect(await attempt.outcome).toMatchObject({ kind: 'hopFailed', retryable: false });
  });

  it('a caller abort before content is not walked and not counted against the provider', async () => {
    const gateway = createCompletionGateway();
    for (let i = 0; i < 6; i++) {
      const attempt = gateway.stream(resolutionWith(async function* () { yield { isFinal: true, choices: [], error: { message: 'Stream aborted by caller', type: 'abort' } }; }), [], {});
      expect(await drain(attempt)).toEqual([]);
      expect(await attempt.outcome).toMatchObject({ kind: 'hopFailed', retryable: false });
    }
    expect(globalLLMProviderHealth.getStats('openai')).toBeNull();
  });

  it('an error after content ends the attempt with one terminal error chunk', async () => {
    const gateway = createCompletionGateway();
    const attempt = gateway.stream(resolutionWith(async function* () { yield { responseTextDelta: 'Partial' }; throw new Error('connection reset'); }), [], {});
    const chunks = await drain(attempt);
    expect(chunks.map((c) => Boolean(c.error))).toEqual([false, true]);
    expect(chunks[1]).toMatchObject({ isFinal: true, error: { message: 'connection reset' } });
    expect(await attempt.outcome).toEqual({ kind: 'delivered' });
  });

  it('an in-band error after content ends the attempt there and counts against the provider', async () => {
    for (let i = 0; i < 2; i++) globalLLMProviderHealth.recordFailure('openai', Object.assign(new Error('429'), { httpStatus: 429 }));
    const attempt = createCompletionGateway().stream(resolutionWith(async function* () {
      yield { responseTextDelta: 'Partial' };
      yield { isFinal: true, choices: [], error: { message: 'rate limited', type: 'rate_limit', code: 429 } };
      yield { responseTextDelta: 'after the end' };
    }), [], {});
    const chunks = await drain(attempt);
    expect(chunks.map((c) => c.responseTextDelta ?? c.error?.message)).toEqual(['Partial', 'rate limited']);
    expect(await attempt.outcome).toEqual({ kind: 'delivered' });
    expect(globalLLMProviderHealth.isOpen('openai')).toBe(true);
  });

  it('a stream with no content chunk flushes everything it buffered', async () => {
    const gateway = createCompletionGateway();
    const attempt = gateway.stream(resolutionWith(async function* () { yield stop(''); yield { isFinal: true, choices: [], usage: { promptTokens: 3, completionTokens: 0, totalTokens: 3 } }; }), [], {});
    expect((await drain(attempt)).length).toBe(2);
    expect(await attempt.outcome).toEqual({ kind: 'delivered' });
  });

  it('merges the hop overrides over the caller options and always streams', async () => {
    let seen: Record<string, unknown> = {};
    const res = resolutionWith(async function* (options) { seen = options; yield { responseTextDelta: 'x' }; }, { optionOverrides: { maxTokens: 400, cache: false } as never });
    await drain(createCompletionGateway().stream(res, [], { temperature: 0.2, maxTokens: 100 }));
    expect(seen).toMatchObject({ temperature: 0.2, maxTokens: 400, cache: false, stream: true });
  });

  it('settles abandoned when the consumer stops reading', async () => {
    const attempt = createCompletionGateway().stream(resolutionWith(async function* () { yield { responseTextDelta: 'a' }; yield { responseTextDelta: 'b' }; }), [], {});
    for await (const _chunk of attempt) break;
    expect(await attempt.outcome).toEqual({ kind: 'abandoned' });
  });

  it('records the hop failure and the hop success on the health registry', async () => {
    const gateway = createCompletionGateway();
    const rateLimited = () => resolutionWith(async function* () { throw Object.assign(new Error('429'), { httpStatus: 429 }); });
    for (let i = 0; i < 2; i++) await drain(gateway.stream(rateLimited(), [], {}));
    await drain(gateway.stream(resolutionWith(async function* () { yield { responseTextDelta: 'ok' }; }), [], {}));
    await drain(gateway.stream(rateLimited(), [], {}));
    expect(globalLLMProviderHealth.isOpen('openai')).toBe(false);
    for (let i = 0; i < 2; i++) await drain(gateway.stream(rateLimited(), [], {}));
    expect(globalLLMProviderHealth.isOpen('openai')).toBe(true);
  });

  // claude-x stands for a Claude model that accepts a forced tool_choice; Sonnet 5.5 and Opus 5.5 do not (next case).
  it('lowers a schema for the hop, suppresses tools, and lifts the forced schema tool call into structuredOutput', async () => {
    let seen: Record<string, unknown> = {};
    const res = resolutionWith(async function* (options) {
      seen = options;
      yield { isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'answer', arguments: '{"city":"Lyon"}' } }] }, finishReason: 'tool_use' }] };
    }, { providerId: 'anthropic', modelId: 'claude-x', toolFormat: 'anthropic_tools' });
    const chunks = await drain(createCompletionGateway().stream(res, [], { tools: [{ type: 'function', function: { name: 'lookup' } }], toolChoice: 'auto' }, z.object({ city: z.string() }), 'answer'));
    expect(seen.tools).toBeUndefined();
    expect(seen.toolChoice).toBeUndefined();
    expect(seen.responseFormat).toMatchObject({ _agentosUseToolForStructuredOutput: true, tool: { name: 'answer' } });
    expect(chunks.at(-1)).toMatchObject({ structuredOutput: { city: 'Lyon' } });
    expect(chunks.at(-1)?.choices[0].message.tool_calls).toBeUndefined();
  });

  it('on a model that refuses a forced tool, the schema rides the prompt only: no response format, no tools, the answer stays text', async () => {
    let seen: Record<string, unknown> = {};
    const res = resolutionWith(async function* (options) {
      seen = options;
      yield { responseTextDelta: '{"city":"Lyon"}' };
      yield stop('{"city":"Lyon"}');
    }, { providerId: 'anthropic', modelId: 'claude-sonnet-5-5', toolFormat: 'anthropic_tools' });
    const chunks = await drain(createCompletionGateway().stream(res, [], { tools: [{ type: 'function', function: { name: 'lookup' } }], toolChoice: 'auto' }, z.object({ city: z.string() }), 'answer'));
    expect(seen.responseFormat).toBeUndefined();
    expect(seen.tools).toBeUndefined();
    expect(seen.toolChoice).toBeUndefined();
    expect(chunks.map((c) => c.responseTextDelta).filter(Boolean)).toEqual(['{"city":"Lyon"}']);
    expect(chunks.some((c) => c.structuredOutput !== undefined)).toBe(false);
  });

  it('a failure before content carries the usage the provider billed', async () => {
    const gateway = createCompletionGateway();
    const attempt = gateway.stream(resolutionWith(async function* () {
      yield { isFinal: true, choices: [], usage: { promptTokens: 40, completionTokens: 0, totalTokens: 40 }, error: { message: 'content filtered', type: 'invalid_request' } };
    }), [], {});
    await drain(attempt);
    expect(await attempt.outcome).toMatchObject({ kind: 'hopFailed', usage: { promptTokens: 40, totalTokens: 40 } });
  });

  // Providers report the request's running total: the latest report is the attempt's bill.
  it("a thrown failure carries its error's usage, else the last usage buffered before it, else none", async () => {
    const gateway = createCompletionGateway();
    const interim = { choices: [{ index: 0, message: { role: 'assistant', content: null }, finishReason: null }], usage: { promptTokens: 12, completionTokens: 2, totalTokens: 14 } };

    const refused = gateway.stream(resolutionWith(async function* () {
      yield interim;
      throw Object.assign(new Error('Claude declined the request'), { code: 'content_filter', details: { usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } } });
    }), [], {});
    expect(await drain(refused)).toEqual([]);
    expect(await refused.outcome).toMatchObject({ kind: 'hopFailed', retryable: true, usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } });

    const reset = gateway.stream(resolutionWith(async function* () { yield interim; throw new Error('socket hang up'); }), [], {});
    await drain(reset);
    expect(await reset.outcome).toMatchObject({ kind: 'hopFailed', usage: { promptTokens: 12, completionTokens: 2, totalTokens: 14 } });

    const unbilled = gateway.stream(resolutionWith(async function* () { throw Object.assign(new Error('overloaded'), { httpStatus: 529 }); }), [], {});
    await drain(unbilled);
    expect(await unbilled.outcome).not.toHaveProperty('usage');
  });
});
