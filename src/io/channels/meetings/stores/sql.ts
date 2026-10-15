import { inspect } from 'node:util';
import type { TranscriptInput } from '../../../voice-pipeline/types.js';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { assertMeetingFundingChange, CONTENT_EVENT_TYPES, type MeetingEvent, type MeetingRunRecord, type MeetingRunState, type TranscriptTurn } from '../types.js';
import type { SecretBox } from '../signing.js';
import { DuplicateIdempotencyKeyError, FencedError, nextAttemptAt, OUTBOX_GIVE_UP_MS, type IEventStore, type IJobStore, type IOutbox, type IRunStore, type ITranscriptStore, type MeetingJob, type OutboxDelivery, type OutboxEnqueue, type RunFilter } from './types.js';
import { abortClaimedSends, runClaimedSend, type ClaimedSends } from './claims.js';
import type { DeliveryFence } from './fenced-outbox.js';

/** Default prefix for all meeting tables and indexes. */
export const DEFAULT_TABLE_PREFIX = 'agentos_meeting';
/** A lower-case letter then at most 37 lower-case letters, digits or underscores: `idx_<prefix>_events_id` stays within 63 bytes. */
const TABLE_PREFIX = /^[a-z][a-z0-9_]{0,37}$/;

/** Validated names for one set of durable meeting stores. */
export interface MeetingStoreTables {
  /** Run records, with sealed meeting URLs. */
  runs: string;
  /** Dispatch jobs and their leases. */
  jobs: string;
  /** Numbered transcript turns. */
  turns: string;
  /** Numbered events with globally unique event ids. */
  events: string;
  /** Outbound deliveries and retry state. */
  outbox: string;
  /** One row per run: the row every content write of the run locks, the event and turn counters, the content fence and the deliveries' fence. */
  locks: string;
}

/** Builds the table names, rejecting a prefix outside the identifier length and character bounds. */
export function meetingStoreTables(tablePrefix: string = DEFAULT_TABLE_PREFIX): MeetingStoreTables {
  if (!TABLE_PREFIX.test(tablePrefix)) throw new Error(`A meeting store's tablePrefix is a lower-case letter and at most 37 more lower-case letters, digits or underscores; got ${JSON.stringify(tablePrefix)}.`);
  return { runs: `${tablePrefix}_runs`, jobs: `${tablePrefix}_jobs`, turns: `${tablePrefix}_turns`, events: `${tablePrefix}_events`, outbox: `${tablePrefix}_outbox`, locks: `${tablePrefix}_run_locks` };
}

/**
 * The six tables and their indexes under one prefix. A product copies this text into its migration. It makes missing
 * tables and indexes only: tables an earlier version made take {@link meetingStoresUpgradeDdl}.
 */
export function meetingStoresDdl(tablePrefix: string = DEFAULT_TABLE_PREFIX): string {
  const t = meetingStoreTables(tablePrefix);
  const p = tablePrefix;
  return `
CREATE TABLE IF NOT EXISTS ${t.runs} (
  run_id TEXT PRIMARY KEY,
  owner_ref TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  provider_connection_ref TEXT,
  platform TEXT NOT NULL,
  state TEXT NOT NULL,
  keep TEXT NOT NULL,
  meeting_url TEXT NOT NULL,
  bot_name TEXT NOT NULL,
  notice_text TEXT NOT NULL,
  notice_version TEXT NOT NULL,
  notice_late_text TEXT NOT NULL,
  stop_phrase TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  idempotency_key TEXT,
  transcriber TEXT,
  requested_at BIGINT NOT NULL,
  join_at BIGINT NOT NULL,
  dispatched_at BIGINT,
  joined_at BIGINT,
  notice_posted_at BIGINT,
  capture_started_at BIGINT,
  left_at BIGINT,
  done_at BIGINT,
  reason TEXT,
  billed_seconds INTEGER NOT NULL DEFAULT 0,
  reservation_id TEXT,
  consent_record_id TEXT,
  dispatch_json TEXT,
  page_seen_at BIGINT,
  last_usage_at BIGINT,
  monitor_seen_at BIGINT,
  participant_count INTEGER,
  leave_commanded_at BIGINT,
  capture_suspended_at BIGINT,
  alone_since BIGINT,
  reported_seconds INTEGER,
  cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE,
  purged_at BIGINT,
  last_report_at BIGINT,
  last_usage_source_at BIGINT,
  creation_pending BOOLEAN NOT NULL DEFAULT FALSE,
  creation_context TEXT,
  funding_json TEXT,
  funding_reservation_id TEXT,
  funding_settlement_json TEXT,
  funding_cleanup_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${p}_runs_idem ON ${t.runs} (owner_ref, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_${p}_runs_owner ON ${t.runs} (owner_ref, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_${p}_runs_state ON ${t.runs} (state);
CREATE TABLE IF NOT EXISTS ${t.jobs} (
  run_id TEXT PRIMARY KEY,
  dispatch_at BIGINT NOT NULL,
  lease_holder TEXT,
  lease_expires_at BIGINT,
  worker_id TEXT,
  dispatched BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_${p}_jobs_due ON ${t.jobs} (dispatch_at) WHERE NOT dispatched AND NOT cancelled;
CREATE TABLE IF NOT EXISTS ${t.locks} (
  run_id TEXT PRIMARY KEY,
  event_seq INTEGER NOT NULL DEFAULT 0,
  turn_seq INTEGER NOT NULL DEFAULT 0,
  fenced_at BIGINT,
  outbox_fenced_at BIGINT
);
CREATE TABLE IF NOT EXISTS ${t.turns} (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  at BIGINT NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT,
  start_ms INTEGER,
  end_ms INTEGER,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS ${t.events} (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at BIGINT NOT NULL,
  data_json TEXT,
  purged BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (run_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${p}_events_id ON ${t.events} (event_id);
CREATE TABLE IF NOT EXISTS ${t.outbox} (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at BIGINT,
  next_at BIGINT NOT NULL,
  state TEXT NOT NULL,
  purged BOOLEAN NOT NULL DEFAULT FALSE,
  kind TEXT NOT NULL DEFAULT 'event',
  expires_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_${p}_outbox_due ON ${t.outbox} (next_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_${p}_outbox_run ON ${t.outbox} (run_id);
CREATE INDEX IF NOT EXISTS idx_${p}_funding_pending ON ${t.runs} (run_id)
WHERE funding_cleanup_json IS NOT NULL AND (funding_cleanup_json::jsonb->>'complete') = 'false';
`;
}

