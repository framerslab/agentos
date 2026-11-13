/**
 * @file openai-refusal.e2e.test.ts
 * An explicit refusal from OpenAI reaches the caller with the model's refusal
 * message in a `refusal` field, at the provider and through generateText and
 * streamText, on both endpoints, so it can be told from an empty answer. The
 * finish reason stays the one the answer always reported (`stop`, or `length`
 * when the output cap cut the message off). The bodies follow the shapes
 * OpenAI documents:
 *
 * - Chat Completions: `message.refusal` beside `finish_reason: "stop"`, and
 *   `delta.refusal` on stream chunks.
 * - Responses: a message content part `{ type: "refusal", refusal }` in a
 *   `completed` response, and the `response.refusal.delta` /
 *   `response.refusal.done` stream events.
 * - A refusal the output cap cut off: `finish_reason: "length"`, and an
 *   `incomplete` response whose reason is `max_output_tokens`. It stays a cut
 *   answer, as the guide's own handling checks for one before a refusal.
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

import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { z } from 'zod';
import { agent } from '../agent.js';
import { GuardrailStopError } from '../errors.js';
import { generateObject, ObjectGenerationError } from '../generateObject.js';
import { generateText, type GenerateTextResult } from '../generateText.js';
import { setGlobalLlmObserver, type LlmUsageEvent } from '../observers.js';
import { streamText, type StreamPart } from '../streamText.js';
import { AgentOSResponseChunkType, type AgentOSFinalResponseChunk } from '../types/AgentOSResponse.js';
import { OpenAIProvider } from '../../core/llm/providers/implementations/OpenAIProvider.js';
import type { ModelCompletionResponse } from '../../core/llm/providers/IProvider.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import { GuardrailAction, type GuardrailContext, type IGuardrailService } from '../../safety/guardrails/IGuardrailService.js';
import { configureAgentOSObservability } from '../../safety/evaluation/observability/otel.js';

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

/** One Chat Completions stream chunk as an SSE block. */
const chatChunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-refusal', object: 'chat.completion.chunk', created: 1721596428, model: CHAT_MODEL, choices, ...extra })}\n\n`;

/** A refusal streamed as `delta.refusal` fragments, then the finish chunk and the usage-only chunk. */
const chatRefusalStream = () =>
  sseResponse([
    chatChunk([{ index: 0, delta: { role: 'assistant', content: null, refusal: '' }, finish_reason: null }]),
    ...REFUSAL_PARTS.map((part) => chatChunk([{ index: 0, delta: { refusal: part }, finish_reason: null }])),
    chatChunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
    chatChunk([], { usage: { prompt_tokens: 81, completion_tokens: 11, total_tokens: 92 } }),
    'data: [DONE]\n\n',
  ]);

/** A streamed step that writes text and then calls the `lookup` tool. */
const chatToolStepStream = () =>
  sseResponse([
    chatChunk([{ index: 0, delta: { role: 'assistant', content: 'Looking it up.' }, finish_reason: null }]),
    chatChunk([{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }, finish_reason: null }]),
    chatChunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
    chatChunk([], { usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 } }),
    'data: [DONE]\n\n',
  ]);

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

/** The piece of the refusal message that came before the output cap cut it off. */
const CUT_REFUSAL = REFUSAL_PARTS[0];

/** A Chat Completions refusal the output cap cut off: the piece that came, beside `finish_reason: "length"`. */
const chatCutRefusal = () =>
  jsonResponse({
    id: 'chatcmpl-cut',
    object: 'chat.completion',
    created: 1721596428,
    model: CHAT_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: CUT_REFUSAL }, logprobs: null, finish_reason: 'length' }],
    usage: { prompt_tokens: 81, completion_tokens: 4, total_tokens: 85 },
  });

/** The same refusal streamed: its piece, then the finish chunk with `length` and the usage-only chunk. */
const chatCutRefusalStream = () =>
  sseResponse([
    chatChunk([{ index: 0, delta: { role: 'assistant', content: null, refusal: '' }, finish_reason: null }]),
    chatChunk([{ index: 0, delta: { refusal: CUT_REFUSAL }, finish_reason: null }]),
    chatChunk([{ index: 0, delta: {}, finish_reason: 'length' }]),
    chatChunk([], { usage: { prompt_tokens: 81, completion_tokens: 4, total_tokens: 85 } }),
    'data: [DONE]\n\n',
  ]);

/** A Responses refusal the output cap cut off: an `incomplete` response, its reason `max_output_tokens`. */
const responsesCutRefusalBody = () => {
  const body = responsesRefusalBody();
  return {
    ...body,
    status: 'incomplete',
    completed_at: null,
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ ...body.output[0], status: 'incomplete', content: [{ type: 'refusal', refusal: CUT_REFUSAL }] }],
    usage: { ...body.usage, output_tokens: 4, total_tokens: 85 },
  };
};

