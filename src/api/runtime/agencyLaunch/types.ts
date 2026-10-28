/**
 * @file types.ts
 * The types and bounds of teams a GMI launches from a turn (`launch_agency`), and of the seats such a team and
 * `sessionSeat()` build. The package root and `src/api` export {@link LAUNCH_AGENCY_TOOL_NAME}, `sessionSeat()` and
 * the types of the `agencies` option, the tool's arguments and result and a seat; the launch registry, the engine
 * (`runLaunch`) and the tool factory (`createGmiLaunchTool`) stay internal.
 */
import type { AgentOptions } from '../../agent.js';
import type { Agent, AgencyStrategy, HitlConfig } from '../../types.js';
import { AgencyConfigError } from '../../types.js';
import type { ApprovalGateFn } from '../approval-gate.js';
import type { SpendBudget } from '../spendBudget.js';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator.js';

export type { SeatMetadata } from '../../types.js';

/** The tool's name on every surface. */
export const LAUNCH_AGENCY_TOOL_NAME = 'launch_agency';
/** The capability a full-runtime persona's grant would name for the tool. No code reads it: gmi() is the one surface that registers `launch_agency`. */
export const LAUNCH_CAPABILITY = 'agency:launch';
/** The five self-modification tools, which a seat never gets. */
export const SELF_MODIFICATION_TOOLS = ['forge_tool', 'create_workflow', 'manage_skills', 'self_evaluate', 'adapt_personality'] as const;
/**
 * The memory tools: never in a seat's names (spec D5). The eight of src/cognition/memory/io/tools/, and the two
 * working-memory tools, which read and replace the agent's persistent markdown working memory (its profile of its
 * users and its notes across conversations).
 */
export const MEMORY_TOOLS = [
  'memory_add',
  'memory_update',
  'memory_delete',
  'memory_merge',
  'memory_search',
  'memory_reflect',
  'read_memory_page',
  'rehydrate_memory',
  'read_working_memory',
  'update_working_memory',
] as const;
/** How long a launch waits, once its signal aborted or its run resolved, for the run to settle and the team to close. */
export const LAUNCH_SETTLE_GRACE_MS = 5_000;
/** The longest `text` a launch returns. */
export const LAUNCH_TEXT_CHARS = 16_000;
/** The longest seat summary a launch returns. */
export const SEAT_SUMMARY_CHARS = 1_000;
/** The prompt's allowance in the smallest launch: a child's token cap must cover it plus one call's output estimate. */
export const MIN_LAUNCH_TOKENS = 2_000;
/** The longest role: `delegate_to_<role>` stays within the 64 characters OpenAI allows a function name. */
export const MAX_ROLE_CHARS = 52;

/** An onBeforeToolExecution hook, as an agent takes one. */
export type ToolCallHook = NonNullable<AgentOptions['onBeforeToolExecution']>;

/** `agencies` on an agent: whether it may launch temporary teams, and every launch's bounds. */
export interface AgencyLaunchOptions {
  /**
   * Registers `launch_agency` on the agent's tool table. Default false. On gmi(), a launched team's manager, synthesizers
   * and temporary seats run on the provider and model the agent's first call resolved: those its options name, else the
   * environment's pair at that call, whatever the environment names later. A call that names its own provider or model
   * runs on that pair alone; a team it launches runs on the agent's.
   */
  launch?: boolean;
  /** The deepest team level a launch tree reaches: an integer from 1 to 4, default 2. */
  maxDepth?: number;
  /** The most seats one launch names: an integer from 1 to 12, default 5. */
  maxSeats?: number;
  /** Launches in flight at once per scope (a session at the root, a team below it): an integer from 1 to 4, default 1. */
  maxConcurrent?: number;
  /** The share of what the launching turn's budget has left that one launch may spend: above 0, at most 1, default 0.5. */
  budgetShare?: number;
  /** The token ceiling of all the root launches of one parent turn, their nested launches included: at least 2,000, default 200,000. */
  maxLaunchTokens?: number;
  /** Their dollar ceiling, counted where a price row or a provider-reported cost exists; a number above 0. Default: none. */
  maxLaunchCostUSD?: number;
  /** The deadline of a launch that names none, in ms: default 120,000 (at most `maxDeadlineMs`). */
  defaultDeadlineMs?: number;
  /** The longest deadline a launch may name, in ms: from 1,000 to 3,600,000, default 600,000. */
  maxDeadlineMs?: number;
  /** gmi() only: the persistent members a launch may seat by agentKey, each a gmi() handle. */
  members?: Record<string, Agent>;
  /** The approval policy every launched team runs under after the gate the launching turn carries; applied at a root launch and inherited below it. */
  hitl?: HitlConfig;
}

