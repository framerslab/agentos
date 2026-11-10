/**
 * @file store-every-request.http.test.ts
 * A call's `store` reaches every request the call makes, not only its first:
 * the second step of a tool loop (Chat Completions, Responses, streamed or
 * not), each round of the prompt-tool loop, and a fallback leg after a primary
 * that answers 503. A fallback leg to Anthropic sends no `store`, since
 * Anthropic's Messages API has no such field.
 *
 * Drives generateText, streamText and generateObject through the public API,
 * the real provider manager, OpenAIProvider and AnthropicProvider, against a
 * local server that answers as OpenAI's API does (`GET /v1/models`,
 * `POST /v1/chat/completions`, `POST /v1/responses`) and as Anthropic's does
 * (`POST /v1/messages`, https://platform.claude.com/docs/en/api/messages).
 * Every request outside the server fails the case.
 *
 * OpenAI's rule: "Responses are stored by default. Chat Completions are stored
 * by default for new accounts. To disable storage in either API, set store:
 * false." (https://developers.openai.com/api/docs/guides/migrate-to-responses,
 * read 2026-11-10). A call that leaves `store` out sends no `store` key to Chat
 * Completions and `store: false` to Responses, on every step.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { generateObject } from '../generateObject.js';
import { generateText } from '../generateText.js';
import { streamText } from '../streamText.js';
import { shutdownProviderManagers } from '../model.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

/** A Chat Completions model: its tool calls stay on /v1/chat/completions. */
const CHAT_MODEL = 'gpt-4.1';
/** A GPT-6 model: a call that carries function tools goes to /v1/responses. */
const GPT6_MODEL = 'gpt-6-luna';
/** The primary that answers 503, so the call walks to its fallback leg. */
const DOWN_MODEL = 'gpt-4.1-nano';
/** The Anthropic leg's model. */
const CLAUDE_MODEL = 'claude-sonnet-4-6';

/** The tool call a first turn makes, as text for the prompt-tool loop. */
const SHIM_CALL = '<tool_call>{"name":"ping","arguments":{"x":"ok"}}</tool_call>';

interface Received {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

const received: Received[] = [];
const unexpected: string[] = [];
const outside: string[] = [];
/**
 * What the first turn of a case answers: plain text, a native tool call, or a
 * prompt-tool-loop call in the text. A turn that already holds a tool result
 * answers `finalText`.
 */
let firstTurn: 'text' | 'native-tool' | 'shim-tool' = 'text';
/** The text every final turn answers with. */
let finalText = 'done';
/** The arguments each run of the ping tool was given. */
const pings: string[] = [];

let server: http.Server;
let origin: string;
const realFetch = globalThis.fetch;

const CHAT_USAGE = { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 };
const RESPONSES_USAGE = {
  input_tokens: 40,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 2,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 42,
};

function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendEvents(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(text);
}

/** The native tool call a first Chat Completions turn makes. */
const CHAT_TOOL_CALL = { id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{"x":"ok"}' } };

/** A Chat Completions answer: the message, its finish reason and usage. */
function chatAnswer(message: Record<string, unknown>, finishReason: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-steps',
    object: 'chat.completion',
    created: 1700000000,
    model: CHAT_MODEL,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: CHAT_USAGE,
  };
}

/** One chunk of a streamed chat completion, in Chat Completions' SSE framing. */
function chatChunk(choices: unknown[], extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-steps', object: 'chat.completion.chunk', created: 1700000000, model: CHAT_MODEL, choices, ...extra })}\n\n`;
}

/** A streamed chat completion: the text, or the native tool call, then the usage chunk and `[DONE]`. */
function chatStream(answer: { text: string } | { toolCall: true }): string {
  const body =
    'text' in answer
      ? chatChunk([{ index: 0, delta: { role: 'assistant', content: answer.text }, finish_reason: null }]) +
        chatChunk([{ index: 0, delta: {}, finish_reason: 'stop' }])
      : chatChunk([
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'ping', arguments: '' } }],
            },
            finish_reason: null,
          },
        ]) +
        chatChunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":"ok"}' } }] }, finish_reason: null }]) +
        chatChunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]);
  return body + chatChunk([], { usage: CHAT_USAGE }) + 'data: [DONE]\n\n';
}

