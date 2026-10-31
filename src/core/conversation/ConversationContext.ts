// File: backend/agentos/core/conversation/ConversationContext.ts
/**
 * @fileoverview Manages the state, history, and metadata of a single conversation in AgentOS.
 * It provides robust methods for adding messages, retrieving history with various strategies
 * (including AI-powered summarization if an IUtilityAI service is provided),
 * and managing session-specific metadata. Designed for comprehensive state export and import.
 *
 * @module backend/agentos/core/conversation/ConversationContext
 * @see ./ConversationMessage.ts For ConversationMessage and MessageRole definitions.
 * @see ../ai_utilities/IUtilityAI.ts For IUtilityAI and SummarizationOptions definitions.
 */

import { ConversationMessage, MessageRole, createConversationMessage, MessageMetadata } from './ConversationMessage';
import { toolRoundBounds, type ToolRoundBounds } from './toolRounds';
import { IUtilityAI, SummarizationOptions } from '../../cognition/nlp/ai_utilities/IUtilityAI';
import { uuidv4 } from '../utils/uuid.js';
import { GMIError, GMIErrorCode } from '../utils/errors.js'; // Corrected path

// Constants for summarization logic
const DEFAULT_MAX_HISTORY_MESSAGES = 100;
const DEFAULT_VERBATIM_TAIL_COUNT = 10;
const DEFAULT_VERBATIM_HEAD_COUNT = 2;
const DEFAULT_SUMMARIZATION_CHUNK_SIZE = 20; // Messages to group for one summary
const MIN_MESSAGES_FOR_SUMMARIZATION_ATTEMPT = 5; // Don't try to summarize too few messages
const DEFAULT_SUMMARIZATION_OPTIONS: SummarizationOptions = { desiredLength: 'medium', method: 'abstractive_llm' };

/**
 * Where to cut `messages` to keep their first `headCount` and their last `tailCount` messages. Providers refuse a tool
 * call without its result and a tool result without its call, so neither cut falls inside a tool round (an assistant
 * message that names tool calls, the tool messages that answer them and anything between, as `toolRoundBounds` finds
 * them): a round the head reaches into is kept whole in the head, and a round the tail reaches into is kept whole in
 * the tail. When that keeps more than `headCount` or `tailCount` messages, the round is kept whole anyway, as the
 * prompt engine's token trim (`PromptEngine.truncateMessages`) keeps a round it cannot drop.
 *
 * @param messages - The messages, oldest first.
 * @param headCount - How many of the first messages to keep.
 * @param tailCount - How many of the last messages to keep.
 * @param rounds - The tool rounds of `messages`, when the caller has them.
 * @returns `headEnd`, the index after the kept head, and `tailStart`, the index of the kept tail's first message, never
 * before `headEnd`. The cut leaves out the messages between them, none when the two are equal.
 */
function cutsKeepingToolRounds(
  messages: ReadonlyArray<ConversationMessage>,
  headCount: number,
  tailCount: number,
  rounds?: ToolRoundBounds,
): { headEnd: number; tailStart: number } {
  const head = Math.min(Math.floor(Math.max(0, headCount)), messages.length);
  const tail = Math.min(Math.floor(Math.max(0, tailCount)), messages.length);
  if (head + tail >= messages.length) {
    return { headEnd: messages.length, tailStart: messages.length };
  }
  const bounds = rounds ?? toolRoundBounds(messages);
  const headEnd = head > 0 ? bounds.end[head - 1] + 1 : 0;
  const tailStart = tail > 0 ? bounds.start[messages.length - tail] : messages.length;
  return { headEnd, tailStart: Math.max(headEnd, tailStart) };
}

/**
 * Where a trim cuts a message list: it keeps the messages before `headEnd`, the summary at `summaryIndex` (none when it
 * is -1), and the messages from `tailStart` on.
 */
interface TrimCuts {
  headEnd: number;
  summaryIndex: number;
  tailStart: number;
}

/**
 * The messages a trim keeps, in their order.
 *
 * @param messages - The messages, oldest first.
 * @param cuts - Where the trim cuts them.
 * @returns The kept messages.
 */
function keptByTrim<T>(messages: ReadonlyArray<T>, cuts: TrimCuts): T[] {
  return [
    ...messages.slice(0, cuts.headEnd),
    ...(cuts.summaryIndex >= 0 ? [messages[cuts.summaryIndex]] : []),
    ...messages.slice(cuts.tailStart),
  ];
}

/**
 * A history setting read as a number of messages: the whole part of the number it reads as, never below 0, and
 * `fallback` when it reads as none (given as undefined, or NaN).
 *
 * @param value - The setting.
 * @param fallback - The setting's default.
 * @returns The number of messages.
 */
