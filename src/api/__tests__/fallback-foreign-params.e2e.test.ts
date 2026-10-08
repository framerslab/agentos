/**
 * @file fallback-foreign-params.e2e.test.ts
 * A fallback leg reuses the caller's customModelParams. Gemini request fields
 * (thinkingConfig, topK, safetySettings, ...) set for a Gemini primary must
 * not reach the next leg's request body: OpenAI and Anthropic reject unknown
 * top-level fields with HTTP 400, so the failover itself would fail.
 *
 * The OpenAI and Anthropic legs run through generateText with the real
 * providers and a stubbed fetch. OpenRouterProvider and OllamaProvider send
 * through axios, so their payloads are checked at their request helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateText } from '../generateText.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import { OpenRouterProvider } from '../../core/llm/providers/implementations/OpenRouterProvider.js';
import { OllamaProvider } from '../../core/llm/providers/implementations/OllamaProvider.js';

type Json = Record<string, any>;

const GEMINI_PARAMS = {
  thinkingConfig: { thinkingBudget: 512, includeThoughts: true },
  topK: 40,
  safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
  metadata: { user_id: 'u1' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const geminiDenied = () =>
  jsonResponse(
    { error: { code: 403, message: 'API key expired. Please renew the API key.', status: 'PERMISSION_DENIED' } },
    403,
  );

function anthropicText(text: string): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_leg',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 9, output_tokens: 1 },
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

function route(handlers: Array<[RegExp, () => Response]>): void {
  fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    const match = handlers.find(([pattern]) => pattern.test(u));
    if (!match) throw new Error(`unexpected request ${init?.method ?? 'GET'} ${u}`);
    return match[1]();
  });
}

function bodyOf(pattern: RegExp): Json {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => pattern.test(String(url)) && (init as { method?: string } | undefined)?.method === 'POST',
  );
  if (!call) throw new Error(`no POST to ${pattern}`);
  return JSON.parse(String((call[1] as { body?: unknown }).body)) as Json;
}

function expectNoGeminiFields(body: Json): void {
  expect(body.thinkingConfig).toBeUndefined();
  expect(body.topK).toBeUndefined();
  expect(body.safetySettings).toBeUndefined();
}

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a Gemini primary fails over with Gemini-only customModelParams', () => {
  it('the OpenAI leg sends none of the Gemini fields and keeps the rest', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-leg-params');
    route([
      [/generativelanguage\.googleapis\.com/, geminiDenied],
      [
        /api\.openai\.com\/v1\/models/,
        () => jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] }),
      ],
      [
        /api\.openai\.com\/v1\/chat\/completions/,
        () =>
          jsonResponse({
            id: 'chatcmpl-leg',
            object: 'chat.completion',
            created: 1,
            model: 'gpt-4.1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'From OpenAI.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
      ],
    ]);

    const result = await generateText({
      provider: 'gemini',
      model: 'gemini-3.1-pro-preview',
      apiKey: 'gemini-key-params-openai',
      prompt: 'Hello?',
      customModelParams: GEMINI_PARAMS,
      fallbackProviders: [{ provider: 'openai', model: 'gpt-4.1' }],
    });

    expect(result.text).toBe('From OpenAI.');
    // The Gemini request itself still carried its fields.
    const geminiBody = bodyOf(/generativelanguage\.googleapis\.com/);
    expect(geminiBody.generationConfig).toMatchObject({ topK: 40, thinkingConfig: { thinkingBudget: 512 } });
    const openaiBody = bodyOf(/api\.openai\.com\/v1\/chat\/completions/);
    expectNoGeminiFields(openaiBody);
    expect(openaiBody.metadata).toEqual({ user_id: 'u1' });
  });

  it('the Anthropic leg sends none of the Gemini fields and keeps the rest', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-leg-params');
    route([
      [/generativelanguage\.googleapis\.com/, geminiDenied],
      [/api\.anthropic\.com\/v1\/messages/, () => anthropicText('From Anthropic.')],
    ]);

    const result = await generateText({
      provider: 'gemini',
      model: 'gemini-3.1-pro-preview',
      apiKey: 'gemini-key-params-anthropic',
      prompt: 'Hello?',
      customModelParams: GEMINI_PARAMS,
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
    });

    expect(result.text).toBe('From Anthropic.');
    const anthropicBody = bodyOf(/api\.anthropic\.com\/v1\/messages/);
    expectNoGeminiFields(anthropicBody);
    expect(anthropicBody.metadata).toEqual({ user_id: 'u1' });
  });
});

describe('providers outside the fetch path strip Gemini fields too', () => {
  it('OpenRouterProvider drops the Gemini fields but keeps its routing controls', async () => {
    const provider = new OpenRouterProvider();
    const makeApiRequest = vi.fn(async () => ({
      id: 'gen-1',
      object: 'chat.completion',
      created: 1,
      model: 'openai/gpt-4.1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    Object.assign(provider as unknown as Record<string, unknown>, {
      ensureInitialized: () => {},
      config: { requestTimeout: 60000, streamRequestTimeout: 120000 },
      makeApiRequest,
    });

    await provider.generateCompletion('openai/gpt-4.1', [{ role: 'user', content: 'hi' }], {
      customModelParams: { ...GEMINI_PARAMS, provider: { order: ['Groq'] } },
    });

    const payload = (makeApiRequest.mock.calls[0] as unknown as unknown[])[3] as Json;
    expectNoGeminiFields(payload);
    expect(payload.metadata).toEqual({ user_id: 'u1' });
    expect(payload.provider).toMatchObject({ order: ['Groq'] });
  });

  it('OllamaProvider keeps the Gemini fields out of its options bag', async () => {
    const provider = new OllamaProvider();
    const post = vi.fn(async () => ({
      status: 200,
      data: {
        model: 'llama3.2',
        created_at: '2026-09-30T00:00:00Z',
        message: { role: 'assistant', content: 'ok' },
        done: true,
        prompt_eval_count: 3,
        eval_count: 1,
      },
    }));
    Object.assign(provider as unknown as Record<string, unknown>, {
      isInitialized: true,
      config: { baseURL: 'http://ollama.test:11434', requestTimeout: 60000 },
      client: { post },
    });

    await provider.generateCompletion('llama3.2', [{ role: 'user', content: 'hi' }], {
      customModelParams: { ...GEMINI_PARAMS },
    });

    const payload = (post.mock.calls[0] as unknown as unknown[])[1] as Json;
    expectNoGeminiFields(payload.options ?? {});
    expect(payload.options?.metadata).toEqual({ user_id: 'u1' });
  });
});
