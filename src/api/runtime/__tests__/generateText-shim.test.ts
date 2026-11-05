import { beforeEach, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, getProvider, createProviderManager };
});
vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'uncensored-x' })),
  resolveProvider: vi.fn(() => ({ providerId: 'openai', modelId: 'uncensored-x', apiKey: 'k' })),
  createProviderManager: hoisted.createProviderManager,
}));

import { generateText } from '../generateText.js';
import { setGlobalLlmObserver, type LlmUsageEvent } from '../../observers.js';

const recall = {
  id: 'r', name: 'recall', displayName: 'R', description: 'recall past messages',
  inputSchema: { type: 'object', properties: {} },
  execute: vi.fn(async () => ({ success: true, output: { found: 'beach' } })),
};

const okStep = (content: string) => ({
  modelId: 'uncensored-x', usage: { totalTokens: 5 },
  choices: [{ message: { role: 'assistant', content }, finishReason: 'stop' }],
});

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
  recall.execute.mockClear();
});

it('toolMode:prompt runs the shim — emits <tool_call>, executes, returns the final answer', async () => {
  hoisted.generateCompletion
    .mockResolvedValueOnce(okStep('<tool_call>{"name":"recall","arguments":{}}</tool_call>'))
    .mockResolvedValueOnce(okStep('You went to the beach.'));

  const result = await generateText({
    model: 'openai:uncensored-x', prompt: 'where did I go?',
    tools: [recall] as any, toolMode: 'prompt', maxSteps: 5,
  });

  expect(recall.execute).toHaveBeenCalledTimes(1);
  expect(result.text).toBe('You went to the beach.');
  expect(result.finishReason).toBe('stop');
  // Shim sends NO native tools to the provider — schemas live in the prompt.
  const firstCallOpts = hoisted.generateCompletion.mock.calls[0][2];
  expect(firstCallOpts?.tools).toBeUndefined();
});

it('toolMode:auto falls back to the shim when the native call rejects tool use', async () => {
  hoisted.generateCompletion
    // native attempt with tools → provider rejects tool use
    .mockRejectedValueOnce(new Error('No endpoints found that support tool use. Try disabling tools.'))
    // shim roundtrips (no tools in payload)
    .mockResolvedValueOnce(okStep('<tool_call>{"name":"recall","arguments":{}}</tool_call>'))
    .mockResolvedValueOnce(okStep('You went to the beach.'));

  const result = await generateText({
    model: 'openai:uncensored-x', prompt: 'where did I go?',
    tools: [recall] as any, toolMode: 'auto', maxSteps: 5,
  });

  expect(recall.execute).toHaveBeenCalledTimes(1);
  expect(result.text).toBe('You went to the beach.');
  // the native attempt passed tools; the shim retries did not
  expect(hoisted.generateCompletion.mock.calls[0][2]?.tools).toBeDefined();
  expect(hoisted.generateCompletion.mock.calls[1][2]?.tools).toBeUndefined();
});

it("toolMode:prompt: the call's usage event carries the account its budget names", async () => {
  hoisted.generateCompletion.mockResolvedValueOnce(okStep('You went to the beach.'));
  const events: LlmUsageEvent[] = [];
  setGlobalLlmObserver((event) => {
    events.push(event);
  });
  try {
    await generateText({
      model: 'openai:uncensored-x', prompt: 'where did I go?',
      tools: [recall] as any, toolMode: 'prompt', maxSteps: 5,
      budget: { maxCostUSD: 100, unpriced: 'allow', accountId: 'acct-1' },
    });
  } finally {
    setGlobalLlmObserver(null);
  }
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ accountId: 'acct-1' });
});
