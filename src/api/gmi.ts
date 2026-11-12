/**
 * @file gmi.ts
 * gmi(): an agent whose sessions are Generalized Mind Instances, built
 * in-process from agent options (docs/GMI.md, "GMIs from agent()"). `agent({ runtime: 'gmi' })`
 * returns the same handle.
 *
 * Construction checks what needs no environment: options the GMI path cannot
 * honour, the cognition profile, the `learning` option, and the `memory.embedding`
 * settings that name their provider. With `learning` on it also builds the
 * agent's learning layer. The persona (with the provider and model it resolves), the
 * prompt engine, utility AI and tool orchestrator the sessions share, and the
 * cognitive memory are built on first use, so an agent made before its keys are
 * set resolves them on its first call; a build that fails is not kept, and the
 * next call builds again.
 *
 * With `memory.store` (which needs the learning option and a key for its brain,
 * `learning.agentKey` or the soul's id)
 * the agent's memory and its learning store share one Brain's adapter, opened on
 * first use, and the Brain keeps each session id's generation, so an id that
 * session.close() ended stays ended across a restart.
 */
import { randomUUID } from 'node:crypto';
import type { Agent, AgentLearning, AgentOptions, AgentSession, AgentSessionOptions, SessionSendOptions } from './agent.js';
// agent.ts imports this module back; each side calls the other only inside functions.
import { loadSoulFromOption } from './agent.js';
import { extractTextFromContent, resolveChainOfThought, type GenerateTextOptions, type GenerateTextResult, type Message, type MessageContent, type TokenUsage } from './generateText.js';
import type { StreamTextResult } from './streamText.js';
import { GMI } from '../cognition/substrate/GMI.js';
import type { GMIBaseConfig, IGMI, ToolCallRequest, ToolCallResult } from '../cognition/substrate/IGMI.js';
import type { IPersonaDefinition } from '../cognition/substrate/personas/IPersonaDefinition.js';
import { InMemoryWorkingMemory } from '../cognition/substrate/memory/InMemoryWorkingMemory.js';
import { StatisticalUtilityAI } from '../cognition/nlp/ai_utilities/StatisticalUtilityAI.js';
import { PromptEngine } from '../core/llm/PromptEngine.js';
import type { PromptEngineConfig } from '../core/llm/IPromptEngine.js';
import type { ChatMessage } from '../core/llm/providers/IProvider.js';
import { ToolPermissionManager } from '../core/tools/permissions/ToolPermissionManager.js';
import { ToolExecutor } from '../core/tools/ToolExecutor.js';
import { ToolOrchestrator } from '../core/tools/ToolOrchestrator.js';
import type { IToolOrchestrator } from '../core/tools/IToolOrchestrator.js';
import type { ITool } from '../core/tools/ITool.js';
import { ExtensionRegistry } from '../extensions/ExtensionRegistry.js';
import { EXTENSION_KIND_TOOL } from '../extensions/types.js';
import { APPROVAL_GRANTED, askApprovalGate, composeReceivedGate, type ApprovalGateFn } from './runtime/approval-gate.js';
import { runCitationVerification } from './runtime/citationVerification.js';
import { createCompletionGateway, type CompletionGateway } from './runtime/completionGateway.js';
import { GatewayProviderManager } from './runtime/gatewayProviderManager.js';
import {
  asSpendBudget,
  assertCallWithinBudget,
  bothBudgets,
  holdsInMeter,
  outputEstimateTokens,
  promptCharsOf,
  type HelperCall,
  type SpendBudget,
  type SpendBudgetOptions,
} from './runtime/spendBudget.js';
import { heldAttempt, refusedAttempt } from './runtime/heldAttempt.js';
import { lowerZodToJsonSchema } from '../orchestration/compiler/SchemaLowering.js';
import { adaptTools } from './runtime/toolAdapter.js';
import { withMembers } from './runtime/withMembers.js';
import { LAUNCH_AGENCY_TOOL_NAME, MIN_LAUNCH_TOKENS, resolveLaunchLimits, type AgencyLaunchFrame, type CallerTurnContext, type ToolCallHook } from './runtime/agencyLaunch/types.js';
import { createGmiLaunchTool } from './runtime/agencyLaunch/gmiLaunchTool.js';
import { resolveCognition, type ResolvedCognition } from './runtime/gmiCognition.js';
import { agentStableIdOf, personaFromAgentOptions, stablePersonaIdOf } from './runtime/gmiPersona.js';
import { memoryHookContextOf, namedSessionUser } from './runtime/memorySubject.js';
import { warnSoulBesideSystemBlocks, withOneSoulWarning } from './runtime/soulLoadWarning.js';
import { soulLog } from '../cognition/substrate/personas/soulLog.js';
import { soulAgentIdOf } from '../cognition/substrate/personas/SoulLoader.js';
import { modelNamesAnotherProvider } from './runtime/credentialOwner.js';
import {
  assertEmbeddingConfig,
  assertMemoryStore,
  createAgentCognitiveMemory,
  openAgentMemoryBrain,
  type AgentCognitiveMemory,
  type AgentMemoryBrain,
} from './runtime/agentCognitiveMemory.js';
import { sendGmiTurn, streamGmiTurn, TurnLock, type GmiForTurn, type GmiSessionDeps, type GmiTurnContext, type GmiTurnOptions } from './runtime/gmiSession.js';
import { resolveRecallOptions } from './runtime/recallOptions.js';
import { recallLog } from '../cognition/memory/retrieval/recall/log.js';
import { endSessionGeneration, readSessionGeneration, sessionGenerationKey, type SessionGeneration } from './runtime/sessionGenerations.js';
import { transcriptToConversation } from './runtime/gmiTranscript.js';
import { SessionHistoryBuffer, SESSION_HISTORY_DEFAULTS } from './sessionHistory.js';
import type { SessionTranscriptMessage } from './sessionTranscript.js';
import { accumulateUsage, createEmptyUsageAggregate, mergeAggregates } from './runtime/usageAccumulator.js';
import type { AgentOSUsageAggregate, AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';
import { exportAgentConfig, exportAgentConfigJSON } from './agentExportCore.js';
import { getDeferredCapabilities, isMeaningfullyConfigured } from './runtime/lightweightAgentDiagnostics.js';
import { resolveTurnMode } from '../cognition/learning/config.js';
import {
  adoptLearningMemory,
  createLearningLayer,
  learningAgentHasLearners,
  releaseLearningMemory,
  releaseLearningStore,
} from '../cognition/learning/LearningLayer.js';
import { deferLearnerSession } from '../cognition/learning/LearnerSession.js';
import { InMemoryLearningStore } from '../cognition/learning/store/InMemoryLearningStore.js';
import type { LearningStore } from '../cognition/learning/store/LearningStore.js';
import { SqlLearningStore } from '../cognition/learning/store/SqlLearningStore.js';
import type {
  FreezeScope,
  HostLoopName,
  ILearnerSession,
  LearnerContext,
  LearnerKey,
  LearningLayerHandle,
  LoopState,
} from '../cognition/learning/types.js';
import type { ICognitiveMemoryManager } from '../cognition/memory/CognitiveMemoryManager.js';
import { sharedForgottenLedgerOf } from '../cognition/memory/suppression/learnerTombstones.js';
import { normalizeHexacoTraits } from '../cognition/substrate/personas/hexaco.js';

/** The options of {@link gmi}: the options of `agent()`. */
export type GmiOptions = AgentOptions;
/** The handle {@link gmi} returns: the `Agent` surface. */
export type GmiHandle = Agent;

/** Options with no GMI-path implementation yet; set, they throw at construction. */
const UNSUPPORTED_ON_GMI = ['voice', 'avatar', 'channels'] as const;
/**
 * Per-call overrides generate() and stream() accept on the GMI path: the completion options, the route,
 * the step limit, the ledger, the call's stop, budget and usage account, and the tool-approval gate `agency()` passes
 * with every call to a member.
 */
const ALLOWED_CALL_OVERRIDES = new Set(['temperature', 'maxTokens', 'topP', 'responseFormat', 'model', 'provider', 'maxSteps', 'usageLedger', '__approvalGate', 'abortSignal', 'budget', 'accountIdOf']);
/** Per-call overrides that pick the route, the step limit, the ledger, the stop, the budget, the usage account or the gate rather than a completion option. */
const ROUTE_OVERRIDES = new Set(['model', 'provider', 'maxSteps', 'usageLedger', '__approvalGate', 'abortSignal', 'budget', 'accountIdOf']);
/** `agent()`'s step limit. */
const DEFAULT_MAX_STEPS = 5;

const GMI_PROMPT_ENGINE_CONFIG: PromptEngineConfig = {
  defaultTemplateName: 'openai_chat',
  availableTemplates: {},
  tokenCounting: { strategy: 'estimated', estimationModel: 'gpt-3.5-turbo' },
  // Truncation only: no utility AI is passed, and no summary is made by a model call.
  historyManagement: { defaultMaxMessages: 100_000, maxTokensForHistory: 120_000, summarizationTriggerRatio: 0, preserveImportantMessages: true },
  contextManagement: { maxRAGContextTokens: 1500, summarizationQualityTier: 'balanced', preserveSourceAttributionInSummary: true },
  contextualElementSelection: { maxElementsPerType: {}, defaultMaxElementsPerType: 3, priorityResolutionStrategy: 'highest_first', conflictResolutionStrategy: 'skip_conflicting' },
  performance: { enableCaching: false, cacheTimeoutSeconds: 60 },
} as PromptEngineConfig;

/**
 * A memoised async build that is not kept when it fails: the next call after a
 * rejection builds again, so one transient failure does not fail every later
 * call.
 */
function retryingOnce<T>(build: () => Promise<T>): { get(): Promise<T>; peek(): Promise<T> | undefined } {
  let pending: Promise<T> | undefined;
  return {
    get() {
      if (!pending) {
        const attempt = build();
        pending = attempt;
        attempt.catch(() => {
          if (pending === attempt) pending = undefined;
        });
      }
      return pending;
    },
    peek: () => pending,
  };
}

/**
 * `messages` with `text` first in the system prompt: before the first system
 * message's content, joined by a blank line, or as a system message of its
 * own when the prompt has none.
 */
function withLeadingSystemText(messages: ChatMessage[], text: string): ChatMessage[] {
  const first = messages[0];
  if (first?.role !== 'system') return [{ role: 'system', content: text }, ...messages];
  const content = first.content;
  if (typeof content === 'string') return [{ ...first, content: content ? `${text}\n\n${content}` : text }, ...messages.slice(1)];
  if (Array.isArray(content)) return [{ ...first, content: [{ type: 'text', text }, ...content] }, ...messages.slice(1)];
  return [{ ...first, content: text }, ...messages.slice(1)];
}

/**
 * A tool registry that leaves out the tools ToolExecutor registers from its own
 * constructor (the built-in getCurrentDateTime), so a tool-less agent offers the
 * model no tools and an agent tool of the same name is the only one.
 * The constructor starts that registration without waiting for it, so skipping
 * it here needs no wait for it before the agent's tools register.
 */
class AgentToolRegistry extends ExtensionRegistry<ITool> {
  /** False while the executor's constructor registers its built-ins. */
  acceptsRegistrations = false;

  override async register(...args: Parameters<ExtensionRegistry<ITool>['register']>): Promise<void> {
    if (!this.acceptsRegistrations) return;
    return super.register(...args);
  }
}

function toolExecutorWithoutBuiltIns(): ToolExecutor {
  const registry = new AgentToolRegistry(EXTENSION_KIND_TOOL);
  const executor = new ToolExecutor(undefined, undefined, registry);
  registry.acceptsRegistrations = true;
  return executor;
}

/** A call answered without running its tool: the model is told why. */
function skippedCall(req: ToolCallRequest, reason: string): ToolCallResult {
  return { toolCallId: req.id, toolName: req.name, output: { skipped: true, reason }, isError: true, errorDetails: { message: `Skipped: ${reason}` } };
}

/**
 * Every GMI's tool orchestrator: the shared one, seen through the turn that runs (read with `turnOf()`, since a
 * session's GMI is built once and serves many turns). A seat's turn lists only its tool names and answers a call to any
 * other with `{ skipped: true, reason: 'not available in this seat' }` before any hook runs. The hooks the turn carries
 * (a launching turn's) run before the agent's own `onBeforeToolExecution`, outermost first: `null` from any skips the
 * tool, returned arguments replace the call's, and a hook that throws, or resolves with no result to read arguments
 * from, is warned about and the call goes on with the arguments it had. The turn's approval gate, else the one the GMI
 * was built with, is then asked about a tool the orchestrator has, with the arguments the hooks left; anything but the
 * exact approval skips the tool, and the model is told why. Every call passed on carries `callerTurn`: the gate, the
 * budget, the explicit user, the names, the hooks (the carried ones, then the agent's) and this view's own
 * `processToolCall`, through which the step gate runs each step of a composed tool. It carries the turn's stop too: once
 * the turn has stopped, a call runs no further hook and asks no gate, so no one is asked about a call that cannot run,
 * and the orchestrator refuses it (`STEP_ABORTED`), as it refuses a call whose turn stopped while its approval was
 * pending; nothing runs either way. A seat's call keeps the session data the GMI gave it, the frozen copy of the seat's
 * frame (`sessionData.agencyLaunch`) among it, which a launch from that call nests under.
 */
function hookTools(
  base: IToolOrchestrator,
  hook: AgentOptions['onBeforeToolExecution'],
  step: { index: number },
  turnOf: () => GmiTurnContext,
  buildGate?: ApprovalGateFn,
): IToolOrchestrator {
  const visible = <T extends { name: string }>(tools: T[]): T[] => {
    const names = turnOf().toolNames;
    return names ? tools.filter((tool) => names.has(tool.name)) : tools;
  };
  const processToolCall: IToolOrchestrator['processToolCall'] = async (details) => {
    const turn = turnOf();
    const req = details.toolCallRequest;
    if (turn.toolNames && !turn.toolNames.has(req.name)) return skippedCall(req, 'not available in this seat');
    // The turn's stop, with the one the call carries: the GMI's own turn stop, or a composed tool's step's.
    const stop = turn.abortSignal;
    const signal = stop && details.signal ? AbortSignal.any([details.signal, stop]) : (stop ?? details.signal);
    const hooks: ToolCallHook[] = [...(turn.toolHooks ?? []), ...(hook ? [hook] : [])];
    let args = (req.arguments ?? {}) as Record<string, unknown>;
    for (const run of hooks) {
      // Once the turn has stopped, no hook runs: the orchestrator refuses the call.
      if (signal?.aborted) break;
      try {
        const hookResult = await run({ name: req.name, args, id: req.id, step: step.index });
        if (hookResult === null) {
          return { toolCallId: req.id, toolName: req.name, output: { skipped: true }, isError: true, errorDetails: { message: 'Skipped by onBeforeToolExecution hook' } };
        }
        args = hookResult.args;
      } catch (hookError) {
        console.warn('[agentos] onBeforeToolExecution hook error:', hookError);
      }
    }
    const gate = turn.approvalGate ?? buildGate;
    // A tool the orchestrator does not have is reported by it without asking anyone, and so is a call whose turn has
    // stopped: the orchestrator refuses it (STEP_ABORTED).
    if (gate && (await base.getTool(req.name)) && !signal?.aborted) {
      const verdict = await askApprovalGate(gate, { name: req.name, args: args ?? {}, id: req.id, step: step.index });
      if (verdict !== APPROVAL_GRANTED) return skippedCall(req, verdict.reason);
    }
    const callerTurn: CallerTurnContext = {
      ...(gate ? { approvalGate: gate } : {}),
      ...(turn.budget ? { budget: turn.budget } : {}),
      ...(turn.providerUserId !== undefined ? { providerUserId: turn.providerUserId } : {}),
      ...(turn.toolNames ? { toolNames: turn.toolNames } : {}),
      toolHooks: hooks,
      dispatch: processToolCall,
    };
    return base.processToolCall({
      ...details,
      toolCallRequest: { ...req, arguments: args },
      ...(signal ? { signal } : {}),
      callerTurn,
    });
  };
  return withMembers(base, {
    processToolCall,
    listAvailableTools: async (context?: Parameters<IToolOrchestrator['listAvailableTools']>[0]) => visible(await base.listAvailableTools(context)),
    ...(typeof base.listDiscoveredTools === 'function'
      ? {
          listDiscoveredTools: async (...args: Parameters<NonNullable<IToolOrchestrator['listDiscoveredTools']>>) =>
            visible(await base.listDiscoveredTools!(...args)),
        }
      : {}),
  });
}

/**
 * The agent's completion gateway. The GMI's route carries its own `onFallback`
 * (a trace entry), which replaces a gateway default, so the agent's
 * `onFallback` is called beside it, as `onFallback(error, provider)`; a
 * listener that throws is warned about and never fails the hop.
 */
function gatewayFor(opts: AgentOptions): CompletionGateway {
  const base = createCompletionGateway({
    // The agent's key and base URL are for its provider: a call that names
    // another provider (generate()'s and stream()'s `provider` and `model`)
    // runs on that provider's own credentials.
    providerId: opts.provider,
    modelId: opts.model,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    fallbackProviders: opts.fallbackProviders,
    policyTier: opts.policyTier,
    router: opts.router,
    routerParams: opts.routerParams,
    hostPolicy: opts.hostPolicy,
  });
  const listener = opts.onFallback;
  if (!listener) return base;
  return {
    stream: base.stream,
    schemaInstruction: base.schemaInstruction,
    resolve: (route, after, failure) =>
      base.resolve(
        {
          ...route,
          onFallback: (info) => {
            route.onFallback?.(info);
            try {
              listener(info.error, info.to);
            } catch (listenerError) {
              console.warn('[agentos] onFallback listener error:', listenerError);
            }
          },
        },
        after,
        failure,
      ),
  };
}

function mergeLedger(...parts: Array<AgentOSUsageLedgerOptions | undefined>): AgentOSUsageLedgerOptions | undefined {
  const merged: AgentOSUsageLedgerOptions = Object.assign({}, ...parts.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function recordedUsage(ledger: AgentOSUsageLedgerOptions | undefined, sessionId?: string): Promise<AgentOSUsageAggregate> {
  // Imported on use, as agent() imports it: the ledger reads files.
  const { getRecordedAgentOSUsage } = await import('./runtime/usageLedger.js');
  return getRecordedAgentOSUsage({ enabled: ledger?.enabled, path: ledger?.path, sessionId });
}

/** What every GMI of the agent shares, built on first use. */
interface Shared {
  /** The agent's persona: its cognition profile, its provider and model. */
  persona: IPersonaDefinition;
  /** The persona `generate()` and `stream()` run on: the light profile. */
  lightPersona: IPersonaDefinition;
  promptEngine: PromptEngine;
  utilityAI: StatisticalUtilityAI;
  tools: IToolOrchestrator;
}

/** One GMI and the hook that hands it each turn's prompt and memory context. */
interface BuiltGmi {
  gmi: IGMI;
  prepare(context: GmiTurnContext): void;
}

interface SessionEntry {
  session: AgentSession;
  userId: string;
  /** Closes the session as `close()` does, without ending its id's memory: `agent.close()` closes its sessions so. */
  shutdown(): Promise<void>;
}

/** A session's end of its id's generation, recorded once: `get()` records it (again after a failure), `peek()` is the attempt under way. */
interface GenerationEnd {
  get(): Promise<void>;
  peek(): Promise<void> | undefined;
}

/** The session options gmi() reads beside the public ones: `__seat`, set only by a seat (sessionSeat(), launch_agency). */
interface SeatSessionOptions extends AgentSessionOptions {
  /** The session's memory is scoped to itself and it has no learner. */
  __seat?: { memoryScope: 'session'; learner: 'none' };
}

/** The keys a seat puts on its session's sends (sessionSeat.ts), beside the public ones. */
interface SeatSendKeys {
  __approvalGate?: ApprovalGateFn;
  __toolNames?: ReadonlySet<string>;
  __toolHooks?: readonly ToolCallHook[];
  __launchFrame?: AgencyLaunchFrame;
  /** Receives the usage of the send's turn once it ends, failed or not, and any usage reported for it later. */
  __onUsage?: (usage: TokenUsage) => void;
}

/** A hook that skips every tool call: what hooks a send carries in a shape no hook can be read from become. */
const skipEveryCall: ToolCallHook = async () => null;

/**
 * A seat's tool names as its send carries them: a set (from any realm, so its string tag is read, and its `has` is
 * checked, since a tag alone proves nothing). Anything else present names no tool, so the turn lists and runs none, and
 * is warned about: a seat's names are its limit, and a turn must not run every tool for want of them.
 */
function receivedToolNames(value: unknown): ReadonlySet<string> {
  const isSet =
    value instanceof Set ||
    (typeof (value as { has?: unknown } | null)?.has === 'function' && Object.prototype.toString.call(value) === '[object Set]');
  if (isSet) return value as ReadonlySet<string>;
  console.warn("[agentos] gmi(): a send's __toolNames is not a Set; the turn lists and runs no tool.");
  return new Set<string>();
}

/**
 * A seat's carried hooks as its send carries them: a list of functions. Anything else present becomes one hook that
 * skips every call, and is warned about: the carried hooks may refuse a call, and a turn must not run it for want of
 * them.
 */
function receivedToolHooks(value: unknown): readonly ToolCallHook[] {
  if (Array.isArray(value) && value.every((hook) => typeof hook === 'function')) return value as ToolCallHook[];
  console.warn("[agentos] gmi(): a send's __toolHooks is not a list of functions; every tool call of the turn is skipped.");
  return [skipEveryCall];
}

/** The turn options a seat's send carries. */
function seatTurnOf(sendOpts: unknown): Pick<GmiTurnOptions, 'approvalGate' | 'toolNames' | 'toolHooks' | 'launchFrame'> {
  const keys = (sendOpts ?? {}) as SeatSendKeys;
  // A gate that is present but not a function refuses every tool, as a gate received from a parent agency does; names
  // and hooks in another shape fail closed the same way.
  const gate = composeReceivedGate(keys.__approvalGate);
  const frame = keys.__launchFrame;
  return {
    ...(gate ? { approvalGate: gate } : {}),
    ...(keys.__toolNames !== undefined ? { toolNames: receivedToolNames(keys.__toolNames) } : {}),
    ...(keys.__toolHooks !== undefined ? { toolHooks: receivedToolHooks(keys.__toolHooks) } : {}),
    // A launched team's seat: the frame its turn's calls carry, copied as the send gave it.
    ...(frame && typeof frame.launchId === 'string' && typeof frame.role === 'string' && typeof frame.depth === 'number'
      ? { launchFrame: { launchId: frame.launchId, role: frame.role, depth: frame.depth } }
      : {}),
  };
}

/** What a gmi() agent's options say about the loops its GMIs run, for the learning layer's manifest. */
function hostLoopsOf(cognition: ResolvedCognition): Partial<Record<HostLoopName, LoopState>> {
  const off = (detail: string): LoopState => ({ live: false, detail });
  const memory = Boolean(cognition.memory);
  const store = cognition.memory ? cognition.memory.store : undefined;
  // An empty preset list expands to no metaprompt, so none runs.
  const metaprompts = cognition.metaprompts === 'all' || (Array.isArray(cognition.metaprompts) && cognition.metaprompts.length > 0);
  return {
    memory: memory ? { live: true } : off('memory is off'),
    memory_mechanisms: cognition.mechanisms ? { live: true } : off(memory ? 'the mechanisms are off' : 'memory is off'),
    memory_observer_reflector: off('gmi() builds memory without an observer or a reflector'),
    memory_store: !memory
      ? off('memory is off')
      : store
        ? { live: true, detail: 'path' in store ? 'a SQLite file (memory.store.path)' : "the host's storage adapter (memory.store.adapter)" }
        : off('memory lives in process memory'),
    sentiment: cognition.sentiment ? { live: true } : off('sentiment tracking is off'),
    metaprompts: metaprompts ? { live: true } : off('no metaprompt preset'),
    emergent_tools: off('gmi() builds no emergent engine'),
    self_improvement_tools: off('gmi() registers no self-improvement tool'),
    forged_code_executor: off('gmi() builds no emergent engine'),
    hitl: off('gmi() applies no hitl setting'),
    tool_policy: off("the tool-policy switch runs in the full runtime's turn pipeline"),
    rag: off('gmi() applies no rag setting'),
  };
}

/**
 * The learning host calls of a `gmi()` agent: the layer's, with the agent's key and namespace filled in. A call that
 * names a user needs the agent's key. A freeze or a suspension with no user covers the agent: by its key, or, for an
 * agent with none, everything its layer serves, since such an agent has no durable store and its store is its own.
 * Each member is `async`, so a key it lacks rejects the call rather than throwing at it.
 *
 * @param agent - The agent's key, resolved at each call as the agent's sessions resolve their learners' key, and its
 *   namespace.
 * @param beforeForget - Runs before `forgetUser`: with `memory.store`, it hands the layer the agent's memory.
 * @param running - Holds each call until it settles: `agent.close()` lets the calls already running finish before it
 *   closes the memory and the Brain they run on.
 */
function learningHostCalls(
  layer: LearningLayerHandle,
  agent: { agentKey: () => Promise<string | undefined>; namespace: string },
  beforeForget?: () => Promise<void>,
  running?: Set<Promise<unknown>>,
): AgentLearning {
  const learnerOf = async (userId: string, call: string): Promise<LearnerKey> => {
    const agentKey = await agent.agentKey();
    if (!agentKey) {
      throw new Error(`gmi(): agent.learning.${call} names a learner, and this agent has no stable key: set learning.agentKey or give the agent a name.`);
    }
    return { namespace: agent.namespace, agentKey, userId };
  };
  const scopeOf = async (target: { userId?: string } | undefined, call: string): Promise<FreezeScope> => {
    if (target?.userId !== undefined) return { learner: await learnerOf(target.userId, call) };
    const agentKey = await agent.agentKey();
    return agentKey ? { agentKey } : { scope: 'all' };
  };
  const calls: AgentLearning = {
    manifest: () => layer.manifest(),
    freeze: async (target, by) => layer.freeze(await scopeOf(target, 'freeze'), by),
    unfreeze: async (target) => layer.unfreeze(await scopeOf(target, 'unfreeze')),
    suspend: async (target, by) => layer.suspend(await scopeOf(target, 'suspend'), by),
    unsuspend: async (target) => layer.unsuspend(await scopeOf(target, 'unsuspend')),
    operatorSet: async ({ userId, traits, by, note }) =>
      layer.operatorSet({ learner: await learnerOf(userId, 'operatorSet'), traits, by, ...(note !== undefined ? { note } : {}) }),
    revert: async (ledgerId, by) => layer.revert(ledgerId, by),
    exportLearnedState: async (userId) => layer.exportLearnedState(await learnerOf(userId, 'exportLearnedState')),
    importLearnedState: async (doc, target) =>
      layer.importLearnedState(doc, target ? await learnerOf(target.userId, 'importLearnedState') : undefined),
    forgetUser: async (userId) => {
      await beforeForget?.();
      return layer.forgetUser(userId, { namespace: agent.namespace });
    },
  };
  if (!running) return calls;
  const held: Record<string, unknown> = {};
  for (const [name, call] of Object.entries(calls) as Array<[string, (...args: unknown[]) => Promise<unknown>]>) {
    held[name] = (...args: unknown[]): Promise<unknown> => {
      const run = call(...args);
      running.add(run);
      void run.then(
        () => running.delete(run),
        () => running.delete(run),
      );
      return run;
    };
  }
  return held as unknown as AgentLearning;
}

/**
 * An agent whose sessions are GMIs (docs/GMI.md, "GMIs from agent()").
 *
 * @param opts - The options of `agent()`. `voice`, `avatar` and `channels` throw when set;
 *   a config that sets only `enabled: false` is unset. `budget` checks every completion call a GMI makes, a seat's
 *   turn's beside the budget its team's call carries (docs/GMI.md, "Spend budget").
 * @returns The `Agent` surface: `generate`, `stream`, `session`, `usage`, `close`, `export`.
 * @throws {Error} At construction, naming the option: an option the GMI path
 *   cannot honour, an unknown cognition profile or metaprompt preset, a
 *   `learning` value of the wrong type or an unknown `learning.mode`, or a
 *   `memory.embedding` that names a provider without embeddings, a model that
 *   does not resolve, or a dimension that is not a positive integer or not known.
 *   No environment is read here: the provider and model resolve on the first
 *   call, which rejects with the error `agent()` gives when nothing resolves.
 * @throws {RangeError} At construction, naming the field: an `agencies` bound
 *   outside its range, or an `agencies.members` value that is not a gmi() agent.
 * @throws {AgencyConfigError} At construction: `agencies.hitl` approvals with no handler.
 * @throws {Error} At construction: `agencies.launch` beside a tool of its own named `launch_agency`.
 */
export function gmi(opts: GmiOptions): GmiHandle {
  for (const key of UNSUPPORTED_ON_GMI) {
    // Counted as agent() counts a deferred option: a config that sets only `enabled: false` is unset.
    if (isMeaningfullyConfigured((opts as unknown as Record<string, unknown>)[key])) {
      throw new Error(`gmi(): '${key}' is not available on the GMI path; remove it or use runtime: 'legacy'.`);
    }
  }
  const deferred = getDeferredCapabilities(opts, 'gmi');
  if (deferred.length > 0) {
    console.warn(`[AgentOS] gmi() accepted config it does not enforce yet: ${deferred.join(', ')}.`);
  }
  warnSoulBesideSystemBlocks(opts);
  // Loaded once, at build: a soul that fails to load throws here unless it is optional.
  const soul = opts.soul ? loadSoulFromOption(opts.soul) : null;
  // gmi() refuses the voice and avatar options, so a front matter that sets them is named and left out.
  for (const field of ['voice', 'avatar'] as const) {
    if (soul?.frontmatter[field]) soulLog.warn('soul.field_ignored', { field });
  }
  const cognition = resolveCognition(opts);
  const agentRecall = typeof opts.memory === 'object' && opts.memory !== null ? opts.memory.recall : undefined;
  // Cognitive memory runs when the resolved memory config is set (an object); every check below reads it that way.
  const cognitiveMemoryOn = Boolean(cognition.memory);
  // memory.recall: with cognitive memory on it goes to the memory manager (through the persona and
  // createAgentCognitiveMemory); with memory off its budget is the memory provider's tokenBudget, as on the default
  // runtime. Checked before anything is built.
  const resolvedRecall = resolveRecallOptions({
    recall: cognition.memory ? cognition.memory.recall : agentRecall,
    cognitiveMemory: cognitiveMemoryOn,
    providerTokenBudget: opts.memoryProviderOptions?.tokenBudget,
    providerContext: Boolean(opts.memoryProvider?.getContext),
    where: 'gmi()',
  });
  for (const option of resolvedRecall.ignored) recallLog.warn('memory.recall.option_ignored', { option });
  // A `cognition.memory` of its own replaces the agent's `memory` option for cognitive memory, its `recall` included:
  // a `memory.recall` set beside it is applied nowhere, and says so.
  if (cognition.memory && cognition.memory !== opts.memory && agentRecall != null) {
    recallLog.warn('memory.recall.option_ignored', { option: 'memory_recall' });
  }
  // generate() and stream() run the light profile, under the agent's own learning option.
  const lightCognition = resolveCognition({ cognition: 'light', learning: opts.learning });
  const learningConfig = typeof opts.learning === 'object' && opts.learning !== null ? opts.learning : undefined;
  /** The soul's one stable id; undefined with no soul, or a soul that gives none on an agent with no name. */
  const soulId = soul ? soulAgentIdOf(soul.frontmatter, opts.name) : undefined;
  // The agent's stable id, which the memory hooks are told: its soul's id, else a named agent's id.
  const agentStableId = agentStableIdOf(opts, soul);
  /** The key of the brain behind memory.store: `learning.agentKey`, else the soul's id. */
  const brainKey = learningConfig?.agentKey?.trim() || soulId;
  const memoryStore = cognition.memory ? cognition.memory.store : undefined;
  // A durable store needs the learning flag and a key that names its brain: learning.agentKey, or the soul's id.
  if (memoryStore !== undefined) assertMemoryStore(memoryStore, cognition.learning !== undefined, brainKey, soul !== null);
  if (cognition.learning && learningConfig?.store?.kind === 'sql' && !learningConfig.agentKey?.trim()) {
    throw new Error(
      "gmi(): a SQL learning.store needs learning.agentKey, the stable id of the agent's learners; two agents on one store would otherwise be one agent to the learning layer.",
    );
  }
  /**
   * The Brain behind `memory.store`, which holds the agent's memory and its learning store. A file's Brain is one per
   * memory generation: `agent.close()` closes it, and the next use opens the file again. A host's adapter keeps one
   * Brain for the agent's life, never closed.
   */
  const openStoreBrain = () => retryingOnce<AgentMemoryBrain>(() => openAgentMemoryBrain(memoryStore!, brainKey!));
  let storeBrain = memoryStore ? openStoreBrain() : undefined;
  /** The host calls of `agent.learning` still running: `agent.close()` lets them finish before it closes what they use. */
  const runningHostCalls = new Set<Promise<unknown>>();
  /** The in-process learning store of a `memory.store` whose adapter has no transactions: one for the agent's life. */
  let inProcessStore: InMemoryLearningStore | undefined;
  // One learning layer for the agent, only when its `learning` option is on. With it off nothing below builds or
  // passes anything of the layer, and the agent runs as it did before the layer existed.
  // A souled agent hands the ledger of its memory store to the layer by the options object it was built from.
  const forgotten = sharedForgottenLedgerOf(opts);
  const layer: LearningLayerHandle | undefined = cognition.learning
    ? createLearningLayer({
        ...(learningConfig ?? {}),
        profile: cognition.profile,
        surface: 'gmi',
        hostLoops: hostLoopsOf(cognition),
        ...(forgotten ? { forgotten } : {}),
        // With memory.store, the learning store runs on the adapter of its Brain, opened on first use; a store passed
        // as learning.store wins.
        ...(memoryStore
          ? {
              openStore: async (): Promise<LearningStore> => {
                const { brain } = await storeBrain!.get();
                if (brain.adapter.capabilities?.has?.('transactions')) return new SqlLearningStore({ adapter: brain.adapter });
                // A change and its ledger row must commit together, which an adapter without transactions cannot do.
                return (inProcessStore ??= new InMemoryLearningStore());
              },
            }
          : {}),
      })
    : undefined;
  /**
   * The key the agent's learners are filed under when `learning.agentKey` is unset (the layer lets that one win):
   * `learning.learnerKey`; else the soul's id, unless the learning store holds learner rows under the slug of the
   * agent's name and none under the soul's id, which keeps the slug and says so once; else the slug of the name, or
   * none for an agent with no name. Resolved at first use, since the store opens then. A store that does not open
   * rejects the lookup rather than reading as holding no learners, so the next open asks again.
   */
  const learnersKey = retryingOnce<string>(async () => {
    const chosen = learningConfig?.learnerKey?.trim();
    if (chosen) return chosen;
    const oldSlug = stablePersonaIdOf(opts);
    if (!soulId) return oldSlug ?? '';
    if (!layer || !oldSlug || oldSlug === soulId) return soulId;
    const namespace = learningConfig?.namespace ?? '';
    const [underSlug, underSoulId] = await Promise.all([
      learningAgentHasLearners(layer, namespace, oldSlug),
      learningAgentHasLearners(layer, namespace, soulId),
    ]);
    if (!underSlug || underSoulId) return soulId;
    soulLog.warn('soul.id_fallback', { reason: 'old_slug_learner' });
    return oldSlug;
  });
  /** The traits the agent was given, by option or by its soul, as the layer and a GMI's own render read them. */
  const authoredTraits = normalizeHexacoTraits(opts.personality ?? soul?.frontmatter.hexaco);
  const hasTraits = Object.keys(authoredTraits).length > 0;
  if (cognition.memory) assertEmbeddingConfig(cognition.memory);
  if (cognition.memory && opts.memoryProvider?.getContext) {
    console.warn('[agentos] gmi(): cognitive memory supplies the memory context; memoryProvider.getContext is skipped (observe still runs).');
  }
  const ledger = mergeLedger((opts.observability?.usageLedger as AgentOSUsageLedgerOptions | undefined) ?? opts.usageLedger);
  // `agencies`: every bound is checked here, `launch` on or off.
  const launchLimits = opts.agencies ? resolveLaunchLimits(opts.agencies) : undefined;
  const tools: ITool[] = adaptTools(opts.tools);
  /**
   * The provider and model the agent's persona resolved in the shared build: those its options name, else the pair its
   * first call resolved from the environment. Its own launches route their coordinator and temporary seats on it, and a
   * launch that seats this agent as a member counts a call of that seat on it (`__route` on the handle).
   */
  const resolvedRoute = async (): Promise<{ provider?: string; model?: string }> => {
    const { persona } = await shared.get();
    return { provider: persona.defaultProviderId, model: persona.defaultModelId };
  };
  // With `agencies.launch`, launch_agency is one of the agent's tools: its persona lists it and its orchestrator runs it.
  if (launchLimits && opts.agencies?.launch === true) {
    if (tools.some((tool) => tool.name === LAUNCH_AGENCY_TOOL_NAME)) {
      throw new Error(`gmi(): agencies.launch registers '${LAUNCH_AGENCY_TOOL_NAME}', and the agent's tools already hold a tool of that name.`);
    }
    // A launch is refused budget_unavailable when its token cap cannot cover one call of the route: a maxLaunchTokens
    // below that refuses every launch, which the host hears of now rather than at the first launch.
    const oneCall = MIN_LAUNCH_TOKENS + outputEstimateTokens(opts.model ?? '', opts.maxTokens);
    if (launchLimits.maxLaunchTokens < oneCall) {
      console.warn(
        `[agentos] gmi(): agencies.maxLaunchTokens (${launchLimits.maxLaunchTokens}) cannot cover one call of this agent's route (${oneCall}: ${MIN_LAUNCH_TOKENS} for the prompt and ${oneCall - MIN_LAUNCH_TOKENS} for the output), so every launch is refused budget_unavailable.`,
      );
    }
    tools.push(
      createGmiLaunchTool({
        opts,
        limits: launchLimits,
        tools: () => tools,
        ledger,
        createAgent: gmi,
        // Every turn that can launch has built the shared build this pair comes from.
        route: resolvedRoute,
      }),
    );
  }
  // Put first in the system prompt of every call that offers tools, as generateText puts it.
  const chainOfThought = tools.length > 0 ? resolveChainOfThought(opts.chainOfThought ?? true) : undefined;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const gateway = gatewayFor(opts);
  // One budget for the agent, as agent() keeps one: every turn with no budget of its own is checked against it.
  const agentBudget: SpendBudget | undefined = asSpendBudget(opts.budget);

  const shared = retryingOnce<Shared>(async () => {
    // Throws, as generateText throws, when no provider or model resolves.
    // Both personas take the soul loaded at build.
    const [persona, lightPersona] = withOneSoulWarning(() => [
      personaFromAgentOptions(opts, cognition, tools, soul),
      personaFromAgentOptions(opts, lightCognition, tools, soul),
    ] as const);
    const promptEngine = new PromptEngine();
    await promptEngine.initialize(GMI_PROMPT_ENGINE_CONFIG);
    const utilityAI = new StatisticalUtilityAI(`gmi-utility-${persona.id}`);
    await utilityAI.initialize({ utilityId: `gmi-utility-${persona.id}` });
    const permissions = new ToolPermissionManager();
    await permissions.initialize({ strictCapabilityChecking: false, logToolCalls: false, toolToSubscriptionFeatures: {} });
    const orchestrator = new ToolOrchestrator();
    await orchestrator.initialize(
      { orchestratorId: `gmi-tools-${persona.id}`, defaultToolCallTimeoutMs: 30_000, maxConcurrentToolCalls: 10, logToolCalls: false, globalDisabledTools: [] },
      permissions,
      toolExecutorWithoutBuiltIns(),
      tools,
    );
    return { persona, lightPersona, promptEngine, utilityAI, tools: orchestrator };
  });

  /**
   * One cognitive memory for the sessions that use it, built on first use.
   * `close()` hands back the build it kept, if any; a build asked for after
   * that fails, so nothing builds a memory that no one will close.
   */
  const memoryForSessions = (brain: typeof storeBrain) => {
    let closed = false;
    const build = retryingOnce<AgentCognitiveMemory | undefined>(async () => {
      if (!cognition.memory) return undefined;
      if (closed) throw new Error('gmi(): the agent was closed; agent.session() opens a new session.');
      const { persona } = await shared.get();
      // With memory.store, the memory files into this generation's Brain; a store that does not open fails the build.
      const opened = brain ? await brain.get() : undefined;
      // Reads the environment for the embedding provider when memory.embedding names none.
      return createAgentCognitiveMemory({ persona, memory: cognition.memory, mechanisms: cognition.mechanisms, ...(opened ? { brain: opened.brain } : {}) });
    });
    return {
      get: build.get,
      close: (): Promise<AgentCognitiveMemory | undefined> | undefined => {
        closed = true;
        return build.peek();
      },
    };
  };
  // The memory of the sessions open now. agent.close() closes it once they
  // have finished, and the sessions opened after that share a new one.
  let memory = memoryForSessions(storeBrain);
  /**
   * With `memory.store`, hands the layer the memory the agent's sessions file into, built for the call when no session
   * has built it, so `forgetUser` reaches the store whether or not a session is open. A memory that does not build
   * fails the call, before the tombstone: a deletion that could not reach the store's traces is never reported done.
   */
  const memoryForForget = memoryStore
    ? async (): Promise<void> => {
        const built = await memory.get();
        if (built && layer) await adoptLearningMemory(layer, built.manager);
      }
    : undefined;

  /**
   * A learner session for one session or one call of the agent; `undefined` when learning is off. `sessionId` is the
   * session's memory scope id (a session opened again after `close()` has its own, and so does a seat session), so a
   * turn with no learner files where the session's memory does; `manager` is the memory the session files into, which
   * the layer hydrates for the learner and reaches in `forgetUser`. A session opened with a user id names a learner
   * (the layer still answers with none for a placeholder id, or for an agent with neither a name nor
   * `learning.agentKey`); a seat session, a session opened without one, `generate()` and `stream()` have none. A layer
   * that fails to open the session never fails the call: the GMI gets a session that asks again at each turn, and
   * until one opens each turn has no learner and the GMI renders the persona's traits itself.
   */
  async function learnerSessionFor(
    sessionId: string,
    personaId: string,
    userId: string | undefined,
    options: { noLearner?: boolean; manager?: ICognitiveMemoryManager } = {},
  ): Promise<ILearnerSession | undefined> {
    const active = layer;
    if (!active) return undefined;
    const { noLearner = false, manager } = options;
    // A seat session (sessionSeat(), launch_agency) has no learner: a team turn's input is a manager's or a sibling's
    // text. The manifest and the trace count its turns as a seat's, whatever user it runs as.
    const context: LearnerContext = {
      sessionId,
      personaId,
      authoredTraits,
      ...(noLearner ? { noLearnerReason: 'workflow_seat' as const } : {}),
      ...(manager ? { memory: manager } : {}),
    };
    // The learners' key: see `learnersKey`. It is read inside the open, so a store that cannot answer yet fails the open
    // as any other open fails, and the turn asks again.
    const open = async (): Promise<ILearnerSession> => {
      const learnerKey = userId === undefined || noLearner ? null : { namespace: '', agentKey: await learnersKey.get(), userId };
      return active.forLearner(learnerKey, context);
    };
    try {
      return await open();
    } catch (error) {
      console.warn("[agentos] gmi(): the learning layer gave the session no learner session; each turn asks again, and until one opens the turn has no learner and its GMI renders the persona's traits itself.", error);
      // Fail closed: the deferred session rejects while the layer cannot open one, so each such turn runs degraded
      // and tells its tools it has no learner; it names the turn's scope ids by the session's own form meanwhile.
      return deferLearnerSession({
        traits: authoredTraits,
        open,
        sessionId,
        personaId,
        defaultNamespace: learningConfig?.namespace ?? '',
        mode: () => resolveTurnMode(cognition.learning?.mode ?? 'on').mode,
      });
    }
  }

  /** Ends a learner session; a failure is warned about and never reaches the caller. */
  async function endLearnerSession(learner: ILearnerSession | undefined): Promise<void> {
    try {
      await learner?.endSession();
    } catch (error) {
      console.warn('[agentos] gmi(): ending the learner session failed:', error);
    }
  }

  async function buildGmi(id: string, persona: IPersonaDefinition, mem: AgentCognitiveMemory | undefined, steps: number, gate?: ApprovalGateFn, learner?: ILearnerSession): Promise<BuiltGmi> {
    const s = await shared.get();
    const step = { index: 0 };
    let turn: GmiTurnContext = { prompt: undefined, memoryContext: undefined };
    const instance = new GMI(id);
    const config: GMIBaseConfig = {
      workingMemory: new InMemoryWorkingMemory(),
      promptEngine: s.promptEngine,
      llmProviderManager: new GatewayProviderManager(() => turn.budget).asProviderManager(),
      utilityAI: s.utilityAI,
      toolOrchestrator: hookTools(s.tools, opts.onBeforeToolExecution, step, () => turn, gate),
      // The agent's memory as this GMI's session sees it: the shared store with a
      // working memory of its own, so one session's active context never lists
      // another's memories. `GMI.shutdown()` shuts down the memory it was given;
      // on the view that does nothing, and `agent.close()` closes the manager.
      ...(mem ? { cognitiveMemory: mem.manager.forSession() } : {}),
      // The agent's traits, which the GMI renders itself: with learning on, on a turn its learner session does not
      // prepare; with learning off, on every turn, since the base prompt then holds no personality section.
      ...(layer
        ? { ...(learner ? { learning: learner } : {}), personaTraits: { authored: authoredTraits } }
        : hasTraits
          ? { personaTraits: { authored: authoredTraits } }
          : {}),
      // The usage a provider reports for a call after the call was stopped goes
      // to the turn that made the call, which meters and counts it.
      completionGateway: {
        resolve: gateway.resolve,
        stream: (resolution, messages, options, responseSchema, schemaName, schemaInPrompt) => {
          // The turn's budget is checked before every attempt; a refusal sends nothing. An attempt of a turn that has
          // stopped (a session's close() or the caller's signal during a tool round) is not checked: the gateway sends
          // nothing and ends it with the stop, and the budget hears of no refusal for a call that would not be sent.
          const budget = turn.budget;
          const onLateUsage = turn.onLateUsage;
          if (budget && !options.abortSignal?.aborted) {
            // The options the gateway sends for this hop: a fallback hop's overrides raise maxTokens by its headroom
            // (fallbackHopOverrides in generateText.ts), so the estimate counts that cap. A structured request goes
            // without the tool definitions, so they are not counted.
            const sent = { ...options, ...resolution.optionOverrides };
            const tools = responseSchema ? undefined : sent.tools;
            if (holdsInMeter(budget)) {
              // A budget with a spend meter holds the attempt from before its request until it ends. Its bound counts
              // what a structured request sends in place of the tools: the schema, as the payload carries it or as the
              // instructions the gateway adds to the system prompt.
              const instruction = responseSchema && !schemaInPrompt ? gateway.schemaInstruction?.(resolution, responseSchema, schemaName) : undefined;
              const call: HelperCall = {
                what: 'gmi.step',
                route: { providerId: resolution.providerId, modelId: resolution.modelId },
                messages: instruction ? [...messages, { role: 'system', content: instruction }] : messages,
                tools,
                maxTokens: sent.maxTokens,
                options: responseSchema ? { ...sent, responseFormat: lowerZodToJsonSchema(responseSchema) } : sent,
                onAttempt: options.onAttempt,
                abortSignal: options.abortSignal,
              };
              return heldAttempt(
                budget,
                call,
                (held, onLate) => gateway.stream(resolution, messages, { ...options, ...held }, responseSchema, schemaName, schemaInPrompt, onLate),
                onLateUsage,
              );
            }
            try {
              assertCallWithinBudget(budget, resolution, promptCharsOf(messages, undefined, tools), sent.maxTokens, 'gmi.step');
            } catch (refusal) {
              return refusedAttempt(refusal);
            }
          }
          return gateway.stream(resolution, messages, options, responseSchema, schemaName, schemaInPrompt, onLateUsage);
        },
        schemaInstruction: gateway.schemaInstruction,
      },
      maxToolLoopIterations: steps,
      defaultLlmProviderId: persona.defaultProviderId,
      defaultLlmModelId: persona.defaultModelId,
      // Every model call: the memoryProvider's recall as a data block before the turn's user message, then
      // onBeforeGeneration.
      beforeModelCall: async (ctx) => {
        step.index = ctx.stepIndex;
        turn.onModelCall?.({ providerId: ctx.providerId, modelId: ctx.modelId });
        let messages: ChatMessage[] = ctx.messages;
        let changed = false;
        // The GMI names the turn's user message after the turn's user, which on
        // this path is the session id unless the caller named one, and replays
        // it under that name on a tool step and for multimodal input. agent()
        // names no message, and OpenAI refuses a name with a space or a slash
        // in it (HTTP 400), so the name stays out of the request.
        if (messages.some((message) => message.role === 'user' && message.name !== undefined)) {
          messages = messages.map((message) => {
            if (message.role !== 'user' || message.name === undefined) return message;
            const { name: _name, ...unnamed } = message;
            return unnamed;
          });
          changed = true;
        }
        // The tools the call offers: none on a structured send's calls, and on
        // a seat's turn only the tools its tool names allow.
        const names = turn.toolNames;
        const offered = turn.structured ? [] : names ? tools.filter((tool) => names.has(tool.name)) : tools;
        // A call that offers no tool gets no chain-of-thought instruction, as
        // agent() sends none with a structured send's calls; every call that
        // offers tools gets it first in its system prompt.
        if (chainOfThought && offered.length > 0) {
          messages = withLeadingSystemText(messages, chainOfThought);
          changed = true;
        }
        if (turn.memoryContext) {
          // Recalled text is data in a user-role message right before the turn's own user message, never a system
          // message, so the persona's hard limits stay the last system text.
          let insertAt = messages.length;
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].role === 'user') {
              insertAt = i;
              break;
            }
          }
          messages = [...messages.slice(0, insertAt), { role: 'user', content: turn.memoryContext }, ...messages.slice(insertAt)];
          changed = true;
        }
        if (opts.onBeforeGeneration) {
          try {
            const modified = await opts.onBeforeGeneration({
              messages: messages as unknown as Message[],
              // With learning on, the base prompt holds no personality section: the system text in `messages` holds
              // the turn's section after it.
              system: typeof persona.baseSystemPrompt === 'string' ? persona.baseSystemPrompt : undefined,
              tools: offered,
              model: ctx.modelId,
              provider: ctx.providerId,
              step: ctx.stepIndex,
              prompt: turn.prompt,
            });
            if (modified?.messages) {
              messages = modified.messages as unknown as ChatMessage[];
              changed = true;
            }
          } catch (hookError) {
            console.warn('[agentos] onBeforeGeneration hook error:', hookError);
          }
        }
        return changed ? messages : undefined;
      },
    };
    await instance.initialize(persona, config);
    return {
      gmi: instance,
      prepare: (context) => {
        turn = context;
      },
    };
  }

  /** A GMI for one turn only, shut down once the turn ends; a learner session made for that turn ends with it. */
  function forOneTurn(built: BuiltGmi, learner?: ILearnerSession): GmiForTurn {
    if (!learner) return { ...built, release: () => built.gmi.shutdown() };
    return {
      ...built,
      release: async () => {
        try {
          await built.gmi.shutdown();
        } finally {
          await endLearnerSession(learner);
        }
      },
    };
  }

  const sessions = new Map<string, SessionEntry>();
  const sessionTallies = new Map<string, AgentOSUsageAggregate>();
  /**
   * In process memory (no `memory.store`), the session ids opened since the
   * sessions' memory was built: an id opened again after its close() is given a
   * memory scope of its own. Only an agent with cognitive memory keeps them,
   * since only memory reads the scope, and it never keeps a seat session's id.
   * An id stays after session.close(), so that its next opening on this agent
   * does not reach the closed session's memory; agent.close() starts a new,
   * empty memory and empties the set. One entry per id, kept while the memory
   * keeps that session's traces. With `memory.store` the store keeps each id's
   * generation instead (runtime/sessionGenerations.ts), and nothing here.
   */
  const openedSessionIds = new Set<string>();
  /**
   * With `memory.store`, the ends `session.close()` asked the store to record, by the id's record key, until each is
   * recorded: the id's next opening on this agent records the end before it reads its generation, so a session opened
   * while a close is under way, or after one the store refused, never files under the closed generation. Kept across
   * `agent.close()`, which ends no session's memory: an end the store refused is tried again at the id's next opening.
   * `agent.close()` waits for the ends under way before it closes a file's Brain.
   */
  const unrecordedEnds = new Map<string, GenerationEnd>();
  const agentTally = createEmptyUsageAggregate();

  /** The per-call overrides as completion options; throws naming an override the GMI path does not take. */
  function overridesOf(extra?: Partial<GenerateTextOptions>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (v === undefined) continue;
      if (!ALLOWED_CALL_OVERRIDES.has(k)) throw new Error(`gmi(): the per-call option '${k}' is not supported on the GMI path.`);
      if (!ROUTE_OVERRIDES.has(k)) out[k] = v;
    }
    return out;
  }

  function oneShotDeps(source: 'agent.generate' | 'agent.stream', extra?: Partial<GenerateTextOptions>): GmiSessionDeps {
    const callId = `${source === 'agent.generate' ? 'generate' : 'stream'}-${randomUUID()}`;
    return {
      sessionId: callId,
      opts,
      userId: callId,
      useMemoryProviderContext: true,
      providerTokenBudget: resolvedRecall.providerTokenBudget,
      // A one-shot call is its own session and its own memory subject.
      memoryHook: memoryHookContextOf({ sessionId: callId, agentId: agentStableId, call: 'one-shot' }),
      history: null,
      ledger: mergeLedger(ledger, extra?.usageLedger, { source: extra?.usageLedger?.source ?? source }),
      onUsage: (u) => accumulateUsage(agentTally, u),
      lock: new TurnLock(),
      // generate() and stream() keep no history and run the light profile whatever the agent's.
      gmiFor: async () => {
        const s = await shared.get();
        // A call whose model's `provider:` prefix names another provider does not inherit the agent's.
        const callProvider =
          extra?.provider ??
          (extra?.model && opts.provider && modelNamesAnotherProvider(opts.provider, extra.model) ? undefined : opts.provider);
        const persona = extra && (extra.model || extra.provider)
          ? personaFromAgentOptions({ ...opts, model: extra.model ?? opts.model, provider: callProvider }, lightCognition, tools, soul)
          : s.lightPersona;
        // A call has no user of its own, so no learner; with learning on its GMI sends the personality section.
        const learner = await learnerSessionFor(callId, persona.id, undefined);
        try {
          return forOneTurn(await buildGmi(`gmi-${persona.id}-${callId}`, persona, undefined, extra?.maxSteps ?? maxSteps, extra?.__approvalGate, learner), learner);
        } catch (error) {
          // A GMI that was never built is never released, so the call's learner session ends here.
          await endLearnerSession(learner);
          throw error;
        }
      },
    };
  }

  /** What a generate() or stream() call hands its turn: its stop, its budget (a new one from settings) or the agent's, its usage account and its gate. */
  const callTurn = (extra?: Partial<GenerateTextOptions>): Pick<GmiTurnOptions, 'abortSignal' | 'callerSignal' | 'budget' | 'accountIdOf' | 'approvalGate'> => {
    const budget = asSpendBudget(extra?.budget) ?? agentBudget;
    return {
      // The call's signal is its only stop, and the caller's own.
      ...(extra?.abortSignal ? { abortSignal: extra.abortSignal, callerSignal: extra.abortSignal } : {}),
      ...(budget ? { budget } : {}),
      ...(extra?.accountIdOf ? { accountIdOf: extra.accountIdOf } : {}),
      ...(extra?.__approvalGate ? { approvalGate: extra.__approvalGate } : {}),
    };
  };

  const handle: Agent = {
    async generate(prompt: MessageContent, extra?: Partial<GenerateTextOptions>): Promise<GenerateTextResult> {
      const options = overridesOf(extra);
      const callerSignal = extra?.abortSignal;
      // A call whose signal has already aborted starts no turn, as a session's send does.
      callerSignal?.throwIfAborted();
      // A turn the caller's signal stopped rejects with its reason, as a session's send does, and a failure that came
      // before the stop keeps its own error: sendGmiTurn decides when the turn's failure is recorded.
      const result = await sendGmiTurn(oneShotDeps('agent.generate', extra), prompt, { options, ...callTurn(extra) });
      // A signal that aborted once the turn had ended rejects the call too, and no source is retrieved for it.
      callerSignal?.throwIfAborted();
      // As agent().generate() does: the answer checked against the sources retrieved for the input.
      if (opts.verifyCitations) {
        const userText = typeof prompt === 'string' ? prompt : extractTextFromContent(prompt);
        result.grounding = await runCitationVerification(result.text, userText, opts.verifyCitations);
      }
      return result;
    },

    stream(prompt: MessageContent, extra?: Partial<GenerateTextOptions>): StreamTextResult {
      const options = overridesOf(extra);
      // A signal that has already aborted starts no turn (streamGmiTurn): the stream ends at once with an error part
      // that carries the signal's reason.
      return streamGmiTurn(oneShotDeps('agent.stream', extra), prompt, { options, ...callTurn(extra) });
    },

    session(id?: string, sessionOptions?: AgentSessionOptions): AgentSession {
      const sessionId = id ?? randomUUID();
      const seat = (sessionOptions as SeatSessionOptions | undefined)?.__seat;
      const existing = sessions.get(sessionId);
      if (existing) {
        // A seat runs in a session of its own: one the agent serves already is never the seat's to run in or close.
        if (seat) throw new TypeError(`gmi(): session '${sessionId}' is open; a seat opens a session of its own`);
        // An anonymous id names no user, so it never asks for another one.
        const asked = namedSessionUser(sessionOptions?.userId, 'gmi', learningConfig?.anonymousUserIds);
        if (asked !== undefined && asked !== existing.userId) {
          throw new Error(`gmi(): session '${sessionId}' already runs as user '${existing.userId}'; close it to open it for another user.`);
        }
        return existing.session;
      }
      // The user the session's memory serves: the user id the caller named, unless it is an anonymous id, which names
      // no user. A seat names none: its memory is a scope of its own.
      const hookUser = seat ? undefined : namedSessionUser(sessionOptions?.userId, 'gmi', learningConfig?.anonymousUserIds);
      // Each session's memory scope is its own unless the caller names the user:
      // sessions are often different people, and one person's facts must not
      // reach another's replies. With memory.store a session id's memory
      // survives a restart, and agent.close(); session.close() ends it for good,
      // across restarts: the id's next opening, in this process or another, gets
      // a new scope id, recalls nothing the closed session filed, and shares
      // only a user id the caller names again. The store's Brain keeps the id's
      // generation (runtime/sessionGenerations.ts), which the session reads as
      // it opens and its close() moves on; an id no close has ended is at
      // generation 0, its plain id. In process memory the ending holds on this
      // agent, whose agent.close() starts an empty memory. A host hands an
      // anonymous id to a new person by closing the old session or minting a
      // new id.
      // A seat session's memory scope is its own, new at each opening: it recalls nothing of the user it runs as.
      const namespace = learningConfig?.namespace ?? '';
      const generationKey = memoryStore && !seat ? sessionGenerationKey(sessionId, namespace) : undefined;
      // An end of this id that an earlier session's close() asked for and the store has not recorded: recorded first.
      const endBefore = generationKey ? unrecordedEnds.get(generationKey) : undefined;
      const generation = generationKey
        ? retryingOnce<SessionGeneration>(async () => {
            // The Brain current as the attempt starts: the read made as the session opens uses the one agent.close()
            // closes, never one it opens after it.
            const current = storeBrain!;
            await endBefore?.get();
            const { brain } = await current.get();
            return readSessionGeneration(brain, sessionId, namespace);
          })
        : undefined;
      // Read as the session opens, so it holds the generation current then; a read that fails is made again by the
      // session's first turn, which fails naming the store while it cannot, and by its close().
      void generation?.get().catch(() => undefined);
      const inProcessScopeId = generation
        ? undefined
        : seat?.memoryScope === 'session' || openedSessionIds.has(sessionId)
          ? `${sessionId}:${randomUUID()}`
          : sessionId;
      // A seat session's id never enters the list agent.close() empties: a long-lived member does not grow by one id
      // per seat.
      if (cognition.memory && !seat && !generation) openedSessionIds.add(sessionId);
      /** The id the session's memory files and recalls under: its generation's, read from the store, or the one above. */
      const memoryScopeIdOf = async (): Promise<string> => (generation ? (await generation.get()).memoryScopeId : inProcessScopeId!);
      // The user the turns run as: the named user, else the session id. A seat runs as the user id it was given.
      const userId = seat ? (sessionOptions?.userId ?? sessionId) : (hookUser ?? sessionId);
      const history = opts.history === false ? null : new SessionHistoryBuffer({ ...SESSION_HISTORY_DEFAULTS, ...(opts.history ?? {}) });
      // A tally the agent's own earlier session of this id left is kept: a seat session adds to it and leaves it at close.
      const ownsTally = !sessionTallies.has(sessionId);
      if (ownsTally) sessionTallies.set(sessionId, createEmptyUsageAggregate(sessionId));
      const tally = sessionTallies.get(sessionId)!;
      const lock = new TurnLock();
      let closing: Promise<void> | undefined;
      // Every turn of the session runs under this signal; close() aborts it.
      const stopTurns = new AbortController();
      // The memory the agent's sessions shared when this one opened.
      const sessionMemory = memory;

      // The session's learner session, when learning is on: one for this agent.session() entry, built with its
      // first turn and ended by close(). A session that keeps no history builds a GMI per turn, and each gets it.
      // It is told the session's memory scope id and its memory, which the build of its first turn builds anyway.
      const learner = retryingOnce<ILearnerSession | undefined>(async () => {
        const { persona } = await shared.get();
        const memoryScopeId = await memoryScopeIdOf();
        const manager = (await sessionMemory.get())?.manager;
        return learnerSessionFor(memoryScopeId, persona.id, sessionOptions?.userId, { noLearner: seat?.learner === 'none', ...(manager ? { manager } : {}) });
      });
      const buildSessionGmi = async (gmiId: string): Promise<BuiltGmi> => {
        const { persona } = await shared.get();
        return buildGmi(gmiId, persona, await sessionMemory.get(), maxSteps, undefined, await learner.get());
      };
      // The session's own GMI, when it keeps history; a GMI per turn otherwise.
      const own = retryingOnce(async () => buildSessionGmi(`gmi-${await memoryScopeIdOf()}`));
      let ownBuilt: BuiltGmi | undefined;

      // Cognitive memory files the replies under the memory scope's session and
      // the user's messages under its user: the session's own scope, a new one
      // for an id opened again after close(). A seat session's user is its own
      // scope too, so nothing it is told is filed under the user it runs as.
      const turnMemoryScope = (memoryScopeId: string): { sessionId: string; userId: string } => ({
        sessionId: memoryScopeId,
        userId: seat?.memoryScope === 'session' ? memoryScopeId : (hookUser ?? memoryScopeId),
      });

      // A send made after close() fails; one made before it runs, and close() waits for it. The turn's memory scope
      // is read first: with memory.store, a store that does not open fails the turn before any model call.
      const gmiFor = (closedAtCall: boolean) => async (): Promise<GmiForTurn> => {
        if (closedAtCall) throw new Error(`gmi(): session '${sessionId}' is closed; agent.session('${sessionId}') opens a new one.`);
        const memoryScope = turnMemoryScope(await memoryScopeIdOf());
        if (!history) return { ...forOneTurn(await buildSessionGmi(`gmi-${memoryScope.sessionId}-${randomUUID()}`)), memoryScope };
        ownBuilt = await own.get();
        return { ...ownBuilt, memoryScope };
      };

      /** Brings the session GMI's own history in line with the store once the running turn ends, so a cleared fact never reaches its sentiment tracker or metaprompts. */
      const syncGmiHistory = (): void => {
        void lock
          .acquire()
          .then((release) => {
            try {
              ownBuilt?.gmi.replaceHistory?.(transcriptToConversation(history?.messages() ?? []));
            } finally {
              release();
            }
          })
          .catch((error: unknown) => console.warn('[agentos] gmi(): could not clear the session GMI history:', error));
      };

      const deps = (source: 'agent.session.send' | 'agent.session.stream', sendOpts?: unknown): GmiSessionDeps => ({
        // Tools, the user context and the reasoning trace see the id the caller
        // opened and the user id (that session id unless the caller named one).
        sessionId,
        opts,
        userId,
        // The turn's memory scope comes with its GMI (gmiFor), once the session has read it.
        // Only a user id the caller passed reaches the provider's end-user field, and never an anonymous one.
        providerUserId: seat ? sessionOptions?.userId : hookUser,
        history,
        lock,
        // A seat session records under its ledger's own source when it names one (a temporary seat's is launch_agency).
        ledger: mergeLedger(ledger, { sessionId, source: seat ? (ledger?.source ?? source) : source }),
        // A seat session's turn takes no context from the memory provider and files nothing with it.
        useMemoryProviderContext: !cognition.memory && !seat,
        providerTokenBudget: resolvedRecall.providerTokenBudget,
        observeMemoryProvider: !seat,
        // Who the turn's memory hooks are told it serves.
        memoryHook: memoryHookContextOf({ sessionId, namedUser: hookUser, agentId: agentStableId, call: 'session' }),
        gmiFor: gmiFor(closing !== undefined),
        onUsage: (u) => {
          accumulateUsage(tally, u);
          accumulateUsage(agentTally, u);
          // A seat's record of its calls, which a send's result does not carry when its turn fails.
          const toSeat = (sendOpts as SeatSendKeys | undefined)?.__onUsage;
          if (typeof toSeat === 'function') {
            try {
              toSeat({ ...u });
            } catch (error) {
              console.warn("[agentos] gmi(): a seat's usage hand-off failed:", error);
            }
          }
        },
      });

      // A turn runs under the session's stop and the caller's own signal, when it
      // passes one: either ends the turn, and only close() ends the session.
      const turnSignal = (callerSignal: AbortSignal | undefined): AbortSignal =>
        callerSignal ? AbortSignal.any([stopTurns.signal, callerSignal]) : stopTurns.signal;

      /**
       * A turn's budget: the one its send carries (settings make a new one) in place of the agent's. A seat's turn
       * (sessionSeat(), launch_agency) is held to the agent's own as well: each call is checked against both and charged
       * to both, a budget both draw on once, so a member's cap holds on the turns it serves in a team; a refusal by the
       * agent's own reaches the carried budget's `onLimitReached` function, as a launch's budget hears of it.
       */
      const turnBudget = (carried: SpendBudget | SpendBudgetOptions | undefined): SpendBudget | undefined => {
        const budget = asSpendBudget(carried);
        if (!budget) return agentBudget;
        return seat && agentBudget ? bothBudgets(budget, agentBudget) : budget;
      };

      /** Stops the running turn and shuts the session's GMI down, once; it ends no memory (see close()). */
      const shutdown = (): Promise<void> =>
        (closing ??= (async () => {
          if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
          // A seat session's tally goes with it: the agent's tally holds its usage (each turn adds to both). One the
          // agent's own earlier session of this id left stays.
          if (seat && ownsTally && sessionTallies.get(sessionId) === tally) sessionTallies.delete(sessionId);
          stopTurns.abort();
          const release = await lock.acquire();
          try {
            const built = await own.peek()?.catch(() => undefined);
            try {
              await built?.gmi.shutdown();
            } finally {
              await endLearnerSession(await learner.peek()?.catch(() => undefined));
            }
          } finally {
            release();
          }
        })());
      /**
       * With memory.store, ends the generation the session opened, once it is recorded: the id's next opening, in this
       * process or another, reads the next one. A failure is the close()'s error and is tried again by the next
       * close() and by the id's next opening on this agent.
       */
      const end: GenerationEnd | undefined = generation
        ? retryingOnce<void>(async () => {
            const current = storeBrain!;
            try {
              const opened = await generation.get();
              const { brain } = await current.get();
              await endSessionGeneration(brain, sessionId, namespace, opened);
            } catch (error) {
              throw Object.assign(
                new Error(
                  `gmi(): memory.store did not record that session '${sessionId}' ended (${error instanceof Error ? error.message : String(error)}); the id's next opening on this agent records it before its first turn, and close() tries again.`,
                ),
                { cause: error },
              );
            }
            if (unrecordedEnds.get(generationKey!) === end) unrecordedEnds.delete(generationKey!);
          })
        : undefined;
      let endRegistered = false;

      const session = {
        id: sessionId,
        send: async (input: MessageContent, sendOpts?: SessionSendOptions<GmiTurnOptions['responseSchema']>) => {
          const callerSignal = sendOpts?.abortSignal;
          // A send whose signal has already aborted starts no turn.
          callerSignal?.throwIfAborted();
          const options = Object.fromEntries(
            Object.entries({
              toolChoice: sendOpts?.toolChoice,
              requestTimeout: sendOpts?.requestTimeout,
              cacheDiagnostics: sendOpts?.cacheDiagnostics,
              cache: sendOpts?.cache,
              maxTokens: sendOpts?.maxTokens,
            }).filter(([, v]) => v !== undefined),
          );
          // A turn the caller's signal stopped rejects with its reason, as
          // agent()'s send does, and a failure that came before the stop keeps
          // its own error (sendGmiTurn decides when the turn's failure is
          // recorded); a turn that close() alone ended keeps the GMI's error.
          return sendGmiTurn(deps('agent.session.send', sendOpts), input, {
            options,
            responseSchema: sendOpts?.responseSchema,
            schemaName: sendOpts?.schemaName,
            blockLabel: sendOpts?.blockLabel,
            abortSignal: turnSignal(callerSignal),
            ...(callerSignal ? { callerSignal } : {}),
            budget: turnBudget(sendOpts?.budget),
            ...seatTurnOf(sendOpts),
          });
        },
        // As in send(), the turn takes the caller's budget and the gate, tool names and hooks a seat puts on its calls.
        stream: (input: MessageContent, streamOpts?: { abortSignal?: AbortSignal; budget?: SpendBudget | SpendBudgetOptions }) =>
          streamGmiTurn(deps('agent.session.stream', streamOpts), input, {
            abortSignal: turnSignal(streamOpts?.abortSignal),
            ...(streamOpts?.abortSignal ? { callerSignal: streamOpts.abortSignal } : {}),
            budget: turnBudget(streamOpts?.budget),
            ...seatTurnOf(streamOpts),
          }),
        messages: (): SessionTranscriptMessage[] => history?.messages() ?? [],
        reseed: (snapshot: SessionTranscriptMessage[]) => {
          if (!history) throw new Error('reseed requires session history (history: false is set on this agent)');
          history.reseed(snapshot);
          syncGmiHistory();
        },
        drainHistoryEvents: () => history?.drainHistoryEvents() ?? [],
        usage: async () => {
          const persisted = await recordedUsage(ledger, sessionId);
          return ledger?.enabled ? persisted : mergeAggregates(tally, persisted);
        },
        // An outside cost is charged to the agent's budget, as agent()'s session charges it; without one it does nothing.
        recordExternalCost: (costUSD: number, meta?: { kind?: string }) => agentBudget?.recordExternal(costUSD, meta?.kind ?? 'external'),
        clear: () => {
          history?.reseed([]);
          syncGmiHistory();
        },
        // A turn still running is stopped: its model call is aborted, its caller
        // gets the abort error, and the steps it finished stay in this session's
        // history, marked partial. Once it has ended, the session's GMI is shut
        // down. The next agent.session(id) builds a new session, which starts
        // empty. With memory.store, close() also records in the store that the
        // id's generation ended, and rejects when the store does not record it.
        close: async (): Promise<void> => {
          if (!end) return shutdown();
          // Registered before the session leaves the agent's list, so an opening of the id made while this closes, or
          // after the store refused the end, records it first.
          if (!endRegistered) {
            endRegistered = true;
            unrecordedEnds.set(generationKey!, end);
          }
          const [shut, ended] = await Promise.allSettled([shutdown(), end.get()]);
          if (shut.status === 'rejected') throw shut.reason;
          if (ended.status === 'rejected') throw ended.reason;
        },
      } as unknown as AgentSession;
      const entry: SessionEntry = { session, userId, shutdown };
      sessions.set(sessionId, entry);
      return session;
    },

    async usage(sessionId?: string): Promise<AgentOSUsageAggregate> {
      const persisted = await recordedUsage(ledger, sessionId);
      const inMemory = sessionId ? sessionTallies.get(sessionId) ?? createEmptyUsageAggregate(sessionId) : agentTally;
      return ledger?.enabled ? persisted : mergeAggregates(inMemory, persisted);
    },

    /**
     * Closes every session (each stops its running turn first, see
     * `session.close()`), then the cognitive memory they shared, including one
     * that a turn still setting up built while the sessions closed; a session
     * opened from now on builds a new one. It ends no session id's memory, as a
     * restart ends none: with `memory.store` an id opened again recalls what it
     * filed, and in process memory the new memory starts empty. A host call of
     * `agent.learning` already running finishes before the memory closes. With
     * `memory.store` on a file, the Brain is closed last, after the learning
     * store lets go of it and the ends a session's close() is recording finish;
     * the next session or host call opens the file again. A host's adapter is
     * never closed. The tools stay as the caller passed them: the orchestrator
     * is not shut down, because shutting it down would shut down the caller's
     * tools.
     */
    async close(): Promise<void> {
      const closingMemory = memory;
      const closingBrain = storeBrain;
      // A file's Brain is one per memory generation; a host's adapter keeps its Brain.
      if (memoryStore && 'path' in memoryStore) storeBrain = openStoreBrain();
      memory = memoryForSessions(storeBrain);
      // Together with the memory, so a session opened while this closes the others is recorded in the new one.
      openedSessionIds.clear();
      // Each session closes without ending its id's memory, which a restart keeps too.
      await Promise.all([...sessions.values()].map((entry) => entry.shutdown()));
      // An end a session's close() is recording finishes on the Brain it started on before that Brain closes.
      await Promise.allSettled([...unrecordedEnds.values()].map((end) => end.peek()));
      // A host call already running (a freeze, an operatorSet, a forgetUser) finishes on the memory and the Brain it
      // holds before they close; one that fails keeps its own error.
      await Promise.allSettled([...runningHostCalls]);
      const mem = await closingMemory.close()?.catch(() => undefined);
      try {
        await mem?.close();
      } finally {
        // The layer reaches the closed memory no more: a deletion asks the memory open now.
        if (mem && layer) releaseLearningMemory(layer, mem.manager);
      }
      if (closingBrain && closingBrain !== storeBrain) {
        // The learning store ran on this Brain: its next use opens it on the next generation's.
        if (layer) releaseLearningStore(layer);
        const opened = await closingBrain.peek()?.catch(() => undefined);
        await opened?.close();
      }
    },

    export(metadata, options) {
      return exportAgentConfig(handle, metadata, options);
    },
    exportJSON(metadata, options) {
      return exportAgentConfigJSON(handle, metadata, options);
    },
    getAvatarBindings() {
      return {} as ReturnType<Agent['getAvatarBindings']>;
    },
    setAvatarBindingOverrides() {
      // avatar is not available on the GMI path
    },
    // With learning on: the layer as the agent's host reads it and the operator's calls, with the agent's key and
    // namespace filled in. agent.close() ends every session's learner session as it closes the session, without ending
    // the session id's memory, and leaves the layer open, because the agent serves sessions opened after close().
    ...(layer ? { learning: learningHostCalls(
          layer,
          { agentKey: async () => learningConfig?.agentKey?.trim() || (await learnersKey.get()) || undefined, namespace: learningConfig?.namespace ?? '' },
          memoryForForget,
          runningHostCalls,
        ) } : {}),
  };
  Object.defineProperty(handle, '__config', { value: opts, enumerable: false, configurable: true });
  // The mark sessionSeat() and agencies.members read: this handle is a gmi() agent.
  Object.defineProperty(handle, '__gmiHandle', { value: true, enumerable: false, configurable: true });
  // The pair its persona resolved, which a launch seating this agent as a member counts its seat's calls on.
  Object.defineProperty(handle, '__route', { value: resolvedRoute, enumerable: false, configurable: true });
  return handle;
}

/** Alias of {@link gmi}. */
export const createGmi = gmi;
