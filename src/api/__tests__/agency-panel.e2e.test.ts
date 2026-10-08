/**
 * @file agency-panel.e2e.test.ts
 * Model pool, seating, strict credentials, redaction and the panel strategy,
 * driven through agency(), agent(), generateText, streamText and the real
 * Anthropic, OpenAI, Gemini and xAI provider classes with only fetch stubbed
 * (axios, which OpenRouter and Ollama send through, is forwarded to it).
 * OpenRouter and Ollama seats are in agency-panel-axios.e2e.test.ts.
 */
// @ts-nocheck -- the types this file imports land in Task 15 and the typed results in Task 23, which removes this line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// OpenRouter and Ollama send through axios, which does not use fetch. Forwarded to the stubbed fetch, a request to
// either is captured, and refused unless a test routes it; with the real axios, an Anthropic call rerouted to
// OpenRouter reaches the network and every "nothing reaches OpenRouter" check in this file passes regardless.
vi.mock('axios', () => {
  const respond = async (url: string, init: Record<string, unknown>) => {
    const res = (await (globalThis.fetch as (u: string, i: unknown) => Promise<Response>)(url, init)) as Response;
    const data = await res.json().catch(() => undefined);
    const out = { status: res.status, statusText: res.statusText, data, headers: Object.fromEntries(res.headers.entries()), config: { url } };
    if (res.status >= 400) { const err = Object.assign(new Error(`Request failed with status code ${res.status}`), { isAxiosError: true, response: out, config: { url } }); throw err; }
    return out;
  };
  const call = (base: string, baseHeaders: Record<string, string>, cfg: Record<string, any>) =>
    respond(`${base}${cfg.url ?? ''}`, { method: String(cfg.method ?? 'GET').toUpperCase(), headers: { ...baseHeaders, ...(cfg.headers ?? {}) }, body: cfg.data !== undefined ? JSON.stringify(cfg.data) : undefined });
  const create = (c: Record<string, any> = {}) => ({
    defaults: { baseURL: c.baseURL, headers: c.headers },
    request: (cfg: Record<string, any>) => call(c.baseURL ?? '', c.headers ?? {}, cfg),
    get: (url: string, cfg: Record<string, any> = {}) => call(c.baseURL ?? '', c.headers ?? {}, { ...cfg, url, method: 'GET' }),
    post: (url: string, data: unknown, cfg: Record<string, any> = {}) => call(c.baseURL ?? '', c.headers ?? {}, { ...cfg, url, data, method: 'POST' }),
  });
  const axios = Object.assign((cfg: Record<string, any>) => call('', {}, cfg), {
    create,
    get: (url: string, cfg: Record<string, any> = {}) => call('', {}, { ...cfg, url, method: 'GET' }),
    post: (url: string, data: unknown, cfg: Record<string, any> = {}) => call('', {}, { ...cfg, url, data, method: 'POST' }),
    isAxiosError: (e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError),
  });
  class AxiosError extends Error {}
  return { default: axios, isAxiosError: axios.isAxiosError, AxiosError };
});

// The CLI binary probe is deterministic in this file: a binary is on PATH only while a test lists it (hoisted, since vi.mock runs first).
const { binariesOnPath } = vi.hoisted(() => ({ binariesOnPath: new Set<string>() }));
vi.mock('../runtime/provider-defaults.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../runtime/provider-defaults.js')>();
  return { ...mod, isBinaryOnPathCached: (name: string) => binariesOnPath.has(name) };
});

import { agent } from '../agent.js';
import { agency } from '../agency.js';
import { hitl } from '../hitl.js';
import { exportAgentConfig, importAgent } from '../agentExport.js';
import { setDefaultProvider, clearDefaultProvider } from '../runtime/global-default.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import { OpenAIProviderError } from '../../core/llm/providers/errors/OpenAIProviderError.js';
import {
  AgencyConfigError, AgencyQuorumError, AgencyPanelError, AgencySeatingError,
  type Agent, type PanelResult, type AgencyResult, type ApprovalRequest, type ApprovalDecision,
} from '../types.js';

type Json = Record<string, any>;
type Captured = { url: string; init: RequestInit & { headers?: Record<string, string> }; body: Json | undefined };
type Handler = (req: Captured) => Response | Promise<Response>;

// ---- keys: every value is at least 8 characters, so the redactor masks it ----
const K = {
  ant: 'sk-ant-pool-00000001', oai: 'sk-oai-pool-00000002', gem: 'gem-pool-00000003', xai: 'xai-pool-00000004',
  antEnv: 'sk-ant-env-00000005', oaiEnv: 'sk-oai-env-00000006', gemEnv: 'gem-env-00000007', orEnv: 'sk-or-env-00000008',
  agency: 'sk-agency-level-0009', chair: 'sk-chair-0010', second: 'sk-second-key-0011', shortKey: 'k1', fixed: 'sk-fixed-seat-0012',
};
const ANTHROPIC = /api\.anthropic\.com\/v1\/messages/;
const OPENAI_LIST = /api\.openai\.com\/v1\/models/;
const OPENAI_CHAT = /api\.openai\.com\/v1\/chat\/completions/;
const OPENAI_RESP = /api\.openai\.com\/v1\/responses/;
const GEMINI = /generativelanguage\.googleapis\.com\/.*:generateContent/;
const XAI_LIST = /api\.x\.ai\/v1\/models/;
const XAI_CHAT = /api\.x\.ai\/v1\/chat\/completions/;
const OPENROUTER = /openrouter\.ai/;

// ---- responders ----
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const U = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const openaiListing = () => json({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }, { id: 'gpt-5.6-sol', object: 'model', created: 1, owned_by: 'openai' }] });
// A streamed chat request (`stream: true` in its body, as agent.stream() sends through streamText's native loop) reads
// its body as SSE only, so the OpenAI chat responders answer it in chunks, the shape agency-tool-approval.e2e.test.ts uses.
const oaiChunk = (model: string, delta: Json | null, finish: string | null = null, usage?: Json) =>
  ({ id: 'c', object: 'chat.completion.chunk', created: 1, model, choices: delta ? [{ index: 0, delta, finish_reason: finish }] : [], ...(usage ? { usage } : {}) });
const openaiText = (text: string, finish = 'stop', model = 'gpt-4.1') => (req?: Captured) =>
  req?.body?.stream === true
    ? sse([oaiChunk(model, { role: 'assistant', content: text }), oaiChunk(model, {}, finish), oaiChunk(model, null, null, U), '[DONE]'])
    : json({ id: 'c', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }], usage: U });
const openaiResponsesText = (text: string) => () =>
  json({ id: 'resp_1', object: 'response', created_at: 1, status: 'completed', model: 'gpt-5.6-sol', output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
const openaiError = (status: number, message: string) => () => json({ error: { message, type: 'server_error', code: null } }, status);
const openaiToolCall = (name: string, args: Json, id = 'call_1') => (req?: Captured) =>
  req?.body?.stream === true
    ? sse([
      oaiChunk('gpt-4.1', { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }),
      oaiChunk('gpt-4.1', { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }),
      oaiChunk('gpt-4.1', {}, 'tool_calls'),
      oaiChunk('gpt-4.1', null, null, U),
      '[DONE]',
    ])
    : json({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: U });
/** One `data:` line per event; a string event (`'[DONE]'`) is written as it is. */
function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const anthropicStart = (model = 'claude-opus-5-5') => ({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
const anthropicText = (text: string) => () =>
  sse([anthropicStart(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' }]);
const anthropicThinkingOnlyCut = () => () =>
  sse([anthropicStart(), { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking hard' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' }]);
const anthropicError = (status: number, message: string, type = 'overloaded_error') => () => json({ type: 'error', error: { type, message } }, status);
const geminiText = (text: string, finish = 'STOP') => () =>
  json({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: finish }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
const geminiError = (status: number, message: string, gstatus = 'INTERNAL') => () => json({ error: { code: status, message, status: gstatus } }, status);
const never = () => new Promise<Response>(() => {});
/** Hangs until the request's signal aborts, then rejects as fetch does; a `never` ignores the abort and the provider never sees a timeout. */
const abortable: Handler = ({ init }) => new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });

// ---- routing with per-pattern queues (the last handler repeats) ----
function route(table: Array<[RegExp, Handler | Handler[]]>): void {
  const queues = table.map(([, h]) => (Array.isArray(h) ? [...h] : [h]));
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const i = table.findIndex(([p]) => p.test(u));
    if (i === -1) throw new Error(`unexpected request ${init?.method ?? 'GET'} ${u}`);
    const q = queues[i];
    const h = q.length > 1 ? q.shift()! : q[0];
    let body: Json | undefined;
    try { body = init?.body ? (JSON.parse(String(init.body)) as Json) : undefined; } catch { body = undefined; }
    return h({ url: u, init: (init ?? {}) as Captured['init'], body });
  });
}
const calls = (p: RegExp, method?: string): Captured[] =>
  fetchMock.mock.calls
    .filter(([u, init]) => p.test(String(u)) && (method === undefined || ((init as RequestInit)?.method ?? 'GET') === method))
    .map(([u, init]) => { let body: Json | undefined; try { body = (init as RequestInit)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined; } catch { body = undefined; } return { url: String(u), init: (init ?? {}) as Captured['init'], body }; });
const header = (c: Captured, name: string) => (c.init.headers ?? {})[name] ?? (c.init.headers ?? {})[name.toLowerCase()];
const threeProviders = (texts = { opus: 'A finds a bug', astra: 'B finds a bug', gemini: 'C finds a bug' }, chairText = 'Merged findings') =>
  route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText(texts.astra)], [ANTHROPIC, [anthropicText(texts.opus), anthropicText(chairText)]], [GEMINI, geminiText(texts.gemini)]]);

const POOL = () => ({
  opus: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: K.ant },
  astra: { provider: 'openai', model: 'gpt-4.1', apiKey: K.oai },
  gemini: { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: K.gem },
});
const SEATS = () => ({ correctness: { instructions: 'Find logic errors.' }, security: { instructions: 'Find security defects.' }, failure: { instructions: 'Find silent failures.' } });
const panel = (extra: Json = {}) => agency({ strategy: 'panel', modelPool: POOL(), agents: SEATS(), chair: { from: ['opus'], instructions: 'Merge.' }, ...extra } as never);

beforeEach(() => { fetchMock.mockReset(); globalLLMProviderHealth.reset(); });
afterEach(() => { vi.unstubAllEnvs(); clearDefaultProvider(); vi.useRealTimers(); });

