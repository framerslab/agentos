/**
 * @fileoverview Unified SQLite connection manager for a single agent's long-term brain.
 *
 * One `brain.sqlite` file stores everything the memory ingestion engine needs:
 * memory traces, knowledge graph nodes/edges, document ingestion records,
 * conversation history, consolidation logs, and retrieval feedback signals.
 *
 * ## Cognitive science grounding
 * The schema mirrors Tulving's LTM taxonomy:
 * - `memory_traces`       → episodic + semantic + procedural + prospective memories
 * - `knowledge_nodes/edges` → semantic network (Collins & Quillian spreading-activation model)
 * - `documents/chunks`    → external world model (grounded episodic encoding)
 * - `conversations/messages` → episodic conversational buffer
 * - `consolidation_log`   → slow-wave sleep analogue (offline consolidation events)
 * - `retrieval_feedback`  → Hebbian reinforcement ("neurons that fire together wire together")
 *
 * ## Storage design choices
 * - **Cross-platform**: Uses `@framers/sql-storage-adapter` StorageAdapter interface,
 *   enabling browser (IndexedDB/sql.js), mobile (Capacitor), and Postgres backends
 *   in addition to the default Node.js better-sqlite3 path.
 * - **WAL mode**: allows concurrent reads during writes (when adapter supports it).
 * - **FTS5 with Porter tokenizer**: enables fast full-text search over memory content with
 *   morphological stemming (retrieval cue → "retriev*").
 * - **Embeddings as BLOBs**: raw Float32Array buffers stored directly — no external vector DB
 *   dependency for the SQLite-backed path; vector similarity runs in-process via HNSW.
 * - **JSON columns**: tags, emotions, metadata stored as JSON TEXT for schema flexibility
 *   without sacrificing query-ability via SQLite's json_extract().
 *
 * @module memory/store/Brain
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  StorageAdapter,
  StorageRunResult,
  StorageParameters,
  StorageFeatures,
} from '@framers/sql-storage-adapter';
import { resolveStorageAdapter, createStorageFeatures, createPostgresAdapter } from '@framers/sql-storage-adapter';
import {
  DDL_ARCHIVED_TRACES,
  DDL_ARCHIVED_TRACES_IDX_AGENT_TIME,
  DDL_ARCHIVED_TRACES_IDX_REASON,
  DDL_ARCHIVE_ACCESS_LOG,
  DDL_ARCHIVE_ACCESS_LOG_IDX,
} from '../../archive/SqlStorageMemoryArchive.js';
import { MigrationRunner, MIGRATIONS, LATEST_SCHEMA_VERSION } from './migrations/index.js';
import { PORTABLE_TABLES, PORTABLE_TABLE_PRIMARY_KEYS } from './portable-tables.js';
import { redactPostgresPassword } from './postgresPasswordRedaction.js';

/**
 * Derive a stable brain identifier from the database file path.
 *
 * `:memory:` becomes `'default'`. For real paths, the file basename is used
 * with extensions stripped (e.g. `companion-alice.sqlite` becomes
 * `companion-alice`; `foo.brain.sqlite` becomes `foo.brain`).
 *
 * Used by {@link Brain.open} when the caller does not supply an
 * explicit `brainId`.
 */
function parseBetterSqliteUri(dbPath: string): {
  body: string;
  params: URLSearchParams;
} {
  const withoutFragment = dbPath.split('#', 1)[0];
  const queryIndex = withoutFragment.indexOf('?');
  const resource = queryIndex >= 0
    ? withoutFragment.slice(0, queryIndex)
    : withoutFragment;
  const query = queryIndex >= 0 ? withoutFragment.slice(queryIndex + 1) : '';
  const encodedBody = resource.slice('file:'.length);
  let body: string;
  try {
    body = decodeURIComponent(encodedBody);
  } catch {
    body = encodedBody;
  }
  return { body, params: new URLSearchParams(query) };
}

function sqliteUriBodyToPath(body: string): string {
  if (body.toLowerCase().startsWith('//localhost/')) {
    return body.slice('//localhost'.length);
  }
  if (body.startsWith('///')) {
    return body.slice(2);
  }
  return body;
}

function deriveBrainIdFromPath(dbPath: string, adapterKind?: string): string {
  let resourcePath = dbPath;
  if (adapterKind === 'better-sqlite3' && dbPath.startsWith('file:')) {
    const { body } = parseBetterSqliteUri(dbPath);
    resourcePath = sqliteUriBodyToPath(body);
  }
  if (resourcePath === ':memory:') return 'default';
  const basename = path.basename(resourcePath);
  const lastDot = basename.lastIndexOf('.');
  return lastDot > 0 ? basename.slice(0, lastDot) : basename;
}

interface CoordinationTokenRegistration {
  identity: string;
  reference: ReferenceLike<object>;
}

interface ReferenceLike<T extends object> {
  deref(): T | undefined;
}

interface FinalizerLike<T> {
  register(target: object, heldValue: T, unregisterToken?: object): void;
  unregister(unregisterToken: object): boolean;
}

const WeakRefImplementation =
  typeof WeakRef === 'function' ? WeakRef : undefined;
const FinalizationRegistryImplementation =
  typeof FinalizationRegistry === 'function' ? FinalizationRegistry : undefined;

function createReference<T extends object>(target: T): ReferenceLike<T> {
  if (WeakRefImplementation) return new WeakRefImplementation(target);
  // Compatibility fallback for runtimes that do not expose WeakRef. Interned
  // Brain identities then live for the process lifetime and remain bounded by
  // the number of backing resources opened by that runtime.
  return { deref: () => target };
}

const coordinationTokens = new Map<string, ReferenceLike<object>>();
const adapterCoordinationTokens = new WeakMap<StorageAdapter, Map<string, object>>();
const coordinationTokenFinalizer: FinalizerLike<CoordinationTokenRegistration> | null =
  FinalizationRegistryImplementation
    ? new FinalizationRegistryImplementation<CoordinationTokenRegistration>(
        ({ identity, reference }) => {
          if (coordinationTokens.get(identity) === reference) {
            coordinationTokens.delete(identity);
          }
        },
      )
    : null;

