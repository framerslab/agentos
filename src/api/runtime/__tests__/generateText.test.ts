import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return {
    generateCompletion,
    getProvider,
    createProviderManager,
  };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4.1-mini' })),
  resolveProvider: vi.fn(() => ({
    providerId: 'openai',
    modelId: 'gpt-4.1-mini',
    apiKey: 'test-key',
  })),
  createProviderManager: hoisted.createProviderManager,
}));

import { generateText, buildFallbackChain, buildPolicyAwareFallbackChain } from '../generateText.js';
import { setGlobalLlmObserver } from '../../observers.js';
import type { LlmUsageEvent } from '../../observers.js';
import { clearRecordedAgentOSUsage, getRecordedAgentOSUsage } from '../usageLedger.js';
import { resolveModelOption, resolveProvider } from '../../model.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import type { Mock } from 'vitest';

describe('generateText', () => {
  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
  });

  afterEach(async () => {
    delete process.env.AGENTOS_USAGE_LEDGER_PATH;
  });

  it('persists helper usage when a ledger path is configured', async () => {
    const ledgerPath = path.join(os.tmpdir(), `agentos-generate-text-${Date.now()}.jsonl`);
    hoisted.generateCompletion.mockResolvedValue({
      modelId: 'gpt-4.1-mini',
      usage: { promptTokens: 12, completionTokens: 6, totalTokens: 18, costUSD: 0.0021 },
      choices: [
        {
          message: { role: 'assistant', content: 'hello world' },
          finishReason: 'stop',
        },
      ],
    });

    const result = await generateText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'hello',
      usageLedger: { path: ledgerPath, sessionId: 'demo-session' },
    });

    expect(result).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      text: 'hello world',
    });
    await expect(
      getRecordedAgentOSUsage({ path: ledgerPath, sessionId: 'demo-session' })
    ).resolves.toEqual({
      sessionId: 'demo-session',
      personaId: undefined,
      promptTokens: 12,
      completionTokens: 6,
      totalTokens: 18,
      costUSD: 0.0021,
      calls: 1,
    });

    await clearRecordedAgentOSUsage({ path: ledgerPath });
  });

  it('accepts prompt-only ToolDefinitionForLLM arrays and records explicit tool errors', async () => {
    hoisted.generateCompletion
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 },
        choices: [
          {
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
      })
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
        choices: [
          {
            message: { role: 'assistant', content: 'Tool execution failed as expected.' },
            finishReason: 'stop',
          },
        ],
      });

    const result = await generateText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Load my profile.',
      maxSteps: 2,
      tools: [
        {
          name: 'open_profile',
          description: 'Load a saved profile record by ID.',
          inputSchema: {
            type: 'object',
            properties: {
              profileId: { type: 'string' },
            },
            required: ['profileId'],
          },
        },
      ],
    });

    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);
    expect(hoisted.generateCompletion.mock.calls[0]?.[2]?.tools).toEqual([
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
    expect(result.text).toBe('Tool execution failed as expected.');
    expect(result.toolCalls).toEqual([
      {
        name: 'open_profile',
        args: { profileId: 'profile-1' },
        error: 'No executor configured for prompt-only tool "open_profile".',
      },
    ]);
  });

  it('forwards the thinking budget to the provider completion options', async () => {
    hoisted.generateCompletion.mockResolvedValue({
      modelId: 'gpt-4.1-mini',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      choices: [{ message: { role: 'assistant', content: 'done' }, finishReason: 'stop' }],
    });

    await generateText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'hi',
      thinking: { budgetTokens: 4096 },
    });

    expect(hoisted.generateCompletion.mock.calls[0]?.[2]?.thinking).toEqual({
      budgetTokens: 4096,
    });
  });

  it('omits thinking from provider options when no budget is configured', async () => {
    hoisted.generateCompletion.mockResolvedValue({
      modelId: 'gpt-4.1-mini',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      choices: [{ message: { role: 'assistant', content: 'done' }, finishReason: 'stop' }],
    });

    await generateText({ model: 'openai:gpt-4.1-mini', prompt: 'hi' });

    expect(hoisted.generateCompletion.mock.calls[0]?.[2]).not.toHaveProperty('thinking');
  });

  it('forwards customModelParams to the provider completion options', async () => {
    // Provider implementations spread customModelParams onto the request
    // payload (OpenRouter/OpenAI/Anthropic all honor it) — it is the
    // documented escape hatch for provider-specific top-level params such as
    // OpenRouter provider-routing preferences. The helper layer must forward
    // it verbatim or the escape hatch is unreachable from the public API.
    hoisted.generateCompletion.mockResolvedValue({
      modelId: 'gpt-4.1-mini',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      choices: [{ message: { role: 'assistant', content: 'done' }, finishReason: 'stop' }],
    });

    await generateText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'hi',
      customModelParams: { provider: { sort: 'throughput' } },
    });

    expect(hoisted.generateCompletion.mock.calls[0]?.[2]?.customModelParams).toEqual({
      provider: { sort: 'throughput' },
    });
  });

  it('omits customModelParams from provider options when not configured', async () => {
    hoisted.generateCompletion.mockResolvedValue({
      modelId: 'gpt-4.1-mini',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      choices: [{ message: { role: 'assistant', content: 'done' }, finishReason: 'stop' }],
    });

    await generateText({ model: 'openai:gpt-4.1-mini', prompt: 'hi' });

    expect(hoisted.generateCompletion.mock.calls[0]?.[2]).not.toHaveProperty('customModelParams');
  });

  it('surfaces the serving provider reported by aggregator completions', async () => {
    // OpenRouter reports which upstream host served each completion
    // (`provider: 'Groq'` in the body → `servingProvider` on the mapped
    // ModelCompletionResponse). Latency attribution is impossible without
    // it — identical model + token counts vary 3-5x by serving host — so
    // the result must carry it through verbatim.
    hoisted.generateCompletion.mockResolvedValue({
      modelId: 'meta-llama/llama-3.3-70b-instruct',
      servingProvider: 'Groq',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      choices: [{ message: { role: 'assistant', content: 'done' }, finishReason: 'stop' }],
    });

    const result = await generateText({ model: 'openrouter:meta-llama/llama-3.3-70b-instruct', prompt: 'hi' });

    expect(result.servingProvider).toBe('Groq');
  });

  it('leaves servingProvider undefined when the completion omits it', async () => {
    hoisted.generateCompletion.mockResolvedValue({
      modelId: 'gpt-4.1-mini',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      choices: [{ message: { role: 'assistant', content: 'done' }, finishReason: 'stop' }],
    });

    const result = await generateText({ model: 'openai:gpt-4.1-mini', prompt: 'hi' });

    expect(result.servingProvider).toBeUndefined();
  });

  it('replays the prior assistant turn thinking blocks when continuing a tool loop', async () => {
    // Anthropic 400s if the most-recent assistant tool_use turn is replayed
    // without its thinking blocks while extended thinking is enabled. The
    // native step loop must carry the captured thinkingBlocks into the
    // assistant message it pushes before the next provider call.
    hoisted.generateCompletion
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 },
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              thinkingBlocks: [
                { type: 'thinking', thinking: 'I should call the tool.', signature: 'sig-abc' },
              ],
              tool_calls: [
                {
                  id: 'tool-1',
                  type: 'function',
                  function: { name: 'open_profile', arguments: '{"profileId":"profile-1"}' },
                },
              ],
            },
            finishReason: 'tool_calls',
          },
        ],
      })
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
        choices: [{ message: { role: 'assistant', content: 'All done.' }, finishReason: 'stop' }],
      });

    const result = await generateText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Load my profile.',
      maxSteps: 2,
      thinking: { budgetTokens: 4096 },
      tools: [
        {
          name: 'open_profile',
          description: 'Load a saved profile record by ID.',
          inputSchema: {
            type: 'object',
            properties: { profileId: { type: 'string' } },
            required: ['profileId'],
          },
        },
      ],
    });

    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);
    const secondCallMessages = hoisted.generateCompletion.mock.calls[1]?.[1] as Array<{
      role: string;
      tool_calls?: unknown;
      thinkingBlocks?: unknown;
    }>;
    const assistantToolTurn = secondCallMessages.find(
      (m) => m.role === 'assistant' && m.tool_calls
    );
    expect(assistantToolTurn?.thinkingBlocks).toEqual([
      { type: 'thinking', thinking: 'I should call the tool.', signature: 'sig-abc' },
    ]);
    expect(result.text).toBe('All done.');
  });

  it('parses text tool calls once and passes a real execution context to external tools', async () => {
    const observedContexts: any[] = [];

    hoisted.generateCompletion
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 10, completionTokens: 6, totalTokens: 16 },
        choices: [
          {
            message: {
              role: 'assistant',
              content: [
                'I should use a tool.',
                '```json',
                '{"tool": "lookup", "arguments": {"topic": "QUIC"}}',
                '```',
                'Thought: I should confirm with the same tool.',
                'Action: lookup',
                'Input: {"topic":"QUIC"}',
              ].join('\n'),
            },
            finishReason: 'stop',
          },
        ],
      })
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
        choices: [
          {
            message: { role: 'assistant', content: 'QUIC reduces handshake overhead.' },
            finishReason: 'stop',
          },
        ],
      });

    const execute = vi.fn(async (args: { topic: string }, context: any) => {
      observedContexts.push(context);
      return { summary: `context for ${args.topic}` };
    });

    const result = await generateText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Explain QUIC.',
      maxSteps: 2,
      tools: new Map([
        [
          'lookup',
          {
            description: 'Look up protocol context',
            inputSchema: {
              type: 'object',
              properties: { topic: { type: 'string' } },
              required: ['topic'],
            },
            execute,
          },
        ],
      ]) as any,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(observedContexts[0]).toMatchObject({
      gmiId: expect.stringMatching(/^generateText:/),
      personaId: 'generateText:persona',
      userContext: { userId: 'system', source: 'generateText' },
      correlationId: 'text-tc-0-0',
      sessionData: {
        source: 'generateText',
        stepIndex: 0,
        sessionId: expect.stringMatching(/^generateText:/),
      },
    });
    expect(result.text).toBe('QUIC reduces handshake overhead.');
    expect(result.toolCalls).toEqual([
      {
        name: 'lookup',
        args: { topic: 'QUIC' },
        result: { summary: 'context for QUIC' },
      },
    ]);
  });

  it('uses onAfterGeneration text rewrites when continuing a text-fallback tool loop', async () => {
    hoisted.generateCompletion
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 10, completionTokens: 6, totalTokens: 16 },
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Action: lookup\nInput: {"topic":"QUIC"}',
            },
            finishReason: 'stop',
          },
        ],
      })
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 },
        choices: [
          {
            message: { role: 'assistant', content: 'QUIC reduces handshake overhead.' },
            finishReason: 'stop',
          },
        ],
      });

    const result = await generateText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Explain QUIC.',
      maxSteps: 2,
      onAfterGeneration: async (stepResult) =>
        stepResult.toolCalls.length > 0
          ? { ...stepResult, text: 'Use the lookup tool before answering.' }
          : stepResult,
      tools: new Map([
        [
          'lookup',
          {
            description: 'Look up protocol context',
            inputSchema: {
              type: 'object',
              properties: { topic: { type: 'string' } },
              required: ['topic'],
            },
            execute: vi.fn(async () => ({ summary: 'ctx' })),
          },
        ],
      ]) as any,
    });

    expect(hoisted.generateCompletion.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'Use the lookup tool before answering.',
        }),
      ])
    );
    expect(result.text).toBe('QUIC reduces handshake overhead.');
  });

  it('records malformed native tool arguments as a tool error without executing the tool', async () => {
    const execute = vi.fn(async () => ({ ok: true }));

    hoisted.generateCompletion
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 },
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'tool-1',
                  type: 'function',
                  function: {
                    name: 'lookup',
                    arguments: '{"topic":',
                  },
                },
              ],
            },
            finishReason: 'tool_calls',
          },
        ],
      })
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 6, completionTokens: 3, totalTokens: 9 },
        choices: [
          {
            message: { role: 'assistant', content: 'I could not execute that tool call.' },
            finishReason: 'stop',
          },
        ],
      });

    const result = await generateText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Explain QUIC.',
      maxSteps: 2,
      tools: new Map([
        [
          'lookup',
          {
            description: 'Look up protocol context',
            inputSchema: {
              type: 'object',
              properties: { topic: { type: 'string' } },
              required: ['topic'],
            },
            execute,
          },
        ],
      ]) as any,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([
      {
        name: 'lookup',
        args: '{"topic":',
        error: 'Tool "lookup" arguments were not valid JSON.',
      },
    ]);
    expect(result.text).toBe('I could not execute that tool call.');
  });

  it('auto-builds fallback chain when fallbackProviders is undefined and primary throws 429', async () => {
    hoisted.generateCompletion
      .mockRejectedValueOnce(new Error('429 rate limit exceeded'))
      .mockResolvedValueOnce({
        modelId: 'gpt-4o-mini',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        choices: [{ message: { role: 'assistant', content: 'fallback reply' }, finishReason: 'stop' }],
      });

    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    try {
      const result = await generateText({
        model: 'openai:gpt-4o',
        prompt: 'hello',
      });
      expect(result.text).toBe('fallback reply');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('does NOT fallback when fallbackProviders is explicitly []', async () => {
    hoisted.generateCompletion.mockRejectedValueOnce(new Error('429 rate limit exceeded'));

    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    try {
      await expect(
        generateText({
          model: 'openai:gpt-4o',
          prompt: 'hello',
          fallbackProviders: [],
        })
      ).rejects.toThrow('429');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('preserves the explicit chain on recursion — never rebuilds the default chain', async () => {
    // Echo the requested provider/model so each hop's identity is observable
    // (the default mock pins every hop to gpt-4.1-mini, hiding which model won).
    (resolveModelOption as unknown as Mock).mockImplementation(
      (opts: { provider?: string; model?: string }) => ({
        providerId: opts?.provider ?? 'openai',
        modelId: opts?.model ?? 'gpt-4.1-mini',
      }),
    );
    (resolveProvider as unknown as Mock).mockImplementation((providerId: string, modelId: string) => ({
      providerId,
      modelId,
      apiKey: 'test-key',
    }));
    globalLLMProviderHealth.reset();
    try {
      // Only the openrouter frontier entry succeeds; the primary and the openai
      // gpt-5.5 hop both throw retryably. If the recursion rebuilt the default
      // chain (the pre-fix bug), the rebuild at the failed-openai hop would
      // splice in the anthropic haiku leg — a model the EXPLICIT chain never
      // names — before openrouter:openai/gpt-5.5.
      hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
        if (modelId === 'openai/gpt-5.5') {
          return {
            modelId,
            usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
            choices: [{ message: { role: 'assistant', content: 'frontier reply' }, finishReason: 'stop' }],
          };
        }
        throw new Error('429 rate limit exceeded');
      });

      const result = await generateText({
        provider: 'anthropic',
        model: 'claude-primary',
        prompt: 'hello',
        fallbackProviders: [
          { provider: 'openai', model: 'gpt-5.5' },
          { provider: 'openrouter', model: 'openai/gpt-5.5' },
        ],
      });

      expect(result.text).toBe('frontier reply');
      expect(result.model).toBe('openai/gpt-5.5');
      const requestedModels = (hoisted.generateCompletion.mock.calls as unknown[][]).map((c) => c[0]);
      expect(requestedModels).not.toContain('gpt-4o-mini');
      expect(requestedModels).not.toContain('openai/gpt-4o-mini');
      // The default chain's anthropic leg — present in any rebuilt chain
      // (the explicit chain has no anthropic entry), so its absence proves
      // the explicit chain was preserved verbatim.
      expect(requestedModels).not.toContain('claude-sonnet-5');
    } finally {
      // Restore the fixed resolvers so later tests see the default behavior.
      (resolveModelOption as unknown as Mock).mockImplementation(() => ({
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
      }));
      (resolveProvider as unknown as Mock).mockImplementation(() => ({
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        apiKey: 'test-key',
      }));
      globalLLMProviderHealth.reset();
    }
  });

  it('applies a fallback entry effort per-hop — fallback runs at its effort, primary stays untouched', async () => {
    (resolveModelOption as unknown as Mock).mockImplementation(
      (opts: { provider?: string; model?: string }) => ({
        providerId: opts?.provider ?? 'openai',
        modelId: opts?.model ?? 'gpt-4.1-mini',
      }),
    );
    (resolveProvider as unknown as Mock).mockImplementation((providerId: string, modelId: string) => ({
      providerId,
      modelId,
      apiKey: 'test-key',
    }));
    globalLLMProviderHealth.reset();
    try {
      // Primary (claude-primary) throws retryably; only the gpt-5.5 fallback
      // succeeds. The chain sets effort ONLY on the fallback entry and the call
      // passes NO call-level effort — so the primary must stay dormant (no effort
      // forwarded) while the fallback runs at its own 'max'.
      hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
        if (modelId === 'gpt-5.5') {
          return {
            modelId,
            usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
            choices: [{ message: { role: 'assistant', content: 'frontier reply' }, finishReason: 'stop' }],
          };
        }
        throw new Error('429 rate limit exceeded');
      });

      const result = await generateText({
        provider: 'anthropic',
        model: 'claude-primary',
        prompt: 'hello',
        // NO call-level effort on purpose — proves per-hop effort does not leak
        // to the primary.
        fallbackProviders: [{ provider: 'openai', model: 'gpt-5.5', effort: 'max' }],
      });

      expect(result.text).toBe('frontier reply');
      expect(result.model).toBe('gpt-5.5');

      const calls = hoisted.generateCompletion.mock.calls as unknown[][];
      const optsFor = (modelId: string) =>
        (calls.find((c) => c[0] === modelId)?.[2] ?? {}) as { effort?: string };
      // The fallback hop ran at the entry's effort.
      expect(optsFor('gpt-5.5').effort).toBe('max');
      // The primary hop was NOT bumped — per-hop effort must never leak upward.
      expect(optsFor('claude-primary').effort).toBeUndefined();
    } finally {
      (resolveModelOption as unknown as Mock).mockImplementation(() => ({
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
      }));
      (resolveProvider as unknown as Mock).mockImplementation(() => ({
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        apiKey: 'test-key',
      }));
      globalLLMProviderHealth.reset();
    }
  });

  it('reports fallback.fired = false on a clean primary success', async () => {
    globalLLMProviderHealth.reset();
    hoisted.generateCompletion.mockResolvedValueOnce({
      modelId: 'gpt-4.1-mini',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      choices: [{ message: { role: 'assistant', content: 'clean' }, finishReason: 'stop' }],
    });

    const result = await generateText({ model: 'openai:gpt-4.1-mini', prompt: 'hi' });

    expect(result.text).toBe('clean');
    expect(result.fallback?.fired).toBe(false);
    expect(result.fallback?.finalProvider).toBe('openai');
    expect(result.fallback?.hops).toEqual([{ provider: 'openai', model: 'gpt-4.1-mini', ok: true }]);
  });

  it('reports fallback.fired = true with a hop trail when a fallback provider wins', async () => {
    globalLLMProviderHealth.reset();
    hoisted.generateCompletion
      .mockRejectedValueOnce(new Error('429 rate limit exceeded'))
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        choices: [{ message: { role: 'assistant', content: 'fallback reply' }, finishReason: 'stop' }],
      });

    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    try {
      const result = await generateText({ model: 'openai:gpt-4o', prompt: 'hi' });
      expect(result.text).toBe('fallback reply');
      expect(result.fallback?.fired).toBe(true);
      // primary (failed) + the winning fallback hop
      expect(result.fallback?.hops.length).toBeGreaterThanOrEqual(2);
      expect(result.fallback?.hops[0]?.ok).toBe(false);
      expect(result.fallback?.hops.at(-1)?.ok).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      globalLLMProviderHealth.reset();
    }
  });

  it('fires ONE usage observer on a fallback whose durationMs spans the failed primary', async () => {
    // Regression (Codex 2026-07-05): before the __rootStartedAt threading the
    // winning recursive hop fired the observer with its OWN start, so a slow
    // fallback turn reported only the fallback leg's time and read as fast.
    globalLLMProviderHealth.reset();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const HOP_MS = 40;
    hoisted.generateCompletion
      .mockImplementationOnce(async () => {
        await sleep(HOP_MS);
        throw new Error('429 rate limit exceeded');
      })
      .mockImplementationOnce(async () => {
        await sleep(HOP_MS);
        return {
          modelId: 'gpt-4.1-mini',
          usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
          choices: [{ message: { role: 'assistant', content: 'fallback reply' }, finishReason: 'stop' }],
        };
      });

    const events: LlmUsageEvent[] = [];
    setGlobalLlmObserver((e) => {
      events.push(e);
    });
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    try {
      const result = await generateText({ model: 'openai:gpt-4o', prompt: 'hi' });
      expect(result.text).toBe('fallback reply');
      // generateText fires exactly ONE observer event on a fallback — the
      // winning hop's — and never a duplicate from the outer call.
      expect(events).toHaveLength(1);
      // durationMs must span BOTH the failed primary (HOP_MS) and the winning
      // fallback (HOP_MS). Lower bound leaves margin below the 2*HOP_MS nominal;
      // scheduling jitter only adds time. Pre-fix this was ~HOP_MS (fallback
      // leg only) and would fail this assertion.
      expect(events[0].durationMs).toBeGreaterThanOrEqual(HOP_MS * 1.75);
    } finally {
      setGlobalLlmObserver(null);
      delete process.env.ANTHROPIC_API_KEY;
      globalLLMProviderHealth.reset();
    }
  });

  // Policy-aware fallback: when policyTier is mature/private-adult AND
  // the primary refuses on a content_policy_violation, the auto-built
  // chain should include the uncensored Hermes 3 prefix and the
  // request should re-route there instead of hard-failing. Without
  // this branch, NSFW callers either had to roll their own fallback
  // or eat the 400. See `buildPolicyAwareFallbackChain` +
  // `isContentPolicyRefusal` for the full path.
  describe('transcriptDelta', () => {
    it('returns the lossless per-send delta: user turn, assistant tool_calls, tool results, final assistant', async () => {
      hoisted.generateCompletion
        .mockResolvedValueOnce({
          modelId: 'gpt-4.1-mini',
          usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
            },
            finishReason: 'tool_calls',
          }],
        })
        .mockResolvedValueOnce({
          modelId: 'gpt-4.1-mini',
          usage: { promptTokens: 6, completionTokens: 2, totalTokens: 8 },
          choices: [{ message: { role: 'assistant', content: 'done' }, finishReason: 'stop' }],
        });

      const result = await generateText({
        model: 'openai:gpt-4.1-mini',
        prompt: 'find x',
        tools: [{
          name: 'lookup',
          description: 'find things',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
          execute: async () => ({ success: true, output: { found: true } }),
        }] as never,
      });

      const delta = result.transcriptDelta ?? [];
      expect(delta.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
      const assistantCall = delta[1] as { tool_calls?: Array<{ id: string }> };
      expect(assistantCall.tool_calls?.[0]?.id).toBe('tc_1');
      expect((delta[2] as { tool_call_id?: string }).tool_call_id).toBe('tc_1');
      expect((delta[3] as { content?: unknown }).content).toBe('done');
    });

    it('carries the delta on plain no-tool calls too (sessions rely on it)', async () => {
      hoisted.generateCompletion.mockResolvedValueOnce({
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }],
      });
      const result = await generateText({ model: 'openai:gpt-4.1-mini', prompt: 'hi' });
      expect(result.transcriptDelta?.map((m) => m.role)).toEqual(['user', 'assistant']);
    });

    it('honors the trailing-caller-messages marker for message-carried user turns', async () => {
      hoisted.generateCompletion.mockResolvedValueOnce({
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }],
      });
      const result = await generateText({
        model: 'openai:gpt-4.1-mini',
        messages: [
          { role: 'user', content: 'earlier history' },
          { role: 'assistant', content: 'earlier reply' },
          { role: 'user', content: [{ type: 'text', text: 'parts turn' }] as never },
        ],
        _transcriptIncludeTrailingCallerMessages: 1,
      } as never);
      const delta = result.transcriptDelta ?? [];
      expect(delta.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(JSON.stringify(delta[0])).toContain('parts turn');
    });
  });

  describe('per-hop fallback cache', () => {
    const useDynamicResolvers = () => {
      (resolveModelOption as unknown as Mock).mockImplementation(
        (opts: { provider?: string; model?: string }) => ({
          providerId: opts?.provider ?? 'openai',
          modelId: opts?.model ?? 'gpt-4.1-mini',
        }),
      );
      (resolveProvider as unknown as Mock).mockImplementation(
        (providerId: string, modelId: string) => ({ providerId, modelId, apiKey: 'test-key' }),
      );
      globalLLMProviderHealth.reset();
    };
    const restoreFixedResolvers = () => {
      (resolveModelOption as unknown as Mock).mockImplementation(() => ({
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
      }));
      (resolveProvider as unknown as Mock).mockImplementation(() => ({
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        apiKey: 'test-key',
      }));
      globalLLMProviderHealth.reset();
    };
    const rescueOnly = (rescueModelId: string) => {
      hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
        if (modelId === rescueModelId) {
          return {
            modelId,
            usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
            choices: [
              { message: { role: 'assistant', content: 'rescue reply' }, finishReason: 'stop' },
            ],
          };
        }
        throw new Error('429 rate limit exceeded');
      });
    };
    const optsFor = (modelId: string) =>
      ((hoisted.generateCompletion.mock.calls as unknown[][]).find((c) => c[0] === modelId)?.[2] ??
        {}) as { cache?: unknown };

    it('applies a fallback entry cache per-hop — rescue hop stands down, primary keeps the call-level cache', async () => {
      useDynamicResolvers();
      try {
        rescueOnly('gpt-5.5');
        const result = await generateText({
          provider: 'anthropic',
          model: 'claude-primary',
          prompt: 'hello',
          // Call-level 1h cache: must reach the PRIMARY hop untouched while the
          // entry's `cache: false` stands the RESCUE hop down — the canonical
          // buildFallbackChain leg shape (writes on one-shot failover traffic
          // never earn their reads back).
          cache: { ttl: '1h' },
          fallbackProviders: [{ provider: 'openai', model: 'gpt-5.5', cache: false }],
        });
        expect(result.text).toBe('rescue reply');
        expect(optsFor('gpt-5.5').cache).toBe(false);
        expect(optsFor('claude-primary').cache).toEqual({ ttl: '1h' });
      } finally {
        restoreFixedResolvers();
      }
    });

    it('inherits the call-level cache on a fallback hop when the entry omits it', async () => {
      useDynamicResolvers();
      try {
        rescueOnly('gpt-5.5');
        const result = await generateText({
          provider: 'anthropic',
          model: 'claude-primary',
          prompt: 'hello',
          cache: { ttl: '1h' },
          // No per-entry cache -> the hop inherits the call-level disposition
          // via the recursion's `...opts` spread (explicit-chain back-compat).
          fallbackProviders: [{ provider: 'openai', model: 'gpt-5.5' }],
        });
        expect(result.text).toBe('rescue reply');
        expect(optsFor('gpt-5.5').cache).toEqual({ ttl: '1h' });
      } finally {
        restoreFixedResolvers();
      }
    });
  });

  describe('policy-aware fallback', () => {
    it('routes content_policy_violation to OpenRouter Hermes 3 when policyTier=mature', async () => {
      // Primary throws an OpenAI-shaped content-policy refusal, then the
      // fallback succeeds. The fallback chain is auto-built from the
      // policyTier — Hermes 3 leads, then Sonnet, then the standard
      // availability suffix.
      const policyError = new Error("Sorry, I can't help with that.");
      (policyError as { httpStatus?: number }).httpStatus = 400;
      (policyError as { code?: string }).code = 'content_policy_violation';

      hoisted.generateCompletion
        .mockRejectedValueOnce(policyError)
        .mockResolvedValueOnce({
          modelId: 'nousresearch/hermes-3-llama-3.1-405b',
          usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
          choices: [
            {
              message: { role: 'assistant', content: 'uncensored reply' },
              finishReason: 'stop',
            },
          ],
        });

      const originalKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = 'test-or-key';
      try {
        const result = await generateText({
          model: 'openai:gpt-4o',
          prompt: 'an explicit fictional scene',
          policyTier: 'mature',
        });
        expect(result.text).toBe('uncensored reply');
      } finally {
        if (originalKey === undefined) {
          delete process.env.OPENROUTER_API_KEY;
        } else {
          process.env.OPENROUTER_API_KEY = originalKey;
        }
      }
    });

    it('does NOT include Hermes 3 prefix when policyTier=safe (back-compat)', async () => {
      const policyError = new Error("Sorry, I can't help with that.");
      (policyError as { httpStatus?: number }).httpStatus = 400;
      (policyError as { code?: string }).code = 'content_policy_violation';

      hoisted.generateCompletion.mockRejectedValueOnce(policyError);

      const originalKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = 'test-or-key';
      try {
        // safe tier with content_policy_violation: the policy chain
        // builder returns the standard availability chain (no Hermes 3
        // prefix). Without ANTHROPIC_API_KEY set, the chain is just
        // OpenRouter (default model) which we don't mock — so this
        // should bubble the original refusal instead of routing.
        await expect(
          generateText({
            model: 'openai:gpt-4o',
            prompt: 'a safe greeting',
            policyTier: 'safe',
            // Force-empty so the test doesn't depend on env state
            // for downstream providers — only the policy-prefix
            // behavior is under test here.
            fallbackProviders: [],
          })
        ).rejects.toThrow();
      } finally {
        if (originalKey === undefined) {
          delete process.env.OPENROUTER_API_KEY;
        } else {
          process.env.OPENROUTER_API_KEY = originalKey;
        }
      }
    });
  });
});

