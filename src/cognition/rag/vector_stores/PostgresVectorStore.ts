/**
 * @fileoverview Postgres + pgvector Vector Store Implementation.
 * @module rag/vector_stores/PostgresVectorStore
 *
 * Implements `IVectorStore` using Postgres with the pgvector extension
 * for native HNSW-indexed approximate nearest neighbor search. Supports:
 *
 * - Dense vector search via pgvector `<=>` (cosine), `<->` (L2), `<#>` (inner product)
 * - Full-text search via tsvector + GIN indexes, fused with the dense search or on its own (`lexicalSearch`)
 * - Hybrid search combining both with RRF fusion in a single SQL query
 * - JSONB metadata filtering with GIN indexes, array fields included
 * - Connection pooling via pg.Pool, or a pool the caller owns
 * - Tables made by the caller's migrations (`manageSchema: false` with `schemaSql()`)
 * - pgvector's iterative index scans for filtered searches
 *
 * Scaling target: 500K → 10M vectors with multi-tenant schema isolation.
 *
 * @see ../../IVectorStore.ts for the interface definition.
 */

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
} from '../IVectorStore.js';

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
  /** Postgres connection string. Required unless `pool` is given. */
  connectionString?: string;
  /** A pool the caller owns. The store opens none of its own, and `close()` leaves this one open. */
  pool?: PgPoolLike;
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

// ---------------------------------------------------------------------------
// PostgresVectorStore
// ---------------------------------------------------------------------------

/**
 * A vector store on Postgres with pgvector: one table per collection, a dense search through its HNSW index, a
 * lexical search through its `tsv` column, and both fused in one statement.
 */
export class PostgresVectorStore implements IVectorStore {
  private pool: any = null; // pg.Pool
  private config: PostgresVectorStoreConfig;
  private prefix: string;
  private isInitialized = false;
  private ownsPool = false;
  private readonly manageSchema: boolean;
  private readonly textConfig: string;

