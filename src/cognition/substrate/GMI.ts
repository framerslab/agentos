/**
 * @fileoverview Implements the Generalized Mind Instance (GMI), the core cognitive
 * engine of the AgentOS platform. This version integrates concrete IUtilityAI methods
 * for tasks like JSON parsing in self-reflection and summarization for RAG ingestion,
 * alongside its full suite of capabilities including tool orchestration, RAG interaction,
 * and adaptive state management.
 *
 * @module backend/agentos/cognitive_substrate/GMI
 * @see ./IGMI.ts for the interface definition.
 * @see ./personas/IPersonaDefinition.ts for persona structure.
 * @see ../core/tools/IToolOrchestrator.ts for tool orchestration.
 * @see ../nlp/ai_utilities/IUtilityAI.ts for utility functions.
 */

import { uuidv4 } from '../../core/utils/uuid';
import {
  IGMI,
  GMIBaseConfig,
  GMITurnInput,
  GMIOutputChunk,
  GMIOutputChunkType,
  GMIPrimeState,
  GMIMood,
  UserContext,
  TaskContext,
  ReasoningTrace,
  ReasoningTraceEntry,
  ReasoningEntryType,
  GMIHealthReport,
  MemoryLifecycleEvent,
  LifecycleActionResponse,
  LifecycleAction,
  GMIInteractionType,
  ToolCallRequest,
  ToolCallResult,
  ToolResultPayload,
  GMIOutput,
  CostAggregator,
  UICommand, // Assuming UICommand is used internally if GMI constructs them
  // AudioOutputConfig, ImageOutputConfig are part of GMIOutput
} from './IGMI';
import type { StepFinishedChunkPayload, ToolResultChunkPayload } from './IGMI';
import {
  IPersonaDefinition,
  PersonaRagConfigIngestionTrigger, // Ensure this type definition exists and is correctly imported
} from './personas/IPersonaDefinition';
import { hardLimitsBlock, HARD_LIMITS_PRIORITY } from './personas/hardLimits';
import { IWorkingMemory } from './memory/IWorkingMemory';
import { IPromptEngine, PromptExecutionContext, PromptComponents, PromptEngineResult, ModelTargetInfo } from '../../core/llm/IPromptEngine';
import { IRetrievalAugmentor, RagRetrievalOptions, RagDocumentInput, RagIngestionOptions, RagMemoryCategory } from '../rag/IRetrievalAugmentor';

import { ChatMessage, ModelCompletionOptions, ModelCompletionResponse, ModelUsage, ThinkingBlock } from '../../core/llm/providers/IProvider';
import type { ZodType } from 'zod';
import type { CompletionAttempt, CompletionOutcome, CompletionResolution, CompletionRoute } from '../../api/runtime/completionGateway.js';
import { checkStructuredReply, resolveStructuredReply, structuredRepairMessage, StructuredReplyConfigError, type StructuredReplyOutput } from '../../api/runtime/structuredReply.js';

import { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager';
import { IUtilityAI, SummarizationOptions } from '../nlp/ai_utilities/IUtilityAI';

import { IToolOrchestrator } from '../../core/tools/IToolOrchestrator';

import { ToolExecutionRequestDetails } from '../../core/tools/ToolExecutor';
import { ConversationMessage } from '../../core/conversation/ConversationMessage';
import { GMIError, GMIErrorCode, createGMIErrorFromError } from '../../core/utils/errors.js';
import type { ICognitiveMemoryManager } from '../memory/CognitiveMemoryManager.js';
import type { AssembledMemoryContext } from '../memory/core/types.js';
import { ConversationHistoryManager } from './ConversationHistoryManager';
import { CognitiveMemoryBridge } from './CognitiveMemoryBridge';
import { SentimentTracker } from './SentimentTracker';
import { MetapromptExecutor } from './MetapromptExecutor';
import { feedbackTraceMessage, type NormalizedUserFeedback } from './userFeedback';
import { resolveReasoningTraceLimits, type ReasoningTraceLimits } from './reasoningTraceLimits';
import { settlesWithin, shutdownTimeoutOrDefault } from './shutdownBound';

const DEFAULT_MAX_CONVERSATION_HISTORY_TURNS = 20;
const DEFAULT_SELF_REFLECTION_INTERVAL_TURNS = 5;

/** The completion options a persona's defaults and a turn's `metadata.options` may set (design D4b). */
const FORWARDED_COMPLETION_OPTION_KEYS = [
  'temperature', 'maxTokens', 'topP', 'frequencyPenalty', 'presencePenalty', 'thinking', 'effort', 'cache',
  'promptCacheKey', 'promptCacheRetention', 'serviceTier', 'requestTimeout', 'customModelParams',
  'stopSequences', 'responseFormat', 'toolChoice',
] as const;

/** The forwarded completion options `source` sets; unset keys are left out so a later layer can fill them. */
function pickCompletionOptions(source: Record<string, unknown> | undefined): Partial<ModelCompletionOptions> {
  const picked: Record<string, unknown> = {};
  if (!source) return picked;
  for (const key of FORWARDED_COMPLETION_OPTION_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked as Partial<ModelCompletionOptions>;
}

/**
 * The `cacheDiagnostics` a turn's first model step sends, or undefined when the
 * turn did not opt in. Takes generateText's forms beside the provider's: `true`
 * opts in with nothing to compare, an object compares against its
 * `previousMessageId` (nothing when it names none), and `false` stays off.
 */
function cacheDiagnosticsSeed(value: unknown): { previousMessageId: string | null } | undefined {
  if (!value) return undefined;
  const id = typeof value === 'object' ? (value as { previousMessageId?: unknown }).previousMessageId : undefined;
  return { previousMessageId: typeof id === 'string' && id.length > 0 ? id : null };
}

/** `messages` with a system message of `text` after the leading system messages. */
function withSystemMessage(messages: ChatMessage[], text: string): ChatMessage[] {
  let at = 0;
  while (at < messages.length && messages[at].role === 'system') at += 1;
  return [...messages.slice(0, at), { role: 'system', content: text }, ...messages.slice(at)];
}

/** `value` when it is an abort signal: an object that takes abort listeners. */
function asAbortSignal(value: unknown): AbortSignal | undefined {
  return value && typeof value === 'object' && typeof (value as AbortSignal).addEventListener === 'function'
    ? (value as AbortSignal)
    : undefined;
}

/** `value` when it is a usage report as a provider gives one: an object with a numeric token count. */
function asUsageReport(value: unknown): ModelUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { promptTokens, completionTokens, totalTokens } = value as Record<string, unknown>;
  return [promptTokens, completionTokens, totalTokens].some((count) => typeof count === 'number' && Number.isFinite(count))
    ? (value as ModelUsage)
    : undefined;
}

/** A message's content as a string two equal contents share: the text itself, or the JSON of its parts. */
function contentKey(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content) ?? '';
  } catch {
    return '';
  }
}

/** Adds one provider usage report to the turn's total. */
function addUsage(total: CostAggregator, usage: ModelUsage): void {
  total.promptTokens += usage.promptTokens || 0;
  total.completionTokens += usage.completionTokens || 0;
  total.totalTokens = total.promptTokens + total.completionTokens;
  if (usage.costUSD) total.totalCostUSD = (total.totalCostUSD || 0) + usage.costUSD;
}

/**
 * @class GMI
 * @implements {IGMI}
 * The core implementation of the Generalized Mind Instance, orchestrating
 * perception, cognition, action, and adaptation.
 */
export class GMI implements IGMI {
  public readonly gmiId: string;
  public readonly creationTimestamp: Date;

  private activePersona!: IPersonaDefinition;
  private config!: GMIBaseConfig;

  // Core Dependencies (Injected)
  private workingMemory!: IWorkingMemory;
  private promptEngine!: IPromptEngine;
  private retrievalAugmentor?: IRetrievalAugmentor;
  private toolOrchestrator!: IToolOrchestrator;
  private llmProviderManager!: AIModelProviderManager;
  private utilityAI!: IUtilityAI;
  private cognitiveMemory?: ICognitiveMemoryManager;

  // Internal State
  private state: GMIPrimeState;
  private isInitialized: boolean = false; // Maintained as per user-provided GMI.ts
  private currentGmiMood: GMIMood;
  private currentUserContext!: UserContext;
  private currentTaskContext!: TaskContext;
  private reasoningTrace: ReasoningTrace;
  /** Entry cap and message cap of the trace; resolved from the persona and the config at initialize(). */
  private traceLimits: ReasoningTraceLimits = resolveReasoningTraceLimits();
  private conversationHistoryManager!: ConversationHistoryManager;

  /**
   * Turn ownership. Each processTurnStream call takes the next number and
   * owns the lifecycle state until a newer turn starts or shutdown() takes it
   * back (0, which no turn has); a turn that no longer owns it (a failed turn
   * whose generator is drained after the next turn began, a turn that ends
   * after shutdown began) leaves the state and the trace's turn id alone.
   */
  private turnSequence = 0;
  private stateOwnerTurn = 0;

  /**
   * The turns whose work is still running, by turn number: the controller that
   * stops each one and a promise that resolves once its work is done.
   * shutdown() stops them and waits for them.
   */
  private readonly runningTurns = new Map<number, { stop: AbortController; ended: Promise<void> }>();

  /** The shutdown that is running, if any; a shutdown() call made meanwhile waits for it. */
  private shutdownInProgress: Promise<void> | undefined;

  /**
   * What the GMI needs to forget a turn once the history no longer holds it
   * (see {@link GMI.forgetTurnsOutside}): the turn each trace entry was recorded
   * in (entries recorded outside a turn have none), and each user turn's input
   * as a comparison key, by turn id, oldest first.
   */
  private readonly traceEntryTurn = new WeakMap<ReasoningTraceEntry, string>();
  private readonly turnInputs = new Map<string, string>();
  /** Settles once the latest replaceHistory() or clearHistory() has also cleaned the sentiment history. */
  private historyForgetting: Promise<void> = Promise.resolve();

  /**
   * The gateway hop that served the turn's last model step; the next step of
   * the turn starts there (a turn moves forward through the chain, never back).
   * Cleared when a user turn starts, so the next turn tries the primary again.
   */
  private turnResolution: CompletionResolution | undefined;

  // (Self-reflection state is owned by MetapromptExecutor)

  // Cognitive Memory Bridge
  private memoryBridge: CognitiveMemoryBridge | null = null;

  // Sentiment & Event Tracking
  private sentimentTracker!: SentimentTracker;

  // Metaprompt Executor
  private metapromptExecutor!: MetapromptExecutor;

  /**
   * Constructs a GMI instance.
   * The GMI is not fully operational until `initialize` is called.
   * @param {string} [gmiId] - Optional ID for the GMI. If not provided, a UUID will be generated.
   */
  constructor(gmiId?: string) {
    this.gmiId = gmiId || `gmi-${uuidv4()}`;
    this.creationTimestamp = new Date();
    this.state = GMIPrimeState.IDLE;

    this.currentGmiMood = GMIMood.NEUTRAL;
    this.currentUserContext = { userId: 'uninitialized-user', skillLevel: 'novice', preferences: {} };
    this.currentTaskContext = { taskId: `task-${uuidv4()}`, domain: 'general', complexity: 'low', status: 'not_started' };
    this.reasoningTrace = { gmiId: this.gmiId, personaId: '', entries: [] };
    this.conversationHistoryManager = new ConversationHistoryManager();
  }