describe('1-2. seats, chair and the ledger', () => {
  it('three pooled seats answer and the chair synthesizes', async () => {
    threeProviders();
    const result = await panel().generate('review this change');
    const bySeat = Object.fromEntries(result.seats.map((s) => [s.seat, s]));
    expect(bySeat.correctness).toMatchObject({ status: 'ok', entry: 'opus', provider: 'anthropic', model: 'claude-opus-5-5', vendor: 'anthropic' });
    expect(bySeat.security).toMatchObject({ status: 'ok', entry: 'astra', provider: 'openai', model: 'gpt-4.1', vendor: 'openai' });
    expect(bySeat.failure).toMatchObject({ status: 'ok', entry: 'gemini', provider: 'gemini', model: 'gemini-2.5-flash', vendor: 'google' });
    expect(result.seating).toMatchObject({ policy: 'preferred', distinct: 'vendor', call: 0, available: ['opus', 'astra', 'gemini'], skipped: [] });
    expect(result.text).toBe('Merged findings');
    expect(result.chair).toMatchObject({ status: 'ok', entry: 'opus', provider: 'anthropic' });
    const chairBody = calls(ANTHROPIC, 'POST')[1].body!;
    const chairInput = JSON.stringify(chairBody.messages) + JSON.stringify(chairBody.system ?? '');
    for (const name of ['correctness', 'security', 'failure']) expect(chairInput).toContain(name);
    for (const word of ['claude', 'gpt-4.1', 'gemini', 'anthropic', 'openai', 'google']) expect(chairInput.toLowerCase()).not.toContain(word);
    expect(result.agentCalls.map((c) => [c.agent, c.provider, c.model])).toEqual([['correctness', 'anthropic', 'claude-opus-5-5'], ['security', 'openai', 'gpt-4.1'], ['failure', 'gemini', 'gemini-2.5-flash']]);
    expect(result.usage.totalTokens).toBe(60);
    expect(result.quorum).toEqual({ met: true, healthy: 3, providers: ['anthropic', 'openai', 'gemini'], vendors: ['anthropic', 'openai', 'google'] });
  });

  it('a thinking-only reply cut at the cap is empty, counted, and kept from the chair', async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, [anthropicThinkingOnlyCut(), anthropicText('Merged')]], [GEMINI, geminiText('C')]]);
    const result = await panel().generate('review');
    const opusSeat = result.seats.find((s) => s.entry === 'opus')!;
    expect(opusSeat).toMatchObject({ status: 'empty', finishReason: 'length', text: '' });
    expect(opusSeat.usage?.totalTokens).toBe(15);
    expect(result.quorum.met).toBe(true);
    expect(JSON.stringify(calls(ANTHROPIC, 'POST')[1].body!.messages)).not.toContain('correctness');
    expect(result.usage.totalTokens).toBe(60);
  });
});

describe('3. quorum failures keep the ledger and the bill', () => {
  it('two seats on 500 reject with AgencyQuorumError carrying seats and usage, and no request goes elsewhere', async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(500, 'down')], [ANTHROPIC, anthropicText('A')], [GEMINI, geminiError(500, 'down')]]);
    // 15 tokens billed by the failed run; the next call's pre-check compares them against the limit, so the limit sits below them.
    const team = panel({ controls: { maxTotalTokens: 10, onLimitReached: 'error' } });
    const err = await team.generate('review').catch((e) => e);
    expect(err).toBeInstanceOf(AgencyQuorumError);
    expect(err.seats).toHaveLength(3);
    expect(err.usage.totalTokens).toBe(15);
    expect(fetchMock.mock.calls.every(([u]) => !OPENROUTER.test(String(u)))).toBe(true);
    await expect(team.generate('again')).rejects.toThrow(/Token limit exceeded/);
  });
  it("the floor of two holds with quorum: { onShortfall: 'error' } and no minAgents", async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(500, 'down')], [ANTHROPIC, anthropicText('A')], [GEMINI, geminiError(500, 'down')]]);
    await expect(panel({ quorum: { onShortfall: 'error' } }).generate('review')).rejects.toBeInstanceOf(AgencyQuorumError);
  });
  it('a run that breaches maxTotalTokens throws the limit error and the next pre-check sees the spend', async () => {
    threeProviders();
    const team = panel({ controls: { maxTotalTokens: 30, onLimitReached: 'error' } });
    await expect(team.generate('review')).rejects.toThrow(/Token limit exceeded/);
    expect((await team.usage()).totalTokens).toBe(60); // three seats and the chair, 15 each, counted before the limit check threw
    await expect(team.generate('again')).rejects.toThrow(/Token limit exceeded/);
    expect(calls(ANTHROPIC, 'POST')).toHaveLength(2);
  });
});

describe('4. the per-call guard', () => {
  // The third column is the "present with the value undefined" variant: for customModelParams it is `{ model: undefined }`, since the guard inspects the inner object (spec test 4 as folded in draft 9).
  const denied: Array<[string, unknown, unknown]> = [['model', 'gpt-4.1', undefined], ['provider', 'openai', undefined], ['apiKey', 'x', undefined], ['fallbackProviders', [], undefined], ['customModelParams', { model: 'x' }, { model: undefined }]];
  it.each(denied)('under panel and under a pooled sequential agency, %s rejects, also as undefined, with no request', async (key, value, undefinedVariant) => {
    threeProviders();
    for (const team of [panel(), agency({ modelPool: POOL(), agents: SEATS(), strategy: 'sequential' } as never)]) {
      for (const v of [value, undefinedVariant]) {
        await expect(team.generate('x', { [key]: v })).rejects.toBeInstanceOf(AgencyConfigError);
        expect(() => team.stream('x', { [key]: v })).toThrow(AgencyConfigError);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('the panel allow list', async () => {
    threeProviders();
    const team = panel();
    for (const opts of [{ system: 's' }, { messages: [] }, { tools: {} }, { toolMode: 'prompt' }, { onBeforeGeneration: async () => {} }, { customModelParams: { system: 's' } }]) {
      await expect(team.generate('x', opts)).rejects.toBeInstanceOf(AgencyConfigError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    const ok = await team.generate('x', { temperature: 0.2 });
    expect(ok.seating.call).toBe(0);
    const seq = agency({ modelPool: POOL(), agents: { one: { instructions: 'a' } }, strategy: 'sequential' } as never);
    await expect(seq.generate('x', { system: 'allowed outside panel' })).resolves.toBeTruthy();
  });
  it('a session send on a panel is not rejected, and a rejected call moves neither the rotation nor the call number', async () => {
    threeProviders();
    const team = panel({ seating: { policy: 'round-robin' } });
    await expect(team.generate('x', { apiKey: 'x' })).rejects.toBeInstanceOf(AgencyConfigError);
    const r = (await (team.session('s') as { send: (t: string) => Promise<PanelResult> }).send('hello')) as PanelResult;
    expect(r.seating.call).toBe(0);
  });
});

describe('5. no chair', () => {
  it('chair: false makes no chair request; text is the labelled block', async () => {
    threeProviders();
    const result = await agency({ strategy: 'panel', modelPool: POOL(), agents: SEATS(), chair: false } as never).generate('review');
    expect(calls(ANTHROPIC, 'POST')).toHaveLength(1);
    expect(result.text).toBe('--- correctness ---\nA finds a bug\n\n--- security ---\nB finds a bug\n\n--- failure ---\nC finds a bug');
    expect(result.chair).toBeUndefined();
  });
});

describe('6. deadlines (fake timers)', () => {
  it('a seat that never answers is timeout; its request was aborted; the breaker stays closed; a late rejection is swallowed', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn(); process.on('unhandledRejection', unhandled);
    const onError = vi.fn();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, ({ init }) => new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); })], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('C')]]);
    const team = panel({ panel: { seatDeadlineMs: 1_000 }, on: { error: onError } });
    const pending = team.generate('review');
    await vi.advanceTimersByTimeAsync(999);
    expect(calls(OPENAI_CHAT)[0].init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;
    expect(result.seats.find((s) => s.entry === 'astra')).toMatchObject({ status: 'timeout' });
    expect(calls(OPENAI_CHAT)[0].init.signal?.aborted).toBe(true);
    expect(globalLLMProviderHealth.isOpen('openai')).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });
  it('concurrency 1 starts the next seat when the first times out', async () => {
    vi.useFakeTimers();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, never], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('C')]]);
    const team = agency({ strategy: 'panel', modelPool: { astra: POOL().astra, opus: POOL().opus, gemini: POOL().gemini }, agents: SEATS(), chair: { from: ['opus'] }, panel: { seatDeadlineMs: 500, concurrency: 1 } } as never);
    const pending = team.generate('review');
    await vi.advanceTimersByTimeAsync(10);
    expect(calls(ANTHROPIC, 'POST')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls(ANTHROPIC, 'POST')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;
    expect(result.seats.map((s) => s.status).sort()).toEqual(['ok', 'ok', 'timeout']);
  });
  it('a beforeAgent handler that never resolves times out its seat and a late approval starts no request; a slow gate leaves only the time left; five such timeouts leave the breaker closed', async () => {
    vi.useFakeTimers();
    let release: (d: ApprovalDecision) => void = () => {};
    const handler = (r: ApprovalRequest) => (r.agent === 'security' ? new Promise<ApprovalDecision>((res) => { release = res; }) : new Promise<ApprovalDecision>((res) => setTimeout(() => res({ approved: true }), 300)));
    // OpenAI requests reject on abort, so each timed-out seat's provider error surfaces and would count against the breaker without the deadline flag.
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, abortable], [ANTHROPIC, anthropicText('Merged')], [GEMINI, never]]);
    const seats = { s1: { instructions: 'a' }, s2: { instructions: 'b' }, s3: { instructions: 'c' }, s4: { instructions: 'd' }, s5: { instructions: 'e' }, security: { instructions: 'f', from: ['gemini'] } };
    const team = agency({ strategy: 'panel', modelPool: { astra: POOL().astra, opus: POOL().opus, gemini: POOL().gemini }, seating: { distinct: false }, agents: seats, chair: { from: ['opus'] }, quorum: { minAgents: 0 }, panel: { seatDeadlineMs: 1_000 },
      hitl: { approvals: { beforeAgent: ['s1', 's2', 's3', 's4', 's5', 'security'] }, handler, guardrailOverride: false } } as never);
    const pending = team.generate('review');
    await vi.advanceTimersByTimeAsync(300);
    const first = calls(OPENAI_CHAT)[0];
    expect(first).toBeDefined();
    await vi.advanceTimersByTimeAsync(698);
    expect(first.init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(3);
    expect(first.init.signal?.aborted).toBe(true);
    release({ approved: true });
    // The late approval starts no request: the security seat's only candidate is gemini, which is never called.
    await vi.advanceTimersByTimeAsync(10);
    expect(calls(GEMINI).length).toBe(0);
    const result = await pending.catch((e) => e);
    expect(result.seats.find((s: Json) => s.seat === 'security').status).toBe('timeout');
    expect(result.seats.filter((s: Json) => s.status === 'timeout')).toHaveLength(6);
    // Each aborted request surfaces REQUEST_TIMEOUT once the provider's own retries end (five of them, the breaker's
    // transient threshold); under __panelDeadline none is recorded.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls(GEMINI).length).toBe(0);
    expect(globalLLMProviderHealth.isOpen('openai')).toBe(false);
  });
  it('a late beforeAgent approval after the seat timed out fires no approvalDecided, guardrailResult or guardrailHitlOverride, starts no request and adds nothing to the next call trail', async () => {
    vi.useFakeTimers();
    let asked = 0;
    let release: (d: ApprovalDecision) => void = () => {};
    const handler = () => (++asked === 1 ? new Promise<ApprovalDecision>((res) => { release = res; }) : Promise.resolve({ approved: true }));
    const events: string[] = [];
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, never], [ANTHROPIC, anthropicText('A')]]);
    const team = agency({ strategy: 'panel', modelPool: { astra: POOL().astra, opus: POOL().opus }, agents: { gated: { instructions: 'x', from: ['astra'] }, other: { instructions: 'y', from: ['opus'] } }, chair: false, quorum: { minAgents: 1 }, panel: { seatDeadlineMs: 500 }, provenance: { enabled: true },
      hitl: { approvals: { beforeAgent: ['gated'] }, handler },
      on: { approvalDecided: () => events.push('decided'), guardrailResult: () => events.push('guardrail'), guardrailHitlOverride: () => events.push('override'), error: () => events.push('error') } } as never);
    // The prompt trips code-safety, so a live approval would fire approvalDecided, then guardrailResult and guardrailHitlOverride.
    const pending = team.generate('please shutdown the host');
    await vi.advanceTimersByTimeAsync(600);
    const r = await pending;
    expect(r.seats.find((s) => s.seat === 'gated')).toMatchObject({ status: 'timeout' });
    expect(events).toEqual(['error']);
    release({ approved: true });
    await vi.advanceTimersByTimeAsync(100);
    // Settled: the gate's notifications are dropped (C9) and no request starts.
    expect(events).toEqual(['error']);
    expect(calls(OPENAI_CHAT, 'POST')).toHaveLength(0);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, anthropicText('A')]]);
    const r2 = await team.generate('review');
    expect(r2.seats.find((s) => s.seat === 'gated')).toMatchObject({ status: 'ok' });
    const trail = r2.provenanceTrail!;
    expect(trail.events.filter((e) => e.kind === 'approvalDecided')).toHaveLength(1);
    expect(JSON.stringify(trail)).not.toContain('destructive pattern');
    vi.useRealTimers();
  });
  it('a chair that never answers throws AgencyPanelError with the seats attached', async () => {
    vi.useFakeTimers();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, [anthropicText('A'), never]], [GEMINI, geminiText('C')]]);
    const pending = panel({ panel: { seatDeadlineMs: 5_000, chairDeadlineMs: 1_000 } }).generate('review').catch((e) => e);
    await vi.advanceTimersByTimeAsync(1_100);
    const err = await pending;
    expect(err).toBeInstanceOf(AgencyPanelError);
    expect(err.seats).toHaveLength(3);
    expect(err.usage.totalTokens).toBe(45);
  });
});

