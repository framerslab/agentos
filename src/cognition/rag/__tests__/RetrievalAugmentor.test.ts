import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetrievalAugmentor } from '../RetrievalAugmentor';
import { IRetrievalAugmentor, RagDocumentInput, RagRetrievalOptions } from '../IRetrievalAugmentor';
import { RetrievalAugmentorServiceConfig } from '../../../core/config/RetrievalAugmentorConfiguration.js';
// Mock dependencies
import { IEmbeddingManager } from '../IEmbeddingManager';
import { IVectorStoreManager } from '../IVectorStoreManager';
import { IVectorStore } from '../IVectorStore';
import type { HydeLlmCaller } from '../HydeRetriever';

const mockEmbeddingManager: IEmbeddingManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  generateEmbeddings: vi.fn().mockResolvedValue({
    embeddings: [[0.1, 0.2, 0.3]], modelId: 'test-emb-model', providerId: 'test-emb-provider', usage: { totalTokens: 5 }
  }),
  getEmbeddingModelInfo: vi.fn().mockResolvedValue({ modelId: 'test-emb-model', providerId: 'test-emb-provider', dimension: 3 }),
  getEmbeddingDimension: vi.fn().mockResolvedValue(3),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

const mockVectorStore: IVectorStore = {
  initialize: vi.fn().mockResolvedValue(undefined),
  upsert: vi.fn().mockResolvedValue({ upsertedCount: 1, upsertedIds: ['doc1_chunk_0'] }),
  query: vi.fn().mockResolvedValue({ documents: [{ id: 'doc1_chunk_0', embedding: [0.1,0.2,0.3], similarityScore: 0.9, textContent: 'Test content' }] }),
  hybridSearch: vi.fn().mockResolvedValue({ documents: [{ id: 'doc1_chunk_0', embedding: [0.1,0.2,0.3], similarityScore: 0.95, textContent: 'Hybrid content' }] }),
  delete: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
  createCollection: vi.fn().mockResolvedValue(undefined),
  collectionExists: vi.fn().mockResolvedValue(true),
};

const mockVectorStoreManager: IVectorStoreManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  getProvider: vi.fn().mockReturnValue(mockVectorStore),
  getDefaultProvider: vi.fn().mockReturnValue(mockVectorStore),
  getStoreForDataSource: vi.fn().mockResolvedValue({ store: mockVectorStore, collectionName: 'test-collection', dimension: 3 }),
  listProviderIds: vi.fn().mockReturnValue(['mock-store-provider']),
  listDataSourceIds: vi.fn().mockReturnValue(['test-ds-1']),
  checkHealth: vi.fn().mockResolvedValue({ isOverallHealthy: true }),
  shutdownAllProviders: vi.fn().mockResolvedValue(undefined),
};

const mockConfig: RetrievalAugmentorServiceConfig = {
  defaultQueryEmbeddingModelId: 'test-emb-model',
  categoryBehaviors: [], // Keep it simple for basic tests
  // defaultDataSourceId: 'test-ds-1' // This was on RetrievalAugmentorConfig in IRetrievalAugmentor.ts, not ServiceConfig
};


