import type { TranscriptInput } from '../../../voice-pipeline/types.js';
import type { MeetingEvent, MeetingEventType, MeetingPlatform, MeetingRunRecord, MeetingRunState, SupplierUsage, TranscriptTurn } from '../types.js';

/** Thrown by a store that refuses content for a run behind the fence. */
export class FencedError extends Error {
  /** @param runId - The run whose content was refused. */
  constructor(readonly runId: string) {
    super(`run ${runId} is being purged; no content is accepted`);
    this.name = 'FencedError';
  }
}

/** Thrown by {@link IRunStore.insert} when the owner already has a run with the idempotency key: a send that loses that race answers the run the key has ({@link IRunStore.findByIdempotencyKey}). */
export class DuplicateIdempotencyKeyError extends Error {
  /**
   * @param ownerRef - The owner the key belongs to.
   * @param idempotencyKey - The key the owner already has a run with.
   */
  constructor(readonly ownerRef: string, readonly idempotencyKey: string) {
    super(`the owner already has a run with idempotency key ${idempotencyKey}`);
    this.name = 'DuplicateIdempotencyKeyError';
  }
}

/** Which runs {@link IRunStore.list} returns: every condition given holds. */
export interface RunFilter {
  /** Only this owner's runs. */
  ownerRef?: string;
  /** Only runs in one of these states; an empty array applies no state filter. */
  states?: readonly MeetingRunState[];
  /** Only runs requested at or after this time, in milliseconds. */
  since?: number;
  /** At most this many runs; default 500, zero returns no rows. */
  limit?: number;
}

/**
 * The run's row. An implementation keeps every field of it, the manager's timers (`leaveCommandedAt`,
 * `captureSuspendedAt`, `aloneSince`) among them: the manager keeps nothing about a run in process. An implementation
 * seals `meetingUrl` at rest.
 */
export interface IRunStore {
  /** Optional whole-run eviction for in-memory hosts after terminal cleanup and the retention grace. Durable stores omit it to retain their records. Call only after producers have stopped; forgetting removes fences too. */
  forget?(runId: string): Promise<void>;
  /**
   * Adds a new run. A run id that exists is an error, and so is an idempotency key the owner already used: that insert
   * stores nothing and rejects with {@link DuplicateIdempotencyKeyError}, so of two sends racing with one key only one run
   * is made, and the other finds it with `findByIdempotencyKey`.
   */
  insert(run: MeetingRunRecord): Promise<void>;
  /** The run, or undefined when there is none. */
  get(runId: string): Promise<MeetingRunRecord | undefined>;
  /** Atomically re-reads the row, checks `expectState` and applies the patch; undefined on a mismatch. Postgres holds the shared run anchor and sets the content fence for a purge in the same transaction. In-memory comparison and update have no await between them. */
  update(runId: string, patch: Partial<MeetingRunRecord>, expectState?: MeetingRunState | readonly MeetingRunState[]): Promise<MeetingRunRecord | undefined>;
  /** Rewrites the whole row (the content-free form at the end of a purge). */
  replace(run: MeetingRunRecord): Promise<void>;
  /** The runs the filter selects, requestedAt descending, then runId ascending. Default limit 500; states: [] applies no state filter. */
  list(filter: RunFilter): Promise<MeetingRunRecord[]>;
  /** The run an owner sent with this idempotency key, if there is one (there is at most one: see `insert`). */
  findByIdempotencyKey(ownerRef: string, key: string): Promise<MeetingRunRecord | undefined>;
}

/** A run's dispatch job: when it is due, who holds its lease, and whether it was dispatched or cancelled. */
export interface MeetingJob {
  /** The run the job dispatches. */
  runId: string;
  /** When the job is due, in milliseconds. */
  dispatchAt: number;
  /** The manager instance holding the dispatch lease. */
  leaseHolder?: string;
  /** When the lease runs out, in milliseconds. */
  leaseExpiresAt?: number;
  /** The worker the provider dispatched to. */
  workerId?: string;
  /** Set when the dispatch was recorded. */
  dispatched: boolean;
  /** Set by a cancel. A cancelled job is never leased. */
  cancelled: boolean;
}

