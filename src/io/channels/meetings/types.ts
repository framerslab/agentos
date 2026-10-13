/**
 * @module channels/meetings/types
 *
 * The meeting-participant channel's types: a bot that joins a meeting as a
 * listener on a person's behalf, posts a notice, and leaves and purges on a
 * stop. The manager ({@link MeetingManager}) owns the run's life; a provider
 * ({@link IMeetingBotProvider}) owns one way of joining.
 */

import { z } from 'zod';
import { quoteCompoundLiability } from '../../../safety/runtime/CreditRates.js';

/** The platforms a provider may declare. */
export type MeetingPlatform = 'google_meet' | 'microsoft_teams' | 'zoom';

/**
 * A run's states, forward only. `purging` is the fence: once a run is there,
 * every store refuses new content for it, and the only exits are `done` or
 * `failed`.
 */
export type MeetingRunState =
  | 'requested'
  | 'scheduled'
  | 'dispatching'
  | 'joining'
  | 'waiting_room'
  | 'in_call_notice_pending'
  | 'in_call'
  | 'leaving'
  | 'left'
  | 'purging'
  | 'done'
  | 'failed';

/** The states a run never leaves. */
export const TERMINAL_RUN_STATES: ReadonlySet<MeetingRunState> = new Set<MeetingRunState>(['done', 'failed']);

/** The transitions the manager allows, from each state. A transition to the same state is always allowed and does nothing. */
export const RUN_TRANSITIONS: Readonly<Record<MeetingRunState, readonly MeetingRunState[]>> = {
  // a cancel or a purge before dispatch goes through the same fence as any other purge
  requested: ['scheduled', 'dispatching', 'purging', 'failed'],
  scheduled: ['dispatching', 'purging', 'failed'],
  // `left` from every state after dispatch: a bot leaves on its own (not admitted, alone, the cap, a crash) and reports it
  dispatching: ['joining', 'leaving', 'left', 'purging', 'failed'],
  joining: ['waiting_room', 'in_call_notice_pending', 'leaving', 'left', 'purging', 'failed'],
  waiting_room: ['in_call_notice_pending', 'leaving', 'left', 'purging', 'failed'],
  in_call_notice_pending: ['in_call', 'leaving', 'left', 'purging', 'failed'],
  in_call: ['leaving', 'left', 'purging', 'failed'],
  leaving: ['left', 'purging', 'failed'],
  left: ['done', 'purging', 'failed'],
  purging: ['done', 'failed'],
  done: [],
  failed: [],
};

/** Whether the manager may move a run from one state to another. */
export function canTransition(from: MeetingRunState, to: MeetingRunState): boolean {
  return from === to || RUN_TRANSITIONS[from].includes(to);
}

/** Why a run ended. The product shows each as a sentence. */
export type MeetingLeaveReason =
  | 'ended'
  | 'stopped_by_participant'
  | 'stopped_by_owner'
  | 'not_admitted'
  | 'notice_failed'
  | 'stop_monitor_failed'
  | 'alone'
  | 'allowance'
  | 'cap'
  | 'page_away'
  | 'declined'
  | 'no_capacity'
  | 'permission_denied'
  | 'stt_failed'
  | 'crashed';

/** Reasons that are never billed, whatever else happened. */
export const UNBILLED_REASONS: ReadonlySet<MeetingLeaveReason> = new Set<MeetingLeaveReason>([
  'not_admitted',
  'notice_failed',
  'stop_monitor_failed',
  'permission_denied',
  'no_capacity',
]);

/** A run is billed when it captured and its reason is not one of {@link UNBILLED_REASONS}. */
export function isBilledEnd(run: Pick<MeetingRunRecord, 'reason' | 'captureStartedAt'>): boolean {
  if (run.captureStartedAt === undefined) return false;
  return run.reason === undefined ? true : !UNBILLED_REASONS.has(run.reason);
}

/**
 * What a provider declares about itself. The notice text and the stop path
 * are written from this, never by hand per provider.
 */
