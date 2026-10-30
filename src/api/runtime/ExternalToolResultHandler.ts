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
import { MessageRole, createConversationMessage } from '../../core/conversation/ConversationMessage';
import type { ConversationMessage } from '../../core/conversation/ConversationMessage';
import type {
  IGMI,
  GMIOutput,
  GMIToolCallRefusal,
  GMIToolResultOptions,
  ToolCallRequest,
  ToolResultPayload,
} from '../../cognition/substrate/IGMI';
import { GMIPrimeState } from '../../cognition/substrate/IGMI';
import type { RagRetrievedChunk } from '../../cognition/rag/IRetrievalAugmentor';
import { refusedToolCallResult } from '../../cognition/substrate/toolCallGate';
import type { GuardrailToolCallGate } from '../../safety/guardrails/guardrailDispatcher';
import { gmiToolCallGateFor } from './toolCallGate';
import { externalToolPauseCalls } from './externalToolPause';
import { addReplyToConversation, finalResponseFieldsOf } from './turnFinalResponse';
import { GMIError, GMIErrorCode } from '../../core/utils/errors.js';
import { snapshotPersonaDetails } from '../../orchestration/turn-planner/helpers';
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
  /**
   * The sources the stream's turn retrieved, as the stream announced them (`METADATA_UPDATE.updates.ragSources`);
   * unset while it announced none. A continuation of the turn gives them to a GMI that does not hold them.
   */
  ragSources?: RagRetrievedChunk[];
  /**
   * The GMI's own history of the paused turn's conversation, read when the turn (or a continuation) stopped for the
   * host on a GMI whose history held that conversation alone, with the pause's calls; unset otherwise. It holds what
   * the conversation store does not: the calls the GMI ran itself in the turn, their results and the thinking blocks
   * of its assistant turns. A continuation sets it on a GMI that does not hold the paused turn
   * ({@link ExternalToolResultHandler.setPausedTurnOn}).
   */
  pausedTurnHistory?: ConversationMessage[];
}

/**
 * Marks a GMI whose own history holds turns of more than one conversation since this runtime last set it.
 */
const SEVERAL_CONVERSATIONS = Symbol('several conversations');

/**
 * `history` ending with an assistant message that names each call of the pause the history does not name. A GMI
 * whose turn a host's own tool layer stopped never recorded the calls the host runs (the shipped GMI runs every call
 * of its tool rounds itself), and a provider takes a tool result only after the assistant message that made its call.
 */
function withPauseCalls(history: ConversationMessage[], pauseCalls: ToolCallRequest[]): ConversationMessage[] {
  const named = new Set(
    history.flatMap((message) =>
      message.role === MessageRole.ASSISTANT && Array.isArray(message.tool_calls)
        ? message.tool_calls.map((call) => call.id)
        : [],
    ),
  );
  const missing = pauseCalls.filter((call) => !named.has(call.id));
  return missing.length === 0
    ? history
    : [...history, createConversationMessage(MessageRole.ASSISTANT, null, { tool_calls: missing })];
}

/** Whether `gmi` was shut down or is shutting down, so it continues nothing. */
function isShutDown(gmi: IGMI): boolean {
  const state = typeof gmi.getCurrentState === 'function' ? gmi.getCurrentState() : undefined;
  return state === GMIPrimeState.SHUTTING_DOWN || state === GMIPrimeState.SHUTDOWN;
}

