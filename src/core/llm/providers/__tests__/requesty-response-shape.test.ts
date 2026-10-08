/**
 * @fileoverview Tests for RequestyProvider tolerance of loosely shaped
 * upstream responses.
 *
 * Requesty routes to many upstream vendors, so three shapes need to be
 * handled without throwing raw TypeErrors:
 *   1. `/models` entries without prices.
 *   2. SSE streams that reach [DONE] without ever sending finish_reason.
 *   3. `/embeddings` responses missing `data` or `usage`.
 *
 * It also covers the `/models` mapping over Requesty's documented response:
 * prices per token, the context window, the output limit and the capability
 * flags (https://docs.requesty.ai/api-reference/endpoint/models-list).
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
  description: 'mock model',
  context_window: 128000,
  input_price: 1.5e-7,
  output_price: 6e-7,
};

const EMBEDDING_MODEL = {
  id: 'openai/text-embedding-3-small',
  description: 'mock embedding model',
  context_window: 8191,
  input_price: 2e-8,
  output_price: 0,
};

describe('RequestyProvider response shape tolerance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes when a /models entry has no prices', async () => {
    const { provider } = await mountProvider([
      { id: 'vendor/no-pricing', description: 'mock', context_window: 4096 },
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

// ---------------------------------------------------------------------------
// GET /v1/models, as Requesty documents and returns it. Prices are USD per token.
// https://docs.requesty.ai/api-reference/endpoint/models-list
// https://docs.requesty.ai/api-reference/endpoint/models-chat-list (the schema)
// ---------------------------------------------------------------------------

/** An entry as the endpoint returns it: prices at the top level and as bands. */
const LISTED_GPT_4O_MINI = {
  api: 'chat',
  id: 'openai/gpt-4o-mini',
  object: 'model',
  created: 1721264400,
  updated: 1787843415,
  owned_by: 'system',
  input_price: 1.5e-7,
  output_price: 6e-7,
  cached_price: 7.5e-8,
  pricing: [{ prompt_tokens_threshold: 0, input_price: 1.5e-7, cached_price: 7.5e-8, output_price: 6e-7 }],
  context_window: 128000,
  max_output_tokens: 16384,
  supports_caching: true,
  supports_vision: true,
  supports_tool_calling: true,
  supports_output_json_object: true,
  supports_output_json_schema: true,
  description: 'Small multimodal model.',
  model_lab: 'openai',
  model_canonical_name: 'gpt-4o-mini',
};

/** The example entry on the documentation page: its prices sit only in the bands. */
const DOCUMENTED_CLAUDE_SONNET = {
  api: 'chat',
  id: 'vertex/claude-sonnet-4-5',
  object: 'model',
  created: 1747933971,
  updated: 1747933971,
  owned_by: 'system',
  pricing: [
    {
      prompt_tokens_threshold: 0,
      input_price: 3e-6,
      caching_price: 3.75e-6,
      caching_5m_price: 3.75e-6,
      caching_1h_price: 6e-6,
      cached_price: 3e-7,
      output_price: 1.5e-5,
    },
    {
      prompt_tokens_threshold: 200000,
      input_price: 6e-6,
      caching_price: 7.5e-6,
      caching_5m_price: 7.5e-6,
      caching_1h_price: 1.2e-5,
      cached_price: 6e-7,
      output_price: 2.25e-5,
    },
  ],
  max_output_tokens: 64000,
  context_window: 200000,
  supports_caching: true,
  supports_vision: true,
  supports_computer_use: true,
  supports_reasoning: true,
  supports_image_generation: false,
  supports_tool_calling: true,
  supports_role_developer: false,
  supports_web_search: true,
  supports_output_json_object: true,
  supports_output_json_schema: true,
  description: 'Hybrid reasoning model with toggleable extended thinking.',
  model_lab: 'vertex',
  model_canonical_name: 'claude-sonnet-4-5',
};

/** Tool calling without an id the provider's old name patterns recognised. */
const LISTED_GROK_4 = {
  api: 'chat',
  id: 'xai/grok-4',
  object: 'model',
  owned_by: 'system',
  input_price: 3e-6,
  output_price: 1.5e-5,
  context_window: 256000,
  max_output_tokens: 0,
  supports_vision: true,
  supports_tool_calling: true,
  supports_output_json_object: true,
  description: 'Flagship model.',
};

/** A Llama id, which the old name patterns took for tool calling; the flag says no. */
const LISTED_LLAMA_405B = {
  api: 'chat',
  id: 'deepinfra/meta-llama/Meta-Llama-3.1-405B-Instruct',
  object: 'model',
  owned_by: 'system',
  input_price: 8e-7,
  output_price: 8e-7,
  context_window: 130815,
  max_output_tokens: 0,
  supports_vision: false,
  supports_tool_calling: false,
  supports_output_json_object: true,
  description: 'Large instruct model.',
};

describe('RequestyProvider model list', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps prices per million tokens, the context window and the output limit', async () => {
    const { provider } = await mountProvider([LISTED_GPT_4O_MINI]);

    expect(await provider.getModelInfo('openai/gpt-4o-mini')).toMatchObject({
      modelId: 'openai/gpt-4o-mini',
      providerId: 'requesty',
      description: 'Small multimodal model.',
      contextWindowSize: 128000,
      outputTokenLimit: 16384,
      pricePer1MTokensInput: 0.15,
      pricePer1MTokensOutput: 0.6,
    });
  });

  it('reads the base band when an entry lists its prices only under pricing', async () => {
    const { provider } = await mountProvider([DOCUMENTED_CLAUDE_SONNET]);

    expect(await provider.getModelInfo('vertex/claude-sonnet-4-5')).toMatchObject({
      contextWindowSize: 200000,
      outputTokenLimit: 64000,
      pricePer1MTokensInput: 3,
      pricePer1MTokensOutput: 15,
    });
  });

  it('takes vision, tool and JSON support from the flags, not from the model id', async () => {
    const { provider } = await mountProvider([LISTED_GROK_4, LISTED_LLAMA_405B]);

    const grok = await provider.getModelInfo('xai/grok-4');
    expect(grok!.capabilities).toEqual(
      expect.arrayContaining(['chat', 'vision_input', 'tool_use', 'json_mode']),
    );
    // max_output_tokens: 0 means the limit is not listed.
    expect(grok!.outputTokenLimit).toBeUndefined();

    const llama = await provider.getModelInfo('deepinfra/meta-llama/Meta-Llama-3.1-405B-Instruct');
    expect(llama!.capabilities).toContain('json_mode');
    expect(llama!.capabilities).not.toContain('tool_use');
    expect(llama!.capabilities).not.toContain('vision_input');

    expect(await provider.listAvailableModels({ capability: 'tool_use' })).toHaveLength(1);
  });
});
