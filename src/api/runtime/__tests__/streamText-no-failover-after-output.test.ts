/**
 * @file streamText-no-failover-after-output.test.ts
 * A retryable failure before the first part fails over to the next provider;
 * the same failure after the stream has delivered text must not, or the
 * consumer receives the primary's partial answer followed by a fresh answer
 * from the fallback. The stream ends with an error part instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletionStream = vi.fn();
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletionStream, generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletionStream, generateCompletion, createProviderManager };
});

vi.mock('../../model.js', () => ({
  parseModelString: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4.1' })),
  resolveModelOption: vi.fn((o: { provider?: string; model?: string }) => ({
    providerId: o?.provider ?? 'openai',
    modelId: o?.model ?? 'gpt-4.1',
  })),
  resolveProvider: vi.fn((providerId?: string, modelId?: string) => ({
    providerId: providerId ?? 'openai',
    modelId: modelId ?? 'gpt-4.1',
    apiKey: 'test-key',
  })),
  createProviderManager: hoisted.createProviderManager,
}));

import { streamText } from '../../streamText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

function textChunk(text: string, isFinal = false) {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 1,
    modelId: 'gpt-4.1',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: isFinal ? 'stop' : null }],
    responseTextDelta: text,
    ...(isFinal ? { isFinal: true, usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } } : {}),
  };
}

/** The error a provider's SSE reader raises when the socket drops mid-body. */
function midStreamReset(): Error {
  return Object.assign(new Error('read ECONNRESET'), { code: 'STREAM_PARSING_ERROR' });
}

async function collect(stream: AsyncIterable<{ type: string }>) {
  const parts: Array<{ type: string } & Record<string, unknown>> = [];
  for await (const part of stream) parts.push(part as { type: string } & Record<string, unknown>);
  return parts;
}

beforeEach(() => {
  hoisted.generateCompletionStream.mockReset();
  hoisted.generateCompletion.mockReset();
  globalLLMProviderHealth.reset();
});

describe('streamText failover and delivered output', () => {
  it('fails over when the primary drops before delivering anything', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () {
        throw midStreamReset();
      })
      .mockImplementationOnce(async function* () {
        yield textChunk('from the fallback', true);
      });

    const result = streamText({
      provider: 'openai',
      model: 'gpt-4.1',
      prompt: 'Hello',
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
    });
    const parts = await collect(result.fullStream);

    expect(parts.filter((p) => p.type === 'text').map((p) => p.text)).toEqual(['from the fallback']);
    expect(hoisted.generateCompletionStream).toHaveBeenCalledTimes(2);
  });

  it('ends with an error instead of restarting on the fallback after text was delivered', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () {
        yield textChunk('partial ');
        throw midStreamReset();
      })
      .mockImplementationOnce(async function* () {
        yield textChunk('a fresh answer', true);
      });

    const result = streamText({
      provider: 'openai',
      model: 'gpt-4.1',
      prompt: 'Hello',
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
    });
    const parts = await collect(result.fullStream);

    expect(parts.filter((p) => p.type === 'text').map((p) => p.text)).toEqual(['partial ']);
    expect(parts[parts.length - 1]?.type).toBe('error');
    expect(await result.finishReason).toBe('error');
    expect(hoisted.generateCompletionStream).toHaveBeenCalledTimes(1);
  });

  it('does not fail over once a prompt-shim tool ran, even with no part delivered yet', async () => {
    // Frozen: noticing that the tool ran must not require wrapping the tool.
    const sendEmail = Object.freeze({
      id: 'send_email',
      name: 'send_email',
      displayName: 'Send email',
      description: 'Send an email.',
      inputSchema: { type: 'object', properties: {} },
      execute: vi.fn(async () => ({ success: true, output: { sent: true } })),
    });
    hoisted.generateCompletion
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1',
        usage: { totalTokens: 5 },
        choices: [
          {
            message: { role: 'assistant', content: '<tool_call>{"name":"send_email","arguments":{}}</tool_call>' },
            finishReason: 'stop',
          },
        ],
      })
      .mockRejectedValueOnce(midStreamReset());

    const result = streamText({
      provider: 'openai',
      model: 'gpt-4.1',
      prompt: 'Email Sam.',
      tools: [sendEmail] as never,
      toolMode: 'prompt',
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
    });
    const parts = await collect(result.fullStream);

    expect(sendEmail.execute).toHaveBeenCalledTimes(1);
    expect(parts[parts.length - 1]?.type).toBe('error');
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);
    expect(hoisted.generateCompletionStream).not.toHaveBeenCalled();
  });
});
