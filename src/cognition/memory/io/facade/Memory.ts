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

import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { MemoryTrace } from '../../core/types.js';
import type { CompileResult } from '../../../substrate/memory/wiki/types.js';
import type { WikiCompilerStorePort } from '../../../substrate/memory/wiki/WikiCompiler.js';
import type { ITool } from '../../../../core/tools/ITool.js';
import type {
  MemoryConfig,
  MemoryPageChunk,
  MemoryPageRow,
  RememberOptions,
  RecallOptions,
  IngestOptions,
  IngestResult,
  ExportOptions,
  ExportResult,
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
  bindingsFor,
  buildNaturalLanguageFtsQuery,
  buildInitialTraceMetadata,
  parseTraceMetadata,
  readPersistedDecayState,
  withPersistedDecayState,
  writeTraceSnapshot,
  deleteTraceRows,
  holdsEncodedScopeIdForm,
  readTraceSnapshot,
  traceNamesUser,
  type TraceSnapshot,
} from '../../retrieval/store/tracePersistence.js';
import { fillScopeIds } from '../../retrieval/store/migrations/v2-to-v3.js';
import { ForgottenLedger, type SuppressionSubject } from '../../suppression/ForgottenLedger.js';
import { CONVERSATION_SCOPE, parseConversationScopeKey } from '../../retrieval/store/conversationScopeKey.js';
import { isMissingTableError } from '../../retrieval/store/missingTable.js';
import { ensureScopeRow, registerUnregisteredConversationScopes } from '../../retrieval/store/conversationScopes.js';
import { memoryLog } from '../../log.js';
import { errorFields } from '../../../../core/logging/events.js';
import { assertWikiPageId } from '../../../substrate/memory/wiki/WikiPageId.js';
import { refileBrainScopeIds, snapshotInEncodedForm, takeScopeIdFormLock } from '../../retrieval/store/scopeIdForm.js';
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

/** Why a scope's wiki compile did not run in a call, as its `memory.compile_skipped` line says it. */
export type CompileSkipReason = 'budget' | 'policy_raw' | 'screen_failed' | 'forgotten';

/** What {@link Memory.attachWiki} takes: a page store per conversation scope, a compiler, and two optional hooks. */
export interface AttachedWiki {
  /** The page store of one conversation scope: a user's or a session's key. */
  storeFor(scopeId: string): WikiCompilerStorePort;
  compiler: {
    compile(input: {
      traces: MemoryTrace[];
      reason: 'consolidation' | 'session-end' | 'explicit';
      /** The store of the scope the traces are of: the compile reads and writes its pages there. */
      store: WikiCompilerStorePort;
    }): Promise<CompileResult>;
  };
  /**
   * Asked once a batch of a scope's traces, before the compiler: the traces to compile, or why this scope's
   * compile does not run. A skipped scope keeps its watermark.
   */
  beforeScopeCompile?(
    scopeId: string,
    traces: MemoryTrace[],
  ): Promise<{ traces: MemoryTrace[] } | { skip: 'policy_raw' | 'screen_failed' | 'forgotten' }>;
  /**
   * Runs one scope's compile: a host that orders each subject's writes, compiles and deletion one after another
   * passes it, and runs `work` in the subject's turn. Unset: the compile runs at once.
   */
  runScope?<T>(scopeId: string, work: () => Promise<T>): Promise<T>;
  /**
   * The reason to log for an error a scope's compile threw: `'budget'` for a spend budget's refusal. Undefined:
   * the error is the call's, thrown once every scope has run.
   */
  compileSkipReasonOf?(error: unknown): 'budget' | undefined;
}

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

/** One registered scope, as {@link Memory.listScopes} returns it. */
export interface MemoryScopeRow {
  /** The scope's id: for a conversation scope, the key `conversationScopeKey` built. */
  scopeId: string;
  /** The kind of subject the key names: `'user'`, `'session'` or `'operator'`. */
  kind: string;
  /** The agent id the key names. */
  agentId: string;
  /** When the scope's first trace was written, in Unix milliseconds. */
  createdAt: number;
  /** When the scope was last compiled into wiki pages, in Unix milliseconds; null before its first compile. */
  compiledAt: number | null;
}

/** One new trace row: the values `Memory._insertTraceRow` writes. */
interface NewTraceRow {
  id: string;
  type: string;
  scope: string;
  scopeId: string;
  content: string;
  /** The encoded vector, or null for a trace stored without one. */
  embedding: Uint8Array | null;
  strength: number;
  createdAt: number;
  /** The tags as JSON text. */
  tags: string;
  /** The metadata as JSON text. */
  metadata: string;
}

/** One row of `memory_pages` as the adapter returns it. */
interface PageRowRecord {
  page_id: string;
  content: string;
  content_hash: string;
  chunk_ids: string;
  updated_at: number | string;
}

/** A page row as the facade returns it: the chunk ids read from their JSON, the time as a number. */
function pageRowOf(row: PageRowRecord): MemoryPageRow {
  let chunkIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.chunk_ids);
    if (Array.isArray(parsed)) chunkIds = parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    // A list that does not parse names no chunk.
  }
  return {
    pageId: row.page_id,
    content: row.content,
    contentHash: row.content_hash,
    chunkIds,
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Throws when a read names the conversation scope and no scope id: that scope holds each subject's memory under a
 * key of its own, and a read of it as a whole would return every subject's traces at once.
 *
 * @param member - The facade member the read is, for the message.
 */
function assertConversationKeyGiven(member: 'recall' | 'recentTraces', scope: string | undefined, scopeId: string | undefined): void {
  if (scope === CONVERSATION_SCOPE && (typeof scopeId !== 'string' || scopeId === '')) {
    throw new TypeError(
      `Memory.${member}: the 'conversation' scope is read one key at a time; pass the scopeId conversationScopeKey() built`,
    );
  }
}

/** Throws unless `scopeId` is the conversation key of a user or of a session: the two kinds of subject that own pages. */
function assertPageOwnerKey(scopeId: string): void {
  const kind = parseConversationScopeKey(scopeId)?.subject.kind;
  if (kind !== 'user' && kind !== 'session') {
    throw new TypeError('Memory: a page belongs to a user or a session conversation key');
  }
}

/** Writes a page row the scope holds no row of that page id for; a row another writer added first is left as it is. */
const INSERT_NEW_PAGE_ROW = `INSERT INTO memory_pages
       (brain_id, scope, scope_id, page_id, content, content_hash, chunk_ids, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (brain_id, scope, scope_id, page_id) DO NOTHING`;

/** Replaces a page row only while it holds the text and the chunk list it was read with. */
const REPLACE_READ_PAGE_ROW = `UPDATE memory_pages
        SET content = ?, content_hash = ?, chunk_ids = ?, updated_at = ?
      WHERE brain_id = ? AND scope = ? AND scope_id = ? AND page_id = ? AND content = ? AND chunk_ids = ?`;

/** How many times a page write reads the row again when another writer changed it between the read and the write. */
const PAGE_WRITE_ATTEMPTS = 5;

/**
 * Each learning-store column that names a user, by table: the learner of a session, chain head, ledger row, trait row,
 * freeze or document row, and the turn's user a ledger row records.
 */
const LEARNER_USER_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['agentos_learning_sessions', 'user_id'],
  ['agentos_learning_heads', 'user_id'],
  ['agentos_learning_ledger', 'user_id'],
  ['agentos_learning_ledger', 'turn_user_id'],
  ['agentos_learning_traits', 'user_id'],
  ['agentos_learning_freezes', 'user_id'],
  ['agentos_learning_outcomes', 'user_id'],
  ['agentos_learning_lessons', 'user_id'],
  ['agentos_learning_skills', 'user_id'],
];