  /**
   * @inheritdoc
   */
  public async initialize(persona: IPersonaDefinition, config: GMIBaseConfig): Promise<void> {
    if (this.isInitialized && this.state !== GMIPrimeState.ERRORED) {
      console.warn(`GMI (ID: ${this.gmiId}) already initialized (state: ${this.state}). Re-initializing parts.`);
      // Selective re-initialization logic can be more granular if needed
      this.reasoningTrace = { gmiId: this.gmiId, personaId: '', entries: [] };
      this.conversationHistoryManager.clear();
    }

    this.traceLimits = resolveReasoningTraceLimits(persona, config);
    if (this.traceLimits.ignored.length > 0) {
      this.addTraceEntry(ReasoningEntryType.WARNING, 'Reasoning-trace limit setting ignored or clamped.', { ignored: this.traceLimits.ignored });
    }
    this.validateInitializationInputs(persona, config);

    this.activePersona = persona;
    this.config = config;

    this.workingMemory = config.workingMemory;
    this.promptEngine = config.promptEngine;
    this.retrievalAugmentor = config.retrievalAugmentor;
    this.toolOrchestrator = config.toolOrchestrator;
    this.llmProviderManager = config.llmProviderManager;
    this.utilityAI = config.utilityAI;
    this.cognitiveMemory = config.cognitiveMemory;

    // Initialize cognitive memory bridge if cognitive memory is provided
    if (this.cognitiveMemory) {
      this.memoryBridge = new CognitiveMemoryBridge(
        this.cognitiveMemory,
        () => this.currentGmiMood,
        () => this.currentUserContext,
        () => this.getCurrentPrimaryPersonaId(),
        () => this.gmiId,
        (type, message, details) => this.addTraceEntry(type as ReasoningEntryType, message, details),
      );
    } else {
      this.memoryBridge = null;
    }

    this.reasoningTrace.personaId = this.activePersona.id;

    await this.workingMemory.initialize(this.gmiId, this.activePersona.customFields?.defaultWorkingMemoryConfig || {});
    this.addTraceEntry(ReasoningEntryType.LIFECYCLE, 'GMI Initializing with Persona and Config.', { personaId: persona.id });

    await this.loadStateFromMemoryAndPersona();

    // Initialize sentiment tracker
    this.sentimentTracker = new SentimentTracker(
      this.utilityAI,
      this.workingMemory,
      () => this.activePersona,
      () => this.conversationHistoryManager.history,
      () => this.reasoningTrace.entries,
      () => this.currentUserContext,
      async (ctx) => {
        this.currentUserContext = ctx;
        await this.workingMemory.set('currentUserContext', this.currentUserContext);
      },
      (type, message, details) => this.addTraceEntry(type as ReasoningEntryType, message, details),
      () => this.gmiId,
    );

    // Initialize metaprompt executor
    this.metapromptExecutor = new MetapromptExecutor({
      workingMemory: this.workingMemory,
      llmProviderManager: this.llmProviderManager,
      utilityAI: this.utilityAI,
      getPersona: () => this.activePersona,
      addTraceEntry: (type, message, details) => this.addTraceEntry(type as ReasoningEntryType, message, details),
      getModelAndProvider: (preferredModel, preferredProvider) => this.getModelAndProviderForLLMCall(
        preferredModel,
        preferredProvider,
        this.activePersona.defaultModelId || this.config.defaultLlmModelId,
        this.activePersona.defaultProviderId || this.config.defaultLlmProviderId,
      ),
      onMoodUpdate: (mood) => {
        this.currentGmiMood = mood;
        this.workingMemory.set('currentGmiMood', this.currentGmiMood);
      },
      onUserContextUpdate: (updates) => {
        Object.assign(this.currentUserContext, updates);
        this.workingMemory.set('currentUserContext', this.currentUserContext);
      },
      onTaskContextUpdate: (updates) => {
        Object.assign(this.currentTaskContext, updates);
        this.workingMemory.set('currentTaskContext', this.currentTaskContext);
      },
      onMemoryImprint: async (content, tags) => {
        await this.memoryBridge?.encode(content, {
          type: 'semantic',
          sourceType: 'agent_inference',
          role: 'system',
          tags,
        });
      },
      getPendingEvents: () => this.sentimentTracker.pendingEvents,
      getEventHistory: () => this.sentimentTracker.events,
      getConversationHistory: () => this.conversationHistoryManager.history,
      getReasoningTraceEntries: () => this.reasoningTrace.entries,
      getMood: () => this.currentGmiMood,
      getUserContext: () => this.currentUserContext,
      getTaskContext: () => this.currentTaskContext,
      setState: (state) => { this.state = state; },
      getState: () => this.state,
      getGmiId: () => this.gmiId,
    });

    const reflectionMetaPrompt = this.activePersona.metaPrompts?.find(mp => mp.id === 'gmi_self_trait_adjustment');
    this.metapromptExecutor.selfReflectionIntervalTurns = reflectionMetaPrompt?.trigger?.type === 'turn_interval' && typeof reflectionMetaPrompt.trigger.intervalTurns === 'number'
      ? reflectionMetaPrompt.trigger.intervalTurns
      : DEFAULT_SELF_REFLECTION_INTERVAL_TURNS;
    this.metapromptExecutor.turnsSinceLastReflection = 0;

    this.isInitialized = true; // Set after all essential initializations
    this.state = GMIPrimeState.READY;
    this.addTraceEntry(ReasoningEntryType.LIFECYCLE, 'GMI Initialization complete. State: READY.');
    console.log(`GMI (ID: ${this.gmiId}, Persona: ${this.activePersona.id}) initialized successfully.`);
  }

  /**
   * Validates the essential inputs for GMI initialization.
   * @param {IPersonaDefinition} persona - The persona definition.
   * @param {GMIBaseConfig} config - The base configuration for the GMI.
   * @private
   * @throws {GMIError} if validation fails.
   */
  private validateInitializationInputs(persona: IPersonaDefinition, config: GMIBaseConfig): void {
    const errors: string[] = [];
    if (!persona) errors.push('PersonaDefinition');
    if (!config) errors.push('GMIBaseConfig');
    else {
      if (!config.workingMemory) errors.push('config.workingMemory');
      if (!config.promptEngine) errors.push('config.promptEngine');
      if (!config.llmProviderManager) errors.push('config.llmProviderManager');
      if (!config.utilityAI) errors.push('config.utilityAI');
      if (!config.toolOrchestrator) errors.push('config.toolOrchestrator');
    }
    if (errors.length > 0) {

      throw new GMIError(`GMI initialization failed, missing dependencies: ${errors.join(', ')}`, GMIErrorCode.GMI_INITIALIZATION_ERROR, { missing: errors });
    }
  }

  /**
   * Loads initial operational state from working memory or persona defaults.
   * @private
   */
  private async loadStateFromMemoryAndPersona(): Promise<void> {
    this.currentGmiMood = (await this.workingMemory.get<GMIMood>('currentGmiMood')) ||
                         (this.activePersona.moodAdaptation?.defaultMood as GMIMood) || // Assuming GMIMood string is compatible
                         GMIMood.NEUTRAL;

    const personaInitialUserCtx = this.activePersona.customFields?.initialUserContext || {};
    const memUserCtx = await this.workingMemory.get<UserContext>('currentUserContext');
    this.currentUserContext = {
      userId: 'default_user', // Will be overridden by actual session/turn user ID
      skillLevel: 'novice',
      preferences: {},
      ...personaInitialUserCtx,
      ...(memUserCtx || {}), // Spread memUserCtx if it exists
    };
    
    const personaInitialTaskCtx = this.activePersona.customFields?.initialTaskContext || {};
    const memTaskCtx = await this.workingMemory.get<TaskContext>('currentTaskContext');
    this.currentTaskContext = {
      taskId: `task-${uuidv4()}`,
      domain: this.activePersona.strengths?.[0] || 'general',
      complexity: 'medium',
      status: 'not_started',
      ...personaInitialTaskCtx,
      ...(memTaskCtx || {}),
    };

    await Promise.all([
        this.workingMemory.set('currentGmiMood', this.currentGmiMood),
        this.workingMemory.set('currentUserContext', this.currentUserContext),
        this.workingMemory.set('currentTaskContext', this.currentTaskContext)
    ]);

    this.addTraceEntry(ReasoningEntryType.STATE_CHANGE, 'GMI operational state (mood, user, task contexts) loaded/initialized.');

    if (this.activePersona.initialMemoryImprints && this.activePersona.initialMemoryImprints.length > 0) {
      this.addTraceEntry(ReasoningEntryType.STATE_CHANGE, `Applying ${this.activePersona.initialMemoryImprints.length} initial memory imprints from persona.`);
      for (const imprint of this.activePersona.initialMemoryImprints) {
        if (imprint.key && imprint.value !== undefined) {
          await this.workingMemory.set(imprint.key, imprint.value);
          this.addTraceEntry(ReasoningEntryType.DEBUG, `Applied memory imprint: '${imprint.key}'`, { value: imprint.value, description: imprint.description });
        }
      }
    }
  }

  /** @inheritdoc */
  public getPersona(): IPersonaDefinition {
    if (!this.isInitialized || !this.activePersona) {
      throw new GMIError("GMI is not properly initialized or has no active persona.", GMIErrorCode.NOT_INITIALIZED);
    }
    return this.activePersona;
  }

  /** @inheritdoc */
  public getCurrentPrimaryPersonaId(): string {
    if (!this.activePersona) {
      throw new GMIError("GMI has no active persona assigned.", GMIErrorCode.NOT_INITIALIZED);
    }
    return this.activePersona.id;
  }

  /** @inheritdoc */
  public getGMIId(): string { return this.gmiId; }

  /** @inheritdoc */
  public getCurrentState(): GMIPrimeState { return this.state; }

  /** @inheritdoc */
  public getReasoningTrace(): Readonly<ReasoningTrace> {
    return JSON.parse(JSON.stringify(this.reasoningTrace));
  }

  /** @inheritdoc */
  public async getWorkingMemorySnapshot(): Promise<Record<string, any>> {
    return this.workingMemory.getAll();
  }

  /** @inheritdoc */
  public getCognitiveMemoryManager(): ICognitiveMemoryManager | undefined {
    return this.cognitiveMemory;
  }

  /**
   * Records user feedback on this instance. Adds a reasoning-trace entry
   * (WARNING for negative feedback, DEBUG otherwise) and, when cognitive memory
   * is configured, encodes the feedback as an episodic memory of the user. A
   * correction is also encoded as a semantic memory so later turns can recall
   * it. Memory failures are traced by the bridge and never thrown.
   *
   * @param feedback - Normalized feedback plus the id of the user who sent it.
   */
  public async recordUserFeedback(feedback: NormalizedUserFeedback & { userId: string }): Promise<void> {
    const { userId, polarity, score, text, correctedContent, targetMessageId, tags } = feedback;
    this.addTraceEntry(
      polarity === 'negative' ? ReasoningEntryType.WARNING : ReasoningEntryType.DEBUG,
      feedbackTraceMessage(polarity),
      { userId, polarity, score, text, correctedContent, targetMessageId, tags },
    );

    // An empty user id falls back to the bridge's default scope (the current user).
    const scopeId = typeof userId === 'string' && userId.trim() ? userId.trim() : undefined;
    const scoreLabel = score !== undefined ? `, score ${score}` : '';
    await this.memoryBridge?.encode(`User feedback (${polarity}${scoreLabel})${text ? `: ${text}` : ''}`, {
      type: 'episodic',
      sourceType: 'user_statement',
      role: 'user',
      scopeId,
      tags: ['user_feedback', `feedback_${polarity}`, ...(tags ?? [])],
    });

    if (correctedContent) {
      const target = targetMessageId ? ` for message ${targetMessageId}` : '';
      await this.memoryBridge?.encode(`User correction${target}: ${correctedContent}`, {
        type: 'semantic',
        sourceType: 'user_statement',
        role: 'user',
        scopeId,
        tags: ['user_feedback', 'user_correction'],
      });
    }
  }

  /**
   * Sets one personality trait on this instance only. The persona definition
   * is shared by every GMI of that persona (it is the GMIManager registry
   * object), so the change is made on a copy that replaces this instance's
   * active persona; other sessions and GMIs created later keep the original.
   *
   * @param trait - Trait key, e.g. `openness` or `honesty`.
   * @param value - New trait value.
   * @throws {GMIError} When the GMI has not been initialized.
   */
  public setPersonalityTrait(trait: string, value: number): void {
    const persona = this.getPersona();
    this.activePersona = {
      ...persona,
      personalityTraits: { ...(persona.personalityTraits ?? {}), [trait]: value },
    };
    this.addTraceEntry(ReasoningEntryType.STATE_CHANGE, `Personality trait '${trait}' set to ${value}.`, { trait, value });
  }

  /**
   * Adds an entry to the GMI's reasoning trace.
   * @private
   */
  private addTraceEntry(type: ReasoningEntryType, message: string, details?: Record<string, any>, timestamp?: Date): void {
    while (this.reasoningTrace.entries.length >= this.traceLimits.maxEntries) {
      this.reasoningTrace.entries.shift();
    }
    const entry: ReasoningTraceEntry = {
      timestamp: timestamp || new Date(),
      type,
      message: message.substring(0, this.traceLimits.maxMessageLength),
      details: details ? JSON.parse(JSON.stringify(details)) : {},
    };
    this.reasoningTrace.entries.push(entry);
    if (this.reasoningTrace.turnId) this.traceEntryTurn.set(entry, this.reasoningTrace.turnId);
  }