function messageCount(value: unknown, fallback: number): number {
  const count = Number(value);
  return Number.isNaN(count) ? fallback : Math.max(0, Math.floor(count));
}

/**
 * Configuration for the ConversationContext, defining its behavior and limits. Each of the four counts of messages
 * (`maxHistoryLengthMessages`, `messagesToKeepVerbatimTail`, `messagesToKeepVerbatimHead`, `summarizationChunkSize`)
 * counts the whole part of the number it reads as, and one that reads as none (given as undefined, or NaN) keeps its
 * default.
 * @interface ConversationContextConfig
 * @property {number} [maxHistoryLengthMessages=100] - The number of messages the history keeps: past it, the oldest messages after the first `messagesToKeepVerbatimHead` are dropped, or summarized with `enableAutomaticSummarization`, and the last summary after those first messages is kept with them. A tool round the kept messages reach into is kept whole, past this number when it has to be.
 * @property {boolean} [enableAutomaticSummarization=false] - If true, attempts to summarize older parts of the conversation when history exceeds limits. Requires `utilityAI`.
 * @property {number} [messagesToKeepVerbatimTail=10] - Number of most recent messages to always keep verbatim (not summarized), more when the oldest of them is part of a tool round.
 * @property {number} [messagesToKeepVerbatimHead=2] - Number of earliest messages (e.g., system prompts, initial user query) to always keep verbatim, more when the last of them is part of a tool round.
 * @property {number} [summarizationChunkSize=20] - Number of messages to group for a single summarization pass, more when the last of them is part of a tool round: the round is summarized whole.
 * @property {SummarizationOptions} [summarizationOptions] - Default options for the summarization process.
 * @property {IUtilityAI} [utilityAI] - Optional. An instance of `IUtilityAI` used for summarization and other NLP tasks.
 * @property {string} [defaultLanguage='en-US'] - Default language (BCP-47) for context-sensitive operations if not otherwise specified.
 * @property {string} [userId] - Optional. The ID of the user associated with this conversation.
 * @property {string} [gmiInstanceId] - Optional. The ID of the GMI instance managing this conversation.
 * @property {string} [activePersonaId] - Optional. The ID of the persona active in this conversation.
 */
export interface ConversationContextConfig {
  maxHistoryLengthMessages?: number;
  enableAutomaticSummarization?: boolean;
  messagesToKeepVerbatimTail?: number;
  messagesToKeepVerbatimHead?: number;
  summarizationChunkSize?: number;
  summarizationOptions?: SummarizationOptions;
  utilityAI?: IUtilityAI;
  defaultLanguage?: string;
  userId?: string;
  gmiInstanceId?: string;
  activePersonaId?: string;
}

/**
 * @class ConversationContext
 * @description Manages the messages, metadata, and operational state for a single conversation.
 * It ensures that conversation history is handled efficiently, including potential summarization
 * to manage context length, and provides a structured way to access and modify conversation-related data.
 */
export class ConversationContext {
  /**
   * Unique identifier for this conversation session.
   * @public
   * @readonly
   * @type {string}
   */
  public readonly sessionId: string;

  /**
   * Timestamp (Unix epoch in milliseconds) of when this context was created.
   * @public
   * @readonly
   * @type {number}
   */
  public readonly createdAt: number;

  /**
   * Array holding all messages in the conversation, ordered by timestamp.
   * @private
   * @type {ConversationMessage[]}
   */
  private messages: ConversationMessage[];

  /**
   * Readonly configuration applied to this context instance.
   * @private
   * @readonly
   * @type {Required<ConversationContextConfig>}
   */
  private readonly config: Required<ConversationContextConfig>;

  /**
   * A key-value store for arbitrary metadata associated with this conversation session.
   * @private
   * @type {Record<string, any>}
   */
  private sessionMetadata: Record<string, any>;

  /**
   * Optional instance of a utility AI service for tasks like summarization.
   * @private
   * @readonly
   * @type {IUtilityAI | undefined}
   */
  private readonly utilityAI?: IUtilityAI;

  /**
   * A lock to prevent concurrent summarization operations on the same context.
   * @private
   * @type {boolean}
   */
  private isSummarizing: boolean = false;

  /**
   * The passes of `manageHistoryLength()` that found a summary being made. Each runs once it is made, so the messages
   * recorded meanwhile get the passes they started.
   * @private
   * @type {number}
   */
  private deferredHistoryPasses: number = 0;

