/**
 * @module channels/meetings/MeetingManager
 *
 * Owns a run's life: the state machine, the capture interlock, the stop
 * command, the purge sequence behind its fence, the limits, the meter and the
 * reconciliation. Keeps nothing durable itself: every row is in an injected
 * store, so several manager processes may share one database.
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
  /** Runs whose capture is suspended, with the time of the suspension. */
  private readonly suspendedAt = new Map<string, number>();
  /** Runs told to leave, with the time, for the kill after `killAfterMs`. */
  private readonly leaveAt = new Map<string, number>();
  /** Runs alone, with the time they became alone. */
  private readonly aloneSince = new Map<string, number>();
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
    const { inserted, seq } = await this.stores.events.append({ eventId: id, runId: run.runId, type, at: time, data });
    if (!inserted) return;
    const event: MeetingManagerEvent = { type, runId: run.runId, run, seq, data };
    if (this.config.destinationsFor) {
      const payload = JSON.stringify({ id, type, runId: run.runId, at: time, seq, data });
      for (const destinationRef of await this.config.destinationsFor(run.ownerRef)) {
        await this.stores.outbox.enqueue({ id: `${id}@${destinationRef}`, runId: run.runId, destinationRef, eventId: id, type, payload }, time);
      }
    }
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
   * leaves out, or gives as `undefined`, takes its default.
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

  private typeOf(event: NormalizedMeetingEvent): MeetingEventType | undefined {
    switch (event.type) {
      case 'joining': return 'bot:joining';
      case 'waiting_room': return 'bot:waiting_room';
      case 'in_call': return 'bot:in_call';
      case 'notice_posted': return 'bot:notice_posted';
      case 'participant_joined': return 'bot:participant_joined';
      case 'participant_left': return 'bot:participant_left';
      case 'chat_message': return 'bot:chat_message';
      case 'stop_command': return 'bot:stop_command';
      case 'capture_suspended': return 'bot:capture_suspended';
      case 'usage': return 'bot:usage';
      case 'left': return 'bot:left';
      case 'error': return 'bot:error';
      default: return undefined; // heartbeats, capture_started, done and crashed are applied without an event of their own
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
    if (event.type !== 'monitor_heartbeat') {
      // heartbeats are not stored: a repeated one is harmless, and 360 rows an hour would be noise
      const dedup = await this.stores.events.append({ eventId: event.eventId, runId: run.runId, type: this.typeOf(event) ?? 'bot:usage', at: event.at, data: event.data });
      if (!dedup.inserted) return false;
    }
    switch (event.type) {
      case 'joining':
        await this.move(run, 'joining', {}, 'bot:joining', undefined, event);
        return true;
      case 'waiting_room':
        await this.move(run, 'waiting_room', {}, 'bot:waiting_room', undefined, event);
        return true;
      case 'in_call':
        await this.move(run, 'in_call_notice_pending', { joinedAt: event.at, participantCount: event.data?.participantCount }, 'bot:in_call', undefined, event);
        this.trackAlone(run.runId, event.data?.participantCount, event.at);
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
        await this.emitFrom(run, 'bot:capture_suspended', {}, event);
        return true;
      case 'participant_joined': {
        const updated = (await this.stores.runs.update(run.runId, { participantCount: event.data?.participantCount })) ?? run;
        this.trackAlone(run.runId, event.data?.participantCount, event.at);
        await this.emitFrom(updated, 'bot:participant_joined', { participantRef: event.data?.participantRef }, event);
        const provider = this.providers.get(run.providerName);
        if (updated.state === 'in_call' && provider?.capabilities.postsChat && !fenced) {
          await provider.command(run.runId, { name: 'postChat', text: run.notice.lateArrivalText });
        }
        return true;
      }
      case 'participant_left': {
        const updated = (await this.stores.runs.update(run.runId, { participantCount: event.data?.participantCount })) ?? run;
        this.trackAlone(run.runId, event.data?.participantCount, event.at);
        await this.emitFrom(updated, 'bot:participant_left', { participantRef: event.data?.participantRef }, event);
        return true;
      }
      case 'chat_message': {
        await this.emitFrom(run, 'bot:chat_message', { text: event.data?.text, sender: event.data?.sender }, event);
        if (!fenced && this.isStopPhrase(run, event.data?.text)) await this.purge(run, 'stopped_by_participant');
        return true;
      }
      case 'stop_command':
        await this.emitFrom(run, 'bot:stop_command', { sender: event.data?.sender }, event);
        if (!fenced) await this.purge(run, 'stopped_by_participant');
        return true;
      case 'usage': {
        const seconds = event.data?.seconds ?? 0;
        const updated = await this.stores.runs.update(run.runId, { lastUsageAt: event.at });
        if (run.reservationId && run.captureStartedAt !== undefined) await this.stores.entitlement.meter(run.reservationId, seconds);
        await this.emitFrom(updated ?? run, 'bot:usage', { seconds }, event);
        return true;
      }
      case 'left': {
        const reason = run.reason ?? event.data?.reason ?? 'ended';
        this.leaveAt.delete(run.runId);
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
        await this.emitFrom(run, 'bot:error', { message: event.data?.message }, event);
        return true;
    }
  }

  private isStopPhrase(run: MeetingRunRecord, text: string | undefined): boolean {
    return !!text && text.toLowerCase().includes(run.stopPhrase.toLowerCase());
  }

  private trackAlone(runId: string, count: number | undefined, at: number): void {
    if (count === undefined) return;
    if (count === 0) {
      if (!this.aloneSince.has(runId)) this.aloneSince.set(runId, at);
    } else this.aloneSince.delete(runId);
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
      && !this.suspendedAt.has(run.runId);
  }

  /** The capture interlock: `in_call`, the notice confirmed, and the stop monitor's own observation reported after the notice, no fence. */
  private async startCaptureIfReady(run: MeetingRunRecord): Promise<void> {
    if (run.state !== 'in_call' || run.noticePostedAt === undefined || run.monitorSeenAt === undefined) return;
    if (run.monitorSeenAt < run.noticePostedAt) return; // a heartbeat from before the notice proves nothing about the chat being watched now
    if (this.now() - run.monitorSeenAt >= this.monitorHeartbeatMs * this.monitorMissedBeats) return;
    if (run.captureStartedAt !== undefined && !this.suspendedAt.has(run.runId)) return; // already capturing
    const provider = this.providers.get(run.providerName);
    if (!provider) return;
    await provider.command(run.runId, { name: 'startCapture' });
    this.suspendedAt.delete(run.runId);
    const started = await this.stores.runs.update(run.runId, { captureStartedAt: run.captureStartedAt ?? this.now() }, 'in_call');
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
      if (cancelled === 'already_dispatched') return this.leave(run, reason);
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

  /** A kept run's content removed after `done`: the fences, the stores, the hooks, the provider's copies, the content-free row, `bot:purged`. A step that throws is the caller's to retry (the product's one purge path retries). */
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
    await this.stores.runs.replace(free);
    await this.emit('bot:purged', free, { reason: 'deleted' });
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

  /** Tells the bot to leave, arms the kill, and moves the run to `leaving`. The kill is armed first, so a leave the bot never receives still ends in the kill. */
  private async leave(run: MeetingRunRecord, reason: MeetingLeaveReason): Promise<boolean> {
    if (!canTransition(run.state, 'leaving') && run.state !== 'purging') return false;
    if (run.state !== 'purging') {
      const moved = await this.stores.runs.update(run.runId, { state: 'leaving', reason }, run.state);
      if (!moved) return false;
    }
    this.leaveAt.set(run.runId, this.now());
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
    const failed = await this.stores.runs.update(run.runId, { ...contentFreeRun(pending), dispatch: undefined, transcriber: undefined, pageSeenAt: undefined, lastUsageAt: undefined, reportedSeconds: undefined, monitorSeenAt: undefined, participantCount: undefined, state: 'failed', leftAt: now, doneAt: now, billedSeconds: 0, cleanupPending: false }, pending.state);
    if (!failed) return;
    this.forget(run.runId);
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
    const done = await this.stores.runs.update(run.runId, { ...kept, dispatch: undefined, transcriber: undefined, pageSeenAt: undefined, lastUsageAt: undefined, reportedSeconds: undefined, monitorSeenAt: undefined, participantCount: undefined, state: 'done', doneAt: now, billedSeconds: billed, cleanupPending: false }, 'left');
    if (!done) return;
    this.forget(run.runId);
    await this.emit('bot:done', done, { reason: done.reason, billedSeconds: billed });
  }

  private async crash(run: MeetingRunRecord, at: number, seconds: number | undefined): Promise<void> {
    const current = await this.stores.runs.get(run.runId);
    if (!current || TERMINAL_RUN_STATES.has(current.state)) return;
    if (current.state === 'purging') {
      await this.stores.runs.update(run.runId, { leftAt: at, reportedSeconds: seconds ?? current.reportedSeconds }, 'purging');
      this.leaveAt.delete(run.runId);
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

  private forget(runId: string): void {
    this.suspendedAt.delete(runId);
    this.leaveAt.delete(runId);
    this.aloneSince.delete(runId);
  }

  // ── The purge sequence ──

  /** (a) the fence; (b) the purge, each step retried until it resolves; (c) the content-free record. */
  private async purge(run: MeetingRunRecord, reason: MeetingLeaveReason): Promise<void> {
    if (run.state !== 'purging') {
      const fenced = await this.stores.runs.update(run.runId, { state: 'purging', reason }, PURGEABLE_STATES);
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
        // the kill is armed first, so a suspend or a leave the bot never receives still ends in the kill
        this.leaveAt.set(run.runId, this.now());
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
    const done = await this.stores.runs.update(runId, { state: 'done', doneAt: now, purgedAt: now, billedSeconds: billed }, 'purging');
    if (!done) return;
    this.forget(runId);
    const free = { ...contentFreeRun(done), purgedAt: now };
    await this.stores.runs.replace(free);
    await this.emit('bot:purged', free, { reason: free.reason });
    await this.emit('bot:done', free, { reason: free.reason, billedSeconds: billed });
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
        const commandedLeaveAt = this.leaveAt.get(run.runId);
        if (commandedLeaveAt !== undefined && now - commandedLeaveAt > this.killAfterMs) {
          this.leaveAt.delete(run.runId);
          // the end is recorded whether or not the kill reaches the bot: the cleanup that follows deletes its room
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
            const suspended = this.suspendedAt.get(run.runId);
            if (suspended === undefined) {
              this.suspendedAt.set(run.runId, now);
              await provider?.command(run.runId, { name: 'suspendCapture' });
              await this.emit('bot:capture_suspended', run, { reason: 'stop monitor quiet' });
            } else if (now - suspended > this.monitorRecoverMs) {
              await this.leave(run, 'stop_monitor_failed');
              continue;
            }
          }
          const alone = this.aloneSince.get(run.runId);
          if (alone !== undefined && now - alone > run.limits.aloneMs) {
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
      this.forget(run.runId);
    }
  }

  // ── Reconcile ──

  /**
   * Compares dispatched jobs with the providers' usage: a run whose container is gone is ended as crashed; an unfinished
   * purge is resumed. As in the limits, a run whose step throws holds back no other, and the first error is thrown at the
   * end.
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
