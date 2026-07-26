/**
 * @file generationHooks.test.ts
 * Tests for generation lifecycle hooks on generateText/streamText.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

const mockGenerateCompletion = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    choices: [{ message: { content: 'original response', role: 'assistant' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }),
);

const mockGenerateCompletionStream = vi.hoisted(() =>
  vi.fn().mockImplementation(async function* () {
    yield {
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'streamed' },
          finishReason: 'stop',
        },
      ],
      responseTextDelta: 'streamed',
      isFinal: true,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }),
);

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn().mockReturnValue({ providerId: 'openai', modelId: 'gpt-4o' }),
  resolveProvider: vi.fn().mockReturnValue({ providerId: 'openai', modelId: 'gpt-4o' }),
  createProviderManager: vi.fn().mockResolvedValue({
    getProvider: vi.fn().mockReturnValue({
      generateCompletion: mockGenerateCompletion,
      generateCompletionStream: mockGenerateCompletionStream,
    }),
    getModelInfo: vi.fn().mockReturnValue(null),
  }),
}));

vi.mock('../../observability.js', () => ({
  attachUsageAttributes: vi.fn(),
  attachGenAiAttributes: vi.fn(),
  toTurnMetricUsage: vi.fn().mockReturnValue({}),
}));

// The provider-health circuit is module-global state: one test's intentional
// failure burst must not open the breaker for the rest of the file.
beforeEach(() => {
  globalLLMProviderHealth.reset();
});

vi.mock('../../../evaluation/observability/otel.js', () => ({
  withAgentOSSpan: vi.fn((_name: string, _attrs: unknown, fn?: Function) => {
    const callback = fn ?? _attrs;
    return typeof callback === 'function' ? (callback as Function)() : undefined;
  }),
  startAgentOSSpan: vi.fn().mockReturnValue({ end: vi.fn(), setAttribute: vi.fn() }),
  recordAgentOSTurnMetrics: vi.fn(),
}));

vi.mock('../usageLedger.js', () => ({
  recordAgentOSUsage: vi.fn().mockResolvedValue(undefined),
  getRecordedAgentOSUsage: vi.fn().mockResolvedValue({
    totalTokens: 0,
    totalCostUSD: 0,
    calls: 0,
  }),
}));

import { generateText } from '../../generateText.js';
import { streamText } from '../../streamText.js';

describe('Generation lifecycle hooks', () => {
  beforeEach(() => {
    mockGenerateCompletion.mockClear();
    mockGenerateCompletionStream.mockClear();
    // Reset default behavior
    mockGenerateCompletion.mockResolvedValue({
      choices: [{ message: { content: 'original response', role: 'assistant' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  describe('onBeforeGeneration', () => {
    it('receives correct context and can modify messages', async () => {
      const hook = vi.fn().mockImplementation((ctx) => ({
        ...ctx,
        messages: [
          { role: 'system' as const, content: 'injected context' },
          ...ctx.messages,
        ],
      }));

      await generateText({ prompt: 'hello', onBeforeGeneration: hook });

      expect(hook).toHaveBeenCalledOnce();
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.any(Array),
          model: 'gpt-4o',
          provider: 'openai',
          step: 0,
        }),
      );
      const callArgs = mockGenerateCompletion.mock.calls[0];
      const messages = callArgs[1];
      expect(messages[0]).toMatchObject({
        role: 'system',
        content: 'injected context',
      });
    });

    it('passes through unchanged when returning void', async () => {
      const hook = vi.fn();

      const result = await generateText({ prompt: 'hello', onBeforeGeneration: hook });

      expect(hook).toHaveBeenCalledOnce();
      expect(result.text).toBe('original response');
    });

    it('does not crash generation when hook throws', async () => {
      const hook = vi.fn().mockRejectedValue(new Error('hook failure'));

      const result = await generateText({ prompt: 'hello', onBeforeGeneration: hook });

      expect(result.text).toBe('original response');
    });
  });

  describe('onAfterGeneration', () => {
    it('can modify the response text', async () => {
      const hook = vi.fn().mockImplementation((result) => ({
        ...result,
        text: 'modified response',
      }));

      const result = await generateText({ prompt: 'hello', onAfterGeneration: hook });

      expect(hook).toHaveBeenCalledOnce();
      expect(result.text).toBe('modified response');
    });

    it('passes through unchanged when returning void', async () => {
      const hook = vi.fn();

      const result = await generateText({ prompt: 'hello', onAfterGeneration: hook });

      expect(result.text).toBe('original response');
    });

    it('does not crash generation when hook throws', async () => {
      const hook = vi.fn().mockRejectedValue(new Error('hook failure'));

      const result = await generateText({ prompt: 'hello', onAfterGeneration: hook });

      expect(result.text).toBe('original response');
    });
  });

  describe('onBeforeToolExecution', () => {
    it('can skip a tool call by returning null', async () => {
      mockGenerateCompletion
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                content: '',
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'tc1',
                    type: 'function',
                    function: { name: 'my_tool', arguments: '{"x":1}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
        .mockResolvedValueOnce({
          choices: [
            { message: { content: 'after tool skip', role: 'assistant' } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });

      const toolExecute = vi
        .fn()
        .mockResolvedValue({ success: true, output: 'result' });
      const tools = new Map([
        [
          'my_tool',
          {
            name: 'my_tool',
            description: 'test tool',
            inputSchema: {
              type: 'object',
              properties: { x: { type: 'number' } },
            },
            execute: toolExecute,
          },
        ],
      ]);

      const hook = vi.fn().mockResolvedValue(null);

      await generateText({
        prompt: 'hello',
        tools: tools as any,
        maxSteps: 2,
        onBeforeToolExecution: hook,
      });

      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'my_tool', args: { x: 1 } }),
      );
      expect(toolExecute).not.toHaveBeenCalled();
    });

    it('can modify tool arguments', async () => {
      mockGenerateCompletion
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                content: '',
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'tc1',
                    type: 'function',
                    function: { name: 'my_tool', arguments: '{"x":1}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'done', role: 'assistant' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });

      const toolExecute = vi
        .fn()
        .mockResolvedValue({ success: true, output: 'ok' });
      const tools = new Map([
        [
          'my_tool',
          {
            name: 'my_tool',
            description: 'test tool',
            inputSchema: {
              type: 'object',
              properties: { x: { type: 'number' } },
            },
            execute: toolExecute,
          },
        ],
      ]);

      const hook = vi.fn().mockImplementation((info) => ({
        ...info,
        args: { x: 999 },
      }));

      await generateText({
        prompt: 'hello',
        tools: tools as any,
        maxSteps: 2,
        onBeforeToolExecution: hook,
      });

      expect(toolExecute).toHaveBeenCalledWith({ x: 999 }, expect.any(Object));
    });
  });

  describe('hooks with streaming', () => {
    it('onBeforeGeneration runs before stream starts', async () => {
      const hook = vi.fn().mockImplementation((ctx) => ({
        ...ctx,
        messages: [
          { role: 'system' as const, content: 'injected' },
          ...ctx.messages,
        ],
      }));

      const result = streamText({ prompt: 'hello', onBeforeGeneration: hook });

      // Consume textStream to trigger execution
      const chunks: string[] = [];
      for await (const chunk of result.textStream) {
        chunks.push(chunk);
      }

      expect(hook).toHaveBeenCalledOnce();
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('onAfterGeneration is called after stream completes', async () => {
      const hook = vi.fn().mockImplementation((result) => ({
        ...result,
        text: 'modified streamed',
      }));

      const result = streamText({ prompt: 'hello', onAfterGeneration: hook });

      // Consume textStream to trigger execution
      for await (const _chunk of result.textStream) {
        // consume
      }

      // Wait for promises to settle
      await new Promise((r) => setTimeout(r, 100));
      expect(hook).toHaveBeenCalledOnce();
    });
  });

  describe('hooks + router compose', () => {
    it('router runs before hooks', async () => {
      const callOrder: string[] = [];

      const router = {
        routerId: 'test',
        initialize: vi.fn(),
        selectModel: vi.fn().mockImplementation(async () => {
          callOrder.push('router');
          return null;
        }),
      };

      const hook = vi.fn().mockImplementation(() => {
        callOrder.push('hook');
        return undefined;
      });

      await generateText({
        prompt: 'hello',
        router,
        onBeforeGeneration: hook,
      });

      expect(callOrder).toEqual(['router', 'hook']);
    });
  });
});
