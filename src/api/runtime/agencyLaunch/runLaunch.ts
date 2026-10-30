/**
 * @file runLaunch.ts
 * The launch engine: one run of `launch_agency` on either surface, through a host that knows the surface (gmi() or
 * the full runtime). It validates, resolves the parent (a frame naming a launch in flight, or the turn itself), applies
 * the bounds, sizes the child budget, admits the launch, builds the seats, runs the child agency once, settles under one
 * deadline and one grace, closes the team and returns one tool result. It never throws.
 * @internal
 */
import { randomUUID } from 'node:crypto';
import { agency } from '../../agency.js';
import type { Agent, AgencyCallbacks, AgencyOptions, AgencyStrategy } from '../../types.js';
import { AgencyConfigError } from '../../types.js';
import { IDENTIFIER_PATTERN } from '../../../cognition/emergent/ToolName.js';
import type { ToolExecutionContext, ToolExecutionResult } from '../../../core/tools/ITool.js';
import type { ApprovalGateFn } from '../approval-gate.js';
import { SpendBudget, type SpendLimitInfo } from '../spendBudget.js';
import type { AgentOSUsageLedgerOptions } from '../usageLedger.js';
import { launchRegistry, type LaunchEntry } from './launchRegistry.js';
import type { SeatHandle } from './sessionSeat.js';
import {
  LAUNCH_AGENCY_TOOL_NAME,
  LAUNCH_SETTLE_GRACE_MS,
  LAUNCH_STRATEGIES,
  LAUNCH_TEXT_CHARS,
  MAX_ROLE_CHARS,
  MIN_LAUNCH_TOKENS,
  refusedInSeat,
  stepsOutside,
  type AgencyLaunchFrame,
  type LaunchAgencyArgs,
  type LaunchAgencyResult,
  type LaunchLimits,
  type LaunchRecordMetadata,
  type LaunchRefusal,
  type LaunchSeatRecord,
  type LaunchStatus,
  type LaunchUsage,
  type SeatToolLike,
  type ToolCallHook,
} from './types.js';

/** The six strategies a launch offers, the list the tool's input schema names. */
const STRATEGIES: readonly AgencyStrategy[] = LAUNCH_STRATEGIES;
const ARG_KEYS: ReadonlySet<string> = new Set(['goal', 'strategy', 'seats', 'budgetUsd', 'maxTokens', 'deadlineMs', 'maxRounds']);
const SEAT_KEYS: ReadonlySet<string> = new Set(['role', 'instructions', 'agentKey', 'personaId', 'brief', 'tools', 'dependsOn']);
/**
 * The role names EmergentAgentForge reserves (private there). A role also matches the forge's identifier pattern
 * ({@link IDENTIFIER_PATTERN}) and never starts with the hierarchical strategy's own tool prefix: a role becomes a
 * `delegate_to_<role>` tool.
 */
const RESERVED_ROLES: ReadonlySet<string> = new Set(['spawn_specialist', 'delegate_to_self', 'final_answer', 'plan']);
const MAX_GOAL_CHARS = 8_000;
const MAX_INSTRUCTIONS_CHARS = 8_192;
const MAX_BRIEF_CHARS = 1_000;

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The launching turn, as a launch sees it. */
export interface LaunchParent {
  gmiId: string;
  personaId: string;
  sessionId: string;
  conversationId?: string;
  /** 0 at the root. */
  depth: number;
  limits: LaunchLimits;
  budget?: SpendBudget;
  approvalGate?: ApprovalGateFn;
  signal?: AbortSignal;
  providerUserId?: string;
  namespace: string;
  /** ctx.correlationId: the parent turn, whose launch pool a root launch draws on. */
  turnId?: string;
  /** The hooks the parent turn's calls ran under, outermost first. */
  toolHooks: readonly ToolCallHook[];
  /**
   * The output tokens one call of a temporary seat the launch builds is counted with, on the route its host builds it
   * on. The one-call floor counts it for each temporary seat; a persistent member's call is counted on its own route.
   */
  outputEstimateTokens: number;
  /**
   * The root scope's id: the launching session as its agent knows it, never the calling GMI. On
   * gmi() an id made once per agent and the session id, so two agents' sessions of one id are two scopes and a session
   * that keeps no history (a GMI per turn) is one; on the full runtime the session's GMI and the session id. A nested
   * launch's scope is its parent launch.
   */
  scopeId: string;
  /**
   * An object that lives as long as the GMI that runs the launching turn (on gmi(), the tool view the call came
   * through, `callerTurn.dispatch`): a root launch's turn pool is kept by it, so no bound on root scopes drops the pool
   * between two launches of a turn. Unset, the registry keeps the pool by scope, under that bound.
   */
  poolOwner?: object;
}

/** One seat after step 3: its form, its member, its names. */
export type ResolvedSeat =
  | { role: string; form: 'temporary'; instructions: string; toolNames: ReadonlySet<string>; dependsOn?: string[] }
  | { role: string; form: 'persistent'; ref: string; brief?: string; toolNames: ReadonlySet<string>; dependsOn?: string[] };

