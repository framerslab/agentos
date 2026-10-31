/**
 * @file runtimeLaunchTool.ts
 * `launch_agency` on the full runtime: the config tool AgentOS registers with `agencies.launch`, which a persona lists
 * and calls only with the `agency:launch` capability, and its host for the launch engine. A seat is a
 * GMI of the runtime's GMIManager (`createAgencySeat`): a registered persona by `personaId`, or a persona made for a
 * temporary seat from the calling GMI's; it runs through a view of the shared tool orchestrator that lists and runs
 * its allowlist alone and asks the approval gate of the team's call (the one `agencies.hitl` makes at a root launch)
 * about each of its tool calls, and makes its completion calls through a view of the runtime's provider manager that
 * checks each against the launch's budget before it is sent. The team's manager and synthesizers call generateText on
 * the host's `coordinator`, else with the key and base URL of the runtime's entry for their provider. The engine is
 * imported on the first call.
 * @internal
 */
import type { AgencyRegistry } from '../../../agents/agency/AgencyRegistry.js';
import type { GMIManager } from '../../../cognition/substrate/GMIManager.js';
import type { IPersonaDefinition } from '../../../cognition/substrate/personas/IPersonaDefinition.js';
import type { ProviderConfigEntry } from '../../../core/llm/providers/AIModelProviderManager.js';
import type { ILogger } from '../../../core/logging/ILogger.js';
import type { ITool, ToolExecutionContext, ToolExecutionResult } from '../../../core/tools/ITool.js';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator.js';
import { GMIErrorCode } from '../../../core/utils/errors.js';
import type { ApprovalGateFn } from '../approval-gate.js';
import { resolveGMIForToolContext } from '../SelfImprovementSessionManager.js';
import { outputEstimateTokens } from '../spendBudget.js';
import type { LaunchEntry } from './launchRegistry.js';
import { meteredProviderManager } from './meteredProviderManager.js';
import type { LaunchHost, LaunchParent, ResolvedSeat } from './runLaunch.js';
import { runtimeSeat, type RuntimeSeatHandle } from './runtimeSeat.js';
import { seatToolView } from './seatToolView.js';
import type { SeatHandle } from './sessionSeat.js';
import {
  LAUNCH_AGENCY_TOOL_NAME,
  LAUNCH_CAPABILITY,
  launchAgencyDescription,
  launchAgencyInputSchema,
  type AgencyLaunchFrame,
  type LaunchAgencyArgs,
  type LaunchAgencyResult,
  type LaunchLimits,
  type LaunchRefusal,
  type RuntimeAgencyLaunchOptions,
} from './types.js';

/** The most of a seat call's answer the call's entry in the registry's seat history keeps. */
const HISTORY_PREVIEW_CHARS = 200;

/** What createRuntimeLaunchTool needs of the runtime. */
export interface RuntimeLaunchToolDeps {
  /** The runtime's GMI manager, read at each launch: it is built after the tool is registered. */
  getGmiManager(): GMIManager | undefined;
  /** The runtime's shared tool orchestrator. */
  getToolOrchestrator(): IToolOrchestrator | undefined;
  /** The runtime's agency registry, read at each record; a runtime without one records nothing. */
  getAgencyRegistry?(): AgencyRegistry | undefined;
  /** `AgentOSConfig.agencies`. */
  options: RuntimeAgencyLaunchOptions;
  /** The tree's limits, resolved at initialization. */
  limits: LaunchLimits;
  /** The GMIs' default provider and model, for a persona that names none (`gmiManagerConfig.defaultGMIBaseConfigDefaults`). */
  gmiDefaults?: { defaultLlmProviderId?: string; defaultLlmModelId?: string };
  /**
   * The runtime's provider entries (`modelProviderManagerConfig.providers`): a launched team's coordinator takes the
   * key and base URL of its provider's entry.
   */
  providers: readonly ProviderConfigEntry[];
  /** Where a launch's failures go: a seat's failed call's original error among them. */
  logger: ILogger;
}

