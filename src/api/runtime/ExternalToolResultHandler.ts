/**
 * @fileoverview Handles external tool result processing for the AgentOS orchestrator.
 *
 * This class encapsulates all logic related to receiving external tool results,
 * feeding them back into the GMI for continued processing, persisting pending
 * external tool requests, and managing the resume-from-persisted-state flow.
 *
 * Extracted from AgentOSOrchestrator to reduce its surface area and improve
 * testability of the external tool continuation path.
 *
 * @module backend/agentos/api/ExternalToolResultHandler
 */

import type { StreamId } from '../../core/streaming/StreamingManager';
import type { StreamChunkEmitter } from './StreamChunkEmitter';
import type { AgentOSOrchestratorDependencies } from '../types/OrchestratorConfig';
import type { AgentOSToolResultInput } from '../types/AgentOSToolResult';
import type {
  AgentOSPendingExternalToolRequest,
  AgentOSResumeExternalToolRequestOptions,
} from '../types/AgentOSExternalToolRequest';
import { AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY } from '../types/AgentOSExternalToolRequest';
import {
  AgentOSResponseChunkType,
} from '../types/AgentOSResponse';
import type { ConversationContext } from '../../core/conversation/ConversationContext';
import { MessageRole } from '../../core/conversation/ConversationMessage';
import type {
  IGMI,
  GMIOutput,
  ToolCallRequest,
  ToolResultPayload,
} from '../../cognition/substrate/IGMI';
import { GMIError, GMIErrorCode } from '../../core/utils/errors.js';
import { normalizeUsage, snapshotPersonaDetails } from '../../orchestration/turn-planner/helpers';
import {
  withAgentOSSpan,
  recordAgentOSToolResultMetrics,
  startAgentOSSpan,
  runWithSpanContext,
} from '../../safety/evaluation/observability/otel';
import { ORGANIZATION_ID_METADATA_KEY } from '../../core/conversation/LongTermMemoryPolicy';

/**
 * Internal state for managing an active stream of GMI interaction.
 * Mirrors the definition inside AgentOSOrchestrator so that the handler
 * can operate on the same map reference.
 */
