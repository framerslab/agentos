/**
 * @file agency-panel-axios.e2e.test.ts
 * Seats on providers that send through axios (OpenRouter, Ollama). axios is
 * replaced by a client that forwards to the stubbed global fetch, so the
 * same request capture works; the providers themselves are the real classes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

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

import { agency } from '../agency.js';
import { generateText } from '../generateText.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

type Json = Record<string, any>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const K = { or: 'sk-or-pool-00000021', ant: 'sk-ant-pool-00000022' };
const ORLIST = /openrouter\.ai\/api\/v1\/models/;
const ORCHAT = /openrouter\.ai\/api\/v1\/chat\/completions/;
const OLLAMA_ROOT = /^http:\/\/127\.0\.0\.1:11434\/?$/;
const OLLAMA_CHAT = /127\.0\.0\.1:11434\/api\/chat/;
const ANTHROPIC = /api\.anthropic\.com\/v1\/messages/;
const orListing = () => json({ data: [{ id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000, pricing: { prompt: '0.000005', completion: '0.000015' }, architecture: { modality: 'text' } }] });
const orText = (text: string, model = 'openai/gpt-4o') => () => json({ id: 'gen', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
const orError = (status: number, message: string) => () => json({ error: { message, code: status } }, status);
const ollamaText = (text: string, model: string) => () => json({ model, created_at: '2026-10-05T00:00:00Z', message: { role: 'assistant', content: text }, done: true, prompt_eval_count: 3, eval_count: 2 });
function anthropicText(text: string): Response {
  const events = [{ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function route(table: Array<[RegExp, (() => Response) | Array<() => Response>]>): void {
  const queues = table.map(([, h]) => (Array.isArray(h) ? [...h] : [h]));
  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url);
    const i = table.findIndex(([p]) => p.test(u));
    if (i === -1) throw new Error(`unexpected request ${u}`);
    const q = queues[i];
    return (q.length > 1 ? q.shift()! : q[0])();
  });
}
const calls = (p: RegExp) => fetchMock.mock.calls.filter(([u]) => p.test(String(u))).map(([u, init]) => ({ url: String(u), init: init as { headers?: Record<string, string>; body?: string } }));

beforeEach(() => { fetchMock.mockReset(); globalLLMProviderHealth.reset(); });
afterEach(() => vi.unstubAllEnvs());

describe('Ollama seats', () => {
  it('a colon tag is never split under provider ollama, and the request carries no auth header', async () => {
    route([[OLLAMA_ROOT, () => json({})], [OLLAMA_CHAT, ollamaText('local view', 'qwen2.5:7b')], [ANTHROPIC, () => anthropicText('Merged')]]);
    const r = await agency({ strategy: 'panel', modelPool: { local: { provider: 'ollama', model: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:11434', vendor: 'alibaba' }, opus: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: K.ant } }, agents: { a: { instructions: 'x', from: ['local'] } }, chair: { from: ['opus'] }, quorum: { minAgents: 1 }, apiKey: 'sk-agency-level-must-not-leak-0023' } as never).generate('review');
    const chat = calls(OLLAMA_CHAT)[0];
    expect(JSON.parse(chat.init.body!).model).toBe('qwen2.5:7b');
    expect(chat.init.headers?.Authorization ?? chat.init.headers?.authorization).toBeUndefined();
    expect(r.seats[0]).toMatchObject({ status: 'ok', provider: 'ollama', model: 'qwen2.5:7b', vendor: 'alibaba' });
  });
  it('mistral:7b under ollama goes to Ollama, through generateText as well', async () => {
    route([[OLLAMA_ROOT, () => json({})], [OLLAMA_CHAT, ollamaText('ok', 'mistral:7b')]]);
    const r = await generateText({ provider: 'ollama', model: 'mistral:7b', baseUrl: 'http://127.0.0.1:11434', prompt: 'hi', fallbackProviders: [] });
    expect(r.provider).toBe('ollama');
    expect(JSON.parse(calls(OLLAMA_CHAT)[0].init.body!).model).toBe('mistral:7b');
  });
});

describe('OpenRouter seats', () => {
  it('a :free suffix stays whole; a response naming another maker counts as that vendor; the record names the host', async () => {
    route([[ORLIST, orListing], [ORCHAT, orText('view', 'anthropic/claude-sonnet-4')], [ANTHROPIC, () => anthropicText('Merged')]]);
    const r = await agency({ strategy: 'panel', modelPool: { host: { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', apiKey: K.or }, opus: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: K.ant } }, agents: { a: { instructions: 'x', from: ['host'] } }, chair: { from: ['opus'] }, quorum: { minAgents: 1 } } as never).generate('review');
    expect(JSON.parse(calls(ORCHAT)[0].init.body!).model).toBe('meta-llama/llama-3.3-70b-instruct:free');
    expect(calls(ORCHAT)[0].init.headers?.Authorization).toBe(`Bearer ${K.or}`);
    expect(r.seats[0]).toMatchObject({ status: 'ok', provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', responseModel: 'anthropic/claude-sonnet-4', vendor: 'anthropic', substituted: true });
  });
  it('a failing OpenRouter seat carries no key in its record', async () => {
    route([[ORLIST, orListing], [ORCHAT, orError(500, `upstream rejected ${K.or}`)], [ANTHROPIC, () => anthropicText('Merged')]]);
    const r = await agency({ strategy: 'panel', modelPool: { host: { provider: 'openrouter', model: 'openai/gpt-4o', apiKey: K.or }, opus: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: K.ant } }, agents: { a: { instructions: 'x', from: ['host'] }, b: { instructions: 'y', from: ['opus'] } }, chair: false, quorum: { minAgents: 1 } } as never).generate('review');
    expect(JSON.stringify(r.seats)).not.toContain(K.or);
  });
});
