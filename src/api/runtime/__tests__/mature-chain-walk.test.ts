/**
 * @file mature-chain-walk.test.ts
 * The fallback walk on generateText for mature and private-adult calls: the
 * chain is resolved once (the failed first model's policy leg dropped, two
 * standing uncensored legs, a refill only after an availability failure or a
 * request that does not fit), legs run as named without the router
 * re-picking them, the policy chain's Claude legs are passed over after a
 * refusal, and a catalog model is never sent a request over its context
 * window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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

import { generateText, buildPolicyAwareFallbackChain, type GenerateTextOptions } from '../../generateText.js';
import { generateObject } from '../../generateObject.js';
import { agent } from '../../agent.js';
import { PolicyAwareRouter } from '../../../core/llm/routing/PolicyAwareRouter.js';
import { createUncensoredModelCatalog } from '../../../core/llm/routing/UncensoredModelCatalog.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import { adaptTools } from '../toolAdapter.js';
import { renderToolSystemBlock } from '../tool-emulation/renderer.js';
import { between, fitsMagnum, userTurn } from './windowBoundary.js';

const LLAMA = 'meta-llama/llama-3.3-70b-instruct';
const MAGNUM = 'anthracite-org/magnum-v4-72b';
const HERMES = 'nousresearch/hermes-3-llama-3.1-70b';
const EIGHT_B = 'meta-llama/llama-3.1-8b-instruct';
const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'] as const;
/** 145_452 characters estimate to 40_000 tokens: over magnum's 32_768 window. */
const FORTY_K = 'x'.repeat(145_452);
// The health registry opens a provider's breaker after 3 failures when the
// latest is a 429, after 5 for a 5xx, and on the first 402. Legs on OpenRouter
// fail with 503 here so a walk of three OpenRouter legs never trips it by
// accident; the 402 test trips it on purpose.

const LOOKUP = {
  lookup: {
    description: 'Looks something up',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ found: true }),
  },
};

function ok(text = 'ok') {
  return {
    modelId: 'm',
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    choices: [{ message: { role: 'assistant', content: text }, finishReason: 'stop' }],
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
/** The model of every completion actually sent, in order. */
const sent = () => hoisted.generateCompletion.mock.calls.map((call) => call[0] as string);
/** The model of every attempt, a send or a pre-send skip, in order. */
const attempted = () => hoisted.resolveProvider.mock.calls.map((call) => call[1] as string);

function keys(...present: Array<(typeof ENV_KEYS)[number]>) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const k of present) process.env[k] = `test-${k}`;
}

