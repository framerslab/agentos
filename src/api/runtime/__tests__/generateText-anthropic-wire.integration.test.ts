/**
 * @file generateText-anthropic-wire.integration.test.ts
 * generateText, streamText and generateObject against the real
 * AnthropicProvider, with only fetch stubbed. The stub answers per model, read
 * from each request body, so a fallback hop to a second Claude model gets its
 * own reply. The tests assert on what the public API returns and on the
 * request bodies the provider put on the wire.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { buildFallbackChain, generateText, isContentPolicyRefusal } from '../../generateText.js';
import { generateObject, ObjectGenerationError } from '../../generateObject.js';
import { streamObject } from '../../streamObject.js';
import { streamText, type StreamPart } from '../../streamText.js';
import { agent } from '../../agent.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

type Json = Record<string, any>;
type Reply = () => Response;

/** An SSE response carrying `events` in order. */
function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** The message_start event of a streamed reply from `model`. */
function messageStart(model: string, usage: Json): Json {
  return {
    type: 'message_start',
    message: {
      id: `msg_${model}`, type: 'message', role: 'assistant', content: [], model,
      stop_reason: null, stop_sequence: null, usage: { output_tokens: 1, ...usage },
    },
  };
}

/** A completed text reply from `model`. */
function textTurn(model: string, text: string, usage: Json = { input_tokens: 10 }, outputTokens = 3): Reply {
  return () =>
    sse([
      messageStart(model, usage),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens },
      },
      { type: 'message_stop' },
    ]);
}

/** A forced tool call to `name` with `input` from `model`, as the forced schema tool is answered. */
function toolTurn(model: string, name: string, input: Json): Reply {
  return () =>
    sse([
      messageStart(model, { input_tokens: 10 }),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]);
}

/** A forced tool call to `name` cut off by `max_tokens` while its input was still being written. */
function cutToolTurn(model: string, name: string, partialJson: string): Reply {
  return () =>
    sse([
      messageStart(model, { input_tokens: 10 }),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partialJson } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 16 } },
      { type: 'message_stop' },
    ]);
}

/** A forced tool call to `name` cut off by `max_tokens` before any of its input was written. */
function inputlessCutToolTurn(model: string, name: string): Reply {
  return () =>
    sse([
      messageStart(model, { input_tokens: 10 }),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]);
}

/** A reply cut off by `max_tokens` after writing `text`. */
function truncatedTurn(model: string, text: string): Reply {
  return () =>
    sse([
      messageStart(model, { input_tokens: 10 }),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]);
}

/**
 * A reply Claude refuses (`stop_reason: 'refusal'`), after writing
 * `partialText` when one is given.
 */
function refusalTurn(model: string, partialText = ''): Reply {
  return () =>
    sse([
      messageStart(model, { input_tokens: 12 }),
      ...(partialText
        ? [
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: partialText } },
            { type: 'content_block_stop', index: 0 },
          ]
        : []),
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'refusal',
          stop_sequence: null,
          stop_details: { type: 'refusal', category: 'example_category', explanation: 'Declined.' },
        },
        usage: { output_tokens: 4 },
      },
      { type: 'message_stop' },
    ]);
}

/**
 * Partial text a refusal cuts off. It holds a ReAct-style tool call that the
 * text tool-call parser would pick up if the partial text were kept as a turn.
 */
const PARTIAL_WITH_TOOL_CALL = 'Let me check.\nAction: get_weather\nInput: {"city":"Paris"}';

/** A weather tool whose executions the refusal tests count. */
function weatherTools() {
  const execute = vi.fn(async (args: { city: string }) => ({ city: args.city, temp_c: 18 }));
  return {
    execute,
    tools: {
      get_weather: {
        description: 'Current weather for a city.',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        execute,
      },
    },
  };
}

/** Awaits `promise` and returns what it rejected with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

/** Collects every part of a stream (streamText runs only while it is read). */
async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

/** Routes each POST to the next reply queued for the model its body names. */
function route(replies: Record<string, Reply[]>): void {
  fetchMock.mockImplementation(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Json;
    const next = replies[String(body.model)]?.shift();
    if (!next) throw new Error(`unexpected request for model ${String(body.model)}`);
    return next();
  });
}

/** Parsed body of every request, in call order. */
function postedBodies(): Json[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as { body?: unknown }).body)) as Json);
}

const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;

