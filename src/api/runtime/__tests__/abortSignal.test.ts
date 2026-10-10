import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, getProvider, createProviderManager };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-6-luna' })),
  resolveProvider: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-6-luna', apiKey: 'test-key' })),
  createProviderManager: hoisted.createProviderManager,
}));

import { embedText } from '../embedText.js';
import { generateObject } from '../generateObject.js';
import { generateText, isRetryableError } from '../generateText.js';

/** A completion that waits until its signal aborts, then rejects with the signal's reason. */
function waitsForAbort() {
  return vi.fn((_model: string, _messages: unknown, options: { abortSignal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      if (options.abortSignal === undefined) return reject(new Error('no signal reached the provider'));
      options.abortSignal.addEventListener('abort', () => reject(options.abortSignal!.reason), { once: true });
    }),
  );
}

const answer = (text: string) => ({ modelId: 'gpt-6-luna', usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 }, choices: [{ message: { role: 'assistant', content: text }, finishReason: 'stop' }] });

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('abortSignal', () => {
  it('reaches the provider from generateText and ends the call when it aborts', async () => {
    hoisted.generateCompletion.mockImplementation(waitsForAbort());
    const controller = new AbortController();
    const call = generateText({ model: 'openai:gpt-6-luna', prompt: 'x', abortSignal: controller.signal });
    // generateText sets up its provider before it sends; the abort lands while the request is in flight.
    await vi.waitFor(() => expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it('refuses at once, with no provider call, when the signal has already aborted', async () => {
    await expect(generateText({ model: 'openai:gpt-6-luna', prompt: 'x', abortSignal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(hoisted.generateCompletion).not.toHaveBeenCalled();
  });

  it('never walks the fallback chain on an abort', async () => {
    const abort = new DOMException('This operation was aborted', 'AbortError');
    expect(isRetryableError(abort)).toBe(false);
    expect(isRetryableError(Object.assign(new Error('Request aborted'), { code: 'REQUEST_ABORTED' }))).toBe(false);
  });

  it('reaches every attempt of generateObject, and an abort between attempts stops the retries', async () => {
    const controller = new AbortController();
    hoisted.generateCompletion.mockImplementationOnce(async (_m: string, _x: unknown, options: { abortSignal?: AbortSignal }) => {
      expect(options.abortSignal).toBe(controller.signal);
      controller.abort();
      return answer('not json');
    });
    const call = generateObject({ model: 'openai:gpt-6-luna', schema: z.object({ a: z.number() }), prompt: 'x', maxRetries: 2, abortSignal: controller.signal });
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it("passes the signal to embedText's fetch", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 0 }], model: 'text-embedding-3-small', usage: { prompt_tokens: 2, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const controller = new AbortController();
    await embedText({ provider: 'openai', model: 'text-embedding-3-small', input: 'x', apiKey: 'test-key', abortSignal: controller.signal });
    expect(seen[0]).toBeDefined();
    controller.abort();
    expect(seen[0]?.aborted).toBe(true);
  });
});
