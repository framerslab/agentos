/**
 * @file key-pool-defaults.e2e.test.ts
 * A host's key pool defaults (a store, a strategy) reach the pools that `createProviderManager()` builds, and a key
 * read from the environment names its pool `<provider>:<ENV_VAR>`, so the pool's state persists under that name; an
 * override names no pool. The providers that send through an OpenAIProvider (Groq, Mistral, Together, xAI) hand it
 * the same defaults and pool id, with their own strategy variable. Drives the real resolver, manager and
 * OpenAIProvider; only fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { cachedProviderManagerCount, createProviderManager, resolveProvider, shutdownProviderManagers } from '../model.js';
import { getKeyPoolDefaults, setKeyPoolDefaults } from '../keyPoolDefaults.js';
import { InMemoryKeyPoolStateStore, type KeyState } from '../../core/providers/KeyPoolStateStore.js';

const modelList = () => new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const okChat = { id: 'c1', object: 'chat.completion', created: 1, model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
const invalidKey = { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } };

/** The key a request carried in its Authorization header. */
const keyOf = (init?: RequestInit) => new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';

/** The OpenAIProvider a Groq, Mistral, Together or xAI provider sends through, with the config it was given and its pool. */
function delegateOf(manager: Awaited<ReturnType<typeof createProviderManager>>, providerId: string) {
  return (manager.getProvider(providerId) as unknown as {
    delegate: { config: { keyPool?: { id?: string; strategy?: string; store?: unknown; recheckMs?: number } }; keyPool: { next(): string } };
  }).delegate;
}

