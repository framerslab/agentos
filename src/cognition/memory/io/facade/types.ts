/**
 * @fileoverview Public API types for the Memory facade.
 *
 * These types form the stable, public-facing contract for the Memory subsystem.
 * They are intentionally independent of internal cognitive-science machinery so
 * consumers only need to import from this file rather than from deep internals.
 *
 * @module memory/facade/types
 */

import type { MemoryRetrievalPolicy } from '../../../rag/unified/policy.js';
import type { PathNameProblem } from '../../../../core/utils/pathName.js';

// ---------------------------------------------------------------------------
// Embedding configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the embedding model used to encode memory content and
 * document chunks into dense vectors.
 */
export interface EmbeddingConfig {
  /**
   * Embedding provider identifier.
   * @example 'openai' | 'cohere' | 'local'
   */
  provider: string;

  /**
   * Model name to use for generating embeddings.
   * When omitted the provider's default model is used.
   * @example 'text-embedding-3-small'
   */
  model?: string;

  /**
   * Dimensionality of produced vectors.
   * Must match the dimensionality expected by the configured vector store.
   * @example 1536
   */
  dimensions?: number;
}

// ---------------------------------------------------------------------------
// Consolidation configuration (extended facade version)
// ---------------------------------------------------------------------------

/**
 * Extended consolidation configuration that adds lifecycle-management fields
 * on top of the core `ConsolidationConfig` used internally.
 *
 * The `trigger` + `every` pair replace the internal `intervalMs` at the facade
 * level; adapters translate these to the internal representation.
 */
export interface ExtendedConsolidationConfig {
  /**
   * What event or schedule triggers a consolidation run.
   * - `'turns'`    – run after every N conversation turns (`every` = turn count).
   * - `'interval'` – run on a wall-clock timer (`every` = milliseconds).
   * - `'manual'`   – only run when explicitly called via `consolidate()`.
   * @default 'interval'
   */
  trigger?: 'turns' | 'interval' | 'manual';

  /**
   * Numeric complement to `trigger`.
   * When `trigger='turns'` this is the turn count; when `trigger='interval'`
   * this is the millisecond interval.
   * @default 3_600_000
   */
  every?: number;

  /**
   * Minimum strength below which a memory trace is pruned.
   * Must be between 0 and 1.
   * @default 0.05
   */
  pruneThreshold?: number;

  /**
   * Cosine similarity above which two traces are candidates for merging.
   * Must be between 0 and 1.
   * @default 0.92
   */
  mergeThreshold?: number;

  /**
   * Whether the consolidation engine should derive new insight traces from
   * clusters of related memories.
   * @default true
   */
  deriveInsights?: boolean;

  /**
   * Maximum number of new insight traces derived per consolidation cycle.
   * Guards against unbounded graph growth.
   * @default 10
   */
  maxDerivedPerCycle?: number;

  // ---- Passthrough from the existing internal ConsolidationConfig ----

  /**
   * How often to run consolidation in milliseconds (internal scheduler).
   * Superseded by `trigger`+`every` at the facade level; kept for compatibility.
   * @default 3_600_000
   */
  intervalMs?: number;

  /**
   * Maximum number of traces to process per consolidation cycle.
   * Bounds CPU/memory cost of a single run.
   * @default 500
   */
  maxTracesPerCycle?: number;

  /**
   * Similarity threshold used when merging redundant traces.
   * @default 0.92
   */
  mergeSimilarityThreshold?: number;

  /**
   * Minimum cluster size required before schema integration fires.
   * @default 5
   */
  minClusterSize?: number;
}

// ---------------------------------------------------------------------------
// Document ingestion configuration
// ---------------------------------------------------------------------------

/**
 * Controls how documents are split into chunks before being stored and indexed.
 */
export interface IngestionConfig {
  /**
   * Strategy for splitting a document into indexable chunks.
   * - `'fixed'`       – split at a fixed token/character count.
   * - `'semantic'`    – split at semantic boundaries (paragraphs, sections).
   * - `'hierarchical'`– build a tree of coarse → fine chunks (good for Q&A).
   * - `'layout'`      – preserve the visual layout of the source (PDF columns etc.).
   * @default 'semantic'
   */
  chunkStrategy?: 'fixed' | 'semantic' | 'hierarchical' | 'layout';

  /**
   * Target token/character count for each chunk.
   * @default 512
   */
  chunkSize?: number;

  /**
   * Overlap between consecutive chunks in tokens/characters.
   * Prevents context loss at chunk boundaries.
   * @default 64
   */
  chunkOverlap?: number;

