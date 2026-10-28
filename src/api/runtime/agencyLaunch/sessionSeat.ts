/**
 * @file sessionSeat.ts
 * A roster member that runs one session of its own. `sessionSeat()` seats a persistent gmi() agent in an agency as
 * itself: its persona, cognition profile, tools and learning config, through a session of its own handle, never the
 * throwaway light GMI its `generate()` builds. `launch_agency` builds every seat of a launched team the same way
 * (`buildSessionSeat`). Every seat's session has memory scoped to the seat session and no learner (spec D5).
 */
import { randomUUID } from 'node:crypto';
import type { AgentOptions, AgentSession, SessionSendOptions } from '../../agent.js';
import type { GenerateTextResult } from '../../generateText.js';
import type { StreamTextResult } from '../../streamText.js';
import type { Agent, SeatMetadata } from '../../types.js';
import type { ApprovalGateFn } from '../approval-gate.js';
import type { SpendBudget, SpendBudgetOptions } from '../spendBudget.js';
import { adaptTools } from '../toolAdapter.js';
import {
  LAUNCH_AGENCY_TOOL_NAME,
  SEAT_SUMMARY_CHARS,
  gmiOptionsOf,
  isGmiHandle,
  refusedInSeat,
  stepsOutside,
  type AgencyLaunchFrame,
  type LaunchSeatRecord,
  type LaunchUsage,
  type SeatToolLike,
  type ToolCallHook,
} from './types.js';

/** Options of {@link sessionSeat}. */
export interface SessionSeatOptions {
  /** The seat's session id on the member, prefixed `seat:` (default `seat:<uuid>`); the seat's first call rejects when the member already has that id open. */
  sessionId?: string;
  /** What a hierarchical manager reads about this seat. Default: the member's persona description (the first line of its instructions, else its name). */
  description?: string;
  /** Seats this one waits for under the graph strategy. */
  dependsOn?: string[];
  /** Tool names the member may use in this seat. Default: all of its own but the five self-modification tools, launch_agency, the memory tools and a composed tool whose steps are not all among the rest. */
  tools?: string[];
  /** A role brief put before every input the seat receives: at most 1,000 characters. */
  brief?: string;
}

/**
 * A roster member that runs one session of its own; built by {@link sessionSeat} and by launch_agency. Its first call
 * opens the session, and fails when the member already serves a session under the seat's id: `generate()` rejects and
 * `stream()` throws, with the `TypeError` that names the id (a launch's seat, with that error's name alone).
 */
export interface SeatHandle extends Agent, SeatMetadata {
  /** The seat's session id on its member. */
  readonly seatId: string;
  /**
   * What the seat did so far; read by the launch for its result. A launch's seat with a call still running once its
   * launch has stopped reads `cut`: the launch reports without that call's answer.
   */
  record(): LaunchSeatRecord;
}

/** @internal What launch_agency adds to a seat's options. */
export interface InternalSeatOptions extends SessionSeatOptions {
  /** The seat's role in its team (a launch's seat); sessionSeat() has none. */
  role?: string;
  form: 'temporary' | 'persistent';
  /** The agentKey or personaId of a persistent member. */
  memberRef?: string;
  /** The explicit user the seat's session runs as: the parent turn's. sessionSeat() names none. */
  userId?: string;
  /** Memory scoped to the seat session and no learner (spec D5). Set when absent, so every seat's session is a seat session. */
  seat?: { memoryScope: 'session'; learner: 'none' };
  /** The frame each of the seat's turns carries (`metadata.agencyLaunch`). */
  frame?: AgencyLaunchFrame;
  /**
   * A launch's seat: the launch's own budget, charged whatever budget the per-call options carry (those carry the
   * coordinator's). The member's own budget, when it has one, is checked and charged beside it (gmi()), on the seat's
   * calls and on those of a team the seat launches; its refusal of a seat's call reaches the launch as a refusal by the
   * launch's budget does, so the seat is cut and the launch reports `budget_exhausted`.
   */
  budget?: SpendBudget;
  /** A launch's seat: the hooks the launching turn ran under, run before the member's own. */
  toolHooks?: readonly ToolCallHook[];
  /** A launch's seat: where a failed call's original error goes; the seat then rejects with its name and code alone. */
  logError?: (error: unknown, where: string) => void;
  /** True for a temporary seat: close() also closes the member, which the launch built. */
  ownsMember?: boolean;
  /**
   * A launch's seat: true once the launch has stopped (its signal aborted, or its budget is exhausted). A call that fails
   * then was cut, and so is a call still running when the launch reads the seat's record.
   */
  cutWhen?: () => boolean;
}