  constructor(config: PostgresVectorStoreConfig) {
    this.config = config;
    this.prefix = config.tablePrefix ?? '';
    this.manageSchema = config.manageSchema !== false;
    this.textConfig = PostgresVectorStore.textSearchConfigOf(config.textSearchConfig);
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
   * @param collection - The collection's name: letters, digits and underscores.
   * @param dimension - The length of the embeddings the collection holds.
   * @param options - The similarity metric (`'cosine'` when left out), on its own or with the table prefix and the
   *   text search configuration (`'english'` when left out). Give the store the same three.
   * @returns The `CREATE TABLE` statement and the three `CREATE INDEX` statements, in the order to run them.
   * @throws When a name or the dimension cannot be written into SQL as given.
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
   * Take the caller's pool or open one, then, unless `manageSchema` is false, ensure the pgvector extension
   * exists and create the collections metadata table.
   *
   * @throws When the configuration holds neither a connection string nor a pool.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.config.pool) {
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

  /** Close the pool the store opened; a caller's pool is left open. */
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
  // Collection Management
  // =========================================================================

  /**
   * Create a new collection (Postgres table) with pgvector HNSW index. Each index is made only when the table
   * has none of its kind, under a name that carries the table prefix. With `manageSchema: false` this does
   * nothing: the caller's migrations made the table.
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
        await this._ensureIndex(name, 'fts', 'USING gin (tsv)');
      } catch {
        // Another caller added the column between the read and the ALTER.
      }
    } else {
      // A table that has the column may still lack its index: before index
      // names carried the prefix, a second prefix's collection got none.
      await this._ensureIndex(name, 'fts', 'USING gin (tsv)');
    }

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
   * Upsert documents into a collection.
   * Uses INSERT ... ON CONFLICT (id) DO UPDATE for idempotent writes.
   */
  async upsert(
    collectionName: string,
    documents: VectorDocument[],
    _options?: UpsertOptions,
  ): Promise<UpsertResult> {
    await this._ensureInit();
    const table = this._t(collectionName);
    const now = Date.now();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const doc of documents) {
        // Convert embedding to pgvector string format: '[0.1,0.2,...]'
        const vecStr = `[${doc.embedding.join(',')}]`;
        const metaJson = doc.metadata ? JSON.stringify(doc.metadata) : null;
        const text = doc.textContent ?? null;

        await client.query(
          `INSERT INTO ${table} (id, embedding, metadata_json, text_content, created_at, updated_at)
           VALUES ($1, $2::vector, $3::jsonb, $4, $5, $5)
           ON CONFLICT (id) DO UPDATE SET
             embedding = EXCLUDED.embedding,
             metadata_json = EXCLUDED.metadata_json,
             text_content = EXCLUDED.text_content,
             updated_at = EXCLUDED.updated_at`,
          [doc.id, vecStr, metaJson, text, now],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return {
      upsertedCount: documents.length,
      upsertedIds: documents.map(d => d.id),
      failedCount: 0,
    };
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
        similarityScore: row.rrf_score,
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
   * another schema does not count.
   */
  private async _ensureIndex(collection: string, suffix: string, using: string): Promise<void> {
    const tableName = `${this.prefix}${collection}`;
    // pg_indexes.indexdef prints `USING hnsw (embedding vector_cosine_ops)`, `USING gin (metadata_json)` and
    // `USING gin (tsv)`, so the text up to the first closing bracket matches an index of an older name too.
    const marker = using.slice(0, using.indexOf(')') + 1);
    const existing = await this.pool.query(
      'SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1',
      [tableName],
    );
    if (existing.rows.some((row: { indexdef: string }) => row.indexdef.includes(marker))) return;
    const indexName = PostgresVectorStore.quoted(`${tableName}_${suffix}`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${this._t(collection)} ${using}`);
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
   * Runs one search statement, inside a transaction with the search settings when there are any, so the
   * settings stay on one connection for one statement and never reach the pool's other users.
   */
  private async _search(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> {
    const settings = this._searchSettings();
    if (settings.length === 0) return this.pool.query(sql, params);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const setting of settings) await client.query(setting);
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // the connection is gone; the first error is the one to report
      }
      throw err;
    } finally {
      client.release();
    }
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
   * Build JSONB metadata filter SQL clauses.
   * Uses Postgres JSONB operators for efficient GIN-indexed filtering. `$in`, `$nin`, `$all` and `$contains`
   * also read a field that holds an array: `$in` matches when the array holds a string in the list, `$nin` when
   * it holds none, `$all` when it holds every value, and `$contains` when it holds the string.
   *
   * @param filter   - MetadataFilter to translate.
   * @param startIdx - Starting parameter index ($N).
   * @returns SQL WHERE clause and parameter values.
   * @throws When a key is not letters, digits, underscore, dot or hyphen.
   */
  private _buildMetadataFilter(
    filter: MetadataFilter,
    startIdx: number,
  ): { clause: string; filterParams: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = startIdx;

    for (const [field, condition] of Object.entries(filter)) {
      const key = this._field(field);
      const path = `metadata_json->>'${key}'`;
      const json = `metadata_json->'${key}'`;

      // Direct scalar match (implicit $eq).
      if (typeof condition !== 'object' || condition === null) {
        conditions.push(`${path} = $${idx}`);
        params.push(String(condition));
        idx++;
        continue;
      }

      const cond = condition as MetadataFieldCondition;

      if (cond.$eq !== undefined) {
        conditions.push(`${path} = $${idx}`);
        params.push(String(cond.$eq));
        idx++;
      }
      if (cond.$ne !== undefined) {
        conditions.push(`${path} != $${idx}`);
        params.push(String(cond.$ne));
        idx++;
      }
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
        conditions.push(`(CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${json} ?| $${idx}::text[] ELSE ${path} = ANY($${idx}::text[]) END)`);
        params.push(cond.$in.map(String));
        idx++;
      }
      if (cond.$nin !== undefined && Array.isArray(cond.$nin)) {
        conditions.push(`(${json} IS NOT NULL AND NOT (CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${json} ?| $${idx}::text[] ELSE ${path} = ANY($${idx}::text[]) END))`);
        params.push(cond.$nin.map(String));
        idx++;
      }
      if (cond.$all !== undefined && Array.isArray(cond.$all)) {
        conditions.push(`${json} @> $${idx}::jsonb`);
        params.push(JSON.stringify(cond.$all));
        idx++;
      }
      if (cond.$exists !== undefined) {
        conditions.push(cond.$exists ? `metadata_json ? '${key}'` : `NOT (metadata_json ? '${key}')`);
      }
      if (cond.$contains !== undefined) {
        conditions.push(`(CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${json} ? $${idx} ELSE ${path} LIKE $${idx + 1} END)`);
        params.push(String(cond.$contains), `%${cond.$contains}%`);
        idx += 2;
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
