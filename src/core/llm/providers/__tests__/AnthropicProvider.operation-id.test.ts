/**
 * @file AnthropicProvider.operation-id.test.ts
 * The operation id AnthropicProvider sends in the header the host names (the
 * `operationIdHeader` option, else `AGENTOS_OPERATION_ID_HEADER`): one value on
 * every attempt of a call, on the SSE transport and the JSON one, after a 503
 * and after a stream that ended before its last event; a new value on the next
 * call and on the request generateObject sends again with a raised
 * `max_tokens`; no header when neither names one. The real provider and fetch,
 * against a local server that answers as Anthropic's Messages API does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { generateObject } from '../../../../api/generateObject';
import { probeProviderKey } from '../../../../api/probeProviderKey';
import { globalLLMProviderHealth } from '../../../safety/LLMProviderHealthRegistry';
import type { ChatMessage } from '../IProvider';
import { AnthropicProvider, type AnthropicProviderConfig } from '../implementations/AnthropicProvider';
import { startProviderStub, type ProviderStub, type StubAnswer } from './helpers/providerStub';

const HEADER = 'x-operation-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API_KEY = 'sk-ant-test-operation-id';
const MESSAGES = 'POST /v1/messages';
const MODEL = 'claude-opus-5-5';
const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const UNAVAILABLE: StubAnswer = { status: 503, json: { type: 'error', error: { type: 'api_error', message: 'Service Unavailable' } } };

/** The `message_start` event of a streamed reply. */
function messageStart(): Record<string, unknown> {
  return {
    type: 'message_start',
    message: {
      id: 'msg_1', type: 'message', role: 'assistant', content: [], model: MODEL,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
    },
  };
}

/** A streamed text reply; `stopReason` `max_tokens` is a reply the output limit cut off. */
function textTurn(text: string, stopReason = 'end_turn'): StubAnswer {
  return {
    sse: [
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ],
  };
}

/** A stream that ends after its first text, before `message_delta`: the connection closed under it. */
const CUT_STREAM: StubAnswer = {
  sse: [
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } },
  ],
};

/** A non-streamed reply, for the JSON transport. */
function messageJson(text: string): StubAnswer {
  return {
    json: {
      id: 'msg_1', type: 'message', role: 'assistant', model: MODEL,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 3 },
    },
  };
}

let stub: ProviderStub;

