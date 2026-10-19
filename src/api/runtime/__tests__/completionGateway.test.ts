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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager.js';
import { MATURE_TEXT_RANKING } from '../../../core/llm/routing/UncensoredModelCatalog.js';
import { buildFallbackChain } from '../../generateText.js';
import { PROVIDER_DEFAULTS } from '../provider-defaults.js';

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

import { createCompletionGateway, type CompletionResolution, type LateAttemptUsage } from '../completionGateway.js';

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

  it("keeps the defaults' credentials with the provider the defaults name; a turn that names another takes only its own", async () => {
    const gateway = createCompletionGateway({ providerId: 'openai', modelId: 'gpt-4o', apiKey: 'sk-openai-default', baseUrl: 'http://openai.local/v1', fallbackProviders: [] });

    await gateway.resolve({ providerId: 'anthropic', modelId: 'claude-x', messages: [] });
    await gateway.resolve({ providerId: 'openai', modelId: 'gpt-4.1', messages: [] });
    await gateway.resolve({ providerId: 'anthropic', modelId: 'claude-x', messages: [], apiKey: 'sk-ant-turn' });

    expect(created).toEqual([
      { providerId: 'anthropic', modelId: 'claude-x', apiKey: 'env-key-anthropic', baseUrl: undefined },
      { providerId: 'openai', modelId: 'gpt-4.1', apiKey: 'sk-openai-default', baseUrl: 'http://openai.local/v1' },
      { providerId: 'anthropic', modelId: 'claude-x', apiKey: 'sk-ant-turn', baseUrl: undefined },
    ]);
  });

  it("runs a turn whose model's prefix names another provider than the defaults' there, on its own key or that provider's", async () => {
    const gateway = createCompletionGateway({ providerId: 'openai', apiKey: 'sk-openai-default', fallbackProviders: [] });

    await gateway.resolve({ modelId: 'anthropic:claude-x', messages: [], apiKey: 'sk-ant-turn' });
    await gateway.resolve({ modelId: 'anthropic:claude-x', messages: [] });

    expect(created).toEqual([
      { providerId: 'anthropic', modelId: 'claude-x', apiKey: 'sk-ant-turn', baseUrl: undefined },
      { providerId: 'anthropic', modelId: 'claude-x', apiKey: 'env-key-anthropic', baseUrl: undefined },
    ]);
  });

  it('lets a router pick the primary, with the task hint from the last user message', async () => {
    const selectModel = vi.fn(async (_params: unknown) => ({ modelId: 'claude-routed', modelInfo: { providerId: 'anthropic' } }));
    const gateway = createCompletionGateway({ router: { routerId: 'test', initialize: async () => undefined, selectModel } as never });
    const r = await gateway.resolve({ providerId: 'openai', modelId: 'gpt-4o', messages: [{ role: 'user', content: 'summarise the attached report' }], fallbackProviders: [] });
    expect(r).toMatchObject({ providerId: 'anthropic', modelId: 'claude-routed', hop: 0 });
    expect(selectModel.mock.calls[0][0]).toMatchObject({ taskHint: 'summarise the attached report', optimizationPreference: 'balanced' });
  });

  it("serves a primary a router moved to another provider on that provider's own key, not the route's", async () => {
    const selectModel = vi.fn(async () => ({ modelId: 'claude-routed', modelInfo: { providerId: 'anthropic' } }));
    const gateway = createCompletionGateway({ router: { routerId: 'test', initialize: async () => undefined, selectModel } as never });

    await gateway.resolve({ providerId: 'openai', modelId: 'gpt-4o', messages: [], apiKey: 'sk-openai-tenant', fallbackProviders: [] });

    expect(created).toEqual([{ providerId: 'anthropic', modelId: 'claude-routed', apiKey: 'env-key-anthropic', baseUrl: undefined }]);
  });

  it('refuses route credentials whose model prefix names another provider than the route', async () => {
    const gateway = createCompletionGateway();

    await expect(
      gateway.resolve({ providerId: 'openai', modelId: 'anthropic:claude-x', messages: [], apiKey: 'sk-openai-tenant', fallbackProviders: [] }),
    ).rejects.toThrow("names provider 'anthropic', not 'openai'");
    expect(created).toEqual([]);
  });
});