/** The same refusal streamed: its piece as a `response.refusal.delta` event, closed by `response.incomplete`. */
const responsesCutRefusalStream = () => {
  let sequence = 0;
  const event = (type: string, fields: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`;
  const body = responsesCutRefusalBody();
  const at = { item_id: 'msg_1234567890', output_index: 0, content_index: 0 };
  return sseResponse([
    event('response.created', { response: { ...body, status: 'in_progress', incomplete_details: null, output: [], usage: null } }),
    event('response.output_item.added', {
      output_index: 0,
      item: { id: 'msg_1234567890', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    }),
    event('response.refusal.delta', { ...at, delta: CUT_REFUSAL }),
    event('response.incomplete', { response: body }),
  ]);
};

/** Answers each request with the first handler whose pattern matches its URL. */
function route(handlers: Array<[RegExp, () => Response]>): void {
  fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
    const target = String(url);
    const match = handlers.find(([pattern]) => pattern.test(target));
    if (!match) throw new Error(`unexpected request ${init?.method ?? 'GET'} ${target}`);
    return match[1]();
  });
}

/** Answers the requests one endpoint gets with the given answers, in order. */
function inOrder(...answers: Array<() => Response>): () => Response {
  const queue = [...answers];
  return () => {
    const next = queue.shift();
    if (!next) throw new Error('more requests than answers');
    return next();
  };
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

  it('reaches the provider result with the refusal text, beside the finish reason OpenAI gave', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [endpoint, answer],
    ]);

    const result = await (await provider()).generateCompletion(model, [{ role: 'user', content: 'A request.' }], {});

    expect(result.choices[0]?.finishReason).toBe('stop');
    expect(result.choices[0]?.refusal).toBe(REFUSAL);
    expect(result.choices[0]?.message.content ?? null).toBeNull();
  });

  it('streams from the provider as refusal deltas and ends on a stop that holds the whole message', async () => {
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
    expect(finish?.choices[0]?.finishReason).toBe('stop');
    expect(finish?.choices[0]?.refusal).toBe(REFUSAL);
    // Only the chunk that ends the answer says it was refused.
    expect(chunks.filter((chunk) => typeof chunk.choices[0]?.refusal === 'string')).toEqual([finish]);
  });

  it('comes back from generateText as a stop with the refusal text and no text', async () => {
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

    expect(result.finishReason).toBe('stop');
    expect(result.refusal).toBe(REFUSAL);
    expect(result.text).toBe('');
  });

  it('comes back from streamText as a stop with the refusal text and no text', async () => {
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
    expect(await result.finishReason).toBe('stop');
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

  /** An ordinary answer streamed on Chat Completions, its first delta naming `refusal: null` as OpenAI sends it. */
  const chatAnswerStream = () =>
    sseResponse([
      chatChunk([{ index: 0, delta: { role: 'assistant', content: '', refusal: null }, finish_reason: null }]),
      chatChunk([{ index: 0, delta: { content: 'Hello.' }, finish_reason: null }]),
      chatChunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
      chatChunk([], { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
      'data: [DONE]\n\n',
    ]);
  /** An ordinary answer streamed on the Responses API. */
  const responsesAnswerStream = () => {
    let sequence = 0;
    const event = (type: string, fields: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`;
    const body = { ...responsesRefusalBody(), output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello.' }] }] };
    return sseResponse([
      event('response.created', { response: { ...body, status: 'in_progress', output: [], usage: null } }),
      event('response.output_item.added', { output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } }),
      event('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hello.' }),
      event('response.completed', { response: body }),
    ]);
  };

  it.each([
    { name: 'Chat Completions', model: CHAT_MODEL, endpoint: /api\.openai\.com\/v1\/chat\/completions/, stream: chatAnswerStream },
    { name: 'Responses', model: RESPONSES_MODEL, endpoint: /api\.openai\.com\/v1\/responses/, stream: responsesAnswerStream },
  ])('streamed on $name, carries no refusal at the provider or from streamText', async ({ model, endpoint, stream }) => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [endpoint, stream],
    ]);
    const provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-refusal-e2e', maxRetries: 1 });
    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of provider.generateCompletionStream(model, [{ role: 'user', content: 'Say hello.' }], {})) chunks.push(chunk);
    expect(chunks.some((chunk) => chunk.refusalDelta !== undefined || (chunk.choices[0] !== undefined && 'refusal' in chunk.choices[0]))).toBe(false);
    expect(chunks.find((chunk) => chunk.choices[0]?.finishReason != null)?.choices[0]?.finishReason).toBe('stop');

    const result = streamText({ provider: 'openai', model, apiKey: 'sk-refusal-e2e', prompt: 'Say hello.', fallbackProviders: [] });
    let streamed = '';
    for await (const delta of result.textStream) streamed += delta;
    expect(streamed).toBe('Hello.');
    expect(await result.finishReason).toBe('stop');
    expect(await result.refusal).toBeUndefined();
    expect(await result.text).toBe('Hello.');
  });
});

// OpenAI's own handling reads an incomplete answer before it looks for a refusal: a message the cap cut off is a cut answer.
const cutPaths = [
  { name: 'Chat Completions', model: CHAT_MODEL, endpoint: /api\.openai\.com\/v1\/chat\/completions/, answer: chatCutRefusal, stream: chatCutRefusalStream },
  { name: 'Responses', model: RESPONSES_MODEL, endpoint: /api\.openai\.com\/v1\/responses/, answer: () => jsonResponse(responsesCutRefusalBody()), stream: responsesCutRefusalStream },
];

