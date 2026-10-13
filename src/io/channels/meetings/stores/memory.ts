import type { TranscriptInput } from '../../../voice-pipeline/types.js';
import { CONTENT_EVENT_TYPES, type MeetingEvent, type MeetingRunRecord, type MeetingRunState, type TranscriptTurn } from '../types.js';
import {
  DuplicateIdempotencyKeyError,
  FencedError,
  nextAttemptAt,
  OUTBOX_GIVE_UP_MS,
  type IClock,
  type IEntitlementHook,
  type ReserveResult,
  type IEventStore,
  type IJobStore,
  type IOutbox,
  type IRunStore,
  type ITranscriptStore,
  type MeetingJob,
  type OutboxDelivery,
  type RunFilter,
} from './types.js';

/** The wall clock. */
export class SystemClock implements IClock {
  now(): number {
    return Date.now();
  }
}

/** A clock a test sets and moves by hand. */
export class FakeClock implements IClock {
  /** @param t - The starting time, in milliseconds. */
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  /** Moves the clock forward by `ms`. */
  advance(ms: number): void {
    this.t += ms;
  }
  /** Sets the clock to `t`. */
  set(t: number): void {
    this.t = t;
  }
}

/** Runs in memory, for tests and single-process hosts. Rows are copied in and out, so a caller never holds the stored row. */
export class InMemoryRunStore implements IRunStore {
  async forget(runId: string): Promise<void> {
    this.runs.delete(runId);
  }

  private readonly runs = new Map<string, MeetingRunRecord>();
  async insert(run: MeetingRunRecord): Promise<void> {
    if (this.runs.has(run.runId)) throw new Error(`run ${run.runId} exists`);
    // one run per owner and key, with no await between the check and the write: of two sends racing with one key, the second insert fails and the sender finds the first
    const key = run.idempotencyKey;
    if (key !== undefined && [...this.runs.values()].some((r) => r.ownerRef === run.ownerRef && r.idempotencyKey === key)) {
      throw new DuplicateIdempotencyKeyError(run.ownerRef, key);
    }
    this.runs.set(run.runId, structuredClone(run));
  }
  async get(runId: string): Promise<MeetingRunRecord | undefined> {
    const r = this.runs.get(runId);
    return r ? structuredClone(r) : undefined;
  }
  async update(runId: string, patch: Partial<MeetingRunRecord>, expectState?: MeetingRunState | readonly MeetingRunState[]): Promise<MeetingRunRecord | undefined> {
    const r = this.runs.get(runId);
    if (!r) return undefined;
    if (expectState !== undefined) {
      const allowed = Array.isArray(expectState) ? expectState : [expectState as MeetingRunState];
      if (!allowed.includes(r.state)) return undefined;
    }
    Object.assign(r, structuredClone(patch));
    return structuredClone(r);
  }
  /** Decides the patch on a copy of the stored row and applies it with no await between them, so no other write lands in between. */
  async updateWith(runId: string, patchFor: (current: MeetingRunRecord) => Partial<MeetingRunRecord> | undefined): Promise<MeetingRunRecord | undefined> {
    const r = this.runs.get(runId);
    if (!r) return undefined;
    const patch = patchFor(structuredClone(r));
    if (patch === undefined) return undefined;
    Object.assign(r, structuredClone(patch));
    return structuredClone(r);
  }
  async replace(run: MeetingRunRecord): Promise<void> {
    this.runs.set(run.runId, structuredClone(run));
  }
  async list(filter: RunFilter): Promise<MeetingRunRecord[]> {
    const out: MeetingRunRecord[] = [];
    for (const r of this.runs.values()) {
      if (filter.ownerRef !== undefined && r.ownerRef !== filter.ownerRef) continue;
      if (filter.states?.length && !filter.states.includes(r.state)) continue;
      if (filter.since !== undefined && r.requestedAt < filter.since) continue;
      out.push(structuredClone(r));
    }
    out.sort((a, b) => b.requestedAt - a.requestedAt || a.runId.localeCompare(b.runId));
    return out.slice(0, filter.limit ?? 500);
  }
  async findByIdempotencyKey(ownerRef: string, key: string): Promise<MeetingRunRecord | undefined> {
    for (const r of this.runs.values()) if (r.ownerRef === ownerRef && r.idempotencyKey === key) return structuredClone(r);
    return undefined;
  }
}