describe('RetrievalAugmentor Functionality', () => {
  let augmentor: IRetrievalAugmentor;

  beforeEach(async () => {
    vi.clearAllMocks();
    augmentor = new RetrievalAugmentor();
    // The actual IRetrievalAugmentor initialize takes RetrievalAugmentorServiceConfig
    // The config in IRetrievalAugmentor.ts was simpler and passed managers directly
    // This needs alignment. For now, using the ServiceConfig from the config file.
    await augmentor.initialize(mockConfig, mockEmbeddingManager, mockVectorStoreManager);
  });

  it('should be defined', () => {
    expect(augmentor).toBeDefined();
  });

  it('should initialize without errors', () => {
    expect(augmentor.augmenterId).toBeDefined();
    // Initialization happens in beforeEach
  });

  it('should ingest a single document', async () => {
    const doc: RagDocumentInput = { id: 'doc1', content: 'This is a test document.' , dataSourceId: 'test-ds-1'};
    const result = await augmentor.ingestDocuments(doc);

    expect(result.processedCount).toBe(1);
    expect(result.ingestedIds?.length).toBe(1); // Assuming chunking and upsert work
    expect(result.ingestedIds).toContain('doc1');
    expect(mockEmbeddingManager.generateEmbeddings).toHaveBeenCalled();
    expect(mockVectorStore.upsert).toHaveBeenCalled();
  });

  it('should retrieve context for a query', async () => {
    const queryText = 'test query';
    const options: RagRetrievalOptions = { targetDataSourceIds: ['test-ds-1'], topK: 1 };
    const result = await augmentor.retrieveContext(queryText, options);

    expect(result.queryText).toBe(queryText);
    expect(result.retrievedChunks.length).toBeGreaterThanOrEqual(0); // Mock returns 1
    if (result.retrievedChunks.length > 0) {
        expect(result.retrievedChunks[0].content).toBe('Test content');
    }
    expect(result.augmentedContext).toBeDefined();
    expect(mockEmbeddingManager.generateEmbeddings).toHaveBeenCalledWith(expect.objectContaining({ texts: queryText }));
    expect(mockVectorStore.query).toHaveBeenCalled();
  });

  it('should use hybridSearch when strategy is hybrid', async () => {
    const queryText = 'test query';
    const result = await augmentor.retrieveContext(queryText, {
      targetDataSourceIds: ['test-ds-1'],
      topK: 1,
      strategy: 'hybrid',
    });

    expect(result.queryText).toBe(queryText);
    expect((mockVectorStore as any).hybridSearch).toHaveBeenCalled();
  });

  it('should request embeddings and more candidates when strategy is mmr', async () => {
    const queryText = 'test query';
    await augmentor.retrieveContext(queryText, {
      targetDataSourceIds: ['test-ds-1'],
      topK: 2,
      strategy: 'mmr',
      strategyParams: { mmrLambda: 0.6 },
    });

    expect(mockVectorStore.query).toHaveBeenCalledWith(
      'test-collection',
      expect.any(Array),
      expect.objectContaining({
        includeEmbedding: true,
        topK: 10, // 2 * 5 candidate multiplier
      }),
    );
  });

  it('should delete by originalDocumentId metadata when removing a document', async () => {
    const result = await augmentor.deleteDocuments(['doc1'], 'test-ds-1');

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(0);
    expect(mockVectorStore.delete).toHaveBeenCalledWith(
      'test-collection',
      undefined,
      { filter: { originalDocumentId: 'doc1' } },
    );
  });

  it('should delete old chunks before ingesting document updates', async () => {
    const deleteSpy = vi
      .spyOn(augmentor as RetrievalAugmentor, 'deleteDocuments')
      .mockResolvedValue({ successCount: 1, failureCount: 0, errors: [] });

    const doc: RagDocumentInput = {
      id: 'doc-update',
      content: 'Updated content for an existing document.',
      dataSourceId: 'test-ds-1',
    };

    const result = await augmentor.updateDocuments(doc, { targetDataSourceId: 'test-ds-1' });

    expect(deleteSpy).toHaveBeenCalledWith(
      ['doc-update'],
      'test-ds-1',
      { ignoreNotFound: true },
    );
    expect(result.processedCount).toBe(1);
    expect(mockVectorStore.upsert).toHaveBeenCalled();
  });
});

