/**
 * @file mature-chain-walk-stream.test.ts
 * The fallback walk on streamText for mature calls: legs run as named when a
 * policy router picked the first model, the refusal record travels into the
 * nested walks so the policy chain's Claude leg is passed over, a standing
 * leg that cannot hold the request is replaced by the refill, and a catalog
 * first model over its window is never streamed.
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
  // Pass-through, so every attempt's provider and model show on the calls.
  const resolveProvider = vi.fn((providerId?: string, modelId?: string) => ({
    providerId: providerId ?? 'openai',
    modelId: modelId ?? 'gpt-5.5',
    apiKey: 'test-key',
  }));
  return { generateCompletion, generateCompletionStream, getProvider, createProviderManager, resolveModelOption, resolveProvider };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: hoisted.resolveModelOption,
  resolveProvider: hoisted.resolveProvider,
  createProviderManager: hoisted.createProviderManager,
}));

import { streamText } from '../../streamText.js';
import { buildPolicyAwareFallbackChain } from '../../generateText.js';
import { agent } from '../../agent.js';
import { PolicyAwareRouter } from '../../../core/llm/routing/PolicyAwareRouter.js';
import { createUncensoredModelCatalog } from '../../../core/llm/routing/UncensoredModelCatalog.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

const LLAMA = 'meta-llama/llama-3.3-70b-instruct';
const MAGNUM = 'anthracite-org/magnum-v4-72b';
const HERMES = 'nousresearch/hermes-3-llama-3.1-70b';
const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'] as const;
/** 145_452 characters estimate to 40_000 tokens: over magnum's 32_768 window. */
const FORTY_K = 'x'.repeat(145_452);
// Legs on OpenRouter fail with 503 so a walk never trips the health
// registry's 429 streak (3) by accident.

const LOOKUP = {
  lookup: {
    description: 'Looks something up',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ found: true }),
  },
};

function finalChunk(text: string, modelId: string) {
  return {
    id: 'chunk-final',
    object: 'chat.completion.chunk',
    created: 1,
    modelId,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: 'stop' }],
    responseTextDelta: text,
    isFinal: true,
    usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 },
  };
}
function status(httpStatus: number) {
  const err = new Error(`[${httpStatus}] failed`) as Error & { httpStatus?: number };
  err.httpStatus = httpStatus;
  return err;
}
function decline(code: 'content_filter' | 'content_policy_violation') {
  const err = new Error('declined') as Error & { code?: string };
  err.code = code;
  return err;
}
const failing = (err: Error) =>
  async function* () {
    throw err;
  };
const serving = (text: string, model: string) =>
  async function* () {
    yield finalChunk(text, model);
  };
/** The model of every stream actually opened, in order. */
const streamed = () => hoisted.generateCompletionStream.mock.calls.map((call) => call[0] as string);
/** The model of every attempt, a send or a pre-send skip, in order. */
const attempted = () => hoisted.resolveProvider.mock.calls.map((call) => call[1] as string);

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

function keys(...present: Array<(typeof ENV_KEYS)[number]>) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const k of present) process.env[k] = `test-${k}`;
}

describe('fallback walk on streamText', () => {
  let saved: Array<[string, string | undefined]>;
  beforeEach(() => {
    saved = ENV_KEYS.map((k) => [k, process.env[k]] as [string, string | undefined]);
    hoisted.generateCompletion.mockReset();
    hoisted.generateCompletionStream.mockReset();
    hoisted.resolveProvider.mockClear();
    hoisted.resolveModelOption.mockClear();
    globalLLMProviderHealth.reset();
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalLLMProviderHealth.reset();
  });

  it('agent.stream: legs run as named when a policy router picked the first model', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletionStream
      .mockImplementationOnce(failing(status(429)))
      .mockImplementationOnce(serving('from magnum', MAGNUM));
    const a = agent({
      provider: 'openrouter',
      model: 'openai/gpt-5.6-sol',
      memory: false,
      policyTier: 'mature',
      router: new PolicyAwareRouter(createUncensoredModelCatalog()),
      tools: LOOKUP,
    });
    expect(await drain(a.stream('hello').textStream)).toBe('from magnum');
    expect(streamed()).toEqual([LLAMA, MAGNUM]);
  });

  it('the refusal record travels into nested walks: the chain Claude leg is passed over', async () => {
    keys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY');
    hoisted.generateCompletionStream
      .mockImplementationOnce(failing(decline('content_filter')))
      .mockImplementationOnce(failing(status(503)))
      .mockImplementationOnce(failing(status(503)))
      .mockImplementationOnce(failing(status(503)))
      .mockImplementationOnce(serving('from the suffix', 'openai/gpt-5.6-sol'));
    const result = streamText({
      provider: 'openrouter',
      model: LLAMA,
      prompt: 'hi',
      policyTier: 'mature',
      fallbackProviders: buildPolicyAwareFallbackChain('mature'),
    });
    expect(await drain(result.textStream)).toBe('from the suffix');
    expect(streamed()).toEqual([LLAMA, MAGNUM, HERMES, 'gpt-5.6-sol', 'openai/gpt-5.6-sol']);
  });

  it('a standing leg that cannot hold a long stream request is replaced by the refill', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletionStream
      .mockImplementationOnce(failing(status(429)))
      .mockImplementationOnce(failing(status(503)))
      .mockImplementationOnce(serving('from hermes', HERMES));
    const result = streamText({ provider: 'anthropic', model: 'claude-sonnet-5-5', prompt: FORTY_K, policyTier: 'mature' });
    expect(await drain(result.textStream)).toBe('from hermes');
    // llama failed on availability and magnum was skipped before sending:
    // two refills are owed and the one refill model runs.
    expect(streamed()).toEqual(['claude-sonnet-5-5', LLAMA, HERMES]);
    expect(attempted()).toContain(MAGNUM);
  });

  it('a pinned catalog first model over its window starts the walk without streaming', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletionStream.mockImplementationOnce(serving('from llama', LLAMA));
    const result = streamText({ provider: 'openrouter', model: MAGNUM, prompt: FORTY_K, policyTier: 'mature' });
    expect(await drain(result.textStream)).toBe('from llama');
    expect(streamed()).toEqual([LLAMA]);
  });
});
