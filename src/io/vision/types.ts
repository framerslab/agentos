/**
 * @module vision/types
 *
 * Type definitions for the unified vision pipeline.
 *
 * The vision pipeline processes images through configurable tiers — from fast,
 * free, offline OCR (PaddleOCR / Tesseract.js) through local vision models
 * (TrOCR, Florence-2, CLIP via HuggingFace Transformers) to cloud vision LLMs
 * (GPT-4o, Claude, Gemini). Each tier adds progressively richer understanding
 * at increasing cost and latency.
 *
 * ## Tier overview
 *
 * | Tier | Provider | Capability | Cost |
 * |------|----------|-----------|------|
 * | 1 — OCR | PaddleOCR / Tesseract.js | Printed text extraction | Free/offline |
 * | 2 — Local Vision | TrOCR / Florence-2 / CLIP | Handwriting, layout, embeddings | Free/offline |
 * | 3 — Cloud Vision | GPT-4o / Claude / Gemini | Scene understanding, complex docs | API cost |
 *
 * @see {@link VisionPipeline} for the orchestration engine.
 * @see {@link VisionStrategy} for how tiers are combined.
 */

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

/**
 * Strategy for how vision tiers are combined during processing.
 *
 * - `'progressive'` — Try local OCR first, enhance with local vision models,
 *   upgrade with cloud only when confidence is below threshold. Best balance
 *   of cost and quality.
 * - `'local-only'` — Tiers 1 + 2 only, never call cloud APIs. For air-gapped
 *   or privacy-sensitive environments.
 * - `'cloud-only'` — Skip local processing entirely, send directly to cloud
 *   vision LLM. Highest quality but highest cost.
 * - `'parallel'` — Run local and cloud simultaneously, merge the best results.
 *   Lowest latency for high-quality output when cost is not a concern.
 */
export type VisionStrategy =
  | 'progressive'
  | 'local-only'
  | 'cloud-only'
  | 'parallel';

// ---------------------------------------------------------------------------
// Content classification
// ---------------------------------------------------------------------------

/**
 * What kind of visual content the pipeline detected or was told to expect.
 *
 * Used to route images to the most appropriate processing tier — e.g.
 * handwritten content triggers TrOCR, complex layouts trigger Florence-2.
 */
export type ContentCategory =
  | 'printed-text'     // typed/printed document
  | 'handwritten'      // handwritten notes/forms
  | 'document-layout'  // complex document with tables/figures
  | 'photograph'       // natural scene/photo
  | 'diagram'          // chart, flowchart, architectural diagram
  | 'screenshot'       // UI screenshot
  | 'mixed';           // combination of multiple categories

// ---------------------------------------------------------------------------
// Vision tiers
// ---------------------------------------------------------------------------

/**
 * Identifies which processing tier produced a result.
 *
 * - `'ocr'` — Tier 1: PaddleOCR or Tesseract.js text extraction
 * - `'handwriting'` — Tier 2a: TrOCR handwriting recognition
 * - `'document-ai'` — Tier 2b: Florence-2 document understanding
 * - `'embedding'` — Tier 2c: CLIP image embedding generation
 * - `'cloud-vision'` — Tier 3: Cloud vision LLM (GPT-4o, Claude, etc.)
 */
export type VisionTier = 'ocr' | 'handwriting' | 'document-ai' | 'embedding' | 'cloud-vision';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Result from a single processing tier.
 *
 * Each tier that runs produces one of these, regardless of whether the
 * pipeline ultimately uses its output or prefers a higher-confidence
 * alternative from another tier.
 */
export interface TierResult {
  /** Which tier produced this result. */
  tier: VisionTier;

  /** Provider name within the tier (e.g. 'paddle', 'tesseract', 'openai'). */
  provider: string;

  /** Extracted or generated text content. */
  text: string;

  /** Confidence score from 0 (no confidence) to 1 (certain). */
  confidence: number;

  /** Wall-clock processing time in milliseconds. */
  durationMs: number;

