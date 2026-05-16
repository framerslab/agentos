// File: backend/agentos/core/conversation/ConversationManager.ts
/**
 * @fileoverview Manages the lifecycle of ConversationContext instances in AgentOS.
 * Responsible for creating, retrieving, storing (both in-memory and persistently
 * using sql-storage-adapter), and managing active conversation states. It ensures conversations
 * can be rehydrated and maintained across sessions.
 *
 * @module backend/agentos/core/conversation/ConversationManager
 * @see ./ConversationContext.ts
 * @see ../../ai_utilities/IUtilityAI.ts
 * @see @framers/sql-storage-adapter
 */

import { ConversationContext, ConversationContextConfig } from './ConversationContext';
import { ConversationMessage as InternalConversationMessage, MessageRole, createConversationMessage } from './ConversationMessage';
import { IUtilityAI } from '../../cognition/nlp/ai_utilities/IUtilityAI';
import { uuidv4 } from '../utils/uuid.js';
import { GMIError, GMIErrorCode } from '../utils/errors.js';
import type { StorageAdapter } from '@framers/sql-storage-adapter';

/**
 * Configuration for the ConversationManager.
 * Defines settings for managing conversation contexts, including persistence options.
 *
 * @interface ConversationManagerConfig
 * @property {Partial<ConversationContextConfig>} [defaultConversationContextConfig] - Default configuration for newly created ConversationContext instances.
 * @property {number} [maxActiveConversationsInMemory=1000] - Maximum number of active conversations to keep in memory. LRU eviction may apply.
 * @property {number} [inactivityTimeoutMs=3600000] - Timeout in milliseconds for inactive conversations. If set, a cleanup process
 * might be implemented to evict conversations inactive for this duration. (Currently conceptual)
 * @property {boolean} [persistenceEnabled=true] - Controls whether storage adapter is used for database persistence of conversations.
 * If true, a StorageAdapter instance must be provided during initialization.
 */
export interface ConversationManagerConfig {
  defaultConversationContextConfig?: Partial<ConversationContextConfig>;
  maxActiveConversationsInMemory?: number;
  inactivityTimeoutMs?: number;
  persistenceEnabled?: boolean;
  /**
   * When enabled, persistence becomes append-only:
   * - `conversations` and `conversation_messages` rows are never updated or deleted
   * - new messages are inserted once and subsequent saves are idempotent
   *
   * This is intended to support provenance "sealed" mode / immutability guarantees.
   */
  appendOnlyPersistence?: boolean;
}

/**
 * SQL schema for conversations table (compatible with SQLite, PostgreSQL, IndexedDB)
 */
const CONVERSATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gmi_instance_id TEXT,
  title TEXT,
  language TEXT,
  session_details TEXT DEFAULT '{}',
  is_archived INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  multimodal_data TEXT,
  audio_url TEXT,
  audio_transcript TEXT,
  voice_settings TEXT,
  metadata TEXT DEFAULT '{}',
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_gmi_instance_id ON conversations(gmi_instance_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_id ON conversation_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_timestamp ON conversation_messages(timestamp);
`;

/**
 * @class ConversationManager
 * @description Manages ConversationContext instances for AgentOS, handling their
 * creation, retrieval, in-memory caching, and persistent storage via sql-storage-adapter.
 * This class is vital for maintaining conversational state across user sessions and
 * GMI interactions.
 */
export class ConversationManager {
  /**
   * Configuration for the ConversationManager instance.
   * @private
   * @type {Required<ConversationManagerConfig>}
   */
  private config!: Required<ConversationManagerConfig>;

  /**
   * In-memory cache for active ConversationContext instances.
   * Key: Conversation ID (sessionId of ConversationContext).
   * Value: ConversationContext instance.
   * @private
   * @type {Map<string, ConversationContext>}
   */
  private activeConversations: Map<string, ConversationContext>;

  /**
   * Optional IUtilityAI service instance, passed to ConversationContexts.
   * @private
   * @type {IUtilityAI | undefined}
   */
  private utilityAIService?: IUtilityAI;

  /**
   * Optional StorageAdapter instance for database interaction.
   * @private
   * @type {StorageAdapter | undefined}
   */
  private storageAdapter?: StorageAdapter;

  /**
   * Flag indicating if the manager has been successfully initialized.
   * @private
   * @type {boolean}
   */
  private initialized: boolean = false;

  /**
   * Unique identifier for this ConversationManager instance.
   * @public
   * @readonly
   * @type {string}
   */
  public readonly managerId: string;

  /**
   * Constructs a ConversationManager instance.
   * Initialization via `initialize()` is required before use.
   */
  constructor() {
    this.managerId = `conv-mgr-${uuidv4()}`;
    this.activeConversations = new Map();
  }

  /**
   * Initializes the ConversationManager with its configuration and dependencies.
   * This method sets up persistence if enabled and prepares the manager for operation.
   *
   * @public
   * @async
   * @param {ConversationManagerConfig} config - Configuration for the manager.
   * @param {IUtilityAI} [utilityAIService] - Optional IUtilityAI instance, primarily
   * used by ConversationContext instances for features like summarization.
   * @param {StorageAdapter} [storageAdapter] - Optional storage adapter for database persistence.
   * Required if `config.persistenceEnabled` is true.
   * @returns {Promise<void>} A promise that resolves when initialization is complete.
   * @throws {GMIError} If configuration is invalid or dependencies are missing when required.
   */
  public async initialize(
    config: ConversationManagerConfig,
    utilityAIService?: IUtilityAI,
    storageAdapter?: StorageAdapter
  ): Promise<void> {
    if (this.initialized) {
      console.warn(`ConversationManager (ID: ${this.managerId}) already initialized. Consider if re-initialization is intended and its effects on state.`);
    }

    // Avoid spreading `config` last because `undefined` values would override defaults.
    this.config = {
      defaultConversationContextConfig: config.defaultConversationContextConfig || {},
      maxActiveConversationsInMemory: config.maxActiveConversationsInMemory ?? 1000,
      inactivityTimeoutMs: config.inactivityTimeoutMs ?? 3600000, // 1 hour
      persistenceEnabled: config.persistenceEnabled ?? true, // Default to true
      appendOnlyPersistence: config.appendOnlyPersistence ?? false,
    };

    this.utilityAIService = utilityAIService;
    this.storageAdapter = this.config.persistenceEnabled ? storageAdapter : undefined;

    if (this.config.persistenceEnabled && !this.storageAdapter) {
      console.warn(`ConversationManager (ID: ${this.managerId}): Persistence is enabled in config, but no StorageAdapter was provided. Persistence will be effectively disabled.`);
      this.config.persistenceEnabled = false;
    }

    // Initialize schema if persistence is enabled
    if (this.config.persistenceEnabled && this.storageAdapter) {
      try {
        await this.storageAdapter.exec(CONVERSATIONS_SCHEMA);
        console.log(`ConversationManager (ID: ${this.managerId}): Schema initialized.`);
      } catch (error: any) {
        console.error(`ConversationManager (ID: ${this.managerId}): Failed to initialize schema:`, error);
        throw new GMIError(`Failed to initialize conversation schema.`, GMIErrorCode.DATABASE_ERROR, { underlyingError: error.message });
      }
    }

    this.initialized = true;
    console.log(
      `ConversationManager (ID: ${this.managerId}) initialized. Persistence: ${this.config.persistenceEnabled}. Append-only: ${this.config.appendOnlyPersistence}. Max in-memory: ${this.config.maxActiveConversationsInMemory}.`
    );
  }

  /**
   * Ensures that the manager has been initialized before performing operations.
   * @private
   * @throws {GMIError} If the manager is not initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new GMIError("ConversationManager is not initialized. Call initialize() first.", GMIErrorCode.NOT_INITIALIZED, { managerId: this.managerId });
    }
  }

  /**
   * Creates a new conversation context or retrieves an existing one.
   * If `conversationId` is provided:
   * - Tries to find it in the active (in-memory) cache.
   * - If not in cache and persistence is enabled, tries to load from the database.
   * - If not found in DB or persistence disabled, creates a new context with this ID.
   * If no `conversationId` is provided, a new one is generated.
   * Manages in-memory cache size by evicting the oldest conversation if capacity is reached.
   *
   * @public
   * @async
   * @param {string} [conversationId] - Optional ID of an existing conversation. This ID will also be used as the `ConversationContext.sessionId`.
   * @param {string} [userId] - ID of the user associated with the conversation.
   * @param {string} [gmiInstanceId] - ID of the GMI instance this conversation is for.
   * @param {string} [activePersonaId] - ID of the active persona for the conversation.
   * @param {Record<string, any>} [initialMetadata={}] - Initial metadata for a new conversation.
   * @param {Partial<ConversationContextConfig>} [overrideConfig] - Config overrides for a new context.
   * @returns {Promise<ConversationContext>} The created or retrieved ConversationContext.
   * @throws {GMIError} If essential parameters for creating a new context are missing or if an error occurs.
   */
  public async getOrCreateConversationContext(
    conversationId?: string,
    userId?: string,
    gmiInstanceId?: string,
    activePersonaId?: string,
    initialMetadata: Record<string, any> = {},
    overrideConfig?: Partial<ConversationContextConfig>
  ): Promise<ConversationContext> {
    this.ensureInitialized();
    const effectiveConversationId = conversationId || `conv_${uuidv4()}`;

    const context = this.activeConversations.get(effectiveConversationId);
    if (context) {
      // Update context identifiers if provided and different. These setters should exist on ConversationContext or be handled via setMetadata.
      if (userId && context.getMetadata('userId') !== userId) context.setMetadata('userId', userId);
      if (gmiInstanceId && context.getMetadata('gmiInstanceId') !== gmiInstanceId) context.setMetadata('gmiInstanceId', gmiInstanceId);
      if (activePersonaId && context.getMetadata('activePersonaId') !== activePersonaId) context.setMetadata('activePersonaId', activePersonaId);
      context.setMetadata('_lastAccessed', Date.now());
      return context;
    }

    if (this.config.persistenceEnabled && this.storageAdapter) {
      const loadedContext = await this.loadConversationFromDB(effectiveConversationId);
      if (loadedContext) {
        if (this.activeConversations.size >= this.config.maxActiveConversationsInMemory) {
          await this.evictOldestConversation();
        }
        this.activeConversations.set(effectiveConversationId, loadedContext);
        loadedContext.setMetadata('_lastAccessed', Date.now());
        return loadedContext;
      }
    }

    const contextConfig: ConversationContextConfig = {
      ...this.config.defaultConversationContextConfig,
      userId: userId || this.config.defaultConversationContextConfig?.userId,
      gmiInstanceId: gmiInstanceId || this.config.defaultConversationContextConfig?.gmiInstanceId,
      activePersonaId: activePersonaId || this.config.defaultConversationContextConfig?.activePersonaId,
      utilityAI: this.utilityAIService || this.config.defaultConversationContextConfig?.utilityAI,
      ...(overrideConfig || {}), // Apply overrides
    } as ConversationContextConfig; // Cast as fully required after merging

    const newContext = new ConversationContext(effectiveConversationId, contextConfig, [], initialMetadata);
    newContext.setMetadata('_lastAccessed', Date.now());

    if (this.activeConversations.size >= this.config.maxActiveConversationsInMemory) {
      await this.evictOldestConversation();
    }
    this.activeConversations.set(effectiveConversationId, newContext);

    return newContext;
  }

  /**
   * Retrieves a ConversationContext if present in memory or persistent storage.
   * Returns null when not found.
   */
  public async getConversation(conversationId: string): Promise<ConversationContext | null> {
    this.ensureInitialized();
    const inMemory = this.activeConversations.get(conversationId);
    if (inMemory) {
      return inMemory;
    }
    const loaded = await this.loadConversationFromDB(conversationId);
    return loaded ?? null;
  }

  /**
   * Lists minimal context info for a given session. Currently returns a single entry
   * matching the provided sessionId if found in memory or storage.
   */
  public async listContextsForSession(sessionId: string): Promise<Array<{ sessionId: string; createdAt: number }>> {
    return this.getConversationInfo(sessionId);
  }

  /**
   * Saves a ConversationContext to persistent storage if persistence is enabled.
   * This is called automatically when a context is evicted from memory or during shutdown.
   *
   * @public
   * @async
   * @param {ConversationContext} context - The ConversationContext to save.
   * @throws {GMIError} If the save operation fails.
   */
  public async saveConversation(context: ConversationContext): Promise<void> {
    this.ensureInitialized();
    if (this.config.persistenceEnabled && this.storageAdapter) {
      await this.saveConversationToDB(context);
    }
  }

  /**
   * Deletes a conversation from both memory and persistent storage.
   *
   * @public
   * @async
   * @param {string} conversationId - The ID of the conversation to delete.
   * @throws {GMIError} If the deletion fails.
   */
  public async deleteConversation(conversationId: string): Promise<void> {
    this.ensureInitialized();
    if (this.config.appendOnlyPersistence) {
      throw new GMIError(
        `Conversation deletion is disabled when appendOnlyPersistence is enabled.`,
        GMIErrorCode.METHOD_NOT_SUPPORTED,
        { conversationId, managerId: this.managerId }
      );
    }
    this.activeConversations.delete(conversationId);

    if (this.config.persistenceEnabled && this.storageAdapter) {
      try {
        await this.storageAdapter.run('DELETE FROM conversations WHERE id = ?', [conversationId]);
        // Messages are deleted via CASCADE, but explicit delete for safety
        await this.storageAdapter.run('DELETE FROM conversation_messages WHERE conversation_id = ?', [conversationId]);
      } catch (error: any) {
        console.error(`ConversationManager (ID: ${this.managerId}): Error deleting conversation ${conversationId} from DB:`, error);
        throw new GMIError(`Failed to delete conversation ${conversationId} from database.`, GMIErrorCode.DATABASE_ERROR, { underlyingError: error.message });
      }
    }
  }

  /**
   * Gets basic info about a conversation (ID and creation timestamp).
   * Checks in-memory cache first, then persistent storage if enabled.
   *
   * @public
   * @async
   * @param {string} sessionId - The ID of the conversation.
   * @returns {Promise<Array<{ sessionId: string; createdAt: number }>>} Array with conversation info, or empty if not found.
   */
  public async getConversationInfo(sessionId: string): Promise<Array<{ sessionId: string; createdAt: number }>> {
    this.ensureInitialized();
    const context = this.activeConversations.get(sessionId);
    if (context) {
      return [{ sessionId: context.sessionId, createdAt: context.createdAt }];
    }
    // Optionally, try loading from DB if not in memory to provide info
    if (this.config.persistenceEnabled && this.storageAdapter) {
      try {
        const dbConvo = await this.storageAdapter.get<{ id: string; created_at: number }>(
          'SELECT id, created_at FROM conversations WHERE id = ?',
          [sessionId]
        );
        if (dbConvo) {
          return [{ sessionId: dbConvo.id, createdAt: dbConvo.created_at }];
        }
      } catch (error: any) {
        console.error(`ConversationManager (ID: ${this.managerId}): Error fetching conversation info for ${sessionId}:`, error);
      }
    }
    return [];
  }

  /**
   * Gets the last active time for a conversation, typically the timestamp of the last message or update.
   * Checks in-memory cache first, then persistent storage if enabled.
   *
   * @public
   * @async
   * @param {string} conversationId - The ID of the conversation.
   * @returns {Promise<number | undefined>} Timestamp of last activity (Unix epoch ms), or undefined if not found.
   */
  public async getLastActiveTimeForConversation(conversationId: string): Promise<number | undefined> {
    this.ensureInitialized();
    const context = this.activeConversations.get(conversationId);
    if (context) {
      const lastMessage = context.getLastMessage();
      return lastMessage?.timestamp || context.createdAt;
    }
    if (this.config.persistenceEnabled && this.storageAdapter) {
      try {
        if (this.config.appendOnlyPersistence) {
          const row = await this.storageAdapter.get<{ last_ts: number | null }>(
            'SELECT MAX(timestamp) AS last_ts FROM conversation_messages WHERE conversation_id = ?',
            [conversationId]
          );
          if (row?.last_ts != null) {
            return row.last_ts;
          }
          const convo = await this.storageAdapter.get<{ created_at: number }>(
            'SELECT created_at FROM conversations WHERE id = ?',
            [conversationId]
          );
          return convo?.created_at;
        }
        const convo = await this.storageAdapter.get<{ updated_at: number }>(
          'SELECT updated_at FROM conversations WHERE id = ?',
          [conversationId]
        );
        return convo?.updated_at;
      } catch (error: any) {
        console.error(`ConversationManager (ID: ${this.managerId}): Error fetching 'updated_at' for conversation ${conversationId} from DB:`, error);
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Evicts the oldest (Least Recently Used based on `_lastAccessed` metadata)
   * conversation from the in-memory cache.
   * If persistence is enabled, ensures the conversation is saved to DB before eviction.
   * @private
   * @async
   */
  private async evictOldestConversation(): Promise<void> {
    if (this.activeConversations.size === 0) return;

    let oldestSessionId: string | undefined;
    let oldestTimestamp = Infinity;

    for (const [sessionId, context] of this.activeConversations.entries()) {
      const lastAccessed = (context.getMetadata('_lastAccessed') as number) || context.createdAt;
      if (lastAccessed < oldestTimestamp) {
        oldestTimestamp = lastAccessed;
        oldestSessionId = sessionId;
      }
    }

    if (oldestSessionId) {
      const contextToEvict = this.activeConversations.get(oldestSessionId);
      console.warn(`ConversationManager (ID: ${this.managerId}): Max in-memory conversations reached (${this.activeConversations.size}/${this.config.maxActiveConversationsInMemory}). Evicting conversation ${oldestSessionId}. Last accessed: ${new Date(oldestTimestamp).toISOString()}`);
      
      if (contextToEvict && this.config.persistenceEnabled && this.storageAdapter) {
        try {
          await this.saveConversationToDB(contextToEvict);
          console.log(`ConversationManager (ID: ${this.managerId}): Successfully saved conversation ${oldestSessionId} to DB before eviction.`);
        } catch (error) {
          console.error(`ConversationManager (ID: ${this.managerId}): Failed to save conversation ${oldestSessionId} to DB before eviction. Data might be lost if not already persisted. Error:`, error);
        }
      }
      this.activeConversations.delete(oldestSessionId);
    }
  }

  /**
   * Saves a ConversationContext to the database using StorageAdapter.
   * This is an upsert operation: creates if not exists, updates if exists.
   * Handles serialization of messages and metadata within a transaction.
   *
   * @async
   * @private
   * @param {ConversationContext} context - The ConversationContext to save.
   * @throws {GMIError} If the database operation fails.
   */
  private async saveConversationToDB(context: ConversationContext): Promise<void> {
    if (!this.storageAdapter || !this.config.persistenceEnabled) return;
    
    const contextJSON = context.toJSON() as {
        sessionId: string;
        createdAt: number;
        messages: InternalConversationMessage[];
        config: any;
        sessionMetadata: Record<string, any>;
    };

    try {
      await this.storageAdapter.transaction(async (tx) => {
        const now = Date.now();
        const conversationData = {
          id: context.sessionId,
          user_id: context.userId,
          gmi_instance_id: context.gmiInstanceId || null,
          title: (contextJSON.sessionMetadata?.title as string) || `Conversation from ${new Date(context.createdAt).toLocaleDateString()}`,
          language: context.currentLanguage || null,
          session_details: JSON.stringify(contextJSON.sessionMetadata || {}),
          is_archived: (contextJSON.sessionMetadata?.isArchived as boolean) ? 1 : 0,
          tags: JSON.stringify((contextJSON.sessionMetadata?.tags as string[]) || []),
          created_at: context.createdAt,
          updated_at: now,
        };

        // Upsert conversation (cross-platform compatible)
        // Check if exists first, then INSERT or UPDATE (unless append-only).
        const existing = await tx.get<{ created_at: number }>(
          'SELECT created_at FROM conversations WHERE id = ?',
          [conversationData.id]
        );
        const finalCreatedAt = existing?.created_at || conversationData.created_at;

        if (!existing) {
          await tx.run(
            `INSERT INTO conversations (id, user_id, gmi_instance_id, title, language, session_details, is_archived, tags, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              conversationData.id,
              conversationData.user_id,
              conversationData.gmi_instance_id,
              conversationData.title,
              conversationData.language,
              conversationData.session_details,
              conversationData.is_archived,
              conversationData.tags,
              finalCreatedAt,
              conversationData.updated_at,
            ]
          );
        } else if (!this.config.appendOnlyPersistence) {
          await tx.run(
            `UPDATE conversations SET
             user_id = ?, gmi_instance_id = ?, title = ?, language = ?, session_details = ?,
             is_archived = ?, tags = ?, updated_at = ?
             WHERE id = ?`,
            [
              conversationData.user_id,
              conversationData.gmi_instance_id,
              conversationData.title,
              conversationData.language,
              conversationData.session_details,
              conversationData.is_archived,
              conversationData.tags,
              conversationData.updated_at,
              conversationData.id,
            ]
          );
        }

        if (contextJSON.messages && contextJSON.messages.length > 0) {
          for (const msg of contextJSON.messages) {
            const messageId = (msg as any).id || `msg_${uuidv4()}`;

            // Append-only persistence: insert each message once; never update.
            if (this.config.appendOnlyPersistence) {
              const existingMsg = await tx.get<{ id: string }>(
                'SELECT id FROM conversation_messages WHERE id = ?',
                [messageId]
              );
              if (existingMsg) {
                continue;
              }
              await tx.run(
                `INSERT INTO conversation_messages (
                  id, conversation_id, role, content, timestamp, tool_calls, tool_call_id,
                  multimodal_data, audio_url, audio_transcript, voice_settings, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  messageId,
                  context.sessionId,
                  msg.role.toString(),
                  typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                  msg.timestamp,
                  msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
                  (msg as any).tool_call_id || null,
                  (msg as any).multimodalData ? JSON.stringify((msg as any).multimodalData) : null,
                  (msg as any).audioUrl || null,
                  (msg as any).audioTranscript || null,
                  (msg as any).voiceSettings ? JSON.stringify((msg as any).voiceSettings) : null,
                  JSON.stringify((msg as any).metadata || {}),
                ]
              );
              continue;
            }

            // Mutable/revisioned persistence: upsert-like behavior.
            // Prefer SQLite's INSERT OR REPLACE when available; otherwise fall back to SELECT+UPDATE.
            if (tx.kind !== 'postgres') {
              await tx.run(
                `INSERT OR REPLACE INTO conversation_messages (
                  id, conversation_id, role, content, timestamp, tool_calls, tool_call_id,
                  multimodal_data, audio_url, audio_transcript, voice_settings, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  messageId,
                  context.sessionId,
                  msg.role.toString(),
                  typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                  msg.timestamp,
                  msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
                  (msg as any).tool_call_id || null,
                  (msg as any).multimodalData ? JSON.stringify((msg as any).multimodalData) : null,
                  (msg as any).audioUrl || null,
                  (msg as any).audioTranscript || null,
                  (msg as any).voiceSettings ? JSON.stringify((msg as any).voiceSettings) : null,
                  JSON.stringify((msg as any).metadata || {}),
                ]
              );
            } else {
              const existingPgMsg = await tx.get<{ id: string }>(
                'SELECT id FROM conversation_messages WHERE id = ?',
                [messageId]
              );
              if (!existingPgMsg) {
                await tx.run(
                  `INSERT INTO conversation_messages (
                    id, conversation_id, role, content, timestamp, tool_calls, tool_call_id,
                    multimodal_data, audio_url, audio_transcript, voice_settings, metadata
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    messageId,
                    context.sessionId,
                    msg.role.toString(),
                    typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                    msg.timestamp,
                    msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
                    (msg as any).tool_call_id || null,
                    (msg as any).multimodalData ? JSON.stringify((msg as any).multimodalData) : null,
                    (msg as any).audioUrl || null,
                    (msg as any).audioTranscript || null,
                    (msg as any).voiceSettings ? JSON.stringify((msg as any).voiceSettings) : null,
                    JSON.stringify((msg as any).metadata || {}),
                  ]
                );
              } else {
                await tx.run(
                  `UPDATE conversation_messages SET
                    conversation_id = ?, role = ?, content = ?, timestamp = ?, tool_calls = ?, tool_call_id = ?,
                    multimodal_data = ?, audio_url = ?, audio_transcript = ?, voice_settings = ?, metadata = ?
                   WHERE id = ?`,
                  [
                    context.sessionId,
                    msg.role.toString(),
                    typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                    msg.timestamp,
                    msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
                    (msg as any).tool_call_id || null,
                    (msg as any).multimodalData ? JSON.stringify((msg as any).multimodalData) : null,
                    (msg as any).audioUrl || null,
                    (msg as any).audioTranscript || null,
                    (msg as any).voiceSettings ? JSON.stringify((msg as any).voiceSettings) : null,
                    JSON.stringify((msg as any).metadata || {}),
                    messageId,
                  ]
                );
              }
            }
          }
        }
      });
    } catch (error: any) {
      console.error(`ConversationManager (ID: ${this.managerId}): Error saving conversation ${context.sessionId} to DB: ${error.message}`, error);
      throw new GMIError(`Failed to save conversation ${context.sessionId} to database.`, GMIErrorCode.DATABASE_ERROR, { underlyingError: error.message, stack: error.stack });
    }
  }

  /**
   * Loads a ConversationContext from the database using StorageAdapter.
   * Reconstructs the ConversationContext instance along with its messages and metadata.
   *
   * @async
   * @private
   * @param {string} conversationId - The ID of the conversation to load.
   * @returns {Promise<ConversationContext | undefined>} The loaded ConversationContext or undefined if not found.
   * @throws {GMIError} If the database operation fails or data inconsistency is detected.
   */
  private async loadConversationFromDB(conversationId: string): Promise<ConversationContext | undefined> {
    if (!this.storageAdapter || !this.config.persistenceEnabled) return undefined;

    try {
      const convoData = await this.storageAdapter.get<{
        id: string;
        user_id: string;
        gmi_instance_id: string | null;
        title: string | null;
        language: string | null;
        session_details: string;
        is_archived: number;
        tags: string;
        created_at: number;
        updated_at: number;
      }>('SELECT * FROM conversations WHERE id = ?', [conversationId]);

      if (!convoData) return undefined;

      const messages = await this.storageAdapter.all<{
        id: string;
        conversation_id: string;
        role: string;
        content: string;
        timestamp: number;
        tool_calls: string | null;
        tool_call_id: string | null;
        multimodal_data: string | null;
        audio_url: string | null;
        audio_transcript: string | null;
        voice_settings: string | null;
        metadata: string;
      }>('SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY timestamp ASC', [conversationId]);

      const internalMessages: InternalConversationMessage[] = messages.map((dbMsg) => {
        let parsedContent: InternalConversationMessage['content'];
        try {
          if (dbMsg.content && ((dbMsg.content.startsWith('{') && dbMsg.content.endsWith('}')) || (dbMsg.content.startsWith('[') && dbMsg.content.endsWith(']')))) {
            parsedContent = JSON.parse(dbMsg.content);
          } else {
            parsedContent = dbMsg.content;
          }
        } catch {
          console.warn(`ConversationManager (ID: ${this.managerId}): Failed to parse content for message ${dbMsg.id} from DB as JSON, using as string.`);
          parsedContent = dbMsg.content;
        }

        const messageOptions: Partial<Omit<InternalConversationMessage, 'id' | 'timestamp' | 'role' | 'content'>> = {
          tool_calls: dbMsg.tool_calls ? JSON.parse(dbMsg.tool_calls) : undefined,
          tool_call_id: dbMsg.tool_call_id || undefined,
          metadata: dbMsg.metadata ? JSON.parse(dbMsg.metadata) : undefined,
          ...(dbMsg.multimodal_data && { multimodalData: JSON.parse(dbMsg.multimodal_data) }),
          ...(dbMsg.audio_url && { audioUrl: dbMsg.audio_url }),
          ...(dbMsg.audio_transcript && { audioTranscript: dbMsg.audio_transcript }),
          ...(dbMsg.voice_settings && { voiceSettings: JSON.parse(dbMsg.voice_settings) }),
        };

        return createConversationMessage(
          dbMsg.role as MessageRole,
          parsedContent,
          {
            ...messageOptions,
            id: dbMsg.id,
            timestamp: dbMsg.timestamp,
          }
        );
      });

      const sessionMetadataFromDB = JSON.parse(convoData.session_details || '{}') as Record<string, any>;

      const contextSpecificConfig = (sessionMetadataFromDB.contextConfigOverrides as Partial<ConversationContextConfig>) || {};
      const finalContextConfig: ConversationContextConfig = {
        ...this.config.defaultConversationContextConfig,
        userId: convoData.user_id || this.config.defaultConversationContextConfig?.userId,
        gmiInstanceId: convoData.gmi_instance_id || this.config.defaultConversationContextConfig?.gmiInstanceId,
        activePersonaId: (sessionMetadataFromDB.activePersonaId as string) || this.config.defaultConversationContextConfig?.activePersonaId,
        utilityAI: this.utilityAIService,
        ...contextSpecificConfig,
      } as ConversationContextConfig;

      const context = ConversationContext.fromJSON(
        {
          sessionId: convoData.id,
          createdAt: convoData.created_at,
          messages: internalMessages,
          config: {
            ...finalContextConfig,
            utilityAIServiceId: this.utilityAIService?.utilityId,
          },
          sessionMetadata: sessionMetadataFromDB,
        },
        (serviceId) => {
          if (this.utilityAIService && serviceId === this.utilityAIService.utilityId) {
            return this.utilityAIService;
          }
          if (serviceId && (!this.utilityAIService || serviceId !== this.utilityAIService.utilityId)) {
            console.warn(`ConversationManager (ID: ${this.managerId}): Conversation ${conversationId} stored utilityAIServiceId '${serviceId}' which differs from current or is unavailable.`);
          }
          return this.utilityAIService;
        }
      );
      
      console.log(`ConversationManager (ID: ${this.managerId}): Conversation ${conversationId} loaded from DB with ${internalMessages.length} messages.`);
      return context;
    } catch (error: any) {
      console.error(`ConversationManager (ID: ${this.managerId}): Error loading conversation ${conversationId} from DB: ${error.message}`, error);
      throw new GMIError(`Failed to load conversation ${conversationId} from database.`, GMIErrorCode.DATABASE_ERROR, { underlyingError: error.message, stack: error.stack });
    }
  }

  /**
   * Shuts down the ConversationManager.
   * If persistence is enabled, ensures all active conversations are saved to the database.
   * Clears the in-memory cache of conversations.
   *
   * @public
   * @async
   * @returns {Promise<void>}
   */
  public async shutdown(): Promise<void> {
    if (!this.initialized) {
        console.warn(`ConversationManager (ID: ${this.managerId}) shutdown called but was not initialized.`);
        return;
    }
    console.log(`ConversationManager (ID: ${this.managerId}): Shutting down...`);
    if (this.config.persistenceEnabled && this.storageAdapter) {
      console.log(`ConversationManager (ID: ${this.managerId}): Saving all active conversations (${this.activeConversations.size}) before shutdown...`);
      let savedCount = 0;
      for (const context of this.activeConversations.values()) {
        try {
          await this.saveConversationToDB(context);
          savedCount++;
        } catch (error) {
          console.error(`ConversationManager (ID: ${this.managerId}): Error saving conversation ${context.sessionId} during shutdown:`, error);
        }
      }
      console.log(`ConversationManager (ID: ${this.managerId}): ${savedCount} active conversations processed for saving.`);
    }
    this.activeConversations.clear();
    this.initialized = false;
    console.log(`ConversationManager (ID: ${this.managerId}): Shutdown complete. In-memory cache cleared.`);
  }
}
