/**
 * @file openai-gpt5-tool-fallback.e2e.test.ts
 * A streamed tool call that falls back from Anthropic to gpt-5.6-sol reaches
 * OpenAI's /v1/responses, never /v1/chat/completions.
 *
 * gpt-5.6-sol refuses function tools on /v1/chat/completions unless
 * `reasoning_effort` is 'none', and its default effort is not none: a body of
 * exactly [max_completion_tokens, messages, model, stream, stream_options,
 * tools] is answered HTTP 400 "Function tools with reasoning_effort are not
 * supported for gpt-5.6-sol in /v1/chat/completions. To use function tools,
 * use /v1/responses or set reasoning_effort to 'none'." A fallback hop to it
 * carries no effort, so the provider must route on the tools alone.
 *
 * Drives streamText through the real resolver, provider manager,
 * AnthropicProvider, OpenAIProvider and health registry; only fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { streamText } from '../streamText.js';
import { shutdownProviderManagers } from '../model.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

type Json = Record<string, any>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const creditTooLow = () =>
  json(
    {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message:
          'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      },
    },
    400,
  );

const openAiModels = () =>
  json({ object: 'list', data: [{ id: 'gpt-5.6-sol', object: 'model', created: 1, owned_by: 'openai' }] });

/** OpenAI's answer to a gpt-5.6-sol function-tool call on /v1/chat/completions. */
const chatToolsRefused = () =>
  json(
    {
      error: {
        message:
          "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
        type: 'invalid_request_error',
        param: 'reasoning_effort',
        code: null,
      },
    },
    400,
  );

/** A /v1/responses SSE body answering with the text 'ok'. */
const responsesOk = () => {
  const meta = { id: 'resp_1', object: 'response', created_at: 1700000000, model: 'gpt-5.6-sol' };
  const events: Json[] = [
    { type: 'response.created', response: { ...meta, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'ok' },
    {
      type: 'response.completed',
      response: {
        ...meta,
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
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 21,
        },
      },
    },
  ];
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const ping = {
  description: 'Ping the service.',
  parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
  execute: async ({ x }: { x: string }) => ({ pong: x }),
};

/** URL and parsed JSON body of every POST to `pattern`. */
const postsTo = (pattern: RegExp): Array<{ url: string; body: Json }> =>
  fetchMock.mock.calls
    .filter(([url, init]) => pattern.test(String(url)) && (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) as Json }));

const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;

describe('a streamed tool call that falls back to gpt-5.6-sol', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    globalLLMProviderHealth.reset();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-credit-low-0001');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-gpt5-tools-0002');
    // Without this the resolver could reroute the Anthropic call to OpenRouter.
    delete process.env.OPENROUTER_API_KEY;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (/api\.anthropic\.com\/v1\/messages/.test(u)) return creditTooLow();
      if (/api\.openai\.com\/v1\/models/.test(u)) return openAiModels();
      if (/api\.openai\.com\/v1\/chat\/completions/.test(u)) return chatToolsRefused();
      if (/api\.openai\.com\/v1\/responses/.test(u)) return responsesOk();
      throw new Error(`unexpected request ${u}`);
    });
  });

  afterEach(async () => {
    await shutdownProviderManagers();
    globalLLMProviderHealth.reset();
    vi.unstubAllEnvs();
    if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
    vi.restoreAllMocks();
  });

  it('reaches /v1/responses with the tools and sends nothing to /v1/chat/completions', async () => {
    const result = streamText({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      prompt: 'hi',
      tools: { ping },
      fallbackProviders: [{ provider: 'openai', model: 'gpt-5.6-sol', cache: false }],
    });

    let streamed = '';
    for await (const delta of result.textStream) streamed += delta;

    expect(streamed).toBe('ok');
    expect(await result.text).toBe('ok');
    expect(postsTo(/api\.anthropic\.com\/v1\/messages/).length).toBeGreaterThanOrEqual(1);
    expect(postsTo(/api\.openai\.com\/v1\/chat\/completions/)).toHaveLength(0);
    const responses = postsTo(/api\.openai\.com\/v1\/responses/);
    expect(responses).toHaveLength(1);
    expect(responses[0].body.model).toBe('gpt-5.6-sol');
    expect(responses[0].body.tools.map((t: Json) => t.name)).toEqual(['ping']);
    expect(responses[0].body).not.toHaveProperty('reasoning');
    expect(responses[0].body).not.toHaveProperty('reasoning_effort');
  });
});
