/**
 * @file agency-panel.e2e.test.ts
 * Model pool, seating, strict credentials, redaction and the panel strategy,
 * driven through agency(), agent(), generateText, streamText and the real
 * Anthropic, OpenAI, Gemini and xAI provider classes with only fetch stubbed
 * (axios, which OpenRouter and Ollama send through, is forwarded to it).
 * OpenRouter and Ollama seats are in agency-panel-axios.e2e.test.ts.
 */
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
    const out = { status: res.status, statusText: res.statusText, data, headers: Object.fromEntries(res.headers as unknown as Iterable<[string, string]>), config: { url } };
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
import { generateText } from '../generateText.js';
import { hitl } from '../hitl.js';
import { exportAgentConfig, importAgent } from '../agentExport.js';
import { setDefaultProvider, clearDefaultProvider } from '../runtime/global-default.js';
import { setLoggerFactory, resetLoggerFactory } from '../../core/logging/loggerFactory.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import { seatHealthId } from '../runtime/pool/resolve.js';
import { OpenAIProviderError } from '../../core/llm/providers/errors/OpenAIProviderError.js';
import {
  AgencyConfigError, AgencyQuorumError, AgencyPanelError, AgencySeatingError,
  type Agent, type AgencyCallbacks, type PanelResult, type AgencyResult, type ApprovalRequest, type ApprovalDecision,
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
/** An abort controller as a polyfill or another realm builds it: its signal fires `abort`, reads `aborted` and `reason`, and is no instance of this realm's AbortSignal. */
function foreignAbortController(): { signal: { aborted: boolean; reason: unknown; addEventListener: EventTarget['addEventListener']; removeEventListener: EventTarget['removeEventListener'] }; abort(reason: unknown): void } {
  const target = new EventTarget();
  const signal = { aborted: false, reason: undefined as unknown, addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target) };
  return { signal, abort(reason) { if (signal.aborted) return; signal.aborted = true; signal.reason = reason; target.dispatchEvent(new Event('abort')); } };
}

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
const header = (c: Captured, name: string): string | undefined => {
  const headers = (c.init.headers ?? {}) as Record<string, string>;
  return headers[name] ?? headers[name.toLowerCase()];
};
type LogLine = { level: string; message: unknown; meta: Json | undefined };
/** Every line the host's logger (`setLoggerFactory`) is handed while `run` runs. */
async function logLines(run: () => Promise<void>): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  const make = (): unknown => {
    const write = (level: string) => (message: unknown, meta?: Json) => { lines.push({ level, message, meta }); };
    return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug'), child: () => make() };
  };
  setLoggerFactory(() => make() as never);
  try { await run(); } finally { resetLoggerFactory(); }
  return lines;
}
const threeProviders = (texts = { opus: 'A finds a bug', astra: 'B finds a bug', gemini: 'C finds a bug' }, chairText = 'Merged findings') =>
  route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText(texts.astra)], [ANTHROPIC, [anthropicText(texts.opus), anthropicText(chairText)]], [GEMINI, geminiText(texts.gemini)]]);

const POOL = () => ({
  opus: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: K.ant },
  astra: { provider: 'openai', model: 'gpt-4.1', apiKey: K.oai },
  gemini: { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: K.gem },
});
// The health record astra's calls on K.oai write. Each key has its own (providerHealthKey): with no OPENAI_API_KEY
// of that value it is not the provider's plain 'openai' record, so a breaker check on astra reads this one.
const astraHealth = () => seatHealthId({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai });
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
    expect(((await team.usage()) as { totalTokens: number }).totalTokens).toBe(60); // three seats and the chair, 15 each, counted before the limit check threw
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
    expect(ok.seating!.call).toBe(0);
    const seq = agency({ modelPool: POOL(), agents: { one: { instructions: 'a' } }, strategy: 'sequential' } as never);
    await expect(seq.generate('x', { system: 'allowed outside panel' })).resolves.toBeTruthy();
  });
  it('maxAttempts and onAttempt pass the allow list and reach the seats: a seat on 500 sends one request, and onAttempt hears it', async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(500, 'down')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('C')]]);
    const onAttempt = vi.fn();
    const result = await panel().generate('review', { maxAttempts: 1, onAttempt });
    expect(result.seats.find((s) => s.entry === 'astra')).toMatchObject({ status: 'error' });
    expect(result.text).toBe('Merged');
    // The provider's own count is three attempts (the nested-panel test counts them); the call's cap sends one.
    expect(calls(OPENAI_CHAT, 'POST')).toHaveLength(1);
    // The OpenAI provider reports each request it sends; the Anthropic and Gemini providers report none.
    expect(onAttempt.mock.calls).toEqual([[{ attempt: 1, status: 500, ok: false }]]);
  });
  it('a session send on a panel is not rejected, and a rejected call moves neither the rotation nor the call number', async () => {
    threeProviders();
    const team = panel({ seating: { policy: 'round-robin' } });
    await expect(team.generate('x', { apiKey: 'x' })).rejects.toBeInstanceOf(AgencyConfigError);
    const r = (await (team.session('s') as { send: (t: string) => Promise<PanelResult> }).send('hello')) as PanelResult;
    expect(r.seating!.call).toBe(0);
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
  it("a caller's abort that lands after two seats answered rejects the call with the panel's ledger and starts no chair; with chair: false no labelled block is returned", async () => {
    for (const chair of [false, { from: ['opus'], instructions: 'Merge.' }]) {
      fetchMock.mockReset();
      globalLLMProviderHealth.reset();
      // opus and gemini answer at once; astra's request hangs until its signal aborts.
      route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, abortable], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('C')]]);
      const ended: string[] = [];
      const controller = new AbortController();
      const pending = panel({ chair, on: { agentEnd: (e: Json) => ended.push(e.agent) } }).generate('review', { abortSignal: controller.signal }).catch((e) => e);
      await vi.waitFor(() => expect([...ended].sort()).toEqual(['correctness', 'failure']));
      controller.abort(new Error('caller stopped'));
      const err = await pending;
      expect(err, `chair ${JSON.stringify(chair)}`).toBeInstanceOf(AgencyPanelError);
      expect(err.message).toBe('panel aborted: caller stopped');
      expect(err.seats.map((s: Json) => [s.seat, s.status, s.error])).toEqual([['correctness', 'ok', undefined], ['security', 'error', 'caller stopped'], ['failure', 'ok', undefined]]);
      expect(err.quorum).toMatchObject({ met: true, healthy: 2 });
      // The one Anthropic request is the correctness seat's: no chair was sent.
      expect(calls(ANTHROPIC, 'POST')).toHaveLength(1);
    }
  });
});

