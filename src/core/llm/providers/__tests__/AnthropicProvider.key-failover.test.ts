import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { AnthropicProvider } from '../implementations/AnthropicProvider';
import { AnthropicProviderError } from '../errors/AnthropicProviderError';

/**
 * Several Anthropic keys in one provider (the key pool v2 design): a key
 * that answers 401, 402, 429 or the credit-balance 400 is taken out and the
 * request moves to the next usable key at once; every key out throws
 * ALL_KEYS_FAILED; a probe re-admits a failed key; a single key keeps the
 * first version's behaviour. `fetch` is stubbed; nothing leaves the process.
 */

type Call = { url: string; init: RequestInit };

function callsOf(): Call[] {
  return fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: (init ?? {}) as RequestInit }));
}

function keyOf(call: Call): string {
  const headers = call.init.headers as Record<string, string>;
  return headers['x-api-key'];
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const okMessage = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 2 },
};

const authError = { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } };
const rateLimit = { type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests exceeded' } };
const creditGone = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
  },
};
const badRequest = { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be positive' } };

const d = (o: unknown) => `data: ${JSON.stringify(o)}`;

function sseResponse(status: number, events?: string[], body?: unknown): Response {
  if (status !== 200) return jsonResponse(status, body);
  const encoder = new TextEncoder();
  const payload = (events ?? []).join('\n\n') + '\n\n';
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: () => Promise.reject(new Error('SSE body, not JSON')),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
  } as unknown as Response;
}

