/**
 * @file gmiLaunchTool.ts
 * `launch_agency` on gmi(): the tool a gmi() agent with `agencies.launch` registers, and the host the launch engine
 * runs through on that surface. A temporary seat is a gmi() agent built for the launch from the launching agent's route
 * (the provider and model its persona resolved, and its other route options), its generation hooks and request timeout,
 * the seat's instructions and the very tool instances its allowlist names, on the light profile with no memory and no
 * learner, and closed with the seat; a persistent seat runs a member of `agencies.members` as itself, through a session
 * of its own. Every seat's tool calls run the tool hooks of the turn that launched the team before the seat's own. The
 * engine, and agency() with it, is imported on the first launch, so building an agent loads neither.
 * @internal
 */
import { randomUUID } from 'node:crypto';
import type { AgentOptions } from '../../agent.js';
import type { Agent } from '../../types.js';
import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '../../../core/tools/ITool.js';
import { createContentSafeConsole } from '../../../core/logging/contentSafeConsole.js';
import { callMaxTokensOf } from '../gmiPersona.js';
import { outputEstimateTokens } from '../spendBudget.js';
import { adaptTools } from '../toolAdapter.js';
import type { AgentOSUsageLedgerOptions } from '../usageLedger.js';
import type { LaunchEntry } from './launchRegistry.js';
import type { LaunchHost, LaunchParent, ResolvedSeat } from './runLaunch.js';
import { buildSessionSeat, descriptionOf, type InternalSeatOptions, type SeatHandle } from './sessionSeat.js';
import {
  LAUNCH_AGENCY_TOOL_NAME,
  gmiOptionsOf,
  gmiRouteOf,
  type AgencyLaunchFrame,
  type LaunchAgencyArgs,
  type LaunchAgencyResult,
  type LaunchLimits,
  type LaunchRefusal,
} from './types.js';

/** This module's fixed diagnostic origin; no runtime name enters telemetry. */
const console = createContentSafeConsole('gmi_launch_tool');

/** What gmi() hands the tool. */
export interface GmiLaunchToolOptions {
  /** The launching agent's options. */
  opts: AgentOptions;
  /** Its launch limits, resolved at construction (`resolveLaunchLimits`). */
  limits: LaunchLimits;
  /** The launching agent's tools, launch_agency included: a root launch's tool names and a temporary seat's tools. */
  tools: () => readonly ITool[];
  /** The agent's usage ledger: a temporary seat's sessions and the team's coordinator record to it under source `launch_agency`. */
  ledger?: AgentOSUsageLedgerOptions;
  /** Builds a temporary seat's agent (gmi() itself). */
  createAgent: (options: AgentOptions) => Agent;
  /**
   * The provider and model the agent's persona resolved in its shared build: those its options name (the provider's
   * default model when they name only a provider), else the pair its first call resolved from the environment. Every
   * turn that can launch runs on that build, so it has resolved.
   */
  route: () => Promise<{ provider?: string; model?: string }>;
}

/** The launching agent's options a temporary seat's agent takes: its route, completion settings and generation hooks. */
const SEAT_OPTION_KEYS = [
  'provider',
  'model',
  'apiKey',
  'baseUrl',
  'fallbackProviders',
  'onFallback',
  'policyTier',
  'router',
  'routerParams',
  'hostPolicy',
  'maxTokens',
  'thinking',
  'effort',
  'customModelParams',
  'cache',
  'maxSteps',
  'chainOfThought',
  // Its generation hooks, so a host's rewrite of a request or of a step's text covers the seat's calls. Its tool hook is
  // not among them: every seat's tool calls run the hooks of the turn that launched the team, the agent's own among them.
  'onBeforeGeneration',
  'onAfterGeneration',
] as const satisfies ReadonlyArray<keyof AgentOptions>;

/**
 * The options of a temporary seat's agent: the launching agent's route, generation hooks and request timeout, and the
 * seat's role, instructions and tools.
 */
