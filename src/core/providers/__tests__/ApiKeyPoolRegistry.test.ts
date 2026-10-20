import { describe, it, expect, beforeEach, vi } from 'vitest';

// The registry and the pool write through the library's `key-pool` logger; the spy records every line.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../logging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logging/index.js')>();
  return { ...actual, createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }) };
});

import { getKeyPool, resetAllPools } from '../ApiKeyPoolRegistry.js';

describe('ApiKeyPoolRegistry', () => {
  beforeEach(() => {
    resetAllPools();
    vi.unstubAllEnvs();
    warn.mockClear();
  });

  it('creates a pool from an env var', () => {
    vi.stubEnv('TEST_API_KEY', 'sk_a,sk_b');
    const pool = getKeyPool('TEST_API_KEY');
    expect(pool.size).toBe(2);
  });

  it('returns the same pool instance for the same env var', () => {
    vi.stubEnv('TEST_API_KEY', 'sk_a');
    const a = getKeyPool('TEST_API_KEY');
    const b = getKeyPool('TEST_API_KEY');
    expect(a).toBe(b);
  });

  it('returns different pools for different env vars', () => {
    vi.stubEnv('KEY_A', 'sk_a');
    vi.stubEnv('KEY_B', 'sk_b');
    expect(getKeyPool('KEY_A')).not.toBe(getKeyPool('KEY_B'));
  });

  it('shares exhaustion state across calls', () => {
    vi.stubEnv('TEST_API_KEY', 'sk_a,sk_b');
    const pool1 = getKeyPool('TEST_API_KEY');
    pool1.next(); // advance
    pool1.markExhausted('sk_a');

    const pool2 = getKeyPool('TEST_API_KEY');
    expect(pool2.next()).toBe('sk_b');
  });

  it('handles missing env var gracefully', () => {
    const pool = getKeyPool('NONEXISTENT_KEY');
    expect(pool.size).toBe(0);
    expect(pool.hasKeys).toBe(false);
  });

  it("builds the pool from the first call's config, and ignores a later call's config with one warning per variable", () => {
    vi.stubEnv('TEST_API_KEY', 'sk_a,sk_b');
    const first = getKeyPool('TEST_API_KEY');
    // Another module asks for the same variable's pool in cost order: it gets the first pool, still round-robin.
    const later = getKeyPool('TEST_API_KEY', { strategy: 'ordered' });
    expect(later).toBe(first);
    expect([later.next(), later.next(), later.next(), later.next()]).toEqual(['sk_a', 'sk_a', 'sk_b', 'sk_a']);
    getKeyPool('TEST_API_KEY', { strategy: 'ordered' });
    const ignored = () => warn.mock.calls.filter(([event]) => event === 'key_pool.registry_config_ignored');
    expect(ignored()).toHaveLength(1);
    // The line names the variable and nothing of the config.
    expect(ignored()[0][1]).toEqual({ envVar: 'TEST_API_KEY' });
    // A call without a config drops nothing and writes nothing.
    getKeyPool('TEST_API_KEY');
    expect(ignored()).toHaveLength(1);
  });
});
