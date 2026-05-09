/**
 * @module rag/multimodal/__tests__/MultimodalIndexer.spec
 *
 * Unit tests for {@link MultimodalIndexer}.
 *
 * Uses mocked vision LLM, STT provider, embedding manager, and vector
 * store to test the full indexing and search flows in isolation.
 *
 * ## What is tested
 *
 * - Constructor validates required dependencies
 * - Image indexing: vision description -> embedding -> vector store upsert
 * - Image indexing with Buffer converts to base64 data URL
 * - Image indexing with URL string passes through unchanged
 * - Audio indexing: STT transcription -> embedding -> vector store upsert
 * - Audio indexing forwards language hint to STT provider
 * - Cross-modal search: embeds query -> queries vector store -> returns results
 * - Modality filtering in search (single and multiple modalities)
 * - Missing vision provider throws on image indexing
 * - Missing STT provider throws on audio indexing
 * - Empty description from vision provider throws
 * - Empty transcript from STT provider throws
 * - Custom collection names are forwarded
 * - Metadata is preserved through indexing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MultimodalIndexer } from '../MultimodalIndexer.js';
import type { IVisionProvider, ISpeechToTextProvider } from '../types.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * Create a mock embedding manager that returns deterministic embeddings.
 * Each call returns a fixed-length vector so upsert/query assertions work.
 */
function createMockEmbeddingManager() {
  return {
    generateEmbeddings: vi.fn(async () => ({
      embeddings: [[0.1, 0.2, 0.3, 0.4]],
      modelId: 'test-model',
      providerId: 'test-provider',
      usage: { inputTokens: 10, totalTokens: 10, costUSD: 0 },
    })),
    getEmbeddingDimension: vi.fn(async () => 4),
    getEmbeddingModelInfo: vi.fn(async () => undefined),
    initialize: vi.fn(async () => {}),
    checkHealth: vi.fn(async () => ({ isHealthy: true })),
    shutdown: vi.fn(async () => {}),
  };
}

/**
 * Create a mock vector store that captures upserted documents and
 * returns configurable search results.
 */
function createMockVectorStore() {
  const upsertedDocuments: Array<{ collection: string; docs: unknown[] }> = [];

  return {
    upserted: upsertedDocuments,
    initialize: vi.fn(async () => {}),
    upsert: vi.fn(async (collection: string, docs: unknown[]) => {
      upsertedDocuments.push({ collection, docs });
      return { upsertedCount: docs.length };
    }),
    query: vi.fn(async () => ({
      documents: [
        {
          id: 'doc-1',
          embedding: [0.1, 0.2, 0.3, 0.4],
          textContent: 'A golden retriever playing fetch on a beach.',
          metadata: { modality: 'image', source: 'upload' },
          similarityScore: 0.95,
        },
        {
          id: 'doc-2',
          embedding: [0.1, 0.2, 0.3, 0.4],
          textContent: 'Welcome to the machine learning podcast episode 42.',
          metadata: { modality: 'audio', language: 'en' },
          similarityScore: 0.82,
        },
        {
          id: 'doc-3',
          embedding: [0.1, 0.2, 0.3, 0.4],
          textContent: 'Introduction to neural networks.',
          metadata: { modality: 'text' },
          similarityScore: 0.75,
        },
      ],
    })),
    delete: vi.fn(async () => ({ deletedCount: 0 })),
    checkHealth: vi.fn(async () => ({ isHealthy: true })),
    shutdown: vi.fn(async () => {}),
  };
}

/** Create a mock vision provider that returns a canned description. */
function createMockVisionProvider(): IVisionProvider {
  return {
    describeImage: vi.fn(async () => 'A golden retriever playing fetch on a sandy beach.'),
  };
}