export interface MeetingBotCapabilities {
  /** The bot joins as a participant the others see in the call. */
  joinsAsParticipant: boolean;
  /** The bot can post to the meeting's chat (the notice, and its short form for a late arrival). */
  postsChat: boolean;
  /** The bot reads the meeting's chat, which is where it watches for the stop phrase. */
  readsChat: boolean;
  /** How the audio reaches the listener: published into a room, or the platform's own media stream. */
  audioPath: 'livekit_room' | 'media_stream';
  /** The provider records no audio. */
  recordsAudio: false;
  /** The provider does not transcribe; the host's listen session does. */
  transcribes: false;
  /** The provider keeps no copy of what it heard or read. */
  keeps: 'nothing';
  /** How a participant stops the bot: the stop phrase in the chat, or a link the notice gives. */
  stopPath: 'chat' | 'link';
}

/** The limits the manager and the container both enforce, in milliseconds. */
export interface MeetingRunLimits {
  /** How long the bot waits to be admitted. */
  waitingRoomMs: number;
  /** How long the bot stays as the only participant. */
  aloneMs: number;
  /** The run's whole length from the join attempt. */
  totalMs: number;
  /** For a run sent from a page: how long the page may be away before the run ends. Absent for an API run. */
  pageAwayMs?: number;
}

/**
 * The limits a run takes where its request sets none: ten minutes in the
 * waiting room, five minutes alone, four hours in all. There is no
 * `pageAwayMs` here; a host that sends a run from a page passes its own.
 */
export const DEFAULT_RUN_LIMITS: Readonly<MeetingRunLimits> = { waitingRoomMs: 600_000, aloneMs: 300_000, totalMs: 14_400_000 };

/** The notice the bot posts, and its short form for a participant who joins later. */
export interface MeetingNotice {
  text: string;
  version: string;
  lateArrivalText: string;
}

/** What dispatch recorded: the room and the hash of the worker's per-run token. Never the token itself. */
export interface MeetingDispatchRecord {
  roomName: string;
  workerTokenHash: string;
  workerId?: string;
  providerRunRef?: string;
}

const wholeFunding = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveFunding = wholeFunding.refine((value) => value > 0);
const fundingId = z.string().min(1).max(512);
const fundingRate = z.object({ unit: z.enum(['second', 'millisecond', 'token', 'character', 'sample', 'request']), micro: wholeFunding, per: positiveFunding }).strict();
const fundingRates = z.object({ version: fundingId, currency: z.literal('USD'), reasoningInOutput: z.boolean(),
  components: z.record(z.string().min(1).max(128), z.object({ customer: fundingRate, supplier: fundingRate }).strict()),
  attemptMinimum: z.object({ customerMicro: wholeFunding, supplierMicro: wholeFunding }).strict().optional() }).strict();
const fundingBase = { accountRef: fundingId, policyVersion: fundingId, reservationRef: fundingId, maxSeconds: positiveFunding, expiresAt: positiveFunding };
/** Closed, additive funding snapshot; authority and prices are server-selected before the first run insert. */
export const MeetingFundingSnapshotSchema = z.discriminatedUnion('fundingMode', [
  z.object({ ...fundingBase, fundingMode: z.literal('bot_blocks'), blockSeconds: positiveFunding, maxLiability: z.object({ blocks: positiveFunding }).strict() }).strict(),
  z.object({ ...fundingBase, fundingMode: z.literal('developer_credit'), rates: fundingRates, mediaComponent: fundingId,
    maxLiability: z.object({ customerMicro: wholeFunding, supplierMicro: wholeFunding }).strict() }).strict(),
]);
/** Stable account, tariff, cap and branch for the lifetime of a run. */
export type MeetingFundingSnapshot = z.infer<typeof MeetingFundingSnapshotSchema>;
/** Terminal billing decision persisted before a possibly interrupted fence or settlement. */
export interface MeetingFundingSettlement {
  /** The seconds the run is billed: zero for an unbilled end, otherwise the measured connection rounded up to the second. */
  billedSeconds: number;
  /** Whether the run ends unbilled. */
  unbilled: boolean;
  /** The measured connection, in milliseconds, when the decision was taken from it. */
  connectedMs?: number;
}
/** Points where host authority and the original allocation must still be valid. */
export type MeetingFundingPhase = 'reserve' | 'revalidate' | 'dispatch' | 'heartbeat' | 'recovery';

