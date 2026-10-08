export type ImageProviderId = 'openai' | 'openrouter' | 'stability' | 'replicate' | 'stable-diffusion-local' | (string & {});
export type ImageModality = 'image' | 'text';
export type ImageBackground = 'transparent' | 'opaque' | 'auto';
export type ImageOutputFormat = 'png' | 'jpeg' | 'jpg' | 'webp';
export type ImageResponseFormat = 'b64_json' | 'url';

export interface ImageModelInfo {
  modelId: string;
  providerId: string;
  displayName?: string;
  description?: string;
}

export interface ImageProviderUsage {
  totalImages: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  totalCostUSD?: number;
}

export interface GeneratedImage {
  url?: string;
  dataUrl?: string;
  base64?: string;
  mimeType?: string;
  revisedPrompt?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface OpenAIImageProviderOptions {
  style?: 'vivid' | 'natural';
  moderation?: 'low' | 'auto';
  extraBody?: Record<string, unknown>;
}

export interface OpenRouterImageProviderOptions {
  imageConfig?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  transforms?: Array<Record<string, unknown>>;
  extraBody?: Record<string, unknown>;
}

export interface StabilityImageProviderOptions {
  engine?: 'core' | 'ultra' | 'sd3' | string;
  negativePrompt?: string;
  seed?: number;
  stylePreset?: string;
  cfgScale?: number;
  steps?: number;
  samples?: number;
  strength?: number;
  aspectRatio?: string;
  outputFormat?: ImageOutputFormat;
  extraFields?: Record<string, string | number | boolean>;
}

export interface ReplicateImageProviderOptions {
  wait?: number;
  webhook?: string;
  webhookEventsFilter?: string[];
  seed?: number;
  negativePrompt?: string;
  numOutputs?: number;
  aspectRatio?: string;
  outputFormat?: ImageOutputFormat;
  outputQuality?: number;
  disableSafetyChecker?: boolean;
  goFast?: boolean;
  megapixels?: string;
  input?: Record<string, unknown>;
  extraBody?: Record<string, unknown>;

  /**
   * Reference image URL for character/face consistency.
   *
   * Mapped to provider-specific inputs based on the target model:
   * - Pulid (`zsxkib/pulid`): `main_face_image`
   * - Flux Redux (`flux-redux-dev`): `image`
   * - Standard Flux models: `image` with `image_strength` derived from consistency mode
   */
  referenceImageUrl?: string;

  /**
   * Control image URL for ControlNet-style guided generation.
   *
   * Mapped to model-specific inputs:
   * - Flux Canny (`flux-canny-dev`): `control_image`
   * - Flux Depth (`flux-depth-dev`): `control_image`
   */
  controlImage?: string;

  /**
   * Control type hint for automatic model routing when `controlImage` is set
   * but no explicit model is specified.
   *
   * - `'canny'` → routes to `black-forest-labs/flux-canny-dev`
   * - `'depth'` → routes to `black-forest-labs/flux-depth-dev`
   * - `'pose'` → routes to community pose model (future)
   */
  controlType?: 'canny' | 'depth' | 'pose';
}

export interface StableDiffusionLocalImageProviderOptions {
  /** Number of inference steps (default 25). */
  steps?: number;
  /** Classifier-free guidance scale (default 7.5). */
  cfgScale?: number;
  /** Random seed (-1 for random). */
  seed?: number;
  /** Sampler name (e.g. 'Euler a', 'DPM++ 2M Karras'). */
  sampler?: string;
  /** Negative prompt. */
  negativePrompt?: string;
  /** Image width in pixels (default 512). */
  width?: number;
  /** Image height in pixels (default 512). */
  height?: number;
  /** Number of images to generate (default 1). */
  batchSize?: number;
  /** ControlNet settings forwarded verbatim to the backend. */
  controlnet?: Record<string, unknown>;
  /** LoRA models to apply.  Injected into the prompt as `<lora:name:weight>`. */
  loras?: Array<{ name: string; weight?: number }>;
  /** Enable high-resolution fix (A1111 only). */
  hrFix?: boolean;
  /** Denoising strength for high-res fix or img2img (default 0.7). */
  denoisingStrength?: number;
}

/** MiniMax text-to-image request options. */
export interface MiniMaxImageProviderOptions {
  /** Enable automatic prompt optimization. */
  promptOptimizer?: boolean;
  /** Pixel dimensions; supply both width and height. */
  width?: number;
  height?: number;
}

export interface ImageProviderOptionBag {
  minimax?: MiniMaxImageProviderOptions;
  openai?: OpenAIImageProviderOptions;
  openrouter?: OpenRouterImageProviderOptions;
  stability?: StabilityImageProviderOptions;
  replicate?: ReplicateImageProviderOptions;
  'stable-diffusion-local'?: StableDiffusionLocalImageProviderOptions;
  [providerId: string]: unknown;
}

export interface ImageGenerationRequest {
  modelId?: string;
  prompt: string;
  modalities?: ImageModality[];
  n?: number;
  size?: string;
  aspectRatio?: string;
  quality?: string;
  background?: ImageBackground;
  outputFormat?: ImageOutputFormat;
  outputCompression?: number;
  responseFormat?: ImageResponseFormat;
  userId?: string;
  seed?: number;
  negativePrompt?: string;
  providerOptions?: ImageProviderOptionBag | Record<string, unknown>;

