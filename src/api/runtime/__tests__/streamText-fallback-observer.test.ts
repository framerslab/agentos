/**
 * @file streamText-fallback-observer.test.ts
 * Usage-observer correctness on streaming fallback + error terminals.
 *
 * A fallback-served stream historically fired TWO usage events: the
 * recursive leg's own (correct — leg provider/model, fallbackDepth
 * stamped) plus the outer finally's aggregate, which still named the
 * FAILED primary, carried the leg's folded token counts, and omitted
 * fallbackDepth (opts.__fallbackDepth is absent at the top level). Hosts
 * keying on the documented contract ("fallbackDepth absent == primary
 * traffic") double-counted the answer and booked the diverted spend under
 * the provider that never served it — the exact 2026-07-20..26
 * misattribution the field was added to eliminate. Conversely, error
 * terminals suppressed the event entirely even when the stream had
 * already accrued real billable usage.
 *
 * These tests pin the corrected contract:
 *  - fallback-served: exactly ONE event, attributed to the winning leg,
 *    stamped with its hop depth;
 *  - error terminal with accrued usage: ONE event, finishReason 'error';
 *  - error terminal with zero usage: silent (nothing to meter).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const generateCompletionStream = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion, generateCompletionStream }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, generateCompletionStream, getProvider, createProviderManager };
});

vi.mock('../../model.js', () => ({
  parseModelString: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-5.5' })),
  // Pass-through: the fallback recursion re-enters with the leg's
  // provider/model on opts, and attribution asserts depend on it.
  resolveModelOption: vi.fn((o: { provider?: string; model?: string }) => ({
    providerId: o?.provider ?? 'openai',
    modelId: o?.model ?? 'gpt-5.5',
  })),
  resolveProvider: vi.fn((providerId?: string, modelId?: string) => ({
    providerId: providerId ?? 'openai',
    modelId: modelId ?? 'gpt-5.5',
    apiKey: 'test-key',
  })),
  createProviderManager: hoisted.createProviderManager,
}));

import { setGlobalLlmObserver, type LlmUsageEvent } from '../../observers.js';
import { streamText } from '../streamText.js';

/** Final chunk carrying the step's usage (providers report usage here). */
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
    usage: { promptTokens: 8000, completionTokens: 2000, totalTokens: 10000 },
  };
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

describe('streamText usage observer — fallback + error terminals', () => {
  let events: LlmUsageEvent[];

  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
    hoisted.generateCompletionStream.mockReset();
    events = [];
    setGlobalLlmObserver((e) => {
      events.push(e);
    });
  });

  afterEach(() => {
    setGlobalLlmObserver(null);
  });

  it('fires exactly ONE event for a fallback-served stream, attributed to the leg with its hop depth', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () {
        throw new Error('[429] rate limited');
      })
      .mockImplementationOnce(async function* () {
        yield finalChunk('served by leg', 'claude-sonnet-5');
      });

    const result = streamText({
      provider: 'openai',
      model: 'gpt-5.5',
      prompt: 'Hello',
      source: 'narrator_turn',
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-sonnet-5' }],
    });
    const text = await drain(result.textStream);
    expect(text).toBe('served by leg');

    const streamEvents = events.filter((e) => e.surface === 'streamText');
    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0]!.provider).toBe('anthropic');
    expect(streamEvents[0]!.model).toBe('claude-sonnet-5');
    expect(streamEvents[0]!.fallbackDepth).toBe(1);
    expect(streamEvents[0]!.source).toBe('narrator_turn');
    expect(streamEvents[0]!.usage.completionTokens).toBe(2000);
  });

  it("fires one 'error' event when an error terminal has accrued billable usage", async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      // Step usage lands (final chunk), then the stream reports a failure —
      // the shape of a mid-loop death after real tokens were consumed.
      yield finalChunk('partial answer', 'gpt-5.5');
      yield {
        id: 'chunk-err',
        object: 'chat.completion.chunk',
        created: 2,
        modelId: 'gpt-5.5',
        choices: [],
        error: { message: 'upstream died mid-stream' },
      };
    });

    const result = streamText({
      provider: 'openai',
      model: 'gpt-5.5',
      prompt: 'Hello',
      fallbackProviders: [],
    });
    await drain(result.textStream);

    const streamEvents = events.filter((e) => e.surface === 'streamText');
    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0]!.finishReason).toBe('error');
    expect(streamEvents[0]!.provider).toBe('openai');
    expect(streamEvents[0]!.usage.promptTokens).toBe(8000);
    expect(streamEvents[0]!.fallbackDepth).toBeUndefined();
  });

  it('stays silent on an error terminal with zero accrued usage', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      throw new Error('[500] boom');
    });

    const result = streamText({
      provider: 'openai',
      model: 'gpt-5.5',
      prompt: 'Hello',
      fallbackProviders: [],
    });
    await drain(result.textStream);

    expect(events.filter((e) => e.surface === 'streamText')).toHaveLength(0);
  });
});
