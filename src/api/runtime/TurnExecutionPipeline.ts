/**
 * @fileoverview Pre-GMI turn preparation pipeline.
 *
 * This class encapsulates the 12 pre-LLM-call phases of a turn:
 * GMI acquisition, turn planning, capability discovery, adaptive execution
 * policies, organization context resolution, long-term memory policy,
 * inbound message persistence, rolling summary compaction, prompt profile
 * routing, long-term memory retrieval, conversation history assembly,
 * and metadata/memory-sink persistence.
 *
 * The pipeline produces a {@link PreparedTurnContext} that the orchestrator
 * consumes to run the GMI tool-call loop and finalize the response.
 *
 * Extracted from AgentOSOrchestrator to reduce the size of
 * `_processTurnInternal` and improve testability of the pre-LLM pipeline.
 *
 * @module backend/agentos/api/TurnExecutionPipeline
 */

import type { StreamId } from '../../core/streaming/StreamingManager';
import type { StreamChunkEmitter } from './StreamChunkEmitter';
import type { AgentOSOrchestratorDependencies } from '../types/OrchestratorConfig';
import type { AgentOSInput } from '../types/AgentOSInput';
import type { GMIChunkTransformer } from './GMIChunkTransformer';
import type { TaskOutcomeTelemetryManager, AdaptiveExecutionDecision } from './TaskOutcomeTelemetryManager';
import {
  AgentOSResponseChunkType,
} from '../types/AgentOSResponse';
import type { ConversationContext } from '../../core/conversation/ConversationContext';
import { MessageRole } from '../../core/conversation/ConversationMessage';
import type {
  IGMI,
  GMITurnInput,
} from '../../cognition/substrate/IGMI';
import { GMIInteractionType } from '../../cognition/substrate/IGMI';
import { GMIError, GMIErrorCode } from '../../core/utils/errors.js';
import { withAgentOSSpan } from '../../safety/evaluation/observability/otel';
import type { TurnPlan } from '../../orchestration/turn-planner/TurnPlanner';
import {
  executeRollingSummaryPhase,
  type RollingSummaryPhaseResult,
} from './turn-phases/rolling-summary';
import { executePromptProfilePhase } from './turn-phases/prompt-profile';
import { executeLongTermMemoryPhase } from './turn-phases/long-term-memory';
import { assembleConversationHistory } from './turn-phases/conversation-history';
import type { RollingSummaryCompactionConfig, RollingSummaryCompactionResult } from '../../core/conversation/RollingSummaryCompactor';
import type {
  IRollingSummaryMemorySink,
  RollingSummaryMemoryUpdate,
} from '../../core/conversation/IRollingSummaryMemorySink';
import {
  DEFAULT_LONG_TERM_MEMORY_POLICY,
  hasAnyLongTermMemoryScope,
  LONG_TERM_MEMORY_POLICY_METADATA_KEY,
  resolveLongTermMemoryPolicy,
  type ResolvedLongTermMemoryPolicy,
} from '../../core/conversation/LongTermMemoryPolicy';
import type {
  LongTermMemoryRecallProfile,
  AgentOSLongTermMemoryRecallConfig,
  AgentOSTenantRoutingConfig,
} from '../types/OrchestratorConfig';

/**
 * Minimal stream context shape, matching the ActiveStreamContext used by
 * the orchestrator and other extracted classes.
 */
export interface PipelineStreamContext {
  gmi: IGMI;
  userId: string;
  sessionId: string;
  personaId: string;
  conversationId: string;
  organizationId?: string;
  conversationContext: ConversationContext;
  userApiKeys?: Record<string, string>;
  processingOptions?: { preferredModelId?: string; preferredProviderId?: string };
  languageNegotiation?: any;
}

/**
 * Result of the pre-LLM turn preparation pipeline.
 *
 * Contains all the hydrated state that the orchestrator needs to run the
 * GMI tool-call loop and finalize the turn.
 */