/** The bounds of a launch on the full runtime, with the route of its coordinator. AgentOSConfig takes no `agencies` option: gmi() is the one surface that registers `launch_agency`. */
export interface RuntimeAgencyLaunchOptions extends Omit<AgencyLaunchOptions, 'members'> {
  /** The route of a launched team's manager and synthesizers (they call generateText). Default: the parent persona's provider and model, with the key and base URL of the runtime's entry for that provider. */
  coordinator?: { provider: string; model: string; apiKey?: string; baseUrl?: string };
}

/** The limits of a launch tree: the root launch's, resolved once, inherited by every nested launch. */
export interface LaunchLimits {
  maxDepth: number;
  maxSeats: number;
  maxConcurrent: number;
  budgetShare: number;
  maxLaunchTokens: number;
  maxLaunchCostUSD?: number;
  defaultDeadlineMs: number;
  maxDeadlineMs: number;
  hitl?: HitlConfig;
}

/** What a seat's turns carry in `metadata.agencyLaunch`, and its tool calls in `sessionData.agencyLaunch`. */
export interface AgencyLaunchFrame {
  /** The launch whose team this turn's GMI sits in. */
  launchId: string;
  /** The seat's role in that team. */
  role: string;
  /** The team's level: 1 for a team a depth-0 turn launched. */
  depth: number;
}

/** Live objects of the turn that made a tool call; set by gmi()'s tool hook and by a runtime seat's view. */
export interface CallerTurnContext {
  /** The approval gate the turn's tool calls are asked. */
  approvalGate?: ApprovalGateFn;
  /** The turn's spend budget. */
  budget?: SpendBudget;
  /** The explicit user id the turn's session named; undefined when it named none. */
  providerUserId?: string;
  /** A seat's tool names: the only tools its turn lists and runs, a composed tool's steps included. */
  toolNames?: ReadonlySet<string>;
  /** gmi(): the onBeforeToolExecution hooks the turn's calls run under, outermost first. */
  toolHooks?: readonly ToolCallHook[];
  /** The processToolCall of the view that made the call; the step gate runs each step of a composed tool through it. */
  dispatch?: IToolOrchestrator['processToolCall'];
}

/** One seat a launch names: exactly one of `instructions`, `agentKey` (gmi()) or `personaId` (the full runtime). */
export type LaunchSeatSpec =
  | { role: string; instructions: string; tools?: string[]; dependsOn?: string[] }
  | { role: string; agentKey: string; brief?: string; tools?: string[]; dependsOn?: string[] }
  | { role: string; personaId: string; brief?: string; tools?: string[]; dependsOn?: string[] };

/** The arguments of `launch_agency`. */
export interface LaunchAgencyArgs {
  /** What the team must produce, in full (members see nothing of the parent's history): 1 to 8,000 characters. */
  goal: string;
  /** Default 'sequential'. */
  strategy?: AgencyStrategy;
  seats: LaunchSeatSpec[];
  /** The dollar cap the parent asks for; the launch takes the least of it and its bounds. */
  budgetUsd?: number;
  /** The token cap the parent asks for; the launch takes the least of it and its bounds. */
  maxTokens?: number;
  /** The wall deadline the parent asks for, in ms (at least 1,000); clamped to `maxDeadlineMs`. */
  deadlineMs?: number;
  /** Rounds of `debate` and `review-loop`: 1 to 3, default 3. */
  maxRounds?: number;
}

