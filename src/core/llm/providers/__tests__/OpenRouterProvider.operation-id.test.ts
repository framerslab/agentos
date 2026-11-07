/**
 * @file OpenRouterProvider.operation-id.test.ts
 * The operation id OpenRouterProvider sends in the header the host names (the
 * `operationIdHeader` option, else `AGENTOS_OPERATION_ID_HEADER`): one value on
 * every attempt of a call, a new value on the next call and on the request
 * generateObject sends again with a raised token budget, and no header when
 * neither names one. The real provider over its own axios client (and fetch
 * for the key probe), against a local server that answers as OpenRouter's API
 * does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { generateObject } from '../../../../api/generateObject';
import { probeProviderKey } from '../../../../api/probeProviderKey';
import { globalLLMProviderHealth } from '../../../safety/LLMProviderHealthRegistry';
import type { ChatMessage } from '../IProvider';
import { OpenRouterProvider, type OpenRouterProviderConfig } from '../implementations/OpenRouterProvider';
import { startProviderStub, type ProviderStub, type StubAnswer } from './helpers/providerStub';

const HEADER = 'x-operation-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API_KEY = 'sk-or-test-operation-id';
const MODEL = 'openai/gpt-4o';
const CHAT = 'POST /api/v1/chat/completions';
const EMBEDDINGS = 'POST /api/v1/embeddings';
const MODELS_LIST = 'GET /api/v1/models';
const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const MODELS = {
  data: [
    { id: MODEL, name: 'GPT-4o', context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' } },
    { id: 'openai/text-embedding-3-small', name: 'Embedding', context_length: 8192, pricing: { prompt: '0.00000002', completion: '0' } },
  ],
};

const UNAVAILABLE: StubAnswer = { status: 503, json: { error: { message: 'Service Unavailable', code: 503 } } };

/** A chat completion reply carrying `content`, stopped for `finishReason`, with OpenRouter's `cost`. */
function chatCompletion(content: string, finishReason = 'stop'): StubAnswer {
  return {
    json: {
      id: 'gen-1',
      object: 'chat.completion',
      created: 1,
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, cost: 0.0001 },
    },
  };
}

/** A streamed reply: `content`, the stop chunk with its usage, and `[DONE]`. */
function chatStream(content: string): StubAnswer {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, unknown>) => ({
    id: 'gen-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  });
  return {
    sse: [
      chunk({ role: 'assistant', content }, null),
      chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, cost: 0.0001 }),
      '[DONE]',
    ],
  };
}

const EMBEDDING: StubAnswer = {
  json: {
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
    model: 'openai/text-embedding-3-small',
    usage: { prompt_tokens: 2, total_tokens: 2 },
  },
};

let stub: ProviderStub;

beforeAll(async () => {
  stub = await startProviderStub({ [MODELS_LIST]: { json: MODELS } });
});

afterAll(async () => {
  await stub.close();
});

