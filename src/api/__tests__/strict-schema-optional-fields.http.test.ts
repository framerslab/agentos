/**
 * @file strict-schema-optional-fields.http.test.ts
 * A structured call whose payload is OpenAI's strict json_schema (sent to
 * OpenAI, or to OpenRouter, which forwards it) is sent every optional property
 * of the caller's schema as required and nullable, since strict mode takes no
 * optional property, and the `null` the model writes for one it leaves out is
 * dropped before the caller's schema checks the reply. Before, the strict
 * payload required each optional property as written, so a model under
 * constrained decoding wrote `""` under a `.min(1)` or `0` under a `.min(5)`,
 * and the reply failed the caller's own schema.
 *
 * The case that matters most is a fallback leg: a primary that answers 503 is
 * followed by a leg whose payload is rebuilt for its own provider. A local
 * server answers as OpenRouter's API does (`GET /models`,
 * `POST /chat/completions`); every request outside it fails the case. Drives
 * generateObject and agent().session().send() through the real resolver,
 * provider manager and OpenRouterProvider.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { agent } from '../agent.js';
import { generateObject } from '../generateObject.js';
import { shutdownProviderManagers } from '../model.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

/** The model of the strict leg. */
const LEG_MODEL = 'openai/gpt-4o-mini';
/** The OpenRouter slug an Anthropic call with no Anthropic key is sent as; the server answers it 503. */
const OVERLOADED_MODEL = 'anthropic/claude-sonnet-4-5';

interface Received {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

const received: Received[] = [];
const unexpected: string[] = [];
const outside: string[] = [];
/** The text the strict leg answers with. */
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
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      received.push({ method: req.method ?? '', path: url.pathname, body });
      if (req.method === 'GET' && url.pathname === '/api/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [LEG_MODEL, OVERLOADED_MODEL].map((id) => ({
              id,
              name: id,
              context_length: 128000,
              pricing: { prompt: '0.0000001', completion: '0.0000003' },
              architecture: { modality: 'text->text' },
            })),
          }),
        );
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/chat/completions') {
        if (body.model === OVERLOADED_MODEL) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end('{"error":{"code":503,"message":"overloaded"}}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'gen-strict',
            object: 'chat.completion',
            created: 1,
            model: typeof body.model === 'string' ? body.model : LEG_MODEL,
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
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-strict-0001');
  vi.stubEnv('OPENROUTER_BASE_URL', `${origin}/api/v1`);
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'AGENTOS_USAGE_LEDGER_PATH', 'WUNDERLAND_USAGE_LEDGER_PATH']) {
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

/** A scene of frames whose media, timing and transition are optional, each with a bound a placeholder fails. */
const Frame = z.object({
  text: z.string().min(1),
  speaker: z.string().min(1).optional(),
  imageUrl: z.string().min(1).optional(),
  clipDurationSec: z.number().min(5).optional(),
  transition: z.object({ kind: z.enum(['cut', 'fade']), durationMs: z.number().min(150) }).optional(),
});
const Scene = z.object({
  id: z.string(),
  frames: z.array(Frame).min(1),
  note: z.string().nullable().optional(),
});

/** What a strict leg writes: every property, `null` for the optional ones it leaves out. */
const STRICT_REPLY = JSON.stringify({
  id: 's1',
  note: null,
  frames: [
    { text: 'The gate opens.', speaker: null, imageUrl: null, clipDurationSec: null, transition: null },
    { text: 'Go.', speaker: 'Ana', imageUrl: null, clipDurationSec: null, transition: { kind: 'fade', durationMs: 300 } },
  ],
});
const EXPECTED_OBJECT = {
  id: 's1',
  note: null,
  frames: [{ text: 'The gate opens.' }, { text: 'Go.', speaker: 'Ana', transition: { kind: 'fade', durationMs: 300 } }],
};

const completions = (): Array<Record<string, unknown>> =>
  received.filter((r) => r.path === '/api/v1/chat/completions').map((r) => r.body);

/** The strict schema a request carried, after checking the payload is strict json_schema. */
function strictSchemaOf(body: Record<string, unknown>): any {
  const format = body.response_format as { type?: string; json_schema?: { strict?: boolean; schema?: unknown } } | undefined;
  expect(format?.type).toBe('json_schema');
  expect(format?.json_schema?.strict).toBe(true);
  return format?.json_schema?.schema;
}

/** The optional properties of the schema are required and nullable; the required ones are as written. */
function expectOptionalFieldsNullable(schema: any): void {
  expect(schema.required).toEqual(['id', 'frames', 'note']);
  expect(schema.properties.note).toEqual({ type: ['string', 'null'] });
  const frame = schema.properties.frames.items;
  expect(frame.required).toEqual(['text', 'speaker', 'imageUrl', 'clipDurationSec', 'transition']);
  expect(frame.properties.text).toEqual({ type: 'string' });
  expect(frame.properties.speaker).toEqual({ type: ['string', 'null'] });
  expect(frame.properties.imageUrl).toEqual({ type: ['string', 'null'] });
  expect(frame.properties.clipDurationSec).toEqual({ type: ['number', 'null'] });
  expect(frame.properties.transition.anyOf).toEqual([
    {
      type: 'object',
      properties: { kind: { enum: ['cut', 'fade'] }, durationMs: { type: 'number' } },
      required: ['kind', 'durationMs'],
      additionalProperties: false,
    },
    { type: 'null' },
  ]);
}

describe('a structured call whose payload is strict json_schema', () => {
  it('on a fallback leg after a primary that answers 503: the leg is sent the optional fields nullable, and its nulls validate', async () => {
    answerText = STRICT_REPLY;

    const result = await generateObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      fallbackProviders: [{ provider: 'openrouter', model: LEG_MODEL }],
      schema: Scene,
      schemaName: 'scene',
      prompt: 'Write the scene.',
      maxAttempts: 1,
      maxRetries: 0,
    });

    expect(result.object).toEqual(EXPECTED_OBJECT);
    expect(result.fallback?.fired).toBe(true);
    const sent = completions();
    expect(sent.map((b) => b.model)).toEqual([OVERLOADED_MODEL, LEG_MODEL]);
    expectOptionalFieldsNullable(strictSchemaOf(sent[1]));
  });

  it('on the primary: generateObject sends the optional fields nullable and reads their nulls as absent', async () => {
    answerText = STRICT_REPLY;

    const result = await generateObject({
      provider: 'openrouter',
      model: LEG_MODEL,
      fallbackProviders: [],
      schema: Scene,
      schemaName: 'scene',
      prompt: 'Write the scene.',
      maxRetries: 0,
    });

    expect(result.object).toEqual(EXPECTED_OBJECT);
    const sent = completions();
    expect(sent).toHaveLength(1);
    expectOptionalFieldsNullable(strictSchemaOf(sent[0]));
  });

  it('on session.send: the optional fields go nullable and their nulls validate', async () => {
    answerText = STRICT_REPLY;

    const a = agent({ provider: 'openrouter', model: LEG_MODEL, memory: false, fallbackProviders: [] });
    let object: unknown;
    try {
      const result = await a.session().send('Write the scene.', { responseSchema: Scene, schemaName: 'scene' });
      object = (result as { object?: unknown }).object;
    } finally {
      await a.close();
    }

    expect(object).toEqual(EXPECTED_OBJECT);
    const sent = completions();
    expect(sent).toHaveLength(1);
    expectOptionalFieldsNullable(strictSchemaOf(sent[0]));
  });
});