/** Schema under {@link DEFAULT_TABLE_PREFIX}; apply it before constructing the stores. */
export const MEETING_STORES_DDL = meetingStoresDdl();

/**
 * The upgrade that brings tables an earlier version's {@link meetingStoresDdl} made to this version's columns: one
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for each column of the runs and run-lock tables that such tables may lack,
 * each made as the fresh schema makes it, then the partial index the funding scan reads. Applied twice, or to tables this
 * version made, it changes nothing. The stores read and write every column, so a host runs it in its migration, in one
 * transaction (`db.transaction((tx) => tx.exec(meetingStoresUpgradeDdl(prefix)))`), before it constructs them.
 *
 * @param tablePrefix - The prefix the tables were made under.
 * @throws Error, the one {@link meetingStoreTables} throws, when the prefix is not a lower-case letter followed by at
 * most 37 lower-case letters, digits or underscores; no SQL is built.
 */
export function meetingStoresUpgradeDdl(tablePrefix: string = DEFAULT_TABLE_PREFIX): string {
  const t = meetingStoreTables(tablePrefix);
  return `
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS provider_connection_ref TEXT;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS leave_commanded_at BIGINT;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS capture_suspended_at BIGINT;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS alone_since BIGINT;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS last_report_at BIGINT;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS last_usage_source_at BIGINT;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS creation_pending BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS creation_context TEXT;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS funding_json TEXT;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS funding_reservation_id TEXT;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS funding_settlement_json TEXT;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS funding_cleanup_json TEXT;
ALTER TABLE ${t.locks} ADD COLUMN IF NOT EXISTS turn_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${t.locks} ADD COLUMN IF NOT EXISTS outbox_fenced_at BIGINT;
ALTER TABLE ${t.outbox} ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'event';
ALTER TABLE ${t.outbox} ADD COLUMN IF NOT EXISTS expires_at BIGINT;
CREATE INDEX IF NOT EXISTS idx_${tablePrefix}_funding_pending ON ${t.runs} (run_id)
WHERE funding_cleanup_json IS NOT NULL AND (funding_cleanup_json::jsonb->>'complete') = 'false';
`;
}

/**
 * Idempotently upgrades existing meeting stores, including the prepared-creation prerequisite. It composes
 * {@link meetingStoresUpgradeDdl}, then adds the funding columns and the funding scan's partial index again, each guarded
 * by `IF NOT EXISTS`, so tables an earlier version made, or tables this version made, end with the fresh schema's columns
 * and that index. A host applies it in its migration, in one transaction, before it constructs the stores.
 *
 * @param tablePrefix - The prefix the tables were made under.
 * @throws Error, the one {@link meetingStoreTables} throws, when the prefix is not a lower-case letter followed by at
 * most 37 lower-case letters, digits or underscores; no SQL is built.
 */
export function meetingFundingUpgradeDdl(tablePrefix: string = DEFAULT_TABLE_PREFIX): string {
  const t = meetingStoreTables(tablePrefix);
  return `${meetingStoresUpgradeDdl(tablePrefix)}
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS funding_json TEXT;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS funding_reservation_id TEXT;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS funding_settlement_json TEXT;
ALTER TABLE ${t.runs} ADD COLUMN IF NOT EXISTS funding_cleanup_json TEXT;
CREATE INDEX IF NOT EXISTS idx_${tablePrefix}_funding_pending ON ${t.runs} (run_id)
WHERE funding_cleanup_json IS NOT NULL AND (funding_cleanup_json::jsonb->>'complete') = 'false';
`;
}

/** Connection and table names shared by all five stores for a run. */
export interface SqlStoreOptions {
  /** Open Postgres adapter supporting transactions, persistence and concurrent access. */
  db: StorageAdapter;
  /** Prefix of an applied {@link meetingStoresDdl} schema, or one an earlier version made that {@link meetingStoresUpgradeDdl} brought up to date. */
  tablePrefix?: string;
}

/** These stores are Postgres stores: `FOR UPDATE SKIP LOCKED`, `ON CONFLICT ... RETURNING` and the row lock an upsert takes are what they rest on. */
function checkPostgres(db: StorageAdapter, what: string): void {
  if (!/postgres/i.test(db.kind)) throw new Error(`${what} is a Postgres store; "${db.kind}" is not Postgres.`);
  const caps = db.capabilities;
  if (!(caps.has('transactions') && caps.has('persistence') && caps.has('concurrent'))) {
    throw new Error(`${what} needs a store several processes share (transactions, persistence and concurrent access); "${db.kind}" lacks one.`);
  }
}

const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : typeof v === 'number' ? v : Number(v));
/** A turn's bound for its INTEGER column: whole milliseconds, rounded (a transcriber's clock, moved by a reconnect, can give fractions), or null. */
const wholeMs = (v: number | undefined): number | null => (v === undefined || !Number.isFinite(v) ? null : Math.round(v));
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 't' || v === 'true';

/**
 * Takes the run's anchor row for the rest of the transaction (an upsert locks the row it touches, so every content write
 * of one run runs after the one before it) and answers the fence. The row is made on first use.
 */
async function lockRun(trx: StorageAdapter, locks: string, runId: string): Promise<{ fencedAt: number | undefined; eventSeq: number }> {
  const row = await trx.get<{ fenced_at: unknown; event_seq: unknown }>(
    `INSERT INTO ${locks} (run_id) VALUES (?) ON CONFLICT (run_id) DO UPDATE SET run_id = EXCLUDED.run_id RETURNING fenced_at, event_seq`,
    [runId]
  );
  return { fencedAt: num(row?.fenced_at), eventSeq: num(row?.event_seq) ?? 0 };
}

