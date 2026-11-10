/**
 * @file memoryProviderHooks.test.ts
 * Unit tests for applyMemoryProvider helper.
 *
 * Contract: the helper wraps onBeforeGeneration with one memory.getContext
 * recall for the call, inserted on every step as a data block in a user-role
 * message right before the turn's own user message. Chains any user-provided
 * onBeforeGeneration AFTER the memory wiring. observe is not the wrapper's:
 * agent() observes after the answered turn. Returns baseOpts unchanged when
 * the provider has no getContext.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import { applyMemoryProvider, MEMORY_TIMEOUT_MS } from '../memoryProviderHooks';
import { renderMemoryRecallBlock } from '../memoryDataBlock';
import type { AgentMemoryProvider } from '../../agent';
import { resetLoggerFactory, setLogger } from '../../../core/logging/loggerFactory';

const logged: Record<string, unknown>[] = [];
beforeEach(() => {
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(() => resetLoggerFactory());

const CONTEXT = { sessionId: 's1', userId: 's1', subject: { kind: 'session', id: 's1' }, call: 'session' } as const;
/** The data block the mock provider's recall is sent as. */
const BLOCK = { role: 'user', content: renderMemoryRecallBlock([{ text: 'Memory block' }]) };

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
    const result = applyMemoryProvider(baseOpts as any, undefined, { userText: 'user text', context: CONTEXT });
    expect(result).toBe(baseOpts);
  });

  it('returns opts unchanged when provider has neither getContext nor observe', () => {
    const baseOpts = { provider: 'openai', model: 'gpt-4o' };
    const result = applyMemoryProvider(baseOpts as any, {}, { userText: 'user text', context: CONTEXT });
    expect(result).toBe(baseOpts);
  });

  it('wraps onBeforeGeneration when getContext is defined', async () => {
    const provider = createMockProvider();
    const baseOpts = { provider: 'openai', model: 'gpt-4o' };
    const result = applyMemoryProvider(baseOpts as any, provider, { userText: 'hello', context: CONTEXT });

    expect(result.onBeforeGeneration).toBeDefined();
    const ctx = { messages: [{ role: 'user', content: 'hello' }] };
    const next = await result.onBeforeGeneration!(ctx as any);

    expect(provider.getContext).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ tokenBudget: expect.any(Number), context: CONTEXT }),
    );
    expect((next as any).messages).toEqual([BLOCK, { role: 'user', content: 'hello' }]);
  });

  it('inserts memory context as a user message right before the turn, leaving the system messages as they are', async () => {
    const provider = createMockProvider();
    const baseOpts = { provider: 'anthropic', model: 'claude-sonnet-4-6' };
    const result = applyMemoryProvider(baseOpts as any, provider, { userText: 'hello', context: CONTEXT });

    // The caller's system content carries a cache breakpoint on its stable
    // prefix. Recall text is never a system message: the prefix, the system
    // messages and the earlier turns are sent as they were.
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
    expect((next as any).messages[1]).toEqual(BLOCK);
    expect((next as any).messages[2]).toEqual({ role: 'user', content: 'hello' });
  });

  it('inserts memory context after the history, before the last user message, with every system message untouched', async () => {
    const provider = createMockProvider();
    const baseOpts = { provider: 'anthropic', model: 'claude-sonnet-4-6' };
    const result = applyMemoryProvider(baseOpts as any, provider, { userText: 'hello', context: CONTEXT });

    const ctx = {
      messages: [
        { role: 'system', content: 'Primary instructions' },
        { role: 'system', content: 'Secondary instructions' },
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'earlier reply' },
        { role: 'user', content: 'hello' },
      ],
    };
    const next = await result.onBeforeGeneration!(ctx as any);

    expect((next as any).messages).toEqual([
      { role: 'system', content: 'Primary instructions' },
      { role: 'system', content: 'Secondary instructions' },
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'earlier reply' },
      BLOCK,
      { role: 'user', content: 'hello' },
    ]);
  });

  it('skips prepend when getContext returns null', async () => {
    const provider = createMockProvider({
      getContext: vi.fn().mockResolvedValue(null),
    });
    const baseOpts = { provider: 'openai', model: 'gpt-4o' };
    const result = applyMemoryProvider(baseOpts as any, provider, { userText: 'hello', context: CONTEXT });

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
    const result = applyMemoryProvider(baseOpts as any, provider, { userText: 'hello', context: CONTEXT });

    const ctx = { messages: [{ role: 'user', content: 'hello' }] };
    const next = await result.onBeforeGeneration!(ctx as any);

    expect((next as any).messages).toHaveLength(1);
  });

  it('calls getContext once for the call and inserts the same block on every step', async () => {
    const provider = createMockProvider();
    const result = applyMemoryProvider({ provider: 'openai', model: 'gpt-4o' } as any, provider, { userText: 'hello', context: CONTEXT });
    const ctx = { messages: [{ role: 'user', content: 'hello' }] };
    const first = await result.onBeforeGeneration!(ctx as any);
    const second = await result.onBeforeGeneration!(ctx as any);

    expect(provider.getContext).toHaveBeenCalledTimes(1);
    for (const next of [first, second]) {
      expect((next as any).messages).toEqual([BLOCK, { role: 'user', content: 'hello' }]);
    }
  });

  it('returns opts unchanged for a provider with observe alone, leaving onAfterGeneration the caller\'s', () => {
    const onAfterGeneration = vi.fn();
    const baseOpts = { provider: 'openai', model: 'gpt-4o', onAfterGeneration };
    const result = applyMemoryProvider(baseOpts as any, { observe: vi.fn() }, { userText: 'hello', context: CONTEXT });
    expect(result).toBe(baseOpts);
    expect(result.onAfterGeneration).toBe(onAfterGeneration);
  });

  it('times out getContext after MEMORY_TIMEOUT_MS and skips prepend', async () => {
    vi.useFakeTimers();
    try {
      const slowProvider = createMockProvider({
        getContext: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      const baseOpts = { provider: 'openai', model: 'gpt-4o' };
      const result = applyMemoryProvider(baseOpts as any, slowProvider, { userText: 'hello', context: CONTEXT });
      const ctx = { messages: [{ role: 'user', content: 'hello' }] };

      const next = result.onBeforeGeneration!(ctx as any);
      vi.advanceTimersByTime(MEMORY_TIMEOUT_MS + 10);
      const resolved = await next;

      expect((resolved as any).messages).toHaveLength(1);
      expect(logged.filter((line) => line.event === 'memory.hook_failed')).toEqual([
        expect.objectContaining({ hook: 'getContext', type: 'TimeoutError', code: 'MEMORY_HOOK_TIMEOUT' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
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
    const result = applyMemoryProvider(baseOpts as any, provider, { userText: 'hello', context: CONTEXT });

    const ctx = { messages: [{ role: 'user', content: 'hello' }] };
    const next = await result.onBeforeGeneration!(ctx as any);

    expect(userHook).toHaveBeenCalled();
    expect((next as any).extraFlag).toBe(true);
    expect((next as any).messages[0]).toEqual(BLOCK);
  });
});