/** An error's name and code, for a refusal's reason: never its message. */
function nameAndCode(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? `${name}: ${code}` : name;
}

/** The first line of a seat's instructions, else its role: what a hierarchical manager reads about a temporary seat. */
function firstLineOf(text: string, fallback: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? fallback;
}

/**
 * A temporary seat's persona, made field by field from the persona of the GMI that launched it: its route, completion
 * options, capabilities and hard limits, with the seat's instructions as its prompt and no traits, metaprompts,
 * sentiment tracking or memory config.
 */
function temporaryPersona(parent: IPersonaDefinition | undefined, seat: Extract<ResolvedSeat, { form: 'temporary' }>, launchId: string): IPersonaDefinition {
  return {
    id: `${launchId}-${seat.role}`,
    name: seat.role,
    description: firstLineOf(seat.instructions, seat.role),
    version: '1.0.0',
    baseSystemPrompt: seat.instructions,
    ...(parent?.defaultProviderId ? { defaultProviderId: parent.defaultProviderId } : {}),
    ...(parent?.defaultModelId ? { defaultModelId: parent.defaultModelId } : {}),
    ...(parent?.defaultModelCompletionOptions ? { defaultModelCompletionOptions: { ...parent.defaultModelCompletionOptions } } : {}),
    ...(parent?.allowedCapabilities ? { allowedCapabilities: [...parent.allowedCapabilities] } : {}),
    ...(parent?.hardLimits ? { hardLimits: [...parent.hardLimits] } : {}),
    metaPrompts: [],
    sentimentTracking: { enabled: false },
  } as IPersonaDefinition;
}

