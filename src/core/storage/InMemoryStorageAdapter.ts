/**
 * @file InMemoryStorageAdapter.ts
 * @description In-memory storage adapter for AgentOS (testing and non-persistent scenarios).
 * 
 * This implementation stores all data in memory using JavaScript Maps and Arrays.
 * Perfect for:
 * - Unit testing without database setup
 * - Ephemeral sessions that don't need persistence
 * - Development and prototyping
 * - CI/CD pipelines
 * 
 * **Warning:** All data is lost when the process terminates or adapter is closed.
 * 
 * @version 1.0.0
 * @author AgentOS Team
 * @license Apache-2.0
 */

import type {
  IStorageAdapter,
  IConversation,
  IConversationMessage,
  IMessageQueryOptions,
  ITokenUsage,
} from './IStorageAdapter.js';

/**
 * A copy of a JSON value that shares no object with the original. Metadata and
 * tool calls are copied through JSON because that is how SqlStorageAdapter
 * stores them, so both adapters hand back the same values.
 */
function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A conversation that shares no object with the one it was copied from. */
function copyConversation(conversation: IConversation): IConversation {
  const copy: IConversation = { ...conversation };
  if (conversation.metadata !== undefined) copy.metadata = jsonCopy(conversation.metadata);
  return copy;
}

/** A message that shares no object with the one it was copied from. */
function copyMessage(message: IConversationMessage): IConversationMessage {
  const copy: IConversationMessage = { ...message };
  if (message.usage !== undefined) copy.usage = { ...message.usage };
  if (message.toolCalls !== undefined) copy.toolCalls = jsonCopy(message.toolCalls);
  if (message.metadata !== undefined) copy.metadata = jsonCopy(message.metadata);
  return copy;
}

/**
 * In-memory storage adapter for AgentOS.
 * 
 * Provides a complete implementation of IStorageAdapter without any persistence.
 * All data is stored in JavaScript Map and Array structures.
 * 
 * **Use Cases:**
 * - Unit and integration testing
 * - Development environments
 * - Stateless sessions
 * - CI/CD pipelines
 * - Prototyping and demos
 * 
 * **Characteristics:**
 * - Zero setup (no database required)
 * - Extremely fast (no I/O)
 * - Non-persistent (data lost on process exit)
 * - Thread-safe in single-threaded environments
 * 
 * @class InMemoryStorageAdapter
 * @implements {IStorageAdapter}
 * 
 * @example
 * ```typescript
 * // Perfect for testing
 * const storage = new InMemoryStorageAdapter();
 * await storage.initialize();
 * 
 * const conversation = await storage.createConversation({
 *   id: 'test-conv',
 *   userId: 'test-user',
 *   createdAt: Date.now(),
 *   lastActivity: Date.now()
 * });
 * 
 * // No cleanup needed for tests
 * await storage.close();
 * ```
 */
export class InMemoryStorageAdapter implements IStorageAdapter {
  private conversations: Map<string, IConversation> = new Map();
  private messages: Map<string, IConversationMessage> = new Map();
  private messagesByConversation: Map<string, string[]> = new Map();
  private initialized: boolean = false;

  /**
   * Creates a new in-memory storage adapter.
   * 
   * No configuration needed since everything is in memory.
   * 
   * @example
   * ```typescript
   * const storage = new InMemoryStorageAdapter();
   * ```
   */
  constructor() {
    // No config needed for in-memory
  }

  /**
   * Initializes the storage adapter.
   * 
   * For in-memory adapter, this just sets the initialized flag.
   * 
   * @returns {Promise<void>}
   */
  async initialize(): Promise<void> {
    this.initialized = true;
  }

  /**
   * Closes the storage adapter and clears all data.
   * 
   * **Warning:** This deletes all conversations and messages from memory.
   * 
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    this.conversations.clear();
    this.messages.clear();
    this.messagesByConversation.clear();
    this.initialized = false;
  }

  // ==================== Conversation Operations ====================

  /**
   * Creates a new conversation.
   * 
   * @param {IConversation} conversation - Conversation to create
   * @returns {Promise<IConversation>} The created conversation
   * @throws {Error} If conversation with same ID already exists
   */
  async createConversation(conversation: IConversation): Promise<IConversation> {
    this.ensureInitialized();

    if (this.conversations.has(conversation.id)) {
      throw new Error(`Conversation already exists: ${conversation.id}`);
    }

    // The store keeps a copy and hands out copies, so a change the caller makes
    // to either object, its metadata included, never reaches the stored one.
    const stored = copyConversation(conversation);
    this.conversations.set(conversation.id, stored);
    this.messagesByConversation.set(conversation.id, []);

    return copyConversation(stored);
  }

