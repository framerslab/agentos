/**
 * @file streamObject.elements.test.ts
 * Tests for streamObject's element stream, its per-request timeout and its reported usage.
 *
 * Mocks the provider layer as streamObject.test.ts does, with a stream whose chunks the test releases one at a
 * time. Several cases never read `object`, which rejects there: Vitest fails a run on an unhandled rejection, so
 * those cases also hold that an object nobody reads raises none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const hoisted = vi.hoisted(() => {
  const generateCompletionStream = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletionStream }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletionStream, getProvider, createProviderManager };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4o' })),
  resolveProvider: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4o', apiKey: 'test-key' })),
  createProviderManager: hoisted.createProviderManager,
}));

import { streamObject } from '../../streamObject.js';
import { ObjectGenerationError } from '../../generateObject.js';

/** One text delta chunk, as the provider manager yields it; the last carries the usage. */
function chunk(text: string, last = false) {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 1,
    modelId: 'gpt-4o',
    choices: [{ index: 0, delta: { content: text }, finishReason: last ? 'stop' : null }],
    responseTextDelta: text,
    isFinal: last,
    ...(last ? { usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } } : {}),
  };
}

/** The chunk that ends a reply the token limit cut off: no text, the finish reason 'length', and the usage. */
function limitReached() {
  const last = chunk('', true);
  return { ...last, choices: [{ ...last.choices[0], finishReason: 'length' }] };
}

