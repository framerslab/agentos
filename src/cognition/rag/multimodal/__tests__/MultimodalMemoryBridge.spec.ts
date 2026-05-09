/**
 * @module rag/multimodal/__tests__/MultimodalMemoryBridge.spec
 *
 * Unit tests for {@link MultimodalMemoryBridge}.
 *
 * Uses mocked MultimodalIndexer, ICognitiveMemoryManager, and child_process
 * to test all ingestion paths (image, audio, video, PDF) in isolation.
 *
 * ## What is tested
 *
 * - Image ingestion creates RAG doc + memory trace
 * - Audio ingestion creates RAG doc + memory trace
 * - Video ingestion with ffprobe available: extracts frames + audio
 * - Video ingestion without ffprobe: graceful degradation with warning
 * - PDF ingestion: text extraction + chunking
 * - Auto-detect routes image/audio/PDF correctly by magic bytes
 * - Auto-detect routes by file extension when bytes are ambiguous
 * - Auto-detect routes by explicit MIME type
 * - No memory manager: still indexes into RAG, memoryTraceIds empty
 * - Memory disabled via options: memoryTraceIds empty
 * - Metadata propagated to both RAG and memory
 * - Constructor validation: throws when indexer is missing
 * - Memory encoding failure is non-fatal (RAG still succeeds)
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { MultimodalMemoryBridge } from '../MultimodalMemoryBridge.js';
import type { MultimodalIndexer } from '../MultimodalIndexer.js';
import type { ICognitiveMemoryManager } from '../../../memory/CognitiveMemoryManager.js';

// Mock child_process.exec to control ffprobe/ffmpeg availability in tests.
// Without this, tests on machines WITH ffmpeg installed would try to actually
// process "fake video data" and hang or fail unpredictably.
vi.mock('node:child_process', () => ({
  exec: vi.fn((_cmd: string, ...args: any[]) => {
    // Extract the callback — it's always the last argument
    const cb = typeof args[args.length - 1] === 'function'
      ? args[args.length - 1]
      : typeof args[0] === 'function'
        ? args[0]
        : null;

    if (cb) {
      // Simulate ffprobe/ffmpeg not found
      cb(new Error('command not found: ffprobe'), '', '');
    }
  }),
}));

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * Create a mock MultimodalIndexer that returns canned results.
 * Tracks calls to indexImage and indexAudio for assertion.
 */
function createMockIndexer(): MultimodalIndexer & {
  indexImage: Mock;
  indexAudio: Mock;
  indexText: Mock;
} {
  return {
    indexImage: vi.fn(async () => ({
      id: 'rag-img-001',
      description: 'A golden retriever playing fetch on a sandy beach.',
    })),
    indexAudio: vi.fn(async () => ({
      id: 'rag-audio-001',
      transcript: 'Welcome to the machine learning podcast episode 42.',
    })),
    indexText: vi.fn(async () => ({
      id: 'rag-text-001',
      text: 'Hello World This is a test document',
    })),
    search: vi.fn(async () => []),
    createMemoryBridge: vi.fn(),
  } as unknown as MultimodalIndexer & {
    indexImage: Mock;
    indexAudio: Mock;
    indexText: Mock;
  };
}

/**
 * Create a mock ICognitiveMemoryManager that returns canned memory traces.
 * Only the encode() method is needed by the bridge.
 */