/** Dispatch jobs in memory, for tests and single-process hosts: its leases hold within one process. */
export class InMemoryJobStore implements IJobStore {
  async forget(runId: string): Promise<void> {
    this.jobs.delete(runId);
  }

  private readonly jobs = new Map<string, MeetingJob>();
  async schedule(job: { runId: string; dispatchAt: number }): Promise<void> {
    const existing = this.jobs.get(job.runId);
    if (existing) existing.dispatchAt = job.dispatchAt;
    else this.jobs.set(job.runId, { ...job, dispatched: false, cancelled: false });
  }
  async lease(holder: string, now: number, ttlMs: number): Promise<MeetingJob | undefined> {
    // no await between the read and the write below, so two takers in one process never hold one job
    const due = [...this.jobs.values()]
      .filter((j) => !j.cancelled && !j.dispatched && j.dispatchAt <= now && (j.leaseExpiresAt === undefined || j.leaseExpiresAt <= now))
      .sort((a, b) => a.dispatchAt - b.dispatchAt);
    const job = due[0];
    if (!job) return undefined;
    job.leaseHolder = holder;
    job.leaseExpiresAt = now + ttlMs;
    return { ...job };
  }
  async renew(runId: string, holder: string, now: number, ttlMs: number): Promise<boolean> {
    const job = this.jobs.get(runId);
    if (!job || job.leaseHolder !== holder || job.leaseExpiresAt === undefined || job.leaseExpiresAt <= now) return false;
    job.leaseExpiresAt = now + ttlMs;
    return true;
  }
  async markDispatched(runId: string, holder: string, workerId: string | undefined): Promise<{ recorded: boolean; cancelled: boolean }> {
    const job = this.jobs.get(runId);
    if (!job) return { recorded: false, cancelled: false };
    // a holder whose lease another holder took changes nothing: the new holder's dispatch is the job's
    if (job.leaseHolder !== holder) return { recorded: false, cancelled: job.cancelled };
    job.dispatched = true;
    job.workerId = workerId;
    return { recorded: true, cancelled: job.cancelled };
  }
  async release(runId: string, holder: string, retryAt: number): Promise<boolean> {
    const job = this.jobs.get(runId);
    if (!job || job.leaseHolder !== holder) return false;
    job.leaseHolder = undefined;
    job.leaseExpiresAt = undefined;
    job.dispatchAt = retryAt;
    return true;
  }
  async cancel(runId: string): Promise<'cancelled' | 'already_dispatched' | 'missing'> {
    const job = this.jobs.get(runId);
    if (!job) return 'missing';
    if (job.dispatched) return 'already_dispatched';
    job.cancelled = true;
    return 'cancelled';
  }
  async get(runId: string): Promise<MeetingJob | undefined> {
    const j = this.jobs.get(runId);
    return j ? { ...j } : undefined;
  }
  async listDispatched(): Promise<MeetingJob[]> {
    return [...this.jobs.values()].filter((j) => j.dispatched).map((j) => ({ ...j }));
  }
  async remove(runId: string): Promise<void> {
    this.jobs.delete(runId);
  }
}

/** Transcript turns in memory: for tests, single-process hosts and runs that are not kept. */
export class InMemoryTranscriptStore implements ITranscriptStore {
  async forget(runId: string): Promise<void> {
    this.turns.delete(runId);
    this.fenced.delete(runId);
    this.lastSeq.delete(runId);
  }

