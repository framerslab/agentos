/**
 * @file streamText-openai-responses.e2e.test.ts
 * GPT-6 tool calls and Responses-only models reach OpenAI's /v1/responses
 * through the public API, streamed and not. Chat Completions does not serve
 * them (GPT-6 tool calls return 400 there, gpt-5.3-codex returns 404), so a
 * call that lands on /v1/chat/completions fails the whole run.
 *
 * Runs streamText / generateText -> the real OpenAIProvider with only fetch
 * stubbed, and asserts the requests on the wire and the results the caller
 * sees.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { streamText } from '../streamText.js';
import { generateText } from '../generateText.js';
import { setGlobalLlmObserver, type LlmUsageEvent } from '../../observers.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

type Json = Record<string, any>;

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A /v1/responses SSE body: an `event:` line and a `data:` line per event. */
function sseResponse(events: Json[]): Response {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Lists models on GET and answers each POST with the next queued reply. */
function serve(posts: Array<() => Response>): void {
  const queue = [...posts];
  fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ object: 'list', data: [{ id: 'gpt-6-sol', object: 'model', created: 1, owned_by: 'openai' }] });
    }
    const next = queue.shift();
    if (!next) throw new Error(`unexpected POST ${String(url)}`);
    return next();
  });
}

function postedBodies(): Array<{ url: string; body: Json }> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as { body?: unknown }).body)) as Json }));
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const delta of stream) text += delta;
  return text;
}

const usage = (input: number, output: number): Json => ({
  input_tokens: input,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: output,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: input + output,
});
const meta = (model: string): Json => ({ id: 'resp_1', object: 'response', created_at: 1700000000, model });
const created = (model: string): Json => ({ type: 'response.created', response: { ...meta(model), status: 'in_progress', output: [], usage: null } });
const completed = (model: string, output: Json[], tokens: Json): Json => ({
  type: 'response.completed',
  response: { ...meta(model), status: 'completed', output, usage: tokens },
});
const pingCall = (args: string): Json => ({
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'ping',
  arguments: args,
  status: 'completed',
});
const message = (text: string): Json => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const textDelta = (delta: string): Json => ({
  type: 'response.output_text.delta',
  output_index: 0,
  item_id: 'msg_1',
  content_index: 0,
  delta,
});

const pingTool = {
  ping: {
    description: 'Ping the service.',
    parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    execute: async ({ x }: { x: string }) => ({ pong: x }),
  },
};

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

describe('streamText on /v1/responses', () => {
  it('runs a gpt-6-sol tool loop on /v1/responses and replays the call and its output', async () => {
    serve([
      () =>
        sseResponse([
          created('gpt-6-sol'),
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...pingCall(''), status: 'in_progress' },
          },
          { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"x":' },
          { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '"ok"}' },
          { type: 'response.output_item.done', output_index: 0, item: pingCall('{"x":"ok"}') },
          completed('gpt-6-sol', [pingCall('{"x":"ok"}')], usage(100, 20)),
        ]),
      () =>
        sseResponse([
          created('gpt-6-sol'),
          textDelta('do'),
          textDelta('ne'),
          completed('gpt-6-sol', [message('done')], usage(150, 5)),
        ]),
    ]);

    const result = streamText({
      model: 'openai:gpt-6-sol',
      apiKey: 'sk-responses-tool-loop',
      prompt: 'Ping with x="ok", then say done.',
      tools: pingTool,
      maxSteps: 3,
      fallbackProviders: [],
    });

    expect(await drain(result.textStream)).toBe('done');
    expect(await result.text).toBe('done');
    expect(await result.finishReason).toBe('stop');
    expect(await result.toolCalls).toEqual([{ name: 'ping', args: { x: 'ok' }, result: { pong: 'ok' } }]);
    expect(await result.usage).toMatchObject({ promptTokens: 250, completionTokens: 25, totalTokens: 275 });

    const bodies = postedBodies();
    expect(bodies.map((b) => b.url)).toEqual([RESPONSES_URL, RESPONSES_URL]);
    expect(bodies[0].body.stream).toBe(true);
    expect(bodies[1].body.input).toEqual(
      expect.arrayContaining([
        { type: 'function_call', call_id: 'call_1', name: 'ping', arguments: '{"x":"ok"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '{"pong":"ok"}' },
      ]),
    );
  });

  it('uses the terminal output where the deltas fall short: text once, the full call arguments', async () => {
    serve([
      () =>
        sseResponse([
          created('gpt-6-sol'),
          { type: 'response.output_item.added', output_index: 0, item: { ...pingCall(''), status: 'in_progress' } },
          // The second argument fragment never arrives as a delta.
          { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"x":' },
          { type: 'response.output_item.done', output_index: 0, item: pingCall('{"x":"ok"}') },
          completed('gpt-6-sol', [pingCall('{"x":"ok"}')], usage(100, 20)),
        ]),
      () =>
        sseResponse([
          created('gpt-6-sol'),
          // Only the start of the answer streams; the terminal output has all of it.
          textDelta('Sun'),
          completed('gpt-6-sol', [message('Sunny.')], usage(150, 5)),
        ]),
    ]);

    const result = streamText({
      model: 'openai:gpt-6-sol',
      apiKey: 'sk-responses-terminal-output',
      prompt: 'Ping with x="ok", then report.',
      tools: pingTool,
      maxSteps: 3,
      fallbackProviders: [],
    });

    expect(await drain(result.textStream)).toBe('Sunny.');
    expect(await result.text).toBe('Sunny.');
    expect(await result.toolCalls).toEqual([{ name: 'ping', args: { x: 'ok' }, result: { pong: 'ok' } }]);
    expect(postedBodies()[1].body.input).toContainEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'ping',
      arguments: '{"x":"ok"}',
    });
  });
});

