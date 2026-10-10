/**
 * @file untrustedImageFetch.ts
 * Fetches an image from a URL an untrusted source gave, such as a model's
 * tool call, reaching public network addresses only. Each connection's
 * address is checked when the connection is made, every redirect is followed
 * here and checked the same way, and the size and the time are capped.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { pipeline, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { isPublicNetworkAddress } from './networkAddress.js';

/** The most bytes an untrusted image fetch reads unless its caller sets a limit: 50 MiB. */
export const UNTRUSTED_IMAGE_MAX_BYTES = 50 * 1024 * 1024;

/** How long an untrusted image fetch may take, redirects and body included, unless its caller sets a limit: 30 seconds. */
export const UNTRUSTED_IMAGE_TIMEOUT_MS = 30_000;

/** The most redirects an untrusted image fetch follows. */
const MAX_REDIRECTS = 5;

/** The longest timer Node keeps: a longer one fires after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Options for {@link fetchUntrustedImage}. */
export interface UntrustedImageFetchOptions {
  /** The most bytes the response may have (default {@link UNTRUSTED_IMAGE_MAX_BYTES}). */
  maxBytes?: number;
  /** How long the fetch may take in milliseconds, redirects and body included (default {@link UNTRUSTED_IMAGE_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Resolves host names (default `dns.lookup`). Tests replace it. */
  lookup?: LookupFunction;
  /** Whether a connection may go to an address (default {@link isPublicNetworkAddress}). Tests replace it. */
  allowAddress?: (address: string) => boolean;
}

/** The URL as an error message shows it: without credentials or a query, either of which can carry a secret. */
function shown(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/** An error for an address or a URL the fetch refuses to reach. */
function refusal(message: string): Error {
  return Object.assign(new Error(message), { code: 'IMAGE_URL_REFUSED' });
}

/** `value` when it is a positive number no larger than `most`; a RangeError otherwise. */
function limit(value: number, name: string, most: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > most) {
    throw new RangeError(`imageToBuffer: ${name} must be a positive number no larger than ${most}, not ${String(value)}.`);
  }
  return value;
}

