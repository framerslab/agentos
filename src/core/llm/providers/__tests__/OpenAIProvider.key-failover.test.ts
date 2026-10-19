import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { OpenAIProvider } from '../implementations/OpenAIProvider';
import { OpenAIProviderError } from '../errors/OpenAIProviderError';
import { InMemoryKeyPoolStateStore, type KeyState } from '../../../providers/KeyPoolStateStore';
import { keyFingerprint } from '../../../providers/ApiKeyPool';

/**
 * Several OpenAI keys in one provider (the key pool v2 design): a key that
 * answers 401 or 429 is taken out and the request is re-sent with the next
 * usable key inside the same attempt, so the attempt budget is untouched;
 * every key out throws ALL_KEYS_FAILED; a probe re-admits a failed key (the
 * models list for an auth failure, a one-token completion for a billing
 * failure); a single key keeps the first version's behaviour. `fetch` is
 * stubbed; nothing leaves the process.
 */

type Call = { url: string; init: RequestInit };

function callsOf(): Call[] {
  return fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: (init ?? {}) as RequestInit }));
}

function keyOf(call: Call): string | null {
  const bearer = new Headers(call.init.headers).get('authorization');
  return bearer ? bearer.replace(/^Bearer /, '') : null;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  } as unknown as Response;
}

const okChat = {
  id: 'chatcmpl_1',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};
const modelList = { object: 'list', data: [] };

// The envelopes the API answers with: a bogus key on 17 Oct 2026 (401), and its documented quota answers.
const invalidKey = {
  error: { message: 'Incorrect API key provided: sk_alph****0001. You can find your API key at https://platform.openai.com/account/api-keys.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' },
};
const insufficientQuota = {
  error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' },
};
const rateLimited = {
  error: { message: 'Rate limit reached for gpt-4o. Please try again in 2s.', type: 'requests', param: null, code: 'rate_limit_exceeded' },
};
const badRequest = { error: { message: "Invalid value: 'bogus'. Supported values are: 'text', 'json_object'.", type: 'invalid_request_error', param: 'response_format', code: null } };

/** An initialized provider: its model listing at initialization succeeds and is dropped from the call list. */
async function provider(apiKey: string, extra: Record<string, unknown> = {}): Promise<OpenAIProvider> {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, modelList));
  const p = new OpenAIProvider();
  await p.initialize({ apiKey, maxRetries: 2, defaultModelId: 'gpt-4o', keyPool: { strategy: 'ordered', recheckMs: 60_000 }, ...extra });
  fetchMock.mockClear();
  return p;
}

const ask = (p: OpenAIProvider) => p.generateCompletion('gpt-4o', [{ role: 'user', content: 'hi' }], {});

