/**
 * Tests for the global LLM usage observer registration and dispatch.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  setGlobalLlmObserver,
  getGlobalLlmObserver,
  fireLlmUsageObserver,
} from '../observers.js';
import type { LlmUsageEvent } from '../observers.js';
import { agent } from '../agent.js';
import { generateObject } from '../generateObject.js';
import { generateText } from '../generateText.js';
import { streamText } from '../streamText.js';
import { SpendBudget } from '../runtime/spendBudget.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

function makeEvent(overrides?: Partial<LlmUsageEvent>): LlmUsageEvent {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      costUSD: 0.012,
    },
    source: 'unit-test',
    finishReason: 'stop',
    surface: 'generateText',
    ...overrides,
  };
}

beforeEach(() => {
  setGlobalLlmObserver(null);
});

afterEach(() => {
  setGlobalLlmObserver(null);
});

describe('setGlobalLlmObserver / getGlobalLlmObserver', () => {
  it('returns null when no observer is registered', () => {
    expect(getGlobalLlmObserver()).toBeNull();
  });

  it('registers and retrieves the observer', () => {
    const obs = vi.fn();
    setGlobalLlmObserver(obs);
    expect(getGlobalLlmObserver()).toBe(obs);
  });

  it('clears the observer when null is passed', () => {
    setGlobalLlmObserver(vi.fn());
    setGlobalLlmObserver(null);
    expect(getGlobalLlmObserver()).toBeNull();
  });

  it('replaces an existing observer (last writer wins)', () => {
    const first = vi.fn();
    const second = vi.fn();
    setGlobalLlmObserver(first);
    setGlobalLlmObserver(second);
    expect(getGlobalLlmObserver()).toBe(second);
  });
});

describe('fireLlmUsageObserver', () => {
  it('no-ops when no observer is registered (does not throw)', () => {
    expect(() => fireLlmUsageObserver(makeEvent())).not.toThrow();
  });

  it('passes the full event payload to the observer', () => {
    const obs = vi.fn();
    setGlobalLlmObserver(obs);
    const event = makeEvent({ source: 'narrator_turn' });
    fireLlmUsageObserver(event);
    expect(obs).toHaveBeenCalledTimes(1);
    expect(obs).toHaveBeenCalledWith(event);
  });

  it('swallows synchronous errors from the observer', () => {
    setGlobalLlmObserver(() => {
      throw new Error('observer crash');
    });
    expect(() => fireLlmUsageObserver(makeEvent())).not.toThrow();
  });

  it('swallows promise rejections from async observers', async () => {
    setGlobalLlmObserver(async () => {
      throw new Error('async observer crash');
    });
    expect(() => fireLlmUsageObserver(makeEvent())).not.toThrow();
    // Yield to the microtask queue so the rejection lands + gets swallowed.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('forwards source label and surface so hosts can route by meter', () => {
    const obs = vi.fn();
    setGlobalLlmObserver(obs);
    fireLlmUsageObserver(makeEvent({ source: 'companion_reply', surface: 'streamText' }));
    expect(obs.mock.calls[0][0].source).toBe('companion_reply');
    expect(obs.mock.calls[0][0].surface).toBe('streamText');
  });

  it('forwards latency + serving-host fields when present', () => {
    const obs = vi.fn();
    setGlobalLlmObserver(obs);
    fireLlmUsageObserver(
      makeEvent({
        surface: 'streamText',
        durationMs: 8421,
        ttfbMs: 612,
        servingProvider: 'Groq',
      }),
    );
    const seen = obs.mock.calls[0][0];
    expect(seen.durationMs).toBe(8421);
    expect(seen.ttfbMs).toBe(612);
    expect(seen.servingProvider).toBe('Groq');
  });

  it('leaves latency fields undefined when the surface did not measure them', () => {
    const obs = vi.fn();
    setGlobalLlmObserver(obs);
    fireLlmUsageObserver(makeEvent());
    const seen = obs.mock.calls[0][0];
    expect(seen.durationMs).toBeUndefined();
    expect(seen.ttfbMs).toBeUndefined();
    expect(seen.servingProvider).toBeUndefined();
  });

  it('forwards cache-token fields when present on usage', () => {
    const obs = vi.fn();
    setGlobalLlmObserver(obs);
    fireLlmUsageObserver(
      makeEvent({
        usage: {
          promptTokens: 1000,
          completionTokens: 50,
          totalTokens: 1050,
          costUSD: 0.005,
          cacheReadTokens: 800,
          cacheCreationTokens: 200,
        },
      }),
    );
    expect(obs.mock.calls[0][0].usage.cacheReadTokens).toBe(800);
    expect(obs.mock.calls[0][0].usage.cacheCreationTokens).toBe(200);
  });
});

/** A Claude reply as its streamed events, the way the real provider reads one; only fetch is stubbed below. */
function claudeEvents(model: string, events: unknown[]): () => Response {
  const start = {
    type: 'message_start',
    message: {
      id: `msg_${model}`, type: 'message', role: 'assistant', content: [], model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
    },
  };
  return () =>
    new Response([start, ...events].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
}

/** A reply whose text is `text`. */
const textReply = (model: string, text: string) =>
  claudeEvents(model, [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]);

/** A reply that ends with no text and no tool call. */
const emptyReply = (model: string) =>
  claudeEvents(model, [
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]);

/** A reply that calls the `lookup` tool. */
const toolReply = (model: string) =>
  claudeEvents(model, [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]);

/** A turn Claude refuses before writing anything, and bills: a call's failed attempt. */
const refusalReply = (model: string) =>
  claudeEvents(model, [
    {
      type: 'message_delta',
      delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'example' } },
      usage: { output_tokens: 4 },
    },
    { type: 'message_stop' },
  ]);

