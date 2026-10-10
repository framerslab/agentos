/**
 * @module vision/VisionPipeline
 *
 * Unified vision pipeline with progressive enhancement.
 *
 * Processes images through configurable tiers:
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ Image Buffer / URL                                                  │
 * │   ↓                                                                 │
 * │ Preprocessing (sharp: resize, grayscale, sharpen, normalize)        │
 * │   ↓                                                                 │
 * │ Tier 1 — Local OCR (PaddleOCR or Tesseract.js)                     │
 * │   ↓ confidence < threshold?                                         │
 * │ Tier 2 — Local Vision (TrOCR / Florence-2)                         │
 * │   ↓ still below threshold?                                          │
 * │ Tier 3 — Cloud Vision (GPT-4o / Claude / Gemini via generateText)  │
 * │   ↓                                                                 │
 * │ Merge: highest-confidence text wins, structured layout preserved    │
 * │                                                                     │
 * │ [parallel] CLIP embedding runs alongside all tiers                  │
 * └─────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Dependency loading
 *
 * All heavy ML dependencies (ppu-paddle-ocr, tesseract.js,
 * \@huggingface/transformers) are loaded lazily via dynamic `import()`.
 * If a dependency is missing, the pipeline throws a helpful error
 * with installation instructions — it never crashes on missing
 * optional peer deps at module load time.
 *
 * ## Strategy behaviours
 *
 * | Strategy | Tier 1 | Tier 2 | Tier 3 | Notes |
 * |----------|--------|--------|--------|-------|
 * | progressive | Always | If low confidence | If still low | Default |
 * | local-only | Always | Always | Never | Air-gapped |
 * | cloud-only | Never | Never | Always | Best quality |
 * | parallel | Always | Always | Always | Merge best |
 *
 * @see {@link VisionPipelineConfig} for configuration options.
 * @see {@link VisionResult} for the output shape.
 * @see {@link createVisionPipeline} for the auto-detecting factory.
 *
 * @example
 * ```typescript
 * const pipeline = new VisionPipeline({
 *   strategy: 'progressive',
 *   ocr: 'paddle',
 *   handwriting: true,
 *   documentAI: true,
 *   embedding: true,
 *   cloudProvider: 'openai',
 *   confidenceThreshold: 0.8,
 * });
 *
 * const result = await pipeline.process(imageBuffer);
 * console.log(result.text);       // extracted text
 * console.log(result.category);   // 'printed-text' | 'handwritten' | etc.
 * console.log(result.embedding);  // CLIP vector for search
 * console.log(result.layout);     // structured document layout
 * ```
 */