/** A stream the test feeds piece by piece: `feed` releases the next piece, `cut` throws inside the stream. */
function gatedStream(pieces: string[]) {
  const gates: Array<() => void> = [];
  let failure: Error | null = null;
  async function* run() {
    for (const [at, piece] of pieces.entries()) {
      await new Promise<void>((resolve) => gates.push(resolve));
      if (failure !== null) throw failure;
      yield chunk(piece, at === pieces.length - 1);
    }
  }
  return {
    stream: run(),
    feed: async () => {
      while (gates.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      gates.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    cut: async (error: Error) => {
      failure = error;
      while (gates.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      gates.shift()!();
    },
  };
}

const Answer = z.object({ sentences: z.array(z.object({ text: z.string().min(1), passage: z.number().int().min(1) })).max(6) });
const PIECES = ['{"sentences":[{"text":"One","passage":1},', '{"text":"Two","passage":2},', '{"text":"Three","passage":3}', ']}'];
/** An answer whose schema puts a field after the array. */
const Summarized = z.object({ sentences: Answer.shape.sentences, summary: z.string() });

describe('streamObject with elements', () => {
  beforeEach(() => vi.clearAllMocks());

  it('yields each element once the next begins, the last at the end, in order', async () => {
    const gated = gatedStream(PIECES);
    hoisted.generateCompletionStream.mockReturnValue(gated.stream);
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p' });
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const element of result.elementStream) seen.push(element);
    })();
    await gated.feed();
    expect(seen).toEqual([]);
    await gated.feed();
    expect(seen).toEqual([{ text: 'One', passage: 1 }]);
    await gated.feed();
    expect(seen).toHaveLength(2);
    await gated.feed();
    await reading;
    expect(seen).toEqual([{ text: 'One', passage: 1 }, { text: 'Two', passage: 2 }, { text: 'Three', passage: 3 }]);
    expect(await result.skipped).toBe(0);
    expect(await result.reportedUsage).toEqual(expect.objectContaining({ promptTokens: 10, completionTokens: 20 }));
  });

  it('skips and counts an element that fails its schema', async () => {
    const gated = gatedStream(['{"sentences":[{"text":"","passage":1},', '{"text":"Two","passage":2}]}']);
    hoisted.generateCompletionStream.mockReturnValue(gated.stream);
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p' });
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const element of result.elementStream) seen.push(element);
    })();
    await gated.feed();
    await gated.feed();
    await reading;
    expect(seen).toEqual([{ text: 'Two', passage: 2 }]);
    expect(await result.skipped).toBe(1);
  });

  it('ends the iteration on an abort, and reports no usage', async () => {
    const gated = gatedStream(PIECES);
    hoisted.generateCompletionStream.mockReturnValue(gated.stream);
    const controller = new AbortController();
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p', abortSignal: controller.signal });
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const element of result.elementStream) seen.push(element);
    })().catch(() => undefined);
    await gated.feed();
    await gated.feed();
    controller.abort(new Error('stop'));
    await gated.cut(new Error('aborted'));
    await reading;
    expect(seen).toEqual([{ text: 'One', passage: 1 }]);
    expect(await result.reportedUsage).toBeUndefined();
  });

  it('resolves the reported usage as undefined, never zero, when the stream is cut mid-answer', async () => {
    const gated = gatedStream(PIECES);
    hoisted.generateCompletionStream.mockReturnValue(gated.stream);
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p' });
    const reading = (async () => {
      for await (const element of result.elementStream) void element;
    })().catch(() => undefined);
    await gated.feed();
    await gated.feed();
    await gated.cut(new Error('socket hang up'));
    await reading;
    expect(await result.reportedUsage).toBeUndefined();
  });

  it("throws the stream's failure from elementStream after the elements before it, so a failed answer never reads as a finished one", async () => {
    const gated = gatedStream(PIECES);
    hoisted.generateCompletionStream.mockReturnValue(gated.stream);
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p' });
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const element of result.elementStream) seen.push(element);
    })();
    await gated.feed();
    await gated.feed();
    await gated.cut(new Error('socket hang up'));
    await expect(reading).rejects.toThrow('socket hang up');
    expect(seen).toEqual([{ text: 'One', passage: 1 }]);
    expect(await result.reportedUsage).toBeUndefined();
    await expect(result.object).rejects.toThrow(/Stream interrupted/);
  });

  it('throws the error the object rejects with from elementStream, after the elements before it, when the text does not parse at the end', async () => {
    // The token limit cut the reply off inside its second element, and the stream ended normally.
    hoisted.generateCompletionStream.mockReturnValue((async function* () {
      yield chunk('{"sentences":[{"text":"One","passage":1},{"text":"Tw');
      yield limitReached();
    })());
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p' });
    const seen: unknown[] = [];
    const thrown = await (async () => {
      for await (const element of result.elementStream) seen.push(element);
    })().then(() => undefined, (error: unknown) => error);
    expect(seen).toEqual([{ text: 'One', passage: 1 }]);
    const rejection = await result.object.then(() => undefined, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(ObjectGenerationError);
    expect((rejection as Error).message).toMatch(/^Failed to parse streamed JSON/);
    expect(thrown).toBe(rejection);
  });

  it('ends elementStream with nothing yielded when the reply is empty, and rejects the object', async () => {
    hoisted.generateCompletionStream.mockReturnValue((async function* () {
      yield chunk('', true);
    })());
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p' });
    const seen: unknown[] = [];
    for await (const element of result.elementStream) seen.push(element);
    expect(seen).toEqual([]);
    await expect(result.object).rejects.toThrow(ObjectGenerationError);
  });

  it("yields the elements before the next one when a chunk ends inside that one's first key, and keeps them when the stream is cut there", async () => {
    // A provider that sends several tokens a chunk can end one inside the key of the element that follows.
    const gated = gatedStream(['{"sentences":[{"text":"One","passage":1},{"text":"Two","passage":2},{"te', 'xt":"Three","passage":3}]}']);
    hoisted.generateCompletionStream.mockReturnValue(gated.stream);
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p' });
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const element of result.elementStream) seen.push(element);
    })();
    await gated.feed();
    expect(seen).toEqual([{ text: 'One', passage: 1 }, { text: 'Two', passage: 2 }]);
    await gated.cut(new Error('socket hang up'));
    await expect(reading).rejects.toThrow('socket hang up');
    expect(seen).toEqual([{ text: 'One', passage: 1 }, { text: 'Two', passage: 2 }]);
    await expect(result.object).rejects.toThrow(/Stream interrupted/);
  });

  it("yields the last element once the array's closing bracket arrives, when the schema puts a field after the array", async () => {
    const gated = gatedStream([
      '{"sentences":[{"text":"One","passage":1},{"text":"Two","passage":2}',
      ']',
      ',"summary":"Two sentences',
      '."}',
    ]);
    hoisted.generateCompletionStream.mockReturnValue(gated.stream);
    const result = streamObject({ model: 'openai:gpt-4o', schema: Summarized, elements: 'sentences', prompt: 'p' });
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const element of result.elementStream) seen.push(element);
    })();
    await gated.feed();
    expect(seen).toEqual([{ text: 'One', passage: 1 }]);
    await gated.feed();
    expect(seen).toEqual([{ text: 'One', passage: 1 }, { text: 'Two', passage: 2 }]);
    await gated.feed();
    await gated.feed();
    await reading;
    expect(seen).toHaveLength(2);
    await expect(result.object).resolves.toEqual({
      sentences: [{ text: 'One', passage: 1 }, { text: 'Two', passage: 2 }],
      summary: 'Two sentences.',
    });
  });

  it('yields the last element when the chunk that closes the array ends inside the key of the field after it', async () => {
    const gated = gatedStream([
      '{"sentences":[{"text":"One","passage":1},{"text":"Two","passage":2}',
      '],"summ',
      'ary":"Two sentences."}',
    ]);
    hoisted.generateCompletionStream.mockReturnValue(gated.stream);
    const result = streamObject({ model: 'openai:gpt-4o', schema: Summarized, elements: 'sentences', prompt: 'p' });
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const element of result.elementStream) seen.push(element);
    })();
    await gated.feed();
    expect(seen).toEqual([{ text: 'One', passage: 1 }]);
    await gated.feed();
    expect(seen).toEqual([{ text: 'One', passage: 1 }, { text: 'Two', passage: 2 }]);
    await gated.feed();
    await reading;
    expect(seen).toHaveLength(2);
    expect(await result.skipped).toBe(0);
  });

  it('yields the whole last element of a fenced reply whose closing bracket and fence arrive in one chunk', async () => {
    // The fence after the bracket keeps the text from parsing, so the elements are read from the text cut back to its
    // last comma, inside the last element: that text holds no closing bracket, and the part of the element in it is
    // not taken as the element.
    const gated = gatedStream(['```json\n{"sentences":[{"text":"One","passage":1},', '{"text":"Two","passage":2}', ']}\n```']);
    hoisted.generateCompletionStream.mockReturnValue(gated.stream);
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p' });
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const element of result.elementStream) seen.push(element);
    })();
    await gated.feed();
    expect(seen).toEqual([]);
    await gated.feed();
    expect(seen).toEqual([{ text: 'One', passage: 1 }]);
    await gated.feed();
    await reading;
    expect(seen).toEqual([{ text: 'One', passage: 1 }, { text: 'Two', passage: 2 }]);
    expect(await result.skipped).toBe(0);
  });

  it('reads a stream that ended with no usage reported as unknown usage, never zero', async () => {
    const gated = gatedStream(['{"sentences":[]}']);
    hoisted.generateCompletionStream.mockReturnValue((async function* () {
      for await (const piece of gated.stream) yield { ...piece, usage: undefined };
    })());
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p' });
    const reading = (async () => {
      for await (const element of result.elementStream) void element;
    })();
    await gated.feed();
    await reading;
    expect(await result.reportedUsage).toBeUndefined();
  });

  it("keeps a provider's report of zero tokens as the reported usage", async () => {
    hoisted.generateCompletionStream.mockReturnValue((async function* () {
      yield { ...chunk('{"sentences":[]}', true), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    })());
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p' });
    for await (const element of result.elementStream) void element;
    expect(await result.reportedUsage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('passes requestTimeout to the provider', async () => {
    hoisted.generateCompletionStream.mockReturnValue(gatedStream([]).stream);
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p', requestTimeout: 4321 });
    for await (const element of result.elementStream) void element;
    expect(hoisted.generateCompletionStream).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ requestTimeout: 4321 }));
  });

  it('settles the result when the reader stops early: no reported usage, and the object rejects', async () => {
    const gated = gatedStream(PIECES);
    hoisted.generateCompletionStream.mockReturnValue(gated.stream);
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p' });
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const element of result.elementStream) {
        seen.push(element);
        break;
      }
    })();
    await gated.feed();
    await gated.feed();
    await reading;
    expect(seen).toEqual([{ text: 'One', passage: 1 }]);
    expect(await result.skipped).toBe(0);
    expect(await result.reportedUsage).toBeUndefined();
    await expect(result.object).rejects.toThrow(/Stream interrupted/);
  });

  it('throws from an elementStream read after the only reader stopped the stream, once it yields the elements completed before the stop', async () => {
    const gated = gatedStream(PIECES);
    hoisted.generateCompletionStream.mockReturnValue(gated.stream);
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p' });
    const watching = (async () => {
      for await (const partial of result.partialObjectStream) {
        if ((partial.sentences?.length ?? 0) > 1) break;
      }
    })();
    await gated.feed();
    await gated.feed();
    await watching;
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const element of result.elementStream) seen.push(element);
    })();
    await expect(reading).rejects.toThrow(/Stream interrupted/);
    expect(seen).toEqual([{ text: 'One', passage: 1 }]);
    await expect(result.object).rejects.toThrow(/Stream interrupted/);
  });

  it("rejects the object with the signal's reason when the reader stops after the signal aborted", async () => {
    const gated = gatedStream(PIECES);
    hoisted.generateCompletionStream.mockReturnValue(gated.stream);
    const controller = new AbortController();
    const reason = new Error('stop');
    const result = streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'sentences', prompt: 'p', abortSignal: controller.signal });
    const reading = (async () => {
      for await (const element of result.elementStream) {
        void element;
        controller.abort(reason);
        break;
      }
    })();
    await gated.feed();
    await gated.feed();
    await reading;
    await expect(result.object).rejects.toBe(reason);
    expect(await result.reportedUsage).toBeUndefined();
  });

  it('throws at the call, before any request, when elements names no array field of the schema', () => {
    expect(() => streamObject({ model: 'openai:gpt-4o', schema: Answer, elements: 'answer', prompt: 'p' })).toThrow(TypeError);
    expect(hoisted.generateCompletionStream).not.toHaveBeenCalled();
  });
});
