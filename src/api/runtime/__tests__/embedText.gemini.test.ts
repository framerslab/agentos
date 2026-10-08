/**
 * @fileoverview embedText routes `provider: 'gemini'` through GeminiProvider's
 * native batchEmbedContents call when no base URL is set or the base URL is
 * Google's native endpoint. The OpenAI-compatible branch falls back to
 * api.openai.com without a base URL, so a Gemini key sent there fails; a
 * gateway or Google's OpenAI-compatible base URL stays on that branch, which
 * those endpoints serve.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../model.js', () => ({
  // Without an inline provider the real resolver auto-detects one; 'openai'
  // stands in for that, so a lost provider: 'gemini' fails these tests.
  resolveModelOption: vi.fn((opts: { provider?: string; model?: string }) => ({
    providerId: opts.provider ?? 'openai',
    modelId: opts.model ?? 'unset',
  })),
  resolveProvider: vi.fn(
    (providerId: string, modelId: string, overrides?: { apiKey?: string; baseUrl?: string }) => ({
      providerId,
      modelId,
      apiKey: overrides?.apiKey ?? 'test-gemini-key',
      baseUrl: overrides?.baseUrl,
    }),
  ),
  createProviderManager: vi.fn(),
}));

vi.mock('../usageLedger.js', () => ({
  recordAgentOSUsage: vi.fn(async () => true),
}));

import { resolveModelOption } from '../model.js';
import { recordAgentOSUsage } from '../usageLedger.js';
import { embedText } from '../embedText.js';
import { clearDefaultProvider, setDefaultProvider } from '../global-default.js';

const fetchMock = vi.fn();

/** A batchEmbedContents reply: one vector per request, 3 prompt tokens each. */
async function batchReply(_url: string, init: { body: string }): Promise<Response> {
  const { requests } = JSON.parse(init.body);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    body: null,
    json: async () => ({
      embeddings: requests.map((_: unknown, i: number) => ({ values: [i, i + 0.5] })),
      usageMetadata: { promptTokenCount: 3 * requests.length },
    }),
  } as unknown as Response;
}

