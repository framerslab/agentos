/**
 * @file agent-policytier-forward.test.ts
 * Agent-level policyTier -> generation routing passthrough (W-82).
 *
 * GenerateTextOptions.policyTier existed on the raw helpers, but AgentOptions
 * carried no policyTier at all, so an agent()-surface caller could never
 * reach the tier-aware path: a mature/private-adult streamed turn that lost
 * its primary fell onto the availability-only chain (censored legs) instead
 * of the policy-aware chain's uncensored prefix. agent() now forwards
 * `policyTier` into every generate / stream / session call, and both helpers
 * thread the top-level tier into the model-router params between the
 * explicit routerParams and hostPolicy layers. Absent policyTier preserves
 * the legacy behavior exactly: availability-only chain, tier-agnostic
 * routing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const generateCompletionStream = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion, generateCompletionStream }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  const resolveModelOption = vi.fn((o: { provider?: string; model?: string }) => ({
    providerId: o?.provider ?? 'openai',
    modelId: o?.model ?? 'gpt-5.5',
  }));
  // Pass-through so the fallback recursion re-enters with the leg's
  // provider/model visible on the recorded calls.
  const resolveProvider = vi.fn((providerId?: string, modelId?: string) => ({
    providerId: providerId ?? 'openai',
    modelId: modelId ?? 'gpt-5.5',
    apiKey: 'test-key',
  }));
  return {
    generateCompletion,
    generateCompletionStream,
    getProvider,
    createProviderManager,
    resolveModelOption,
    resolveProvider,
  };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: hoisted.resolveModelOption,
  resolveProvider: hoisted.resolveProvider,
  createProviderManager: hoisted.createProviderManager,
}));

import { agent } from '../../agent.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'] as const;

function finalChunk(text: string, modelId: string) {
  return {
    id: 'chunk-final',
    object: 'chat.completion.chunk',
    created: 1,
    modelId,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finishReason: 'stop',
      },
    ],
    responseTextDelta: text,
    isFinal: true,
    usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 },
  };
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

describe('agent policyTier passthrough', () => {
  const okCompletion = {
    modelId: 'gpt-5.5',
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }],
  };
  let savedEnv: Array<[string, string | undefined]>;

  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
    hoisted.generateCompletionStream.mockReset();
    hoisted.resolveModelOption.mockClear();
    hoisted.resolveProvider.mockClear();
    globalLLMProviderHealth.reset();
    // Deterministic auto-built chains: only the OpenRouter leg is available.
    savedEnv = ENV_KEYS.map((key) => [key, process.env[key]]);
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-or-key';
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('threads the agent-level policyTier into the router route params', async () => {
    hoisted.generateCompletion.mockResolvedValue(okCompletion);
    const selectModel = vi.fn().mockResolvedValue(null);
    const a = agent({
      provider: 'openai',
      model: 'gpt-5.5',
      memory: false,
      policyTier: 'mature',
      router: { selectModel } as any,
    });
    const result = await a.generate('hello');
    expect(result.text).toBe('ok');
    expect(selectModel).toHaveBeenCalledOnce();
    expect(selectModel.mock.calls[0]![0].policyTier).toBe('mature');
  });

  it('threads policyTier into the router route params on the stream path', async () => {
    hoisted.generateCompletionStream.mockImplementation(async function* () {
      yield finalChunk('ok', 'gpt-5.5');
    });
    const selectModel = vi.fn().mockResolvedValue(null);
    const a = agent({
      provider: 'openai',
      model: 'gpt-5.5',
      memory: false,
      policyTier: 'mature',
      router: { selectModel } as any,
    });
    const text = await drain(a.stream('hello').textStream);
    expect(text).toBe('ok');
    expect(selectModel).toHaveBeenCalledOnce();
    expect(selectModel.mock.calls[0]![0].policyTier).toBe('mature');
  });

  it('leaves the router route params tier-agnostic when policyTier is absent (legacy)', async () => {
    hoisted.generateCompletion.mockResolvedValue(okCompletion);
    const selectModel = vi.fn().mockResolvedValue(null);
    const a = agent({
      provider: 'openai',
      model: 'gpt-5.5',
      memory: false,
      router: { selectModel } as any,
    });
    await a.generate('hello');
    expect(selectModel).toHaveBeenCalledOnce();
    expect(selectModel.mock.calls[0]![0].policyTier).toBeUndefined();
  });

  it('lets an explicit routerParams.policyTier win over the agent-level tier', async () => {
    hoisted.generateCompletion.mockResolvedValue(okCompletion);
    const selectModel = vi.fn().mockResolvedValue(null);
    const a = agent({
      provider: 'openai',
      model: 'gpt-5.5',
      memory: false,
      policyTier: 'mature',
      routerParams: { policyTier: 'standard' },
      router: { selectModel } as any,
    });
    await a.generate('hello');
    expect(selectModel.mock.calls[0]![0].policyTier).toBe('standard');
  });

  it('rescues a mature-tier failed stream onto the uncensored prefix first', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () {
        throw new Error('[429] rate limited');
      })
      .mockImplementationOnce(async function* () {
        yield finalChunk('served by leg', 'nousresearch/hermes-3-llama-3.1-405b');
      });
    const a = agent({
      provider: 'openai',
      model: 'gpt-5.5',
      memory: false,
      policyTier: 'private-adult',
    });
    const text = await drain(a.stream('hello').textStream);
    expect(text).toBe('served by leg');
    // Call 0 is the primary; call 1 must be the policy-aware chain's
    // uncensored OpenRouter lead, not the availability-only leg.
    expect(hoisted.resolveProvider.mock.calls[1]![0]).toBe('openrouter');
    expect(hoisted.resolveProvider.mock.calls[1]![1]).toBe('nousresearch/hermes-3-llama-3.1-405b');
  });

  it('keeps the availability-only chain when policyTier is absent (legacy)', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () {
        throw new Error('[429] rate limited');
      })
      .mockImplementationOnce(async function* () {
        yield finalChunk('served by leg', 'openai/gpt-5.6-sol');
      });
    const a = agent({ provider: 'openai', model: 'gpt-5.5', memory: false });
    const text = await drain(a.stream('hello').textStream);
    expect(text).toBe('served by leg');
    const legModels = hoisted.resolveProvider.mock.calls.map((call) => call[1]);
    expect(legModels).not.toContain('nousresearch/hermes-3-llama-3.1-405b');
    expect(hoisted.resolveProvider.mock.calls[1]![0]).toBe('openrouter');
    expect(hoisted.resolveProvider.mock.calls[1]![1]).toBe('openai/gpt-5.6-sol');
  });
});
