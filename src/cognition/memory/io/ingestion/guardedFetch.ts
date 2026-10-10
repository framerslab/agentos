/**
 * @fileoverview A fetch for a server that reads an address a person gave it.
 * The host is resolved first and refused when any of its addresses is not
 * public ({@link isPublicAddress}: private, loopback, link-local,
 * unique-local, multicast, reserved or unspecified, IPv4 and IPv6, an IPv4
 * address inside IPv6 read as IPv4); the connection is made to the address
 * that was checked, on a connection of its own, so a second lookup cannot
 * point it elsewhere; at most `maxRedirects` redirects, each checked the same
 * way; `http:` and `https:` on their default ports; the body read as a stream
 * under a cap, counted after decoding; one deadline over the whole read; the
 * content types the caller accepts.
 *
 * @module memory/ingestion/guardedFetch
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { pipeline, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { isPublicNetworkAddress } from '../../../../io/media/images/networkAddress.js';

/**
 * Why a fetch was refused or stopped:
 *
 * - `'address'`: the host, or a redirect's host, resolves to an address that is not public.
 * - `'scheme'`: not an `http:` or `https:` address, not an address at all, or one with a user name or password.
 * - `'port'`: a port the caller does not allow.
 * - `'redirects'`: more redirects than `maxRedirects`.
 * - `'status'`: an answer other than 2xx, a redirect without an address, or a protocol upgrade.
 * - `'type'`: a media type the caller does not accept, or a body in a coding the request did not ask for.
 * - `'size'`: a body past `maxBytes`, counted after decoding.
 * - `'deadline'`: the read took longer than `deadlineMs`.
 * - `'network'`: the host has no address, or the lookup, the connection or the read failed.
 */
export type GuardedFetchReason =
  | 'address'
  | 'scheme'
  | 'port'
  | 'redirects'
  | 'status'
  | 'type'
  | 'size'
  | 'deadline'
  | 'network';

/** A fetch that {@link guardedFetch} refused or could not finish. */
export class GuardedFetchError extends Error {
  /**
   * @param reason - Why the fetch stopped.
   * @param message - What happened, in words.
   * @param status - The HTTP status of the answer that was refused, when there was one.
   */
  constructor(
    readonly reason: GuardedFetchReason,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GuardedFetchError';
  }
}

/** What the caller allows a {@link guardedFetch}. */
export interface GuardedFetchOptions {
  /** The most bytes the body may hold, counted after a gzip, deflate or br coding is decoded. */
  maxBytes: number;
  /** How long the whole read may take in milliseconds: the lookups, every redirect and the body. */
  deadlineMs: number;
  /** The most redirects followed, each checked as the first address is. @default 3 */
  maxRedirects?: number;
  /** Media types read, without parameters, in lower case. @default ['text/html', 'application/xhtml+xml', 'application/pdf', 'text/plain'] */
  accept?: readonly string[];
  /** Ports read. @default [80, 443] */
  allowPorts?: readonly number[];
  /** The `User-Agent` header; none is sent when absent. */
  userAgent?: string;
  /** Ends the read early; the fetch then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Answers a host's addresses; a test passes a stand-in. @default `dns.lookup` with every address */
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  /** Addresses reachable though not public, for a test's own server. Never set it in production. */
  allowAddresses?: readonly string[];
}

/** What a {@link guardedFetch} read. */
export interface GuardedResponse {
  /** The last address, after redirects. */
  url: string;
  /** The HTTP status, a 2xx. */
  status: number;
  /** The media type without parameters, in lower case. */
  contentType: string;
  /** The body, decoded. */
  body: Buffer;
}

/** The address a connection goes to, as the check passed it. */
interface CheckedAddress {
  address: string;
  family: 4 | 6;
}

/** The media types read unless the caller names others. */
const DEFAULT_ACCEPT: readonly string[] = ['text/html', 'application/xhtml+xml', 'application/pdf', 'text/plain'];

/** The ports read unless the caller names others. */
const DEFAULT_PORTS: readonly number[] = [80, 443];

/** The redirects followed unless the caller sets another number. */
const DEFAULT_MAX_REDIRECTS = 3;

/** The longest timer Node keeps: a longer one fires after 1 ms. */
const MAX_DEADLINE_MS = 2_147_483_647;

/** The redirect statuses followed. */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * True when `address`, an IPv4 or IPv6 address as text, is a public unicast
 * address: not unspecified, loopback, private, carrier-grade NAT, link-local,
 * unique-local, site-local, multicast, documentation, benchmarking or
 * otherwise reserved, and, for an IPv6 address that carries an IPv4 one
 * (IPv4-mapped, IPv4-compatible, NAT64, 6to4), not one whose IPv4 address is
 * any of those. Text that is not an IP address is not public. It is the rule
 * {@link guardedFetch} applies to every address a host resolves to, the same
 * rule as `isPublicNetworkAddress` in `@framers/agentos/io/media/images`,
 * which it calls.
 *
 * @example
 * ```ts
 * isPublicAddress('8.8.8.8');         // true
 * isPublicAddress('169.254.169.254'); // false: link-local, where cloud metadata services answer
 * isPublicAddress('::ffff:10.0.0.1'); // false: a private IPv4 address inside IPv6
 * ```
 */
