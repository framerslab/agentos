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

import { generateText, buildFallbackChain } from '../generateText.js';
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

  it('preserves the explicit chain on recursion — never falls into the default cheap chain (gpt-4o-mini)', async () => {
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
      // cheap chain (the pre-fix bug), an openai/gpt-4o-mini hop would be tried
      // before openrouter:openai/gpt-5.5.
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

  // Policy-aware fallback: when policyTier is mature/private-adult AND
  // the primary refuses on a content_policy_violation, the auto-built
  // chain should include the uncensored Hermes 3 prefix and the
  // request should re-route there instead of hard-failing. Without
  // this branch, NSFW callers either had to roll their own fallback
  // or eat the 400. See `buildPolicyAwareFallbackChain` +
  // `isContentPolicyRefusal` for the full path.
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
      // A model-less OpenRouter entry silently defaults to the expensive
      // `openai/gpt-4o` in the OpenRouter provider, which made failover
      // traffic the #1 LLM cost in prod (2026-06-07). Pin a cheap
      // last-resort model so failover never lands on gpt-4o.
      expect(orEntry?.model).toBe('openai/gpt-4o-mini');
    } finally {
      if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalKey;
    }
  });
});
