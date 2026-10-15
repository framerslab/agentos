/**
 * @fileoverview Outbound HTTP to destinations a host does not control (a customer's webhook, a tool's endpoint, a
 * developer's model endpoint), checked before any byte is sent: the scheme and port the policy allows, no credentials
 * in the address, no address literal in the hosted profile, every address the name resolves to outside the refused
 * blocks and outside the network's own NAT64 prefixes, and the connection its own, pinned to the address that was
 * checked (the request's `lookup` answers it, so a second resolution cannot move the connection) while TLS still
 * validates the certificate against the name. No redirect is followed; the answer is bounded in time and size; and
 * every request checks the name again, so a destination that rebinds to a private address is refused on its next
 * connection.
 *
 * @module safety/egress/CheckedEgress
 */
import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { nat64PrefixesFrom, type Nat64Prefix } from '../../io/media/images/networkAddress.js';
import { isPublicAddress } from './addresses.js';

/** Which destinations a policy is for: a hosted service's customers, or a developer's own machine. */
export type EgressProfile = 'hosted' | 'local';

/** What a request may reach, and its bounds. */
export interface EgressPolicy {
  profile: EgressProfile;
  /** The schemes allowed. */
  schemes: ReadonlyArray<'https:' | 'http:'>;
  /** The ports allowed; any port when absent. */
  ports?: readonly number[];
  /** Refuse every address in the refused blocks or under the network's own NAT64 prefixes, and address literals. */
  publicOnly: boolean;
  /** The most a request may take, connection to last byte, in milliseconds. */
  timeoutMs: number;
  /** The most an answer's body may be, in bytes. */
  maxResponseBytes: number;
}

/** The hosted profile: https on 443 to public names alone. Defaults: 10 seconds, 1 MiB. */
export function hostedEgressPolicy(bounds: { timeoutMs?: number; maxResponseBytes?: number } = {}): EgressPolicy {
  return { profile: 'hosted', schemes: ['https:'], ports: [443], publicOnly: true, timeoutMs: bounds.timeoutMs ?? 10_000, maxResponseBytes: bounds.maxResponseBytes ?? 1_048_576 };
}

/** The local profile: a developer's own endpoints, http or https on any port, private addresses allowed. */
export function localEgressPolicy(bounds: { timeoutMs?: number; maxResponseBytes?: number } = {}): EgressPolicy {
  return { profile: 'local', schemes: ['https:', 'http:'], publicOnly: false, timeoutMs: bounds.timeoutMs ?? 60_000, maxResponseBytes: bounds.maxResponseBytes ?? 16_777_216 };
}

/** Why a request was refused. */
export type EgressRefusal = 'scheme' | 'port' | 'userinfo' | 'address_literal' | 'private_address' | 'unresolved' | 'redirect' | 'too_large' | 'timeout';

/** Thrown for a destination or an answer the policy refuses; before any byte is sent, except for the answer's bounds. */
export class EgressRefusedError extends Error {
  /**
   * @param reason - Why.
   * @param detail - What happened, in words, when the reason alone does not say; it names no address.
   */
  constructor(readonly reason: EgressRefusal, detail?: string) {
    super(detail ? `egress refused: ${reason} (${detail})` : `egress refused: ${reason}`);
    this.name = 'EgressRefusedError';
  }
}

/** A host name's addresses. */
export type AddressLookup = (hostname: string, signal?: AbortSignal) => Promise<Array<{ address: string; family: number }>>;

/** Why `signal` stopped the work: a `timeout` refusal for a deadline, the caller's own reason otherwise. */
function stopReason(signal: AbortSignal): unknown {
  return signal.reason?.name === 'TimeoutError' ? new EgressRefusedError('timeout') : signal.reason;
}

/** Bounds every awaited stage, including adapters that ignore cancellation. */
async function waitStage<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw stopReason(signal);
  let abort = (): void => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(stopReason(signal));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work(), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

const systemLookup: AddressLookup = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

/**
 * The network's own NAT64 prefixes (RFC 7050), from the IPv6 addresses `lookup` gives for `ipv4only.arpa`: that name
 * has IPv4 addresses alone, so an IPv6 answer was written by a DNS64 resolver from a prefix of this network, and a
 * network without DNS64 gives none.
 *
 * @throws {EgressRefusedError} `unresolved` when the name cannot be read, since no IPv6 address can then be cleared.
 */
async function networkNat64Prefixes(lookup: AddressLookup, signal: AbortSignal): Promise<Nat64Prefix[]> {
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await waitStage(() => lookup('ipv4only.arpa', signal), signal);
  } catch (error) {
    if (signal.aborted || error instanceof EgressRefusedError) throw error;
    throw new EgressRefusedError('unresolved', "the network's NAT64 prefixes could not be read, so an IPv6 address cannot be cleared");
  }
  return nat64PrefixesFrom(answers.map((a) => a.address).filter((address) => isIP(address) === 6));
}

