/**
 * @file conversationTables.ts
 * @description The tables `ConversationManager` keeps conversations and their
 * messages in, under a prefix a host may set, and the changes that bring a
 * database an earlier version made up to them.
 *
 * @license Apache-2.0
 */

import type { StorageAdapter } from '@framers/sql-storage-adapter';

/** The names of the two tables `ConversationManager` keeps conversations and their messages in. */
export interface ConversationTableNames {
  /** `<prefix>conversations`. */
  conversations: string;
  /** `<prefix>conversation_messages`. */
  messages: string;
}

/**
 * The longest table prefix: the two table names built from it stay within PostgreSQL's 63-byte identifiers. An index
 * name past 63 bytes (`idx_<prefix>conversation_messages_conversation_id` from a prefix over 22 characters) is
 * shortened to 63 bytes by PostgreSQL, the same way at every start, and the four index names stay distinct.
 */
const MAX_TABLE_PREFIX_LENGTH = 32;

/**
 * The tables' names under `tablePrefix`: `<prefix>conversations` and
 * `<prefix>conversation_messages`. No prefix, or an empty one, gives
 * `conversations` and `conversation_messages`.
 *
 * @param tablePrefix - Letters, digits and underscores, starting with a letter
 *   or an underscore, at most 32 characters; or empty.
 * @throws {TypeError} For any other prefix, naming
 *   `conversationManagerConfig.tablePrefix`.
 */
export function conversationTableNames(tablePrefix: string = ''): ConversationTableNames {
  if (
    typeof tablePrefix !== 'string' ||
    tablePrefix.length > MAX_TABLE_PREFIX_LENGTH ||
    (tablePrefix !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablePrefix))
  ) {
    throw new TypeError(
      `conversationManagerConfig.tablePrefix must be empty, or up to ${MAX_TABLE_PREFIX_LENGTH} letters, digits and underscores starting with a letter or an underscore; got ${JSON.stringify(tablePrefix)}.`,
    );
  }
  return { conversations: `${tablePrefix}conversations`, messages: `${tablePrefix}conversation_messages` };
}

/**
 * The two tables and their indexes, under the names given: with no prefix,
 * `conversations` and `conversation_messages`, and indexes named after them
 * (`idx_conversations_user_id`, ...).
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
export function conversationTablesSql(names: ConversationTableNames = conversationTableNames()): string {
  const { conversations, messages } = names;
  return `
CREATE TABLE IF NOT EXISTS ${conversations} (
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

CREATE TABLE IF NOT EXISTS ${messages} (
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
  FOREIGN KEY (conversation_id) REFERENCES ${conversations}(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_${conversations}_user_id ON ${conversations}(user_id);
CREATE INDEX IF NOT EXISTS idx_${conversations}_gmi_instance_id ON ${conversations}(gmi_instance_id);
CREATE INDEX IF NOT EXISTS idx_${messages}_conversation_id ON ${messages}(conversation_id);
CREATE INDEX IF NOT EXISTS idx_${messages}_timestamp ON ${messages}(timestamp);
`;
}

/** The `conversations` and `conversation_messages` tables and their indexes ({@link conversationTablesSql}). */
export const CONVERSATION_TABLES_SQL = conversationTablesSql();

/**
 * Thrown where a table of the name `ConversationManager` would make holds
 * another component's rows: a memory Brain on the same database makes a
 * `conversations` table of its own, with other columns.
 */
export class ConversationTableConflictError extends Error {
  constructor(readonly table: string) {
    super(
      `The table ${table} on this storage adapter is not one ConversationManager made (another component, such as a memory Brain on the same database, makes a table of that name with other columns). Set conversationManagerConfig.tablePrefix (for one, 'agentos_') to keep the conversation tables apart.`,
    );
    this.name = 'ConversationTableConflictError';
  }
}

/** The columns of each table's first version, which a table `ConversationManager` made has at every version. */
const OWN_COLUMNS = {
  conversations: ['id', 'user_id', 'gmi_instance_id', 'title', 'language', 'session_details', 'is_archived', 'tags', 'created_at', 'updated_at'],
  messages: [
    'id',
    'conversation_id',
    'role',
    'content',
    'timestamp',
    'tool_calls',
    'tool_call_id',
    'multimodal_data',
    'audio_url',
    'audio_transcript',
    'voice_settings',
    'metadata',
  ],
} as const;