describe('7. keys on the first call', () => {
  it('an anthropic entry with only OPENROUTER_API_KEY, and one with an empty key, are skipped; nothing reaches OpenRouter', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', K.orEnv);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [GEMINI, geminiText('C')]]);
    const result = await agency({ strategy: 'panel', modelPool: { opus: { provider: 'anthropic', model: 'claude-opus-5-5' }, blank: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: '' }, astra: POOL().astra, gemini: POOL().gemini }, agents: SEATS(), chair: { from: ['astra'] } } as never).generate('review');
    expect(result.seating.skipped).toEqual([{ entry: 'opus', reason: 'no key (ANTHROPIC_API_KEY)' }, { entry: 'blank', reason: 'no key (ANTHROPIC_API_KEY)' }]);
    expect(fetchMock.mock.calls.every(([u]) => !OPENROUTER.test(String(u)))).toBe(true);
  });
  it("an agency-level key and URL serve the chair only; a nameless setDefaultProvider reaches no seat and not the chair", async () => {
    setDefaultProvider({ apiKey: 'sk-nameless-default-0013', baseUrl: 'https://nameless.example/v1' });
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, anthropicText('A')], [GEMINI, geminiText('C')], [/chairproxy\.example\/v1\/chat\/completions/, openaiText('Merged')], [/chairproxy\.example\/v1\/models/, openaiListing]]);
    const result = await agency({ strategy: 'panel', provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, baseUrl: 'https://chairproxy.example/v1', modelPool: POOL(), agents: SEATS() } as never).generate('review');
    expect(result.text).toBe('Merged');
    const ant = calls(ANTHROPIC, 'POST')[0];
    expect(ant.url).toMatch(/^https:\/\/api\.anthropic\.com/);
    expect(header(ant, 'x-api-key')).toBe(K.ant);
    expect(header(calls(/chairproxy/, 'POST')[0], 'Authorization')).toBe(`Bearer ${K.chair}`);
    expect(fetchMock.mock.calls.every(([u]) => !/nameless\.example/.test(String(u)))).toBe(true);
    expect(JSON.stringify(fetchMock.mock.calls.map(([, i]) => (i as RequestInit).headers))).not.toContain('sk-nameless-default-0013');
  });
  it('a fixed seat on another provider with no key is unseated under panel; a provider-only fixed seat runs on that provider default model', async () => {
    vi.stubEnv('XAI_API_KEY', K.xai);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('C')], [XAI_LIST, openaiListing], [XAI_CHAT, openaiText('Grok view', 'stop', 'grok-2')]]);
    const result = await panel({ agents: { ...SEATS(), nokey: { provider: 'mistral', model: 'mistral-large-latest', instructions: 'x' }, grok: { provider: 'xai', instructions: 'x' } }, quorum: { minAgents: 2 } }).generate('review');
    expect(result.seats.find((s) => s.seat === 'nokey')).toMatchObject({ status: 'unseated', error: 'no key (MISTRAL_API_KEY)' });
    expect(result.seats.find((s) => s.seat === 'grok')).toMatchObject({ status: 'ok', provider: 'xai', model: 'grok-2', vendor: 'xai' });
    expect(calls(XAI_CHAT, 'POST')[0].body!.model).toBe('grok-2');
  });
});

describe('8. keys on a hop', () => {
  it('a fixed seat in a pooled sequential agency fails over along the default chain with each hop provider env key, never the nameless default', async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    vi.stubEnv('GEMINI_API_KEY', K.gemEnv);
    setDefaultProvider({ apiKey: 'sk-nameless-default-0013' });
    route([[GEMINI, geminiError(529, 'overloaded', 'UNAVAILABLE')], [OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('from openai')], [OPENAI_RESP, openaiResponsesText('from openai')]]);
    const team = agency({ modelPool: { astra: POOL().astra }, agents: { fixed: { provider: 'gemini', model: 'gemini-2.5-flash', instructions: 'x' } }, strategy: 'sequential' } as never);
    const result = await team.generate('go');
    expect(result.text).toBe('from openai');
    expect(header(calls(GEMINI, 'POST')[0], 'x-goog-api-key')).toBe(K.gemEnv);
    const oai = calls(OPENAI_CHAT, 'POST')[0] ?? calls(OPENAI_RESP, 'POST')[0];
    expect(header(oai, 'Authorization')).toBe(`Bearer ${K.oaiEnv}`);
    expect(JSON.stringify(fetchMock.mock.calls.map(([, i]) => (i as RequestInit).headers))).not.toContain('sk-nameless-default-0013');
    expect(result.agentCalls[0]).toMatchObject({ provider: 'openai' });
    expect(result.agentCalls[0].fallback?.fired).toBe(true);
  });
  it('an Anthropic hop with no Anthropic key is dropped from a fixed seat chain and nothing goes to OpenRouter', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', K.orEnv);
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(529, 'overloaded')]]);
    const team = agency({ modelPool: { gemini: POOL().gemini }, agents: { fixed: { provider: 'openai', model: 'gpt-4.1', instructions: 'x', fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }] } }, strategy: 'sequential' } as never);
    await expect(team.generate('go')).rejects.toThrow();
    expect(fetchMock.mock.calls.every(([u]) => !OPENROUTER.test(String(u)) && !ANTHROPIC.test(String(u)))).toBe(true);
  });
  it("under panel a fixed seat's own chain carries the keys the resolver wrote; a keyless hop is dropped and listed; the record carries fallback", async () => {
    vi.stubEnv('GEMINI_API_KEY', K.gemEnv);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(529, 'overloaded')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('rescued')]]);
    const result = await agency({ strategy: 'panel', modelPool: { opus: POOL().opus }, agents: { pooled: { instructions: 'a' }, fixed: { provider: 'openai', model: 'gpt-4.1', apiKey: K.fixed, instructions: 'x', fallbackProviders: [{ provider: 'mistral', model: 'mistral-large-latest' }, { provider: 'gemini', model: 'gemini-2.5-flash' }] } }, chair: { from: ['opus'] } } as never).generate('review');
    const fixed = result.seats.find((s) => s.seat === 'fixed')!;
    expect(fixed).toMatchObject({ status: 'ok', provider: 'gemini', text: 'rescued' });
    expect(fixed.fallback?.fired).toBe(true);
    expect(header(calls(GEMINI, 'POST')[0], 'x-goog-api-key')).toBe(K.gemEnv);
    expect(result.seating.skipped).toContainEqual({ entry: 'fixed/fallbackProviders/0', reason: 'no key (MISTRAL_API_KEY)' });
  });
  it("after a native hop the fixed seat's record carries the answering leg's vendor, not the primary's: an Anthropic seat answered by its OpenAI hop is openai", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('from the hop')], [ANTHROPIC, anthropicError(529, 'overloaded')], [GEMINI, geminiText('C')]]);
    const r = await agency({ strategy: 'panel', modelPool: { gemini: POOL().gemini }, agents: { pooled: { instructions: 'a' }, fixed: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: K.fixed, instructions: 'x', fallbackProviders: [{ provider: 'openai', model: 'gpt-4.1' }] } }, chair: false, quorum: { minAgents: 1 } } as never).generate('review');
    const fixed = r.seats.find((s) => s.seat === 'fixed')!;
    expect(fixed).toMatchObject({ status: 'ok', provider: 'openai', model: 'gpt-4.1', vendor: 'openai', text: 'from the hop' });
    expect(fixed.fallback?.fired).toBe(true);
    expect(header(calls(OPENAI_CHAT, 'POST')[0], 'Authorization')).toBe(`Bearer ${K.oaiEnv}`);
    expect(r.quorum.vendors).toEqual(expect.arrayContaining(['google', 'openai']));
    expect(r.quorum.vendors).not.toContain('anthropic');
  });
  it("a hop on a custom URL is an unknown vendor unless the hop declares one: an Anthropic seat answered by an OpenAI-compatible proxy serving Llama has no vendor and does not meet minVendors beside an OpenAI seat; with vendor 'meta' on the hop the record says meta", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const PROXY_LIST = /proxy\.local\/v1\/models/;
    const PROXY_CHAT = /proxy\.local\/v1\/chat\/completions/;
    const proxyListing = () => json({ object: 'list', data: [{ id: 'llama-3.1-70b', object: 'model', created: 1, owned_by: 'meta' }] });
    const build = (hop: Json) => agency({ strategy: 'panel', modelPool: { astra: POOL().astra }, agents: { pooled: { instructions: 'a', from: ['astra'] }, fixed: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: K.fixed, instructions: 'x', fallbackProviders: [hop] } }, chair: false, quorum: { minAgents: 2, minVendors: 2 } } as never);
    // The pre-fold code gave the hop's provider maker ('openai') here; the fold reads the hop's resolved URL, so the vendor is unknown (spec section 5).
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('O')], [PROXY_LIST, proxyListing], [PROXY_CHAT, openaiText('from the proxy')], [ANTHROPIC, anthropicError(529, 'overloaded')]]);
    const err = await build({ provider: 'openai', model: 'llama-3.1-70b', baseUrl: 'https://proxy.local/v1' }).generate('review').catch((e) => e);
    expect(err).toBeInstanceOf(AgencyQuorumError);
    const fixed = err.seats.find((s: Json) => s.seat === 'fixed');
    expect(fixed).toMatchObject({ status: 'ok', provider: 'openai', model: 'llama-3.1-70b', text: 'from the proxy' });
    expect(fixed.vendor).toBeUndefined();
    expect(fixed.fallback?.fired).toBe(true);
    expect(err.quorum.healthy).toBe(2);
    expect(err.quorum.vendors).toEqual(['openai']);
    expect(calls(PROXY_CHAT, 'POST')).toHaveLength(1);
    expect(header(calls(PROXY_CHAT, 'POST')[0], 'Authorization')).toBe(`Bearer ${K.oaiEnv}`);
    // The same hop with a declared vendor: the record says meta and the vendor quorum is met.
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('O')], [PROXY_LIST, proxyListing], [PROXY_CHAT, openaiText('from the proxy')], [ANTHROPIC, anthropicError(529, 'overloaded')]]);
    const r = await build({ provider: 'openai', model: 'llama-3.1-70b', baseUrl: 'https://proxy.local/v1', vendor: 'meta' }).generate('review');
    expect(r.seats.find((s) => s.seat === 'fixed')).toMatchObject({ status: 'ok', provider: 'openai', model: 'llama-3.1-70b', vendor: 'meta' });
    expect(r.quorum).toMatchObject({ met: true, vendors: expect.arrayContaining(['openai', 'meta']) });
  });
  it('a claude-code-cli hop is kept when the binary probe passes and dropped as binary not found when it fails', async () => {
    const build = () => agency({ strategy: 'panel', modelPool: { opus: POOL().opus }, agents: { pooled: { instructions: 'a' }, fixed: { provider: 'openai', model: 'gpt-4.1', apiKey: K.fixed, instructions: 'x', fallbackProviders: [{ provider: 'claude-code-cli', model: 'claude-sonnet-4-6' }] } }, chair: { from: ['opus'] } } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]]]);
    const dropped = await build().generate('review');
    expect(dropped.seating.skipped).toContainEqual({ entry: 'fixed/fallbackProviders/0', reason: 'binary not found (claude)' });
    binariesOnPath.add('claude');
    try {
      route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]]]);
      const kept = await build().generate('review');
      expect(kept.seating.skipped).toEqual([]);
      expect(kept.seats.find((s) => s.seat === 'fixed')).toMatchObject({ status: 'ok', provider: 'openai' });
    } finally { binariesOnPath.delete('claude'); }
  });
  it("a fixed seat's Ollama hop with a URL and no key is kept: the availability rule, not a key, decides", async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]]]);
    const r = await agency({ strategy: 'panel', modelPool: { opus: POOL().opus }, agents: { pooled: { instructions: 'a' }, fixed: { provider: 'openai', model: 'gpt-4.1', apiKey: K.fixed, instructions: 'x', fallbackProviders: [{ provider: 'ollama', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434' }] } }, chair: { from: ['opus'] } } as never).generate('review');
    expect(r.seating.skipped).toEqual([]);
    expect(r.seats.find((s) => s.seat === 'fixed')).toMatchObject({ status: 'ok', provider: 'openai' });
  });
  it('a pooled seat that sets fallbackProviders fails construction', () => {
    expect(() => agency({ strategy: 'panel', modelPool: POOL(), agents: { a: { instructions: 'x', fallbackProviders: [] } }, chair: { from: ['opus'] } } as never)).toThrow(AgencyConfigError);
  });
});

describe('9. substitution', () => {
  it('a Gemini seat answered from the retired-id alias reports responseModel and substituted', async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [/models\/gemini-3\.1-pro-preview:generateContent/, geminiError(404, 'no longer available', 'NOT_FOUND')], [/models\/gemini-pro-latest:generateContent/, geminiText('C')]]);
    const result = await agency({ strategy: 'panel', modelPool: { ...POOL(), gemini: { provider: 'gemini', model: 'gemini-3.1-pro-preview', apiKey: K.gem } }, agents: SEATS(), chair: { from: ['opus'] } } as never).generate('review');
    expect(result.seats.find((s) => s.entry === 'gemini')).toMatchObject({ status: 'ok', model: 'gemini-3.1-pro-preview', responseModel: 'gemini-pro-latest', substituted: true, vendor: 'google' });
  });
});