/** The send options a seat puts on its session's sends: the public ones and the internal keys gmi() reads. */
type SeatSendOptions = SessionSendOptions & {
  __approvalGate?: ApprovalGateFn;
  __launchFrame?: AgencyLaunchFrame;
  __toolNames?: ReadonlySet<string>;
  __toolHooks?: readonly ToolCallHook[];
};

/** A gmi() handle's session opener, which takes the internal `__seat` setting. */
type SeatSessionOpener = (id: string, options: { userId?: string; __seat: { memoryScope: 'session'; learner: 'none' } }) => AgentSession;

const emptyUsage = (): LaunchUsage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

/** Adds a result's usage to a seat's record. */
function addUsage(target: LaunchUsage, usage: unknown): void {
  if (!usage || typeof usage !== 'object') return;
  const u = usage as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  target.promptTokens += num(u.promptTokens);
  target.completionTokens += num(u.completionTokens);
  target.totalTokens += num(u.totalTokens);
  if (typeof u.costUSD === 'number' && Number.isFinite(u.costUSD)) target.costUSD = (target.costUSD ?? 0) + u.costUSD;
}

/** An error's code, when it carries a string or numeric one. */
function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : typeof code === 'number' ? String(code) : undefined;
}

/**
 * The error a launch's seat rejects with: the original's name and code alone. A provider's or a handler's message can
 * carry a URL or a credential, and a hierarchical manager's delegate tool hands a seat's rejection to the manager's
 * model (spec D16).
 */
function seatError(name: string, code: string | undefined): Error {
  const error = new Error(code ? `${name} (${code})` : name);
  error.name = name;
  if (code) (error as Error & { code?: string }).code = code;
  return error;
}

/**
 * The persona description gmi() gives an agent: the first line of its instructions, else its name.
 *
 * @internal
 */
export function descriptionOf(config: { instructions?: string; name?: string }): string | undefined {
  return config.instructions?.split('\n').map((line) => line.trim()).find(Boolean) ?? (config.name?.trim() || undefined);
}

/**
 * The error part of a stream that has ended, else an error of its own. A GMI stream's parts stay readable once it has
 * ended, so this reads them without waiting.
 */
async function streamErrorOf(result: StreamTextResult): Promise<unknown> {
  for await (const part of result.fullStream) {
    if (part.type === 'error') return part.error;
  }
  return new Error('the stream ended with an error');
}

/**
 * Seats a persistent gmi() agent in an agency as itself: its own persona, cognition profile, tools and learning
 * config, through a session of its own handle. The session opens on the seat's first call and runs every call of the
 * run, so a manager that delegates twice to the seat finds the first exchange. The session's memory is scoped to the
 * seat session and it has no learner: a team turn's input is a manager's or a sibling's text. Each call of the session
 * is checked against, and charged to, the member's own `budget` beside the budget the agency's call carries, and a refusal
 * by the member's own runs the carried budget's `onLimitReached` function, as a refusal by that budget's parent does.
 * `agency().close()` closes the seat's session and leaves the member serving its own users.
 *
 * @param member - A gmi() handle (gmi() or agent({ runtime: 'gmi' })).
 * @param options - The seat's session id, description, dependencies, tool names and brief.
 * @returns A roster member for `agency({ agents })`.
 * @throws {TypeError} For a member that is not a gmi() handle, a brief over 1,000 characters, or a `tools` entry the
 *   member does not have, that never runs in a seat (a self-modification or memory tool), that is launch_agency (only a
 *   launch gives a seat that tool), or that is a composed tool whose steps are not all among `tools`.
 */