  /**
   * Retrieves a conversation by ID.
   * 
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<IConversation | null>} The conversation or null
   */
  async getConversation(conversationId: string): Promise<IConversation | null> {
    this.ensureInitialized();

    const conversation = this.conversations.get(conversationId);
    return conversation ? copyConversation(conversation) : null;
  }

  /**
   * Updates a conversation.
   * 
   * @param {string} conversationId - Conversation to update
   * @param {Partial<IConversation>} updates - Fields to update
   * @returns {Promise<IConversation>} Updated conversation
   * @throws {Error} If conversation doesn't exist
   */
  async updateConversation(
    conversationId: string,
    updates: Partial<IConversation>
  ): Promise<IConversation> {
    this.ensureInitialized();

    const existing = this.conversations.get(conversationId);
    if (!existing) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const updated = copyConversation({ ...existing, ...updates });
    this.conversations.set(conversationId, updated);

    return copyConversation(updated);
  }

  /**
   * Deletes a conversation and all its messages.
   * 
   * @param {string} conversationId - Conversation to delete
   * @returns {Promise<boolean>} True if deleted, false if not found
   */
  async deleteConversation(conversationId: string): Promise<boolean> {
    this.ensureInitialized();

    const existed = this.conversations.has(conversationId);

    if (existed) {
      // Delete conversation
      this.conversations.delete(conversationId);

      // Delete all messages
      const messageIds = this.messagesByConversation.get(conversationId) || [];
      for (const messageId of messageIds) {
        this.messages.delete(messageId);
      }
      this.messagesByConversation.delete(conversationId);
    }

    return existed;
  }

  /**
   * Lists conversations for a user.
   * 
   * @param {string} userId - User whose conversations to list
   * @param {Object} [options] - Query options
   * @returns {Promise<IConversation[]>} Array of conversations
   */
  async listConversations(
    userId: string,
    options?: { limit?: number; offset?: number; agentId?: string }
  ): Promise<IConversation[]> {
    this.ensureInitialized();

    let conversations = Array.from(this.conversations.values()).filter(
      (conv) => conv.userId === userId
    );

    if (options?.agentId) {
      conversations = conversations.filter((conv) => conv.agentId === options.agentId);
    }

    // Sort by lastActivity descending
    conversations.sort((a, b) => b.lastActivity - a.lastActivity);

    const offset = options?.offset || 0;
    const limit = options?.limit || conversations.length;

    return conversations.slice(offset, offset + limit).map(copyConversation);
  }

  // ==================== Message Operations ====================

