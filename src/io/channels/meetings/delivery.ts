/**
 * @module channels/meetings/delivery
 *
 * Sends the outbox's due deliveries to their destinations: each signed with the envelope under the host's header names,
 * posted through the checked egress module's hosted profile (https on 443 to a name whose every address is public,
 * connected to the address that was checked), never following a redirect, within a deadline. A 2xx marks a delivery
 * delivered; anything else marks it failed for the outbox's backoff. A delivery a purge emptied, or one stored empty
 * behind the fence, sends the content-free `bot:purged` body; the manager's own `bot:purged` event, stored whole, also
 * sends its time, its sequence and its reason. One dispatcher runs per outbox: `due()` takes no lease.
 */
import { EgressRefusedError, checkedRequest, hostedEgressPolicy, type AddressLookup } from '../../../safety/egress/CheckedEgress.js';
import { isPublicAddress } from '../../../safety/egress/addresses.js';
import { DEFAULT_ENVELOPE_HEADERS, envelopeHeaders, type EnvelopeHeaderNames } from './signing.js';
import { OUTBOX_GIVE_UP_MS, type IClock, type IOutbox, type OutboxDelivery } from './stores/types.js';

/**
 * Whether an address, as text, is public: the checked egress module's rule, kept here under its first name, which
 * {@link httpsSend} holds at each delivery, so a host can check a destination's addresses when it is registered. It
 * refuses every block of IANA's IPv4 and IPv6 special-purpose registries, multicast, the IPv6 space outside 2000::/3,
 * every IPv4-mapped or translated IPv6 form whatever IPv4 address it carries, and text that is not an address. A
 * network's own NAT64 prefixes are not part of it: `httpsSend` reads those prefixes at the delivery.
 */
export { isPublicAddress };

/**
 * Thrown before any socket opens, for a destination the checked egress module's hosted profile refuses: not https on
 * port 443, credentials or an address literal in the url, an address that is not public, or a name whose addresses
 * cannot be read and cleared.
 */
export class DestinationRefusedError extends Error {
  /** @param message - Why the destination was refused; it names no address. */
  constructor(message: string) {
    super(message);
    this.name = 'DestinationRefusedError';
  }
}

/** A host name's addresses: the checked egress module's lookup, which may be given the request's signal. */
export type { AddressLookup };

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

/** What a host's mail send answers for one mail delivery. */
export type MailOutcome =
  | { outcome: 'sent' }
  /** A refusal no retry can change: the delivery ends dead. */
  | { outcome: 'dead' }
  /** The destination may have acted but never answered (a sender that takes no idempotency key): the delivery ends dead, never tried again, and the warning says `unknown`, so the host looks before it sends again. */
  | { outcome: 'unknown' }
  /** A failure of the moment: the outbox's backoff. */
  | { outcome: 'retry' }
  /** A cap that holds the mail: the delivery's next attempt moves to `notBefore` and no attempt is counted. */
  | { outcome: 'hold'; notBefore: number };

/** Sends one mail delivery as the host does (the unseal, its checks, the send) and answers its outcome; a throw counts as `retry`. */
export type MailSend = (delivery: OutboxDelivery, signal: AbortSignal) => Promise<MailOutcome>;

/**
 * The default send: the checked egress module's hosted profile (https on 443 to a name whose every address is public,
 * the connection its own and pinned to the checked address, TLS validating the name), no redirect followed (a 3xx is
 * answered as it is, and the dispatcher marks it failed), the answer read within the profile's 1 MiB bound and dropped,
 * all within the request's deadline and its signal. An IPv6 address is also checked under the network's own NAT64
 * prefixes, read (RFC 7050) from the IPv6 addresses `lookup` gives for `ipv4only.arpa`, and one under them is refused;
 * a send whose prefixes cannot be read fails without connecting.
 *
 * @param options - `lookup`, a host name's addresses; the system resolver when absent.
 */
