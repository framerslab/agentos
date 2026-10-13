/**
 * @module channels/meetings/delivery
 *
 * Sends the outbox's due deliveries to their destinations: each signed with the envelope under the host's header names,
 * posted over https to an address that resolves to public ranges alone, connected to the address that was checked,
 * never following a redirect, within a deadline. A 2xx marks a delivery delivered; anything else marks it failed for
 * the outbox's backoff. A purged delivery sends the content-free `bot:purged` body. One dispatcher runs per outbox:
 * `due()` takes no lease.
 */
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPublicAddress } from '../../../cognition/memory/io/ingestion/guardedFetch.js';
import { isPublicNetworkAddress, nat64PrefixesFrom } from '../../media/images/networkAddress.js';
import { DEFAULT_ENVELOPE_HEADERS, envelopeHeaders, type EnvelopeHeaderNames } from './signing.js';
import type { IClock, IOutbox, OutboxDelivery } from './stores/types.js';

/**
 * Whether an address, as text, is public: the library's one rule for an address a server must not let a stranger's
 * input reach. Loopback, private, link-local, carrier-grade NAT, unique-local, multicast, documentation, benchmarking,
 * reserved and unspecified addresses are not public, nor is an IPv6 address that carries such an IPv4 one (IPv4-mapped,
 * NAT64, 6to4), nor text that is not an address. It is the rule `guardedFetch` applies, re-exported as the rule
 * {@link httpsSend} holds at each delivery, so a host can check a destination's addresses when it is registered. A
 * network's own NAT64 prefix is not part of it: `httpsSend` reads those prefixes at the delivery, as `guardedFetch` does.
 */
export { isPublicAddress };

/** Thrown before any socket opens, for a destination that is not https or that resolves to a private address. */
export class DestinationRefusedError extends Error {
  /** @param message - Why the destination was refused; it names no address. */
  constructor(message: string) {
    super(message);
    this.name = 'DestinationRefusedError';
  }
}

/** A host name's addresses. */
export type AddressLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const systemLookup: AddressLookup = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

/** One delivery as the send makes it. */
export interface DeliveryRequest {
  /** The destination's https url. */
  url: string;
  /** The envelope's headers; {@link httpsSend} adds the content type and length. */
  headers: Record<string, string>;
  /** The body, exactly as it was signed. */
  body: string;
  /** The deadline over the whole post, in milliseconds. */
  timeoutMs: number;
  /** A fence aborts DNS-waiting and socket-waiting sends. Custom senders must honor it before writing bytes. */
  signal?: AbortSignal;
}

/** Posts one delivery and answers its status; throws for a refused destination or a failed connection. */
export type DeliverySend = (request: DeliveryRequest) => Promise<{ status: number }>;

/** A destination as the host resolves it: where it posts and the secret it signs with. */
export interface DeliveryDestination {
  /** Where deliveries are posted: an https url. */
  url: string;
  /** The destination's nonempty secret, which {@link envelopeHeaders} signs each delivery with. */
  secret: string;
}

/**
 * The default send: https only, no credentials in the address, every resolved address public, the connection made to
 * the first of them (the request's `lookup` answers it, so a second resolution cannot move the connection), no redirect
 * followed, the answer's body read and dropped. An IPv6 address is also checked under the network's own NAT64
 * prefixes, as `guardedFetch` checks it: they are read (RFC 7050) from the IPv6 addresses `lookup` gives for
 * `ipv4only.arpa`, a name with IPv4 addresses only, when such an address comes up, and a send whose prefixes cannot be
 * read fails without connecting.
 *
 * @param options - `lookup`, a host name's addresses; the system resolver when absent.
 */
export function httpsSend(options: { lookup?: AddressLookup } = {}): DeliverySend {
  const resolveAll = options.lookup ?? systemLookup;
  return async ({ url, headers, body, timeoutMs, signal }) => {
    signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    signal?.throwIfAborted();
    const target = new URL(url);
    if (target.protocol !== 'https:') throw new DestinationRefusedError('a destination is https');
    if (target.username || target.password) throw new DestinationRefusedError('a destination carries no credentials');
    // a lookup cannot be cancelled: the wait for it ends at the signal, while the lookup runs on
    const lookup = (name: string): Promise<Array<{ address: string; family: number }>> =>
      new Promise((resolve, reject) => {
        const cancelled = (): void => reject(signal?.reason);
        signal?.addEventListener('abort', cancelled, { once: true });
        void resolveAll(name).then(resolve, reject).finally(() => signal?.removeEventListener('abort', cancelled));
      });
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const literal = isIP(host);
    const addresses = literal ? [{ address: host, family: literal }] : await lookup(host);
    signal?.throwIfAborted();
    if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
      throw new DestinationRefusedError('the destination resolves to a private address');
    }
    // A public-looking IPv6 address can carry a private IPv4 one under a NAT64 prefix of this network, which a DNS64
    // resolver writes into the answer for a name with IPv4 addresses only; the NAT64 gateway connects to that IPv4 one.
    const overIPv6 = addresses.filter((a) => isIP(a.address) === 6);
    if (overIPv6.length > 0) {
      const known = await lookup('ipv4only.arpa').catch((): undefined => undefined);
      signal?.throwIfAborted();
      if (known === undefined) throw new Error("the network's NAT64 prefixes could not be read, so the destination's IPv6 address cannot be cleared");
      const nat64Prefixes = nat64PrefixesFrom(known.map((a) => a.address).filter((address) => isIP(address) === 6));
      if (!overIPv6.every((a) => isPublicNetworkAddress(a.address, { nat64Prefixes }))) {
        throw new DestinationRefusedError('the destination resolves to a private address');
      }
    }
    const chosen = addresses[0]!;
    const pinned = ((_hostname: string, lookupOptions: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
      if (lookupOptions?.all) callback(null, [{ address: chosen.address, family: chosen.family }]);
      else callback(null, chosen.address, chosen.family);
    }) as unknown as LookupFunction;
    return new Promise<{ status: number }>((resolve, reject) => {
      const req = httpsRequest(
        target,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
          lookup: pinned,
          // A connection of its own: a pooled keep-alive socket for the same host and port may have been opened to an
          // address this check never saw, and a reused socket never asks `lookup`.
          agent: false,
          timeout: timeoutMs,
          signal,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
          res.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('the delivery timed out')));
      req.on('error', reject);
      if (signal?.aborted) req.destroy(new Error('delivery cancelled'));
      else req.end(body);
    });
  };
}