function internCoordinationToken(identity: string): object {
  const existing = coordinationTokens.get(identity)?.deref();
  if (existing) return existing;
  const token = {};
  const reference = createReference(token);
  coordinationTokens.set(identity, reference);
  coordinationTokenFinalizer?.register(token, { identity, reference }, reference);
  return token;
}

function rememberAdapterCoordinationToken(
  adapter: StorageAdapter,
  brainId: string,
  token: object,
): void {
  let tokens = adapterCoordinationTokens.get(adapter);
  if (!tokens) {
    tokens = new Map();
    adapterCoordinationTokens.set(adapter, tokens);
  }
  tokens.set(brainId, token);
}

function coordinationTokenForAdapter(adapter: StorageAdapter, brainId: string): object {
  let tokens = adapterCoordinationTokens.get(adapter);
  if (!tokens) {
    tokens = new Map();
    adapterCoordinationTokens.set(adapter, tokens);
  }
  let token = tokens.get(brainId);
  if (!token) {
    token = {};
    tokens.set(brainId, token);
  }
  return token;
}

function rememberedAdapterCoordinationToken(
  adapter: StorageAdapter,
  brainId: string,
): object | undefined {
  return adapterCoordinationTokens.get(adapter)?.get(brainId);
}

async function sqliteCoordinationIdentity(
  dbPath: string,
  brainId: string,
  adapterKind: string,
): Promise<string | null> {
  let resourcePath = dbPath;
  // better-sqlite3 delegates `file:` names to SQLite, which applies URI
  // semantics. sql.js treats the same string as a literal OS filename, so
  // decoding it here would make distinct backing files share a token.
  if (adapterKind === 'better-sqlite3' && dbPath.startsWith('file:')) {
    const { body, params } = parseBetterSqliteUri(dbPath);
    const isMemory = body === ':memory:' || params.get('mode') === 'memory';
    if (isMemory) {
      if (params.get('cache') !== 'shared') return null;
      return JSON.stringify([
        'sqlite-memory-uri',
        adapterKind,
        sqliteUriBodyToPath(body),
        brainId,
      ]);
    }

    if (body.startsWith('//') && !body.toLowerCase().startsWith('//localhost/')) {
      return JSON.stringify(['sqlite-uri', adapterKind, body, brainId]);
    }
    resourcePath = sqliteUriBodyToPath(body);
  }

  const target = await fs.realpath(resourcePath).catch(() => path.resolve(resourcePath));
  return JSON.stringify(['sqlite', adapterKind, target, brainId]);
}

function postgresCoordinationIdentity(connectionString: string, brainId: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(connectionString)) {
    try {
      const url = new URL(connectionString);
      // Keep the role in the internal identity. PostgreSQL defaults the
      // database to the role when no path is supplied, and role-specific RLS
      // or `$user` schemas must never share a coordination namespace.
      url.password = '';
      for (const key of [...url.searchParams.keys()]) {
        if (
          ['password', 'passfile', 'sslcert', 'sslkey', 'sslpassword']
            .includes(key.toLowerCase())
        ) {
          url.searchParams.delete(key);
        }
      }
      url.searchParams.sort();
      return JSON.stringify(['postgres', url.toString(), brainId]);
    } catch {
      // Fall through to credential stripping for malformed or keyword input.
    }
  }

  const credentialKey = '(?:password|passfile|sslcert|sslkey|sslpassword)';
  const withoutCredentials = connectionString
    .replace(/^([a-z][a-z0-9+.-]*:\/\/[^:@/]+):[^@/]*@/i, '$1@')
    .replace(new RegExp(`\\b${credentialKey}\\s*=\\s*'(?:''|\\\\'|[^'])*'`, 'gi'), '')
    .replace(new RegExp(`\\b${credentialKey}\\s*=\\s*"(?:""|\\\\"|[^"])*"`, 'gi'), '')
    .replace(new RegExp(`\\b${credentialKey}\\s*=\\s*[^\\s'"]+`, 'gi'), '')
    .trim();
  return JSON.stringify(['postgres', withoutCredentials, brainId]);
}

// redactPostgresPassword extracted to ./postgresPasswordRedaction.ts
// (handles both URL form and keyword form; see postgresPasswordRedaction.test.ts).

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// SCHEMA_VERSION moved to migrations/index.ts as LATEST_SCHEMA_VERSION
// (derived from the highest registered migration, so adding v2-to-v3.ts
// auto-bumps the seed value).

// ---------------------------------------------------------------------------
// DDL — full schema
// ---------------------------------------------------------------------------

/**
 * Brain metadata key-value store.
 * Used for versioning, agent identity, and embedding configuration.
 */
const DDL_BRAIN_META = `
CREATE TABLE IF NOT EXISTS brain_meta (
  brain_id TEXT NOT NULL,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (brain_id, key)
);
`;

/**
 * Core memory trace table (Tulving's unified trace model).
 *
 * Column notes:
 * - `embedding` is a raw BLOB (Float32Array serialised as little-endian bytes).
 * - `strength` is the Ebbinghaus retrievability R ∈ [0, 1].
 * - `tags` / `emotions` / `metadata` are JSON TEXT columns.
 * - `deleted` is a soft-delete flag (0 = active, 1 = tombstoned).
 */
const DDL_MEMORY_TRACES = `
CREATE TABLE IF NOT EXISTS memory_traces (
  brain_id        TEXT    NOT NULL,
  id              TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  scope           TEXT    NOT NULL,
  content         TEXT    NOT NULL,
  embedding       BLOB,
  strength        REAL    NOT NULL DEFAULT 1.0,
  created_at      INTEGER NOT NULL,
  last_accessed   INTEGER,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  tags            TEXT    NOT NULL DEFAULT '[]',
  emotions        TEXT    NOT NULL DEFAULT '{}',
  metadata        TEXT    NOT NULL DEFAULT '{}',
  deleted         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (brain_id, id)
);

CREATE INDEX IF NOT EXISTS idx_memory_traces_brain_type
  ON memory_traces (brain_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_traces_brain_scope
  ON memory_traces (brain_id, scope);
`;