describe('embedText with provider gemini', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(resolveModelOption).mockClear();
    vi.mocked(recordAgentOSUsage).mockClear();
    fetchMock.mockReset();
    fetchMock.mockImplementation(batchReply);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDefaultProvider();
  });

  it('calls Gemini batchEmbedContents with the API key and returns vectors in input order', async () => {
    const result = await embedText({ provider: 'gemini', input: ['first', 'second'] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/models/gemini-embedding-2:batchEmbedContents');
    expect(String(url)).not.toContain('key=');
    expect((init as { headers: Record<string, string> }).headers['x-goog-api-key']).toBe('test-gemini-key');
    expect(JSON.parse(init.body).requests).toHaveLength(2);
    expect(result.provider).toBe('gemini');
    expect(result.embeddings).toEqual([[0, 0.5], [1, 1.5]]);
    // Usage comes from the response's usageMetadata, priced at $0.20 per 1M.
    expect(result.usage).toMatchObject({ promptTokens: 6, totalTokens: 6 });
    expect(result.usage.costUSD).toBeCloseTo((6 / 1_000_000) * 0.2, 12);
  });

  it('passes the embedding cost to the usage ledger', async () => {
    await embedText({ provider: 'gemini', input: ['first', 'second'] });
    const [record] = vi.mocked(recordAgentOSUsage).mock.calls[0];
    expect(record.usage).toMatchObject({ promptTokens: 6, completionTokens: 0, totalTokens: 6 });
    expect(record.usage?.costUSD).toBeCloseTo((6 / 1_000_000) * 0.2, 12);
  });

  it('records the spend of earlier batches when a later batch fails', async () => {
    fetchMock
      .mockImplementationOnce(batchReply)
      .mockImplementationOnce(async () => ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: new Headers(),
        body: null,
        json: async () => ({ error: { code: 400, message: 'bad batch', status: 'INVALID_ARGUMENT' } }),
      }) as unknown as Response);
    const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);

    await expect(embedText({ provider: 'gemini', input: texts })).rejects.toMatchObject({ httpStatus: 400 });

    // The first call's 100 texts were billed at 3 tokens each.
    const [record] = vi.mocked(recordAgentOSUsage).mock.calls[0];
    expect(record.usage).toMatchObject({ promptTokens: 300, totalTokens: 300 });
    expect(record.usage?.costUSD).toBeCloseTo((300 / 1_000_000) * 0.2, 12);
  });

  it('uses the native protocol for an explicit Google base URL', async () => {
    await embedText({ provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', input: 'hello' });
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents',
    );
  });

  it('keeps a custom gateway base URL on the OpenAI-style /embeddings route', async () => {
    // An OpenAI-compatible gateway serves /embeddings with bearer auth, as
    // it did for provider 'gemini' before the native branch existed.
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [1, 2], index: 0 }], model: 'gemini-embedding-2' }),
    }) as unknown as Response);

    await embedText({ provider: 'gemini', baseUrl: 'https://gateway.example/v1', input: 'hello' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gateway.example/v1/embeddings');
    expect(init.headers.Authorization).toBe('Bearer test-gemini-key');
  });

  it('defaults an explicit gemini provider to gemini-embedding-2', async () => {
    await embedText({ provider: 'gemini', input: 'hello' });
    expect(resolveModelOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'gemini', model: 'gemini-embedding-2' }),
      'embedding',
    );
  });

  it('defaults a globally configured gemini provider to gemini-embedding-2', async () => {
    setDefaultProvider({ provider: 'gemini', apiKey: 'global-key' });
    await embedText({ input: 'hello' });
    expect(resolveModelOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'gemini', model: 'gemini-embedding-2' }),
      'embedding',
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain('/models/gemini-embedding-2:batchEmbedContents');
  });

  it('embeds with gemini-embedding-2 when the global default names a chat model', async () => {
    // The global model is the one generateText uses; batchEmbedContents
    // rejects a chat model.
    setDefaultProvider({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'global-key' });
    await embedText({ input: 'hello' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/models/gemini-embedding-2:batchEmbedContents');
  });

  it('keeps an embedding model named by the global default', async () => {
    setDefaultProvider({ provider: 'gemini', model: 'gemini-embedding-001', apiKey: 'global-key' });
    await embedText({ input: 'hello' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/models/gemini-embedding-001:batchEmbedContents');
  });

  it('keeps an explicitly chosen Gemini embedding model', async () => {
    await embedText({ provider: 'gemini', model: 'gemini-embedding-001', input: 'hello' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/models/gemini-embedding-001:batchEmbedContents');
  });

  it("keeps Google's OpenAI-compatible base URL on the /embeddings route", async () => {
    // That surface serves OpenAI's /embeddings with bearer auth and has no
    // batchEmbedContents route.
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ embedding: [0.25, 0.5], index: 0 }],
        model: 'gemini-embedding-001',
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }),
    }) as unknown as Response);

    const result = await embedText({
      provider: 'gemini',
      model: 'gemini-embedding-001',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      input: 'hello',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/openai/embeddings');
    expect(init.headers.Authorization).toBe('Bearer test-gemini-key');
    expect(result.embeddings).toEqual([[0.25, 0.5]]);
    expect(result.usage).toEqual({ promptTokens: 2, totalTokens: 2 });
  });

  it('counts zero usage when an OpenAI-compatible response omits it', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.25, 0.5], index: 0 }], model: 'gemini-embedding-001' }),
    }) as unknown as Response);

    const result = await embedText({
      provider: 'gemini',
      model: 'gemini-embedding-001',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      input: 'hello',
    });

    expect(result.embeddings).toEqual([[0.25, 0.5]]);
    expect(result.usage).toEqual({ promptTokens: 0, totalTokens: 0 });
  });

  it('sends dimensions as outputDimensionality', async () => {
    await embedText({ provider: 'gemini', input: 'hello', dimensions: 768 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.requests[0].outputDimensionality).toBe(768);
  });
});
