/**
 * @fileoverview A fetch for a server that reads an address a person gave it.
 * The host is resolved first and refused when any of its addresses is not
 * public ({@link isPublicAddress}: private, loopback, link-local,
 * unique-local, multicast, reserved or unspecified, IPv4 and IPv6, an IPv4
 * address inside IPv6 read as IPv4); the connection is made to the address
 * that was checked, on a connection of its own, so a second lookup cannot
 * point it elsewhere; at most `maxRedirects` redirects, each checked the same
 * way; a caller's rule over the host (`allowHost`), asked about the first
 * address and about every redirect's target before either is resolved;
 * `http:` and `https:` on their default ports; the body read as a stream
 * under a cap, counted as it arrives and again after decoding; one deadline
 * over the whole read; the content types the caller accepts. An IPv6 address
 * is also checked for an IPv4 one it carries under a NAT64 prefix of this
 * network (RFC 7050), not only under the well-known one.
 *
 * @module memory/ingestion/guardedFetch
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { performance } from 'node:perf_hooks';
import { pipeline, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { isPublicNetworkAddress, nat64PrefixesFrom, type Nat64Prefix } from '../../../../io/media/images/networkAddress.js';

/**
 * Why a fetch was refused or stopped:
 *
 * - `'address'`: the host, or a redirect's host, resolves to an address that is not public.
 * - `'host'`: the host, or a redirect's host, is one the caller's `allowHost` does not allow, or that rule failed.
 * - `'scheme'`: not an `http:` or `https:` address, not an address at all, or one with a user name or password.
 * - `'port'`: a port the caller does not allow.
 * - `'redirects'`: more redirects than `maxRedirects`.
 * - `'status'`: an answer other than 2xx, a redirect without an address, or a protocol upgrade.
 * - `'type'`: a media type the caller does not accept, or a body in a coding the request did not ask for.
 * - `'size'`: a body past `maxBytes`, as it arrives or after decoding.
 * - `'deadline'`: the read took longer than `deadlineMs`.
 * - `'network'`: the host has no address, the lookup, the connection or the read failed, or the
 *   network's NAT64 prefixes could not be read for a host with an IPv6 address.
 */
