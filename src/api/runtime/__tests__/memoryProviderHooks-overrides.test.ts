/**
 * @file memoryProviderHooks-overrides.test.ts
 * Caller overrides + failure logging for the memory-provider hooks (W-84).
 *
 * The hook historically hardcoded MEMORY_TIMEOUT_MS (5000) and
 * DEFAULT_MEMORY_TOKEN_BUDGET (2000) with no caller override, raced
 * getContext against the timeout silently, and swallowed failures in a
 * log-free catch — so a slow or failing assembly dropped the entire memory
 * block with no signal while the provider's own (still-running) success log
 * read as if recall had landed. The hook now accepts optional
 * { timeoutMs, tokenBudget } overrides (agent()-surface: `memoryProviderOptions`),
 * and writes a memory.hook_failed event when the timeout wins the race or
 * getContext fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, getProvider, createProviderManager };
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

import {
  applyMemoryProvider,
  DEFAULT_MEMORY_TOKEN_BUDGET,
  MEMORY_TIMEOUT_MS,
} from '../memoryProviderHooks';
import { agent } from '../../agent.js';
import type { AgentMemoryProvider } from '../../agent';
import { resetLoggerFactory, setLogger } from '../../../core/logging/loggerFactory.js';

const CONTEXT = { sessionId: 's1', userId: 's1', subject: { kind: 'session', id: 's1' }, call: 'session' } as const;

function createMockProvider(
  overrides: Partial<AgentMemoryProvider> = {},
): AgentMemoryProvider {
  return {
    getContext: vi.fn().mockResolvedValue({ contextText: 'Memory block' }),
    observe: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('applyMemoryProvider hook options', () => {
  const baseOpts = { provider: 'openai', model: 'gpt-4.1-mini' };
  const logged: Record<string, unknown>[] = [];
  const failures = () => logged.filter((line) => line.event === 'memory.hook_failed');

  beforeEach(() => {
    logged.length = 0;
    setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
  });

  afterEach(() => {
    resetLoggerFactory();
  });

  it('forwards the default token budget when no overrides are given', async () => {
    const provider = createMockProvider();
    const result = applyMemoryProvider(baseOpts as any, provider, { userText: 'hello', context: CONTEXT });
    await result.onBeforeGeneration!({ messages: [{ role: 'user', content: 'hello' }] } as any);
    expect(provider.getContext).toHaveBeenCalledWith('hello', {
      tokenBudget: DEFAULT_MEMORY_TOKEN_BUDGET,
      context: CONTEXT,
    });
  });

  it('forwards a custom tokenBudget override to getContext', async () => {
    const provider = createMockProvider();
    const result = applyMemoryProvider(baseOpts as any, provider, { userText: 'hello', context: CONTEXT }, { tokenBudget: 4000 });
    await result.onBeforeGeneration!({ messages: [{ role: 'user', content: 'hello' }] } as any);
    expect(provider.getContext).toHaveBeenCalledWith('hello', { tokenBudget: 4000, context: CONTEXT });
  });

  it('honors a custom timeoutMs and logs memory.hook_failed when the provider loses the race', async () => {
    vi.useFakeTimers();
    try {
      const slowProvider = createMockProvider({
        getContext: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      const result = applyMemoryProvider(baseOpts as any, slowProvider, { userText: 'hello', context: CONTEXT }, { timeoutMs: 100 });
      const next = result.onBeforeGeneration!({
        messages: [{ role: 'user', content: 'hello' }],
      } as any);
      vi.advanceTimersByTime(110);
      const resolved = await next;

      expect((resolved as any).messages).toHaveLength(1);
      expect(failures()).toEqual([expect.objectContaining({ hook: 'getContext', type: 'TimeoutError', code: 'MEMORY_HOOK_TIMEOUT' })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the default MEMORY_TIMEOUT_MS race when no timeoutMs override is given', async () => {
    vi.useFakeTimers();
    try {
      const slowProvider = createMockProvider({
        getContext: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      const result = applyMemoryProvider(baseOpts as any, slowProvider, { userText: 'hello', context: CONTEXT });
      let settled = false;
      const next = result
        .onBeforeGeneration!({ messages: [{ role: 'user', content: 'hello' }] } as any)
        .then((resolved) => {
          settled = true;
          return resolved;
        });

      vi.advanceTimersByTime(100);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(failures()).toEqual([]);

      vi.advanceTimersByTime(MEMORY_TIMEOUT_MS + 10);
      const resolved = await next;
      expect(settled).toBe(true);
      expect((resolved as any).messages).toHaveLength(1);
      expect(failures()).toEqual([expect.objectContaining({ hook: 'getContext', type: 'TimeoutError', code: 'MEMORY_HOOK_TIMEOUT' })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs memory.hook_failed when getContext rejects and continues with the unmodified context', async () => {
    const failingProvider = createMockProvider({
      getContext: vi.fn().mockRejectedValue(new Error('assembly boom')),
    });
    const result = applyMemoryProvider(baseOpts as any, failingProvider, { userText: 'hello', context: CONTEXT });
    const ctx = { messages: [{ role: 'user', content: 'hello' }] };
    const next = await result.onBeforeGeneration!(ctx as any);

    expect((next as any).messages).toHaveLength(1);
    expect(failures()).toEqual([expect.objectContaining({ hook: 'getContext', type: 'Error' })]);
    expect(JSON.stringify(logged)).not.toContain('assembly boom');
  });

  it('logs nothing when getContext resolves normally', async () => {
    const provider = createMockProvider();
    const result = applyMemoryProvider(baseOpts as any, provider, { userText: 'hello', context: CONTEXT });
    await result.onBeforeGeneration!({ messages: [{ role: 'user', content: 'hello' }] } as any);
    expect(failures()).toEqual([]);
  });
});

describe('agent() memoryProviderOptions wiring', () => {
  const okCompletion = {
    modelId: 'gpt-4.1-mini',
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }],
  };

  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
    hoisted.generateCompletion.mockResolvedValue(okCompletion);
  });

  it('threads agent-level memoryProviderOptions into the getContext call', async () => {
    const provider = createMockProvider();
    const a = agent({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      memory: false,
      memoryProvider: provider,
      memoryProviderOptions: { tokenBudget: 4321, timeoutMs: 1234 },
    });
    const result = await a.generate('hello');
    expect(result.text).toBe('ok');
    expect(provider.getContext).toHaveBeenCalledWith('hello', {
      tokenBudget: 4321,
      context: expect.objectContaining({ sessionId: expect.stringMatching(/^generate-/), call: 'one-shot' }),
    });
  });

  it('keeps the module-default budget when the agent declares no overrides', async () => {
    const provider = createMockProvider();
    const a = agent({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      memory: false,
      memoryProvider: provider,
    });
    await a.generate('hello');
    expect(provider.getContext).toHaveBeenCalledWith('hello', {
      tokenBudget: DEFAULT_MEMORY_TOKEN_BUDGET,
      context: expect.objectContaining({ sessionId: expect.stringMatching(/^generate-/), call: 'one-shot' }),
    });
  });
});