/** Thrown inside a page write's transaction when the row is no longer the one read, so the transaction rolls back. */
class PageRowChangedError extends Error {
  constructor() {
    super('the page row changed after it was read');
    this.name = 'PageRowChangedError';
  }
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

/**
 * What every facade of one backing store in this process shares, by the Brain's coordination token: the page writes of
 * each conversation scope still running, the compiles and deletes of each scope still running, and the compile's fence
 * (when a compile read last began, the latest time a conversation trace was stamped with, and the times of the traces
 * stamped and not yet stored, with their counts).
 */
interface SharedCoordination {
  pageWrites: Map<string, Promise<void>>;
  scopeChanges: Map<string, Promise<void>>;
  compileReadAt: number;
  lastConversationStamp: number;
  unstored: Map<number, number>;
}
const sharedCoordination = new WeakMap<object, SharedCoordination>();

/** The state the facades of the store behind `token` share in this process. */
function coordinationOf(token: object): SharedCoordination {
  let shared = sharedCoordination.get(token);
  if (!shared) {
    shared = { pageWrites: new Map(), scopeChanges: new Map(), compileReadAt: 0, lastConversationStamp: 0, unstored: new Map() };
    sharedCoordination.set(token, shared);
  }
  return shared;
}

/**
 * Runs `work` once the work queued before it under `key` in `queue` has settled, failed or not, and queues it there
 * for the work that comes next.
 */
function oneAtATime<T>(queue: Map<string, Promise<void>>, key: string, work: () => Promise<T>): Promise<T> {
  const earlier = queue.get(key) ?? Promise.resolve();
  const run = earlier.then(work, work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queue.set(key, settled);
  void settled.then(() => {
    if (queue.get(key) === settled) queue.delete(key);
  });
  return run;
}

/** The error a page write throws when other writers changed the row under each of its attempts. */
function pageChangedUnderEveryAttempt(): Error {
  return new Error(
    `Memory: the page row changed under each of ${PAGE_WRITE_ATTEMPTS} attempts to write it; nothing of this write is kept`,
  );
}

/** The trace ids a registry row's `rebuild_sources` holds: a JSON array of strings; anything else holds none. */
function rebuildSourceIds(listed: string | null): string[] {
  if (listed === null) return [];
  try {
    const parsed: unknown = JSON.parse(listed);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  } catch {
    return [];
  }
}

/** True for a trace's tags (a JSON array in text) that mark it a chunk of a wiki page. */
function isPageChunkTags(tags: string): boolean {
  try {
    const parsed: unknown = JSON.parse(tags);
    return Array.isArray(parsed) && parsed.includes('wiki');
  } catch {
    return false;
  }
}

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

  /**
   * The vector index's work, one step after another ({@link _onVectorIndex}): an add, a remove, a rebuild and a
   * rewrite never interleave, so a rewrite that read the traces writes them with nothing added or removed between.
   */
  private _vectorIndexWork: Promise<unknown> = Promise.resolve();

  /**
   * What deletes for good left to do in the store's files ({@link finishErasure}): the vector index is owed a rewrite
   * from a delete until a rewrite succeeds, and from an open whose check of the index failed; the write-ahead log is
   * owed a checkpoint while deletes were made after the last checkpoint that emptied it.
   */
  private readonly _erasureOwed = { vectorIndex: false, deletes: 0, checkpointed: 0 };

  /** Optional embedding function for vector search (set via config.embed). */
  private readonly _embed: ((text: string) => Promise<number[]>) | null;

  /** The forgotten-user ledger the store was opened with, if any (config.forgotten). */
  private readonly _forgotten: ForgottenLedger | undefined;

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
    forgotten?: ForgottenLedger,
  ) {
    this._brain = brain;
    this._config = config;
    this._forgotten = forgotten;

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

    // HNSW sidecar index (O(log n) ANN alongside SQLite), one per brain: a
    // database can hold several brains, so the index file is named for this
    // brain and holds only its vectors. Loads that index from disk if present;
    // auto-builds when the brain holds 1000 traces and embeddings are
    // available. Falls back to FTS5-only recall if hnswlib-node is not
    // installed or no embeddings exist.
    this._initPromise = this._initPromise.then(async () => {
      let sidecar: import('../../retrieval/store/HnswSidecar.js').HnswSidecar | undefined;
      try {
        const { HnswSidecar } = await import('../../retrieval/store/HnswSidecar.js');
        const dims = this._config.embeddings?.dimensions ?? 1536;
        sidecar = new HnswSidecar({
          sqlitePath: this._config.path!,
          dimensions: dims,
          brainId: this._brain.brainId,
        });
        await sidecar.init();
      } catch {
        // hnswlib-node not installed or init failed — HNSW stays null.
        // Recall will use FTS5 only (still works, just O(n) for vectors).
        this._hnswSidecar = null;
        return;
      }
      this._hnswSidecar = sidecar ?? null;
      if (!sidecar?.isActive) return;
      try {
        // The database is authoritative: an index loaded from its files is brought up to date with it before recall
        // uses it, including a small store whose index was built explicitly.
        await this._checkLoadedVectorIndex(sidecar);
      } catch (error) {
        // The files may still name a trace that is gone: their rewrite is owed, and the next deletion, sweep or
        // re-application of the tombstones runs it. Recall keeps the index as it loaded: a vector of a trace that is
        // gone finds no row.
        this._erasureOwed.vectorIndex = true;
        memoryLog.warn('memory.erasure_unfinished', errorFields(error));
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
   * Wires the Memory facade around an already-opened Brain, and opens the
   * forgotten-user ledger over the Brain's adapter when the config asks for one.
   *
   * @throws {ForgottenLedgerError} When the ledger does not open; the Brain is closed first.
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

    // The ledger's table lives beside the traces, on the store's own adapter, which exists only now.
    let forgotten: ForgottenLedger | undefined;
    if (config.forgotten instanceof ForgottenLedger) {
      forgotten = config.forgotten;
    } else if (config.forgotten) {
      try {
        forgotten = await ForgottenLedger.open({ ...config.forgotten, primary: brain.adapter });
      } catch (error) {
        // A store whose ledger does not open is not served, and the refused open leaves no handle behind.
        await brain.close();
        throw error;
      }
    }

    return new Memory(brain, merged, forgotten);
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
   * A trace of the `'conversation'` scope is filed under a key `conversationScopeKey` built, and the scope's row
   * of `memory_scopes` is written with its first trace: in one transaction where the adapter has them, and before
   * the trace where it has none, so no conversation trace is stored under a scope the registry does not name.
   *
   * @param content - The text content to remember.
   * @param options - Optional metadata (type, scope, tags, importance, etc.).
   * @returns The created MemoryTrace-like object.
   * @throws TypeError when `options.scope` is `'conversation'` and `options.scopeId` is not a key
   *   `conversationScopeKey` built; nothing is stored.
   */
  async remember(content: string, options?: RememberOptions): Promise<MemoryTrace> {
    const type = options?.type ?? 'episodic';
    const scope = options?.scope ?? 'user';
    const scopeId = options?.scopeId ?? '';
    const conversation = scope === CONVERSATION_SCOPE;
    if (conversation && !parseConversationScopeKey(scopeId)) {
      throw new TypeError(
        "Memory.remember: a trace of the 'conversation' scope needs a scope id conversationScopeKey() built",
      );
    }
    await this._initPromise;

    const contentHash = await sha256(content);
    const declaredUser = options?.metadata?.turnUserId;
    const turnUserId = typeof declaredUser === 'string' ? declaredUser : '';
    // A chunk of a wiki page is its page's: a message of the same text is a trace of its own, so the page's next
    // rewrite, which deletes its chunks, takes nothing a person said.
    const asChunk = (options?.tags ?? []).includes('wiki');
    const existing = await this._findExistingTraceByHash(contentHash, type, scope, scopeId, turnUserId, asChunk);
    if (existing) {
      // The text is stored already; its scope's registry row is written when it is missing.
      if (conversation) await ensureScopeRow(this._brain, this._brain.brainId, scopeId, Date.now());
      return this._buildTrace(existing);
    }

    const id = typeof options?.id === 'string' && options.id !== '' ? options.id : nextTraceId();
    // A conversation trace is stamped after the last compile read of this facade, and counted as not yet stored until
    // its row is in: a compile reads below it meanwhile, so no watermark moves past a trace a compile has not read.
    const fence = conversation ? coordinationOf(this._brain.coordinationToken) : undefined;
    const now = fence ? Math.max(Date.now(), fence.compileReadAt + 1) : Date.now();
    if (fence && now > fence.lastConversationStamp) fence.lastConversationStamp = now;
    const tags = options?.tags ?? [];
    const entities = options?.entities ?? [];
    const importance = options?.importance ?? 1.0;
    // The caller's keys go under the facade's own, which win.
    const metadata = JSON.stringify(
      buildInitialTraceMetadata({ ...(options?.metadata ?? {}) }, { contentHash, entities, scopeId }),
    );

    const unstored = conversation ? this._holdUnstored(now) : undefined;
    let newRow: NewTraceRow;
    try {
      // Generate embedding if embed function is available.
      const embeddingBlob = await this._embeddingBlobOf(content);

      // Insert into memory_traces: a conversation trace with its scope's registry row.
      newRow = {
        id,
        type,
        scope,
        scopeId,
        content,
        embedding: embeddingBlob,
        strength: importance,
        createdAt: now,
        tags: JSON.stringify(tags),
        metadata,
      };
      if (!conversation) {
        await this._insertTraceRow(this._brain, newRow);
      } else if (this._brain.adapter.capabilities?.has?.('transactions')) {
        const brainId = this._brain.brainId;
        const row = newRow;
        await this._brain.transaction(async (trx) => {
          await ensureScopeRow(trx, brainId, scopeId, now);
          await this._insertTraceRow(trx, row);
        });
      } else {
        // No transaction to hold the two: the registry row first, so a failure between them leaves a row with no
        // trace and never a trace with no row.
        await ensureScopeRow(this._brain, this._brain.brainId, scopeId, now);
        await this._insertTraceRow(this._brain, newRow);
      }
    } finally {
      unstored?.();
    }
    // A delete of the scope that read its traces before this one was stored, and removed the registry row meanwhile,
    // left the trace with no row: the row is written again, which a row already there leaves as it is.
    if (conversation) await ensureScopeRow(this._brain, this._brain.brainId, scopeId, now);

    // The full-text entry, the memory-graph node and the vector index entry.
    await this._afterTraceInsert(newRow);

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
      metadata,
      deleted: 0,
    });
  }

  /**
   * Search for memory traces matching a natural-language query.
   *
   * Uses FTS5 full-text search with the Porter tokenizer, ranked by
   * `strength * abs(fts_rank)`. With the HNSW index active and an embedder,
   * the vector index's candidates and the full-text ones are fused by
   * reciprocal rank. The filters bind both halves: a trace of another type,
   * scope or scope id, weaker than `minStrength` or outside `after` and
   * `before` is never returned, however near its vector.
   *
   * @param query   - Natural-language search query.
   * @param options - Optional filters (limit, type, scope, scopeId, minStrength, after, before).
   * @returns Ranked array of {@link ScoredTrace} results.
   * A call with no scope and no scope id reads the whole brain, every subject's conversation traces among them: the
   * host's own read of its store. No turn, tool or prompt of a souled agent makes one; pass the scope and a key to read
   * one subject.
   *
   * @throws TypeError when `options.scope` is `'conversation'` and no `scopeId` is given: the conversation scope
   *   holds each subject's memory under a key of its own and is read one key at a time, never as a whole.
   */
  async recall(query: string, options?: RecallOptions): Promise<ScoredTrace[]> {
    assertConversationKeyGiven('recall', options?.scope, options?.scopeId);
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

    // Build WHERE clause fragments: this brain's live traces, then the
    // optional filters. A database can hold several brains and its full-text
    // index spans all of them, so every recall query reads this brain only.
    const conditions: string[] = ['t.brain_id = ?', 't.deleted = 0'];
    const params: unknown[] = [this._brain.brainId];

    if (options?.type) {
      conditions.push('t.type = ?');
      params.push(options.type);
    }
    if (options?.scope) {
      conditions.push('t.scope = ?');
      params.push(options.scope);
    }
    if (options?.scopeId) {
      // Equality on the trace's `scope_id` column, which its index serves; never a pattern or a prefix.
      conditions.push('t.scope_id = ?');
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

    const filters = conditions.join(' AND ');

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
        // Get FTS candidates. Every placeholder is `?`: the adapter sends a
        // statement that holds a `$n` as written, so a rank left on its
        // default `$1` would leave the other `?` unbound on Postgres. There
        // the rank reads the query text through its own `?`; on SQLite it
        // reads the match and binds nothing. The index keeps its own name in
        // the join: FTS4's rank, offsets(memory_traces_fts), takes the
        // table's hidden column, which carries the table's name and no alias.
        const { fts: ftsHelper } = this._brain.features;
        const rankA = ftsHelper.rankExpression('memory_traces_fts', '?');
        const rankBindingsA = bindingsFor(rankA, ftsQuery);
        const ftsSql = `
          SELECT t.*, ${rankA} as rank
          FROM ${ftsHelper.joinClause('memory_traces', 't', 'memory_traces_fts', 'memory_traces_fts')}
          WHERE ${ftsHelper.matchClause('memory_traces_fts', '?')}
          AND ${filters}
          ORDER BY abs(${rankA}) DESC
          LIMIT ?
        `;
        let ftsRows: FtsJoinRow[] = [];
        try {
          ftsRows = await this._brain.all<FtsJoinRow>(
            ftsSql,
            [...rankBindingsA, ftsQuery, ...params, ...rankBindingsA, candidateLimit],
          );
        } catch (error) {
          if (!isFtsUnavailableError(error)) {
            throw error;
          }
        }

        // The vector index holds every trace of this brain, whatever its type,
        // scope, scope id, strength or age, so the candidates of both halves
        // pass the recall's filters, this brain's id first, before they rank.
        const candidateIds = [...new Set([...hnswCandidates.map(c => c.id), ...ftsRows.map(r => r.id)])];
        const candidateRows = await this._brain.all<FtsJoinRow>(
          `SELECT t.*, 0.0 as rank FROM memory_traces t
           WHERE ${filters} AND t.id IN (${candidateIds.map(() => '?').join(',')})`,
          [...params, ...candidateIds],
        );
        const rowById = new Map(candidateRows.map(r => [r.id, r]));

        // Each half's ranks count the candidates that passed.
        const hnswRank = new Map(hnswCandidates.filter(c => rowById.has(c.id)).map((c, i) => [c.id, i + 1]));
        const ftsRank = new Map(ftsRows.filter(r => rowById.has(r.id)).map((r, i) => [r.id, i + 1]));
        const rrfK = 60; // Standard RRF constant.

        // Compute RRF score for each candidate that passed.
        const scored: { id: string; rrfScore: number }[] = [];
        for (const id of candidateIds) {
          if (!rowById.has(id)) continue;
          const denseRank = hnswRank.get(id) ?? 10000;
          const lexRank = ftsRank.get(id) ?? 10000;
          const rrfScore = 1 / (rrfK + denseRank) + 1 / (rrfK + lexRank);
          scored.push({ id, rrfScore });
        }

        // Sort by RRF score descending, take top limit.
        scored.sort((a, b) => b.rrfScore - a.rrfScore);
        const top = scored.slice(0, candidateLimit);

        // With no candidate left, the full-text path below answers.
        if (top.length > 0) {
          const topRows = top
            .map(s => rowById.get(s.id))
            .filter((row): row is FtsJoinRow => row !== undefined);
          const updatedRows = await this._applyRecallAccessUpdates(topRows);
          const rrfMap = new Map(top.map(s => [s.id, s.rrfScore]));

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
    // strength * abs(fts_rank). Works without any embeddings. The rank binds
    // the query text as in path A: through its own `?` on Postgres, not at
    // all on SQLite; and the index keeps its own name in the join, as there.
    const { fts: ftsB } = this._brain.features;
    const rankB = ftsB.rankExpression('memory_traces_fts', '?');
    const rankBindingsB = bindingsFor(rankB, ftsQuery);
    const sql = `
      SELECT t.*, ${rankB} as rank
      FROM ${ftsB.joinClause('memory_traces', 't', 'memory_traces_fts', 'memory_traces_fts')}
      WHERE ${ftsB.matchClause('memory_traces_fts', '?')}
      AND ${filters}
      ORDER BY (t.strength * abs(${rankB})) DESC
      LIMIT ?
    `;

    let rows: FtsJoinRow[];
    try {
      rows = await this._brain.all<FtsJoinRow>(
        sql,
        [...rankBindingsB, ftsQuery, ...params, ...rankBindingsB, candidateLimit],
      );
    } catch (error) {
      if (!isFtsUnavailableError(error)) {
        throw error;
      }
      rows = await this._recallWithoutFts(query, filters, params, candidateLimit);
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
   * excluded from all recall queries and health reports. Its knowledge-graph
   * copy goes ({@link deleteGraphCopies}), so its words do not stay in the
   * graph.
   *
   * @param traceId - The ID of the trace to forget.
   */
  async forget(traceId: string): Promise<void> {
    await this._initPromise;

    await this._brain.run(
      'UPDATE memory_traces SET deleted = 1 WHERE brain_id = ? AND id = ?',
      [this._brain.brainId, traceId],
    );
    await this.deleteGraphCopies([traceId]);
  }

  /**
   * Deletes the knowledge-graph copies of the given traces and leaves the traces: the episodic record a memory
   * manager on this facade's Brain writes of each trace it stores (`SqlKnowledgeGraph.recordMemory`). A soft delete
   * calls it ({@link forget}, and the memory tools' `memory_delete` and `memory_merge`), so a deleted trace's words do
   * not stay in the graph; a trace a revert brings back needs no copy, since no recall reads one. Best-effort: a graph
   * that cannot be reached leaves its copies, which a later delete by trace id or by scope finds.
   *
   * @returns How many copies it deleted.
   */
  async deleteGraphCopies(traceIds: readonly string[]): Promise<number> {
    await this._initPromise;
    const ids = [...new Set(traceIds)];
    if (ids.length === 0) return 0;
    try {
      return await this._knowledgeGraph.deleteMemories({ traceIds: ids });
    } catch {
      return 0;
    }
  }

  /** The id of the brain this facade reads and writes; a ledger row names it for the writes it records. */
  get brainId(): string {
    return this._brain.brainId;
  }

  /**
   * Deletes every trace of one scope for good: the rows, their memory-graph nodes and knowledge-graph copies, and
   * the full-text index entries. With `turnUserId`, only the scope's traces whose metadata names that user, as the
   * second user a memory write on another user's session records, or among the contributors of a summary the
   * rolling-summary sink filed. Account deletion calls it. A whole `'conversation'` scope loses its row of
   * `memory_scopes` with its traces; a delete of one user's traces in it (`turnUserId`) keeps the row, and so does a
   * scope that still holds a wiki page (`memory_pages`): this call deletes no page row, and the registry goes on
   * naming the scope until its pages are deleted and the call is made again. A document chunk one of the scope's
   * traces was filed from lets go of it and keeps its text: to delete those chunks too, delete the scope's traces
   * first with {@link deleteTraces} and `documentChunks: 'delete'` ({@link tracesStoredBefore} lists them).
   *
   * It reads the rows by their `scope_id` column, after filing the brain's rows that hold `''` there while their
   * metadata names a scope id: a release older than the column writes those, to a Brain this facade holds open too.
   *
   * @throws TypeError when `scopeId` is empty, so a caller's missing id never deletes every trace filed under no scope
   *   id, or when `turnUserId` is given and is not a non-empty string.
   * @throws When the knowledge graph cannot delete the copies: of the traces, before any row is deleted; of the scope,
   *   once the traces are deleted, so a second call finds the copies alone.
   */
  async deleteScope(scope: string, scopeId: string, options: { turnUserId?: string } = {}): Promise<{ deleted: number }> {
    if (typeof scopeId !== 'string' || scopeId === '') {
      throw new TypeError('Memory.deleteScope: scopeId must be a non-empty string');
    }
    const only = options.turnUserId;
    if (only !== undefined && (typeof only !== 'string' || only === '')) {
      throw new TypeError('Memory.deleteScope: turnUserId must be a non-empty string');
    }
    await this._initPromise;
    // A conversation scope is deleted after a compile of it that is running, and a compile that comes after waits for
    // the delete: no page is written from traces the delete took.
    if (scope === CONVERSATION_SCOPE) return this._oneScopeChangeAtATime(scopeId, () => this._deleteScope(scope, scopeId, only));
    return this._deleteScope(scope, scopeId, only);
  }

  /** {@link deleteScope}, its arguments checked. */
  private async _deleteScope(scope: string, scopeId: string, only: string | undefined): Promise<{ deleted: number }> {
    await fillScopeIds(this._brain.adapter, this._brain.brainId);
    const rows = await this._brain.all<{ id: string; metadata: string | null }>(
      'SELECT id, metadata FROM memory_traces WHERE brain_id = ? AND scope = ? AND scope_id = ?',
      [this._brain.brainId, scope, scopeId],
    );
    const ids = rows
      .filter((row) => only === undefined || traceNamesUser(row.metadata, only))
      .map((row) => row.id);
    const result = await this.deleteTraces(ids);
    // The per-trace deletes above took each trace's own copy. A copy filed under the scope whose trace is gone holds
    // the trace's words with no row to find them by: a graph that cannot delete it fails the call.
    if (only === undefined) await this._knowledgeGraph.deleteMemories({ scopes: [{ scope, scopeId }] });
    // The scope's registry row goes last, so a call that failed above is made again and finds it. A scope that still
    // holds a wiki page keeps its row, so whoever walks the registry still finds the page; the row goes with the call
    // made once the pages are deleted. A trace stored under the scope after the rows above were read keeps the row too.
    if (only === undefined && scope === CONVERSATION_SCOPE) {
      await this._brain.run(
        `DELETE FROM memory_scopes
          WHERE brain_id = ? AND scope = ? AND scope_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM memory_pages p
               WHERE p.brain_id = memory_scopes.brain_id AND p.scope = memory_scopes.scope AND p.scope_id = memory_scopes.scope_id)
            AND NOT EXISTS (
              SELECT 1 FROM memory_traces t
               WHERE t.brain_id = memory_scopes.brain_id AND t.scope = memory_scopes.scope AND t.scope_id = memory_scopes.scope_id)`,
        [this._brain.brainId, scope, scopeId],
      );
    }
    return result;
  }

  /**
   * Deletes the given traces for good, as {@link deleteScope} does for a scope. The rows that name a trace go first,
   * as the Brain's foreign keys require: its `retrieval_feedback` rows are deleted, and a `document_chunks` row it was
   * filed from lets go of it and keeps its text. Each trace's memory-graph node goes with its edges, whichever facade
   * on the Brain wrote them, a relation a host made to the node ({@link addRelation}) included. Each trace's
   * knowledge-graph copy goes before its row. Unknown ids are skipped.
   *
   * With `documentChunks: 'delete'` the document chunks the traces were filed from are deleted with their text, the
   * pictures of those chunks, and each document left with no chunk: a person's deletion and the retention sweep pass
   * it. On an adapter with transactions those deletes share one, so a failure among them deletes none and a later call
   * finds them again.
   *
   * A delete only marks a trace's vector in the vector index, which keeps the numbers in its files until it is
   * written again: {@link rebuildVectorIndex} writes it from the traces that are left.
   *
   * @returns How many trace rows it deleted, so a call made again counts none.
   * @throws When the knowledge graph cannot delete the copies: no row is deleted, so a later call deletes them.
   */
  async deleteTraces(
    traceIds: readonly string[],
    options: { documentChunks?: 'delete' } = {},
  ): Promise<{ deleted: number }> {
    await this._initPromise;
    const ids = [...new Set(traceIds)];
    if (ids.length === 0) return { deleted: 0 };
    // A trace's knowledge-graph copy holds its full text, and once the row is gone nothing finds the copy again: the
    // copies go first, and a failure fails the call with every row kept, so a later call deletes them.
    await this._knowledgeGraph.deleteMemories({ traceIds: ids });
    // The chunks go while their rows still name the traces: once a trace is gone its chunk names nothing.
    if (options.documentChunks === 'delete') await this._deleteDocumentChunksOf(ids);
    const deleted = await deleteTraceRows(this._brain, this._brain.brainId, ids);
    if (deleted > 0) this._erasureOwed.deletes += 1;
    for (const id of ids) {
      try {
        await this._memoryGraph.removeNode(id);
      } catch {
        // A node whose delete fails stays, holding no words of the trace; its trace is gone.
      }
    }
    // After a rewrite already running, so the index it writes does not keep the vectors as live.
    const sidecar = this._hnswSidecar;
    if (sidecar) {
      await this._onVectorIndex(async () => {
        for (const id of ids) sidecar.remove(id);
        // After a rewrite already running: that rewrite may have written these vectors, so the next one is owed.
        if (deleted > 0) this._erasureOwed.vectorIndex = true;
      });
    }
    // Postgres keeps the index in each row's own column, which went with the row.
    if (this._brain.features.dialect.name !== 'postgres') await this._rebuildFtsIndex();
    return { deleted };
  }

  /**
   * The ids of one scope's traces stored before a time, live or soft-deleted, a wiki page's chunks left out: a chunk
   * follows its page, never its own age. A person's deletion lists every trace of theirs with it (a bound past any
   * time a trace was stored), and a retention sweep the traces that expired. Like {@link deleteScope}, it first files
   * the brain's rows that hold `''` as their scope id while their metadata names one.
   *
   * @param beforeMs - Exclusive upper bound on the time a trace was stored (Unix ms).
   * @throws TypeError when `scopeId` is empty.
   */
  async tracesStoredBefore(scope: string, scopeId: string, beforeMs: number): Promise<string[]> {
    if (typeof scopeId !== 'string' || scopeId === '') {
      throw new TypeError('Memory.tracesStoredBefore: scopeId must be a non-empty string');
    }
    await this._initPromise;
    await fillScopeIds(this._brain.adapter, this._brain.brainId);
    const rows = await this._brain.all<{ id: string; tags: string }>(
      'SELECT id, tags FROM memory_traces WHERE brain_id = ? AND scope = ? AND scope_id = ? AND created_at < ?',
      [this._brain.brainId, scope, scopeId, beforeMs],
    );
    return rows.filter((row) => !isPageChunkTags(row.tags)).map((row) => row.id);
  }

  /**
   * Which of the given ids are live traces of one scope, a wiki page's chunks left out: a chunk is not a statement a
   * person made. A correction checks with it that every trace it names is the person's own before it changes anything.
   * The scope id is matched by equality, 400 ids a statement.
   *
   * @returns The ids found, each once, in no set order.
   * @throws TypeError when `scopeId` is empty.
   */
  async liveTraceIdsOf(scope: string, scopeId: string, traceIds: readonly string[]): Promise<string[]> {
    if (typeof scopeId !== 'string' || scopeId === '') {
      throw new TypeError('Memory.liveTraceIdsOf: scopeId must be a non-empty string');
    }
    await this._initPromise;
    const ids = [...new Set(traceIds)];
    const found: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 400) {
      const slice = ids.slice(offset, offset + 400);
      const rows = await this._brain.all<{ id: string; tags: string }>(
        `SELECT id, tags FROM memory_traces
          WHERE brain_id = ? AND scope = ? AND scope_id = ? AND deleted = 0 AND id IN (${slice.map(() => '?').join(', ')})`,
        [this._brain.brainId, scope, scopeId, ...slice],
      );
      for (const row of rows) if (!isPageChunkTags(row.tags)) found.push(row.id);
    }
    return found;
  }

  /**
   * Deletes the document chunks the given traces were filed from, with their text: first the pictures of those
   * chunks, as the foreign key of `document_images` on `document_chunks` requires, then the chunks, 400 ids a
   * statement. A document left with no chunk is deleted with the pictures filed under it; a document that still has
   * a chunk stays. On an adapter with transactions every delete shares one: a step that fails rolls back the ones
   * before it, so a later call finds the chunks by their traces again, and the document by its chunks.
   */
  private async _deleteDocumentChunksOf(traceIds: readonly string[]): Promise<void> {
    const brainId = this._brain.brainId;
    const deletes = async (trx: Pick<StorageAdapter, 'all' | 'get' | 'run'>): Promise<void> => {
      const documentIds = new Set<string>();
      const chunkIds: string[] = [];
      for (let offset = 0; offset < traceIds.length; offset += 400) {
        const slice = traceIds.slice(offset, offset + 400);
        const chunks = await trx.all<{ id: string; document_id: string }>(
          `SELECT id, document_id FROM document_chunks WHERE brain_id = ? AND trace_id IN (${slice.map(() => '?').join(', ')})`,
          [brainId, ...slice],
        );
        for (const chunk of chunks) {
          chunkIds.push(chunk.id);
          documentIds.add(chunk.document_id);
        }
      }
      for (let offset = 0; offset < chunkIds.length; offset += 400) {
        const slice = chunkIds.slice(offset, offset + 400);
        const placeholders = slice.map(() => '?').join(', ');
        const params = [brainId, ...slice];
        await trx.run(`DELETE FROM document_images WHERE brain_id = ? AND chunk_id IN (${placeholders})`, params);
        await trx.run(`DELETE FROM document_chunks WHERE brain_id = ? AND id IN (${placeholders})`, params);
      }
      for (const documentId of documentIds) {
        const left = await trx.get<{ n: number | string }>(
          'SELECT count(*) AS n FROM document_chunks WHERE brain_id = ? AND document_id = ?',
          [brainId, documentId],
        );
        if (Number(left?.n ?? 0) > 0) continue;
        await trx.run('DELETE FROM document_images WHERE brain_id = ? AND document_id = ?', [brainId, documentId]);
        await trx.run('DELETE FROM documents WHERE brain_id = ? AND id = ?', [brainId, documentId]);
      }
    };
    if (this._brain.adapter.capabilities?.has?.('transactions') === true) await this._brain.transaction(deletes);
    else await deletes(this._brain);
  }

  /**
   * Deletes for good every trace whose metadata names the user as `turnUserId`, under any scope and under none, live
   * or soft-deleted, with the document chunks those traces were filed from ({@link deleteTraces} with
   * `documentChunks: 'delete'`). A person's deletion calls it for what they said on someone else's session.
   *
   * @returns How many trace rows it deleted.
   * @throws TypeError when `userId` is not a non-empty string.
   */
  async deleteTracesNamingUser(userId: string): Promise<{ deleted: number }> {
    if (typeof userId !== 'string' || userId === '') {
      throw new TypeError('Memory.deleteTracesNamingUser: userId must be a non-empty string');
    }
    await this._initPromise;
    const rows = await this._brain.all<{ id: string }>(
      `SELECT id FROM memory_traces WHERE brain_id = ? AND CAST(${this._brain.features.dialect.jsonExtract('metadata', '$.turnUserId')} AS TEXT) = ?`,
      [this._brain.brainId, userId],
    );
    return this.deleteTraces(
      rows.map((row) => row.id),
      { documentChunks: 'delete' },
    );
  }

  /**
   * Writes the vector index again from the live traces that are left, or removes its files when none is left. A
   * delete only marks a vector in the index, so the numbers of a deleted trace stay in the index files until this
   * runs: call it after deleting for good.
   *
   * It runs after the vector index's other work and reads the traces inside its own step: a trace deleted while an
   * earlier rewrite runs is not written back by this one, and a trace remembered while it runs is indexed after it.
   *
   * @returns How many vectors the index holds afterwards: 0 for a store with no file path, and where `hnswlib-node`
   *   is not installed (no index file is written there).
   * @throws When an index file cannot be removed, or when the rebuilt index did not save.
   */
  async rebuildVectorIndex(): Promise<{ vectors: number }> {
    await this._initPromise;
    const sidecar = this._hnswSidecar;
    if (!sidecar) return { vectors: 0 };
    return this._onVectorIndex(async () => {
      const written = await sidecar.rewrite(await this._ownEmbeddedTraces());
      this._erasureOwed.vectorIndex = false;
      return written;
    });
  }

  /**
   * Moves the store's write-ahead log into its file and empties the log. A row deleted for good is overwritten in the
   * page the delete wrote, and the log still holds the pages written before it until a checkpoint: a person's deletion
   * calls this once its deletes are done, so neither file holds the deleted text.
   *
   * @returns `'emptied'` when the log holds nothing more; `'busy'` when a reader or a writer of another connection held
   *   it, and the deleted bytes stay in it until a later checkpoint; `'none'` for a database that keeps no such log
   *   (PostgreSQL).
   */
  async checkpointLog(): Promise<{ log: 'emptied' | 'busy' | 'none' }> {
    await this._initPromise;
    // The deletes made before the checkpoint starts are the ones it can empty from the log.
    const before = this._erasureOwed.deletes;
    const checkpoint = this._brain.features.dialect.pragma('wal_checkpoint', 'TRUNCATE');
    if (!checkpoint) {
      this._erasureOwed.checkpointed = Math.max(this._erasureOwed.checkpointed, before);
      return { log: 'none' };
    }
    const row = await this._brain.get<{ busy?: number | string | null }>(checkpoint);
    const log = Number(row?.busy ?? 0) === 0 ? 'emptied' : 'busy';
    if (log === 'emptied') this._erasureOwed.checkpointed = Math.max(this._erasureOwed.checkpointed, before);
    return { log };
  }

  /**
   * Finishes what deletes for good left in the store's files: the vector index is written again
   * ({@link rebuildVectorIndex}) when a delete, or an open whose check of the index failed, left it naming a trace that
   * is gone; the write-ahead log is emptied ({@link checkpointLog}) when deletes were made after the last checkpoint
   * that emptied it. Nothing owed, nothing runs. A retention sweep, a correction and a re-application of the
   * tombstones call it, so a rewrite or a checkpoint that failed in an earlier call runs again.
   *
   * @returns Whether the index was written again, and what the checkpoint answered; `'not owed'` for a step that had
   *   nothing to do.
   * @throws What the rewrite throws, once the checkpoint was tried as well, or what the checkpoint throws. A step that
   *   fails, and a checkpoint another connection held (`'busy'`), stay owed.
   */
  async finishErasure(): Promise<{ vectorIndex: 'rewritten' | 'not owed'; log: 'emptied' | 'busy' | 'none' | 'not owed' }> {
    await this._initPromise;
    let failure: unknown;
    let vectorIndex: 'rewritten' | 'not owed' = 'not owed';
    if (this._erasureOwed.vectorIndex) {
      try {
        await this.rebuildVectorIndex();
        vectorIndex = 'rewritten';
      } catch (error) {
        failure = error;
      }
    }
    let log: 'emptied' | 'busy' | 'none' | 'not owed' = 'not owed';
    if (this._erasureOwed.deletes > this._erasureOwed.checkpointed) {
      try {
        log = (await this.checkpointLog()).log;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
    return { vectorIndex, log };
  }

  /**
   * Runs one step of the vector index's work once every step asked for before it has settled. A step that throws
   * rejects its own caller and does not stop the steps after it.
   */
  private _onVectorIndex<T>(work: () => Promise<T>): Promise<T> {
    const step = this._vectorIndexWork.then(work);
    this._vectorIndexWork = step.catch(() => undefined);
    return step;
  }

  /**
   * Records a subject as forgotten in this store's ledger: its copy first, then the store.
   *
   * @throws When the store was opened without a ledger (`forgotten` in its config), or when either write fails.
   */
  async markForgotten(subject: SuppressionSubject): Promise<{ form: 'keyed' | 'unkeyed'; written: boolean }> {
    if (!this._forgotten) throw new Error('Memory.markForgotten: this store was opened without a forgotten-user ledger');
    return this._forgotten.markForgotten(subject);
  }

  /**
   * Whether this store's ledger holds a tombstone of the subject, in any form.
   *
   * @throws When the store was opened without a ledger (`forgotten` in its config).
   */
  async isForgotten(subject: SuppressionSubject): Promise<boolean> {
    if (!this._forgotten) throw new Error('Memory.isForgotten: this store was opened without a forgotten-user ledger');
    return this._forgotten.isForgotten(subject);
  }

  /** The ledger the store was opened with; undefined for a store opened without one. */
  get forgotten(): ForgottenLedger | undefined {
    return this._forgotten;
  }

  /**
   * Every subject this store holds anything of, each once: the users and sessions whose conversation key names a
   * registry row, a trace or a wiki page of this brain (a registry row may be gone after a deletion that did not
   * finish), the users a trace's metadata names as `turnUserId`, and, where the store's database holds the learning
   * tables, the users any learner row names (sessions, chain heads, the ledger and its turn users, traits, freezes,
   * outcomes, lessons and skills), so a restore that put back one row of a learner alone leads back to them, and the
   * user memory from before per-user scope is
   * attributed to ({@link legacyOwner}). The operator's key names no subject. The re-application of the tombstones asks
   * the ledger about each.
   */
  async listHeldSubjects(): Promise<SuppressionSubject[]> {
    await this._initPromise;
    const brainId = this._brain.brainId;
    const held = new Map<string, SuppressionSubject>();
    const hold = (subject: SuppressionSubject): void => {
      held.set(`${subject.kind}\u0000${subject.id}`, subject);
    };
    for (const table of ['memory_scopes', 'memory_traces', 'memory_pages']) {
      const rows = await this._brain.all<{ scope_id: string | null }>(
        `SELECT DISTINCT scope_id FROM ${table} WHERE brain_id = ? AND scope = ?`,
        [brainId, CONVERSATION_SCOPE],
      );
      for (const row of rows) {
        const subject = typeof row.scope_id === 'string' ? parseConversationScopeKey(row.scope_id)?.subject : undefined;
        if (subject && subject.kind !== 'operator') hold({ kind: subject.kind, id: subject.id });
      }
    }
    // The owner of older memory: a forgotten owner's attributed memory is deleted again after a restore.
    const owners = await this._brain.all<{ owner_key: string }>('SELECT owner_key FROM memory_legacy_owner WHERE brain_id = ?', [brainId]);
    for (const row of owners) {
      const subject = parseConversationScopeKey(row.owner_key)?.subject;
      if (subject && subject.kind !== 'operator') hold({ kind: subject.kind, id: subject.id });
    }
    const holdUser = (userId: unknown): void => {
      if (typeof userId === 'number') hold({ kind: 'user', id: String(userId) });
      else if (typeof userId === 'string' && userId !== '') hold({ kind: 'user', id: userId });
    };
    const named = await this._brain.all<{ user_id: unknown }>(
      `SELECT DISTINCT ${this._brain.features.dialect.jsonExtract('metadata', '$.turnUserId')} AS user_id FROM memory_traces WHERE brain_id = ?`,
      [brainId],
    );
    for (const row of named) holdUser(row.user_id);
    for (const [table, column] of LEARNER_USER_COLUMNS) {
      try {
        const rows = await this._brain.all<{ user_id: unknown }>(
          `SELECT DISTINCT ${column} AS user_id FROM ${table} WHERE ${column} IS NOT NULL`,
        );
        for (const row of rows) holdUser(row.user_id);
      } catch (error) {
        // A store whose database holds no learning tables has no learner to name.
        if (!isMissingTableError(error)) throw error;
      }
    }
    return [...held.values()];
  }

  /**
   * The conversation key of the user the agent's memory from before per-user scope is attributed to; undefined when
   * it is attributed to nobody. An attribution stands for the store's life, whatever later opens pass.
   */
  async legacyOwner(agentId: string): Promise<string | undefined> {
    await this._initPromise;
    const row = await this._brain.get<{ owner_key: string }>(
      'SELECT owner_key FROM memory_legacy_owner WHERE brain_id = ? AND agent_id = ?',
      [this._brain.brainId, agentId],
    );
    return typeof row?.owner_key === 'string' ? row.owner_key : undefined;
  }

  /**
   * Attributes the agent's memory from before per-user scope to one user, by their conversation key. An attribution
   * already made is never moved: the call then writes nothing.
   */
  async setLegacyOwner(agentId: string, ownerKey: string): Promise<void> {
    if (typeof ownerKey !== 'string' || ownerKey === '') {
      throw new TypeError('Memory.setLegacyOwner: ownerKey must be a non-empty string');
    }
    await this._initPromise;
    await this._brain.run(
      `INSERT INTO memory_legacy_owner (brain_id, agent_id, owner_key, attributed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (brain_id, agent_id) DO NOTHING`,
      [this._brain.brainId, agentId, ownerKey, Date.now()],
    );
  }

  /** Removes the attribution of the agent's older memory: the owner's deletion does, once that memory is gone. */
  async clearLegacyOwner(agentId: string): Promise<void> {
    await this._initPromise;
    await this._brain.run('DELETE FROM memory_legacy_owner WHERE brain_id = ? AND agent_id = ?', [this._brain.brainId, agentId]);
  }

  /**
   * Brings one trace back to the state a snapshot holds (`readTraceSnapshot`): its content, tags, scope and
   * metadata, live again. A ledger revert of a memory tool's update, delete or merge calls it with the before-state
   * its row recorded; a revert of an add calls {@link forget}. The full-text index then matches the restored words:
   * SQLite rebuilds its index, and Postgres re-indexes the restored row alone.
   *
   * A snapshot read before the Brain was re-filed in the encoded scope-id form ({@link ensureEncodedScopeIds}) is
   * written under the encoded id, as the re-file wrote the row: once the Brain holds the record, the plain form of an
   * id that holds a `/` names a namespaced user (`team/ana` is user `ana` of namespace `team`), so the trace stays the
   * plain user's. On Postgres the restore reads the record under the lock a re-file takes, so a re-file another process
   * makes meanwhile comes before or after it.
   *
   * @throws When the snapshot is of another trace.
   */
  async restoreTrace(traceId: string, before: TraceSnapshot): Promise<void> {
    await this._initPromise;
    if (before.id !== traceId) {
      throw new Error(`Memory.restoreTrace: the snapshot of trace ${before.id} cannot restore ${traceId}`);
    }
    const { dialect } = this._brain.features;
    const brainId = this._brain.brainId;
    await this._brain.transaction(async (trx) => {
      let snapshot = before;
      if (before.scopeIdForm === 'plain') {
        if (dialect.name === 'postgres') await takeScopeIdFormLock(trx, brainId);
        if (await holdsEncodedScopeIdForm(trx, brainId)) snapshot = snapshotInEncodedForm(before);
      }
      await writeTraceSnapshot(trx, dialect.insertOrReplace.bind(dialect), brainId, snapshot);
    });
    if (dialect.name === 'postgres') {
      // The index is the row's own `_tsv` column, which the upsert leaves as it was: re-index the restored row alone.
      try {
        const rebuild = this._brain.fullTextRebuild();
        await this._brain.run(`${rebuild.sql} AND id = ?`, [...rebuild.params, traceId]);
      } catch {
        // Best-effort, as every full-text sync of the facade is; an open fills a column left null.
      }
      return;
    }
    await this._rebuildFtsIndex();
  }

  /**
   * Re-files this facade's Brain in the encoded form a learning layer reads, once per Brain
   * (`refileBrainScopeIds`); every live `MemoryStore` on the Brain in this process then moves what it holds of the
   * traces the re-file moved. The layer calls it when it is first handed the facade.
   *
   * @returns How many traces it moved: none when the Brain held the record already.
   */
  async ensureEncodedScopeIds(): Promise<number> {
    await this._initPromise;
    const { moved } = await refileBrainScopeIds(this._brain);
    return moved.reduce((sum, pair) => sum + pair.traces, 0);
  }

  /** One row of this facade's Brain as a snapshot, live or deleted; `undefined` when there is none. */
  async readTrace(traceId: string): Promise<TraceSnapshot | undefined> {
    await this._initPromise;
    return readTraceSnapshot(this._brain, this._brain.brainId, traceId);
  }

  /**
   * How many live traces one scope holds in this facade's Brain; with `includeDeleted`, the soft-deleted ones too,
   * which still hold their words until a delete for good ({@link deleteScope}) removes them.
   */
  async countScope(scope: string, scopeId: string, options: { includeDeleted?: boolean } = {}): Promise<number> {
    await this._initPromise;
    const row = await this._brain.get<{ n: number | string }>(
      `SELECT count(*) AS n FROM memory_traces WHERE brain_id = ? AND scope = ? AND scope_id = ?${options.includeDeleted ? '' : ' AND deleted = 0'}`,
      [this._brain.brainId, scope, scopeId],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * The registered scopes of this facade's Brain, by scope id: each conversation scope gets its row of
   * `memory_scopes` with its first trace ({@link remember}), and loses it when the scope is deleted
   * ({@link deleteScope}).
   *
   * @param filter.scope - The scope to list. Defaults to `'conversation'`, the one scope that is registered.
   * @param filter.kind - Only the scopes of one kind of subject: `'user'`, `'session'` or `'operator'`.
   * @returns Each scope's id, the kind and agent id its key holds, when it was first written (Unix ms) and when it
   *   was last compiled into wiki pages (Unix ms; null before its first compile).
   */
  async listScopes(filter?: { scope?: string; kind?: string }): Promise<MemoryScopeRow[]> {
    await this._initPromise;
    const conditions = ['brain_id = ?', 'scope = ?'];
    const params: unknown[] = [this._brain.brainId, filter?.scope ?? CONVERSATION_SCOPE];
    if (filter?.kind) {
      conditions.push('kind = ?');
      params.push(filter.kind);
    }
    const rows = await this._brain.all<{
      scope_id: string;
      kind: string;
      agent_id: string;
      created_at: number | string;
      compiled_at: number | string | null;
    }>(
      `SELECT scope_id, kind, agent_id, created_at, compiled_at
         FROM memory_scopes
        WHERE ${conditions.join(' AND ')}
        ORDER BY scope_id`,
      params,
    );
    // A BIGINT column can come back as text (Postgres): every number is read through Number().
    return rows.map((row) => ({
      scopeId: row.scope_id,
      kind: row.kind,
      agentId: row.agent_id,
      createdAt: Number(row.created_at),
      compiledAt: row.compiled_at === null || row.compiled_at === undefined ? null : Number(row.compiled_at),
    }));
  }

  /**
   * One wiki page row of one conversation scope; null when the scope holds no page of that id.
   *
   * @param scopeId - The scope's key, matched by equality.
   * @throws InvalidWikiPageIdError for a refused page id; nothing is read.
   */
  async readPageRow(scopeId: string, pageId: string): Promise<MemoryPageRow | null> {
    assertWikiPageId(pageId);
    await this._initPromise;
    const row = await this._brain.get<PageRowRecord>(
      `SELECT page_id, content, content_hash, chunk_ids, updated_at
         FROM memory_pages
        WHERE brain_id = ? AND scope = ? AND scope_id = ? AND page_id = ?`,
      [this._brain.brainId, CONVERSATION_SCOPE, scopeId, pageId],
    );
    return row ? pageRowOf(row) : null;
  }

  /** Every wiki page row of one conversation scope, by page id. The scope's key is matched by equality. */
  async listPageRows(scopeId: string): Promise<MemoryPageRow[]> {
    await this._initPromise;
    const rows = await this._brain.all<PageRowRecord>(
      `SELECT page_id, content, content_hash, chunk_ids, updated_at
         FROM memory_pages
        WHERE brain_id = ? AND scope = ? AND scope_id = ?`,
      [this._brain.brainId, CONVERSATION_SCOPE, scopeId],
    );
    // Ordered here, by code unit, so every database lists one order whatever its collation.
    return rows.map(pageRowOf).sort((a, b) => (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0));
  }

  /**
   * Writes one wiki page row of a user's or a session's conversation scope, with its chunks. With `chunks`, the
   * page's old chunks are deleted for good, the new ones are filed as traces under the scope's key with the tags
   * `wiki` and `page:<id>`, and the row lists them; without, the row's content is replaced and its chunks are kept.
   * With `chunks` and `keepChunksIfUnchanged`, the stored row is compared once the scope's earlier page writes have
   * settled: a row whose `contentHash` is the one given keeps its chunks, and any other row gets the new ones.
   * The scope's registry row, the new chunks, the page row and the delete of the old chunks are one transaction
   * where the adapter has them; where it has none they run in that order, so the row never lists a chunk that is
   * not stored. The row is replaced only while it holds the text and the chunks the write read: a writer in another
   * process that changed it meanwhile makes the write read it again and start over, so no chunk that writer filed is
   * left unlisted.
   *
   * @returns The ids of the chunks the row lists.
   * @throws TypeError when `scopeId` is not the conversation key of a user or of a session.
   * @throws InvalidWikiPageIdError for a refused page id.
   * @throws When the knowledge graph cannot delete the old chunks' copies: nothing is changed.
   * @throws Error when other writers changed the row under each of the write's attempts.
   */
  async writePageRow(
    scopeId: string,
    page: {
      pageId: string;
      content: string;
      contentHash: string;
      chunks?: ReadonlyArray<MemoryPageChunk>;
      keepChunksIfUnchanged?: boolean;
    },
  ): Promise<{ chunkIds: string[] }> {
    assertPageOwnerKey(scopeId);
    assertWikiPageId(page.pageId);
    await this._initPromise;
    return this._onePageWriteAtATime(scopeId, () => this._writePageRow(scopeId, page));
  }

  /**
   * Files a page's chunks again from the text its row holds when the write runs, and keeps that text: a page another
   * write changed after a caller listed it is chunked as it is now, and never written back as it was listed. The old
   * chunks are deleted for good, as {@link writePageRow} deletes them.
   *
   * @param chunksOf - The chunks of a row's stored text; null when the text does not parse, which writes nothing.
   * @returns The ids of the chunks the row lists and of the chunks it listed before; null when the scope holds no page
   *   of that id or `chunksOf` answered null.
   * @throws TypeError when `scopeId` is not the conversation key of a user or of a session.
   * @throws InvalidWikiPageIdError for a refused page id.
   */
  async reindexPageRow(
    scopeId: string,
    pageId: string,
    chunksOf: (content: string) => ReadonlyArray<MemoryPageChunk> | null,
  ): Promise<{ chunkIds: string[]; removed: string[] } | null> {
    assertPageOwnerKey(scopeId);
    assertWikiPageId(pageId);
    await this._initPromise;
    return this._onePageWriteAtATime(scopeId, async () => {
      for (let attempt = 1; ; attempt += 1) {
        const prior = await this._readPageRecord(scopeId, pageId);
        if (!prior) return null;
        const chunks = chunksOf(prior.content);
        if (!chunks) return null;
        const written = await this._replacePageRow(
          scopeId,
          { pageId, content: prior.content, contentHash: prior.content_hash, chunks },
          prior,
        );
        if (written) return { chunkIds: written.chunkIds, removed: pageRowOf(prior).chunkIds };
        if (attempt >= PAGE_WRITE_ATTEMPTS) throw pageChangedUnderEveryAttempt();
      }
    });
  }

  /**
   * Runs `work` once every earlier page write or page delete of the same scope on this facade has settled, so two
   * writes of one page made at once are made one after the other: the second reads the chunks the first wrote, and
   * deletes them. Writers in other processes are not ordered by it; a write's compare with the row it read is.
   */
  private _onePageWriteAtATime<T>(scopeId: string, work: () => Promise<T>): Promise<T> {
    return oneAtATime(coordinationOf(this._brain.coordinationToken).pageWrites, scopeId, work);
  }

  /**
   * Runs `work` once every earlier compile, scope delete and page delete of the same scope on the facades of this store
   * in this process has settled: a compile's page is never written from traces a delete took while it ran, and a delete
   * made while a compile runs finds the page that compile writes. Writers in other processes are not ordered by it.
   */
  private _oneScopeChangeAtATime<T>(scopeId: string, work: () => Promise<T>): Promise<T> {
    return oneAtATime(coordinationOf(this._brain.coordinationToken).scopeChanges, scopeId, work);
  }

  /** One page row as the database holds it, its chunk list as stored text; null when the scope holds no such page. */
  private async _readPageRecord(scopeId: string, pageId: string): Promise<PageRowRecord | null> {
    const row = await this._brain.get<PageRowRecord>(
      `SELECT page_id, content, content_hash, chunk_ids, updated_at
         FROM memory_pages
        WHERE brain_id = ? AND scope = ? AND scope_id = ? AND page_id = ?`,
      [this._brain.brainId, CONVERSATION_SCOPE, scopeId, pageId],
    );
    return row ?? null;
  }

  /** {@link writePageRow}, once the scope's earlier page writes have settled: read, write, and read again on a change. */
  private async _writePageRow(
    scopeId: string,
    page: {
      pageId: string;
      content: string;
      contentHash: string;
      chunks?: ReadonlyArray<MemoryPageChunk>;
      keepChunksIfUnchanged?: boolean;
    },
  ): Promise<{ chunkIds: string[] }> {
    for (let attempt = 1; ; attempt += 1) {
      const prior = await this._readPageRecord(scopeId, page.pageId);
      const written = await this._replacePageRow(scopeId, page, prior);
      if (written) return written;
      if (attempt >= PAGE_WRITE_ATTEMPTS) throw pageChangedUnderEveryAttempt();
    }
  }

  /**
   * One attempt of a page write over the row `prior` as it was read (null: no row). The row is written only while
   * it still holds that text and that chunk list; when another writer changed it, nothing of this write is kept and
   * the answer is null.
   */
  private async _replacePageRow(
    scopeId: string,
    page: {
      pageId: string;
      content: string;
      contentHash: string;
      chunks?: ReadonlyArray<MemoryPageChunk>;
      keepChunksIfUnchanged?: boolean;
    },
    prior: PageRowRecord | null,
  ): Promise<{ chunkIds: string[] } | null> {
    const brainId = this._brain.brainId;
    const now = Date.now();
    const old = prior ? pageRowOf(prior).chunkIds : [];
    const transactions = this._brain.adapter.capabilities?.has?.('transactions') === true;
    /** Writes the row over `prior`; throws {@link PageRowChangedError} when the row is no longer the one read. */
    const replace = async (db: Pick<StorageAdapter, 'run'>, chunkIds: readonly string[]): Promise<void> => {
      const listed = JSON.stringify(chunkIds);
      const result = prior
        ? await db.run(REPLACE_READ_PAGE_ROW, [
            page.content,
            page.contentHash,
            listed,
            now,
            brainId,
            CONVERSATION_SCOPE,
            scopeId,
            page.pageId,
            prior.content,
            prior.chunk_ids,
          ])
        : await db.run(INSERT_NEW_PAGE_ROW, [
            brainId,
            CONVERSATION_SCOPE,
            scopeId,
            page.pageId,
            page.content,
            page.contentHash,
            listed,
            now,
          ]);
      if (result.changes !== 1) throw new PageRowChangedError();
    };

    // Read after the scope's earlier writes settled: a body the row holds now keeps the chunks the row lists.
    const unchanged = page.keepChunksIfUnchanged === true && prior !== null && prior.content_hash === page.contentHash;
    if (page.chunks === undefined || unchanged) {
      const keep = async (db: Pick<StorageAdapter, 'run'>): Promise<void> => {
        await ensureScopeRow(db, brainId, scopeId, now);
        await replace(db, old);
      };
      try {
        if (transactions) await this._brain.transaction(keep);
        else await keep(this._brain);
      } catch (error) {
        if (error instanceof PageRowChangedError) return null;
        throw error;
      }
      return { chunkIds: old };
    }

    const tags = JSON.stringify(['wiki', `page:${page.pageId}`]);
    const rows: NewTraceRow[] = [];
    for (const chunk of page.chunks) {
      rows.push({
        id: nextTraceId(),
        type: chunk.type,
        scope: CONVERSATION_SCOPE,
        scopeId,
        content: chunk.text,
        embedding: await this._embeddingBlobOf(chunk.text),
        strength: 1.0,
        createdAt: now,
        tags,
        metadata: JSON.stringify(
          buildInitialTraceMetadata(
            {},
            { contentHash: await sha256(chunk.text), entities: [...(chunk.entities ?? [])], scopeId },
          ),
        ),
      });
    }
    const chunkIds = rows.map((row) => row.id);
    // An old chunk's knowledge-graph copy holds its text and is found by the chunk's id alone: the copies go first,
    // and a graph that cannot delete them fails the call with every row as it was.
    if (old.length > 0) await this._knowledgeGraph.deleteMemories({ traceIds: old });
    const write = async (db: Pick<StorageAdapter, 'run'>): Promise<void> => {
      await ensureScopeRow(db, brainId, scopeId, now);
      for (const row of rows) await this._insertTraceRow(db, row);
      await replace(db, chunkIds);
      await deleteTraceRows(db, brainId, old);
    };
    try {
      if (transactions) await this._brain.transaction(write);
      else await write(this._brain);
    } catch (error) {
      if (!(error instanceof PageRowChangedError)) throw error;
      // The row changed after it was read. A transaction took this attempt's chunks back with it; without one, they
      // are deleted here, before the write reads the row again.
      if (!transactions) await deleteTraceRows(this._brain, brainId, chunkIds);
      return null;
    }

    for (const row of rows) await this._afterTraceInsert(row);
    for (const id of old) {
      try {
        await this._memoryGraph.removeNode(id);
      } catch {
        // A node whose delete fails stays, holding no words of the chunk; its trace is gone.
      }
      this._hnswSidecar?.remove(id);
    }
    // Postgres keeps the index in each row's own column, which went with the row.
    if (old.length > 0 && this._brain.features.dialect.name !== 'postgres') await this._rebuildFtsIndex();
    return { chunkIds };
  }

  /**
   * Deletes one wiki page row of a user's or a session's conversation scope, or every page row of the scope, for
   * good: the pages' chunks first ({@link deleteTraces}), then the rows. Another scope's pages are never touched.
   *
   * @param pageId - The one page to delete; every page of the scope when left out.
   * @returns How many page rows and how many chunk traces it deleted.
   * @throws TypeError when `scopeId` is not the conversation key of a user or of a session.
   * @throws InvalidWikiPageIdError for a refused page id.
   * @throws When the knowledge graph cannot delete the chunks' copies: no row is deleted.
   * @throws When other writers rewrote a page's row under each of its attempts to delete it: that row is kept.
   */
  async deletePageRows(scopeId: string, pageId?: string): Promise<{ pages: number; chunks: number }> {
    assertPageOwnerKey(scopeId);
    if (pageId !== undefined) assertWikiPageId(pageId);
    await this._initPromise;
    // After a compile of the scope that is running: the page it writes is one of the pages deleted.
    return this._oneScopeChangeAtATime(scopeId, () =>
      this._onePageWriteAtATime(scopeId, () => this._deletePageRows(scopeId, pageId)),
    );
  }

  /**
   * {@link deletePageRows}, once the scope's earlier page writes have settled. Each row is deleted only while it holds
   * the text and the chunk list read with it: a row another process rewrote between the read and the delete lists
   * chunks this call has not deleted, so it is read again and its chunks go first.
   */
  private async _deletePageRows(scopeId: string, pageId?: string): Promise<{ pages: number; chunks: number }> {
    // The rows that are there now, by their ids: a page another writer adds meanwhile keeps its row with its chunks.
    const ids = pageId === undefined ? (await this.listPageRows(scopeId)).map((row) => row.pageId) : [pageId];
    let pages = 0;
    let chunks = 0;
    for (const id of ids) {
      for (let attempt = 1; ; attempt += 1) {
        const record = await this._readPageRecord(scopeId, id);
        if (!record) break;
        chunks += (await this.deleteTraces(pageRowOf(record).chunkIds)).deleted;
        const result = await this._brain.run(
          `DELETE FROM memory_pages
            WHERE brain_id = ? AND scope = ? AND scope_id = ? AND page_id = ? AND content = ? AND chunk_ids = ?`,
          [this._brain.brainId, CONVERSATION_SCOPE, scopeId, id, record.content, record.chunk_ids],
        );
        if (result.changes > 0) {
          pages += 1;
          // The page's text is in the log until a checkpoint.
          this._erasureOwed.deletes += 1;
          break;
        }
        if (attempt >= PAGE_WRITE_ATTEMPTS) {
          throw new Error(
            `Memory: the page row changed under each of ${PAGE_WRITE_ATTEMPTS} attempts to delete it; its row is kept`,
          );
        }
      }
    }
    return { pages, chunks };
  }

  /**
   * Whether a conversation scope other than `scopeId` holds a wiki page row of that id; with null, whether any
   * conversation scope does. The answer says why a page was not found for one asker, for a log line: nothing a
   * caller is served depends on it, and it names no scope.
   *
   * @param scopeId - The asker's own key, left out of the search; null to search every scope.
   * @throws InvalidWikiPageIdError for a refused page id; nothing is read.
   */
  async pageExistsOutside(scopeId: string | null, pageId: string): Promise<boolean> {
    assertWikiPageId(pageId);
    await this._initPromise;
    const conditions = ['brain_id = ?', 'scope = ?', 'page_id = ?'];
    const params: unknown[] = [this._brain.brainId, CONVERSATION_SCOPE, pageId];
    if (scopeId !== null) {
      conditions.push('scope_id <> ?');
      params.push(scopeId);
    }
    const row = await this._brain.get<{ found: number | string }>(
      `SELECT 1 AS found FROM memory_pages WHERE ${conditions.join(' AND ')} LIMIT 1`,
      params,
    );
    return row !== undefined && row !== null;
  }

  /**
   * List traces created strictly after `sinceMs` (Unix-ms). Newest-first by
   * default; pass `order: 'asc'` for oldest-first (used by the wiki compiler to
   * drain the window in chronological batches).
   *
   * Unlike {@link recall}, this performs no FTS match — it is a time-window scan,
   * used by the wiki compiler to fold recent activity into pages.
   *
   * @param sinceMs - Exclusive lower bound on `created_at` (Unix ms). Use 0 for "all".
   * @param options - Optional scope filter, scope id filter (equality on the `scope_id` column), result cap
   *   (default 200), and sort order.
   * @throws TypeError when `options.scope` is `'conversation'` and no `scopeId` is given: that scope is read one
   *   key at a time.
   */
  async recentTraces(
    sinceMs: number,
    options?: { limit?: number; scope?: string; scopeId?: string; order?: 'asc' | 'desc' },
  ): Promise<MemoryTrace[]> {
    assertConversationKeyGiven('recentTraces', options?.scope, options?.scopeId);
    await this._initPromise;
    const limit = options?.limit ?? 200;
    // Whitelisted literal — never interpolate user input into SQL.
    const direction = options?.order === 'asc' ? 'ASC' : 'DESC';
    const conditions = ['brain_id = ?', 'deleted = 0', 'created_at > ?'];
    const params: unknown[] = [this._brain.brainId, sinceMs];
    if (options?.scope) {
      conditions.push('scope = ?');
      params.push(options.scope);
    }
    if (options?.scopeId) {
      conditions.push('scope_id = ?');
      params.push(options.scopeId);
    }
    params.push(limit);

    const rows = await this._brain.all<TraceRow>(
      `SELECT id, type, scope, content, embedding, strength, created_at,
              last_accessed, retrieval_count, tags, emotions, metadata, deleted
       FROM memory_traces
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at ${direction}
       LIMIT ?`,
      params,
    );
    return rows.map((row) => this._buildTrace(row));
  }

  /**
   * Names traces of a conversation scope for its next compile to read by id, beside the traces after its watermark:
   * the traces a deleted page was built from that are still there, so the page is rebuilt from them. The ids are
   * added to the scope's registry row (`rebuild_sources`), each once; a scope with no registry row takes none.
   */
  async addRebuildSources(scopeId: string, traceIds: readonly string[]): Promise<void> {
    await this._initPromise;
    const ids = traceIds.filter((id) => typeof id === 'string' && id !== '');
    if (ids.length === 0) return;
    const where = 'brain_id = ? AND scope = ? AND scope_id = ?';
    const key = [this._brain.brainId, CONVERSATION_SCOPE, scopeId];
    const row = await this._brain.get<{ rebuild_sources: string | null }>(`SELECT rebuild_sources FROM memory_scopes WHERE ${where}`, key);
    if (!row) return;
    const listed = [...new Set([...rebuildSourceIds(row.rebuild_sources ?? null), ...ids])];
    await this._brain.run(`UPDATE memory_scopes SET rebuild_sources = ? WHERE ${where}`, [JSON.stringify(listed), ...key]);
  }

  /** The live traces of one scope a registry row lists in `rebuild_sources`, a page's chunks left out. */
  private async _rebuildSourceTraces(scopeId: string, listed: string): Promise<MemoryTrace[]> {
    const ids = rebuildSourceIds(listed);
    const traces: MemoryTrace[] = [];
    for (let offset = 0; offset < ids.length; offset += 400) {
      const slice = ids.slice(offset, offset + 400);
      const rows = await this._brain.all<TraceRow>(
        `SELECT id, type, scope, content, embedding, strength, created_at,
                last_accessed, retrieval_count, tags, emotions, metadata, deleted
           FROM memory_traces
          WHERE brain_id = ? AND deleted = 0 AND scope = ? AND scope_id = ? AND id IN (${slice.map(() => '?').join(', ')})`,
        [this._brain.brainId, CONVERSATION_SCOPE, scopeId, ...slice],
      );
      for (const row of rows) if (!isPageChunkTags(row.tags)) traces.push(this._buildTrace(row));
    }
    return traces;
  }

  /** The wiki attached by the agent at boot: a page store per conversation scope, and the compiler. */
  private _wiki?: AttachedWiki;

  /**
   * Attach a wiki: a page store per conversation scope, a compiler, and its two optional hooks. Called by the
   * agent at boot. Idempotent (last call wins).
   */
  attachWiki(wiki: AttachedWiki): void {
    this._wiki = wiki;
  }

  /**
   * Compile new traces into wiki pages, one conversation scope at a time: each scope's traces go to the compiler
   * with that scope's own page store, and each scope keeps its own watermark, `compiled_at` in its row of
   * `memory_scopes`. No-op when no wiki is attached.
   *
   * Only the scopes of a user or a session are compiled; the operator's scope never is. For each scope the traces
   * stored after its watermark are read oldest first, in batches. The scope's own page chunks (tagged `wiki`) are
   * left out, so a scope whose only new traces are its chunks makes no model call. The watermark then moves to the
   * newest trace of the batch read, not to wall-clock now.
   *
   * A scope whose compile throws keeps its watermark where it was, so the next compile takes up the same traces,
   * and the other scopes go on. When the wiki's `compileSkipReasonOf` names a reason for the error, such as a spend
   * budget's refusal, the scope is skipped; any other error is thrown once every scope has run, the first of them
   * when several scopes failed. A scope the wiki's `beforeScopeCompile` skips keeps its watermark too. Each reason a
   * scope was skipped for is logged once a call, as one `memory.compile_skipped` line that names no scope.
   *
   * @param opts.reason - What triggered this compile (telemetry + compiler hint).
   * @param opts.scopes - The scope ids to compile. Unset: every user or session scope that holds a trace newer than
   *   its watermark. An id with no registry row, and the operator's, is left out. An empty list compiles nothing.
   * @returns The pages written, the traces consumed and the conflicts, summed over the scopes that compiled.
   */
  async compileWiki(opts?: {
    reason?: 'consolidation' | 'session-end' | 'explicit';
    scopes?: readonly string[];
  }): Promise<CompileResult> {
    await this._initPromise;
    const aggregate: CompileResult = { pagesWritten: [], tracesConsumed: 0, conflicts: [] };
    const wiki = this._wiki;
    if (!wiki) return aggregate;

    const reason = opts?.reason ?? 'explicit';
    const skipped = new Set<CompileSkipReason>();
    let failed = false;
    let failure: unknown;
    for (const target of await this._scopesToCompile(opts?.scopes)) {
      try {
        const compileScope = () =>
          this._oneScopeChangeAtATime(target.scopeId, () => this._compileScope(wiki, target, reason, aggregate));
        const skip = await (wiki.runScope ? wiki.runScope(target.scopeId, compileScope) : compileScope());
        if (skip) skipped.add(skip);
      } catch (error) {
        const why = wiki.compileSkipReasonOf?.(error);
        if (why) {
          skipped.add(why);
        } else if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    for (const why of skipped) memoryLog.warn('memory.compile_skipped', { reason: why });
    if (failed) throw failure;
    return aggregate;
  }

  /**
   * The user and session scopes a compile runs over, each with its watermark: the scopes named, or, with none
   * named, every one that holds a live trace newer than its watermark or names traces a page is to be rebuilt from
   * (`rebuild_sources`). A scope is matched by equality on its id.
   */
  private async _scopesToCompile(scopes: readonly string[] | undefined): Promise<Array<{ scopeId: string; compiledAt: number }>> {
    const brainId = this._brain.brainId;
    type Row = { scope_id: string; compiled_at: number | string | null };
    // A BIGINT column can come back as text (Postgres): the watermark is read through Number().
    const target = (row: Row) => ({ scopeId: row.scope_id, compiledAt: row.compiled_at === null || row.compiled_at === undefined ? 0 : Number(row.compiled_at) });
    if (scopes === undefined) {
      const rows = await this._brain.all<Row>(
        `SELECT s.scope_id AS scope_id, s.compiled_at AS compiled_at
           FROM memory_scopes s
          WHERE s.brain_id = ? AND s.scope = ? AND s.kind IN ('user', 'session')
            AND (s.rebuild_sources IS NOT NULL OR EXISTS (
              SELECT 1 FROM memory_traces t
               WHERE t.brain_id = s.brain_id AND t.scope = s.scope AND t.scope_id = s.scope_id
                 AND t.deleted = 0 AND t.created_at > COALESCE(s.compiled_at, 0)))
          ORDER BY s.scope_id`,
        [brainId, CONVERSATION_SCOPE],
      );
      return rows.map(target);
    }
    const targets: Array<{ scopeId: string; compiledAt: number }> = [];
    for (const scopeId of new Set(scopes)) {
      if (typeof scopeId !== 'string' || scopeId === '') continue;
      const row = await this._brain.get<Row>(
        `SELECT scope_id, compiled_at FROM memory_scopes
          WHERE brain_id = ? AND scope = ? AND scope_id = ? AND kind IN ('user', 'session')`,
        [brainId, CONVERSATION_SCOPE, scopeId],
      );
      if (row) targets.push(target(row));
    }
    return targets;
  }

  /** Counts a write stamped `at` as not yet stored, for every facade of this store, until the returned call. */
  private _holdUnstored(at: number): () => void {
    const unstored = coordinationOf(this._brain.coordinationToken).unstored;
    unstored.set(at, (unstored.get(at) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (unstored.get(at) ?? 1) - 1;
      if (left > 0) unstored.set(at, left);
      else unstored.delete(at);
    };
  }

  /**
   * Marks a compile read as begun and returns the time it reads below: the earliest write of any facade of this store
   * in this process stamped and not yet stored, or no bound. Every trace stamped before that time is stored, and every
   * trace stamped from now on is later than any the read returns. Writers in other processes are not ordered by it.
   */
  private _beginCompileRead(): number {
    const fence = coordinationOf(this._brain.coordinationToken);
    fence.compileReadAt = Math.max(Date.now(), fence.compileReadAt, fence.lastConversationStamp);
    let bound = Number.POSITIVE_INFINITY;
    for (const at of fence.unstored.keys()) if (at < bound) bound = at;
    return bound;
  }

  /**
   * The live traces of one conversation scope stamped after `sinceMs` and before `belowMs`, oldest first and in id
   * order within one millisecond; at most `limit`, or every one stamped at `exactlyMs` when it is given.
   */
  private async _compileTraces(
    scopeId: string,
    range: { sinceMs: number; belowMs: number; limit: number } | { exactlyMs: number },
  ): Promise<MemoryTrace[]> {
    const select = `SELECT id, type, scope, content, embedding, strength, created_at,
              last_accessed, retrieval_count, tags, emotions, metadata, deleted
         FROM memory_traces
        WHERE brain_id = ? AND deleted = 0 AND scope = ? AND scope_id = ?`;
    const base = [this._brain.brainId, CONVERSATION_SCOPE, scopeId];
    const rows =
      'exactlyMs' in range
        ? await this._brain.all<TraceRow>(`${select} AND created_at = ? ORDER BY id ASC`, [...base, range.exactlyMs])
        : Number.isFinite(range.belowMs)
          ? await this._brain.all<TraceRow>(
              `${select} AND created_at > ? AND created_at < ? ORDER BY created_at ASC, id ASC LIMIT ?`,
              [...base, range.sinceMs, range.belowMs, range.limit],
            )
          : await this._brain.all<TraceRow>(`${select} AND created_at > ? ORDER BY created_at ASC, id ASC LIMIT ?`, [
              ...base,
              range.sinceMs,
              range.limit,
            ]);
    return rows.map((row) => this._buildTrace(row));
  }

  /**
   * Compiles one scope from its watermark on, adding what its compiles return to `aggregate`, and moves the
   * watermark past each batch it compiled.
   *
   * A batch never ends inside a millisecond: when the limit would cut one, the traces of that millisecond wait for
   * the next batch, or, when the whole batch shares one, every trace of it is read. The read stops below any write
   * of this facade still being stored, so the watermark never passes a trace that is stored after the read.
   *
   * @returns The reason the wiki's `beforeScopeCompile` skipped the scope for; undefined when it was not skipped.
   * @throws Whatever the hook, the compiler or the store throws; the watermark then stays where the last compiled
   *   batch left it.
   */
  private async _compileScope(
    wiki: AttachedWiki,
    target: { scopeId: string; compiledAt: number },
    reason: 'consolidation' | 'session-end' | 'explicit',
    aggregate: CompileResult,
  ): Promise<CompileSkipReason | undefined> {
    const BATCH = 500;
    const { scopeId } = target;
    // The watermark is read here, in the scope's turn: a compile that waited for another compile of the scope starts
    // where that one left it, and sends none of the same traces to the model again. A scope deleted meanwhile is done.
    const current = await this._brain.get<{ compiled_at: number | string | null; rebuild_sources: string | null }>(
      `SELECT compiled_at, rebuild_sources FROM memory_scopes WHERE brain_id = ? AND scope = ? AND scope_id = ?`,
      [this._brain.brainId, CONVERSATION_SCOPE, scopeId],
    );
    if (!current) return undefined;
    const store = wiki.storeFor(scopeId);
    let sinceMs = current.compiled_at === null || current.compiled_at === undefined ? 0 : Number(current.compiled_at);
    // The traces a deleted page is to be rebuilt from: read by id, beside the traces after the watermark, in the
    // scope's first batch. They stay listed until a batch that holds them has compiled.
    const listed = current.rebuild_sources ?? null;
    let rebuild: MemoryTrace[] = listed === null ? [] : await this._rebuildSourceTraces(scopeId, listed);
    let rebuildPending = listed !== null;
    for (;;) {
      const belowMs = this._beginCompileRead();
      const read = await this._compileTraces(scopeId, { sinceMs, belowMs, limit: BATCH });
      if (read.length === 0 && !rebuildPending) break;
      const full = read.length === BATCH;
      let batch = read;
      if (full) {
        const last = Number(read[read.length - 1].createdAt);
        const before = read.filter((trace) => Number(trace.createdAt) < last);
        batch = before.length > 0 ? before : await this._compileTraces(scopeId, { exactlyMs: last });
      }

      // The scope's own page chunks are never compiled back into its pages.
      let traces = batch.filter((trace) => !trace.tags.includes('wiki'));
      if (rebuildPending) {
        // Each trace once, oldest first.
        const inBatch = new Set(traces.map((trace) => trace.id));
        traces = [...rebuild.filter((trace) => !inBatch.has(trace.id)), ...traces].sort(
          (a, b) => Number(a.createdAt) - Number(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      }
      if (traces.length > 0) {
        if (wiki.beforeScopeCompile) {
          const answer = await wiki.beforeScopeCompile(scopeId, traces);
          if ('skip' in answer) return answer.skip;
          traces = answer.traces;
        }
        const result = await wiki.compiler.compile({ traces, reason, store });
        aggregate.pagesWritten.push(...result.pagesWritten);
        aggregate.tracesConsumed += result.tracesConsumed;
        aggregate.conflicts.push(...result.conflicts);
      }

      if (rebuildPending) {
        // The listed traces are compiled: the list is cleared while it still holds what was read, so ids another
        // writer added meanwhile wait for the next compile.
        await this._brain.run(
          `UPDATE memory_scopes SET rebuild_sources = NULL
            WHERE brain_id = ? AND scope = ? AND scope_id = ? AND rebuild_sources = ?`,
          [this._brain.brainId, CONVERSATION_SCOPE, scopeId, listed],
        );
        rebuildPending = false;
        rebuild = [];
      }
      if (batch.length === 0) break;

      // A trace stored meanwhile, by an import or another writer, under a time the batch spans is read next time: the
      // watermark stops just before the oldest such trace.
      const newest = batch.reduce((latest, trace) => Math.max(latest, Number(trace.createdAt)), sinceMs);
      const compiledIds = new Set(batch.map((trace) => trace.id));
      const stored = await this._brain.all<{ id: string; created_at: number | string; tags: string }>(
        `SELECT id, created_at, tags FROM memory_traces
          WHERE brain_id = ? AND deleted = 0 AND scope = ? AND scope_id = ? AND created_at > ? AND created_at <= ?`,
        [this._brain.brainId, CONVERSATION_SCOPE, scopeId, sinceMs, newest],
      );
      const unread = stored
        .filter((row) => !compiledIds.has(row.id) && !isPageChunkTags(row.tags))
        .map((row) => Number(row.created_at));
      const watermark = unread.length > 0 ? Math.min(...unread) - 1 : newest;
      // Moved only from the value this compile started from: an import that moved it back meanwhile keeps its value,
      // and the compile of this scope stops here.
      const moved = await this._brain.run(
        `UPDATE memory_scopes SET compiled_at = ?
          WHERE brain_id = ? AND scope = ? AND scope_id = ? AND COALESCE(compiled_at, 0) = ?`,
        [watermark, this._brain.brainId, CONVERSATION_SCOPE, scopeId, sinceMs],
      );
      if (moved.changes === 0 || watermark < newest) break;
      sinceMs = watermark;

      if (!full) break;
    }
    return undefined;
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
   * - `.sqlite` / `.db` -> a new SQLite file holding this brain's own rows
   * - directory path -> Markdown or Obsidian (based on `options.format`)
   *
   * A SQLite export writes this brain's rows of every portable table, from a
   * SQLite or a Postgres brain; another brain in the same database is left
   * out. Nothing may exist at `outputPath` yet.
   *
   * A Markdown or Obsidian export writes one file per trace, in folders named
   * after the trace's scope and type, and leaves out a trace whose scope, type
   * or id is not a safe file or folder name, whose place in the export folder
   * holds a link, symbolic or hard, or anything but a regular file, or whose
   * file would be an older trace's, where names ignore case or by the file
   * system's own reckoning; the result lists each one left out. No file is
   * written outside the export folder.
   *
   * @param outputPath - Path to write the export to.
   * @param options    - Optional format and content controls.
   * @returns The traces the export left out, with the reason for each.
   */
  async export(outputPath: string, options?: ExportOptions): Promise<ExportResult> {
    await this._initPromise;

    const format = await this._detectExportFormat(outputPath, options);

    switch (format) {
      case 'json': {
        const { JsonExporter } = await import('../JsonExporter.js');
        const exporter = new JsonExporter(this._brain);
        await exporter.export(outputPath, options);
        return { refused: [] };
      }
      case 'markdown': {
        const { MarkdownExporter } = await import('../MarkdownExporter.js');
        const exporter = new MarkdownExporter(this._brain);
        return exporter.export(outputPath, options);
      }
      case 'obsidian': {
        const { ObsidianExporter } = await import('../ObsidianExporter.js');
        const exporter = new ObsidianExporter(this._brain);
        return exporter.export(outputPath, options);
      }
      case 'sqlite': {
        const { SqliteExporter } = await import('../SqliteExporter.js');
        const exporter = new SqliteExporter(this._brain);
        await exporter.export(outputPath, options);
        return { refused: [] };
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
   * A SQLite source is read one brain at a time: a file whose rows carry
   * several brain ids imports nothing, and `errors` names the ids.
   *
   * @param source  - Path to the import source (file or directory).
   * @param options - Optional format hint and dedup settings.
   * @returns Summary of the import operation.
   */
  async importFrom(source: string, options?: ImportOptions): Promise<ImportResult> {
    await this._initPromise;

    const format = await this._detectImportFormat(source, options);
    let result: ImportResult;
    // The SQLite and Obsidian importers rebuild the full-text index
    // themselves, once, after an import that inserted a trace or added new
    // tags to one.
    let importerRebuildsFullText = false;

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
        importerRebuildsFullText = true;
        break;
      }
      case 'sqlite': {
        const { SqliteImporter } = await import('../SqliteImporter.js');
        result = await new SqliteImporter(this._brain).import(source, options);
        importerRebuildsFullText = true;
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
      if (!importerRebuildsFullText) {
        await this._rebuildFtsIndex();
      }
      await this._rebuildHnswIndex();
      // An importer writes trace rows itself: a conversation scope it filed gets its registry row here.
      await registerUnregisteredConversationScopes(this._brain, this._brain.brainId);
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
      // An importer writes trace rows itself: a conversation scope it filed gets its registry row here.
      await registerUnregisteredConversationScopes(this._brain, this._brain.brainId);
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
   * Where a learning layer puts a turn's scope ids on a call, the tools file
   * and read under them and record each write in the layer's ledger, and
   * `memory_reflect` refuses (`withdrawn`); a host that registers the tools
   * itself leaves `memory_reflect` out (`includeReflect: false`).
   *
   * When self-improvement is disabled, `memory_reflect` is omitted because
   * there is no backing {@link ConsolidationLoop} instance.
   */
  createTools(options?: { includeReflect?: boolean }): ITool[] {
    // The four tools that write delete a trace's knowledge-graph copy with it, and take back a write a learning layer
    // does not keep, through this facade, so a trace's memory-graph node, index entry and knowledge-graph copy go with
    // its row.
    const tools: ITool[] = [
      new MemoryAddTool(this._brain, this),
      new MemoryUpdateTool(this._brain, this),
      new MemoryDeleteTool(this._brain, this),
      new MemoryMergeTool(this._brain, this),
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
   * Return a health snapshot of this brain.
   *
   * Queries aggregate statistics from this brain's rows of every table (a
   * database can hold several brains) and returns a {@link MemoryHealth}
   * report. Counts are read through `Number()`: Postgres returns `COUNT(*)`
   * and `BIGINT` columns as strings.
   */
  async health(): Promise<MemoryHealth> {
    await this._initPromise;
    const brainId = this._brain.brainId;

    // Total traces (active + deleted).
    const totalRow = await this._brain.get<{ cnt: number | string }>(
      'SELECT COUNT(*) AS cnt FROM memory_traces WHERE brain_id = ?',
      [brainId],
    );
    const totalTraces = Number(totalRow?.cnt ?? 0);

    // Active traces (not deleted).
    const activeRow = await this._brain.get<{ cnt: number | string }>(
      'SELECT COUNT(*) AS cnt FROM memory_traces WHERE brain_id = ? AND deleted = 0',
      [brainId],
    );
    const activeTraces = Number(activeRow?.cnt ?? 0);

    // Average strength of active traces.
    const avgRow = await this._brain.get<{ avg_s: number | null }>(
      'SELECT AVG(strength) AS avg_s FROM memory_traces WHERE brain_id = ? AND deleted = 0',
      [brainId],
    );
    const avgStrength = Number(avgRow?.avg_s ?? 0);

    // Weakest active trace.
    const weakRow = await this._brain.get<{ min_s: number | null }>(
      'SELECT MIN(strength) AS min_s FROM memory_traces WHERE brain_id = ? AND deleted = 0',
      [brainId],
    );
    const weakestTraceStrength = Number(weakRow?.min_s ?? 0);

    // Knowledge graph counts.
    const nodesRow = await this._brain.get<{ cnt: number | string }>(
      'SELECT COUNT(*) AS cnt FROM knowledge_nodes WHERE brain_id = ?',
      [brainId],
    );
    const graphNodes = Number(nodesRow?.cnt ?? 0);

    const edgesRow = await this._brain.get<{ cnt: number | string }>(
      'SELECT COUNT(*) AS cnt FROM knowledge_edges WHERE brain_id = ?',
      [brainId],
    );
    const graphEdges = Number(edgesRow?.cnt ?? 0);

    // Last consolidation timestamp.
    const lastConsolRow = await this._brain.get<{ ran_at: number | string }>(
      'SELECT ran_at FROM consolidation_log WHERE brain_id = ? ORDER BY ran_at DESC LIMIT 1',
      [brainId],
    );
    const lastConsolidation = lastConsolRow
      ? new Date(Number(lastConsolRow.ran_at)).toISOString()
      : null;

    // Traces per type.
    const typeRows = await this._brain.all<{ type: string; cnt: number | string }>(
      'SELECT type, COUNT(*) AS cnt FROM memory_traces WHERE brain_id = ? AND deleted = 0 GROUP BY type',
      [brainId],
    );
    const tracesPerType: Record<string, number> = {};
    for (const row of typeRows) {
      tracesPerType[row.type] = Number(row.cnt);
    }

    // Traces per scope.
    const scopeRows = await this._brain.all<{ scope: string; cnt: number | string }>(
      'SELECT scope, COUNT(*) AS cnt FROM memory_traces WHERE brain_id = ? AND deleted = 0 GROUP BY scope',
      [brainId],
    );
    const tracesPerScope: Record<string, number> = {};
    for (const row of scopeRows) {
      tracesPerScope[row.scope] = Number(row.cnt);
    }

    // Documents ingested.
    const docsRow = await this._brain.get<{ cnt: number | string }>(
      'SELECT COUNT(*) AS cnt FROM documents WHERE brain_id = ?',
      [brainId],
    );
    const documentsIngested = Number(docsRow?.cnt ?? 0);

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
    // A rewrite of the vector index reads the traces through the Brain: it finishes before the Brain closes.
    await this._vectorIndexWork;
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
      ...(typeof metadata.turnUserId === 'string' && metadata.turnUserId ? { turnUserId: metadata.turnUserId } : {}),
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
   * The encoded vector of `content`, or null with no embedder or when the embedder fails: the trace is then stored
   * without one.
   */
  private async _embeddingBlobOf(content: string): Promise<Uint8Array | null> {
    if (!this._embed) return null;
    try {
      return this._brain.features.blobCodec.encode(await this._embed(content));
    } catch {
      // Embedding generation failed: continue without a vector.
      return null;
    }
  }

  /**
   * What follows a trace row's insert, outside any transaction: the row's full-text entry, its memory-graph node
   * where the graph is on, and its vector in the HNSW sidecar when the row holds one.
   */
  private async _afterTraceInsert(row: NewTraceRow): Promise<void> {
    // Sync FTS index. The external-content FTS table needs explicit insert.
    const { fts } = this._brain.features;
    try {
      await this._brain.run(
        fts.syncInsert('memory_traces_fts', '(SELECT rowid FROM memory_traces WHERE id = ?)', ['content', 'tags']),
        [row.id, row.content, row.tags],
      );
    } catch (error) {
      if (!isFtsUnavailableError(error)) {
        throw error;
      }
    }

    // Add to memory graph if available.
    if (this._config.graph) {
      await this._memoryGraph.addNode(row.id, {
        type: row.type as 'episodic' | 'semantic' | 'procedural',
        scope: row.scope as 'session' | 'user' | 'global',
        scopeId: row.scopeId,
        strength: row.strength,
        createdAt: row.createdAt,
      });
    }

    // Add to HNSW sidecar if embeddings exist for this trace.
    // The embedding is stored in the memory_traces table; if it's non-null,
    // also index it in the HNSW sidecar for fast ANN recall. The sidecar is
    // this brain's: its threshold counts this brain's traces and its rebuild
    // reads this brain's embeddings. The row is written first and the index
    // step runs after any rewrite already asked for, so a rewrite that read the
    // traces before this row existed does not drop it from the index.
    const sidecar = this._hnswSidecar;
    if (sidecar) {
      await this._onVectorIndex(async () => {
        const stored = await this._brain.get<{ embedding: Buffer | null }>(
          'SELECT embedding FROM memory_traces WHERE brain_id = ? AND id = ?',
          [this._brain.brainId, row.id],
        );
        if (stored?.embedding && stored.embedding.length > 0) {
          const { blobCodec } = this._brain.features;
          const isLegacy = typeof stored.embedding === 'string' ||
            (stored.embedding && stored.embedding[0] === 0x5b); // '[' character = JSON array
          const vec = isLegacy
            ? JSON.parse(stored.embedding as unknown as string) as number[]
            : blobCodec.decode(stored.embedding);
          const countRow = await this._brain.get<{ c: number }>(
            'SELECT COUNT(*) as c FROM memory_traces WHERE brain_id = ? AND deleted = 0',
            [this._brain.brainId],
          );
          const count = countRow?.c ?? 0;

          if (!sidecar.isActive && count >= 1000) {
            // Threshold crossed — rebuild the index from this brain's embeddings.
            await sidecar.rebuildFromData(await this._ownEmbeddedTraces());
          } else {
            await sidecar.add(row.id, vec, count);
          }
        }
      });
    }
  }

  /**
   * Inserts one trace row, live and never recalled, through `db`: the Brain, or the transaction that holds the
   * row's other writes.
   */
  private async _insertTraceRow(db: Pick<StorageAdapter, 'run'>, row: NewTraceRow): Promise<void> {
    await db.run(
      `INSERT INTO memory_traces
         (brain_id, id, type, scope, content, embedding, strength, created_at,
          last_accessed, retrieval_count, tags, emotions, metadata, deleted, scope_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, 0, ?)`,
      [
        this._brain.brainId,
        row.id,
        row.type,
        row.scope,
        row.content,
        row.embedding, // Binary blob or null
        row.strength,
        row.createdAt,
        row.tags,
        JSON.stringify({}),
        row.metadata,
        row.scopeId,
      ],
    );
  }

  /**
   * Find an active trace of this brain previously stored with the same
   * content hash.
   *
   * Checks both the facade-native `content_hash` metadata key and the
   * importer-used `import_hash` key so dedup works across facade and import
   * workflows. Another brain's trace of the same text is not a duplicate, and
   * neither is a trace another user filed (`metadata.turnUserId`): a second
   * user's words stay a trace of their own beside the same words of the
   * session's owner, so a deletion of either user's traces leaves the other's.
   *
   * A trace tagged `wiki` (a chunk of a wiki page) and one that is not are never duplicates of each other.
   *
   * @param turnUserId - The second user the new trace is filed for, or `''`.
   * @param asChunk - Whether the new trace is a chunk of a wiki page (tagged `wiki`).
   */
  private async _findExistingTraceByHash(
    contentHash: string,
    type: string,
    scope: string,
    scopeId: string,
    turnUserId: string,
    asChunk = false,
  ): Promise<TraceRow | undefined> {
    const { dialect } = this._brain.features;
    // Read 50 candidates at a time until one of the kind asked for is found: any number of the other kind can come
    // first.
    for (let offset = 0; ; offset += 50) {
      const rows = await this._brain.all<TraceRow>(
        `SELECT id, type, scope, content, embedding, strength, created_at,
                last_accessed, retrieval_count, tags, emotions, metadata, deleted
         FROM memory_traces
         WHERE brain_id = ?
           AND deleted = 0
           AND type = ?
           AND scope = ?
           AND ${dialect.ifnull(dialect.jsonExtract('metadata', '$.scopeId'), "''")} = ?
           AND ${dialect.ifnull(dialect.jsonExtract('metadata', '$.turnUserId'), "''")} = ?
           AND (
             ${dialect.jsonExtract('metadata', '$.content_hash')} = ?
             OR ${dialect.jsonExtract('metadata', '$.import_hash')} = ?
           )
         LIMIT 50 OFFSET ?`,
        [this._brain.brainId, type, scope, scopeId, turnUserId, contentHash, contentHash, offset],
      );
      // The tags are a JSON array in a text column, tested here: the dialect has no array test for both engines.
      const found = rows.find((row) => {
        let tags: unknown = [];
        try {
          tags = JSON.parse(row.tags);
        } catch {
          /* tags that do not parse name no page */
        }
        return (Array.isArray(tags) && tags.includes('wiki')) === asChunk;
      });
      if (found || rows.length < 50) return found;
    }
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
            last_accessed, retrieval_count, tags, emotions, metadata, deleted, scope_id)
         VALUES (?, ?, 'semantic', 'user', ?, NULL, 1.0, ?, NULL, 0, '[]', '{}', ?, 0, '')`,
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
      const rebuild = this._brain.fullTextRebuild();
      await this._brain.run(rebuild.sql, rebuild.params);
    } catch {
      // Best-effort; imports still succeed even if the FTS rebuild is unavailable.
    }
  }

  /**
   * Recall by `LIKE` matching when the database has no full-text index (a
   * SQLite build without FTS5).
   *
   * @param filters      - The recall's conditions joined with `AND`, this
   *   brain's id first.
   * @param filterParams - Their parameters, in order.
   */
  private async _recallWithoutFts(
    rawQuery: string,
    filters: string,
    filterParams: unknown[],
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
      WHERE ${filters}
      AND (${matchExpression})
      ORDER BY (t.strength * (${scoreExpression})) DESC, t.created_at DESC
      LIMIT ?
    `;

    // Parameters bind in the order their placeholders appear: the score in
    // the select list, the filters, the match, the score in ORDER BY, the limit.
    return this._brain.all<FtsJoinRow>(
      sql,
      [...likeTerms, ...filterParams, ...likeTerms, ...likeTerms, limit],
    );
  }

  /**
   * Rebuild the HNSW sidecar after bulk import operations.
   *
   * Imports bypass `remember()`, so any embedded traces need to be replayed
   * into the ANN sidecar explicitly to keep hybrid recall accurate.
   */
  private async _rebuildHnswIndex(): Promise<void> {
    const sidecar = this._hnswSidecar;
    if (!sidecar) return;

    try {
      await this._onVectorIndex(async () => {
        const items = await this._ownEmbeddedTraces();
        if (items.length > 0) await sidecar.rebuildFromData(items);
      });
    } catch {
      // Best-effort; import should still succeed even if HNSW rebuild fails.
    }
  }

  /**
   * Brings a vector index loaded from its files up to date with the store at open, and builds nothing when nothing
   * differs. The files are written by a whole build and by this check's adds, never after a delete, so they hold the
   * vectors of the ids their map names and no other. An id that is no live trace with an embedding any more leaves a
   * deleted trace's vector in the files: the index is written again from the store. A live trace the map lacks, stored
   * after the last write, is read and added, and the files are saved.
   */
  private async _checkLoadedVectorIndex(sidecar: import('../../retrieval/store/HnswSidecar.js').HnswSidecar): Promise<void> {
    const rows = await this._brain.all<{ id: string }>(
      'SELECT id FROM memory_traces WHERE brain_id = ? AND deleted = 0 AND embedding IS NOT NULL',
      [this._brain.brainId],
    );
    const live = new Set(rows.map((row) => row.id));
    const indexed = sidecar.ids();
    if (indexed.some((id) => !live.has(id))) {
      await sidecar.rewrite(await this._ownEmbeddedTraces());
      return;
    }
    const held = new Set(indexed);
    const missing = [...live].filter((id) => !held.has(id));
    if (missing.length === 0) return;
    const items: { id: string; embedding: number[] }[] = [];
    for (let offset = 0; offset < missing.length; offset += 400) {
      const slice = missing.slice(offset, offset + 400);
      items.push(
        ...this._decodedEmbeddings(
          await this._brain.all<{ id: string; embedding: Uint8Array | string | null }>(
            `SELECT id, embedding FROM memory_traces
              WHERE brain_id = ? AND deleted = 0 AND embedding IS NOT NULL AND id IN (${slice.map(() => '?').join(', ')})`,
            [this._brain.brainId, ...slice],
          ),
        ),
      );
    }
    await sidecar.addMissing(items);
  }

  /**
   * This brain's live traces that carry an embedding, decoded for the HNSW
   * sidecar. A database can hold several brains; the sidecar is this brain's,
   * so it is built from this brain's vectors only.
   */
  private async _ownEmbeddedTraces(): Promise<{ id: string; embedding: number[] }[]> {
    const rows = await this._brain.all<{ id: string; embedding: Uint8Array | string | null }>(
      'SELECT id, embedding FROM memory_traces WHERE brain_id = ? AND deleted = 0 AND embedding IS NOT NULL',
      [this._brain.brainId],
    );
    return this._decodedEmbeddings(rows);
  }

  /** Embedding rows decoded into vectors; an empty embedding is left out. */
  private _decodedEmbeddings(
    rows: { id: string; embedding: Uint8Array | string | null }[],
  ): { id: string; embedding: number[] }[] {
    const { blobCodec } = this._brain.features;
    return rows
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
