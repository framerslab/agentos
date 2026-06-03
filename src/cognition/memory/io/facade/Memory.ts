/**
 * @fileoverview Memory facade -- unified public API for the complete memory system.
 *
 * The `Memory` class wires together every subsystem built in Tasks 1-12:
 * - Brain (unified SQLite connection with WAL, full schema)
 * - SqlKnowledgeGraph (IKnowledgeGraph backed by SQLite)
 * - SqlMemoryGraph (IMemoryGraph with spreading activation)
 * - LoaderRegistry (document loaders: text, md, html, pdf, docx)
 * - FolderScanner (recursive directory scanning)
 * - ChunkingEngine (4 chunking strategies)
 * - RetrievalFeedbackSignal (used/ignored detection)
 * - ConsolidationLoop (6-step self-improvement)
 * - I/O exporters and importers (JSON, Markdown, Obsidian, SQLite, ChatGPT)
 *
 * Consumers only need to import this single class to interact with the entire
 * memory subsystem.
 *
 * @module memory/facade/Memory
 */

import { sha256 as crossSha256, uuid } from '../../core/util/crossPlatformCrypto.js';

const _isNode = typeof process !== 'undefined' && !!process.versions?.node;

async function _getFs(): Promise<typeof import('node:fs/promises')> {
  if (!_isNode) throw new Error('Filesystem operations are not available in browser environments.');
  return import('node:fs/promises');
}

async function _getPath(): Promise<typeof import('node:path')> {
  if (!_isNode) throw new Error('Path operations are not available in browser environments.');
  return import('node:path');
}

async function _getOs(): Promise<typeof import('node:os')> {
  if (!_isNode) throw new Error('OS operations are not available in browser environments.');
  return import('node:os');
}

import type { MemoryTrace } from '../../core/types.js';
import type { CompileResult } from '../../../substrate/memory/wiki/types.js';
import type { ITool } from '../../../../core/tools/ITool.js';
import type {
  MemoryConfig,
  RememberOptions,
  RecallOptions,
  IngestOptions,
  IngestResult,
  ExportOptions,
  ImportOptions,
  ImportResult,
  ConsolidationResult,
  MemoryHealth,
  LoadedDocument,
} from './types.js';
import type {
  IKnowledgeGraph,
  KnowledgeEntity,
  KnowledgeRelation,
} from '../../retrieval/graph/knowledge/IKnowledgeGraph.js';
import type { LoaderRegistry } from '../ingestion/LoaderRegistry.js';
import type { FolderScanner } from '../ingestion/FolderScanner.js';

import { Brain } from '../../retrieval/store/Brain.js';
import {
  buildNaturalLanguageFtsQuery,
  buildInitialTraceMetadata,
  parseTraceMetadata,
  readPersistedDecayState,
  withPersistedDecayState,
} from '../../retrieval/store/tracePersistence.js';
import { SqlKnowledgeGraph } from '../../retrieval/store/SqlKnowledgeGraph.js';
import { SqlMemoryGraph } from '../../retrieval/store/SqlMemoryGraph.js';
import { ChunkingEngine } from '../ingestion/ChunkingEngine.js';
import { UrlLoader } from '../ingestion/UrlLoader.js';
import { RetrievalFeedbackSignal } from '../../retrieval/feedback/RetrievalFeedbackSignal.js';
import type { RetrievalFeedback } from '../../retrieval/feedback/RetrievalFeedbackSignal.js';
import { ConsolidationLoop } from '../../pipeline/consolidation/ConsolidationLoop.js';
import { penalizeUnused, updateOnRetrieval } from '../../core/decay/DecayModel.js';
import {
  evaluateRetrievalConfidence,
  getCandidateLimit,
  resolveMemoryRetrievalPolicy,
} from '../../../rag/unified/index.js';
import {
  MemoryAddTool,
  MemoryUpdateTool,
  MemoryDeleteTool,
  MemoryMergeTool,
  MemorySearchTool,
  MemoryReflectTool,
} from '../tools/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A memory trace paired with its retrieval relevance score.
 *
 * Returned by {@link Memory.recall} as a ranked list of matches.
 */
export interface ScoredTrace {
  /** The full memory trace envelope. */
  trace: MemoryTrace;
  /** Composite relevance score; higher is better. */
  score: number;
}

/**
 * Standalone recall paths produce backend-specific ranking signals
 * (FTS rank products and RRF fusion scores), not calibrated 0–1
 * confidences. Translate them into a conservative confidence band
 * before applying shared retrieval-policy thresholds.
 *
 * Key property: "balanced" defaults should pass clearly relevant
 * lexical hits, while very high thresholds (for explicit suppression)
 * can still zero them out.
 */
function standaloneRecallConfidence(score: number): number {
  if (!Number.isFinite(score) || score <= 0) {
    return 0;
  }

  return Math.min(0.9, Math.max(0, (Math.log10(score) + 10) / 10));
}

// ---------------------------------------------------------------------------
// Internal row types (matched to Brain DDL)
// ---------------------------------------------------------------------------

/** Raw row shape from the `memory_traces` table. */
interface TraceRow {
  id: string;
  type: string;
  scope: string;
  content: string;
  embedding: Buffer | null;
  strength: number;
  created_at: number;
  last_accessed: number | null;
  retrieval_count: number;
  tags: string;
  emotions: string;
  metadata: string;
  deleted: number;
}

/** Shape returned by FTS5 ranked join query. */
interface FtsJoinRow extends TraceRow {
  rank: number;
}

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

/**
 * Generate a globally unique, collision-free trace ID.
 * Previous implementation used a monotonic counter (`mt_{timestamp}_{counter}`)
 * which could collide across multiple processes or rapid restarts.
 */
function nextTraceId(): string {
  return `mt_${uuid()}`;
}

function isFtsUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('no such module: fts5') || message.includes('no such table: memory_traces_fts');
}

/**
 * Compute SHA-256 hex digest of a string.
 */
async function sha256(content: string): Promise<string> {
  return crossSha256(content);
}

// ---------------------------------------------------------------------------
// Memory facade
// ---------------------------------------------------------------------------

/**
 * Unified public API for the AgentOS memory system.
 *
 * One `Memory` instance manages the full lifecycle of an agent's memories:
 * storing, retrieving, ingesting documents, building a knowledge graph,
 * self-improving through consolidation, and importing/exporting data.
 *
 * ## Quick start
 * ```ts
 * const mem = await Memory.create({ store: 'sqlite', path: './brain.sqlite' });
 *
 * await mem.remember('The user prefers dark mode');
 * const results = await mem.recall('dark mode preference');
 * console.log(results[0].trace.content);
 *
 * await mem.close();
 * ```
 */
export class Memory {
  // ---- Internal subsystem handles ----
  private readonly _brain: Brain;
  private readonly _knowledgeGraph: SqlKnowledgeGraph;
  private readonly _memoryGraph: SqlMemoryGraph;
  private _loaderRegistry: LoaderRegistry | null = null;
  private _folderScanner: FolderScanner | null = null;
  private _ingestionToolsPromise:
    | Promise<{ loaderRegistry: LoaderRegistry; folderScanner: FolderScanner }>
    | null = null;
  private readonly _chunkingEngine: ChunkingEngine;
  private readonly _feedbackSignal: RetrievalFeedbackSignal | null;
  private readonly _consolidationLoop: ConsolidationLoop | null;
  private readonly _config: Required<Pick<MemoryConfig, 'store' | 'graph' | 'selfImprove' | 'decay'>> & MemoryConfig;
  private _initPromise: Promise<void>;

  /** HNSW sidecar index for O(log n) vector search alongside SQLite. */
  private _hnswSidecar: import('../../retrieval/store/HnswSidecar.js').HnswSidecar | null = null;

  /** Optional embedding function for vector search (set via config.embed). */
  private readonly _embed: ((text: string) => Promise<number[]>) | null;

  // -------------------------------------------------------------------
  // Constructor (private — use Memory.create() instead)
  // -------------------------------------------------------------------