  /**
   * Creates an instance of ConversationContext.
   *
   * @constructor
   * @param {string} [sessionId] - Optional. A specific ID for this conversation session. If not provided, a UUID will be generated.
   * @param {Partial<ConversationContextConfig>} [config={}] - Optional. Configuration overrides for this context. Defaults will be applied.
   * @param {ConversationMessage[]} [initialMessages=[]] - Optional. An array of messages to pre-populate the context.
   * @param {Record<string, any>} [initialMetadata={}] - Optional. Initial key-value metadata for the session.
   */
  constructor(
    sessionId?: string,
    config: Partial<ConversationContextConfig> = {},
    initialMessages: ConversationMessage[] = [],
    initialMetadata: Record<string, any> = {}
  ) {
    this.sessionId = sessionId || `conv_ctx_${uuidv4()}`;
    this.createdAt = Date.now();

    this.messages = initialMessages.map(m => ({
      ...m,
      id: m.id || `msg_${uuidv4()}`,
      timestamp: m.timestamp || Date.now(),
    }));

    const defaultConfig: Required<Omit<ConversationContextConfig, 'utilityAI' | 'userId' | 'gmiInstanceId' | 'activePersonaId'>> & Partial<Pick<ConversationContextConfig, 'utilityAI' | 'userId' | 'gmiInstanceId' | 'activePersonaId'>> = {
      maxHistoryLengthMessages: DEFAULT_MAX_HISTORY_MESSAGES,
      enableAutomaticSummarization: false,
      messagesToKeepVerbatimTail: DEFAULT_VERBATIM_TAIL_COUNT,
      messagesToKeepVerbatimHead: DEFAULT_VERBATIM_HEAD_COUNT,
      summarizationChunkSize: DEFAULT_SUMMARIZATION_CHUNK_SIZE,
      summarizationOptions: { ...DEFAULT_SUMMARIZATION_OPTIONS },
      defaultLanguage: 'en-US',
    };
    
    this.config = {
        ...defaultConfig,
        ...config,
        summarizationOptions: { // Ensure deep merge for nested config objects
            ...defaultConfig.summarizationOptions,
            ...(config.summarizationOptions || {}),
        },
    } as Required<ConversationContextConfig>;
    // The history's cuts index the messages with these settings, so each is read as a whole number of messages, and a
    // setting given as undefined, which the spread above puts in place of its default, keeps the default.
    this.config.maxHistoryLengthMessages = messageCount(this.config.maxHistoryLengthMessages, DEFAULT_MAX_HISTORY_MESSAGES);
    this.config.messagesToKeepVerbatimTail = messageCount(this.config.messagesToKeepVerbatimTail, DEFAULT_VERBATIM_TAIL_COUNT);
    this.config.messagesToKeepVerbatimHead = messageCount(this.config.messagesToKeepVerbatimHead, DEFAULT_VERBATIM_HEAD_COUNT);
    this.config.summarizationChunkSize = messageCount(this.config.summarizationChunkSize, DEFAULT_SUMMARIZATION_CHUNK_SIZE);

    this.utilityAI = this.config.utilityAI; // Use the one from the fully merged config
    this.sessionMetadata = { ...initialMetadata };

    // Set well-known metadata from config if present
    if (this.config.userId) this.sessionMetadata.userId = this.config.userId;
    if (this.config.gmiInstanceId) this.sessionMetadata.gmiInstanceId = this.config.gmiInstanceId;
    if (this.config.activePersonaId) this.sessionMetadata.activePersonaId = this.config.activePersonaId;
    if (this.config.defaultLanguage && !this.sessionMetadata.currentLanguage) {
      this.sessionMetadata.currentLanguage = this.config.defaultLanguage;
    }
    
    this.sessionMetadata['_lastAccessed'] = this.createdAt; // Initialize last accessed time

    if (this.config.enableAutomaticSummarization && !this.utilityAI) {
      console.warn(`ConversationContext (ID: ${this.sessionId}): Automatic summarization is enabled, but no IUtilityAI service was provided. Summarization will be disabled for this context.`);
      // Update the effective configuration for this instance
      (this.config as { -readonly [K in keyof Required<ConversationContextConfig>]: Required<ConversationContextConfig>[K] }).enableAutomaticSummarization = false;
    }
  }

  /**
   * Adds a new message to the conversation history.
   * The message is created using `createConversationMessage` to ensure default fields like `id` and `timestamp` are set.
   * After adding, it asynchronously triggers history management (truncation/summarization).
   *
   * @public
   * @param {Omit<ConversationMessage, 'id' | 'timestamp'>} messageData - The data for the new message, excluding `id` and `timestamp` which will be auto-generated.
   * @returns {Readonly<ConversationMessage>} A readonly version of the newly added message.
   */
  public addMessage(messageData: Omit<ConversationMessage, 'id' | 'timestamp'>): Readonly<ConversationMessage> {
    const newMessage = createConversationMessage(messageData.role, messageData.content, messageData);
    this.messages.push(newMessage);
    this.sessionMetadata['_lastAccessed'] = Date.now();

    // Asynchronously manage history length to avoid blocking the addMessage call.
    this.manageHistoryLength().catch(error => {
      console.error(`ConversationContext (ID: ${this.sessionId}): Error during background history management after adding message:`, error);
      // Fallback to simple truncation if manageHistoryLength fails critically
      if (this.messages.length > this.config.maxHistoryLengthMessages) {
        this.truncateHistorySimple(this.config.maxHistoryLengthMessages);
      }
    });
    return Object.freeze({ ...newMessage });
  }