/** Whether a statement that reads the table runs: false when the table, or one of the columns, is missing. */
async function reads(adapter: StorageAdapter, table: string, columns: readonly string[] | '*'): Promise<boolean> {
  try {
    await adapter.get(`SELECT ${columns === '*' ? '*' : columns.join(', ')} FROM ${table} LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the table that CREATE TABLE IF NOT EXISTS would keep exists without
 * one of `own`'s columns. On PostgreSQL that is the table of the schema the
 * connection creates in (`current_schema()`), never one of a later schema of
 * the search path, which an unqualified read would find in its place.
 */
async function isOtherComponentsTable(adapter: StorageAdapter, table: string, own: readonly string[]): Promise<boolean> {
  if (isPostgresAdapter(adapter)) {
    // An unquoted name is folded to lower case, which is how information_schema lists it.
    const rows = await adapter.all<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
      [table.toLowerCase()],
    );
    if (rows.length === 0) return false;
    const columns = new Set(rows.map((row) => row.column_name));
    return own.some((column) => !columns.has(column));
  }
  return (await reads(adapter, table, '*')) && !(await reads(adapter, table, own));
}

/**
 * Refuses a table of either name that exists without the columns every version
 * of the manager's table has: the CREATE TABLE IF NOT EXISTS would keep it, and
 * every read and write after it would fail.
 *
 * @throws {ConversationTableConflictError} Naming the table.
 */
async function assertOwnTables(adapter: StorageAdapter, names: ConversationTableNames): Promise<void> {
  for (const kind of ['conversations', 'messages'] as const) {
    if (await isOtherComponentsTable(adapter, names[kind], OWN_COLUMNS[kind])) {
      throw new ConversationTableConflictError(names[kind]);
    }
  }
}

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
 * messages table made by an earlier version lacks, and on PostgreSQL widens
 * INTEGER timestamp columns to BIGINT.
 *
 * @param adapter - The open database.
 * @param names - The tables' names ({@link conversationTableNames}); by
 *   default `conversations` and `conversation_messages`.
 * @returns What changed in tables that already existed.
 * @throws {ConversationTableConflictError} When a table of either name exists
 *   with other columns, before anything is changed.
 */
export async function ensureConversationTables(
  adapter: StorageAdapter,
  names: ConversationTableNames = conversationTableNames(),
): Promise<ConversationTablesChanges> {
  await assertOwnTables(adapter, names);
  await adapter.exec(conversationTablesSql(names));
  const addedColumns = await addMissingMessageColumns(adapter, names.messages);
  const widenedColumns = isPostgresAdapter(adapter) ? await widenPostgresTimestamps(adapter, names) : 0;
  return { addedColumns, widenedColumns };
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
async function addMissingMessageColumns(adapter: StorageAdapter, table: string): Promise<string[]> {
  const names = ADDED_MESSAGE_COLUMNS.map(([name]) => name);
  if (await reads(adapter, table, names)) return [];

  const added: string[] = [];
  for (const [name, type] of ADDED_MESSAGE_COLUMNS) {
    if (await reads(adapter, table, [name])) continue;
    try {
      await adapter.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      added.push(name);
    } catch (error) {
      if (!(await reads(adapter, table, [name]))) throw error;
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
async function widenPostgresTimestamps(adapter: StorageAdapter, names: ConversationTableNames): Promise<number> {
  // The prefix is checked to be letters, digits and underscores (conversationTableNames); PostgreSQL folds an unquoted
  // name to lower case, which is how information_schema lists it.
  const conversations = names.conversations.toLowerCase();
  const messages = names.messages.toLowerCase();
  const narrow = await adapter.all<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND data_type = 'integer'
        AND ((table_name = ? AND column_name IN ('created_at', 'updated_at'))
          OR (table_name = ? AND column_name = 'timestamp'))`,
    [conversations, messages],
  );
  for (const { table_name, column_name } of narrow) {
    // The table is one of the two names above, and the column one of the fixed list in the query.
    await adapter.exec(`ALTER TABLE ${table_name} ALTER COLUMN ${column_name} TYPE BIGINT`);
  }
  return narrow.length;
}
