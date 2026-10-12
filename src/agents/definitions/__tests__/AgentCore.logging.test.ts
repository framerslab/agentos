import { describe, expect, it, vi } from 'vitest';
import { AgentCore } from '../AgentCore.js';
import type { ModelCompletionResponse } from '../../../core/llm/providers/IProvider.js';

describe('AgentCore tool parsing diagnostics', () => {
  it('logs the tool name and arguments length without raw arguments or parser excerpts', () => {
    const sentinel = 'sentinel-words-7731';
    const agent = Object.assign(Object.create(AgentCore.prototype), {
      name: 'agent-1', isInitialized: true,
    }) as { parseLLMResponse(response: ModelCompletionResponse): { toolCalls?: unknown[] } };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = agent.parseLLMResponse({
        id: 'reply-1', object: 'chat.completion', created: 1, modelId: 'model-1',
        choices: [{ index: 0, finishReason: 'tool_calls', message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: sentinel } }],
        } }],
      });
      expect(result.toolCalls).toBeUndefined();
      expect(error).toHaveBeenCalledExactlyOnceWith("Agent 'agent-1': Failed to parse tool call arguments.", {
        toolName: 'lookup', callId: 'call-1', argumentsLength: sentinel.length, error: 'Invalid tool arguments JSON.',
      });
      expect(JSON.stringify(error.mock.calls)).not.toContain(sentinel);
    } finally {
      error.mockRestore();
    }
  });
});