/** The history a conversation holds, as a turn's prompt reads it: every message but errors and thoughts. */
function storedHistoryOf(conversationContext: ConversationContext) {
  return conversationContext.getHistory(undefined, [MessageRole.ERROR, MessageRole.THOUGHT]);
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
 * Whether `held`, the pending request a conversation holds, is the pause `given` names: the one its stream saved for
 * the same calls. A snapshot read before its pause was answered, dropped or replaced names none the conversation holds.
 */
function isHeldPendingRequest(
  held: AgentOSPendingExternalToolRequest | undefined,
  given: AgentOSPendingExternalToolRequest,
): boolean {
  if (!held || held.streamId !== given.streamId || !Array.isArray(held.toolCalls) || !Array.isArray(given.toolCalls)) {
    return false;
  }
  return (
    held.toolCalls.length > 0 &&
    held.toolCalls.length === given.toolCalls.length &&
    held.toolCalls.every((call, index) => call.id === given.toolCalls[index]?.id)
  );
}

/** The key a resume takes a pause under: the pause's conversation and the stream that saved it. */
function pauseKeyOf(pendingRequest: AgentOSPendingExternalToolRequest): string {
  return `${pendingRequest.conversationId}\u0000${pendingRequest.streamId}`;
}

/**
 * Whether each of `toolResults` answers a call of `pendingRequest`, a pause that holds at least one call: the results a
 * pause waits on, on its stream and on a resume alike.
 */
function answersCallsOf(
  pendingRequest: AgentOSPendingExternalToolRequest,
  toolResults: readonly AgentOSToolResultInput[],
): boolean {
  const calls = Array.isArray(pendingRequest.toolCalls) ? pendingRequest.toolCalls : [];
  const callIds = new Set(calls.map((call) => call.id));
  return callIds.size > 0 && toolResults.every((tr) => callIds.has(tr.toolCallId));
}

/** The message that records `toolResult` in the conversation. It throws for an output that has no JSON form. */
function toolResultMessage(
  toolResult: AgentOSToolResultInput,
  personaId: string | undefined,
): Parameters<ConversationContext['addMessage']>[0] {
  return {
    role: MessageRole.TOOL,
    content: typeof toolResult.toolOutput === 'string' ? toolResult.toolOutput : JSON.stringify(toolResult.toolOutput),
    tool_call_id: toolResult.toolCallId,
    name: toolResult.toolName,
    metadata: {
      agentPersonaId: personaId,
      source: 'agentos_tool_result',
      isSuccess: toolResult.isSuccess,
    },
  };
}

/** The message of the error that refuses a resume of `pendingRequest`. */
function staleResumeMessage(pendingRequest: AgentOSPendingExternalToolRequest): string {
  return (
    `The conversation '${pendingRequest.conversationId}' no longer holds the pending tool request of stream ` +
    `'${pendingRequest.streamId}': it was answered, dropped, replaced or is being resumed already, so it is not resumed.`
  );
}

/** The details of the error that refuses a resume of `pendingRequest`. */
function staleResumeDetails(pendingRequest: AgentOSPendingExternalToolRequest): Record<string, unknown> {
  return {
    conversationId: pendingRequest.conversationId,
    streamId: pendingRequest.streamId,
    toolCallIds: Array.isArray(pendingRequest.toolCalls) ? pendingRequest.toolCalls.map((call) => call.id) : [],
  };
}

/** The code of the tool result that answers a call of a pause that never got its result. */
export const EXTERNAL_TOOL_NOT_RUN_CODE = 'EXTERNAL_TOOL_NOT_RUN';

/** Records, for each of `calls`, a tool result that says why the call has no result, worded as the GMI words a failed result. */
function answerAsNotRun(
  conversationContext: ConversationContext,
  calls: readonly ToolCallRequest[],
  personaId: string | undefined,
  why: (call: ToolCallRequest) => string,
): void {
  for (const call of calls) {
    const notRun = { code: EXTERNAL_TOOL_NOT_RUN_CODE, message: why(call) };
    conversationContext.addMessage({
      role: MessageRole.TOOL,
      content: `Error from tool '${call.name}': ${JSON.stringify(notRun)}`,
      tool_call_id: call.id,
      name: call.name,
      metadata: {
        agentPersonaId: personaId,
        source: 'agentos_tool_call_not_run',
        isSuccess: false,
      },
    });
  }
}

/**
 * The calls of `pendingRequest` that no tool message answers after the assistant message the pause recorded for them,
 * or none when the conversation holds no such message (a conversation the runtime does not record, or one whose
 * history no longer reaches the pause).
 */
function unansweredPauseCalls(
  conversationContext: ConversationContext,
  pendingRequest: AgentOSPendingExternalToolRequest,
): ToolCallRequest[] {
  const pauseCalls = Array.isArray(pendingRequest.toolCalls) ? pendingRequest.toolCalls : [];
  if (pauseCalls.length === 0) {
    return [];
  }
  const messages = conversationContext.getAllMessages();
  let pauseAt = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const declared = Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => call?.id) : [];
    if (message.role === MessageRole.ASSISTANT && pauseCalls.every((call) => declared.includes(call.id))) {
      pauseAt = index;
      break;
    }
  }
  if (pauseAt < 0) {
    return [];
  }
  const answered = new Set(
    messages
      .slice(pauseAt + 1)
      .filter((message) => message.role === MessageRole.TOOL && typeof message.tool_call_id === 'string')
      .map((message) => message.tool_call_id as string),
  );
  return pauseCalls.filter((call) => !answered.has(call.id));
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
 * 2. **resumeToolResultsInternal** - Re-hydrates a stream context from a
 *    persisted `AgentOSPendingExternalToolRequest` after process restart and
 *    continues the GMI with the results on a new stream, as the paused
 *    stream's own continuation does.
 *
 * 3. **buildPendingExternalToolRequest / persistPendingExternalToolRequest /
 *    clearPendingExternalToolRequest** - Construct, persist, and clear the
 *    conversation-metadata snapshot that enables cross-restart recovery.
 *
 * All chunk emission is delegated to the shared {@link StreamChunkEmitter}.
 */
export class ExternalToolResultHandler {
  /** The pauses being resumed, by conversation and stream, until their resumes end. */
  private readonly resumingPauses = new Set<string>();

  /**
   * The streams an output guardrail blocked whose pause is being dropped, with the number of drops under way for each.
   * From the verdict until the drop ends, the pause such a stream saves is neither offered, resumed nor continued.
   */
  private readonly blockedStreams = new Map<string, number>();

  /**
   * The conversation each GMI's own history holds, as far as this runtime ran turns on the GMI: the one conversation
   * whose turns it recorded since this runtime last set its history, or SEVERAL_CONVERSATIONS. A session's GMI serves
   * every conversation of the session and records each turn in its own history, so a continuation reads that history
   * only while it holds the continuation's conversation alone.
   */
  private readonly gmiHistoryOwners = new WeakMap<IGMI, string | typeof SEVERAL_CONVERSATIONS>();

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

