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
 * @license Apache-2.0
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
import { CONVERSATION_COLUMNS, MESSAGE_COLUMNS, ensureConversationSchema } from './sqlStorageSchema.js';
import { createLogger, type ILogger } from '../logging/index.js';

/** Milliseconds in a day, for `messageRetentionDays`. */
const DAY_MS = 86_400_000;

/**
 * The row limit sent when a caller pages with an offset alone. SQLite reads
 * OFFSET only after a LIMIT (https://www.sqlite.org/lang_select.html), so an
 * offset needs a limit beside it. This one is the largest integer a JavaScript
 * number holds exactly; PostgreSQL reads a LIMIT as a bigint, which holds it too.
 */
const NO_ROW_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * Appends `LIMIT ? OFFSET ?` to a query when the caller asked for a limit, an
 * offset or both, and pushes their values. A missing or zero limit returns every
 * row after the offset.
 */
function pageClause(params: unknown[], limit?: number, offset?: number): string {
  if (!limit && !offset) return '';
  params.push(limit || NO_ROW_LIMIT, offset || 0);
  return ' LIMIT ? OFFSET ?';
}

/**
 * A column, count or sum as a number. PostgreSQL's driver hands back a BIGINT
 * (a millisecond timestamp here, a COUNT, a SUM of INTEGER columns) as a string
 * (https://github.com/brianc/node-pg-types#readme); SQLite hands back numbers.
 * A NULL, such as the SUM of no rows, reads as 0.
 */
function toNumber(value: unknown): number {
  return Number(value) || 0;
}

/**
 * Configuration options for the AgentOS SQL storage adapter.
 * 
 * Extends the base storage resolution options with AgentOS-specific settings.
 * 
 * @interface AgentOsSqlStorageConfig
 * @extends {StorageResolutionOptions}
 * @property {boolean} [enableAutoMigration] - Create the tables and run the schema
 *   migrations in `initialize()` (default true). False leaves the schema to the host.
 * @property {number} [messageRetentionDays] - Delete messages older than this many days,
 *   in `initialize()` and after each stored message (0, the default, keeps every message)
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
 * - Timestamps are milliseconds in BIGINT columns
 * 
 * @class SqlStorageAdapter
 * @implements {IStorageAdapter}
 * 
 * @example
 * ```typescript
 * // Node.js: better-sqlite3, or sql.js when the native module does not load
 * const storage = new SqlStorageAdapter({
 *   filePath: './data/agentos.db',
 *   priority: ['better-sqlite3', 'sqljs'],
 * });
 * await storage.initialize();
 *
 * // PostgreSQL, with the tables in a schema of their own
 * const pgStorage = new SqlStorageAdapter({
 *   priority: ['postgres'],
 *   postgres: { connectionString: process.env.DATABASE_URL },
 *   segment: 'agentos',
 *   messageRetentionDays: 90,
 * });
 * await pgStorage.initialize();
 * ```
 */
export class SqlStorageAdapter implements IStorageAdapter {
  private adapter!: StorageAdapter;
  private config: AgentOsSqlStorageConfig;
  private initialized: boolean = false;
  private logger?: ILogger;

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
   * **Schema created** (unless `enableAutoMigration` is false):
   * - `conversations` table with indexes on userId, agentId and lastActivity
   * - `messages` table with indexes on conversationId, timestamp and role
   * - Foreign key constraints for referential integrity
   * - On PostgreSQL, INTEGER timestamp columns of an older table widened to BIGINT
   *
   * With `messageRetentionDays` set, it then deletes the messages older than that.
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

    if (this.config.enableAutoMigration === false) {
      this.log().debug?.('Schema left to the host', { enableAutoMigration: false });
    } else {
      const { widenedColumns } = await ensureConversationSchema(this.adapter);
      if (widenedColumns > 0) {
        this.log().info('Widened INTEGER timestamp columns to BIGINT', { widenedColumns });
      }
    }

