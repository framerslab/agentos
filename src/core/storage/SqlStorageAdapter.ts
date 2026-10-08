/**
 * @file SqlStorageAdapter.ts
 * @description SQL-based storage adapter for AgentOS using @framers/sql-storage-adapter.
 * 
 * This implementation provides a complete persistence layer for conversations and messages
 * using the cross-platform SQL storage adapter. It automatically handles:
 * - Schema creation and migration
 * - CRUD operations for conversations and messages
 * - Transaction support for atomic operations
 * - Cross-platform compatibility (SQLite, PostgreSQL, SQL.js, etc.)
 * 
 * **Architecture:**
 * ```
 * AgentOS ConversationManager
 *          ↓
 *   SqlStorageAdapter (this file)
 *          ↓
 *   @framers/sql-storage-adapter
 *          ↓
 *   Database (SQLite/PostgreSQL/etc.)
 * ```
 * 
 * @version 1.0.0
 * @author AgentOS Team
 * @license MIT
 */

import {
  type StorageAdapter,
  resolveStorageAdapter,
  type StorageResolutionOptions,
} from '@framers/sql-storage-adapter';
import type {
  IStorageAdapter,
  IConversation,
  IConversationMessage,
  IMessageQueryOptions,
  ITokenUsage,
} from './IStorageAdapter.js';

/**
 * Configuration options for the AgentOS SQL storage adapter.
 * 
 * Extends the base storage resolution options with AgentOS-specific settings.
 * 
 * @interface AgentOsSqlStorageConfig
 * @extends {StorageResolutionOptions}
 * @property {boolean} [enableAutoMigration] - Automatically run schema migrations on init
 * @property {number} [messageRetentionDays] - Auto-delete messages older than X days (0 = disabled)
 * 
 * @example
 * ```typescript
 * const config: AgentOsSqlStorageConfig = {
 *   filePath: './agentos.db',
 *   priority: ['better-sqlite3', 'sqljs'],
 *   enableAutoMigration: true,
 *   messageRetentionDays: 90 // Keep 3 months of history
 * };
 * ```
 */
export interface AgentOsSqlStorageConfig extends StorageResolutionOptions {
  enableAutoMigration?: boolean;
  messageRetentionDays?: number;
}

/**
 * SQL storage adapter implementation for AgentOS.
 * 
 * Provides full persistence for conversations and messages using a SQL database.
 * Wraps @framers/sql-storage-adapter to provide AgentOS-specific schema and operations.
 * 
 * **Features:**
 * - Cross-platform SQL support (SQLite, PostgreSQL, SQL.js, Capacitor)
 * - Automatic schema creation and migration
 * - Efficient querying with indexes
 * - Transaction support for atomic operations
 * - Type-safe API with full TypeScript support
 * 
 * **Database Schema:**
 * - `conversations` table: Stores conversation metadata
 * - `messages` table: Stores individual messages with foreign key to conversations
 * - Indexes on frequently queried columns for performance
 * 
 * @class SqlStorageAdapter
 * @implements {IStorageAdapter}
 * 
 * @example
 * ```typescript
 * // Node.js with SQLite
 * const storage = new SqlStorageAdapter({
 *   type: 'better-sqlite3',
 *   database: './data/agentos.db',
 *   enableWAL: true
 * });
 * 
 * await storage.initialize();
 * 
 * // Browser with SQL.js
 * const browserStorage = new SqlStorageAdapter({
 *   type: 'sql.js',
 *   database: 'agentos.db',
 *   enableAutoMigration: true
 * });
 * 
 * await browserStorage.initialize();
 * ```
 */
export class SqlStorageAdapter implements IStorageAdapter {
  private adapter!: StorageAdapter;
  private config: AgentOsSqlStorageConfig;
  private initialized: boolean = false;

  /**
   * Creates a new SQL storage adapter instance.
   * 
   * @param {AgentOsSqlStorageConfig} config - Storage configuration
   * 
   * @example
   * ```typescript
   * const storage = new SqlStorageAdapter({
   *   filePath: './agentos.db',
   *   priority: ['better-sqlite3']
   * });
   * ```
   */
  constructor(config: AgentOsSqlStorageConfig = {}) {
    this.config = {
      enableAutoMigration: true,
      messageRetentionDays: 0,
      ...config,
    };
  }