/** The NAT64 prefixes as subnets: each prefix's bytes, padded with zeros, written as an IPv6 network. */
function nat64Blocks(prefixes: readonly Nat64Prefix[]): BlockList {
  const blocks = new BlockList();
  for (const { bytes, length } of prefixes) {
    const full = Array.from({ length: 16 }, (_, index) => bytes[index] ?? 0);
    const groups = Array.from({ length: 8 }, (_, index) => ((full[2 * index] << 8) | full[2 * index + 1]).toString(16));
    blocks.addSubnet(groups.join(':'), length, 'ipv6');
  }
  return blocks;
}

/** A destination that passed the policy, with the address its connection is pinned to. */
export interface CheckedDestination {
  url: URL;
  hostname: string;
  port: number;
  address: string;
  family: 4 | 6;
}

/**
 * Checks a destination against a policy and answers the address to connect to. When the policy is `publicOnly` and the
 * name has an IPv6 address, the network's own NAT64 prefixes are read through `lookup` as well, and an address under
 * one of them is refused like an address under the well-known 64:ff9b::/96, whatever IPv4 address it carries.
 *
 * @throws {EgressRefusedError} When the destination is refused.
 */
export async function checkDestination(url: string | URL, policy: EgressPolicy, lookup: AddressLookup = systemLookup, signal: AbortSignal = AbortSignal.timeout(policy.timeoutMs)): Promise<CheckedDestination> {
  if (signal.aborted) throw stopReason(signal);
  let target: URL;
  try {
    target = typeof url === 'string' ? new URL(url) : new URL(url.href);
  } catch {
    throw new EgressRefusedError('scheme');
  }
  if (!policy.schemes.includes(target.protocol as 'https:' | 'http:')) throw new EgressRefusedError('scheme');
  if (target.username || target.password) throw new EgressRefusedError('userinfo');
  const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;
  if (policy.ports && !policy.ports.includes(port)) throw new EgressRefusedError('port');
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(hostname);
  if (literal) {
    if (policy.publicOnly) throw new EgressRefusedError('address_literal');
    return { url: target, hostname, port, address: hostname, family: literal as 4 | 6 };
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await waitStage(() => lookup(hostname, signal), signal);
  } catch (error) {
    if (signal.aborted || error instanceof EgressRefusedError) throw error;
    throw new EgressRefusedError('unresolved');
  }
  if (addresses.length === 0) throw new EgressRefusedError('unresolved');
  if (policy.publicOnly) {
    if (!addresses.every((a) => isPublicAddress(a.address))) throw new EgressRefusedError('private_address');
    // A public-looking IPv6 address can sit under a NAT64 prefix of this network, which a DNS64 resolver writes into
    // the answer for a name with IPv4 addresses only; the NAT64 gateway then connects to the IPv4 address it carries.
    const overIPv6 = addresses.filter((a) => isIP(a.address) === 6);
    if (overIPv6.length > 0) {
      const translated = nat64Blocks(await networkNat64Prefixes(lookup, signal));
      if (overIPv6.some((a) => translated.check(a.address, 'ipv6'))) throw new EgressRefusedError('private_address');
    }
  }
  const chosen = addresses[0]!;
  return { url: target, hostname, port, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/** One request as a connector makes it. */
export interface EgressConnectRequest {
  destination: CheckedDestination;
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  signal: AbortSignal;
  timeoutMs: number;
}

/** An answer's status, headers and body, before the bounds are applied. */
export interface EgressConnectResponse {
  status: number;
  headers: IncomingHttpHeaders | Record<string, string>;
  body: AsyncIterable<Buffer | string>;
  /** Immediately destroys unread response resources. */
  cancel?(): void;
}

/** Opens one connection to a checked destination; the default is {@link nodeConnector}. */
export type EgressConnector = (request: EgressConnectRequest) => Promise<EgressConnectResponse>;

/**
 * The options a connection to a checked destination is opened with: the pinned lookup, a connection of its own and the
 * name for TLS.
 */
export function connectionOptions(destination: CheckedDestination, method: string, headers: Record<string, string>, timeoutMs: number): RequestOptions & { servername?: string; rejectUnauthorized?: boolean } {
  const pinned = ((_hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: destination.address, family: destination.family }]);
    else callback(null, destination.address, destination.family);
  }) as unknown as LookupFunction;
  return {
    method,
    headers,
    lookup: pinned,
    // A connection of its own: a pooled keep-alive socket for the same host and port may have been opened to an address
    // this check never saw, and a reused socket never asks `lookup`.
    agent: false,
    timeout: timeoutMs,
    ...(destination.url.protocol === 'https:' && !isIP(destination.hostname) ? { servername: destination.hostname } : {}),
  };
}

/** The default connector, over `node:http` and `node:https`. */
export const nodeConnector: EgressConnector = (request) =>
  new Promise((resolve, reject) => {
    const options = { ...connectionOptions(request.destination, request.method, request.headers, request.timeoutMs), signal: request.signal };
    const onResponse = (res: IncomingMessage): void =>
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, cancel: () => { res.destroy(); req.destroy(); } });
    // One call for each scheme: the two overloaded request functions cannot be called through a union of their types.
    const req = request.destination.url.protocol === 'https:'
      ? httpsRequest(request.destination.url, options, onResponse)
      : httpRequest(request.destination.url, options, onResponse);
    req.on('timeout', () => req.destroy(new EgressRefusedError('timeout')));
    req.on('error', reject);
    if (request.body !== undefined) req.end(request.body);
    else req.end();
  });