describe('10-12. vendors, shortfalls, truncation and pre-built seats', () => {
  const groq = { provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: 'gsk-groq-00000014' };
  const together = { provider: 'together', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', apiKey: 'tog-together-00000015', vendor: 'Meta' };
  it('vendor quorum validation at construction', () => {
    expect(() => agency({ strategy: 'panel', modelPool: { g: groq }, agents: { a: { instructions: 'x' }, b: { instructions: 'y' } }, chair: false, quorum: { minVendors: 1 } } as never)).toThrow(/vendor/);
    expect(() => agency({ strategy: 'panel', modelPool: { g: { ...groq, vendor: 'meta' }, t: together }, agents: { a: { instructions: 'x' }, b: { instructions: 'y' } }, chair: false, quorum: { minVendors: 2 } } as never)).toThrow(/minVendors/);
    expect(() => agency({ strategy: 'panel', modelPool: POOL(), agents: { a: { instructions: 'x' }, b: { instructions: 'y' } }, chair: false, quorum: { minProviders: 4 } } as never)).toThrow(/minProviders/);
    // A pre-built seat can add one provider at most (C6): the bound counts it, and minProviders 3 still fails.
    expect(() => agency({ strategy: 'panel', modelPool: { astra: POOL().astra }, agents: { a: { instructions: 'x' }, pre: agent({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: K.ant, fallbackProviders: [] }) }, chair: false, quorum: { minProviders: 3 } } as never)).toThrow(/minProviders/);
  });
  it('a vendor quorum is not met by two hosts of one maker; a pre-built seat adds nothing to it', async () => {
    // The pre-built seat answers on OpenAI, so the vendor count is the only thing that keeps it out of the quorum.
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('P')], [/api\.groq\.com\/openai\/v1\/models/, openaiListing], [/api\.groq\.com\/openai\/v1\/chat\/completions/, openaiText('G')], [/api\.together\.xyz\/v1\/models/, openaiListing], [/api\.together\.xyz\/v1\/chat\/completions/, openaiText('T')], [ANTHROPIC, anthropicError(500, 'down', 'api_error')]]);
    const prebuilt = agent({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, fallbackProviders: [] });
    const team = agency({ strategy: 'panel', modelPool: { g: { ...groq, vendor: 'meta' }, t: together, opus: POOL().opus }, seating: { distinct: 'provider' }, agents: { a: { instructions: 'x' }, b: { instructions: 'y' }, c: { instructions: 'z' }, pre: prebuilt }, chair: false, quorum: { minAgents: 2, minVendors: 2 } } as never);
    const err = await team.generate('review').catch((e) => e);
    expect(err).toBeInstanceOf(AgencyQuorumError);
    expect(err.quorum.healthy).toBeGreaterThanOrEqual(2);
    expect(err.quorum.vendors).toEqual(['meta']);
  });
  it('two healthy seats both answered by OpenAI, one through a fixed Anthropic seat whose chain fired, do not meet minVendors 2', async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('O')], [ANTHROPIC, anthropicError(529, 'overloaded')]]);
    const err = await agency({ strategy: 'panel', modelPool: { astra: POOL().astra, opus: POOL().opus }, agents: { pooled: { instructions: 'a', from: ['astra'] }, fixed: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: K.fixed, instructions: 'x', fallbackProviders: [{ provider: 'openai', model: 'gpt-4.1' }] } }, chair: false, quorum: { minAgents: 2, minVendors: 2 } } as never).generate('review').catch((e) => e);
    expect(err).toBeInstanceOf(AgencyQuorumError);
    expect(err.quorum.healthy).toBe(2);
    expect(err.quorum.vendors).toEqual(['openai']);
  });
  it('minProviders counts a pre-built seat as one possible provider at construction; the run counts what answered', async () => {
    const pre = agent({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: K.ant, fallbackProviders: [] });
    const build = () => agency({ strategy: 'panel', modelPool: { astra: POOL().astra }, agents: { pooled: { instructions: 'a' }, pre }, chair: false, quorum: { minAgents: 2, minProviders: 2 } } as never);
    expect(build).not.toThrow();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('O')], [ANTHROPIC, anthropicText('A')]]);
    const ok = await build().generate('review');
    expect(ok.quorum).toMatchObject({ met: true, providers: expect.arrayContaining(['openai', 'anthropic']) });
    const preOnOpenAI = agent({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, fallbackProviders: [] });
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('O')]]);
    const err = await agency({ strategy: 'panel', modelPool: { astra: POOL().astra }, agents: { pooled: { instructions: 'a' }, pre: preOnOpenAI }, chair: false, quorum: { minAgents: 2, minProviders: 2 } } as never).generate('review').catch((e) => e);
    expect(err).toBeInstanceOf(AgencyQuorumError);
    expect(err.quorum.providers).toEqual(['openai']);
  });
  it("onShortfall 'proceed' returns met false with one healthy seat and still throws with none", async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(500, 'down')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiError(500, 'down')]]);
    const r = await panel({ quorum: { onShortfall: 'proceed' } }).generate('review');
    expect(r.quorum.met).toBe(false);
    expect(r.quorum.shortfall).toMatch(/1\/3/);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(500, 'down')], [ANTHROPIC, anthropicError(500, 'down', 'api_error')], [GEMINI, geminiError(500, 'down')]]);
    await expect(panel({ quorum: { onShortfall: 'proceed' } }).generate('review')).rejects.toBeInstanceOf(AgencyQuorumError);
  });
  it('a truncated seat with text is ok and truncated; text under minChars is empty; a pre-built seat is prebuilt and counts', async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiText('cut off mid', 'length'), openaiText('prebuilt view')]], [ANTHROPIC, [anthropicText('ok'), anthropicText('Merged')]], [GEMINI, geminiText('C')]]);
    const pre = agent({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, fallbackProviders: [] });
    // Healthy: the astra seat and the pre-built one ('ok' and 'C' are under minChars), so the quorum of 2 is met only if the pre-built seat counts.
    const r = await agency({ strategy: 'panel', modelPool: POOL(), agents: { ...SEATS(), pre }, chair: { from: ['opus'] }, panel: { minChars: 3 }, quorum: { minAgents: 2 } } as never).generate('review');
    expect(r.seats.find((s) => s.entry === 'astra')).toMatchObject({ status: 'ok', truncated: true, finishReason: 'length' });
    expect(r.seats.find((s) => s.entry === 'opus')).toMatchObject({ status: 'empty' });
    expect(r.seating.seats.pre).toEqual({ prebuilt: true });
    expect(r.seats.find((s) => s.seat === 'pre')).toMatchObject({ status: 'ok', provider: 'openai' });
    expect(r.quorum.met).toBe(true);
  });
});

const ownStrings = (e: unknown): string => {
  if (!e || typeof e !== 'object') return String(e);
  const out: string[] = [];
  for (const k of Object.getOwnPropertyNames(e)) { try { const v = (e as Json)[k]; out.push(typeof v === 'string' ? v : JSON.stringify(v) ?? ''); } catch { /* accessor */ } }
  return out.join('\n');
};
const errorEcho = (key: string) => ({ openai: openaiError(500, `rejected key ${key} by upstream`), anthropic: anthropicError(500, `rejected key ${key} by upstream`, 'api_error'), gemini: geminiError(500, `rejected key ${key} by upstream`) });

