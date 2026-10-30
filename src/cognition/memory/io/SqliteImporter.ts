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
 *   - A trace a release older than `memory_traces.scope_id` wrote to the
 *     target holds `''` in that column whatever scope id its metadata names;
 *     the import files such traces under that scope id before it merges
 *     (`fillScopeIds`), so a source record of another scope id never merges
 *     into one.
 *   - New traces are inserted wholesale.
 * - **knowledge_nodes**: deduplicated by `label` + `type`.
 *   - New nodes are inserted; existing nodes are left unchanged.
 *   - A trace's episodic copy the file holds under another node id than its
 *     trace's key (a release older than keyed copies recorded it so) is filed
 *     under the key once the edges are in, with the relations that name it,
 *     so a delete by its trace id finds it (`keyTraceCopies`); a copy whose
 *     key the brain's own copy of the trace holds is deleted.
 *   - A trace's copy comes in with its trace alone: the copy of a source
 *     trace merged into a trace the brain holds, or written under another id
 *     because its id names another trace, or not written, is skipped, with
 *     the edges that name it. A delete of the trace the brain holds then
 *     leaves none of its words in the graph.
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
 * ## A Brain's scope-id form
 * A Brain a learning layer serves holds its plain `user` and `persona` scope
 * ids in the encoded form, and says so in `brain_meta` (`scope_id_form`; see
 * `scopeIdForm.ts`). The source's form is the record of the brain it holds:
 * its rows are read with the record read before and after them, and read
 * again when a re-file of the file committed in between. A plain source goes
 * into a Brain that holds the record with its ids encoded as they are written,
 * each trace's knowledge-graph copy with it. A source with the record goes
 * into a Brain without it, which then gets the record, unless that Brain holds
 * a plain id the record would read as another, in a trace or a copy: then
 * nothing is imported and `errors` names the record. The Brain's form is read
 * in the transaction the import writes in, so a re-file or another import of
 * the Brain that commits first is followed.
 *
 * @module memory/io/SqliteImporter
 */

import { sha256 as crossSha256 } from '../core/util/crossPlatformCrypto.js';
import { v4 as uuidv4 } from 'uuid';
import type { ImportOptions, ImportResult } from './facade/types.js';
import type { Brain } from '../retrieval/store/Brain.js';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';
import { duplicateTraceCondition, duplicateTraceParams, importedScopeId } from './importScope.js';
import { fillScopeIds } from '../retrieval/store/migrations/v2-to-v3.js';
import { keyTraceCopies, storedCopyTraceId } from '../retrieval/store/SqlKnowledgeGraph.js';
import { parseTraceMetadata } from '../retrieval/store/tracePersistence.js';
import {
  encodedCopyProperties,
  encodePlainScopeId,
  importScopeIdFormDecision,
  readInOneScopeIdForm,
  readScopeIdFormRecord,
  SCOPE_ID_FORM_KEY,
  writeScopeIdFormRecord,
} from '../retrieval/store/scopeIdForm.js';

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

