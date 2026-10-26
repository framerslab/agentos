/**
 * @file untrustedImageFetch.ts
 * Fetches an image from a URL an untrusted source gave, such as a model's
 * tool call, reaching public network addresses only. Each connection's
 * address is checked when the connection is made, every redirect is followed
 * here and checked the same way, and the size and the time are capped.
 */
import { ADDRCONFIG, lookup as dnsLookup, type LookupAddress } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP, isIPv6, type LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';
import { pipeline, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { isPublicNetworkAddress, nat64PrefixesFrom, type Nat64Prefix } from './networkAddress.js';

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
  /**
   * Whether a connection may go to an address. The default is
   * {@link isPublicNetworkAddress}, with the NAT64 prefixes the resolver
   * reveals for an IPv6 address. A function given here is the whole rule:
   * no NAT64 prefix is looked up. Tests replace it.
   */
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

/**
 * The byte limit of an untrusted read: `maxBytes`, or
 * {@link UNTRUSTED_IMAGE_MAX_BYTES} when none is given.
 *
 * @throws {RangeError} When `maxBytes` is not a positive number.
 */
export function untrustedByteLimit(maxBytes?: number): number {
  return limit(maxBytes ?? UNTRUSTED_IMAGE_MAX_BYTES, 'maxBytes', Number.MAX_SAFE_INTEGER);
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
 * What a refusal knows and its message leaves out: the address a host name
 * resolved to, or the resolver's error.
 */
export interface ImageUrlRefusalDetail {
  /** The address that was refused, when the name resolved to one. */
  resolvedAddress?: string;
  /** The resolver's error, when the name did not resolve. */
  cause?: unknown;
}

/** The detail of each refusal, kept off the error itself. */
const refusalDetails = new WeakMap<object, ImageUrlRefusalDetail>();

/**
 * The detail of a refusal that {@link fetchUntrustedImage} threw, for a log:
 * which address a host name resolved to, or why it did not resolve. It is
 * not a property of the error, so code that prints or serializes the error
 * for whoever sent the URL (`util.inspect` shows an error's `cause`) does
 * not hand it over. `undefined` for any other value.
 */
export function imageUrlRefusalDetail(error: unknown): ImageUrlRefusalDetail | undefined {
  return typeof error === 'object' && error !== null ? refusalDetails.get(error) : undefined;
}

/**
 * The error for a host name that resolves to no address the fetch may reach.
 * A name that resolves only to a refused address and a name that does not
 * resolve at all get the same message: it reaches whoever sent the URL, and a
 * model told to try internal names could otherwise map the network one
 * refusal at a time, learning which names exist and what they resolve to.
 * The address or the resolver's error is kept for {@link imageUrlRefusalDetail}.
 */
function unreachableName(hostname: string, detail: ImageUrlRefusalDetail): Error {
  const error = refusal(`imageToBuffer: ${hostname} does not resolve to a public network address.`);
  refusalDetails.set(error, detail);
  return error;
}

/** How long the NAT64 prefixes a resolver revealed are kept before it is asked again. */
const NAT64_PREFIX_TTL_MS = 5 * 60_000;

/** What a resolver revealed about the network's NAT64 prefixes, when, and on which network. */
interface Nat64PrefixEntry {
  at: number;
  network: string;
  prefixes: Promise<Nat64Prefix[] | undefined>;
}

/** The NAT64 prefixes each resolver revealed. */
const nat64PrefixCache = new WeakMap<LookupFunction, Nat64PrefixEntry>();

/**
 * This machine's addresses on its networks, as one string. When it changes
 * the machine has moved to another network, whose NAT64 prefix can be
 * another, so what was learned on the old one is not used.
 */
function networkFingerprint(): string {
  return Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((entry) => !entry.internal)
    .map((entry) => entry.cidr ?? entry.address)
    .sort()
    .join(' ');
}

/**
 * The NAT64 prefixes of the network, as `resolve` reveals them (RFC 7050):
 * the IPv6 addresses it gives for `ipv4only.arpa`, a name that has IPv4
 * addresses only, were made by a DNS64 resolver from those prefixes. A
 * network without DNS64 gives none: the resolver answers that the name has
 * no such address. Any other failure gives `undefined`: the prefixes are
 * not known, and the caller must not take that for "none".
 *
 * An answer is kept for five minutes on the network it was learned on. A
 * failure is not kept.
 */
function nat64Prefixes(resolve: LookupFunction): Promise<Nat64Prefix[] | undefined> {
  const network = networkFingerprint();
  const cached = nat64PrefixCache.get(resolve);
  if (cached && cached.network === network && Date.now() - cached.at < NAT64_PREFIX_TTL_MS) return cached.prefixes;
  let settle!: (prefixes: Nat64Prefix[] | undefined) => void;
  const entry: Nat64PrefixEntry = {
    at: Date.now(),
    network,
    prefixes: new Promise((done) => {
      settle = done;
    }),
  };
  // Kept before the resolver is asked: one that answers at once must find
  // the entry there to remove.
  nat64PrefixCache.set(resolve, entry);
  const unknown = () => {
    if (nat64PrefixCache.get(resolve) === entry) nat64PrefixCache.delete(resolve);
    settle(undefined);
  };
  try {
    resolve('ipv4only.arpa', { family: 6, all: true, hints: 0 }, (error, result) => {
      if (!error) settle(nat64PrefixesFrom(Array.isArray(result) ? result.map((address) => address.address) : [result]));
      else if ((error as NodeJS.ErrnoException).code === 'ENOTFOUND') settle([]);
      else unknown();
    });
  } catch {
    unknown();
  }
  return entry.prefixes;
}

/** Finds the first of `addresses` a fetch may not connect to, or `undefined` when it may connect to all. */
type AddressCheck = (addresses: readonly string[]) => Promise<string | undefined>;

/**
 * The check of a fetch's addresses. With `allowAddress` given, that function
 * is the whole rule. Otherwise an address must be public
 * ({@link isPublicNetworkAddress}), and an IPv6 address that is must not
 * carry a non-public IPv4 address under a NAT64 prefix of this network: the
 * prefixes are asked of `resolve` only when such an address comes up, so a
 * fetch from an IPv4 address asks nothing more. When the resolver fails to
 * say what the prefixes are, the check throws: an IPv6 address cannot be
 * cleared, and the fetch is refused.
 */
function addressCheck(resolve: LookupFunction, allowAddress?: (address: string) => boolean): AddressCheck {
  if (allowAddress) return async (addresses) => addresses.find((address) => !allowAddress(address));
  return async (addresses) => {
    const refused = addresses.find((address) => !isPublicNetworkAddress(address));
    if (refused !== undefined) return refused;
    const overIPv6 = addresses.filter((address) => isIPv6(address));
    if (overIPv6.length === 0) return undefined;
    const prefixes = await nat64Prefixes(resolve);
    if (prefixes === undefined) {
      throw new Error("the resolver did not say whether the network has a NAT64 prefix, so an IPv6 address cannot be cleared");
    }
    return overIPv6.find((address) => !isPublicNetworkAddress(address, { nat64Prefixes: prefixes }));
  };
}

/**
 * A `lookup` for the request that resolves every address of the host name and
 * fails unless each one is allowed. The connection then goes to an address
 * this check passed, so a name that resolves to a private address when the
 * connection is made is refused, whatever an earlier lookup returned.
 *
 * The resolver is asked without `ADDRCONFIG`, the hint Node adds that leaves
 * out a family this machine has no address of. On an IPv6-only network that
 * hint hides a name's private IPv4 address and leaves the NAT64 address a
 * DNS64 resolver made from it, which looks public.
 */
function checkedLookup(resolve: LookupFunction, firstRefused: AddressCheck): LookupFunction {
  return (hostname, options, callback) => {
    const hints = (options.hints ?? 0) & ~ADDRCONFIG;
    resolve(hostname, { ...options, hints, all: true }, (error, result, family) => {
      if (error) {
        callback(unreachableName(hostname, { cause: error }), []);
        return;
      }
      const addresses: LookupAddress[] = Array.isArray(result)
        ? result
        : [{ address: result, family: family ?? isIP(result) }];
      if (addresses.length === 0) {
        callback(unreachableName(hostname, {}), []);
        return;
      }
      firstRefused(addresses.map((entry) => entry.address)).then(
        (refused) => {
          if (refused !== undefined) {
            callback(unreachableName(hostname, { resolvedAddress: refused }), []);
          } else if (options.all) {
            callback(null, addresses);
          } else {
            callback(null, addresses[0].address, addresses[0].family);
          }
        },
        (failure: unknown) => callback(unreachableName(hostname, { cause: failure }), []),
      );
    });
  };
}

/** `promise`, or a rejection as soon as `signal` aborts: the deadline also bounds a wait that cannot itself be cancelled. */
function beforeAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
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
 * encoded although the request asked for identity. The bytes on the wire are
 * held to `maxBytes` as well as the decoded ones the reader counts: a
 * compressed body can carry megabytes that decode to nothing, a gzip
 * header's file name for one.
 */
function decodedBody(response: http.IncomingMessage, url: URL, maxBytes: number): Readable {
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
  let encoded = 0;
  response.on('data', (chunk: Buffer) => {
    encoded += chunk.length;
    if (encoded > maxBytes) decoder.destroy(tooLarge(url, maxBytes));
  });
  // Errors reach the reader through the decoder, which pipeline destroys with them.
  pipeline(response, decoder, () => {});
  return decoder;
}

/**
 * Reads the body of `response` until it ends or `signal` aborts, at most
 * `maxBytes` of it after decoding, so a small compressed body that expands
 * past the limit stops there. An abort ends the decoder as well as the
 * response: the decoder can hold input after the response has ended, and a
 * response that has ended ignores `destroy`.
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
  const body = decodedBody(response, url, maxBytes);
  const onAbort = () => {
    const error = new Error('aborted');
    body.destroy(error);
    response.destroy(error);
  };
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
    if (signal.aborted) {
      throw new Error('aborted');
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
 * made, all of them, in both address families, so neither a name that
 * resolves to this machine or a private network nor a name whose answer
 * changes between two lookups (DNS rebinding) gets through. An IPv6 address
 * is also checked against the network's own NAT64 prefixes, which the
 * resolver reveals (RFC 7050): under one of them it stands for an IPv4
 * address, and that address must be public too. A NAT64 prefix a network
 * announces by other means than DNS64 is not known here; a host on such a
 * network passes `allowAddress`. Up to five redirects are followed here, each
 * checked the same way, and a redirect to another scheme is refused. The body
 * is read up to `maxBytes`, on the wire and after decoding (the request asks
 * for identity; a gzip, deflate or br body is decoded, any other coding
 * refused), and the whole fetch stops after `timeoutMs`.
 *
 * @throws {RangeError} When `maxBytes` or `timeoutMs` is not a positive
 *   number (or `timeoutMs` is longer than Node's longest timer), before any
 *   connection is made.
 * @throws {Error} With `code: 'IMAGE_URL_REFUSED'` when an address or a
 *   redirect is refused, or a host name does not resolve: the message is the
 *   same for a name that resolves only to a refused address and for one that
 *   does not resolve, so it does not tell which names exist
 *   ({@link imageUrlRefusalDetail} has the difference, for a log). Otherwise when
 *   the response is not a 2xx, is too large, is cut short, comes in a coding
 *   the fetch does not decode, or takes too long.
 */
export async function fetchUntrustedImage(
  source: string,
  options: UntrustedImageFetchOptions = {},
): Promise<Buffer> {
  const maxBytes = untrustedByteLimit(options.maxBytes);
  const timeoutMs = limit(options.timeoutMs ?? UNTRUSTED_IMAGE_TIMEOUT_MS, 'timeoutMs', MAX_TIMEOUT_MS);
  const resolver = options.lookup ?? (dnsLookup as unknown as LookupFunction);
  const firstRefused = addressCheck(resolver, options.allowAddress);
  const lookup = checkedLookup(resolver, firstRefused);
  const signal = AbortSignal.timeout(Math.ceil(timeoutMs));
  let url = httpUrl(source, 'the image URL');
  try {
    for (let redirects = 0; ; redirects += 1) {
      const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
      if (isIP(host)) {
        // A check that fails refuses the address as one that did not pass.
        const refused = await beforeAbort(firstRefused([host]), signal).catch((cause: unknown) => {
          if (signal.aborted) throw cause;
          return { cause };
        });
        if (refused !== undefined) {
          const error = refusal(`imageToBuffer: ${host} is not a public network address.`);
          if (typeof refused === 'object') refusalDetails.set(error, refused);
          throw error;
        }
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