/** What a launch needs of its surface (gmi() or the full runtime). */
export interface LaunchHost {
  surface: 'gmi' | 'runtime';
  /** The parent of a root launch (no frame): depth 0. */
  rootParent(ctx: ToolExecutionContext): Promise<LaunchParent | LaunchRefusal>;
  /**
   * The output tokens one call of a seat this host builds is counted with: the one-call floor of a nested launch it
   * runs, whose seats it builds on its own route (a persistent member that launches from its seat builds them on the
   * member's, not the root's). Unset, a nested launch counts the one its parent launch's entry holds.
   */
  outputEstimateTokens?(ctx: ToolExecutionContext): Promise<number>;
  /**
   * The output tokens one call of a persistent member's seat is counted with: its calls run on the member's own route
   * (an `agentKey` member on gmi(), a `personaId` seat on the full runtime). Unset, or undefined for a member, the
   * floor counts the parent's estimate for that seat.
   */
  memberOutputEstimateTokens?(ref: string): Promise<number | undefined>;
  /** A root launch's parent tool names; a nested launch reads its seat's from the entry. */
  parentToolNames(ctx: ToolExecutionContext, parent: LaunchParent): Promise<ReadonlySet<string>>;
  /** A tool of the parent's table by name, read for a composition's step tools. */
  toolOf(ctx: ToolExecutionContext, name: string): Promise<SeatToolLike | undefined>;
  /** Whether a member exists: an agentKey on gmi(), a personaId on the runtime. */
  hasMember(ref: string): boolean;
  /** Builds one seat; a refusal for a member that cannot be seated. Never throws. */
  buildSeat(seat: ResolvedSeat, launch: LaunchEntry, parent: LaunchParent, frame: AgencyLaunchFrame, cutWhen: () => boolean): Promise<SeatHandle | LaunchRefusal>;
  /** The child agency's own route: its manager's and synthesizers'. */
  agencyRoute(parent: LaunchParent): Promise<Pick<AgencyOptions, 'provider' | 'model' | 'apiKey' | 'baseUrl'>>;
  /** The host's callbacks, for the child agency's `on`. */
  callbacks?: AgencyCallbacks;
  /** gmi(): the parent's usage ledger, which the coordinator's calls record to under source `launch_agency`. */
  usageLedger?: AgentOSUsageLedgerOptions;
  /** The full runtime's registry entry; no-ops on gmi(). A recorder that throws is logged and the launch goes on. */
  recorder: {
    start(record: { agencyId: string; conversationId: string; meta: LaunchRecordMetadata; seats: SeatHandle[] }): void;
    close(result: LaunchAgencyResult): void;
  };
  logError(error: unknown, where: string): void;
  /** @internal The settle grace (tests shorten it); default LAUNCH_SETTLE_GRACE_MS. */
  settleGraceMs?: number;
}

/** What the run came to. */
type RunOutcome = { kind: 'resolved'; text: string } | { kind: 'rejected'; error: unknown } | { kind: 'unsettled' } | { kind: 'not_run' };

/** Why the launch stopped early, set by the budget's function, the deadline and the parent's stop. */
interface LaunchState {
  exhausted: boolean;
  /** The refusal that marked the launch exhausted: its own budget's, or that of a budget its calls draw on. */
  refusal?: SpendLimitInfo;
  timedOut: boolean;
  cancelled: boolean;
}

/** A launch past admission: everything steps 6 to 10 read. */
interface AdmittedLaunch {
  host: LaunchHost;
  args: LaunchAgencyArgs;
  parent: LaunchParent;
  entry: LaunchEntry;
  seats: ResolvedSeat[];
  strategy: AgencyStrategy;
  child: SpendBudget;
  coordinator: SpendBudget;
  caps: { maxCostUSD: number; maxTotalTokens: number };
  state: LaunchState;
  controller: AbortController;
  deadlineMs: number;
  startedAt: Date;
}

const ZERO_USAGE = (): LaunchUsage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

/** A refusal as a tool result: `processToolCall` hands the model `error` and `details`. */
function refused(refusal: LaunchRefusal): ToolExecutionResult<LaunchAgencyResult> {
  return { success: false, error: `${refusal.code}: ${refusal.reason}`, details: { code: refusal.code, reason: refusal.reason } };
}

function isRefusal(value: unknown): value is LaunchRefusal {
  return typeof value === 'object' && value !== null && typeof (value as LaunchRefusal).code === 'string' && typeof (value as LaunchRefusal).reason === 'string';
}

/**
 * Logs through the host, ignoring a logger that throws: the launch's result and its seats' release come first, and
 * `runLaunch` never throws. A host's own logger, such as one passed to `AgentOS.create`, makes no promise not to
 * throw.
 */
function logSafely(host: LaunchHost, error: unknown, where: string): void {
  try {
    host.logError(error, where);
  } catch {
    // A logger that throws is not a failure of the launch.
  }
}

/** The frame a turn's tool call carries (`sessionData.agencyLaunch`), when it is well formed. */
function frameIn(sessionData: Record<string, unknown> | undefined): AgencyLaunchFrame | undefined {
  const frame = sessionData?.agencyLaunch as Partial<AgencyLaunchFrame> | undefined;
  if (!frame || typeof frame.launchId !== 'string' || typeof frame.role !== 'string' || typeof frame.depth !== 'number') return undefined;
  return { launchId: frame.launchId, role: frame.role, depth: frame.depth };
}

/**
 * Step 2: the parent. A frame naming a live entry gives the depth, the limits, the user, the namespace and the calling
 * seat's names; the call's own context gives the gate, the hooks it carries (the entry's then the member's own) and the
 * budget (the seat's turn's: the entry's, held on gmi() beside a persistent member's own), else the entry's. A frame
 * naming a closing or missing entry is refused. No frame: the host's root.
 */
