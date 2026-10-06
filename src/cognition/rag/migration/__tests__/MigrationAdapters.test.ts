/**
 * @fileoverview Unit tests for migration adapters with fully mocked backends.
 *
 * Tests the Postgres, Qdrant, and Pinecone migration adapters without
 * requiring any external services. pg is vi.mock()'d and global fetch is
 * stubbed for Qdrant/Pinecone HTTP adapters.
 *
 * @module rag/migration/__tests__/MigrationAdapters.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Mock pg module for Postgres adapters
// ---------------------------------------------------------------------------

const pgQueryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let pgQueryResult: { rows: any[]; rowCount?: number } = { rows: [], rowCount: 0 };
const pgQueryResultQueue: Array<{ rows: any[]; rowCount?: number }> = [];

const pgMockClient = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    pgQueryCalls.push({ sql, params });
    if (pgQueryResultQueue.length > 0) return pgQueryResultQueue.shift()!;
    return pgQueryResult;
  }),
  release: vi.fn(),
};

const pgMockPool = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    pgQueryCalls.push({ sql, params });
    if (pgQueryResultQueue.length > 0) return pgQueryResultQueue.shift()!;
    return pgQueryResult;
  }),
  connect: vi.fn(async () => pgMockClient),
  end: vi.fn(async () => {}),
};

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(function () {
      return pgMockPool;
    }),
  },
}));

// ---------------------------------------------------------------------------
// Mock global fetch for Qdrant & Pinecone adapters
// ---------------------------------------------------------------------------

const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
const fetchResponseQueue: Array<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}> = [];

function okJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function errResponse(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => 'error',
  };
}

const mockFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  fetchCalls.push({ url, init: init ?? {} });
  if (fetchResponseQueue.length > 0) return fetchResponseQueue.shift()!;
  return okJson({});
});

vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Import adapters after mocks.
// ---------------------------------------------------------------------------

import { PostgresSourceAdapter } from '../adapters/PostgresSourceAdapter.js';
import { PostgresTargetAdapter } from '../adapters/PostgresTargetAdapter.js';
import { QdrantSourceAdapter } from '../adapters/QdrantSourceAdapter.js';
import { QdrantTargetAdapter } from '../adapters/QdrantTargetAdapter.js';
import { PineconeSourceAdapter } from '../adapters/PineconeSourceAdapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetAll() {
  pgQueryCalls.length = 0;
  pgQueryResultQueue.length = 0;
  pgQueryResult = { rows: [], rowCount: 0 };
  pgMockPool.query.mockClear();
  pgMockClient.query.mockClear();
  pgMockClient.release.mockClear();
  fetchCalls.length = 0;
  fetchResponseQueue.length = 0;
  mockFetch.mockClear();
}

// ---------------------------------------------------------------------------
// PostgresSourceAdapter
// ---------------------------------------------------------------------------

describe('PostgresSourceAdapter', () => {
  let adapter: PostgresSourceAdapter;

  beforeEach(() => {
    resetAll();
    adapter = new PostgresSourceAdapter('postgresql://test:test@localhost/db');
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('listTables() queries information_schema for public tables', async () => {
    pgQueryResultQueue.push({
      rows: [
        { table_name: 'memory_traces' },
        { table_name: 'knowledge_nodes' },
        { table_name: 'documents' },
        { table_name: 'unrelated_table' },
      ],
    });

    const tables = await adapter.listTables();

    // Should filter to only known migration tables.
    expect(tables).toContain('memory_traces');
    expect(tables).toContain('knowledge_nodes');
    expect(tables).toContain('documents');
    expect(tables).not.toContain('unrelated_table');

    const call = pgQueryCalls.find(c => c.sql.includes('information_schema'));
    expect(call).toBeDefined();
    expect(call!.sql).toContain("table_schema = 'public'");
  });

  it('countRows() returns parsed count', async () => {
    pgQueryResultQueue.push({ rows: [{ c: '42' }] });
    const count = await adapter.countRows('memory_traces');
    expect(count).toBe(42);

    const call = pgQueryCalls.find(c => c.sql.includes('COUNT(*)'));
    expect(call).toBeDefined();
    expect(call!.sql).toContain('"memory_traces"');
  });

  it('readBatch() uses LIMIT/OFFSET', async () => {
    pgQueryResultQueue.push({
      rows: [
        { id: 'r1', content: 'hello' },
        { id: 'r2', content: 'world' },
      ],
    });

    const rows = await adapter.readBatch('memory_traces', 10, 50);

    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe('r1');

    const call = pgQueryCalls.find(c => c.sql.includes('LIMIT'));
    expect(call).toBeDefined();
    expect(call!.params).toEqual([50, 10]); // [limit, offset]
  });
});

// ---------------------------------------------------------------------------
// PostgresTargetAdapter
// ---------------------------------------------------------------------------

describe('PostgresTargetAdapter', () => {
  let adapter: PostgresTargetAdapter;

  beforeEach(() => {
    resetAll();
    adapter = new PostgresTargetAdapter('postgresql://test:test@localhost/db');
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('ensureTable() calls CREATE EXTENSION vector on first use', async () => {
    await adapter.ensureTable('memory_traces', {
      id: 'test',
      content: 'hello',
      embedding: [0.1, 0.2, 0.3],
      score: 1.0,
    });

    const extCall = pgQueryCalls.find(c => c.sql.includes('CREATE EXTENSION'));
    expect(extCall).toBeDefined();
    expect(extCall!.sql).toContain('CREATE EXTENSION IF NOT EXISTS vector');
  });

  it('ensureTable() creates table with inferred column types', async () => {
    await adapter.ensureTable('test_table', {
      id: 'abc',
      content: 'text value',
      score: 42,
      embedding: [0.1, 0.2, 0.3],
      is_active: true,
      metadata: { key: 'val' },
    });

    const createCall = pgQueryCalls.find(c =>
      c.sql.includes('CREATE TABLE') && c.sql.includes('test_table'),
    );
    expect(createCall).toBeDefined();
    expect(createCall!.sql).toContain('"id" TEXT');
    expect(createCall!.sql).toContain('"content" TEXT');
    expect(createCall!.sql).toContain('"score" BIGINT');
    expect(createCall!.sql).toContain('vector(3)');
    expect(createCall!.sql).toContain('"is_active" BOOLEAN');
    expect(createCall!.sql).toContain('"metadata" JSONB');
  });

  it('writeBatch() wraps inserts in a transaction', async () => {
    // First call will trigger ensureTable + CREATE EXTENSION.
    await adapter.ensureTable('memory_traces', { id: 'x', content: 'y' });
    resetAll();

    await adapter.writeBatch('memory_traces', [
      { id: '1', content: 'first' },
      { id: '2', content: 'second' },
    ]);

    const beginIdx = pgQueryCalls.findIndex(c => c.sql === 'BEGIN');
    const commitIdx = pgQueryCalls.findIndex(c => c.sql === 'COMMIT');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(beginIdx);

    const inserts = pgQueryCalls.filter(c => c.sql.includes('INSERT INTO'));
    expect(inserts.length).toBe(2);
    expect(inserts[0].sql).toContain('ON CONFLICT DO NOTHING');
  });
});

// ---------------------------------------------------------------------------
// QdrantSourceAdapter
// ---------------------------------------------------------------------------

describe('QdrantSourceAdapter', () => {
  let adapter: QdrantSourceAdapter;

  beforeEach(() => {
    resetAll();
    adapter = new QdrantSourceAdapter('http://localhost:6333', 'test-key');
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('listTables() calls /collections to check which Qdrant collections exist', async () => {
    fetchResponseQueue.push(okJson({
      result: {
        collections: [
          { name: 'memory_traces' },
          { name: 'document_chunks' },
          { name: 'unrelated' },
        ],
      },
    }));

    const tables = await adapter.listTables();

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain('/collections');
    // Should only include known collections.
    expect(tables).toContain('memory_traces');
    expect(tables).toContain('document_chunks');
    expect(tables).not.toContain('unrelated');
  });

  it('countRows() calls /collections/{name} for points_count', async () => {
    fetchResponseQueue.push(okJson({
      result: { points_count: 500 },
    }));

    const count = await adapter.countRows('memory_traces');
    expect(count).toBe(500);
    expect(fetchCalls[0].url).toContain('/collections/memory_traces');
  });

  it('readBatch() calls scroll API and flattens point structure', async () => {
    fetchResponseQueue.push(okJson({
      result: {
        points: [
          { id: 'p1', vector: [0.1, 0.2, 0.3], payload: { content: 'hello', type: 'episodic' } },
          { id: 'p2', vector: [0.4, 0.5, 0.6], payload: { content: 'world', type: 'semantic' } },
        ],
      },
    }));

    const rows = await adapter.readBatch('memory_traces', 0, 100);

    expect(fetchCalls[0].url).toContain('/collections/memory_traces/points/scroll');
    expect(fetchCalls[0].init.method).toBe('POST');

    const body = JSON.parse(fetchCalls[0].init.body as string);
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
    expect(body.with_payload).toBe(true);
    expect(body.with_vector).toBe(true);

    expect(rows.length).toBe(2);
    // Flattened row should have id, embedding, and payload fields.
    expect(rows[0].id).toBe('p1');
    expect(rows[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(rows[0].content).toBe('hello');
  });

  it('readBatch() returns empty for non-collection tables', async () => {
    const rows = await adapter.readBatch('brain_meta', 0, 10);
    expect(rows).toEqual([]);
    expect(fetchCalls.length).toBe(0);
  });

  it('sets api-key header when apiKey provided', async () => {
    fetchResponseQueue.push(okJson({
      result: { collections: [{ name: 'memory_traces' }] },
    }));

    await adapter.listTables();

    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers['api-key']).toBe('test-key');
  });

  it('includes sidecar SQLite tables when sidecarPath is provided', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'qdrant-source-sidecar-'));
    const sidecarPath = join(tempDir, 'sidecar.sqlite');
    const db = new Database(sidecarPath);
    db.exec('CREATE TABLE documents (id TEXT, title TEXT)');
    db.exec(`INSERT INTO documents (id, title) VALUES ('doc-1', 'hello')`);
    db.close();

    const sidecarAdapter = new QdrantSourceAdapter('http://localhost:6333', 'test-key', sidecarPath);

    try {
      fetchResponseQueue.push(okJson({
        result: { collections: [{ name: 'memory_traces' }] },
      }));

      const tables = await sidecarAdapter.listTables();
      expect(tables).toContain('memory_traces');
      expect(tables).toContain('documents');
      expect(await sidecarAdapter.countRows('documents')).toBe(1);
      expect(await sidecarAdapter.readBatch('documents', 0, 10)).toEqual([
        { id: 'doc-1', title: 'hello' },
      ]);
    } finally {
      await sidecarAdapter.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// QdrantTargetAdapter
// ---------------------------------------------------------------------------

describe('QdrantTargetAdapter', () => {
  let adapter: QdrantTargetAdapter;

  beforeEach(() => {
    resetAll();
    adapter = new QdrantTargetAdapter('http://localhost:6333', 'test-key');
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('ensureTable() creates Qdrant collection with correct vector config', async () => {
    // First call: check if collection exists (404 = doesn't exist).
    fetchResponseQueue.push(errResponse(404));
    // Second call: create collection.
    fetchResponseQueue.push(okJson({ result: true }));

    await adapter.ensureTable('memory_traces', {
      id: 'test',
      embedding: [0.1, 0.2, 0.3, 0.4],
      content: 'hello',
    });

    // First fetch: GET /collections/memory_traces
    expect(fetchCalls[0].url).toContain('/collections/memory_traces');
    expect(fetchCalls[0].init.method).toBeUndefined(); // GET (default)

    // Second fetch: PUT /collections/memory_traces
    expect(fetchCalls[1].url).toContain('/collections/memory_traces');
    expect(fetchCalls[1].init.method).toBe('PUT');

    const body = JSON.parse(fetchCalls[1].init.body as string);
    expect(body.vectors.size).toBe(4); // Inferred from embedding length.
    expect(body.vectors.distance).toBe('Cosine');
  });

  it('writeBatch() upserts points with correct structure', async () => {
    // Mark as already created.
    fetchResponseQueue.push(okJson({})); // collection exists
    await adapter.ensureTable('memory_traces', { id: 'x', embedding: [1, 2], content: 'y' });
    resetAll();

    fetchResponseQueue.push(okJson({}));
    const count = await adapter.writeBatch('memory_traces', [
      { id: 'p1', embedding: [0.1, 0.2], content: 'hello', type: 'episodic' },
      { id: 'p2', embedding: [0.3, 0.4], content: 'world', type: 'semantic' },
    ]);

    expect(count).toBe(2);
    expect(fetchCalls[0].url).toContain('/collections/memory_traces/points');
    expect(fetchCalls[0].init.method).toBe('PUT');

    const body = JSON.parse(fetchCalls[0].init.body as string);
    expect(body.points.length).toBe(2);
    expect(body.points[0].id).toBe('p1');
    expect(body.points[0].vector).toEqual([0.1, 0.2]);
    // Payload should contain non-id, non-embedding fields.
    expect(body.points[0].payload.content).toBe('hello');
    expect(body.points[0].payload.type).toBe('episodic');
    expect(body.points[0].payload.id).toBeUndefined();
    expect(body.points[0].payload.embedding).toBeUndefined();
  });

  it('writeBatch() returns 0 for non-collection tables', async () => {
    await expect(adapter.writeBatch('brain_meta', [{ id: 'x' }])).rejects.toThrow(
      'sidecarPath',
    );
    expect(fetchCalls.length).toBe(0);
  });

  it('writes non-vector tables to sidecar SQLite when configured', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'qdrant-target-sidecar-'));
    const sidecarPath = join(tempDir, 'sidecar.sqlite');
    const sidecarAdapter = new QdrantTargetAdapter('http://localhost:6333', 'test-key', sidecarPath);

    try {
      await sidecarAdapter.ensureTable('documents', {
        id: 'doc-1',
        title: 'hello',
        metadata: { source: 'test' },
        isActive: true,
      });

      const count = await sidecarAdapter.writeBatch('documents', [
        { id: 'doc-1', title: 'hello', metadata: { source: 'test' }, isActive: true },
      ]);
      expect(count).toBe(1);

      const db = new Database(sidecarPath, { readonly: true });
      const rows = db.prepare('SELECT * FROM documents').all() as Array<Record<string, unknown>>;
      db.close();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'doc-1',
        title: 'hello',
        metadata: JSON.stringify({ source: 'test' }),
        isActive: 1,
      });
    } finally {
      await sidecarAdapter.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// PineconeSourceAdapter
// ---------------------------------------------------------------------------

describe('PineconeSourceAdapter', () => {
  let adapter: PineconeSourceAdapter;

  beforeEach(() => {
    resetAll();
    adapter = new PineconeSourceAdapter(
      'https://my-index.svc.aped.pinecone.io',
      'test-api-key',
      'my-namespace',
    );
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('listTables() returns single "memory_traces" entry', async () => {
    const tables = await adapter.listTables();
    expect(tables).toEqual(['memory_traces']);
  });

  it('countRows() calls describe_index_stats and returns namespace vector count', async () => {
    fetchResponseQueue.push(okJson({
      namespaces: { 'my-namespace': { vectorCount: 1234 } },
      totalVectorCount: 5000,
    }));

    const count = await adapter.countRows('memory_traces');
    expect(count).toBe(1234);
    expect(fetchCalls[0].url).toContain('/describe_index_stats');
  });

  it('countRows() falls back to totalVectorCount when namespace not present', async () => {
    const noNsAdapter = new PineconeSourceAdapter(
      'https://my-index.svc.aped.pinecone.io',
      'test-api-key',
      '',
    );

    fetchResponseQueue.push(okJson({
      namespaces: {},
      totalVectorCount: 7777,
    }));

    const count = await noNsAdapter.countRows('memory_traces');
    expect(count).toBe(7777);
    await noNsAdapter.close();
  });

  it('readBatch() calls vectors/list then vectors/fetch', async () => {
    // list response
    fetchResponseQueue.push(okJson({
      vectors: [{ id: 'v1' }, { id: 'v2' }],
    }));
    // fetch response
    fetchResponseQueue.push(okJson({
      vectors: {
        v1: { id: 'v1', values: [0.1, 0.2, 0.3], metadata: { content: 'hello' } },
        v2: { id: 'v2', values: [0.4, 0.5, 0.6], metadata: { content: 'world' } },
      },
    }));

    const rows = await adapter.readBatch('memory_traces', 0, 100);

    // First call: list endpoint.
    expect(fetchCalls[0].url).toContain('/vectors/list');
    expect(fetchCalls[0].url).toContain('namespace=my-namespace');
    expect(fetchCalls[0].url).toContain('limit=100');

    // Second call: fetch endpoint.
    expect(fetchCalls[1].url).toContain('/vectors/fetch');
    const fetchBody = JSON.parse(fetchCalls[1].init.body as string);
    expect(fetchBody.ids).toEqual(['v1', 'v2']);
    expect(fetchBody.namespace).toBe('my-namespace');

    // Verify flattened row structure.
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe('v1');
    expect(rows[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(rows[0].content).toBe('hello');
  });

  it('readBatch() returns empty when list returns no vectors', async () => {
    fetchResponseQueue.push(okJson({ vectors: [] }));
    const rows = await adapter.readBatch('memory_traces', 0, 100);
    expect(rows).toEqual([]);
    expect(fetchCalls.length).toBe(1); // Only list call, no fetch.
  });

  it('sets Api-Key header on all requests', async () => {
    fetchResponseQueue.push(okJson({ namespaces: {}, totalVectorCount: 0 }));
    await adapter.countRows('memory_traces');

    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers['Api-Key']).toBe('test-api-key');
  });
});
