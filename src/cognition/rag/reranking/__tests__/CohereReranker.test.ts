/**
 * @fileoverview Unit tests for CohereReranker provider
 * @module backend/agentos/rag/reranking/tests/CohereReranker.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CohereReranker, COHERE_RERANKER_MODELS } from '../providers/CohereReranker';
import type { RerankerInput, RerankerRequestConfig } from '../IRerankerService';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('CohereReranker', () => {
  let reranker: CohereReranker;
  const testApiKey = 'test-api-key';

  beforeEach(() => {
    vi.clearAllMocks();
    reranker = new CohereReranker({
      providerId: 'cohere',
      apiKey: testApiKey,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initialization', () => {
    it('should create instance with correct providerId', () => {
      expect(reranker.providerId).toBe('cohere');
    });

    it('should use custom base URL if provided', async () => {
      const customReranker = new CohereReranker({
        providerId: 'cohere',
        apiKey: testApiKey,
        baseUrl: 'https://custom.api.com',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      });

      await customReranker.rerank(
        { query: 'test', documents: [{ id: '1', content: 'test' }] },
        { providerId: 'cohere', modelId: 'rerank-english-v3.0' },
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom.api.com/v1/rerank',
        expect.anything(),
      );
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is configured', async () => {
      const isAvailable = await reranker.isAvailable();
      expect(isAvailable).toBe(true);
    });

    it('should return false when API key is missing', async () => {
      const noKeyReranker = new CohereReranker({
        providerId: 'cohere',
        apiKey: '',
      });
      const isAvailable = await noKeyReranker.isAvailable();
      expect(isAvailable).toBe(false);
    });
  });

  describe('getSupportedModels', () => {
    it('should return list of supported models', () => {
      const models = reranker.getSupportedModels();
      expect(models).toEqual(COHERE_RERANKER_MODELS);
      expect(models).toContain('rerank-english-v3.0');
      expect(models).toContain('rerank-multilingual-v3.0');
    });
  });

  describe('rerank', () => {
    const sampleInput: RerankerInput = {
      query: 'What is machine learning?',
      documents: [
        { id: 'doc-1', content: 'Machine learning is a subset of AI.', originalScore: 0.8 },
        { id: 'doc-2', content: 'Deep learning uses neural networks.', originalScore: 0.7 },
        { id: 'doc-3', content: 'Python is a programming language.', originalScore: 0.6 },
      ],
    };

    const sampleConfig: RerankerRequestConfig = {
      providerId: 'cohere',
      modelId: 'rerank-english-v3.0',
      topN: 2,
    };

    const mockCohereResponse = {
      results: [
        { index: 0, relevance_score: 0.95 },
        { index: 1, relevance_score: 0.85 },
      ],
      meta: {
        billed_units: { search_units: 1 },
      },
    };

    it('should call Cohere API with correct parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCohereResponse),
      });

      await reranker.rerank(sampleInput, sampleConfig);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cohere.ai/v1/rerank',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${testApiKey}`,
            'Content-Type': 'application/json',
          }),
        }),
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.query).toBe(sampleInput.query);
      expect(requestBody.documents).toHaveLength(3);
      expect(requestBody.model).toBe('rerank-english-v3.0');
      expect(requestBody.top_n).toBe(2);
    });

    it('should return reranked documents with scores', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCohereResponse),
      });

      const result = await reranker.rerank(sampleInput, sampleConfig);

      expect(result.results).toHaveLength(2);
      expect(result.results[0].id).toBe('doc-1');
      expect(result.results[0].relevanceScore).toBe(0.95);
      expect(result.results[0].originalScore).toBe(0.8);
      expect(result.results[1].id).toBe('doc-2');
      expect(result.results[1].relevanceScore).toBe(0.85);
    });

    it('should include diagnostics in response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCohereResponse),
      });

      const result = await reranker.rerank(sampleInput, sampleConfig);

      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics?.providerId).toBe('cohere');
      expect(result.diagnostics?.modelId).toBe('rerank-english-v3.0');
      expect(result.diagnostics?.documentsProcessed).toBe(3);
    });

    it('should handle API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('Invalid API key'),
      });

      await expect(reranker.rerank(sampleInput, sampleConfig)).rejects.toThrow(
        /Cohere API error/,
      );
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(reranker.rerank(sampleInput, sampleConfig)).rejects.toThrow(
        'Network error',
      );
    });

    it('should use default model when not specified', async () => {
      const rerankerWithDefault = new CohereReranker({
        providerId: 'cohere',
        apiKey: testApiKey,
        defaultModelId: 'rerank-multilingual-v3.0',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      });

      await rerankerWithDefault.rerank(sampleInput, {
        providerId: 'cohere',
        modelId: '', // Empty model should use default
      });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.model).toBe('rerank-multilingual-v3.0');
    });

    it('should respect timeout configuration', async () => {
      const controller = new AbortController();
      // Called with `new`, so the implementation must be constructible.
      vi.spyOn(global, 'AbortController').mockImplementation(function () {
        return controller;
      });

      mockFetch.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timeout')), 100);
          }),
      );

      await expect(
        reranker.rerank(sampleInput, { ...sampleConfig, timeoutMs: 50 }),
      ).rejects.toThrow();
    });

    it('should preserve document metadata', async () => {
      const inputWithMetadata: RerankerInput = {
        query: 'test',
        documents: [
          {
            id: 'doc-1',
            content: 'Test content',
            metadata: { source: 'wiki', page: 42 },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [{ index: 0, relevance_score: 0.9 }],
          }),
      });

      const result = await reranker.rerank(inputWithMetadata, sampleConfig);

      expect(result.results[0].metadata).toEqual({ source: 'wiki', page: 42 });
    });
  });
});