const PRIMARY = 'claude-opus-5-5';
const FALLBACK = 'claude-opus-4-8';
const lookup = {
  id: 'lookup', name: 'lookup', displayName: 'Lookup', description: 'Look it up.',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ success: true, output: 'ok' }),
};

/** Answers each request with the next reply queued for its model. */
function route(replies: Record<string, Array<() => Response>>): void {
  fetchMock.mockImplementation(async (_url: unknown, init?: { body?: unknown }) => {
    const model = String((JSON.parse(String(init?.body)) as { model?: unknown }).model);
    const next = replies[model]?.shift();
    if (!next) throw new Error(`unexpected request for model ${model}`);
    return next();
  });
}

/** Reads a stream to its end. */
async function drain(parts: AsyncIterable<unknown>): Promise<void> {
  for await (const _part of parts) {
    // read and dropped
  }
}

describe('the account on a call\'s usage event, over the real Anthropic provider', () => {
  const call = { provider: 'anthropic', model: PRIMARY, prompt: 'Hello?', apiKey: 'sk-ant-usage-test', fallbackProviders: [] };
  let events: LlmUsageEvent[];

  beforeEach(() => {
    fetchMock.mockReset();
    globalLLMProviderHealth.reset();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-usage-test');
    events = [];
    setGlobalLlmObserver((event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("generateText: an event for a call with budget.options.accountId carries it", async () => {
    route({ [PRIMARY]: [textReply(PRIMARY, 'One.')] });
    await generateText({ ...call, budget: new SpendBudget({ maxCostUSD: 100, accountId: 'acct-1' }) });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ surface: 'generateText', finishReason: 'stop', accountId: 'acct-1' });
  });

  it('generateText: a budget given as settings names the account too', async () => {
    route({ [PRIMARY]: [textReply(PRIMARY, 'One.')] });
    await generateText({ ...call, budget: { maxCostUSD: 100, accountId: 'acct-1' } });
    expect(events[0]).toMatchObject({ accountId: 'acct-1' });
  });

  it('generateText: with no budget, or a budget that names no account, the field is absent', async () => {
    route({ [PRIMARY]: [textReply(PRIMARY, 'One.'), textReply(PRIMARY, 'Two.')] });
    await generateText(call);
    await generateText({ ...call, budget: { maxCostUSD: 100 } });
    expect(events).toHaveLength(2);
    for (const event of events) expect(event).not.toHaveProperty('accountId');
  });

  it("a budget that names no account takes the one its parent names; its own wins over its parent's", async () => {
    route({ [PRIMARY]: [textReply(PRIMARY, 'One.'), textReply(PRIMARY, 'Two.')] });
    const parent = new SpendBudget({ maxCostUSD: 100, accountId: 'acct-parent' });
    await generateText({ ...call, budget: new SpendBudget({ maxCostUSD: 50, parent }) });
    await generateText({ ...call, budget: new SpendBudget({ maxCostUSD: 50, parent, accountId: 'acct-own' }) });
    expect(events[0]).toMatchObject({ accountId: 'acct-parent' });
    expect(events[1]).toMatchObject({ accountId: 'acct-own' });
  });

  it('generateText: a reply with no text carries it', async () => {
    route({ [PRIMARY]: [emptyReply(PRIMARY)] });
    await generateText({ ...call, budget: { maxCostUSD: 100, accountId: 'acct-1' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ accountId: 'acct-1' });
  });

  it('generateText: a call that runs out of steps on a tool call carries it', async () => {
    route({ [PRIMARY]: [toolReply(PRIMARY)] });
    await generateText({ ...call, tools: [lookup] as any, maxSteps: 1, budget: { maxCostUSD: 100, accountId: 'acct-1' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ finishReason: 'tool-calls', accountId: 'acct-1' });
  });

  it('generateText: a billed failure that ends the call carries it', async () => {
    route({ [PRIMARY]: [refusalReply(PRIMARY)] });
    await expect(generateText({ ...call, budget: { maxCostUSD: 100, accountId: 'acct-1' } })).rejects.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ finishReason: 'error', accountId: 'acct-1' });
  });

  it('generateText: the billed failure and the fallback leg that answered both carry it', async () => {
    route({ [PRIMARY]: [refusalReply(PRIMARY)], [FALLBACK]: [textReply(FALLBACK, 'Recovered.')] });
    await generateText({ ...call, fallbackProviders: [{ provider: 'anthropic', model: FALLBACK }], budget: { maxCostUSD: 100, accountId: 'acct-1' } });
    expect(events.map((e) => [e.model, e.finishReason])).toEqual([
      [PRIMARY, 'error'],
      [FALLBACK, 'stop'],
    ]);
    for (const event of events) expect(event).toMatchObject({ accountId: 'acct-1' });
  });

  it('streamText: an event carries it, and without one the field is absent', async () => {
    route({ [PRIMARY]: [textReply(PRIMARY, 'One.'), textReply(PRIMARY, 'Two.')] });
    await drain(streamText({ ...call, budget: { maxCostUSD: 100, accountId: 'acct-1' } }).fullStream);
    await drain(streamText(call).fullStream);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ surface: 'streamText', accountId: 'acct-1' });
    expect(events[1]).not.toHaveProperty('accountId');
  });

  it('streamText: the billed failure and the fallback leg that answered both carry it', async () => {
    route({ [PRIMARY]: [refusalReply(PRIMARY)], [FALLBACK]: [textReply(FALLBACK, 'Recovered.')] });
    await drain(
      streamText({ ...call, fallbackProviders: [{ provider: 'anthropic', model: FALLBACK }], budget: { maxCostUSD: 100, accountId: 'acct-1' } }).fullStream,
    );
    expect(events.map((e) => [e.model, e.finishReason]).sort()).toEqual([
      [FALLBACK, 'stop'],
      [PRIMARY, 'error'],
    ]);
    for (const event of events) expect(event).toMatchObject({ accountId: 'acct-1' });
  });

  it('generateObject: the event of the call it makes carries it', async () => {
    route({ [PRIMARY]: [textReply(PRIMARY, '{"answer":"yes"}')] });
    const { object } = await generateObject({ ...call, schema: z.object({ answer: z.string() }), budget: { maxCostUSD: 100, accountId: 'acct-1' } });
    expect(object).toEqual({ answer: 'yes' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ accountId: 'acct-1' });
  });

  it("agent(): generate(), stream() and a session's send() carry the agent's budget's account, and a send's budget replaces it", async () => {
    route({ [PRIMARY]: [textReply(PRIMARY, 'One.'), textReply(PRIMARY, 'Two.'), textReply(PRIMARY, 'Three.'), textReply(PRIMARY, 'Four.')] });
    const a = agent({ provider: 'anthropic', model: PRIMARY, apiKey: 'sk-ant-usage-test', fallbackProviders: [], budget: { maxCostUSD: 100, accountId: 'acct-agent' } });
    await a.generate('Hello?');
    await drain(a.stream('Hello?').fullStream);
    const session = a.session('s');
    await session.send('Hello?');
    await session.send('Again?', { budget: { maxCostUSD: 100, accountId: 'acct-send' } });
    expect(events).toHaveLength(4);
    expect(events.slice(0, 3).map((e) => e.surface)).toEqual(['generateText', 'streamText', 'generateText']);
    for (const event of events.slice(0, 3)) expect(event).toMatchObject({ accountId: 'acct-agent' });
    expect(events[3]).toMatchObject({ accountId: 'acct-send' });
  });
});