    this.initialized = true;
    await this.deleteExpiredMessages();
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
    // Before initialize() has resolved a database there is nothing to close.
    if (this.adapter) await this.adapter.close();
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
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`,
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
   * Deletes a conversation and all its messages, in one transaction.
   *
   * The messages are deleted by their own statement. The table's
   * `ON DELETE CASCADE` acts only where foreign keys are enforced, and SQLite
   * leaves them off on a connection that does not turn them on
   * (https://www.sqlite.org/foreignkeys.html), as the sql.js, IndexedDB and
   * Capacitor adapters do.
   *
   * @param {string} conversationId - Conversation to delete
   * @returns {Promise<boolean>} True if deleted, false if not found
   */
  async deleteConversation(conversationId: string): Promise<boolean> {
    this.ensureInitialized();

    return this.adapter.transaction(async (trx) => {
      await trx.run('DELETE FROM messages WHERE conversationId = ?', [conversationId]);
      const result = await trx.run('DELETE FROM conversations WHERE id = ?', [conversationId]);
      return result.changes > 0;
    });
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

    let query = `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE userId = ?`;
    const params: any[] = [userId];

    if (options?.agentId) {
      query += ' AND agentId = ?';
      params.push(options.agentId);
    }

    query += ' ORDER BY lastActivity DESC';
    query += pageClause(params, options?.limit, options?.offset);

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
        // Null only when the caller reported no count, so a usage of zero
        // tokens reads back as zero rather than as no usage.
        message.usage?.promptTokens ?? null,
        message.usage?.completionTokens ?? null,
        message.usage?.totalTokens ?? null,
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

    await this.deleteExpiredMessages();
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

    const row = await this.adapter.get<any>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`, [
      messageId,
    ]);

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

    let query = `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversationId = ?`;
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
    query += pageClause(params, options?.limit, options?.offset);

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

    const row = await this.adapter.get<{ count: number | string }>(
      'SELECT COUNT(*) AS "count" FROM messages WHERE conversationId = ?',
      [conversationId]
    );

    return toNumber(row?.count);
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
        SUM(promptTokens) AS "promptTokens",
        SUM(completionTokens) AS "completionTokens",
        SUM(totalTokens) AS "totalTokens",
        SUM(cacheReadTokens) AS "cacheReadTokens",
        SUM(cacheCreationTokens) AS "cacheCreationTokens",
        COUNT(cacheReadTokens) AS "cacheReadCount",
        COUNT(cacheCreationTokens) AS "cacheCreationCount"
       FROM messages
       WHERE conversationId = ?`,
      [conversationId]
    );

    const usage: ITokenUsage = {
      promptTokens: toNumber(row?.promptTokens),
      completionTokens: toNumber(row?.completionTokens),
      totalTokens: toNumber(row?.totalTokens),
    };
    // COUNT returns the number of non-NULL rows; when nothing recorded
    // cache metrics, SUM collapses to NULL / 0 but the count is also 0.
    // We only populate the optional cache fields when at least one
    // message carried a value, preserving the "not reported" signal
    // on cache-silent providers (e.g. OpenAI).
    if (toNumber(row?.cacheReadCount) > 0) {
      usage.cacheReadTokens = toNumber(row?.cacheReadTokens);
    }
    if (toNumber(row?.cacheCreationCount) > 0) {
      usage.cacheCreationTokens = toNumber(row?.cacheCreationTokens);
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

  /** The adapter's logger, made on first use through the host's logger factory. */
  private log(): ILogger {
    return (this.logger ??= createLogger('SqlStorageAdapter'));
  }

  /**
   * Deletes the messages older than `messageRetentionDays`, when it is above 0.
   * Runs in `initialize()` and after each stored message, so a message stored
   * with a timestamp already past the cutoff is deleted at once.
   */
  private async deleteExpiredMessages(): Promise<void> {
    const days = this.config.messageRetentionDays ?? 0;
    if (!(days > 0)) return;
    const cutoff = Date.now() - days * DAY_MS;
    const result = await this.adapter.run('DELETE FROM messages WHERE timestamp < ?', [cutoff]);
    if (result.changes > 0) {
      this.log().debug?.('Deleted expired messages', { deleted: result.changes, retentionDays: days });
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
      createdAt: toNumber(row.createdAt),
      lastActivity: toNumber(row.lastActivity),
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
      timestamp: toNumber(row.timestamp),
    };

    if (row.model) message.model = row.model;
    // A usage is read back when the row stored any count, zero included.
    if (
      row.promptTokens != null ||
      row.completionTokens != null ||
      row.totalTokens != null ||
      row.cacheReadTokens != null ||
      row.cacheCreationTokens != null
    ) {
      message.usage = {
        promptTokens: toNumber(row.promptTokens),
        completionTokens: toNumber(row.completionTokens),
        totalTokens: toNumber(row.totalTokens),
      };
      // Only set cache fields when the row actually stored a value so
      // callers retain "not reported" vs "zero hits" distinction.
      if (row.cacheReadTokens != null) message.usage.cacheReadTokens = toNumber(row.cacheReadTokens);
      if (row.cacheCreationTokens != null) {
        message.usage.cacheCreationTokens = toNumber(row.cacheCreationTokens);
      }
    }
    if (row.toolCalls) message.toolCalls = JSON.parse(row.toolCalls);
    if (row.toolCallId) message.toolCallId = row.toolCallId;
    if (row.name) message.name = row.name;
    if (row.metadata) message.metadata = JSON.parse(row.metadata);

    return message;
  }
}
