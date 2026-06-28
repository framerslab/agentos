/**
 * @module media/images/providers/FalImageProvider
 *
 * Image generation provider for the Fal.ai platform, a popular serverless
 * GPU host that offers fast inference for Flux and other diffusion models.
 *
 * ## Supported models
 *
 * | Model ID                    | Description                                  |
 * |-----------------------------|----------------------------------------------|
 * | `fal-ai/flux/dev`           | Flux Dev — fast iteration, open weights      |
 * | `fal-ai/flux-pro`           | Flux Pro — highest quality                   |
 * | `fal-ai/flux/schnell`       | Flux Schnell — optimised for speed           |
 *
 * ## API flow (queue-based)
 *
 * 1. **Submit** — `POST https://queue.fal.run/{model}` with prompt/params.
 *    Returns `{ request_id }` immediately.
 * 2. **Poll** — `GET https://queue.fal.run/{model}/requests/{request_id}/status`
 *    until `status === 'COMPLETED'` and `images` array is populated.
 *
 * ## Authentication
 *
 * Requires a `FAL_API_KEY` environment variable. The key is sent as
 * `Authorization: Key ${FAL_API_KEY}`.
 *
 * @see {@link IImageProvider} for the provider interface contract.
 * @see {@link FluxImageProvider} for direct BFL API access.
 * @see {@link ReplicateImageProvider} for Flux via Replicate.
 */

import {
  type IImageProvider,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ImageEditRequest,
  type ImageModelInfo,
  type GeneratedImage,
  parseImageSize,
} from '../IImageProvider.js';
import { ApiKeyPool } from '../../../../core/providers/ApiKeyPool.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Fal.ai image provider.
 *
 * @example
 * ```typescript
 * const config: FalImageProviderConfig = {
 *   apiKey: process.env.FAL_API_KEY!,
 *   defaultModelId: 'fal-ai/flux/dev',
 * };
 * ```
 */
export interface FalImageProviderConfig {
  /**
   * Fal.ai API key. Sent as `Authorization: Key ${apiKey}`.
   * Obtain from https://fal.ai/dashboard/keys
   */
  apiKey: string;

  /**
   * Base URL for the Fal.ai queue API. Override for testing or proxy setups.
   * @default 'https://queue.fal.run'
   */
  baseURL?: string;

  /**
   * Default model to use when the request doesn't specify one.
   * @default 'fal-ai/flux/dev'
   */
  defaultModelId?: string;

  /**
   * Milliseconds between status polls while waiting for generation.
   * @default 1000
   */
  pollIntervalMs?: number;

