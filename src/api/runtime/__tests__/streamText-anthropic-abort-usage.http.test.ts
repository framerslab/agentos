/**
 * @file streamText-anthropic-abort-usage.http.test.ts
 * A streamed Anthropic call that the caller aborts after output has streamed
 * reports what it used. Anthropic sends the input and cache counts on
 * `message_start` and the output count only on the final `message_delta`, so
 * an abort before that event used to end the stream with an abort chunk that
 * carried no usage, and streamText fired no usage event for a call that had
 * billed its prompt and every token streamed so far.
 *
 * Real fetch against a local HTTP server; nothing is mocked.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { streamText, type StreamPart } from '../../streamText.js';
import { setGlobalLlmObserver, type LlmUsageEvent } from '../../observers.js';
import { AnthropicProvider } from '../../../core/llm/providers/implementations/AnthropicProvider.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import type { ModelCompletionResponse } from '../../../core/llm/providers/IProvider.js';

/** The text deltas the server streams before it stalls: 48 characters in all, 12 tokens at four characters a token. */
const DELTAS = ['The lantern swung ', 'once, twice, then ', 'went dark.'.padEnd(12, ' ')];
const STREAMED_CHARS = DELTAS.join('').length;

/** How the server answers: `stall` sends message_start and the deltas, then holds the connection open. */
type Mode = 'stall' | 'finalThenStall';

let mode: Mode = 'stall';
let messagePosts = 0;
let server: http.Server;
let baseUrl: string;

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const messageStart = {
  type: 'message_start',
  message: {
    id: 'msg_abort_usage', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5-5',
    stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
  },
};

/** One server a test, on its own port: no connection a test left behind is reused by the next. */
async function startServer(): Promise<void> {
  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    messagePosts += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse(messageStart));
    res.write(sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    for (const text of DELTAS) {
      res.write(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
    }
    if (mode === 'finalThenStall') {
      res.write(sse({ type: 'content_block_stop', index: 0 }));
      res.write(sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 15 } }));
    }
    // The connection stays open: no message_delta (in `stall`) and no message_stop arrive before the abort.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(() => {
  // Without an Anthropic key in the environment the resolver can reroute to OpenRouter; keep it on Anthropic.
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-abort-usage-test');
  vi.stubEnv('OPENROUTER_API_KEY', undefined);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/** A usage event read with the abort and estimate marks this file checks. */
type MarkedEvent = LlmUsageEvent & {
  aborted?: boolean;
  usageEstimated?: boolean;
  usage: LlmUsageEvent['usage'] & { completionTokensEstimated?: boolean };
};

let events: MarkedEvent[];

beforeEach(async () => {
  mode = 'stall';
  messagePosts = 0;
  events = [];
  globalLLMProviderHealth.reset();
  setGlobalLlmObserver((event) => {
    events.push(event as MarkedEvent);
  });
  await startServer();
});