  /** Bounding boxes for detected text regions, when available. */
  regions?: TextRegion[];
}

/**
 * A detected text region within an image, with spatial coordinates
 * and per-region confidence.
 */
export interface TextRegion {
  /** The text content within this region. */
  text: string;

  /** Confidence score for this specific region (0–1). */
  confidence: number;

  /**
   * Bounding box in image coordinates (pixels).
   * Origin is top-left corner of the image.
   */
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

// ---------------------------------------------------------------------------
// Document layout
// ---------------------------------------------------------------------------

/**
 * Structured document layout produced by Florence-2 or similar
 * document understanding models.
 *
 * Captures the spatial arrangement of text, tables, figures, headings,
 * and other semantic blocks within a multi-page document.
 */
export interface DocumentLayout {
  /** Pages in document order. */
  pages: DocumentPage[];
}

/**
 * A single page within a structured document layout.
 */
export interface DocumentPage {
  /** 1-based page number. */
  pageNumber: number;

  /** Page width in pixels. */
  width: number;

  /** Page height in pixels. */
  height: number;

  /** Semantic blocks detected on this page. */
  blocks: LayoutBlock[];
}

/**
 * A semantic block within a document page — a paragraph, table, figure,
 * heading, list, or code snippet.
 */
export interface LayoutBlock {
  /** Semantic type of the block. */
  type: 'text' | 'table' | 'figure' | 'heading' | 'list' | 'code';

  /** Text content extracted from the block. */
  content: string;

  /**
   * Bounding box in page coordinates (pixels).
   * Origin is top-left corner of the page.
   */
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  /** Confidence score for this block detection (0–1). */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

/**
 * Aggregated result from the vision pipeline after all configured tiers
 * have run. Contains the best extracted text, content classification,
 * optional embeddings, and detailed per-tier breakdowns.
 *
 * @example
 * ```typescript
 * const result = await pipeline.process(imageBuffer);
 *
 * // Best extracted text across all tiers
 * console.log(result.text);
 *
 * // What kind of content was detected
 * console.log(result.category); // 'printed-text' | 'handwritten' | ...
 *
 * // CLIP embedding for similarity search
 * if (result.embedding) {
 *   await vectorStore.upsert('images', [{ embedding: result.embedding }]);
 * }
 *
 * // Inspect individual tier contributions
 * for (const tr of result.tierResults) {
 *   console.log(`${tr.tier} (${tr.provider}): ${tr.confidence}`);
 * }
 * ```
 */
export interface VisionResult {
  /** Best extracted text (from OCR, handwriting, or vision description). */
  text: string;

  /** Overall confidence score 0–1, taken from the winning tier. */
  confidence: number;

  /** What kind of content was detected. */
  category: ContentCategory;

  /** Which tier(s) contributed to the final result. */
  tiers: VisionTier[];

  /** Detailed results from each tier that ran, ordered by execution. */
  tierResults: TierResult[];

  /** CLIP image embedding vector, when embedding tier is enabled. */
  embedding?: number[];

  /** Structured document layout, when Florence-2 ran. */
  layout?: DocumentLayout;

  /** Bounding boxes for detected text regions from the winning tier. */
  regions?: TextRegion[];

  /** Total wall-clock processing time in milliseconds. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

/**
 * Preprocessing options applied to images before they enter the
 * vision pipeline tiers. Uses `sharp` under the hood.
 */
export interface VisionPreprocessingConfig {
  /** Convert to grayscale before OCR (improves contrast for printed text). */
  grayscale?: boolean;

  /**
   * Resize constraints. The image is scaled down proportionally
   * so that neither dimension exceeds the specified maximum.
   * No upscaling is performed.
   */
  resize?: {
    maxWidth?: number;
    maxHeight?: number;
  };

  /** Apply unsharp-mask sharpening (helps blurry scans). */
  sharpen?: boolean;