function temporarySeatOptions(parent: AgentOptions, role: string, instructions: string, tools: ITool[], ledger: AgentOSUsageLedgerOptions | undefined): AgentOptions {
  const inherited: Record<string, unknown> = {};
  for (const key of SEAT_OPTION_KEYS) if (parent[key] !== undefined) inherited[key] = parent[key];
  return {
    ...(inherited as Partial<AgentOptions>),
    name: role,
    instructions,
    // By name, each the launching agent's own instance (adaptTools keeps an ITool as it is).
    tools: Object.fromEntries(tools.map((tool): [string, ITool] => [tool.name, tool])),
    // The light profile with no memory: a seat runs one goal, and nothing it is told outlives the launch.
    cognition: 'light',
    ...(ledger ? { usageLedger: { ...ledger, source: LAUNCH_AGENCY_TOOL_NAME } } : {}),
    // The launching agent's request timeout bounds each of the seat's calls too. Its other controls stay the agent's:
    // the launch's budget bounds what the seat spends.
    ...(parent.controls?.maxDurationMs !== undefined ? { controls: { maxDurationMs: parent.controls.maxDurationMs } } : {}),
  };
}

/** The tool names a persistent member's own turns can run: its tools, and launch_agency when it launches teams itself. */
function memberToolNames(member: Agent): Set<string> {
  const config: Partial<AgentOptions> = gmiOptionsOf(member) ?? {};
  const names = new Set(adaptTools(config.tools).map((tool) => tool.name));
  if (config.agencies?.launch === true) names.add(LAUNCH_AGENCY_TOOL_NAME);
  return names;
}

