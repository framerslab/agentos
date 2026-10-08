/**
 * @file gmi.ts
 * gmi(): an agent whose sessions are Generalized Mind Instances, built
 * in-process from agent options (spec D5-D12). `agent({ runtime: 'gmi' })`
 * returns the same handle.
 *
 * Construction checks what needs no environment: options the GMI path cannot
 * honour, the cognition profile, and the `memory.embedding` settings that name
 * their provider. The persona (with the provider and model it resolves), the
 * prompt engine, utility AI and tool orchestrator the sessions share, and the
 * cognitive memory are built on first use, so an agent made before its keys are
 * set resolves them on its first call; a build that fails is not kept, and the
 * next call builds again.
 */
import { randomUUID } from 'node:crypto';
import type { Agent, AgentOptions, AgentSession, AgentSessionOptions, SessionSendOptions } from './agent.js';
import type { GenerateTextOptions, GenerateTextResult, Message, MessageContent } from './generateText.js';
import type { StreamTextResult } from './streamText.js';
import { GMI } from '../cognition/substrate/GMI.js';
import type { GMIBaseConfig, IGMI } from '../cognition/substrate/IGMI.js';
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
import { createCompletionGateway, type CompletionGateway } from './runtime/completionGateway.js';
import { GatewayProviderManager } from './runtime/gatewayProviderManager.js';
import { adaptTools } from './runtime/toolAdapter.js';
import { resolveCognition } from './runtime/gmiCognition.js';
import { personaFromAgentOptions } from './runtime/gmiPersona.js';
import { assertEmbeddingConfig, createAgentCognitiveMemory, type AgentCognitiveMemory } from './runtime/agentCognitiveMemory.js';
import { sendGmiTurn, streamGmiTurn, TurnLock, type GmiForTurn, type GmiSessionDeps, type GmiTurnContext, type GmiTurnOptions } from './runtime/gmiSession.js';
import { transcriptToConversation } from './runtime/gmiTranscript.js';
import { SessionHistoryBuffer, SESSION_HISTORY_DEFAULTS } from './sessionHistory.js';
import type { SessionTranscriptMessage } from './sessionTranscript.js';
import { accumulateUsage, createEmptyUsageAggregate, mergeAggregates } from './runtime/usageAccumulator.js';
import type { AgentOSUsageAggregate, AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';
import { exportAgentConfig, exportAgentConfigJSON } from './agentExportCore.js';
import { getDeferredCapabilities } from './runtime/lightweightAgentDiagnostics.js';

/** The options of {@link gmi}: the options of `agent()`. */
export type GmiOptions = AgentOptions;
/** The handle {@link gmi} returns: the `Agent` surface. */
export type GmiHandle = Agent;

/** Options with no GMI-path implementation yet; set, they throw at construction. */
const UNSUPPORTED_ON_GMI = ['voice', 'avatar', 'channels'] as const;
/** Per-call overrides generate() and stream() accept on the GMI path (spec D10). */
const ALLOWED_CALL_OVERRIDES = new Set(['temperature', 'maxTokens', 'topP', 'responseFormat', 'model', 'provider', 'maxSteps', 'usageLedger']);
/** Per-call overrides that pick the route, the step limit or the ledger rather than a completion option. */
const ROUTE_OVERRIDES = new Set(['model', 'provider', 'maxSteps', 'usageLedger']);
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

function isSet(value: unknown): boolean {
  if (value == null || value === false) return false;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/**
 * A memoised async build that is not kept when it fails: the next call after a
 * rejection builds again, so one transient failure does not fail every later
 * call. `reset()` drops a kept result.
 */
function retryingOnce<T>(build: () => Promise<T>): { get(): Promise<T>; peek(): Promise<T> | undefined; reset(): void } {
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
    reset() {
      pending = undefined;
    },
  };
}

/** `target` with some members replaced; every other method runs on `target` itself. */
function withMembers<T extends object>(target: T, members: Partial<Record<keyof T, unknown>>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (Object.prototype.hasOwnProperty.call(members, prop)) return (members as Record<PropertyKey, unknown>)[prop];
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(t) : value;
    },
  });
}

