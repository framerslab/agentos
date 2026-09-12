/**
 * @fileoverview Tests for RequestyProvider tolerance of loosely shaped
 * upstream responses.
 *
 * Requesty routes to many upstream vendors, so three shapes need to be
 * handled without throwing raw TypeErrors:
 *   1. `/models` entries without a `pricing` object.
 *   2. SSE streams that reach [DONE] without ever sending finish_reason.
 *   3. `/embeddings` responses missing `data` or `usage`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { RequestyProvider } from '../implementations/RequestyProvider.js';

interface MockClient {
  request: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function makeReadableSse(lines: string[]): NodeJS.ReadableStream {
  return Readable.from(lines.map((l) => Buffer.from(l)));
}

async function mountProvider(models: Record<string, unknown>[]): Promise<{ provider: RequestyProvider; client: MockClient }> {
  const client: MockClient = {
    request: vi.fn(),
    get: vi.fn().mockResolvedValue({ data: { data: [] } }),
  };
  const axios = (await import('axios')).default;
  vi.spyOn(axios, 'create').mockReturnValue(client as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  client.request.mockResolvedValueOnce({ data: { data: models } });

  const provider = new RequestyProvider();
  await provider.initialize({ apiKey: 'sk-test' });
  return { provider, client };
}

const CHAT_MODEL = {
  id: 'openai/gpt-4o-mini',
  name: 'GPT-4o mini',
  description: 'mock model',
  context_length: 128000,
  pricing: { prompt: '0.00000015', completion: '0.0000006' },
};

const EMBEDDING_MODEL = {
  id: 'openai/text-embedding-3-small',
  name: 'text-embedding-3-small',
  description: 'mock embedding model',
  context_length: 8191,
  pricing: { prompt: '0.00000002', completion: '0' },
};

describe('RequestyProvider response shape tolerance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes when a /models entry has no pricing object', async () => {
    const { provider } = await mountProvider([
      { id: 'vendor/no-pricing', name: 'No pricing', description: 'mock', context_length: 4096 },
      CHAT_MODEL,
    ]);

    const models = await provider.listAvailableModels();
    const noPricing = models.find((m) => m.modelId === 'vendor/no-pricing');
    expect(noPricing).toBeDefined();
    expect(noPricing!.pricePer1MTokensInput).toBeUndefined();
    expect(noPricing!.pricePer1MTokensOutput).toBeUndefined();
  });

  it('emits exactly one final chunk when the stream ends without finish_reason', async () => {
    const { provider, client } = await mountProvider([CHAT_MODEL]);
    const contentChunk = {
      id: 'gen-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'openai/gpt-4o-mini',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }],
    };
    client.request.mockResolvedValueOnce({
      data: makeReadableSse([`data: ${JSON.stringify(contentChunk)}\n\n`, 'data: [DONE]\n\n']),
    });

    const chunks = [];
    for await (const chunk of provider.generateCompletionStream(
      'openai/gpt-4o-mini',
      [{ role: 'user', content: 'hi' }],
      {},
    )) {
      chunks.push(chunk);
    }

    const finals = chunks.filter((c) => c.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].error).toBeUndefined();
    expect(finals[0].choices[0]?.finishReason).toBe('stop');
    expect(chunks[0].isFinal).toBe(false);
  });

  it('raises API_RESPONSE_MALFORMED when the embeddings response lacks data or usage', async () => {
    const { provider, client } = await mountProvider([EMBEDDING_MODEL]);
    client.request.mockResolvedValueOnce({ data: { object: 'list', model: 'openai/text-embedding-3-small' } });

    await expect(
      provider.generateEmbeddings('openai/text-embedding-3-small', ['hi']),
    ).rejects.toMatchObject({ code: 'API_RESPONSE_MALFORMED' });

    client.request.mockResolvedValueOnce({
      data: { object: 'list', model: 'openai/text-embedding-3-small', data: [{ object: 'embedding', embedding: [0.1], index: 0 }] },
    });
    await expect(
      provider.generateEmbeddings('openai/text-embedding-3-small', ['hi']),
    ).rejects.toMatchObject({ code: 'API_RESPONSE_MALFORMED' });
  });
});
