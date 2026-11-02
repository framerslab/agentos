/**
 * @module media/video/providers/ReplicateVideoProvider
 *
 * Video generation provider for the Replicate API.
 *
 * Replicate hosts a wide range of video models (Kling, MiniMax Hailuo, Veo,
 * Wan, etc.) behind a uniform predictions API. This provider mirrors the
 * pattern established by {@link ReplicateImageProvider}: create a prediction
 * with `Prefer: wait`, then poll if it hasn't completed inline.
 *
 * ## Models
 *
 * The model is `owner/name` for an official model (for example
 * `google/veo-3.1` or `kwaivgi/kling-v2.5-turbo-pro`, the default),
 * `owner/name:version` or a bare 64-character version id. It is sent as the
 * prediction's `version`, which takes all three forms
 * (https://replicate.com/docs/reference/http#predictions.create).
 *
 * ## Model inputs
 *
 * | Request field      | Replicate input                                       |
 * |--------------------|-------------------------------------------------------|
 * | `prompt`           | `prompt`                                              |
 * | `image`            | `start_image` (`kwaivgi/kling*`), `first_frame_image` (`minimax/*`), otherwise `image` |
 * | `referenceImages`  | `reference_images`                                    |
 * | `durationSec`      | `duration`                                            |
 * | `aspectRatio`      | `aspect_ratio`                                        |
 * | `resolution`       | `resolution`                                          |
 * | `negativePrompt`   | `negative_prompt`                                     |
 * | `seed`             | `seed`                                                |
 *
 * The image names come from each model's input schema
 * (`GET https://api.replicate.com/v1/models/{owner}/{name}`): Kling takes
 * `start_image`, MiniMax Hailuo and Video-01 take `first_frame_image`, and
 * Veo 3.1 and Wan take `image`. Images given as URLs are sent as given and a
 * `Buffer` as a `data:` URL; Replicate accepts both for file inputs.
 * `providerOptions` (or their `replicate` entry) add other inputs, such as
 * Veo's `last_frame` or MiniMax's `subject_reference`, and never replace the
 * fields above. Their `imageInputName` entry is not sent: it names the input
 * the source image goes under, ahead of the model-family rule above. A bare
 * version id names no family, so its image goes under `image` unless
 * `imageInputName` says otherwise (`start_image` for a Kling version).
 *
 * ## API flow (submit + sync wait + optional poll)
 *
 * 1. **Create prediction**: `POST ${baseURL}/predictions` with
 *    `{ version, input }` and `Prefer: wait=60`. If the model finishes within
 *    60 seconds the response already contains the output.
 * 2. **Poll** (if needed): `GET prediction.urls.get` until `status` is
 *    `succeeded`, `failed`, or `canceled`.
 * 3. **Result**: `output` is the video URL (string or first array element).
 *
 * ## Authentication
 *
 * Requires a `REPLICATE_API_TOKEN`. Sent as `Authorization: Token ${apiKey}`.
 *
 * @see {@link IVideoGenerator} for the provider interface contract.
 * @see {@link ReplicateImageProvider} for the image counterpart.
 */

import type { IVideoGenerator } from '../IVideoGenerator.js';
import { ApiKeyPool } from '../../../../core/providers/ApiKeyPool.js';
import { addProviderInputs, getVideoProviderOptions, videoImageToUrl } from '../videoInputs.js';
import type {
  VideoGenerateRequest,
  ImageToVideoRequest,
  VideoResult,
} from '../types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Model used when neither the request nor the config names one. */
const DEFAULT_MODEL = 'kwaivgi/kling-v2.5-turbo-pro';

/**
 * Configuration for the Replicate video generation provider.
 *
 * @example
 * ```typescript
 * const config: ReplicateVideoProviderConfig = {
 *   apiKey: process.env.REPLICATE_API_TOKEN!,
 *   defaultModelId: 'google/veo-3.1',
 * };
 * ```
 */
export interface ReplicateVideoProviderConfig {
  /** Replicate API token. Sent as `Authorization: Token ${apiKey}`. */
  apiKey: string;

  /**
   * Base URL for the Replicate API. Override for testing or proxy setups.
   * @default 'https://api.replicate.com/v1'
   */
  baseURL?: string;

