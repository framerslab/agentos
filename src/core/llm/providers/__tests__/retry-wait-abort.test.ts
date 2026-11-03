/**
 * @file retry-wait-abort.test.ts
 * The caller's abort signal ends a provider's wait between retries, not only
 * the request in flight. A 429's Retry-After (up to an hour) or the backoff
 * after a 5xx or a network failure is cut short the moment the signal aborts:
 * the call rejects with REQUEST_ABORTED then (a stream ends with its terminal
 * abort chunk instead), and no further request is sent. A stream whose body
 * has stalled ends at the abort as well, and a stream yields nothing after its
 * abort chunk.
 * The real Anthropic, Gemini and OpenRouter providers run over a stubbed
 * `fetch` (OpenRouter over an injected axios client) on fake timers; nothing
 * leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { AnthropicProvider } from '../implementations/AnthropicProvider';
import { GeminiProvider } from '../implementations/GeminiProvider';
import { OpenRouterProvider } from '../implementations/OpenRouterProvider';
import { waitForRetry } from '../implementations/retry-backoff';
import { ApiKeyPool } from '../../../providers/ApiKeyPool';
import type { ChatMessage, ModelCompletionResponse } from '../IProvider';

const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  } as unknown as Response;
}

// Error envelopes as the vendors document them: Anthropic's 429 rate_limit_error and 529 overloaded_error
// (https://platform.claude.com/docs/en/api/errors), Gemini's 429 RESOURCE_EXHAUSTED and 503 UNAVAILABLE
// (https://aistudio.google.com/docs/troubleshooting), OpenRouter's 429 (https://openrouter.ai/docs/api-reference/errors).
const anthropicRateLimited = { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } };
const anthropicOverloaded = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
const geminiExhausted = { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } };
const geminiUnavailable = { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } };

type Outcome = { state: 'pending' | 'resolved' | 'rejected'; error?: unknown };

/** Records how a call settles without awaiting it, so the fake clock can be advanced past each mark. */
function track(call: Promise<unknown>): Outcome {
  const outcome: Outcome = { state: 'pending' };
  call.then(
    () => {
      outcome.state = 'resolved';
    },
    (error: unknown) => {
      outcome.state = 'rejected';
      outcome.error = error;
    },
  );
  return outcome;
}

/** Reads a stream to its end and returns every chunk it yielded. */
async function drain(stream: AsyncGenerator<ModelCompletionResponse, void, undefined>): Promise<ModelCompletionResponse[]> {
  const chunks: ModelCompletionResponse[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/**
 * A 200 event stream that sends nothing, as a stalled connection does. Its body errors when the request's signal
 * aborts, as fetch's body does, so only a request that carries the caller's signal ends at the caller's abort.
 */
function stalledEventStream(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')), { once: true });
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body,
  } as unknown as Response;
}

/** A 200 event stream whose body holds `sse` in one read and then ends. */
function eventStream(sse: string): Response {
  const bytes = new TextEncoder().encode(sse);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  } as unknown as Response;
}

/** One Gemini stream event whose candidate holds a text part for each of `texts`. */
function geminiEvent(...texts: string[]): string {
  return `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: texts.map((text) => ({ text })) }, index: 0 }] })}\n\n`;
}

/** Drains a stream, aborting the controller once the first chunk has arrived, as a caller that stops reading does. */
async function drainAbortingAfterFirst(
  stream: AsyncGenerator<ModelCompletionResponse, void, undefined>,
  controller: AbortController,
): Promise<ModelCompletionResponse[]> {
  const chunks: ModelCompletionResponse[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
    if (chunks.length === 1) controller.abort();
  }
  return chunks;
}

/** A signal that aborts `afterMs` into the fake clock, as a caller's deadline does. */
function deadline(afterMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('deadline passed')), afterMs);
  return controller.signal;
}

async function anthropic(extra: Record<string, unknown> = {}): Promise<AnthropicProvider> {
  const p = new AnthropicProvider();
  await p.initialize({ apiKey: 'test-anthropic-key', maxRetries: 3, ...extra });
  return p;
}

async function gemini(): Promise<GeminiProvider> {
  const p = new GeminiProvider();
  await p.initialize({ apiKey: 'test-gemini-key', maxRetries: 3 });
  return p;
}

/** A bare OpenRouter provider with one key and an injected axios client (initialize() lists models over the network). */
function openRouter(request: ReturnType<typeof vi.fn>): OpenRouterProvider {
  const provider = new OpenRouterProvider();
  Object.assign(provider as unknown as Record<string, unknown>, {
    isInitialized: true,
    ensureInitialized: () => {},
    config: { apiKey: 'key_only_0001', baseURL: 'https://openrouter.ai/api/v1', requestTimeout: 1000, streamRequestTimeout: 1000 },
    keyPool: new ApiKeyPool('key_only_0001', { strategy: 'ordered' }),
    client: { request },
  });
  return provider;
}

function axiosError(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { isAxiosError: true, message: `Request failed with status code ${status}`, response: { status, data: body, headers } };
}

