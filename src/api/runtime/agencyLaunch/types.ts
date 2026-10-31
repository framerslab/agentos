/**
 * @file types.ts
 * The types and bounds of teams a GMI launches from a turn (`launch_agency`), and of the seats such a team and
 * `sessionSeat()` build, with the tool's schema and description, which both surfaces offer. The package root and
 * `src/api` export {@link LAUNCH_AGENCY_TOOL_NAME}, `sessionSeat()` and the types of the `agencies` option, the tool's
 * arguments and result and a seat; the launch registry, the engine (`runLaunch`) and the tool factories
 * (`createGmiLaunchTool`, `createRuntimeLaunchTool`) stay internal.
 */
import type { AgentOptions } from '../../agent.js';
import type { Agent, AgencyStrategy, HitlConfig } from '../../types.js';
import { AgencyConfigError } from '../../types.js';
import type { ApprovalGateFn } from '../approval-gate.js';
import type { SpendBudget } from '../spendBudget.js';
import type { GMIToolCallGate } from '../../../cognition/substrate/IGMI.js';
import type { JSONSchemaObject } from '../../../core/tools/ITool.js';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator.js';

export type { SeatMetadata } from '../../types.js';

/** The tool's name on every surface. */
export const LAUNCH_AGENCY_TOOL_NAME = 'launch_agency';
/** The six strategies a launch offers: the tool's input schema lists them and the engine accepts them. */
export const LAUNCH_STRATEGIES = ['sequential', 'parallel', 'debate', 'review-loop', 'hierarchical', 'graph'] as const satisfies readonly AgencyStrategy[];
/**
 * The capability the full runtime's `launch_agency` requires (`requiredCapabilities`): only a persona whose
 * `allowedCapabilities` names it lists and calls the tool, while the runtime checks capabilities strictly (its
 * `toolPermissionManagerConfig.strictCapabilityChecking`, on by default). gmi() registers the tool for its agent alone
 * and checks no capability.
 */
export const LAUNCH_CAPABILITY = 'agency:launch';
/** The five self-modification tools, which a seat never gets. */
export const SELF_MODIFICATION_TOOLS = ['forge_tool', 'create_workflow', 'manage_skills', 'self_evaluate', 'adapt_personality'] as const;
/**
 * The memory tools: never in a seat's names. The eight of src/cognition/memory/io/tools/, and the two
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
/**
 * The prompt's allowance in the smallest launch: a child's token cap must cover it plus the output estimate of one call,
 * the largest a seat of the team makes.
 */
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
   * runs on that pair alone; a team it launches runs on the agent's. A temporary seat also takes the agent's other route
   * and completion settings, its `onBeforeGeneration` and `onAfterGeneration` hooks and, of its controls,
   * `controls.maxDurationMs` alone: a cap the agent's calls take from `controls.maxTotalTokens` does not reach a seat's
   * calls, which the launch's budget bounds. Every seat's tool calls run the `onBeforeToolExecution` hooks of the turn
   * that launched the team, a member's before its own. The manager and synthesizers, which agency() builds on agent(),
   * take that pair with the agent's key and base URL alone: none of its hooks and no request timeout reach their calls,
   * which the launch's deadline and budget bound. A seat whose call fails rejects with its error's name and code alone,
   * so a provider's or a handler's message reaches no model of the team and not the result; the error itself goes to
   * the agent's `on.error`, under `launch_agency seat <role>` (the console without one), as do the launch's other
   * failures, a failed run apart: the team reports its run once, under `launch:<agencyId>`, with the error it rejected
   * with. A seat's name holds its role and not its team, so two teams' seats of one role report under one name. A
   * callback that throws or rejects fails no launch.
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
  /**
   * The token ceiling of all the root launches of one parent turn, their nested launches included: at least 2,000,
   * default 200,000. gmi() warns at construction when it cannot cover one call of the agent's route (2,000 for the
   * prompt and the call's output estimate), since every launch is then refused `budget_unavailable`.
   */
  maxLaunchTokens?: number;
  /** Their dollar ceiling, counted where a price row or a provider-reported cost exists; a number above 0. Default: none. */
  maxLaunchCostUSD?: number;
  /** The deadline of a launch that names none, in ms: default 120,000 (at most `maxDeadlineMs`). */
  defaultDeadlineMs?: number;
  /** The longest deadline a launch may name, in ms: from 1,000 to 3,600,000, default 600,000. */
  maxDeadlineMs?: number;
  /**
   * gmi() only: the persistent members a launch may seat by agentKey, each a gmi() handle. The record is read once,
   * when the agent is built: a member put in it afterwards, under a new key or an old one, is never seated.
   */
  members?: Record<string, Agent>;
  /**
   * The approval policy of the team a root launch builds, asked after the gate the launching turn carries. A nested
   * launch passes that team's gate on, so `beforeTool` covers the seats of every team below it, each tool call asked
   * once. `beforeAgent` and `beforeReturn` are asked in the root team alone: no nested team's seat or answer waits
   * for them.
   */
  hitl?: HitlConfig;
}