describe('key pool defaults on the generateText path', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => modelList());
    vi.unstubAllEnvs();
  });
  afterEach(async () => {
    await shutdownProviderManagers();
    setKeyPoolDefaults(null);
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("shutdownProviderManagers() writes the pools' pending state at once, so a short-lived host keeps a key's standing", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubEnv('OPENAI_API_KEY', 'sk_pooltest_gamma_0007,sk_pooltest_delta_0008');
    const store = new InMemoryKeyPoolStateStore();
    setKeyPoolDefaults({ strategy: 'ordered', store });
    const manager = await createProviderManager(resolveProvider('openai', 'gpt-4o'));
    const provider = manager.getProvider('openai')!;
    // The first key is refused and the request moves to the second; the first key's failure is saved a quarter of a
    // second later, which a host that exits now would lose.
    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => (keyOf(init) === 'sk_pooltest_gamma_0007' ? json(invalidKey, 401) : json(okChat)));
    const answer = await provider.generateCompletion('gpt-4o', [{ role: 'user', content: 'hi' }], {});
    expect(answer.choices[0]?.message?.content).toBe('hi');
    expect(await store.load('openai:OPENAI_API_KEY')).toBeNull();
    await shutdownProviderManagers();
    expect((await store.load('openai:OPENAI_API_KEY'))?.map((row) => row.status)).toEqual(['failed']);
    expect(cachedProviderManagerCount()).toBe(0);
    // The next call builds a new manager as the first call did.
    fetchMock.mockImplementation(async () => modelList());
    const again = await createProviderManager(resolveProvider('openai', 'gpt-4o'));
    expect(again).not.toBe(manager);
    log.mockRestore();
  });

  it('a manager built while shutdownProviderManagers() runs waits for it, so its pools load what the old pools wrote', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubEnv('OPENAI_API_KEY', 'sk_pooltest_eps_0009,sk_pooltest_zeta_0010');
    // A store whose writes land only when the test lets them, like a slow database.
    const inner = new InMemoryKeyPoolStateStore();
    let releaseSaves: () => void = () => undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSaves = resolve;
    });
    const store = {
      load: (poolId: string) => inner.load(poolId),
      save: async (poolId: string, state: KeyState) => {
        await saveGate;
        await inner.save(poolId, state);
      },
    };
    setKeyPoolDefaults({ strategy: 'ordered', store });
    const manager = await createProviderManager(resolveProvider('openai', 'gpt-4o'));
    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => (keyOf(init) === 'sk_pooltest_eps_0009' ? json(invalidKey, 401) : json(okChat)));
    await manager.getProvider('openai')!.generateCompletion('gpt-4o', [{ role: 'user', content: 'hi' }], {});

    // The shutdown writes the first key's failure, slowly; a call that comes in meanwhile builds the next manager.
    const shuttingDown = shutdownProviderManagers();
    fetchMock.mockImplementation(async () => modelList());
    let built = false;
    const replacement = createProviderManager(resolveProvider('openai', 'gpt-4o')).then((next) => {
      built = true;
      return next;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(built).toBe(false);
    releaseSaves();
    await shuttingDown;
    const next = await replacement;
    expect(next).not.toBe(manager);
    const pool = (next.getProvider('openai') as unknown as { keyPool: { snapshot(): Array<{ status: string }> } }).keyPool;
    expect(pool.snapshot().map((s) => s.status)).toEqual(['failed', 'ok']);
    log.mockRestore();
  });

  it('names the pool after the environment variable and forwards the defaults into the provider', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk_pooltest_alpha_0001,sk_pooltest_beta_0002');
    const store = new InMemoryKeyPoolStateStore();
    setKeyPoolDefaults({ strategy: 'ordered', store, recheckMs: 5_000 });
    expect(getKeyPoolDefaults()).toMatchObject({ strategy: 'ordered', recheckMs: 5_000 });

    const resolved = resolveProvider('openai', 'gpt-4o');
    expect(resolved.poolId).toBe('openai:OPENAI_API_KEY');

    const manager = await createProviderManager(resolved);
    const provider = manager.getProvider('openai') as unknown as { config: { keyPool?: { id?: string; strategy?: string; store?: unknown } } };
    expect(provider.config.keyPool).toMatchObject({ id: 'openai:OPENAI_API_KEY', strategy: 'ordered', recheckMs: 5_000 });
    expect(provider.config.keyPool?.store).toBe(store);
  });

  it('builds separate managers for one key string from the environment and from an override, and a new one when the defaults change', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk_pooltest_same_0005,sk_pooltest_same_0006');
    const configOf = (manager: Awaited<ReturnType<typeof createProviderManager>>) =>
      (manager.getProvider('openai') as unknown as { config: { keyPool?: { id?: string; strategy?: string } } }).config;
    const fromEnv = await createProviderManager(resolveProvider('openai', 'gpt-4o'));
    const fromOverride = await createProviderManager(resolveProvider('openai', 'gpt-4o', { apiKey: 'sk_pooltest_same_0005,sk_pooltest_same_0006' }));
    expect(fromOverride).not.toBe(fromEnv);
    expect(configOf(fromEnv).keyPool?.id).toBe('openai:OPENAI_API_KEY');
    expect(configOf(fromOverride).keyPool?.id).toBeUndefined();
    setKeyPoolDefaults({ strategy: 'ordered' });
    const afterChange = await createProviderManager(resolveProvider('openai', 'gpt-4o'));
    expect(afterChange).not.toBe(fromEnv);
    expect(configOf(afterChange).keyPool).toMatchObject({ id: 'openai:OPENAI_API_KEY', strategy: 'ordered' });
  });

  it.each([
    ['groq', 'GROQ_API_KEY', 'llama-3.3-70b-versatile'],
    ['mistral', 'MISTRAL_API_KEY', 'mistral-large-latest'],
    ['together', 'TOGETHER_API_KEY', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    ['xai', 'XAI_API_KEY', 'grok-2'],
  ])("forwards the defaults and the pool id into the OpenAIProvider that %s sends through", async (providerId, envVar, modelId) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubEnv(envVar, `${providerId}_pooltest_a_0011,${providerId}_pooltest_b_0012`);
    const store = new InMemoryKeyPoolStateStore();
    setKeyPoolDefaults({ strategy: 'ordered', store, recheckMs: 5_000 });
    const resolved = resolveProvider(providerId, modelId);
    expect(resolved.poolId).toBe(`${providerId}:${envVar}`);
    const delegate = delegateOf(await createProviderManager(resolved), providerId);
    // The pool that sends this provider's keys is named after its variable and carries the host's store and timings.
    expect(delegate.config.keyPool).toMatchObject({ id: `${providerId}:${envVar}`, strategy: 'ordered', recheckMs: 5_000 });
    expect(delegate.config.keyPool?.store).toBe(store);
    log.mockRestore();
  });

  it("takes a delegating provider's strategy from its own variable, never from OpenAI's", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const draws = (pool: { next(): string }) => new Set([pool.next(), pool.next(), pool.next(), pool.next()]);
    vi.stubEnv('GROQ_API_KEY', 'gsk_pooltest_c_0013,gsk_pooltest_d_0014');
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY_GROQ', 'ordered');
    let delegate = delegateOf(await createProviderManager(resolveProvider('groq', 'llama-3.3-70b-versatile')), 'groq');
    expect(delegate.config.keyPool).toMatchObject({ id: 'groq:GROQ_API_KEY', strategy: 'ordered' });
    expect(draws(delegate.keyPool)).toEqual(new Set(['gsk_pooltest_c_0013']));
    await shutdownProviderManagers();

    // OpenAI's own variable orders OpenAI's keys alone: Groq's keys keep spreading load.
    vi.unstubAllEnvs();
    vi.stubEnv('GROQ_API_KEY', 'gsk_pooltest_c_0013,gsk_pooltest_d_0014');
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY_OPENAI', 'ordered');
    delegate = delegateOf(await createProviderManager(resolveProvider('groq', 'llama-3.3-70b-versatile')), 'groq');
    expect(delegate.config.keyPool).toMatchObject({ id: 'groq:GROQ_API_KEY', strategy: 'round-robin' });
    expect(draws(delegate.keyPool)).toEqual(new Set(['gsk_pooltest_c_0013', 'gsk_pooltest_d_0014']));
    log.mockRestore();
  });

  it('names no pool for an override, so the store does not apply to it', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk_pooltest_env_0003');
    const resolved = resolveProvider('openai', 'gpt-4o', { apiKey: 'sk_pooltest_override_0004' });
    expect(resolved.poolId).toBeUndefined();
  });
});