  /** Normalize brightness/contrast (histogram stretching). */
  normalize?: boolean;
}

/**
 * Configuration for the {@link VisionPipeline}.
 *
 * All fields are optional — the factory function {@link createVisionPipeline}
 * auto-detects available providers and fills in sensible defaults.
 *
 * @example
 * ```typescript
 * const config: VisionPipelineConfig = {
 *   strategy: 'progressive',
 *   ocr: 'paddle',
 *   handwriting: true,
 *   documentAI: true,
 *   embedding: true,
 *   cloudProvider: 'openai',
 *   cloudModel: 'gpt-4o',
 *   confidenceThreshold: 0.8,
 *   preprocessing: { grayscale: true, sharpen: true },
 * };
 * ```
 */
export interface VisionPipelineConfig {
  /**
   * How to combine tiers.
   * @default 'progressive'
   */
  strategy: VisionStrategy;

  /**
   * OCR engine for Tier 1 text extraction.
   * - `'paddle'` — PaddleOCR (via `ppu-paddle-ocr`). Best accuracy for most scripts.
   * - `'tesseract'` — Tesseract.js. Wider language support, slightly lower accuracy.
   * - `'none'` — Skip OCR entirely (useful for photo-only pipelines).
   * @default 'paddle' (if installed), else 'tesseract' (if installed), else 'none'
   */
  ocr?: 'paddle' | 'tesseract' | 'none';

  /**
   * Enable handwriting recognition via TrOCR (`@huggingface/transformers`).
   * Only triggered when OCR confidence is low and content appears handwritten.
   * @default false
   */
  handwriting?: boolean;

  /**
   * Enable document understanding via Florence-2 (`@huggingface/transformers`).
   * Produces structured {@link DocumentLayout} with semantic block detection.
   * @default false
   */
  documentAI?: boolean;

  /**
   * Enable CLIP image embeddings (`@huggingface/transformers`).
   * Runs in parallel with other tiers — does not affect text extraction.
   * @default false
   */
  embedding?: boolean;

  /**
   * Cloud vision LLM provider name for Tier 3 fallback.
   * Must match a provider known to `generateText()` (e.g. 'openai', 'anthropic', 'google').
   * When unset, cloud vision is disabled.
   */
  cloudProvider?: string;

  /**
   * Cloud model override. When unset, the provider's default vision model is used.
   * @example 'gpt-4o', 'claude-sonnet-4-6', 'gemini-2.5-flash'
   */
  cloudModel?: string;

  /**
   * Minimum confidence to accept an OCR result without escalating to cloud.
   * Only applies to `'progressive'` strategy — if OCR confidence is below
   * this threshold, the pipeline escalates to the next tier.
   * @default 0.7
   */
  confidenceThreshold?: number;

  /**
   * Image preprocessing options applied before any tier runs.
   * Uses `sharp` for resizing, grayscale conversion, sharpening,
   * and normalization.
   */
  preprocessing?: VisionPreprocessingConfig;
}

// ---------------------------------------------------------------------------
// Frame extraction (used by video analysis pipeline)
// ---------------------------------------------------------------------------

/**
 * A single decoded video frame with its timestamp and sequence index.
 *
 * Frames are produced by the frame extraction stage of the video
 * analysis pipeline and consumed by {@link SceneDetector} for visual
 * change detection.
 */
export interface Frame {
  /** Raw pixel data as a Buffer (RGB, 3 bytes per pixel, row-major). */
  buffer: Buffer;

  /**
   * Original encoded frame bytes (for example PNG/JPEG) when the frame was
   * decoded into raw RGB for scene detection.
   */
  sourceBuffer?: Buffer;

  /** Timestamp of this frame within the source video, in seconds. */
  timestampSec: number;

  /** 0-based sequential index of this frame in the extraction order. */
  index: number;
}

// ---------------------------------------------------------------------------
// Scene boundary detection
// ---------------------------------------------------------------------------

/**
 * A detected scene boundary within a video frame sequence.
 *
 * Produced by {@link SceneDetector.detectScenes} when visual
 * discontinuity between consecutive frames exceeds the configured
 * threshold. Each boundary marks the start of a new scene.
 */
export interface SceneBoundary {
  /** 0-based index of this scene boundary in detection order. */
  index: number;