export type GuardedFetchReason =
  | 'address'
  | 'host'
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
   * What the caller's host rule threw, when the refusal is that rule's
   * failure; absent otherwise. The message keeps its details out.
   */
  readonly cause?: unknown;

  /**
   * @param reason - Why the fetch stopped.
   * @param message - What happened, in words.
   * @param status - The HTTP status of the answer that was refused, when there was one.
   * @param cause - What the host rule threw, when that is why.
   */
  constructor(
    readonly reason: GuardedFetchReason,
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'GuardedFetchError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** What the caller allows a {@link guardedFetch}. */
export interface GuardedFetchOptions {
  /** The most bytes the body may hold, counted as they arrive and again after a gzip, deflate or br coding is decoded. */
  maxBytes: number;
  /** How long the whole read may take in milliseconds: the host rule, the lookups, every redirect and the body. */
  deadlineMs: number;
  /** The most redirects followed, each checked as the first address is. @default 3 */
  maxRedirects?: number;
  /**
   * Media types read, without parameters, in lower case. An answer with no
   * `Content-Type` counts as `application/octet-stream`.
   * @default ['text/html', 'application/xhtml+xml', 'application/pdf', 'text/plain']
   */
  accept?: readonly string[];
  /** Ports read. @default [80, 443] */
  allowPorts?: readonly number[];
  /**
   * A rule over the host, asked about the host of the address and about the
   * host of every redirect's target, after the scheme and credential checks
   * and before the port check and the lookup: the read is refused with the
   * reason `'host'` unless it answers `true`, so a refused host is never
   * resolved or connected to. It sees the host alone: lower case, without a
   * port, without the brackets around an IPv6 address, without a trailing
   * dot. A host it allows is still resolved and checked as every host is:
   * the rule narrows what the fetch reads and never widens it. A rule that
   * throws refuses as one that answers `false`, with what it threw as the
   * refusal's `cause`; a value that is not a function is a `TypeError`
   * before any lookup. The rule is asked under the deadline and the caller's
   * signal like every other step: its time counts against `deadlineMs`, so a
   * rule that outlasts the deadline leaves the read refused `'deadline'` with
   * nothing more begun, and when it aborts the signal the read ends with that
   * signal's reason.
   * @default every host
   */
  allowHost?: (host: string) => boolean;
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
  /** The media type without parameters, in lower case; `application/octet-stream` for an answer that names none. */
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
 * How long a connection to one of a host's addresses may take before the
 * next is tried. Node ends an attempt at this timeout and moves on (it does
 * not race them), so at its default of 250 ms a first address that connects
 * more slowly, over a long or lossy link, would be given up for a next one
 * that may refuse. Two seconds is RFC 8305's upper bound for this delay
 * (section 5); an address that cannot be reached costs at most that.
 */
const CONNECT_ATTEMPT_MS = 2_000;

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

/**
 * The host of `url` as a caller's `allowHost` sees it: {@link hostOf} with
 * any trailing dot removed, since `example.com.` names the same host as
 * `example.com` and a rule that refuses one must refuse the other. The URL
 * parser has already lower-cased a name and put an international one in its
 * ASCII form. The request itself goes to the host as written.
 */
function ruleHostOf(url: URL): string {
  return hostOf(url).replace(/\.+$/, '');
}

/** A caller's rule over the host, or `undefined` when every host may be read. */
type HostRule = GuardedFetchOptions['allowHost'];

/**
 * `text`, resolved against `base` when given, as a URL the fetch may read: an
 * `http:` or `https:` address without credentials, whose host `allowHost`
 * allows, on a port in `ports`. The host is asked about before the port, so a
 * refused host is never reported in terms of its port, and before any lookup,
 * so it costs no resolution.
 */
function checkedUrl(text: string, ports: readonly number[], allowHost: HostRule, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    throw new GuardedFetchError('scheme', 'not an address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new GuardedFetchError('scheme', `${url.protocol} is not read`);
  if (url.username !== '' || url.password !== '') throw new GuardedFetchError('scheme', 'an address with a user name is not read');
  if (allowHost !== undefined) {
    const host = ruleHostOf(url);
    let answer: unknown;
    try {
      answer = allowHost(host);
    } catch (cause) {
      throw new GuardedFetchError('host', `${host} is not read: the host rule failed`, undefined, cause);
    }
    if (answer !== true) throw new GuardedFetchError('host', `${host} is not read`);
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!ports.includes(port)) throw new GuardedFetchError('port', `port ${port} is not read`);
  return url;
}

/**
 * The result of `work`, or a rejection with the signal's reason once `signal`
 * aborts first. The work is not begun when the signal has already aborted, so
 * no lookup is started for a read that has ended, and the abort is listened
 * for before the work begins, so work that aborts the signal as it starts ends
 * the wait too; once begun, the work goes on when the signal aborts, since a
 * lookup cannot be cancelled.
 */
function untilAborted<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    let promise: Promise<T>;
    try {
      promise = work();
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      reject(error);
      return;
    }
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

/** The NAT64 prefixes of the network, or `undefined` when they could not be read (see {@link nat64PrefixesOf}). */
type Nat64Lookup = () => Promise<Nat64Prefix[] | undefined>;

/**
 * The addresses the connection may go to: every address of the host, each
 * public or allowed, in the order the resolver gave them. A lookup cannot be
 * cancelled, so the wait for it ends at the deadline while the lookup itself
 * runs on; none is begun once the read has ended.
 */
async function checkedAddresses(
  url: URL,
  resolve: NonNullable<GuardedFetchOptions['resolve']>,
  allowed: ReadonlySet<string>,
  signal: AbortSignal,
  nat64: Nat64Lookup,
): Promise<CheckedAddress[]> {
  const host = hostOf(url);
  const literal = isIP(host);
  const answers = literal !== 0 ? [{ address: host, family: literal }] : await untilAborted(() => resolve(host), signal);
  if (answers.length === 0) throw new GuardedFetchError('network', `${host} has no address`);
  for (const answer of answers) {
    if (!allowed.has(answer.address) && !isPublicAddress(answer.address)) {
      throw new GuardedFetchError('address', `${host} resolves to an address that is not public`);
    }
  }
  // A public-looking IPv6 address can carry a private IPv4 one under a NAT64
  // prefix of this network, which a DNS64 resolver writes into the answer
  // for a name with IPv4 addresses only. The prefixes are asked for only
  // when such an address comes up.
  const overIPv6 = answers.filter((answer) => !allowed.has(answer.address) && isIP(answer.address) === 6);
  if (overIPv6.length > 0) {
    const nat64Prefixes = await nat64();
    if (nat64Prefixes === undefined) {
      throw new GuardedFetchError('network', `the network's NAT64 prefixes could not be read, so the IPv6 address of ${host} cannot be cleared`);
    }
    if (overIPv6.some((answer) => !isPublicNetworkAddress(answer.address, { nat64Prefixes }))) {
      throw new GuardedFetchError('address', `${host} resolves to an address that is not public`);
    }
  }
  return answers.map((answer) => ({ address: answer.address, family: isIP(answer.address) === 6 ? 6 : 4 }));
}

/**
 * The NAT64 prefixes of the network, as `resolve` reveals them (RFC 7050):
 * the IPv6 addresses it gives for `ipv4only.arpa`, a name with IPv4
 * addresses only, were made by a DNS64 resolver from those prefixes, and a
 * network without DNS64 gives its IPv4 addresses alone. `undefined` when
 * the lookup fails, `ENOTFOUND` included: `resolve` asks for every family,
 * so even a network without DNS64 answers with the name's IPv4 addresses,
 * and a name that does not resolve at all was filtered or the resolver
 * failed. The prefixes are then not known, and no IPv6 address can be
 * cleared. (The image fetch, `untrustedImageFetch.ts`, asks for IPv6
 * addresses alone, where `ENOTFOUND` does mean no DNS64.)
 */
async function nat64PrefixesOf(
  resolve: NonNullable<GuardedFetchOptions['resolve']>,
  signal: AbortSignal,
): Promise<Nat64Prefix[] | undefined> {
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await untilAborted(() => resolve('ipv4only.arpa'), signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
  return nat64PrefixesFrom(answers.map((answer) => answer.address).filter((address) => isIP(address) === 6));
}

/**
 * Sends one GET for `url` on a connection of its own to one of `targets`,
 * the addresses that were checked, and resolves with the response once its
 * head arrives. Node tries them in turn, alternating the families, when the
 * first does not connect (`autoSelectFamily`), so a host whose first address
 * cannot be reached from this network, often an IPv6 one, is read at the
 * next; it never connects to an address that was not checked. The promise settles
 * however the request ends: a response, an error, the signal, a protocol
 * upgrade, or a close with none of these. Node closes a connection answered
 * with `101 Switching Protocols` without an error when nothing listens for the
 * upgrade, and a request it has closed ignores a later abort, so without the
 * last two neither the error nor the deadline would end the wait.
 */
function requestOnce(
  url: URL,
  targets: CheckedAddress[],
  headers: http.OutgoingHttpHeaders,
  signal: AbortSignal,
): Promise<http.IncomingMessage> {
  const host = hostOf(url);
  // The connection goes to an address that was checked, whatever another
  // lookup of the name would answer now.
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, targets.map(({ address, family }) => ({ address, family })));
    else callback(null, targets[0].address, targets[0].family);
  };
  // autoSelectFamily and its attempt timeout are socket options that
  // http(s).request hands on to the connection; @types/node does not list
  // them among the request's options.
  const options: https.RequestOptions & { autoSelectFamily?: boolean; autoSelectFamilyAttemptTimeout?: number } = {
    // A connection of its own: a pooled one may have been opened to another
    // address for the same host and port, by a lookup this check never saw.
    agent: false,
    host,
    port: url.port === '' ? undefined : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers,
    lookup,
    // Set here, not left to the process-wide defaults, which a host can change.
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_MS,
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
 * `maxBytes`, counted as it arrives and again after decoding: a small
 * compressed body that inflates past the cap stops there, and so does a
 * large one that decodes to little, which would otherwise be read until the
 * deadline. A decoder is joined to the response by `pipeline`, so an error
 * ends both. The signal destroys both streams even when the connection has
 * already closed and only decoding remains.
 */
async function readBody(response: http.IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (Number(response.headers['content-length']) > maxBytes) {
    response.destroy();
    throw new GuardedFetchError('size', `the body passes ${maxBytes} bytes`, response.statusCode);
  }
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
    let encoded = 0;
    response.on('data', (chunk: Buffer) => {
      encoded += chunk.length;
      if (encoded > maxBytes) decoder.destroy(new GuardedFetchError('size', `the body passes ${maxBytes} bytes`, response.statusCode));
    });
    pipeline(response, decoder, () => {});
    body = decoder;
  }
  /** Ends the response and any decoder, including decoding after the wire closes. */
  const onAbort = () => {
    response.destroy();
    body.destroy();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) {
      onAbort();
      signal.throwIfAborted();
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
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** The refusal of a read that passed its deadline. */
function deadlinePassed(): GuardedFetchError {
  return new GuardedFetchError('deadline', 'the read took too long');
}

/**
 * What a read that failed rejects with: the caller's own reason when its
 * signal aborted, a deadline refusal once the deadline passed (by its signal,
 * or by the clock when a synchronous step held the timer), a refusal as it
 * was thrown, and any other failure as a network one.
 */
function failureOf(error: unknown, callerSignal: AbortSignal | undefined, deadline: AbortSignal, overdue: () => boolean): unknown {
  if (callerSignal?.aborted) return callerSignal.reason;
  if (deadline.aborted || overdue()) return deadlinePassed();
  if (error instanceof GuardedFetchError) return error;
  return new GuardedFetchError('network', 'The network read failed.');
}

/**
 * Reads `address`, an http or https address a person gave a server, under
 * `options`. Each hop asks the caller's `allowHost`, when given, about the
 * host before anything is resolved, then resolves the host and refuses it
 * when any of its addresses is not public ({@link isPublicAddress}) and not in
 * `allowAddresses`, then connects to a checked address on a connection of
 * its own, trying the next one when the first cannot be reached; a redirect is followed only to an address that
 * passes the same checks, at most `maxRedirects` times. The answer must be a
 * 2xx of a type in `accept`, and its body, decoded from gzip, deflate or br,
 * is refused once it passes `maxBytes` on the wire or decoded. The whole read
 * stops at `deadlineMs`.
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
 * @throws {TypeError} When `allowHost` is given and is not a function, before any lookup.
 * @throws {GuardedFetchError} When the address, a redirect or the answer is
 *   refused, or the read fails or passes its deadline; `reason` says which,
 *   and a host rule's own failure is the error's `cause`.
 * @throws The reason of `options.signal` when the caller aborts it.
 */
export async function guardedFetch(address: string, options: GuardedFetchOptions): Promise<GuardedResponse> {
  const maxBytes = positive(options.maxBytes, 'maxBytes', Number.MAX_SAFE_INTEGER);
  const deadlineMs = positive(options.deadlineMs, 'deadlineMs', MAX_DEADLINE_MS);
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new RangeError(`guardedFetch: maxRedirects must be a whole number of 0 or more, not ${String(maxRedirects)}.`);
  }
  const hostRule: unknown = options.allowHost;
  if (hostRule !== undefined && typeof hostRule !== 'function') {
    throw new TypeError(`guardedFetch: allowHost must be a function over the host, not ${typeof hostRule}.`);
  }
  const allowHost = options.allowHost;
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
  const started = performance.now();
  const deadline = AbortSignal.timeout(Math.ceil(deadlineMs));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  /**
   * True once the deadline has passed by the clock. The host rule runs
   * synchronously and so holds the deadline's timer until it returns; the
   * clock says what the timer cannot say yet.
   */
  const overdue = (): boolean => performance.now() - started >= deadlineMs;
  /** Throws when the read has ended: by the caller's abort, or by the deadline, read from the signal or from the clock. */
  const ended = (): void => {
    signal.throwIfAborted();
    if (overdue()) throw deadlinePassed();
  };
  // Asked once a fetch, the first time an IPv6 address comes up, whatever
  // number of redirects follows.
  let nat64Asked: ReturnType<Nat64Lookup> | undefined;
  const nat64: Nat64Lookup = () => (nat64Asked ??= nat64PrefixesOf(resolve, signal));
  try {
    // The first address is checked under the deadline and the caller's
    // signal, as every redirect's target is: the host rule's time counts
    // against the deadline, and a rule that aborts the signal ends the read
    // with that signal's reason.
    let url = checkedUrl(address, ports, allowHost);
    for (let hop = 0; ; hop += 1) {
      // Nothing is begun for a read that has ended: the rule may have aborted
      // the signal, or outlasted the deadline, whose timer could not fire
      // while it ran.
      ended();
      const targets = await checkedAddresses(url, resolve, allowed, signal, nat64);
      // A literal address arrives here with no lookup to end the read at.
      ended();
      const response = await requestOnce(url, targets, headers, signal);
      const status = response.statusCode ?? 0;
      if (REDIRECTS.has(status)) {
        const location = response.headers.location;
        // Destroyed, not drained: the body is not needed, and the connection is this hop's alone.
        response.destroy();
        if (location === undefined) throw new GuardedFetchError('status', 'a redirect with no address', status);
        if (hop >= maxRedirects) throw new GuardedFetchError('redirects', 'too many redirects', status);
        url = checkedUrl(location, ports, allowHost, url);
        continue;
      }
      if (status < 200 || status > 299) {
        response.destroy();
        throw new GuardedFetchError('status', `the server answered ${status}`, status);
      }
      // An answer that names no type is application/octet-stream, as RFC 9110
      // (8.3) lets a recipient take it: a caller that accepts bytes of no
      // type in particular reads it, and any other list refuses it as before.
      const declared = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const contentType = declared || 'application/octet-stream';
      if (!accept.includes(contentType)) {
        response.destroy();
        throw new GuardedFetchError('type', `${declared || 'an answer with no type'} is not read`, status);
      }
      const body = await readBody(response, maxBytes, signal);
      signal.throwIfAborted();
      return { url: url.toString(), status, contentType, body };
    }
  } catch (error) {
    throw failureOf(error, options.signal, deadline, overdue);
  }
}