describe.each(cutPaths)('an OpenAI refusal the output cap cut off on $name', ({ model, endpoint, answer, stream }) => {
  const call = { provider: 'openai', model, apiKey: 'sk-refusal-e2e', prompt: 'A request.', fallbackProviders: [] };

  it('keeps finish reason length at the provider, with the piece of the message that came', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [endpoint, answer],
    ]);
    const provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-refusal-e2e', maxRetries: 1 });

    const result = await provider.generateCompletion(model, [{ role: 'user', content: 'A request.' }], {});
    expect(result.choices[0]?.finishReason).toBe('length');
    expect(result.choices[0]?.refusal).toBe(CUT_REFUSAL);

    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [endpoint, stream],
    ]);
    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of provider.generateCompletionStream(model, [{ role: 'user', content: 'A request.' }], {})) chunks.push(chunk);
    const finish = chunks.find((chunk) => chunk.choices[0]?.finishReason != null);
    expect(finish?.choices[0]?.finishReason).toBe('length');
    expect(finish?.choices[0]?.refusal).toBe(CUT_REFUSAL);
  });

  it('comes back from generateText and streamText as finish reason length, with the piece of the message and no text', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [endpoint, answer],
    ]);
    const result = await generateText(call);
    expect(result.finishReason).toBe('length');
    expect(result.refusal).toBe(CUT_REFUSAL);
    expect(result.text).toBe('');

    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [endpoint, stream],
    ]);
    const streamed = streamText(call);
    let text = '';
    for await (const delta of streamed.textStream) text += delta;
    expect(text).toBe('');
    expect(await streamed.finishReason).toBe('length');
    expect(await streamed.refusal).toBe(CUT_REFUSAL);
    expect(await streamed.text).toBe('');
  });

  it('comes back the same in prompt tool mode, never as a stop', async () => {
    // The prompt tool loop sends each round as a whole request, so the answer is the whole body.
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [endpoint, answer],
    ]);
    const lookup = { description: 'Look a word up.', parameters: { type: 'object' as const, properties: {} }, execute: vi.fn(async () => ({ hits: 1 })) };
    const withTools = { ...call, tools: { lookup }, toolMode: 'prompt' as const };

    const result = await generateText(withTools);
    expect(result.finishReason).toBe('length');
    expect(result.refusal).toBe(CUT_REFUSAL);
    expect(result.text).toBe('');

    const streamed = streamText(withTools);
    let text = '';
    for await (const delta of streamed.textStream) text += delta;
    expect(text).toBe('');
    expect(await streamed.finishReason).toBe('length');
    expect(await streamed.refusal).toBe(CUT_REFUSAL);
    expect(lookup.execute).not.toHaveBeenCalled();
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

    expect(result.finishReason).toBe('stop');
    expect(result.refusal).toBe(REFUSAL);
    expect(result.provider).toBe('openai');
    const requested = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requested.filter((url) => !/api\.openai\.com/.test(url))).toEqual([]);
  });
});

describe('an OpenAI refusal on a call with guards', () => {
  /** A guard that passes every reply. */
  const passes: IGuardrailService = { id: 'passes', evaluateOutput: async () => null };
  const context: GuardrailContext = { userId: 'user-1', sessionId: 'session-1' };
  const call = {
    provider: 'openai',
    model: CHAT_MODEL,
    apiKey: 'sk-refusal-e2e',
    prompt: 'A request.',
    fallbackProviders: [],
    guards: { services: [passes], context },
  };

  it('comes back from generateText as it does without them', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, chatRefusal],
    ]);

    const result = await generateText(call);

    expect(result.finishReason).toBe('stop');
    expect(result.refusal).toBe(REFUSAL);
    expect(result.text).toBe('');
  });

  it('comes back from streamText as it does without them', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, chatRefusalStream],
    ]);

    const result = streamText(call);

    let streamed = '';
    for await (const delta of result.textStream) streamed += delta;
    expect(streamed).toBe('');
    expect(await result.finishReason).toBe('stop');
    expect(await result.refusal).toBe(REFUSAL);
    expect(await result.text).toBe('');
  });

  const isFinal = (chunk: { type: string }): boolean => chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE;
  /** A guard that blocks every whole reply it is shown, and records its text. */
  function blocks(): IGuardrailService & { seen: Array<string | null> } {
    const seen: Array<string | null> = [];
    return {
      id: 'blocks',
      seen,
      evaluateOutput: async ({ chunk }) => {
        if (!isFinal(chunk)) return null;
        seen.push((chunk as AgentOSFinalResponseChunk).finalResponseText);
        return { action: GuardrailAction.BLOCK, reasonCode: 'RULE_OUT' };
      },
    };
  }
  /** A guard that rewrites every whole reply it is shown. */
  const rewrites: IGuardrailService = {
    id: 'rewrites',
    config: { canSanitize: true },
    evaluateOutput: async ({ chunk }) => (isFinal(chunk) ? { action: GuardrailAction.SANITIZE, modifiedText: 'A rewritten refusal.' } : null),
  };
  /** A guard that removes the whole text of every reply it is shown. */
  const removes: IGuardrailService = {
    id: 'removes',
    config: { canSanitize: true },
    evaluateOutput: async ({ chunk }) => (isFinal(chunk) ? { action: GuardrailAction.SANITIZE, modifiedText: '' } : null),
  };

  it('is judged by the output guards before generateText returns its message', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, chatRefusal],
    ]);

    const guard = blocks();
    const stopped = await generateText({ ...call, guards: { services: [guard], context } }).catch((e) => e);
    expect(stopped).toBeInstanceOf(GuardrailStopError);
    expect(stopped).toMatchObject({ code: 'GUARDRAIL_BLOCKED', stage: 'output' });
    expect(guard.seen).toEqual([REFUSAL]);

    const result = await generateText({ ...call, guards: { services: [rewrites], context } });
    expect(result.finishReason).toBe('stop');
    expect(result.refusal).toBe('A rewritten refusal.');
    expect(result.text).toBe('');
    expect(result.guardReport?.result).toBe('sanitized');

    // A guard that removes the message leaves an empty one: the field still says the model refused.
    const removed = await generateText({ ...call, guards: { services: [removes], context } });
    expect(removed.finishReason).toBe('stop');
    expect(removed.refusal).toBe('');
  });

  it('is judged by the output guards before streamText resolves its message', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, chatRefusalStream],
    ]);

    const guard = blocks();
    const blocked = streamText({ ...call, guards: { services: [guard], context } });
    const parts: StreamPart[] = [];
    for await (const part of blocked.fullStream) parts.push(part);
    expect(parts.map((part) => part.type)).toEqual(['error']);
    expect((parts[0] as { error: unknown }).error).toMatchObject({ name: 'GuardrailStopError', code: 'GUARDRAIL_BLOCKED', stage: 'output' });
    expect(await blocked.finishReason).toBe('error');
    expect(await blocked.refusal).toBeUndefined();
    expect(guard.seen).toEqual([REFUSAL]);

    const rewritten = streamText({ ...call, guards: { services: [rewrites], context } });
    let streamed = '';
    for await (const delta of rewritten.textStream) streamed += delta;
    expect(streamed).toBe('');
    expect(await rewritten.finishReason).toBe('stop');
    expect(await rewritten.refusal).toBe('A rewritten refusal.');
    expect(await rewritten.text).toBe('');

    // A guard that removes the message leaves an empty one: the promise still says the model refused.
    const removed = streamText({ ...call, guards: { services: [removes], context } });
    for await (const _part of removed.fullStream) void _part;
    expect(await removed.finishReason).toBe('stop');
    expect(await removed.refusal).toBe('');
  });

  /** A guard that passes the whole reply it is shown, and the caller aborts the call while it judges. */
  const abortsWhileJudging = (controller: AbortController): IGuardrailService => ({
    id: 'aborts-while-judging',
    evaluateOutput: async ({ chunk }) => {
      if (isFinal(chunk)) controller.abort(new Error('the caller stopped'));
      return null;
    },
  });

  it('ends on a caller abort that fired while the output guards judged its message', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, chatRefusal],
    ]);
    const stopping = new AbortController();
    await expect(generateText({ ...call, abortSignal: stopping.signal, guards: { services: [abortsWhileJudging(stopping)], context } })).rejects.toThrow('the caller stopped');

    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, chatRefusalStream],
    ]);
    const controller = new AbortController();
    const stopped = streamText({ ...call, abortSignal: controller.signal, guards: { services: [abortsWhileJudging(controller)], context } });
    const parts: StreamPart[] = [];
    for await (const part of stopped.fullStream) parts.push(part);
    expect(parts.map((part) => part.type)).toEqual(['error']);
    expect((parts[0] as { error: unknown }).error).toMatchObject({ message: 'the caller stopped' });
    expect(await stopped.finishReason).toBe('error');
    expect(await stopped.refusal).toBeUndefined();
  });
});

