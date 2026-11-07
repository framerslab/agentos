/**
 * @file router-moved-structured-output.http.test.ts
 * A structured `session.send()` that the agent's model router moves to another
 * provider is sent the structured-output payload of the provider and model the
 * router picked, as a fallback leg is, and the schema in its system prompt when
 * that payload carries none. The agent's own provider is Anthropic, whose
 * marker OpenRouter's request builder never forwards, so a routed send that
 * kept it would reach OpenRouter with no schema at all.
 *
 * A local server answers as OpenRouter's API does
 * (https://openrouter.ai/docs/api/reference/overview): `GET /models` and
 * `POST /chat/completions`. Every request outside it fails the case. Drives
 * agent().session().send() through the real resolver, provider manager and
 * OpenRouterProvider.
 *
 * An Anthropic call with no Anthropic key, which the resolver sends to
 * OpenRouter, goes to the OpenRouter base URL a call that names OpenRouter
 * goes to (a global default's for OpenRouter, else the environment's), and a
 * structured send there is sent OpenRouter's payload.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { agent } from '../agent.js';
import { generateText } from '../generateText.js';
import { shutdownProviderManagers } from '../model.js';
import { clearDefaultProvider, setDefaultProvider } from '../runtime/global-default.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

/** The OpenRouter model the router sends every call to. */
const ROUTED_MODEL = 'meta-llama/llama-3.3-70b-instruct';
/** The OpenRouter slug an Anthropic call with no Anthropic key is sent as. */
const REMAPPED_MODEL = 'anthropic/claude-sonnet-4-5';
/** The line the schema instructions carry when the schema rides the system prompt. */
const SCHEMA_LINE = 'The JSON MUST conform to this JSON Schema:';

interface Received {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

/** Every request the server received in the current case, in order. */
const received: Received[] = [];
/** The requests no route answered. */
const unexpected: string[] = [];
/** The URLs a call tried outside the server. */
const outside: string[] = [];
/** The text the next chat completion answers with. */
let answerText = '{}';

let server: http.Server;
let origin: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', origin);
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: req.method ?? '',
        path: url.pathname,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      if (req.method === 'GET' && url.pathname === '/api/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: ROUTED_MODEL,
                name: 'Llama 3.3 70B Instruct',
                context_length: 131072,
                pricing: { prompt: '0.0000001', completion: '0.0000003' },
                architecture: { modality: 'text->text' },
              },
              {
                id: REMAPPED_MODEL,
                name: 'Claude Sonnet 4.5',
                context_length: 200000,
                pricing: { prompt: '0.000003', completion: '0.000015' },
                architecture: { modality: 'text->text' },
              },
            ],
          }),
        );
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'gen-routed',
            object: 'chat.completion',
            created: 1,
            model: typeof received[received.length - 1].body.model === 'string' ? received[received.length - 1].body.model : ROUTED_MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: answerText }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          }),
        );
        return;
      }
      unexpected.push(`${req.method} ${url.pathname}`);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"code":404,"message":"no such route in this case"}}');
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
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-routed-0001');
  vi.stubEnv('OPENROUTER_BASE_URL', `${origin}/api/v1`);
  // The router moves every call, so the agent's own provider is never reached,
  // and the usage ledger records nothing.
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'AGENTOS_USAGE_LEDGER_PATH', 'WUNDERLAND_USAGE_LEDGER_PATH']) {
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

/** A model router that sends every call to {@link ROUTED_MODEL} on OpenRouter. */
const toOpenRouter = {
  routerId: 'to-openrouter',
  initialize: async () => undefined,
  selectModel: async () => ({ modelId: ROUTED_MODEL, modelInfo: { providerId: 'openrouter' } }),
} as never;

/** The bodies of the chat completions the server received. */
const completions = (): Array<Record<string, unknown>> =>
  received.filter((r) => r.path === '/api/v1/chat/completions').map((r) => r.body);

/** The text of a request body's system messages. */
function systemText(body: Record<string, unknown>): string {
  const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

/** A send on an Anthropic agent whose router moves every call to OpenRouter. */
async function routedSend<T extends z.ZodType>(schema: T, schemaName: string): Promise<unknown> {
  const a = agent({
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    router: toOpenRouter,
    memory: false,
    fallbackProviders: [],
  });
  try {
    const result = await a.session().send('Answer in the schema.', { responseSchema: schema, schemaName });
    return (result as { object?: unknown }).object;
  } finally {
    await a.close();
  }
}

describe('a structured send the model router moves from Anthropic to an OpenRouter model', () => {
  it("is sent OpenRouter's json_schema payload for a schema OpenAI's strict rules take", async () => {
    answerText = '{"title":"Routed"}';

    const object = await routedSend(z.object({ title: z.string() }), 'chapter');

    expect(object).toEqual({ title: 'Routed' });
    const sent = completions();
    expect(sent).toHaveLength(1);
    expect(sent[0].model).toBe(ROUTED_MODEL);
    expect(sent[0].response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'chapter',
        strict: true,
        schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      },
    });
    // OpenRouter sends a json_schema request only to a host that honours it.
    expect(sent[0].provider).toMatchObject({ require_parameters: true });
    // The payload carries the schema, so the system prompt does not repeat it.
    expect(systemText(sent[0])).not.toContain(SCHEMA_LINE);
  });

  it('is sent JSON-object mode and the schema in its system prompt for a schema the strict rules refuse', async () => {
    answerText = '{"palette":{"primary":"#aabbcc"}}';

    // A record lowers to a schema-valued additionalProperties, which OpenAI's
    // strict rules refuse, so OpenRouter is sent JSON-object mode.
    const object = await routedSend(z.object({ palette: z.record(z.string(), z.string()) }), 'palette');

    expect(object).toEqual({ palette: { primary: '#aabbcc' } });
    const sent = completions();
    expect(sent).toHaveLength(1);
    expect(sent[0].response_format).toEqual({ type: 'json_object' });
    // JSON-object mode carries no schema, so the system prompt does.
    expect(systemText(sent[0])).toContain(SCHEMA_LINE);
    expect(systemText(sent[0])).toContain('"palette"');
  });
});