describe('6. deadlines (fake timers)', () => {
  it('a panel of one: the floor is zero, so its one answer meets the quorum, and its one failure throws AgencyQuorumError with no healthy seat', async () => {
    const one = () => agency({ strategy: 'panel', modelPool: { astra: POOL().astra }, agents: { only: { instructions: 'x' } }, chair: false } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('A')]]);
    const result = await one().generate('review');
    expect(result.quorum).toEqual({ met: true, healthy: 1, providers: ['openai'], vendors: ['openai'] });
    expect(result.seats.map((s) => [s.seat, s.status])).toEqual([['only', 'ok']]);
    expect(result.text).toBe('--- only ---\nA');
    fetchMock.mockReset();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(500, 'down')]]);
    const err = await one().generate('review').catch((e) => e);
    expect(err).toBeInstanceOf(AgencyQuorumError);
    expect(err.message).toContain('no seat returned text (0/1 healthy)');
    expect(err.quorum).toMatchObject({ met: false, healthy: 0 });
    expect(err.seats.map((s: Json) => [s.seat, s.status])).toEqual([['only', 'error']]);
  });
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
    expect(globalLLMProviderHealth.isOpen(astraHealth())).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });
  it('a seat stopped by its deadline sends no further request: the tool call it was running when it timed out leads to no second step', async () => {
    vi.useFakeTimers();
    // The tool takes 2 s, past the 1 s deadline; its result would start the seat's second step.
    const search = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 2_000)); return { hits: 1 }; });
    const tools = { search: { description: 's', parameters: { type: 'object' as const, properties: { q: { type: 'string' } } }, execute: search } };
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('search', { q: 'x' }), openaiText('late answer')]], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('C')]]);
    const pending = panel({ panel: { seatDeadlineMs: 1_000 }, tools }).generate('review');
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await pending;
    expect(result.seats.find((s) => s.entry === 'astra')).toMatchObject({ status: 'timeout' });
    expect(result.text).toBe('Merged');
    expect(search).toHaveBeenCalledTimes(1);
    // The tool returns after the panel did. The seat's call was stopped at its deadline, so its loop starts no
    // second step: the one OpenAI request is the tool call's.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls(OPENAI_CHAT, 'POST')).toHaveLength(1);
  });
  it("a caller's abort settles a seat waiting on its beforeAgent approval, and a seat that takes its slot after it asks no approval and sends nothing", async () => {
    // The handler never answers, and the panel sets no deadline: before the abort the first seat waits on it.
    const handler = vi.fn(() => new Promise<ApprovalDecision>(() => {}));
    threeProviders();
    const controller = new AbortController();
    const team = panel({ panel: { concurrency: 1 }, hitl: { approvals: { beforeAgent: ['correctness', 'security', 'failure'] }, handler, guardrailOverride: false } });
    const pending = team.generate('review', { abortSignal: controller.signal }).catch((e) => e);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    controller.abort(new Error('caller stopped'));
    const err = await pending;
    // Every seat ended on the abort: zero healthy seats, and the ledger names each.
    expect(err).toBeInstanceOf(AgencyQuorumError);
    expect(err.seats.map((s: Json) => [s.seat, s.status, s.error])).toEqual([
      ['correctness', 'error', 'caller stopped'],
      ['security', 'error', 'caller stopped'],
      ['failure', 'error', 'caller stopped'],
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 10_000);
  it("a caller's abort through a signal this realm's AbortSignal does not recognize, a polyfill's or another realm's, settles a seat waiting on its approval the same way, and no request is sent", async () => {
    const handler = vi.fn(() => new Promise<ApprovalDecision>(() => {}));
    threeProviders();
    const foreign = foreignAbortController();
    expect(foreign.signal).not.toBeInstanceOf(AbortSignal);
    const team = panel({ panel: { concurrency: 1 }, hitl: { approvals: { beforeAgent: ['correctness', 'security', 'failure'] }, handler, guardrailOverride: false } });
    const pending = team.generate('review', { abortSignal: foreign.signal as unknown as AbortSignal }).catch((e) => e);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    foreign.abort(new Error('caller stopped'));
    const err = await pending;
    expect(err).toBeInstanceOf(AgencyQuorumError);
    expect(err.seats.map((s: Json) => [s.seat, s.status, s.error])).toEqual([
      ['correctness', 'error', 'caller stopped'],
      ['security', 'error', 'caller stopped'],
      ['failure', 'error', 'caller stopped'],
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 10_000);
  it("a caller's abort that lands as a seat's approval resolves starts nothing: a pre-built seat that ignores the signal is not invoked, and the seat ends on the abort", async () => {
    // The approval resolves and the caller aborts in one tick: the seat reads the abort when the approval returns, not a
    // flag the abort's own chain sets a few microtasks later, which the approval's shorter chain would outrun.
    let approve!: (decision: ApprovalDecision) => void;
    const handler = vi.fn(() => new Promise<ApprovalDecision>((resolve) => { approve = resolve; }));
    const ignoring = { generate: vi.fn(async () => ({ text: 'ran anyway' })), stream: () => { throw new Error('unused'); }, session: () => ({}), usage: async () => ({}), close: async () => {} } as unknown as Agent;
    threeProviders();
    const controller = new AbortController();
    const team = agency({ strategy: 'panel', modelPool: { opus: POOL().opus }, agents: { pre: ignoring, pooled: { instructions: 'p' } }, chair: false, panel: { concurrency: 1 }, hitl: { approvals: { beforeAgent: ['pre'] }, handler, guardrailOverride: false } } as never);
    const pending = team.generate('review', { abortSignal: controller.signal }).catch((e) => e);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    approve({ approved: true });
    controller.abort(new Error('caller stopped'));
    const err = await pending;
    expect(err).toBeInstanceOf(AgencyQuorumError);
    expect(err.seats.map((s: Json) => [s.seat, s.status, s.error])).toEqual([['pre', 'error', 'caller stopped'], ['pooled', 'error', 'caller stopped']]);
    expect(ignoring.generate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  }, 10_000);
  it("a seat's deadline stops its request in flight when the caller's signal is a polyfill's: the seat is timeout, its request was aborted, and the panel returns", async () => {
    vi.useFakeTimers();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, abortable], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('C')]]);
    const foreign = foreignAbortController();
    const pending = panel({ panel: { seatDeadlineMs: 1_000 } }).generate('review', { abortSignal: foreign.signal as unknown as AbortSignal });
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await pending;
    expect(result.seats.find((s) => s.entry === 'astra')).toMatchObject({ status: 'timeout' });
    expect(calls(OPENAI_CHAT)[0].init.signal?.aborted).toBe(true);
    expect(result.text).toBe('Merged');
  });
  it('concurrency 1 starts the next seat when the first times out', async () => {
    vi.useFakeTimers();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, never], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('C')]]);
    const team = agency({ strategy: 'panel', modelPool: { astra: POOL().astra, opus: POOL().opus, gemini: POOL().gemini }, agents: SEATS(), chair: { from: ['opus'] }, panel: { seatDeadlineMs: 500, concurrency: 1 } } as never);
    const pending = team.generate('review');
    await vi.advanceTimersByTimeAsync(10);
    expect(calls(ANTHROPIC, 'POST')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    // The security seat (opus) started when the first seat timed out. The stubs answer at once, so the failure seat
    // and then the chair, also on opus, have run too: the chair's request is the second.
    const anthropicPosts = calls(ANTHROPIC, 'POST');
    expect(anthropicPosts).toHaveLength(2);
    expect(JSON.stringify(anthropicPosts[0].body)).toContain('Find security defects.');
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
    // Every seat times out, and zero healthy seats always rejects: the rejection is observed from the start, so it is
    // never unhandled while the timers advance.
    const pending = team.generate('review').catch((e) => e);
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
    const result = await pending;
    expect(result).toBeInstanceOf(AgencyQuorumError);
    expect(result.seats.find((s: Json) => s.seat === 'security').status).toBe('timeout');
    expect(result.seats.filter((s: Json) => s.status === 'timeout')).toHaveLength(6);
    // Five seats timed out on astra (the breaker's transient threshold). Each was stopped at its deadline: its request
    // ends as an abort, which the provider does not retry and no breaker records, so after ten more seconds each seat
    // sent one request and the breaker is closed.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls(GEMINI).length).toBe(0);
    expect(calls(OPENAI_CHAT, 'POST')).toHaveLength(5);
    expect(globalLLMProviderHealth.isOpen(astraHealth())).toBe(false);
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
    expect(result.seating!.skipped).toEqual([{ entry: 'opus', reason: 'no key (ANTHROPIC_API_KEY)' }, { entry: 'blank', reason: 'no key (ANTHROPIC_API_KEY)' }]);
    expect(fetchMock.mock.calls.every(([u]) => !OPENROUTER.test(String(u)))).toBe(true);
  });
  it("an anthropic entry's own key with only OPENROUTER_API_KEY in the environment: its calls go to Anthropic on that key, and nothing reports a fallback to OpenRouter", async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', K.orEnv);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      threeProviders();
      const result = await panel().generate('review');
      expect(result.text).toBe('Merged findings');
      // The opus seat and the chair, each on the entry's own key.
      expect(calls(ANTHROPIC, 'POST').map((c) => header(c, 'x-api-key'))).toEqual([K.ant, K.ant]);
      expect(fetchMock.mock.calls.every(([u]) => !OPENROUTER.test(String(u)))).toBe(true);
      // Seating, the panel's start check and each call read the provider's shared credentials to pick the health
      // record. With no Anthropic key there that read resolves to OpenRouter, and it sends nothing.
      const notices = warn.mock.calls.map((args) => args.map(String).join(' ')).filter((line) => line.includes('OpenRouter'));
      expect(notices).toEqual([]);
    } finally {
      warn.mockRestore();
    }
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
  it('an agency-level provider that disagrees with the prefix of the agency model yields to it, as the agency calls do: the chair calls Anthropic with the agency key, and no OpenAI request carries it', async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('C')]]);
    const result = await agency({ strategy: 'panel', provider: 'openai', model: 'anthropic:claude-opus-5-5', apiKey: K.agency, modelPool: POOL(), agents: SEATS() } as never).generate('review');
    expect(result.text).toBe('Merged');
    expect(calls(ANTHROPIC, 'POST').some((c) => header(c, 'x-api-key') === K.agency && c.body?.model === 'claude-opus-5-5')).toBe(true);
    expect(JSON.stringify(calls(/api\.openai\.com/).map((c) => c.init.headers))).not.toContain(K.agency);
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
  it("beside a nameless setDefaultProvider a fixed seat's default-chain hop keeps the breaker of the environment key it sends: its 401 stops no call on the default's key, and the default key's 401 skips no hop", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    vi.stubEnv('GEMINI_API_KEY', K.gemEnv);
    // The default chain is then one OpenAI hop.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const nameless = 'sk-nameless-default-0013';
    setDefaultProvider({ apiKey: nameless });
    // OpenAI refuses one key and answers any other.
    let refused = K.oaiEnv;
    const openai = (answer: Handler): Handler => (req) => (header(req, 'Authorization') === `Bearer ${refused}` ? openaiError(401, 'bad key')() : answer(req));
    route([[GEMINI, geminiError(529, 'overloaded', 'UNAVAILABLE')], [OPENAI_LIST, openaiListing], [OPENAI_CHAT, openai(openaiText('from openai'))], [OPENAI_RESP, openai(openaiResponsesText('from openai'))]]);
    const seat = () => agency({ modelPool: { astra: POOL().astra }, agents: { fixed: { provider: 'gemini', model: 'gemini-2.5-flash', instructions: 'x' } }, strategy: 'sequential' } as never).generate('go');
    // A call that names its provider and no key runs on the nameless default's key.
    const direct = () => generateText({ provider: 'openai', model: 'gpt-4.1', prompt: 'hi', fallbackProviders: [] });
    const openaiKeys = () => calls(/api\.openai\.com\/v1\/(chat\/completions|responses)/, 'POST').map((c) => header(c, 'Authorization'));

    // The seat's hop is refused on the environment's key; a call on the default's key is still sent and answered.
    await expect(seat()).rejects.toThrow();
    expect(openaiKeys().length).toBeGreaterThan(0);
    expect(openaiKeys().every((k) => k === `Bearer ${K.oaiEnv}`)).toBe(true);
    const before = openaiKeys().length;
    expect((await direct()).text).toBe('from openai');
    expect(openaiKeys().slice(before)).toEqual([`Bearer ${nameless}`]);

    // The default's key is refused, which opens the provider's own record; the seat's hop still runs on the
    // environment's key.
    globalLLMProviderHealth.reset();
    refused = nameless;
    await expect(direct()).rejects.toThrow();
    expect(globalLLMProviderHealth.isOpen('openai')).toBe(true);
    const result = await seat();
    expect(result.text).toBe('from openai');
    expect(openaiKeys().slice(-1)).toEqual([`Bearer ${K.oaiEnv}`]);
  });
  it('an Anthropic hop with no Anthropic key is dropped from a fixed seat chain and nothing goes to OpenRouter', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', K.orEnv);
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(529, 'overloaded')]]);
    const team = agency({ modelPool: { gemini: POOL().gemini }, agents: { fixed: { provider: 'openai', model: 'gpt-4.1', instructions: 'x', fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }] } }, strategy: 'sequential' } as never);
    await expect(team.generate('go')).rejects.toThrow();
    expect(fetchMock.mock.calls.every(([u]) => !OPENROUTER.test(String(u)) && !ANTHROPIC.test(String(u)))).toBe(true);
  });
  it.each(['parallel', 'debate', 'hierarchical'])("a pooled %s agency's own agent (the synthesizer, the manager) resolves its keys as a seat does: its default-chain hop sends the hop provider's key, never a nameless default's", async (strategy) => {
    vi.stubEnv('GEMINI_API_KEY', K.gemEnv);
    // The default chain is then one Gemini hop.
    vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('OPENROUTER_API_KEY', '');
    const nameless = 'sk-nameless-default-0013';
    setDefaultProvider({ apiKey: nameless });
    // The agency's own agent runs on OpenAI with the agency key, which OpenAI refuses; the seats sit on opus.
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(401, 'bad key')], [ANTHROPIC, anthropicText('A')], [GEMINI, geminiText('rescued')]]);
    const team = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: { opus: POOL().opus }, agents: { a: { instructions: 'x' }, b: { instructions: 'y' } }, strategy, maxRounds: 1 } as never);
    const result = await team.generate('go');
    expect(result.text).toBe('rescued');
    expect(calls(GEMINI, 'POST').map((c) => header(c, 'x-goog-api-key'))).toEqual([K.gemEnv]);
    expect(JSON.stringify(fetchMock.mock.calls.map(([, i]) => (i as RequestInit).headers))).not.toContain(nameless);
  });
  it("a pooled hierarchical agency's spawned specialist resolves its keys as a seat does: its default-chain hop sends the hop provider's key, never a nameless default's", async () => {
    vi.stubEnv('GEMINI_API_KEY', K.gemEnv);
    // The default chain is then one Gemini hop.
    vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('OPENROUTER_API_KEY', '');
    const nameless = 'sk-nameless-default-0013';
    setDefaultProvider({ apiKey: nameless });
    // The manager's requests carry the spawn tool; the specialist's, on the agency key, are overloaded. A transient
    // failure leaves the breaker of that key closed for the manager's next turn, where a 401 would open it.
    const isManager = (body: Json) => (body.tools ?? []).some((t: Json) => t.function?.name === 'spawn_specialist');
    let managerTurn = 0;
    route([
      [OPENAI_LIST, openaiListing],
      [OPENAI_CHAT, (req) => {
        if (!isManager(req.body!)) return openaiError(529, 'overloaded')();
        managerTurn += 1;
        return managerTurn === 1 ? openaiToolCall('spawn_specialist', { role: 'helper', instructions: 'Help.' }, 'c1')(req)
          : managerTurn === 2 ? openaiToolCall('delegate_to_helper', { task: 'v' }, 'c2')(req)
          : openaiText('manager done')(req);
      }],
      [GEMINI, geminiText('helped')],
    ]);
    const team = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: { gemini: POOL().gemini }, agents: { worker: { instructions: 'w' } }, strategy: 'hierarchical', emergent: { enabled: true } } as never);
    const r = await team.generate('go');
    expect(r.text).toBe('manager done');
    // The specialist's answer is the tool turn the manager's last request carries.
    expect(JSON.stringify(calls(OPENAI_CHAT, 'POST').at(-1)!.body!.messages)).toContain('helped');
    expect(calls(GEMINI, 'POST').map((c) => header(c, 'x-goog-api-key'))).toEqual([K.gemEnv]);
    expect(JSON.stringify(fetchMock.mock.calls.map(([, i]) => (i as RequestInit).headers))).not.toContain(nameless);
  });
  it("a pooled hierarchical agency's emergent judge resolves its key as a seat does: the agency-level key on the agency's provider, whether or not the provider's variable is set, and never a nameless setDefaultProvider key", async () => {
    const nameless = 'sk-nameless-default-0013';
    /** Runs one spawn with a judge review and returns the Authorization header of every judge request. */
    const judgeHeaders = async (envKey: string): Promise<Array<string | undefined>> => {
      fetchMock.mockReset();
      vi.stubEnv('OPENAI_API_KEY', envKey);
      setDefaultProvider({ apiKey: nameless });
      let managerTurn = 0;
      route([
        [OPENAI_LIST, openaiListing],
        [OPENAI_CHAT, (req) => {
          // The judge's request carries no tools; the manager's carry the delegate and spawn tools.
          if (!(req.body?.tools ?? []).length) return openaiText('{"approved": true, "reasoning": "fits"}')(req);
          managerTurn += 1;
          return managerTurn === 1 ? openaiToolCall('spawn_specialist', { role: 'helper', instructions: 'Help.' }, 'c1')(req) : openaiText('manager done')(req);
        }],
      ]);
      const team = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: { gemini: POOL().gemini }, agents: { worker: { instructions: 'w' } }, strategy: 'hierarchical', emergent: { enabled: true, judge: true, planner: { judgeModel: 'gpt-4.1' } } } as never);
      const r = await team.generate('go');
      expect(r.text).toBe('manager done');
      expect(JSON.stringify(fetchMock.mock.calls.map(([, i]) => (i as RequestInit).headers))).not.toContain(nameless);
      return calls(OPENAI_CHAT, 'POST').filter((c) => !(c.body?.tools ?? []).length).map((c) => header(c, 'Authorization'));
    };
    // The agency's key, as the manager sends it: a fixed seat on the agency's provider inherits it before the provider's variable.
    expect(await judgeHeaders(K.oaiEnv)).toEqual([`Bearer ${K.chair}`]);
    // With no variable, the agency's key is the only key the judge's provider has; the review is still sent.
    expect(await judgeHeaders('')).toEqual([`Bearer ${K.chair}`]);
  });
  it("a hierarchical agency without a pool sends its emergent judge the key every other call of the agency reads: a nameless setDefaultProvider key ahead of the provider's variable", async () => {
    const nameless = 'sk-nameless-default-0014';
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    setDefaultProvider({ apiKey: nameless });
    let managerTurn = 0;
    route([
      [OPENAI_LIST, openaiListing],
      [OPENAI_CHAT, (req) => {
        // The judge's request carries no tools; the manager's carry the delegate and spawn tools.
        if (!(req.body?.tools ?? []).length) return openaiText('{"approved": true, "reasoning": "fits"}')(req);
        managerTurn += 1;
        return managerTurn === 1 ? openaiToolCall('spawn_specialist', { role: 'helper', instructions: 'Help.' }, 'c1')(req) : openaiText('manager done')(req);
      }],
    ]);
    const team = agency({ provider: 'openai', model: 'gpt-4.1', agents: { worker: { instructions: 'w' } }, strategy: 'hierarchical', emergent: { enabled: true, judge: true, planner: { judgeModel: 'gpt-4.1' } } } as never);
    const r = await team.generate('go');
    expect(r.text).toBe('manager done');
    const sent = calls(OPENAI_CHAT, 'POST');
    expect(sent.filter((c) => !(c.body?.tools ?? []).length)).toHaveLength(1);
    // The manager's turns and the judge's review read the same key, in the usual order: the nameless default, then the variable.
    expect(sent.map((c) => header(c, 'Authorization'))).toEqual(sent.map(() => `Bearer ${nameless}`));
  });
  it("a pooled seat's failover reaches a logger factory the host sets after import: fallback_fired names both providers and carries the provider's message masked", async () => {
    route([[ANTHROPIC, anthropicError(529, `overloaded ${K.ant}`)], [OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('rescued')]]);
    // The seat takes opus, the first entry, and fails over to astra, its next candidate.
    const team = agency({ modelPool: POOL(), agents: { one: { instructions: 'x' } }, strategy: 'sequential' } as never);
    const lines = await logLines(async () => {
      expect((await team.generate('go')).text).toBe('rescued');
    });
    const fired = lines.filter((l) => l.meta?.event === 'fallback_fired');
    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0].meta).toMatchObject({ primaryProvider: 'anthropic', fallbackProvider: 'openai' });
    expect(String(fired[0].meta?.errorMessage)).toContain('overloaded [redacted]');
    expect(JSON.stringify(lines)).not.toContain(K.ant);
  });
  it("under panel a fixed seat's own chain carries the keys the resolver wrote; a keyless hop is dropped and listed; the record carries fallback", async () => {
    vi.stubEnv('GEMINI_API_KEY', K.gemEnv);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(529, 'overloaded')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('rescued')]]);
    const result = await agency({ strategy: 'panel', modelPool: { opus: POOL().opus }, agents: { pooled: { instructions: 'a' }, fixed: { provider: 'openai', model: 'gpt-4.1', apiKey: K.fixed, instructions: 'x', fallbackProviders: [{ provider: 'mistral', model: 'mistral-large-latest' }, { provider: 'gemini', model: 'gemini-2.5-flash' }] } }, chair: { from: ['opus'] } } as never).generate('review');
    const fixed = result.seats.find((s) => s.seat === 'fixed')!;
    expect(fixed).toMatchObject({ status: 'ok', provider: 'gemini', text: 'rescued' });
    expect(fixed.fallback?.fired).toBe(true);
    expect(header(calls(GEMINI, 'POST')[0], 'x-goog-api-key')).toBe(K.gemEnv);
    expect(result.seating!.skipped).toContainEqual({ entry: 'fixed/fallbackProviders/0', reason: 'no key (MISTRAL_API_KEY)' });
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
    expect(dropped.seating!.skipped).toContainEqual({ entry: 'fixed/fallbackProviders/0', reason: 'binary not found (claude)' });
    binariesOnPath.add('claude');
    try {
      route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]]]);
      const kept = await build().generate('review');
      expect(kept.seating!.skipped).toEqual([]);
      expect(kept.seats.find((s) => s.seat === 'fixed')).toMatchObject({ status: 'ok', provider: 'openai' });
    } finally { binariesOnPath.delete('claude'); }
  });
  it("a fixed seat's Ollama hop with a URL and no key is kept: the availability rule, not a key, decides", async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]]]);
    const r = await agency({ strategy: 'panel', modelPool: { opus: POOL().opus }, agents: { pooled: { instructions: 'a' }, fixed: { provider: 'openai', model: 'gpt-4.1', apiKey: K.fixed, instructions: 'x', fallbackProviders: [{ provider: 'ollama', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434' }] } }, chair: { from: ['opus'] } } as never).generate('review');
    expect(r.seating!.skipped).toEqual([]);
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
  it("a fixed seat with no key of its own adds no provider and no vendor at construction, its keyed hop's included, since seating leaves it out before its chain is read; a pool entry with no key adds none either", () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const hop = { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: K.ant };
    const seats = (aKey?: string) => ({
      a: { provider: 'openai', model: 'gpt-4.1', ...(aKey ? { apiKey: aKey } : {}), instructions: 'x', fallbackProviders: [hop] },
      b: { provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, instructions: 'y' },
    });
    // Seat a is unseated at every call, so its Anthropic hop never runs: b alone answers, on one provider and one vendor.
    expect(() => agency({ strategy: 'panel', agents: seats(), chair: false, quorum: { minProviders: 2 } } as never)).toThrow(/minProviders \(2\) is above the 1 .*seat "a": no key \(OPENAI_API_KEY\)/);
    expect(() => agency({ strategy: 'panel', agents: seats(), chair: false, quorum: { minVendors: 2 } } as never)).toThrow(/minVendors \(2\) is above the 1 .*seat "a": no key \(OPENAI_API_KEY\)/);
    // With a key of its own, a answers on OpenAI or through its hop on Anthropic.
    expect(() => agency({ strategy: 'panel', agents: seats(K.fixed), chair: false, quorum: { minProviders: 2, minVendors: 2 } } as never)).not.toThrow();
    // An entry with no key is skipped at seating and seats nobody: both pooled seats answer on OpenAI.
    const pool = { opus: { provider: 'anthropic', model: 'claude-opus-5-5' }, astra: POOL().astra };
    expect(() => agency({ strategy: 'panel', modelPool: pool, agents: { a: { instructions: 'x' }, b: { instructions: 'y' } }, chair: false, quorum: { minProviders: 2 } } as never)).toThrow(/minProviders \(2\) is above the 1 .*entry "opus": no key \(ANTHROPIC_API_KEY\)/);
    expect(() => agency({ strategy: 'panel', modelPool: POOL(), agents: { a: { instructions: 'x' }, b: { instructions: 'y' } }, chair: false, quorum: { minProviders: 2 } } as never)).not.toThrow();
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
    expect(r.seating!.seats.pre).toEqual({ prebuilt: true });
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
/** An error whose message is clean and whose toJSON writes a key it keeps in a private field, which no walk of its properties reaches. */
class KeyedError extends Error {
  readonly #key: string;
  constructor(message: string, key: string) {
    super(message);
    this.name = 'KeyedError';
    this.#key = key;
  }
  toJSON(): Record<string, unknown> {
    return { message: this.message, key: this.#key };
  }
}
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
    expect(errors.length).toBeGreaterThan(0);
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
    expect(errors.length).toBeGreaterThan(0);
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

  it("under a pooled hierarchical agency an agency-level tool's error that echoes a key reaches the manager's next request masked", async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', K.antEnv);
    const tools = { lookup: { description: 'l', parameters: { type: 'object', properties: {} }, execute: async () => { throw new Error(`lookup saw ${K.antEnv}`); } } };
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('lookup', {}, 'c1'), openaiText('manager done')]], [GEMINI, geminiText('unused')]]);
    const team = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: { gemini: POOL().gemini }, agents: { worker: { instructions: 'w' } }, strategy: 'hierarchical', tools } as never);
    const result = await team.generate('go');
    expect(result.text).toBe('manager done');
    // The manager's two requests: the one that drew the tool call, and the one carrying the tool's error.
    const bodies = calls(OPENAI_CHAT, 'POST').map((c) => JSON.stringify(c.body));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toContain(K.antEnv);
    expect(bodies[1]).toContain('lookup saw [redacted]');
  });

  it("a seat's answer and a tool result that repeat a key reach no record: the result's text, agentCalls, toolCalls, the trail, agentEnd and every stream part", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const tools = { readConfig: { description: 'r', parameters: { type: 'object', properties: {} }, execute: async () => ({ key: K.oaiEnv }) } };
    const script = () => [openaiToolCall('readConfig', {}), openaiText(`the key is ${K.oaiEnv}`)];
    const ends: Json[] = [];
    const team = agency({ modelPool: { astra: { provider: 'openai', model: 'gpt-4.1' } }, agents: { one: { instructions: 'x', tools } }, strategy: 'sequential', provenance: { enabled: true }, on: { agentEnd: (e: Json) => ends.push(e) } } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, script()]]);
    const result = await team.generate('go');
    expect(result.text).toBe('the key is [redacted]');
    expect(result.agentCalls[0].output).toBe('the key is [redacted]');
    expect(result.agentCalls[0].toolCalls[0].result).toEqual({ key: '[redacted]' });
    expect(JSON.stringify(result)).not.toContain(K.oaiEnv);
    expect(JSON.stringify(result.provenanceTrail)).toContain('the key is [redacted]');
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, script()]]);
    const streamed = team.stream('go');
    const parts: Json[] = []; for await (const part of streamed.fullStream) parts.push(part as Json);
    expect(JSON.stringify(parts)).not.toContain(K.oaiEnv);
    expect(parts.find((part) => part.type === 'final-output')).toMatchObject({ text: 'the key is [redacted]' });
    expect((await streamed.result).text).toBe('the key is [redacted]');
    expect(ends).toHaveLength(2);
    expect(JSON.stringify(ends)).not.toContain(K.oaiEnv);
  });

  it("a tool that returns an Error as its output: the key in its message reaches the tool-call record masked, and the record keeps an Error", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const tools = { readConfig: { description: 'r', parameters: { type: 'object', properties: {} }, execute: async () => new Error(`config holds ${K.oaiEnv}`) } };
    const team = agency({ modelPool: { astra: { provider: 'openai', model: 'gpt-4.1' } }, agents: { one: { instructions: 'x', tools } }, strategy: 'sequential' } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('readConfig', {}), openaiText('done')]]]);
    const result = await team.generate('go');
    const recorded = result.agentCalls[0].toolCalls[0].result as Error;
    expect(recorded).toBeInstanceOf(Error);
    expect(recorded.message).toBe('config holds [redacted]');
    expect(ownStrings(recorded)).not.toContain(K.oaiEnv);
    expect(JSON.stringify(result)).not.toContain(K.oaiEnv);
  });

  it("a tool that returns a class instance holding a key: the tool-call record holds what a serializer writes of it, masked, as the provider's turn does, and a clean instance stays itself", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    class Session { user: string; token: string; constructor(user: string, token: string) { this.user = user; this.token = token; } }
    class Profile { user: string; constructor(user: string) { this.user = user; } }
    const clean = new Profile('ada');
    const tools = {
      login: { description: 'l', parameters: { type: 'object', properties: {} }, execute: async () => new Session('ada', `tok ${K.oaiEnv}`) },
      whoami: { description: 'w', parameters: { type: 'object', properties: {} }, execute: async () => clean },
    };
    const team = agency({ modelPool: { astra: { provider: 'openai', model: 'gpt-4.1' } }, agents: { one: { instructions: 'x', tools } }, strategy: 'sequential' } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('login', {}, 'c1'), openaiToolCall('whoami', {}, 'c2'), openaiText('done')]]]);
    const result = await team.generate('go');
    expect(result.text).toBe('done');
    const [login, whoami] = result.agentCalls[0].toolCalls;
    expect(login.result).toEqual({ user: 'ada', token: 'tok [redacted]' });
    expect(whoami.result).toBe(clean);
    expect(JSON.stringify(result)).not.toContain(K.oaiEnv);
    expect(JSON.stringify(calls(OPENAI_CHAT, 'POST').map((c) => c.body))).not.toContain(K.oaiEnv);
  });

  it("a tool that returns an object keyed by a key: the tool-call record and the result hold the key masked, as the provider's turn does", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const tools = { keys: { description: 'k', parameters: { type: 'object', properties: {} }, execute: async () => ({ status: { [K.oaiEnv]: 'active' } }) } };
    const team = agency({ modelPool: { astra: { provider: 'openai', model: 'gpt-4.1' } }, agents: { one: { instructions: 'x', tools } }, strategy: 'sequential' } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('keys', {}, 'c1'), openaiText('done')]]]);
    const result = await team.generate('go');
    expect(result.text).toBe('done');
    expect(result.agentCalls[0].toolCalls[0].result).toEqual({ status: { '[redacted]': 'active' } });
    expect(JSON.stringify(result)).not.toContain(K.oaiEnv);
    expect(JSON.stringify(calls(OPENAI_CHAT, 'POST').map((c) => c.body))).not.toContain(K.oaiEnv);
  });

  it("a tool that returns an Error whose toJSON writes a key from a private field: the tool-call record holds what that toJSON writes, masked, as the provider's turn does", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const tools = { lookup: { description: 'l', parameters: { type: 'object', properties: {} }, execute: async () => new KeyedError('lookup failed', K.oaiEnv) } };
    const team = agency({ modelPool: { astra: { provider: 'openai', model: 'gpt-4.1' } }, agents: { one: { instructions: 'x', tools } }, strategy: 'sequential' } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('lookup', {}), openaiText('done')]]]);
    const result = await team.generate('go');
    expect(result.text).toBe('done');
    expect(result.agentCalls[0].toolCalls[0].result).toEqual({ message: 'lookup failed', key: '[redacted]' });
    expect(JSON.stringify(result)).not.toContain(K.oaiEnv);
    expect(JSON.stringify(calls(OPENAI_CHAT, 'POST').map((c) => c.body))).not.toContain(K.oaiEnv);
  });

  it("a pre-built seat's tool that returns a number whose digits hold a listed key: the call record holds it masked, in generate() and in stream()", async () => {
    const digits = '12345678';
    const tools = { pin: { description: 'p', parameters: { type: 'object', properties: {} }, execute: async () => 912345678 } };
    const pre = agent({ provider: 'openai', model: 'gpt-4.1', apiKey: digits, fallbackProviders: [], tools });
    const team = agency({ modelPool: { opus: POOL().opus }, agents: { pre }, strategy: 'sequential' } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('pin', {}), openaiText('done')]]]);
    const generated = await team.generate('go');
    expect(generated.text).toBe('done');
    expect(generated.agentCalls[0].toolCalls.map((t) => t.result)).toEqual(['[redacted]']);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('pin', {}), openaiText('done')]]]);
    const streamed = team.stream('go');
    const parts: unknown[] = [];
    for await (const part of streamed.fullStream) parts.push(part);
    const final = await streamed.result;
    expect(final.agentCalls[0].toolCalls.map((t) => t.result)).toEqual(['[redacted]']);
    expect(JSON.stringify([generated.agentCalls, final.agentCalls])).not.toContain(digits);
  });

  it("under panel a seat's answer that repeats a key is redacted in its seat record and the chair's answer in the result's text", async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText(`B saw ${K.oai}`)], [ANTHROPIC, [anthropicText('A'), anthropicText(`Merged ${K.oai}`)]], [GEMINI, geminiText('C')]]);
    const result = await panel().generate('review');
    expect(result.seats.find((s) => s.entry === 'astra')).toMatchObject({ status: 'ok', text: 'B saw [redacted]' });
    expect(result.text).toBe('Merged [redacted]');
    expect(result.chair).toMatchObject({ text: 'Merged [redacted]' });
    expect(JSON.stringify(result)).not.toContain(K.oai);
  });

  it("under panel a seat's answer that repeats a key reaches the chair's request, every agentEnd event and the provenance trail masked", async () => {
    const ends: Json[] = [];
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText(`B saw ${K.oai}`)], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiText('C')]]);
    const result = await panel({ provenance: { enabled: true }, on: { agentEnd: (e: Json) => ends.push(e) } }).generate('review');
    expect(result.text).toBe('Merged');
    // The opus seat's request and the chair's: the chair is sent the healthy seats' answers.
    const chairBody = JSON.stringify(calls(ANTHROPIC, 'POST')[1].body);
    expect(chairBody).not.toContain(K.oai);
    expect(chairBody).toContain('B saw [redacted]');
    expect(ends.map((e) => e.agent)).toEqual(expect.arrayContaining(['security', 'chair', '__agency__']));
    expect(JSON.stringify(ends)).not.toContain(K.oai);
    expect(JSON.stringify(ends)).toContain('B saw [redacted]');
    expect(JSON.stringify(result.provenanceTrail)).not.toContain(K.oai);
    expect(JSON.stringify(result.provenanceTrail)).toContain('B saw [redacted]');
  });

  it("under a pooled hierarchical agency a delegate's answer that repeats a key reaches the manager's next request masked, a pooled delegate's and a pre-built one's", async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', K.antEnv);
    route([
      [OPENAI_LIST, openaiListing],
      [OPENAI_CHAT, [openaiToolCall('delegate_to_worker', { task: 't' }, 'c1'), openaiToolCall('delegate_to_prebuilt', { task: 'u' }, 'c2'), openaiText('manager done')]],
      [GEMINI, geminiText(`worker saw ${K.gem}`)],
      [ANTHROPIC, anthropicText(`prebuilt saw ${K.antEnv}`)],
    ]);
    const prebuilt = agent({ provider: 'anthropic', model: 'claude-opus-5-5', fallbackProviders: [] });
    const team = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: { gemini: POOL().gemini }, agents: { worker: { instructions: 'w' }, prebuilt }, strategy: 'hierarchical' } as never);
    const r = await team.generate('go');
    expect(r.text).toBe('manager done');
    // Only the manager calls OpenAI: the first request drew the worker's call, the second the pre-built delegate's.
    const bodies = calls(OPENAI_CHAT, 'POST').map((c) => JSON.stringify(c.body));
    expect(bodies).toHaveLength(3);
    for (const b of bodies) for (const key of [K.gem, K.antEnv]) expect(b).not.toContain(key);
    expect(bodies[2]).toContain('worker saw [redacted]');
    expect(bodies[2]).toContain('prebuilt saw [redacted]');
    expect(r.agentCalls.map((c) => c.output)).toEqual(['worker saw [redacted]', 'prebuilt saw [redacted]']);
  });

  it("under a pooled sequential agency a seat's answer that repeats a key reaches the next seat's request masked, in generate() and in stream()", async () => {
    const team = agency({ modelPool: { astra: POOL().astra, opus: POOL().opus }, agents: { first: { instructions: 'f', from: ['astra'] }, second: { instructions: 's', from: ['opus'] } }, strategy: 'sequential' } as never);
    const script = (): void => route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText(`first saw ${K.oai}`)], [ANTHROPIC, anthropicText('second done')]]);
    script();
    const r = await team.generate('go');
    expect(r.text).toBe('second done');
    const sent = JSON.stringify(calls(ANTHROPIC, 'POST')[0].body);
    expect(sent).not.toContain(K.oai);
    expect(sent).toContain('first saw [redacted]');
    expect(r.agentCalls[0].output).toBe('first saw [redacted]');
    fetchMock.mockReset();
    script();
    const st = team.stream('go');
    for await (const _part of st.fullStream) { /* drain */ }
    await st.result;
    const streamed = JSON.stringify(calls(ANTHROPIC, 'POST')[0].body);
    expect(streamed).not.toContain(K.oai);
    expect(streamed).toContain('first saw [redacted]');
  });

  it.each(['parallel', 'debate'])("a pooled %s agency sends its synthesizer, and under debate the next speaker, a seat's answer masked", async (strategy) => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('synth')], [ANTHROPIC, anthropicText(`A saw ${K.ant}`)], [GEMINI, geminiText('B argues')]]);
    const team = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: { opus: POOL().opus, gemini: POOL().gemini }, agents: { a: { instructions: 'x', from: ['opus'] }, b: { instructions: 'y', from: ['gemini'] } }, strategy, maxRounds: 1 } as never);
    const r = await team.generate('go');
    expect(r.text).toBe('synth');
    // The seats are on Anthropic and Gemini, so the one OpenAI request is the synthesizer's.
    const synthBody = JSON.stringify(calls(OPENAI_CHAT, 'POST')[0].body);
    expect(synthBody).not.toContain(K.ant);
    expect(synthBody).toContain('A saw [redacted]');
    if (strategy === 'debate') {
      const rebuttal = JSON.stringify(calls(GEMINI, 'POST')[0].body);
      expect(rebuttal).not.toContain(K.ant);
      expect(rebuttal).toContain('A saw [redacted]');
    }
  });

  it("a pooled review-loop agency sends its reviewer the producer's draft masked, and a pooled graph sends a dependent its dependency's answer masked", async () => {
    route([[OPENAI_LIST, openaiListing], [ANTHROPIC, anthropicText(`draft with ${K.ant}`)], [GEMINI, geminiText('{"approved": true, "feedback": ""}')]]);
    const loop = agency({ modelPool: { opus: POOL().opus, gemini: POOL().gemini }, agents: { producer: { instructions: 'p', from: ['opus'] }, reviewer: { instructions: 'r', from: ['gemini'] } }, strategy: 'review-loop', maxRounds: 1 } as never);
    const reviewed = await loop.generate('go');
    const review = JSON.stringify(calls(GEMINI, 'POST')[0].body);
    expect(review).not.toContain(K.ant);
    expect(review).toContain('draft with [redacted]');
    expect(reviewed.text).toBe('draft with [redacted]');

    fetchMock.mockReset();
    route([[OPENAI_LIST, openaiListing], [ANTHROPIC, anthropicText(`A saw ${K.ant}`)], [GEMINI, geminiText('B done')]]);
    const graph = agency({ modelPool: { opus: POOL().opus, gemini: POOL().gemini }, agents: { a: { instructions: 'a', from: ['opus'] }, b: { instructions: 'b', from: ['gemini'], dependsOn: ['a'] } }, strategy: 'graph' } as never);
    const g = await graph.generate('go');
    expect(g.text).toBe('B done');
    const dependent = JSON.stringify(calls(GEMINI, 'POST')[0].body);
    expect(dependent).not.toContain(K.ant);
    expect(dependent).toContain('A saw [redacted]');
  });

  it('under a pooled sequential agency a key the seat streams across two chunks is whole in no text part, no textStream chunk and no final text', async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    // K.oaiEnv is sk-oai-env-00000006: the first chunk ends inside it.
    const split: Handler = () => sse([oaiChunk('gpt-4.1', { role: 'assistant', content: 'the key is sk-oai-' }), oaiChunk('gpt-4.1', { content: 'env-00000006 now' }), oaiChunk('gpt-4.1', {}, 'stop'), oaiChunk('gpt-4.1', null, null, U), '[DONE]']);
    const team = agency({ modelPool: { astra: { provider: 'openai', model: 'gpt-4.1' } }, agents: { one: { instructions: 'x' } }, strategy: 'sequential' } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, split]]);
    const st = team.stream('go');
    const parts: Json[] = []; for await (const p of st.fullStream) parts.push(p as Json);
    const streamedText = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
    expect(streamedText).not.toContain(K.oaiEnv);
    expect(streamedText).toBe('the key is [redacted] now');
    expect(await st.text).toBe('the key is [redacted] now');
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, split]]);
    const chunks: string[] = []; for await (const chunk of team.stream('go').textStream) chunks.push(chunk);
    expect(chunks.join('')).toBe('the key is [redacted] now');
  });

  it('under a pooled sequential agency a key the seat streams around a tool call, half before it and half after its result, is whole in no text part and no final text', async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const tools = { lookup: { description: 'l', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true }) } };
    // The first step's text ends inside K.oaiEnv and the step ends on a tool call; the second step's text finishes the key.
    const firstStep: Handler = () => sse([
      oaiChunk('gpt-4.1', { role: 'assistant', content: 'the key is sk-oai-' }),
      oaiChunk('gpt-4.1', { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '' } }] }),
      oaiChunk('gpt-4.1', { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }),
      oaiChunk('gpt-4.1', {}, 'tool_calls'),
      oaiChunk('gpt-4.1', null, null, U),
      '[DONE]',
    ]);
    const team = agency({ modelPool: { astra: { provider: 'openai', model: 'gpt-4.1' } }, agents: { one: { instructions: 'x', tools } }, strategy: 'sequential' } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [firstStep, openaiText('env-00000006 now')]]]);
    const st = team.stream('go');
    const parts: Json[] = []; for await (const p of st.fullStream) parts.push(p as Json);
    const streamedText = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
    expect(streamedText).toBe('the key is [redacted] now');
    expect(JSON.stringify(parts)).not.toContain(K.oaiEnv);
    expect(await st.text).toBe('the key is [redacted] now');
    expect(calls(OPENAI_CHAT, 'POST')).toHaveLength(2);
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

  it("a pre-built seat's error whose toJSON writes a key from a private field reaches the caller and on.error as an error whose JSON holds no key", async () => {
    const errors: Json[] = [];
    const seat = { generate: async () => { throw new KeyedError('upstream failed', K.ant); }, stream: () => { throw new Error('unused'); }, session: () => ({}), usage: async () => ({}), close: async () => {} } as unknown as Agent;
    const err = await agency({ modelPool: { opus: POOL().opus }, agents: { seat }, strategy: 'sequential', on: { error: (e: Json) => errors.push(e) } } as never).generate('go').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('upstream failed');
    expect(JSON.stringify(err)).not.toContain(K.ant);
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).not.toContain(K.ant);
  });

  it('a frozen pre-built seat runs in a pooled agency: its generate() and stream() leave it masked, as an unfrozen seat does', async () => {
    // Each own property of a frozen object is neither writable nor configurable, and a proxy must return such a
    // property's own value: a proxy over the seat itself could not hand out the masking generate and stream.
    const seat = Object.freeze({
      generate: async () => ({ text: `answer ${K.ant}` }),
      stream: () => ({
        textStream: (async function* () { yield `streamed ${K.ant}`; })(),
        text: Promise.resolve(`streamed ${K.ant}`),
        usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
        toolCalls: Promise.resolve([]),
      }),
      session: () => ({}),
      usage: async () => ({}),
      close: async () => {},
    }) as unknown as Agent;
    const team = agency({ modelPool: { opus: POOL().opus }, agents: { seat }, strategy: 'sequential' } as never);
    expect((await team.generate('go')).text).toBe('answer [redacted]');
    const parts: Json[] = [];
    for await (const part of team.stream('go').fullStream) parts.push(part as unknown as Json);
    expect(parts.filter((p) => p.type === 'text').map((p) => p.text).join('')).toBe('streamed [redacted]');
    expect(JSON.stringify(parts)).not.toContain(K.ant);
    expect(fetchMock).not.toHaveBeenCalled();
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
  ])('a tool error echoing the key, thrown and returned, and a tool result that returns it are masked in the transcript, the top-level toolCalls and the next request under a seated and under a pre-built last seat (%s)', async (_mode, callOpts) => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const tools = {
      boom: { description: 'throws', parameters: { type: 'object', properties: {} }, execute: async () => { throw new Error(`tool saw ${K.oaiEnv}`); } },
      soft: { description: 'returns failure', parameters: { type: 'object', properties: {} }, execute: async () => ({ success: false, error: `soft ${K.oaiEnv}` }) },
      // A successful result that holds the key: its turn reaches the seat's next request masked, as the error turns do.
      peek: { description: 'returns the key', parameters: { type: 'object', properties: {} }, execute: async () => ({ key: K.oaiEnv }) },
    };
    const native = () => [openaiToolCall('boom', {}, 'c1'), openaiToolCall('soft', {}, 'c2'), openaiToolCall('peek', {}, 'c3'), openaiText('done')];
    const prompt = () => [openaiText('<tool_call>{"name":"boom","arguments":{}}</tool_call>'), openaiText('<tool_call>{"name":"soft","arguments":{}}</tool_call>'), openaiText('<tool_call>{"name":"peek","arguments":{}}</tool_call>'), openaiText('done')];
    const script = () => (callOpts.toolMode === 'prompt' ? prompt() : native());
    for (const last of ['seated', 'prebuilt'] as const) {
      route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, script()]]);
      const pre = agent({ provider: 'openai', model: 'gpt-4.1', fallbackProviders: [], tools });
      const team = agency({ modelPool: { astra: { provider: 'openai', model: 'gpt-4.1' } }, agents: last === 'seated' ? { one: { instructions: 'x', tools } } : { one: pre }, strategy: 'sequential' } as never);
      const r = await team.generate('go', callOpts);
      const everywhere = JSON.stringify([r.transcriptDelta, r.toolCalls, r.agentCalls.map((c) => c.toolCalls)]);
      expect(everywhere).not.toContain(K.oaiEnv);
      expect(everywhere).toContain('[redacted]');
      expect(calls(OPENAI_CHAT, 'POST').length).toBeGreaterThanOrEqual(4);
      // The seated seat's loops mask before they write the tool turn, so its second and third requests carry no key.
      // A pre-built seat's own loops carry no mask, so its requests are not checked: what it returns (its answer, its
      // transcriptDelta, its tool calls and their errors) is masked as it leaves the seat, above.
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
    const before = ((await team.usage()) as { totalTokens: number }).totalTokens;
    await expect(team.stream('review').text).rejects.toBeInstanceOf(AgencyQuorumError);
    expect(((await team.usage()) as { totalTokens: number }).totalTokens).toBe(before + 15);
  });
});