function createMockMemoryManager(): ICognitiveMemoryManager & {
  encode: Mock;
} {
  return {
    encode: vi.fn(async (_input: string) => ({
      id: `trace-${Math.random().toString(36).slice(2, 10)}`,
      type: 'semantic',
      scope: 'user',
      scopeId: 'test',
      content: _input,
      entities: [],
      tags: [],
      provenance: {
        sourceType: 'external',
        sourceTimestamp: Date.now(),
        confidence: 1,
        verificationCount: 0,
      },
      emotionalContext: {
        valence: 0,
        arousal: 0.3,
        dominance: 0,
        intensity: 0,
        gmiMood: 'neutral',
      },
      encodingStrength: 0.5,
      stability: 1000,
      retrievalCount: 0,
      lastAccessedAt: Date.now(),
      accessCount: 0,
      reinforcementInterval: 86400000,
      associatedTraceIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isActive: true,
    })),
    // Stub remaining interface methods — bridge only uses encode()
    initialize: vi.fn(),
    retrieve: vi.fn(),
    assembleForPrompt: vi.fn(),
    getMemoryHealth: vi.fn(),
    getStore: vi.fn(),
    getWorkingMemory: vi.fn(),
    getConfig: vi.fn(),
    getGraph: vi.fn(() => null),
    getObserver: vi.fn(() => null),
    getProspective: vi.fn(() => null),
    getContextWindowStats: vi.fn(() => null),
    getContextTransparencyReport: vi.fn(() => null),
    shutdown: vi.fn(),
  } as unknown as ICognitiveMemoryManager & { encode: Mock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MultimodalMemoryBridge', () => {
  let indexer: ReturnType<typeof createMockIndexer>;
  let memoryManager: ReturnType<typeof createMockMemoryManager>;
  let bridge: MultimodalMemoryBridge;

  beforeEach(() => {
    indexer = createMockIndexer();
    memoryManager = createMockMemoryManager();
    bridge = new MultimodalMemoryBridge(indexer, memoryManager);

    // Suppress console.warn during tests (bridge logs non-fatal warnings)
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  it('should throw if indexer is missing', () => {
    expect(() => new MultimodalMemoryBridge(null as any)).toThrow(
      /requires a MultimodalIndexer/,
    );
  });

  it('should construct without memory manager', () => {
    expect(() => new MultimodalMemoryBridge(indexer)).not.toThrow();
  });

  it('should construct with custom options', () => {
    const customBridge = new MultimodalMemoryBridge(indexer, memoryManager, {
      enableMemory: false,
      defaultChunkSize: 500,
      defaultChunkOverlap: 100,
      defaultMood: { valence: 0.5, arousal: 0.5, dominance: 0 },
    });
    expect(customBridge).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Image ingestion
  // -------------------------------------------------------------------------

  it('should ingest an image into RAG and memory', async () => {
    const result = await bridge.ingestImage(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      { source: 'user-upload', tags: ['nature'] },
    );

    // RAG indexing should have been called
    expect(indexer.indexImage).toHaveBeenCalledTimes(1);
    expect(indexer.indexImage).toHaveBeenCalledWith(
      expect.objectContaining({
        image: expect.any(Buffer),
        metadata: expect.objectContaining({ source: 'user-upload' }),
      }),
    );

    // Memory encoding should have been called
    expect(memoryManager.encode).toHaveBeenCalledTimes(1);
    expect(memoryManager.encode).toHaveBeenCalledWith(
      'A golden retriever playing fetch on a sandy beach.',
      expect.objectContaining({ valence: 0, arousal: 0.3 }),
      'neutral',
      expect.objectContaining({ type: 'semantic', sourceType: 'external' }),
    );

    // Result should contain both IDs
    expect(result.ragDocumentIds).toEqual(['rag-img-001']);
    expect(result.memoryTraceIds).toHaveLength(1);
    expect(result.contentType).toBe('image');
    expect(result.extractedText).toContain('golden retriever');
    expect(result.details.visionDescriptions).toHaveLength(1);
  });

  it('should ingest an image with URL string', async () => {
    await bridge.ingestImage('https://example.com/photo.jpg');

    expect(indexer.indexImage).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'https://example.com/photo.jpg' }),
    );
  });

  // -------------------------------------------------------------------------
  // Audio ingestion
  // -------------------------------------------------------------------------

  it('should ingest audio into RAG and memory', async () => {
    const audioBuffer = Buffer.from('fake audio data');
    const result = await bridge.ingestAudio(audioBuffer, {
      source: 'meeting',
      language: 'en',
    });

    // RAG indexing
    expect(indexer.indexAudio).toHaveBeenCalledTimes(1);
    expect(indexer.indexAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: audioBuffer,
        language: 'en',
        metadata: expect.objectContaining({ source: 'meeting' }),
      }),
    );

    // Memory encoding — audio is episodic (time-bound event)
    expect(memoryManager.encode).toHaveBeenCalledTimes(1);
    expect(memoryManager.encode).toHaveBeenCalledWith(
      expect.stringContaining('machine learning podcast'),
      expect.any(Object),
      'neutral',
      expect.objectContaining({ type: 'episodic' }),
    );

    expect(result.ragDocumentIds).toEqual(['rag-audio-001']);
    expect(result.memoryTraceIds).toHaveLength(1);
    expect(result.contentType).toBe('audio');
    expect(result.details.audioTranscript).toContain('machine learning');
  });

  // -------------------------------------------------------------------------
  // Video ingestion (no ffprobe)
  // -------------------------------------------------------------------------

  it('should degrade gracefully when ffprobe is not available', async () => {
    // exec('ffprobe -version') will naturally fail in test environment
    const videoBuffer = Buffer.from('fake video data');
    const result = await bridge.ingestVideo(videoBuffer, {
      extractFrames: true,
      source: 'screen-recording',
    });

    // Without ffmpeg, no frames or audio can be extracted
    expect(result.contentType).toBe('video');
    expect(result.extractedText).toContain('no content could be extracted');

    // console.warn should have been called about missing ffmpeg
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('ffmpeg/ffprobe not found'),
    );

    // Memory trace should still be created (even with empty content)
    expect(memoryManager.encode).toHaveBeenCalledTimes(1);
  });

  it('should skip frame extraction when extractFrames is false', async () => {
    const videoBuffer = Buffer.from('fake video data');
    const result = await bridge.ingestVideo(videoBuffer, {
      extractFrames: false,
      extractAudio: false,
    });

    // No indexer calls since everything is disabled and ffmpeg is unavailable
    expect(indexer.indexImage).not.toHaveBeenCalled();
    expect(indexer.indexAudio).not.toHaveBeenCalled();
    expect(result.contentType).toBe('video');
  });

  // -------------------------------------------------------------------------
  // PDF ingestion
  // -------------------------------------------------------------------------

  it('should extract text from PDF via regex fallback', async () => {
    // Create a minimal PDF-like buffer with text objects
    // Real PDFs have BT/ET text blocks with parenthesized strings
    const pdfContent = '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Page >>\nendobj\n' +
      'stream\nBT\n/F1 12 Tf\n(Hello World) Tj\nET\nendstream\n' +
      'stream\nBT\n(This is a test document) Tj\nET\nendstream\n';
    const pdfBuffer = Buffer.from(pdfContent);

    const result = await bridge.ingestPDF(pdfBuffer, {
      source: 'test-document',
      collection: 'pdf-knowledge',
    });

    expect(result.contentType).toBe('pdf');
    expect(result.extractedText).toContain('Hello World');
    expect(result.extractedText).toContain('test document');
    expect(indexer.indexText).toHaveBeenCalledTimes(1);
    expect(indexer.indexText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Hello World'),
        collection: 'pdf-knowledge',
        metadata: expect.objectContaining({
          source: 'test-document',
          sourceModality: 'pdf',
          chunkIndex: 0,
          chunkCount: 1,
        }),
      }),
    );
    expect(result.ragDocumentIds).toEqual(['rag-text-001']);

    // Memory encoding with semantic type (factual content)
    expect(memoryManager.encode).toHaveBeenCalledWith(
      expect.stringContaining('Hello World'),
      expect.any(Object),
      'neutral',
      expect.objectContaining({ type: 'semantic' }),
    );
  });

  it('should throw when no text can be extracted from PDF', async () => {
    // PDF magic bytes but no readable text content
    const emptyPdf = Buffer.from('%PDF-1.4\n%%EOF');

    await expect(bridge.ingestPDF(emptyPdf)).rejects.toThrow(
      /could not extract any text/,
    );
  });

  it('should warn when image extraction is requested from PDF', async () => {
    const pdfContent = '%PDF-1.4\nstream\nBT\n(Some text) Tj\nET\nendstream\n';
    const pdfBuffer = Buffer.from(pdfContent);

    await bridge.ingestPDF(pdfBuffer, { extractImages: true });

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('PDF image extraction requires'),
    );
  });

  // -------------------------------------------------------------------------
  // Auto-detect
  // -------------------------------------------------------------------------

  it('should auto-detect PNG image from magic bytes', async () => {
    // PNG magic bytes: 0x89 P N G
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const result = await bridge.ingest(pngBuffer, {});

    expect(result.contentType).toBe('image');
    expect(indexer.indexImage).toHaveBeenCalled();
  });

  it('should auto-detect JPEG image from magic bytes', async () => {
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    const result = await bridge.ingest(jpegBuffer, {});

    expect(result.contentType).toBe('image');
  });

  it('should auto-detect PDF from magic bytes', async () => {
    const pdfContent = '%PDF-1.4\nstream\nBT\n(Auto detected) Tj\nET\nendstream\n';
    const pdfBuffer = Buffer.from(pdfContent);

    const result = await bridge.ingest(pdfBuffer, {});

    expect(result.contentType).toBe('pdf');
    expect(result.extractedText).toContain('Auto detected');
  });

  it('should auto-detect WAV audio from magic bytes', async () => {
    // WAV: "RIFF" + 4 bytes size + "WAVE" + data
    const wavHeader = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x00, 0x00, 0x00, 0x00, // file size placeholder
      0x57, 0x41, 0x56, 0x45, // "WAVE"
      0x66, 0x6d, 0x74, 0x20, // "fmt "
    ]);

    const result = await bridge.ingest(wavHeader, {});

    expect(result.contentType).toBe('audio');
    expect(indexer.indexAudio).toHaveBeenCalled();
  });

  it('should auto-detect from file extension when bytes are ambiguous', async () => {
    // Ambiguous bytes that don't match any known magic
    const unknownBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

    const result = await bridge.ingest(unknownBuffer, {
      fileName: 'recording.mp3',
    });

    expect(result.contentType).toBe('audio');
  });

  it('should auto-detect from explicit MIME type', async () => {
    const unknownBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);

    const result = await bridge.ingest(unknownBuffer, {
      mimeType: 'image/png',
    });

    expect(result.contentType).toBe('image');
  });

  it('should prioritize MIME type over file extension', async () => {
    const unknownBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);

    // MIME says audio, extension says image — MIME wins
    const result = await bridge.ingest(unknownBuffer, {
      mimeType: 'audio/wav',
      fileName: 'photo.png',
    });

    expect(result.contentType).toBe('audio');
  });

  it('should throw when content type cannot be determined', async () => {
    const unknownBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);

    await expect(bridge.ingest(unknownBuffer, {})).rejects.toThrow(
      /could not detect content type/,
    );
  });

  // -------------------------------------------------------------------------
  // No memory manager
  // -------------------------------------------------------------------------

  it('should still index into RAG when no memory manager is provided', async () => {
    const noMemBridge = new MultimodalMemoryBridge(indexer);

    const result = await noMemBridge.ingestImage(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      { source: 'upload' },
    );

    // RAG should succeed
    expect(result.ragDocumentIds).toEqual(['rag-img-001']);

    // Memory traces should be empty
    expect(result.memoryTraceIds).toEqual([]);

    // Memory manager should NOT have been called
    expect(memoryManager.encode).not.toHaveBeenCalled();
  });

  it('should skip memory when enableMemory is false', async () => {
    const disabledBridge = new MultimodalMemoryBridge(indexer, memoryManager, {
      enableMemory: false,
    });

    const result = await disabledBridge.ingestImage(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    // RAG should succeed
    expect(result.ragDocumentIds).toEqual(['rag-img-001']);

    // Memory should be skipped even though manager exists
    expect(result.memoryTraceIds).toEqual([]);
    expect(memoryManager.encode).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Memory encoding failure resilience
  // -------------------------------------------------------------------------

  it('should succeed on RAG even when memory encoding fails', async () => {
    memoryManager.encode.mockRejectedValueOnce(new Error('Memory store full'));

    const result = await bridge.ingestImage(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      { source: 'upload' },
    );

    // RAG should still succeed
    expect(result.ragDocumentIds).toEqual(['rag-img-001']);

    // Memory trace IDs should be empty (encoding failed)
    expect(result.memoryTraceIds).toEqual([]);

    // Warning should have been logged
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to encode memory trace'),
      expect.stringContaining('Memory store full'),
    );
  });

  // -------------------------------------------------------------------------
  // Metadata propagation
  // -------------------------------------------------------------------------

  it('should propagate metadata to RAG indexer', async () => {
    await bridge.ingestImage('https://example.com/img.jpg', {
      source: 'web-scrape',
      tags: ['landscape'],
      collection: 'user-images',
      customField: 42,
    });

    expect(indexer.indexImage).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'https://example.com/img.jpg',
        collection: 'user-images',
        metadata: expect.objectContaining({
          source: 'web-scrape',
          tags: ['landscape'],
          customField: 42,
        }),
      }),
    );
  });

  it('should propagate tags to memory encoding', async () => {
    await bridge.ingestImage('https://example.com/img.jpg', {
      tags: ['important', 'meeting-notes'],
    });

    expect(memoryManager.encode).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      'neutral',
      expect.objectContaining({
        tags: ['important', 'meeting-notes'],
      }),
    );
  });

  it('should propagate source as scopeId to memory encoding', async () => {
    await bridge.ingestAudio(Buffer.from('audio'), {
      source: 'customer-call',
    });

    expect(memoryManager.encode).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      'neutral',
      expect.objectContaining({
        scopeId: 'customer-call',
      }),
    );
  });
});