export function httpsSend(options: { lookup?: AddressLookup } = {}): DeliverySend {
  return async ({ url, headers, body, timeoutMs, signal }) => {
    try {
      const answer = await checkedRequest({
        url,
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body,
        policy: hostedEgressPolicy({ timeoutMs }),
        signal,
        lookup: options.lookup,
        onRedirect: 'return',
      });
      return { status: answer.status };
    } catch (err) {
      // a destination refused before any byte is sent keeps this module's error; a deadline or an oversized answer does not
      if (err instanceof EgressRefusedError && err.reason !== 'timeout' && err.reason !== 'too_large') throw new DestinationRefusedError(err.message);
      throw err;
    }
  };
}

/**
 * The body of a delivery a purge emptied, or one the fence stored empty: its event's id, `bot:purged` and the run's id.
 * The manager's own `bot:purged` event, which a plain outbox keeps whole, also sends the time, the sequence and the
 * reason it was stored with, as every other event's delivery does; nothing else of its payload goes out.
 */
function purgedBody(d: OutboxDelivery): string {
  const ids = { id: d.eventId, type: 'bot:purged', runId: d.runId };
  const own = d.purged ? undefined : storedPurgeFields(d.payload);
  return JSON.stringify(own ? { ...ids, ...own } : ids);
}

/** The time, the sequence and the reason of a payload that is a stored `bot:purged` event; undefined for any other. */
function storedPurgeFields(payload: string): { at: number; seq: number; data: { reason?: string } } | undefined {
  let stored: unknown;
  try {
    stored = JSON.parse(payload);
  } catch {
    // the empty payload of a delivery the fence stored
    return undefined;
  }
  if (typeof stored !== 'object' || stored === null) return undefined;
  const { type, at, seq, data } = stored as Record<string, unknown>;
  if (type !== 'bot:purged' || typeof at !== 'number' || typeof seq !== 'number') return undefined;
  const reason = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).reason : undefined;
  return { at, seq, data: typeof reason === 'string' ? { reason } : {} };
}