describe('an OpenAI refusal on a call with tools', () => {
  const lookup = {
    description: 'Look a word up.',
    parameters: { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q' as const] },
    execute: vi.fn(async () => ({ hits: 1 })),
  };
  const call = {
    provider: 'openai',
    model: CHAT_MODEL,
    apiKey: 'sk-refusal-e2e',
    prompt: 'A request.',
    fallbackProviders: [],
    tools: { lookup },
  };

  it('comes back from generateText in prompt tool mode as a stop with its message', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, chatRefusal],
    ]);

    const result = await generateText({ ...call, toolMode: 'prompt' });

    expect(result.finishReason).toBe('stop');
    expect(result.refusal).toBe(REFUSAL);
    expect(result.text).toBe('');
  });

  it('comes back from streamText in prompt tool mode as a stop with its message', async () => {
    // The prompt tool loop sends each round as a whole request, so the answer is the whole body.
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, chatRefusal],
    ]);

    const result = streamText({ ...call, toolMode: 'prompt' });

    let streamed = '';
    for await (const delta of result.textStream) streamed += delta;
    expect(streamed).toBe('');
    expect(await result.finishReason).toBe('stop');
    expect(await result.refusal).toBe(REFUSAL);
    expect(await result.text).toBe('');
  });

  it('after a tool step that wrote text, resolves the text of streamText empty', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, inOrder(chatToolStepStream, chatRefusalStream)],
    ]);

    const result = streamText({ ...call, maxSteps: 3 });

    let streamed = '';
    for await (const delta of result.textStream) streamed += delta;
    // The tool step's own text went out as it came; the refused step added none.
    expect(streamed).toBe('Looking it up.');
    expect(await result.finishReason).toBe('stop');
    expect(await result.refusal).toBe(REFUSAL);
    expect(await result.text).toBe('');
  });
});

describe('an OpenAI chat stream cut before its finish chunk', () => {
  it('ends streamText on an error, never as a refused answer', async () => {
    // A refusal piece, then the body ends: no finish chunk, no usage chunk, no [DONE].
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, () => sseResponse([chatChunk([{ index: 0, delta: { refusal: 'I cannot' }, finish_reason: null }])])],
    ]);

    const result = streamText({ provider: 'openai', model: CHAT_MODEL, apiKey: 'sk-refusal-e2e', prompt: 'A request.', fallbackProviders: [] });
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);

    expect(parts.map((part) => part.type)).toContain('error');
    expect(await result.finishReason).toBe('error');
    expect(await result.refusal).toBeUndefined();
  });
});