  /** Index of the first frame belonging to this scene. */
  startFrame: number;

  /** Index of the last frame belonging to this scene. */
  endFrame: number;

  /** Timestamp (seconds) of the first frame in this scene. */
  startTimeSec: number;

  /** Timestamp (seconds) of the last frame in this scene. */
  endTimeSec: number;

  /** Duration of this scene in seconds (`endTimeSec - startTimeSec`). */
  durationSec: number;

  /**
   * Classification of the visual transition that starts this scene.
   *
   * - `'hard-cut'` — Abrupt frame-to-frame change (chi-squared > hardCutThreshold)
   * - `'dissolve'` — Cross-dissolve / superimposition (diff > 0.25)
   * - `'fade'`     — Fade from/to black or white (diff > 0.20)
   * - `'wipe'`     — Directional wipe transition
   * - `'gradual'`  — Other gradual transition below dissolve threshold
   */
  cutType: 'hard-cut' | 'dissolve' | 'fade' | 'wipe' | 'gradual';

  /**
   * Confidence score (0–1) for this scene boundary.
   * Derived from the diff score relative to the threshold — higher
   * values indicate a more definitive visual discontinuity.
   */
  confidence: number;

  /**
   * Raw difference score that triggered the scene boundary.
   * Useful for debugging threshold tuning. The scale depends on the
   * detection method (histogram chi-squared, 1 - SSIM, etc.).
   */
  diffScore?: number;
}

// ---------------------------------------------------------------------------
// Scene detector configuration
// ---------------------------------------------------------------------------

/**
 * Detection method used by the {@link SceneDetector}.
 *
 * - `'histogram'` — RGB histogram chi-squared distance. Fast, works
 *   well for hard cuts. No external dependencies.
 * - `'ssim'`      — Structural Similarity Index. Better for gradual
 *   transitions. Requires `sharp` (falls back to histogram if missing).
 * - `'clip'`      — CLIP embedding cosine distance. Semantic scene
 *   change detection. Requires a CLIP provider (local or OpenAI).
 */
export type SceneDetectionMethod = 'histogram' | 'ssim' | 'clip';

/**
 * Configuration for the {@link SceneDetector}.
 *
 * All fields are optional — the detector uses sensible defaults that
 * work well for typical video content.
 *
 * @example
 * ```typescript
 * const config: SceneDetectorConfig = {
 *   methods: ['histogram', 'ssim'],
 *   hardCutThreshold: 0.3,
 *   gradualThreshold: 0.15,
 *   minSceneDurationSec: 1.0,
 * };
 * ```
 */
export interface SceneDetectorConfig {
  /**
   * Detection methods to use. Multiple methods are combined by
   * taking the maximum diff score across all methods.
   * @default ['histogram', 'ssim']
   */
  methods?: SceneDetectionMethod[];

  /**
   * Diff score threshold above which a frame transition is classified
   * as a hard cut. Applied to histogram chi-squared distance (0–1).
   * @default 0.3
   */
  hardCutThreshold?: number;

  /**
   * Diff score threshold for gradual transitions (dissolves, fades).
   * Transitions with scores between this and {@link hardCutThreshold}
   * are classified as gradual cuts.
   * @default 0.15
   */
  gradualThreshold?: number;

  /**
   * Minimum scene duration in seconds. Scene boundaries that would
   * create scenes shorter than this are suppressed. Prevents
   * over-segmentation from flashes, strobe effects, or noise.
   * @default 1.0
   */
  minSceneDurationSec?: number;

  /**
   * CLIP embedding provider to use when `'clip'` is in {@link methods}.
   * - `'local'`  — Use local CLIP model via @huggingface/transformers
   * - `'openai'` — Use OpenAI's CLIP-based embedding endpoint
   * @default 'local'
   */
  clipProvider?: 'local' | 'openai';
}
