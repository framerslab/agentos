/**
 * @fileoverview The gate a GMI asks before each call of its own tool round, on one stream: the output guardrails'
 * tool-call gate over the chunk the stream carries for that call.
 * @module backend/agentos/api/runtime/toolCallGate
 */

import type { GMIToolCallGate } from '../../cognition/substrate/IGMI';
import type { GuardrailToolCallGate } from '../../safety/guardrails/guardrailDispatcher';
import { AgentOSResponseChunkType, type AgentOSToolCallRequestChunk } from '../types/AgentOSResponse';

/** The stream a turn runs on, read when a call is judged. */
export interface ToolCallGateStream {
  personaId: string;
  sessionId: string;
  conversationId: string;
  organizationId?: string;
}

/**
 * The GMI's tool-call gate on one stream. Each call is judged as the TOOL_CALL_REQUEST chunk the stream carries for a
 * call the runtime runs itself, holding that one call; a blocking evaluation becomes the refusal, with the guardrail's
 * reason, reason code and id.
 *
 * @param gate - The output guardrails' tool-call gate, or undefined when no guardrail evaluates tool calls.
 * @param streamId - The stream the turn runs on.
 * @param gmiInstanceId - The GMI instance the stream's chunks name.
 * @param stream - The stream's context.
 * @returns The gate for the GMI, or undefined without a guardrail gate.
 */
export function gmiToolCallGateFor(
  gate: GuardrailToolCallGate | undefined,
  streamId: string,
  gmiInstanceId: string,
  stream: ToolCallGateStream,
): GMIToolCallGate | undefined {
  if (!gate) {
    return undefined;
  }
  return async (call) => {
    const chunk: AgentOSToolCallRequestChunk = {
      type: AgentOSResponseChunkType.TOOL_CALL_REQUEST,
      streamId,
      gmiInstanceId,
      personaId: stream.personaId,
      isFinal: false,
      timestamp: new Date().toISOString(),
      toolCalls: [call],
      rationale: 'Agent requires tool execution.',
      executionMode: 'internal',
      requiresExternalToolResult: false,
      metadata: {
        sessionId: stream.sessionId,
        conversationId: stream.conversationId,
        executionMode: 'internal',
        requiresExternalToolResult: false,
        ...(stream.organizationId ? { organizationId: stream.organizationId } : {}),
      },
    };
    const evaluation = await gate(chunk);
    if (!evaluation) {
      return null;
    }
    const guardrailId = evaluation.metadata?.guardrailId;
    return {
      reason: evaluation.reason || `An output guardrail refused the call to '${call.name}'.`,
      ...(evaluation.reasonCode ? { reasonCode: evaluation.reasonCode } : {}),
      ...(typeof guardrailId === 'string' ? { guardrailId } : {}),
    };
  };
}