describe('an OpenAI refusal beside a tool call', () => {
  /** A Responses answer that refuses part of the request and calls `lookup` in the same output. */
  const responsesRefusalWithCall = () =>
    jsonResponse({
      ...responsesRefusalBody(),
      output: [
        { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'refusal', refusal: REFUSAL }] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      ],
    });
  /** An ordinary Responses answer, which a second request would get. */
  const responsesDone = () =>
    jsonResponse({ ...responsesRefusalBody(), output: [{ type: 'message', id: 'msg_2', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }] });
  /** The same on a Chat Completions stream: refusal pieces and a tool call, finished with `tool_calls`. */
  const chatRefusalWithCallStream = () =>
    sseResponse([
      ...REFUSAL_PARTS.map((part) => chatChunk([{ index: 0, delta: { refusal: part }, finish_reason: null }])),
      chatChunk([{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }, finish_reason: null }]),
      chatChunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
      chatChunk([], { usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } }),
      'data: [DONE]\n\n',
    ]);
  const chatDoneStream = () =>
    sseResponse([chatChunk([{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }]), chatChunk([{ index: 0, delta: {}, finish_reason: 'stop' }]), 'data: [DONE]\n\n']);
  const tool = () => ({
    description: 'Look a word up.',
    parameters: { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q' as const] },
    execute: vi.fn(async () => ({ hits: 1 })),
  });
  const requestsTo = (endpoint: RegExp) => fetchMock.mock.calls.filter(([url]) => endpoint.test(String(url))).length;

  it('ends generateText on the refusal, and the call it came with is not run', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/responses/, inOrder(responsesRefusalWithCall, responsesDone)],
    ]);
    const lookup = tool();

    const result = await generateText({ provider: 'openai', model: RESPONSES_MODEL, apiKey: 'sk-refusal-e2e', prompt: 'A request.', fallbackProviders: [], tools: { lookup }, maxSteps: 3 });

    expect(result.finishReason).toBe('stop');
    expect(result.refusal).toBe(REFUSAL);
    expect(result.text).toBe('');
    expect(lookup.execute).not.toHaveBeenCalled();
    expect(requestsTo(/api\.openai\.com\/v1\/responses/)).toBe(1);
  });

  it('ends streamText on the refusal, and the call it came with is not run', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, inOrder(chatRefusalWithCallStream, chatDoneStream)],
    ]);
    const lookup = tool();

    const result = streamText({ provider: 'openai', model: CHAT_MODEL, apiKey: 'sk-refusal-e2e', prompt: 'A request.', fallbackProviders: [], tools: { lookup }, maxSteps: 3 });
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);

    expect(parts).toEqual([]);
    expect(await result.finishReason).toBe('stop');
    expect(await result.refusal).toBe(REFUSAL);
    expect(await result.text).toBe('');
    expect(lookup.execute).not.toHaveBeenCalled();
    expect(requestsTo(/api\.openai\.com\/v1\/chat\/completions/)).toBe(1);
  });

  it('ends generateText and streamText in prompt tool mode on the refusal, and the call written beside it is not run', async () => {
    // Prompt tool mode reads calls from the reply's text: this one holds a call block and the refusal message.
    const refusalWithCallBlock = () =>
      jsonResponse({
        id: 'chatcmpl-refusal-call',
        object: 'chat.completion',
        created: 1721596428,
        model: CHAT_MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: '<tool_call>{"name":"lookup","arguments":{"q":"x"}}</tool_call>', refusal: REFUSAL }, logprobs: null, finish_reason: 'stop' }],
        usage: { prompt_tokens: 81, completion_tokens: 30, total_tokens: 111 },
      });
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      // Every request gets the same reply: a second request or a run tool would show in the counts below.
      [/api\.openai\.com\/v1\/chat\/completions/, refusalWithCallBlock],
    ]);
    const lookup = tool();
    const call = { provider: 'openai', model: CHAT_MODEL, apiKey: 'sk-refusal-e2e', prompt: 'A request.', fallbackProviders: [], tools: { lookup }, toolMode: 'prompt' as const, maxSteps: 3 };

    const result = await generateText(call);
    expect(result.finishReason).toBe('stop');
    expect(result.refusal).toBe(REFUSAL);
    expect(result.text).toBe('');
    expect(lookup.execute).not.toHaveBeenCalled();
    expect(requestsTo(/api\.openai\.com\/v1\/chat\/completions/)).toBe(1);

    const streamed = streamText(call);
    let text = '';
    for await (const delta of streamed.textStream) text += delta;
    expect(text).toBe('');
    expect(await streamed.finishReason).toBe('stop');
    expect(await streamed.refusal).toBe(REFUSAL);
    expect(lookup.execute).not.toHaveBeenCalled();
    expect(requestsTo(/api\.openai\.com\/v1\/chat\/completions/)).toBe(2);
  });

  it('ends a turn on the GMI runtime on the refusal, and the call it came with is not run', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-refusal-e2e');
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, inOrder(chatRefusalWithCallStream, chatDoneStream)],
    ]);
    const lookup = tool();
    const seat = agent({ runtime: 'gmi', provider: 'openai', model: CHAT_MODEL, apiKey: 'sk-refusal-e2e', memory: false, fallbackProviders: [], tools: { lookup } });

    try {
      const result = (await seat.generate('A request.')) as GenerateTextResult;
      // The GMI turn carries no refusal field (a documented limit); it ends on the model's answer, never on its calls.
      expect(result.finishReason).toBe('stop');
      expect(result.text).toBe('');
      expect(result.toolCalls).toEqual([]);
    } finally {
      await seat.close();
    }
    expect(lookup.execute).not.toHaveBeenCalled();
    expect(requestsTo(/api\.openai\.com\/v1\/chat\/completions/)).toBe(1);
  });
});

describe('an OpenAI refusal on a structured call', () => {
  const requestsTo = (endpoint: RegExp) => fetchMock.mock.calls.filter(([url]) => endpoint.test(String(url))).length;

  it('ends generateObject on the refusal with its message, and asks for no repair', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, chatRefusal],
    ]);

    const failed = await generateObject({
      provider: 'openai',
      model: CHAT_MODEL,
      apiKey: 'sk-refusal-e2e',
      schema: z.object({ answer: z.string() }),
      prompt: 'A request.',
      fallbackProviders: [],
    }).catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(ObjectGenerationError);
    expect(failed).toMatchObject({ refusal: REFUSAL });
    expect(requestsTo(/api\.openai\.com\/v1\/chat\/completions/)).toBe(1);
  });

  it('ends an agent session send with a response schema on the refusal, and asks for no repair', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, chatRefusal],
    ]);

    const session = agent({ provider: 'openai', model: CHAT_MODEL, apiKey: 'sk-refusal-e2e', fallbackProviders: [], memory: false, instructions: 'Answer in JSON.' }).session('refused');
    const failed = await session.send('A request.', { responseSchema: z.object({ answer: z.string() }), maxValidationRetries: 1 }).catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(ObjectGenerationError);
    expect(failed).toMatchObject({ refusal: REFUSAL });
    expect(requestsTo(/api\.openai\.com\/v1\/chat\/completions/)).toBe(1);
  });
});

