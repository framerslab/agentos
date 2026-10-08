/**
 * @file gmiTranscript.ts
 * Conversions between the session store's transcript and a GMI's conversation
 * history (`agent({ runtime: 'gmi' })`). Before every turn the GMI's history is
 * replaced with the store's messages; as each model step finishes, the messages
 * it adds are written to the store.
 *
 * A step is stored as the GMI put it in its own history (the assistant message
 * with its tool calls and thinking blocks, then each tool result in the GMI's
 * wording), so the next turn replays the bytes the provider already saw and a
 * cached prompt prefix stays valid.
 */
import { createConversationMessage, MessageRole, type ConversationMessage } from '../../core/conversation/ConversationMessage.js';
import type { ThinkingBlock } from '../../core/llm/providers/IProvider.js';
import type { StepFinishedChunkPayload, ToolCallRequest, ToolResultChunkPayload } from '../../cognition/substrate/IGMI.js';
import { toProviderReplayMessage, type SessionTranscriptMessage } from '../sessionTranscript.js';

/** A tool call's JSON arguments as an object; a non-object or unparsable value is kept under `value` or `raw`. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw };
  }
}

/** Message content a GMI history entry can hold: text, parts, or null; anything else as its JSON. */
function conversationContent(content: unknown): ConversationMessage['content'] {
  if (content === null || content === undefined) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content as Array<Record<string, any>>;
  return JSON.stringify(content);
}

/**
 * The store's messages as GMI conversation history: roles, tool calls with
 * parsed arguments and Gemini thought signatures, tool-result ids, and thinking
 * blocks (a caller-built signed `thinking` entry becomes a block, as a replay to
 * the provider makes it). The `partial` marker is left out.
 *
 * @param messages - The session store's messages, oldest first.
 * @returns History for `IGMI.replaceHistory`.
 */
export function transcriptToConversation(messages: readonly SessionTranscriptMessage[]): ConversationMessage[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return createConversationMessage(MessageRole.USER, conversationContent(message.content) ?? '');
    }
    if (message.role === 'tool') {
      return createConversationMessage(MessageRole.TOOL, message.content, { tool_call_id: message.tool_call_id });
    }
    const replay = toProviderReplayMessage(message) as { thinkingBlocks?: ThinkingBlock[] };
    const toolCalls = message.tool_calls?.length
      ? message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: parseArguments(tc.function.arguments),
          ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
        }))
      : undefined;
    return createConversationMessage(MessageRole.ASSISTANT, conversationContent(message.content), {
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      ...(replay.thinkingBlocks?.length ? { thinkingBlocks: replay.thinkingBlocks } : {}),
    });
  });
}

/** One finished model step and what the turn produced around it. */
export interface StepTranscriptInput {
  step: StepFinishedChunkPayload;
  /** The tool calls the step requested, in order. */
  calls: ToolCallRequest[];
  /** The step's tool results, in order. */
  results: ToolResultChunkPayload[];
  /** The turn's user message, given on the turn's first step. */
  userMessage?: SessionTranscriptMessage;
  /** `onAfterGeneration`'s replacement for the step text. */
  textOverride?: string;
}

/** A tool result's content, worded as the GMI words it in its own history (`ConversationHistoryManager.updateWithToolResult`). */
function toolContent(result: ToolResultChunkPayload): string {
  if (result.isError) {
    return `Error from tool '${result.name}': ${JSON.stringify(result.errorDetails || result.result)}`;
  }
  return typeof result.result === 'string' ? result.result : (JSON.stringify(result.result) ?? '');
}

/**
 * The store messages one finished step adds: the turn's user message on the
 * first step, the assistant message (left out when the step produced neither
 * text nor tool calls), then one tool message per result. A step that answered
 * a response schema is stored as the JSON string of its answer.
 *
 * @param input - The step, its calls and results, and the turn's user message on the first step.
 * @returns The messages to append through the turn writer.
 */
export function stepToTranscript(input: StepTranscriptInput): SessionTranscriptMessage[] {
  const { step, calls, results, userMessage, textOverride } = input;
  const text = step.structuredOutput !== undefined ? JSON.stringify(step.structuredOutput) : (textOverride ?? step.text);
  const out: SessionTranscriptMessage[] = userMessage ? [userMessage] : [];
  if (calls.length > 0 || text) {
    out.push({
      role: 'assistant',
      content: text || null,
      ...(calls.length > 0
        ? {
            tool_calls: calls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
              ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
            })),
          }
        : {}),
      ...(step.thinkingBlocks?.length ? { thinkingBlocks: step.thinkingBlocks } : {}),
    });
  }
  for (const result of results) out.push({ role: 'tool', tool_call_id: result.toolCallId, content: toolContent(result) });
  return out;
}
