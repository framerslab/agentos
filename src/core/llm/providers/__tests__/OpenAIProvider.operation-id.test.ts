/**
 * @file OpenAIProvider.operation-id.test.ts
 * The operation id OpenAIProvider sends in the header the host names (the
 * `operationIdHeader` option, else `AGENTOS_OPERATION_ID_HEADER`): one value on
 * every attempt of a call, a new value on the next call and on the request
 * generateObject sends again with a raised token budget, and no header when
 * neither names one. The real provider and fetch, against a local server that
 * answers as OpenAI's API does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { generateObject } from '../../../../api/generateObject';
import { probeProviderKey } from '../../../../api/probeProviderKey';
import { globalLLMProviderHealth } from '../../../safety/LLMProviderHealthRegistry';
import type { ChatMessage } from '../IProvider';
import { OpenAIProvider, type OpenAIProviderConfig } from '../implementations/OpenAIProvider';
import { startProviderStub, type ProviderStub, type StubAnswer } from './helpers/providerStub';

const HEADER = 'x-operation-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API_KEY = 'sk-test-operation-id';
const CHAT = 'POST /v1/chat/completions';
const EMBEDDINGS = 'POST /v1/embeddings';
const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const MODELS = {
  object: 'list',
  data: [
    { id: 'gpt-4o', object: 'model', created: 1, owned_by: 'openai' },
    { id: 'text-embedding-3-small', object: 'model', created: 1, owned_by: 'openai' },
  ],
};

const UNAVAILABLE: StubAnswer = { status: 503, json: { error: { message: 'Service Unavailable', type: 'server_error' } } };

/** A Chat Completions reply carrying `content`, stopped for `finishReason`. */
function chatCompletion(content: string, finishReason = 'stop'): StubAnswer {
  return {
    json: {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    },
  };
}

/** A streamed Chat Completions reply: `content`, the stop, the usage chunk and `[DONE]`. */
function chatStream(content: string): StubAnswer {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-4o',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  return {
    sse: [
      chunk({ role: 'assistant', content }, null),
      chunk({}, 'stop'),
      { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o', choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
      '[DONE]',
    ],
  };
}

const EMBEDDING: StubAnswer = {
  json: {
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 2, total_tokens: 2 },
  },
};

let stub: ProviderStub;

