/**
 * @module io/segmentation/types
 *
 * Type definitions for provider-agnostic image segmentation.
 *
 * The segmentation surface takes an image plus exactly one prompt (text,
 * points, box, or automatic "segment everything") and returns one
 * {@link SegmentMask} per detected region. Masks are encoded white=object /
 * black=background so they drop straight into the image-editing `mask` input.
 *
 * @see {@link ISegmentationProvider} for the provider contract.
 */

/** Identifier for a segmentation backend. */
export type SegmentationProviderId = 'replicate' | (string & {});

/** Which kind of prompt drives the segmentation. Exactly one per call. */
export type SegmentationMode = 'text' | 'points' | 'box' | 'automatic';

/** A click point for point-prompted segmentation. */
export interface SegmentationPoint {
  x: number;
  y: number;
  /** Defaults to `'foreground'` during normalization. */
  label?: 'foreground' | 'background';
}

/** An axis-aligned box in image pixels (top-left origin). */
export interface SegmentationBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Per-provider passthrough options for the Replicate backend. */
export interface ReplicateSegmentationOptions {
  /** Override the SAM2 model slug used for geometric prompts. */
  samModelId?: string;
  /** Override the GroundedSAM model slug used for text prompts. */
  groundedSamModelId?: string;
  /** Poll interval in milliseconds (default 1000). */
  pollIntervalMs?: number;
  /** Overall timeout in milliseconds (default 120000). */
  timeoutMs?: number;
  /** Extra fields merged verbatim into the Replicate `input`. */
  input?: Record<string, unknown>;
}

/** Namespaced bag of per-provider options. */
export interface SegmentationProviderOptionBag {
  replicate?: ReplicateSegmentationOptions;
  [providerId: string]: unknown;
}

/** Public options accepted by the high-level {@link segment} helper. */
export interface SegmentOptions {
  /** Source image as raw bytes or a file path. */
  image: Buffer | Uint8Array | string;
  /** Provider id. Defaults to `'replicate'`. */
  provider?: SegmentationProviderId;
  /** Model id override. Provider default is used when omitted. */
  model?: string;

  // --- Exactly one prompt mode per call ---
  /** Open-vocabulary text prompt (routes to GroundedSAM). */
  prompt?: string;
  /** Point prompts (foreground/background clicks). */
  points?: SegmentationPoint[];
  /** Bounding-box prompt. */
  box?: SegmentationBox;
  /** "Segment everything" when `true`. */
  automatic?: boolean;

  /** Cap on returned masks (automatic/text can produce many). */
  maxMasks?: number;
  /** Confidence floor; masks scoring below this are dropped. */
  minScore?: number;
  /** Provider-specific passthrough options. */
  providerOptions?: SegmentationProviderOptionBag | Record<string, unknown>;
  /** Caller id for usage tracking. */
  userId?: string;
}

/** A single segmented region. */
export interface SegmentMask {
  /** PNG bytes; white(255)=object, black(0)=background (matches editImage mask). */
  mask: Buffer;
  /** Tight bounding box in source-image pixels, top-left origin. */
  bbox: SegmentationBox;
  /** Model confidence 0–1 (1 when the model reports none). */
  score: number;
  /** Grounding phrase for text prompts; undefined for geometric/automatic. */
  label?: string;
  /** Stable index within the result. */
  index: number;
}

/** Aggregated segmentation result. */
export interface SegmentationResult {
  masks: SegmentMask[];
  /** Source image width in pixels (so bboxes/masks are interpretable). */
  width: number;
  /** Source image height in pixels. */
  height: number;
  providerId: string;
  modelId: string;
  promptMode: SegmentationMode;
  usage?: { totalMasks: number; totalCostUSD?: number };
  durationMs: number;
}

/**
 * Normalized provider-level request produced by the {@link segment} helper
 * from {@link SegmentOptions}. The image is already a `Buffer`, exactly one
 * `mode` is resolved, and point labels are defaulted.
 */
export interface SegmentationRequest {
  modelId: string;
  image: Buffer;
  mode: SegmentationMode;
  prompt?: string;
  points?: Array<{ x: number; y: number; label: 'foreground' | 'background' }>;
  box?: SegmentationBox;
  maxMasks?: number;
  minScore?: number;
  providerOptions?: SegmentationProviderOptionBag | Record<string, unknown>;
}

