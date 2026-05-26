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

/** Mock Pool class. */
const mockPool = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
    if (queryResultQueue.length > 0) return queryResultQueue.shift()!;
    return nextQueryResult;
  }),
  connect: vi.fn(async () => mockClient),
  end: vi.fn(async () => {}),
};

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => mockPool),
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

function resetMocks() {
  queryCalls.length = 0;
  queryResultQueue.length = 0;
  nextQueryResult = { rows: [], rowCount: 0 };
  mockPool.query.mockClear();
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

      await store.createCollection('my_docs', 4, { similarityMetric: 'cosine' });

      // Should have: CREATE TABLE, CREATE INDEX (hnsw), CREATE INDEX (gin metadata),
      // ALTER TABLE (tsvector), CREATE INDEX (fts), INSERT into _collections.
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

      // Tsvector column.
      const tsvCol = queryCalls.find(c => c.sql.includes('tsvector'));
      expect(tsvCol).toBeDefined();

      // _collections registration.
      const reg = queryCalls.find(c => c.sql.includes('INSERT INTO') && c.sql.includes('_collections'));
      expect(reg).toBeDefined();
      expect(reg!.params).toEqual(['my_docs', 4, 'cosine']);
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
      expect(queryCall!.sql).toContain('IN (');
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

    it('translates $in to SQL IN clause', async () => {
      store = new PostgresVectorStore(makeConfig());
      await store.initialize();
      resetMocks();

      queryResultQueue.push({ rows: [{ name: 'c', dimension: 4, metric: 'cosine' }] });
      queryResultQueue.push({ rows: [] });

      await store.query('c', [1, 2, 3, 4], {
        filter: { category: { $in: ['a', 'b', 'c'] } },
      });

      const q = queryCalls.find(c => c.sql.includes('IN ('));
      expect(q).toBeDefined();
      // $in values are stringified.
      expect(q!.params).toContain('a');
      expect(q!.params).toContain('b');
      expect(q!.params).toContain('c');
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
  });
});