  /**
   * Retrieves a portion of the conversation history, optionally limited and filtered.
   * Returns readonly copies of the messages to prevent external modification.
   *
   * With `limit`, the newest `limit` messages. Without it, the messages a trim to `maxHistoryLengthMessages` keeps:
   * the first `messagesToKeepVerbatimHead`, the last summary after them, and the newest, `maxHistoryLengthMessages` in
   * all. Providers refuse a tool call without its result and a tool result without its call, so neither cut falls
   * inside a tool round (an assistant message that names tool calls, the tool messages that answer them and anything
   * between): a round the returned messages reach into is returned whole, past the limit when it has to be, as the
   * prompt engine's token trim keeps a round it cannot drop.
   *
   * @public
   * @param {number} [limit] - Optional. The number of recent messages to return, more when the oldest of them is part of a tool round. Without it, the messages a trim to `config.maxHistoryLengthMessages` keeps.
   * @param {MessageRole[]} [excludeRoles] - Optional. An array of message roles to exclude from the returned history. The other messages are the ones counted.
   * @returns {ReadonlyArray<Readonly<ConversationMessage>>} A readonly array of readonly message objects.
   */
  public getHistory(limit?: number, excludeRoles?: MessageRole[]): ReadonlyArray<Readonly<ConversationMessage>> {
    this.sessionMetadata['_lastAccessed'] = Date.now();
    let effectiveMessages = this.messages;
    if (excludeRoles && excludeRoles.length > 0) {
      const rolesToExclude = new Set(excludeRoles);
      effectiveMessages = effectiveMessages.filter(msg => !rolesToExclude.has(msg.role));
    }
    let returned = effectiveMessages;
    if (limit !== undefined && limit > 0) {
      // the newest `limit` messages, from the first message of a tool round they reach into
      const count = Math.floor(limit);
      if (count > 0 && count < effectiveMessages.length) {
        returned = effectiveMessages.slice(toolRoundBounds(effectiveMessages).start[effectiveMessages.length - count]);
      }
    } else if (this.config.maxHistoryLengthMessages > 0) {
      const cuts = this.trimCuts(effectiveMessages, this.config.maxHistoryLengthMessages);
      if (cuts.headEnd < cuts.tailStart) returned = keptByTrim(effectiveMessages, cuts);
    }

    // Ensure both array and its elements are treated as readonly
    return Object.freeze(
        returned.map(m => Object.freeze({ ...m }) as Readonly<ConversationMessage>)
    ) as ReadonlyArray<Readonly<ConversationMessage>>;
  }

  /**
   * Retrieves all messages in the conversation.
   * Returns readonly copies to prevent external modification.
   *
   * @public
   * @returns {ReadonlyArray<Readonly<ConversationMessage>>} A readonly array of all readonly message objects.
   */
  public getAllMessages(): ReadonlyArray<Readonly<ConversationMessage>> {
    this.sessionMetadata['_lastAccessed'] = Date.now();
    return Object.freeze(
        this.messages.map(m => Object.freeze({ ...m }) as Readonly<ConversationMessage>)
    ) as ReadonlyArray<Readonly<ConversationMessage>>;
  }

  /**
   * Retrieves a specific message by its unique ID.
   *
   * @public
   * @param {string} messageId - The ID of the message to retrieve.
   * @returns {Readonly<ConversationMessage> | undefined} A readonly copy of the message if found, otherwise `undefined`.
   */
  public getMessageById(messageId: string): Readonly<ConversationMessage> | undefined {
    this.sessionMetadata['_lastAccessed'] = Date.now();
    const message = this.messages.find(m => m.id === messageId);
    return message ? Object.freeze({ ...message }) : undefined;
  }

  /**
   * Retrieves the most recent message in the conversation.
   *
   * @public
   * @returns {Readonly<ConversationMessage> | undefined} A readonly copy of the last message, or `undefined` if the history is empty.
   */
  public getLastMessage(): Readonly<ConversationMessage> | undefined {
    this.sessionMetadata['_lastAccessed'] = Date.now();
    return this.messages.length > 0 ? Object.freeze({ ...this.messages[this.messages.length - 1] }) : undefined;
  }

