/**
 * @fileoverview The rule that stops a turn for the host. The turn and each tool-result continuation decide with it
 * whether the GMI's output waits on calls the host runs.
 * @module backend/agentos/api/runtime/externalToolPause
 */

import type { GMIOutput, ToolCallRequest } from '../../cognition/substrate/IGMI';

/**
 * The calls a GMI's output stops its turn for: the host runs them and passes their results back through
 * `handleToolResult()`, `handleToolResults()` or `resumeExternalToolRequest()`. Only an output that is not final
 * (`isFinal: false`) and names at least one call stops the turn. A final output's `toolCalls` are the calls of the GMI's
 * own tool rounds, each one run or refused by the tool-call gate, with its result already in the GMI's history; the
 * turn reports them in `FINAL_RESPONSE.finalToolCalls` and never waits on them.
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
