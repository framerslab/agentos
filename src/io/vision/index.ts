/**
 * @module vision
 *
 * Unified vision pipeline with progressive enhancement for AgentOS.
 *
 * Processes images through three configurable tiers:
 *
 * 1. **Local OCR** (PaddleOCR / Tesseract.js) — fast, free, offline
 * 2. **Local Vision Models** (TrOCR / Florence-2 / CLIP) — offline, richer
 * 3. **Cloud Vision LLMs** (GPT-4o / Claude / Gemini) — best quality
 *
 * The {@link createVisionPipeline} factory auto-detects which providers
 * are installed and builds a pipeline with sensible defaults.
 *
 * @example
 * ```typescript
 * import {
 *   createVisionPipeline,
 *   VisionPipeline,
 *   type VisionPipelineConfig,
 *   type VisionResult,
 * } from '@framers/agentos/io/vision';
 *
 * // Auto-detect available providers
 * const pipeline = await createVisionPipeline();
 * const result = await pipeline.process(imageBuffer);
 *
 * // Or configure explicitly
 * const custom = await createVisionPipeline({
 *   strategy: 'progressive',
 *   ocr: 'paddle',
 *   embedding: true,
 *   cloudProvider: 'openai',
 * });
 * ```
 *
 * @see {@link VisionPipeline} for the main pipeline class.
 * @see {@link VisionPipelineConfig} for configuration options.
 * @see {@link LLMVisionProvider} for a simple cloud-only vision provider.
 * @see {@link PipelineVisionProvider} for wrapping the pipeline as IVisionProvider.
 */

export { VisionPipeline } from './VisionPipeline.js';
export { LLMVisionProvider } from './providers/LLMVisionProvider.js';
export type { LLMVisionProviderConfig } from './providers/LLMVisionProvider.js';
export { PipelineVisionProvider } from './providers/PipelineVisionProvider.js';

export type {
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
  VisionPreprocessingConfig,
  // Scene detection types (used by video analysis pipeline)
  Frame,
  SceneBoundary,
  SceneDetectorConfig,
  SceneDetectionMethod,
} from './types.js';

export { SceneDetector } from './SceneDetector.js';

// ---------------------------------------------------------------------------
// Provider availability probes
// ---------------------------------------------------------------------------

/**
 * Check if a module is importable without actually loading it.
 * Uses a dynamic import wrapped in try/catch — the module is loaded
 * then immediately discarded, so the overhead is minimal on first probe
 * but cached by the runtime on subsequent probes.
 *
 * @param moduleId - npm package name to probe.
 * @returns True if the module can be imported.
 */
async function isModuleAvailable(moduleId: string): Promise<boolean> {
  try {
    await import(moduleId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect which cloud vision provider is available based on environment
 * variables. Returns the first provider that has a valid API key set.
 *
 * @returns Provider name string, or undefined if no API keys are found.
 */
function detectCloudProvider(): string | undefined {
  // Check common vision-capable provider API keys in preference order.
  // GPT-4o is the most widely used vision LLM, so we prefer OpenAI first.
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) return 'google';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  return undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a vision pipeline with sensible defaults by auto-detecting
 * which providers are installed in the current environment.
 *
 * The factory probes for optional peer dependencies (ppu-paddle-ocr,
 * tesseract.js, \@huggingface/transformers) and cloud API keys in
 * environment variables, then configures the pipeline accordingly.
 *
 * ## Auto-detection logic
 *
 * | Check | Result |
 * |-------|--------|
 * | `ppu-paddle-ocr` importable | `ocr: 'paddle'` |
 * | `tesseract.js` importable (paddle missing) | `ocr: 'tesseract'` |
 * | Neither importable | `ocr: 'none'` |
 * | `@huggingface/transformers` importable | `handwriting: true`, `documentAI: true`, `embedding: true` |
 * | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / etc. set | `cloudProvider` configured |
 *
 * Caller-supplied config overrides always take precedence over
 * auto-detected values.
 *
 * @param config - Optional partial configuration. Fields that are set
 *   override auto-detected values. Fields that are omitted are filled
 *   by the auto-detection logic.
 * @returns A configured and ready-to-use VisionPipeline instance.
 *
 * @example
 * ```typescript
 * // Full auto-detection
 * const pipeline = await createVisionPipeline();
 *
 * // Override strategy but auto-detect everything else
 * const localOnly = await createVisionPipeline({
 *   strategy: 'local-only',
 * });
 *
 * // Explicit full config (no auto-detection)
 * const explicit = await createVisionPipeline({
 *   strategy: 'progressive',
 *   ocr: 'tesseract',
 *   handwriting: true,
 *   documentAI: false,
 *   embedding: true,
 *   cloudProvider: 'openai',
 *   cloudModel: 'gpt-4o',
 *   confidenceThreshold: 0.85,
 * });
 * ```
 */
export async function createVisionPipeline(
  config?: Partial<import('./types.js').VisionPipelineConfig>,
): Promise<import('./VisionPipeline.js').VisionPipeline> {
  // Probe available OCR engines in parallel for speed
  const [hasPaddle, hasTesseract, hasTransformers] = await Promise.all([
    // Only probe if caller didn't explicitly set the OCR engine
    config?.ocr !== undefined ? Promise.resolve(false) : isModuleAvailable('ppu-paddle-ocr'),
    config?.ocr !== undefined ? Promise.resolve(false) : isModuleAvailable('tesseract.js'),
    // Only probe if caller didn't explicitly set all HF-dependent flags
    (config?.handwriting !== undefined && config?.documentAI !== undefined && config?.embedding !== undefined)
      ? Promise.resolve(false)
      : isModuleAvailable('@huggingface/transformers'),
  ]);

  // Resolve OCR engine: caller override > paddle > tesseract > none
  let ocr = config?.ocr;
  if (ocr === undefined) {
    if (hasPaddle) {
      ocr = 'paddle';
    } else if (hasTesseract) {
      ocr = 'tesseract';
    } else {
      ocr = 'none';
    }
  }

  // Resolve HuggingFace-dependent features: caller override > auto-detect
  const handwriting = config?.handwriting ?? (hasTransformers ? true : false);
  const documentAI = config?.documentAI ?? (hasTransformers ? true : false);
  const embedding = config?.embedding ?? (hasTransformers ? true : false);

  // Resolve cloud provider: caller override > env var auto-detect
  const cloudProvider = config?.cloudProvider ?? detectCloudProvider();

  // Build the final resolved config
  const resolvedConfig: import('./types.js').VisionPipelineConfig = {
    strategy: config?.strategy ?? 'progressive',
    ocr,
    handwriting,
    documentAI,
    embedding,
    cloudProvider,
    cloudModel: config?.cloudModel,
    cloudApiKey: config?.cloudApiKey,
    cloudBaseUrl: config?.cloudBaseUrl,
    confidenceThreshold: config?.confidenceThreshold,
    preprocessing: config?.preprocessing,
  };

  const { VisionPipeline } = await import('./VisionPipeline.js');
  return new VisionPipeline(resolvedConfig);
}