  /**
   * Whether to extract embedded images from documents (PDF, DOCX, etc.).
   * Extracted images are stored as `ExtractedImage` objects.
   * @default false
   */
  extractImages?: boolean;

  /**
   * Whether to run Optical Character Recognition on extracted images.
   * Requires `extractImages: true`.
   * @default false
   */
  ocrEnabled?: boolean;

  /**
   * Whether to use the Docling library for high-fidelity PDF/DOCX parsing.
   * When `false`, a simpler text-extraction path is used.
   * @default false
   */
  doclingEnabled?: boolean;

  /**
   * Vision-capable LLM model identifier used to caption extracted images.
   * Only consulted when `extractImages: true`.
   * @example 'gpt-4o'
   */
  visionLlm?: string;
}

// ---------------------------------------------------------------------------
// Top-level memory facade configuration
// ---------------------------------------------------------------------------

/**
 * Top-level configuration object for the Memory facade.
 *
 * All fields are optional; sensible defaults are applied per field.
 * A minimal `{}` config is valid and will use a temporary SQLite brain file
 * with graph + self-improvement enabled.
 */
export interface MemoryConfig {
  /**
   * Persistence backend for memory traces.
   *
   * The Phase 1 facade currently implements the SQLite path at runtime.
   * Other values are reserved for future backends and will throw if selected.
   *
   * - `'sqlite'`  – file-based SQLite (implemented; recommended).
   * - `'memory'`  – reserved for a future in-process backend.
   * - `'qdrant'`  – reserved for a future vector-database backend.
   * - `'neo4j'`   – reserved for a future graph-database backend.
   * - `'hnsw'`    – reserved for a future ANN-only backend.
   * @default 'sqlite'
   */
  store?: 'sqlite' | 'memory' | 'qdrant' | 'neo4j' | 'hnsw' | 'postgres';

  /**
   * File-system path for stores that require one (e.g. SQLite db file).
   * Ignored by in-memory and remote stores.
   * @example './data/agent-memory.sqlite'
   */
  path?: string;

  /**
   * Postgres connection string. Required when store='postgres'.
   * @example 'postgresql://postgres:wunderland@localhost:5432/agent_memory'
   */
  connectionString?: string;

  /**
   * Qdrant base URL. Required when store='qdrant'.
   * @example 'http://localhost:6333'
   */
  qdrantUrl?: string;

  /** Qdrant API key for cloud instances. Optional. */
  qdrantApiKey?: string;

  /** Embedding model configuration (provider name + optional model). */
  embeddings?: EmbeddingConfig;

  /**
   * Optional embedding function for generating vectors at remember/recall time.
   * When provided, enables HNSW vector search in recall() and stores embeddings
   * alongside text in remember(). Without this, recall() falls back to FTS5-only.
   *
   * @example
   * ```typescript
   * const mem = await Memory.createSqlite({
   *   embed: async (text) => {
   *     const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
   *     return res.data[0].embedding;
   *   },
   * });
   * ```
   */
  embed?: (text: string) => Promise<number[]>;

  /**
   * Whether to build and maintain a knowledge graph alongside the vector store.
   * When enabled, entity co-occurrence and semantic edges are tracked.
   * @default false
   */
  graph?: boolean;

  /**
   * Whether the agent may autonomously refine and restructure its own memories
   * (write new insight traces, prune contradictions, merge redundancies).
   * @default false
   */
  selfImprove?: boolean;

  /**
   * Whether memory traces lose strength over time following an Ebbinghaus
   * forgetting-curve model.
   * @default true
   */
  decay?: boolean;

  /** Consolidation schedule and thresholds. */
  consolidation?: ExtendedConsolidationConfig;

  /** Document ingestion settings applied to all `ingest()` calls by default. */
  ingestion?: IngestionConfig;
}

// ---------------------------------------------------------------------------
// remember() options
// ---------------------------------------------------------------------------

/**
 * Options for storing a new memory trace via `Memory.remember()`.
 */
export interface RememberOptions {
  /**
   * Tulving memory type.
   * @example 'episodic' | 'semantic' | 'procedural' | 'prospective'
   */
  type?: string;

  /**
   * Visibility scope of the trace.
   * @example 'thread' | 'user' | 'persona' | 'organization'
   */
  scope?: string;

  /**
   * Identifier for the scope (e.g. thread ID, user ID).
   * Required when `scope` is set.
   */
  scopeId?: string;

  /**
   * Free-form tags for filtering and retrieval.
   * @example ['project:alpha', 'decision']
   */
  tags?: string[];