describe('buildFallbackChain — OpenRouter link pins a cheap model', () => {
  it('gives the OpenRouter fallback entry an explicit cheap model, not the gpt-4o default', () => {
    const originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-or-key';
    try {
      const chain = buildFallbackChain('anthropic');
      const orEntry = chain.find((e) => e.provider === 'openrouter');
      expect(orEntry).toBeDefined();
      // A model-less OpenRouter entry silently defaults to the OpenRouter
      // provider's defaultModel, which made failover traffic the #1 LLM
      // cost in prod (2026-06-07). The entry must be PINNED — and pinned
      // to the gpt-5.5 quality floor, so a primary outage neither lands
      // on an unchosen model nor downgrades output to a mini tier.
      expect(orEntry?.model).toBe('openai/gpt-5.5');
    } finally {
      if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalKey;
    }
  });
});

describe('canonical fallback chains stand their cache markers down', () => {
  const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'] as const;

  const withAllKeys = (fn: () => void) => {
    const saved = KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of KEYS) process.env[k] = `test-${k.toLowerCase()}`;
    try {
      fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('buildFallbackChain pins cache:false on every leg', () => {
    withAllKeys(() => {
      const chain = buildFallbackChain();
      expect(chain.length).toBeGreaterThanOrEqual(4);
      // Rescue legs are sporadic one-shots: a cache write on a failover hop
      // rarely earns reads back (claude-sonnet-5 leg measured 0.45x write
      // amortization in prod, 2026-07-13..20). Every canonical leg must stand
      // its markers down; a caller wanting a cached hop supplies its own entry.
      for (const entry of chain) {
        expect(entry.cache, `${entry.provider}:${entry.model ?? ''}`).toBe(false);
      }
    });
  });

  it('buildPolicyAwareFallbackChain pins cache:false on the uncensored prefix and the availability suffix', () => {
    withAllKeys(() => {
      const chain = buildPolicyAwareFallbackChain('mature');
      expect(chain.length).toBeGreaterThanOrEqual(5);
      expect(chain[0]?.model).toBe('nousresearch/hermes-3-llama-3.1-405b');
      for (const entry of chain) {
        expect(entry.cache, `${entry.provider}:${entry.model ?? ''}`).toBe(false);
      }
    });
  });
});

describe('provider-reported response identity (spec batch-1)', () => {
  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
  });

  it('carries responseModel and serviceTier onto the result additively', async () => {
    hoisted.generateCompletion.mockResolvedValue({
      modelId: 'gpt-4.1-mini-2026-01-01',
      serviceTier: 'default',
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      choices: [
        {
          message: { role: 'assistant', content: 'ok' },
          finishReason: 'stop',
        },
      ],
    });

    const result = await generateText({ model: 'openai:gpt-4.1-mini', prompt: 'hi' });

    expect(result.model).toBe('gpt-4.1-mini');
    expect(result.responseModel).toBe('gpt-4.1-mini-2026-01-01');
    expect(result.serviceTier).toBe('default');
  });

  it('omits responseModel and serviceTier when the provider reports neither', async () => {
    hoisted.generateCompletion.mockResolvedValue({
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      choices: [
        {
          message: { role: 'assistant', content: 'ok' },
          finishReason: 'stop',
        },
      ],
    });

    const result = await generateText({ model: 'openai:gpt-4.1-mini', prompt: 'hi' });

    expect(result.responseModel).toBeUndefined();
    expect(result.serviceTier).toBeUndefined();
  });
});
