/**
 * agent({ runtime: 'gmi' }) end to end: sessions served by a GMI built
 * in-process from agent options, over the real provider manager, completion
 * gateway, prompt engine, tool orchestrator, cognitive memory and session
 * store. Only the provider classes are stubbed (helpers/stubProviders.ts), at
 * their module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
import { z } from 'zod';
import { agent, type AgentOptions } from '../agent';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { GMIErrorCode } from '../../core/utils/errors';
import { clearProviderPriority, setProviderPriority } from '../runtime/provider-priority';

let n = 0;
const key = () => `k-session-${++n}`;
const base = (apiKey: string, extra: Record<string, unknown> = {}) =>
  ({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [], ...extra }) as unknown as AgentOptions;
const lookupTool = (execute: (args: Record<string, unknown>) => Promise<unknown>) => ({ name: 'lookup', description: 'Look up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, execute });
/** Cognitive memory with no mechanisms, so recall depends on the scopes alone. */
const plainMemory = (embedding: Record<string, unknown> = { provider: 'openai' }) => ({ cognition: { memory: { embedding }, mechanisms: false } });
const FACT = 'The deploy key lives in the vault under ops/deploy.';
const QUESTION = 'Where does the deploy key live?';

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearProviderPriority();
});

describe("agent({ runtime: 'gmi' }) sessions", () => {
  it('send returns the reply with stop, usage from the trailing chunk and the provider', async () => {
    const k = key(); script('openai', k, { replies: [reply.text('Hello there.')] });
    const a = agent({ ...base(k), name: 'Greeter', instructions: 'Be brief.' });
    const r = await a.session('s').send('hi');
    expect(r).toMatchObject({ text: 'Hello there.', finishReason: 'stop', provider: 'openai', usage: { totalTokens: 15 } });
    await a.close();
  });

  it('a second send carries the first exchange, and messages() shows both turns', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('One.'), reply.text('Two.')] });
    const session = agent(base(k)).session('s');
    await session.send('first');
    await session.send('second');
    const second = s.seen[1].messages.filter((m) => m.role !== 'system').map((m) => m.content);
    expect(second).toEqual(['first', 'One.', 'second']);
    expect(session.messages().map((m) => m.content)).toEqual(['first', 'One.', 'second', 'Two.']);
  });

  it('stream yields deltas, resolves usage, and the next send sees the streamed turn', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('Streamed.'), reply.text('After.')] });
    const session = agent(base(k)).session('s');
    const r = session.stream('go');
    const deltas: string[] = [];
    for await (const t of r.textStream) deltas.push(t);
    expect(deltas).toEqual(['Streamed.']);
    expect((await r.usage).totalTokens).toBe(15);
    expect(await r.text).toBe('Streamed.');
    await session.send('next');
    expect(s.seen[1].messages.map((m) => m.content)).toContain('Streamed.');
  });

  it('runs a tool through the orchestrator: tool-result reaches fullStream, text is the final answer, the store keeps the tool round', async () => {
    const k = key(); script('openai', k, { replies: [reply.tools([{ id: 'c1', name: 'lookup', args: { q: 'x' } }], 'Let me check.'), reply.text('Found x.')] });
    const lookup = { ...lookupTool(async (args) => ({ success: true, output: { found: args.q } })), requiredCapabilities: ['capability:search'] };
    const session = agent(base(k, { tools: [lookup] })).session('s');
    const r = session.stream('find x');
    const parts: Array<{ type: string }> = [];
    for await (const p of r.fullStream) parts.push(p);
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool-call', 'tool-result', 'text']);
    expect(await r.text).toBe('Found x.');
    expect((await r.toolCalls)[0]).toMatchObject({ name: 'lookup', args: { q: 'x' }, result: { found: 'x' } });
    expect(session.messages()).toEqual([
      { role: 'user', content: 'find x' },
      { role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"found":"x"}' },
      { role: 'assistant', content: 'Found x.' },
    ]);
  });

  it('a tool-less agent sends no tools payload (the executor\'s built-in date tool is not offered)', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('ok')] });
    await agent(base(k)).session('s').send('hi');
    expect(s.seen[0].options.tools).toBeUndefined();
  });

  it('a send that asks for a tool choice on an agent with no tools sends none: OpenAI rejects tool_choice without tools', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('ok')] });
    await agent(base(k)).session('s').send('hi', { toolChoice: 'auto' });
    expect(s.seen[0].options.tools).toBeUndefined();
    expect(s.seen[0].options.toolChoice).toBeUndefined();
  });

  it('sends no temperature and no output budget unless the agent or the call sets one, as agent() does', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('ok'), reply.text('ok')] });
    const a = agent(base(k));
    await a.session('s').send('hi');
    expect(s.seen[0].options).not.toHaveProperty('temperature');
    expect(s.seen[0].options).not.toHaveProperty('maxTokens');
    await a.generate('hi', { temperature: 0.3, maxTokens: 64 });
    expect(s.seen[1].options).toMatchObject({ temperature: 0.3, maxTokens: 64 });
  });

  it("an agent tool named getCurrentDateTime is the one that runs, not the executor's built-in", async () => {
    const k = key(); script('openai', k, { replies: [reply.tools([{ id: 'c1', name: 'getCurrentDateTime', args: {} }]), reply.text('Noon.')] });
    const execute = vi.fn(async () => ({ success: true, output: 'noon' }));
    const r = await agent(base(k, { tools: { getCurrentDateTime: { description: 'The time.', parameters: { type: 'object', properties: {} }, execute } } })).session('s').send('time?');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(r.toolCalls[0]).toMatchObject({ name: 'getCurrentDateTime', result: 'noon' });
    expect(r.text).toBe('Noon.');
  });

  it('a structured send returns the object with tools suppressed, on OpenAI', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('{"city":"Lyon"}')] });
    const r = await agent(base(k, { tools: [lookupTool(async () => ({ success: true }))] })).session('s')
      .send('where?', { responseSchema: z.object({ city: z.string() }) });
    expect(r.object).toEqual({ city: 'Lyon' });
    expect(r.text).toBe('{"city":"Lyon"}');
    expect(s.seen[0].options.tools).toBeUndefined();
    expect(s.seen[0].options.responseFormat).toBeTruthy();
  });

  it('a structured send on an Anthropic model that takes a forced tool: the schema tool call becomes the object; preamble text stays text', async () => {
    const k = key(); const s = script('anthropic', k, { replies: [reply.schemaTool('answer', { city: 'Lyon' }, 'Here you go.')] });
    const session = agent({ ...base(k), provider: 'anthropic', model: 'claude-x' }).session('s');
    const r = await session.send('where?', { responseSchema: z.object({ city: z.string() }), schemaName: 'answer' });
    expect(r.object).toEqual({ city: 'Lyon' });
    expect(r.text).toBe('{"city":"Lyon"}');
    expect(r.finishReason).toBe('stop');
    expect(s.seen[0].options.responseFormat).toMatchObject({ _agentosUseToolForStructuredOutput: true });
    expect(session.messages().at(-1)).toEqual({ role: 'assistant', content: '{"city":"Lyon"}' });
  });

  it('a structured send on Claude Sonnet 5.5 (no forced tool): the JSON text answer is parsed', async () => {
    const k = key(); const s = script('anthropic', k, { replies: [reply.text('{"city":"Lyon"}')] });
    const r = await agent({ ...base(k), provider: 'anthropic', model: 'claude-sonnet-5-5' }).session('s')
      .send('where?', { responseSchema: z.object({ city: z.string() }) });
    expect(r.object).toEqual({ city: 'Lyon' });
    expect(s.seen[0].options.responseFormat).toBeUndefined();
  });

  it('generate keeps no history; close releases sessions', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('A.'), reply.text('B.')] });
    const a = agent(base(k));
    await a.generate('one');
    await a.generate('two');
    expect(s.seen[1].messages.filter((m) => m.role !== 'system').map((m) => m.content)).toEqual(['two']);
    const session = a.session('s');
    await a.close();
    expect(session.messages()).toEqual([]);
  });

  it('history: false keeps nothing between sends', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('One.'), reply.text('Two.')] });
    const session = agent(base(k, { history: false })).session('s');
    await session.send('first');
    await session.send('second');
    expect(s.seen[1].messages.filter((m) => m.role !== 'system').map((m) => m.content)).toEqual(['second']);
    expect(session.messages()).toEqual([]);
  });

  it('the code-word case: clear() leaves nothing of the earlier exchange in the next request', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('I do not know.')] });
    const session = agent(base(k, { cognition: 'full', memory: false })).session('s');
    await session.send('the code word is heron');
    session.clear();
    await session.send('what is the code word?');
    expect(JSON.stringify(s.seen[1].messages)).not.toContain('heron');
  });

  it('two concurrent sends on one session run one after the other', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('First.'), reply.text('Second.')] });
    const session = agent(base(k)).session('s');
    const [a, b] = await Promise.all([session.send('one'), session.send('two')]);
    expect([a.text, b.text]).toEqual(['First.', 'Second.']);
    expect(s.seen[1].messages.map((m) => m.content)).toContain('First.');
  });

  it('close() lets a running send finish but keeps it out of the history; the id starts empty', async () => {
    const k = key(); script('openai', k, { replies: [reply.text('Late.')] });
    const a = agent(base(k));
    const pending = a.session('s').send('one');
    await a.session('s').close();
    expect((await pending).text).toBe('Late.');
    expect(a.session('s').messages()).toEqual([]);
  });

  it('a clear while the turn waits for its memory context keeps that turn out of the history', async () => {
    const k = key(); script('openai', k, { replies: [reply.text('Late reply.')] });
    let releaseContext!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    const getContext = vi.fn(async (_text: string) => {
      await held;
      return null;
    });
    const session = agent(base(k, { memoryProvider: { getContext } })).session('s');
    const pending = session.send('first');
    await vi.waitFor(() => expect(getContext).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    session.clear();
    releaseContext();
    expect((await pending).text).toBe('Late reply.');
    expect(session.messages()).toEqual([]);
  });

  it('a provider error before any output: send rejects with the GMI code and the store keeps nothing', async () => {
    const k = key(); script('openai', k, { replies: [Object.assign(new Error('bad request'), { httpStatus: 400 })] });
    const session = agent(base(k)).session('s');
    await expect(session.send('go')).rejects.toMatchObject({ code: GMIErrorCode.LLM_PROVIDER_ERROR });
    expect(session.messages()).toEqual([]);
  });

  it('onBeforeToolExecution returning null skips the tool as agent() does; session.usage reports the turn', async () => {
    const k = key(); script('openai', k, { replies: [reply.tools([{ id: 'c1', name: 'lookup', args: {} }]), reply.text('Blocked.')] });
    const execute = vi.fn(async () => ({ success: true, output: 1 }));
    const session = agent(base(k, { tools: [lookupTool(execute)], onBeforeToolExecution: async () => null })).session('s');
    const r = await session.send('go');
    expect(execute).not.toHaveBeenCalled();
    expect(r.toolCalls[0].error).toBe('Skipped by onBeforeToolExecution hook');
    expect((await session.usage()).totalTokens).toBe(29);
  });

  it('onBeforeGeneration sees the prompt and can replace it; onAfterGeneration rewrites the text and the stored reply', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('raw text')] });
    const seen: Array<{ step: number; provider: string; model: string; prompt: string | undefined }> = [];
    const session = agent(base(k, {
      onBeforeGeneration: async (ctx: { messages: Array<{ role: string; content: unknown }>; step: number; provider: string; model: string; prompt: string | undefined }) => {
        seen.push({ step: ctx.step, provider: ctx.provider, model: ctx.model, prompt: ctx.prompt });
        return { ...ctx, messages: [...ctx.messages, { role: 'system', content: 'APPENDED' }] };
      },
      onAfterGeneration: async (res: { text: string }) => ({ ...res, text: res.text.toUpperCase() }),
    })).session('s');
    const r = await session.send('hi');
    expect(seen).toEqual([{ step: 0, provider: 'openai', model: 'stub-model', prompt: 'hi' }]);
    expect(s.seen[0].messages.at(-1)).toEqual({ role: 'system', content: 'APPENDED' });
    expect(r.text).toBe('RAW TEXT');
    expect(session.messages().at(-1)).toMatchObject({ role: 'assistant', content: 'RAW TEXT' });
  });

  it("memoryProvider: getContext text is its own system message after the agent's, observe runs for both sides", async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('Done.')] });
    const getContext = vi.fn(async (_text: string) => ({ contextText: 'RECALL: likes tea' }));
    const observe = vi.fn(async (_role: string, _text: string) => undefined);
    await agent(base(k, { instructions: 'Be brief.', memoryProvider: { getContext, observe } })).session('s').send('hi');
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(s.seen[0].messages.filter((m) => m.role === 'system').map((m) => m.content)).toEqual(['Be brief.', 'RECALL: likes tea']);
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
    expect(observe.mock.calls).toEqual([['user', 'hi'], ['assistant', 'Done.']]);
  });

  it('onFallback hears the move to a fallback hop, and one that throws does not fail that hop', async () => {
    const k = key(); const fb = key();
    script('anthropic', k, { initThrows: Object.assign(new Error('503 unavailable'), { httpStatus: 503 }) });
    script('openai', fb, { replies: [reply.text('From the fallback.')] });
    vi.stubEnv('OPENAI_API_KEY', fb);
    const onFallback = vi.fn((_error: Error, _provider: string) => {
      throw new Error('a listener bug');
    });
    const r = await agent({ ...base(k), provider: 'anthropic', model: 'claude-x', fallbackProviders: [{ provider: 'openai', model: 'stub-model' }], onFallback }).session('s').send('hi');
    expect(r).toMatchObject({ text: 'From the fallback.', provider: 'openai' });
    expect(onFallback).toHaveBeenCalledWith(expect.any(Error), 'openai');
  });

  it('close() leaves the tools the caller passed running', async () => {
    const k = key(); script('openai', k, { replies: [reply.text('ok')] });
    const shutdown = vi.fn(async () => undefined);
    const tool = { id: 'lookup-v1', name: 'lookup', description: 'Look up.', inputSchema: { type: 'object' }, execute: async () => ({ success: true }), shutdown };
    const a = agent(base(k, { tools: { lookup: tool } }));
    await a.session('s').send('hi');
    await a.close();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('options the GMI path cannot honour throw at construction, or at the call for a per-call override, naming the option', async () => {
    expect(() => agent({ ...base(key()), voice: { enabled: true } as never })).toThrow(/voice/);
    expect(() => agent({ ...base(key()), channels: { discord: { token: 'x' } } })).toThrow(/channels/);
    await expect(agent(base(key())).generate('hi', { system: 'other' } as never)).rejects.toThrow(/system/);
    expect(() => agent(base(key())).stream('hi', { messages: [] } as never)).toThrow(/messages/);
  });
});

