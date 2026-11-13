/**
 * @file openai-refusal.e2e.test.ts
 * An explicit refusal from OpenAI reaches the caller as a refusal, never as an
 * empty answer: finish reason `refusal` and the model's refusal message in
 * `refusal`, at the provider and through generateText and streamText, on both
 * endpoints. The bodies follow the shapes OpenAI documents:
 *
 * - Chat Completions: `message.refusal` beside `finish_reason: "stop"`, and
 *   `delta.refusal` on stream chunks.
 * - Responses: a message content part `{ type: "refusal", refusal }` in a
 *   `completed` response, and the `response.refusal.delta` /
 *   `response.refusal.done` stream events.
 *
 * Sources: https://developers.openai.com/api/docs/guides/structured-outputs#refusals-with-structured-outputs,
 * https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events,
 * https://developers.openai.com/api/reference/resources/responses/streaming-events
 *
 * Runs the real OpenAIProvider, generateText and streamText; only fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateText } from '../generateText.js';
import { streamText } from '../streamText.js';
import { OpenAIProvider } from '../../core/llm/providers/implementations/OpenAIProvider.js';
import type { ModelCompletionResponse } from '../../core/llm/providers/IProvider.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

const REFUSAL = "I'm sorry, I cannot assist with that request.";
const REFUSAL_PARTS = ["I'm sorry, ", 'I cannot assist with that request.'];

/** A Chat Completions model, and one OpenAI serves only through /v1/responses. */
const CHAT_MODEL = 'gpt-4.1';
const RESPONSES_MODEL = 'gpt-5.5-pro';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function sseResponse(blocks: string[]): Response {
  return new Response(blocks.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const modelList = () =>
  jsonResponse({
    object: 'list',
    data: [CHAT_MODEL, RESPONSES_MODEL].map((id) => ({ id, object: 'model', created: 1, owned_by: 'openai' })),
  });

/** The refused Chat Completions answer the structured-outputs guide shows. */
const chatRefusal = () =>
  jsonResponse({
    id: 'chatcmpl-9nYAG9LPNonX8DAyrkwYfemr3C8HC',
    object: 'chat.completion',
    created: 1721596428,
    model: CHAT_MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', refusal: REFUSAL },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 81, completion_tokens: 11, total_tokens: 92 },
  });

/** A refusal streamed as `delta.refusal` fragments, then the finish chunk and the usage-only chunk. */
const chatRefusalStream = () => {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: 'chatcmpl-refusal', object: 'chat.completion.chunk', created: 1721596428, model: CHAT_MODEL, choices, ...extra })}\n\n`;
  return sseResponse([
    chunk([{ index: 0, delta: { role: 'assistant', content: null, refusal: '' }, finish_reason: null }]),
    ...REFUSAL_PARTS.map((part) => chunk([{ index: 0, delta: { refusal: part }, finish_reason: null }])),
    chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
    chunk([], { usage: { prompt_tokens: 81, completion_tokens: 11, total_tokens: 92 } }),
    'data: [DONE]\n\n',
  ]);
};

/** The refused Responses answer the structured-outputs guide shows. */
const responsesRefusalBody = () => ({
  id: 'resp_1234567890',
  object: 'response',
  created_at: 1721596428,
  status: 'completed',
  completed_at: 1721596429,
  error: null,
  incomplete_details: null,
  model: RESPONSES_MODEL,
  output: [
    {
      id: 'msg_1234567890',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'refusal', refusal: REFUSAL }],
    },
  ],
  usage: { input_tokens: 81, output_tokens: 11, total_tokens: 92, output_tokens_details: { reasoning_tokens: 0 } },
});

const responsesRefusal = () => jsonResponse(responsesRefusalBody());

/** A refusal streamed as `response.refusal.delta` events, closed by `response.refusal.done` and `response.completed`. */
const responsesRefusalStream = () => {
  let sequence = 0;
  const event = (type: string, fields: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`;
  const body = responsesRefusalBody();
  const at = { item_id: 'msg_1234567890', output_index: 0, content_index: 0 };
  return sseResponse([
    event('response.created', { response: { ...body, status: 'in_progress', output: [], usage: null } }),
    event('response.output_item.added', {
      output_index: 0,
      item: { id: 'msg_1234567890', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    }),
    ...REFUSAL_PARTS.map((delta) => event('response.refusal.delta', { ...at, delta })),
    event('response.refusal.done', { ...at, refusal: REFUSAL }),
    event('response.output_item.done', { output_index: 0, item: { ...body.output[0], status: 'completed' } }),
    event('response.completed', { response: body }),
  ]);
};

