import { beforeEach, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const generateCompletionStream = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion, generateCompletionStream }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, generateCompletionStream, getProvider, createProviderManager };
});
vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'uncensored-x' })),
  resolveProvider: vi.fn(() => ({ providerId: 'openai', modelId: 'uncensored-x', apiKey: 'k' })),
  createProviderManager: hoisted.createProviderManager,
}));

import { streamText } from '../streamText.js';

const recall = {
  id: 'r', name: 'recall', displayName: 'R', description: 'recall',
  inputSchema: { type: 'object', properties: {} },
  execute: vi.fn(async () => ({ success: true, output: { found: 'beach' } })),
};

const okStep = (content: string) => ({
  modelId: 'uncensored-x', usage: { totalTokens: 5 },
  choices: [{ message: { role: 'assistant', content }, finishReason: 'stop' }],
});

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
  hoisted.generateCompletionStream.mockReset();
  recall.execute.mockClear();
});

it('toolMode:prompt streams the final answer after buffered tool hops', async () => {
  hoisted.generateCompletion
    .mockResolvedValueOnce(okStep('<tool_call>{"name":"recall","arguments":{}}</tool_call>'))
    .mockResolvedValueOnce(okStep('You went to the beach.'));

  const result = streamText({
    model: 'openai:uncensored-x', prompt: 'where did I go?',
    tools: [recall] as any, toolMode: 'prompt', maxSteps: 5,
  } as any);

  let streamed = '';
  for await (const chunk of result.textStream) streamed += chunk;

  expect(recall.execute).toHaveBeenCalledTimes(1);
  expect(streamed).toBe('You went to the beach.');
  await expect(result.text).resolves.toBe('You went to the beach.');
  await expect(result.toolCalls).resolves.toEqual([{ name: 'recall', args: {} }]);
});

it('toolMode:auto falls back to the shim when native streaming rejects tool use', async () => {
  // native streaming attempt (with tools) rejects tool use → reactive fallback
  hoisted.generateCompletionStream.mockImplementation(() => {
    throw new Error('No endpoints found that support tool use. Try disabling tools.');
  });
  hoisted.generateCompletion
    .mockResolvedValueOnce(okStep('<tool_call>{"name":"recall","arguments":{}}</tool_call>'))
    .mockResolvedValueOnce(okStep('You went to the beach.'));

  const result = streamText({
    model: 'openai:uncensored-x', prompt: 'where did I go?',
    tools: [recall] as any, toolMode: 'auto', maxSteps: 5,
  } as any);

  let streamed = '';
  for await (const chunk of result.textStream) streamed += chunk;

  expect(recall.execute).toHaveBeenCalledTimes(1);
  expect(streamed).toBe('You went to the beach.');
  await expect(result.text).resolves.toBe('You went to the beach.');
});

it('forwards thinking and effort through the shim callModel to generateCompletion', async () => {
  // The shim path (toolMode:prompt) drives the provider through
  // generateCompletion, not generateCompletionStream. Without forwarding
  // there, a thinking-capable streaming caller that emulates tools silently
  // loses its reasoning depth — the parity gap CodeRabbit caught in 0.9.140.
  hoisted.generateCompletion.mockResolvedValueOnce(okStep('done.'));

  const result = streamText({
    model: 'openai:uncensored-x', prompt: 'reason then answer',
    tools: [recall] as any, toolMode: 'prompt', maxSteps: 3,
    thinking: { budgetTokens: 2048 }, effort: 'high',
  } as any);
  for await (const _ of result.textStream) void _;

  const options = hoisted.generateCompletion.mock.calls[0][2] as Record<string, unknown>;
  expect(options.thinking).toEqual({ budgetTokens: 2048 });
  expect(options.effort).toBe('high');
});

it('omits thinking and effort from the shim callModel when the caller did not set them', async () => {
  hoisted.generateCompletion.mockResolvedValueOnce(okStep('done.'));

  const result = streamText({
    model: 'openai:uncensored-x', prompt: 'answer',
    tools: [recall] as any, toolMode: 'prompt', maxSteps: 3,
  } as any);
  for await (const _ of result.textStream) void _;

  const options = hoisted.generateCompletion.mock.calls[0][2] as Record<string, unknown>;
  expect('thinking' in options).toBe(false);
  expect('effort' in options).toBe(false);
});