  /**
   * Private constructor. Receives an already-opened Brain and
   * pre-computed configuration. Use {@link Memory.create} to instantiate.
   */
  private constructor(
    brain: Brain,
    config: Required<Pick<MemoryConfig, 'store' | 'graph' | 'selfImprove' | 'decay'>> & MemoryConfig,
  ) {
    this._brain = brain;
    this._config = config;

    // Store the optional embedding function for vector search.
    this._embed = config.embed ?? null;

    // Create SqlKnowledgeGraph.
    this._knowledgeGraph = new SqlKnowledgeGraph(this._brain);

    // Create SqlMemoryGraph and initialize.
    this._memoryGraph = new SqlMemoryGraph(this._brain);
    this._initPromise = this._memoryGraph.initialize();

    // Create ChunkingEngine.
    this._chunkingEngine = new ChunkingEngine();

    // Self-improvement subsystems.
    if (this._config.selfImprove) {
      this._feedbackSignal = new RetrievalFeedbackSignal(this._brain);
      this._consolidationLoop = new ConsolidationLoop(this._brain, this._memoryGraph);
    } else {
      this._feedbackSignal = null;
      this._consolidationLoop = null;
    }

    // HNSW sidecar index (O(log n) ANN alongside SQLite).
    // Loads existing index from disk if present; auto-builds when trace count
    // exceeds 1000 and embeddings are available. Falls back to FTS5-only
    // recall if hnswlib-node is not installed or no embeddings exist.
    this._initPromise = this._initPromise.then(async () => {
      try {
        const { HnswSidecar } = await import('../../retrieval/store/HnswSidecar.js');
        const dims = this._config.embeddings?.dimensions ?? 1536;
        this._hnswSidecar = new HnswSidecar({
          sqlitePath: this._config.path!,
          dimensions: dims,
        });
        await this._hnswSidecar.init();
      } catch {
        // hnswlib-node not installed or init failed — HNSW stays null.
        // Recall will use FTS5 only (still works, just O(n) for vectors).
        this._hnswSidecar = null;
      }
    });
  }

  // -------------------------------------------------------------------
  // Async factory
  // -------------------------------------------------------------------

  /**
   * Create a new Memory instance and wire together all subsystems.
   *
   * Initialization sequence:
   * 1. Merge `config` with defaults (store='sqlite', path=tmpdir, graph=true,
   *    selfImprove=true, decay=true).
   * 2. Await `Brain.openSqlite(config.path)`.
   * 3. Check embedding dimension compatibility (warn on mismatch).
   * 4. Create `SqlKnowledgeGraph(brain)`.
   * 5. Create `SqlMemoryGraph(brain)` and call `.initialize()`.
   * 6. Create `ChunkingEngine()`.
   * 7. Lazily create ingestion loaders on first `ingest()` call.
   * 8. If `selfImprove`: create `RetrievalFeedbackSignal(brain)` and
   *    `ConsolidationLoop(brain, memoryGraph)`.
   *
   * @param config - Optional configuration; see {@link MemoryConfig}.
   * @returns A fully initialised Memory instance.
   */
  /**
   * Open a Memory backed by SQLite. Defaults to a tmp file when no path is given.
   *
   * Accepts either a path string + opts, or a `MemoryConfig` object for
   * compatibility with the old `Memory.create(config)` shape.
   *
   * @example
   * ```ts
   * await Memory.createSqlite('./brain.sqlite');
   * await Memory.createSqlite('./brain.sqlite', { graph: true });
   * await Memory.createSqlite({ path: './brain.sqlite', graph: true });
   * ```
   */
  /**
   * Backwards-compatible alias for {@link Memory.createSqlite}. The earlier
   * surface accepted `Memory.create(config)` and several published docs and
   * blog posts still reference it; rather than break those examples we
   * forward to `createSqlite` (the modern, more explicit factory).
   *
   * For non-SQLite backends call {@link Memory.createPostgres} or
   * {@link Memory.createWithAdapter} directly.
   */
  static async create(
    pathOrConfig?: string | MemoryConfig,
    opts: Omit<MemoryConfig, 'store' | 'path'> & {
      brainId?: string;
      priority?: ('better-sqlite3' | 'sqljs' | 'indexeddb')[];
    } = {},
  ): Promise<Memory> {
    return Memory.createSqlite(pathOrConfig, opts);
  }

  static async createSqlite(
    pathOrConfig?: string | MemoryConfig,
    opts: Omit<MemoryConfig, 'store' | 'path'> & {
      brainId?: string;
      priority?: ('better-sqlite3' | 'sqljs' | 'indexeddb')[];
    } = {},
  ): Promise<Memory> {
    let path: string | undefined;
    let mergedOpts: typeof opts;

    if (typeof pathOrConfig === 'string' || pathOrConfig === undefined) {
      path = pathOrConfig;
      mergedOpts = opts;
    } else {
      // Config-object form for compat with the prior Memory.create({path, ...}) API.
      // Reject explicit non-sqlite stores so callers know to use a different factory.
      if (pathOrConfig.store && pathOrConfig.store !== 'sqlite') {
        throw new Error(
          `Memory.createSqlite supports only the SQLite-backed facade at runtime. ` +
          `Received store="${pathOrConfig.store}". ` +
          `Use Memory.createPostgres(connectionString, opts) for Postgres or ` +
          `Memory.createWithAdapter(adapter, opts) for a pre-resolved adapter.`,
        );
      }
      const { store: _store, path: cfgPath, ...rest } = pathOrConfig;
      path = cfgPath;
      mergedOpts = { ...rest, ...opts };
    }

    const resolvedPath = path ?? (await Memory._defaultSqlitePath());
    const brain = await Brain.openSqlite(resolvedPath, {
      brainId: mergedOpts.brainId,
      priority: mergedOpts.priority,
    });
    return Memory._initialize(brain, { ...mergedOpts, store: 'sqlite', path: resolvedPath });
  }

  /**
   * Open a Memory backed by PostgreSQL. Requires the `pg` npm package.
   *
   * @param connectionString - Standard Postgres connection URL.
   * @param opts.brainId - REQUIRED. Multi-tenant scope per query.
   * @param opts.poolSize - pg pool max size. Defaults to 10.
   * @param opts - Plus standard Memory options (graph, selfImprove, decay,
   *   embeddings).
   */
  static async createPostgres(
    connectionString: string,
    opts: Omit<MemoryConfig, 'store' | 'path'> & {
      brainId: string;
      poolSize?: number;
    },
  ): Promise<Memory> {
    const brain = await Brain.openPostgres(connectionString, {
      brainId: opts.brainId,
      poolSize: opts.poolSize,
    });
    return Memory._initialize(brain, { ...opts, store: 'sqlite' });
  }

  /**
   * Open a Memory with a pre-resolved StorageAdapter. Use when sharing an
   * adapter across subsystems or when you need full control over adapter
   * resolution.
   */
  static async createWithAdapter(
    adapter: import('@framers/sql-storage-adapter').StorageAdapter,
    opts: Omit<MemoryConfig, 'store' | 'path'> & { brainId?: string } = {},
  ): Promise<Memory> {
    const brain = await Brain.openWithAdapter(adapter, { brainId: opts.brainId });
    return Memory._initialize(brain, { ...opts, store: 'sqlite' });
  }

  /**
   * Internal common initialization path for all three factories.
   * Wires the Memory facade around an already-opened Brain.
   */
  private static async _initialize(
    brain: Brain,
    config: MemoryConfig,
  ): Promise<Memory> {
    const merged = {
      store: 'sqlite' as const,
      graph: true,
      selfImprove: true,
      decay: true,
      ...config,
    };

    // Embedding dimension compatibility check.
    const dimensions = merged.embeddings?.dimensions ?? 1536;
    const compatible = await brain.checkEmbeddingCompat(dimensions);
    if (!compatible) {
      console.warn(
        `[Memory] Embedding dimension mismatch: expected ${dimensions} but brain ` +
        `was previously configured with a different dimension. Vector similarity ` +
        `searches may produce incorrect results.`,
      );
    }

    return new Memory(brain, merged);
  }