/** Delayed dispatch with leases. `lease` is atomic: two takers never hold one job. */
export interface IJobStore {
  /** Optional whole-run eviction for in-memory hosts after terminal cleanup and the retention grace. Durable stores omit it to retain their records. Call only after producers have stopped; forgetting removes fences too. */
  forget?(runId: string): Promise<void>;
  /** Adds the run's job, due at `dispatchAt`; for an existing job moves only dispatchAt, preserving the lease, worker, dispatched and cancelled fields. */
  schedule(job: { runId: string; dispatchAt: number }): Promise<void>;
  /** The next due, uncancelled, undispatched job whose lease is absent or expired, leased to `holder` until `now + ttlMs`. */
  lease(holder: string, now: number, ttlMs: number): Promise<MeetingJob | undefined>;
  /** Extends a lease the holder still holds; false when it expired or another holder took it, and then the holder must stop. */
  renew(runId: string, holder: string, now: number, ttlMs: number): Promise<boolean>;
  /**
   * Records the dispatch for the lease's holder and answers whether a cancel arrived meanwhile (then the dispatcher tells
   * the bot to leave at once). A dispatch can outlive its lease and another holder can take the job: when `holder` no
   * longer holds the lease, or the job is gone, nothing is recorded and `recorded` is false.
   */
  markDispatched(runId: string, holder: string, workerId: string | undefined): Promise<{ recorded: boolean; cancelled: boolean }>;
  /**
   * Releases the holder's lease without dispatching (the dispatch failed and will be retried), moving the job's due time
   * to `retryAt`. False, and nothing changes, when `holder` no longer holds the lease or the job is gone.
   */
  release(runId: string, holder: string, retryAt: number): Promise<boolean>;
  /** Marks the job cancelled. `already_dispatched` when the bot is out: the caller tells it to leave instead. A job under a live lease is cancelled too, and its dispatcher learns it from `markDispatched`. */
  cancel(runId: string): Promise<'cancelled' | 'already_dispatched' | 'missing'>;
  /** The run's job, or undefined when there is none. */
  get(runId: string): Promise<MeetingJob | undefined>;
  /** Every dispatched job: what reconciliation compares with the providers' usage. */
  listDispatched(): Promise<MeetingJob[]>;
  /** Deletes the run's job. */
  remove(runId: string): Promise<void>;
}

/** A run's transcript turns. Behind the fence it refuses new turns; a purge removes the turns and keeps the fence. */
export interface ITranscriptStore {
  /** Optional whole-run eviction for in-memory hosts after terminal cleanup and the retention grace. Durable stores omit it to retain their records. Call only after producers have stopped; forgetting removes fences too. */
  forget?(runId: string): Promise<void>;
  /** Adds an already numbered turn; a repeated (runId, seq) keeps the first copy. Rejects with {@link FencedError} once fenced. */
  append(turn: TranscriptTurn): Promise<void>;
  /** Assigns the next seq and turnId for this run and stores the turn atomically, under the same anchor as the fence. Continues after the largest stored or allocated seq across sink instances. Optional for existing store implementers; required by MeetingTranscriptSink, which checks it at construction. */
  appendNext?(turn: TranscriptInput): Promise<TranscriptTurn>;
  /** The run's turns after `fromSeq`, in order, at most `limit` of them. */
  read(runId: string, fromSeq: number, limit?: number): Promise<TranscriptTurn[]>;
  /** The fence: from now on the run takes no new turn. */
  fence(runId: string): Promise<void>;
  /** Whether the run is fenced. */
  isFenced(runId: string): Promise<boolean>;
  /** Removes the run's turns; the fence stays. */
  purge(runId: string): Promise<void>;
}

