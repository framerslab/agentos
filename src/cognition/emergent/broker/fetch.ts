/**
 * @fileoverview The broker's `fetch` for code-forged tools under a ceiling.
 * `prepareFetch` checks a request before anything is sent (the URL, its
 * scheme, the method and the first host) and rebuilds the caller's options
 * from the two it accepts; `sendFetch` sends it with `redirect: 'manual'`,
 * follows each redirect itself after checking the next host, and reads the
 * body as a stream that is refused past its limit.
 * @module @framers/agentos/emergent/broker/fetch
 */

import type { HttpMethod } from '../types.js';
import { CapabilityRefusal } from './refusal.js';

/** The scope a ceiling grants `fetch` under, with its defaults applied. */
export interface FetchScope {
  domains: string[] | '*';
  methods: HttpMethod[];
  maxResponseBytes: number;
  maxRedirects: number;
  timeoutMs: number;
  /** Set when `methods` holds a state-changing method. */
  maxRequestBytes?: number;
}

/** A request that passed every check made before anything is sent. */
export interface PreparedFetch {
  url: URL;
  method: HttpMethod;
  headers: Headers;
  /** A state-changing request's body; GET and HEAD carry none. */
  body?: string | Uint8Array;
  /** The body's size in bytes. */
  bodyBytes?: number;
}