export function sessionSeat(member: Agent, options: SessionSeatOptions = {}): SeatHandle {
  if (!isGmiHandle(member)) {
    throw new TypeError("sessionSeat(): the member must be a gmi() agent (gmi() or agent({ runtime: 'gmi' })); a legacy agent's session takes no approval gate or frame per send, and its sessions are not GMIs");
  }
  if (options.brief !== undefined && options.brief.length > 1_000) throw new TypeError('sessionSeat(): brief is at most 1,000 characters');
  const config: Partial<AgentOptions> = gmiOptionsOf(member) ?? {};
  const own: SeatToolLike[] = adaptTools(config.tools);
  const byName = new Map<string, SeatToolLike>(own.map((tool) => [tool.name, tool]));
  const ownNames = new Set(byName.keys());
  if ((config as { agencies?: { launch?: boolean } }).agencies?.launch === true) ownNames.add(LAUNCH_AGENCY_TOOL_NAME);
  /** Why `name` is never among a sessionSeat()'s tools, or undefined. */
  const why = (name: string): string | undefined => {
    if (name === LAUNCH_AGENCY_TOOL_NAME) return 'runs in a seat only when a launch gives it';
    const refused = refusedInSeat(name);
    return refused ? `is ${refused} and never runs in a seat` : undefined;
  };
  const toolOf = (name: string) => byName.get(name);

  let names: string[];
  if (options.tools) {
    names = [...new Set(options.tools)];
    for (const name of names) {
      if (!ownNames.has(name)) throw new TypeError(`sessionSeat(): the member has no tool '${name}'`);
      const refused = why(name);
      if (refused) throw new TypeError(`sessionSeat(): '${name}' ${refused}`);
    }
    const allowed = new Set(names);
    for (const name of names) {
      const outside = stepsOutside(toolOf(name), allowed, toolOf);
      if (outside.length > 0) throw new TypeError(`sessionSeat(): '${name}' is a composed tool whose step '${outside[0]}' is not among the seat's tools`);
    }
  } else {
    const kept = [...ownNames].filter((name) => !why(name));
    const allowed = new Set(kept);
    names = kept.filter((name) => stepsOutside(toolOf(name), allowed, toolOf).length === 0);
  }

  const description = options.description ?? descriptionOf(config);
  return buildSessionSeat(member, {
    ...options,
    sessionId: `seat:${options.sessionId ?? randomUUID()}`,
    form: 'persistent',
    tools: names,
    ...(description ? { description } : {}),
  });
}

/**
 * Builds a seat over `member`'s session (sessionSeat() and launch_agency).
 *
 * @internal
 */