/** The route of a launched team's manager and synthesizers. */
export interface CoordinatorRoute {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * The route of a launched team's manager and synthesizers, which call generateText: the host's `coordinator`, else
 * the provider and model of the persona of the GMI that launched the team, with the key and base URL of the runtime's
 * enabled entry for that provider, where the runtime's own providers take theirs; the environment's key only when that
 * entry has none.
 *
 * @param coordinator - `agencies.coordinator`, when the host sets it.
 * @param persona - The provider and model of the launching GMI's persona, else the GMIs' defaults.
 * @param providers - The runtime's provider entries.
 * @returns The route, with only the fields that are set.
 */
export function coordinatorRoute(
  coordinator: RuntimeAgencyLaunchOptions['coordinator'],
  persona: { provider?: string; model?: string },
  providers: readonly ProviderConfigEntry[],
): CoordinatorRoute {
  if (coordinator) return { ...coordinator };
  const { provider, model } = persona;
  const entry = provider ? providers.find((candidate) => candidate.providerId === provider && candidate.enabled) : undefined;
  const config = (entry?.config ?? {}) as { apiKey?: unknown; baseURL?: unknown };
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(typeof config.apiKey === 'string' && config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(typeof config.baseURL === 'string' && config.baseURL ? { baseUrl: config.baseURL } : {}),
  };
}

/**
 * `launch_agency` for the full runtime.
 *
 * @param deps - The runtime's GMI manager and orchestrator getters, the options, limits, defaults and logger.
 * @returns The tool: it requires `agency:launch`, so only a persona granted it lists and calls it, and has side
 *   effects. It never throws: every refusal and every launch that started is a tool result.
 */
export function createRuntimeLaunchTool(deps: RuntimeLaunchToolDeps): ITool<LaunchAgencyArgs, LaunchAgencyResult> {
  const manager = (): GMIManager => {
    const found = deps.getGmiManager();
    if (!found) throw new Error('launch_agency: the runtime has no GMI manager yet');
    return found;
  };
  const orchestrator = (): IToolOrchestrator => {
    const found = deps.getToolOrchestrator();
    if (!found) throw new Error('launch_agency: the runtime has no tool orchestrator yet');
    return found;
  };
  /** The persona of the GMI that made a launch's call: a seat's own definition, or the registered one. */
  const personaOf = (parent: LaunchParent): IPersonaDefinition | undefined =>
    manager().activeGMIs.get(parent.gmiId)?.getPersona() ?? manager().getPersonaDefinition(parent.personaId);
  /**
   * The output tokens one call of a GMI built from the persona is counted with, as its own check counts it: the
   * persona's maxTokens held to the output ceiling of its model, the runtime's default model when it names none
   * (4,096 when maxTokens is unset, which is what a GMI sends then: no cap). The one-call floor counts a temporary seat
   * with the persona of the GMI that launched it, whose route the seat takes, and a personaId member with its own
   * persona's.
   */
  const estimateOf = (persona: IPersonaDefinition | undefined): number =>
    outputEstimateTokens(persona?.defaultModelId || deps.gmiDefaults?.defaultLlmModelId || '', persona?.defaultModelCompletionOptions?.maxTokens);

  /**
   * Where a launch's failures go: the runtime's logger, at warn, under `launch_agency` and what failed (`launch_agency
   * seat <role>`, `launch_agency run`), with the error's name, message and stack. A logger that throws fails no launch
   * and no seat's call.
   */
  const logError = (error: unknown, where: string): void => {
    const what = where.startsWith(LAUNCH_AGENCY_TOOL_NAME) ? where : `${LAUNCH_AGENCY_TOOL_NAME} ${where}`;
    try {
      deps.logger.warn(`[AgentOS] ${what} failed`, {
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });
    } catch {
      // Nothing further to report to.
    }
  };

  const host: LaunchHost = {
    surface: 'runtime',

    async rootParent(ctx: ToolExecutionContext): Promise<LaunchParent> {
      // A full-runtime turn carries no gate, no hooks and no budget; its root launches draw on its pool.
      const gmi = resolveGMIForToolContext(manager(), ctx);
      if (!gmi) throw new Error('launch_agency: the GMI that made the call is not active');
      const persona = gmi.getPersona();
      const sessionId = String(ctx.sessionData?.sessionId ?? gmi.gmiId);
      const conversationId = ctx.sessionData?.conversationId;
      const organizationId = ctx.sessionData?.organizationId;
      return {
        gmiId: gmi.gmiId,
        personaId: persona.id,
        sessionId,
        // The session's GMI (an id of its own) and the session: a root scope of its own.
        scopeId: `${gmi.gmiId}:${sessionId}`,
        ...(typeof conversationId === 'string' ? { conversationId } : {}),
        depth: 0,
        limits: deps.limits,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.userContext?.userId ? { providerUserId: ctx.userContext.userId } : {}),
        // The organization is the namespace on the full runtime.
        namespace: typeof organizationId === 'string' ? organizationId : '',
        ...(ctx.correlationId ? { turnId: ctx.correlationId } : {}),
        // The session's GMI keeps its turns' launch pool: the pool lasts as long as the GMI that runs the turn.
        poolOwner: gmi,
        toolHooks: [],
        // The output guardrails' tool-call gate the turn asks before each of its calls: the seats' turns ask it too.
        ...(ctx.callerTurn?.toolCallGate ? { toolCallGate: ctx.callerTurn.toolCallGate } : {}),
        outputEstimateTokens: estimateOf(persona),
      };
    },

    /** A nested launch's temporary seats run on the calling GMI's persona's route: the floor counts them with its estimate. */
    async outputEstimateTokens(ctx: ToolExecutionContext): Promise<number> {
      return estimateOf(resolveGMIForToolContext(manager(), ctx)?.getPersona() ?? manager().getPersonaDefinition(ctx.personaId));
    },

    /** A personaId member's calls run on its own persona's route: the floor counts its seat with that persona's estimate. */
    async memberOutputEstimateTokens(ref: string): Promise<number | undefined> {
      const persona = manager().getPersonaDefinition(ref);
      return persona ? estimateOf(persona) : undefined;
    },

    async parentToolNames(ctx: ToolExecutionContext): Promise<ReadonlySet<string>> {
      // The tools the calling persona lists: those its capabilities allow.
      const tools = await orchestrator().listAvailableTools({ personaId: ctx.personaId, personaCapabilities: ctx.personaCapabilities ?? [], userContext: ctx.userContext });
      return new Set(tools.map((tool) => tool.name));
    },

    async toolOf(_ctx: ToolExecutionContext, name: string) {
      return orchestrator().getTool(name);
    },

    hasMember: (ref: string): boolean => manager().getPersonaDefinition(ref) !== undefined,

    async buildSeat(seat: ResolvedSeat, launch: LaunchEntry, parent: LaunchParent, frame: AgencyLaunchFrame, cutWhen: () => boolean): Promise<SeatHandle | LaunchRefusal> {
      const seatSessionId = `seat:${launch.launchId}:${seat.role}`;
      const userId = parent.providerUserId ?? 'system';
      // The approval gate of the call the seat serves: set by the seat for each call, asked by its view.
      const gate: { current?: ApprovalGateFn } = {};
      try {
        if (seat.form === 'persistent') {
          // A member's seat names only tools its persona may use: those its capabilities allow.
          const persona = manager().getPersonaDefinition(seat.ref);
          if (!persona) return { code: 'unknown_member', reason: `seat '${seat.role}': no persona '${seat.ref}'` };
          const own = await orchestrator().listAvailableTools({ personaId: persona.id, personaCapabilities: persona.allowedCapabilities ?? [], userContext: { userId } });
          const ownNames = new Set(own.map((tool) => tool.name));
          const missing = [...seat.toolNames].find((name) => !ownNames.has(name));
          if (missing) return { code: 'unknown_tool', reason: `seat '${seat.role}': the persona '${seat.ref}' has no tool '${missing}'` };
        }
        const built = await manager().createAgencySeat({
          seatSessionId,
          userId,
          persona: seat.form === 'persistent' ? { personaId: seat.ref } : { definition: temporaryPersona(personaOf(parent), seat, launch.launchId) },
          toolView: (base) => seatToolView(base, seat.toolNames, () => gate.current),
          // Every completion call the seat's GMI makes is checked against the launch's budget before it is sent.
          providerManager: (base) => meteredProviderManager(base, launch.budget),
        });
        const description = (seat.form === 'persistent' ? seat.brief : undefined) ?? built.gmi.getPersona().description;
        return runtimeSeat({
          role: seat.role,
          form: seat.form,
          ...(seat.form === 'persistent' ? { memberRef: seat.ref, ...(seat.brief ? { brief: seat.brief } : {}) } : {}),
          ...(description ? { description } : {}),
          ...(seat.dependsOn ? { dependsOn: [...seat.dependsOn] } : {}),
          seatSessionId,
          userId,
          organizationId: parent.namespace,
          frame,
          gmi: built.gmi,
          personaId: built.personaId,
          release: built.release,
          ...(parent.toolCallGate ? { toolCallGate: parent.toolCallGate } : {}),
          setGate: (fn) => {
            gate.current = fn;
          },
          cutWhen,
          logError,
          // Each call the seat ran, in the team's registry entry: its outcome, and the start of its answer when it answered.
          onCall: (call) => {
            deps.getAgencyRegistry?.()?.appendSeatHistory(launch.launchId, seat.role, {
              timestamp: new Date().toISOString(),
              status: call.status === 'completed' ? 'completed' : 'failed',
              ...(call.status === 'completed' ? { outputPreview: call.summary.slice(0, HISTORY_PREVIEW_CHARS) } : {}),
              metadata: { outcome: call.status, ...(call.error ? { error: { ...call.error } } : {}) },
            });
          },
        });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (seat.form === 'persistent' && code === GMIErrorCode.PERSONA_NOT_FOUND) {
          return { code: 'unknown_member', reason: `seat '${seat.role}': no persona '${seat.ref}'` };
        }
        logError(error, `seat ${seat.role}`);
        // A seat that cannot be seated (a persona the user's tier or strict validation refuses, a GMI that does not
        // initialize) refuses the launch before any seat runs.
        return seat.form === 'persistent'
          ? { code: 'member_unavailable', reason: `seat '${seat.role}': the persona '${seat.ref}' could not be seated (${nameAndCode(error)})` }
          : { code: 'member_unavailable', reason: `seat '${seat.role}' could not be seated (${nameAndCode(error)})` };
      }
    },

    async agencyRoute(parent: LaunchParent) {
      // The manager and synthesizers call generateText: on the host's coordinator, else on the launching persona's
      // provider and model with the key and base URL of the runtime's entry for that provider.
      if (deps.options.coordinator) return coordinatorRoute(deps.options.coordinator, {}, deps.providers);
      const persona = personaOf(parent);
      const provider = persona?.defaultProviderId || deps.gmiDefaults?.defaultLlmProviderId;
      const model = persona?.defaultModelId || deps.gmiDefaults?.defaultLlmModelId;
      return coordinatorRoute(undefined, { provider, model }, deps.providers);
    },

    // The team's entry in the runtime's AgencyRegistry while it runs: made under the launch's agencyId with a seat per
    // role once the team is built, a history entry per seat call (each seat's onCall), marked closing when the launch
    // returns while a seat still holds its GMI, and, when the launch's entry goes, the launch's status, closing time
    // and usage merged, then the entry removed. A runtime with no registry records nothing.
    recorder: {
      start({ agencyId, conversationId, meta, seats }) {
        const registry = deps.getAgencyRegistry?.();
        if (!registry) return;
        registry.upsertAgency({ agencyId, workflowId: `launch:${agencyId}`, conversationId, metadata: { ...meta } });
        for (const seat of seats) {
          const { role, form, member } = seat.record();
          const { gmiId, personaId } = seat as Partial<Pick<RuntimeSeatHandle, 'gmiId' | 'personaId'>>;
          if (!gmiId || !personaId) continue;
          registry.registerSeat({ agencyId, roleId: role, gmiInstanceId: gmiId, personaId, metadata: { form, ...(member ? { member } : {}) } });
        }
      },
      closing(result) {
        const registry = deps.getAgencyRegistry?.();
        const entry = registry?.getAgency(result.agencyId);
        if (!registry || !entry) return;
        registry.upsertAgency({ agencyId: result.agencyId, workflowId: entry.workflowId, conversationId: entry.conversationId, metadata: { status: 'closing' } });
      },
      close(result) {
        // Only an entry this registry holds: a registry made after the launch started has none to close.
        const registry = deps.getAgencyRegistry?.();
        const entry = registry?.getAgency(result.agencyId);
        if (!registry || !entry) return;
        registry.upsertAgency({
          agencyId: result.agencyId,
          workflowId: entry.workflowId,
          conversationId: entry.conversationId,
          metadata: { status: result.status, closedAt: result.provenance.closedAt, usage: { ...result.usage } },
        });
        registry.removeAgency(result.agencyId);
      },
    },

    logError,
  };

  return {
    id: 'agentos-launch-agency',
    name: LAUNCH_AGENCY_TOOL_NAME,
    displayName: 'Launch agency',
    description: launchAgencyDescription(deps.limits, { field: 'personaId' }),
    inputSchema: launchAgencyInputSchema(deps.limits, { field: 'personaId' }),
    category: 'agency',
    hasSideEffects: true,
    requiredCapabilities: [LAUNCH_CAPABILITY],
    async execute(args: LaunchAgencyArgs, context: ToolExecutionContext): Promise<ToolExecutionResult<LaunchAgencyResult>> {
      const { runLaunch } = await import('./runLaunch.js');
      return runLaunch(host, args, context);
    },
  };
}
