/**
 * @fileoverview The gate a GMI asks before each call of its own tool round, on one stream: the output guardrails'
 * tool-call gate over TOOL_CALL_REQUEST chunks of the calls the runtime runs itself.
 * @module backend/agentos/api/runtime/toolCallGate
 */

import type { GMIToolCallGate, GMIToolCallRefusal, ToolCallRequest } from '../../cognition/substrate/IGMI';
import type { GuardrailToolCallGate } from '../../safety/guardrails/guardrailDispatcher';
import type { GuardrailEvaluationResult } from '../../safety/guardrails/IGuardrailService';
import { AgentOSResponseChunkType, type AgentOSToolCallRequestChunk } from '../types/AgentOSResponse';

/** The stream a turn runs on, read when a call is judged. */
export interface ToolCallGateStream {
  personaId: string;
  sessionId: string;
  conversationId: string;
  organizationId?: string;
}

/** The sources a judged chunk is read beside. */
type GateSources = Parameters<GuardrailToolCallGate>[1];

/** Where `call` stands in its step: the same call, or else the call with its id; -1 when the step does not hold it. */
function positionInStep(stepCalls: readonly ToolCallRequest[], call: ToolCallRequest): number {
  const position = stepCalls.indexOf(call);
  return position >= 0 ? position : stepCalls.findIndex((stepCall) => stepCall.id === call.id);
}

/** The guardrails' verdicts on one model step's calls: each call alone, then the calls that pass alone together. */
interface StepVerdicts {
  /** Each call's verdict alone, by its position in the step. */
  alone: PromiseSettledResult<GuardrailEvaluationResult | null>[];
  /** The positions of the calls judged together: the calls that pass alone, when two or more do. */
  together: Set<number>;
  /** The verdict on the calls judged together, when there were two or more. */
  togetherVerdict?: PromiseSettledResult<GuardrailEvaluationResult | null>;
}

/**
 * The GMI's tool-call gate on one stream. Each call is judged as a TOOL_CALL_REQUEST chunk of a call the runtime runs
 * itself holding that one call, with the sources the turn retrieved (`context.ragSources`). When the GMI names the
 * step's calls (`context.stepCalls`), every call of the step is judged alone, and the calls that pass alone, when two
 * or more do, are judged once more together, as the stream's chunk for the step holds them: a guardrail that rules on
 * calls together sees them before any of them runs, and a block there refuses each of them. The step is judged once,
 * however many of its calls the GMI asks about. A blocking evaluation becomes the refusal, with the guardrail's
 * reason, reason code and id; a judgement that throws refuses the calls it was about, as the GMI refuses a call whose
 * gate throws.
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
  const judge = (toolCalls: readonly ToolCallRequest[], ragSources: GateSources): Promise<GuardrailEvaluationResult | null> => {
    const chunk: AgentOSToolCallRequestChunk = {
      type: AgentOSResponseChunkType.TOOL_CALL_REQUEST,
      streamId,
      gmiInstanceId,
      personaId: stream.personaId,
      isFinal: false,
      timestamp: new Date().toISOString(),
      toolCalls: [...toolCalls],
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
    return gate(chunk, ragSources);
  };
  const judgeStep = async (stepCalls: readonly ToolCallRequest[], ragSources: GateSources): Promise<StepVerdicts> => {
    const alone = await Promise.allSettled(stepCalls.map((call) => judge([call], ragSources)));
    const together = new Set<number>();
    alone.forEach((verdict, position) => {
      if (verdict.status === 'fulfilled' && !verdict.value) together.add(position);
    });
    if (together.size < 2) {
      return { alone, together: new Set() };
    }
    const [togetherVerdict] = await Promise.allSettled([judge(stepCalls.filter((_call, position) => together.has(position)), ragSources)]);
    return { alone, together, togetherVerdict };
  };
  // the verdicts on each step the GMI asked about, by the step's array of calls, so a step is judged once
  const steps = new WeakMap<readonly ToolCallRequest[], Promise<StepVerdicts>>();

  return async (call, context): Promise<GMIToolCallRefusal | null> => {
    const ragSources = context?.ragSources && context.ragSources.length > 0 ? context.ragSources : undefined;
    const stepCalls = context?.stepCalls;
    const position = stepCalls ? positionInStep(stepCalls, call) : -1;
    let evaluation: GuardrailEvaluationResult | null;
    if (stepCalls && position >= 0) {
      let verdicts = steps.get(stepCalls);
      if (!verdicts) {
        verdicts = judgeStep(stepCalls, ragSources);
        steps.set(stepCalls, verdicts);
      }
      const step = await verdicts;
      const alone = step.alone[position]!;
      if (alone.status === 'rejected') throw alone.reason;
      evaluation = alone.value;
      if (!evaluation && step.together.has(position) && step.togetherVerdict) {
        if (step.togetherVerdict.status === 'rejected') throw step.togetherVerdict.reason;
        evaluation = step.togetherVerdict.value;
      }
    } else {
      evaluation = await judge([call], ragSources);
    }
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