async function resolveParent(host: LaunchHost, ctx: ToolExecutionContext): Promise<{ parent: LaunchParent; toolNames: ReadonlySet<string>; frame?: AgencyLaunchFrame } | LaunchRefusal> {
  const frame = frameIn(ctx.sessionData);
  if (!frame) {
    const root = await host.rootParent(ctx);
    if (isRefusal(root)) return root;
    return { parent: root, toolNames: await host.parentToolNames(ctx, root) };
  }
  const entry = launchRegistry.get(frame.launchId);
  if (!entry || entry.state === 'closing') {
    return { code: 'parent_launch_closed', reason: `the team this turn sits in (${frame.launchId}) is closing or gone` };
  }
  const gate = ctx.callerTurn?.approvalGate ?? entry.approvalGate;
  const conversationId = ctx.sessionData?.conversationId;
  // The temporary seats this launch builds run on its host's route: the floor counts a call of one with its estimate.
  const outputEstimateTokens = host.outputEstimateTokens ? await host.outputEstimateTokens(ctx) : entry.outputEstimateTokens;
  return {
    frame,
    toolNames: entry.seatTools.get(frame.role) ?? new Set<string>(),
    parent: {
      gmiId: ctx.gmiId,
      personaId: ctx.personaId,
      sessionId: String(ctx.sessionData?.sessionId ?? ctx.gmiId),
      ...(typeof conversationId === 'string' ? { conversationId } : {}),
      depth: entry.depth,
      limits: entry.limits,
      // The seat's turn's budget draws on the entry's, so the tree stays under its root; a persistent member's own
      // budget, held beside it, bounds the teams the member launches from its seat as it bounds the member's calls.
      budget: ctx.callerTurn?.budget ?? entry.budget,
      ...(gate ? { approvalGate: gate } : {}),
      signal: ctx.signal ? AbortSignal.any([entry.signal, ctx.signal]) : entry.signal,
      ...(entry.providerUserId !== undefined ? { providerUserId: entry.providerUserId } : {}),
      namespace: entry.namespace,
      ...(ctx.correlationId ? { turnId: ctx.correlationId } : {}),
      toolHooks: ctx.callerTurn?.toolHooks ?? entry.toolHooks,
      outputEstimateTokens,
      // A nested launch's scope is the launch its team comes from.
      scopeId: frame.launchId,
    },
  };
}

/**
 * Step 4's one-call floor: the output tokens of the largest call one of the launch's seats makes, so the cap covers a
 * call of any seat, counted alone. A temporary seat runs on the route its host builds it on
 * (`parent.outputEstimateTokens`); a persistent member on its own, as its host counts it. A coordinator's call (a
 * hierarchical manager's, a parallel or debate synthesizer's) is not in the floor: like every call, it is checked
 * against the launch's budget before it is sent.
 */
async function seatsOutputEstimate(host: LaunchHost, parent: LaunchParent, seats: readonly ResolvedSeat[]): Promise<number> {
  let estimate = 0;
  for (const seat of seats) {
    const own = seat.form === 'persistent' ? await host.memberOutputEstimateTokens?.(seat.ref) : undefined;
    estimate = Math.max(estimate, own ?? parent.outputEstimateTokens);
  }
  return estimate;
}

/** Every tool the allowlists name and, for each composition, its step tools in turn, each read once. */
async function collectTools(names: string[], toolOf: (name: string) => Promise<SeatToolLike | undefined>): Promise<Map<string, SeatToolLike | undefined>> {
  const found = new Map<string, SeatToolLike | undefined>();
  const queue = [...new Set(names)];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (found.has(name)) continue;
    const tool = await toolOf(name);
    found.set(name, tool);
    for (const step of tool?.stepTools ?? []) if (!found.has(step)) queue.push(step);
  }
  return found;
}

/**
 * Step 3: the bounds. The level against `maxDepth`, the seat count against `maxSeats`, the forms the surface takes,
 * the members, and each allowlist: a self-modification or memory tool, or launch_agency where the seat's level cannot
 * launch, is `tool_not_allowed`; a name the parent lacks is `unknown_tool`; a composed tool any of whose step tools the
 * same allowlist leaves out is `tool_not_allowed`.
 */
async function checkBounds(host: LaunchHost, ctx: ToolExecutionContext, args: LaunchAgencyArgs, parent: LaunchParent, parentNames: ReadonlySet<string>): Promise<ResolvedSeat[] | LaunchRefusal> {
  const { limits } = parent;
  const level = parent.depth + 1;
  if (level > limits.maxDepth) return { code: 'depth_exceeded', reason: `a team at level ${level} would pass maxDepth ${limits.maxDepth}` };
  if (args.seats.length > limits.maxSeats) return { code: 'too_many_seats', reason: `${args.seats.length} seats; at most ${limits.maxSeats}` };
  const canLaunch = level + 1 <= limits.maxDepth;
  const tools = await collectTools(args.seats.flatMap((seat) => seat.tools ?? []), (name) => host.toolOf(ctx, name));
  const refs = new Set<string>();
  const resolved: ResolvedSeat[] = [];
  for (const seat of args.seats) {
    const fields = seat as { agentKey?: string; personaId?: string; instructions?: string; brief?: string };
    if (fields.personaId !== undefined && host.surface === 'gmi') {
      return { code: 'seat_form_unsupported', reason: `seat '${seat.role}': personaId seats run on the full runtime; name a member by agentKey` };
    }
    if (fields.agentKey !== undefined && host.surface === 'runtime') {
      return { code: 'seat_form_unsupported', reason: `seat '${seat.role}': agentKey seats run on gmi(); name a registered persona by personaId` };
    }
    const ref = fields.agentKey ?? fields.personaId;
    if (ref !== undefined) {
      if (!host.hasMember(ref)) return { code: 'unknown_member', reason: `seat '${seat.role}': no member '${ref}'` };
      if (refs.has(ref)) return { code: 'duplicate_member', reason: `member '${ref}' is named by two seats` };
      refs.add(ref);
    }
    const names = new Set(seat.tools ?? []);
    for (const name of names) {
      const why = name === LAUNCH_AGENCY_TOOL_NAME ? (canLaunch ? undefined : `launch_agency, which a seat at level ${level} cannot use (maxDepth ${limits.maxDepth})`) : refusedInSeat(name);
      if (why) return { code: 'tool_not_allowed', reason: `seat '${seat.role}': '${name}' is ${why}` };
      if (!parentNames.has(name)) return { code: 'unknown_tool', reason: `seat '${seat.role}': the launching agent has no tool '${name}'` };
      const outside = stepsOutside(tools.get(name), names, (step) => tools.get(step));
      if (outside.length > 0) {
        return { code: 'tool_not_allowed', reason: `seat '${seat.role}': '${name}' is a composed tool whose step '${outside[0]}' the seat's allowlist leaves out` };
      }
    }
    const dependsOn = seat.dependsOn ? { dependsOn: [...seat.dependsOn] } : {};
    resolved.push(
      ref === undefined
        ? { role: seat.role, form: 'temporary', instructions: fields.instructions ?? '', toolNames: names, ...dependsOn }
        : { role: seat.role, form: 'persistent', ref, ...(fields.brief ? { brief: fields.brief } : {}), toolNames: names, ...dependsOn },
    );
  }
  return resolved;
}

