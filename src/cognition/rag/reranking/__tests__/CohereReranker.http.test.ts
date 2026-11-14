/**
 * @fileoverview CohereReranker over the real fetch, against a local server that answers as Cohere's rerank API
 * and can send its headers and then stall its body. Each case reads when the call settles, what it settles with,
 * and whether the server saw its connection closed.
 */
import { EventEmitter, getEventListeners, once } from 'node:events';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { RerankerService } from '../RerankerService';
import { CohereReranker } from '../providers/CohereReranker';
import type { RerankerInput } from '../IRerankerService';

/**
 * What the server does with a rerank request, read from the first segment of its path:
 * - `answer`: the whole answer at once;
 * - `slow-answer`: the headers and the first bytes of the answer, the rest 150 ms later;
 * - `stall-body`: the headers and the first bytes of the answer, then nothing;
 * - `stall-error`: a 503 with the first bytes of its text, then nothing.
 */
type Mode = 'answer' | 'slow-answer' | 'stall-body' | 'stall-error';

/** One request the server received. */
interface Received {
  mode: string;
  /** Settles once the server has written what its mode sends first. */
  sent: Promise<void>;
  /** Settles once the request's connection is closed. */
  closed: Promise<void>;
}

const received: Received[] = [];
/** Emits `request` with each {@link Received} as it arrives. */
const arrivals = new EventEmitter();
/** Responses the server left open, ended after each case. */
const stalled = new Set<http.ServerResponse>();

let server: http.Server;
let origin: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const mode = (req.url ?? '').split('/')[1] ?? '';
    const socket = req.socket;
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    let markSent: () => void = () => undefined;
    const sent = new Promise<void>((resolve) => {
      markSent = resolve;
    });
    const request: Received = { mode, sent, closed };
    received.push(request);
    arrivals.emit('request', request);

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { documents: string[] };
      // The documents in the order given, each scored a little lower than the one before.
      const answer = JSON.stringify({
        id: 'rerank-1',
        results: body.documents.map((_, index) => ({ index, relevance_score: 1 - index / 10 })),
        meta: { api_version: { version: '1' } },
      });
      switch (mode as Mode) {
        case 'answer':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(answer, () => markSent());
          return;
        case 'slow-answer':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write(answer.slice(0, 12), () => markSent());
          setTimeout(() => res.end(answer.slice(12)), 150);
          return;
        case 'stall-body':
          stalled.add(res);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write(answer.slice(0, 12), () => markSent());
          return;
        case 'stall-error':
          stalled.add(res);
          res.writeHead(503, { 'content-type': 'text/plain' });
          res.write('Service', () => markSent());
          return;
        default:
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{"message":"no such route"}', () => markSent());
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const res of stalled) res.destroy();
  stalled.clear();
  received.length = 0;
  arrivals.removeAllListeners();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A provider whose requests reach the server under `mode`. */
function cohereAt(mode: Mode): CohereReranker {
  return new CohereReranker({ providerId: 'cohere', apiKey: 'test-key', baseUrl: `${origin}/${mode}` });
}

/** The next request the server receives. */
function nextRequest(): Promise<Received> {
  return once(arrivals, 'request').then(([request]) => request as Received);
}

/**
 * Wraps the real `fetch` so the returned promise settles once the client holds a response, its headers read.
 * An abort after it lands in the body read, however slow the runner.
 */
function headersReceived(): Promise<void> {
  const realFetch = globalThis.fetch;
  let markHeaders: () => void = () => undefined;
  const headersIn = new Promise<void>((resolve) => {
    markHeaders = resolve;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args: Parameters<typeof fetch>) => {
    const response = await realFetch(...args);
    markHeaders();
    return response;
  });
  return headersIn;
}

