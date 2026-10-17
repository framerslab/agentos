/**
 * @fileoverview Cross-platform SQLite importer for AgentOS memory brain.
 *
 * Opens a source SQLite file via `@framers/sql-storage-adapter` (supporting
 * better-sqlite3, sql.js, IndexedDB, etc.) and merges traces, knowledge
 * nodes, and edges into the target `Brain`.
 *
 * ## Merge strategy
 * - **memory_traces**: deduplicated by SHA-256 of `content` (or equal `content`)
 *   inside the trace's scope and scope id.
 *   - If a trace of the same scope and scope id with the same hash already
 *     exists in the target:
 *     - Keep the newer `created_at` timestamp.
 *     - Merge `tags` arrays (union, dedup).
 *   - A trace of another scope id is not a duplicate: its tags and time are
 *     left as they are.
 *   - New traces are inserted wholesale.
 * - **knowledge_nodes**: deduplicated by `label` + `type`.
 *   - New nodes are inserted; existing nodes are left unchanged.
 * - **knowledge_edges**: deduplicated by `source_id` + `target_id` + `type`.
 *   - New edges are inserted; existing edges are left unchanged.
 *
 * ## One brain per source
 * A database can hold several brains: every row of a brain's tables carries
 * the brain's id. The importer reads the rows of the one brain a source file
 * holds (`Memory.export` with format `'sqlite'` writes one) and refuses a file
 * whose rows carry several brain ids, naming them in `errors`. A file older
 * than the `brain_id` column holds one brain, and every row of it is read.
 *
 * @module memory/io/SqliteImporter
 */

import { sha256 as crossSha256 } from '../core/util/crossPlatformCrypto.js';
import { v4 as uuidv4 } from 'uuid';
import type { ImportOptions, ImportResult } from './facade/types.js';
import type { Brain } from '../retrieval/store/Brain.js';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';
import { importedScopeId } from './importScope.js';

// ---------------------------------------------------------------------------
// Internal row types (matched to Brain DDL)
// ---------------------------------------------------------------------------

interface TraceRow {
  id: string;
  type: string;
  scope: string;
  content: string;
  embedding: Uint8Array | null;
  strength: number;
  created_at: number;
  last_accessed: number | null;
  retrieval_count: number;
  tags: string;
  emotions: string;
  metadata: string;
  deleted: number;
  /** Present when the source is a schema-3 Brain; `metadata.scopeId` holds it too. */
  scope_id?: string;
}

interface NodeRow {
  id: string;
  type: string;
  label: string;
  properties: string;
  embedding: Uint8Array | null;
  confidence: number;
  source: string;
  created_at: number;
}

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  weight: number;
  bidirectional: number;
  metadata: string;
  created_at: number;
}

/** The tables the importer reads. */
const SOURCE_TABLES = ['memory_traces', 'knowledge_nodes', 'knowledge_edges'] as const;
type SourceTable = (typeof SOURCE_TABLES)[number];

/** The statement and parameters that read a source table's rows. */
type SourceRead = (table: SourceTable) => [sql: string, params: unknown[]];

// ---------------------------------------------------------------------------
// SqliteImporter
// ---------------------------------------------------------------------------

/**
 * Merges a source SQLite brain file into a target `Brain`.
 *
 * Uses `@framers/sql-storage-adapter` to open the source file, enabling
 * cross-platform operation (better-sqlite3, sql.js, IndexedDB).
 *
 * **Usage:**
 * ```ts
 * const importer = new SqliteImporter(targetBrain);
 * const result = await importer.import('/path/to/source.sqlite');
 * ```
 */
export class SqliteImporter {
  constructor(private readonly brain: Brain) {}

