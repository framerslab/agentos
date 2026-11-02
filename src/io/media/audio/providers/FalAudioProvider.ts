/**
 * @module media/audio/providers/FalAudioProvider
 *
 * Audio generation provider for the Fal.ai serverless GPU platform.
 *
 * Fal.ai hosts audio generation models (MusicGen, Stable Audio, etc.) behind a
 * queue-based API. This provider implements the three-step pattern
 * established by {@link FalVideoProvider}: submit to queue, poll for status,
 * then fetch the completed result.
 *
 * ## Supported models
 *
 * | Model ID                                | Input duration field | Result field |
 * |-----------------------------------------|----------------------|--------------|
 * | `fal-ai/musicgen` (music default)       | `duration` (4-40 s)  | `audio_url`  |
 * | `fal-ai/stable-audio` (SFX default)     | `seconds_total` (0-47 s) | `audio_file` |
 * | `fal-ai/stable-audio-25/text-to-audio`  | `seconds_total`      | `audio`      |
 *
 * Models whose id starts with `fal-ai/stable-audio` get `seconds_total`; every
 * other model gets `duration`. `seed` is sent when the request sets it, and
 * `providerOptions` add model inputs without replacing the prompt, the
 * duration field or the seed. The result is read from `audio`, `audio_file`
 * or `audio_url`, whichever the model returns. Each model's schema is on its
 * fal.ai page, for example https://fal.ai/models/fal-ai/musicgen/api.
 *
 * ## API flow (three-step queue)
 *
 * 1. **Submit**: `POST ${baseURL}/${model}` with the model input. Returns
 *    `{ request_id, status_url, response_url }`.
 * 2. **Poll**: `GET status_url` until `status === 'COMPLETED'`. A failed
 *    request also ends `COMPLETED`, with an `error` field, which is raised.
 * 3. **Fetch**: `GET response_url` returns the model output.
 *
 * When `baseURL` is on another origin than the URLs fal returns (a gateway),
 * their paths are moved onto `baseURL`. When the submit response omits the
 * URLs they are built from the app path
 * (the first two segments of the model id):
 * `${baseURL}/${owner}/${app}/requests/${request_id}[/status]`. Queue
 * reference: https://fal.ai/docs/api-reference/inference-api/queue/submit.md.
 *
 * ## Authentication
 *
 * Requires a `FAL_API_KEY`. Sent as `Authorization: Key ${apiKey}`.
 *
 * @see {@link IAudioGenerator} for the provider interface contract.
 * @see {@link FalVideoProvider} for the video counterpart.
 * @see {@link FalImageProvider} for the image counterpart.
 */

import type { IAudioGenerator } from '../IAudioGenerator.js';
import { ApiKeyPool } from '../../../../core/providers/ApiKeyPool.js';
import type { MusicGenerateRequest, SFXGenerateRequest, AudioResult } from '../types.js';

/** Music model used when neither the request nor the config names one. */
const DEFAULT_MUSIC_MODEL = 'fal-ai/musicgen';

/** SFX model used when neither the request nor the config names one. */
const DEFAULT_SFX_MODEL = 'fal-ai/stable-audio';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Fal.ai audio generation provider.
 *
 * @example
 * ```typescript
 * const config: FalAudioProviderConfig = {
 *   apiKey: process.env.FAL_API_KEY!,
 *   defaultMusicModel: 'fal-ai/musicgen',
 *   defaultSfxModel: 'fal-ai/stable-audio',
 * };
 * ```
 */
export interface FalAudioProviderConfig {
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
   * One model for both music and SFX. When set it replaces both
   * {@link FalAudioProviderConfig.defaultMusicModel} and
   * {@link FalAudioProviderConfig.defaultSfxModel}.
   */
  defaultModelId?: string;

  /**
   * Default model for music generation.
   * @default 'fal-ai/musicgen'
   */
  defaultMusicModel?: string;