describe('OpenAIProvider key failover', () => {
  it('a multi-key initialize that fails starts no recheck interval, so a retried manager leaves none behind', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(401, invalidKey));
    const p = new OpenAIProvider();
    await expect(p.initialize({ apiKey: 'sk_alpha_0001,sk_beta_0002', maxRetries: 2, keyPool: { strategy: 'ordered', recheckMs: 1000 } })).rejects.toBeInstanceOf(OpenAIProviderError);
    // Both keys answered 401 on the models list, so the provider is not up and its pool runs no interval.
    expect(callsOf().map(keyOf)).toEqual(['sk_alpha_0001', 'sk_beta_0002']);
    expect((p as unknown as { keyPool: { recheckTimer?: unknown } }).keyPool.recheckTimer).toBeUndefined();
  });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('moves from a rejected key to a throttled key to a working one inside the attempt, without waiting on the hops', async () => {
    const p = await provider('sk_alpha_0001,sk_beta_0002,sk_gamma_0003');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, invalidKey))
      .mockResolvedValueOnce(jsonResponse(429, rateLimited, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse(200, okChat));
    const started = Date.now();
    const answer = await ask(p);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(answer.choices[0]?.message?.content).toBe('hello');
    expect(callsOf().map(keyOf)).toEqual(['sk_alpha_0001', 'sk_beta_0002', 'sk_gamma_0003']);
    expect(callsOf().every((call) => call.url.endsWith('/chat/completions'))).toBe(true);

    const pool = (p as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    const [a, b, c] = pool.snapshot();
    expect(a).toMatchObject({ status: 'failed', kind: 'auth', failures: 1 });
    expect(b).toMatchObject({ status: 'resting', kind: 'quota' });
    expect((b.until as number) - Date.now()).toBeLessThanOrEqual(2000);
    expect(c).toMatchObject({ status: 'ok' });
    expect(typeof c.lastOkAt).toBe('number');

    fetchMock.mockResolvedValueOnce(jsonResponse(200, okChat));
    await ask(p);
    expect(keyOf(callsOf()[3])).toBe('sk_gamma_0003');
  });

  it("reads OpenAI's insufficient_quota 429 as a billing failure, not a throttle", async () => {
    const p = await provider('sk_alpha_0001,sk_beta_0002');
    fetchMock.mockResolvedValueOnce(jsonResponse(429, insufficientQuota)).mockResolvedValueOnce(jsonResponse(200, okChat));
    await ask(p);
    expect(callsOf().map(keyOf)).toEqual(['sk_alpha_0001', 'sk_beta_0002']);
    const pool = (p as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing' });
  });

  it("keeps a plain 400 as the request's fault: no hop, no mark", async () => {
    const p = await provider('sk_alpha_0001,sk_beta_0002');
    fetchMock.mockResolvedValueOnce(jsonResponse(400, badRequest));
    await expect(ask(p)).rejects.toMatchObject({ code: 'API_CLIENT_ERROR', httpStatus: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const pool = (p as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(pool.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
  });

  it('throws ALL_KEYS_FAILED once every key is out, and sends nothing until one returns', async () => {
    const p = await provider('sk_alpha_0001,sk_beta_0002');
    fetchMock.mockResolvedValueOnce(jsonResponse(401, invalidKey)).mockResolvedValueOnce(jsonResponse(429, insufficientQuota));
    const error = await ask(p).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAIProviderError);
    expect(error).toMatchObject({ code: 'ALL_KEYS_FAILED' });
    expect((error as OpenAIProviderError).details).toMatchObject({ kinds: expect.arrayContaining(['auth', 'billing']) });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(ask(p)).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-admits a failed key when the models-list probe passes, and prefers it again in order', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const p = await provider('sk_alpha_0001,sk_beta_0002', { keyPool: { strategy: 'ordered', recheckMs: 1000 } });
    fetchMock.mockResolvedValueOnce(jsonResponse(401, invalidKey)).mockResolvedValueOnce(jsonResponse(200, okChat));
    await ask(p);
    expect(callsOf().map(keyOf)).toEqual(['sk_alpha_0001', 'sk_beta_0002']);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, modelList));
    vi.advanceTimersByTime(1001);
    const pool = (p as unknown as { keyPool: { recheck(): Promise<void>; snapshot(): Array<Record<string, unknown>> } }).keyPool;
    await pool.recheck();
    const probe = callsOf()[2];
    expect(probe.url).toContain('/v1/models');
    expect(probe.init.method).toBe('GET');
    expect(keyOf(probe)).toBe('sk_alpha_0001');
    expect(pool.snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, okChat));
    await ask(p);
    expect(keyOf(callsOf()[3])).toBe('sk_alpha_0001');
  });

  it('a re-initialize waits for the old pool\'s probe and writes its result before the new pool reads the store', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const store = new InMemoryKeyPoolStateStore();
    const keyPool = { strategy: 'ordered' as const, recheckMs: 1000, id: 'openai:reinit', store };
    const p = await provider('sk_alpha_0001,sk_beta_0002', { keyPool });
    fetchMock.mockResolvedValueOnce(jsonResponse(401, invalidKey)).mockResolvedValueOnce(jsonResponse(200, okChat));
    await ask(p);
    const old = (p as unknown as { keyPool: { flush(): Promise<void> } }).keyPool;
    await old.flush();
    expect((await store.load('openai:reinit'))?.map((row) => row.status)).toEqual(['failed']);
    // The interval probes the failed key and its answer comes late, after the re-initialize has begun.
    let answer: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      answer = resolve;
    }));
    vi.advanceTimersByTime(1001);
    expect(keyOf(callsOf()[2])).toBe('sk_alpha_0001');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, modelList));
    const again = p.initialize({ apiKey: 'sk_alpha_0001,sk_beta_0002', maxRetries: 2, defaultModelId: 'gpt-4o', keyPool });
    answer(jsonResponse(200, modelList));
    await again;
    // The probe's result reached the store before the new pool loaded it, so the new pool holds the key as usable.
    const fresh = (p as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(fresh).not.toBe(old);
    expect(fresh.snapshot()[0]).toMatchObject({ status: 'ok' });
    expect((await store.load('openai:reinit'))?.map((row) => row.status)).toEqual(['ok']);
  });

  it('a re-initialize that is refused leaves the provider as it was, its pool and its recheck timer included', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const p = await provider('sk_alpha_0001,sk_beta_0002', { keyPool: { strategy: 'ordered', recheckMs: 1000 } });
    fetchMock.mockResolvedValueOnce(jsonResponse(401, invalidKey)).mockResolvedValueOnce(jsonResponse(200, okChat));
    await ask(p);
    const internals = p as unknown as { keyPool: unknown; config: unknown };
    const pool = internals.keyPool;
    const config = internals.config;
    await expect(p.initialize({ apiKey: '' })).rejects.toMatchObject({ code: 'INIT_FAILED_MISSING_API_KEY' });
    await expect(p.initialize({ apiKey: 'sk_alpha_0001,sk_beta_0002', keyPool: { cooldownMs: -1 } })).rejects.toBeInstanceOf(RangeError);
    expect(internals.keyPool).toBe(pool);
    expect(internals.config).toBe(config);
    expect(p.isInitialized).toBe(true);
    // Neither refusal sent a request, and the timer still probes the failed key at its recheck.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, modelList));
    await vi.advanceTimersByTimeAsync(1001);
    expect(callsOf()[2].url).toContain('/models');
    expect(keyOf(callsOf()[2])).toBe('sk_alpha_0001');
    expect((pool as { snapshot(): Array<Record<string, unknown>> }).snapshot()[0]).toMatchObject({ status: 'ok' });
  });

  it('initializes with every key out of rotation, sends nothing until the recheck, and its timer probes the keys back', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const hours = 60 * 60_000;
    // The previous process held both keys out for billing with a doubled delay; the credit was topped up since.
    const store = new InMemoryKeyPoolStateStore();
    const id = 'openai:all-out';
    const outRow = (key: string, label: string): KeyState => ({
      fingerprint: keyFingerprint(key),
      label,
      status: 'failed',
      kind: 'billing',
      failures: 3,
      lastFailAt: Date.now() - 60_000,
      nextRecheckAt: Date.now() + 5 * hours,
      updatedAt: Date.now() - 60_000,
      version: 1,
    });
    await store.save(id, outRow('sk_alpha_0001', 'k00001'));
    await store.save(id, outRow('sk_beta_0002', 'k10002'));
    const p = new OpenAIProvider();
    await p.initialize({ apiKey: 'sk_alpha_0001,sk_beta_0002', maxRetries: 2, keyPool: { strategy: 'ordered', id, store } });
    expect(p.isInitialized).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(ask(p)).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED', httpStatus: 402 });
    expect(fetchMock).not.toHaveBeenCalled();

    // At the recheck the timer probes each key with a one-token completion on the first chat model the account lists.
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url).endsWith('/models')
        ? jsonResponse(200, { object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model', created: 1, owned_by: 'openai' }] })
        : jsonResponse(200, okChat),
    );
    await vi.advanceTimersByTimeAsync(5 * hours + 1);
    const probes = callsOf();
    expect(probes.filter((call) => call.url.endsWith('/models')).map(keyOf).sort()).toEqual(['sk_alpha_0001', 'sk_beta_0002']);
    expect(probes.filter((call) => call.url.endsWith('/chat/completions')).map(keyOf).sort()).toEqual(['sk_alpha_0001', 'sk_beta_0002']);
    const pool = (p as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(pool.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
    const answer = await ask(p);
    expect(answer.choices[0]?.message?.content).toBe('hello');
    expect(keyOf(callsOf()[probes.length])).toBe('sk_alpha_0001');
    // It initialized without the listing; the first listing now that a key is back makes it.
    const models = await p.listAvailableModels();
    expect(models.map((model) => model.modelId)).toEqual(['gpt-4o-mini']);
    expect(callsOf()[probes.length + 1].url).toMatch(/\/models$/);
  });

  it('probes a billing failure with a one-token completion on the default model, never a models list', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const p = await provider('sk_alpha_0001,sk_beta_0002', { keyPool: { strategy: 'ordered', recheckMs: 1000 } });
    fetchMock.mockResolvedValueOnce(jsonResponse(429, insufficientQuota)).mockResolvedValueOnce(jsonResponse(200, okChat));
    await ask(p);
    fetchMock.mockResolvedValueOnce(jsonResponse(429, insufficientQuota));
    vi.advanceTimersByTime(1001);
    const pool = (p as unknown as { keyPool: { recheck(): Promise<void>; snapshot(): Array<Record<string, unknown>> } }).keyPool;
    await pool.recheck();
    const probe = callsOf()[2];
    expect(probe.url).toContain('/chat/completions');
    expect(probe.init.method).toBe('POST');
    expect(JSON.parse(String(probe.init.body))).toMatchObject({ model: 'gpt-4o', max_tokens: 1 });
    expect(keyOf(probe)).toBe('sk_alpha_0001');
    expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing', failures: 2 });
  });

  it('never marks or hops a per-request override, even one equal to a pool key', async () => {
    const p = await provider('sk_alpha_0001,sk_beta_0002');
    fetchMock.mockResolvedValueOnce(jsonResponse(401, invalidKey));
    await expect(p.generateCompletion('gpt-4o', [{ role: 'user', content: 'hi' }], { apiKeyOverride: 'sk_alpha_0001' })).rejects.toMatchObject({ code: 'API_CLIENT_ERROR', httpStatus: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(keyOf(callsOf()[0])).toBe('sk_alpha_0001');
    const pool = (p as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(pool.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
  });

  it("keeps the first version's behaviour for a single key: a 401 throws at once as a client error", async () => {
    const p = await provider('sk_only_0001');
    fetchMock.mockResolvedValueOnce(jsonResponse(401, invalidKey));
    await expect(ask(p)).rejects.toMatchObject({ code: 'API_CLIENT_ERROR', httpStatus: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads the strategy from the environment when the config names none', async () => {
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY', 'ordered');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, modelList));
    const p = new OpenAIProvider();
    await p.initialize({ apiKey: 'sk_alpha_0001,sk_beta_0002', maxRetries: 1 });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse(200, okChat));
    await ask(p);
    await ask(p);
    await ask(p);
    expect(callsOf().map(keyOf)).toEqual(['sk_alpha_0001', 'sk_alpha_0001', 'sk_alpha_0001']);
  });
});
