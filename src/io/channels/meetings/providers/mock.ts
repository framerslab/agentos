import { hashWorkerToken, workerTokenMatches } from '../signing.js';
import type {
  DispatchInput,
  DispatchResult,
  IMeetingBotProvider,
  ProviderCommand,
  ProviderEventContext,
  ProviderParseResult,
  ProviderUsage,
  ProviderVerificationResult,
} from '../IMeetingBotProvider.js';
import type { MeetingBotCapabilities, MeetingPlatform, MeetingRunRecord, NormalizedMeetingEvent, ProviderEventType } from '../types.js';

/** Builds the context a worker's report would produce, for tests. */
export function mockEventContext(
  runId: string,
  type: ProviderEventType,
  data: NormalizedMeetingEvent['data'],
  at: number,
  workerToken: string
): ProviderEventContext {
  return {
    providerName: 'mock',
    method: 'POST',
    url: `/events/mock/${runId}`,
    headers: { authorization: `Bearer ${workerToken}` },
    body: JSON.stringify({ runId, type, at, data }),
    runId,
  };
}

// The join links the mock accepts: a Meet meeting code link, and a Teams meeting link on either of Microsoft's hosts.
const MEET = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\?.*)?$/;
const TEAMS = /^https:\/\/teams\.(microsoft\.com|live\.com)\/(l\/)?meet(up-join)?\//;

/** A provider for tests: it records dispatches and commands, and its reports are driven by the test through {@link mockEventContext}. */
export class MockMeetingBotProvider implements IMeetingBotProvider {
  readonly name = 'mock';
  readonly platforms: readonly MeetingPlatform[] = ['google_meet', 'microsoft_teams'];
  readonly capabilities: MeetingBotCapabilities = {
    joinsAsParticipant: true,
    postsChat: true,
    readsChat: true,
    audioPath: 'livekit_room',
    recordsAudio: false,
    transcribes: false,
    keeps: 'nothing',
    stopPath: 'chat',
  };
  /** Each run's dispatch input, by run id. */
  readonly dispatched = new Map<string, DispatchInput>();
  /** Each run's commands, in the order they were sent. */
  readonly commands = new Map<string, ProviderCommand[]>();
  /** The run ids `deleteRun` was called with, in order. */
  readonly deleted: string[] = [];
  /** What `usage()` answers; tests set it. */
  alive = new Map<string, number>();
  /** When set, dispatch rejects with it (a worker with no slot). */
  dispatchError: Error | undefined;
  /** Runs inside `dispatch`, before it records anything: a test puts a race here (a cancel while the dispatch is in flight). */
  beforeDispatch: ((input: DispatchInput) => Promise<void>) | undefined;

  verifyEvent(ctx: ProviderEventContext, run: MeetingRunRecord | undefined): ProviderVerificationResult {
    const header = ctx.headers.authorization ?? ctx.headers.Authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const token = value?.startsWith('Bearer ') ? value.slice(7) : undefined;
    if (!token) return { valid: false, error: 'no bearer token' };
    if (!run?.dispatch) return { valid: false, error: 'no dispatch record for the run' };
    return workerTokenMatches(token, run.dispatch.workerTokenHash) ? { valid: true } : { valid: false, error: 'token mismatch' };
  }

  parseEvent(ctx: ProviderEventContext): ProviderParseResult {
    const raw = JSON.parse(typeof ctx.body === 'string' ? ctx.body : ctx.body.toString('utf8')) as {
      runId: string;
      type: ProviderEventType;
      at: number;
      data?: NormalizedMeetingEvent['data'];
    };
    return {
      events: [{ eventId: `mock:${raw.runId}:${raw.type}:${raw.at}`, runId: raw.runId, type: raw.type, at: raw.at, data: raw.data }],
      rawData: raw,
    };
  }

  checkJoinUrl(url: string): { ok: true; platform: MeetingPlatform } | { ok: false; message: string } {
    if (MEET.test(url)) return { ok: true, platform: 'google_meet' };
    if (TEAMS.test(url)) return { ok: true, platform: 'microsoft_teams' };
    return { ok: false, message: 'not a Google Meet or Microsoft Teams join link' };
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    if (this.dispatchError) throw this.dispatchError;
    await this.beforeDispatch?.(input);
    this.dispatched.set(input.run.runId, input);
    this.alive.set(input.run.runId, 0);
    return { workerId: 'mock-worker', providerRunRef: `mock-${input.run.runId}` };
  }

  async command(runId: string, command: ProviderCommand): Promise<void> {
    const list = this.commands.get(runId) ?? [];
    list.push(command);
    this.commands.set(runId, list);
  }

  async deleteRun(input: { runId: string }): Promise<{ deleted: boolean }> {
    this.deleted.push(input.runId);
    return { deleted: false };
  }

  async usage(input: { runIds?: string[] }): Promise<ProviderUsage[]> {
    const ids = input.runIds ?? [...this.alive.keys()];
    return ids.map((runId) => ({ runId, alive: this.alive.has(runId), seconds: this.alive.get(runId) ?? 0 }));
  }

  /** The token a run was dispatched with, for a test that drives its reports. */
  tokenOf(runId: string): string {
    const d = this.dispatched.get(runId);
    if (!d) throw new Error(`no dispatch for ${runId}`);
    return d.workerToken;
  }

  /** For a test that wants the hash a run store would hold. */
  static hash(token: string): string {
    return hashWorkerToken(token);
  }
}