  /**
   * Named entities extracted from or associated with this trace.
   * @example ['Alice', 'GPT-4o', 'Q3 roadmap']
   */
  entities?: string[];

  /**
   * Manually supplied importance score (0–1).
   * When omitted the encoding engine derives one automatically.
   */
  importance?: number;
}

// ---------------------------------------------------------------------------
// recall() options
// ---------------------------------------------------------------------------

/**
 * Options for querying memory traces via `Memory.recall()`.
 */
export interface RecallOptions {
  /**
   * Maximum number of traces to return.
   * @default 10
   */
  limit?: number;

  /**
   * Filter by Tulving memory type.
   */
  type?: string;

  /**
   * Filter by visibility scope.
   */
  scope?: string;

  /**
   * Filter by scope ID.
   */
  scopeId?: string;

  /**
   * Minimum retrieval strength (Ebbinghaus current strength) to include.
   * Traces below this value are considered too weak/forgotten.
   * @default 0
   */
  minStrength?: number;

  /**
   * Only return traces created after this Unix-ms timestamp.
   * Part of the three-date temporal model for time-ranged recall.
   */
  after?: number;

  /**
   * Only return traces created before this Unix-ms timestamp.
   * Part of the three-date temporal model for time-ranged recall.
   */
  before?: number;

  /**
   * Optional shared retrieval policy override.
   * When omitted, recall preserves the current standalone behavior.
   */
  policy?: MemoryRetrievalPolicy;
}

// ---------------------------------------------------------------------------
// ingest() options
// ---------------------------------------------------------------------------

/**
 * Options controlling a document-ingestion job launched via `Memory.ingest()`.
 */
export interface IngestOptions {
  /**
   * Whether to recursively scan sub-directories when `source` is a directory.
   * @default false
   */
  recursive?: boolean;

  /**
   * Glob patterns for file types to include.
   * @example ['**\/*.md', '**\/*.pdf']
   */
  include?: string[];

  /**
   * Glob patterns for paths to exclude.
   * @example ['node_modules/**', '**\/*.test.*']
   */
  exclude?: string[];

  /**
   * Format hint for the ingested content.
   * - `'auto'`      – detect from file extension / mime type.
   * - `'obsidian'`  – parse Obsidian wiki-links and front-matter.
   * - `'markdown'`  – treat as plain CommonMark.
   * @default 'auto'
   */
  format?: 'auto' | 'obsidian' | 'markdown';

  /**
   * Callback invoked as each file is processed.
   * Useful for building progress UI.
   * @param processed - number of files completed so far
   * @param total     - total number of files discovered
   * @param current   - path of the file currently being processed
   */
  onProgress?: (processed: number, total: number, current: string) => void;
}

// ---------------------------------------------------------------------------
// ingest() result
// ---------------------------------------------------------------------------

/**
 * Summary of a completed ingestion run returned by `Memory.ingest()`.
 */
export interface IngestResult {
  /**
   * Absolute paths of all files that were successfully ingested.
   */
  succeeded: string[];

  /**
   * Files that could not be ingested, with per-file error messages.
   */
  failed: Array<{ path: string; error: string }>;

  /**
   * Total number of document chunks created and stored.
   */
  chunksCreated: number;

  /**
   * Total number of new memory traces created from the ingested content.
   */
  tracesCreated: number;
}

// ---------------------------------------------------------------------------
// export() options
// ---------------------------------------------------------------------------

/**
 * Options for exporting the memory store via `Memory.export()`.
 */
export interface ExportOptions {
  /**
   * Serialisation format for the export artifact.
   * - `'sqlite'`   – copy of the SQLite file (binary).
   * - `'json'`     – newline-delimited JSON of all traces.
   * - `'markdown'` – human-readable Markdown summary.
   * - `'obsidian'` – Obsidian vault with one note per trace and wiki-links.
   * @default 'json'
   */
  format?: 'sqlite' | 'json' | 'markdown' | 'obsidian';

  /**
   * Whether to include raw embedding vectors in the export.
   * Embeddings dramatically increase file size but allow round-trip import
   * without re-embedding.
   * @default false
   */
  includeEmbeddings?: boolean;

  /**
   * Whether to include conversation turn traces in the export.
   * @default true
   */
  includeConversations?: boolean;
}

// ---------------------------------------------------------------------------
// export() result
// ---------------------------------------------------------------------------

/**
 * A trace an export left out. Nothing was written for it.
 */
export interface RefusedExportTrace {
  /** The trace's id, as stored. */
  id: string;

