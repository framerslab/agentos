/**
 * A memoryProvider whose observe() fails, end to end on both runtimes: the turn's answer is unchanged, and the
 * failure is logged as a `memory.hook_failed` event (the hook, the error's type and code, never its message) on its
 * first occurrence and then at the 10th, 100th, 1000th ... failure of that provider, so a broken store cannot flood
 * the log. Runs over the real agent, generateText, provider manager and GMI; only the OpenAI provider class is stubbed
 * (helpers/stubProviders.ts), at its module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { inspect } from 'node:util';
import pino from 'pino';
import { agent, type AgentMemoryProvider, type AgentOptions } from '../agent';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-observe-${++n}`;
const stubbed = (apiKey: string, extra: Partial<AgentOptions> = {}) =>
  ({ provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [], ...extra }) as unknown as AgentOptions;

const logged: Record<string, unknown>[] = [];
beforeEach(() => {
  globalLLMProviderHealth.reset();
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(() => {
  resetLoggerFactory();
  vi.restoreAllMocks();
});

/** The lines about a memory provider whose observe failed. */
const observeFailures = () => logged.filter((line) => line.event === 'memory.hook_failed' && line.hook === 'observe');

const failingProvider = (): AgentMemoryProvider & { calls: number } => {
  const provider = {
    calls: 0,
    observe: async () => {
      provider.calls += 1;
      throw new Error('store down');
    },
  };
  return provider;
};

describe('a memoryProvider whose observe() fails', () => {
  it('is logged on the default runtime, first and then sparsely, and the turn is answered as before', async () => {
    const k = key();
    script('openai', k, { whole: true, replies: Array.from({ length: 5 }, (_, i) => reply.text(`Answer ${i}.`)) });
    const memoryProvider = failingProvider();
    const a = agent(stubbed(k, { memoryProvider }));

    expect((await a.generate('hi')).text).toBe('Answer 0.');
    await vi.waitFor(() => expect(memoryProvider.calls).toBe(2));
    await vi.waitFor(() => expect(observeFailures()).toHaveLength(1));
    expect(observeFailures()[0]).toMatchObject({ hook: 'observe', type: 'Error' });

    // Four more turns: failures 3 to 10. Only the 10th is logged.
    for (let i = 1; i < 5; i++) expect((await a.generate(`turn ${i}`)).text).toBe(`Answer ${i}.`);
    await vi.waitFor(() => expect(memoryProvider.calls).toBe(10));
    await vi.waitFor(() => expect(observeFailures()).toHaveLength(2));
    expect(JSON.stringify(logged)).not.toContain('store down');
  });

  it('is logged, and the turn answered, when observe() fails with a value that cannot be turned into text', async () => {
    const k = key();
    script('openai', k, { whole: true, replies: [reply.text('First.'), reply.text('Second.')] });
    // An object with no prototype has no toString: String() of it throws.
    const rejecting: AgentMemoryProvider = { observe: async () => { throw Object.create(null); } };
    const throwing = { observe: () => { throw Object.create(null); } } as unknown as AgentMemoryProvider;

    expect((await agent(stubbed(k, { memoryProvider: rejecting })).generate('hi')).text).toBe('First.');
    expect((await agent(stubbed(k, { memoryProvider: throwing })).generate('hi again')).text).toBe('Second.');
    // One line for each provider's first failure.
    await vi.waitFor(() => expect(observeFailures()).toHaveLength(2));
  });

  it('is logged, with no unhandled rejection, when observe() fails with an error that cannot be inspected', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const k = key();
      script('openai', k, { whole: true, replies: [reply.text('Answered.')] });
      const error = new Error('store down');
      Object.defineProperty(error, inspect.custom, { value: () => { throw new Error('cannot inspect'); } });
      const memoryProvider: AgentMemoryProvider = { observe: async () => { throw error; } };

      expect((await agent(stubbed(k, { memoryProvider })).generate('hi')).text).toBe('Answered.');
      await vi.waitFor(() => expect(observeFailures()).toHaveLength(1));
      expect(JSON.stringify(logged)).not.toContain('store down');
      // Let any rejection of the failure's handler surface.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it("is logged on runtime: 'gmi', and the turn is answered as before", async () => {
    const k = key();
    script('openai', k, { replies: [reply.text('Done.')] });
    const memoryProvider = failingProvider();
    const session = agent(stubbed(k, { runtime: 'gmi', memoryProvider } as Partial<AgentOptions>)).session('s');

    expect((await session.send('hi')).text).toBe('Done.');
    await vi.waitFor(() => expect(memoryProvider.calls).toBe(2));
    await vi.waitFor(() => expect(observeFailures()).toHaveLength(1));
    expect(JSON.stringify(logged)).not.toContain('store down');
  });
});