  /**
   * Generate a default temp SQLite path for `createSqlite()` when no
   * explicit path is supplied. Node-only; browsers must pass a path
   * (typically `:memory:` or an indexeddb-backed adapter).
   */
  private static async _defaultSqlitePath(): Promise<string> {
    const randomSuffix = Math.random().toString(36).slice(2, 10);
    if (_isNode) {
      const osModule = await _getOs();
      const pathModule = await _getPath();
      return pathModule.join(osModule.tmpdir(), `brain-${randomSuffix}.sqlite`);
    }
    return `brain-${randomSuffix}.sqlite`;
  }

  // =========================================================================
  // Core memory operations
  // =========================================================================

  /**
   * Store a new memory trace.
   *
   * Creates a trace in the `memory_traces` table with a unique ID, content
   * hash for deduplication, and optional type/scope/tags metadata. If the
   * memory graph is available the trace is also added as a graph node.
   *
   * @param content - The text content to remember.
   * @param options - Optional metadata (type, scope, tags, importance, etc.).
   * @returns The created MemoryTrace-like object.
   */
  async remember(content: string, options?: RememberOptions): Promise<MemoryTrace> {
    await this._initPromise;

    const contentHash = await sha256(content);
    const type = options?.type ?? 'episodic';
    const scope = options?.scope ?? 'user';
    const scopeId = options?.scopeId ?? '';
    const existing = await this._findExistingTraceByHash(contentHash, type, scope, scopeId);
    if (existing) {
      return this._buildTrace(existing);
    }

    const id = nextTraceId();
    const now = Date.now();
    const tags = options?.tags ?? [];
    const entities = options?.entities ?? [];
    const importance = options?.importance ?? 1.0;

    // Generate embedding if embed function is available.
    let embeddingBlob: Uint8Array | null = null;
    if (this._embed) {
      try {
        const vec = await this._embed(content);
        embeddingBlob = this._brain.features.blobCodec.encode(vec);
      } catch {
        // Embedding generation failed — continue without vector.
        embeddingBlob = null;
      }
    }

    // Insert into memory_traces.
    await this._brain.run(
      `INSERT INTO memory_traces
         (brain_id, id, type, scope, content, embedding, strength, created_at,
          last_accessed, retrieval_count, tags, emotions, metadata, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, 0)`,
      [
        this._brain.brainId,
        id,
        type,
        scope,
        content,
        embeddingBlob, // Binary blob or null
        importance,
        now,
        JSON.stringify(tags),
        JSON.stringify({}),
        JSON.stringify(buildInitialTraceMetadata({}, { contentHash, entities, scopeId })),
      ],
    );

    // Sync FTS index. The external-content FTS table needs explicit insert.
    const { fts } = this._brain.features;
    try {
      await this._brain.run(
        fts.syncInsert('memory_traces_fts', '(SELECT rowid FROM memory_traces WHERE id = ?)', ['content', 'tags']),
        [id, content, JSON.stringify(tags)],
      );
    } catch (error) {
      if (!isFtsUnavailableError(error)) {
        throw error;
      }
    }

    // Add to memory graph if available.
    if (this._config.graph) {
      await this._memoryGraph.addNode(id, {
        type: type as 'episodic' | 'semantic' | 'procedural',
        scope: scope as 'session' | 'user' | 'global',
        scopeId,
        strength: importance,
        createdAt: now,
      });
    }

    // Add to HNSW sidecar if embeddings exist for this trace.
    // The embedding is stored in the memory_traces table; if it's non-null,
    // also index it in the HNSW sidecar for fast ANN recall.
    if (this._hnswSidecar) {
      const row = await this._brain.get<{ embedding: Buffer | null }>(
        'SELECT embedding FROM memory_traces WHERE id = ?',
        [id],
      );
      if (row?.embedding && row.embedding.length > 0) {
        const { blobCodec } = this._brain.features;
        const isLegacy = typeof row.embedding === 'string' ||
          (row.embedding && row.embedding[0] === 0x5b); // '[' character = JSON array
        const vec = isLegacy
          ? JSON.parse(row.embedding as unknown as string) as number[]
          : blobCodec.decode(row.embedding);
        const countRow = await this._brain.get<{ c: number }>(
          'SELECT COUNT(*) as c FROM memory_traces WHERE deleted = 0',
        );
        const count = countRow?.c ?? 0;

        if (!this._hnswSidecar.isActive && count >= 1000) {
          // Threshold crossed — rebuild full index from all embeddings.
          const allRows = await this._brain.all<{ id: string; embedding: Buffer }>(
            'SELECT id, embedding FROM memory_traces WHERE deleted = 0 AND embedding IS NOT NULL',
          );
          const data = allRows
            .filter(r => r.embedding && r.embedding.length > 0)
            .map(r => {
              const legacy = typeof r.embedding === 'string' ||
                (r.embedding && r.embedding[0] === 0x5b);
              return {
                id: r.id,
                embedding: legacy
                  ? JSON.parse(r.embedding as unknown as string) as number[]
                  : blobCodec.decode(r.embedding),
              };
            });
          await this._hnswSidecar.rebuildFromData(data);
        } else {
          await this._hnswSidecar.add(id, vec, count);
        }
      }
    }

    // Build a MemoryTrace-shaped return value.
    return this._buildTrace({
      id,
      type,
      scope,
      content,
      embedding: null,
      strength: importance,
      created_at: now,
      last_accessed: null,
      retrieval_count: 0,
      tags: JSON.stringify(tags),
      emotions: JSON.stringify({}),
      metadata: JSON.stringify(buildInitialTraceMetadata({}, { contentHash, entities, scopeId })),
      deleted: 0,
    });
  }

  /**
   * Search for memory traces matching a natural-language query.
   *
   * Uses FTS5 full-text search with the Porter tokenizer. Results are ranked
   * by `strength * abs(fts_rank)` and filtered by optional type/scope/strength
   * criteria.
   *
   * @param query   - Natural-language search query.
   * @param options - Optional filters (limit, type, scope, minStrength).
   * @returns Ranked array of {@link ScoredTrace} results.
   */
  async recall(query: string, options?: RecallOptions): Promise<ScoredTrace[]> {
    await this._initPromise;

    const ftsQuery = buildNaturalLanguageFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }

    const resolvedPolicy = options?.policy ? resolveMemoryRetrievalPolicy(options.policy) : null;
    const limit = options?.limit ?? resolvedPolicy?.topK ?? 10;
    const candidateLimit = resolvedPolicy
      ? getCandidateLimit(limit, resolvedPolicy.candidateMultiplier)
      : limit;
    const minStrength = options?.minStrength ?? 0;

    // Build WHERE clause fragments for optional filters.
    const conditions: string[] = ['t.deleted = 0'];
    const params: unknown[] = [];

