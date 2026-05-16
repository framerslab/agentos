/**
 * @fileoverview Transforms GMI output into AgentOS response chunks.
 *
 * This class encapsulates the mapping layer between GMI's internal output
 * representation (GMIOutput, GMIOutputChunk) and the public-facing AgentOS
 * response chunk types. It also handles GMI input construction from AgentOS
 * input and capability discovery filtering.
 *
 * Extracted from AgentOSOrchestrator to separate the data-transformation
 * concerns from orchestration control flow.
 *
 * @module backend/agentos/api/GMIChunkTransformer
 */

import type { StreamId } from '../../core/streaming/StreamingManager';
import type { StreamChunkEmitter } from './StreamChunkEmitter';
import type { AgentOSOrchestratorDependencies } from '../types/OrchestratorConfig';
import {
  AgentOSResponseChunkType,
} from '../types/AgentOSResponse';
import type { AgentOSInput } from '../types/AgentOSInput';
import type { ConversationContext } from '../../core/conversation/ConversationContext';
import type {
  IGMI,
  GMITurnInput,
  GMIOutputChunk,
  GMIOutput,
  ToolCallRequest,
  UICommand,
} from '../../cognition/substrate/IGMI';
import {
  GMIInteractionType,
  GMIOutputChunkType,
} from '../../cognition/substrate/IGMI';
import { GMIErrorCode } from '../../core/utils/errors.js';
import { normalizeUsage, snapshotPersonaDetails } from '../../orchestration/turn-planner/helpers';
import { withAgentOSSpan } from '../../safety/evaluation/observability/otel';
import { uuidv4 } from '../../core/utils/uuid.js';
import type { ITurnPlanner, TurnPlan } from '../../orchestration/turn-planner/TurnPlanner';
import { CapabilityContextAssembler } from '../../cognition/discovery/CapabilityContextAssembler.js';
import { filterCapabilityDiscoveryResultByDisabledSkills } from './selfImprovementRuntime.js';

/**
 * Minimal stream context shape needed by the transformer.
 * Mirrors the ActiveStreamContext defined in AgentOSOrchestrator.
 */