  /**
   * Stores a message.
   *
   * @param {IConversationMessage} message - Message to store
   * @returns {Promise<IConversationMessage>} The stored message
   * @throws {Error} If conversation doesn't exist, or a message with the same ID
   *   is already stored (SqlStorageAdapter's primary key refuses it too)
   */
  async storeMessage(message: IConversationMessage): Promise<IConversationMessage> {
    this.ensureInitialized();

    const conversation = this.conversations.get(message.conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${message.conversationId}`);
    }
    if (this.messages.has(message.id)) {
      throw new Error(`Message already exists: ${message.id}`);
    }

    // Store message
    const stored = copyMessage(message);
    this.messages.set(message.id, stored);

    // Add to conversation's message list
    const messageIds = this.messagesByConversation.get(message.conversationId) || [];
    messageIds.push(message.id);
    this.messagesByConversation.set(message.conversationId, messageIds);

    // Update conversation lastActivity
    conversation.lastActivity = message.timestamp;

    return copyMessage(stored);
  }

  /**
   * Retrieves a message by ID.
   * 
   * @param {string} messageId - Message ID
   * @returns {Promise<IConversationMessage | null>} The message or null
   */
  async getMessage(messageId: string): Promise<IConversationMessage | null> {
    this.ensureInitialized();

    const message = this.messages.get(messageId);
    return message ? copyMessage(message) : null;
  }

  /**
   * Retrieves messages for a conversation with filtering.
   * 
   * @param {string} conversationId - Conversation ID
   * @param {IMessageQueryOptions} [options] - Query options
   * @returns {Promise<IConversationMessage[]>} Array of messages
   */
  async getMessages(
    conversationId: string,
    options?: IMessageQueryOptions
  ): Promise<IConversationMessage[]> {
    this.ensureInitialized();

    const messageIds = this.messagesByConversation.get(conversationId) || [];
    let messages = messageIds
      .map((id) => this.messages.get(id))
      .filter((msg): msg is IConversationMessage => msg !== undefined);

    // Apply filters
    if (options?.since) {
      messages = messages.filter((msg) => msg.timestamp >= options.since!);
    }

    if (options?.until) {
      messages = messages.filter((msg) => msg.timestamp <= options.until!);
    }

    if (options?.roles && options.roles.length > 0) {
      messages = messages.filter((msg) => options.roles!.includes(msg.role));
    }

    // Sort
    const order = options?.order === 'desc' ? -1 : 1;
    messages.sort((a, b) => order * (a.timestamp - b.timestamp));

    // Pagination
    const offset = options?.offset || 0;
    const limit = options?.limit || messages.length;

    return messages.slice(offset, offset + limit).map(copyMessage);
  }

  /**
   * Deletes a message.
   * 
   * @param {string} messageId - Message to delete
   * @returns {Promise<boolean>} True if deleted
   */
  async deleteMessage(messageId: string): Promise<boolean> {
    this.ensureInitialized();

    const message = this.messages.get(messageId);
    if (!message) {
      return false;
    }

    // Remove from messages map
    this.messages.delete(messageId);

    // Remove from conversation's message list
    const messageIds = this.messagesByConversation.get(message.conversationId) || [];
    const index = messageIds.indexOf(messageId);
    if (index > -1) {
      messageIds.splice(index, 1);
      this.messagesByConversation.set(message.conversationId, messageIds);
    }

    return true;
  }

  /**
   * Deletes all messages in a conversation.
   * 
   * @param {string} conversationId - Conversation whose messages to delete
   * @returns {Promise<number>} Number of messages deleted
   */
  async deleteMessagesForConversation(conversationId: string): Promise<number> {
    this.ensureInitialized();

    const messageIds = this.messagesByConversation.get(conversationId) || [];
    const count = messageIds.length;

    for (const messageId of messageIds) {
      this.messages.delete(messageId);
    }

    this.messagesByConversation.set(conversationId, []);

    return count;
  }

  // ==================== Analytics & Utilities ====================

  /**
   * Counts messages in a conversation.
   * 
   * @param {string} conversationId - Conversation to count
   * @returns {Promise<number>} Message count
   */
  async getMessageCount(conversationId: string): Promise<number> {
    this.ensureInitialized();

    const messageIds = this.messagesByConversation.get(conversationId) || [];
    return messageIds.length;
  }

  /**
   * Calculates total token usage for a conversation.
   * 
   * @param {string} conversationId - Conversation to analyze
   * @returns {Promise<ITokenUsage>} Aggregated token usage
   */
  async getConversationTokenUsage(conversationId: string): Promise<ITokenUsage> {
    this.ensureInitialized();

    const messageIds = this.messagesByConversation.get(conversationId) || [];
    const messages = messageIds
      .map((id) => this.messages.get(id))
      .filter((msg): msg is IConversationMessage => msg !== undefined);

    const usage: ITokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    for (const message of messages) {
      if (message.usage) {
        usage.promptTokens += message.usage.promptTokens || 0;
        usage.completionTokens += message.usage.completionTokens || 0;
        usage.totalTokens += message.usage.totalTokens || 0;
        // Forward Anthropic prompt-cache metrics when the stored
        // message carries them. Undefined stays undefined — lets
        // consumers distinguish "provider does not report cache" from
        // "zero hits", matching the UsageLedger + generateObject
        // propagation convention.
        if (typeof message.usage.cacheReadTokens === 'number') {
          usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + message.usage.cacheReadTokens;
        }
        if (typeof message.usage.cacheCreationTokens === 'number') {
          usage.cacheCreationTokens =
            (usage.cacheCreationTokens ?? 0) + message.usage.cacheCreationTokens;
        }
      }
    }

    return usage;
  }

  // ==================== Private Helper Methods ====================

  /**
   * Ensures the adapter has been initialized.
   * 
   * @private
   * @throws {Error} If not initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('InMemoryStorageAdapter not initialized. Call initialize() first.');
    }
  }
}
