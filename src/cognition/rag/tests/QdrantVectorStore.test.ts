/**
 * @file QdrantVectorStore.test.ts
 * @description Tests for the Qdrant-backed vector store implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { QdrantVectorStore } from '../vector_stores/QdrantVectorStore';
import type { VectorDocument } from '../IVectorStore';

type FetchCall = { url: string; init?: RequestInit };

const jsonResponse = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('QdrantVectorStore', () => {
  let store: QdrantVectorStore;
  let calls: FetchCall[];
  // Explicitly type as `any` to avoid vitest Mock generic variance issues in `tsc --noEmit`.
  let fetchStub: any;

  const makeDoc = (
    id: string,
    embedding: number[],
    metadata?: Record<string, any>,
    textContent?: string,
  ): VectorDocument => ({
    id,
    embedding,
    metadata,
    textContent,
  });

  beforeEach(async () => {
    calls = [];
    fetchStub = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });

      // Health
      if (String(url).endsWith('/healthz')) {
        return new Response('ok', { status: 200 });
      }

      // Collection exists checks
      if (String(url).includes('/collections/test-col') && init?.method === 'GET') {
        return jsonResponse({ result: { collection: { status: 'green' } } }, 404);
      }

      // Create collection
      if (String(url).includes('/collections/test-col') && init?.method === 'PUT') {
        return jsonResponse({ result: true });
      }

      // Upsert points
      if (String(url).includes('/collections/test-col/points') && init?.method === 'PUT') {
        return jsonResponse({ result: { operation_id: 1 } });
      }

      // Query API
      if (String(url).includes('/collections/test-col/points/query') && init?.method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const using = body?.using;

        if (using === 'dense') {
          return jsonResponse({
            result: {
              points: [
                {
                  id: 'doc1',
                  score: 0.9,
                  payload: { __text: 'Hello world', tag: 'a' },
                  vector: { dense: [0.1, 0.2, 0.3] },
                },
              ],
            },
            time: 0.01,
          });
        }

        if (using === 'bm25') {
          return jsonResponse({
            result: {
              points: [
                {
                  id: 'doc2',
                  score: 0.8,
                  payload: { __text: 'Second doc', tag: 'b' },
                },
              ],
            },
          });
        }

        // Hybrid server-side fusion (rrf) uses `prefetch` + `query`
        if (Array.isArray(body?.prefetch)) {
          return jsonResponse({
            result: {
              points: [
                {
                  id: 'doc2',
                  score: 0.77,
                  payload: { __text: 'Second doc', tag: 'b' },
                },
                {
                  id: 'doc1',
                  score: 0.66,
                  payload: { __text: 'Hello world', tag: 'a' },
                },
              ],
            },
          });
        }
      }

      // Scroll API
      if (String(url).includes('/collections/test-col/points/scroll') && init?.method === 'POST') {
        return jsonResponse({
          result: {
            points: [
              {
                id: 'doc-expired',
                payload: {
                  __text: 'Expired memory',
                  tag: 'a',
                  category: 'episodic',
                  timestamp: '2024-01-01T00:00:00.000Z',
                },
                vector: { dense: [0.4, 0.5, 0.6] },
              },
              {
                id: 'doc-fresh',
                payload: {
                  __text: 'Fresh memory',
                  tag: 'b',
                  category: 'semantic',
                  timestamp: '2026-04-20T00:00:00.000Z',
                },
                vector: { dense: [0.7, 0.8, 0.9] },
              },
            ],
            next_page_offset: null,
          },
          time: 0.01,
        });
      }

      // Delete points
      if (String(url).includes('/points/delete') && init?.method === 'POST') {
        return jsonResponse({ result: { operation_id: 2 } });
      }

      return jsonResponse({ result: {} });
    });

    store = new QdrantVectorStore();
    await store.initialize({
      id: 'qdrant-test',
      type: 'qdrant',
      url: 'http://localhost:6333',
      fetch: fetchStub as any,
      enableBm25: true,
    } as any);
  });

  afterEach(async () => {
    await store.shutdown();
  });

  it('checkHealth uses /healthz', async () => {
    const health = await store.checkHealth();
    expect(health.isHealthy).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/healthz'))).toBe(true);
  });

  it('createCollection creates dense + bm25 fields', async () => {
    await store.createCollection?.('test-col', 3, { similarityMetric: 'cosine' });
    const put = calls.find((c) => c.url.includes('/collections/test-col') && c.init?.method === 'PUT');
    expect(put).toBeTruthy();
    const body = put?.init?.body ? JSON.parse(String(put.init.body)) : {};
    expect(body?.vectors?.dense?.size).toBe(3);
    expect(body?.vectors?.dense?.distance).toBe('Cosine');
    expect(body?.sparse_vectors?.bm25).toBeTruthy();
  });

  it('upsert stores payload text and bm25 text vector', async () => {
    await store.createCollection?.('test-col', 3);
    await store.upsert('test-col', [makeDoc('doc1', [0.1, 0.2, 0.3], { tag: 'a' }, 'Hello world')]);

    const put = calls.find((c) => c.url.includes('/collections/test-col/points') && c.init?.method === 'PUT');
    expect(put).toBeTruthy();
    const body = put?.init?.body ? JSON.parse(String(put.init.body)) : {};
    const point = body?.points?.[0];
    expect(point?.id).toBe('doc1');
    expect(point?.payload?.__text).toBe('Hello world');
    expect(point?.payload?.tag).toBe('a');
    expect(point?.vector?.dense).toEqual([0.1, 0.2, 0.3]);
    expect(point?.vector?.bm25?.text).toBe('Hello world');
  });

  it('query maps payload to metadata/textContent', async () => {
    const result = await store.query('test-col', [0.1, 0.2, 0.3], {
      topK: 5,
      includeMetadata: true,
      includeTextContent: true,
      includeEmbedding: true,
    });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].id).toBe('doc1');
    expect(result.documents[0].textContent).toBe('Hello world');
    expect(result.documents[0].metadata).toEqual({ tag: 'a' });
    expect(result.documents[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('hybridSearch (weighted) performs dense + bm25 queries', async () => {
    const result = await store.hybridSearch?.('test-col', [0.1, 0.2, 0.3], 'hello', {
      topK: 2,
      includeMetadata: true,
      includeTextContent: true,
      fusion: 'weighted',
      alpha: 0.7,
    });

    expect(result?.documents).toBeTruthy();
    const queryCalls = calls.filter((c) => c.url.includes('/points/query') && c.init?.method === 'POST');
    // 1 dense + 1 bm25 call
    expect(queryCalls.length).toBeGreaterThanOrEqual(2);
    expect(result!.documents.length).toBeGreaterThanOrEqual(1);
  });

  it('delete calls points/delete', async () => {
    await store.delete('test-col', ['doc1']);
    const del = calls.find((c) => c.url.includes('/points/delete') && c.init?.method === 'POST');
    expect(del).toBeTruthy();
  });

  it('scanByMetadata scrolls filtered points with text, metadata, and embeddings', async () => {
    expect(store.scanByMetadata).toBeTypeOf('function');

    const result = await store.scanByMetadata?.('test-col', {
      filter: {
        category: 'episodic',
        timestamp: { $lt: '2025-01-01T00:00:00.000Z' },
      },
      includeMetadata: true,
      includeTextContent: true,
      includeEmbedding: true,
      limit: 10,
    });

    expect(result?.documents).toHaveLength(1);
    expect(result?.documents[0]).toMatchObject({
      id: 'doc-expired',
      textContent: 'Expired memory',
      metadata: {
        tag: 'a',
        category: 'episodic',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
      embedding: [0.4, 0.5, 0.6],
      similarityScore: 1,
    });

    const scrollCall = calls.find((c) => c.url.includes('/points/scroll') && c.init?.method === 'POST');
    expect(scrollCall).toBeTruthy();
    const body = scrollCall?.init?.body ? JSON.parse(String(scrollCall.init.body)) : {};
    expect(body.limit).toBe(10);
    expect(body.with_payload).toBe(true);
    expect(body.with_vector).toBe(true);
  });
});