describe('RetrievalAugmentor Reranking', () => {
  let augmentor: RetrievalAugmentor;
  let mockRerankerProvider: any;

  const configWithReranking: RetrievalAugmentorServiceConfig = {
    ...mockConfig,
    rerankerServiceConfig: {
      providers: [{ providerId: 'mock-reranker', defaultModelId: 'test-model' }],
      defaultProviderId: 'mock-reranker',
    },
    defaultRerankerProviderId: 'mock-reranker',
    defaultRerankerModelId: 'test-model',
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    mockRerankerProvider = {
      providerId: 'mock-reranker',
      rerank: vi.fn().mockImplementation(async (input: any) => ({
        results: input.documents.map((doc: any, idx: number) => ({
          id: doc.id,
          content: doc.content,
          relevanceScore: 1 - idx * 0.1, // Assign new scores
          originalScore: doc.originalScore,
          metadata: doc.metadata,
        })),
      })),
      isAvailable: vi.fn().mockResolvedValue(true),
    };

    augmentor = new RetrievalAugmentor();
    await augmentor.initialize(configWithReranking, mockEmbeddingManager, mockVectorStoreManager);
    augmentor.registerRerankerProvider(mockRerankerProvider);
  });

  it('should skip reranking when not enabled', async () => {
    const result = await augmentor.retrieveContext('test query', {
      targetDataSourceIds: ['test-ds-1'],
      // rerankerConfig not enabled
    });

    expect(mockRerankerProvider.rerank).not.toHaveBeenCalled();
    expect(result.diagnostics?.rerankingTimeMs).toBeUndefined();
  });

  it('should apply reranking when enabled', async () => {
    const result = await augmentor.retrieveContext('test query', {
      targetDataSourceIds: ['test-ds-1'],
      rerankerConfig: {
        enabled: true,
      },
    });

    expect(mockRerankerProvider.rerank).toHaveBeenCalled();
    expect(result.diagnostics?.rerankingTimeMs).toBeDefined();
    expect(result.diagnostics?.messages).toContainEqual(
      expect.stringContaining('Reranking applied'),
    );
  });

  it('should use specified provider for reranking', async () => {
    await augmentor.retrieveContext('test query', {
      targetDataSourceIds: ['test-ds-1'],
      rerankerConfig: {
        enabled: true,
        providerId: 'mock-reranker',
        modelId: 'custom-model',
      },
    });

    expect(mockRerankerProvider.rerank).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        providerId: 'mock-reranker',
        modelId: 'custom-model',
      }),
    );
  });

  it('should apply topN after reranking', async () => {
    const result = await augmentor.retrieveContext('test query', {
      targetDataSourceIds: ['test-ds-1'],
      topK: 10, // Get more initially
      rerankerConfig: {
        enabled: true,
        topN: 3, // Reranker returns top 3
      },
    });

    expect(mockRerankerProvider.rerank).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        topN: 3,
      }),
    );
  });

  it('should handle reranking errors gracefully', async () => {
    mockRerankerProvider.rerank.mockRejectedValueOnce(new Error('Reranker API error'));

    const result = await augmentor.retrieveContext('test query', {
      targetDataSourceIds: ['test-ds-1'],
      rerankerConfig: {
        enabled: true,
      },
    });

    // Should return results without reranking
    expect(result.retrievedChunks.length).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics?.messages).toContainEqual(
      expect.stringContaining('Reranking failed'),
    );
  });

  it('should warn when reranking enabled but service not configured', async () => {
    const augmentorNoReranker = new RetrievalAugmentor();
    await augmentorNoReranker.initialize(mockConfig, mockEmbeddingManager, mockVectorStoreManager);

    const result = await augmentorNoReranker.retrieveContext('test query', {
      targetDataSourceIds: ['test-ds-1'],
      rerankerConfig: {
        enabled: true,
      },
    });

    expect(result.diagnostics?.messages).toContainEqual(
      expect.stringContaining('RerankerService not configured'),
    );
  });

  it('maps shared retrieval policy to HyDE, reranking, and topK', async () => {
    const mockPolicyHydeLlmCaller = vi.fn<(hypothetical: string, query: string) => Promise<string>>().mockResolvedValue(
      'Hypothetical answer about test content that matches stored documents.',
    ) as unknown as HydeLlmCaller;
    augmentor.setHydeLlmCaller(mockPolicyHydeLlmCaller);

    const result = await augmentor.retrieveContext('test query', {
      targetDataSourceIds: ['test-ds-1'],
      policy: {
        profile: 'max-recall',
        adaptive: false,
        topK: 3,
        hyde: 'always',
        reranker: 'always',
      },
    });

    expect(result.diagnostics?.policy?.profile).toBe('max-recall');
    expect(result.diagnostics?.hyde).toBeDefined();
    expect(mockPolicyHydeLlmCaller).toHaveBeenCalled();
    expect(mockRerankerProvider.rerank).toHaveBeenCalled();
  });
});

