/**
 * @file RequestyProvider.key-failover.test.ts
 * Several Requesty keys in one provider (the key pool v2 design): a key the
 * router rejects (its HTTP 403 "Invalid authorization token"), an unpaid key
 * (402) or a throttled key (429) is marked and the request is sent again at
 * once with the next usable key; every key out throws ALL_KEYS_FAILED before
 * anything is sent; a per-request override is never hopped. The axios client
 * is mocked; nothing leaves the process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestyProvider } from '../implementations/RequestyProvider.js';
import { RequestyProviderError } from '../errors/RequestyProviderError.js';
import { InMemoryKeyPoolStateStore } from '../../../providers/KeyPoolStateStore.js';
import { keyFingerprint } from '../../../providers/ApiKeyPool.js';

interface MockClient {
  request: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

const CHAT_MODEL = { id: 'openai/gpt-4o-mini', description: 'mock model', context_window: 128000, input_price: 1.5e-7, output_price: 6e-7 };

async function mountProvider(
  apiKey: string,
  options: { models?: unknown[]; keyPool?: Record<string, unknown>; defaultModelId?: string } = {},
): Promise<{ provider: RequestyProvider; client: MockClient }> {
  const client: MockClient = { request: vi.fn(), get: vi.fn().mockResolvedValue({ data: { data: [] } }) };
  const axios = (await import('axios')).default;
  vi.spyOn(axios, 'create').mockReturnValue(client as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  client.request.mockResolvedValueOnce({ data: { data: options.models ?? [CHAT_MODEL] } });
  const provider = new RequestyProvider();
  await provider.initialize({
    apiKey,
    keyPool: { strategy: 'ordered', ...(options.keyPool ?? {}) },
    ...(options.defaultModelId ? { defaultModelId: options.defaultModelId } : {}),
  });
  client.request.mockClear();
  return { provider, client };
}

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

// Catalog entries as GET /v1/models lists them (USD per token): a free model and a dearer one beside CHAT_MODEL.
const FREE_MODEL = { id: 'meta-llama/llama-3.3-8b-instruct:free', context_window: 8000, input_price: 0, output_price: 0 };
const DEAR_MODEL = { id: 'anthropic/claude-opus-5.5', context_window: 200000, input_price: 1.5e-5, output_price: 7.5e-5 };
// The documented description of the router's 402 (https://docs.requesty.ai/api-reference/endpoint/chat-completions-create).
const balanceExhausted = { error: { origin: 'router', message: 'Payment required - organization balance exhausted.' } };

interface PoolView {
  recheck(): Promise<void>;
  snapshot(): Array<Record<string, unknown>>;
}

function axiosError(status: number, body: unknown) {
  return { isAxiosError: true, message: `Request failed with status code ${status}`, response: { status, data: body, headers: {} } };
}

const okResponse = {
  id: 'gen-ok',
  object: 'chat.completion',
  created: 1,
  model: 'openai/gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

// The envelope the router answered a bogus key with on 17 Oct 2026: HTTP 403.
const badToken = { error: { origin: 'router', message: 'Invalid authorization token' } };

const ask = (p: RequestyProvider) => p.generateCompletion('openai/gpt-4o-mini', [{ role: 'user', content: 'hi' }], {});

function bearers(client: MockClient): string[] {
  return client.request.mock.calls.map(([options]) => String((options as { headers: Record<string, string> }).headers.Authorization));
}

describe('RequestyProvider key failover', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('moves from a rejected key to the next usable one inside the request, and records the success', async () => {
    const { provider, client } = await mountProvider('key_alpha_0001,key_beta_0002');
    client.request.mockRejectedValueOnce(axiosError(403, badToken)).mockResolvedValueOnce({ data: okResponse });
    // One call, two sends: the caller gets the answer, not the rejected key's error.
    const answer = await ask(provider);
    expect(answer.choices[0]?.message?.content).toBe('hi');
    expect(bearers(client)).toEqual(['Bearer key_alpha_0001', 'Bearer key_beta_0002']);

    const pool = (provider as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    const [a, b] = pool.snapshot();
    expect(a).toMatchObject({ status: 'failed', kind: 'auth', failures: 1 });
    expect(b).toMatchObject({ status: 'ok' });
    expect(typeof b.lastOkAt).toBe('number');
  });

  it('throws ALL_KEYS_FAILED before sending once every key is out', async () => {
    const { provider, client } = await mountProvider('key_alpha_0001,key_beta_0002');
    client.request.mockRejectedValueOnce(axiosError(403, badToken)).mockRejectedValueOnce(axiosError(402, { error: { message: 'Insufficient credits' } }));
    // The request hops from the rejected key to the unpaid one and ends on that key's answer.
    await expect(ask(provider)).rejects.toMatchObject({ code: 'API_REQUEST_FAILED', httpStatus: 402 });
    expect(bearers(client)).toEqual(['Bearer key_alpha_0001', 'Bearer key_beta_0002']);

    const error = await ask(provider).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestyProviderError);
    expect(error).toMatchObject({ code: 'ALL_KEYS_FAILED' });
    expect((error as RequestyProviderError).details).toMatchObject({ kinds: expect.arrayContaining(['auth', 'billing']) });
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("rests a throttled key for the server's Retry-After and moves the request to the next key", async () => {
    const { provider, client } = await mountProvider('key_alpha_0001,key_beta_0002');
    client.request
      .mockRejectedValueOnce({
        isAxiosError: true,
        message: 'Request failed with status code 429',
        response: { status: 429, data: { error: { message: 'Too many requests' } }, headers: { 'retry-after': '7' } },
      })
      .mockResolvedValueOnce({ data: okResponse });
    const before = Date.now();
    const answer = await ask(provider);
    expect(answer.choices[0]?.message?.content).toBe('hi');
    expect(bearers(client)).toEqual(['Bearer key_alpha_0001', 'Bearer key_beta_0002']);
    const pool = (provider as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    const [a] = pool.snapshot();
    expect(a).toMatchObject({ status: 'resting', kind: 'quota' });
    expect((a.until as number) - before).toBeGreaterThan(6000);
    expect((a.until as number) - before).toBeLessThanOrEqual(7100);
  });

  it('initializes with every key out of rotation without the model listing, and runs the recheck timer', async () => {
    const client: MockClient = { request: vi.fn(), get: vi.fn() };
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'create').mockReturnValue(client as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemoryKeyPoolStateStore();
    for (const [key, label] of [['key_alpha_0001', 'k00001'], ['key_beta_0002', 'k10002']] as const) {
      await store.save('requesty:all-out', {
        fingerprint: keyFingerprint(key),
        label,
        status: 'failed',
        kind: 'auth',
        failures: 1,
        lastFailAt: Date.now() - 1000,
        nextRecheckAt: Date.now() + 60 * 60_000,
        updatedAt: Date.now() - 1000,
        version: 1,
      });
    }
    const provider = new RequestyProvider();
    await provider.initialize({ apiKey: 'key_alpha_0001,key_beta_0002', keyPool: { strategy: 'ordered', id: 'requesty:all-out', store } });
    expect(provider.isInitialized).toBe(true);
    expect(client.request).not.toHaveBeenCalled();
    expect((provider as unknown as { keyPool: { recheckTimer?: unknown } }).keyPool.recheckTimer).toBeDefined();
    await expect(ask(provider)).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED' });
    expect(client.request).not.toHaveBeenCalled();
    await provider.shutdown();
  });

  it('never hops a per-request override, though it marks one that is also a pool key', async () => {
    const { provider, client } = await mountProvider('key_alpha_0001,key_beta_0002');
    client.request.mockRejectedValueOnce(axiosError(403, badToken));
    await expect(
      provider.generateCompletion('openai/gpt-4o-mini', [{ role: 'user', content: 'hi' }], { apiKeyOverride: 'key_alpha_0001' }),
    ).rejects.toMatchObject({ code: 'API_REQUEST_FAILED', httpStatus: 403 });
    expect(bearers(client)).toEqual(['Bearer key_alpha_0001']);
    const pool = (provider as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(pool.snapshot().map((s) => s.status)).toEqual(['failed', 'ok']);
  });

  it('probes a billing failure with the smallest billable completion on the cheapest priced model, and an auth failure with the models list', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { provider, client } = await mountProvider('key_alpha_0001,key_beta_0002', {
        models: [DEAR_MODEL, FREE_MODEL, CHAT_MODEL],
        keyPool: { recheckMs: 1000 },
      });
      const pool = (provider as unknown as { keyPool: PoolView }).keyPool;
      client.request.mockRejectedValueOnce(axiosError(402, balanceExhausted)).mockResolvedValueOnce({ data: okResponse });
      await ask(provider);
      expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing', failures: 1 });

      // The recheck: a completion on the cheapest model with a price (never the free one), with the failed key; a 402
      // keeps it out and doubles the delay.
      fetchMock.mockResolvedValueOnce(fetchAnswer(402, balanceExhausted));
      vi.advanceTimersByTime(1001);
      await pool.recheck();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://router.requesty.ai/v1/chat/completions');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key_alpha_0001');
      expect(JSON.parse(String(init.body))).toMatchObject({ model: 'openai/gpt-4o-mini', max_tokens: 16 });
      expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing', failures: 2 });

      // The balance is back: the next probe passes, the key is re-admitted and drawn first again.
      fetchMock.mockResolvedValueOnce(fetchAnswer(200, okResponse));
      vi.advanceTimersByTime(2001);
      await pool.recheck();
      expect(pool.snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });
      client.request.mockResolvedValueOnce({ data: okResponse });
      await ask(provider);
      expect(bearers(client).at(-1)).toBe('Bearer key_alpha_0001');

      // An auth failure is probed with the models list, as before.
      client.request.mockRejectedValueOnce(axiosError(403, badToken)).mockResolvedValueOnce({ data: okResponse });
      await ask(provider);
      fetchMock.mockResolvedValueOnce(fetchAnswer(200, { data: [] }));
      vi.advanceTimersByTime(1001);
      await pool.recheck();
      const [authUrl, authInit] = fetchMock.mock.calls[2] as [string, RequestInit];
      expect(authUrl).toBe('https://router.requesty.ai/v1/models');
      expect(authInit.method).toBe('GET');
      expect(pool.snapshot()[0]).toMatchObject({ status: 'ok' });
      await provider.shutdown();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('probes a billing failure on the default model when one is set, and has no verdict when only free models are listed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const withDefault = await mountProvider('key_alpha_0001,key_beta_0002', { keyPool: { recheckMs: 1000 }, defaultModelId: 'anthropic/claude-haiku-4.5' });
      withDefault.client.request.mockRejectedValueOnce(axiosError(402, balanceExhausted)).mockResolvedValueOnce({ data: okResponse });
      await ask(withDefault.provider);
      fetchMock.mockResolvedValueOnce(fetchAnswer(402, balanceExhausted));
      vi.advanceTimersByTime(1001);
      await (withDefault.provider as unknown as { keyPool: PoolView }).keyPool.recheck();
      expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({ model: 'anthropic/claude-haiku-4.5' });
      await withDefault.provider.shutdown();
      vi.restoreAllMocks();

      // Only a free model listed and no default: nothing is sent and the key stays out a longer while.
      fetchMock.mockClear();
      const freeOnly = await mountProvider('key_alpha_0001,key_beta_0002', { models: [FREE_MODEL], keyPool: { recheckMs: 1000 } });
      const pool = (freeOnly.provider as unknown as { keyPool: PoolView }).keyPool;
      freeOnly.client.request.mockRejectedValueOnce(axiosError(402, balanceExhausted)).mockResolvedValueOnce({ data: okResponse });
      await ask(freeOnly.provider);
      vi.advanceTimersByTime(1001);
      await pool.recheck();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing', failures: 2 });
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
      const client: MockClient = { request: vi.fn(), get: vi.fn() };
      const axios = (await import('axios')).default;
      vi.spyOn(axios, 'create').mockReturnValue(client as never);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const store = new InMemoryKeyPoolStateStore();
      for (const [key, label] of [['key_alpha_0001', 'k00001'], ['key_beta_0002', 'k10002']] as const) {
        await store.save('requesty:billing-out', {
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
      const provider = new RequestyProvider();
      await provider.initialize({ apiKey: 'key_alpha_0001,key_beta_0002', keyPool: { strategy: 'ordered', recheckMs: 1000, id: 'requesty:billing-out', store } });
      expect(provider.isInitialized).toBe(true);
      expect(client.request).not.toHaveBeenCalled();

      // The catalog answers every key; the first key's balance is back, the second's is not.
      fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
        const bearer = (init.headers as Record<string, string>).Authorization;
        if (url.endsWith('/models')) return fetchAnswer(200, { data: [DEAR_MODEL, FREE_MODEL, CHAT_MODEL] });
        return bearer === 'Bearer key_alpha_0001' ? fetchAnswer(200, okResponse) : fetchAnswer(402, balanceExhausted);
      });
      vi.advanceTimersByTime(1001);
      const pool = (provider as unknown as { keyPool: PoolView }).keyPool;
      await pool.recheck();
      const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
      expect(calls.some(([url, init]) => url === 'https://router.requesty.ai/v1/models' && init.method === 'GET')).toBe(true);
      const completions = calls.filter(([url]) => url === 'https://router.requesty.ai/v1/chat/completions');
      expect(completions.map(([, init]) => (init.headers as Record<string, string>).Authorization).sort()).toEqual([
        'Bearer key_alpha_0001',
        'Bearer key_beta_0002',
      ]);
      for (const [, init] of completions) expect(JSON.parse(String(init.body))).toMatchObject({ model: 'openai/gpt-4o-mini', max_tokens: 16 });
      expect(pool.snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });
      expect(pool.snapshot()[1]).toMatchObject({ status: 'failed', kind: 'billing', failures: 2 });

      // The catalog the probe listed is kept, and the key that came back serves the next request.
      expect((await provider.listAvailableModels()).map((model) => model.modelId)).toContain('openai/gpt-4o-mini');
      expect(client.request).not.toHaveBeenCalled();
      client.request.mockResolvedValueOnce({ data: okResponse });
      await ask(provider);
      expect(bearers(client)).toEqual(['Bearer key_alpha_0001']);
      await provider.shutdown();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps a 400 as the request's fault: no mark", async () => {
    const { provider, client } = await mountProvider('key_alpha_0001,key_beta_0002');
    client.request.mockRejectedValueOnce(axiosError(400, { error: { message: 'temperature must be at most 2' } }));
    await expect(ask(provider)).rejects.toMatchObject({ code: 'API_REQUEST_FAILED', httpStatus: 400 });
    const pool = (provider as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(pool.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
  });
});