  /**
   * Open `sourcePath` via StorageAdapter, read all tables, and merge
   * their contents into the target brain.
   *
   * @param sourcePath - Absolute path to the source `.sqlite` file to import.
   * @returns `ImportResult` with counts of imported, skipped, and errored items.
   */
  async import(sourcePath: string, options?: Pick<ImportOptions, 'dedup'>): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, skipped: 0, errors: [] };

    // Check file exists before opening — resolveStorageAdapter creates new
    // files on open (SQLite behavior), which would hide missing-file errors.
    let sourceAdapter: StorageAdapter;
    try {
      const fs = await import('node:fs');
      if (!fs.existsSync(sourcePath)) {
        result.errors.push(`Cannot open source SQLite: file does not exist: ${sourcePath}`);
        return result;
      }
      sourceAdapter = await resolveStorageAdapter({
        filePath: sourcePath,
        quiet: true,
      });
    } catch (err) {
      result.errors.push(`Cannot open source SQLite: ${String(err)}`);
      return result;
    }

    try {
      const { brainIds, scoped } = await this._sourceBrains(sourceAdapter);
      if (brainIds.length > 1) {
        result.errors.push(
          `Cannot import a SQLite file that holds several brains (${brainIds.join(', ')}): ` +
            "import one brain's export (Memory.export with format 'sqlite').",
        );
        return result;
      }
      const read: SourceRead = (table) =>
        scoped.has(table) && brainIds.length === 1
          ? [`SELECT * FROM ${table} WHERE brain_id = ?`, [brainIds[0]]]
          : [`SELECT * FROM ${table}`, []];

      await this.brain.transaction(async (trx) => {
        await this._mergeTraces(sourceAdapter, read, result, trx, options);
        await this._mergeNodes(sourceAdapter, read, result, trx);
        await this._mergeEdges(sourceAdapter, read, result, trx);
      });
    } finally {
      await sourceAdapter.close();
    }

    return result;
  }

  /**
   * The brain ids the source's rows carry, and the tables that have the
   * `brain_id` column. A table missing from the file, or older than the
   * column, adds no id.
   */
  private async _sourceBrains(src: StorageAdapter): Promise<{ brainIds: string[]; scoped: Set<SourceTable> }> {
    const brainIds = new Set<string>();
    const scoped = new Set<SourceTable>();
    for (const table of SOURCE_TABLES) {
      let rows: { brain_id: string | null }[];
      try {
        const columns = await src.all<{ name: string }>(`PRAGMA table_info(${table})`);
        if (!columns.some((column) => column.name === 'brain_id')) continue;
        rows = await src.all<{ brain_id: string | null }>(`SELECT DISTINCT brain_id FROM ${table}`);
      } catch {
        // An unreadable table is skipped here as its merge skips it.
        continue;
      }
      scoped.add(table);
      for (const row of rows) {
        if (row.brain_id != null) brainIds.add(row.brain_id);
      }
    }
    return { brainIds: [...brainIds].sort(), scoped };
  }

  private async _sha256(s: string): Promise<string> {
    return crossSha256(s);
  }

  private async _mergeTraces(
    src: StorageAdapter,
    read: SourceRead,
    result: ImportResult,
    trx: { run: Brain['run']; get: Brain['get'] },
    options?: Pick<ImportOptions, 'dedup'>,
  ): Promise<void> {
    let sourceRows: TraceRow[];
    try {
      sourceRows = await src.all<TraceRow>(...read('memory_traces'));
    } catch {
      return;
    }

    const { dialect } = this.brain.features;
    const brainId = this.brain.brainId;
    const checkSql = `SELECT id, created_at, tags
       FROM memory_traces
       WHERE brain_id = ? AND scope = ? AND scope_id = ?
         AND (${dialect.jsonExtract('metadata', '$.import_hash')} = ?
              OR content = ?)
       LIMIT 1`;

    const insertSql = `INSERT INTO memory_traces
         (brain_id, id, type, scope, content, embedding, strength, created_at, last_accessed,
          retrieval_count, tags, emotions, metadata, deleted, scope_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const updateTimestampSql = `UPDATE memory_traces SET created_at = ?, tags = ? WHERE brain_id = ? AND id = ?`;

    for (const row of sourceRows) {
      try {
        const hash = await this._sha256(row.content);
        const scope = row.scope ?? 'user';

        // The metadata names the scope id, so it is read before the dedup check.
        let meta: Record<string, unknown> = {};
        try { meta = JSON.parse(row.metadata) as Record<string, unknown>; } catch { /* ignore */ }
        const scopeId = importedScopeId(meta, row.scope_id);

        if (options?.dedup ?? true) {
          const existing = await trx.get<{ id: string; created_at: number; tags: string }>(
            checkSql, [brainId, scope, scopeId, hash, row.content],
          );

          if (existing) {
            const newerAt = Math.max(existing.created_at, row.created_at);
            let existingTags: string[] = [];
            try { existingTags = JSON.parse(existing.tags) as string[]; } catch { /* ignore */ }
            let sourceTags: string[] = [];
            try { sourceTags = JSON.parse(row.tags) as string[]; } catch { /* ignore */ }
            const merged = Array.from(new Set([...existingTags, ...sourceTags]));
            await trx.run(updateTimestampSql, [newerAt, JSON.stringify(merged), brainId, existing.id]);
            result.skipped++;
            continue;
          }
        }

        meta['import_hash'] = hash;

        const id = await this._resolveTraceId(trx, row.id ?? `mt_${uuidv4()}`);

        await trx.run(insertSql, [
          brainId,
          id,
          row.type ?? 'episodic',
          scope,
          row.content,
          row.embedding ?? null,
          row.strength ?? 1.0,
          row.created_at ?? Date.now(),
          row.last_accessed ?? null,
          row.retrieval_count ?? 0,
          row.tags ?? '[]',
          row.emotions ?? '{}',
          JSON.stringify(meta),
          row.deleted ?? 0,
          scopeId,
        ]);

        result.imported++;
      } catch (err) {
        result.errors.push(`Trace merge error: ${String(err)}`);
      }
    }
  }

  private async _mergeNodes(
    src: StorageAdapter,
    read: SourceRead,
    result: ImportResult,
    trx: { run: Brain['run']; get: Brain['get'] },
  ): Promise<void> {
    let sourceRows: NodeRow[];
    try {
      sourceRows = await src.all<NodeRow>(...read('knowledge_nodes'));
    } catch {
      return;
    }

    const checkSql = `SELECT id FROM knowledge_nodes WHERE brain_id = ? AND label = ? AND type = ? LIMIT 1`;

    const { dialect } = this.brain.features;
    const brainId = this.brain.brainId;
    const insertSql = dialect.insertOrIgnore(
      'knowledge_nodes',
      ['brain_id', 'id', 'type', 'label', 'properties', 'embedding', 'confidence', 'source', 'created_at'],
      ['?', '?', '?', '?', '?', '?', '?', '?', '?'],
    );

    for (const row of sourceRows) {
      try {
        const existing = await trx.get<{ id: string }>(checkSql, [brainId, row.label ?? '', row.type ?? '']);
        if (existing) {
          result.skipped++;
          continue;
        }

        await trx.run(insertSql, [
          brainId,
          row.id ?? `kn_${uuidv4()}`,
          row.type ?? 'concept',
          row.label ?? '',
          row.properties ?? '{}',
          row.embedding ?? null,
          row.confidence ?? 1.0,
          row.source ?? '{}',
          row.created_at ?? Date.now(),
        ]);

        result.imported++;
      } catch (err) {
        result.errors.push(`Node merge error: ${String(err)}`);
      }
    }
  }

  private async _mergeEdges(
    src: StorageAdapter,
    read: SourceRead,
    result: ImportResult,
    trx: { run: Brain['run']; get: Brain['get'] },
  ): Promise<void> {
    let sourceRows: EdgeRow[];
    try {
      sourceRows = await src.all<EdgeRow>(...read('knowledge_edges'));
    } catch {
      return;
    }

    const checkSql = `SELECT id FROM knowledge_edges
       WHERE brain_id = ? AND source_id = ? AND target_id = ? AND type = ?
       LIMIT 1`;

    const { dialect } = this.brain.features;
    const brainId = this.brain.brainId;
    const insertSql = dialect.insertOrIgnore(
      'knowledge_edges',
      ['brain_id', 'id', 'source_id', 'target_id', 'type', 'weight', 'bidirectional', 'metadata', 'created_at'],
      ['?', '?', '?', '?', '?', '?', '?', '?', '?'],
    );

    for (const row of sourceRows) {
      try {
        if (!row.source_id || !row.target_id) {
          result.skipped++;
          continue;
        }

        const existing = await trx.get<{ id: string }>(
          checkSql, [brainId, row.source_id, row.target_id, row.type ?? ''],
        );
        if (existing) {
          result.skipped++;
          continue;
        }

        await trx.run(insertSql, [
          brainId,
          row.id ?? `ke_${uuidv4()}`,
          row.source_id,
          row.target_id,
          row.type ?? 'related_to',
          row.weight ?? 1.0,
          row.bidirectional ?? 0,
          row.metadata ?? '{}',
          row.created_at ?? Date.now(),
        ]);

        result.imported++;
      } catch (err) {
        result.errors.push(`Edge merge error: ${String(err)}`);
      }
    }
  }

  private async _resolveTraceId(
    trx: { get: Brain['get'] },
    preferredId: string,
  ): Promise<string> {
    const existing = await trx.get<{ id: string }>(
      'SELECT id FROM memory_traces WHERE brain_id = ? AND id = ? LIMIT 1',
      [this.brain.brainId, preferredId],
    );
    return existing ? `mt_${uuidv4()}` : preferredId;
  }
}
