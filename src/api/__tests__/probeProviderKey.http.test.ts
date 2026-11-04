/**
 * @file probeProviderKey.http.test.ts
 * probeProviderKey through the real providers and fetch, against a local
 * server that answers as each vendor's API does. Each case checks the request
 * the probe sent (method, path, the key's header and the body) and the state
 * it read back. A request no case expects is answered 404 and fails the case,
 * and a URL outside the server is refused.
 *
 * The answers follow the vendors' documented errors:
 * Anthropic https://platform.claude.com/docs/en/api/errors,
 * OpenAI https://developers.openai.com/api/docs/guides/error-codes,
 * Gemini https://aistudio.google.com/docs/api-errors,
 * OpenRouter https://openrouter.ai/docs/api-reference/errors,
 * Requesty https://docs.requesty.ai/features/billing.md (all read 3 November 2026).
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  keyFingerprint,
  probeProviderKey,
  type ProbeProviderKeyOptions,
  type ProviderKeyState,
} from '../../index.js';
import { AnthropicProvider } from '../../core/llm/providers/implementations/AnthropicProvider.js';
import { GeminiProvider } from '../../core/llm/providers/implementations/GeminiProvider.js';
import { OpenAIProvider } from '../../core/llm/providers/implementations/OpenAIProvider.js';
import { OpenRouterProvider } from '../../core/llm/providers/implementations/OpenRouterProvider.js';
import { RequestyProvider } from '../../core/llm/providers/implementations/RequestyProvider.js';

// ---------------------------------------------------------------------------
// The surface under test, from the package root
// ---------------------------------------------------------------------------

type KeyState = ProviderKeyState;

/** The options with a provider id the call does not know, for the refusal case. */
type ProbeOptions = Omit<ProbeProviderKeyOptions, 'provider'> & { provider: string };

const api = {
  probeProviderKey: (options: ProbeOptions) => probeProviderKey(options as ProbeProviderKeyOptions),
  keyFingerprint,
};

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