beforeEach(() => {
  stub.reset();
  globalLLMProviderHealth.reset();
  // A variable set where the suite runs must not decide the cases that leave it out.
  vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** An OpenRouterProvider initialized against the stub (it lists the models), with `config` over the key and base URL. */
async function provider(config: Partial<OpenRouterProviderConfig> = {}): Promise<OpenRouterProvider> {
  const created = new OpenRouterProvider();
  await created.initialize({ apiKey: API_KEY, baseURL: `${stub.origin}/api/v1`, ...config });
  return created;
}

/** The value of `header` on each request sent to `key`, in order. */
function ids(key: string, header = HEADER): Array<string | undefined> {
  return stub.sent(key).map((request) => request.headers[header] as string | undefined);
}

describe('OpenRouterProvider operation id', () => {
  it('sends one operation id on both attempts of a call that a 503 retried', async () => {
    stub.queue(CHAT, UNAVAILABLE, chatCompletion('hi'));
    const openrouter = await provider({ operationIdHeader: HEADER });

    const response = await openrouter.generateCompletion(MODEL, messages, {});

    expect(response.choices[0]?.message.content).toBe('hi');
    const sent = ids(CHAT);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(UUID);
    expect(sent[1]).toBe(sent[0]);
  });

  it('sends a new operation id on the next call', async () => {
    stub.queue(CHAT, chatCompletion('one'), chatCompletion('two'));
    const openrouter = await provider({ operationIdHeader: HEADER });

    await openrouter.generateCompletion(MODEL, messages, {});
    await openrouter.generateCompletion(MODEL, messages, {});

    const [first, second] = ids(CHAT);
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
  });

  it('sends one operation id on both attempts of a streamed call that a 503 retried', async () => {
    stub.queue(CHAT, UNAVAILABLE, chatStream('hello'));
    const openrouter = await provider({ operationIdHeader: HEADER });

    const chunks: unknown[] = [];
    for await (const chunk of openrouter.generateCompletionStream(MODEL, messages, {})) chunks.push(chunk);

    expect(chunks.length).toBeGreaterThan(0);
    const sent = ids(CHAT);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(UUID);
    expect(sent[1]).toBe(sent[0]);
  });

  it('sends the operation id the call names on every attempt, in place of one of its own, streamed or not', async () => {
    stub.queue(CHAT, UNAVAILABLE, chatCompletion('hi'), UNAVAILABLE, chatStream('hello'));
    const openrouter = await provider({ operationIdHeader: HEADER });

    await openrouter.generateCompletion(MODEL, messages, { operationId: 'op-whole' });
    for await (const _chunk of openrouter.generateCompletionStream(MODEL, messages, { operationId: 'op-stream' })) {
      // read and dropped
    }

    expect(ids(CHAT)).toEqual(['op-whole', 'op-whole', 'op-stream', 'op-stream']);
  });

  it('keeps the operation id the call names on the request sent again without its schema, streamed or not', async () => {
    const noEndpoints: StubAnswer = { status: 404, json: { error: { message: 'No endpoints found that support the requested parameters.', code: 404 } } };
    const responseFormat = { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } };
    stub.queue(CHAT, noEndpoints, chatCompletion('{"ok":true}'), noEndpoints, chatStream('{"ok":true}'));
    const openrouter = await provider({ operationIdHeader: HEADER });

    await openrouter.generateCompletion(MODEL, messages, { operationId: 'op-whole', responseFormat } as never);
    for await (const _chunk of openrouter.generateCompletionStream(MODEL, messages, { operationId: 'op-stream', responseFormat } as never)) {
      // read and dropped
    }

    expect(ids(CHAT)).toEqual(['op-whole', 'op-whole', 'op-stream', 'op-stream']);
  });

  it('sends one operation id on both attempts of an embeddings call that a 503 retried', async () => {
    stub.queue(EMBEDDINGS, UNAVAILABLE, EMBEDDING);
    const openrouter = await provider({ operationIdHeader: HEADER });

    const response = await openrouter.generateEmbeddings('openai/text-embedding-3-small', ['hi']);

    expect(response.data[0]?.embedding).toEqual([0.1, 0.2]);
    const sent = ids(EMBEDDINGS);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(UUID);
    expect(sent[1]).toBe(sent[0]);
  });

  it('sends the operation id an embeddings call names on both attempts of a call that a 503 retried', async () => {
    stub.queue(EMBEDDINGS, UNAVAILABLE, EMBEDDING);
    const openrouter = await provider({ operationIdHeader: HEADER });

    await openrouter.generateEmbeddings('openai/text-embedding-3-small', ['hi'], { operationId: 'op-embed' });

    expect(ids(EMBEDDINGS)).toEqual(['op-embed', 'op-embed']);
  });

  it('takes the header name from AGENTOS_OPERATION_ID_HEADER when the config names none, and the config name over it', async () => {
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', HEADER);
    stub.queue(CHAT, chatCompletion('from the variable'), chatCompletion('from the option'));

    await (await provider()).generateCompletion(MODEL, messages, {});
    await (await provider({ operationIdHeader: 'x-call-id' })).generateCompletion(MODEL, messages, {});

    const [fromVariable, fromOption] = stub.sent(CHAT);
    expect(fromVariable?.headers[HEADER]).toMatch(UUID);
    expect(fromOption?.headers['x-call-id']).toMatch(UUID);
    expect(fromOption?.headers[HEADER]).toBeUndefined();
  });

  it('sends no operation id when neither the config nor the environment names a header', async () => {
    stub.queue(CHAT, chatCompletion('hi'));

    await (await provider()).generateCompletion(MODEL, messages, {});

    const [request] = stub.sent(CHAT);
    expect(request?.headers[HEADER]).toBeUndefined();
    expect(Object.values(request?.headers ?? {}).filter((value) => typeof value === 'string' && UUID.test(value))).toEqual([]);
  });

  it('sends a new operation id when generateObject sends the request again with a raised token budget', async () => {
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', HEADER);
    stub.queue(CHAT, chatCompletion('{"name":"Ada","ta', 'length'), chatCompletion('{"name":"Ada","tags":["a"]}'));

    const result = await generateObject({
      provider: 'openrouter',
      model: MODEL,
      apiKey: API_KEY,
      baseUrl: `${stub.origin}/api/v1`,
      schema: z.object({ name: z.string(), tags: z.array(z.string()) }),
      prompt: 'Describe Ada.',
      fallbackProviders: [],
    });

    expect(result.object).toEqual({ name: 'Ada', tags: ['a'] });
    const requests = stub.sent(CHAT);
    expect(requests).toHaveLength(2);
    expect(Number(requests[1]!.json.max_tokens)).toBeGreaterThan(Number(requests[0]!.json.max_tokens));
    const [first, second] = ids(CHAT);
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
  });

  it('refuses a header name that is not an HTTP field name, or one the provider sends itself, before anything is sent', async () => {
    await expect(provider({ operationIdHeader: 'x operation id' })).rejects.toBeInstanceOf(RangeError);
    await expect(provider({ operationIdHeader: 'HTTP-Referer' })).rejects.toBeInstanceOf(RangeError);
    // Neither refused initialize listed the models: the one listing is the next provider's.
    expect(stub.requests).toEqual([]);
    const openrouter = await provider();
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', 'x operation id');

    await expect(openrouter.generateCompletion(MODEL, messages, {})).rejects.toBeInstanceOf(RangeError);

    expect(stub.sent(CHAT)).toEqual([]);
    expect(stub.sent(MODELS_LIST)).toHaveLength(1);
  });

  it('sends an operation id on the health check', async () => {
    const openrouter = await provider({ operationIdHeader: HEADER });
    stub.reset();

    const health = await openrouter.checkHealth();

    expect(health.isHealthy).toBe(true);
    expect(ids(MODELS_LIST)).toEqual([expect.stringMatching(UUID)]);
  });

  it("gives a key probe's completion an operation id of its own", async () => {
    stub.queue(CHAT, chatCompletion('pong'));
    const openrouter = await provider({ operationIdHeader: HEADER });

    const answer = await openrouter.probeApiKey('sk-or-probed-key', { kind: 'billing', model: MODEL });

    expect(answer.verdict).toBe('ok');
    expect(ids(CHAT)[0]).toMatch(UUID);
  });

  it('refuses a bad header name in a key probe with a RangeError, before anything is sent', async () => {
    const openrouter = await provider();
    stub.reset();
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', 'x operation id');

    await expect(openrouter.probeApiKey('sk-or-probed-key')).rejects.toBeInstanceOf(RangeError);
    await expect(openrouter.probeApiKey('sk-or-probed-key', { kind: 'billing', model: MODEL })).rejects.toBeInstanceOf(RangeError);
    await expect(
      probeProviderKey({ provider: 'openrouter', apiKey: 'sk-or-probed-key', baseUrl: `${stub.origin}/api/v1`, model: MODEL }),
    ).rejects.toBeInstanceOf(RangeError);

    expect(stub.requests).toEqual([]);
  });
});