  /**
   * Initializes the storage adapter and creates the database schema.
   * 
   * **Schema created:**
   * - `conversations` table with indexes on userId and agentId
   * - `messages` table with indexes on conversationId and timestamp
   * - Foreign key constraints for referential integrity
   * 
   * **Must be called before any other operations.**
   * 
   * @returns {Promise<void>}
   * @throws {Error} If database connection or schema creation fails
   * 
   * @example
   * ```typescript
   * await storage.initialize();
   * console.log('Storage ready!');
   * ```
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Resolve the appropriate storage adapter for the platform
    this.adapter = await resolveStorageAdapter(this.config);

    // Create conversations table
    await this.adapter.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        agentId TEXT,
        createdAt INTEGER NOT NULL,
        lastActivity INTEGER NOT NULL,
        title TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_userId ON conversations(userId);
      CREATE INDEX IF NOT EXISTS idx_conversations_agentId ON conversations(agentId);
      CREATE INDEX IF NOT EXISTS idx_conversations_lastActivity ON conversations(lastActivity);
    `);

    // Create messages table with foreign key
    await this.adapter.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        model TEXT,
        promptTokens INTEGER,
        completionTokens INTEGER,
        totalTokens INTEGER,
        cacheReadTokens INTEGER,
        cacheCreationTokens INTEGER,
        toolCalls TEXT,
        toolCallId TEXT,
        name TEXT,
        metadata TEXT,
        FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversationId ON messages(conversationId);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
    `);

    // Back-compat migration: add cacheReadTokens / cacheCreationTokens
    // columns on pre-existing databases. CREATE TABLE IF NOT EXISTS
    // above only helps on fresh DBs; on DBs that predate this field
    // set the table already exists and the new columns never land
    // without an explicit ALTER. Swallow the duplicate-column error
    // because neither SQLite nor Postgres has portable IF NOT EXISTS
    // on ADD COLUMN (Postgres does; SQLite does not until 3.35).
    //
    // Both columns are read first and the ALTERs run only when that read
    // fails. On Postgres an ALTER TABLE takes an ACCESS EXCLUSIVE lock even
    // when the column exists; the lock waits behind every open reader of
    // the table (a pg_dump reads it for its whole run) and later queries
    // queue behind it.
    let hasCacheTokenColumns = false;
    try {
      await this.adapter.get('SELECT cacheReadTokens, cacheCreationTokens FROM messages LIMIT 0');
      hasCacheTokenColumns = true;
    } catch {
      // At least one column is missing: add them below.
    }
    if (!hasCacheTokenColumns) {
      for (const col of ['cacheReadTokens', 'cacheCreationTokens']) {
        try {
          await this.adapter.exec(`ALTER TABLE messages ADD COLUMN ${col} INTEGER;`);
        } catch {
          // The column already exists (the other one was the missing one).
        }
      }
    }

    this.initialized = true;
  }

  /**
   * Closes the database connection and releases resources.
   * 
   * @returns {Promise<void>}
   * 
   * @example
   * ```typescript
   * await storage.close();
   * ```
   */
  async close(): Promise<void> {
    await this.adapter.close();
    this.initialized = false;
  }

  // ==================== Conversation Operations ====================

