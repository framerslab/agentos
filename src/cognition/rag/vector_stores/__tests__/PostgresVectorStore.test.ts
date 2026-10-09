/**
 * @fileoverview Unit tests for PostgresVectorStore with fully mocked pg module.
 *
 * These tests verify the SQL generation and parameter handling of every public
 * method WITHOUT requiring a running Postgres instance. The pg module is
 * replaced by vi.mock() stubs that record calls and return canned results.
 *
 * @module rag/vector_stores/__tests__/PostgresVectorStore.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock pg module — must be declared before importing the class under test.
// ---------------------------------------------------------------------------

/** Captured SQL statements + params from pool.query() calls. */
const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];

/** Result returned by the next pool.query() call. Override per-test. */
let nextQueryResult: { rows: any[]; rowCount?: number } = { rows: [], rowCount: 0 };

/** Queue of query results (FIFO); if non-empty, takes precedence over nextQueryResult. */
const queryResultQueue: Array<{ rows: any[]; rowCount?: number }> = [];

/** Mock client returned by pool.connect(). */
const mockClient = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
    if (queryResultQueue.length > 0) return queryResultQueue.shift()!;
    return nextQueryResult;
  }),
  release: vi.fn(),
};

/** Default pool.query behaviour: record the call, answer from the queue or the canned result. */
async function recordPoolQuery(sql: string, params?: unknown[]) {
  queryCalls.push({ sql, params });
  if (queryResultQueue.length > 0) return queryResultQueue.shift()!;
  return nextQueryResult;
}

/** Mock Pool class. */
const mockPool = {
  query: vi.fn(recordPoolQuery),
  connect: vi.fn(async () => mockClient),
  end: vi.fn(async () => {}),
};

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(function () {
      return mockPool;
    }),
  },
}));

// ---------------------------------------------------------------------------
// Import class under test after mocks are installed.
// ---------------------------------------------------------------------------

import { PostgresVectorStore } from '../PostgresVectorStore.js';
import type { PostgresVectorStoreConfig } from '../PostgresVectorStore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<PostgresVectorStoreConfig>): PostgresVectorStoreConfig {
  return {
    id: 'test-pg',
    type: 'postgres',
    connectionString: 'postgresql://test:test@localhost:5432/testdb',
    poolSize: 2,
    defaultDimension: 4,
    similarityMetric: 'cosine',
    tablePrefix: '',
    ...overrides,
  };
}

function lastQuery() {
  return queryCalls[queryCalls.length - 1];
}

/**
 * Make collection tables look like ones created before the `tsv` column:
 * the read of `tsv` fails the way Postgres fails it.
 */
function tsvColumnIsMissing() {
  mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/^\s*SELECT tsv FROM /.test(sql)) {
      queryCalls.push({ sql, params });
      throw new Error('column "tsv" does not exist');
    }
    return recordPoolQuery(sql, params);
  });
}

