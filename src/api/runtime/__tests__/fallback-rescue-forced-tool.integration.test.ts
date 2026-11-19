/**
 * @file fallback-rescue-forced-tool.integration.test.ts
 * The Anthropic rescue leg of the auto-built fallback chain keeps a required
 * tool required.
 *
 * Claude Sonnet 5.5, the leg's model, refuses a forced `tool_choice`, and
 * AnthropicProvider sends such a choice to it as `auto`. A call whose
 * `toolChoice` forces a tool therefore takes Claude Sonnet 5 on that leg,
 * which takes the forced choice; any other call keeps Sonnet 5.5.
 *
 * generateText runs with the real OpenAI and Anthropic providers and only
 * fetch stubbed: the OpenAI primary answers 503, and the stub records the
 * request the Anthropic leg puts on the wire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateText } from '../../generateText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

type Json = Record<string, any>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A streamed Claude turn that calls `get_weather`, as a forced tool call is answered. */
function claudeToolTurn(model: string): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_${model}`, type: 'message', role: 'assistant', content: [], model,
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** OpenAI lists its models, then answers every POST with 503; Anthropic answers every message with a tool call. */
function route(): void {
  fetchMock.mockImplementation(async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.startsWith('https://api.openai.com/')) {
      if (method === 'GET') {
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
      }
      return jsonResponse({ error: { message: 'The server is overloaded.', type: 'server_error', code: null } }, 503);
    }
    if (u.startsWith('https://api.anthropic.com/')) {
      if (method === 'GET') return jsonResponse({ data: [], has_more: false });
      const body = JSON.parse(String(init?.body)) as Json;
      return claudeToolTurn(String(body.model));
    }
    throw new Error(`unexpected request ${method} ${u}`);
  });
}

/** Parsed bodies of the POSTs sent to a host, in call order. */
function postsTo(host: string): Json[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).startsWith(host) && (init as { method?: string } | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as { body?: unknown }).body)) as Json);
}

const tools = {
  get_weather: {
    description: 'Current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    execute: async (args: { city: string }) => ({ city: args.city, temp_c: 18 }),
  },
};

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
  for (const name of ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL']) vi.stubEnv(name, '');
  vi.stubEnv('OPENAI_API_KEY', 'sk-openai-rescue-test');
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-rescue-test');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the Anthropic rescue leg of an OpenAI primary that answers 503', () => {
  it.each([
    ["toolChoice 'required'", 'required' as const, { type: 'any' }],
    ['a named function', { type: 'function', function: { name: 'get_weather' } }, { type: 'tool', name: 'get_weather' }],
  ])('sends a call with %s to claude-sonnet-5 with a forced tool_choice', async (_label, toolChoice, wireChoice) => {
    route();

    await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      prompt: 'What is the weather in Paris?',
      tools,
      toolChoice,
      maxSteps: 1,
      maxAttempts: 1,
    });

    // The primary was sent, and failed, before the leg ran.
    expect(postsTo('https://api.openai.com/').length).toBeGreaterThan(0);
    const [rescue] = postsTo('https://api.anthropic.com/');
    expect(rescue).toBeDefined();
    expect(rescue.model).toBe('claude-sonnet-5');
    expect(rescue.tool_choice).toEqual(wireChoice);
  });

  it('keeps claude-sonnet-5-5 for a call that forces no tool', async () => {
    route();

    await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      prompt: 'What is the weather in Paris?',
      tools,
      toolChoice: 'auto',
      maxSteps: 1,
      maxAttempts: 1,
    });

    const [rescue] = postsTo('https://api.anthropic.com/');
    expect(rescue).toBeDefined();
    expect(rescue.model).toBe('claude-sonnet-5-5');
  });
});