  private readonly turns = new Map<string, TranscriptTurn[]>();
  private readonly lastSeq = new Map<string, number>();
  private readonly fenced = new Set<string>();
  async append(turn: TranscriptTurn): Promise<void> {
    if (this.fenced.has(turn.runId)) throw new FencedError(turn.runId);
    const list = this.turns.get(turn.runId) ?? [];
    if (list.some((t) => t.seq === turn.seq)) return;
    list.push({ ...turn });
    list.sort((a, b) => a.seq - b.seq);
    this.lastSeq.set(turn.runId, Math.max(this.lastSeq.get(turn.runId) ?? 0, turn.seq));
    this.turns.set(turn.runId, list);
  }
  async appendNext(input: TranscriptInput): Promise<TranscriptTurn> {
    if (this.fenced.has(input.runId)) throw new FencedError(input.runId);
    const seq = (this.lastSeq.get(input.runId) ?? 0) + 1;
    const turn: TranscriptTurn = { ...input, seq, turnId: `${input.runId}:${seq}` };
    // No await between allocation and insertion: all sinks in this process share this counter.
    this.lastSeq.set(input.runId, seq);
    const list = this.turns.get(input.runId) ?? [];
    list.push({ ...turn });
    this.turns.set(input.runId, list);
    return { ...turn };
  }
  async read(runId: string, fromSeq: number, limit = 500): Promise<TranscriptTurn[]> {
    return (this.turns.get(runId) ?? []).filter((t) => t.seq > fromSeq).slice(0, limit).map((t) => ({ ...t }));
  }
  async fence(runId: string): Promise<void> {
    this.fenced.add(runId);
  }
  async isFenced(runId: string): Promise<boolean> {
    return this.fenced.has(runId);
  }
  async purge(runId: string): Promise<void> {
    this.turns.delete(runId);
  }
  /** Alias for whole-run eviction after the retention grace. */
  async drop(runId: string): Promise<void> {
    await this.forget(runId);
  }
}

/**
 * Events in memory, numbered per run and deduplicated by id: for tests, single-process hosts and runs that are not kept.
 * Events are copied in and out, payloads included, so a caller never holds a stored event.
 */
export class InMemoryEventStore implements IEventStore {
  async forget(runId: string): Promise<void> {
    for (const event of this.byRun.get(runId) ?? []) this.byId.delete(event.eventId);
    this.byRun.delete(runId);
    this.fenced.delete(runId);
  }

  private readonly byRun = new Map<string, MeetingEvent[]>();
  private readonly byId = new Map<string, MeetingEvent>();
  private readonly fenced = new Set<string>();
  async append(event: Omit<MeetingEvent, 'seq'>): Promise<{ inserted: boolean; seq: number }> {
    const existing = this.byId.get(event.eventId);
    if (existing) return { inserted: false, seq: existing.seq };
    const list = this.byRun.get(event.runId) ?? [];
    const behindFence = this.fenced.has(event.runId) && CONTENT_EVENT_TYPES.has(event.type);
    const stored: MeetingEvent = behindFence ? { ...event, data: undefined, purged: true, seq: list.length + 1 } : { ...structuredClone(event), seq: list.length + 1 };
    list.push(stored);
    this.byRun.set(event.runId, list);
    this.byId.set(event.eventId, stored);
    return { inserted: true, seq: stored.seq };
  }
  async fence(runId: string): Promise<void> {
    this.fenced.add(runId);
  }
  async read(runId: string, fromSeq: number, limit = 500): Promise<MeetingEvent[]> {
    return (this.byRun.get(runId) ?? []).filter((e) => e.seq > fromSeq).slice(0, limit).map((e) => structuredClone(e));
  }
  async purgePayloads(runId: string): Promise<void> {
    for (const e of this.byRun.get(runId) ?? []) {
      if (CONTENT_EVENT_TYPES.has(e.type)) {
        delete e.data;
        e.purged = true;
      }
    }
  }
}

/** Outbound deliveries in memory, for tests and single-process hosts. */
export class InMemoryOutbox implements IOutbox {
  async forget(runId: string): Promise<void> {
    for (const [id, delivery] of this.deliveries) if (delivery.runId === runId) this.deliveries.delete(id);
    this.purgedRuns.delete(runId);
  }

