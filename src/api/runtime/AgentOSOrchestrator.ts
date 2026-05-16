// File: backend/agentos/api/AgentOSOrchestrator.ts
/**
 * @fileoverview Implements the `AgentOSOrchestrator`, which acts as the central
 * coordinator between the public-facing `AgentOS` API and the internal `GMI`
 * instances. It manages the full lifecycle of an interaction turn, including
 * GMI selection, input preparation, handling GMI's streaming output, and
 * coordinating tool execution and result feedback.
 * @module backend/agentos/api/AgentOSOrchestrator
 */

import { AgentOSInput, ProcessingOptions } from '../types/AgentOSInput';
import {
  TaskOutcomeTelemetryManager,
  evaluateTaskOutcome,
  resolveTaskOutcomeTelemetryConfig,
  resolveAdaptiveExecutionConfig,
  type TaskOutcomeAssessment,
  type ResolvedTaskOutcomeTelemetryConfig,
  type ResolvedAdaptiveExecutionConfig,
} from './TaskOutcomeTelemetryManager';
import { StreamChunkEmitter } from './StreamChunkEmitter';
// Turn-phase helpers (rolling-summary, prompt-profile, long-term-memory,
// conversation-history) now used by TurnExecutionPipeline
import {
  AgentOSResponseChunkType,
} from '../types/AgentOSResponse';
import type {
  AgentOSPendingExternalToolRequest,
  AgentOSResumeExternalToolRequestOptions,
} from '../types/AgentOSExternalToolRequest';
// AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY now used only by ExternalToolResultHandler
import type { AgentOSToolResultInput } from '../types/AgentOSToolResult';
import {
  IGMI,
  GMIOutput,
  GMIOutputChunkType,
} from '../../cognition/substrate/IGMI';
import { ConversationContext } from '../../core/conversation/ConversationContext';
import { MessageRole } from '../../core/conversation/ConversationMessage';
// IToolOrchestrator — referenced via AgentOSOrchestratorDependencies
// uuidv4 — now used by GMIChunkTransformer
import { GMIError, GMIErrorCode } from '../../core/utils/errors.js';
import { type StreamId } from '../../core/streaming/StreamingManager';
import { normalizeUsage, snapshotPersonaDetails } from '../../orchestration/turn-planner/helpers';
import type { WorkflowProgressUpdate } from '../../orchestration/workflows/WorkflowTypes';
// AIModelProviderManager — referenced via AgentOSOrchestratorDependencies
import {
  DEFAULT_PROMPT_PROFILE_CONFIG,
} from '../structured/prompting/PromptProfileRouter';
import {
  DEFAULT_ROLLING_SUMMARY_COMPACTION_CONFIG,
} from '../../core/conversation/RollingSummaryCompactor';
// IRollingSummaryMemorySink, RollingSummaryMemoryUpdate — now used by TurnExecutionPipeline
// ILongTermMemoryRetriever — referenced via AgentOSOrchestratorDependencies
// ResolvedLongTermMemoryPolicy — referenced via TurnExecutionPipeline
import {
  recordAgentOSTurnMetrics,
  recordExceptionOnActiveSpan,
  runWithSpanContext,
  startAgentOSSpan,
  withAgentOSSpan,
} from '../../safety/evaluation/observability/otel';
// ITurnPlanner, TurnPlan — now used by TurnExecutionPipeline
// CapabilityContextAssembler, filterCapabilityDiscoveryResultByDisabledSkills — now used by GMIChunkTransformer
import { ExternalToolResultHandler } from './ExternalToolResultHandler';
import { GMIChunkTransformer } from './GMIChunkTransformer';
import { TurnExecutionPipeline } from './TurnExecutionPipeline';

// Public config types extracted to types/OrchestratorConfig.ts
export type {
  RollingSummaryCompactionProfileDefinition,
  RollingSummaryCompactionProfilesConfig,
  LongTermMemoryRecallProfile,
  AgentOSLongTermMemoryRecallConfig,
  TenantRoutingMode,
  AgentOSTenantRoutingConfig,
  TaskOutcomeTelemetryScope,
  AgentOSTaskOutcomeTelemetryConfig,
  AgentOSAdaptiveExecutionConfig,
  TaskOutcomeKpiWindowEntry,
  ITaskOutcomeTelemetryStore,
  AgentOSOrchestratorConfig,
  AgentOSOrchestratorDependencies,
} from '../types/OrchestratorConfig';

import type {
  LongTermMemoryRecallProfile,
  AgentOSLongTermMemoryRecallConfig,
  TenantRoutingMode,
  AgentOSTenantRoutingConfig,
  AgentOSOrchestratorConfig,
  AgentOSOrchestratorDependencies,
} from '../types/OrchestratorConfig';

type ResolvedLongTermMemoryRecallConfig = {
  profile: LongTermMemoryRecallProfile;
  cadenceTurns: number;
  forceOnCompaction: boolean;
  maxContextChars: number;
  topKByScope: Record<'user' | 'persona' | 'organization', number>;
};

type ResolvedTenantRoutingConfig = {
  mode: TenantRoutingMode;
  defaultOrganizationId?: string;
  strictOrganizationIsolation: boolean;
};

// ResolvedTaskOutcomeTelemetryConfig, ResolvedAdaptiveExecutionConfig,
// TaskOutcomeAssessment, TaskOutcomeKpiSummary, TaskOutcomeKpiAlert,
// AdaptiveExecutionDecision — imported from TaskOutcomeTelemetryManager

// TaskOutcomeKpiWindowEntry imported from types/OrchestratorConfig.ts

// AdaptiveExecutionDecision imported from TaskOutcomeTelemetryManager

