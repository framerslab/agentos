import { beforeEach, expect, it, vi } from 'vitest';

/**
 * Cache-diagnostics auto-threading across the agentic loop
 * (`GenerateTextOptions.cacheDiagnostics`):
 *
 * - step 1 opts in with `previousMessageId: null`
 * - step N passes step N-1's provider message id
 * - per-step verdicts reach the onAfterGeneration hook
 * - the final result carries the LAST step's verdict
 * - without the option, no cacheDiagnostics ever reaches the provider
 */

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, getProvider, createProviderManager };
});
vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'anthropic', modelId: 'claude-opus-4-8' })),
  resolveProvider: vi.fn(() => ({ providerId: 'anthropic', modelId: 'claude-opus-4-8', apiKey: 'k' })),
  createProviderManager: hoisted.createProviderManager,
}));

import { generateText } from '../generateText.js';

const echo = {
  id: 'echo',
  name: 'echo',
  displayName: 'Echo',
  description: 'echo the input back',
  inputSchema: { type: 'object', properties: {} },
  execute: vi.fn(async () => ({ success: true, output: { ok: true } })),
};

/** A step response that requests one native tool call. */
const toolStep = (id: string, diagnostics?: unknown) => ({
  id,
  modelId: 'claude-opus-4-8',
  usage: { totalTokens: 7 },
  ...(diagnostics !== undefined ? { cacheDiagnostics: diagnostics } : {}),
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'echo', arguments: '{}' } },
        ],
      },
      finishReason: 'tool_calls',
    },
  ],
});

/** A terminal text step. */
const textStep = (id: string, content: string, diagnostics?: unknown) => ({
  id,
  modelId: 'claude-opus-4-8',
  usage: { totalTokens: 5 },
  ...(diagnostics !== undefined ? { cacheDiagnostics: diagnostics } : {}),
  choices: [{ message: { role: 'assistant', content }, finishReason: 'stop' }],
});

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
  echo.execute.mockClear();
});

it('threads each step\'s message id into the next step\'s previousMessageId', async () => {
  hoisted.generateCompletion
    .mockResolvedValueOnce(toolStep('msg_step_1', null))
    .mockResolvedValueOnce(
      textStep('msg_step_2', 'Done.', { cacheMissReason: null }),
    );

  const result = await generateText({
    model: 'anthropic:claude-opus-4-8',
    prompt: 'do the thing',
    tools: [echo] as any,
    maxSteps: 5,
    cacheDiagnostics: true,
  });

  expect(result.text).toBe('Done.');
  // Step 1: first-turn opt-in with nothing to compare.
  expect(hoisted.generateCompletion.mock.calls[0][2]?.cacheDiagnostics).toEqual({
    previousMessageId: null,
  });
  // Step 2: threads step 1's provider message id.
  expect(hoisted.generateCompletion.mock.calls[1][2]?.cacheDiagnostics).toEqual({
    previousMessageId: 'msg_step_1',
  });
  // The final result carries the LAST step's verdict.
  expect(result.cacheDiagnostics).toEqual({ cacheMissReason: null });
});

it('surfaces per-step verdicts on the onAfterGeneration hook', async () => {
  hoisted.generateCompletion
    .mockResolvedValueOnce(toolStep('msg_a', null))
    .mockResolvedValueOnce(
      textStep('msg_b', 'Finished.', {
        cacheMissReason: { type: 'messages_changed', cacheMissedInputTokens: 512 },
      }),
    );

  const seen: unknown[] = [];
  const result = await generateText({
    model: 'anthropic:claude-opus-4-8',
    prompt: 'go',
    tools: [echo] as any,
    maxSteps: 5,
    cacheDiagnostics: true,
    onAfterGeneration: async (hookResult) => {
      seen.push((hookResult as { cacheDiagnostics?: unknown }).cacheDiagnostics);
    },
  });

  expect(seen).toEqual([
    null,
    { cacheMissReason: { type: 'messages_changed', cacheMissedInputTokens: 512 } },
  ]);
  expect(result.cacheDiagnostics).toEqual({
    cacheMissReason: { type: 'messages_changed', cacheMissedInputTokens: 512 },
  });
});

it('sends no cacheDiagnostics option to the provider when not opted in', async () => {
  hoisted.generateCompletion.mockResolvedValueOnce(textStep('msg_x', 'Plain.'));

  const result = await generateText({
    model: 'anthropic:claude-opus-4-8',
    prompt: 'plain run',
  });

  expect(result.text).toBe('Plain.');
  expect(hoisted.generateCompletion.mock.calls[0][2]?.cacheDiagnostics).toBeUndefined();
  expect(result.cacheDiagnostics).toBeUndefined();
});

it('seeds the FIRST step from the object form so cross-request threading works', async () => {
  hoisted.generateCompletion
    .mockResolvedValueOnce(toolStep('msg_step_1', null))
    .mockResolvedValueOnce(textStep('msg_step_2', 'Done.', { cacheMissReason: null }));

  const result = await generateText({
    model: 'anthropic:claude-opus-4-8',
    prompt: 'continue the story',
    tools: [echo] as any,
    maxSteps: 5,
    cacheDiagnostics: { previousMessageId: 'msg_prior_turn' },
  });

  // Step 1 compares against the CALLER's previous request (last turn), not null.
  expect(hoisted.generateCompletion.mock.calls[0][2]?.cacheDiagnostics).toEqual({
    previousMessageId: 'msg_prior_turn',
  });
  // Step 2 chains within the loop as before.
  expect(hoisted.generateCompletion.mock.calls[1][2]?.cacheDiagnostics).toEqual({
    previousMessageId: 'msg_step_1',
  });
  expect(result.cacheDiagnostics).toEqual({ cacheMissReason: null });
});

it('exposes the last step\'s provider message id on the result for next-turn threading', async () => {
  hoisted.generateCompletion
    .mockResolvedValueOnce(toolStep('msg_step_1', null))
    .mockResolvedValueOnce(textStep('msg_step_2', 'Done.', { cacheMissReason: null }));

  const result = await generateText({
    model: 'anthropic:claude-opus-4-8',
    prompt: 'go',
    tools: [echo] as any,
    maxSteps: 5,
    cacheDiagnostics: true,
  });

  expect(result.providerMessageId).toBe('msg_step_2');
});

it('leaves providerMessageId absent when diagnostics are not opted in', async () => {
  hoisted.generateCompletion.mockResolvedValueOnce(textStep('msg_x', 'Plain.'));

  const result = await generateText({
    model: 'anthropic:claude-opus-4-8',
    prompt: 'plain run',
  });

  expect(result.providerMessageId).toBeUndefined();
});