export function isPublicAddress(address: string): boolean {
  return isPublicNetworkAddress(address);
}

/** `value` when it is a positive number no larger than `most`; a RangeError naming the option otherwise. */
function positive(value: number, name: string, most: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > most) {
    throw new RangeError(`guardedFetch: ${name} must be a positive number no larger than ${most}, not ${String(value)}.`);
  }
  return value;
}

/** The host of `url` without the brackets around an IPv6 address. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

/** `text`, resolved against `base` when given, as a URL the fetch may read. */
function checkedUrl(text: string, ports: readonly number[], base?: URL): URL {
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    throw new GuardedFetchError('scheme', 'not an address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new GuardedFetchError('scheme', `${url.protocol} is not read`);
  if (url.username !== '' || url.password !== '') throw new GuardedFetchError('scheme', 'an address with a user name is not read');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!ports.includes(port)) throw new GuardedFetchError('port', `port ${port} is not read`);
  return url;
}

/** `promise`, or a rejection with the signal's reason once `signal` aborts first. The work behind `promise` goes on. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The address the connection goes to: every address of the host public or
 * allowed, the first one taken. A lookup cannot be cancelled, so the wait for
 * it ends at the deadline while the lookup itself runs on.
 */
async function checkedAddress(
  url: URL,
  resolve: NonNullable<GuardedFetchOptions['resolve']>,
  allowed: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<CheckedAddress> {
  const host = hostOf(url);
  const literal = isIP(host);
  const answers = literal !== 0 ? [{ address: host, family: literal }] : await untilAborted(resolve(host), signal);
  if (answers.length === 0) throw new GuardedFetchError('network', `${host} has no address`);
  for (const answer of answers) {
    if (!allowed.has(answer.address) && !isPublicAddress(answer.address)) {
      throw new GuardedFetchError('address', `${host} resolves to an address that is not public`);
    }
  }
  const first = answers[0];
  return { address: first.address, family: isIP(first.address) === 6 ? 6 : 4 };
}

/**
 * Sends one GET for `url` to `target` on a connection of its own, and
 * resolves with the response once its head arrives. The promise settles
 * however the request ends: a response, an error, the signal, a protocol
 * upgrade, or a close with none of these. Node closes a connection answered
 * with `101 Switching Protocols` without an error when nothing listens for the
 * upgrade, and a request it has closed ignores a later abort, so without the
 * last two neither the error nor the deadline would end the wait.
 */
function requestOnce(
  url: URL,
  target: CheckedAddress,
  headers: http.OutgoingHttpHeaders,
  signal: AbortSignal,
): Promise<http.IncomingMessage> {
  const host = hostOf(url);
  // The connection goes to the address that was checked, whatever another
  // lookup of the name would answer now.
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
  const options: https.RequestOptions = {
    // A connection of its own: a pooled one may have been opened to another
    // address for the same host and port, by a lookup this check never saw.
    agent: false,
    host,
    port: url.port === '' ? undefined : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers,
    lookup,
    signal,
    // The certificate is checked against the host's name, never the address.
    servername: isIP(host) === 0 ? host : undefined,
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      outcome();
    };
    const onResponse = (response: http.IncomingMessage) => {
      if (settled) {
        response.destroy();
        return;
      }
      settle(() => resolve(response));
    };
    const request = url.protocol === 'https:' ? https.request(options, onResponse) : http.request(options, onResponse);
    request.on('error', (error) => settle(() => reject(error)));
    // With a listener, Node hands over the socket of a 101 instead of closing it.
    request.on('upgrade', (_response, socket) => {
      socket.destroy();
      settle(() => reject(new GuardedFetchError('status', 'the server answered with a protocol upgrade', 101)));
    });
    request.on('close', () => settle(() => reject(new GuardedFetchError('network', 'the connection closed before an answer'))));
    request.end();
  });
}

/**
 * Reads the body of `response`, decoded, and refuses it once it passes
 * `maxBytes` counted after decoding, so a small compressed body that inflates
 * past the cap stops there. A decoder is joined to the response by
 * `pipeline`, so an error or an abort that ends the response ends the read.
 */