async function fenceRun(db: StorageAdapter, locks: string, runId: string, now: number): Promise<void> {
  await db.run(`INSERT INTO ${locks} (run_id, fenced_at) VALUES (?, ?) ON CONFLICT (run_id) DO UPDATE SET fenced_at = COALESCE(${locks}.fenced_at, EXCLUDED.fenced_at)`, [runId, now]);
}

/**
 * The authenticated context a run's sealed creation context is bound to: the run and the column, so the sealed text
 * opens neither in another run's row nor in the place of the meeting url, which is bound to the run id alone.
 */
const creationContextAad = (runId: string): string => `creation_context:${runId}`;

/** Run storage options, including the host's meeting URL sealing key. */
export interface SqlRunStoreOptions extends SqlStoreOptions {
  /** Seals `meetingUrl` and `creationContext` at rest. */
  box: SecretBox;
}

/** Durable run records with sealed URLs and creation contexts, and expected-state updates under the run anchor. */
export class SqlRunStore implements IRunStore {
  private readonly t: MeetingStoreTables;
  /** Checks the adapter capabilities and prefix; the caller applies the exported DDL. */
  constructor(private readonly opts: SqlRunStoreOptions) {
    checkPostgres(opts.db, 'SqlRunStore');
    this.t = meetingStoreTables(opts.tablePrefix);
  }
  /** What `util.inspect`, and so `console.log`, prints: a redacted marker, neither the box nor the database's options. */
  [inspect.custom](): string {
    return '[SqlRunStore redacted]';
  }
  /** Serialises no options, database or box; persistence uses only the explicit row fields. */
  toJSON(): string {
    return '[SqlRunStore redacted]';
  }
  private static readonly COLUMNS = 'run_id, owner_ref, provider_name, platform, state, keep, meeting_url, bot_name, notice_text, notice_version, notice_late_text, stop_phrase, limits_json, idempotency_key, transcriber, requested_at, join_at, dispatched_at, joined_at, notice_posted_at, capture_started_at, left_at, done_at, reason, billed_seconds, reservation_id, consent_record_id, dispatch_json, page_seen_at, last_usage_at, monitor_seen_at, participant_count, leave_commanded_at, capture_suspended_at, alone_since, reported_seconds, cleanup_pending, purged_at, provider_connection_ref, last_report_at, last_usage_source_at, creation_pending, creation_context, funding_json, funding_reservation_id, funding_settlement_json, funding_cleanup_json';
  private row(run: MeetingRunRecord): unknown[] {
    return [run.runId, run.ownerRef, run.providerName, run.platform, run.state, run.keep, run.meetingUrl === '' ? '' : this.opts.box.seal(run.meetingUrl, run.runId), run.botName, run.notice.text, run.notice.version, run.notice.lateArrivalText, run.stopPhrase, JSON.stringify(run.limits), run.idempotencyKey ?? null, run.transcriber ?? null, run.requestedAt, run.joinAt, run.dispatchedAt ?? null, run.joinedAt ?? null, run.noticePostedAt ?? null, run.captureStartedAt ?? null, run.leftAt ?? null, run.doneAt ?? null, run.reason ?? null, run.billedSeconds, run.reservationId ?? null, run.consentRecordId ?? null, run.dispatch ? JSON.stringify(run.dispatch) : null, run.pageSeenAt ?? null, run.lastUsageAt ?? null, run.monitorSeenAt ?? null, run.participantCount ?? null, run.leaveCommandedAt ?? null, run.captureSuspendedAt ?? null, run.aloneSince ?? null, run.reportedSeconds ?? null, run.cleanupPending ?? false, run.purgedAt ?? null, run.providerConnectionRef ?? null, run.lastReportAt ?? null, run.lastUsageSourceAt ?? null, run.creationPending ?? false, run.creationContext === undefined ? null : this.opts.box.seal(run.creationContext, creationContextAad(run.runId)), run.funding === undefined ? null : JSON.stringify(run.funding), run.fundingReservationId ?? null, run.fundingSettlement === undefined ? null : JSON.stringify(run.fundingSettlement), run.fundingCleanup === undefined ? null : JSON.stringify(run.fundingCleanup)];
  }
  private fromRow(r: Record<string, unknown>): MeetingRunRecord {
    const sealed = String(r.meeting_url ?? '');
    const run: MeetingRunRecord = {
      runId: String(r.run_id), ownerRef: String(r.owner_ref), providerName: String(r.provider_name), platform: r.platform as MeetingRunRecord['platform'], state: r.state as MeetingRunState, keep: r.keep as MeetingRunRecord['keep'],
      meetingUrl: sealed === '' ? '' : this.opts.box.open(sealed, String(r.run_id)), botName: String(r.bot_name), notice: { text: String(r.notice_text), version: String(r.notice_version), lateArrivalText: String(r.notice_late_text) }, stopPhrase: String(r.stop_phrase),
      limits: JSON.parse(String(r.limits_json)), requestedAt: num(r.requested_at)!, joinAt: num(r.join_at)!, billedSeconds: num(r.billed_seconds) ?? 0,
    };
    const opt = <K extends keyof MeetingRunRecord>(key: K, value: MeetingRunRecord[K] | undefined | null): void => { if (value !== undefined && value !== null) run[key] = value; };
    opt('idempotencyKey', r.idempotency_key as string | null); opt('transcriber', r.transcriber as string | null); opt('dispatchedAt', num(r.dispatched_at)); opt('joinedAt', num(r.joined_at)); opt('noticePostedAt', num(r.notice_posted_at)); opt('captureStartedAt', num(r.capture_started_at)); opt('leftAt', num(r.left_at)); opt('doneAt', num(r.done_at)); opt('reason', r.reason as MeetingRunRecord['reason'] | null); opt('reservationId', r.reservation_id as string | null); opt('consentRecordId', r.consent_record_id as string | null); opt('dispatch', r.dispatch_json ? JSON.parse(String(r.dispatch_json)) : undefined); opt('pageSeenAt', num(r.page_seen_at)); opt('lastUsageAt', num(r.last_usage_at)); opt('monitorSeenAt', num(r.monitor_seen_at)); opt('participantCount', num(r.participant_count)); opt('leaveCommandedAt', num(r.leave_commanded_at)); opt('captureSuspendedAt', num(r.capture_suspended_at)); opt('aloneSince', num(r.alone_since)); opt('reportedSeconds', num(r.reported_seconds)); opt('purgedAt', num(r.purged_at)); opt('lastReportAt', num(r.last_report_at)); opt('lastUsageSourceAt', num(r.last_usage_source_at));
    if (bool(r.cleanup_pending)) run.cleanupPending = true;
    opt('providerConnectionRef', r.provider_connection_ref as string | null);
    run.creationPending = bool(r.creation_pending);
    opt('creationContext', r.creation_context ? this.opts.box.open(String(r.creation_context), creationContextAad(run.runId)) : undefined);
    opt('funding', r.funding_json === null || r.funding_json === undefined ? undefined : JSON.parse(String(r.funding_json)));
    opt('fundingReservationId', r.funding_reservation_id as string | null);
    opt('fundingSettlement', r.funding_settlement_json === null || r.funding_settlement_json === undefined ? undefined : JSON.parse(String(r.funding_settlement_json)));
    opt('fundingCleanup', r.funding_cleanup_json === null || r.funding_cleanup_json === undefined ? undefined : JSON.parse(String(r.funding_cleanup_json)));
    // a row whose funding is corrupt or incomplete fails closed on every read
    assertMeetingFundingChange(undefined, run);
    return run;
  }
  /** Inserts a run, its funding snapshot validated first when it has one, retaining the existing idempotency conflict contract. */
  async insert(run: MeetingRunRecord): Promise<void> {
    const next = structuredClone(run); assertMeetingFundingChange(undefined, next);
    const marks = SqlRunStore.COLUMNS.split(', ').map(() => '?').join(', ');
    try {
      await this.opts.db.transaction(async (trx) => {
        await lockRun(trx, this.t.locks, next.runId);
        await trx.run(`INSERT INTO ${this.t.runs} (${SqlRunStore.COLUMNS}) VALUES (${marks})`, this.row(next));
      });
    } catch (err) {
      const conflict = err as { code?: string; constraint?: string };
      const index = `idx_${this.opts.tablePrefix ?? DEFAULT_TABLE_PREFIX}_runs_idem`;
      if (conflict.code === '23505' && conflict.constraint === index && next.idempotencyKey !== undefined) throw new DuplicateIdempotencyKeyError(next.ownerRef, next.idempotencyKey);
      throw err;
    }
  }
  /** Reads a run, opening its URL with its run id as authenticated context, and its creation context with the run and its column. */
  async get(runId: string): Promise<MeetingRunRecord | undefined> {
    const r = await this.opts.db.get<Record<string, unknown>>(`SELECT * FROM ${this.t.runs} WHERE run_id = ?`, [runId]);
    return r ? this.fromRow(r) : undefined;
  }
  /** Patches under the shared anchor, setting the content fence atomically on entry to purging, and refuses changes to immutable funding fields. */
  async update(runId: string, patch: Partial<MeetingRunRecord>, expectState?: MeetingRunState | readonly MeetingRunState[]): Promise<MeetingRunRecord | undefined> {
    const captured = structuredClone(patch);
    return this.updateWith(runId, (current) => {
      if (expectState !== undefined) {
        const allowed = Array.isArray(expectState) ? expectState : [expectState as MeetingRunState];
        if (!allowed.includes(current.state)) return undefined;
      }
      return captured;
    });
  }
  /**
   * Re-reads the row under the anchor and writes the patch `patchFor` makes of it in the same transaction, setting the
   * content fence there too on entry to purging. A patch that would change the run's persisted funding is refused before
   * anything is written, and the transaction rolls back.
   */
  async updateWith(runId: string, patchFor: (current: MeetingRunRecord) => Partial<MeetingRunRecord> | undefined): Promise<MeetingRunRecord | undefined> {
    return this.opts.db.transaction(async (trx) => {
      await lockRun(trx, this.t.locks, runId);
      const r = await trx.get<Record<string, unknown>>(`SELECT * FROM ${this.t.runs} WHERE run_id = ? FOR UPDATE`, [runId]);
      if (!r) return undefined;
      const current = this.fromRow(r);
      const patch = patchFor(structuredClone(current));
      if (patch === undefined) return undefined;
      const next: MeetingRunRecord = { ...current, ...patch };
      assertMeetingFundingChange(current, next);
      if (patch.state === 'purging') {
        await trx.run(`UPDATE ${this.t.locks} SET fenced_at = COALESCE(fenced_at, ?) WHERE run_id = ?`, [Date.now(), runId]);
      }
      const row = this.row(next);
      const sets = SqlRunStore.COLUMNS.split(', ').map((c) => `${c} = ?`).join(', ');
      await trx.run(`UPDATE ${this.t.runs} SET ${sets} WHERE run_id = ?`, [...row, runId]);
      return next;
    });
  }
  /** Rereads before replacement, including content-free replacement after cleanup, so a stale replacement cannot overwrite a newer funding settlement intent. */
  async replace(run: MeetingRunRecord): Promise<void> {
    const next = structuredClone(run);
    const sets = SqlRunStore.COLUMNS.split(', ').map((c) => `${c} = ?`).join(', ');
    await this.opts.db.transaction(async (trx) => {
      await lockRun(trx, this.t.locks, next.runId);
      const r = await trx.get<Record<string, unknown>>(`SELECT * FROM ${this.t.runs} WHERE run_id = ? FOR UPDATE`, [next.runId]);
      if (!r) return;
      assertMeetingFundingChange(this.fromRow(r), next);
      await trx.run(`UPDATE ${this.t.runs} SET ${sets} WHERE run_id = ?`, [...this.row(next), next.runId]);
    });
  }
  /** Lists matching runs by requested time descending, then run id ascending. */
  async list(filter: RunFilter): Promise<MeetingRunRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.ownerRef !== undefined) { where.push('owner_ref = ?'); params.push(filter.ownerRef); }
    if (filter.states?.length) { where.push(`state IN (${filter.states.map(() => '?').join(', ')})`); params.push(...filter.states); }
    if (filter.since !== undefined) { where.push('requested_at >= ?'); params.push(filter.since); }
    const rows = await this.opts.db.all<Record<string, unknown>>(`SELECT * FROM ${this.t.runs}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY requested_at DESC, run_id ASC LIMIT ?`, [...params, filter.limit ?? 500]);
    return rows.map((r) => this.fromRow(r));
  }
  /** Finds the owner's run for a previously used idempotency key. */
  async findByIdempotencyKey(ownerRef: string, key: string): Promise<MeetingRunRecord | undefined> {
    const r = await this.opts.db.get<Record<string, unknown>>(`SELECT * FROM ${this.t.runs} WHERE owner_ref = ? AND idempotency_key = ?`, [ownerRef, key]);
    return r ? this.fromRow(r) : undefined;
  }
  /** At most `limit` (1 to 64) runs whose funding cleanup is unfinished, after `afterRunId`, ordered by run id, over the funding scan's partial index. */
  async listFundingPending(limit: number, afterRunId?: string): Promise<MeetingRunRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('funding scan bound');
    const rows = await this.opts.db.all<Record<string, unknown>>(`SELECT * FROM ${this.t.runs} WHERE funding_cleanup_json IS NOT NULL AND (funding_cleanup_json::jsonb->>'complete') = 'false' AND run_id > ? ORDER BY run_id LIMIT ?`, [afterRunId ?? '', limit]);
    return rows.map((r) => this.fromRow(r));
  }
}