beforeAll(() => {
  // Fallback hops resolve their key from the environment.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-wire-test';
  // Without an Anthropic key the resolver reroutes to OpenRouter; keep it out.
  delete process.env.OPENROUTER_API_KEY;
});

afterAll(() => {
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
  if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
});

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

describe('Anthropic catalog and pricing through the public API', () => {
  it('generateObject on Claude Sonnet 5.5 sends the JSON output format, no forced tool, and parses the JSON reply', async () => {
    route({ 'claude-sonnet-5-5': [textTurn('claude-sonnet-5-5', '{"answer":"ok"}')] });

    const result = await generateObject({
      model: 'anthropic:claude-sonnet-5-5',
      schema: z.object({ answer: z.string() }),
      prompt: 'Answer with ok.',
      fallbackProviders: [],
    });

    expect(result.object).toEqual({ answer: 'ok' });
    const [body] = postedBodies();
    // Sonnet 5.5 has the JSON output format: the schema goes out as
    // output_config.format, with no tool and no tool_choice.
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['answer'] });
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });

  it('generateObject on Claude Opus 5.5 sends output_config.format with the stamped Zod schema and no tools, and parses the text answer', async () => {
    route({ 'claude-opus-5-5': [textTurn('claude-opus-5-5', '{"name":"Ada","tags":["a","b"]}')] });

    const result = await generateObject({
      model: 'anthropic:claude-opus-5-5',
      schema: z.object({ name: z.string(), tags: z.array(z.string()) }),
      schemaName: 'person',
      prompt: 'Describe Ada.',
      fallbackProviders: [],
    });

    expect(result.object).toEqual({ name: 'Ada', tags: ['a', 'b'] });
    const bodies = postedBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].output_config.format.type).toBe('json_schema');
    expect(bodies[0].output_config.format.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
    });
    expect(bodies[0].tools).toBeUndefined();
    expect(bodies[0].tool_choice).toBeUndefined();
  });

  it('generateObject on Claude Opus 5.5 escalates the output budget after a max_tokens stop and completes on the second attempt', async () => {
    route({
      'claude-opus-5-5': [
        truncatedTurn('claude-opus-5-5', '{"name":"Ada","ta'),
        textTurn('claude-opus-5-5', '{"name":"Ada","tags":["a"]}'),
      ],
    });

    const result = await generateObject({
      model: 'anthropic:claude-opus-5-5',
      schema: z.object({ name: z.string(), tags: z.array(z.string()) }),
      prompt: 'Describe Ada.',
      fallbackProviders: [],
    });

    expect(result.object).toEqual({ name: 'Ada', tags: ['a'] });
    const bodies = postedBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].max_tokens).toBeGreaterThan(bodies[0].max_tokens);
    expect(bodies[1].output_config.format.type).toBe('json_schema');
  });

  it('generateObject repairs an enum value that differs from the schema by case without spending a retry', async () => {
    route({ 'claude-opus-5-5': [textTurn('claude-opus-5-5', '{"answer":"Yes"}')] });

    const result = await generateObject({
      model: 'anthropic:claude-opus-5-5',
      schema: z.object({ answer: z.enum(['yes', 'no']) }),
      prompt: 'Yes or no?',
      fallbackProviders: [],
    });

    expect(result.object).toEqual({ answer: 'yes' });
    expect(postedBodies()).toHaveLength(1);
  });

  it('generateObject with a record schema on Claude Sonnet 4.6 sends one non-strict tool with a forced tool_choice and returns the tool call as the object', async () => {
    // A record is outside the JSON output format; Sonnet 4.6, the provider's
    // default text model, accepts a forced tool choice, so the non-strict
    // forced tool carries the schema, as it did before the format.
    route({ 'claude-sonnet-4-6': [toolTurn('claude-sonnet-4-6', 'scores', { scores: { a: 1, b: 2 } })] });

    const result = await generateObject({
      model: 'anthropic:claude-sonnet-4-6',
      schema: z.object({ scores: z.record(z.string(), z.number()) }),
      schemaName: 'scores',
      prompt: 'Score a and b.',
      fallbackProviders: [],
    });

    expect(result.object).toEqual({ scores: { a: 1, b: 2 } });
    // The forced schema call is the answer: generateText's tool loop never sees it as a missing tool.
    expect(result.finishReason).toBe('stop');
    const bodies = postedBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools).toHaveLength(1);
    expect(bodies[0].tools[0].name).toBe('scores');
    expect(bodies[0].tools[0].strict).toBeUndefined();
    expect(bodies[0].tools[0].input_schema.properties.scores).toMatchObject({ type: 'object' });
    expect(bodies[0].tool_choice).toEqual({ type: 'tool', name: 'scores' });
    expect(bodies[0].output_config?.format).toBeUndefined();
  });

  it('a session send with a record schema on Claude Sonnet 4.6 (the default runtime) takes one request: the forced schema call is the answer, not a tool round', async () => {
    // agent() runs up to five steps by default; a schema call left in tool_calls
    // ran as a missing tool and asked the model again on each of them.
    route({ 'claude-sonnet-4-6': [toolTurn('claude-sonnet-4-6', 'scores', { scores: { a: 1 } })] });
    const session = agent({ provider: 'anthropic', model: 'claude-sonnet-4-6', memory: false, fallbackProviders: [] }).session('legacy-forced');

    const result = await session.send('Score a.', {
      responseSchema: z.object({ scores: z.record(z.string(), z.number()) }),
      schemaName: 'scores',
    });

    expect(result.object).toEqual({ scores: { a: 1 } });
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(postedBodies()).toHaveLength(1);
    expect(session.messages().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('generateObject with a record schema and a thinking budget on Claude Opus 4.8 sends no clamped tool, and the provider\'s schema block survives the auto-cache', async () => {
    // Opus 4.8 accepts a forced tool choice, but not beside thinking: the
    // schema rides the prompt, and the auto-cache re-emits the system blocks
    // as an array to place its marker, the schema block among them.
    route({ 'claude-opus-4-8': [textTurn('claude-opus-4-8', '{"scores":{"a":1}}')] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await generateObject({
        model: 'anthropic:claude-opus-4-8',
        schema: z.object({ scores: z.record(z.string(), z.number()) }),
        schemaName: 'scores',
        system: 'You grade things.',
        prompt: 'Grade a.',
        thinking: { budgetTokens: 1024 },
        fallbackProviders: [],
      });

      expect(result.object).toEqual({ scores: { a: 1 } });
      const [body] = postedBodies();
      expect(['adaptive', 'enabled']).toContain(body.thinking?.type);
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.output_config?.format).toBeUndefined();
      expect(Array.isArray(body.system)).toBe(true);
      expect((body.system as Json[]).some((block) => block.cache_control)).toBe(true);
      expect(String((body.system as Json[]).at(-1)?.text)).toMatch(/^Answer with JSON only, matching this schema: /);
      expect(warn.mock.calls.some((call) => String(call[0]).includes('clamping'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('reports Claude Opus 5.5 cache reads at 0.05x in result.usage.costUSD', async () => {
    route({
      'claude-opus-5-5': [
        textTurn(
          'claude-opus-5-5',
          'Hello.',
          { input_tokens: 1000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0 },
          500,
        ),
      ],
    });

    const result = await generateText({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      prompt: 'Say hello.',
      fallbackProviders: [],
    });

    // $0.004 input + $0.02 cache reads + $0.01 output.
    expect(result.usage.costUSD).toBeCloseTo(0.034, 6);
  });
});

describe('Claude refusals through the public API', () => {
  it('generateText falls back to the next model when Claude refuses before any output', async () => {
    route({
      'claude-opus-5-5': [refusalTurn('claude-opus-5-5')],
      'claude-opus-4-8': [textTurn('claude-opus-4-8', 'Recovered.')],
    });

    const result = await generateText({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      prompt: 'What is the weather in Paris?',
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
    });

    expect(result.text).toBe('Recovered.');
    expect(result.fallback?.fired).toBe(true);
    expect(result.fallback?.hops).toEqual([
      { provider: 'anthropic', model: 'claude-opus-5-5', ok: false },
      { provider: 'anthropic', model: 'claude-opus-4-8', ok: true },
    ]);
  });

  it('generateText rejects with a content-policy error when no fallback is configured', async () => {
    route({ 'claude-opus-5-5': [refusalTurn('claude-opus-5-5')] });

    const error = await rejectionOf(
      generateText({
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        prompt: 'What is the weather in Paris?',
        fallbackProviders: [],
      }),
    );

    // Never an empty-string success.
    expect(isContentPolicyRefusal(error)).toBe(true);
  });

  it('generateText never runs a tool call parsed from the text of a refused turn', async () => {
    route({ 'claude-opus-5-5': [refusalTurn('claude-opus-5-5', PARTIAL_WITH_TOOL_CALL)] });
    const { execute, tools } = weatherTools();

    const error = await rejectionOf(
      generateText({
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        prompt: 'What is the weather in Paris?',
        tools,
        maxSteps: 3,
        fallbackProviders: [],
      }),
    );

    expect(isContentPolicyRefusal(error)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(postedBodies()).toHaveLength(1);
  });

  it('leaves the Anthropic breaker closed after six refusals in a row', async () => {
    route({ 'claude-opus-5-5': Array.from({ length: 6 }, () => refusalTurn('claude-opus-5-5')) });

    for (let i = 0; i < 6; i++) {
      const error = await rejectionOf(
        generateText({
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          prompt: `Question ${i}`,
          fallbackProviders: [],
        }),
      );
      // A refusal counted as a provider failure would open the breaker after
      // five, and the sixth call would fail with circuit-open instead.
      expect(isContentPolicyRefusal(error)).toBe(true);
    }
    expect(globalLLMProviderHealth.isOpen('anthropic')).toBe(false);
  });

  it('streamText falls back when Claude refuses before any text streamed', async () => {
    route({
      'claude-opus-5-5': [refusalTurn('claude-opus-5-5')],
      'claude-opus-4-8': [textTurn('claude-opus-4-8', 'Recovered.')],
    });

    const result = streamText({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      prompt: 'What is the weather in Paris?',
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
    });
    const parts = await collect(result.fullStream);

    expect(parts).toEqual([{ type: 'text', text: 'Recovered.' }]);
    expect(await result.finishReason).toBe('stop');
  });

  it('streamText ends unsuccessfully and runs no tool when Claude refuses after text streamed', async () => {
    route({
      'claude-opus-5-5': [refusalTurn('claude-opus-5-5', PARTIAL_WITH_TOOL_CALL)],
      'claude-opus-4-8': [textTurn('claude-opus-4-8', 'Recovered.')],
    });
    const { execute, tools } = weatherTools();

    const result = streamText({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      prompt: 'What is the weather in Paris?',
      tools,
      maxSteps: 3,
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
    });
    const parts = await collect(result.fullStream);

    expect(parts[0]).toEqual({ type: 'text', text: PARTIAL_WITH_TOOL_CALL });
    const last = parts[parts.length - 1];
    expect(last.type).toBe('error');
    expect(isContentPolicyRefusal(last.type === 'error' ? last.error : undefined)).toBe(true);
    expect(parts.some((part) => part.type === 'tool-call' || part.type === 'tool-result')).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(await result.finishReason).toBe('error');
    // The refused text already reached the consumer, so no fallback request.
    expect(postedBodies().map((body) => body.model)).toEqual(['claude-opus-5-5']);
  });

  it('generateText falls back to the next model when an SSE api_error ends the reply before any output', async () => {
    // Anthropic reports a server failure inside the 200 stream as an `error`
    // event. The provider retries it in place (three attempts in all), then
    // throws it with no HTTP status and the class in anthropicErrorType; the
    // walk then moves on to the next model.
    const apiError = (): Reply => () =>
      sse([
        messageStart('claude-opus-5-5', { input_tokens: 10 }),
        { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
      ]);
    route({
      'claude-opus-5-5': [apiError(), apiError(), apiError()],
      'claude-opus-4-8': [textTurn('claude-opus-4-8', 'Recovered.')],
    });
    // The provider's backoff between its attempts, at its shortest.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const result = await generateText({
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        prompt: 'Hello?',
        fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
      });

      expect(result.text).toBe('Recovered.');
      expect(postedBodies().map((b) => b.model)).toEqual([
        'claude-opus-5-5',
        'claude-opus-5-5',
        'claude-opus-5-5',
        'claude-opus-4-8',
      ]);
    } finally {
      random.mockRestore();
    }
  });
});

describe('Structured sends on the GMI runtime through the real provider', () => {
  const gmiSession = (model: string, id: string) =>
    agent({ runtime: 'gmi', provider: 'anthropic', model, memory: false, fallbackProviders: [] }).session(id);

  it('a send cut off at maxTokens on Claude Sonnet 5.5 rejects naming the cut-off, after one request on the JSON output format', async () => {
    route({ 'claude-sonnet-5-5': [truncatedTurn('claude-sonnet-5-5', '{"city":"Ly')] });
    const session = gmiSession('claude-sonnet-5-5', 'cut-format');

    const error = await rejectionOf(session.send('Where?', { responseSchema: z.object({ city: z.string() }), maxTokens: 16 }));

    expect(error).toBeInstanceOf(ObjectGenerationError);
    expect((error as ObjectGenerationError).message).toContain('cut off at maxTokens (16)');
    expect((error as ObjectGenerationError).rawText).toBe('{"city":"Ly');
    const bodies = postedBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].output_config.format.type).toBe('json_schema');
    expect(bodies[0].tools).toBeUndefined();
    expect(session.messages()).toEqual([]);
  });

  it('a send with a record schema on Claude Sonnet 4.6 sends one non-strict forced tool and returns its call as the object', async () => {
    route({ 'claude-sonnet-4-6': [toolTurn('claude-sonnet-4-6', 'scores', { scores: { a: 1, b: 2 } })] });
    const session = gmiSession('claude-sonnet-4-6', 'forced-record');

    const result = await session.send('Score a and b.', {
      responseSchema: z.object({ scores: z.record(z.string(), z.number()) }),
      schemaName: 'scores',
    });

    expect(result.object).toEqual({ scores: { a: 1, b: 2 } });
    expect(result.finishReason).toBe('stop');
    const bodies = postedBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools).toHaveLength(1);
    expect(bodies[0].tools[0].name).toBe('scores');
    expect(bodies[0].tools[0].strict).toBeUndefined();
    expect(bodies[0].tool_choice).toEqual({ type: 'tool', name: 'scores' });
    expect(bodies[0].output_config?.format).toBeUndefined();
  });

  it('a send whose forced schema tool call on Claude Sonnet 4.6 was cut off at maxTokens rejects naming the cut-off, with one request and no tool run', async () => {
    route({ 'claude-sonnet-4-6': [cutToolTurn('claude-sonnet-4-6', 'scores', '{"scores":{"a":')] });
    const session = gmiSession('claude-sonnet-4-6', 'forced-cut');

    const error = await rejectionOf(
      session.send('Score a.', { responseSchema: z.object({ scores: z.record(z.string(), z.number()) }), schemaName: 'scores', maxTokens: 16 }),
    );

    expect(error).toBeInstanceOf(ObjectGenerationError);
    expect((error as ObjectGenerationError).message).toContain('cut off at maxTokens (16)');
    expect((error as ObjectGenerationError).rawText).toBe('{"scores":{"a":');
    expect(postedBodies()).toHaveLength(1);
    expect(session.messages()).toEqual([]);
  });

  it('a send whose forced schema tool call on Claude Sonnet 4.6 was cut before its input began rejects naming the cut-off, though the {} the provider builds fits the schema', async () => {
    route({ 'claude-sonnet-4-6': [inputlessCutToolTurn('claude-sonnet-4-6', 'scores')] });
    const session = gmiSession('claude-sonnet-4-6', 'forced-cut-empty');

    const error = await rejectionOf(
      session.send('Score a.', {
        responseSchema: z.object({ scores: z.record(z.string(), z.number()).optional() }),
        schemaName: 'scores',
        maxTokens: 1,
      }),
    );

    expect(error).toBeInstanceOf(ObjectGenerationError);
    expect((error as ObjectGenerationError).message).toContain('cut off at maxTokens (1)');
    expect((error as ObjectGenerationError).rawText).toBe('{}');
    const bodies = postedBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].tool_choice).toEqual({ type: 'tool', name: 'scores' });
    expect(session.messages()).toEqual([]);
  });
});

describe('Claude refusals in a session', () => {
  it('records a streamed turn before the stream\'s text settles', async () => {
    route({ 'claude-opus-5-5': [textTurn('claude-opus-5-5', 'Hello.')] });
    const session = agent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      memory: false,
      fallbackProviders: [],
    }).session('stream-order');

    const result = session.stream('Hi.');
    void collect(result.fullStream);
    await result.text;

    expect(session.messages().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('leaves a refused stream out of the history, so the next request stays valid', async () => {
    route({
      'claude-opus-5-5': [
        refusalTurn('claude-opus-5-5', 'Here is how you'),
        textTurn('claude-opus-5-5', 'Happy to help with that.'),
      ],
    });
    const session = agent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      memory: false,
      fallbackProviders: [],
    }).session('refused-stream');

    const parts = await collect(session.stream('First question.').fullStream);
    expect(parts[parts.length - 1]?.type).toBe('error');
    // History is updated once the stream's promises settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.messages()).toEqual([]);

    await session.send('Second question.');
    const messages = postedBodies()[1].messages as Json[];
    expect(messages.filter((m) => m.role === 'assistant')).toEqual([]);
    expect(session.messages().map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

/** Request headers of every request, in call order (the provider sends a plain object). */
function postedHeaders(): Array<Record<string, string>> {
  return fetchMock.mock.calls.map(
    ([, init]) => (init as { headers?: Record<string, string> } | undefined)?.headers ?? {},
  );
}

describe('Claude thinking off and effort through the public API', () => {
  it('turns Sonnet 5.5 off with between_tools and caps effort at high', async () => {
    route({ 'claude-sonnet-5-5': [textTurn('claude-sonnet-5-5', 'Done.')] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await generateText({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      prompt: 'Be quick.',
      thinking: false,
      effort: 'max',
      fallbackProviders: [],
    });

    const [body] = postedBodies();
    expect(body.thinking).toEqual({ type: 'between_tools' });
    expect(body.output_config).toEqual({ effort: 'high' });
    warn.mockRestore();
  });

  it('sends each fallback model its own off shape, never Sonnet 5.5\'s', async () => {
    route({
      'claude-sonnet-5-5': [refusalTurn('claude-sonnet-5-5')],
      'claude-sonnet-5': [textTurn('claude-sonnet-5', 'Done.')],
    });

    const result = await generateText({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      prompt: 'Be quick.',
      thinking: false,
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-sonnet-5' }],
    });

    expect(result.text).toBe('Done.');
    const [primary, leg] = postedBodies();
    expect(primary.thinking).toEqual({ type: 'between_tools' });
    expect(leg.thinking).toEqual({ type: 'disabled' });
  });

  it('keeps a forced tool_choice and sends no interleaved-thinking beta when Opus 5 has thinking off', async () => {
    route({ 'claude-opus-5': [textTurn('claude-opus-5', 'No tool needed.')] });
    const { tools } = weatherTools();

    await generateText({
      provider: 'anthropic',
      model: 'claude-opus-5',
      prompt: 'Weather in Paris?',
      tools,
      toolChoice: 'required',
      thinking: false,
      fallbackProviders: [],
    });

    const [body] = postedBodies();
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.tool_choice).toEqual({ type: 'any' });
    expect(postedHeaders()[0]['anthropic-beta'] ?? '').not.toContain('interleaved-thinking');
  });

  it('turns thinking off for the planning call too, in generateText and streamText', async () => {
    const plan = '{"steps":[{"description":"Answer directly.","tool":null,"reasoning":"No tool needed."}]}';
    route({
      'claude-opus-5': [
        textTurn('claude-opus-5', plan),
        textTurn('claude-opus-5', 'Done.'),
        textTurn('claude-opus-5', plan),
        textTurn('claude-opus-5', 'Streamed.'),
      ],
    });

    await generateText({
      provider: 'anthropic',
      model: 'claude-opus-5',
      prompt: 'Be quick.',
      planning: true,
      thinking: false,
      fallbackProviders: [],
    });
    const stream = streamText({
      provider: 'anthropic',
      model: 'claude-opus-5',
      prompt: 'Be quick.',
      planning: true,
      thinking: false,
      fallbackProviders: [],
    });
    await collect(stream.fullStream);

    const bodies = postedBodies();
    expect(bodies).toHaveLength(4);
    for (const body of bodies) expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('sends no thinking field to a model that always thinks or thinks only when asked', async () => {
    route({
      'claude-opus-5-5': [textTurn('claude-opus-5-5', 'One.')],
      'claude-opus-4-8': [textTurn('claude-opus-4-8', 'Two.')],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await generateText({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'Hi', thinking: false, fallbackProviders: [] });
    await generateText({ provider: 'anthropic', model: 'claude-opus-4-8', prompt: 'Hi', thinking: false, fallbackProviders: [] });

    const [alwaysOn, onRequest] = postedBodies();
    expect(alwaysOn.thinking).toBeUndefined();
    expect(onRequest.thinking).toBeUndefined();
    warn.mockRestore();
  });

  it('sends each Claude model an effort level it accepts', async () => {
    route({
      'claude-sonnet-4-6': [textTurn('claude-sonnet-4-6', 'a')],
      'claude-opus-4-5-20251101': [textTurn('claude-opus-4-5-20251101', 'b')],
      'claude-opus-4-6': [textTurn('claude-opus-4-6', 'c')],
      'claude-opus-4-8': [textTurn('claude-opus-4-8', 'd')],
    });

    await generateText({ provider: 'anthropic', model: 'claude-sonnet-4-6', prompt: 'x', effort: 'xhigh', fallbackProviders: [] });
    await generateText({ provider: 'anthropic', model: 'claude-opus-4-5-20251101', prompt: 'x', effort: 'max', fallbackProviders: [] });
    await generateText({ provider: 'anthropic', model: 'claude-opus-4-6', prompt: 'x', effort: 'max', fallbackProviders: [] });
    await generateText({ provider: 'anthropic', model: 'claude-opus-4-8', prompt: 'x', effort: 'xhigh', fallbackProviders: [] });

    expect(postedBodies().map((b) => b.output_config?.effort)).toEqual(['high', 'high', 'max', 'xhigh']);
  });
});

describe('structured calls carry thinking and effort to the wire', () => {
  it('generateObject on Sonnet 5.5 with thinking off sends between_tools at the given effort', async () => {
    route({ 'claude-sonnet-5-5': [textTurn('claude-sonnet-5-5', '{"answer":"ok"}')] });

    const result = await generateObject({
      model: 'anthropic:claude-sonnet-5-5',
      schema: z.object({ answer: z.string() }),
      prompt: 'Answer with ok.',
      thinking: false,
      effort: 'low',
      fallbackProviders: [],
    });

    expect(result.object).toEqual({ answer: 'ok' });
    const [body] = postedBodies();
    expect(body.thinking).toEqual({ type: 'between_tools' });
    // The JSON output format rides beside the effort in the same output_config.
    expect(body.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
  });

  it('streamObject on Sonnet 5.5 with thinking off sends between_tools at the given effort', async () => {
    route({ 'claude-sonnet-5-5': [textTurn('claude-sonnet-5-5', '{"answer":"ok"}')] });

    const result = streamObject({
      model: 'anthropic:claude-sonnet-5-5',
      schema: z.object({ answer: z.string() }),
      prompt: 'Answer with ok.',
      thinking: false,
      effort: 'low',
    });
    for await (const _partial of result.partialObjectStream) {
      // drain the stream so the request is made
    }

    await expect(result.object).resolves.toEqual({ answer: 'ok' });
    const [body] = postedBodies();
    expect(body.thinking).toEqual({ type: 'between_tools' });
    expect(body.output_config).toEqual({ effort: 'low' });
  });
});

describe('the Anthropic rescue leg of buildFallbackChain on the wire', () => {
  it('runs Sonnet 5.5 at effort low with 1024 tokens of headroom and keeps the caller\'s thinking off', async () => {
    const saved = { openai: process.env.OPENAI_API_KEY, gemini: process.env.GEMINI_API_KEY };
    // The chain an OpenAI-primary call builds; with no OpenAI, OpenRouter or
    // Gemini key its only leg is Anthropic's.
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const chain = buildFallbackChain('openai');
      expect(chain.map((entry) => entry.model)).toEqual(['claude-sonnet-5-5']);
      route({
        'claude-opus-5-5': [refusalTurn('claude-opus-5-5')],
        'claude-sonnet-5-5': [textTurn('claude-sonnet-5-5', 'Rescued.')],
      });

      const result = await generateText({
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        prompt: 'Say something.',
        maxTokens: 500,
        thinking: false,
        fallbackProviders: chain,
      });

      expect(result.text).toBe('Rescued.');
      const leg = postedBodies().find((body) => body.model === 'claude-sonnet-5-5');
      expect(leg).toBeDefined();
      expect(leg!.max_tokens).toBe(1524);
      expect(leg!.output_config).toEqual({ effort: 'low' });
      expect(leg!.thinking).toEqual({ type: 'between_tools' });
    } finally {
      warn.mockRestore();
      if (saved.openai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.openai;
      if (saved.gemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = saved.gemini;
    }
  });
});