const frameFor = (entry: LaunchEntry, role: string): AgencyLaunchFrame => ({ launchId: entry.launchId, role, depth: entry.depth });

/** Closes seats, logging a close that rejects. */
async function closeAll(seats: SeatHandle[], host: LaunchHost): Promise<void> {
  await Promise.all(seats.map((seat) => seat.close().catch((error: unknown) => logSafely(host, error, 'launch_agency close'))));
}

/** Resolves when `signal` aborts. */
function whenAborted(signal: AbortSignal): Promise<{ kind: 'aborted' }> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve({ kind: 'aborted' });
    else signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
  });
}

/** `work`'s value, or `aborted` when `signal` aborts first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<{ kind: 'value'; value: T } | { kind: 'aborted' }> {
  return Promise.race([work.then((value) => ({ kind: 'value' as const, value })), whenAborted(signal)]);
}

/** Whether `work` settles within `ms` (with its value), or not; a rejection counts as settled. */
function within<T>(work: Promise<T>, ms: number): Promise<{ settled: true; value: T } | { settled: false }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ settled: false }), Math.max(0, ms));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ settled: true, value });
      },
      () => {
        clearTimeout(timer);
        resolve({ settled: true, value: undefined as T });
      },
    );
  });
}

function recordMeta(launch: AdmittedLaunch, status: LaunchRecordMetadata['status']): LaunchRecordMetadata {
  return {
    kind: 'launched',
    parentGmiId: launch.parent.gmiId,
    parentPersonaId: launch.parent.personaId,
    launchingSessionId: launch.parent.sessionId,
    depth: launch.entry.depth,
    strategy: launch.strategy,
    goalPreview: launch.args.goal.slice(0, 200),
    startedAt: launch.startedAt.toISOString(),
    status,
  };
}

/** Step 7's record: the full runtime's registry entry. A recorder that throws is logged and the launch goes on. */
function recordStart(launch: AdmittedLaunch, seats: SeatHandle[]): void {
  try {
    launch.host.recorder.start({ agencyId: launch.entry.launchId, conversationId: launch.parent.conversationId ?? launch.parent.sessionId, meta: recordMeta(launch, 'running'), seats });
  } catch (error) {
    logSafely(launch.host, error, 'launch_agency record');
  }
}

/** The child agency: the parent's route as its own, the seats as its roster, the root's hitl at the root only. */
async function childAgencyOptions(launch: AdmittedLaunch, seats: SeatHandle[]): Promise<AgencyOptions> {
  const route = await launch.host.agencyRoute(launch.parent);
  return {
    name: `launch:${launch.entry.launchId}`,
    strategy: launch.strategy,
    agents: Object.fromEntries(seats.map((seat, i) => [launch.seats[i].role, seat])),
    maxRounds: launch.args.maxRounds ?? 3,
    ...route,
    ...(launch.parent.depth === 0 && launch.parent.limits.hitl ? { hitl: launch.parent.limits.hitl } : {}),
    ...(launch.host.callbacks ? { on: launch.host.callbacks } : {}),
  };
}

/** Step 7's call: the goal once, under the launch's signal, the coordinator's budget, the ledger and the parent's gate. */
function runTeam(launch: AdmittedLaunch, team: Agent): Promise<RunOutcome> {
  const { host, parent } = launch;
  return team
    .generate(launch.args.goal, {
      abortSignal: launch.controller.signal,
      budget: launch.coordinator,
      ...(host.usageLedger ? { usageLedger: { ...host.usageLedger, source: 'launch_agency' } } : {}),
      ...(parent.approvalGate ? { __approvalGate: parent.approvalGate } : {}),
    })
    .then(
      (value): RunOutcome => ({ kind: 'resolved', text: String((value as { text?: unknown } | null)?.text ?? '') }),
      (error: unknown): RunOutcome => ({ kind: 'rejected', error }),
    );
}

function notRun(seat: ResolvedSeat): LaunchSeatRecord {
  return { role: seat.role, form: seat.form, ...(seat.form === 'persistent' ? { member: seat.ref } : {}), status: 'not_run', calls: 0, summary: '', usage: ZERO_USAGE() };
}

/** Step 8's status: the first that holds. */
function statusOf(state: LaunchState, outcome: RunOutcome): LaunchStatus {
  if (state.exhausted) return 'budget_exhausted';
  if (state.timedOut) return 'timed_out';
  if (state.cancelled) return 'cancelled';
  return outcome.kind === 'resolved' ? 'completed' : 'failed';
}

/**
 * The result's reason, for every status but 'completed': whose budget refused a call and why, the deadline, the
 * parent's stop, or what failed (the first failed seat by its error's name and code, else the team's error by its name
 * and code, else that the team did not settle or that no seat ran). Never an error's message.
 */