    if (options?.type) {
      conditions.push('t.type = ?');
      params.push(options.type);
    }
    if (options?.scope) {
      conditions.push('t.scope = ?');
      params.push(options.scope);
    }
    if (options?.scopeId) {
      const { dialect } = this._brain.features;
      conditions.push(`${dialect.jsonExtract('t.metadata', '$.scopeId')} = ?`);
      params.push(options.scopeId);
    }
    if (minStrength > 0) {
      conditions.push('t.strength >= ?');
      params.push(minStrength);
    }
    if (options?.after != null) {
      conditions.push('t.created_at > ?');
      params.push(options.after);
    }
    if (options?.before != null) {
      conditions.push('t.created_at < ?');
      params.push(options.before);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // ── Path A: HNSW + FTS5 hybrid (if sidecar is active) ──
    // Uses HNSW for dense vector candidates, FTS5 for lexical candidates,
    // then merges via reciprocal rank fusion (RRF). This is the fast path
    // when embeddings exist and the sidecar has been built.
    if (this._hnswSidecar?.isActive && this._embed) {
      // Generate query embedding for HNSW vector search.
      let queryEmbedding: number[] = [];
      try {
        queryEmbedding = await this._embed(query);
      } catch {
        // Embedding failed — fall through to FTS5-only path.
      }

      // Get vector candidates from HNSW (3x over-fetch for fusion).
      const hnswCandidates = queryEmbedding.length > 0
        ? this._hnswSidecar.query(queryEmbedding, candidateLimit)
        : [];

      // If HNSW returned candidates, merge with FTS5 via RRF.
      if (hnswCandidates.length > 0) {
        const hnswIds = new Set(hnswCandidates.map(c => c.id));
        const hnswRank = new Map(hnswCandidates.map((c, i) => [c.id, i + 1]));

        // Get FTS candidates.
        const { fts: ftsHelper } = this._brain.features;
        const ftsSql = `
          SELECT t.*, ${ftsHelper.rankExpression('fts')} as rank
          FROM ${ftsHelper.joinClause('memory_traces', 't', 'fts', 'memory_traces_fts')}
          ${whereClause}
          AND ${ftsHelper.matchClause('memory_traces_fts', '?')}
          ORDER BY abs(${ftsHelper.rankExpression('fts')}) DESC
          LIMIT ?
        `;
        let ftsRows: FtsJoinRow[] = [];
        try {
          ftsRows = await this._brain.all<FtsJoinRow>(
            ftsSql,
            [...params, ftsQuery, candidateLimit],
          );
        } catch (error) {
          if (!isFtsUnavailableError(error)) {
            throw error;
          }
        }

        const ftsRank = new Map(ftsRows.map((r, i) => [r.id, i + 1]));

        // Merge all candidate IDs.
        const allIds = new Set([...hnswIds, ...ftsRows.map(r => r.id)]);
        const rrfK = 60; // Standard RRF constant.

        // Compute RRF score for each candidate.
        const scored: { id: string; rrfScore: number }[] = [];
        for (const id of allIds) {
          const denseRank = hnswRank.get(id) ?? 10000;
          const lexRank = ftsRank.get(id) ?? 10000;
          const rrfScore = 1 / (rrfK + denseRank) + 1 / (rrfK + lexRank);
          scored.push({ id, rrfScore });
        }

        // Sort by RRF score descending, take top limit.
        scored.sort((a, b) => b.rrfScore - a.rrfScore);
        const topIds = scored.slice(0, candidateLimit).map(s => s.id);

        // Fetch full rows for the top candidates.
        if (topIds.length > 0) {
          const placeholders = topIds.map(() => '?').join(',');
          const fullRows = await this._brain.all<FtsJoinRow>(
            `SELECT t.*, 0.0 as rank FROM memory_traces t WHERE t.id IN (${placeholders}) AND t.deleted = 0`,
            topIds,
          );

          const updatedRows = await this._applyRecallAccessUpdates(fullRows);
          const rrfMap = new Map(scored.map(s => [s.id, s.rrfScore]));

          const results = updatedRows.map((row) => ({
            trace: this._buildTrace(row),
            score: rrfMap.get(row.id) ?? 0,
          })).sort((a, b) => b.score - a.score);

          if (!resolvedPolicy) {
            return results.slice(0, limit);
          }

          const confidence = evaluateRetrievalConfidence(
            results.map((row) => ({
              relevanceScore: standaloneRecallConfidence(row.score),
            })),
            { adaptive: resolvedPolicy.adaptive, minScore: resolvedPolicy.minScore },
          );

          return confidence.suppressResults ? [] : results.slice(0, limit);
        }
      }
    }

    // ── Path B: FTS-only (fallback when HNSW is inactive) ──
    // This is the original behavior — pure text search ranked by
    // strength * abs(fts_rank). Works without any embeddings.
    const { fts: ftsB } = this._brain.features;
    const sql = `
      SELECT t.*, ${ftsB.rankExpression('fts')} as rank
      FROM ${ftsB.joinClause('memory_traces', 't', 'fts', 'memory_traces_fts')}
      ${whereClause}
      AND ${ftsB.matchClause('memory_traces_fts', '?')}
      ORDER BY (t.strength * abs(${ftsB.rankExpression('fts')})) DESC
      LIMIT ?
    `;

    params.push(ftsQuery, candidateLimit);

    let rows: FtsJoinRow[];
    try {
      rows = await this._brain.all<FtsJoinRow>(sql, params);
    } catch (error) {
      if (!isFtsUnavailableError(error)) {
        throw error;
      }
      rows = await this._recallWithoutFts(query, whereClause, params.slice(0, -2), candidateLimit);
    }

    const updatedRows = await this._applyRecallAccessUpdates(rows);

    const results = updatedRows.map((row) => ({
      trace: this._buildTrace(row),
      score: row.strength * Math.abs(row.rank),
    }));

    if (!resolvedPolicy) {
      return results.slice(0, limit);
    }

    const confidence = evaluateRetrievalConfidence(
      results.map((row) => ({
        relevanceScore: standaloneRecallConfidence(row.score),
      })),
      { adaptive: resolvedPolicy.adaptive, minScore: resolvedPolicy.minScore },
    );

    return confidence.suppressResults ? [] : results.slice(0, limit);
  }

  /**
   * Soft-delete a memory trace by setting `deleted = 1`.
   *
   * The trace remains in the database for audit/recovery purposes but is
   * excluded from all recall queries and health reports.
   *
   * @param traceId - The ID of the trace to forget.
   */
  async forget(traceId: string): Promise<void> {
    await this._initPromise;

    await this._brain.run(
      'UPDATE memory_traces SET deleted = 1 WHERE brain_id = ? AND id = ?',
      [this._brain.brainId, traceId],
    );
  }