beforeAll(async () => {
  stub = await startProviderStub();
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

/** An AnthropicProvider initialized against the stub, with `config` over the key and base URL. */
async function provider(config: Partial<AnthropicProviderConfig> = {}): Promise<AnthropicProvider> {
  const created = new AnthropicProvider();
  await created.initialize({ apiKey: API_KEY, baseURL: stub.origin, ...config });
  return created;
}

/** The value of `header` on each request to the Messages API, in order. */
function ids(header = HEADER): Array<string | undefined> {
  return stub.sent(MESSAGES).map((request) => request.headers[header] as string | undefined);
}

/** A message's content as text, for a `toContain` check. */
function textOf(content: ChatMessage['content'] | undefined): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

describe('AnthropicProvider operation id', () => {
  it('sends one operation id on both attempts of a call that a 503 retried', async () => {
    stub.queue(MESSAGES, UNAVAILABLE, textTurn('hi'));
    const anthropic = await provider({ operationIdHeader: HEADER });

    const response = await anthropic.generateCompletion(MODEL, messages, {});

    expect(textOf(response.choices[0]?.message.content)).toContain('hi');
    const sent = ids();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(UUID);
    expect(sent[1]).toBe(sent[0]);
  });

  // The stream path sends its request once (a key hop aside), so only the two other paths retry the 503.
  it('sends the operation id the call names on every attempt, in place of one of its own, on all three paths', async () => {
    stub.queue(MESSAGES, UNAVAILABLE, textTurn('whole'), textTurn('stream'), UNAVAILABLE, messageJson('json'));
    const anthropic = await provider({ operationIdHeader: HEADER });

    await anthropic.generateCompletion(MODEL, messages, { operationId: 'op-whole' });
    for await (const _chunk of anthropic.generateCompletionStream(MODEL, messages, { operationId: 'op-stream' })) {
      // read and dropped
    }
    const overJson = await provider({ operationIdHeader: HEADER, streamCompletions: false });
    await overJson.generateCompletion(MODEL, messages, { operationId: 'op-json' });

    expect(ids()).toEqual(['op-whole', 'op-whole', 'op-stream', 'op-json', 'op-json']);
  });

  it('sends the same operation id again when a stream ended before its last event and the call is retried', async () => {
    stub.queue(MESSAGES, CUT_STREAM, textTurn('hello'));
    const anthropic = await provider({ operationIdHeader: HEADER });

    const response = await anthropic.generateCompletion(MODEL, messages, {});

    expect(textOf(response.choices[0]?.message.content)).toContain('hello');
    const sent = ids();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(UUID);
    expect(sent[1]).toBe(sent[0]);
  });

  it('sends one operation id on both attempts on the JSON transport', async () => {
    stub.queue(MESSAGES, UNAVAILABLE, messageJson('hi'));
    const anthropic = await provider({ operationIdHeader: HEADER, streamCompletions: false });

    const response = await anthropic.generateCompletion(MODEL, messages, {});

    expect(textOf(response.choices[0]?.message.content)).toContain('hi');
    const sent = ids();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(UUID);
    expect(sent[1]).toBe(sent[0]);
  });

  it('sends a new operation id on the next call', async () => {
    stub.queue(MESSAGES, textTurn('one'), textTurn('two'));
    const anthropic = await provider({ operationIdHeader: HEADER });

    await anthropic.generateCompletion(MODEL, messages, {});
    await anthropic.generateCompletion(MODEL, messages, {});

    const [first, second] = ids();
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
  });

  it('sends an operation id on a streamed call', async () => {
    stub.queue(MESSAGES, textTurn('streamed'));
    const anthropic = await provider({ operationIdHeader: HEADER });

    const chunks: unknown[] = [];
    for await (const chunk of anthropic.generateCompletionStream(MODEL, messages, {})) chunks.push(chunk);

    expect(chunks.length).toBeGreaterThan(0);
    expect(ids()).toEqual([expect.stringMatching(UUID)]);
  });

  it('takes the header name from AGENTOS_OPERATION_ID_HEADER when the config names none, and the config name over it', async () => {
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', HEADER);
    stub.queue(MESSAGES, textTurn('from the variable'), textTurn('from the option'));

    await (await provider()).generateCompletion(MODEL, messages, {});
    await (await provider({ operationIdHeader: 'x-call-id' })).generateCompletion(MODEL, messages, {});

    const [fromVariable, fromOption] = stub.sent(MESSAGES);
    expect(fromVariable?.headers[HEADER]).toMatch(UUID);
    expect(fromOption?.headers['x-call-id']).toMatch(UUID);
    expect(fromOption?.headers[HEADER]).toBeUndefined();
  });

  it('sends no operation id when neither the config nor the environment names a header', async () => {
    stub.queue(MESSAGES, textTurn('hi'));

    await (await provider()).generateCompletion(MODEL, messages, {});

    const [request] = stub.sent(MESSAGES);
    expect(request?.headers[HEADER]).toBeUndefined();
    expect(Object.values(request?.headers ?? {}).filter((value) => typeof value === 'string' && UUID.test(value))).toEqual([]);
  });

  it('sends a new operation id when generateObject sends the request again with a raised max_tokens', async () => {
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', HEADER);
    stub.queue(MESSAGES, textTurn('{"name":"Ada","ta', 'max_tokens'), textTurn('{"name":"Ada","tags":["a"]}'));

    const result = await generateObject({
      provider: 'anthropic',
      model: MODEL,
      apiKey: API_KEY,
      baseUrl: stub.origin,
      schema: z.object({ name: z.string(), tags: z.array(z.string()) }),
      prompt: 'Describe Ada.',
      fallbackProviders: [],
    });

    expect(result.object).toEqual({ name: 'Ada', tags: ['a'] });
    const requests = stub.sent(MESSAGES);
    expect(requests).toHaveLength(2);
    expect(Number(requests[1]!.json.max_tokens)).toBeGreaterThan(Number(requests[0]!.json.max_tokens));
    const [first, second] = ids();
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
  });

  it('refuses a header name that is not an HTTP field name, or one the provider sends itself, before anything is sent', async () => {
    await expect(provider({ operationIdHeader: 'x operation id' })).rejects.toBeInstanceOf(RangeError);
    await expect(provider({ operationIdHeader: 'X-Api-Key' })).rejects.toBeInstanceOf(RangeError);
    const anthropic = await provider();
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', 'x operation id');

    await expect(anthropic.generateCompletion(MODEL, messages, {})).rejects.toBeInstanceOf(RangeError);
    const stream = anthropic.generateCompletionStream(MODEL, messages, {});
    await expect(stream.next()).rejects.toBeInstanceOf(RangeError);

    expect(stub.requests).toEqual([]);
  });

  it("gives a key probe's completion an operation id of its own", async () => {
    stub.queue(MESSAGES, messageJson('pong'));
    const anthropic = await provider({ operationIdHeader: HEADER });

    const answer = await anthropic.probeApiKey('sk-ant-probed-key', { kind: 'billing', model: MODEL });

    expect(answer.verdict).toBe('ok');
    expect(ids()[0]).toMatch(UUID);
  });

  it('refuses a bad header name in a key probe with a RangeError, before anything is sent', async () => {
    const anthropic = await provider();
    stub.reset();
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', 'x operation id');

    await expect(anthropic.probeApiKey('sk-ant-probed-key')).rejects.toBeInstanceOf(RangeError);
    await expect(anthropic.probeApiKey('sk-ant-probed-key', { kind: 'billing', model: MODEL })).rejects.toBeInstanceOf(RangeError);
    await expect(
      probeProviderKey({ provider: 'anthropic', apiKey: 'sk-ant-probed-key', baseUrl: stub.origin, model: MODEL }),
    ).rejects.toBeInstanceOf(RangeError);

    expect(stub.requests).toEqual([]);
  });
});