// ITaskOutcomeTelemetryStore imported from types/OrchestratorConfig.ts

const RECALL_PROFILE_DEFAULTS: Record<
  LongTermMemoryRecallProfile,
  Omit<ResolvedLongTermMemoryRecallConfig, 'profile'>
> = {
  aggressive: {
    cadenceTurns: 2,
    forceOnCompaction: true,
    maxContextChars: 4200,
    topKByScope: { user: 8, persona: 8, organization: 8 },
  },
  balanced: {
    cadenceTurns: 4,
    forceOnCompaction: true,
    maxContextChars: 3200,
    topKByScope: { user: 6, persona: 6, organization: 6 },
  },
  conservative: {
    cadenceTurns: 8,
    forceOnCompaction: false,
    maxContextChars: 2200,
    topKByScope: { user: 4, persona: 4, organization: 4 },
  },
};

function renderPlainText(markdown: string): string {
  let text = String(markdown ?? '');
  if (!text.trim()) return '';

  text = text.replace(/\r\n/g, '\n');
  // Fenced code blocks: keep inner content, drop fences.
  text = text.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, '$1');
  // Inline code.
  text = text.replace(/`([^`]+)`/g, '$1');
  // Images + links.
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Headings + blockquotes.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  // Emphasis / strike-through.
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');
  // Horizontal rules.
  text = text.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '');
  // Basic HTML tags.
  text = text.replace(/<\/?[^>]+>/g, '');

  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

// normalizeTaskOutcomeOverride, normalizeRequestedToolFailureMode
// moved to TaskOutcomeTelemetryManager

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function normalizeOrganizationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveLongTermMemoryRecallConfig(
  config: AgentOSLongTermMemoryRecallConfig | undefined
): ResolvedLongTermMemoryRecallConfig {
  const profile: LongTermMemoryRecallProfile =
    config?.profile === 'balanced' || config?.profile === 'conservative'
      ? config.profile
      : 'aggressive';

  const defaults = RECALL_PROFILE_DEFAULTS[profile];
  return {
    profile,
    cadenceTurns: clampInteger(config?.cadenceTurns, defaults.cadenceTurns, 1, 100),
    forceOnCompaction:
      typeof config?.forceOnCompaction === 'boolean'
        ? config.forceOnCompaction
        : defaults.forceOnCompaction,
    maxContextChars: clampInteger(config?.maxContextChars, defaults.maxContextChars, 300, 12000),
    topKByScope: {
      user: clampInteger(config?.topKByScope?.user, defaults.topKByScope.user, 1, 50),
      persona: clampInteger(config?.topKByScope?.persona, defaults.topKByScope.persona, 1, 50),
      organization: clampInteger(
        config?.topKByScope?.organization,
        defaults.topKByScope.organization,
        1,
        50
      ),
    },
  };
}

function resolveTenantRoutingConfig(
  config: AgentOSTenantRoutingConfig | undefined
): ResolvedTenantRoutingConfig {
  return {
    mode: config?.mode === 'single_tenant' ? 'single_tenant' : 'multi_tenant',
    defaultOrganizationId: normalizeOrganizationId(config?.defaultOrganizationId),
    strictOrganizationIsolation: Boolean(config?.strictOrganizationIsolation),
  };
}

// evaluateTaskOutcome, resolveTaskOutcomeTelemetryConfig, resolveAdaptiveExecutionConfig
// imported from TaskOutcomeTelemetryManager

// AgentOSOrchestratorConfig and AgentOSOrchestratorDependencies imported from types/OrchestratorConfig.ts

/**
 * Internal state for managing an active stream of GMI interaction.
 * @interface ActiveStreamContext
 * @private
 */
interface ActiveStreamContext {
  gmi: IGMI;
  userId: string;
  sessionId: string; // AgentOS session ID
  personaId: string;
  conversationId: string; // Can be same as sessionId or a more specific conversation thread ID
  organizationId?: string;
  conversationContext: ConversationContext;
  userApiKeys?: Record<string, string>;
  processingOptions?: ProcessingOptions;
  languageNegotiation?: any; // multilingual negotiation metadata
  // Iterator is managed within the orchestrateTurn method directly
}

function buildToolCallChunkMetadata(
  streamContext: ActiveStreamContext,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    sessionId: streamContext.sessionId,
    conversationId: streamContext.conversationId,
    ...extra,
  };

  if (streamContext.organizationId) {
    metadata.organizationId = streamContext.organizationId;
  }

  return metadata;
}

type ResolvedAgentOSOrchestratorConfig = Required<
  Omit<
    AgentOSOrchestratorConfig,
    'longTermMemoryRecall' | 'tenantRouting' | 'taskOutcomeTelemetry' | 'adaptiveExecution'
  >
> & {
  longTermMemoryRecall: ResolvedLongTermMemoryRecallConfig;
  tenantRouting: ResolvedTenantRoutingConfig;
  taskOutcomeTelemetry: ResolvedTaskOutcomeTelemetryConfig;
  adaptiveExecution: ResolvedAdaptiveExecutionConfig;
};

/**
 * @class AgentOSOrchestrator
 * @description
 * The `AgentOSOrchestrator` is responsible for unifying the request handling
 * pipeline for AgentOS. It bridges the high-level `AgentOSInput` from the
 * public API to the internal `GMI` processing logic. It ensures that user
 * requests are routed to the correct GMI, manages the GMI's turn lifecycle,
 * and handles the complex dance of tool calls and streaming responses.
 */
export class AgentOSOrchestrator {
  // capabilityContextAssembler — moved to GMIChunkTransformer

  private initialized: boolean = false;
  private config!: ResolvedAgentOSOrchestratorConfig;
  private dependencies!: AgentOSOrchestratorDependencies;
  private telemetry!: TaskOutcomeTelemetryManager;
  private chunks!: StreamChunkEmitter;
  private toolResultHandler!: ExternalToolResultHandler;
  private chunkTransformer!: GMIChunkTransformer;
  private turnPipeline!: TurnExecutionPipeline;

  /**
   * A map to hold ongoing stream contexts.
   * Key: streamId (generated by orchestrator for this interaction flow).
   * Value: ActiveStreamContext.
   * @private
   */
  private activeStreamContexts: Map<string, ActiveStreamContext> = new Map();

  constructor() {}

  /**
   * Initializes the AgentOSOrchestrator with its configuration and dependencies.
   * This method must be called successfully before orchestrating any turns.
   *
   * @public
   * @async
   * @param {AgentOSOrchestratorConfig} config - Configuration settings for the orchestrator.
   * @param {AgentOSOrchestratorDependencies} dependencies - Required services.
   * @returns {Promise<void>} A Promise that resolves when initialization is complete.
   * @throws {GMIError} If any critical dependency is missing or config is invalid.
   */
  public async initialize(
    config: AgentOSOrchestratorConfig,
    dependencies: AgentOSOrchestratorDependencies
  ): Promise<void> {
    if (this.initialized) {
      console.warn('AgentOSOrchestrator already initialized. Skipping re-initialization.');
      return;
    }

    if (
      !dependencies.gmiManager ||
      !dependencies.toolOrchestrator ||
      !dependencies.conversationManager ||
      !dependencies.streamingManager ||
      !dependencies.modelProviderManager
    ) {
      throw new GMIError(
        'AgentOSOrchestrator: Missing essential dependencies (gmiManager, toolOrchestrator, conversationManager, streamingManager, modelProviderManager).',
        GMIErrorCode.CONFIGURATION_ERROR
      );
    }

    this.config = {
      maxToolCallIterations: config.maxToolCallIterations ?? 5,
      defaultAgentTurnTimeoutMs: config.defaultAgentTurnTimeoutMs ?? 120000,
      enableConversationalPersistence: config.enableConversationalPersistence ?? true,
      promptProfileConfig:
        config.promptProfileConfig === null
          ? null
          : (config.promptProfileConfig ?? DEFAULT_PROMPT_PROFILE_CONFIG),
      rollingSummaryCompactionConfig:
        config.rollingSummaryCompactionConfig === null
          ? null
          : {
              ...DEFAULT_ROLLING_SUMMARY_COMPACTION_CONFIG,
              ...(config.rollingSummaryCompactionConfig ?? {}),
            },
      rollingSummaryCompactionProfilesConfig: config.rollingSummaryCompactionProfilesConfig ?? null,
      rollingSummarySystemPrompt: config.rollingSummarySystemPrompt ?? '',
      rollingSummaryStateKey: config.rollingSummaryStateKey ?? 'rollingSummaryState',
      longTermMemoryRecall: resolveLongTermMemoryRecallConfig(config.longTermMemoryRecall),
      tenantRouting: resolveTenantRoutingConfig(config.tenantRouting),
      taskOutcomeTelemetry: resolveTaskOutcomeTelemetryConfig(config.taskOutcomeTelemetry),
      adaptiveExecution: resolveAdaptiveExecutionConfig(config.adaptiveExecution),
    };
    this.dependencies = dependencies;
    this.chunks = new StreamChunkEmitter(
      dependencies.streamingManager,
      this.activeStreamContexts as Map<string, any>
    );
    this.telemetry = new TaskOutcomeTelemetryManager(
      this.config.taskOutcomeTelemetry,
      this.config.adaptiveExecution,
      dependencies.taskOutcomeTelemetryStore
    );
    this.chunkTransformer = new GMIChunkTransformer(
      this.activeStreamContexts as Map<string, any>,
      this.chunks,
      this.dependencies,
      this.config.enableConversationalPersistence,
      // clearPendingRequest callback — wired after toolResultHandler is created below
      async () => {},
    );
    this.toolResultHandler = new ExternalToolResultHandler(
      this.activeStreamContexts as Map<string, any>,
      this.chunks,
      this.dependencies,
      this.config.enableConversationalPersistence,
      this.chunkTransformer.processGMIOutput.bind(this.chunkTransformer),
      this.resolveOrganizationContext.bind(this),
    );
    // Wire the chunkTransformer's clearPendingRequest to the toolResultHandler
    this.chunkTransformer.setClearPendingRequestCallback(
      this.toolResultHandler.clearPendingExternalToolRequest.bind(this.toolResultHandler),
    );
    this.turnPipeline = new TurnExecutionPipeline(
      this.activeStreamContexts as Map<string, any>,
      this.chunks,
      this.dependencies,
      this.config,
      this.chunkTransformer,
      this.telemetry,
      this.resolveOrganizationContext.bind(this),
    );
    await this.telemetry.loadPersistedWindows();
    this.initialized = true;
    console.log('AgentOSOrchestrator initialized.');
  }

  /**
   * Ensures the orchestrator is initialized.
   * @private
   * @throws {GMIError} If not initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new GMIError(
        'AgentOSOrchestrator is not initialized. Call initialize() first.',
        GMIErrorCode.NOT_INITIALIZED
      );
    }
  }

  private resolveOrganizationContext(inputOrganizationId: unknown): string | undefined {
    const inbound = normalizeOrganizationId(inputOrganizationId);
    const tenantConfig = this.config.tenantRouting;

    if (tenantConfig.mode === 'single_tenant') {
      const fallback = tenantConfig.defaultOrganizationId;
      if (tenantConfig.strictOrganizationIsolation && inbound && fallback && inbound !== fallback) {
        throw new GMIError(
          `organizationId '${inbound}' does not match configured single-tenant org '${fallback}'.`,
          GMIErrorCode.VALIDATION_ERROR,
          {
            mode: tenantConfig.mode,
            inboundOrganizationId: inbound,
            configuredOrganizationId: fallback,
          }
        );
      }
      const resolved = inbound ?? fallback;
      if (tenantConfig.strictOrganizationIsolation && !resolved) {
        throw new GMIError(
          'Single-tenant mode requires an organizationId or tenantRouting.defaultOrganizationId.',
          GMIErrorCode.VALIDATION_ERROR,
          { mode: tenantConfig.mode }
        );
      }
      return resolved;
    }

    return inbound;
  }

  // Task outcome telemetry methods delegated to this.telemetry (TaskOutcomeTelemetryManager)

  // pushChunkToStream, pushErrorChunk, emitExecutionLifecycleUpdate
  // delegated to this.chunks (StreamChunkEmitter)

  public async broadcastWorkflowUpdate(update: WorkflowProgressUpdate): Promise<void> {
    this.ensureInitialized();
    const targets: Array<{ streamId: StreamId; context: ActiveStreamContext }> = [];

    for (const [streamId, context] of this.activeStreamContexts.entries()) {
      if (
        update.workflow.conversationId &&
        context.conversationId !== update.workflow.conversationId
      ) {
        continue;
      }
      targets.push({ streamId, context });
    }

    if (targets.length === 0) {
      console.debug('AgentOSOrchestrator: No active streams for workflow update', {
        workflowId: update.workflow.workflowId,
        conversationId: update.workflow.conversationId,
      });
      return;
    }

    await Promise.allSettled(
      targets.map(async ({ streamId, context }) => {
        const gmiId = context.gmi.getGMIId();
        const metadata = {
          workflowId: update.workflow.workflowId,
          definitionId: update.workflow.definitionId,
          conversationId: update.workflow.conversationId,
          status: update.workflow.status,
        };
        await this.chunks.pushChunk(
          streamId,
          AgentOSResponseChunkType.WORKFLOW_UPDATE,
          gmiId,
          context.personaId,
          false,
          {
            workflow: update,
            metadata,
          }
        );
      })
    );
  }

  /**
   * Orchestrates a full logical turn for a user request.
   * This involves managing GMI interaction, tool calls, and streaming responses.
   * Instead of directly yielding, it uses the StreamingManager to push chunks.
   *
   * @public
   * @async
   * @param {AgentOSInput} input - The comprehensive input for the current turn.
   * @returns {Promise<StreamId>} The ID of the stream to which responses will be pushed.
   * @throws {GMIError} If critical initialization or setup fails.
   */
  public async orchestrateTurn(input: AgentOSInput): Promise<StreamId> {
    this.ensureInitialized();
    const agentOSStreamId = await this.dependencies.streamingManager.createStream();
    console.log(
      `AgentOSOrchestrator: Starting turn for AgentOS Stream ${agentOSStreamId}, User ${input.userId}, Session ${input.sessionId}`
    );

    const rootSpan = startAgentOSSpan('agentos.turn', {
      attributes: {
        'agentos.stream_id': agentOSStreamId,
        'agentos.user_id': input.userId,
        'agentos.session_id': input.sessionId,
        'agentos.conversation_id': input.conversationId ?? '',
        'agentos.persona_id': input.selectedPersonaId ?? '',
      },
    });

    const run = async () => this._processTurnInternal(agentOSStreamId, input);

    const promise = rootSpan ? runWithSpanContext(rootSpan, run) : run();

    // Execute the turn processing asynchronously without awaiting it here,
    // so this method can return the streamId quickly.
    promise
      .catch(async (criticalError: any) => {
        if (rootSpan) {
          try {
            rootSpan.recordException(criticalError);
          } catch {
            // ignore
          }
        }

        console.error(
          `AgentOSOrchestrator: Critical unhandled error in _processTurnInternal for stream ${agentOSStreamId}:`,
          criticalError
        );
        try {
          await this.chunks.pushError(
            agentOSStreamId,
            input.selectedPersonaId || 'unknown_persona',
            'orchestrator_critical',
            GMIErrorCode.INTERNAL_SERVER_ERROR,
            `A critical orchestration error occurred: ${criticalError.message}`,
            { name: criticalError.name, stack: criticalError.stack }
          );
          await this.dependencies.streamingManager.closeStream(
            agentOSStreamId,
            'Critical orchestrator error'
          );
        } catch (cleanupError: any) {
          console.error(
            `AgentOSOrchestrator: Error during critical error cleanup for stream ${agentOSStreamId}:`,
            cleanupError
          );
        }
        this.activeStreamContexts.delete(agentOSStreamId);
      })
      .finally(() => {
        try {
          rootSpan?.end();
        } catch {
          // ignore
        }
      });

    return agentOSStreamId;
  }

  public async orchestrateResumedToolResults(
    pendingRequest: AgentOSPendingExternalToolRequest,
    toolResults: AgentOSToolResultInput[],
    options: AgentOSResumeExternalToolRequestOptions = {}
  ): Promise<StreamId> {
    this.ensureInitialized();
    const agentOSStreamId = await this.dependencies.streamingManager.createStream();
    console.log(
      `AgentOSOrchestrator: Resuming external tool request for conversation ${pendingRequest.conversationId} on new stream ${agentOSStreamId}.`
    );

    const rootSpan = startAgentOSSpan('agentos.resume_external_tool_request', {
      attributes: {
        'agentos.stream_id': agentOSStreamId,
        'agentos.user_id': pendingRequest.userId,
        'agentos.session_id': pendingRequest.sessionId,
        'agentos.conversation_id': pendingRequest.conversationId,
        'agentos.persona_id': pendingRequest.personaId,
        'agentos.tool_result_count': toolResults.length,
      },
    });

    const run = async () =>
      this.toolResultHandler.resumeToolResultsInternal(agentOSStreamId, pendingRequest, toolResults, options);

    const promise = rootSpan ? runWithSpanContext(rootSpan, run) : run();
    promise
      .catch(async (criticalError: any) => {
        if (rootSpan) {
          try {
            rootSpan.recordException(criticalError);
          } catch {
            // ignore
          }
        }

        console.error(
          `AgentOSOrchestrator: Critical unhandled error in _resumeToolResultsInternal for stream ${agentOSStreamId}:`,
          criticalError
        );
        try {
          await this.chunks.pushError(
            agentOSStreamId,
            pendingRequest.personaId || 'unknown_persona',
            pendingRequest.gmiInstanceId || 'orchestrator_resume_critical',
            GMIErrorCode.INTERNAL_SERVER_ERROR,
            `A critical external-tool resume error occurred: ${criticalError.message}`,
            { name: criticalError.name, stack: criticalError.stack }
          );
          await this.dependencies.streamingManager.closeStream(
            agentOSStreamId,
            'Critical external-tool resume error'
          );
        } catch (cleanupError: any) {
          console.error(
            `AgentOSOrchestrator: Error during resume critical-error cleanup for stream ${agentOSStreamId}:`,
            cleanupError
          );
        }
        this.activeStreamContexts.delete(agentOSStreamId);
      })
      .finally(() => {
        try {
          rootSpan?.end();
        } catch {
          // ignore
        }
      });

    return agentOSStreamId;
  }

  /**
   * Internal processing logic for a turn, designed to be called without await by `orchestrateTurn`.
   * @private
   */
  private async _processTurnInternal(
    agentOSStreamId: StreamId,
    input: AgentOSInput
  ): Promise<void> {
    const turnStartedAt = Date.now();
    let turnMetricsStatus: 'ok' | 'error' = 'ok';
    let turnMetricsPersonaId: string | undefined = input.selectedPersonaId;
    let turnMetricsTaskOutcome: TaskOutcomeAssessment | undefined;
    let turnMetricsUsage:
      | {
          totalTokens?: number;
          promptTokens?: number;
          completionTokens?: number;
          totalCostUSD?: number;
        }
      | undefined;

    let gmi: IGMI | undefined;
    let conversationContext: ConversationContext | undefined;
    let currentPersonaId = input.selectedPersonaId;
    let gmiInstanceIdForChunks = 'gmi_pending_init';
    let organizationIdForMemory: string | undefined;
    let didForceTerminate = false;
    let lifecycleDegraded = false;
    let keepStreamContextActive = false;
    let streamedToolCallRequest = false;

    try {
      // --- Pre-LLM pipeline (phases 1-12) delegated to TurnExecutionPipeline ---
      const prepared = await this.turnPipeline.prepareTurn(agentOSStreamId, input);

      gmi = prepared.gmi;
      conversationContext = prepared.conversationContext;
      currentPersonaId = prepared.currentPersonaId;
      gmiInstanceIdForChunks = prepared.gmiInstanceIdForChunks;
      organizationIdForMemory = prepared.organizationIdForMemory;
      lifecycleDegraded = prepared.lifecycleDegraded;
      turnMetricsPersonaId = currentPersonaId;

      const { gmiInput, streamContext } = prepared;
      const longTermMemoryFeedbackPayload = prepared.longTermMemoryFeedbackPayload;

      let currentToolCallIteration = 0;
      let continueProcessing = true;
      let lastGMIOutput: GMIOutput | undefined; // To store the result from handleToolResult or final processTurnStream result

      await this.chunks.emitLifecycleUpdate({
        streamId: agentOSStreamId,
        gmiInstanceId: gmiInstanceIdForChunks,
        personaId: currentPersonaId,
        phase: 'executing',
        status: lifecycleDegraded ? 'degraded' : 'ok',
        details: {
          maxToolCallIterations: this.config.maxToolCallIterations,
        },
      });

      while (continueProcessing && currentToolCallIteration < this.config.maxToolCallIterations) {
        currentToolCallIteration++;

        if (lastGMIOutput?.toolCalls && lastGMIOutput.toolCalls.length > 0) {
          // This case should be handled by external call to orchestrateToolResult.
          // If GMI's handleToolResult itself requests more tools *synchronously* in its GMIOutput,
          // the orchestrator needs to initiate those.
          // For now, we assume gmi.processTurnStream is the entry point for a 'thought cycle'.
          // This part of the loop might need to re-evaluate if GMI.handleToolResult directly returns new tool_calls.
          // Based on GMI.ts, handleToolResult calls processTurnStream internally and returns a final GMIOutput for that step.
          // So, we'd take the tool_calls from that GMIOutput and then break this loop to let orchestrateToolResult handle them.
          await this.chunkTransformer.processGMIOutput(
            agentOSStreamId,
            streamContext,
            lastGMIOutput,
            true /*isContinuation*/
          );
          if (lastGMIOutput.toolCalls && lastGMIOutput.toolCalls.length > 0) {
            // Yield tool call requests and expect external call to orchestrateToolResult
            continueProcessing = false; // Exit this loop, further action via orchestrateToolResult
            break;
          }
          continueProcessing = !lastGMIOutput.isFinal; // isFinal comes from GMIOutput
          if (!continueProcessing) break;
          // If not final and no tool calls, what's the next GMI input? This implies GMI yielded intermediate text.
          // The GMI itself should manage its internal state for continuation.
          // Here we assume processTurnStream will pick up from where it left.
          // For simplicity in this refactor, we'll assume after handleToolResult, if not final & no tools, it's an error or unexpected state.
          // A robust solution might require GMI to provide a continuation token or explicit next step.
          console.warn(
            `AgentOSOrchestrator: GMI output after tool result was not final and had no tool calls. Ending turn for stream ${agentOSStreamId}.`
          );
          continueProcessing = false;
          break;
        }

        if (!gmi) {
          throw new Error('AgentOSOrchestrator: GMI not initialized (unexpected).');
        }
        const gmiForTurn = gmi;

        await withAgentOSSpan('agentos.gmi.process_turn_stream', async (span) => {
          span?.setAttribute('agentos.stream_id', agentOSStreamId);
          span?.setAttribute('agentos.gmi_id', gmiInstanceIdForChunks);
          span?.setAttribute('agentos.tool_call_iteration', currentToolCallIteration);

          const gmiStreamIterator = gmiForTurn.processTurnStream(gmiInput); // For initial turn or if GMI internally continues

          // Consume the async generator manually so we can capture its return value (GMIOutput).
          // `for await...of` does not expose the generator return value, which caused placeholder
          // FINAL_RESPONSE payloads (e.g. "Turn processing sequence complete.").
          while (true) {
            const { value, done } = await gmiStreamIterator.next();
            if (done) {
              lastGMIOutput = value;
              continueProcessing = false;
              break;
            }

            const gmiChunk = value;
            if (
              gmiChunk.type === GMIOutputChunkType.TOOL_CALL_REQUEST &&
              Array.isArray(gmiChunk.content) &&
              gmiChunk.content.length > 0
            ) {
              streamedToolCallRequest = true;
            }
            await this.chunkTransformer.transformAndPushGMIChunk(agentOSStreamId, streamContext, gmiChunk);

            // NOTE: Tool calls may be executed internally by the GMI/tool orchestrator. Do not stop
            // streaming on TOOL_CALL_REQUEST; treat it as informational for observers/UI.
            if (gmiChunk.isFinal || gmiChunk.type === GMIOutputChunkType.FINAL_RESPONSE_MARKER) {
              // Still keep consuming to capture the generator's return value.
              continueProcessing = false;
            }
          }
        });

        if (!continueProcessing) break; // Exit the while loop
      } // End while

      if (currentToolCallIteration >= this.config.maxToolCallIterations && continueProcessing) {
        console.warn(
          `AgentOSOrchestrator: Max tool call iterations reached for stream ${agentOSStreamId}. Forcing termination.`
        );
        didForceTerminate = true;
        await this.chunks.pushError(
          agentOSStreamId,
          currentPersonaId,
          gmiInstanceIdForChunks,
          GMIErrorCode.RATE_LIMIT_EXCEEDED, // Or a more specific code
          'Agent reached maximum tool call iterations.',
          { maxIterations: this.config.maxToolCallIterations }
        );
      }

      // Final processing at the end of the turn or if no more continuation.
      // This should use the true GMIOutput returned by GMI (either initial or after tool handling)
      // For now, this relies on the fact that the last interaction with GMI (processTurnStream or handleToolResult)
      // updated the conversation context, and we generate a final response summary.

      // Send a final response chunk if not already implicitly sent by an error or final GMI chunk transform.
      // This part needs careful consideration of what `lastGMIOutput` represents here.
      // It should represent the *actual* TReturn from the GMI's processing.
      const finalGMIStateForResponse: GMIOutput = lastGMIOutput || {
        isFinal: true,
        responseText: gmi ? 'Processing complete.' : 'Processing ended.',
      };

      if (
        finalGMIStateForResponse.isFinal === false &&
        Array.isArray(finalGMIStateForResponse.toolCalls) &&
        finalGMIStateForResponse.toolCalls.length > 0
      ) {
        keepStreamContextActive = true;

        if (conversationContext) {
          await this.toolResultHandler.persistPendingExternalToolRequest(
            agentOSStreamId,
            streamContext,
            gmiInstanceIdForChunks,
            finalGMIStateForResponse.toolCalls,
            finalGMIStateForResponse.responseText ||
              'Agent requires tool execution before it can complete the turn.'
          );
        }

        if (!streamedToolCallRequest) {
          await this.chunks.pushChunk(
            agentOSStreamId,
            AgentOSResponseChunkType.TOOL_CALL_REQUEST,
            gmiInstanceIdForChunks,
            currentPersonaId,
            false,
            {
              toolCalls: finalGMIStateForResponse.toolCalls,
              rationale:
                finalGMIStateForResponse.responseText ||
                'Agent requires tool execution before it can complete the turn.',
              executionMode: 'external',
              requiresExternalToolResult: true,
              metadata: buildToolCallChunkMetadata(streamContext),
            }
          );
        }

        return;
      }

      const normalizedUsage = normalizeUsage(finalGMIStateForResponse.usage);
      if (normalizedUsage) {
        turnMetricsUsage = {
          totalTokens: normalizedUsage.totalTokens,
          promptTokens: normalizedUsage.promptTokens,
          completionTokens: normalizedUsage.completionTokens,
          totalCostUSD:
            typeof normalizedUsage.totalCostUSD === 'number'
              ? normalizedUsage.totalCostUSD
              : undefined,
        };
      }
      if (didForceTerminate || Boolean(finalGMIStateForResponse.error)) {
        turnMetricsStatus = 'error';
      }
      const taskOutcome = evaluateTaskOutcome({
        finalOutput: finalGMIStateForResponse,
        didForceTerminate,
        degraded: lifecycleDegraded,
        customFlags: input.options?.customFlags,
      });
      turnMetricsTaskOutcome = taskOutcome;
      const taskOutcomeKpi = this.telemetry.updateKpi({
        outcome: taskOutcome,
        organizationId: organizationIdForMemory,
        personaId: currentPersonaId,
      });
      const taskOutcomeAlert = this.telemetry.maybeBuildAlert(taskOutcomeKpi);
      await this.chunks.pushChunk(
        agentOSStreamId,
        AgentOSResponseChunkType.METADATA_UPDATE,
        gmiInstanceIdForChunks,
        currentPersonaId,
        false,
        {
          updates: {
            taskOutcome,
            taskOutcomeKpi,
            taskOutcomeAlert,
          },
        }
      );
      if (turnMetricsStatus === 'error') {
        await this.chunks.emitLifecycleUpdate({
          streamId: agentOSStreamId,
          gmiInstanceId: gmiInstanceIdForChunks,
          personaId: currentPersonaId,
          phase: 'errored',
          status: 'error',
          details: {
            didForceTerminate,
            hasFinalError: Boolean(finalGMIStateForResponse.error),
            taskOutcomeStatus: taskOutcome.status,
            taskOutcomeScore: taskOutcome.score,
          },
        });
      } else {
        if (lifecycleDegraded) {
          await this.chunks.emitLifecycleUpdate({
            streamId: agentOSStreamId,
            gmiInstanceId: gmiInstanceIdForChunks,
            personaId: currentPersonaId,
            phase: 'recovered',
            status: 'ok',
            details: {
              recovery: 'Turn completed with fallback path.',
            },
          });
        }
        await this.chunks.emitLifecycleUpdate({
          streamId: agentOSStreamId,
          gmiInstanceId: gmiInstanceIdForChunks,
          personaId: currentPersonaId,
          phase: 'completed',
          status: 'ok',
          details: {
            toolIterations: currentToolCallIteration,
            taskOutcomeStatus: taskOutcome.status,
            taskOutcomeScore: taskOutcome.score,
          },
        });
      }

      if (conversationContext) {
        await this.toolResultHandler.clearPendingExternalToolRequest(conversationContext);
      }

      if (
        typeof finalGMIStateForResponse.responseText === 'string' &&
        finalGMIStateForResponse.responseText.trim() &&
        longTermMemoryFeedbackPayload !== undefined &&
        typeof this.dependencies.longTermMemoryRetriever?.recordRetrievalFeedback === 'function'
      ) {
        const feedbackQueryText = prepared.longTermMemoryQueryText ?? '';

        try {
          await this.dependencies.longTermMemoryRetriever.recordRetrievalFeedback({
            queryText: feedbackQueryText,
            responseText: finalGMIStateForResponse.responseText,
            feedbackPayload: longTermMemoryFeedbackPayload,
          });
        } catch (feedbackError: any) {
          console.warn(
            `AgentOSOrchestrator: Failed to record long-term memory feedback for stream ${agentOSStreamId}.`,
            feedbackError
          );
        }
      }

      // Persist assistant output into ConversationContext for durable memory / prompt reconstruction.
      if (this.config.enableConversationalPersistence && conversationContext) {
        const persistContext = conversationContext;
        try {
          if (
            typeof finalGMIStateForResponse.responseText === 'string' &&
            finalGMIStateForResponse.responseText.trim()
          ) {
            conversationContext.addMessage({
              role: MessageRole.ASSISTANT,
              content: finalGMIStateForResponse.responseText,
              metadata: { agentPersonaId: currentPersonaId, source: 'agentos_output' },
            });
          } else if (
            finalGMIStateForResponse.toolCalls &&
            finalGMIStateForResponse.toolCalls.length > 0
          ) {
            conversationContext.addMessage({
              role: MessageRole.ASSISTANT,
              content: null,
              tool_calls: finalGMIStateForResponse.toolCalls as any,
              metadata: { agentPersonaId: currentPersonaId, source: 'agentos_output_tool_calls' },
            });
          }

          await withAgentOSSpan('agentos.conversation.save', async (span) => {
            span?.setAttribute('agentos.stage', 'assistant_output');
            span?.setAttribute('agentos.stream_id', agentOSStreamId);
            await this.dependencies.conversationManager.saveConversation(persistContext);
          });
        } catch (persistError: any) {
          console.warn(
            `AgentOSOrchestrator: Failed to persist assistant output to ConversationContext for stream ${agentOSStreamId}.`,
            persistError
          );
        }
      }

      await this.chunks.pushChunk(
        agentOSStreamId,
        AgentOSResponseChunkType.FINAL_RESPONSE,
        gmiInstanceIdForChunks,
        currentPersonaId,
        true,
        {
          finalResponseText: finalGMIStateForResponse.responseText ?? null,
          finalResponseTextPlain:
            typeof finalGMIStateForResponse.responseText === 'string'
              ? renderPlainText(finalGMIStateForResponse.responseText)
              : null,
          finalToolCalls: finalGMIStateForResponse.toolCalls,
          finalUiCommands: finalGMIStateForResponse.uiCommands,
          audioOutput: finalGMIStateForResponse.audioOutput,
          imageOutput: finalGMIStateForResponse.imageOutput,
          usage: normalizedUsage,
          reasoningTrace: finalGMIStateForResponse.reasoningTrace,
          error: finalGMIStateForResponse.error,
          updatedConversationContext: conversationContext
            ? conversationContext.toJSON()
            : undefined,
          activePersonaDetails: snapshotPersonaDetails(gmi?.getPersona?.()),
          ragSources: finalGMIStateForResponse.ragSources,
        }
      );
      await this.dependencies.streamingManager.closeStream(agentOSStreamId, 'Processing complete.');
    } catch (error: any) {
      turnMetricsStatus = 'error';
      recordExceptionOnActiveSpan(error, `Error in orchestrateTurn for stream ${agentOSStreamId}`);
      const gmiErr =
        GMIError.wrap?.(
          error,
          GMIErrorCode.GMI_PROCESSING_ERROR,
          `Error in orchestrateTurn for stream ${agentOSStreamId}`
        ) ||
        new GMIError(
          `Error in orchestrateTurn for stream ${agentOSStreamId}: ${error.message}`,
          GMIErrorCode.GMI_PROCESSING_ERROR,
          error
        );
      turnMetricsTaskOutcome = {
        status: 'failed',
        score: 0,
        reason: `Exception before completion: ${gmiErr.code}`,
        source: 'heuristic',
      };
      const taskOutcomeKpi = this.telemetry.updateKpi({
        outcome: turnMetricsTaskOutcome,
        organizationId: organizationIdForMemory,
        personaId: currentPersonaId,
      });
      const taskOutcomeAlert = this.telemetry.maybeBuildAlert(taskOutcomeKpi);
      console.error(
        `AgentOSOrchestrator: Error during _processTurnInternal for stream ${agentOSStreamId}:`,
        gmiErr
      );
      await this.chunks.pushChunk(
        agentOSStreamId,
        AgentOSResponseChunkType.METADATA_UPDATE,
        gmiInstanceIdForChunks,
        currentPersonaId ?? 'unknown_persona',
        false,
        {
          updates: {
            taskOutcome: turnMetricsTaskOutcome,
            taskOutcomeKpi,
            taskOutcomeAlert,
          },
        }
      );
      await this.chunks.emitLifecycleUpdate({
        streamId: agentOSStreamId,
        gmiInstanceId: gmiInstanceIdForChunks,
        personaId: currentPersonaId ?? 'unknown_persona',
        phase: 'errored',
        status: 'error',
        details: {
          code: gmiErr.code,
          message: gmiErr.message,
          taskOutcomeStatus: turnMetricsTaskOutcome.status,
          taskOutcomeScore: turnMetricsTaskOutcome.score,
        },
      });
      await this.chunks.pushError(
        agentOSStreamId,
        currentPersonaId ?? 'unknown_persona',
        gmiInstanceIdForChunks,
        gmiErr.code,
        gmiErr.message,
        gmiErr.details
      );
      await this.toolResultHandler.clearPendingExternalToolRequest(conversationContext);
      await this.dependencies.streamingManager.closeStream(
        agentOSStreamId,
        'Error during turn processing.'
      );
    } finally {
      recordAgentOSTurnMetrics({
        durationMs: Date.now() - turnStartedAt,
        status: turnMetricsStatus,
        personaId: turnMetricsPersonaId,
        usage: turnMetricsUsage,
        taskOutcomeStatus: turnMetricsTaskOutcome?.status,
        taskOutcomeScore: turnMetricsTaskOutcome?.score,
      });

      // Stream is closed explicitly in the success/error paths; this finally block always
      // clears internal state to avoid leaks, unless we are waiting for an external
      // tool result to continue this same stream.
      if (!keepStreamContextActive) {
        this.activeStreamContexts.delete(agentOSStreamId);
        console.log(
          `AgentOSOrchestrator: Finished processing for AgentOS Stream ${agentOSStreamId}. Context removed.`
        );
      } else {
        console.log(
          `AgentOSOrchestrator: Stream ${agentOSStreamId} retained for external tool continuation.`
        );
      }
    }
  }

  /**
   * Handles the result of an external tool execution, feeding it back into the
   * relevant GMI instance for continued processing.
   * Delegates to {@link ExternalToolResultHandler}.
   */
  public async orchestrateToolResult(
    agentOSStreamId: StreamId,
    toolCallId: string,
    toolName: string,
    toolOutput: any,
    isSuccess: boolean,
    errorMessage?: string
  ): Promise<void> {
    this.ensureInitialized();
    return this.toolResultHandler.orchestrateToolResult(
      agentOSStreamId, toolCallId, toolName, toolOutput, isSuccess, errorMessage
    );
  }

  /**
   * Handles one or more external tool results in batch.
   * Delegates to {@link ExternalToolResultHandler}.
   */
  public async orchestrateToolResults(
    agentOSStreamId: StreamId,
    toolResults: AgentOSToolResultInput[]
  ): Promise<void> {
    this.ensureInitialized();
    return this.toolResultHandler.orchestrateToolResults(agentOSStreamId, toolResults);
  }

  // processGMIOutput, transformAndPushGMIChunk, constructGMITurnInput, and
  // filterTurnPlanForDisabledSessionSkills — delegated to this.chunkTransformer (GMIChunkTransformer)

  /**
   * Shuts down the AgentOSOrchestrator.
   * Currently, this mainly involves clearing active stream contexts.
   * Dependencies like GMIManager are assumed to be shut down by AgentOS.
   *
   * @public
   * @async
   * @returns {Promise<void>} A promise that resolves when shutdown is complete.
   */
  public async shutdown(): Promise<void> {
    console.log('AgentOSOrchestrator: Shutting down...');
    // Notify and close streams managed by StreamingManager for contexts held here
    for (const streamId of this.activeStreamContexts.keys()) {
      try {
        await this.dependencies.streamingManager.closeStream(
          streamId,
          'Orchestrator shutting down.'
        );
      } catch (e: any) {
        console.error(
          `AgentOSOrchestrator: Error closing stream ${streamId} during shutdown: ${e.message}`
        );
      }
    }
    this.activeStreamContexts.clear();
    this.telemetry?.kpiWindows.clear();
    this.telemetry?.alertState.clear();
    this.initialized = false;
    console.log('AgentOSOrchestrator: Shutdown complete.');
  }
}