async function readBody(response: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const coding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
  let body: Readable = response;
  if (coding !== '' && coding !== 'identity') {
    const decoder =
      coding === 'gzip' || coding === 'x-gzip'
        ? createGunzip()
        : coding === 'deflate'
          ? createInflate()
          : coding === 'br'
            ? createBrotliDecompress()
            : undefined;
    if (decoder === undefined) {
      response.destroy();
      throw new GuardedFetchError('type', `a body in the ${coding} coding is not read`, response.statusCode);
    }
    pipeline(response, decoder, () => {});
    body = decoder;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const bytes = chunk as Buffer;
    total += bytes.length;
    if (total > maxBytes) {
      response.destroy();
      throw new GuardedFetchError('size', `the body passes ${maxBytes} bytes`, response.statusCode);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

/**
 * What a read that failed rejects with: the caller's own reason when its
 * signal aborted, a deadline refusal once the deadline passed, a refusal as it
 * was thrown, and any other failure as a network one.
 */
function failureOf(error: unknown, callerSignal: AbortSignal | undefined, deadline: AbortSignal): unknown {
  if (callerSignal?.aborted) return callerSignal.reason;
  if (deadline.aborted) return new GuardedFetchError('deadline', 'the read took too long');
  if (error instanceof GuardedFetchError) return error;
  return new GuardedFetchError('network', error instanceof Error ? error.message : String(error));
}

/**
 * Reads `address`, an http or https address a person gave a server, under
 * `options`. Each hop resolves the host and refuses it when any of its
 * addresses is not public ({@link isPublicAddress}) and not in
 * `allowAddresses`, then connects to the first checked address on a
 * connection of its own; a redirect is followed only to an address that
 * passes the same checks, at most `maxRedirects` times. The answer must be a
 * 2xx of a type in `accept`, and its body, decoded from gzip, deflate or br,
 * is refused once it passes `maxBytes`. The whole read stops at `deadlineMs`.
 *
 * @example
 * ```ts
 * const page = await guardedFetch('https://example.com/notes', { maxBytes: 2 * 1024 * 1024, deadlineMs: 10_000 });
 * page.contentType; // 'text/html'
 * ```
 *
 * @throws {RangeError} When `maxBytes` or `deadlineMs` is not a positive
 *   number (or `deadlineMs` is longer than Node's longest timer), or
 *   `maxRedirects` is not a whole number of 0 or more, before any lookup.
 * @throws {GuardedFetchError} When the address, a redirect or the answer is
 *   refused, or the read fails or passes its deadline; `reason` says which.
 * @throws The reason of `options.signal` when the caller aborts it.
 */
export async function guardedFetch(address: string, options: GuardedFetchOptions): Promise<GuardedResponse> {
  const maxBytes = positive(options.maxBytes, 'maxBytes', Number.MAX_SAFE_INTEGER);
  const deadlineMs = positive(options.deadlineMs, 'deadlineMs', MAX_DEADLINE_MS);
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new RangeError(`guardedFetch: maxRedirects must be a whole number of 0 or more, not ${String(maxRedirects)}.`);
  }
  options.signal?.throwIfAborted();
  const accept = options.accept ?? DEFAULT_ACCEPT;
  const ports = options.allowPorts ?? DEFAULT_PORTS;
  const resolve: NonNullable<GuardedFetchOptions['resolve']> =
    options.resolve ?? ((host) => dnsLookup(host, { all: true, order: 'verbatim' }));
  const allowed: ReadonlySet<string> = new Set(options.allowAddresses ?? []);
  const headers: http.OutgoingHttpHeaders = {
    accept: accept.join(', '),
    'accept-encoding': 'gzip, deflate, br',
    ...(options.userAgent ? { 'user-agent': options.userAgent } : {}),
  };
  let url = checkedUrl(address, ports);
  const deadline = AbortSignal.timeout(Math.ceil(deadlineMs));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    for (let hop = 0; ; hop += 1) {
      const target = await checkedAddress(url, resolve, allowed, signal);
      const response = await requestOnce(url, target, headers, signal);
      const status = response.statusCode ?? 0;
      if (REDIRECTS.has(status)) {
        const location = response.headers.location;
        // Destroyed, not drained: the body is not needed, and the connection is this hop's alone.
        response.destroy();
        if (location === undefined) throw new GuardedFetchError('status', 'a redirect with no address', status);
        if (hop >= maxRedirects) throw new GuardedFetchError('redirects', 'too many redirects', status);
        url = checkedUrl(location, ports, url);
        continue;
      }
      if (status < 200 || status > 299) {
        response.destroy();
        throw new GuardedFetchError('status', `the server answered ${status}`, status);
      }
      const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!accept.includes(contentType)) {
        response.destroy();
        throw new GuardedFetchError('type', `${contentType || 'no type'} is not read`, status);
      }
      return { url: url.toString(), status, contentType, body: await readBody(response, maxBytes) };
    }
  } catch (error) {
    throw failureOf(error, options.signal, deadline);
  }
}