  /**
   * List traces created strictly after `sinceMs` (Unix-ms), newest first.
   *
   * Unlike {@link recall}, this performs no FTS match — it is a time-window scan,
   * used by the wiki compiler to fold recent activity into pages.
   *
   * @param sinceMs - Exclusive lower bound on `created_at` (Unix ms). Use 0 for "all".
   * @param options - Optional scope filter and result cap (default 200).
   */
  async recentTraces(
    sinceMs: number,
    options?: { limit?: number; scope?: string },
  ): Promise<MemoryTrace[]> {
    await this._initPromise;
    const limit = options?.limit ?? 200;
    const conditions = ['brain_id = ?', 'deleted = 0', 'created_at > ?'];
    const params: unknown[] = [this._brain.brainId, sinceMs];
    if (options?.scope) {
      conditions.push('scope = ?');
      params.push(options.scope);
    }
    params.push(limit);

    const rows = await this._brain.all<TraceRow>(
      `SELECT id, type, scope, content, embedding, strength, created_at,
              last_accessed, retrieval_count, tags, emotions, metadata, deleted
       FROM memory_traces
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      params,
    );
    return rows.map((row) => this._buildTrace(row));
  }

  /** Optional markdown wiki store + compiler, attached by the agent at boot. */
  private _wiki?: {
    store: {
      index: (o?: { force?: boolean }) => Promise<unknown>;
      readMetaWatermark: () => Promise<string | null>;
      writeMetaWatermark: (iso: string) => Promise<void>;
    };
    compiler: {
      compile: (input: {
        traces: MemoryTrace[];
        reason: 'consolidation' | 'session-end' | 'explicit';
      }) => Promise<CompileResult>;
    };
  };

  /**
   * Attach a markdown wiki store + compiler. Called by the agent at boot once
   * the memory/ workspace directory is known. Idempotent (last call wins).
   */
  attachWiki(wiki: NonNullable<Memory['_wiki']>): void {
    this._wiki = wiki;
  }

  /**
   * Compile recent (non-wiki) traces into the markdown wiki, then re-index.
   * Reads the wiki's watermark, folds every trace created since into pages, and
   * advances the watermark. No-op when no wiki is attached.
   *
   * @param opts.reason - What triggered this compile (telemetry + compiler hint).
   */
  async compileWiki(opts?: {
    reason?: 'consolidation' | 'session-end' | 'explicit';
  }): Promise<CompileResult> {
    await this._initPromise;
    const empty: CompileResult = { pagesWritten: [], tracesConsumed: 0, conflicts: [] };
    if (!this._wiki) return empty;

    const reason = opts?.reason ?? 'explicit';
    const watermarkIso = await this._wiki.store.readMetaWatermark();
    const sinceMs = watermarkIso ? Date.parse(watermarkIso) : 0;
    const traces = await this.recentTraces(sinceMs, { limit: 500 });

    const result = await this._wiki.compiler.compile({ traces, reason });
    if (result.pagesWritten.length > 0) {
      await this._wiki.store.index();
    }
    await this._wiki.store.writeMetaWatermark(new Date(Date.now()).toISOString());
    return result;
  }

  // =========================================================================
  // Document ingestion
  // =========================================================================

  /**
   * Ingest documents from a file, directory, or URL.
   *
   * Workflow:
   * 1. Detect source type (file, directory, or URL).
   * 2. Load document(s) using the appropriate loader.
   * 3. Chunk each document using the configured strategy.
   * 4. For each chunk: insert into `document_chunks`, create a memory trace.
   * 5. Record the document in the `documents` table.
   *
   * @param source  - File path, directory path, or URL.
   * @param options - Optional ingestion settings (recursive, include/exclude globs).
   * @returns Summary of the ingestion run.
   */
  async ingest(source: string, options?: IngestOptions): Promise<IngestResult> {
    await this._initPromise;

    const result: IngestResult = {
      succeeded: [],
      failed: [],
      chunksCreated: 0,
      tracesCreated: 0,
    };

    const chunking = {
      strategy: (this._config.ingestion?.chunkStrategy ?? 'semantic') as 'fixed' | 'semantic' | 'hierarchical' | 'layout',
      chunkSize: this._config.ingestion?.chunkSize ?? 512,
      chunkOverlap: this._config.ingestion?.chunkOverlap ?? 64,
    };
    const { loaderRegistry, folderScanner } = await this._ensureIngestionTools();
    const urlLoader = new UrlLoader(loaderRegistry);

    try {
      // Detect source type.
      const fsModule = await _getFs();
      const stat = await fsModule.stat(source).catch(() => null);

      if (stat?.isDirectory()) {
        // Directory scan.
        const scanResult = await folderScanner.scan(source, {
          recursive: options?.recursive ?? true,
          include: options?.include,
          exclude: options?.exclude,
          onProgress: options?.onProgress
            ? (file, index, total) => options.onProgress!(index, total, file)
            : undefined,
        });

        result.succeeded.push(...scanResult.succeeded);
        result.failed.push(...scanResult.failed);

        // Chunk and store each loaded document.
        for (const doc of scanResult.documents) {
          try {
            await this._ingestLoadedDocument(doc.metadata.source ?? source, doc, chunking, result);
          } catch (err) {
            result.failed.push({
              path: doc.metadata.source ?? source,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else if (stat?.isFile()) {
        // Single file.
        try {
          const doc = await loaderRegistry.loadFile(source);
          result.succeeded.push(source);
          await this._ingestLoadedDocument(source, doc, chunking, result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          result.failed.push({ path: source, error: message });
        }
      } else if (urlLoader.canLoad(source)) {
        try {
          const doc = await urlLoader.load(source);
          result.succeeded.push(source);
          await this._ingestLoadedDocument(source, doc, chunking, result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          result.failed.push({ path: source, error: message });
        }
      } else {
        // Unknown source.
        result.failed.push({
          path: source,
          error: `Source "${source}" is not a file, directory, or supported URL.`,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ path: source, error: message });
    }

    return result;
  }

  private async _ensureIngestionTools(): Promise<{
    loaderRegistry: LoaderRegistry;
    folderScanner: FolderScanner;
  }> {
    if (this._loaderRegistry && this._folderScanner) {
      return {
        loaderRegistry: this._loaderRegistry,
        folderScanner: this._folderScanner,
      };
    }

    if (!this._ingestionToolsPromise) {
      this._ingestionToolsPromise = (async () => {
        const [{ LoaderRegistry }, { FolderScanner }] = await Promise.all([
          import('../ingestion/LoaderRegistry.js'),
          import('../ingestion/FolderScanner.js'),
        ]);

        const loaderRegistry = this._loaderRegistry ?? new LoaderRegistry();
        const folderScanner = this._folderScanner ?? new FolderScanner(loaderRegistry);

        this._loaderRegistry = loaderRegistry;
        this._folderScanner = folderScanner;

        return { loaderRegistry, folderScanner };
      })();
    }

    try {
      return await this._ingestionToolsPromise;
    } finally {
      this._ingestionToolsPromise = null;
    }
  }

  // =========================================================================
  // Knowledge graph
  // =========================================================================

  /**
   * Add or update an entity in the knowledge graph.
   *
   * Delegates to `SqlKnowledgeGraph.upsertEntity()`. Accepts a partial
   * entity; `id`, `createdAt`, and `updatedAt` are auto-generated when omitted.
   *
   * @param entity - Partial entity descriptor.
   * @returns The complete, persisted entity.
   */
  async addEntity(
    entity: Partial<KnowledgeEntity>,
  ): Promise<KnowledgeEntity> {
    await this._initPromise;

    return this._knowledgeGraph.upsertEntity({
      type: entity.type ?? 'concept',
      label: entity.label ?? '',
      properties: entity.properties ?? {},
      confidence: entity.confidence ?? 1.0,
      source: entity.source ?? {
        type: 'system',
        timestamp: new Date().toISOString(),
      },
      embedding: entity.embedding,
      ownerId: entity.ownerId,
      tags: entity.tags,
      metadata: entity.metadata,
      ...(entity.id ? { id: entity.id } : {}),
    });
  }

  /**
   * Add or update a relation (edge) in the knowledge graph.
   *
   * Delegates to `SqlKnowledgeGraph.upsertRelation()`. Accepts a partial
   * relation; `id` and `createdAt` are auto-generated when omitted.
   *
   * @param relation - Partial relation descriptor.
   * @returns The complete, persisted relation.
   */
  async addRelation(
    relation: Partial<KnowledgeRelation>,
  ): Promise<KnowledgeRelation> {
    await this._initPromise;

    return this._knowledgeGraph.upsertRelation({
      sourceId: relation.sourceId ?? '',
      targetId: relation.targetId ?? '',
      type: relation.type ?? 'related_to',
      label: relation.label ?? '',
      weight: relation.weight ?? 1.0,
      bidirectional: relation.bidirectional ?? false,
      confidence: relation.confidence ?? 1.0,
      source: relation.source ?? {
        type: 'system',
        timestamp: new Date().toISOString(),
      },
      properties: relation.properties,
      validFrom: relation.validFrom,
      validTo: relation.validTo,
      ...(relation.id ? { id: relation.id } : {}),
    });
  }

  /**
   * Access the underlying IKnowledgeGraph implementation.
   *
   * Useful for advanced queries (traversal, semantic search, neighbourhood
   * lookups) that are not exposed on the facade directly.
   */
  get graph(): IKnowledgeGraph {
    return this._knowledgeGraph;
  }

  // =========================================================================
  // Self-improvement
  // =========================================================================

  /**
   * Run one consolidation cycle (prune, merge, strengthen, derive, compact,
   * re-index).
   *
   * @param options - Optional topic filter (reserved for future use).
   * @returns Statistics from the consolidation run.
   * @throws {Error} When `selfImprove` was set to `false` in the config.
   */
  async consolidate(options?: { topic?: string }): Promise<ConsolidationResult> {
    await this._initPromise;

    if (!this._consolidationLoop) {
      throw new Error(
        'Memory.consolidate(): self-improvement is disabled. ' +
        'Set selfImprove: true in the MemoryConfig to enable consolidation.',
      );
    }

    const consolidation = await this._consolidationLoop.run(this._config.consolidation);
    if (this._wiki) {
      await this.compileWiki({ reason: 'consolidation' });
    }
    return consolidation;
  }

  /**
   * Record retrieval feedback for a memory trace.
   *
   * The feedback is persisted asynchronously. This method returns a Promise
   * that resolves once the feedback has been written.
   *
   * @param traceId - The ID of the trace being evaluated.
   * @param signal  - Whether the trace was `'used'` or `'ignored'` by the LLM.
   * @param query   - Optional retrieval context, typically the original user query.
   */
  async feedback(traceId: string, signal: 'used' | 'ignored', query?: string): Promise<void> {
    if (!this._feedbackSignal) return;

    try {
      const now = Date.now();
      const brainId = this._brain.brainId;
      const row = await this._brain.get<TraceRow>(
        `SELECT id, type, scope, content, embedding, strength, created_at,
                last_accessed, retrieval_count, tags, emotions, metadata, deleted
         FROM memory_traces
         WHERE brain_id = ? AND id = ?
         LIMIT 1`,
        [brainId, traceId],
      );

      await this._brain.run(
        `INSERT INTO retrieval_feedback (brain_id, trace_id, signal, query, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [brainId, traceId, signal, query ?? null, now],
      );

      if (!row) return;

      if (signal === 'used') {
        const update = updateOnRetrieval(this._buildTrace(row), now);
        const metadata = JSON.stringify(
          withPersistedDecayState(parseTraceMetadata(row.metadata), {
            stability: update.stability,
            accessCount: update.accessCount,
            reinforcementInterval: update.reinforcementInterval,
            nextReinforcementAt: update.nextReinforcementAt,
          }),
        );
        await this._brain.run(
          `UPDATE memory_traces
           SET strength = ?, last_accessed = ?, retrieval_count = ?, metadata = ?
           WHERE brain_id = ? AND id = ?`,
          [
            update.encodingStrength,
            update.lastAccessedAt,
            update.retrievalCount,
            metadata,
            brainId,
            traceId,
          ],
        );
        return;
      }

      const penalty = penalizeUnused(this._buildTrace(row), now);
      const existingDecay = readPersistedDecayState(parseTraceMetadata(row.metadata), row.retrieval_count);
      const metadata = JSON.stringify(
        withPersistedDecayState(parseTraceMetadata(row.metadata), {
          stability: penalty.stability,
          accessCount: existingDecay.accessCount,
          reinforcementInterval: existingDecay.reinforcementInterval,
          ...(existingDecay.nextReinforcementAt !== undefined
            ? { nextReinforcementAt: existingDecay.nextReinforcementAt }
            : {}),
        }),
      );
      await this._brain.run(
        `UPDATE memory_traces
         SET strength = ?, last_accessed = ?, metadata = ?
         WHERE brain_id = ? AND id = ?`,
        [penalty.encodingStrength, penalty.lastAccessedAt, metadata, brainId, traceId],
      );
    } catch {
      // Explicit feedback is best-effort; the caller should not fail on analytics updates.
    }
  }

