/**
 * @module channels/meetings/MeetingManager
 *
 * Owns a run's life: the state machine, the capture interlock, the stop
 * command, the purge sequence behind its fence, the limits, the meter and the
 * reconciliation. Keeps nothing about a run in process: every row, and every
 * timer the limits run on, is in an injected store, so several manager
 * processes may share one database and one that restarts carries on.
 */
import { randomUUID } from 'node:crypto';
import type { ITranscriptInputSink, TranscriptTurn } from '../../voice-pipeline/types.js';
import type { DispatchResult, IMeetingBotProvider, ProviderCommand, ProviderEventContext } from './IMeetingBotProvider.js';
import type { MeetingRoom, MeetingRoomHandle } from './MeetingRoom.js';
import { MeetingTranscriptSink } from './MeetingTranscriptSink.js';
import { hashWorkerToken, mintWorkerToken } from './signing.js';
import { DuplicateIdempotencyKeyError, type IClock, type IEntitlementHook, type IEventStore, type IJobStore, type IOutbox, type IRunStore, type ITranscriptStore } from './stores/types.js';
import {
  canTransition,
  CONTENT_EVENT_TYPES,
  contentFreeRun,
  DEFAULT_RUN_LIMITS,
  isBilledEnd,
  TERMINAL_RUN_STATES,
  type MeetingEventType,
  type MeetingLeaveReason,
  type MeetingPlatform,
  type MeetingRunLimits,
  type MeetingRunRecord,
  type MeetingRunState,
  type NormalizedMeetingEvent,
  type ProviderEventType,
  type SendBotRequest,
  type SendBotResult,
} from './types.js';

/** The stores and hooks a manager keeps its runs in. */
export interface MeetingManagerStores {
  /** The runs' rows. */
  runs: IRunStore;
  /** The dispatch jobs and their leases. */
  jobs: IJobStore;
  /** The runs' transcript turns. */
  transcript: ITranscriptStore;
  /** The runs' events, numbered per run. */
  events: IEventStore;
  /** The events' deliveries to the product's destinations. */
  outbox: IOutbox;
  /** The product's billing: reserve, meter, settle, release. */
  entitlement: IEntitlementHook;
  /** The clock the manager measures every limit on. */
  clock: IClock;
}

/** How a host builds a {@link MeetingManager}: its stores, its room helper, its routes and its limits. */
export interface MeetingManagerConfig {
  /** This process, as the holder of dispatch leases. */
  managerId?: string;
  /** Where every run's rows, jobs, turns, events and deliveries are kept. */
  stores: MeetingManagerStores;
  /** Makes each run's room at dispatch and deletes it at the end. */
  room: MeetingRoom;
  /** The product's events route for a provider's reports about a run. */
  reportUrlFor: (runId: string, providerName: string) => string;
  /** The product's destinations (webhook registrations) for an owner; absent, nothing is enqueued. */
  destinationsFor?: (ownerRef: string) => Promise<string[]>;
  /** The product's steps of the purge sequence: the agent's history, the kept session, the page. Each is retried until it resolves. */
  purgeHooks?: Array<(runId: string) => Promise<void>>;
  /** How long a dispatch lease lasts; renewed every third of it while a dispatch is in flight. Default 60000. */
  leaseTtlMs?: number;
  /** How long after `in_call` the notice may go unconfirmed before the run leaves with `notice_failed`. Default 30000. */
  noticeConfirmMs?: number;
  /** How often the stop monitor reports. Default 10000. */
  monitorHeartbeatMs?: number;
  /** How many heartbeats the stop monitor may miss before it counts as unhealthy: it does once this many heartbeat intervals pass without one (30 seconds with the defaults). Default 3. */
  monitorMissedBeats?: number;
  /** How long a suspended capture waits for the stop monitor to recover before the run leaves with `stop_monitor_failed`. Default 30000. */
  monitorRecoverMs?: number;
  /** How long after its due time a dispatch keeps being retried before the run fails. Default 300000. */
  dispatchRetryMs?: number;
  /** The pause before a failed dispatch is tried again. Default 15000. */
  dispatchRetryDelayMs?: number;
  /** How long after a leave command the bot is killed. Default 30000. */
  killAfterMs?: number;
  /** In-memory terminal records live for this grace; default two days, beyond the outbox retry window. */
  forgetAfterMs?: number;
  /** The least a reservation may cover for a run to be sent, in seconds; a send under it is refused with `allowance`. Default 600. */
  minReservationSeconds?: number;
  /** Where the manager writes its warnings and errors. */
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

/** An event the manager emitted, as its handlers receive it once it is stored. */
export interface MeetingManagerEvent {
  /** The event's type. */
  type: MeetingEventType;
  /** The run the event belongs to. */
  runId: string;
  /** The run's row as the manager held it when it emitted the event. */
  run: MeetingRunRecord;
  /** The event's number in its run. */
  seq: number;
  /** The event's payload; a content event carries what a person said or did. */
  data?: Record<string, unknown>;
}

/** Receives each event once; a handler that throws or rejects is logged and the others still run. */
export type MeetingManagerEventHandler = (event: MeetingManagerEvent) => void | Promise<void>;

/** An event as the manager stored it in its run's sequence, which its delivery carries. */
interface StoredEvent {
  id: string;
  type: MeetingEventType;
  at: number;
  seq: number;
  data?: Record<string, unknown>;
  /** Stored before under the same id: a report the worker sent again, or an emit tried again after a later step failed. */
  repeated: boolean;
}

/** Thrown by a provider's `dispatch` when no worker has a slot. */
export class NoCapacityError extends Error {
  /** @param message - Why no worker took the run. */
  constructor(message = 'no worker has a free slot') {
    super(message);
    this.name = 'NoCapacityError';
  }
}

const ONCE_EVENTS: ReadonlySet<MeetingEventType> = new Set<MeetingEventType>([
  'bot:requested',
  'bot:scheduled',
  'bot:dispatching',
  'bot:joining',
  'bot:in_call',
  'bot:notice_posted',
  'bot:left',
  'bot:purged',
  'bot:done',
]);

const ACTIVE_STATES: readonly MeetingRunState[] = ['dispatching', 'joining', 'waiting_room', 'in_call_notice_pending', 'in_call', 'leaving', 'left', 'purging'];
/** States a purge may start from: everything that is not terminal. */
const PURGEABLE_STATES: readonly MeetingRunState[] = ['requested', 'scheduled', ...ACTIVE_STATES.filter((s) => s !== 'purging')];
/** Reports that carry what a person said or did; behind the fence they are neither stored nor forwarded. */
const CONTENT_REPORTS: ReadonlySet<ProviderEventType> = new Set<ProviderEventType>(['chat_message', 'stop_command', 'participant_joined', 'participant_left']);

/**
 * A run's limits: the defaults, each replaced by the request's own value where it gives one. A limit given as
 * `undefined` keeps its default (a spread would copy the `undefined` over it and leave the run without that limit).
 *
 * @throws RangeError when a limit is given that is not a finite number of milliseconds, zero or more.
 */
function runLimits(requested: Partial<MeetingRunLimits> | undefined): MeetingRunLimits {
  const limits: MeetingRunLimits = { ...DEFAULT_RUN_LIMITS };
  for (const key of ['waitingRoomMs', 'aloneMs', 'totalMs', 'pageAwayMs'] as const) {
    const value = requested?.[key];
    if (value === undefined) continue;
    // NaN would turn off the limit it sets: every comparison with it is false
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`limits.${key} must be a finite number of milliseconds, zero or more`);
    limits[key] = value;
  }
  return limits;
}

/**
 * The meeting-participant channel's manager: sends bots, dispatches them under
 * a lease, applies the providers' reports and enforces each run's lifecycle
 * over the injected stores. Several managers may share one database; each
 * takes dispatch leases under its own `managerId`.
 */