/** An ordinary answer on Chat Completions, which must come back as it always has. */
const chatAnswer = () =>
  jsonResponse({
    id: 'chatcmpl-answer',
    object: 'chat.completion',
    created: 1721596428,
    model: CHAT_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello.', refusal: null }, logprobs: null, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  });

/** Answers each request with the first handler whose pattern matches its URL. */
function route(handlers: Array<[RegExp, () => Response]>): void {
  fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
    const target = String(url);
    const match = handlers.find(([pattern]) => pattern.test(target));
    if (!match) throw new Error(`unexpected request ${init?.method ?? 'GET'} ${target}`);
    return match[1]();
  });
}

const paths = [
  {
    name: 'Chat Completions',
    model: CHAT_MODEL,
    endpoint: /api\.openai\.com\/v1\/chat\/completions/,
    answer: chatRefusal,
    stream: chatRefusalStream,
  },
  {
    name: 'Responses',
    model: RESPONSES_MODEL,
    endpoint: /api\.openai\.com\/v1\/responses/,
    answer: responsesRefusal,
    stream: responsesRefusalStream,
  },
];

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

afterEach(() => {
  globalLLMProviderHealth.reset();
  vi.unstubAllEnvs();
});

describe.each(paths)('an OpenAI refusal on $name', ({ model, endpoint, answer, stream }) => {
  async function provider(): Promise<OpenAIProvider> {
    const instance = new OpenAIProvider();
    await instance.initialize({ apiKey: 'sk-refusal-e2e', maxRetries: 1 });
    return instance;
  }

  it('reaches the provider result as finish reason refusal with the refusal text', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [endpoint, answer],
    ]);

    const result = await (await provider()).generateCompletion(model, [{ role: 'user', content: 'A request.' }], {});

    expect(result.choices[0]?.finishReason).toBe('refusal');
    expect(result.choices[0]?.refusal).toBe(REFUSAL);
    expect(result.choices[0]?.message.content ?? null).toBeNull();
  });

  it('streams from the provider as refusal deltas and ends on finish reason refusal', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [endpoint, stream],
    ]);

    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of (await provider()).generateCompletionStream(model, [{ role: 'user', content: 'A request.' }], {})) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.refusalDelta ?? '').join('')).toBe(REFUSAL);
    expect(chunks.map((chunk) => chunk.responseTextDelta ?? '').join('')).toBe('');
    const finish = chunks.find((chunk) => chunk.choices[0]?.finishReason != null);
    expect(finish?.choices[0]?.finishReason).toBe('refusal');
    expect(finish?.choices[0]?.refusal).toBe(REFUSAL);
  });

  it('comes back from generateText as finish reason refusal with the refusal text and no text', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [endpoint, answer],
    ]);

    const result = await generateText({
      provider: 'openai',
      model,
      apiKey: 'sk-refusal-e2e',
      prompt: 'A request.',
      fallbackProviders: [],
    });

    expect(result.finishReason).toBe('refusal');
    expect(result.refusal).toBe(REFUSAL);
    expect(result.text).toBe('');
  });

  it('comes back from streamText as finish reason refusal with the refusal text and no text', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [endpoint, stream],
    ]);

    const result = streamText({
      provider: 'openai',
      model,
      apiKey: 'sk-refusal-e2e',
      prompt: 'A request.',
      fallbackProviders: [],
    });

    let streamed = '';
    for await (const delta of result.textStream) streamed += delta;
    expect(streamed).toBe('');
    expect(await result.finishReason).toBe('refusal');
    expect(await result.refusal).toBe(REFUSAL);
    expect(await result.text).toBe('');
  });
});

describe('an ordinary OpenAI answer', () => {
  it('carries no refusal and keeps its finish reason', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, chatAnswer],
    ]);

    const result = await generateText({
      provider: 'openai',
      model: CHAT_MODEL,
      apiKey: 'sk-refusal-e2e',
      prompt: 'Say hello.',
      fallbackProviders: [],
    });

    expect(result.text).toBe('Hello.');
    expect(result.finishReason).toBe('stop');
    expect('refusal' in result).toBe(false);
  });
});

describe('an OpenAI refusal with a fallback provider set', () => {
  it('is returned as the result and is never sent on to the fallback', async () => {
    // A key for the fallback, so a walk would reach it: route() throws on any request outside OpenAI.
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-refusal-e2e');
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, chatRefusal],
    ]);

    const result = await generateText({
      provider: 'openai',
      model: CHAT_MODEL,
      apiKey: 'sk-refusal-e2e',
      prompt: 'A request.',
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
    });

    expect(result.finishReason).toBe('refusal');
    expect(result.refusal).toBe(REFUSAL);
    expect(result.provider).toBe('openai');
    const requested = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requested.filter((url) => !/api\.openai\.com/.test(url))).toEqual([]);
  });
});
