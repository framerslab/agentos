/**
 * @fileoverview Manages the GMI's internal conversation history, including
 * adding new messages, trimming to size, building prompt-compatible snapshots,
 * and converting between ChatMessage and ConversationMessage formats.
 *
 * Extracted from GMI.ts to isolate conversation state management from the
 * core cognitive engine, reducing class complexity while preserving full
 * feature parity.
 *
 * @module cognitive_substrate/ConversationHistoryManager
 */

import { ChatMessage } from '../../core/llm/providers/IProvider';
import {
  ConversationMessage,
  createConversationMessage,
  MessageRole,
} from '../../core/conversation/ConversationMessage';
import {
  GMIInteractionType,
  GMITurnInput,
  ToolCallResult,
} from './IGMI';

const DEFAULT_MAX_CONVERSATION_HISTORY_TURNS = 20;

/**
 * Encapsulates all conversation history state and operations for a GMI instance.
 *
 * Owns the mutable `ChatMessage[]` array and provides methods to append user/tool/system
 * messages, trim to a configurable maximum, build `ConversationMessage[]` snapshots for
 * prompt construction, and hydrate from a previously serialized conversation.
 *
 * Dependencies are injected via the constructor; no direct coupling to GMI internals.
 */
export class ConversationHistoryManager {
  /** The mutable backing store for conversation messages. */
  private conversationHistory: ChatMessage[] = [];

