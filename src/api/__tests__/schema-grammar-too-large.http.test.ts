/**
 * @file schema-grammar-too-large.http.test.ts
 * Anthropic's JSON output format compiles the request's schema into a grammar
 * and answers a schema whose grammar is too large with HTTP 400:
 *
 *   "The compiled grammar is too large, which would cause performance issues.
 *    Simplify your tool schemas or reduce the number of strict tools."
 *
 * Every attempt of a generateObject call then failed the same way, since a 400
 * is not retried, so a schema with many nested objects and enums (a race track
 * layout, an arena layout) could not be generated on any Claude model, directly
 * or through OpenRouter, whose Claude endpoints forward a strict `json_schema`
 * to the same format.
 *
 * Now the provider sends that request once more without the format (Anthropic:
 * the schema in the system prompt, as generateObject writes it; OpenRouter:
 * JSON-object mode), remembers the refusal for the process by schema and
 * model, and writes one log line. Any other 400 fails as before.
 *
 * A local server answers as Anthropic's Messages API and OpenRouter's API do;
 * every request outside it fails the case. Drives generateObject through the
 * real resolver, provider manager and providers, and each provider's own
 * generate and stream paths.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { generateObject } from '../generateObject.js';
import { shutdownProviderManagers } from '../model.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import { setLogger, resetLoggerFactory } from '../../core/logging/loggerFactory.js';
import { AnthropicProvider } from '../../core/llm/providers/implementations/AnthropicProvider.js';
import { OpenRouterProvider } from '../../core/llm/providers/implementations/OpenRouterProvider.js';
import { buildResponseFormat } from '../../core/llm/providers/structuredOutputFormat.js';
import { resetSchemaFormatRefusals } from '../../core/llm/providers/schema-format-refusals.js';

const ANTHROPIC_KEY = 'sk-ant-grammar-0001';
const OPENROUTER_KEY = 'sk-or-grammar-0001';
const CLAUDE = 'claude-sonnet-5-5';
const OTHER_CLAUDE = 'claude-haiku-5-5';
const CLAUDE_SLUG = 'anthropic/claude-haiku-4.5';
/** The line generateObject's schema instructions carry in the system prompt. */
const SCHEMA_LINE = 'The JSON MUST conform to this JSON Schema:';
/** The block the provider's own prompt route adds; a request that states the schema already gets no second copy. */
const PROVIDER_SCHEMA_BLOCK = 'Answer with JSON only, matching this schema';
const GRAMMAR_MESSAGE =
  'The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.';
const PROMPT = 'Lay out a short beach circuit.';

