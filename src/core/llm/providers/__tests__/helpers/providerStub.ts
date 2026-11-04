/**
 * @file providerStub.ts
 * A local HTTP server that answers as a model provider's API does, for tests
 * that drive the real providers over fetch or axios. It records every request
 * with its headers and body. A route answers from the answers a case queued
 * for it, in order, then from its default; a request no route answers gets a
 * 404 and is listed in `unexpected`.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the server received. */
export interface StubRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  /** The body as sent. */
  body: string;
  /** The body parsed as a JSON object, or `{}` when it is not one. */
  json: Record<string, unknown>;
}

/** One answer. `json` is sent as `application/json`; `sse` as `text/event-stream`, one `data:` line per event. */
export interface StubAnswer {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  /** Events sent in order; a string goes out as it is (`[DONE]`), anything else as its JSON. */
  sse?: unknown[];
}

/** An answer, or a function of the request that returns one. */
export type StubRoute = StubAnswer | ((request: StubRequest) => StubAnswer);

/** The running server. A route's key is `METHOD /path`, the path without its query. */
export interface ProviderStub {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** Every request of the current case, in order. */
  readonly requests: StubRequest[];
  /** The `METHOD /path` of each request no route answered. */
  readonly unexpected: string[];
  /** Queues `answers` for `key`, in order; once they are spent the key's default answers. */
  queue(key: string, ...answers: StubRoute[]): void;
  /** The requests sent to `key`, in order. */
  sent(key: string): StubRequest[];
  /** Forgets the requests and the queued answers; the defaults stay. */
  reset(): void;
  close(): Promise<void>;
}

function parseJson(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Starts the server on a free loopback port.
 *
 * @param defaults The answer each key gives when nothing is queued for it.
 */
export async function startProviderStub(defaults: Record<string, StubRoute> = {}): Promise<ProviderStub> {
  const requests: StubRequest[] = [];
  const unexpected: string[] = [];
  const queued = new Map<string, StubRoute[]>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const body = Buffer.concat(chunks).toString('utf8');
      const request: StubRequest = { method: req.method ?? '', path, headers: req.headers, body, json: parseJson(body) };
      requests.push(request);
      const key = `${request.method} ${path}`;
      const route = queued.get(key)?.shift() ?? defaults[key];
      if (!route) {
        unexpected.push(key);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"no route for this request in this case"}}');
        return;
      }
      const answer = typeof route === 'function' ? route(request) : route;
      if (answer.sse) {
        res.writeHead(answer.status ?? 200, { 'content-type': 'text/event-stream', ...(answer.headers ?? {}) });
        res.end(answer.sse.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''));
        return;
      }
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
      res.end(JSON.stringify(answer.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    requests,
    unexpected,
    queue(key, ...answers) {
      queued.set(key, [...(queued.get(key) ?? []), ...answers]);
    },
    sent(key) {
      return requests.filter((request) => `${request.method} ${request.path}` === key);
    },
    reset() {
      requests.length = 0;
      unexpected.length = 0;
      queued.clear();
    },
    close() {
      // Keep-alive connections from fetch and axios would hold close() open.
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
