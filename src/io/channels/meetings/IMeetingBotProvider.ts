import type {
  MeetingBotCapabilities,
  MeetingLeaveReason,
  MeetingPlatform,
  MeetingRunRecord,
  NormalizedMeetingEvent,
} from './types.js';

/** What reached the product's events route: the provider authenticates and parses it. */
export interface ProviderEventContext {
  /** The provider the route names. */
  providerName: string;
  /** The request's HTTP method. */
  method: string;
  /** The request's URL. */
  url: string;
  /** The request's headers. */
  headers: Record<string, string | string[] | undefined>;
  /** The request's body as it arrived, before any parse. */
  body: string | Buffer;
  /** The run the report names, when the route can read it before parsing (a path parameter). */
  runId?: string;
}

/** A provider's verdict on whether a report is authentic. */
export interface ProviderVerificationResult {
  /** Whether the report is authentic. */
  valid: boolean;
  /** Why the report was refused. */
  error?: string;
}

/** The channel's events that one report holds. */
export interface ProviderParseResult {
  /** The report's events, each with a stable id. */
  events: NormalizedMeetingEvent[];
  /** The report as the provider decoded it. */
  rawData?: unknown;
}

/** What dispatch hands a provider. The tokens are minted at dispatch and never stored in clear. */
export interface DispatchInput {
  /** The run to start: its link, its bot's name, its notice, its stop phrase and its limits. */
  run: MeetingRunRecord;
  /** The run's room: the server's url, the room's name and the bot's publish-only token. */
  room: { url: string; name: string; publishToken: string };
  /** The per-run bearer token the worker presents on every report. */
  workerToken: string;
  /** Where the worker sends its reports. */
  reportUrl: string;
}

/** What a provider answers a dispatch with; the manager keeps both on the run's dispatch record. */
export interface DispatchResult {
  /** The worker that took the run. */
  workerId?: string;
  /** The provider's own reference for the run. */
  providerRunRef?: string;
}

/**
 * A command the manager sends to a run's bot: `startCapture` and
 * `suspendCapture` start and stop the audio it passes on, `postChat` posts to
 * the meeting's chat, `leave` leaves the meeting with a reason, and `kill`
 * stops the bot at once.
 */
export type ProviderCommand =
  | { name: 'startCapture' }
  | { name: 'suspendCapture' }
  | { name: 'postChat'; text: string }
  | { name: 'leave'; reason: MeetingLeaveReason }
  | { name: 'kill' };

/** One run as a provider's workers report it. */
export interface ProviderUsage {
  /** The run. */
  runId: string;
  /** Whether a worker still holds the run. */
  alive: boolean;
  /** The seconds the worker has counted for the run. */
  seconds: number;
}

/**
 * One way of joining meetings. A provider ships as an extension pack with the
 * kind `meeting-provider`; the host registers it on the manager.
 */
export interface IMeetingBotProvider {
  /** The name the manager registers the provider under; runs and reports carry it. */
  readonly name: string;
  /** The platforms the provider joins. */
  readonly platforms: readonly MeetingPlatform[];
  /** What the provider declares about itself; the notice and the stop path follow from it. */
  readonly capabilities: MeetingBotCapabilities;
  /** The provider's own authentication of a report: a platform's signature scheme, or the worker's per-run token against the run's dispatch record. */
  verifyEvent(ctx: ProviderEventContext, run: MeetingRunRecord | undefined): ProviderVerificationResult;
  /** Turns a verified report into the channel's events, each with a stable id; throws on a report it cannot read. */
  parseEvent(ctx: ProviderEventContext): ProviderParseResult;
  /** Tells a join url's platform, or why it is refused. */
  checkJoinUrl(url: string): { ok: true; platform: MeetingPlatform } | { ok: false; message: string };
  /** Hands the run to a worker with the room and the tokens minted for it; rejects when the run cannot start. */
  dispatch(input: DispatchInput): Promise<DispatchResult>;
  /**
   * Sends a command to the run's bot. A provider passes on no audio of a run
   * before the run's first `startCapture`, and none after a `suspendCapture`
   * until the next `startCapture`: the manager sends `startCapture` only once
   * the run's notice is confirmed posted and its stop monitor is healthy.
   */
  command(runId: string, command: ProviderCommand): Promise<void>;
  /** Deletes a provider's own copies of a run. Ours keep none; the method stands so a purge always has an answer. */
  deleteRun(input: { runId: string }): Promise<{ deleted: boolean }>;
  /** Each run asked for (every run the provider knows when `runIds` is absent), alive or not, with the seconds it has counted. */
  usage(input: { runIds?: string[] }): Promise<ProviderUsage[]>;
}
