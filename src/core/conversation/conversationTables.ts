/**
 * @file conversationTables.ts
 * @description The tables `ConversationManager` keeps conversations and their
 * messages in, and the changes that bring a database an earlier version made up
 * to them.
 *
 * @license Apache-2.0
 */

import type { StorageAdapter } from '@framers/sql-storage-adapter';

/**
 * The `conversations` and `conversation_messages` tables and their indexes.
 *
 * Timestamps are milliseconds, so their columns are BIGINT. SQLite gives a
 * column whose declared type contains INT integer affinity
 * (https://www.sqlite.org/datatype3.html), so BIGINT and INTEGER store alike
 * there; PostgreSQL keeps an INTEGER in four bytes
 * (https://www.postgresql.org/docs/current/datatype-numeric.html).
 *
 * `content_type` says how `content` reads back: `text` as it is, `json`
 * parsed. `name`, `thinking_blocks` and `summarized_count` hold the message's
 * `name`, `thinkingBlocks` and `originalMessagesSummarizedCount`. `seq` is the
 * message's position in its conversation when it was saved; it orders messages
 * that share a timestamp.
 */
export const CONVERSATION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gmi_instance_id TEXT,
  title TEXT,
  language TEXT,
  session_details TEXT DEFAULT '{}',
  is_archived INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  multimodal_data TEXT,
  audio_url TEXT,
  audio_transcript TEXT,
  voice_settings TEXT,
  metadata TEXT DEFAULT '{}',
  content_type TEXT,
  name TEXT,
  thinking_blocks TEXT,
  summarized_count INTEGER,
  seq INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_gmi_instance_id ON conversations(gmi_instance_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_id ON conversation_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_timestamp ON conversation_messages(timestamp);
`;

/**
 * The `conversation_messages` columns added after its first version, in the
 * order a table made before them gets them.
 */
const ADDED_MESSAGE_COLUMNS: ReadonlyArray<readonly [name: string, type: string]> = [
  ['content_type', 'TEXT'],
  ['name', 'TEXT'],
  ['thinking_blocks', 'TEXT'],
  ['summarized_count', 'INTEGER'],
  ['seq', 'INTEGER'],
];

/** What {@link ensureConversationTables} changed in tables that already existed. */
export interface ConversationTablesChanges {
  /** The columns added to a `conversation_messages` table made before them. */
  addedColumns: string[];
  /** Timestamp columns widened from INTEGER to BIGINT, on PostgreSQL. */
  widenedColumns: number;
}

/**
 * True for an adapter that runs PostgreSQL: the storage library's `postgres`
 * adapter and its Supabase adapter (`supabase-postgres`).
 *
 * @param adapter - The adapter, or a transaction's view of it.
 */
export function isPostgresAdapter(adapter: Pick<StorageAdapter, 'kind'>): boolean {
  return String(adapter.kind ?? '').includes('postgres');
}

/**
 * Creates the tables and indexes when they are missing, adds the columns a
 * `conversation_messages` table made by an earlier version lacks, and on
 * PostgreSQL widens INTEGER timestamp columns to BIGINT.
 *
 * @param adapter - The open database.
 * @returns What changed in tables that already existed.
 */
export async function ensureConversationTables(adapter: StorageAdapter): Promise<ConversationTablesChanges> {
  await adapter.exec(CONVERSATION_TABLES_SQL);
  const addedColumns = await addMissingMessageColumns(adapter);
  const widenedColumns = isPostgresAdapter(adapter) ? await widenPostgresTimestamps(adapter) : 0;
  return { addedColumns, widenedColumns };
}

/** True when `conversation_messages` has every one of the columns. */
async function hasMessageColumns(adapter: StorageAdapter, columns: readonly string[]): Promise<boolean> {
  try {
    await adapter.get(`SELECT ${columns.join(', ')} FROM conversation_messages LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Adds the columns of {@link ADDED_MESSAGE_COLUMNS} that the table lacks. The
 * columns are read first and an ALTER runs only for a missing one: on
 * PostgreSQL an ALTER TABLE takes an ACCESS EXCLUSIVE lock even when it
 * changes nothing. SQLite has no ADD COLUMN IF NOT EXISTS
 * (https://www.sqlite.org/lang_altertable.html), so the ALTER is the plain ADD
 * COLUMN both databases run, and when it fails the column is read again: a
 * second process that opened the same database may have added it.
 */
async function addMissingMessageColumns(adapter: StorageAdapter): Promise<string[]> {
  const names = ADDED_MESSAGE_COLUMNS.map(([name]) => name);
  if (await hasMessageColumns(adapter, names)) return [];

  const added: string[] = [];
  for (const [name, type] of ADDED_MESSAGE_COLUMNS) {
    if (await hasMessageColumns(adapter, [name])) continue;
    try {
      await adapter.exec(`ALTER TABLE conversation_messages ADD COLUMN ${name} ${type}`);
      added.push(name);
    } catch (error) {
      if (!(await hasMessageColumns(adapter, [name]))) throw error;
    }
  }
  return added;
}

/**
 * Widens the timestamp columns of tables made with INTEGER timestamps. A
 * millisecond timestamp passed INTEGER's 2147483647 on 25 January 1970, so
 * such a table refuses every save. The column types are read first, so the
 * ALTER and the lock it takes come only when a column needs it.
 *
 * @returns How many columns were widened.
 */
async function widenPostgresTimestamps(adapter: StorageAdapter): Promise<number> {
  const narrow = await adapter.all<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND data_type = 'integer'
        AND ((table_name = 'conversations' AND column_name IN ('created_at', 'updated_at'))
          OR (table_name = 'conversation_messages' AND column_name = 'timestamp'))`
  );
  for (const { table_name, column_name } of narrow) {
    // Both names come from the fixed list in the query above.
    await adapter.exec(`ALTER TABLE ${table_name} ALTER COLUMN ${column_name} TYPE BIGINT`);
  }
  return narrow.length;
}