  /**
   * Default model to use when the request doesn't specify one: `owner/name`,
   * `owner/name:version` or a version id.
   * @default 'kwaivgi/kling-v2.5-turbo-pro'
   */
  defaultModelId?: string;

  /**
   * Milliseconds between prediction status polls.
   * @default 5000
   */
  pollIntervalMs?: number;

  /**
   * Maximum milliseconds to wait for generation before timing out.
   * @default 300000
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Replicate API response types
// ---------------------------------------------------------------------------

/**
 * Shape of a Replicate prediction object returned by the API.
 * @internal
 */
interface ReplicatePrediction {
  /** Prediction identifier. */
  id?: string;

  /** Current status: 'starting', 'processing', 'succeeded', 'failed', 'canceled'. */
  status?: string;

  /** Model version identifier. */
  version?: string;

  /** Generation output — typically a URL string or array of URLs. */
  output?: unknown;

  /** Error message on failure. */
  error?: string;

  /** Timing and billing metrics. */
  metrics?: Record<string, unknown>;

  /** Polling URLs. */
  urls?: {
    /** GET URL for polling this prediction's status. */
    get?: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sleep for the specified number of milliseconds.
 * Used between poll requests to avoid rate-limiting.
 * @param ms - Duration in milliseconds.
 * @internal
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The input name a model takes its source image under, from the model input
 * schemas on Replicate: Kling (`kwaivgi/kling-v2.1`,
 * `kwaivgi/kling-v2.5-turbo-pro`) takes `start_image`, MiniMax
 * (`minimax/hailuo-02`, `minimax/video-01`) takes `first_frame_image`, and
 * the others (`google/veo-3.1`, `wan-video/wan-2.2-i2v-fast`) take `image`.
 *
 * @param model - The model id, with or without a version.
 * @returns The input field name.
 * @internal
 */
function imageInputName(model: string): string {
  const name = model.toLowerCase();
  if (name.startsWith('kwaivgi/kling')) return 'start_image';
  if (name.startsWith('minimax/')) return 'first_frame_image';
  return 'image';
}

/**
 * Extract a video URL from the Replicate prediction output.
 *
 * Replicate returns output in different shapes depending on the model:
 * - A plain URL string
 * - An array of URL strings (first element is the video)
 * - An object with a `url` or `video` property
 *
 * @param output - Raw output from the prediction.
 * @returns The video URL string, or `undefined` if not found.
 * @internal
 */
function extractVideoUrl(output: unknown): string | undefined {
  if (typeof output === 'string') return output;

  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj.url === 'string') return obj.url;
        if (typeof obj.video === 'string') return obj.video;
      }
    }
    return undefined;
  }

  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    if (typeof obj.url === 'string') return obj.url;
    if (typeof obj.video === 'string') return obj.video;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Video generation provider connecting to the Replicate predictions API.
 *
 * Follows the same submit-then-poll pattern as {@link ReplicateImageProvider}:
 * create a prediction with `Prefer: wait=60`, then poll if the model takes
 * longer than the wait window.
 *
 * @implements {IVideoGenerator}
 *
 * @example
 * ```typescript
 * const provider = new ReplicateVideoProvider();
 * await provider.initialize({ apiKey: process.env.REPLICATE_API_TOKEN! });
 *
 * const result = await provider.generateVideo({
 *   modelId: 'google/veo-3.1',
 *   prompt: 'A butterfly emerging from a cocoon in slow motion',
 * });
 * console.log(result.videos[0].url);
 * ```
 */
export class ReplicateVideoProvider implements IVideoGenerator {
  /** @inheritdoc */
  public readonly providerId = 'replicate';

  /** @inheritdoc */
  public isInitialized = false;

  /** @inheritdoc */
  public defaultModelId?: string;

  /** Internal resolved configuration. */
  private _config!: Required<Pick<ReplicateVideoProviderConfig, 'apiKey' | 'baseURL' | 'pollIntervalMs' | 'timeoutMs'>> & ReplicateVideoProviderConfig;
  private keyPool!: ApiKeyPool;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the provider with API credentials and optional configuration.
   *
   * @param config - Configuration object. Must include `apiKey`.
   * @throws {Error} If `apiKey` is missing or empty.
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (!apiKey) {
      throw new Error('Replicate video provider requires apiKey (REPLICATE_API_TOKEN).');
    }