  /**
   * Maximum milliseconds to wait for generation before timing out.
   * @default 120000
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Fal.ai API response types
// ---------------------------------------------------------------------------

/**
 * Response from the Fal.ai queue submission endpoint.
 * @internal
 */
interface FalSubmitResponse {
  /** Unique request ID for polling. */
  request_id: string;
  /**
   * Absolute status-polling URL Fal returns on submit. Authoritative over a
   * reconstructed `${base}/${model}/requests/${id}/status` path: multi-segment
   * model slugs (e.g. image-to-image edit endpoints) reconstruct to an invalid
   * route and 405. Always prefer this when present.
   */
  status_url?: string;
  /** Absolute result URL Fal returns on submit. Authoritative over a reconstructed path (same 405 reason as `status_url`). */
  response_url?: string;
}

/**
 * Response from the Fal.ai status polling endpoint.
 * @internal
 */
interface FalStatusResponse {
  /** Current status: 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED', 'FAILED'. */
  status: string;
}

/**
 * Response from the Fal.ai result endpoint (fetched after COMPLETED).
 * @internal
 */
interface FalResultResponse {
  /** Array of generated images with URLs. */
  images: Array<{
    /** URL to the generated image (temporary, typically expires). */
    url: string;
    /** Image width in pixels. */
    width?: number;
    /** Image height in pixels. */
    height?: number;
    /** MIME type of the image. */
    content_type?: string;
  }>;
  /** Random seed used for generation. */
  seed?: number;
  /** Whether NSFW content was detected. */
  has_nsfw_concepts?: boolean[];
  /** Prompt used for generation (may differ from input if modified). */
  prompt?: string;
}

// ---------------------------------------------------------------------------
// Provider-specific options
// ---------------------------------------------------------------------------

/**
 * Provider-specific options for Fal.ai image generation.
 *
 * Pass via `request.providerOptions.fal` when calling
 * {@link FalImageProvider.generateImage}.
 *
 * @example
 * ```typescript
 * const result = await provider.generateImage({
 *   modelId: 'fal-ai/flux/dev',
 *   prompt: 'A sunset over mountains',
 *   providerOptions: {
 *     fal: { num_images: 2, seed: 42 },
 *   },
 * });
 * ```
 */
export interface FalImageProviderOptions {
  /** Number of images to generate. Default: 1. */
  num_images?: number;
  /** Image size string (e.g. 'landscape_16_9', 'square_hd', 'portrait_4_3'). */
  image_size?: string;
  /** Random seed for reproducible generation. */
  seed?: number;
  /** Number of inference steps. */
  num_inference_steps?: number;
  /** Guidance scale for classifier-free guidance. */
  guidance_scale?: number;
  /** Whether to enable the safety checker. Default: true. */
  enable_safety_checker?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sleep for the specified number of milliseconds.
 * Used between poll requests to avoid rate-limiting.
 * @param ms - Duration in milliseconds.
 * @returns Resolves after the delay.
 * @internal
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Image generation provider connecting to the Fal.ai serverless platform.
 *
 * Implements the queue-based submit-then-poll pattern: a generation request
 * returns a request ID immediately, and the provider polls the status
 * endpoint until completion or timeout.
 *
 * @implements {IImageProvider}
 *
 * @example
 * ```typescript
 * const provider = new FalImageProvider();
 * await provider.initialize({ apiKey: process.env.FAL_API_KEY! });
 *
 * const result = await provider.generateImage({
 *   modelId: 'fal-ai/flux/dev',
 *   prompt: 'A photorealistic astronaut riding a horse on Mars',
 * });
 * console.log(result.images[0].url);
 * ```
 */
export class FalImageProvider implements IImageProvider {
  /** @inheritdoc */
  public readonly providerId = 'fal';

  /** @inheritdoc */
  public isInitialized = false;

  /** @inheritdoc */
  public defaultModelId?: string;

  /** Internal resolved configuration. */
  private _config!: Required<Pick<FalImageProviderConfig, 'apiKey' | 'baseURL' | 'pollIntervalMs' | 'timeoutMs'>> & FalImageProviderConfig;
  private keyPool!: ApiKeyPool;

  /**
   * Initialize the provider with API credentials and optional configuration.
   *
   * @param config - Configuration object. Must include `apiKey`.
   * @throws {Error} If `apiKey` is missing or empty.
   *
   * @example
   * ```typescript
   * await provider.initialize({ apiKey: 'fal_xxx' });
   * ```
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (!apiKey) {
      throw new Error('Fal.ai image provider requires apiKey (FAL_API_KEY).');
    }

    this._config = {
      apiKey,
      baseURL:
        typeof config.baseURL === 'string' && config.baseURL.trim()
          ? config.baseURL.trim()
          : 'https://queue.fal.run',
      defaultModelId:
        typeof config.defaultModelId === 'string' && config.defaultModelId.trim()
          ? config.defaultModelId.trim()
          : 'fal-ai/flux/dev',
      pollIntervalMs:
        typeof config.pollIntervalMs === 'number' && config.pollIntervalMs > 0
          ? config.pollIntervalMs
          : 1000,
      timeoutMs:
        typeof config.timeoutMs === 'number' && config.timeoutMs > 0
          ? config.timeoutMs
          : 120_000,
    };

    this.defaultModelId = this._config.defaultModelId;
    this.keyPool = new ApiKeyPool(apiKey);
    this.isInitialized = true;
  }

  /**
   * Generate an image using the Fal.ai queue API.
   *
   * Submits the generation task to the queue, then polls the status
   * endpoint until the result is ready or the timeout is reached.
   *
   * @param request - Image generation request with prompt and optional params.
   * @returns The generated image result with URL(s).
   *
   * @throws {Error} If the provider is not initialized.
   * @throws {Error} If the API returns an error or times out.
   *
   * @example
   * ```typescript
   * const result = await provider.generateImage({
   *   modelId: 'fal-ai/flux/dev',
   *   prompt: 'A serene Japanese garden in autumn',
   *   n: 2,
   * });
   * ```
   */
  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('Fal.ai image provider is not initialized. Call initialize() first.');
    }

    const model = request.modelId || this.defaultModelId || 'fal-ai/flux/dev';