beforeAll(async () => {
  stub = await startProviderStub({ 'GET /v1/models': { json: MODELS } });
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

/** An OpenAIProvider initialized against the stub, with `config` over the key and base URL. */
async function provider(config: Partial<OpenAIProviderConfig> = {}): Promise<OpenAIProvider> {
  const created = new OpenAIProvider();
  await created.initialize({ apiKey: API_KEY, baseURL: `${stub.origin}/v1`, ...config });
  return created;
}

/** The value of `header` on each request sent to `key`, in order. */
function ids(key: string, header = HEADER): Array<string | undefined> {
  return stub.sent(key).map((request) => request.headers[header] as string | undefined);
}

/** Reads a stream to its end and returns its chunks. */
async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('OpenAIProvider operation id', () => {
  it('sends one operation id on both attempts of a call that a 503 retried', async () => {
    stub.queue(CHAT, UNAVAILABLE, chatCompletion('hi'));
    const openai = await provider({ operationIdHeader: HEADER });

    const response = await openai.generateCompletion('gpt-4o', messages, {});

    expect(response.choices[0]?.message.content).toBe('hi');
    const sent = ids(CHAT);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(UUID);
    expect(sent[1]).toBe(sent[0]);
  });

  it('sends a new operation id on the next call', async () => {
    stub.queue(CHAT, chatCompletion('one'), chatCompletion('two'));
    const openai = await provider({ operationIdHeader: HEADER });

    await openai.generateCompletion('gpt-4o', messages, {});
    await openai.generateCompletion('gpt-4o', messages, {});

    const [first, second] = ids(CHAT);
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
  });

  it('sends one operation id on both attempts of a streamed call that a 503 retried', async () => {
    stub.queue(CHAT, UNAVAILABLE, chatStream('hello'));
    const openai = await provider({ operationIdHeader: HEADER });

    const chunks = await drain(openai.generateCompletionStream('gpt-4o', messages, {}));

    expect(chunks.length).toBeGreaterThan(0);
    const sent = ids(CHAT);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(UUID);
    expect(sent[1]).toBe(sent[0]);
  });

  it('sends the operation id the call names on every attempt, in place of one of its own, streamed or not', async () => {
    stub.queue(CHAT, UNAVAILABLE, chatCompletion('hi'), UNAVAILABLE, chatStream('hello'));
    const openai = await provider({ operationIdHeader: HEADER });

    await openai.generateCompletion('gpt-4o', messages, { operationId: 'op-whole' });
    await drain(openai.generateCompletionStream('gpt-4o', messages, { operationId: 'op-stream' }));

    expect(ids(CHAT)).toEqual(['op-whole', 'op-whole', 'op-stream', 'op-stream']);
  });

  it('replaces a customHeaders entry of the same name with the operation id the call names', async () => {
    stub.queue(CHAT, chatCompletion('hi'));
    const openai = await provider({ operationIdHeader: HEADER, customHeaders: { 'X-Operation-Id': 'from-the-host' } });

    await openai.generateCompletion('gpt-4o', messages, { operationId: 'op-named' });

    expect(ids(CHAT)).toEqual(['op-named']);
  });

  it('sends nothing for the operation id a call names when neither the config nor the environment names a header', async () => {
    stub.queue(CHAT, chatCompletion('hi'));

    await (await provider()).generateCompletion('gpt-4o', messages, { operationId: 'op-unsent' });

    const [request] = stub.sent(CHAT);
    expect(Object.values(request?.headers ?? {})).not.toContain('op-unsent');
  });

  it('sends one operation id on both attempts of an embeddings call that a 503 retried', async () => {
    stub.queue(EMBEDDINGS, UNAVAILABLE, EMBEDDING);
    const openai = await provider({ operationIdHeader: HEADER });

    const response = await openai.generateEmbeddings('text-embedding-3-small', ['hi']);

    expect(response.data[0]?.embedding).toEqual([0.1, 0.2]);
    const sent = ids(EMBEDDINGS);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(UUID);
    expect(sent[1]).toBe(sent[0]);
  });

  it('sends the operation id an embeddings call names on both attempts of a call that a 503 retried', async () => {
    stub.queue(EMBEDDINGS, UNAVAILABLE, EMBEDDING);
    const openai = await provider({ operationIdHeader: HEADER });

    await openai.generateEmbeddings('text-embedding-3-small', ['hi'], { operationId: 'op-embed' });

    expect(ids(EMBEDDINGS)).toEqual(['op-embed', 'op-embed']);
  });

  it('takes the header name from AGENTOS_OPERATION_ID_HEADER when the config names none, and the config name over it', async () => {
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', HEADER);
    stub.queue(CHAT, chatCompletion('from the variable'), chatCompletion('from the option'));

    await (await provider()).generateCompletion('gpt-4o', messages, {});
    await (await provider({ operationIdHeader: 'x-call-id' })).generateCompletion('gpt-4o', messages, {});

    const [fromVariable, fromOption] = stub.sent(CHAT);
    expect(fromVariable?.headers[HEADER]).toMatch(UUID);
    expect(fromOption?.headers['x-call-id']).toMatch(UUID);
    expect(fromOption?.headers[HEADER]).toBeUndefined();
  });

  it('sends no operation id when neither the config nor the environment names a header', async () => {
    stub.queue(CHAT, chatCompletion('hi'));

    await (await provider()).generateCompletion('gpt-4o', messages, {});

    const [request] = stub.sent(CHAT);
    expect(request?.headers[HEADER]).toBeUndefined();
    expect(Object.values(request?.headers ?? {}).filter((value) => typeof value === 'string' && UUID.test(value))).toEqual([]);
  });

  it('sends a new operation id when generateObject sends the request again with a raised token budget', async () => {
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', HEADER);
    stub.queue(CHAT, chatCompletion('{"name":"Ada","ta', 'length'), chatCompletion('{"name":"Ada","tags":["a"]}'));

    const result = await generateObject({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: API_KEY,
      baseUrl: `${stub.origin}/v1`,
      schema: z.object({ name: z.string(), tags: z.array(z.string()) }),
      prompt: 'Describe Ada.',
      fallbackProviders: [],
    });

    expect(result.object).toEqual({ name: 'Ada', tags: ['a'] });
    const requests = stub.sent(CHAT);
    expect(requests).toHaveLength(2);
    const budget = (body: Record<string, unknown>) => Number(body.max_tokens ?? body.max_completion_tokens);
    expect(budget(requests[1]!.json)).toBeGreaterThan(budget(requests[0]!.json));
    const [first, second] = ids(CHAT);
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
  });

  it('refuses a header name that is not an HTTP field name, or one the provider sends itself, before anything is sent', async () => {
    await expect(provider({ operationIdHeader: 'x operation id' })).rejects.toBeInstanceOf(RangeError);
    await expect(provider({ operationIdHeader: 'Authorization' })).rejects.toBeInstanceOf(RangeError);
    // Neither refused initialize listed the models: the one listing is the next provider's.
    expect(stub.requests).toEqual([]);
    const openai = await provider();
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', 'x operation id');

    await expect(openai.generateCompletion('gpt-4o', messages, {})).rejects.toBeInstanceOf(RangeError);

    expect(stub.sent(CHAT)).toEqual([]);
    expect(stub.sent('GET /v1/models')).toHaveLength(1);
  });

  it("gives a key probe's completion an operation id of its own", async () => {
    stub.queue(CHAT, chatCompletion('pong'));
    const openai = await provider({ operationIdHeader: HEADER });

    const answer = await openai.probeApiKey('sk-probed-key', { kind: 'billing', model: 'gpt-4o' });

    expect(answer.verdict).toBe('ok');
    expect(ids(CHAT)[0]).toMatch(UUID);
  });

  it('refuses a bad header name in a key probe with a RangeError, before anything is sent', async () => {
    const openai = await provider();
    stub.reset();
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', 'x operation id');

    await expect(openai.probeApiKey('sk-probed-key')).rejects.toBeInstanceOf(RangeError);
    await expect(openai.probeApiKey('sk-probed-key', { kind: 'billing', model: 'gpt-4o' })).rejects.toBeInstanceOf(RangeError);
    await expect(
      probeProviderKey({ provider: 'openai', apiKey: 'sk-probed-key', baseUrl: `${stub.origin}/v1`, model: 'gpt-4o' }),
    ).rejects.toBeInstanceOf(RangeError);

    expect(stub.requests).toEqual([]);
  });

  it('replaces a customHeaders entry of the same name in another case, so each attempt carries the operation id alone', async () => {
    stub.queue(CHAT, UNAVAILABLE, chatCompletion('hi'));
    const openai = await provider({
      operationIdHeader: HEADER,
      customHeaders: { 'X-Operation-Id': 'host-value', 'x-trace-id': 'kept' },
    });

    await openai.generateCompletion('gpt-4o', messages, {});

    const sent = stub.sent(CHAT);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.headers[HEADER]).toMatch(UUID);
    expect(sent[1]?.headers[HEADER]).toBe(sent[0]?.headers[HEADER]);
    // The host's other headers still go out.
    expect(sent.map((request) => request.headers['x-trace-id'])).toEqual(['kept', 'kept']);
  });
});