    this._config = {
      apiKey,
      baseURL:
        typeof config.baseURL === 'string' && config.baseURL.trim()
          ? config.baseURL.trim()
          : 'https://api.replicate.com/v1',
      defaultModelId:
        typeof config.defaultModelId === 'string' && config.defaultModelId.trim()
          ? config.defaultModelId.trim()
          : DEFAULT_MODEL,
      pollIntervalMs:
        typeof config.pollIntervalMs === 'number' && config.pollIntervalMs > 0
          ? config.pollIntervalMs
          : 5000,
      timeoutMs:
        typeof config.timeoutMs === 'number' && config.timeoutMs > 0
          ? config.timeoutMs
          : 300_000,
    };

    this.defaultModelId = this._config.defaultModelId;
    this.keyPool = new ApiKeyPool(apiKey);
    this.isInitialized = true;
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  /**
   * Generate a video from a text prompt using the Replicate predictions API.
   *
   * Creates a prediction, waits for synchronous completion (up to 60s), then
   * polls if still in progress. Returns the video URL in a result envelope.
   *
   * @param request - Video generation request with prompt and optional params.
   * @returns The generated video result envelope.
   *
   * @throws {Error} If the provider is not initialized.
   * @throws {Error} If the API returns an error or times out.
   */
  async generateVideo(request: VideoGenerateRequest): Promise<VideoResult> {
    if (!this.isInitialized) {
      throw new Error('Replicate video provider is not initialized. Call initialize() first.');
    }

    const model = request.modelId || this.defaultModelId || DEFAULT_MODEL;
    const prediction = await this._runPrediction(model, this._buildInput(model, request));
    return this._buildResult(prediction, model);
  }

  /**
   * Generate a video from a source image using the Replicate predictions API.
   *
   * The image goes under the input name the model takes (`start_image`,
   * `first_frame_image` or `image`): a URL as given, a `Buffer` as a `data:`
   * URL with the MIME type read from its first bytes.
   *
   * @param request - Generation parameters including the source image.
   * @returns The generated video result envelope.
   *
   * @throws {Error} If the provider is not initialized or the API fails.
   */
  async imageToVideo(request: ImageToVideoRequest): Promise<VideoResult> {
    if (!this.isInitialized) {
      throw new Error('Replicate video provider is not initialized. Call initialize() first.');
    }

    const model = request.modelId || this.defaultModelId || DEFAULT_MODEL;
    const input = this._buildInput(model, request, videoImageToUrl(request.image));
    const prediction = await this._runPrediction(model, input);
    return this._buildResult(prediction, model);
  }

  // -------------------------------------------------------------------------
  // Capability query
  // -------------------------------------------------------------------------

  /**
   * Replicate supports both text-to-video and image-to-video generation.
   *
   * @param capability - The capability to check.
   * @returns `true` for both `'text-to-video'` and `'image-to-video'`.
   */
  supports(capability: 'text-to-video' | 'image-to-video'): boolean {
    return capability === 'text-to-video' || capability === 'image-to-video';
  }

