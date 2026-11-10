/**
 * The memory hooks end to end: who they are told a turn serves, how often they run, and how recalled text reaches the
 * model. Runs over the real agent, GMI, generateText, streamText and provider manager; only the OpenAI provider class is
 * stubbed (helpers/stubProviders.ts), at its module boundary, and each model call's messages are read from the script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import pino from 'pino';
import { agent, type AgentMemoryProvider, type AgentOptions, type MemoryHookContext } from '../agent';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-memory-hooks-${++n}`;
const stubbed = (apiKey: string, extra: Record<string, unknown> = {}) =>
  ({ provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [], ...extra }) as unknown as AgentOptions;
/** The runtimes each case runs on. */
const runtimes: Array<[string, Record<string, unknown>]> = [['the default runtime', {}]];

const logged: Record<string, unknown>[] = [];
beforeEach(() => {
  globalLLMProviderHealth.reset();
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(() => {
  resetLoggerFactory();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const events = (name: string) => logged.filter((line) => line.event === name);

interface HookCall { hook: 'getContext' | 'observe'; role?: string; text: string; context?: MemoryHookContext }
/** A provider that records every hook call and recalls nothing, or `recalled` when given. */
const recorder = (recalled?: Awaited<ReturnType<NonNullable<AgentMemoryProvider['getContext']>>>) => {
  const calls: HookCall[] = [];
  const provider: AgentMemoryProvider = {
    getContext: async (text, opts) => {
      calls.push({ hook: 'getContext', text, context: opts?.context });
      return recalled ?? null;
    },
    observe: async (role, text, context) => {
      calls.push({ hook: 'observe', role, text, context });
    },
  };
  return { provider, calls, observed: () => calls.filter((call) => call.hook === 'observe') };
};

describe.each(runtimes)('who the memory hooks are told a turn serves, on %s', (_name, runtime) => {
  it('a session opened with a user id: both hooks get the session, the user, the subject and the agent', async () => {
    const k = key();
    script('openai', k, { whole: true, replies: [reply.text('Hello.')] });
    const { provider, calls, observed } = recorder();
    const a = agent(stubbed(k, { ...runtime, name: 'Aria', memoryProvider: provider }));
    await a.session('s1', { userId: 'ana' }).send('Hi.');
    await vi.waitFor(() => expect(observed()).toHaveLength(2));
    expect(calls.map((call) => call.hook)).toEqual(['getContext', 'observe', 'observe']);
    for (const call of calls) {
      expect(call.context).toEqual({ sessionId: 's1', userId: 'ana', subject: { kind: 'user', id: 'ana' }, providerUserId: 'ana', agentId: 'aria', call: 'session' });
    }
  });

  it('a session opened with no user id: the session is the user and the subject', async () => {
    const k = key();
    script('openai', k, { whole: true, replies: [reply.text('Hello.')] });
    const { provider, calls, observed } = recorder();
    await agent(stubbed(k, { ...runtime, name: 'Aria', memoryProvider: provider })).session('s1').send('Hi.');
    await vi.waitFor(() => expect(observed()).toHaveLength(2));
    for (const call of calls) {
      expect(call.context).toEqual({ sessionId: 's1', userId: 's1', subject: { kind: 'session', id: 's1' }, agentId: 'aria', call: 'session' });
      expect(call.context).not.toHaveProperty('providerUserId');
    }
  });

  it("a session opened as 'system' is no user: the session is the subject, and one memory.anonymous_user line says so", async () => {
    const k = key();
    script('openai', k, { whole: true, replies: [reply.text('Hello.')] });
    const { provider, calls, observed } = recorder();
    await agent(stubbed(k, { ...runtime, name: 'Aria', memoryProvider: provider })).session('s1', { userId: 'system' }).send('Hi.');
    await vi.waitFor(() => expect(observed()).toHaveLength(2));
    for (const call of calls) expect(call.context).toMatchObject({ userId: 's1', subject: { kind: 'session', id: 's1' } });
    const lines = events('memory.anonymous_user');
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines[0])).not.toContain('s1');
  });

  it('generate() and stream() are one-shots: each call is its own session and subject', async () => {
    const k = key();
    script('openai', k, { whole: true, replies: [reply.text('One.'), reply.text('Two.')] });
    const { provider, calls, observed } = recorder();
    const a = agent(stubbed(k, { ...runtime, name: 'Aria', memoryProvider: provider }));
    await a.generate('Hi.');
    const streamed = a.stream('Hi again.');
    for await (const _part of streamed.textStream) { /* drain */ }
    await streamed.text;
    await vi.waitFor(() => expect(observed()).toHaveLength(4));
    const ids = new Set(calls.map((call) => call.context?.sessionId));
    expect([...ids].sort()).toEqual([expect.stringMatching(/^generate-/), expect.stringMatching(/^stream-/)]);
    for (const call of calls) {
      const id = call.context!.sessionId;
      expect(call.context).toEqual({ sessionId: id, userId: id, subject: { kind: 'session', id }, agentId: 'aria', call: 'one-shot' });
    }
  });

  it("names the agent by its soul's id when it has a soul", async () => {
    const k = key();
    script('openai', k, { whole: true, replies: [reply.text('Hello.')] });
    const { provider, calls, observed } = recorder();
    await agent(stubbed(k, { ...runtime, name: 'Support', soul: { content: '---\nagentId: aria-1\n---\nYou are Aria.' }, memoryProvider: provider })).session('s1').send('Hi.');
    await vi.waitFor(() => expect(observed()).toHaveLength(2));
    for (const call of calls) expect(call.context?.agentId).toBe('aria-1');
  });
});

describe('one session is one user on the default runtime', () => {
  it('opening an open session for another user throws; the same user, no user, and a closed session do not', async () => {
    const a = agent(stubbed(key()));
    const first = a.session('s1', { userId: 'ana' });
    expect(() => a.session('s1', { userId: 'ben' })).toThrow("agent(): session 's1' already runs as user 'ana'; close it to open it for another user.");
    expect(a.session('s1').id).toBe('s1');
    expect(a.session('s1', { userId: 'ana' }).id).toBe('s1');
    await first.close();
    expect(a.session('s1', { userId: 'ben' }).id).toBe('s1');
    // A session opened with no user runs as its own id.
    a.session('s2');
    expect(() => a.session('s2', { userId: 'ana' })).toThrow("agent(): session 's2' already runs as user 's2'; close it to open it for another user.");
    await a.close();
    expect(a.session('s2', { userId: 'ana' }).id).toBe('s2');
  });
});