  private readonly deliveries = new Map<string, OutboxDelivery>();
  /** The runs whose content was purged: the outbox's fence. */
  private readonly purgedRuns = new Set<string>();
  async enqueue(d: Pick<OutboxDelivery, 'id' | 'runId' | 'destinationRef' | 'eventId' | 'type' | 'payload'>, now: number): Promise<void> {
    // behind the purge nothing a person said or did is taken for delivery
    if (this.purgedRuns.has(d.runId) && CONTENT_EVENT_TYPES.has(d.type)) return;
    if (this.deliveries.has(d.id)) return;
    this.deliveries.set(d.id, { ...d, attempts: 0, nextAt: now, state: 'pending', purged: false });
  }
  async due(now: number, limit = 100): Promise<OutboxDelivery[]> {
    return [...this.deliveries.values()].filter((d) => d.state === 'pending' && d.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt || a.id.localeCompare(b.id)).slice(0, limit).map((d) => ({ ...d }));
  }
  async markDelivered(id: string): Promise<void> {
    const d = this.deliveries.get(id);
    if (d) d.state = 'delivered';
  }
  async markFailed(id: string, now: number): Promise<void> {
    const d = this.deliveries.get(id);
    // a delivery no longer pending (delivered, or given up) is left as it is
    if (!d || d.state !== 'pending') return;
    d.attempts += 1;
    d.firstAttemptAt ??= now;
    if (now - d.firstAttemptAt >= OUTBOX_GIVE_UP_MS) d.state = 'dead';
    else d.nextAt = nextAttemptAt(d.attempts, now);
  }
  async replay(id: string, now: number): Promise<void> {
    const d = this.deliveries.get(id);
    if (!d) return;
    d.state = 'pending';
    d.attempts = 0;
    d.firstAttemptAt = undefined;
    d.nextAt = now;
  }
  async purgeContent(runId: string): Promise<void> {
    this.purgedRuns.add(runId);
    for (const d of this.deliveries.values()) {
      // delivered rows too: a replay after the purge must send nothing of the content; a content-free delivery (`bot:done`) stays as it is
      if (d.runId !== runId || !CONTENT_EVENT_TYPES.has(d.type)) continue;
      d.payload = '';
      d.type = 'bot:purged';
      d.purged = true;
    }
  }
  async listByRun(runId: string): Promise<OutboxDelivery[]> {
    return [...this.deliveries.values()].filter((d) => d.runId === runId).sort((a, b) => a.nextAt - b.nextAt || a.id.localeCompare(b.id)).map((d) => ({ ...d }));
  }
}

/** Reservations in memory for tests and single-process hosts; no external billing policy is applied. */
export class InMemoryEntitlementHook implements IEntitlementHook {
  private readonly reservations = new Map<string, { runId: string; maxSeconds: number; metered: number; settled?: number; released: boolean }>();
  /** @param maxSeconds - The most one reservation covers, in seconds; four hours when absent. */
  constructor(private readonly maxSeconds = 14_400) {}
  async reserve(input: Parameters<IEntitlementHook['reserve']>[0]): Promise<ReserveResult> {
    const id = `reservation:${input.runId}`;
    const existing = this.reservations.get(id);
    if (existing) return { ok: true, reservationId: id, maxSeconds: existing.maxSeconds };
    const maxSeconds = Math.min(input.maxSeconds, this.maxSeconds);
    if (maxSeconds <= 0) return { ok: false, reason: 'allowance', message: 'no seconds available' };
    this.reservations.set(id, { runId: input.runId, maxSeconds, metered: 0, released: false });
    return { ok: true, reservationId: id, maxSeconds };
  }
  async revalidate(id: string): Promise<boolean> {
    const r = this.reservations.get(id);
    return !!r && !r.released && r.settled === undefined;
  }
  async meter(id: string, seconds: number): Promise<void> {
    const r = this.reservations.get(id);
    if (r && !r.released && r.settled === undefined) r.metered = Math.max(r.metered, seconds);
  }
  async settle(id: string, billedSeconds: number): Promise<void> {
    const r = this.reservations.get(id);
    if (r && !r.released && r.settled === undefined) r.settled = billedSeconds;
  }
  async release(id: string): Promise<void> {
    const r = this.reservations.get(id);
    if (r && r.settled === undefined) r.released = true;
  }
  /** A copied reservation, for inspection by a single-process host. */
  get(id: string): { runId: string; maxSeconds: number; metered: number; settled?: number; released: boolean } | undefined {
    const r = this.reservations.get(id);
    return r ? { ...r } : undefined;
  }
  async forget(runId: string): Promise<void> {
    for (const [id, r] of this.reservations) if (r.runId === runId) this.reservations.delete(id);
  }
}
