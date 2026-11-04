/**
 * @file request-in-flight-abort.test.ts
 * The caller's abort signal ends a request the provider has already sent. A
 * completion or an embedding whose upstream never answers rejects with
 * REQUEST_ABORTED at the abort, not at the request timeout, and nothing is
 * sent after it; a stream waiting for the response headers, or one whose body
 * has stalled after its first event, ends at the abort with the terminal abort
 * chunk.
 *
 * The real OpenRouter, Requesty, Ollama and OpenAI providers are initialized
 * against a local HTTP server, over their real HTTP clients (axios for
 * OpenRouter, Requesty and Ollama, fetch for OpenAI). The server answers every
 * GET (the model listings the providers read at start) and holds every POST
 * open without answering, so only a request that carries the caller's signal
 * ends at the abort. Nothing leaves the machine.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenRouterProvider } from '../implementations/OpenRouterProvider';
import { RequestyProvider } from '../implementations/RequestyProvider';
import { OllamaProvider } from '../implementations/OllamaProvider';
import { OpenAIProvider } from '../implementations/OpenAIProvider';
import type { ChatMessage, ModelCompletionResponse } from '../IProvider';

const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];

/** Far longer than any wait below: a request that ends does so at the abort, never at its timeout. */
const LONG_TIMEOUT_MS = 60_000;
/** How long a call may take to settle after the abort. */
const SETTLE_MS = 2_000;
/** How long to keep watching for a request sent after the abort (OpenRouter's first backoff is 300 to 500 ms). */
const QUIET_MS = 1_000;

/**
 * The first event of a streamed answer, as each vendor sends it: OpenRouter's server-sent `data:` line in the
 * OpenAI chunk shape (https://openrouter.ai/docs/api-reference/streaming) and one of the JSON objects Ollama's
 * `/api/chat` streams (https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion), one to a
 * line as the provider reads them.
 */
const OPENROUTER_FIRST_EVENT =
  `data: ${JSON.stringify({
    id: 'gen-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'anthropic/claude-sonnet-5.5',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }],
  })}\n\n`;
const OLLAMA_FIRST_EVENT =
  `${JSON.stringify({ model: 'llama3', created_at: '2026-11-03T00:00:00Z', message: { role: 'assistant', content: 'Hel' }, done: false })}\n`;

/** A local upstream: every GET answers 200, every POST is held open (or sends its first event and then stalls). */
interface Upstream {
  url: string;
  /** Paths of the POSTs received, in order. */
  posts: string[];
  /** Set to the first event a POST answers with before it stalls; null holds the POST before its headers. */
  firstEvent: { contentType: string; body: string } | null;
  /** Resolves once `count` POSTs have arrived. */
  untilPosts(count: number): Promise<void>;
  close(): Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const posts: string[] = [];
  let waiters: Array<{ count: number; resolve: () => void }> = [];
  const upstream = { posts, firstEvent: null } as unknown as Upstream;
  const server: Server = createServer((req, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [], models: [] }));
      return;
    }
    req.resume();
    posts.push(req.url ?? '');
    const ready = waiters.filter((w) => posts.length >= w.count);
    waiters = waiters.filter((w) => posts.length < w.count);
    ready.forEach((w) => w.resolve());
    if (upstream.firstEvent) {
      res.writeHead(200, { 'content-type': upstream.firstEvent.contentType });
      res.write(upstream.firstEvent.body);
    }
    // The POST is never answered (or never finished): only the caller's abort can end it.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  upstream.url = `http://127.0.0.1:${port}`;
  upstream.untilPosts = (count: number) =>
    posts.length >= count ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ count, resolve }));
  upstream.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return upstream;
}

type Outcome = { state: 'pending' | 'resolved' | 'rejected'; value?: unknown; error?: unknown };