const RESPONSES_META = { id: 'resp_steps', object: 'response', created_at: 1700000000, model: GPT6_MODEL };
const responsesPing = (args: string): Record<string, unknown> => ({
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_r1',
  name: 'ping',
  arguments: args,
  status: 'completed',
});
const responsesMessage = (text: string): Record<string, unknown> => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});

/** A streamed Responses answer: the function call, or the text, in the Responses SSE framing. */
function responsesStream(answer: { text: string } | { toolCall: true }): string {
  const output = 'text' in answer ? [responsesMessage(answer.text)] : [responsesPing('{"x":"ok"}')];
  const middle =
    'text' in answer
      ? [{ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: answer.text }]
      : [
          { type: 'response.output_item.added', output_index: 0, item: { ...responsesPing(''), status: 'in_progress' } },
          { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"x":"ok"}' },
          { type: 'response.output_item.done', output_index: 0, item: responsesPing('{"x":"ok"}') },
        ];
  const events = [
    { type: 'response.created', response: { ...RESPONSES_META, status: 'in_progress', output: [], usage: null } },
    ...middle,
    { type: 'response.completed', response: { ...RESPONSES_META, status: 'completed', output, usage: RESPONSES_USAGE } },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** An Anthropic Messages answer whose text is `finalText`, streamed or not. */
function answerMessages(res: http.ServerResponse, body: Record<string, unknown>): void {
  const model = typeof body.model === 'string' ? body.model : CLAUDE_MODEL;
  if (body.stream === true) {
    const events: Array<[string, unknown]> = [
      ['message_start', { type: 'message_start', message: { id: 'msg_leg', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: finalText } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    sendEvents(res, events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    return;
  }
  sendJson(res, {
    id: 'msg_leg',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: finalText }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', origin);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      received.push({ method: req.method ?? '', path: url.pathname, body });
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        sendJson(res, {
          object: 'list',
          data: [CHAT_MODEL, GPT6_MODEL, DOWN_MODEL].map((id) => ({ id, object: 'model', created: 1, owned_by: 'openai' })),
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        if (body.model === DOWN_MODEL) {
          sendJson(res, { error: { message: 'Service Unavailable', type: 'server_error' } }, 503);
          return;
        }
        // A turn that holds the tool's result, as a native tool message or as
        // the prompt-tool loop's own assistant turn, is the final one.
        const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: unknown }>) : [];
        const final = firstTurn === 'text' || messages.some((m) => m.role === 'tool' || m.role === 'assistant');
        if (body.stream === true) {
          sendEvents(res, chatStream(final || firstTurn === 'shim-tool' ? { text: final ? finalText : SHIM_CALL } : { toolCall: true }));
          return;
        }
        if (final) sendJson(res, chatAnswer({ role: 'assistant', content: finalText }, 'stop'));
        else if (firstTurn === 'shim-tool') sendJson(res, chatAnswer({ role: 'assistant', content: SHIM_CALL }, 'stop'));
        else sendJson(res, chatAnswer({ role: 'assistant', content: null, tool_calls: [CHAT_TOOL_CALL] }, 'tool_calls'));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        const input = Array.isArray(body.input) ? (body.input as Array<{ type?: unknown }>) : [];
        const final = firstTurn === 'text' || input.some((item) => item.type === 'function_call_output');
        if (body.stream === true) {
          sendEvents(res, responsesStream(final ? { text: finalText } : { toolCall: true }));
          return;
        }
        sendJson(res, {
          ...RESPONSES_META,
          status: 'completed',
          output: [final ? responsesMessage(finalText) : responsesPing('{"x":"ok"}')],
          usage: RESPONSES_USAGE,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        answerMessages(res, body);
        return;
      }
      unexpected.push(`${req.method} ${url.pathname}`);
      sendJson(res, { error: { message: 'no such route in this case' } }, 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
  unexpected.length = 0;
  outside.length = 0;
  pings.length = 0;
  firstTurn = 'text';
  finalText = 'done';
  globalLLMProviderHealth.reset();
  for (const name of [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'OPENROUTER_API_KEY',
    'AGENTOS_USAGE_LEDGER_PATH',
    'WUNDERLAND_USAGE_LEDGER_PATH',
  ]) {
    vi.stubEnv(name, '');
  }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${origin}/`)) {
      outside.push(url);
      return Promise.reject(new Error(`outside the test server: ${url}`));
    }
    return realFetch(input, init);
  });
});

afterEach(async () => {
  await shutdownProviderManagers();
  globalLLMProviderHealth.reset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(unexpected).toEqual([]);
  expect(outside).toEqual([]);
});

/** The POSTs the server received: each one's path and JSON body. */
const posts = (): Received[] => received.filter((r) => r.method === 'POST');

const baseUrl = (): string => `${origin}/v1`;

/** Reads a text stream to its end and returns what it carried. */
async function drain(stream: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const delta of stream) text += delta;
  return text;
}

const pingTool = {
  ping: {
    description: 'Ping the service.',
    parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    execute: async ({ x }: { x: string }) => {
      pings.push(x);
      return { pong: x };
    },
  },
};

/** Checks one request's `store`: the value the call set, or no key at all on Chat Completions when it set none. */
function expectChatStore(request: Received, store: boolean | undefined): void {
  if (store === undefined) expect(request.body).not.toHaveProperty('store');
  else expect(request.body.store).toBe(store);
}

/** Whether a request carries the tool's result back to the model. */
const carriesToolResult = (request: Received): boolean => {
  const messages = Array.isArray(request.body.messages) ? (request.body.messages as Array<{ role?: unknown }>) : [];
  const input = Array.isArray(request.body.input) ? (request.body.input as Array<{ type?: unknown }>) : [];
  return messages.some((m) => m.role === 'tool') || input.some((item) => item.type === 'function_call_output');
};

describe('every step of the tool loop carries store', () => {
  it.each([{ store: false }, { store: true }, { store: undefined }])(
    'generateText on Chat Completions with store: $store: the tool call and the turn after it carry it',
    async ({ store }) => {
      firstTurn = 'native-tool';

      const result = await generateText({
        provider: 'openai',
        model: CHAT_MODEL,
        apiKey: 'test',
        baseUrl: baseUrl(),
        prompt: 'Ping with x="ok", then say done.',
        tools: pingTool,
        maxSteps: 3,
        ...(store === undefined ? {} : { store }),
        fallbackProviders: [],
      });

      expect(result.text).toBe('done');
      expect(pings).toEqual(['ok']);
      expect(posts().map((p) => p.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
      expect(carriesToolResult(posts()[1])).toBe(true);
      for (const request of posts()) expectChatStore(request, store);
    },
  );

  it.each([
    { store: true, expected: true },
    { store: false, expected: false },
    { store: undefined, expected: false },
  ])(
    'generateText on Responses with store: $store: the tool call and the turn after it carry store: $expected',
    async ({ store, expected }) => {
      firstTurn = 'native-tool';

      const result = await generateText({
        provider: 'openai',
        model: GPT6_MODEL,
        apiKey: 'test',
        baseUrl: baseUrl(),
        prompt: 'Ping with x="ok", then say done.',
        tools: pingTool,
        maxSteps: 3,
        ...(store === undefined ? {} : { store }),
        fallbackProviders: [],
      });

      expect(result.text).toBe('done');
      expect(pings).toEqual(['ok']);
      expect(posts().map((p) => p.path)).toEqual(['/v1/responses', '/v1/responses']);
      expect(carriesToolResult(posts()[1])).toBe(true);
      for (const request of posts()) expect(request.body.store).toBe(expected);
    },
  );

  it('streamText on Chat Completions with store: false: the streamed tool call and the streamed turn after it carry it', async () => {
    firstTurn = 'native-tool';

    const result = streamText({
      provider: 'openai',
      model: CHAT_MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'Ping with x="ok", then say done.',
      tools: pingTool,
      maxSteps: 3,
      store: false,
      fallbackProviders: [],
    });

    expect(await drain(result.textStream)).toBe('done');
    expect(pings).toEqual(['ok']);
    expect(posts().map((p) => p.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
    expect(carriesToolResult(posts()[1])).toBe(true);
    for (const request of posts()) {
      expect(request.body.stream).toBe(true);
      expect(request.body.store).toBe(false);
    }
  });

  it('streamText on Responses with store: true: the streamed tool call and the streamed turn after it carry it', async () => {
    firstTurn = 'native-tool';

    const result = streamText({
      provider: 'openai',
      model: GPT6_MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'Ping with x="ok", then say done.',
      tools: pingTool,
      maxSteps: 3,
      store: true,
      fallbackProviders: [],
    });

    expect(await drain(result.textStream)).toBe('done');
    expect(pings).toEqual(['ok']);
    expect(posts().map((p) => p.path)).toEqual(['/v1/responses', '/v1/responses']);
    expect(carriesToolResult(posts()[1])).toBe(true);
    for (const request of posts()) {
      expect(request.body.stream).toBe(true);
      expect(request.body.store).toBe(true);
    }
  });
});

describe("each round of the prompt-tool loop carries store", () => {
  it("generateText with toolMode 'prompt' and store: false: the round that calls the tool and the round after it carry it", async () => {
    firstTurn = 'shim-tool';

    const result = await generateText({
      provider: 'openai',
      model: CHAT_MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'Ping with x="ok", then say done.',
      tools: pingTool,
      toolMode: 'prompt',
      store: false,
      fallbackProviders: [],
    });

    expect(result.text).toBe('done');
    expect(pings).toEqual(['ok']);
    expect(posts().map((p) => p.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
    for (const request of posts()) {
      expect(request.body).not.toHaveProperty('tools');
      expect(request.body.store).toBe(false);
    }
  });

  it("streamText with toolMode 'prompt' and store: false: the round that calls the tool and the round after it carry it", async () => {
    firstTurn = 'shim-tool';

    const result = streamText({
      provider: 'openai',
      model: CHAT_MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'Ping with x="ok", then say done.',
      tools: pingTool,
      toolMode: 'prompt',
      store: false,
      fallbackProviders: [],
    });

    expect(await drain(result.textStream)).toBe('done');
    expect(pings).toEqual(['ok']);
    expect(posts().map((p) => p.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
    for (const request of posts()) {
      expect(request.body).not.toHaveProperty('tools');
      expect(request.body.store).toBe(false);
    }
  });
});

describe('a fallback leg carries store', () => {
  /** A leg to OpenAI on the same server, with a key of its own. */
  const openaiLeg = () => [{ provider: 'openai', model: CHAT_MODEL, apiKey: 'test-leg', baseUrl: baseUrl() }];

  it('generateText with store: false: the 503 primary and the OpenAI leg after it both carry it', async () => {
    const result = await generateText({
      provider: 'openai',
      model: DOWN_MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'x',
      maxAttempts: 1,
      store: false,
      fallbackProviders: openaiLeg(),
    });

    expect(result.text).toBe('done');
    expect(result.fallback?.fired).toBe(true);
    expect(posts().map((p) => p.body.model)).toEqual([DOWN_MODEL, CHAT_MODEL]);
    for (const request of posts()) expect(request.body.store).toBe(false);
  });

  it('streamText with store: false: the 503 primary and the streamed OpenAI leg after it both carry it', async () => {
    const result = streamText({
      provider: 'openai',
      model: DOWN_MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'x',
      maxAttempts: 1,
      store: false,
      fallbackProviders: openaiLeg(),
    });

    expect(await drain(result.textStream)).toBe('done');
    expect(posts().map((p) => p.body.model)).toEqual([DOWN_MODEL, CHAT_MODEL]);
    for (const request of posts()) {
      expect(request.body.stream).toBe(true);
      expect(request.body.store).toBe(false);
    }
  });

  it('generateObject with store: false: the 503 primary and the OpenAI leg after it both carry it', async () => {
    finalText = '{"planet":"Jupiter"}';

    const result = await generateObject({
      provider: 'openai',
      model: DOWN_MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      schema: z.object({ planet: z.string() }),
      prompt: 'x',
      maxAttempts: 1,
      store: false,
      fallbackProviders: openaiLeg(),
    });

    expect(result.object).toEqual({ planet: 'Jupiter' });
    expect(posts().map((p) => p.body.model)).toEqual([DOWN_MODEL, CHAT_MODEL]);
    for (const request of posts()) expect(request.body.store).toBe(false);
  });

  it('generateText with store: false: an Anthropic leg sends no store, which its Messages API does not take', async () => {
    const result = await generateText({
      provider: 'openai',
      model: DOWN_MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'x',
      maxAttempts: 1,
      store: false,
      fallbackProviders: [{ provider: 'anthropic', model: CLAUDE_MODEL, apiKey: 'sk-ant-leg', baseUrl: origin }],
    });

    expect(result.text).toBe('done');
    expect(result.fallback?.fired).toBe(true);
    const [primary, leg] = posts();
    expect(primary.path).toBe('/v1/chat/completions');
    expect(primary.body.store).toBe(false);
    expect(leg.path).toBe('/v1/messages');
    expect(leg.body.model).toBe(CLAUDE_MODEL);
    expect(leg.body).not.toHaveProperty('store');
    expect(posts()).toHaveLength(2);
  });
});
