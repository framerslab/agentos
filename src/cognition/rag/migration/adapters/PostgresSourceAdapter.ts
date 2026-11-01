/**
 * @fileoverview Postgres source adapter for the migration engine.
 * @module rag/migration/adapters/PostgresSourceAdapter
 *
 * Reads data from a Postgres + pgvector database in streaming batches.
 * Uses the `pg` npm package for connection management.
 */

import type { IMigrationSource } from '../types.js';
import { readScopeIdForms, type BrainScopeIdForm } from '../../../memory/retrieval/store/scopeIdForm.js';

/** A statement with `?` placeholders in `pg`'s numbered form (`$1`, `$2`, ...); its text holds no other `?`. */
function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${(n += 1)}`);
}

/**
 * Tables in the AgentOS Postgres schema that should be migrated.
 * Matches the SQLite schema with JSONB instead of TEXT for JSON columns.
 */
const PG_MIGRATION_TABLES = [
  'brain_meta',
  'memory_traces',
  'knowledge_nodes',
  'knowledge_edges',
  'documents',
  'document_chunks',
  'document_images',
  'consolidation_log',
  'retrieval_feedback',
  'conversations',
  'messages',
];

export class PostgresSourceAdapter implements IMigrationSource {
  private pool: any = null; // pg.Pool — dynamically imported

  /**
   * @param connectionString - Postgres connection string (e.g. 'postgresql://user:pass@host:5432/db').
   */
  constructor(private readonly connectionString: string) {}

  /** Lazily initialize the pg connection pool. */
  private async _ensurePool(): Promise<any> {
    if (this.pool) return this.pool;
    const pg = await import('pg');
    this.pool = new pg.default.Pool({ connectionString: this.connectionString, max: 5 });
    return this.pool;
  }

  /** List tables that exist in the Postgres schema. */
  async listTables(): Promise<string[]> {
    const pool = await this._ensurePool();
    const result = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const existing = new Set(result.rows.map((r: any) => r.table_name));
    return PG_MIGRATION_TABLES.filter(t => existing.has(t));
  }

  /** Count rows in a table. */
  async countRows(table: string): Promise<number> {
    const pool = await this._ensurePool();
    const result = await pool.query(`SELECT COUNT(*) as c FROM "${table}"`);
    return parseInt(result.rows[0].c, 10);
  }

  /**
   * Read a batch of rows using LIMIT/OFFSET.
   * Converts pgvector `vector` columns to number[] arrays.
   */
  async readBatch(table: string, offset: number, limit: number): Promise<Record<string, unknown>[]> {
    const pool = await this._ensurePool();
    const result = await pool.query(`SELECT * FROM "${table}" LIMIT $1 OFFSET $2`, [limit, offset]);
    return result.rows as Record<string, unknown>[];
  }

  /** Every brain this database holds, with its scope-id form. */
  async scopeIdForms(): Promise<Map<string, BrainScopeIdForm>> {
    const pool = await this._ensurePool();
    return readScopeIdForms({
      get: async <T>(sql: string, params: unknown[] = []) => (await pool.query(numbered(sql), params)).rows[0] as T | undefined,
      all: async <T>(sql: string, params: unknown[] = []) => (await pool.query(numbered(sql), params)).rows as T[],
    });
  }

  /** Close the connection pool. */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