interface Received {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

const received: Received[] = [];
const unexpected: string[] = [];
const outside: string[] = [];
const logged: Record<string, unknown>[] = [];

/**
 * How the server answers a request that carries the layout schema in its format. OpenRouter answers a Claude
 * endpoint's refusal with HTTP 400, streamed or not, its message "Provider returned error" and Anthropic's own body
 * as `metadata.raw` (read from a live refused call on 2026-11-19).
 */
let refusal: { status: number; message: string; openRouterRaw?: boolean } = { status: 400, message: GRAMMAR_MESSAGE };
/** The JSON the model writes. */
let answer = '{}';

let server: http.Server;
let origin: string;
const realFetch = globalThis.fetch;

/** A completed text reply in the Messages API's SSE event order. */
function anthropicStream(text: string, model: string): string {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_grammar', type: 'message', role: 'assistant', content: [], model,
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } },
    { type: 'message_stop' },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
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
        sendJson(res, 200, { data: [], has_more: false, first_id: null, last_id: null });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        // The layout schema (it has `checkpoints`) is the one whose grammar is refused.
        const format = (body.output_config as { format?: unknown } | undefined)?.format;
        if (format !== undefined && JSON.stringify(format).includes('checkpoints')) {
          sendJson(res, refusal.status, { type: 'error', error: { type: 'invalid_request_error', message: refusal.message } });
          return;
        }
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(anthropicStream(answer, String(body.model)));
          return;
        }
        sendJson(res, 200, {
          id: 'msg_grammar', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: answer }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 40, output_tokens: 30 },
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/models') {
        sendJson(res, 200, {
          data: [CLAUDE_SLUG].map((id) => ({
            id, name: id, context_length: 200000,
            pricing: { prompt: '0.000001', completion: '0.000005' },
            architecture: { modality: 'text->text' },
          })),
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/chat/completions') {
        const format = body.response_format as { type?: string } | undefined;
        if (format?.type === 'json_schema' && JSON.stringify(format).includes('checkpoints')) {
          const upstream = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: refusal.message } });
          sendJson(
            res,
            refusal.status,
            refusal.openRouterRaw
              ? { error: { code: refusal.status, message: 'Provider returned error', metadata: { raw: upstream, provider_name: 'Anthropic' } } }
              : { error: { code: refusal.status, message: refusal.message } },
          );
          return;
        }
        if (body.stream === true) {
          const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
            `data: ${JSON.stringify({ id: 'gen-grammar', object: 'chat.completion.chunk', created: 1, model: body.model, choices, ...extra })}\n\n`;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            chunk([{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }]) +
              chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) +
              chunk([], { usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 } }) +
              'data: [DONE]\n\n',
          );
          return;
        }
        sendJson(res, 200, {
          id: 'gen-grammar', object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 },
        });
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
  logged.length = 0;
  refusal = { status: 400, message: GRAMMAR_MESSAGE };
  resetSchemaFormatRefusals();
  globalLLMProviderHealth.reset();
  vi.stubEnv('ANTHROPIC_API_KEY', ANTHROPIC_KEY);
  vi.stubEnv('ANTHROPIC_BASE_URL', origin);
  vi.stubEnv('OPENROUTER_API_KEY', OPENROUTER_KEY);
  vi.stubEnv('OPENROUTER_BASE_URL', `${origin}/api/v1`);
  for (const name of ['OPENAI_API_KEY', 'AGENTOS_USAGE_LEDGER_PATH', 'WUNDERLAND_USAGE_LEDGER_PATH']) vi.stubEnv(name, '');
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
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
  resetLoggerFactory();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(unexpected).toEqual([]);
  expect(outside).toEqual([]);
});

/** A layout with nested objects and enums: the shape of schema whose grammar the format refuses. */
const Layout = z.object({
  name: z.string(),
  laps: z.number().int(),
  weather: z.enum(['clear', 'rain', 'fog']),
  checkpoints: z.array(z.object({ x: z.number(), z: z.number(), banked: z.boolean() })),
  rivals: z.array(z.object({ name: z.string(), skill: z.enum(['easy', 'medium', 'hard']) })),
});
const LAYOUT = {
  name: 'Sunset Loop',
  laps: 2,
  weather: 'clear',
  checkpoints: [{ x: 0, z: 0, banked: false }, { x: 40, z: 12, banked: true }],
  rivals: [{ name: 'Mara', skill: 'hard' }],
};

const posts = (path: string): Record<string, unknown>[] =>
  received.filter((r) => r.method === 'POST' && r.path === path).map((r) => r.body);
const messagesPosts = (): Record<string, unknown>[] => posts('/v1/messages');
const completionsPosts = (): Record<string, unknown>[] => posts('/api/v1/chat/completions');
const formatOf = (body: Record<string, unknown>): unknown => (body.output_config as { format?: unknown } | undefined)?.format;
const refusalLines = (): Record<string, unknown>[] => logged.filter((line) => line.event === 'llm.schema_format_refused');

/** The text of a Messages request's system prompt, a string or a block array. */
function systemText(body: Record<string, unknown>): string {
  const system = body.system;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((block) => (block as { text?: string }).text ?? '').join('\n');
  return '';
}