  /**
   * Drops what the GMI recorded about the turns `history` no longer holds, so
   * that a replaced or cleared fact reaches no later model call through the
   * records kept beside the history: the reflection metaprompt sends recent
   * trace entries to the model as evidence.
   *
   * A recorded turn is kept when `history` has a user message with that turn's
   * input, each message keeping one turn, the newest first. For every other
   * turn, the details of its trace entries are emptied (the first characters of
   * its input, its tool calls and results; the entries stay, with their type and
   * message), and the sentiment tracker drops the input excerpts of its events
   * and sentiment trends. The tracker's part runs asynchronously and has
   * finished before the next turn starts.
   *
   * @param history - The conversation history after the replacement.
   */
  private forgetTurnsOutside(history: readonly ChatMessage[]): void {
    const unclaimed = new Map<string, number>();
    for (const message of history) {
      if (message.role !== 'user') continue;
      const key = contentKey(message.content);
      unclaimed.set(key, (unclaimed.get(key) ?? 0) + 1);
    }
    const kept = new Set<string>();
    for (const [turnId, key] of [...this.turnInputs].reverse()) {
      const left = unclaimed.get(key) ?? 0;
      if (left === 0) {
        this.turnInputs.delete(turnId);
        continue;
      }
      unclaimed.set(key, left - 1);
      kept.add(turnId);
    }
    for (const entry of this.reasoningTrace.entries) {
      const turnId = this.traceEntryTurn.get(entry);
      if (turnId === undefined || kept.has(turnId)) continue;
      entry.details = {};
      this.traceEntryTurn.delete(entry);
    }
    this.historyForgetting = this.historyForgetting
      .then(() => this.sentimentTracker?.forgetTurnsExcept(kept))
      .catch((error: unknown) => {
        this.addTraceEntry(ReasoningEntryType.WARNING, 'Could not drop the sentiment history of turns removed from the conversation history.', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private stringifyTurnContent(content: GMITurnInput['content']): string | null {
    if (typeof content === 'string') {
      const trimmed = content.trim();
      return trimmed ? trimmed : null;
    }
    try {
      const serialized = JSON.stringify(content);
      return serialized && serialized !== 'null' ? serialized : null;
    } catch {
      return null;
    }
  }

  private getConversationIdForTurn(turnInput: GMITurnInput): string | undefined {
    const metadataConversationId =
      typeof turnInput.metadata?.conversationId === 'string'
        ? turnInput.metadata.conversationId.trim()
        : '';
    if (metadataConversationId) {
      return metadataConversationId;
    }

    const sessionId = typeof turnInput.sessionId === 'string' ? turnInput.sessionId.trim() : '';
    return sessionId || undefined;
  }

  private getOrganizationIdForTurn(turnInput: GMITurnInput): string | undefined {
    const organizationId =
      typeof turnInput.metadata?.organizationId === 'string'
        ? turnInput.metadata.organizationId.trim()
        : '';
    return organizationId || undefined;
  }

  /**
   * Error results for the calls of a tool round that produced none: the call
   * that was running when the round failed and the calls not yet started.
   * Recording them leaves a history in which every tool call the assistant
   * message declared has an answer, which the next request needs (providers
   * reject an unanswered tool call, and a later turn replays this history).
   *
   * @param requests - Every call the round's assistant message declared, in order.
   * @param finishedCount - How many of them already produced a result.
   * @param inFlight - The call that was running when the round failed, if any.
   * @param error - Why the round stopped.
   * @returns One error result per unanswered call.
   */
  private resultsForUnfinishedToolCalls(
    requests: ToolCallRequest[],
    finishedCount: number,
    inFlight: ToolCallRequest | undefined,
    error: unknown,
  ): ToolCallResult[] {
    const reason = error instanceof Error ? error.message : String(error);
    return requests.slice(finishedCount).map((request) => ({
      toolCallId: request.id,
      toolName: request.name,
      output: undefined,
      isError: true,
      errorDetails: {
        message:
          request === inFlight
            ? `Tool '${request.name}' failed: ${reason}`
            : `Tool '${request.name}' was not run because the tool round stopped: ${reason}`,
      },
    }));
  }

  private buildToolSessionData(turnInput: GMITurnInput): Record<string, any> | undefined {
    const sessionId = typeof turnInput.sessionId === 'string' ? turnInput.sessionId.trim() : '';
    const conversationId = this.getConversationIdForTurn(turnInput);
    const organizationId = this.getOrganizationIdForTurn(turnInput);

    const sessionData: Record<string, any> = {};
    if (sessionId) {
      sessionData.sessionId = sessionId;
    }
    if (conversationId) {
      sessionData.conversationId = conversationId;
    }
    if (organizationId) {
      sessionData.organizationId = organizationId;
    }

    return Object.keys(sessionData).length > 0 ? sessionData : undefined;
  }

  /**
   * Ensures the GMI is initialized and idle: READY, or ERRORED after a failed
   * turn. ERRORED only records that the last turn failed; the instance still
   * works, so it does not block the next turn or the memory callbacks.
   * @private
   */
  private ensureReady(additionallyAllowedStates: GMIPrimeState[] = []): void {
    if (!this.isInitialized) {
        throw new GMIError(`GMI (ID: ${this.gmiId}) is not initialized.`, GMIErrorCode.NOT_INITIALIZED);
    }
    const isIdle = this.state === GMIPrimeState.READY || this.state === GMIPrimeState.ERRORED;
    if (!isIdle && !additionallyAllowedStates.includes(this.state)) {

      throw new GMIError(
        `GMI (ID: ${this.gmiId}) is not in READY state. Current state: ${this.state}.`,
        GMIErrorCode.INVALID_STATE,
        { currentGMIState: this.state }
      );
    }
  }

  /**
   * Creates a standardized GMIOutputChunk.
   * @private
   */
  private createOutputChunk(
    interactionId: string,
    type: GMIOutputChunkType,
    content: any,
    extras: Partial<Omit<GMIOutputChunk, 'interactionId' | 'type' | 'content' | 'timestamp' | 'chunkId'>> = {}
  ): GMIOutputChunk {
    return {
      interactionId, type, content,
      timestamp: new Date(),
      chunkId: `gmi-chunk-${uuidv4()}`,
      ...extras,
    };
  }

  public hydrateConversationHistory(conversationHistory: ConversationMessage[]): void {
    this.conversationHistoryManager.hydrate(conversationHistory);
  }

  /**
   * Makes `messages` the whole conversation history. An empty array is
   * authoritative: it empties the history (unlike
   * `metadata.conversationHistoryForPrompt`, which a turn ignores when empty).
   * The sentiment tracker and the metaprompts read the same history. What the
   * GMI recorded about turns the new history no longer holds is dropped too:
   * the details of their reasoning-trace entries and the input excerpts of
   * their sentiment records (a turn stays while a user message with its input
   * is in the history).
   */
  public replaceHistory(messages: ConversationMessage[]): void {
    this.conversationHistoryManager.clear();
    if (messages.length > 0) this.conversationHistoryManager.hydrate(messages);
    this.forgetTurnsOutside(this.conversationHistoryManager.history);
  }

  /** Empties the conversation history, and drops what the GMI recorded about its turns, as {@link GMI.replaceHistory} does. */
  public clearHistory(): void {
    this.conversationHistoryManager.clear();
    this.forgetTurnsOutside([]);
  }

  public hydrateTurnContext(context: {
    sessionId?: string;
    conversationId?: string;
    organizationId?: string;
  }): void {
    if (typeof context.sessionId === 'string' && context.sessionId.trim()) {
      this.reasoningTrace.sessionId = context.sessionId.trim();
    }
    if (typeof context.conversationId === 'string' && context.conversationId.trim()) {
      this.reasoningTrace.conversationId = context.conversationId.trim();
    }
    if (typeof context.organizationId === 'string' && context.organizationId.trim()) {
      this.reasoningTrace.organizationId = context.organizationId.trim();
    }
  }

  /**
   * Builds the PromptExecutionContext for the PromptEngine.
   * @private
   * @returns {PromptExecutionContext} The context for prompt construction.
   */
  private buildPromptExecutionContext(): PromptExecutionContext {
    if (!this.isInitialized || !this.activePersona || !this.currentUserContext || !this.currentTaskContext || !this.workingMemory) {
      throw new GMIError("GMI context not properly initialized for prompt construction.", GMIErrorCode.INVALID_STATE);
    }
    
    const context: PromptExecutionContext = {
      activePersona: this.activePersona,
      workingMemory: this.workingMemory,
      currentMood: this.currentGmiMood,
      userSkillLevel: this.currentUserContext.skillLevel,
      userPreferences: this.currentUserContext.preferences,
      taskHint: this.currentTaskContext.domain,
      taskComplexity: this.currentTaskContext.complexity,
      // language: this.currentUserContext.language, // If available
      // conversationSignals: this.detectConversationSignals(), // If such method exists
    };
    return context;
  }

  /**
   * Assembles the conversation history and user input for one model call of
   * a turn.
   *
   * The history is the conversation before this turn, then this turn's own
   * messages. The conversation before the turn is the host's durable history
   * (`metadata.conversationHistoryForPrompt`) when the host passed a non-empty
   * one, which ends before the current user message; otherwise it is this
   * GMI's history as the turn found it, without the user message the turn
   * recorded. The turn's own messages are that user message and the assistant
   * replies and tool results of earlier calls in the turn, so a tool round's
   * calls and results reach the next call on either history.
   *
   * On a turn's first call, plain text input travels as `userInput`, which the
   * chat template places last and attaches retrieved context to; the durable
   * path has always sent it that way. Structured (multimodal) input stays a
   * history message, so its parts reach the provider intact and only once.
   *
   * @param turn - Where the turn's messages come from.
   * @param turn.durableHistory - The host's history before this turn, or
   *   `null` to use this GMI's own history.
   * @param turn.historyAtTurnStart - This GMI's history once the turn input
   *   was recorded.
   * @param turn.currentUserMessage - The user message the turn input added,
   *   when the turn is user-initiated.
   * @param turn.turnMessages - Assistant replies and tool results the turn has
   *   added so far.
   * @returns The `conversationHistory` and `userInput` prompt components,
   *   and how many history messages belong to this turn (token budgeting
   *   leaves those whole).
   */
  private buildPromptConversation(turn: {
    durableHistory: ConversationMessage[] | null;
    historyAtTurnStart: readonly ChatMessage[];
    currentUserMessage: ChatMessage | undefined;
    turnMessages: readonly ChatMessage[];
  }): { conversationHistory: ConversationMessage[]; userInput: string | null; currentTurnMessageCount: number } {
    const { durableHistory, historyAtTurnStart, currentUserMessage, turnMessages } = turn;
    const toConversationMessage = (message: ChatMessage): ConversationMessage =>
      this.conversationHistoryManager.convertToConversationMessage(message);

    const historyBeforeTurn =
      durableHistory ??
      historyAtTurnStart
        .filter((message) => message !== currentUserMessage)
        .map(toConversationMessage);
    const userContent = currentUserMessage?.content;
    const userText =
      turnMessages.length === 0 && typeof userContent === 'string' && userContent !== ''
        ? userContent
        : null;
    const turnHistory: ChatMessage[] = [
      ...(currentUserMessage && userText === null ? [currentUserMessage] : []),
      ...turnMessages,
    ];

    return {
      conversationHistory: [...historyBeforeTurn, ...turnHistory.map(toConversationMessage)],
      userInput: userText,
      currentTurnMessageCount: turnHistory.length,
    };
  }

  /**
   * Determines if RAG retrieval should be triggered based on the current query and persona configuration.
   * @private
   * @param {string} query - The current user query.
   * @returns {boolean} True if RAG should be triggered, false otherwise.
   */
  private shouldTriggerRAGRetrieval(query: string, context?: { lastToolFailed?: boolean; detectedIntents?: string[] }): boolean {
    if (!query || query.trim() === '') return false;

    const ragConfig = this.activePersona.memoryConfig?.ragConfig;
    const retrievalTriggers = ragConfig?.retrievalTriggers;
    if (!retrievalTriggers) return false;

    if (retrievalTriggers.onUserQuery) return true;

    if (retrievalTriggers.onToolFailure?.length && context?.lastToolFailed) {
      return true;
    }

    if (retrievalTriggers.onIntentDetected?.length && context?.detectedIntents?.length) {
      const matched = retrievalTriggers.onIntentDetected.some(
        intent => context.detectedIntents!.includes(intent),
      );
      if (matched) return true;
    }

    return false;
  }

  /**
   * Returns the PromptEngine template GMI builds its prompts with.
   *
   * GMI hands the constructed prompt to `IProvider.generateCompletionStream`,
   * whose input is an OpenAI-style `ChatMessage[]` for every provider; each
   * provider converts that array to its own wire format (Anthropic messages
   * with a separate system field, Gemini contents with a systemInstruction).
   * A provider-specific template would hand the provider another shape; the
   * `anthropic_messages` template, for one, returns an object with the
   * system prompt split out, which AnthropicProvider cannot iterate.
   *
   * @returns Always `'openai_chat'`.
   */
  private determinePromptFormat(): 'openai_chat' {
    return 'openai_chat';
  }

  /**
   * Determines the tool calling format based on model provider.
   * @param modelDetails - Model metadata from the provider manager.
   * @param providerId - The provider identifier.
   * @returns The tool format string.
   */
  private determineToolFormat(
    modelDetails: { providerId?: string; capabilities?: string[] } | null | undefined,
    providerId?: string,
  ): string {
    const pid = (modelDetails?.providerId || providerId || '').toLowerCase();
    if (pid.includes('anthropic')) return 'anthropic_tools';
    if (pid.includes('google') || pid.includes('gemini')) return 'google_function_calling';
    return 'openai_functions';
  }

  /**
   * The model target of a turn without a completion gateway: the runtime
   * path's lookup through the provider manager, with the 8192-token window
   * and no capabilities when the manager knows nothing about the model.
   */
  private async legacyModelTargetInfo(modelId: string, providerId: string | undefined): Promise<ModelTargetInfo> {
    const modelDetails = await this.llmProviderManager.getModelInfo(modelId, providerId);
    return {
      modelId,
      providerId: modelDetails?.providerId || providerId || this.llmProviderManager.getProviderForModel(modelId)?.providerId || 'unknown',
      maxContextTokens: modelDetails?.contextWindowSize || 8192,
      capabilities: modelDetails?.capabilities || [],
      promptFormatType: this.determinePromptFormat(),
      toolSupport: {
        supported: modelDetails?.capabilities.includes('tool_use') || false,
        format: this.determineToolFormat(modelDetails, providerId),
      },
    };
  }

  /** @inheritdoc */

  public async *processTurnStream(turnInput: GMITurnInput): AsyncGenerator<GMIOutputChunk, GMIOutput, undefined> {
    const continuationAllowedStates =
      turnInput.metadata?.isToolContinuation === true
        ? [GMIPrimeState.PROCESSING, GMIPrimeState.AWAITING_TOOL_RESULT]
        : [];
    this.ensureReady(continuationAllowedStates);
    if (this.state === GMIPrimeState.ERRORED) {
      this.addTraceEntry(ReasoningEntryType.WARNING, 'Previous turn failed; starting a new turn.');
    }
    this.state = GMIPrimeState.PROCESSING;
    const turnNumber = ++this.turnSequence;
    // A user turn starts at the primary hop; a tool continuation stays on the
    // hop that served the step it continues.
    if (turnInput.metadata?.isToolContinuation !== true) this.turnResolution = undefined;
    this.stateOwnerTurn = turnNumber;
    // False once a newer turn has started; lifecycle writes below check it.
    const ownsState = (): boolean => this.stateOwnerTurn === turnNumber;
    const turnId = turnInput.interactionId || `turn-${uuidv4()}`;
    // Store turnId on reasoningTrace for current turn
    if (this.reasoningTrace) {
      this.reasoningTrace.turnId = turnId;
      this.reasoningTrace.sessionId = turnInput.sessionId;
      this.reasoningTrace.conversationId = this.getConversationIdForTurn(turnInput);
      this.reasoningTrace.organizationId = this.getOrganizationIdForTurn(turnInput);
    }

    this.addTraceEntry(ReasoningEntryType.INTERACTION_START, `Processing turn '${turnId}' for user '${turnInput.userId}'`,
      { inputType: turnInput.type, inputPreview: String(turnInput.content).substring(0, 100) });

    // Initialize aggregates for the final GMIOutput
    let aggregatedResponseText = "";
    const aggregatedToolCalls: ToolCallRequest[] = [];
    const aggregatedUiCommands: UICommand[] = [];
    const aggregatedUsage: CostAggregator = { totalTokens: 0, promptTokens: 0, completionTokens: 0, breakdown: [] };
      let lastErrorForOutput: GMIOutput['error'] = undefined;

    // The turn's stop. The caller's abort signal (a session's close()) and this
    // GMI's shutdown() both abort it; the model call in progress then ends with
    // the provider's abort chunk (the gateway's, on a turn through a gateway).
    const callerSignal = asAbortSignal(turnInput.metadata?.options?.abortSignal);
    const stop = new AbortController();
    const forwardAbort = (): void => stop.abort();
    if (callerSignal?.aborted) stop.abort();
    else callerSignal?.addEventListener('abort', forwardAbort, { once: true });
    let endTurn!: () => void;
    this.runningTurns.set(turnNumber, {
      stop,
      ended: new Promise<void>((resolve) => {
        endTurn = resolve;
      }),
    });

    try {
      // A history replaced or cleared just before this turn has finished dropping
      // the sentiment records of the turns it removed.
      await this.historyForgetting;
      if (turnInput.userContextOverride) {
        const mergedPreferences =
          turnInput.userContextOverride.preferences &&
          typeof turnInput.userContextOverride.preferences === 'object'
            ? {
                ...(this.currentUserContext.preferences ?? {}),
                ...turnInput.userContextOverride.preferences,
              }
            : this.currentUserContext.preferences;

        this.currentUserContext = {
          ...this.currentUserContext,
          ...turnInput.userContextOverride,
          ...(mergedPreferences ? { preferences: mergedPreferences } : {}),
        };
        await this.workingMemory.set('currentUserContext', this.currentUserContext);
      }
      if (turnInput.taskContextOverride) {
        this.currentTaskContext = { ...this.currentTaskContext, ...turnInput.taskContextOverride };
        await this.workingMemory.set('currentTaskContext', this.currentTaskContext);
      }
      if (turnInput.userId && this.currentUserContext.userId !== turnInput.userId) {
        this.currentUserContext.userId = turnInput.userId;
        await this.workingMemory.set('currentUserContext', this.currentUserContext);
      }
      const maxHistoryMessages = this.activePersona.conversationContextConfig?.maxMessages ||
                               this.activePersona.memoryConfig?.conversationContext?.maxMessages ||
                               DEFAULT_MAX_CONVERSATION_HISTORY_TURNS;
      const messagesBeforeInput = new Set<ChatMessage>(this.conversationHistoryManager.history);
      this.conversationHistoryManager.update(turnInput, maxHistoryMessages);
      // The turn's prompt sources: this GMI's history once the input is
      // recorded, the user message the input added (user-initiated turns
      // only), the host's durable history when it passed one, and the
      // assistant replies and tool results the loop below adds.
      const historyAtTurnStart = [...this.conversationHistoryManager.history];
      const currentUserMessage = historyAtTurnStart.find(
        (message) => message.role === 'user' && !messagesBeforeInput.has(message),
      );
      // The turn's input, so a later replaceHistory() or clearHistory() can tell
      // whether the history still holds this turn. Bounded like the trace:
      // every turn on the trace has at least one entry there.
      if (currentUserMessage) {
        this.turnInputs.delete(turnId);
        this.turnInputs.set(turnId, contentKey(currentUserMessage.content));
        while (this.turnInputs.size > this.traceLimits.maxEntries) {
          const oldest = this.turnInputs.keys().next().value;
          if (oldest === undefined) break;
          this.turnInputs.delete(oldest);
        }
      }
      const currentTurnText = currentUserMessage?.content
        ? (typeof currentUserMessage.content === 'string'
            ? currentUserMessage.content
            : JSON.stringify(currentUserMessage.content))
        : '';
      const durableHistoryForPrompt =
        Array.isArray(turnInput.metadata?.conversationHistoryForPrompt) && turnInput.metadata?.conversationHistoryForPrompt.length > 0
          ? (turnInput.metadata?.conversationHistoryForPrompt as ConversationMessage[])
          : null;
      const turnMessages: ChatMessage[] = [];

      // Analyze sentiment of user input only when sentiment tracking is enabled
      if (this.activePersona.sentimentTracking?.enabled) {
        const lastMsg = this.conversationHistoryManager.history.length > 0
          ? this.conversationHistoryManager.history[this.conversationHistoryManager.history.length - 1]
          : null;
        if (lastMsg?.role === 'user' && lastMsg?.content) {
          const userInputText = typeof lastMsg.content === 'string'
            ? lastMsg.content
            : JSON.stringify(lastMsg.content);
          await this.sentimentTracker.analyzeTurnSentiment(turnId, userInputText);
        }
      }

      // -------------------------------------------------------------------
      // Main tool-calling loop (ReAct-style).
      //
      // NOTE: This loop duplicates the general-purpose LoopController
      // (src/orchestration/runtime/LoopController.ts) but carries
      // GMI-specific concerns that prevent a simple drop-in replacement:
      //
      //   - RAG retrieval + cognitive memory assembly on each iteration
      //   - Full prompt reconstruction via PromptEngine per iteration
      //   - Tool orchestration through IToolOrchestrator with persona-scoped
      //     ToolExecutionRequestDetails (gmiId, capabilities, sessionData)
      //   - GMIPrimeState transitions (PROCESSING <-> AWAITING_TOOL_RESULT)
      //   - Streaming via provider.generateCompletionStream() rather than
      //     the LoopController's AsyncGenerator<LoopChunk> abstraction
      //   - Capability discovery tool filtering per iteration
      //   - GMIError-based fail_closed semantics with structured error codes
      //
      // Future refactor path: extract the RAG + prompt-build phase into a
      // pre-iteration callback and the tool-dispatch phase into a
      // LoopContext adapter, then delegate the iteration/termination logic
      // to LoopController.execute().  This would unify the safety-break,
      // parallel-tools, and fail_open/fail_closed policies.  For now the
      // configurable maxToolLoopIterations (GMIBaseConfig) keeps the safety
      // break in sync with LoopController's maxIterations concept.
      // -------------------------------------------------------------------
      let safetyBreak = 0;
      const maxToolLoopIterations = this.config.maxToolLoopIterations ?? 5;
      // Prompt-cache diagnostics run through the turn's steps as they run through
      // generateText's: the first step compares against the message the turn (or
      // the persona) names, each later step against the previous step's response.
      const requestedCacheDiagnostics = (turnInput.metadata?.options as Record<string, unknown> | undefined)?.cacheDiagnostics;
      let stepCacheDiagnostics = cacheDiagnosticsSeed(
        requestedCacheDiagnostics !== undefined
          ? requestedCacheDiagnostics
          : (this.activePersona.defaultModelCompletionOptions as Record<string, unknown> | undefined)?.cacheDiagnostics,
      );
      let lastRagSources: import('../rag/IRetrievalAugmentor.js').RagRetrievedChunk[] | undefined;
      // A structured turn (ProcessingOptions.structuredReply): the schema the reply must match, resolved once. Its
      // instruction joins the system prompt, its Zod schema reaches the gateway, no delta streams before the check
      // unless asked, and a reply that does not match is asked for again inside the turn.
      let structuredReply: ReturnType<typeof resolveStructuredReply> = null;
      try {
        structuredReply = resolveStructuredReply((turnInput.metadata?.options as { structuredReply?: Parameters<typeof resolveStructuredReply>[0] } | undefined)?.structuredReply);
      } catch (error) {
        if (error instanceof StructuredReplyConfigError) throw new GMIError(error.message, GMIErrorCode.VALIDATION_ERROR, { code: error.code });
        throw error;
      }
      let structuredAttempts = 0;
      let structuredResult: StructuredReplyOutput | undefined;
      main_processing_loop: while (safetyBreak < maxToolLoopIterations) {
        safetyBreak++;
        let augmentedContextFromRAG = "";
        const injectedLongTermMemoryContext =
          typeof turnInput.metadata?.longTermMemoryContext === 'string'
            ? turnInput.metadata.longTermMemoryContext.trim()
            : "";
        let assembledMemoryContext: AssembledMemoryContext | null = null;

        // Retrieval and memory assembly run for a user turn's first model
        // call only; later calls continue from tool results.
        const isUserInitiatedTurn = currentUserMessage !== undefined && turnMessages.length === 0;

        if (this.retrievalAugmentor && this.activePersona.memoryConfig?.ragConfig?.enabled && isUserInitiatedTurn && currentTurnText) {
          const currentQueryForRag = currentTurnText;
          if (this.shouldTriggerRAGRetrieval(currentQueryForRag)) {
            this.addTraceEntry(ReasoningEntryType.RAG_QUERY_START, "RAG retrieval triggered.", { queryPreview: currentQueryForRag.substring(0, 100) });
            const ragCfg = this.activePersona.memoryConfig?.ragConfig;
            const strategyMap: Record<string, RagRetrievalOptions['strategy']> = {
              similarity: 'similarity', mmr: 'mmr', hybrid_search: 'hybrid',
            };
            const retrievalOptions: RagRetrievalOptions = {
                topK: ragCfg?.defaultRetrievalTopK || 5,
                targetDataSourceIds: ragCfg?.dataSources?.filter(ds => ds.isEnabled).map(ds => ds.dataSourceNameOrId),
                ...(ragCfg?.defaultRetrievalStrategy && {
                  strategy: strategyMap[ragCfg.defaultRetrievalStrategy] ?? 'similarity',
                }),
            };
            const ragResult = await this.retrievalAugmentor.retrieveContext(currentQueryForRag, retrievalOptions);
            augmentedContextFromRAG = ragResult.augmentedContext;
            lastRagSources = ragResult.retrievedChunks;
            this.addTraceEntry(ReasoningEntryType.RAG_QUERY_RESULT, 'RAG context retrieved.', {
              length: augmentedContextFromRAG.length,
              chunkCount: ragResult.retrievedChunks?.length ?? 0,
            });
            // Emit the retrieved chunks to the stream so streaming output guardrails
            // (e.g. Grounding Guard) can verify each generated TEXT_DELTA against the
            // same sources the LLM is about to see. The chunk also reaches client
            // consumers who want to display source attribution alongside the response.
            if (ragResult.retrievedChunks && ragResult.retrievedChunks.length > 0) {
              yield this.createOutputChunk(
                turnInput.interactionId,
                GMIOutputChunkType.RAG_SOURCES_AVAILABLE,
                { ragSources: ragResult.retrievedChunks },
              );
            }
          }
        }

        if (isUserInitiatedTurn && currentTurnText) {
          // Recall is limited to this turn's user, session and conversation scopes.
          assembledMemoryContext = await this.memoryBridge?.assembleContext(currentTurnText, {
            sessionId: turnInput.sessionId,
            conversationId: this.getConversationIdForTurn(turnInput),
            organizationId: this.getOrganizationIdForTurn(turnInput),
          }) ?? null;
        }

        const promptExecContext = this.buildPromptExecutionContext();
        const baseSystemPrompts = Array.isArray(this.activePersona.baseSystemPrompt)
            ? this.activePersona.baseSystemPrompt
            : typeof this.activePersona.baseSystemPrompt === 'object' && 'template' in this.activePersona.baseSystemPrompt
                ? [{ content: this.activePersona.baseSystemPrompt.template, priority: 1}]
                : typeof this.activePersona.baseSystemPrompt === 'string'
                    ? [{ content: this.activePersona.baseSystemPrompt, priority: 1}]
                    : [];

        const systemPrompts = [...baseSystemPrompts];
        const rollingSummaryText = typeof turnInput.metadata?.rollingSummary?.text === 'string'
          ? turnInput.metadata.rollingSummary.text.trim()
          : '';
        if (rollingSummaryText) {
          systemPrompts.push({
            content: `Rolling Memory Summary (compressed)\n${rollingSummaryText}`,
            priority: 50,
          });
        }
        const promptProfileInstructions = typeof turnInput.metadata?.promptProfile?.systemInstructions === 'string'
          ? turnInput.metadata.promptProfile.systemInstructions.trim()
          : '';
        if (promptProfileInstructions) {
          systemPrompts.push({
            content: promptProfileInstructions,
            priority: 60,
          });
        }
        const discoveryPromptContext =
          typeof turnInput.metadata?.capabilityDiscovery?.promptContext === 'string'
            ? turnInput.metadata.capabilityDiscovery.promptContext.trim()
            : '';
        if (discoveryPromptContext) {
          systemPrompts.push({
            content: `Capability Discovery Context\n${discoveryPromptContext}`,
            priority: 55,
          });
        }
        const skillPromptContext =
          typeof turnInput.metadata?.skillPromptContext === 'string'
            ? turnInput.metadata.skillPromptContext.trim()
            : '';
        if (skillPromptContext) {
          systemPrompts.push({
            content: skillPromptContext,
            priority: 57,
          });
        }
        if (structuredReply) {
          systemPrompts.push({ content: structuredReply.instruction, priority: 900 });
        }
        // the persona's hard limits close the system prompt, after everything the turn added above
        const hardLimits = hardLimitsBlock(this.activePersona.hardLimits);
        if (hardLimits) {
          systemPrompts.push({ content: hardLimits, priority: HARD_LIMITS_PRIORITY });
        }

        const promptConversation = this.buildPromptConversation({
          durableHistory: durableHistoryForPrompt,
          historyAtTurnStart,
          currentUserMessage,
          turnMessages,
        });

        const promptComponents: PromptComponents = {
          systemPrompts,
          conversationHistory: promptConversation.conversationHistory,
          currentTurnMessageCount: promptConversation.currentTurnMessageCount,
          userInput: promptConversation.userInput,
          retrievedContext: [
            assembledMemoryContext?.contextText,
            augmentedContextFromRAG,
            injectedLongTermMemoryContext,
          ].filter(Boolean).join("\n\n---\n\n"),
          assembledMemoryContext: assembledMemoryContext ?? undefined,
          // tools: this.activePersona.embeddedTools, // If ITool[] and PromptComponents.tools takes ITool[]
        };

        const gateway = this.config.completionGateway;
        const preferredModelIdFromInput = turnInput.metadata?.options?.preferredModelId as string | undefined;
        const modelIdToUse = preferredModelIdFromInput || this.activePersona.defaultModelId || this.config.defaultLlmModelId;
        const providerIdForModel = this.activePersona.defaultProviderId || this.config.defaultLlmProviderId;

        if (!modelIdToUse) {
            throw new GMIError("Could not determine modelId for LLM call.", GMIErrorCode.CONFIGURATION_ERROR, { turnId });
        }

        const plannedToolFailureMode =
          turnInput.metadata?.executionPolicy?.toolFailureMode === 'fail_closed'
            ? 'fail_closed'
            : 'fail_open';
        const plannedToolSelectionMode =
          turnInput.metadata?.executionPolicy?.toolSelectionMode === 'discovered'
            ? 'discovered'
            : 'all';
        const capabilityDiscoveryResult = turnInput.metadata?.capabilityDiscovery?.result;

        let toolsForLLM = await this.toolOrchestrator.listAvailableTools({
          personaId: this.activePersona.id,
          personaCapabilities: this.activePersona.allowedCapabilities || [],
          userContext: this.currentUserContext,
        });
        if (
          plannedToolSelectionMode === 'discovered' &&
          capabilityDiscoveryResult &&
          typeof this.toolOrchestrator.listDiscoveredTools === 'function'
        ) {
          const discoveredTools = await this.toolOrchestrator.listDiscoveredTools(
            capabilityDiscoveryResult,
            {
              personaId: this.activePersona.id,
              personaCapabilities: this.activePersona.allowedCapabilities || [],
              userContext: this.currentUserContext,
            },
          );
          if (discoveredTools.length > 0) {
            toolsForLLM = discoveredTools;
          }
        }

        // Every completion option the persona and the turn set (D4b), the turn's
        // over the persona's; one neither sets is not sent, so the provider's
        // default applies. Tools, user and streaming are the GMI's.
        const turnOptions = (turnInput.metadata?.options ?? {}) as Record<string, unknown>;
        const personaOptions = (this.activePersona.defaultModelCompletionOptions ?? {}) as Record<string, unknown>;
        // The provider's end-user field: the host's choice when the turn names one
        // (null sends none), else the turn's user.
        const providerUserId = turnInput.metadata && 'providerUserId' in turnInput.metadata
          ? turnInput.metadata.providerUserId
          : this.currentUserContext.userId;
        const llmOptions: ModelCompletionOptions = {
          ...pickCompletionOptions(personaOptions),
          ...pickCompletionOptions(turnOptions),
          ...(stepCacheDiagnostics ? { cacheDiagnostics: { ...stepCacheDiagnostics } } : {}),
          // The turn's stop (the caller's abort signal or shutdown()): aborting it ends
          // the model call in progress with the provider's abort chunk, and every
          // later call of the turn at once.
          abortSignal: stop.signal,
          tools: toolsForLLM.length > 0 ? toolsForLLM.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema }})) : undefined,
          // Only with tools: OpenAI rejects a tool_choice on a request that offers none
          // (HTTP 400, "'tool_choice' is only allowed when 'tools' are specified").
          toolChoice: toolsForLLM.length > 0
            ? ((turnOptions.toolChoice as ModelCompletionOptions['toolChoice']) ?? (personaOptions.toolChoice as ModelCompletionOptions['toolChoice']) ?? "auto")
            : undefined,
          ...(providerUserId ? { userId: providerUserId } : {}),
          stream: true,
        };
        // A schema travels to the gateway, which lowers it per hop (D9); it is not a provider option.
        const responseSchema = (turnOptions.responseSchema as ZodType | undefined) ?? structuredReply?.zod;
        const schemaName = (turnOptions.schemaName as string | undefined) ?? (structuredReply && responseSchema === structuredReply.zod ? structuredReply.name : undefined);
        // The structured reply's instruction is in the system prompt already; the gateway adds none for its schema.
        const schemaInPrompt = responseSchema !== undefined && responseSchema === structuredReply?.zod;

        // The gateway's route: the model asked for, the last user message (its text
        // is the router's task hint: the text parts of a multimodal message, and on
        // a continuation the message being answered, never the continuation's own
        // internal text), the tools, and the call options each fallback hop derives
        // its overrides from. Every hop that could not start is traced.
        let lastHopError: Error | undefined;
        let lastUserMessage: ChatMessage | undefined;
        for (let i = historyAtTurnStart.length - 1; i >= 0 && !lastUserMessage; i--) {
          if (historyAtTurnStart[i].role === 'user') lastUserMessage = historyAtTurnStart[i];
        }
        const route: CompletionRoute | undefined = gateway
          ? {
              modelId: modelIdToUse,
              providerId: providerIdForModel,
              messages: lastUserMessage ? [lastUserMessage] : [],
              tools: llmOptions.tools,
              callOptions: { maxTokens: llmOptions.maxTokens, effort: llmOptions.effort, cache: llmOptions.cache },
              onFallback: ({ from, to, hop, error }) => this.addTraceEntry(ReasoningEntryType.WARNING, `Model fallback from '${from}' to '${to}' (hop ${hop}): ${error.message}`),
              onHopFailure: ({ providerId, hop, error }) => {
                lastHopError = error;
                this.addTraceEntry(ReasoningEntryType.WARNING, `Provider '${providerId}' (hop ${hop}) could not start: ${error.message}`);
              },
            }
          : undefined;

        // The hop that serves this step: the one that served the turn's last
        // step, else the route's first hop that can start. Resolved before the
        // prompt is built, so the prompt is budgeted for the serving model (D1).
        let resolution: CompletionResolution | null = null;
        if (gateway && route) {
          try {
            resolution = this.turnResolution ?? (await gateway.resolve(route));
          } catch (resolveError) {
            // resolve() throws only when the primary cannot be set up (no
            // credentials, a provider or model that does not resolve): a
            // configuration error, not a failure of the turn's processing.
            if (resolveError instanceof GMIError) throw resolveError;
            throw new GMIError(
              resolveError instanceof Error ? resolveError.message : String(resolveError),
              GMIErrorCode.CONFIGURATION_ERROR,
              { turnId, providerId: providerIdForModel, modelId: modelIdToUse },
            );
          }
          if (!resolution) {
            throw new GMIError(
              `No model provider could serve the turn${lastHopError ? `: ${lastHopError.message}` : '.'}`,
              GMIErrorCode.LLM_PROVIDER_UNAVAILABLE,
              { turnId },
            );
          }
        }

        // What the serving attempt produced; read after the hop loop.
        let currentIterationTextResponse = "";
        let currentIterationToolCallRequests: ToolCallRequest[] = [];
        // Extended-thinking blocks emitted this step (Anthropic with thinking
        // enabled). Captured from the final chunk and stored on the assistant
        // turn so the next tool turn replays them verbatim, which Anthropic
        // requires. Empty for every non-thinking step.
        let currentIterationThinkingBlocks: ThinkingBlock[] = [];
        let stepUsage: ModelUsage | undefined;
        let stepFinishReason: string | null = null;
        let stepFinalChunk: ModelCompletionResponse | undefined;
        let stepStructuredOutput: unknown;
        // Whether the answering attempt's provider payload carried the response schema (the gateway says).
        // Initialised through the assertion, so tsc does not narrow it to undefined where it is read.
        let stepSchemaInPayload = undefined as boolean | undefined;
        let modelTargetInfo!: ModelTargetInfo;

        // One attempt per hop. A failure before any output moves to the next
        // hop and rebuilds the prompt for that hop's model (D3); after output
        // there is no fallback for the step. Without a gateway the loop runs once.
        hopLoop: for (;;) {
          if (resolution) {
            (this.llmProviderManager as unknown as { setResolution?: (r: CompletionResolution) => void }).setResolution?.(resolution);
          }
          modelTargetInfo = resolution
            ? {
                modelId: resolution.modelId,
                providerId: resolution.providerId,
                maxContextTokens: resolution.maxContextTokens,
                capabilities: resolution.capabilities,
                promptFormatType: this.determinePromptFormat(),
                toolSupport: { supported: resolution.capabilities.includes('tool_use'), format: resolution.toolFormat },
              }
            : await this.legacyModelTargetInfo(modelIdToUse, providerIdForModel);

          const promptEngineResult: PromptEngineResult = await this.promptEngine.constructPrompt(
            promptComponents, modelTargetInfo, promptExecContext
          );

          promptEngineResult.issues?.forEach(issue => this.addTraceEntry(ReasoningEntryType.WARNING, `Prompt Engine Issue: ${issue.message}`, issue as any));
          // A failed template leaves the prompt empty, and every provider takes
          // a non-empty ChatMessage[]; fail the turn rather than send nothing.
          const promptMessages = promptEngineResult.prompt;
          if (!Array.isArray(promptMessages) || promptMessages.length === 0) {
            throw new GMIError(
              `Prompt construction produced no chat messages for model '${modelTargetInfo.modelId}' (template '${promptEngineResult.metadata?.templateUsed ?? 'unknown'}').`,
              GMIErrorCode.GMI_PROCESSING_ERROR,
              {
                turnId,
                templateUsed: promptEngineResult.metadata?.templateUsed,
                issues: promptEngineResult.issues?.filter((issue) => issue.type === 'error'),
              },
            );
          }
          this.addTraceEntry(ReasoningEntryType.PROMPT_CONSTRUCTION_COMPLETE, `Prompt constructed for model ${modelTargetInfo.modelId}.`);

          // A turn's response schema that the primary hop's payload does not carry
          // rides the prompt. It goes in before the host's hook, as generateText puts
          // it in before onBeforeGeneration, so a hook that removes it removes it,
          // and the gateway adds no second copy on that hop. Fallback hops keep the
          // gateway's per-hop rule.
          let promptForHook: ChatMessage[] = promptMessages;
          let attemptSchemaInPrompt = schemaInPrompt;
          if (gateway && resolution && resolution.hop === 0 && responseSchema && !schemaInPrompt) {
            const instruction = gateway.schemaInstruction?.(resolution, responseSchema, schemaName);
            if (instruction) {
              promptForHook = withSystemMessage(promptMessages, instruction);
              attemptSchemaInPrompt = true;
            }
          }

          // The host's hook sees each attempt's prompt, a fallback hop's rebuilt one
          // included, and may replace it for that attempt; the history is untouched.
          let sendMessages: ChatMessage[] = promptForHook;
          if (this.config.beforeModelCall) {
            try {
              const replaced = await this.config.beforeModelCall({
                turnId,
                stepIndex: safetyBreak - 1,
                hop: resolution?.hop ?? 0,
                providerId: modelTargetInfo.providerId,
                modelId: modelTargetInfo.modelId,
                messages: [...promptForHook],
              });
              if (Array.isArray(replaced)) {
                if (replaced.length > 0) {
                  sendMessages = replaced;
                } else {
                  this.addTraceEntry(ReasoningEntryType.WARNING, 'beforeModelCall returned no messages; the built prompt is sent.');
                }
              }
            } catch (hookError) {
              this.addTraceEntry(ReasoningEntryType.WARNING, `beforeModelCall hook failed: ${hookError instanceof Error ? hookError.message : String(hookError)}`);
            }
          }

          let attempt: AsyncIterable<ModelCompletionResponse>;
          let attemptOutcome: Promise<CompletionOutcome> | undefined;
          if (gateway && resolution) {
            const gatewayAttempt: CompletionAttempt = gateway.stream(resolution, sendMessages, llmOptions, responseSchema, schemaName, attemptSchemaInPrompt);
            attempt = gatewayAttempt;
            attemptOutcome = gatewayAttempt.outcome;
            stepSchemaInPayload = gatewayAttempt.schemaInPayload;
          } else {
            const provider = this.llmProviderManager.getProvider(modelTargetInfo.providerId);
            if (!provider) {
                throw new GMIError(`LLM Provider '${modelTargetInfo.providerId}' not found or not initialized.`, GMIErrorCode.LLM_PROVIDER_UNAVAILABLE);
            }
            attempt = provider.generateCompletionStream(modelTargetInfo.modelId, sendMessages, llmOptions);
          }
          this.addTraceEntry(ReasoningEntryType.LLM_CALL_START, `Streaming from ${modelTargetInfo.modelId}${resolution ? ` (hop ${resolution.hop})` : ''}. Tools: ${toolsForLLM.length}.`);

          let textDeltaEmitted = false;
          // The usage on the error chunk that ended the step, when it carried one.
          let errorChunkUsage: ModelUsage | undefined;
          try {
            for await (const chunk of attempt) {
              if (chunk.error) {
                errorChunkUsage = asUsageReport(chunk.usage);
                throw new GMIError(`LLM stream error: ${chunk.error.message}`, GMIErrorCode.LLM_PROVIDER_ERROR, chunk.error.details);
              }

              if (chunk.responseTextDelta) {
                currentIterationTextResponse += chunk.responseTextDelta;
                aggregatedResponseText += chunk.responseTextDelta; // Aggregate for final output
                if (!structuredReply || structuredReply.streamDeltas) {
                  yield this.createOutputChunk(turnInput.interactionId, GMIOutputChunkType.TEXT_DELTA, chunk.responseTextDelta, { usage: chunk.usage });
                }
                textDeltaEmitted = true;
              }

              // Handle fully formed tool_calls if present in the chunk's message
              const choice = chunk.choices?.[0];
              // Capture extended-thinking blocks from the final chunk so they ride
              // the assistant turn into history (replayed verbatim next tool turn).
              if (choice?.message?.thinkingBlocks?.length) {
                currentIterationThinkingBlocks = choice.message.thinkingBlocks;
              }
              // The gateway lifts a streamed schema tool call into `structuredOutput` (D9).
              const structured = (chunk as { structuredOutput?: unknown }).structuredOutput;
              if (structured !== undefined) stepStructuredOutput = structured;

              if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
                currentIterationToolCallRequests = choice.message.tool_calls.map((tc: any) => ({ // tc is from IProvider.ChatMessage.tool_calls
                    id: tc.id || `toolcall-${uuidv4()}`, // Ensure ID
                    name: tc.function.name,
                    arguments: typeof tc.function.arguments === 'string'
                        ? JSON.parse(tc.function.arguments)
                        : tc.function.arguments,
                    ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
                }));
                aggregatedToolCalls.push(...currentIterationToolCallRequests); // Aggregate for final output
                yield this.createOutputChunk(
                  turnInput.interactionId,
                  GMIOutputChunkType.TOOL_CALL_REQUEST,
                  [...currentIterationToolCallRequests],
                  {
                    metadata: {
                      executionMode: 'internal',
                      requiresExternalToolResult: false,
                    },
                  },
                );
                this.addTraceEntry(ReasoningEntryType.TOOL_CALL_REQUESTED, `LLM requested tool(s).`, { requests: currentIterationToolCallRequests });
              }

              // A provider that sends no deltas: its final content is the step's text, emitted once (D4d).
              if (chunk.isFinal && !textDeltaEmitted && typeof choice?.message?.content === 'string' && choice.message.content.length > 0) {
                currentIterationTextResponse = choice.message.content;
                aggregatedResponseText += choice.message.content;
                if (!structuredReply || structuredReply.streamDeltas) {
                  yield this.createOutputChunk(turnInput.interactionId, GMIOutputChunkType.TEXT_DELTA, choice.message.content, { usage: chunk.usage });
                }
                textDeltaEmitted = true;
              }

              if (chunk.isFinal && choice?.finishReason) {
                stepFinishReason = choice.finishReason;
                this.addTraceEntry(ReasoningEntryType.LLM_CALL_COMPLETE, `LLM stream part finished. Reason: ${choice.finishReason}`, { usage: chunk.usage });
              }
              if (chunk.isFinal) stepFinalChunk = chunk;
              // Usage on every chunk that carries it, choice or not (D4c). Providers report
              // the request's running total, so the turn total takes the step's last value once.
              if (chunk.usage) {
                stepUsage = chunk.usage;
                yield this.createOutputChunk(turnInput.interactionId, GMIOutputChunkType.USAGE_UPDATE, chunk.usage);
              }
            } // End LLM stream
          } catch (stepError) {
            // A step that fails once its attempt has started was still billed.
            // Providers report the request's running total, so the bill is the
            // latest report: the error chunk's own usage, else the usage the
            // error carries (a refused turn reports it), else the last usage the
            // step reported. It counts toward the turn once and is reported on a
            // USAGE_UPDATE of its own, marked as a failed attempt's, because no
            // STEP_FINISHED will carry it.
            const billed =
              errorChunkUsage ??
              asUsageReport((stepError as { details?: { usage?: unknown } } | null | undefined)?.details?.usage) ??
              stepUsage;
            if (billed) {
              addUsage(aggregatedUsage, billed);
              yield this.createOutputChunk(turnInput.interactionId, GMIOutputChunkType.USAGE_UPDATE, billed, {
                metadata: { attemptFailed: true, hop: resolution?.hop ?? 0, providerId: modelTargetInfo.providerId, modelId: modelTargetInfo.modelId },
              });
            }
            throw stepError;
          }

          if (gateway && route && resolution && attemptOutcome) {
            const outcome = await attemptOutcome;
            if (outcome.kind === 'hopFailed') {
              const failedHop = resolution;
              lastHopError = outcome.error;
              this.addTraceEntry(ReasoningEntryType.WARNING, `Provider '${failedHop.providerId}' (hop ${failedHop.hop}) failed before any output: ${outcome.error.message}`);
              // A failed attempt can still be billed (a refused turn reports its
              // usage). It counts toward the turn once, whether or not the turn
              // goes on, and is reported on its own USAGE_UPDATE: no STEP_FINISHED
              // carries it.
              if (outcome.usage) {
                addUsage(aggregatedUsage, outcome.usage);
                yield this.createOutputChunk(turnInput.interactionId, GMIOutputChunkType.USAGE_UPDATE, outcome.usage, {
                  metadata: { attemptFailed: true, hop: failedHop.hop, providerId: failedHop.providerId, modelId: failedHop.modelId },
                });
              }
              if (!outcome.retryable) {
                throw new GMIError(`LLM provider error: ${outcome.error.message}`, GMIErrorCode.LLM_PROVIDER_ERROR, { turnId, providerId: failedHop.providerId, hop: failedHop.hop });
              }
              const next = await gateway.resolve(route, failedHop);
              if (!next) {
                throw new GMIError(`LLM provider error after ${failedHop.hop + 1} hop(s): ${lastHopError.message}`, GMIErrorCode.LLM_PROVIDER_ERROR, { turnId, providerId: failedHop.providerId, hop: failedHop.hop });
              }
              // Nothing of the failed attempt carries over to the next hop.
              currentIterationTextResponse = "";
              currentIterationToolCallRequests = [];
              currentIterationThinkingBlocks = [];
              stepUsage = undefined;
              stepFinishReason = null;
              stepFinalChunk = undefined;
              stepStructuredOutput = undefined;
              resolution = next;
              continue hopLoop;
            }
          }
          break hopLoop;
        }
        if (resolution) this.turnResolution = resolution;

        // The step's usage, counted once (D4c).
        if (stepUsage) addUsage(aggregatedUsage, stepUsage);

        // The next step's diagnostics compare against this step's response.
        if (stepCacheDiagnostics) {
          const responseId = stepFinalChunk?.id;
          stepCacheDiagnostics = { previousMessageId: typeof responseId === 'string' && responseId.length > 0 ? responseId : null };
        }

        // The step boundary (D4d): the step's own text, finish reason, hop and usage.
        const stepPayload: StepFinishedChunkPayload = {
          stepIndex: safetyBreak - 1,
          text: currentIterationTextResponse,
          finishReason: stepFinishReason,
          providerId: modelTargetInfo.providerId,
          modelId: modelTargetInfo.modelId,
          hop: resolution?.hop ?? 0,
          ...(stepUsage ? { usage: stepUsage } : {}),
          ...(stepFinalChunk?.modelId ? { responseModel: stepFinalChunk.modelId } : {}),
          ...(stepFinalChunk?.serviceTier ? { serviceTier: stepFinalChunk.serviceTier } : {}),
          ...(stepFinalChunk?.id ? { providerMessageId: stepFinalChunk.id } : {}),
          ...(stepFinalChunk?.cacheDiagnostics !== undefined ? { cacheDiagnostics: stepFinalChunk.cacheDiagnostics } : {}),
          ...(stepStructuredOutput !== undefined ? { structuredOutput: stepStructuredOutput } : {}),
          ...(currentIterationThinkingBlocks.length > 0 ? { thinkingBlocks: [...currentIterationThinkingBlocks] } : {}),
        };
        yield this.createOutputChunk(turnInput.interactionId, GMIOutputChunkType.STEP_FINISHED, stepPayload, {
          ...(stepFinishReason ? { finishReason: stepFinishReason } : {}),
          ...(stepUsage ? { usage: stepUsage } : {}),
        });

        // The structured check, on a step that answered with text rather than tool calls. A reply that does not match
        // is asked for again: the invalid reply and the repair request join this turn's prompt and never the durable
        // history, and the turn's text starts over with the next attempt.
        if (structuredReply && currentIterationToolCallRequests.length === 0) {
          structuredAttempts += 1;
          const lifted = stepStructuredOutput !== undefined;
          const check = lifted ? structuredReply.checkValue(stepStructuredOutput) : checkStructuredReply(currentIterationTextResponse, structuredReply);
          // 'provider_schema' only when the answering hop's payload carried the schema; a hop that sent it in the
          // prompt alone reports 'prompt_only'. A gateway that does not say keeps the earlier report.
          const enforcement = lifted ? 'forced_tool' : gateway && stepSchemaInPayload !== false ? 'provider_schema' : 'prompt_only';
          if (check.ok) {
            structuredResult = { value: check.value, meta: { schemaName: structuredReply.name, valid: true, attempts: structuredAttempts, enforcement, stage: 'model' } };
            if (lifted && !currentIterationTextResponse) {
              // the forced tool call carried the reply: its text is the value, so the final response holds it too
              currentIterationTextResponse = JSON.stringify(check.value);
              aggregatedResponseText += currentIterationTextResponse;
            }
          } else {
            const canRetry = structuredAttempts <= structuredReply.maxRetries && safetyBreak < maxToolLoopIterations;
            if (canRetry) {
              this.addTraceEntry(ReasoningEntryType.WARNING, `The reply did not match the schema "${structuredReply.name}" (attempt ${structuredAttempts}); asking again.`, { issues: check.issues });
              turnMessages.push({ role: 'assistant', content: currentIterationTextResponse || null });
              turnMessages.push({ role: 'user', content: structuredRepairMessage(check.issues, structuredReply, currentIterationTextResponse) });
              aggregatedResponseText = '';
              continue main_processing_loop;
            }
            if (structuredReply.onExhausted === 'error') {
              throw new GMIError(
                `The reply did not match the schema "${structuredReply.name}" after ${structuredAttempts} attempt(s).`,
                GMIErrorCode.STRUCTURED_OUTPUT_INVALID,
                { schemaName: structuredReply.name, attempts: structuredAttempts, issues: check.issues },
              );
            }
            structuredResult = { value: check.value ?? null, meta: { schemaName: structuredReply.name, valid: false, attempts: structuredAttempts, enforcement, stage: 'model', issues: check.issues } };
          }
        }

        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: currentIterationTextResponse || null,
          tool_calls: currentIterationToolCallRequests.length > 0
            ? currentIterationToolCallRequests.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
              }))
            : undefined,
          ...(currentIterationThinkingBlocks.length > 0 && { thinkingBlocks: currentIterationThinkingBlocks }),
        };
        this.conversationHistoryManager.push(assistantMessage);
        turnMessages.push(assistantMessage);

        if (currentIterationToolCallRequests.length > 0) {
          if (ownsState()) this.state = GMIPrimeState.AWAITING_TOOL_RESULT;
          const toolExecutionResults: ToolCallResult[] = [];
          // The call awaiting its result; cleared once processToolCall returns.
          let callInFlight: ToolCallRequest | undefined;
          let toolRoundFailure: { error: unknown } | undefined;
          try {
            for (const toolCallReq of currentIterationToolCallRequests) {
              const requestDetails: ToolExecutionRequestDetails = {
                toolCallRequest: toolCallReq,
                gmiId: this.gmiId, personaId: this.activePersona.id,
                personaCapabilities: this.activePersona.allowedCapabilities || [],
                userContext: this.currentUserContext, correlationId: turnId,
                sessionData: this.buildToolSessionData(turnInput),
              };
              this.addTraceEntry(ReasoningEntryType.TOOL_EXECUTION_START, `Orchestrating tool: ${toolCallReq.name}`, { reqId: toolCallReq.id });
              callInFlight = toolCallReq;
              const result = await this.toolOrchestrator.processToolCall(requestDetails);
              callInFlight = undefined;
              toolExecutionResults.push(result);
              this.addTraceEntry(ReasoningEntryType.TOOL_EXECUTION_RESULT, `Tool '${toolCallReq.name}' result. Success: ${!result.isError}`, { result });
              if (result.isError && plannedToolFailureMode === 'fail_closed') {
                throw new GMIError(
                  `Tool '${toolCallReq.name}' failed and execution policy is fail_closed.`,
                  GMIErrorCode.TOOL_ERROR,
                  {
                    toolCallId: toolCallReq.id,
                    toolName: toolCallReq.name,
                    errorDetails: result.errorDetails,
                  },
                );
              }
            }
          } catch (error) {
            toolRoundFailure = { error };
            toolExecutionResults.push(...this.resultsForUnfinishedToolCalls(
              currentIterationToolCallRequests,
              toolExecutionResults.length,
              callInFlight,
              error,
            ));
          }
          // Recorded on success and failure alike, so the history this turn
          // leaves answers every call its assistant message declared. Each
          // recorded result is also published as a TOOL_RESULT chunk (D4e).
          for (const tcResult of toolExecutionResults) {
            turnMessages.push(this.conversationHistoryManager.updateWithToolResult(tcResult));
            const toolResultPayload: ToolResultChunkPayload = {
              toolCallId: tcResult.toolCallId,
              name: tcResult.toolName,
              result: tcResult.output,
              isError: tcResult.isError === true,
              ...(tcResult.errorDetails !== undefined ? { errorDetails: tcResult.errorDetails } : {}),
            };
            yield this.createOutputChunk(turnInput.interactionId, GMIOutputChunkType.TOOL_RESULT, toolResultPayload);
          }
          if (toolRoundFailure) throw toolRoundFailure.error;
          if (ownsState()) this.state = GMIPrimeState.PROCESSING;
          continue main_processing_loop;
        }
        break main_processing_loop; // Break if no tool calls
      }

      await this.memoryBridge?.syncForTurn(turnInput, aggregatedResponseText);

      await this.performPostTurnIngestion(
        this.stringifyTurnContent(turnInput.content) ?? '',
        aggregatedResponseText
      );

      // Check and trigger all metaprompts (turn_interval, event_based, manual).
      // Only user messages count toward turn_interval triggers: tool
      // continuations, system messages and tool responses do not.
      const isUserTurn =
        turnInput.metadata?.isToolContinuation !== true &&
        (turnInput.type === GMIInteractionType.TEXT ||
          turnInput.type === GMIInteractionType.MULTIMODAL_CONTENT);
      await this.metapromptExecutor.checkAndTriggerMetaprompts(turnId, { countTurn: isUserTurn });

      // Prepare the final GMIOutput for the generator's return value
      const finalTurnOutput: GMIOutput = {
        isFinal: true,
        responseText: aggregatedResponseText || null,
        toolCalls: aggregatedToolCalls.length > 0 ? aggregatedToolCalls : undefined,
        uiCommands: aggregatedUiCommands.length > 0 ? aggregatedUiCommands : undefined, // Assuming GMI can populate these
        usage: aggregatedUsage,
        error: lastErrorForOutput,
        ragSources: lastRagSources,
        ...(structuredResult ? { structuredOutput: structuredResult } : {}),
      };
      return finalTurnOutput; // Return the aggregated output

    } catch (error: any) {
      // A GMIError keeps its code (an in-band provider error stays
      // LLM_PROVIDER_ERROR); anything else is a processing error (D4f).
      const gmiError = createGMIErrorFromError(
        error,
        error instanceof GMIError ? error.code : GMIErrorCode.GMI_PROCESSING_ERROR,
        { turnId },
        `Error in GMI turn '${turnId}'.`,
      );
      if (ownsState()) this.state = GMIPrimeState.ERRORED;
      lastErrorForOutput = { code: gmiError.code, message: gmiError.message, details: gmiError.details };
      this.addTraceEntry(ReasoningEntryType.ERROR, `GMI processing error: ${gmiError.message}`, gmiError.toPlainObject());
      console.error(`GMI (ID: ${this.gmiId}) error in turn '${turnId}':`, gmiError);
      yield this.createOutputChunk(turnInput.interactionId, GMIOutputChunkType.ERROR, gmiError.message, { errorDetails: gmiError.toPlainObject() });
      
      // Still need to return a GMIOutput for the generator contract
      return {
        isFinal: true,
        responseText: null,
        error: lastErrorForOutput,
        usage: aggregatedUsage, // Could be partial
      };
    } finally {
      // The turn's work is done: shutdown() stops waiting for it, and the
      // caller's signal no longer reaches it.
      this.runningTurns.delete(turnNumber);
      callerSignal?.removeEventListener('abort', forwardAbort);
      endTurn();
      // A newer turn may already own the lifecycle state (this generator was
      // drained after a failure, once the next turn had started), or shutdown()
      // took it back; leave the state and the trace's turn id alone then.
      if (
        ownsState() &&
        this.state !== GMIPrimeState.ERRORED &&
        this.state !== GMIPrimeState.AWAITING_TOOL_RESULT
      ) {
        this.state = GMIPrimeState.READY;
      }
      // This final chunk is part of the stream, not the return value of the generator
      yield this.createOutputChunk(turnInput.interactionId, GMIOutputChunkType.FINAL_RESPONSE_MARKER, 'Turn processing sequence complete.', { isFinal: true });
      this.addTraceEntry(ReasoningEntryType.INTERACTION_END, `Turn '${turnId}' finished. GMI State: ${this.state}.`);
      // Checked after the yield: a newer turn can start while this one waits there.
      if (ownsState() && this.reasoningTrace) this.reasoningTrace.turnId = undefined;
    }
  }

  /** @inheritdoc */
  public async handleToolResult(
    toolCallId: string,
    toolName: string,
    resultPayload: ToolResultPayload,
    userId: string,
    // userApiKeys?: Record<string, string> // Not directly used by GMI, providers handle keys
  ): Promise<GMIOutput> {
    return this.handleToolResults(
      [
        {
          toolCallId,
          toolName,
          output: resultPayload.type === 'success' ? resultPayload.result : resultPayload.error,
          isError: resultPayload.type === 'error',
          errorDetails: resultPayload.type === 'error' ? resultPayload.error : undefined,
        },
      ],
      userId,
    );
  }

  /** @inheritdoc */
  public async handleToolResults(
    toolResults: ToolCallResult[],
    _userId: string,
    // userApiKeys?: Record<string, string> // Not directly used by GMI, providers handle keys
  ): Promise<GMIOutput> {
    if (!this.isInitialized) {
        throw new GMIError("GMI is not initialized. Cannot handle tool result.", GMIErrorCode.NOT_INITIALIZED);
    }
    if (!Array.isArray(toolResults) || toolResults.length === 0) {
        throw new GMIError(
          'At least one tool result is required to continue the turn.',
          GMIErrorCode.VALIDATION_ERROR,
        );
    }
    // Allow handling tool results if processing or specifically awaiting
    if (
      this.state !== GMIPrimeState.AWAITING_TOOL_RESULT &&
      this.state !== GMIPrimeState.PROCESSING &&
      this.state !== GMIPrimeState.READY
    ) {
        this.addTraceEntry(
          ReasoningEntryType.WARNING,
          `handleToolResults called when GMI state is ${this.state}. Expected READY, AWAITING_TOOL_RESULT, or PROCESSING.`,
          {
            toolCallIds: toolResults.map((toolResult) => toolResult.toolCallId),
            toolNames: toolResults.map((toolResult) => toolResult.toolName),
          },
        );
        // Depending on desired robustness, could throw an error or try to proceed.
    }
    this.state = GMIPrimeState.PROCESSING; // Set state to processing

    // Use current turnId if available, or generate a new interactionId for this specific handling
    const interactionId = this.reasoningTrace?.turnId || `tool_handler_turn_${uuidv4()}`;

    this.addTraceEntry(
      ReasoningEntryType.TOOL_EXECUTION_RESULT,
      toolResults.length === 1
        ? `Received external tool result for '${toolResults[0].toolName}' (ID: ${toolResults[0].toolCallId}) to be processed.`
        : `Received ${toolResults.length} external tool results to be processed together.`,
      {
        interactionId,
        toolResults: toolResults.map((toolResult) => ({
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          success: !toolResult.isError,
        })),
      },
    );

    toolResults.forEach((toolResult) => this.conversationHistoryManager.updateWithToolResult(toolResult));

    // Construct a system turn input to represent the continuation after tool result
    const systemTurnInput: GMITurnInput = {
        interactionId,
        userId: this.currentUserContext.userId, // Use the GMI's current user context
        sessionId: this.reasoningTrace?.sessionId,
        type: GMIInteractionType.SYSTEM_MESSAGE, // Or a specific type for internal continuation
        content:
          toolResults.length === 1
            ? `Internally processing result for tool '${toolResults[0].toolName}'.`
            : `Internally processing ${toolResults.length} external tool results.`,
        metadata: {
            isToolContinuation: true,
            originalToolCallId: toolResults.length === 1 ? toolResults[0].toolCallId : undefined,
            originalToolCallIds: toolResults.map((toolResult) => toolResult.toolCallId),
            ...(this.reasoningTrace?.conversationId
              ? { conversationId: this.reasoningTrace.conversationId }
              : {}),
            ...(this.reasoningTrace?.organizationId
              ? { organizationId: this.reasoningTrace.organizationId }
              : {}),
        }
    };
    
    // Collect all chunks from processTurnStream to form a single GMIOutput
    let _aggregatedResponseText = "";
    const aggregatedToolCalls: ToolCallRequest[] = [];
    const aggregatedUsage: CostAggregator = { totalTokens: 0, promptTokens: 0, completionTokens: 0, breakdown: [] };
    let _lastErrorForOutput: GMIOutput['error'] = undefined;

    const stream = this.processTurnStream(systemTurnInput); // This now returns GMIOutput
    let finalGmiOutputFromStream: GMIOutput | undefined;

    while (true) {
      const { value, done } = await stream.next();
      if (done) {
        finalGmiOutputFromStream = value;
        break;
      }

      const chunk = value;
      if (chunk.type === GMIOutputChunkType.TEXT_DELTA && typeof chunk.content === 'string') {
        _aggregatedResponseText += chunk.content;
      }
      if (chunk.type === GMIOutputChunkType.TOOL_CALL_REQUEST && Array.isArray(chunk.content)) {
        aggregatedToolCalls.push(...chunk.content);
      }
      if (chunk.usage) {
        aggregatedUsage.promptTokens += chunk.usage.promptTokens || 0;
        aggregatedUsage.completionTokens += chunk.usage.completionTokens || 0;
        aggregatedUsage.totalTokens = aggregatedUsage.promptTokens + aggregatedUsage.completionTokens;
        if (chunk.usage.costUSD) aggregatedUsage.totalCostUSD = (aggregatedUsage.totalCostUSD || 0) + chunk.usage.costUSD;
      }
      if (chunk.type === GMIOutputChunkType.ERROR) {
        _lastErrorForOutput =
          chunk.errorDetails || { code: GMIErrorCode.GMI_PROCESSING_ERROR, message: String(chunk.content) };
      }
    }

    if (!finalGmiOutputFromStream) {
      finalGmiOutputFromStream = {
        isFinal: _lastErrorForOutput ? true : false,
        responseText: _aggregatedResponseText || null,
        toolCalls: aggregatedToolCalls.length > 0 ? aggregatedToolCalls : undefined,
        usage: aggregatedUsage,
        error: _lastErrorForOutput,
      };
    }

    this.addTraceEntry(
      ReasoningEntryType.INTERACTION_END,
      toolResults.length === 1
        ? `Continuation after tool '${toolResults[0].toolName}' (ID: ${toolResults[0].toolCallId}) processed.`
        : `Continuation after ${toolResults.length} external tool results processed.`,
    );
    return finalGmiOutputFromStream;
  }

  /**
   * Performs post-turn RAG ingestion if configured.
   * @private
   */
  private async performPostTurnIngestion(userInput: string, gmiResponse: string): Promise<void> {
    const ragConfig = this.activePersona.memoryConfig?.ragConfig;

    const ingestionTriggers = ragConfig?.ingestionTriggers as PersonaRagConfigIngestionTrigger | undefined;
    const ingestionProcessingConfig = ragConfig?.ingestionProcessing;

    if (!this.retrievalAugmentor || !ragConfig?.enabled || !ingestionTriggers?.onTurnSummary) {
      return;
    }
    
    try {
      const textToSummarize = `User: ${userInput}\n\nAssistant: ${gmiResponse}`;
      let documentContent = textToSummarize;

      // Summarization is an explicit opt-in; ingestion can be cheap even when enabled.
      const summarizationEnabled = ingestionProcessingConfig?.summarization?.enabled === true;
      if (this.utilityAI && summarizationEnabled) {
        const summarizationOptions: SummarizationOptions = {
          desiredLength: ingestionProcessingConfig?.summarization?.targetLength || 'short',
          method: ingestionProcessingConfig?.summarization?.method || 'abstractive_llm',
          modelId: ingestionProcessingConfig?.summarization?.modelId || this.activePersona.defaultModelId || this.config.defaultLlmModelId,
          providerId: ingestionProcessingConfig?.summarization?.providerId || this.activePersona.defaultProviderId || this.config.defaultLlmProviderId,
        };
        this.addTraceEntry(ReasoningEntryType.RAG_INGESTION_DETAIL, "Summarizing turn for RAG ingestion.", { textLength: textToSummarize.length, options: summarizationOptions });
        documentContent = await this.utilityAI.summarize(textToSummarize, summarizationOptions);
      }
      
      const turnIdForMetadata = this.reasoningTrace.turnId || "unknown_turn"; // Handle undefined turnId

      const docToIngest: RagDocumentInput = {
        id: `turnsummary-${this.gmiId}-${turnIdForMetadata}-${uuidv4()}`, // Ensure unique ID
        content: documentContent,
        metadata: {
          gmiId: this.gmiId, personaId: this.activePersona.id, userId: this.currentUserContext.userId,
          timestamp: new Date().toISOString(), type: "conversation_turn_summary",
          turnId: turnIdForMetadata, // Now guaranteed to be a string
        },
        dataSourceId: ragConfig.defaultIngestionDataSourceId,
      };
      const ingestionOptions: RagIngestionOptions = {
        userId: this.currentUserContext.userId, personaId: this.activePersona.id,
      };

      this.addTraceEntry(ReasoningEntryType.RAG_INGESTION_START, "Ingesting turn summary to RAG.", { documentId: docToIngest.id });
      const ingestionResult = await this.retrievalAugmentor.ingestDocuments(docToIngest, ingestionOptions);
      if (ingestionResult.failedCount > 0) {
        this.addTraceEntry(ReasoningEntryType.WARNING, "Post-turn RAG ingestion encountered errors.", { errors: ingestionResult.errors });
      } else {
        this.addTraceEntry(ReasoningEntryType.RAG_INGESTION_COMPLETE, "Post-turn RAG ingestion successful.", { ingestedIds: ingestionResult.ingestedIds });
      }
    } catch (error: any) {

      const gmiError = createGMIErrorFromError(error, GMIErrorCode.RAG_INGESTION_FAILED, undefined, "Error during post-turn RAG ingestion.");
      this.addTraceEntry(ReasoningEntryType.ERROR, gmiError.message, gmiError.toPlainObject());
      console.error(`GMI (ID: ${this.gmiId}): RAG Ingestion Error - ${gmiError.message}`, gmiError.details);
    }
  }

  /** @inheritdoc */
  public async _triggerAndProcessSelfReflection(): Promise<void> {
    await this.metapromptExecutor.triggerAndProcessSelfReflection();
  }

  /**
   * Helper to determine model and provider for internal LLM calls.
   * @private
   */
  private getModelAndProviderForLLMCall(
    preferredModelId?: string, preferredProviderId?: string,
    systemDefaultModelId?: string, systemDefaultProviderId?: string
  ): { modelId: string; providerId: string } {
    let modelId = preferredModelId || this.activePersona.defaultModelId || systemDefaultModelId;
    let providerId = preferredProviderId || this.activePersona.defaultProviderId || systemDefaultProviderId;

    if (!modelId) {
      const defaultProvider = this.llmProviderManager.getDefaultProvider();
      modelId = defaultProvider?.defaultModelId;
      if (!providerId && modelId) { // If modelId found from default provider, use that providerId
          providerId = defaultProvider?.providerId;
      }
      if (!modelId) { // Still no modelId after all fallbacks
        throw new GMIError("Cannot determine modelId for LLM call: No preferred, persona default, system default, or provider default found.", GMIErrorCode.CONFIGURATION_ERROR);
      }
    }

    if (!providerId && modelId.includes('/')) {
      // A namespaced id names its provider only when that provider is
      // registered here. Otherwise it is a router's model id (OpenRouter
      // lists `openai/gpt-4o-mini`), and the registry lookup below finds the
      // provider that serves it.
      const prefix = modelId.split('/')[0];
      if (prefix && this.llmProviderManager.getProvider(prefix)) {
        providerId = prefix;
      }
    }

    if (!providerId) {
      const foundProvider = this.llmProviderManager.getProviderForModel(modelId);
      if (foundProvider) {
        providerId = foundProvider.providerId;
      } else {

        throw new GMIError(`Cannot determine providerId for model '${modelId}'. No explicit providerId, unable to infer from modelId, and no default provider found for it.`, GMIErrorCode.CONFIGURATION_ERROR, {modelId});
      }
    }
    // Drop the provider prefix from the model id. OpenRouter's own ids are
    // namespaced slugs, and some name OpenRouter itself (`openrouter/auto`),
    // so there the prefix goes only when it wraps another vendor's slug
    // (`openrouter/openai/gpt-4o` sends `openai/gpt-4o`).
    if (modelId.startsWith(providerId + '/')) {
      const unprefixed = modelId.substring(providerId.length + 1);
      if (providerId !== 'openrouter' || unprefixed.includes('/')) {
        modelId = unprefixed;
      }
    }

    return { modelId, providerId };
  }

  /** @inheritdoc */
  public async onMemoryLifecycleEvent(event: MemoryLifecycleEvent): Promise<LifecycleActionResponse> {
    this.ensureReady();
    this.addTraceEntry(ReasoningEntryType.MEMORY_LIFECYCLE_EVENT_RECEIVED, `Received memory lifecycle event: ${event.type}`, { eventId: event.eventId, itemId: event.itemId });
    
    const personaLifecycleConf = this.activePersona.memoryConfig?.lifecycleConfig;
    let gmiDecision: LifecycleAction = event.proposedAction;
    let rationale = 'GMI default action: align with MemoryLifecycleManager proposal.';

    if (personaLifecycleConf?.negotiationEnabled && event.negotiable) {
      this.addTraceEntry(ReasoningEntryType.MEMORY_LIFECYCLE_NEGOTIATION_START, "GMI negotiation for memory item.", { event });

      if (event.category === RagMemoryCategory.USER_EXPLICIT_MEMORY.toString() &&
          (event.type === 'DELETION_PROPOSED' || event.type === 'EVICTION_PROPOSED') &&
          event.proposedAction === 'DELETE') {
        gmiDecision = 'PREVENT_ACTION';
        rationale = 'GMI policy: User explicit memory requires careful review; preventing immediate deletion/eviction.';
      }
    }
    const response: LifecycleActionResponse = {
      gmiId: this.gmiId, eventId: event.eventId, actionTaken: gmiDecision, rationale,
    };
    this.addTraceEntry(ReasoningEntryType.MEMORY_LIFECYCLE_RESPONSE_SENT, `Responding to memory event: ${response.actionTaken}`, { response });
    return response;
  }

  /** @inheritdoc */
  public async analyzeAndReportMemoryHealth(): Promise<GMIHealthReport['memoryHealth']> {
    this.ensureReady();
    this.addTraceEntry(ReasoningEntryType.HEALTH_CHECK_REQUESTED, "Analyzing GMI memory health.");
    const workingMemorySize = await this.workingMemory.size();
    const ragHealth = this.retrievalAugmentor ? await this.retrievalAugmentor.checkHealth() : { isHealthy: true, details: "RAG not configured." };

    const memoryHealthReport: GMIHealthReport['memoryHealth'] = { // Explicit type
      overallStatus: ragHealth.isHealthy ? 'OPERATIONAL' : 'DEGRADED',
      workingMemoryStats: { itemCount: workingMemorySize },
      ragSystemStats: ragHealth,
      issues: [],
    };
    if (!ragHealth.isHealthy) memoryHealthReport.issues?.push({severity: 'warning', component: 'RetrievalAugmentor', description: "RAG system health check failed.", details: ragHealth.details});
    this.addTraceEntry(ReasoningEntryType.HEALTH_CHECK_RESULT, "Memory health analysis complete.", { status: memoryHealthReport.overallStatus });
    return memoryHealthReport;
  }

  /** @inheritdoc */
  public async getOverallHealth(): Promise<GMIHealthReport> {
    this.addTraceEntry(ReasoningEntryType.HEALTH_CHECK_REQUESTED, "Overall GMI health check.");
    const memoryHealth = await this.analyzeAndReportMemoryHealth();
    const dependenciesStatus: GMIHealthReport['dependenciesStatus'] = [];

    // Example extended dependency check
    const checkDep = async (name: string, service?: { checkHealth?: () => Promise<{isHealthy: boolean, details?: any}> }): Promise<void> => {
        if (!service || typeof service.checkHealth !== 'function') {
            dependenciesStatus.push({ componentName: name, status: 'UNKNOWN', details: `${name} service not configured or has no health check.`});
            return;
        }
        try {
            const health = await service.checkHealth();
            dependenciesStatus.push({ componentName: name, status: health.isHealthy ? 'HEALTHY' : 'UNHEALTHY', details: health.details });
        } catch (e: any) {
            dependenciesStatus.push({ componentName: name, status: 'ERROR', details: e.message });
        }
    };

    await Promise.all([
        checkDep('AIModelProviderManager', this.llmProviderManager as any), // Cast if AIModelProviderManager doesn't directly implement checkHealth
        checkDep('ToolOrchestrator', this.toolOrchestrator),
        checkDep('UtilityAI', this.utilityAI as any), // Cast if IUtilityAI doesn't have checkHealth
        checkDep('PromptEngine', this.promptEngine as any), // Cast if IPromptEngine doesn't have checkHealth
        // retrievalAugmentor already included in memoryHealth
    ]);
    
    let overallSystemHealthy = memoryHealth?.overallStatus === 'OPERATIONAL';
    dependenciesStatus.forEach(dep => { if (dep.status !== 'HEALTHY') overallSystemHealthy = false; });

    const report: GMIHealthReport = {
        gmiId: this.gmiId,
        personaId: this.activePersona?.id || 'uninitialized',
        timestamp: new Date(),
        overallStatus: overallSystemHealthy ? 'HEALTHY' : 'DEGRADED',
        currentState: this.state,
        memoryHealth,
        dependenciesStatus,
        recentErrors: this.reasoningTrace.entries.filter(e => e.type === ReasoningEntryType.ERROR).slice(-5),
        // uptimeSeconds, activeTurnsProcessed would need dedicated tracking if required
    };
    this.addTraceEntry(ReasoningEntryType.HEALTH_CHECK_RESULT, "Overall GMI health check complete.", { status: report.overallStatus });
    return report;
  }

  /**
   * Shuts the GMI down. It stops the turns still running (each ends with the
   * abort error) and waits for them at most `shutdownTimeoutMs`, gives
   * metaprompt work in flight a bounded window to finish, then closes the
   * cognitive and working memory. It owns the lifecycle state from the start,
   * so a turn that ends later leaves the state SHUTDOWN.
   *
   * One shutdown runs at a time: a call made while one runs (a manager that
   * shuts down while a session is deactivated, a second signal to the host)
   * returns the same promise, so the memories are closed once. A call after
   * the shutdown has finished returns at once.
   */
  public shutdown(): Promise<void> {
    if (!this.shutdownInProgress) {
      this.shutdownInProgress = this.shutDownOnce().finally(() => {
        this.shutdownInProgress = undefined;
      });
    }
    return this.shutdownInProgress;
  }

  /** The work of {@link GMI.shutdown}, run by one call at a time. */
  private async shutDownOnce(): Promise<void> {
    if (this.state === GMIPrimeState.SHUTDOWN || (this.state === GMIPrimeState.IDLE && !this.isInitialized)) {
      console.log(`GMI (ID: ${this.gmiId}) already shut down or was never fully initialized.`);
      this.state = GMIPrimeState.SHUTDOWN; return;
    }
    this.state = GMIPrimeState.SHUTTING_DOWN;
    // Shutdown owns the lifecycle state from here on: a turn that ends later
    // writes neither READY nor ERRORED over SHUTTING_DOWN or SHUTDOWN.
    this.stateOwnerTurn = 0;
    this.addTraceEntry(ReasoningEntryType.LIFECYCLE, "GMI shutting down.");
    try {
      // Stop the turns still running, and give them the shutdown bound to end
      // before the memories they write to are closed.
      await this.stopRunningTurns();
      // Give metaprompt work still in flight a bounded window to store its
      // updates before the memories it writes to are closed, then stop the
      // queue: work not yet started is skipped, and late results are dropped.
      await this.metapromptExecutor?.drain();
      this.metapromptExecutor?.close();
      await this.cognitiveMemory?.shutdown?.();
      await this.workingMemory?.close?.();
      // Shared dependencies (tool orchestrator, retrieval augmentor, utility AI, etc.) are owned by
      // the host (AgentOS/GMIManager) and may be shared across GMIs. Do not shut them down here,
      // otherwise deactivating one idle GMI can break other active sessions.
    } catch (error: any) {
        const shutdownError = createGMIErrorFromError(error, GMIErrorCode.INTERNAL_SERVER_ERROR, undefined, "Error during GMI component shutdown.");
        this.addTraceEntry(ReasoningEntryType.ERROR, shutdownError.message, shutdownError.toPlainObject());
        console.error(`GMI (ID: ${this.gmiId}): Error during component shutdown:`, shutdownError);
    } finally {
      this.state = GMIPrimeState.SHUTDOWN;
      this.isInitialized = false; // Mark as not initialized
      this.addTraceEntry(ReasoningEntryType.LIFECYCLE, "GMI shutdown complete.");
      console.log(`GMI (ID: ${this.gmiId}) shut down.`);
    }
  }

  /**
   * Aborts every running turn, so its model call ends with the provider's
   * abort chunk, and waits for the turns to end, at most the shutdown bound
   * (`GMIBaseConfig.shutdownTimeoutMs`). A turn whose consumer stops reading its
   * stream does not end; shutdown goes on without it.
   */
  private async stopRunningTurns(): Promise<void> {
    if (this.runningTurns.size === 0) return;
    const turns = Array.from(this.runningTurns.values());
    for (const turn of turns) turn.stop.abort();
    const bound = shutdownTimeoutOrDefault(this.config?.shutdownTimeoutMs);
    if (await settlesWithin(Promise.all(turns.map((turn) => turn.ended)), bound)) return;
    const message = `${this.runningTurns.size} stopped turn(s) still running after ${bound} ms; closing the memories anyway.`;
    this.addTraceEntry(ReasoningEntryType.WARNING, message);
    console.warn(`GMI (ID: ${this.gmiId}): ${message}`);
  }
}
