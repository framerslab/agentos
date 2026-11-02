/**
 * @module media/video/providers/RunwayVideoProvider
 *
 * Video generation provider for the Runway Gen-3 Alpha API.
 *
 * Runway offers high-quality AI video generation with both text-to-video
 * and image-to-video capabilities. This provider implements the submit-then-
 * poll pattern: a generation task is created via POST, then polled via GET
 * until the task reaches a terminal state.
 *
 * ## Supported models
 *
 * | Model ID       | Description                            |
 * |----------------|----------------------------------------|
 * | `gen3a_turbo`  | Gen-3 Alpha Turbo — fast, lower cost   |
 * | `gen3a`        | Gen-3 Alpha — highest quality          |
 *
 * ## API flow
 *
 * 1. **Submit** — `POST ${baseURL}/text_to_video` or `/image_to_video`.
 *    Returns a task object with `{ id }`.
 * 2. **Poll** — `GET ${baseURL}/tasks/${id}` until `status` is
 *    `SUCCEEDED` or `FAILED`.
 * 3. **Result** — `output[0]` on the SUCCEEDED task is the video URL.
 *
 * ## Authentication
 *
 * Requires a `RUNWAY_API_KEY`. Sent as `Authorization: Bearer ${apiKey}`.
 *
 * @see {@link IVideoGenerator} for the provider interface contract.
 */

import type { IVideoGenerator } from '../IVideoGenerator.js';
import { ApiKeyPool } from '../../../../core/providers/ApiKeyPool.js';
import { videoImageToUrl } from '../videoInputs.js';
import type {
  VideoGenerateRequest,
  ImageToVideoRequest,
  VideoResult,
} from '../types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Runway video generation provider.
 *
 * @example
 * ```typescript
 * const config: RunwayVideoProviderConfig = {
 *   apiKey: process.env.RUNWAY_API_KEY!,
 *   defaultModelId: 'gen3a_turbo',
 * };
 * ```
 */
export interface RunwayVideoProviderConfig {
  /** Runway API key. Sent as `Authorization: Bearer ${apiKey}`. */
  apiKey: string;

  /**
   * Base URL for the Runway API. Override for testing or proxy setups.
   * @default 'https://api.dev.runwayml.com/v1'
   */
  baseURL?: string;

  /**
   * Default model to use when the request doesn't specify one.
   * @default 'gen3a_turbo'
   */
  defaultModelId?: string;

  /**
   * Milliseconds between task status polls.
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
// Runway API response types
// ---------------------------------------------------------------------------

/**
 * Response from a Runway task creation endpoint.
 * @internal
 */
interface RunwayTaskResponse {
  /** Unique task identifier for polling. */
  id: string;
}

/**
 * Response from the Runway task status endpoint.
 * @internal
 */
interface RunwayTaskStatus {
  /** Task identifier. */
  id: string;

  /** Current status: 'PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED'. */
  status: string;

  /** Video output URLs when the task has succeeded. */
  output?: string[];

  /** Error details when the task has failed. */
  failure?: string;

  /** Human-readable failure reason. */
  failureCode?: string;
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

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Video generation provider connecting to the Runway Gen-3 Alpha API.
 *
 * Implements the submit-then-poll pattern: a generation request returns
 * a task ID immediately, and the provider polls the status endpoint
 * until completion or timeout.
 *
 * @implements {IVideoGenerator}
 *
 * @example
 * ```typescript
 * const provider = new RunwayVideoProvider();
 * await provider.initialize({ apiKey: process.env.RUNWAY_API_KEY! });
 *
 * const result = await provider.generateVideo({
 *   modelId: 'gen3a_turbo',
 *   prompt: 'A cinematic drone shot over a misty forest at dawn',
 *   durationSec: 5,
 *   aspectRatio: '16:9',
 * });
 * console.log(result.videos[0].url);
 * ```
 */
export class RunwayVideoProvider implements IVideoGenerator {
  /** @inheritdoc */
  public readonly providerId = 'runway';

  /** @inheritdoc */
  public isInitialized = false;

  /** @inheritdoc */
  public defaultModelId?: string;

  /** Internal resolved configuration. */
  private _config!: Required<Pick<RunwayVideoProviderConfig, 'apiKey' | 'baseURL' | 'pollIntervalMs' | 'timeoutMs'>> & RunwayVideoProviderConfig;
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
      throw new Error('Runway video provider requires apiKey (RUNWAY_API_KEY).');
    }