/**
 * A tool registry that leaves out the tools ToolExecutor registers from its own
 * constructor (the built-in getCurrentDateTime), so a tool-less agent offers the
 * model no tools (spec D4j) and an agent tool of the same name is the only one.
 * The constructor starts that registration without waiting for it; skipping it
 * here needs no wait, and no later registration can be overtaken by it.
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

/**
 * The agent's `onBeforeToolExecution` around the shared orchestrator, for one
 * GMI: `null` skips the tool as `generateText` skips it, returned arguments
 * replace the call's, and a hook that throws is warned about and the tool runs.
 */
function hookTools(base: IToolOrchestrator, hook: AgentOptions['onBeforeToolExecution'], step: { index: number }): IToolOrchestrator {
  if (!hook) return base;
  const processToolCall: IToolOrchestrator['processToolCall'] = async (details) => {
    const req = details.toolCallRequest;
    let info: Awaited<ReturnType<NonNullable<AgentOptions['onBeforeToolExecution']>>> = {
      name: req.name,
      args: (req.arguments ?? {}) as Record<string, unknown>,
      id: req.id,
      step: step.index,
    };
    try {
      info = await hook(info);
    } catch (hookError) {
      console.warn('[agentos] onBeforeToolExecution hook error:', hookError);
    }
    if (info === null) {
      return {
        toolCallId: req.id,
        toolName: req.name,
        output: { skipped: true },
        isError: true,
        errorDetails: { message: 'Skipped by onBeforeToolExecution hook' },
      };
    }
    return base.processToolCall({ ...details, toolCallRequest: { ...req, arguments: info.args } });
  };
  return withMembers(base, { processToolCall });
}

/**
 * The agent's completion gateway. The GMI's route carries its own `onFallback`
 * (a trace entry), which replaces a gateway default, so the agent's
 * `onFallback` is called beside it, as `onFallback(error, provider)`; a
 * listener that throws is warned about and never fails the hop.
 */