  /**
   * Detect and persist used/ignored feedback for a batch of injected traces
   * based on the assistant's final response text.
   *
   * This is the high-level bridge used by long-term-memory integrations that
   * already know which traces were injected into the prompt.
   */
  async feedbackFromResponse(
    injectedTraces: MemoryTrace[],
    response: string,
    query?: string,
  ): Promise<RetrievalFeedback[]> {
    if (!this._feedbackSignal) return [];
    return this._feedbackSignal.detect(injectedTraces, response, query);
  }

  // =========================================================================
  // Import / Export
  // =========================================================================

  /**
   * Export the memory store to a file or directory.
   *
   * Format is detected from `options.format` or the file extension:
   * - `.json` -> JSON
   * - `.sqlite` / `.db` -> SQLite file copy
   * - directory path -> Markdown or Obsidian (based on `options.format`)
   *
   * @param outputPath - Path to write the export to.
   * @param options    - Optional format and content controls.
   */
  async export(outputPath: string, options?: ExportOptions): Promise<void> {
    await this._initPromise;

    const format = await this._detectExportFormat(outputPath, options);

    switch (format) {
      case 'json': {
        const { JsonExporter } = await import('../JsonExporter.js');
        const exporter = new JsonExporter(this._brain);
        await exporter.export(outputPath, options);
        break;
      }
      case 'markdown': {
        const { MarkdownExporter } = await import('../MarkdownExporter.js');
        const exporter = new MarkdownExporter(this._brain);
        await exporter.export(outputPath, options);
        break;
      }
      case 'obsidian': {
        const { ObsidianExporter } = await import('../ObsidianExporter.js');
        const exporter = new ObsidianExporter(this._brain);
        await exporter.export(outputPath, options);
        break;
      }
      case 'sqlite': {
        const { SqliteExporter } = await import('../SqliteExporter.js');
        const exporter = new SqliteExporter(this._brain);
        await exporter.export(outputPath, options);
        break;
      }
      default: {
        throw new Error(`Memory.export(): unsupported format "${format}".`);
      }
    }
  }

  /**
   * Import memory data from a file or directory.
   *
   * Format is detected from `options.format`, the file extension, or by
   * inspecting the content.
   *
   * @param source  - Path to the import source (file or directory).
   * @param options - Optional format hint and dedup settings.
   * @returns Summary of the import operation.
   */
  async importFrom(source: string, options?: ImportOptions): Promise<ImportResult> {
    await this._initPromise;

    const format = await this._detectImportFormat(source, options);
    let result: ImportResult;

    switch (format) {
      case 'json': {
        const { JsonImporter } = await import('../JsonImporter.js');
        result = await new JsonImporter(this._brain).import(source, options);
        break;
      }
      case 'markdown': {
        const { MarkdownImporter } = await import('../MarkdownImporter.js');
        result = await new MarkdownImporter(this._brain).import(source, options);
        break;
      }
      case 'obsidian': {
        const { ObsidianImporter } = await import('../ObsidianImporter.js');
        result = await new ObsidianImporter(this._brain).import(source, options);
        break;
      }
      case 'sqlite': {
        const { SqliteImporter } = await import('../SqliteImporter.js');
        result = await new SqliteImporter(this._brain).import(source, options);
        break;
      }
      case 'chatgpt': {
        const { ChatGptImporter } = await import('../ChatGptImporter.js');
        result = await new ChatGptImporter(this._brain).import(source, options);
        break;
      }
      case 'csv': {
        const { CsvImporter } = await import('../CsvImporter.js');
        result = await new CsvImporter(this._brain).import(source, options);
        break;
      }
      default:
        result = { imported: 0, skipped: 0, errors: [`Unsupported import format: "${format}"`] };
        break;
    }

    if (result.imported > 0) {
      await this._rebuildFtsIndex();
      await this._rebuildHnswIndex();
    }

    return result;
  }

  /**
   * Import memory data from a string without filesystem access.
   *
   * Supports JSON and CSV formats. Useful in browser environments or when
   * the data is already in memory.
   *
   * @param content - The raw string content to import.
   * @param format  - The format of the content: `'json'` or `'csv'`.
   * @param options - Optional deduplication controls.
   * @returns Summary of the import operation.
   */
  async importFromString(
    content: string,
    format: 'json' | 'csv',
    options?: Pick<ImportOptions, 'dedup'>,
  ): Promise<ImportResult> {
    await this._initPromise;

    let result: ImportResult;
    if (format === 'json') {
      const { JsonImporter } = await import('../JsonImporter.js');
      result = await new JsonImporter(this._brain).importFromString(content, options);
    } else {
      const { CsvImporter } = await import('../CsvImporter.js');
      result = await new CsvImporter(this._brain).importFromString(content, options);
    }

    if (result.imported > 0) {
      await this._rebuildFtsIndex();
      await this._rebuildHnswIndex();
    }

    return result;
  }

  /**
   * Export the full brain state as a JSON string without filesystem access.
   *
   * Useful in browser environments or when the data needs to be sent over
   * a network connection.
   *
   * @param options - Optional export configuration (embeddings, conversations).
   * @returns Pretty-printed JSON string of the full brain payload.
   */
  async exportToString(options?: ExportOptions): Promise<string> {
    await this._initPromise;
    const { JsonExporter } = await import('../JsonExporter.js');
    return new JsonExporter(this._brain).exportToString(options);
  }

  // =========================================================================
  // Tool integration
  // =========================================================================