/** The source's rows of each table it reads; `null` for a table the file does not hold or that cannot be read. */
interface SourceRows {
  traces: TraceRow[] | null;
  nodes: NodeRow[] | null;
  edges: EdgeRow[] | null;
}

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

      // The source's form is its brain's record. Its rows are read with the record read before and after them, and
      // read again when a re-file of the file committed in between, so they are in the form the record names.
      const sourceBrainId = brainIds.length === 1 ? brainIds[0]! : undefined;
      const { value: rows, encoded: sourceEncoded } = await readInOneScopeIdForm(
        async () => sourceBrainId !== undefined && (await readScopeIdFormRecord(sourceAdapter, sourceBrainId)),
        async (): Promise<SourceRows> => ({
          traces: await this._readSource<TraceRow>(sourceAdapter, read, 'memory_traces'),
          nodes: await this._readSource<NodeRow>(sourceAdapter, read, 'knowledge_nodes'),
          edges: await this._readSource<EdgeRow>(sourceAdapter, read, 'knowledge_edges'),
        }),
      );

      let traces = { inserted: 0, retagged: 0 };
      await this.brain.transaction(async (trx) => {
        // The Brain's form is read in the transaction the import writes in, so a re-file or another import that
        // commits first is followed (on Postgres the import waits for the brain's form lock).
        const decision = await importScopeIdFormDecision(trx, this.brain, { encoded: sourceEncoded });
        if (decision.action === 'refuse') {
          result.errors.push(`${SCOPE_ID_FORM_KEY}: ${decision.reason}`);
          return;
        }
        if (decision.action === 'record') await writeScopeIdFormRecord(trx, this.brain);
        const encodePlainIds = decision.action === 'encode';
        // A trace an older release wrote holds scope_id '': filed under its scope id first, it is matched there.
        if (options?.dedup ?? true) await fillScopeIds(trx, this.brain.brainId);
        const merged = await this._mergeTraces(rows.traces, result, trx, options, encodePlainIds);
        traces = merged;
        const nodes = await this._mergeNodes(rows.nodes, result, trx, merged.unfiled, encodePlainIds);
        await this._mergeEdges(rows.edges, result, trx, nodes.skipped);
        // A trace's copy is found by its trace's key: one the file holds under another node id gets the key here.
        if (nodes.memoryNodes > 0) await keyTraceCopies(trx, this.brain.brainId);
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

  /** One source table's rows, or `null` when the file does not hold the table or it cannot be read. */
  private async _readSource<T>(src: StorageAdapter, read: SourceRead, table: SourceTable): Promise<T[] | null> {
    try {
      return await src.all<T>(...read(table));
    } catch {
      return null;
    }
  }

  /**
   * Insert the source's traces, or merge a duplicate's tags and time into
   * the trace the brain holds.
   *
   * @param sourceRows - The source's traces; `null` when it holds none it
   *   can read.
   * @param encodePlainIds - Encode the source's plain user and persona ids as
   *   they are written (an import into a Brain that holds the encoded form).
   * @returns How many traces it inserted, how many held traces a merge gave
   *   new tags, and the ids of the source traces it did not write under their
   *   own id (merged into a trace of another id, written under a new id, or
   *   not written), whose copies stay out.
   */
  private async _mergeTraces(
    sourceRows: TraceRow[] | null,
    result: ImportResult,
    trx: { run: Brain['run']; get: Brain['get'] },
    options: Pick<ImportOptions, 'dedup'> | undefined,
    encodePlainIds: boolean,
  ): Promise<{ inserted: number; retagged: number; unfiled: Set<string> }> {
    let inserted = 0;
    let retagged = 0;
    const seen = new Set<string>();
    const filed = new Set<string>();
    const unfiledOf = (): Set<string> => new Set([...seen].filter((id) => !filed.has(id)));
    if (!sourceRows) return { inserted, retagged, unfiled: unfiledOf() };

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

    for (const row of sourceRows) {
      if (row.id) seen.add(row.id);
      try {
        const hash = await this._sha256(row.content);
        const scope = row.scope ?? 'user';

        // The metadata names the scope id, so it is read before the dedup check. Metadata that is not a JSON object
        // (malformed text, an array, null) starts fresh: the object stored names the scope id and the import hash.
        const meta = parseTraceMetadata(row.metadata);
        let scopeId = importedScopeId(meta, row.scope_id);
        if (encodePlainIds) {
          scopeId = encodePlainScopeId(scope, scopeId);
          if (scopeId !== '') meta.scopeId = scopeId;
        }

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
   * label and type for. The copy of a source trace the import did not write
   * under its own id is skipped: it would name a trace the brain does not
   * hold under that id.
   *
   * @param sourceRows - The source's nodes; `null` when it holds none it can
   *   read.
   * @param unfiled - The source trace ids the trace merge did not write
   *   under their own id.
   * @param encodePlainIds - Write a trace's copy under its trace's scope id
   *   in the encoded form, as the trace merge writes the trace.
   * @returns How many of the nodes it wrote are of type `memory`, and the ids
   *   of the copies it skipped, whose edges stay out too.
   */
  private async _mergeNodes(
    sourceRows: NodeRow[] | null,
    result: ImportResult,
    trx: { run: Brain['run']; get: Brain['get'] },
    unfiled: ReadonlySet<string>,
    encodePlainIds: boolean,
  ): Promise<{ memoryNodes: number; skipped: Set<string> }> {
    let memoryNodes = 0;
    const skipped = new Set<string>();
    if (!sourceRows) return { memoryNodes, skipped };

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
        // A trace's copy comes in with its trace alone.
        const copied = row.type === 'memory' ? storedCopyTraceId(row.properties) : undefined;
        if (copied !== undefined && unfiled.has(copied)) {
          if (row.id) skipped.add(row.id);
          result.skipped++;
          continue;
        }

        const existing = await trx.get<{ id: string }>(checkSql, [brainId, row.label ?? '', row.type ?? '']);
        if (existing) {
          result.skipped++;
          continue;
        }

        const properties = row.properties ?? '{}';
        await trx.run(insertSql, [
          brainId,
          row.id ?? `kn_${uuidv4()}`,
          row.type ?? 'concept',
          row.label ?? '',
          encodePlainIds && row.type === 'memory' && typeof properties === 'string' ? encodedCopyProperties(properties) : properties,
          row.embedding ?? null,
          row.confidence ?? 1.0,
          row.source ?? '{}',
          row.created_at ?? Date.now(),
        ]);

        if (row.type === 'memory') memoryNodes++;
        result.imported++;
      } catch (err) {
        result.errors.push(`Node merge error: ${String(err)}`);
      }
    }
    return { memoryNodes, skipped };
  }

  /**
   * Insert the source's knowledge edges the brain has no edge of the same
   * source, target and type for, except those that name a copy the node
   * merge skipped.
   */
  private async _mergeEdges(
    sourceRows: EdgeRow[] | null,
    result: ImportResult,
    trx: { run: Brain['run']; get: Brain['get'] },
    skippedNodes: ReadonlySet<string>,
  ): Promise<void> {
    if (!sourceRows) return;

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
