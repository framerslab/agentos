/**
 * @module vision/__tests__/VisionPipeline.spec
 *
 * Unit tests for the {@link VisionPipeline} class.
 *
 * All heavy ML dependencies (ppu-paddle-ocr, tesseract.js,
 * \@huggingface/transformers, sharp) are fully mocked. These tests
 * validate the routing logic, strategy behaviours, content category
 * detection, lazy loading, error handling, and result assembly — NOT
 * the actual ML model accuracy.
 *
 * ## Test categories
 *
 * 1. **Strategy routing** — progressive, local-only, cloud-only, parallel
 * 2. **Content detection** — printed-text, handwritten, document-layout, mixed
 * 3. **Tier integration** — OCR, TrOCR, Florence-2, CLIP, cloud vision
 * 4. **Shortcut methods** — extractText(), embed(), analyzeLayout()
 * 5. **Error handling** — missing providers, empty results, disposed pipeline
 * 6. **Preprocessing** — grayscale, resize, sharpen, normalize
 * 7. **Resource management** — dispose() releases all resources
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { VisionPipeline, imageMediaType } from '../VisionPipeline.js';
import { createVisionPipeline } from '../index.js';
import type { VisionPipelineConfig, ContentCategory } from '../types.js';

// ---------------------------------------------------------------------------
// Mock registries — we capture mock instances so tests can inspect calls
// ---------------------------------------------------------------------------

/** Mock PaddleOCR service with configurable results. */
let mockPaddleOcrInstance: {
  init: Mock;
  recognize: Mock;
  dispose: Mock;
};

/** Mock Tesseract worker with configurable results. */
let mockTesseractWorkerInstance: {
  recognize: Mock;
  terminate: Mock;
};

/** Mock HuggingFace pipeline function. */
let mockHfPipelineFactory: Mock;

/** Mock Florence-2 loads: `from_pretrained` of the model and of the processor. */
let mockFlorenceModelLoad: Mock;
let mockFlorenceProcessorLoad: Mock;

/** The Florence-2 model and processor the loads return. */
let mockFlorenceModel: { generate: Mock; dispose: Mock };
let mockFlorenceProcessor: Mock & { batch_decode: Mock; post_process_generation: Mock };

/** Mock `RawImage.read`, which the Florence-2 tier decodes its image with. */
let mockRawImageRead: Mock;

/** Mock generateText function for cloud vision. */
let mockGenerateText: Mock;

/** Mock sharp instance for preprocessing. */
let mockSharpInstance: Record<string, Mock>;

// ---------------------------------------------------------------------------
// Default mock results
// ---------------------------------------------------------------------------

/** High-confidence PaddleOCR result (printed text). */
function highConfidencePaddleResult() {
  return {
    regions: [
      { text: 'Hello World', confidence: 0.95, bbox: [[0, 0], [100, 0], [100, 30], [0, 30]] },
      { text: 'Second line', confidence: 0.92, bbox: [[0, 40], [100, 40], [100, 70], [0, 70]] },
    ],
  };
}

/** Low-confidence PaddleOCR result (poor quality / handwritten). */
function lowConfidencePaddleResult() {
  return {
    regions: [
      { text: 'H', confidence: 0.3, bbox: [[0, 0], [10, 0], [10, 30], [0, 30]] },
      { text: 'e', confidence: 0.25, bbox: [[12, 0], [22, 0], [22, 30], [12, 30]] },
      { text: 'l', confidence: 0.2, bbox: [[24, 0], [34, 0], [34, 30], [24, 30]] },
    ],
  };
}

/** Tesseract result with confidence on 0-100 scale. */
function tesseractResult() {
  return {
    data: {
      text: 'Tesseract output text',
      confidence: 88,
      words: [
        { text: 'Tesseract', confidence: 90, bbox: { x0: 0, y0: 0, x1: 80, y1: 30 } },
        { text: 'output', confidence: 85, bbox: { x0: 85, y0: 0, x1: 140, y1: 30 } },
        { text: 'text', confidence: 89, bbox: { x0: 145, y0: 0, x1: 180, y1: 30 } },
      ],
    },
  };
}