describe('an OpenAI Responses refusal part with an empty message', () => {
  const emptyRefusal = () => {
    const body = responsesRefusalBody();
    return jsonResponse({ ...body, output: [{ ...body.output[0], content: [{ type: 'refusal', refusal: '' }] }] });
  };

  it('is still a refusal at the provider and from generateText', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/responses/, emptyRefusal],
    ]);
    const provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-refusal-e2e', maxRetries: 1 });

    const answer = await provider.generateCompletion(RESPONSES_MODEL, [{ role: 'user', content: 'A request.' }], {});
    expect(answer.choices[0]?.finishReason).toBe('stop');
    expect(answer.choices[0]?.refusal).toBe('');

    const result = await generateText({ provider: 'openai', model: RESPONSES_MODEL, apiKey: 'sk-refusal-e2e', prompt: 'A request.', fallbackProviders: [] });
    expect(result.finishReason).toBe('stop');
    expect(result.refusal).toBe('');
    expect(result.text).toBe('');
  });
});

// The `refusal` field is the signal: present, an empty message included, exactly when the model refused, on every
// endpoint, whole or streamed, and when the output cap cut the answer.
describe('an OpenAI refusal with an empty message on every path', () => {
  const call = (model: string) => ({ provider: 'openai', model, apiKey: 'sk-refusal-e2e', prompt: 'A request.', fallbackProviders: [] });
  /** A Chat Completions answer whose message holds the given content beside an empty refusal. */
  const chatEmptyRefusal = (finishReason: 'stop' | 'length', content: string | null = null) => () =>
    jsonResponse({
      id: 'chatcmpl-empty-refusal',
      object: 'chat.completion',
      created: 1721596428,
      model: CHAT_MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content, refusal: '' }, logprobs: null, finish_reason: finishReason }],
      usage: { prompt_tokens: 81, completion_tokens: 1, total_tokens: 82 },
    });
  /** The same streamed: the first delta opens an empty refusal; then the finish chunk, or the body ends there. */
  const chatEmptyRefusalStream = (end: 'stop' | 'length' | 'cut') => () =>
    sseResponse([
      chatChunk([{ index: 0, delta: { role: 'assistant', content: null, refusal: '' }, finish_reason: null }]),
      ...(end === 'cut'
        ? []
        : [
            chatChunk([{ index: 0, delta: {}, finish_reason: end }]),
            chatChunk([], { usage: { prompt_tokens: 81, completion_tokens: 1, total_tokens: 82 } }),
            'data: [DONE]\n\n',
          ]),
    ]);
  /** An `incomplete` response the output cap cut, its one message a refusal part with an empty message. */
  const responsesCutEmptyRefusalBody = () => {
    const body = responsesCutRefusalBody();
    return { ...body, output: [{ ...body.output[0], content: [{ type: 'refusal', refusal: '' }] }] };
  };
  const responsesCutEmptyRefusalStream = () => {
    let sequence = 0;
    const event = (type: string, fields: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`;
    const body = responsesCutEmptyRefusalBody();
    return sseResponse([
      event('response.created', { response: { ...body, status: 'in_progress', incomplete_details: null, output: [], usage: null } }),
      event('response.output_item.added', {
        output_index: 0,
        item: { id: 'msg_1234567890', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      }),
      event('response.incomplete', { response: body }),
    ]);
  };
  const chatEndpoint = /api\.openai\.com\/v1\/chat\/completions/;
  const responsesEndpoint = /api\.openai\.com\/v1\/responses/;

  it('on Chat Completions, is a refusal at the provider, from generateText and from streamText', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [chatEndpoint, chatEmptyRefusal('stop')],
    ]);
    const provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-refusal-e2e', maxRetries: 1 });
    const answer = await provider.generateCompletion(CHAT_MODEL, [{ role: 'user', content: 'A request.' }], {});
    expect(answer.choices[0]?.finishReason).toBe('stop');
    expect(answer.choices[0]?.refusal).toBe('');

    const result = await generateText(call(CHAT_MODEL));
    expect(result.finishReason).toBe('stop');
    expect(result.refusal).toBe('');
    expect(result.text).toBe('');

    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [chatEndpoint, chatEmptyRefusalStream('stop')],
    ]);
    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of provider.generateCompletionStream(CHAT_MODEL, [{ role: 'user', content: 'A request.' }], {})) chunks.push(chunk);
    const finish = chunks.find((chunk) => chunk.choices[0]?.finishReason != null);
    expect(finish?.choices[0]?.finishReason).toBe('stop');
    expect(finish?.choices[0]?.refusal).toBe('');

    const streamed = streamText(call(CHAT_MODEL));
    for await (const _part of streamed.fullStream) void _part;
    expect(await streamed.finishReason).toBe('stop');
    expect(await streamed.refusal).toBe('');
    expect(await streamed.text).toBe('');
  });

  it('on a Chat Completions stream cut before its finish chunk, ends streamText on an error', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [chatEndpoint, chatEmptyRefusalStream('cut')],
    ]);

    const result = streamText(call(CHAT_MODEL));
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);

    expect(parts.map((part) => part.type)).toContain('error');
    expect(await result.finishReason).toBe('error');
    expect(await result.refusal).toBeUndefined();
  });

  it.each([
    { name: 'Chat Completions', model: CHAT_MODEL, endpoint: chatEndpoint, answer: chatEmptyRefusal('length'), stream: chatEmptyRefusalStream('length') },
    { name: 'Responses', model: RESPONSES_MODEL, endpoint: responsesEndpoint, answer: () => jsonResponse(responsesCutEmptyRefusalBody()), stream: responsesCutEmptyRefusalStream },
  ])('cut by the output cap on $name, comes back from generateText and streamText as length with the field', async ({ model, endpoint, answer, stream }) => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [endpoint, answer],
    ]);
    const result = await generateText(call(model));
    expect(result).toMatchObject({ text: '', finishReason: 'length', refusal: '' });

    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [endpoint, stream],
    ]);
    const streamed = streamText(call(model));
    for await (const _part of streamed.fullStream) void _part;
    expect(await streamed.finishReason).toBe('length');
    expect(await streamed.refusal).toBe('');
    expect(await streamed.text).toBe('');
  });

  it('beside text, is kept as a Responses refusal part, and an empty Chat Completions refusal field beside text is no refusal', async () => {
    // A Responses refusal is its own typed part, so it is a refusal whatever comes beside it.
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [responsesEndpoint, () => {
        const body = responsesRefusalBody();
        return jsonResponse({ ...body, output: [{ ...body.output[0], content: [{ type: 'output_text', text: '{"c":{}}' }, { type: 'refusal', refusal: '' }] }] });
      }],
    ]);
    const kept = await generateText(call(RESPONSES_MODEL));
    expect(kept).toMatchObject({ text: '{"c":{}}', finishReason: 'stop', refusal: '' });

    // A Chat Completions message has one refusal field: an empty one beside the answer's text holds no refusal.
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [chatEndpoint, chatEmptyRefusal('stop', 'Hello.')],
    ]);
    const answered = await generateText(call(CHAT_MODEL));
    expect(answered.text).toBe('Hello.');
    expect('refusal' in answered).toBe(false);
  });
});

describe('a Responses stream whose terminal output disagrees with its refusal pieces', () => {
  /** Refusal pieces, then a `response.completed` whose output is the given message content. */
  const streamEndingOn = (content: unknown[]) => () => {
    let sequence = 0;
    const event = (type: string, fields: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`;
    const body = { ...responsesRefusalBody(), output: [{ id: 'msg_1', type: 'message', role: 'assistant', content }] };
    return sseResponse([
      event('response.created', { response: { ...body, status: 'in_progress', output: [], usage: null } }),
      event('response.output_item.added', { output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } }),
      event('response.refusal.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: REFUSAL }),
      event('response.completed', { response: body }),
    ]);
  };

  it('reads the refusal from the terminal output, as the same body read whole does', async () => {
    route([[/api\.openai\.com\/v1\/models/, modelList]]);
    const provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-refusal-e2e', maxRetries: 1 });
    const finalChoice = async () => {
      const chunks: ModelCompletionResponse[] = [];
      for await (const chunk of provider.generateCompletionStream(RESPONSES_MODEL, [{ role: 'user', content: 'A request.' }], {})) chunks.push(chunk);
      return chunks.find((chunk) => chunk.choices[0]?.finishReason != null)?.choices[0];
    };

    // The terminal output holds an ordinary answer and no refusal: the answer is no refusal.
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/responses/, streamEndingOn([{ type: 'output_text', text: 'Hello.' }])],
    ]);
    const answered = await finalChoice();
    expect(answered?.finishReason).toBe('stop');
    expect(answered && 'refusal' in answered).toBe(false);

    const result = streamText({ provider: 'openai', model: RESPONSES_MODEL, apiKey: 'sk-refusal-e2e', prompt: 'A request.', fallbackProviders: [] });
    for await (const _part of result.fullStream) void _part;
    expect(await result.finishReason).toBe('stop');
    expect(await result.refusal).toBeUndefined();
    expect(await result.text).toBe('Hello.');

    // The terminal output holds a refusal part with an empty message: the refusal is that empty message.
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/responses/, streamEndingOn([{ type: 'refusal', refusal: '' }])],
    ]);
    const emptied = await finalChoice();
    expect(emptied?.finishReason).toBe('stop');
    expect(emptied?.refusal).toBe('');
  });
});