export interface PreparedTurnContext {
  /** The GMI instance for this turn. */
  gmi: IGMI;
  /** The hydrated conversation context. */
  conversationContext: ConversationContext;
  /** The resolved persona ID from the GMI. */
  currentPersonaId: string;
  /** The GMI instance ID used for chunk attribution. */
  gmiInstanceIdForChunks: string;
  /** The constructed GMI input for this turn. */
  gmiInput: GMITurnInput;
  /** The active stream context (registered in the shared map). */
  streamContext: PipelineStreamContext;
  /** The resolved organization ID for memory scoping. */
  organizationIdForMemory: string | undefined;
  /** The resolved long-term memory policy for this turn. */
  longTermMemoryPolicy: ResolvedLongTermMemoryPolicy | null;
  /** Whether the turn was planned with a degraded/fallback path. */
  lifecycleDegraded: boolean;
  /** Long-term memory feedback payload (for recording feedback after the turn). */
  longTermMemoryFeedbackPayload: any;
  /** Long-term memory retrieval diagnostics. */
  longTermMemoryRetrievalDiagnostics: any;
  /** The user query text used for long-term memory retrieval. */
  longTermMemoryQueryText: string | undefined;
}

/**
 * Resolved config shape consumed by the pipeline.
 * Extracted from the orchestrator's full resolved config to avoid coupling.
 */
export interface TurnPipelineConfig {
  enableConversationalPersistence: boolean;
  maxToolCallIterations: number;
  promptProfileConfig: any;
  rollingSummaryCompactionConfig: RollingSummaryCompactionConfig | null;
  rollingSummaryCompactionProfilesConfig: any;
  rollingSummarySystemPrompt: string;
  rollingSummaryStateKey: string;
  longTermMemoryRecall: {
    profile: LongTermMemoryRecallProfile;
    cadenceTurns: number;
    forceOnCompaction: boolean;
    maxContextChars: number;
    topKByScope: Record<'user' | 'persona' | 'organization', number>;
  };
  tenantRouting: {
    mode: 'multi_tenant' | 'single_tenant';
    defaultOrganizationId?: string;
    strictOrganizationIsolation: boolean;
  };
  taskOutcomeTelemetry: any;
  adaptiveExecution: any;
}

/**
 * @class TurnExecutionPipeline
 * @description
 * Runs the 12 pre-LLM phases of a turn and produces a {@link PreparedTurnContext}.
 *
 * **Phase sequence:**
 * 1. Validate input (selectedPersonaId required)
 * 2. GMI acquisition via `getOrCreateGMIForSession`
 * 3. Stream context registration
 * 4. GMI input construction (delegates to {@link GMIChunkTransformer})
 * 5. Turn planning via ITurnPlanner
 * 6. Adaptive execution policy application
 * 7. Organization context and long-term memory policy resolution
 * 8. Inbound message persistence
 * 9. Rolling summary compaction
 * 10. Prompt profile routing
 * 11. Long-term memory retrieval
 * 12. Conversation history assembly, metadata persistence, memory sink,
 *     and metadata chunk emission
 *
 * The orchestrator calls `prepareTurn()` and then uses the returned context
 * to drive the GMI streaming loop.
 */
export class TurnExecutionPipeline {
  /**
   * Creates a TurnExecutionPipeline.
   *
   * @param activeStreamContexts - Shared mutable map of active stream contexts.
   * @param chunks - Delegate for assembling and emitting response chunks.
   * @param dependencies - Injected service dependencies.
   * @param config - Resolved orchestrator config for this pipeline's needs.
   * @param chunkTransformer - For constructing GMI input and filtering turn plans.
   * @param telemetry - For adaptive execution policy decisions.
   * @param resolveOrganizationContext - Callback to resolve tenant org context.
   */
  constructor(
    private readonly activeStreamContexts: Map<string, PipelineStreamContext>,
    private readonly chunks: StreamChunkEmitter,
    private readonly dependencies: AgentOSOrchestratorDependencies,
    private readonly config: TurnPipelineConfig,
    private readonly chunkTransformer: GMIChunkTransformer,
    private readonly telemetry: TaskOutcomeTelemetryManager,
    private readonly resolveOrganizationContext: (inputOrganizationId: unknown) => string | undefined,
  ) {}

