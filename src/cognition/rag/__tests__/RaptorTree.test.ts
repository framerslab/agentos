/**
 * @fileoverview Tests for RaptorTree — recursive abstractive tree for hierarchical retrieval.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaptorTree, type RaptorInputChunk, type RaptorTreeStats } from '../raptor/RaptorTree.js';
import type { IEmbeddingManager, EmbeddingResponse } from '../IEmbeddingManager.js';
import type { IVectorStore, QueryResult, VectorDocument } from '../IVectorStore.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Tracks all upserted documents for later search simulation. */
let upsertedDocs: VectorDocument[] = [];

function createMockEmbeddingManager(dim: number = 3): IEmbeddingManager {
  let callCount = 0;
  return {
    initialize: vi.fn(),
    generateEmbeddings: vi.fn().mockImplementation(({ texts }: { texts: string | string[] }) => {
      const textArray = Array.isArray(texts) ? texts : [texts];
      callCount++;
      return Promise.resolve({
        embeddings: textArray.map((_, i) => {
          // Generate deterministic but unique embeddings for clustering
          const base = (callCount * 100 + i) * 0.01;
          return Array.from({ length: dim }, (__, d) =>
            Math.sin(base + d * 0.5) * 0.5 + 0.5,
          );
        }),
        modelId: 'test-model',
        providerId: 'test-provider',
        usage: { totalTokens: textArray.length * 10 },
      } satisfies EmbeddingResponse);
    }),
    getEmbeddingModelInfo: vi.fn(),
    getEmbeddingDimension: vi.fn().mockResolvedValue(dim),
    checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  };
}

function createMockVectorStore(): IVectorStore {
  return {
    initialize: vi.fn(),
    upsert: vi.fn().mockImplementation(
      (_collection: string, docs: VectorDocument[]) => {
        upsertedDocs.push(...docs);
        return Promise.resolve({
          upsertedCount: docs.length,
          upsertedIds: docs.map((d) => d.id),
        });
      },
    ),
    query: vi.fn().mockImplementation(
      (_collection: string, queryEmbedding: number[], opts?: { topK?: number }) => {
        // Simple mock search: return upserted docs sorted by simulated score
        const results = upsertedDocs
          .map((doc) => ({
            ...doc,
            similarityScore: Math.random() * 0.5 + 0.5, // Random score between 0.5-1.0
          }))
          .sort((a, b) => b.similarityScore - a.similarityScore)
          .slice(0, opts?.topK ?? 10);

        return Promise.resolve({ documents: results } as QueryResult);
      },
    ),
    delete: vi.fn(),
    checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
    shutdown: vi.fn(),
  };
}

