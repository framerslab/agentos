/**
 * @file v2-to-v3.ts
 * Schema migration v2 -> v3: `memory_traces.scope_id`, each trace's scope id as a column of its own (until v3 it
 * lived only in the metadata JSON, so a read of one scope scanned every row of the brain), filled from that JSON,
 * with an index on (brain_id, scope, scope_id, created_at).
 *
 * Idempotent. The column is added once per table: when this step adds it, every row of the table is filled, whatever
 * brain it belongs to, and the brain being migrated is not read again. When the column is already there, a brain's
 * migration fills that brain's rows that hold `''`, which catches rows an older release wrote after another brain's
 * migration added the column (such a release writes the column's default). `Brain` runs {@link ensureScopeIdColumn}
 * on every open as well, for a table another path created without the column (a migration engine's copy, a file an
 * import reads).
 *
 * An older release goes on writing `''` to a brain that is already at version 3, where its migration never runs
 * again. `Brain` runs {@link fillScopeIds} for the brain it opens, at every open, and each importer runs it before it
 * looks for duplicates, so such a row is filed under the scope id its metadata names before an import reads the column.
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

/**
 * Whether Postgres has an index named `index` in the schema of `table`, the table the connection's search path
 * resolves: the schema where `CREATE INDEX IF NOT EXISTS index ON table` makes it, and where its IF NOT EXISTS
 * looks. An unqualified `to_regclass(index)` would also find a same-named index in a later schema on the search
 * path (a fresh schema ahead of an initialized `public`) and skip the index the table needs. Ask once `table`
 * exists: before, its name can resolve to a same-named table in a later schema, not the one `CREATE TABLE IF NOT
 * EXISTS` is about to make in the first. Reads the catalog without taking a lock on the table.
 */
export async function postgresIndexExists(adapter: StorageAdapter, index: string, table: string): Promise<boolean> {
  const row = await adapter.get<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class i
        WHERE i.relname = ? AND i.relkind IN ('i', 'I')
          AND i.relnamespace = (SELECT t.relnamespace FROM pg_class t WHERE t.oid = to_regclass(?))
     ) AS found`,
    [index, table],
  );
  return row?.found === true;
}

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
 * Matches a row whose metadata text can name a scope id other than `''`: it holds `"scopeId"`, and not only once with
 * the value `""`, as `JSON.stringify` writes the metadata of a trace `remember()` files under no scope id. A fill gives
 * a scope id to no other row, so the fill that runs at every open reads only these, and the traces a brain holds under
 * no scope id are not read back each time. A row whose text holds `"scopeId"` once is excluded only when that one
 * `"scopeId"` reads `""`: whether it is the top-level key or a nested one, the top-level scope id is then `''` or
 * missing. SQLite's `LIKE` ignores ASCII case, which counts more occurrences and so excludes no further row.
 */
const NAMES_SCOPE_ID =
  `metadata LIKE '%"scopeId"%' AND NOT (metadata LIKE '%"scopeId":""%' AND metadata NOT LIKE '%"scopeId"%"scopeId"%')`;

/**
 * Fills one brain's `scope_id` from the metadata JSON for its rows that hold `''`. Pages by `id` inside the brain, so
 * each page is a range read of the primary key, and writes each page's values in one statement, to the rows that
 * still hold `''`.
 *
 * @param named - Read only the rows whose metadata text can name a scope id other than `''`.
 */
async function backfill(adapter: Pick<StorageAdapter, 'all' | 'run'>, brainId: string, named = false): Promise<void> {
  const filter = named ? ` AND (${NAMES_SCOPE_ID})` : '';
  let afterId = '';
  for (;;) {
    const rows = await adapter.all<{ id: string; metadata: string | null }>(
      `SELECT id, metadata FROM memory_traces
        WHERE brain_id = ? AND scope_id = '' AND id > ?${filter}
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
          WHERE brain_id = ? AND scope_id = '' AND id IN (${filled.map(() => '?').join(', ')})`,
        [...filled.flat(), brainId, ...filled.map(([id]) => id)],
      );
    }
    if (rows.length < PAGE) return;
    afterId = rows[rows.length - 1]!.id;
  }
}

/**
 * Files the traces of one brain that hold `scope_id` `''` while their metadata names a scope id: the rows a release
 * older than the column writes, with the column's default, to a brain that is already at schema version 3. Only the
 * rows whose metadata text can name a scope id other than `''` are read; a row whose JSON cannot be read, or whose
 * `scopeId` is not a string, keeps `''`. A row that holds a scope id is never written.
 *
 * `Brain` runs it for the brain it opens, at every open. Each importer runs it before its first duplicate check,
 * inside the import's transaction where it has one: an older release can write to a brain while this process holds
 * it open.
 *
 * @param adapter - The store, or the transaction an import runs in.
 * @param brainId - The brain whose traces are filed.
 */
export async function fillScopeIds(adapter: Pick<StorageAdapter, 'all' | 'run'>, brainId: string): Promise<void> {
  await backfill(adapter, brainId, true);
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
 * @returns Whether this call added the column, and so filled every row of the table.
 */
export async function ensureScopeIdColumn(adapter: StorageAdapter): Promise<boolean> {
  if (!(await tableExists(adapter, 'memory_traces'))) return false;
  let added = false;
  if (!(await hasColumn(adapter, 'memory_traces', 'scope_id'))) {
    // On Postgres the first opens of two brains can both find the column missing: the second ALTER waits for the
    // first's lock and then finds the column, which `IF NOT EXISTS` lets it pass. SQLite has no such clause; its
    // migrations run under `BEGIN IMMEDIATE`, so the second sees the column the first committed.
    const ifNotExists = isPostgres(adapter) ? 'IF NOT EXISTS ' : '';
    await adapter.exec(`ALTER TABLE memory_traces ADD COLUMN ${ifNotExists}scope_id TEXT NOT NULL DEFAULT ''`);
    await backfillEveryBrain(adapter);
    added = true;
  }
  // Postgres takes the table's SHARE lock before it checks IF NOT EXISTS, so an existing index is skipped by name:
  // otherwise every open would wait for a long write transaction on memory_traces and hold up the writers behind it.
  if (isPostgres(adapter) && (await postgresIndexExists(adapter, 'idx_memory_traces_brain_scope_id', 'memory_traces'))) {
    return added;
  }
  await adapter.exec(SCOPE_ID_INDEX_DDL);
  return added;
}

/**
 * Schema version 3: `memory_traces.scope_id`, each trace's scope id as a column of its own, and the index
 * `idx_memory_traces_brain_scope_id` a per-scope read uses. `MigrationRunner` runs it for a brain whose
 * `schema_version` is below 3, inside the migration's transaction (`BEGIN IMMEDIATE` on SQLite, a transaction that
 * holds the brain's advisory lock on Postgres), and then records version 3 for that brain.
 *
 * The first brain of a table to migrate adds the column ({@link ensureScopeIdColumn}), which fills it for every brain
 * the table holds from each row's metadata JSON. A brain that migrates after that fills its own rows that hold `''`:
 * a release older than the column may have written them since. A store with no `memory_traces` is left to the schema
 * step that follows, which creates the table with the column.
 */
export const v2ToV3: Migration = {
  version: 3,
  async up(adapter: StorageAdapter, _features: StorageFeatures, brainId: string): Promise<void> {
    // A file with no `memory_traces` gets the table, with the column, from the schema step that follows.
    if (!(await tableExists(adapter, 'memory_traces'))) return;
    // Adding the column filled every brain's rows, this brain's among them.
    if (await ensureScopeIdColumn(adapter)) return;
    await backfill(adapter, brainId);
  },
};
