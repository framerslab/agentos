/**
 * @fileoverview Postgres + pgvector Vector Store Implementation.
 * @module rag/vector_stores/PostgresVectorStore
 *
 * Implements `IVectorStore` using Postgres with the pgvector extension
 * for native HNSW-indexed approximate nearest neighbor search. Supports:
 *
 * - Dense vector search via pgvector `<=>` (cosine), `<->` (L2), `<#>` (inner product)
 * - Full-text search via tsvector + GIN indexes, fused with the dense search or on its own (`lexicalSearch`)
 * - A grouped lexical search over a caller's item lists (`lexicalGroupSearch`): a match that is an item's across
 *   its passages, a count, an explicit rank, a page by a key and a one-edit match drawn from the stored words
 * - Hybrid search combining both with RRF fusion in a single SQL query
 * - JSONB metadata filtering with GIN indexes, array fields included
 * - Connection pooling via pg.Pool, or a pool the caller owns
 * - An open PostgreSQL `StorageAdapter` the caller owns, and a view of the store bound to one of the adapter's
 *   transactions (`withStorageTransaction`), so vector writes commit or roll back with the caller's own
 * - Tables made by the caller's migrations (`manageSchema: false` with `schemaSql()`)
 * - pgvector's iterative index scans for filtered searches
 *
 * Scaling target: 500K → 10M vectors with multi-tenant schema isolation.
 *
 * @see ../../IVectorStore.ts for the interface definition.
 */

import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type {
  IVectorStore,
  VectorStoreProviderConfig,
  VectorDocument,
  RetrievedVectorDocument,
  QueryOptions,
  QueryResult,
  MetadataScanOptions,
  MetadataScanResult,
  UpsertOptions,
  UpsertResult,
  DeleteOptions,
  DeleteResult,
  CreateCollectionOptions,
  MetadataFilter,
  MetadataFieldCondition,
  MetadataScalarValue,
  MetadataValue,
  LexicalGroupKey,
  LexicalGroupRow,
  LexicalGroupSearchOptions,
  LexicalGroupSearchResult,
  LexicalMatchKind,
} from '../IVectorStore.js';
import { sha256Hex } from '../../../core/utils/sha256.js';
import {
  LEXICAL_GROUP_EXPANSION_MAX as EXPANSION_MAX,
  LEXICAL_GROUP_WORDS_MAX as GROUP_WORDS_MAX,
  isLexicalGroupExpansion as isExpansion,
  lexicalGroupExpansionRoom as expansionRoom,
  lexicalGroupWordBytes as wordBytes,
  LEXICAL_GROUP_STORED_WORD_BYTES_MAX as STORED_WORD_BYTES_MAX,
  isLexicalGroupInstant as isInstant,
  isLexicalGroupRank as isRank,
  isLexicalGroupSourceId as isSourceId,
} from '../../../core/vector-store/lexicalGroupForms.js';
import { withinOneEdit } from '../search/FuzzyIndex.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The part of pg.Pool the store calls. A caller's own pool satisfies it. */
export interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  connect(): Promise<{
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
    release(): void;
  }>;
  end?(): Promise<void>;
}

/** Configuration specific to the Postgres vector store. */
export interface PostgresVectorStoreConfig extends VectorStoreProviderConfig {
  type: 'postgres';
  /** Postgres connection string. Required unless `pool` or `adapter` is given. */
  connectionString?: string;
  /** A pool the caller owns. The store opens none of its own, and `close()` leaves this one open. */
  pool?: PgPoolLike;
  /**
   * Open PostgreSQL adapter owned by the caller; exclusive with pool/connectionString. The store opens no pool of
   * its own and `close()` leaves the adapter open. With `pool` or `connectionString` as well, `initialize()` throws.
   */
  adapter?: StorageAdapter;
  /** Connection pool size when the store opens its own pool. @default 10 */
  poolSize?: number;
  /** Default embedding dimensions for new collections. @default 1536 */
  defaultDimension?: number;
  /** Default similarity metric. @default 'cosine' */
  similarityMetric?: 'cosine' | 'euclidean' | 'dotproduct';
  /** Table name prefix for multi-tenancy. @default '' */
  tablePrefix?: string;
  /**
   * When false the store runs no DDL: no CREATE EXTENSION, no collections table, and `createCollection()` does
   * nothing. The caller's migrations make the tables from {@link PostgresVectorStore.schemaSql}, and the metric is
   * read from `similarityMetric`. @default true
   */
  manageSchema?: boolean;
  /** Text search configuration of the lexical column and its queries. @default 'english' */
  textSearchConfig?: string;
  /**
   * pgvector's iterative index scan (0.8.0 and later) for `query()` and `hybridSearch()`: the HNSW scan goes on
   * until a filtered search has its rows. Without it pgvector filters after the scan and can return fewer than top-K.
   */
  iterativeScan?: 'strict_order' | 'relaxed_order';
  /** `hnsw.ef_search` for a search (1 to 1000). */
  efSearch?: number;
  /** `hnsw.max_scan_tuples` for an iterative scan. */
  maxScanTuples?: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CollectionMeta {
  name: string;
  dimension: number;
  metric: 'cosine' | 'euclidean' | 'dotproduct';
  documentCount: number;
}

/** A row of the lexical search's statement, as pg reads it. */
interface LexicalRow {
  id: string;
  embedding: string | null;
  metadata_json: Record<string, MetadataValue> | null;
  text_content: string | null;
  score: number;
}

/** The operators of a metadata filter's condition that the store writes into SQL. */
const FILTER_OPERATORS: ReadonlySet<string> = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$all', '$exists', '$contains', '$textSearch',
]);

/** The bytes Postgres keeps of a name; it cuts a longer one there. */
const NAME_BYTES = 63;

/** A text's length in bytes of UTF-8. Postgres counts a name in bytes of the database's encoding, taken here to be UTF-8. */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A name cut to at most `bytes` bytes, between two characters, the way Postgres cuts a name that is too long. */
function cutToBytes(name: string, bytes: number): string {
  let kept = '';
  let used = 0;
  for (const character of name) {
    used += utf8Bytes(character);
    if (used > bytes) break;
    kept += character;
  }
  return kept;
}

/** The rows a statement answered, or the number of rows it changed. */
interface VectorSqlResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

/** The one call the store's statements go through: a pool's client in a transaction, or an adapter. */
interface VectorSqlExecutor {
  query(sql: string, params?: unknown[]): Promise<VectorSqlResult>;
}

/**
 * The store's statements on a `StorageAdapter`: a read (`SELECT`, `WITH`, or a `FETCH` from a cursor) through `all`,
 * anything else through `run`, whose `changes` is the row count. It runs no transaction command and never opens a
 * `pg` pool. Its SQL comes only from this store, whose `WITH` statements are read queries.
 *
 * @throws When the adapter is not a PostgreSQL adapter with transactions.
 */
function adapterExecutor(adapter: StorageAdapter): VectorSqlExecutor {
  if (adapter.kind !== 'postgres' || !adapter.capabilities.has('transactions')) {
    throw new Error('vector_adapter_requires_postgres_transactions');
  }
  return {
    async query(sql, params = []) {
      if (/^\s*(SELECT|WITH|FETCH)\b/i.test(sql)) {
        const rows = await adapter.all<Record<string, unknown>>(sql, params);
        return { rows, rowCount: rows.length };
      }
      const result = await adapter.run(sql, params);
      return { rows: [], rowCount: result.changes };
    },
  };
}

// ---------------------------------------------------------------------------
// Grouped lexical search
// ---------------------------------------------------------------------------

/** How many stored words one FETCH reads from the cursor over a group's stored words. */
const STORED_WORDS_BATCH = 1000;

/** A word of a grouped search: a letter or a digit, then letters, digits and combining marks, so no part of it is a tsquery operator. */
const GROUP_WORD = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}]*$/u;

/** The kinds of match by the number the grouped search's statement answers. */
const MATCH_KINDS: Record<string, LexicalMatchKind> = { '3': 'same', '2': 'start', '1': 'edit' };

/** Counts the cursors over stored words, so that two of one connection never share a name. */
let storedWordsCursors = 0;

/** A grouped search as its statements read it, each part checked. */
interface GroupSearch {
  words: string[];
  /** The caller's stored words one edit away, from an earlier page; without them the first page reads its own. */
  expansion: string[][] | undefined;
  oneEdit: { minLength: number; max: number } | undefined;
  ids: string[];
  dates: Array<string | null>;
  /** The part kinds that narrow the passages, or null when none does. */
  partKinds: string[] | null;
  fields: Record<string, number>;
  fallback: string;
  /** The field an item's title read from the metadata ranks as, or null when titles are read from passages alone. */
  titleField: string | null;
  order: 'rank' | 'date';
  pageSize: number;
  after: LexicalGroupKey | undefined;
}

/** A row of a grouped search's statement: the count on every row, and an item with its passage unless nothing matched. */
interface GroupSqlRow {
  total: number;
  live?: string | null;
  part?: number | null;
  source_id: string | null;
  rank?: string | null;
  item_kinds?: string | null;
  held_kinds?: string | null;
  field: string | null;
  id: string | null;
  metadata_json: Record<string, MetadataValue> | string | null;
  text_content: string | null;
}

/**
 * The parts of a grouped search, checked. Its values reach the statements as parameters, but for the words, which
 * are written into a tsquery's text and so may hold nothing a tsquery reads as an operator.
 *
 * @throws When a part is not in the form {@link LexicalGroupSearchOptions} gives it.
 */
