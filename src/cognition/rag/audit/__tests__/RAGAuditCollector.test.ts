import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RAGAuditCollector, RAGOperationHandle } from '../RAGAuditCollector.js';
import type { RAGAuditTrail, RAGOperationEntry } from '../RAGAuditTypes.js';

describe('RAGOperationHandle', () => {
  let completedEntry: RAGOperationEntry | undefined;
  let handle: RAGOperationHandle;

  beforeEach(() => {
    vi.clearAllMocks();
    completedEntry = undefined;
    handle = new RAGOperationHandle('vector_query', (entry) => {
      completedEntry = entry;
    });
  });

  it('initializes with correct defaults', () => {
    const entry = handle.complete(0, 0);
    expect(entry.operationType).toBe('vector_query');
    expect(entry.operationId).toMatch(/^op-vector_query-/);
    expect(entry.startedAt).toBeTruthy();
    expect(entry.sources).toEqual([]);
    expect(entry.tokenUsage).toEqual({
      embeddingTokens: 0,
      llmPromptTokens: 0,
      llmCompletionTokens: 0,
      totalTokens: 0,
    });
    expect(entry.costUSD).toBe(0);
    expect(entry.resultsCount).toBe(0);
  });

  it('setRetrievalMethod returns this and sets method', () => {
    const result = handle.setRetrievalMethod({
      strategy: 'mmr',
      topK: 10,
      mmrLambda: 0.7,
    });
    expect(result).toBe(handle);

    const entry = handle.complete(5, 0);
    expect(entry.retrievalMethod).toEqual({
      strategy: 'mmr',
      topK: 10,
      mmrLambda: 0.7,
    });
  });

  it('addSources with chunkId/documentId format', () => {
    handle.addSources([
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        content: 'Hello world',
        relevanceScore: 0.95,
        dataSourceId: 'ds-1',
        source: 'test.md',
      },
    ]);
    const entry = handle.complete(1, 0);
    expect(entry.sources).toHaveLength(1);
    expect(entry.sources[0]).toEqual({
      chunkId: 'chunk-1',
      documentId: 'doc-1',
      source: 'test.md',
      contentSnippet: 'Hello world',
      relevanceScore: 0.95,
      dataSourceId: 'ds-1',
      metadata: undefined,
    });
  });

  it('addSources with id/originalDocumentId format', () => {
    handle.addSources([
      {
        id: 'alt-chunk-1',
        originalDocumentId: 'alt-doc-1',
        content: 'Alternative format',
        relevanceScore: 0.8,
      },
    ]);
    const entry = handle.complete(1, 0);
    expect(entry.sources[0]!.chunkId).toBe('alt-chunk-1');
    expect(entry.sources[0]!.documentId).toBe('alt-doc-1');
  });

  it('addSources truncates content to 200 chars for snippet', () => {
    const longContent = 'x'.repeat(500);
    handle.addSources([{ id: 'c1', content: longContent }]);
    const entry = handle.complete(1, 0);
    expect(entry.sources[0]!.contentSnippet).toHaveLength(200);
  });

  it('addSources uses contentSnippet over content when provided', () => {
    handle.addSources([{ id: 'c1', content: 'full text', contentSnippet: 'snippet' }]);
    const entry = handle.complete(1, 0);
    expect(entry.sources[0]!.contentSnippet).toBe('snippet');
  });

  it('setTokenUsage overrides defaults', () => {
    handle.setTokenUsage({
      embeddingTokens: 100,
      llmPromptTokens: 200,
      llmCompletionTokens: 50,
      totalTokens: 350,
    });
    const entry = handle.complete(0, 0);
    expect(entry.tokenUsage.totalTokens).toBe(350);
    expect(entry.tokenUsage.embeddingTokens).toBe(100);
  });

  it('setCost sets cost', () => {
    handle.setCost(0.0025);
    const entry = handle.complete(0, 0);
    expect(entry.costUSD).toBe(0.0025);
  });

  it('setDataSourceIds and setCollectionIds', () => {
    handle.setDataSourceIds(['ds-a', 'ds-b']);
    handle.setCollectionIds(['col-1']);
    const entry = handle.complete(0, 0);
    expect(entry.dataSourceIds).toEqual(['ds-a', 'ds-b']);
    expect(entry.collectionIds).toEqual(['col-1']);
  });

  it('setGraphDetails', () => {
    const graphHandle = new RAGOperationHandle('graph_local', () => {});
    graphHandle.setGraphDetails({
      entitiesMatched: 5,
      communitiesSearched: 2,
      traversalTimeMs: 120,
    });
    const entry = graphHandle.complete(3, 0);
    expect(entry.graphDetails).toEqual({
      entitiesMatched: 5,
      communitiesSearched: 2,
      traversalTimeMs: 120,
    });
  });

  it('setRerankDetails', () => {
    const rerankHandle = new RAGOperationHandle('rerank', () => {});
    rerankHandle.setRerankDetails({
      providerId: 'cohere',
      modelId: 'rerank-english-v3.0',
      documentsReranked: 20,
    });
    const entry = rerankHandle.complete(10, 0);
    expect(entry.rerankDetails).toEqual({
      providerId: 'cohere',
      modelId: 'rerank-english-v3.0',
      documentsReranked: 20,
    });
  });

  it('complete computes relevance scores from sources', () => {
    handle.addSources([
      { id: 'a', relevanceScore: 0.5 },
      { id: 'b', relevanceScore: 0.8 },
      { id: 'c', relevanceScore: 0.9 },
    ]);
    const entry = handle.complete(3, 0);
    expect(entry.relevanceScores).toEqual({
      min: 0.5,
      max: 0.9,
      avg: expect.closeTo(0.7333, 3),
    });
  });

  it('complete does not set relevanceScores when no sources', () => {
    const entry = handle.complete(0, 0);
    expect(entry.relevanceScores).toBeUndefined();
  });

  it('complete uses overrideDurationMs when provided', () => {
    const entry = handle.complete(0, 42);
    expect(entry.durationMs).toBe(42);
  });

  it('complete measures real duration when no override', () => {
    // Small delay to get non-zero duration
    const entry = handle.complete(0);
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('complete calls onComplete callback', () => {
    handle.complete(5, 0);
    expect(completedEntry).toBeDefined();
    expect(completedEntry!.resultsCount).toBe(5);
  });

  it('complete is idempotent — second call returns same entry', () => {
    const first = handle.complete(5, 10);
    const second = handle.complete(99, 999);
    expect(second).toBe(first);
    expect(second.resultsCount).toBe(5);
    expect(second.durationMs).toBe(10);
  });

  it('fluent chaining works', () => {
    const entry = handle
      .setRetrievalMethod({ strategy: 'similarity', topK: 5 })
      .addSources([{ id: 'a', relevanceScore: 0.9 }])
      .setTokenUsage({ embeddingTokens: 64, llmPromptTokens: 0, llmCompletionTokens: 0, totalTokens: 64 })
      .setCost(0.001)
      .setDataSourceIds(['ds-1'])
      .setCollectionIds(['col-1'])
      .complete(1, 0);

    expect(entry.retrievalMethod!.strategy).toBe('similarity');
    expect(entry.sources).toHaveLength(1);
    expect(entry.tokenUsage.embeddingTokens).toBe(64);
    expect(entry.costUSD).toBe(0.001);
    expect(entry.dataSourceIds).toEqual(['ds-1']);
    expect(entry.collectionIds).toEqual(['col-1']);
  });
});

describe('RAGAuditCollector', () => {
  it('creates a trail with unique ID and timestamp', () => {
    const collector = new RAGAuditCollector({
      requestId: 'req-1',
      query: 'What is ML?',
    });
    const trail = collector.finalize();
    expect(trail.trailId).toMatch(/^trail-/);
    expect(trail.requestId).toBe('req-1');
    expect(trail.query).toBe('What is ML?');
    expect(trail.timestamp).toBeTruthy();
    expect(new Date(trail.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('carries seedId and sessionId', () => {
    const collector = new RAGAuditCollector({
      requestId: 'req-2',
      query: 'test',
      seedId: 'seed-abc',
      sessionId: 'sess-123',
    });
    const trail = collector.finalize();
    expect(trail.seedId).toBe('seed-abc');
    expect(trail.sessionId).toBe('sess-123');
  });

  it('empty trail has zeroed summary', () => {
    const collector = new RAGAuditCollector({ requestId: 'r', query: 'q' });
    const trail = collector.finalize();
    expect(trail.operations).toEqual([]);
    expect(trail.summary.totalOperations).toBe(0);
    expect(trail.summary.totalLLMCalls).toBe(0);
    expect(trail.summary.totalEmbeddingCalls).toBe(0);
    expect(trail.summary.totalTokens).toBe(0);
    expect(trail.summary.totalCostUSD).toBe(0);
    expect(trail.summary.operationTypes).toEqual([]);
    expect(trail.summary.sourceSummary).toEqual({
      uniqueDocuments: 0,
      uniqueCollections: 0,
      uniqueDataSources: 0,
    });
  });

  it('startOperation returns a handle and collects on complete', () => {
    const collector = new RAGAuditCollector({ requestId: 'r', query: 'q' });
    const h = collector.startOperation('embedding');
    expect(h).toBeInstanceOf(RAGOperationHandle);

    h.setTokenUsage({ embeddingTokens: 512, llmPromptTokens: 0, llmCompletionTokens: 0, totalTokens: 512 });
    h.complete(1, 5);

    const trail = collector.finalize();
    expect(trail.operations).toHaveLength(1);
    expect(trail.operations[0]!.operationType).toBe('embedding');
  });

  it('aggregates multiple operations correctly', () => {
    const collector = new RAGAuditCollector({ requestId: 'r', query: 'q' });

    // Embedding operation
    collector.startOperation('embedding')
      .setTokenUsage({ embeddingTokens: 256, llmPromptTokens: 0, llmCompletionTokens: 0, totalTokens: 256 })
      .setCost(0.001)
      .complete(1, 5);

    // Vector query
    collector.startOperation('vector_query')
      .addSources([
        { chunkId: 'c1', documentId: 'doc-1', relevanceScore: 0.9, dataSourceId: 'ds-a' },
        { chunkId: 'c2', documentId: 'doc-2', relevanceScore: 0.8, dataSourceId: 'ds-a' },
      ])
      .setCollectionIds(['col-1'])
      .setDataSourceIds(['ds-a'])
      .complete(2, 15);

    // Rerank with LLM usage
    collector.startOperation('rerank')
      .setTokenUsage({ embeddingTokens: 0, llmPromptTokens: 100, llmCompletionTokens: 20, totalTokens: 120 })
      .setCost(0.002)
      .setRerankDetails({ providerId: 'cohere', modelId: 'rerank-v3', documentsReranked: 2 })
      .complete(2, 10);

    const trail = collector.finalize();

    expect(trail.summary.totalOperations).toBe(3);
    expect(trail.summary.totalEmbeddingCalls).toBe(1);
    expect(trail.summary.totalLLMCalls).toBe(1); // rerank with LLM tokens
    expect(trail.summary.totalTokens).toBe(256 + 120);
    expect(trail.summary.totalPromptTokens).toBe(100);
    expect(trail.summary.totalCompletionTokens).toBe(20);
    expect(trail.summary.totalEmbeddingTokens).toBe(256);
    expect(trail.summary.totalCostUSD).toBeCloseTo(0.003, 6);
    expect(trail.summary.operationTypes).toEqual(
      expect.arrayContaining(['embedding', 'vector_query', 'rerank']),
    );
    expect(trail.summary.sourceSummary.uniqueDocuments).toBe(2);
    expect(trail.summary.sourceSummary.uniqueCollections).toBe(1);
    expect(trail.summary.sourceSummary.uniqueDataSources).toBe(1);
  });

  it('counts graph operations as LLM calls when they have prompt tokens', () => {
    const collector = new RAGAuditCollector({ requestId: 'r', query: 'q' });
    collector.startOperation('graph_global')
      .setTokenUsage({ embeddingTokens: 0, llmPromptTokens: 500, llmCompletionTokens: 200, totalTokens: 700 })
      .setGraphDetails({ entitiesMatched: 10, communitiesSearched: 3, traversalTimeMs: 50 })
      .complete(5, 100);

    const trail = collector.finalize();
    expect(trail.summary.totalLLMCalls).toBe(1);
    expect(trail.summary.totalEmbeddingCalls).toBe(0);
    expect(trail.summary.totalTokens).toBe(700);
  });

  it('does not count graph operations as LLM calls when no prompt tokens', () => {
    const collector = new RAGAuditCollector({ requestId: 'r', query: 'q' });
    collector.startOperation('graph_local')
      .setTokenUsage({ embeddingTokens: 0, llmPromptTokens: 0, llmCompletionTokens: 0, totalTokens: 0 })
      .complete(2, 10);

    const trail = collector.finalize();
    expect(trail.summary.totalLLMCalls).toBe(0);
  });

  it('deduplicates documents and data sources in summary', () => {
    const collector = new RAGAuditCollector({ requestId: 'r', query: 'q' });

    // Two operations referencing overlapping documents
    collector.startOperation('vector_query')
      .addSources([
        { chunkId: 'c1', documentId: 'doc-1', dataSourceId: 'ds-a' },
        { chunkId: 'c2', documentId: 'doc-2', dataSourceId: 'ds-a' },
      ])
      .setDataSourceIds(['ds-a'])
      .setCollectionIds(['col-1'])
      .complete(2, 0);

    collector.startOperation('vector_query')
      .addSources([
        { chunkId: 'c3', documentId: 'doc-1', dataSourceId: 'ds-b' }, // same doc, different ds
        { chunkId: 'c4', documentId: 'doc-3', dataSourceId: 'ds-a' },
      ])
      .setDataSourceIds(['ds-b'])
      .setCollectionIds(['col-1', 'col-2'])
      .complete(2, 0);

    const trail = collector.finalize();
    expect(trail.summary.sourceSummary.uniqueDocuments).toBe(3); // doc-1, doc-2, doc-3
    expect(trail.summary.sourceSummary.uniqueDataSources).toBe(2); // ds-a, ds-b
    expect(trail.summary.sourceSummary.uniqueCollections).toBe(2); // col-1, col-2
  });

  describe('UsageLedger integration', () => {
    it('pushes operations to ledger on finalize', () => {
      const ingestUsage = vi.fn();
      const collector = new RAGAuditCollector({
        requestId: 'r',
        query: 'q',
        sessionId: 'sess-1',
        seedId: 'seed-1',
        usageLedger: { ingestUsage },
      });

      collector.startOperation('embedding')
        .setTokenUsage({ embeddingTokens: 256, llmPromptTokens: 0, llmCompletionTokens: 0, totalTokens: 256 })
        .setCost(0.001)
        .complete(1, 0);

      collector.startOperation('vector_query').complete(5, 0);

      collector.startOperation('rerank')
        .setTokenUsage({ embeddingTokens: 0, llmPromptTokens: 50, llmCompletionTokens: 10, totalTokens: 60 })
        .setRerankDetails({ providerId: 'cohere', modelId: 'rerank-v3', documentsReranked: 5 })
        .setCost(0.002)
        .complete(5, 0);

      collector.finalize();

      expect(ingestUsage).toHaveBeenCalledTimes(3);

      // Embedding call
      expect(ingestUsage).toHaveBeenCalledWith(
        { sessionId: 'sess-1', personaId: 'seed-1', providerId: 'rag-embedding', modelId: undefined },
        expect.objectContaining({ totalTokens: 256, costUSD: 0.001, isFinal: true }),
      );

      // Vector call
      expect(ingestUsage).toHaveBeenCalledWith(
        { sessionId: 'sess-1', personaId: 'seed-1', providerId: 'rag-vector', modelId: undefined },
        expect.objectContaining({ totalTokens: 0, isFinal: true }),
      );

      // Rerank call
      expect(ingestUsage).toHaveBeenCalledWith(
        { sessionId: 'sess-1', personaId: 'seed-1', providerId: 'rag-rerank', modelId: 'rerank-v3' },
        expect.objectContaining({ promptTokens: 50, completionTokens: 10, totalTokens: 60, costUSD: 0.002 }),
      );
    });

    it('skips ledger push when no sessionId', () => {
      const ingestUsage = vi.fn();
      const collector = new RAGAuditCollector({
        requestId: 'r',
        query: 'q',
        usageLedger: { ingestUsage },
        // no sessionId
      });
      collector.startOperation('embedding').complete(1, 0);
      collector.finalize();
      expect(ingestUsage).not.toHaveBeenCalled();
    });

    it('skips ledger push when no usageLedger provided', () => {
      const collector = new RAGAuditCollector({
        requestId: 'r',
        query: 'q',
        sessionId: 'sess',
        // no usageLedger
      });
      collector.startOperation('embedding').complete(1, 0);
      // Should not throw
      expect(() => collector.finalize()).not.toThrow();
    });

    it('maps graph operations to rag-graphrag provider', () => {
      const ingestUsage = vi.fn();
      const collector = new RAGAuditCollector({
        requestId: 'r',
        query: 'q',
        sessionId: 'sess',
        usageLedger: { ingestUsage },
      });
      collector.startOperation('graph_global')
        .setTokenUsage({ embeddingTokens: 0, llmPromptTokens: 100, llmCompletionTokens: 50, totalTokens: 150 })
        .complete(3, 0);
      collector.finalize();

      expect(ingestUsage).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'rag-graphrag' }),
        expect.anything(),
      );
    });
  });

  it('totalDurationMs covers the collector lifetime', () => {
    const collector = new RAGAuditCollector({ requestId: 'r', query: 'q' });
    // Finalize immediately — duration should be >= 0
    const trail = collector.finalize();
    expect(trail.summary.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});