export interface ActiveStreamContext {
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
 * Callback signature for processing GMI output after tool results.
 * The orchestrator or GMIChunkTransformer implements this and supplies
 * it during construction so this handler stays decoupled from those classes.
 */
export type ProcessGMIOutputCallback = (
  streamId: string,
  streamContext: ActiveStreamContext,
  gmiOutput: GMIOutput,
  isContinuation: boolean,
) => Promise<void>;

/** Builds metadata payload attached to TOOL_CALL_REQUEST chunks. */
function buildToolCallChunkMetadata(
  streamContext: ActiveStreamContext,
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
 * @class ExternalToolResultHandler
 * @description
 * Manages the full lifecycle of external tool result handling:
 *
 * 1. **orchestrateToolResult / orchestrateToolResults** - Receives one or more
 *    tool results, persists them to conversation history, feeds them into the
 *    GMI via `handleToolResult` / `handleToolResults`, and processes the
 *    resulting GMI output for further tool calls or final responses.
 *
 * 2. **_resumeToolResultsInternal** - Re-hydrates a stream context from a
 *    persisted `AgentOSPendingExternalToolRequest` after process restart and
 *    delegates to `orchestrateToolResults` for the actual processing.
 *
 * 3. **buildPendingExternalToolRequest / persistPendingExternalToolRequest /
 *    clearPendingExternalToolRequest** - Construct, persist, and clear the
 *    conversation-metadata snapshot that enables cross-restart recovery.
 *
 * All chunk emission is delegated to the shared {@link StreamChunkEmitter}.
 */
export class ExternalToolResultHandler {
  /**
   * Creates an ExternalToolResultHandler.
   *
   * @param activeStreamContexts - Shared mutable map of active stream contexts
   *   (same reference held by the orchestrator). This handler reads and writes
   *   entries to coordinate stream lifecycle with the orchestrator.
   * @param chunks - Delegate for assembling and emitting response chunks.
   * @param dependencies - Injected service dependencies (gmiManager,
   *   conversationManager, streamingManager, etc.).
   * @param enableConversationalPersistence - Whether to persist messages to
   *   the ConversationContext store.
   * @param processGMIOutput - Callback invoked to transform a GMIOutput into
   *   response chunks after tool result processing.
   * @param resolveOrganizationContext - Callback to resolve tenant org context.
   */
  constructor(
    private readonly activeStreamContexts: Map<string, ActiveStreamContext>,
    private readonly chunks: StreamChunkEmitter,
    private readonly dependencies: AgentOSOrchestratorDependencies,
    private readonly enableConversationalPersistence: boolean,
    private processGMIOutputCallback: ProcessGMIOutputCallback,
    private readonly resolveOrganizationContext: (inputOrganizationId: unknown) => string | undefined,
  ) {}

  /**
   * Replaces the processGMIOutput callback after construction.
   * Used when the GMIChunkTransformer is created after this handler and the
   * orchestrator needs to re-wire the callback.
   *
   * @param cb - The new callback.
   */
  setProcessGMIOutputCallback(cb: ProcessGMIOutputCallback): void {
    this.processGMIOutputCallback = cb;
  }

  // ---------------------------------------------------------------------------
  // orchestrateToolResult (single)
  // ---------------------------------------------------------------------------

  /**
   * Handles the result of a single external tool execution by delegating to
   * {@link orchestrateToolResults}.
   *
   * @param agentOSStreamId - The orchestrator stream ID.
   * @param toolCallId - ID of the tool call being responded to.
   * @param toolName - Name of the tool.
   * @param toolOutput - The output produced by the tool.
   * @param isSuccess - Whether the tool execution succeeded.
   * @param errorMessage - Optional error message if the tool failed.
   */
  async orchestrateToolResult(
    agentOSStreamId: StreamId,
    toolCallId: string,
    toolName: string,
    toolOutput: any,
    isSuccess: boolean,
    errorMessage?: string,
  ): Promise<void> {
    return this.orchestrateToolResults(agentOSStreamId, [
      { toolCallId, toolName, toolOutput, isSuccess, errorMessage },
    ]);
  }

  // ---------------------------------------------------------------------------
  // orchestrateToolResults (batch)
  // ---------------------------------------------------------------------------

  /**
   * Handles one or more external tool results, feeds them into the GMI, and
   * processes the resulting output. Manages persistence, error recovery, and
   * further tool-call chaining.
   *
   * @param agentOSStreamId - The orchestrator stream ID.
   * @param toolResults - Array of tool results to process.
   * @throws {GMIError} If the stream context is missing or processing fails.
   */
  async orchestrateToolResults(
    agentOSStreamId: StreamId,
    toolResults: AgentOSToolResultInput[],
  ): Promise<void> {
    const startedAt = Date.now();
    if (!Array.isArray(toolResults) || toolResults.length === 0) {
      throw new GMIError(
        'At least one tool result is required to continue the stream.',
        GMIErrorCode.VALIDATION_ERROR,
        { agentOSStreamId },
      );
    }

    const streamContext = this.activeStreamContexts.get(agentOSStreamId);
    if (!streamContext) {
      const errMsg = `Orchestrator: Received tool result for unknown or inactive streamId: ${agentOSStreamId}.`;
      console.error(errMsg);
      throw new GMIError(errMsg, GMIErrorCode.RESOURCE_NOT_FOUND, {
        agentOSStreamId,
        toolResults: toolResults.map((tr) => ({
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
        })),
      });
    }

    const { gmi, userId, personaId, conversationContext, userApiKeys } = streamContext;
    const gmiInstanceIdForChunks = gmi.getGMIId();
    const metricToolName =
      toolResults.length === 1 ? toolResults[0].toolName : '__batch_external_tools__';
    const metricToolSuccess = toolResults.every((tr) => tr.isSuccess);

    console.log(
      `AgentOSOrchestrator: Feeding ${toolResults.length} tool result(s) for stream ${agentOSStreamId}, GMI ${gmiInstanceIdForChunks} back to GMI.`,
    );

    try {
      await withAgentOSSpan('agentos.tool_result', async (span) => {
        span?.setAttribute('agentos.stream_id', agentOSStreamId);
        span?.setAttribute('agentos.gmi_id', gmiInstanceIdForChunks);
        span?.setAttribute('agentos.tool_result_count', toolResults.length);
        span?.setAttribute(
          'agentos.tool_call_ids',
          JSON.stringify(toolResults.map((tr) => tr.toolCallId)),
        );
        span?.setAttribute(
          'agentos.tool_names',
          JSON.stringify(toolResults.map((tr) => tr.toolName)),
        );
        span?.setAttribute('agentos.tool_success', metricToolSuccess);

        try {
          await this.clearPendingExternalToolRequest(conversationContext);

          // Emit TOOL_RESULT_EMISSION chunk and persist each result.
          for (const toolResult of toolResults) {
            await this.chunks.pushChunk(
              agentOSStreamId,
              AgentOSResponseChunkType.TOOL_RESULT_EMISSION,
              gmiInstanceIdForChunks,
              personaId,
              false,
              {
                toolCallId: toolResult.toolCallId,
                toolName: toolResult.toolName,
                toolResult: toolResult.toolOutput,
                isSuccess: toolResult.isSuccess,
                errorMessage: toolResult.errorMessage,
              },
            );

            if (this.enableConversationalPersistence && conversationContext) {
              conversationContext.addMessage({
                role: MessageRole.TOOL,
                content:
                  typeof toolResult.toolOutput === 'string'
                    ? toolResult.toolOutput
                    : JSON.stringify(toolResult.toolOutput),
                tool_call_id: toolResult.toolCallId,
                name: toolResult.toolName,
                metadata: {
                  agentPersonaId: personaId,
                  source: 'agentos_tool_result',
                  isSuccess: toolResult.isSuccess,
                },
              });
            }
          }

          // Persist tool result messages.
          if (this.enableConversationalPersistence && conversationContext) {
            try {
              await withAgentOSSpan('agentos.conversation.save', async (child) => {
                child?.setAttribute('agentos.stage', 'tool_result');
                child?.setAttribute('agentos.stream_id', agentOSStreamId);
                child?.setAttribute('agentos.tool_result_count', toolResults.length);
                await this.dependencies.conversationManager.saveConversation(conversationContext);
              });
            } catch (persistError: any) {
              console.warn(
                `AgentOSOrchestrator: Failed to persist tool results to ConversationContext for stream ${agentOSStreamId}.`,
                persistError,
              );
            }
          }

          // Feed tool results into the GMI.
          const gmiOutputAfterTool: GMIOutput = await withAgentOSSpan(
            'agentos.gmi.handle_tool_result',
            async (child) => {
              child?.setAttribute('agentos.stream_id', agentOSStreamId);
              child?.setAttribute('agentos.tool_result_count', toolResults.length);
              child?.setAttribute(
                'agentos.tool_call_ids',
                JSON.stringify(toolResults.map((tr) => tr.toolCallId)),
              );
              child?.setAttribute(
                'agentos.tool_names',
                JSON.stringify(toolResults.map((tr) => tr.toolName)),
              );
              child?.setAttribute('agentos.tool_success', metricToolSuccess);

              if (toolResults.length > 1) {
                if (!gmi.handleToolResults) {
                  throw new GMIError(
                    `GMI ${gmiInstanceIdForChunks} does not support batched external tool continuation.`,
                    GMIErrorCode.INVALID_STATE,
                    {
                      agentOSStreamId,
                      gmiInstanceId: gmiInstanceIdForChunks,
                      toolResults: toolResults.map((tr) => ({
                        toolCallId: tr.toolCallId,
                        toolName: tr.toolName,
                      })),
                    },
                  );
                }

                return gmi.handleToolResults(
                  toolResults.map((tr) => ({
                    toolCallId: tr.toolCallId,
                    toolName: tr.toolName,
                    output: tr.isSuccess
                      ? tr.toolOutput
                      : {
                          code: 'EXTERNAL_TOOL_ERROR',
                          message:
                            tr.errorMessage ||
                            `External tool '${tr.toolName}' execution failed.`,
                        },
                    isError: !tr.isSuccess,
                    errorDetails: tr.isSuccess
                      ? undefined
                      : {
                          code: 'EXTERNAL_TOOL_ERROR',
                          message:
                            tr.errorMessage ||
                            `External tool '${tr.toolName}' execution failed.`,
                        },
                  })),
                  userId,
                  userApiKeys || {},
                );
              }

              // Single tool result path.
              const [toolResult] = toolResults;
              const toolResultPayload: ToolResultPayload = toolResult.isSuccess
                ? { type: 'success', result: toolResult.toolOutput }
                : {
                    type: 'error',
                    error: {
                      code: 'EXTERNAL_TOOL_ERROR',
                      message:
                        toolResult.errorMessage ||
                        `External tool '${toolResult.toolName}' execution failed.`,
                    },
                  };

              return gmi.handleToolResult(
                toolResult.toolCallId,
                toolResult.toolName,
                toolResultPayload,
                userId,
                userApiKeys || {},
              );
            },
          );

          // Process the GMI output (text, ui commands, errors).
          await this.processGMIOutputCallback(agentOSStreamId, streamContext, gmiOutputAfterTool, false);

          // Handle further tool calls or finalization.
          if (gmiOutputAfterTool.toolCalls && gmiOutputAfterTool.toolCalls.length > 0) {
            await this.persistPendingExternalToolRequest(
              agentOSStreamId,
              streamContext,
              gmiInstanceIdForChunks,
              gmiOutputAfterTool.toolCalls,
              gmiOutputAfterTool.responseText || 'Agent requires further tool execution.',
            );
            await this.chunks.pushChunk(
              agentOSStreamId,
              AgentOSResponseChunkType.TOOL_CALL_REQUEST,
              gmiInstanceIdForChunks,
              personaId,
              false,
              {
                toolCalls: gmiOutputAfterTool.toolCalls,
                rationale:
                  gmiOutputAfterTool.responseText || 'Agent requires further tool execution.',
                executionMode: 'external',
                requiresExternalToolResult: true,
                metadata: buildToolCallChunkMetadata(streamContext),
              },
            );
          } else if (gmiOutputAfterTool.isFinal) {
            // Persist assistant output.
            if (this.enableConversationalPersistence && conversationContext) {
              try {
                if (
                  typeof gmiOutputAfterTool.responseText === 'string' &&
                  gmiOutputAfterTool.responseText.trim()
                ) {
                  conversationContext.addMessage({
                    role: MessageRole.ASSISTANT,
                    content: gmiOutputAfterTool.responseText,
                    metadata: { agentPersonaId: personaId, source: 'agentos_output' },
                  });
                } else if (
                  gmiOutputAfterTool.toolCalls &&
                  gmiOutputAfterTool.toolCalls.length > 0
                ) {
                  conversationContext.addMessage({
                    role: MessageRole.ASSISTANT,
                    content: null,
                    tool_calls: gmiOutputAfterTool.toolCalls as any,
                    metadata: { agentPersonaId: personaId, source: 'agentos_output_tool_calls' },
                  });
                }
                await withAgentOSSpan('agentos.conversation.save', async (child) => {
                  child?.setAttribute('agentos.stage', 'assistant_output_after_tool');
                  child?.setAttribute('agentos.stream_id', agentOSStreamId);
                  await this.dependencies.conversationManager.saveConversation(conversationContext);
                });
              } catch (persistError: any) {
                console.warn(
                  `AgentOSOrchestrator: Failed to persist assistant output after tool result for stream ${agentOSStreamId}.`,
                  persistError,
                );
              }
            }

            // Push final response and clean up.
            await this.chunks.pushChunk(
              agentOSStreamId,
              AgentOSResponseChunkType.FINAL_RESPONSE,
              gmiInstanceIdForChunks,
              personaId,
              true,
              {
                finalResponseText: gmiOutputAfterTool.responseText,
                finalToolCalls: gmiOutputAfterTool.toolCalls,
                finalUiCommands: gmiOutputAfterTool.uiCommands,
                audioOutput: gmiOutputAfterTool.audioOutput,
                imageOutput: gmiOutputAfterTool.imageOutput,
                usage: normalizeUsage(gmiOutputAfterTool.usage),
                reasoningTrace: gmiOutputAfterTool.reasoningTrace,
                error: gmiOutputAfterTool.error,
                updatedConversationContext: conversationContext.toJSON(),
                activePersonaDetails: snapshotPersonaDetails(gmi.getPersona?.()),
              },
            );
            this.activeStreamContexts.delete(agentOSStreamId);
            await this.dependencies.streamingManager.closeStream(
              agentOSStreamId,
              'Tool processing complete and final response generated.',
            );
          }
          // If not final and no tool calls, the stream remains open for further
          // GMI internal processing or new user input.
        } catch (error: any) {
          const gmiErr =
            GMIError.wrap?.(
              error,
              GMIErrorCode.TOOL_ERROR,
              `Error in orchestrateToolResult for stream ${agentOSStreamId}`,
            ) ||
            new GMIError(
              `Error in orchestrateToolResult for stream ${agentOSStreamId}: ${error.message}`,
              GMIErrorCode.TOOL_ERROR,
              error,
            );
          console.error(
            `AgentOSOrchestrator: Critical error processing tool result for stream ${agentOSStreamId}:`,
            gmiErr,
          );
          await this.clearPendingExternalToolRequest(conversationContext);
          await this.chunks.pushError(
            agentOSStreamId,
            personaId,
            gmiInstanceIdForChunks,
            gmiErr.code,
            gmiErr.message,
            gmiErr.details,
          );
          this.activeStreamContexts.delete(agentOSStreamId);
          await this.dependencies.streamingManager.closeStream(
            agentOSStreamId,
            'Critical error during tool result processing.',
          );
          throw gmiErr;
        }
      });

      recordAgentOSToolResultMetrics({
        durationMs: Date.now() - startedAt,
        status: 'ok',
        toolName: metricToolName,
        toolSuccess: metricToolSuccess,
      });
    } catch (error) {
      recordAgentOSToolResultMetrics({
        durationMs: Date.now() - startedAt,
        status: 'error',
        toolName: metricToolName,
        toolSuccess: metricToolSuccess,
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Resume from persisted state
  // ---------------------------------------------------------------------------

  /**
   * Resumes an external tool request from persisted conversation metadata.
   * Re-creates the stream context and delegates to {@link orchestrateToolResults}.
   *
   * @param agentOSStreamId - Fresh stream ID allocated by the orchestrator.
   * @param pendingRequest - The persisted pending request snapshot.
   * @param toolResults - Tool results to feed back.
   * @param options - Runtime-only options for resumption (API keys, model prefs).
   */
  async resumeToolResultsInternal(
    agentOSStreamId: StreamId,
    pendingRequest: AgentOSPendingExternalToolRequest,
    toolResults: AgentOSToolResultInput[],
    options: AgentOSResumeExternalToolRequestOptions,
  ): Promise<void> {
    if (!Array.isArray(toolResults) || toolResults.length === 0) {
      throw new GMIError(
        'At least one tool result is required to resume an external tool request.',
        GMIErrorCode.VALIDATION_ERROR,
        { agentOSStreamId, conversationId: pendingRequest.conversationId },
      );
    }

    const gmiResult = await withAgentOSSpan('agentos.gmi.resume_get_or_create', async (span) => {
      span?.setAttribute('agentos.user_id', pendingRequest.userId);
      span?.setAttribute('agentos.session_id', pendingRequest.sessionId);
      span?.setAttribute('agentos.conversation_id', pendingRequest.conversationId);
      span?.setAttribute('agentos.persona_id', pendingRequest.personaId);
      return this.dependencies.gmiManager.getOrCreateGMIForSession(
        pendingRequest.userId,
        pendingRequest.sessionId,
        pendingRequest.personaId,
        pendingRequest.conversationId,
        options.preferredModelId,
        options.preferredProviderId,
        options.userApiKeys,
      );
    });

    const gmi = gmiResult.gmi;
    const conversationContext = gmiResult.conversationContext;
    const currentPersonaId = gmi.getCurrentPrimaryPersonaId();
    const gmiInstanceIdForChunks = gmi.getGMIId();
    const storedOrganizationId = conversationContext.getMetadata(ORGANIZATION_ID_METADATA_KEY);
    const resolvedOrganizationId = this.resolveOrganizationContext(
      options.organizationId ?? storedOrganizationId,
    );

    const streamContext: ActiveStreamContext = {
      gmi,
      userId: pendingRequest.userId,
      sessionId: pendingRequest.sessionId,
      personaId: currentPersonaId,
      conversationId: conversationContext.sessionId,
      organizationId: resolvedOrganizationId,
      conversationContext,
      userApiKeys: options.userApiKeys,
      processingOptions: {
        preferredModelId: options.preferredModelId,
        preferredProviderId: options.preferredProviderId,
      },
    };
    this.activeStreamContexts.set(agentOSStreamId, streamContext);

    if (gmi.hydrateConversationHistory) {
      gmi.hydrateConversationHistory(
        conversationContext.getHistory(undefined, [MessageRole.ERROR, MessageRole.THOUGHT]) as any,
      );
    }
    if (gmi.hydrateTurnContext) {
      gmi.hydrateTurnContext({
        sessionId: pendingRequest.sessionId,
        conversationId: conversationContext.sessionId,
        organizationId: resolvedOrganizationId,
      });
    }

    await this.chunks.pushChunk(
      agentOSStreamId,
      AgentOSResponseChunkType.SYSTEM_PROGRESS,
      gmiInstanceIdForChunks,
      currentPersonaId,
      false,
      {
        message: `Resuming external tool request for conversation ${conversationContext.sessionId}...`,
        progressPercentage: 10,
      },
    );

    await this.orchestrateToolResults(agentOSStreamId, toolResults);
  }

  // ---------------------------------------------------------------------------
  // Pending external tool request management
  // ---------------------------------------------------------------------------

  /**
   * Constructs a pending external tool request snapshot without persisting it.
   *
   * @param agentOSStreamId - Current stream ID.
   * @param streamContext - Active stream context.
   * @param gmiInstanceId - GMI instance identifier.
   * @param toolCalls - Tool calls that require external execution.
   * @param rationale - Optional rationale text from the agent.
   * @returns The constructed pending request object.
   */
  buildPendingExternalToolRequest(
    agentOSStreamId: string,
    streamContext: ActiveStreamContext,
    gmiInstanceId: string,
    toolCalls: ToolCallRequest[],
    rationale?: string,
  ): AgentOSPendingExternalToolRequest {
    return {
      streamId: agentOSStreamId,
      sessionId: streamContext.sessionId,
      conversationId: streamContext.conversationId,
      userId: streamContext.userId,
      personaId: streamContext.personaId,
      gmiInstanceId,
      toolCalls,
      rationale,
      requestedAt: new Date().toISOString(),
    };
  }

  /**
   * Persists a pending external tool request into conversation metadata so it
   * can survive process restarts.
   *
   * @param agentOSStreamId - Current stream ID.
   * @param streamContext - Active stream context.
   * @param gmiInstanceId - GMI instance identifier.
   * @param toolCalls - Tool calls that require external execution.
   * @param rationale - Optional rationale text from the agent.
   * @returns The persisted pending request object.
   */
  async persistPendingExternalToolRequest(
    agentOSStreamId: string,
    streamContext: ActiveStreamContext,
    gmiInstanceId: string,
    toolCalls: ToolCallRequest[],
    rationale?: string,
  ): Promise<AgentOSPendingExternalToolRequest> {
    const { conversationContext, personaId } = streamContext;
    const pendingRequest = this.buildPendingExternalToolRequest(
      agentOSStreamId,
      streamContext,
      gmiInstanceId,
      toolCalls,
      rationale,
    );

    if (toolCalls.length > 0) {
      conversationContext.addMessage({
        role: MessageRole.ASSISTANT,
        content: null,
        tool_calls: toolCalls as any,
        metadata: { agentPersonaId: personaId, source: 'agentos_output_tool_calls' },
      });
    }
    conversationContext.setMetadata(
      AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY,
      pendingRequest,
    );

    if (this.enableConversationalPersistence) {
      await withAgentOSSpan('agentos.conversation.save', async (span) => {
        span?.setAttribute('agentos.stage', 'pending_external_tool_request');
        span?.setAttribute('agentos.stream_id', agentOSStreamId);
        await this.dependencies.conversationManager.saveConversation(conversationContext);
      });
    }

    return pendingRequest;
  }

  /**
   * Clears a previously persisted pending external tool request from
   * conversation metadata.
   *
   * @param conversationContext - The conversation context to clear, or
   *   `undefined` if no context is available (no-op).
   */
  async clearPendingExternalToolRequest(
    conversationContext: ConversationContext | undefined,
  ): Promise<void> {
    if (!conversationContext) {
      return;
    }
    if (
      conversationContext.getMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY) ===
      undefined
    ) {
      return;
    }

    conversationContext.setMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY, undefined);

    if (this.enableConversationalPersistence) {
      await withAgentOSSpan('agentos.conversation.save', async (span) => {
        span?.setAttribute('agentos.stage', 'clear_pending_external_tool_request');
        await this.dependencies.conversationManager.saveConversation(conversationContext);
      });
    }
  }
}