  /**
   * The value that was refused: the trace's `scope`, `type` or `id`, which name its folders and its file in a
   * Markdown or Obsidian export; or `path`, when the path an exporter subclass builds for the trace is outside
   * the export folder.
   */
  field: 'scope' | 'type' | 'id' | 'path';

  /**
   * Why: the part of the name rule the value breaks (`PathNameProblem` in `core/utils/pathName`), or `outside`
   * for a path outside the export folder.
   */
  problem: PathNameProblem | 'outside';
}

/**
 * What `Memory.export()` reports.
 */
export interface ExportResult {
  /**
   * The traces the export left out, each with its id and the reason; its length is how many. A Markdown or
   * Obsidian export names a trace's folders after its scope and type and its file after its id, so it leaves out
   * a trace whose scope, type or id is not a safe file or folder name: an empty one, one that holds a slash, a
   * backslash, a colon, one of `"`, `*`, `<`, `>`, `?` and `|`, or a control character, one that starts with a
   * dot, starts or ends with a space or ends with a dot, or one longer than 200 bytes in UTF-8. Every other trace
   * is written. A JSON or SQLite export writes every trace into its one file and leaves none out.
   */
  refused: RefusedExportTrace[];
}

// ---------------------------------------------------------------------------
// import() options
// ---------------------------------------------------------------------------

/**
 * Options for importing memory data via `Memory.import()`.
 */
export interface ImportOptions {
  /**
   * Source format of the import file.
   * - `'auto'`     – detect from file extension / magic bytes.
   * - `'sqlite'`   – AgentOS SQLite export.
   * - `'json'`     – newline-delimited JSON export.
   * - `'markdown'` – parse headings as trace content.
   * - `'obsidian'` – Obsidian vault (wiki-links become graph edges).
   * - `'chatgpt'`  – ChatGPT conversation export (conversations.json).
   * - `'csv'`      – flat CSV with `content` column.
   * @default 'auto'
   */
  format?: 'auto' | 'sqlite' | 'json' | 'markdown' | 'obsidian' | 'chatgpt' | 'csv';

  /**
   * Whether to skip importing traces whose content hash already exists in the
   * store, preventing duplicates on repeated imports.
   * @default true
   */
  dedup?: boolean;
}

// ---------------------------------------------------------------------------
// import() result
// ---------------------------------------------------------------------------

/**
 * Summary of a completed import operation returned by `Memory.import()`.
 */
export interface ImportResult {
  /**
   * Number of traces successfully imported and written to the store.
   */
  imported: number;

  /**
   * Number of traces skipped (deduplication or format mismatch).
   */
  skipped: number;

  /**
   * Human-readable error messages for any traces that failed to import.
   */
  errors: string[];
}

// ---------------------------------------------------------------------------
// consolidate() result
// ---------------------------------------------------------------------------

/**
 * Statistics returned after a consolidation cycle completes.
 */
export interface ConsolidationResult {
  /**
   * Number of traces pruned (below strength threshold).
   */
  pruned: number;

  /**
   * Number of trace pairs merged into single traces.
   */
  merged: number;

  /**
   * Number of new insight traces derived from clusters.
   */
  derived: number;

  /**
   * Number of traces compacted (archived to long-term store).
   */
  compacted: number;

  /**
   * Wall-clock time the consolidation cycle took in milliseconds.
   */
  durationMs: number;

  /**
   * Number of personality mutations affected by decay during this cycle.
   *
   * Only populated when a {@link PersonalityMutationStore} is configured
   * on the ConsolidationLoop. This includes both weakened mutations and
   * mutations pruned after falling below the strength threshold.
   * Zero when the store is absent or no mutations were touched.
   * @default 0
   */
  personalityDecayed?: number;
}

// ---------------------------------------------------------------------------
// Memory health report
// ---------------------------------------------------------------------------

/**
 * Snapshot of the memory store's health and usage statistics.
 * Returned by `Memory.health()`.
 */
export interface MemoryHealth {
  /**
   * Total number of traces in the store (active + inactive).
   */
  totalTraces: number;

  /**
   * Number of traces that are currently active (strength > pruneThreshold).
   */
  activeTraces: number;

  /**
   * Mean Ebbinghaus strength across all active traces (0–1).
   */
  avgStrength: number;

  /**
   * Strength of the weakest active trace.
   */
  weakestTraceStrength: number;

  /**
   * Number of nodes in the knowledge graph (0 when `graph` is disabled).
   */
  graphNodes: number;