  /**
   * Executes the pre-LLM turn preparation pipeline.
   *
   * @param agentOSStreamId - The stream ID allocated for this turn.
   * @param input - The AgentOS-level input for this turn.
   * @returns A {@link PreparedTurnContext} containing everything the
   *   orchestrator needs to drive the GMI streaming loop.
   * @throws {GMIError} If validation fails, GMI acquisition fails, or
   *   turn planning raises a fatal error.
   */
  async prepareTurn(
    agentOSStreamId: StreamId,
    input: AgentOSInput,
  ): Promise<PreparedTurnContext> {
    // -------------------------------------------------------------------
    // Phase 1: Validate input
    // -------------------------------------------------------------------
    const selectedPersonaId = input.selectedPersonaId;
    if (!selectedPersonaId) {
      throw new GMIError(
        'AgentOSOrchestrator requires a selectedPersonaId on AgentOSInput.',
        GMIErrorCode.VALIDATION_ERROR,
      );
    }

    // -------------------------------------------------------------------
    // Phase 2: GMI acquisition
    // -------------------------------------------------------------------
    const gmiResult = await withAgentOSSpan('agentos.gmi.get_or_create', async (span) => {
      span?.setAttribute('agentos.user_id', input.userId);
      span?.setAttribute('agentos.session_id', input.sessionId);
      span?.setAttribute('agentos.persona_id', selectedPersonaId);
      if (typeof input.conversationId === 'string' && input.conversationId.trim()) {
        span?.setAttribute('agentos.conversation_id', input.conversationId.trim());
      }
      return this.dependencies.gmiManager.getOrCreateGMIForSession(
        input.userId,
        input.sessionId,
        selectedPersonaId,
        input.conversationId,
        input.options?.preferredModelId,
        input.options?.preferredProviderId,
        input.userApiKeys,
      );
    });
    const gmi = gmiResult.gmi;
    const conversationContext = gmiResult.conversationContext;
    const currentPersonaId = gmi.getCurrentPrimaryPersonaId();
    const gmiInstanceIdForChunks = gmi.getGMIId();

    // -------------------------------------------------------------------
    // Phase 3: Stream context registration
    // -------------------------------------------------------------------
    // eslint-disable-next-line prefer-const -- assigned in Phase 7, used in later phases
    let organizationIdForMemory: string | undefined;
    const streamContext: PipelineStreamContext = {
      gmi,
      userId: input.userId,
      sessionId: input.sessionId,
      personaId: currentPersonaId,
      organizationId: organizationIdForMemory,
      conversationId: conversationContext.sessionId,
      conversationContext,
      userApiKeys: input.userApiKeys,
      processingOptions: input.options,
    };
    this.activeStreamContexts.set(agentOSStreamId, streamContext);

    await this.chunks.pushChunk(
      agentOSStreamId,
      AgentOSResponseChunkType.SYSTEM_PROGRESS,
      gmiInstanceIdForChunks,
      currentPersonaId,
      false,
      {
        message: `Initializing persona ${currentPersonaId}... GMI: ${gmiInstanceIdForChunks}`,
        progressPercentage: 10,
      },
    );

    // -------------------------------------------------------------------
    // Phase 4: GMI input construction
    // -------------------------------------------------------------------
    const gmiInput = this.chunkTransformer.constructGMITurnInput(agentOSStreamId, input, streamContext);

    // -------------------------------------------------------------------
    // Phase 5: Turn planning
    // -------------------------------------------------------------------
    let turnPlan: TurnPlan | null = null;
    const resolvedOrganizationId = this.resolveOrganizationContext(input.organizationId);
    streamContext.organizationId = resolvedOrganizationId;

    if (this.dependencies.turnPlanner) {
      const planningMessage =
        gmiInput.type === GMIInteractionType.TEXT && typeof gmiInput.content === 'string'
          ? gmiInput.content
          : gmiInput.type === GMIInteractionType.MULTIMODAL_CONTENT
            ? JSON.stringify(gmiInput.content)
            : '';
      try {
        turnPlan = await this.dependencies.turnPlanner.planTurn({
          userId: input.userId,
          organizationId: resolvedOrganizationId,
          sessionId: input.sessionId,
          conversationId: input.conversationId,
          persona: gmi.getPersona(),
          userMessage: planningMessage,
          options: input.options,
          excludedCapabilityIds: input.disabledSessionSkillIds,
        });
      } catch (planningError: any) {
        throw new GMIError(
          `Turn planning failed before execution: ${planningError?.message || String(planningError)}`,
          GMIErrorCode.PROCESSING_ERROR,
          { streamId: agentOSStreamId, planningError },
        );
      }
    }
    turnPlan = this.chunkTransformer.filterTurnPlanForDisabledSessionSkills(turnPlan, input);

    // -------------------------------------------------------------------
    // Phase 6: Adaptive execution policies
    // -------------------------------------------------------------------
    const adaptiveExecution = this.telemetry.maybeApplyAdaptivePolicy({
      turnPlan,
      organizationId: resolvedOrganizationId,
      personaId: currentPersonaId,
      requestCustomFlags: input.options?.customFlags,
    });
    const adaptiveExecutionPayload =
      adaptiveExecution.applied || adaptiveExecution.kpi || adaptiveExecution.actions
        ? {
            applied: adaptiveExecution.applied,
            reason: adaptiveExecution.reason,
            kpi: adaptiveExecution.kpi,
            actions: adaptiveExecution.actions,
          }
        : undefined;

    await this.chunks.emitLifecycleUpdate({
      streamId: agentOSStreamId,
      gmiInstanceId: gmiInstanceIdForChunks,
      personaId: currentPersonaId,
      phase: 'planned',
      status: 'ok',
      details: turnPlan
        ? {
            plannerVersion: turnPlan.policy.plannerVersion,
            toolFailureMode: turnPlan.policy.toolFailureMode,
            toolSelectionMode: turnPlan.policy.toolSelectionMode,
            adaptiveExecution: adaptiveExecutionPayload,
          }
        : { plannerVersion: 'none' },
    });

    let lifecycleDegraded = false;
    if (turnPlan?.capability.fallbackApplied || adaptiveExecution.applied) {
      lifecycleDegraded = true;
      await this.chunks.emitLifecycleUpdate({
        streamId: agentOSStreamId,
        gmiInstanceId: gmiInstanceIdForChunks,
        personaId: currentPersonaId,
        phase: 'degraded',
        status: 'degraded',
        details: {
          reason:
            turnPlan?.capability.fallbackReason || adaptiveExecution.reason || 'fallback applied',
          discoveryAttempts: turnPlan?.diagnostics.discoveryAttempts,
          adaptiveExecution: adaptiveExecutionPayload,
        },
      });
    }

    // -------------------------------------------------------------------
    // Phase 7: Organization context + long-term memory policy
    // -------------------------------------------------------------------
    organizationIdForMemory = resolvedOrganizationId;
    let longTermMemoryPolicy: ResolvedLongTermMemoryPolicy | null = null;

    if (conversationContext) {
      const rawPrevPolicy = conversationContext.getMetadata(LONG_TERM_MEMORY_POLICY_METADATA_KEY);
      const prevPolicy =
        rawPrevPolicy && typeof rawPrevPolicy === 'object'
          ? (rawPrevPolicy as ResolvedLongTermMemoryPolicy)
          : null;
      const inputPolicy = input.memoryControl?.longTermMemory ?? null;

      longTermMemoryPolicy = resolveLongTermMemoryPolicy({
        previous: prevPolicy,
        input: inputPolicy,
        defaults: DEFAULT_LONG_TERM_MEMORY_POLICY,
      });

      if (inputPolicy || !prevPolicy) {
        conversationContext.setMetadata(
          LONG_TERM_MEMORY_POLICY_METADATA_KEY,
          longTermMemoryPolicy,
        );
      }
    } else {
      longTermMemoryPolicy = resolveLongTermMemoryPolicy({
        defaults: DEFAULT_LONG_TERM_MEMORY_POLICY,
      });
    }

    if (turnPlan) {
      (gmiInput.metadata ??= {} as any).executionPolicy = turnPlan.policy;
      (gmiInput.metadata as any).capabilityDiscovery = turnPlan.capability;
    }

    (gmiInput.metadata ??= {} as any).organizationId = organizationIdForMemory ?? null;
    (gmiInput.metadata as any).longTermMemoryPolicy = longTermMemoryPolicy;

    // -------------------------------------------------------------------
    // Phase 8: Inbound message persistence
    // -------------------------------------------------------------------
    if (this.config.enableConversationalPersistence && conversationContext) {
      const persistContext = conversationContext;
      try {
        if (gmiInput.type === GMIInteractionType.TEXT && typeof gmiInput.content === 'string') {
          conversationContext.addMessage({
            role: MessageRole.USER,
            content: gmiInput.content,
            name: input.userId,
            metadata: { agentPersonaId: currentPersonaId, source: 'agentos_input' },
          });
        } else if (gmiInput.type === GMIInteractionType.MULTIMODAL_CONTENT) {
          conversationContext.addMessage({
            role: MessageRole.USER,
            content: JSON.stringify(gmiInput.content),
            name: input.userId,
            metadata: { agentPersonaId: currentPersonaId, source: 'agentos_input_multimodal' },
          });
        } else if (gmiInput.type === GMIInteractionType.SYSTEM_MESSAGE) {
          conversationContext.addMessage({
            role: MessageRole.SYSTEM,
            content:
              typeof gmiInput.content === 'string'
                ? gmiInput.content
                : JSON.stringify(gmiInput.content),
            metadata: { agentPersonaId: currentPersonaId, source: 'agentos_input_system' },
          });
        }
        await withAgentOSSpan('agentos.conversation.save', async (span) => {
          span?.setAttribute('agentos.stage', 'inbound');
          span?.setAttribute('agentos.stream_id', agentOSStreamId);
          await this.dependencies.conversationManager.saveConversation(persistContext);
        });
      } catch (persistError: any) {
        console.warn(
          `AgentOSOrchestrator: Failed to persist inbound message to ConversationContext for stream ${agentOSStreamId}.`,
          persistError,
        );
      }
    }

    // -------------------------------------------------------------------
    // Phase 9: Rolling summary compaction
    // -------------------------------------------------------------------
    const modeForRouting =
      typeof input.options?.customFlags?.mode === 'string' &&
      input.options.customFlags.mode.trim()
        ? input.options.customFlags.mode.trim()
        : currentPersonaId;

    const rollingSummaryPhase = await executeRollingSummaryPhase({
      conversationContext,
      modeForRouting,
      streamId: agentOSStreamId,
      rollingSummaryCompactionConfig: this.config.rollingSummaryCompactionConfig,
      rollingSummaryCompactionProfilesConfig: this.config.rollingSummaryCompactionProfilesConfig,
      rollingSummarySystemPrompt: this.config.rollingSummarySystemPrompt,
      rollingSummaryStateKey: this.config.rollingSummaryStateKey,
      modelProviderManager: this.dependencies.modelProviderManager,
    });
    const {
      result: rollingSummaryResult,
      profileId: rollingSummaryProfileId,
      configForTurn: rollingSummaryConfigForTurn,
    } = rollingSummaryPhase;
    const rollingSummaryEnabled = rollingSummaryPhase.enabled;
    const rollingSummaryText = rollingSummaryPhase.summaryText;

    if (!gmiInput.metadata) {
      gmiInput.metadata = {};
    }
    (gmiInput.metadata as any).rollingSummary =
      rollingSummaryEnabled && rollingSummaryText
        ? { text: rollingSummaryText, json: rollingSummaryResult?.summaryJson ?? undefined }
        : null;

    // -------------------------------------------------------------------
    // Phase 10: Prompt-profile routing
    // -------------------------------------------------------------------
    const promptProfileSelection = executePromptProfilePhase({
      conversationContext,
      promptProfileConfig: this.config.promptProfileConfig,
      modeForRouting,
      gmiInput,
      didCompact: Boolean(rollingSummaryResult?.didCompact),
    });

    (gmiInput.metadata as any).promptProfile = promptProfileSelection
      ? {
          id: promptProfileSelection.presetId,
          systemInstructions: promptProfileSelection.systemInstructions,
          reason: promptProfileSelection.reason,
        }
      : null;

    // -------------------------------------------------------------------
    // Phase 11: Long-term memory retrieval
    // -------------------------------------------------------------------
    const longTermMemoryPhase = await executeLongTermMemoryPhase({
      conversationContext,
      longTermMemoryRetriever: this.dependencies.longTermMemoryRetriever,
      longTermMemoryPolicy,
      gmiInput,
      streamId: agentOSStreamId,
      userId: streamContext.userId,
      organizationId: organizationIdForMemory,
      conversationId: streamContext.conversationId,
      personaId: currentPersonaId,
      modeForRouting,
      recallConfig: this.config.longTermMemoryRecall,
      didCompact: Boolean(rollingSummaryResult?.didCompact),
    });
    const longTermMemoryContextText = longTermMemoryPhase.contextText;
    const longTermMemoryRetrievalDiagnostics = longTermMemoryPhase.diagnostics;
    const longTermMemoryFeedbackPayload = longTermMemoryPhase.feedbackPayload;
    const longTermMemoryShouldReview = longTermMemoryPhase.shouldReview;
    const longTermMemoryReviewReason = longTermMemoryPhase.reviewReason;

    (gmiInput.metadata as any).longTermMemoryContext =
      typeof longTermMemoryContextText === 'string' && longTermMemoryContextText.length > 0
        ? longTermMemoryContextText
        : null;

    // --- Conversation history assembly ---
    const historyForPrompt = assembleConversationHistory({
      conversationContext,
      gmiInput,
      rollingSummaryEnabled,
      rollingSummaryResult,
      rollingSummaryText,
      rollingSummaryConfigForTurn,
    });
    if (historyForPrompt) {
      (gmiInput.metadata as any).conversationHistoryForPrompt = historyForPrompt;
    }

    // -------------------------------------------------------------------
    // Phase 12: Metadata persistence, memory sink, metadata chunk emission
    // -------------------------------------------------------------------

    // Persist compaction/router metadata updates prior to the main LLM call.
    if (this.config.enableConversationalPersistence && conversationContext) {
      const persistContext = conversationContext;
      try {
        await withAgentOSSpan('agentos.conversation.save', async (span) => {
          span?.setAttribute('agentos.stage', 'metadata');
          span?.setAttribute('agentos.stream_id', agentOSStreamId);
          await this.dependencies.conversationManager.saveConversation(persistContext);
        });
      } catch (metadataPersistError: any) {
        console.warn(
          `AgentOSOrchestrator: Failed to persist conversation metadata updates for stream ${agentOSStreamId}.`,
          metadataPersistError,
        );
      }
    }

    // Best-effort: persist structured rolling memory to an external store.
    if (
      rollingSummaryEnabled &&
      rollingSummaryResult?.didCompact &&
      typeof rollingSummaryResult.summaryText === 'string' &&
      this.dependencies.rollingSummaryMemorySink &&
      Boolean(longTermMemoryPolicy?.enabled) &&
      hasAnyLongTermMemoryScope(longTermMemoryPolicy ?? DEFAULT_LONG_TERM_MEMORY_POLICY)
    ) {
      const update: RollingSummaryMemoryUpdate = {
        userId: streamContext.userId,
        organizationId: organizationIdForMemory,
        sessionId: streamContext.sessionId,
        conversationId: streamContext.conversationId,
        personaId: currentPersonaId,
        mode: modeForRouting,
        profileId: rollingSummaryProfileId,
        memoryPolicy: longTermMemoryPolicy ?? undefined,
        summaryText: rollingSummaryResult.summaryText,
        summaryJson: rollingSummaryResult.summaryJson ?? null,
        summaryUptoTimestamp: rollingSummaryResult.summaryUptoTimestamp ?? null,
        summaryUpdatedAt: rollingSummaryResult.summaryUpdatedAt ?? null,
      };
      void this.dependencies.rollingSummaryMemorySink
        .upsertRollingSummaryMemory(update)
        .catch((error: any) => {
          console.warn(
            `AgentOSOrchestrator: Rolling summary sink failed for stream ${agentOSStreamId} (continuing).`,
            error,
          );
        });
    }

    // Emit routing + memory metadata as a first-class chunk for clients.
    await this.chunks.pushChunk(
      agentOSStreamId,
      AgentOSResponseChunkType.METADATA_UPDATE,
      gmiInstanceIdForChunks,
      currentPersonaId,
      false,
      {
        updates: {
          promptProfile: promptProfileSelection,
          organizationId: organizationIdForMemory ?? null,
          tenantRouting: {
            mode: this.config.tenantRouting.mode,
            strictOrganizationIsolation: this.config.tenantRouting.strictOrganizationIsolation,
            defaultOrganizationId: this.config.tenantRouting.defaultOrganizationId ?? null,
          },
          longTermMemoryPolicy,
          longTermMemoryRecall: this.config.longTermMemoryRecall,
          taskOutcomeTelemetry: this.config.taskOutcomeTelemetry,
          adaptiveExecution: this.config.adaptiveExecution,
          turnPlanning: turnPlan
            ? {
                policy: turnPlan.policy,
                diagnostics: turnPlan.diagnostics,
                adaptiveExecution: adaptiveExecutionPayload ?? null,
                discovery: {
                  enabled: turnPlan.capability.enabled,
                  kind: turnPlan.capability.kind,
                  selectedToolNames: turnPlan.capability.selectedToolNames,
                  fallbackApplied: turnPlan.capability.fallbackApplied,
                  fallbackReason: turnPlan.capability.fallbackReason,
                  tokenEstimate: turnPlan.capability.result?.tokenEstimate,
                  diagnostics: turnPlan.capability.result?.diagnostics,
                },
              }
            : null,
          longTermMemoryRetrieval: longTermMemoryContextText
            ? {
                shouldReview: longTermMemoryShouldReview,
                reviewReason: longTermMemoryReviewReason,
                didRetrieve: true,
                contextChars: longTermMemoryContextText.length,
                diagnostics: longTermMemoryRetrievalDiagnostics,
              }
            : {
                shouldReview: longTermMemoryShouldReview,
                reviewReason: longTermMemoryReviewReason,
                didRetrieve: false,
              },
          rollingSummary: rollingSummaryResult
            ? {
                profileId: rollingSummaryProfileId,
                enabled: rollingSummaryResult.enabled,
                didCompact: rollingSummaryResult.didCompact,
                summaryText: rollingSummaryResult.summaryText,
                summaryJson: rollingSummaryResult.summaryJson,
                summaryUptoTimestamp: rollingSummaryResult.summaryUptoTimestamp,
                summaryUpdatedAt: rollingSummaryResult.summaryUpdatedAt,
                reason: rollingSummaryResult.reason,
              }
            : null,
        },
      },
    );

    return {
      gmi,
      conversationContext,
      currentPersonaId,
      gmiInstanceIdForChunks,
      gmiInput,
      streamContext,
      organizationIdForMemory,
      longTermMemoryPolicy,
      lifecycleDegraded,
      longTermMemoryFeedbackPayload,
      longTermMemoryRetrievalDiagnostics,
      longTermMemoryQueryText:
        typeof (longTermMemoryRetrievalDiagnostics as any)?.queryText === 'string'
          ? ((longTermMemoryRetrievalDiagnostics as any).queryText as string)
          : typeof gmiInput.content === 'string'
            ? gmiInput.content
            : JSON.stringify(gmiInput.content),
    };
  }
}