afterEach(async () => {
  setGlobalLlmObserver(null);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Reads `stream` until `abortAfter` text parts have arrived, aborts, then reads to the end; a throw becomes an error part. */
async function readThenAbort(
  stream: AsyncIterable<StreamPart>,
  controller: AbortController,
  abortAfter: number,
): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  let texts = 0;
  try {
    for await (const part of stream) {
      parts.push(part);
      if (part.type === 'text' && ++texts === abortAfter) controller.abort();
    }
  } catch (error) {
    parts.push({ type: 'error', error: error as Error });
  }
  return parts;
}

/** The parts as words, an error part with its message, so a failed assertion shows how the stream ended. */
function partTrail(parts: StreamPart[]): string[] {
  return parts.map((part) =>
    part.type === 'error' ? `error: ${(part.error as Error | undefined)?.message ?? String(part.error)}` : part.type,
  );
}

/** Lets the stream's finally (where the usage event fires) and any promise it starts settle. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('an aborted Anthropic stream reports its usage', () => {
  it('the provider ends the stream with an abort chunk carrying the input and cache counts and an estimated output count', async () => {
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'sk-ant-abort-usage-test', baseURL: baseUrl });
    const controller = new AbortController();

    const chunks: ModelCompletionResponse[] = [];
    let texts = 0;
    for await (const chunk of provider.generateCompletionStream(
      'claude-sonnet-5-5',
      [{ role: 'user', content: 'Tell a story.' }],
      { abortSignal: controller.signal },
    )) {
      chunks.push(chunk);
      if (chunk.responseTextDelta && ++texts === DELTAS.length) controller.abort();
    }

    const last = chunks[chunks.length - 1];
    expect(last?.error?.type).toBe('abort');
    expect(last?.isFinal).toBe(true);
    expect(last?.usage).toBeDefined();
    expect(last?.usage?.promptTokens).toBe(120);
    expect(last?.usage?.cacheReadInputTokens).toBe(300);
    expect(last?.usage?.cacheCreationInputTokens).toBe(40);
    expect(last?.usage?.inclusiveInputTokens).toBe(460);
    expect(last?.usage?.completionTokens).toBe(Math.ceil(STREAMED_CHARS / 4));
    expect(last?.usage?.totalTokens).toBe(120 + Math.ceil(STREAMED_CHARS / 4));
    const lastUsage = last?.usage as (ModelCompletionResponse['usage'] & { completionTokensEstimated?: boolean }) | undefined;
    expect(lastUsage?.completionTokensEstimated).toBe(true);
    expect(last?.usage?.costUSD).toBeGreaterThan(0);
  }, 20000);

  it('streamText fires exactly one usage event for the aborted call, marked aborted and estimated', async () => {
    const controller = new AbortController();
    const result = streamText({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      apiKey: 'sk-ant-abort-usage-test',
      baseUrl,
      prompt: 'Tell a story.',
      abortSignal: controller.signal,
      fallbackProviders: [],
    });

    const parts = await readThenAbort(result.fullStream, controller, DELTAS.length);
    await settled();

    expect(parts.filter((part) => part.type === 'text')).toHaveLength(DELTAS.length);
    expect(parts[parts.length - 1]?.type).toBe('error');
    // The call's own usage reports the same counts the event carries.
    expect({ trail: partTrail(parts), usage: await result.usage }).toMatchObject({
      usage: { promptTokens: 120, completionTokens: Math.ceil(STREAMED_CHARS / 4), completionTokensEstimated: true },
    });
    expect(events).toHaveLength(1);
    const event = events[0] as MarkedEvent;
    expect(event.provider).toBe('anthropic');
    expect(event.surface).toBe('streamText');
    expect(event.aborted).toBe(true);
    expect(event.usageEstimated).toBe(true);
    expect(event.usage.promptTokens).toBe(120);
    expect(event.usage.cacheReadTokens).toBe(300);
    expect(event.usage.cacheCreationTokens).toBe(40);
    expect(event.usage.inclusiveInputTokens).toBe(460);
    expect(event.usage.completionTokens).toBe(Math.ceil(STREAMED_CHARS / 4));
    expect(event.usage.completionTokensEstimated).toBe(true);
    expect(event.usage.costUSD).toBeGreaterThan(0);
  }, 20000);

  it('an abort after the final message_delta reports the provider count once, not an estimate on top of it', async () => {
    mode = 'finalThenStall';
    const controller = new AbortController();
    const result = streamText({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      apiKey: 'sk-ant-abort-usage-test',
      baseUrl,
      prompt: 'Tell a story.',
      abortSignal: controller.signal,
      fallbackProviders: [],
      __onUsageReport: () => controller.abort(),
    });

    // The abort comes once streamText has counted the final chunk's usage, while the server holds the connection.
    const parts: StreamPart[] = [];
    try {
      for await (const part of result.fullStream) parts.push(part);
    } catch (error) {
      parts.push({ type: 'error', error: error as Error });
    }
    await settled();

    expect({ posts: messagePosts, trail: partTrail(parts) }).toEqual({
      posts: 1,
      trail: ['text', 'text', 'text', expect.stringMatching(/abort/i)],
    });
    const usage = await result.usage;
    expect({ trail: partTrail(parts), usage }).toMatchObject({ usage: { promptTokens: 120, completionTokens: 15 } });
    expect(usage.completionTokensEstimated).toBeUndefined();
    expect(events).toHaveLength(1);
    const event = events[0] as MarkedEvent;
    expect(event.usage.promptTokens).toBe(120);
    expect(event.usage.completionTokens).toBe(15);
    expect(event.usage.completionTokensEstimated).toBeUndefined();
    expect(event.usageEstimated).toBeUndefined();
  }, 20000);
});
