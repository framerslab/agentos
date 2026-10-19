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

async function mountProvider(apiKey: string): Promise<{ provider: RequestyProvider; client: MockClient }> {
  const client: MockClient = { request: vi.fn(), get: vi.fn().mockResolvedValue({ data: { data: [] } }) };
  const axios = (await import('axios')).default;
  vi.spyOn(axios, 'create').mockReturnValue(client as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  client.request.mockResolvedValueOnce({ data: { data: [CHAT_MODEL] } });
  const provider = new RequestyProvider();
  await provider.initialize({ apiKey, keyPool: { strategy: 'ordered' } });
  client.request.mockClear();
  return { provider, client };
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

  it("keeps a 400 as the request's fault: no mark", async () => {
    const { provider, client } = await mountProvider('key_alpha_0001,key_beta_0002');
    client.request.mockRejectedValueOnce(axiosError(400, { error: { message: 'temperature must be at most 2' } }));
    await expect(ask(provider)).rejects.toMatchObject({ code: 'API_REQUEST_FAILED', httpStatus: 400 });
    const pool = (provider as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(pool.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
  });
});