describe('15-16. seating outside panel', () => {
  it('a sequential pool seats from the pool, fails over to the next candidate with its key, and names who answered', async () => {
    route([[ANTHROPIC, anthropicError(529, 'overloaded')], [OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('rescued')]]);
    const team = agency({ modelPool: POOL(), agents: { a: { instructions: 'x' } }, strategy: 'sequential' } as never);
    const r = await team.generate('go');
    expect(r.seating!.seats.a).toMatchObject({ entry: 'opus', provider: 'anthropic' });
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
    expect((await team.generate('go')).seating!.call).toBe(0);
    vi.unstubAllEnvs();
    const g = agency({ modelPool: { opus: { provider: 'anthropic', model: 'claude-opus-5-5' } }, agents: { root: { instructions: 'r' }, leaf: { instructions: 'l', dependsOn: ['root'] } }, strategy: 'graph' } as never);
    await expect(g.generate('go')).rejects.toBeInstanceOf(AgencySeatingError);
  });
  it('a pooled parallel agency with minProviders 2 and no seating meets its quorum', async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')], [ANTHROPIC, anthropicText('A')], [GEMINI, geminiText('C')]]);
    const r = await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: POOL(), agents: { a: { instructions: 'x' }, b: { instructions: 'y' } }, strategy: 'parallel', quorum: { minProviders: 2 } } as never).generate('go');
    expect(r.seating!.distinct).toBe('vendor');
    expect(new Set(Object.values(r.seating!.seats).map((s) => s.provider)).size).toBe(2);
  });
  it('a nested panel in last position leaks no ledger into a pooled sequential parent', async () => {
    threeProviders();
    const inner = panel();
    const parent = agency({ modelPool: { gemini: POOL().gemini }, agents: { first: { instructions: 'f' }, inner }, strategy: 'sequential' } as never);
    const r = await parent.generate('go');
    expect(r.seating!.seats.first).toMatchObject({ entry: 'gemini' });
    expect(r.seating!.seats.inner).toEqual({ prebuilt: true });
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
  it('rejects a config seat or a chair on the GMI runtime in an agency with a pool or a panel', () => {
    // A GMI seat's calls would skip the strict credentials and the error mask seating gives every seat.
    const gmiSeats: Array<[string, Json]> = [
      ['a pooled seat', { modelPool: POOL(), agents: { a: { instructions: 'x', runtime: 'gmi' } }, strategy: 'sequential' }],
      ['a fixed seat of a panel', { strategy: 'panel', modelPool: POOL(), agents: { ...SEATS(), own: { provider: 'openai', model: 'gpt-4.1', runtime: 'gmi' } }, chair: false }],
      ['a chair', { strategy: 'panel', modelPool: POOL(), agents: SEATS(), chair: { from: ['opus'], runtime: 'gmi' } }],
    ];
    for (const [label, opts] of gmiSeats) {
      expect(() => agency(opts as never), label).toThrow(AgencyConfigError);
      expect(() => agency(opts as never), label).toThrow(/runtime 'gmi' is not available/);
    }
  });
  it("rejects a panel seat named 'chair', the name the chair's record, approvals and callbacks carry, with an AgencyPanelError that names it", () => {
    for (const chair of [{ instructions: 'Merge.' }, agent({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai })]) {
      expect(() => agency({ strategy: 'panel', modelPool: POOL(), agents: { ...SEATS(), chair }, chair: false } as never)).toThrow(AgencyPanelError);
      expect(() => agency({ strategy: 'panel', modelPool: POOL(), agents: { ...SEATS(), chair }, chair: false } as never)).toThrow(/seat "chair"/);
    }
    // The name is only reserved under panel.
    expect(() => agency({ modelPool: POOL(), agents: { chair: { instructions: 'x' } }, strategy: 'sequential' } as never)).not.toThrow();
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
    expect(r.seating!.skipped).toContainEqual({ entry: 'cli', reason: 'binary not found (claude)' });
    expect(r.seating!.seats.a).toMatchObject({ entry: 'astra' });
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
    expect([c1.seating!.call, c2.seating!.call]).toEqual([0, 1]);
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
  it("a run whose every seat is rejected writes one line through the host's logger, which names the agency, its strategy and its seats", async () => {
    const lines = await logLines(async () => {
      const r = (await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { a: { instructions: 'x' }, b: { instructions: 'y' } }, strategy: 'sequential', hitl: { approvals: { beforeAgent: ['a', 'b'] }, handler: hitl.autoReject('no') } } as never).generate('go')) as AgencyResult;
      expect(r.text).toBe('');
      expect(r.agentCalls).toEqual([]);
    });
    expect(lines.filter((l) => l.meta?.event === 'agency_no_seat_answered')).toEqual([
      { level: 'info', message: expect.any(String), meta: { event: 'agency_no_seat_answered', agency: '__agency__', strategy: 'sequential', seats: 2 } },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('a run whose every seat is rejected is no reply to validate: the agency asks the approver once per seat, not again on a retry', async () => {
    const handler = vi.fn(hitl.autoReject('no'));
    const r = (await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { a: { instructions: 'x' }, b: { instructions: 'y' } }, strategy: 'sequential', output: z.object({ ok: z.boolean() }), hitl: { approvals: { beforeAgent: ['a', 'b'] }, handler } } as never).generate('go')) as AgencyResult;
    expect(r.text).toBe('');
    expect(r.parsed).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("parallel and debate call no synthesizer when every seat is rejected: text is '', the run is logged once, and an output schema asks the approver once per seat turn", async () => {
    for (const strategy of ['parallel', 'debate']) {
      fetchMock.mockClear();
      // A synthesizer that ran over no answer would be answered, and its text would be the result's.
      route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('a synthesis of no answer')]]);
      const handler = vi.fn(hitl.autoReject('no'));
      const lines = await logLines(async () => {
        const r = (await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { a: { instructions: 'x' }, b: { instructions: 'y' } }, strategy, maxRounds: 1, output: z.object({ ok: z.boolean() }), hitl: { approvals: { beforeAgent: ['a', 'b'] }, handler } } as never).generate('go')) as AgencyResult;
        expect(r.text).toBe('');
        expect(r.agentCalls).toEqual([]);
        expect(r.parsed).toBeUndefined();
      });
      expect(lines.filter((l) => l.meta?.event === 'agency_no_seat_answered')).toEqual([
        { level: 'info', message: expect.any(String), meta: { event: 'agency_no_seat_answered', agency: '__agency__', strategy, seats: 2 } },
      ]);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
  it("parallel and debate call no synthesizer when every seat is a nested agency whose own seats were all rejected: such a seat gave no answer, as a rejected one, so text is '' and the parent asks no model", async () => {
    for (const strategy of ['parallel', 'debate']) {
      fetchMock.mockClear();
      // A synthesizer that ran over the nested agencies' empty texts would be answered, and its text would be the result's.
      route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('a synthesis of no answer')]]);
      const nested = () => agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { only: { instructions: 'x' } }, strategy: 'sequential', hitl: { approvals: { beforeAgent: ['only'] }, handler: hitl.autoReject('no') } } as never);
      const lines = await logLines(async () => {
        const r = (await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { a: nested(), b: nested() }, strategy, maxRounds: 1 } as never).generate('go')) as AgencyResult;
        expect(r.text).toBe('');
        expect(r.agentCalls).toEqual([]);
      });
      // Each nested agency writes its own line; the parent writes one more, naming its two seats.
      expect(lines.filter((l) => l.meta?.event === 'agency_no_seat_answered' && l.meta?.strategy === strategy)).toEqual([
        { level: 'info', message: expect.any(String), meta: { event: 'agency_no_seat_answered', agency: '__agency__', strategy, seats: 2 } },
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
  it("sequential and graph take a nested agency that no seat of its own answered as a rejected seat: no call record, no empty answer handed on, and the run's text is the answer a seat gave, in generate() and in stream()", async () => {
    const quiet = () => agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { only: { instructions: 'x' } }, strategy: 'sequential', hitl: { approvals: { beforeAgent: ['only'] }, handler: hitl.autoReject('no') } } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('draft')]]);
    const seq = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { writer: { instructions: 'w' }, quiet: quiet() }, strategy: 'sequential' } as never);
    const generated = await seq.generate('go');
    expect(generated.text).toBe('draft');
    expect(generated.agentCalls.map((c) => c.agent)).toEqual(['writer']);
    const streamed = seq.stream('go');
    const parts: unknown[] = [];
    for await (const part of streamed.fullStream) parts.push(part);
    const final = await streamed.result;
    expect(final.text).toBe('draft');
    expect(final.agentCalls.map((c) => c.agent)).toEqual(['writer']);
    // A graph node that depends on such an agency is sent the rejected seat's marker, not an empty output.
    for (const mode of ['generate', 'stream'] as const) {
      fetchMock.mockClear();
      const graph = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { quiet: quiet(), user: { instructions: 'u', dependsOn: ['quiet'] } }, strategy: 'graph' } as never);
      let result: AgencyResult;
      if (mode === 'generate') result = await graph.generate('go');
      else {
        const graphStream = graph.stream('go');
        for await (const part of graphStream.fullStream) parts.push(part);
        result = await graphStream.result;
      }
      expect(result.agentCalls.map((c) => c.agent)).toEqual(['user']);
      const sent = calls(OPENAI_CHAT, 'POST').map((c) => JSON.stringify(c.body?.messages ?? []));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('[skipped by HITL]');
    }
  });
  it("review-loop and hierarchical take a nested agency that no seat of its own answered as a rejected seat: no reviewer reads an empty draft, and a manager is told its delegate gave no answer", async () => {
    const quiet = () => agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { only: { instructions: 'x' } }, strategy: 'sequential', hitl: { approvals: { beforeAgent: ['only'] }, handler: hitl.autoReject('no') } } as never);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('{"approved":false,"feedback":"write something"}')]]);
    const loop = await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { producer: quiet(), reviewer: { instructions: 'r' } }, strategy: 'review-loop' } as never).generate('go');
    expect(loop.text).toBe('');
    expect(loop.agentCalls).toEqual([]);
    expect(calls(OPENAI_CHAT, 'POST')).toEqual([]);
    fetchMock.mockClear();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('delegate_to_quiet', { task: 't' }), openaiText('done')]]]);
    const managed = await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { quiet: quiet() }, strategy: 'hierarchical' } as never).generate('go');
    expect(managed.text).toBe('done');
    expect(managed.agentCalls.map((c) => c.agent)).not.toContain('quiet');
    const second = calls(OPENAI_CHAT, 'POST')[1];
    expect(JSON.stringify(second?.body?.messages ?? [])).toContain('gave no answer');
  });
  it("a pooled parallel agency logs a failed pre-built seat through the host's logger with its message masked, and writes it to no console", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('synth')], [ANTHROPIC, anthropicText('A')]]);
      const failing = { generate: async () => { throw new Error(`upstream rejected ${K.oaiEnv}`); }, stream: () => { throw new Error('unused'); }, session: () => ({}), usage: async () => ({}), close: async () => {} } as unknown as Agent;
      const lines = await logLines(async () => {
        const r = await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: { opus: POOL().opus }, agents: { a: { instructions: 'x' }, failing }, strategy: 'parallel' } as never).generate('go');
        expect(r.text).toBe('synth');
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(K.oaiEnv);
      const failed = lines.filter((l) => l.meta?.event === 'parallel_seat_failed');
      expect(failed).toEqual([{ level: 'warn', message: expect.any(String), meta: { event: 'parallel_seat_failed', agent: 'failing', error: 'upstream rejected [redacted]' } }]);
      expect(JSON.stringify(lines)).not.toContain(K.oaiEnv);
    } finally {
      consoleError.mockRestore();
    }
  });
  it("a panel shortfall under onShortfall: 'proceed' is written through the host's logger as panel_quorum_shortfall, and to no console", async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(500, 'down')], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, geminiError(500, 'down')]]);
      const lines = await logLines(async () => {
        const r = await panel({ quorum: { onShortfall: 'proceed' } }).generate('review');
        expect(r.quorum.met).toBe(false);
        expect(r.text).toBe('Merged');
      });
      expect(lines.filter((l) => l.meta?.event === 'panel_quorum_shortfall')).toEqual([
        { level: 'warn', message: expect.stringContaining('proceeding'), meta: { event: 'panel_quorum_shortfall', shortfall: 'panel quorum shortfall: 1/3 seats healthy (need 2)' } },
      ]);
      expect(consoleWarn.mock.calls.filter(([first]) => String(first).includes('[AgentOS][Panel]'))).toEqual([]);
    } finally {
      consoleWarn.mockRestore();
    }
  });
  it("a panel seat whose key is refused, whose deadline passes or that finds no entry to sit on is written through the host's logger as panel_seat_failed, its message masked, though the run meets its quorum", async () => {
    vi.stubEnv('XAI_API_KEY', '');
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiError(401, `rejected key ${K.oai} by upstream`)], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]], [GEMINI, never]]);
    const lines = await logLines(async () => {
      const r = await agency({
        strategy: 'panel',
        modelPool: { ...POOL(), grok: { provider: 'xai', model: 'grok-4' } },
        agents: { ...SEATS(), extra: { instructions: 'x', from: ['grok'] } },
        chair: { from: ['opus'], instructions: 'Merge.' },
        panel: { seatDeadlineMs: 300 },
        quorum: { minAgents: 1 },
      } as never).generate('review');
      expect(r.text).toBe('Merged');
      expect(r.seats.map((s) => [s.seat, s.status])).toEqual([['correctness', 'ok'], ['security', 'error'], ['failure', 'timeout'], ['extra', 'unseated']]);
    });
    const failed = lines.filter((l) => l.meta?.event === 'panel_seat_failed');
    expect(failed.map((l) => [l.level, l.meta?.agent, l.meta?.status]).sort()).toEqual([['warn', 'extra', 'unseated'], ['warn', 'failure', 'timeout'], ['warn', 'security', 'error']]);
    expect(failed.find((l) => l.meta?.agent === 'security')?.meta?.error).toContain('rejected key [redacted] by upstream');
    expect(failed.find((l) => l.meta?.agent === 'failure')?.meta?.error).toBe('seat "failure" timed out after 300ms');
    expect(failed.find((l) => l.meta?.agent === 'extra')?.meta?.error).toContain('XAI_API_KEY');
    expect(JSON.stringify(lines)).not.toContain(K.oai);
  });
  it("an agentStart callback that throws on a pooled agency's first call, before the call is seated, is written through the host's logger masked: the mask holds the configured keys from construction", async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      threeProviders();
      const lines = await logLines(async () => {
        // The agency's own agentStart fires before seatForCall lists the call's keys; the pool's keys are written in the config.
        const r = await panel({ on: { agentStart: () => { throw new Error(`callback saw ${K.ant}`); } } }).generate('review');
        expect(r.text).toBe('Merged findings');
      });
      const threw = lines.filter((l) => l.meta?.event === 'agency_callback_threw' && l.meta?.callback === 'agentStart');
      expect(threw.length).toBeGreaterThanOrEqual(1);
      for (const line of threw) expect(line.meta).toEqual({ event: 'agency_callback_threw', callback: 'agentStart', error: 'callback saw [redacted]' });
      expect(JSON.stringify(lines)).not.toContain(K.ant);
    } finally {
      consoleWarn.mockRestore();
    }
  });
  it("a callback that throws is written through the host's logger as agency_callback_threw with its message masked, and to no console", async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      threeProviders();
      const lines = await logLines(async () => {
        const r = await panel({ on: { agentEnd: () => { throw new Error(`callback saw ${K.ant}`); } } }).generate('review');
        expect(r.text).toBe('Merged findings');
      });
      // The seats' and the chair's agentEnd through the panel's callbacks, and the agency's own through its runner.
      const threw = lines.filter((l) => l.meta?.event === 'agency_callback_threw');
      expect(threw.length).toBeGreaterThanOrEqual(2);
      for (const line of threw) expect(line).toEqual({ level: 'warn', message: expect.any(String), meta: { event: 'agency_callback_threw', callback: 'agentEnd', error: 'callback saw [redacted]' } });
      expect(JSON.stringify(lines)).not.toContain(K.ant);
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain(K.ant);
      expect(consoleWarn.mock.calls.filter(([first]) => /callback threw/.test(String(first)))).toEqual([]);
    } finally {
      consoleWarn.mockRestore();
    }
  });
  it("an async callback that rejects is written through the host's logger as agency_callback_threw with its message masked, and leaves no rejection unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      threeProviders();
      const lines = await logLines(async () => {
        const r = await panel({ on: { agentEnd: async () => { throw new Error(`callback saw ${K.ant}`); } } }).generate('review');
        expect(r.text).toBe('Merged findings');
        // A callback's rejection settles after the call that fired it: let it land before the host's factory is reset.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const threw = lines.filter((l) => l.meta?.event === 'agency_callback_threw');
      expect(threw.length).toBeGreaterThanOrEqual(2);
      for (const line of threw) expect(line).toEqual({ level: 'warn', message: expect.any(String), meta: { event: 'agency_callback_threw', callback: 'agentEnd', error: 'callback saw [redacted]' } });
      expect(JSON.stringify(lines)).not.toContain(K.ant);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
  it("a callback a strategy fires that throws fails no call of an agency without a pool and is written through the host's logger, and that agency's trail records what its strategy fires", async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('Merged')]]);
    const seat = (generate: () => Promise<unknown>) => ({ generate, stream: () => { throw new Error('unused'); }, session: () => ({}), usage: async () => ({}), close: async () => {} }) as unknown as Agent;
    const answering = seat(async () => ({ text: 'B', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }));
    const failing = seat(async () => { throw new Error('seat down'); });
    const lines = await logLines(async () => {
      // parallel fires on.error for its failed seat itself; the handler throws, and the other seat's answer is still synthesized.
      const parallel = await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { a: failing, b: answering }, strategy: 'parallel', on: { error: () => { throw new Error('error handler down'); } } } as never).generate('go');
      expect(parallel.text).toBe('Merged');
      // sequential fires a beforeAgent approval's approvalRequested and approvalDecided itself; both throw, and the approved seat still answers.
      const sequential = await agency({
        provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { b: answering }, strategy: 'sequential', provenance: { enabled: true },
        hitl: { approvals: { beforeAgent: ['b'] }, handler: hitl.autoApprove(), guardrailOverride: false },
        on: { approvalRequested: () => { throw new Error('requested handler down'); }, approvalDecided: () => { throw new Error('decided handler down'); } },
      } as never).generate('go');
      expect(sequential.text).toBe('B');
      // The decision the strategy fired is in the trail, as the agency's own events are.
      expect(sequential.provenanceTrail!.events.filter((e) => e.kind === 'approvalDecided').map((e) => e.payload.approved)).toEqual([true]);
    });
    expect(lines.filter((l) => l.meta?.event === 'agency_callback_threw').map((l) => [l.level, l.meta?.callback, l.meta?.error])).toEqual([
      ['warn', 'error', 'error handler down'],
      ['warn', 'approvalRequested', 'requested handler down'],
      ['warn', 'approvalDecided', 'decided handler down'],
    ]);
  });
  it("a callback the host sets, replaces or deletes on its on object after agency() returns is the one that runs at the next call, guarded: in an agency without a pool, and in a panel whose error callback and trail wrapped on at construction", async () => {
    const answering = { generate: async () => ({ text: 'B', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }), stream: () => { throw new Error('unused'); }, session: () => ({}), usage: async () => ({}), close: async () => {} } as unknown as Agent;
    const seen: string[] = [];
    const on: AgencyCallbacks = { agentEnd: () => { seen.push('first agentEnd'); } };
    const plain = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { b: answering }, strategy: 'sequential', on } as never);
    // Replaced and added after construction: the new agentEnd runs in place of the first, and the added agentStart, which throws, runs guarded.
    on.agentEnd = (e) => { seen.push(`agentEnd ${e.agent}`); };
    on.agentStart = (e) => { seen.push(`agentStart ${e.agent}`); throw new Error('added handler down'); };
    const lines = await logLines(async () => {
      expect((await plain.generate('go')).text).toBe('B');
      // Deleted after the first call: the next call runs without it.
      delete on.agentStart;
      expect((await plain.generate('again')).text).toBe('B');
    });
    expect(seen).toEqual(['agentStart __agency__', 'agentEnd __agency__', 'agentEnd __agency__']);
    expect(lines.filter((l) => l.meta?.event === 'agency_callback_threw').map((l) => [l.meta?.callback, l.meta?.error])).toEqual([['agentStart', 'added handler down']]);
    // A panel's error callback and its trail wrap on at construction; an agentEnd added after still runs for every seat, the chair and the agency.
    threeProviders();
    const panelOn: AgencyCallbacks = { error: () => {} };
    const team = panel({ on: panelOn, provenance: { enabled: true } });
    const ended: string[] = [];
    panelOn.agentEnd = (e) => { ended.push(e.agent); };
    expect((await team.generate('review')).text).toBe('Merged findings');
    expect([...ended].sort()).toEqual(['__agency__', 'chair', 'correctness', 'failure', 'security']);
  });
  it("a callback getter on the host's on object is read when its event fires, never by agency(): one that throws fails no construction and is written as agency_callback_threw at its event, and one whose event never fires is never read, in an agency without a pool and in a panel", async () => {
    const answering = { generate: async () => ({ text: 'B', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }), stream: () => { throw new Error('unused'); }, session: () => ({}), usage: async () => ({}), close: async () => {} } as unknown as Agent;
    const read: string[] = [];
    /** An on object whose agentStart and emergentForge are enumerable getters that throw when read. */
    const gettersOn = (): AgencyCallbacks => {
      const on: AgencyCallbacks = {};
      for (const name of ['agentStart', 'emergentForge'] as const) {
        Object.defineProperty(on, name, { enumerable: true, configurable: true, get: () => { read.push(name); throw new Error(`${name} getter down`); } });
      }
      return on;
    };
    const plain = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { b: answering }, strategy: 'sequential', on: gettersOn() } as never);
    threeProviders();
    const team = panel({ on: gettersOn() });
    // Neither construction read a getter.
    expect(read).toEqual([]);
    const lines = await logLines(async () => {
      expect((await plain.generate('go')).text).toBe('B');
      expect((await team.generate('review')).text).toBe('Merged findings');
    });
    // agentStart fired for each agency (and the panel's seats and chair) and was read at each event; emergentForge never fired.
    expect(read.length).toBeGreaterThanOrEqual(2);
    expect(new Set(read)).toEqual(new Set(['agentStart']));
    const threw = lines.filter((l) => l.meta?.event === 'agency_callback_threw');
    expect(threw.length).toBe(read.length);
    for (const line of threw) expect(line.meta).toEqual({ event: 'agency_callback_threw', callback: 'agentStart', error: 'agentStart getter down' });
  });
  it('a run no seat answered adds no assistant turn to its session: messages() keeps the user turn alone, in send() and in stream(), and the next prompt carries no empty answer', async () => {
    let decide: (r: ApprovalRequest) => Promise<ApprovalDecision> = hitl.autoReject('no');
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')]]);
    const team = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { a: { instructions: 'x' } }, strategy: 'sequential', hitl: { approvals: { beforeAgent: ['a'] }, handler: (r: ApprovalRequest) => decide(r) } } as never);
    const session = team.session('s') as { send: (t: string) => Promise<AgencyResult>; stream: (t: string) => { textStream: AsyncIterable<string>; text: Promise<string> }; messages: () => Array<{ role: string; content: string }> };
    expect((await session.send('first')).text).toBe('');
    expect(session.messages()).toEqual([{ role: 'user', content: 'first' }]);
    const streamed = session.stream('second');
    for await (const chunk of streamed.textStream) void chunk;
    expect(await streamed.text).toBe('');
    expect(session.messages()).toEqual([{ role: 'user', content: 'first' }, { role: 'user', content: 'second' }]);
    expect(fetchMock).not.toHaveBeenCalled();
    decide = hitl.autoApprove();
    expect((await session.send('third')).text).toBe('B');
    const sent = calls(OPENAI_CHAT, 'POST');
    expect(sent).toHaveLength(1);
    const content = (sent[0].body!.messages as Json[]).filter((m) => m.role === 'user').at(-1)?.content;
    const userText = Array.isArray(content) ? content.map((p: Json) => String(p.text ?? '')).join('') : String(content ?? '');
    expect(userText).toBe('User: first\nUser: second\nUser: third');
    expect(session.messages()).toEqual([{ role: 'user', content: 'first' }, { role: 'user', content: 'second' }, { role: 'user', content: 'third' }, { role: 'assistant', content: 'B' }]);
  });
  it("a seat that answers with no text adds no assistant turn either: messages() keeps the user turn, and the next prompt carries no empty answer", async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiText(''), openaiText('B')]]]);
    const team = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { a: { instructions: 'x' } }, strategy: 'sequential' } as never);
    const session = team.session('s') as { send: (t: string) => Promise<AgencyResult>; messages: () => Array<{ role: string; content: string }> };
    const first = await session.send('first');
    expect(first.text).toBe('');
    expect(first.agentCalls).toHaveLength(1);
    expect(session.messages()).toEqual([{ role: 'user', content: 'first' }]);
    expect((await session.send('second')).text).toBe('B');
    const sent = calls(OPENAI_CHAT, 'POST');
    expect(sent).toHaveLength(2);
    const content = (sent[1].body!.messages as Json[]).filter((m) => m.role === 'user').at(-1)?.content;
    const userText = Array.isArray(content) ? content.map((p: Json) => String(p.text ?? '')).join('') : String(content ?? '');
    expect(userText).toBe('User: first\nUser: second');
    expect(session.messages()).toEqual([{ role: 'user', content: 'first' }, { role: 'user', content: 'second' }, { role: 'assistant', content: 'B' }]);
  });
  it("parallel rejects when no seat is left and a seat failed: an outage is the seats' failure, not a run no seat answered, so the call throws the first failed seat's error, masked, after each failure is logged, and asks no synthesizer", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    // A synthesizer that ran over no answer would be answered, and the call would resolve with its text.
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('a synthesis of no answer')], [ANTHROPIC, anthropicText('A')]]);
    const failing = (what: string) => ({ generate: async () => { throw new Error(`${what} rejected ${K.oaiEnv}`); }, stream: () => { throw new Error('unused'); }, session: () => ({}), usage: async () => ({}), close: async () => {} }) as unknown as Agent;
    const lines = await logLines(async () => {
      const err = await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: { opus: POOL().opus }, agents: { a: failing('first'), b: failing('second') }, strategy: 'parallel' } as never).generate('go').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('first rejected [redacted]');
    });
    expect(lines.filter((l) => l.meta?.event === 'parallel_seat_failed').map((l) => l.meta?.agent)).toEqual(['a', 'b']);
    expect(lines.filter((l) => l.meta?.event === 'agency_no_seat_answered')).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain(K.oaiEnv);
    // A seat its approver rejected beside one that failed: no seat is left, and the failure is the call's.
    const mixed = await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { a: { instructions: 'x' }, b: failing('only') }, strategy: 'parallel', hitl: { approvals: { beforeAgent: ['a'] }, handler: hitl.autoReject('no') } } as never).generate('go').catch((e: unknown) => e);
    expect(mixed).toBeInstanceOf(Error);
    expect((mixed as Error).message).toContain('only rejected');
    // No synthesizer was asked in either run.
    expect(calls(OPENAI_CHAT, 'POST')).toEqual([]);
    expect(calls(ANTHROPIC, 'POST')).toEqual([]);
  });
  it("a parallel quorum that no seat meets because each failed throws AgencyQuorumError with the first failed seat's error, masked, as its cause, and asks no synthesizer", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('a synthesis of no answer')]]);
    const failing = (what: string) => ({ generate: async () => { throw new Error(`${what} rejected ${K.oaiEnv}`); }, stream: () => { throw new Error('unused'); }, session: () => ({}), usage: async () => ({}), close: async () => {} }) as unknown as Agent;
    const err = await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.chair, modelPool: { opus: POOL().opus }, agents: { a: failing('first'), b: failing('second') }, strategy: 'parallel', quorum: { minAgents: 1 } } as never).generate('go').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgencyQuorumError);
    const cause = (err as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toBe('first rejected [redacted]');
    expect(ownStrings(err)).not.toContain(K.oaiEnv);
    expect(calls(OPENAI_CHAT, 'POST')).toEqual([]);
  });
  it("a plain seat that answers with no text on a provider that reports no tokens answered: parallel counts it toward the quorum and hands it to the synthesizer, and debate records its turn", async () => {
    // A CLI provider reports 0 tokens when it reads no usage; a reply with no text from it is still the seat's answer.
    const emptyAnswer = () => json({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    for (const strategy of ['parallel', 'debate']) {
      fetchMock.mockClear();
      route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, (req) => {
        const sent = JSON.stringify(req.body?.messages ?? []);
        return sent.includes('seat-b') ? emptyAnswer() : sent.includes('seat-a') ? openaiText('A')(req) : openaiText('synth')(req);
      }]]);
      const r = (await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { a: { instructions: 'seat-a' }, b: { instructions: 'seat-b' } }, strategy, maxRounds: 1, ...(strategy === 'parallel' ? { quorum: { minAgents: 2 } } : {}) } as never).generate('go')) as AgencyResult;
      expect(r.agentCalls.map((c) => [c.agent, c.output])).toEqual([['a', 'A'], ['b', '']]);
      expect(r.text).toBe('synth');
    }
  });
  it("a manager that answers with no text on a provider that reports no tokens ran: the run is not logged as one no seat answered, and an output schema retries it", async () => {
    const emptyAnswer = () => json({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [emptyAnswer, openaiText('{"ok":true}')]]]);
    const lines = await logLines(async () => {
      const r = (await agency({ provider: 'openai', model: 'gpt-4.1', apiKey: K.oai, agents: { worker: { instructions: 'w' } }, strategy: 'hierarchical', output: z.object({ ok: z.boolean() }) } as never).generate('go')) as AgencyResult;
      expect(r.parsed).toEqual({ ok: true });
    });
    expect(lines.filter((l) => l.meta?.event === 'agency_no_seat_answered')).toEqual([]);
    expect(calls(OPENAI_CHAT, 'POST')).toHaveLength(2);
  });
});