/** What {@link checkedRequest} and {@link checkedStream} send. */
export interface CheckedRequestInput {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Buffer;
  policy: EgressPolicy;
  /** A caller's cancellation; the policy's deadline applies as well. */
  signal?: AbortSignal;
  lookup?: AddressLookup;
  connector?: EgressConnector;
  /** A 3xx: refused (the default), or answered as it is, never followed. */
  onRedirect?: 'throw' | 'return';
}

/** A bounded answer. */
export interface CheckedResponse {
  status: number;
  headers: IncomingHttpHeaders | Record<string, string>;
  body: Buffer;
}

/**
 * A streamed answer; reading `body` past the size bound gives the bytes up to the bound, then throws
 * {@link EgressRefusedError} `too_large`.
 */
export interface CheckedStreamResponse {
  status: number;
  headers: IncomingHttpHeaders | Record<string, string>;
  body: AsyncIterable<Buffer>;
}

/** Opens a checked connection and applies the redirect rule and the deadline; the body is bounded by the caller. */
async function open(input: CheckedRequestInput): Promise<{ response: EgressConnectResponse; signal: AbortSignal; deadline: AbortSignal }> {
  const deadline = AbortSignal.timeout(input.policy.timeoutMs);
  const signal = input.signal ? AbortSignal.any([deadline, input.signal]) : deadline;
  const destination = await checkDestination(input.url, input.policy, input.lookup, signal);
  if (signal.aborted) throw stopReason(signal);
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  if (input.body !== undefined) headers['content-length'] = String(Buffer.byteLength(input.body));
  const connector = input.connector ?? nodeConnector;
  let response: EgressConnectResponse;
  try {
    response = await waitStage(() => connector({ destination, method: input.method, headers, body: input.body, signal, timeoutMs: input.policy.timeoutMs }).then((answer) => {
      if (signal.aborted) answer.cancel?.();
      return answer;
    }), signal);
  } catch (err) {
    if (deadline.aborted) throw new EgressRefusedError('timeout');
    throw err;
  }
  if (response.status >= 300 && response.status < 400 && (input.onRedirect ?? 'throw') === 'throw') {
    if (response.cancel) response.cancel();
    else {
      for await (const _ of bounded(response.body, input.policy.maxResponseBytes, signal, () => deadline.aborted)) {
        // An injected connector without cancellation still obeys both response bounds.
      }
    }
    throw new EgressRefusedError('redirect');
  }
  return { response, signal, deadline };
}

/**
 * Reads `body` to the end, refusing it past `max` bytes: the bytes up to the bound are given, then the refusal, since
 * one chunk can carry the last bytes under the bound with the first ones past it.
 */
async function* bounded(body: AsyncIterable<Buffer | string>, max: number, signal: AbortSignal, deadline: () => boolean): AsyncIterable<Buffer> {
  let total = 0;
  const iterator = body[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await waitStage(() => iterator.next(), signal);
      if (next.done) break;
      const piece = next.value;
      if (signal.aborted) throw deadline() ? new EgressRefusedError('timeout') : signal.reason;
      const chunk = typeof piece === 'string' ? Buffer.from(piece) : piece;
      if (total + chunk.length > max) {
        if (max > total) yield chunk.subarray(0, max - total);
        throw new EgressRefusedError('too_large');
      }
      total += chunk.length;
      yield chunk;
    }
  } catch (err) {
    if (err instanceof EgressRefusedError) throw err;
    if (signal.aborted && deadline()) throw new EgressRefusedError('timeout');
    throw err;
  } finally {
    // Do not let an adapter's stuck return() delay a deadline or cancellation.
    if (iterator.return) void Promise.resolve(iterator.return()).catch(() => undefined);
  }
}

/**
 * Sends one checked request and answers its bounded body.
 *
 * @throws {EgressRefusedError} For a refused destination, a redirect, an answer past the size bound or the deadline.
 */
export async function checkedRequest(input: CheckedRequestInput): Promise<CheckedResponse> {
  const { response, signal, deadline } = await open(input);
  const chunks: Buffer[] = [];
  for await (const chunk of bounded(response.body, input.policy.maxResponseBytes, signal, () => deadline.aborted)) chunks.push(chunk);
  return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) };
}

/**
 * Sends one checked request and answers its body as a stream, bounded in size as it is read and by the deadline.
 *
 * @throws {EgressRefusedError} For a refused destination or a redirect; the stream throws past the bounds.
 */
export async function checkedStream(input: CheckedRequestInput): Promise<CheckedStreamResponse> {
  const { response, signal, deadline } = await open(input);
  return { status: response.status, headers: response.headers, body: bounded(response.body, input.policy.maxResponseBytes, signal, () => deadline.aborted) };
}
