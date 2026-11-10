/**
 * @file generateObject.store.http.test.ts
 * `store` on generateObject, generateText and streamText, through the public
 * API, the real provider manager and the real OpenAIProvider, against a local
 * server that answers as OpenAI's API does (`GET /v1/models`,
 * `POST /v1/chat/completions`, `POST /v1/responses`, streamed or not). Every
 * request outside the server fails the case.
 *
 * OpenAI keeps a request's output unless the request says `store: false`:
 * "Responses are stored by default. Chat completions are stored by default for
 * new accounts. To disable storage when using either API, set store: false."
 * (https://developers.openai.com/api/docs/guides/migrate-to-responses, read
 * 2026-11-10). A call that sets `store` sends it on the request it makes, on
 * every attempt and on the planning request; a call that leaves it out sends
 * no `store` key to Chat Completions and `store: false` to Responses.
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

const MODEL = 'gpt-6-luna';

interface Received {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

const received: Received[] = [];
const unexpected: string[] = [];
const outside: string[] = [];
/** The message texts the next chat completions answer with, in order; the last one repeats. */
let chatReplies: string[] = [];

let server: http.Server;
let origin: string;
const realFetch = globalThis.fetch;

function sendJson(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendEvents(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(text);
}

/** A streamed chat completion whose message text is `content`, in Chat Completions' SSE framing. */
function chatStream(content: string): string {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: 'chatcmpl-store', object: 'chat.completion.chunk', created: 1700000000, model: MODEL, choices, ...extra })}\n\n`;
  return (
    chunk([{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]) +
    chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) +
    chunk([], { usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }) +
    'data: [DONE]\n\n'
  );
}

/** The assistant message a Responses answer carries. */
const RESPONSES_MESSAGE = {
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'pong', annotations: [] }],
};
const RESPONSES_USAGE = {
  input_tokens: 40,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 2,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 42,
};
const RESPONSES_META = { id: 'resp_store', object: 'response', created_at: 1700000000, model: MODEL };

/** A streamed Responses answer, in the Responses SSE framing: an `event:` line and a `data:` line per event. */
function responsesStream(): string {
  const events = [
    { type: 'response.created', response: { ...RESPONSES_META, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'pong' },
    { type: 'response.completed', response: { ...RESPONSES_META, status: 'completed', output: [RESPONSES_MESSAGE], usage: RESPONSES_USAGE } },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
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
        sendJson(res, { object: 'list', data: [{ id: MODEL, object: 'model', created: 1, owned_by: 'openai' }] });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const content = chatReplies.length > 1 ? chatReplies.shift()! : (chatReplies[0] ?? 'ok');
        if (body.stream === true) {
          sendEvents(res, chatStream(content));
          return;
        }
        sendJson(res, {
          id: 'chatcmpl-store',
          object: 'chat.completion',
          created: 1700000000,
          model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        if (body.stream === true) {
          sendEvents(res, responsesStream());
          return;
        }
        sendJson(res, { ...RESPONSES_META, status: 'completed', output: [RESPONSES_MESSAGE], usage: RESPONSES_USAGE });
        return;
      }
      unexpected.push(`${req.method} ${url.pathname}`);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"no such route in this case"}}');
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
  chatReplies = [];
  globalLLMProviderHealth.reset();
  for (const name of [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
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

const Planet = z.object({ planet: z.string() });

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
    execute: async ({ x }: { x: string }) => ({ pong: x }),
  },
};

describe('generateObject sends store to OpenAI', () => {
  it('store: false reaches the chat completion as store: false', async () => {
    chatReplies = ['{"planet":"Jupiter"}'];

    const { object } = await generateObject({
      provider: 'openai',
      model: MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      schema: Planet,
      prompt: 'x',
      store: false,
      fallbackProviders: [],
    });

    expect(object).toEqual({ planet: 'Jupiter' });
    expect(posts()).toHaveLength(1);
    expect(posts()[0].path.endsWith('/chat/completions')).toBe(true);
    expect(posts()[0].body.store).toBe(false);
  });

  it('a call that leaves store out sends no store key to Chat Completions', async () => {
    chatReplies = ['{"planet":"Jupiter"}'];

    await generateObject({
      provider: 'openai',
      model: MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      schema: Planet,
      prompt: 'x',
      fallbackProviders: [],
    });

    expect(posts()).toHaveLength(1);
    expect(posts()[0].path.endsWith('/chat/completions')).toBe(true);
    expect(posts()[0].body).not.toHaveProperty('store');
  });

  it('a validation retry carries store: false too', async () => {
    chatReplies = ['not json at all', '{"planet":"Jupiter"}'];

    const { object } = await generateObject({
      provider: 'openai',
      model: MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      schema: Planet,
      prompt: 'x',
      maxRetries: 1,
      store: false,
      fallbackProviders: [],
    });

    expect(object).toEqual({ planet: 'Jupiter' });
    expect(posts()).toHaveLength(2);
    for (const request of posts()) expect(request.body.store).toBe(false);
  });
});

describe('generateText sends store to OpenAI', () => {
  it('store: false reaches the chat completion as store: false', async () => {
    chatReplies = ['Jupiter'];

    const result = await generateText({
      provider: 'openai',
      model: MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'x',
      store: false,
      fallbackProviders: [],
    });

    expect(result.text).toBe('Jupiter');
    expect(posts()).toHaveLength(1);
    expect(posts()[0].path.endsWith('/chat/completions')).toBe(true);
    expect(posts()[0].body.store).toBe(false);
  });

  it('a GPT-6 tool call goes to Responses with store: true when the call sets it, and store: false when it does not', async () => {
    const withStore = await generateText({
      provider: 'openai',
      model: MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'Ping with x="ok".',
      tools: pingTool,
      store: true,
      fallbackProviders: [],
    });
    const without = await generateText({
      provider: 'openai',
      model: MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'Ping with x="ok".',
      tools: pingTool,
      fallbackProviders: [],
    });

    expect(withStore.text).toBe('pong');
    expect(without.text).toBe('pong');
    expect(posts().map((p) => p.path)).toEqual(['/v1/responses', '/v1/responses']);
    expect(posts()[0].body.store).toBe(true);
    expect(posts()[1].body.store).toBe(false);
  });

  it("the planning request carries the call's store: false as the turn's request does", async () => {
    chatReplies = ['{"steps":[{"description":"Answer.","tool":null,"reasoning":"No tool is needed."}]}', 'Jupiter'];

    const result = await generateText({
      provider: 'openai',
      model: MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'x',
      planning: true,
      store: false,
      fallbackProviders: [],
    });

    expect(result.text).toBe('Jupiter');
    expect(posts()).toHaveLength(2);
    for (const request of posts()) {
      expect(request.path.endsWith('/chat/completions')).toBe(true);
      expect(request.body.store).toBe(false);
    }
  });
});

describe('streamText sends store to OpenAI', () => {
  it('store: false reaches the streamed chat completion as store: false', async () => {
    chatReplies = ['Jupiter'];

    const result = streamText({
      provider: 'openai',
      model: MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'x',
      store: false,
      fallbackProviders: [],
    });

    expect(await drain(result.textStream)).toBe('Jupiter');
    expect(posts()).toHaveLength(1);
    expect(posts()[0].path.endsWith('/chat/completions')).toBe(true);
    expect(posts()[0].body.stream).toBe(true);
    expect(posts()[0].body.store).toBe(false);
  });

  it('a streamed GPT-6 tool call goes to Responses with store: true when the call sets it', async () => {
    const result = streamText({
      provider: 'openai',
      model: MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'Ping with x="ok".',
      tools: pingTool,
      store: true,
      fallbackProviders: [],
    });

    expect(await drain(result.textStream)).toBe('pong');
    expect(posts().map((p) => p.path)).toEqual(['/v1/responses']);
    expect(posts()[0].body.stream).toBe(true);
    expect(posts()[0].body.store).toBe(true);
  });

  it("the planning request carries the call's store: false as the streamed turn's request does", async () => {
    chatReplies = ['{"steps":[{"description":"Answer.","tool":null,"reasoning":"No tool is needed."}]}', 'Jupiter'];

    const result = streamText({
      provider: 'openai',
      model: MODEL,
      apiKey: 'test',
      baseUrl: baseUrl(),
      prompt: 'x',
      planning: true,
      store: false,
      fallbackProviders: [],
    });

    expect(await drain(result.textStream)).toBe('Jupiter');
    expect(posts()).toHaveLength(2);
    for (const request of posts()) {
      expect(request.path.endsWith('/chat/completions')).toBe(true);
      expect(request.body.store).toBe(false);
    }
  });
});