  /**
   * Create runtime `ITool` instances backed by this memory facade's SQLite brain.
   *
   * This is the supported bridge from the standalone memory engine into
   * AgentOS tool registration. The returned tools share this `Memory`
   * instance's underlying SQLite database and consolidation loop.
   *
   * Typical usage:
   * ```ts
   * for (const tool of memory.createTools()) {
   *   await agentos.getToolOrchestrator().registerTool(tool);
   * }
   * ```
   *
   * When self-improvement is disabled, `memory_reflect` is omitted because
   * there is no backing {@link ConsolidationLoop} instance.
   */
  createTools(options?: { includeReflect?: boolean }): ITool[] {
    const tools: ITool[] = [
      new MemoryAddTool(this._brain),
      new MemoryUpdateTool(this._brain),
      new MemoryDeleteTool(this._brain),
      new MemoryMergeTool(this._brain),
      new MemorySearchTool(this._brain),
    ];

    const includeReflect = options?.includeReflect ?? true;
    if (includeReflect && this._consolidationLoop) {
      tools.push(new MemoryReflectTool(this._brain, this._consolidationLoop));
    }

    return tools;
  }

  // =========================================================================
  // Health
  // =========================================================================

  /**
   * Return a health snapshot of the memory store.
   *
   * Queries aggregate statistics from all tables and returns a
   * {@link MemoryHealth} report.
   */
  async health(): Promise<MemoryHealth> {
    await this._initPromise;

    // Total traces (active + deleted).
    const totalRow = await this._brain.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM memory_traces',
    );
    const totalTraces = totalRow?.cnt ?? 0;

