/**
 * @fileoverview The rule that stops a turn for the host. The turn and each tool-result continuation decide with it
 * whether the GMI's output waits on calls the host runs, and the turn reads with it whether a chunk the GMI streamed
 * already handed the host such calls.
 * @module backend/agentos/api/runtime/externalToolPause
 */

import { GMIOutputChunkType } from '../../cognition/substrate/IGMI';
import type { GMIOutput, GMIOutputChunk, ToolCallRequest } from '../../cognition/substrate/IGMI';
import type { AgentOSToolCallExecutionMode } from '../types/AgentOSResponse';

/**
 * The calls a GMI's output stops its turn for: the host runs them and passes their results back through
 * `handleToolResult()`, `handleToolResults()` or `resumeExternalToolRequest()`. Only an output that is not final
 * (`isFinal: false`) and names at least one call stops the turn. A final output's `toolCalls` are the calls of the GMI's
 * own tool rounds, each one run or refused by the tool-call gate, with its result already in the GMI's history; the
 * turn reports them in `FINAL_RESPONSE.finalToolCalls` and never waits on them. An output that does not stop the turn
 * ends it, and a continuation, with `FINAL_RESPONSE`, whether it is marked final or not.
 *
 * @param output - The GMI's output for a turn or for a tool-result continuation.
 * @returns The calls the turn waits on, or undefined when the output does not stop the turn.
 */
export function externalToolPauseCalls(output: GMIOutput): ToolCallRequest[] | undefined {
  if (output.isFinal !== false || !Array.isArray(output.toolCalls) || output.toolCalls.length === 0) {
    return undefined;
  }
  return output.toolCalls;
}

/**
 * How the runtime stream reports a `TOOL_CALL_REQUEST` chunk a GMI streamed: `executionMode: 'external'` when the
 * chunk's metadata says so and `'internal'` otherwise, and `requiresExternalToolResult` as the metadata states it or,
 * when it states none, as the mode implies.
 *
 * @param metadata - The streamed chunk's metadata.
 * @returns The chunk's execution mode, and whether the host passes back results for its calls.
 */
export function toolCallChunkMode(metadata: Record<string, any> | undefined): {
  executionMode: AgentOSToolCallExecutionMode;
  requiresExternalToolResult: boolean;
} {
  const executionMode: AgentOSToolCallExecutionMode = metadata?.executionMode === 'external' ? 'external' : 'internal';
  return {
    executionMode,
    requiresExternalToolResult:
      typeof metadata?.requiresExternalToolResult === 'boolean'
        ? metadata.requiresExternalToolResult
        : executionMode === 'external',
  };
}

/**
 * Whether a chunk a GMI streamed reaches the host as an actionable request, one whose calls the host runs and passes
 * back (`isActionableToolCallRequestChunk()`). The host stops reading the turn's stream at such a chunk, so a turn that
 * then stops for the host streams no request of its own. A chunk for a call the GMI runs itself does not stop the
 * host's read: a turn that streamed only such chunks streams the request it stops for.
 *
 * @param chunk - A chunk the GMI streamed.
 * @returns Whether the stream reports the chunk as a `TOOL_CALL_REQUEST` with `executionMode: 'external'` and
 *   `requiresExternalToolResult: true`.
 */
export function streamsActionableToolCalls(chunk: GMIOutputChunk): boolean {
  if (chunk.type !== GMIOutputChunkType.TOOL_CALL_REQUEST || !Array.isArray(chunk.content)) {
    return false;
  }
  const mode = toolCallChunkMode(chunk.metadata);
  return mode.executionMode === 'external' && mode.requiresExternalToolResult;
}