interface Received {
  method: string;
  path: string;
  search: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * One answer: `delayMs` holds it back, `drop` closes the connection before any answer, `stall` sends the status, the
 * headers and the start of the body, then nothing more.
 */
type Answer = { status?: number; headers?: Record<string, string>; body?: string; delayMs?: number; drop?: boolean; stall?: boolean };

/** Every request the server received in the current case, in order. */
const received: Received[] = [];
/** The requests no route answered. */
const unexpected: string[] = [];
/** The URLs the probe tried outside the server. */
const outside: string[] = [];
/** Answers the server holds back, cleared after each case. */
const held: NodeJS.Timeout[] = [];
/** Answers left unfinished, ended after each case. */
const stalled: http.ServerResponse[] = [];
/** The current case's answers, by `METHOD /path`. */
let routes: Record<string, (request: Received) => Answer> = {};

let server: http.Server;
let origin: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', origin);
      const request: Received = { method: req.method ?? '', path: url.pathname, search: url.search, headers: req.headers, body: Buffer.concat(chunks) };
      received.push(request);
      const route = routes[`${request.method} ${request.path}`];
      if (!route) {
        unexpected.push(`${request.method} ${request.path}`);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"no such route in this case"}}');
        return;
      }
      const answer = route(request);
      if (answer.drop) {
        res.socket?.destroy();
        return;
      }
      if (answer.stall) {
        res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
        res.write((answer.body ?? '{}').slice(0, 12));
        stalled.push(res);
        return;
      }
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
        res.end(answer.body ?? '{}');
      };
      if (answer.delayMs) held.push(setTimeout(send, answer.delayMs));
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
  unexpected.length = 0;
  outside.length = 0;
  routes = {};
  // The probe reads the key it is given and nothing from the environment.
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'REQUESTY_API_KEY']) vi.stubEnv(name, '');
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${origin}/`)) {
      outside.push(url);
      return Promise.reject(new Error(`outside the test server: ${url}`));
    }
    return realFetch(input, init);
  });
});

afterEach(() => {
  for (const timer of held.splice(0)) clearTimeout(timer);
  for (const res of stalled.splice(0)) res.destroy();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(unexpected).toEqual([]);
  expect(outside).toEqual([]);
});

/** A JSON request's body. */
function jsonOf(request: Received): Record<string, unknown> {
  return JSON.parse(request.body.toString('utf8')) as Record<string, unknown>;
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Answer => ({ status, headers, body: JSON.stringify(value) });

const PING = [{ role: 'user', content: 'ping' }];

/** The rejection a call ends in. */
async function rejectionOf(call: Promise<unknown>): Promise<Error> {
  const error = await call.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe('probeProviderKey on Anthropic', () => {
  const KEY = 'sk-ant-api03-probe-key-1';
  const anthropicError = (type: string, message: string, extra: Record<string, unknown> = {}) => ({ type: 'error', error: { type, message, ...extra }, request_id: 'req_1' });
  const probe = (extra: Partial<ProbeOptions> = {}) => api.probeProviderKey({ provider: 'anthropic', apiKey: KEY, baseUrl: origin, ...extra });

  it('sends the smallest billable request and reads a 200 as ok', async () => {
    routes['POST /v1/messages'] = () => json({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'p' }], stop_reason: 'max_tokens' });

    const result = await probe();

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request.headers['x-api-key']).toBe(KEY);
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    expect(request.headers['content-type']).toBe('application/json');
    expect(jsonOf(request)).toEqual({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: PING });
    expect(result).toEqual({
      state: 'ok',
      detail: 'key accepted: HTTP 200 on claude-haiku-4-5-20251001',
      provider: 'anthropic',
      fingerprint: api.keyFingerprint(KEY),
      httpStatus: 200,
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('sends the billable request to the model the caller names', async () => {
    routes['POST /v1/messages'] = () => json({ id: 'msg_1', type: 'message', content: [] });

    const result = await probe({ model: 'claude-haiku-5-5' });

    expect(jsonOf(received[0]).model).toBe('claude-haiku-5-5');
    expect(result.state).toBe('ok');
    expect(result.model).toBe('claude-haiku-5-5');
  });

  it('reads the credit-balance 400 as exhausted, with the vendor message', async () => {
    const message = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
    routes['POST /v1/messages'] = () => json(anthropicError('invalid_request_error', message), 400);

    const result = await probe();

    expect(result.state).toBe('exhausted');
    expect(result.httpStatus).toBe(400);
    expect(result.detail).toBe(`no credit or a spend limit reached (HTTP 400): ${message}`);
  });

  it("reads the operator's spend limit (400) and the tier's monthly cap (429) as exhausted", async () => {
    routes['POST /v1/messages'] = () => json(anthropicError('invalid_request_error', 'You have reached your specified API usage limits. You will regain access on 2026-12-01.'), 400);
    expect((await probe()).state).toBe('exhausted');

    routes['POST /v1/messages'] = () =>
      json(anthropicError('rate_limit_error', 'You have reached your API usage limits.', { details: { error_code: 'enforced_spend_limit_reached' } }), 429);
    const capped = await probe();
    expect(capped.state).toBe('exhausted');
    expect(capped.httpStatus).toBe(429);
  });

  it('reads a 402 billing_error as exhausted', async () => {
    routes['POST /v1/messages'] = () => json(anthropicError('billing_error', 'There is an issue with your billing.'), 402);

    expect((await probe()).state).toBe('exhausted');
  });

  it('reads a 401 as invalid', async () => {
    routes['POST /v1/messages'] = () => json(anthropicError('authentication_error', 'invalid x-api-key'), 401);

    const result = await probe();

    expect(result.state).toBe('invalid');
    expect(result.detail).toBe('key rejected (HTTP 401): invalid x-api-key');
  });

  it('reads a throttle 429 as throttled, with its Retry-After', async () => {
    routes['POST /v1/messages'] = () => json(anthropicError('rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit'), 429, { 'retry-after': '30' });

    const result = await probe();

    expect(result.state).toBe('throttled');
    expect(result.httpStatus).toBe(429);
    expect(result.retryAfterMs).toBe(30_000);
    expect(result.detail).toBe('rate limited (HTTP 429): Number of request tokens has exceeded your per-minute rate limit; retry after 30 s');
  });

  it('reads an overloaded 529, a 403 permission_error and a 404 as unknown: none of them is the key', async () => {
    routes['POST /v1/messages'] = () => json(anthropicError('overloaded_error', 'Overloaded'), 529);
    const overloaded = await probe();
    expect(overloaded.state).toBe('unknown');
    expect(overloaded.httpStatus).toBe(529);
    expect(overloaded.detail).toBe('no verdict (HTTP 529): Overloaded');

    routes['POST /v1/messages'] = () => json(anthropicError('permission_error', 'Your API key does not have permission to use the specified resource.'), 403);
    expect((await probe()).state).toBe('unknown');

    routes['POST /v1/messages'] = () => json(anthropicError('not_found_error', 'model: claude-retired'), 404);
    expect((await probe({ model: 'claude-retired' })).state).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe('probeProviderKey on OpenAI', () => {
  const KEY = 'sk-proj-probe-key-2';
  const openaiError = (message: string, type: string | null, code: string | null) => ({ error: { message, type, param: null, code } });
  const probe = (extra: Partial<ProbeOptions> = {}) => api.probeProviderKey({ provider: 'openai', apiKey: KEY, baseUrl: `${origin}/v1`, ...extra });

  it('sends a one-token completion to the named model with the key as a bearer token', async () => {
    routes['POST /v1/chat/completions'] = () => json({ id: 'chatcmpl-1', object: 'chat.completion', choices: [] });

    const result = await probe({ model: 'gpt-4.1-mini' });

    expect(received).toHaveLength(1);
    expect(received[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(jsonOf(received[0])).toEqual({ model: 'gpt-4.1-mini', max_tokens: 1, messages: PING });
    expect(result).toMatchObject({ state: 'ok', provider: 'openai', httpStatus: 200, model: 'gpt-4.1-mini' });
  });

  it('takes the first chat model the account lists when none is named', async () => {
    routes['GET /v1/models'] = () => json({ object: 'list', data: [{ id: 'text-embedding-3-small' }, { id: 'gpt-4o-mini-tts' }, { id: 'gpt-4o-mini' }] });
    routes['POST /v1/chat/completions'] = () => json({ id: 'chatcmpl-1', choices: [] });

    const result = await probe();

    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/models', 'POST /v1/chat/completions']);
    expect(jsonOf(received[1]).model).toBe('gpt-4o-mini');
    expect(result).toMatchObject({ state: 'ok', model: 'gpt-4o-mini' });
  });

  it('takes an o-series model when the account lists no GPT chat model, and skips the Responses-only models', async () => {
    routes['POST /v1/chat/completions'] = () => json({ id: 'chatcmpl-1', choices: [] });

    routes['GET /v1/models'] = () => json({ object: 'list', data: [{ id: 'text-embedding-3-small' }, { id: 'o1-pro' }, { id: 'o4-mini' }] });
    const reasoningOnly = await probe();
    expect(jsonOf(received[1])).toEqual({ model: 'o4-mini', max_completion_tokens: 16, messages: PING });
    expect(reasoningOnly).toMatchObject({ state: 'ok', model: 'o4-mini' });

    // A GPT chat model goes first; a Responses-only one has no Chat Completions route to probe.
    received.length = 0;
    routes['GET /v1/models'] = () => json({ object: 'list', data: [{ id: 'o3' }, { id: 'gpt-5-pro' }, { id: 'gpt-4o-mini' }] });
    const mixed = await probe();
    expect(jsonOf(received[1]).model).toBe('gpt-4o-mini');
    expect(mixed).toMatchObject({ state: 'ok', model: 'gpt-4o-mini' });
  });

  it('skips the completions-only instruct models when it picks from the catalog', async () => {
    routes['GET /v1/models'] = () => json({ object: 'list', data: [{ id: 'gpt-3.5-turbo-instruct' }, { id: 'gpt-3.5-turbo-instruct-0914' }, { id: 'gpt-4o-mini' }] });
    routes['POST /v1/chat/completions'] = () => json({ id: 'chatcmpl-1', choices: [] });

    const result = await probe();

    expect(jsonOf(received[1]).model).toBe('gpt-4o-mini');
    expect(result).toMatchObject({ state: 'ok', model: 'gpt-4o-mini' });
  });

  it('sends the billable request for a named Responses-only model to /responses', async () => {
    // gpt-5.3-codex has no Chat Completions route; the Responses API takes a plain string as input
    // (https://developers.openai.com/api/reference/resources/responses/methods/create, read 4 November 2026).
    routes['POST /v1/responses'] = () => json({ id: 'resp_1', object: 'response', status: 'incomplete', output: [] });

    const result = await probe({ model: 'gpt-5.3-codex' });

    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /v1/responses']);
    expect(received[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(jsonOf(received[0])).toEqual({ model: 'gpt-5.3-codex', input: 'ping', max_output_tokens: 16 });
    expect(result).toMatchObject({ state: 'ok', provider: 'openai', httpStatus: 200, model: 'gpt-5.3-codex' });

    routes['POST /v1/responses'] = () => json({ error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } }, 429);
    expect((await probe({ model: 'gpt-5.3-codex' })).state).toBe('exhausted');
  });

  it('reports the timeout, not a catalog without a chat model, when the models list stops before its end', async () => {
    routes['GET /v1/models'] = () => ({ ...json({ object: 'list', data: [{ id: 'gpt-4o-mini' }] }), stall: true });

    const result = await probe({ timeoutMs: 200 });

    expect(result.state).toBe('unknown');
    expect(result.detail).toBe('no answer within 200 ms');
    expect(received.map((r) => r.path)).toEqual(['/v1/models']);
  });

  it('sends max_completion_tokens to a reasoning model', async () => {
    routes['POST /v1/chat/completions'] = () => json({ id: 'chatcmpl-1', choices: [] });

    await probe({ model: 'gpt-5-mini' });

    expect(jsonOf(received[0])).toEqual({ model: 'gpt-5-mini', max_completion_tokens: 16, messages: PING });
  });

  it('reads insufficient_quota and the documented credit and spend-limit codes as exhausted', async () => {
    routes['POST /v1/chat/completions'] = () => json(openaiError('You exceeded your current quota.', 'insufficient_quota', 'insufficient_quota'), 429);
    expect((await probe({ model: 'gpt-4.1-mini' })).state).toBe('exhausted');

    for (const code of ['credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded']) {
      routes['POST /v1/chat/completions'] = () => json(openaiError(`429 ${code}`, null, code), 429);
      const result = await probe({ model: 'gpt-4.1-mini' });
      expect(result.state).toBe('exhausted');
      expect(result.detail).toBe(`no credit or a spend limit reached (HTTP 429): 429 ${code}`);
    }
  });

  it('reads an incorrect key as invalid, on the models list as on the completion', async () => {
    const wrong = openaiError('Incorrect API key provided: sk-proj-****ey-2. You can find your API key at https://platform.openai.com/account/api-keys.', 'invalid_request_error', 'invalid_api_key');
    routes['GET /v1/models'] = () => json(wrong, 401);
    const listed = await probe();
    expect(listed.state).toBe('invalid');
    expect(listed.httpStatus).toBe(401);
    expect(received.map((r) => r.path)).toEqual(['/v1/models']);
    expect(listed.model).toBeUndefined();

    routes['POST /v1/chat/completions'] = () => json(wrong, 401);
    expect((await probe({ model: 'gpt-4.1-mini' })).state).toBe('invalid');
  });

  it('reads a rate-limit 429 as throttled', async () => {
    routes['POST /v1/chat/completions'] = () => json(openaiError('Rate limit reached for requests', 'requests', 'rate_limit_exceeded'), 429, { 'retry-after': '2' });

    const result = await probe({ model: 'gpt-4.1-mini' });

    expect(result).toMatchObject({ state: 'throttled', httpStatus: 429, retryAfterMs: 2000 });
  });

  it('reads a 500 as unknown, and an account that lists no chat model as unknown without a completion', async () => {
    routes['POST /v1/chat/completions'] = () => json(openaiError('The server had an error while processing your request.', 'server_error', null), 500);
    expect((await probe({ model: 'gpt-4.1-mini' })).state).toBe('unknown');

    received.length = 0;
    routes['GET /v1/models'] = () => json({ object: 'list', data: [{ id: 'text-embedding-3-small' }, { id: 'whisper-1' }] });
    const none = await probe();
    expect(none.state).toBe('unknown');
    expect(none.detail).toBe('no model to send the billable request to; pass `model`');
    expect(received.map((r) => r.path)).toEqual(['/v1/models']);
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe('probeProviderKey on Gemini', () => {
  const KEY = 'AIzaSy-probe-key-3';
  const GENERATE = '/v1beta/models/gemini-2.5-flash:generateContent';
  const probe = (extra: Partial<ProbeOptions> = {}) => api.probeProviderKey({ provider: 'gemini', apiKey: KEY, baseUrl: `${origin}/v1beta`, ...extra });

  it('sends a one-token generateContent with the key in x-goog-api-key and reads a 200 as ok', async () => {
    routes[`POST ${GENERATE}`] = () => json({ candidates: [{ content: { parts: [{ text: 'p' }] } }] });

    const result = await probe();

    expect(received).toHaveLength(1);
    expect(received[0].headers['x-goog-api-key']).toBe(KEY);
    expect(received[0].search).toBe('');
    expect(jsonOf(received[0])).toEqual({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 1 } });
    expect(result).toMatchObject({ state: 'ok', provider: 'gemini', httpStatus: 200, model: 'gemini-2.5-flash' });
  });

  it("reads the invalid-key 400 and a 401 as invalid", async () => {
    routes[`POST ${GENERATE}`] = () =>
      json(
        {
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
            details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
          },
        },
        400,
      );
    const bad = await probe();
    expect(bad.state).toBe('invalid');
    expect(bad.detail).toBe('key rejected (HTTP 400): API key not valid. Please pass a valid API key.');

    routes[`POST ${GENERATE}`] = () => json({ error: { code: 'authentication', message: 'The API key is missing, invalid, or expired.' } }, 401);
    expect((await probe()).state).toBe('invalid');
  });

  it('reads a 402 for spent Prepay credit as exhausted', async () => {
    routes[`POST ${GENERATE}`] = () => json({ error: { code: 'payment_required', message: 'Your Prepay credit balance is depleted.' } }, 402);

    const result = await probe();

    expect(result.state).toBe('exhausted');
    expect(result.detail).toBe('no credit or a spend limit reached (HTTP 402): Your Prepay credit balance is depleted.');
  });

  it('reads a 429 as throttled and a 403 as unknown', async () => {
    routes[`POST ${GENERATE}`] = () => json({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }, 429);
    expect((await probe()).state).toBe('throttled');

    routes[`POST ${GENERATE}`] = () => json({ error: { code: 403, message: 'Method doesn\'t allow unregistered callers.', status: 'PERMISSION_DENIED' } }, 403);
    expect((await probe()).state).toBe('unknown');
  });

  it('sends the billable request to the model the caller names', async () => {
    routes['POST /v1beta/models/gemini-3-flash:generateContent'] = () => json({ candidates: [] });

    const result = await probe({ model: 'gemini-3-flash' });

    expect(result).toMatchObject({ state: 'ok', model: 'gemini-3-flash' });
  });
});

// ---------------------------------------------------------------------------
// OpenRouter and Requesty: the cheapest priced model, never a free one
// ---------------------------------------------------------------------------

describe('probeProviderKey on OpenRouter', () => {
  const KEY = 'sk-or-v1-probe-key-4';
  const probe = (extra: Partial<ProbeOptions> = {}) => api.probeProviderKey({ provider: 'openrouter', apiKey: KEY, baseUrl: `${origin}/api/v1`, ...extra });
  const catalogModel = (id: string, prompt: string, completion: string) => ({
    id,
    name: id,
    description: '',
    pricing: { prompt, completion },
    context_length: 8192,
    top_provider: { max_retries: null, is_fallback: null },
  });

  it('lists the catalog and sends a 16-token completion to the cheapest priced model', async () => {
    routes['GET /api/v1/models'] = () =>
      json({
        data: [
          catalogModel('meta-llama/llama-3.3-8b-instruct:free', '0', '0'),
          catalogModel('openrouter/auto', '-1', '-1'),
          catalogModel('openai/gpt-4o-mini', '0.00000015', '0.0000006'),
          catalogModel('anthropic/claude-opus-5.5', '0.000015', '0.000075'),
        ],
      });
    routes['POST /api/v1/chat/completions'] = () => json({ id: 'gen-1', choices: [] });

    const result = await probe();

    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v1/models', 'POST /api/v1/chat/completions']);
    expect(received[1].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(jsonOf(received[1])).toEqual({ model: 'openai/gpt-4o-mini', max_tokens: 16, messages: PING });
    expect(result).toMatchObject({ state: 'ok', provider: 'openrouter', httpStatus: 200, model: 'openai/gpt-4o-mini' });
  });

  it("keeps one endpoint's catalog out of a probe of another endpoint", async () => {
    // Each base URL is its own catalog: what one endpoint listed is neither reused for another nor kept.
    routes['GET /api/v1/models'] = () => json({ data: [catalogModel('first/cheap', '0.0000001', '0.0000001')] });
    routes['POST /api/v1/chat/completions'] = () => json({ id: 'gen-1', choices: [] });
    routes['GET /second/api/v1/models'] = () => json({ data: [catalogModel('second/cheap', '0.0000001', '0.0000001')] });
    routes['POST /second/api/v1/chat/completions'] = () => json({ id: 'gen-2', choices: [] });
    const provider = new OpenRouterProvider();

    const first = await provider.probeApiKey(KEY, { kind: 'billing', baseURL: `${origin}/api/v1` });
    const second = await provider.probeApiKey(KEY, { kind: 'billing', baseURL: `${origin}/second/api/v1` });

    expect(first).toMatchObject({ verdict: 'ok', model: 'first/cheap' });
    expect(second).toMatchObject({ verdict: 'ok', model: 'second/cheap' });
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/v1/models',
      'POST /api/v1/chat/completions',
      'GET /second/api/v1/models',
      'POST /second/api/v1/chat/completions',
    ]);
    expect(jsonOf(received[3]).model).toBe('second/cheap');
  });

  it('sends the completion to the named model without listing the catalog', async () => {
    routes['POST /api/v1/chat/completions'] = () => json({ id: 'gen-1', choices: [] });

    await probe({ model: 'mistralai/mistral-small' });

    expect(received.map((r) => r.path)).toEqual(['/api/v1/chat/completions']);
    expect(jsonOf(received[0]).model).toBe('mistralai/mistral-small');
  });

  it('reads 402, 401 and 429 as exhausted, invalid and throttled', async () => {
    const states: KeyState[] = [];
    for (const [status, message] of [
      [402, 'Insufficient credits. Add more using https://openrouter.ai/credits'],
      [401, 'No auth credentials found'],
      [429, 'Rate limit exceeded'],
    ] as const) {
      routes['POST /api/v1/chat/completions'] = () => json({ error: { code: status, message } }, status);
      const result = await probe({ model: 'openai/gpt-4o-mini' });
      expect(result.httpStatus).toBe(status);
      expect(result.detail).toContain(message);
      states.push(result.state);
    }
    expect(states).toEqual(['exhausted', 'invalid', 'throttled']);
  });

  it('reports unknown and sends no completion when the catalog lists no priced model', async () => {
    routes['GET /api/v1/models'] = () => json({ data: [catalogModel('meta-llama/llama-3.3-8b-instruct:free', '0', '0')] });

    const result = await probe();

    expect(result.state).toBe('unknown');
    expect(result.detail).toBe('no model to send the billable request to; pass `model`');
    expect(received.map((r) => r.path)).toEqual(['/api/v1/models']);
  });
});

describe('probeProviderKey on Requesty', () => {
  const KEY = 'rqsty-sk-probe-key-5';
  const probe = (extra: Partial<ProbeOptions> = {}) => api.probeProviderKey({ provider: 'requesty', apiKey: KEY, baseUrl: `${origin}/v1`, ...extra });

  it('lists the catalog and sends a 16-token completion to the cheapest priced model', async () => {
    routes['GET /v1/models'] = () =>
      json({
        data: [
          { id: 'openai/gpt-4o', input_price: 0.0000025, output_price: 0.00001 },
          { id: 'google/gemini-2.5-flash', input_price: 0.0000003, output_price: 0.0000025 },
          { id: 'free/model', input_price: 0, output_price: 0 },
        ],
      });
    routes['POST /v1/chat/completions'] = () => json({ id: 'req-1', choices: [] });

    const result = await probe();

    expect(jsonOf(received[1])).toEqual({ model: 'google/gemini-2.5-flash', max_tokens: 16, messages: PING });
    expect(received[1].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(result).toMatchObject({ state: 'ok', provider: 'requesty', model: 'google/gemini-2.5-flash' });
  });

  it("keeps one endpoint's catalog out of a probe of another endpoint", async () => {
    routes['GET /v1/models'] = () => json({ data: [{ id: 'first/cheap', input_price: 0.0000001, output_price: 0.0000001 }] });
    routes['POST /v1/chat/completions'] = () => json({ id: 'req-1', choices: [] });
    routes['GET /second/v1/models'] = () => json({ data: [{ id: 'second/cheap', input_price: 0.0000001, output_price: 0.0000001 }] });
    routes['POST /second/v1/chat/completions'] = () => json({ id: 'req-2', choices: [] });
    const provider = new RequestyProvider();

    const first = await provider.probeApiKey(KEY, { kind: 'billing', baseURL: `${origin}/v1` });
    const second = await provider.probeApiKey(KEY, { kind: 'billing', baseURL: `${origin}/second/v1` });

    expect(first).toMatchObject({ verdict: 'ok', model: 'first/cheap' });
    expect(second).toMatchObject({ verdict: 'ok', model: 'second/cheap' });
    expect(received.map((r) => r.path)).toEqual(['/v1/models', '/v1/chat/completions', '/second/v1/models', '/second/v1/chat/completions']);
  });

  it('reads a 402 for a spent balance as exhausted and the 403 bad-token answer as invalid', async () => {
    routes['POST /v1/chat/completions'] = () => json({ error: { message: 'Insufficient balance' } }, 402);
    expect((await probe({ model: 'openai/gpt-4o-mini' })).state).toBe('exhausted');

    routes['POST /v1/chat/completions'] = () => json({ error: { origin: 'router', message: 'Invalid authorization token' } }, 403);
    expect((await probe({ model: 'openai/gpt-4o-mini' })).state).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// What every provider shares
// ---------------------------------------------------------------------------

describe('probeProviderKey, whatever the provider', () => {
  const KEY = 'sk-ant-api03-shared-key-6';

  it('reports unknown when no answer comes within the timeout', async () => {
    routes['POST /v1/messages'] = () => ({ ...json({ id: 'msg_1' }), delayMs: 2_000 });

    const started = Date.now();
    const result = await api.probeProviderKey({ provider: 'anthropic', apiKey: KEY, baseUrl: origin, timeoutMs: 150 });

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result.state).toBe('unknown');
    expect(result.detail).toBe('no answer within 150 ms');
    expect(result.httpStatus).toBeUndefined();
  });

  it('reports the timeout and the abort, not the status, when the error body stops before its end', async () => {
    // The status and the headers arrive, the body never finishes: the probe has no answer to read.
    routes['POST /v1/messages'] = () => ({ ...json({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }, 429), stall: true });

    const timedOut = await api.probeProviderKey({ provider: 'anthropic', apiKey: KEY, baseUrl: origin, timeoutMs: 200 });
    expect(timedOut.state).toBe('unknown');
    expect(timedOut.detail).toBe('no answer within 200 ms');

    const caller = new AbortController();
    setTimeout(() => caller.abort(), 100);
    const aborted = await api.probeProviderKey({ provider: 'anthropic', apiKey: KEY, baseUrl: origin, signal: caller.signal });
    expect(aborted).toMatchObject({ state: 'unknown', detail: 'aborted by the caller' });
  });

  it('reports unknown when the connection fails', async () => {
    routes['POST /v1/messages'] = () => ({ drop: true });

    const result = await api.probeProviderKey({ provider: 'anthropic', apiKey: KEY, baseUrl: origin });

    expect(result.state).toBe('unknown');
    expect(result.detail.startsWith('request failed: ')).toBe(true);
    expect(result.httpStatus).toBeUndefined();
  });

  it("ends at the caller's abort, and sends nothing for a signal that has already fired", async () => {
    const before = new AbortController();
    before.abort();
    const early = await api.probeProviderKey({ provider: 'anthropic', apiKey: KEY, baseUrl: origin, signal: before.signal });
    expect(early).toMatchObject({ state: 'unknown', detail: 'aborted by the caller' });
    expect(received).toHaveLength(0);

    routes['POST /v1/messages'] = () => ({ ...json({ id: 'msg_1' }), delayMs: 2_000 });
    const during = new AbortController();
    setTimeout(() => during.abort(), 50);
    const late = await api.probeProviderKey({ provider: 'anthropic', apiKey: KEY, baseUrl: origin, signal: during.signal });
    expect(late).toMatchObject({ state: 'unknown', detail: 'aborted by the caller' });
  });

  it('never writes the key into the detail, even when the vendor echoes it', async () => {
    routes['POST /v1/messages'] = () => json({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${KEY}` } }, 401);

    const result = await api.probeProviderKey({ provider: 'anthropic', apiKey: KEY, baseUrl: origin });

    expect(result.state).toBe('invalid');
    expect(result.detail).not.toContain(KEY);
    expect(result.detail).toBe('key rejected (HTTP 401): invalid x-api-key: [key]');
  });

  it('keeps the key out of a long vendor message that would be cut through the key', async () => {
    // The message runs past the 300 characters a detail keeps, with the key across the cut.
    const filler = 'refused '.repeat(34).trim();
    routes['POST /v1/messages'] = () => json({ type: 'error', error: { type: 'authentication_error', message: `${filler} Key: ${KEY} is not valid.` } }, 401);

    const result = await api.probeProviderKey({ provider: 'anthropic', apiKey: KEY, baseUrl: origin });

    expect(result.state).toBe('invalid');
    expect(result.detail).not.toContain(KEY.slice(0, 8));
    expect(result.detail).toContain('Key: [key] is not valid.');
  });

  it("keeps the base URL's credentials out of the detail when fetch refuses the URL", async () => {
    // fetch refuses a URL with `user:password@` and names the whole URL in its error.
    vi.mocked(globalThis.fetch).mockImplementation((input, init) => realFetch(input, init));
    const withCredentials = origin.replace('http://', 'http://probe-user:s3cret-pass@');

    for (const provider of ['anthropic', 'openai', 'gemini', 'openrouter', 'requesty']) {
      const result = await api.probeProviderKey({ provider, apiKey: KEY, baseUrl: withCredentials, model: 'probe-model-1' });

      expect(result.state).toBe('unknown');
      expect(result.detail.startsWith('request failed: ')).toBe(true);
      expect(result.detail).not.toContain('s3cret-pass');
      expect(result.detail).not.toContain('probe-user:');
    }
    expect(received).toHaveLength(0);
  });

  it('keeps the key out of the error each provider probe reports when fetch quotes it', async () => {
    // fetch quotes a header value it refuses, the key with it.
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError(`Headers.append: "Bearer ${KEY}\u0000" is an invalid header value.`));

    for (const provider of [new AnthropicProvider(), new OpenAIProvider(), new GeminiProvider(), new OpenRouterProvider(), new RequestyProvider()]) {
      const answer = await provider.probeApiKey(KEY, { kind: 'billing', baseURL: origin, model: 'probe-model-1' });

      expect(answer).toMatchObject({ verdict: 'unknown', failure: 'network' });
      expect(answer.error).toContain('is an invalid header value');
      expect(answer.error).not.toContain(KEY);
    }
  });

  it('waits out a timeout past the longest timer delay when a provider probe is called directly', async () => {
    // Node fires a timer set past 2,147,483,647 ms after 1 ms; each answer here comes 100 ms late.
    const late = (body: unknown) => () => ({ ...json(body), delayMs: 100 });
    routes['POST /v1/messages'] = late({ id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'p' }] });
    routes['POST /v1/chat/completions'] = late({ id: 'chatcmpl-1', choices: [] });
    routes['POST /v1beta/models/probe-model-1:generateContent'] = late({ candidates: [] });
    routes['POST /api/v1/chat/completions'] = late({ id: 'gen-1', choices: [] });
    const cases = [
      [new AnthropicProvider(), origin],
      [new OpenAIProvider(), `${origin}/v1`],
      [new GeminiProvider(), `${origin}/v1beta`],
      [new OpenRouterProvider(), `${origin}/api/v1`],
      [new RequestyProvider(), `${origin}/v1`],
    ] as const;

    for (const [provider, baseURL] of cases) {
      const answer = await provider.probeApiKey(KEY, { kind: 'billing', baseURL, model: 'probe-model-1', timeoutMs: 2 ** 31 });

      expect(answer).toMatchObject({ verdict: 'ok', status: 200 });
      expect(answer.failure).toBeUndefined();
    }
    expect(received).toHaveLength(5);
  });

  it("lets go of a 2xx answer's connection once the status is read", async () => {
    // The status and the headers arrive and the body never finishes: an ok probe must not hold the connection.
    routes['POST /v1/messages'] = () => ({ ...json({ id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'p' }] }), stall: true });

    const result = await api.probeProviderKey({ provider: 'anthropic', apiKey: KEY, baseUrl: origin });

    expect(result.state).toBe('ok');
    const [answer] = stalled;
    const closed = await new Promise<boolean>((resolve) => {
      if (!answer.socket || answer.socket.destroyed) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), 2_000);
      answer.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(closed).toBe(true);
  });

  it("goes to the vendor's own endpoint when baseUrl is blank", async () => {
    const result = await api.probeProviderKey({ provider: 'anthropic', apiKey: KEY, baseUrl: '   ' });

    // The test refuses every URL outside its server: the probe tried Anthropic's own endpoint, and nothing else.
    expect(outside).toEqual(['https://api.anthropic.com/v1/messages']);
    outside.length = 0;
    expect(result.state).toBe('unknown');
  });

  it('trims the key it is given', async () => {
    routes['POST /v1/messages'] = () => json({ id: 'msg_1' });

    const result = await api.probeProviderKey({ provider: 'anthropic', apiKey: `  ${KEY}\n`, baseUrl: origin });

    expect(received[0].headers['x-api-key']).toBe(KEY);
    expect(result.fingerprint).toBe(api.keyFingerprint(KEY));
  });

  it('refuses a provider it has no probe for, a missing key, a list of keys and a bad timeout, before any request', async () => {
    expect(await rejectionOf(api.probeProviderKey({ provider: 'cohere', apiKey: KEY }))).toBeInstanceOf(RangeError);
    expect(await rejectionOf(api.probeProviderKey({ provider: 'anthropic', apiKey: '  ' }))).toBeInstanceOf(TypeError);
    expect(await rejectionOf(api.probeProviderKey({ provider: 'anthropic', apiKey: 'sk-ant-1,sk-ant-2' }))).toBeInstanceOf(TypeError);
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await rejectionOf(api.probeProviderKey({ provider: 'anthropic', apiKey: KEY, baseUrl: origin, timeoutMs }))).toBeInstanceOf(RangeError);
    }
    expect(received).toHaveLength(0);
  });
});