/** The number of times `needle` occurs in `text`. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** A Messages request without its output format: the rest of `output_config` stays, and an empty one goes. */
function withoutFormat(body: Record<string, unknown>): Record<string, unknown> {
  const { output_config: outputConfig, ...rest } = body;
  const { format: _format, ...keptConfig } = (outputConfig ?? {}) as Record<string, unknown>;
  return Object.keys(keptConfig).length > 0 ? { ...rest, output_config: keptConfig } : rest;
}

const layoutCall = (model: string, extra: Record<string, unknown> = {}) =>
  generateObject({
    provider: 'anthropic',
    model,
    apiKey: ANTHROPIC_KEY,
    baseUrl: origin,
    fallbackProviders: [],
    schema: Layout,
    schemaName: 'RaceTrackLayout',
    prompt: PROMPT,
    thinking: false,
    maxRetries: 0,
    ...extra,
  });

/** A strict tool a direct caller sends beside the schema; the vendor counts it toward the same grammar. */
const STRICT_LOOKUP = {
  name: 'lookup',
  description: 'Look a place up.',
  strict: true,
  input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
};

describe('Anthropic: a schema the JSON output format refuses as too large', () => {
  it('is sent once more on the prompt route, and generateObject returns the validated object', async () => {
    answer = JSON.stringify(LAYOUT);

    const result = await layoutCall(CLAUDE);

    expect(result.object).toEqual(LAYOUT);
    const [refused, retried] = messagesPosts();
    expect(messagesPosts()).toHaveLength(2);
    expect((refused.output_config as { format?: { type?: string } }).format?.type).toBe('json_schema');
    // The re-sent request is the refused one without the format: no schema tool, the rest unchanged.
    expect(retried).toEqual(withoutFormat(refused));
    expect(retried.tools).toBeUndefined();
    expect(retried.tool_choice).toBeUndefined();
    // The schema rides the system prompt once, in generateObject's words.
    const system = systemText(retried);
    expect(occurrences(system, SCHEMA_LINE)).toBe(1);
    expect(system).toContain('"checkpoints"');
    expect(system).not.toContain(PROVIDER_SCHEMA_BLOCK);
  });

  it('remembers the refusal by schema and model: the next call goes straight to the prompt route', async () => {
    answer = JSON.stringify(LAYOUT);

    await layoutCall(CLAUDE);
    received.length = 0;
    const second = await layoutCall(CLAUDE);

    expect(second.object).toEqual(LAYOUT);
    expect(messagesPosts()).toHaveLength(1);
    expect(formatOf(messagesPosts()[0])).toBeUndefined();

    // Another model has not refused it: it is sent the format, and falls back on its own refusal.
    received.length = 0;
    await layoutCall(OTHER_CLAUDE);
    expect(messagesPosts()).toHaveLength(2);
    expect(formatOf(messagesPosts()[0])).toBeDefined();

    // Another schema on the refused model is sent the format, and the format carries it.
    received.length = 0;
    answer = '{"name":"Loop"}';
    const small = await generateObject({
      provider: 'anthropic', model: CLAUDE, apiKey: ANTHROPIC_KEY, baseUrl: origin, fallbackProviders: [],
      schema: z.object({ name: z.string() }), schemaName: 'Small', prompt: PROMPT, thinking: false, maxRetries: 0,
    });
    expect(small.object).toEqual({ name: 'Loop' });
    expect(messagesPosts()).toHaveLength(1);
    expect(formatOf(messagesPosts()[0])).toBeDefined();
  });

  it('writes one log line per refusal, naming the model, the schema and the reason, and nothing of the prompt or the key', async () => {
    answer = JSON.stringify(LAYOUT);

    await layoutCall(CLAUDE);
    await layoutCall(CLAUDE);

    expect(refusalLines()).toEqual([
      expect.objectContaining({ provider: 'anthropic', model: CLAUDE, schema: 'RaceTrackLayout', reason: 'grammar_too_large' }),
    ]);
    const text = JSON.stringify(logged);
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain(ANTHROPIC_KEY);
    // No second line on the console for the same downgrade.
    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => String(call[0]));
    expect(warned.filter((line) => line.includes('rides the prompt alone'))).toEqual([]);
  });

  it('keeps the re-send inside the call\'s maxAttempts, and still remembers the refusal', async () => {
    answer = JSON.stringify(LAYOUT);

    await expect(layoutCall(CLAUDE, { maxAttempts: 1 })).rejects.toThrow(/compiled grammar is too large/);
    expect(messagesPosts()).toHaveLength(1);
    expect(refusalLines()).toHaveLength(1);

    received.length = 0;
    const next = await layoutCall(CLAUDE, { maxAttempts: 1 });
    expect(next.object).toEqual(LAYOUT);
    expect(messagesPosts()).toHaveLength(1);
    expect(formatOf(messagesPosts()[0])).toBeUndefined();
  });

  it('shares the remembered refusal between schemas whose wire copy is the same', async () => {
    answer = JSON.stringify({ ...LAYOUT, checkpoints: [...LAYOUT.checkpoints, { x: 80, z: 0, banked: false }] });
    const checkpoint = z.object({ x: z.number(), z: z.number(), banked: z.boolean() });

    await layoutCall(CLAUDE, { schema: Layout.extend({ checkpoints: z.array(checkpoint).min(2) }) });
    expect(messagesPosts()).toHaveLength(2);

    // `minItems` above 1 is left out of the format's copy, so this schema is sent the same format: no second refusal.
    received.length = 0;
    await layoutCall(CLAUDE, { schema: Layout.extend({ checkpoints: z.array(checkpoint).min(3) }) });
    expect(messagesPosts()).toHaveLength(1);
    expect(formatOf(messagesPosts()[0])).toBeUndefined();
  });

  it('drops a passthrough output format on the re-send and keeps the rest of output_config', async () => {
    answer = JSON.stringify(LAYOUT);

    const result = await layoutCall(CLAUDE, {
      customModelParams: { output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } } },
    });

    expect(result.object).toEqual(LAYOUT);
    const [, retried] = messagesPosts();
    expect(messagesPosts()).toHaveLength(2);
    expect(formatOf(retried)).toBeUndefined();
    expect((retried.output_config as { effort?: string }).effort).toBe('low');
  });

  it('remembers a refusal with strict tools beside the schema apart from the schema alone', async () => {
    answer = JSON.stringify(LAYOUT);

    await layoutCall(CLAUDE, { customModelParams: { tools: [STRICT_LOOKUP] } });
    expect(messagesPosts()).toHaveLength(2);

    // The same schema without the strict tool is another request: it still goes on the format first.
    received.length = 0;
    await layoutCall(CLAUDE);
    expect(messagesPosts()).toHaveLength(2);
    expect(formatOf(messagesPosts()[0])).toBeDefined();
  });

  it('keeps any other 400 as it was: no second request, the error reaches the caller', async () => {
    refusal = {
      status: 400,
      message: "output_config.format.schema: For 'array' type, 'minItems' values other than 0 or 1 are not supported",
    };

    await expect(layoutCall(CLAUDE)).rejects.toThrow();

    expect(messagesPosts()).toHaveLength(1);
    expect(refusalLines()).toEqual([]);
  });

  it('falls back on the provider stream path and the single-shot path too', async () => {
    answer = JSON.stringify(LAYOUT);
    const responseFormat = buildResponseFormat({ provider: 'anthropic', modelId: CLAUDE, schema: Layout, schemaName: 'RaceTrackLayout' });

    const streaming = new AnthropicProvider();
    await streaming.initialize({ apiKey: ANTHROPIC_KEY, baseURL: origin });
    let text = '';
    let last: { schemaRoute?: string; schemaInPayload?: boolean } = {};
    for await (const chunk of streaming.generateCompletionStream(CLAUDE, [{ role: 'user', content: PROMPT }], {
      responseFormat, maxTokens: 2000, thinking: false,
    } as never)) {
      text += chunk.responseTextDelta ?? '';
      last = chunk;
    }
    expect(JSON.parse(text)).toEqual(LAYOUT);
    expect(last.schemaRoute).toBe('none');
    expect(last.schemaInPayload).toBe(false);
    expect(messagesPosts()).toHaveLength(2);
    expect(withoutFormat(messagesPosts()[0])).toEqual({
      ...messagesPosts()[1],
      // The provider's own prompt route adds its schema block when no caller states the schema.
      system: messagesPosts()[0].system,
    });
    expect(systemText(messagesPosts()[1])).toContain(PROVIDER_SCHEMA_BLOCK);

    resetSchemaFormatRefusals();
    received.length = 0;
    const single = new AnthropicProvider();
    await single.initialize({ apiKey: ANTHROPIC_KEY, baseURL: origin, streamCompletions: false });
    const response = await single.generateCompletion(CLAUDE, [{ role: 'user', content: PROMPT }], {
      responseFormat, maxTokens: 2000, thinking: false,
    } as never);
    expect(JSON.parse(String(response.choices[0]?.message?.content ?? ''))).toEqual(LAYOUT);
    expect(messagesPosts()).toHaveLength(2);
    expect(formatOf(messagesPosts()[1])).toBeUndefined();
  });
});