// The hop list is resolved once, as generateText's and streamText's walks
// resolve theirs, and walked with the same state: refills only while a
// standing leg is owed one, the policy chain's Claude legs passed over after a
// refusal. The ladder is the real catalog's; llama-3.1-8b is never a leg.
describe('CompletionGateway.resolve: the walk', () => {
  const LADDER = MATURE_TEXT_RANKING.filter((model) => model !== 'meta-llama/llama-3.1-8b-instruct');
  // The walk's rule: the uncensored group's first two entries stand, the rest are refills.
  const STANDING = LADDER.slice(0, 2);
  const REFILLS = LADDER.slice(2);
  const isClaude = (provider: string, model?: string) => provider === 'anthropic' || (provider === 'openrouter' && (model ?? '').startsWith('anthropic/'));

  beforeEach(() => {
    // Only the keys a case names: the policy chain's availability suffix follows the environment.
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY']) vi.stubEnv(k, '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Every hop the walk resolves when each one fails with `failure`, and every entry it passes over. */
  async function walkAll(
    route: Parameters<ReturnType<typeof createCompletionGateway>['resolve']>[0],
    failure: Error,
    defaults: Parameters<typeof createCompletionGateway>[0] = {},
  ) {
    const skipped: string[] = [];
    const gateway = createCompletionGateway(defaults);
    const withSkips = { ...route, onHopSkipped: ({ model, reason }: { model?: string; reason: string }) => skipped.push(`${model}:${reason}`) };
    const served: string[] = [];
    let r = await gateway.resolve(withSkips);
    while (r) {
      served.push(r.modelId);
      r = await gateway.resolve(withSkips, r, failure);
    }
    return { served, skipped };
  }

  it('never sends a model the route excludes, as written or as the leg resolves it (#139)', async () => {
    failInit.add('anthropic');
    const skipped: Array<[string, string | undefined, string]> = [];
    const gateway = createCompletionGateway({ routerParams: { excludedModelIds: [PROVIDER_DEFAULTS.openai!.text!, 'openrouter:x/excluded'] } });
    const r = await gateway.resolve({
      providerId: 'anthropic',
      modelId: 'claude-x',
      messages: [],
      fallbackProviders: [{ provider: 'openai' }, { provider: 'openrouter', model: 'openrouter:x/excluded' }, { provider: 'openrouter', model: 'x/allowed' }],
      onHopSkipped: ({ provider, model, reason }) => skipped.push([provider, model, reason]),
    });
    expect(r).toMatchObject({ providerId: 'openrouter', modelId: 'x/allowed', hop: 1 });
    expect(r?.chain.map((h) => h.model)).toEqual(['claude-x', 'x/allowed']);
    expect(skipped).toEqual([
      ['openai', undefined, 'excluded_model'],
      ['openrouter', 'openrouter:x/excluded', 'excluded_model'],
    ]);
    expect(created.map((c) => `${c.providerId}/${c.modelId}`)).toEqual(['anthropic/claude-x', 'openrouter/x/allowed']);
  });

  it("drops the policy chain's entry for the first model, and reports it only when a walk starts", async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-key');
    expect(LADDER.length).toBeGreaterThanOrEqual(3);
    const skipped: string[] = [];
    const gateway = createCompletionGateway({ policyTier: 'mature' });
    const route = {
      providerId: 'openrouter',
      modelId: LADDER[0],
      messages: [],
      onHopSkipped: ({ model, reason }: { model?: string; reason: string }) => skipped.push(`${model}:${reason}`),
    };
    const r = await gateway.resolve(route);
    const roles = r?.chain.map((h) => `${h.model}${h.entry?.walkRole ? `(${h.entry.walkRole})` : ''}`);
    expect(roles?.slice(0, LADDER.length)).toEqual([
      LADDER[0],
      `${LADDER[1]}(standing)`,
      `${LADDER[2]}(standing)`,
      ...LADDER.slice(3).map((model) => `${model}(refill)`),
    ]);
    expect(r?.chain.filter((h) => h.model === LADDER[0])).toHaveLength(1);
    // A turn the first model answers walks nothing and reports nothing.
    expect(skipped).toEqual([]);
    const next = await gateway.resolve(route, r!, Object.assign(new Error('[503] overloaded'), { httpStatus: 503 }));
    expect(next?.modelId).toBe(LADDER[1]);
    expect(skipped).toEqual([`${LADDER[0]}:failed_primary`]);
  });

  it('builds the ladder for a tier set on the host policy, as the walkers read it', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-key');
    const gateway = createCompletionGateway({ hostPolicy: { policyTier: 'mature' } });
    const r = await gateway.resolve({ providerId: 'openai', modelId: 'gpt-4o', messages: [] });
    expect(r?.chain.slice(1, 1 + LADDER.length).map((h) => h.model)).toEqual(LADDER);
  });

  it('onFallback receives the error the previous hop failed with', async () => {
    const seen: Array<[string, string]> = [];
    const gateway = createCompletionGateway({ fallbackProviders: chain(['anthropic', 'claude-x']) });
    const route = { providerId: 'openai', modelId: 'gpt-4o', messages: [], onFallback: ({ to, error }: { to: string; error: Error }) => seen.push([to, error.message]) };
    const first = await gateway.resolve(route);
    await gateway.resolve(route, first!, new Error('[503] the first model is overloaded'));
    expect(seen).toEqual([['anthropic', '[503] the first model is overloaded']]);
  });

  it('onFallback receives the most recent error: a hop that could not start on the way', async () => {
    failInit.add('anthropic');
    const seen: Array<[string, string]> = [];
    const gateway = createCompletionGateway({ fallbackProviders: chain(['anthropic', 'claude-x'], ['openrouter', 'x/y']) });
    const route = { providerId: 'openai', modelId: 'gpt-4o', messages: [], onFallback: ({ to, error }: { to: string; error: Error }) => seen.push([to, error.message]) };
    const first = await gateway.resolve(route);
    await gateway.resolve(route, first!, new Error('[503] the first model is overloaded'));
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe('openrouter');
    expect(seen[0][1]).toContain('invalid key');
  });

  it("after refusals, a refill and the policy chain's Claude legs are passed over; after outages every leg runs", async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'an-key');
    const suffix = buildFallbackChain('openai');
    expect(suffix.some((e) => isClaude(e.provider, e.model))).toBe(true);
    const route = { providerId: 'openai', modelId: 'gpt-4o', messages: [] };
    const mature = { policyTier: 'mature' as const };

    const refused = await walkAll(route, Object.assign(new Error('The model declined.'), { code: 'content_filter' }), mature);
    expect(refused.served).toEqual(['gpt-4o', ...STANDING, ...suffix.filter((e) => !isClaude(e.provider, e.model)).map((e) => e.model)]);
    expect(refused.skipped).toEqual([
      ...REFILLS.map((model) => `${model}:refill_not_owed`),
      ...suffix.filter((e) => isClaude(e.provider, e.model)).map((e) => `${e.model}:claude_after_refusal`),
    ]);

    // Each standing leg's outage owes one refill: two in all.
    const outages = await walkAll(route, Object.assign(new Error('[503] overloaded'), { httpStatus: 503 }), mature);
    expect(outages.served).toEqual(['gpt-4o', ...STANDING, ...REFILLS.slice(0, 2), ...suffix.map((e) => e.model)]);
    expect(outages.skipped).toEqual(REFILLS.slice(2).map((model) => `${model}:refill_not_owed`));
  });

  it('a standing leg that cannot start is owed a refill; a standing leg that refuses is not', async () => {
    // A rejected key opens OpenRouter's circuit at once: leg a cannot start.
    globalLLMProviderHealth.recordFailure('openrouter', Object.assign(new Error('invalid key'), { httpStatus: 401 }));
    const leg = (provider: string, model: string) => ({ provider, model, origin: 'policy-default' as const, group: 'uncensored' as const });
    const { served, skipped } = await walkAll(
      {
        providerId: 'gemini',
        modelId: 'g-primary',
        messages: [],
        fallbackProviders: [leg('openrouter', 'a'), leg('openai', 'b'), leg('openai', 'c'), leg('openai', 'd')],
      },
      Object.assign(new Error('The model declined.'), { code: 'content_filter' }),
    );
    // a and b stand, c and d are refills. a could not start: one refill owed.
    // b refused: none owed. c takes the one owed; d is not owed.
    expect(served).toEqual(['g-primary', 'b', 'c']);
    expect(skipped).toEqual(['d:refill_not_owed']);
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

  it('on Claude Sonnet 5.5 the marker takes the JSON output format: no tools, and the JSON text answer is lifted into structuredOutput', async () => {
    let seen: Record<string, unknown> = {};
    const res = resolutionWith(async function* (options) {
      seen = options;
      yield { responseTextDelta: '{"city":"Lyon"}' };
      yield stop('{"city":"Lyon"}');
    }, { providerId: 'anthropic', modelId: 'claude-sonnet-5-5', toolFormat: 'anthropic_tools' });
    const chunks = await drain(createCompletionGateway().stream(res, [], { tools: [{ type: 'function', function: { name: 'lookup' } }], toolChoice: 'auto' }, z.object({ city: z.string() }), 'answer'));
    expect(seen.responseFormat).toMatchObject({ _agentosUseToolForStructuredOutput: true, route: 'json_schema', tool: { name: 'answer' } });
    expect(seen.tools).toBeUndefined();
    expect(seen.toolChoice).toBeUndefined();
    // The text still streams; the final chunk carries the parsed answer, as the forced tool's lift does.
    expect(chunks.map((c) => c.responseTextDelta).filter(Boolean)).toEqual(['{"city":"Lyon"}']);
    expect(chunks.at(-1)).toMatchObject({ structuredOutput: { city: 'Lyon' } });
  });

  it('on Claude Sonnet 5.5 a record schema (outside the JSON output format) rides the prompt only: no response format, no tools, the answer stays text', async () => {
    let seen: Record<string, unknown> = {};
    const res = resolutionWith(async function* (options) {
      seen = options;
      yield { responseTextDelta: '{"city":"Lyon","scores":{"a":1}}' };
      yield stop('{"city":"Lyon","scores":{"a":1}}');
    }, { providerId: 'anthropic', modelId: 'claude-sonnet-5-5', toolFormat: 'anthropic_tools' });
    const chunks = await drain(createCompletionGateway().stream(res, [], { tools: [{ type: 'function', function: { name: 'lookup' } }], toolChoice: 'auto' }, z.object({ city: z.string(), scores: z.record(z.string(), z.number()) }), 'answer'));
    expect(seen.responseFormat).toBeUndefined();
    expect(seen.tools).toBeUndefined();
    expect(seen.toolChoice).toBeUndefined();
    expect(chunks.map((c) => c.responseTextDelta).filter(Boolean)).toEqual(['{"city":"Lyon","scores":{"a":1}}']);
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

  // A late report is the request's running total too: only what the attempt had not reported is new.
  it("usage a provider reports after the caller's abort reaches onLateUsage as the part the attempt had not reported, and is logged without a listener", async () => {
    /** A provider that reads the signal when its next event arrives: content reporting 12 tokens, then, once `opened`, its abort chunk reporting the request's 16. */
    const readsSignalPerEvent = (opened: Promise<void>) => async function* (options: Record<string, unknown>) {
      yield { choices: [], responseTextDelta: 'Partial', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } };
      await opened;
      if ((options.abortSignal as AbortSignal | undefined)?.aborted) {
        yield { isFinal: true, choices: [], usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 }, error: { message: 'Stream aborted by caller', type: 'abort' } };
      }
    };
    /** One attempt the caller aborts once its first chunk is in; the provider's abort chunk comes after the attempt has ended. */
    async function abortAfterFirstChunk(onLateUsage?: (report: LateAttemptUsage) => void): Promise<Array<Record<string, any>>> {
      const controller = new AbortController();
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      const attempt = createCompletionGateway().stream(resolutionWith(readsSignalPerEvent(opened)), [], { abortSignal: controller.signal }, undefined, undefined, false, onLateUsage);
      const chunks: Array<Record<string, any>> = [];
      for await (const chunk of attempt) {
        chunks.push(chunk as Record<string, any>);
        controller.abort();
      }
      open();
      return chunks;
    }

    const late: LateAttemptUsage[] = [];
    const chunks = await abortAfterFirstChunk((report) => late.push(report));
    // The attempt reported 12 tokens and ended with the gateway's own abort chunk.
    expect(chunks.map((c) => [c.usage?.totalTokens, c.error?.type])).toEqual([[12, undefined], [undefined, 'abort']]);
    await vi.waitFor(() => expect(late).toEqual([{ providerId: 'openai', modelId: 'gpt-4o', hop: 0, usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 } }]));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await abortAfterFirstChunk();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 prompt, 2 completion, 4 total tokens')));
    } finally {
      warn.mockRestore();
    }
  });
});
