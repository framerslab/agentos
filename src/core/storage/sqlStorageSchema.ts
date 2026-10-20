/**
 * @file sqlStorageSchema.ts
 * @description The tables `SqlStorageAdapter` keeps conversations and messages
 * in, the migrations that bring an older database up to them, and the column
 * lists it reads rows through.
 *
 * @license Apache-2.0
 */

import type { StorageAdapter } from '@framers/sql-storage-adapter';

/**
 * The columns a conversation is read from, each under the name `IConversation`
 * gives it. PostgreSQL folds a name written without quotes to lower case
 * (https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS),
 * so `SELECT *` hands back `userid` for `userId`; a quoted alias keeps the case,
 * on SQLite too.
 */
export const CONVERSATION_COLUMNS = [
  'id',
  'userId AS "userId"',
  'agentId AS "agentId"',
  'createdAt AS "createdAt"',
  'lastActivity AS "lastActivity"',
  'title',
  'metadata',
].join(', ');

/** The columns a message is read from, each under the name `IConversationMessage` gives it. */
export const MESSAGE_COLUMNS = [
  'id',
  'conversationId AS "conversationId"',
  'role',
  'content',
  'timestamp',
  'model',
  'promptTokens AS "promptTokens"',
  'completionTokens AS "completionTokens"',
  'totalTokens AS "totalTokens"',
  'cacheReadTokens AS "cacheReadTokens"',
  'cacheCreationTokens AS "cacheCreationTokens"',
  'toolCalls AS "toolCalls"',
  'toolCallId AS "toolCallId"',
  'name',
  'metadata',
].join(', ');

/** What {@link ensureConversationSchema} changed in a database that already held the tables. */
export interface ConversationSchemaChanges {
  /** Timestamp columns widened from INTEGER to BIGINT, on PostgreSQL. */
  widenedColumns: number;
}

/**
 * Creates the `conversations` and `messages` tables and their indexes when they
 * are missing, adds the cache-token columns to a `messages` table made before
 * them, and on PostgreSQL widens INTEGER timestamp columns to BIGINT.
 *
 * @param adapter - The open database.
 * @returns What changed in tables that already existed.
 */
export async function ensureConversationSchema(adapter: StorageAdapter): Promise<ConversationSchemaChanges> {
  // Timestamps are milliseconds, so their columns are BIGINT.
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      agentId TEXT,
      createdAt BIGINT NOT NULL,
      lastActivity BIGINT NOT NULL,
      title TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_userId ON conversations(userId);
    CREATE INDEX IF NOT EXISTS idx_conversations_agentId ON conversations(agentId);
    CREATE INDEX IF NOT EXISTS idx_conversations_lastActivity ON conversations(lastActivity);
  `);

  // SQLite enforces the foreign key only on a connection that turns foreign
  // keys on; SqlStorageAdapter.deleteConversation deletes the messages itself.
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      timestamp BIGINT NOT NULL,
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

  await addCacheTokenColumns(adapter);
  const widenedColumns = adapter.kind.includes('postgres') ? await widenPostgresTimestamps(adapter) : 0;
  return { widenedColumns };
}

/**
 * Back-compat migration: adds the cacheReadTokens and cacheCreationTokens
 * columns to a `messages` table made before them. CREATE TABLE IF NOT EXISTS
 * leaves an existing table as it is, so they need an explicit ALTER. Neither
 * SQLite before 3.35 nor a portable statement has ADD COLUMN IF NOT EXISTS, so
 * a duplicate-column error is swallowed.
 *
 * Both columns are read first and the ALTERs run only when that read fails. On
 * Postgres an ALTER TABLE takes an ACCESS EXCLUSIVE lock even when the column
 * exists; the lock waits behind every open reader of the table (a pg_dump reads
 * it for its whole run) and later queries queue behind it.
 */
async function addCacheTokenColumns(adapter: StorageAdapter): Promise<void> {
  try {
    await adapter.get('SELECT cacheReadTokens, cacheCreationTokens FROM messages LIMIT 0');
    return;
  } catch {
    // At least one column is missing: add them below.
  }
  for (const col of ['cacheReadTokens', 'cacheCreationTokens']) {
    try {
      await adapter.exec(`ALTER TABLE messages ADD COLUMN ${col} INTEGER;`);
    } catch {
      // The column already exists (the other one was the missing one).
    }
  }
}

/**
 * Widens the timestamp columns of tables made with INTEGER timestamps.
 * PostgreSQL's INTEGER holds four bytes
 * (https://www.postgresql.org/docs/current/datatype-numeric.html), up to
 * 2147483647, which a millisecond timestamp passed on 25 January 1970, so such a
 * table refuses every conversation and message. The column types are read
 * first, so the ALTER and the ACCESS EXCLUSIVE lock it takes come only when a
 * column needs it. SQLite stores an INTEGER in up to eight bytes
 * (https://www.sqlite.org/datatype3.html) and needs nothing.
 *
 * @returns How many columns were widened.
 */
async function widenPostgresTimestamps(adapter: StorageAdapter): Promise<number> {
  const narrow = await adapter.all<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND data_type = 'integer'
        AND ((table_name = 'conversations' AND column_name IN ('createdat', 'lastactivity'))
          OR (table_name = 'messages' AND column_name = 'timestamp'))`
  );
  for (const { table_name, column_name } of narrow) {
    // Both names come from the fixed list in the query above.
    await adapter.exec(`ALTER TABLE ${table_name} ALTER COLUMN ${column_name} TYPE BIGINT`);
  }
  return narrow.length;
}
