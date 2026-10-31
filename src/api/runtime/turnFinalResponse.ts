/**
 * @fileoverview How a turn and each of its tool-result continuations end: the reply the conversation keeps, and the
 * fields the `FINAL_RESPONSE` takes from the GMI's output. The turn and the continuation build both the same way.
 * @module backend/agentos/api/runtime/turnFinalResponse
 */

import type { ConversationContext } from '../../core/conversation/ConversationContext';
import { MessageRole } from '../../core/conversation/ConversationMessage';
import type { GMIOutput } from '../../cognition/substrate/IGMI';
import { normalizeUsage } from '../../orchestration/turn-planner/helpers';
import type { AgentOSFinalResponseChunk } from '../types/AgentOSResponse';

/**
 * The plain text of a Markdown reply, for voice output and logs: fenced and inline code keep their text, links and
 * images keep their label, and heading and quote markers, emphasis, rules and HTML tags are removed.
 *
 * @param markdown - The reply as the model wrote it.
 * @returns The reply as plain text, trimmed.
 */
export function renderPlainText(markdown: string): string {
  let text = String(markdown ?? '');
  if (!text.trim()) return '';

  text = text.replace(/\r\n/g, '\n');
  // Fenced code blocks: keep inner content, drop fences.
  text = text.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, '$1');
  // Inline code.
  text = text.replace(/`([^`]+)`/g, '$1');
  // Images + links.
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Headings + blockquotes.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  // Emphasis / strike-through.
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');
  // Horizontal rules.
  text = text.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '');
  // Basic HTML tags.
  text = text.replace(/<\/?[^>]+>/g, '');

  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/** The `FINAL_RESPONSE` fields that come from the GMI's output. */
export type FinalResponseOutputFields = Pick<
  AgentOSFinalResponseChunk,
  | 'finalResponseText'
  | 'finalResponseTextPlain'
  | 'finalToolCalls'
  | 'finalUiCommands'
  | 'audioOutput'
  | 'imageOutput'
  | 'usage'
  | 'reasoningTrace'
  | 'error'
  | 'ragSources'
  | 'structured'
>;

/**
 * The `FINAL_RESPONSE` fields a turn or a continuation takes from the GMI's output that ends it: the reply and its
 * plain text, the calls the GMI ran or refused in its own tool rounds, the UI commands, the audio and image output, the
 * usage, the reasoning trace, the error, the sources and, on a structured turn, the parsed value. The caller adds the
 * conversation and the persona.
 *
 * @param output - The GMI's output that ends the turn or the continuation.
 * @returns The fields, ready to push with the final chunk.
 */
export function finalResponseFieldsOf(output: GMIOutput): FinalResponseOutputFields {
  return {
    finalResponseText: output.responseText ?? null,
    finalResponseTextPlain: typeof output.responseText === 'string' ? renderPlainText(output.responseText) : null,
    finalToolCalls: output.toolCalls,
    finalUiCommands: output.uiCommands,
    audioOutput: output.audioOutput,
    imageOutput: output.imageOutput,
    usage: normalizeUsage(output.usage),
    reasoningTrace: output.reasoningTrace,
    error: output.error,
    ragSources: output.ragSources,
    ...(output.structuredOutput ? { structured: output.structuredOutput } : {}),
  };
}

/**
 * Adds the reply of the output that ends a turn or a continuation to the conversation, as the assistant's message,
 * when the output has one. The calls the output lists are never added: the GMI ran them, or the tool-call gate refused
 * them, in its own tool rounds, and their results live in the GMI's history alone, so a message naming them would
 * leave calls that no tool message answers in the history a later turn sends the model.
 *
 * @param conversationContext - The turn's conversation.
 * @param output - The GMI's output that ends the turn or the continuation.
 * @param personaId - The persona that replied.
 * @returns Whether a message was added.
 */
export function addReplyToConversation(
  conversationContext: ConversationContext,
  output: GMIOutput,
  personaId: string | undefined,
): boolean {
  if (typeof output.responseText !== 'string' || !output.responseText.trim()) {
    return false;
  }
  conversationContext.addMessage({
    role: MessageRole.ASSISTANT,
    content: output.responseText,
    metadata: { agentPersonaId: personaId, source: 'agentos_output' },
  });
  return true;
}
