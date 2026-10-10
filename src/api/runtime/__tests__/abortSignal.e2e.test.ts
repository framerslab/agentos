/**
 * @file abortSignal.e2e.test.ts
 * A caller's abort signal through the public API and the real OpenAIProvider,
 * with only fetch stubbed. An abort while a request is in flight cancels that
 * request, and the call rejects with the signal's reason itself: no retry, no
 * further attempt and no fallback request follows, and the provider's health
 * is not charged. An abort while the call's last tool round runs lets the
 * round finish and then ends the call the same way, on the native tool loop
 * and on the prompt-tool shim, instead of settling the call as a success.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateObject } from '../generateObject.js';
import { generateText } from '../generateText.js';
import { streamText, type StreamPart } from '../streamText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';

type Payload = Record<string, unknown>;

/** Answers one POST, given the signal fetch was handed for it. */
type Reply = (signal: AbortSignal | null | undefined) => Response | Promise<Response>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A /v1/responses SSE body: an `event:` line and a `data:` line per event. */
function sseResponse(events: Payload[]): Response {
  const text = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A request that gets no answer: as fetch does, it rejects with the reason once its signal aborts. */
const heldUntilAborted: Reply = (signal) =>
  new Promise<Response>((_resolve, reject) => {
    if (!signal) {
      reject(new Error('the request carries no signal'));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** Lists models on GET and answers each POST with the next queued reply. */
function serve(posts: Reply[]): void {
  const queue = [...posts];
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ object: 'list', data: [{ id: 'gpt-6-luna', object: 'model', created: 1, owned_by: 'openai' }] });
    }
    const next = queue.shift();
    if (!next) throw new Error(`unexpected POST ${String(url)}`);
    return next(init?.signal);
  });
}

/** The POSTs fetch was handed: each one's URL and signal. */
function posted(): Array<{ url: string; signal: AbortSignal | null | undefined }> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({ url: String(url), signal: (init as RequestInit | undefined)?.signal }));
}

const usage = (input: number, output: number): Payload => ({
  input_tokens: input,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: output,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: input + output,
});
const meta = (model: string): Payload => ({ id: 'resp_1', object: 'response', created_at: 1700000000, model });
const created = (model: string): Payload => ({
  type: 'response.created',
  response: { ...meta(model), status: 'in_progress', output: [], usage: null },
});
const completed = (model: string, output: Payload[], tokens: Payload): { type: string; response: Payload } => ({
  type: 'response.completed',
  response: { ...meta(model), status: 'completed', output, usage: tokens },
});
const pingCall = (args: string): Payload => ({
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'ping',
  arguments: args,
  status: 'completed',
});