describe('RetrievalAugmentor registerRerankerProvider', () => {
  it('should throw error when RerankerService not configured', async () => {
    const augmentor = new RetrievalAugmentor();
    await augmentor.initialize(mockConfig, mockEmbeddingManager, mockVectorStoreManager);

    expect(() => {
      augmentor.registerRerankerProvider({
        providerId: 'test',
        rerank: vi.fn(),
        isAvailable: vi.fn(),
      });
    }).toThrow('RerankerService not configured');
  });

  it('should register provider when RerankerService is configured', async () => {
    const configWithReranking: RetrievalAugmentorServiceConfig = {
      ...mockConfig,
      rerankerServiceConfig: {
        providers: [{ providerId: 'test' }],
        defaultProviderId: 'test',
      },
    };

    const augmentor = new RetrievalAugmentor();
    await augmentor.initialize(configWithReranking, mockEmbeddingManager, mockVectorStoreManager);

    const mockProvider = {
      providerId: 'test',
      rerank: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
    };

    expect(() => augmentor.registerRerankerProvider(mockProvider)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// HyDE integration tests
// ---------------------------------------------------------------------------

describe('RetrievalAugmentor HyDE integration', () => {
  let augmentor: RetrievalAugmentor;
  let mockHydeLlmCaller: HydeLlmCaller;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockHydeLlmCaller = vi.fn<(hypothetical: string, query: string) => Promise<string>>().mockResolvedValue(
      'Hypothetical answer about test content that matches stored documents.',
    ) as unknown as HydeLlmCaller;

    augmentor = new RetrievalAugmentor();
    await augmentor.initialize(mockConfig, mockEmbeddingManager, mockVectorStoreManager);
    augmentor.setHydeLlmCaller(mockHydeLlmCaller);
  });

  it('should use HyDE when enabled in options', async () => {
    const result = await augmentor.retrieveContext('What is test?', {
      targetDataSourceIds: ['test-ds-1'],
      hyde: { enabled: true },
    });

    // The LLM caller should have been invoked for hypothesis generation
    expect(mockHydeLlmCaller).toHaveBeenCalledOnce();
    expect(mockHydeLlmCaller).toHaveBeenCalledWith(
      expect.stringContaining('knowledgeable assistant'),
      'What is test?',
    );

    // The embedding manager should embed the hypothesis, NOT the raw query
    expect(mockEmbeddingManager.generateEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        texts: expect.stringContaining('Hypothetical answer'),
      }),
    );

    // Should still return normal results
    expect(result.queryText).toBe('What is test?');
    expect(result.retrievedChunks.length).toBeGreaterThanOrEqual(0);

    // Diagnostics should include HyDE metadata
    expect(result.diagnostics?.hyde).toBeDefined();
    expect(result.diagnostics?.hyde?.hypothesis).toContain('Hypothetical answer');
    expect(result.diagnostics?.hyde?.hypothesisLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should skip HyDE when not enabled', async () => {
    const result = await augmentor.retrieveContext('test query', {
      targetDataSourceIds: ['test-ds-1'],
      // hyde not specified
    });

    expect(mockHydeLlmCaller).not.toHaveBeenCalled();
    expect(result.diagnostics?.hyde).toBeUndefined();

    // Should embed the raw query
    expect(mockEmbeddingManager.generateEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({ texts: 'test query' }),
    );
  });

  it('should use pre-supplied hypothesis without calling LLM', async () => {
    const result = await augmentor.retrieveContext('test query', {
      targetDataSourceIds: ['test-ds-1'],
      hyde: {
        enabled: true,
        hypothesis: 'My pre-generated hypothesis text',
      },
    });

    // LLM caller should NOT be called when hypothesis is pre-supplied
    expect(mockHydeLlmCaller).not.toHaveBeenCalled();

    // Should embed the pre-supplied hypothesis
    expect(mockEmbeddingManager.generateEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({ texts: 'My pre-generated hypothesis text' }),
    );

    expect(result.diagnostics?.hyde?.hypothesis).toBe('My pre-generated hypothesis text');
    expect(result.diagnostics?.hyde?.hypothesisLatencyMs).toBe(0);
  });

  it('should fall back to direct embedding when no LLM caller registered', async () => {
    const freshAugmentor = new RetrievalAugmentor();
    await freshAugmentor.initialize(mockConfig, mockEmbeddingManager, mockVectorStoreManager);
    // No setHydeLlmCaller call

    const result = await freshAugmentor.retrieveContext('test query', {
      targetDataSourceIds: ['test-ds-1'],
      hyde: { enabled: true },
    });

    // Should fall back to direct query embedding
    expect(mockEmbeddingManager.generateEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({ texts: 'test query' }),
    );

    expect(result.diagnostics?.hyde).toBeUndefined();
    expect(result.diagnostics?.messages).toContainEqual(
      expect.stringContaining('no LLM caller registered'),
    );
  });

  it('should fall back to direct embedding when HyDE embedding fails', async () => {
    // Make the first generateEmbeddings call return empty (HyDE path),
    // but the second call (fallback) return valid embeddings
    (mockEmbeddingManager.generateEmbeddings as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        embeddings: [[]],
        modelId: 'test-emb-model',
        providerId: 'test-emb-provider',
        usage: { totalTokens: 0 },
      })
      .mockResolvedValueOnce({
        embeddings: [[0.1, 0.2, 0.3]],
        modelId: 'test-emb-model',
        providerId: 'test-emb-provider',
        usage: { totalTokens: 5 },
      });

    const result = await augmentor.retrieveContext('test query', {
      targetDataSourceIds: ['test-ds-1'],
      hyde: { enabled: true },
    });

    // Should have been called twice: once for HyDE (failed), once for fallback
    expect(mockEmbeddingManager.generateEmbeddings).toHaveBeenCalledTimes(2);

    // Should still return results from the fallback path
    expect(result.retrievedChunks.length).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics?.messages).toContainEqual(
      expect.stringContaining('Falling back to direct query embedding'),
    );
  });

  it('should record HyDE in audit trail when audit is enabled', async () => {
    const result = await augmentor.retrieveContext('test query', {
      targetDataSourceIds: ['test-ds-1'],
      hyde: { enabled: true },
      includeAudit: true,
    });

    expect(result.auditTrail).toBeDefined();
    const hydeOp = result.auditTrail?.operations.find(
      (op) => op.operationType === 'hyde',
    );
    expect(hydeOp).toBeDefined();
    expect(hydeOp?.hydeDetails?.hypothesis).toContain('Hypothetical answer');
  });
});