describe("agent({ runtime: 'gmi' }) resolves the model and builds memory on first use", () => {
  it('construction reads no environment: the first call fails as agent() fails, and a key set before a call is used', async () => {
    // Only OPENAI_API_KEY is probed, so a CLI on the runner's PATH cannot answer.
    setProviderPriority(['openai']);
    vi.stubEnv('OPENAI_API_KEY', '');
    const early = agent({ runtime: 'gmi', fallbackProviders: [] });
    const later = agent({ runtime: 'gmi', fallbackProviders: [] });
    const legacyError = await agent({ fallbackProviders: [] }).generate('hi').then(() => undefined, (error: unknown) => error);
    expect(legacyError).toBeInstanceOf(Error);
    await expect(early.generate('hi')).rejects.toThrow((legacyError as Error).message);

    const k = key(); script('openai', k, { replies: [reply.text('From the environment.'), reply.text('Again.')] });
    vi.stubEnv('OPENAI_API_KEY', k);
    expect((await later.session('s').send('hi')).text).toBe('From the environment.');
    // The failed resolution was not kept: the agent that failed resolves now.
    expect((await early.generate('hi')).text).toBe('Again.');
  });

  it('memory checks that need the environment wait for the first call, which names memory.embedding; the others run at construction', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OLLAMA_BASE_URL', '');
    expect(() => agent(base(key(), { memory: { embedding: { provider: 'anthropic' } } }))).toThrow(/Anthropic has no embedding models/);
    expect(() => agent(base(key(), { memory: { embedding: { provider: 'ollama', model: 'mxbai-embed-large', dimension: 0 } } }))).toThrow(/positive integer/);
    expect(() => agent(base(key(), { memory: { embedding: { provider: 'ollama', model: 'mxbai-embed-large' } } }))).toThrow(/memory\.embedding\.dimension/);

    const k = key(); const s = script('openai', k, { replies: [reply.text('Hi.')] });
    const session = agent(base(k, { memory: true })).session('s');
    await expect(session.send('hi')).rejects.toThrow(/memory\.embedding/);
    expect(s.seen).toHaveLength(0);

    const emb = key(); const e = script('openai', emb);
    vi.stubEnv('OPENAI_API_KEY', emb);
    expect((await session.send('hi')).text).toBe('Hi.');
    expect(e.embedCalls).toBeGreaterThan(0);
  });

  it('a memory build that fails is not kept: the next send builds it again', async () => {
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [reply.text('Hello.')] });
    const e = script('openai', emb, { initThrows: Object.assign(new Error('503 upstream unavailable'), { httpStatus: 503 }) });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const session = agent(base(k, plainMemory())).session('s');
    await expect(session.send('hi')).rejects.toThrow(/memory\.embedding/);
    e.initThrows = undefined;
    expect((await session.send('hi')).text).toBe('Hello.');
    expect(e.embedCalls).toBeGreaterThan(0);
    expect(s.seen).toHaveLength(1);
  });

  it("each session's memory is its own unless sessions share a user id; closing one session leaves the shared memory to the others", async () => {
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('No idea.'), reply.text('Noted.'), reply.text('In the vault.')] });
    script('openai', emb);
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = agent(base(k, plainMemory()));

    await a.session('alice-1').send(FACT);
    await a.session('bob-1').send(QUESTION);
    expect(JSON.stringify(s.seen[1].messages)).not.toContain('vault');

    await a.session('carol-1', { userId: 'carol' }).send(FACT);
    expect(() => a.session('carol-1', { userId: 'mallory' })).toThrow(/already runs as user 'carol'/);
    await a.session('carol-1').close();
    await a.session('carol-2', { userId: 'carol' }).send(QUESTION);
    expect(JSON.stringify(s.seen[3].messages)).toContain('vault');
    await a.close();
  });

  it("a session's memory context names no memory of another session; sessions that share a user id still see each other's", async () => {
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: ['Noted.', 'Kept.', 'No idea.', 'Noted.', 'Kept.', 'In the vault.'].map((text) => reply.text(text)) });
    script('openai', emb);
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = agent(base(k, plainMemory()));
    /** The memory trace ids a request's prompt names: the active-context list of its memory block. */
    const traceIdsIn = (request: { messages: unknown }): string[] => JSON.stringify(request.messages).match(/mt_[0-9a-f-]{36}/g) ?? [];

    await a.session('alice-1').send(FACT);
    await a.session('alice-1').send('Keep that safe for me.');
    // Alice's second request lists the memories of her first exchange as her active context.
    expect(traceIdsIn(s.seen[1]).length).toBeGreaterThan(0);

    // Bob has no memories yet: his request names none, Alice's included.
    await a.session('bob-1').send(QUESTION);
    expect(traceIdsIn(s.seen[2])).toEqual([]);
    expect(JSON.stringify(s.seen[2].messages)).not.toContain('vault');

    // One user in two sessions: the second recalls the fact and names a memory of the first.
    await a.session('carol-1', { userId: 'carol' }).send(FACT);
    await a.session('carol-1').send('Keep that safe for me.');
    const carolIds = traceIdsIn(s.seen[4]);
    expect(carolIds.length).toBeGreaterThan(0);
    await a.session('carol-2', { userId: 'carol' }).send(QUESTION);
    expect(JSON.stringify(s.seen[5].messages)).toContain('vault');
    expect(traceIdsIn(s.seen[5]).some((id) => carolIds.includes(id))).toBe(true);
    await a.close();
  });
});

describe('agent() routes on runtime', () => {
  it("runtime: 'gmi' builds the agent on the GMI path, whose diagnostics name gmi(); runtime: 'legacy' keeps the helper's", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const warnings = (): string[] => warn.mock.calls.map(([message]) => String(message));

    agent({ ...base(key()), discovery: { enabled: true }, cognitiveMechanisms: {} });
    expect(warnings()).toContain('[AgentOS] gmi() accepted config it does not enforce yet: discovery.');
    expect(warnings().some((message) => message.includes('lightweight helper'))).toBe(false);

    warn.mockClear();
    agent({ ...base(key()), runtime: 'legacy', discovery: { enabled: true } });
    expect(warnings().some((message) => message.includes('lightweight helper'))).toBe(true);
    expect(warnings().some((message) => message.includes('gmi()'))).toBe(false);
  });
});
