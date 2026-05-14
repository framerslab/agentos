/**
 * @fileoverview Stream chunk assembly and emission delegate.
 * Extracted from AgentOSOrchestrator for focused chunk construction logic.
 */

import type { StreamId, StreamingManager } from '../../core/streaming/StreamingManager';
import {
  type AgentOSResponse,
  AgentOSResponseChunkType,
  type AgentOSTextDeltaChunk,
  type AgentOSFinalResponseChunk,
  type AgentOSErrorChunk,
  type AgentOSSystemProgressChunk,
  type AgentOSToolCallRequestChunk,
  type AgentOSToolResultEmissionChunk,
  type AgentOSUICommandChunk,
  type AgentOSMetadataUpdateChunk,
  type AgentOSWorkflowUpdateChunk,
} from '../types/AgentOSResponse';
import { GMIErrorCode } from '@framers/agentos/core/utils/errors';
import { normalizeUsage } from '../../orchestration/turn-planner/helpers';
import {
  getActiveTraceMetadata,
  shouldIncludeTraceInAgentOSResponses,
} from '../../safety/evaluation/observability/otel';

type TurnExecutionLifecyclePhase =
  | 'planned'
  | 'executing'
  | 'degraded'
  | 'recovered'
  | 'completed'
  | 'errored';

interface StreamContext {
  languageNegotiation?: any;
}

/**
 * Assembles and emits AgentOS response chunks via a StreamingManager.
 * Takes a reference to the active stream contexts map for language negotiation metadata.
 */
export class StreamChunkEmitter {
  constructor(
    private readonly streamingManager: StreamingManager,
    private readonly activeStreamContexts: Map<string, StreamContext>,
  ) {}

  async pushChunk(
    streamId: StreamId,
    type: AgentOSResponseChunkType,
    gmiInstanceId: string,
    personaId: string,
    isFinal: boolean,
    data: any,
  ): Promise<void> {
    const baseChunk: Record<string, any> = {
      type,
      streamId,
      gmiInstanceId,
      personaId,
      isFinal,
      timestamp: new Date().toISOString(),
    };

    if (data && typeof data === 'object' && 'metadata' in data && data.metadata) {
      baseChunk.metadata = data.metadata;
    }
    const ctx = this.activeStreamContexts.get(streamId);
    if (ctx?.languageNegotiation) {
      baseChunk.metadata = baseChunk.metadata || {};
      if (!baseChunk.metadata.language) baseChunk.metadata.language = ctx.languageNegotiation;
    }

    if (
      shouldIncludeTraceInAgentOSResponses() &&
      (type === AgentOSResponseChunkType.METADATA_UPDATE ||
        type === AgentOSResponseChunkType.FINAL_RESPONSE ||
        type === AgentOSResponseChunkType.ERROR)
    ) {
      const traceMeta = getActiveTraceMetadata();
      if (traceMeta) {
        baseChunk.metadata = baseChunk.metadata || {};
        baseChunk.metadata.trace = traceMeta;
      }
    }

    let chunk: AgentOSResponse;

    switch (type) {
      case AgentOSResponseChunkType.TEXT_DELTA:
        chunk = { ...baseChunk, textDelta: data.textDelta } as AgentOSTextDeltaChunk;
        break;
      case AgentOSResponseChunkType.SYSTEM_PROGRESS:
        chunk = {
          ...baseChunk,
          message: data.message,
          progressPercentage: data.progressPercentage,
          statusCode: data.statusCode,
        } as AgentOSSystemProgressChunk;
        break;
      case AgentOSResponseChunkType.TOOL_CALL_REQUEST:
        chunk = {
          ...baseChunk,
          toolCalls: data.toolCalls,
          rationale: data.rationale,
          executionMode: data.executionMode,
          requiresExternalToolResult: data.requiresExternalToolResult,
        } as AgentOSToolCallRequestChunk;
        break;
      case AgentOSResponseChunkType.TOOL_RESULT_EMISSION:
        chunk = {
          ...baseChunk,
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          toolResult: data.toolResult,
          isSuccess: data.isSuccess,
          errorMessage: data.errorMessage,
        } as AgentOSToolResultEmissionChunk;
        break;
      case AgentOSResponseChunkType.UI_COMMAND:
        chunk = { ...baseChunk, uiCommands: data.uiCommands } as AgentOSUICommandChunk;
        break;
      case AgentOSResponseChunkType.ERROR:
        chunk = {
          ...baseChunk,
          code: data.code,
          message: data.message,
          details: data.details,
        } as AgentOSErrorChunk;
        break;
      case AgentOSResponseChunkType.FINAL_RESPONSE:
        chunk = {
          ...baseChunk,
          finalResponseText: data.finalResponseText,
          finalToolCalls: data.finalToolCalls,
          finalUiCommands: data.finalUiCommands,
          audioOutput: data.audioOutput,
          imageOutput: data.imageOutput,
          usage: normalizeUsage(data.usage),
          reasoningTrace: data.reasoningTrace,
          error: data.error,
          updatedConversationContext: data.updatedConversationContext,
          activePersonaDetails: data.activePersonaDetails,
          ragSources: data.ragSources,
        } as AgentOSFinalResponseChunk;
        break;
      case AgentOSResponseChunkType.WORKFLOW_UPDATE:
        chunk = { ...baseChunk, workflow: data.workflow } as AgentOSWorkflowUpdateChunk;
        break;
      case AgentOSResponseChunkType.METADATA_UPDATE:
        chunk = { ...baseChunk, updates: data.updates } as AgentOSMetadataUpdateChunk;
        break;
      default:
        console.error(`StreamChunkEmitter: Unknown chunk type: ${type}`);
        chunk = {
          ...baseChunk,
          type: AgentOSResponseChunkType.ERROR,
          code: GMIErrorCode.INTERNAL_SERVER_ERROR,
          message: `Unknown chunk type: ${type}`,
          details: data,
        } as AgentOSErrorChunk;
    }

    try {
      await this.streamingManager.pushChunk(streamId, chunk);
    } catch (pushError: any) {
      console.error(
        `StreamChunkEmitter: Failed to push chunk to stream ${streamId}. Type: ${type}. Error: ${pushError?.message}`,
        pushError,
      );
    }
  }

  async pushError(
    streamId: StreamId,
    personaId: string,
    gmiInstanceId: string = 'unknown_gmi_instance',
    code: GMIErrorCode | string,
    message: string,
    details?: any,
  ): Promise<void> {
    await this.pushChunk(
      streamId,
      AgentOSResponseChunkType.ERROR,
      gmiInstanceId,
      personaId,
      true,
      { code: code.toString(), message, details },
    );
  }

  async emitLifecycleUpdate(args: {
    streamId: StreamId;
    gmiInstanceId: string;
    personaId: string;
    phase: TurnExecutionLifecyclePhase;
    status: 'ok' | 'degraded' | 'error';
    details?: Record<string, unknown>;
  }): Promise<void> {
    await this.pushChunk(
      args.streamId,
      AgentOSResponseChunkType.METADATA_UPDATE,
      args.gmiInstanceId,
      args.personaId,
      false,
      {
        updates: {
          executionLifecycle: {
            phase: args.phase,
            status: args.status,
            timestamp: new Date().toISOString(),
            ...(args.details ? { details: args.details } : null),
          },
        },
      },
    );
  }
}
