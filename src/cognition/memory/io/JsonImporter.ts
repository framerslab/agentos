/**
 * @fileoverview JSON importer for AgentOS memory brain.
 *
 * Reads a JSON file produced by `JsonExporter` (or a compatible schema) and
 * merges traces, graph rows, documents, document chunks/images, conversations,
 * and messages into a target `Brain`.
 *
 * Trace deduplication is performed via SHA-256 content hash inside the trace's
 * scope and scope id by default, but it can be disabled via `{ dedup: false }`
 * on the importer or `Memory.importFrom`. A trace a release older than
 * `memory_traces.scope_id` wrote holds `''` in that column whatever scope id
 * its metadata names; the import files such traces under that scope id before
 * its first duplicate check (`fillScopeIds`).
 *
 * A trace's episodic copy written under another node id than its trace's key
 * (an export from a release older than keyed copies, or a copy whose key the
 * brain's own copy of the trace holds, written under a new id) is filed under
 * the key once the edges are in, with the relations that name it, so a delete
 * by its trace id finds it (`keyTraceCopies`); a copy whose key the brain's own
 * copy holds is deleted. A trace's copy comes in with its trace alone: the copy
 * of a trace the import merges into a trace the brain holds, writes under
 * another id because its id names another trace, or does not write, is
 * skipped, with the edges that name it.
 *
 * @module memory/io/JsonImporter
 */

import { sha256 } from '../core/util/crossPlatformCrypto.js';
import { v4 as uuidv4 } from 'uuid';
import type { ImportOptions, ImportResult } from './facade/types.js';
import type { Brain } from '../retrieval/store/Brain.js';
import { base64ToBytes } from './base64.js';
import { importedScopeId } from './importScope.js';
import { fillScopeIds } from '../retrieval/store/migrations/v2-to-v3.js';
import { keyTraceCopies, storedCopyTraceId } from '../retrieval/store/SqlKnowledgeGraph.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Expected shape of the JSON file produced by `JsonExporter`.
 * All fields except `traces` are optional so the importer is forgiving of
 * partial exports.
 */
interface BrainExportPayload {
  meta?: Record<string, string>;
  traces: TraceRecord[];
  nodes?: NodeRecord[];
  edges?: EdgeRecord[];
  documents?: DocumentRecord[];
  chunks?: DocumentChunkRecord[];
  images?: DocumentImageRecord[];
  conversations?: ConversationRecord[];
  messages?: MessageRecord[];
}

/** Serialised memory trace from the export file. */
interface TraceRecord {
  id?: string;
  type?: string;
  scope?: string;
  content: string;
  embedding?: string | null;   // base64 when present
  strength?: number;
  created_at?: number;
  last_accessed?: number | null;
  retrieval_count?: number;
  tags?: string;
  emotions?: string;
  metadata?: string;
  deleted?: number;
  /** The trace's scope id, in an export of a schema-3 Brain; `metadata.scopeId` holds it too. */
  scope_id?: string;
}

/** Serialised knowledge node. */
interface NodeRecord {
  id?: string;
  type?: string;
  label?: string;
  properties?: string;
  embedding?: string | null;
  confidence?: number;
  source?: string;
  created_at?: number;
}

/** Serialised knowledge edge. */
interface EdgeRecord {
  id?: string;
  source_id?: string;
  target_id?: string;
  type?: string;
  weight?: number;
  bidirectional?: number;
  metadata?: string;
  created_at?: number;
}

/** Serialised document record. */
interface DocumentRecord {
  id?: string;
  path?: string;
  format?: string;
  title?: string | null;
  content_hash?: string;
  chunk_count?: number;
  metadata?: string;
  ingested_at?: number;
}

/** Serialised document chunk record. */
interface DocumentChunkRecord {
  id?: string;
  document_id?: string;
  trace_id?: string | null;
  content?: string;
  chunk_index?: number;
  page_number?: number | null;
  embedding?: string | null;
}

/** Serialised document image record. */
interface DocumentImageRecord {
  id?: string;
  document_id?: string;
  chunk_id?: string | null;
  data?: string;
  mime_type?: string;
  caption?: string | null;
  page_number?: number | null;
  embedding?: string | null;
}

