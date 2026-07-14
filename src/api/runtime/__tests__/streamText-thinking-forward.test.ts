import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `streamText` step options must forward `thinking` and `effort` to the
 * provider stream call exactly like `generateText` does. Before this
 * coverage existed the fields were silently dropped: every streamed request
 * reached the provider non-thinking, which both discarded the caller's
 * reasoning depth and pinned the request to the non-thinking auto-cache
 * branch (no moving message-tail breakpoint alongside caller system
 * markers — the shape that left streamed conversation history uncached).
 */

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const generateCompletionStream = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion, generateCompletionStream }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, generateCompletionStream, getProvider, createProviderManager };
});

vi.mock('../../model.js', () => ({
  parseModelString: vi.fn(() => ({ providerId: 'anthropic', modelId: 'claude-opus-4-8' })),
  resolveModelOption: vi.fn(() => ({ providerId: 'anthropic', modelId: 'claude-opus-4-8' })),
  resolveProvider: vi.fn(() => ({
    providerId: 'anthropic',
    modelId: 'claude-opus-4-8',
    apiKey: 'test-key',
  })),
  createProviderManager: hoisted.createProviderManager,
}));

import { streamText } from '../streamText.js';

/** One-step stream: a single final chunk carrying text + usage. */
function finalChunk() {
  return async function* () {
    yield {
      id: 'msg_stream_final',
      modelId: 'claude-opus-4-8',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Streamed.' },
          finishReason: 'stop',
        },
      ],
      responseTextDelta: 'Streamed.',
      isFinal: true,
      usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
    };
  };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    void _chunk;
  }
}

describe('streamText thinking/effort forwarding', () => {
  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
    hoisted.generateCompletionStream.mockReset();
  });

  it('forwards thinking and effort to the provider stream options', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(finalChunk());

    const result = await streamText({
      model: 'anthropic:claude-opus-4-8',
      prompt: 'stream it',
      thinking: { budgetTokens: 2048 },
      effort: 'high',
    });
    await drain(result.textStream);

    const options = hoisted.generateCompletionStream.mock.calls[0][2] as Record<string, unknown>;
    expect(options.thinking).toEqual({ budgetTokens: 2048 });
    expect(options.effort).toBe('high');
  });

  it('omits thinking and effort from the provider options when the caller did not set them', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(finalChunk());

    const result = await streamText({
      model: 'anthropic:claude-opus-4-8',
      prompt: 'stream it',
    });
    await drain(result.textStream);

    const options = hoisted.generateCompletionStream.mock.calls[0][2] as Record<string, unknown>;
    expect('thinking' in options).toBe(false);
    expect('effort' in options).toBe(false);
  });
});