  /**
   * Replaces a message's content in place, keeping its id, role and time. For a reply an output guardrail rewrote or
   * replaced after it was stored: the history then holds what the person saw. Metadata given is merged over the
   * message's own. False when no message has the id.
   *
   * @public
   */
  public replaceMessageContent(messageId: string, content: ConversationMessage['content'], metadata?: Partial<NonNullable<ConversationMessage['metadata']>>): boolean {
    const message = this.messages.find(m => m.id === messageId);
    if (!message) return false;
    message.content = content;
    if (metadata) message.metadata = { ...(message.metadata ?? {}), ...metadata };
    this.sessionMetadata['_lastAccessed'] = Date.now();
    return true;
  }

  /**
   * Calculates the current "turn number" based on the count of user messages.
   * This can be a simple proxy for conversation length from the user's perspective.
   *
   * @public
   * @returns {number} The number of messages with `role: MessageRole.USER`.
   */
  public getTurnNumber(): number {
    return this.messages.filter(msg => msg.role === MessageRole.USER).length;
  }

  /**
   * Clears the conversation history, with options to preserve certain messages or metadata.
   *
   * @public
   * @param {object} [options] - Options for clearing the history.
   * @param {boolean} [options.keepMetadata=true] - If true, session metadata is preserved. Otherwise, it's reset to essential defaults.
   * @param {boolean} [options.keepSystemMessages=true] - If true, messages with `role: MessageRole.SYSTEM` are preserved.
   * @param {ConversationMessage[]} [options.messagesToKeep=[]] - An array of specific message objects to preserve.
   * @returns {void}
   */
  public clearHistory(options: { keepMetadata?: boolean; keepSystemMessages?: boolean; messagesToKeep?: ConversationMessage[] } = {}): void {
    const { keepMetadata = true, keepSystemMessages = true, messagesToKeep = [] } = options;
    
    const preservedMessages: ConversationMessage[] = [...messagesToKeep];
    if (keepSystemMessages) {
      this.messages.forEach(m => {
        if (m.role === MessageRole.SYSTEM && !preservedMessages.find(pm => pm.id === m.id)) {
          preservedMessages.push(m);
        }
      });
    }
    // Use a Map to ensure uniqueness by ID if messagesToKeep and system messages overlap
    this.messages = [...new Map(preservedMessages.map(item => [item.id, item])).values()];
    this.messages.sort((a,b) => a.timestamp - b.timestamp); // Ensure messages remain sorted

    if (!keepMetadata) {
      const essentialMetadataKeys = ['userId', 'gmiInstanceId', 'activePersonaId', 'currentLanguage', '_lastAccessed'];
      const newMetadata: Record<string, any> = {};
      for(const key of essentialMetadataKeys) {
          if(this.sessionMetadata[key] !== undefined) {
              newMetadata[key] = this.sessionMetadata[key];
          }
      }
      // Ensure core config-derived metadata is preserved if it was initially set
      if (this.config.userId) newMetadata.userId = this.config.userId;
      if (this.config.gmiInstanceId) newMetadata.gmiInstanceId = this.config.gmiInstanceId;
      if (this.config.activePersonaId) newMetadata.activePersonaId = this.config.activePersonaId;
      if (this.config.defaultLanguage && !newMetadata.currentLanguage) newMetadata.currentLanguage = this.config.defaultLanguage;
      
      this.sessionMetadata = newMetadata;
    }
    this.sessionMetadata['_lastAccessed'] = Date.now();
    console.log(`ConversationContext (ID: ${this.sessionId}): History cleared with options. New message count: ${this.messages.length}. Metadata kept: ${keepMetadata}.`);
  }

  /**
   * Sets a custom metadata key-value pair for the session.
   * If `value` is `undefined`, the key is removed.
   *
   * @public
   * @param {string} key - The metadata key.
   * @param {any} value - The metadata value. Use `undefined` to delete the key.
   * @returns {void}
   */
  public setMetadata(key: string, value: any): void {
    if (value === undefined) {
      delete this.sessionMetadata[key];
    } else {
      this.sessionMetadata[key] = value;
    }
    this.sessionMetadata['_lastAccessed'] = Date.now();
  }

  /**
   * Retrieves a metadata value by its key.
   *
   * @public
   * @param {string} key - The metadata key.
   * @returns {any | undefined} The metadata value, or `undefined` if the key does not exist.
   */
  public getMetadata(key: string): any | undefined {
    return this.sessionMetadata[key];
  }

  /**
   * Retrieves all session metadata as a readonly object.
   *
   * @public
   * @returns {Readonly<Record<string, any>>} A readonly copy of all session metadata.
   */
  public getAllMetadata(): Readonly<Record<string, any>> {
    return Object.freeze({ ...this.sessionMetadata });
  }

