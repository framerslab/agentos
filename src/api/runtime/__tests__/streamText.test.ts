import * as os from 'node:os';
import * as path from 'node:path';

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

import { streamText } from '../streamText.js';
import { DEFAULT_COT_INSTRUCTION } from '../generateText.js';
import { clearRecordedAgentOSUsage, getRecordedAgentOSUsage } from '../usageLedger.js';

describe('streamText', () => {
  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
    hoisted.generateCompletionStream.mockReset();
  });

  it('applies planning and chain-of-thought before the streaming loop', async () => {
    hoisted.generateCompletion.mockResolvedValueOnce({
      modelId: 'gpt-4.1-mini',
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              steps: [
                {
                  description: 'Look up protocol context',
                  tool: 'lookup',
                  reasoning: 'Need supporting information',
                },
              ],
            }),
          },
          finishReason: 'stop',
        },
      ],
    });

    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield {
        id: 'step-1',
        object: 'chat.completion.chunk',
        created: 1,
        modelId: 'gpt-4.1-mini',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Done.' },
            finishReason: 'stop',
          },
        ],
        responseTextDelta: 'Done.',
        isFinal: true,
        usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
      };
    });

    const result = streamText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Explain QUIC.',
      system: 'You are a helper.',
      planning: true,
      chainOfThought: true,
      tools: {
        lookup: {
          description: 'Look up protocol context',
          parameters: {
            type: 'object',
            properties: { topic: { type: 'string' } },
            required: ['topic'],
          },
        },
      },
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['Done.']);
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
    const planningCallMessages = hoisted.generateCompletion.mock.calls[0][1];
    expect(planningCallMessages[0].content).toContain('planning');

    const streamedMessages = hoisted.generateCompletionStream.mock.calls[0][1];
    const systemMessages = streamedMessages.filter((m: any) => m.role === 'system');
    expect(systemMessages[0].content).toContain(DEFAULT_COT_INSTRUCTION);
    expect(systemMessages[0].content).toContain('You are a helper.');
    expect(systemMessages.some((m: any) => String(m.content).includes('Follow this plan'))).toBe(true);
    await expect(result.usage).resolves.toEqual({
      promptTokens: 24,
      completionTokens: 13,
      totalTokens: 37,
    });
  });

  it('executes streamed tool calls before continuing to the next step', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () {
        yield {
          id: 'step-1',
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
                    id: 'tool-1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"topic":"QUIC"}' },
                  },
                ],
              },
              finishReason: 'tool_calls',
            },
          ],
          isFinal: true,
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        };
      })
      .mockImplementationOnce(async function* () {
        yield {
          id: 'step-2a',
          object: 'chat.completion.chunk',
          created: 2,
          modelId: 'gpt-4.1-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'QUIC reduces handshake overhead.' },
              finishReason: null,
            },
          ],
          responseTextDelta: 'QUIC reduces handshake overhead.',
          isFinal: false,
        };
        yield {
          id: 'step-2b',
          object: 'chat.completion.chunk',
          created: 2,
          modelId: 'gpt-4.1-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'QUIC reduces handshake overhead.' },
              finishReason: 'stop',
            },
          ],
          isFinal: true,
          usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
        };
      });

    const result = streamText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Explain QUIC.',
      maxSteps: 2,
      tools: {
        lookup: {
          description: 'Look up protocol context',
          parameters: {
            type: 'object',
            properties: { topic: { type: 'string' } },
            required: ['topic'],
          },
          execute: vi.fn(async (args: { topic: string }) => ({
            summary: `context for ${args.topic}`,
          })),
        },
      },
    });

    const parts: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const part of result.fullStream) {
      parts.push(part as any);
    }

    expect(parts.map((part) => part.type)).toEqual(['tool-call', 'tool-result', 'text']);
    expect(parts[0]).toMatchObject({ toolName: 'lookup', args: { topic: 'QUIC' } });
    expect(parts[1]).toMatchObject({ toolName: 'lookup', result: { summary: 'context for QUIC' } });
    expect(await result.text).toBe('QUIC reduces handshake overhead.');
    expect(await result.usage).toEqual({ promptTokens: 17, completionTokens: 7, totalTokens: 24 });
    await expect(result.toolCalls).resolves.toEqual([
      {
        name: 'lookup',
        args: { topic: 'QUIC' },
        result: { summary: 'context for QUIC' },
      },
    ]);
  });

  it('parses text-based tool calls during streaming and continues the loop', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () {
        const toolText = [
          'Thought: I should use the lookup tool.',
          'Action: lookup',
          'Input: {"topic":"QUIC"}',
        ].join('\n');

        yield {
          id: 'step-1',
          object: 'chat.completion.chunk',
          created: 1,
          modelId: 'gpt-4.1-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: toolText },
              finishReason: 'stop',
            },
          ],
          responseTextDelta: toolText,
          isFinal: true,
          usage: { promptTokens: 8, completionTokens: 5, totalTokens: 13 },
        };
      })
      .mockImplementationOnce(async function* () {
        yield {
          id: 'step-2',
          object: 'chat.completion.chunk',
          created: 2,
          modelId: 'gpt-4.1-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'QUIC reduces handshake overhead.' },
              finishReason: 'stop',
            },
          ],
          responseTextDelta: 'QUIC reduces handshake overhead.',
          isFinal: true,
          usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 },
        };
      });

    const execute = vi.fn(async ({ topic }: { topic: string }) => ({
      success: true,
      output: { summary: `context for ${topic}` },
    }));

    const result = streamText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Explain QUIC.',
      maxSteps: 2,
      tools: {
        lookup: {
          description: 'Look up protocol context',
          parameters: {
            type: 'object',
            properties: { topic: { type: 'string' } },
            required: ['topic'],
          },
          execute,
        },
      },
    });

    const parts: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const part of result.fullStream) {
      parts.push(part as any);
    }

    expect(execute).toHaveBeenCalledTimes(1);
    expect(parts.some((part) => part.type === 'tool-call' && part.toolName === 'lookup')).toBe(true);
    expect(parts.some((part) => part.type === 'tool-result' && part.toolName === 'lookup')).toBe(true);
    await expect(result.text).resolves.toBe('QUIC reduces handshake overhead.');
    await expect(result.toolCalls).resolves.toEqual([
      {
        name: 'lookup',
        args: { topic: 'QUIC' },
        result: { summary: 'context for QUIC' },
      },
    ]);
  });

  it('uses onAfterGeneration text rewrites when continuing a streamed text-fallback tool loop', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () {
        const toolText = 'Action: lookup\nInput: {"topic":"QUIC"}';
        yield {
          id: 'step-1',
          object: 'chat.completion.chunk',
          created: 1,
          modelId: 'gpt-4.1-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: toolText },
              finishReason: 'stop',
            },
          ],
          responseTextDelta: toolText,
          isFinal: true,
          usage: { promptTokens: 8, completionTokens: 5, totalTokens: 13 },
        };
      })
      .mockImplementationOnce(async function* () {
        yield {
          id: 'step-2',
          object: 'chat.completion.chunk',
          created: 2,
          modelId: 'gpt-4.1-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'QUIC reduces handshake overhead.' },
              finishReason: 'stop',
            },
          ],
          responseTextDelta: 'QUIC reduces handshake overhead.',
          isFinal: true,
          usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 },
        };
      });

    const result = streamText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Explain QUIC.',
      maxSteps: 2,
      onAfterGeneration: async (stepResult) =>
        stepResult.toolCalls.length > 0
          ? { ...stepResult, text: 'Use the lookup tool before answering.' }
          : stepResult,
      tools: {
        lookup: {
          description: 'Look up protocol context',
          parameters: {
            type: 'object',
            properties: { topic: { type: 'string' } },
            required: ['topic'],
          },
          execute: vi.fn(async () => ({
            success: true,
            output: { summary: 'ctx' },
          })),
        },
      },
    });

    for await (const _part of result.fullStream) {
      // Drain the stream so the second generation step runs.
    }

    expect(hoisted.generateCompletionStream.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'Use the lookup tool before answering.',
        }),
      ])
    );
  });

  it('persists streaming usage when a ledger path is configured', async () => {
    const ledgerPath = path.join(os.tmpdir(), `agentos-stream-text-${Date.now()}.jsonl`);

    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield {
        id: 'step-1',
        object: 'chat.completion.chunk',
        created: 1,
        modelId: 'gpt-4.1-mini',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'streamed hello' },
            finishReason: 'stop',
          },
        ],
        responseTextDelta: 'streamed hello',
        isFinal: true,
        usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7, costUSD: 0.0007 },
      };
    });

    const result = streamText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'hi',
      usageLedger: { path: ledgerPath, sessionId: 'stream-session' },
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['streamed hello']);
    await expect(
      getRecordedAgentOSUsage({ path: ledgerPath, sessionId: 'stream-session' })
    ).resolves.toEqual({
      sessionId: 'stream-session',
      personaId: undefined,
      promptTokens: 4,
      completionTokens: 3,
      totalTokens: 7,
      costUSD: 0.0007,
      calls: 1,
    });

    await clearRecordedAgentOSUsage({ path: ledgerPath });
  });

  it('accepts external tool registries provided as Map instances', async () => {
    const observedContexts: any[] = [];

    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () {
        yield {
          id: 'step-1',
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
                    id: 'tool-1',
                    type: 'function',
                    function: {
                      name: 'open_profile',
                      arguments: '{"profileId":"profile-1"}',
                    },
                  },
                ],
              },
              finishReason: 'tool_calls',
            },
          ],
          isFinal: true,
          usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 },
        };
      })
      .mockImplementationOnce(async function* () {
        yield {
          id: 'step-2',
          object: 'chat.completion.chunk',
          created: 2,
          modelId: 'gpt-4.1-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Loaded your profile.' },
              finishReason: 'stop',
            },
          ],
          responseTextDelta: 'Loaded your profile.',
          isFinal: true,
          usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
        };
      });

    const result = streamText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Load my profile.',
      maxSteps: 2,
      tools: new Map([
        [
          'open_profile',
          {
            description: 'Load a saved profile record by ID.',
            inputSchema: {
              type: 'object',
              properties: {
                profileId: { type: 'string' },
              },
              required: ['profileId'],
            },
            execute: vi.fn(async ({ profileId }: { profileId: string }, context: any) => {
              observedContexts.push(context);
              return {
                success: true,
                output: { profile: { id: profileId, preferredTheme: 'solarized' } },
              };
            }),
          },
        ],
      ]),
    });

    const parts: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const part of result.fullStream) {
      parts.push(part as any);
    }

    expect(hoisted.generateCompletionStream.mock.calls[0]?.[2]?.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'open_profile',
          description: 'Load a saved profile record by ID.',
          parameters: {
            type: 'object',
            properties: {
              profileId: { type: 'string' },
            },
            required: ['profileId'],
          },
        },
      },
    ]);
    expect(parts.map((part) => part.type)).toEqual(['tool-call', 'tool-result', 'text']);
    expect(parts[1]).toMatchObject({
      type: 'tool-result',
      toolName: 'open_profile',
      result: { profile: { id: 'profile-1', preferredTheme: 'solarized' } },
    });
    await expect(result.toolCalls).resolves.toEqual([
      {
        name: 'open_profile',
        args: { profileId: 'profile-1' },
        result: { profile: { id: 'profile-1', preferredTheme: 'solarized' } },
      },
    ]);
    expect(observedContexts[0]).toMatchObject({
      gmiId: expect.stringMatching(/^streamText:/),
      personaId: 'streamText:persona',
      userContext: { userId: 'system', source: 'streamText' },
      correlationId: 'tool-1',
      sessionData: {
        source: 'streamText',
        stepIndex: 0,
        sessionId: expect.stringMatching(/^streamText:/),
      },
    });
  });

  it('propagates cacheReadInputTokens + cacheCreationInputTokens onto result.usage', async () => {
    // Final chunk from the provider mirrors Anthropic's streaming shape:
    // cache_read_input_tokens + cache_creation_input_tokens ride on the
    // usage object. streamText's accumulator must forward both onto the
    // aggregated TokenUsage so downstream cost trackers see cache hits.
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield {
        id: 'step-1',
        object: 'chat.completion.chunk',
        created: 1,
        modelId: 'gpt-4.1-mini',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Cached!' },
            finishReason: 'stop',
          },
        ],
        responseTextDelta: 'Cached!',
        isFinal: true,
        usage: {
          promptTokens: 100,
          completionTokens: 5,
          totalTokens: 105,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 15,
        },
      };
    });

    const result = streamText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Say hi.',
    });

    for await (const _ of result.fullStream) {
      // drain
    }
    const usage = await result.usage;
    expect(usage.cacheReadTokens).toBe(80);
    expect(usage.cacheCreationTokens).toBe(15);
  });

  it('sends the caller customModelParams with the planning call', async () => {
    const customModelParams = { provider: { data_collection: 'deny', order: ['Fireworks'] } };
    hoisted.generateCompletion.mockResolvedValueOnce({
      modelId: 'gpt-4.1-mini',
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({ steps: [{ description: 'Answer', tool: null, reasoning: 'Direct' }] }),
          },
          finishReason: 'stop',
        },
      ],
    });
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield {
        id: 'step-1',
        object: 'chat.completion.chunk',
        created: 1,
        modelId: 'gpt-4.1-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop' }],
        responseTextDelta: 'Done.',
        isFinal: true,
        usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
      };
    });

    const result = streamText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Explain QUIC.',
      planning: true,
      customModelParams,
    });
    for await (const _ of result.textStream) {
      // drain
    }

    expect(hoisted.generateCompletion.mock.calls[0][2].customModelParams).toEqual(customModelParams);
    expect(hoisted.generateCompletionStream.mock.calls[0][2].customModelParams).toEqual(customModelParams);
  });
});