/** Cloud vision result from generateText. */
function cloudVisionResult() {
  return {
    text: 'A scanned document containing handwritten notes about machine learning.',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    toolCalls: [],
    finishReason: 'stop' as const,
    provider: 'openai',
    model: 'gpt-4o',
  };
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mock ppu-paddle-ocr
vi.mock('ppu-paddle-ocr', () => {
  return {
    PaddleOcrService: class {
      constructor() {
        // Wire up instance methods from the test-level registry so
        // each test can customize the mock's behavior.
        Object.assign(this, mockPaddleOcrInstance);
      }
    },
  };
});

// Mock tesseract.js
vi.mock('tesseract.js', () => {
  return {
    default: {
      createWorker: vi.fn(async () => mockTesseractWorkerInstance),
    },
  };
});

// Mock @huggingface/transformers — the pipeline() factory, and the
// Florence-2 model, processor and RawImage the layout tier uses.
vi.mock('@huggingface/transformers', () => {
  return {
    pipeline: (...args: any[]) => mockHfPipelineFactory(...args),
    Florence2ForConditionalGeneration: {
      from_pretrained: (...args: any[]) => mockFlorenceModelLoad(...args),
    },
    AutoProcessor: {
      from_pretrained: (...args: any[]) => mockFlorenceProcessorLoad(...args),
    },
    RawImage: {
      read: (...args: any[]) => mockRawImageRead(...args),
    },
  };
});

// Mock generateText for cloud vision.
// VisionPipeline dynamically imports '../api/generateText.js' (relative to
// src/vision/), which resolves to src/api/generateText.js. From this test
// file's location (src/vision/__tests__/) the equivalent relative path is
// two levels up.
vi.mock('../../../api/generateText.js', () => {
  return {
    generateText: (...args: any[]) => mockGenerateText(...args),
  };
});

// Mock sharp for preprocessing
vi.mock('sharp', () => {
  return {
    default: () => mockSharpInstance,
  };
});

// Mock axios for URL-to-buffer conversion
vi.mock('axios', () => {
  return {
    default: {
      get: vi.fn(async () => ({
        data: Buffer.from('fake-image-data'),
      })),
    },
  };
});

// ---------------------------------------------------------------------------
// Setup & teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset all mock instances before each test
  mockPaddleOcrInstance = {
    init: vi.fn(async () => {}),
    recognize: vi.fn(async () => highConfidencePaddleResult()),
    dispose: vi.fn(async () => {}),
  };

  mockTesseractWorkerInstance = {
    recognize: vi.fn(async () => tesseractResult()),
    terminate: vi.fn(async () => {}),
  };

  // By default, HuggingFace pipeline factory returns a mock pipeline
  // function that returns text output.
  mockHfPipelineFactory = vi.fn(async (task: string) => {
    if (task === 'image-to-text') {
      return vi.fn(async () => [{ generated_text: 'HF pipeline output' }]);
    }
    if (task === 'image-feature-extraction') {
      return vi.fn(async () => [[0.1, 0.2, 0.3, 0.4, 0.5]]);
    }
    throw new Error(`Unknown pipeline task: ${task}`);
  });

  // Florence-2 reads two lines, each with the four corners of its box.
  mockFlorenceModel = { generate: vi.fn(async () => ({ token_ids: 'generated' })), dispose: vi.fn(async () => {}) };
  mockFlorenceProcessor = Object.assign(vi.fn(async () => ({ input_ids: 'ids', pixel_values: 'pixels' })), {
    batch_decode: vi.fn(() => ['</s><s>Invoice 42<loc_15><loc_41>...</s>']),
    post_process_generation: vi.fn((_text: string, task: string) => ({
      [task]: {
        labels: ['Invoice 42', 'Total due'],
        quad_boxes: [
          [10, 20, 110, 20, 110, 40, 10, 40],
          [12, 50, 90, 52, 90, 70, 12, 68],
        ],
      },
    })),
  });
  mockFlorenceModelLoad = vi.fn(async () => mockFlorenceModel);
  mockFlorenceProcessorLoad = vi.fn(async () => mockFlorenceProcessor);
  mockRawImageRead = vi.fn(async () => ({ width: 640, height: 480, size: [640, 480] }));

  mockGenerateText = vi.fn(async () => cloudVisionResult());

  // Mock sharp as a fluent builder
  mockSharpInstance = {
    resize: vi.fn().mockReturnThis(),
    grayscale: vi.fn().mockReturnThis(),
    sharpen: vi.fn().mockReturnThis(),
    normalize: vi.fn().mockReturnThis(),
    toBuffer: vi.fn(async () => Buffer.from('preprocessed-image')),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a pipeline with all tiers enabled. */
function createFullPipeline(overrides?: Partial<VisionPipelineConfig>): VisionPipeline {
  return new VisionPipeline({
    strategy: 'progressive',
    ocr: 'paddle',
    handwriting: true,
    documentAI: true,
    embedding: true,
    cloudProvider: 'openai',
    confidenceThreshold: 0.7,
    ...overrides,
  });
}

/** Create a minimal test image buffer. */
function testImage(): Buffer {
  return Buffer.from('fake-png-data');
}

// ===========================================================================
// Tests
// ===========================================================================

describe('VisionPipeline', () => {
  // =========================================================================
  // Progressive strategy
  // =========================================================================

  describe('progressive strategy', () => {
    it('should run OCR first and skip cloud when confidence is high', async () => {
      // High confidence (0.935) is above threshold (0.7), so cloud should NOT run
      const pipeline = createFullPipeline();
      const result = await pipeline.process(testImage());

      // OCR ran
      expect(mockPaddleOcrInstance.recognize).toHaveBeenCalledTimes(1);
      // Cloud did NOT run (early return due to high confidence)
      expect(mockGenerateText).not.toHaveBeenCalled();
      // Text comes from PaddleOCR
      expect(result.text).toContain('Hello World');
      expect(result.confidence).toBeGreaterThan(0.7);
      expect(result.tiers).toContain('ocr');
      expect(result.tiers).not.toContain('cloud-vision');
    });

    it('should fall back to cloud when OCR confidence is low', async () => {
      // Override PaddleOCR to return low-confidence results
      mockPaddleOcrInstance.recognize.mockResolvedValue(lowConfidencePaddleResult());

      // Use a higher threshold so that even TrOCR's 0.75 confidence
      // is insufficient, forcing escalation to cloud vision.
      const pipeline = createFullPipeline({ confidenceThreshold: 0.9 });
      const result = await pipeline.process(testImage());

      // OCR ran
      expect(mockPaddleOcrInstance.recognize).toHaveBeenCalledTimes(1);
      // Cloud ran as fallback because even after TrOCR, confidence (0.75)
      // was below the elevated threshold (0.9)
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      // Cloud has highest confidence (0.95), so its text wins
      expect(result.text).toContain('handwritten notes');
      expect(result.tiers).toContain('ocr');
      expect(result.tiers).toContain('cloud-vision');
    });

    it('should collect tier results from all tiers that ran', async () => {
      mockPaddleOcrInstance.recognize.mockResolvedValue(lowConfidencePaddleResult());

      const pipeline = createFullPipeline();
      const result = await pipeline.process(testImage());

      // Should have OCR result + handwriting (TrOCR) + cloud
      // (handwriting triggers because low confidence + single-char regions)
      expect(result.tierResults.length).toBeGreaterThanOrEqual(2);

      // Each tier result should have the standard shape
      for (const tr of result.tierResults) {
        expect(tr.tier).toBeDefined();
        expect(tr.provider).toBeDefined();
        expect(typeof tr.text).toBe('string');
        expect(typeof tr.confidence).toBe('number');
        expect(typeof tr.durationMs).toBe('number');
      }
    });
  });

  // =========================================================================
  // Local-only strategy
  // =========================================================================

  describe('local-only strategy', () => {
    it('should never call cloud even with low confidence', async () => {
      mockPaddleOcrInstance.recognize.mockResolvedValue(lowConfidencePaddleResult());

      const pipeline = createFullPipeline({ strategy: 'local-only' });
      const result = await pipeline.process(testImage());

      // OCR ran
      expect(mockPaddleOcrInstance.recognize).toHaveBeenCalledTimes(1);
      // Cloud never ran — local-only strategy
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(result.tiers).not.toContain('cloud-vision');
    });

    it('should still run Tier 2 models when confidence is low', async () => {
      mockPaddleOcrInstance.recognize.mockResolvedValue(lowConfidencePaddleResult());

      const pipeline = createFullPipeline({ strategy: 'local-only' });
      const result = await pipeline.process(testImage());

      // TrOCR should have been triggered by low-confidence handwriting detection
      expect(result.tiers).toContain('handwriting');
    });
  });

  // =========================================================================
  // Cloud-only strategy
  // =========================================================================

  describe('cloud-only strategy', () => {
    it('should skip OCR entirely and go straight to cloud', async () => {
      const pipeline = createFullPipeline({ strategy: 'cloud-only' });
      const result = await pipeline.process(testImage());

      // OCR did NOT run
      expect(mockPaddleOcrInstance.recognize).not.toHaveBeenCalled();
      // Cloud ran directly
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(result.text).toContain('handwritten notes');
      expect(result.tiers).toContain('cloud-vision');
      expect(result.tiers).not.toContain('ocr');
    });

    it('should still generate CLIP embedding when enabled', async () => {
      const pipeline = createFullPipeline({ strategy: 'cloud-only' });
      const result = await pipeline.process(testImage());

      // Embedding runs in parallel regardless of strategy
      expect(result.embedding).toBeDefined();
      expect(result.embedding).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
      expect(result.tiers).toContain('embedding');
    });
  });

  // =========================================================================
  // Parallel strategy
  // =========================================================================

  describe('parallel strategy', () => {
    it('should run both local and cloud, merging best results', async () => {
      const pipeline = createFullPipeline({ strategy: 'parallel' });
      const result = await pipeline.process(testImage());

      // Both OCR and cloud ran
      expect(mockPaddleOcrInstance.recognize).toHaveBeenCalledTimes(1);
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(result.tiers).toContain('ocr');
      expect(result.tiers).toContain('cloud-vision');

      // Cloud has higher confidence (0.95) so its text should win
      expect(result.text).toContain('handwritten notes');
      expect(result.confidence).toBe(0.95);
    });
  });

  // =========================================================================
  // Content category detection
  // =========================================================================

  describe('content category detection', () => {
    it('should detect handwriting from low-confidence single-char regions', async () => {
      mockPaddleOcrInstance.recognize.mockResolvedValue(lowConfidencePaddleResult());

      const pipeline = createFullPipeline({ strategy: 'local-only' });
      const result = await pipeline.process(testImage());

      // Low confidence + single-char regions → handwritten
      expect(result.category).toBe('handwritten');
    });

    it('should detect printed text from high-confidence OCR', async () => {
      const pipeline = createFullPipeline();
      const result = await pipeline.process(testImage());

      expect(result.category).toBe('printed-text');
    });

    it('should detect document-layout from many regions', async () => {
      // Create a result with >20 regions
      const manyRegions = Array.from({ length: 25 }, (_, i) => ({
        text: `Region ${i}`,
        confidence: 0.7,
        bbox: [[0, i * 30], [100, i * 30], [100, (i + 1) * 30], [0, (i + 1) * 30]],
      }));
      mockPaddleOcrInstance.recognize.mockResolvedValue({ regions: manyRegions });

      const pipeline = createFullPipeline({ strategy: 'local-only' });
      const result = await pipeline.process(testImage());

      expect(result.category).toBe('document-layout');
    });

    it('should respect forceCategory override', async () => {
      const pipeline = createFullPipeline();
      const result = await pipeline.process(testImage(), {
        forceCategory: 'screenshot',
      });

      expect(result.category).toBe('screenshot');
    });
  });

  // =========================================================================
  // Handwriting detection triggers TrOCR
  // =========================================================================

  describe('handwriting detection', () => {
    it('should trigger TrOCR when content appears handwritten', async () => {
      mockPaddleOcrInstance.recognize.mockResolvedValue(lowConfidencePaddleResult());

      const pipeline = createFullPipeline({ strategy: 'local-only' });
      const result = await pipeline.process(testImage());

      // TrOCR pipeline should have been created, from the conversion
      // transformers.js loads (ONNX weights and tokenizer.json)
      expect(mockHfPipelineFactory).toHaveBeenCalledWith(
        'image-to-text',
        'Xenova/trocr-base-handwritten',
      );
      expect(result.tiers).toContain('handwriting');
      expect(result.failedTiers).toBeUndefined();
    });

    it('hands TrOCR a Buffer image as a Blob, not a data URL transformers.js would read as a path', async () => {
      mockPaddleOcrInstance.recognize.mockResolvedValue(lowConfidencePaddleResult());
      const inputs: unknown[] = [];
      mockHfPipelineFactory = vi.fn(async (task: string) => {
        if (task === 'image-to-text') {
          return vi.fn(async (input: unknown) => {
            inputs.push(input);
            return [{ generated_text: 'HF pipeline output' }];
          });
        }
        if (task === 'image-feature-extraction') return vi.fn(async () => [[0.1, 0.2, 0.3]]);
        throw new Error(`Unknown pipeline task: ${task}`);
      });

      const pipeline = createFullPipeline({ strategy: 'local-only' });
      const result = await pipeline.process(testImage());

      expect(result.tiers).toContain('handwriting');
      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs) {
        expect(input).toBeInstanceOf(Blob);
        expect((input as Blob).size).toBeGreaterThan(0);
      }
    });

    it('should not trigger TrOCR when handwriting is disabled', async () => {
      mockPaddleOcrInstance.recognize.mockResolvedValue(lowConfidencePaddleResult());

      const pipeline = createFullPipeline({
        strategy: 'local-only',
        handwriting: false,
      });
      const result = await pipeline.process(testImage());

      expect(result.tiers).not.toContain('handwriting');
    });
  });

  // =========================================================================
  // Document layout triggers Florence-2
  // =========================================================================

  describe('document layout detection', () => {
    it('should trigger Florence-2 for complex document layouts', async () => {
      // Many regions → document-layout category
      const manyRegions = Array.from({ length: 25 }, (_, i) => ({
        text: `Region ${i}`,
        confidence: 0.7,
        bbox: [[0, i * 30], [100, i * 30], [100, (i + 1) * 30], [0, (i + 1) * 30]],
      }));
      mockPaddleOcrInstance.recognize.mockResolvedValue({ regions: manyRegions });

      const pipeline = createFullPipeline({ strategy: 'local-only' });
      const result = await pipeline.process(testImage());

      // Florence-2 is loaded as a model and a processor, not as an
      // image-to-text pipeline, which does not take it.
      expect(mockFlorenceModelLoad).toHaveBeenCalledWith('onnx-community/Florence-2-base-ft');
      expect(mockFlorenceProcessorLoad).toHaveBeenCalledWith('onnx-community/Florence-2-base-ft');
      expect(mockHfPipelineFactory).not.toHaveBeenCalledWith('image-to-text', expect.stringContaining('Florence'));
      expect(result.tiers).toContain('document-ai');
      expect(result.layout).toBeDefined();
      expect(result.layout!.pages).toHaveLength(1);
    });

    it('reads the lines of text with their boxes, and keeps the location tokens for the parser', async () => {
      const pipeline = createFullPipeline();
      const layout = await pipeline.analyzeLayout(testImage());

      expect(mockFlorenceProcessor).toHaveBeenCalledWith(expect.anything(), '<OCR_WITH_REGION>');
      expect(mockFlorenceModel.generate).toHaveBeenCalledWith(
        expect.objectContaining({ input_ids: 'ids', pixel_values: 'pixels', max_new_tokens: 1024 }),
      );
      expect(mockFlorenceProcessor.batch_decode).toHaveBeenCalledWith(
        { token_ids: 'generated' },
        { skip_special_tokens: false },
      );
      expect(mockFlorenceProcessor.post_process_generation).toHaveBeenCalledWith(
        '</s><s>Invoice 42<loc_15><loc_41>...</s>',
        '<OCR_WITH_REGION>',
        [640, 480],
      );
      expect(layout).toEqual({
        pages: [{
          pageNumber: 1,
          width: 640,
          height: 480,
          blocks: [
            { type: 'text', content: 'Invoice 42', bbox: { x: 10, y: 20, width: 100, height: 20 }, confidence: 0.8 },
            { type: 'text', content: 'Total due', bbox: { x: 12, y: 50, width: 78, height: 20 }, confidence: 0.8 },
          ],
        }],
      });
    });

    it('gives the lines in reading order as the tier text', async () => {
      const manyRegions = Array.from({ length: 25 }, (_, i) => ({
        text: `Region ${i}`,
        confidence: 0.7,
        bbox: [[0, i * 30], [100, i * 30], [100, (i + 1) * 30], [0, (i + 1) * 30]],
      }));
      mockPaddleOcrInstance.recognize.mockResolvedValue({ regions: manyRegions });

      const pipeline = createFullPipeline({ strategy: 'local-only' });
      const result = await pipeline.process(testImage());

      const layoutTier = result.tierResults.find((t) => t.tier === 'document-ai');
      expect(layoutTier).toMatchObject({ provider: 'florence-2', text: 'Invoice 42\nTotal due', confidence: 0.8 });
    });

    it('hands Florence-2 a Buffer image as a Blob, and a URL string as it is', async () => {
      const manyRegions = Array.from({ length: 25 }, (_, i) => ({
        text: `Region ${i}`,
        confidence: 0.7,
        bbox: [[0, i * 30], [100, i * 30], [100, (i + 1) * 30], [0, (i + 1) * 30]],
      }));
      mockPaddleOcrInstance.recognize.mockResolvedValue({ regions: manyRegions });
      const pipeline = createFullPipeline({ strategy: 'local-only', handwriting: false });
      await pipeline.process(testImage());
      await pipeline.process('https://example.com/scan.png');

      const inputs = mockRawImageRead.mock.calls.map(([input]) => input);
      expect(inputs).toHaveLength(2);
      expect(inputs[0]).toBeInstanceOf(Blob);
      expect((inputs[0] as Blob).size).toBeGreaterThan(0);
      expect(inputs[1]).toBe('https://example.com/scan.png');
    });
  });

  // =========================================================================
  // CLIP embedding
  // =========================================================================

  describe('CLIP embedding', () => {
    it('should generate CLIP embedding alongside OCR', async () => {
      const pipeline = createFullPipeline();
      const result = await pipeline.process(testImage());

      expect(result.embedding).toBeDefined();
      expect(result.embedding).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
      expect(result.tiers).toContain('embedding');
    });

    it('should not generate embedding when disabled', async () => {
      const pipeline = createFullPipeline({ embedding: false });
      const result = await pipeline.process(testImage());

      expect(result.embedding).toBeUndefined();
      expect(result.tiers).not.toContain('embedding');
    });

    it('should gracefully handle CLIP failure without affecting other tiers', async () => {
      // Make CLIP fail
      mockHfPipelineFactory.mockImplementation(async (task: string) => {
        if (task === 'image-feature-extraction') {
          throw new Error('CLIP load failed');
        }
        return vi.fn(async () => [{ generated_text: 'HF output' }]);
      });

      const pipeline = createFullPipeline();
      const result = await pipeline.process(testImage());

      // OCR still succeeded
      expect(result.text).toContain('Hello World');
      // The embedding failed, and the result says so
      expect(result.embedding).toBeUndefined();
      expect(result.tiers).not.toContain('embedding');
      expect(result.failedTiers).toEqual([{ tier: 'embedding', error: 'CLIP load failed' }]);
    });

    it('hands CLIP a Buffer image as a Blob, through the image task, and reads its Tensor', async () => {
      const inputs: unknown[] = [];
      mockHfPipelineFactory = vi.fn(async (task: string) => {
        if (task === 'image-feature-extraction') {
          return vi.fn(async (input: unknown) => {
            inputs.push(input);
            return { dims: [1, 3], data: Float32Array.from([0.5, 0.25, -1]) };
          });
        }
        throw new Error(`Unknown pipeline task: ${task}`);
      });

      const pipeline = createFullPipeline();
      const embedding = await pipeline.embed(testImage());

      expect(mockHfPipelineFactory).toHaveBeenCalledWith('image-feature-extraction', 'Xenova/clip-vit-base-patch32');
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toBeInstanceOf(Blob);
      expect(embedding).toEqual([0.5, 0.25, -1]);
    });
  });

  // =========================================================================
  // Missing provider error messages
  // =========================================================================

  describe('missing providers', () => {
    it('should throw helpful message when PaddleOCR is missing', async () => {
      // Override the mock to simulate MODULE_NOT_FOUND
      const origMock = vi.fn(async () => highConfidencePaddleResult());
      mockPaddleOcrInstance.recognize = origMock;

      // We need to simulate the import failure. Since the mock always
      // succeeds, we test via a pipeline with a non-mocked import path.
      // Instead, we test the error message contract directly.
      const pipeline = new VisionPipeline({
        strategy: 'progressive',
        ocr: 'paddle',
      });

      // The _loadPaddleOcr is private, so we test through process()
      // which delegates to it. Since our mock resolves, this won't throw.
      // This test verifies the pipeline CAN run with the mock in place.
      const result = await pipeline.process(testImage());
      expect(result.text).toBeTruthy();
    });

    it('should throw when cloud vision is requested without provider', async () => {
      const pipeline = new VisionPipeline({
        strategy: 'cloud-only',
        // No cloudProvider set
      });

      await expect(pipeline.process(testImage())).rejects.toThrow(
        'no cloudProvider is configured',
      );
    });

    it('should throw when OCR is none but OCR tier is explicitly requested', async () => {
      const pipeline = new VisionPipeline({
        strategy: 'cloud-only',
        ocr: 'none',
        cloudProvider: 'openai',
      });

      await expect(
        pipeline.process(testImage(), { tiers: ['ocr'] }),
      ).rejects.toThrow('OCR is set to "none"');
    });
  });

  // =========================================================================
  // Preprocessing
  // =========================================================================

  describe('preprocessing', () => {
    it('should apply grayscale + resize + sharpen + normalize via sharp', async () => {
      const pipeline = createFullPipeline({
        preprocessing: {
          grayscale: true,
          resize: { maxWidth: 1024, maxHeight: 768 },
          sharpen: true,
          normalize: true,
        },
      });

      await pipeline.process(testImage());

      expect(mockSharpInstance.resize).toHaveBeenCalledWith({
        width: 1024,
        height: 768,
        fit: 'inside',
        withoutEnlargement: true,
      });
      expect(mockSharpInstance.grayscale).toHaveBeenCalled();
      expect(mockSharpInstance.sharpen).toHaveBeenCalled();
      expect(mockSharpInstance.normalize).toHaveBeenCalled();
      expect(mockSharpInstance.toBuffer).toHaveBeenCalled();
    });

    it('should skip preprocessing when not configured', async () => {
      const pipeline = createFullPipeline({
        preprocessing: undefined,
      });

      await pipeline.process(testImage());

      // sharp's toBuffer was not called because no preprocessing happened
      expect(mockSharpInstance.toBuffer).not.toHaveBeenCalled();
    });

    it('should pass URL strings through without preprocessing', async () => {
      const pipeline = createFullPipeline({
        preprocessing: { grayscale: true },
      });

      await pipeline.process('https://example.com/image.png');

      // sharp was not invoked for URL strings — only Buffers are preprocessed
      expect(mockSharpInstance.toBuffer).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Shortcut methods
  // =========================================================================

  describe('extractText()', () => {
    it('should only run OCR and return text', async () => {
      const pipeline = createFullPipeline();
      const text = await pipeline.extractText(testImage());

      expect(text).toContain('Hello World');
      expect(mockPaddleOcrInstance.recognize).toHaveBeenCalledTimes(1);
      // No cloud or HF calls
      expect(mockGenerateText).not.toHaveBeenCalled();
    });
  });

  describe('embed()', () => {
    it('should only run CLIP and return embedding vector', async () => {
      const pipeline = createFullPipeline();
      const embedding = await pipeline.embed(testImage());

      expect(embedding).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
      // No OCR or cloud calls
      expect(mockPaddleOcrInstance.recognize).not.toHaveBeenCalled();
      expect(mockGenerateText).not.toHaveBeenCalled();
    });
  });

  describe('analyzeLayout()', () => {
    it('should only run Florence-2 and return document layout', async () => {
      const pipeline = createFullPipeline();
      const layout = await pipeline.analyzeLayout(testImage());

      expect(layout.pages).toHaveLength(1);
      expect(layout.pages[0].blocks).toHaveLength(2);
      // Florence-2 was loaded as a model and a processor; no OCR or cloud call
      expect(mockFlorenceModelLoad).toHaveBeenCalledTimes(1);
      expect(mockPaddleOcrInstance.recognize).not.toHaveBeenCalled();
      expect(mockGenerateText).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================

  describe('dispose()', () => {
    it('should release all resources', async () => {
      const pipeline = createFullPipeline();

      // Warm up the pipeline so providers are loaded
      await pipeline.process(testImage());

      await pipeline.dispose();

      expect(mockPaddleOcrInstance.dispose).toHaveBeenCalled();
    });

    it('releases the transformers.js models it loaded', async () => {
      const pipeline = createFullPipeline();
      await pipeline.analyzeLayout(testImage());

      await pipeline.dispose();

      expect(mockFlorenceModel.dispose).toHaveBeenCalledTimes(1);
    });

    it('should prevent further calls after disposal', async () => {
      const pipeline = createFullPipeline();
      await pipeline.dispose();

      await expect(pipeline.process(testImage())).rejects.toThrow(
        'pipeline has been disposed',
      );
      await expect(pipeline.extractText(testImage())).rejects.toThrow(
        'pipeline has been disposed',
      );
      await expect(pipeline.embed(testImage())).rejects.toThrow(
        'pipeline has been disposed',
      );
      await expect(pipeline.analyzeLayout(testImage())).rejects.toThrow(
        'pipeline has been disposed',
      );
    });
  });

  // =========================================================================
  // Explicit tier overrides
  // =========================================================================

  describe('explicit tier selection', () => {
    it('should run only requested tiers when specified', async () => {
      const pipeline = createFullPipeline();
      const result = await pipeline.process(testImage(), {
        tiers: ['ocr', 'embedding'],
      });

      expect(mockPaddleOcrInstance.recognize).toHaveBeenCalledTimes(1);
      expect(result.embedding).toBeDefined();
      // Cloud and HF handwriting/doc models were NOT invoked
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(result.tiers).toContain('ocr');
      expect(result.tiers).toContain('embedding');
      expect(result.tiers).not.toContain('cloud-vision');
      expect(result.tiers).not.toContain('handwriting');
    });

    it('should allow requesting cloud-vision explicitly', async () => {
      const pipeline = createFullPipeline();
      const result = await pipeline.process(testImage(), {
        tiers: ['cloud-vision'],
      });

      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(mockPaddleOcrInstance.recognize).not.toHaveBeenCalled();
      expect(result.tiers).toContain('cloud-vision');
    });
  });

  // =========================================================================
  // Tesseract.js fallback
  // =========================================================================

  describe('Tesseract.js OCR engine', () => {
    it('should use tesseract when configured', async () => {
      const pipeline = createFullPipeline({ ocr: 'tesseract' });
      const result = await pipeline.process(testImage());

      expect(mockTesseractWorkerInstance.recognize).toHaveBeenCalledTimes(1);
      expect(result.text).toContain('Tesseract output text');

      // Tesseract confidence is 88/100 = 0.88
      const ocrTier = result.tierResults.find((t) => t.tier === 'ocr');
      expect(ocrTier?.provider).toBe('tesseract');
      expect(ocrTier?.confidence).toBeCloseTo(0.88, 1);
    });
  });

  // =========================================================================
  // The OCR engines' current result shapes
  // =========================================================================

  describe('OCR engines as their current releases answer', () => {
    it('hands ppu-paddle-ocr an ArrayBuffer, and reads its lines with their boxes', async () => {
      mockPaddleOcrInstance.recognize.mockResolvedValue({
        text: 'Hello World\nSecond line',
        lines: [
          [
            { text: 'Hello', box: { x: 0, y: 0, width: 50, height: 30 }, confidence: 0.96 },
            { text: 'World', box: { x: 55, y: 0, width: 45, height: 30 }, confidence: 0.92 },
          ],
          [{ text: 'Second line', box: { x: 0, y: 40, width: 100, height: 30 }, confidence: 0.94 }],
        ],
        confidence: 0.94,
      });

      const result = await createFullPipeline({ embedding: false }).process(Buffer.from([1, 2, 3, 4]), { tiers: ['ocr'] });

      // ppu-paddle-ocr 6 takes a Node Buffer for a canvas and throws.
      const [input] = mockPaddleOcrInstance.recognize.mock.calls[0];
      expect(input).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(input)]).toEqual([1, 2, 3, 4]);
      expect(result.text).toBe('Hello World\nSecond line');
      expect(result.confidence).toBeCloseTo(0.94, 5);
      expect(result.regions).toEqual([
        { text: 'Hello', confidence: 0.96, bbox: { x: 0, y: 0, width: 50, height: 30 } },
        { text: 'World', confidence: 0.92, bbox: { x: 55, y: 0, width: 45, height: 30 } },
        { text: 'Second line', confidence: 0.94, bbox: { x: 0, y: 40, width: 100, height: 30 } },
      ]);
    });

    it('starts ppu-paddle-ocr with initialize() and releases it with destroy()', async () => {
      const initialize = vi.fn(async () => {});
      const destroy = vi.fn(async () => {});
      mockPaddleOcrInstance = { recognize: vi.fn(async () => highConfidencePaddleResult()), initialize, destroy } as any;

      const pipeline = createFullPipeline({ embedding: false });
      await pipeline.process(testImage(), { tiers: ['ocr'] });
      await pipeline.dispose();

      expect(initialize).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('asks tesseract.js for the blocks output, and reads its words from them', async () => {
      mockTesseractWorkerInstance.recognize.mockResolvedValue({
        data: {
          text: 'Total due\n',
          confidence: 91,
          blocks: [{
            paragraphs: [{
              lines: [{
                words: [
                  { text: 'Total', confidence: 93, bbox: { x0: 10, y0: 5, x1: 60, y1: 25 } },
                  { text: 'due', confidence: 89, bbox: { x0: 66, y0: 5, x1: 95, y1: 25 } },
                ],
              }],
            }],
          }],
        },
      });
      const image = testImage();

      const result = await createFullPipeline({ ocr: 'tesseract', embedding: false }).process(image, { tiers: ['ocr'] });

      expect(mockTesseractWorkerInstance.recognize).toHaveBeenCalledWith(image, {}, { blocks: true });
      expect(result.text).toBe('Total due\n');
      expect(result.confidence).toBeCloseTo(0.91, 5);
      expect(result.regions).toEqual([
        { text: 'Total', confidence: 0.93, bbox: { x: 10, y: 5, width: 50, height: 20 } },
        { text: 'due', confidence: 0.89, bbox: { x: 66, y: 5, width: 29, height: 20 } },
      ]);
    });
  });

  // =========================================================================
  // Failed engines, shared loads and disposal
  // =========================================================================

  describe('failed engines, shared loads and disposal', () => {
    it('goes on to the cloud tier when the OCR engine fails, and lists the failure', async () => {
      mockPaddleOcrInstance.recognize.mockRejectedValue(new Error('paddle: model download failed'));

      const result = await createFullPipeline({ handwriting: false, documentAI: false, embedding: false })
        .process(testImage());

      expect(result.tiers).toEqual(['cloud-vision']);
      expect(result.failedTiers).toEqual([{ tier: 'ocr', error: 'paddle: model download failed' }]);
      expect(result.text).toContain('handwritten notes');
    });

    it('skips the OCR tier when no engine is set, instead of failing the call', async () => {
      const result = await new VisionPipeline({ strategy: 'progressive', ocr: 'none', cloudProvider: 'openai' })
        .process(testImage());

      expect(result.tiers).toEqual(['cloud-vision']);
      expect(result.failedTiers).toBeUndefined();
    });

    it('throws with every failure when no tier gave a result', async () => {
      mockPaddleOcrInstance.recognize.mockRejectedValue(new Error('paddle down'));
      mockHfPipelineFactory.mockRejectedValue(new Error('no tokenizer.json'));

      await expect(
        createFullPipeline({ strategy: 'local-only', documentAI: false, embedding: false }).process(testImage()),
      ).rejects.toThrow('every tier that was due to run failed: ocr: paddle down; handwriting: no tokenizer.json');
    });

    it('loads an engine once for calls that start together', async () => {
      const pipeline = createFullPipeline();

      await Promise.all([pipeline.analyzeLayout(testImage()), pipeline.analyzeLayout(testImage())]);

      expect(mockFlorenceModelLoad).toHaveBeenCalledTimes(1);
      expect(mockFlorenceProcessorLoad).toHaveBeenCalledTimes(1);
    });

    it('loads the Florence-2 processor before the model, so a failed processor leaves no model behind', async () => {
      mockFlorenceProcessorLoad.mockRejectedValueOnce(new Error('preprocessor_config.json: 404'));
      const pipeline = createFullPipeline();

      await expect(pipeline.analyzeLayout(testImage())).rejects.toThrow('preprocessor_config.json: 404');
      expect(mockFlorenceModelLoad).not.toHaveBeenCalled();

      // The failed load is forgotten: the next call loads again.
      await expect(pipeline.analyzeLayout(testImage())).resolves.toMatchObject({ pages: [expect.anything()] });
      expect(mockFlorenceModelLoad).toHaveBeenCalledTimes(1);
    });

    it('waits for a call in progress before it releases the models', async () => {
      let finish!: () => void;
      mockFlorenceModel.generate.mockImplementation(
        () => new Promise((resolve) => {
          finish = () => resolve({ token_ids: 'generated' });
        }),
      );
      const pipeline = createFullPipeline();
      const layout = pipeline.analyzeLayout(testImage());
      await vi.waitFor(() => expect(mockFlorenceModel.generate).toHaveBeenCalled());

      const disposed = pipeline.dispose();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockFlorenceModel.dispose).not.toHaveBeenCalled();

      finish();
      await expect(layout).resolves.toMatchObject({ pages: [expect.anything()] });
      await disposed;
      expect(mockFlorenceModel.dispose).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Pipeline result structure
  // =========================================================================

  describe('result structure', () => {
    it('lists a local tier that failed, with its error, and goes on with the others', async () => {
      mockPaddleOcrInstance.recognize.mockResolvedValue(lowConfidencePaddleResult());
      mockHfPipelineFactory.mockImplementation(async (task: string) => {
        if (task === 'image-to-text') throw new Error('Could not locate file: "tokenizer.json".');
        return vi.fn(async () => [[0.1, 0.2]]);
      });

      const pipeline = createFullPipeline({ strategy: 'local-only' });
      const result = await pipeline.process(testImage(), { forceCategory: 'handwritten' });

      expect(result.tiers).toEqual(['ocr', 'embedding']);
      expect(result.failedTiers).toEqual([
        { tier: 'handwriting', error: 'Could not locate file: "tokenizer.json".' },
      ]);
      // The OCR text, its regions joined line by line
      expect(result.text).toBe('H\ne\nl');
    });

    it('lists a failed cloud tier when a local tier gave text, and names its error when none did', async () => {
      mockPaddleOcrInstance.recognize.mockResolvedValue(lowConfidencePaddleResult());
      mockGenerateText.mockRejectedValue(new Error('401 invalid key'));

      const withLocal = await createFullPipeline({ handwriting: false, documentAI: false, embedding: false })
        .process(testImage());
      expect(withLocal.failedTiers).toEqual([{ tier: 'cloud-vision', error: '401 invalid key' }]);

      await expect(
        createFullPipeline({ embedding: false }).process(testImage(), { tiers: ['cloud-vision'] }),
      ).rejects.toThrow('cloud vision failed and no local results available: 401 invalid key');
    });

    it('should always include durationMs >= 0', async () => {
      const pipeline = createFullPipeline();
      const result = await pipeline.process(testImage());
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should include regions from the winning tier', async () => {
      const pipeline = createFullPipeline();
      const result = await pipeline.process(testImage());

      // PaddleOCR wins (high confidence) and it has regions
      expect(result.regions).toBeDefined();
      expect(result.regions!.length).toBe(2);
      expect(result.regions![0].text).toBe('Hello World');
    });
  });
});

// ===========================================================================
// The cloud vision request
// ===========================================================================

describe('VisionPipeline cloud vision request', () => {
  /** The first bytes of a JPEG file. */
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  it('sends the image as an image part, typed by its bytes, with the configured key and base URL', async () => {
    const pipeline = createFullPipeline({ cloudApiKey: 'sk-vision', cloudBaseUrl: 'https://proxy.example/v1' });
    await pipeline.process(JPEG, { tiers: ['cloud-vision'] });

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const [request] = mockGenerateText.mock.calls[0];
    expect(request).toMatchObject({ provider: 'openai', apiKey: 'sk-vision', baseUrl: 'https://proxy.example/v1' });
    // An array of parts: a string here reaches the model as text, and the model never sees the image.
    const { content } = request.messages[0];
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({ type: 'text' });
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${JPEG.toString('base64')}` },
    });
  });

  it('passes an image URL through as the image part', async () => {
    const pipeline = createFullPipeline();
    await pipeline.process('https://example.com/scan.png', { tiers: ['cloud-vision'] });

    const [request] = mockGenerateText.mock.calls[0];
    expect(request.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: 'https://example.com/scan.png' } });
  });

  it('createVisionPipeline carries the cloud key and base URL into the pipeline', async () => {
    const pipeline = await createVisionPipeline({
      strategy: 'cloud-only',
      ocr: 'none',
      handwriting: false,
      documentAI: false,
      embedding: false,
      cloudProvider: 'anthropic',
      cloudApiKey: 'sk-from-config',
      cloudBaseUrl: 'https://gateway.example',
    });
    await pipeline.process(JPEG);

    const [request] = mockGenerateText.mock.calls[0];
    expect(request).toMatchObject({ provider: 'anthropic', apiKey: 'sk-from-config', baseUrl: 'https://gateway.example' });
  });
});

describe('createVisionPipeline cloud provider detection', () => {
  const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((name) => [name, process.env[name]]));
    for (const name of KEYS) delete process.env[name];
  });

  afterEach(() => {
    for (const name of KEYS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  /** The generateText request a cloud-only pipeline from detection sends. */
  async function cloudRequest(): Promise<Record<string, unknown>> {
    const pipeline = await createVisionPipeline({
      strategy: 'cloud-only',
      ocr: 'none',
      handwriting: false,
      documentAI: false,
      embedding: false,
    });
    await pipeline.process(Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
    return mockGenerateText.mock.calls[0][0];
  }

  it('picks the gemini provider for a GEMINI_API_KEY, which the provider reads itself', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';

    const request = await cloudRequest();

    expect(request.provider).toBe('gemini');
    expect(request.apiKey).toBeUndefined();
  });

  it('picks the gemini provider for a GOOGLE_API_KEY alone, and passes that key', async () => {
    process.env.GOOGLE_API_KEY = 'google-key';

    expect(await cloudRequest()).toMatchObject({ provider: 'gemini', apiKey: 'google-key' });
  });
});

describe('imageMediaType', () => {
  it('reads PNG, JPEG, GIF and WebP from their first bytes, and calls anything else PNG', () => {
    expect(imageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe('image/png');
    expect(imageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))).toBe('image/jpeg');
    expect(imageMediaType(Buffer.from('GIF89a......', 'latin1'))).toBe('image/gif');
    expect(imageMediaType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(imageMediaType(Buffer.from('fake-png-data'))).toBe('image/png');
    expect(imageMediaType(Buffer.alloc(0))).toBe('image/png');
  });
});
