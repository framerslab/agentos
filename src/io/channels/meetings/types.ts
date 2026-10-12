/**
 * @module channels/meetings/types
 *
 * The meeting-participant channel's types: a bot that joins a meeting as a
 * listener on a person's behalf, posts a notice, and leaves and purges on a
 * stop. The manager ({@link MeetingManager}) owns the run's life; a provider
 * ({@link IMeetingBotProvider}) owns one way of joining.
 */

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

/** A run's row. The run store seals `meetingUrl` at rest with the product's key and opens it on read. */
export interface MeetingRunRecord {
  runId: string;
  /** The product's reference for who owns the run (an account, an API key's workspace). Opaque to the library. */
  ownerRef: string;
  providerName: string;
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
  joinedAt?: number;
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
  /** The last time a usage report arrived. */
  lastUsageAt?: number;
  /** The seconds the worker reported at `left` or `done`; what a purge bills from. */
  reportedSeconds?: number;
  /** Set at `left`: the settlement, the cleanup and the room's deletion are still owed; cleared when `done` is written. */
  cleanupPending?: boolean;
  /** When a kept run's content was purged after `done` (a session's deletion). */
  purgedAt?: number;
  /** The last time the stop monitor reported. */
  monitorSeenAt?: number;
  /** How many participants besides the bot the provider last reported. */
  participantCount?: number;
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
}

/** The terminal, content-free form of a run: ids, platform, times, reason, seconds, the notice version and the consent record. */
export function contentFreeRun(run: MeetingRunRecord): MeetingRunRecord {
  return {
    runId: run.runId,
    ownerRef: run.ownerRef,
    providerName: run.providerName,
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
    consentRecordId: run.consentRecordId,
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
    /** An error's description, on `error`. */
    message?: string;
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