/** Create a mock STT provider that returns a canned transcript. */
function createMockSttProvider(): ISpeechToTextProvider {
  return {
    transcribe: vi.fn(async () => 'Welcome to the machine learning podcast episode 42.'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MultimodalIndexer', () => {
  let embeddingManager: ReturnType<typeof createMockEmbeddingManager>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let visionProvider: IVisionProvider;
  let sttProvider: ISpeechToTextProvider;
  let indexer: MultimodalIndexer;

  beforeEach(() => {
    embeddingManager = createMockEmbeddingManager();
    vectorStore = createMockVectorStore();
    visionProvider = createMockVisionProvider();
    sttProvider = createMockSttProvider();

    indexer = new MultimodalIndexer({
      embeddingManager: embeddingManager as any,
      vectorStore: vectorStore as any,
      visionProvider,
      sttProvider,
    });
  });

  // -------------------------------------------------------------------------
  // Constructor validation
  // -------------------------------------------------------------------------

  it('should throw if embeddingManager is missing', () => {
    expect(() => new MultimodalIndexer({
      embeddingManager: null as any,
      vectorStore: vectorStore as any,
    })).toThrow(/requires an IEmbeddingManager/);
  });

  it('should throw if vectorStore is missing', () => {
    expect(() => new MultimodalIndexer({
      embeddingManager: embeddingManager as any,
      vectorStore: null as any,
    })).toThrow(/requires an IVectorStore/);
  });

  it('should construct without optional providers', () => {
    expect(() => new MultimodalIndexer({
      embeddingManager: embeddingManager as any,
      vectorStore: vectorStore as any,
      // No visionProvider or sttProvider
    })).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Image indexing
  // -------------------------------------------------------------------------

  it('should index an image from a URL string', async () => {
    const result = await indexer.indexImage({
      image: 'https://example.com/photo.jpg',
      metadata: { source: 'web' },
    });

    // Should have called vision provider with the URL
    expect(visionProvider.describeImage).toHaveBeenCalledWith('https://example.com/photo.jpg');

    // Should have embedded the description
    expect(embeddingManager.generateEmbeddings).toHaveBeenCalledTimes(1);
    const embReq = (embeddingManager.generateEmbeddings.mock.calls as any)[0][0];
    expect(embReq.texts[0]).toContain('golden retriever');

    // Should have upserted to vector store
    expect(vectorStore.upsert).toHaveBeenCalledTimes(1);
    const [collection, docs] = vectorStore.upsert.mock.calls[0] as any;
    expect(collection).toBe('multimodal');
    expect(docs).toHaveLength(1);
    expect(docs[0].metadata.modality).toBe('image');
    expect(docs[0].metadata.source).toBe('web');
    expect(docs[0].textContent).toContain('golden retriever');

    // Should return document ID and description
    expect(result.id).toBeTruthy();
    expect(result.description).toContain('golden retriever');
  });

  it('should index image URLs even when the Buffer global is unavailable', async () => {
    const originalBuffer = (globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer;
    Reflect.deleteProperty(globalThis as typeof globalThis & Record<string, unknown>, 'Buffer');

    try {
      await indexer.indexImage({
        image: 'https://example.com/no-buffer.jpg',
      });
    } finally {
      (globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer = originalBuffer;
    }

    expect(visionProvider.describeImage).toHaveBeenCalledWith('https://example.com/no-buffer.jpg');
  });

  it('should convert Buffer to base64 data URL for vision provider', async () => {
    const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    await indexer.indexImage({ image: imageBuffer });

    const calledWith = (visionProvider.describeImage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledWith).toMatch(/^data:image\/png;base64,/);
  });

  it('should use custom collection name for image indexing', async () => {
    await indexer.indexImage({
      image: 'https://example.com/img.jpg',
      collection: 'custom-images',
    });

    expect((vectorStore.upsert.mock.calls as any)[0][0]).toBe('custom-images');
  });

  it('should throw if no vision provider is configured', async () => {
    const noVisionIndexer = new MultimodalIndexer({
      embeddingManager: embeddingManager as any,
      vectorStore: vectorStore as any,
    });

    await expect(noVisionIndexer.indexImage({
      image: 'https://example.com/img.jpg',
    })).rejects.toThrow(/no vision provider/);
  });

  it('should throw if vision provider returns empty description', async () => {
    (visionProvider.describeImage as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');

    await expect(indexer.indexImage({
      image: 'https://example.com/img.jpg',
    })).rejects.toThrow(/empty description/);
  });

  // -------------------------------------------------------------------------
  // Audio indexing
  // -------------------------------------------------------------------------

  it('should index text by embedding and storing it with text modality metadata', async () => {
    const result = await (indexer as any).indexText({
      text: 'Quarterly revenue increased 18 percent.',
      metadata: { source: 'pdf', sourceModality: 'pdf' },
      collection: 'documents',
    });

    expect(embeddingManager.generateEmbeddings).toHaveBeenCalledWith({
      texts: ['Quarterly revenue increased 18 percent.'],
    });

    expect(vectorStore.upsert).toHaveBeenCalledTimes(1);
    const [collection, docs] = vectorStore.upsert.mock.calls[0] as any;
    expect(collection).toBe('documents');
    expect(docs).toHaveLength(1);
    expect(docs[0].textContent).toBe('Quarterly revenue increased 18 percent.');
    expect(docs[0].metadata.modality).toBe('text');
    expect(docs[0].metadata.sourceModality).toBe('pdf');
    expect(result.id).toBeTruthy();
    expect(result.text).toBe('Quarterly revenue increased 18 percent.');
  });

  it('should index audio by transcribing and embedding', async () => {
    const audioBuffer = Buffer.from('fake audio data');
    const result = await indexer.indexAudio({
      audio: audioBuffer,
      metadata: { source: 'podcast' },
      language: 'en',
    });

    // Should have called STT provider
    expect(sttProvider.transcribe).toHaveBeenCalledWith(audioBuffer, 'en');

    // Should have embedded the transcript
    expect(embeddingManager.generateEmbeddings).toHaveBeenCalledTimes(1);
    const embReq = (embeddingManager.generateEmbeddings.mock.calls as any)[0][0];
    expect(embReq.texts[0]).toContain('machine learning podcast');

    // Should have upserted to vector store
    expect(vectorStore.upsert).toHaveBeenCalledTimes(1);
    const [collection, docs] = vectorStore.upsert.mock.calls[0] as any;
    expect(collection).toBe('multimodal');
    expect(docs[0].metadata.modality).toBe('audio');
    expect(docs[0].metadata.source).toBe('podcast');
    expect(docs[0].metadata.language).toBe('en');

    // Should return document ID and transcript
    expect(result.id).toBeTruthy();
    expect(result.transcript).toContain('machine learning podcast');
  });

  it('should use custom collection name for audio indexing', async () => {
    await indexer.indexAudio({
      audio: Buffer.from('audio'),
      collection: 'meeting-recordings',
    });

    expect((vectorStore.upsert.mock.calls as any)[0][0]).toBe('meeting-recordings');
  });

  it('should throw if no STT provider is configured', async () => {
    const noSttIndexer = new MultimodalIndexer({
      embeddingManager: embeddingManager as any,
      vectorStore: vectorStore as any,
    });

    await expect(noSttIndexer.indexAudio({
      audio: Buffer.from('audio'),
    })).rejects.toThrow(/no STT provider/);
  });

  it('should throw if STT provider returns empty transcript', async () => {
    (sttProvider.transcribe as ReturnType<typeof vi.fn>).mockResolvedValueOnce('  ');

    await expect(indexer.indexAudio({
      audio: Buffer.from('audio'),
    })).rejects.toThrow(/empty transcript/);
  });

  // -------------------------------------------------------------------------
  // Cross-modal search
  // -------------------------------------------------------------------------

  it('should search across all modalities and return annotated results', async () => {
    const results = await indexer.search('dogs on beach');

    // Should have embedded the query
    expect(embeddingManager.generateEmbeddings).toHaveBeenCalledTimes(1);
    const embReq = (embeddingManager.generateEmbeddings.mock.calls as any)[0][0];
    expect(embReq.texts[0]).toBe('dogs on beach');

    // Should have queried vector store
    expect(vectorStore.query).toHaveBeenCalledTimes(1);
    const [collection, _embedding, queryOpts] = vectorStore.query.mock.calls[0] as any;
    expect(collection).toBe('multimodal');
    expect(queryOpts.topK).toBe(5);
    expect(queryOpts.includeMetadata).toBe(true);
    expect(queryOpts.includeTextContent).toBe(true);

    // Should return 3 results from mock
    expect(results).toHaveLength(3);

    // Verify result shapes
    expect(results[0].id).toBe('doc-1');
    expect(results[0].modality).toBe('image');
    expect(results[0].score).toBe(0.95);
    expect(results[0].content).toContain('golden retriever');

    expect(results[1].id).toBe('doc-2');
    expect(results[1].modality).toBe('audio');
    expect(results[1].score).toBe(0.82);

    expect(results[2].id).toBe('doc-3');
    expect(results[2].modality).toBe('text');
    expect(results[2].score).toBe(0.75);
  });

  it('should filter by single modality', async () => {
    await indexer.search('cats', { modalities: ['image'] });

    const queryOpts = (vectorStore.query.mock.calls as any)[0][2];
    expect(queryOpts.filter).toEqual({ modality: 'image' });
  });

  it('should filter by multiple modalities using $in', async () => {
    await indexer.search('cats', { modalities: ['image', 'audio'] });

    const queryOpts = (vectorStore.query.mock.calls as any)[0][2];
    expect(queryOpts.filter).toEqual({ modality: { $in: ['image', 'audio'] } });
  });

  it('should not apply modality filter when modalities is empty', async () => {
    await indexer.search('cats', { modalities: [] });

    const queryOpts = (vectorStore.query.mock.calls as any)[0][2];
    // No filter should be applied
    expect(queryOpts.filter).toBeUndefined();
  });

  it('should use custom topK and collection', async () => {
    await indexer.search('test', { topK: 20, collection: 'custom-coll' });

    const [collection, _embedding, queryOpts] = vectorStore.query.mock.calls[0] as any;
    expect(collection).toBe('custom-coll');
    expect(queryOpts.topK).toBe(20);
  });

  it('should use default collection from config', async () => {
    const customIndexer = new MultimodalIndexer({
      embeddingManager: embeddingManager as any,
      vectorStore: vectorStore as any,
      config: { defaultCollection: 'knowledge-base' },
    });

    await customIndexer.search('test');
    expect((vectorStore.query.mock.calls as any)[0][0]).toBe('knowledge-base');
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('should preserve all user metadata through image indexing', async () => {
    await indexer.indexImage({
      image: 'https://example.com/img.jpg',
      metadata: { source: 'upload', tags: 'landscape', userId: 'user-123' },
    });

    const doc = (vectorStore.upsert.mock.calls as any)[0][1][0];
    expect(doc.metadata.source).toBe('upload');
    expect(doc.metadata.tags).toBe('landscape');
    expect(doc.metadata.userId).toBe('user-123');
    // Modality should be added on top
    expect(doc.metadata.modality).toBe('image');
  });

  it('should preserve all user metadata through audio indexing', async () => {
    await indexer.indexAudio({
      audio: Buffer.from('audio'),
      metadata: { source: 'meeting', duration: 3600 },
    });

    const doc = (vectorStore.upsert.mock.calls as any)[0][1][0];
    expect(doc.metadata.source).toBe('meeting');
    expect(doc.metadata.duration).toBe(3600);
    expect(doc.metadata.modality).toBe('audio');
  });

  it('should generate unique IDs for each indexed document', async () => {
    const result1 = await indexer.indexImage({ image: 'https://example.com/1.jpg' });
    const result2 = await indexer.indexImage({ image: 'https://example.com/2.jpg' });

    expect(result1.id).not.toBe(result2.id);
  });
});
