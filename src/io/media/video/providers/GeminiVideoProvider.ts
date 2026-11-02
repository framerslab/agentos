/**
 * @module media/video/providers/GeminiVideoProvider
 *
 * Video generation provider for the Gemini API, running Gemini Omni Flash
 * (`gemini-omni-1.1-flash`) on the Interactions API.
 *
 * Google shut down the Veo models in the Gemini API (`veo-3.0-*` on 30 June
 * 2026, the `veo-3.1-*-preview` models on 22 October 2026) and names
 * `gemini-omni-1.1-flash` as their replacement
 * (https://ai.google.dev/gemini-api/docs/deprecations). Omni Flash generates
 * video through `POST /v1beta/interactions` rather than `predictLongRunning`
 * (https://ai.google.dev/gemini-api/docs/omni).
 *
 * ## Request
 *
 * `POST ${baseURL}/interactions` with the key in the `x-goog-api-key` header:
 *
 * ```json
 * {
 *   "store": false,
 *   "model": "gemini-omni-1.1-flash",
 *   "input": [
 *     { "type": "image", "data": "<base64>", "mime_type": "image/png" },
 *     { "type": "text", "text": "The figure walks toward the camera" }
 *   ],
 *   "response_format": { "type": "video", "aspect_ratio": "9:16", "resolution": "1080p" },
 *   "generation_config": { "video_config": { "task": "image_to_video" } }
 * }
 * ```
 *
 * - A prompt with no images is sent as the `input` string.
 * - The source image comes first, then the reference images, then the prompt
 *   as a text part. The task is `image_to_video` with a source image and
 *   `reference_to_video` with reference images alone.
 * - Images are sent inline. A `Buffer` is sent with the MIME type read from
 *   its first bytes; a `data:` URL is split into its MIME type and data; an
 *   `https://` URL is fetched with `globalThis.fetch` (without the API key)
 *   and its bytes are sent; the URL is trusted as the caller's own, so a host
 *   that passes an address a person typed checks it first.
 *   A Gemini Files API URI (`https://generativelanguage.googleapis.com/...`)
 *   goes as a `uri` part.
 * - `aspectRatio` (`16:9`, `9:16`) and `resolution` (`360p`, `720p`, `1080p`,
 *   `4k`) go in `response_format`. The Omni guide documents no duration or
 *   seed field and says negative prompts are not supported, so
 *   `durationSec`, `negativePrompt` and `seed` are not sent; put durations
 *   and things to avoid in the prompt.
 * - `store: false` asks for synchronous generation, as the Omni guide
 *   recommends; `providerOptions` may set it.
 * - `providerOptions` (or their `gemini` entry) add body fields, and their
 *   `response_format` and `generation_config` objects are merged key by key.
 *   They never replace the model, the input, `response_format.type` or a
 *   format or task the call sets.
 *
 * ## Response
 *
 * The interaction's `model_output` step holds the video part:
 * `{ "type": "video", "mime_type": "video/mp4", "data": "<base64>" }`, or a
 * `uri` when `providerOptions` ask for `response_format.delivery: 'uri'`,
 * which the Omni guide recommends for videos over 4 MB. The URI names a Files
 * API file: poll it until its state is `ACTIVE`, then download it with the
 * API key in the `x-goog-api-key` header. An interaction whose `status` is
 * not `completed` is raised with its error message.
 *
 * ## Deadline
 *
 * One `AbortSignal.timeout(timeoutMs)` covers every request of a call (the
 * image fetches and the interaction), so a stalled connection ends the call
 * at the deadline.
 *
 * @see {@link IVideoGenerator} for the provider interface contract.
 */

import type { IVideoGenerator } from '../IVideoGenerator.js';
import type {
  ImageToVideoRequest,
  VideoGenerateRequest,
  VideoImageInput,
  VideoResult,
  GeneratedVideo,
} from '../types.js';
import { ApiKeyPool } from '../../../../core/providers/ApiKeyPool.js';
import { getVideoProviderOptions, isPlainRecord, sniffImageMimeType } from '../videoInputs.js';

/** Model used when neither the request nor the config names one. */
const DEFAULT_MODEL = 'gemini-omni-1.1-flash';

/** Host of the Gemini API, whose Files API URIs are sent as `uri` parts. */
const GEMINI_API_HOST = 'generativelanguage.googleapis.com';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Gemini video provider.
 *
 * @example
 * ```typescript
 * const config: GeminiVideoProviderConfig = {
 *   apiKey: process.env.GEMINI_API_KEY!,
 *   timeoutMs: 600_000,
 * };
 * ```
 */
export interface GeminiVideoProviderConfig {
  /** Gemini API key, sent in the `x-goog-api-key` header. A comma-separated list is used in turn. */
  apiKey: string;

