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
import {
  IPersonaDefinition,
  PersonaRagConfigIngestionTrigger, // Ensure this type definition exists and is correctly imported
} from './personas/IPersonaDefinition';
import { IWorkingMemory } from './memory/IWorkingMemory';
import { IPromptEngine, PromptExecutionContext, PromptComponents, PromptEngineResult, ModelTargetInfo } from '../../core/llm/IPromptEngine';
import { IRetrievalAugmentor, RagRetrievalOptions, RagDocumentInput, RagIngestionOptions, RagMemoryCategory } from '../rag/IRetrievalAugmentor';

import { ChatMessage, ModelCompletionOptions, ThinkingBlock } from '../../core/llm/providers/IProvider';

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

const DEFAULT_MAX_CONVERSATION_HISTORY_TURNS = 20;
const DEFAULT_SELF_REFLECTION_INTERVAL_TURNS = 5;
const MAX_REASONING_TRACE_ENTRIES = 500; // Limit trace size in memory

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
  private conversationHistoryManager!: ConversationHistoryManager;

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
   * Adds an entry to the GMI's reasoning trace.
   * @private
   */
  private addTraceEntry(type: ReasoningEntryType, message: string, details?: Record<string, any>, timestamp?: Date): void {
    if (this.reasoningTrace.entries.length >= MAX_REASONING_TRACE_ENTRIES) {
      this.reasoningTrace.entries.shift();
    }
    const entry: ReasoningTraceEntry = {
      timestamp: timestamp || new Date(),
      type,
      message: message.substring(0, 1000), // Cap message length
      details: details ? JSON.parse(JSON.stringify(details)) : {},
    };
    this.reasoningTrace.entries.push(entry);
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
   * Ensures the GMI is initialized and in a READY state.
   * @private
   */
  private ensureReady(additionallyAllowedStates: GMIPrimeState[] = []): void {
    if (!this.isInitialized) {
        throw new GMIError(`GMI (ID: ${this.gmiId}) is not initialized.`, GMIErrorCode.NOT_INITIALIZED);
    }
    if (
      this.state !== GMIPrimeState.READY &&
      !additionallyAllowedStates.includes(this.state)
    ) {

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
   * Determines the prompt format type based on model provider.
   * @param modelDetails - Model metadata from the provider manager.
   * @param providerId - The provider identifier.
   * @returns The prompt format type string.
   */
  private determinePromptFormat(
    modelDetails: { providerId?: string } | null | undefined,
    providerId?: string,
  ): string {
    const pid = (modelDetails?.providerId || providerId || '').toLowerCase();
    if (pid.includes('anthropic')) return 'anthropic_messages';
    if (pid.includes('google') || pid.includes('gemini')) return 'google_gemini';
    if (pid.includes('cohere')) return 'cohere_chat';
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

  /** @inheritdoc */

  public async *processTurnStream(turnInput: GMITurnInput): AsyncGenerator<GMIOutputChunk, GMIOutput, undefined> {
    const continuationAllowedStates =
      turnInput.metadata?.isToolContinuation === true
        ? [GMIPrimeState.PROCESSING, GMIPrimeState.AWAITING_TOOL_RESULT]
        : [];
    this.ensureReady(continuationAllowedStates);
    this.state = GMIPrimeState.PROCESSING;
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

    try {
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
      this.conversationHistoryManager.update(turnInput, maxHistoryMessages);

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
      let lastRagSources: import('../rag/IRetrievalAugmentor.js').RagRetrievedChunk[] | undefined;
      main_processing_loop: while (safetyBreak < maxToolLoopIterations) {
        safetyBreak++;
        let augmentedContextFromRAG = "";
        const injectedLongTermMemoryContext =
          typeof turnInput.metadata?.longTermMemoryContext === 'string'
            ? turnInput.metadata.longTermMemoryContext.trim()
            : "";
        let assembledMemoryContext: AssembledMemoryContext | null = null;

        const lastMessage = this.conversationHistoryManager.history.length > 0 ? this.conversationHistoryManager.history[this.conversationHistoryManager.history.length - 1] : null;
        const isUserInitiatedTurn = lastMessage?.role === 'user';
        const currentTurnText =
          isUserInitiatedTurn && lastMessage?.content
            ? (typeof lastMessage.content === 'string'
                ? lastMessage.content
                : JSON.stringify(lastMessage.content))
            : '';

        if (this.retrievalAugmentor && this.activePersona.memoryConfig?.ragConfig?.enabled && isUserInitiatedTurn && lastMessage?.content) {
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
          assembledMemoryContext = await this.memoryBridge?.assembleContext(currentTurnText) ?? null;
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

        const durableHistoryForPrompt =
          Array.isArray(turnInput.metadata?.conversationHistoryForPrompt) && turnInput.metadata?.conversationHistoryForPrompt.length > 0
            ? (turnInput.metadata?.conversationHistoryForPrompt as ConversationMessage[])
            : null;

        const promptComponents: PromptComponents = {
          systemPrompts,
          conversationHistory: durableHistoryForPrompt ?? this.conversationHistoryManager.buildForPrompt(),
          userInput: isUserInitiatedTurn ? currentTurnText : null,
          retrievedContext: [
            assembledMemoryContext?.contextText,
            augmentedContextFromRAG,
            injectedLongTermMemoryContext,
          ].filter(Boolean).join("\n\n---\n\n"),
          assembledMemoryContext: assembledMemoryContext ?? undefined,
          // tools: this.activePersona.embeddedTools, // If ITool[] and PromptComponents.tools takes ITool[]
        };

        const preferredModelIdFromInput = turnInput.metadata?.options?.preferredModelId as string | undefined;
        const modelIdToUse = preferredModelIdFromInput || this.activePersona.defaultModelId || this.config.defaultLlmModelId;
        const providerIdForModel = this.activePersona.defaultProviderId || this.config.defaultLlmProviderId;

        if (!modelIdToUse) {
            throw new GMIError("Could not determine modelId for LLM call.", GMIErrorCode.CONFIGURATION_ERROR, { turnId });
        }

        const modelDetails = await this.llmProviderManager.getModelInfo(modelIdToUse, providerIdForModel);
        const modelTargetInfo: ModelTargetInfo = {
            modelId: modelIdToUse,
            providerId: modelDetails?.providerId || providerIdForModel || this.llmProviderManager.getProviderForModel(modelIdToUse)?.providerId || 'unknown',
            maxContextTokens: modelDetails?.contextWindowSize || 8192, // Default fallback
            capabilities: modelDetails?.capabilities || [],
            promptFormatType: this.determinePromptFormat(modelDetails, providerIdForModel),
            toolSupport: {
              supported: modelDetails?.capabilities.includes('tool_use') || false,
              format: this.determineToolFormat(modelDetails, providerIdForModel),
            },
        };

        const promptEngineResult: PromptEngineResult = await this.promptEngine.constructPrompt(
          promptComponents, modelTargetInfo, promptExecContext
        );

        promptEngineResult.issues?.forEach(issue => this.addTraceEntry(ReasoningEntryType.WARNING, `Prompt Engine Issue: ${issue.message}`, issue as any));
        this.addTraceEntry(ReasoningEntryType.PROMPT_CONSTRUCTION_COMPLETE, `Prompt constructed for model ${modelTargetInfo.modelId}.`);

        const provider = this.llmProviderManager.getProvider(modelTargetInfo.providerId);
        if (!provider) {
            throw new GMIError(`LLM Provider '${modelTargetInfo.providerId}' not found or not initialized.`, GMIErrorCode.LLM_PROVIDER_UNAVAILABLE);
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
        
        const llmOptions: ModelCompletionOptions = {
          temperature: (turnInput.metadata?.options?.temperature as number) ?? this.activePersona.defaultModelCompletionOptions?.temperature ?? 0.7,
          maxTokens: (turnInput.metadata?.options?.maxTokens as number) ?? this.activePersona.defaultModelCompletionOptions?.maxTokens ?? 2048,
          tools: toolsForLLM.length > 0 ? toolsForLLM.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema }})) : undefined,
          toolChoice: turnInput.metadata?.options?.toolChoice || (toolsForLLM.length > 0 ? "auto" : undefined),
          userId: this.currentUserContext.userId,
          stream: true, // For generateCompletionStream
          responseFormat: turnInput.metadata?.options?.responseFormat,
        };

        this.addTraceEntry(ReasoningEntryType.LLM_CALL_START, `Streaming from ${modelTargetInfo.modelId}. Tools: ${toolsForLLM.length}.`);

        let currentIterationTextResponse = "";
        let currentIterationToolCallRequests: ToolCallRequest[] = [];
        // Extended-thinking blocks emitted this iteration (Opus 4.7/4.8 with
        // thinking enabled). Captured from the final chunk + stored on the
        // assistant turn so the next tool turn replays them verbatim, which
        // Anthropic requires. Empty for every non-thinking turn, so the stored
        // turn is unchanged on the normal path.
        let currentIterationThinkingBlocks: ThinkingBlock[] = [];

        let textDeltaEmitted = false;
        for await (const chunk of provider.generateCompletionStream(modelTargetInfo.modelId, promptEngineResult.prompt as ChatMessage[], llmOptions)) {
          if (chunk.error) {

            throw new GMIError(`LLM stream error: ${chunk.error.message}`, GMIErrorCode.LLM_PROVIDER_ERROR, chunk.error.details);
          }

          if (chunk.responseTextDelta) {
            currentIterationTextResponse += chunk.responseTextDelta;
            aggregatedResponseText += chunk.responseTextDelta; // Aggregate for final output
            yield this.createOutputChunk(turnInput.interactionId, GMIOutputChunkType.TEXT_DELTA, chunk.responseTextDelta, { usage: chunk.usage });
            textDeltaEmitted = true;
          }

          // Handle fully formed tool_calls if present in the chunk's message
          const choice = chunk.choices?.[0];
          // Capture extended-thinking blocks from the final chunk so they ride
          // the assistant turn into history (replayed verbatim next tool turn).
          if (choice?.message?.thinkingBlocks?.length) {
            currentIterationThinkingBlocks = choice.message.thinkingBlocks;
          }
          if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
            currentIterationToolCallRequests = choice.message.tool_calls.map((tc: any) => ({ // tc is from IProvider.ChatMessage.tool_calls
                id: tc.id || `toolcall-${uuidv4()}`, // Ensure ID
                name: tc.function.name,
                arguments: typeof tc.function.arguments === 'string'
                    ? JSON.parse(tc.function.arguments)
                    : tc.function.arguments,
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
          
          if (chunk.isFinal && choice?.finishReason) {
            this.addTraceEntry(ReasoningEntryType.LLM_CALL_COMPLETE, `LLM stream part finished. Reason: ${choice.finishReason}`, { usage: chunk.usage });
            if (chunk.usage) {
              yield this.createOutputChunk(turnInput.interactionId, GMIOutputChunkType.USAGE_UPDATE, chunk.usage);
              // Aggregate usage
              aggregatedUsage.promptTokens += chunk.usage.promptTokens || 0;
              aggregatedUsage.completionTokens += chunk.usage.completionTokens || 0;
              aggregatedUsage.totalTokens = aggregatedUsage.promptTokens + aggregatedUsage.completionTokens;
              if (chunk.usage.costUSD) aggregatedUsage.totalCostUSD = (aggregatedUsage.totalCostUSD || 0) + chunk.usage.costUSD;
            }
          }
        } // End LLM stream

        // Ensure at least one TEXT_DELTA is emitted for this turn if text was produced
        if (!textDeltaEmitted && aggregatedResponseText) {
          yield this.createOutputChunk(turnInput.interactionId, GMIOutputChunkType.TEXT_DELTA, aggregatedResponseText);
        }

        this.conversationHistoryManager.push({
          role: 'assistant',
          content: currentIterationTextResponse || null,
          tool_calls: currentIterationToolCallRequests.length > 0
            ? currentIterationToolCallRequests.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
              }))
            : undefined,
          ...(currentIterationThinkingBlocks.length > 0 && { thinkingBlocks: currentIterationThinkingBlocks }),
        });

        if (currentIterationToolCallRequests.length > 0) {
          this.state = GMIPrimeState.AWAITING_TOOL_RESULT;
          const toolExecutionResults: ToolCallResult[] = [];
          for (const toolCallReq of currentIterationToolCallRequests) {
            const requestDetails: ToolExecutionRequestDetails = {
              toolCallRequest: toolCallReq,
              gmiId: this.gmiId, personaId: this.activePersona.id,
              personaCapabilities: this.activePersona.allowedCapabilities || [],
              userContext: this.currentUserContext, correlationId: turnId,
              sessionData: this.buildToolSessionData(turnInput),
            };
            this.addTraceEntry(ReasoningEntryType.TOOL_EXECUTION_START, `Orchestrating tool: ${toolCallReq.name}`, { reqId: toolCallReq.id });
            const result = await this.toolOrchestrator.processToolCall(requestDetails);
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
          toolExecutionResults.forEach(tcResult => this.conversationHistoryManager.updateWithToolResult(tcResult));
          currentIterationTextResponse = ""; // Reset for next iteration if any
          currentIterationToolCallRequests = []; // Reset
          this.state = GMIPrimeState.PROCESSING;
          continue main_processing_loop;
        }
        break main_processing_loop; // Break if no tool calls
      }

      await this.memoryBridge?.syncForTurn(turnInput, aggregatedResponseText);

      await this.performPostTurnIngestion(
        this.stringifyTurnContent(turnInput.content) ?? '',
        aggregatedResponseText
      );

      // Check and trigger all metaprompts (turn_interval, event_based, manual)
      await this.metapromptExecutor.checkAndTriggerMetaprompts(turnId);

      // Prepare the final GMIOutput for the generator's return value
      const finalTurnOutput: GMIOutput = {
        isFinal: true,
        responseText: aggregatedResponseText || null,
        toolCalls: aggregatedToolCalls.length > 0 ? aggregatedToolCalls : undefined,
        uiCommands: aggregatedUiCommands.length > 0 ? aggregatedUiCommands : undefined, // Assuming GMI can populate these
        usage: aggregatedUsage,
        error: lastErrorForOutput,
        ragSources: lastRagSources,
      };
      return finalTurnOutput; // Return the aggregated output

    } catch (error: any) {

      const gmiError = createGMIErrorFromError(error, GMIErrorCode.GMI_PROCESSING_ERROR, { turnId }, `Error in GMI turn '${turnId}'.`);
      this.state = GMIPrimeState.ERRORED;
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
      if (this.state !== GMIPrimeState.ERRORED && this.state !== GMIPrimeState.AWAITING_TOOL_RESULT) {
        this.state = GMIPrimeState.READY;
      }
      // This final chunk is part of the stream, not the return value of the generator
      yield this.createOutputChunk(turnInput.interactionId, GMIOutputChunkType.FINAL_RESPONSE_MARKER, 'Turn processing sequence complete.', { isFinal: true });
      this.addTraceEntry(ReasoningEntryType.INTERACTION_END, `Turn '${turnId}' finished. GMI State: ${this.state}.`);
      if (this.reasoningTrace) this.reasoningTrace.turnId = undefined;
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
      const parts = modelId.split('/');
      if (parts.length >= 2) { // Can be "openai/gpt-3.5-turbo" or "ollama/modelname/variant"
        providerId = parts[0];
        // modelId = parts.slice(1).join('/'); // Keep full model name if provider prefix was there
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
     // Ensure modelId doesn't contain the provider prefix if providerId is now set
     if (modelId.startsWith(providerId + '/')) {
        modelId = modelId.substring(providerId.length + 1);
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

  /** @inheritdoc */
  public async shutdown(): Promise<void> {
    if (this.state === GMIPrimeState.SHUTDOWN || (this.state === GMIPrimeState.IDLE && !this.isInitialized)) {
      console.log(`GMI (ID: ${this.gmiId}) already shut down or was never fully initialized.`);
      this.state = GMIPrimeState.SHUTDOWN; return;
    }
    this.state = GMIPrimeState.SHUTTING_DOWN;
    this.addTraceEntry(ReasoningEntryType.LIFECYCLE, "GMI shutting down.");
    try {
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
}