  /**
   * Manages the length of the conversation history.
   * If `enableAutomaticSummarization` is true and a `utilityAI` service is available,
   * it attempts to summarize older messages. Otherwise, it falls back to simple truncation.
   * This method is called asynchronously after each new message is added.
   *
   * A summary replaces a chunk of the messages between the first `messagesToKeepVerbatimHead` and the newest
   * `messagesToKeepVerbatimTail`. None of the three ends inside a tool round: a round the head or the tail reaches into
   * stays whole there, and a round the chunk reaches into is summarized whole, past `summarizationChunkSize`. The
   * summary takes the chunk's place, so a message recorded while the summary is made stays after it, and the summary
   * of a history cleared meanwhile is dropped. A history still past its limit with too few messages left for another
   * chunk, the ones recorded meanwhile counted in, is trimmed, and the trim keeps the last summary after the head: this
   * one, unless a conversation loaded from storage holds a later one. One with enough left for another chunk waits for
   * the next pass. A pass that finds a summary being made runs once it is made, so the messages recorded meanwhile,
   * after a clear too, get their passes.
   *
   * @private
   * @async
   * @returns {Promise<void>}
   */
  private async manageHistoryLength(): Promise<void> {
    if (this.messages.length <= this.config.maxHistoryLengthMessages) {
      return; // Already within limits
    }
    if (this.isSummarizing) {
      // A summary is being made: this pass runs once it is made.
      this.deferredHistoryPasses += 1;
      return;
    }

    if (this.config.enableAutomaticSummarization && this.utilityAI) {
      this.isSummarizing = true;
      try {
        const headCount = Math.max(0, this.config.messagesToKeepVerbatimHead);
        const tailCount = Math.max(0, this.config.messagesToKeepVerbatimTail);

        // If keeping head/tail already satisfies max length, or not enough messages to summarize meaningfully
        if (headCount + tailCount >= this.config.maxHistoryLengthMessages || this.messages.length < headCount + tailCount + MIN_MESSAGES_FOR_SUMMARIZATION_ATTEMPT) {
          this.truncateHistorySimple(this.config.maxHistoryLengthMessages);
          return; // Exit after simple truncation
        }
        
        // Ensure there's a middle section to process. It starts after the kept head and ends before the kept tail, each
        // moved to keep a tool round whole.
        const messages = this.messages;
        const rounds = toolRoundBounds(messages);
        const { headEnd: middleSectionStartIndex, tailStart: middleSectionEndIndex } = cutsKeepingToolRounds(messages, headCount, tailCount, rounds);
        if (middleSectionStartIndex >= middleSectionEndIndex) {
             this.truncateHistorySimple(this.config.maxHistoryLengthMessages); // Not enough messages for a middle section
             return;
        }

        const middleSectionLength = middleSectionEndIndex - middleSectionStartIndex;

        if (middleSectionLength >= this.config.summarizationChunkSize && middleSectionLength >= MIN_MESSAGES_FOR_SUMMARIZATION_ATTEMPT) {
          // The chunk ends where its last message's tool round ends. No round crosses the middle section's end, so the
          // chunk stays inside the middle section.
          let chunkEndIndex = middleSectionStartIndex + Math.max(0, this.config.summarizationChunkSize);
          if (chunkEndIndex > middleSectionStartIndex) chunkEndIndex = rounds.end[chunkEndIndex - 1] + 1;
          const messagesToSummarize = messages.slice(middleSectionStartIndex, chunkEndIndex);
          const textToSummarize = messagesToSummarize
            .map(m => `${m.name || m.role}: ${typeof m.content === 'string' ? m.content : (m.tool_calls ? '[Tool Call Invoked]' : '[Structured Content]')}`)
            .join('\n\n');

          const summaryContent = await this.utilityAI.summarize(textToSummarize, this.config.summarizationOptions);

          // A history cleared while the summary was made no longer holds the messages it summarizes.
          if (this.messages !== messages) {
            return;
          }

          const summaryMessageOptions: Partial<Omit<ConversationMessage, "id" | "timestamp" | "role" | "content">> = {
            // timestamp is removed from options, createConversationMessage will set it.
            originalMessagesSummarizedCount: messagesToSummarize.length,
            metadata: {
              source: 'automatic_history_summary',
              modificationInfo: {
                strategy: 'summarized',
                originalMessageCount: messagesToSummarize.length,
              },
              summarizedMessageIds: messagesToSummarize.map(m => m.id),
            } as MessageMetadata, // Cast to MessageMetadata
          };

          const summaryMessage = createConversationMessage(MessageRole.SUMMARY, summaryContent, summaryMessageOptions);

          // The summary takes the chunk's place. While it was made the history could only grow, so the messages after
          // the chunk, with any recorded meanwhile, stay as they are.
          this.messages = [...messages.slice(0, middleSectionStartIndex), summaryMessage, ...messages.slice(chunkEndIndex)];
          console.log(`ConversationContext (ID: ${this.sessionId}): History summarized. New length: ${this.messages.length}.`);

          if (this.messages.length > this.config.maxHistoryLengthMessages) {
            // The messages between the summary and the kept tail, the ones recorded meanwhile counted in. Too few for
            // another chunk are trimmed, and the trim keeps the last summary after the head. Enough for one wait for
            // the next pass: the one the next message starts, or one that found this pass making the summary.
            const remainingMiddleLength =
              cutsKeepingToolRounds(this.messages, headCount, tailCount).tailStart - (middleSectionStartIndex + 1);
            if (remainingMiddleLength < MIN_MESSAGES_FOR_SUMMARIZATION_ATTEMPT || remainingMiddleLength < this.config.summarizationChunkSize) {
              this.truncateHistorySimple(this.config.maxHistoryLengthMessages);
            }
          }
        } else {
          this.truncateHistorySimple(this.config.maxHistoryLengthMessages);
        }
      } catch (error: any) {
        console.error(`ConversationContext (ID: ${this.sessionId}): Summarization failed: ${error.message}. Falling back to simple truncation.`, error);
        this.truncateHistorySimple(this.config.maxHistoryLengthMessages);
      } finally {
        this.isSummarizing = false;
        // The passes that found this one making its summary run now, one after another, on the history as it is: the
        // messages recorded meanwhile, after a clear too, get the passes they started.
        while (this.deferredHistoryPasses > 0) {
          this.deferredHistoryPasses -= 1;
          await this.manageHistoryLength();
        }
      }
    } else {
      this.truncateHistorySimple(this.config.maxHistoryLengthMessages);
    }
  }

