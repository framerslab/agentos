/**
 * @fileoverview SQLite source adapter for the migration engine.
 * @module rag/migration/adapters/SqliteSourceAdapter
 *
 * Reads data from a brain.sqlite file in streaming batches using
 * better-sqlite3's synchronous API (fastest for local reads).
 */

import Database from 'better-sqlite3';
import type { IMigrationSource } from '../types.js';
import { readScopeIdForms, type BrainScopeIdForm } from '../../../memory/retrieval/store/scopeIdForm.js';

/**
 * Tables that are part of the AgentOS memory schema and should
 * be included in migrations. Order matters — foreign key dependencies
 * require parent tables to be migrated before children.
 */
const MIGRATION_TABLES = [
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

export class SqliteSourceAdapter implements IMigrationSource {
  private db: Database.Database;

  /**
   * @param path - Path to the source brain.sqlite file. Opened read-only.
   */
  constructor(path: string) {
    this.db = new Database(path, { readonly: true });
  }

  /**
   * List tables that exist in the source database AND are part of
   * the AgentOS memory schema. Unknown tables are skipped.
   */
  async listTables(): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const existing = new Set(rows.map(r => r.name));
    // Return only known tables that actually exist, in dependency order.
    return MIGRATION_TABLES.filter(t => existing.has(t));
  }

  /**
   * Count rows in a table.
   * @param table - Table name.
   */
  async countRows(table: string): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM "${table}"`).get() as { c: number };
    return row.c;
  }

  /**
   * Read a batch of rows from a table using LIMIT/OFFSET pagination.
   *
   * @param table  - Table name.
   * @param offset - Number of rows to skip.
   * @param limit  - Maximum rows to return.
   * @returns Array of row objects with column name → value mappings.
   */
  async readBatch(table: string, offset: number, limit: number): Promise<Record<string, unknown>[]> {
    return this.db
      .prepare(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`)
      .all(limit, offset) as Record<string, unknown>[];
  }

  /** Every brain this file holds, with its scope-id form. */
  async scopeIdForms(): Promise<Map<string, BrainScopeIdForm>> {
    const db = this.db;
    return readScopeIdForms({
      get: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
      all: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
    });
  }

  /** Close the read-only database connection. */
  async close(): Promise<void> {
    this.db.close();
  }
}
