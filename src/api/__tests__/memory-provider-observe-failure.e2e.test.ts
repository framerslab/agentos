/**
 * A memoryProvider whose observe() fails, end to end on both runtimes: the turn's answer is unchanged, and the
 * failure is logged on its first occurrence and then at the 10th, 100th, 1000th ... failure of that provider, so a
 * broken store cannot flood the log. Runs over the real agent, generateText, provider manager and GMI; only the
 * OpenAI provider class is stubbed (helpers/stubProviders.ts), at its module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { agent, type AgentMemoryProvider, type AgentOptions } from '../agent';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-observe-${++n}`;
const stubbed = (apiKey: string, extra: Partial<AgentOptions> = {}) =>
  ({ provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [], ...extra }) as unknown as AgentOptions;

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
});

/** The console.warn lines about a memory provider that failed to record a turn. */
function observeWarnings(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls.map((call) => call.map(String).join(' ')).filter((line) => line.includes('failed to record'));
}

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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const k = key();
    script('openai', k, { whole: true, replies: Array.from({ length: 5 }, (_, i) => reply.text(`Answer ${i}.`)) });
    const memoryProvider = failingProvider();
    const a = agent(stubbed(k, { memoryProvider }));

    expect((await a.generate('hi')).text).toBe('Answer 0.');
    await vi.waitFor(() => expect(memoryProvider.calls).toBe(2));
    await vi.waitFor(() => expect(observeWarnings(warn)).toHaveLength(1));
    expect(observeWarnings(warn)[0]).toContain('answered');
    expect(observeWarnings(warn)[0]).toContain('store down');

    // Four more turns: failures 3 to 10. Only the 10th is logged.
    for (let i = 1; i < 5; i++) expect((await a.generate(`turn ${i}`)).text).toBe(`Answer ${i}.`);
    await vi.waitFor(() => expect(memoryProvider.calls).toBe(10));
    await vi.waitFor(() => expect(observeWarnings(warn)).toHaveLength(2));
    expect(observeWarnings(warn)[1]).toContain('10');
  });

  it("is logged on runtime: 'gmi', and the turn is answered as before", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const k = key();
    script('openai', k, { replies: [reply.text('Done.')] });
    const memoryProvider = failingProvider();
    const session = agent(stubbed(k, { runtime: 'gmi', memoryProvider } as Partial<AgentOptions>)).session('s');

    expect((await session.send('hi')).text).toBe('Done.');
    await vi.waitFor(() => expect(memoryProvider.calls).toBe(2));
    await vi.waitFor(() => expect(observeWarnings(warn)).toHaveLength(1));
    expect(observeWarnings(warn)[0]).toContain('store down');
  });
});
