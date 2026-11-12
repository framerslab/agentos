/**
 * @fileoverview Integration tests for RAG reranking feature
 * @module backend/agentos/tests/rag/Reranking.spec
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RerankerService,
  CohereReranker,
  LocalCrossEncoderReranker,
  type IRerankerProvider,
  type RerankerServiceConfig,
} from '../../src/cognition/rag/reranking/index.js';
import type { RagRetrievedChunk } from '../../src/cognition/rag/IRetrievalAugmentor.js';

// Mock fetch for Cohere tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Stub transformers.js for the local provider: the tokenizer hands each pair's
// document on, and one model call scores the whole batch from the documents'
// lengths (one logit per pair), so the order is known and the scores differ.
const { transformersStub } = vi.hoisted(() => ({ transformersStub: () => {
  const tokenizer = vi.fn((_queries: string[], options: { text_pair: string[] }) => ({
    documents: options.text_pair,
  }));
  const model: any = vi.fn(async (inputs: { documents: string[] }) => ({
    logits: {
      data: Float32Array.from(inputs.documents.map((doc) => doc.length / 10 - 3)),
      dims: [inputs.documents.length, 1],
    },
  }));
  model.config = { id2label: { '0': 'LABEL_0' } };
  model.dispose = vi.fn(async () => {});
  return {
    AutoTokenizer: { from_pretrained: vi.fn().mockResolvedValue(tokenizer) },
    AutoModelForSequenceClassification: { from_pretrained: vi.fn().mockResolvedValue(model) },
    env: { allowLocalModels: true, useBrowserCache: false },
  };
} }));

vi.mock('@huggingface/transformers', () => transformersStub());
vi.mock('@xenova/transformers', () => transformersStub());

describe('Reranking Integration', () => {
  describe('RerankerService with Multiple Providers', () => {
    let service: RerankerService;
    let cohereProvider: CohereReranker;
    let localProvider: LocalCrossEncoderReranker;

    const serviceConfig: RerankerServiceConfig = {
      providers: [
        { providerId: 'cohere', apiKey: 'test-key', defaultModelId: 'rerank-english-v3.0' },
        { providerId: 'local', defaultModelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2' },
      ],
      defaultProviderId: 'local',
    };

    beforeEach(() => {
      vi.clearAllMocks();
      service = new RerankerService({ config: serviceConfig });

      cohereProvider = new CohereReranker({
        providerId: 'cohere',
        apiKey: 'test-key',
        defaultModelId: 'rerank-english-v3.0',
      });

      localProvider = new LocalCrossEncoderReranker({
        providerId: 'local',
        defaultModelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2',
      });

      service.registerProvider(cohereProvider);
      service.registerProvider(localProvider);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should list both registered providers', () => {
      const providers = service.listProviders();
      expect(providers).toContain('cohere');
      expect(providers).toContain('local');
    });

    it('should use default provider when not specified', async () => {
      const chunks: RagRetrievedChunk[] = [
        { id: '1', content: 'Test content', originalDocumentId: 'doc-1', relevanceScore: 0.8 },
      ];

      // Local provider should be used (it's the default)
      const result = await service.rerankChunks('test query', chunks);

      expect(result).toBeDefined();
      expect(result.length).toBe(1);
    });

    it('should switch between providers based on config', async () => {
      // Mock Cohere response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [{ index: 0, relevance_score: 0.95 }],
          }),
      });

      const chunks: RagRetrievedChunk[] = [
        { id: '1', content: 'Test content', originalDocumentId: 'doc-1', relevanceScore: 0.8 },
      ];

      // Explicitly use Cohere
      const result = await service.rerankChunks('test query', chunks, {
        providerId: 'cohere',
      });

      expect(mockFetch).toHaveBeenCalled();
      expect(result[0].relevanceScore).toBe(0.95);
    });
  });

  describe('End-to-End Reranking Workflow', () => {
    let service: RerankerService;

    beforeEach(() => {
      service = new RerankerService({
        config: {
          providers: [{ providerId: 'local' }],
          defaultProviderId: 'local',
        },
      });

      service.registerProvider(
        new LocalCrossEncoderReranker({
          providerId: 'local',
          defaultModelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2',
        }),
      );
    });

    it('should rerank documents and change order based on relevance', async () => {
      const chunks: RagRetrievedChunk[] = [
        { id: 'chunk-1', content: 'Python is a programming language', originalDocumentId: 'doc-1', relevanceScore: 0.9 },
        { id: 'chunk-2', content: 'Machine learning uses neural networks', originalDocumentId: 'doc-2', relevanceScore: 0.8 },
        { id: 'chunk-3', content: 'What is machine learning explained simply', originalDocumentId: 'doc-3', relevanceScore: 0.7 },
        { id: 'chunk-4', content: 'Deep learning is a subset of ML', originalDocumentId: 'doc-4', relevanceScore: 0.6 },
        { id: 'chunk-5', content: 'JavaScript runs in browsers', originalDocumentId: 'doc-5', relevanceScore: 0.5 },
      ];

      const query = 'What is machine learning?';
      const result = await service.rerankChunks(query, chunks);

      // Results should be sorted by relevance score (descending)
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].relevanceScore).toBeGreaterThanOrEqual(result[i].relevanceScore!);
      }

      // Original document IDs should be preserved
      result.forEach((chunk) => {
        expect(chunk.originalDocumentId).toBeDefined();
      });
    });

    it('should preserve metadata through reranking', async () => {
      const chunks: RagRetrievedChunk[] = [
        {
          id: 'chunk-1',
          content: 'Test content',
          originalDocumentId: 'doc-1',
          relevanceScore: 0.9,
          metadata: {
            source: 'wikipedia',
            category: 'science',
            page: 42,
          },
        },
      ];

      const result = await service.rerankChunks('test query', chunks);

      expect(result[0].metadata?.source).toBe('wikipedia');
      expect(result[0].metadata?.category).toBe('science');
      expect(result[0].metadata?.page).toBe(42);
      // Reranker should add its own metadata
      expect(result[0].metadata?._rerankerOriginalScore).toBeDefined();
      expect(result[0].metadata?._rerankerProviderId).toBe('local');
    });

    it('should apply topN filtering after reranking', async () => {
      const chunks: RagRetrievedChunk[] = Array.from({ length: 10 }, (_, i) => ({
        id: `chunk-${i}`,
        content: `Content ${i}`,
        originalDocumentId: `doc-${i}`,
        relevanceScore: 0.9 - i * 0.05,
      }));

      const result = await service.rerankChunks('test query', chunks, { topN: 3 });

      expect(result.length).toBe(3);
    });
  });

  describe('Error Handling', () => {
    it('should throw when provider is not registered', async () => {
      const service = new RerankerService({
        config: { providers: [], defaultProviderId: undefined },
      });

      const chunks: RagRetrievedChunk[] = [
        { id: '1', content: 'Test', originalDocumentId: 'doc-1' },
      ];

      await expect(
        service.rerankChunks('test', chunks, { providerId: 'nonexistent' }),
      ).rejects.toThrow('not found');
    });

    it('should handle API errors from Cohere', async () => {
      const service = new RerankerService({
        config: {
          providers: [{ providerId: 'cohere', apiKey: 'test' }],
          defaultProviderId: 'cohere',
        },
      });

      service.registerProvider(
        new CohereReranker({ providerId: 'cohere', apiKey: 'invalid-key' }),
      );

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('Invalid API key'),
      });

      const chunks: RagRetrievedChunk[] = [
        { id: '1', content: 'Test', originalDocumentId: 'doc-1' },
      ];

      await expect(service.rerankChunks('test', chunks)).rejects.toThrow(/API error/);
    });
  });

  describe('Performance Considerations', () => {
    it('should handle large document sets with maxDocuments limit', async () => {
      const service = new RerankerService({
        config: {
          providers: [{ providerId: 'local' }],
          defaultProviderId: 'local',
        },
      });

      service.registerProvider(
        new LocalCrossEncoderReranker({ providerId: 'local' }),
      );

      // Create 200 chunks
      const chunks: RagRetrievedChunk[] = Array.from({ length: 200 }, (_, i) => ({
        id: `chunk-${i}`,
        content: `Content ${i}`,
        originalDocumentId: `doc-${i}`,
        relevanceScore: Math.random(),
      }));

      // Limit to 50 documents
      const result = await service.rerankChunks('test query', chunks, {
        maxDocuments: 50,
        topN: 10,
      });

      expect(result.length).toBeLessThanOrEqual(10);
    });
  });
});
