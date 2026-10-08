/**
 * @file provider-init-failover.e2e.test.ts
 * A primary provider that cannot initialize (OpenAI's model listing answers
 * 401 for a revoked key, or the endpoint is unreachable) must fail over to
 * the next provider, and must not stay disabled for the life of the process
 * once it recovers.
 *
 * Drives generateText / streamText through the real provider manager and the
 * real OpenAIProvider and AnthropicProvider classes; only fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateText } from '../generateText.js';
import { streamText } from '../streamText.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

type Handler = (url: string, init?: { method?: string }) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function anthropicText(text: string): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_fb',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const revokedKey = () =>
  jsonResponse(
    {
      error: {
        message: 'Incorrect API key provided: sk-bad***. You can find your API key at https://platform.openai.com/account/api-keys.',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    },
    401,
  );

/** Routes each request to the first handler whose pattern matches its URL. */
function route(handlers: Array<[RegExp, Handler]>): void {
  fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    const match = handlers.find(([pattern]) => pattern.test(u));
    if (!match) throw new Error(`unexpected request ${init?.method ?? 'GET'} ${u}`);
    return match[1](u, init);
  });
}

function requestsTo(pattern: RegExp, method?: string): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      pattern.test(String(url)) &&
      (method === undefined || ((init as { method?: string } | undefined)?.method ?? 'GET') === method),
  ).length;
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const delta of stream) text += delta;
  return text;
}

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('primary provider fails to initialize', () => {
  it('generateText fails over when the primary key is rejected at initialization', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-failover-generate');
    route([
      [/api\.openai\.com\/v1\/models/, revokedKey],
      [/api\.anthropic\.com\/v1\/messages/, () => anthropicText('Served by the fallback.')],
    ]);

    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: 'sk-bad-init-generate',
      prompt: 'Hello?',
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
    });

    expect(result.text).toBe('Served by the fallback.');
    expect(result.provider).toBe('anthropic');
    expect(requestsTo(/api\.openai\.com\/v1\/chat\/completions/)).toBe(0);
  });

  it('streamText fails over when the primary key is rejected at initialization', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-failover-stream');
    route([
      [/api\.openai\.com\/v1\/models/, revokedKey],
      [/api\.anthropic\.com\/v1\/messages/, () => anthropicText('Streamed by the fallback.')],
    ]);

    const result = streamText({
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: 'sk-bad-init-stream',
      prompt: 'Hello?',
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
    });

    expect(await drain(result.textStream)).toBe('Streamed by the fallback.');
    expect(requestsTo(/api\.openai\.com\/v1\/chat\/completions/)).toBe(0);
  });

  it('fails over when the primary endpoint is unreachable through every initialization retry', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-failover-network');
    route([
      [
        /api\.openai\.com\/v1\/models/,
        () => {
          throw new TypeError('fetch failed');
        },
      ],
      [/api\.anthropic\.com\/v1\/messages/, () => anthropicText('Reached the fallback.')],
    ]);

    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: 'sk-unreachable-init',
      prompt: 'Hello?',
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
    });

    expect(result.text).toBe('Reached the fallback.');
    // OpenAIProvider retries the listing before giving up (maxRetries 3).
    expect(requestsTo(/api\.openai\.com\/v1\/models/)).toBe(3);
  });

  it('reports the cause and initializes again on the next call instead of caching the failure', async () => {
    let listing: () => Response = revokedKey;
    route([
      [/api\.openai\.com\/v1\/models/, () => listing()],
      [
        /api\.openai\.com\/v1\/chat\/completions/,
        () =>
          jsonResponse({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 1,
            model: 'gpt-4.1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Back online.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
      ],
    ]);
    const call = () =>
      generateText({
        provider: 'openai',
        model: 'gpt-4.1',
        apiKey: 'sk-recovering-key',
        prompt: 'Hello?',
        fallbackProviders: [],
      });

    await expect(call()).rejects.toMatchObject({
      name: 'ProviderInitializationError',
      providerId: 'openai',
      httpStatus: 401,
    });

    // The key works again (for example, the host restored it). The breaker
    // tripped on the 401 above; reset it so this call exercises the cache.
    listing = () =>
      jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
    globalLLMProviderHealth.reset();

    const recovered = await call();
    expect(recovered.text).toBe('Back online.');
    expect(requestsTo(/api\.openai\.com\/v1\/models/)).toBe(2);
  });
});
