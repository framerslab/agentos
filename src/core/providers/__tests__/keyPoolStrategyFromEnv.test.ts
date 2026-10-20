import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The resolver writes through the library's `key-pool` logger; the spy records every line.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../logging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logging/index.js')>();
  return { ...actual, createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }) };
});

import { keyPoolStrategyFromEnv } from '../ApiKeyPool.js';

const ignored = () => warn.mock.calls.filter(([event]) => event === 'key_pool.strategy_ignored');

describe('keyPoolStrategyFromEnv', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    warn.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("takes a provider's own variable over the shared one when it names a strategy", () => {
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY', 'ordered');
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY_OPENAI', 'round-robin');
    expect(keyPoolStrategyFromEnv('openai')).toEqual({ strategy: 'round-robin' });
    expect(keyPoolStrategyFromEnv('anthropic')).toEqual({ strategy: 'ordered' });
    expect(ignored()).toHaveLength(0);
  });

  it("skips an own variable that names no strategy, so the shared one stays in force, and says so once", () => {
    // A typo in the provider's own variable no longer drops the shared ordered setting to round-robin.
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY', 'ordered');
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY_ANTHROPIC', 'orderd');
    expect(keyPoolStrategyFromEnv('anthropic')).toEqual({ strategy: 'ordered' });
    expect(keyPoolStrategyFromEnv('anthropic')).toEqual({ strategy: 'ordered' });
    expect(ignored()).toHaveLength(1);
    // The line names the variable, not what it holds.
    expect(ignored()[0][1]).toEqual({ variable: 'AGENTOS_KEY_POOL_STRATEGY_ANTHROPIC' });
  });

  it('falls back to the default when neither variable names a strategy, with one line for each', () => {
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY', 'cost-order');
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY_GEMINI', 'Ordered');
    expect(keyPoolStrategyFromEnv('gemini')).toEqual({});
    expect(keyPoolStrategyFromEnv('gemini')).toEqual({});
    expect(ignored().map(([, meta]) => meta)).toEqual([
      { variable: 'AGENTOS_KEY_POOL_STRATEGY_GEMINI' },
      { variable: 'AGENTOS_KEY_POOL_STRATEGY' },
    ]);
  });

  it('writes again when a variable is changed to another value that names no strategy', () => {
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY_REQUESTY', 'first-typo');
    expect(keyPoolStrategyFromEnv('requesty')).toEqual({});
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY_REQUESTY', 'second-typo');
    expect(keyPoolStrategyFromEnv('requesty')).toEqual({});
    expect(ignored()).toHaveLength(2);
  });

  it('reads nothing and writes nothing when no variable is set', () => {
    expect(keyPoolStrategyFromEnv('openrouter')).toEqual({});
    expect(keyPoolStrategyFromEnv()).toEqual({});
    expect(ignored()).toHaveLength(0);
  });
});
