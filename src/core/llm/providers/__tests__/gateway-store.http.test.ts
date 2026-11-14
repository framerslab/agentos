/**
 * @fileoverview `store` is OpenAI's field. The providers that send through the
 * OpenAI transport to their own OpenAI-compatible endpoint (Groq, xAI,
 * Together, Mistral, LiteLLM, MiniMax) leave it out of the request body, as
 * every other non-OpenAI provider does, so a call that sets `store` reaches an
 * endpoint that rejects fields outside its schema.
 *
 * Mistral is such an endpoint: its chat completion request schema lists no
 * `store` and sets `additionalProperties: false`
 * (https://docs.mistral.ai/openapi.yaml, `ChatCompletionRequest`, read
 * 2026-11-10), and its changelog entry of 11 January says "If you have
 * unsupported parameters in your request, you will see the error message
 * 'Extra inputs are not permitted'"
 * (https://docs.mistral.ai/getting-started/changelog, read 2026-11-10). The
 * local server here answers a body that carries `store` the same way, with a
 * 422, on every route but `/lenient`.
 *
 * A `store` key in `customModelParams` still reaches the endpoint: that is the
 * passthrough for a field an endpoint is known to take.
 *
 * No key and no network: every request outside the server fails the case.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateText } from '../../../../api/generateText.js';
import { shutdownProviderManagers } from '../../../../api/model.js';
import { globalLLMProviderHealth } from '../../../safety/LLMProviderHealthRegistry.js';
import type { ChatMessage, IProvider, ModelCompletionOptions, ModelCompletionResponse } from '../IProvider';
import { GroqProvider } from '../implementations/GroqProvider';
import { LiteLLMProvider } from '../implementations/LiteLLMProvider';
import { MiniMaxProvider } from '../implementations/MiniMaxProvider';
import { MistralProvider } from '../implementations/MistralProvider';
import { TogetherProvider } from '../implementations/TogetherProvider';
import { XAIProvider } from '../implementations/XAIProvider';

const USER: ChatMessage[] = [{ role: 'user', content: 'x' }];

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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function completion(model: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-gateway',
    object: 'chat.completion',
    created: 1700000000,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  };
}

function streamed(model: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-gateway',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return [chunk({ role: 'assistant', content: 'ok' }, null), chunk({}, 'stop'), 'data: [DONE]\n\n'].join('');
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
      if (req.method === 'GET' && url.pathname.endsWith('/v1/models')) {
        sendJson(res, 200, { object: 'list', data: [] });
        return;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/v1/chat/completions')) {
        const model = typeof body.model === 'string' ? body.model : 'unknown';
        if ('store' in body && !url.pathname.startsWith('/lenient/')) {
          // Mistral's answer to a field outside its schema.
          sendJson(res, 422, {
            object: 'error',
            message: { detail: [{ type: 'extra_forbidden', loc: ['body', 'store'], msg: 'Extra inputs are not permitted', input: body.store }] },
            type: 'invalid_request_error',
            param: null,
            code: null,
          });
          return;
        }
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(streamed(model));
          return;
        }
        sendJson(res, 200, completion(model));
        return;
      }
      unexpected.push(`${req.method} ${url.pathname}`);
      sendJson(res, 404, { error: { message: 'no such route in this case' } });
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
  globalLLMProviderHealth.reset();
  for (const name of [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENROUTER_API_KEY',
    'ANTHROPIC_API_KEY',
    'MISTRAL_API_KEY',
    'MISTRAL_BASE_URL',
    'AGENTOS_USAGE_LEDGER_PATH',
    'WUNDERLAND_USAGE_LEDGER_PATH',
  ]) {
    vi.stubEnv(name, '');
  }
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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

/** The one POST the call made. */
function soleRequest(): Received {
  const sent = received.filter((r) => r.method === 'POST');
  expect(sent).toHaveLength(1);
  return sent[0];
}

interface Gateway {
  name: string;
  model: string;
  make: () => IProvider;
}

const GATEWAYS: Gateway[] = [
  { name: 'groq', model: 'llama-3.3-70b-versatile', make: () => new GroqProvider() },
  { name: 'xai', model: 'grok-4', make: () => new XAIProvider() },
  { name: 'together', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', make: () => new TogetherProvider() },
  { name: 'mistral', model: 'mistral-large-latest', make: () => new MistralProvider() },
  { name: 'litellm', model: 'gpt-4o-mini', make: () => new LiteLLMProvider() },
  { name: 'minimax', model: 'MiniMax-M3', make: () => new MiniMaxProvider() },
];

async function gateway(g: Gateway, root = g.name): Promise<IProvider> {
  const p = g.make();
  await p.initialize({ apiKey: 'test', baseURL: `${origin}/${root}/v1` });
  return p;
}

const CASES = GATEWAYS.flatMap((g) => [false, true].map((store) => ({ ...g, store })));

describe('the providers built on the OpenAI transport send no store to their own endpoint', () => {
  it.each(CASES)('$name with store: $store: the completion succeeds and its body has no store key', async (c) => {
    const options: ModelCompletionOptions = { store: c.store };

    const response = await (await gateway(c)).generateCompletion(c.model, USER, options);

    expect(response.error).toBeUndefined();
    const request = soleRequest();
    expect(request.path).toBe(`/${c.name}/v1/chat/completions`);
    expect(request.body).not.toHaveProperty('store');
  });

  it.each(CASES)('$name with store: $store: the streamed completion succeeds and its body has no store key', async (c) => {
    const options: ModelCompletionOptions = { store: c.store };

    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of (await gateway(c)).generateCompletionStream(c.model, USER, options)) chunks.push(chunk);

    expect(chunks.filter((chunk) => chunk.error !== undefined)).toEqual([]);
    const request = soleRequest();
    expect(request.path).toBe(`/${c.name}/v1/chat/completions`);
    expect(request.body.stream).toBe(true);
    expect(request.body).not.toHaveProperty('store');
  });

  it.each(GATEWAYS)('$name: a store key in customModelParams still reaches the endpoint', async (g) => {
    const options: ModelCompletionOptions = { store: true, customModelParams: { store: false } };

    await (await gateway(g, 'lenient')).generateCompletion(g.model, USER, options);

    expect(soleRequest().body.store).toBe(false);
  });
});

describe('generateText', () => {
  it("generateText({ provider: 'mistral', store: false }) answers, and Mistral's request carries no store", async () => {
    const result = await generateText({
      provider: 'mistral',
      model: 'mistral-large-latest',
      apiKey: 'test',
      baseUrl: `${origin}/mistral/v1`,
      prompt: 'x',
      store: false,
      maxAttempts: 1,
      fallbackProviders: [],
    });

    expect(result.text).toBe('ok');
    const sent = received.filter((r) => r.method === 'POST');
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe('/mistral/v1/chat/completions');
    expect(sent[0].body).not.toHaveProperty('store');
  });
});