/** A run's events: stable ids, a sequence number per run, and payloads a purge removes. */
export interface IEventStore {
  /** Optional whole-run eviction for in-memory hosts after terminal cleanup and the retention grace. Durable stores omit it to retain their records. Call only after producers have stopped; forgetting removes fences too. */
  forget?(runId: string): Promise<void>;
  /** Inserts with the next sequence number of the run; a repeated `eventId` is not inserted and answers the existing sequence. Behind the fence a content event is stored without its payload, marked `purged`. */
  append(event: Omit<MeetingEvent, 'seq'>): Promise<{ inserted: boolean; seq: number }>;
  /** The run's events after `fromSeq`, in sequence order, at most `limit` of them. */
  read(runId: string, fromSeq: number, limit?: number): Promise<MeetingEvent[]>;
  /** The fence: from now on no payload of a content event is stored for the run. */
  fence(runId: string): Promise<void>;
  /** Removes the payload of every content event of the run; type, time and sequence stay. */
  purgePayloads(runId: string): Promise<void>;
}

/** One event's delivery to one destination. */
export interface OutboxDelivery {
  /** The delivery's id. */
  id: string;
  /** The run the event belongs to. */
  runId: string;
  /** The product's reference for where it goes (a webhook registration). */
  destinationRef: string;
  /** The event the delivery carries. */
  eventId: string;
  /** The event's type; `bot:purged` once a purge emptied the delivery. */
  type: MeetingEventType;
  /** The body to send; empty once a purge emptied the delivery. */
  payload: string;
  /** The failed attempts so far. */
  attempts: number;
  /** When the first failed attempt was recorded; a delivery still failing a day later is given up. */
  firstAttemptAt?: number;
  /** When the next attempt is due. */
  nextAt: number;
  /** `pending` until the destination takes it, or until it is given up as `dead`. */
  state: 'pending' | 'delivered' | 'dead';
  /** Set when a purge emptied the delivery. */
  purged: boolean;
}

/** Outbound deliveries: retried with backoff for a day, replayable, content-free after a purge. */
export interface IOutbox {
  /** Optional whole-run eviction for in-memory hosts after terminal cleanup and the retention grace. Durable stores omit it to retain their records. Call only after producers have stopped; forgetting removes fences too. */
  forget?(runId: string): Promise<void>;
  /**
   * Adds a pending delivery, due at `now`; a repeated id preserves the first delivery and its retry state. After `purgeContent` for the run, a delivery of a content event (a type in
   * `CONTENT_EVENT_TYPES`) is not stored: the purge is the outbox's fence. A delivery of any other type (`bot:left`,
   * `bot:purged`, `bot:done` and the rest) is stored.
   */
  enqueue(delivery: Pick<OutboxDelivery, 'id' | 'runId' | 'destinationRef' | 'eventId' | 'type' | 'payload'>, now: number): Promise<void>;
  /** Pending deliveries due at now, ordered by nextAt then id ascending; default limit 100. */
  due(now: number, limit?: number): Promise<OutboxDelivery[]>;
  /** Records that the destination took the delivery. */
  markDelivered(id: string): Promise<void>;
  /** Records a failed attempt: due again after the backoff of {@link nextAttemptAt}, or `dead` a day after the first failed attempt. A delivery that is no longer pending, delivered or dead, is left as it is. */
  markFailed(id: string, now: number): Promise<void>;
  /** Makes a delivery pending again, due at `now`, with its attempts counted afresh (a manual replay). */
  replay(id: string, now: number): Promise<void>;
  /**
   * Empties every content delivery of the run (a type in `CONTENT_EVENT_TYPES`), delivered ones included, so a replay
   * after a purge sends the content-free `bot:purged` in its place. A delivery of any other type (`bot:done`,
   * `bot:left` and the rest) carries no content and keeps its type and payload. From then on the run takes no content
   * delivery (see `enqueue`).
   */
  purgeContent(runId: string): Promise<void>;
  /** Every delivery of the run, whatever its state, ordered by nextAt then id ascending. */
  listByRun(runId: string): Promise<OutboxDelivery[]>;
  /**
   * Optional. Sends one delivery under the outbox's own guard: re-reads `candidate` (a row `due` returned, which a purge
   * may have emptied since) and, when it is still pending, calls `send` with the fresh row and a signal that a purge of
   * its run aborts. Answers true when `send` resolved, false when the delivery was skipped (gone, no longer pending, or
   * cancelled by a purge), and rejects with `send`'s error otherwise. `OutboxDispatcher` sends through it when an outbox
   * has it (`InMemoryOutbox` and `SqlOutbox` do), and sends the row `due` returned when it has not.
   */
  sendClaimed?(candidate: OutboxDelivery, send: (fresh: OutboxDelivery, signal: AbortSignal) => Promise<void>): Promise<boolean>;
}