/**
 * `AgentOSConfig.agencies`: whether the full runtime registers `launch_agency`, and every launch's bounds. `launch: true`
 * registers the tool, which requires {@link LAUNCH_CAPABILITY}, so only a persona granted it lists and calls it. A
 * seat is a GMI of the runtime's GMIManager: a registered persona a launch names by `personaId` (in place of
 * `agentKey`), or a persona made for a temporary seat from the calling GMI's (its route, completion options,
 * capabilities and hard limits, with the seat's instructions as its prompt). Every seat runs through a view of the
 * runtime's tools that lists and runs its allowlist alone, as the parent turn's user and organization, with no
 * cognitive memory, no retrieval and no learner.
 */
export interface RuntimeAgencyLaunchOptions extends Omit<AgencyLaunchOptions, 'members' | 'launch'> {
  /**
   * Registers `launch_agency` among the runtime's config tools, for the personas granted `agency:launch`: a config tool
   * of the host's own by that name then fails initialization. Default false. A seat whose call fails rejects with its
   * error's name and code alone, so a provider's or a handler's message reaches no model of the team and not the
   * result; the error itself goes to the runtime's logger (the one `AgentOS.create` takes, else its own), at warn,
   * under `launch_agency seat <role>`, as do the launch's other failures (a failed run under `launch_agency run`). A
   * logger that throws fails no launch. The output guardrails that judge the launching turn's tool calls
   * (`config.evaluateToolCalls`) judge each call of every seat, a nested team's included, before it runs, beside the
   * sources the launching turn retrieved, and a call they block is refused as the launching turn's would be. The usage
   * the runtime's spend meter (`spendMeter`) records for the launching turn is that turn's own model calls: a team's
   * calls are its seats' GMIs' and its coordinator's, which the launch's result reports (`usage`, `coordinatorUsage`).
   */
  launch?: boolean;
  /**
   * The route of a launched team's manager and synthesizers (they call generateText). Default: the provider and model
   * of the persona of the GMI that launched the team, else the GMIs' defaults
   * (`gmiManagerConfig.defaultGMIBaseConfigDefaults`), with the key generateText resolves for that provider.
   */
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
  /**
   * The full runtime: the gate the turn's output guardrails that judge tool calls (`config.evaluateToolCalls`) ask
   * before each call of the turn's own tool round. A GMI whose turn has one passes it with every call it makes, asked
   * beside the sources the turn retrieved, and a team a call launches gives it to each of its seats' turns, so a seat's
   * calls are judged as the launching turn's are, beside what that turn read.
   */
  toolCallGate?: GMIToolCallGate;
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
 * or a persistent member's own budget on its seat's call, refused a call), `timed_out` (its deadline passed before the
 * launching turn stopped), `cancelled` (the launching turn stopped first: a deadline that passes while the team settles
 * changes nothing), `completed` (the team answered) or `failed` (the team or a seat failed, no seat ran, or the launch
 * failed before its team ran).
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
 * - `member_unavailable`: a seat could not be built: a member that cannot take a seat (on the full runtime, a persona
 *   the user's tier or strict validation refuses), or the agent or GMI made for a temporary seat.
 * - `duplicate_member`: two seats name one member.
 * - `budget_unavailable`: the launch's token cap cannot cover one call of the seat whose calls are largest
 *   (`MIN_LAUNCH_TOKENS` for the prompt and that seat's output estimate, on the route its calls run on), or it has no
 *   dollars left.
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
   * ended the seat's last call, or that call was still running when the launch returned without its answer. 'not_run':
   * none of the seat's calls has ended; in a launch's result, the seat was never called.
   */
  status: 'completed' | 'cut' | 'failed' | 'not_run';
  calls: number;
  /** The seat's last output, at most SEAT_SUMMARY_CHARS characters. */
  summary: string;
  usage: LaunchUsage;
  /** Whether the seat's turns had a learner; unset when the launch does not report it. */
  learner?: 'bound' | 'none' | 'unavailable';
  /**
   * The error that ended the seat's last call, a failed or a cut one, by name and code; never its message. Unset when
   * that call answered, and when it was still running as the launch returned.
   */
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
   * draws on) and why: the launch's own token cap, once the launch's calls have used it up, as its count of the cap;
   * any other refusal, a call whose estimate alone would pass what the cap has left among them, in the refusing cap's
   * own words.
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
  /**
   * 'running' while the team runs; 'closing' once the launch has returned while a seat, or a launch its seats started,
   * still holds a GMI; the launch's own status, merged with `closedAt` and `usage` just before the entry is removed.
   */
  status: 'running' | 'closing' | LaunchStatus;
  /** When the launch returned its result. */
  closedAt?: string;
  /** The seats' usage, as the launch's result reports it. */
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
 * Reads the provider and model a gmi() handle's persona resolved (the pair its options name, else the environment's at
 * its first build), or undefined for any other value. The read builds the agent's shared state, as its first session
 * does.
 */