  /**
   * Creates a new conversation record.
   * 
   * @param {IConversation} conversation - Conversation to create
   * @returns {Promise<IConversation>} The created conversation
   * @throws {Error} If conversation with same ID exists or validation fails
   */
  async createConversation(conversation: IConversation): Promise<IConversation> {
    this.ensureInitialized();

    const metadataJson = conversation.metadata ? JSON.stringify(conversation.metadata) : null;

    await this.adapter.run(
      `INSERT INTO conversations (id, userId, agentId, createdAt, lastActivity, title, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        conversation.id,
        conversation.userId,
        conversation.agentId || null,
        conversation.createdAt,
        conversation.lastActivity,
        conversation.title || null,
        metadataJson,
      ]
    );

    return conversation;
  }

  /**
   * Retrieves a conversation by ID.
   * 
   * @param {string} conversationId - The conversation ID
   * @returns {Promise<IConversation | null>} The conversation or null if not found
   */
  async getConversation(conversationId: string): Promise<IConversation | null> {
    this.ensureInitialized();

    const row = await this.adapter.get<any>(
      'SELECT * FROM conversations WHERE id = ?',
      [conversationId]
    );

    if (!row) {
      return null;
    }

    return this.rowToConversation(row);
  }

  /**
   * Updates a conversation's fields.
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

    const existing = await this.getConversation(conversationId);
    if (!existing) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const updated = { ...existing, ...updates };
    const metadataJson = updated.metadata ? JSON.stringify(updated.metadata) : null;

    await this.adapter.run(
      `UPDATE conversations 
       SET userId = ?, agentId = ?, createdAt = ?, lastActivity = ?, title = ?, metadata = ?
       WHERE id = ?`,
      [
        updated.userId,
        updated.agentId || null,
        updated.createdAt,
        updated.lastActivity,
        updated.title || null,
        metadataJson,
        conversationId,
      ]
    );

    return updated;
  }

  /**
   * Deletes a conversation and all its messages.
   * 
   * @param {string} conversationId - Conversation to delete
   * @returns {Promise<boolean>} True if deleted, false if not found
   */
  async deleteConversation(conversationId: string): Promise<boolean> {
    this.ensureInitialized();

    const result = await this.adapter.run(
      'DELETE FROM conversations WHERE id = ?',
      [conversationId]
    );

    return result.changes > 0;
  }

  /**
   * Lists conversations for a user with optional filtering.
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

    let query = 'SELECT * FROM conversations WHERE userId = ?';
    const params: any[] = [userId];

    if (options?.agentId) {
      query += ' AND agentId = ?';
      params.push(options.agentId);
    }

    query += ' ORDER BY lastActivity DESC';

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const rows = await this.adapter.all<any>(query, params);
    return rows.map((row: any) => this.rowToConversation(row));
  }

  // ==================== Message Operations ====================

  /**
   * Stores a message and updates conversation's lastActivity.
   * 
   * @param {IConversationMessage} message - Message to store
   * @returns {Promise<IConversationMessage>} The stored message
   * @throws {Error} If conversation doesn't exist
   */
  async storeMessage(message: IConversationMessage): Promise<IConversationMessage> {
    this.ensureInitialized();

    // Verify conversation exists
    const conversation = await this.getConversation(message.conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${message.conversationId}`);
    }

    const toolCallsJson = message.toolCalls ? JSON.stringify(message.toolCalls) : null;
    const metadataJson = message.metadata ? JSON.stringify(message.metadata) : null;

