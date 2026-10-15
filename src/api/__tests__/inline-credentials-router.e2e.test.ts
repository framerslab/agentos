/**
 * @file inline-credentials-router.e2e.test.ts
 * A call's own key goes only to the provider the call names. When a model
 * router moves the call to another provider, the request there carries that
 * provider's own key, as a fallback leg's does, and never the caller's.
 *
 * Drives generateText and streamText through the real provider manager and
 * AnthropicProvider; only fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateText } from '../generateText.js';
import { streamText } from '../streamText.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

/** A streamed message from Anthropic. */
function anthropicText(text: string): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_routed',
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

/** A router that sends every call to Anthropic. */
const toAnthropic = {
  routerId: 'to-anthropic',
  initialize: async () => undefined,
  selectModel: async () => ({ modelId: 'claude-opus-5-5', modelInfo: { providerId: 'anthropic' } }),
} as never;

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env');
  fetchMock.mockImplementation(async (url: unknown) => {
    if (/api\.anthropic\.com\/v1\/messages/.test(String(url))) return anthropicText('Routed.');
    throw new Error(`unexpected request ${String(url)}`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The x-api-key every request to Anthropic carried. */
const anthropicKeys = () =>
  fetchMock.mock.calls
    .filter(([url]) => /api\.anthropic\.com/.test(String(url)))
    .map(([, init]) => new Headers((init as RequestInit | undefined)?.headers).get('x-api-key'));

describe('a call a router moves to another provider', () => {
  it("generateText sends it on that provider's own key", async () => {
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: 'sk-openai-tenant',
      router: toAnthropic,
      prompt: 'Hello?',
      fallbackProviders: [],
    });

    expect(result.text).toBe('Routed.');
    expect(anthropicKeys()).toEqual(['sk-ant-env']);
  });

  it("streamText sends it on that provider's own key", async () => {
    const result = streamText({
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: 'sk-openai-tenant',
      router: toAnthropic,
      prompt: 'Hello?',
      fallbackProviders: [],
    });
    let text = '';
    for await (const delta of result.textStream) text += delta;

    expect(text).toBe('Routed.');
    expect(anthropicKeys()).toEqual(['sk-ant-env']);
  });
});