// FTS index DDL is now generated dynamically by features.fts.createIndex()
// to support both SQLite FTS5 and Postgres tsvector/GIN.

/**
 * Knowledge graph nodes (semantic network).
 * Each node represents a real-world entity or concept the agent has learned about.
 *
 * `properties` is a JSON TEXT column holding arbitrary typed attributes.
 * `source` is a JSON TEXT provenance reference.
 * `confidence` ∈ [0, 1] — certainty of this node's existence / accuracy.
 */
const DDL_KNOWLEDGE_NODES = `
CREATE TABLE IF NOT EXISTS knowledge_nodes (
  brain_id   TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  label      TEXT    NOT NULL,
  properties TEXT    NOT NULL DEFAULT '{}',
  embedding  BLOB,
  confidence REAL    NOT NULL DEFAULT 1.0,
  source     TEXT    NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (brain_id, id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_brain_type
  ON knowledge_nodes (brain_id, type);
`;

/**
 * Knowledge graph edges (typed relationships).
 * Models semantic links between knowledge nodes (e.g. IS_A, HAS_PART, CAUSED_BY).
 *
 * `bidirectional = 1` means the edge applies in both directions (e.g. SIBLING_OF).
 * `weight` ∈ [0, 1] represents relationship strength / confidence.
 */
const DDL_KNOWLEDGE_EDGES = `
CREATE TABLE IF NOT EXISTS knowledge_edges (
  brain_id      TEXT    NOT NULL,
  id            TEXT    NOT NULL,
  source_id     TEXT    NOT NULL,
  target_id     TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  weight        REAL    NOT NULL DEFAULT 1.0,
  bidirectional INTEGER NOT NULL DEFAULT 0,
  metadata      TEXT    NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (brain_id, id),
  FOREIGN KEY (brain_id, source_id) REFERENCES knowledge_nodes(brain_id, id),
  FOREIGN KEY (brain_id, target_id) REFERENCES knowledge_nodes(brain_id, id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_edges_brain_source
  ON knowledge_edges (brain_id, source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_brain_target
  ON knowledge_edges (brain_id, target_id);
`;

/**
 * Ingested document registry.
 *
 * Tracks every external document (PDF, Markdown, web page, etc.) that has
 * been chunked and embedded into this agent's brain.
 *
 * `content_hash` enables idempotent re-ingestion (skip if unchanged).
 */
const DDL_DOCUMENTS = `
CREATE TABLE IF NOT EXISTS documents (
  brain_id     TEXT    NOT NULL,
  id           TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  format       TEXT    NOT NULL,
  title        TEXT,
  content_hash TEXT    NOT NULL,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  metadata     TEXT    NOT NULL DEFAULT '{}',
  ingested_at  INTEGER NOT NULL,
  PRIMARY KEY (brain_id, id)
);
`;

/**
 * Document chunk table.
 *
 * Each chunk corresponds to a contiguous passage of text extracted from a
 * parent document. `trace_id` links to the corresponding memory trace so
 * retrieval pipelines can cross-reference vector search results.
 */
const DDL_DOCUMENT_CHUNKS = `
CREATE TABLE IF NOT EXISTS document_chunks (
  brain_id     TEXT    NOT NULL,
  id           TEXT    NOT NULL,
  document_id  TEXT    NOT NULL,
  trace_id     TEXT,
  content      TEXT    NOT NULL,
  chunk_index  INTEGER NOT NULL,
  page_number  INTEGER,
  embedding    BLOB,
  PRIMARY KEY (brain_id, id),
  FOREIGN KEY (brain_id, document_id) REFERENCES documents(brain_id, id),
  FOREIGN KEY (brain_id, trace_id) REFERENCES memory_traces(brain_id, id)
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_brain_document
  ON document_chunks (brain_id, document_id, chunk_index);
`;

/**
 * Document image table.
 *
 * Stores visual assets extracted from documents (e.g. figures, diagrams).
 * `caption` and `embedding` support multimodal retrieval.
 */
const DDL_DOCUMENT_IMAGES = `
CREATE TABLE IF NOT EXISTS document_images (
  brain_id    TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  document_id TEXT    NOT NULL,
  chunk_id    TEXT,
  data        BLOB    NOT NULL,
  mime_type   TEXT    NOT NULL,
  caption     TEXT,
  page_number INTEGER,
  embedding   BLOB,
  PRIMARY KEY (brain_id, id),
  FOREIGN KEY (brain_id, document_id) REFERENCES documents(brain_id, id),
  FOREIGN KEY (brain_id, chunk_id) REFERENCES document_chunks(brain_id, id)
);
`;

/**
 * Consolidation log.
 *
 * Records each offline consolidation run — the analogue of slow-wave sleep
 * memory consolidation. Tracks how many traces were pruned, merged, derived
 * (by inference), or compacted (losslessly compressed).
 */
const DDL_CONSOLIDATION_LOG = `
CREATE TABLE IF NOT EXISTS consolidation_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  brain_id    TEXT    NOT NULL,
  ran_at      INTEGER NOT NULL,
  pruned      INTEGER NOT NULL DEFAULT 0,
  merged      INTEGER NOT NULL DEFAULT 0,
  derived     INTEGER NOT NULL DEFAULT 0,
  compacted   INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_consolidation_log_brain_time
  ON consolidation_log (brain_id, ran_at DESC);
`;

/**
 * Retrieval feedback signals.
 *
 * Captures explicit (thumbs up/down) or implicit (click, dwell time, follow-up)
 * feedback on retrieved memory traces. Used by the spaced-repetition scheduler
 * to modulate `strength` and `stability` updates (Hebbian reinforcement).
 *
 * `signal` examples: 'positive', 'negative', 'neutral', 'implicit_positive'.
 */
const DDL_RETRIEVAL_FEEDBACK = `
CREATE TABLE IF NOT EXISTS retrieval_feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  brain_id   TEXT    NOT NULL,
  trace_id   TEXT    NOT NULL,
  signal     TEXT    NOT NULL,
  query      TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (brain_id, trace_id) REFERENCES memory_traces(brain_id, id)
);

CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_brain_trace
  ON retrieval_feedback (brain_id, trace_id, created_at DESC);
`;

