/**
 * @fileoverview The refused tool result recorded for a call a tool-call gate refuses.
 * @module cognition/substrate/toolCallGate
 */

import { GMIErrorCode } from '../../core/utils/errors.js';
import type { GMIToolCallRefusal, ToolCallRequest, ToolCallResult } from './IGMI';

/** The `errorDetails.reason` of a call a tool-call gate refused. */
export const TOOL_CALL_REFUSED_REASON = 'Refused by an output guardrail';

/**
 * The refused tool result for `call`, recorded as a permission refusal is: an error with the code
 * `AUTH_PERMISSION_DENIED` whose message is the refusal's reason, with the refusing guardrail's id and reason code in
 * its details.
 *
 * @param call - The refused call.
 * @param refusal - Why it was refused.
 * @returns The tool result the model reads in place of the tool's output.
 */
export function refusedToolCallResult(call: ToolCallRequest, refusal: GMIToolCallRefusal): ToolCallResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    output: null,
    isError: true,
    errorDetails: {
      message: refusal.reason,
      code: GMIErrorCode.PERMISSION_DENIED,
      reason: TOOL_CALL_REFUSED_REASON,
      details: {
        ...(refusal.guardrailId ? { guardrailId: refusal.guardrailId } : {}),
        ...(refusal.reasonCode ? { reasonCode: refusal.reasonCode } : {}),
      },
    },
  };
}