export function buildSessionSeat(member: Agent, options: InternalSeatOptions): SeatHandle {
  const seatId = options.sessionId ?? `seat:${randomUUID()}`;
  const seatSettings = options.seat ?? { memoryScope: 'session' as const, learner: 'none' as const };
  const toolNames: ReadonlySet<string> | undefined = options.tools ? new Set(options.tools) : undefined;
  const record: LaunchSeatRecord = {
    role: options.role ?? seatId,
    form: options.form,
    ...(options.memberRef ? { member: options.memberRef } : {}),
    status: 'not_run',
    calls: 0,
    summary: '',
    usage: emptyUsage(),
  };
  let session: AgentSession | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  /** The seat's calls in flight. */
  let running = 0;

  const open = (): AgentSession => {
    if (!session) {
      const opener = (member as unknown as { session: SeatSessionOpener }).session.bind(member);
      session = opener(seatId, { ...(options.userId !== undefined ? { userId: options.userId } : {}), __seat: seatSettings });
    }
    return session;
  };

  /** The input with the seat's role and brief before it: a persistent seat's role, a sessionSeat()'s brief. */
  const framed = (input: string): string => {
    const role = options.form === 'persistent' ? options.role : undefined;
    const brief = options.brief?.trim();
    if (!role && !brief) return input;
    const lead = role ? `Your role in this team: ${role}.${brief ? ` ${brief}` : ''}` : `Your role in this team: ${brief}`;
    return `${lead}\n\n${input}`;
  };

  /** What the seat puts on a send: the call's stop and gate, the launch's budget (else the call's), the frame, names and hooks. */
  const sendOptions = (opts: Record<string, unknown> | undefined): SeatSendOptions => {
    const signal = opts?.abortSignal as AbortSignal | undefined;
    const gate = opts?.__approvalGate as ApprovalGateFn | undefined;
    const budget = options.budget ?? (opts?.budget as SpendBudget | SpendBudgetOptions | undefined);
    return {
      ...(signal ? { abortSignal: signal } : {}),
      ...(budget ? { budget } : {}),
      ...(gate ? { __approvalGate: gate } : {}),
      ...(options.frame ? { __launchFrame: options.frame } : {}),
      ...(toolNames ? { __toolNames: toolNames } : {}),
      ...(options.toolHooks && options.toolHooks.length > 0 ? { __toolHooks: options.toolHooks } : {}),
    };
  };

  /** Records a failed call and returns the error the seat rejects with. */
  const failed = (error: unknown, signal: AbortSignal | undefined): unknown => {
    const cut = signal?.aborted === true || options.cutWhen?.() === true;
    const name = error instanceof Error ? error.name : 'Error';
    const code = codeOf(error);
    record.status = cut ? 'cut' : 'failed';
    record.error = { name, ...(code ? { code } : {}) };
    if (!options.logError) return error;
    options.logError(error, `seat ${record.role}`);
    return seatError(name, code);
  };

  /** Records a call that answered. */
  const answered = (text: string): void => {
    record.status = 'completed';
    delete record.error;
    record.summary = text.length > SEAT_SUMMARY_CHARS ? text.slice(0, SEAT_SUMMARY_CHARS) : text;
  };

  const handle: SeatHandle = {
    seatId,
    ...(options.description ? { description: options.description } : {}),
    ...(options.dependsOn ? { dependsOn: [...options.dependsOn] } : {}),

    async generate(prompt: string, opts?: Record<string, unknown>): Promise<GenerateTextResult> {
      if (closed) throw new Error('seat closed');
      record.calls += 1;
      running += 1;
      const send = sendOptions(opts);
      try {
        const result = (await open().send(framed(prompt), send)) as GenerateTextResult;
        answered(result.text ?? '');
        addUsage(record.usage, result.usage);
        return result;
      } catch (error) {
        throw failed(error, send.abortSignal);
      } finally {
        running -= 1;
      }
    },

    stream(prompt: string, opts?: Record<string, unknown>): StreamTextResult {
      if (closed) throw new Error('seat closed');
      record.calls += 1;
      const send = sendOptions(opts);
      let result: StreamTextResult;
      try {
        result = open().stream(framed(prompt), send as { abortSignal?: AbortSignal });
      } catch (error) {
        throw failed(error, send.abortSignal);
      }
      running += 1;
      // A GMI stream resolves its text when its turn fails too, and ends with an error part: the finish reason says
      // which it was. Its usage resolves either way, failed attempts included.
      const settle = async (): Promise<void> => {
        try {
          const [text, finishReason] = await Promise.all([result.text, result.finishReason]);
          if (finishReason === 'error') failed(await streamErrorOf(result), send.abortSignal);
          else answered(text);
        } catch (error) {
          failed(error, send.abortSignal);
        } finally {
          running -= 1;
        }
      };
      void settle().catch(() => undefined);
      void Promise.resolve(result.usage).then(
        (usage) => addUsage(record.usage, usage),
        () => undefined,
      );
      return result;
    },

    session(): never {
      throw new Error('a seat runs one session; call generate()');
    },

    async usage(): Promise<LaunchUsage> {
      return { ...record.usage };
    },

    close(): Promise<void> {
      closing ??= (async () => {
        closed = true;
        try {
          await session?.close();
        } finally {
          if (options.ownsMember) await member.close();
        }
      })();
      return closing;
    },

    record(): LaunchSeatRecord {
      // A call still running once the launch has stopped (its deadline, its parent's stop, its budget) is cut, whatever
      // the seat's earlier calls came to: the launch reports without that call's answer.
      const cut = running > 0 && options.cutWhen?.() === true;
      return { ...record, ...(cut ? { status: 'cut' as const } : {}), usage: { ...record.usage }, ...(record.error ? { error: { ...record.error } } : {}) };
    },
  };
  return handle;
}