/**
 * Conversation sessions.
 *
 * Provides a lightweight conversational buffer independent of external message
 * stores. Primarily used for episodic memory encoding (conversation → trace).
 */
const DDL_CONVERSATIONS = `
CREATE TABLE IF NOT EXISTS conversations (
  brain_id   TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  title      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata   TEXT    NOT NULL DEFAULT '{}',
  PRIMARY KEY (brain_id, id)
);
`;

/**
 * Conversation messages.
 *
 * Each message belongs to a conversation. `role` follows the OpenAI convention:
 * 'user' | 'assistant' | 'system' | 'tool'.
 */
const DDL_MESSAGES = `
CREATE TABLE IF NOT EXISTS messages (
  brain_id        TEXT    NOT NULL,
  id              TEXT    NOT NULL,
  conversation_id TEXT    NOT NULL,
  role            TEXT    NOT NULL,
  content         TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  metadata        TEXT    NOT NULL DEFAULT '{}',
  PRIMARY KEY (brain_id, id),
  FOREIGN KEY (brain_id, conversation_id) REFERENCES conversations(brain_id, id)
);

CREATE INDEX IF NOT EXISTS idx_messages_brain_conversation
  ON messages (brain_id, conversation_id, created_at);
`;

/**
 * Prospective memory items table.
 *
 * Stores time-based, event-based, and context-based reminders/intentions
 * that the ProspectiveMemoryManager checks each turn. Items are registered
 * automatically from commitment and intention observation notes.
 *
 * `trigger_type` determines how the item fires:
 * - 'time_based': fires at or after `trigger_at` timestamp
 * - 'event_based': fires when `trigger_event` name occurs
 * - 'context_based': fires when embedding similarity to `cue_embedding` exceeds threshold
 */
const DDL_PROSPECTIVE_ITEMS = `
CREATE TABLE IF NOT EXISTS prospective_items (
  brain_id             TEXT    NOT NULL,
  id                   TEXT    NOT NULL,
  content              TEXT    NOT NULL,
  trigger_type         TEXT    NOT NULL,
  trigger_at           INTEGER,
  trigger_event        TEXT,
  cue_text             TEXT,
  cue_embedding        BLOB,
  similarity_threshold REAL    DEFAULT 0.7,
  importance           REAL    NOT NULL DEFAULT 0.5,
  triggered            INTEGER NOT NULL DEFAULT 0,
  recurring            INTEGER NOT NULL DEFAULT 0,
  source_trace_id      TEXT,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (brain_id, id)
);
`;

// ---------------------------------------------------------------------------
// Brain
// ---------------------------------------------------------------------------

/**
 * Unified cross-platform connection manager for a single agent's persistent brain.
 *
 * Uses the `StorageAdapter` interface from `@framers/sql-storage-adapter` to
 * support multiple backends (better-sqlite3, sql.js, IndexedDB, Postgres, etc.)
 * transparently. All methods are async.
 *
 * **Usage:**
 * ```ts
 * const brain = await Brain.open('/path/to/agent/brain.sqlite');
 *
 * // Async query API for subsystems
 * const row = await brain.get<{ value: string }>('SELECT value FROM brain_meta WHERE key = ?', ['schema_version']);
 *
 * // Meta helpers
 * await brain.setMeta('last_sync', Date.now().toString());
 * const ver = await brain.getMeta('schema_version'); // '1'
 *
 * await brain.close();
 * ```
 *
 * Subsystems (KnowledgeGraph, MemoryGraph, ConsolidationLoop, etc.)
 * receive the `Brain` instance and call its async proxy methods
 * (`run`, `get`, `all`, `exec`, `transaction`) for all database operations.
 */
export class Brain {
  /**
   * The cross-platform storage adapter backing this brain.
   * Not exposed publicly — consumers use the async proxy methods instead.
   */
  private readonly _adapter: StorageAdapter;

  /**
   * Platform-aware feature bundle (dialect, FTS, BLOB codec, exporter).
   * Created by `createStorageFeatures(adapter)` during `open()`.
   */
  private readonly _features: StorageFeatures;

  /**
   * Brain identifier used to scope every brain-owned table row.
   *
   * In SQLite per-file mode, defaults to the file basename (or `'default'`
   * for `:memory:`); subsystems pass it through to the `brain_id` column
   * on every INSERT/UPDATE and into every WHERE clause on SELECT.
   *
   * In Postgres mode (multi-tenant), this is required and must be unique
   * per brain across the database.
   */
  readonly #brainId: string;

  /**
   * Opaque process-local key for coordinating operations that target the
   * same durable storage resource. It intentionally contains no path or
   * connection-string material.
   */
  readonly #coordinationToken: object;

  // ---------------------------------------------------------------------------
  // Constructor (private — use Brain.open())
  // ---------------------------------------------------------------------------

  /**
   * Private constructor — use `Brain.open(dbPath)` instead.
   *
   * @param adapter  - A fully initialised StorageAdapter instance.
   * @param features - Platform-aware feature bundle.
   * @param brainId  - Brain identifier used to scope multi-tenant queries.
   * @param coordinationToken - Opaque identity of the backing store and brain.
   */
  private constructor(
    adapter: StorageAdapter,
    features: StorageFeatures,
    brainId: string,
    coordinationToken: object,
  ) {
    this._adapter = adapter;
    this._features = features;
    this.#brainId = brainId;
    this.#coordinationToken = coordinationToken;
  }

  /**
   * Brain identifier scoping every query through this Brain instance.
   * Subsystems (KnowledgeGraph, MemoryGraph, ConsolidationLoop) read this
   * to inject `brain_id` into their own SQL.
   */
  get brainId(): string {
    return this.#brainId;
  }

  /**
   * Opaque identity used to serialize same-process operations across
   * separate Brain handles that address the same backing store.
   */
  get coordinationToken(): object {
    return this.#coordinationToken;
  }

