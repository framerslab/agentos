/**
 * @fileoverview Top-level OCR API for AgentOS.
 *
 * Provides a simple, self-contained `performOCR(options)` function that
 * extracts text from images without requiring callers to instantiate or
 * manage a {@link VisionPipeline} directly.
 *
 * Under the hood the function:
 * 1. Resolves the input (file path, URL, base64, or raw Buffer) into a Buffer.
 * 2. Creates a {@link VisionPipeline} via {@link createVisionPipeline} using
 *    the caller's strategy/threshold preferences.
 * 3. Runs the pipeline's progressive tier system (PaddleOCR -> Tesseract ->
 *    TrOCR -> Florence-2 -> Cloud LLM).
 * 4. Maps the internal {@link VisionResult} to a consumer-friendly
 *    {@link OCRResult}.
 * 5. Disposes the pipeline so no resources leak.
 *
 * @example
 * ```ts
 * import { performOCR } from '@framers/agentos';
 *
 * // From a file path
 * const result = await performOCR({ image: '/tmp/receipt.png' });
 * console.log(result.text);
 *
 * // From a URL with cloud-only strategy, on a key of your own
 * const result2 = await performOCR({
 *   image: 'https://example.com/scan.jpg',
 *   strategy: 'cloud-only',
 *   provider: 'openai',
 *   apiKey: process.env.TENANT_OPENAI_KEY,
 * });
 * ```
 *
 * @module api/performOCR
 */

import { readFile } from 'node:fs/promises';
import { imageToBuffer } from '../io/media/images/imageToBuffer.js';
import { createVisionPipeline } from '../io/vision/index.js';
import type { FailedTier, VisionResult, VisionTier } from '../io/vision/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link performOCR}.
 */
export interface PerformOCROptions {
  /**
   * Image source. Accepts any of:
   * - **File path** — absolute or relative filesystem path (e.g. `/tmp/scan.png`).
   * - **URL** — HTTP(S) URL to fetch the image from.
   * - **Base64 string** — raw base64-encoded image data (with or without a
   *   `data:image/...;base64,` prefix).
   * - **Buffer** — in-memory image bytes.
   */
  image: string | Buffer;

  /**
   * Vision strategy controlling which tiers are used.
   *
   * - `'progressive'` — start local, escalate to cloud only when confidence
   *   is below {@link confidenceThreshold}. Best cost/quality balance.
   * - `'local-only'` — never call cloud APIs. For air-gapped / privacy use.
   * - `'cloud-only'` — skip local processing, send straight to a cloud LLM.
   *   Highest quality but highest cost.
   *
   * @default 'progressive'
   */
  strategy?: 'progressive' | 'local-only' | 'cloud-only';

  /**
   * Minimum confidence threshold (0-1) to accept an OCR result from a local
   * tier without escalating to the next tier.
   *
   * Only meaningful for the `'progressive'` strategy.
   *
   * @default 0.7
   */
  confidenceThreshold?: number;

  /**
   * Cloud LLM provider for tier-3 fallback (e.g. `'openai'`, `'anthropic'`,
   * `'google'`). When omitted the provider is auto-detected from environment
   * variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.).
   */
  provider?: string;

  /**
   * Cloud LLM model override. When omitted the provider's default vision
   * model is used (e.g. `gpt-4o` for OpenAI).
   */
  model?: string;

  /**
   * API key for the cloud provider. It goes to `provider`, or to the provider
   * a `model` prefix names (`openai:gpt-4o`), and is refused with neither, so
   * it never reaches a provider picked from the environment. When omitted
   * the key is read from the standard environment variable for the provider.
   */
  apiKey?: string;

  /**
   * Base URL for the cloud provider, such as a proxy. It needs a named
   * provider, as `apiKey` does.
   */
  baseUrl?: string;
}

/**
 * Result returned by {@link performOCR}.
 */
export interface OCRResult {
  /** Extracted text content. */
  text: string;

  /** Overall confidence score (0 = no confidence, 1 = certain). */
  confidence: number;

  /**
   * Which processing tier produced the winning result.
   *
   * - `'ocr'` — PaddleOCR or Tesseract.js (fast, local, free).
   * - `'handwriting'` — TrOCR handwriting recognition (local).
   * - `'document-ai'` — Florence-2 document understanding (local).
   * - `'cloud-vision'` — Cloud LLM (GPT-4o, Claude, Gemini).
   */
  tier: VisionTier;

  /** Content category detected by the pipeline (e.g. `'printed-text'`). */
  category?: string;

  /** Provider name that produced the winning result (e.g. `'paddle'`, `'openai'`). */
  provider: string;