/** The methods that change state: sent with a bounded body, never redirected, recorded with their method. */
export const STATE_CHANGING: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A state-changing request cut (by the call's end or its time bound) after
 * `fetch()` was called. Node's fetch does not say how far the request got,
 * so the broker cannot tell whether the server acted on it: the record keeps
 * no outcome (the store's unknown) and the code `cut_in_flight`.
 */
export class InFlightCut extends CapabilityRefusal {
  constructor(
    readonly how: 'aborted' | 'timed_out',
    host: string,
  ) {
    super('cut_in_flight', `${host}: the request was sent, and whether the server acted on it is unknown`);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
/** Dropped when a redirect changes the origin, as fetch itself does. */
const CROSS_ORIGIN_DROPPED = ['authorization', 'proxy-authorization', 'cookie', 'host'];

/**
 * The URL a forged tool's first argument names: a string, a URL, or an object
 * with a `url` string. A property is read once, so the value checked is the
 * value returned (a getter in forged code can answer each read differently).
 */
export function fetchTarget(input: unknown): string | undefined {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (input && typeof input === 'object') {
    const url: unknown = (input as { url?: unknown }).url;
    return typeof url === 'string' ? url : undefined;
  }
  return undefined;
}

function checkScheme(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CapabilityRefusal('scheme_not_allowed', `${url.protocol} (http and https only)`);
  }
}

function checkHost(url: URL, scope: FetchScope): void {
  const host = url.hostname.toLowerCase();
  if (scope.domains !== '*' && !scope.domains.includes(host)) {
    throw new CapabilityRefusal('host_not_allowed', host);
  }
}

function headersFrom(given: unknown): Headers {
  const headers = new Headers();
  try {
    if (given instanceof Headers) {
      given.forEach((value, name) => headers.set(name, value));
    } else if (Array.isArray(given)) {
      for (const pair of given) {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
          headers.append(pair[0], pair[1]);
        }
      }
    } else if (given && typeof given === 'object') {
      for (const [name, value] of Object.entries(given as Record<string, unknown>)) {
        if (typeof value === 'string') {
          headers.set(name, value);
        }
      }
    }
  } catch (error: unknown) {
    throw new CapabilityRefusal('invalid_headers', error instanceof Error ? error.message : String(error));
  }
  return headers;
}

/** A state-changing request's body: a string or bytes within the scope's bound, read once. */
function requestBody(given: unknown, limit: number): { body?: string | Uint8Array; bodyBytes?: number } {
  if (given === undefined || given === null) {
    return {};
  }
  let body: string | Uint8Array;
  if (typeof given === 'string') {
    body = given;
  } else if (given instanceof Uint8Array) {
    body = given;
  } else if (given instanceof ArrayBuffer) {
    body = new Uint8Array(given);
  } else {
    throw new CapabilityRefusal('unsupported_body', 'a request body is a string or bytes');
  }
  const bodyBytes = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
  if (bodyBytes > limit) {
    throw new CapabilityRefusal('request_too_large', `${bodyBytes} bytes, more than ${limit}`);
  }
  return { body, bodyBytes };
}

/**
 * The checks made before anything is sent. The caller's options are read for
 * `method`, `headers` and, for a state-changing method, `body` only: a
 * redirect mode, credentials or a signal of the caller's are never passed
 * on, and a body on GET or HEAD is dropped, as stage 1 dropped it.
 */
export function prepareFetch(input: unknown, init: unknown, scope: FetchScope): PreparedFetch {
  const raw = fetchTarget(input);
  if (raw === undefined) {
    throw new CapabilityRefusal('invalid_url', 'fetch takes a URL');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CapabilityRefusal('invalid_url', `"${raw}" is not an absolute URL`);
  }
  checkScheme(url);
  const options =
    init && typeof init === 'object' ? (init as { method?: unknown; headers?: unknown; body?: unknown }) : {};
  const method = (typeof options.method === 'string' ? options.method : 'GET').toUpperCase();
  if (!(scope.methods as string[]).includes(method)) {
    throw new CapabilityRefusal('method_not_allowed', method);
  }
  checkHost(url, scope);
  const headers = headersFrom(options.headers);
  if (!STATE_CHANGING.has(method as HttpMethod)) {
    return { url, method: method as HttpMethod, headers };
  }
  return { url, method: method as HttpMethod, headers, ...requestBody(options.body, scope.maxRequestBytes ?? 0) };
}

async function cappedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new CapabilityRefusal('response_too_large', `more than ${limit} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Sends a prepared request. `signal` is the call's; the scope's `timeoutMs`
 * bounds the whole request, redirects and body included. For GET and HEAD
 * every redirect is followed here, its host checked like the first, and the
 * method kept through every redirect status. A state-changing request is
 * never redirected: its redirect answer is returned as it came, and a cut
 * after it was sent is an {@link InFlightCut}.
 */
export async function sendFetch(
  prepared: PreparedFetch,
  scope: FetchScope,
  signal: AbortSignal,
): Promise<{ response: Response; bytes: number }> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(scope.timeoutMs)]);
  const changesState = STATE_CHANGING.has(prepared.method);
  const ended = (host: string): CapabilityRefusal =>
    changesState
      ? new InFlightCut(signal.aborted ? 'aborted' : 'timed_out', host)
      : new CapabilityRefusal(signal.aborted ? 'aborted' : 'timed_out', host);
  // A typed array is not a BodyInit under TypeScript 5.7 and later; its own copy is.
  const sentBody =
    prepared.body === undefined
      ? undefined
      : typeof prepared.body === 'string'
        ? prepared.body
        : (prepared.body.slice().buffer as ArrayBuffer);
  const headers = new Headers(prepared.headers);
  let url = prepared.url;
  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: prepared.method,
        headers,
        redirect: 'manual',
        signal: bounded,
        ...(sentBody !== undefined ? { body: sentBody } : {}),
      });
    } catch (error: unknown) {
      if (bounded.aborted) {
        throw ended(url.hostname);
      }
      throw error;
    }
    const location = response.headers.get('location');
    if (!changesState && REDIRECT_STATUSES.has(response.status) && location !== null) {
      await response.body?.cancel().catch(() => undefined);
      if (redirects >= scope.maxRedirects) {
        throw new CapabilityRefusal('too_many_redirects', `more than ${scope.maxRedirects}`);
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new CapabilityRefusal('invalid_url', `a redirect to "${location}"`);
      }
      checkScheme(next);
      checkHost(next, scope);
      if (next.origin !== url.origin) {
        for (const name of CROSS_ORIGIN_DROPPED) {
          headers.delete(name);
        }
      }
      url = next;
      continue;
    }
    let body: Uint8Array | null = null;
    if (prepared.method === 'HEAD' || NULL_BODY_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
    } else {
      try {
        body = await cappedBody(response, scope.maxResponseBytes);
      } catch (error: unknown) {
        if (error instanceof CapabilityRefusal) {
          throw error;
        }
        if (bounded.aborted) {
          throw ended(url.hostname);
        }
        throw error;
      }
    }
    return {
      // The body's own ArrayBuffer (it was allocated whole above): a typed
      // array is not a BodyInit under TypeScript 5.7 and later.
      response: new Response(body === null ? null : (body.buffer as ArrayBuffer), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      bytes: body?.byteLength ?? 0,
    };
  }
}

/** The broker's fetch without its records: the checks, then the request. */
export async function brokeredFetch(
  input: unknown,
  init: unknown,
  scope: FetchScope,
  signal: AbortSignal,
): Promise<Response> {
  return (await sendFetch(prepareFetch(input, init, scope), scope, signal)).response;
}
