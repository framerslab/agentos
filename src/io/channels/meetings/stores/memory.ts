import { CONTENT_EVENT_TYPES, type MeetingEvent, type MeetingRunRecord, type MeetingRunState, type TranscriptTurn } from '../types.js';
import {
  FencedError,
  nextAttemptAt,
  OUTBOX_GIVE_UP_MS,
  type IClock,
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
  private readonly runs = new Map<string, MeetingRunRecord>();
  async insert(run: MeetingRunRecord): Promise<void> {
    if (this.runs.has(run.runId)) throw new Error(`run ${run.runId} exists`);
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
  async replace(run: MeetingRunRecord): Promise<void> {
    this.runs.set(run.runId, structuredClone(run));
  }
  async list(filter: RunFilter): Promise<MeetingRunRecord[]> {
    const out: MeetingRunRecord[] = [];
    for (const r of this.runs.values()) {
      if (filter.ownerRef !== undefined && r.ownerRef !== filter.ownerRef) continue;
      if (filter.states && !filter.states.includes(r.state)) continue;
      if (filter.since !== undefined && r.requestedAt < filter.since) continue;
      out.push(structuredClone(r));
    }
    out.sort((a, b) => b.requestedAt - a.requestedAt);
    return filter.limit ? out.slice(0, filter.limit) : out;
  }
  async findByIdempotencyKey(ownerRef: string, key: string): Promise<MeetingRunRecord | undefined> {
    for (const r of this.runs.values()) if (r.ownerRef === ownerRef && r.idempotencyKey === key) return structuredClone(r);
    return undefined;
  }
}

/** Dispatch jobs in memory, for tests and single-process hosts: its leases hold within one process. */
export class InMemoryJobStore implements IJobStore {
  private readonly jobs = new Map<string, MeetingJob>();
  async schedule(job: { runId: string; dispatchAt: number }): Promise<void> {
    this.jobs.set(job.runId, { runId: job.runId, dispatchAt: job.dispatchAt, dispatched: false, cancelled: false });
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
  async markDispatched(runId: string, workerId: string | undefined): Promise<{ cancelled: boolean }> {
    const job = this.jobs.get(runId);
    if (!job) return { cancelled: false };
    job.dispatched = true;
    job.workerId = workerId;
    return { cancelled: job.cancelled };
  }
  async release(runId: string, retryAt: number): Promise<void> {
    const job = this.jobs.get(runId);
    if (job) {
      job.leaseHolder = undefined;
      job.leaseExpiresAt = undefined;
      job.dispatchAt = retryAt;
    }
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
  private readonly turns = new Map<string, TranscriptTurn[]>();
  private readonly fenced = new Set<string>();
  async append(turn: TranscriptTurn): Promise<void> {
    if (this.fenced.has(turn.runId)) throw new FencedError(turn.runId);
    const list = this.turns.get(turn.runId) ?? [];
    list.push({ ...turn });
    this.turns.set(turn.runId, list);
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
  /** Forgets a run whole, its turns and its fence, to free the memory of a run that is over. The manager does not call it: it removes a run's turns with `purge`, which keeps the fence. */
  async drop(runId: string): Promise<void> {
    this.turns.delete(runId);
    this.fenced.delete(runId);
  }
}

/** Events in memory, numbered per run and deduplicated by id: for tests, single-process hosts and runs that are not kept. */
export class InMemoryEventStore implements IEventStore {
  private readonly byRun = new Map<string, MeetingEvent[]>();
  private readonly byId = new Map<string, MeetingEvent>();
  private readonly fenced = new Set<string>();
  async append(event: Omit<MeetingEvent, 'seq'>): Promise<{ inserted: boolean; seq: number }> {
    const existing = this.byId.get(event.eventId);
    if (existing) return { inserted: false, seq: existing.seq };
    const list = this.byRun.get(event.runId) ?? [];
    const behindFence = this.fenced.has(event.runId) && CONTENT_EVENT_TYPES.has(event.type);
    const stored: MeetingEvent = behindFence ? { ...event, data: undefined, purged: true, seq: list.length + 1 } : { ...event, seq: list.length + 1 };
    list.push(stored);
    this.byRun.set(event.runId, list);
    this.byId.set(event.eventId, stored);
    return { inserted: true, seq: stored.seq };
  }
  async fence(runId: string): Promise<void> {
    this.fenced.add(runId);
  }
  async read(runId: string, fromSeq: number, limit = 500): Promise<MeetingEvent[]> {
    return (this.byRun.get(runId) ?? []).filter((e) => e.seq > fromSeq).slice(0, limit).map((e) => ({ ...e }));
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
  private readonly deliveries = new Map<string, OutboxDelivery>();
  /** The runs whose content was purged: the outbox's fence. */
  private readonly purgedRuns = new Set<string>();
  async enqueue(d: Pick<OutboxDelivery, 'id' | 'runId' | 'destinationRef' | 'eventId' | 'type' | 'payload'>, now: number): Promise<void> {
    // behind the purge nothing a person said or did is taken for delivery
    if (this.purgedRuns.has(d.runId) && CONTENT_EVENT_TYPES.has(d.type)) return;
    this.deliveries.set(d.id, { ...d, attempts: 0, nextAt: now, state: 'pending', purged: false });
  }
  async due(now: number, limit = 100): Promise<OutboxDelivery[]> {
    return [...this.deliveries.values()].filter((d) => d.state === 'pending' && d.nextAt <= now).slice(0, limit).map((d) => ({ ...d }));
  }
  async markDelivered(id: string): Promise<void> {
    const d = this.deliveries.get(id);
    if (d) d.state = 'delivered';
  }
  async markFailed(id: string, now: number): Promise<void> {
    const d = this.deliveries.get(id);
    if (!d) return;
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
      if (d.runId !== runId) continue; // delivered rows too: a replay after the purge must send nothing of the content
      d.payload = '';
      d.type = 'bot:purged';
      d.purged = true;
    }
  }
  async listByRun(runId: string): Promise<OutboxDelivery[]> {
    return [...this.deliveries.values()].filter((d) => d.runId === runId).map((d) => ({ ...d }));
  }
}
