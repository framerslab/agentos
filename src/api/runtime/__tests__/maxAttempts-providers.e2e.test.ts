/**
 * @file maxAttempts-providers.e2e.test.ts
 * A call's `maxAttempts` through generateText and the real Anthropic, Gemini
 * and OpenRouter providers, with only the transport stubbed (fetch, and axios
 * forwarding to fetch for OpenRouter). A retryable answer (Anthropic's 529
 * overloaded, a 503 from Gemini or OpenRouter) is retried up to the call's
 * count, the configured count holds when the call names none, and no backoff
 * is waited after the last attempt. The backoff helper is replaced by one that
 * waits nothing, so the retries run at once and its calls can be counted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const backoff = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../../core/llm/providers/implementations/retry-backoff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/llm/providers/implementations/retry-backoff.js')>();
  return {
    ...actual,
    computeRetryBackoffMs: () => {
      backoff.calls += 1;
      return 0;
    },
  };
});

vi.mock('axios', () => {
  const respond = async (url: string, init: Record<string, unknown>) => {
    const res = (await (globalThis.fetch as (u: string, i: unknown) => Promise<Response>)(url, init)) as Response;
    const data = await res.json().catch(() => undefined);
    const out = { status: res.status, statusText: res.statusText, data, headers: Object.fromEntries(res.headers as unknown as Iterable<[string, string]>), config: { url } };
    if (res.status >= 400) throw Object.assign(new Error(`Request failed with status code ${res.status}`), { isAxiosError: true, response: out, config: { url } });
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

import { generateText } from '../../generateText.js';
import { AnthropicProvider } from '../../../core/llm/providers/implementations/AnthropicProvider.js';
import { GeminiProvider } from '../../../core/llm/providers/implementations/GeminiProvider.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

type Reply = () => Response;

const ANTHROPIC = /api\.anthropic\.com\/v1\/messages/;
const GEMINI = /generativelanguage\.googleapis\.com\/.*:generateContent/;
const OR_LIST = /openrouter\.ai\/api\/v1\/models/;
const OR_CHAT = /openrouter\.ai\/api\/v1\/chat\/completions/;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Anthropic's overloaded answer: HTTP 529 with an `overloaded_error`. */
const anthropicOverloaded: Reply = () => json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529);

/** A streamed Claude text reply, as the provider's default transport reads it. */
const anthropicText = (text: string): Reply => () => {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

/** A whole (non-streamed) Claude text reply. */
const anthropicMessage = (text: string): Reply => () =>
  json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 3 } });

/** Anthropic's rate-limit answer: HTTP 429 with a `rate_limit_error`, no Retry-After. */
const anthropicRateLimited: Reply = () => json({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }, 429);

/** A transport failure: fetch rejects before any answer arrives. */
const networkFailure: Reply = () => {
  throw new TypeError('fetch failed');
};

const geminiRateLimited: Reply = () => json({ error: { code: 429, message: 'Resource has been exhausted.', status: 'RESOURCE_EXHAUSTED' } }, 429);
const geminiUnavailable: Reply = () => json({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }, 503);
const geminiText = (text: string): Reply => () =>
  json({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } });

const orListing: Reply = () => json({ data: [{ id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000, pricing: { prompt: '0.000005', completion: '0.000015' }, architecture: { modality: 'text' } }] });
const orUnavailable: Reply = () => json({ error: { code: 503, message: 'No instances available' } }, 503);
const orText = (text: string): Reply => () =>
  json({ id: 'gen-1', object: 'chat.completion', created: 1, model: 'openai/gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });

/** Answers each request with the next reply queued for the first pattern its URL matches; the last reply repeats. */
function route(table: Array<[RegExp, Reply[]]>): void {
  const queues = table.map(([, replies]) => [...replies]);
  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url);
    const i = table.findIndex(([pattern]) => pattern.test(u));
    if (i === -1) throw new Error(`unexpected request ${u}`);
    const queue = queues[i];
    return (queue.length > 1 ? queue.shift()! : queue[0])();
  });
}

