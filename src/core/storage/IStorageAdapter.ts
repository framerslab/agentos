/**
 * @file IStorageAdapter.ts
 * @description Core storage abstraction interface for AgentOS persistence layer.
 * 
 * This module defines the contract that storage implementations must fulfill to provide
 * persistence capabilities for conversations, messages, user data, and agent state.
 * 
 * The storage layer is designed to be:
 * - **Platform-agnostic**: Works in Node.js, browsers, Electron, mobile (Capacitor)
 * - **Swappable**: Can switch between SQLite, PostgreSQL, in-memory, etc.
 * - **Type-safe**: Full TypeScript support with strict typing
 * - **Async-first**: All operations return Promises for non-blocking I/O
 * 
 * @version 1.0.0
 * @author AgentOS Team
 * @license Apache-2.0
 */

/**
 * Represents a stored conversation with metadata.
 * 
 * @interface IConversation
 * @property {string} id - Unique identifier for the conversation (UUID recommended)
 * @property {string} userId - User who owns this conversation
 * @property {string} [agentId] - Optional agent ID if conversation is tied to specific agent
 * @property {number} createdAt - Unix timestamp (milliseconds) when conversation was created
 * @property {number} lastActivity - Unix timestamp (milliseconds) of last message in conversation
 * @property {string} [title] - Optional human-readable title for the conversation
 * @property {Record<string, any>} [metadata] - Arbitrary metadata object for extensibility
 * 
 * @example
 * ```typescript
 * const conversation: IConversation = {
 *   id: 'conv-123',
 *   userId: 'user-456',
 *   agentId: 'agent-coding',
 *   createdAt: Date.now(),
 *   lastActivity: Date.now(),
 *   title: 'Build a React component',
 *   metadata: { tags: ['coding', 'react'], starred: true }
 * };
 * ```
 */
export interface IConversation {
  id: string;
  userId: string;
  agentId?: string;
  createdAt: number;
  lastActivity: number;
  title?: string;
  metadata?: Record<string, any>;
}

/**
 * Represents a single message within a conversation.
 * 
 * Follows OpenAI's chat completion message format for compatibility with LLM providers.
 * 
 * @interface IConversationMessage
 * @property {string} id - Unique identifier for the message
 * @property {string} conversationId - ID of the conversation this message belongs to
 * @property {'user' | 'assistant' | 'system' | 'tool'} role - Message role in conversation
 * @property {string} content - The text content of the message
 * @property {number} timestamp - Unix timestamp (milliseconds) when message was created
 * @property {string} [model] - LLM model used to generate this message (for assistant messages)
 * @property {ITokenUsage} [usage] - Token usage statistics for this message
 * @property {any[]} [toolCalls] - Tool/function calls made in this message
 * @property {string} [toolCallId] - ID linking this message to a tool call response
 * @property {string} [name] - Name field for tool/function messages
 * @property {Record<string, any>} [metadata] - Additional metadata for extensibility
 * 
 * @example
 * ```typescript
 * const userMessage: IConversationMessage = {
 *   id: 'msg-001',
 *   conversationId: 'conv-123',
 *   role: 'user',
 *   content: 'What is TypeScript?',
 *   timestamp: Date.now()
 * };
 * 
 * const assistantMessage: IConversationMessage = {
 *   id: 'msg-002',
 *   conversationId: 'conv-123',
 *   role: 'assistant',
 *   content: 'TypeScript is a typed superset of JavaScript...',
 *   timestamp: Date.now(),
 *   model: 'gpt-4o',
 *   usage: { promptTokens: 10, completionTokens: 50, totalTokens: 60 }
 * };
 * ```
 */
export interface IConversationMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  model?: string;
  usage?: ITokenUsage;
  toolCalls?: any[];
  toolCallId?: string;
  name?: string;
  metadata?: Record<string, any>;
}

/**
 * Token usage statistics for LLM API calls.
 * 
 * @interface ITokenUsage
 * @property {number} promptTokens - Number of tokens in the prompt (input)
 * @property {number} completionTokens - Number of tokens in the completion (output)
 * @property {number} totalTokens - Total tokens used (prompt + completion)
 * 
 * @example
 * ```typescript
 * const usage: ITokenUsage = {
 *   promptTokens: 150,
 *   completionTokens: 75,
 *   totalTokens: 225
 * };
 * ```
 */