/** Postgres dispatch jobs with atomic leases and holder-checked writes. */
export class SqlJobStore implements IJobStore {
  private readonly t: MeetingStoreTables;
  /** Checks the adapter capabilities and prefix without creating tables. */
  constructor(private readonly opts: SqlStoreOptions) {
    checkPostgres(opts.db, 'SqlJobStore');
    this.t = meetingStoreTables(opts.tablePrefix);
  }
  private fromRow(r: Record<string, unknown>): MeetingJob {
    return { runId: String(r.run_id), dispatchAt: num(r.dispatch_at)!, leaseHolder: (r.lease_holder as string | null) ?? undefined, leaseExpiresAt: num(r.lease_expires_at), workerId: (r.worker_id as string | null) ?? undefined, dispatched: bool(r.dispatched), cancelled: bool(r.cancelled) };
  }
  /** Schedules a job; an existing job keeps its lease, dispatch and cancellation fields. */
  async schedule(job: { runId: string; dispatchAt: number }): Promise<void> {
    await this.opts.db.run(`INSERT INTO ${this.t.jobs} (run_id, dispatch_at) VALUES (?, ?) ON CONFLICT (run_id) DO UPDATE SET dispatch_at = EXCLUDED.dispatch_at`, [job.runId, job.dispatchAt]);
  }
  /** One statement: the row is locked, skipped by any other taker, and leased in the same UPDATE. */
  async lease(holder: string, now: number, ttlMs: number): Promise<MeetingJob | undefined> {
    const r = await this.opts.db.get<Record<string, unknown>>(
      `UPDATE ${this.t.jobs} SET lease_holder = ?, lease_expires_at = ?
       WHERE run_id = (
         SELECT run_id FROM ${this.t.jobs}
         WHERE NOT dispatched AND NOT cancelled AND dispatch_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         ORDER BY dispatch_at LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
      [holder, now + ttlMs, now, now]
    );
    return r ? this.fromRow(r) : undefined;
  }
  /** Extends an unexpired lease only for its current holder. */
  async renew(runId: string, holder: string, now: number, ttlMs: number): Promise<boolean> {
    const res = await this.opts.db.run(`UPDATE ${this.t.jobs} SET lease_expires_at = ? WHERE run_id = ? AND lease_holder = ? AND lease_expires_at > ?`, [now + ttlMs, runId, holder, now]);
    return res.changes > 0;
  }
  /** Records the holder's dispatch and reports a cancellation that arrived during it. */
  async markDispatched(runId: string, holder: string, workerId: string | undefined): Promise<{ recorded: boolean; cancelled: boolean }> {
    return this.opts.db.transaction(async (trx) => {
      const job = await trx.get<{ lease_holder: string | null; cancelled: unknown }>(`SELECT lease_holder, cancelled FROM ${this.t.jobs} WHERE run_id = ? FOR UPDATE`, [runId]);
      if (!job) return { recorded: false, cancelled: false };
      if (job.lease_holder !== holder) return { recorded: false, cancelled: bool(job.cancelled) };
      await trx.run(`UPDATE ${this.t.jobs} SET dispatched = TRUE, worker_id = ? WHERE run_id = ? AND lease_holder = ?`, [workerId ?? null, runId, holder]);
      return { recorded: true, cancelled: bool(job.cancelled) };
    });
  }
  /** Releases the holder's lease and moves the job's due time to its retry. */
  async release(runId: string, holder: string, retryAt: number): Promise<boolean> {
    const result = await this.opts.db.run(`UPDATE ${this.t.jobs} SET lease_holder = NULL, lease_expires_at = NULL, dispatch_at = ? WHERE run_id = ? AND lease_holder = ?`, [retryAt, runId, holder]);
    return result.changes > 0;
  }
  /** Cancels a pending job or reports that the caller must leave an already dispatched bot. */
  async cancel(runId: string): Promise<'cancelled' | 'already_dispatched' | 'missing'> {
    return this.opts.db.transaction(async (trx) => {
      const r = await trx.get<Record<string, unknown>>(`SELECT dispatched FROM ${this.t.jobs} WHERE run_id = ? FOR UPDATE`, [runId]);
      if (!r) return 'missing';
      if (bool(r.dispatched)) return 'already_dispatched';
      await trx.run(`UPDATE ${this.t.jobs} SET cancelled = TRUE WHERE run_id = ?`, [runId]);
      return 'cancelled';
    });
  }
  /** Reads one dispatch job. */
  async get(runId: string): Promise<MeetingJob | undefined> {
    const r = await this.opts.db.get<Record<string, unknown>>(`SELECT * FROM ${this.t.jobs} WHERE run_id = ?`, [runId]);
    return r ? this.fromRow(r) : undefined;
  }
  /** Lists the dispatched jobs reconciliation compares with provider usage. */
  async listDispatched(): Promise<MeetingJob[]> {
    return (await this.opts.db.all<Record<string, unknown>>(`SELECT * FROM ${this.t.jobs} WHERE dispatched`)).map((r) => this.fromRow(r));
  }
  /** Removes a run's job. */
  async remove(runId: string): Promise<void> {
    await this.opts.db.run(`DELETE FROM ${this.t.jobs} WHERE run_id = ?`, [runId]);
  }
}

/** Durable transcript turns, allocated and written under the same anchor as the content fence. A turn's start and end are kept in whole milliseconds, rounded. */
export class SqlTranscriptStore implements ITranscriptStore {
  private readonly t: MeetingStoreTables;
  /** Checks the adapter capabilities and prefix without creating tables. */
  constructor(private readonly opts: SqlStoreOptions) {
    checkPostgres(opts.db, 'SqlTranscriptStore');
    this.t = meetingStoreTables(opts.tablePrefix);
  }
  /** The anchor row is locked first, so an append and a fence of one run never interleave: a fence that commits first is seen, a fence that waits sees the turn and purges it. */
  async append(turn: TranscriptTurn): Promise<void> {
    await this.opts.db.transaction(async (trx) => {
      const { fencedAt } = await lockRun(trx, this.t.locks, turn.runId);
      if (fencedAt !== undefined) throw new FencedError(turn.runId);
      await trx.run(`INSERT INTO ${this.t.turns} (run_id, seq, turn_id, at, text, speaker, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run_id, seq) DO NOTHING`, [turn.runId, turn.seq, turn.turnId, turn.at, turn.text, turn.speaker ?? null, wholeMs(turn.startMs), wholeMs(turn.endMs)]);
      await trx.run(`UPDATE ${this.t.locks} SET turn_seq = GREATEST(turn_seq, ?) WHERE run_id = ?`, [turn.seq, turn.runId]);
    });
  }
  /** Allocates the next run sequence and stores the turn atomically, rejecting fenced runs. */
  async appendNext(input: TranscriptInput): Promise<TranscriptTurn> {
    return this.opts.db.transaction(async (trx) => {
      const { fencedAt } = await lockRun(trx, this.t.locks, input.runId);
      if (fencedAt !== undefined) throw new FencedError(input.runId);
      const row = await trx.get<{ turn_seq: unknown }>(
        `UPDATE ${this.t.locks} SET turn_seq = GREATEST(turn_seq, COALESCE((SELECT MAX(seq) FROM ${this.t.turns} WHERE run_id = ?), 0)) + 1 WHERE run_id = ? RETURNING turn_seq`,
        [input.runId, input.runId]
      );
      const seq = num(row?.turn_seq)!;
      const turn: TranscriptTurn = { ...input, seq, turnId: `${input.runId}:${seq}` };
      await trx.run(`INSERT INTO ${this.t.turns} (run_id, seq, turn_id, at, text, speaker, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [turn.runId, seq, turn.turnId, turn.at, turn.text, turn.speaker ?? null, wholeMs(turn.startMs), wholeMs(turn.endMs)]);
      return turn;
    });
  }
  /** Reads turns after the cursor in sequence order. */
  async read(runId: string, fromSeq: number, limit = 500): Promise<TranscriptTurn[]> {
    const rows = await this.opts.db.all<Record<string, unknown>>(`SELECT * FROM ${this.t.turns} WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`, [runId, fromSeq, limit]);
    return rows.map((r) => ({ runId: String(r.run_id), seq: num(r.seq)!, turnId: String(r.turn_id), at: num(r.at)!, text: String(r.text), speaker: (r.speaker as string | null) ?? undefined, startMs: num(r.start_ms), endMs: num(r.end_ms) }));
  }
  /** Fences the run against further transcript and content writes. */
  async fence(runId: string): Promise<void> {
    await fenceRun(this.opts.db, this.t.locks, runId, Date.now());
  }
  /** Reports whether the run's durable fence is set. */
  async isFenced(runId: string): Promise<boolean> {
    const r = await this.opts.db.get<{ fenced_at: unknown }>(`SELECT fenced_at FROM ${this.t.locks} WHERE run_id = ?`, [runId]);
    return num(r?.fenced_at) !== undefined;
  }
  /** Removes turns under the anchor, retaining its fence and sequence counters. */
  async purge(runId: string): Promise<void> {
    await this.opts.db.transaction(async (trx) => {
      await lockRun(trx, this.t.locks, runId);
      await trx.run(`DELETE FROM ${this.t.turns} WHERE run_id = ?`, [runId]);
    });
  }
}