/**
 * How a launch that started ended, the first that holds: `budget_exhausted` (the launch's budget, a budget it draws on,
 * or a persistent member's own budget on its seat's call, refused a call), `timed_out` (its deadline passed),
 * `cancelled` (the launching turn stopped), `completed` (the team answered) or `failed` (the team or a seat failed, no
 * seat ran, or the launch failed before its team ran).
 */
export type LaunchStatus = 'completed' | 'timed_out' | 'budget_exhausted' | 'cancelled' | 'failed';

/**
 * Why a launch was refused before it started. A refusal is the tool call's error, `<code>: <reason>`.
 *
 * - `invalid_arguments`: the arguments break their own rules, or `agency()` refuses the team they describe.
 * - `depth_exceeded`: the team would sit deeper than `maxDepth`.
 * - `too_many_seats`: more seats than `maxSeats`.
 * - `concurrency_exceeded`: `maxConcurrent` launches of the scope are in flight.
 * - `unknown_tool`: a seat names a tool the launching agent, or the member it seats, does not have.
 * - `tool_not_allowed`: a seat names a self-modification or memory tool, `launch_agency` at a level that cannot launch,
 *   or a composed tool one of whose steps its allowlist leaves out.
 * - `seat_form_unsupported`: a seat form the surface does not run (`personaId` on gmi(), `agentKey` on the full runtime).
 * - `unknown_member`: a seat names a member the surface does not have.
 * - `member_unavailable`: a member could not be seated.
 * - `duplicate_member`: two seats name one member.
 * - `budget_unavailable`: the launch's token cap cannot cover one call, or it has no dollars left.
 * - `parent_launch_closed`: the team the calling seat sits in is closing or gone.
 */
export type LaunchRefusalCode =
  | 'invalid_arguments'
  | 'depth_exceeded'
  | 'too_many_seats'
  | 'concurrency_exceeded'
  | 'unknown_tool'
  | 'tool_not_allowed'
  | 'seat_form_unsupported'
  | 'unknown_member'
  | 'member_unavailable'
  | 'duplicate_member'
  | 'budget_unavailable'
  | 'parent_launch_closed';

/** A launch refused before it started. */
export interface LaunchRefusal {
  /** The rule that refused it. */
  code: LaunchRefusalCode;
  /** What was refused, in one sentence: the seat, the tool, the member or the bound. */
  reason: string;
}

/** The tokens a seat's calls, or all of a launch's seats' calls, used, as their results reported them. */
export interface LaunchUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** The cost the results reported, in US dollars; unset when none reported one. */
  costUSD?: number;
}

/** One seat of a launched team, as the launch's result reports it. */
export interface LaunchSeatRecord {
  role: string;
  form: 'temporary' | 'persistent';
  /** The agentKey or personaId of a persistent member. */
  member?: string;
  /**
   * 'cut': the deadline, a budget the call drew on (the launch's, or a persistent member's own) or the parent's stop
   * ended the seat's last call.
   */
  status: 'completed' | 'cut' | 'failed' | 'not_run';
  calls: number;
  /** The seat's last output, at most SEAT_SUMMARY_CHARS characters. */
  summary: string;
  usage: LaunchUsage;
  /** Whether the seat's turns had a learner; unset when the launch does not report it. */
  learner?: 'bound' | 'none' | 'unavailable';
  /** A failed seat's error, by name and code; never its message. */
  error?: { name: string; code?: string };
}