function gatewayFor(opts: AgentOptions): CompletionGateway {
  const base = createCompletionGateway({
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
    resolve: (route, after) =>
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
}

/**
 * An agent whose sessions are GMIs (docs/GMI.md, "GMIs from agent()").
 *
 * @param opts - The options of `agent()`. `voice`, `avatar` and `channels` throw.
 * @returns The `Agent` surface: `generate`, `stream`, `session`, `usage`, `close`, `export`.
 * @throws {Error} At construction, naming the option: an option the GMI path
 *   cannot honour, an unknown cognition profile or metaprompt preset, or a
 *   `memory.embedding` that names a provider without embeddings, a model that
 *   does not resolve, or a dimension that is not a positive integer or not known.
 *   No environment is read here: the provider and model resolve on the first
 *   call, which rejects with the error `agent()` gives when nothing resolves.
 */
export function gmi(opts: GmiOptions): GmiHandle {
  for (const key of UNSUPPORTED_ON_GMI) {
    if (isSet((opts as unknown as Record<string, unknown>)[key])) {
      throw new Error(`gmi(): '${key}' is not available on the GMI path; remove it or use runtime: 'legacy'.`);
    }
  }
  const deferred = getDeferredCapabilities(opts, 'gmi');
  if (deferred.length > 0) {
    console.warn(`[AgentOS] gmi() accepted config it does not enforce yet: ${deferred.join(', ')}.`);
  }
  const cognition = resolveCognition(opts);
  const lightCognition = resolveCognition({ cognition: 'light' });
  if (cognition.memory) assertEmbeddingConfig(cognition.memory);
  if (cognition.memory && opts.memoryProvider?.getContext) {
    console.warn('[agentos] gmi(): cognitive memory supplies the memory context; memoryProvider.getContext is skipped (observe still runs).');
  }
  const tools: ITool[] = adaptTools(opts.tools);
  const ledger = mergeLedger((opts.observability?.usageLedger as AgentOSUsageLedgerOptions | undefined) ?? opts.usageLedger);
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const gateway = gatewayFor(opts);

  const shared = retryingOnce<Shared>(async () => {
    // Throws, as generateText throws, when no provider or model resolves.
    const persona = personaFromAgentOptions(opts, cognition, tools);
    const lightPersona = personaFromAgentOptions(opts, lightCognition, tools);
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

  const memory = retryingOnce<AgentCognitiveMemory | undefined>(async () => {
    if (!cognition.memory) return undefined;
    const { persona } = await shared.get();
    // Reads the environment for the embedding provider when memory.embedding names none.
    return createAgentCognitiveMemory({ persona, memory: cognition.memory, mechanisms: cognition.mechanisms });
  });

  async function buildGmi(id: string, persona: IPersonaDefinition, mem: AgentCognitiveMemory | undefined, steps: number): Promise<BuiltGmi> {
    const s = await shared.get();
    const step = { index: 0 };
    let turn: GmiTurnContext = { prompt: undefined, memoryContext: undefined };
    const instance = new GMI(id);
    const config: GMIBaseConfig = {
      workingMemory: new InMemoryWorkingMemory(),
      promptEngine: s.promptEngine,
      llmProviderManager: new GatewayProviderManager().asProviderManager(),
      utilityAI: s.utilityAI,
      toolOrchestrator: hookTools(s.tools, opts.onBeforeToolExecution, step),
      // The agent's memory as this GMI's session sees it: the shared store with a
      // working memory of its own, so one session's active context never lists
      // another's memories. `GMI.shutdown()` shuts down the memory it was given;
      // on the view that does nothing, and `agent.close()` closes the manager.
      ...(mem ? { cognitiveMemory: mem.manager.forSession() } : {}),
      completionGateway: gateway,
      maxToolLoopIterations: steps,
      defaultLlmProviderId: persona.defaultProviderId,
      defaultLlmModelId: persona.defaultModelId,
      // Every model call: the memoryProvider block after the leading system
      // messages (where the legacy path puts it), then onBeforeGeneration.
      beforeModelCall: async (ctx) => {
        step.index = ctx.stepIndex;
        let messages: ChatMessage[] = ctx.messages;
        let changed = false;
        if (turn.memoryContext) {
          let insertAt = 0;
          while (insertAt < messages.length && messages[insertAt].role === 'system') insertAt += 1;
          messages = [...messages.slice(0, insertAt), { role: 'system', content: turn.memoryContext }, ...messages.slice(insertAt)];
          changed = true;
        }
        if (opts.onBeforeGeneration) {
          try {
            const modified = await opts.onBeforeGeneration({
              messages: messages as unknown as Message[],
              system: typeof persona.baseSystemPrompt === 'string' ? persona.baseSystemPrompt : undefined,
              tools,
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

  /** A GMI for one turn only, shut down once the turn ends. */
  function forOneTurn(built: BuiltGmi): GmiForTurn {
    return { ...built, release: () => built.gmi.shutdown() };
  }

  const sessions = new Map<string, SessionEntry>();
  const sessionTallies = new Map<string, AgentOSUsageAggregate>();
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
      history: null,
      ledger: mergeLedger(ledger, extra?.usageLedger, { source: extra?.usageLedger?.source ?? source }),
      onUsage: (u) => accumulateUsage(agentTally, u),
      lock: new TurnLock(),
      // generate() and stream() keep no history and run the light profile whatever the agent's (spec D10).
      gmiFor: async () => {
        const s = await shared.get();
        const persona = extra && (extra.model || extra.provider)
          ? personaFromAgentOptions({ ...opts, model: extra.model ?? opts.model, provider: extra.provider ?? opts.provider }, lightCognition, tools)
          : s.lightPersona;
        return forOneTurn(await buildGmi(`gmi-${persona.id}-${callId}`, persona, undefined, extra?.maxSteps ?? maxSteps));
      },
    };
  }

  const handle: Agent = {
    async generate(prompt: MessageContent, extra?: Partial<GenerateTextOptions>): Promise<GenerateTextResult> {
      const options = overridesOf(extra);
      return sendGmiTurn(oneShotDeps('agent.generate', extra), prompt, { options });
    },

    stream(prompt: MessageContent, extra?: Partial<GenerateTextOptions>): StreamTextResult {
      const options = overridesOf(extra);
      return streamGmiTurn(oneShotDeps('agent.stream', extra), prompt, { options });
    },

    session(id?: string, sessionOptions?: AgentSessionOptions): AgentSession {
      const sessionId = id ?? randomUUID();
      const existing = sessions.get(sessionId);
      if (existing) {
        if (sessionOptions?.userId !== undefined && sessionOptions.userId !== existing.userId) {
          throw new Error(`gmi(): session '${sessionId}' already runs as user '${existing.userId}'; close it to open it for another user.`);
        }
        return existing.session;
      }
      // Each session's memory scope is its own unless the caller names the user:
      // sessions are often different people, and one person's facts must not
      // reach another's replies.
      const userId = sessionOptions?.userId ?? sessionId;
      const history = opts.history === false ? null : new SessionHistoryBuffer({ ...SESSION_HISTORY_DEFAULTS, ...(opts.history ?? {}) });
      if (!sessionTallies.has(sessionId)) sessionTallies.set(sessionId, createEmptyUsageAggregate(sessionId));
      const tally = sessionTallies.get(sessionId)!;
      const lock = new TurnLock();
      let closing: Promise<void> | undefined;

      const buildSessionGmi = async (gmiId: string): Promise<BuiltGmi> => {
        const { persona } = await shared.get();
        return buildGmi(gmiId, persona, await memory.get(), maxSteps);
      };
      // The session's own GMI, when it keeps history; a GMI per turn otherwise.
      const own = retryingOnce(() => buildSessionGmi(`gmi-${sessionId}`));
      let ownBuilt: BuiltGmi | undefined;

      // A send made after close() fails; one made before it runs, and close() waits for it.
      const gmiFor = (closedAtCall: boolean) => async (): Promise<GmiForTurn> => {
        if (closedAtCall) throw new Error(`gmi(): session '${sessionId}' is closed; agent.session('${sessionId}') opens a new one.`);
        if (!history) return forOneTurn(await buildSessionGmi(`gmi-${sessionId}-${randomUUID()}`));
        ownBuilt = await own.get();
        return ownBuilt;
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

      const deps = (source: 'agent.session.send' | 'agent.session.stream'): GmiSessionDeps => ({
        sessionId,
        opts,
        userId,
        history,
        lock,
        ledger: mergeLedger(ledger, { sessionId, source }),
        useMemoryProviderContext: !cognition.memory,
        gmiFor: gmiFor(closing !== undefined),
        onUsage: (u) => {
          accumulateUsage(tally, u);
          accumulateUsage(agentTally, u);
        },
      });

      const session = {
        id: sessionId,
        send: (input: MessageContent, sendOpts?: SessionSendOptions<GmiTurnOptions['responseSchema']>) => {
          const options = Object.fromEntries(
            Object.entries({
              toolChoice: sendOpts?.toolChoice,
              requestTimeout: sendOpts?.requestTimeout,
              cacheDiagnostics: sendOpts?.cacheDiagnostics,
              cache: sendOpts?.cache,
              maxTokens: sendOpts?.maxTokens,
            }).filter(([, v]) => v !== undefined),
          );
          return sendGmiTurn(deps('agent.session.send'), input, {
            options,
            responseSchema: sendOpts?.responseSchema,
            schemaName: sendOpts?.schemaName,
            blockLabel: sendOpts?.blockLabel,
          });
        },
        stream: (input: MessageContent) => streamGmiTurn(deps('agent.session.stream'), input, {}),
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
        clear: () => {
          history?.reseed([]);
          syncGmiHistory();
        },
        // A turn still running ends first and is returned to its caller, but the
        // reseed keeps it out of the history; then the session's GMI is shut down.
        close: () =>
          (closing ??= (async () => {
            if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
            history?.reseed([]);
            const release = await lock.acquire();
            try {
              const built = await own.peek()?.catch(() => undefined);
              await built?.gmi.shutdown();
            } finally {
              release();
            }
          })()),
      } as unknown as AgentSession;
      const entry: SessionEntry = { session, userId };
      sessions.set(sessionId, entry);
      return session;
    },

    async usage(sessionId?: string): Promise<AgentOSUsageAggregate> {
      const persisted = await recordedUsage(ledger, sessionId);
      const inMemory = sessionId ? sessionTallies.get(sessionId) ?? createEmptyUsageAggregate(sessionId) : agentTally;
      return ledger?.enabled ? persisted : mergeAggregates(inMemory, persisted);
    },

    /**
     * Closes every session (each after its running turn), then the cognitive
     * memory; a session opened from now on builds a new one. The tools stay as
     * the caller passed them: the orchestrator is not shut down, because
     * shutting it down would shut down the caller's tools.
     */
    async close(): Promise<void> {
      const pending = memory.peek();
      memory.reset();
      await Promise.all([...sessions.values()].map(({ session }) => session.close()));
      const mem = await pending?.catch(() => undefined);
      await mem?.close();
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
  };
  Object.defineProperty(handle, '__config', { value: opts, enumerable: false, configurable: true });
  return handle;
}

/** Alias of {@link gmi}. */
export const createGmi = gmi;