/** What an {@link OutboxDispatcher} sends from, where to, and how. */
export interface OutboxDispatcherOptions {
  /** The outbox whose due deliveries it sends; one dispatcher per outbox. */
  outbox: IOutbox;
  /** A delivery's destination by its `destinationRef`, or undefined when the host no longer holds it. */
  resolve: (destinationRef: string) => Promise<DeliveryDestination | undefined>;
  /** How each delivery is posted; {@link httpsSend} when absent. */
  send?: DeliverySend;
  /** Sends a delivery of kind `mail`; absent, such a delivery fails for its backoff and the warning names it. With it, the outbox needs `markDead`, so an `unknown` outcome can end its delivery rather than retry a send the destination may have made. */
  mail?: MailSend;
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
    if (options.mail !== undefined && typeof options.outbox.markDead !== 'function') throw new TypeError('OutboxDispatcher: a mail send needs an outbox with markDead, so an unknown outcome ends its delivery');
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
   * each delivery is sent through it, and one it skips (gone, no longer pending, being sent already, or cancelled by a
   * purge) counts as neither.
   */
  async deliverDue(): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    // an expired mail waits for no attempt: ended first, its body emptied, where the outbox can
    await this.options.outbox.endExpired?.(this.now());
    for (const d of await this.options.outbox.due(this.now(), this.options.batch ?? 50)) {
      if (d.kind === 'mail') {
        const outcome = await this.sendMail(d);
        if (outcome === 'delivered') delivered += 1;
        else if (outcome === 'failed') failed += 1;
        continue;
      }
      const destination = await this.destinationOf(d);
      if (!destination) {
        await this.options.outbox.markFailed(d.id, this.now());
        failed += 1;
        continue;
      }
      try {
        const deliver = async (fresh: typeof d, signal: AbortSignal): Promise<void> => {
          signal.throwIfAborted();
          const body = fresh.purged || fresh.type === 'bot:purged' ? purgedBody(fresh) : fresh.payload;
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

  /**
   * One mail delivery through the host's send, under the outbox's claim when it has one; the outcome recorded as the
   * host answered it (`dead` and `hold` through the outbox's own methods where it has them, else as a failed attempt).
   * Skipped when the claim found the delivery gone, no longer pending, being sent already or cancelled by a purge.
   */
  private async sendMail(d: OutboxDelivery): Promise<'delivered' | 'failed' | 'held' | 'skipped'> {
    const mail = this.options.mail;
    const outbox = this.options.outbox;
    if (!mail) {
      this.options.logger?.warn(`[OutboxDispatcher] ${d.id}: no mail send`);
      await outbox.markFailed(d.id, this.now());
      return 'failed';
    }
    // The outcome is recorded inside the claim, before it is released, so a second pass cannot take the row while a
    // durable record of this pass's send is still being written; a delivery that expired since `due` returned it is
    // ended without a send. Held on an object: an assignment inside the closure is not seen by a plain variable's narrowing.
    const held: { result: 'delivered' | 'failed' | 'held' } = { result: 'failed' };
    const deliver = async (fresh: OutboxDelivery, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (fresh.expiresAt !== undefined && this.now() >= fresh.expiresAt) {
        await this.endDead(fresh.id);
        held.result = 'failed';
        return;
      }
      const answer = await mail(fresh, signal);
      signal.throwIfAborted();
      held.result = await this.record(fresh, answer);
    };
    try {
      const claimed = outbox.sendClaimed;
      if (claimed) {
        if (!(await claimed.call(outbox, d, deliver))) return 'skipped';
      } else await deliver(d, new AbortController().signal);
    } catch (err) {
      this.options.logger?.warn(`[OutboxDispatcher] ${d.id}: ${err instanceof Error ? err.name : 'error'}`);
      await outbox.markFailed(d.id, this.now());
      return 'failed';
    }
    return held.result;
  }

  /** Records a mail's outcome: delivered, dead at once (a refusal, or an outcome never answered), held until a time, or a failed attempt for the backoff. */
  private async record(d: OutboxDelivery, answer: MailOutcome): Promise<'delivered' | 'failed' | 'held'> {
    const outbox = this.options.outbox;
    const id = d.id;
    switch (answer.outcome) {
      case 'sent':
        await outbox.markDelivered(id);
        return 'delivered';
      case 'dead':
        await this.endDead(id);
        return 'failed';
      case 'unknown': {
        // never a retry: the destination may have acted. Ended where the outbox can; where a wrapper's outbox cannot end
        // it, held until its expiry, which ends it; failed for the backoff only when it can do neither (and says so)
        this.options.logger?.warn(`[OutboxDispatcher] ${id}: outcome unknown`);
        if (outbox.markDead && (await outbox.markDead(id))) return 'failed';
        const until = d.expiresAt ?? this.now() + OUTBOX_GIVE_UP_MS;
        if (outbox.holdUntil && (await outbox.holdUntil(id, until))) {
          this.options.logger?.warn(`[OutboxDispatcher] ${id}: outcome unknown held until its expiry; the outbox cannot end a delivery`);
          return 'held';
        }
        this.options.logger?.warn(`[OutboxDispatcher] ${id}: outcome unknown and the outbox can neither end nor hold the delivery`);
        await outbox.markFailed(id, this.now());
        return 'failed';
      }
      case 'hold':
        if (!outbox.holdUntil || !(await outbox.holdUntil(id, answer.notBefore))) await outbox.markFailed(id, this.now());
        return 'held';
      default:
        await outbox.markFailed(id, this.now());
        return 'failed';
    }
  }

  /** Ends a delivery at once where the outbox can, else as a failed attempt. */
  private async endDead(id: string): Promise<void> {
    const outbox = this.options.outbox;
    if (!outbox.markDead || !(await outbox.markDead(id))) await outbox.markFailed(id, this.now());
  }
}
