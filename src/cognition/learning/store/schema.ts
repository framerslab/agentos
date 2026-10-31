/**
 * @module learning/store/schema
 *
 * The learning store's ten tables, portable between SQLite and Postgres: TEXT and INTEGER columns, JSON in TEXT, times
 * as ISO strings, and no literal question mark in any statement (the Postgres adapter numbers each one). Every row
 * carries its learner's `namespace`; each row the layer updates in place carries a `version`, and a chain head's `seq`
 * is its version, moved only by compare-and-swap. A product that runs its own migrations runs
 * {@link LEARNING_SCHEMA_DDL}, adds each column of {@link LEARNING_COLUMN_ADDITIONS} its tables lack, and passes
 * `ensureSchema: false` to the store.
 *
 * On Postgres `CREATE ... IF NOT EXISTS` is not atomic, and `CREATE INDEX IF NOT EXISTS` takes its table's SHARE lock
 * before it looks for the index, so {@link ensureLearningSchema} makes one object a step, runs a step again when it
 * lost the race for its object to another session's create, and skips an index Postgres has: stores of several
 * processes that first open one database at once make each table and index once, and a store that opens while
 * another process holds a write transaction on a table does not wait for it.
 */
import { createStorageFeatures, ensureColumnExists, type StorageAdapter } from '@framers/sql-storage-adapter';
import { retryLostCreate } from '../../memory/retrieval/store/migrations/lost-create.js';
import { postgresIndexExists } from '../../memory/retrieval/store/migrations/v2-to-v3.js';

/** The ten tables, in the order the DDL creates them. */
export const LEARNING_TABLES = [
  'agentos_learning_ledger',
  'agentos_learning_heads',
  'agentos_learning_traits',
  'agentos_learning_outcomes',
  'agentos_learning_lessons',
  'agentos_learning_skills',
  'agentos_learning_probe_cache',
  'agentos_learning_freezes',
  'agentos_learning_sessions',
  'agentos_learning_forgotten',
] as const;

/** One of the learning store's tables. */
export type LearningTable = (typeof LEARNING_TABLES)[number];

/** A learner document table's columns: outcomes, lessons and skills share them; `body` holds the record as JSON. */
const learnerDocTable = (name: LearningTable) => `CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

/** Each table's `CREATE TABLE IF NOT EXISTS` statement, in the order of {@link LEARNING_TABLES}. */
const TABLE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS agentos_learning_ledger (
  id TEXT PRIMARY KEY,
  chain_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  row_type TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  user_id TEXT,
  turn_user_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  verdict TEXT NOT NULL,
  body TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  state_digest TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (chain_key, seq)
);`,
  `CREATE TABLE IF NOT EXISTS agentos_learning_heads (
  chain_key TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  user_id TEXT,
  last_id TEXT NOT NULL,
  last_hash TEXT NOT NULL,
  seq INTEGER NOT NULL,
  forgotten INTEGER NOT NULL DEFAULT 0
);`,
  `CREATE TABLE IF NOT EXISTS agentos_learning_traits (
  namespace TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, agent_key, user_id)
);`,
  learnerDocTable('agentos_learning_outcomes'),
  learnerDocTable('agentos_learning_lessons'),
  learnerDocTable('agentos_learning_skills'),
  `CREATE TABLE IF NOT EXISTS agentos_learning_probe_cache (
  cache_key TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT '',
  persona_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS agentos_learning_freezes (
  scope_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  namespace TEXT NOT NULL,
  agent_key TEXT,
  user_id TEXT,
  set_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, mode)
);`,
  `CREATE TABLE IF NOT EXISTS agentos_learning_sessions (
  namespace TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  conversation_ids TEXT NOT NULL,
  brain_ids TEXT NOT NULL,
  started_at TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (namespace, agent_key, session_id, user_id, kind)
);`,
  `CREATE TABLE IF NOT EXISTS agentos_learning_forgotten (
  hash TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT '',
  forgotten_at TEXT NOT NULL
);`,
];