/** Contract implemented by every segmentation backend. */
export interface ISegmentationProvider {
  readonly providerId: string;
  readonly isInitialized: boolean;
  readonly defaultModelId?: string;
  initialize(config: Record<string, unknown>): Promise<void>;
  segment(request: SegmentationRequest): Promise<SegmentationResult>;
  /** Prompt modes this provider supports, for up-front validation. */
  supportedModes(): ReadonlyArray<SegmentationMode>;
  shutdown?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Background removal (matting)
// ---------------------------------------------------------------------------

/** Identifier for a background removal backend. */
export type BackgroundRemovalProviderId = 'fal' | (string & {});

/** How {@link removeBackground} hands back the cut-out. */
export type BackgroundRemovalOutput = 'url' | 'buffer';

/** The cut-out's image format. Both keep the alpha channel. */
export type BackgroundRemovalFormat = 'png' | 'webp';

/**
 * The BiRefNet weights fal's `fal-ai/birefnet/v2` endpoint runs, as its
 * `model` field names them. `General Use (Light)` is the endpoint's default
 * and the one fal recommends for most images; `General Use (Heavy)` is slower
 * and more accurate; `Portrait` is trained for portrait images and `Matting`
 * for matting; `General Use (Dynamic)` takes resolutions from 256x256 to
 * 2304x2304.
 */
export type FalBiRefNetVariant =
  | 'General Use (Light)'
  | 'General Use (Light 2K)'
  | 'General Use (Heavy)'
  | 'Matting'
  | 'Portrait'
  | 'General Use (Dynamic)';

/** Per-provider passthrough options for the fal background removal backend. */
export interface FalBackgroundRemovalOptions {
  /** The BiRefNet weights (the endpoint's `model` field). Default `'General Use (Light)'`. */
  variant?: FalBiRefNetVariant | (string & {});
  /**
   * The resolution BiRefNet works at (`operating_resolution`). Default
   * `'1024x1024'`; `'2304x2304'` runs on the `General Use (Dynamic)` variant only.
   */
  operatingResolution?: '1024x1024' | '2048x2048' | '2304x2304' | (string & {});
  /** Refine the foreground with the estimated mask (`refine_foreground`). Default `true`. */
  refineForeground?: boolean;
  /**
   * Extra fields merged verbatim into the request body after the fields above
   * (for example `mask_only`). The call's image (`image_url`), the mask
   * `returnMask` asks for (`output_mask`) and the inline answer `output:
   * 'buffer'` asks for (`sync_mode`) stand over them.
   */
  input?: Record<string, unknown>;
  /**
   * The most bytes read from fal's answer, and from a downloaded cut-out or
   * mask; past it the call rejects with `provider_failed`. Default 64 MiB.
   */
  maxResponseBytes?: number;
}

/** Namespaced bag of per-provider background removal options. */
export interface BackgroundRemovalProviderOptionBag {
  fal?: FalBackgroundRemovalOptions;
  [providerId: string]: unknown;
}

/**
 * Options accepted by the high-level {@link removeBackground} helper.
 *
 * @example
 * ```ts
 * const { image } = await removeBackground({ image: 'https://example.com/hero.png' });
 * console.log(image.url); // the cut-out PNG on fal's CDN
 * ```
 */
export interface RemoveBackgroundOptions {
  /**
   * The source image: an `http(s)` URL, or a base64 image data URL (standard,
   * padded base64) whose bytes are PNG, JPEG, WebP or GIF, sent to the
   * provider as given, or the image's bytes, sent as a data URL typed by their
   * signature (PNG, JPEG, WebP or GIF). Any other string (a file path, raw
   * base64, a data URL that holds no such image) is refused: read the file and
   * pass its bytes.
   */
  image: string | Buffer | Uint8Array;
  /** Provider id. Defaults to `'fal'`. */
  provider?: BackgroundRemovalProviderId;
  /** The provider's model or endpoint. fal: default `'fal-ai/birefnet/v2'`. */
  model?: string;
  /**
   * `'url'` (default): the cut-out's URL on the provider's storage.
   * `'buffer'`: its bytes and data URL; fal is asked to return the image
   * inline (`sync_mode`), which also keeps it out of fal's request history.
   */
  output?: BackgroundRemovalOutput;
  /** The cut-out's format. Default `'png'`. */
  format?: BackgroundRemovalFormat;
  /** Also return the matte used for the cut (white = subject). Default `false`. */
  returnMask?: boolean;
  /** How long the call may take, download included, in milliseconds. Default 60000. */
  timeoutMs?: number;
  /** Aborts the call; it then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** fal API key for this call, instead of `FAL_API_KEY`. */
  apiKey?: string;
  /** The provider's base URL for this call (fal: default `https://fal.run`). */
  baseUrl?: string;
  /** Provider-specific passthrough options, namespaced by provider id. */
  providerOptions?: BackgroundRemovalProviderOptionBag | Record<string, unknown>;
}

/** One image a background removal returns: the cut-out, or the matte. */
export interface BackgroundRemovalImage {
  /** Where the provider stores the file. Absent when it came back inline. */
  url?: string;
  /** The image as a data URL, with `output: 'buffer'` or when the provider answered inline. */
  dataUrl?: string;
  /** The image's bytes, with `output: 'buffer'` or when the provider answered inline. */
  buffer?: Buffer;
  /** The image's media type, e.g. `'image/png'`. */
  mimeType: string;
  /** Width in pixels, when the provider reports it. */
  width?: number;
  /** Height in pixels, when the provider reports it. */
  height?: number;
  /** Size in bytes, when the provider reports it. */
  fileSize?: number;
}

/** The result of a background removal. */
export interface BackgroundRemovalResult {
  /** The subject on a transparent background. */
  image: BackgroundRemovalImage;
  /** The matte, with `returnMask`; a provider that answers without it rejects. */
  mask?: BackgroundRemovalImage;
  providerId: string;
  modelId: string;
  durationMs: number;
}

/**
 * Normalized provider-level request produced by {@link removeBackground}
 * from {@link RemoveBackgroundOptions}: the image is an `http(s)` URL or a
 * data URL, and every default is filled in.
 */
export interface BackgroundRemovalRequest {
  /** The model or endpoint; empty for the provider's default. */
  modelId: string;
  /** The source image as an `http(s)` URL or a base64 data URL. */
  imageUrl: string;
  output: BackgroundRemovalOutput;
  format: BackgroundRemovalFormat;
  returnMask: boolean;
  /** The call's deadline in milliseconds. */
  timeoutMs: number;
  signal?: AbortSignal;
  providerOptions?: BackgroundRemovalProviderOptionBag | Record<string, unknown>;
}

/** Contract implemented by every background removal backend. */
export interface IBackgroundRemovalProvider {
  readonly providerId: string;
  readonly isInitialized: boolean;
  readonly defaultModelId?: string;
  initialize(config: Record<string, unknown>): Promise<void>;
  removeBackground(request: BackgroundRemovalRequest): Promise<BackgroundRemovalResult>;
  shutdown?(): Promise<void>;
}