  /**
   * Notes that a turn of `conversationId` runs on `gmi`, which records the turn in its own history. The orchestrator
   * calls it before each user turn reaches the GMI, and a continuation once the GMI it runs on holds the paused turn.
   *
   * @param gmi - The GMI the turn runs on.
   * @param conversationId - The turn's conversation.
   */
  noteTurnOnGmi(gmi: IGMI, conversationId: string): void {
    const owner = this.gmiHistoryOwners.get(gmi);
    if (owner === undefined) {
      this.gmiHistoryOwners.set(gmi, conversationId);
    } else if (owner !== conversationId) {
      this.gmiHistoryOwners.set(gmi, SEVERAL_CONVERSATIONS);
    }
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
   * further tool-call chaining. The results continue the stream only while the
   * conversation holds the pause the stream saved and each result answers one
   * of its calls; the pause is taken once, so a result delivered twice, or after
   * the pause was resumed, ended by a newer turn or replaced, is refused. The
   * GMI the results reach holds the paused turn, whatever the session's GMI ran
   * since the pause ({@link gmiForContinuation}).
   *
   * @param agentOSStreamId - The orchestrator stream ID.
   * @param toolResults - Array of tool results to process.
   * @param toolCallGate - The output guardrails' tool-call gate, which the GMI asks before each call it runs itself in
   *   the continuation.
   * @throws {GMIError} If the stream context is missing or processing fails; `INVALID_STATE`, with nothing changed,
   *   when an output guardrail blocked the stream or the stream does not wait on every one of the results.
   */
  async orchestrateToolResults(
    agentOSStreamId: StreamId,
    toolResults: AgentOSToolResultInput[],
    toolCallGate?: GuardrailToolCallGate,
  ): Promise<void> {
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
    if (this.isBlockedStream(agentOSStreamId)) {
      // the stream's turn runs on after the block, and the pause it saves is dropped when the turn ends
      const errMsg =
        `Orchestrator: An output guardrail blocked stream ${agentOSStreamId}, so tool results do not continue it.`;
      console.warn(errMsg);
      throw new GMIError(errMsg, GMIErrorCode.INVALID_STATE, {
        agentOSStreamId,
        toolResults: toolResults.map((tr) => ({
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
        })),
      });
    }
    const takenPause = this.takeStreamPause(agentOSStreamId, streamContext, toolResults);

    await this.continueWithToolResults(agentOSStreamId, streamContext, takenPause, toolResults, toolCallGate);
  }

  /**
   * Takes the pause `agentOSStreamId` stopped for, for results the host passes on the stream. The conversation's
   * pending request must be one this stream saved, each result must answer one of its calls, and no resume may hold
   * it. The pending request is cleared at once, before the continuation waits on anything, so a second delivery of the
   * results on the stream and a resume of the pause's snapshot find none.
   *
   * @throws {GMIError} `INVALID_STATE` when the stream does not wait on every call the results answer: its pause was
   *   continued, resumed on another stream, ended by a newer turn or replaced by its next pause, or a result answers a
   *   call the pause does not hold. The pending request and the stream are left as they are.
   * @returns The pause taken.
   */
  private takeStreamPause(
    agentOSStreamId: StreamId,
    streamContext: ActiveStreamContext,
    toolResults: AgentOSToolResultInput[],
  ): AgentOSPendingExternalToolRequest {
    const { conversationContext } = streamContext;
    const held = conversationContext?.getMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY) as
      | AgentOSPendingExternalToolRequest
      | undefined;
    const streamPause = held !== undefined && held.streamId === agentOSStreamId ? held : undefined;
    if (
      !streamPause ||
      !answersCallsOf(streamPause, toolResults) ||
      this.resumingPauses.has(pauseKeyOf(streamPause))
    ) {
      const errMsg =
        `Orchestrator: Stream ${agentOSStreamId} does not wait on every one of these tool results: the pause it stopped ` +
        'for was continued, resumed, ended by a newer turn or replaced, or does not hold every call they answer, so they ' +
        'do not continue it.';
      console.warn(errMsg);
      throw new GMIError(errMsg, GMIErrorCode.INVALID_STATE, {
        agentOSStreamId,
        toolResults: toolResults.map((tr) => ({
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
        })),
        pendingToolCallIds:
          streamPause && Array.isArray(streamPause.toolCalls) ? streamPause.toolCalls.map((call) => call.id) : [],
      });
    }
    conversationContext.setMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY, undefined);
    return streamPause;
  }

  /**
   * Feeds `toolResults` to the stream's GMI and ends the continuation by the turn's rule: a pause for the calls of a
   * non-final output, one `FINAL_RESPONSE` otherwise. The GMI holds the paused turn when the results reach it
   * ({@link gmiForContinuation}). The caller has taken `takenPause`, the pause the results answer:
   * the store keeps that it was taken before the results reach the GMI, and a call of it the results leave out is
   * answered as not run, in the conversation and, for a GMI that takes results together (`handleToolResults()`), in the
   * results the GMI reads, so both histories answer every call of the pause before the GMI writes again. A
   * continuation that fails before the conversation records the results (the store refuses that save, a result has
   * no JSON form, or no GMI holds the paused turn) puts the pause back, as the store holds it; one that fails later ends
   * a pause it saved for its next calls, whose request the host never read, as a new turn ends a pause
   * ({@link endPauseOfFailedStream}).
   */
  private async continueWithToolResults(
    agentOSStreamId: StreamId,
    streamContext: ActiveStreamContext,
    takenPause: AgentOSPendingExternalToolRequest,
    toolResults: AgentOSToolResultInput[],
    toolCallGate?: GuardrailToolCallGate,
  ): Promise<void> {
    const startedAt = Date.now();
    const { userId, personaId, conversationContext, userApiKeys } = streamContext;
    // the GMI the turn paused on, until the continuation knows the GMI it runs on
    let gmi = streamContext.gmi;
    let gmiInstanceIdForChunks = gmi.getGMIId();
    const metricToolName =
      toolResults.length === 1 ? toolResults[0].toolName : '__batch_external_tools__';
    const metricToolSuccess = toolResults.every((tr) => tr.isSuccess);

    console.log(
      `AgentOSOrchestrator: Feeding ${toolResults.length} tool result(s) for stream ${agentOSStreamId}, GMI ${gmiInstanceIdForChunks} back to GMI.`,
    );
    // set once nothing can refuse the results any more: the conversation records them next, when persistence is on,
    // and the GMI takes them; a failure before it leaves the pause as it was, and one after it keeps them
    let resultsRecorded = false;

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
          // The results' messages are built before anything is stored, so a result the conversation cannot record
          // fails the continuation with the pause as it was.
          const resultMessages =
            this.enableConversationalPersistence && conversationContext
              ? toolResults.map((toolResult) => toolResultMessage(toolResult, personaId))
              : [];
          // The GMI the results reach, holding the paused turn, before the conversation records the results: a GMI
          // given the conversation's history then reads them once, when it takes them.
          gmi = await this.gmiForContinuation(streamContext);
          gmiInstanceIdForChunks = gmi.getGMIId();
          span?.setAttribute('agentos.gmi_id', gmiInstanceIdForChunks);
          const continuationGate = gmiToolCallGateFor(toolCallGate, agentOSStreamId, gmiInstanceIdForChunks, streamContext);
          const continuationOptions: GMIToolResultOptions | undefined = continuationGate
            ? { toolCallGate: continuationGate }
            : undefined;
          // The caller took the pause; the store keeps that before the results reach the GMI, since the GMI takes
          // them once. A store that refuses the save fails the continuation here, with the pause put back as the store
          // holds it.
          if (this.enableConversationalPersistence && conversationContext) {
            await withAgentOSSpan('agentos.conversation.save', async (child) => {
              child?.setAttribute('agentos.stage', 'take_pending_external_tool_request');
              child?.setAttribute('agentos.stream_id', agentOSStreamId);
              await this.dependencies.conversationManager.saveConversation(conversationContext);
            });
          }

          resultsRecorded = true;

          // Emit TOOL_RESULT_EMISSION chunk and persist each result.
          for (const [index, toolResult] of toolResults.entries()) {
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

            const resultMessage = resultMessages[index];
            if (resultMessage && conversationContext) {
              conversationContext.addMessage(resultMessage);
            }
          }

          // The calls of the pause the results leave out never get a result: the next message the GMI writes ends the
          // pause's tool round, which a provider accepts only when every call of it is answered. The conversation
          // records them as not run here; the GMI reads them as not run when it takes the results below.
          const leftOutCalls = (Array.isArray(takenPause.toolCalls) ? takenPause.toolCalls : []).filter(
            (call) => !toolResults.some((tr) => tr.toolCallId === call.id),
          );
          const leftOutReason = (call: ToolCallRequest) =>
            `The host passed back results for this pause without one for '${call.name}', so the call has none.`;
          if (this.enableConversationalPersistence && conversationContext) {
            answerAsNotRun(
              conversationContext,
              unansweredPauseCalls(conversationContext, takenPause),
              personaId,
              leftOutReason,
            );
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

              // The GMI continues on its own history, so it reads the calls the results leave out as not run beside
              // the host's results; an IGMI that takes one result at a time reads the host's result alone.
              const notRunResults = leftOutCalls.map((call) => {
                const notRun = { code: EXTERNAL_TOOL_NOT_RUN_CODE, message: leftOutReason(call) };
                return {
                  toolCallId: call.id,
                  toolName: call.name,
                  output: notRun,
                  isError: true,
                  errorDetails: notRun,
                };
              });
              if (toolResults.length > 1 || (notRunResults.length > 0 && gmi.handleToolResults)) {
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
                  [
                    ...toolResults.map((tr) => ({
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
                    ...notRunResults,
                  ],
                  userId,
                  userApiKeys || {},
                  continuationOptions,
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
                continuationOptions,
              );
            },
          );

          // Process the GMI output (sources, text, ui commands, errors). The continuation's own end follows here.
          await this.processGMIOutputCallback(agentOSStreamId, streamContext, gmiOutputAfterTool, true);

          // Handle further tool calls or finalization. The continuation stops for the host by the turn's rule, so the
          // calls a final output lists, which the GMI ran or refused itself, end the turn with the final response.
          const pauseCalls = externalToolPauseCalls(gmiOutputAfterTool);
          if (pauseCalls) {
            await this.persistPendingExternalToolRequest(
              agentOSStreamId,
              streamContext,
              gmiInstanceIdForChunks,
              pauseCalls,
              gmiOutputAfterTool.responseText || 'Agent requires further tool execution.',
            );
            await this.chunks.pushChunk(
              agentOSStreamId,
              AgentOSResponseChunkType.TOOL_CALL_REQUEST,
              gmiInstanceIdForChunks,
              personaId,
              false,
              {
                toolCalls: pauseCalls,
                rationale:
                  gmiOutputAfterTool.responseText || 'Agent requires further tool execution.',
                executionMode: 'external',
                requiresExternalToolResult: true,
                metadata: buildToolCallChunkMetadata(streamContext),
              },
            );
          } else {
            // An output that does not stop for the host ends the continuation as it ends a turn, marked final or not:
            // the conversation keeps the reply, and one FINAL_RESPONSE carries what the turn's would.
            if (this.enableConversationalPersistence && conversationContext) {
              try {
                addReplyToConversation(conversationContext, gmiOutputAfterTool, personaId);
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
                ...finalResponseFieldsOf(gmiOutputAfterTool),
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
        } catch (error: any) {
          if (!resultsRecorded) {
            // neither the conversation nor the GMI took the results: the conversation holds the pause again, as the
            // store does, at once, so the host can resume it and a new turn ends it
            this.restoreTakenPause(conversationContext, takenPause);
          }
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
          if (resultsRecorded) {
            await this.endPauseOfFailedStream(agentOSStreamId, conversationContext, personaId);
          }
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

  /**
   * The GMI a continuation gives the results to, holding the paused turn. It is the stream's GMI unless that GMI was
   * shut down, as the session's GMI is when a turn on the session asks for another persona or the manager's idle
   * cleanup ends it: then it is the session's GMI for the stream's persona, acquired under the stream's organization as
   * the turn acquired its own (the manager waits for a GMI it is shutting down before it gives the session another),
   * and the stream goes on on it.
   * Such a GMI, and one whose own history holds a turn of another conversation, is given the paused turn first
   * ({@link setPausedTurnOn}). The stream's GMI keeps its own history while it holds this conversation alone, since
   * that history also holds the calls the GMI ran itself in the turn, which the conversation does not.
   *
   * @param streamContext - The continuation's stream, which goes on on the GMI returned.
   * @returns The GMI the continuation runs on.
   * @throws {GMIError} `INVALID_STATE` when the stream's GMI was shut down and the conversation holds no history of the
   *   paused turn (conversational persistence is off), or the session's GMI the manager gives is shut down too; the
   *   manager's error when it gives the session no GMI.
   */
  private async gmiForContinuation(streamContext: ActiveStreamContext): Promise<IGMI> {
    const { conversationId } = streamContext;
    let gmi = streamContext.gmi;
    if (isShutDown(gmi)) {
      if (storedHistoryOf(streamContext.conversationContext).length === 0) {
        const message =
          `The GMI the turn of conversation '${conversationId}' paused on was shut down, and the conversation holds no ` +
          'history of the paused turn to continue it on another GMI, so the results do not continue it.';
        console.warn(`AgentOSOrchestrator: ${message}`);
        throw new GMIError(message, GMIErrorCode.INVALID_STATE, { conversationId, gmiInstanceId: gmi.getGMIId() });
      }
      const acquired = await this.dependencies.gmiManager.getOrCreateGMIForSession(
        streamContext.userId,
        streamContext.sessionId,
        streamContext.personaId,
        conversationId,
        streamContext.processingOptions?.preferredModelId,
        streamContext.processingOptions?.preferredProviderId,
        streamContext.userApiKeys,
        undefined,
        // the turn's resolved organization, '' for none, as the turn pipeline passed it for the turn: a GMI built here
        // binds its learner as the GMI the turn paused on was bound
        streamContext.organizationId ?? '',
      );
      gmi = acquired.gmi;
      if (isShutDown(gmi)) {
        // the manager waits for a GMI it deactivates before it gives the session another; one shut down without it
        // continues nothing either
        const message =
          `The session's GMI for persona '${streamContext.personaId}' is shut down too, so the results do not ` +
          `continue the paused turn of conversation '${conversationId}'.`;
        console.warn(`AgentOSOrchestrator: ${message}`);
        throw new GMIError(message, GMIErrorCode.INVALID_STATE, { conversationId, gmiInstanceId: gmi.getGMIId() });
      }
      streamContext.gmi = gmi;
      this.setPausedTurnOn(gmi, streamContext);
    } else {
      const owner = this.gmiHistoryOwners.get(gmi);
      if (owner !== undefined && owner !== conversationId) {
        this.setPausedTurnOn(gmi, streamContext);
      }
    }
    this.noteTurnOnGmi(gmi, conversationId);
    return gmi;
  }

  /**
   * Gives `gmi` the paused turn of `streamContext`'s stream before the results reach it: the GMI's own history of the
   * paused turn when the stream kept it at the pause ({@link pausedTurnHistoryOf}), which holds the calls the GMI ran
   * itself in the turn, and otherwise the conversation's history, as a turn's prompt reads it, when the conversation
   * holds one (a conversation the runtime does not record holds none, and the GMI's own history goes on, with a
   * warning when it holds a turn of another conversation); then the stream's session, conversation and organization,
   * and the sources its turn retrieved. A GMI that ran a turn of another conversation keeps neither that turn's
   * organization nor its sources: a stream with no organization clears the GMI's, and a stream with no sources of its
   * turn, such as a resume in a process that does not hold the paused stream, clears the GMI's sources. A GMI that ran
   * no turn here keeps what the stream does not set.
   */
  private setPausedTurnOn(gmi: IGMI, streamContext: ActiveStreamContext): void {
    const { conversationId } = streamContext;
    const owner = this.gmiHistoryOwners.get(gmi);
    const servedAnother = owner !== undefined && owner !== conversationId;
    // the GMI's own history of the paused turn when the stream holds it, which keeps the calls the GMI ran itself in
    // the turn; the conversation's stored history otherwise
    const history =
      this.enableConversationalPersistence && streamContext.pausedTurnHistory
        ? streamContext.pausedTurnHistory
        : storedHistoryOf(streamContext.conversationContext);
    if (gmi.hydrateConversationHistory && history.length > 0) {
      gmi.hydrateConversationHistory(history as any);
      this.gmiHistoryOwners.set(gmi, conversationId);
    } else if (servedAnother) {
      // with conversational persistence off the GMI's own history is the only record of the session's conversations,
      // and setting another one would erase the other conversation's: the continuation reads it, as every turn of the
      // session does
      console.warn(
        `AgentOSOrchestrator: GMI ${gmi.getGMIId()} continues the paused turn of conversation '${conversationId}' on ` +
          'its own history, which also holds a turn of another conversation of the session: ' +
          (history.length === 0 ? 'the conversation holds no history to set in its place.' : 'the GMI takes no history.'),
      );
    }
    if (gmi.hydrateTurnContext) {
      const sources = streamContext.ragSources;
      gmi.hydrateTurnContext({
        sessionId: streamContext.sessionId,
        conversationId,
        organizationId: streamContext.organizationId ?? (servedAnother ? '' : undefined),
        ...(servedAnother || (owner !== conversationId && sources !== undefined) ? { ragSources: sources ?? [] } : {}),
      });
    }
  }

  /**
   * What the GMI of `streamContext` holds of the turn that stops for `pauseCalls`, kept with the stream for a
   * continuation on a GMI that no longer holds the turn: the GMI's own history with the pause's calls
   * ({@link withPauseCalls}), while that history holds the stream's conversation alone and the runtime records the
   * conversation. Undefined otherwise, and for a GMI that does not give its history; a continuation then starts from
   * the conversation's stored history.
   */
  private pausedTurnHistoryOf(
    streamContext: ActiveStreamContext,
    pauseCalls: ToolCallRequest[],
  ): ConversationMessage[] | undefined {
    const { gmi, conversationId } = streamContext;
    if (
      !this.enableConversationalPersistence ||
      typeof gmi.getConversationHistory !== 'function' ||
      this.gmiHistoryOwners.get(gmi) !== conversationId
    ) {
      return undefined;
    }
    try {
      return withPauseCalls(gmi.getConversationHistory(), pauseCalls);
    } catch (error: any) {
      console.warn(
        `AgentOSOrchestrator: GMI ${gmi.getGMIId()} gave no history for the pause of conversation '${conversationId}', ` +
          "so a continuation on another GMI starts from the conversation's stored history.",
        error,
      );
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Resume from persisted state
  // ---------------------------------------------------------------------------

  /**
   * Takes the pause `pendingRequest` names for one resume, before the resume
   * makes a stream or acquires the session's GMI, so a refused resume changes
   * nothing: acquiring the GMI records the resume's model and provider on the
   * conversation and can replace the session's GMI. The pause is taken when the
   * conversation holds it (saved by the same stream, for the same calls), no
   * output guardrail blocked that stream, and no other resume holds it. The
   * check and the take happen together, so of two resumes of one pause in this
   * handler one takes it.
   *
   * @param pendingRequest - The snapshot the host resumes.
   * @param toolResults - The results the resume passes: each must answer a call of the pause, as on the pause's stream.
   * @returns The release, called when the resume ends.
   * @throws {GMIError} `INVALID_STATE` when the pause is not taken: answered on
   *   its stream, dropped after an output guardrail blocked its stream (or being
   *   dropped), replaced by a newer pause, or held by another resume; or when a
   *   result answers a call the pause does not hold.
   */
  async claimPendingExternalToolRequest(
    pendingRequest: AgentOSPendingExternalToolRequest,
    toolResults?: readonly AgentOSToolResultInput[],
  ): Promise<() => void> {
    const conversation = await this.dependencies.conversationManager.getConversation(pendingRequest.conversationId);
    const heldRequest = conversation?.getMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY) as
      | AgentOSPendingExternalToolRequest
      | undefined;
    const pauseKey = pauseKeyOf(pendingRequest);
    if (
      !isHeldPendingRequest(heldRequest, pendingRequest) ||
      this.isBlockedStream(pendingRequest.streamId) ||
      this.resumingPauses.has(pauseKey)
    ) {
      const message = staleResumeMessage(pendingRequest);
      console.warn(`AgentOSOrchestrator: ${message}`);
      throw new GMIError(message, GMIErrorCode.INVALID_STATE, staleResumeDetails(pendingRequest));
    }
    if (toolResults !== undefined && !answersCallsOf(pendingRequest, toolResults)) {
      const message =
        `The pending tool request of stream '${pendingRequest.streamId}' does not hold every call these tool results ` +
        'answer, so it is not resumed with them.';
      console.warn(`AgentOSOrchestrator: ${message}`);
      throw new GMIError(message, GMIErrorCode.INVALID_STATE, {
        ...staleResumeDetails(pendingRequest),
        resultToolCallIds: toolResults.map((tr) => tr.toolCallId),
      });
    }
    this.resumingPauses.add(pauseKey);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.resumingPauses.delete(pauseKey);
      }
    };
  }

  /**
   * Holds `agentOSStreamId` as a stream an output guardrail blocked until the
   * returned release is called. Meanwhile the pause the stream saves is not
   * offered (`getPendingExternalToolRequest()` returns `null` for it), a resume
   * of it is refused, and tool results do not continue the stream.
   *
   * @param agentOSStreamId - The stream the guardrail blocked.
   * @returns The release, called once the stream's pause is dropped or found absent.
   */
  holdBlockedStream(agentOSStreamId: string): () => void {
    this.blockedStreams.set(agentOSStreamId, (this.blockedStreams.get(agentOSStreamId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const holds = (this.blockedStreams.get(agentOSStreamId) ?? 1) - 1;
      if (holds > 0) {
        this.blockedStreams.set(agentOSStreamId, holds);
      } else {
        this.blockedStreams.delete(agentOSStreamId);
      }
    };
  }

  /** Whether an output guardrail blocked `agentOSStreamId` and the pause it saves is being dropped. */
  isBlockedStream(agentOSStreamId: string): boolean {
    return this.blockedStreams.has(agentOSStreamId);
  }

  /**
   * Resumes an external tool request from persisted conversation metadata,
   * once the caller has taken its pause with
   * {@link claimPendingExternalToolRequest}. The pause is checked again once
   * the session's GMI is acquired: when it was answered on its own stream or an
   * output guardrail blocked that stream meanwhile, the stream ends with one
   * error chunk (`SYS_INVALID_STATE`) before the GMI's history is replaced or
   * the results reach the GMI. In the same step the stream's context is made,
   * which throws for an organization the runtime refuses, the GMI's history is
   * set from the conversation, and the pause is taken from the conversation;
   * then the stream the pause was saved on ends and the results continue the
   * GMI on the new stream. A refused organization leaves the pause as it was.
   *
   * @param agentOSStreamId - Fresh stream ID allocated by the orchestrator.
   * @param pendingRequest - The persisted pending request snapshot.
   * @param toolResults - Tool results to feed back.
   * @param options - Runtime-only options for resumption (API keys, model prefs).
   * @param toolCallGate - The output guardrails' tool-call gate, passed on to the continuation.
   */
  async resumeToolResultsInternal(
    agentOSStreamId: StreamId,
    pendingRequest: AgentOSPendingExternalToolRequest,
    toolResults: AgentOSToolResultInput[],
    options: AgentOSResumeExternalToolRequestOptions,
    toolCallGate?: GuardrailToolCallGate,
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

    // the pause can be answered on its own stream, or its stream blocked, while the GMI is acquired; it is checked
    // again before the GMI's history is replaced, since a stale snapshot can arrive while the conversation's next
    // turn runs on the same GMI
    const heldRequest = conversationContext.getMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY) as
      | AgentOSPendingExternalToolRequest
      | undefined;
    if (!isHeldPendingRequest(heldRequest, pendingRequest) || this.isBlockedStream(pendingRequest.streamId)) {
      const message = staleResumeMessage(pendingRequest);
      console.warn(`AgentOSOrchestrator: ${message}`);
      await this.chunks.pushError(
        agentOSStreamId,
        pendingRequest.personaId,
        pendingRequest.gmiInstanceId,
        GMIErrorCode.INVALID_STATE,
        message,
        staleResumeDetails(pendingRequest),
      );
      await this.dependencies.streamingManager.closeStream(agentOSStreamId, 'The pending tool request is no longer current.');
      return;
    }
    // what can refuse the resume (an organization the runtime refuses) runs here, in the same step as the check and
    // before the take, so a refused resume leaves the pause as it was
    const streamContext = this.openResumedStream(agentOSStreamId, pendingRequest, options, gmi, conversationContext);
    // the resume takes the pause in the same step as the check, so a result on the pause's stream or a new turn that
    // comes while the resume waits below finds no pause to continue or end
    conversationContext.setMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY, undefined);
    // the pause goes on on this stream, so the stream that stopped for it ends and no result on it continues it again
    await this.endPausedStream(
      pendingRequest.streamId,
      agentOSStreamId,
      `The pending tool request was resumed on stream ${agentOSStreamId}.`,
    );

    await this.chunks.pushChunk(
      agentOSStreamId,
      AgentOSResponseChunkType.SYSTEM_PROGRESS,
      gmi.getGMIId(),
      streamContext.personaId,
      false,
      {
        message: `Resuming external tool request for conversation ${conversationContext.sessionId}...`,
        progressPercentage: 10,
      },
    );

    await this.continueWithToolResults(agentOSStreamId, streamContext, heldRequest!, toolResults, toolCallGate);
  }

  /** Puts `takenPause` back as the conversation's pending request, unless the conversation holds another one. */
  private restoreTakenPause(
    conversationContext: ConversationContext | undefined,
    takenPause: AgentOSPendingExternalToolRequest,
  ): void {
    if (!conversationContext) {
      return;
    }
    if (conversationContext.getMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY) === undefined) {
      conversationContext.setMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY, takenPause);
    }
  }

  /**
   * Ends the pause `agentOSStreamId` saved before the turn or the continuation on it failed: the host never read the
   * request for its calls, so each call no tool message answers is answered as not run (code `EXTERNAL_TOOL_NOT_RUN`)
   * and the pending request is cleared, as a new turn ends a pause, and the conversation is saved when persistence is
   * on. A pause another stream saved is left as it is. Nothing here throws: a store that refuses the save is logged,
   * and the conversation's next save stores the end of the pause.
   *
   * @param agentOSStreamId - The stream that failed.
   * @param conversationContext - The stream's conversation, or `undefined` before the turn acquired it (no-op).
   * @param personaId - The persona the not-run results are recorded for.
   */
  async endPauseOfFailedStream(
    agentOSStreamId: StreamId,
    conversationContext: ConversationContext | undefined,
    personaId: string | undefined,
  ): Promise<void> {
    const pause = conversationContext?.getMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY) as
      | AgentOSPendingExternalToolRequest
      | undefined;
    if (!conversationContext || !pause || pause.streamId !== agentOSStreamId) {
      return;
    }
    if (this.enableConversationalPersistence) {
      answerAsNotRun(
        conversationContext,
        unansweredPauseCalls(conversationContext, pause),
        personaId,
        (call) => `The runtime failed before it asked the host to run '${call.name}', so the call has no result.`,
      );
    }
    conversationContext.setMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY, undefined);
    if (this.enableConversationalPersistence) {
      try {
        await withAgentOSSpan('agentos.conversation.save', async (span) => {
          span?.setAttribute('agentos.stage', 'end_pending_external_tool_request_after_failure');
          span?.setAttribute('agentos.stream_id', agentOSStreamId);
          await this.dependencies.conversationManager.saveConversation(conversationContext);
        });
      } catch (persistError: unknown) {
        console.warn(
          `AgentOSOrchestrator: Failed to persist the end of the pause stream ${agentOSStreamId} saved before it failed.`,
          persistError,
        );
      }
    }
  }

  /** Ends `pausedStreamId`, the stream a pause was saved on, unless it is `currentStreamId` or has ended already. */
  private async endPausedStream(pausedStreamId: string, currentStreamId: string, reason: string): Promise<void> {
    if (pausedStreamId === currentStreamId || !this.activeStreamContexts.has(pausedStreamId)) {
      return;
    }
    this.activeStreamContexts.delete(pausedStreamId);
    try {
      await this.dependencies.streamingManager.closeStream(pausedStreamId, reason);
    } catch (closeError: unknown) {
      console.warn(`AgentOSOrchestrator: Could not close stream ${pausedStreamId} after its pause moved on.`, closeError);
    }
  }

  /**
   * Opens the stream a resume continues a pause on: its context, with the organization the runtime resolves for the
   * resume, and the sources the paused turn retrieved and the GMI's own history of the turn when this process still
   * holds the paused stream; and the GMI's history and turn context set from them, from the conversation and from the
   * new stream ({@link setPausedTurnOn}).
   *
   * @throws {GMIError} When the runtime refuses the resume's organization.
   */
  private openResumedStream(
    agentOSStreamId: StreamId,
    pendingRequest: AgentOSPendingExternalToolRequest,
    options: AgentOSResumeExternalToolRequestOptions,
    gmi: IGMI,
    conversationContext: ConversationContext,
  ): ActiveStreamContext {
    const currentPersonaId = gmi.getCurrentPrimaryPersonaId();
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
      // the pause stores the calls and never the documents its turn retrieved, nor the GMI's own tool rounds; the
      // stream that saved it keeps them
      ragSources: this.activeStreamContexts.get(pendingRequest.streamId)?.ragSources,
      pausedTurnHistory: this.activeStreamContexts.get(pendingRequest.streamId)?.pausedTurnHistory,
    };
    this.activeStreamContexts.set(agentOSStreamId, streamContext);

    this.setPausedTurnOn(gmi, streamContext);
    return streamContext;
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
    // what the GMI holds of the paused turn and the store does not, for a continuation on a GMI that no longer holds it
    streamContext.pausedTurnHistory = this.pausedTurnHistoryOf(streamContext, toolCalls);

    // recorded only in a conversation the runtime records: its tool results and replies are recorded there too, and
    // a call recorded alone would reach the next turn's prompt with no result
    if (toolCalls.length > 0 && this.enableConversationalPersistence) {
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
   * Drops the pause a stream saved after an output guardrail blocked the
   * stream. It acts only when the conversation's pending request was saved by
   * `agentOSStreamId` and, with `toolCallIds`, holds one of them: each call of
   * the pause is answered with a refused tool result, so the history answers
   * every call the pause's assistant message declared, the pending request is
   * cleared, and the stream's context is removed and the stream closed, so no
   * result for the calls can continue it. The conversation is saved when
   * persistence is on. The stream is closed whether or not the store takes the
   * save: a refused save rejects once the stream is closed, and the stored
   * conversation keeps the pause until the conversation is saved again.
   *
   * @param agentOSStreamId - The stream the guardrail blocked.
   * @param streamContext - The stream's context.
   * @param toolCallIds - The ids of the calls the block withheld, or undefined
   *   for a block that withheld none, which drops the stream's pause whatever
   *   calls it holds.
   * @param refusal - What the refused tool results say.
   * @returns Whether the pause was dropped.
   * @throws The store's error when it refuses the save, after the stream is closed.
   */
  async discardPendingExternalToolRequest(
    agentOSStreamId: string,
    streamContext: ActiveStreamContext,
    toolCallIds: readonly string[] | undefined,
    refusal: GMIToolCallRefusal,
  ): Promise<boolean> {
    const { conversationContext, personaId } = streamContext;
    const pending = conversationContext.getMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY) as
      | AgentOSPendingExternalToolRequest
      | undefined;
    if (
      !pending ||
      pending.streamId !== agentOSStreamId ||
      !Array.isArray(pending.toolCalls) ||
      pending.toolCalls.length === 0 ||
      (toolCallIds !== undefined && !pending.toolCalls.some((call) => toolCallIds.includes(call.id)))
    ) {
      return false;
    }

    // a conversation the runtime does not record holds no message of the pause to answer
    for (const call of this.enableConversationalPersistence ? pending.toolCalls : []) {
      const refused = refusedToolCallResult(call, refusal);
      conversationContext.addMessage({
        role: MessageRole.TOOL,
        // worded as the GMI words a refused result in its own history
        content: `Error from tool '${call.name}': ${JSON.stringify(refused.errorDetails)}`,
        tool_call_id: call.id,
        name: call.name,
        metadata: {
          agentPersonaId: personaId,
          source: 'agentos_tool_call_refused',
          isSuccess: false,
        },
      });
    }
    conversationContext.setMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY, undefined);
    // the stream goes before the save, so a store that refuses the save cannot leave the calls open on it
    this.activeStreamContexts.delete(agentOSStreamId);

    try {
      if (this.enableConversationalPersistence) {
        await withAgentOSSpan('agentos.conversation.save', async (span) => {
          span?.setAttribute('agentos.stage', 'discard_blocked_external_tool_request');
          span?.setAttribute('agentos.stream_id', agentOSStreamId);
          await this.dependencies.conversationManager.saveConversation(conversationContext);
        });
      }
    } finally {
      await this.dependencies.streamingManager.closeStream(
        agentOSStreamId,
        'An output guardrail blocked the stream, so the tool call it stopped for was dropped.',
      );
    }
    return true;
  }

  /**
   * Ends the pause a conversation holds when a new turn starts on it, before the
   * turn records its input. Each call of the pause that no tool message answers
   * yet is answered with a tool result that says the call never ran (code
   * `EXTERNAL_TOOL_NOT_RUN`), right after the pause's assistant message, so the
   * new turn's prompt holds no call without its result; the pending request is
   * cleared, and the stream that stopped for the pause is removed and closed, so
   * a result passed on it later continues nothing. A conversation the runtime
   * does not record holds no message of the pause, and gets none. The
   * conversation is saved when persistence is on. Nothing here throws: a store
   * that refuses the save is logged, and the turn saves the conversation again
   * when it records its input.
   *
   * @param conversationContext - The conversation the new turn runs on.
   * @param newStreamId - The new turn's stream.
   * @returns Whether a pause was ended.
   */
  async endPendingExternalToolRequestForNewTurn(
    conversationContext: ConversationContext | undefined,
    newStreamId: string,
  ): Promise<boolean> {
    const pending = conversationContext?.getMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY) as
      | AgentOSPendingExternalToolRequest
      | undefined;
    if (!conversationContext || !pending || pending.streamId === newStreamId) {
      return false;
    }

    if (this.enableConversationalPersistence) {
      answerAsNotRun(
        conversationContext,
        unansweredPauseCalls(conversationContext, pending),
        pending.personaId,
        (call) =>
          `A new turn started on the conversation before the host passed back the result of '${call.name}', so the ` +
          'call has none.',
      );
    }
    conversationContext.setMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY, undefined);
    await this.endPausedStream(
      pending.streamId,
      newStreamId,
      'A new turn started on the conversation, so the tool call the stream stopped for never ran.',
    );

    if (this.enableConversationalPersistence) {
      try {
        await withAgentOSSpan('agentos.conversation.save', async (span) => {
          span?.setAttribute('agentos.stage', 'end_pending_external_tool_request');
          span?.setAttribute('agentos.stream_id', newStreamId);
          await this.dependencies.conversationManager.saveConversation(conversationContext);
        });
      } catch (persistError: unknown) {
        console.warn(
          `AgentOSOrchestrator: Failed to persist the end of the pause of stream ${pending.streamId} for the new turn on stream ${newStreamId}.`,
          persistError,
        );
      }
    }
    return true;
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