describe('13. no credential in any record', () => {
  it.each([
    ['a key written in the pool', () => ({ astra: POOL().astra }), () => K.oai, {}],
    ['a key read from the environment', () => ({ astra: { provider: 'openai', model: 'gpt-4.1' } }), () => K.oaiEnv, { OPENAI_API_KEY: K.oaiEnv }],
    ['the second key of a comma pool', () => ({ astra: { provider: 'openai', model: 'gpt-4.1', apiKey: `${K.oai},${K.second}` } }), () => K.second, {}],
  ])('under panel, %s appears in no seat record, thrown error or on.error payload', async (_label, entry, secret, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const errors: unknown[] = [];
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, errorEcho(secret()).openai], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('C')]]);
    const r = await agency({ strategy: 'panel', modelPool: { ...POOL(), ...entry() }, agents: SEATS(), chair: { from: ['opus'] }, on: { error: (e: Json) => errors.push(e) } } as never).generate('review');
    expect(JSON.stringify(r.seats)).not.toContain(secret());
    expect(r.seats.find((s) => s.entry === 'astra')!.error).toContain('[redacted]');
    for (const e of errors) expect(ownStrings((e as Json).error) + JSON.stringify(e)).not.toContain(secret());
  });

  it('under a pooled sequential agency the thrown error, the on.error payload and the stream error part hold the key nowhere', async () => {
    const errors: unknown[] = [];
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, errorEcho(K.oai).openai]]);
    const team = agency({ modelPool: { astra: POOL().astra }, agents: { one: { instructions: 'x' } }, strategy: 'sequential', on: { error: (e: Json) => errors.push(e) } } as never);
    const err = await team.generate('go').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    for (const text of [err.message, err.stack ?? '', ownStrings(err), JSON.stringify(err.details ?? null), ownStrings(err.cause)]) expect(text).not.toContain(K.oai);
    expect(err.message).toContain('[redacted]');
    for (const e of errors) expect(ownStrings((e as Json).error)).not.toContain(K.oai);
    const parts: Json[] = []; for await (const p of team.stream('go').fullStream) parts.push(p as Json);
    const errorPart = parts.find((p) => p.type === 'error');
    expect(errorPart).toBeDefined();
    expect(ownStrings(errorPart!.error)).not.toContain(K.oai);
  });

  it('under a pooled parallel agency with provenance on, a failed seat key is in neither on.error nor the trail', async () => {
    const errors: unknown[] = [];
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('synth')], [ANTHROPIC, errorEcho(K.ant).anthropic], [GEMINI, geminiText('C')]]);
    // `from: ['opus']` leaves seat a one candidate and so an empty chain: with the whole pool its chain would be gemini, which answers, and no error would reach on.error.
    const team = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: { opus: POOL().opus, gemini: POOL().gemini }, agents: { a: { instructions: 'x', from: ['opus'] }, b: { instructions: 'y' } }, strategy: 'parallel', provenance: { enabled: true }, on: { error: (e: Json) => errors.push(e) } } as never);
    const r = await team.generate('go');
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(ownStrings((e as Json).error)).not.toContain(K.ant);
    expect(JSON.stringify(r.provenanceTrail)).not.toContain(K.ant);
    expect(JSON.stringify(r.provenanceTrail)).toContain('[redacted]');
  });

  it("under a pooled hierarchical agency a failed delegate's key is absent from the manager's next request: a pooled delegate, a pre-built delegate and a spawned specialist failing on a default-chain hop", async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', K.antEnv);
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const isManager = (body: Json) => (body.tools ?? []).some((t: Json) => t.function?.name === 'delegate_to_worker');
    route([
      [OPENAI_LIST, openaiListing],
      [OPENAI_CHAT, (req) => {
        if (isManager(req.body!)) {
          const n = calls(OPENAI_CHAT, 'POST').filter((c) => isManager(c.body!)).length;
          return n === 1 ? openaiToolCall('delegate_to_worker', { task: 't' }, 'c1')(req)
            : n === 2 ? openaiToolCall('delegate_to_prebuilt', { task: 'u' }, 'c2')(req)
            : n === 3 ? openaiToolCall('spawn_specialist', { role: 'helper', instructions: 'Help.' }, 'c3')(req)
            : n === 4 ? openaiToolCall('delegate_to_helper', { task: 'v' }, 'c4')(req)
            : openaiText('manager done')(req);
        }
        // Every non-manager OpenAI request (the pre-built delegate on the environment key, the specialist on the agency key) fails echoing both keys.
        return openaiError(529, `overloaded ${K.chair} ${K.oaiEnv}`)();
      }],
      [ANTHROPIC, errorEcho(K.antEnv).anthropic],
      [GEMINI, errorEcho(K.gem).gemini],
    ]);
    const prebuilt = agent({ provider: 'openai', model: 'gpt-4.1', fallbackProviders: [] });
    const team = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: { gemini: POOL().gemini }, agents: { worker: { instructions: 'w' }, prebuilt }, strategy: 'hierarchical', emergent: { enabled: true } } as never);
    const r = await team.generate('go');
    expect(r.text).toBe('manager done');
    const managerBodies = calls(OPENAI_CHAT, 'POST').filter((c) => isManager(c.body!)).map((c) => JSON.stringify(c.body));
    expect(managerBodies.length).toBeGreaterThanOrEqual(5);
    for (const b of managerBodies) for (const key of [K.gem, K.antEnv, K.chair, K.oaiEnv]) expect(b).not.toContain(key);
    expect(managerBodies[managerBodies.length - 1]).toContain('[redacted]');
  });

  it("a pre-built seat's streamed error part is masked under a pooled sequential agency", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    // The seat is pre-built and never seated, so it has no __maskError of its own; agency.ts masks the error part before the consumer sees it.
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, errorEcho(K.oaiEnv).openai]]);
    const seq = agency({ modelPool: { gemini: POOL().gemini }, agents: { pre: agent({ provider: 'openai', model: 'gpt-4.1', fallbackProviders: [] }) }, strategy: 'sequential' } as never);
    const parts: Json[] = []; for await (const p of seq.stream('go').fullStream) parts.push(p as Json);
    const errorPart = parts.find((p) => p.type === 'error');
    expect(errorPart).toBeDefined();
    expect(ownStrings(errorPart!.error)).not.toContain(K.oaiEnv);
    expect(ownStrings(errorPart!.error)).toContain('[redacted]');
  });

  it('a default-chain hop on OpenAI and Anthropic failing with its environment key, and a synthesizer failing with the agency-level key, are masked', async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv); vi.stubEnv('ANTHROPIC_API_KEY', K.antEnv); vi.stubEnv('GEMINI_API_KEY', K.gemEnv);
    route([[GEMINI, geminiError(529, 'overloaded', 'UNAVAILABLE')], [OPENAI_LIST, openaiListing], [OPENAI_CHAT, errorEcho(K.oaiEnv).openai], [OPENAI_RESP, errorEcho(K.oaiEnv).openai], [ANTHROPIC, errorEcho(K.antEnv).anthropic]]);
    const err = await agency({ modelPool: { astra: POOL().astra }, agents: { fixed: { provider: 'gemini', model: 'gemini-2.5-flash', instructions: 'x' } }, strategy: 'sequential' } as never).generate('go').catch((e) => e);
    for (const key of [K.oaiEnv, K.antEnv]) { expect(err.message).not.toContain(key); expect(ownStrings(err)).not.toContain(key); }
    // With the environment keys gone the synthesizer has no default chain to rescue it, so its own failure reaches the caller.
    vi.unstubAllEnvs();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, errorEcho(K.chair).openai], [ANTHROPIC, anthropicText('A')], [GEMINI, geminiText('C')]]);
    const err2 = await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: { opus: POOL().opus, gemini: POOL().gemini }, agents: { a: { instructions: 'x' }, b: { instructions: 'y' } }, strategy: 'parallel' } as never).generate('go').catch((e) => e);
    expect(err2).toBeInstanceOf(Error);
    expect(ownStrings(err2)).not.toContain(K.chair);
  });

  it('an accessor-message error and a frozen error from a pre-built seat reach the caller masked; a timeout error keeps its abort error name', async () => {
    const accessor = new Error('x'); Object.defineProperty(accessor, 'message', { get: () => `leaked ${K.ant}`, configurable: false });
    const frozen = Object.freeze(new Error(`frozen ${K.ant}`));
    const timeout = new OpenAIProviderError(`timed out holding ${K.ant}`, 'REQUEST_TIMEOUT', undefined, undefined, undefined, new DOMException('aborted', 'AbortError'));
    for (const thrown of [accessor, frozen, timeout]) {
      const seat = { generate: async () => { throw thrown; }, stream: () => { throw thrown; }, session: () => ({}), usage: async () => ({}), close: async () => {} } as unknown as Agent;
      const err = await agency({ modelPool: { opus: POOL().opus }, agents: { seat }, strategy: 'sequential' } as never).generate('go').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TypeError);
      expect(err.message).not.toContain(K.ant);
      expect(err.message).toContain('[redacted]');
      if (thrown === timeout) { expect(err).toBeInstanceOf(OpenAIProviderError); expect((err.details as DOMException).name).toBe('AbortError'); }
    }
  });

  it('a pre-built seat and a debate judge failing with an environment key are masked in on.error of generate and stream and in the next call trail; a key under 8 characters masks nothing; a tool error is masked in the call record', async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const errors: unknown[] = [];
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, errorEcho(K.oaiEnv).openai], [ANTHROPIC, anthropicText('A')]]);
    const pre = agent({ provider: 'openai', model: 'gpt-4.1', fallbackProviders: [] });
    const team = agency({ provider: 'openai', model: 'gpt-4.1', modelPool: { opus: POOL().opus }, agents: { a: { instructions: 'x' }, pre }, strategy: 'debate', maxRounds: 1, provenance: { enabled: true }, on: { error: (e: Json) => errors.push(e) } } as never);
    await team.generate('go').catch(() => {});
    await team.stream('go').text.catch(() => {});
    for (const e of errors) expect(ownStrings((e as Json).error)).not.toContain(K.oaiEnv);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    // The next call succeeds; the recorder accumulates across calls, so its trail holds the two masked errors.
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('judged')], [ANTHROPIC, anthropicText('A')]]);
    const r = await team.generate('go');
    expect(JSON.stringify(r.provenanceTrail)).not.toContain(K.oaiEnv);
    expect(JSON.stringify(r.provenanceTrail)).toContain('[redacted]');

    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, errorEcho(K.shortKey).openai]]);
    const short = await agency({ modelPool: { astra: { provider: 'openai', model: 'gpt-4.1', apiKey: K.shortKey } }, agents: { one: { instructions: 'x' } }, strategy: 'sequential' } as never).generate('go').catch((e) => e);
    expect(short.message).toContain(K.shortKey);

    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('leak', {}), openaiText('done')]]]);
    const tr = await agency({ modelPool: { astra: POOL().astra }, agents: { one: { instructions: 'x' } }, strategy: 'sequential', tools: { leak: { description: 'l', parameters: { type: 'object', properties: {} }, execute: async () => { throw new Error(`tool saw ${K.oai}`); } } } } as never).generate('go');
    expect(tr.agentCalls[0].toolCalls[0].error).not.toContain(K.oai);
    expect(tr.agentCalls[0].toolCalls[0].error).toContain('[redacted]');
  });

  it.each<[string, Record<string, unknown>]>([
    ['native', {}],
    ['prompt-tool', { toolMode: 'prompt' }],
  ])('a tool error echoing the key, thrown and returned, is masked in the transcript, the top-level toolCalls and the next request under a seated and under a pre-built last seat (%s)', async (_mode, callOpts) => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const tools = {
      boom: { description: 'throws', parameters: { type: 'object', properties: {} }, execute: async () => { throw new Error(`tool saw ${K.oaiEnv}`); } },
      soft: { description: 'returns failure', parameters: { type: 'object', properties: {} }, execute: async () => ({ success: false, error: `soft ${K.oaiEnv}` }) },
    };
    const native = () => [openaiToolCall('boom', {}, 'c1'), openaiToolCall('soft', {}, 'c2'), openaiText('done')];
    const prompt = () => [openaiText('<tool_call>{"name":"boom","arguments":{}}</tool_call>'), openaiText('<tool_call>{"name":"soft","arguments":{}}</tool_call>'), openaiText('done')];
    const script = () => (callOpts.toolMode === 'prompt' ? prompt() : native());
    for (const last of ['seated', 'prebuilt'] as const) {
      route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, script()]]);
      const pre = agent({ provider: 'openai', model: 'gpt-4.1', fallbackProviders: [], tools });
      const team = agency({ modelPool: { astra: { provider: 'openai', model: 'gpt-4.1' } }, agents: last === 'seated' ? { one: { instructions: 'x', tools } } : { one: pre }, strategy: 'sequential' } as never);
      const r = await team.generate('go', callOpts);
      const everywhere = JSON.stringify([r.transcriptDelta, r.toolCalls, r.agentCalls.map((c) => c.toolCalls)]);
      expect(everywhere).not.toContain(K.oaiEnv);
      expect(everywhere).toContain('[redacted]');
      expect(calls(OPENAI_CHAT, 'POST').length).toBeGreaterThanOrEqual(3);
      // The seated seat's loops mask before they write the tool turn, so its second and third requests carry no key.
      // A pre-built seat's own loops carry no mask (spec section 4, Not covered): of what it returns, transcriptDelta, the top-level toolCalls and the call-record tool errors are masked, above; an answer of its that repeats the error is not.
      if (last === 'seated') for (const c of calls(OPENAI_CHAT, 'POST').slice(1)) expect(JSON.stringify(c.body)).not.toContain(K.oaiEnv);
    }
  });

  it.each<[string, Record<string, unknown>]>([
    ['native', {}],
    ['prompt-tool', { toolMode: 'prompt' }],
  ])('under stream() a seated last seat masks the tool error in its next requests, in the resolved transcript and in every stream part (%s)', async (_mode, callOpts) => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const tools = {
      boom: { description: 'throws', parameters: { type: 'object', properties: {} }, execute: async () => { throw new Error(`tool saw ${K.oaiEnv}`); } },
      soft: { description: 'returns failure', parameters: { type: 'object', properties: {} }, execute: async () => ({ success: false, error: `soft ${K.oaiEnv}` }) },
    };
    const script = callOpts.toolMode === 'prompt'
      ? [openaiText('<tool_call>{"name":"boom","arguments":{}}</tool_call>'), openaiText('<tool_call>{"name":"soft","arguments":{}}</tool_call>'), openaiText('done')]
      : [openaiToolCall('boom', {}, 'c1'), openaiToolCall('soft', {}, 'c2'), openaiText('done')];
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, script]]);
    // sequential streams its seats through agent.stream(): this drives streamText's masking (native) and the shim under runShimStream (prompt), where FT-1's scope matters.
    const team = agency({ modelPool: { astra: { provider: 'openai', model: 'gpt-4.1' } }, agents: { one: { instructions: 'x', tools } }, strategy: 'sequential' } as never);
    const st = team.stream('go', callOpts);
    const parts: Json[] = []; for await (const part of st.fullStream) parts.push(part as Json);
    const r = await st.result;
    expect(r.text).toBe('done');
    expect(JSON.stringify(parts)).not.toContain(K.oaiEnv);
    expect(JSON.stringify([r.transcriptDelta, r.toolCalls, r.agentCalls.map((c) => c.toolCalls)])).not.toContain(K.oaiEnv);
    expect(JSON.stringify(r.agentCalls.map((c) => c.toolCalls))).toContain('[redacted]');
    expect(calls(OPENAI_CHAT, 'POST').length).toBeGreaterThanOrEqual(3);
    for (const c of calls(OPENAI_CHAT, 'POST').slice(1)) expect(JSON.stringify(c.body)).not.toContain(K.oaiEnv);
  });

  it("a nested plain agency's accumulated provenance trail never reaches a pooled parent with provenance off", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const child = agency({ provider: 'openai', model: 'gpt-4.1', agents: { inner: { instructions: 'i', fallbackProviders: [] } }, strategy: 'sequential', provenance: { enabled: true } } as never);
    const parent = agency({ modelPool: { opus: POOL().opus }, agents: { first: { instructions: 'f' }, child }, strategy: 'sequential' } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, errorEcho(K.oaiEnv).openai], [ANTHROPIC, anthropicText('A')]]);
    await expect(parent.generate('go')).rejects.toThrow();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('child done')], [ANTHROPIC, anthropicText('A')]]);
    const r = await parent.generate('go');
    expect(r.text).toBe('child done');
    // The child's trail (which recorded its raw error on the first call) is the child's record: stripped, not rewritten (C3).
    expect(r).not.toHaveProperty('provenanceTrail');
    expect(JSON.stringify(r)).not.toContain(K.oaiEnv);
    expect(JSON.stringify((await child.generate('again')).provenanceTrail)).toContain(K.oaiEnv);
  });
});

