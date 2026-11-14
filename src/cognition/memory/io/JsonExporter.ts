/**
 * @fileoverview JSON exporter for AgentOS memory brain.
 *
 * Serialises all memory traces, knowledge graph nodes/edges, document registry
 * rows, document chunks/images, conversations, conversation messages, the
 * registry of conversation scopes and each subject's wiki pages from
 * a `Brain` into a single structured JSON file.
 * Optionally includes raw embedding vectors encoded as base64 strings.
 *
 * ## Output shape
 * ```json
 * {
 *   "meta": { "schema_version": "1", "exported_at": 1711234567890, ... },
 *   "traces": [...],
 *   "nodes": [...],
 *   "edges": [...],
 *   "documents": [...],
 *   "chunks": [...],
 *   "images": [...],
 *   "conversations": [...],
 *   "messages": [...],
 *   "scopes": [...],
 *   "pages": [...],
 *   "legacyOwners": [...]
 * }
 * ```
 *
 * `scopes` holds the brain's registry of conversation scopes (`memory_scopes`, each with its compile watermark),
 * `pages` each subject's wiki pages (`memory_pages`, each listing the ids of its chunks among `traces`), and
 * `legacyOwners` the user each agent's memory from before per-user scope is attributed to (`memory_legacy_owner`).
 *
 * A Brain a learning layer serves writes its record of the encoded scope-id
 * form into `meta` (`scope_id_form`), which an import reads as the export's
 * form. The record and the rows come from one form: when a re-file commits
 * while the export reads, the export reads again.
 *
 * @module memory/io/JsonExporter
 */

import type { ExportOptions } from './facade/types.js';
import type { Brain } from '../retrieval/store/Brain.js';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { asBinaryBytes, bytesToBase64 } from './base64.js';
import { brainHoldsScopeIdFormRecord, readInOneScopeIdForm } from '../retrieval/store/scopeIdForm.js';

// ---------------------------------------------------------------------------
// Row types (internal — matched to Brain DDL)
// ---------------------------------------------------------------------------

/** Raw row shape from the `memory_traces` table. */
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
}

/** Raw row shape from the `knowledge_nodes` table. */
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

/** Raw row shape from the `knowledge_edges` table. */
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

/** Raw row shape from the `documents` table. */
interface DocumentRow {
  id: string;
  path: string;
  format: string;
  title: string | null;
  content_hash: string;
  chunk_count: number;
  metadata: string;
  ingested_at: number;
}

/** Raw row shape from the `document_chunks` table. */
interface DocumentChunkRow {
  id: string;
  document_id: string;
  trace_id: string | null;
  content: string;
  chunk_index: number;
  page_number: number | null;
  embedding: Uint8Array | null;
}

/** Raw row shape from the `document_images` table. */
interface DocumentImageRow {
  id: string;
  document_id: string;
  chunk_id: string | null;
  data: Uint8Array;
  mime_type: string;
  caption: string | null;
  page_number: number | null;
  embedding: Uint8Array | null;
}

/** Raw row shape from the `conversations` table. */
interface ConversationRow {
  id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  metadata: string;
}

/** Raw row shape from the `messages` table. */
interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: number;
  metadata: string;
}