const streamEvents = [
  d({
    type: 'message_start',
    message: { id: 'msg_s', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } },
  }),
  d({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  d({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }),
  d({ type: 'content_block_stop', index: 0 }),
  d({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }),
  d({ type: 'message_stop' }),
];

async function provider(apiKey: string, extra: Record<string, unknown> = {}): Promise<AnthropicProvider> {
  const p = new AnthropicProvider();
  await p.initialize({ apiKey, maxRetries: 3, streamCompletions: false, keyPool: { strategy: 'ordered', recheckMs: 60_000 }, ...extra });
  return p;
}

const ask = (p: AnthropicProvider) => p.generateCompletion('claude-opus-5-5', [{ role: 'user', content: 'hi' }], {});

describe('AnthropicProvider key failover', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves from a revoked key to a throttled key to a working one in order, without waiting on the hops', async () => {
    const p = await provider('sk_a,sk_b,sk_c');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, authError))
      .mockResolvedValueOnce(jsonResponse(429, rateLimit, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse(200, okMessage));
    const started = Date.now();
    const answer = await ask(p);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(answer.choices[0]?.message?.content).toBe('hello');
    expect(callsOf().map(keyOf)).toEqual(['sk_a', 'sk_b', 'sk_c']);

    const pool = (p as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>>; next(): string } }).keyPool;
    const [a, b, c] = pool.snapshot();
    expect(a).toMatchObject({ status: 'failed', kind: 'auth', failures: 1 });
    expect(b).toMatchObject({ status: 'resting', kind: 'quota' });
    expect((b.until as number) - Date.now()).toBeLessThanOrEqual(2000);
    expect(c).toMatchObject({ status: 'ok' });
    expect(typeof c.lastOkAt).toBe('number');

    fetchMock.mockResolvedValueOnce(jsonResponse(200, okMessage));
    await ask(p);
    expect(keyOf(callsOf()[3])).toBe('sk_c');
  });

  it("takes a key out on Anthropic's credit-balance 400 and keeps a plain 400 as the request's fault", async () => {
    const p = await provider('sk_a,sk_b');
    fetchMock.mockResolvedValueOnce(jsonResponse(400, creditGone)).mockResolvedValueOnce(jsonResponse(200, okMessage));
    await ask(p);
    expect(callsOf().map(keyOf)).toEqual(['sk_a', 'sk_b']);
    const pool = (p as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing' });

    fetchMock.mockReset();
    const q = await provider('sk_a,sk_b');
    fetchMock.mockResolvedValueOnce(jsonResponse(400, badRequest));
    await expect(ask(q)).rejects.toMatchObject({ code: 'API_CLIENT_ERROR', httpStatus: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const poolQ = (q as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(poolQ.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
  });

  it('throws ALL_KEYS_FAILED once every key is out, with the kinds and the soonest return', async () => {
    const p = await provider('sk_a,sk_b');
    fetchMock.mockResolvedValueOnce(jsonResponse(401, authError)).mockResolvedValueOnce(jsonResponse(402, { type: 'error', error: { type: 'billing_error', message: 'no credit' } }));
    const error = await ask(p).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnthropicProviderError);
    expect(error).toMatchObject({ code: 'ALL_KEYS_FAILED' });
    expect((error as AnthropicProviderError).details).toMatchObject({ kinds: expect.arrayContaining(['auth', 'billing']) });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The next request sends nothing until a key returns; the error carries the status of the kind that took the
    // keys out (402 here), so the provider health breaker treats the pool as it treats that answer.
    await expect(ask(p)).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED', httpStatus: 402 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-admits a failed key when its probe passes, and prefers it again in order', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const p = await provider('sk_a,sk_b', { keyPool: { strategy: 'ordered', recheckMs: 1000 } });
    fetchMock.mockResolvedValueOnce(jsonResponse(401, authError)).mockResolvedValueOnce(jsonResponse(200, okMessage));
    await ask(p);
    expect(callsOf().map(keyOf)).toEqual(['sk_a', 'sk_b']);

    // The probe: GET /v1/models with the failed key answers 200.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    vi.advanceTimersByTime(1001);
    const pool = (p as unknown as { keyPool: { recheck(): Promise<void>; snapshot(): Array<Record<string, unknown>> } }).keyPool;
    await pool.recheck();
    const probe = callsOf()[2];
    expect(probe.url).toContain('/v1/models');
    expect(probe.init.method).toBe('GET');
    expect(keyOf(probe)).toBe('sk_a');
    expect(pool.snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, okMessage));
    await ask(p);
    expect(keyOf(callsOf()[3])).toBe('sk_a');
  });

  it('serves the first request after the recheck comes due from the key its probe brings back, instead of failing it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const p = await provider('sk_a,sk_b', { keyPool: { strategy: 'ordered', recheckMs: 60_000 } });
    fetchMock.mockResolvedValueOnce(jsonResponse(401, authError)).mockResolvedValueOnce(jsonResponse(401, authError));
    await expect(ask(p)).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED', httpStatus: 401 });
    // The keys work again; the clock reaches their recheck before the pool's timer has run, so the request itself
    // finds both keys due: it starts their probes, waits for them, and goes out with the first key they bring back.
    vi.setSystemTime(new Date(Date.now() + 60_000));
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      .mockResolvedValueOnce(jsonResponse(200, okMessage));
    const answer = await ask(p);
    expect(answer.choices[0]?.message?.content).toBe('hello');
    const after = callsOf().slice(2);
    expect(after.map((call) => (call.url.includes('/v1/models') ? 'probe' : 'request'))).toEqual(['probe', 'probe', 'request']);
    expect(after.map(keyOf)).toEqual(['sk_a', 'sk_b', 'sk_a']);
  });

  it('probes a billing failure with a one-token request, never a models list', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const p = await provider('sk_a,sk_b', { keyPool: { strategy: 'ordered', recheckMs: 1000 } });
    fetchMock.mockResolvedValueOnce(jsonResponse(400, creditGone)).mockResolvedValueOnce(jsonResponse(200, okMessage));
    await ask(p);
    fetchMock.mockResolvedValueOnce(jsonResponse(400, creditGone));
    vi.advanceTimersByTime(1001);
    const pool = (p as unknown as { keyPool: { recheck(): Promise<void>; snapshot(): Array<Record<string, unknown>> } }).keyPool;
    await pool.recheck();
    const probe = callsOf()[2];
    expect(probe.url).toContain('/v1/messages');
    expect(probe.init.method).toBe('POST');
    // The model the probe sends is one the catalog knows (the health check's), never a guessed id.
    expect(JSON.parse(String(probe.init.body))).toMatchObject({ model: 'claude-haiku-4-5-20251001', max_tokens: 1 });
    expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing', failures: 2 });
  });

  it('hops keys on the streaming transport too, before any event has reached the caller', async () => {
    const p = await provider('sk_a,sk_b', { streamCompletions: true });
    fetchMock.mockResolvedValueOnce(sseResponse(401, undefined, authError)).mockResolvedValueOnce(sseResponse(200, streamEvents));
    const answer = await ask(p);
    expect(answer.choices[0]?.message?.content).toBe('hello');
    expect(callsOf().map(keyOf)).toEqual(['sk_a', 'sk_b']);
    const pool = (p as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'auth' });
    expect(pool.snapshot()[1]).toMatchObject({ status: 'ok' });

    const chunks: unknown[] = [];
    fetchMock.mockResolvedValueOnce(sseResponse(200, streamEvents));
    for await (const chunk of p.generateCompletionStream('claude-opus-5-5', [{ role: 'user', content: 'hi' }], {})) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
    expect(keyOf(callsOf()[2])).toBe('sk_b');
  });

  it('keeps the first version\'s behaviour for a single key: a 401 throws at once as a client error', async () => {
    const p = await provider('sk_only');
    fetchMock.mockResolvedValueOnce(jsonResponse(401, authError));
    await expect(ask(p)).rejects.toMatchObject({ code: 'API_CLIENT_ERROR', httpStatus: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads the strategy from the environment when the config names none', async () => {
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY', 'ordered');
    const p = new AnthropicProvider();
    await p.initialize({ apiKey: 'sk_a,sk_b', streamCompletions: false });
    fetchMock.mockResolvedValue(jsonResponse(200, okMessage));
    await ask(p);
    await ask(p);
    await ask(p);
    expect(callsOf().map(keyOf)).toEqual(['sk_a', 'sk_a', 'sk_a']);
  });
});
