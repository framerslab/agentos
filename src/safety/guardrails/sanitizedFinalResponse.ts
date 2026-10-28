/**
 * @fileoverview The final response a guardrail's `SANITIZE` leaves: every field that carries the reply reads the
 * guardrail's text, and no value parsed from the replaced reply stays. The output guardrails and the cross-agent
 * guardrails rewrite a final response with it.
 * @module backend/agentos/safety/guardrails/sanitizedFinalResponse
 */

import type { StructuredReplyOutput } from '../../api/runtime/structuredReply';
import type { AgentOSFinalResponseChunk } from '../../api/types/AgentOSResponse';

/** The issue a withdrawn structured value records (`structured.meta.issues`). */
export const STRUCTURED_REPLY_WITHDRAWN_ISSUE =
  'A guardrail rewrote the reply after it was parsed, so the value parsed from the reply as the model wrote it was withdrawn.';

/**
 * The structured value a rewritten final response carries in place of the one parsed from the reply it replaced: no
 * value, marked invalid at the `post_guardrail` stage. `processRequest()` holds the turn's schema and checks the
 * rewritten reply against it, which replaces this value; a stream that holds no schema (a tool-result continuation, a
 * cross-agent supervisor's) hands it to the host as it is, so no value parsed from the replaced reply reaches the host.
 *
 * @param structured - The value parsed from the reply the guardrail replaced.
 * @returns The withdrawn value, which keeps the schema's name, the attempts and the enforcement.
 */
export function withdrawnStructuredReply(structured: StructuredReplyOutput): StructuredReplyOutput {
  return {
    value: null,
    meta: { ...structured.meta, valid: false, stage: 'post_guardrail', issues: [STRUCTURED_REPLY_WITHDRAWN_ISSUE] },
  };
}

/**
 * A copy of a serialized conversation (a final chunk's `updatedConversationContext`) in which the newest assistant
 * message that reads `from` reads `to`; anything that is not a conversation with messages is returned as it is.
 *
 * @param context - The serialized conversation the final chunk carries.
 * @param from - The reply as the chunk carried it before the rewrite.
 * @param to - The reply the guardrail wrote.
 * @returns The conversation with that reply rewritten, or `context` when it holds no such reply.
 */
export function withReplyRewritten<T>(context: T, from: string | null, to: string | null | undefined): T {
  if (from === null || !context || typeof context !== 'object') return context;
  const messages = (context as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return context;
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (m && m.role === 'assistant' && m.content === from) {
      index = i;
      break;
    }
  }
  if (index < 0) return context;
  const copy = messages.slice();
  copy[index] = { ...(messages[index] as object), content: to ?? '' };
  return { ...(context as object), messages: copy } as T;
}

/**
 * The final response with its reply replaced by a guardrail's text: the reply, its plain text and the reply in the
 * serialized conversation the chunk carries all read `text`, and a structured value parsed from the replaced reply is
 * withdrawn (`withdrawnStructuredReply()`), so no field keeps the reply the guardrail rewrote.
 *
 * @param chunk - The final response the guardrail sanitized.
 * @param text - The guardrail's text (`GuardrailEvaluationResult.modifiedText`).
 * @returns A copy of the chunk that carries `text` wherever it carried the reply.
 */
export function sanitizedFinalResponse(chunk: AgentOSFinalResponseChunk, text: string | null): AgentOSFinalResponseChunk {
  return {
    ...chunk,
    finalResponseText: text,
    finalResponseTextPlain: text,
    // the serialized conversation the chunk carries holds the reply as the model wrote it: it reads the rewrite too
    updatedConversationContext: withReplyRewritten(chunk.updatedConversationContext, chunk.finalResponseText ?? null, text),
    ...(chunk.structured ? { structured: withdrawnStructuredReply(chunk.structured) } : {}),
  };
}
