/**
 * @file OpenRouterProvider.key-failover.test.ts
 * Several OpenRouter keys in one provider (the key pool v2 design): a key
 * that answers 401 or 402 is taken out and the request moves to the next
 * usable key at once, outside the attempt count; every key out throws
 * ALL_KEYS_FAILED and sends nothing more; a success records the key as
 * good. The axios client is injected; nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider } from '../implementations/OpenRouterProvider';
import { OpenRouterProviderError } from '../errors/OpenRouterProviderError';
import { ApiKeyPool, keyFingerprint } from '../../../providers/ApiKeyPool';
import { InMemoryKeyPoolStateStore } from '../../../providers/KeyPoolStateStore';
import type { ChatMessage } from '../IProvider';

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const MODEL = 'anthropic/claude-sonnet-5.5';

/** Bare provider with injected internals (initialize() hits the network). */
function makeProvider(clientRequest: ReturnType<typeof vi.fn>, keys = 'key_alpha_0001,key_beta_0002') {
  const provider = new OpenRouterProvider();
  const keyPool = new ApiKeyPool(keys, { strategy: 'ordered' });
  Object.assign(provider as unknown as Record<string, unknown>, {
    isInitialized: true,
    ensureInitialized: () => {},
    config: { apiKey: keys, baseURL: 'https://openrouter.ai/api/v1', requestTimeout: 1000, streamRequestTimeout: 1000 },
    keyPool,
    client: { request: clientRequest },
  });
  return { provider, keyPool };
}

function axiosError(status: number | undefined, body: unknown) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: status === undefined ? undefined : { status, data: body, headers: {} },
  };
}

function okResponse() {
  return {
    id: 'gen-ok',
    object: 'chat.completion',
    created: 1,
    model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127, cost: 0.0004 },
  };
}

/** The bearer each request carried, in order. */
function bearers(request: ReturnType<typeof vi.fn>): string[] {
  return request.mock.calls.map(([options]) => String((options as { headers: Record<string, string> }).headers.Authorization));
}

