/**
 * @module media/video/providers/FalVideoProvider
 *
 * Video generation provider for the Fal.ai serverless GPU platform.
 *
 * Fal.ai hosts video generation models (Kling, MiniMax Hailuo, Vidu, Wan,
 * HunyuanVideo, etc.) behind a queue-based API. This provider implements the
 * three-step pattern established by {@link FalImageProvider}: submit to queue,
 * poll for status, then fetch the completed result.
 *
 * ## Models
 *
 * The model id is the endpoint path, for example
 * `fal-ai/minimax/hailuo-02/standard/image-to-video`. With no model named,
 * text-to-video runs `fal-ai/kling-video/v2.5-turbo/pro/text-to-video` and
 * image-to-video runs `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`; a
 * configured `defaultModelId` replaces both. Each model's inputs are on its
 * fal.ai page, for example
 * https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video/api.
 *
 * ## Model inputs
 *
 * | Request field      | fal input              |
 * |--------------------|------------------------|
 * | `prompt`           | `prompt`               |
 * | `image`            | `image_url`            |
 * | `referenceImages`  | `reference_image_urls` |
 * | `durationSec`      | `duration`             |
 * | `aspectRatio`      | `aspect_ratio`         |
 * | `resolution`       | `resolution`           |
 * | `negativePrompt`   | `negative_prompt`      |
 * | `seed`             | `seed`                 |
 *
 * An image given as a URL is sent as given; a `Buffer` is sent as a `data:`
 * URL. Kling and MiniMax endpoints take `duration` as a string enum (`"5"`,
 * `"10"`; `"6"`, `"10"`), so it is sent as a string to models whose id holds
 * `kling-video` or `minimax`, and as a number to the others. `resolution` is
 * sent as given, in the model's own vocabulary (MiniMax takes `512P` or
 * `768P`). `providerOptions` (or their `fal` entry) add other inputs, such as
 * `end_image_url` or `tail_image_url`, and never replace the fields above.
 *
 * ## API flow (three-step queue)
 *
 * 1. **Submit**: `POST ${baseURL}/${model}` with the model input. Returns
 *    `{ request_id, status_url, response_url }`.
 * 2. **Poll**: `GET status_url` until `status === 'COMPLETED'`. A failed
 *    request also ends `COMPLETED`, with an `error` field, which is raised.
 * 3. **Fetch**: `GET response_url` returns `{ video: { url } }`.
 *
 * When `baseURL` is on another origin than the URLs fal returns (a gateway),
 * their paths are moved onto `baseURL`. When the submit response omits the
 * URLs they are built on the app path (the first two segments of the model
 * id): `${baseURL}/${owner}/${app}/requests/${request_id}[/status]`. Queue
 * reference: https://fal.ai/docs/api-reference/inference-api/queue/submit.md.
 *
 * ## Authentication
 *
 * Requires a `FAL_API_KEY`. Sent as `Authorization: Key ${apiKey}`.
 *
 * @see {@link IVideoGenerator} for the provider interface contract.
 * @see {@link FalImageProvider} for the image counterpart.
 */

import type { IVideoGenerator } from '../IVideoGenerator.js';
import type {
  VideoGenerateRequest,
  ImageToVideoRequest,
  VideoResult,
} from '../types.js';
import { ApiKeyPool } from '../../../../core/providers/ApiKeyPool.js';
import { addProviderInputs, getVideoProviderOptions, videoImageToUrl } from '../videoInputs.js';

/** Text-to-video model used when neither the request nor the config names one. */
const DEFAULT_TEXT_TO_VIDEO_MODEL = 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video';

/** Image-to-video model used when neither the request nor the config names one. */
const DEFAULT_IMAGE_TO_VIDEO_MODEL = 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Fal.ai video generation provider.
 *
 * @example
 * ```typescript
 * const config: FalVideoProviderConfig = {
 *   apiKey: process.env.FAL_API_KEY!,
 *   defaultModelId: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
 * };
 * ```
 */
export interface FalVideoProviderConfig {
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
   * Model for both text-to-video and image-to-video when the request doesn't
   * name one. When unset, text-to-video runs
   * `fal-ai/kling-video/v2.5-turbo/pro/text-to-video` and image-to-video runs
   * `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`.
   */
  defaultModelId?: string;

  /**
   * Milliseconds between status polls while waiting for generation.
   * @default 2000
   */
  pollIntervalMs?: number;

  /**
   * Maximum milliseconds to wait for generation before timing out.
   * @default 300000
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
  /** URL to poll for the request's status. */
  status_url?: string | null;
  /** URL of the request's result. */
  response_url?: string | null;
}

/**
 * The queue URLs for one submitted request.
 * @internal
 */
interface FalRequestUrls {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
}

/**
 * Response from the Fal.ai status polling endpoint.
 * @internal
 */
interface FalStatusResponse {
  /** Current status: 'IN_QUEUE', 'IN_PROGRESS' or 'COMPLETED'. */
  status: string;
  /** Error message; present only when the request failed. */
  error?: string;
  /** Error category; present only when the request failed. */
  error_type?: string;
}