  // ---------------------------------------------------------------------------
  // Async factories (three named entry points)
  //
  // Naming convention:
  //   - openSqlite / openPostgres: factory by-DIALECT. The caller specifies
  //     "I want a SQLite-backed brain at this file" or "I want a Postgres-
  //     backed brain at this URL." The adapter is constructed internally.
  //   - openWithAdapter: factory by-PRE-BUILT-ADAPTER. The caller has already
  //     built the StorageAdapter (e.g., to share a connection pool with
  //     another subsystem) and hands it to Brain to consume.
  //
  // The naming asymmetry is intentional: the first two are dialect-specific
  // entry points; the third is the escape hatch for advanced cases where the
  // adapter is owned outside the Brain.
  // ---------------------------------------------------------------------------

  /**
   * Open a Brain backed by SQLite. Tries adapters in order:
   * better-sqlite3 (Node native) -> sql.js (WASM) -> indexeddb (browser).
   *
   * @param dbPath - File path. Use `:memory:` for in-process testing.
   * @param opts.brainId - Optional explicit brainId; defaults to file basename
   *   (or `'default'` for `:memory:`).
   * @param opts.priority - Override the default adapter priority.
   * @param opts.coordinationToken - Optional process-local identity for
   *   non-filesystem adapters whose resource name is adapter-specific.
   * @returns A fully initialised `Brain` instance with the v2 schema.
   */
  static async openSqlite(
    dbPath: string,
    opts: {
      brainId?: string;
      priority?: ('better-sqlite3' | 'sqljs' | 'indexeddb')[];
      coordinationToken?: object;
    } = {},
  ): Promise<Brain> {
    const adapter = await resolveStorageAdapter({
      filePath: dbPath,
      priority: opts.priority ?? ['better-sqlite3', 'sqljs', 'indexeddb'],
      quiet: true,
    });
    const brainId = opts.brainId ?? deriveBrainIdFromPath(dbPath, adapter.kind);
    const usesFileIdentity =
      adapter.kind === 'better-sqlite3' ||
      (adapter.kind === 'sqljs' && adapter.capabilities.has('persistence'));
    const identity = usesFileIdentity && dbPath !== ':memory:'
      ? await sqliteCoordinationIdentity(dbPath, brainId, adapter.kind)
      : null;
    const coordinationToken =
      opts.coordinationToken ??
      (identity
        ? internCoordinationToken(identity)
        : coordinationTokenForAdapter(adapter, brainId));
    rememberAdapterCoordinationToken(adapter, brainId, coordinationToken);
    return Brain._initialize(adapter, brainId, coordinationToken);
  }

