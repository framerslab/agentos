/**
 * @fileoverview SQLite target adapter for the migration engine.
 * @module rag/migration/adapters/SqliteTargetAdapter
 *
 * Writes migration data to a new or existing brain.sqlite file.
 * Uses WAL mode for concurrent read safety and wraps each batch
 * in a transaction for atomicity and performance.
 */

import Database from 'better-sqlite3';
import type { IMigrationTarget } from '../types.js';
import {
  readScopeIdForms,
  SCOPE_ID_FORM_KEY,
  scopeIdOfMetadata,
  type BrainScopeIdForm,
} from '../../../memory/retrieval/store/scopeIdForm.js';

export class SqliteTargetAdapter implements IMigrationTarget {
  private db: Database.Database;
  /** Track which tables we've already created to avoid redundant DDL. */
  private createdTables = new Set<string>();

  /**
   * @param path - Path to the target brain.sqlite file. Created if it doesn't exist.
   */
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  /**
   * Ensure the target table exists. Infers column types from a sample row:
   * - Buffer → BLOB
   * - number (integer) → INTEGER
   * - number (float) → REAL
   * - everything else → TEXT
   *
   * Uses CREATE TABLE IF NOT EXISTS so it's safe to call multiple times.
   *
   * @param table     - Table name to create.
   * @param sampleRow - A sample row to derive column types from.
   */
  async ensureTable(table: string, sampleRow: Record<string, unknown>): Promise<void> {
    if (this.createdTables.has(table)) return;

    const columns = Object.keys(sampleRow);
    const colDefs = columns.map(col => {
      const val = sampleRow[col];
      // Infer SQLite column type from the sample value.
      if (val instanceof Buffer || val instanceof Uint8Array) return `"${col}" BLOB`;
      if (typeof val === 'number') return `"${col}" ${Number.isInteger(val) ? 'INTEGER' : 'REAL'}`;
      if (typeof val === 'boolean') return `"${col}" INTEGER`; // SQLite stores booleans as 0/1
      return `"${col}" TEXT`;
    }).join(', ');

    this.db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${colDefs})`);
    this.createdTables.add(table);
  }

  /**
   * Write a batch of rows to the target table.
   * Uses INSERT OR REPLACE to handle duplicates (requires a PRIMARY KEY
   * or UNIQUE constraint — if none exists, rows are simply inserted).
   *
   * Wraps the entire batch in a single transaction for atomicity and
   * dramatically better write performance (avoids per-row fsync).
   *
   * @param table - Table name to write to.
   * @param rows  - Array of row objects.
   * @returns Number of rows written.
   */
  async writeBatch(table: string, rows: Record<string, unknown>[]): Promise<number> {
    if (rows.length === 0) return 0;

    // A row from before memory_traces.scope_id gets the column from its metadata where the target's table has it.
    const sourceColumns = Object.keys(rows[0]);
    const fillScopeId = table === 'memory_traces' && !sourceColumns.includes('scope_id') && this.hasColumn(table, 'scope_id');
    const columns = fillScopeId ? [...sourceColumns, 'scope_id'] : sourceColumns;
    const quotedCols = columns.map(c => `"${c}"`).join(', ');
    const placeholders = columns.map(() => '?').join(', ');

    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO "${table}" (${quotedCols}) VALUES (${placeholders})`,
    );

    // Transaction wrapper: single fsync for the entire batch.
    const tx = this.db.transaction((batch: Record<string, unknown>[]) => {
      let count = 0;
      for (const row of batch) {
        const values = columns.map(c => {
          const v = c === 'scope_id' && fillScopeId ? scopeIdOfMetadata(row.metadata) : row[c];
          // Convert booleans to integers for SQLite compatibility.
          if (typeof v === 'boolean') return v ? 1 : 0;
          return v;
        });
        stmt.run(...values);
        count++;
      }
      return count;
    });

    return tx(rows);
  }

  /** These brains as this file holds them, with their scope-id forms. */
  async scopeIdForms(brainIds: readonly string[]): Promise<Map<string, BrainScopeIdForm>> {
    const db = this.db;
    return readScopeIdForms(
      {
        get: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
        all: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
      },
      brainIds,
    );
  }

  async clearScopeIdForm(brainId: string): Promise<void> {
    try {
      this.db.prepare('DELETE FROM brain_meta WHERE brain_id = ? AND key = ?').run(brainId, SCOPE_ID_FORM_KEY);
    } catch {
      // A target with no brain ids holds no record.
    }
  }

  /** Whether the target's table has the column, read once per table. */
  private readonly columnsOf = new Map<string, Set<string>>();
  private hasColumn(table: string, column: string): boolean {
    let columns = this.columnsOf.get(table);
    if (!columns) {
      columns = new Set((this.db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name));
      this.columnsOf.set(table, columns);
    }
    return columns.has(column);
  }

  /** Close the database connection. */
  async close(): Promise<void> {
    this.db.close();
  }
}