describe('fallback walk on generateText', () => {
  let saved: Array<[string, string | undefined]>;
  beforeEach(() => {
    saved = ENV_KEYS.map((k) => [k, process.env[k]] as [string, string | undefined]);
    hoisted.generateCompletion.mockReset();
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

  it('runs each leg as named when a policy router picked the first model (tools as a plain record)', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion.mockRejectedValueOnce(status(429)).mockResolvedValueOnce(ok('from magnum'));
    const a = agent({
      provider: 'openrouter',
      model: 'openai/gpt-5.6-sol',
      memory: false,
      policyTier: 'mature',
      router: new PolicyAwareRouter(createUncensoredModelCatalog()),
      tools: LOOKUP,
    });
    const result = await a.generate('hello');
    expect(result.text).toBe('from magnum');
    expect(sent()).toEqual([LLAMA, MAGNUM]);
  });

  it('a policy router picks the tool-capable catalog model when the tools come as an array', async () => {
    // An array or a Map of tools makes the call require function_calling,
    // which the catalog lists as tool_use.
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion.mockResolvedValueOnce(ok('from llama'));
    const lookup = {
      name: 'lookup',
      description: 'Looks something up',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ success: true, output: { found: true } }),
    };
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-5.5',
      prompt: 'hi',
      policyTier: 'mature',
      router: new PolicyAwareRouter(createUncensoredModelCatalog()),
      tools: [lookup] as never,
    });
    expect(result.text).toBe('from llama');
    expect(sent()).toEqual([LLAMA]);
  });

  it('builds the chain for a tier that only the router carries', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion.mockRejectedValueOnce(status(429)).mockResolvedValueOnce(ok());
    await generateText({
      provider: 'openai',
      model: 'gpt-5.5',
      prompt: 'hi',
      router: new PolicyAwareRouter(createUncensoredModelCatalog(), null, {}, 'mature'),
    });
    expect(sent()).toEqual([LLAMA, MAGNUM]);
  });

  type Tier = NonNullable<GenerateTextOptions['policyTier']>;
  type TierCase = [
    name: string,
    extra: Partial<GenerateTextOptions>,
    routerTier: Tier | undefined,
    routeTier: Tier | undefined,
    firstLeg: string,
  ];
  const TIER_CASES: TierCase[] = [
    ['explicit route tier', { routerParams: { policyTier: 'standard' }, policyTier: 'mature' }, 'private-adult', 'standard', 'openai/gpt-5.6-sol'],
    ['call tier', { policyTier: 'mature' }, 'private-adult', 'mature', LLAMA],
    ['host policy without a tier', { hostPolicy: {} }, 'mature', 'standard', 'openai/gpt-5.6-sol'],
    ['host policy tier', { hostPolicy: { policyTier: 'private-adult' } }, undefined, 'private-adult', MAGNUM],
    ['router default only', {}, 'mature', undefined, LLAMA],
    ['no tier anywhere', {}, undefined, undefined, 'openai/gpt-5.6-sol'],
  ];
  it.each(TIER_CASES)('%s: the primary route tier is unchanged and the chain follows the resolved tier', async (_name, extra, routerTier, routeTier, firstLeg) => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion.mockRejectedValueOnce(status(429)).mockResolvedValueOnce(ok());
    const selectModel = vi.fn().mockResolvedValue(null);
    await generateText({
      provider: 'openai',
      model: 'gpt-5.5',
      prompt: 'hi',
      router: { routerId: 'spy', initialize: async () => {}, selectModel, policyTier: routerTier } as any,
      ...extra,
    });
    expect(selectModel.mock.calls[0]![0].policyTier).toBe(routeTier);
    expect(sent()[1]).toBe(firstLeg);
  });

  it('a delegating router: the base default picks the first model and builds the chain', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion.mockRejectedValueOnce(status(429)).mockResolvedValueOnce(ok());
    const catalog = createUncensoredModelCatalog();
    const router = new PolicyAwareRouter(catalog, new PolicyAwareRouter(catalog, null, {}, 'private-adult'));
    await generateText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', router });
    expect(sent()).toEqual([MAGNUM, HERMES]);
  });

  it('a standard default over a mature base: the base picks the first model and the chain follows the base', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion.mockRejectedValueOnce(status(429)).mockResolvedValueOnce(ok());
    const catalog = createUncensoredModelCatalog();
    const router = new PolicyAwareRouter(catalog, new PolicyAwareRouter(catalog, null, {}, 'mature'), {}, 'standard');
    await generateText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', router });
    expect(sent()).toEqual([LLAMA, MAGNUM]);
  });

  it('runs the refill after both standing legs failed on availability', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion
      .mockRejectedValueOnce(decline('content_filter'))
      .mockRejectedValueOnce(status(503))
      .mockRejectedValueOnce(status(503))
      .mockResolvedValueOnce(ok('from hermes'));
    const result = await generateText({ provider: 'anthropic', model: 'claude-sonnet-5-5', prompt: 'hi', policyTier: 'mature' });
    expect(result.text).toBe('from hermes');
    expect(sent()).toEqual(['claude-sonnet-5-5', LLAMA, MAGNUM, HERMES]);
  });

  it('runs the refill in place of a standing leg that could not hold the request', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion
      .mockRejectedValueOnce(status(429))
      .mockRejectedValueOnce(decline('content_filter'))
      .mockResolvedValueOnce(ok('from hermes'));
    const result = await generateText({ provider: 'anthropic', model: 'claude-sonnet-5-5', prompt: FORTY_K, policyTier: 'mature' });
    expect(result.text).toBe('from hermes');
    // llama declined, which owes no refill; magnum was skipped before sending,
    // which owes the one hermes fills.
    expect(sent()).toEqual(['claude-sonnet-5-5', LLAMA, HERMES]);
    expect(attempted()).toContain(MAGNUM);
  });

  it('runs no refill after the standing legs declined, and never the 8B', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion
      .mockRejectedValueOnce(status(429))
      .mockRejectedValueOnce(decline('content_filter'))
      .mockRejectedValueOnce(decline('content_policy_violation'))
      .mockResolvedValueOnce(ok('from the suffix'));
    await generateText({ provider: 'anthropic', model: 'claude-sonnet-5-5', prompt: 'hi', policyTier: 'mature' });
    expect(sent()).toEqual(['claude-sonnet-5-5', LLAMA, MAGNUM, 'openai/gpt-5.6-sol']);
    expect(attempted()).not.toContain(EIGHT_B);
  });

  it('passes over the policy chain Claude leg after a refusal, not after a filter hit', async () => {
    keys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY');
    hoisted.generateCompletion
      .mockRejectedValueOnce(decline('content_filter'))
      .mockRejectedValueOnce(status(503))
      .mockRejectedValueOnce(status(503))
      .mockRejectedValueOnce(status(503))
      .mockResolvedValueOnce(ok());
    await generateText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', policyTier: 'mature' });
    expect(sent()).toEqual(['gpt-5.5', LLAMA, MAGNUM, HERMES, 'openai/gpt-5.6-sol']);

    hoisted.generateCompletion.mockReset();
    globalLLMProviderHealth.reset();
    hoisted.generateCompletion
      .mockRejectedValueOnce(decline('content_policy_violation'))
      .mockRejectedValueOnce(status(503))
      .mockRejectedValueOnce(status(503))
      .mockRejectedValueOnce(status(503))
      .mockResolvedValueOnce(ok());
    await generateText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', policyTier: 'mature' });
    expect(sent()).toEqual(['gpt-5.5', LLAMA, MAGNUM, HERMES, 'claude-sonnet-5-5']);
  });

  it('keeps a caller-written Claude leg after a refusal', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion.mockRejectedValueOnce(decline('content_filter')).mockResolvedValueOnce(ok('from opus'));
    const result = await generateText({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      prompt: 'hi',
      policyTier: 'mature',
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }, ...buildPolicyAwareFallbackChain('mature', 'anthropic')],
    });
    expect(result.text).toBe('from opus');
    expect(sent()).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
  });

  it('skips catalog legs lacking an explicitly required capability, under either spelling', async () => {
    for (const capability of ['function_calling', 'tool_use']) {
      hoisted.generateCompletion.mockReset();
      globalLLMProviderHealth.reset();
      keys('OPENROUTER_API_KEY');
      hoisted.generateCompletion.mockRejectedValueOnce(status(429)).mockRejectedValueOnce(status(503)).mockResolvedValueOnce(ok());
      await generateText({
        provider: 'openai',
        model: 'gpt-5.5',
        prompt: 'hi',
        policyTier: 'mature',
        routerParams: { requiredCapabilities: [capability] },
      });
      expect(sent()).toEqual(['gpt-5.5', LLAMA, 'openai/gpt-5.6-sol']);
    }
  });

  it('keeps magnum and hermes as legs on a tool-carrying call without explicit capabilities', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion
      .mockRejectedValueOnce(status(429))
      .mockRejectedValueOnce(status(503))
      .mockRejectedValueOnce(status(503))
      .mockResolvedValueOnce(ok('from hermes'));
    const result = await generateText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', policyTier: 'mature', tools: LOOKUP });
    expect(result.text).toBe('from hermes');
    expect(sent()).toEqual(['gpt-5.5', LLAMA, MAGNUM, HERMES]);
  });

  it('a 402 opens the OpenRouter breaker at once and the walk skips the remaining OpenRouter legs', async () => {
    keys('OPENROUTER_API_KEY', 'GEMINI_API_KEY');
    hoisted.generateCompletion
      .mockRejectedValueOnce(status(429))
      .mockRejectedValueOnce(status(402))
      .mockResolvedValueOnce(ok('from gemini'));
    const result = await generateText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', policyTier: 'mature' });
    expect(result.text).toBe('from gemini');
    expect(sent()).toEqual(['gpt-5.5', LLAMA, 'gemini-3.1-pro-preview']);
  });

  it('a pinned catalog first model over its window is not sent and the walk starts', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion.mockResolvedValueOnce(ok('from llama'));
    const result = await generateText({ provider: 'openrouter', model: MAGNUM, prompt: FORTY_K, policyTier: 'mature' });
    expect(result.text).toBe('from llama');
    expect(sent()).toEqual([LLAMA]);
    expect(result.fallback?.hops[0]).toEqual({ provider: 'openrouter', model: MAGNUM, ok: false });
    // The size refusal is never recorded: llama's success alone would not
    // remove a record, so no record exists at all.
    expect(globalLLMProviderHealth.getStats('openrouter')).toBeNull();
  });

  it('a customModelParams.model override is checked against the window of the model the payload names', async () => {
    keys('OPENROUTER_API_KEY');
    // The call names magnum (32,768 tokens) but the payload carries llama
    // (131,072), which holds the 40,000: the request is sent.
    hoisted.generateCompletion.mockResolvedValueOnce(ok('held'));
    const widened = await generateText({
      provider: 'openrouter',
      model: MAGNUM,
      customModelParams: { model: LLAMA },
      prompt: FORTY_K,
      policyTier: 'mature',
    });
    expect(widened.text).toBe('held');
    expect(sent()).toEqual([MAGNUM]);

    // The reverse: the payload carries magnum on every OpenRouter leg, and
    // none of them is sent a request magnum cannot hold.
    hoisted.generateCompletion.mockReset();
    await expect(
      generateText({
        provider: 'openrouter',
        model: LLAMA,
        customModelParams: { model: MAGNUM },
        prompt: FORTY_K,
        policyTier: 'mature',
      }),
    ).rejects.toThrow();
    expect(sent()).toEqual([]);
  });

  it('the router pick over its window is not sent and the walk starts', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion.mockResolvedValueOnce(ok('from hermes'));
    await generateText({
      provider: 'openai',
      model: 'gpt-5.5',
      prompt: FORTY_K,
      router: new PolicyAwareRouter(createUncensoredModelCatalog(), null, {}, 'private-adult'),
    });
    expect(attempted()[0]).toBe(MAGNUM);
    expect(sent()).toEqual([HERMES]);
  });

  it('the shim send of a catalog first model over its window starts the walk', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion.mockResolvedValueOnce(ok('from llama'));
    await generateText({
      provider: 'openrouter',
      model: MAGNUM,
      prompt: FORTY_K,
      policyTier: 'mature',
      tools: LOOKUP,
      toolMode: 'prompt',
    });
    expect(sent()).toEqual([LLAMA]);
  });

  it('a continuation leg is checked against the continuation messages', async () => {
    keys('OPENROUTER_API_KEY');
    const bigLookup = {
      lookup: { ...LOOKUP.lookup, execute: async () => ({ text: FORTY_K }) },
    };
    hoisted.generateCompletion
      .mockResolvedValueOnce({
        modelId: 'gpt-5.5',
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
            },
            finishReason: 'tool_calls',
          },
        ],
      })
      .mockRejectedValueOnce(status(429))
      .mockResolvedValueOnce(ok('from hermes'));
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-5.5',
      prompt: 'hi',
      maxSteps: 3,
      policyTier: 'private-adult',
      tools: bigLookup,
    });
    expect(result.text).toBe('from hermes');
    expect(attempted()).toContain(MAGNUM);
    expect(sent()).toEqual(['gpt-5.5', 'gpt-5.5', HERMES]);
  });

  it('a system-heavy generateObject skips magnum and is served by hermes', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion.mockResolvedValueOnce(ok('{"answer":"ok"}'));
    const result = await generateObject({
      provider: 'openrouter',
      model: MAGNUM,
      policyTier: 'private-adult',
      system: FORTY_K,
      prompt: 'Answer.',
      schema: z.object({ answer: z.string() }),
    });
    expect(result.object).toEqual({ answer: 'ok' });
    expect(sent()).toEqual([HERMES]);
  });

  it("counts a leg's maxTokensHeadroom toward its window", async () => {
    keys('OPENROUTER_API_KEY');
    const chars = between(
      (n) => fitsMagnum({ messages: userTurn(n), maxTokens: 1_824 }),
      (n) => fitsMagnum({ messages: userTurn(n), maxTokens: 800 }),
    );
    expect(fitsMagnum({ messages: userTurn(chars), maxTokens: 800 })).toBe(true);
    expect(fitsMagnum({ messages: userTurn(chars), maxTokens: 1_824 })).toBe(false);
    const prompt = 'x'.repeat(chars);

    hoisted.generateCompletion.mockRejectedValueOnce(status(429)).mockResolvedValueOnce(ok('from hermes'));
    await generateText({
      provider: 'openai',
      model: 'gpt-5.5',
      prompt,
      maxTokens: 800,
      fallbackProviders: [
        { provider: 'openrouter', model: MAGNUM, maxTokensHeadroom: 1_024 },
        { provider: 'openrouter', model: HERMES },
      ],
    });
    expect(attempted()).toContain(MAGNUM);
    expect(sent()).toEqual(['gpt-5.5', HERMES]);

    hoisted.generateCompletion.mockReset();
    hoisted.resolveProvider.mockClear();
    globalLLMProviderHealth.reset();
    hoisted.generateCompletion.mockRejectedValueOnce(status(429)).mockResolvedValueOnce(ok('from magnum'));
    await generateText({
      provider: 'openai',
      model: 'gpt-5.5',
      prompt,
      maxTokens: 800,
      fallbackProviders: [{ provider: 'openrouter', model: MAGNUM }],
    });
    expect(sent()).toEqual(['gpt-5.5', MAGNUM]);
  });

  it('counts a customModelParams.max_tokens override as the output allowance', async () => {
    keys('OPENROUTER_API_KEY');
    const override = { max_tokens: 1_000 };
    const chars = between(
      (n) => fitsMagnum({ messages: userTurn(n) }),
      (n) => fitsMagnum({ messages: userTurn(n), customModelParams: override }),
    );
    expect(fitsMagnum({ messages: userTurn(chars), customModelParams: override })).toBe(true);
    expect(fitsMagnum({ messages: userTurn(chars) })).toBe(false);
    const prompt = 'x'.repeat(chars);

    hoisted.generateCompletion.mockResolvedValueOnce(ok('from magnum'));
    await generateText({ provider: 'openrouter', model: MAGNUM, prompt, policyTier: 'mature', customModelParams: override });
    expect(sent()).toEqual([MAGNUM]);

    hoisted.generateCompletion.mockReset();
    hoisted.generateCompletion.mockResolvedValueOnce(ok('from llama'));
    await generateText({ provider: 'openrouter', model: MAGNUM, prompt, policyTier: 'mature' });
    expect(sent()).toEqual([LLAMA]);
  });

  it('counts the tool text the prompt shim renders', async () => {
    keys('OPENROUTER_API_KEY');
    const shimSystem = { role: 'system', content: renderToolSystemBlock(adaptTools(LOOKUP)) };
    const chars = between(
      (n) => fitsMagnum({ messages: [shimSystem, ...userTurn(n)] }),
      (n) => fitsMagnum({ messages: userTurn(n) }),
    );
    expect(fitsMagnum({ messages: userTurn(chars) })).toBe(true);
    expect(fitsMagnum({ messages: [shimSystem, ...userTurn(chars)] })).toBe(false);

    hoisted.generateCompletion.mockResolvedValueOnce(ok('from hermes'));
    await generateText({
      provider: 'openrouter',
      model: MAGNUM,
      prompt: 'x'.repeat(chars),
      policyTier: 'private-adult',
      tools: LOOKUP,
      toolMode: 'prompt',
    });
    expect(sent()).toEqual([HERMES]);
  });

  it('toolMode auto: after the provider rejects native tools, the shim send is checked on its own', async () => {
    keys('OPENROUTER_API_KEY');
    const tools = adaptTools(LOOKUP);
    const nativeSchemas = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    const shimSystem = { role: 'system', content: renderToolSystemBlock(tools) };
    const chars = between(
      (n) => fitsMagnum({ messages: [shimSystem, ...userTurn(n)] }),
      (n) => fitsMagnum({ messages: userTurn(n), tools: nativeSchemas }),
    );
    expect(fitsMagnum({ messages: userTurn(chars), tools: nativeSchemas })).toBe(true);
    expect(fitsMagnum({ messages: [shimSystem, ...userTurn(chars)] })).toBe(false);

    hoisted.generateCompletion
      .mockRejectedValueOnce(new Error('No endpoints found that support tool use'))
      .mockResolvedValueOnce(ok('from hermes'));
    const result = await generateText({
      provider: 'openrouter',
      model: MAGNUM,
      prompt: 'x'.repeat(chars),
      policyTier: 'private-adult',
      tools: LOOKUP,
      toolMode: 'auto',
    });
    expect(result.text).toBe('from hermes');
    // magnum took the native send; the shim's send to it was never made.
    expect(sent()).toEqual([MAGNUM, HERMES]);
  });

  it('the router pick over its window is not sent through the prompt shim either', async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion.mockResolvedValueOnce(ok('from hermes'));
    await generateText({
      provider: 'openai',
      model: 'gpt-5.5',
      prompt: FORTY_K,
      tools: LOOKUP,
      toolMode: 'prompt',
      router: new PolicyAwareRouter(createUncensoredModelCatalog(), null, {}, 'private-adult'),
    });
    expect(attempted()[0]).toBe(MAGNUM);
    expect(sent()).toEqual([HERMES]);
  });

  it("sends a request over the window when the call enables OpenRouter's context compression", async () => {
    keys('OPENROUTER_API_KEY');
    hoisted.generateCompletion.mockResolvedValueOnce(ok('from magnum'));
    await generateText({
      provider: 'openrouter',
      model: MAGNUM,
      prompt: FORTY_K,
      policyTier: 'mature',
      customModelParams: { plugins: [{ id: 'context-compression' }] },
    });
    expect(sent()).toEqual([MAGNUM]);
  });
});
