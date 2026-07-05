/**
 * @file memoryProviderHooks.test.ts
 * Unit tests for applyMemoryProvider helper.
 *
 * Contract: the helper wraps onBeforeGeneration (with memory.getContext
 * retrieval + system-message prepend) and onAfterGeneration (with
 * memory.observe fire-and-forget for user + assistant text). Chains any
 * user-provided hooks AFTER the memory wiring. Returns baseOpts unchanged
 * when provider is absent or lacks both hooks.
 */
import { describe, expect, it, vi } from 'vitest';

import { applyMemoryProvider, MEMORY_TIMEOUT_MS } from '../memoryProviderHooks';
import type { AgentMemoryProvider } from '../../agent';

function createMockProvider(
  overrides: Partial<AgentMemoryProvider> = {},
): AgentMemoryProvider {
  return {
    getContext: vi.fn().mockResolvedValue({ contextText: 'Memory block' }),
    observe: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('applyMemoryProvider', () => {
  it('returns opts unchanged when provider is undefined', () => {
    const baseOpts = { provider: 'openai', model: 'gpt-4o' };
    const result = applyMemoryProvider(baseOpts as any, undefined, 'user text');
    expect(result).toBe(baseOpts);
  });

  it('returns opts unchanged when provider has neither getContext nor observe', () => {
    const baseOpts = { provider: 'openai', model: 'gpt-4o' };
    const result = applyMemoryProvider(baseOpts as any, {}, 'user text');
    expect(result).toBe(baseOpts);
  });

  it('wraps onBeforeGeneration when getContext is defined', async () => {
    const provider = createMockProvider();
    const baseOpts = { provider: 'openai', model: 'gpt-4o' };
    const result = applyMemoryProvider(baseOpts as any, provider, 'hello');

    expect(result.onBeforeGeneration).toBeDefined();
    const ctx = { messages: [{ role: 'user', content: 'hello' }] };
    const next = await result.onBeforeGeneration!(ctx as any);

    expect(provider.getContext).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ tokenBudget: expect.any(Number) }),
    );
    expect((next as any).messages[0]).toEqual({
      role: 'system',
      content: 'Memory block',
    });
  });

  it('inserts memory context AFTER a leading system message so cached prefixes stay stable', async () => {
    const provider = createMockProvider();
    const baseOpts = { provider: 'anthropic', model: 'claude-sonnet-4-6' };
    const result = applyMemoryProvider(baseOpts as any, provider, 'hello');

    // The caller's system content carries a cache breakpoint on its stable
    // prefix. Recall text must land AFTER it — a prepend at index 0 rewrites
    // the provider-side cache prefix every turn (write every call, read 0).
    const systemMsg = {
      role: 'system',
      content: [
        { type: 'text', text: 'Stable prefix', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'Volatile tail' },
      ],
    };
    const ctx = {
      messages: [systemMsg, { role: 'user', content: 'hello' }],
    };
    const next = await result.onBeforeGeneration!(ctx as any);

    expect((next as any).messages).toHaveLength(3);
    expect((next as any).messages[0]).toBe(systemMsg);
    expect((next as any).messages[1]).toEqual({
      role: 'system',
      content: 'Memory block',
    });
    expect((next as any).messages[2]).toEqual({ role: 'user', content: 'hello' });
  });

  it('inserts memory context after ALL consecutive leading system messages', async () => {
    const provider = createMockProvider();
    const baseOpts = { provider: 'anthropic', model: 'claude-sonnet-4-6' };
    const result = applyMemoryProvider(baseOpts as any, provider, 'hello');

    const ctx = {
      messages: [
        { role: 'system', content: 'Primary instructions' },
        { role: 'system', content: 'Secondary instructions' },
        { role: 'user', content: 'hello' },
      ],
    };
    const next = await result.onBeforeGeneration!(ctx as any);

    expect((next as any).messages).toHaveLength(4);
    expect((next as any).messages[0].content).toBe('Primary instructions');
    expect((next as any).messages[1].content).toBe('Secondary instructions');
    expect((next as any).messages[2]).toEqual({
      role: 'system',
      content: 'Memory block',
    });
    expect((next as any).messages[3].role).toBe('user');
  });

  it('skips prepend when getContext returns null', async () => {
    const provider = createMockProvider({
      getContext: vi.fn().mockResolvedValue(null),
    });
    const baseOpts = { provider: 'openai', model: 'gpt-4o' };
    const result = applyMemoryProvider(baseOpts as any, provider, 'hello');

    const ctx = { messages: [{ role: 'user', content: 'hello' }] };
    const next = await result.onBeforeGeneration!(ctx as any);

    expect((next as any).messages).toHaveLength(1);
    expect((next as any).messages[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('skips prepend when getContext returns empty contextText', async () => {
    const provider = createMockProvider({
      getContext: vi.fn().mockResolvedValue({ contextText: '' }),
    });
    const baseOpts = { provider: 'openai', model: 'gpt-4o' };
    const result = applyMemoryProvider(baseOpts as any, provider, 'hello');

    const ctx = { messages: [{ role: 'user', content: 'hello' }] };
    const next = await result.onBeforeGeneration!(ctx as any);

    expect((next as any).messages).toHaveLength(1);
  });

  it('times out getContext after MEMORY_TIMEOUT_MS and skips prepend', async () => {
    vi.useFakeTimers();
    try {
      const slowProvider = createMockProvider({
        getContext: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      const baseOpts = { provider: 'openai', model: 'gpt-4o' };
      const result = applyMemoryProvider(baseOpts as any, slowProvider, 'hello');
      const ctx = { messages: [{ role: 'user', content: 'hello' }] };

      const next = result.onBeforeGeneration!(ctx as any);
      vi.advanceTimersByTime(MEMORY_TIMEOUT_MS + 10);
      const resolved = await next;

      expect((resolved as any).messages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps onAfterGeneration when observe is defined and fires both observes', async () => {
    const provider = createMockProvider();
    const baseOpts = { provider: 'openai', model: 'gpt-4o' };
    const result = applyMemoryProvider(baseOpts as any, provider, 'hello');

    expect(result.onAfterGeneration).toBeDefined();
    await result.onAfterGeneration!({
      text: 'world',
      messages: [{ role: 'user', content: 'hello' }],
    } as any);

    // Fire-and-forget: wait a tick for the async void promises
    await new Promise((resolve) => setImmediate(resolve));
    expect(provider.observe).toHaveBeenCalledWith('user', 'hello');
    expect(provider.observe).toHaveBeenCalledWith('assistant', 'world');
  });

  it('does not reject onAfterGeneration when observe rejects', async () => {
    const provider = createMockProvider({
      observe: vi.fn().mockRejectedValue(new Error('observe failed')),
    });
    const baseOpts = { provider: 'openai', model: 'gpt-4o' };
    const result = applyMemoryProvider(baseOpts as any, provider, 'hello');

    await expect(
      result.onAfterGeneration!({
        text: 'world',
        messages: [{ role: 'user', content: 'hello' }],
      } as any),
    ).resolves.toBeDefined();
  });

  it('chains user-provided onBeforeGeneration after memory wiring', async () => {
    const provider = createMockProvider();
    const userHook = vi.fn().mockImplementation(async (ctx: any) => ({
      ...ctx,
      extraFlag: true,
    }));
    const baseOpts = {
      provider: 'openai',
      model: 'gpt-4o',
      onBeforeGeneration: userHook,
    };
    const result = applyMemoryProvider(baseOpts as any, provider, 'hello');

    const ctx = { messages: [{ role: 'user', content: 'hello' }] };
    const next = await result.onBeforeGeneration!(ctx as any);

    expect(userHook).toHaveBeenCalled();
    expect((next as any).extraFlag).toBe(true);
    expect((next as any).messages[0]).toEqual({
      role: 'system',
      content: 'Memory block',
    });
  });

  it('chains user-provided onAfterGeneration after memory observe', async () => {
    const provider = createMockProvider();
    const userHook = vi.fn().mockImplementation(async (r: any) => ({
      ...r,
      extraField: 'added',
    }));
    const baseOpts = {
      provider: 'openai',
      model: 'gpt-4o',
      onAfterGeneration: userHook,
    };
    const result = applyMemoryProvider(baseOpts as any, provider, 'hello');

    const final = await result.onAfterGeneration!({
      text: 'world',
      messages: [{ role: 'user', content: 'hello' }],
    } as any);

    expect(userHook).toHaveBeenCalled();
    expect((final as any).extraField).toBe('added');
  });
});
