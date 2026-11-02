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
 *   its first bytes; a `data:` URL is decoded (base64 or percent-encoded)
 *   into its MIME type and data; an image URL is fetched through the checked
 *   egress path (`safety/egress`, without the API key) and its bytes are
 *   sent. A Gemini Files API URI (`https://generativelanguage.googleapis.com/...`)
 *   goes as a `uri` part.
 * - Image fetches run under the hosted egress profile by default: `https` on
 *   port 443 to a name whose every address is public, checked before the
 *   connection opens and pinned to the checked address. A redirect is
 *   followed (up to 3) only after its target passes the same check. The
 *   bytes read in one call's image fetches, redirect bodies included, may
 *   total `maxImageBytes` (20 MiB by default).
 *   `imageEgress: { profile: 'local' }` allows `http` and private addresses,
 *   for a developer's own machine.
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
 *   format or task the call sets. `background: true` is refused before any
 *   request: the provider reads the interaction the create call returns and
 *   does not poll a background one.
 *
 * ## Response
 *
 * The interaction's `model_output` step holds the video part:
 * `{ "type": "video", "mime_type": "video/mp4", "data": "<base64>" }`, or a
 * `uri` when `providerOptions` ask for `response_format.delivery: 'uri'`,
 * which the Omni guide recommends for videos over 4 MB. The URI names a Files
 * API file, which the provider polls (`GET ${baseURL}/files/{id}`, every
 * `pollIntervalMs`) until its `state` is `ACTIVE` and then downloads
 * (`GET ${baseURL}/files/{id}:download?alt=media`), both with the key in the
 * `x-goog-api-key` header
 * (https://ai.google.dev/gemini-api/docs/omni#retrieving-videos-with-an-uri);
 * the video is returned as `base64`, with the URI in
 * `providerMetadata.fileUri`. A file whose state is `FAILED` is raised. An
 * interaction whose `status` is not `completed` is raised with the messages
 * of the faults its `errors` list records, and one with no `status` is
 * raised as well.
 *
 * ## Deadline
 *
 * One `AbortSignal.timeout(timeoutMs)` covers every request of a call (the
 * image fetches, the interaction, the file polls and the download), so a
 * stalled connection ends the call at the deadline.
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
import {
  checkedRequest,
  EgressRefusedError,
  hostedEgressPolicy,
  localEgressPolicy,
  type AddressLookup,
  type EgressConnector,
  type EgressPolicy,
  type EgressProfile,
} from '../../../../safety/egress/CheckedEgress.js';
import { getVideoProviderOptions, isPlainRecord, sniffImageMimeType } from '../videoInputs.js';

/** Model used when neither the request nor the config names one. */
const DEFAULT_MODEL = 'gemini-omni-1.1-flash';

/** Host of the Gemini API, whose Files API URIs are sent as `uri` parts. */
const GEMINI_API_HOST = 'generativelanguage.googleapis.com';

/** The most bytes the images fetched by URL in one call may total. */
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** The longest timer Node keeps: a longer one fires after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** The most redirects one image fetch follows. */
const MAX_IMAGE_REDIRECTS = 3;

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
   * fetches, the interaction and the download of a video delivered by URI.
   * A fractional value is rounded up to whole milliseconds; a value past
   * 2147483647 (the longest timer Node keeps) is refused at `initialize()`.
   * @default 300000
   */
  timeoutMs?: number;

  /**
   * Milliseconds between polls of a video file delivered by URI. A value
   * past 2147483647 is refused at `initialize()`.
   * @default 5000
   */
  pollIntervalMs?: number;

  /**
   * The most bytes the images fetched by URL in one call may total; a fetch
   * past it is refused (`EgressRefusedError` `too_large`). A value past
   * `Number.MAX_SAFE_INTEGER`, `Infinity` included, is refused at
   * `initialize()`.
   * @default 20971520
   */
  maxImageBytes?: number;

  /**
   * How image URLs are fetched. `profile` is `'hosted'` (the default: https
   * on 443 to public addresses alone) or `'local'` (http or https on any
   * port, private addresses allowed). `lookup` and `connector` replace the
   * system resolver and the node:https connection.
   */
  imageEgress?: {
    profile?: EgressProfile;
    lookup?: AddressLookup;
    connector?: EgressConnector;
  };
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
  /** Faults recorded on the interaction (https://ai.google.dev/api/interactions-api). */
  errors?: Array<{ code?: string; message?: string }>;
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
  private _config!: Required<Omit<GeminiVideoProviderConfig, 'imageEgress'>> & {
    imageEgress: NonNullable<GeminiVideoProviderConfig['imageEgress']>;
  };
  private keyPool!: ApiKeyPool;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the provider with an API key and optional configuration.
   *
   * @param config - Configuration object. Must include `apiKey`.
   * @throws {Error} If `apiKey` is missing or empty.
   * @throws {RangeError} If `timeoutMs` or `pollIntervalMs` is past
   *   2147483647 milliseconds, or `maxImageBytes` is past
   *   `Number.MAX_SAFE_INTEGER`.
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (!apiKey) {
      throw new Error('Gemini video provider requires apiKey (GEMINI_API_KEY).');
    }

    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;

    // A positive number no larger than `most`, rounded up to a whole number,
    // or the default when the value is unset, not a number or not positive.
    const bounded = (name: string, fallback: number, most: number): number => {
      const value = config[name];
      if (typeof value !== 'number' || !(value > 0)) return fallback;
      if (value > most) {
        throw new RangeError(`Gemini video provider ${name} must be no larger than ${most}, not ${String(value)}.`);
      }
      return Math.ceil(value);
    };

    // AbortSignal.timeout() takes whole milliseconds only, and Node fires a
    // timer longer than MAX_TIMEOUT_MS after 1 ms.
    const timeoutMs = bounded('timeoutMs', 300_000, MAX_TIMEOUT_MS);
    const pollIntervalMs = bounded('pollIntervalMs', 5_000, MAX_TIMEOUT_MS);
    // An infinite budget would read an image URL without a byte bound.
    const maxImageBytes = bounded('maxImageBytes', DEFAULT_MAX_IMAGE_BYTES, Number.MAX_SAFE_INTEGER);

    this._config = {
      apiKey,
      baseURL: (text(config.baseURL) ?? text(config.baseUrl) ?? 'https://generativelanguage.googleapis.com/v1beta')
        .replace(/\/+$/, ''),
      defaultModelId: text(config.defaultModelId) ?? DEFAULT_MODEL,
      timeoutMs,
      pollIntervalMs,
      maxImageBytes,
      imageEgress: isPlainRecord(config.imageEgress)
        ? (config.imageEgress as NonNullable<GeminiVideoProviderConfig['imageEgress']>)
        : {},
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

    // Refused before any image is fetched: the provider reads the interaction
    // the create call returns and does not poll a background one.
    if (getVideoProviderOptions(this.providerId, request.providerOptions)?.background === true) {
      throw new Error(
        'Gemini video provider does not run background interactions; leave providerOptions.background unset.',
      );
    }

    const model = request.modelId || this._config.defaultModelId;
    const timeoutMs = this._config.timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    // One key for the whole call: a Files API file belongs to the project of
    // the key that generated it (https://ai.google.dev/api/files).
    const apiKey = this.keyPool.next();

    try {
      const budget = { remaining: this._config.maxImageBytes };
      const images: GeminiContentPart[] = [];
      if (sourceImage !== undefined) images.push(await this._imagePart(sourceImage, signal, budget));
      for (const reference of request.referenceImages ?? []) {
        images.push(await this._imagePart(reference, signal, budget));
      }

      const body = this._buildBody(request, model, images, sourceImage !== undefined);
      const response = await fetch(`${this._config.baseURL}/interactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini video generation request failed (${response.status}): ${errorText}`);
      }

      const interaction = (await response.json()) as GeminiInteraction;
      const result = this._buildResult(interaction, model);
      for (const video of result.videos) {
        if (video.base64 || !video.url) continue;
        const fileUri = video.url;
        video.base64 = await this._downloadFile(fileUri, signal, apiKey);
        delete video.url;
        video.providerMetadata = { ...video.providerMetadata, fileUri };
      }
      return result;
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
   * @param image - Bytes, a `data:` URL, an image URL or a Files API URI.
   * @param signal - The call's deadline.
   * @param budget - The bytes the call's image fetches may still read.
   * @returns The image part.
   * @throws {EgressRefusedError} For an image URL the egress policy refuses,
   *   a redirect past the limit, or bytes past the budget.
   * @internal
   */
  private async _imagePart(
    image: VideoImageInput,
    signal: AbortSignal,
    budget: { remaining: number },
  ): Promise<GeminiContentPart> {
    if (typeof image !== 'string') {
      const bytes = Buffer.isBuffer(image) ? image : Buffer.from(image as Uint8Array);
      return { type: 'image', data: bytes.toString('base64'), mime_type: sniffImageMimeType(bytes) };
    }

    const value = image.trim();
    // URL schemes are case-insensitive (RFC 3986, section 3.1).
    if (/^data:/i.test(value)) return dataUrlPart(value, budget);

    let url: URL | undefined;
    try {
      url = new URL(value);
    } catch {
      url = undefined;
    }
    if (!url || url.hostname === GEMINI_API_HOST || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      return { type: 'image', uri: value };
    }

    const bytesAndType = await this._fetchImage(url.href, signal, budget);
    return {
      type: 'image',
      data: bytesAndType.bytes.toString('base64'),
      mime_type: bytesAndType.mimeType,
    };
  }

  /**
   * Fetch an image URL through the checked egress path: the destination and
   * every redirect target are checked against the policy before a connection
   * opens, and the bytes are bounded by the call's image budget. The API key
   * is never sent.
   *
   * @param url - The image URL.
   * @param signal - The call's deadline.
   * @param budget - The bytes the call's image fetches may still read; reduced.
   * @returns The image bytes and MIME type.
   * @internal
   */
  private async _fetchImage(
    url: string,
    signal: AbortSignal,
    budget: { remaining: number },
  ): Promise<{ bytes: Buffer; mimeType: string }> {
    const { profile, lookup, connector } = this._config.imageEgress;

    let target = url;
    for (let hop = 0; ; hop += 1) {
      // Every answer, a redirect's body included, is read against what is
      // left of the call's budget.
      const bounds = { timeoutMs: this._config.timeoutMs, maxResponseBytes: Math.max(0, budget.remaining) };
      const policy: EgressPolicy = profile === 'local' ? localEgressPolicy(bounds) : hostedEgressPolicy(bounds);
      const response = await checkedRequest({
        url: target,
        method: 'GET',
        policy,
        signal,
        onRedirect: 'return',
        ...(lookup ? { lookup } : {}),
        ...(connector ? { connector } : {}),
      });
      budget.remaining -= response.body.length;
      if (response.status >= 300 && response.status < 400) {
        const location = headerValue(response.headers, 'location');
        if (!location || hop >= MAX_IMAGE_REDIRECTS) {
          throw new Error(`Gemini video provider could not read an image (HTTP ${response.status}).`);
        }
        target = new URL(location, target).href;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Gemini video provider could not read an image (HTTP ${response.status}).`);
      }
      const declared = headerValue(response.headers, 'content-type')?.split(';')[0]?.trim().toLowerCase();
      return {
        bytes: response.body,
        mimeType: declared && declared.startsWith('image/') ? declared : sniffImageMimeType(response.body),
      };
    }
  }

  /**
   * Wait for a Files API video to be `ACTIVE` and download it.
   *
   * @param fileUri - The URI the interaction gave (`files/{id}` or a full URL).
   * @param signal - The call's deadline.
   * @param apiKey - The key that generated the file; its project owns it.
   * @returns The video bytes as base64.
   * @throws {Error} If the file fails processing or a request is refused.
   * @internal
   */
  private async _downloadFile(fileUri: string, signal: AbortSignal, apiKey: string): Promise<string> {
    const match = /(?:^|\/)files\/([^/?#:]+)/.exec(fileUri);
    if (!match) {
      throw new Error(`Gemini video generation returned a video URI that names no file: ${fileUri}`);
    }
    const name = `files/${match[1]}`;
    const fileUrl = `${this._config.baseURL}/${name}`;

    for (;;) {
      const response = await fetch(fileUrl, {
        headers: { 'x-goog-api-key': apiKey },
        signal,
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini video file request failed (${response.status}): ${errorText}`);
      }
      const file = (await response.json()) as { state?: string };
      if (file.state === 'ACTIVE') break;
      if (file.state === 'FAILED') throw new Error(`Gemini video file ${name} failed processing.`);
      await sleep(this._config.pollIntervalMs, signal);
    }

    const download = await fetch(`${fileUrl}:download?alt=media`, {
      headers: { 'x-goog-api-key': apiKey },
      signal,
    });
    if (!download.ok) {
      const errorText = await download.text();
      throw new Error(`Gemini video download failed (${download.status}): ${errorText}`);
    }
    return Buffer.from(await download.arrayBuffer()).toString('base64');
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
    if (interaction.status !== 'completed') {
      // `status` is required on the Interaction resource; a reply without it
      // is not taken as a completed generation.
      if (!interaction.status) throw new Error('Gemini video generation ended with no status.');
      const messages = (Array.isArray(interaction.errors) ? interaction.errors : [])
        .map((fault) => (typeof fault?.message === 'string' ? fault.message.trim() : ''))
        .filter((message) => message.length > 0);
      const reason = messages.length > 0 ? `: ${messages.join('; ')}` : '.';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait `ms` milliseconds, or until `signal` aborts.
 * @internal
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One header of an egress answer, whose headers may hold arrays.
 * @internal
 */
function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Decode a `data:` URL (RFC 2397) into an image part: a base64 payload is
 * sent as standard base64 (its escapes decoded, line breaks dropped, the
 * URL-safe alphabet mapped), and a percent-encoded one is decoded to its
 * bytes and base64 encoded. The decoded size is charged to the call's image budget
 * before anything is decoded.
 *
 * @throws {Error} If the URL is malformed or its MIME type is not an image.
 * @throws {EgressRefusedError} `too_large` when the image is past the budget.
 * @internal
 */
function dataUrlPart(value: string, budget: { remaining: number }): GeminiContentPart {
  const comma = value.indexOf(',');
  if (comma < 0) throw new Error('Gemini video provider got a data: URL image with no data.');
  const params = value.slice('data:'.length, comma).split(';').map((part) => part.trim());
  const isBase64 = params.length > 1 && params[params.length - 1]!.toLowerCase() === 'base64';
  const mimeType = (params[0] ?? '').toLowerCase();
  if (!mimeType.startsWith('image/')) {
    throw new Error('Gemini video provider takes a data: URL image only with an image/ MIME type.');
  }
  const payload = value.slice(comma + 1);
  // A `%XX` escape counts as the one character it decodes to.
  const size = isBase64
    ? base64DecodedLength(payload.replace(/%[0-9a-fA-F]{2}/g, 'A'))
    : percentDecodedLength(payload);
  if (size > budget.remaining) {
    throw new EgressRefusedError('too_large', 'an inline image is past maxImageBytes');
  }
  budget.remaining -= size;
  if (isBase64) {
    // RFC 2397 allows escapes and line breaks in the payload, and some
    // writers use the URL-safe alphabet; Gemini takes standard base64.
    const clean = payload
      .replace(/%([0-9a-fA-F]{2})/g, (_escape, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\s+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    return { type: 'image', data: Buffer.from(clean, 'base64').toString('base64'), mime_type: mimeType };
  }
  return { type: 'image', data: percentDecode(payload).toString('base64'), mime_type: mimeType };
}

/**
 * The number of bytes a base64 payload decodes to.
 * @internal
 */
function base64DecodedLength(payload: string): number {
  const digits = payload.replace(/[^A-Za-z0-9+/_-]/g, '').length;
  return Math.floor((digits * 3) / 4);
}

/**
 * The number of bytes a percent-encoded payload decodes to: one for each
 * `%XX`, and the UTF-8 length of every other character.
 * @internal
 */
function percentDecodedLength(payload: string): number {
  const escapes = payload.match(/%[0-9a-fA-F]{2}/g)?.length ?? 0;
  return Buffer.byteLength(payload, 'utf8') - 2 * escapes;
}

/**
 * The bytes of a percent-encoded string: each `%XX` is one byte and every
 * other character is its UTF-8 bytes.
 * @internal
 */
function percentDecode(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      const code = text.codePointAt(i)!;
      const char = String.fromCodePoint(code);
      bytes.push(...Buffer.from(char, 'utf8'));
      if (char.length > 1) i += 1;
    }
  }
  return Buffer.from(bytes);
}