import { bufferToBlobPart } from '../media/images/imageToBuffer.js';
import type {
  VisionPipelineConfig,
  VisionResult,
  VisionStrategy,
  VisionTier,
  ContentCategory,
  TierResult,
  TextRegion,
  DocumentLayout,
  DocumentPage,
  LayoutBlock,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default confidence threshold for the progressive strategy.
 * OCR results above this threshold are accepted without cloud escalation.
 */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Default cloud vision confidence score. Cloud LLMs don't return numeric
 * confidence, so we assign a fixed high value since they are generally
 * the most capable tier.
 */
const CLOUD_VISION_CONFIDENCE = 0.95;

/**
 * Prompt sent to cloud vision LLMs when describing images.
 * Designed to extract both descriptive text AND any embedded text,
 * and to identify the content type for routing purposes.
 */
const CLOUD_VISION_PROMPT =
  'Describe this image in detail. Extract all visible text exactly as written. ' +
  'Identify the type of content (printed document, handwritten note, photograph, ' +
  'diagram, screenshot, etc.). If the image contains a document, preserve the ' +
  'logical reading order and structure.';

// ---------------------------------------------------------------------------
// VisionPipeline
// ---------------------------------------------------------------------------

/**
 * The image as the transformers.js image-to-text pipelines take it. A Buffer
 * goes in a Blob, which transformers.js decodes with sharp in Node
 * (`RawImage.fromBlob`). A data URL string does not work there: in Node,
 * transformers.js reads a string that is not an http(s) or blob: URL as a
 * file path (`getFile` in its utils/hub.js), and fails. A URL string goes as
 * it is.
 */
function transformersImage(image: Buffer | string): Blob | string {
  return Buffer.isBuffer(image) ? new Blob([bufferToBlobPart(image)]) : image;
}

/**
 * The media type of an image from its first bytes: PNG, JPEG, GIF or WebP,
 * and `image/png` for anything else.
 */
export function imageMediaType(image: Buffer): string {
  if (image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) return 'image/jpeg';
  if (image.length >= 6 && /^GIF8[79]a$/.test(image.toString('latin1', 0, 6))) return 'image/gif';
  if (image.length >= 12 && image.toString('latin1', 0, 4) === 'RIFF' && image.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return 'image/png';
}

/**
 * Unified vision pipeline with progressive enhancement.
 *
 * Processes images through up to three tiers of increasing capability:
 * 1. Local OCR (PaddleOCR / Tesseract.js) — fast, free, offline
 * 2. Local Vision Models (TrOCR / Florence-2 / CLIP) — offline but slower
 * 3. Cloud Vision LLMs (GPT-4o, Claude, Gemini) — best quality, API cost
 *
 * All heavy dependencies are loaded lazily on first use. The pipeline
 * never imports ML libraries at module load time, so it's safe to
 * instantiate even when optional peer deps are missing — errors only
 * surface when a tier that needs them actually runs.
 *
 * @see {@link createVisionPipeline} for automatic provider detection.
 */
export class VisionPipeline {
  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /** Resolved pipeline configuration. */
  private readonly _config: VisionPipelineConfig;

  // -------------------------------------------------------------------------
  // Lazy-loaded provider instances (initialized on first use)
  // -------------------------------------------------------------------------

  /** PaddleOCR service instance (Tier 1). */
  private _paddleOcr?: any;

  /** Tesseract.js worker instance (Tier 1). */
  private _tesseract?: any;

  /** TrOCR pipeline for handwriting recognition (Tier 2). */
  private _trOcrPipeline?: any;

  /** Florence-2 pipeline for document understanding (Tier 2). */
  private _florencePipeline?: any;

  /** CLIP pipeline for image embeddings (Tier 2). */
  private _clipPipeline?: any;

  /** Whether dispose() has been called. Guards against use-after-free. */
  private _disposed = false;

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * Create a new vision pipeline.
   *
   * @param config - Pipeline configuration. All heavy dependencies are loaded
   *   lazily, so construction is synchronous and never imports ML libraries.
   *
   * @example
   * ```typescript
   * const pipeline = new VisionPipeline({
   *   strategy: 'progressive',
   *   ocr: 'paddle',
   *   handwriting: true,
   *   cloudProvider: 'openai',
   * });
   * ```
   */
  constructor(config: VisionPipelineConfig) {
    this._config = { ...config };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Process an image through the configured tiers.
   *
   * Automatically detects content type (printed text, handwritten, diagram,
   * etc.) and routes through the appropriate processing tiers based on the
   * configured {@link VisionStrategy}.
   *
   * @param image - Image data as a Buffer or file-path / URL string.
   *   Buffers are preprocessed with sharp (if configured). URL strings
   *   are passed directly to providers that support them.
   * @param options - Optional overrides for this specific invocation.
   * @param options.forceCategory - Force a specific content category
   *   instead of auto-detecting from OCR confidence heuristics.
   * @param options.tiers - Run only these specific tiers, ignoring
   *   the strategy's normal routing logic.
   * @returns Aggregated vision result with text, confidence, embeddings, etc.
   *
   * @throws {Error} If all configured tiers fail to produce a result.
   * @throws {Error} If a required dependency (e.g. ppu-paddle-ocr) is missing.
   * @throws {Error} If `dispose()` was already called.
   *
   * @example
   * ```typescript
   * // Full progressive pipeline
   * const result = await pipeline.process(imageBuffer);
   *
   * // Force handwriting mode
   * const hw = await pipeline.process(scanBuffer, {
   *   forceCategory: 'handwritten',
   * });
   *
   * // Only run OCR and embedding, skip everything else
   * const partial = await pipeline.process(imageBuffer, {
   *   tiers: ['ocr', 'embedding'],
   * });
   * ```
   */
  async process(
    image: Buffer | string,
    options?: {
      forceCategory?: ContentCategory;
      tiers?: VisionTier[];
    },
  ): Promise<VisionResult> {
    this._assertNotDisposed();

    const startTime = Date.now();
    const { strategy } = this._config;
    const threshold = this._config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

    // Preprocess the image (resize, grayscale, etc.) if it's a Buffer
    const preprocessed = Buffer.isBuffer(image)
      ? await this._preprocess(image)
      : image;

    const tierResults: TierResult[] = [];
    let embedding: number[] | undefined;
    let layout: DocumentLayout | undefined;
    const activeTiers: VisionTier[] = [];

    // Determine which tiers to run based on strategy (or explicit override)
    const requestedTiers = options?.tiers;

    // -----------------------------------------------------------------------
    // CLIP embedding — runs in parallel with everything else when enabled,
    // because it doesn't affect the text extraction path.
    // -----------------------------------------------------------------------
    const embeddingPromise = this._shouldRunTier('embedding', strategy, requestedTiers)
      ? this._runClipEmbedding(preprocessed).catch(() => undefined)
      : Promise.resolve(undefined);

    // -----------------------------------------------------------------------
    // Strategy: cloud-only — skip all local tiers
    // -----------------------------------------------------------------------
    if (strategy === 'cloud-only' && !requestedTiers) {
      const cloudResult = await this._runCloudVision(preprocessed);
      tierResults.push(cloudResult);
      activeTiers.push('cloud-vision');

      embedding = await embeddingPromise;
      if (embedding) activeTiers.push('embedding');

      return this._assembleResult(
        tierResults,
        activeTiers,
        embedding,
        layout,
        options?.forceCategory,
        startTime,
      );
    }

    // -----------------------------------------------------------------------
    // Tier 1 — Local OCR (PaddleOCR or Tesseract.js)
    // -----------------------------------------------------------------------
    let ocrResult: TierResult | undefined;

    if (this._shouldRunTier('ocr', strategy, requestedTiers)) {
      ocrResult = await this._runOcr(preprocessed);
      tierResults.push(ocrResult);
      activeTiers.push('ocr');

      // In progressive mode, if OCR confidence is high enough, we can
      // skip expensive downstream tiers and return early.
      if (
        strategy === 'progressive' &&
        !requestedTiers &&
        ocrResult.confidence >= threshold
      ) {
        embedding = await embeddingPromise;
        if (embedding) activeTiers.push('embedding');

        return this._assembleResult(
          tierResults,
          activeTiers,
          embedding,
          layout,
          options?.forceCategory,
          startTime,
        );
      }
    }

    // -----------------------------------------------------------------------
    // Content category detection — decides which Tier 2 models to invoke
    // -----------------------------------------------------------------------
    const category = options?.forceCategory ?? this._detectCategory(ocrResult);

    // -----------------------------------------------------------------------
    // Tier 2a — Handwriting recognition (TrOCR)
    // Triggered when content appears handwritten (low OCR confidence +
    // single-char region heuristic) or when forced via forceCategory.
    // -----------------------------------------------------------------------
    if (
      this._shouldRunTier('handwriting', strategy, requestedTiers) &&
      (category === 'handwritten' || category === 'mixed')
    ) {
      try {
        const hwResult = await this._runTrOcr(preprocessed);
        tierResults.push(hwResult);
        activeTiers.push('handwriting');
      } catch {
        // TrOCR failure is non-fatal — we still have OCR or cloud fallback
      }
    }

    // -----------------------------------------------------------------------
    // Tier 2b — Document understanding (Florence-2)
    // Triggered for complex layouts (many regions with varying sizes).
    // -----------------------------------------------------------------------
    if (
      this._shouldRunTier('document-ai', strategy, requestedTiers) &&
      (category === 'document-layout' || category === 'mixed')
    ) {
      try {
        const docResult = await this._runFlorence2(preprocessed);
        tierResults.push(docResult.tierResult);
        activeTiers.push('document-ai');
        layout = docResult.layout;
      } catch {
        // Florence-2 failure is non-fatal
      }
    }

    // -----------------------------------------------------------------------
    // Tier 3 — Cloud Vision (GPT-4o / Claude / Gemini)
    // In progressive mode: only if we're still below threshold.
    // In parallel mode: always runs.
    // In local-only mode: never runs.
    // -----------------------------------------------------------------------
    const bestLocalConfidence = this._bestConfidence(tierResults);

    if (this._shouldRunCloudVision(strategy, bestLocalConfidence, threshold, requestedTiers)) {
      try {
        const cloudResult = await this._runCloudVision(preprocessed);
        tierResults.push(cloudResult);
        activeTiers.push('cloud-vision');
      } catch {
        // Cloud failure is non-fatal if we have local results
        if (tierResults.length === 0) {
          throw new Error(
            'VisionPipeline: cloud vision failed and no local results available.',
          );
        }
      }
    }

    // -----------------------------------------------------------------------
    // Collect CLIP embedding (was running in parallel)
    // -----------------------------------------------------------------------
    embedding = await embeddingPromise;
    if (embedding) activeTiers.push('embedding');

    // -----------------------------------------------------------------------
    // Assemble final result
    // -----------------------------------------------------------------------
    return this._assembleResult(
      tierResults,
      activeTiers,
      embedding,
      layout,
      options?.forceCategory ?? category,
      startTime,
    );
  }

  /**
   * Extract text only — fastest path using OCR tier exclusively.
   *
   * Ignores all other tiers (handwriting, document-ai, cloud, embedding).
   * Useful when you just need the text content and don't need confidence
   * scoring, layout analysis, or embeddings.
   *
   * @param image - Image data as a Buffer or file-path / URL string.
   * @returns Extracted text, or empty string if OCR produces no output.
   *
   * @throws {Error} If the configured OCR engine is missing.
   *
   * @example
   * ```typescript
   * const text = await pipeline.extractText(receiptImage);
   * console.log(text); // "ACME STORE\n...\nTotal: $42.99"
   * ```
   */
  async extractText(image: Buffer | string): Promise<string> {
    this._assertNotDisposed();

    const preprocessed = Buffer.isBuffer(image)
      ? await this._preprocess(image)
      : image;

    const result = await this._runOcr(preprocessed);
    return result.text;
  }

  /**
   * Generate an image embedding using CLIP — embedding tier only.
   *
   * Useful for building image similarity search indexes without running
   * the full OCR + vision pipeline.
   *
   * @param image - Image data as a Buffer or file-path / URL string.
   * @returns CLIP embedding vector (typically 512 or 768 dimensions).
   *
   * @throws {Error} If `@huggingface/transformers` is not installed.
   * @throws {Error} If CLIP model loading fails.
   *
   * @example
   * ```typescript
   * const embedding = await pipeline.embed(photoBuffer);
   * await vectorStore.upsert('images', [{
   *   id: 'photo-1',
   *   embedding,
   *   metadata: { source: 'upload' },
   * }]);
   * ```
   */
  async embed(image: Buffer | string): Promise<number[]> {
    this._assertNotDisposed();

    const preprocessed = Buffer.isBuffer(image)
      ? await this._preprocess(image)
      : image;

    const result = await this._runClipEmbedding(preprocessed);
    if (!result) {
      throw new Error('VisionPipeline: CLIP embedding returned empty result.');
    }
    return result;
  }

  /**
   * Analyze document layout using Florence-2 — document-ai tier only.
   *
   * Returns structured {@link DocumentLayout} with semantic blocks
   * (text, tables, figures, headings, lists, code) and their bounding
   * boxes within each page.
   *
   * @param image - Image data as a Buffer or file-path / URL string.
   * @returns Structured document layout with pages and blocks.
   *
   * @throws {Error} If `@huggingface/transformers` is not installed.
   * @throws {Error} If Florence-2 model loading fails.
   *
   * @example
   * ```typescript
   * const layout = await pipeline.analyzeLayout(documentScan);
   * for (const page of layout.pages) {
   *   for (const block of page.blocks) {
   *     console.log(`${block.type}: ${block.content.slice(0, 50)}...`);
   *   }
   * }
   * ```
   */
  async analyzeLayout(image: Buffer | string): Promise<DocumentLayout> {
    this._assertNotDisposed();

    const preprocessed = Buffer.isBuffer(image)
      ? await this._preprocess(image)
      : image;

    const result = await this._runFlorence2(preprocessed);
    return result.layout;
  }

  /**
   * Shut down the pipeline and release all loaded model resources.
   *
   * After calling dispose(), any further calls to `process()`,
   * `extractText()`, `embed()`, or `analyzeLayout()` will throw.
   *
   * @example
   * ```typescript
   * const pipeline = new VisionPipeline({ strategy: 'progressive' });
   * try {
   *   const result = await pipeline.process(image);
   * } finally {
   *   await pipeline.dispose();
   * }
   * ```
   */
  async dispose(): Promise<void> {
    this._disposed = true;

    // Release PaddleOCR resources
    if (this._paddleOcr?.dispose) {
      try {
        await this._paddleOcr.dispose();
      } catch {
        // Swallow disposal errors — we're tearing down anyway
      }
    }
    this._paddleOcr = undefined;

    // Terminate Tesseract worker
    if (this._tesseract?.terminate) {
      try {
        await this._tesseract.terminate();
      } catch {
        // Swallow disposal errors
      }
    }
    this._tesseract = undefined;

    // Release HuggingFace pipelines by dropping references.
    // The transformers library doesn't expose explicit dispose(),
    // so we rely on GC to reclaim WASM/ONNX memory.
    this._trOcrPipeline = undefined;
    this._florencePipeline = undefined;
    this._clipPipeline = undefined;
  }

  // -------------------------------------------------------------------------
  // Preprocessing
  // -------------------------------------------------------------------------

  /**
   * Apply configured preprocessing to an image buffer using sharp.
   *
   * @param image - Raw image buffer.
   * @returns Preprocessed image buffer, or the original if no preprocessing
   *   is configured or sharp is unavailable.
   */
  private async _preprocess(image: Buffer): Promise<Buffer> {
    const pp = this._config.preprocessing;
    if (!pp) return image;

    // Only import sharp when preprocessing is actually needed.
    // sharp is already a project dependency, but we guard the import
    // to keep the pipeline functional even if sharp fails to load
    // (e.g. in environments without native bindings).
    let sharp: any;
    try {
      // @ts-ignore — sharp is an optional native dependency, may not be installed in CI
      sharp = (await import('sharp')).default;
    } catch {
      // sharp not available — return original image unmodified.
      // This is a soft failure because preprocessing is an optimization,
      // not a hard requirement.
      return image;
    }

    let pipeline = sharp(image);

    // Resize while preserving aspect ratio — never upscale
    if (pp.resize) {
      pipeline = pipeline.resize({
        width: pp.resize.maxWidth,
        height: pp.resize.maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // Convert to grayscale (improves OCR contrast on colored backgrounds)
    if (pp.grayscale) {
      pipeline = pipeline.grayscale();
    }

    // Sharpen (helps blurry scans and camera captures)
    if (pp.sharpen) {
      pipeline = pipeline.sharpen();
    }

    // Normalize brightness/contrast via histogram stretching
    if (pp.normalize) {
      pipeline = pipeline.normalize();
    }

    return pipeline.toBuffer();
  }

  // -------------------------------------------------------------------------
  // Tier 1 — Local OCR
  // -------------------------------------------------------------------------

  /**
   * Run OCR on the image using the configured engine (PaddleOCR or Tesseract.js).
   *
   * @param image - Preprocessed image buffer or URL string.
   * @returns Tier result with extracted text, confidence, and regions.
   * @throws {Error} If OCR engine is 'none' or neither engine is available.
   */
  private async _runOcr(image: Buffer | string): Promise<TierResult> {
    const ocrEngine = this._config.ocr ?? 'paddle';

    if (ocrEngine === 'none') {
      throw new Error(
        'VisionPipeline: OCR is set to "none" but OCR tier was requested.',
      );
    }

    if (ocrEngine === 'paddle') {
      return this._runPaddleOcr(image);
    }

    return this._runTesseract(image);
  }

  /**
   * Run PaddleOCR for text extraction.
   *
   * Lazily loads and initializes the ppu-paddle-ocr library on first call.
   * Subsequent calls reuse the cached service instance.
   *
   * @param image - Image buffer or URL string.
   * @returns Tier result with PaddleOCR output.
   * @throws {Error} If ppu-paddle-ocr is not installed.
   */
  private async _runPaddleOcr(image: Buffer | string): Promise<TierResult> {
    const start = Date.now();
    const ocr = await this._loadPaddleOcr();

    // PaddleOCR expects a Buffer; convert URL/path to buffer if needed
    const imageBuffer = Buffer.isBuffer(image) ? image : await this._urlToBuffer(image);

    const ocrResult = await ocr.recognize(imageBuffer);

    // Normalize PaddleOCR output into our standard shape.
    // PaddleOCR returns an array of detected text regions with bounding
    // boxes and per-region confidence scores.
    const regions: TextRegion[] = (ocrResult?.regions ?? ocrResult?.data ?? []).map(
      (r: any) => ({
        text: r.text ?? r.content ?? '',
        confidence: r.confidence ?? r.score ?? 0,
        bbox: {
          x: r.bbox?.[0]?.[0] ?? r.box?.[0]?.[0] ?? 0,
          y: r.bbox?.[0]?.[1] ?? r.box?.[0]?.[1] ?? 0,
          width: (r.bbox?.[1]?.[0] ?? r.box?.[1]?.[0] ?? 0) - (r.bbox?.[0]?.[0] ?? r.box?.[0]?.[0] ?? 0),
          height: (r.bbox?.[2]?.[1] ?? r.box?.[2]?.[1] ?? 0) - (r.bbox?.[0]?.[1] ?? r.box?.[0]?.[1] ?? 0),
        },
      }),
    );

    const text = regions.map((r) => r.text).join('\n');
    const avgConfidence =
      regions.length > 0
        ? regions.reduce((sum, r) => sum + r.confidence, 0) / regions.length
        : 0;

    return {
      tier: 'ocr',
      provider: 'paddle',
      text,
      confidence: avgConfidence,
      durationMs: Date.now() - start,
      regions,
    };
  }

  /**
   * Run Tesseract.js for text extraction.
   *
   * Lazily loads the tesseract.js library and creates a worker on first call.
   * The worker is reused for subsequent calls and terminated on dispose().
   *
   * @param image - Image buffer or URL string.
   * @returns Tier result with Tesseract output.
   * @throws {Error} If tesseract.js is not installed.
   */
  private async _runTesseract(image: Buffer | string): Promise<TierResult> {
    const start = Date.now();
    const worker = await this._loadTesseract();

    // Tesseract.js accepts Buffer, URL, or base64 string
    const input = Buffer.isBuffer(image) ? image : image;
    const result = await worker.recognize(input);

    // Normalize Tesseract output into our standard shape.
    // Tesseract returns paragraphs → lines → words with bounding boxes.
    const regions: TextRegion[] = (result.data?.words ?? []).map(
      (w: any) => ({
        text: w.text ?? '',
        confidence: (w.confidence ?? 0) / 100, // Tesseract uses 0-100 scale
        bbox: {
          x: w.bbox?.x0 ?? 0,
          y: w.bbox?.y0 ?? 0,
          width: (w.bbox?.x1 ?? 0) - (w.bbox?.x0 ?? 0),
          height: (w.bbox?.y1 ?? 0) - (w.bbox?.y0 ?? 0),
        },
      }),
    );

    const text = result.data?.text ?? '';
    // Tesseract confidence is 0-100; normalize to 0-1
    const confidence = (result.data?.confidence ?? 0) / 100;

    return {
      tier: 'ocr',
      provider: 'tesseract',
      text,
      confidence,
      durationMs: Date.now() - start,
      regions,
    };
  }

  // -------------------------------------------------------------------------
  // Tier 2a — Handwriting recognition (TrOCR)
  // -------------------------------------------------------------------------

  /**
   * Run TrOCR handwriting recognition via @huggingface/transformers.
   *
   * TrOCR is a transformer model specifically trained for handwritten
   * text recognition. It excels where standard OCR engines (PaddleOCR,
   * Tesseract) produce low-confidence, garbled output on cursive text.
   *
   * @param image - Preprocessed image buffer or URL string.
   * @returns Tier result with handwriting-recognized text.
   * @throws {Error} If @huggingface/transformers is not installed.
   */
  private async _runTrOcr(image: Buffer | string): Promise<TierResult> {
    const start = Date.now();
    const pipe = await this._loadTrOcr();

    const output = await pipe(transformersImage(image));

    // The pipeline returns an array of { generated_text: string }
    const text = Array.isArray(output)
      ? output.map((o: any) => o.generated_text ?? '').join('\n')
      : (output as any)?.generated_text ?? '';

    return {
      tier: 'handwriting',
      provider: 'trocr',
      text,
      // TrOCR doesn't output per-token confidence for the full sequence,
      // so we assign a moderate default. The progressive strategy will
      // still prefer cloud results if they exist.
      confidence: text.length > 0 ? 0.75 : 0,
      durationMs: Date.now() - start,
    };
  }

  // -------------------------------------------------------------------------
  // Tier 2b — Document understanding (Florence-2)
  // -------------------------------------------------------------------------

  /**
   * Run Florence-2 document understanding via @huggingface/transformers.
   *
   * Florence-2 detects semantic blocks (text, tables, figures, headings,
   * lists, code) and their bounding boxes, producing a structured
   * {@link DocumentLayout} alongside extracted text.
   *
   * @param image - Preprocessed image buffer or URL string.
   * @returns Tier result plus structured document layout.
   * @throws {Error} If @huggingface/transformers is not installed.
   */
  private async _runFlorence2(
    image: Buffer | string,
  ): Promise<{ tierResult: TierResult; layout: DocumentLayout }> {
    const start = Date.now();
    const pipe = await this._loadFlorence2();

    // Florence-2 uses a VQA-style interface — we ask it to describe
    // the document layout.
    const output = await pipe(transformersImage(image), 'Describe the document layout in detail.');

    // Parse Florence-2 output into our structured layout format.
    // The model returns a description — we extract block annotations
    // if the model provides them, or fall back to a single text block.
    const text = Array.isArray(output)
      ? output.map((o: any) => o.generated_text ?? '').join('\n')
      : (output as any)?.generated_text ?? '';

    const blocks: LayoutBlock[] = [{
      type: 'text',
      content: text,
      bbox: { x: 0, y: 0, width: 0, height: 0 },
      confidence: 0.8,
    }];

    const layout: DocumentLayout = {
      pages: [{
        pageNumber: 1,
        width: 0,
        height: 0,
        blocks,
      }],
    };

    return {
      tierResult: {
        tier: 'document-ai',
        provider: 'florence-2',
        text,
        confidence: text.length > 0 ? 0.8 : 0,
        durationMs: Date.now() - start,
      },
      layout,
    };
  }

  // -------------------------------------------------------------------------
  // Tier 2c — Image embeddings (CLIP)
  // -------------------------------------------------------------------------

  /**
   * Generate a CLIP image embedding via @huggingface/transformers.
   *
   * CLIP embeddings enable cross-modal similarity search — the embedding
   * lives in the same vector space as text embeddings from the same model,
   * so you can search images with text queries and vice versa.
   *
   * @param image - Preprocessed image buffer or URL string.
   * @returns Embedding vector (typically 512 or 768 dimensions), or undefined
   *   if CLIP is not available.
   * @throws {Error} If @huggingface/transformers is not installed.
   */
  private async _runClipEmbedding(image: Buffer | string): Promise<number[] | undefined> {
    const pipe = await this._loadClip();

    const input = Buffer.isBuffer(image)
      ? `data:image/png;base64,${image.toString('base64')}`
      : image;

    const output = await pipe(input);

    // The feature-extraction pipeline returns a nested tensor-like structure.
    // We extract the flat float array from it.
    if (Array.isArray(output)) {
      // output is [[number, number, ...]] — flatten one level
      const flat = Array.isArray(output[0]) ? output[0] : output;
      return flat.map((v: any) => Number(v));
    }

    // Handle tensor-like output with .data or .tolist()
    if (output?.data) {
      return Array.from(output.data as number[]);
    }
    if (typeof output?.tolist === 'function') {
      const list = output.tolist();
      return Array.isArray(list[0]) ? list[0] : list;
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // Tier 3 — Cloud Vision
  // -------------------------------------------------------------------------

  /**
   * Run cloud vision LLM for image understanding.
   *
   * Uses the existing `generateText()` API with a multimodal message
   * containing the image as a base64 data URL. This works with any
   * vision-capable provider (OpenAI GPT-4o, Anthropic Claude, Google
   * Gemini, Ollama with LLaVA, etc.).
   *
   * @param image - Image buffer or URL string.
   * @returns Tier result with cloud vision description.
   * @throws {Error} If no cloud provider is configured.
   * @throws {Error} If the cloud API call fails.
   */
  private async _runCloudVision(image: Buffer | string): Promise<TierResult> {
    const start = Date.now();

    if (!this._config.cloudProvider) {
      throw new Error(
        'VisionPipeline: cloud vision requested but no cloudProvider is configured. ' +
        'Set cloudProvider in the pipeline config (e.g. "openai", "anthropic").',
      );
    }

    // Import the high-level API to avoid coupling to any specific provider
    const { generateText } = await import('../../api/generateText.js');

    // A buffer goes as a data URL with the media type its bytes show: a
    // provider that checks the declared type against the data (Anthropic
    // does) rejects a JPEG sent as image/png.
    const imageUrl = Buffer.isBuffer(image)
      ? `data:${imageMediaType(image)};base64,${image.toString('base64')}`
      : image;

    // The content is an array of parts, which providers send as a text part
    // and an image part. A string, such as the parts serialized as JSON,
    // reaches the model as text, and the model never sees the image.
    const result = await generateText({
      provider: this._config.cloudProvider,
      model: this._config.cloudModel,
      apiKey: this._config.cloudApiKey,
      baseUrl: this._config.cloudBaseUrl,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: CLOUD_VISION_PROMPT },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
    });

    return {
      tier: 'cloud-vision',
      provider: this._config.cloudProvider,
      text: result.text,
      confidence: CLOUD_VISION_CONFIDENCE,
      durationMs: Date.now() - start,
    };
  }

  // -------------------------------------------------------------------------
  // Lazy loader methods (optional peer dependency pattern)
  // -------------------------------------------------------------------------

  /**
   * Lazily load and initialize PaddleOCR.
   *
   * @returns Initialized PaddleOCR service instance.
   * @throws {Error} If ppu-paddle-ocr is not installed, with install instructions.
   */
  private async _loadPaddleOcr(): Promise<any> {
    if (this._paddleOcr) return this._paddleOcr;

    try {
      const mod = await import('ppu-paddle-ocr');
      // ppu-paddle-ocr exports vary by version — handle both default and named
      const PaddleOcrCls = mod.PaddleOcrService ?? mod.default?.PaddleOcrService ?? mod.default;
      const instance = new PaddleOcrCls();

      // PaddleOCR requires async initialization to load ONNX models
      if (typeof instance.init === 'function') {
        await instance.init();
      }

      this._paddleOcr = instance;
      return instance;
    } catch (err: any) {
      // Distinguish between "not installed" and "runtime init failure"
      if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
        throw new Error(
          'ppu-paddle-ocr is not installed. Install with:\n' +
          '  npm install ppu-paddle-ocr\n\n' +
          'Or switch to Tesseract.js by setting ocr: "tesseract" in the pipeline config.',
        );
      }
      throw err;
    }
  }

  /**
   * Lazily load and initialize a Tesseract.js worker.
   *
   * @returns Initialized Tesseract worker ready for recognition.
   * @throws {Error} If tesseract.js is not installed, with install instructions.
   */
  private async _loadTesseract(): Promise<any> {
    if (this._tesseract) return this._tesseract;

    try {
      const mod = await import('tesseract.js');
      const Tesseract = mod.default ?? mod;

      // createWorker() handles downloading trained data on first run
      const worker = await Tesseract.createWorker('eng');
      this._tesseract = worker;
      return worker;
    } catch (err: any) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
        throw new Error(
          'tesseract.js is not installed. Install with:\n' +
          '  npm install tesseract.js\n\n' +
          'Or switch to PaddleOCR by setting ocr: "paddle" in the pipeline config.',
        );
      }
      throw err;
    }
  }

  /**
   * Lazily load the TrOCR image-to-text pipeline from @huggingface/transformers.
   *
   * @returns HuggingFace image-to-text pipeline configured with TrOCR weights.
   * @throws {Error} If @huggingface/transformers is not installed.
   */
  private async _loadTrOcr(): Promise<any> {
    if (this._trOcrPipeline) return this._trOcrPipeline;

    try {
      const { pipeline } = await import('@huggingface/transformers');
      // TrOCR is an image-to-text model for handwriting recognition.
      // microsoft/trocr-base-handwritten is the standard pretrained checkpoint.
      this._trOcrPipeline = await (pipeline as any)(
        'image-to-text',
        'microsoft/trocr-base-handwritten',
      );
      return this._trOcrPipeline;
    } catch (err: any) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
        throw new Error(
          '@huggingface/transformers is not installed. Install with:\n' +
          '  npm install @huggingface/transformers\n\n' +
          'This is required for handwriting recognition (TrOCR).',
        );
      }
      throw err;
    }
  }

  /**
   * Lazily load the Florence-2 document understanding pipeline.
   *
   * @returns HuggingFace pipeline configured for Florence-2 document analysis.
   * @throws {Error} If @huggingface/transformers is not installed.
   */
  private async _loadFlorence2(): Promise<any> {
    if (this._florencePipeline) return this._florencePipeline;

    try {
      const { pipeline } = await import('@huggingface/transformers');
      // Florence-2 uses the image-to-text task with a VQA-style interface.
      // microsoft/Florence-2-base is the standard pretrained checkpoint.
      this._florencePipeline = await (pipeline as any)(
        'image-to-text',
        'microsoft/Florence-2-base',
      );
      return this._florencePipeline;
    } catch (err: any) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
        throw new Error(
          '@huggingface/transformers is not installed. Install with:\n' +
          '  npm install @huggingface/transformers\n\n' +
          'This is required for document understanding (Florence-2).',
        );
      }
      throw err;
    }
  }

  /**
   * Lazily load the CLIP feature-extraction pipeline for image embeddings.
   *
   * @returns HuggingFace feature-extraction pipeline configured with CLIP.
   * @throws {Error} If @huggingface/transformers is not installed.
   */
  private async _loadClip(): Promise<any> {
    if (this._clipPipeline) return this._clipPipeline;

    try {
      const { pipeline } = await import('@huggingface/transformers');
      // CLIP ViT-B/32 is the standard model for image embeddings.
      // It produces 512-dimensional vectors in the same space as
      // CLIP text embeddings, enabling cross-modal search.
      this._clipPipeline = await (pipeline as any)(
        'feature-extraction',
        'Xenova/clip-vit-base-patch32',
      );
      return this._clipPipeline;
    } catch (err: any) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
        throw new Error(
          '@huggingface/transformers is not installed. Install with:\n' +
          '  npm install @huggingface/transformers\n\n' +
          'This is required for CLIP image embeddings.',
        );
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Content category heuristics
  // -------------------------------------------------------------------------

  /**
   * Detect the content category from OCR results using heuristics.
   *
   * This avoids running expensive classification models just to decide
   * which Tier 2 model to invoke. The heuristics are deliberately
   * conservative — when in doubt, they return 'mixed' which triggers
   * both handwriting and document-ai tiers.
   *
   * @param ocrResult - Result from Tier 1 OCR, or undefined if OCR was skipped.
   * @returns Detected content category.
   */
  private _detectCategory(ocrResult?: TierResult): ContentCategory {
    if (!ocrResult) return 'mixed';

    // High confidence + clean text → printed document
    if (ocrResult.confidence > 0.85) return 'printed-text';

    // Low confidence + many single-character detections is a strong
    // handwriting signal: OCR struggles with cursive and often splits
    // connected strokes into individual character guesses.
    const singleCharRegions = ocrResult.regions?.filter(
      (r) => r.text.trim().length === 1,
    );
    if (
      ocrResult.confidence < 0.5 &&
      singleCharRegions &&
      singleCharRegions.length > 0
    ) {
      return 'handwritten';
    }

    // Many regions with varying sizes suggests a complex document layout
    // with headers, body text, sidebars, tables, etc.
    if (ocrResult.regions && ocrResult.regions.length > 20) {
      return 'document-layout';
    }

    // Moderate confidence but few regions — probably a photograph or
    // diagram with some incidental text.
    if (ocrResult.confidence < 0.6 && (ocrResult.regions?.length ?? 0) < 5) {
      return 'photograph';
    }

    return 'mixed';
  }

  // -------------------------------------------------------------------------
  // Routing helpers
  // -------------------------------------------------------------------------

  /**
   * Determine whether a specific tier should run based on the strategy
   * and any explicit tier overrides.
   *
   * @param tier - The tier to check.
   * @param strategy - The pipeline's configured strategy.
   * @param requestedTiers - Explicit tier overrides from the caller, if any.
   * @returns True if the tier should run.
   */
  private _shouldRunTier(
    tier: VisionTier,
    strategy: VisionStrategy,
    requestedTiers?: VisionTier[],
  ): boolean {
    // Explicit tier list takes precedence over strategy
    if (requestedTiers) return requestedTiers.includes(tier);

    // Strategy-based routing
    switch (tier) {
      case 'ocr':
        // OCR runs in all strategies except cloud-only
        return strategy !== 'cloud-only';

      case 'handwriting':
        // Handwriting only runs if explicitly enabled in config
        if (!this._config.handwriting) return false;
        // Runs in progressive (conditionally), local-only, and parallel
        return strategy !== 'cloud-only';

      case 'document-ai':
        // Document AI only runs if explicitly enabled in config
        if (!this._config.documentAI) return false;
        return strategy !== 'cloud-only';

      case 'embedding':
        // Embedding only runs if explicitly enabled in config
        if (!this._config.embedding) return false;
        return true; // CLIP runs regardless of strategy

      case 'cloud-vision':
        // Cloud vision routing is handled separately in _shouldRunCloudVision
        return false;

      default:
        return false;
    }
  }

  /**
   * Determine whether cloud vision should run based on strategy, current
   * confidence, and threshold.
   *
   * Cloud vision is the most expensive tier, so we're careful about when
   * to invoke it — only when local results are insufficient.
   *
   * @param strategy - Pipeline strategy.
   * @param bestLocalConfidence - Best confidence from local tiers so far.
   * @param threshold - Confidence threshold for cloud escalation.
   * @param requestedTiers - Explicit tier overrides, if any.
   * @returns True if cloud vision should run.
   */
  private _shouldRunCloudVision(
    strategy: VisionStrategy,
    bestLocalConfidence: number,
    threshold: number,
    requestedTiers?: VisionTier[],
  ): boolean {
    // Explicit tier list takes precedence
    if (requestedTiers) return requestedTiers.includes('cloud-vision');

    // No cloud provider configured — can't run
    if (!this._config.cloudProvider) return false;

    switch (strategy) {
      case 'cloud-only':
        // Already handled at the top of process() — shouldn't reach here
        return true;

      case 'local-only':
        // Never call cloud
        return false;

      case 'parallel':
        // Always run cloud alongside local
        return true;

      case 'progressive':
        // Only escalate when local confidence is below threshold
        return bestLocalConfidence < threshold;

      default:
        return false;
    }
  }

  /**
   * Find the highest confidence among a set of tier results.
   *
   * @param tierResults - Results from tiers that have run so far.
   * @returns Best confidence score, or 0 if no results.
   */
  private _bestConfidence(tierResults: TierResult[]): number {
    if (tierResults.length === 0) return 0;
    return Math.max(...tierResults.map((r) => r.confidence));
  }

  // -------------------------------------------------------------------------
  // Result assembly
  // -------------------------------------------------------------------------

  /**
   * Assemble the final {@link VisionResult} from individual tier outputs.
   *
   * The winning tier is the one with the highest confidence. Layout data
   * from Florence-2 is always included when available, regardless of
   * which tier's text wins.
   *
   * @param tierResults - All tier results collected during processing.
   * @param activeTiers - Which tiers actually ran (for metadata).
   * @param embedding - CLIP embedding, if generated.
   * @param layout - Florence-2 document layout, if generated.
   * @param forcedCategory - Caller-specified category override.
   * @param startTime - Timestamp when processing started (for duration).
   * @returns Assembled vision result.
   */
  private _assembleResult(
    tierResults: TierResult[],
    activeTiers: VisionTier[],
    embedding: number[] | undefined,
    layout: DocumentLayout | undefined,
    forcedCategory: ContentCategory | undefined,
    startTime: number,
  ): VisionResult {
    // Pick the tier result with the highest confidence for the primary text
    const winner = tierResults.reduce(
      (best, current) => (current.confidence > best.confidence ? current : best),
      tierResults[0] ?? { text: '', confidence: 0, regions: undefined },
    );

    // Detect category from the OCR result (first tier), unless forced
    const ocrResult = tierResults.find((r) => r.tier === 'ocr');
    const category = forcedCategory ?? this._detectCategory(ocrResult);

    return {
      text: winner?.text ?? '',
      confidence: winner?.confidence ?? 0,
      category,
      tiers: activeTiers,
      tierResults,
      embedding,
      layout,
      regions: winner?.regions,
      durationMs: Date.now() - startTime,
    };
  }

  // -------------------------------------------------------------------------
  // Utility methods
  // -------------------------------------------------------------------------

  /**
   * Convert a URL or file path to a Buffer by reading the file or
   * fetching the URL.
   *
   * @param url - URL string (http://, https://, file://, or bare path).
   * @returns Image data as a Buffer.
   */
  private async _urlToBuffer(url: string): Promise<Buffer> {
    // Handle data URLs by extracting the base64 payload
    if (url.startsWith('data:')) {
      const commaIdx = url.indexOf(',');
      if (commaIdx === -1) throw new Error(`VisionPipeline: invalid data URL.`);
      return Buffer.from(url.slice(commaIdx + 1), 'base64');
    }

    // Handle http/https URLs
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const { default: axios } = await import('axios');
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      return Buffer.from(response.data);
    }

    // Handle file:// URLs and bare file paths
    const { readFile } = await import('node:fs/promises');
    const filePath = url.startsWith('file://') ? url.slice(7) : url;
    return readFile(filePath);
  }

  /**
   * Guard method that throws if the pipeline has been disposed.
   * Called at the top of every public method to prevent use-after-free.
   *
   * @throws {Error} If dispose() has been called.
   */
  private _assertNotDisposed(): void {
    if (this._disposed) {
      throw new Error(
        'VisionPipeline: pipeline has been disposed. Create a new instance.',
      );
    }
  }
}