/** Durable per-run event sequences with idempotent event ids and payload fencing. */
export class SqlEventStore implements IEventStore {
  private readonly t: MeetingStoreTables;
  /** Checks the adapter capabilities and prefix without creating tables. */
  constructor(private readonly opts: SqlStoreOptions) {
    checkPostgres(opts.db, 'SqlEventStore');
    this.t = meetingStoreTables(opts.tablePrefix);
  }
  /**
   * One transaction: the run's anchor row is locked (so sequence numbers of one run are handed out one at a time and the
   * fence is read under the same lock), a repeated event id answers its existing sequence, the row is written with the
   * run's next number and the counter advances; behind the fence a content event is written without its payload. Ids
   * are unique across runs, and two runs' anchors do not order their appends: an append whose id another run's append
   * writes and commits while this one waits on the index writes nothing and answers that event's sequence, as a
   * repeated id does.
   */
  async append(event: Omit<MeetingEvent, 'seq'>): Promise<{ inserted: boolean; seq: number }> {
    return this.opts.db.transaction(async (trx) => {
      const { fencedAt, eventSeq } = await lockRun(trx, this.t.locks, event.runId);
      const existing = await trx.get<{ seq: unknown }>(`SELECT seq FROM ${this.t.events} WHERE event_id = ?`, [event.eventId]);
      if (existing) return { inserted: false, seq: num(existing.seq)! };
      const seq = eventSeq + 1;
      const behindFence = fencedAt !== undefined && CONTENT_EVENT_TYPES.has(event.type);
      const written = await trx.get<{ seq: unknown }>(`INSERT INTO ${this.t.events} (run_id, seq, event_id, type, at, data_json, purged) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING RETURNING seq`, [event.runId, seq, event.eventId, event.type, event.at, behindFence || event.data === undefined ? null : JSON.stringify(event.data), behindFence]);
      if (!written) {
        // read committed: this statement sees the row the other append committed while the insert waited for it
        const holder = await trx.get<{ seq: unknown }>(`SELECT seq FROM ${this.t.events} WHERE event_id = ?`, [event.eventId]);
        if (!holder) throw new Error(`SqlEventStore: event ${event.eventId} conflicted on its id and no event holds it`);
        return { inserted: false, seq: num(holder.seq)! };
      }
      await trx.run(`UPDATE ${this.t.locks} SET event_seq = ? WHERE run_id = ?`, [seq, event.runId]);
      return { inserted: true, seq };
    });
  }
  /** Reads events after the cursor in sequence order. */
  async read(runId: string, fromSeq: number, limit = 500): Promise<MeetingEvent[]> {
    const rows = await this.opts.db.all<Record<string, unknown>>(`SELECT * FROM ${this.t.events} WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`, [runId, fromSeq, limit]);
    return rows.map((r) => ({ runId: String(r.run_id), seq: num(r.seq)!, eventId: String(r.event_id), type: r.type as MeetingEvent['type'], at: num(r.at)!, ...(r.data_json ? { data: JSON.parse(String(r.data_json)) } : {}), ...(bool(r.purged) ? { purged: true } : {}) }));
  }
  /** Prevents further content payloads from being stored for the run. */
  async fence(runId: string): Promise<void> {
    await fenceRun(this.opts.db, this.t.locks, runId, Date.now());
  }
  /** Scrubs content payloads under the anchor, preserving event ids, types, times and sequences. */
  async purgePayloads(runId: string): Promise<void> {
    const types = [...CONTENT_EVENT_TYPES];
    await this.opts.db.transaction(async (trx) => {
      await lockRun(trx, this.t.locks, runId);
      await trx.run(`UPDATE ${this.t.events} SET data_json = NULL, purged = TRUE WHERE run_id = ? AND type IN (${types.map(() => '?').join(', ')})`, [runId, ...types]);
    });
  }
}