export class MeetingManager {
  private readonly providers = new Map<string, IMeetingBotProvider>();
  private readonly handlers: MeetingManagerEventHandler[] = [];
  private readonly paused = new Set<MeetingPlatform>();
  private readonly id: string;
  private readonly leaseTtlMs: number;
  private readonly noticeConfirmMs: number;
  private readonly monitorHeartbeatMs: number;
  private readonly monitorMissedBeats: number;
  private readonly monitorRecoverMs: number;
  private readonly dispatchRetryMs: number;
  private readonly dispatchRetryDelayMs: number;
  private readonly killAfterMs: number;
  private readonly minReservationSeconds: number;
  private readonly purgeHooks: Array<(runId: string) => Promise<void>> = [];
  private lastReconcileAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly config: MeetingManagerConfig) {
    this.id = config.managerId ?? randomUUID();
    this.leaseTtlMs = config.leaseTtlMs ?? 60_000;
    this.noticeConfirmMs = config.noticeConfirmMs ?? 30_000;
    this.monitorHeartbeatMs = config.monitorHeartbeatMs ?? 10_000;
    this.monitorMissedBeats = config.monitorMissedBeats ?? 3;
    this.monitorRecoverMs = config.monitorRecoverMs ?? 30_000;
    this.dispatchRetryMs = config.dispatchRetryMs ?? 300_000;
    this.dispatchRetryDelayMs = config.dispatchRetryDelayMs ?? 15_000;
    this.killAfterMs = config.killAfterMs ?? 30_000;
    this.minReservationSeconds = config.minReservationSeconds ?? 600;
    this.purgeHooks.push(...(config.purgeHooks ?? []));
  }

  private get stores(): MeetingManagerStores {
    return this.config.stores;
  }

  private now(): number {
    return this.stores.clock.now();
  }

  // ── Providers and platforms ──

  /** Registers a provider under its name; a later provider with the same name replaces it. */
  registerProvider(provider: IMeetingBotProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** The provider registered under `name`, if there is one. */
  getProvider(name: string): IMeetingBotProvider | undefined {
    return this.providers.get(name);
  }

  /** The provider a send uses: the one named, or else the first registered provider that declares the platform. */
  providerFor(platform: MeetingPlatform, name?: string): IMeetingBotProvider | undefined {
    if (name) return this.providers.get(name);
    for (const p of this.providers.values()) if (p.platforms.includes(platform)) return p;
    return undefined;
  }

  /** Refuses new sends to the platform with `platform_paused`; runs already sent go on. */
  pausePlatform(platform: MeetingPlatform): void {
    this.paused.add(platform);
  }

  /** Takes new sends to the platform again. */
  resumePlatform(platform: MeetingPlatform): void {
    this.paused.delete(platform);
  }

  /** Whether new sends to the platform are refused. */
  isPaused(platform: MeetingPlatform): boolean {
    return this.paused.has(platform);
  }

  // ── Events ──

  /** Adds a handler for every event the manager emits; the function returned removes it. */
  on(handler: MeetingManagerEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  private async emit(type: MeetingEventType, run: MeetingRunRecord, data?: Record<string, unknown>, eventId?: string, at?: number): Promise<void> {
    const time = at ?? this.now();
    const id = eventId ?? (ONCE_EVENTS.has(type) ? `${run.runId}:${type}` : `${run.runId}:${type}:${time}:${randomUUID().slice(0, 8)}`);
    await this.deliver(await this.storeEvent({ id, type, at: time, data }, run.runId), run);
  }

  /**
   * Stores the event in its run's sequence and answers it as stored. An id stored before (a report the worker sent
   * again, or an emit tried again after a later step failed) is not stored twice: it comes back `repeated`, with the
   * time and payload of its first copy. An id that another run's event holds comes back undefined: nothing of this run.
   * A content event comes back as the store holds it, so a fence that went up while it was on its way, which left the
   * stored row no payload, leaves its delivery and its handlers none either.
   */
  private async storeEvent(event: Omit<StoredEvent, 'seq' | 'repeated'>, runId: string): Promise<StoredEvent | undefined> {
    const { inserted, seq } = await this.stores.events.append({ eventId: event.id, runId, type: event.type, at: event.at, data: event.data });
    if (inserted && !CONTENT_EVENT_TYPES.has(event.type)) return { ...event, seq, repeated: false };
    const [first] = await this.stores.events.read(runId, seq - 1, 1);
    if (first?.eventId !== event.id) return inserted ? { ...event, seq, repeated: false } : undefined;
    return { ...event, at: first.at, data: first.data, seq, repeated: !inserted };
  }

  /**
   * Delivers a stored event, with the run as it stands: a delivery to each of the owner's destinations, then every
   * handler. A repeated event goes to the destinations again, which the outbox keeps once each (a delivery its first
   * attempt never enqueued is enqueued now), and to no handler: a handler receives an event once.
   */
  private async deliver(stored: StoredEvent | undefined, run: MeetingRunRecord): Promise<void> {
    if (!stored) return;
    const { id, type, at, seq, data } = stored;
    if (this.config.destinationsFor) {
      const payload = JSON.stringify({ id, type, runId: run.runId, at, seq, data });
      for (const destinationRef of await this.config.destinationsFor(run.ownerRef)) {
        await this.stores.outbox.enqueue({ id: `${id}@${destinationRef}`, runId: run.runId, destinationRef, eventId: id, type, payload }, at);
      }
    }
    if (stored.repeated) return;
    const event: MeetingManagerEvent = { type, runId: run.runId, run, seq, data };
    for (const h of this.handlers) {
      try {
        const r = h(event);
        if (r instanceof Promise) r.catch((err) => this.config.logger?.error(`[MeetingManager] handler: ${String(err)}`));
      } catch (err) {
        this.config.logger?.error(`[MeetingManager] handler: ${String(err)}`);
      }
    }
  }

  // ── Sending ──

  /**
   * Sends a bot: answers the run an earlier send by the same owner with the same idempotency key made, checks the link
   * against the platform, reserves the run's time, stores the run and schedules its dispatch (now, or at `joinAt`). A
   * reservation that covers less than `minReservationSeconds` is released and the send refused. A limit the request
   * leaves out, or gives as `undefined`, takes its default. A send whose job store fails after the run is stored rejects
   * with that error; {@link MeetingManager.reconcile} then gives the run its job, so a send repeated with the same key
   * answers a run that is dispatched.
   *
   * @throws RangeError when `joinAt` or a limit the request gives is not a finite number (a limit must also be zero or more); nothing is reserved.
   */
  async sendBot(request: SendBotRequest): Promise<SendBotResult> {
    // a repeated send answers the run its key made, whatever changed since (a platform paused in between included)
    if (request.idempotencyKey !== undefined) {
      const existing = await this.stores.runs.findByIdempotencyKey(request.ownerRef, request.idempotencyKey);
      if (existing) return { ok: true, run: existing, repeated: true };
    }
    const provider = this.providerFor(request.platform, request.providerName);
    if (!provider) return { ok: false, reason: 'no_provider', message: `no provider for ${request.platform}` };
    const url = provider.checkJoinUrl(request.meetingUrl);
    if (!url.ok) return { ok: false, reason: 'invalid_url', message: url.message };
    if (url.platform !== request.platform) return { ok: false, reason: 'invalid_url', message: `the link is a ${url.platform} link` };
    if (this.paused.has(request.platform)) return { ok: false, reason: 'platform_paused', message: `${request.platform} is paused today` };
    const now = this.now();
    const joinAt = request.joinAt ?? now;
    // a NaN join time is never due: the run would wait for ever with its reservation held
    if (!Number.isFinite(joinAt)) throw new RangeError('joinAt must be a finite time in milliseconds');
    const limits = runLimits(request.limits);
    const runId = randomUUID();
    const reserved = await this.stores.entitlement.reserve({ ownerRef: request.ownerRef, runId, platform: request.platform, maxSeconds: Math.ceil(limits.totalMs / 1000) });
    if (!reserved.ok) return { ok: false, reason: reserved.reason, message: reserved.message };
    // written as "not at least" so that an answer that is not a number is refused too, rather than leaving the run without a cap
    if (!(reserved.maxSeconds >= this.minReservationSeconds)) {
      await this.stores.entitlement.release(reserved.reservationId);
      return { ok: false, reason: 'allowance', message: `under ${Math.round(this.minReservationSeconds / 60)} minutes left` };
    }
    limits.totalMs = Math.min(limits.totalMs, reserved.maxSeconds * 1000);
    const run: MeetingRunRecord = {
      runId,
      ownerRef: request.ownerRef,
      providerName: provider.name,
      platform: request.platform,
      state: joinAt > now ? 'scheduled' : 'requested',
      keep: request.keep,
      meetingUrl: request.meetingUrl,
      botName: request.botName,
      notice: request.notice,
      stopPhrase: request.stopPhrase,
      limits,
      idempotencyKey: request.idempotencyKey,
      transcriber: request.transcriber,
      requestedAt: now,
      joinAt,
      billedSeconds: 0,
      reservationId: reserved.reservationId,
      consentRecordId: request.consentRecordId,
      pageSeenAt: limits.pageAwayMs === undefined ? undefined : now,
    };
    try {
      await this.stores.runs.insert(run);
    } catch (err) {
      await this.stores.entitlement.release(reserved.reservationId);
      if (err instanceof DuplicateIdempotencyKeyError && request.idempotencyKey !== undefined) {
        const existing = await this.stores.runs.findByIdempotencyKey(request.ownerRef, request.idempotencyKey);
        if (existing) return { ok: true, run: existing, repeated: true };
      }
      throw err;
    }
    await this.stores.jobs.schedule({ runId, dispatchAt: joinAt });
    await this.emit('bot:requested', run, { platform: run.platform, joinAt });
    if (run.state === 'scheduled') await this.emit('bot:scheduled', run, { joinAt });
    return { ok: true, run, repeated: false };
  }

  // ── The loop ──

  /** Runs `tick()` every second until `stop()`. A host with its own scheduler calls `tick()` itself. */
  start(intervalMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.config.logger?.error(`[MeetingManager] tick: ${String(err)}`));
    }, intervalMs);
    this.timer.unref?.();
  }

  /** Stops the loop `start()` began; a pass already running finishes. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass: due jobs dispatched, limits enforced, kills issued, purges resumed, a reconcile every minute. Each step runs
   * even when an earlier one throws, so a dispatch that fails on one run never holds back the limits of the others (the
   * stop monitor's suspension among them); the first error is thrown once the pass is over.
   */
  async tick(): Promise<void> {
    let failure: { error: unknown } | undefined;
    const step = async (pass: () => Promise<void>): Promise<void> => {
      try {
        await pass();
      } catch (error) {
        failure ??= { error };
      }
    };
    await step(() => this.dispatchDue());
    await step(() => this.enforceLimits());
    await step(() => this.cleanupExpired());
    if (this.now() - this.lastReconcileAt >= 60_000) {
      this.lastReconcileAt = this.now();
      await step(() => this.reconcile());
    }
    if (failure) throw failure.error;
  }

  private async dispatchDue(): Promise<void> {
    for (;;) {
      const now = this.now();
      const job = await this.stores.jobs.lease(this.id, now, this.leaseTtlMs);
      if (!job) return;
      const run = await this.stores.runs.get(job.runId);
      if (!run || TERMINAL_RUN_STATES.has(run.state) || run.state === 'purging') {
        await this.stores.jobs.remove(job.runId);
        continue;
      }
      if (run.cleanupPending && ['requested', 'scheduled', 'dispatching'].includes(run.state)) {
        await this.fail(run, run.reason ?? 'crashed');
        continue;
      }
      if (run.state === 'dispatching') {
        // the lease of another manager expired in the middle of a dispatch: find out whether the bot is out
        await this.recoverDispatch(run);
        continue;
      }
      if (run.state === 'scheduled' && run.reservationId && !(await this.stores.entitlement.revalidate(run.reservationId))) {
        await this.stores.jobs.remove(job.runId);
        await this.fail(run, 'allowance');
        continue;
      }
      const dispatching = await this.stores.runs.update(run.runId, { state: 'dispatching', dispatchedAt: now }, ['requested', 'scheduled']);
      if (!dispatching) {
        // cancelled or purged between the lease and now: the job is finished
        await this.stores.jobs.remove(job.runId);
        continue;
      }
      await this.dispatch(dispatching);
    }
  }

  /** A run left in `dispatching` by a lease that expired: the bot is out (the provider knows the run) or it is not (dispatch again). */
  private async recoverDispatch(run: MeetingRunRecord): Promise<void> {
    const provider = this.providers.get(run.providerName);
    if (!provider) {
      await this.fail(run, 'crashed', 'provider not registered');
      return;
    }
    let alive = false;
    try {
      alive = (await provider.usage({ runIds: [run.runId] })).some((u) => u.runId === run.runId && u.alive);
    } catch (err) {
      this.config.logger?.warn(`[MeetingManager] usage of ${provider.name} unavailable during recovery of ${run.runId}: ${String(err)}`);
      if (await this.stores.jobs.release(run.runId, this.id, this.now() + this.dispatchRetryDelayMs)) {
        const job = await this.stores.jobs.get(run.runId);
        if (job?.cancelled) {
          const current = await this.stores.runs.get(run.runId);
          if (current) await this.fail(current, current.reason ?? 'stopped_by_owner');
        }
      }
      return;
    }
    if (alive) {
      const { recorded, cancelled } = await this.stores.jobs.markDispatched(run.runId, this.id, run.dispatch?.workerId);
      if (!recorded) return;
      if (cancelled) await this.leaveCancelled(run.runId);
      return;
    }
    const job = await this.stores.jobs.get(run.runId);
    if (!job || job.leaseHolder !== this.id) return;
    if (job.cancelled) {
      const current = await this.stores.runs.get(run.runId);
      if (current) await this.fail(current, current.reason ?? 'stopped_by_owner');
      return;
    }
    if (run.dispatch?.roomName) await this.config.room.delete(run.dispatch.roomName);
    const again = await this.stores.runs.update(run.runId, { dispatch: undefined }, 'dispatching');
    if (again) await this.dispatch(again);
  }

  private async dispatch(run: MeetingRunRecord): Promise<void> {
    const provider = this.providers.get(run.providerName);
    if (!provider) {
      await this.fail(run, 'crashed', 'provider not registered');
      return;
    }
    // the lease must still be ours before anything leaves this process: a holder that lost it stops here
    if (!(await this.stores.jobs.renew(run.runId, this.id, this.now(), this.leaseTtlMs))) {
      this.config.logger?.warn(`[MeetingManager] lease of ${run.runId} lost before dispatch`);
      return;
    }
    let room: MeetingRoomHandle;
    try {
      room = await this.config.room.create(run.runId);
    } catch (err) {
      // a room that cannot be made fails the dispatch as a provider's refusal does: tried again after the pause, ended at the deadline
      await this.dispatchFailed(run, err, undefined);
      return;
    }
    const workerToken = mintWorkerToken();
    const withDispatch = await this.stores.runs.update(run.runId, { dispatch: { roomName: room.name, workerTokenHash: hashWorkerToken(workerToken) } }, 'dispatching');
    if (!withDispatch) return;
    let result: DispatchResult;
    let leaseLost = false;
    let renewal = Promise.resolve();
    const timer = setInterval(() => {
      renewal = renewal.then(async () => {
        if (!(await this.stores.jobs.renew(run.runId, this.id, this.now(), this.leaseTtlMs))) leaseLost = true;
      }).catch(() => { leaseLost = true; });
    }, Math.max(1, Math.floor(this.leaseTtlMs / 3)));
    timer.unref?.();
    try {
      result = await provider.dispatch({ run: withDispatch, room: { url: room.url, name: room.name, publishToken: room.publishToken }, workerToken, reportUrl: this.config.reportUrlFor(run.runId, provider.name) });
    } catch (err) {
      clearInterval(timer);
      await renewal;
      if (leaseLost) return;
      await this.dispatchFailed(run, err, room.name);
      return;
    } finally {
      clearInterval(timer);
    }
    await renewal;
    if (leaseLost) return;
    const { recorded, cancelled } = await this.stores.jobs.markDispatched(run.runId, this.id, result.workerId);
    if (!recorded) return;
    const dispatched = await this.stores.runs.update(run.runId, { dispatch: { ...withDispatch.dispatch!, workerId: result.workerId, providerRunRef: result.providerRunRef } }, 'dispatching');
    if (dispatched) await this.emit('bot:dispatching', dispatched, { workerId: result.workerId });
    if (cancelled) await this.leaveCancelled(run.runId);
  }

  /**
   * A dispatch that failed before the bot was out, while this manager still holds the job: the room goes, then the run
   * ends (no capacity, a cancel that landed meanwhile, or the retry window past its due time) or its job is released to
   * be tried again after the pause.
   */
  private async dispatchFailed(run: MeetingRunRecord, err: unknown, roomName: string | undefined): Promise<void> {
    const job = await this.stores.jobs.get(run.runId);
    if (!job || job.leaseHolder !== this.id) return;
    if (roomName) await this.config.room.delete(roomName);
    if (err instanceof NoCapacityError || this.now() - run.joinAt > this.dispatchRetryMs) {
      const current = await this.stores.runs.get(run.runId);
      if (current) await this.fail(current, job.cancelled ? current.reason ?? 'stopped_by_owner' : err instanceof NoCapacityError ? 'no_capacity' : 'crashed');
      return;
    }
    // Keep dispatching: the forward-only graph allows retrying the same state.
    // Preserve the dispatch record so recovery checks whether the provider started a bot before its reply failed.
    if (!(await this.stores.jobs.release(run.runId, this.id, this.now() + this.dispatchRetryDelayMs))) return;
    const released = await this.stores.jobs.get(run.runId);
    if (released?.cancelled) {
      const current = await this.stores.runs.get(run.runId);
      if (current) await this.fail(current, current.reason ?? 'stopped_by_owner');
    }
  }

  /**
   * A cancel learned at `markDispatched`: the bot is out, so it is told to leave with the cancel's reason. The run is read
   * again first, since the bot's own first report (`joining`) may have moved it on while the dispatch was in flight.
   */
  private async leaveCancelled(runId: string): Promise<void> {
    const current = await this.stores.runs.get(runId);
    if (current) await this.leave(current, current.reason ?? 'stopped_by_owner');
  }

  // ── Reports ──

  /** A provider's report, from the product's events route. Verified by the provider, parsed, deduplicated, applied. */
  async processProviderEvent(providerName: string, ctx: ProviderEventContext): Promise<{ accepted: boolean; error?: string; applied: number }> {
    const provider = this.providers.get(providerName);
    if (!provider) return { accepted: false, error: 'unknown provider', applied: 0 };
    const run = ctx.runId ? await this.stores.runs.get(ctx.runId) : undefined;
    const verification = provider.verifyEvent(ctx, run);
    if (!verification.valid) return { accepted: false, error: verification.error ?? 'refused', applied: 0 };
    let parsed;
    try {
      parsed = provider.parseEvent(ctx);
    } catch {
      // a fixed answer: the parser's error may quote the report (a JSON.parse error quotes the input around the bad token), and a report carries what people said
      return { accepted: false, error: 'unparseable', applied: 0 };
    }
    let applied = 0;
    for (const event of parsed.events) {
      if (run && event.runId !== run.runId) continue;
      if (await this.apply(event)) applied += 1;
    }
    return { accepted: true, applied };
  }

  /**
   * The event a report is, whatever the run's state, for a report that is one: stored before the report is applied, it
   * is the report's record. A state report has none (the move it makes emits its event), and a heartbeat,
   * capture_started, done and crashed emit nothing of their own.
   */
  private ownEvent(event: NormalizedMeetingEvent): { type: MeetingEventType; data: Record<string, unknown> } | undefined {
    switch (event.type) {
      case 'participant_joined': return { type: 'bot:participant_joined', data: { participantRef: event.data?.participantRef } };
      case 'participant_left': return { type: 'bot:participant_left', data: { participantRef: event.data?.participantRef } };
      case 'chat_message': return { type: 'bot:chat_message', data: { text: event.data?.text, sender: event.data?.sender } };
      case 'stop_command': return { type: 'bot:stop_command', data: { sender: event.data?.sender } };
      case 'capture_suspended': return { type: 'bot:capture_suspended', data: {} };
      case 'usage': return { type: 'bot:usage', data: { seconds: event.data?.seconds ?? 0 } };
      case 'error': return { type: 'bot:error', data: { message: event.data?.message } };
      default: return undefined;
    }
  }

  private async apply(event: NormalizedMeetingEvent): Promise<boolean> {
    const run = await this.stores.runs.get(event.runId);
    if (!run || TERMINAL_RUN_STATES.has(run.state)) return false;
    const fenced = run.state === 'purging';
    // behind the fence nothing a person said or did is stored or forwarded: a late content report is dropped whole
    if (fenced && CONTENT_REPORTS.has(event.type)) return false;
    if (event.type === 'capture_started' && !this.captureReady(run)) {
      await this.emit('bot:error', run, { message: 'capture_started outside the capture interlock' }, `${event.eventId}#interlock`, event.at);
      return false;
    }
    // One row per report, the event the destinations and the handlers receive. A report that is an event of its own is
    // stored as that event before anything is applied, and the row is its record: a repeated one is stored nowhere, and
    // of its application only its deliveries and a stop are tried again. A state report stores the event of the move it
    // makes, and a repeated one moves nothing; a heartbeat (360 rows an hour would be noise), capture_started, done and
    // crashed store nothing, and applying one twice changes nothing.
    const own = this.ownEvent(event);
    const stored = own ? await this.storeEvent({ id: `${event.eventId}#${own.type}`, type: own.type, at: event.at, data: own.data }, run.runId) : undefined;
    if (own && (!stored || stored.repeated)) {
      // A repeated report was applied when its row was stored: applied again, an older count or total would overwrite a
      // newer one. Two parts of it are worth the worker's retry. Its deliveries go out again (the outbox keeps the first
      // of each, so one the first attempt never enqueued is enqueued now), and a stop the first attempt did not carry
      // out (the run is not behind the fence) is carried out now, whether or not the deliveries go out this time.
      const stop = this.isStop(run, event);
      try {
        await this.deliver(stored, run);
      } finally {
        if (stop) await this.purge(run, 'stopped_by_participant');
      }
      return stop;
    }
    switch (event.type) {
      case 'joining':
        await this.move(run, 'joining', {}, 'bot:joining', undefined, event);
        return true;
      case 'waiting_room':
        await this.move(run, 'waiting_room', {}, 'bot:waiting_room', undefined, event);
        return true;
      case 'in_call':
        await this.move(run, 'in_call_notice_pending', { joinedAt: event.at, participantCount: event.data?.participantCount, ...this.aloneTimer(run, event.data?.participantCount, event.at) }, 'bot:in_call', undefined, event);
        return true;
      case 'notice_posted': {
        // the notice alone does not open capture: the stop monitor must report a real observation after it (the interlock)
        const moved = await this.move(run, 'in_call', { noticePostedAt: event.at }, 'bot:notice_posted', { version: run.notice.version }, event);
        if (moved) await this.startCaptureIfReady(moved);
        return true;
      }
      case 'monitor_heartbeat': {
        // the stop monitor's own observation: the first after the notice opens capture, one after a suspension resumes it (the method holds every guard)
        const updated = await this.stores.runs.update(run.runId, { monitorSeenAt: event.at });
        if (updated) await this.startCaptureIfReady(updated);
        return true;
      }
      case 'capture_started':
        if (run.captureStartedAt === undefined) await this.stores.runs.update(run.runId, { captureStartedAt: event.at }, 'in_call');
        return true;
      case 'capture_suspended':
        await this.deliver(stored, run);
        return true;
      case 'participant_joined': {
        const updated = (await this.stores.runs.update(run.runId, { participantCount: event.data?.participantCount, ...this.aloneTimer(run, event.data?.participantCount, event.at) })) ?? run;
        await this.deliver(stored, updated);
        const provider = this.providers.get(run.providerName);
        if (updated.state === 'in_call' && provider?.capabilities.postsChat && !fenced) {
          await provider.command(run.runId, { name: 'postChat', text: run.notice.lateArrivalText });
        }
        return true;
      }
      case 'participant_left': {
        const updated = (await this.stores.runs.update(run.runId, { participantCount: event.data?.participantCount, ...this.aloneTimer(run, event.data?.participantCount, event.at) })) ?? run;
        await this.deliver(stored, updated);
        return true;
      }
      case 'chat_message':
      case 'stop_command':
        // a stop goes ahead even when the message's delivery fails; the delivery's error is raised once the purge has run
        try {
          await this.deliver(stored, run);
        } finally {
          if (this.isStop(run, event)) await this.purge(run, 'stopped_by_participant');
        }
        return true;
      case 'usage': {
        const updated = await this.stores.runs.update(run.runId, { lastUsageAt: event.at });
        if (run.reservationId && run.captureStartedAt !== undefined) await this.stores.entitlement.meter(run.reservationId, event.data?.seconds ?? 0);
        await this.deliver(stored, updated ?? run);
        return true;
      }
      case 'left': {
        const reason = run.reason ?? event.data?.reason ?? 'ended';
        if (run.state === 'purging') {
          await this.stores.runs.update(run.runId, { leftAt: event.at, reason, reportedSeconds: event.data?.seconds ?? run.reportedSeconds });
          return true;
        }
        // a bot that left on its own (not admitted, alone, the cap, a crash before a command) reaches `left` from any state after dispatch, with its own reason
        const left = await this.move(run, 'left', { leftAt: event.at, reason, reportedSeconds: event.data?.seconds ?? run.reportedSeconds, cleanupPending: true }, 'bot:left', { reason }, event);
        if (left) await this.complete(left, event.data?.seconds);
        return true;
      }
      case 'done':
        if (run.state === 'purging') await this.stores.runs.update(run.runId, { reportedSeconds: event.data?.seconds ?? run.reportedSeconds });
        else if (run.state === 'left' || run.state === 'leaving') await this.complete(run, event.data?.seconds);
        return true;
      case 'crashed':
        await this.crash(run, event.at, event.data?.seconds);
        return true;
      case 'error':
        await this.deliver(stored, run);
        return true;
    }
  }

  private isStopPhrase(run: MeetingRunRecord, text: string | undefined): boolean {
    return !!text && text.toLowerCase().includes(run.stopPhrase.toLowerCase());
  }

  /** Whether a report asks the bot to stop: a stop command, or a chat message holding the stop phrase. */
  private isStop(run: MeetingRunRecord, event: NormalizedMeetingEvent): boolean {
    return event.type === 'stop_command' || (event.type === 'chat_message' && this.isStopPhrase(run, event.data?.text));
  }

  /** The alone timer's patch for a report of `count` participants besides the bot: started by the first report of none, kept while there is none, cleared when one is reported. */
  private aloneTimer(run: MeetingRunRecord, count: number | undefined, at: number): Partial<MeetingRunRecord> {
    if (count === undefined) return {};
    return { aloneSince: count === 0 ? run.aloneSince ?? at : undefined };
  }

  /** Moves the run forward when the transition is allowed; a repeated state does nothing; a disallowed one is logged and dropped. */
  private async move(run: MeetingRunRecord, to: MeetingRunState, patch: Partial<MeetingRunRecord>, type: MeetingEventType, data: Record<string, unknown> | undefined, event: NormalizedMeetingEvent): Promise<MeetingRunRecord | undefined> {
    if (run.state === to) return run;
    if (!canTransition(run.state, to)) {
      this.config.logger?.warn(`[MeetingManager] ${run.runId}: ${run.state} -> ${to} refused`);
      return undefined;
    }
    const updated = await this.stores.runs.update(run.runId, { ...patch, state: to }, run.state);
    if (!updated) return undefined;
    await this.emitFrom(updated, type, data, event);
    return updated;
  }

  private emitFrom(run: MeetingRunRecord, type: MeetingEventType, data: Record<string, unknown> | undefined, event: NormalizedMeetingEvent): Promise<void> {
    return this.emit(type, run, data, `${event.eventId}#${type}`, event.at);
  }

  private captureReady(run: MeetingRunRecord): boolean {
    return run.state === 'in_call'
      && run.noticePostedAt !== undefined
      && run.monitorSeenAt !== undefined
      && run.monitorSeenAt >= run.noticePostedAt
      && this.now() - run.monitorSeenAt < this.monitorHeartbeatMs * this.monitorMissedBeats
      && run.captureSuspendedAt === undefined;
  }

  /** The capture interlock: `in_call`, the notice confirmed, and the stop monitor's own observation reported after the notice, no fence. */
  private async startCaptureIfReady(run: MeetingRunRecord): Promise<void> {
    if (run.state !== 'in_call' || run.noticePostedAt === undefined || run.monitorSeenAt === undefined) return;
    if (run.monitorSeenAt < run.noticePostedAt) return; // a heartbeat from before the notice proves nothing about the chat being watched now
    if (this.now() - run.monitorSeenAt >= this.monitorHeartbeatMs * this.monitorMissedBeats) return;
    if (run.captureStartedAt !== undefined && run.captureSuspendedAt === undefined) return; // already capturing
    const provider = this.providers.get(run.providerName);
    if (!provider) return;
    await provider.command(run.runId, { name: 'startCapture' });
    // the suspension is on the run, so the manager that hears the monitor recover resumes capture, whichever one suspended it
    const started = await this.stores.runs.update(run.runId, { captureStartedAt: run.captureStartedAt ?? this.now(), captureSuspendedAt: undefined }, 'in_call');
    if (started) await this.emit('bot:capture_started', started, { resumed: run.captureStartedAt !== undefined });
  }

  // ── Owner commands ──

  /** The bot leaves; the run's data stays under its Keep. Before dispatch the run ends; during a dispatch the cancel becomes a leave. */
  async leaveBot(runId: string, reason: MeetingLeaveReason = 'stopped_by_owner'): Promise<boolean> {
    const run = await this.stores.runs.get(runId);
    if (!run) return false;
    if (run.state === 'dispatching') {
      await this.stores.runs.update(runId, { reason }, 'dispatching');
      const result = await this.stores.jobs.cancel(runId);
      if (result === 'already_dispatched') {
        const current = await this.stores.runs.get(runId);
        return current ? this.leave(current, reason) : false;
      }
      const job = await this.stores.jobs.get(runId);
      if (job && job.leaseHolder === undefined) await this.fail(run, reason);
      return true;
    }
    if (run.state === 'requested' || run.state === 'scheduled') {
      const cancelled = await this.stores.jobs.cancel(runId);
      if (cancelled === 'already_dispatched') {
        // the job was dispatched after the read above, so the run is past `requested`, which cannot move to `leaving`: leave from the state it is in now
        const current = await this.stores.runs.get(runId);
        return current ? this.leave(current, reason) : false;
      }
      const stillWaiting = await this.stores.runs.update(runId, { reason }, ['requested', 'scheduled']);
      if (!stillWaiting) {
        // a dispatcher took the run between the read and the cancel: it learns the cancel at markDispatched and tells the bot to leave with this reason
        await this.stores.runs.update(runId, { reason }, 'dispatching');
        return true;
      }
      await this.stores.jobs.remove(runId);
      await this.fail(stillWaiting, reason);
      return true;
    }
    return this.leave(run, reason);
  }

  /** The bot leaves and everything it took is deleted (the purge sequence). On a run that is already done, the kept content is deleted (a session's deletion). */
  async purgeRun(runId: string, reason: MeetingLeaveReason = 'stopped_by_owner'): Promise<boolean> {
    const run = await this.stores.runs.get(runId);
    if (!run) return false;
    if (run.state === 'done') return this.purgeKept(run);
    if (run.state === 'failed') return false;
    await this.purge(run, reason);
    return true;
  }

  /** A kept run's content removed after `done`: the fences, the stores, the hooks, the provider's copies, `bot:purged`, the content-free row. A step that throws is the caller's to retry (the product's one purge path retries). */
  private async purgeKept(run: MeetingRunRecord): Promise<boolean> {
    if (run.purgedAt !== undefined) return true;
    await this.stores.transcript.fence(run.runId);
    await this.stores.events.fence(run.runId);
    await this.stores.outbox.purgeContent(run.runId);
    await this.stores.transcript.purge(run.runId);
    await this.stores.events.purgePayloads(run.runId);
    await this.stores.outbox.purgeContent(run.runId);
    for (const hook of this.purgeHooks) await hook(run.runId);
    await this.providers.get(run.providerName)?.deleteRun({ runId: run.runId });
    const free = { ...contentFreeRun(run), purgedAt: this.now() };
    // the event goes out before the row is rewritten, the last step: a call whose event fails to go out leaves purgedAt
    // unset, so the caller's retry runs the steps again and sends it, where after the rewrite a retry returns at once
    await this.emit('bot:purged', free, { reason: 'deleted' });
    await this.stores.runs.replace(free);
    return true;
  }

  /** Posts to the meeting's chat through the run's bot; false unless the run is in the call and its provider posts to chat. */
  async postChat(runId: string, text: string): Promise<boolean> {
    const run = await this.stores.runs.get(runId);
    const provider = run && this.providers.get(run.providerName);
    if (!run || !provider || !provider.capabilities.postsChat || run.state !== 'in_call') return false;
    await provider.command(runId, { name: 'postChat', text });
    return true;
  }

  /** A run sent from a page: the page is still there. */
  async pageSeen(runId: string): Promise<void> {
    await this.stores.runs.update(runId, { pageSeenAt: this.now() });
  }

  /** Adds a step to the purge sequence, as {@link MeetingManagerConfig.purgeHooks} does. */
  addPurgeHook(hook: (runId: string) => Promise<void>): void {
    this.purgeHooks.push(hook);
  }

  /** The run's row, or undefined when there is none. */
  getRun(runId: string): Promise<MeetingRunRecord | undefined> {
    return this.stores.runs.get(runId);
  }

  /** The runs the filter selects, newest first, as the run store's {@link IRunStore.list} answers them. */
  listRuns(filter: { ownerRef?: string; states?: readonly MeetingRunState[]; since?: number; limit?: number }): Promise<MeetingRunRecord[]> {
    return this.stores.runs.list(filter);
  }

  // ── Ends ──

  /**
   * Moves the run to `leaving` (a run behind the fence stays `purging`), arms the kill and tells the bot to leave. The
   * kill's deadline is armed on the run before the command goes, so a leave the bot never receives still ends in the
   * kill, and whichever manager runs the limits, after a restart too, sends it.
   */
  private async leave(run: MeetingRunRecord, reason: MeetingLeaveReason): Promise<boolean> {
    if (!canTransition(run.state, 'leaving') && run.state !== 'purging') return false;
    const armed: Partial<MeetingRunRecord> = run.state === 'purging' ? { leaveCommandedAt: this.now() } : { state: 'leaving', reason, leaveCommandedAt: this.now() };
    if (!(await this.stores.runs.update(run.runId, armed, run.state))) return false;
    await this.sendCommand(run, { name: 'leave', reason });
    return true;
  }

  /**
   * Sends a command on the way out (suspend, leave, kill) to the run's bot. A command that fails, its worker unreachable
   * for a moment, is logged and not thrown: the kill armed before it, and the end recorded after the kill, cover a bot
   * that never received it.
   */
  private async sendCommand(run: MeetingRunRecord, command: ProviderCommand): Promise<void> {
    try {
      await this.providers.get(run.providerName)?.command(run.runId, command);
    } catch (err) {
      this.config.logger?.warn(`[MeetingManager] ${command.name} to the bot of ${run.runId} failed: ${String(err)}`);
    }
  }

  /** A run that ends before it joined (a failed revalidation, no capacity, a cancel): never billed. */
  private async fail(run: MeetingRunRecord, reason: MeetingLeaveReason, message?: string): Promise<void> {
    const current = await this.stores.runs.get(run.runId);
    if (!current || !['requested', 'scheduled', 'dispatching'].includes(current.state)) return;
    // update re-reads under the anchor and checks this exact non-purging state.
    const pending = await this.stores.runs.update(current.runId, { reason: current.reason ?? reason, cleanupPending: true }, current.state);
    if (!pending) return;
    await this.stores.transcript.fence(run.runId);
    await this.stores.events.fence(run.runId);
    await this.stores.outbox.purgeContent(run.runId);
    await this.stores.transcript.purge(run.runId);
    await this.stores.events.purgePayloads(run.runId);
    if (pending.reservationId) await this.stores.entitlement.release(pending.reservationId);
    if (pending.dispatch?.roomName) await this.config.room.delete(pending.dispatch.roomName);
    await this.stores.jobs.remove(run.runId);
    const now = this.now();
    const failed = await this.stores.runs.update(run.runId, { ...contentFreeRun(pending), dispatch: undefined, transcriber: undefined, pageSeenAt: undefined, lastUsageAt: undefined, reportedSeconds: undefined, monitorSeenAt: undefined, participantCount: undefined, leaveCommandedAt: undefined, captureSuspendedAt: undefined, aloneSince: undefined, state: 'failed', leftAt: now, doneAt: now, billedSeconds: 0, cleanupPending: false }, pending.state);
    if (!failed) return;
    await this.emit('bot:left', failed, { reason: failed.reason, message });
    await this.emit('bot:done', failed, { reason: failed.reason, billedSeconds: 0 });
  }

  /**
   * After `left` (no purge): settle or release, drop what is not kept, delete the room, remove the job, and only then
   * `done`. A step that throws leaves the run in `left` with `cleanupPending`, and the next tick calls this again; the
   * entitlement hook's `settle` and `release` are idempotent, so a retry after a half-done cleanup changes nothing twice.
   */
  private async complete(run: MeetingRunRecord, reportedSeconds: number | undefined): Promise<void> {
    const current = await this.stores.runs.get(run.runId);
    if (!current || (current.state !== 'left' && current.state !== 'leaving')) return;
    if (current.state === 'leaving') {
      const left = await this.stores.runs.update(run.runId, { state: 'left', leftAt: current.leftAt ?? this.now(), cleanupPending: true, reportedSeconds: reportedSeconds ?? current.reportedSeconds }, 'leaving');
      if (!left) return;
      await this.emit('bot:left', left, { reason: left.reason });
      run = left;
    } else run = current;
    const now = this.now();
    const seconds = reportedSeconds ?? run.reportedSeconds ?? Math.max(0, Math.round(((run.leftAt ?? now) - (run.dispatchedAt ?? run.joinAt)) / 1000));
    const billed = isBilledEnd(run) ? seconds : 0;
    try {
      await this.stores.transcript.fence(run.runId);
      if (run.reservationId) {
        if (billed > 0) await this.stores.entitlement.settle(run.reservationId, billed);
        else await this.stores.entitlement.release(run.reservationId);
      }
      if (run.keep === 'none') {
        await this.stores.events.fence(run.runId);
        await this.stores.outbox.purgeContent(run.runId);
        await this.stores.transcript.purge(run.runId);
        await this.stores.events.purgePayloads(run.runId);
      }
      if (run.dispatch?.roomName) await this.config.room.delete(run.dispatch.roomName);
      await this.stores.jobs.remove(run.runId);
    } catch (err) {
      this.config.logger?.warn(`[MeetingManager] cleanup of ${run.runId} retried on the next tick: ${String(err)}`);
      await this.stores.runs.update(run.runId, { reportedSeconds: seconds, cleanupPending: true }, 'left');
      return;
    }
    const free = contentFreeRun(run);
    const kept = run.keep === 'none' ? free : { ...free, botName: run.botName, notice: run.notice };
    const done = await this.stores.runs.update(run.runId, { ...kept, dispatch: undefined, transcriber: undefined, pageSeenAt: undefined, lastUsageAt: undefined, reportedSeconds: undefined, monitorSeenAt: undefined, participantCount: undefined, leaveCommandedAt: undefined, captureSuspendedAt: undefined, aloneSince: undefined, state: 'done', doneAt: now, billedSeconds: billed, cleanupPending: false }, 'left');
    if (!done) return;
    await this.emit('bot:done', done, { reason: done.reason, billedSeconds: billed });
  }

  private async crash(run: MeetingRunRecord, at: number, seconds: number | undefined): Promise<void> {
    const current = await this.stores.runs.get(run.runId);
    if (!current || TERMINAL_RUN_STATES.has(current.state)) return;
    if (current.state === 'purging') {
      await this.stores.runs.update(run.runId, { leftAt: at, reportedSeconds: seconds ?? current.reportedSeconds }, 'purging');
      return;
    }
    const expected = ACTIVE_STATES.filter((state) => state !== 'purging');
    if (!expected.includes(current.state)) return;
    // The store re-reads under the anchor; a purge between get and update fails this exact-state guard.
    const left = await this.stores.runs.update(run.runId, { state: 'left', leftAt: at, reason: current.reason ?? 'crashed', reportedSeconds: seconds ?? current.reportedSeconds, cleanupPending: true }, current.state);
    if (!left) {
      const fenced = await this.stores.runs.get(run.runId);
      if (fenced?.state === 'purging') await this.stores.runs.update(run.runId, { leftAt: at, reportedSeconds: seconds ?? fenced.reportedSeconds }, 'purging');
      return;
    }
    await this.emit('bot:left', left, { reason: left.reason });
    await this.complete(left, seconds);
  }

  // ── The purge sequence ──

  /** (a) the fence; (b) the purge, each step retried until it resolves; (c) the content-free record. */
  private async purge(run: MeetingRunRecord, reason: MeetingLeaveReason): Promise<void> {
    if (run.state !== 'purging') {
      // a bot that may be out is told to leave below: the kill's deadline goes on the run with the fence, before the commands
      const fenced = await this.stores.runs.update(run.runId, { state: 'purging', reason, ...(run.dispatch ? { leaveCommandedAt: this.now() } : {}) }, PURGEABLE_STATES);
      if (!fenced) return;
      await this.stores.transcript.fence(run.runId);
      await this.stores.events.fence(run.runId);
      await this.stores.outbox.purgeContent(run.runId);
      // decided on the row the fence wrote, not on the read before it: a dispatcher may have taken the run in between,
      // written its dispatch record and started a bot. With no dispatch record no bot can start (the dispatcher's write of
      // one expects `dispatching`); with one, the bot is told at once unless it has already left.
      if (fenced.dispatch === undefined) {
        await this.stores.jobs.cancel(run.runId);
        await this.stores.jobs.remove(run.runId);
      } else if (fenced.leftAt === undefined) {
        // the kill is armed first, so a suspend or a leave the bot never receives still ends in the kill; a fence written
        // without its deadline (a dispatcher took the run after the read above) has it written here, before the commands
        if (fenced.leaveCommandedAt === undefined) await this.stores.runs.update(run.runId, { leaveCommandedAt: this.now() }, 'purging');
        await this.sendCommand(run, { name: 'suspendCapture' });
        await this.sendCommand(run, { name: 'leave', reason });
      }
    }
    await this.continuePurge(run.runId);
  }

  /** The steps after the fence, in order; a step that throws is retried on the next tick, and a restart resumes here through `reconcile`. */
  private async continuePurge(runId: string): Promise<void> {
    const run = await this.stores.runs.get(runId);
    if (!run || run.state !== 'purging') return;
    const provider = this.providers.get(run.providerName);
    try {
      // the stores' content goes at once: behind the fence nothing new is written, so these steps need not wait for the bot
      await this.stores.transcript.purge(runId);
      await this.stores.events.purgePayloads(runId);
      await this.stores.outbox.purgeContent(runId);
      const stillInCall = run.dispatch !== undefined && run.leftAt === undefined;
      if (stillInCall) return; // the bot has not left yet; the kill timer and the left report bring us back
      for (const hook of this.purgeHooks) await hook(runId);
      if (provider) await provider.deleteRun({ runId });
      if (run.dispatch?.roomName) await this.config.room.delete(run.dispatch.roomName);
    } catch (err) {
      this.config.logger?.warn(`[MeetingManager] purge of ${runId} retried: ${String(err)}`);
      return;
    }
    const now = this.now();
    const seconds = run.reportedSeconds ?? Math.max(0, Math.round(((run.leftAt ?? now) - (run.dispatchedAt ?? run.joinAt)) / 1000));
    const billed = isBilledEnd(run) ? seconds : 0;
    if (run.reservationId) {
      if (billed > 0) await this.stores.entitlement.settle(run.reservationId, billed);
      else await this.stores.entitlement.release(run.reservationId);
    }
    await this.stores.jobs.remove(runId);
    // The events go out before the last write: events that fail to go out leave the run purging, and the next pass runs
    // these steps again, the events (stored once, delivered again) and the write with them. After the write nothing
    // would return to a done run to send them, and no other path writes this run's end, so the events cannot announce
    // an end that does not come.
    const done: MeetingRunRecord = { ...contentFreeRun(run), state: 'done', doneAt: now, purgedAt: now, billedSeconds: billed };
    await this.emit('bot:purged', done, { reason: done.reason });
    await this.emit('bot:done', done, { reason: done.reason, billedSeconds: billed });
    // one write, `done` and the content-free row together as complete() and fail() write theirs: a failure after a first
    // write of `done` would leave a done row holding the url, the bot's name and the notice, and nothing returns to a done run
    await this.stores.runs.update(runId, { ...done, dispatch: undefined, transcriber: undefined, pageSeenAt: undefined, lastUsageAt: undefined, reportedSeconds: undefined, monitorSeenAt: undefined, participantCount: undefined, leaveCommandedAt: undefined, captureSuspendedAt: undefined, aloneSince: undefined, cleanupPending: false }, 'purging');
  }

  // ── The limits ──

  /**
   * Each run's limits, kills, resumed purges and retried cleanups, in turn. A run whose step throws (a cleanup, a settle,
   * a command) holds back no other run's, the stop monitor's suspension among them: it is tried again on the next pass,
   * and the first error is thrown once every run has had its turn.
   */
  private async enforceLimits(): Promise<void> {
    const now = this.now();
    const runs = await this.stores.runs.list({ states: ['requested', 'scheduled', ...ACTIVE_STATES], limit: Number.MAX_SAFE_INTEGER });
    let failure: { error: unknown } | undefined;
    for (const run of runs) {
      try {
        if (run.cleanupPending && ['requested', 'scheduled', 'dispatching'].includes(run.state)) {
          await this.fail(run, run.reason ?? 'crashed');
          continue;
        }
        if (run.state === 'requested' || run.state === 'scheduled') continue;
        const provider = this.providers.get(run.providerName);
        // the kill's deadline is on the run, so a bot that has not left is killed whichever manager told it to leave, after a
        // restart too, and the bot's leaving (`leftAt`) disarms it. The end is recorded whether or not the kill reaches the
        // bot: the cleanup that follows deletes its room
        if (run.leaveCommandedAt !== undefined && run.leftAt === undefined && now - run.leaveCommandedAt > this.killAfterMs) {
          await this.sendCommand(run, { name: 'kill' });
          await this.crash(run, now, undefined);
          continue;
        }
        if (run.state === 'purging') {
          await this.continuePurge(run.runId);
          continue;
        }
        if (run.state === 'left') {
          // a cleanup that threw last time is tried again here, until `done` is written
          await this.complete(run, undefined);
          continue;
        }
        if (run.state === 'leaving') continue;
        // a cancel that leaveBot wrote during a dispatch, with no dispatcher left to act on it: the dispatcher stopped, so the
        // cancelled job is never leased again and no markDispatched learns it. The leave goes from here, from whatever state
        // the bot's own reports have moved the run to; a dispatch still under a live lease learns it at markDispatched.
        if (run.reason !== undefined && !(run.state === 'dispatching' && (await this.dispatchLeaseLive(run.runId, now)))) {
          await this.leave(run, run.reason);
          continue;
        }
        const since = run.dispatchedAt ?? run.joinAt;
        if (now - since > run.limits.totalMs) {
          await this.leave(run, 'cap');
          continue;
        }
        if (run.state === 'waiting_room' && now - (run.joinedAt ?? since) > run.limits.waitingRoomMs) {
          await this.leave(run, 'not_admitted');
          continue;
        }
        if (run.state === 'in_call_notice_pending' && run.joinedAt !== undefined && now - run.joinedAt > this.noticeConfirmMs) {
          await this.leave(run, 'notice_failed');
          continue;
        }
        if (run.state === 'in_call') {
          // quiet once monitorMissedBeats intervals have passed since the last heartbeat, the boundary captureReady and startCaptureIfReady use
          const monitorStale = run.monitorSeenAt !== undefined && now - run.monitorSeenAt >= this.monitorHeartbeatMs * this.monitorMissedBeats;
          if (monitorStale) {
            if (run.captureSuspendedAt === undefined) {
              // kept on the run: the manager that hears the monitor recover resumes capture, and the recovery window holds after a restart
              const suspended = await this.stores.runs.update(run.runId, { captureSuspendedAt: now }, 'in_call');
              if (suspended) {
                await provider?.command(run.runId, { name: 'suspendCapture' });
                await this.emit('bot:capture_suspended', suspended, { reason: 'stop monitor quiet' });
              }
            } else if (now - run.captureSuspendedAt > this.monitorRecoverMs) {
              await this.leave(run, 'stop_monitor_failed');
              continue;
            }
          }
          if (run.aloneSince !== undefined && now - run.aloneSince > run.limits.aloneMs) {
            await this.leave(run, 'alone');
            continue;
          }
          if (run.limits.pageAwayMs !== undefined && run.pageSeenAt !== undefined && now - run.pageSeenAt > run.limits.pageAwayMs) {
            await this.leave(run, 'page_away');
            continue;
          }
        }
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }

  /** Whether a dispatcher still holds the run's job under a lease that has not run out. */
  private async dispatchLeaseLive(runId: string, now: number): Promise<boolean> {
    const job = await this.stores.jobs.get(runId);
    return job !== undefined && job.leaseHolder !== undefined && job.leaseExpiresAt !== undefined && job.leaseExpiresAt > now;
  }

  /** Evicts completed in-memory runs after the grace. Durable stores omit forget and keep their terminal records. */
  private async cleanupExpired(): Promise<void> {
    const { runs, jobs, transcript, events, outbox, entitlement } = this.stores;
    if (!runs.forget || !jobs.forget || !transcript.forget || !events.forget || !outbox.forget) return;
    const grace = Math.max(86_400_000, this.config.forgetAfterMs ?? 172_800_000);
    for (const run of await runs.list({ states: ['done', 'failed'], limit: Number.MAX_SAFE_INTEGER })) {
      if (run.doneAt === undefined || this.now() - Math.max(run.doneAt, run.purgedAt ?? 0) < grace) continue;
      if (run.keep === 'account' && run.purgedAt === undefined && run.state !== 'failed') continue;
      const deliveries = await outbox.listByRun(run.runId);
      if (deliveries.some((d) => d.state === 'pending')) continue;
      await transcript.forget(run.runId);
      await events.forget(run.runId);
      await outbox.forget(run.runId);
      await jobs.forget(run.runId);
      await entitlement.forget?.(run.runId);
      await runs.forget(run.runId);
    }
  }

  // ── Reconcile ──

  /**
   * Compares dispatched jobs with the providers' usage: a run whose container is gone is ended as crashed; an unfinished
   * purge is resumed. A run still waiting for its dispatch whose job is missing (a send whose job could not be stored)
   * is given its job again, and one a cancel left without its job (the cancel's reason is on the run) is ended, so
   * neither waits for ever holding its reservation. As in the limits, a run whose step throws holds back no other, and
   * the first error is thrown at the end.
   */
  async reconcile(): Promise<void> {
    const now = this.now();
    let failure: { error: unknown } | undefined;
    const byProvider = new Map<string, string[]>();
    for (const job of await this.stores.jobs.listDispatched()) {
      try {
        const run = await this.stores.runs.get(job.runId);
        if (!run) {
          await this.stores.jobs.remove(job.runId);
          continue;
        }
        if (run.state === 'purging') {
          await this.continuePurge(run.runId);
          continue;
        }
        if (!ACTIVE_STATES.includes(run.state) || run.state === 'dispatching') continue;
        const list = byProvider.get(run.providerName) ?? [];
        list.push(run.runId);
        byProvider.set(run.providerName, list);
      } catch (error) {
        failure ??= { error };
      }
    }
    for (const [providerName, runIds] of byProvider) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;
      let usage;
      try {
        usage = await provider.usage({ runIds });
      } catch (err) {
        this.config.logger?.warn(`[MeetingManager] usage of ${providerName} unavailable: ${String(err)}`);
        continue;
      }
      for (const u of usage) {
        if (u.alive) continue;
        try {
          const run = await this.stores.runs.get(u.runId);
          if (run && (run.state === 'joining' || run.state === 'waiting_room' || run.state === 'in_call_notice_pending' || run.state === 'in_call' || run.state === 'leaving')) {
            this.config.logger?.warn(`[MeetingManager] ${run.runId}: worker reports no container; ending as crashed`);
            await this.crash(run, now, u.seconds || undefined);
          }
        } catch (error) {
          failure ??= { error };
        }
      }
    }
    // only a job is ever dispatched: a waiting run without one would hold its reservation for ever. A run whose end has
    // begun (cleanupPending) is the limits pass's to finish.
    for (const run of await this.stores.runs.list({ states: ['requested', 'scheduled'], limit: Number.MAX_SAFE_INTEGER })) {
      try {
        if (run.cleanupPending || (await this.stores.jobs.get(run.runId))) continue;
        if (run.reason !== undefined) await this.fail(run, run.reason);
        else await this.stores.jobs.schedule({ runId: run.runId, dispatchAt: run.joinAt });
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }

  // ── The transcript ──

  /** A turn the listen session wrote: a `bot:transcript` event, stored and forwarded, unless the run is behind the fence or over. */
  async recordTranscript(turn: TranscriptTurn): Promise<boolean> {
    const run = await this.stores.runs.get(turn.runId);
    if (!run || run.state === 'purging' || TERMINAL_RUN_STATES.has(run.state) || await this.stores.transcript.isFenced(turn.runId)) return false;
    await this.emit('bot:transcript', run, { seq: turn.seq, turnId: turn.turnId, text: turn.text, speaker: turn.speaker, startMs: turn.startMs, endMs: turn.endMs }, `${turn.runId}:transcript:${turn.seq}`, turn.at);
    return true;
  }

  /** The sink a listen session writes to for one run: the transcript store behind the fence, then the event above. */
  transcriptSink(runId: string): ITranscriptInputSink {
    return new MeetingTranscriptSink({ manager: this, transcript: this.stores.transcript, runId });
  }
}