// The envelopes OpenRouter answered with on 17 Oct 2026 (a bogus key) and documents for spent credits.
const noAuth = { error: { message: 'Missing Authentication header', code: 401 } };
const noCredits = { error: { message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits', code: 402 } };

/**
 * A provider initialized for real over a mocked axios client (the catalog it lists at start is `models`), so the
 * pool carries the provider's own probe. The probes go out through `fetch`, which the caller stubs.
 */
async function mountProvider(apiKey: string, models: unknown[], extra: Record<string, unknown> = {}) {
  const client = { request: vi.fn(), get: vi.fn() };
  const axios = (await import('axios')).default;
  vi.spyOn(axios, 'create').mockReturnValue(client as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  client.request.mockResolvedValueOnce({ data: { data: models } });
  const provider = new OpenRouterProvider();
  await provider.initialize({ apiKey, keyPool: { strategy: 'ordered', recheckMs: 1000 }, ...extra });
  client.request.mockClear();
  const keyPool = (provider as unknown as { keyPool: ApiKeyPool }).keyPool;
  return { provider, client, keyPool };
}

// Catalog entries as GET /models lists them: prices per token, as strings; the auto router at -1.
const catalog = [
  { id: 'anthropic/claude-opus-5.5', name: 'Opus', context_length: 200000, pricing: { prompt: '0.000015', completion: '0.000075' } },
  { id: 'meta-llama/llama-3.3-8b-instruct:free', name: 'Free', context_length: 8000, pricing: { prompt: '0', completion: '0' } },
  { id: 'openai/gpt-4o-mini', name: 'Mini', context_length: 128000, pricing: { prompt: '0.00000015', completion: '0.0000006' } },
  { id: 'openrouter/auto', name: 'Auto', context_length: 2000000, pricing: { prompt: '-1', completion: '-1' } },
];

/** A `fetch` answer as the probes read it: status, ok, a JSON body and its text. */
function fetchAnswer(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('OpenRouterProvider key failover', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('moves from a rejected key to the next usable one inside the request, and records the success', async () => {
    const request = vi.fn().mockRejectedValueOnce(axiosError(401, noAuth)).mockResolvedValueOnce({ data: okResponse() });
    const { provider, keyPool } = makeProvider(request);
    const answer = await provider.generateCompletion(MODEL, messages, {});
    expect(answer.choices[0]?.message?.content).toBe('hi');
    expect(bearers(request)).toEqual(['Bearer key_alpha_0001', 'Bearer key_beta_0002']);
    const [a, b] = keyPool.snapshot();
    expect(a).toMatchObject({ status: 'failed', kind: 'auth', failures: 1 });
    expect(b).toMatchObject({ status: 'ok' });
    expect(typeof b.lastOkAt).toBe('number');
  });

  it('takes a key out on 402 (spent credits) and keeps going on the next', async () => {
    const request = vi.fn().mockRejectedValueOnce(axiosError(402, noCredits)).mockResolvedValueOnce({ data: okResponse() });
    const { provider, keyPool } = makeProvider(request);
    await provider.generateCompletion(MODEL, messages, {});
    expect(bearers(request)).toEqual(['Bearer key_alpha_0001', 'Bearer key_beta_0002']);
    expect(keyPool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing' });
  });

  it('throws ALL_KEYS_FAILED once every key is out, and sends nothing until one returns', async () => {
    const request = vi.fn().mockRejectedValueOnce(axiosError(401, noAuth)).mockRejectedValueOnce(axiosError(402, noCredits));
    const { provider } = makeProvider(request);
    const error = await provider.generateCompletion(MODEL, messages, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenRouterProviderError);
    expect(error).toMatchObject({ code: 'ALL_KEYS_FAILED' });
    expect((error as OpenRouterProviderError).details).toMatchObject({ kinds: expect.arrayContaining(['auth', 'billing']) });
    expect(request).toHaveBeenCalledTimes(2);

    await expect(provider.generateCompletion(MODEL, messages, {})).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reports unhealthy without a request when every key is out, instead of sending an empty bearer', async () => {
    const request = vi.fn().mockRejectedValueOnce(axiosError(401, noAuth)).mockRejectedValueOnce(axiosError(401, noAuth));
    const { provider } = makeProvider(request);
    await expect(provider.generateCompletion(MODEL, messages, {})).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED' });
    const get = vi.fn().mockResolvedValue({ data: { data: [] } });
    Object.assign((provider as unknown as { client: Record<string, unknown> }).client, { get });
    const health = await provider.checkHealth();
    expect(health.isHealthy).toBe(false);
    expect(health.details).toMatchObject({ message: 'Every OpenRouter API key is out of rotation', error: { code: 'ALL_KEYS_FAILED' } });
    expect(get).not.toHaveBeenCalled();
  });

  it('sends the health check with a usable key of the pool', async () => {
    const request = vi.fn().mockRejectedValueOnce(axiosError(401, noAuth)).mockResolvedValueOnce({ data: okResponse() });
    const { provider } = makeProvider(request);
    await provider.generateCompletion(MODEL, messages, {});
    const get = vi.fn().mockResolvedValue({ data: { data: [] } });
    Object.assign((provider as unknown as { client: Record<string, unknown> }).client, { get });
    expect((await provider.checkHealth()).isHealthy).toBe(true);
    // get('/models', { headers }): the bearer rides on the second argument.
    expect(get.mock.calls.map(([, options]) => String((options as { headers: Record<string, string> }).headers.Authorization))).toEqual([
      'Bearer key_beta_0002',
    ]);
  });

  it("keeps a 400 as the request's fault: no hop, no mark", async () => {
    const request = vi.fn().mockRejectedValueOnce(axiosError(400, { error: { code: 400, message: 'temperature must be at most 2' } }));
    const { provider, keyPool } = makeProvider(request);
    await expect(provider.generateCompletion(MODEL, messages, {})).rejects.toMatchObject({ code: 'API_REQUEST_FAILED', httpStatus: 400 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(keyPool.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
  });

  it('reads a Retry-After given as an HTTP-date for the key\'s rest and for its own wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    try {
      const rateLimited = (retryAfter: string) => ({
        isAxiosError: true,
        message: 'Request failed with status code 429',
        response: { status: 429, data: { error: { message: 'Rate limit exceeded', code: 429 } }, headers: { 'retry-after': retryAfter } },
      });
      const twoSecondsAhead = () => new Date(Date.now() + 2_000).toUTCString();
      // Two keys: the throttled key rests until the date, not the 15-minute cooldown, and the request moves on.
      const request = vi.fn().mockRejectedValueOnce(rateLimited(twoSecondsAhead())).mockResolvedValueOnce({ data: okResponse() });
      const { provider, keyPool } = makeProvider(request);
      await provider.generateCompletion(MODEL, messages, {});
      expect(bearers(request)).toEqual(['Bearer key_alpha_0001', 'Bearer key_beta_0002']);
      expect(keyPool.snapshot()[0]).toMatchObject({ status: 'resting', kind: 'quota', until: Date.now() + 2_000 });

      // One key: the request waits for the date before it tries again, not the short backoff.
      const single = vi.fn().mockRejectedValueOnce(rateLimited(twoSecondsAhead())).mockResolvedValueOnce({ data: okResponse() });
      const { provider: one } = makeProvider(single, 'key_only_0001');
      const answering = one.generateCompletion(MODEL, messages, {});
      await vi.advanceTimersByTimeAsync(1_500);
      expect(single).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600);
      expect(single).toHaveBeenCalledTimes(2);
      expect((await answering).choices[0]?.message?.content).toBe('hi');
    } finally {
      vi.useRealTimers();
    }
  });

  it('probes a billing failure with the smallest billable completion on the cheapest priced model, and an auth failure with GET /key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { provider, client, keyPool } = await mountProvider('key_alpha_0001,key_beta_0002', catalog);
      client.request.mockRejectedValueOnce(axiosError(402, noCredits)).mockResolvedValueOnce({ data: okResponse() });
      await provider.generateCompletion(MODEL, messages, {});
      expect(keyPool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing', failures: 1 });

      // The recheck: a one-token-class completion on the cheapest model with a price (never the free one, which an
      // account with no credit can still use), with the failed key; a 402 keeps it out and doubles the delay.
      fetchMock.mockResolvedValueOnce(fetchAnswer(402, noCredits));
      vi.advanceTimersByTime(1001);
      await keyPool.recheck();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key_alpha_0001');
      expect(JSON.parse(String(init.body))).toMatchObject({ model: 'openai/gpt-4o-mini', max_tokens: 16 });
      expect(keyPool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing', failures: 2 });

      // Credit is back: the next probe passes, the key is re-admitted and drawn first again.
      fetchMock.mockResolvedValueOnce(fetchAnswer(200, { id: 'gen-probe', choices: [] }));
      vi.advanceTimersByTime(2001);
      await keyPool.recheck();
      expect(keyPool.snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });
      client.request.mockResolvedValueOnce({ data: okResponse() });
      await provider.generateCompletion(MODEL, messages, {});
      expect(bearers(client.request).at(-1)).toBe('Bearer key_alpha_0001');

      // An auth failure is probed with the documented read of the calling key.
      client.request.mockRejectedValueOnce(axiosError(401, noAuth)).mockResolvedValueOnce({ data: okResponse() });
      await provider.generateCompletion(MODEL, messages, {});
      fetchMock.mockResolvedValueOnce(fetchAnswer(200, { data: { label: 'k0' } }));
      vi.advanceTimersByTime(1001);
      await keyPool.recheck();
      const [authUrl, authInit] = fetchMock.mock.calls[2] as [string, RequestInit];
      expect(authUrl).toBe('https://openrouter.ai/api/v1/key');
      expect(authInit.method).toBe('GET');
      expect(keyPool.snapshot()[0]).toMatchObject({ status: 'ok' });
      await provider.shutdown();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("probes a billing failure on the default model when one is set, and has no verdict when there is no model to send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const withDefault = await mountProvider('key_alpha_0001,key_beta_0002', catalog, { defaultModelId: 'anthropic/claude-haiku-4.5' });
      withDefault.client.request.mockRejectedValueOnce(axiosError(402, noCredits)).mockResolvedValueOnce({ data: okResponse() });
      await withDefault.provider.generateCompletion(MODEL, messages, {});
      fetchMock.mockResolvedValueOnce(fetchAnswer(402, noCredits));
      vi.advanceTimersByTime(1001);
      await withDefault.keyPool.recheck();
      expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({ model: 'anthropic/claude-haiku-4.5' });
      await withDefault.provider.shutdown();

      // Only free and unpriced models listed, no default: nothing is sent and the key stays out a longer while.
      fetchMock.mockClear();
      const freeOnly = await mountProvider('key_alpha_0001,key_beta_0002', [catalog[1], catalog[3]]);
      freeOnly.client.request.mockRejectedValueOnce(axiosError(402, noCredits)).mockResolvedValueOnce({ data: okResponse() });
      await freeOnly.provider.generateCompletion(MODEL, messages, {});
      vi.advanceTimersByTime(1001);
      await freeOnly.keyPool.recheck();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(freeOnly.keyPool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing', failures: 2 });
      await freeOnly.provider.shutdown();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('lists the catalog with the probing key when the provider started with every key out, then probes on the cheapest priced model', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      // The store holds both keys out for billing: the provider starts without its model listing (no key to send).
      const store = new InMemoryKeyPoolStateStore();
      for (const [key, label] of [['key_alpha_0001', 'k00001'], ['key_beta_0002', 'k10002']] as const) {
        await store.save('openrouter:all-out', {
          fingerprint: keyFingerprint(key),
          label,
          status: 'failed',
          kind: 'billing',
          failures: 1,
          lastFailAt: Date.now() - 1000,
          nextRecheckAt: Date.now() + 1000,
          updatedAt: Date.now() - 1000,
          version: 1,
        });
      }
      const client = { request: vi.fn(), get: vi.fn() };
      const axios = (await import('axios')).default;
      vi.spyOn(axios, 'create').mockReturnValue(client as never);
      const provider = new OpenRouterProvider();
      await provider.initialize({ apiKey: 'key_alpha_0001,key_beta_0002', keyPool: { strategy: 'ordered', recheckMs: 1000, id: 'openrouter:all-out', store } });
      expect(provider.isInitialized).toBe(true);
      expect(client.request).not.toHaveBeenCalled();

      // The catalog answers every key; the first key's credit is back, the second's is not.
      fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
        const bearer = (init.headers as Record<string, string>).Authorization;
        if (url.endsWith('/models')) return fetchAnswer(200, { data: catalog });
        return bearer === 'Bearer key_alpha_0001' ? fetchAnswer(200, { id: 'gen-probe', choices: [] }) : fetchAnswer(402, noCredits);
      });
      vi.advanceTimersByTime(1001);
      const keyPool = (provider as unknown as { keyPool: ApiKeyPool }).keyPool;
      await keyPool.recheck();
      const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
      const listings = calls.filter(([url]) => url === 'https://openrouter.ai/api/v1/models');
      expect(listings.length).toBeGreaterThanOrEqual(1);
      expect(listings.every(([, init]) => init.method === 'GET')).toBe(true);
      const completions = calls.filter(([url]) => url === 'https://openrouter.ai/api/v1/chat/completions');
      expect(completions.map(([, init]) => (init.headers as Record<string, string>).Authorization).sort()).toEqual([
        'Bearer key_alpha_0001',
        'Bearer key_beta_0002',
      ]);
      for (const [, init] of completions) expect(JSON.parse(String(init.body))).toMatchObject({ model: 'openai/gpt-4o-mini', max_tokens: 16 });
      expect(keyPool.snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });
      expect(keyPool.snapshot()[1]).toMatchObject({ status: 'failed', kind: 'billing', failures: 2 });

      // The catalog the probe listed is kept: the model listing answers from it without a request.
      const listed = await provider.listAvailableModels();
      expect(listed.map((model) => model.modelId)).toContain('openai/gpt-4o-mini');
      expect(client.request).not.toHaveBeenCalled();
      client.request.mockResolvedValueOnce({ data: okResponse() });
      await provider.generateCompletion(MODEL, messages, {});
      expect(bearers(client.request)).toEqual(['Bearer key_alpha_0001']);
      await provider.shutdown();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("ends a draw that waits on the probes when the caller aborts: a stream ends with its abort chunk, a completion with REQUEST_ABORTED, and no request goes out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { provider, client } = await mountProvider('key_alpha_0001,key_beta_0002', catalog);
      client.request.mockRejectedValueOnce(axiosError(401, noAuth)).mockRejectedValueOnce(axiosError(401, noAuth));
      await expect(provider.generateCompletion(MODEL, messages, {})).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED' });
      client.request.mockClear();

      // At the recheck the stream's draw starts both probes (GET /key), which hang; it waits on them until its
      // caller aborts, then ends with the abort chunk instead of sending the request.
      vi.setSystemTime(new Date(Date.now() + 1001));
      fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
      const controller = new AbortController();
      const reading = (async () => {
        const chunks: unknown[] = [];
        for await (const chunk of provider.generateCompletionStream(MODEL, messages, { abortSignal: controller.signal })) {
          chunks.push(chunk);
        }
        return chunks;
      })();
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/key']);
      controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      const chunks = await reading;
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ isFinal: true, choices: [], error: { type: 'abort', message: 'Stream aborted prior to first chunk' } });
      expect(client.request).not.toHaveBeenCalled();

      // A completion that waits on the same probes rejects with REQUEST_ABORTED, and sends nothing either.
      const second = new AbortController();
      const asking = provider.generateCompletion(MODEL, messages, { abortSignal: second.signal }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1);
      second.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect(await asking).toMatchObject({ code: 'REQUEST_ABORTED' });
      expect(client.request).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps the first version's behaviour for a single key: a 401 fails the request at once", async () => {
    const request = vi.fn().mockRejectedValueOnce(axiosError(401, noAuth));
    const { provider } = makeProvider(request, 'key_only_0001');
    await expect(provider.generateCompletion(MODEL, messages, {})).rejects.toMatchObject({ code: 'API_REQUEST_FAILED', httpStatus: 401 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
