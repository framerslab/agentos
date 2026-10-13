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
import type { IDurableInbox } from './DurableInbox.js';
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
  type PendingSupplierUsage,
  type ProviderEventType,
  type SendBotRequest,
  type SendBotResult,
  type SupplierUsage,
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
  /**
   * Optional. Where supplier totals wait when the entitlement hook's `recordSupplierUsage` refuses them (a report's, or
   * those a provider's usage answers at reconciliation), until the next {@link MeetingManager.reconcile} hands them over
   * again; a durable inbox (`SqlDurableInbox`) keeps them across a restart. A refusal holds back no run either way: the
   * report is applied, and a run whose worker is gone still ends. Without an inbox, the hook's error is thrown once the
   * report is applied, or at the end of the reconcile pass.
   */
  supplierUsageInbox?: IDurableInbox<PendingSupplierUsage>;
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
  /**
   * End at the last durable usage after this silence. Omitted preserves the existing reconciliation policy. When set, a
   * dispatching or dispatched run whose worker has sent no fresh usage report for this many milliseconds (counted from
   * the manager's receipt of the last one, or from the dispatch when none came) is killed and ended `crashed`, at that
   * receipt and at the total the reports gave, whatever the provider answers and whatever heartbeats arrive. Every pass of
   * the upkeep checks it, and so does {@link MeetingManager.reconcile}. A value that is not a finite number of milliseconds
   * above zero is refused with a `RangeError` when the manager is built.
   */
  usageSilenceMs?: number;
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

/**
 * Thrown by a provider's `dispatch` when the run will never be allowed to start: the platform refused it for good
 * (the caller lacks the permission, the account forbids it), or no worker has a slot. The manager ends the run at once
 * with the reason, unbilled, and never retries it. Any other error from `dispatch` is treated as a fault of the moment
 * and retried. The message is shown to no one by the library; a host may read it from the `bot:left` event.
 */
export class DispatchRefusedError extends Error {
  /**
   * @param reason - The reason the run ends with.
   * @param message - The provider's word for why, from a fixed list of its own; it reaches `bot:left`, so it carries nothing of the meeting.
   */
  constructor(
    readonly reason: Extract<MeetingLeaveReason, 'no_capacity' | 'permission_denied'>,
    message: string,
  ) {
    super(message);
    this.name = 'DispatchRefusedError';
  }
}

/**
 * Thrown by a provider's `dispatch` when no worker has a slot. As with any {@link DispatchRefusedError}, the manager
 * ends the run at once with `no_capacity`, and the message reaches the host as the `message` of the run's `bot:left`
 * event, so it carries nothing of the meeting.
 */