export interface TransformerStreamContext {
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
 * Callback for clearing pending external tool requests.
 * Provided by the ExternalToolResultHandler so the transformer does not need
 * a direct dependency on that class.
 */
export type ClearPendingRequestCallback = (
  conversationContext: ConversationContext | undefined,
) => Promise<void>;

/** Builds metadata payload attached to TOOL_CALL_REQUEST chunks. */
function buildToolCallChunkMetadata(
  streamContext: TransformerStreamContext,
  extra?: Record<string, unknown>,
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

/**
 * @class GMIChunkTransformer
 * @description
 * Provides the data-transformation bridge between GMI and AgentOS:
 *
 * - **processGMIOutput** - Converts a non-streaming {@link GMIOutput} (returned
 *   by `handleToolResult` or the generator return value) into AgentOS response
 *   chunks (text deltas, UI commands, errors, final responses).
 *
 * - **transformAndPushGMIChunk** - Maps a single streaming {@link GMIOutputChunk}
 *   to the corresponding {@link AgentOSResponseChunkType} and pushes it.
 *
 * - **constructGMITurnInput** - Builds a {@link GMITurnInput} from an
 *   {@link AgentOSInput}, performing interaction type detection (text /
 *   multimodal / system) and metadata assembly.
 *
 * - **filterTurnPlanForDisabledSessionSkills** - Removes disabled skills from
 *   a turn plan's capability discovery results.
 *
 * All chunk emission is delegated to the shared {@link StreamChunkEmitter}.
 */
export class GMIChunkTransformer {
  private readonly capabilityContextAssembler = new CapabilityContextAssembler();

  /**
   * Creates a GMIChunkTransformer.
   *
   * @param activeStreamContexts - Shared mutable map of active stream contexts.
   *   The transformer deletes entries when a stream reaches a terminal state
   *   (error or final response).
   * @param chunks - Delegate for assembling and emitting response chunks.
   * @param dependencies - Injected service dependencies (streamingManager,
   *   conversationManager).
   * @param enableConversationalPersistence - Whether to persist messages.
   * @param clearPendingRequest - Callback to clear pending external tool requests
   *   from conversation metadata.
   */
  constructor(
    private readonly activeStreamContexts: Map<string, TransformerStreamContext>,
    private readonly chunks: StreamChunkEmitter,
    private readonly dependencies: AgentOSOrchestratorDependencies,
    private readonly enableConversationalPersistence: boolean,
    private clearPendingRequest: ClearPendingRequestCallback,
  ) {}

  /**
   * Replaces the clearPendingRequest callback after construction.
   *
   * @param cb - The new callback.
   */
  setClearPendingRequestCallback(cb: ClearPendingRequestCallback): void {
    this.clearPendingRequest = cb;
  }

  // ---------------------------------------------------------------------------
  // processGMIOutput — non-streaming GMIOutput → AgentOS chunks
  // ---------------------------------------------------------------------------

  /**
   * Processes a non-streaming {@link GMIOutput} (typically from
   * `handleToolResult` or the generator return value) and pushes the
   * corresponding AgentOS response chunks.
   *
   * Handles:
   * - Response text emission as TEXT_DELTA
   * - UI command emission
   * - Error handling with stream cleanup
   * - Final response emission with conversation persistence
   *
   * @param agentOSStreamId - The orchestrator stream ID.
   * @param streamContext - Active stream context for this interaction.
   * @param gmiOutput - The GMI output to transform.
   * @param _isContinuation - Whether this output is from an internal GMI
   *   continuation (currently informational only).
   */
  async processGMIOutput(
    agentOSStreamId: string,
    streamContext: TransformerStreamContext,
    gmiOutput: GMIOutput,
    _isContinuation: boolean,
  ): Promise<void> {
    const { gmi, personaId, conversationContext } = streamContext;
    const gmiInstanceIdForChunks = gmi.getGMIId();

    if (gmiOutput.responseText) {
      await this.chunks.pushChunk(
        agentOSStreamId,
        AgentOSResponseChunkType.TEXT_DELTA,
        gmiInstanceIdForChunks,
        personaId,
        false,
        { textDelta: gmiOutput.responseText },
      );
    }
    if (gmiOutput.uiCommands && gmiOutput.uiCommands.length > 0) {
      await this.chunks.pushChunk(
        agentOSStreamId,
        AgentOSResponseChunkType.UI_COMMAND,
        gmiInstanceIdForChunks,
        personaId,
        false,
        { uiCommands: gmiOutput.uiCommands },
      );
    }
    if (gmiOutput.error) {
      await this.clearPendingRequest(conversationContext);
      await this.chunks.pushError(
        agentOSStreamId,
        personaId,
        gmiInstanceIdForChunks,
        gmiOutput.error.code,
        gmiOutput.error.message,
        gmiOutput.error.details,
      );
      if (gmiOutput.isFinal) {
        this.activeStreamContexts.delete(agentOSStreamId);
        await this.dependencies.streamingManager.closeStream(
          agentOSStreamId,
          `GMI reported an error: ${gmiOutput.error.message}`,
        );
      }
      return;
    }

    // Tool calls from GMIOutput are handled by the calling method
    // (orchestrateTurn or orchestrateToolResult) to decide on looping or
    // yielding ToolCallRequestChunks.

    if (gmiOutput.isFinal && (!gmiOutput.toolCalls || gmiOutput.toolCalls.length === 0)) {
      await this.clearPendingRequest(conversationContext);
      if (this.enableConversationalPersistence && conversationContext) {
        await withAgentOSSpan('agentos.conversation.save', async (span) => {
          span?.setAttribute('agentos.stage', 'gmi_output_final');
          span?.setAttribute('agentos.stream_id', agentOSStreamId);
          await this.dependencies.conversationManager.saveConversation(conversationContext);
        });
      }
      await this.chunks.pushChunk(
        agentOSStreamId,
        AgentOSResponseChunkType.FINAL_RESPONSE,
        gmiInstanceIdForChunks,
        personaId,
        true,
        {
          finalResponseText: gmiOutput.responseText,
          finalToolCalls: gmiOutput.toolCalls,
          finalUiCommands: gmiOutput.uiCommands,
          audioOutput: gmiOutput.audioOutput,
          imageOutput: gmiOutput.imageOutput,
          usage: normalizeUsage(gmiOutput.usage),
          reasoningTrace: gmiOutput.reasoningTrace,
          error: gmiOutput.error,
          updatedConversationContext: conversationContext.toJSON(),
          activePersonaDetails: snapshotPersonaDetails(gmi.getPersona?.()),
          ragSources: gmiOutput.ragSources,
        },
      );
      this.activeStreamContexts.delete(agentOSStreamId);
      await this.dependencies.streamingManager.closeStream(agentOSStreamId, 'Processing complete.');
    }
  }

  // ---------------------------------------------------------------------------
  // transformAndPushGMIChunk — streaming GMIOutputChunk → AgentOS chunk
  // ---------------------------------------------------------------------------

  /**
   * Transforms a single streaming {@link GMIOutputChunk} into the corresponding
   * AgentOS response chunk type and pushes it via the {@link StreamChunkEmitter}.
   *
   * Supported chunk type mappings:
   * - TEXT_DELTA -> AgentOSResponseChunkType.TEXT_DELTA
   * - SYSTEM_MESSAGE -> AgentOSResponseChunkType.SYSTEM_PROGRESS
   * - TOOL_CALL_REQUEST -> AgentOSResponseChunkType.TOOL_CALL_REQUEST
   * - UI_COMMAND -> AgentOSResponseChunkType.UI_COMMAND
   * - ERROR -> pushError (with optional stream close on isFinal)
   * - FINAL_RESPONSE_MARKER -> no-op (consumed internally)
   * - USAGE_UPDATE -> logged to console
   *
   * @param agentOSStreamId - The orchestrator stream ID.
   * @param streamContext - Active stream context.
   * @param gmiChunk - The GMI output chunk to transform.
   */
  async transformAndPushGMIChunk(
    agentOSStreamId: string,
    streamContext: TransformerStreamContext,
    gmiChunk: GMIOutputChunk,
  ): Promise<void> {
    const { gmi, personaId } = streamContext;
    const gmiInstanceIdForChunks = gmi.getGMIId();

    switch (gmiChunk.type) {
      case GMIOutputChunkType.TEXT_DELTA:
        if (gmiChunk.content && typeof gmiChunk.content === 'string') {
          await this.chunks.pushChunk(
            agentOSStreamId,
            AgentOSResponseChunkType.TEXT_DELTA,
            gmiInstanceIdForChunks,
            personaId,
            gmiChunk.isFinal ?? false,
            { textDelta: gmiChunk.content },
          );
        }
        break;
      case GMIOutputChunkType.SYSTEM_MESSAGE:
        if (gmiChunk.content && typeof gmiChunk.content === 'object') {
          const progressContent = gmiChunk.content as {
            message: string;
            progressPercentage?: number;
            statusCode?: string;
          };
          await this.chunks.pushChunk(
            agentOSStreamId,
            AgentOSResponseChunkType.SYSTEM_PROGRESS,
            gmiInstanceIdForChunks,
            personaId,
            gmiChunk.isFinal ?? false,
            progressContent,
          );
        }
        break;
      case GMIOutputChunkType.TOOL_CALL_REQUEST:
        if (gmiChunk.content && Array.isArray(gmiChunk.content)) {
          const toolCalls = gmiChunk.content as ToolCallRequest[];
          const executionMode =
            gmiChunk.metadata?.executionMode === 'external' ? 'external' : 'internal';
          await this.chunks.pushChunk(
            agentOSStreamId,
            AgentOSResponseChunkType.TOOL_CALL_REQUEST,
            gmiInstanceIdForChunks,
            personaId,
            false,
            {
              toolCalls,
              rationale: gmiChunk.metadata?.rationale || 'Agent requires tool execution.',
              executionMode,
              requiresExternalToolResult:
                typeof gmiChunk.metadata?.requiresExternalToolResult === 'boolean'
                  ? gmiChunk.metadata.requiresExternalToolResult
                  : executionMode === 'external',
              metadata: buildToolCallChunkMetadata(streamContext, gmiChunk.metadata),
            },
          );
        }
        break;
      case GMIOutputChunkType.UI_COMMAND:
        if (gmiChunk.content && Array.isArray(gmiChunk.content)) {
          await this.chunks.pushChunk(
            agentOSStreamId,
            AgentOSResponseChunkType.UI_COMMAND,
            gmiInstanceIdForChunks,
            personaId,
            gmiChunk.isFinal ?? false,
            { uiCommands: gmiChunk.content as UICommand[] },
          );
        }
        break;
      case GMIOutputChunkType.ERROR: {
        const errDetails = gmiChunk.errorDetails || { message: gmiChunk.content };
        await this.chunks.pushError(
          agentOSStreamId,
          personaId,
          gmiInstanceIdForChunks,
          errDetails.code || GMIErrorCode.GMI_PROCESSING_ERROR,
          errDetails.message || String(gmiChunk.content) || 'Unknown GMI processing error.',
          errDetails.details || errDetails,
        );
        if (gmiChunk.isFinal) {
          this.activeStreamContexts.delete(agentOSStreamId);
          await this.dependencies.streamingManager.closeStream(
            agentOSStreamId,
            `GMI stream error: ${errDetails.message || String(gmiChunk.content)}`,
          );
        }
        break;
      }
      case GMIOutputChunkType.FINAL_RESPONSE_MARKER:
        // Marker chunk emitted at end-of-stream. Do not surface to clients.
        // The real final response is the AsyncGenerator return value (GMIOutput).
        break;
      case GMIOutputChunkType.RAG_SOURCES_AVAILABLE: {
        const content = gmiChunk.content as
          | { ragSources?: import('../../cognition/rag/IRetrievalAugmentor.js').RagRetrievedChunk[] }
          | undefined;
        const ragSources = content?.ragSources;
        if (Array.isArray(ragSources) && ragSources.length > 0) {
          // Surface as METADATA_UPDATE so consumers (output guardrails, UI source
          // panels, telemetry) can pick up retrieved chunks before the model
          // emits text deltas. Grounding guardrails subscribe to this update to
          // verify subsequent claims against the same sources the LLM saw.
          await this.chunks.pushChunk(
            agentOSStreamId,
            AgentOSResponseChunkType.METADATA_UPDATE,
            gmiInstanceIdForChunks,
            personaId,
            false,
            { updates: { ragSources } },
          );
        }
        break;
      }
      case GMIOutputChunkType.USAGE_UPDATE:
        console.log(
          `AgentOSOrchestrator: UsageUpdate from GMI on stream ${agentOSStreamId}:`,
          gmiChunk.content,
        );
        break;
      default:
        console.warn(
          `AgentOSOrchestrator: Unhandled GMIOutputChunkType '${gmiChunk.type}' on stream ${agentOSStreamId}. Content:`,
          gmiChunk.content,
        );
    }
  }

  // ---------------------------------------------------------------------------
  // constructGMITurnInput — AgentOSInput → GMITurnInput
  // ---------------------------------------------------------------------------

  /**
   * Constructs a {@link GMITurnInput} from an {@link AgentOSInput} and the
   * active stream context. Performs interaction type detection (text, multimodal,
   * system message) and assembles all metadata required by the GMI.
   *
   * @param agentOSStreamId - The orchestrator stream ID.
   * @param input - The AgentOS-level input for this turn.
   * @param streamContext - Active stream context.
   * @returns The constructed GMI turn input.
   */
  constructGMITurnInput(
    agentOSStreamId: string,
    input: AgentOSInput,
    streamContext: TransformerStreamContext,
  ): GMITurnInput {
    const { userId, sessionId, options } = input;
    const { gmi } = streamContext;

    const gmiInputMetadata: Record<string, any> = {
      gmiId: gmi.getGMIId(),
      options: options,
      sessionId,
      conversationId: streamContext.conversationId,
      userApiKeys: input.userApiKeys,
      userFeedback: input.userFeedback,
      explicitPersonaSwitchId: input.selectedPersonaId,
      skillPromptContext: input.skillPromptContext,
      taskHint: input.textInput
        ? 'user_text_query'
        : input.visionInputs || input.audioInput
          ? 'user_multimodal_query'
          : 'general_query',
      modelSelectionOverrides: {
        preferredModelId: options?.preferredModelId,
        preferredProviderId: options?.preferredProviderId,
        temperature: options?.temperature,
        topP: options?.topP,
        maxTokens: options?.maxTokens,
      },
      personaStateOverrides: [],
    };

    let type: GMIInteractionType;
    let content: GMITurnInput['content'];

    if ((input.visionInputs && input.visionInputs.length > 0) || input.audioInput) {
      type = GMIInteractionType.MULTIMODAL_CONTENT;
      const multiModalContent: { text?: string | null; vision?: any[]; audio?: any } = {};
      if (input.textInput) multiModalContent.text = input.textInput;
      if (input.visionInputs) multiModalContent.vision = input.visionInputs;
      if (input.audioInput) multiModalContent.audio = input.audioInput;
      content = multiModalContent;
    } else if (input.textInput) {
      type = GMIInteractionType.TEXT;
      content = input.textInput;
    } else {
      type = GMIInteractionType.SYSTEM_MESSAGE;
      content = 'No primary user input provided for this turn.';
      console.warn(
        `AgentOSOrchestrator: No primary input in AgentOSInput for stream ${agentOSStreamId}. Sending as system message to GMI.`,
      );
    }

    return {
      interactionId: agentOSStreamId + `_turn_${uuidv4()}`,
      userId,
      sessionId,
      type,
      content,
      userContextOverride: input.userContextOverride,
      metadata: gmiInputMetadata,
      timestamp: new Date(),
    };
  }

  // ---------------------------------------------------------------------------
  // filterTurnPlanForDisabledSessionSkills
  // ---------------------------------------------------------------------------

  /**
   * Filters a turn plan's capability discovery results by removing any
   * capabilities that belong to skills disabled for this session.
   *
   * @param turnPlan - The turn plan to filter (may be null).
   * @param input - The AgentOS input containing disabled skill IDs.
   * @returns The filtered turn plan, or the original if no filtering was needed.
   */
  filterTurnPlanForDisabledSessionSkills(
    turnPlan: TurnPlan | null,
    input: AgentOSInput,
  ): TurnPlan | null {
    const disabledSessionSkillIds = Array.isArray(input.disabledSessionSkillIds)
      ? input.disabledSessionSkillIds.filter(
          (skillId): skillId is string => typeof skillId === 'string' && skillId.trim().length > 0,
        )
      : [];

    if (!turnPlan?.capability.result || disabledSessionSkillIds.length === 0) {
      return turnPlan;
    }

    const filteredResult = filterCapabilityDiscoveryResultByDisabledSkills(
      turnPlan.capability.result,
      disabledSessionSkillIds,
    );
    if (filteredResult === turnPlan.capability.result) {
      return turnPlan;
    }

    return {
      ...turnPlan,
      capability: {
        ...turnPlan.capability,
        result: filteredResult,
        promptContext: this.capabilityContextAssembler.renderForPrompt(filteredResult),
      },
    };
  }
}