function resetMocks() {
  queryCalls.length = 0;
  queryResultQueue.length = 0;
  nextQueryResult = { rows: [], rowCount: 0 };
  mockPool.query.mockClear();
  mockPool.query.mockImplementation(recordPoolQuery);
  mockClient.query.mockClear();
  mockClient.release.mockClear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgresVectorStore', () => {
  let store: PostgresVectorStore;

  beforeEach(() => {
    resetMocks();
  });

  afterEach(async () => {
    try {
      await store?.close();
    } catch { /* already closed */ }
    resetMocks();
  });

  // =========================================================================
  // initialize()
  // =========================================================================

  describe('initialize()', () => {
    it('calls CREATE EXTENSION vector and creates _collections table', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();

      // First query should be CREATE EXTENSION
      const extensionCall = queryCalls.find(c => c.sql.includes('CREATE EXTENSION'));
      expect(extensionCall).toBeDefined();
      expect(extensionCall!.sql).toContain('CREATE EXTENSION IF NOT EXISTS vector');

      // Second query should create the _collections metadata table.
      const createTableCall = queryCalls.find(c => c.sql.includes('_collections'));
      expect(createTableCall).toBeDefined();
      expect(createTableCall!.sql).toContain('CREATE TABLE IF NOT EXISTS');
      expect(createTableCall!.sql).toContain('name TEXT PRIMARY KEY');
      expect(createTableCall!.sql).toContain('dimension INTEGER NOT NULL');
    });

    it('is idempotent — second call is a no-op', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      const callCount = queryCalls.length;
      await store.initialize();
      expect(queryCalls.length).toBe(callCount); // No new queries
    });
  });

  // =========================================================================
  // createCollection()
  // =========================================================================

  describe('createCollection()', () => {
    it('creates table with vector column, HNSW index, GIN index, tsvector, and FTS index', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();
      tsvColumnIsMissing();

      await store.createCollection('my_docs', 4, { similarityMetric: 'cosine' });

      // Should have: CREATE TABLE, CREATE INDEX (hnsw), CREATE INDEX (gin metadata),
      // a read of tsv, ALTER TABLE (tsvector), CREATE INDEX (fts), INSERT into _collections.
      const createTable = queryCalls.find(c => c.sql.includes('CREATE TABLE') && c.sql.includes('my_docs'));
      expect(createTable).toBeDefined();
      expect(createTable!.sql).toContain('vector(4)');
      expect(createTable!.sql).toContain('metadata_json JSONB');
      expect(createTable!.sql).toContain('text_content TEXT');

      // HNSW index with correct ops class.
      const hnswIdx = queryCalls.find(c => c.sql.includes('hnsw') && c.sql.includes('vector_cosine_ops'));
      expect(hnswIdx).toBeDefined();

      // GIN index for metadata.
      const ginIdx = queryCalls.find(c => c.sql.includes('gin') && c.sql.includes('metadata_json'));
      expect(ginIdx).toBeDefined();

      // Tsvector column and its full-text index.
      const tsvCol = queryCalls.find(c => c.sql.includes('tsvector'));
      expect(tsvCol).toBeDefined();
      const ftsIdx = queryCalls.find(c => c.sql.includes('my_docs_fts'));
      expect(ftsIdx).toBeDefined();

      // Each index is made after a read of the indexes the table already has.
      const steps = queryCalls
        .map(c => (c.sql.includes('FROM pg_indexes') ? 'read' : c.sql.startsWith('CREATE INDEX') ? 'index' : ''))
        .filter(step => step !== '');
      expect(steps).toEqual(['read', 'index', 'read', 'index', 'read', 'index']);
      expect(queryCalls.filter(c => c.sql.includes('FROM pg_indexes')).map(c => c.params)).toEqual([['my_docs'], ['my_docs'], ['my_docs']]);
      expect(queryCalls.filter(c => c.sql.startsWith('CREATE INDEX')).map(c => c.sql)).toEqual([
        'CREATE INDEX IF NOT EXISTS "my_docs_hnsw" ON "my_docs" USING hnsw (embedding vector_cosine_ops)',
        'CREATE INDEX IF NOT EXISTS "my_docs_metadata" ON "my_docs" USING gin (metadata_json)',
        'CREATE INDEX IF NOT EXISTS "my_docs_fts" ON "my_docs" USING gin (tsv)',
      ]);

      // _collections registration.
      const reg = queryCalls.find(c => c.sql.includes('INSERT INTO') && c.sql.includes('_collections'));
      expect(reg).toBeDefined();
      expect(reg!.params).toEqual(['my_docs', 4, 'cosine']);
    });

    // ALTER TABLE takes an ACCESS EXCLUSIVE lock even when the column exists.
    // That lock waits behind every open reader of the table (a pg_dump reads
    // it for its whole run) and later queries queue behind it, so a
    // collection that already has the column must see no ALTER.
    it('leaves a collection that already has the tsv column without an ALTER TABLE', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      await store.createCollection('my_docs', 4, { similarityMetric: 'cosine' });

      expect(queryCalls.some(c => c.sql.includes('SELECT tsv FROM'))).toBe(true);
      expect(queryCalls.filter(c => /ALTER\s+TABLE/i.test(c.sql))).toEqual([]);
      // The column is there, and its index is made when the table has none.
      expect(queryCalls.some(c => c.sql === 'CREATE INDEX IF NOT EXISTS "my_docs_fts" ON "my_docs" USING gin (tsv)')).toBe(true);
      const reg = queryCalls.find(c => c.sql.includes('INSERT INTO') && c.sql.includes('_collections'));
      expect(reg).toBeDefined();
    });

    it('uses vector_l2_ops for euclidean metric', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      await store.createCollection('l2_coll', 4, { similarityMetric: 'euclidean' });
      const hnswIdx = queryCalls.find(c => c.sql.includes('hnsw') && c.sql.includes('vector_l2_ops'));
      expect(hnswIdx).toBeDefined();
    });

    it('uses vector_ip_ops for dotproduct metric', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      await store.createCollection('ip_coll', 4, { similarityMetric: 'dotproduct' });
      const hnswIdx = queryCalls.find(c => c.sql.includes('hnsw') && c.sql.includes('vector_ip_ops'));
      expect(hnswIdx).toBeDefined();
    });
  });

  // =========================================================================
  // upsert()
  // =========================================================================

  describe('upsert()', () => {
    it('calls INSERT ... ON CONFLICT with correct params inside a transaction', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      const docs = [
        { id: 'doc-1', embedding: [0.1, 0.2, 0.3, 0.4], metadata: { topic: 'testing' }, textContent: 'hello world' },
        { id: 'doc-2', embedding: [0.5, 0.6, 0.7, 0.8] },
      ];

      const result = await store.upsert('my_docs', docs);

      // Verify transaction lifecycle.
      const beginIdx = queryCalls.findIndex(c => c.sql === 'BEGIN');
      const commitIdx = queryCalls.findIndex(c => c.sql === 'COMMIT');
      expect(beginIdx).toBeGreaterThanOrEqual(0);
      expect(commitIdx).toBeGreaterThan(beginIdx);

      // Verify INSERT ... ON CONFLICT for each document.
      const inserts = queryCalls.filter(c => c.sql.includes('INSERT INTO') && c.sql.includes('ON CONFLICT'));
      expect(inserts.length).toBe(2);

      // First insert should have the correct vector string and metadata.
      expect(inserts[0].params![0]).toBe('doc-1');
      expect(inserts[0].params![1]).toBe('[0.1,0.2,0.3,0.4]');
      expect(inserts[0].params![2]).toBe(JSON.stringify({ topic: 'testing' }));
      expect(inserts[0].params![3]).toBe('hello world');

      // Result counts.
      expect(result.upsertedCount).toBe(2);
      expect(result.failedCount).toBe(0);
    });

    it('rolls back on error', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      // Make the insert throw.
      mockClient.query.mockImplementationOnce(async (sql: string, params?: unknown[]) => {
        queryCalls.push({ sql, params });
        return nextQueryResult;
      }).mockImplementationOnce(async (sql: string) => {
        queryCalls.push({ sql });
        throw new Error('disk full');
      });

      await expect(
        store.upsert('my_docs', [{ id: 'x', embedding: [1, 2, 3, 4] }]),
      ).rejects.toThrow('disk full');

      const rollback = queryCalls.find(c => c.sql === 'ROLLBACK');
      expect(rollback).toBeDefined();
    });
  });

  // =========================================================================
  // query()
  // =========================================================================

  describe('query()', () => {
    it('builds correct SQL with cosine distance operator and returns documents', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      // Queue: first call is _getCollectionMeta, second is the actual query.
      queryResultQueue.push({
        rows: [{ name: 'my_docs', dimension: 4, metric: 'cosine' }],
      });
      queryResultQueue.push({
        rows: [
          { id: 'r1', embedding: '[0.1,0.2,0.3,0.4]', metadata_json: { topic: 'test' }, text_content: 'hello', distance: 0.1 },
          { id: 'r2', embedding: '[0.5,0.6,0.7,0.8]', metadata_json: null, text_content: null, distance: 0.3 },
        ],
        rowCount: 2,
      });

      const result = await store.query('my_docs', [0.1, 0.2, 0.3, 0.4], {
        topK: 5,
        includeMetadata: true,
        includeTextContent: true,
      });

      // Verify the query SQL uses the cosine operator <=>.
      const queryCall = queryCalls.find(c => c.sql.includes('<=>'));
      expect(queryCall).toBeDefined();
      expect(queryCall!.sql).toContain('ORDER BY');
      expect(queryCall!.sql).toContain('LIMIT');
      expect(queryCall!.params).toContain('[0.1,0.2,0.3,0.4]');

      // Verify result documents.
      expect(result.documents.length).toBe(2);
      expect(result.documents[0].id).toBe('r1');
      // Cosine: similarity = 1 - distance
      expect(result.documents[0].similarityScore).toBeCloseTo(0.9);
      expect(result.documents[0].metadata).toEqual({ topic: 'test' });
    });

    it('applies metadata filters to WHERE clause', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      queryResultQueue.push({
        rows: [{ name: 'my_docs', dimension: 4, metric: 'cosine' }],
      });
      queryResultQueue.push({ rows: [], rowCount: 0 });

      await store.query('my_docs', [0.1, 0.2, 0.3, 0.4], {
        topK: 3,
        filter: {
          topic: { $eq: 'science' },
          year: { $gt: 2020 },
          status: { $in: ['draft', 'published'] },
        },
      });

      const queryCall = queryCalls.find(c => c.sql.includes('metadata_json'));
      expect(queryCall).toBeDefined();
      expect(queryCall!.sql).toContain("metadata_json->>'topic'");
      expect(queryCall!.sql).toContain('::numeric >');
      expect(queryCall!.sql).toContain("(CASE WHEN jsonb_typeof(metadata_json->'status') = 'array' THEN metadata_json->'status' @> ANY($5::jsonb[]) ELSE metadata_json->>'status' = ANY($4::text[]) END)");
    });
  });

  describe('fetchByIds()', () => {
    it('fetches rows by primary key without similarity ordering', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      queryResultQueue.push({
        rows: [
          { id: 'doc-1', embedding: '[0.1,0.2,0.3,0.4]', metadata_json: { topic: 'a' }, text_content: 'content a' },
          { id: 'doc-2', embedding: '[0.5,0.6,0.7,0.8]', metadata_json: { topic: 'b' }, text_content: 'content b' },
        ],
        rowCount: 2,
      });

      const docs = await store.fetchByIds('my_docs', ['doc-1', 'doc-2'], {
        includeMetadata: true,
        includeTextContent: true,
      });

      const select = queryCalls.find(c => c.sql.includes('SELECT') && c.sql.includes('my_docs'));
      expect(select).toBeDefined();
      // Primary-key fetch: id = ANY($1::text[]) — no cosine operator, no ORDER BY.
      expect(select!.sql).toMatch(/id = ANY\(\$1::text\[\]\)/);
      expect(select!.sql).not.toMatch(/<=>/);
      expect(select!.sql).not.toMatch(/ORDER BY/);
      expect(select!.params![0]).toEqual(['doc-1', 'doc-2']);

      expect(docs.length).toBe(2);
      expect(docs[0].id).toBe('doc-1');
      // similarityScore is 0 — fetchByIds doesn't rank, the sentinel value
      // tells callers not to interpret it as a real cosine number.
      expect(docs[0].similarityScore).toBe(0);
      expect(docs[0].metadata).toEqual({ topic: 'a' });
      expect(docs[0].textContent).toBe('content a');
    });

    it('returns [] for empty id list without hitting the DB', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      const docs = await store.fetchByIds('my_docs', []);

      expect(docs).toEqual([]);
      // No SELECT fired — empty id list short-circuits.
      expect(queryCalls.find(c => c.sql.includes('SELECT') && c.sql.includes('my_docs'))).toBeUndefined();
    });

    it('omits metadata + textContent when options disable them', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      queryResultQueue.push({
        rows: [
          { id: 'doc-1', embedding: '[0.1,0.2,0.3,0.4]', metadata_json: { topic: 'a' }, text_content: 'content a' },
        ],
        rowCount: 1,
      });

      const docs = await store.fetchByIds('my_docs', ['doc-1'], {
        includeMetadata: false,
        includeTextContent: false,
      });

      expect(docs[0].metadata).toBeUndefined();
      expect(docs[0].textContent).toBeUndefined();
    });
  });

  describe('scanByMetadata()', () => {
    it('returns filtered documents with metadata, text, and embeddings', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      nextQueryResult = {
        rows: [
          {
            id: 'expired',
            embedding: '[1,0,0,0]',
            metadata_json: { status: 'expired', timestamp: '2026-01-01T00:00:00.000Z' },
            text_content: 'old doc',
          },
          {
            id: 'fresh',
            embedding: '[0,1,0,0]',
            metadata_json: { status: 'fresh', timestamp: '2026-04-21T00:00:00.000Z' },
            text_content: 'fresh doc',
          },
        ],
        rowCount: 2,
      };

      const result = await store.scanByMetadata?.('my_docs', {
        filter: { status: 'expired' },
        includeMetadata: true,
        includeTextContent: true,
        includeEmbedding: true,
      });

      expect(lastQuery().sql).toContain('SELECT id, embedding::text, metadata_json, text_content');
      expect(result?.documents.map((doc) => doc.id)).toEqual(['expired']);
      expect(result?.documents[0]?.textContent).toBe('old doc');
      expect(result?.documents[0]?.metadata).toEqual({
        status: 'expired',
        timestamp: '2026-01-01T00:00:00.000Z',
      });
      expect(result?.documents[0]?.embedding).toEqual([1, 0, 0, 0]);
    });
  });

  // =========================================================================
  // hybridSearch()
  // =========================================================================

  describe('hybridSearch()', () => {
    it('builds RRF CTE query with dense + lexical CTEs', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      queryResultQueue.push({
        rows: [{ name: 'my_docs', dimension: 4, metric: 'cosine' }],
      });
      queryResultQueue.push({
        rows: [
          { id: 'h1', rrf_score: 0.025, embedding: '[0.1,0.2,0.3,0.4]', metadata_json: null, text_content: 'match' },
        ],
        rowCount: 1,
      });

      const result = await store.hybridSearch('my_docs', [0.1, 0.2, 0.3, 0.4], 'test query', {
        topK: 5,
        rrfK: 60,
      });

      // Verify the query contains the dense and lexical CTEs.
      const hybridCall = queryCalls.find(c => c.sql.includes('WITH dense AS'));
      expect(hybridCall).toBeDefined();
      expect(hybridCall!.sql).toContain('lexical AS');
      expect(hybridCall!.sql).toContain('fused AS');
      expect(hybridCall!.sql).toContain('plainto_tsquery');
      expect(hybridCall!.sql).toContain('rrf_score');

      // Params: [vecStr, queryText, candidatePool, rrfK, topK]
      expect(hybridCall!.params![0]).toBe('[0.1,0.2,0.3,0.4]');
      expect(hybridCall!.params![1]).toBe('test query');
      expect(hybridCall!.params![3]).toBe(60); // rrfK
      expect(hybridCall!.params![4]).toBe(5);  // topK

      expect(result.documents.length).toBe(1);
      expect(result.documents[0].similarityScore).toBeCloseTo(0.025);
    });

    it('filters dense and lexical candidates before ranking with stable parameter indexes', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      queryResultQueue.push({
        rows: [{ name: 'my_docs', dimension: 4, metric: 'cosine' }],
      });
      queryResultQueue.push({ rows: [], rowCount: 0 });

      await store.hybridSearch('my_docs', [0.1, 0.2, 0.3, 0.4], 'public docs', {
        topK: 5,
        rrfK: 60,
        filter: {
          visibility: { $eq: 'public' },
          product: { $in: ['agentos', 'frame'] },
        },
      });

      const hybridCall = queryCalls.find(c => c.sql.includes('WITH dense AS'));
      expect(hybridCall).toBeDefined();

      const denseEnd = hybridCall!.sql.indexOf('lexical AS');
      const lexicalEnd = hybridCall!.sql.indexOf('fused AS');
      const denseSql = hybridCall!.sql.slice(0, denseEnd);
      const lexicalSql = hybridCall!.sql.slice(denseEnd, lexicalEnd);
      const filterSql = "metadata_json->>'visibility' = $3 AND (CASE WHEN jsonb_typeof(metadata_json->'product') = 'array' THEN metadata_json->'product' @> ANY($5::jsonb[]) ELSE metadata_json->>'product' = ANY($4::text[]) END)";

      expect(denseSql).toContain(`WHERE ${filterSql}`);
      expect(lexicalSql).toContain(`AND ${filterSql}`);
      expect(hybridCall!.sql.match(/LIMIT \$6/g)).toHaveLength(2);
      expect(hybridCall!.sql).toContain('$7 + COALESCE(d.rank');
      expect(hybridCall!.sql).toContain('LIMIT $8');
      expect(hybridCall!.params).toEqual([
        '[0.1,0.2,0.3,0.4]',
        'public docs',
        'public',
        ['agentos', 'frame'],
        ['["agentos"]', '["frame"]'],
        15,
        60,
        5,
      ]);
    });
  });

  // =========================================================================
  // delete()
  // =========================================================================

  describe('delete()', () => {
    it('deletes by IDs with correct SQL', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();
      nextQueryResult = { rows: [], rowCount: 2 };

      const result = await store.delete('my_docs', ['a', 'b']);

      const delCall = queryCalls.find(c => c.sql.includes('DELETE FROM') && c.sql.includes('IN'));
      expect(delCall).toBeDefined();
      expect(delCall!.params).toEqual(['a', 'b']);
      expect(result.deletedCount).toBe(2);
    });

    it('deleteAll sends DELETE without WHERE', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();
      nextQueryResult = { rows: [], rowCount: 50 };

      const result = await store.delete('my_docs', undefined, { deleteAll: true });

      const delCall = queryCalls.find(c => c.sql.includes('DELETE FROM') && !c.sql.includes('IN'));
      expect(delCall).toBeDefined();
      expect(result.deletedCount).toBe(50);
    });

    it('returns 0 deleted when no ids and not deleteAll', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      const result = await store.delete('my_docs', []);
      expect(result.deletedCount).toBe(0);
    });
  });

  // =========================================================================
  // healthCheck()
  // =========================================================================

  describe('healthCheck()', () => {
    it('returns true on successful SELECT 1', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();
      nextQueryResult = { rows: [{ ok: 1 }] };

      const ok = await store.healthCheck();
      expect(ok).toBe(true);
    });

    it('returns false when query fails', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();
      mockPool.query.mockRejectedValueOnce(new Error('connection refused'));

      const ok = await store.healthCheck();
      expect(ok).toBe(false);
    });
  });

  // =========================================================================
  // _buildMetadataFilter() (tested indirectly via query)
  // =========================================================================

  describe('_buildMetadataFilter (via query)', () => {
    it('translates $eq correctly', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      queryResultQueue.push({ rows: [{ name: 'c', dimension: 4, metric: 'cosine' }] });
      queryResultQueue.push({ rows: [] });

      await store.query('c', [1, 2, 3, 4], {
        filter: { status: { $eq: 'active' } },
      });

      const q = queryCalls.find(c => c.sql.includes("metadata_json->>'status'") && c.sql.includes('='));
      expect(q).toBeDefined();
      expect(q!.params).toContain('active');
    });

    it('translates $gt correctly with numeric cast', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      queryResultQueue.push({ rows: [{ name: 'c', dimension: 4, metric: 'cosine' }] });
      queryResultQueue.push({ rows: [] });

      await store.query('c', [1, 2, 3, 4], {
        filter: { score: { $gt: 0.8 } },
      });

      const q = queryCalls.find(c => c.sql.includes('::numeric >'));
      expect(q).toBeDefined();
      expect(q!.params).toContain(0.8);
    });

    it('translates $in to a match on the value, or on an array that shares one', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      queryResultQueue.push({ rows: [{ name: 'c', dimension: 4, metric: 'cosine' }] });
      queryResultQueue.push({ rows: [] });

      await store.query('c', [1, 2, 3, 4], {
        filter: { category: { $in: ['a', 'b', 'c'] } },
      });

      const q = queryCalls.find(c => c.sql.includes('= ANY('));
      expect(q).toBeDefined();
      expect(q!.sql).toContain("(CASE WHEN jsonb_typeof(metadata_json->'category') = 'array' THEN metadata_json->'category' @> ANY($3::jsonb[]) ELSE metadata_json->>'category' = ANY($2::text[]) END)");
      // A single value is compared as text; an array's elements are compared as JSON values.
      expect(q!.params).toContainEqual(['a', 'b', 'c']);
      expect(q!.params).toContainEqual(['["a"]', '["b"]', '["c"]']);
    });
  });

  // =========================================================================
  // Table prefix (multi-tenancy)
  // =========================================================================

  describe('tablePrefix', () => {
    it('prefixes all table names when tablePrefix is set', async () => {
      store = new PostgresVectorStore(makeConfig({ tablePrefix: 'tenant1_' }));
      await store.initialize();

      // The collections metadata table should be prefixed.
      const prefixed = queryCalls.find(c => c.sql.includes('"tenant1__collections"'));
      expect(prefixed).toBeDefined();
    });

    it('doubles a double quote in the prefix or the collection name, so each name stays one identifier', async () => {
      store = new PostgresVectorStore(makeConfig({ tablePrefix: 'te"n_' }));
      await store.initialize();
      expect(queryCalls.some(c => c.sql.includes('CREATE TABLE IF NOT EXISTS "te""n__collections" ('))).toBe(true);
      resetMocks();

      await store.createCollection('chu"nks', 4);
      expect(queryCalls[0].sql).toContain('CREATE TABLE IF NOT EXISTS "te""n_chu""nks" (');
      expect(queryCalls.filter(c => c.sql.includes('FROM pg_indexes')).map(c => c.params)).toEqual([['te"n_chu"nks'], ['te"n_chu"nks'], ['te"n_chu"nks']]);
      expect(queryCalls.filter(c => c.sql.startsWith('CREATE INDEX')).map(c => c.sql)).toEqual([
        'CREATE INDEX IF NOT EXISTS "te""n_chu""nks_hnsw" ON "te""n_chu""nks" USING hnsw (embedding vector_cosine_ops)',
        'CREATE INDEX IF NOT EXISTS "te""n_chu""nks_metadata" ON "te""n_chu""nks" USING gin (metadata_json)',
        'CREATE INDEX IF NOT EXISTS "te""n_chu""nks_fts" ON "te""n_chu""nks" USING gin (tsv)',
      ]);

      resetMocks();
      await store.delete('chu"nks', undefined, { filter: { sourceId: 's1' } });
      expect(queryCalls[0]).toEqual({ sql: `DELETE FROM "te""n_chu""nks" WHERE metadata_json->>'sourceId' = $1`, params: ['s1'] });
    });
  });

  // =========================================================================
  // Scoped retrieval (many tenants in one collection)
  // =========================================================================

  describe('scoped retrieval (many tenants in one collection)', () => {
    const base = { id: 'pg', type: 'postgres' as const, connectionString: 'postgres://test' };

    it('runs no DDL when manageSchema is false, and reads no collections table', async () => {
      const store = new PostgresVectorStore({ ...base, manageSchema: false, similarityMetric: 'cosine' });
      await store.initialize();
      await store.createCollection('chunks', 8);
      expect(queryCalls).toEqual([]);
      await store.query('chunks', [0, 0, 0, 0, 0, 0, 0, 0], { topK: 3 });
      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].sql).not.toContain('_collections');
      expect(queryCalls[0].sql).toContain('<=>');
    });

    it("refuses to drop a collection whose tables are the caller's", async () => {
      const store = new PostgresVectorStore({ ...base, manageSchema: false });
      await expect(store.dropCollection('chunks')).rejects.toThrow('manageSchema: false');
      expect(queryCalls).toEqual([]);
    });

    it('uses a pool the caller owns and never ends it', async () => {
      const owned = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn(async () => mockClient), end: vi.fn(async () => {}) };
      const store = new PostgresVectorStore({ id: 'pg', type: 'postgres', pool: owned, manageSchema: false });
      await store.initialize();
      await store.query('chunks', [0, 0, 0], { topK: 1 });
      await store.close();
      expect(owned.query).toHaveBeenCalledTimes(1);
      expect(owned.end).not.toHaveBeenCalled();
    });

    it('refuses to start with neither a connection string nor a pool', async () => {
      const store = new PostgresVectorStore({ id: 'pg', type: 'postgres' });
      await expect(store.initialize()).rejects.toThrow('connectionString or a pool');
    });

    it('prints the schema a migration can run', () => {
      expect(PostgresVectorStore.schemaSql('chunks', 1536, { tablePrefix: 'library_', textSearchConfig: 'simple' })).toEqual([
        `CREATE TABLE IF NOT EXISTS "library_chunks" (id TEXT PRIMARY KEY, embedding vector(1536), metadata_json JSONB, text_content TEXT, created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT, updated_at BIGINT, tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE(text_content, ''))) STORED)`,
        `CREATE INDEX IF NOT EXISTS "library_chunks_hnsw" ON "library_chunks" USING hnsw (embedding vector_cosine_ops)`,
        `CREATE INDEX IF NOT EXISTS "library_chunks_metadata" ON "library_chunks" USING gin (metadata_json)`,
        `CREATE INDEX IF NOT EXISTS "library_chunks_fts" ON "library_chunks" USING gin (tsv)`,
      ]);
      expect(() => PostgresVectorStore.schemaSql('chunks', 8, { textSearchConfig: "simple'); DROP" })).toThrow('text search configuration');
      expect(() => PostgresVectorStore.schemaSql('chu"nks', 8)).toThrow('collection name');
    });

    it('takes the metric alone as the third argument of schemaSql', () => {
      const statements = PostgresVectorStore.schemaSql('chunks', 4, 'euclidean');
      expect(statements[0]).toContain(`CREATE TABLE IF NOT EXISTS "chunks" (`);
      expect(statements[0]).toContain(`to_tsvector('english'::regconfig, COALESCE(text_content, ''))`);
      expect(statements[1]).toBe(`CREATE INDEX IF NOT EXISTS "chunks_hnsw" ON "chunks" USING hnsw (embedding vector_l2_ops)`);
      expect(() => PostgresVectorStore.schemaSql('chunks', 0)).toThrow('dimension');
    });

    it('names the indexes after the prefixed table, and adds none the table already has', async () => {
      const store = new PostgresVectorStore({ ...base, tablePrefix: 'tenant1_' });
      await store.initialize();
      resetMocks();
      tsvColumnIsMissing();
      // The CREATE TABLE answers first; then the read of the table's indexes finds an HNSW index made under an older name.
      queryResultQueue.push({ rows: [], rowCount: 0 });
      queryResultQueue.push({ rows: [{ indexdef: 'CREATE INDEX chunks_hnsw ON public.tenant1_chunks USING hnsw (embedding vector_cosine_ops)' }] });
      await store.createCollection('chunks', 8);
      const reads = queryCalls.filter((call) => call.sql.includes('FROM pg_indexes'));
      expect(reads.map((call) => call.params)).toEqual([['tenant1_chunks'], ['tenant1_chunks'], ['tenant1_chunks']]);
      expect(queryCalls.filter((call) => call.sql.startsWith('CREATE INDEX')).map((call) => call.sql)).toEqual([
        `CREATE INDEX IF NOT EXISTS "tenant1_chunks_metadata" ON "tenant1_chunks" USING gin (metadata_json)`,
        `CREATE INDEX IF NOT EXISTS "tenant1_chunks_fts" ON "tenant1_chunks" USING gin (tsv)`,
      ]);
    });

    it("reads the indexes of the table in the store's own schema, so a same-named table in another schema does not count", async () => {
      const store = new PostgresVectorStore({ ...base, tablePrefix: 'tenant1_' });
      await store.initialize();
      resetMocks();
      await store.createCollection('chunks', 8);
      const read = { sql: 'SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1', params: ['tenant1_chunks'] };
      expect(queryCalls.filter((call) => call.sql.includes('FROM pg_indexes'))).toEqual([read, read, read]);
    });

    it('matches an array field with $in, $nin, $all and $contains', async () => {
      const store = new PostgresVectorStore({ ...base, manageSchema: false });
      await store.query('chunks', [0, 0], {
        topK: 5,
        filter: { tenantId: 'org1', aclGroups: { $in: ['acct:a', 'org:org1'] }, tags: { $all: ['q3', 'budget'] }, status: { $nin: ['archived'] }, labels: { $contains: 'x' } },
      });
      const { sql, params } = queryCalls[0];
      expect(sql).toContain(`metadata_json->>'tenantId' = $2`);
      expect(sql).toContain(`(CASE WHEN jsonb_typeof(metadata_json->'aclGroups') = 'array' THEN metadata_json->'aclGroups' @> ANY($4::jsonb[]) ELSE metadata_json->>'aclGroups' = ANY($3::text[]) END)`);
      expect(sql).toContain(`metadata_json->'tags' @> $5::jsonb`);
      expect(sql).toContain(`(metadata_json->'status' IS NOT NULL AND NOT (CASE WHEN jsonb_typeof(metadata_json->'status') = 'array' THEN metadata_json->'status' @> ANY($7::jsonb[]) ELSE metadata_json->>'status' = ANY($6::text[]) END))`);
      expect(sql).toContain(`(CASE WHEN jsonb_typeof(metadata_json->'labels') = 'array' THEN metadata_json->'labels' @> $8::jsonb ELSE metadata_json->>'labels' LIKE $9 END)`);
      expect(params).toEqual(['[0,0]', 'org1', ['acct:a', 'org:org1'], ['["acct:a"]', '["org:org1"]'], '["q3","budget"]', ['archived'], ['["archived"]'], '["x"]', '%x%', 5]);
    });

    it('refuses a metadata key that is not a plain name', async () => {
      const store = new PostgresVectorStore({ ...base, manageSchema: false });
      await expect(store.query('chunks', [0], { filter: { "x' OR 1=1 --": 'y' } })).rejects.toThrow('metadata key');
    });

    it('refuses a condition it cannot write into SQL, so no deletion, change or search runs wider than its filter', async () => {
      const store = new PostgresVectorStore({ ...base, manageSchema: false });
      const notAnArray = { $in: 'org1' as unknown as string[] };
      await expect(store.delete('chunks', undefined, { filter: { tenantId: notAnArray, sourceId: 's1' } })).rejects.toThrow('$in on the metadata key \'tenantId\' needs an array');
      await expect(store.updateMetadata('chunks', { tenantId: { $regex: 'org1' } as never, sourceId: 's1' }, { a: 1 })).rejects.toThrow('not a filter operator');
      await expect(store.lexicalSearch('chunks', 'budget', { filter: { tenantId: { $eq: undefined } } })).rejects.toThrow('holds no condition');
      await expect(store.query('chunks', [0, 0], { filter: { tenantId: {} } })).rejects.toThrow('holds no condition');
      expect(queryCalls).toEqual([]);
    });

    it('matches $textSearch on a string value that contains the text, in any case', async () => {
      const store = new PostgresVectorStore({ ...base, manageSchema: false });
      await store.lexicalSearch('chunks', 'budget', { filter: { tenantId: 'org1', title: { $textSearch: 'Q3 Review' } } });
      expect(queryCalls[0].sql).toContain(`AND metadata_json->>'tenantId' = $2 AND (jsonb_typeof(metadata_json->'title') = 'string' AND strpos(lower(metadata_json->>'title'), lower($3)) > 0)`);
      expect(queryCalls[0].params).toEqual(['budget', 'org1', 'Q3 Review', 10]);
    });

    it('deletes by filter', async () => {
      const store = new PostgresVectorStore({ ...base, manageSchema: false, tablePrefix: 'library_' });
      queryResultQueue.push({ rows: [], rowCount: 4 });
      const result = await store.delete('chunks', undefined, { filter: { sourceId: 's1' } });
      expect(queryCalls[0]).toEqual({ sql: `DELETE FROM "library_chunks" WHERE metadata_json->>'sourceId' = $1`, params: ['s1'] });
      expect(result.deletedCount).toBe(4);
    });

    it('changes stored metadata by filter, removing a key given as null', async () => {
      const store = new PostgresVectorStore({ ...base, manageSchema: false, tablePrefix: 'library_' });
      queryResultQueue.push({ rows: [], rowCount: 2 });
      const result = await store.updateMetadata('chunks', { sourceId: 's1' }, { aclGroups: ['acct:a'], folderId: null });
      expect(queryCalls[0].sql).toBe(`UPDATE "library_chunks" SET metadata_json = (COALESCE(metadata_json, '{}'::jsonb) || $1::jsonb) - $2::text[], updated_at = $3 WHERE metadata_json->>'sourceId' = $4`);
      expect(queryCalls[0].params?.[0]).toBe('{"aclGroups":["acct:a"]}');
      expect(queryCalls[0].params?.[1]).toEqual(['folderId']);
      expect(queryCalls[0].params?.[3]).toBe('s1');
      expect(result.updatedCount).toBe(2);
      await expect(store.updateMetadata('chunks', {}, { a: 1 })).rejects.toThrow('needs a filter');
    });

    it('searches the lexical leg alone, every word or any word, whole or by prefix', async () => {
      const store = new PostgresVectorStore({ ...base, manageSchema: false, textSearchConfig: 'simple' });
      await store.lexicalSearch('chunks', 'Chapter TWO, please!', { topK: 7, match: 'all', prefix: true, filter: { tenantId: 'org1' } });
      expect(queryCalls[0].sql).toContain(`to_tsquery('simple'::regconfig, $1)`);
      expect(queryCalls[0].sql).toContain(`AND metadata_json->>'tenantId' = $2`);
      expect(queryCalls[0].params).toEqual(['chapter:* & two:* & please:*', 'org1', 7]);
      await store.lexicalSearch('chunks', 'chapter two', { match: 'any' });
      expect(queryCalls[1].params?.[0]).toBe('chapter | two');
      const empty = await store.lexicalSearch('chunks', ' ... ');
      expect(empty.documents).toEqual([]);
      expect(queryCalls).toHaveLength(2);
    });

    it("reads a hybrid search's own words with match or prefix, and searches by the embedding alone when none is left", async () => {
      const store = new PostgresVectorStore({ ...base, manageSchema: false, textSearchConfig: 'simple' });
      await store.hybridSearch('chunks', [0, 0], 'Budget, the PLAN', { topK: 4, match: 'all', prefix: true });
      expect(queryCalls[0].sql).toContain(`ts_rank(tsv, to_tsquery('simple'::regconfig, $2))`);
      expect(queryCalls[0].sql).not.toContain('plainto_tsquery');
      expect(queryCalls[0].params?.[1]).toBe('budget:* & the:* & plan:*');
      await store.hybridSearch('chunks', [0, 0], 'budget plan', { topK: 4 });
      expect(queryCalls[1].sql).toContain(`ts_rank(tsv, plainto_tsquery('simple'::regconfig, $2))`);
      expect(queryCalls[1].params?.[1]).toBe('budget plan');
      await store.hybridSearch('chunks', [0, 0], ' ... ', { topK: 4, match: 'any' });
      expect(queryCalls).toHaveLength(3);
      expect(queryCalls[2].sql).not.toContain('WITH dense AS');
      expect(queryCalls[2].sql).toContain('<=>');
    });

    it('runs a search inside a transaction with pgvector settings when an iterative scan is asked for', async () => {
      const store = new PostgresVectorStore({ ...base, manageSchema: false, iterativeScan: 'strict_order', efSearch: 100, maxScanTuples: 20000 });
      await store.query('chunks', [0, 0], { topK: 5, filter: { tenantId: 'org1' } });
      expect(queryCalls.map((call) => call.sql.trim().split('\n')[0].trim())).toEqual([
        'BEGIN',
        `SET LOCAL hnsw.iterative_scan = 'strict_order'`,
        'SET LOCAL hnsw.ef_search = 100',
        'SET LOCAL hnsw.max_scan_tuples = 20000',
        expect.stringContaining('SELECT id, embedding::text'),
        'COMMIT',
      ]);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('runs a hybrid search in the same transaction, on one connection, with the pgvector settings', async () => {
      const store = new PostgresVectorStore({ ...base, manageSchema: false, iterativeScan: 'relaxed_order', efSearch: 64 });
      await store.hybridSearch('chunks', [0, 0], 'budget', { topK: 5, filter: { tenantId: 'org1' } });
      expect(queryCalls.map((call) => call.sql.trim().split('\n')[0].trim())).toEqual([
        'BEGIN',
        `SET LOCAL hnsw.iterative_scan = 'relaxed_order'`,
        'SET LOCAL hnsw.ef_search = 64',
        'WITH dense AS (',
        'COMMIT',
      ]);
      expect(queryCalls[3].params).toEqual(['[0,0]', 'budget', 'org1', 15, 60, 5]);
      expect(mockPool.query).not.toHaveBeenCalled();
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('sorts the rows of a relaxed scan again by similarity', async () => {
      const store = new PostgresVectorStore({ ...base, manageSchema: false, iterativeScan: 'relaxed_order' });
      // BEGIN and the setting answer first; then the search's rows come back slightly out of distance order.
      queryResultQueue.push({ rows: [] }, { rows: [] }, {
        rows: [
          { id: 'b', embedding: null, metadata_json: null, text_content: null, distance: 0.2 },
          { id: 'a', embedding: null, metadata_json: null, text_content: null, distance: 0.1 },
          { id: 'c', embedding: null, metadata_json: null, text_content: null, distance: 0.3 },
        ],
        rowCount: 3,
      });
      const result = await store.query('chunks', [0, 0], { topK: 3, filter: { tenantId: 'org1' } });
      expect(result.documents.map((doc) => doc.id)).toEqual(['a', 'b', 'c']);
    });
  });
});
