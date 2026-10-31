/**
 * @fileoverview Cross-platform SQLite importer for AgentOS memory brain.
 *
 * Opens a source SQLite file via `@framers/sql-storage-adapter` (supporting
 * better-sqlite3, sql.js, IndexedDB, etc.) and merges traces, knowledge
 * nodes, and edges into the target `Brain`.
 *
 * ## Merge strategy
 * - **memory_traces**: deduplicated inside the trace's scope and scope id: a
 *   trace there with equal `content`, or whose metadata names the SHA-256 of
 *   that text as `import_hash` or `content_hash`, is the duplicate, whichever
 *   writer stored it.
 *   - If such a trace already exists in the target:
 *     - Keep the newer `created_at` timestamp.
 *     - Merge `tags` arrays (union, dedup).
 *   - A trace of another scope id is not a duplicate: its tags and time are
 *     left as they are.
 *   - The source's live rows are read before its forgotten ones
 *     (`liveRecordsFirst`), so a text the source holds both forgotten and live
 *     arrives live, and the forgotten row merges into that trace.
 *   - A trace a release older than `memory_traces.scope_id` wrote to the
 *     target holds `''` in that column whatever scope id its metadata names;
 *     the import files such traces under that scope id before it merges
 *     (`fillScopeIds`), so a source record of another scope id never merges
 *     into one.
 *   - New traces are inserted wholesale.
 * - **knowledge_nodes**: deduplicated by `label` + `type`.
 *   - New nodes are inserted; existing nodes are left unchanged.
 *   - A trace's memory-graph node (`type` `memory_graph`, whose id is its
 *     trace's) comes in with its trace alone, under that id
 *     (`memoryGraphNodeImport`): the node of a source trace merged into a
 *     trace of another id, written under a new id, or not written, or of a
 *     trace the brain does not hold, is skipped, with the edges that name it;
 *     a node the brain holds under that id is its duplicate.
 * - **knowledge_edges**: deduplicated by `source_id` + `target_id` + `type`.
 *   - New edges are inserted; existing edges are left unchanged.
 *
 * ## Full-text index
 * The brain's full-text index covers each trace's content and tags. Once the
 * import has committed, the importer rebuilds it, once, when the import
 * inserted a trace or a merge gave a trace the brain holds new tags.
 * `Memory.importFrom` does not rebuild it again after a SQLite import.
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
import {
  duplicateTraceCondition,
  duplicateTraceParams,
  importedScopeId,
  isForgottenRecord,
  liveRecordsFirst,
  MEMORY_GRAPH_NODE_TYPE,
  memoryGraphNodeImport,
} from './importScope.js';
import { fillScopeIds } from '../retrieval/store/migrations/v2-to-v3.js';
import { parseTraceMetadata } from '../retrieval/store/tracePersistence.js';

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

      let traces: { inserted: number; retagged: number; unfiled: Set<string> } = {
        inserted: 0,
        retagged: 0,
        unfiled: new Set<string>(),
      };
      await this.brain.transaction(async (trx) => {
        // A trace an older release wrote holds scope_id '': filed under its scope id first, it is matched there.
        if (options?.dedup ?? true) await fillScopeIds(trx, this.brain.brainId);
        traces = await this._mergeTraces(sourceAdapter, read, result, trx, options);
        const skippedNodes = await this._mergeNodes(sourceAdapter, read, result, trx, traces.unfiled);
        await this._mergeEdges(sourceAdapter, read, result, trx, skippedNodes);
      });
      // The inserts are not synced into the full-text index, and a tag merge
      // rewrites a held trace's tags in place and counts as skipped. One
      // rebuild covers both, here rather than in each caller: a caller that
      // rebuilt after inserts alone would miss a merge.
      if (traces.inserted > 0 || traces.retagged > 0) {
        await this._rebuildFullTextIndex();
      }
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

  /**
   * Insert the source's traces, or merge a duplicate's tags and time into
   * the trace the brain holds. The source's live rows are read before its
   * forgotten ones (see `liveRecordsFirst`).
   *
   * @returns How many traces it inserted, how many held traces a merge gave
   *   new tags, and the ids of the source traces it did not write, or match
   *   as a duplicate, under their own id (merged into a trace of another id,
   *   written under a new id, or not written), whose memory-graph nodes stay
   *   out.
   */
  private async _mergeTraces(
    src: StorageAdapter,
    read: SourceRead,
    result: ImportResult,
    trx: { run: Brain['run']; get: Brain['get'] },
    options?: Pick<ImportOptions, 'dedup'>,
  ): Promise<{ inserted: number; retagged: number; unfiled: Set<string> }> {
    let inserted = 0;
    let retagged = 0;
    const seen = new Set<string>();
    const filed = new Set<string>();
    const unfiledOf = (): Set<string> => new Set([...seen].filter((id) => !filed.has(id)));
    let sourceRows: TraceRow[];
    try {
      sourceRows = await src.all<TraceRow>(...read('memory_traces'));
    } catch {
      return { inserted, retagged, unfiled: unfiledOf() };
    }

    const brainId = this.brain.brainId;
    const checkSql = `SELECT id, created_at, tags
       FROM memory_traces
       WHERE brain_id = ? AND scope = ? AND scope_id = ?
         AND ${duplicateTraceCondition(this.brain)}
       LIMIT 1`;

    const insertSql = `INSERT INTO memory_traces
         (brain_id, id, type, scope, content, embedding, strength, created_at, last_accessed,
          retrieval_count, tags, emotions, metadata, deleted, scope_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const updateTimestampSql = `UPDATE memory_traces SET created_at = ?, tags = ? WHERE brain_id = ? AND id = ?`;

    for (const row of liveRecordsFirst(sourceRows, isForgottenRecord)) {
      if (row.id) seen.add(row.id);
      try {
        const hash = await this._sha256(row.content);
        const scope = row.scope ?? 'user';

        // The metadata names the scope id, so it is read before the dedup check. Metadata that is not a JSON object
        // (malformed text, an array, null) starts fresh: the object stored names the scope id and the import hash.
        const meta = parseTraceMetadata(row.metadata);
        const scopeId = importedScopeId(meta, row.scope_id);

        if (options?.dedup ?? true) {
          const existing = await trx.get<{ id: string; created_at: number; tags: string }>(
            checkSql, [brainId, scope, scopeId, ...duplicateTraceParams(hash, row.content)],
          );

          if (existing) {
            const newerAt = Math.max(existing.created_at, row.created_at);
            let existingTags: string[] = [];
            try { existingTags = JSON.parse(existing.tags) as string[]; } catch { /* ignore */ }
            let sourceTags: string[] = [];
            try { sourceTags = JSON.parse(row.tags) as string[]; } catch { /* ignore */ }
            const merged = JSON.stringify(Array.from(new Set([...existingTags, ...sourceTags])));
            await trx.run(updateTimestampSql, [newerAt, merged, brainId, existing.id]);
            if (merged !== existing.tags) retagged++;
            if (row.id && existing.id === row.id) filed.add(row.id);
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

        if (row.id && id === row.id) filed.add(row.id);
        inserted++;
        result.imported++;
      } catch (err) {
        result.errors.push(`Trace merge error: ${String(err)}`);
      }
    }
    return { inserted, retagged, unfiled: unfiledOf() };
  }

  /**
   * Rebuild the brain's full-text index (best-effort) with the statement
   * `Brain.fullTextRebuild` returns: the whole index on SQLite, the `_tsv`
   * column of the brain's rows on Postgres. The import's rows are committed,
   * so a failure is logged and never fails the import.
   */
  private async _rebuildFullTextIndex(): Promise<void> {
    try {
      const rebuild = this.brain.fullTextRebuild();
      await this.brain.run(rebuild.sql, rebuild.params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A database the index was never created in has nothing to rebuild.
      if (message.includes('no such module: fts5') || message.includes('no such table: memory_traces_fts')) {
        return;
      }
      console.warn(
        `[SqliteImporter] full-text index rebuild after an import failed for brain ${this.brain.brainId}: ${message}`,
      );
    }
  }

  /**
   * Insert the source's knowledge nodes the brain has no node of the same
   * label and type for. A memory-graph node comes in with its trace alone,
   * under its trace's id (see `memoryGraphNodeImport`).
   *
   * @param unfiled - The source trace ids the trace merge did not write, or
   *   match as a duplicate, under their own id.
   * @returns The ids of the memory-graph nodes it skipped, whose edges stay
   *   out too.
   */
  private async _mergeNodes(
    src: StorageAdapter,
    read: SourceRead,
    result: ImportResult,
    trx: { run: Brain['run']; get: Brain['get'] },
    unfiled: ReadonlySet<string>,
  ): Promise<Set<string>> {
    const skipped = new Set<string>();
    let sourceRows: NodeRow[];
    try {
      sourceRows = await src.all<NodeRow>(...read('knowledge_nodes'));
    } catch {
      return skipped;
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
        if (row.type === MEMORY_GRAPH_NODE_TYPE) {
          const take = await memoryGraphNodeImport(trx, brainId, row.id, (traceId) => unfiled.has(traceId));
          if (take.action !== 'write') {
            if (take.action === 'skip' && typeof row.id === 'string') skipped.add(row.id);
            result.skipped++;
            continue;
          }
        } else {
          const existing = await trx.get<{ id: string }>(checkSql, [brainId, row.label ?? '', row.type ?? '']);
          if (existing) {
            result.skipped++;
            continue;
          }
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
    return skipped;
  }

  /**
   * Insert the source's knowledge edges the brain has no edge of the same
   * source, target and type for, except those that name a memory-graph node
   * the node merge skipped.
   */
  private async _mergeEdges(
    src: StorageAdapter,
    read: SourceRead,
    result: ImportResult,
    trx: { run: Brain['run']; get: Brain['get'] },
    skippedNodes: ReadonlySet<string>,
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
        if (!row.source_id || !row.target_id || skippedNodes.has(row.source_id) || skippedNodes.has(row.target_id)) {
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