/** What an {@link OutboxDispatcher} sends from, where to, and how. */
export interface OutboxDispatcherOptions {
  /** The outbox whose due deliveries it sends; one dispatcher per outbox. */
  outbox: IOutbox;
  /** A delivery's destination by its `destinationRef`, or undefined when the host no longer holds it. */
  resolve: (destinationRef: string) => Promise<DeliveryDestination | undefined>;
  /** How each delivery is posted; {@link httpsSend} when absent. */
  send?: DeliverySend;
  /** The envelope's header names; the library's defaults when absent. */
  names?: EnvelopeHeaderNames;
  /** What is due, and the envelope's timestamp, by this clock; the wall clock when absent. */
  clock?: IClock;
  /** Deliveries a pass takes. Default 50. */
  batch?: number;
  /** Each post's deadline. Default 10000. */
  timeoutMs?: number;
  /** Told a failed delivery's id and the error's name, never its body, its url or its secret. */
  logger?: { warn(msg: string): void };
}

/** Sends what the outbox holds due. */
export class OutboxDispatcher {
  private readonly send: DeliverySend;

  /** @param options - The outbox, the destinations and the send: {@link OutboxDispatcherOptions}. */
  constructor(private readonly options: OutboxDispatcherOptions) {
    this.send = options.send ?? httpsSend();
  }

  private now(): number {
    return this.options.clock?.now() ?? Date.now();
  }

  /** A delivery's destination; undefined when the host no longer holds it, or when `resolve` rejects, which is logged. */
  private async destinationOf(d: OutboxDelivery): Promise<DeliveryDestination | undefined> {
    try {
      return await this.options.resolve(d.destinationRef);
    } catch (err) {
      // a lookup that fails (the host's store out of reach, say) fails this delivery for its backoff, not the whole pass
      this.options.logger?.warn(`[OutboxDispatcher] ${d.id}: ${err instanceof Error ? err.name : 'error'}`);
      return undefined;
    }
  }

  /**
   * One pass over the due deliveries; answers how many were delivered and how many failed. A delivery whose destination
   * `resolve` does not give, or rejects for, is marked failed, and the pass goes on. When the outbox has `sendClaimed`,
   * each delivery is sent through it, and one it skips (gone, no longer pending, or cancelled by a purge) counts as
   * neither.
   */
  async deliverDue(): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    for (const d of await this.options.outbox.due(this.now(), this.options.batch ?? 50)) {
      const destination = await this.destinationOf(d);
      if (!destination) {
        await this.options.outbox.markFailed(d.id, this.now());
        failed += 1;
        continue;
      }
      try {
        const deliver = async (fresh: typeof d, signal: AbortSignal): Promise<void> => {
          signal.throwIfAborted();
          const body = fresh.purged || fresh.type === 'bot:purged' ? JSON.stringify({ id: fresh.eventId, type: 'bot:purged', runId: fresh.runId }) : fresh.payload;
          const { status } = await this.send({
            url: destination.url,
            headers: envelopeHeaders(destination.secret, fresh.id, this.now(), body, this.options.names ?? DEFAULT_ENVELOPE_HEADERS),
            body, timeoutMs: this.options.timeoutMs ?? 10_000, signal,
          });
          signal.throwIfAborted();
          if (status < 200 || status >= 300) throw new Error('delivery refused');
          await this.options.outbox.markDelivered(fresh.id);
        };
        const claimed = this.options.outbox.sendClaimed;
        if (claimed) {
          if (await claimed.call(this.options.outbox, d, deliver)) delivered += 1;
        } else {
          await deliver(d, new AbortController().signal);
          delivered += 1;
        }
        continue;
      } catch (err) {
        this.options.logger?.warn(`[OutboxDispatcher] ${d.id}: ${err instanceof Error ? err.name : 'error'}`);
      }
      await this.options.outbox.markFailed(d.id, this.now());
      failed += 1;
    }
    return { delivered, failed };
  }
}
