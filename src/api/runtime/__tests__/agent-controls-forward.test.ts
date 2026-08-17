import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const generateCompletionStream = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion, generateCompletionStream }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, generateCompletionStream, getProvider, createProviderManager };
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

import { agent } from '../../agent.js';
import { getCapabilitySupport } from '../capabilityContract.js';

/**
 * AgentConfig.controls -> generateText/streamText passthrough (W-81).
 *
 * The lightweight agent() surface historically accepted
 * `controls: { maxTotalTokens, maxDurationMs }` and dropped them on the
 * floor (capability contract: 'accepted_but_deferred'), so every caller
 * declaring a token or duration budget got no enforcement. agent() now
 * forwards them per call: maxTotalTokens caps each call's completion output
 * (mapped to maxTokens when no explicit maxTokens is set) and maxDurationMs
 * bounds each LLM request (mapped to requestTimeout, on both the generate
 * and stream paths). The agency()-level whole-run semantics are unchanged.
 */
describe('agent controls passthrough', () => {
  const okCompletion = {
    modelId: 'gpt-4.1-mini',
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }],
  };
  const okStreamChunk = {
    id: 'chunk-final',
    object: 'chat.completion.chunk',
    created: 1,
    modelId: 'gpt-4.1-mini',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finishReason: 'stop',
      },
    ],
    responseTextDelta: 'ok',
    isFinal: true,
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
  };
  const lastGenerateOpts = () =>
    ((): unknown => {
      const calls = hoisted.generateCompletion.mock.calls as unknown[][];
      return calls[calls.length - 1]?.[2] ?? {};
    })() as { maxTokens?: number; requestTimeout?: number };
  const lastStreamOpts = () =>
    ((): unknown => {
      const calls = hoisted.generateCompletionStream.mock.calls as unknown[][];
      return calls[calls.length - 1]?.[2] ?? {};
    })() as { maxTokens?: number; requestTimeout?: number };

  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
    hoisted.generateCompletionStream.mockReset();
  });

  it('forwards controls.maxTotalTokens as maxTokens and controls.maxDurationMs as requestTimeout on generate', async () => {
    hoisted.generateCompletion.mockResolvedValue(okCompletion);
    const a = agent({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      memory: false,
      controls: { maxTotalTokens: 8000, maxDurationMs: 45_000 },
    });
    const result = await a.generate('hello');
    expect(result.text).toBe('ok');
    expect(lastGenerateOpts().maxTokens).toBe(8000);
    expect(lastGenerateOpts().requestTimeout).toBe(45_000);
  });

  it('forwards both controls onto the stream path too', async () => {
    hoisted.generateCompletionStream.mockImplementation(async function* () {
      yield okStreamChunk;
    });
    const a = agent({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      memory: false,
      controls: { maxTotalTokens: 8000, maxDurationMs: 45_000 },
    });
    const result = a.stream('hello');
    let text = '';
    for await (const chunk of result.textStream) text += chunk;
    expect(text).toBe('ok');
    expect(lastStreamOpts().maxTokens).toBe(8000);
    expect(lastStreamOpts().requestTimeout).toBe(45_000);
  });

  it('prefers an explicit top-level maxTokens over controls.maxTotalTokens', async () => {
    hoisted.generateCompletion.mockResolvedValue(okCompletion);
    const a = agent({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      memory: false,
      maxTokens: 1600,
      controls: { maxTotalTokens: 8000, maxDurationMs: 45_000 },
    });
    await a.generate('hello');
    expect(lastGenerateOpts().maxTokens).toBe(1600);
    expect(lastGenerateOpts().requestTimeout).toBe(45_000);
  });

  it('lets per-call extra overrides win over the controls-derived defaults', async () => {
    hoisted.generateCompletion.mockResolvedValue(okCompletion);
    const a = agent({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      memory: false,
      controls: { maxTotalTokens: 8000, maxDurationMs: 45_000 },
    });
    await a.generate('hello', { maxTokens: 500, requestTimeout: 5000 });
    expect(lastGenerateOpts().maxTokens).toBe(500);
    expect(lastGenerateOpts().requestTimeout).toBe(5000);
  });

  it('leaves maxTokens and requestTimeout unset when no controls or caps are declared', async () => {
    hoisted.generateCompletion.mockResolvedValue(okCompletion);
    const a = agent({ provider: 'openai', model: 'gpt-4.1-mini', memory: false });
    const result = await a.generate('hello');
    expect(result.text).toBe('ok');
    expect(lastGenerateOpts().maxTokens).toBeUndefined();
    expect(lastGenerateOpts().requestTimeout).toBeUndefined();
  });

  it('classifies agent-surface controls as partially enforced in the capability contract', () => {
    expect(getCapabilitySupport('agent', 'controls')).toBe('partially_enforced');
  });
});