describe('14. stream() and session().stream() carry the ledger', () => {
  it('result resolves to the same ledger as generate(); the final-output part carries it; a failed streamed quorum is billed', async () => {
    threeProviders();
    const team = panel();
    const g = await team.generate('review');
    threeProviders();
    const s = team.stream('review');
    const parts: Json[] = []; for await (const p of s.fullStream) parts.push(p as Json);
    const r = await s.result;
    expect(r.seats.map((x) => [x.seat, x.status, x.entry])).toEqual(g.seats.map((x) => [x.seat, x.status, x.entry]));
    expect(r.quorum).toEqual(g.quorum);
    const final = parts.find((p) => p.type === 'final-output')!;
    expect(final.seats).toHaveLength(3);
    expect(final.quorum.met).toBe(true);
    threeProviders();
    const ss = (team.session('s') as { stream: (t: string) => { result: Promise<PanelResult> } }).stream('review');
    expect((await ss.result).seats).toHaveLength(3);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(500, 'down')], [ANTHROPIC, anthropicText('A')], [GEMINI, geminiError(500, 'down')]]);
    const before = (await team.usage()).totalTokens;
    await expect(team.stream('review').text).rejects.toBeInstanceOf(AgencyQuorumError);
    expect((await team.usage()).totalTokens).toBe(before + 15);
  });
});

describe('15-16. seating outside panel', () => {
  it('a sequential pool seats from the pool, fails over to the next candidate with its key, and names who answered', async () => {
    route([[ANTHROPIC, anthropicError(529, 'overloaded')], [OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('rescued')]]);
    const team = agency({ modelPool: POOL(), agents: { a: { instructions: 'x' } }, strategy: 'sequential' } as never);
    const r = await team.generate('go');
    expect(r.seating.seats.a).toMatchObject({ entry: 'opus', provider: 'anthropic' });
    expect(r.text).toBe('rescued');
    expect(header(calls(OPENAI_CHAT, 'POST')[0], 'Authorization')).toBe(`Bearer ${K.oai}`);
    expect(r.agentCalls[0]).toMatchObject({ provider: 'openai', model: 'gpt-4.1' });
    expect(r.agentCalls[0].fallback).toMatchObject({ fired: true, finalProvider: 'openai' });
    route([[ANTHROPIC, anthropicError(529, 'overloaded')], [OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('rescued stream')]]);
    const s = team.stream('go');
    expect(await s.text).toBe('rescued stream');
    expect((await s.agentCalls)[0]).toMatchObject({ provider: 'openai', fallback: expect.objectContaining({ fired: true }) });
  });
  it('no available candidate throws AgencySeatingError before any request and leaves the rotation; a graph with an unseatable dependency does the same', async () => {
    threeProviders();
    const team = agency({ modelPool: { opus: { provider: 'anthropic', model: 'claude-opus-5-5' } }, seating: { policy: 'round-robin' }, agents: { a: { instructions: 'x' } }, strategy: 'sequential' } as never);
    await expect(team.generate('go')).rejects.toBeInstanceOf(AgencySeatingError);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv('ANTHROPIC_API_KEY', K.antEnv);
    expect((await team.generate('go')).seating.call).toBe(0);
    vi.unstubAllEnvs();
    const g = agency({ modelPool: { opus: { provider: 'anthropic', model: 'claude-opus-5-5' } }, agents: { root: { instructions: 'r' }, leaf: { instructions: 'l', dependsOn: ['root'] } }, strategy: 'graph' } as never);
    await expect(g.generate('go')).rejects.toBeInstanceOf(AgencySeatingError);
  });
  it('a pooled parallel agency with minProviders 2 and no seating meets its quorum', async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, anthropicText('A')], [GEMINI, geminiText('C')]]);
    const r = await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: POOL(), agents: { a: { instructions: 'x' }, b: { instructions: 'y' } }, strategy: 'parallel', quorum: { minProviders: 2 } } as never).generate('go');
    expect(r.seating.distinct).toBe('vendor');
    expect(new Set(Object.values(r.seating.seats).map((s) => s.provider)).size).toBe(2);
  });
  it('a nested panel in last position leaks no ledger into a pooled sequential parent', async () => {
    threeProviders();
    const inner = panel();
    const parent = agency({ modelPool: { gemini: POOL().gemini }, agents: { first: { instructions: 'f' }, inner }, strategy: 'sequential' } as never);
    const r = await parent.generate('go');
    expect(r.seating.seats.first).toMatchObject({ entry: 'gemini' });
    expect(r.seating.seats.inner).toEqual({ prebuilt: true });
    expect((r as Json).seats).toBeUndefined(); expect((r as Json).chair).toBeUndefined(); expect((r as Json).quorum).toBeUndefined();
  });
});