/** Durable outbound deliveries with retry backoff, manual replay and content scrubbing. */
export class SqlOutbox implements IOutbox {
  private readonly t: MeetingStoreTables;
  /** The sends `sendClaimed` has under way in this process, by run. */
  private readonly claims: ClaimedSends = new Map();
  /** Checks the adapter capabilities and prefix without creating tables. */
  constructor(private readonly opts: SqlStoreOptions) {
    checkPostgres(opts.db, 'SqlOutbox');
    this.t = meetingStoreTables(opts.tablePrefix);
  }
  private fromRow(r: Record<string, unknown>): OutboxDelivery {
    return { id: String(r.id), runId: String(r.run_id), destinationRef: String(r.destination_ref), eventId: String(r.event_id), type: r.type as OutboxDelivery['type'], payload: String(r.payload), attempts: num(r.attempts) ?? 0, firstAttemptAt: num(r.first_attempt_at), nextAt: num(r.next_at)!, state: r.state as OutboxDelivery['state'], purged: bool(r.purged), kind: (r.kind as OutboxDelivery['kind'] | undefined) ?? 'event', expiresAt: num(r.expires_at) };
  }
  /** Enqueues once per delivery id, refusing new content behind the run's fence (a mail delivery is content). */
  async enqueue(d: OutboxEnqueue, now: number): Promise<void> {
    const kind = d.kind ?? 'event';
    await this.opts.db.transaction(async (trx) => {
      const { fencedAt } = await lockRun(trx, this.t.locks, d.runId);
      if (fencedAt !== undefined && (kind === 'mail' || CONTENT_EVENT_TYPES.has(d.type))) return;
      await trx.run(`INSERT INTO ${this.t.outbox} (id, run_id, destination_ref, event_id, type, payload, next_at, state, kind, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (id) DO NOTHING`, [d.id, d.runId, d.destinationRef, d.eventId, d.type, d.payload, now, kind, d.expiresAt ?? null]);
    });
  }
  /** Lists pending deliveries due at now, ordered by due time and id; a mail delivery past its expiry is left out. */
  async due(now: number, limit = 100): Promise<OutboxDelivery[]> {
    return (await this.opts.db.all<Record<string, unknown>>(`SELECT * FROM ${this.t.outbox} WHERE state = 'pending' AND next_at <= ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY next_at, id LIMIT ?`, [now, now, limit])).map((r) => this.fromRow(r));
  }
  /** Marks a delivery accepted by its destination. */
  async markDelivered(id: string): Promise<void> {
    await this.opts.db.run(`UPDATE ${this.t.outbox} SET state = 'delivered' WHERE id = ?`, [id]);
  }
  /** Advances retry backoff, giving up a day after the first failed attempt. A delivery no longer pending (delivered, or given up) is left as it is. */
  async markFailed(id: string, now: number): Promise<void> {
    await this.opts.db.transaction(async (trx) => {
      const r = await trx.get<Record<string, unknown>>(`SELECT attempts, first_attempt_at, state, expires_at FROM ${this.t.outbox} WHERE id = ? FOR UPDATE`, [id]);
      // a late failure report from a sender that lost the race resurrects neither a delivery the destination took nor one given up
      if (!r || r.state !== 'pending') return;
      const attempts = (num(r.attempts) ?? 0) + 1;
      const first = num(r.first_attempt_at) ?? now;
      const expires = num(r.expires_at);
      const dead = now - first >= OUTBOX_GIVE_UP_MS || (expires !== undefined && now >= expires);
      await trx.run(`UPDATE ${this.t.outbox} SET attempts = ?, first_attempt_at = ?, next_at = ?, state = ? WHERE id = ?`, [attempts, first, dead ? now : nextAttemptAt(attempts, now), dead ? 'dead' : 'pending', id]);
    });
  }
  /** Resets attempts and makes a delivery due now without restoring any purged payload; a mail delivery is never replayed. */
  async replay(id: string, now: number): Promise<void> {
    await this.opts.db.run(`UPDATE ${this.t.outbox} SET state = 'pending', attempts = 0, first_attempt_at = NULL, next_at = ? WHERE id = ? AND kind <> 'mail'`, [now, id]);
  }
  /** Ends a pending delivery at once; one no longer pending is left as it is. */
  async markDead(id: string): Promise<void> {
    await this.opts.db.run(`UPDATE ${this.t.outbox} SET state = 'dead' WHERE id = ? AND state = 'pending'`, [id]);
  }
  /** Moves a pending delivery's next attempt to `notBefore`, never earlier than it is, without counting an attempt. */
  async holdUntil(id: string, notBefore: number): Promise<void> {
    await this.opts.db.run(`UPDATE ${this.t.outbox} SET next_at = GREATEST(next_at, ?) WHERE id = ? AND state = 'pending'`, [notBefore, id]);
  }
  /** Ends every pending delivery of the run to the destination. */
  async cancel(runId: string, destinationRef: string): Promise<void> {
    await this.opts.db.run(`UPDATE ${this.t.outbox} SET state = 'dead' WHERE run_id = ? AND destination_ref = ? AND state = 'pending'`, [runId, destinationRef]);
  }
  /**
   * Fences new content and scrubs content deliveries, including delivered rows; content-free deliveries keep their type
   * and payload. A send of the run that `sendClaimed` has under way in this process and that has not written its body
   * yet stops.
   */
  async purgeContent(runId: string): Promise<void> {
    abortClaimedSends(this.claims, runId);
    await this.opts.db.transaction(async (trx) => {
      await lockRun(trx, this.t.locks, runId);
      await trx.run(`UPDATE ${this.t.locks} SET fenced_at = COALESCE(fenced_at, ?) WHERE run_id = ?`, [Date.now(), runId]);
      const types = [...CONTENT_EVENT_TYPES];
      await trx.run(`UPDATE ${this.t.outbox} SET payload = '', type = 'bot:purged', purged = TRUE WHERE run_id = ? AND kind = 'event' AND type IN (${types.map(() => '?').join(', ')})`, [runId, ...types]);
      await trx.run(`UPDATE ${this.t.outbox} SET payload = '', purged = TRUE, state = 'dead' WHERE run_id = ? AND kind = 'mail'`, [runId]);
    });
    // again once the scrub has committed: a send claimed while it ran may have read the row before it was emptied
    abortClaimedSends(this.claims, runId);
  }
  /** Lists all deliveries of a run, including delivered and dead ones. */
  async listByRun(runId: string): Promise<OutboxDelivery[]> {
    return (await this.opts.db.all<Record<string, unknown>>(`SELECT * FROM ${this.t.outbox} WHERE run_id = ? ORDER BY next_at, id`, [runId])).map((r) => this.fromRow(r));
  }
  /**
   * Sends one delivery as the table holds it now, not as `due` returned it: one gone or no longer pending is skipped
   * (false). The signal `send` gets aborts when this outbox's `purgeContent` purges the delivery's run, so a send that
   * has not written its body yet stops (false); any other rejection is `send`'s. A purge committed through another
   * instance or process reaches a send only through the re-read, so the manager that purges and the dispatcher take
   * the same `SqlOutbox`.
   *
   * @param candidate - A delivery `due` returned.
   * @param send - Sends the fresh copy under the signal.
   */
  async sendClaimed(candidate: OutboxDelivery, send: (fresh: OutboxDelivery, signal: AbortSignal) => Promise<void>): Promise<boolean> {
    return runClaimedSend(this.claims, candidate.runId, async (signal) => {
      const r = await this.opts.db.get<Record<string, unknown>>(`SELECT * FROM ${this.t.outbox} WHERE id = ?`, [candidate.id]);
      if (!r || r.state !== 'pending') return false;
      await send(this.fromRow(r), signal);
      return true;
    });
  }
}