/** A chat completion whose text holds one tool call in the form the prompt-tool shim asks for. */
const shimToolCall = (): Response =>
  jsonResponse({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-6-luna',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '<tool_call>{"name":"ping","arguments":{"x":"ok"}}</tool_call>' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  });

/** A `ping` tool whose run outlasts the caller: the caller's signal aborts while it runs, and the run still ends. */
function pingThatOutlastsTheCaller(controller: AbortController, reason: Error) {
  return {
    ping: {
      description: 'Ping the service.',
      parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      execute: async ({ x }: { x: string }) => {
        controller.abort(reason);
        return { pong: x };
      },
    },
  };
}

/** Drains a stream: its parts, and the errors its `error` parts carry. */
async function errorParts(stream: AsyncIterable<StreamPart>): Promise<{ parts: StreamPart[]; errors: Error[] }> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return { parts, errors: parts.flatMap((part) => (part.type === 'error' ? [part.error] : [])) };
}

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

describe("a caller's abort signal through the public API and the real OpenAIProvider", () => {
  it('cancels a generateObject request in flight: the call rejects with the reason itself, and no retry, attempt or fallback request follows', async () => {
    // The fallback entry has a key, so a walk to it would send a second request.
    vi.stubEnv('OPENAI_API_KEY', 'sk-abort-fallback');
    serve([heldUntilAborted]);
    const controller = new AbortController();
    const reason = new Error('deadline passed');
    try {
      const settled = generateObject({
        model: 'openai:gpt-6-luna',
        apiKey: 'sk-abort-object',
        schema: z.object({ planet: z.string() }),
        prompt: 'Which planet in the solar system is the largest?',
        maxRetries: 2,
        fallbackProviders: [{ provider: 'openai', model: 'gpt-6-astra' }],
        abortSignal: controller.signal,
      }).then(() => 'resolved', (error: unknown) => error);
      await vi.waitFor(() => expect(posted()).toHaveLength(1));
      expect(posted()[0].url).toBe(CHAT_URL);
      expect(posted()[0].signal?.aborted).toBe(false);

      controller.abort(reason);

      expect(await settled).toBe(reason);
      expect(posted()[0].signal?.aborted).toBe(true);
      expect(posted()).toHaveLength(1);
      expect(globalLLMProviderHealth.getStats('openai')).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ends generateText with the reason when the signal aborts during its last tool round', async () => {
    serve([() => jsonResponse(completed('gpt-6-luna', [pingCall('{"x":"ok"}')], usage(80, 12)).response)]);
    const controller = new AbortController();
    const reason = new Error('the caller moved on');

    const settled = await generateText({
      model: 'openai:gpt-6-luna',
      apiKey: 'sk-abort-tool-round',
      prompt: 'Ping with x="ok".',
      tools: pingThatOutlastsTheCaller(controller, reason),
      maxSteps: 1,
      fallbackProviders: [],
      abortSignal: controller.signal,
    }).then(() => 'resolved', (error: unknown) => error);

    expect(settled).toBe(reason);
    expect(posted().map((p) => p.url)).toEqual([RESPONSES_URL]);
    expect(globalLLMProviderHealth.getStats('openai')).toBeNull();
  });

  it('ends streamText on the reason when the signal aborts during its last tool round, after the round has run', async () => {
    serve([
      () =>
        sseResponse([
          created('gpt-6-luna'),
          { type: 'response.output_item.added', output_index: 0, item: { ...pingCall(''), status: 'in_progress' } },
          { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"x":' },
          { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '"ok"}' },
          { type: 'response.output_item.done', output_index: 0, item: pingCall('{"x":"ok"}') },
          completed('gpt-6-luna', [pingCall('{"x":"ok"}')], usage(100, 20)),
        ]),
    ]);
    const controller = new AbortController();
    const reason = new Error('the caller moved on');

    const result = streamText({
      model: 'openai:gpt-6-luna',
      apiKey: 'sk-abort-stream-tool-round',
      prompt: 'Ping with x="ok".',
      tools: pingThatOutlastsTheCaller(controller, reason),
      maxSteps: 1,
      fallbackProviders: [],
      abortSignal: controller.signal,
    });
    const { parts, errors } = await errorParts(result.fullStream);

    expect(parts.some((part) => part.type === 'tool-result')).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(reason);
    expect(await result.finishReason).toBe('error');
    expect(posted().map((p) => p.url)).toEqual([RESPONSES_URL]);
    expect(globalLLMProviderHealth.getStats('openai')).toBeNull();
  });

  it("ends generateText with the reason when the signal aborts during the prompt-tool shim's last round", async () => {
    serve([() => shimToolCall()]);
    const controller = new AbortController();
    const reason = new Error('the caller moved on');

    const settled = await generateText({
      model: 'openai:gpt-6-luna',
      apiKey: 'sk-abort-shim-round',
      prompt: 'Ping with x="ok".',
      tools: pingThatOutlastsTheCaller(controller, reason),
      toolMode: 'prompt',
      maxSteps: 1,
      fallbackProviders: [],
      abortSignal: controller.signal,
    }).then(() => 'resolved', (error: unknown) => error);

    expect(settled).toBe(reason);
    expect(posted().map((p) => p.url)).toEqual([CHAT_URL]);
  });

  it("ends streamText on the reason when the signal aborts during the prompt-tool shim's last round", async () => {
    serve([() => shimToolCall()]);
    const controller = new AbortController();
    const reason = new Error('the caller moved on');

    const result = streamText({
      model: 'openai:gpt-6-luna',
      apiKey: 'sk-abort-shim-stream-round',
      prompt: 'Ping with x="ok".',
      tools: pingThatOutlastsTheCaller(controller, reason),
      toolMode: 'prompt',
      maxSteps: 1,
      fallbackProviders: [],
      abortSignal: controller.signal,
    });
    const { errors } = await errorParts(result.fullStream);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(reason);
    expect(await result.finishReason).toBe('error');
    expect(posted().map((p) => p.url)).toEqual([CHAT_URL]);
  });
});