export function gmiRouteOf(value: unknown): (() => Promise<{ provider?: string; model?: string }>) | undefined {
  const route = isGmiHandle(value) ? (value as { __route?: unknown }).__route : undefined;
  return typeof route === 'function' ? (route as () => Promise<{ provider?: string; model?: string }>) : undefined;
}

/**
 * Applies the defaults of `agencies` and checks every bound, at construction (`gmi()`, `AgentOS.initialize`).
 *
 * @param options - The `agencies` option, `launch` on or off. A field set to `null` is unset, as a JSON or YAML config
 *   writes it, and takes its default.
 * @returns The limits of every launch tree rooted at this agent or runtime.
 * @throws {RangeError} Naming the field, for a value outside its range or a `members` value that is not a gmi()
 *   handle (or one whose `learning.agentKey` names another key).
 * @throws {AgencyConfigError} For `hitl` approvals with no handler, the rule `agency()` applies.
 */
export function resolveLaunchLimits(options: AgencyLaunchOptions | RuntimeAgencyLaunchOptions): LaunchLimits {
  const integer = (field: string, value: number | undefined, fallback: number, min: number, max: number): number => {
    // null is unset, as `??` reads it for the other fields.
    if (value === undefined || value === null) return fallback;
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
  const dollars = options.maxLaunchCostUSD ?? undefined;
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

  const members = (options as AgencyLaunchOptions).members ?? undefined;
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

/**
 * The persistent members a surface's `launch_agency` seats as themselves: gmi()'s `agencies.members` by `agentKey`, or
 * the full runtime's registered personas by `personaId`.
 */
export type LaunchMemberForm = { field: 'agentKey'; keys: readonly string[] } | { field: 'personaId' };

/** The words the schema and the description give a member form. */
function memberWords(members: LaunchMemberForm): { property: string; brief: string; tools: string; offer: string; rule: string } {
  if (members.field === 'agentKey') {
    const keys = members.keys.join(', ');
    return {
      property: `A persistent member to seat as itself, in place of instructions: one of ${keys}.`,
      brief: "A member's brief for this team, at most 1,000 characters; only with agentKey.",
      tools: '; for a member, only those it also has',
      offer: `, or a member you seat as itself by agentKey (${keys})`,
      rule: "A member's seat may name only tools the member also has.",
    };
  }
  return {
    property: 'A registered persona to seat as itself, in place of instructions: its own prompt, model and capabilities.',
    brief: "A persona's brief for this team, at most 1,000 characters; only with personaId.",
    tools: "; for a persona, only those its capabilities allow",
    offer: ', or a registered persona you seat as itself by personaId',
    rule: "A persona's seat may name only tools its capabilities allow.",
  };
}

/**
 * The input schema `launch_agency` offers the model. Counts, unknown keys and the forms' rules are the engine's
 * (`validateLaunchArgs`), with its codes.
 *
 * @param limits - The tree's limits: the seat count and the deadlines the schema states.
 * @param members - The members the surface seats as themselves; none, and the schema offers instructions alone.
 */
export function launchAgencyInputSchema(limits: LaunchLimits, members?: LaunchMemberForm): JSONSchemaObject {
  const words = members ? memberWords(members) : undefined;
  const names = { type: 'array', items: { type: 'string' } };
  const seat: JSONSchemaObject = {
    type: 'object',
    properties: {
      role: { type: 'string', description: "The seat's name in the team, unique: a letter, then letters, digits, '_' or '-', at most 52 characters." },
      instructions: { type: 'string', description: 'Who the seat is and what it does: the system prompt of an agent made for this team.' },
      ...(members && words
        ? {
            [members.field]: { type: 'string', description: words.property },
            brief: { type: 'string', description: words.brief },
          }
        : {}),
      tools: { ...names, description: `The names of your own tools this seat may use${words?.tools ?? ''}. A seat given none uses none.` },
      dependsOn: { ...names, description: 'For the graph strategy: the roles this seat waits for; their outputs are its input.' },
    },
    required: ['role'],
  };
  return {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What the team must produce, in full: its members see nothing of this conversation. At most 8,000 characters.' },
      strategy: {
        type: 'string',
        enum: [...LAUNCH_STRATEGIES],
        description:
          "How the seats work together. sequential (the default): each seat receives the task and the previous seat's output. parallel: every seat answers at once, and one answer is made from theirs. debate: the seats argue in rounds, and their arguments are summed up. review-loop: exactly two seats, the first writes and the second reviews until it approves. hierarchical: a manager delegates to the seats. graph: a seat runs once the seats its dependsOn names have answered.",
      },
      seats: { type: 'array', items: seat, description: `The team, at most ${limits.maxSeats} seats.` },
      budgetUsd: { type: 'number', description: 'The most the team may spend, in US dollars; the launch takes the least of this and its own bounds.' },
      maxTokens: { type: 'number', description: 'The most tokens the team may use; the launch takes the least of this and its own bounds.' },
      deadlineMs: { type: 'number', description: `The team's deadline in milliseconds, at least 1,000; default ${limits.defaultDeadlineMs}, at most ${limits.maxDeadlineMs}.` },
      maxRounds: { type: 'integer', description: 'The rounds of debate and review-loop: 1, 2 or 3 (the default).' },
    },
    required: ['goal', 'seats'],
  };
}

/**
 * What the model reads about `launch_agency`.
 *
 * @param limits - The tree's limits: the seat count the description states.
 * @param members - The members the surface seats as themselves; none, and every seat is an agent made for the team.
 */
export function launchAgencyDescription(limits: LaunchLimits, members?: LaunchMemberForm): string {
  const words = members ? memberWords(members) : undefined;
  return [
    "Launches a temporary team of agents on one goal and returns the team's answer as this call's result.",
    `Each seat is an agent with the instructions you give it${words?.offer ?? ''}.`,
    'One seat makes a subagent.',
    "The team sees nothing of this conversation, so put everything it needs in the goal and each seat's instructions.",
    'A seat uses only the tools its tools list names, from your own tools.',
    ...(words ? [words.rule] : []),
    `At most ${limits.maxSeats} seats; the team runs within a share of this turn's budget and a deadline.`,
    'A launch that is refused returns an error that starts with its code, such as too_many_seats or invalid_arguments.',
  ].join(' ');
}

/** A tool as the seat rules read it: its name and, for a composed tool, the tools its steps call. */
export interface SeatToolLike {
  readonly name: string;
  readonly stepTools?: readonly string[];
}

/**
 * The step tools of a composed tool that `allowed` leaves out, nested compositions' steps included, first found first;
 * `[]` for a tool whose steps are all allowed, or that is no composition (a composed tool is admitted only
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
