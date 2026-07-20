/**
 * @file agentPromptEngine.test.ts
 * Tests for PromptEngine, Memory, and Skills integration in agent().
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

const mockGenerateCompletion = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    choices: [{ message: { content: 'agent response', role: 'assistant' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }),
);

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn().mockReturnValue({ providerId: 'openai', modelId: 'gpt-4o' }),
  resolveProvider: vi.fn().mockReturnValue({ providerId: 'openai', modelId: 'gpt-4o' }),
  createProviderManager: vi.fn().mockResolvedValue({
    getProvider: vi.fn().mockReturnValue({
      generateCompletion: mockGenerateCompletion,
      generateCompletionStream: vi.fn().mockImplementation(async function* () {
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

import { agent } from '../../agent.js';

function createMockMemory() {
  return {
    getContext: vi.fn().mockResolvedValue({
      contextText: 'Memory: user likes hiking',
      tokensUsed: 50,
      includedMemoryIds: ['m1'],
    }),
    observe: vi.fn().mockResolvedValue(undefined),
    recall: vi.fn().mockResolvedValue({
      memories: [],
      partial: [],
      diagnostics: {},
    }),
    remember: vi.fn().mockResolvedValue({ success: true }),
    raw: undefined,
  } as any;
}

describe('agent() PromptEngine/Memory/Skills integration', () => {
  beforeEach(() => {
    mockGenerateCompletion.mockClear();
    mockGenerateCompletion.mockResolvedValue({
      choices: [{ message: { content: 'agent response', role: 'assistant' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  describe('skills injection', () => {
    it('appends skill content to system prompt', async () => {
      const a = agent({
        instructions: 'You are a companion.',
        skills: [
          {
            skill: {
              name: 'companion-writer',
              description: 'companion skill',
              content: '## Companion Rules\nBe warm and empathetic.',
            },
            frontmatter: {} as any,
          },
        ],
      });

      await a.generate('hello');

      const callArgs = mockGenerateCompletion.mock.calls[0];
      const messages = callArgs[1];
      const systemMsg = messages.find((m: any) => m.role === 'system');
      expect(systemMsg.content).toContain('You are a companion.');
      expect(systemMsg.content).toContain('## Companion Rules');
      expect(systemMsg.content).toContain('Be warm and empathetic.');
    });
  });

  describe('memoryProvider integration', () => {
    it('calls getContext before each session turn', async () => {
      const memory = createMockMemory();
      const a = agent({ instructions: 'test', memoryProvider: memory });
      const session = a.session('user-1');

      await session.send('hello');

      expect(memory.getContext).toHaveBeenCalledWith(
        'hello',
        expect.objectContaining({ tokenBudget: expect.any(Number) }),
      );
    });

    it('calls observe after each session turn', async () => {
      const memory = createMockMemory();
      const a = agent({ instructions: 'test', memoryProvider: memory });
      const session = a.session('user-1');

      await session.send('hello');

      expect(memory.observe).toHaveBeenCalledWith('user', 'hello');
      expect(memory.observe).toHaveBeenCalledWith('assistant', 'agent response');
    });

    it('prepends memory context to system prompt', async () => {
      const memory = createMockMemory();
      const a = agent({
        instructions: 'You are helpful.',
        memoryProvider: memory,
      });
      const session = a.session('user-1');

      await session.send('hello');

      const callArgs = mockGenerateCompletion.mock.calls[0];
      const messages = callArgs[1];
      const systemMsgs = messages.filter((m: any) => m.role === 'system');
      const combined = systemMsgs.map((m: any) => m.content).join('\n');
      expect(combined).toContain('Memory: user likes hiking');
    });

    it('does not crash when observe fails', async () => {
      const memory = createMockMemory();
      memory.observe.mockRejectedValue(new Error('observe failed'));

      const a = agent({ instructions: 'test', memoryProvider: memory });
      const session = a.session('user-1');

      const result = await session.send('hello');

      expect(result.text).toBe('agent response');
    });

    it('continues generation when memory getContext fails', async () => {
      const memory = createMockMemory();
      memory.getContext.mockRejectedValue(new Error('memory error'));

      const a = agent({ instructions: 'test', memoryProvider: memory });
      const session = a.session('user-1');

      const result = await session.send('hello');

      expect(result.text).toBe('agent response');
    });

    it('calls getContext before direct agent.generate() (new in 0.2.0)', async () => {
      const memory = createMockMemory();
      const a = agent({ instructions: 'test', memoryProvider: memory });

      await a.generate('hello from direct');

      expect(memory.getContext).toHaveBeenCalledWith(
        'hello from direct',
        expect.objectContaining({ tokenBudget: expect.any(Number) }),
      );
    });

    it('calls observe after direct agent.generate() (new in 0.2.0)', async () => {
      const memory = createMockMemory();
      const a = agent({ instructions: 'test', memoryProvider: memory });

      await a.generate('hello from direct');
      await new Promise((resolve) => setImmediate(resolve));

      expect(memory.observe).toHaveBeenCalledWith('user', 'hello from direct');
      expect(memory.observe).toHaveBeenCalledWith('assistant', 'agent response');
    });

    it('prepends memory context to direct agent.generate() system prompt (new in 0.2.0)', async () => {
      const memory = createMockMemory();
      const a = agent({
        instructions: 'You are helpful.',
        memoryProvider: memory,
      });

      await a.generate('hello from direct');

      const callArgs = mockGenerateCompletion.mock.calls[0];
      const messages = callArgs[1];
      const systemMsgs = messages.filter((m: any) => m.role === 'system');
      const combined = systemMsgs.map((m: any) => m.content).join('\n');
      expect(combined).toContain('Memory: user likes hiking');
    });

    it('calls getContext before direct agent.stream() (new in 0.2.0)', async () => {
      const memory = createMockMemory();
      const a = agent({ instructions: 'test', memoryProvider: memory });

      const streamResult = a.stream('hello from stream');
      // Drain the stream to ensure generation completes
      for await (const _chunk of streamResult.textStream) {
        // consume
      }
      await streamResult.text;

      expect(memory.getContext).toHaveBeenCalledWith(
        'hello from stream',
        expect.objectContaining({ tokenBudget: expect.any(Number) }),
      );
    });

    it('calls observe after direct agent.stream() completes (new in 0.2.0)', async () => {
      const memory = createMockMemory();
      const a = agent({ instructions: 'test', memoryProvider: memory });

      const streamResult = a.stream('hello from stream');
      for await (const _chunk of streamResult.textStream) {
        // consume
      }
      await streamResult.text;
      await new Promise((resolve) => setImmediate(resolve));

      expect(memory.observe).toHaveBeenCalledWith('user', 'hello from stream');
      expect(memory.observe).toHaveBeenCalledWith('assistant', 'streamed');
    });
  });

  describe('all three compose together', () => {
    it('memoryProvider + skills all work', async () => {
      const memory = createMockMemory();
      const a = agent({
        instructions: 'companion',
        memoryProvider: memory,
        skills: [
          {
            skill: {
              name: 'test-skill',
              description: 'test',
              content: 'skill content',
            },
            frontmatter: {} as any,
          },
        ],
      });
      const session = a.session('user-1');

      await session.send('hello');

      expect(memory.getContext).toHaveBeenCalled();
      expect(memory.observe).toHaveBeenCalledWith('user', 'hello');
      // System prompt should contain both skill content and memory
      const callArgs = mockGenerateCompletion.mock.calls[0];
      const messages = callArgs[1];
      const systemMsgs = messages.filter((m: any) => m.role === 'system');
      const combined = systemMsgs.map((m: any) => m.content).join('\n');
      expect(combined).toContain('skill content');
      expect(combined).toContain('Memory: user likes hiking');
    });
  });

  describe('existing behavior preserved', () => {
    it('works without any new options', async () => {
      const a = agent({ instructions: 'You are helpful.' });
      const result = await a.generate('hello');
      expect(result.text).toBe('agent response');
    });
  });
});