/**
 * Advances the clock to just before the abort, then to it: the call is still waiting with one request sent before,
 * and rejects with REQUEST_ABORTED at the abort itself, long before the wait would have ended. Running the clock on
 * past where the wait would have ended sends nothing more.
 */
async function expectAbortEndsTheWait(outcome: Outcome, sent: () => number, abortAtMs: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(abortAtMs - 1);
  expect(outcome.state).toBe('pending');
  expect(sent()).toBe(1);

  await vi.advanceTimersByTimeAsync(1);
  expect(outcome.state).toBe('rejected');
  expect(outcome.error).toMatchObject({ code: 'REQUEST_ABORTED' });

  await vi.advanceTimersByTimeAsync(120_000);
  expect(sent()).toBe(1);
}

describe("a provider's wait between retries ends when the caller's signal aborts", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('AnthropicProvider', () => {
    it("ends a 429's Retry-After wait at the abort on the streamed transport (the default)", async () => {
      const p = await anthropic();
      fetchMock.mockResolvedValue(jsonResponse(429, anthropicRateLimited, { 'retry-after': '20' }));
      vi.useFakeTimers();
      const outcome = track(p.generateCompletion('claude-sonnet-4-20250514', messages, { abortSignal: deadline(10_000) }));
      await expectAbortEndsTheWait(outcome, () => fetchMock.mock.calls.length, 10_000);
    });

    it("ends a 429's Retry-After wait at the abort on the single-shot transport", async () => {
      const p = await anthropic({ streamCompletions: false });
      fetchMock.mockResolvedValue(jsonResponse(429, anthropicRateLimited, { 'retry-after': '20' }));
      vi.useFakeTimers();
      const outcome = track(p.generateCompletion('claude-sonnet-4-20250514', messages, { abortSignal: deadline(10_000) }));
      await expectAbortEndsTheWait(outcome, () => fetchMock.mock.calls.length, 10_000);
    });

    it('ends the backoff after a 529 at the abort on the single-shot transport', async () => {
      const p = await anthropic({ streamCompletions: false });
      fetchMock.mockResolvedValue(jsonResponse(529, anthropicOverloaded));
      vi.spyOn(Math, 'random').mockReturnValue(1); // the first backoff is its full 1 s window
      vi.useFakeTimers();
      const outcome = track(p.generateCompletion('claude-sonnet-4-20250514', messages, { abortSignal: deadline(500) }));
      await expectAbortEndsTheWait(outcome, () => fetchMock.mock.calls.length, 500);
    });

    it('ends the backoff after a network failure at the abort on the single-shot transport', async () => {
      const p = await anthropic({ streamCompletions: false });
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      vi.spyOn(Math, 'random').mockReturnValue(1);
      vi.useFakeTimers();
      const outcome = track(p.generateCompletion('claude-sonnet-4-20250514', messages, { abortSignal: deadline(500) }));
      await expectAbortEndsTheWait(outcome, () => fetchMock.mock.calls.length, 500);
    });

    it('ends the backoff after a 529 at the abort on the streamed transport', async () => {
      const p = await anthropic();
      fetchMock.mockResolvedValue(jsonResponse(529, anthropicOverloaded));
      vi.spyOn(Math, 'random').mockReturnValue(1);
      vi.useFakeTimers();
      const outcome = track(p.generateCompletion('claude-sonnet-4-20250514', messages, { abortSignal: deadline(500) }));
      await expectAbortEndsTheWait(outcome, () => fetchMock.mock.calls.length, 500);
    });

    it('waits no Retry-After after its last attempt', async () => {
      const p = await anthropic({ streamCompletions: false });
      fetchMock.mockResolvedValue(jsonResponse(429, anthropicRateLimited, { 'retry-after': '20' }));
      vi.useFakeTimers();
      const outcome = track(p.generateCompletion('claude-sonnet-4-20250514', messages, { maxAttempts: 1 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toMatchObject({ state: 'rejected', error: { code: 'RATE_LIMIT_EXCEEDED' } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('GeminiProvider', () => {
    it("ends a 429's Retry-After wait at the abort", async () => {
      const p = await gemini();
      fetchMock.mockResolvedValue(jsonResponse(429, geminiExhausted, { 'retry-after': '20' }));
      vi.useFakeTimers();
      const outcome = track(p.generateCompletion('gemini-2.5-flash', messages, { abortSignal: deadline(10_000) }));
      await expectAbortEndsTheWait(outcome, () => fetchMock.mock.calls.length, 10_000);
    });

    it('ends the backoff after a 503 at the abort', async () => {
      const p = await gemini();
      fetchMock.mockResolvedValue(jsonResponse(503, geminiUnavailable));
      vi.spyOn(Math, 'random').mockReturnValue(1);
      vi.useFakeTimers();
      const outcome = track(p.generateCompletion('gemini-2.5-flash', messages, { abortSignal: deadline(500) }));
      await expectAbortEndsTheWait(outcome, () => fetchMock.mock.calls.length, 500);
    });

    it('ends the backoff after a network failure at the abort', async () => {
      const p = await gemini();
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      vi.spyOn(Math, 'random').mockReturnValue(1);
      vi.useFakeTimers();
      const outcome = track(p.generateCompletion('gemini-2.5-flash', messages, { abortSignal: deadline(500) }));
      await expectAbortEndsTheWait(outcome, () => fetchMock.mock.calls.length, 500);
    });

    it('ends a stream whose body has stalled at the abort with the terminal abort chunk', async () => {
      const p = await gemini();
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => stalledEventStream(init?.signal));
      vi.useFakeTimers();
      let chunks: ModelCompletionResponse[] = [];
      const outcome = track(
        drain(p.generateCompletionStream('gemini-2.5-flash', messages, { abortSignal: deadline(500) })).then((all) => {
          chunks = all;
        }),
      );

      await vi.advanceTimersByTimeAsync(499);
      expect(outcome.state).toBe('pending');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(outcome.state).toBe('resolved');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ isFinal: true, error: { type: 'abort' } });
    });

    it('yields nothing after the abort chunk when the abort comes between two events of one read', async () => {
      const p = await gemini();
      fetchMock.mockResolvedValue(eventStream(geminiEvent('Hel') + geminiEvent('lo')));
      const controller = new AbortController();
      const chunks = await drainAbortingAfterFirst(
        p.generateCompletionStream('gemini-2.5-flash', messages, { abortSignal: controller.signal }),
        controller,
      );

      expect(chunks[0]).toMatchObject({ responseTextDelta: 'Hel' });
      expect(chunks[chunks.length - 1]).toMatchObject({ isFinal: true, error: { type: 'abort' } });
      expect(chunks.filter((chunk) => chunk.isFinal)).toHaveLength(1);
    });

    it('yields no later part of the same event after an abort', async () => {
      const p = await gemini();
      fetchMock.mockResolvedValue(eventStream(geminiEvent('Hel', 'lo')));
      const controller = new AbortController();
      const chunks = await drainAbortingAfterFirst(
        p.generateCompletionStream('gemini-2.5-flash', messages, { abortSignal: controller.signal }),
        controller,
      );

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toMatchObject({ responseTextDelta: 'Hel' });
      expect(chunks[1]).toMatchObject({ isFinal: true, error: { type: 'abort' } });
    });

    it('ends with the abort chunk, not the success chunk, when the abort comes after the last event', async () => {
      const p = await gemini();
      fetchMock.mockResolvedValue(eventStream(geminiEvent('Hello')));
      const controller = new AbortController();
      const chunks = await drainAbortingAfterFirst(
        p.generateCompletionStream('gemini-2.5-flash', messages, { abortSignal: controller.signal }),
        controller,
      );

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toMatchObject({ responseTextDelta: 'Hello' });
      expect(chunks[1]).toMatchObject({ isFinal: true, error: { type: 'abort' } });
    });

    it('waits no Retry-After after its last attempt', async () => {
      const p = await gemini();
      fetchMock.mockResolvedValue(jsonResponse(429, geminiExhausted, { 'retry-after': '20' }));
      vi.useFakeTimers();
      const outcome = track(p.generateCompletion('gemini-2.5-flash', messages, { maxAttempts: 1 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toMatchObject({ state: 'rejected', error: { code: 'RATE_LIMIT_EXCEEDED' } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('OpenRouterProvider', () => {
    it("ends a 429's Retry-After wait at the abort", async () => {
      const request = vi.fn().mockRejectedValue(axiosError(429, { error: { message: 'Rate limit exceeded', code: 429 } }, { 'retry-after': '12' }));
      const p = openRouter(request);
      vi.useFakeTimers();
      const outcome = track(p.generateCompletion('anthropic/claude-sonnet-5.5', messages, { abortSignal: deadline(5_000) }));
      await expectAbortEndsTheWait(outcome, () => request.mock.calls.length, 5_000);
    });

    it("ends a stream's Retry-After wait at the abort with the terminal abort chunk, not a throw", async () => {
      const request = vi.fn().mockRejectedValue(axiosError(429, { error: { message: 'Rate limit exceeded', code: 429 } }, { 'retry-after': '12' }));
      const p = openRouter(request);
      vi.useFakeTimers();
      let chunks: ModelCompletionResponse[] = [];
      const outcome = track(
        drain(p.generateCompletionStream('anthropic/claude-sonnet-5.5', messages, { abortSignal: deadline(5_000) })).then((all) => {
          chunks = all;
        }),
      );

      await vi.advanceTimersByTimeAsync(4_999);
      expect(outcome.state).toBe('pending');
      expect(request).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(outcome.state).toBe('resolved');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ isFinal: true, error: { type: 'abort' } });

      await vi.advanceTimersByTimeAsync(120_000);
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  describe('waitForRetry', () => {
    it('ends at the abort and clears its timer', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const outcome = track(waitForRetry(20_000, controller.signal));
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome.state).toBe('resolved');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('waits nothing for a signal that has already aborted', async () => {
      vi.useFakeTimers();
      const outcome = track(waitForRetry(20_000, AbortSignal.abort()));
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome.state).toBe('resolved');
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
