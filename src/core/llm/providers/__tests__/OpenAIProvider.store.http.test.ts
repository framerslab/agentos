/**
 * @fileoverview OpenAIProvider sends a call's `store` option as `store` on the
 * request body, on `/v1/chat/completions` and `/v1/responses` alike, against a
 * local server that answers as OpenAI's API does. No key and no network: every
 * request outside the server fails the case.
 *
 * OpenAI's rule: "Responses are stored by default. Chat completions are stored
 * by default for new accounts. To disable storage when using either API, set
 * store: false."
 * (https://developers.openai.com/api/docs/guides/migrate-to-responses, read
 * 2026-11-10). Left out, a chat completion carries no `store` key, as before,
 * and a Responses request carries `store: false`, as before.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAIProvider } from '../implementations/OpenAIProvider';
import type { ChatMessage, ModelCompletionOptions } from '../IProvider';

const MODEL = 'gpt-6-luna';
const USER: ChatMessage[] = [{ role: 'user', content: 'x' }];
/** A function tool: a GPT-6 call that carries one goes to /v1/responses. */
const PING_TOOL: Array<Record<string, unknown>> = [
  {
    type: 'function',
    function: { name: 'ping', description: 'Ping.', parameters: { type: 'object', properties: {} } },
  },
];

interface Received {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

const received: Received[] = [];
const unexpected: string[] = [];
const outside: string[] = [];

let server: http.Server;
let origin: string;
const realFetch = globalThis.fetch;

function sendJson(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', origin);
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({ method: req.method ?? '', path: url.pathname, body: raw ? JSON.parse(raw) : {} });
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        sendJson(res, { object: 'list', data: [{ id: MODEL, object: 'model', created: 1, owned_by: 'openai' }] });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        sendJson(res, {
          id: 'chatcmpl-store',
          object: 'chat.completion',
          created: 1700000000,
          model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        sendJson(res, {
          id: 'resp_store',
          object: 'response',
          created_at: 1700000000,
          model: MODEL,
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg_1',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'ok', annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 5,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 6,
          },
        });
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

afterEach(() => {
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
  expect(outside).toEqual([]);
});

async function provider(): Promise<OpenAIProvider> {
  const p = new OpenAIProvider();
  await p.initialize({ apiKey: 'test', baseURL: `${origin}/v1`, maxRetries: 1 });
  return p;
}

/** The one POST the call made. */
function soleRequest(): Received {
  const sent = received.filter((r) => r.method === 'POST');
  expect(sent).toHaveLength(1);
  return sent[0];
}

describe('OpenAIProvider sends store on the request', () => {
  /** The call's options, with `store` only when the case sets it. */
  const withStore = (store: boolean | undefined, extra: ModelCompletionOptions = {}): ModelCompletionOptions => ({
    ...extra,
    ...(store === undefined ? {} : { store }),
  });

  it.each([
    { store: true, expected: true },
    { store: false, expected: false },
  ])('a chat completion with store: $store carries store: $expected', async ({ store, expected }) => {
    await (await provider()).generateCompletion(MODEL, USER, withStore(store));

    const request = soleRequest();
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.body.store).toBe(expected);
  });

  it('a chat completion without the option carries no store key', async () => {
    await (await provider()).generateCompletion(MODEL, USER, withStore(undefined));

    const request = soleRequest();
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.body).not.toHaveProperty('store');
  });

  it.each([
    { store: true, expected: true },
    { store: false, expected: false },
    { store: undefined, expected: false },
  ])('a Responses request with store: $store carries store: $expected', async ({ store, expected }) => {
    await (await provider()).generateCompletion(MODEL, USER, withStore(store, { tools: PING_TOOL }));

    const request = soleRequest();
    expect(request.path).toBe('/v1/responses');
    expect(request.body.store).toBe(expected);
  });
});