/** The POSTs sent to URLs matching `pattern`. */
const posts = (pattern: RegExp): unknown[] =>
  fetchMock.mock.calls.filter(([url, init]) => pattern.test(String(url)) && String((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST');

/** Awaits `promise` and returns what it rejected with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
  backoff.calls = 0;
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-attempts');
  vi.stubEnv('GEMINI_API_KEY', 'gem-attempts');
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-attempts');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('maxAttempts on the Anthropic provider', () => {
  const call = (maxAttempts?: number) =>
    generateText({
      model: 'anthropic:claude-haiku-5-5',
      apiKey: 'sk-ant-attempts',
      prompt: 'Say ok.',
      fallbackProviders: [],
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    });

  it('with maxAttempts 1, a 529 sends one request and the call fails', async () => {
    route([[ANTHROPIC, [anthropicOverloaded, anthropicOverloaded, anthropicText('ok')]]]);
    const error = await rejectionOf(call(1));
    expect(error).toBeInstanceOf(Error);
    expect(posts(ANTHROPIC)).toHaveLength(1);
    expect(backoff.calls).toBe(0);
  });

  it('with maxAttempts 2, two 529s send two requests and the call fails without a third', async () => {
    route([[ANTHROPIC, [anthropicOverloaded, anthropicOverloaded, anthropicText('ok')]]]);
    await rejectionOf(call(2));
    expect(posts(ANTHROPIC)).toHaveLength(2);
  });

  it('with maxAttempts 2, a 529 then a reply answers on the second request', async () => {
    route([[ANTHROPIC, [anthropicOverloaded, anthropicText('ok')]]]);
    const result = await call(2);
    expect(result.text).toBe('ok');
    expect(posts(ANTHROPIC)).toHaveLength(2);
  });

  it('left out, the configured count (3) holds', async () => {
    route([[ANTHROPIC, [anthropicOverloaded, anthropicOverloaded, anthropicText('ok')]]]);
    const result = await call();
    expect(result.text).toBe('ok');
    expect(posts(ANTHROPIC)).toHaveLength(3);
  });

  it('a count that is not a whole number of 1 or more is refused before anything is sent', async () => {
    route([[ANTHROPIC, [anthropicText('ok')]]]);
    expect(await rejectionOf(call(0))).toBeInstanceOf(RangeError);
    expect(await rejectionOf(call(1.5))).toBeInstanceOf(RangeError);
    expect(posts(ANTHROPIC)).toHaveLength(0);
  });

  it('on the non-streamed transport, maxAttempts 1 sends one request and waits no backoff after it', async () => {
    route([[ANTHROPIC, [anthropicOverloaded, anthropicOverloaded, anthropicMessage('ok')]]]);
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'sk-ant-attempts', streamCompletions: false });
    const error = await rejectionOf(provider.generateCompletion('claude-haiku-5-5', [{ role: 'user', content: 'Say ok.' }], { maxAttempts: 1 }));
    expect(error).toMatchObject({ code: 'API_SERVER_ERROR' });
    expect(posts(ANTHROPIC)).toHaveLength(1);
    expect(backoff.calls).toBe(0);
  });

  it('on the non-streamed transport, maxAttempts 2 retries a 529 once and answers', async () => {
    route([[ANTHROPIC, [anthropicOverloaded, anthropicMessage('ok')]]]);
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'sk-ant-attempts', streamCompletions: false });
    const result = await provider.generateCompletion('claude-haiku-5-5', [{ role: 'user', content: 'Say ok.' }], { maxAttempts: 2 });
    expect(result.choices[0]?.message?.content).toBe('ok');
    expect(posts(ANTHROPIC)).toHaveLength(2);
  });
});

describe('maxAttempts on the Anthropic provider: 429s and transport failures', () => {
  const provider = async () => {
    const p = new AnthropicProvider();
    await p.initialize({ apiKey: 'sk-ant-attempts', streamCompletions: false });
    return p;
  };
  const ask = async (maxAttempts: number) =>
    (await provider()).generateCompletion('claude-haiku-5-5', [{ role: 'user', content: 'Say ok.' }], { maxAttempts });

  it('with maxAttempts 1, a 429 sends one request and waits no backoff after it', async () => {
    route([[ANTHROPIC, [anthropicRateLimited, anthropicMessage('ok')]]]);
    expect(await rejectionOf(ask(1))).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    expect(posts(ANTHROPIC)).toHaveLength(1);
    expect(backoff.calls).toBe(0);
  });

  it('with maxAttempts 2, a 429 waits one backoff and the second request answers', async () => {
    route([[ANTHROPIC, [anthropicRateLimited, anthropicMessage('ok')]]]);
    const result = await ask(2);
    expect(result.choices[0]?.message?.content).toBe('ok');
    expect(posts(ANTHROPIC)).toHaveLength(2);
    expect(backoff.calls).toBe(1);
  });

  it('with maxAttempts 1, a transport failure sends one request and the call fails', async () => {
    route([[ANTHROPIC, [networkFailure, anthropicMessage('ok')]]]);
    expect(await rejectionOf(ask(1))).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(posts(ANTHROPIC)).toHaveLength(1);
    expect(backoff.calls).toBe(0);
  });

  it('with maxAttempts 2, a transport failure is retried once and the second request answers', async () => {
    route([[ANTHROPIC, [networkFailure, anthropicMessage('ok')]]]);
    const result = await ask(2);
    expect(result.choices[0]?.message?.content).toBe('ok');
    expect(posts(ANTHROPIC)).toHaveLength(2);
    expect(backoff.calls).toBe(1);
  });
});

describe('maxAttempts on the Gemini provider: 429s and transport failures', () => {
  const ask = async (maxAttempts: number) => {
    const p = new GeminiProvider();
    await p.initialize({ apiKey: 'gem-attempts' });
    return p.generateCompletion('gemini-2.5-flash', [{ role: 'user', content: 'Say ok.' }], { maxAttempts });
  };

  it('with maxAttempts 1, a 429 sends one request and waits no backoff after it', async () => {
    route([[GEMINI, [geminiRateLimited, geminiText('ok')]]]);
    expect(await rejectionOf(ask(1))).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    expect(posts(GEMINI)).toHaveLength(1);
    expect(backoff.calls).toBe(0);
  });

  it('with maxAttempts 2, a 429 waits one backoff and the second request answers', async () => {
    route([[GEMINI, [geminiRateLimited, geminiText('ok')]]]);
    const result = await ask(2);
    expect(result.choices[0]?.message?.content).toBe('ok');
    expect(posts(GEMINI)).toHaveLength(2);
    expect(backoff.calls).toBe(1);
  });

  it('with maxAttempts 1, a transport failure sends one request and the call fails', async () => {
    route([[GEMINI, [networkFailure, geminiText('ok')]]]);
    expect(await rejectionOf(ask(1))).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(posts(GEMINI)).toHaveLength(1);
    expect(backoff.calls).toBe(0);
  });

  it('with maxAttempts 2, a transport failure is retried once and the second request answers', async () => {
    route([[GEMINI, [networkFailure, geminiText('ok')]]]);
    const result = await ask(2);
    expect(result.choices[0]?.message?.content).toBe('ok');
    expect(posts(GEMINI)).toHaveLength(2);
    expect(backoff.calls).toBe(1);
  });
});

describe('maxAttempts on the Gemini provider', () => {
  const call = (maxAttempts?: number) =>
    generateText({
      model: 'gemini:gemini-2.5-flash',
      apiKey: 'gem-attempts',
      prompt: 'Say ok.',
      fallbackProviders: [],
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    });

  it('with maxAttempts 1, a 503 sends one request, waits no backoff, and the call fails', async () => {
    route([[GEMINI, [geminiUnavailable, geminiUnavailable, geminiText('ok')]]]);
    await rejectionOf(call(1));
    expect(posts(GEMINI)).toHaveLength(1);
    expect(backoff.calls).toBe(0);
  });

  it('with maxAttempts 2, a 503 then a reply answers on the second request', async () => {
    route([[GEMINI, [geminiUnavailable, geminiText('ok')]]]);
    const result = await call(2);
    expect(result.text).toBe('ok');
    expect(posts(GEMINI)).toHaveLength(2);
  });

  it('left out, the configured count (3) holds', async () => {
    route([[GEMINI, [geminiUnavailable, geminiUnavailable, geminiText('ok')]]]);
    const result = await call();
    expect(result.text).toBe('ok');
    expect(posts(GEMINI)).toHaveLength(3);
  });

  it('a count that is not a whole number of 1 or more is refused before anything is sent', async () => {
    route([[GEMINI, [geminiText('ok')]]]);
    expect(await rejectionOf(call(0))).toBeInstanceOf(RangeError);
    expect(posts(GEMINI)).toHaveLength(0);
  });
});

describe('maxAttempts on the OpenRouter provider', () => {
  const call = (maxAttempts?: number) =>
    generateText({
      model: 'openrouter:openai/gpt-4o',
      apiKey: 'sk-or-attempts',
      prompt: 'Say ok.',
      fallbackProviders: [],
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    });

  it('with maxAttempts 1, a 503 sends one request and the call fails', async () => {
    route([[OR_LIST, [orListing]], [OR_CHAT, [orUnavailable, orUnavailable, orText('ok')]]]);
    await rejectionOf(call(1));
    expect(posts(OR_CHAT)).toHaveLength(1);
  });

  it('with maxAttempts 2, a 503 then a reply answers on the second request', async () => {
    route([[OR_LIST, [orListing]], [OR_CHAT, [orUnavailable, orText('ok')]]]);
    const result = await call(2);
    expect(result.text).toBe('ok');
    expect(posts(OR_CHAT)).toHaveLength(2);
  });

  it('left out, the configured count (3) holds', async () => {
    route([[OR_LIST, [orListing]], [OR_CHAT, [orUnavailable, orUnavailable, orText('ok')]]]);
    const result = await call();
    expect(result.text).toBe('ok');
    expect(posts(OR_CHAT)).toHaveLength(3);
  }, 15_000);

  it('a count that is not a whole number of 1 or more is refused before anything is sent', async () => {
    route([[OR_LIST, [orListing]], [OR_CHAT, [orText('ok')]]]);
    expect(await rejectionOf(call(0))).toBeInstanceOf(RangeError);
    expect(posts(OR_CHAT)).toHaveLength(0);
  });
});

const GEMINI_STREAM = /generativelanguage\.googleapis\.com\/.*:streamGenerateContent/;
const GEMINI_RETIRED = /\/models\/gemini-3\.1-pro-preview:generateContent/;
const GEMINI_ALIAS = /\/models\/gemini-pro-latest:generateContent/;
const GEMINI_RETIRED_STREAM = /\/models\/gemini-3\.1-pro-preview:streamGenerateContent/;
const GEMINI_ALIAS_STREAM = /\/models\/gemini-pro-latest:streamGenerateContent/;

/** Google's answer for a model id it no longer serves. */
const geminiNotFound: Reply = () => json({ error: { code: 404, message: 'models/gemini-3.1-pro-preview is not found.', status: 'NOT_FOUND' } }, 404);

/** A streamed Gemini text reply (`alt=sse`). */
const geminiStreamText = (text: string): Reply => () =>
  new Response(
    `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } })}\r\n\r\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

/** Reads a stream to its end. */
async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // read and dropped
  }
}

const geminiProvider = async () => {
  const p = new GeminiProvider();
  await p.initialize({ apiKey: 'gem-attempts' });
  return p;
};

describe('maxAttempts on the Gemini provider: a retired pin served from its alias', () => {
  const ask = async (maxAttempts?: number) =>
    (await geminiProvider()).generateCompletion('gemini-3.1-pro-preview', [{ role: 'user', content: 'Say ok.' }], maxAttempts !== undefined ? { maxAttempts } : {});

  it('with maxAttempts 1, the 404 ends the call and the alias is not asked', async () => {
    route([[GEMINI_RETIRED, [geminiNotFound]], [GEMINI_ALIAS, [geminiText('ok')]]]);
    expect(await rejectionOf(ask(1))).toMatchObject({ httpStatus: 404 });
    expect(posts(GEMINI_RETIRED)).toHaveLength(1);
    expect(posts(GEMINI_ALIAS)).toHaveLength(0);
  });

  it('with maxAttempts 2, a 503 and then the 404 spend both attempts and the alias is not asked', async () => {
    route([[GEMINI_RETIRED, [geminiUnavailable, geminiNotFound]], [GEMINI_ALIAS, [geminiText('ok')]]]);
    expect(await rejectionOf(ask(2))).toMatchObject({ httpStatus: 404 });
    expect(posts(GEMINI_RETIRED)).toHaveLength(2);
    expect(posts(GEMINI_ALIAS)).toHaveLength(0);
  });

  it('with maxAttempts 2, the 404 leaves one attempt for the alias, which is not retried', async () => {
    route([[GEMINI_RETIRED, [geminiNotFound]], [GEMINI_ALIAS, [geminiUnavailable, geminiText('ok')]]]);
    expect(await rejectionOf(ask(2))).toMatchObject({ httpStatus: 503 });
    expect(posts(GEMINI_RETIRED)).toHaveLength(1);
    expect(posts(GEMINI_ALIAS)).toHaveLength(1);
  });

  it('left out, the alias answers', async () => {
    route([[GEMINI_RETIRED, [geminiNotFound]], [GEMINI_ALIAS, [geminiText('ok')]]]);
    const result = await ask();
    expect(result.choices[0]?.message?.content).toBe('ok');
    expect(posts(GEMINI_ALIAS)).toHaveLength(1);
  });
});

describe('maxAttempts on the Anthropic and Gemini streams', () => {
  const anthropicStream = async (maxAttempts: number) => {
    const p = new AnthropicProvider();
    await p.initialize({ apiKey: 'sk-ant-attempts' });
    return p.generateCompletionStream('claude-haiku-5-5', [{ role: 'user', content: 'Say ok.' }], { maxAttempts });
  };
  const geminiStream = async (modelId: string, maxAttempts?: number) =>
    (await geminiProvider()).generateCompletionStream(modelId, [{ role: 'user', content: 'Say ok.' }], maxAttempts !== undefined ? { maxAttempts } : {});

  it('Anthropic: a count that is not a whole number of 1 or more is refused before anything is sent', async () => {
    route([[ANTHROPIC, [anthropicText('ok')]]]);
    expect(await rejectionOf(drain(await anthropicStream(0)))).toBeInstanceOf(RangeError);
    expect(await rejectionOf(drain(await anthropicStream(1.5)))).toBeInstanceOf(RangeError);
    expect(posts(ANTHROPIC)).toHaveLength(0);
  });

  it('Gemini: a count that is not a whole number of 1 or more is refused before anything is sent', async () => {
    route([[GEMINI_STREAM, [geminiStreamText('ok')]]]);
    expect(await rejectionOf(drain(await geminiStream('gemini-2.5-flash', 0)))).toBeInstanceOf(RangeError);
    expect(await rejectionOf(drain(await geminiStream('gemini-2.5-flash', 1.5)))).toBeInstanceOf(RangeError);
    expect(posts(GEMINI_STREAM)).toHaveLength(0);
  });

  it('Gemini: with maxAttempts 1, a retired pin\'s 404 ends the stream and the alias is not asked', async () => {
    route([[GEMINI_RETIRED_STREAM, [geminiNotFound]], [GEMINI_ALIAS_STREAM, [geminiStreamText('ok')]]]);
    expect(await rejectionOf(drain(await geminiStream('gemini-3.1-pro-preview', 1)))).toMatchObject({ httpStatus: 404 });
    expect(posts(GEMINI_ALIAS_STREAM)).toHaveLength(0);
  });

  it('Gemini: with maxAttempts 2, a retired pin streams from its alias', async () => {
    route([[GEMINI_RETIRED_STREAM, [geminiNotFound]], [GEMINI_ALIAS_STREAM, [geminiStreamText('ok')]]]);
    await drain(await geminiStream('gemini-3.1-pro-preview', 2));
    expect(posts(GEMINI_ALIAS_STREAM)).toHaveLength(1);
  });
});

describe('the configured count bounds a Gemini stream\'s alias when the call names none', () => {
  const stream = async (maxRetries: number) => {
    const p = new GeminiProvider();
    await p.initialize({ apiKey: 'gem-attempts', maxRetries });
    return p.generateCompletionStream('gemini-3.1-pro-preview', [{ role: 'user', content: 'Say ok.' }], {});
  };

  it('with maxRetries 1, a retired pin\'s 404 ends the stream and the alias is not asked', async () => {
    route([[GEMINI_RETIRED_STREAM, [geminiNotFound]], [GEMINI_ALIAS_STREAM, [geminiStreamText('ok')]]]);
    expect(await rejectionOf(drain(await stream(1)))).toMatchObject({ httpStatus: 404 });
    expect(posts(GEMINI_ALIAS_STREAM)).toHaveLength(0);
  });

  it('with maxRetries 2, the alias streams', async () => {
    route([[GEMINI_RETIRED_STREAM, [geminiNotFound]], [GEMINI_ALIAS_STREAM, [geminiStreamText('ok')]]]);
    await drain(await stream(2));
    expect(posts(GEMINI_ALIAS_STREAM)).toHaveLength(1);
  });
});
