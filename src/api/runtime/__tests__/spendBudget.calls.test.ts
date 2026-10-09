/**
 * The spend budget on the paths beside the plain call: a stream's usage and its refusal, the usage a failed call's
 * error reports, the provider's health while a budget refuses calls, a fallback walk that meets a spent budget, a
 * model with no price row when the budget warns or tells a callback (and one named after a member every object
 * inherits), a token cap of NaN, estimated as a call that names none, a guard hook's stop under `hookErrors: 'throw'`
 * (never walked to another provider, never counted against one, and on the prompt-tool path before the tool runs),
 * and an agent on the GMI runtime, which takes no budget.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const generateCompletionStream = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion, generateCompletionStream }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, generateCompletionStream, getProvider, createProviderManager };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-6-luna' })),
  resolveProvider: vi.fn((providerId: string, modelId: string) => ({ providerId, modelId, apiKey: 'sk-test-not-a-real-key' })),
  createProviderManager: hoisted.createProviderManager,
}));

import { CostCapExceededError } from '../../../safety/runtime/CostGuard.js';
import { agent } from '../../agent.js';
import { generateText } from '../../generateText.js';
import { resolveModelOption } from '../../model.js';
import { streamText, type StreamPart } from '../../streamText.js';
import { SpendBudget, UnpricedModelError, type SpendLimitInfo } from '../spendBudget.js';
import type { Mock } from 'vitest';

/** One assistant reply that reports what it cost. */
function reply(text: string, costUSD: number) {
  return {
    modelId: 'gpt-6-luna',
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, costUSD },
    choices: [{ message: { role: 'assistant', content: text }, finishReason: 'stop' }],
  };
}

/** A provider stream that answers `text` in one final chunk reporting what it cost. */
function streamedReply(text: string, costUSD: number) {
  return async function* () {
    yield {
      id: 'step-1',
      object: 'chat.completion.chunk',
      created: 1,
      modelId: 'gpt-6-luna',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: 'stop' }],
      responseTextDelta: text,
      isFinal: true,
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, costUSD },
    };
  };
}

/** A provider error that reports what the failed request was billed, as a refused turn's error does. */
function billedFailure(costUSD: number): Error {
  return Object.assign(new Error('the request failed after it was billed'), {
    details: { usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, costUSD } },
  });
}

/** Every part a stream hands its consumer, in order. */
async function partsOf(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

/** The error a stream's last part carries, when that part is an error. */
function errorOf(parts: StreamPart[]): Error | undefined {
  const last = parts[parts.length - 1];
  return last?.type === 'error' ? last.error : undefined;
}

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
  hoisted.generateCompletionStream.mockReset();
});

describe('a spend budget through streamText', () => {
  it("records a stream's final usage and refuses the next stream before the provider is called", async () => {
    hoisted.generateCompletionStream.mockImplementation(streamedReply('ok', 0.0006));
    const budget = new SpendBudget({ maxCostUSD: 0.0006 });
    const first = await partsOf(streamText({ provider: 'openai', model: 'gpt-6-luna', prompt: 'hello', maxTokens: 100, budget }).fullStream);
    expect(first.map((part) => part.type)).toEqual(['text']);
    expect(budget.spentUSD()).toBeCloseTo(0.0006, 10);

    const second = await partsOf(streamText({ provider: 'openai', model: 'gpt-6-luna', prompt: 'again', maxTokens: 100, budget }).fullStream);
    expect(second.map((part) => part.type)).toEqual(['error']);
    expect(errorOf(second)).toBeInstanceOf(CostCapExceededError);
    expect(hoisted.generateCompletionStream).toHaveBeenCalledTimes(1);
  });

  it('charges a failed stream with what its error reports it was billed', async () => {
    hoisted.generateCompletionStream.mockImplementation(async function* () {
      throw billedFailure(0.0004);
    });
    const budget = new SpendBudget({ maxCostUSD: 0.01 });
    const parts = await partsOf(
      streamText({ provider: 'openai', model: 'gpt-6-luna', prompt: 'hello', maxTokens: 100, budget, fallbackProviders: [] }).fullStream,
    );
    expect(errorOf(parts)?.message).toBe('the request failed after it was billed');
    expect(budget.spentUSD()).toBeCloseTo(0.0004, 10);
  });
});

