/**
 * @module learning/store/schema
 *
 * The learning store's ten tables, portable between SQLite and Postgres: TEXT and INTEGER columns, JSON in TEXT, times
 * as ISO strings, and no literal question mark in any statement (the Postgres adapter numbers each one). Every row
 * carries its learner's `namespace`; each row the layer updates in place carries a `version`, and a chain head's `seq`
 * is its version, moved only by compare-and-swap. A product that runs its own migrations runs
 * {@link LEARNING_SCHEMA_DDL}, adds each column of {@link LEARNING_COLUMN_ADDITIONS} its tables lack, and passes
 * `ensureSchema: false` to the store.
 */
import { ensureColumnExists, type StorageAdapter } from '@framers/sql-storage-adapter';

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
const learnerDocTable = (name: LearningTable) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_${name}_learner ON ${name} (namespace, agent_key, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_${name}_user ON ${name} (namespace, user_id);`;

/** The DDL of the ten tables and their indexes. Idempotent. */
export const LEARNING_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS agentos_learning_ledger (
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
);
CREATE INDEX IF NOT EXISTS idx_agentos_learning_ledger_learner ON agentos_learning_ledger (namespace, agent_key, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agentos_learning_ledger_candidate ON agentos_learning_ledger (candidate_id);
CREATE INDEX IF NOT EXISTS idx_agentos_learning_ledger_turn_user ON agentos_learning_ledger (namespace, turn_user_id);

CREATE TABLE IF NOT EXISTS agentos_learning_heads (
  chain_key TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  user_id TEXT,
  last_id TEXT NOT NULL,
  last_hash TEXT NOT NULL,
  seq INTEGER NOT NULL,
  forgotten INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agentos_learning_heads_user ON agentos_learning_heads (namespace, user_id);

CREATE TABLE IF NOT EXISTS agentos_learning_traits (
  namespace TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, agent_key, user_id)
);
${learnerDocTable('agentos_learning_outcomes')}
${learnerDocTable('agentos_learning_lessons')}
${learnerDocTable('agentos_learning_skills')}

CREATE TABLE IF NOT EXISTS agentos_learning_probe_cache (
  cache_key TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT '',
  persona_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agentos_learning_freezes (
  scope_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  namespace TEXT NOT NULL,
  agent_key TEXT,
  user_id TEXT,
  set_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, mode)
);

CREATE TABLE IF NOT EXISTS agentos_learning_sessions (
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
);
CREATE INDEX IF NOT EXISTS idx_agentos_learning_sessions_user ON agentos_learning_sessions (namespace, user_id);

CREATE TABLE IF NOT EXISTS agentos_learning_forgotten (
  hash TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT '',
  forgotten_at TEXT NOT NULL
);
`;

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
 * current schema, on SQLite the table's columns). Idempotent; a store runs it before its first statement.
 *
 * @throws {Error} When a statement fails, or an addition's column is not a plain identifier.
 */
export async function ensureLearningSchema(
  adapter: StorageAdapter,
  additions: readonly LearningColumnAddition[] = LEARNING_COLUMN_ADDITIONS,
): Promise<void> {
  await adapter.exec(LEARNING_SCHEMA_DDL);
  for (const { table, column, definition } of additions) await ensureColumnExists(adapter, table, column, definition);
}
