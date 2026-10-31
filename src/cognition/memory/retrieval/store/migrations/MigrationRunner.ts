/**
 * @fileoverview MigrationRunner: centralized owner of "how schema migrations
 * run safely." Each registered Migration object knows only its target version
 * and schema-diff logic; the runner handles transaction wrapping, advisory
 * locking (per-brain), and atomic schema_version bumps.
 *
 * Two distinct dialect paths because connection-pooling and transaction
 * semantics differ enough that a unified path obscures correctness:
 *
 * - Postgres: uses `adapter.transaction()` to keep all queries on one pooled
 *   connection. Acquires a transaction-scoped advisory lock with
 *   `pg_advisory_xact_lock`, which auto-releases on COMMIT/ROLLBACK. The lock
 *   is the brain's, while a migration changes the tables every brain of the
 *   database shares, so another brain's open can make the same object at the
 *   same moment; a transaction that loses that race rolls back and runs again
 *   (`retryLostCreate`), and finds the object.
 * - SQLite: uses explicit `BEGIN IMMEDIATE` via `adapter.exec`. Single
 *   connection per file, so the connection-pool concern doesn't apply.
 *   IMMEDIATE acquires the reserved write lock immediately, eliminating the
 *   race window in default DEFERRED mode.
 *
 * @module memory/retrieval/store/migrations/MigrationRunner
 */

import type { StorageAdapter, StorageFeatures } from '@framers/sql-storage-adapter';
import { retryLostCreate } from './lost-create.js';
import type { Migration } from './types.js';

export class MigrationRunner {
  /**
   * Run all pending migrations against the adapter, scoped by brainId.
   *
   * On Postgres they run in one transaction that holds the brain's advisory
   * lock. A migration's statement that loses the race for a shared table,
   * column or index to another brain's open fails the transaction, which rolls
   * back and runs again, up to `LOST_CREATE_RUNS` runs; each run finds what the
   * runs before it lost.
   *
   * @returns The list of migration versions that were applied.
   */
  static async runPending(
    adapter: StorageAdapter,
    features: StorageFeatures,
    brainId: string,
    migrations: Migration[],
  ): Promise<{ applied: number[] }> {
    const isPostgres = adapter.kind.includes('postgres');

    if (isPostgres) {
      return retryLostCreate(() =>
        adapter.transaction(async (trx) => {
          await trx.run(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            [`agentos_brain:${brainId}`],
          );
          return MigrationRunner._runMigrations(trx, features, brainId, migrations);
        }),
      );
    }

    // SQLite path: explicit BEGIN IMMEDIATE for single-connection serialization.
    await adapter.exec('BEGIN IMMEDIATE');
    try {
      const result = await MigrationRunner._runMigrations(adapter, features, brainId, migrations);
      await adapter.exec('COMMIT');
      return result;
    } catch (err) {
      // Best-effort rollback. If BEGIN IMMEDIATE never landed (e.g. the
      // adapter swallowed it or sql.js didn't actually open a tx), a
      // bare ROLLBACK throws "no transaction is active" and SHADOWS the
      // real migration failure. Swallow that rollback-time error so
      // the original `err` makes it to the caller.
      try {
        await adapter.exec('ROLLBACK');
      } catch {
        /* preserve the original migration error */
      }
      throw err;
    }
  }

  /**
   * Inner migration loop, called once the lock + transaction are established.
   * Reads the current schema_version, filters pending migrations, applies each
   * one, and bumps schema_version inside the same transaction.
   */
  private static async _runMigrations(
    adapter: StorageAdapter,
    features: StorageFeatures,
    brainId: string,
    migrations: Migration[],
  ): Promise<{ applied: number[] }> {
    const current = await MigrationRunner._readSchemaVersion(adapter, brainId);

    // Fresh database: brain_meta does not exist yet. Skip migrations entirely;
    // the upcoming _initSchema call creates the latest schema directly.
    if (current === null) return { applied: [] };

    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    const pending = sorted.filter((m) => m.version > current);
    const applied: number[] = [];

    for (const migration of pending) {
      await migration.up(adapter, features, brainId);
      await MigrationRunner._writeSchemaVersion(adapter, features, brainId, migration.version);
      applied.push(migration.version);
    }
    return { applied };
  }

  /**
   * Read the current schema_version from brain_meta. Returns null when
   * brain_meta does not exist (fresh database).
   *
   * Handles both v1 (no brain_id column) and v2+ (composite-key) schemas.
   * On v1, the SELECT omits the brain_id WHERE clause so the column-existence
   * check in v1ToV2.up can proceed with the migration.
   */
  private static async _readSchemaVersion(
    adapter: StorageAdapter,
    brainId: string,
  ): Promise<number | null> {
    const isPostgres = adapter.kind.includes('postgres');
    const brainMetaExists = isPostgres
      ? await MigrationRunner._postgresTableExists(adapter, 'brain_meta')
      : await MigrationRunner._sqliteTableExists(adapter, 'brain_meta');
    if (!brainMetaExists) return null;

    const hasBrainIdCol = isPostgres
      ? await MigrationRunner._postgresHasColumn(adapter, 'brain_meta', 'brain_id')
      : await MigrationRunner._sqliteHasColumn(adapter, 'brain_meta', 'brain_id');

    if (!hasBrainIdCol) {
      // v1 schema: brain_meta has key/value only. v1ToV2 migration will add
      // brain_id and namespace existing rows. Read the unscoped schema_version.
      const row = await adapter.get<{ value: string }>(
        `SELECT value FROM brain_meta WHERE key = ?`,
        ['schema_version'],
      );
      return row ? parseInt(row.value, 10) : null;
    }

    const row = await adapter.get<{ value: string }>(
      `SELECT value FROM brain_meta WHERE brain_id = ? AND key = ?`,
      [brainId, 'schema_version'],
    );
    return row ? parseInt(row.value, 10) : null;
  }

  /**
   * Upsert schema_version in brain_meta inside the current transaction.
   * Uses dialect-aware INSERT OR REPLACE.
   */
  private static async _writeSchemaVersion(
    adapter: StorageAdapter,
    features: StorageFeatures,
    brainId: string,
    version: number,
  ): Promise<void> {
    await adapter.run(
      features.dialect.insertOrReplace(
        'brain_meta',
        ['brain_id', 'key', 'value'],
        ['?', '?', '?'],
        'brain_id, key',
      ),
      [brainId, 'schema_version', String(version)],
    );
  }

  private static async _sqliteTableExists(
    adapter: StorageAdapter,
    table: string,
  ): Promise<boolean> {
    const row = await adapter.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [table],
    );
    return Boolean(row);
  }

  private static async _sqliteHasColumn(
    adapter: StorageAdapter,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows = await adapter.all<{ name: string }>(`PRAGMA table_info(${table})`);
    return rows.some((r) => r.name === column);
  }

  private static async _postgresHasColumn(
    adapter: StorageAdapter,
    table: string,
    column: string,
  ): Promise<boolean> {
    // Scope to current_schema() to match _postgresTableExists. Without
    // the schema filter, a table with the same name in another schema
    // (e.g. a previous test deployment in another search-path entry)
    // would falsely return true and skip the actual ALTER TABLE this
    // probe gates.
    const row = await adapter.get<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = $1
            AND column_name = $2
       ) AS exists`,
      [table, column],
    );
    return row?.exists ?? false;
  }

  private static async _postgresTableExists(
    adapter: StorageAdapter,
    table: string,
  ): Promise<boolean> {
    const row = await adapter.get<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = $1
       ) AS exists`,
      [table],
    );
    return row?.exists ?? false;
  }
}
