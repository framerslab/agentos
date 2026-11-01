/**
 * @file generateObject.serviceTier.e2e.test.ts
 * `serviceTier` and `customModelParams` on generateObject, through the public
 * API and the real OpenAIProvider with only fetch stubbed: the request body
 * OpenAI receives carries `service_tier` and the passthrough fields, on the
 * first attempt and on a validation retry, as generateText sends them.
 *
 * streamObject sends both the same way on its streamed request. A fallback leg
 * to another vendor gets the passthrough fields minus the structured-output
 * field only the primary's vendor accepts: OpenAI's `response_format` is not
 * an Anthropic Messages field, and Anthropic's `output_config` is not an OpenAI
 * Chat Completions field.
 *
 * OpenAI's Chat Completions reference describes `service_tier` as the
 * processing type for the request ('auto', 'default', 'flex', 'priority') and
 * lists `response_format` and no `output_config`:
 * https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
 * Anthropic's Messages reference lists `output_config` and no `response_format`:
 * https://platform.claude.com/docs/en/api/messages/create
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateObject } from '../generateObject.js';
import { generateText } from '../generateText.js';
import { streamObject } from '../streamObject.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'gpt-6-luna';
const CLAUDE = 'claude-sonnet-5-5';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A chat completion whose message text is `content`. */
function chatCompletion(content: string): Response {
  return jsonResponse({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1700000000,
    model: MODEL,
    service_tier: 'priority',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  });
}

/** Lists models on GET and answers each POST with the next queued reply. */
function serve(replies: Array<() => Response>): void {
  const queue = [...replies];
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ object: 'list', data: [{ id: MODEL, object: 'model', created: 1, owned_by: 'openai' }] });
    }
    const next = queue.shift();
    if (!next) throw new Error(`unexpected POST ${String(url)}`);
    return next();
  });
}

/** The POSTs fetch was handed: each one's URL and parsed JSON body. */
function posted(): Array<{ url: string; body: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    }));
}

