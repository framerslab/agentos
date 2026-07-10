import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cache-diagnostics for the streaming path (`streamText`):
 *
 * - opting in forwards `{ previousMessageId }` to the provider stream call
 *   (`true` = null seed; object form = the caller's prior-turn message id)
 * - the final chunk's verdict + provider message id resolve on the result's
 *   `cacheDiagnostics` / `providerMessageId` promises
 * - without the option, the provider sees no cacheDiagnostics and both
 *   promises resolve null
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

/** One-step stream: a single final chunk carrying text + optional metadata. */
function finalChunk(extra: Record<string, unknown> = {}) {
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
      ...extra,
    };
  };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    void _chunk;
  }
}

describe('streamText cache diagnostics', () => {
  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
    hoisted.generateCompletionStream.mockReset();
  });

  it('forwards a null seed to the provider when opted in with `true`', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(
      finalChunk({ cacheDiagnostics: { cacheMissReason: null } }),
    );

    const result = await streamText({
      model: 'anthropic:claude-opus-4-8',
      prompt: 'stream it',
      cacheDiagnostics: true,
    });
    await drain(result.textStream);

    expect(hoisted.generateCompletionStream.mock.calls[0][2]?.cacheDiagnostics).toEqual({
      previousMessageId: null,
    });
    await expect(result.cacheDiagnostics).resolves.toEqual({ cacheMissReason: null });
    await expect(result.providerMessageId).resolves.toBe('msg_stream_final');
  });

  it('forwards the caller\'s prior-turn message id from the object form', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(
      finalChunk({
        cacheDiagnostics: {
          cacheMissReason: { type: 'system_changed', cacheMissedInputTokens: 900 },
        },
      }),
    );

    const result = await streamText({
      model: 'anthropic:claude-opus-4-8',
      prompt: 'next turn',
      cacheDiagnostics: { previousMessageId: 'msg_prior_turn' },
    });
    await drain(result.textStream);

    expect(hoisted.generateCompletionStream.mock.calls[0][2]?.cacheDiagnostics).toEqual({
      previousMessageId: 'msg_prior_turn',
    });
    await expect(result.cacheDiagnostics).resolves.toEqual({
      cacheMissReason: { type: 'system_changed', cacheMissedInputTokens: 900 },
    });
    await expect(result.providerMessageId).resolves.toBe('msg_stream_final');
  });

  it('sends nothing to the provider and resolves null when not opted in', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(finalChunk());

    const result = await streamText({
      model: 'anthropic:claude-opus-4-8',
      prompt: 'plain stream',
    });
    await drain(result.textStream);

    expect(hoisted.generateCompletionStream.mock.calls[0][2]?.cacheDiagnostics).toBeUndefined();
    await expect(result.cacheDiagnostics).resolves.toBeNull();
    await expect(result.providerMessageId).resolves.toBeNull();
  });
});
