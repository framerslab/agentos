import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageFeatures } from '@framers/sql-storage-adapter';

type SidecarItem = { id: string; embedding: number[] };

class MockHnswIndexSidecar {
  public ids: string[] = [];
  public available = true;

  initialize = vi.fn(async () => {});
  isAvailable = vi.fn(() => this.available);
  isActive = vi.fn(() => this.ids.length > 0);
  rebuildFromData = vi.fn(async (items: SidecarItem[]) => {
    this.ids = items.map(item => item.id);
  });
  upsertBatch = vi.fn(async (items: SidecarItem[]) => {
    for (const item of items) {
      if (!this.ids.includes(item.id)) {
        this.ids.push(item.id);
      }
    }
  });
  removeBatch = vi.fn(async (ids: string[]) => {
    this.ids = this.ids.filter(id => !ids.includes(id));
  });
  search = vi.fn(async () => this.ids.map(id => ({ id, score: 0.9 })));
  shutdown = vi.fn(async () => {});
}

import { SqlVectorStore, type SqlVectorStoreConfig } from '../SqlVectorStore';

describe('SqlVectorStore HNSW integration', () => {
  let store: SqlVectorStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new SqlVectorStore();
  });

  afterEach(async () => {
    await store.shutdown();
  });

  it('keeps separate HNSW sidecars per collection', async () => {
    const alphaSidecar = new MockHnswIndexSidecar();
    const betaSidecar = new MockHnswIndexSidecar();
    const hnswSidecarFactory = vi.fn()
      .mockImplementationOnce(() => alphaSidecar)
      .mockImplementationOnce(() => betaSidecar);

    const config: SqlVectorStoreConfig = {
      id: 'sql-vector-store-test',
      type: 'sql',
      hnswThreshold: 1,
      hnswSidecarFactory: hnswSidecarFactory as unknown as SqlVectorStoreConfig['hnswSidecarFactory'],
    };

    await store.initialize(config);

    await store.createCollection('alpha', 2, { overwriteIfExists: true });
    await store.createCollection('beta', 2, { overwriteIfExists: true });

    await store.upsert('alpha', [
      { id: 'alpha-1', embedding: [1, 0], textContent: 'alpha document' },
    ]);
    await store.upsert('beta', [
      { id: 'beta-1', embedding: [0, 1], textContent: 'beta document' },
    ]);

    const alphaResult = await store.query('alpha', [1, 0], {
      topK: 1,
      includeTextContent: true,
    });
    const betaResult = await store.query('beta', [0, 1], {
      topK: 1,
      includeTextContent: true,
    });

    expect(hnswSidecarFactory).toHaveBeenCalledTimes(2);
    expect(alphaSidecar.initialize).toHaveBeenCalledWith(expect.objectContaining({
      indexPath: expect.stringMatching(/alpha\.hnsw$/),
      dimensions: 2,
      metric: 'cosine',
    }));
    expect(betaSidecar.initialize).toHaveBeenCalledWith(expect.objectContaining({
      indexPath: expect.stringMatching(/beta\.hnsw$/),
      dimensions: 2,
      metric: 'cosine',
    }));
    expect(alphaResult.documents[0]?.id).toBe('alpha-1');
    expect(alphaResult.documents[0]?.textContent).toBe('alpha document');
    expect(betaResult.documents[0]?.id).toBe('beta-1');
    expect(betaResult.documents[0]?.textContent).toBe('beta document');
  });

  it('refreshes the active sidecar on document updates and deletes', async () => {
    const gammaSidecar = new MockHnswIndexSidecar();
    const hnswSidecarFactory = vi.fn(() => gammaSidecar);

    const config: SqlVectorStoreConfig = {
      id: 'sql-vector-store-test',
      type: 'sql',
      hnswThreshold: 1,
      hnswSidecarFactory: hnswSidecarFactory as unknown as SqlVectorStoreConfig['hnswSidecarFactory'],
    };

    await store.initialize(config);

    await store.createCollection('gamma', 2, { overwriteIfExists: true });
    await store.upsert('gamma', [
      { id: 'gamma-1', embedding: [1, 0], textContent: 'original document' },
    ]);

    expect(hnswSidecarFactory).toHaveBeenCalledTimes(1);
    expect(gammaSidecar.rebuildFromData).toHaveBeenCalledTimes(1);

    await store.upsert('gamma', [
      { id: 'gamma-1', embedding: [0, 1], textContent: 'updated document' },
    ]);

    expect(gammaSidecar.upsertBatch).toHaveBeenCalledWith([
      { id: 'gamma-1', embedding: [0, 1] },
    ]);

    await store.delete('gamma', ['gamma-1']);

    expect(gammaSidecar.removeBatch).toHaveBeenCalledWith(['gamma-1']);
  });

  it('stores embeddings as portable base64 text and decodes them on query', async () => {
    const config: SqlVectorStoreConfig = {
      id: 'sql-vector-store-test',
      type: 'sql',
      hnswThreshold: Infinity,
    };

    await store.initialize(config);
    await store.createCollection('portable', 2, { overwriteIfExists: true });
    await store.upsert('portable', [
      { id: 'portable-1', embedding: [0.25, -0.5], textContent: 'portable embedding' },
    ]);

    const row = await (store as any).adapter.get(
      `SELECT embedding_blob FROM ${(store as any).tablePrefix}documents WHERE collection_name = ? AND id = ?`,
      ['portable', 'portable-1'],
    );

    expect(typeof row?.embedding_blob).toBe('string');
    expect((row?.embedding_blob as string).startsWith('[')).toBe(false);

    const result = await store.query('portable', [0.25, -0.5], {
      topK: 1,
      includeEmbedding: true,
    });

    expect(result.documents[0]?.embedding).toEqual([0.25, -0.5]);
  });

  it('uses the dialect abstraction for metadata filter SQL', async () => {
    (store as any).features = createStorageFeatures({ kind: 'postgres' } as any);

    const sql = (store as any).buildMetadataFilterSQL({
      theme: 'dark',
      priority: { $gte: 2 },
    });

    expect(sql.clause).toContain('::jsonb');
    expect(sql.params).toEqual(['dark', 2]);
  });

  it('applies exact metadata filter semantics after SQL prefiltering', async () => {
    const config: SqlVectorStoreConfig = {
      id: 'sql-vector-store-test',
      type: 'sql',
      hnswThreshold: Infinity,
    };

    await store.initialize(config);
    await store.createCollection('filters', 2, { overwriteIfExists: true });
    await store.upsert('filters', [
      {
        id: 'match',
        embedding: [1, 0],
        textContent: 'alpha beta',
        metadata: { tags: ['alpha', 'beta'], title: 'alpha beta doc' },
      },
      {
        id: 'partial',
        embedding: [0.9, 0.1],
        textContent: 'alpha only',
        metadata: { tags: ['alpha'], title: 'alpha doc' },
      },
    ]);

    const result = await store.query('filters', [1, 0], {
      topK: 5,
      filter: {
        tags: { $all: ['alpha', 'beta'] },
      },
      includeMetadata: true,
    });

    expect(result.documents.map((doc) => doc.id)).toEqual(['match']);
    expect(result.documents[0]?.metadata).toEqual({
      tags: ['alpha', 'beta'],
      title: 'alpha beta doc',
    });
  });

  it('scanByMetadata returns filtered documents with text content', async () => {
    const config: SqlVectorStoreConfig = {
      id: 'sql-vector-store-test',
      type: 'sql',
      hnswThreshold: Infinity,
    };

    await store.initialize(config);
    await store.createCollection('scan', 2, { overwriteIfExists: true });
    await store.upsert('scan', [
      {
        id: 'expired',
        embedding: [1, 0],
        textContent: 'old document',
        metadata: {
          status: 'expired',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      },
      {
        id: 'fresh',
        embedding: [0, 1],
        textContent: 'fresh document',
        metadata: {
          status: 'fresh',
          timestamp: '2026-04-21T00:00:00.000Z',
        },
      },
    ]);

    const result = await store.scanByMetadata?.('scan', {
      filter: { status: 'expired' },
      includeMetadata: true,
      includeTextContent: true,
      includeEmbedding: true,
    });

    expect(result?.documents.map((doc) => doc.id)).toEqual(['expired']);
    expect(result?.documents[0]?.textContent).toBe('old document');
    expect(result?.documents[0]?.metadata).toEqual({
      status: 'expired',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(result?.documents[0]?.embedding).toEqual([1, 0]);
  });

  it('scanByMetadata supports ISO timestamp range filters', async () => {
    const config: SqlVectorStoreConfig = {
      id: 'sql-vector-store-test',
      type: 'sql',
      hnswThreshold: Infinity,
    };

    await store.initialize(config);
    await store.createCollection('scan-timestamps', 2, { overwriteIfExists: true });
    await store.upsert('scan-timestamps', [
      {
        id: 'expired',
        embedding: [1, 0],
        textContent: 'old document',
        metadata: {
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        id: 'fresh',
        embedding: [0, 1],
        textContent: 'fresh document',
        metadata: {
          timestamp: '2026-04-21T00:00:00.000Z',
        },
      },
    ]);

    const result = await store.scanByMetadata?.('scan-timestamps', {
      filter: { timestamp: { $lt: '2025-01-01T00:00:00.000Z' } },
      includeMetadata: true,
    });

    expect(result?.documents.map((doc) => doc.id)).toEqual(['expired']);
  });
});
