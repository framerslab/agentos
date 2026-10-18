import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { GeminiProvider } from '../implementations/GeminiProvider';
import { GeminiProviderError } from '../errors/GeminiProviderError';

/**
 * Several Gemini keys in one provider (the key pool v2 design): a key the
 * API rejects (its HTTP 400 with reason API_KEY_INVALID) or throttles (429)
 * is taken out and the request moves to the next usable key at once; every
 * key out throws ALL_KEYS_FAILED; a probe (the models list) re-admits a
 * failed key; a single key keeps the first version's behaviour. `fetch` is
 * stubbed; nothing leaves the process.
 */

type Call = { url: string; init: RequestInit };

function callsOf(): Call[] {
  return fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: (init ?? {}) as RequestInit }));
}

function keyOf(call: Call): string | null {
  return new Headers(call.init.headers).get('x-goog-api-key');
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

const okContent = {
  candidates: [{ content: { parts: [{ text: 'hello' }], role: 'model' }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
};

// The envelope the API answered a bogus key with on 17 Oct 2026: HTTP 400, not 401.
const invalidKey = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
  },
};
const exhausted = { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } };
const badRequest = { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "foo".', status: 'INVALID_ARGUMENT' } };

async function provider(apiKey: string, extra: Record<string, unknown> = {}): Promise<GeminiProvider> {
  const p = new GeminiProvider();
  await p.initialize({ apiKey, maxRetries: 3, keyPool: { strategy: 'ordered', recheckMs: 60_000 }, ...extra });
  return p;
}

const ask = (p: GeminiProvider) => p.generateCompletion('gemini-2.5-flash', [{ role: 'user', content: 'hi' }], {});

describe('GeminiProvider key failover', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('moves from a rejected key to a throttled key to a working one in order, without waiting on the hops', async () => {
    const p = await provider('key_alpha_0001,key_beta_0002,key_gamma_0003');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, invalidKey))
      .mockResolvedValueOnce(jsonResponse(429, exhausted, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse(200, okContent));
    const started = Date.now();
    const answer = await ask(p);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(answer.choices[0]?.message?.content).toBe('hello');
    expect(callsOf().map(keyOf)).toEqual(['key_alpha_0001', 'key_beta_0002', 'key_gamma_0003']);

    const pool = (p as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    const [a, b, c] = pool.snapshot();
    expect(a).toMatchObject({ status: 'failed', kind: 'auth', failures: 1 });
    expect(b).toMatchObject({ status: 'resting', kind: 'quota' });
    expect((b.until as number) - Date.now()).toBeLessThanOrEqual(2000);
    expect(c).toMatchObject({ status: 'ok' });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, okContent));
    await ask(p);
    expect(keyOf(callsOf()[3])).toBe('key_gamma_0003');
  });

  it("keeps a plain 400 as the request's fault: no hop, no mark", async () => {
    const p = await provider('key_alpha_0001,key_beta_0002');
    fetchMock.mockResolvedValueOnce(jsonResponse(400, badRequest));
    await expect(ask(p)).rejects.toMatchObject({ code: 'API_CLIENT_ERROR', httpStatus: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const pool = (p as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(pool.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
  });

  it('throws ALL_KEYS_FAILED once every key is out, and sends nothing until one returns', async () => {
    const p = await provider('key_alpha_0001,key_beta_0002');
    fetchMock.mockResolvedValueOnce(jsonResponse(400, invalidKey)).mockResolvedValueOnce(jsonResponse(400, invalidKey));
    const error = await ask(p).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiProviderError);
    expect(error).toMatchObject({ code: 'ALL_KEYS_FAILED' });
    expect((error as GeminiProviderError).details).toMatchObject({ kinds: ['auth'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(ask(p)).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('opens no stream either once every key is out', async () => {
    const p = await provider('key_alpha_0001,key_beta_0002');
    fetchMock.mockResolvedValueOnce(jsonResponse(400, invalidKey)).mockResolvedValueOnce(jsonResponse(400, invalidKey));
    await ask(p).catch(() => undefined);
    await expect(p.generateCompletionStream('gemini-2.5-flash', [{ role: 'user', content: 'hi' }], {}).next()).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('records a success, so an older failure cannot take a working key out', async () => {
    const p = await provider('key_alpha_0001,key_beta_0002');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, okContent));
    await ask(p);
    const pool = (p as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(typeof pool.snapshot()[0].lastOkAt).toBe('number');
  });

  it('re-admits a failed key when the models-list probe passes, and prefers it again in order', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const p = await provider('key_alpha_0001,key_beta_0002', { keyPool: { strategy: 'ordered', recheckMs: 1000 } });
    fetchMock.mockResolvedValueOnce(jsonResponse(400, invalidKey)).mockResolvedValueOnce(jsonResponse(200, okContent));
    await ask(p);
    expect(callsOf().map(keyOf)).toEqual(['key_alpha_0001', 'key_beta_0002']);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { models: [] }));
    vi.advanceTimersByTime(1001);
    const pool = (p as unknown as { keyPool: { recheck(): Promise<void>; snapshot(): Array<Record<string, unknown>> } }).keyPool;
    await pool.recheck();
    const probe = callsOf()[2];
    expect(probe.url).toContain('/models?pageSize=1');
    expect(probe.init.method).toBe('GET');
    expect(keyOf(probe)).toBe('key_alpha_0001');
    expect(pool.snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, okContent));
    await ask(p);
    expect(keyOf(callsOf()[3])).toBe('key_alpha_0001');
  });

  it("keeps the first version's behaviour for a single key: the invalid-key 400 throws at once as a client error", async () => {
    const p = await provider('key_only_0001');
    fetchMock.mockResolvedValueOnce(jsonResponse(400, invalidKey));
    await expect(ask(p)).rejects.toMatchObject({ code: 'API_CLIENT_ERROR', httpStatus: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads the strategy from the environment when the config names none', async () => {
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY', 'ordered');
    const p = new GeminiProvider();
    await p.initialize({ apiKey: 'key_alpha_0001,key_beta_0002' });
    fetchMock.mockResolvedValue(jsonResponse(200, okContent));
    await ask(p);
    await ask(p);
    await ask(p);
    expect(callsOf().map(keyOf)).toEqual(['key_alpha_0001', 'key_alpha_0001', 'key_alpha_0001']);
  });
});