/** A reservation's answer: its id and the seconds it covers, or why it was refused. */
export type ReserveResult =
  | { ok: true; reservationId: string; maxSeconds: number }
  | { ok: false; reason: 'allowance' | 'permission_denied'; message: string };

/**
 * The product's billing. The library reserves before a run exists, meters every minute, settles at the end, releases an
 * unbilled run. `settle` and `release` are idempotent per reservation: the manager retries them until they resolve, and a
 * repeated call after a success changes nothing.
 */
export interface IEntitlementHook {
  /** Optional whole-run eviction for in-memory hosts after terminal cleanup and the retention grace. Durable stores omit it to retain their records. Call only after producers have stopped; forgetting removes fences too. */
  forget?(runId: string): Promise<void>;
  /** Reserves at most `maxSeconds` for a run about to be made; the answer's `maxSeconds` is what it covers, and the run's limit is cut to it. A refusal sends no bot. */
  reserve(input: { ownerRef: string; runId: string; platform: MeetingPlatform; maxSeconds: number }): Promise<ReserveResult>;
  /** A scheduled run, at dispatch: still paid, still has the hours. */
  revalidate(reservationId: string): Promise<boolean>;
  /** The seconds the run has used so far, every minute: a running total, not an increment. */
  meter(reservationId: string, seconds: number): Promise<void>;
  /** Settles the run at the seconds it is billed. */
  settle(reservationId: string, billedSeconds: number): Promise<void>;
  /** Frees a reservation nothing is billed against: a run that ends unbilled, or a send refused after its reservation. */
  release(reservationId: string): Promise<void>;
  /**
   * Optional. Records what the run's supplier measured ({@link SupplierUsage}), apart from the seconds the owner is
   * billed: the cost the run incurred, settled whatever the owner's bill, an unbilled end included. The manager calls it
   * for every report that carries totals, before its terminal and fence checks, and for the totals a provider's usage
   * answers at reconciliation, so it may be called again with the same or older totals: keep the largest of each. A
   * rejection holds back no run (the report that carried the totals is applied, and a run whose worker is gone still
   * ends): the manager keeps the totals in its stores' `supplierUsageInbox`, when it has one, and calls again with them
   * at the next reconcile. Absent, nothing is recorded, and `meter`, `settle` and `release` behave as they do without it.
   */
  recordSupplierUsage?(reservationId: string, usage: SupplierUsage): Promise<void>;
}

/** The manager's clock; a test passes a fake. */
export interface IClock {
  /** The current time, in milliseconds. */
  now(): number;
}

/**
 * Backoff: 5 s, 10 s, 20 s ... up to an hour between attempts, dead a day after the first attempt.
 *
 * @param attempts - The failed attempts so far, the one just recorded included.
 * @param now - When that failure was recorded, in milliseconds.
 * @returns When the next attempt is due.
 */
export function nextAttemptAt(attempts: number, now: number): number {
  return now + Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}
/** How long after its first failed attempt a delivery is given up as `dead`: a day. */
export const OUTBOX_GIVE_UP_MS = 86_400_000;
