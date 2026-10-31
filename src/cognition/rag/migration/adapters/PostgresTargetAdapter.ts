/**
 * @fileoverview Postgres target adapter for the migration engine.
 * @module rag/migration/adapters/PostgresTargetAdapter
 *
 * Writes migration data to a Postgres + pgvector database.
 * Ensures pgvector extension and creates tables with appropriate
 * column types (JSONB, vector, tsvector).
 */

import type { IMigrationTarget } from '../types.js';
import {
  readScopeIdForms,
  SCOPE_ID_FORM_KEY,
  scopeIdOfMetadata,
  type BrainScopeIdForm,
} from '../../../memory/retrieval/store/scopeIdForm.js';

/** A statement with `?` placeholders in `pg`'s numbered form (`$1`, `$2`, ...); its text holds no other `?`. */
function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${(n += 1)}`);
}

export class PostgresTargetAdapter implements IMigrationTarget {
  private pool: any = null;
  private createdTables = new Set<string>();

  /**
   * @param connectionString - Postgres connection string.
   */
  constructor(private readonly connectionString: string) {}

  /** Lazily initialize the pg connection pool and ensure pgvector is available. */
  private async _ensurePool(): Promise<any> {
    if (this.pool) return this.pool;
    const pg = await import('pg');
    this.pool = new pg.default.Pool({ connectionString: this.connectionString, max: 5 });
    // Ensure pgvector extension exists.
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    return this.pool;
  }

  /**
   * Create the target table if it doesn't exist.
   * Infers column types from the sample row:
   * - Buffer → BYTEA (or vector if column name contains 'embedding')
   * - number → BIGINT or DOUBLE PRECISION
   * - boolean → BOOLEAN
   * - object/array → JSONB
   * - string → TEXT
   */
  async ensureTable(table: string, sampleRow: Record<string, unknown>): Promise<void> {
    if (this.createdTables.has(table)) return;
    const pool = await this._ensurePool();

    const columns = Object.keys(sampleRow);
    const colDefs = columns.map(col => {
      const val = sampleRow[col];
      // Embedding columns get the pgvector `vector` type.
      if (col.includes('embedding') && (val instanceof Buffer || Array.isArray(val))) {
        const dim = val instanceof Buffer ? val.byteLength / 4 : (val as number[]).length;
        return `"${col}" vector(${dim})`;
      }
      if (val instanceof Buffer || val instanceof Uint8Array) return `"${col}" BYTEA`;
      if (typeof val === 'number') return `"${col}" ${Number.isInteger(val) ? 'BIGINT' : 'DOUBLE PRECISION'}`;
      if (typeof val === 'boolean') return `"${col}" BOOLEAN`;
      if (typeof val === 'object' && val !== null) return `"${col}" JSONB`;
      return `"${col}" TEXT`;
    }).join(', ');

    await pool.query(`CREATE TABLE IF NOT EXISTS "${table}" (${colDefs})`);
    this.createdTables.add(table);
  }

  /**
   * Write a batch of rows using INSERT ... ON CONFLICT DO NOTHING.
   * Wraps in a single transaction for atomicity.
   */
  async writeBatch(table: string, rows: Record<string, unknown>[]): Promise<number> {
    if (rows.length === 0) return 0;
    const pool = await this._ensurePool();
    // A row from before memory_traces.scope_id gets the column from its metadata where the target's table has it.
    const sourceColumns = Object.keys(rows[0]);
    const fillScopeId =
      table === 'memory_traces' && !sourceColumns.includes('scope_id') && (await this.hasColumn(table, 'scope_id'));
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const columns = fillScopeId ? [...sourceColumns, 'scope_id'] : sourceColumns;
      const quotedCols = columns.map(c => `"${c}"`).join(', ');
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `INSERT INTO "${table}" (${quotedCols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

      let count = 0;
      for (const row of rows) {
        const values = columns.map(c => {
          const v = c === 'scope_id' && fillScopeId ? scopeIdOfMetadata(row.metadata) : row[c];
          // Convert Buffer embeddings to pgvector format: '[0.1,0.2,...]'
          if (c.includes('embedding') && v instanceof Buffer) {
            const f32 = new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4);
            return `[${Array.from(f32).join(',')}]`;
          }
          // Convert objects/arrays to JSON strings for JSONB columns.
          if (typeof v === 'object' && v !== null && !(v instanceof Buffer)) {
            return JSON.stringify(v);
          }
          return v;
        });
        await client.query(sql, values);
        count++;
      }

      await client.query('COMMIT');
      return count;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** These brains as this database holds them, with their scope-id forms. */
  async scopeIdForms(brainIds: readonly string[]): Promise<Map<string, BrainScopeIdForm>> {
    const pool = await this._ensurePool();
    return readScopeIdForms(
      {
        get: async <T>(sql: string, params: unknown[] = []) => (await pool.query(numbered(sql), params)).rows[0] as T | undefined,
        all: async <T>(sql: string, params: unknown[] = []) => (await pool.query(numbered(sql), params)).rows as T[],
      },
      brainIds,
    );
  }

  async clearScopeIdForm(brainId: string): Promise<void> {
    const pool = await this._ensurePool();
    try {
      await pool.query('DELETE FROM brain_meta WHERE brain_id = $1 AND key = $2', [brainId, SCOPE_ID_FORM_KEY]);
    } catch {
      // A target with no brain ids holds no record.
    }
  }

  /** The columns of each target table, read once per table. */
  private readonly columnsOf = new Map<string, Set<string>>();
  private async hasColumn(table: string, column: string): Promise<boolean> {
    let columns = this.columnsOf.get(table);
    if (!columns) {
      const pool = await this._ensurePool();
      const result = await pool.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
        [table],
      );
      columns = new Set((result.rows as Array<{ column_name: string }>).map((c) => c.column_name));
      this.columnsOf.set(table, columns);
    }
    return columns.has(column);
  }

  /** Close the connection pool. */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