function reasonOf(status: LaunchStatus, launch: AdmittedLaunch, seats: LaunchSeatRecord[], outcome: RunOutcome, state: LaunchState): string | undefined {
  switch (status) {
    case 'completed':
      return undefined;
    case 'budget_exhausted': {
      const refusal = state.refusal;
      const used = launch.child.tokensUsed();
      // A budget the launch draws on (its parent's, its pool) or one a seat's call draws on (a persistent member's own)
      // names the cap that refused. The launch's own token cap reads from the launch's count once its calls have used it
      // up; a call whose estimate alone would pass what the cap has left is told in the refusal's own words, as every
      // other cap's refusal is.
      if (refusal && refusal.budgetId !== launch.child.id) return `a budget the team draws on refused a call: ${refusal.reason}`;
      if (refusal && (refusal.capType !== 'tokens' || used < launch.caps.maxTotalTokens)) return `the launch's budget refused a call: ${refusal.reason}`;
      return `the launch's budget is spent: ${used} of ${launch.caps.maxTotalTokens} tokens`;
    }
    case 'timed_out':
      return `the deadline of ${launch.deadlineMs} ms passed`;
    case 'cancelled':
      return 'the parent turn stopped';
    default: {
      const seat = seats.find((record) => record.status === 'failed' && record.error);
      if (seat?.error) return `seat '${seat.role}' failed: ${seat.error.name}${seat.error.code ? ` (${seat.error.code})` : ''}`;
      if (outcome.kind === 'rejected') {
        const error = outcome.error as { name?: unknown; code?: unknown } | null;
        const name = typeof error?.name === 'string' ? error.name : 'Error';
        return `the team failed: ${name}${typeof error?.code === 'string' ? ` (${error.code})` : ''}`;
      }
      return outcome.kind === 'unsettled' ? 'the team did not settle' : 'no seat ran';
    }
  }
}

/**
 * Step 10: the result, recorded, as the tool's output.
 *
 * @param state - The launch's state when the run settled (a stop that came during the close does not change it).
 */
function finish(launch: AdmittedLaunch, built: SeatHandle[], outcome: RunOutcome, state: LaunchState = launch.state): ToolExecutionResult<LaunchAgencyResult> {
  const seats = launch.seats.map((seat, i) => built[i]?.record() ?? notRun(seat));
  const usage = seats.reduce<LaunchUsage>((sum, record) => {
    sum.promptTokens += record.usage.promptTokens;
    sum.completionTokens += record.usage.completionTokens;
    sum.totalTokens += record.usage.totalTokens;
    if (record.usage.costUSD !== undefined) sum.costUSD = (sum.costUSD ?? 0) + record.usage.costUSD;
    return sum;
  }, ZERO_USAGE());
  const status = statusOf(state, outcome);
  const reason = reasonOf(status, launch, seats, outcome, state);
  const text = outcome.kind === 'resolved' ? outcome.text : '';
  const truncated = text.length > LAUNCH_TEXT_CHARS;
  const closedAt = new Date();
  const result: LaunchAgencyResult = {
    status,
    agencyId: launch.entry.launchId,
    text: truncated ? text.slice(0, LAUNCH_TEXT_CHARS) : text,
    truncated,
    seats,
    usage,
    coordinatorUsage: { totalTokens: launch.coordinator.tokensUsed(), costUSD: launch.coordinator.spentUSD() },
    durationMs: closedAt.getTime() - launch.startedAt.getTime(),
    ...(reason ? { reason } : {}),
    provenance: {
      agencyId: launch.entry.launchId,
      strategy: launch.strategy,
      depth: launch.entry.depth,
      parentGmiId: launch.parent.gmiId,
      parentSessionId: launch.parent.sessionId,
      startedAt: launch.startedAt.toISOString(),
      closedAt: closedAt.toISOString(),
      deadlineMs: launch.deadlineMs,
      budget: {
        ...(Number.isFinite(launch.caps.maxCostUSD) ? { maxCostUSD: launch.caps.maxCostUSD } : {}),
        maxTotalTokens: launch.caps.maxTotalTokens,
        spentUSD: launch.child.spentUSD(),
        tokensUsed: launch.child.tokensUsed(),
      },
    },
  };
  try {
    launch.host.recorder.close(result);
  } catch (error) {
    logSafely(launch.host, error, 'launch_agency record');
  }
  return { success: true, output: result };
}

/**
 * Steps 6 to 10. One real-time timer per launch (never the learning layer's clock): at the deadline, or when the
 * parent turn stops, the launch signal aborts, which every seat's turn and the coordinator's calls run under. The
 * parent's stop ends the timer, so a deadline that passes while the team settles leaves the launch cancelled. The
 * launch then waits one grace for the run to settle and the team to close, together, and returns; a run that resolved
 * before any abort gets the whole grace for its close. Once the run has settled the signal aborts in any case, before
 * the seats close, so no seat's call runs on past its launch. The launch's registry entry goes once every seat is
 * released and every launch its seats started is gone; until then it stays closing.
 */