  /**
   * Base URL of the Gemini API.
   * @default 'https://generativelanguage.googleapis.com/v1beta'
   */
  baseURL?: string;

  /**
   * Model to run when the request doesn't name one.
   * @default 'gemini-omni-1.1-flash'
   */
  defaultModelId?: string;

  /**
   * Deadline in milliseconds for one generation call, across its image
   * fetches and the interaction.
   * @default 300000
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Interactions API shapes
// ---------------------------------------------------------------------------

/**
 * One content part of an interaction's input or output.
 * @internal
 */
interface GeminiContentPart {
  type?: string;
  text?: string;
  data?: string;
  uri?: string;
  mime_type?: string;
}

/**
 * The interaction object the API returns.
 * @internal
 */
interface GeminiInteraction {
  id?: string;
  status?: string;
  steps?: Array<{ type?: string; content?: GeminiContentPart[] }>;
  error?: { message?: string; code?: number | string };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Video generation provider for Gemini Omni Flash on the Gemini
 * Interactions API.
 *
 * @implements {IVideoGenerator}
 *
 * @example
 * ```typescript
 * const provider = new GeminiVideoProvider();
 * await provider.initialize({ apiKey: process.env.GEMINI_API_KEY! });
 *
 * const result = await provider.imageToVideo({
 *   prompt: 'The lantern swings in the wind',
 *   image: 'https://cdn.example.com/lantern.png',
 *   aspectRatio: '9:16',
 *   resolution: '1080p',
 * });
 * fs.writeFileSync('lantern.mp4', Buffer.from(result.videos[0].base64!, 'base64'));
 * ```
 */
export class GeminiVideoProvider implements IVideoGenerator {
  /** @inheritdoc */
  public readonly providerId = 'gemini';

  /** @inheritdoc */
  public isInitialized = false;

  /** @inheritdoc */
  public defaultModelId?: string;

  /** Internal resolved configuration. */
  private _config!: Required<GeminiVideoProviderConfig>;
  private keyPool!: ApiKeyPool;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the provider with an API key and optional configuration.
   *
   * @param config - Configuration object. Must include `apiKey`.
   * @throws {Error} If `apiKey` is missing or empty.
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (!apiKey) {
      throw new Error('Gemini video provider requires apiKey (GEMINI_API_KEY).');
    }

    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;

    this._config = {
      apiKey,
      baseURL: (text(config.baseURL) ?? text(config.baseUrl) ?? 'https://generativelanguage.googleapis.com/v1beta')
        .replace(/\/+$/, ''),
      defaultModelId: text(config.defaultModelId) ?? DEFAULT_MODEL,
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
   * Generate a video from a text prompt, with reference images when the
   * request gives them.
   *
   * @param request - Video generation request.
   * @returns The generated video result envelope.
   *
   * @throws {Error} If the provider is not initialized, the API refuses the
   *   request, the interaction does not complete, or the deadline passes.
   */
  async generateVideo(request: VideoGenerateRequest): Promise<VideoResult> {
    return this._generate(request);
  }

  /**
   * Generate a video from a source image (the first frame) and a prompt.
   *
   * @param request - Generation parameters including the source image.
   * @returns The generated video result envelope.
   *
   * @throws {Error} If the provider is not initialized, the API refuses the
   *   request, the interaction does not complete, or the deadline passes.
   */
  async imageToVideo(request: ImageToVideoRequest): Promise<VideoResult> {
    return this._generate(request, request.image);
  }

  // -------------------------------------------------------------------------
  // Capability query
  // -------------------------------------------------------------------------

  /**
   * Gemini Omni Flash supports both text-to-video and image-to-video.
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
   * Build the interaction, send it under the call's deadline and read the
   * video from the response.
   *
   * @param request - The text-to-video or image-to-video request.
   * @param sourceImage - The first frame, for image-to-video.
   * @returns Normalized video result envelope.
   * @internal
   */
  private async _generate(
    request: VideoGenerateRequest | ImageToVideoRequest,
    sourceImage?: VideoImageInput,
  ): Promise<VideoResult> {
    if (!this.isInitialized) {
      throw new Error('Gemini video provider is not initialized. Call initialize() first.');
    }

    const model = request.modelId || this._config.defaultModelId;
    const timeoutMs = this._config.timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);

    try {
      const images: GeminiContentPart[] = [];
      if (sourceImage !== undefined) images.push(await this._imagePart(sourceImage, signal));
      for (const reference of request.referenceImages ?? []) {
        images.push(await this._imagePart(reference, signal));
      }

      const body = this._buildBody(request, model, images, sourceImage !== undefined);
      const response = await fetch(`${this._config.baseURL}/interactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.keyPool.next(),
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini video generation request failed (${response.status}): ${errorText}`);
      }

      const interaction = (await response.json()) as GeminiInteraction;
      return this._buildResult(interaction, model);
    } catch (error) {
      if (signal.aborted) {
        throw new Error(`Gemini video generation timed out after ${timeoutMs}ms.`);
      }
      throw error;
    }
  }