/** An index of a table: its name, its table, and the columns it orders. */
interface LearningIndex {
  name: string;
  table: LearningTable;
  columns: string;
}

/** The learner document tables' two indexes each: by learner and time, and by user for a user's deletion. */
const learnerDocIndexes = (table: LearningTable): LearningIndex[] => [
  { name: `idx_${table}_learner`, table, columns: 'namespace, agent_key, user_id, created_at' },
  { name: `idx_${table}_user`, table, columns: 'namespace, user_id' },
];

/** Every index of the ten tables, each after its table. */
const INDEXES: readonly LearningIndex[] = [
  { name: 'idx_agentos_learning_ledger_learner', table: 'agentos_learning_ledger', columns: 'namespace, agent_key, user_id, created_at' },
  { name: 'idx_agentos_learning_ledger_candidate', table: 'agentos_learning_ledger', columns: 'candidate_id' },
  { name: 'idx_agentos_learning_ledger_turn_user', table: 'agentos_learning_ledger', columns: 'namespace, turn_user_id' },
  { name: 'idx_agentos_learning_heads_user', table: 'agentos_learning_heads', columns: 'namespace, user_id' },
  ...learnerDocIndexes('agentos_learning_outcomes'),
  ...learnerDocIndexes('agentos_learning_lessons'),
  ...learnerDocIndexes('agentos_learning_skills'),
  { name: 'idx_agentos_learning_sessions_user', table: 'agentos_learning_sessions', columns: 'namespace, user_id' },
];

const indexStatement = ({ name, table, columns }: LearningIndex): string =>
  `CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${columns});`;

/** The DDL of the ten tables and their indexes, the tables first. Idempotent. */
export const LEARNING_SCHEMA_DDL = `${[...TABLE_STATEMENTS, ...INDEXES.map(indexStatement)].join('\n\n')}\n`;

/** A column a release adds to a table an earlier release created: nullable or with a default, so its rows are kept. */
export interface LearningColumnAddition {
  table: LearningTable;
  /** The column's name: letters, digits and underscores. */
  column: string;
  /** The column's type and constraints, as `ALTER TABLE ... ADD COLUMN <column> <definition>` takes them: `TEXT`. */
  definition: string;
}

/**
 * The columns added since the tables were first released, oldest first. Empty in this release; a release that adds a
 * column to one of the tables appends it here, and a store adds each one its table lacks when it opens.
 */
export const LEARNING_COLUMN_ADDITIONS: readonly LearningColumnAddition[] = [];

/**
 * Creates the ten tables and their indexes where missing, then adds each column of `additions` its table lacks
 * (`ensureColumnExists` of `@framers/sql-storage-adapter`: on Postgres it reads the catalogue of the connection's
 * current schema, on SQLite the table's columns). Each table and each index is a step of its own, run again when it
 * lost the race for its object to another session's create (Postgres fails such a create once the other commits); on
 * Postgres an index the table's schema holds is skipped, never asked for with `CREATE INDEX IF NOT EXISTS`, which
 * would wait for every write transaction on the table. A column another store adds between this one's read and its
 * `ALTER TABLE` is found when the addition runs once more. Idempotent; a store runs it before its first statement.
 *
 * @throws {Error} When a statement fails, or an addition's column is not a plain identifier.
 */
export async function ensureLearningSchema(
  adapter: StorageAdapter,
  additions: readonly LearningColumnAddition[] = LEARNING_COLUMN_ADDITIONS,
): Promise<void> {
  const postgres = createStorageFeatures(adapter).dialect.name === 'postgres';
  for (const statement of TABLE_STATEMENTS) await retryLostCreate(() => adapter.exec(statement));
  for (const index of INDEXES) {
    if (postgres && (await postgresIndexExists(adapter, index.name, index.table))) continue;
    await retryLostCreate(() => adapter.exec(indexStatement(index)));
  }
  for (const { table, column, definition } of additions) {
    const add = () => ensureColumnExists(adapter, table, column, definition);
    await retryLostCreate(add).catch(() => add());
  }
}