  /**
   * Open a Brain backed by PostgreSQL. Requires the `pg` npm package and
   * a reachable Postgres instance.
   *
   * @param connectionString - Standard Postgres connection URL.
   * @param opts.brainId - REQUIRED. Used to scope every query so multiple
   *   brains can share one Postgres database without leaking rows.
   * @param opts.poolSize - pg connection pool size. Defaults to 10.
   */
  static async openPostgres(
    connectionString: string,
    opts: { brainId: string; poolSize?: number },
  ): Promise<Brain> {
    if (!opts.brainId) {
      throw new Error('Brain.openPostgres: opts.brainId is required (Postgres mode is multi-tenant)');
    }
    // Use createPostgresAdapter directly so we can pass pool size; the
    // resolveStorageAdapter facade only forwards `connectionString`.
    let adapter: StorageAdapter;
    try {
      adapter = await createPostgresAdapter({
        connectionString,
        max: opts.poolSize ?? 10,
      });
      await adapter.open();
    } catch (err) {
      const safe = redactPostgresPassword(connectionString);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Brain.openPostgres: connection failed for ${safe}: ${msg}`);
    }
    const coordinationToken = internCoordinationToken(
      postgresCoordinationIdentity(connectionString, opts.brainId),
    );
    rememberAdapterCoordinationToken(adapter, opts.brainId, coordinationToken);
    return Brain._initialize(adapter, opts.brainId, coordinationToken);
  }

  /**
   * Open a Brain with a pre-resolved StorageAdapter. Use when sharing an
   * adapter across subsystems (e.g., wilds-ai foundation pool + brain) or
   * when the consumer needs full control over adapter resolution.
   *
   * **CONCURRENCY CAVEAT (Postgres adapters):** the underlying
   * `PostgresAdapter` tracks `transactionalClient` as instance-shared
   * mutable state. Two concurrent `Brain.transaction(...)` calls on the
   * same shared adapter (or any subsystem call that internally opens a
   * transaction) will overwrite each other's connection assignment, which
   * corrupts both transactions silently. If the consumer dispatches
   * concurrent writes through subsystems sharing one adapter, either:
   *   1. construct a fresh `PostgresAdapter` per logical actor, OR
   *   2. serialize transactions at the consumer layer until the adapter
   *      gets `AsyncLocalStorage`-tracked transactional clients.
   * Non-transactional concurrent reads/writes against a shared adapter
   * are safe (the pool handles those correctly).
   *
   * @param adapter - Pre-built StorageAdapter instance.
   * @param opts.brainId - Required for postgres-kind adapters; optional for
   *   sqlite-kind adapters (defaults to `'default'`).
   * @param opts.coordinationToken - Optional shared opaque token for separate
   *   adapter objects that address the same backing database and brain.
   */
  static async openWithAdapter(
    adapter: StorageAdapter,
    opts: { brainId?: string; coordinationToken?: object } = {},
  ): Promise<Brain> {
    const isPostgres = adapter.kind.includes('postgres');
    if (isPostgres && !opts.brainId) {
      throw new Error(
        'Brain.openWithAdapter: opts.brainId is required for postgres-kind adapters',
      );
    }
    const brainId = opts.brainId ?? 'default';
    const remembered = rememberedAdapterCoordinationToken(adapter, brainId);
    if (
      opts.coordinationToken &&
      remembered &&
      remembered !== opts.coordinationToken
    ) {
      throw new Error(
        'Brain.openWithAdapter: coordinationToken conflicts with the token already ' +
          'registered for this adapter and brainId',
      );
    }
    const coordinationToken =
      opts.coordinationToken ?? remembered ?? coordinationTokenForAdapter(adapter, brainId);
    rememberAdapterCoordinationToken(adapter, brainId, coordinationToken);
    return Brain._initialize(adapter, brainId, coordinationToken);
  }

  /**
   * Internal common initialization path used by all three factories.
   *
   * Sequence:
   * 1. Build platform-aware feature bundle.
   * 2. Set WAL mode (dialect.pragma returns null on Postgres).
   * 3. Enable foreign key enforcement (dialect.pragma returns null on Postgres).
   * 4. Auto-migrate v1 schemas to v2 (idempotent; no-op for fresh DBs and v2).
   * 5. Apply full DDL via _initSchema().
   * 6. Seed brain_meta defaults.
   */
  private static async _initialize(
    adapter: StorageAdapter,
    brainId: string,
    coordinationToken: object,
  ): Promise<Brain> {
    const features = createStorageFeatures(adapter);
    const brain = new Brain(adapter, features, brainId, coordinationToken);

    const walPragma = features.dialect.pragma('journal_mode', 'WAL');
    if (walPragma) await adapter.exec(walPragma);

    const fkPragma = features.dialect.pragma('foreign_keys', 'ON');
    if (fkPragma) await adapter.exec(fkPragma);

    await MigrationRunner.runPending(adapter, features, brainId, MIGRATIONS);
    await brain._initSchema();
    await brain._seedMeta();

    return brain;
  }

  // ---------------------------------------------------------------------------
  // Async proxy methods (for consumer subsystems)
  // ---------------------------------------------------------------------------

  /**
   * Execute a mutation statement (INSERT, UPDATE, DELETE).
   *
   * @param sql    - SQL statement with `?` positional placeholders.
   * @param params - Parameter array matching the placeholders.
   * @returns Metadata about affected rows.
   */
  async run(sql: string, params?: StorageParameters): Promise<StorageRunResult> {
    return this._adapter.run(sql, params);
  }

  /**
   * Retrieve a single row (or null if none found).
   *
   * @param sql    - SQL SELECT statement.
   * @param params - Parameter array.
   * @returns First matching row or null.
   */
  async get<T = unknown>(sql: string, params?: StorageParameters): Promise<T | null> {
    return this._adapter.get<T>(sql, params);
  }

  /**
   * Retrieve all rows matching the statement.
   *
   * @param sql    - SQL SELECT statement.
   * @param params - Parameter array.
   * @returns Array of matching rows (empty array if none).
   */
  async all<T = unknown>(sql: string, params?: StorageParameters): Promise<T[]> {
    return this._adapter.all<T>(sql, params);
  }

  /**
   * Execute a script containing multiple SQL statements.
   *
   * @param sql - SQL script (semicolon-delimited statements).
   */
  async exec(sql: string): Promise<void> {
    return this._adapter.exec(sql);
  }

  /**
   * Execute a callback within a database transaction.
   *
   * The transaction is automatically committed on success or rolled back
   * on error.
   *
   * @param fn - Async callback receiving a transactional adapter.
   * @returns Result of the callback.
   */
  async transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    return this._adapter.transaction(fn);
  }

  /**
   * Expose the raw storage adapter for advanced usage.
   *
   * Primarily used by SqliteExporter (VACUUM INTO) and SqliteImporter
   * (which needs direct adapter access for the target brain).
   */
  get adapter(): StorageAdapter {
    return this._adapter;
  }

  /**
   * Platform-aware feature bundle (dialect, FTS, BLOB codec, exporter).
   * Consumers use this to generate cross-platform SQL instead of hardcoding
   * SQLite-specific syntax.
   */
  get features(): StorageFeatures {
    return this._features;
  }

  // ---------------------------------------------------------------------------
  // Private init helpers
  // ---------------------------------------------------------------------------

  /**
   * Execute idempotent DDL statements to initialize the schema.
   * `CREATE TABLE IF NOT EXISTS` is safe to re-run, so a sequential setup path
   * is sufficient and avoids adapter-specific transaction quirks during DDL.
   */
  private async _initSchema(): Promise<void> {
    const ddlStatements = [
      DDL_BRAIN_META,
      DDL_MEMORY_TRACES,
      DDL_KNOWLEDGE_NODES,
      DDL_KNOWLEDGE_EDGES,
      DDL_DOCUMENTS,
      DDL_DOCUMENT_CHUNKS,
      DDL_DOCUMENT_IMAGES,
      DDL_CONSOLIDATION_LOG,
      DDL_RETRIEVAL_FEEDBACK,
      DDL_CONVERSATIONS,
      DDL_MESSAGES,
      DDL_PROSPECTIVE_ITEMS,
      // Memory archive tables (write-ahead cold storage for verbatim content)
      DDL_ARCHIVED_TRACES,
      DDL_ARCHIVED_TRACES_IDX_AGENT_TIME,
      DDL_ARCHIVED_TRACES_IDX_REASON,
      DDL_ARCHIVE_ACCESS_LOG,
      DDL_ARCHIVE_ACCESS_LOG_IDX,
    ];

    for (const statement of ddlStatements) {
      await this._adapter.exec(this._normalizeDdlForDialect(statement));
    }

    // FTS index via feature abstraction (FTS5 on SQLite, tsvector/GIN on Postgres).
    // SQL.js builds may not include FTS5, so keep the core schema independent.
    const ftsDdl = this._features.fts.createIndex({
      table: 'memory_traces_fts',
      columns: ['content', 'tags'],
      contentTable: 'memory_traces',
      tokenizer: 'porter ascii',
    });
    try {
      await this._adapter.exec(ftsDdl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('no such module: fts5')) {
        throw error;
      }
    }
  }

  private _normalizeDdlForDialect(statement: string): string {
    if (this._features.dialect.name !== 'postgres') {
      return statement;
    }

    return statement
      .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/g, this._features.dialect.autoIncrementPrimaryKey())
      // SQLite stores every INTEGER as a 64-bit value, but Postgres INTEGER is int4
      // (max 2_147_483_647). Millisecond-epoch columns (`created_at`, `last_accessed`,
      // `ingested_at`, `trigger_at`, ...) hold Date.now() values (~1.78e12) that overflow
      // int4 with `value out of range for type integer` (pg_strtoint32). Map every
      // remaining INTEGER to BIGINT so Postgres matches SQLite's integer width. Runs after
      // the AUTOINCREMENT rewrite, so identity columns become `BIGINT GENERATED ALWAYS AS
      // IDENTITY` (valid, and consistent with the 64-bit surrogate keys SQLite produces).
      .replace(/\bINTEGER\b/g, 'BIGINT')
      .replace(/\bBLOB\b/g, 'BYTEA');
  }

  /**
   * Seed `brain_meta` with mandatory keys on first creation.
   * Uses INSERT OR IGNORE to be idempotent on subsequent opens.
   */
  private async _seedMeta(): Promise<void> {
    const { dialect } = this._features;
    // INSERT OR IGNORE is idempotent — no transaction needed.
    // Avoids sql.js "cannot rollback" errors when DDL from _initSchema()
    // leaves the connection in an implicit-commit state.
    await this._adapter.run(
      dialect.insertOrIgnore('brain_meta', ['brain_id', 'key', 'value'], ['?', '?', '?']),
      [this.#brainId, 'schema_version', String(LATEST_SCHEMA_VERSION)],
    );
    await this._adapter.run(
      dialect.insertOrIgnore('brain_meta', ['brain_id', 'key', 'value'], ['?', '?', '?']),
      [this.#brainId, 'created_at', Date.now().toString()],
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Read a value from the `brain_meta` key-value store.
   *
   * @param key - The metadata key to look up.
   * @returns The stored string value, or `undefined` if the key does not exist.
   */
  async getMeta(key: string): Promise<string | undefined> {
    const row = await this._adapter.get<{ value: string }>(
      'SELECT value FROM brain_meta WHERE brain_id = ? AND key = ?',
      [this.#brainId, key],
    );

    return row?.value;
  }

  /**
   * Upsert a value into the `brain_meta` key-value store.
   *
   * Uses `INSERT OR REPLACE` semantics — creates the row if absent, or
   * overwrites if present.
   *
   * @param key   - The metadata key.
   * @param value - The string value to store.
   */
  async setMeta(key: string, value: string): Promise<void> {
    await this._adapter.run(
      this._features.dialect.insertOrReplace(
        'brain_meta',
        ['brain_id', 'key', 'value'],
        ['?', '?', '?'],
        'brain_id, key',
      ),
      [this.#brainId, key, value],
    );
  }

  /**
   * Check whether a given embedding dimension is compatible with this brain.
   *
   * On first call (no stored `embedding_dimensions`), returns `true` and stores
   * the provided dimension for future compatibility checks.
   *
   * Subsequent calls compare `dimensions` against the stored value.
   * Mismatches indicate that a different embedding model was used to encode
   * memories — mixing dimensions would corrupt vector similarity searches.
   *
   * @param dimensions - The embedding vector length to check (e.g. 1536 for OpenAI ada-002).
   * @returns `true` if compatible (or no prior value), `false` on mismatch.
   */
  async checkEmbeddingCompat(dimensions: number): Promise<boolean> {
    const stored = await this.getMeta('embedding_dimensions');

    if (stored === undefined) {
      // First embedding model encounter — store and accept.
      await this.setMeta('embedding_dimensions', String(dimensions));
      return true;
    }

    return parseInt(stored, 10) === dimensions;
  }

  // ---------------------------------------------------------------------------
  // Portable artifact: export to / import from a SQLite snapshot
  // ---------------------------------------------------------------------------

  /**
   * Materialize this brain to a portable SQLite file at `targetPath`.
   *
   * Source can be any backend (SQLite, Postgres, Capacitor, etc.); output
   * is always a fresh SQLite file. Used by `.wildsoul`-style export and
   * other portability flows.
   *
   * Refuses to overwrite an existing file at `targetPath` so callers do
   * not silently lose data.
   *
   * Forking semantics: rows are emitted with the source brainId. Importing
   * the resulting file under a different brainId produces a fork.
   *
   * @param targetPath - Destination file path. File must not exist.
   * @returns Bytes written to the destination file.
   */
  async exportToSqlite(targetPath: string): Promise<{ bytesWritten: number }> {
    // Refuse to overwrite an existing file.
    try {
      await fs.access(targetPath);
      throw new Error(`Brain.exportToSqlite: target already exists: ${targetPath}`);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // Re-throw the "already exists" error and any other access error
        // that isn't a missing-file response.
        throw err;
      }
    }

    // Open a fresh SQLite Brain at the target path. We import under the
    // source brainId so the export file is identifiable as belonging to
    // this brain even if the receiving Brain has a different id.
    const target = await Brain.openSqlite(targetPath, { brainId: this.#brainId });
    try {
      for (const table of PORTABLE_TABLES) {
        const rows = await this.all<Record<string, unknown>>(
          `SELECT * FROM ${table} WHERE brain_id = ?`,
          [this.#brainId],
        );
        if (rows.length === 0) continue;

        // Upsert so source rows override the brain_meta defaults
        // (schema_version, created_at) seeded during target initialisation.
        await this._bulkCopy(target, table, rows, this.#brainId, { upsert: true });
      }
    } finally {
      await target.close();
    }

    const stat = await fs.stat(targetPath);
    return { bytesWritten: stat.size };
  }

  /**
   * Load a portable SQLite file into this Brain's adapter.
   *
   * Forking semantics: rows from the source file are written under the
   * RECEIVING brain's `brainId`, not the brainId stored in the source
   * file. This means importing an `alice` snapshot into a Brain opened
   * with `brainId: 'alice-fork'` produces a fork with no shared identity.
   *
   * **CAVEAT:** importing from a pre-0.3.0 SQLite file MUTATES the source
   * file. Opening the source via `Brain.openSqlite` runs the v1 to v2
   * migration in place. To preserve the source unchanged, copy the file to
   * a temp path before calling this method.
   *
   * @param sourcePath - Source SQLite file path (typically produced by
   *   `Brain.exportToSqlite`).
   * @param opts.strategy - `'merge'` (default) upserts on PK collision;
   *   `'replace'` wipes all rows for the receiving `brainId` first.
   * @returns Counts of rows imported per table.
   */
  async importFromSqlite(
    sourcePath: string,
    opts: { strategy?: 'merge' | 'replace' } = {},
  ): Promise<{ tablesImported: Record<string, number> }> {
    const strategy = opts.strategy ?? 'merge';

    // Peek at the source's brain_meta BEFORE opening it as a Brain. Opening
    // via Brain.openSqlite without a brainId would derive one from the file
    // path and pollute brain_meta with that synthetic id (via _seedMeta),
    // breaking the single-brain check below. We use a raw adapter for the
    // peek so we don't trigger any seeding.
    const peekAdapter = await resolveStorageAdapter({
      filePath: sourcePath,
      priority: ['better-sqlite3', 'sqljs'],
      quiet: true,
    });
    let sourceBrainIds: { brain_id: string }[] = [];
    try {
      // Check brain_meta has the brain_id column before querying it. v1
      // schemas (pre-0.3.0) only have key/value columns; the SELECT would
      // throw "no such column: brain_id" otherwise. When the column is
      // missing, treat as a single-brain v1 source (the auto-migration on
      // Brain.openSqlite below will add brain_id and namespace by the
      // path-derived brainId, then importFromSqlite proceeds normally).
      const cols = await peekAdapter.all<{ name: string }>(
        `PRAGMA table_info(brain_meta)`,
      );
      const hasBrainIdColumn = cols.some((c) => c.name === 'brain_id');
      if (hasBrainIdColumn) {
        sourceBrainIds = await peekAdapter.all<{ brain_id: string }>(
          `SELECT DISTINCT brain_id FROM brain_meta WHERE brain_id IS NOT NULL`,
        );
      }
    } finally {
      await peekAdapter.close();
    }

    if (sourceBrainIds.length > 1) {
      const ids = sourceBrainIds.map((r) => r.brain_id).join(', ');
      throw new Error(
        `Brain.importFromSqlite: source contains multiple brain_ids (${ids}). ` +
          `Imports must be from a single-brain export (use Brain.exportToSqlite).`,
      );
    }

    // Open the source as a Brain with the peeked brainId (if any) to avoid
    // _seedMeta polluting brain_meta with a path-derived id.
    const sourceBrainId = sourceBrainIds[0]?.brain_id;
    const source = sourceBrainId
      ? await Brain.openSqlite(sourcePath, { brainId: sourceBrainId })
      : await Brain.openSqlite(sourcePath);
    const tablesImported: Record<string, number> = {};

    try {
      if (strategy === 'replace') {
        // Wipe existing rows for the receiving brainId in every portable table.
        // Order matters: child tables before parent tables to satisfy FKs.
        for (const table of [...PORTABLE_TABLES].reverse()) {
          await this.run(
            `DELETE FROM ${table} WHERE brain_id = ?`,
            [this.#brainId],
          );
        }
      }

      for (const table of PORTABLE_TABLES) {
        // Read every row in the source file regardless of its stored brainId
        // so we capture the full snapshot for re-insertion under our brainId.
        const rows = await source.all<Record<string, unknown>>(
          `SELECT * FROM ${table}`,
        );
        tablesImported[table] = rows.length;
        if (rows.length === 0) continue;

        // Always use upsert to gracefully handle the brain_meta rows seeded
        // by `_seedMeta` during the receiving Brain's initialization (which
        // would otherwise collide with the source's schema_version/created_at).
        await this._bulkCopy(this, table, rows, this.#brainId, { upsert: true });
      }
    } finally {
      await source.close();
    }

    return { tablesImported };
  }

  /**
   * Internal helper: bulk-insert `rows` into `target.<table>`, rewriting
   * `brain_id` on each row to `targetBrainId`. When `opts.upsert` is true,
   * uses `dialect.insertOrReplace` so PK collisions overwrite (idempotent).
   */
  private async _bulkCopy(
    target: Brain,
    table: string,
    rows: Record<string, unknown>[],
    targetBrainId: string,
    opts: { upsert?: boolean } = {},
  ): Promise<void> {
    if (rows.length === 0) return;

    // Postgres FTS (PostgresFts) adds a `_tsv` tsvector shadow column to the content
    // table via `ALTER TABLE ... ADD COLUMN _tsv`. SQLite has no such column (it uses a
    // separate FTS5 virtual table), and the value is regenerated from source columns by
    // the receiving Brain's own FTS index — so it must never cross backends. Copying it
    // verbatim fails with "table memory_traces has no column named _tsv" on a
    // Postgres -> SQLite export. Strip it from the portable column set in both directions.
    const columns = Object.keys(rows[0]!).filter((c) => c !== '_tsv');
    const placeholders = columns.map(() => '?').join(', ');
    const colList = columns.join(', ');

    const stmt = opts.upsert
      ? target._features.dialect.insertOrReplace(
          table,
          columns,
          columns.map(() => '?'),
          PORTABLE_TABLE_PRIMARY_KEYS[table] ?? 'brain_id, id',
        )
      : `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`;

    // Single transaction per table for bulk-insert performance + atomicity.
    // MUST use adapter.transaction() (not raw exec BEGIN/COMMIT) so all writes
    // pin to one pooled connection on Postgres. Raw BEGIN against a pool
    // connection would land each query on a different connection, breaking
    // the transactional guarantee silently.
    await target._adapter.transaction(async (trx) => {
      for (const row of rows) {
        const values = columns.map((c) =>
          c === 'brain_id' ? targetBrainId : row[c],
        );
        await trx.run(stmt, values as never[]);
      }
    });
  }

  /**
   * Close the database connection.
   *
   * Must be called when the agent shuts down to flush the WAL and release
   * the file lock. Failing to close may leave the database in WAL mode with
   * an unconsumed WAL file.
   */
  async close(): Promise<void> {
    try {
      await this._adapter.close();
    } catch (err) {
      // Adapter close failures (pool drain timeouts, lock-release races on
      // shutdown) shouldn't propagate to callers who are themselves shutting
      // down and can't usefully react. Log to stderr so CI artifacts capture
      // the failure context if it ever indicates a real problem.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[Brain.close] adapter close failed: ${msg}\n`);
    }
  }
}

// PORTABLE_TABLES + PORTABLE_TABLE_PRIMARY_KEYS moved to ./portable-tables.ts
// (single source of truth shared with v1-to-v2 migration + postgres test cleanup).
