/**
 * @fileoverview Unit tests for VectorStoreManager
 * Tests vector store provider management, data source routing, and lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock SqlVectorStore to avoid requiring the optional @framers/sql-storage-adapter peer dependency
vi.mock('../../src/rag/implementations/vector_stores/SqlVectorStore', () => ({
  SqlVectorStore: class MockSqlVectorStore {
    constructor() {}
    async initialize() {}
    async shutdown() {}
    isInitialized() { return true; }
    async checkHealth() { return { isHealthy: true }; }
  },
}));
import { VectorStoreManager } from '../../src/cognition/rag/VectorStoreManager.js';
import type { VectorStoreManagerConfig, RagDataSourceConfig } from '../../src/config/VectorStoreConfiguration';

describe('VectorStoreManager', () => {
  let manager: VectorStoreManager;

  const testConfig: VectorStoreManagerConfig = {
    providers: [
      {
        id: 'primary-store',
        type: 'in_memory' as any,
      },
      {
        id: 'secondary-store',
        type: 'in_memory' as any,
      },
    ],
    defaultProviderId: 'primary-store',
    defaultEmbeddingDimension: 384,
  };

  const testDataSources: RagDataSourceConfig[] = [
    {
      dataSourceId: 'main-knowledge',
      displayName: 'Main Knowledge Base',
      vectorStoreProviderId: 'primary-store',
      actualNameInProvider: 'knowledge_collection',
      embeddingDimension: 384,
      isDefaultQuerySource: true,
    },
    {
      dataSourceId: 'user-memories',
      displayName: 'User Memories',
      vectorStoreProviderId: 'primary-store',
      actualNameInProvider: 'memories_collection',
      embeddingDimension: 384,
      isDefaultIngestionSource: true,
    },
    {
      dataSourceId: 'secondary-data',
      displayName: 'Secondary Data',
      vectorStoreProviderId: 'secondary-store',
      actualNameInProvider: 'secondary_collection',
      embeddingDimension: 384,
    },
  ];

  beforeEach(async () => {
    manager = new VectorStoreManager();
    await manager.initialize(testConfig, testDataSources);
  });

  afterEach(async () => {
    if (manager) {
      await manager.shutdownAllProviders();
    }
  });

  it('logs the index and missing fields of invalid provider entries without credentials', async () => {
    const sentinel = 'sentinel-words-7731';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const invalidManager = new VectorStoreManager();
    try {
      await invalidManager.initialize({ providers: [
        { type: 'pinecone', apiKey: sentinel },
        { id: 'store-2', connectionString: sentinel },
        { apiKey: sentinel, connectionString: sentinel },
      ] } as unknown as VectorStoreManagerConfig, []);
      expect(error.mock.calls.map((call) => call[1])).toEqual([
        { index: 0, missingFields: ['id'] },
        { index: 1, missingFields: ['type'] },
        { index: 2, missingFields: ['id', 'type'] },
      ]);
      expect(JSON.stringify(error.mock.calls)).not.toContain(sentinel);
    } finally {
      await invalidManager.shutdownAllProviders();
      error.mockRestore();
    }
  });

  describe('initialization', () => {
    it('initializes successfully with valid config', async () => {
      const newManager = new VectorStoreManager();
      await expect(
        newManager.initialize(testConfig, testDataSources)
      ).resolves.not.toThrow();
      await newManager.shutdownAllProviders();
    });

    it('registers all configured providers', async () => {
      const providerIds = manager.listProviderIds();
      expect(providerIds).toContain('primary-store');
      expect(providerIds).toContain('secondary-store');
    });

    it('registers all configured data sources', async () => {
      const dataSourceIds = manager.listDataSourceIds();
      expect(dataSourceIds).toContain('main-knowledge');
      expect(dataSourceIds).toContain('user-memories');
      expect(dataSourceIds).toContain('secondary-data');
    });
  });

  describe('provider management', () => {
    it('retrieves provider by ID', () => {
      const provider = manager.getProvider('primary-store');
      expect(provider).toBeDefined();
    });

    it('throws for non-existent provider', () => {
      expect(() => manager.getProvider('non-existent')).toThrow();
    });

    it('retrieves default provider', () => {
      const defaultProvider = manager.getDefaultProvider();
      expect(defaultProvider).toBeDefined();
    });
  });

  describe('data source routing', () => {
    it('routes to correct provider for data source', async () => {
      const { store, collectionName } = await manager.getStoreForDataSource('main-knowledge');
      
      expect(store).toBeDefined();
      expect(collectionName).toBe('knowledge_collection');
    });

    it('routes secondary data source to correct provider', async () => {
      const { store, collectionName } = await manager.getStoreForDataSource('secondary-data');
      
      expect(store).toBeDefined();
      expect(collectionName).toBe('secondary_collection');
    });

    it('throws for non-existent data source', async () => {
      await expect(
        manager.getStoreForDataSource('non-existent')
      ).rejects.toThrow();
    });

    it('returns dimension from data source config', async () => {
      const { dimension } = await manager.getStoreForDataSource('main-knowledge');
      expect(dimension).toBe(384);
    });
  });

  describe('health checks', () => {
    it('reports healthy status when all providers are healthy', async () => {
      const health = await manager.checkHealth();
      
      expect(health.isOverallHealthy).toBe(true);
    });

    it('includes provider-level health details when checking specific provider', async () => {
      const health = await manager.checkHealth('primary-store');
      
      expect(health.isOverallHealthy).toBeDefined();
    });

    it('handles health check for all providers', async () => {
      const health = await manager.checkHealth();
      
      expect(health).toBeDefined();
      expect(typeof health.isOverallHealthy).toBe('boolean');
    });
  });

  describe('lifecycle', () => {
    it('shuts down cleanly', async () => {
      const newManager = new VectorStoreManager();
      await newManager.initialize(testConfig, testDataSources);
      
      await expect(newManager.shutdownAllProviders()).resolves.not.toThrow();
    });

    it('handles shutdown when not initialized', async () => {
      const uninitializedManager = new VectorStoreManager();
      // Should not throw - gracefully handle uninitialized state
      await expect(uninitializedManager.shutdownAllProviders()).resolves.not.toThrow();
    });
  });

  describe('multi-provider operations', () => {
    it('handles operations across multiple providers', async () => {
      // Get stores for data sources on different providers
      const { store: store1 } = await manager.getStoreForDataSource('main-knowledge');
      const { store: store2 } = await manager.getStoreForDataSource('secondary-data');
      
      // Both should be valid stores
      expect(store1).toBeDefined();
      expect(store2).toBeDefined();
    });
  });

  describe('configuration validation', () => {
    it('throws on null config', async () => {
      const newManager = new VectorStoreManager();
      await expect(
        newManager.initialize(null as any, testDataSources)
      ).rejects.toThrow();
    });

    it('throws on null data source configs', async () => {
      const newManager = new VectorStoreManager();
      await expect(
        newManager.initialize(testConfig, null as any)
      ).rejects.toThrow();
    });

    it('handles empty providers gracefully', async () => {
      const emptyConfig: VectorStoreManagerConfig = {
        providers: [],
      };
      const newManager = new VectorStoreManager();
      
      // Should warn but not throw
      await expect(
        newManager.initialize(emptyConfig, [])
      ).resolves.not.toThrow();
      
      await newManager.shutdownAllProviders();
    });
  });
});