  /**
   * Release any resources held by the provider. No-op for HTTP-only providers.
   */
  async shutdown(): Promise<void> {
    this.isInitialized = false;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build the model input from the request's fields and provider options.
   *
   * @param model - Model identifier.
   * @param request - The text-to-video or image-to-video request.
   * @param imageUrl - The source image as a URL, for image-to-video.
   * @returns The prediction's `input`.
   * @internal
   */
  private _buildInput(
    model: string,
    request: VideoGenerateRequest | ImageToVideoRequest,
    imageUrl?: string,
  ): Record<string, unknown> {
    const input: Record<string, unknown> = {
      prompt: request.prompt,
    };

    // `imageInputName` names the source image's field; it is not a model
    // input. A bare version id names no model family, so it needs one.
    const { imageInputName: namedImageInput, ...extra } =
      getVideoProviderOptions(this.providerId, request.providerOptions) ?? {};
    const imageField =
      typeof namedImageInput === 'string' && namedImageInput.trim()
        ? namedImageInput.trim()
        : imageInputName(model);

    if (imageUrl !== undefined) input[imageField] = imageUrl;
    if (request.durationSec !== undefined) input.duration = request.durationSec;
    if (request.aspectRatio) input.aspect_ratio = request.aspectRatio;
    if (request.resolution) input.resolution = request.resolution;
    if (request.negativePrompt) input.negative_prompt = request.negativePrompt;
    if (request.seed !== undefined) input.seed = request.seed;
    if (request.referenceImages?.length) {
      input.reference_images = request.referenceImages.map(videoImageToUrl);
    }
    // Provider options add model inputs; they never replace the fields above.
    return addProviderInputs(input, extra);
  }

  /**
   * Create a prediction and wait for it to complete.
   *
   * Uses `Prefer: wait=60` to get synchronous completion for fast models.
   * Falls back to polling if the prediction hasn't completed within the
   * wait window.
   *
   * @param model - Model identifier (e.g. 'kwaivgi/kling-v2.5-turbo-pro').
   * @param input - Model input parameters.
   * @returns The completed prediction object.
   *
   * @throws {Error} If prediction creation fails, the prediction fails,
   *   is canceled, or times out.
   * @internal
   */
  private async _runPrediction(
    model: string,
    input: Record<string, unknown>,
  ): Promise<ReplicatePrediction> {
    let prediction = await this._createPrediction(model, input);

    // If the prediction hasn't reached a terminal state, poll for it.
    if (
      prediction.status
      && !['succeeded', 'failed', 'canceled'].includes(prediction.status)
      && prediction.urls?.get
    ) {
      prediction = await this._pollPrediction(prediction.urls.get);
    }

    if (prediction.status === 'failed') {
      throw new Error(`Replicate video generation failed: ${prediction.error ?? 'unknown error'}`);
    }
    if (prediction.status === 'canceled') {
      throw new Error('Replicate video generation was canceled.');
    }

    return prediction;
  }

  /**
   * Create a new prediction via `POST /predictions`.
   *
   * @param model - Model identifier.
   * @param input - Model input parameters.
   * @returns The prediction response (may or may not be completed).
   *
   * @throws {Error} If the HTTP request fails.
   * @internal
   */
  private async _createPrediction(
    model: string,
    input: Record<string, unknown>,
  ): Promise<ReplicatePrediction> {
    // predictions.create names the model in `version`: `owner/name` for an
    // official model, `owner/name:version`, or a bare version id.
    const body: Record<string, unknown> = {
      version: model,
      input,
    };

    const response = await fetch(`${this._config.baseURL}/predictions`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.keyPool.next()}`,
        'Content-Type': 'application/json',
        Prefer: 'wait=60',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Replicate video generation submission failed (${response.status}): ${errorText}`);
    }

    return (await response.json()) as ReplicatePrediction;
  }

  /**
   * Poll a prediction URL until it reaches a terminal state.
   *
   * @param url - The `prediction.urls.get` URL to poll.
   * @returns The completed prediction object.
   *
   * @throws {Error} If polling fails or times out.
   * @internal
   */
  private async _pollPrediction(url: string): Promise<ReplicatePrediction> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < this._config.timeoutMs) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Token ${this.keyPool.next()}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Replicate prediction polling failed (${response.status}): ${errorText}`);
      }

      const prediction = (await response.json()) as ReplicatePrediction;

      if (
        !prediction.status
        || ['succeeded', 'failed', 'canceled'].includes(prediction.status)
      ) {
        return prediction;
      }

      await sleep(this._config.pollIntervalMs);
    }

    throw new Error(
      `Replicate video generation timed out after ${this._config.timeoutMs}ms.`,
    );
  }

  /**
   * Build a {@link VideoResult} from a completed Replicate prediction.
   *
   * @param prediction - The succeeded prediction object.
   * @param model - Model ID used for the generation.
   * @returns Normalized video result envelope.
   *
   * @throws {Error} If no video URL could be extracted from the output.
   * @internal
   */
  private _buildResult(prediction: ReplicatePrediction, model: string): VideoResult {
    const videoUrl = extractVideoUrl(prediction.output);

    if (!videoUrl) {
      throw new Error('Replicate prediction succeeded but returned no video output.');
    }

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      videos: [{
        url: videoUrl,
        mimeType: 'video/mp4',
        providerMetadata: {
          predictionId: prediction.id,
          metrics: prediction.metrics,
        },
      }],
      usage: {
        totalVideos: 1,
      },
    };
  }
}