describe('25-26. approvals under panel and nested agencies', () => {
  const searchTool = () => ({ search: { description: 's', parameters: { type: 'object' as const, properties: { q: { type: 'string' } } }, execute: vi.fn(async () => ({ hits: 1 })) } });
  const toolThenText = (text: string) => [openaiToolCall('search', { q: 'x' }), openaiText(text)];
  it("a beforeReturn approval's replacement that holds a listed key leaves a pooled agency masked: the result's text, the final-output part, agentEnd and the provenance trail, in generate() and in stream()", async () => {
    const ends: Json[] = [];
    const handler = async () => ({ approved: true, modifications: { output: `signed off with ${K.ant}` } });
    threeProviders();
    const team = panel({ provenance: { enabled: true }, hitl: { approvals: { beforeReturn: true }, handler, guardrailOverride: false }, on: { agentEnd: (e: Json) => ends.push(e) } });
    const r = await team.generate('review');
    expect(r.text).toBe('signed off with [redacted]');
    expect(JSON.stringify(r.provenanceTrail)).toContain('signed off with [redacted]');
    expect(ends.find((e) => e.agent === 'panel' || e.agent === 'agency')?.output ?? ends.at(-1)?.output).toBe('signed off with [redacted]');
    expect(JSON.stringify([r, ends])).not.toContain(K.ant);
    threeProviders();
    ends.length = 0;
    const streamed = team.stream('review');
    const parts: Json[] = [];
    for await (const part of streamed.fullStream) parts.push(part as unknown as Json);
    const final = parts.find((p) => p.type === 'final-output');
    expect(final?.text).toBe('signed off with [redacted]');
    expect((await streamed.result).text).toBe('signed off with [redacted]');
    expect(JSON.stringify([parts, ends, await streamed.result])).not.toContain(K.ant);
  });
  it("a beforeAgent approval's reason that quotes a listed key reaches the host's approvalDecided and the provenance trail masked in a pooled agency", async () => {
    const decided: Json[] = [];
    threeProviders();
    const team = panel({ provenance: { enabled: true }, hitl: { approvals: { beforeAgent: ['correctness'] }, handler: async () => ({ approved: true, reason: `cleared, saw ${K.ant}` }) }, on: { approvalDecided: (d: Json) => decided.push(d) } });
    const r = await team.generate('review');
    expect(r.text).toBe('Merged findings');
    expect(decided).toEqual([{ approved: true, reason: 'cleared, saw [redacted]' }]);
    const records = r.provenanceTrail!.events.filter((e) => e.kind === 'approvalDecided').map((e) => e.payload);
    expect(records).toEqual([{ approved: true, reason: 'cleared, saw [redacted]' }]);
    expect(JSON.stringify([r, decided])).not.toContain(K.ant);
  });
  it("a decision's numbers are the approver's: a key of digits in modifications.toolArgs reaches the host's approvalDecided and the provenance trail masked in a pooled agency", async () => {
    const digits = '12345678';
    const decided: Json[] = [];
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('B')]]);
    const team = agency({ modelPool: { astra: { provider: 'openai', model: 'gpt-4.1', apiKey: digits } }, agents: { only: { instructions: 'x' } }, strategy: 'sequential', provenance: { enabled: true }, hitl: { approvals: { beforeAgent: ['only'] }, handler: async () => ({ approved: true, modifications: { toolArgs: { pin: 12345678 } } }) }, on: { approvalDecided: (d: Json) => decided.push(d) } } as never);
    const r = await team.generate('go');
    expect(r.text).toBe('B');
    expect(decided).toEqual([{ approved: true, modifications: { toolArgs: { pin: '[redacted]' } } }]);
    const records = r.provenanceTrail!.events.filter((e) => e.kind === 'approvalDecided').map((e) => e.payload);
    expect(records).toEqual([{ approved: true, modifications: { toolArgs: { pin: '[redacted]' } } }]);
    expect(JSON.stringify([r.provenanceTrail, decided])).not.toContain(digits);
  });
  it("a pooled seat's token counts stay numbers under the mask: a key of digits that a count contains leaves the result's, the seat's, the call record's and the final-output part's usage and the agency's totals as numbers", async () => {
    const digits = '12345678';
    const usage = { prompt_tokens: 12345678, completion_tokens: 5, total_tokens: 12345683 };
    const reply = (text: string) => (req?: Captured) =>
      req?.body?.stream === true
        ? sse([oaiChunk('gpt-4.1', { role: 'assistant', content: text }), oaiChunk('gpt-4.1', {}, 'stop'), oaiChunk('gpt-4.1', null, null, usage), '[DONE]'])
        : json({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage });
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, reply('B')]]);
    const team = agency({ strategy: 'panel', modelPool: { astra: { provider: 'openai', model: 'gpt-4.1', apiKey: digits } }, agents: { only: { instructions: 'x' } }, chair: false } as never);
    const r = await team.generate('review');
    expect(r.agentCalls).toHaveLength(1);
    expect(r.usage).toMatchObject({ promptTokens: 12345678, completionTokens: 5, totalTokens: 12345683 });
    expect(r.agentCalls[0]?.usage).toMatchObject({ promptTokens: 12345678, totalTokens: 12345683 });
    expect(r.seats[0]?.usage).toMatchObject({ promptTokens: 12345678, totalTokens: 12345683 });
    expect(await team.usage()).toMatchObject({ promptTokens: 12345678, totalTokens: 12345683 });
    const session = team.session('s') as { send: (t: string) => Promise<AgencyResult> };
    expect((await session.send('again')).usage.promptTokens).toBe(12345678);
    const streamed = team.stream('review');
    const parts: Json[] = [];
    for await (const part of streamed.fullStream) parts.push(part as unknown as Json);
    expect(parts.find((p) => p.type === 'final-output')?.usage).toMatchObject({ promptTokens: 12345678, totalTokens: 12345683 });
    expect((await streamed.result).usage.promptTokens).toBe(12345678);
    expect(((await team.usage()) as { promptTokens: number }).promptTokens).toBe(12345678 * 3);
  });
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
  it("under a pooled sequential agency a handler error that echoes a key rejects the call masked and reaches on.error masked, and the handler's own error is left as it is", async () => {
    const tools = searchTool();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('search', { q: 'x' }), openaiText('done')]]]);
    const own = new Error(`approval service saw ${K.oai}`);
    const errors: Json[] = [];
    const team = agency({ modelPool: { astra: POOL().astra }, agents: { one: { instructions: 'x' } }, strategy: 'sequential', tools, hitl: { approvals: { beforeTool: ['search'] }, handler: async () => { throw own; } }, on: { error: (e: Json) => errors.push(e) } } as never);
    const err = await team.generate('go').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBe(own);
    expect(err.message).toContain('[redacted]');
    expect(ownStrings(err)).not.toContain(K.oai);
    // The handler's error belongs to the caller: the agency masks a copy and never writes the original.
    expect(own.message).toBe(`approval service saw ${K.oai}`);
    expect(errors).toHaveLength(1);
    expect(ownStrings(errors[0].error)).not.toContain(K.oai);
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
  it("a seat starting after a sibling's 401 opened its key's breaker is error with reason circuit open; a seat on another key runs", async () => {
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiError(401, 'bad key'), openaiText('second key')]], [ANTHROPIC, anthropicText('Merged')]]);
    const r = await agency({ strategy: 'panel', modelPool: { a1: POOL().astra, a2: { ...POOL().astra, apiKey: K.second }, opus: POOL().opus }, seating: { distinct: false }, agents: { s1: { instructions: 'x', from: ['a1'] }, s2: { instructions: 'y', from: ['a2'] }, s3: { instructions: 'z', from: ['a1'] } }, chair: { from: ['opus'] }, panel: { concurrency: 1 }, quorum: { minAgents: 0 } } as never).generate('review').catch((e) => e);
    const seats = r instanceof Error ? (r as Json).seats : r.seats;
    // Each key has its own breaker: s1's 401 opened K.oai's, so s3 on that key is stopped at its start and sends
    // nothing, while s2 on K.second runs. The exact reason is the panel's own: a call that reached generateText's
    // breaker check would end with "[503] Provider 'openai' circuit open; cooldown ...".
    expect(seats.find((s: Json) => s.seat === 's3')).toMatchObject({ status: 'error', error: 'circuit open' });
    expect(seats.find((s: Json) => s.seat === 's2')).toMatchObject({ status: 'ok', text: 'second key' });
    expect(calls(OPENAI_CHAT, 'POST').map((c) => header(c, 'Authorization'))).toEqual([`Bearer ${K.oai}`, `Bearer ${K.second}`]);
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
  it("a panel nested in a panel is stopped at the parent's deadline: each child seat sends one request, none is retried after it, and the breaker stays closed; the parent's gate holds on nested tools and a parent handler error fills the parent's slot", async () => {
    vi.useFakeTimers();
    // The OpenAI stub rejects on abort. The parent's deadline is passed down as requestTimeout, and when it fires the
    // parent stops its seat, which aborts each inner seat's call. Five failures on one provider would open its breaker
    // (transient threshold 5); an abort is not recorded.
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, ({ init }) => new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); })], [ANTHROPIC, [anthropicText('A'), anthropicText('Merged')]]]);
    const inner = agency({ strategy: 'panel', modelPool: { astra: POOL().astra }, seating: { distinct: false }, agents: { p1: { instructions: 'a' }, p2: { instructions: 'b' }, p3: { instructions: 'c' }, p4: { instructions: 'd' }, p5: { instructions: 'e' } }, chair: false, quorum: { minAgents: 0 } } as never);
    const outer = agency({ strategy: 'panel', modelPool: { opus: POOL().opus }, agents: { innerSeat: inner, own: { instructions: 'o' } }, chair: { from: ['opus'] }, panel: { seatDeadlineMs: 500 }, quorum: { minAgents: 1 } } as never);
    const pending = outer.generate('review');
    await vi.advanceTimersByTimeAsync(600);
    const r = await pending;
    expect(r.seats.find((s) => s.seat === 'innerSeat')).toMatchObject({ status: 'timeout' });
    // Without the stop, each inner seat's call would make the provider's three attempts, the last ending within 4,500 ms
    // of the start. The breaker is read after that point.
    await vi.advanceTimersByTimeAsync(10_000);
    const innerPosts = calls(OPENAI_CHAT, 'POST');
    expect(innerPosts).toHaveLength(5); // five seats, one attempt each; the own seat and the chair are on Anthropic, and a seat with one candidate has no chain
    expect(innerPosts.every((c) => c.init.signal?.aborted)).toBe(true);
    expect(globalLLMProviderHealth.isOpen(astraHealth())).toBe(false);
    vi.useRealTimers();
    const tools = searchTool();
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiToolCall('search', { q: 'x' }), openaiText('inner done')]]]);
    const childHandler = vi.fn(async () => ({ approved: true }));
    const child = agency({ modelPool: { astra: POOL().astra }, agents: { inner: { instructions: 'i' } }, strategy: 'sequential', tools, hitl: { approvals: { beforeTool: ['search'] }, handler: childHandler } } as never);
    const parent = agency({ agents: { child }, strategy: 'sequential', hitl: { approvals: { beforeTool: ['search'] }, handler: async () => { throw new Error('parent handler failed'); } } } as never);
    await expect(parent.generate('go')).rejects.toThrow('parent handler failed');
    expect(childHandler).not.toHaveBeenCalled();
    expect(tools.search.execute).not.toHaveBeenCalled();
    expect(((await child.usage()) as { totalTokens: number }).totalTokens).toBe(30);
  });
});

