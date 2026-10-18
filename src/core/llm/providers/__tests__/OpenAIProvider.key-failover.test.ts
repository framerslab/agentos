import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { OpenAIProvider } from '../implementations/OpenAIProvider';
import { OpenAIProviderError } from '../errors/OpenAIProviderError';

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
