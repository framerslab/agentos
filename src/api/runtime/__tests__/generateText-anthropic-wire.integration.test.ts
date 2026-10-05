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

import { generateText, isContentPolicyRefusal } from '../../generateText.js';
import { generateObject } from '../../generateObject.js';
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
  it('generateObject on Claude Sonnet 5.5 sends no forced tool and parses the JSON reply', async () => {
    route({ 'claude-sonnet-5-5': [textTurn('claude-sonnet-5-5', '{"answer":"ok"}')] });

    const result = await generateObject({
      model: 'anthropic:claude-sonnet-5-5',
      schema: z.object({ answer: z.string() }),
      prompt: 'Answer with ok.',
      fallbackProviders: [],
    });

    expect(result.object).toEqual({ answer: 'ok' });
    const [body] = postedBodies();
    // Sonnet 5.5 returns HTTP 400 on a forced tool_choice, so structured
    // output rides the prompt-only JSON path.
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools).toBeUndefined();
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