/** The input schema the model is offered. Counts, unknown keys and the forms' rules are the engine's, with its codes. */
function inputSchemaFor(limits: LaunchLimits, memberKeys: string[]): JSONSchemaObject {
  const names = { type: 'array', items: { type: 'string' } };
  const seat: JSONSchemaObject = {
    type: 'object',
    properties: {
      role: { type: 'string', description: "The seat's name in the team, unique: a letter, then letters, digits, '_' or '-', at most 52 characters." },
      instructions: { type: 'string', description: 'Who the seat is and what it does: the system prompt of an agent made for this team.' },
      ...(memberKeys.length > 0
        ? {
            agentKey: { type: 'string', description: `A persistent member to seat as itself, in place of instructions: one of ${memberKeys.join(', ')}.` },
            brief: { type: 'string', description: "A member's brief for this team, at most 1,000 characters; only with agentKey." },
          }
        : {}),
      tools: {
        ...names,
        description: `The names of your own tools this seat may use${memberKeys.length > 0 ? '; for a member, only those it also has' : ''}. A seat given none uses none.`,
      },
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
        enum: ['sequential', 'parallel', 'debate', 'review-loop', 'hierarchical', 'graph'],
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

/** What the model reads about the tool. */
function descriptionFor(limits: LaunchLimits, memberKeys: string[]): string {
  const members = memberKeys.length > 0 ? `, or a member you seat as itself by agentKey (${memberKeys.join(', ')})` : '';
  return [
    "Launches a temporary team of agents on one goal and returns the team's answer as this call's result.",
    `Each seat is an agent with the instructions you give it${members}.`,
    'One seat makes a subagent.',
    "The team sees nothing of this conversation, so put everything it needs in the goal and each seat's instructions.",
    "A seat uses only the tools its tools list names, from your own tools.",
    ...(memberKeys.length > 0 ? ["A member's seat may name only tools the member also has."] : []),
    `At most ${limits.maxSeats} seats; the team runs within a share of this turn's budget and a deadline.`,
    'A launch that is refused returns an error that starts with its code, such as too_many_seats or invalid_arguments.',
  ].join(' ');
}

/**
 * The `launch_agency` tool of a gmi() agent with `agencies.launch`.
 *
 * @param o - The agent's options, launch limits, tools, ledger and agent builder.
 * @returns The tool, which never throws: every refusal and every launch that started is a tool result.
 */
export function createGmiLaunchTool(o: GmiLaunchToolOptions): ITool<LaunchAgencyArgs, LaunchAgencyResult> {
  const { opts, limits, ledger } = o;
  // One id per agent: a root launch's scope is this agent and the launching session, so two agents' sessions of one
  // id are two scopes.
  const agentScope = randomUUID();
  // The members record, copied once: resolveLaunchLimits checked these entries at construction, so a member the caller
  // puts in its record later, under a new key or an old one, never takes a seat.
  const members: Readonly<Record<string, Agent>> = Object.freeze({ ...opts.agencies?.members });
  const memberKeys = Object.keys(members);
  const learning = opts.learning;
  const namespace = typeof learning === 'object' && learning !== null && typeof learning.namespace === 'string' ? learning.namespace : '';

  const logError = (error: unknown, where: string): void => {
    console.warn(`[agentos] gmi(): ${where} failed:`, error);
  };

  /** The member of a persistent seat, by its agentKey. */
  const memberOf = (ref: string): Agent | undefined => (Object.prototype.hasOwnProperty.call(members, ref) ? members[ref] : undefined);

  /**
   * The provider and model a launched team's manager, synthesizers and temporary seats run on: the pair the agent's
   * persona resolved (`o.route`), which `agency()` needs for a parallel, debate or hierarchical team. The team stays on it
   * when the environment names another pair after the agent's first call, as the agent's own turns do; a call that names
   * its own provider or model runs on that pair alone, and a team it launches on the agent's. A pair that cannot be read
   * (no turn that can launch runs without it) is logged, and the pair the options name stands in.
   */
  const agentRoute = async (): Promise<{ provider?: string; model?: string }> => {
    try {
      const { provider, model } = await o.route();
      return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
    } catch (error) {
      logError(error, 'launch_agency route');
      return { ...(opts.provider ? { provider: opts.provider } : {}), ...(opts.model ? { model: opts.model } : {}) };
    }
  };

  /**
   * The output tokens one call of a temporary seat is counted with, as the seat's own check counts it: the agent's
   * maxTokens, which the seat takes, held to the output ceiling of the model the persona resolved, which the seat runs
   * on (4,096 when maxTokens is unset). The one-call floor counts it for the temporary seats of every launch this agent
   * runs: its root launches, and the teams it launches from a seat it holds in another agent's team, whose seats it
   * builds on this route too.
   */
  const seatOutputEstimate = async (): Promise<number> => outputEstimateTokens((await agentRoute()).model ?? '', opts.maxTokens);

  /**
   * The output tokens one call of a member's seat is counted with, as its own check counts it: the member runs as
   * itself, so the cap its calls are sent with (its maxTokens, else its controls.maxTotalTokens) held to the output
   * ceiling of the model its persona resolved (the model its options name when that pair cannot be read).
   */
  const memberOutputEstimate = async (ref: string): Promise<number | undefined> => {
    const member = memberOf(ref);
    if (!member) return undefined;
    const config: Partial<AgentOptions> = gmiOptionsOf(member) ?? {};
    let model = config.model;
    try {
      model = (await gmiRouteOf(member)?.())?.model ?? model;
    } catch (error) {
      logError(error, `launch_agency member ${ref} route`);
    }
    return outputEstimateTokens(model ?? '', callMaxTokensOf(config));
  };

  const host: LaunchHost = {
    surface: 'gmi',

    async rootParent(ctx: ToolExecutionContext): Promise<LaunchParent> {
      const caller = ctx.callerTurn;
      const sessionId = String(ctx.sessionData?.sessionId ?? ctx.gmiId);
      const conversationId = ctx.sessionData?.conversationId;
      const outputEstimate = await seatOutputEstimate();
      return {
        gmiId: ctx.gmiId,
        personaId: ctx.personaId,
        sessionId,
        ...(typeof conversationId === 'string' ? { conversationId } : {}),
        depth: 0,
        limits,
        ...(caller?.budget ? { budget: caller.budget } : {}),
        // The gate the launching turn carries (an agency's, when this agent is one of its members): the team asks it
        // first on every seat's tool call, and its refusal is final.
        ...(caller?.approvalGate ? { approvalGate: caller.approvalGate } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(caller?.providerUserId !== undefined ? { providerUserId: caller.providerUserId } : {}),
        namespace,
        ...(ctx.correlationId ? { turnId: ctx.correlationId } : {}),
        // The hooks the launching turn's calls ran under, outermost first: any it carried, then the agent's own. Every
        // seat's tool calls run them before the seat's own hook, a member's included.
        toolHooks: caller?.toolHooks ?? [],
        outputEstimateTokens: outputEstimate,
        scopeId: `${agentScope}:${sessionId}`,
      };
    },

    outputEstimateTokens: seatOutputEstimate,

    memberOutputEstimateTokens: memberOutputEstimate,

    async parentToolNames(ctx: ToolExecutionContext): Promise<ReadonlySet<string>> {
      // A seat's turn runs only its names; any other turn runs every tool of the agent.
      return ctx.callerTurn?.toolNames ?? new Set(o.tools().map((tool) => tool.name));
    },

    async toolOf(_ctx: ToolExecutionContext, name: string) {
      return o.tools().find((tool) => tool.name === name);
    },

    hasMember: (ref: string): boolean => memberOf(ref) !== undefined,

    async buildSeat(seat: ResolvedSeat, launch: LaunchEntry, parent: LaunchParent, frame: AgencyLaunchFrame, cutWhen: () => boolean): Promise<SeatHandle | LaunchRefusal> {
      const common: Omit<InternalSeatOptions, 'form'> = {
        sessionId: `seat:${launch.launchId}:${seat.role}`,
        role: seat.role,
        tools: [...seat.toolNames],
        ...(seat.dependsOn ? { dependsOn: [...seat.dependsOn] } : {}),
        // The seat's session runs as the launching turn's user, when that turn named one.
        ...(parent.providerUserId !== undefined ? { userId: parent.providerUserId } : {}),
        frame,
        budget: launch.budget,
        toolHooks: launch.toolHooks,
        logError,
        cutWhen,
      };
      try {
        if (seat.form === 'persistent') {
          const member = memberOf(seat.ref);
          if (!member) return { code: 'unknown_member', reason: `seat '${seat.role}': no member '${seat.ref}'` };
          const own = memberToolNames(member);
          const missing = [...seat.toolNames].find((name) => !own.has(name));
          if (missing) return { code: 'unknown_tool', reason: `seat '${seat.role}': the member '${seat.ref}' has no tool '${missing}'` };
          const description = seat.brief ?? descriptionOf(gmiOptionsOf(member) ?? {});
          return buildSessionSeat(member, {
            ...common,
            form: 'persistent',
            memberRef: seat.ref,
            ...(seat.brief ? { brief: seat.brief } : {}),
            ...(description ? { description } : {}),
          });
        }
        // A temporary seat runs the launching agent's own tool instances, launch_agency among them where its allowlist
        // names it: the frame its turns carry makes a launch from the seat a nested one.
        const byName = new Map(o.tools().map((tool) => [tool.name, tool]));
        const tools = [...seat.toolNames].map((name) => byName.get(name)).filter((tool): tool is ITool => tool !== undefined);
        const member = o.createAgent(temporarySeatOptions({ ...opts, ...(await agentRoute()) }, seat.role, seat.instructions, tools, ledger));
        const description = descriptionOf({ instructions: seat.instructions });
        return buildSessionSeat(member, { ...common, form: 'temporary', ownsMember: true, ...(description ? { description } : {}) });
      } catch (error) {
        logError(error, `launch_agency seat ${seat.role}`);
        const name = error instanceof Error ? error.name : 'Error';
        return { code: 'member_unavailable', reason: `seat '${seat.role}' could not be seated (${name})` };
      }
    },

    async agencyRoute() {
      return {
        ...(await agentRoute()),
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      };
    },

    // The agent's callbacks, for the child agency, which fires them as `launch:<agencyId>`: the agent's `on` sees every
    // team it launches, a team one of its temporary seats launches through the agent's own tool included.
    ...(opts.on ? { callbacks: opts.on } : {}),
    ...(ledger ? { usageLedger: ledger } : {}),
    // gmi() keeps no registry of running teams.
    recorder: { start: () => undefined, close: () => undefined },
    logError,
  };

  return {
    id: `launch-agency-${agentScope}`,
    name: LAUNCH_AGENCY_TOOL_NAME,
    displayName: 'Launch agency',
    description: descriptionFor(limits, memberKeys),
    inputSchema: inputSchemaFor(limits, memberKeys),
    category: 'agency',
    hasSideEffects: true,
    async execute(args: LaunchAgencyArgs, ctx: ToolExecutionContext): Promise<ToolExecutionResult<LaunchAgencyResult>> {
      const { runLaunch } = await import('./runLaunch.js');
      return runLaunch(host, args, ctx);
    },
  };
}
