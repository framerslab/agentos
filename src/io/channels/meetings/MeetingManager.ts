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
import type { DispatchResult, IMeetingBotProvider, ProviderEventContext } from './IMeetingBotProvider.js';
import type { MeetingRoom } from './MeetingRoom.js';
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
  /** How many heartbeats the stop monitor may miss before it counts as unhealthy. Default 3. */
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
   * Sends a bot: checks the link against the platform, answers the run an earlier send by the same owner with the same
   * idempotency key made, reserves the run's time, stores the run and schedules its dispatch (now, or at `joinAt`). A
   * reservation that covers less than `minReservationSeconds` is released and the send refused.
   */
  async sendBot(request: SendBotRequest): Promise<SendBotResult> {
    const provider = this.providerFor(request.platform, request.providerName);
    if (!provider) return { ok: false, reason: 'no_provider', message: `no provider for ${request.platform}` };
    const url = provider.checkJoinUrl(request.meetingUrl);
    if (!url.ok) return { ok: false, reason: 'invalid_url', message: url.message };
    if (url.platform !== request.platform) return { ok: false, reason: 'invalid_url', message: `the link is a ${url.platform} link` };
    if (this.paused.has(request.platform)) return { ok: false, reason: 'platform_paused', message: `${request.platform} is paused today` };
    if (request.idempotencyKey !== undefined) {
      const existing = await this.stores.runs.findByIdempotencyKey(request.ownerRef, request.idempotencyKey);
      if (existing) return { ok: true, run: existing, repeated: true };
    }
    const now = this.now();
    const runId = randomUUID();
    const limits = { ...DEFAULT_RUN_LIMITS, ...request.limits };
    const reserved = await this.stores.entitlement.reserve({ ownerRef: request.ownerRef, runId, platform: request.platform, maxSeconds: Math.ceil(limits.totalMs / 1000) });
    if (!reserved.ok) return { ok: false, reason: reserved.reason, message: reserved.message };
    if (reserved.maxSeconds < this.minReservationSeconds) {
      await this.stores.entitlement.release(reserved.reservationId);
      return { ok: false, reason: 'allowance', message: `under ${Math.round(this.minReservationSeconds / 60)} minutes left` };
    }
    limits.totalMs = Math.min(limits.totalMs, reserved.maxSeconds * 1000);
    const joinAt = request.joinAt ?? now;
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

  /** One pass: due jobs dispatched, limits enforced, kills issued, purges resumed, a reconcile every minute. */
  async tick(): Promise<void> {
    await this.dispatchDue();
    await this.enforceLimits();
    await this.cleanupExpired();
    if (this.now() - this.lastReconcileAt >= 60_000) {
      this.lastReconcileAt = this.now();
      await this.reconcile();
    }
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
      if (cancelled) await this.leave(run, run.reason ?? 'stopped_by_owner');
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
    const room = await this.config.room.create(run.runId);
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
      const job = await this.stores.jobs.get(run.runId);
      if (leaseLost || !job || job.leaseHolder !== this.id) return;
      await this.config.room.delete(room.name);
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
    if (dispatched && cancelled) await this.leave(dispatched, dispatched.reason ?? 'stopped_by_owner');
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
    } catch (err) {
      return { accepted: false, error: `unparseable: ${String(err)}`, applied: 0 };
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
      && this.now() - run.monitorSeenAt <= this.monitorHeartbeatMs * this.monitorMissedBeats
      && !this.suspendedAt.has(run.runId);
  }

  /** The capture interlock: `in_call`, the notice confirmed, and the stop monitor's own observation reported after the notice, no fence. */
  private async startCaptureIfReady(run: MeetingRunRecord): Promise<void> {
    if (run.state !== 'in_call' || run.noticePostedAt === undefined || run.monitorSeenAt === undefined) return;
    if (run.monitorSeenAt < run.noticePostedAt) return; // a heartbeat from before the notice proves nothing about the chat being watched now
    if (this.now() - run.monitorSeenAt > this.monitorHeartbeatMs * this.monitorMissedBeats) return;
    if (run.captureStartedAt !== undefined && !this.suspendedAt.has(run.runId)) return; // already capturing
    const provider = this.providers.get(run.providerName);
    if (!provider) return;
    await provider.command(run.runId, { name: 'startCapture' });
    this.suspendedAt.delete(run.runId);
    const started = await this.stores.runs.update(run.runId, { captureStartedAt: run.captureStartedAt ?? this.now() }, 'in_call');
    if (started) await this.emit('bot:capture_started', started, { resumed: run.captureStartedAt !== undefined });
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