/**
 * Canonical text for comparison: object keys sorted at every depth and arrays kept in order, so two equal values compare
 * equal whatever order their keys were written in. `undefined` is written as a marker, not dropped.
 */
function fundingJson(value: unknown): string {
  if (value === undefined) return "undefined"; if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(fundingJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${fundingJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
/** Canonical validated snapshot text for immutable comparison and reservation identity. */
export function meetingFundingIdentity(snapshot: MeetingFundingSnapshot): string {
  return fundingJson(MeetingFundingSnapshotSchema.parse(snapshot));
}
/** Validates a new row and refuses any change to already persisted funding identity or terminal intent. */
export function assertMeetingFundingChange(previous: MeetingRunRecord | undefined, next: MeetingRunRecord): void {
  const snapshot = next.funding === undefined ? undefined : MeetingFundingSnapshotSchema.parse(next.funding);
  if (previous && (previous.funding !== undefined || snapshot !== undefined) && (previous.runId !== next.runId || previous.ownerRef !== next.ownerRef || (previous.funding === undefined) !== (snapshot === undefined) || (previous.funding && snapshot && meetingFundingIdentity(previous.funding) !== meetingFundingIdentity(snapshot)))) throw new Error('immutable funding');
  if (previous?.fundingReservationId !== undefined && previous.fundingReservationId !== next.fundingReservationId) throw new Error('immutable funding reservation');
  if (previous?.funding && previous.reportedSeconds !== undefined && next.reportedSeconds !== undefined && next.reportedSeconds < previous.reportedSeconds) throw new Error('meeting funding usage refused');
  if (previous?.fundingSettlement !== undefined && fundingJson(previous.fundingSettlement) !== fundingJson(next.fundingSettlement)) throw new Error('immutable funding settlement');
  if (previous?.fundingCleanup && (!next.fundingCleanup || previous.fundingCleanup.unbilled !== next.fundingCleanup.unbilled || (previous.fundingCleanup.complete && !next.fundingCleanup.complete))) throw new Error('immutable funding cleanup');
  if (!snapshot) {
    if (next.fundingReservationId !== undefined || next.fundingSettlement !== undefined) throw new Error('funding snapshot missing');
    return;
  }
  if (snapshot.accountRef !== next.ownerRef || snapshot.reservationRef !== `meeting-funding:${next.runId}` || snapshot.expiresAt <= next.requestedAt || !Number.isSafeInteger(snapshot.maxSeconds * 1000) || snapshot.maxSeconds * 1000 < next.limits.totalMs) throw new Error('invalid funding identity or bound');
  if (snapshot.fundingMode === 'developer_credit') {
    if (snapshot.policyVersion !== snapshot.rates.version) throw new Error('funding tariff version mismatch');
    const quote = quoteCompoundLiability({ rates: snapshot.rates, mediaComponent: snapshot.mediaComponent, durationSeconds: snapshot.maxSeconds, attempts: { maxAttempts: 0, perAttempt: {} } });
    if (quote.customerMicro !== snapshot.maxLiability.customerMicro || quote.supplierMicro !== snapshot.maxLiability.supplierMicro) throw new Error('funding liability mismatch');
  } else if (snapshot.maxLiability.blocks < Math.ceil(snapshot.maxSeconds / snapshot.blockSeconds)) throw new Error('funding block bound too small');
  if (next.fundingReservationId !== undefined) fundingId.parse(next.fundingReservationId);
  if (next.fundingSettlement !== undefined) {
    const settlement = z.object({ billedSeconds: wholeFunding, unbilled: z.boolean(), connectedMs: wholeFunding.optional() }).strict().parse(next.fundingSettlement);
    if ((settlement.unbilled && settlement.billedSeconds !== 0) || (settlement.connectedMs !== undefined && !settlement.unbilled && settlement.billedSeconds !== Math.ceil(settlement.connectedMs / 1000))) throw new Error('invalid funding settlement');
  }
}

/** A run's row. The run store seals `meetingUrl` at rest with the product's key and opens it on read. */
export interface MeetingRunRecord {
  runId: string;
  /** The product's reference for who owns the run (an account, an API key's workspace). Opaque to the library. */
  ownerRef: string;
  providerName: string;
  /**
   * The provider's opaque reference for the connection the run was sent through (a credential's generation, for
   * example). The content-free row keeps it, so the runs sent through one connection can still be found, and their kept
   * content purged, after the connection's credentials are gone. It names no person and carries nothing of the meeting.
   */
  providerConnectionRef?: string;
  platform: MeetingPlatform;
  state: MeetingRunState;
  keep: 'none' | 'account';
  meetingUrl: string;
  botName: string;
  notice: MeetingNotice;
  stopPhrase: string;
  limits: MeetingRunLimits;
  idempotencyKey?: string;
  /** The transcriber the run uses, named in the notice (a provider id). */
  transcriber?: string;
  requestedAt: number;
  joinAt: number;
  dispatchedAt?: number;
  /** When the bot reached the meeting: its waiting room, then the call itself once it is admitted. The waiting-room limit counts from the first, the notice's confirmation from the second. */
  joinedAt?: number;
  /** When the bot confirmed its notice in the meeting's chat, as the worker reported it, on the worker's clock: the stop monitor's heartbeats are ordered against it on that clock. */
  noticePostedAt?: number;
  captureStartedAt?: number;
  leftAt?: number;
  doneAt?: number;
  reason?: MeetingLeaveReason;
  billedSeconds: number;
  reservationId?: string;
  consentRecordId?: string;
  dispatch?: MeetingDispatchRecord;
  /** The last time the run's page was seen (a run sent from a page). */
  pageSeenAt?: number;
  /**
   * When the last usage report was taken: on the manager's own clock when the host sets the manager's `usageSilenceMs`,
   * which measures a run's silence from it, and otherwise the report's own time.
   */
  lastUsageAt?: number;
  /**
   * The worker's own time on the last usage report taken, when the host sets the manager's `usageSilenceMs`: a usage
   * report the worker made no later than it (a report sent again, or one that arrives late) moves neither `lastUsageAt`
   * nor `reportedSeconds`.
   */
  lastUsageSourceAt?: number;
  /**
   * The largest running total of seconds the worker reported: at `left`, `done` or a crash, and on each usage report when
   * the host sets the manager's `usageSilenceMs`. What a settlement bills from.
   */
  reportedSeconds?: number;
  /** Set at `left`: the settlement, the cleanup and the room's deletion are still owed; cleared when `done` is written. */
  cleanupPending?: boolean;
  /** When a kept run's content was purged after `done` (a session's deletion). */
  purgedAt?: number;
  /**
   * The last heartbeat the stop monitor made at or after the notice, at its time bounded to one heartbeat interval past
   * the manager's clock, by which the limits measure the monitor's freshness. The notice's confirmation clears it, so a
   * heartbeat from before the notice is never taken for one after it.
   */
  monitorSeenAt?: number;
  /** How many participants besides the bot the provider last reported. */
  participantCount?: number;
  /** When the manager last accepted a report about the run, on the manager's own clock. */
  lastReportAt?: number;
  /**
   * When the bot was last told to leave: a bot that has not left the manager's `killAfterMs` later is killed. This and
   * the two fields after it are the manager's timers, kept on the row so that any manager sharing the stores, or one
   * that restarted, runs the limits on them.
   */
  leaveCommandedAt?: number;
  /** When capture was suspended because the stop monitor went quiet; cleared when capture resumes. */
  captureSuspendedAt?: number;
  /** Since when the provider has reported no participant besides the bot; cleared when one is reported. */
  aloneSince?: number;
  /**
   * Set while the run's creation through `MeetingManager.sendBotPrepared` is unfinished: its reservation, the host's
   * preparation or its job may still be owed. No job of such a run is dispatched. Cleared, with `creationContext`, once
   * the run's job is scheduled, and by the run's terminal write.
   */
  creationPending?: boolean;
  /** Opaque host preparation data, sealed at rest and removed before dispatch. */
  creationContext?: string;
  /** Immutable server-selected funding. Absence preserves legacy entitlement callers. */
  funding?: MeetingFundingSnapshot;
  /** Write-once actual block reservation or compound hold id. */
  fundingReservationId?: string;
  /** Write-once terminal decision; retained after content purge for idempotent recovery. */
  fundingSettlement?: MeetingFundingSettlement;
  /** Durable cleanup policy and completion; completion prevents repeated external close effects. */
  fundingCleanup?: { unbilled: boolean; complete: boolean };
}

/**
 * The terminal, content-free form of a run: ids, the provider's connection reference, platform, times, reason, seconds,
 * the notice version and the consent record. It keeps the usage evidence too (the last usage report's receipt and source
 * times, the reported total and the last report's time), so a run ended at its last usage can be checked after it is over.
 */
export function contentFreeRun(run: MeetingRunRecord): MeetingRunRecord {
  return {
    runId: run.runId,
    ownerRef: run.ownerRef,
    providerName: run.providerName,
    providerConnectionRef: run.providerConnectionRef,
    platform: run.platform,
    state: run.state,
    keep: run.keep,
    meetingUrl: '',
    botName: '',
    notice: { text: '', version: run.notice.version, lateArrivalText: '' },
    stopPhrase: '',
    limits: run.limits,
    idempotencyKey: run.idempotencyKey,
    requestedAt: run.requestedAt,
    joinAt: run.joinAt,
    dispatchedAt: run.dispatchedAt,
    joinedAt: run.joinedAt,
    noticePostedAt: run.noticePostedAt,
    captureStartedAt: run.captureStartedAt,
    leftAt: run.leftAt,
    doneAt: run.doneAt,
    reason: run.reason,
    billedSeconds: run.billedSeconds,
    reservationId: run.reservationId,
    funding: run.funding === undefined ? undefined : structuredClone(run.funding),
    fundingReservationId: run.fundingReservationId,
    fundingSettlement: run.fundingSettlement === undefined ? undefined : structuredClone(run.fundingSettlement),
    fundingCleanup: run.fundingCleanup === undefined ? undefined : structuredClone(run.fundingCleanup),
    consentRecordId: run.consentRecordId,
    lastUsageAt: run.lastUsageAt,
    lastUsageSourceAt: run.lastUsageSourceAt,
    reportedSeconds: run.reportedSeconds,
    lastReportAt: run.lastReportAt,
  };
}

/** The events the manager emits. `bot:done` and `bot:purged` carry no content. */
export type MeetingEventType =
  | 'bot:requested'
  | 'bot:scheduled'
  | 'bot:dispatching'
  | 'bot:joining'
  | 'bot:waiting_room'
  | 'bot:in_call'
  | 'bot:notice_posted'
  | 'bot:capture_started'
  | 'bot:capture_suspended'
  | 'bot:participant_joined'
  | 'bot:participant_left'
  | 'bot:chat_message'
  | 'bot:stop_command'
  | 'bot:transcript'
  | 'bot:usage'
  | 'bot:left'
  | 'bot:purged'
  | 'bot:done'
  | 'bot:error';

/** Event types whose payload is content a purge removes. */
export const CONTENT_EVENT_TYPES: ReadonlySet<MeetingEventType> = new Set<MeetingEventType>([
  'bot:chat_message',
  'bot:transcript',
  'bot:participant_joined',
  'bot:participant_left',
  'bot:stop_command',
]);

/** A stored event: a stable id, a sequence number per run, a type, a time and a payload. */
export interface MeetingEvent {
  eventId: string;
  runId: string;
  seq: number;
  type: MeetingEventType;
  at: number;
  data?: Record<string, unknown>;
  /** Set when a purge removed the payload. */
  purged?: boolean;
}

/** What a provider reports, after its parser normalised it. */
export type ProviderEventType =
  | 'joining'
  | 'waiting_room'
  | 'in_call'
  | 'notice_posted'
  | 'monitor_heartbeat'
  | 'participant_joined'
  | 'participant_left'
  | 'chat_message'
  | 'stop_command'
  | 'capture_started'
  | 'capture_suspended'
  | 'left'
  | 'done'
  | 'crashed'
  | 'usage'
  | 'error';

/**
 * What a provider's supplier (the platform that carries the run's media and bills for it) measured for a run, apart
 * from the seconds the manager bills the owner: how long the supplier's stream was open, and how much of it the run
 * captured. Both are running totals; a host records them through the entitlement hook's `recordSupplierUsage`.
 */
export interface SupplierUsage {
  /** Seconds the supplier's media stream was open for the run, so far. */
  streamSeconds: number;
  /** Seconds of that stream during which capture was open, so far. */
  captureSeconds: number;
  /** Set on the last totals the provider reports for the run. */
  final?: boolean;
}

/** Supplier totals the entitlement hook refused, as the manager's `supplierUsageInbox` keeps them until the hook records them. */
export interface PendingSupplierUsage {
  /** The run the totals were measured for. */
  runId: string;
  /** The run's reservation, which the hook records them against. */
  reservationId: string;
  /** The totals. */
  usage: SupplierUsage;
}

/** One report from a provider, in the channel's terms, as the provider's parser returns it. */
export interface NormalizedMeetingEvent {
  /** Stable: the provider supplies it or derives it from its own ids, never at random. */
  eventId: string;
  runId: string;
  type: ProviderEventType;
  at: number;
  data?: {
    /** Why the bot left, on `left`. */
    reason?: MeetingLeaveReason;
    /** The seconds the worker counted, on `usage`, `left`, `done` and `crashed`. */
    seconds?: number;
    /** A chat message's text. */
    text?: string;
    /** Who sent a chat message or a stop command. */
    sender?: string;
    /** The provider's reference for a participant who joined or left. */
    participantRef?: string;
    /** How many participants besides the bot, on `in_call` and when one joins or leaves. */
    participantCount?: number;
    /** An error's description, on `error`; on `left`, the provider's word for why the run ended, which `bot:left` carries beside the reason. */
    message?: string;
    /** What the provider's supplier measured so far, on any report: recorded whatever the run's state, a terminal one included. */
    supplierUsage?: SupplierUsage;
  };
}

/** A request to send a bot. */
export interface SendBotRequest {
  ownerRef: string;
  providerName?: string;
  platform: MeetingPlatform;
  meetingUrl: string;
  botName: string;
  keep: 'none' | 'account';
  /** Absent: now. */
  joinAt?: number;
  notice: MeetingNotice;
  stopPhrase: string;
  limits?: Partial<MeetingRunLimits>;
  idempotencyKey?: string;
  transcriber?: string;
  consentRecordId?: string;
}

/** Why a send was refused before any run was made. */
export type SendBotRefusal = 'no_provider' | 'invalid_url' | 'platform_paused' | 'allowance' | 'no_capacity' | 'permission_denied';

/** The outcome of a send: the run (`repeated` when an earlier send by the same owner with the same idempotency key made it), or the refusal and its message. */
export type SendBotResult = { ok: true; run: MeetingRunRecord; repeated: boolean } | { ok: false; reason: SendBotRefusal; message: string };

/** The transcript turn and its sink are the voice pipeline's types, re-exported here. */
export type { TranscriptTurn, ITranscriptSink } from '../../voice-pipeline/types.js';