    // Insert message
    await this.adapter.run(
      `INSERT INTO messages
       (id, conversationId, role, content, timestamp, model, promptTokens, completionTokens, totalTokens, cacheReadTokens, cacheCreationTokens, toolCalls, toolCallId, name, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.conversationId,
        message.role,
        message.content,
        message.timestamp,
        message.model || null,
        message.usage?.promptTokens || null,
        message.usage?.completionTokens || null,
        message.usage?.totalTokens || null,
        // Persist cache-token counters when the caller reports them so
        // getConversationTokenUsage can SUM a full cache picture later.
        // Null when undefined — distinguishes "provider did not report"
        // from a genuine zero.
        message.usage?.cacheReadTokens ?? null,
        message.usage?.cacheCreationTokens ?? null,
        toolCallsJson,
        message.toolCallId || null,
        message.name || null,
        metadataJson,
      ]
    );

    // Update conversation lastActivity
    await this.adapter.run(
      'UPDATE conversations SET lastActivity = ? WHERE id = ?',
      [message.timestamp, message.conversationId]
    );

    return message;
  }

  /**
   * Retrieves a message by ID.
   * 
   * @param {string} messageId - Message ID
   * @returns {Promise<IConversationMessage | null>} The message or null
   */
  async getMessage(messageId: string): Promise<IConversationMessage | null> {
    this.ensureInitialized();

    const row = await this.adapter.get<any>('SELECT * FROM messages WHERE id = ?', [messageId]);

    if (!row) {
      return null;
    }

    return this.rowToMessage(row);
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

    let query = 'SELECT * FROM messages WHERE conversationId = ?';
    const params: any[] = [conversationId];

    if (options?.since) {
      query += ' AND timestamp >= ?';
      params.push(options.since);
    }

    if (options?.until) {
      query += ' AND timestamp <= ?';
      params.push(options.until);
    }

    if (options?.roles && options.roles.length > 0) {
      const placeholders = options.roles.map(() => '?').join(',');
      query += ` AND role IN (${placeholders})`;
      params.push(...options.roles);
    }

    const order = options?.order === 'desc' ? 'DESC' : 'ASC';
    query += ` ORDER BY timestamp ${order}`;

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const rows = await this.adapter.all<any>(query, params);
    return rows.map((row: any) => this.rowToMessage(row));
  }

  /**
   * Deletes a specific message.
   * 
   * @param {string} messageId - Message to delete
   * @returns {Promise<boolean>} True if deleted
   */
  async deleteMessage(messageId: string): Promise<boolean> {
    this.ensureInitialized();

    const result = await this.adapter.run('DELETE FROM messages WHERE id = ?', [messageId]);
    return result.changes > 0;
  }

  /**
   * Deletes all messages in a conversation.
   * 
   * @param {string} conversationId - Conversation whose messages to delete
   * @returns {Promise<number>} Number of messages deleted
   */
  async deleteMessagesForConversation(conversationId: string): Promise<number> {
    this.ensureInitialized();

    const result = await this.adapter.run('DELETE FROM messages WHERE conversationId = ?', [
      conversationId,
    ]);

    return result.changes;
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

    const row = await this.adapter.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM messages WHERE conversationId = ?',
      [conversationId]
    );

    return row?.count || 0;
  }

  /**
   * Calculates total token usage for a conversation.
   * 
   * @param {string} conversationId - Conversation to analyze
   * @returns {Promise<ITokenUsage>} Aggregated token usage
   */
  async getConversationTokenUsage(conversationId: string): Promise<ITokenUsage> {
    this.ensureInitialized();

    const row = await this.adapter.get<any>(
      `SELECT
        SUM(promptTokens) as promptTokens,
        SUM(completionTokens) as completionTokens,
        SUM(totalTokens) as totalTokens,
        SUM(cacheReadTokens) as cacheReadTokens,
        SUM(cacheCreationTokens) as cacheCreationTokens,
        COUNT(cacheReadTokens) as cacheReadCount,
        COUNT(cacheCreationTokens) as cacheCreationCount
       FROM messages
       WHERE conversationId = ?`,
      [conversationId]
    );

    const usage: ITokenUsage = {
      promptTokens: row?.promptTokens || 0,
      completionTokens: row?.completionTokens || 0,
      totalTokens: row?.totalTokens || 0,
    };
    // COUNT returns the number of non-NULL rows; when nothing recorded
    // cache metrics, SUM collapses to NULL / 0 but the count is also 0.
    // We only populate the optional cache fields when at least one
    // message carried a value, preserving the "not reported" signal
    // on cache-silent providers (e.g. OpenAI).
    if (row?.cacheReadCount && Number(row.cacheReadCount) > 0) {
      usage.cacheReadTokens = Number(row.cacheReadTokens) || 0;
    }
    if (row?.cacheCreationCount && Number(row.cacheCreationCount) > 0) {
      usage.cacheCreationTokens = Number(row.cacheCreationTokens) || 0;
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
      throw new Error('SqlStorageAdapter not initialized. Call initialize() first.');
    }
  }

  /**
   * Converts a database row to an IConversation object.
   * 
   * @private
   * @param {any} row - Database row
   * @returns {IConversation} Conversation object
   */
  private rowToConversation(row: any): IConversation {
    return {
      id: row.id,
      userId: row.userId,
      agentId: row.agentId || undefined,
      createdAt: row.createdAt,
      lastActivity: row.lastActivity,
      title: row.title || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  /**
   * Converts a database row to an IConversationMessage object.
   * 
   * @private
   * @param {any} row - Database row
   * @returns {IConversationMessage} Message object
   */
  private rowToMessage(row: any): IConversationMessage {
    const message: IConversationMessage = {
      id: row.id,
      conversationId: row.conversationId,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
    };

    if (row.model) message.model = row.model;
    if (
      row.promptTokens ||
      row.completionTokens ||
      row.totalTokens ||
      row.cacheReadTokens != null ||
      row.cacheCreationTokens != null
    ) {
      message.usage = {
        promptTokens: row.promptTokens || 0,
        completionTokens: row.completionTokens || 0,
        totalTokens: row.totalTokens || 0,
      };
      // Only set cache fields when the row actually stored a value so
      // callers retain "not reported" vs "zero hits" distinction.
      if (row.cacheReadTokens != null) message.usage.cacheReadTokens = row.cacheReadTokens;
      if (row.cacheCreationTokens != null) message.usage.cacheCreationTokens = row.cacheCreationTokens;
    }
    if (row.toolCalls) message.toolCalls = JSON.parse(row.toolCalls);
    if (row.toolCallId) message.toolCallId = row.toolCallId;
    if (row.name) message.name = row.name;
    if (row.metadata) message.metadata = JSON.parse(row.metadata);

    return message;
  }
}