  /**
   * Where a trim to `targetMessageCount` messages cuts `messages`: it keeps the first `messagesToKeepVerbatimHead` (at
   * most `targetMessageCount`), the last summary after them, and the newest that fill the rest. The head and the newest
   * keep a tool round they reach into whole. A summary pass puts its summary right after the first messages; a
   * conversation loaded from storage holds each summary where its own time sorts it, after the messages it replaced.
   * The summary stands for messages the trim leaves out, so when it is not among the newest it takes the place of the
   * oldest of them, as long as one of those is still kept. It is neither a call nor a result, so it is kept alone
   * wherever it sits.
   *
   * @private
   */
  private trimCuts(messages: ReadonlyArray<ConversationMessage>, targetMessageCount: number): TrimCuts {
    const headCount = Math.max(0, Math.min(this.config.messagesToKeepVerbatimHead, targetMessageCount));
    const tailCount = Math.max(0, targetMessageCount - headCount);
    if (headCount + tailCount >= messages.length) {
      return { headEnd: messages.length, summaryIndex: -1, tailStart: messages.length };
    }
    const rounds = toolRoundBounds(messages);
    const cuts = cutsKeepingToolRounds(messages, headCount, tailCount, rounds);
    let summaryIndex = -1;
    for (let index = messages.length - 1; index >= cuts.headEnd; index -= 1) {
      if (messages[index].role === MessageRole.SUMMARY) {
        summaryIndex = index;
        break;
      }
    }
    if (tailCount < 2 || summaryIndex < 0 || summaryIndex >= cuts.tailStart) {
      return { ...cuts, summaryIndex: -1 };
    }
    // The summary sits between the head and the newest, so one fewer of the newest is kept. Neither cut moves before
    // the summary: the head's end stays, and the newest start no earlier than before.
    return { ...cutsKeepingToolRounds(messages, headCount, tailCount - 1, rounds), summaryIndex };
  }

  /**
   * Performs simple truncation of message history from the middle: it keeps the first `messagesToKeepVerbatimHead`
   * messages (at most `targetMessageCount`), the last summary after them, and the newest that fill the rest of
   * `targetMessageCount`. The summary stands for messages the trim leaves out, so when it is not among the newest it
   * takes the place of the oldest of them, as long as one of those is still kept.
   *
   * Providers refuse a tool call without its result and a tool result without its call, so neither cut falls inside a
   * tool round (an assistant message that names tool calls, the tool messages that answer them and anything between):
   * a round the kept head or the kept newest messages reach into is kept whole. When keeping it whole passes
   * `targetMessageCount`, the round is kept whole anyway and the history holds more messages, as the prompt engine's
   * token trim (`PromptEngine.truncateMessages`) keeps a round it cannot drop. A round in the head stays; a round the
   * newest messages reach into is left out whole by a later trim, once newer messages fill the rest.
   *
   * @private
   * @param {number} targetMessageCount - The number of messages to keep, passed when a tool round stays whole.
   */
  private truncateHistorySimple(targetMessageCount: number): void {
    if (this.messages.length <= targetMessageCount) {
      return;
    }

    const cuts = this.trimCuts(this.messages, targetMessageCount);
    if (cuts.headEnd < cuts.tailStart) {
      this.messages = keptByTrim(this.messages, cuts);
    }

    console.log(`ConversationContext (ID: ${this.sessionId}): History truncated simply. New length: ${this.messages.length}. Target: ${targetMessageCount}.`);
  }