export interface ITokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Tokens served from the provider's prompt-prefix cache (Anthropic
   * `cache_read_input_tokens`). Optional — undefined when no aggregated
   * message reported cache activity, so consumers can distinguish
   * "provider did not report" from "zero hits".
   */
  cacheReadTokens?: number;
  /**
   * Tokens written to the provider's prompt-prefix cache as a new entry
   * (Anthropic `cache_creation_input_tokens`). Same undefined-vs-zero
   * convention as `cacheReadTokens`.
   */
  cacheCreationTokens?: number;
}

/**
 * Options for querying conversation messages with filtering and pagination.
 * 
 * @interface IMessageQueryOptions
 * @property {number} [limit] - Maximum number of messages to return
 * @property {number} [offset] - Number of messages to skip (for pagination)
 * @property {number} [since] - Only return messages created after this timestamp
 * @property {number} [until] - Only return messages created before this timestamp
 * @property {('user' | 'assistant' | 'system' | 'tool')[]} [roles] - Filter by message roles
 * @property {'asc' | 'desc'} [order] - Sort order by timestamp (default: 'asc')
 * 
 * @example
 * ```typescript
 * // Get last 50 assistant messages
 * const options: IMessageQueryOptions = {
 *   limit: 50,
 *   roles: ['assistant'],
 *   order: 'desc'
 * };
 * 
 * // Get messages from last hour
 * const recentOptions: IMessageQueryOptions = {
 *   since: Date.now() - (60 * 60 * 1000)
 * };
 * ```
 */
export interface IMessageQueryOptions {
  limit?: number;
  offset?: number;
  since?: number;
  until?: number;
  roles?: ('user' | 'assistant' | 'system' | 'tool')[];
  order?: 'asc' | 'desc';
}

/**
 * Core storage adapter interface for AgentOS persistence.
 * 
 * Implementations of this interface provide the actual storage mechanism
 * (SQL database, NoSQL, in-memory, etc.) while AgentOS remains storage-agnostic.
 * 
 * **Design Principles:**
 * - All methods are async for non-blocking I/O
 * - Returns null when entities don't exist (not throwing errors)
 * - Uses strong typing for compile-time safety
 * - Supports transaction-like batch operations
 * - Designed for multi-user scenarios (userId scoping)
 * 
 * **Lifecycle:**
 * 1. Instantiate adapter with configuration
 * 2. Call `initialize()` to set up database/schema
 * 3. Use CRUD operations during runtime
 * 4. Call `close()` when shutting down (optional cleanup)
 * 
 * @interface IStorageAdapter
 * 
 * @example
 * ```typescript
 * // Example implementation instantiation
 * const storage: IStorageAdapter = new SqlStorageAdapter({
 *   type: 'better-sqlite3',
 *   database: './agentos.db'
 * });
 * 
 * await storage.initialize();
 * 
 * // Create conversation
 * const conversation = await storage.createConversation({
 *   id: 'conv-123',
 *   userId: 'user-456',
 *   createdAt: Date.now(),
 *   lastActivity: Date.now()
 * });
 * 
 * // Store message
 * await storage.storeMessage({
 *   id: 'msg-001',
 *   conversationId: 'conv-123',
 *   role: 'user',
 *   content: 'Hello!',
 *   timestamp: Date.now()
 * });
 * 
 * // Query messages
 * const messages = await storage.getMessages('conv-123', { limit: 10 });
 * ```
 */
export interface IStorageAdapter {
  /**
   * Initializes the storage adapter.
   * 
   * This should:
   * - Establish database connections
   * - Create necessary tables/schemas if they don't exist
   * - Run migrations if needed
   * - Validate configuration
   * 
   * **Must be called before any other methods.**
   * 
   * @returns {Promise<void>} Resolves when initialization is complete
   * @throws {Error} If initialization fails (connection errors, invalid config, etc.)
   * 
   * @example
   * ```typescript
   * const storage = new SqlStorageAdapter(config);
   * await storage.initialize(); // Sets up database schema
   * ```
   */
  initialize(): Promise<void>;

