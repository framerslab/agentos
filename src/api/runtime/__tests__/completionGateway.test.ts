/**
 * @file completionGateway.test.ts
 * The completion gateway resolves a turn's hop before the GMI builds its
 * prompt: router, primary, then the fallback chain, each hop's provider
 * initialised inside the protected attempt, its context window and
 * capabilities read from the initialised manager. Only the provider manager
 * and credential lookup are faked; model resolution and the fallback helpers
 * are the real ones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { createCompletionGateway } from '../completionGateway.js';

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