  /**
   * Default model for SFX generation.
   * @default 'fal-ai/stable-audio'
   */
  defaultSfxModel?: string;

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
 * A fal file reference, as returned in model outputs.
 * @internal
 */
interface FalFile {
  /** URL to the generated audio file. */
  url?: string;
  /** MIME type of the file. */
  content_type?: string;
  /** Duration of the generated audio in seconds, when the model reports it. */
  duration?: number;
}

/**
 * Response from the Fal.ai result endpoint (fetched after COMPLETED).
 * Models name the audio field differently.
 * @internal
 */
interface FalAudioResultResponse {
  /** Audio output (for example Stable Audio 2.5). */
  audio?: FalFile | string;
  /** Audio output (for example Stable Audio Open). */
  audio_file?: FalFile | string;
  /** Audio output (for example MusicGen). */
  audio_url?: FalFile | string;
  /** Random seed used for generation. */
  seed?: number;
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
 * Read the audio file from a model output, whichever field the model uses.
 * @internal
 */
function extractAudioFile(result: FalAudioResultResponse): FalFile | undefined {
  for (const candidate of [result.audio, result.audio_file, result.audio_url]) {
    if (typeof candidate === 'string' && candidate) return { url: candidate };
    if (candidate && typeof candidate === 'object' && typeof candidate.url === 'string' && candidate.url) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Choose the MIME type: the file's `content_type` when it names audio,
 * otherwise the URL's extension, otherwise `audio/mpeg`.
 * @internal
 */
function audioMimeType(file: FalFile): string {
  if (typeof file.content_type === 'string' && file.content_type.startsWith('audio/')) {
    return file.content_type;
  }
  let ext = '';
  try {
    ext = new URL(file.url ?? '').pathname.split('.').pop()?.toLowerCase() ?? '';
  } catch {
    ext = '';
  }
  switch (ext) {
    case 'wav': return 'audio/wav';
    case 'flac': return 'audio/flac';
    case 'ogg': return 'audio/ogg';
    case 'aac': return 'audio/aac';
    default: return 'audio/mpeg';
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Audio generation provider connecting to the Fal.ai serverless platform.
 *
 * Implements the three-step queue pattern: submit a generation task,
 * poll the status endpoint until completion, then fetch the result.
 * This mirrors the flow used by {@link FalVideoProvider}.
 *
 * Music runs on `fal-ai/musicgen` and SFX on `fal-ai/stable-audio` unless the
 * request or the config names another model.
 *
 * @implements {IAudioGenerator}
 *
 * @example
 * ```typescript
 * const provider = new FalAudioProvider();
 * await provider.initialize({ apiKey: process.env.FAL_API_KEY! });
 *
 * const result = await provider.generateMusic({
 *   prompt: 'A dreamy ambient track with reverb-heavy synths',
 *   durationSec: 30,
 * });
 * console.log(result.audio[0].url);
 * ```
 */
export class FalAudioProvider implements IAudioGenerator {
  /** @inheritdoc */
  public readonly providerId = 'fal-audio';

  /** @inheritdoc */
  public isInitialized = false;

  /** Default model id reported to callers: the music default. SFX uses `defaultSfxModel`. */
  public defaultModelId?: string;

  /** Internal resolved configuration. */
  private _config!: Required<Pick<FalAudioProviderConfig, 'apiKey' | 'baseURL' | 'defaultMusicModel' | 'defaultSfxModel' | 'pollIntervalMs' | 'timeoutMs'>>;
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
      throw new Error('Fal.ai audio provider requires apiKey (FAL_API_KEY).');
    }

    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;
    const single = text(config.defaultModelId);

    this._config = {
      apiKey,
      baseURL: text(config.baseURL) ?? 'https://queue.fal.run',
      defaultMusicModel: single ?? text(config.defaultMusicModel) ?? DEFAULT_MUSIC_MODEL,
      defaultSfxModel: single ?? text(config.defaultSfxModel) ?? DEFAULT_SFX_MODEL,
      pollIntervalMs:
        typeof config.pollIntervalMs === 'number' && config.pollIntervalMs > 0
          ? config.pollIntervalMs
          : 2000,
      timeoutMs:
        typeof config.timeoutMs === 'number' && config.timeoutMs > 0
          ? config.timeoutMs
          : 300_000,
    };

    this.defaultModelId = this._config.defaultMusicModel;
    this.keyPool = new ApiKeyPool(apiKey);
    this.isInitialized = true;
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  /**
   * Generate music from a text prompt using the Fal.ai queue API.
   *
   * Submits the task, polls until complete, then fetches the result.
   *
   * @param request - Music generation request with prompt and optional params.
   * @returns The generated audio result envelope.
   *
   * @throws {Error} If the provider is not initialized.
   * @throws {Error} If the API returns an error or times out.
   */
  async generateMusic(request: MusicGenerateRequest): Promise<AudioResult> {
    if (!this.isInitialized) {
      throw new Error('Fal.ai audio provider is not initialized. Call initialize() first.');
    }

    return this._generate(request, request.modelId || this._config.defaultMusicModel);
  }

  /**
   * Generate a sound effect from a text prompt using the Fal.ai queue API.
   *
   * Submits the task, polls until complete, then fetches the result.
   *
   * @param request - SFX generation request with prompt and optional params.
   * @returns The generated audio result envelope.
   *
   * @throws {Error} If the provider is not initialized.
   * @throws {Error} If the API returns an error or times out.
   */
  async generateSFX(request: SFXGenerateRequest): Promise<AudioResult> {
    if (!this.isInitialized) {
      throw new Error('Fal.ai audio provider is not initialized. Call initialize() first.');
    }

    return this._generate(request, request.modelId || this._config.defaultSfxModel);
  }

  // -------------------------------------------------------------------------
  // Capability query
  // -------------------------------------------------------------------------

  /**
   * Fal.ai audio supports both music and SFX generation.
   *
   * @param capability - The capability to check.
   * @returns `true` for both `'music'` and `'sfx'`.
   */
  supports(capability: 'music' | 'sfx'): boolean {
    return capability === 'music' || capability === 'sfx';
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
   * Run the full three-step generation flow: submit, poll, fetch.
   *
   * @param request - Music or SFX request.
   * @param model - Full model path (e.g. 'fal-ai/musicgen').
   * @returns Normalized audio result envelope.
   *
   * @throws {Error} If any step of the flow fails.
   * @internal
   */
  private async _generate(
    request: MusicGenerateRequest | SFXGenerateRequest,
    model: string,
  ): Promise<AudioResult> {
    const body: Record<string, unknown> = {
      prompt: request.prompt,
    };

    if (request.durationSec !== undefined) {
      body[model.startsWith('fal-ai/stable-audio') ? 'seconds_total' : 'duration'] = request.durationSec;
    }
    if (request.seed !== undefined) body.seed = request.seed;
    // Provider options add model inputs; they never replace the fields above.
    for (const [key, value] of Object.entries(request.providerOptions ?? {})) {
      if (!(key in body)) body[key] = value;
    }

    // Three-step flow: submit -> poll -> fetch
    const urls = await this._submitTask(model, body);
    await this._pollStatus(urls);
    const result = await this._fetchResult(urls);

    return this._buildResult(result, model, urls.requestId);
  }

  /**
   * Submit a generation task to the Fal.ai queue.
   *
   * @param model - Full model path (e.g. 'fal-ai/musicgen').
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
      throw new Error(`Fal.ai audio generation submission failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as FalSubmitResponse;
    if (!data.request_id) {
      throw new Error('Fal.ai audio submission response missing request_id.');
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
        throw new Error(`Fal.ai audio status polling failed (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as FalStatusResponse;

      if (data.status === 'COMPLETED' || data.status === 'FAILED') {
        if (data.error || data.status === 'FAILED') {
          const reason = data.error ?? 'unknown error';
          const kind = data.error_type ? ` [${data.error_type}]` : '';
          throw new Error(`Fal.ai audio generation failed for request ${urls.requestId}${kind}: ${reason}`);
        }
        return;
      }

      // 'IN_QUEUE' or 'IN_PROGRESS': wait before the next poll
      await sleep(this._config.pollIntervalMs);
    }

    throw new Error(
      `Fal.ai audio generation timed out after ${this._config.timeoutMs}ms for request ${urls.requestId}.`,
    );
  }

  /**
   * Fetch the completed generation result from the Fal.ai result endpoint.
   *
   * Called after polling confirms the task is COMPLETED.
   *
   * @param urls - The request's queue URLs.
   * @returns The model output.
   *
   * @throws {Error} If the result fetch fails.
   * @internal
   */
  private async _fetchResult(urls: FalRequestUrls): Promise<FalAudioResultResponse> {
    const response = await fetch(urls.responseUrl, {
      headers: {
        Authorization: `Key ${this.keyPool.next()}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Fal.ai audio result fetch failed (${response.status}): ${errorText}`);
    }

    return (await response.json()) as FalAudioResultResponse;
  }

  /**
   * Build an {@link AudioResult} from a completed Fal.ai result.
   *
   * @param result - The Fal.ai result response.
   * @param model - Model ID used for the generation.
   * @param requestId - The queue request id.
   * @returns Normalized audio result envelope.
   *
   * @throws {Error} If the result has no audio URL.
   * @internal
   */
  private _buildResult(result: FalAudioResultResponse, model: string, requestId: string): AudioResult {
    const file = extractAudioFile(result);
    if (!file?.url) {
      throw new Error('Fal.ai audio generation completed but returned no audio output.');
    }

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      audio: [{
        url: file.url,
        mimeType: audioMimeType(file),
        durationSec: file.duration,
        providerMetadata: {
          seed: result.seed,
          requestId,
        },
      }],
      usage: {
        totalAudioClips: 1,
      },
    };
  }
}