  /**
   * Creates a new ConversationHistoryManager.
   *
   * @param maxHistoryLength - Maximum number of messages to retain in the conversation
   *   history window. When exceeded, the oldest messages are removed. Defaults to 20.
   */
  constructor(
    private maxHistoryLength: number = DEFAULT_MAX_CONVERSATION_HISTORY_TURNS,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns a readonly view of the current conversation history.
   *
   * The returned array reference is live (reflects mutations), but callers
   * should not mutate it directly. Use the dedicated mutation methods instead.
   */
  public get history(): readonly ChatMessage[] {
    return this.conversationHistory;
  }

  /**
   * Appends a new turn's messages to the conversation history and trims
   * to the configured maximum length. The trim removes the oldest messages,
   * and with them any tool results the cut would leave without the assistant
   * message that called their tools.
   *
   * Handles TEXT, MULTIMODAL_CONTENT, TOOL_RESPONSE, and SYSTEM_MESSAGE
   * interaction types. For TOOL_RESPONSE, multiple results are each appended
   * as separate tool-role messages.
   *
   * @param turnInput - The incoming turn input from the GMI turn processor.
   * @param maxMessages - Optional override for the maximum history length
   *   (used when the persona defines a custom limit at runtime).
   */
  public update(turnInput: GMITurnInput, maxMessages?: number): void {
    let messageToAdd: ChatMessage | null = null;

    switch (turnInput.type) {
      case GMIInteractionType.TEXT:
        messageToAdd = {
          role: 'user',
          content: turnInput.content as string,
          name: turnInput.metadata?.userName || turnInput.userId,
        };
        break;
      case GMIInteractionType.MULTIMODAL_CONTENT:
        messageToAdd = {
          role: 'user',
          content: turnInput.content as any,
          name: turnInput.metadata?.userName || turnInput.userId,
        };
        break;
      case GMIInteractionType.TOOL_RESPONSE: {
        const results = Array.isArray(turnInput.content)
          ? (turnInput.content as ToolCallResult[])
          : [turnInput.content as ToolCallResult];
        results.forEach(result => {
          this.conversationHistory.push({
            role: 'tool',
            tool_call_id: result.toolCallId,
            name: result.toolName,
            content:
              typeof result.output === 'string'
                ? result.output
                : JSON.stringify(result.output),
          });
        });
        break;
      }
      case GMIInteractionType.SYSTEM_MESSAGE:
        messageToAdd = { role: 'system', content: turnInput.content as string };
        break;
    }
    if (messageToAdd) this.conversationHistory.push(messageToAdd);

    const effectiveMax = maxMessages ?? this.maxHistoryLength;
    if (this.conversationHistory.length > effectiveMax) {
      let removeCount = this.conversationHistory.length - effectiveMax;
      // A cut inside a tool round would keep tool results whose assistant
      // message (the one that called the tools) is gone, and providers reject a
      // tool result that answers no call. The round's remaining results go too.
      while (this.conversationHistory[removeCount]?.role === 'tool') removeCount += 1;
      this.conversationHistory.splice(0, removeCount);
    }
  }

  /**
   * Appends a single tool-call result to the conversation history.
   *
   * Used after internal tool execution within the GMI's ReAct loop.
   * Formats error results with a descriptive prefix so the LLM can
   * distinguish success from failure.
   *
   * @param toolCallResult - The result from a tool execution.
   * @returns The tool-role message that was appended.
   */
  public updateWithToolResult(toolCallResult: ToolCallResult): ChatMessage {
    const message: ChatMessage = {
      role: 'tool',
      tool_call_id: toolCallResult.toolCallId,
      name: toolCallResult.toolName,
      content: toolCallResult.isError
        ? `Error from tool '${toolCallResult.toolName}': ${JSON.stringify(toolCallResult.errorDetails || toolCallResult.output)}`
        : typeof toolCallResult.output === 'string'
          ? toolCallResult.output
          : JSON.stringify(toolCallResult.output),
    };
    this.conversationHistory.push(message);
    return message;
  }

  /**
   * Builds a `ConversationMessage[]` snapshot of the current history, suitable
   * for injection into the PromptEngine's `PromptComponents`.
   *
   * Each ChatMessage is converted to the richer ConversationMessage format,
   * preserving tool_calls, thinking blocks, role mappings, and content
   * normalization.
   *
   * @returns An array of ConversationMessage objects mirroring the current history.
   */
  public buildForPrompt(): ConversationMessage[] {
    return this.conversationHistory.map(msg =>
      this.convertToConversationMessage(msg),
    );
  }

  /**
   * Replaces the entire conversation history by hydrating from a serialized
   * `ConversationMessage[]` (e.g., loaded from persistent storage).
   *
   * Messages with roles ERROR or THOUGHT are silently dropped, as they have
   * no ChatMessage equivalent. All others are converted to ChatMessage format.
   *
   * @param conversationHistory - The ConversationMessage array to hydrate from.
   */
  public hydrate(conversationHistory: ConversationMessage[]): void {
    this.conversationHistory = conversationHistory
      .map(message => this.convertToChatMessage(message))
      .filter((message): message is ChatMessage => message !== null);
  }

  /**
   * Converts a single ChatMessage (LLM-provider format) to a ConversationMessage
   * (AgentOS internal format).
   *
   * Handles role mapping, content normalization, and tool_calls conversion
   * (string arguments are parsed to objects). An assistant turn's thinking
   * blocks are kept as they are, because Anthropic rejects a tool-loop
   * request that does not replay them verbatim.
   *
   * @param chatMsg - The ChatMessage to convert.
   * @returns The equivalent ConversationMessage.
   */
  public convertToConversationMessage(chatMsg: ChatMessage): ConversationMessage {
    const conversationMessage = createConversationMessage(
      this.mapChatRoleToMessageRole(chatMsg.role),
      this.normalizeChatMessageContent(chatMsg.content),
      {
        name: chatMsg.name,
        tool_call_id: chatMsg.tool_call_id,
      },
    );

    if (chatMsg.tool_calls && chatMsg.tool_calls.length > 0) {
      conversationMessage.tool_calls = chatMsg.tool_calls
        .filter(tc => !!tc?.function?.name)
        .map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: this.parseToolCallArguments(tc.function.arguments),
          ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
        }));
    }

    if (chatMsg.thinkingBlocks && chatMsg.thinkingBlocks.length > 0) {
      conversationMessage.thinkingBlocks = [...chatMsg.thinkingBlocks];
    }

    return conversationMessage;
  }

  /**
   * Converts a single ConversationMessage (AgentOS internal format) back to a
   * ChatMessage (LLM-provider format).
   *
   * Messages with roles ERROR or THOUGHT return `null` as they have no
   * meaningful ChatMessage representation. SUMMARY messages are prefixed
   * with `[Conversation Summary]`. Thinking blocks carry over unchanged.
   *
   * @param message - The ConversationMessage to convert.
   * @returns The equivalent ChatMessage, or null if the role is not representable.
   */
  public convertToChatMessage(
    message: ConversationMessage,
  ): ChatMessage | null {
    if (message.role === MessageRole.ERROR || message.role === MessageRole.THOUGHT) {
      return null;
    }

    const role: ChatMessage['role'] =
      message.role === MessageRole.SYSTEM || message.role === MessageRole.SUMMARY
        ? 'system'
        : message.role === MessageRole.ASSISTANT
          ? 'assistant'
          : message.role === MessageRole.TOOL
            ? 'tool'
            : 'user';

    const content =
      message.role === MessageRole.SUMMARY && typeof message.content === 'string'
        ? `[Conversation Summary]\n${message.content}`
        : this.normalizeConversationMessageContent(message.content);

    return {
      role,
      content,
      name: message.name,
      tool_call_id: message.tool_call_id,
      tool_calls: Array.isArray(message.tool_calls)
        ? message.tool_calls.map(toolCall => ({
            id: toolCall.id,
            type: 'function' as const,
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments ?? {}),
            },
            ...(toolCall.thoughtSignature ? { thoughtSignature: toolCall.thoughtSignature } : {}),
          }))
        : undefined,
      ...(Array.isArray(message.thinkingBlocks) && message.thinkingBlocks.length > 0
        ? { thinkingBlocks: [...message.thinkingBlocks] }
        : {}),
    };
  }

  /**
   * Directly pushes a pre-built ChatMessage into the history.
   *
   * Used by the GMI's main processing loop to append the assistant's own
   * response (including any tool_calls) after LLM streaming completes.
   *
   * @param message - The ChatMessage to push.
   */
  public push(message: ChatMessage): void {
    this.conversationHistory.push(message);
  }

  /**
   * Resets the conversation history to an empty array.
   * Used during re-initialization.
   */
  public clear(): void {
    this.conversationHistory = [];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Maps a ChatMessage role string to the richer MessageRole enum.
   *
   * @param role - The ChatMessage role ('system' | 'user' | 'assistant' | 'tool').
   * @returns The corresponding MessageRole enum value.
   */
  private mapChatRoleToMessageRole(role: ChatMessage['role']): MessageRole {
    switch (role) {
      case 'system':
        return MessageRole.SYSTEM;
      case 'assistant':
        return MessageRole.ASSISTANT;
      case 'tool':
        return MessageRole.TOOL;
      default:
        return MessageRole.USER;
    }
  }

  /**
   * Normalizes ChatMessage content (which may be string, null, undefined, or an
   * array of content parts) into ConversationMessage-compatible content.
   *
   * @param content - The raw ChatMessage content.
   * @returns Normalized content suitable for a ConversationMessage.
   */
  private normalizeChatMessageContent(
    content: ChatMessage['content'],
  ): ConversationMessage['content'] {
    if (typeof content === 'undefined') {
      return null;
    }
    if (content === null || typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map(part => ({ ...part }));
    }
    return content as unknown as ConversationMessage['content'];
  }

  /**
   * Normalizes ConversationMessage content into ChatMessage-compatible content.
   *
   * @param content - The ConversationMessage content.
   * @returns Normalized content suitable for a ChatMessage.
   */
  private normalizeConversationMessageContent(
    content: ConversationMessage['content'],
  ): ChatMessage['content'] {
    if (content === null || typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map(part => ({ ...part })) as ChatMessage['content'];
    }
    return JSON.stringify(content);
  }

  /**
   * Safely parses tool call arguments from their raw form (string, object, or
   * falsy) into a `Record<string, any>`.
   *
   * Falls back to an empty object on parse errors or unexpected types.
   *
   * @param args - The raw arguments value from a tool call.
   * @returns A parsed arguments object.
   */
  private parseToolCallArguments(args: unknown): Record<string, any> {
    if (!args) {
      return {};
    }
    if (typeof args === 'string') {
      try {
        return JSON.parse(args);
      } catch {
        return {};
      }
    }
    if (typeof args === 'object') {
      return args as Record<string, any>;
    }
    return {};
  }
}