  /**
   * Reference image URL or data URI for character/face consistency.
   *
   * Providers that support identity preservation map this to model-specific inputs:
   * - Replicate (Pulid): `main_face_image`
   * - Replicate (Flux Redux): `image`
   * - Fal (IP-Adapter): `ip_adapter_image`
   * - SD-Local: ControlNet with IP-Adapter preprocessor
   * - OpenAI/Stability/OpenRouter/BFL: ignored (debug warning logged)
   */
  referenceImageUrl?: string;

  /**
   * Pre-computed 512-dim face embedding vector for drift detection.
   *
   * When provided alongside `referenceImageUrl`, the AvatarPipeline
   * verifies generated face identity via cosine similarity against
   * this anchor vector.
   */
  faceEmbedding?: number[];

  /**
   * Character consistency mode controlling identity preservation strength.
   *
   * - `'strict'` — Maximum preservation. Uses Pulid/InstantID. Face guaranteed
   *   consistent but output creativity is constrained.
   * - `'balanced'` — Moderate preservation. IP-Adapter strength ~0.6. Good for
   *   expression variants where some variation is acceptable.
   * - `'loose'` — Light guidance. Reference influences mood/style but face may
   *   drift. Good for "inspired by" generations.
   *
   * @default 'balanced'
   */
  consistencyMode?: 'strict' | 'balanced' | 'loose';
}

export interface ImageGenerationResult {
  created: number;
  modelId: string;
  providerId: string;
  text?: string;
  images: GeneratedImage[];
  usage?: ImageProviderUsage;
}

// ---------------------------------------------------------------------------
// Image editing (img2img / inpainting / outpainting)
// ---------------------------------------------------------------------------

/** The kind of editing operation to perform. */
export type ImageEditMode = 'img2img' | 'inpaint' | 'outpaint';

/**
 * Provider-level request for image editing.
 *
 * Passed to {@link IImageProvider.editImage} by the high-level
 * {@link editImage} helper after normalising user input.
 */
export interface ImageEditRequest {
  /** Model identifier to use for the edit. */
  modelId: string;
  /** Source image as a raw `Buffer`. */
  image: Buffer;
  /** Text prompt describing the desired changes. */
  prompt: string;
  /** Optional mask for inpainting (white = edit region, black = keep). */
  mask?: Buffer;
  /** Editing mode. Defaults to `'img2img'`. */
  mode?: ImageEditMode;
  /**
   * How much the output may deviate from the source.
   * `0` = identical, `1` = completely redrawn.  Default `0.75`.
   */
  strength?: number;
  /** Negative prompt describing content to avoid. */
  negativePrompt?: string;
  /** Desired output dimensions (e.g. `"1024x1024"`). */
  size?: string;
  /** Seed for reproducible output. */
  seed?: number;
  /** Number of output images. */
  n?: number;
  /** Arbitrary provider-specific options. */
  providerOptions?: ImageProviderOptionBag | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Image upscaling (super-resolution)
// ---------------------------------------------------------------------------

/**
 * Provider-level request for image upscaling / super-resolution.
 *
 * Passed to {@link IImageProvider.upscaleImage} by the high-level
 * {@link upscaleImage} helper.
 */
export interface ImageUpscaleRequest {
  /** Model identifier to use for upscaling. */
  modelId: string;
  /** Source image as a raw `Buffer`. */
  image: Buffer;
  /** Integer scale factor (e.g. `2` or `4`). */
  scale?: 2 | 4;
  /** Target width in pixels (alternative to `scale`). */
  width?: number;
  /** Target height in pixels (alternative to `scale`). */
  height?: number;
  /** Arbitrary provider-specific options. */
  providerOptions?: ImageProviderOptionBag | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Image variations
// ---------------------------------------------------------------------------

/**
 * Provider-level request for generating image variations.
 *
 * Passed to {@link IImageProvider.variateImage} by the high-level
 * {@link variateImage} helper.
 */
export interface ImageVariateRequest {
  /** Model identifier to use for variation generation. */
  modelId: string;
  /** Source image as a raw `Buffer`. */
  image: Buffer;
  /** Number of variations to generate. */
  n?: number;
  /**
   * How different from the original (`0` = identical, `1` = very different).
   * Default `0.5`.
   */
  variance?: number;
  /** Desired output size (e.g. `"1024x1024"`). */
  size?: string;
  /** Arbitrary provider-specific options. */
  providerOptions?: ImageProviderOptionBag | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface IImageProvider {
  readonly providerId: string;
  readonly isInitialized: boolean;
  readonly defaultModelId?: string;

  initialize(config: Record<string, unknown>): Promise<void>;
  generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
  listAvailableModels?(): Promise<ImageModelInfo[]>;
  shutdown?(): Promise<void>;

  // --- Optional editing capabilities (not every provider supports every op) ---

  /**
   * Perform an image-to-image edit, inpainting, or outpainting operation.
   * Providers that do not support editing should leave this `undefined`.
   */
  editImage?(request: ImageEditRequest): Promise<ImageGenerationResult>;

  /**
   * Upscale / super-resolve an image.
   * Providers that do not support upscaling should leave this `undefined`.
   */
  upscaleImage?(request: ImageUpscaleRequest): Promise<ImageGenerationResult>;

  /**
   * Generate visual variations of the supplied image.
   * Providers that do not support variations should leave this `undefined`.
   */
  variateImage?(request: ImageVariateRequest): Promise<ImageGenerationResult>;
}

const BUILT_IN_IMAGE_PROVIDER_IDS = new Set(['minimax', 'openai', 'openrouter', 'stability', 'replicate', 'stable-diffusion-local']);

export function getImageProviderOptions<T extends object>(
  providerId: string,
  providerOptions?: ImageGenerationRequest['providerOptions'],
): T | undefined {
  if (!providerOptions || typeof providerOptions !== 'object' || Array.isArray(providerOptions)) {
    return undefined;
  }

  const bag = providerOptions as ImageProviderOptionBag;
  const directMatch = bag[providerId];
  if (directMatch && typeof directMatch === 'object' && !Array.isArray(directMatch)) {
    return directMatch as T;
  }

  const hasNamespacedProviderKeys = Object.keys(providerOptions).some(
    (key) => BUILT_IN_IMAGE_PROVIDER_IDS.has(key) || key === providerId,
  );
  if (hasNamespacedProviderKeys) {
    return undefined;
  }

  return providerOptions as T;
}

export function parseDataUrl(
  value: string,
): { mimeType?: string; base64?: string; dataUrl?: string } {
  const match = /^data:([^;,]+)?;base64,(.+)$/i.exec(value.trim());
  if (!match) {
    return { dataUrl: value };
  }
  return {
    mimeType: match[1] || undefined,
    base64: match[2],
    dataUrl: value,
  };
}

export function normalizeOutputFormat(format?: ImageOutputFormat): 'png' | 'jpeg' | 'webp' | undefined {
  if (!format) {
    return undefined;
  }
  return format === 'jpg' ? 'jpeg' : format;
}

export function parseImageSize(size?: string): { width?: number; height?: number } {
  if (!size) {
    return {};
  }
  const match = /^(\d+)x(\d+)$/i.exec(size.trim());
  if (!match) {
    return {};
  }
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

export function inferAspectRatioFromSize(size?: string): string | undefined {
  if (!size) {
    return undefined;
  }

  switch (size.trim()) {
    case '1024x1024':
    case '512x512':
    case '256x256':
      return '1:1';
    case '1792x1024':
      return '16:9';
    case '1024x1792':
      return '9:16';
    default:
      break;
  }

  const { width, height } = parseImageSize(size);
  if (!width || !height) {
    return undefined;
  }

  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}