/** `text`, resolved against `base` when given, as an http(s) URL. */
function httpUrl(text: string, what: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    throw new Error(`imageToBuffer: ${what} is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw refusal(`imageToBuffer: ${what} is a ${url.protocol} URL; untrusted input is fetched over http and https only.`);
  }
  return url;
}

/**
 * The error for a host name that resolves to no address the fetch may reach.
 * A name that resolves only to a refused address and a name that does not
 * resolve at all get the same message: it reaches whoever sent the URL, and a
 * model told to try internal names could otherwise map the network one
 * refusal at a time, learning which names exist and what they resolve to.
 * The address or the resolver's error stays on the error, out of its message
 * and its own keys, for logs.
 */
function unreachableName(hostname: string, detail: { resolvedAddress?: string; cause?: unknown }): Error {
  const error = refusal(`imageToBuffer: ${hostname} does not resolve to a public network address.`);
  for (const [key, value] of Object.entries(detail)) {
    Object.defineProperty(error, key, { value, enumerable: false });
  }
  return error;
}

/**
 * A `lookup` for the request that resolves every address of the host name and
 * fails unless each one is allowed. The connection then goes to an address
 * this check passed, so a name that resolves to a private address when the
 * connection is made is refused, whatever an earlier lookup returned.
 */
function checkedLookup(resolve: LookupFunction, allowed: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, result, family) => {
      if (error) {
        callback(unreachableName(hostname, { cause: error }), []);
        return;
      }
      const addresses: LookupAddress[] = Array.isArray(result)
        ? result
        : [{ address: result, family: family ?? isIP(result) }];
      const refused = addresses.find((entry) => !allowed(entry.address));
      if (refused || addresses.length === 0) {
        callback(unreachableName(hostname, { resolvedAddress: refused?.address }), []);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/**
 * Sends a GET for `url` on a connection of its own, and resolves with the
 * response once its head arrives. The promise settles however the request
 * ends: a response, an error, the deadline, a protocol upgrade, or a close
 * with none of these. Node closes the connection without an error on a
 * `101 Switching Protocols` that nothing listens for, and a request it has
 * closed ignores a later `destroy`, so neither the error nor the deadline
 * would end the wait.
 */
function get(url: URL, lookup: LookupFunction, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    // agent: false gives every request a new connection, so no socket that an
    // unchecked lookup opened is reused.
    const options: https.RequestOptions = {
      agent: false,
      lookup,
      headers: { accept: 'image/*,*/*;q=0.8', 'accept-encoding': 'identity', 'user-agent': 'agentos' },
    };
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => {
      request.destroy();
      fail(new Error('aborted'));
    };
    const onResponse = (response: http.IncomingMessage) => {
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(response);
    };
    const request =
      url.protocol === 'https:' ? https.get(url, options, onResponse) : http.get(url, options, onResponse);
    request.on('error', fail);
    // With a listener, Node hands over the socket of a 101 instead of closing it.
    request.on('upgrade', (_response, socket) => {
      socket.destroy();
      fail(new Error(`imageToBuffer: ${shown(url)} answered with a protocol upgrade, not an image.`));
    });
    request.on('close', () => fail(new Error(`imageToBuffer: the connection to ${shown(url)} closed before a response arrived.`)));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The error for a response larger than the limit. */
function tooLarge(url: URL, maxBytes: number): Error {
  return new Error(`imageToBuffer: the image at ${shown(url)} is larger than ${maxBytes} bytes.`);
}

/**
 * The body of `response`, decoded when the server sent it gzip, deflate or br
 * encoded although the request asked for identity. The decoder is piped from
 * the response, so destroying the response ends it too.
 */
function decodedBody(response: http.IncomingMessage, url: URL): Readable {
  const coding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (coding === '' || coding === 'identity') return response;
  const decoder =
    coding === 'gzip' || coding === 'x-gzip'
      ? createGunzip()
      : coding === 'deflate'
        ? createInflate()
        : coding === 'br'
          ? createBrotliDecompress()
          : undefined;
  if (!decoder) {
    response.destroy();
    throw new Error(`imageToBuffer: ${shown(url)} sent the image in a content coding the fetch does not decode (${coding}).`);
  }
  // Errors reach the reader through the decoder, which pipeline destroys with them.
  pipeline(response, decoder, () => {});
  return decoder;
}

/**
 * Reads the body of `response` until it ends or `signal` aborts, at most
 * `maxBytes` of it after decoding, so a small compressed body that expands
 * past the limit stops there.
 */
async function readBody(
  response: http.IncomingMessage,
  url: URL,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (Number(response.headers['content-length']) > maxBytes) {
    response.destroy();
    throw tooLarge(url, maxBytes);
  }
  const body = decodedBody(response, url);
  const onAbort = () => response.destroy(new Error('aborted'));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const bytes = chunk as Buffer;
      total += bytes.length;
      if (total > maxBytes) {
        response.destroy();
        throw tooLarge(url, maxBytes);
      }
      chunks.push(bytes);
    }
    if (!response.complete) {
      throw new Error(`imageToBuffer: the connection to ${shown(url)} closed before the whole image arrived.`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetches the image at `source`, an http(s) URL an untrusted source gave.
 *
 * The request reaches public network addresses only
 * ({@link isPublicNetworkAddress}): an IP address in the URL is checked before
 * connecting, and a host name's addresses are checked when the connection is
 * made, all of them, so neither a name that resolves to this machine or a
 * private network nor a name whose answer changes between two lookups (DNS
 * rebinding) gets through. Up to five redirects are followed here, each
 * checked the same way, and a redirect to another scheme is refused. The body
 * is read up to `maxBytes` after decoding (the request asks for identity; a
 * gzip, deflate or br body is decoded, any other coding refused), and the
 * whole fetch stops after `timeoutMs`.
 *
 * @throws {RangeError} When `maxBytes` or `timeoutMs` is not a positive
 *   number (or `timeoutMs` is longer than Node's longest timer), before any
 *   connection is made.
 * @throws {Error} With `code: 'IMAGE_URL_REFUSED'` when an address or a
 *   redirect is refused, or a host name does not resolve: the message is the
 *   same for a name that resolves only to a refused address and for one that
 *   does not resolve, so it does not tell which names exist. Otherwise when
 *   the response is not a 2xx, is too large, is cut short, comes in a coding
 *   the fetch does not decode, or takes too long.
 */
export async function fetchUntrustedImage(
  source: string,
  options: UntrustedImageFetchOptions = {},
): Promise<Buffer> {
  const maxBytes = limit(options.maxBytes ?? UNTRUSTED_IMAGE_MAX_BYTES, 'maxBytes', Number.MAX_SAFE_INTEGER);
  const timeoutMs = limit(options.timeoutMs ?? UNTRUSTED_IMAGE_TIMEOUT_MS, 'timeoutMs', MAX_TIMEOUT_MS);
  const allowed = options.allowAddress ?? isPublicNetworkAddress;
  const lookup = checkedLookup(options.lookup ?? (dnsLookup as unknown as LookupFunction), allowed);
  const signal = AbortSignal.timeout(Math.ceil(timeoutMs));
  let url = httpUrl(source, 'the image URL');
  try {
    for (let redirects = 0; ; redirects += 1) {
      const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
      if (isIP(host) && !allowed(host)) {
        throw refusal(`imageToBuffer: ${host} is not a public network address.`);
      }
      const response = await get(url, lookup, signal);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location !== undefined) {
        // Destroyed, not drained: the body is not needed, and a drained socket
        // stays open for as long as the server keeps sending.
        response.destroy();
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(`imageToBuffer: ${shown(url)} redirected more than ${MAX_REDIRECTS} times.`);
        }
        url = httpUrl(location, `the redirect from ${shown(url)}`, url);
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        const reason = response.statusMessage ? ` ${response.statusMessage}` : '';
        throw new Error(`imageToBuffer: failed to fetch image from ${shown(url)} (${status}${reason}).`);
      }
      return await readBody(response, url, maxBytes, signal);
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`imageToBuffer: fetching ${shown(url)} took longer than ${timeoutMs} ms.`);
    }
    throw error;
  }
}