/**
 * The durable {@link DeliveryFence} for a `FencedOutbox`: a run's fence is its run-lock row's `outbox_fenced_at`, so it
 * holds across a restart and between processes that share the tables. It is apart from the content fence the stores set
 * when a run enters `purging`. Fences are kept for good, so it has no `forget`.
 */
export class SqlDeliveryFence implements DeliveryFence {
  private readonly t: MeetingStoreTables;
  /** Checks the adapter capabilities and prefix without creating tables. */
  constructor(private readonly opts: SqlStoreOptions) {
    checkPostgres(opts.db, 'SqlDeliveryFence');
    this.t = meetingStoreTables(opts.tablePrefix);
  }
  /** Whether the run's deliveries are fenced. */
  async isFenced(runId: string): Promise<boolean> {
    const row = await this.opts.db.get<{ outbox_fenced_at: unknown }>(`SELECT outbox_fenced_at FROM ${this.t.locks} WHERE run_id = ?`, [runId]);
    return num(row?.outbox_fenced_at) !== undefined;
  }
  /** Fences the run's deliveries, making its run-lock row when there is none; a fence already written keeps its time. */
  async fence(runId: string): Promise<void> {
    await this.opts.db.run(`INSERT INTO ${this.t.locks} (run_id, outbox_fenced_at) VALUES (?, ?)
      ON CONFLICT (run_id) DO UPDATE SET outbox_fenced_at = COALESCE(${this.t.locks}.outbox_fenced_at, EXCLUDED.outbox_fenced_at)`, [runId, Date.now()]);
  }
}