/** A streamed chat completion whose message text is `content`. */
function chatCompletionStream(content: string): Response {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700000000, model: MODEL, choices, ...extra })}\n\n`;
  const text =
    chunk([{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]) +
    chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) +
    chunk([], { usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }) +
    'data: [DONE]\n\n';
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Reads a stream to its end (streamObject sends its request only while it is read). */
async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _part of stream) {
    // read and dropped
  }
}

/** A streamed Claude reply whose text is `text`. */
function claudeTurn(text: string): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', content: [], model: CLAUDE,
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A 500 from either vendor. */
function serverError(): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal server error' } }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });
}

/** Answers OpenAI's model list on GET and each POST with the next reply queued for its URL. */
function serveByUrl(replies: Record<string, Array<() => Response>>): void {
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ object: 'list', data: [{ id: MODEL, object: 'model', created: 1, owned_by: 'openai' }] });
    }
    const next = replies[String(url)]?.shift();
    if (!next) throw new Error(`unexpected POST ${String(url)}`);
    return next();
  });
}

const savedKeys = {
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
};

beforeAll(() => {
  // Fallback legs resolve their keys from the environment; without OpenRouter's,
  // no leg is rerouted there.
  process.env.OPENAI_API_KEY = 'sk-leg-openai';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-leg';
  delete process.env.OPENROUTER_API_KEY;
});

afterAll(() => {
  for (const [name, value] of [
    ['OPENAI_API_KEY', savedKeys.openai],
    ['ANTHROPIC_API_KEY', savedKeys.anthropic],
    ['OPENROUTER_API_KEY', savedKeys.openrouter],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

describe('generateObject sends serviceTier and customModelParams to the provider', () => {
  it('a generateText call with the same options sends service_tier and the passthrough fields (the reference)', async () => {
    serve([() => chatCompletion('Jupiter')]);

    await generateText({
      model: `openai:${MODEL}`,
      apiKey: 'sk-tier-text',
      prompt: 'Which planet in the solar system is the largest?',
      fallbackProviders: [],
      serviceTier: 'priority',
      customModelParams: { seed: 7 },
    });

    expect(posted()).toHaveLength(1);
    expect(posted()[0].url).toBe(CHAT_URL);
    expect(posted()[0].body.service_tier).toBe('priority');
    expect(posted()[0].body.seed).toBe(7);
  });

  it("sends serviceTier: 'priority' as service_tier on OpenAI's request", async () => {
    serve([() => chatCompletion('{"planet":"Jupiter"}')]);
    const options = {
      model: `openai:${MODEL}`,
      apiKey: 'sk-tier-object',
      schema: z.object({ planet: z.string() }),
      prompt: 'Which planet in the solar system is the largest?',
      fallbackProviders: [],
      serviceTier: 'priority' as const,
    };

    const { object } = await generateObject(options);

    expect(object).toEqual({ planet: 'Jupiter' });
    expect(posted()).toHaveLength(1);
    expect(posted()[0].url).toBe(CHAT_URL);
    expect(posted()[0].body.service_tier).toBe('priority');
  });

  it('spreads customModelParams onto the request body', async () => {
    serve([() => chatCompletion('{"planet":"Jupiter"}')]);
    const options = {
      model: `openai:${MODEL}`,
      apiKey: 'sk-params-object',
      schema: z.object({ planet: z.string() }),
      prompt: 'Which planet in the solar system is the largest?',
      fallbackProviders: [],
      customModelParams: { seed: 7, metadata: { job: 'extract' } },
    };

    await generateObject(options);

    expect(posted()).toHaveLength(1);
    expect(posted()[0].body.seed).toBe(7);
    expect(posted()[0].body.metadata).toEqual({ job: 'extract' });
  });

  it('a validation retry carries service_tier and the passthrough fields too', async () => {
    serve([() => chatCompletion('not json at all'), () => chatCompletion('{"planet":"Jupiter"}')]);
    const options = {
      model: `openai:${MODEL}`,
      apiKey: 'sk-tier-retry',
      schema: z.object({ planet: z.string() }),
      prompt: 'Which planet in the solar system is the largest?',
      maxRetries: 1,
      fallbackProviders: [],
      serviceTier: 'flex' as const,
      customModelParams: { seed: 11 },
    };

    const { object } = await generateObject(options);

    expect(object).toEqual({ planet: 'Jupiter' });
    expect(posted()).toHaveLength(2);
    for (const request of posted()) {
      expect(request.body.service_tier).toBe('flex');
      expect(request.body.seed).toBe(11);
    }
  });

  it('sends no service_tier when the call names none', async () => {
    serve([() => chatCompletion('{"planet":"Jupiter"}')]);

    await generateObject({
      model: `openai:${MODEL}`,
      apiKey: 'sk-no-tier',
      schema: z.object({ planet: z.string() }),
      prompt: 'Which planet in the solar system is the largest?',
      fallbackProviders: [],
    });

    expect(posted()).toHaveLength(1);
    expect(posted()[0].body).not.toHaveProperty('service_tier');
  });
});

describe('streamObject sends serviceTier and customModelParams to the provider', () => {
  it("sends serviceTier: 'flex' as service_tier and spreads customModelParams onto the streamed request", async () => {
    serve([() => chatCompletionStream('{"planet":"Jupiter"}')]);
    const options = {
      model: `openai:${MODEL}`,
      apiKey: 'sk-tier-stream',
      schema: z.object({ planet: z.string() }),
      prompt: 'Which planet in the solar system is the largest?',
      serviceTier: 'flex' as const,
      customModelParams: { seed: 5 },
    };

    const result = streamObject(options);
    await drain(result.partialObjectStream);

    expect(await result.object).toEqual({ planet: 'Jupiter' });
    expect(posted()).toHaveLength(1);
    expect(posted()[0].body.stream).toBe(true);
    expect(posted()[0].body.service_tier).toBe('flex');
    expect(posted()[0].body.seed).toBe(5);
  });

  it('sends no service_tier when the call names none', async () => {
    serve([() => chatCompletionStream('{"planet":"Jupiter"}')]);

    const result = streamObject({
      model: `openai:${MODEL}`,
      apiKey: 'sk-no-tier-stream',
      schema: z.object({ planet: z.string() }),
      prompt: 'Which planet in the solar system is the largest?',
    });
    await drain(result.partialObjectStream);

    expect(await result.object).toEqual({ planet: 'Jupiter' });
    expect(posted()).toHaveLength(1);
    expect(posted()[0].body).not.toHaveProperty('service_tier');
  });
});

describe("a fallback leg to another vendor drops the primary vendor's structured-output passthrough", () => {
  it("an OpenAI call's response_format stays off the Anthropic leg, and the other passthrough fields go to both", async () => {
    serveByUrl({ [CHAT_URL]: [serverError], [MESSAGES_URL]: [() => claudeTurn('{"planet":"Jupiter"}')] });

    const { object } = await generateObject({
      model: `openai:${MODEL}`,
      apiKey: 'sk-primary-openai',
      schema: z.object({ planet: z.string() }),
      prompt: 'Which planet in the solar system is the largest?',
      maxAttempts: 1,
      fallbackProviders: [{ provider: 'anthropic', model: CLAUDE }],
      customModelParams: { response_format: { type: 'json_object' }, metadata: { user_id: 'u-1' } },
    });

    expect(object).toEqual({ planet: 'Jupiter' });
    const [primary, leg] = posted();
    expect(primary.url).toBe(CHAT_URL);
    expect(primary.body.response_format).toEqual({ type: 'json_object' });
    expect(leg.url).toBe(MESSAGES_URL);
    expect(leg.body).not.toHaveProperty('response_format');
    expect(leg.body.metadata).toEqual({ user_id: 'u-1' });
    // The leg's own structured output still goes out in Anthropic's form.
    expect((leg.body.output_config as { format?: { type?: string } }).format?.type).toBe('json_schema');
  });

  it("an Anthropic call's output_config stays off the OpenAI leg", async () => {
    serveByUrl({ [MESSAGES_URL]: [serverError], [CHAT_URL]: [() => chatCompletion('{"planet":"Jupiter"}')] });

    const { object } = await generateObject({
      model: `anthropic:${CLAUDE}`,
      apiKey: 'sk-ant-primary',
      schema: z.object({ planet: z.string() }),
      prompt: 'Which planet in the solar system is the largest?',
      maxAttempts: 1,
      fallbackProviders: [{ provider: 'openai', model: MODEL }],
      customModelParams: { output_config: { effort: 'low' }, metadata: { user_id: 'u-2' } },
    });

    expect(object).toEqual({ planet: 'Jupiter' });
    const [primary, leg] = posted();
    expect(primary.url).toBe(MESSAGES_URL);
    expect((primary.body.output_config as { effort?: string }).effort).toBe('low');
    expect(leg.url).toBe(CHAT_URL);
    expect(leg.body).not.toHaveProperty('output_config');
    expect(leg.body.metadata).toEqual({ user_id: 'u-2' });
  });
});