describe('OpenRouter: a Claude model refuses the strict json_schema as too large', () => {
  const openRouterCall = () =>
    generateObject({
      provider: 'openrouter',
      model: CLAUDE_SLUG,
      fallbackProviders: [],
      schema: Layout,
      schemaName: 'RaceTrackLayout',
      prompt: PROMPT,
      maxRetries: 0,
    });

  it('is sent once more as json_object, with the schema in its system prompt, and remembered', async () => {
    answer = JSON.stringify(LAYOUT);
    refusal = { status: 400, message: GRAMMAR_MESSAGE, openRouterRaw: true };

    const result = await openRouterCall();

    expect(result.object).toEqual(LAYOUT);
    const [refused, retried] = completionsPosts();
    expect(completionsPosts()).toHaveLength(2);
    expect((refused.response_format as { type?: string }).type).toBe('json_schema');
    expect(retried.response_format).toEqual({ type: 'json_object' });
    const system = (retried.messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === 'system');
    expect(occurrences(JSON.stringify(system), SCHEMA_LINE)).toBe(1);

    received.length = 0;
    await openRouterCall();
    expect(completionsPosts()).toHaveLength(1);
    expect(completionsPosts()[0].response_format).toEqual({ type: 'json_object' });

    expect(refusalLines()).toEqual([
      expect.objectContaining({ provider: 'openrouter', model: CLAUDE_SLUG, schema: 'RaceTrackLayout', reason: 'grammar_too_large' }),
    ]);
    expect(logged.filter((line) => line.event === 'llm.format_fallback')).toEqual([]);
    expect(JSON.stringify(logged)).not.toContain(OPENROUTER_KEY);
  });

  it('reads the refusal from the message as well, on the stream path too', async () => {
    answer = JSON.stringify(LAYOUT);
    const responseFormat = buildResponseFormat({ provider: 'openai', schema: Layout, schemaName: 'RaceTrackLayout' });

    const provider = new OpenRouterProvider();
    await provider.initialize({ apiKey: OPENROUTER_KEY, baseURL: `${origin}/api/v1` });
    let text = '';
    for await (const chunk of provider.generateCompletionStream(CLAUDE_SLUG, [{ role: 'user', content: PROMPT }], {
      responseFormat,
    } as never)) {
      text += chunk.responseTextDelta ?? '';
    }

    expect(JSON.parse(text)).toEqual(LAYOUT);
    expect(completionsPosts().map((body) => (body.response_format as { type?: string }).type)).toEqual(['json_schema', 'json_object']);
    expect(refusalLines()).toHaveLength(1);
  });

  it('keeps any other 400 as it was', async () => {
    refusal = { status: 400, message: 'Invalid schema for response_format' };

    await expect(openRouterCall()).rejects.toThrow();

    expect(completionsPosts()).toHaveLength(1);
    expect(refusalLines()).toEqual([]);
  });
});