/** Records how a call settles without awaiting it. */
function track(call: Promise<unknown>): Outcome {
  const outcome: Outcome = { state: 'pending' };
  call.then(
    (value: unknown) => {
      outcome.state = 'resolved';
      outcome.value = value;
    },
    (error: unknown) => {
      outcome.state = 'rejected';
      outcome.error = error;
    },
  );
  return outcome;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until the call settles or `ms` pass, whichever comes first. */
async function settledWithin(outcome: Outcome, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (outcome.state === 'pending' && Date.now() < until) await sleep(10);
}

/** Reads a stream to its end, aborting the controller once the first chunk has arrived when asked to. */
async function drain(
  stream: AsyncGenerator<ModelCompletionResponse, void, undefined>,
  abortAfterFirst?: AbortController,
): Promise<ModelCompletionResponse[]> {
  const chunks: ModelCompletionResponse[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
    if (abortAfterFirst && chunks.length === 1) abortAfterFirst.abort();
  }
  return chunks;
}

/**
 * Sends the call, aborts once the upstream holds its request, and expects a rejection with REQUEST_ABORTED within
 * SETTLE_MS of the abort, with no request sent after it.
 */
async function expectAbortEndsTheRequest(upstream: Upstream, send: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const controller = new AbortController();
  const outcome = track(send(controller.signal));
  await upstream.untilPosts(1);
  expect(outcome.state).toBe('pending');

  controller.abort();
  await settledWithin(outcome, SETTLE_MS);
  expect(outcome.state).toBe('rejected');
  expect(outcome.error).toMatchObject({ code: 'REQUEST_ABORTED' });

  await sleep(QUIET_MS);
  expect(upstream.posts).toHaveLength(1);
}

/** Opens the stream, aborts while the upstream holds the request before its headers, and expects the abort chunk. */
async function expectAbortEndsTheStreamBeforeHeaders(
  upstream: Upstream,
  open: (signal: AbortSignal) => AsyncGenerator<ModelCompletionResponse, void, undefined>,
): Promise<void> {
  const controller = new AbortController();
  const outcome = track(drain(open(controller.signal)));
  await upstream.untilPosts(1);
  expect(outcome.state).toBe('pending');

  controller.abort();
  await settledWithin(outcome, SETTLE_MS);
  expect(outcome.state).toBe('resolved');
  const chunks = outcome.value as ModelCompletionResponse[];
  expect(chunks[chunks.length - 1]).toMatchObject({ isFinal: true, error: { type: 'abort' } });
  expect(chunks.filter((chunk) => chunk.isFinal)).toHaveLength(1);

  await sleep(QUIET_MS);
  expect(upstream.posts).toHaveLength(1);
}

/** Opens the stream, aborts once its first event has arrived and its body has stalled, and expects the abort chunk. */
async function expectAbortEndsAStalledBody(
  upstream: Upstream,
  open: (signal: AbortSignal) => AsyncGenerator<ModelCompletionResponse, void, undefined>,
): Promise<void> {
  const controller = new AbortController();
  const outcome = track(drain(open(controller.signal), controller));
  await upstream.untilPosts(1);

  await settledWithin(outcome, SETTLE_MS);
  expect(controller.signal.aborted).toBe(true);
  expect(outcome.state).toBe('resolved');
  const chunks = outcome.value as ModelCompletionResponse[];
  expect(chunks[0]).toMatchObject({ responseTextDelta: 'Hel' });
  expect(chunks).toHaveLength(2);
  expect(chunks[1]).toMatchObject({ isFinal: true, error: { type: 'abort' } });
}

describe("a request already sent ends when the caller's signal aborts", () => {
  let upstream: Upstream;

  beforeEach(async () => {
    upstream = await startUpstream();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await upstream.close();
    vi.restoreAllMocks();
  });

  describe('OpenRouterProvider', () => {
    async function openRouter(): Promise<OpenRouterProvider> {
      const provider = new OpenRouterProvider();
      await provider.initialize({
        apiKey: 'test-openrouter-key',
        baseURL: `${upstream.url}/api/v1`,
        requestTimeout: LONG_TIMEOUT_MS,
        streamRequestTimeout: LONG_TIMEOUT_MS,
      });
      return provider;
    }

    it('rejects a completion with REQUEST_ABORTED at the abort and sends nothing after it', async () => {
      const p = await openRouter();
      await expectAbortEndsTheRequest(upstream, (signal) =>
        p.generateCompletion('anthropic/claude-sonnet-5.5', messages, { abortSignal: signal }),
      );
      expect(upstream.posts).toEqual(['/api/v1/chat/completions']);
    });

    it('ends a stream waiting for its response headers with the terminal abort chunk', async () => {
      const p = await openRouter();
      await expectAbortEndsTheStreamBeforeHeaders(upstream, (signal) =>
        p.generateCompletionStream('anthropic/claude-sonnet-5.5', messages, { abortSignal: signal }),
      );
    });

    it('ends a stream whose body has stalled after its first event with the terminal abort chunk', async () => {
      upstream.firstEvent = { contentType: 'text/event-stream', body: OPENROUTER_FIRST_EVENT };
      const p = await openRouter();
      await expectAbortEndsAStalledBody(upstream, (signal) =>
        p.generateCompletionStream('anthropic/claude-sonnet-5.5', messages, { abortSignal: signal }),
      );
    });

    it('rejects an embedding request with REQUEST_ABORTED at the abort', async () => {
      const p = await openRouter();
      await expectAbortEndsTheRequest(upstream, (signal) =>
        p.generateEmbeddings('openai/text-embedding-3-small', ['hello'], { abortSignal: signal }),
      );
      expect(upstream.posts).toEqual(['/api/v1/embeddings']);
    });
  });

  describe('RequestyProvider', () => {
    async function requesty(): Promise<RequestyProvider> {
      const provider = new RequestyProvider();
      await provider.initialize({
        apiKey: 'test-requesty-key',
        baseURL: `${upstream.url}/v1`,
        requestTimeout: LONG_TIMEOUT_MS,
        streamRequestTimeout: LONG_TIMEOUT_MS,
      });
      return provider;
    }

    it('rejects a completion with REQUEST_ABORTED at the abort', async () => {
      const p = await requesty();
      await expectAbortEndsTheRequest(upstream, (signal) =>
        p.generateCompletion('openai/gpt-4o-mini', messages, { abortSignal: signal }),
      );
    });

    it('rejects an embedding request with REQUEST_ABORTED at the abort', async () => {
      const p = await requesty();
      await expectAbortEndsTheRequest(upstream, (signal) =>
        p.generateEmbeddings('openai/text-embedding-3-small', ['hello'], { abortSignal: signal }),
      );
    });
  });

  describe('OllamaProvider', () => {
    async function ollama(): Promise<OllamaProvider> {
      const provider = new OllamaProvider();
      await provider.initialize({ baseURL: upstream.url, requestTimeout: LONG_TIMEOUT_MS });
      return provider;
    }

    it('rejects a completion with REQUEST_ABORTED at the abort', async () => {
      const p = await ollama();
      await expectAbortEndsTheRequest(upstream, (signal) => p.generateCompletion('llama3', messages, { abortSignal: signal }));
      expect(upstream.posts).toEqual(['/api/chat']);
    });

    it('ends a stream waiting for its response headers with the terminal abort chunk', async () => {
      const p = await ollama();
      await expectAbortEndsTheStreamBeforeHeaders(upstream, (signal) =>
        p.generateCompletionStream('llama3', messages, { abortSignal: signal }),
      );
    });

    it('ends a stream whose body has stalled after its first event with the terminal abort chunk', async () => {
      upstream.firstEvent = { contentType: 'application/x-ndjson', body: OLLAMA_FIRST_EVENT };
      const p = await ollama();
      await expectAbortEndsAStalledBody(upstream, (signal) => p.generateCompletionStream('llama3', messages, { abortSignal: signal }));
    });

    it('sends nothing for a call whose signal has already aborted', async () => {
      const p = await ollama();
      const controller = new AbortController();
      controller.abort();
      const completion = track(p.generateCompletion('llama3', messages, { abortSignal: controller.signal }));
      const stream = track(drain(p.generateCompletionStream('llama3', messages, { abortSignal: controller.signal })));
      await settledWithin(completion, SETTLE_MS);
      await settledWithin(stream, SETTLE_MS);

      expect(completion.state).toBe('rejected');
      expect(completion.error).toMatchObject({ code: 'REQUEST_ABORTED' });
      expect(stream.state).toBe('resolved');
      const chunks = stream.value as ModelCompletionResponse[];
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ isFinal: true, error: { type: 'abort' } });
      await sleep(QUIET_MS);
      expect(upstream.posts).toHaveLength(0);
    });

    it('rejects an embedding request with REQUEST_ABORTED at the abort', async () => {
      const p = await ollama();
      await expectAbortEndsTheRequest(upstream, (signal) =>
        p.generateEmbeddings('nomic-embed-text', ['hello', 'world'], { abortSignal: signal }),
      );
      expect(upstream.posts).toEqual(['/api/embeddings']);
    });
  });

  describe('OpenAIProvider', () => {
    it('rejects an embedding request with REQUEST_ABORTED at the abort', async () => {
      const p = new OpenAIProvider();
      await p.initialize({ apiKey: 'test-openai-key', baseURL: `${upstream.url}/v1`, requestTimeout: LONG_TIMEOUT_MS });
      await expectAbortEndsTheRequest(upstream, (signal) =>
        p.generateEmbeddings('text-embedding-3-small', ['hello'], { abortSignal: signal }),
      );
      expect(upstream.posts).toEqual(['/v1/embeddings']);
    });
  });
});
