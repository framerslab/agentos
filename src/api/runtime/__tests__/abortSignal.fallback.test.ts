/**
 * @file abortSignal.fallback.test.ts
 * A call the caller's signal stopped is the caller's stop, whatever error the
 * provider made of the cut request: generateText and streamText try it on no
 * fallback provider, count nothing against the provider's health, and end with
 * the signal's reason itself rather than the provider's error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const generateCompletionStream = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion, generateCompletionStream }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, generateCompletionStream, createProviderManager };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn((o: { provider?: string; model?: string }) => ({
    providerId: o?.provider ?? 'openai',
    modelId: o?.model ?? 'gpt-6-luna',
  })),
  resolveProvider: vi.fn((providerId: string, modelId: string) => ({ providerId, modelId, apiKey: 'test-key' })),
  createProviderManager: hoisted.createProviderManager,
}));

import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import { generateText } from '../generateText.js';
import { streamText, type StreamPart } from '../streamText.js';

/** A fallback entry the call is tried on when its first provider fails with a retryable error. */
const FALLBACK = [{ provider: 'gemini', model: 'gemini-x' }];

/** What a provider can make of a request the caller's signal cut off: a retryable status, not an abort. */
const unavailable = (): Error => Object.assign(new Error('[503] upstream connect error'), { httpStatus: 503 });

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
  hoisted.generateCompletionStream.mockReset();
  globalLLMProviderHealth.reset();
});

describe("a call the caller's signal stopped, which the provider reports as its own failure", () => {
  it('generateText walks no fallback chain, leaves the provider healthy and rejects with the reason itself', async () => {
    const controller = new AbortController();
    const reason = new Error('the caller moved on');
    hoisted.generateCompletion.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw unavailable();
    });
    const onFallback = vi.fn();
    await expect(
      generateText({ provider: 'openai', model: 'gpt-6-luna', prompt: 'x', abortSignal: controller.signal, fallbackProviders: FALLBACK, onFallback }),
    ).rejects.toBe(reason);
    expect(onFallback).not.toHaveBeenCalled();
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
    expect(globalLLMProviderHealth.getStats('openai')).toBeNull();
  });

  it('streamText walks no fallback chain, leaves the provider healthy and ends with the reason itself', async () => {
    const controller = new AbortController();
    const reason = new Error('the caller moved on');
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      controller.abort(reason);
      throw unavailable();
    });
    const onFallback = vi.fn();
    const result = streamText({ provider: 'openai', model: 'gpt-6-luna', prompt: 'x', abortSignal: controller.signal, fallbackProviders: FALLBACK, onFallback });
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);
    const errors = parts.flatMap((part) => (part.type === 'error' ? [part.error] : []));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(reason);
    expect(await result.finishReason).toBe('error');
    expect(onFallback).not.toHaveBeenCalled();
    expect(hoisted.generateCompletionStream).toHaveBeenCalledTimes(1);
    expect(globalLLMProviderHealth.getStats('openai')).toBeNull();
  });
});