    // Extract Fal-specific options from the provider options bag.
    const providerOpts = (request.providerOptions as Record<string, unknown> | undefined)?.fal as FalImageProviderOptions | undefined;

    // Build the request body matching Fal.ai's API schema.
    const body: Record<string, unknown> = {
      prompt: request.prompt,
    };

    // Map standard request fields to Fal.ai parameters.
    // Fal.ai uses `image_size` which can be a named preset or dimensions.
    const { width, height } = parseImageSize(request.size);
    if (providerOpts?.image_size) {
      body.image_size = providerOpts.image_size;
    } else if (width && height) {
      // Fal.ai accepts object-style dimensions for some models
      body.image_size = { width, height };
    }

    if (request.n) body.num_images = request.n;
    if (providerOpts?.num_images !== undefined) body.num_images = providerOpts.num_images;
    if (request.seed !== undefined) body.seed = request.seed;
    if (providerOpts?.seed !== undefined) body.seed = providerOpts.seed;
    if (providerOpts?.num_inference_steps !== undefined) body.num_inference_steps = providerOpts.num_inference_steps;
    if (providerOpts?.guidance_scale !== undefined) body.guidance_scale = providerOpts.guidance_scale;
    if (providerOpts?.enable_safety_checker !== undefined) body.enable_safety_checker = providerOpts.enable_safety_checker;

    // --- Character consistency via IP-Adapter ---
    const FAL_CONSISTENCY_SCALES: Record<string, number> = {
      strict: 0.9,
      balanced: 0.6,
      loose: 0.3,
    };

    if (request.referenceImageUrl) {
      body.ip_adapter_image = request.referenceImageUrl;
      body.ip_adapter_scale = FAL_CONSISTENCY_SCALES[request.consistencyMode ?? 'balanced'];
    }

    // Step 1: Submit to the queue
    const { requestId, statusUrl, responseUrl } = await this._submitTask(model, body);

    // Step 2: Poll until complete (use the URLs Fal returns, not reconstructed paths)
    await this._pollStatus(model, requestId, statusUrl);

    // Step 3: Fetch the result
    const result = await this._fetchResult(model, requestId, responseUrl);

    if (!result.images || result.images.length === 0) {
      throw new Error('Fal.ai generation completed but returned no images.');
    }