/** The tool's output for every launch that started; a refusal is a tool error instead. */
export interface LaunchAgencyResult {
  status: LaunchStatus;
  agencyId: string;
  /** The team's answer, at most LAUNCH_TEXT_CHARS characters; '' when the team produced none. */
  text: string;
  truncated: boolean;
  seats: LaunchSeatRecord[];
  /** The seats' own calls, summed from their records. */
  usage: LaunchUsage;
  /** The coordinator's calls (the manager's and the synthesizers'), from its sub-budget. */
  coordinatorUsage: { totalTokens: number; costUSD: number };
  durationMs: number;
  /**
   * For every status but 'completed'. For 'budget_exhausted' it says whose budget refused (the launch's, or one the team
   * draws on) and why: the launch's own token cap as its count of the cap, any other cap in its own words.
   */
  reason?: string;
  provenance: {
    agencyId: string;
    strategy: AgencyStrategy;
    depth: number;
    parentGmiId: string;
    parentSessionId: string;
    startedAt: string;
    closedAt: string;
    deadlineMs: number;
    /** Everything the launch's budget counted: the seats', the coordinator's and every nested launch's calls; maxCostUSD omitted when no dollar cap applied. */
    budget: { maxCostUSD?: number; maxTotalTokens: number; spentUSD: number; tokensUsed: number };
  };
}

/** Metadata of a launched team's AgencyRegistry entry (the full runtime). */
export interface LaunchRecordMetadata {
  kind: 'launched';
  parentGmiId: string;
  parentPersonaId: string;
  launchingSessionId: string;
  depth: number;
  strategy: AgencyStrategy;
  /** The goal's first 200 characters. */
  goalPreview: string;
  startedAt: string;
  status: 'running' | 'closing' | LaunchStatus;
  closedAt?: string;
  usage?: LaunchUsage;
}

/** Whether `value` is a handle gmi() built (the non-enumerable mark gmi() sets). */
export function isGmiHandle(value: unknown): value is Agent {
  return typeof value === 'object' && value !== null && (value as { __gmiHandle?: unknown }).__gmiHandle === true;
}

/** The options a gmi() handle was built with, or undefined for any other value. */
export function gmiOptionsOf(value: unknown): AgentOptions | undefined {
  return isGmiHandle(value) ? (value as { __config?: AgentOptions }).__config : undefined;
}

/**
 * Applies the defaults of `agencies` and checks every bound, at construction (`gmi()`, `AgentOS.initialize`).
 *
 * @param options - The `agencies` option, `launch` on or off.
 * @returns The limits of every launch tree rooted at this agent or runtime.
 * @throws {RangeError} Naming the field, for a value outside its range or a `members` value that is not a gmi()
 *   handle (or one whose `learning.agentKey` names another key).
 * @throws {AgencyConfigError} For `hitl` approvals with no handler, the rule `agency()` applies.
 */
