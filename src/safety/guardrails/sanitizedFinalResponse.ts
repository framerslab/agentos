/**
 * @fileoverview The final response a guardrail's `SANITIZE` leaves: every field that carries the reply reads the
 * guardrail's text, the plain text field and the text the audio output speaks as plain text, and no value parsed or
 * audio made from the replaced reply stays. A `SANITIZE` that leaves the reply as it was changes nothing. The output
 * guardrails and the cross-agent guardrails rewrite a final response with it.
 * @module backend/agentos/safety/guardrails/sanitizedFinalResponse
 */

import type { StructuredReplyOutput } from '../../api/runtime/structuredReply';
import { renderPlainText } from '../../api/runtime/turnFinalResponse';
import type { AgentOSFinalResponseChunk } from '../../api/types/AgentOSResponse';
import type { AudioOutputConfig } from '../../cognition/substrate/IGMI';

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
 * The audio output a rewritten final response carries in place of the one made of the reply it replaced: the same voice
 * settings, speaking the guardrail's text as plain text (`renderPlainText()`, as `finalResponseTextPlain` carries it),
 * and no audio file, since the file speaks the replaced reply. A removed reply (`null`) leaves nothing to speak.
 *
 * @param audioOutput - The audio output made of the reply the guardrail replaced.
 * @param text - The guardrail's text.
 * @returns The audio output for the guardrail's text, or undefined when the guardrail removed the reply.
 */
export function rewrittenAudioOutput(audioOutput: AudioOutputConfig, text: string | null): AudioOutputConfig | undefined {
  if (text === null) return undefined;
  const { url: _audioOfReplacedReply, ...voice } = audioOutput;
  return { ...voice, textToSpeak: renderPlainText(text) };
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
 * The final response with its reply replaced by a guardrail's text: the reply and the reply in the serialized
 * conversation the chunk carries read `text`, its plain text is `text` rendered as a turn renders its own reply
 * (`renderPlainText()`), a structured value parsed from the replaced reply is withdrawn (`withdrawnStructuredReply()`),
 * and the audio output speaks `text` with no audio file of the replaced reply (`rewrittenAudioOutput()`), so no field
 * keeps the reply the guardrail rewrote. When `text` is the reply the chunk carries, the guardrail rewrote nothing, and
 * the chunk is returned as it is, with the value parsed and the audio made from its reply.
 *
 * @param chunk - The final response the guardrail sanitized.
 * @param text - The guardrail's text (`GuardrailEvaluationResult.modifiedText`).
 * @returns A copy of the chunk that carries `text` wherever it carried the reply, or `chunk` when `text` is its reply.
 */
export function sanitizedFinalResponse(chunk: AgentOSFinalResponseChunk, text: string | null): AgentOSFinalResponseChunk {
  if (text === chunk.finalResponseText) {
    return chunk;
  }
  return {
    ...chunk,
    finalResponseText: text,
    finalResponseTextPlain: text === null ? null : renderPlainText(text),
    // the serialized conversation the chunk carries holds the reply as the model wrote it: it reads the rewrite too
    updatedConversationContext: withReplyRewritten(chunk.updatedConversationContext, chunk.finalResponseText ?? null, text),
    ...(chunk.structured ? { structured: withdrawnStructuredReply(chunk.structured) } : {}),
    ...(chunk.audioOutput ? { audioOutput: rewrittenAudioOutput(chunk.audioOutput, text) } : {}),
  };
}