async function runAdmitted(launch: AdmittedLaunch): Promise<ToolExecutionResult<LaunchAgencyResult>> {
  const { host, parent, entry, controller, state } = launch;
  const graceMs = host.settleGraceMs ?? LAUNCH_SETTLE_GRACE_MS;
  // Everything that still holds a seat: the run, the close, a seat build that settles late.
  const holding = new Set<Promise<void>>();
  const hold = (work: Promise<unknown>): Promise<void> => {
    const settled = work.then(() => undefined, () => undefined);
    holding.add(settled);
    return settled.then(() => {
      holding.delete(settled);
    });
  };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort(Object.assign(new Error(`the launch's deadline of ${launch.deadlineMs} ms passed`), { name: 'LaunchDeadlineError' }));
  }, launch.deadlineMs);
  const onParentStop = (): void => {
    state.cancelled = true;
    // The parent stopped first: the deadline no longer runs, however long the team takes to settle.
    clearTimeout(timer);
    controller.abort(parent.signal?.reason);
  };
  if (parent.signal?.aborted) onParentStop();
  else parent.signal?.addEventListener('abort', onParentStop, { once: true });

  const built: SeatHandle[] = [];
  let team: Agent | undefined;
  let outcome: RunOutcome = { kind: 'not_run' };
  let settled: LaunchState | undefined;
  try {
    // 6. Seats, each racing the launch's signal (a runtime seat's GMI can take long to start).
    for (const seat of launch.seats) entry.seatTools.set(seat.role, seat.toolNames);
    const cutWhen = (): boolean => state.exhausted || controller.signal.aborted;
    for (const seat of launch.seats) {
      if (controller.signal.aborted) break;
      const building = host.buildSeat(seat, entry, parent, frameFor(entry, seat.role), cutWhen);
      const raced = await untilAborted(building, controller.signal);
      if (raced.kind === 'aborted') {
        // A seat whose build settles after the abort is released at once, a close that rejects logged as every other
        // close's is; a build that rejects after the abort is logged too.
        void hold(
          building.then(
            (late) => (isRefusal(late) ? undefined : closeAll([late], host)),
            (error: unknown) => logSafely(host, error, 'launch_agency'),
          ),
        );
        break;
      }
      if (isRefusal(raced.value)) {
        void hold(closeAll(built, host));
        return refused(raced.value);
      }
      built.push(raced.value);
    }

    // The child's route races the launch's signal as the seat builds do.
    const options = controller.signal.aborted ? ({ kind: 'aborted' } as const) : await untilAborted(childAgencyOptions(launch, built), controller.signal);
    if (options.kind === 'aborted') {
      // The deadline or the parent's stop came while the team was built: nothing runs.
      settled = { ...state };
      await within(hold(closeAll(built, host)), graceMs);
    } else {
      // 7. Run.
      try {
        team = agency(options.value);
      } catch (error) {
        if (!(error instanceof AgencyConfigError)) throw error;
        void hold(closeAll(built, host));
        return refused({ code: 'invalid_arguments', reason: error.message });
      }
      // The record starts once the child is built, so a configuration agency() refuses leaves no record behind.
      recordStart(launch, built);
      const run = runTeam(launch, team);
      void hold(run);
      // 8. Settle: the run, or the abort and then one grace for the run and the close together.
      const first = await Promise.race([run, whenAborted(controller.signal)]);
      let graceEnds: number;
      if (first.kind === 'aborted') {
        graceEnds = Date.now() + graceMs;
        const late = await within(run, graceMs);
        outcome = late.settled ? late.value : { kind: 'unsettled' };
      } else {
        clearTimeout(timer);
        outcome = first;
        graceEnds = Date.now() + graceMs;
      }
      settled = { ...state };
      if (outcome.kind === 'rejected') logSafely(host, outcome.error, 'launch_agency run');
      // The launch stops waiting for its team here, and its timer and its parent's stop end with it, so its signal
      // aborts now: a run can reject while a seat still runs (a graph tier awaits its seats together and rejects at the
      // first that fails), and that seat stops instead of running on past its launch.
      if (!controller.signal.aborted) controller.abort(Object.assign(new Error('the launch has ended'), { name: 'LaunchEndedError' }));
      // 9. Close: every seat once, every close attempted. Not team.close(): agency().close() stops at the
      // first member that rejects, which would free the scope with later seats open.
      const closing = hold(closeAll(built, host));
      await within(closing, graceEnds - Date.now());
    }
  } catch (error) {
    logSafely(host, error, 'launch_agency');
    outcome = { kind: 'rejected', error };
    settled = { ...state };
    void hold(closeAll(built, host));
  } finally {
    clearTimeout(timer);
    parent.signal?.removeEventListener('abort', onParentStop);
    // A team one of the seats launched holds seats of this tree too: the entry waits for each such launch to go, so a
    // tool that hangs in a nested team holds this launch's scope as one in its own team does.
    for (const nested of launchRegistry.nestedUnder(entry.launchId)) void hold(launchRegistry.whenRemoved(nested.launchId));
    // The entry goes once every seat is released. Until then it stays, closing: it admits nothing under it and
    // counts toward its scope's maxConcurrent, so retries against a tool that hangs past the deadline are refused
    // instead of piling up seats.
    if (holding.size === 0) launchRegistry.remove(entry.launchId);
    else {
      launchRegistry.markClosing(entry.launchId);
      void Promise.all([...holding]).then(() => launchRegistry.remove(entry.launchId));
    }
  }
  return finish(launch, built, outcome, settled ?? { ...state });
}

/**
 * One run of `launch_agency`: validate, resolve the parent, check the bounds, size the budget, admit, then
 * build, run, settle, close and report. Never throws: a refusal is `{ success: false, error: '<code>: <reason>',
 * details }`, every launch that started is `{ success: true, output }` whatever its status, and an unexpected error
 * before admission is logged and reported as a `failed` launch.
 */
