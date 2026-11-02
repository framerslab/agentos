/**
 * @fileoverview Qdrant target adapter for the migration engine.
 * @module rag/migration/adapters/QdrantTargetAdapter
 *
 * Writes vector data to Qdrant collections and non-vector data
 * to a sidecar SQLite file. Creates collections with appropriate
 * vector configuration on first write.
 */

import type { IMigrationTarget } from '../types.js';
import Database from 'better-sqlite3';
import { SCOPE_ID_FORM_KEY, type BrainScopeIdForm } from '../../../memory/retrieval/store/scopeIdForm.js';
import { isMissingTableError } from '../../../memory/retrieval/store/missingTable.js';
import { sidecarScopeIdForms } from './sidecarScopeIdForms.js';

/** Tables that go into Qdrant as point collections. */
const QDRANT_COLLECTIONS = new Set(['memory_traces', 'document_chunks']);

export class QdrantTargetAdapter implements IMigrationTarget {
  private createdCollections = new Set<string>();
  private createdSidecarTables = new Set<string>();
  private sidecarDb: Database.Database | null = null; // For non-vector tables

  /**
   * These brains as the sidecar holds them, with their scope-id forms ({@link sidecarScopeIdForms}); set only with a
   * sidecar, since a target with none cannot report the form of what it holds.
   */
  readonly scopeIdForms?: (brainIds?: readonly string[]) => Promise<Map<string, BrainScopeIdForm>>;

  /** Removes one brain's scope-id form record from the sidecar; set only with a sidecar. */
  readonly clearScopeIdForm?: (brainId: string) => Promise<void>;

  /**
   * @param url    - Qdrant base URL.
   * @param apiKey - Optional API key for cloud instances.
   * @param sidecarPath - The SQLite file that takes the tables other than the vectors.
   */
  constructor(
    private readonly url: string,
    private readonly apiKey?: string,
    sidecarPath?: string,
  ) {
    if (sidecarPath) {
      const sidecar = new Database(sidecarPath);
      sidecar.pragma('journal_mode = WAL');
      sidecar.pragma('foreign_keys = ON');
      this.sidecarDb = sidecar;
      this.scopeIdForms = (brainIds) => sidecarScopeIdForms(sidecar, brainIds);
      this.clearScopeIdForm = async (brainId) => {
        try {
          sidecar.prepare('DELETE FROM brain_meta WHERE brain_id = ? AND key = ?').run(brainId, SCOPE_ID_FORM_KEY);
        } catch (error) {
          // A sidecar with no brain_meta holds no record; any other failure leaves the record and fails the migration.
          if (!isMissingTableError(error)) throw error;
        }
      };
    }
  }

  /** Build fetch headers. */
  private _headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['api-key'] = this.apiKey;
    return h;
  }

  /**
   * Ensure a Qdrant collection exists with the correct vector configuration.
   * For non-vector tables, ensures the sidecar SQLite file has the table.
   */
  async ensureTable(table: string, sampleRow: Record<string, unknown>): Promise<void> {
    if (QDRANT_COLLECTIONS.has(table)) {
      if (this.createdCollections.has(table)) return;
      // Determine vector dimensions from sample row.
      const embedding = sampleRow['embedding'];
      const dim = Array.isArray(embedding)
        ? embedding.length
        : (embedding instanceof Buffer ? embedding.byteLength / 4 : 1536);

      // Check if collection already exists.
      const checkRes = await fetch(`${this.url}/collections/${table}`, {
        headers: this._headers(),
      });

      if (!checkRes.ok) {
        // Create the collection with cosine distance.
        await fetch(`${this.url}/collections/${table}`, {
          method: 'PUT',
          headers: this._headers(),
          body: JSON.stringify({
            vectors: { size: dim, distance: 'Cosine' },
          }),
        });
      }

      this.createdCollections.add(table);
      return;
    }

    if (!this.sidecarDb) {
      throw new Error(`Qdrant target requires sidecarPath to migrate non-vector table '${table}'.`);
    }
    if (this.createdSidecarTables.has(table)) return;

    const columns = Object.keys(sampleRow);
    const colDefs = columns.map((col) => {
      const val = sampleRow[col];
      if (val instanceof Buffer || val instanceof Uint8Array) return `"${col}" BLOB`;
      if (typeof val === 'number') return `"${col}" ${Number.isInteger(val) ? 'INTEGER' : 'REAL'}`;
      if (typeof val === 'boolean') return `"${col}" INTEGER`;
      return `"${col}" TEXT`;
    }).join(', ');

    this.sidecarDb.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${colDefs})`);
    this.createdSidecarTables.add(table);
  }

  /**
   * Write a batch of rows as Qdrant points.
   * Extracts `id` and `embedding` fields; everything else becomes payload.
   */
  async writeBatch(table: string, rows: Record<string, unknown>[]): Promise<number> {
    if (rows.length === 0) return 0;

    if (QDRANT_COLLECTIONS.has(table)) {
      // Convert rows to Qdrant point format.
      const points = rows.map(row => {
        const { id, embedding, ...payload } = row;
        // Convert Buffer embedding to number[] if needed.
        let vector: number[];
        if (embedding instanceof Buffer) {
          const f32 = new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4);
          vector = Array.from(f32);
        } else if (Array.isArray(embedding)) {
          vector = embedding as number[];
        } else {
          vector = []; // Fallback — shouldn't happen.
        }

        return {
          id: String(id),
          vector,
          payload,
        };
      });

      // Upsert points in a single batch request.
      const res = await fetch(`${this.url}/collections/${table}/points`, {
        method: 'PUT',
        headers: this._headers(),
        body: JSON.stringify({ points }),
      });

      return res.ok ? points.length : 0;
    }

    if (!this.sidecarDb) {
      throw new Error(`Qdrant target requires sidecarPath to migrate non-vector table '${table}'.`);
    }

    const columns = Object.keys(rows[0]);
    const quotedCols = columns.map((c) => `"${c}"`).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const stmt = this.sidecarDb.prepare(
      `INSERT OR REPLACE INTO "${table}" (${quotedCols}) VALUES (${placeholders})`,
    );

    const tx = this.sidecarDb.transaction((batch: Record<string, unknown>[]) => {
      let count = 0;
      for (const row of batch) {
        const values = columns.map((column) => {
          const value = row[column];
          if (typeof value === 'boolean') return value ? 1 : 0;
          if (typeof value === 'object' && value !== null && !(value instanceof Buffer) && !(value instanceof Uint8Array)) {
            return JSON.stringify(value);
          }
          return value;
        });
        stmt.run(...values);
        count++;
      }
      return count;
    });

    return tx(rows);
  }

  /** Close connections. */
  async close(): Promise<void> {
    if (this.sidecarDb) {
      this.sidecarDb.close();
      this.sidecarDb = null;
    }
  }
}
