import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'text-embedding-3-small' })),
  resolveProvider: vi.fn((providerId: string, modelId: string) => ({
    providerId, modelId, apiKey: 'test-key',
  })),
  createProviderManager: vi.fn(),
}));
vi.mock('../usageLedger.js', () => ({ recordAgentOSUsage: vi.fn(async () => true) }));

import { embedText } from '../embedText.js';
import { recordAgentOSUsage } from '../usageLedger.js';

function inputs(count: number): string[] {
  return Array.from({ length: count }, (_, i) => String(i));
}

function reply(input: string[], promptTokens = input.length, totalTokens = promptTokens): Response {
  return new Response(JSON.stringify({
    data: input.map((text, index) => ({ index, embedding: [Number(text)] })).reverse(),
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: promptTokens, total_tokens: totalTokens },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function requests(): { input: string[]; model: string; dimensions?: number }[] {
  return vi.mocked(globalThis.fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
}

describe('embedText OpenAI-compatible batches', () => {
  beforeEach(() => {
    vi.mocked(recordAgentOSUsage).mockClear();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      reply(JSON.parse(String(init?.body)).input),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('sends 5000 inputs in ordered batches of 2048, 2048 and 904', async () => {
    const input = inputs(5000);
    const signal = new AbortController().signal;
    const result = await embedText({ input, dimensions: 1, abortSignal: signal });

    expect(requests().map((body) => body.input.length)).toEqual([2048, 2048, 904]);
    expect(requests().flatMap((body) => body.input)).toEqual(input);
    expect(result.embeddings).toEqual(input.map((text) => [Number(text)]));
    for (const body of requests()) {
      expect(body.model).toBe('text-embedding-3-small');
      expect(body.dimensions).toBe(1);
    }
    for (const [, init] of vi.mocked(globalThis.fetch).mock.calls) expect(init?.signal).toBe(signal);
  });

  it('starts a new batch when UTF-8 bytes would exceed 300000', async () => {
    const input = Array.from({ length: 101 }, () => '界'.repeat(1000));
    await embedText({ input });

    expect(requests().map((body) => body.input.length)).toEqual([100, 1]);
    expect(requests().flatMap((body) => body.input)).toEqual(input);
  });

  it('sums prompt and total usage from every batch', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(reply(inputs(2048), 12, 15))
      .mockResolvedValueOnce(reply(['2048'], 7, 9));
    const result = await embedText({ input: inputs(2049) });

    expect(result.usage).toMatchObject({ promptTokens: 19, totalTokens: 24 });
    expect(recordAgentOSUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ promptTokens: 19, totalTokens: 24 }),
    }));
  });

  it('records the first batch usage when the second request returns 500', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(reply(inputs(2048), 12, 15))
      .mockResolvedValueOnce(new Response('failed', { status: 500 }));

    await expect(embedText({ input: inputs(5000) })).rejects.toThrow(/500/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(recordAgentOSUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ promptTokens: 12, totalTokens: 15 }),
    }));
  });

  it('sends no second request when the signal aborts after the first batch', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
      controller.abort(reason);
      return reply(inputs(2048), 12, 15);
    });

    await expect(embedText({ input: inputs(2049), abortSignal: controller.signal })).rejects.toBe(reason);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(recordAgentOSUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ promptTokens: 12, totalTokens: 15 }),
    }));
  });

  it('honours maxInputsPerRequest of 100', async () => {
    await embedText({ input: inputs(250), maxInputsPerRequest: 100 });
    expect(requests().map((body) => body.input.length)).toEqual([100, 100, 50]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2049])('rejects invalid batch size %s before sending', async (maxInputsPerRequest) => {
    await expect(embedText({ input: ['0'], maxInputsPerRequest })).rejects.toThrow(RangeError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects an input exceeding the byte bound without sending it', async () => {
    await expect(embedText({ input: 'x'.repeat(300001) })).rejects.toThrow(
      new RangeError('Embedding input at index 0 is 300001 UTF-8 bytes and exceeds the 300,000 UTF-8 byte request bound.'),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(recordAgentOSUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }));
  });

  it('rejects an oversized input after 2048 short inputs before sending any request', async () => {
    await expect(embedText({ input: [...inputs(2048), '界'.repeat(100001)] })).rejects.toThrow(
      new RangeError('Embedding input at index 2048 is 300003 UTF-8 bytes and exceeds the 300,000 UTF-8 byte request bound.'),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(recordAgentOSUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }));
  });
});
