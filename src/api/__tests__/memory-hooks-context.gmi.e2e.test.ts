/**
 * The memory hooks end to end: who they are told a turn serves, how often they run, and how recalled text reaches the
 * model. Runs over the real agent, GMI, generateText, streamText and provider manager; only the OpenAI provider class is
 * stubbed (helpers/stubProviders.ts), at its module boundary, and each model call's messages are read from the script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import pino from 'pino';
import { z } from 'zod';
import { agent, type AgentMemoryProvider, type AgentOptions, type MemoryHookContext } from '../agent';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { ObjectGenerationError } from '../generateObject';
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

const lookup = { name: 'lookup', description: 'Look up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, execute: async () => ({ found: true }) };

describe('how often the memory hooks run on the default runtime', () => {
  it('a turn with two tool steps recalls once and observes twice: the user text, and the reply the caller receives', async () => {
    const k = key();
    const s = script('openai', k, {
      whole: true,
      replies: [reply.tools([{ id: 'c1', name: 'lookup', args: { q: 'x' } }]), reply.tools([{ id: 'c2', name: 'lookup', args: { q: 'y' } }]), reply.text('Found both.')],
    });
    // A recalled text with no whitespace, so this case reads the same once recalled text is datamarked.
    const { provider, calls, observed } = recorder({ contextText: 'RECALL-likes-tea' });
    const r = await agent(stubbed(k, { tools: [lookup], memoryProvider: provider })).session('s1').send('Find x and y.');
    expect(r.text).toBe('Found both.');
    await vi.waitFor(() => expect(observed()).toHaveLength(2));
    expect(s.seen).toHaveLength(3);
    expect(calls.filter((call) => call.hook === 'getContext')).toHaveLength(1);
    expect(observed().map((call) => [call.role, call.text])).toEqual([['user', 'Find x and y.'], ['assistant', 'Found both.']]);
    // The one recall is in every step's request.
    for (const call of s.seen) expect(JSON.stringify(call.messages)).toContain('RECALL-likes-tea');
  });

  it('a structured send recalls once across its attempts and observes only the accepted result', async () => {
    const k = key();
    const schema = z.object({ count: z.number() });
    script('openai', k, { whole: true, replies: [reply.text('{"count":"two"}'), reply.text('{"count":2}'), reply.text('{"count":"three"}')] });
    const { provider, calls, observed } = recorder();
    const a = agent(stubbed(k, { memoryProvider: provider }));
    const r = await a.session('s1').send('Count.', { responseSchema: schema, maxValidationRetries: 1 });
    expect(r.object).toEqual({ count: 2 });
    await vi.waitFor(() => expect(observed()).toHaveLength(2));
    expect(calls.filter((call) => call.hook === 'getContext')).toHaveLength(1);
    expect(observed().map((call) => [call.role, call.text])).toEqual([['user', 'Count.'], ['assistant', '{"count":2}']]);
    await expect(a.session('s2').send('Count again.', { responseSchema: schema })).rejects.toBeInstanceOf(ObjectGenerationError);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(observed()).toHaveLength(2);
  });

  it('a session stream observes once its text has settled', async () => {
    const k = key();
    script('openai', k, { whole: true, replies: [reply.text('Streamed.')] });
    const { provider, observed } = recorder();
    const result = agent(stubbed(k, { memoryProvider: provider })).session('s1').stream('Hi.');
    for await (const _part of result.textStream) { /* drain */ }
    expect(await result.text).toBe('Streamed.');
    expect(observed().map((call) => [call.role, call.text])).toEqual([['user', 'Hi.'], ['assistant', 'Streamed.']]);
  });
});

describe('a memory hook that fails on the default runtime', () => {
  it('leaves the turn as it is and writes memory.hook_failed with no message: a throw, a timeout, and observe sparsely', async () => {
    const k = key();
    script('openai', k, { whole: true, replies: Array.from({ length: 7 }, (_, i) => reply.text(`Answer ${i}.`)) });
    const throwing: AgentMemoryProvider = { getContext: async () => { throw Object.assign(new Error('store down for ana'), { code: 'ECONNREFUSED' }); } };
    expect((await agent(stubbed(k, { memoryProvider: throwing })).generate('Hi.')).text).toBe('Answer 0.');
    const slow: AgentMemoryProvider = { getContext: () => new Promise(() => undefined) };
    expect((await agent(stubbed(k, { memoryProvider: slow, memoryProviderOptions: { timeoutMs: 20 } })).generate('Hi.')).text).toBe('Answer 1.');
    expect(events('memory.hook_failed')).toEqual([
      expect.objectContaining({ hook: 'getContext', type: 'Error', code: 'ECONNREFUSED' }),
      expect.objectContaining({ hook: 'getContext', type: 'TimeoutError', code: 'MEMORY_HOOK_TIMEOUT' }),
    ]);

    logged.length = 0;
    let failures = 0;
    const failing: AgentMemoryProvider = { observe: async () => { failures += 1; throw new Error('store down for ana'); } };
    const a = agent(stubbed(k, { memoryProvider: failing }));
    for (let i = 0; i < 5; i++) await a.generate(`turn ${i}`);
    await vi.waitFor(() => expect(failures).toBe(10));
    // The first failure and the tenth.
    await vi.waitFor(() => expect(events('memory.hook_failed')).toHaveLength(2));
    for (const line of events('memory.hook_failed')) expect(line).toMatchObject({ hook: 'observe', type: 'Error' });
    expect(JSON.stringify(logged)).not.toContain('store down');
  });
});