function groupSearchOf(options: LexicalGroupSearchOptions): GroupSearch {
  const refused = (what: string): Error => new Error(`PostgresVectorStore.lexicalGroupSearch: ${what}.`);
  const whole = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
  const { words, expansion, oneEdit, group, profile, order, pageSize, after } = options;
  if (!Array.isArray(words) || words.length > GROUP_WORDS_MAX || words.some((word) => typeof word !== 'string' || !GROUP_WORD.test(word))) {
    throw refused(`the words must be at most ${GROUP_WORDS_MAX}, each a letter or a digit followed by letters, digits and combining marks`);
  }
  if (new Set(words).size !== words.length) throw refused('a word is given twice');
  if (expansion !== undefined && !isExpansion(expansion, words)) {
    throw refused(
      `the expansion must hold one list of at most ${EXPANSION_MAX} stored words for each word, each word a text that is not empty, holds no NUL and is at most 2046 bytes of UTF-8, and all of them at most what one tsquery holds beside the search's own words`,
    );
  }
  if (oneEdit !== undefined && !(whole(oneEdit.minLength) && whole(oneEdit.max) && oneEdit.max <= EXPANSION_MAX)) {
    throw refused(`oneEdit.minLength must be a whole number from 1 to ${Number.MAX_SAFE_INTEGER}, and oneEdit.max one from 1 to ${EXPANSION_MAX}`);
  }
  if (!Array.isArray(group?.items)) throw refused('the group needs its items');
  const ids = group.items.map((item) => item.sourceId);
  if (ids.some((id) => !isSourceId(id))) throw refused("an item's sourceId must be a text that is not empty and holds no NUL");
  if (new Set(ids).size !== ids.length) throw refused('an item is listed twice');
  const dates = group.items.map((item) => item.date ?? null);
  if (dates.some((date) => date !== null && !isInstant(date))) {
    throw refused("an item's date must be an ISO 8601 instant with its zone that names a real day and time, to the microsecond at most, or null");
  }
  if (group.partKinds !== undefined && !(Array.isArray(group.partKinds) && group.partKinds.every((kind) => typeof kind === 'string'))) {
    throw refused('partKinds must be a list of texts');
  }
  const fields = profile?.fields;
  const names = fields !== null && typeof fields === 'object' ? Object.keys(fields) : [];
  if (names.length === 0 || names.some((name) => !(typeof fields[name] === 'number' && Number.isFinite(fields[name]) && fields[name] > 0))) {
    throw refused("each of the profile's fields needs a weight, a finite number above 0");
  }
  if (typeof profile.fallback !== 'string' || !names.includes(profile.fallback)) throw refused("the profile's fallback must be one of its fields");
  if (profile.title !== undefined && profile.title !== 'passage' && profile.title !== 'metadata') {
    throw refused("the profile's title must be 'passage' or 'metadata'");
  }
  if (order !== 'rank' && order !== 'date') throw refused("the order must be 'rank' or 'date'");
  if (!whole(pageSize)) throw refused(`pageSize must be a whole number from 1 to ${Number.MAX_SAFE_INTEGER}`);
  if (after !== undefined) {
    if (!isRank(after.rank) || !isSourceId(after.sourceId)) {
      throw refused('the key to start after needs a rank in decimal digits that a Postgres numeric holds and a sourceId that is not empty and holds no NUL');
    }
    if (after.date !== undefined && after.date !== null && !isInstant(after.date)) {
      throw refused('the date of the key to start after must be an ISO 8601 instant with its zone that names a real day and time, or null');
    }
  }
  return {
    words,
    expansion,
    oneEdit,
    ids,
    dates,
    partKinds: group.partKinds !== undefined && group.partKinds.length > 0 ? [...new Set(group.partKinds)] : null,
    fields: Object.fromEntries(names.map((name) => [name, fields[name]])),
    fallback: profile.fallback,
    titleField: profile.title === 'metadata' ? (names.includes('title') ? 'title' : profile.fallback) : null,
    order,
    pageSize,
    after,
  };
}