/** Serialised conversation record. */
interface ConversationRecord {
  id?: string;
  title?: string | null;
  created_at?: number;
  updated_at?: number;
  metadata?: string;
}

/** Serialised conversation message record. */
interface MessageRecord {
  id?: string;
  conversation_id?: string;
  role?: string;
  content?: string;
  created_at?: number;
  metadata?: string;
}

interface ImportContext {
  dedup: boolean;
  traceIds: Map<string, string>;
  /** The payload's trace ids. */
  sourceTraceIds: Set<string>;
  /** The payload's trace ids the import wrote, or matched as a duplicate, under that same id. */
  filedTraceIds: Set<string>;
  /** The payload ids of the copies left out, since their trace was not filed under its own id. */
  skippedNodeIds: Set<string>;
  nodeIds: Map<string, string>;
  documentIds: Map<string, string>;
  chunkIds: Map<string, string>;
  conversationIds: Map<string, string>;
}

// ---------------------------------------------------------------------------
// JsonImporter
// ---------------------------------------------------------------------------

/**
 * Imports a `JsonExporter`-compatible JSON file into a `Brain`.
 *
 * **Usage:**
 * ```ts
 * const importer = new JsonImporter(brain);
 * const result = await importer.import('/path/to/export.json');
 * console.log(result.imported, result.skipped, result.errors);
 * ```
 */
