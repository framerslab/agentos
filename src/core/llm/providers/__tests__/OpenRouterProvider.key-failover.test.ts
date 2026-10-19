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
import { ApiKeyPool } from '../../../providers/ApiKeyPool';
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

  it("keeps the first version's behaviour for a single key: a 401 fails the request at once", async () => {
    const request = vi.fn().mockRejectedValueOnce(axiosError(401, noAuth));
    const { provider } = makeProvider(request, 'key_only_0001');
    await expect(provider.generateCompletion(MODEL, messages, {})).rejects.toMatchObject({ code: 'API_REQUEST_FAILED', httpStatus: 401 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