/** A registry, page or owner row with its times as numbers: a BIGINT column can come back as text (Postgres). */
function numericTimes(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const column of ['created_at', 'compiled_at', 'updated_at', 'attributed_at']) {
    const value = out[column];
    if (typeof value === 'string' && value !== '') out[column] = Number(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JsonExporter
// ---------------------------------------------------------------------------

/**
 * Exports a `Brain` to a structured JSON file.
 *
 * **Usage:**
 * ```ts
 * const exporter = new JsonExporter(brain);
 * await exporter.export('/path/to/export.json', { includeEmbeddings: false });
 * ```
 */
export class JsonExporter {
  /**
   * @param brain - The `Brain` instance to read from.
   */
  constructor(private readonly brain: Brain) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Export the full brain state to a JSON file at `outputPath`.
   *
   * @param outputPath - Absolute path to write the JSON output.
   * @param options - Optional export configuration. `includeEmbeddings` (default
   *   `false`): when `true`, raw embedding BLOBs are encoded as base64 strings and
   *   included in the output. `includeConversations` (default `true`): when
   *   `false`, conversation and message rows are omitted from the output.
   */
  async export(outputPath: string, options?: ExportOptions): Promise<void> {
    const payload = await this._buildPayload(options);
    const fs = await import('node:fs/promises');
    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  /**
   * Export the full brain state as a JSON string without filesystem access.
   *
   * @param options - Optional export configuration (embeddings, conversations).
   * @returns Pretty-printed JSON string of the full brain payload.
   */
  async exportToString(options?: ExportOptions): Promise<string> {
    const payload = await this._buildPayload(options);
    return JSON.stringify(payload, null, 2);
  }

  /**
   * Build the full export payload from the brain database.
   *
   * @param options - Optional export configuration.
   * @returns The structured payload object ready for serialisation.
   */
  private async _buildPayload(options?: ExportOptions): Promise<Record<string, unknown>> {
    // The record of the brain's scope-id form, in `meta`, names the form its rows are in: a re-file that commits while
    // the export reads is wholly in what it reads or wholly out of it.
    const { value } = await readInOneScopeIdForm(
      () => brainHoldsScopeIdFormRecord(this.brain),
      // One consistent view of the database: a page rewritten while the export reads is wholly in it, its chunks
      // with it, or wholly out of it.
      () => this.brain.readConsistently((source) => this._readPayload(options, source)),
    );
    return value;
  }

  /** Reads the payload's rows from `source`, {@link _buildPayload}'s one pass. */
  private async _readPayload(
    options: ExportOptions | undefined,
    source: Pick<StorageAdapter, 'all'>,
  ): Promise<Record<string, unknown>> {
    const includeEmbeddings = options?.includeEmbeddings ?? false;
    const includeConversations = options?.includeConversations ?? true;

    const brainId = this.brain.brainId;

    // Collect brain_meta as a plain object for the `meta` field.
    const metaRows = await source.all<{ key: string; value: string }>(
      'SELECT key, value FROM brain_meta WHERE brain_id = ?',
      [brainId],
    );
    const meta: Record<string, string> = {};
    for (const row of metaRows) {
      meta[row.key] = row.value;
    }
    meta['exported_at'] = String(Date.now());

    // ---- memory_traces ----
    const rawTraces = await source.all<TraceRow>('SELECT * FROM memory_traces WHERE brain_id = ?', [brainId]);
    const traces = rawTraces.map((row) => this._serializeTrace(row, includeEmbeddings));

    // ---- knowledge_nodes ----
    const rawNodes = await source.all<NodeRow>('SELECT * FROM knowledge_nodes WHERE brain_id = ?', [brainId]);
    const nodes = rawNodes.map((row) => this._serializeNode(row, includeEmbeddings));

    // ---- knowledge_edges ----
    const edges = await source.all<EdgeRow>('SELECT * FROM knowledge_edges WHERE brain_id = ?', [brainId]);

    // ---- documents ----
    const documents = await source.all<DocumentRow>('SELECT * FROM documents WHERE brain_id = ?', [brainId]);

    // ---- document_chunks ----
    const rawChunks = await source.all<DocumentChunkRow>('SELECT * FROM document_chunks WHERE brain_id = ?', [brainId]);
    const chunks = rawChunks.map((row) => this._serializeChunk(row, includeEmbeddings));

    // ---- document_images ----
    const rawImages = await source.all<DocumentImageRow>('SELECT * FROM document_images WHERE brain_id = ?', [brainId]);
    const images = rawImages.map((row) => this._serializeImage(row, includeEmbeddings));

    // ---- conversations ----
    const conversations: ConversationRow[] = includeConversations
      ? await source.all<ConversationRow>('SELECT * FROM conversations WHERE brain_id = ?', [brainId])
      : [];

    // ---- messages ----
    const messages: MessageRow[] = includeConversations
      ? await source.all<MessageRow>('SELECT * FROM messages WHERE brain_id = ?', [brainId])
      : [];

    // ---- memory_scopes, memory_pages ----
    // The registry of conversation scopes and each subject's wiki pages: a page's row lists its chunks among the
    // traces, so a restore without the rows would leave chunks no row lists.
    const scopes = await source.all<Record<string, unknown>>(
      'SELECT scope, scope_id, kind, agent_id, created_at, compiled_at FROM memory_scopes WHERE brain_id = ?',
      [brainId],
    );
    const pages = await source.all<Record<string, unknown>>(
      `SELECT scope, scope_id, page_id, content, content_hash, chunk_ids, updated_at
         FROM memory_pages WHERE brain_id = ?`,
      [brainId],
    );

    // ---- memory_legacy_owner ----
    // The owner of each agent's older memory: without it an import withholds that memory again, and a deletion of the
    // owner would not reach it.
    const legacyOwners = await source.all<Record<string, unknown>>(
      'SELECT agent_id, owner_key, attributed_at FROM memory_legacy_owner WHERE brain_id = ?',
      [brainId],
    );

    return {
      meta,
      traces,
      nodes,
      edges,
      documents,
      chunks,
      images,
      conversations,
      messages,
      scopes: scopes.map(numericTimes),
      pages: pages.map(numericTimes),
      legacyOwners: legacyOwners.map(numericTimes),
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Serialise a single `memory_traces` row, optionally stripping the embedding.
   *
   * @param row               - Raw DB row.
   * @param includeEmbeddings - Whether to encode the BLOB as base64.
   * @returns Plain JS object safe for JSON serialisation.
   */
  private _serializeTrace(row: TraceRow, includeEmbeddings: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row };
    const embedding = asBinaryBytes(row.embedding);
    if (embedding) {
      out['embedding'] = includeEmbeddings ? bytesToBase64(embedding) : undefined;
    }
    return out;
  }

  /**
   * Serialise a single `knowledge_nodes` row, optionally stripping the embedding.
   *
   * @param row               - Raw DB row.
   * @param includeEmbeddings - Whether to encode the BLOB as base64.
   * @returns Plain JS object safe for JSON serialisation.
   */
  private _serializeNode(row: NodeRow, includeEmbeddings: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row };
    const embedding = asBinaryBytes(row.embedding);
    if (embedding) {
      out['embedding'] = includeEmbeddings ? bytesToBase64(embedding) : undefined;
    }
    return out;
  }

  /**
   * Serialise a single `document_chunks` row.
   */
  private _serializeChunk(row: DocumentChunkRow, includeEmbeddings: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row };
    const embedding = asBinaryBytes(row.embedding);
    if (embedding) {
      out['embedding'] = includeEmbeddings ? bytesToBase64(embedding) : undefined;
    }
    return out;
  }

  /**
   * Serialise a single `document_images` row.
   *
   * Raw image bytes are always exported as base64 because they are primary
   * data, while the optional image embedding follows `includeEmbeddings`.
   */
  private _serializeImage(row: DocumentImageRow, includeEmbeddings: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row, data: bytesToBase64(row.data) };
    const embedding = asBinaryBytes(row.embedding);
    if (embedding) {
      out['embedding'] = includeEmbeddings ? bytesToBase64(embedding) : undefined;
    }
    return out;
  }
}