export class JsonImporter {
  /**
   * @param brain - The target `Brain` to import into.
   */
  constructor(private readonly brain: Brain) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Read and merge a JSON export file into the target brain.
   *
   * Validation:
   * - The file must be valid JSON.
   * - The top-level object must contain a `traces` array.
   *
   * Deduplication:
   * - For `memory_traces`: SHA-256 of `content` is used as the dedup key,
   *   inside the trace's scope and scope id. Existing rows of that scope and
   *   scope id with the same hash are skipped; a row of another scope id is not
   *   a duplicate.
   * - For `knowledge_nodes`: SHA-256 of `label` + `type`.
   * - For `knowledge_edges`: SHA-256 of `source_id` + `target_id` + `type`.
   *
   * @param sourcePath - Absolute path to the JSON file to import.
   * @returns `ImportResult` with counts of imported, skipped, and errored items.
   */
  async import(sourcePath: string, options?: Pick<ImportOptions, 'dedup'>): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, skipped: 0, errors: [] };

    // ---- Load + parse ----
    let raw: string;
    try {
      const fs = await import('node:fs/promises');
      raw = await fs.readFile(sourcePath, 'utf8');
    } catch (err) {
      result.errors.push(`Failed to read file: ${String(err)}`);
      return result;
    }

    return this._importParsed(raw, result, options);
  }

  /**
   * Import a JSON string directly into the target brain without filesystem access.
   *
   * @param jsonContent - The JSON string to parse and import.
   * @returns `ImportResult` with counts of imported, skipped, and errored items.
   */
  async importFromString(
    jsonContent: string,
    options?: Pick<ImportOptions, 'dedup'>,
  ): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, skipped: 0, errors: [] };
    return this._importParsed(jsonContent, result, options);
  }

  /**
   * Parse a raw JSON string and import its contents into the brain.
   *
   * @param raw    - The raw JSON string to parse.
   * @param result - Mutable `ImportResult` to accumulate counts.
   * @returns The populated `ImportResult`.
   */
  private async _importParsed(
    raw: string,
    result: ImportResult,
    options?: Pick<ImportOptions, 'dedup'>,
  ): Promise<ImportResult> {
    let payload: BrainExportPayload;
    try {
      payload = JSON.parse(raw) as BrainExportPayload;
    } catch (err) {
      result.errors.push(`Invalid JSON: ${String(err)}`);
      return result;
    }

    if (!Array.isArray(payload.traces)) {
      result.errors.push('Invalid export format: missing top-level "traces" array.');
      return result;
    }

    // ---- Import in a single transaction for atomicity ----
    const context: ImportContext = {
      dedup: options?.dedup ?? true,
      traceIds: new Map<string, string>(),
      sourceTraceIds: new Set<string>(),
      filedTraceIds: new Set<string>(),
      skippedNodeIds: new Set<string>(),
      nodeIds: new Map<string, string>(),
      documentIds: new Map<string, string>(),
      chunkIds: new Map<string, string>(),
      conversationIds: new Map<string, string>(),
    };

    await this.brain.transaction(async (trx) => {
      await this._importMeta(trx, payload.meta);
      // A trace an older release wrote holds scope_id '': filed under its scope id first, it is found there.
      if (context.dedup) await fillScopeIds(trx, this.brain.brainId);
      await this._importTraces(trx, payload.traces, result, context);
      const memoryNodes = await this._importNodes(trx, payload.nodes ?? [], result, context);
      await this._importEdges(trx, payload.edges ?? [], result, context);
      // A trace's copy is found by its trace's key: one written under another node id gets the key here.
      if (memoryNodes > 0) await keyTraceCopies(trx, this.brain.brainId);
      await this._importDocuments(trx, payload.documents ?? [], result, context);
      await this._importChunks(trx, payload.chunks ?? [], result, context);
      await this._importImages(trx, payload.images ?? [], result, context);
      await this._importConversations(trx, payload.conversations ?? [], result, context);
      await this._importMessages(trx, payload.messages ?? [], result, context);
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Compute a SHA-256 hex digest of arbitrary string content.
   * Used as a stable dedup key across import operations.
   *
   * @param content - The string to hash.
   * @returns 64-character lowercase hex string.
   */
  private async _sha256(content: string): Promise<string> {
    return sha256(content);
  }

  /**
   * Restore brain metadata keys from the export payload.
   *
   * `exported_at` is export-specific and intentionally ignored on import.
   */
  private async _importMeta(
    trx: { run: Brain['run'] },
    meta?: Record<string, string>,
  ): Promise<void> {
    if (!meta) return;
    const { dialect } = this.brain.features;
    const upsertSql = dialect.insertOrReplace(
      'brain_meta',
      ['brain_id', 'key', 'value'],
      ['?', '?', '?'],
      'brain_id, key',
    );

    for (const [key, value] of Object.entries(meta)) {
      if (key === 'exported_at') continue;
      await trx.run(upsertSql, [this.brain.brainId, key, value]);
    }
  }

  /**
   * Import memory trace records into `memory_traces`.
   *
   * Each trace is filed under its scope and scope id (see `importedScopeId`)
   * and deduplicated by the SHA-256 of its `content` field inside them: if a
   * trace of the same scope and scope id has the same content hash, the record
   * is skipped and its id maps to that trace's.
   *
   * @param trx    - Transactional storage adapter.
   * @param traces - Array of serialised trace objects from the export.
   * @param result - Mutable `ImportResult` to accumulate counts.
   */
  private async _importTraces(
    trx: { run: Brain['run']; get: Brain['get'] },
    traces: TraceRecord[],
    result: ImportResult,
    context: ImportContext,
  ): Promise<void> {
    const { dialect } = this.brain.features;
    const brainId = this.brain.brainId;
    const checkSql = `SELECT id FROM memory_traces
       WHERE brain_id = ? AND scope = ? AND scope_id = ?
         AND ${dialect.jsonExtract('metadata', '$.import_hash')} = ?
       LIMIT 1`;

    const insertSql = `INSERT INTO memory_traces
         (brain_id, id, type, scope, content, embedding, strength, created_at, last_accessed,
          retrieval_count, tags, emotions, metadata, deleted, scope_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    for (const t of traces) {
      if (t.id) context.sourceTraceIds.add(t.id);
      try {
        const hash = await this._sha256(t.content);
        const sourceId = t.id;
        const scope = t.scope ?? 'user';

        // The metadata names the scope id, so it is read before the dedup check.
        let meta: Record<string, unknown> = {};
        try {
          meta = JSON.parse(t.metadata ?? '{}') as Record<string, unknown>;
        } catch {
          // If metadata is malformed, start fresh.
        }
        const scopeId = importedScopeId(meta, t.scope_id);

        if (context.dedup) {
          const existing = await trx.get<{ id: string }>(checkSql, [brainId, scope, scopeId, hash]);
          if (existing) {
            if (sourceId) context.traceIds.set(sourceId, existing.id);
            if (sourceId && existing.id === sourceId) context.filedTraceIds.add(sourceId);
            result.skipped++;
            continue;
          }
        }

        // Merge import_hash into the metadata JSON so future imports can dedup.
        meta['import_hash'] = hash;

        // Decode embedding if present.
        let embeddingBuf: Uint8Array | null = null;
        if (typeof t.embedding === 'string') {
          embeddingBuf = base64ToBytes(t.embedding);
        }

        const id = await this._resolveUniqueId(
          trx,
          'memory_traces',
          sourceId ?? `mt_${uuidv4()}`,
          'mt_',
        );

        await trx.run(insertSql, [
          brainId,
          id,
          t.type ?? 'episodic',
          scope,
          t.content,
          embeddingBuf,
          t.strength ?? 1.0,
          t.created_at ?? Date.now(),
          t.last_accessed ?? null,
          t.retrieval_count ?? 0,
          t.tags ?? '[]',
          t.emotions ?? '{}',
          JSON.stringify(meta),
          t.deleted ?? 0,
          scopeId,
        ]);

        if (sourceId) context.traceIds.set(sourceId, id);
        if (sourceId && id === sourceId) context.filedTraceIds.add(sourceId);
        result.imported++;
      } catch (err) {
        result.errors.push(`Trace import error: ${String(err)}`);
      }
    }
  }

  /**
   * Import knowledge node records into `knowledge_nodes`.
   *
   * Dedup key: SHA-256 of `label` concatenated with `type`. The copy of a
   * payload trace the import did not file under its own id is skipped: it
   * would name a trace the brain does not hold under that id.
   *
   * @param trx    - Transactional storage adapter.
   * @param nodes  - Array of serialised node objects.
   * @param result - Mutable `ImportResult` to accumulate counts.
   * @returns How many of the nodes it wrote are of type `memory`.
   */
  private async _importNodes(
    trx: { run: Brain['run']; get: Brain['get'] },
    nodes: NodeRecord[],
    result: ImportResult,
    context: ImportContext,
  ): Promise<number> {
    let memoryNodes = 0;
    const { dialect } = this.brain.features;
    const brainId = this.brain.brainId;
    const checkSql = `SELECT id FROM knowledge_nodes WHERE brain_id = ? AND ${dialect.jsonExtract('properties', '$.import_hash')} = ? LIMIT 1`;

    const insertSql = dialect.insertOrIgnore(
      'knowledge_nodes',
      ['brain_id', 'id', 'type', 'label', 'properties', 'embedding', 'confidence', 'source', 'created_at'],
      ['?', '?', '?', '?', '?', '?', '?', '?', '?'],
    );

    for (const n of nodes) {
      try {
        // A trace's copy comes in with its trace alone.
        const copied = n.type === 'memory' ? storedCopyTraceId(n.properties) : undefined;
        if (copied !== undefined && context.sourceTraceIds.has(copied) && !context.filedTraceIds.has(copied)) {
          if (n.id) context.skippedNodeIds.add(n.id);
          result.skipped++;
          continue;
        }

        const hash = await this._sha256(`${n.label ?? ''}::${n.type ?? ''}`);
        const sourceId = n.id;
        const existing = await trx.get<{ id: string }>(checkSql, [brainId, hash]);
        if (existing) {
          if (sourceId) context.nodeIds.set(sourceId, existing.id);
          result.skipped++;
          continue;
        }

        let props: Record<string, unknown> = {};
        try {
          props = JSON.parse(n.properties ?? '{}') as Record<string, unknown>;
        } catch {
          // ignore malformed JSON
        }
        props['import_hash'] = hash;

        let embeddingBuf: Uint8Array | null = null;
        if (typeof n.embedding === 'string') {
          embeddingBuf = base64ToBytes(n.embedding);
        }

        const id = await this._resolveUniqueId(
          trx,
          'knowledge_nodes',
          sourceId ?? `kn_${uuidv4()}`,
          'kn_',
        );

        await trx.run(insertSql, [
          brainId,
          id,
          n.type ?? 'concept',
          n.label ?? '',
          JSON.stringify(props),
          embeddingBuf,
          n.confidence ?? 1.0,
          n.source ?? '{}',
          n.created_at ?? Date.now(),
        ]);

        if (sourceId) context.nodeIds.set(sourceId, id);
        if (n.type === 'memory') memoryNodes++;
        result.imported++;
      } catch (err) {
        result.errors.push(`Node import error: ${String(err)}`);
      }
    }
    return memoryNodes;
  }

  /**
   * Import knowledge edge records into `knowledge_edges`.
   *
   * Dedup key: SHA-256 of `source_id + target_id + type`.
   * Edges referencing non-existent nodes are silently skipped (FK constraint),
   * and an edge that names a copy the node import skipped is skipped.
   *
   * @param trx    - Transactional storage adapter.
   * @param edges  - Array of serialised edge objects.
   * @param result - Mutable `ImportResult` to accumulate counts.
   */
  private async _importEdges(
    trx: { run: Brain['run']; get: Brain['get'] },
    edges: EdgeRecord[],
    result: ImportResult,
    context: ImportContext,
  ): Promise<void> {
    const { dialect } = this.brain.features;
    const brainId = this.brain.brainId;
    const checkSql = `SELECT id FROM knowledge_edges WHERE brain_id = ? AND ${dialect.jsonExtract('metadata', '$.import_hash')} = ? LIMIT 1`;

    const insertSql = dialect.insertOrIgnore(
      'knowledge_edges',
      ['brain_id', 'id', 'source_id', 'target_id', 'type', 'weight', 'bidirectional', 'metadata', 'created_at'],
      ['?', '?', '?', '?', '?', '?', '?', '?', '?'],
    );

    for (const e of edges) {
      try {
        if ((e.source_id && context.skippedNodeIds.has(e.source_id)) || (e.target_id && context.skippedNodeIds.has(e.target_id))) {
          result.skipped++;
          continue;
        }
        const sourceId = e.source_id ? (context.nodeIds.get(e.source_id) ?? e.source_id) : null;
        const targetId = e.target_id ? (context.nodeIds.get(e.target_id) ?? e.target_id) : null;
        if (!sourceId || !targetId) {
          result.skipped++;
          continue;
        }

        const hash = await this._sha256(`${sourceId}::${targetId}::${e.type ?? ''}`);
        const existing = await trx.get<{ id: string }>(checkSql, [brainId, hash]);
        if (existing) {
          result.skipped++;
          continue;
        }

        let meta: Record<string, unknown> = {};
        try {
          meta = JSON.parse(e.metadata ?? '{}') as Record<string, unknown>;
        } catch {
          // ignore malformed JSON
        }
        meta['import_hash'] = hash;

        await trx.run(insertSql, [
          brainId,
          await this._resolveUniqueId(
            trx,
            'knowledge_edges',
            e.id ?? `ke_${uuidv4()}`,
            'ke_',
          ),
          sourceId,
          targetId,
          e.type ?? 'related_to',
          e.weight ?? 1.0,
          e.bidirectional ?? 0,
          JSON.stringify(meta),
          e.created_at ?? Date.now(),
        ]);

        result.imported++;
      } catch (err) {
        // FK constraint violation (referenced node doesn't exist) is common
        // when importing partial exports — log but don't fail.
        result.errors.push(`Edge import error: ${String(err)}`);
      }
    }
  }

  /**
   * Import document registry rows.
   *
   * Documents are deduplicated by their exported `id`.
   */
  private async _importDocuments(
    trx: { run: Brain['run']; get: Brain['get'] },
    documents: DocumentRecord[],
    result: ImportResult,
    context: ImportContext,
  ): Promise<void> {
    const { dialect } = this.brain.features;
    const brainId = this.brain.brainId;
    const checkSql = 'SELECT id FROM documents WHERE brain_id = ? AND id = ? LIMIT 1';
    const upsertSql = dialect.insertOrReplace(
      'documents',
      ['brain_id', 'id', 'path', 'format', 'title', 'content_hash', 'chunk_count', 'metadata', 'ingested_at'],
      ['?', '?', '?', '?', '?', '?', '?', '?', '?'],
      'brain_id, id',
    );

    for (const doc of documents) {
      try {
        const sourceId = doc.id;
        const id = sourceId ?? `doc_${uuidv4()}`;
        const existing = await trx.get<{ id: string }>(checkSql, [brainId, id]);
        if (existing) {
          if (sourceId) context.documentIds.set(sourceId, existing.id);
          result.skipped++;
          continue;
        }

        await trx.run(upsertSql, [
          brainId,
          id,
          doc.path ?? '',
          doc.format ?? 'unknown',
          doc.title ?? null,
          doc.content_hash ?? '',
          doc.chunk_count ?? 0,
          doc.metadata ?? '{}',
          doc.ingested_at ?? Date.now(),
        ]);
        if (sourceId) context.documentIds.set(sourceId, id);
        result.imported++;
      } catch (err) {
        result.errors.push(`Document import error: ${String(err)}`);
      }
    }
  }

  /**
   * Import document chunk rows.
   */
  private async _importChunks(
    trx: { run: Brain['run']; get: Brain['get'] },
    chunks: DocumentChunkRecord[],
    result: ImportResult,
    context: ImportContext,
  ): Promise<void> {
    const brainId = this.brain.brainId;
    const checkSql = 'SELECT id FROM document_chunks WHERE brain_id = ? AND id = ? LIMIT 1';
    const insertSql = `INSERT INTO document_chunks
         (brain_id, id, document_id, trace_id, content, chunk_index, page_number, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

    for (const chunk of chunks) {
      try {
        const sourceId = chunk.id;
        const id = sourceId ?? `chunk_${uuidv4()}`;
        const existing = await trx.get<{ id: string }>(checkSql, [brainId, id]);
        if (existing) {
          if (sourceId) context.chunkIds.set(sourceId, existing.id);
          result.skipped++;
          continue;
        }

        const documentId = chunk.document_id
          ? (context.documentIds.get(chunk.document_id) ?? chunk.document_id)
          : null;
        if (!documentId || !chunk.content) {
          result.skipped++;
          continue;
        }

        const traceId = chunk.trace_id
          ? (context.traceIds.get(chunk.trace_id) ?? chunk.trace_id)
          : null;

        const embedding = typeof chunk.embedding === 'string'
          ? base64ToBytes(chunk.embedding)
          : null;

        await trx.run(insertSql, [
          brainId,
          id,
          documentId,
          traceId,
          chunk.content,
          chunk.chunk_index ?? 0,
          chunk.page_number ?? null,
          embedding,
        ]);

        if (sourceId) context.chunkIds.set(sourceId, id);
        result.imported++;
      } catch (err) {
        result.errors.push(`Chunk import error: ${String(err)}`);
      }
    }
  }

  /**
   * Import document image rows.
   */
  private async _importImages(
    trx: { run: Brain['run']; get: Brain['get'] },
    images: DocumentImageRecord[],
    result: ImportResult,
    context: ImportContext,
  ): Promise<void> {
    const brainId = this.brain.brainId;
    const checkSql = 'SELECT id FROM document_images WHERE brain_id = ? AND id = ? LIMIT 1';
    const insertSql = `INSERT INTO document_images
         (brain_id, id, document_id, chunk_id, data, mime_type, caption, page_number, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    for (const image of images) {
      try {
        const id = image.id ?? `img_${uuidv4()}`;
        const existing = await trx.get<{ id: string }>(checkSql, [brainId, id]);
        if (existing) {
          result.skipped++;
          continue;
        }

        const documentId = image.document_id
          ? (context.documentIds.get(image.document_id) ?? image.document_id)
          : null;
        if (!documentId || !image.data || !image.mime_type) {
          result.skipped++;
          continue;
        }

        const chunkId = image.chunk_id
          ? (context.chunkIds.get(image.chunk_id) ?? image.chunk_id)
          : null;
        const data = base64ToBytes(image.data);
        const embedding = typeof image.embedding === 'string'
          ? base64ToBytes(image.embedding)
          : null;

        await trx.run(insertSql, [
          brainId,
          id,
          documentId,
          chunkId,
          data,
          image.mime_type,
          image.caption ?? null,
          image.page_number ?? null,
          embedding,
        ]);

        result.imported++;
      } catch (err) {
        result.errors.push(`Image import error: ${String(err)}`);
      }
    }
  }

  /**
   * Import conversation session rows.
   *
   * Conversation session rows are imported before messages so message foreign
   * keys can be remapped safely when IDs collide or sessions already exist.
   */
  private async _importConversations(
    trx: { run: Brain['run']; get: Brain['get'] },
    conversations: ConversationRecord[],
    result: ImportResult,
    context: ImportContext,
  ): Promise<void> {
    const { dialect } = this.brain.features;
    const brainId = this.brain.brainId;
    const checkSql = 'SELECT id FROM conversations WHERE brain_id = ? AND id = ? LIMIT 1';
    const upsertSql = dialect.insertOrReplace(
      'conversations',
      ['brain_id', 'id', 'title', 'created_at', 'updated_at', 'metadata'],
      ['?', '?', '?', '?', '?', '?'],
      'brain_id, id',
    );

    for (const convo of conversations) {
      try {
        const sourceId = convo.id;
        const id = sourceId ?? `conv_${uuidv4()}`;
        const existing = await trx.get<{ id: string }>(checkSql, [brainId, id]);
        if (existing) {
          if (sourceId) context.conversationIds.set(sourceId, existing.id);
          result.skipped++;
          continue;
        }

        const createdAt = convo.created_at ?? Date.now();
        await trx.run(upsertSql, [
          brainId,
          id,
          convo.title ?? null,
          createdAt,
          convo.updated_at ?? createdAt,
          convo.metadata ?? '{}',
        ]);
        if (sourceId) context.conversationIds.set(sourceId, id);
        result.imported++;
      } catch (err) {
        result.errors.push(`Conversation import error: ${String(err)}`);
      }
    }
  }

  /**
   * Import conversation message rows.
   */
  private async _importMessages(
    trx: { run: Brain['run']; get: Brain['get'] },
    messages: MessageRecord[],
    result: ImportResult,
    context: ImportContext,
  ): Promise<void> {
    const brainId = this.brain.brainId;
    const checkSql = 'SELECT id FROM messages WHERE brain_id = ? AND id = ? LIMIT 1';
    const insertSql = `INSERT INTO messages
         (brain_id, id, conversation_id, role, content, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`;

    for (const message of messages) {
      try {
        const id = message.id ?? `msg_${uuidv4()}`;
        const existing = await trx.get<{ id: string }>(checkSql, [brainId, id]);
        if (existing) {
          result.skipped++;
          continue;
        }

        const conversationId = message.conversation_id
          ? (context.conversationIds.get(message.conversation_id) ?? message.conversation_id)
          : null;
        if (!conversationId || !message.role || !message.content) {
          result.skipped++;
          continue;
        }

        await trx.run(insertSql, [
          brainId,
          id,
          conversationId,
          message.role,
          message.content,
          message.created_at ?? Date.now(),
          message.metadata ?? '{}',
        ]);

        result.imported++;
      } catch (err) {
        result.errors.push(`Message import error: ${String(err)}`);
      }
    }
  }

  private async _resolveUniqueId(
    trx: { get: Brain['get'] },
    table: string,
    preferredId: string,
    prefix: string,
  ): Promise<string> {
    const existing = await trx.get<{ id: string }>(
      `SELECT id FROM ${table} WHERE brain_id = ? AND id = ? LIMIT 1`,
      [this.brain.brainId, preferredId],
    );
    return existing ? `${prefix}${uuidv4()}` : preferredId;
  }
}
