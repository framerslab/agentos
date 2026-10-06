import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Mock hnswlib-node at module level for dynamic import() */
const mockIndex = {
  initIndex: vi.fn(),
  setEf: vi.fn(),
  addPoint: vi.fn(),
  markDelete: vi.fn(),
  searchKnn: vi.fn(),
  resizeIndex: vi.fn(),
  writeIndex: vi.fn(),
  readIndex: vi.fn(),
};

const MockHierarchicalNSW = vi.fn(function () {
  return mockIndex;
});

vi.mock('hnswlib-node', () => ({
  HierarchicalNSW: MockHierarchicalNSW,
  default: { HierarchicalNSW: MockHierarchicalNSW },
}));

/* Mock fs/promises */
vi.mock('fs/promises', () => ({
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('{}'),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import * as fsMod from 'fs/promises';
import { HnswIndexSidecar } from '../HnswIndexSidecar';

const fsMocks = vi.mocked(fsMod);

const BASE_CONFIG = {
  indexPath: '/tmp/test.hnsw',
  dimensions: 4,
  metric: 'cosine' as const,
  activationThreshold: 3,
};

describe('HnswIndexSidecar', () => {
  let sidecar: HnswIndexSidecar;

  beforeEach(() => {
    vi.clearAllMocks();
    MockHierarchicalNSW.mockImplementation(() => mockIndex);
    fsMocks.access.mockRejectedValue(new Error('ENOENT'));
    fsMocks.writeFile.mockResolvedValue(undefined);
    sidecar = new HnswIndexSidecar();
  });

  describe('initialize()', () => {
    it('marks hnswlib as available when import succeeds', async () => {
      await sidecar.initialize(BASE_CONFIG);
      expect(sidecar.isAvailable()).toBe(true);
      expect(sidecar.isActive()).toBe(false);
    });

    it('loads existing index from disk if present', async () => {
      fsMocks.access.mockResolvedValue(undefined);
      fsMocks.readFile.mockResolvedValue(JSON.stringify({
        nextLabel: 2,
        capacity: 100,
        entries: [[0, 'doc-a'], [1, 'doc-b']],
      }));

      await sidecar.initialize(BASE_CONFIG);
      expect(sidecar.isActive()).toBe(true);
      expect(sidecar.getStats().vectorCount).toBe(2);
    });
  });

  describe('rebuildFromData()', () => {
    beforeEach(async () => {
      await sidecar.initialize(BASE_CONFIG);
    });

    it('creates index and adds all vectors', async () => {
      const items = [
        { id: 'a', embedding: [1, 0, 0, 0] },
        { id: 'b', embedding: [0, 1, 0, 0] },
        { id: 'c', embedding: [0, 0, 1, 0] },
      ];

      await sidecar.rebuildFromData(items);

      expect(MockHierarchicalNSW).toHaveBeenCalledWith('cosine', 4);
      expect(mockIndex.initIndex).toHaveBeenCalled();
      expect(mockIndex.addPoint).toHaveBeenCalledTimes(3);
      expect(sidecar.isActive()).toBe(true);
      expect(sidecar.getStats().vectorCount).toBe(3);
    });

    it('saves to disk after rebuild', async () => {
      await sidecar.rebuildFromData([
        { id: 'a', embedding: [1, 0, 0, 0] },
      ]);

      expect(mockIndex.writeIndex).toHaveBeenCalledWith('/tmp/test.hnsw');
      expect(fsMocks.writeFile).toHaveBeenCalledWith(
        '/tmp/test.hnsw.map.json',
        expect.any(String),
        'utf8',
      );
    });

    it('does nothing with empty items', async () => {
      await sidecar.rebuildFromData([]);
      expect(sidecar.isActive()).toBe(false);
    });
  });

  describe('add()', () => {
    beforeEach(async () => {
      await sidecar.initialize(BASE_CONFIG);
      await sidecar.rebuildFromData([
        { id: 'a', embedding: [1, 0, 0, 0] },
      ]);
    });

    it('adds a new vector to an active index', async () => {
      await sidecar.add('b', [0, 1, 0, 0]);
      expect(sidecar.getStats().vectorCount).toBe(2);
    });

    it('skips duplicates', async () => {
      await sidecar.add('a', [1, 0, 0, 0]);
      expect(sidecar.getStats().vectorCount).toBe(1);
    });

    it('upsertBatch replaces existing vectors in an active index', async () => {
      await sidecar.upsertBatch([
        { id: 'a', embedding: [0, 1, 0, 0] },
        { id: 'b', embedding: [0, 0, 1, 0] },
      ]);

      expect(mockIndex.markDelete).toHaveBeenCalledTimes(1);
      expect(mockIndex.addPoint).toHaveBeenCalledTimes(3);
      expect(sidecar.getStats().vectorCount).toBe(2);
    });
  });

  describe('remove()', () => {
    beforeEach(async () => {
      await sidecar.initialize(BASE_CONFIG);
      await sidecar.rebuildFromData([
        { id: 'a', embedding: [1, 0, 0, 0] },
        { id: 'b', embedding: [0, 1, 0, 0] },
      ]);
    });

    it('soft-deletes a vector', async () => {
      await sidecar.remove('a');
      expect(mockIndex.markDelete).toHaveBeenCalled();
      expect(sidecar.getStats().vectorCount).toBe(1);
    });

    it('does nothing for unknown ID', async () => {
      await sidecar.remove('nonexistent');
      expect(mockIndex.markDelete).not.toHaveBeenCalled();
    });

    it('removeBatch soft-deletes all known ids', async () => {
      await sidecar.removeBatch(['a', 'b', 'missing']);
      expect(mockIndex.markDelete).toHaveBeenCalledTimes(2);
      expect(sidecar.getStats().vectorCount).toBe(0);
    });
  });

  describe('search()', () => {
    beforeEach(async () => {
      await sidecar.initialize(BASE_CONFIG);
      await sidecar.rebuildFromData([
        { id: 'a', embedding: [1, 0, 0, 0] },
        { id: 'b', embedding: [0, 1, 0, 0] },
        { id: 'c', embedding: [0, 0, 1, 0] },
      ]);
    });

    it('returns results sorted by score (cosine)', async () => {
      mockIndex.searchKnn.mockReturnValue({
        neighbors: [0, 1, 2],
        distances: [0.1, 0.3, 0.8],
      });

      const results = await sidecar.search([1, 0, 0, 0], 3);
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe('a');
      expect(results[0].score).toBeCloseTo(0.9);
      expect(results[2].score).toBeCloseTo(0.2);
    });

    it('returns empty when inactive', async () => {
      const empty = new HnswIndexSidecar();
      await empty.initialize(BASE_CONFIG);
      const results = await empty.search([1, 0, 0, 0], 3);
      expect(results).toEqual([]);
    });

    it('clamps topK to vector count', async () => {
      mockIndex.searchKnn.mockReturnValue({
        neighbors: [0, 1, 2],
        distances: [0.1, 0.2, 0.3],
      });

      await sidecar.search([1, 0, 0, 0], 100);
      expect(mockIndex.searchKnn).toHaveBeenCalledWith(expect.anything(), 3);
    });
  });

  describe('getStats()', () => {
    it('reports correct stats after rebuild', async () => {
      await sidecar.initialize(BASE_CONFIG);
      await sidecar.rebuildFromData([
        { id: 'a', embedding: [1, 0, 0, 0] },
      ]);

      const stats = sidecar.getStats();
      expect(stats.active).toBe(true);
      expect(stats.available).toBe(true);
      expect(stats.vectorCount).toBe(1);
      expect(stats.indexPath).toBe('/tmp/test.hnsw');
    });
  });
});