  /**
   * Closes the storage adapter and releases resources.
   * 
   * This should:
   * - Close database connections
   * - Flush any pending writes
   * - Clean up temporary resources
   * 
   * **Call during application shutdown for graceful cleanup.**
   * 
   * @returns {Promise<void>} Resolves when cleanup is complete
   * 
   * @example
   * ```typescript
   * process.on('SIGTERM', async () => {
   *   await storage.close();
   *   process.exit(0);
   * });
   * ```
   */
  close(): Promise<void>;

  // ==================== Conversation Operations ====================

  /**
   * Creates a new conversation record.
   * 
   * @param {IConversation} conversation - The conversation object to create
   * @returns {Promise<IConversation>} The created conversation (may include defaults)
   * @throws {Error} If conversation with same ID already exists or validation fails
   * 
   * @example
   * ```typescript
   * const conversation = await storage.createConversation({
   *   id: uuidv4(),
   *   userId: 'user-123',
   *   agentId: 'agent-coding',
   *   createdAt: Date.now(),
   *   lastActivity: Date.now(),
   *   title: 'New coding project'
   * });
   * ```
   */
  createConversation(conversation: IConversation): Promise<IConversation>;

  /**
   * Retrieves a conversation by its ID.
   * 
   * @param {string} conversationId - The unique conversation identifier
   * @returns {Promise<IConversation | null>} The conversation or null if not found
   * 
   * @example
   * ```typescript
   * const conv = await storage.getConversation('conv-123');
   * if (conv) {
   *   console.log('Found:', conv.title);
   * }
   * ```
   */
  getConversation(conversationId: string): Promise<IConversation | null>;

  /**
   * Updates an existing conversation's metadata.
   * 
   * Only provided fields will be updated. Omitted fields remain unchanged.
   * 
   * @param {string} conversationId - The conversation to update
   * @param {Partial<IConversation>} updates - Fields to update
   * @returns {Promise<IConversation>} The updated conversation
   * @throws {Error} If conversation doesn't exist
   * 
   * @example
   * ```typescript
   * // Update title and last activity
   * const updated = await storage.updateConversation('conv-123', {
   *   title: 'Renamed conversation',
   *   lastActivity: Date.now()
   * });
   * ```
   */
  updateConversation(conversationId: string, updates: Partial<IConversation>): Promise<IConversation>;

  /**
   * Deletes a conversation and all its messages.
   * 
   * **Warning:** This is a destructive operation that cannot be undone.
   * Consider implementing soft deletes in production.
   * 
   * @param {string} conversationId - The conversation to delete
   * @returns {Promise<boolean>} True if deleted, false if not found
   * 
   * @example
   * ```typescript
   * const deleted = await storage.deleteConversation('conv-123');
   * if (deleted) {
   *   console.log('Conversation deleted successfully');
   * }
   * ```
   */
  deleteConversation(conversationId: string): Promise<boolean>;

  /**
   * Lists all conversations for a specific user.
   * 
   * Results are typically ordered by lastActivity (most recent first).
   * 
   * @param {string} userId - The user whose conversations to retrieve
   * @param {Object} [options] - Optional filtering/pagination
   * @param {number} [options.limit] - Maximum conversations to return
   * @param {number} [options.offset] - Number of conversations to skip
   * @param {string} [options.agentId] - Filter by specific agent
   * @returns {Promise<IConversation[]>} Array of conversations
   * 
   * @example
   * ```typescript
   * // Get user's 20 most recent conversations
   * const conversations = await storage.listConversations('user-123', {
   *   limit: 20
   * });
   * 
   * // Get conversations for specific agent
   * const codingConvs = await storage.listConversations('user-123', {
   *   agentId: 'agent-coding'
   * });
   * ```
   */
  listConversations(
    userId: string,
    options?: { limit?: number; offset?: number; agentId?: string }
  ): Promise<IConversation[]>;

  // ==================== Message Operations ====================

