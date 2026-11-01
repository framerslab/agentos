/**
 * @file streamText-anthropic-requestTimeout.http.test.ts
 * A streamed Anthropic call honours the per-call `requestTimeout`, as the
 * generate path and the other providers' streams do. The stream path used to
 * open its connection with the provider's configured timeout (90 s by
 * default) whatever the call asked for, so a server that never answered held
 * a stream for 90 s though the caller had set 2 s.
 *
 * Real fetch against a local HTTP server; nothing is mocked.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { streamText, type StreamPart } from '../../streamText.js';
import { AnthropicProvider } from '../../../core/llm/providers/implementations/AnthropicProvider.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

/** How the server answers a `POST /v1/messages`. */
type Mode = { kind: 'silent' } | { kind: 'late'; delayMs: number; text: string };

let mode: Mode = { kind: 'silent' };
let messagePosts = 0;
let server: http.Server;
let baseUrl: string;
const savedKeys = { anthropic: process.env.ANTHROPIC_API_KEY, openrouter: process.env.OPENROUTER_API_KEY };

/** The SSE body of a completed text reply, in the Messages API's event order. */
function textReply(text: string): string {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_timeout_test', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5-5',
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

beforeAll(async () => {
  // Without an Anthropic key in the environment the resolver can reroute to OpenRouter; keep it on Anthropic.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-timeout-test';
  delete process.env.OPENROUTER_API_KEY;
  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    messagePosts += 1;
    req.resume();
    const current = mode;
    if (current.kind === 'silent') return; // accepts the request and never sends headers
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(textReply(current.text));
    }, current.delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (savedKeys.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKeys.anthropic;
  if (savedKeys.openrouter === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKeys.openrouter;
});

beforeEach(() => {
  messagePosts = 0;
  globalLLMProviderHealth.reset();
});

afterEach(() => {
  // A request the server left hanging must not outlive its test.
  server.closeAllConnections();
});

/** Every part of `stream`; a throw from the stream is kept as an error part. */
async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  try {
    for await (const part of stream) parts.push(part);
  } catch (error) {
    parts.push({ type: 'error', error: error as Error });
  }
  return parts;
}

/** Resolves to `'still waiting'` after `ms`, so a stream stuck on the old default fails an assertion instead of hanging. */
function stillWaitingAfter(ms: number): Promise<'still waiting'> {
  return new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms));
}

describe('Anthropic streaming honours the per-call requestTimeout', () => {
  it('streamText with requestTimeout 2000 ends with an error about 2 s after a server that never answers', async () => {
    mode = { kind: 'silent' };
    const startedAt = Date.now();

    const result = streamText({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      apiKey: 'sk-ant-timeout-test',
      baseUrl,
      prompt: 'Say hello.',
      requestTimeout: 2000,
      fallbackProviders: [],
    });
    const outcome = await Promise.race([collect(result.fullStream), stillWaitingAfter(8000)]);
    const elapsedMs = Date.now() - startedAt;

    expect(outcome).not.toBe('still waiting');
    const parts = outcome as StreamPart[];
    expect(parts.some((part) => part.type === 'text')).toBe(false);
    expect(parts[parts.length - 1]?.type).toBe('error');
    expect(elapsedMs).toBeGreaterThanOrEqual(1900);
    expect(elapsedMs).toBeLessThan(8000);
    expect(messagePosts).toBe(1);
  }, 20000);

  it('a per-call requestTimeout above the configured one lets a slow first byte through', async () => {
    mode = { kind: 'late', delayMs: 1200, text: 'Hello.' };
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'sk-ant-timeout-test', baseURL: baseUrl, requestTimeout: 300 });

    let text = '';
    let failure: unknown;
    try {
      for await (const chunk of provider.generateCompletionStream(
        'claude-sonnet-5-5',
        [{ role: 'user', content: 'Say hello.' }],
        { requestTimeout: 5000 },
      )) {
        text += chunk.responseTextDelta ?? '';
      }
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeUndefined();
    expect(text).toBe('Hello.');
    expect(messagePosts).toBe(1);
  }, 20000);
});