  /**
   * Serializes the ConversationContext instance to a JSON-compatible object.
   * The `utilityAI` instance itself is not serialized; its ID might be stored if needed for rehydration.
   *
   * @public
   * @returns {object} A plain JavaScript object representing the conversation context.
   */
  public toJSON(): object {
    // Create a copy of config for serialization, excluding the utilityAI instance
    const serializableConfig = { ...this.config };
    delete (serializableConfig as Partial<ConversationContextConfig>).utilityAI; // Remove instance before stringification
    if (this.utilityAI?.utilityId) {
        (serializableConfig as any).utilityAIServiceId = this.utilityAI.utilityId;
    }

    return {
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      messages: this.messages, // Messages are already plain objects
      config: serializableConfig,
      sessionMetadata: this.sessionMetadata,
    };
  }

  /**
   * Deserializes a JSON object (typically from `toJSON()`) back into a `ConversationContext` instance.
   *
   * @public
   * @static
   * @param {any} jsonData - The plain JavaScript object to deserialize.
   * @param {(serviceId?: string) => IUtilityAI | undefined} [utilityAIProvider] - Optional. A function that can provide
   * an `IUtilityAI` instance based on a stored `utilityAIServiceId`. This allows for re-injecting dependencies.
   * @returns {ConversationContext} A new instance of `ConversationContext`.
   * @throws {GMIError} If `jsonData` is invalid or missing essential fields.
   */
  public static fromJSON(jsonData: any, utilityAIProvider?: (serviceId?: string) => IUtilityAI | undefined): ConversationContext {
    if (!jsonData || typeof jsonData.sessionId !== 'string' || !Array.isArray(jsonData.messages) || typeof jsonData.config !== 'object' || jsonData.config === null) {
      throw new GMIError(
        "Invalid JSON data: Missing essential fields (sessionId, messages, config) for ConversationContext deserialization.",
        GMIErrorCode.VALIDATION_ERROR,
        { providedKeys: Object.keys(jsonData || {}).join(', ') }
      );
    }

    let utilityAIInstance: IUtilityAI | undefined = undefined;
    if (utilityAIProvider && jsonData.config.utilityAIServiceId) {
        utilityAIInstance = utilityAIProvider(jsonData.config.utilityAIServiceId);
    } else if (jsonData.config.utilityAIServiceId && !utilityAIProvider) {
        console.warn(`ConversationContext.fromJSON (ID: ${jsonData.sessionId}): Config contained utilityAIServiceId '${jsonData.config.utilityAIServiceId}', but no utilityAIProvider function was given to resolve the instance. Summarization may be unavailable.`);
    }
    
    const configForNewInstance: Partial<ConversationContextConfig> = {
      ...(jsonData.config as Partial<ConversationContextConfig>), // Cast to allow utilityAIServiceId property
      utilityAI: utilityAIInstance,
    };
    // Remove utilityAIServiceId from config object as it's not part of ConversationContextConfig directly
    delete (configForNewInstance as any).utilityAIServiceId;


    const context = new ConversationContext(
      jsonData.sessionId,
      configForNewInstance,
      jsonData.messages as ConversationMessage[], // Assume messages are correctly structured
      jsonData.sessionMetadata || {}
    );

    // Restore read-only properties if they were part of the JSON
    if (typeof jsonData.createdAt === 'number') {
      // This is a bit of a hack to set a readonly property post-construction.
      // It's generally better if all state is reconstructable via constructor or public methods.
      (context as { -readonly [P in 'createdAt']: ConversationContext[P] }).createdAt = jsonData.createdAt;
    }
    return context;
  }

  /**
   * Gets the User ID associated with this conversation context.
   * @public
   * @type {string | undefined}
   */
  public get userId(): string | undefined { return this.sessionMetadata.userId || this.config.userId; }

  /**
   * Gets the GMI Instance ID associated with this conversation context.
   * @public
   * @type {string | undefined}
   */
  public get gmiInstanceId(): string | undefined { return this.sessionMetadata.gmiInstanceId || this.config.gmiInstanceId; }
  
  /**
   * Gets the Active Persona ID associated with this conversation context.
   * @public
   * @type {string | undefined}
   */
  public get activePersonaId(): string | undefined { return this.sessionMetadata.activePersonaId || this.config.activePersonaId; }

  /**
   * Gets the current primary language for the conversation.
   * @public
   * @type {string}
   */
  public get currentLanguage(): string { return this.sessionMetadata.currentLanguage || this.config.defaultLanguage; }
}
