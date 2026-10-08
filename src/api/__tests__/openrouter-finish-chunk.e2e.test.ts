/**
 * @file openrouter-finish-chunk.e2e.test.ts
 * Text that OpenRouter sends in the same chunk as `finish_reason` must reach
 * streamText's text stream and its final text.
 *
 * Drives streamText through the real provider manager and the real
 * OpenRouterProvider; only the provider's axios client is stubbed.
 */
import { Readable } from 'node:stream';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { streamText } from '../streamText.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

const MODEL = 'openai/gpt-4o';

/** An SSE body: one `data:` block per chunk, then `[DONE]`. */
function sse(chunks: Array<Record<string, unknown>>): Readable {
  const blocks = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).concat('data: [DONE]\n\n');
  return Readable.from(blocks.map((block) => Buffer.from(block)));
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
  return {
    id: 'gen-e2e',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  globalLLMProviderHealth.reset();
});

describe('streamText on OpenRouter', () => {
  it('keeps the text that arrives with the finish reason', async () => {
    const request = vi.fn(async (config: { url?: string }) => {
      if (config.url === '/models') {
        return {
          data: {
            data: [{ id: MODEL, name: 'GPT-4o', context_length: 128000, pricing: { prompt: '0', completion: '0' } }],
          },
        };
      }
      if (config.url === '/chat/completions') {
        return { data: sse([chunk({ role: 'assistant', content: 'Hello ' }, null), chunk({ content: 'world' }, 'stop')]) };
      }
      throw new Error(`unexpected request to ${config.url}`);
    });
    vi.spyOn(axios, 'create').mockReturnValue({
      request,
      get: vi.fn().mockResolvedValue({ data: { data: [] } }),
    } as never);

    const result = streamText({ provider: 'openrouter', model: MODEL, apiKey: 'sk-or-e2e', prompt: 'Say hello.' });

    let streamed = '';
    for await (const delta of result.textStream) streamed += delta;
    expect(streamed).toBe('Hello world');
    expect(await result.text).toBe('Hello world');
    expect(request.mock.calls.some(([config]) => config.url === '/chat/completions')).toBe(true);
  });
});