export async function runLaunch(host: LaunchHost, args: LaunchAgencyArgs, ctx: ToolExecutionContext): Promise<ToolExecutionResult<LaunchAgencyResult>> {
  const startedAt = new Date();
  const agencyId = `agency-${randomUUID()}`;
  let depth = 1;
  try {
    const invalid = validateLaunchArgs(args);
    if (invalid) return refused(invalid);
    const resolved = await resolveParent(host, ctx);
    if (isRefusal(resolved)) return refused(resolved);
    const { parent, toolNames, frame } = resolved;
    depth = parent.depth + 1;
    const seats = await checkBounds(host, ctx, args, parent, toolNames);
    if (isRefusal(seats)) return refused(seats);

    // 4. The budget: a root launch draws on its turn's pool; a nested one on its parent launch's budget, and on a
    // persistent member's own as well when the member launches it from its seat.
    // A root launch's scope is the launching session as its host names it, never the calling GMI.
    const scopeKey = frame ? frame.launchId : `${host.surface}:${parent.scopeId}`;
    const pool = frame ? undefined : launchRegistry.rootPool(scopeKey, parent.turnId, parent.limits, parent.budget, parent.poolOwner);
    const caps = childBudgetCaps(parent.budget, pool, parent.limits, args, await seatsOutputEstimate(host, parent, seats));
    if (isRefusal(caps)) return refused(caps);
    const state: LaunchState = { exhausted: false, timedOut: false, cancelled: false };
    const upstream = pool ?? parent.budget;
    const child = new SpendBudget({
      maxCostUSD: caps.maxCostUSD,
      maxTotalTokens: caps.maxTotalTokens,
      unpriced: 'allow',
      ...(upstream ? { parent: upstream } : {}),
      // Runs before every refusal, this budget's own, an ancestor's, or that of a persistent member's own budget held
      // beside it on a seat's call: the launch reads exhaustion, and the first refusal, from here.
      onLimitReached: (info) => {
        state.refusal ??= info;
        state.exhausted = true;
      },
    });
    const coordinator = new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, unpriced: 'allow', parent: child });

    // 5. Admit.
    const controller = new AbortController();
    const entry: LaunchEntry = {
      launchId: agencyId,
      depth,
      limits: parent.limits,
      scopeKey,
      budget: child,
      ...(parent.approvalGate ? { approvalGate: parent.approvalGate } : {}),
      signal: controller.signal,
      ...(parent.providerUserId !== undefined ? { providerUserId: parent.providerUserId } : {}),
      namespace: parent.namespace,
      toolHooks: parent.toolHooks,
      seatTools: new Map(),
      outputEstimateTokens: parent.outputEstimateTokens,
      state: 'running',
    };
    const admitted = launchRegistry.admit(entry);
    if (!admitted.ok) {
      return refused({ code: 'concurrency_exceeded', reason: `${admitted.inFlight} launch(es) of this scope in flight; at most ${parent.limits.maxConcurrent}` });
    }
    const deadlineMs = Math.min(args.deadlineMs ?? parent.limits.defaultDeadlineMs, parent.limits.maxDeadlineMs);
    return await runAdmitted({ host, args, parent, entry, seats, strategy: args.strategy ?? 'sequential', child, coordinator, caps, state, controller, deadlineMs, startedAt });
  } catch (error) {
    logSafely(host, error, 'launch_agency');
    const name = error instanceof Error ? error.name : 'Error';
    const closedAt = new Date().toISOString();
    return {
      success: true,
      output: {
        status: 'failed',
        agencyId,
        text: '',
        truncated: false,
        seats: [],
        usage: ZERO_USAGE(),
        coordinatorUsage: { totalTokens: 0, costUSD: 0 },
        durationMs: Date.now() - startedAt.getTime(),
        reason: `the launch failed before it ran: ${name}`,
        provenance: {
          agencyId,
          strategy: args?.strategy ?? 'sequential',
          depth,
          parentGmiId: ctx.gmiId,
          parentSessionId: String(ctx.sessionData?.sessionId ?? ctx.gmiId),
          startedAt: startedAt.toISOString(),
          closedAt,
          deadlineMs: 0,
          budget: { maxTotalTokens: 0, spentUSD: 0, tokensUsed: 0 },
        },
      },
    };
  }
}

/**
 * Step 1: the arguments' own rules (types, required fields and the strategy's names are the input schema's too, so a
 * call the schema refuses never reaches here). Counts against a host's bounds are step 3's. A `dependsOn` cycle is
 * refused naming a seat on it, and a chain of any length is checked without recursion.
 *
 * @returns `invalid_arguments` naming the first problem, or undefined.
 */