describe('17. construction and seating errors', () => {
  it('rejects the listed configurations at agency()', () => {
    const bad: Array<[string, Json]> = [
      ['panel + adaptive', { strategy: 'panel', modelPool: POOL(), agents: SEATS(), chair: { from: ['opus'] }, adaptive: true }],
      // No pool surface at all: validatePoolOptions does not run, so only the raw-strategy check in validateAgencyOptions (Task 23 Step 3b) can reject this one.
      ['panel + adaptive, no pool and no chair', { strategy: 'panel', adaptive: true, provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: SEATS() }],
      ['an unknown-vendor entry no seat references, with minVendors', { strategy: 'panel', modelPool: { ...POOL(), stray: { provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: 'gsk-stray-00000019' } }, agents: { a: { instructions: 'x', from: ['opus'] }, b: { instructions: 'y', from: ['astra'] } }, chair: false, quorum: { minVendors: 2 } }],
      ['chair with no model', { strategy: 'panel', modelPool: POOL(), agents: SEATS(), chair: { instructions: 'x' } }],
      ['chair model with no provider anywhere', { strategy: 'panel', modelPool: POOL(), agents: SEATS(), chair: { model: 'claude-opus-5-5' } }],
      ['chair.from unknown', { strategy: 'panel', modelPool: POOL(), agents: SEATS(), chair: { from: ['nope'] } }],
      ['router on a fixed seat of a pooled agency', { modelPool: POOL(), agents: { a: { provider: 'openai', model: 'gpt-4.1', router: {} } }, strategy: 'sequential' }],
      ['pooled hierarchical with no agency-level model', { modelPool: POOL(), agents: { a: { instructions: 'x' } }, strategy: 'hierarchical' }],
      ['seating without a pool', { seating: { policy: 'random' }, agents: SEATS() }],
      ['integer-like entry name', { strategy: 'panel', modelPool: { '1': POOL().opus }, agents: SEATS(), chair: false }],
      ['pooled seat with apiKey', { modelPool: POOL(), agents: { a: { apiKey: 'x' } }, strategy: 'sequential' }],
      ['customModelParams.model on a pooled seat', { modelPool: POOL(), agents: { a: { customModelParams: { model: 'x' } } }, strategy: 'sequential' }],
      ['output under panel', { strategy: 'panel', modelPool: POOL(), agents: SEATS(), chair: false, output: z.object({}) }],
      ['chair with a strategy other than panel', { modelPool: POOL(), agents: SEATS(), strategy: 'sequential', chair: { from: ['opus'] } }],
      ['bad seed', { strategy: 'panel', modelPool: POOL(), seating: { seed: -1 }, agents: SEATS(), chair: false }],
      ['minAgents above the seats', { strategy: 'panel', modelPool: POOL(), agents: SEATS(), chair: false, quorum: { minAgents: 4 } }],
    ];
    for (const [label, opts] of bad) expect(() => agency(opts as never), label).toThrow(AgencyConfigError);
  });
  it('an unseatable chair throws at call time before any seat request', async () => {
    threeProviders();
    const team = agency({ strategy: 'panel', modelPool: { ...POOL(), chairOnly: { provider: 'mistral', model: 'mistral-large-latest' } }, agents: SEATS(), chair: { from: ['chairOnly'] } } as never);
    await expect(team.generate('review')).rejects.toBeInstanceOf(AgencySeatingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('18. export and import of a panel agency', () => {
  it('round-trips without a sentinel and refuses a pre-built seat', () => {
    const S = { pool: 'sk-pool-sentinel-0016', hop: 'sk-hop-sentinel-0017', tok: 'xoxb-sentinel-0018' };
    const build = () => agency({ strategy: 'panel', modelPool: { opus: { ...POOL().opus, apiKey: S.pool }, astra: POOL().astra }, seating: { policy: 'weighted', seed: 7 }, agents: { a: { instructions: 'x' }, fixed: { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: K.gem, instructions: 'f', fallbackProviders: [{ provider: 'openai', model: 'gpt-4.1', apiKey: S.hop }] }, chan: { instructions: 'c', channels: { slack: { botToken: S.tok } } } }, chair: { from: ['opus'] }, panel: { seatDeadlineMs: 1000 }, quorum: { minAgents: 1 } } as never);
    const first = exportAgentConfig(build());
    // Every redacted path is supplied: a provider key beside a provider would otherwise be dropped for the environment (spec 116), and the second export would lack it (S11).
    const restored = importAgent(first, { secrets: {
      '/agents/chan/channels/slack/botToken': S.tok, '/agents/fixed/fallbackProviders/0/apiKey': S.hop, '/agents/fixed/apiKey': K.gem,
      '/config/modelPool/opus/apiKey': S.pool, '/config/modelPool/astra/apiKey': K.oai,
    } });
    const second = exportAgentConfig(restored);
    // Parsed documents compared structurally: the re-stashed roster may sit at another key position than the first export's.
    const strip = (d: Json) => JSON.parse(JSON.stringify({ ...d, exportedAt: undefined }));
    expect(strip(second)).toEqual(strip(first));
    for (const doc of [first, second]) { const t = JSON.stringify(doc); for (const s of Object.values(S)) expect(t).not.toContain(s); expect(t).toContain('"modelPool"'); expect(t).toContain('"seating"'); expect(t).toContain('"chair"'); expect(t).toContain('"panel"'); expect(t).toContain('"quorum"'); expect(doc.strategy).toBe('panel'); }
    const withPre = agency({ strategy: 'panel', modelPool: POOL(), agents: { ...SEATS(), pre: agent({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai }) }, chair: { from: ['opus'] } } as never);
    const doc = exportAgentConfig(withPre);
    expect(doc.agents!.pre).toEqual({ prebuilt: true });
    expect(() => importAgent(doc)).toThrow(/pre-built seat "pre"/);
  });
});

describe('19-21. callbacks, gates, CLI entries', () => {
  it('callbacks never change a status; a sync-throwing seat is error and the queue goes on; the trail holds the seat events', async () => {
    threeProviders();
    const approvalRequested = vi.fn(() => { throw new Error('ui crashed'); });
    const syncThrow = { generate: () => { throw new Error('sync'); }, stream: () => { throw new Error('sync'); }, session: () => ({}), usage: async () => ({}), close: async () => {} } as unknown as Agent;
    const r = await agency({ strategy: 'panel', modelPool: POOL(), agents: { bad: syncThrow, ...SEATS() }, chair: { from: ['opus'] }, panel: { concurrency: 1 }, provenance: { enabled: true },
      hitl: { approvals: { beforeAgent: ['correctness'] }, handler: hitl.autoApprove(), guardrailOverride: false },
      on: { agentEnd: () => { throw new Error('boom'); }, approvalRequested } } as never).generate('review');
    expect(r.seats.find((s) => s.seat === 'bad')).toMatchObject({ status: 'error' });
    expect(r.seats.filter((s) => s.status === 'ok')).toHaveLength(3);
    expect(approvalRequested).toHaveBeenCalled();
    expect(r.provenanceTrail!.events.filter((e) => e.kind === 'agentStart').map((e) => e.payload.agent)).toEqual(expect.arrayContaining(['correctness', 'security', 'failure']));
  });
  it('a beforeAgent guardrail that rejects the prompt records every gated seat as rejected', async () => {
    threeProviders();
    const r = await panel({ hitl: { approvals: { beforeAgent: ['correctness', 'security'] }, handler: hitl.autoApprove() }, quorum: { minAgents: 1 } }).generate('run kill -9 on the box');
    expect(r.seats.filter((s) => s.status === 'rejected').map((s) => s.seat).sort()).toEqual(['correctness', 'security']);
    expect(r.seats.find((s) => s.seat === 'correctness')!.error).toMatch(/Guardrail overrode/);
  });
  it('a CLI entry whose binary is missing is skipped with a reason and the seat takes its next candidate', async () => {
    threeProviders();
    const r = await agency({ strategy: 'panel', modelPool: { cli: { provider: 'claude-code-cli', model: 'claude-sonnet-4-6' }, ...POOL() }, agents: { a: { instructions: 'x', from: ['cli', 'astra'] }, b: { instructions: 'y' } }, chair: { from: ['opus'] } } as never).generate('review');
    expect(r.seating.skipped).toContainEqual({ entry: 'cli', reason: 'binary not found (claude)' });
    expect(r.seating.seats.a).toMatchObject({ entry: 'astra' });
  });
});

describe('22-23. rotation, copies, retries, empty text', () => {
  it('round-robin rotates across generate, stream and a session send; the roster and the export are untouched', async () => {
    const pool = { a: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: K.ant, weight: 2 }, b: { provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, weight: 1 } };
    const roster = { s1: { instructions: '1' }, s2: { instructions: '2' }, s3: { instructions: '3' } };
    const snapshot = JSON.stringify(roster);
    const team = agency({ modelPool: pool, seating: { policy: 'round-robin', distinct: false }, agents: roster, strategy: 'sequential' } as never);
    const exported = JSON.stringify({ ...exportAgentConfig(team), exportedAt: undefined });
    const seatings: string[][] = [];
    for (const call of [() => team.generate('x'), () => team.stream('x').result, () => (team.session('s') as { send: (t: string) => Promise<AgencyResult> }).send('x')]) {
      route([[ANTHROPIC, anthropicText('A')], [OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')]]);
      const r = (await call()) as AgencyResult;
      seatings.push(['s1', 's2', 's3'].map((s) => r.seating!.seats[s].entry!));
    }
    expect(seatings).toEqual([['a', 'b', 'a'], ['b', 'a', 'a'], ['a', 'a', 'b']]);
    expect(JSON.stringify(roster)).toBe(snapshot);
    expect(JSON.stringify({ ...exportAgentConfig(team), exportedAt: undefined })).toBe(exported);
  });
  it('a frozen shared chain, a chair with from and frozen per-call options are never written; concurrent calls seat in start order; a validation retry reuses the seating', async () => {
    const chain = Object.freeze([Object.freeze({ provider: 'mistral', model: 'mistral-large-latest' }), Object.freeze({ provider: 'gemini', model: 'gemini-2.5-flash' })]);
    vi.stubEnv('GEMINI_API_KEY', K.gemEnv);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(529, 'over')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('rescued')]]);
    const mk = () => agency({ strategy: 'panel', modelPool: { opus: POOL().opus }, agents: { pooled: { instructions: 'p' }, fixed: { provider: 'openai', model: 'gpt-4.1', apiKey: K.fixed, instructions: 'f', fallbackProviders: chain as never } }, chair: { from: ['opus'] } } as never);
    const [t1, t2] = [mk(), mk()];
    const r = await t1.generate('review', Object.freeze({ temperature: 0.1 }));
    expect(r.seats.find((s) => s.seat === 'fixed')).toMatchObject({ status: 'ok', provider: 'gemini' });
    expect(chain).toHaveLength(2);
    await t2.generate('review');
    threeProviders();
    const rr = agency({ strategy: 'panel', modelPool: POOL(), seating: { policy: 'round-robin', distinct: false }, agents: SEATS(), chair: { from: ['opus'] } } as never);
    const [c1, c2] = await Promise.all([rr.generate('one'), rr.generate('two')]);
    expect([c1.seating.call, c2.seating.call]).toEqual([0, 1]);
    // The requests above (three attempts per failing OpenAI call, and the round-robin seats) are not this part's.
    fetchMock.mockClear();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiText('not json'), openaiText('{"ok":true}')]]]);
    const v = await agency({ modelPool: { astra: POOL().astra }, agents: { one: { instructions: 'x' } }, strategy: 'sequential', output: z.object({ ok: z.boolean() }) } as never).generate('go');
    expect(v.parsed).toEqual({ ok: true });
    expect(v.seating!.call).toBe(0);
    expect(calls(OPENAI_CHAT, 'POST')).toHaveLength(2);
  });
  it("text is '' when sequential or graph reject every seat", async () => {
    for (const strategy of ['sequential', 'graph']) {
      const r = (await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { a: { instructions: 'x' } }, strategy, hitl: { approvals: { beforeAgent: ['a'] }, handler: hitl.autoReject('no') } } as never).generate('go')) as AgencyResult;
      expect(r.text).toBe('');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('25-26. approvals under panel and nested agencies', () => {
  const searchTool = () => ({ search: { description: 's', parameters: { type: 'object' as const, properties: { q: { type: 'string' } } }, execute: vi.fn(async () => ({ hits: 1 })) } });
  const toolThenText = (text: string) => [openaiToolCall('search', { q: 'x' }), openaiText(text)];
  it('the handler is asked once per tool call; a seat whose approval times out is error; the call resolves whole', async () => {
    const handler = vi.fn(async (r: ApprovalRequest) => (r.agent === 'failure' ? new Promise<ApprovalDecision>(() => {}) : { approved: true }));
    // The three seats send their first requests together, so the first three replies are the three tool calls; each approved seat's continuation then takes a text.
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('search', { q: 'x' }), openaiToolCall('search', { q: 'x' }), openaiToolCall('search', { q: 'x' }), openaiText('B'), openaiText('C'), openaiText('D')]], [ANTHROPIC, anthropicText('Merged')]]);
    const tools = searchTool();
    const r = await agency({ strategy: 'panel', modelPool: { astra: POOL().astra, opus: POOL().opus }, seating: { distinct: false }, agents: SEATS(), chair: { from: ['opus'] }, tools, hitl: { approvals: { beforeTool: ['search'] }, handler, timeoutMs: 20, onTimeout: 'error' } } as never).generate('review');
    expect(handler).toHaveBeenCalledTimes(3);
    // Agency-level tools reach every seat through mergeDefaults (D11): each seat's first request carries the search definition, and the two approved seats ran it.
    for (const c of calls(OPENAI_CHAT, 'POST').slice(0, 3)) expect((c.body!.tools ?? []).map((t: Json) => t.function?.name)).toContain('search');
    expect(tools.search.execute).toHaveBeenCalledTimes(2);
    expect(r.seats.find((s) => s.seat === 'failure')).toMatchObject({ status: 'error', error: expect.stringMatching(/timed out/) });
    expect(r.seats.filter((s) => s.status === 'ok')).toHaveLength(2);
    expect(r.chair?.status).toBe('ok');
    expect(r.quorum.met).toBe(true);
    expect(r.usage.totalTokens).toBeGreaterThan(0);
  });
  it('under a pooled sequential agency a throwing guardrailResult callback does not undo a guardrail block: the approved rm -rf never runs', async () => {
    const tools = searchTool();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('search', { q: 'rm -rf /tmp/foo' }), openaiText('done')]]]);
    const team = agency({ modelPool: { astra: POOL().astra }, agents: { one: { instructions: 'x' } }, strategy: 'sequential', tools, hitl: { approvals: { beforeTool: ['search'] }, handler: async () => ({ approved: true }) }, on: { guardrailResult: () => { throw new Error('ui down'); } } } as never);
    const r = await team.generate('clean up');
    expect(r.text).toBe('done');
    expect(tools.search.execute).not.toHaveBeenCalled();
  });
  it('a chair whose approval errors throws AgencyPanelError with the ledger; a seat already timed out stays timeout', async () => {
    vi.useFakeTimers();
    // A seat's approval rejects 5 s in, after the seat's 1 s deadline passed: the seat stays timeout and the late error fills no slot.
    const handler = vi.fn(async (r: ApprovalRequest) => { if (r.agent === 'chair') throw new Error('chair denied'); return new Promise<ApprovalDecision>((_, rej) => setTimeout(() => rej(new Error('late')), 5_000)); });
    // Every request goes to astra (distinct false, chair from astra): the first seat draws the tool call, the other two get text, the chair's first reply is the tool call and its continuation gets text.
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [...toolThenText('B'), openaiText('C'), openaiToolCall('search', { q: 'chair' }, 'call_c'), openaiText('E')]], [ANTHROPIC, anthropicText('A')]]);
    const team = agency({ strategy: 'panel', modelPool: { astra: POOL().astra, opus: POOL().opus }, seating: { distinct: false }, agents: SEATS(), chair: { from: ['astra'], tools: searchTool() }, tools: searchTool(), panel: { seatDeadlineMs: 1_000 }, hitl: { approvals: { beforeTool: ['search'] }, handler, timeoutMs: 10_000, onTimeout: 'error' } } as never);
    const pending = team.generate('review').catch((e) => e);
    await vi.advanceTimersByTimeAsync(6_000);
    const err = await pending;
    expect(err).toBeInstanceOf(AgencyPanelError);
    expect(err.seats.find((s: Json) => s.seat === 'correctness').status).toBe('timeout');
  });
  it("a seat starting after a sibling's 401 opened the provider is error with reason circuit open", async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiError(401, 'bad key'), openaiText('never')]], [ANTHROPIC, anthropicText('Merged')]]);
    const r = await agency({ strategy: 'panel', modelPool: { a1: POOL().astra, a2: { ...POOL().astra, apiKey: K.second }, opus: POOL().opus }, seating: { distinct: false }, agents: { s1: { instructions: 'x', from: ['a1'] }, s2: { instructions: 'y', from: ['a2'] } }, chair: { from: ['opus'] }, panel: { concurrency: 1 }, quorum: { minAgents: 0 } } as never).generate('review').catch((e) => e);
    const seats = r instanceof Error ? (r as Json).seats : r.seats;
    expect(seats.find((s: Json) => s.seat === 's2')).toMatchObject({ status: 'error', error: 'circuit open' });
    expect(calls(OPENAI_CHAT, 'POST')).toHaveLength(1);
  });
  it('nested pooled agencies and panels compose the gate and keep the deadline flag', async () => {
    const tools = searchTool();
    const child = () => agency({ modelPool: { astra: POOL().astra }, agents: { inner: { instructions: 'i' } }, strategy: 'sequential', tools } as never);
    const childPanel = () => agency({ strategy: 'panel', modelPool: { astra: POOL().astra, opus: POOL().opus }, seating: { distinct: false }, agents: { p1: { instructions: 'a' }, p2: { instructions: 'b' } }, chair: false, tools, quorum: { minAgents: 1 } } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [...toolThenText('a'), ...toolThenText('b'), ...toolThenText('c'), ...toolThenText('d'), ...toolThenText('e'), ...toolThenText('f')]], [ANTHROPIC, anthropicText('Merged')]]);
    // Under D11 the panel seats hold the agency-level search tool too, so a call any of them draws would run: the parent's gate must reach all of them.
    for (const seat of [child(), childPanel()]) {
      const r = await agency({ agents: { seat }, strategy: 'sequential', hitl: { approvals: { beforeTool: ['search'] }, handler: hitl.autoReject('no') } } as never).generate('go');
      expect(r).toBeTruthy();
    }
    // Six requests served: the child's tool call and text; p1's tool call, p2's text, p1's second tool call and its text. Every drawn call was skipped by the parent's gate; without the gate the count here would be 3.
    expect(tools.search.execute).toHaveBeenCalledTimes(0);
    for (const seat of [child(), childPanel()]) {
      const r = await agency({ agents: { seat }, strategy: 'sequential' } as never).generate('go');
      expect(r).toBeTruthy();
    }
    // No parent gate: the child's one call and p1's two ran (p2 drew text both rounds); the twelve-item queue is used up exactly.
    expect(tools.search.execute).toHaveBeenCalledTimes(3);
    expect(calls(OPENAI_CHAT, 'POST')).toHaveLength(12);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [...toolThenText('g'), ...toolThenText('h')]]]);
    const handler = vi.fn(async () => ({ approved: true }));
    const gated = agency({ modelPool: { astra: POOL().astra }, agents: { inner: { instructions: 'i' } }, strategy: 'sequential', tools, hitl: { approvals: { beforeTool: ['search'] }, handler } } as never);
    tools.search.execute.mockClear();
    await gated.generate('go', { __approvalGate: 'nope' });
    await gated.generate('go', { __approvalGate: async () => { throw new Error('bad'); } });
    // D12: a present non-function gate fails closed and a throwing gate refuses; neither asks the handler, neither runs the tool.
    expect(handler).not.toHaveBeenCalled();
    expect(tools.search.execute).toHaveBeenCalledTimes(0);
  });
  it("a panel nested in a panel keeps __panelDeadline; a parent-deadline timeout in a child seat leaves the breaker closed; the parent's gate holds on nested tools and a parent handler error fills the parent's slot", async () => {
    vi.useFakeTimers();
    // The OpenAI stub rejects on abort, so each inner seat's request becomes a REQUEST_TIMEOUT error when the parent's deadline, passed down as requestTimeout with __panelDeadline, fires. Five such errors on one provider would open its breaker (transient threshold 5) if the flag were lost.
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, ({ init }) => new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); })], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]]]);
    const inner = agency({ strategy: 'panel', modelPool: { astra: POOL().astra }, seating: { distinct: false }, agents: { p1: { instructions: 'a' }, p2: { instructions: 'b' }, p3: { instructions: 'c' }, p4: { instructions: 'd' }, p5: { instructions: 'e' } }, chair: false, quorum: { minAgents: 0 } } as never);
    const outer = agency({ strategy: 'panel', modelPool: { opus: POOL().opus }, agents: { innerSeat: inner, own: { instructions: 'o' } }, chair: { from: ['opus'] }, panel: { seatDeadlineMs: 500 }, quorum: { minAgents: 1 } } as never);
    const pending = outer.generate('review');
    await vi.advanceTimersByTimeAsync(600);
    const r = await pending;
    expect(r.seats.find((s) => s.seat === 'innerSeat')).toMatchObject({ status: 'timeout' });
    // Each inner seat's call makes the provider's three attempts, each aborted by the 500 ms requestTimeout the parent's deadline passed down, with the provider's backoff between them (500 to 1,000 ms, then 1,000 to 2,000 ms): the last attempt ends within 4,500 ms of the start, and only then does the call reach the recordFailure site __panelDeadline guards. The breaker is read after that point; with the flag lost, the five REQUEST_TIMEOUT failures would have opened it.
    await vi.advanceTimersByTimeAsync(10_000);
    const innerPosts = calls(OPENAI_CHAT, 'POST');
    expect(innerPosts).toHaveLength(15); // five seats, three attempts each; the own seat and the chair are on Anthropic, and a seat with one candidate has no chain
    expect(innerPosts.every((c) => c.init.signal?.aborted)).toBe(true);
    expect(globalLLMProviderHealth.isOpen('openai')).toBe(false);
    vi.useRealTimers();
    const tools = searchTool();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('search', { q: 'x' }), openaiText('inner done')]]]);
    const childHandler = vi.fn(async () => ({ approved: true }));
    const child = agency({ modelPool: { astra: POOL().astra }, agents: { inner: { instructions: 'i' } }, strategy: 'sequential', tools, hitl: { approvals: { beforeTool: ['search'] }, handler: childHandler } } as never);
    const parent = agency({ agents: { child }, strategy: 'sequential', hitl: { approvals: { beforeTool: ['search'] }, handler: async () => { throw new Error('parent handler failed'); } } } as never);
    await expect(parent.generate('go')).rejects.toThrow('parent handler failed');
    expect(childHandler).not.toHaveBeenCalled();
    expect(tools.search.execute).not.toHaveBeenCalled();
    expect((await child.usage()).totalTokens).toBe(30);
  });
});