describe('streamText on a failed /v1/responses response', () => {
  it('counts the usage the failed response reports', async () => {
    serve([
      () =>
        sseResponse([
          created('gpt-5.3-codex'),
          textDelta('Part'),
          {
            type: 'response.failed',
            response: {
              ...meta('gpt-5.3-codex'),
              status: 'failed',
              error: { code: 'server_error', message: 'The model failed mid-answer.' },
              output: [],
              usage: usage(90, 7),
            },
          },
        ]),
    ]);
    const events: LlmUsageEvent[] = [];
    setGlobalLlmObserver((event) => {
      events.push(event);
    });

    try {
      const result = streamText({
        model: 'openai:gpt-5.3-codex',
        apiKey: 'sk-responses-failed',
        prompt: 'Answer in full.',
        fallbackProviders: [],
      });
      for await (const _part of result.fullStream) {
        // drain
      }

      expect(postedBodies().map((b) => b.url)).toEqual([RESPONSES_URL]);
      expect(await result.finishReason).toBe('error');
      expect(await result.usage).toMatchObject({ promptTokens: 90, completionTokens: 7, totalTokens: 97 });
      expect(events.map((e) => [e.finishReason, e.usage.promptTokens, e.usage.completionTokens])).toEqual([
        ['error', 90, 7],
      ]);
    } finally {
      setGlobalLlmObserver(null);
    }
  });
});

describe('streamText when /v1/responses fails before any output', () => {
  it('fails over to the next provider and meters the failed attempt', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-env-fallback');
    serve([
      () =>
        sseResponse([
          created('gpt-5.3-codex'),
          {
            type: 'response.failed',
            response: {
              ...meta('gpt-5.3-codex'),
              status: 'failed',
              error: { code: 'server_error', message: 'Try again.' },
              output: [],
              usage: usage(40, 0),
            },
          },
        ]),
      () =>
        sseResponse([
          created('gpt-5.3-codex'),
          textDelta('Recovered.'),
          completed('gpt-5.3-codex', [message('Recovered.')], usage(60, 3)),
        ]),
    ]);

    try {
      const result = streamText({
        model: 'openai:gpt-5.3-codex',
        apiKey: 'sk-responses-primary',
        prompt: 'Answer.',
        fallbackProviders: [{ provider: 'openai', model: 'gpt-5.3-codex' }],
      });

      expect(await drain(result.textStream)).toBe('Recovered.');
      expect(await result.usage).toMatchObject({ promptTokens: 100, completionTokens: 3 });
      expect(postedBodies().map((b) => b.url)).toEqual([RESPONSES_URL, RESPONSES_URL]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('generateText on /v1/responses', () => {
  it('answers from a Responses-only model', async () => {
    serve([() => jsonResponse({ ...completed('gpt-5.3-codex', [message('hi')], usage(10, 1)).response })]);

    const result = await generateText({
      model: 'openai:gpt-5.3-codex',
      apiKey: 'sk-responses-codex',
      prompt: 'Say hi.',
      fallbackProviders: [],
    });

    expect(result.text).toBe('hi');
    expect(postedBodies().map((b) => b.url)).toEqual([RESPONSES_URL]);
  });

  it('completes a gpt-6-astra tool call that sets no effort', async () => {
    serve([
      () => jsonResponse({ ...completed('gpt-6-astra', [pingCall('{"x":"ok"}')], usage(80, 12)).response }),
      () => jsonResponse({ ...completed('gpt-6-astra', [message('pong ok')], usage(120, 4)).response }),
    ]);

    const result = await generateText({
      model: 'openai:gpt-6-astra',
      apiKey: 'sk-responses-astra',
      prompt: 'Ping with x="ok".',
      tools: pingTool,
      maxSteps: 3,
      fallbackProviders: [],
    });

    expect(result.text).toBe('pong ok');
    expect(result.toolCalls).toEqual([{ name: 'ping', args: { x: 'ok' }, result: { pong: 'ok' } }]);
    const bodies = postedBodies();
    expect(bodies.map((b) => b.url)).toEqual([RESPONSES_URL, RESPONSES_URL]);
    expect(bodies[0].body).not.toHaveProperty('reasoning');
  });
});