  /**
   * Build the Interactions API request body.
   *
   * @param request - The video request.
   * @param model - The model to run.
   * @param images - The image parts, source image first.
   * @param hasSourceImage - Whether the first image is the source image.
   * @returns The JSON body.
   * @internal
   */
  private _buildBody(
    request: VideoGenerateRequest | ImageToVideoRequest,
    model: string,
    images: GeminiContentPart[],
    hasSourceImage: boolean,
  ): Record<string, unknown> {
    const extra = getVideoProviderOptions(this.providerId, request.providerOptions) ?? {};
    const {
      model: _model,
      input: _input,
      response_format: extraFormat,
      generation_config: extraConfig,
      ...rest
    } = extra;

    const body: Record<string, unknown> = {
      store: false,
      ...rest,
      model,
      input: images.length > 0 ? [...images, { type: 'text', text: request.prompt }] : request.prompt,
      response_format: {
        ...(isPlainRecord(extraFormat) ? extraFormat : {}),
        type: 'video',
        ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
        ...(request.resolution ? { resolution: request.resolution } : {}),
      },
    };

    const task = hasSourceImage ? 'image_to_video' : images.length > 0 ? 'reference_to_video' : undefined;
    const generationConfig: Record<string, unknown> = isPlainRecord(extraConfig) ? { ...extraConfig } : {};
    if (task) {
      const videoConfig = isPlainRecord(generationConfig.video_config) ? generationConfig.video_config : {};
      generationConfig.video_config = { ...videoConfig, task };
    }
    if (Object.keys(generationConfig).length > 0) body.generation_config = generationConfig;

    return body;
  }

  /**
   * Turn one image into an input part.
   *
   * @param image - Bytes, a `data:` URL, an `https://` URL or a Files API URI.
   * @param signal - The call's deadline.
   * @returns The image part.
   * @internal
   */
  private async _imagePart(image: VideoImageInput, signal: AbortSignal): Promise<GeminiContentPart> {
    if (typeof image !== 'string') {
      const bytes = Buffer.isBuffer(image) ? image : Buffer.from(image as Uint8Array);
      return { type: 'image', data: bytes.toString('base64'), mime_type: sniffImageMimeType(bytes) };
    }

    const value = image.trim();
    if (value.startsWith('data:')) {
      const match = /^data:([^;,]+)(?:;[^,;]+)*;base64,(.*)$/s.exec(value);
      if (!match) {
        throw new Error('Gemini video provider takes a data: URL image only when it is base64 encoded.');
      }
      return { type: 'image', data: match[2], mime_type: match[1] };
    }

    let url: URL | undefined;
    try {
      url = new URL(value);
    } catch {
      url = undefined;
    }
    if (!url || url.hostname === GEMINI_API_HOST || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      return { type: 'image', uri: value };
    }

    // The image's own host gets a plain GET: the API key is never sent to it.
    const response = await fetch(value, { signal });
    if (!response.ok) {
      throw new Error(`Gemini video provider could not read the image ${value} (${response.status}).`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const declared = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    return {
      type: 'image',
      data: bytes.toString('base64'),
      mime_type: declared && declared.startsWith('image/') ? declared : sniffImageMimeType(bytes),
    };
  }

  /**
   * Read the video parts from a finished interaction.
   *
   * @param interaction - The interaction the API returned.
   * @param model - The model that ran.
   * @returns Normalized video result envelope.
   *
   * @throws {Error} If the interaction did not complete or holds no video.
   * @internal
   */
  private _buildResult(interaction: GeminiInteraction, model: string): VideoResult {
    if (interaction.status && interaction.status !== 'completed') {
      const reason = interaction.error?.message ? `: ${interaction.error.message}` : '.';
      throw new Error(`Gemini video generation ended with status ${interaction.status}${reason}`);
    }

    const videos: GeneratedVideo[] = [];
    for (const step of interaction.steps ?? []) {
      if (step?.type !== 'model_output') continue;
      for (const part of step.content ?? []) {
        if (part?.type !== 'video' || (!part.data && !part.uri)) continue;
        videos.push({
          ...(part.data ? { base64: part.data } : { url: part.uri }),
          mimeType: part.mime_type ?? 'video/mp4',
          providerMetadata: { interactionId: interaction.id },
        });
      }
    }

    if (videos.length === 0) {
      throw new Error(
        `Gemini video generation returned no video (interaction ${interaction.id ?? 'unknown'}).`,
      );
    }

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      videos,
      usage: {
        totalVideos: videos.length,
      },
    };
  }
}