    // Active traces (not deleted).
    const activeRow = await this._brain.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM memory_traces WHERE deleted = 0',
    );
    const activeTraces = activeRow?.cnt ?? 0;

    // Average strength of active traces.
    const avgRow = await this._brain.get<{ avg_s: number | null }>(
      'SELECT AVG(strength) AS avg_s FROM memory_traces WHERE deleted = 0',
    );
    const avgStrength = avgRow?.avg_s ?? 0;

    // Weakest active trace.
    const weakRow = await this._brain.get<{ min_s: number | null }>(
      'SELECT MIN(strength) AS min_s FROM memory_traces WHERE deleted = 0',
    );
    const weakestTraceStrength = weakRow?.min_s ?? 0;

    // Knowledge graph counts.
    const nodesRow = await this._brain.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM knowledge_nodes',
    );
    const graphNodes = nodesRow?.cnt ?? 0;

    const edgesRow = await this._brain.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM knowledge_edges',
    );
    const graphEdges = edgesRow?.cnt ?? 0;

    // Last consolidation timestamp.
    const lastConsolRow = await this._brain.get<{ ran_at: number }>(
      'SELECT ran_at FROM consolidation_log ORDER BY ran_at DESC LIMIT 1',
    );
    const lastConsolidation = lastConsolRow
      ? new Date(lastConsolRow.ran_at).toISOString()
      : null;

    // Traces per type.
    const typeRows = await this._brain.all<{ type: string; cnt: number }>(
      'SELECT type, COUNT(*) AS cnt FROM memory_traces WHERE deleted = 0 GROUP BY type',
    );
    const tracesPerType: Record<string, number> = {};
    for (const row of typeRows) {
      tracesPerType[row.type] = row.cnt;
    }

    // Traces per scope.
    const scopeRows = await this._brain.all<{ scope: string; cnt: number }>(
      'SELECT scope, COUNT(*) AS cnt FROM memory_traces WHERE deleted = 0 GROUP BY scope',
    );
    const tracesPerScope: Record<string, number> = {};
    for (const row of scopeRows) {
      tracesPerScope[row.scope] = row.cnt;
    }

    // Total document chunks.
    const docsRow = await this._brain.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM documents',
    );
    const documentsIngested = docsRow?.cnt ?? 0;

    return {
      totalTraces,
      activeTraces,
      avgStrength,
      weakestTraceStrength,
      graphNodes,
      graphEdges,
      lastConsolidation,
      tracesPerType,
      tracesPerScope,
      documentsIngested,
    };
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Close the Memory instance and release all resources.
   *
   * Flushes the SQLite WAL and releases the file lock. Must be called when
   * the agent shuts down.
   */
  async close(): Promise<void> {
    await this._initPromise;
    await this._brain.close();
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Convert a raw `memory_traces` row into a `MemoryTrace` object.
   */
  private _buildTrace(row: TraceRow): MemoryTrace {
    let tags: string[] = [];
    try { tags = JSON.parse(row.tags); } catch { /* empty */ }

    let emotions = {};
    try { emotions = JSON.parse(row.emotions); } catch { /* empty */ }

    const metadata = parseTraceMetadata(row.metadata);

    const entities = Array.isArray(metadata.entities) ? metadata.entities as string[] : [];
    const scopeId = typeof metadata.scopeId === 'string' ? metadata.scopeId : '';
    const decayState = readPersistedDecayState(metadata, row.retrieval_count);

    return {
      id: row.id,
      type: row.type as MemoryTrace['type'],
      scope: row.scope as MemoryTrace['scope'],
      scopeId,
      content: row.content,
      entities,
      tags,
      provenance: {
        sourceType: 'user_statement',
        sourceTimestamp: row.created_at,
        confidence: 1.0,
        verificationCount: 0,
      },
      emotionalContext: {
        valence: 0,
        arousal: 0,
        dominance: 0,
        intensity: 0,
        gmiMood: 'neutral',
        ...emotions,
      },
      encodingStrength: row.strength,
      stability: decayState.stability,
      retrievalCount: row.retrieval_count,
      lastAccessedAt: row.last_accessed ?? row.created_at,
      accessCount: decayState.accessCount,
      reinforcementInterval: decayState.reinforcementInterval,
      ...(decayState.nextReinforcementAt !== undefined
        ? { nextReinforcementAt: decayState.nextReinforcementAt }
        : {}),
      associatedTraceIds: [],
      createdAt: row.created_at,
      updatedAt: row.created_at,
      isActive: row.deleted === 0,
    };
  }

  /**
   * Find an active trace previously stored with the same content hash.
   *
   * Checks both the facade-native `content_hash` metadata key and the
   * importer-used `import_hash` key so dedup works across facade and import
   * workflows.
   */
  private async _findExistingTraceByHash(
    contentHash: string,
    type: string,
    scope: string,
    scopeId: string,
  ): Promise<TraceRow | undefined> {
    const { dialect } = this._brain.features;
    const row = await this._brain.get<TraceRow>(
      `SELECT id, type, scope, content, embedding, strength, created_at,
              last_accessed, retrieval_count, tags, emotions, metadata, deleted
       FROM memory_traces
       WHERE deleted = 0
         AND type = ?
         AND scope = ?
         AND ${dialect.ifnull(dialect.jsonExtract('metadata', '$.scopeId'), "''")} = ?
         AND (
           ${dialect.jsonExtract('metadata', '$.content_hash')} = ?
           OR ${dialect.jsonExtract('metadata', '$.import_hash')} = ?
         )
       LIMIT 1`,
      [type, scope, scopeId, contentHash, contentHash],
    );
    return row ?? undefined;
  }

  /**
   * Apply spaced-repetition access updates to recalled rows and persist the
   * updated retrieval metadata back to SQLite.
   */
  private async _applyRecallAccessUpdates(rows: FtsJoinRow[]): Promise<FtsJoinRow[]> {
    if (rows.length === 0) return rows;

    const now = Date.now();

    const brainId = this._brain.brainId;
    return this._brain.transaction(async (trx) => {
      const results: FtsJoinRow[] = [];
      for (const row of rows) {
        const update = updateOnRetrieval(this._buildTrace(row), now);
        const metadata = JSON.stringify(
          withPersistedDecayState(parseTraceMetadata(row.metadata), {
            stability: update.stability,
            accessCount: update.accessCount,
            reinforcementInterval: update.reinforcementInterval,
            nextReinforcementAt: update.nextReinforcementAt,
          }),
        );
        await trx.run(
          `UPDATE memory_traces
           SET strength = ?, last_accessed = ?, retrieval_count = ?, metadata = ?
           WHERE brain_id = ? AND id = ?`,
          [
            update.encodingStrength,
            update.lastAccessedAt,
            update.retrievalCount,
            metadata,
            brainId,
            row.id,
          ],
        );

        results.push({
          ...row,
          strength: update.encodingStrength,
          last_accessed: update.lastAccessedAt,
          retrieval_count: update.retrievalCount,
          metadata,
        });
      }
      return results;
    });
  }

  /**
   * Persist one loaded document into the documents/chunks/traces tables.
   *
   * Document-level dedup is keyed by `documents.content_hash`, so re-ingesting
   * the same source content is idempotent.
   */
  private async _ingestLoadedDocument(
    source: string,
    doc: LoadedDocument,
    chunking: {
      strategy: 'fixed' | 'semantic' | 'hierarchical' | 'layout';
      chunkSize: number;
      chunkOverlap: number;
    },
    result: IngestResult,
  ): Promise<void> {
    const brainId = this._brain.brainId;
    const contentHash = await sha256(doc.content);
    const existingDoc = await this._brain.get<{ id: string }>(
      `SELECT id FROM documents WHERE brain_id = ? AND content_hash = ? LIMIT 1`,
      [brainId, contentHash],
    );

    if (existingDoc) {
      return;
    }

    const chunks = await this._chunkingEngine.chunk(doc.content, chunking);
    const docId = `doc_${uuid()}`;

    await this._brain.run(
      `INSERT INTO documents
         (brain_id, id, path, format, title, content_hash, chunk_count, metadata, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        brainId,
        docId,
        doc.metadata.source ?? source,
        doc.format,
        doc.metadata.title ?? null,
        contentHash,
        chunks.length,
        JSON.stringify(doc.metadata),
        Date.now(),
      ],
    );

    for (const chunk of chunks) {
      const chunkId = `chunk_${uuid()}`;
      const traceId = nextTraceId();
      const createdAt = Date.now();

      await this._brain.run(
        `INSERT INTO memory_traces
           (brain_id, id, type, scope, content, embedding, strength, created_at,
            last_accessed, retrieval_count, tags, emotions, metadata, deleted)
         VALUES (?, ?, 'semantic', 'user', ?, NULL, 1.0, ?, NULL, 0, '[]', '{}', ?, 0)`,
        [
          brainId,
          traceId,
          chunk.content,
          createdAt,
          JSON.stringify(
            buildInitialTraceMetadata(
              {
                document_id: docId,
                chunk_index: chunk.index,
              },
              { contentHash: await sha256(chunk.content) },
            ),
          ),
        ],
      );

      await this._brain.run(
        this._brain.features.fts.syncInsert('memory_traces_fts', '(SELECT rowid FROM memory_traces WHERE id = ?)', ['content', 'tags']),
        [traceId, chunk.content, '[]'],
      ).catch((error) => {
        if (!isFtsUnavailableError(error)) {
          throw error;
        }
      });

      if (this._config.graph && !this._memoryGraph.hasNode(traceId)) {
        await this._memoryGraph.addNode(traceId, {
          type: 'semantic',
          scope: 'user',
          scopeId: docId,
          strength: 1.0,
          createdAt,
        });
      }

      await this._brain.run(
        `INSERT INTO document_chunks (brain_id, id, document_id, trace_id, content, chunk_index, page_number, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          brainId,
          chunkId,
          docId,
          traceId,
          chunk.content,
          chunk.index,
          chunk.pageNumber ?? null,
        ],
      );

      result.chunksCreated++;
      result.tracesCreated++;
    }
  }

  /**
   * Rebuild the external-content FTS index after bulk import operations.
   */
  private async _rebuildFtsIndex(): Promise<void> {
    try {
      await this._brain.exec(this._brain.features.fts.rebuildCommand('memory_traces_fts'));
    } catch {
      // Best-effort; imports still succeed even if the FTS rebuild is unavailable.
    }
  }

  private async _recallWithoutFts(
    rawQuery: string,
    whereClause: string,
    baseParams: unknown[],
    limit: number,
  ): Promise<FtsJoinRow[]> {
    const terms = rawQuery
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.replace(/[^\p{L}\p{N}_-]+/gu, ''))
      .filter((term) => term.length > 0);

    if (terms.length === 0) {
      return [];
    }

    const scoreExpression = terms
      .map(() => `CASE WHEN lower(t.content) LIKE ? THEN 1 ELSE 0 END`)
      .join(' + ');
    const matchExpression = terms
      .map(() => 'lower(t.content) LIKE ?')
      .join(' OR ');
    const likeTerms = terms.map((term) => `%${term}%`);

    const sql = `
      SELECT t.*, (${scoreExpression}) as rank
      FROM memory_traces t
      ${whereClause}
      AND (${matchExpression})
      ORDER BY (t.strength * (${scoreExpression})) DESC, t.created_at DESC
      LIMIT ?
    `;

    return this._brain.all<FtsJoinRow>(
      sql,
      [...baseParams, ...likeTerms, ...likeTerms, ...likeTerms, limit],
    );
  }

  /**
   * Rebuild the HNSW sidecar after bulk import operations.
   *
   * Imports bypass `remember()`, so any embedded traces need to be replayed
   * into the ANN sidecar explicitly to keep hybrid recall accurate.
   */
  private async _rebuildHnswIndex(): Promise<void> {
    if (!this._hnswSidecar) return;

    try {
      const rows = await this._brain.all<{ id: string; embedding: Uint8Array | string | null }>(
        'SELECT id, embedding FROM memory_traces WHERE deleted = 0 AND embedding IS NOT NULL',
      );
      if (rows.length === 0) return;

      const { blobCodec } = this._brain.features;
      const items = rows
        .filter((row) => row.embedding && row.embedding.length > 0)
        .map((row) => {
          const embedding = row.embedding!;
          const isLegacy = typeof embedding === 'string' || embedding[0] === 0x5b;
          return {
            id: row.id,
            embedding: isLegacy
              ? JSON.parse(embedding as unknown as string) as number[]
              : blobCodec.decode(embedding),
          };
        });

      if (items.length > 0) {
        await this._hnswSidecar.rebuildFromData(items);
      }
    } catch {
      // Best-effort; import should still succeed even if HNSW rebuild fails.
    }
  }

  /**
   * Detect the export format from options or file extension.
   */
  private async _detectExportFormat(
    outputPath: string,
    options?: ExportOptions,
  ): Promise<'json' | 'markdown' | 'obsidian' | 'sqlite'> {
    if (options?.format) return options.format;

    const pathModule = await _getPath();
    const ext = pathModule.extname(outputPath).toLowerCase();
    switch (ext) {
      case '.json': return 'json';
      case '.sqlite':
      case '.db': return 'sqlite';
      default: return 'markdown';
    }
  }

  /**
   * Detect the import format from options, file extension, or content inspection.
   */
  private async _detectImportFormat(
    source: string,
    options?: ImportOptions,
  ): Promise<'json' | 'markdown' | 'obsidian' | 'sqlite' | 'chatgpt' | 'csv'> {
    if (options?.format && options.format !== 'auto') return options.format;

    const pathModule = await _getPath();
    const ext = pathModule.extname(source).toLowerCase();
    switch (ext) {
      case '.json': {
        // Check if it looks like a ChatGPT export.
        try {
          const fsModule = await _getFs();
          const head = await fsModule.readFile(source, { encoding: 'utf8', flag: 'r' });
          if (head.includes('"mapping"') && head.includes('"conversation_id"')) {
            return 'chatgpt';
          }
        } catch { /* fall through */ }
        return 'json';
      }
      case '.sqlite':
      case '.db': return 'sqlite';
      case '.csv': return 'csv';
      default: {
        // Check if source is a directory.
        try {
          const fsModule = await _getFs();
          const stat = await fsModule.stat(source);
          if (stat.isDirectory()) return 'markdown';
        } catch { /* fall through */ }
        return 'json';
      }
    }
  }
}