    const images: GeneratedImage[] = result.images.map((img) => ({
      url: img.url,
      mimeType: img.content_type,
      providerMetadata: {
        width: img.width,
        height: img.height,
        seed: result.seed,
      },
    }));

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      images,
      usage: {
        totalImages: images.length,
      },
    };
  }

  /**
   * List available Flux models on the Fal.ai platform.
   *
   * @returns Static list of known Fal.ai model identifiers.
   */
  /**
   * Edit an image using a Fal.ai-hosted Flux model.
   *
   * Supports img2img (prompt-guided transformation) and inpainting
   * (mask-guided regional editing). The source image is passed as a
   * base64 data URL in the `image` field of the model input.
   *
   * @param request - Edit request with source image, prompt, and optional mask.
   * @returns Generation result with the edited image(s).
   * @throws {Error} When the provider is not initialised or the API fails.
   *
   * @example
   * ```typescript
   * const result = await provider.editImage({
   *   modelId: 'fal-ai/flux/dev',
   *   image: imageBuffer,
   *   prompt: 'Convert to watercolor style',
   *   strength: 0.7,
   * });
   * ```
   */
  async editImage(request: ImageEditRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('Fal.ai image provider is not initialized. Call initialize() first.');
    }

    const hasMask = !!request.mask;
    const model = request.modelId || 'fal-ai/flux/dev';

    const imageDataUrl = `data:image/png;base64,${request.image.toString('base64')}`;
    const body: Record<string, unknown> = {
      prompt: request.prompt,
      image: imageDataUrl,
    };

    if (hasMask) {
      body.mask = `data:image/png;base64,${request.mask!.toString('base64')}`;
    }

    body.strength = request.strength ?? 0.75;

    if (request.negativePrompt) body.negative_prompt = request.negativePrompt;
    if (request.seed !== undefined) body.seed = request.seed;
    if (request.n) body.num_images = request.n;

    const { requestId, statusUrl, responseUrl } = await this._submitTask(model, body);
    await this._pollStatus(model, requestId, statusUrl);
    const result = await this._fetchResult(model, requestId, responseUrl);

    if (!result.images || result.images.length === 0) {
      throw new Error('Fal.ai edit completed but returned no images.');
    }

    const images: GeneratedImage[] = result.images.map((img) => ({
      url: img.url,
      mimeType: img.content_type,
      providerMetadata: { width: img.width, height: img.height, seed: result.seed },
    }));

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      images,
      usage: { totalImages: images.length },
    };
  }

  async listAvailableModels(): Promise<ImageModelInfo[]> {
    return [
      { providerId: this.providerId, modelId: 'fal-ai/flux/dev', displayName: 'Flux Dev (Fal)', description: 'Fast iteration, open weights, img2img capable' },
      { providerId: this.providerId, modelId: 'fal-ai/flux-pro', displayName: 'Flux Pro (Fal)', description: 'Highest quality generation' },
      { providerId: this.providerId, modelId: 'fal-ai/flux/schnell', displayName: 'Flux Schnell (Fal)', description: 'Speed-optimized generation' },
      { providerId: this.providerId, modelId: 'fal-ai/flux-pro/v1.1', displayName: 'Flux Pro 1.1 (Fal)', description: 'Latest pro generation' },
      { providerId: this.providerId, modelId: 'fal-ai/flux-pro/v1.1-ultra', displayName: 'Flux Pro 1.1 Ultra (Fal)', description: 'Ultra-high resolution' },
      { providerId: this.providerId, modelId: 'fal-ai/flux-lora', displayName: 'Flux LoRA (Fal)', description: 'LoRA fine-tuned generation' },
      { providerId: this.providerId, modelId: 'fal-ai/flux-realism', displayName: 'Flux Realism (Fal)', description: 'Photorealistic output' },
    ];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Submit a generation task to the Fal.ai queue.
   *
   * @param model - Full model path (e.g. 'fal-ai/flux/dev').
   * @param body - Request body with prompt and generation params.
   * @returns The request_id for status polling.
   *
   * @throws {Error} If the submission request fails.
   * @internal
   */
  private async _submitTask(
    model: string,
    body: Record<string, unknown>
  ): Promise<{ requestId: string; statusUrl?: string; responseUrl?: string }> {
    const url = `${this._config.baseURL}/${model}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Key ${this.keyPool.next()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Fal.ai image generation submission failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as FalSubmitResponse;
    if (!data.request_id) {
      throw new Error('Fal.ai submission response missing request_id.');
    }

    return { requestId: data.request_id, statusUrl: data.status_url, responseUrl: data.response_url };
  }

  /**
   * Poll the Fal.ai status endpoint until the task completes or times out.
   *
   * @param model - Full model path.
   * @param requestId - The request ID from submission.
   *
   * @throws {Error} If the generation fails or times out.
   * @internal
   */
  private async _pollStatus(model: string, requestId: string, statusUrl?: string): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < this._config.timeoutMs) {
      const url = statusUrl ?? `${this._config.baseURL}/${model}/requests/${requestId}/status`;

      const response = await fetch(url, {
        headers: {
          Authorization: `Key ${this.keyPool.next()}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Fal.ai status polling failed (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as FalStatusResponse;

      if (data.status === 'COMPLETED') {
        return;
      }

      if (data.status === 'FAILED') {
        throw new Error(`Fal.ai image generation failed for request ${requestId}.`);
      }

      // 'IN_QUEUE' or 'IN_PROGRESS' — wait before next poll
      await sleep(this._config.pollIntervalMs);
    }

    throw new Error(`Fal.ai image generation timed out after ${this._config.timeoutMs}ms for request ${requestId}.`);
  }

  /**
   * Fetch the completed generation result from the Fal.ai result endpoint.
   *
   * Called after polling confirms the task is COMPLETED. The result
   * endpoint is separate from the status endpoint because Fal.ai
   * returns the full payload (including image URLs) only here.
   *
   * @param model - Full model path.
   * @param requestId - The request ID from submission.
   * @returns The generation result with image URLs.
   *
   * @throws {Error} If the result fetch fails.
   * @internal
   */
  private async _fetchResult(model: string, requestId: string, responseUrl?: string): Promise<FalResultResponse> {
    const url = responseUrl ?? `${this._config.baseURL}/${model}/requests/${requestId}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Key ${this.keyPool.next()}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Fal.ai result fetch failed (${response.status}): ${errorText}`);
    }

    return (await response.json()) as FalResultResponse;
  }
}