describe('an Anthropic call with no Anthropic key, which the resolver sends to OpenRouter', () => {
  it('goes to the OpenRouter base URL the environment sets', async () => {
    answerText = 'remapped';

    const result = await generateText({ provider: 'anthropic', model: 'claude-sonnet-4-5', prompt: 'x', fallbackProviders: [] });

    expect(result.text).toBe('remapped');
    const sent = completions();
    expect(sent).toHaveLength(1);
    expect(sent[0].model).toBe(REMAPPED_MODEL);
  });

  it('goes to the base URL a global default that names OpenRouter sets, as a call that names OpenRouter does', async () => {
    answerText = 'remapped through the default';
    vi.stubEnv('OPENROUTER_BASE_URL', '');
    setDefaultProvider({ provider: 'openrouter', baseUrl: `${origin}/api/v1` });

    try {
      const result = await generateText({ provider: 'anthropic', model: 'claude-sonnet-4-5', prompt: 'x', fallbackProviders: [] });

      expect(result.text).toBe('remapped through the default');
      const sent = completions();
      expect(sent).toHaveLength(1);
      expect(sent[0].model).toBe(REMAPPED_MODEL);
    } finally {
      clearDefaultProvider();
    }
  });

  it("is sent OpenRouter's json_schema payload when it is a structured send", async () => {
    answerText = '{"title":"Remapped"}';

    const a = agent({ provider: 'anthropic', model: 'claude-sonnet-4-5', memory: false, fallbackProviders: [] });
    let object: unknown;
    try {
      const result = await a.session().send('Answer in the schema.', {
        responseSchema: z.object({ title: z.string() }),
        schemaName: 'chapter',
      });
      object = (result as { object?: unknown }).object;
    } finally {
      await a.close();
    }

    expect(object).toEqual({ title: 'Remapped' });
    const sent = completions();
    expect(sent).toHaveLength(1);
    expect(sent[0].model).toBe(REMAPPED_MODEL);
    expect(sent[0].response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'chapter',
        strict: true,
        schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      },
    });
    expect(systemText(sent[0])).not.toContain(SCHEMA_LINE);
  });
});