describe('a spend budget and a failed call', () => {
  it('charges a failed call with what its error reports it was billed', async () => {
    hoisted.generateCompletion.mockRejectedValue(billedFailure(0.0004));
    const budget = new SpendBudget({ maxCostUSD: 0.01 });
    await expect(
      generateText({ provider: 'openai', model: 'gpt-6-luna', prompt: 'hello', maxTokens: 100, budget, fallbackProviders: [] }),
    ).rejects.toThrow('the request failed after it was billed');
    expect(budget.spentUSD()).toBeCloseTo(0.0004, 10);
  });

  it("leaves the provider's health alone while a spent budget refuses its calls", async () => {
    hoisted.generateCompletion.mockResolvedValue(reply('ok', 0));
    const spent = new SpendBudget({ maxCostUSD: 0 });
    for (let call = 0; call < 6; call += 1) {
      await expect(
        generateText({ provider: 'openai', model: 'gpt-6-luna', prompt: 'hello', maxTokens: 100, budget: spent, fallbackProviders: [] }),
      ).rejects.toBeInstanceOf(CostCapExceededError);
    }
    await expect(generateText({ provider: 'openai', model: 'gpt-6-luna', prompt: 'hello', fallbackProviders: [] })).resolves.toMatchObject({
      text: 'ok',
    });
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it('ends a fallback walk at the first leg the spent budget refuses', async () => {
    // The primary is billed the whole budget and fails with a status a fallback is tried on.
    hoisted.generateCompletion.mockRejectedValueOnce(Object.assign(billedFailure(0.001), { httpStatus: 503 }));
    const onFallback = vi.fn();
    const budget = new SpendBudget({ maxCostUSD: 0.001 });
    await expect(
      generateText({
        provider: 'openai',
        model: 'gpt-6-luna',
        prompt: 'hello',
        maxTokens: 100,
        budget,
        onFallback,
        fallbackProviders: [
          { provider: 'openai', model: 'gpt-6.1-sol' },
          { provider: 'openai', model: 'gpt-6-luna' },
        ],
      }),
    ).rejects.toBeInstanceOf(CostCapExceededError);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
    expect(budget.spentUSD()).toBeCloseTo(0.001, 10);
  });
});

describe('a spend budget and a model with no price row', () => {
  it('tells the callback, then refuses the call with an error that names the model', async () => {
    (resolveModelOption as Mock).mockReturnValueOnce({ providerId: 'openai', modelId: 'no-such-model' });
    const seen: SpendLimitInfo[] = [];
    const budget = new SpendBudget({
      maxCostUSD: 1,
      onLimitReached: (info) => {
        seen.push(info);
      },
    });
    const refusal = await generateText({ provider: 'openai', model: 'no-such-model', prompt: 'hello', budget, fallbackProviders: [] }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(UnpricedModelError);
    const unpriced = refusal as UnpricedModelError;
    expect([unpriced.providerId, unpriced.modelId]).toEqual(['openai', 'no-such-model']);
    expect(seen.map((info) => info.capType)).toEqual(['unpriced']);
    expect(hoisted.generateCompletion).not.toHaveBeenCalled();
  });

  it('warns and runs the call when the budget is set to warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    (resolveModelOption as Mock).mockReturnValueOnce({ providerId: 'openai', modelId: 'no-such-model' });
    hoisted.generateCompletion.mockResolvedValue(reply('ok', 0));
    const budget = new SpendBudget({ maxCostUSD: 1, onLimitReached: 'warn' });
    await expect(
      generateText({ provider: 'openai', model: 'no-such-model', prompt: 'hello', budget, fallbackProviders: [] }),
    ).resolves.toMatchObject({ text: 'ok' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('openai:no-such-model has no price row'));
    warn.mockRestore();
  });

  it('refuses a model named after a member every object inherits, which has no price row either', async () => {
    // Read from the table as a plain key, `constructor` found Object's own constructor and priced the call at NaN,
    // which every cap let through.
    (resolveModelOption as Mock).mockReturnValueOnce({ providerId: 'openai', modelId: 'constructor' });
    hoisted.generateCompletion.mockResolvedValue(reply('ok', 0));
    const budget = new SpendBudget({ maxCostUSD: 1 });
    await expect(generateText({ model: 'openai:constructor', prompt: 'hello', budget, fallbackProviders: [] })).rejects.toBeInstanceOf(
      UnpricedModelError,
    );
    expect(hoisted.generateCompletion).not.toHaveBeenCalled();
  });
});

describe('a spend budget and a token cap of NaN', () => {
  it('estimates the call as one that names no cap, so the budget still refuses a call that does not fit', async () => {
    // A cap read from a setting that is not there (`Number(undefined)`) is NaN, and the request goes out with no cap.
    // Priced with that cap, the estimate was NaN, which every check of the budget let through.
    hoisted.generateCompletion.mockResolvedValue(reply('ok', 0));
    const helper = agent({
      provider: 'openai',
      model: 'gpt-6-luna',
      controls: { maxTotalTokens: Number.NaN },
      budget: { maxCostUSD: 0.01 },
    });
    const session = helper.session('s1');
    session.recordExternalCost(0.02, { kind: 'stt' });
    await expect(session.send('hello')).rejects.toBeInstanceOf(CostCapExceededError);
    // Nothing spent yet: 4,096 output tokens of gpt-6-luna, about 0.002 US dollars, do not fit a budget of 0.001.
    await expect(
      generateText({
        provider: 'openai',
        model: 'gpt-6-luna',
        prompt: 'hello',
        maxTokens: Number.NaN,
        budget: { maxCostUSD: 0.001 },
        fallbackProviders: [],
      }),
    ).rejects.toBeInstanceOf(CostCapExceededError);
    expect(hoisted.generateCompletion).not.toHaveBeenCalled();
  });
});

describe("a guard hook under hookErrors: 'throw'", () => {
  it('neither tries a call a guard hook stopped on another provider nor counts it against the provider', async () => {
    hoisted.generateCompletion.mockResolvedValue(reply('ok', 0));
    const onFallback = vi.fn();
    // A guard's message can read like a provider's rate limit.
    const guard = async (): Promise<void> => {
      throw new Error('rate limit for this user reached');
    };
    for (let call = 0; call < 6; call += 1) {
      await expect(
        generateText({
          provider: 'openai',
          model: 'gpt-6-luna',
          prompt: 'hello',
          onBeforeGeneration: guard,
          hookErrors: 'throw',
          onFallback,
          fallbackProviders: [{ provider: 'openai', model: 'gpt-6.1-sol' }],
        }),
      ).rejects.toThrow('rate limit for this user reached');
    }
    expect(onFallback).not.toHaveBeenCalled();
    await expect(generateText({ provider: 'openai', model: 'gpt-6-luna', prompt: 'hello', fallbackProviders: [] })).resolves.toMatchObject({
      text: 'ok',
    });
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it('stops a prompt-tool call when the tool hook throws, before the tool runs', async () => {
    hoisted.generateCompletion.mockResolvedValueOnce(reply('<tool_call>{"name":"recall","arguments":{}}</tool_call>', 0));
    const execute = vi.fn(async () => ({ found: 'beach' }));
    await expect(
      generateText({
        provider: 'openai',
        model: 'gpt-6-luna',
        prompt: 'where did I go?',
        tools: { recall: { description: 'recall past messages', parameters: { type: 'object', properties: {} }, execute } },
        toolMode: 'prompt',
        maxSteps: 5,
        hookErrors: 'throw',
        fallbackProviders: [],
        onBeforeToolExecution: async () => {
          throw new Error('stopped by the tool guard');
        },
      }),
    ).rejects.toThrow('stopped by the tool guard');
    expect(execute).not.toHaveBeenCalled();
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
  });
});

describe('an agent on the GMI runtime', () => {
  it('refuses a budget when it is built, since its sessions would not hold one', () => {
    expect(() => agent({ runtime: 'gmi', provider: 'openai', model: 'gpt-6-luna', budget: { maxCostUSD: 1 } })).toThrow(
      "'budget' is not available on the GMI path",
    );
  });
});