/**
 * Response from the Fal.ai result endpoint (fetched after COMPLETED).
 * @internal
 */
interface FalVideoResultResponse {
  /** Generated video output. */
  video?: {
    /** URL to the generated video file. */
    url: string;
    /** MIME type of the video. */
    content_type?: string;
    /** Duration of the generated video in seconds. */
    duration?: number;
  };
  /** Random seed used for generation. */
  seed?: number;
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
 * Whether a model takes `duration` as a string enum. fal's Kling and MiniMax
 * endpoints declare `duration` as `"5" | "10"` and `"6" | "10"`, for example
 * https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/text-to-video/api
 * and https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/image-to-video/api.
 * @internal
 */
function takesStringDuration(model: string): boolean {
  return model.includes('kling-video') || model.includes('minimax');
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Video generation provider connecting to the Fal.ai serverless platform.
 *
 * Implements the three-step queue pattern: submit a generation task,
 * poll the status endpoint until completion, then fetch the result.
 * This mirrors the flow used by {@link FalImageProvider}.
 *
 * @implements {IVideoGenerator}
 *
 * @example
 * ```typescript
 * const provider = new FalVideoProvider();
 * await provider.initialize({ apiKey: process.env.FAL_API_KEY! });
 *
 * const result = await provider.generateVideo({
 *   modelId: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
 *   prompt: 'A time-lapse of flowers blooming in a meadow',
 * });
 * console.log(result.videos[0].url);
 * ```
 */
export class FalVideoProvider implements IVideoGenerator {
  /** @inheritdoc */
  public readonly providerId = 'fal';

  /** @inheritdoc */
  public isInitialized = false;

  /** @inheritdoc */
  public defaultModelId?: string;

  /** Internal resolved configuration. */
  private _config!: Required<Pick<FalVideoProviderConfig, 'apiKey' | 'baseURL' | 'pollIntervalMs' | 'timeoutMs'>> & FalVideoProviderConfig;
  private keyPool!: ApiKeyPool;
  /** The model the config names for both capabilities, when it names one. */
  private _configuredModel?: string;

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
      throw new Error('Fal.ai video provider requires apiKey (FAL_API_KEY).');
    }

    this._configuredModel =
      typeof config.defaultModelId === 'string' && config.defaultModelId.trim()
        ? config.defaultModelId.trim()
        : undefined;

    this._config = {
      apiKey,
      baseURL:
        typeof config.baseURL === 'string' && config.baseURL.trim()
          ? config.baseURL.trim()
          : 'https://queue.fal.run',
      defaultModelId: this._configuredModel ?? DEFAULT_TEXT_TO_VIDEO_MODEL,
      pollIntervalMs:
        typeof config.pollIntervalMs === 'number' && config.pollIntervalMs > 0
          ? config.pollIntervalMs
          : 2000,
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
   * Generate a video from a text prompt using the Fal.ai queue API.
   *
   * Submits the task, polls until complete, then fetches the result.
   *
   * @param request - Video generation request with prompt and optional params.
   * @returns The generated video result envelope.
   *
   * @throws {Error} If the provider is not initialized.
   * @throws {Error} If the API returns an error or times out.
   */
  async generateVideo(request: VideoGenerateRequest): Promise<VideoResult> {
    if (!this.isInitialized) {
      throw new Error('Fal.ai video provider is not initialized. Call initialize() first.');
    }

    const model = request.modelId || this._configuredModel || DEFAULT_TEXT_TO_VIDEO_MODEL;
    return this._generate(model, request);
  }

  /**
   * Generate a video from a source image using the Fal.ai queue API.
   *
   * The image goes as `image_url`: a URL as given, a `Buffer` as a `data:` URL
   * with the MIME type read from its first bytes.
   *
   * @param request - Generation parameters including the source image.
   * @returns The generated video result envelope.
   *
   * @throws {Error} If the provider is not initialized or the API fails.
   */
  async imageToVideo(request: ImageToVideoRequest): Promise<VideoResult> {
    if (!this.isInitialized) {
      throw new Error('Fal.ai video provider is not initialized. Call initialize() first.');
    }

    const model = request.modelId || this._configuredModel || DEFAULT_IMAGE_TO_VIDEO_MODEL;
    return this._generate(model, request, videoImageToUrl(request.image));
  }

  // -------------------------------------------------------------------------
  // Capability query
  // -------------------------------------------------------------------------

  /**
   * Fal.ai supports both text-to-video and image-to-video generation.
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
   * Build the model input and run the queue flow: submit, poll, fetch.
   *
   * @param model - Full model path (e.g. 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video').
   * @param request - The text-to-video or image-to-video request.
   * @param imageUrl - The source image as a URL, for image-to-video.
   * @returns Normalized video result envelope.
   * @internal
   */
  private async _generate(
    model: string,
    request: VideoGenerateRequest | ImageToVideoRequest,
    imageUrl?: string,
  ): Promise<VideoResult> {
    const body: Record<string, unknown> = {
      prompt: request.prompt,
    };

    if (imageUrl !== undefined) body.image_url = imageUrl;
    if (request.durationSec !== undefined) {
      body.duration = takesStringDuration(model) ? String(request.durationSec) : request.durationSec;
    }
    if (request.aspectRatio) body.aspect_ratio = request.aspectRatio;
    if (request.resolution) body.resolution = request.resolution;
    if (request.negativePrompt) body.negative_prompt = request.negativePrompt;
    if (request.seed !== undefined) body.seed = request.seed;
    if (request.referenceImages?.length) {
      body.reference_image_urls = request.referenceImages.map(videoImageToUrl);
    }
    // Provider options add model inputs; they never replace the fields above.
    addProviderInputs(body, getVideoProviderOptions(this.providerId, request.providerOptions));

    // Three-step flow: submit -> poll -> fetch
    const urls = await this._submitTask(model, body);
    await this._pollStatus(urls);
    const result = await this._fetchResult(urls);

    return this._buildResult(result, model, urls.requestId);
  }

  /**
   * Submit a generation task to the Fal.ai queue.
   *
   * @param model - Full model path.
   * @param body - Model input.
   * @returns The request id and the status and result URLs.
   *
   * @throws {Error} If the submission request fails.
   * @internal
   */
  private async _submitTask(model: string, body: Record<string, unknown>): Promise<FalRequestUrls> {
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
      throw new Error(`Fal.ai video generation submission failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as FalSubmitResponse;
    if (!data.request_id) {
      throw new Error('Fal.ai submission response missing request_id.');
    }

    // Status and result live on the app path, without any endpoint sub-path.
    const appPath = model.split('/').slice(0, 2).join('/');
    const requestBase = `${this._config.baseURL}/${appPath}/requests/${data.request_id}`;

    return {
      requestId: data.request_id,
      statusUrl: this._onBaseURL(data.status_url) ?? `${requestBase}/status`,
      responseUrl: this._onBaseURL(data.response_url) ?? requestBase,
    };
  }

  /**
   * Keep a queue URL on the configured base URL. fal answers with its own
   * host; when `baseURL` points at a gateway on another origin, the URL's path
   * is moved onto `baseURL` so the polls and the result fetch go through it.
   *
   * @param url - A URL from the submit response.
   * @returns The URL to request, or `undefined` when none was given.
   * @internal
   */
  private _onBaseURL(url: string | null | undefined): string | undefined {
    if (!url) return undefined;
    try {
      const target = new URL(url);
      if (target.origin === new URL(this._config.baseURL).origin) return url;
      return `${this._config.baseURL.replace(/\/+$/, '')}${target.pathname}${target.search}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Poll the Fal.ai status endpoint until the task completes or times out.
   *
   * @param urls - The request's queue URLs.
   *
   * @throws {Error} If the generation fails or times out.
   * @internal
   */
  private async _pollStatus(urls: FalRequestUrls): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < this._config.timeoutMs) {
      const response = await fetch(urls.statusUrl, {
        headers: {
          Authorization: `Key ${this.keyPool.next()}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Fal.ai status polling failed (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as FalStatusResponse;

      if (data.status === 'COMPLETED' || data.status === 'FAILED') {
        if (data.error || data.status === 'FAILED') {
          const reason = data.error ? `: ${data.error}` : '.';
          const kind = data.error_type ? ` [${data.error_type}]` : '';
          throw new Error(`Fal.ai video generation failed for request ${urls.requestId}${kind}${reason}`);
        }
        return;
      }

      // 'IN_QUEUE' or 'IN_PROGRESS' — wait before next poll
      await sleep(this._config.pollIntervalMs);
    }

    throw new Error(
      `Fal.ai video generation timed out after ${this._config.timeoutMs}ms for request ${urls.requestId}.`,
    );
  }

  /**
   * Fetch the completed generation result from the request's result URL.
   *
   * @param urls - The request's queue URLs.
   * @returns The generation result with video URL.
   *
   * @throws {Error} If the result fetch fails.
   * @internal
   */
  private async _fetchResult(urls: FalRequestUrls): Promise<FalVideoResultResponse> {
    const response = await fetch(urls.responseUrl, {
      headers: {
        Authorization: `Key ${this.keyPool.next()}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Fal.ai result fetch failed (${response.status}): ${errorText}`);
    }

    return (await response.json()) as FalVideoResultResponse;
  }

  /**
   * Build a {@link VideoResult} from a completed Fal.ai result.
   *
   * @param result - The Fal.ai result response.
   * @param model - Model ID used for the generation.
   * @param requestId - The queue request id.
   * @returns Normalized video result envelope.
   *
   * @throws {Error} If the result has no video URL.
   * @internal
   */
  private _buildResult(result: FalVideoResultResponse, model: string, requestId: string): VideoResult {
    if (!result.video?.url) {
      throw new Error('Fal.ai generation completed but returned no video output.');
    }

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      videos: [{
        url: result.video.url,
        mimeType: result.video.content_type ?? 'video/mp4',
        durationSec: result.video.duration,
        providerMetadata: {
          requestId,
          seed: result.seed,
        },
      }],
      usage: {
        totalVideos: 1,
      },
    };
  }
}