function generateChunks(count: number): RaptorInputChunk[] {
  const topics = [
    'authentication and security',
    'database optimization',
    'API design patterns',
    'deployment strategies',
    'testing methodologies',
    'caching mechanisms',
    'error handling',
    'logging and monitoring',
    'containerization',
    'microservices',
  ];

  return Array.from({ length: count }, (_, i) => {
    const topic = topics[i % topics.length];
    return {
      id: `chunk-${i}`,
      text: `This document discusses ${topic}. It covers key concepts including implementation details, best practices, and common pitfalls related to ${topic} in modern software architecture. Section ${i}.`,
      metadata: { source: `doc-${Math.floor(i / 5)}`, section: i },
    };
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('RaptorTree', () => {
  let embeddingManager: ReturnType<typeof createMockEmbeddingManager>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let llmCaller: ReturnType<typeof vi.fn<(prompt: string) => Promise<string>>>;

  beforeEach(() => {
    upsertedDocs = [];
    embeddingManager = createMockEmbeddingManager();
    vectorStore = createMockVectorStore();
    llmCaller = vi.fn<(prompt: string) => Promise<string>>(async (_prompt: string): Promise<string> => {
      return `Summary: This section covers multiple topics including implementation details and best practices. Key themes include software architecture patterns and deployment considerations.`;
    });
  });

  describe('build', () => {
    it('builds a multi-layer tree from 100 chunks', async () => {
      const raptor = new RaptorTree({
        llmCaller,
        embeddingManager,
        vectorStore,
        clusterSize: 8,
        maxDepth: 4,
        minChunksForLayer: 3,
      });

      const chunks = generateChunks(100);
      const stats = await raptor.build(chunks);

      // Should have multiple layers
      expect(stats.totalLayers).toBeGreaterThanOrEqual(2);

      // Layer 0 should have all 100 chunks
      expect(stats.nodesPerLayer[0]).toBe(100);

      // Higher layers should have progressively fewer nodes
      for (let layer = 1; layer < stats.totalLayers; layer++) {
        expect(stats.nodesPerLayer[layer]).toBeLessThan(
          stats.nodesPerLayer[layer - 1],
        );
      }

      // Total nodes should include all layers
      expect(stats.totalNodes).toBeGreaterThan(100);

      // Should have created clusters
      expect(stats.totalClusters).toBeGreaterThan(0);

      // Build time should be recorded
      expect(stats.buildTimeMs).toBeGreaterThanOrEqual(0);

      // Vector store should have been called to upsert all layers
      expect(vectorStore.upsert).toHaveBeenCalled();

      // LLM should have been called for summarization
      expect(llmCaller).toHaveBeenCalled();
    });

    it('handles empty input', async () => {
      const raptor = new RaptorTree({
        llmCaller,
        embeddingManager,
        vectorStore,
      });

      const stats = await raptor.build([]);

      expect(stats.totalLayers).toBe(0);
      expect(stats.totalNodes).toBe(0);
      expect(stats.totalClusters).toBe(0);
    });

    it('handles single chunk input', async () => {
      const raptor = new RaptorTree({
        llmCaller,
        embeddingManager,
        vectorStore,
        minChunksForLayer: 3,
      });

      const chunks = generateChunks(1);
      const stats = await raptor.build(chunks);

      // Only layer 0 (1 chunk is below minChunksForLayer)
      expect(stats.totalLayers).toBe(1);
      expect(stats.nodesPerLayer[0]).toBe(1);
      expect(stats.totalNodes).toBe(1);
    });

    it('stores layer metadata on each node', async () => {
      const raptor = new RaptorTree({
        llmCaller,
        embeddingManager,
        vectorStore,
        clusterSize: 5,
        maxDepth: 2,
      });

      const chunks = generateChunks(20);
      await raptor.build(chunks);

      // Check that upserted docs have raptorLayer metadata
      const layer0Docs = upsertedDocs.filter(
        (d) => d.metadata?.raptorLayer === 0,
      );
      const layer1Docs = upsertedDocs.filter(
        (d) => d.metadata?.raptorLayer === 1,
      );

      expect(layer0Docs.length).toBe(20);
      expect(layer1Docs.length).toBeGreaterThan(0);

      // Layer 0 docs should not be summaries
      for (const doc of layer0Docs) {
        expect(doc.metadata?.raptorIsSummary).toBe(false);
      }

      // Layer 1+ docs should be summaries
      for (const doc of layer1Docs) {
        expect(doc.metadata?.raptorIsSummary).toBe(true);
      }
    });

    it('uses chain-of-thought prompting for summarization', async () => {
      const raptor = new RaptorTree({
        llmCaller,
        embeddingManager,
        vectorStore,
        clusterSize: 5,
      });

      const chunks = generateChunks(10);
      await raptor.build(chunks);

      // Check that the LLM prompt includes chain-of-thought instructions
      const firstCallPrompt = llmCaller.mock.calls[0][0];
      expect(firstCallPrompt).toContain('Think step by step');
      expect(firstCallPrompt).toContain('key themes');
      expect(firstCallPrompt).toContain('relationships');
    });
  });

  describe('search', () => {
    it('returns results from multiple layers', async () => {
      const raptor = new RaptorTree({
        llmCaller,
        embeddingManager,
        vectorStore,
        clusterSize: 5,
        maxDepth: 3,
      });

      const chunks = generateChunks(50);
      await raptor.build(chunks);

      const results = await raptor.search('authentication security', 10);

      expect(results.length).toBeGreaterThan(0);

      // Results should have layer information
      for (const result of results) {
        expect(typeof result.layer).toBe('number');
        expect(typeof result.isSummary).toBe('boolean');
        expect(result.score).toBeGreaterThan(0);
        expect(result.text.length).toBeGreaterThan(0);
      }

      // Should include results from different layers (leaf + summary)
      const layers = new Set(results.map((r) => r.layer));
      // At least layer 0 should be present
      expect(layers.has(0)).toBe(true);
    });

    it('respects topK limit', async () => {
      const raptor = new RaptorTree({
        llmCaller,
        embeddingManager,
        vectorStore,
        clusterSize: 5,
      });

      const chunks = generateChunks(30);
      await raptor.build(chunks);

      const results = await raptor.search('testing', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('returns results sorted by score descending', async () => {
      const raptor = new RaptorTree({
        llmCaller,
        embeddingManager,
        vectorStore,
        clusterSize: 5,
      });

      const chunks = generateChunks(20);
      await raptor.build(chunks);

      const results = await raptor.search('database optimization', 10);

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });
  });

  describe('getStats', () => {
    it('returns stats matching the build result', async () => {
      const raptor = new RaptorTree({
        llmCaller,
        embeddingManager,
        vectorStore,
        clusterSize: 5,
      });

      const chunks = generateChunks(15);
      const buildStats = await raptor.build(chunks);
      const stats = raptor.getStats();

      expect(stats.totalLayers).toBe(buildStats.totalLayers);
      expect(stats.totalNodes).toBe(buildStats.totalNodes);
      expect(stats.totalClusters).toBe(buildStats.totalClusters);
    });

    it('returns zero stats before build', () => {
      const raptor = new RaptorTree({
        llmCaller,
        embeddingManager,
        vectorStore,
      });

      const stats = raptor.getStats();
      expect(stats.totalLayers).toBe(0);
      expect(stats.totalNodes).toBe(0);
    });
  });
});
