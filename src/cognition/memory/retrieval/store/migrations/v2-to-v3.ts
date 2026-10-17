/**
 * @file v2-to-v3.ts
 * Schema migration v2 -> v3: `memory_traces.scope_id`, each trace's scope id as a column of its own (until v3 it
 * lived only in the metadata JSON, so a read of one scope scanned every row of the brain), filled from that JSON,
 * with an index on (brain_id, scope, scope_id, created_at).
 *
 * Idempotent. The column is added once per table: when this step adds it, every row of the table is filled, whatever
 * brain it belongs to. Each brain's own migration then fills that brain's rows that hold `''` again, which catches rows
 * an older release wrote after another brain's migration added the column (such a release writes the column's
 * default). `Brain` runs {@link ensureScopeIdColumn} on every open as well, for a table another path created without
 * the column (a migration engine's copy, a file an import reads).
 *
 * A row's JSON is read in code, not with a SQL JSON function: `json_extract` (SQLite) and the `::jsonb` cast
 * (Postgres) raise on a malformed row, which would stop the migration for the whole Brain. A row whose JSON cannot be
 * read, or holds no string `scopeId`, keeps `''`.
 *
 * @module memory/retrieval/store/migrations/v2-to-v3
 */
import type { StorageAdapter, StorageFeatures } from '@framers/sql-storage-adapter';
import { parseTraceMetadata } from '../tracePersistence.js';
import type { Migration } from './types.js';

/** The index a per-scope read uses. */
export const SCOPE_ID_INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS idx_memory_traces_brain_scope_id ON memory_traces (brain_id, scope, scope_id, created_at)';

/**
 * Rows read per page while the column is filled. A page's update binds two values per row it fills and one per row
 * it names, plus the brain id: 901 at most, under the 999 bound values of SQLite's oldest default limit.
 */
const PAGE = 300;

const isPostgres = (adapter: StorageAdapter): boolean => adapter.kind.includes('postgres');

async function tableExists(adapter: StorageAdapter, table: string): Promise<boolean> {
  if (isPostgres(adapter)) {
    const row = await adapter.get<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1) AS exists`,
      [table],
    );
    return row?.exists === true;
  }
  return Boolean(await adapter.get<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]));
}

async function hasColumn(adapter: StorageAdapter, table: string, column: string): Promise<boolean> {
  if (isPostgres(adapter)) {
    const row = await adapter.get<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2) AS exists`,
      [table, column],
    );
    return row?.exists === true;
  }
  const rows = await adapter.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some((row) => row.name === column);
}

/** The scope id a row's metadata JSON holds, or `''`. */
function scopeIdOfMetadata(metadata: string | null | undefined): string {
  const scopeId = parseTraceMetadata(metadata).scopeId;
  return typeof scopeId === 'string' ? scopeId : '';
}

/**
 * Fills one brain's `scope_id` from the metadata JSON for its rows that hold `''`. Pages by `id` inside the brain, so
 * each page is a range read of the primary key, and writes each page's values in one statement.
 */
async function backfill(adapter: StorageAdapter, brainId: string): Promise<void> {
  let afterId = '';
  for (;;) {
    const rows = await adapter.all<{ id: string; metadata: string | null }>(
      `SELECT id, metadata FROM memory_traces
        WHERE brain_id = ? AND scope_id = '' AND id > ?
        ORDER BY id LIMIT ${PAGE}`,
      [brainId, afterId],
    );
    const filled: Array<[string, string]> = [];
    for (const row of rows) {
      const scopeId = scopeIdOfMetadata(row.metadata);
      if (scopeId !== '') filled.push([row.id, scopeId]);
    }
    if (filled.length > 0) {
      await adapter.run(
        `UPDATE memory_traces SET scope_id = CASE id ${filled.map(() => 'WHEN ? THEN ?').join(' ')} END
          WHERE brain_id = ? AND id IN (${filled.map(() => '?').join(', ')})`,
        [...filled.flat(), brainId, ...filled.map(([id]) => id)],
      );
    }
    if (rows.length < PAGE) return;
    afterId = rows[rows.length - 1]!.id;
  }
}

/**
 * Fills `scope_id` for every brain the table holds, one brain at a time: a brain with rows and no `brain_meta` row
 * runs no migration of its own, so the step that adds the column fills it.
 */
async function backfillEveryBrain(adapter: StorageAdapter): Promise<void> {
  const brains = await adapter.all<{ brain_id: string }>('SELECT DISTINCT brain_id FROM memory_traces');
  for (const { brain_id: brainId } of brains) await backfill(adapter, brainId);
}

/**
 * Gives `memory_traces` its `scope_id` column and index. Adding the column fills it for every row of the table.
 * A store without the table is left alone: the schema step that follows creates it with the column.
 *
 * @param adapter - The store, or a migration's transaction.
 */
export async function ensureScopeIdColumn(adapter: StorageAdapter): Promise<void> {
  if (!(await tableExists(adapter, 'memory_traces'))) return;
  if (!(await hasColumn(adapter, 'memory_traces', 'scope_id'))) {
    // On Postgres the first opens of two brains can both find the column missing: the second ALTER waits for the
    // first's lock and then finds the column, which `IF NOT EXISTS` lets it pass. SQLite has no such clause; its
    // migrations run under `BEGIN IMMEDIATE`, so the second sees the column the first committed.
    const ifNotExists = isPostgres(adapter) ? 'IF NOT EXISTS ' : '';
    await adapter.exec(`ALTER TABLE memory_traces ADD COLUMN ${ifNotExists}scope_id TEXT NOT NULL DEFAULT ''`);
    await backfillEveryBrain(adapter);
  }
  await adapter.exec(SCOPE_ID_INDEX_DDL);
}

export const v2ToV3: Migration = {
  version: 3,
  async up(adapter: StorageAdapter, _features: StorageFeatures, brainId: string): Promise<void> {
    // A file with no `memory_traces` gets the table, with the column, from the schema step that follows.
    if (!(await tableExists(adapter, 'memory_traces'))) return;
    await ensureScopeIdColumn(adapter);
    await backfill(adapter, brainId);
  },
};