describe('the usage event of a refused call', () => {
  /** A streamed step that only calls the `lookup` tool. */
  const chatToolCallOnlyStream = () =>
    sseResponse([
      chatChunk([{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }, finish_reason: null }]),
      chatChunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
      chatChunk([], { usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 } }),
      'data: [DONE]\n\n',
    ]);
  /** Registers an observer and answers the events it hears. */
  const heard = (): LlmUsageEvent[] => {
    const events: LlmUsageEvent[] = [];
    setGlobalLlmObserver((event) => {
      events.push(event);
    });
    return events;
  };

  afterEach(() => setGlobalLlmObserver(null));

  it('from streamText after a tool step with no text, names the reason the call resolved to and says it was refused', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, inOrder(chatToolCallOnlyStream, chatRefusalStream)],
    ]);
    const events = heard();
    const lookup = { description: 'Look a word up.', parameters: { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q' as const] }, execute: vi.fn(async () => ({ hits: 1 })) };

    const result = streamText({ provider: 'openai', model: CHAT_MODEL, apiKey: 'sk-refusal-e2e', prompt: 'A request.', fallbackProviders: [], tools: { lookup }, maxSteps: 3 });
    for await (const _part of result.fullStream) void _part;

    expect(await result.finishReason).toBe('stop');
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    // The tool step ran, and the call still ended on the model's answer: never 'tool-calls'.
    expect(events.at(-1)).toMatchObject({ surface: 'streamText', finishReason: 'stop', refused: true });
  });

  it('from generateText says it was refused, and the event of an ordinary answer does not', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, inOrder(chatRefusal, chatAnswer)],
    ]);
    const events = heard();
    const call = { provider: 'openai', model: CHAT_MODEL, apiKey: 'sk-refusal-e2e', prompt: 'A request.', fallbackProviders: [] };

    await generateText(call);
    await generateText(call);

    await vi.waitFor(() => expect(events.length).toBe(2));
    expect(events[0]).toMatchObject({ surface: 'generateText', finishReason: 'stop', refused: true });
    expect(events[1]).toMatchObject({ surface: 'generateText', finishReason: 'stop' });
    expect(events[1] && 'refused' in events[1]).toBe(false);
  });

  /** A guard that blocks every whole reply it is shown. */
  const blocks: IGuardrailService = {
    id: 'blocks',
    evaluateOutput: async ({ chunk }) => (chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE ? { action: GuardrailAction.BLOCK, reasonCode: 'RULE_OUT' } : null),
  };
  const guarded = (services: IGuardrailService[], abortSignal?: AbortSignal) => ({
    provider: 'openai',
    model: CHAT_MODEL,
    apiKey: 'sk-refusal-e2e',
    prompt: 'A request.',
    fallbackProviders: [],
    ...(abortSignal ? { abortSignal } : {}),
    guards: { services, context: { userId: 'user-1', sessionId: 'session-1' } },
  });

  it('and its root span say the call was refused and blocked when the output guards blocked the refusal message', async () => {
    // The root spans go to an in-memory exporter for this case.
    const exporter = new InMemorySpanExporter();
    trace.disable();
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    configureAgentOSObservability({ enabled: true, tracing: { enabled: true } });
    try {
      route([
        [/api\.openai\.com\/v1\/models/, modelList],
        [/api\.openai\.com\/v1\/chat\/completions/, inOrder(chatRefusal, chatRefusalStream)],
      ]);
      const events = heard();

      await expect(generateText(guarded([blocks]))).rejects.toBeInstanceOf(GuardrailStopError);
      const result = streamText(guarded([blocks]));
      for await (const _part of result.fullStream) void _part;
      expect(await result.finishReason).toBe('error');
      expect(await result.refusal).toBeUndefined();

      // Each record says what the caller got: the call ended on an error, on a refusal the guards blocked.
      await vi.waitFor(() => expect(events.length).toBe(2));
      expect(events[0]).toMatchObject({ surface: 'generateText', finishReason: 'error', refused: true });
      expect(events[1]).toMatchObject({ surface: 'streamText', finishReason: 'error', refused: true });
      const roots = exporter.getFinishedSpans().filter((span) => span.name === 'agentos.api.generate_text' || span.name === 'agentos.api.stream_text');
      expect(roots.map((span) => span.name)).toEqual(['agentos.api.generate_text', 'agentos.api.stream_text']);
      for (const span of roots) {
        expect(span.attributes).toMatchObject({ 'agentos.api.finish_reason': 'error', 'agentos.api.refused': true, 'agentos.api.guard_blocked': true });
      }
    } finally {
      configureAgentOSObservability();
      trace.disable();
    }
  });

  it('of a streamText call the caller aborted while the output guards judged the refusal message says it ended on the abort', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, chatRefusalStream],
    ]);
    const events = heard();
    const controller = new AbortController();
    const abortsWhileJudging: IGuardrailService = {
      id: 'aborts-while-judging',
      evaluateOutput: async ({ chunk }) => {
        if (chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE) controller.abort(new Error('the caller stopped'));
        return null;
      },
    };

    const result = streamText(guarded([abortsWhileJudging], controller.signal));
    for await (const _part of result.fullStream) void _part;
    expect(await result.finishReason).toBe('error');

    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0]).toMatchObject({ surface: 'streamText', finishReason: 'error', aborted: true });
    expect(events[0] && 'refused' in events[0]).toBe(false);
  });

  it('and its root span say the same for a streamText call in prompt tool mode whose refusal the output guards blocked', async () => {
    const exporter = new InMemorySpanExporter();
    trace.disable();
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    configureAgentOSObservability({ enabled: true, tracing: { enabled: true } });
    try {
      // The prompt tool loop sends each round as a whole request, so the answer is the whole body.
      route([
        [/api\.openai\.com\/v1\/models/, modelList],
        [/api\.openai\.com\/v1\/chat\/completions/, chatRefusal],
      ]);
      const events = heard();
      const lookup = { description: 'Look a word up.', parameters: { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q' as const] }, execute: vi.fn(async () => ({ hits: 1 })) };

      const result = streamText({ ...guarded([blocks]), tools: { lookup }, toolMode: 'prompt' });
      for await (const _part of result.fullStream) void _part;
      expect(await result.finishReason).toBe('error');
      expect(await result.refusal).toBeUndefined();

      await vi.waitFor(() => expect(events.length).toBe(1));
      expect(events[0]).toMatchObject({ surface: 'streamText', finishReason: 'error', refused: true });
      const roots = exporter.getFinishedSpans().filter((span) => span.name === 'agentos.api.stream_text');
      expect(roots).toHaveLength(1);
      expect(roots[0]?.attributes).toMatchObject({ 'agentos.api.finish_reason': 'error', 'agentos.api.refused': true, 'agentos.api.guard_blocked': true });
      expect(lookup.execute).not.toHaveBeenCalled();
    } finally {
      configureAgentOSObservability();
      trace.disable();
    }
  });

  it('from streamText that moved to prompt tool mode after a native tool step, ends on the refusal as a stop', async () => {
    // A native tool step runs `lookup`; the next request is turned down for its tools, so the call goes on in
    // prompt tool mode, whose whole answer is the refusal.
    const noNativeTools = () =>
      new Response(JSON.stringify({ error: { message: 'This model does not support tools.', type: 'invalid_request_error', code: null } }), { status: 400, headers: { 'content-type': 'application/json' } });
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, inOrder(chatToolCallOnlyStream, noNativeTools, chatRefusal)],
    ]);
    const events = heard();
    const lookup = { description: 'Look a word up.', parameters: { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q' as const] }, execute: vi.fn(async () => ({ hits: 1 })) };

    const result = streamText({ provider: 'openai', model: CHAT_MODEL, apiKey: 'sk-refusal-e2e', prompt: 'A request.', fallbackProviders: [], tools: { lookup }, maxSteps: 3 });
    for await (const _part of result.fullStream) void _part;

    expect(lookup.execute).toHaveBeenCalledTimes(1);
    // The call ended on the model's refusal, never as an unfinished tool loop.
    expect(await result.finishReason).toBe('stop');
    expect(await result.refusal).toBe(REFUSAL);
    expect(await result.text).toBe('');
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    expect(events.at(-1)).toMatchObject({ surface: 'streamText', finishReason: 'stop', refused: true });
  });
});
