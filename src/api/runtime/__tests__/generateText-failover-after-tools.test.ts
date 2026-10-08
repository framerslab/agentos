/**
 * @file generateText-failover-after-tools.test.ts
 * A provider failure after a tool round must not run that tool again. With
 * native tool calls, the fallback provider continues the conversation from
 * the completed rounds (it sees the call and its result). The prompt-tool
 * shim keeps its rounds to itself, so a shim call whose tools ran surfaces
 * the error instead of failing over.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion }));
  const createProviderManager = vi.fn(async (_resolved: { providerId: string }) => ({ getProvider }));
  return { generateCompletion, getProvider, createProviderManager };
});

vi.mock('../../model.js', () => ({
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

import { generateText } from '../../generateText.js';
import { setGlobalLlmObserver, type LlmUsageEvent } from '../../observers.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

const sendEmail = {
  id: 'send_email',
  name: 'send_email',
  displayName: 'Send email',
  description: 'Send an email.',
  inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
  execute: vi.fn(async () => ({ success: true, output: { sent: true } })),
};

function timeout(): Error {
  return Object.assign(new Error('Request timed out after 60000ms.'), { code: 'REQUEST_TIMEOUT' });
}

const usage = { promptTokens: 5, completionTokens: 5, totalTokens: 10 };

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
  hoisted.createProviderManager.mockImplementation(async () => ({ getProvider: hoisted.getProvider }));
  sendEmail.execute.mockClear();
  globalLLMProviderHealth.reset();
});

/** A step that asks for one native send_email call. */
function nativeToolCall() {
  return {
    modelId: 'gpt-4.1',
    usage,
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'send_email', arguments: '{"to":"sam@example.com"}' } },
          ],
        },
        finishReason: 'tool_calls',
      },
    ],
  };
}

function textStep(modelId: string, text: string) {
  return {
    modelId,
    usage,
    choices: [{ message: { role: 'assistant', content: text }, finishReason: 'stop' }],
  };
}

