/**
 * @file key-pool-defaults.e2e.test.ts
 * A host's key pool defaults (a store, a strategy) reach the pools that `createProviderManager()` builds, and a key
 * read from the environment names its pool `<provider>:<ENV_VAR>`, so the pool's state persists under that name; an
 * override names no pool. Drives the real resolver, manager and OpenAIProvider; only fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { createProviderManager, resolveProvider } from '../model.js';
import { getKeyPoolDefaults, setKeyPoolDefaults } from '../keyPoolDefaults.js';
import { InMemoryKeyPoolStateStore } from '../../core/providers/KeyPoolStateStore.js';

const modelList = () => new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('key pool defaults on the generateText path', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => modelList());
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    setKeyPoolDefaults(null);
    vi.unstubAllEnvs();
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

  it('names no pool for an override, so the store does not apply to it', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk_pooltest_env_0003');
    const resolved = resolveProvider('openai', 'gpt-4o', { apiKey: 'sk_pooltest_override_0004' });
    expect(resolved.poolId).toBeUndefined();
  });
});