/** Settles as `promise` does, or rejects with "still pending after <ms> ms" once `ms` have passed. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const input: RerankerInput = {
  query: 'refund days',
  documents: [
    { id: 'refund', content: 'A refund takes five to ten business days.' },
    { id: 'ship', content: 'Orders ship within two days of payment.' },
  ],
};

describe('CohereReranker: the timeout covers the whole call', () => {
  it('rejects at timeoutMs when the body stalls after the headers, and closes the connection', async () => {
    const arrived = nextRequest();
    const started = Date.now();
    const call = cohereAt('stall-body').rerank(input, { providerId: 'cohere', modelId: 'rerank-v3.5', timeoutMs: 300 });

    await expect(within(call, 3000)).rejects.toThrow('CohereReranker: Request timed out after 300ms');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    const request = await arrived;
    expect(request.mode).toBe('stall-body');
    await within(request.closed, 2000);
  });

  it('rejects at timeoutMs when an error answer stalls its body, and closes the connection', async () => {
    const arrived = nextRequest();
    const call = cohereAt('stall-error').rerank(input, { providerId: 'cohere', modelId: 'rerank-v3.5', timeoutMs: 300 });

    await expect(within(call, 3000)).rejects.toThrow('CohereReranker: Request timed out after 300ms');
    await within((await arrived).closed, 2000);
  });

  it('resolves a body that ends inside the bound, as before', async () => {
    const output = await within(
      cohereAt('slow-answer').rerank(input, { providerId: 'cohere', modelId: 'rerank-v3.5', timeoutMs: 2000 }),
      3000,
    );
    expect(output.results.map((doc) => [doc.id, doc.relevanceScore])).toEqual([
      ['refund', 1],
      ['ship', 0.9],
    ]);
    expect(output.diagnostics?.providerMetrics?.cohereRequestId).toBe('rerank-1');
  });
});

describe("CohereReranker: the request's signal", () => {
  it("rejects with the signal's reason when it aborts during the body read, and closes the connection", async () => {
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    // Built apart from the call, as a host passes its own config through.
    const config = { providerId: 'cohere', modelId: 'rerank-v3.5', timeoutMs: 30_000, signal: controller.signal };
    const headersIn = headersReceived();
    const arrived = nextRequest();
    const call = cohereAt('stall-body').rerank(input, config);

    const request = await within(arrived, 3000);
    await within(headersIn, 3000); // the client holds the response, so the abort lands in the body read
    controller.abort(reason);

    await expect(within(call, 3000)).rejects.toBe(reason);
    await within(request.closed, 2000);
  });

  it('rejects with the reason of a signal aborted before the call, and sends nothing', async () => {
    const controller = new AbortController();
    const reason = new Error('stopped before the call');
    controller.abort(reason);
    const config = { providerId: 'cohere', modelId: 'rerank-v3.5', signal: controller.signal };

    await expect(within(cohereAt('answer').rerank(input, config), 3000)).rejects.toBe(reason);
    await delay(100);
    expect(received).toHaveLength(0);
  });

  it('rejects with the reason of a signal aborted while the request is built, and sends nothing', async () => {
    const controller = new AbortController();
    const reason = new Error('stopped while the request was built');
    // The passage's text is read as the request body is built, and reading it stops the call.
    const stopping: RerankerInput = {
      query: input.query,
      documents: [
        {
          id: 'refund',
          get content() {
            controller.abort(reason);
            return 'A refund takes five to ten business days.';
          },
        },
      ],
    };
    const config = { providerId: 'cohere', modelId: 'rerank-v3.5', signal: controller.signal };

    await expect(within(cohereAt('answer').rerank(stopping, config), 3000)).rejects.toBe(reason);
    await delay(100);
    expect(received).toHaveLength(0);
  });

  it('answers as before with no signal', async () => {
    const output = await within(cohereAt('answer').rerank(input, { providerId: 'cohere', modelId: 'rerank-v3.5' }), 3000);
    expect(output.results.map((doc) => doc.id)).toEqual(['refund', 'ship']);
  });

  it('answers as before with a signal that never aborts, and leaves no listener on it', async () => {
    const controller = new AbortController();
    const config = { providerId: 'cohere', modelId: 'rerank-v3.5', signal: controller.signal };

    const output = await within(cohereAt('answer').rerank(input, config), 3000);
    expect(output.results.map((doc) => doc.id)).toEqual(['refund', 'ship']);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it("reaches the provider through RerankerService.rerank, which rejects with the signal's reason", async () => {
    const service = new RerankerService({ config: { providers: [{ providerId: 'cohere' }] } });
    service.registerProvider(cohereAt('stall-body'));
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    const config = { providerId: 'cohere', signal: controller.signal };
    const headersIn = headersReceived();
    const arrived = nextRequest();
    const call = service.rerank(input, config);

    const request = await within(arrived, 3000);
    await within(headersIn, 3000);
    controller.abort(reason);

    await expect(within(call, 3000)).rejects.toBe(reason);
    await within(request.closed, 2000);
  });

  it("logs a stop by the caller's signal at debug through RerankerService.rerank, and a timeout at error", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const service = new RerankerService({ config: { providers: [{ providerId: 'cohere' }] }, logger });
    service.registerProvider(cohereAt('stall-body'));
    const controller = new AbortController();
    const reason = new Error('superseded');
    const headersIn = headersReceived();
    const arrived = nextRequest();
    const call = service.rerank(input, { providerId: 'cohere', signal: controller.signal });

    await within(arrived, 3000);
    await within(headersIn, 3000);
    logger.debug.mockClear();
    controller.abort(reason);

    await expect(within(call, 3000)).rejects.toBe(reason);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug.mock.calls[0]?.[0]).toBe("RerankerService: Reranking with provider 'cohere' stopped by the caller's signal");

    // A timeout that fires while a signal is armed is the provider's failure, and keeps its error line.
    const timedOut = service.rerank(input, { providerId: 'cohere', timeoutMs: 300, signal: new AbortController().signal });
    await expect(within(timedOut, 3000)).rejects.toThrow('CohereReranker: Request timed out after 300ms');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).toBe("RerankerService: Reranking failed with provider 'cohere'");
  });
});