  /**
   * Text regions with bounding boxes, when the winning tier provides
   * spatial information. Not all tiers return region data.
   */
  regions?: Array<{
    text: string;
    bbox?: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;

  /**
   * Tiers that were due to run and failed, each with its error, such as a
   * cloud tier whose request failed while a local tier read the text.
   * Absent when none did.
   */
  failedTiers?: FailedTier[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when a string looks like a `data:` URI or raw base64.
 *
 * Heuristic: starts with `data:` prefix, or is a string containing only
 * base64-legal characters that is at least 64 chars long (to avoid false
 * positives on short file paths).
 */
function looksLikeBase64(value: string): boolean {
  if (value.startsWith('data:')) return true;
  if (value.length < 64) return false;
  return /^[A-Za-z0-9+/\r\n]+=*$/.test(value);
}

/**
 * Strips the `data:...;base64,` prefix from a data URI and returns
 * the raw base64 payload.
 */
function stripDataPrefix(value: string): string {
  const idx = value.indexOf(',');
  return idx >= 0 ? value.slice(idx + 1) : value;
}

/**
 * Resolves a heterogeneous image input into a raw `Buffer`.
 *
 * @param image - File path, URL, base64 string, or Buffer.
 * @returns The image as a Buffer.
 */
async function resolveImageToBuffer(image: string | Buffer): Promise<Buffer> {
  // Already a Buffer — return as-is.
  if (Buffer.isBuffer(image)) {
    return image;
  }

  // A data URL, base64 or percent-encoded (RFC 2397).
  if (image.startsWith('data:')) {
    return imageToBuffer(image);
  }

  // Raw base64 string.
  if (looksLikeBase64(image)) {
    const raw = stripDataPrefix(image);
    return Buffer.from(raw, 'base64');
  }

  // HTTP(S) URL — fetch and return body as Buffer.
  if (image.startsWith('http://') || image.startsWith('https://')) {
    const response = await fetch(image);
    if (!response.ok) {
      throw new Error(
        `performOCR: failed to fetch image from ${image} — HTTP ${response.status} ${response.statusText}`,
      );
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // File path — read from disk.
  return readFile(image);
}

/**
 * Determines the winning tier from a {@link VisionResult}.
 *
 * The winning tier is the one whose text was selected as the final
 * `result.text`. We find it by matching against `tierResults` — the last
 * tier result whose text matches the overall text is the winner (later
 * tiers override earlier ones in the pipeline).
 */
function resolveWinningTier(result: VisionResult): { tier: VisionTier; provider: string } {
  // Walk tier results in reverse — the last match is the winner.
  for (let i = result.tierResults.length - 1; i >= 0; i--) {
    const tr = result.tierResults[i];
    if (tr.text === result.text) {
      return { tier: tr.tier, provider: tr.provider };
    }
  }

  // Fallback: use the first tier reported in the result's tiers array.
  const fallbackTier = result.tiers[0] ?? 'ocr';
  const fallbackProvider = result.tierResults[0]?.provider ?? 'unknown';
  return { tier: fallbackTier, provider: fallbackProvider };
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Extract text from an image using AgentOS's progressive vision pipeline.
 *
 * This is the recommended high-level API for OCR. It handles input
 * resolution (file, URL, base64, Buffer), pipeline lifecycle, and
 * result mapping so callers don't need to interact with
 * {@link VisionPipeline} directly.
 *
 * ## When to use `performOCR()` vs `VisionPipeline`
 *
 * | Use case | Recommendation |
 * |----------|---------------|
 * | One-shot text extraction | `performOCR()` |
 * | Batch processing many images | `VisionPipeline` (create once, reuse) |
 * | Need embeddings or layout | `VisionPipeline` (richer result) |
 * | Simple scripts / quick integration | `performOCR()` |
 *
 * @param opts - OCR options including the image source and strategy.
 * @returns A promise resolving to an {@link OCRResult} with extracted text,
 *   confidence, tier info, and optional bounding-box regions.
 *
 * @example
 * ```ts
 * // Basic usage — file path, auto-detect everything
 * const { text, confidence } = await performOCR({
 *   image: '/path/to/receipt.png',
 * });
 *
 * // Privacy-sensitive — never call cloud APIs
 * const local = await performOCR({
 *   image: screenshotBuffer,
 *   strategy: 'local-only',
 * });
 *
 * // Best quality — go straight to cloud
 * const cloud = await performOCR({
 *   image: 'https://example.com/document.jpg',
 *   strategy: 'cloud-only',
 *   provider: 'openai',
 *   model: 'gpt-4o',
 * });
 * ```
 */
export async function performOCR(opts: PerformOCROptions): Promise<OCRResult> {
  // 1. Create a vision pipeline with the caller's preferences. It refuses a
  //    key or base URL with no named provider before any image is read.
  const pipeline = await createVisionPipeline({
    strategy: opts.strategy ?? 'progressive',
    confidenceThreshold: opts.confidenceThreshold,
    cloudProvider: opts.provider,
    cloudModel: opts.model,
    cloudApiKey: opts.apiKey,
    cloudBaseUrl: opts.baseUrl,
    // Disable embedding tier — OCR callers don't need CLIP vectors.
    embedding: false,
  });

  try {
    // 2. Resolve the input into a raw image buffer.
    const imageBuffer = await resolveImageToBuffer(opts.image);

    // 3. Run the pipeline. The cloud tier transcribes: OCR wants the text as
    //    written, not a description of the picture.
    const visionResult = await pipeline.process(imageBuffer, { cloudTask: 'transcribe' });

    // 4. Determine which tier won.
    const winning = resolveWinningTier(visionResult);

    // 5. Map regions from the winning tier (if available).
    const regions = visionResult.regions?.map((r) => ({
      text: r.text,
      bbox: r.bbox
        ? { x: r.bbox.x, y: r.bbox.y, width: r.bbox.width, height: r.bbox.height }
        : undefined,
      confidence: r.confidence,
    }));

    return {
      text: visionResult.text,
      confidence: visionResult.confidence,
      tier: winning.tier,
      category: visionResult.category,
      provider: winning.provider,
      regions,
      ...(visionResult.failedTiers?.length ? { failedTiers: visionResult.failedTiers } : {}),
    };
  } finally {
    // 6. Always clean up pipeline resources.
    await pipeline.dispose();
  }
}
