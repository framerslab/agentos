/**
 * @fileoverview SQLite exporter for AgentOS memory brain.
 *
 * Writes the brain to a new SQLite file through `Brain.exportToSqlite`: this
 * brain's rows of every portable table (traces with their embeddings, the
 * knowledge graph, documents and chunks, conversations and messages, the
 * consolidation log and the rest of `PORTABLE_TABLES`), from a SQLite or a
 * Postgres brain alike. A database can hold several brains; the file holds
 * this one only, so importing it reads one brain.
 *
 * @module memory/io/SqliteExporter
 */

import type { ExportOptions } from './facade/types.js';
import type { Brain } from '../retrieval/store/Brain.js';

// ---------------------------------------------------------------------------
// SqliteExporter
// ---------------------------------------------------------------------------

/**
 * Exports a `Brain` as a portable SQLite file.
 *
 * **Usage:**
 * ```ts
 * const exporter = new SqliteExporter(brain);
 * await exporter.export('/path/to/backup.sqlite');
 * ```
 */
export class SqliteExporter {
  /**
   * @param brain - The `Brain` instance to export.
   */
  constructor(private readonly brain: Brain) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Write this brain's rows to a new SQLite file at `outputPath`.
   *
   * The rows keep this brain's id; importing the file into a brain with
   * another id forks it. Embeddings are copied as they are, so an import
   * needs no re-embedding.
   *
   * @param outputPath - Path for the SQLite file. Nothing may exist there yet,
   *   and its parent directory must exist.
   * @param _options   - Export options (unused: a SQLite export always
   *   includes every portable table and the embeddings).
   * @throws {Error} When a file already exists at `outputPath`.
   */
  async export(outputPath: string, _options?: ExportOptions): Promise<void> {
    await this.brain.exportToSqlite(outputPath);
  }
}