  /**
   * Number of edges in the knowledge graph (0 when `graph` is disabled).
   */
  graphEdges: number;

  /**
   * ISO 8601 timestamp of the last successful consolidation run.
   * `null` if consolidation has never been run.
   */
  lastConsolidation: string | null;

  /**
   * Trace count broken down by Tulving memory type.
   */
  tracesPerType: Record<string, number>;

  /**
   * Trace count broken down by visibility scope.
   */
  tracesPerScope: Record<string, number>;

  /**
   * Total number of document chunks ingested via `Memory.ingest()`.
   */
  documentsIngested: number;
}

// ---------------------------------------------------------------------------
// Document loading types
// ---------------------------------------------------------------------------

/**
 * Options for the lower-level `Memory.load()` document-parsing primitive.
 */
export interface LoadOptions {
  /**
   * Format hint passed directly to the document parser.
   * @example 'pdf' | 'docx' | 'md' | 'txt'
   */
  format?: string;
}

/**
 * Arbitrary key-value metadata attached to a loaded document.
 * Well-known fields are typed explicitly; any additional fields are allowed.
 */
export interface DocumentMetadata {
  /** Document title extracted from front-matter or PDF info dict. */
  title?: string;

  /** Primary author of the document. */
  author?: string;

  /** Number of pages (PDF/DOCX). */
  pageCount?: number;

  /** Approximate word count of the full document text. */
  wordCount?: number;

  /**
   * ISO 639-1 language code detected in the document.
   * @example 'en' | 'de' | 'fr'
   */
  language?: string;

  /** ISO 8601 creation timestamp. */
  createdAt?: string;

  /** ISO 8601 last-modified timestamp. */
  modifiedAt?: string;

  /** Original file path or URL the document was loaded from. */
  source?: string;

  /** Any additional metadata fields from the source document. */
  [key: string]: unknown;
}

/**
 * A single chunk produced by splitting a document.
 * Used internally and returned in `LoadedDocument.chunks`.
 */
export interface DocumentChunk {
  /**
   * Text content of this chunk after extraction and cleaning.
   */
  content: string;

  /**
   * Zero-based chunk index within the parent document.
   */
  index: number;

  /**
   * Page number this chunk originates from (1-based, PDF/DOCX).
   */
  pageNumber?: number;

  /**
   * Heading or section title that precedes this chunk, if detected.
   */
  heading?: string;

  /**
   * Chunk-level metadata (e.g. bounding box, column number for layout mode).
   */
  metadata?: Record<string, unknown>;
}

/**
 * An image extracted from a document during ingestion.
 */
export interface ExtractedImage {
  /**
   * Raw image bytes (PNG, JPEG, WebP, etc.).
   */
  data: Buffer;

  /**
   * MIME type of `data`.
   * @example 'image/png' | 'image/jpeg'
   */
  mimeType: string;

  /**
   * Auto-generated or OCR-derived caption.
   * Present when a vision LLM is configured and `extractImages: true`.
   */
  caption?: string;

  /**
   * Page number the image appears on (1-based, PDF/DOCX).
   */
  pageNumber?: number;

  /**
   * Dense embedding of the image caption or visual content.
   * Only present when embeddings were computed during extraction.
   */
  embedding?: number[];
}

/**
 * A structured table extracted from a document.
 */
export interface ExtractedTable {
  /**
   * Column header labels, in order.
   */
  headers: string[];

  /**
   * Data rows; each row is an array of cell strings aligned to `headers`.
   */
  rows: string[][];

  /**
   * Optional caption or title for the table.
   */
  caption?: string;

  /**
   * Page number the table appears on (1-based, PDF/DOCX).
   */
  pageNumber?: number;
}

/**
 * The parsed representation of a document returned by `Memory.load()`.
 * Contains full text, optional chunks, and any extracted images/tables.
 */
export interface LoadedDocument {
  /**
   * Full extracted text content of the document.
   */
  content: string;

  /**
   * Document-level metadata (title, author, page count, etc.).
   */
  metadata: DocumentMetadata;

  /**
   * Pre-chunked segments, present when chunking was requested during load.
   */
  chunks?: DocumentChunk[];

  /**
   * Images extracted from the document.
   * Populated only when `IngestionConfig.extractImages` is `true`.
   */
  images?: ExtractedImage[];

  /**
   * Structured tables extracted from the document.
   */
  tables?: ExtractedTable[];

  /**
   * The format that was detected or used to parse the document.
   * @example 'pdf' | 'md' | 'docx' | 'txt'
   */
  format: string;
}