export function resolveLaunchLimits(options: AgencyLaunchOptions | RuntimeAgencyLaunchOptions): LaunchLimits {
  const integer = (field: string, value: number | undefined, fallback: number, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`agencies.${field} must be an integer from ${min} to ${max}, not ${String(value)}`);
    }
    return value;
  };
  const number = (field: string, value: number, ok: boolean, rule: string): number => {
    if (!Number.isFinite(value) || !ok) throw new RangeError(`agencies.${field} must be ${rule}, not ${String(value)}`);
    return value;
  };
  const maxDepth = integer('maxDepth', options.maxDepth, 2, 1, 4);
  const maxSeats = integer('maxSeats', options.maxSeats, 5, 1, 12);
  const maxConcurrent = integer('maxConcurrent', options.maxConcurrent, 1, 1, 4);
  const share = options.budgetShare ?? 0.5;
  const budgetShare = number('budgetShare', share, share > 0 && share <= 1, 'above 0 and at most 1');
  const tokens = options.maxLaunchTokens ?? 200_000;
  const maxLaunchTokens = number('maxLaunchTokens', tokens, tokens >= MIN_LAUNCH_TOKENS, `at least ${MIN_LAUNCH_TOKENS}`);
  const dollars = options.maxLaunchCostUSD;
  if (dollars !== undefined) number('maxLaunchCostUSD', dollars, dollars > 0, 'a number above 0');
  const ceiling = options.maxDeadlineMs ?? 600_000;
  const maxDeadlineMs = number('maxDeadlineMs', ceiling, ceiling >= 1_000 && ceiling <= 3_600_000, 'from 1,000 to 3,600,000 ms');
  const deadline = options.defaultDeadlineMs ?? Math.min(120_000, maxDeadlineMs);
  const defaultDeadlineMs = number('defaultDeadlineMs', deadline, deadline >= 1_000 && deadline <= maxDeadlineMs, `from 1,000 ms to maxDeadlineMs (${maxDeadlineMs})`);

  // agency()'s own rule, restated: any approval trigger needs a handler.
  const approvals = options.hitl?.approvals;
  const asks =
    !!approvals &&
    ((Array.isArray(approvals.beforeTool) && approvals.beforeTool.length > 0) ||
      (Array.isArray(approvals.beforeAgent) && approvals.beforeAgent.length > 0) ||
      approvals.beforeEmergent === true ||
      approvals.beforeReturn === true ||
      approvals.beforeStrategyOverride === true);
  if (asks && !options.hitl?.handler) {
    throw new AgencyConfigError('agencies.hitl: HITL approvals configured but no handler provided');
  }

  const members = (options as AgencyLaunchOptions).members;
  if (members !== undefined) {
    if (typeof members !== 'object' || members === null) throw new RangeError('agencies.members must be a record of gmi() handles');
    for (const [key, member] of Object.entries(members)) {
      if (!isGmiHandle(member)) {
        throw new RangeError(`agencies.members.${key} is not a gmi() handle (an agent built by gmi() or agent({ runtime: 'gmi' }))`);
      }
      const learning = gmiOptionsOf(member)?.learning;
      const agentKey = typeof learning === 'object' && learning !== null ? learning.agentKey : undefined;
      if (agentKey !== undefined && agentKey !== key) {
        throw new RangeError(`agencies.members.${key} is the agent '${agentKey}' (its learning.agentKey); list it under that key`);
      }
    }
  }

  return {
    maxDepth,
    maxSeats,
    maxConcurrent,
    budgetShare,
    maxLaunchTokens,
    ...(dollars !== undefined ? { maxLaunchCostUSD: dollars } : {}),
    defaultDeadlineMs,
    maxDeadlineMs,
    ...(options.hitl ? { hitl: options.hitl } : {}),
  };
}

/** A tool as the seat rules read it: its name and, for a composed tool, the tools its steps call. */
export interface SeatToolLike {
  readonly name: string;
  readonly stepTools?: readonly string[];
}

/**
 * The step tools of a composed tool that `allowed` leaves out, nested compositions' steps included, first found first;
 * `[]` for a tool whose steps are all allowed, or that is no composition (spec D11: a composed tool is admitted only
 * when every tool its steps call, and their steps' in turn, is in the same allowlist).
 *
 * @param tool - The tool, or undefined.
 * @param allowed - The seat's names.
 * @param toolOf - The tool of a name, for a step that is itself a composition.
 * @param seen - The steps already walked, so a composition that calls itself ends.
 */
export function stepsOutside(tool: SeatToolLike | undefined, allowed: ReadonlySet<string>, toolOf: (name: string) => SeatToolLike | undefined, seen: Set<string> = new Set()): string[] {
  const outside: string[] = [];
  for (const step of tool?.stepTools ?? []) {
    if (!allowed.has(step)) {
      outside.push(step);
      continue;
    }
    if (seen.has(step)) continue;
    seen.add(step);
    outside.push(...stepsOutside(toolOf(step), allowed, toolOf, seen));
  }
  return outside;
}

/** Why `name` never runs in a seat, or undefined: the five self-modification tools and the memory tools. */
export function refusedInSeat(name: string): string | undefined {
  if ((SELF_MODIFICATION_TOOLS as readonly string[]).includes(name)) return 'a self-modification tool';
  if ((MEMORY_TOOLS as readonly string[]).includes(name)) return 'a memory tool';
  return undefined;
}