  /**
   * Stores a new message in a conversation.
   * 
   * **Note:** This also updates the parent conversation's `lastActivity` timestamp.
   * 
   * @param {IConversationMessage} message - The message to store
   * @returns {Promise<IConversationMessage>} The stored message
   * @throws {Error} If conversation doesn't exist, a message with the same ID is
   *   already stored, or validation fails
   * 
   * @example
   * ```typescript
   * await storage.storeMessage({
   *   id: uuidv4(),
   *   conversationId: 'conv-123',
   *   role: 'user',
   *   content: 'Explain async/await',
   *   timestamp: Date.now()
   * });
   * ```
   */
  storeMessage(message: IConversationMessage): Promise<IConversationMessage>;

  /**
   * Retrieves a single message by its ID.
   * 
   * @param {string} messageId - The unique message identifier
   * @returns {Promise<IConversationMessage | null>} The message or null if not found
   * 
   * @example
   * ```typescript
   * const msg = await storage.getMessage('msg-456');
   * if (msg) {
   *   console.log(`[${msg.role}]: ${msg.content}`);
   * }
   * ```
   */
  getMessage(messageId: string): Promise<IConversationMessage | null>;

  /**
   * Retrieves all messages for a conversation with optional filtering.
   * 
   * This is the primary method for loading conversation history.
   * 
   * @param {string} conversationId - The conversation to query
   * @param {IMessageQueryOptions} [options] - Query options for filtering/pagination
   * @returns {Promise<IConversationMessage[]>} Array of messages matching criteria
   * 
   * @example
   * ```typescript
   * // Get all messages (oldest first)
   * const allMessages = await storage.getMessages('conv-123');
   * 
   * // Get last 50 messages (newest first)
   * const recent = await storage.getMessages('conv-123', {
   *   limit: 50,
   *   order: 'desc'
   * });
   * 
   * // Get only assistant responses from last hour
   * const assistantRecent = await storage.getMessages('conv-123', {
   *   roles: ['assistant'],
   *   since: Date.now() - 3600000
   * });
   * ```
   */
  getMessages(conversationId: string, options?: IMessageQueryOptions): Promise<IConversationMessage[]>;

  /**
   * Deletes a specific message.
   * 
   * **Note:** This does NOT update the conversation's lastActivity timestamp.
   * 
   * @param {string} messageId - The message to delete
   * @returns {Promise<boolean>} True if deleted, false if not found
   * 
   * @example
   * ```typescript
   * const deleted = await storage.deleteMessage('msg-456');
   * ```
   */
  deleteMessage(messageId: string): Promise<boolean>;

  /**
   * Deletes all messages in a conversation.
   * 
   * **Warning:** Destructive operation. Consider soft deletes in production.
   * 
   * @param {string} conversationId - The conversation whose messages to delete
   * @returns {Promise<number>} Number of messages deleted
   * 
   * @example
   * ```typescript
   * const deletedCount = await storage.deleteMessagesForConversation('conv-123');
   * console.log(`Deleted ${deletedCount} messages`);
   * ```
   */
  deleteMessagesForConversation(conversationId: string): Promise<number>;

  // ==================== Analytics & Utilities ====================

  /**
   * Counts total messages in a conversation.
   * 
   * Useful for pagination and UI indicators.
   * 
   * @param {string} conversationId - The conversation to count
   * @returns {Promise<number>} Total message count
   * 
   * @example
   * ```typescript
   * const count = await storage.getMessageCount('conv-123');
   * console.log(`This conversation has ${count} messages`);
   * ```
   */
  getMessageCount(conversationId: string): Promise<number>;

  /**
   * Calculates total token usage for a conversation.
   * 
   * Sums up all message usage statistics.
   * 
   * @param {string} conversationId - The conversation to analyze
   * @returns {Promise<ITokenUsage>} Aggregated token usage
   * 
   * @example
   * ```typescript
   * const usage = await storage.getConversationTokenUsage('conv-123');
   * console.log(`Total tokens: ${usage.totalTokens}`);
   * console.log(`Cost estimate: $${usage.totalTokens * 0.00001}`);
   * ```
   */
  getConversationTokenUsage(conversationId: string): Promise<ITokenUsage>;
}
