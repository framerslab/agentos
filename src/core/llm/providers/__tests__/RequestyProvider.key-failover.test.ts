/**
 * @file RequestyProvider.key-failover.test.ts
 * Several Requesty keys in one provider (the key pool v2 design). Requesty's
 * request path sends once, so a key the router rejects (its HTTP 403
 * "Invalid authorization token") is marked and the request fails as before;
 * the next request draws the next usable key; every key out throws
 * ALL_KEYS_FAILED before anything is sent. The axios client is mocked;
 * nothing leaves the process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestyProvider } from '../implementations/RequestyProvider.js';
import { RequestyProviderError } from '../errors/RequestyProviderError.js';

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

  it('marks a rejected key and draws the next usable one for the next request', async () => {
    const { provider, client } = await mountProvider('key_alpha_0001,key_beta_0002');
    client.request.mockRejectedValueOnce(axiosError(403, badToken));
    await expect(ask(provider)).rejects.toMatchObject({ code: 'API_REQUEST_FAILED', httpStatus: 403 });

    client.request.mockResolvedValueOnce({ data: okResponse });
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
    await expect(ask(provider)).rejects.toMatchObject({ code: 'API_REQUEST_FAILED', httpStatus: 403 });
    await expect(ask(provider)).rejects.toMatchObject({ code: 'API_REQUEST_FAILED', httpStatus: 402 });
    expect(bearers(client)).toEqual(['Bearer key_alpha_0001', 'Bearer key_beta_0002']);

    const error = await ask(provider).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestyProviderError);
    expect(error).toMatchObject({ code: 'ALL_KEYS_FAILED' });
    expect((error as RequestyProviderError).details).toMatchObject({ kinds: expect.arrayContaining(['auth', 'billing']) });
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("keeps a 400 as the request's fault: no mark", async () => {
    const { provider, client } = await mountProvider('key_alpha_0001,key_beta_0002');
    client.request.mockRejectedValueOnce(axiosError(400, { error: { message: 'temperature must be at most 2' } }));
    await expect(ask(provider)).rejects.toMatchObject({ code: 'API_REQUEST_FAILED', httpStatus: 400 });
    const pool = (provider as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
    expect(pool.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
  });
});