export function validateLaunchArgs(args: LaunchAgencyArgs): LaunchRefusal | undefined {
  const invalid = (reason: string): LaunchRefusal => ({ code: 'invalid_arguments', reason });
  if (typeof args !== 'object' || args === null) return invalid('the arguments must be an object');
  for (const key of Object.keys(args)) if (!ARG_KEYS.has(key)) return invalid(`unknown argument '${key}'`);
  if (typeof args.goal !== 'string' || args.goal.trim().length === 0 || args.goal.length > MAX_GOAL_CHARS) {
    return invalid(`goal must be 1 to ${MAX_GOAL_CHARS.toLocaleString('en-US')} characters`);
  }
  const strategy = args.strategy ?? 'sequential';
  if (!STRATEGIES.includes(strategy)) return invalid(`unknown strategy '${String(strategy)}'; one of ${STRATEGIES.join(', ')}`);
  if (!Array.isArray(args.seats) || args.seats.length === 0) return invalid('seats must name at least one seat');

  const roles = new Set<string>();
  for (let i = 0; i < args.seats.length; i++) {
    const seat = args.seats[i] as unknown as Record<string, unknown>;
    if (typeof seat !== 'object' || seat === null) return invalid(`seat ${i + 1} must be an object`);
    for (const key of Object.keys(seat)) if (!SEAT_KEYS.has(key)) return invalid(`seat ${i + 1}: unknown key '${key}'`);
    const role = seat.role;
    if (typeof role !== 'string' || !IDENTIFIER_PATTERN.test(role)) {
      return invalid(`seat ${i + 1}: a role starts with a letter and holds only letters, digits, '_' and '-'`);
    }
    if (role.length > MAX_ROLE_CHARS) return invalid(`seat '${role.slice(0, 20)}...': a role is at most ${MAX_ROLE_CHARS} characters`);
    if (RESERVED_ROLES.has(role) || role.startsWith('delegate_to_')) return invalid(`seat '${role}': the role is a name the hierarchical strategy uses`);
    if (roles.has(role)) return invalid(`seat '${role}': roles must be unique`);
    roles.add(role);
    const forms = ['instructions', 'agentKey', 'personaId'].filter((form) => seat[form] !== undefined);
    if (forms.length !== 1) return invalid(`seat '${role}': name exactly one of instructions, agentKey and personaId`);
    const form = forms[0];
    const value = seat[form];
    if (typeof value !== 'string' || value.trim().length === 0) return invalid(`seat '${role}': ${form} must be a non-blank string`);
    if (form === 'instructions') {
      if (value.length > MAX_INSTRUCTIONS_CHARS) return invalid(`seat '${role}': instructions are at most ${MAX_INSTRUCTIONS_CHARS.toLocaleString('en-US')} characters`);
      if (seat.brief !== undefined) return invalid(`seat '${role}': a brief is for a persistent member; put it in the instructions`);
    }
    if (seat.brief !== undefined && (typeof seat.brief !== 'string' || seat.brief.length > MAX_BRIEF_CHARS)) {
      return invalid(`seat '${role}': a brief is a string of at most ${MAX_BRIEF_CHARS.toLocaleString('en-US')} characters`);
    }
    if (seat.tools !== undefined && !isStringArray(seat.tools)) return invalid(`seat '${role}': tools must be a list of tool names`);
    if (seat.dependsOn !== undefined && !isStringArray(seat.dependsOn)) return invalid(`seat '${role}': dependsOn must be a list of roles`);
  }

  const dependsOn = new Map<string, string[]>();
  for (const seat of args.seats) {
    const deps = seat.dependsOn ?? [];
    for (const dep of deps) {
      if (dep === seat.role || !roles.has(dep)) return invalid(`seat '${seat.role}': dependsOn names '${dep}', which is not another seat`);
    }
    dependsOn.set(seat.role, deps);
  }
  // A cycle: a seat that, through dependsOn, waits for itself. The refusal names the seat at which the walk meets one
  // it is still visiting, which is on the cycle. The walk keeps its own stack: the seat count is bounded after this
  // step (maxSeats), so a chain of any length must be walked without exhausting the call stack.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cycleAt = (start: string): string | undefined => {
    if (done.has(start)) return undefined;
    const path: Array<{ role: string; next: number }> = [{ role: start, next: 0 }];
    visiting.add(start);
    while (path.length > 0) {
      const top = path[path.length - 1];
      const deps = dependsOn.get(top.role) ?? [];
      if (top.next < deps.length) {
        const dep = deps[top.next];
        top.next += 1;
        if (visiting.has(dep)) return dep;
        if (!done.has(dep)) {
          visiting.add(dep);
          path.push({ role: dep, next: 0 });
        }
      } else {
        path.pop();
        visiting.delete(top.role);
        done.add(top.role);
      }
    }
    return undefined;
  };
  for (const role of roles) {
    const at = cycleAt(role);
    if (at !== undefined) return invalid(`dependsOn makes a cycle through '${at}'`);
  }

  if (strategy === 'review-loop' && args.seats.length !== 2) return invalid('review-loop takes exactly 2 seats');
  if ((strategy === 'parallel' || strategy === 'debate') && args.seats.length < 2) return invalid(`${strategy} takes at least 2 seats`);
  if (args.deadlineMs !== undefined && !(Number.isFinite(args.deadlineMs) && args.deadlineMs >= 1_000)) return invalid('deadlineMs must be at least 1,000');
  if (args.maxRounds !== undefined && !(Number.isInteger(args.maxRounds) && args.maxRounds >= 1 && args.maxRounds <= 3)) return invalid('maxRounds must be 1, 2 or 3');
  if (args.budgetUsd !== undefined && !(Number.isFinite(args.budgetUsd) && args.budgetUsd > 0)) return invalid('budgetUsd must be above 0');
  if (args.maxTokens !== undefined && !(Number.isFinite(args.maxTokens) && args.maxTokens > 0)) return invalid('maxTokens must be above 0');
  return undefined;
}

/**
 * Step 4: the child budget's caps. Dollars: the least of `budgetUsd`, the parent's remaining dollars times
 * `budgetShare` and, at a root launch, what the turn's launch pool has left (Infinity when none of them caps). Tokens:
 * the least of `maxTokens`, the parent's remaining tokens times `budgetShare` (when it has a token cap), the pool's
 * remaining tokens and `limits.maxLaunchTokens`.
 *
 * @param outputEstimateTokens - The output tokens the floor counts one call with: the largest a seat's call is counted
 *   with.
 * @returns The caps, or `budget_unavailable` when the token cap cannot cover one call (`MIN_LAUNCH_TOKENS` plus the
 *   output estimate) or no dollars are left.
 */
export function childBudgetCaps(
  parent: SpendBudget | undefined,
  pool: SpendBudget | undefined,
  limits: LaunchLimits,
  args: Pick<LaunchAgencyArgs, 'budgetUsd' | 'maxTokens'>,
  outputEstimateTokens: number,
): { maxCostUSD: number; maxTotalTokens: number } | LaunchRefusal {
  const parentLeft = parent?.remaining();
  const poolLeft = pool?.remaining();
  let usd = Number.POSITIVE_INFINITY;
  if (args.budgetUsd !== undefined) usd = Math.min(usd, args.budgetUsd);
  if (parentLeft) usd = Math.min(usd, parentLeft.usd * limits.budgetShare);
  if (poolLeft) usd = Math.min(usd, poolLeft.usd);
  let tokens = Number.POSITIVE_INFINITY;
  if (args.maxTokens !== undefined) tokens = Math.min(tokens, args.maxTokens);
  if (parentLeft?.tokens !== undefined) tokens = Math.min(tokens, Math.floor(parentLeft.tokens * limits.budgetShare));
  if (poolLeft?.tokens !== undefined) tokens = Math.min(tokens, poolLeft.tokens);
  // Never past the tree's own bound, whatever the arguments ask, and that bound when nothing else caps the tokens.
  tokens = Math.min(tokens, limits.maxLaunchTokens);
  const floor = MIN_LAUNCH_TOKENS + outputEstimateTokens;
  if (tokens < floor) {
    return { code: 'budget_unavailable', reason: `the launch's token cap, ${tokens}, cannot cover one call (${floor}: ${MIN_LAUNCH_TOKENS} for the prompt and ${outputEstimateTokens} for the output)` };
  }
  if (!(usd > 0)) return { code: 'budget_unavailable', reason: 'the launch has no dollars left to spend' };
  return { maxCostUSD: usd, maxTotalTokens: tokens };
}