describe('24. a tool table that grows mid-call', () => {
  const toolNames = (c: Captured): string[] => ((c.body?.tools ?? []) as Json[]).map((t) => t.function?.name as string);
  /** The stream read to its end, then its text: streamText's promises settle once a consumer has read the stream, and `text` awaited alone starts no request (27 below). */
  const drained = async (st: { fullStream: AsyncIterable<unknown>; text: Promise<string> }): Promise<string> => { for await (const part of st.fullStream) void part; return st.text; };
  it.each(['generate', 'stream'] as const)("a tool that a tool's execute adds to the table is in the next step's request and runs when the model calls it, in %s()", async (api) => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const ran: string[] = [];
    const table: Record<string, unknown> = {
      add_tool: { description: 'adds second', parameters: { type: 'object', properties: {} }, execute: async () => {
        table.second = { description: 'second', parameters: { type: 'object', properties: {} }, execute: async () => { ran.push('second'); return 'second ran'; } };
        return 'added';
      } },
    };
    let turn = 0;
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, (req) => { turn += 1; return turn === 1 ? openaiToolCall('add_tool', {}, 'c1')(req) : turn === 2 ? openaiToolCall('second', {}, 'c2')(req) : openaiText('done')(req); }]]);
    const a = agent({ provider: 'openai', model: 'gpt-4.1', instructions: 'x', tools: table as never, maxSteps: 5 });
    const text = api === 'generate' ? (await a.generate('go')).text : await drained(a.stream('go'));
    expect(text).toBe('done');
    expect(ran).toEqual(['second']);
    expect(calls(OPENAI_CHAT, 'POST').map(toolNames)).toEqual([['add_tool'], ['add_tool', 'second'], ['add_tool', 'second']]);
  });
  it("a specialist spawn_specialist adds mid-run is in the manager's next request and runs when the manager calls it", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const isManager = (body: Json | undefined) => ((body?.tools ?? []) as Json[]).some((t) => t.function?.name === 'spawn_specialist');
    let managerTurn = 0;
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, (req) => {
      if (!isManager(req.body)) return openaiText('helped')(req);
      managerTurn += 1;
      return managerTurn === 1 ? openaiToolCall('spawn_specialist', { role: 'helper', instructions: 'Help.' }, 'c1')(req)
        : managerTurn === 2 ? openaiToolCall('delegate_to_helper', { task: 'v' }, 'c2')(req)
        : openaiText('manager done')(req);
    }]]);
    const team = agency({ provider: 'openai', model: 'gpt-4.1', agents: { worker: { instructions: 'w' } }, strategy: 'hierarchical', emergent: { enabled: true } } as never);
    const r = await team.generate('go');
    expect(r.text).toBe('manager done');
    const managerRequests = calls(OPENAI_CHAT, 'POST').filter((c) => isManager(c.body));
    // The spawned specialist's delegate tool is in the manager's next request, and its answer, not a "not found", is the
    // tool turn the request after it carries.
    expect(managerRequests.map((c) => toolNames(c).includes('delegate_to_helper'))).toEqual([false, true, true]);
    expect(JSON.stringify(managerRequests[2].body!.messages)).toContain('helped');
    expect(JSON.stringify(managerRequests[2].body!.messages)).not.toContain('not found');
    expect(r.agentCalls.map((c) => [c.agent, c.output])).toEqual([['helper', 'helped']]);
  });
  /** The tool names the prompt shim lists in a request's tool block, or none. */
  const shimToolNames = (c: Captured): string[] => {
    const textOf = (content: unknown): string => (Array.isArray(content) ? content.map((p: Json) => String(p?.text ?? '')).join('') : String(content ?? ''));
    const block = ((c.body?.messages ?? []) as Json[]).map((m) => textOf(m.content)).find((t) => t.includes('<tools>'));
    const manifest = block ? /<tools>\n([\s\S]*?)\n<\/tools>/.exec(block)?.[1] : undefined;
    return manifest ? (JSON.parse(manifest) as Json[]).map((t) => t.name as string) : [];
  };
  it.each(['generate', 'stream'] as const)("under the prompt shim, a tool that a tool's execute adds to the table is in the next round's tool block and runs when the model calls it, in %s()", async (api) => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const ran: string[] = [];
    const table: Record<string, unknown> = {
      add_tool: { description: 'adds second', parameters: { type: 'object', properties: {} }, execute: async () => {
        table.second = { description: 'second', parameters: { type: 'object', properties: {} }, execute: async () => { ran.push('second'); return 'second ran'; } };
        return 'added';
      } },
    };
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, [openaiText('<tool_call>{"name":"add_tool","arguments":{}}</tool_call>'), openaiText('<tool_call>{"name":"second","arguments":{}}</tool_call>'), openaiText('done')]]]);
    const a = agent({ provider: 'openai', model: 'gpt-4.1', instructions: 'x', tools: table as never, maxSteps: 5 });
    const text = api === 'generate' ? (await a.generate('go', { toolMode: 'prompt' })).text : await drained(a.stream('go', { toolMode: 'prompt' }));
    expect(text).toBe('done');
    expect(ran).toEqual(['second']);
    expect(calls(OPENAI_CHAT, 'POST').map(shimToolNames)).toEqual([['add_tool'], ['add_tool', 'second'], ['add_tool', 'second']]);
  });
  it("under the prompt shim, a specialist spawn_specialist adds mid-run is in the manager's next tool block and runs when the manager calls it", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    const isManager = (c: Captured) => shimToolNames(c).includes('spawn_specialist');
    let managerTurn = 0;
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, (req) => {
      if (!isManager(req)) return openaiText('helped')(req);
      managerTurn += 1;
      return managerTurn === 1 ? openaiText('<tool_call>{"name":"spawn_specialist","arguments":{"role":"helper","instructions":"Help."}}</tool_call>')(req)
        : managerTurn === 2 ? openaiText('<tool_call>{"name":"delegate_to_helper","arguments":{"task":"v"}}</tool_call>')(req)
        : openaiText('manager done')(req);
    }]]);
    const team = agency({ provider: 'openai', model: 'gpt-4.1', agents: { worker: { instructions: 'w' } }, strategy: 'hierarchical', emergent: { enabled: true } } as never);
    const r = await team.generate('go', { toolMode: 'prompt' });
    expect(r.text).toBe('manager done');
    const managerRequests = calls(OPENAI_CHAT, 'POST').filter(isManager);
    // The spawned specialist's delegate tool is in the manager's next tool block, and its answer, not an "unknown
    // tool", is the tool response the round after it carries.
    expect(managerRequests.map((c) => shimToolNames(c).includes('delegate_to_helper'))).toEqual([false, true, true]);
    expect(JSON.stringify(managerRequests[2].body!.messages)).toContain('helped');
    expect(JSON.stringify(managerRequests[2].body!.messages)).not.toContain('unknown tool');
    expect(r.agentCalls.map((c) => [c.agent, c.output])).toEqual([['helper', 'helped']]);
  });
});

describe('27. a stream is read before its promises settle', () => {
  it("a bare agent stream's text awaited alone sends no request and stays pending; reading the stream sends it and settles text and toolCalls", async () => {
    vi.stubEnv('OPENAI_API_KEY', K.oaiEnv);
    route([[OPENAI_LIST, openaiListing], [OPENAI_CHAT, openaiText('done')]]);
    const a = agent({ provider: 'openai', model: 'gpt-4.1', instructions: 'x' });
    const st = a.stream('go');
    let settled = false;
    void st.text.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // streamText's contract: the request goes out when a consumer reads the stream, not when one of its promises is
    // awaited; a promise awaited alone never settles, so a caller that wants only the text reads the stream first.
    expect(calls(OPENAI_CHAT, 'POST')).toHaveLength(0);
    expect(settled).toBe(false);
    const chunks: string[] = [];
    for await (const chunk of st.textStream) chunks.push(chunk);
    expect(chunks.join('')).toBe('done');
    expect(await st.text).toBe('done');
    expect(await st.toolCalls).toEqual([]);
    expect(calls(OPENAI_CHAT, 'POST')).toHaveLength(1);
  });
});