/** A stored word as a lexeme of a tsquery's text: in single quotes, a quote and a backslash doubled, so nothing in it is read as an operator. */
function quotedLexeme(word: string): string {
  return `'${word.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** A numeric's text without the zeros that end its fraction: `75.7500` is `75.75` and `100.0` is `100`. */
function trimmedDecimal(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

// ---------------------------------------------------------------------------
// PostgresVectorStore
// ---------------------------------------------------------------------------

/**
 * A vector store on Postgres with pgvector: one table per collection, a dense search through its HNSW index, a
 * lexical search through its `tsv` column, and both fused in one statement.
 */
export class PostgresVectorStore implements IVectorStore {
  private pool: any = null; // pg.Pool, the caller's pool, or the statements of an adapter
  private config: PostgresVectorStoreConfig;
  private prefix: string;
  private isInitialized = false;
  private ownsPool = false;
  /**
   * Set on a view of a caller's transaction when its callback ends; the view then runs no statement again (see
   * {@link PostgresVectorStore.withStorageTransaction} for the calls that still answer).
   */
  private borrowedEnded = false;
  /**
   * The adapter the caller made the store with. A view keeps its store's rather than the transaction it was lent,
   * so that it refuses that adapter too and may lend on the transaction it holds.
   */
  private ownAdapter: StorageAdapter | undefined;
  private readonly manageSchema: boolean;
  private readonly textConfig: string;

  constructor(config: PostgresVectorStoreConfig) {
    this.config = config;
    this.prefix = config.tablePrefix ?? '';
    this.manageSchema = config.manageSchema !== false;
    this.textConfig = PostgresVectorStore.textSearchConfigOf(config.textSearchConfig);
    this.ownAdapter = config.adapter;
  }

  /** A name safe to write inside double quotes. */
  private static plainName(name: string, what: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`PostgresVectorStore: the ${what} must be letters, digits and underscores.`);
    return name;
  }

  /** The text search configuration, checked, since it is written into SQL. */
  private static textSearchConfigOf(name: string | undefined): string {
    const config = name ?? 'english';
    if (!/^[a-z_][a-z0-9_]*$/.test(config)) throw new Error('PostgresVectorStore: the text search configuration must be a plain lower-case name.');
    return config;
  }

  /**
   * The statements that make one collection's table and its three indexes, for a caller that runs its own
   * migrations with `manageSchema: false`. The extension itself (`CREATE EXTENSION vector`) is the caller's.
   *
   * @param collection - The collection's name: letters, digits and underscores, at most 54 characters with the prefix.
   * @param dimension - The length of the embeddings the collection holds.
   * @param options - The similarity metric (`'cosine'` when left out), on its own or with the table prefix and the
   *   text search configuration (`'english'` when left out). Give the store the same three.
   * @returns The `CREATE TABLE` statement and the three `CREATE INDEX` statements, in the order to run them.
   * @throws When a name or the dimension cannot be written into SQL as given, or the name with its prefix is longer
   *   than 54 characters.
   *
   * @example
   * for (const statement of PostgresVectorStore.schemaSql('chunks', 1536, { tablePrefix: 'app_', textSearchConfig: 'simple' })) {
   *   await pool.query(statement);
   * }
   */
  static schemaSql(
    collection: string,
    dimension: number,
    options?:
      | 'cosine'
      | 'euclidean'
      | 'dotproduct'
      | { metric?: 'cosine' | 'euclidean' | 'dotproduct'; tablePrefix?: string; textSearchConfig?: string },
  ): string[] {
    const settings: { metric?: 'cosine' | 'euclidean' | 'dotproduct'; tablePrefix?: string; textSearchConfig?: string } =
      typeof options === 'string' ? { metric: options } : (options ?? {});
    const name = `${settings.tablePrefix ?? ''}${PostgresVectorStore.plainName(collection, 'collection name')}`;
    PostgresVectorStore.plainName(name, 'collection name');
    // Postgres keeps 63 bytes of a name. Up to 54 characters every index name stays whole; from 62 the three would
    // cut to one name, and IF NOT EXISTS would skip two of the indexes.
    if (name.length > 54) {
      throw new Error('PostgresVectorStore: the collection name, with its prefix, must be at most 54 characters, so that its index names stay whole.');
    }
    if (!Number.isInteger(dimension) || dimension < 1) throw new Error('PostgresVectorStore: the dimension must be a positive integer.');
    const config = PostgresVectorStore.textSearchConfigOf(settings.textSearchConfig);
    const ops = settings.metric === 'euclidean' ? 'vector_l2_ops' : settings.metric === 'dotproduct' ? 'vector_ip_ops' : 'vector_cosine_ops';
    return [
      `CREATE TABLE IF NOT EXISTS "${name}" (id TEXT PRIMARY KEY, embedding vector(${dimension}), metadata_json JSONB, text_content TEXT, created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT, updated_at BIGINT, tsv tsvector GENERATED ALWAYS AS (to_tsvector('${config}'::regconfig, COALESCE(text_content, ''))) STORED)`,
      `CREATE INDEX IF NOT EXISTS "${name}_hnsw" ON "${name}" USING hnsw (embedding ${ops})`,
      `CREATE INDEX IF NOT EXISTS "${name}_metadata" ON "${name}" USING gin (metadata_json)`,
      `CREATE INDEX IF NOT EXISTS "${name}_fts" ON "${name}" USING gin (tsv)`,
    ];
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Initialize the selected connection and optionally manage collection metadata: take the caller's adapter or
   * pool, or open a pool from the connection string; then, unless `manageSchema` is false, ensure the pgvector
   * extension exists and create the collections metadata table.
   *
   * @throws `vector_connection_ambiguous` when an adapter is given with a pool or a connection string, without
   *   contacting a database; `vector_adapter_requires_postgres_transactions` when the adapter is not a PostgreSQL
   *   adapter with transactions; `vector_transaction_closed` on a view of a transaction whose callback has ended;
   *   and an error when the configuration holds no adapter, pool or connection string.
   */
  async initialize(): Promise<void> {
    if (this.borrowedEnded) throw new Error('vector_transaction_closed');
    if (this.isInitialized) return;
    if (this.config.adapter) {
      if (this.config.pool || this.config.connectionString) throw new Error('vector_connection_ambiguous');
      this.pool = adapterExecutor(this.config.adapter);
      this.ownsPool = false;
    } else if (this.config.pool) {
      this.pool = this.config.pool;
      this.ownsPool = false;
    } else {
      if (!this.config.connectionString) throw new Error('PostgresVectorStore needs a connectionString or a pool.');
      const pg = await import('pg');
      this.pool = new pg.default.Pool({ connectionString: this.config.connectionString, max: this.config.poolSize ?? 10 });
      this.ownsPool = true;
    }
    if (this.manageSchema) {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS ${this._t('_collections')} (
          name TEXT PRIMARY KEY,
          dimension INTEGER NOT NULL,
          metric TEXT NOT NULL DEFAULT 'cosine',
          created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        )
      `);
    }
    this.isInitialized = true;
  }

  /** Close the pool the store opened; a caller's pool or adapter is left open. */
  async close(): Promise<void> {
    if (this.pool && this.ownsPool) await this.pool.end();
    this.pool = null;
    this.isInitialized = false;
  }

  /** Gracefully shut down the store (alias for close). */
  async shutdown(): Promise<void> {
    await this.close();
  }

  /**
   * Health check — verifies connection and pgvector availability.
   * @returns True if Postgres + pgvector is reachable.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this._ensureInit();
      const result = await this.pool.query('SELECT 1 AS ok');
      return result.rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  /** IVectorStore-compliant health check. */
  async checkHealth(): Promise<{ isHealthy: boolean; details?: any }> {
    const isHealthy = await this.healthCheck();
    return { isHealthy };
  }

  // =========================================================================
  // Caller transactions
  // =========================================================================

  /**
   * Borrow only the transaction adapter supplied to StorageAdapter.transaction. `work` gets a view of this store
   * whose every statement runs on that transaction's connection, so its vector writes commit or roll back with the
   * caller's own writes in the same transaction. The view opens no pool, commits nothing and runs no DDL: like a
   * store with `manageSchema: false`, it takes the metric from `similarityMetric`. The adapter the store was made
   * with is refused in place of the transaction, on the store and on a view of it: on that adapter the view's
   * writes would run on pooled connections and commit at once, outside the caller's transaction.
   *
   * When `work` settles the view stops working: `close()` and `shutdown()` do nothing, `healthCheck()` answers
   * false, `checkHealth()` answers `{ isHealthy: false }`, `fetchByIds()` with no ids answers an empty list, and
   * every other call throws `vector_transaction_closed`.
   *
   * Make the calls on the view one at a time, awaiting each inside `work`: they share the transaction's one
   * connection, and two searches with settings at once interleave their `SET LOCAL` and restore statements there,
   * so that one can run under the transaction's own values and the transaction can go on under the store's. Keep
   * neither the view nor the transaction after `work`, and let a failure reach the transaction's callback, so that
   * the transaction rolls back: a transaction that catches a failed write and commits is outside this contract.
   * Compute embeddings before the transaction opens, not inside it.
   *
   * @param transaction - The adapter that `StorageAdapter.transaction` passed to its callback.
   * @param work - The reads and writes to run in the transaction.
   * @returns What `work` returns.
   * @throws `vector_adapter_required` when the store was configured with a pool or a connection string rather
   *   than an adapter; `vector_transaction_required` when `transaction` is the adapter the store was made with;
   *   `vector_adapter_requires_postgres_transactions` when `transaction` is not a PostgreSQL adapter with
   *   transactions; `vector_transaction_closed` when called on a view whose callback has ended; and whatever
   *   `work` throws.
   *
   * @example
   * await db.transaction((tx) => store.withStorageTransaction(tx, async (vectors) => {
   *   await tx.run('UPDATE sources SET version = ? WHERE id = ?', [version, sourceId]);
   *   await vectors.delete('chunks', undefined, { filter: { sourceId } });
   *   await vectors.upsert('chunks', passages);
   * }));
   */
  async withStorageTransaction<T>(
    transaction: StorageAdapter,
    work: (store: PostgresVectorStore) => Promise<T>,
  ): Promise<T> {
    if (this.borrowedEnded) throw new Error('vector_transaction_closed');
    if (!this.config.adapter) throw new Error('vector_adapter_required');
    // On the adapter itself a view's writes would run on pooled connections and commit at once, outside the
    // transaction the caller has open.
    if (transaction === this.ownAdapter) throw new Error('vector_transaction_required');
    const view = new PostgresVectorStore({
      ...this.config, adapter: transaction, pool: undefined,
      connectionString: undefined, manageSchema: false,
    });
    view.ownAdapter = this.ownAdapter;
    view.pool = adapterExecutor(transaction);
    view.isInitialized = true;
    try {
      return await work(view);
    } finally {
      view.borrowedEnded = true;
      view.pool = null;
      view.isInitialized = false;
    }
  }

  // =========================================================================
  // Collection Management
  // =========================================================================

  /**
   * Create a new collection (Postgres table) with pgvector HNSW index. Each index is made only when the table
   * has none of its kind, under a name that carries the table prefix; a name longer than the 63 bytes Postgres
   * keeps is shortened so that it stays the index's own. With `manageSchema: false` this does nothing: the
   * caller's migrations made the table.
   */
  async createCollection(
    name: string,
    dimension: number,
    options?: CreateCollectionOptions,
  ): Promise<void> {
    await this._ensureInit();
    if (!this.manageSchema) return;
    const dim = dimension ?? this.config.defaultDimension ?? 1536;
    const metric = (options?.similarityMetric ?? this.config.similarityMetric ?? 'cosine') as 'cosine' | 'euclidean' | 'dotproduct';
    const table = this._t(name);

    // Create the documents table with pgvector embedding column.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        embedding vector(${dim}),
        metadata_json JSONB,
        text_content TEXT,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
        updated_at BIGINT
      )
    `);

    // Create HNSW index for ANN search.
    const opsClass = metric === 'cosine' ? 'vector_cosine_ops'
      : metric === 'euclidean' ? 'vector_l2_ops'
      : 'vector_ip_ops';
    await this._ensureIndex(name, 'hnsw', `USING hnsw (embedding ${opsClass})`);

    // Create GIN index for JSONB metadata filtering.
    await this._ensureIndex(name, 'metadata', 'USING gin (metadata_json)');

    // Create tsvector column + GIN index for full-text search.
    //
    // The column is read first and added only when that read fails. ALTER
    // TABLE takes an ACCESS EXCLUSIVE lock even when the column exists. That
    // lock waits behind every open reader of the table (a pg_dump reads the
    // table for its whole run), and every later query on the table queues
    // behind the waiting ALTER. A read takes ACCESS SHARE, which a dump does
    // not block.
    if (!(await this._hasTsvColumn(table))) {
      try {
        await this.pool.query(
          `ALTER TABLE ${table} ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('${this.textConfig}'::regconfig, COALESCE(text_content, ''))) STORED`,
        );
      } catch (err) {
        // Another caller added the column between the read and the ALTER (duplicate_column); any other failure
        // reaches the caller.
        if ((err as { code?: unknown } | null)?.code !== '42701') throw err;
      }
    }
    // The index is made outside the ALTER's catch, so a failure to make it reaches the caller. A table that has
    // the column may still lack its index: before index names carried the prefix, a second prefix's collection
    // got none.
    await this._ensureIndex(name, 'fts', 'USING gin (tsv)');

    // Register in collections metadata.
    await this.pool.query(
      `INSERT INTO ${this._t('_collections')} (name, dimension, metric) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
      [name, dim, metric],
    );
  }

  /**
   * Drop a collection table.
   *
   * @throws With `manageSchema: false`, where the tables are the caller's migrations' to drop.
   */
  async dropCollection(name: string): Promise<void> {
    await this._ensureInit();
    if (!this.manageSchema) {
      throw new Error("PostgresVectorStore: with manageSchema: false the tables are the caller's; drop them in a migration.");
    }
    await this.pool.query(`DROP TABLE IF EXISTS ${this._t(name)} CASCADE`);
    await this.pool.query(
      `DELETE FROM ${this._t('_collections')} WHERE name = $1`,
      [name],
    );
  }

  // =========================================================================
  // Upsert
  // =========================================================================

  /**
   * Insert/update the batch atomically on the current storage connection: INSERT ... ON CONFLICT (id) DO UPDATE in
   * one transaction, on a pool's client, in an adapter transaction, or in the caller's transaction for a view of
   * {@link PostgresVectorStore.withStorageTransaction}.
   */
  async upsert(
    collectionName: string,
    documents: VectorDocument[],
    _options?: UpsertOptions,
  ): Promise<UpsertResult> {
    await this._ensureInit();
    const table = this._t(collectionName);
    const now = Date.now();
    await this._transaction(async (client) => {
      for (const doc of documents) {
        // The embedding in pgvector's text form: '[0.1,0.2,...]'.
        await client.query(
          `INSERT INTO ${table} (id, embedding, metadata_json, text_content, created_at, updated_at)
           VALUES ($1, $2::vector, $3::jsonb, $4, $5, $5)
           ON CONFLICT (id) DO UPDATE SET
             embedding = EXCLUDED.embedding,
             metadata_json = EXCLUDED.metadata_json,
             text_content = EXCLUDED.text_content,
             updated_at = EXCLUDED.updated_at`,
          [doc.id, `[${doc.embedding.join(',')}]`, doc.metadata ? JSON.stringify(doc.metadata) : null,
            doc.textContent ?? null, now],
        );
      }
    });
    return { upsertedCount: documents.length, upsertedIds: documents.map((doc) => doc.id), failedCount: 0 };
  }

  // =========================================================================
  // Query (Dense Vector Search)
  // =========================================================================

  /**
   * Query for top-K nearest neighbors using pgvector operators.
   * Uses HNSW index for O(log n) approximate search.
   */
  async query(
    collectionName: string,
    queryEmbedding: number[],
    options?: QueryOptions,
  ): Promise<QueryResult> {
    await this._ensureInit();
    const table = this._t(collectionName);
    const topK = options?.topK ?? 10;
    const vecStr = `[${queryEmbedding.join(',')}]`;

    // Determine distance operator based on collection metric.
    const meta = await this._getCollectionMeta(collectionName);
    const op = meta?.metric === 'euclidean' ? '<->'
      : meta?.metric === 'dotproduct' ? '<#>'
      : '<=>'; // cosine (default)

    // Build query with optional JSONB metadata filtering.
    let sql = `SELECT id, embedding::text, metadata_json, text_content,
               (embedding ${op} $1::vector) AS distance
               FROM ${table}`;
    const params: unknown[] = [vecStr];
    let paramIdx = 2;

    // Apply metadata filters.
    if (options?.filter) {
      const { clause, filterParams } = this._buildMetadataFilter(options.filter, paramIdx);
      if (clause) {
        sql += ` WHERE ${clause}`;
        params.push(...filterParams);
        paramIdx += filterParams.length;
      }
    }

    sql += ` ORDER BY embedding ${op} $1::vector LIMIT $${paramIdx}`;
    params.push(topK);

    const result = await this._search(sql, params);

    // Convert rows to RetrievedVectorDocument.
    const documents: RetrievedVectorDocument[] = result.rows.map((row: any) => {
      const doc: RetrievedVectorDocument = {
        id: row.id,
        // Cosine distance → similarity: 1 - distance. L2: negate. IP: negate.
        similarityScore: op === '<=>' ? 1 - row.distance : -row.distance,
        embedding: options?.includeEmbedding ? this._parseVectorString(row.embedding) : [],
      };
      if (options?.includeMetadata !== false && row.metadata_json) {
        doc.metadata = row.metadata_json;
      }
      if (options?.includeTextContent && row.text_content) {
        doc.textContent = row.text_content;
      }
      return doc;
    });

    // A relaxed iterative scan may return rows slightly out of order; pgvector's README says to sort again.
    if (this.config.iterativeScan === 'relaxed_order') {
      documents.sort((a, b) => b.similarityScore - a.similarityScore);
    }

    return {
      documents,
      queryId: `pg-${Date.now()}`,
      stats: {
        totalCandidates: result.rowCount ?? 0,
        filteredCandidates: documents.length,
        returnedCount: documents.length,
      },
    };
  }

  /**
   * Fetch rows by primary key without similarity ranking. Used by
   * `HybridSearcher` to hydrate sparse-only RRF winners — a second
   * similarity query would return the next-K dense rows, not the
   * specific BM25 winners, and would misattribute rows under the
   * wrong fused-score position.
   *
   * Returns an empty array for an empty id list without firing SQL.
   * `similarityScore` is set to 0 as a sentinel.
   */
  async fetchByIds(
    collectionName: string,
    ids: string[],
    options?: { includeMetadata?: boolean; includeTextContent?: boolean },
  ): Promise<RetrievedVectorDocument[]> {
    if (ids.length === 0) return [];
    await this._ensureInit();
    const table = this._t(collectionName);

    const sql = `
      SELECT id, embedding::text, metadata_json, text_content
      FROM ${table}
      WHERE id = ANY($1::text[])
    `;
    const result = await this.pool.query(sql, [ids]);

    return result.rows.map((row: any) => {
      const doc: RetrievedVectorDocument = {
        id: row.id,
        similarityScore: 0,
        embedding: [],
      };
      if (options?.includeMetadata !== false && row.metadata_json) {
        doc.metadata = row.metadata_json;
      }
      if (options?.includeTextContent !== false && row.text_content) {
        doc.textContent = row.text_content;
      }
      return doc;
    });
  }

  async scanByMetadata(
    collectionName: string,
    options?: MetadataScanOptions,
  ): Promise<MetadataScanResult> {
    await this._ensureInit();
    const table = this._t(collectionName);
    const limit = Math.max(1, options?.limit ?? 100);

    const result = await this.pool.query(
      `SELECT id, embedding::text, metadata_json, text_content
       FROM ${table}
       ORDER BY updated_at ASC NULLS FIRST, created_at ASC
       LIMIT $1`,
      [Math.max(limit * 10, limit)],
    );

    const documents: RetrievedVectorDocument[] = [];
    for (const row of result.rows) {
      const metadata = row.metadata_json ?? undefined;
      if (options?.filter && !this._matchesFilter(metadata, options.filter)) {
        continue;
      }

      const scannedDoc: RetrievedVectorDocument = {
        id: row.id,
        embedding: options?.includeEmbedding ? this._parseVectorString(row.embedding) : [],
        similarityScore: 1,
      };

      if (options?.includeMetadata !== false && metadata) {
        scannedDoc.metadata = metadata;
      }
      if (options?.includeTextContent && row.text_content) {
        scannedDoc.textContent = row.text_content;
      }

      documents.push(scannedDoc);
      if (documents.length >= limit) break;
    }

    return {
      documents,
      stats: {
        totalCandidates: result.rowCount ?? 0,
        returnedCount: documents.length,
      },
    };
  }

  // =========================================================================
  // Hybrid Search (Dense + Lexical with RRF)
  // =========================================================================

  /**
   * Hybrid search combining pgvector ANN and tsvector BM25 in a single
   * SQL query with Reciprocal Rank Fusion.
   *
   * This runs as one query with two CTEs — no application-level fusion needed.
   *
   * With `match` or `prefix` the lexical leg reads the query's own words, every word (`match: 'all'`) or any word
   * (`'any'`, the default), each matching a stored word that begins with it when `prefix` is true; a query with no
   * word then runs the dense search alone. With neither, the leg reads the query with `plainto_tsquery`, which asks
   * for every word.
   */
  async hybridSearch(
    collectionName: string,
    queryEmbedding: number[],
    queryText: string,
    options?: QueryOptions & {
      alpha?: number;
      fusion?: 'rrf' | 'weighted';
      rrfK?: number;
      match?: 'all' | 'any';
      prefix?: boolean;
    },
  ): Promise<QueryResult> {
    await this._ensureInit();
    const ownWords = options?.match !== undefined || options?.prefix !== undefined;
    const lexicalQuery = ownWords ? this._tsQuery(queryText, options?.match ?? 'any', options?.prefix === true) : queryText;
    if (lexicalQuery === null) return this.query(collectionName, queryEmbedding, options);
    const tsQuery = `${ownWords ? 'to_tsquery' : 'plainto_tsquery'}('${this.textConfig}'::regconfig, $2)`;
    const table = this._t(collectionName);
    const topK = options?.topK ?? 10;
    const rrfK = options?.rrfK ?? 60;
    const candidatePool = topK * 3;
    const vecStr = `[${queryEmbedding.join(',')}]`;

    const meta = await this._getCollectionMeta(collectionName);
    const op = meta?.metric === 'euclidean' ? '<->'
      : meta?.metric === 'dotproduct' ? '<#>'
      : '<=>';

    // Filter each candidate source before its window rank and LIMIT. Applying
    // the predicate after fusion can discard winners without allowing the
    // next matching dense or lexical candidates into the RRF pool.
    const { clause: filterClause, filterParams } = options?.filter
      ? this._buildMetadataFilter(options.filter, 3)
      : { clause: '', filterParams: [] };
    const candidatePoolParam = 3 + filterParams.length;
    const rrfKParam = candidatePoolParam + 1;
    const topKParam = rrfKParam + 1;
    const denseFilterSql = filterClause ? `WHERE ${filterClause}` : '';
    const lexicalFilterSql = filterClause ? `AND ${filterClause}` : '';

    // RRF hybrid query: two CTEs (dense + lexical) merged with reciprocal rank fusion.
    const sql = `
      WITH dense AS (
        SELECT id, (embedding ${op} $1::vector) AS distance,
               ROW_NUMBER() OVER (ORDER BY embedding ${op} $1::vector) AS rank
        FROM ${table}
        ${denseFilterSql}
        ORDER BY embedding ${op} $1::vector
        LIMIT $${candidatePoolParam}
      ),
      lexical AS (
        SELECT id, ts_rank(tsv, ${tsQuery}) AS score,
               ROW_NUMBER() OVER (ORDER BY ts_rank(tsv, ${tsQuery}) DESC) AS rank
        FROM ${table}
        WHERE tsv @@ ${tsQuery}
        ${lexicalFilterSql}
        LIMIT $${candidatePoolParam}
      ),
      fused AS (
        SELECT COALESCE(d.id, l.id) AS id,
               (1.0 / ($${rrfKParam} + COALESCE(d.rank, 10000))) + (1.0 / ($${rrfKParam} + COALESCE(l.rank, 10000))) AS rrf_score
        FROM dense d
        FULL OUTER JOIN lexical l ON d.id = l.id
        ORDER BY rrf_score DESC
        LIMIT $${topKParam}
      )
      SELECT f.id, f.rrf_score, t.embedding::text, t.metadata_json, t.text_content
      FROM fused f
      JOIN ${table} t ON t.id = f.id
      ORDER BY f.rrf_score DESC
    `;

    const result = await this._search(
      sql,
      [vecStr, lexicalQuery, ...filterParams, candidatePool, rrfK, topK],
    );

    const documents: RetrievedVectorDocument[] = result.rows.map((row: any) => {
      const doc: RetrievedVectorDocument = {
        id: row.id,
        // rrf_score is a numeric, which pg returns as text.
        similarityScore: Number(row.rrf_score),
        embedding: options?.includeEmbedding ? this._parseVectorString(row.embedding) : [],
      };
      if (options?.includeMetadata !== false && row.metadata_json) {
        doc.metadata = row.metadata_json;
      }
      if (options?.includeTextContent && row.text_content) {
        doc.textContent = row.text_content;
      }
      return doc;
    });

    return {
      documents,
      queryId: `pg-hybrid-${Date.now()}`,
      stats: {
        totalCandidates: candidatePool,
        filteredCandidates: documents.length,
        returnedCount: documents.length,
      },
    };
  }

  // =========================================================================
  // Lexical Search and Metadata Changes
  // =========================================================================

  /** The words of a query as a tsquery: letters and digits only, lower case, at most 32 words. */
  private _tsQuery(queryText: string, match: 'all' | 'any', prefix: boolean): string | null {
    const words = [...new Set(queryText.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 32);
    if (words.length === 0) return null;
    return words.map((word) => (prefix ? `${word}:*` : word)).join(match === 'all' ? ' & ' : ' | ');
  }

  /**
   * Search on the tsvector column alone: no embedding, ranked by `ts_rank`. The query's words are runs of
   * letters and digits in lower case (at most 32); `match` asks for every word (`'all'`) or any word (`'any'`, the
   * default), and `prefix` matches a stored word that begins with a query word. A query with no word answers no
   * document and runs no search.
   */
  async lexicalSearch(
    collectionName: string,
    queryText: string,
    options?: QueryOptions & { match?: 'all' | 'any'; prefix?: boolean },
  ): Promise<QueryResult> {
    await this._ensureInit();
    const table = this._t(collectionName);
    const topK = options?.topK ?? 10;
    const tsQuery = this._tsQuery(queryText, options?.match ?? 'any', options?.prefix === true);
    if (tsQuery === null) {
      return { documents: [], queryId: `pg-lexical-${Date.now()}`, stats: { totalCandidates: 0, filteredCandidates: 0, returnedCount: 0 } };
    }
    const { clause, filterParams } = options?.filter ? this._buildMetadataFilter(options.filter, 2) : { clause: '', filterParams: [] };
    // The one table in the statement makes the filter's bare metadata_json unambiguous: to_tsquery yields a
    // single column, named q.
    const sql = `
      SELECT t.id, t.embedding::text, t.metadata_json, t.text_content, ts_rank(t.tsv, q) AS score
      FROM ${table} t, to_tsquery('${this.textConfig}'::regconfig, $1) AS q
      WHERE t.tsv @@ q
      ${clause ? `AND ${clause}` : ''}
      ORDER BY score DESC, t.id
      LIMIT $${2 + filterParams.length}
    `;
    const result: { rows: LexicalRow[]; rowCount?: number | null } = await this.pool.query(sql, [tsQuery, ...filterParams, topK]);
    const documents: RetrievedVectorDocument[] = result.rows.map((row) => {
      const doc: RetrievedVectorDocument = {
        id: row.id,
        similarityScore: Number(row.score),
        embedding: options?.includeEmbedding ? this._parseVectorString(row.embedding ?? '') : [],
      };
      if (options?.includeMetadata !== false && row.metadata_json) doc.metadata = row.metadata_json;
      if (options?.includeTextContent && row.text_content) doc.textContent = row.text_content;
      return doc;
    });
    return {
      documents,
      queryId: `pg-lexical-${Date.now()}`,
      stats: { totalCandidates: result.rowCount ?? 0, filteredCandidates: documents.length, returnedCount: documents.length },
    };
  }

  /**
   * One search over the items of one of the caller's groups, on the tsvector column alone, with no embedding. An
   * item is a source, the passages whose `sourceId` metadata key is its id, and the search reads the passages of the
   * handed items that `filter` admits, narrowed by `partKinds`, and no other: for the stored words it widens to, the
   * match, the count, the rank and the passage it shows.
   *
   * - **The match is an item's.** Each word is tested on every passage on its own (the same word, a word it begins,
   *   or one of the stored words one edit away), and an item matches when every word matches in at least one of its
   *   passages, the same passage or different ones. A word the text search configuration reads as no word, a stop
   *   word, is left out of the rule; a search whose every word is one finds nothing.
   * - **The rank is explicit.** For each word, the best of its matches over the item's passages, the weight of the
   *   passage's field (`profile`) times 1 for the same word, 0.75 for a word it begins and 0.5 for a word one edit
   *   away, summed over the words, in exact decimal arithmetic. `ts_rank` is not read.
   * - **The stored words one edit away** come from `ts_stat` over the same passages: every stored word within one
   *   letter of a query word's length, read 1,000 at a time through a cursor in a transaction, held to one edit in
   *   process, the most frequent `oneEdit.max` (64 at most) kept for each word while one tsquery holds them beside the query's
   *   words (each at most 2046 bytes, all of them with the query's words at most 1048575); a word past either is left
   *   out and marks the answer incomplete. A page after the first takes them as `expansion` and reads none.
   * - **The page** is ordered by rank, or by the caller's dates with an undated item last, then by the source id in
   *   byte order, and starts after `after`. The count, the page and each item's passage come from one statement, so
   *   they describe one state of the table.
   * - **With no word** every item that holds an admitted passage is listed, in the date order, each by its first
   *   passage.
   *
   * @throws When a part of `options` is not in the form {@link LexicalGroupSearchOptions} gives it.
   */
  async lexicalGroupSearch(
    collectionName: string,
    options: LexicalGroupSearchOptions,
  ): Promise<LexicalGroupSearchResult> {
    await this._ensureInit();
    const search = groupSearchOf(options);
    const { signal, filter } = options;
    const none = search.words.map((): string[] => []);
    const answered = (incomplete: boolean, expansion: string[][]): LexicalGroupSearchResult => ({
      total: 0, incomplete, expansion, rows: [], anyWord: [], more: false,
    });
    // An empty list is empty, never unrestricted: nothing is read.
    if (search.ids.length === 0) return answered(false, search.expansion ?? none);
    if (signal?.aborted) return answered(true, none);

    let expansion = search.expansion ?? none;
    let overflowed = search.words.map(() => false);
    if (search.expansion === undefined && search.oneEdit !== undefined) {
      const read = await this._storedWordsOneEdit(collectionName, search, search.oneEdit, filter, signal);
      if (read === null) return answered(true, none);
      ({ expansion, overflowed } = read);
    }
    if (signal?.aborted) return answered(true, none);
    const statement = search.words.length === 0
      ? this._groupListingSql(collectionName, search, filter)
      : this._groupMatchSql(collectionName, search, expansion, filter);
    const result: { rows: GroupSqlRow[] } = await this.pool.query(statement.sql, statement.params);
    // The statement ran to its end; an answer that came after the signal aborted is dropped.
    if (signal?.aborted) return answered(true, none);

    const head = result.rows[0];
    // A word the configuration reads as no word matched nothing, whatever stored words were found for it.
    const live = search.words.map((_word, at) => (head?.live ?? '')[at] === '1');
    const kindsOf = (text: string | null | undefined): Array<LexicalMatchKind | null> => {
      const kinds: Array<LexicalMatchKind | null> = search.words.map(() => null);
      for (const pair of text ? text.split(',') : []) {
        const [place, kind] = pair.split(':');
        kinds[Number(place) - 1] = MATCH_KINDS[kind] ?? null;
      }
      return kinds;
    };
    const rowOf = (row: GroupSqlRow): LexicalGroupRow => {
      // The rank is a numeric, which pg answers as text; a listing has none.
      const rank = trimmedDecimal(String(row.rank ?? '0'));
      const metadata: Record<string, MetadataValue> | null =
        typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json;
      const document: RetrievedVectorDocument = {
        id: String(row.id), embedding: [], similarityScore: Number(rank), textContent: row.text_content ?? '',
      };
      if (metadata) document.metadata = metadata;
      return {
        sourceId: String(row.source_id), rank, field: String(row.field),
        kinds: kindsOf(row.item_kinds), document, held: kindsOf(row.held_kinds),
      };
    };
    // Every row carries the count; a row with no item is the count alone.
    const found = result.rows.filter((row) => row.source_id !== null);
    const page = found.filter((row) => (row.part ?? 0) === 0);
    return {
      total: Number(head?.total ?? 0),
      incomplete: overflowed.some((over, at) => over && live[at]),
      expansion: expansion.map((list, at) => (live[at] ? list : [])),
      rows: page.slice(0, search.pageSize).map(rowOf),
      anyWord: found.filter((row) => row.part === 1).map(rowOf),
      more: page.length > search.pageSize,
    };
  }

  /**
   * The stored words one edit from each word of a grouped search, read from the passages the search admits and no
   * other, so a word that only another tenant's, another group's or an unshared passage holds is neither found nor
   * counted against the limit. `ts_stat` takes its query as text, so that text is built by Postgres's own `format()`,
   * the table through `%I` and every value through `%L`; no value is written into SQL here. Every stored word within
   * one letter of a query word's length comes back, the most frequent first, with no limit before the edit check: a
   * limit there would let frequent words of the right length crowd out the one word that is one edit away. A word is
   * kept only while the statement's one tsquery has room for it beside the search's own words, and only at 2046 bytes
   * of UTF-8 or fewer (`lexicalGroupExpansionRoom`); one left out marks its query word as `max` does.
   *
   * @returns Each word's stored words and whether more than `max` were found or one was left out for room, or null
   *   when the signal stopped the read.
   */
  private async _storedWordsOneEdit(
    collectionName: string,
    search: GroupSearch,
    oneEdit: { minLength: number; max: number },
    filter: MetadataFilter | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ expansion: string[][]; overflowed: boolean[] } | null> {
    const { words } = search;
    const kept = words.map((): string[] => []);
    const overflowed = words.map(() => false);
    // A word left out as the tsquery has no room for it: too long for one, or past what the words kept already leave.
    const leftOut = words.map(() => false);
    let room = expansionRoom(words);
    // A letter is a code point, as Postgres's length() counts a character.
    const letters = words.map((word) => Array.from(word).length);
    const widened = letters.map((count) => count >= oneEdit.minLength);
    const lengths = [...new Set(letters.flatMap((count, at) => (widened[at] ? [count - 1, count, count + 1] : [])))]
      .filter((count) => count >= oneEdit.minLength)
      .sort((a, b) => a - b);
    if (lengths.length === 0) return { expansion: kept, overflowed };

    const { clause, filterParams } = filter ? this._buildMetadataFilter(filter, 1, true) : { clause: '', filterParams: [] };
    // The filter's $n become format()'s %n$L, after the table, the items and the part kinds; a % of the clause's own
    // would be read as a format specifier, so it is doubled first.
    const admitted = clause
      ? ` AND (${clause.replace(/%/g, '%%').replace(/\$(\d+)/g, (_match, place: string) => `%${Number(place) + 3}$L`)})`
      : '';
    const tsv = search.titleField === null
      ? 'tsv'
      : `tsv || to_tsvector('${this.textConfig}'::regconfig, COALESCE(metadata_json->>'title', ''))`;
    const passages =
      `SELECT ${tsv} FROM %1$I WHERE jsonb_typeof(metadata_json->'sourceId') = 'string' AND metadata_json->>'sourceId' = ANY(%2$L::text[])` +
      ` AND (%3$L::text[] IS NULL OR metadata_json->>'partKind' = ANY(%3$L::text[]))${admitted}`;
    const values: unknown[] = [`${this.prefix}${collectionName}`, search.ids, search.partKinds, ...filterParams];
    // format() takes its values as text: pg writes an array as an array literal, which %L quotes and the clause casts.
    const placeholders = values.map((_value, at) => `$${at + 2}::text`).join(', ');
    storedWordsCursors += 1;
    const cursor = `agentos_stored_words_${storedWordsCursors}`;
    const declare =
      `DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT word, ndoc FROM ts_stat(format($1::text, ${placeholders}))` +
      ` WHERE length(word) = ANY($${values.length + 2}::int[]) ORDER BY ndoc DESC, word COLLATE "C"`;

    return this._transaction(async (client) => {
      await client.query(declare, [passages, ...values, lengths]);
      let stopped = false;
      for (;;) {
        if (signal?.aborted) {
          stopped = true;
          break;
        }
        const batch = await client.query(`FETCH ${STORED_WORDS_BATCH} FROM ${cursor}`);
        for (const row of batch.rows) {
          const stored = String(row.word);
          const count = Array.from(stored).length;
          for (let at = 0; at < words.length; at += 1) {
            if (!widened[at] || overflowed[at] || count < oneEdit.minLength || Math.abs(count - letters[at]) > 1) continue;
            // The word itself and a word it begins match as such, and take no place among the words one edit away.
            if (stored === words[at] || stored.startsWith(words[at]) || !withinOneEdit(words[at], stored)) continue;
            if (kept[at].length >= oneEdit.max) {
              overflowed[at] = true;
              continue;
            }
            const bytes = wordBytes(stored);
            if (bytes > STORED_WORD_BYTES_MAX || bytes + 1 > room) {
              leftOut[at] = true;
              continue;
            }
            kept[at].push(stored);
            room -= bytes + 1;
          }
        }
        // The last batch is a short one; and once every word has more than its limit, the rest changes nothing.
        if (batch.rows.length < STORED_WORDS_BATCH || widened.every((wide, at) => !wide || overflowed[at])) break;
      }
      await client.query(`CLOSE ${cursor}`);
      return stopped ? null : { expansion: kept, overflowed: overflowed.map((over, at) => over || leftOut[at]) };
    });
  }

  /**
   * The statement of a grouped search with words: the count, the page, the items that match some of the words when
   * none matches every word, and each item's passage, read in one statement. Its parts, by name:
   *
   * - `q`: each word as three queries (the same word, a word it begins, the stored words one edit away) and whether
   *   the configuration reads it as a word at all.
   * - `p`: the passages the search admits that hold any of the words; with titles read from the metadata, every
   *   admitted passage of an item whose title holds one as well.
   * - `h`: how each of those passages holds each word. `tt`: how each item's title read from the metadata does.
   * - `a`: every match with its score. `b`: an item's best match of each word. `i`: the items, with the words each
   *   holds, its rank and the caller's date. `m`: the items that hold every word.
   * - `pg`: the page. `aw`: on a first page of two words or more with nothing in `m`, the items of `i`.
   * - `bp`: the passage to show for each item of `pg` and `aw`. `fp`: the first passage of an item none of whose
   *   passages holds a word.
   */
  private _groupMatchSql(
    collectionName: string,
    search: GroupSearch,
    expansion: string[][],
    filter: MetadataFilter | undefined,
  ): { sql: string; params: unknown[] } {
    const table = this._t(collectionName);
    const config = `'${this.textConfig}'::regconfig`;
    const params: unknown[] = [];
    const bind = (value: unknown, type: string): string => {
      params.push(value);
      return `$${params.length}::${type}`;
    };
    const starts = search.words.map((word) => `${word}:*`);
    const edits = expansion.map((list) => list.map(quotedLexeme).join(' | '));
    const same = bind(search.words, 'text[]');
    const start = bind(starts, 'text[]');
    const edit = bind(edits, 'text[]');
    const ids = bind(search.ids, 'text[]');
    const dates = bind(search.dates, 'timestamptz[]');
    const kinds = bind(search.partKinds, 'text[]');
    const weights = bind(JSON.stringify(search.fields), 'jsonb');
    const fallback = bind(search.fallback, 'text');
    // One row more than the page says whether an item follows it. row_number() is a bigint, and so is the bound.
    const limit = bind(search.pageSize + 1, 'bigint');
    // Any word, by any of its three queries, each written as `q` writes it: what a passage must hold to count at all.
    const anyStart = `to_tsquery(${config}, ${bind([...search.words, ...starts].join(' | '), 'text')})`;
    const allEdits = edits.filter((text) => text !== '').join(' | ');
    const anyWord = allEdits === '' ? anyStart : `(${anyStart} || ${bind(allEdits, 'tsquery')})`;
    const titled = search.titleField !== null;
    const titleField = titled ? bind(search.titleField, 'text') : '';
    const order = (row: string): string =>
      (search.order === 'date' ? `${row}.date DESC NULLS LAST, ` : '') + `${row}.rank DESC, ${row}.source_id COLLATE "C" ASC`;
    const after = this._groupAfterSql(search, bind);
    // The items that match some of the words are read on a first page alone, and only where two words or more could differ.
    const others = search.after === undefined && search.words.length > 1;
    const pageSize = others ? bind(search.pageSize, 'bigint') : '';
    const { clause, filterParams } = filter ? this._buildMetadataFilter(filter, params.length + 1, true) : { clause: '', filterParams: [] };
    params.push(...filterParams);
    const kindOf = (tsv: string): string =>
      `CASE WHEN ${tsv} @@ q.same THEN 3 WHEN ${tsv} @@ q.start THEN 2 WHEN ${tsv} @@ q.edit THEN 1 END`;
    const scoreOf = (field: string, kind: string): string =>
      `(${weights}->>${field})::numeric * (CASE ${kind} WHEN 3 THEN 1 WHEN 2 THEN 0.75 ELSE 0.5 END)`;
    const sql = `
      WITH q AS MATERIALIZED (
        SELECT u.n::int AS n, z.same, z.start, z.edit, numnode(z.same) > 0 AS live
        FROM unnest(${same}, ${start}, ${edit}) WITH ORDINALITY AS u(same, start, edit, n)
        CROSS JOIN LATERAL (
          SELECT to_tsquery(${config}, u.same) AS same, to_tsquery(${config}, u.start) AS start,
                 CASE WHEN u.edit = '' THEN NULL ELSE u.edit::tsquery END AS edit
        ) z
      ),
      x AS MATERIALIZED (SELECT ${anyWord} AS words),
      p AS MATERIALIZED (
        SELECT t.id, t.metadata_json->>'sourceId' AS source_id,
               CASE WHEN jsonb_exists(${weights}, t.metadata_json->>'field') THEN t.metadata_json->>'field' ELSE ${fallback} END AS field,
               CASE WHEN jsonb_typeof(t.metadata_json->'index') = 'number' THEN (t.metadata_json->>'index')::numeric END AS idx,
               t.tsv${titled ? ', y.title' : ''}
        FROM ${table} t
        ${titled ? `CROSS JOIN LATERAL (SELECT to_tsvector(${config}, COALESCE(t.metadata_json->>'title', '')) AS title) y` : ''}
        WHERE jsonb_typeof(t.metadata_json->'sourceId') = 'string' AND t.metadata_json->>'sourceId' = ANY(${ids})
          AND (${kinds} IS NULL OR t.metadata_json->>'partKind' = ANY(${kinds}))
          AND ${titled ? '(t.tsv @@ (SELECT x.words FROM x) OR y.title @@ (SELECT x.words FROM x))' : 't.tsv @@ (SELECT x.words FROM x)'}
          ${clause ? `AND (${clause})` : ''}
      ),
      h AS MATERIALIZED (
        SELECT w.id, w.source_id, w.field, w.idx, w.n, w.kind
        FROM (SELECT p.id, p.source_id, p.field, p.idx, q.n, ${kindOf('p.tsv')} AS kind FROM p CROSS JOIN q WHERE q.live) w
        WHERE w.kind IS NOT NULL
      ),
      ${titled ? `tt AS (
        SELECT w.source_id, w.n, w.kind
        FROM (
          SELECT f.source_id, q.n, ${kindOf('f.title')} AS kind
          FROM (
            SELECT DISTINCT ON (p.source_id) p.source_id, p.title
            FROM p ORDER BY p.source_id, p.idx ASC NULLS LAST, p.id COLLATE "C" ASC
          ) f
          CROSS JOIN q WHERE q.live
        ) w
        WHERE w.kind IS NOT NULL
      ),` : ''}
      a AS (
        SELECT h.source_id, h.n, h.kind, ${scoreOf('h.field', 'h.kind')} AS score FROM h
        ${titled ? `UNION ALL SELECT tt.source_id, tt.n, tt.kind, ${scoreOf(titleField, 'tt.kind')} FROM tt` : ''}
      ),
      b AS (
        SELECT a.source_id, a.n, max(ARRAY[a.score, a.kind::numeric]) AS best FROM a GROUP BY a.source_id, a.n
      ),
      i AS MATERIALIZED (
        SELECT g.source_id, g.held, g.rank, g.kinds, d.date
        FROM (
          SELECT b.source_id, count(*)::int AS held, sum(b.best[1]) AS rank,
                 string_agg(b.n::text || ':' || (b.best[2])::int::text, ',' ORDER BY b.n) AS kinds
          FROM b GROUP BY b.source_id
        ) g
        JOIN unnest(${ids}, ${dates}) AS d(source_id, date) ON d.source_id = g.source_id
      ),
      m AS MATERIALIZED (
        SELECT i.source_id, i.rank, i.kinds, i.date FROM i WHERE i.held = (SELECT count(*)::int FROM q WHERE q.live)
      ),
      pg AS (
        SELECT o.source_id, o.rank, o.kinds, o.pos
        FROM (SELECT m.source_id, m.rank, m.kinds, row_number() OVER (ORDER BY ${order('m')}) AS pos FROM m WHERE ${after}) o
        WHERE o.pos <= ${limit}
      ),
      ${others ? `aw AS (
        SELECT o.source_id, o.rank, o.kinds, o.pos
        FROM (
          SELECT i.source_id, i.rank, i.kinds, row_number() OVER (ORDER BY ${order('i')}) AS pos
          FROM i WHERE NOT EXISTS (SELECT 1 FROM m)
        ) o
        WHERE o.pos <= ${pageSize}
      ),` : ''}
      r AS MATERIALIZED (
        SELECT 0 AS part, pg.source_id, pg.rank, pg.kinds, pg.pos FROM pg
        ${others ? 'UNION ALL SELECT 1, aw.source_id, aw.rank, aw.kinds, aw.pos FROM aw' : ''}
      ),
      bp AS (
        SELECT DISTINCT ON (s.source_id) s.source_id, s.id, s.field, s.kinds
        FROM (
          SELECT h.source_id, h.id, h.field, h.idx, count(*) AS held,
                 string_agg(h.n::text || ':' || h.kind::text, ',' ORDER BY h.n) AS kinds
          FROM h WHERE h.source_id IN (SELECT r.source_id FROM r)
          GROUP BY h.source_id, h.id, h.field, h.idx
        ) s
        ORDER BY s.source_id, s.held DESC, (${weights}->>s.field)::numeric DESC, s.idx ASC NULLS LAST, s.id COLLATE "C" ASC
      )${titled ? `,
      fp AS (
        SELECT DISTINCT ON (p.source_id) p.source_id, p.id
        FROM p
        WHERE p.source_id IN (SELECT r.source_id FROM r) AND p.source_id NOT IN (SELECT bp.source_id FROM bp)
        ORDER BY p.source_id, p.idx ASC NULLS LAST, p.id COLLATE "C" ASC
      )` : ''}
      SELECT c.total, c.live, r.part, r.source_id, r.rank::text AS rank, r.kinds AS item_kinds, bp.kinds AS held_kinds,
             ${titled ? `COALESCE(bp.field, ${titleField})` : 'bp.field'} AS field, t.id, t.metadata_json, t.text_content
      FROM (
        SELECT (SELECT count(*)::int FROM m) AS total,
               (SELECT string_agg(CASE WHEN q.live THEN '1' ELSE '0' END, '' ORDER BY q.n) FROM q) AS live
      ) c
      LEFT JOIN (
        r LEFT JOIN bp ON bp.source_id = r.source_id
        ${titled ? 'LEFT JOIN fp ON fp.source_id = r.source_id' : ''}
        JOIN ${table} t ON t.id = ${titled ? 'COALESCE(bp.id, fp.id)' : 'bp.id'}
      ) ON TRUE
      ORDER BY r.part, r.pos
    `;
    return { sql, params };
  }

  /**
   * The statement of a grouped search with no word: every item that holds an admitted passage, counted, in the date
   * order (the newest of the caller's dates first, an undated item last, then by the source id), each with its first
   * passage. `p` is the admitted passages, `m` each item's first with the caller's date, `pg` the page.
   */
  private _groupListingSql(
    collectionName: string,
    search: GroupSearch,
    filter: MetadataFilter | undefined,
  ): { sql: string; params: unknown[] } {
    const table = this._t(collectionName);
    const params: unknown[] = [];
    const bind = (value: unknown, type: string): string => {
      params.push(value);
      return `$${params.length}::${type}`;
    };
    const ids = bind(search.ids, 'text[]');
    const dates = bind(search.dates, 'timestamptz[]');
    const kinds = bind(search.partKinds, 'text[]');
    const weights = bind(JSON.stringify(search.fields), 'jsonb');
    const fallback = bind(search.fallback, 'text');
    const limit = bind(search.pageSize + 1, 'bigint');
    // No word ranks an item, so every item's rank is 0 and the date decides under either order.
    const after = this._groupAfterSql({ ...search, order: 'date' }, bind);
    const { clause, filterParams } = filter ? this._buildMetadataFilter(filter, params.length + 1, true) : { clause: '', filterParams: [] };
    params.push(...filterParams);
    const sql = `
      WITH p AS MATERIALIZED (
        SELECT t.id, t.metadata_json->>'sourceId' AS source_id,
               CASE WHEN jsonb_exists(${weights}, t.metadata_json->>'field') THEN t.metadata_json->>'field' ELSE ${fallback} END AS field,
               CASE WHEN jsonb_typeof(t.metadata_json->'index') = 'number' THEN (t.metadata_json->>'index')::numeric END AS idx
        FROM ${table} t
        WHERE jsonb_typeof(t.metadata_json->'sourceId') = 'string' AND t.metadata_json->>'sourceId' = ANY(${ids})
          AND (${kinds} IS NULL OR t.metadata_json->>'partKind' = ANY(${kinds}))
          ${clause ? `AND (${clause})` : ''}
      ),
      m AS MATERIALIZED (
        SELECT f.source_id, f.id, f.field, 0::numeric AS rank, d.date
        FROM (
          SELECT DISTINCT ON (p.source_id) p.source_id, p.id, p.field
          FROM p ORDER BY p.source_id, p.idx ASC NULLS LAST, p.id COLLATE "C" ASC
        ) f
        JOIN unnest(${ids}, ${dates}) AS d(source_id, date) ON d.source_id = f.source_id
      ),
      pg AS (
        SELECT o.source_id, o.id, o.field, o.pos
        FROM (
          SELECT m.source_id, m.id, m.field,
                 row_number() OVER (ORDER BY m.date DESC NULLS LAST, m.source_id COLLATE "C" ASC) AS pos
          FROM m WHERE ${after}
        ) o
        WHERE o.pos <= ${limit}
      )
      SELECT c.total, pg.source_id, pg.field, t.id, t.metadata_json, t.text_content
      FROM (SELECT (SELECT count(*)::int FROM m) AS total) c
      LEFT JOIN (pg JOIN ${table} t ON t.id = pg.id) ON TRUE
      ORDER BY pg.pos
    `;
    return { sql, params };
  }

  /**
   * The condition that keeps the items of `m` after a page's last, in the page's complete order: by rank, the lower
   * ranks and, level in rank, the later source ids; by date, the older dates, then the undated items, and within one
   * date the same. `TRUE` on a first page.
   */
  private _groupAfterSql(search: GroupSearch, bind: (value: unknown, type: string) => string): string {
    const key = search.after;
    if (key === undefined) return 'TRUE';
    const rank = bind(key.rank, 'numeric');
    const lower = `(m.rank < ${rank} OR (m.rank = ${rank} AND m.source_id COLLATE "C" > ${bind(key.sourceId, 'text')}))`;
    if (search.order !== 'date') return lower;
    if (key.date === undefined || key.date === null) return `(m.date IS NULL AND ${lower})`;
    const date = bind(key.date, 'timestamptz');
    return `(m.date < ${date} OR m.date IS NULL OR (m.date = ${date} AND ${lower}))`;
  }

  /**
   * Change the metadata of every document the filter matches: a key given as `null` is removed, the others
   * replace the stored ones, and the rest of the stored metadata stays.
   *
   * @throws When the filter holds no condition, so that no call changes every document.
   */
  async updateMetadata(
    collectionName: string,
    filter: MetadataFilter,
    patch: Record<string, MetadataValue | null>,
  ): Promise<{ updatedCount: number }> {
    await this._ensureInit();
    const table = this._t(collectionName);
    const set: Record<string, MetadataValue> = {};
    const remove: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      this._field(key);
      if (value === null) remove.push(key);
      else set[key] = value;
    }
    const { clause, filterParams } = this._buildMetadataFilter(filter, 4);
    if (!clause) throw new Error('PostgresVectorStore.updateMetadata needs a filter.');
    const result = await this.pool.query(
      `UPDATE ${table} SET metadata_json = (COALESCE(metadata_json, '{}'::jsonb) || $1::jsonb) - $2::text[], updated_at = $3 WHERE ${clause}`,
      [JSON.stringify(set), remove, Date.now(), ...filterParams],
    );
    return { updatedCount: result.rowCount ?? 0 };
  }

  // =========================================================================
  // Delete
  // =========================================================================

  /**
   * Delete documents by id, else by a metadata filter (`options.filter`), else every document when
   * `options.deleteAll` is set. A filter that yields no condition deletes nothing.
   */
  async delete(
    collectionName: string,
    ids?: string[],
    options?: DeleteOptions,
  ): Promise<DeleteResult> {
    await this._ensureInit();
    const table = this._t(collectionName);

    if (ids && ids.length > 0) {
      const placeholders = ids.map((_: unknown, i: number) => `$${i + 1}`).join(', ');
      const result = await this.pool.query(
        `DELETE FROM ${table} WHERE id IN (${placeholders})`,
        ids,
      );
      return { deletedCount: result.rowCount ?? 0 };
    }

    if (options?.filter && Object.keys(options.filter).length > 0) {
      const { clause, filterParams } = this._buildMetadataFilter(options.filter, 1);
      if (!clause) return { deletedCount: 0 };
      const result = await this.pool.query(`DELETE FROM ${table} WHERE ${clause}`, filterParams);
      return { deletedCount: result.rowCount ?? 0 };
    }

    if (options?.deleteAll) {
      const result = await this.pool.query(`DELETE FROM ${table}`);
      return { deletedCount: result.rowCount ?? 0 };
    }

    return { deletedCount: 0 };
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /** Whether a collection table already has its `tsv` full-text column. */
  private async _hasTsvColumn(table: string): Promise<boolean> {
    try {
      await this.pool.query(`SELECT tsv FROM ${table} LIMIT 0`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Makes an index on a collection's table unless the table already has one of that access method on that column.
   * The table is looked up in the schema the store's unqualified names create it in, so a same-named table of
   * another schema does not count, and under the name the catalog holds, which is the 63 bytes Postgres keeps of
   * a longer one.
   */
  private async _ensureIndex(collection: string, suffix: string, using: string): Promise<void> {
    const tableName = cutToBytes(`${this.prefix}${collection}`, NAME_BYTES);
    // pg_indexes.indexdef prints `USING hnsw (embedding vector_cosine_ops)`, `USING gin (metadata_json)` and
    // `USING gin (tsv)`, so the text up to the first closing bracket matches an index of an older name too.
    const marker = using.slice(0, using.indexOf(')') + 1);
    const existing = await this.pool.query(
      'SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1',
      [tableName],
    );
    if (existing.rows.some((row: { indexdef: string }) => row.indexdef.includes(marker))) return;
    const indexName = PostgresVectorStore.quoted(PostgresVectorStore.indexName(tableName, suffix));
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${this._t(collection)} ${using}`);
  }

  /**
   * The name of one of a table's indexes: the table's name, an underscore and the suffix, whole when Postgres
   * keeps it whole. A longer name would be cut to the table's own name or to the name of another of its indexes,
   * and IF NOT EXISTS would then skip the index. So the table's part is cut instead and eight hex digits of a hash
   * of the table's name follow it: the indexes of one table, and those of two tables whose names start alike, keep
   * names of their own.
   */
  private static indexName(tableName: string, suffix: string): string {
    const whole = `${tableName}_${suffix}`;
    if (utf8Bytes(whole) <= NAME_BYTES) return whole;
    const hash = sha256Hex(tableName).slice(0, 8);
    return `${cutToBytes(tableName, NAME_BYTES - hash.length - suffix.length - 2)}_${hash}_${suffix}`;
  }

  /** Ensure the store is initialized before any operation. */
  private async _ensureInit(): Promise<void> {
    if (!this.isInitialized) await this.initialize();
  }

  /**
   * A collection's table, with the prefix, as one quoted identifier. A double quote in the prefix or the name is
   * doubled, the SQL rule for a quoted identifier, so a name cannot close the identifier and write SQL of its own.
   */
  private _t(name: string): string {
    return PostgresVectorStore.quoted(`${this.prefix}${name}`);
  }

  /** A name as a quoted identifier, every double quote in it doubled. */
  private static quoted(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /** Get collection metadata: from the collections table, or from the configuration when the schema is the caller's. */
  private async _getCollectionMeta(name: string): Promise<CollectionMeta | null> {
    if (!this.manageSchema) {
      return { name, dimension: this.config.defaultDimension ?? 1536, metric: this.config.similarityMetric ?? 'cosine', documentCount: 0 };
    }
    const result = await this.pool.query(
      `SELECT name, dimension, metric FROM ${this._t('_collections')} WHERE name = $1`,
      [name],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      name: row.name,
      dimension: row.dimension,
      metric: row.metric,
      documentCount: 0, // Lazy — count not tracked here.
    };
  }

  /** The pgvector settings a search runs under, or none. */
  private _searchSettings(): string[] {
    const settings: string[] = [];
    if (this.config.iterativeScan === 'strict_order' || this.config.iterativeScan === 'relaxed_order') {
      settings.push(`SET LOCAL hnsw.iterative_scan = '${this.config.iterativeScan}'`);
    }
    if (this.config.efSearch !== undefined) {
      if (!Number.isInteger(this.config.efSearch) || this.config.efSearch < 1 || this.config.efSearch > 1000) throw new Error('PostgresVectorStore: efSearch must be an integer from 1 to 1000.');
      settings.push(`SET LOCAL hnsw.ef_search = ${this.config.efSearch}`);
    }
    if (this.config.maxScanTuples !== undefined) {
      if (!Number.isInteger(this.config.maxScanTuples) || this.config.maxScanTuples < 1) throw new Error('PostgresVectorStore: maxScanTuples must be a positive integer.');
      settings.push(`SET LOCAL hnsw.max_scan_tuples = ${this.config.maxScanTuples}`);
    }
    return settings;
  }

  /**
   * One transaction using the configured adapter or the existing pool path. On a view of a caller's transaction
   * the adapter's `transaction` runs `work` on that same transaction, which commits when the caller's does.
   */
  private async _transaction<T>(work: (sql: VectorSqlExecutor) => Promise<T>): Promise<T> {
    if (this.config.adapter) {
      return this.config.adapter.transaction((tx) => work(adapterExecutor(tx)));
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work({
        async query(sql, params = []) {
          const result = await client.query(sql, params);
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the operation failure if the connection was lost.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Run search settings on one connection and restore a borrowed transaction's settings. A search with settings
   * runs in a transaction with `SET LOCAL`, so they stay on one connection for one statement and never reach the
   * pool's other users. On an adapter the transaction may be the caller's, which goes on after the search: each
   * setting's value is read first and set back after the search.
   */
  private async _search(sql: string, params: unknown[]): Promise<{
    rows: Record<string, unknown>[]; rowCount?: number | null;
  }> {
    const settings = this._searchSettings();
    if (settings.length === 0) return this.pool.query(sql, params);
    return this._transaction(async (client) => {
      if (!this.config.adapter) {
        for (const setting of settings) await client.query(setting);
        return client.query(sql, params);
      }
      const saved: { name: string; value: string | null }[] = [];
      for (const setting of settings) {
        const name = /^SET LOCAL ([a-z_.]+) = /.exec(setting)?.[1];
        if (!name) throw new Error('vector_search_setting_invalid');
        const before = await client.query('SELECT current_setting($1, true) AS value', [name]);
        const value = before.rows[0]?.value;
        saved.push({ name, value: typeof value === 'string' ? value : null });
        await client.query(setting);
      }
      const result = await client.query(sql, params);
      for (const previous of saved.reverse()) {
        await client.query('SELECT set_config($1, $2, true)', [previous.name, previous.value]);
      }
      return result;
    });
  }

  /**
   * Parse pgvector string format '[0.1,0.2,0.3]' to number[].
   */
  private _parseVectorString(str: string): number[] {
    if (!str) return [];
    // pgvector returns format: [0.1,0.2,0.3]
    return str
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(Number);
  }

  /** A metadata key safe to write into SQL: letters, digits, underscore, dot and hyphen. */
  private _field(field: string): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(field)) throw new Error('PostgresVectorStore: a metadata key must be letters, digits, underscore, dot or hyphen.');
    return field;
  }

  /**
   * Build JSONB metadata filter SQL clauses. `$in`, `$nin`, `$all` and `$contains` also read a field that holds an
   * array, comparing its elements as JSON values, so a number matches a number and not its text: `$in` matches
   * when the array holds a value in the list, `$nin` when it holds none, `$all` when it holds every value, and
   * `$contains` when it holds the value. A field that holds a single value is compared as text, unless `typed`.
   * `$textSearch` matches a string value that contains the text, in any case.
   *
   * @param filter   - MetadataFilter to translate.
   * @param startIdx - Starting parameter index ($N).
   * @param typed    - Compare a field that holds a single value as a JSON value too, under a plain value, `$eq`,
   *   `$ne`, `$in` and `$nin`: the number 7 then matches 7 and not the text "7", as `LibraryIndex` checks a scope.
   * @returns SQL WHERE clause and parameter values.
   * @throws When a key is not letters, digits, underscore, dot or hyphen, or when a key's condition holds an
   *   operator the store does not know, `$in`, `$nin` or `$all` without an array, or no operator at all. A
   *   condition left out of the SQL would widen the search, change or deletion the filter scopes.
   */
  private _buildMetadataFilter(
    filter: MetadataFilter,
    startIdx: number,
    typed = false,
  ): { clause: string; filterParams: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = startIdx;

    for (const [field, condition] of Object.entries(filter)) {
      const key = this._field(field);
      const path = `metadata_json->>'${key}'`;
      const json = `metadata_json->'${key}'`;
      // A single value, compared as a JSON value (`typed`) or as text.
      const single = (operator: '=' | '!=', value: unknown): void => {
        conditions.push(typed ? `${json} ${operator} $${idx}::jsonb` : `${path} ${operator} $${idx}`);
        params.push(typed ? JSON.stringify(value) : String(value));
        idx++;
      };
      // How `$in` and `$nin` compare a field that holds a single value with their list, and the list as they bind it.
      const inList = (place: number): string => (typed ? `${json} = ANY($${place}::jsonb[])` : `${path} = ANY($${place}::text[])`);
      const listed = (values: unknown[]): string[] => values.map((value) => (typed ? JSON.stringify(value) : String(value)));

      // Direct scalar match (implicit $eq).
      if (typeof condition !== 'object' || condition === null) {
        single('=', condition);
        continue;
      }

      const cond = condition as MetadataFieldCondition;
      for (const [operator, value] of Object.entries(cond)) {
        if (value === undefined) continue;
        if (!FILTER_OPERATORS.has(operator)) {
          throw new Error(`PostgresVectorStore: '${operator}' on the metadata key '${key}' is not a filter operator.`);
        }
        if ((operator === '$in' || operator === '$nin' || operator === '$all') && !Array.isArray(value)) {
          throw new Error(`PostgresVectorStore: ${operator} on the metadata key '${key}' needs an array.`);
        }
      }
      const first = conditions.length;

      if (cond.$eq !== undefined) single('=', cond.$eq);
      if (cond.$ne !== undefined) single('!=', cond.$ne);
      if (cond.$gt !== undefined) {
        conditions.push(typeof cond.$gt === 'number' ? `(${path})::numeric > $${idx}` : `${path} > $${idx}`);
        params.push(typeof cond.$gt === 'number' ? cond.$gt : String(cond.$gt));
        idx++;
      }
      if (cond.$gte !== undefined) {
        conditions.push(typeof cond.$gte === 'number' ? `(${path})::numeric >= $${idx}` : `${path} >= $${idx}`);
        params.push(typeof cond.$gte === 'number' ? cond.$gte : String(cond.$gte));
        idx++;
      }
      if (cond.$lt !== undefined) {
        conditions.push(typeof cond.$lt === 'number' ? `(${path})::numeric < $${idx}` : `${path} < $${idx}`);
        params.push(typeof cond.$lt === 'number' ? cond.$lt : String(cond.$lt));
        idx++;
      }
      if (cond.$lte !== undefined) {
        conditions.push(typeof cond.$lte === 'number' ? `(${path})::numeric <= $${idx}` : `${path} <= $${idx}`);
        params.push(typeof cond.$lte === 'number' ? cond.$lte : String(cond.$lte));
        idx++;
      }
      if (cond.$in !== undefined && Array.isArray(cond.$in)) {
        conditions.push(`(CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${json} @> ANY($${idx + 1}::jsonb[]) ELSE ${inList(idx)} END)`);
        params.push(listed(cond.$in), cond.$in.map((value) => JSON.stringify([value])));
        idx += 2;
      }
      if (cond.$nin !== undefined && Array.isArray(cond.$nin)) {
        conditions.push(`(${json} IS NOT NULL AND NOT (CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${json} @> ANY($${idx + 1}::jsonb[]) ELSE ${inList(idx)} END))`);
        params.push(listed(cond.$nin), cond.$nin.map((value) => JSON.stringify([value])));
        idx += 2;
      }
      if (cond.$all !== undefined && Array.isArray(cond.$all)) {
        conditions.push(`${json} @> $${idx}::jsonb`);
        params.push(JSON.stringify(cond.$all));
        idx++;
      }
      // jsonb_exists is the function behind jsonb's ? operator. The SQL storage adapter rewrites every question mark
      // in a statement to a placeholder, so the statement spells the function.
      if (cond.$exists !== undefined) {
        conditions.push(cond.$exists
          ? `jsonb_exists(metadata_json, '${key}')`
          : `NOT jsonb_exists(metadata_json, '${key}')`);
      }
      if (cond.$contains !== undefined) {
        conditions.push(`(CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${json} @> $${idx}::jsonb ELSE ${path} LIKE $${idx + 1} END)`);
        params.push(JSON.stringify([cond.$contains]), `%${cond.$contains}%`);
        idx += 2;
      }
      if (cond.$textSearch !== undefined) {
        conditions.push(`(jsonb_typeof(${json}) = 'string' AND strpos(lower(${path}), lower($${idx})) > 0)`);
        params.push(String(cond.$textSearch));
        idx++;
      }
      if (conditions.length === first) {
        throw new Error(`PostgresVectorStore: the filter on the metadata key '${key}' holds no condition.`);
      }
    }

    return {
      clause: conditions.length > 0 ? conditions.join(' AND ') : '',
      filterParams: params,
    };
  }

  private _matchesFilter(
    metadata: Record<string, MetadataValue> | undefined,
    filter: MetadataFilter,
  ): boolean {
    if (!metadata) {
      for (const key in filter) {
        const condition = filter[key];
        if (typeof condition === 'object' && condition !== null && (condition as MetadataFieldCondition).$exists === false) {
          continue;
        }
        return false;
      }
      return true;
    }

    for (const key in filter) {
      const docValue = metadata[key];
      const filterValue = filter[key];

      if (typeof filterValue === 'object' && filterValue !== null) {
        if (!this._evaluateCondition(docValue, filterValue as MetadataFieldCondition)) {
          return false;
        }
      } else if (Array.isArray(docValue)) {
        if (!docValue.includes(filterValue as MetadataScalarValue)) {
          return false;
        }
      } else if (docValue !== filterValue) {
        return false;
      }
    }

    return true;
  }

  private _evaluateCondition(
    docValue: MetadataValue | undefined,
    condition: MetadataFieldCondition,
  ): boolean {
    if (condition.$exists !== undefined) {
      return condition.$exists === (docValue !== undefined);
    }
    if (docValue === undefined) return false;

    if (condition.$eq !== undefined && docValue !== condition.$eq) return false;
    if (condition.$ne !== undefined && docValue === condition.$ne) return false;

    if (typeof docValue === 'number') {
      if (typeof condition.$gt === 'number' && !(docValue > condition.$gt)) return false;
      if (typeof condition.$gte === 'number' && !(docValue >= condition.$gte)) return false;
      if (typeof condition.$lt === 'number' && !(docValue < condition.$lt)) return false;
      if (typeof condition.$lte === 'number' && !(docValue <= condition.$lte)) return false;
    } else if (typeof docValue === 'string') {
      if (condition.$gt !== undefined && !(docValue > String(condition.$gt))) return false;
      if (condition.$gte !== undefined && !(docValue >= String(condition.$gte))) return false;
      if (condition.$lt !== undefined && !(docValue < String(condition.$lt))) return false;
      if (condition.$lte !== undefined && !(docValue <= String(condition.$lte))) return false;
    }

    if (condition.$in !== undefined) {
      if (!Array.isArray(condition.$in)) return false;
      if (Array.isArray(docValue)) {
        if (!docValue.some(value => condition.$in!.includes(value as MetadataScalarValue))) return false;
      } else if (!condition.$in.includes(docValue as MetadataScalarValue)) {
        return false;
      }
    }

    if (condition.$nin !== undefined) {
      if (!Array.isArray(condition.$nin)) return false;
      if (Array.isArray(docValue)) {
        if (docValue.some(value => condition.$nin!.includes(value as MetadataScalarValue))) return false;
      } else if (condition.$nin.includes(docValue as MetadataScalarValue)) {
        return false;
      }
    }

    if (Array.isArray(docValue)) {
      if (condition.$contains !== undefined && !docValue.includes(condition.$contains as MetadataScalarValue)) return false;
      if (condition.$all !== undefined) {
        if (!Array.isArray(condition.$all) || !condition.$all.every(value => docValue.includes(value))) return false;
      }
    } else if (typeof docValue === 'string' && condition.$contains !== undefined && typeof condition.$contains === 'string') {
      if (!docValue.includes(condition.$contains)) return false;
    }

    if (condition.$textSearch !== undefined) {
      if (typeof docValue !== 'string' || !docValue.toLowerCase().includes(condition.$textSearch.toLowerCase())) {
        return false;
      }
    }

    return true;
  }
}
