/**
 * @file streamText-finishReason.test.ts
 * StreamTextResult.finishReason surfacing.
 *
 * The streaming API historically discarded the provider's finish reason:
 * the final chunk carries `choices[0].finishReason` (Anthropic maps
 * `max_tokens` → `length` in its adapter; OpenAI-compatible providers pass
 * `length` through verbatim), but `StreamTextResult` exposed no way to read
 * it and the usage-observer line fabricated `'stop'`. Hosts that persist
 * streamed prose as canonical (wilds-ai narrator) therefore cached
 * token-cap-truncated text as if it were complete.
 *
 * These tests pin the new contract: `result.finishReason` resolves to the
 * canonical `'stop' | 'length' | 'tool-calls' | 'error'` union when the
 * stream completes, normalized across provider vocabularies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const generateCompletionStream = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion, generateCompletionStream }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return {
    generateCompletion,
    generateCompletionStream,
    getProvider,
    createProviderManager,
  };
});

vi.mock('../../model.js', () => ({
  parseModelString: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4.1-mini' })),
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4.1-mini' })),
  resolveProvider: vi.fn(() => ({
    providerId: 'openai',
    modelId: 'gpt-4.1-mini',
    apiKey: 'test-key',
  })),
  createProviderManager: hoisted.createProviderManager,
}));

import { normalizeStreamFinishReason, streamText } from '../streamText.js';

/** Build a text-only final chunk with the given provider finish reason. */
function finalTextChunk(text: string, finishReason: string | null) {
  return {
    id: 'chunk-final',
    object: 'chat.completion.chunk',
    created: 1,
    modelId: 'gpt-4.1-mini',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finishReason,
      },
    ],
    responseTextDelta: text,
    isFinal: true,
    usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
  };
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

describe('streamText finishReason', () => {
  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
    hoisted.generateCompletionStream.mockReset();
  });

  it("resolves 'length' when the provider reports a token-cap truncation", async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield finalTextChunk('Truncated mid-sent', 'length');
    });

    const result = streamText({ model: 'openai:gpt-4.1-mini', prompt: 'Write a saga.' });
    const text = await drain(result.textStream);

    expect(text).toBe('Truncated mid-sent');
    await expect(result.finishReason).resolves.toBe('length');
  });

  it("normalizes the Anthropic raw 'max_tokens' vocabulary to 'length'", async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield finalTextChunk('Cut off', 'max_tokens');
    });

    const result = streamText({ model: 'openai:gpt-4.1-mini', prompt: 'Write.' });
    await drain(result.textStream);

    await expect(result.finishReason).resolves.toBe('length');
  });

  it("resolves 'stop' on a natural completion", async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield finalTextChunk('Done.', 'stop');
    });

    const result = streamText({ model: 'openai:gpt-4.1-mini', prompt: 'Say done.' });
    await drain(result.textStream);

    await expect(result.finishReason).resolves.toBe('stop');
  });

  it("resolves 'stop' when the provider omits a finish reason", async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield finalTextChunk('Done.', null);
    });

    const result = streamText({ model: 'openai:gpt-4.1-mini', prompt: 'Say done.' });
    await drain(result.textStream);

    await expect(result.finishReason).resolves.toBe('stop');
  });

  it("resolves 'error' when the stream yields an error chunk", async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield {
        id: 'chunk-err',
        object: 'chat.completion.chunk',
        created: 1,
        modelId: 'gpt-4.1-mini',
        choices: [],
        error: { message: 'upstream exploded' },
      };
    });

    const result = streamText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Fail.',
      fallbackProviders: [],
    });
    const parts: unknown[] = [];
    for await (const part of result.fullStream) parts.push(part);

    await expect(result.finishReason).resolves.toBe('error');
  });

  it('reports the LAST step reason on a multi-step tool run', async () => {
    // Step 1: model requests a tool call (finishReason tool_calls).
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield {
        id: 'chunk-tools',
        object: 'chat.completion.chunk',
        created: 1,
        modelId: 'gpt-4.1-mini',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"topic":"quic"}' },
                },
              ],
            },
            finishReason: 'tool_calls',
          },
        ],
        responseTextDelta: '',
        isFinal: true,
        usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      };
    });
    // Step 2: final prose step ends at the token cap.
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield finalTextChunk('Long answer that got cu', 'length');
    });

    const result = streamText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Explain QUIC.',
      maxSteps: 3,
      tools: {
        lookup: {
          description: 'Look up protocol context',
          parameters: {
            type: 'object',
            properties: { topic: { type: 'string' } },
            required: ['topic'],
          },
          execute: async () => ({ success: true, output: { context: 'quic facts' } }),
        },
      },
    });
    await drain(result.textStream);

    await expect(result.finishReason).resolves.toBe('length');
  });
});

describe('normalizeStreamFinishReason', () => {
  it('maps provider vocabularies onto the canonical union', () => {
    expect(normalizeStreamFinishReason('length')).toBe('length');
    expect(normalizeStreamFinishReason('max_tokens')).toBe('length');
    expect(normalizeStreamFinishReason('MAX_TOKENS')).toBe('length');
    expect(normalizeStreamFinishReason('model_length')).toBe('length');
    expect(normalizeStreamFinishReason('tool_calls')).toBe('tool-calls');
    expect(normalizeStreamFinishReason('tool-calls')).toBe('tool-calls');
    expect(normalizeStreamFinishReason('tool_use')).toBe('tool-calls');
    expect(normalizeStreamFinishReason('function_call')).toBe('tool-calls');
    expect(normalizeStreamFinishReason('stop')).toBe('stop');
    expect(normalizeStreamFinishReason('end_turn')).toBe('stop');
    expect(normalizeStreamFinishReason('stop_sequence')).toBe('stop');
    expect(normalizeStreamFinishReason('error')).toBe('error');
    expect(normalizeStreamFinishReason(null)).toBe('stop');
    expect(normalizeStreamFinishReason(undefined)).toBe('stop');
    // Unknown provider strings degrade to 'stop' (today's semantics).
    expect(normalizeStreamFinishReason('SAFETY')).toBe('stop');
  });
});