export class NoCapacityError extends DispatchRefusedError {
  /** @param message - Why no worker took the run. */
  constructor(message = 'no worker has a free slot') {
    super('no_capacity', message);
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
/** The states whose runs `usageSilenceMs` ends: from the dispatch until the bot has left. A run behind the fence has its kill deadline, and one that has left only its cleanup. */
const SILENCE_STATES: readonly MeetingRunState[] = ['dispatching', 'joining', 'waiting_room', 'in_call_notice_pending', 'in_call', 'leaving'];
/** States a purge may start from: everything that is not terminal. */
const PURGEABLE_STATES: readonly MeetingRunState[] = ['requested', 'scheduled', ...ACTIVE_STATES.filter((s) => s !== 'purging')];
/** Every state that is not terminal. */
const OPEN_STATES: readonly MeetingRunState[] = ['requested', 'scheduled', ...ACTIVE_STATES];
/** Reports that carry what a person said or did; behind the fence they are neither stored nor forwarded. */
const CONTENT_REPORTS: ReadonlySet<ProviderEventType> = new Set<ProviderEventType>(['chat_message', 'stop_command', 'participant_joined', 'participant_left']);
/** The two passes of the loop `start()` runs, apart from each other: the dispatches, and the upkeep. */
type LoopPass = 'dispatch' | 'upkeep';
/** How many of the loop's intervals a pass may run before the next one starts beside it: a pass this old is held by a call that does not answer. */
const STUCK_PASS_INTERVALS = 5;

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
  private readonly usageSilenceMs: number | undefined;
  private readonly minReservationSeconds: number;
  private readonly purgeHooks: Array<(runId: string) => Promise<void>> = [];
  private lastReconcileAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** How many intervals the loop has run: the clock its passes are timed on. */
  private loopIntervals = 0;
  /** The interval in which each of the loop's passes that is still running began. */
  private readonly passStartedAt = new Map<LoopPass, number>();
  /** When the terminal runs are next listed for eviction: when the first of them can go, and at least once a minute. */
  private nextCleanupAt = 0;

  /** @throws RangeError when `usageSilenceMs` is given and is not a finite number of milliseconds above zero. */
  constructor(private readonly config: MeetingManagerConfig) {
    // NaN or zero would end every run at once (no silence is ever shorter), and Infinity would end none
    if (config.usageSilenceMs !== undefined && !(Number.isFinite(config.usageSilenceMs) && config.usageSilenceMs > 0)) {
      throw new RangeError('usageSilenceMs must be a finite number of milliseconds above zero');
    }
    this.id = config.managerId ?? randomUUID();
    this.leaseTtlMs = config.leaseTtlMs ?? 60_000;
    this.noticeConfirmMs = config.noticeConfirmMs ?? 30_000;
    this.monitorHeartbeatMs = config.monitorHeartbeatMs ?? 10_000;
    this.monitorMissedBeats = config.monitorMissedBeats ?? 3;
    this.monitorRecoverMs = config.monitorRecoverMs ?? 30_000;
    this.dispatchRetryMs = config.dispatchRetryMs ?? 300_000;
    this.dispatchRetryDelayMs = config.dispatchRetryDelayMs ?? 15_000;
    this.killAfterMs = config.killAfterMs ?? 30_000;
    this.usageSilenceMs = config.usageSilenceMs;
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
   * Delivers a stored event, with the run as it stands: to every handler, then a delivery to each of the owner's
   * destinations. The handlers come first, so a destination lookup or an enqueue that fails cannot keep an event from
   * them: a handler receives an event once, and a repeated event goes to no handler. A repeated event goes to the
   * destinations again, which the outbox keeps once each, so a delivery its first attempt never enqueued is enqueued now.
   */
  private async deliver(stored: StoredEvent | undefined, run: MeetingRunRecord): Promise<void> {
    if (!stored) return;
    const { id, type, at, seq, data } = stored;
    if (!stored.repeated) {
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
    if (this.config.destinationsFor) {
      const payload = JSON.stringify({ id, type, runId: run.runId, at, seq, data });
      for (const destinationRef of await this.config.destinationsFor(run.ownerRef)) {
        await this.stores.outbox.enqueue({ id: `${id}@${destinationRef}`, runId: run.runId, destinationRef, eventId: id, type, payload }, at);
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

  /**
   * Runs a tick's two passes every second until `stop()`, apart from each other: the dispatches, and the upkeep (the
   * limits, the kills, the purges and cleanups resumed, the eviction and a reconcile every minute). Apart, a dispatch a
   * provider is slow to answer (a worker pulling its image) holds back no limit: a quiet stop monitor is still suspended
   * and an armed kill still fires while it waits. Each pass runs one at a time, so a slow store does not stack passes on
   * each other, except that a pass still running five intervals after it began is no longer waited for and the next one
   * starts beside it: a pass held by a call that never answers (a command to a worker that froze) would otherwise stop
   * every later one. A host with its own scheduler calls `tick()` itself.
   */
  start(intervalMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.loopIntervals += 1;
      this.runPass('dispatch', () => this.dispatchDue());
      this.runPass('upkeep', () => this.upkeep());
    }, intervalMs);
    this.timer.unref?.();
  }

  /** Starts one of the loop's passes, unless the last one of it is still running and has not run for five intervals. */
  private runPass(pass: LoopPass, work: () => Promise<void>): void {
    const began = this.passStartedAt.get(pass);
    if (began !== undefined && this.loopIntervals - began < STUCK_PASS_INTERVALS) return;
    if (began !== undefined) this.config.logger?.warn(`[MeetingManager] the ${pass} pass begun ${this.loopIntervals - began} intervals ago has not finished; the next one starts beside it`);
    const mark = this.loopIntervals;
    this.passStartedAt.set(pass, mark);
    void work()
      .catch((err) => this.config.logger?.error(`[MeetingManager] ${pass} pass: ${String(err)}`))
      .finally(() => {
        // a pass that was stuck and finishes after a later one began leaves the later one's mark alone
        if (this.passStartedAt.get(pass) === mark) this.passStartedAt.delete(pass);
      });
  }

  /** Stops the loop `start()` began; a pass already running finishes. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass: due jobs dispatched, then the upkeep (limits enforced, kills issued, purges resumed, a reconcile every
   * minute). Each step runs even when an earlier one throws, so a dispatch that fails on one run never holds back the
   * limits of the others (the stop monitor's suspension among them); the first error is thrown once the pass is over.
   * The steps run in turn, so a dispatch that takes long holds this pass's limits back until it returns; `start()` runs
   * the two apart.
   */
  async tick(): Promise<void> {
    let failure: { error: unknown } | undefined;
    try {
      await this.dispatchDue();
    } catch (error) {
      failure = { error };
    }
    try {
      await this.upkeep();
    } catch (error) {
      failure ??= { error };
    }
    if (failure) throw failure.error;
  }

  /**
   * The steps after the dispatches: the usage silence (when the host sets `usageSilenceMs`), the limits, the eviction and
   * a reconcile every minute, each run even when an earlier one throws; the first error is thrown at the end. The silence
   * is checked on every pass, not on the reconcile's minute, so a run ends when its silence reaches the threshold.
   */
  private async upkeep(): Promise<void> {
    let failure: { error: unknown } | undefined;
    const step = async (pass: () => Promise<void>): Promise<void> => {
      try {
        await pass();
      } catch (error) {
        failure ??= { error };
      }
    };
    await step(() => this.endSilentRuns());
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
      if (run.state !== 'requested' && run.state !== 'scheduled') {
        // the bot is out and has reported, and its dispatcher lost the lease before it recorded the dispatch: it is
        // recorded now, under this lease, so reconcile watches the run (a removed job would let its container die unseen)
        await this.stores.jobs.markDispatched(run.runId, this.id, run.dispatch?.workerId);
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
    let alive: boolean;
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
    // a run that ended while the provider's call was in flight had its job removed, so the lease is lost or the dispatch
    // is not recorded: the worker the provider started is killed, since nothing watches it any more
    if (leaseLost) {
      await this.killIfEnded(run);
      return;
    }
    const { recorded, cancelled } = await this.stores.jobs.markDispatched(run.runId, this.id, result.workerId);
    if (!recorded) {
      await this.killIfEnded(run);
      return;
    }
    // a report may have moved the run on while the provider's call was in flight: the worker's id is written whatever active state the run reached
    const dispatched = await this.stores.runs.update(run.runId, { dispatch: { ...withDispatch.dispatch!, workerId: result.workerId, providerRunRef: result.providerRunRef } }, ACTIVE_STATES);
    if (!dispatched || dispatched.leftAt !== undefined) {
      // an end recorded during the call whose cleanup has not removed the job yet: the same
      await this.killIfEnded(run);
      return;
    }
    if (dispatched.state === 'dispatching') await this.emit('bot:dispatching', dispatched, { workerId: result.workerId });
    // A cancellation received during dispatch becomes a leave in whichever active state the report reached.
    if (cancelled) await this.leaveCancelled(run.runId);
  }

  /**
   * After the provider answered a dispatch: when the run ended while the call was in flight (the usage silence, a purge's
   * kill deadline, or any other end that recorded the bot gone or removed the job), the worker the provider started has
   * no report taken and no reconcile watching it, and is killed. A run still going keeps its worker, and so does one whose
   * job another dispatcher took over when this one's lease ran out: that dispatcher finds the worker and records it.
   */
  private async killIfEnded(run: MeetingRunRecord): Promise<void> {
    const current = await this.stores.runs.get(run.runId);
    if (current && !TERMINAL_RUN_STATES.has(current.state) && current.leftAt === undefined) return;
    this.config.logger?.warn(`[MeetingManager] ${run.runId}: the provider answered the dispatch after the run ended; its worker is killed`);
    this.kill(run);
  }

  /**
   * A dispatch that failed before the bot was out, while this manager still holds the job: the room goes, then the run
   * ends (a refusal for good, a cancel that landed meanwhile, or the retry window past its due time) or its job is
   * released to be tried again after the pause.
   */
  private async dispatchFailed(run: MeetingRunRecord, err: unknown, roomName: string | undefined): Promise<void> {
    const job = await this.stores.jobs.get(run.runId);
    if (!job || job.leaseHolder !== this.id) return;
    if (roomName) await this.config.room.delete(roomName);
    if (err instanceof DispatchRefusedError || this.now() - run.joinAt > this.dispatchRetryMs) {
      const current = await this.stores.runs.get(run.runId);
      if (!current) return;
      // a cancel that landed during the call ends the run as the cancel asked; a refusal ends it with the provider's reason and its word; a fault that outlasted the window ends it crashed
      if (job.cancelled) await this.fail(current, current.reason ?? 'stopped_by_owner');
      else if (err instanceof DispatchRefusedError) await this.fail(current, err.reason, err.message);
      else await this.fail(current, 'crashed');
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
    // what the supplier measured is cost already incurred: recorded before the terminal, fence and dedup guards, so a
    // terminal report still settles it without admitting content (the hook keeps the largest totals, so a repeat is safe).
    // A record the hook refuses holds back nothing of the report: a left or a crash still ends the run below
    const refused = run?.reservationId && event.data?.supplierUsage !== undefined
      ? await this.recordSupplierTotals(run.runId, run.reservationId, event.data.supplierUsage)
      : undefined;
    const applied = await this.applyReport(run, event);
    // written once the report is applied, never between its stored event and its effects: a write that failed there
    // would leave the worker's retry a repeated report, which applies nothing again. A report applied before (a
    // duplicate) applies nothing and moves it not at all
    if (applied && run) await this.stores.runs.update(run.runId, { lastReportAt: this.now() });
    if (refused) throw refused.error;
    return applied;
  }

  /**
   * Hands what a run's supplier measured to the entitlement hook's `recordSupplierUsage`, when the hook has one. Totals
   * the hook refuses wait in the stores' `supplierUsageInbox`, when there is one, until a reconcile hands them over
   * again; with no inbox, or one that refuses them too, the hook's error is answered, for the caller to throw once its
   * own work is done.
   */
  private async recordSupplierTotals(runId: string, reservationId: string, usage: SupplierUsage): Promise<{ error: unknown } | undefined> {
    try {
      await this.stores.entitlement.recordSupplierUsage?.(reservationId, usage);
      return undefined;
    } catch (error) {
      const inbox = this.stores.supplierUsageInbox;
      if (!inbox) {
        this.config.logger?.warn(`[MeetingManager] supplier usage of ${runId} not recorded: ${String(error)}`);
        return { error };
      }
      try {
        // the id names the run and the totals, so the same totals refused twice wait once
        await inbox.accept({ id: `${runId}:${usage.streamSeconds}:${usage.captureSeconds}:${usage.final === true ? 'final' : 'running'}`, acceptedAt: this.now(), value: { runId, reservationId, usage } });
      } catch (keepError) {
        this.config.logger?.error(`[MeetingManager] supplier usage of ${runId} neither recorded (${String(error)}) nor kept (${String(keepError)})`);
        return { error };
      }
      this.config.logger?.warn(`[MeetingManager] supplier usage of ${runId} not recorded, kept for the next reconcile: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Hands the entitlement hook again the supplier totals it refused before, kept in the stores' `supplierUsageInbox`:
   * each one recorded is acknowledged, and one refused again stays for the next reconcile.
   * An entry recorded but not acknowledged holds back no other, and the first such failure is thrown once the pass
   * is done, for reconcile to throw at the end of its own work.
   */
  private async recordKeptSupplierUsage(): Promise<void> {
    const inbox = this.stores.supplierUsageInbox;
    if (!inbox || !this.stores.entitlement.recordSupplierUsage) return;
    const kept = await inbox.pending();
    let refused = 0;
    let firstError: unknown;
    let unacknowledged: { error: unknown } | undefined;
    for (const entry of kept) {
      try {
        await this.stores.entitlement.recordSupplierUsage?.(entry.value.reservationId, entry.value.usage);
      } catch (error) {
        if (refused === 0) firstError = error;
        refused += 1;
        continue;
      }
      try {
        await inbox.acknowledge(entry.id);
      } catch (error) {
        // recorded all the same: the entry stays pending, and the hook, which keeps the largest of each, sees the totals again
        unacknowledged ??= { error };
      }
    }
    // one line for the pass, however many the hook refused
    if (refused > 0) this.config.logger?.warn(`[MeetingManager] ${refused} of ${kept.length} kept supplier usage totals refused again, kept for the next reconcile: ${String(firstError)}`);
    if (unacknowledged) throw unacknowledged.error;
  }

  /** The report applied to its run as `apply` read it, whatever became of the report's supplier totals. */
  private async applyReport(run: MeetingRunRecord | undefined, event: NormalizedMeetingEvent): Promise<boolean> {
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
        // the waiting-room limit counts from here, the bot's arrival in the waiting room; admission moves joinedAt on to the call
        await this.move(run, 'waiting_room', { joinedAt: this.reportedAt(event.at) }, 'bot:waiting_room', undefined, event);
        return true;
      case 'in_call': {
        const at = this.reportedAt(event.at);
        await this.move(run, 'in_call_notice_pending', { joinedAt: at, participantCount: event.data?.participantCount, ...this.aloneTimer(run, event.data?.participantCount, at) }, 'bot:in_call', undefined, event);
        return true;
      }
      case 'notice_posted':
        // The notice alone does not open capture: the stop monitor must report a real observation after it (the
        // interlock). The notice's time is kept as the worker gave it, on the worker's clock, since the monitor's
        // heartbeats are ordered against it on that clock; and a heartbeat time the run holds from before the
        // confirmation, whose order against the notice is not known, is cleared, so the next heartbeat decides.
        await this.move(run, 'in_call', { noticePostedAt: event.at, monitorSeenAt: undefined }, 'bot:notice_posted', { version: run.notice.version }, event);
        return true;
      case 'monitor_heartbeat': {
        // The stop monitor's own observation counts only once the notice is confirmed, and only when the worker made it at
        // or after the notice, both read on the worker's clock: one from before the notice proves nothing about the chat
        // being watched after it, and its time bounded on the manager's clock could equal the notice's or pass it. A
        // counted heartbeat is kept at its bounded time, by which the limits measure the monitor's freshness. The first
        // after the notice opens capture, one after a suspension resumes it (the method holds every guard).
        if (run.state !== 'in_call' || run.noticePostedAt === undefined || event.at < run.noticePostedAt) return false;
        const updated = await this.stores.runs.update(run.runId, { monitorSeenAt: this.reportedAt(event.at) }, 'in_call');
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
        // the short notice goes first, before the count is written and the event delivered: a write or a delivery that
        // fails, after which the worker's retry applies nothing again, cannot keep it from the participant who arrived
        await this.postLateNotice(run);
        const updated = (await this.updateParticipants(run, event)) ?? run;
        await this.deliver(stored, updated);
        return true;
      }
      case 'participant_left': {
        const updated = (await this.updateParticipants(run, event)) ?? run;
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
        if (this.usageSilenceMs === undefined) {
          const updated = await this.stores.runs.update(run.runId, { lastUsageAt: event.at });
          if (run.reservationId && run.captureStartedAt !== undefined) await this.stores.entitlement.meter(run.reservationId, event.data?.seconds ?? 0);
          await this.deliver(stored, updated ?? run);
          return true;
        }
        // the receipt, on the manager's clock, and the running total are written before the meter, so a manager that
        // restarts measures the silence and settles from them; a count that is not a finite number never enters the total
        const reported = event.data?.seconds;
        const count = typeof reported === 'number' && Number.isFinite(reported) ? reported : 0;
        // With the silence rule, a report the worker made no later than the last one taken (one that arrives late, out of
        // order) is not fresh usage: its event is delivered as stored, and neither the clock nor the total moves. Both are
        // decided on the row as the store holds it, in the write, so of two reports applied at once the older one never
        // writes its time, or a smaller total, over the newer one's
        const updated = await this.updateRunWith(run.runId, (current) =>
          current.lastUsageSourceAt !== undefined && event.at <= current.lastUsageSourceAt
            ? undefined
            : { lastUsageAt: this.now(), lastUsageSourceAt: event.at, reportedSeconds: Math.max(current.reportedSeconds ?? 0, count) });
        if (!updated) {
          await this.deliver(stored, run);
          return false;
        }
        if (run.reservationId && run.captureStartedAt !== undefined) await this.stores.entitlement.meter(run.reservationId, updated.reportedSeconds ?? count);
        await this.deliver(stored, updated);
        return true;
      }
      case 'left': {
        const reason = run.reason ?? event.data?.reason ?? 'ended';
        if (run.state === 'purging') {
          // behind the fence a left report only records the end: the first leaving time, and the largest total counted
          await this.stores.runs.update(run.runId, { leftAt: run.leftAt ?? event.at, reason, reportedSeconds: this.countedSeconds(run.reportedSeconds, event.data?.seconds) });
          return true;
        }
        // a bot that left on its own (not admitted, alone, the cap, a crash before a command) reaches `left` from any state
        // after dispatch, with its own reason; the total it gives never lowers one its usage reports gave
        const left = await this.move(run, 'left', { leftAt: event.at, reason, reportedSeconds: this.countedSeconds(run.reportedSeconds, event.data?.seconds), cleanupPending: true }, 'bot:left', event.data?.message === undefined ? { reason } : { reason, message: event.data.message }, event);
        if (left) await this.complete(left, event.data?.seconds);
        return true;
      }
      case 'done':
        if (run.state === 'purging') await this.stores.runs.update(run.runId, { reportedSeconds: this.countedSeconds(run.reportedSeconds, event.data?.seconds) });
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

  /**
   * Posts the notice's short form for a participant who joined after the notice, when the run is in the call and its
   * provider posts to chat: a late arrival does not see the chat's history, so the notice posted at the start never
   * reached them (behind the fence the run is `purging`, and nothing is posted).
   */
  private async postLateNotice(run: MeetingRunRecord): Promise<void> {
    const provider = this.providers.get(run.providerName);
    if (run.state === 'in_call' && provider?.capabilities.postsChat) await provider.command(run.runId, { name: 'postChat', text: run.notice.lateArrivalText });
  }

  /** Whether a report asks the bot to stop: a stop command, or a chat message holding the stop phrase. */
  private isStop(run: MeetingRunRecord, event: NormalizedMeetingEvent): boolean {
    return event.type === 'stop_command' || (event.type === 'chat_message' && this.isStopPhrase(run, event.data?.text));
  }

  /**
   * A report's time as the limits read it: the worker's own, but no later than one heartbeat interval past the manager's
   * clock. The limits compare these times with the manager's clock, so a worker whose clock runs ahead would otherwise
   * keep a quiet stop monitor counted healthy, and the waiting-room, notice and alone limits unexpired, for as long as it
   * runs ahead. Bounded times need not keep the worker's order (two reports of a worker far ahead can take one time, or
   * a later report an earlier one's), so the interlock's order, a heartbeat at or after the notice, is read on the
   * worker's own times, never on these.
   */
  private reportedAt(at: number): number {
    return Math.min(at, this.now() + this.monitorHeartbeatMs);
  }

  /**
   * Writes a participant report's count and the alone timer it implies, decided on the row as it stands now, read after
   * the report's event was stored: decided on the row read before it, while another report cleared the timer, it could
   * put back a timer that had run out, and the next pass would end the run as alone with a participant in the call.
   */
  private async updateParticipants(run: MeetingRunRecord, event: NormalizedMeetingEvent): Promise<MeetingRunRecord | undefined> {
    const current = (await this.stores.runs.get(run.runId)) ?? run;
    const count = event.data?.participantCount;
    return this.stores.runs.update(run.runId, { participantCount: count, ...this.aloneTimer(current, count, this.reportedAt(event.at)) });
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

  /**
   * The capture interlock holds: `in_call`, the notice confirmed, a heartbeat the stop monitor made after the notice and
   * still fresh, and no suspension. `monitorSeenAt` is kept only for a heartbeat the worker made at or after the notice
   * (read on the worker's clock as the heartbeat is applied; the notice's confirmation clears it), so its presence is that
   * order; its bounded time is never compared with the notice's, which is on the worker's clock.
   */
  private captureReady(run: MeetingRunRecord): boolean {
    return run.state === 'in_call'
      && run.noticePostedAt !== undefined
      && run.monitorSeenAt !== undefined
      && this.now() - run.monitorSeenAt < this.monitorHeartbeatMs * this.monitorMissedBeats
      && run.captureSuspendedAt === undefined;
  }

  /** The capture interlock: `in_call`, the notice confirmed, and the stop monitor's own observation reported after the notice, no fence. */
  private async startCaptureIfReady(run: MeetingRunRecord): Promise<void> {
    // a heartbeat from before the notice proves nothing about the chat being watched now, and none is kept (see captureReady)
    if (run.state !== 'in_call' || run.noticePostedAt === undefined || run.monitorSeenAt === undefined) return;
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

  /**
   * The bot leaves and everything it took is deleted (the purge sequence). On a run that is over, done or failed before
   * it joined, what is kept is deleted and the host's purge hooks run (a session's deletion). False for a run that does
   * not exist.
   */
  async purgeRun(runId: string, reason: MeetingLeaveReason = 'stopped_by_owner'): Promise<boolean> {
    const run = await this.stores.runs.get(runId);
    if (!run) return false;
    if (run.state === 'done' || run.state === 'failed') return this.purgeKept(run);
    await this.purge(run, reason);
    return true;
  }

  /** A run's kept content removed after it ended (`done`, or `failed`, which kept none): the fences, the stores, the hooks, the provider's copies, `bot:purged`, the content-free row. A step that throws is the caller's to retry (the product's one purge path retries). */
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

  /** A run sent from a page: the page is still there. A run that is over keeps its terminal row as it was written. */
  async pageSeen(runId: string): Promise<void> {
    await this.stores.runs.update(runId, { pageSeenAt: this.now() }, OPEN_STATES);
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
   * kill, and whichever manager runs the limits, after a restart too, sends it. A run already told to leave keeps the
   * reason it was told, which decides its billing, and its deadline; a report that moves the run between the read this
   * was given and the write is overtaken by trying again from the state the run is in now.
   */
  private async leave(run: MeetingRunRecord, reason: MeetingLeaveReason): Promise<boolean> {
    let current: MeetingRunRecord | undefined = run;
    for (let attempt = 0; current !== undefined && attempt < 3; attempt += 1) {
      if (current.state === 'leaving') return true;
      if (!canTransition(current.state, 'leaving') && current.state !== 'purging') return false;
      const armed: Partial<MeetingRunRecord> = current.state === 'purging' ? { leaveCommandedAt: current.leaveCommandedAt ?? this.now() } : { state: 'leaving', reason, leaveCommandedAt: this.now() };
      if (await this.stores.runs.update(current.runId, armed, current.state)) {
        await this.sendCommand(current, { name: 'leave', reason });
        return true;
      }
      current = await this.stores.runs.get(current.runId);
    }
    return false;
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

  /**
   * Sends the bot a kill without waiting for the provider's answer, so the end that follows is recorded at once: a kill
   * that never answers (a scheduler that hangs) would otherwise hold the pass, and every run after it in the pass, for as
   * long as it hangs. One that fails is logged, as `sendCommand` logs it.
   */
  private kill(run: MeetingRunRecord): void {
    void this.sendCommand(run, { name: 'kill' });
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
    const failed = await this.stores.runs.update(run.runId, { ...contentFreeRun(pending), dispatch: undefined, transcriber: undefined, pageSeenAt: undefined, monitorSeenAt: undefined, participantCount: undefined, leaveCommandedAt: undefined, captureSuspendedAt: undefined, aloneSince: undefined, state: 'failed', leftAt: now, doneAt: now, billedSeconds: 0, cleanupPending: false }, pending.state);
    if (!failed) return;
    await this.emit('bot:left', failed, { reason: failed.reason, message });
    await this.emit('bot:done', failed, { reason: failed.reason, billedSeconds: 0 });
  }

  /**
   * After `left` (no purge): settle or release, drop what is not kept, delete the room, remove the job, and only then
   * `done`. A run that ended with `permission_denied` is purged instead, whatever its Keep. A step that throws leaves the
   * run in `left` with `cleanupPending`, and the next tick calls this again; the entitlement hook's `settle` and
   * `release` are idempotent, so a retry after a half-done cleanup changes nothing twice.
   */
  private async complete(run: MeetingRunRecord, reportedSeconds: number | undefined): Promise<void> {
    const current = await this.stores.runs.get(run.runId);
    if (!current || (current.state !== 'left' && current.state !== 'leaving')) return;
    if (current.state === 'leaving') {
      const left = await this.stores.runs.update(run.runId, { state: 'left', leftAt: current.leftAt ?? this.now(), cleanupPending: true, reportedSeconds: this.countedSeconds(current.reportedSeconds, reportedSeconds) }, 'leaving');
      if (!left) return;
      await this.emit('bot:left', left, { reason: left.reason });
      run = left;
    } else run = current;
    if (run.reason === 'permission_denied') {
      // the platform refused the bot the meeting's permission: what the run took is deleted whatever its Keep, through
      // the purge sequence and the host's purge hooks, rather than kept as a completed run's content is
      await this.purge(run, 'permission_denied');
      return;
    }
    const now = this.now();
    const counted = this.countedSeconds(run.reportedSeconds, reportedSeconds);
    const seconds = counted ?? Math.max(0, Math.round(((run.leftAt ?? now) - (run.dispatchedAt ?? run.joinAt)) / 1000));
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
    // the total counted with the report that ended the run (a done report may give one its left report did not), so the
    // usage evidence the row keeps agrees with what was settled
    const done = await this.stores.runs.update(run.runId, { ...kept, reportedSeconds: counted, dispatch: undefined, transcriber: undefined, pageSeenAt: undefined, monitorSeenAt: undefined, participantCount: undefined, leaveCommandedAt: undefined, captureSuspendedAt: undefined, aloneSince: undefined, state: 'done', doneAt: now, billedSeconds: billed, cleanupPending: false }, 'left');
    if (!done) return;
    await this.emit('bot:done', done, { reason: done.reason, billedSeconds: billed });
  }

  /**
   * The seconds a worker counted, a running total: the largest of the stored total and a report's, so a report the
   * worker sent again, or one that arrives late, never lowers what a later one gave. Undefined when neither gives one.
   */
  private countedSeconds(stored: number | undefined, reported: number | undefined): number | undefined {
    if (reported === undefined) return stored;
    return stored === undefined ? reported : Math.max(stored, reported);
  }

  private async crash(run: MeetingRunRecord, at: number, seconds: number | undefined): Promise<void> {
    const current = await this.stores.runs.get(run.runId);
    if (!current || TERMINAL_RUN_STATES.has(current.state)) return;
    if (current.state === 'purging') {
      await this.stores.runs.update(run.runId, { leftAt: current.leftAt ?? at, reportedSeconds: this.countedSeconds(current.reportedSeconds, seconds) }, 'purging');
      return;
    }
    if (current.state === 'left') {
      // the bot left before: the time it left and the seconds it counted stand, and only the cleanup still owed is tried again
      await this.complete(current, undefined);
      return;
    }
    const expected = ACTIVE_STATES.filter((state) => state !== 'purging');
    if (!expected.includes(current.state)) return;
    // The store re-reads under the anchor; a purge between get and update fails this exact-state guard.
    const left = await this.stores.runs.update(run.runId, { state: 'left', leftAt: at, reason: current.reason ?? 'crashed', reportedSeconds: this.countedSeconds(current.reportedSeconds, seconds), cleanupPending: true }, current.state);
    if (!left) {
      const fenced = await this.stores.runs.get(run.runId);
      if (fenced?.state === 'purging') await this.stores.runs.update(run.runId, { leftAt: fenced.leftAt ?? at, reportedSeconds: this.countedSeconds(fenced.reportedSeconds, seconds) }, 'purging');
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
    await this.stores.runs.update(runId, { ...done, dispatch: undefined, transcriber: undefined, pageSeenAt: undefined, monitorSeenAt: undefined, participantCount: undefined, leaveCommandedAt: undefined, captureSuspendedAt: undefined, aloneSince: undefined, cleanupPending: false }, 'purging');
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
        // bot, and without waiting for the provider's answer: the cleanup that follows deletes its room
        if (run.leaveCommandedAt !== undefined && run.leftAt === undefined && now - run.leaveCommandedAt > this.killAfterMs) {
          this.kill(run);
          await this.crash(run, now, undefined);
          continue;
        }
        if (run.state === 'purging') {
          // a fence written without its kill deadline (the process that wrote it stopped before the deadline's own write)
          // is armed now, so a bot that never hears the leave is killed and the purge finishes: the kill counts from here
          if (run.dispatch !== undefined && run.leftAt === undefined && run.leaveCommandedAt === undefined) await this.stores.runs.update(run.runId, { leaveCommandedAt: now }, 'purging');
          await this.continuePurge(run.runId);
          continue;
        }
        if (run.state === 'left') {
          // a cleanup that threw last time is tried again here, until `done` is written
          await this.complete(run, undefined);
          continue;
        }
        if (run.state === 'leaving') {
          // a leave written without its kill deadline is armed the same way, so it never waits for a bot that is gone
          if (run.leaveCommandedAt === undefined) await this.stores.runs.update(run.runId, { leaveCommandedAt: now }, 'leaving');
          continue;
        }
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
          // A stop monitor that has not reported once since the notice: capture never opened, and the run leaves when the
          // window and the recovery wait have both passed, as it does for a monitor that went quiet and stayed quiet. The
          // notice's time is the worker's own, so the wait counts from it but from no later than the end of the notice's
          // confirmation window after the bot entered the call (joinedAt, bounded on the manager's clock): a worker whose
          // clock runs ahead does not keep the run in the call for as long as it runs ahead.
          if (run.monitorSeenAt === undefined && run.noticePostedAt !== undefined) {
            const noticeAt = run.joinedAt === undefined ? run.noticePostedAt : Math.min(run.noticePostedAt, run.joinedAt + this.noticeConfirmMs);
            if (now - noticeAt > this.monitorHeartbeatMs * this.monitorMissedBeats + this.monitorRecoverMs) {
              await this.leave(run, 'stop_monitor_failed');
              continue;
            }
          }
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

  /**
   * Evicts completed in-memory runs after the grace. Durable stores omit forget and keep their terminal records. The
   * terminal runs are listed when the first of them can go, and at least once a minute (for a run that ended since, or
   * one a pending delivery held back), not on every pass.
   */
  private async cleanupExpired(): Promise<void> {
    const { runs, jobs, transcript, events, outbox, entitlement } = this.stores;
    if (!runs.forget || !jobs.forget || !transcript.forget || !events.forget || !outbox.forget) return;
    const now = this.now();
    if (now < this.nextCleanupAt) return;
    const grace = Math.max(86_400_000, this.config.forgetAfterMs ?? 172_800_000);
    // a run that ends from now on can go no sooner than a grace from now, at least a day, so a minute's wait misses none
    let next = now + 60_000;
    for (const run of await runs.list({ states: ['done', 'failed'], limit: Number.MAX_SAFE_INTEGER })) {
      if (run.doneAt === undefined) continue;
      const forgetAt = Math.max(run.doneAt, run.purgedAt ?? 0) + grace;
      if (now < forgetAt) {
        next = Math.min(next, forgetAt);
        continue;
      }
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
    this.nextCleanupAt = next;
  }

  // ── Reconcile ──

  /**
   * With `usageSilenceMs`, ends as crashed each dispatching or dispatched run whose worker has sent no fresh usage report
   * for that long: the run ends at the manager's receipt of its last usage report (its dispatch, when none came, or its
   * request) and at the total its reports gave, nothing when none did, and then the bot is sent a kill, not waited for, so
   * a kill the provider never answers holds back no settlement and no later run. The silence is decided again on the row
   * as the store holds it, in the same write as the end, so a usage report taken after the runs were listed keeps its run
   * and no kill goes to its worker. The rule rests on what the stores hold alone, never on the provider's answer or the
   * stop monitor's heartbeats, so a worker that cannot be reached, or one that answers and sends nothing, ends the same
   * way, and a manager that restarted ends it too. A dispatching run whose job was never recorded dispatched (its
   * dispatcher stopped first) is among them. A run whose step throws holds back no other, and the first error is thrown
   * at the end. Without `usageSilenceMs` it does nothing.
   */
  private async endSilentRuns(): Promise<void> {
    const silenceMs = this.usageSilenceMs;
    if (silenceMs === undefined) return;
    let failure: { error: unknown } | undefined;
    for (const listed of await this.stores.runs.list({ states: SILENCE_STATES, limit: Number.MAX_SAFE_INTEGER })) {
      if (this.now() - this.lastHeard(listed) < silenceMs) continue;
      try {
        // decided again on the row as the store holds it, in the write that ends the run: a usage report taken since the
        // list was read (while an earlier run's kill was on its way, say) keeps the run, and its worker is sent no kill
        let silentFor = 0;
        const left = await this.updateRunWith(listed.runId, (current) => {
          const heard = this.lastHeard(current);
          silentFor = this.now() - heard;
          if (!SILENCE_STATES.includes(current.state) || silentFor < silenceMs) return undefined;
          return { state: 'left', leftAt: heard, reason: current.reason ?? 'crashed', reportedSeconds: current.reportedSeconds ?? 0, cleanupPending: true };
        });
        if (!left) continue;
        this.config.logger?.warn(`[MeetingManager] ${left.runId}: no usage report for ${silentFor} ms; ended as crashed`);
        // not waited for: a kill that never answers holds neither this run's settlement nor the runs after it
        this.kill(left);
        await this.emit('bot:left', left, { reason: left.reason });
        await this.complete(left, left.reportedSeconds);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }

  /** When a run's worker was last heard from, as the usage silence counts it: the receipt of its last usage report, else its dispatch, else its request. */
  private lastHeard(run: MeetingRunRecord): number {
    return run.lastUsageAt ?? run.dispatchedAt ?? run.requestedAt;
  }

  /**
   * Writes the patch `patchFor` makes of the run's row as it stands: through the run store's `updateWith`, in one step
   * with the read, when the store has it. Otherwise the row is read and written with `update` guarded by the state read,
   * and read again when that state moved in between, three times at most; a write that keeps the state can still slip
   * between the read and the write. Undefined when `patchFor` answers undefined or the run does not exist.
   */
  private async updateRunWith(runId: string, patchFor: (current: MeetingRunRecord) => Partial<MeetingRunRecord> | undefined): Promise<MeetingRunRecord | undefined> {
    const runs = this.stores.runs;
    if (runs.updateWith) return runs.updateWith(runId, patchFor);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await runs.get(runId);
      const patch = current && patchFor(current);
      if (!current || !patch) return undefined;
      const updated = await runs.update(runId, patch, current.state);
      if (updated) return updated;
    }
    return undefined;
  }

  /**
   * Compares dispatched jobs with the providers' usage: a run whose container is gone is ended as crashed; an unfinished
   * purge is resumed; what a provider's supplier measured for a run is recorded through the entitlement hook's
   * `recordSupplierUsage`, when the hook has one. First, the supplier totals the hook refused before, kept in the stores'
   * `supplierUsageInbox`, are handed to it again; then, with `usageSilenceMs`, each run gone silent for that long is ended
   * at its last usage before any provider is asked, and a run whose container a provider reports gone ends at the total
   * its usage reports gave. An answer about a run the provider was not asked about is ignored and logged. A run still
   * waiting for its dispatch whose job is missing (a send whose job could not be stored) is given its job again, and one a
   * cancel left without its job (the cancel's reason is on the run) is ended, so neither waits for ever holding its
   * reservation. As in the limits, a run whose step throws holds back no other, and the first error is thrown at the end.
   */
  async reconcile(): Promise<void> {
    const now = this.now();
    let failure: { error: unknown } | undefined;
    try {
      await this.recordKeptSupplierUsage();
    } catch (error) {
      failure ??= { error };
    }
    // the usage silence before the providers are asked: a run it ends is over whatever a provider would answer
    try {
      await this.endSilentRuns();
    } catch (error) {
      failure ??= { error };
    }
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
      // only the runs this pass asked about: an answer about another run (another provider's, or one not polled) is not
      // the provider's to give, so neither its supplier totals nor its end are taken from it
      const asked = new Set(runIds);
      const answered = usage.filter((u) => asked.has(u.runId));
      if (answered.length < usage.length) {
        this.config.logger?.warn(`[MeetingManager] usage of ${providerName}: ${usage.length - answered.length} answer(s) about runs it was not asked about, ignored`);
      }
      for (const u of answered) {
        if (u.supplierUsage !== undefined) {
          // in a try of its own: a record that throws holds back neither this run's crash check nor any other run's. Totals
          // the hook refuses wait in the supplier usage inbox, so the crash below, whose cleanup removes the run's job and
          // with it the run from every later pass, loses none of them
          try {
            const supplierRun = await this.stores.runs.get(u.runId);
            if (supplierRun?.reservationId !== undefined) {
              const refused = await this.recordSupplierTotals(u.runId, supplierRun.reservationId, u.supplierUsage);
              if (refused) failure ??= refused;
            }
          } catch (error) {
            failure ??= { error };
          }
        }
        if (u.alive) continue;
        try {
          const run = await this.stores.runs.get(u.runId);
          if (run && (run.state === 'joining' || run.state === 'waiting_room' || run.state === 'in_call_notice_pending' || run.state === 'in_call' || run.state === 'leaving')) {
            this.config.logger?.warn(`[MeetingManager] ${run.runId}: worker reports no container; ending as crashed`);
            // with the silence rule a run bills only what its durable usage reports gave, never the provider's count
            await this.crash(run, now, this.usageSilenceMs === undefined ? u.seconds || undefined : run.reportedSeconds ?? 0);
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

  /**
   * Whether a run takes transcript turns now: it is not behind the fence or over, and its capture has started or the
   * capture interlock holds. The start is written on the run once the bot has answered `startCapture`, and the bot can
   * send its first audio, and so a first final, before that answer; a turn from audio a provider passed on before the
   * interlock held is dropped (the interlock does not rest on the provider alone). The transcript sink reads it too.
   *
   * @param run - The run as just read from its store.
   */
  takesTurns(run: MeetingRunRecord): boolean {
    if (run.state === 'purging' || TERMINAL_RUN_STATES.has(run.state)) return false;
    return run.captureStartedAt !== undefined || this.captureReady(run);
  }

  /**
   * A turn the listen session wrote: a `bot:transcript` event, stored and forwarded, unless the run takes no turns now
   * ({@link MeetingManager.takesTurns}: behind the fence or over, or before its capture can start) or its transcript is fenced.
   */
  async recordTranscript(turn: TranscriptTurn): Promise<boolean> {
    const run = await this.stores.runs.get(turn.runId);
    if (!run || !this.takesTurns(run) || await this.stores.transcript.isFenced(turn.runId)) return false;
    await this.emit('bot:transcript', run, { seq: turn.seq, turnId: turn.turnId, text: turn.text, speaker: turn.speaker, startMs: turn.startMs, endMs: turn.endMs }, `${turn.runId}:transcript:${turn.seq}`, turn.at);
    return true;
  }

  /** The sink a listen session writes to for one run: the transcript store behind the fence, then the event above. */
  transcriptSink(runId: string): ITranscriptInputSink {
    return new MeetingTranscriptSink({ manager: this, transcript: this.stores.transcript, runId });
  }
}