    this._config = {
      apiKey,
      baseURL:
        typeof config.baseURL === 'string' && config.baseURL.trim()
          ? config.baseURL.trim()
          : 'https://api.dev.runwayml.com/v1',
      defaultModelId:
        typeof config.defaultModelId === 'string' && config.defaultModelId.trim()
          ? config.defaultModelId.trim()
          : 'gen3a_turbo',
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
   * Generate a video from a text prompt using the Runway text_to_video endpoint.
   *
   * Submits the task, polls until completion, and returns the video result.
   *
   * @param request - Video generation request with prompt and optional params.
   * @returns The generated video result envelope.
   *
   * @throws {Error} If the provider is not initialized.
   * @throws {Error} If the API returns an error or times out.
   */
  async generateVideo(request: VideoGenerateRequest): Promise<VideoResult> {
    if (!this.isInitialized) {
      throw new Error('Runway video provider is not initialized. Call initialize() first.');
    }

    const model = request.modelId || this.defaultModelId || 'gen3a_turbo';

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
    };

    if (request.durationSec !== undefined) body.duration = request.durationSec;
    if (request.aspectRatio) body.ratio = request.aspectRatio;

    // Step 1: Submit
    const taskId = await this._submitTask('text_to_video', body);

    // Step 2: Poll until done
    const task = await this._pollTask(taskId);

    // Step 3: Extract result
    return this._buildResult(task, model);
  }

  /**
   * Generate a video from a source image using the Runway image_to_video endpoint.
   *
   * An image given as a URL is sent as given; a `Buffer` is sent as a
   * `data:` URL with the MIME type read from its first bytes.
   *
   * @param request - Generation parameters including the source image buffer.
   * @returns The generated video result envelope.
   *
   * @throws {Error} If the provider is not initialized or the API fails.
   */
  async imageToVideo(request: ImageToVideoRequest): Promise<VideoResult> {
    if (!this.isInitialized) {
      throw new Error('Runway video provider is not initialized. Call initialize() first.');
    }

    const model = request.modelId || this.defaultModelId || 'gen3a_turbo';

    const body: Record<string, unknown> = {
      model,
      prompt_image: videoImageToUrl(request.image),
    };

    if (request.prompt) body.prompt = request.prompt;
    if (request.durationSec !== undefined) body.duration = request.durationSec;
    if (request.aspectRatio) body.ratio = request.aspectRatio;

    // Step 1: Submit
    const taskId = await this._submitTask('image_to_video', body);

    // Step 2: Poll until done
    const task = await this._pollTask(taskId);

    // Step 3: Extract result
    return this._buildResult(task, model);
  }

  // -------------------------------------------------------------------------
  // Capability query
  // -------------------------------------------------------------------------

  /**
   * Runway supports both text-to-video and image-to-video generation.
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
   * Submit a generation task to the Runway API.
   *
   * @param endpoint - API endpoint path ('text_to_video' or 'image_to_video').
   * @param body - Request body with model, prompt, and generation params.
   * @returns The task ID for status polling.
   *
   * @throws {Error} If the submission request fails.
   * @internal
   */
  private async _submitTask(endpoint: string, body: Record<string, unknown>): Promise<string> {
    const url = `${this._config.baseURL}/${endpoint}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.keyPool.next()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Runway video generation submission failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as RunwayTaskResponse;
    if (!data.id) {
      throw new Error('Runway submission response missing task id.');
    }

    return data.id;
  }

  /**
   * Poll the Runway task status endpoint until the task reaches a terminal state.
   *
   * @param taskId - The task ID from submission.
   * @returns The completed task status object.
   *
   * @throws {Error} If the task fails or polling times out.
   * @internal
   */
  private async _pollTask(taskId: string): Promise<RunwayTaskStatus> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < this._config.timeoutMs) {
      const url = `${this._config.baseURL}/tasks/${taskId}`;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.keyPool.next()}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Runway task polling failed (${response.status}): ${errorText}`);
      }

      const task = (await response.json()) as RunwayTaskStatus;

      if (task.status === 'SUCCEEDED') {
        return task;
      }

      if (task.status === 'FAILED') {
        const reason = task.failure || task.failureCode || 'unknown error';
        throw new Error(`Runway video generation failed: ${reason}`);
      }

      await sleep(this._config.pollIntervalMs);
    }

    throw new Error(
      `Runway video generation timed out after ${this._config.timeoutMs}ms for task ${taskId}.`,
    );
  }

  /**
   * Build a {@link VideoResult} from a completed Runway task.
   *
   * @param task - The SUCCEEDED task status object.
   * @param model - Model ID used for the generation.
   * @returns Normalized video result envelope.
   *
   * @throws {Error} If the task has no output URLs.
   * @internal
   */
  private _buildResult(task: RunwayTaskStatus, model: string): VideoResult {
    if (!task.output || task.output.length === 0) {
      throw new Error('Runway task succeeded but returned no video output.');
    }

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      videos: task.output.map((url) => ({
        url,
        mimeType: 'video/mp4',
        providerMetadata: {
          taskId: task.id,
        },
      })),
      usage: {
        totalVideos: task.output.length,
      },
    };
  }
}