describe('generateText failover after a tool ran', () => {
  it('continues on the fallback from the completed tool round instead of running the tool again', async () => {
    hoisted.generateCompletion
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1',
        usage,
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'send_email', arguments: '{"to":"sam@example.com"}' } },
              ],
            },
            finishReason: 'tool_calls',
          },
        ],
      })
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce({
        modelId: 'claude-opus-5-5',
        usage,
        choices: [{ message: { role: 'assistant', content: 'Sent it.' }, finishReason: 'stop' }],
      });

    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      prompt: 'Email Sam.',
      tools: [sendEmail] as never,
      maxSteps: 5,
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
    });

    expect(sendEmail.execute).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Sent it.');
    expect(result.provider).toBe('anthropic');
    expect(result.toolCalls.map((c) => c.name)).toEqual(['send_email']);

    const legCall = hoisted.generateCompletion.mock.calls[2] as unknown[];
    expect(legCall[0]).toBe('claude-opus-5-5');
    const legMessages = legCall[1] as Array<Record<string, unknown>>;
    expect(legMessages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(legMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Email Sam.' }),
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [expect.objectContaining({ id: 'call_1' })],
        }),
        expect.objectContaining({ role: 'tool', tool_call_id: 'call_1' }),
      ]),
    );
    // A session records the whole call, primary round included.
    expect(result.transcriptDelta?.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('keeps the tool session, step numbering and prompt when the fallback continues', async () => {
    hoisted.generateCompletion
      .mockResolvedValueOnce(nativeToolCall())
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce({
        modelId: 'claude-opus-5-5',
        usage,
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_2', type: 'function', function: { name: 'send_email', arguments: '{"to":"kai@example.com"}' } },
              ],
            },
            finishReason: 'tool_calls',
          },
        ],
      })
      .mockResolvedValueOnce(textStep('claude-opus-5-5', 'Sent both.'));
    const hookSteps: number[] = [];
    const hookPrompts: Array<string | undefined> = [];

    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      prompt: 'Email Sam, then Kai.',
      tools: [sendEmail] as never,
      maxSteps: 5,
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
      onBeforeGeneration: async (ctx) => {
        hookPrompts.push(ctx.prompt);
        return undefined;
      },
      onBeforeToolExecution: async (info) => {
        hookSteps.push(info.step);
        return info;
      },
    });

    expect(result.text).toBe('Sent both.');
    const contexts = sendEmail.execute.mock.calls.map(
      (call) => (call as unknown[])[1] as { sessionData: { sessionId: string; stepIndex: number } },
    );
    expect(contexts).toHaveLength(2);
    // One tool session across both providers, and steps counted on.
    expect(contexts[1].sessionData.sessionId).toBe(contexts[0].sessionData.sessionId);
    expect(contexts.map((c) => c.sessionData.stepIndex)).toEqual([0, 1]);
    expect(hookSteps).toEqual([0, 1]);
    // Every generation, the fallback's included, sees the caller's prompt.
    expect(hookPrompts).toEqual(Array(hookPrompts.length).fill('Email Sam, then Kai.'));
    expect(hookPrompts.length).toBeGreaterThanOrEqual(3);
  });

  it('continues on Claude without a thinking budget when another model ran the tool round', async () => {
    hoisted.generateCompletion
      .mockResolvedValueOnce(nativeToolCall())
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(textStep('claude-sonnet-4-5', 'Sent it.'));

    await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      prompt: 'Email Sam.',
      tools: [sendEmail] as never,
      maxSteps: 5,
      thinking: { budgetTokens: 2048 },
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-sonnet-4-5' }],
    });

    const optionsOf = (call: number) =>
      (hoisted.generateCompletion.mock.calls[call] as unknown[])[2] as { thinking?: unknown };
    expect(optionsOf(0).thinking).toEqual({ budgetTokens: 2048 });
    // The OpenAI tool turn has no signed thinking for Claude to open with.
    expect(optionsOf(2).thinking).toBeUndefined();
  });

  it('keeps thinking off on a Claude continuation when the caller turned it off', async () => {
    hoisted.generateCompletion
      .mockResolvedValueOnce(nativeToolCall())
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(textStep('claude-opus-5', 'Sent it.'));

    await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      prompt: 'Email Sam.',
      tools: [sendEmail] as never,
      maxSteps: 5,
      thinking: false,
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5' }],
    });

    const legOptions = (hoisted.generateCompletion.mock.calls[2] as unknown[])[2] as { thinking?: unknown };
    expect(legOptions.thinking).toBe(false);
  });

  it('reports the tokens a prompt-shim round consumed when a later call fails', async () => {
    const events: LlmUsageEvent[] = [];
    setGlobalLlmObserver((event) => {
      events.push(event);
    });
    try {
      hoisted.generateCompletion
        .mockResolvedValueOnce(
          textStep('gpt-4.1', '<tool_call>{"name":"send_email","arguments":{"to":"sam@example.com"}}</tool_call>'),
        )
        .mockRejectedValueOnce(timeout());

      await expect(
        generateText({
          provider: 'openai',
          model: 'gpt-4.1',
          prompt: 'Email Sam.',
          tools: [sendEmail] as never,
          toolMode: 'prompt',
          maxSteps: 5,
          fallbackProviders: [],
        }),
      ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });

      // The completed round's 10 tokens, metered once as the failed attempt.
      expect(events.map((e) => [e.finishReason, e.usage.totalTokens])).toEqual([['error', 10]]);
    } finally {
      setGlobalLlmObserver(null);
    }
  });

  it('surfaces the error instead of failing over once a prompt-shim tool ran', async () => {
    hoisted.generateCompletion
      .mockResolvedValueOnce({
        modelId: 'gpt-4.1',
        usage,
        choices: [
          {
            message: {
              role: 'assistant',
              content: '<tool_call>{"name":"send_email","arguments":{"to":"sam@example.com"}}</tool_call>',
            },
            finishReason: 'stop',
          },
        ],
      })
      .mockRejectedValueOnce(timeout());

    await expect(
      generateText({
        provider: 'openai',
        model: 'gpt-4.1',
        prompt: 'Email Sam.',
        tools: [sendEmail] as never,
        toolMode: 'prompt',
        maxSteps: 5,
        fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });

    expect(sendEmail.execute).toHaveBeenCalledTimes(1);
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);
  });

  it('keeps the caller\'s own system messages in the conversation a continuation carries', async () => {
    hoisted.generateCompletion
      .mockResolvedValueOnce(nativeToolCall())
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(textStep('claude-opus-5-5', 'Envoyé.'));

    await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      system: 'You are an assistant.',
      messages: [{ role: 'system', content: 'Always answer in French.' }],
      prompt: 'Email Sam.',
      tools: [sendEmail] as never,
      maxSteps: 5,
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
    });

    const legMessages = (hoisted.generateCompletion.mock.calls[2] as unknown[])[1] as Array<Record<string, unknown>>;
    const systemTexts = legMessages.filter((m) => m.role === 'system').map((m) => m.content);
    expect(systemTexts).toContain('Always answer in French.');
    // The generated system prompt is rebuilt once, not carried over a second time.
    expect(systemTexts.filter((t) => typeof t === 'string' && t.includes('You are an assistant.'))).toHaveLength(1);
    expect(sendEmail.execute).toHaveBeenCalledTimes(1);
  });

  it('renders the completed native round as shim text when the fallback cannot take native tools', async () => {
    hoisted.generateCompletion
      .mockResolvedValueOnce(nativeToolCall())
      .mockRejectedValueOnce(timeout())
      .mockRejectedValueOnce(new Error('No endpoints found that support tool use. Try disabling tools.'))
      .mockResolvedValueOnce(textStep('claude-opus-5-5', 'Sent it.'));

    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      prompt: 'Email Sam.',
      tools: [sendEmail] as never,
      maxSteps: 5,
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
    });

    expect(result.text).toBe('Sent it.');
    expect(sendEmail.execute).toHaveBeenCalledTimes(1);
    const shimMessages = (hoisted.generateCompletion.mock.calls[3] as unknown[])[1] as Array<{ role: string; content: string }>;
    expect(shimMessages.some((m) => m.role === 'tool')).toBe(false);
    expect(shimMessages.some((m) => m.role === 'assistant' && m.content.includes('<tool_call>{"name":"send_email"'))).toBe(true);
    expect(shimMessages.some((m) => m.role === 'user' && m.content.startsWith('<tool_response>'))).toBe(true);
  });

  it('continues a fallback leg\'s native tool round on the next leg instead of running the tool again', async () => {
    // The primary cannot initialize; the first leg makes a native send_email
    // call, then times out. That leg's own walk carries the completed round
    // to the second leg, which answers from it.
    hoisted.createProviderManager.mockImplementation(async (resolved: { providerId: string }) => {
      if (resolved.providerId === 'openai') {
        throw Object.assign(new Error("Provider 'openai' failed to initialize: 401"), {
          name: 'ProviderInitializationError',
          httpStatus: 401,
        });
      }
      return { getProvider: hoisted.getProvider };
    });
    hoisted.generateCompletion
      .mockResolvedValueOnce(nativeToolCall())
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(textStep('mistral-large-latest', 'Sent it.'));

    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      prompt: 'Email Sam.',
      tools: [sendEmail] as never,
      maxSteps: 5,
      fallbackProviders: [
        { provider: 'anthropic', model: 'claude-opus-5-5' },
        { provider: 'mistral', model: 'mistral-large-latest' },
      ],
    });

    expect(sendEmail.execute).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Sent it.');
    expect(result.provider).toBe('mistral');
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(3);
    const legMessages = (hoisted.generateCompletion.mock.calls[2] as unknown[])[1] as Array<Record<string, unknown>>;
    expect(legMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'call_1' })] }),
        expect.objectContaining({ role: 'tool', tool_call_id: 'call_1' }),
      ]),
    );
  });

  it('stops walking the chain when a fallback leg ran tools before it failed', async () => {
    // The primary cannot initialize; the first leg runs a prompt-shim tool
    // and then times out. The second leg must not start over and send again.
    hoisted.createProviderManager.mockImplementation(async (resolved: { providerId: string }) => {
      if (resolved.providerId === 'openai') {
        throw Object.assign(new Error("Provider 'openai' failed to initialize: 401"), {
          name: 'ProviderInitializationError',
          httpStatus: 401,
        });
      }
      return { getProvider: hoisted.getProvider };
    });
    hoisted.generateCompletion
      .mockResolvedValueOnce(
        textStep('claude-opus-5-5', '<tool_call>{"name":"send_email","arguments":{"to":"sam@example.com"}}</tool_call>'),
      )
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(
        textStep('mistral-large-latest', '<tool_call>{"name":"send_email","arguments":{"to":"sam@example.com"}}</tool_call>'),
      )
      .mockResolvedValueOnce(textStep('mistral-large-latest', 'Sent it.'));

    await expect(
      generateText({
        provider: 'openai',
        model: 'gpt-4.1',
        prompt: 'Email Sam.',
        tools: [sendEmail] as never,
        toolMode: 'prompt',
        maxSteps: 5,
        fallbackProviders: [
          { provider: 'anthropic', model: 'claude-opus-5-5' },
          { provider: 'mistral', model: 'mistral-large-latest' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });

    expect(sendEmail.execute).toHaveBeenCalledTimes(1);
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);
  });

  it('runs a frozen prompt-shim tool and still refuses to fail over after it ran', async () => {
    const execute = vi.fn(async () => ({ success: true, output: { sent: true } }));
    const frozenTool = Object.freeze({ ...sendEmail, execute });
    hoisted.generateCompletion
      .mockResolvedValueOnce(
        textStep('gpt-4.1', '<tool_call>{"name":"send_email","arguments":{"to":"sam@example.com"}}</tool_call>'),
      )
      .mockRejectedValueOnce(timeout());

    await expect(
      generateText({
        provider: 'openai',
        model: 'gpt-4.1',
        prompt: 'Email Sam.',
        tools: [frozenTool] as never,
        toolMode: 'prompt',
        maxSteps: 5,
        fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }],
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);
  });

  it('runs a prompt-shim tool written as a class whose getters read private fields', async () => {
    class LookupTool {
      #name = 'lookup';
      readonly id = 'lookup';
      readonly displayName = 'Lookup';
      readonly inputSchema = { type: 'object', properties: {} };
      get name(): string {
        return this.#name;
      }
      get description(): string {
        return `Look something up (${this.#name}).`;
      }
      async execute() {
        return { success: true, output: { found: this.#name } };
      }
    }
    hoisted.generateCompletion
      .mockResolvedValueOnce(textStep('gpt-4.1', '<tool_call>{"name":"lookup","arguments":{}}</tool_call>'))
      .mockResolvedValueOnce(textStep('gpt-4.1', 'Found it.'));

    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      prompt: 'Look it up.',
      tools: [new LookupTool()] as never,
      toolMode: 'prompt',
      maxSteps: 5,
      fallbackProviders: [],
    });

    expect(result.text).toBe('Found it.');
    const secondCall = (hoisted.generateCompletion.mock.calls[1] as unknown[])[1] as Array<{ content: string }>;
    expect(secondCall.some((m) => m.content.includes('"found":"lookup"'))).toBe(true);
  });
});
