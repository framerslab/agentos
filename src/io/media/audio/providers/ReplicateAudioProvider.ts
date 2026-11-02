/**
 * @module media/audio/providers/ReplicateAudioProvider
 *
 * Audio generation provider for the Replicate API, supporting both music
 * and sound effects through different default models.
 *
 * Replicate hosts open-source audio models (MusicGen, AudioGen, etc.) behind
 * a uniform predictions API. This provider mirrors the pattern established
 * by {@link ReplicateVideoProvider}: create a prediction with `Prefer: wait`,
 * then poll if it hasn't completed inline.
 *
 * ## Supported models
 *
 * | Model ID                          | Type  | Route                                   |
 * |-----------------------------------|-------|-----------------------------------------|
 * | `meta/musicgen`                   | Music | community, version pinned; default      |
 * | `sepal/audiogen`                  | SFX   | community, version pinned; default      |
 * | `stability-ai/stable-audio-2.5`   | Both  | official model                          |
 *
 * `meta/audiogen`, the former SFX default, is not published on Replicate and
 * resolves to `sepal/audiogen`.
 *
 * ## Model routing
 *
 * Replicate runs community models only by version and official models by
 * name (https://replicate.com/docs/reference/http#predictions.create):
 *
 * - `owner/name:version` or a bare 64-character version id:
 *   `POST ${baseURL}/predictions` with `{ version, input }`, as given.
 * - `owner/name` with a pinned version ({@link REPLICATE_AUDIO_MODEL_VERSIONS}):
 *   `POST ${baseURL}/predictions` with `{ version: 'owner/name:<pin>', input }`.
 * - any other `owner/name` (an official model):
 *   `POST ${baseURL}/models/{owner}/{name}/predictions` with `{ input }`.
 *
 * ## API flow (submit + sync wait + optional poll)
 *
 * 1. **Create prediction**: as routed above, with `Prefer: wait=60`. If the
 *    model finishes within 60 seconds the response already contains the output.
 * 2. **Poll** (if needed): `GET prediction.urls.get` until `status` is
 *    `succeeded`, `failed`, or `canceled`.
 * 3. **Result**: `output` is the audio URL (string or first array element).
 *
 * The model input is `{ prompt, duration }` (`music_length_ms`, in
 * milliseconds, for `elevenlabs/music`), plus `output_format` and `seed`
 * where the model takes them, plus every other key of `providerOptions` (for
 * example musicgen's `model_version` or `normalization_strategy`). Provider
 * options never replace `prompt`, the length, `output_format` or `seed`.
 *
 * `outputFormat` `wav` or `mp3` is sent as the model's own `output_format`
 * value: `wav`/`mp3` for `meta/musicgen` and `sepal/audiogen`,
 * `wav_cd_quality`/`mp3_standard` for `elevenlabs/music`, and nothing for
 * `stability-ai/stable-audio-2.5`, which has no such input. `flac`, `ogg` and
 * `aac` are never sent; the model's default format is used. The result's MIME
 * type is read from the output URL's extension, then from the format sent, and
 * is `audio/mpeg` when neither names one. `seed` is sent to every model except
 * `sepal/audiogen` and `elevenlabs/music`, which take none. A model with no
 * entry here gets `output_format` `wav`/`mp3` and `seed` as given; pass other
 * names through `providerOptions`.
 *
 * A model given as `owner/name:version` or a bare version id is reported in
 * the result exactly as given.
 *
 * ## Authentication
 *
 * Requires a `REPLICATE_API_TOKEN`. Sent as `Authorization: Bearer ${apiKey}`.
 *
 * @see {@link IAudioGenerator} for the provider interface contract.
 * @see {@link ReplicateVideoProvider} for the video counterpart.
 */

import type { IAudioGenerator } from '../IAudioGenerator.js';
import { ApiKeyPool } from '../../../../core/providers/ApiKeyPool.js';
import type { MusicGenerateRequest, SFXGenerateRequest, AudioResult } from '../types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Replicate audio generation provider.
 *
 * @example
 * ```typescript
 * const config: ReplicateAudioProviderConfig = {
 *   apiKey: process.env.REPLICATE_API_TOKEN!,
 *   defaultMusicModel: 'meta/musicgen',
 *   defaultSfxModel: 'sepal/audiogen',
 * };
 * ```
 */
export interface ReplicateAudioProviderConfig {
  /** Replicate API token. Sent as `Authorization: Bearer ${apiKey}`. */
  apiKey: string;

  /**
   * Base URL for the Replicate API. Override for testing or proxy setups.
   * @default 'https://api.replicate.com/v1'
   */
  baseURL?: string;

  /**
   * One model for both music and SFX. When set it replaces both
   * {@link ReplicateAudioProviderConfig.defaultMusicModel} and
   * {@link ReplicateAudioProviderConfig.defaultSfxModel}.
   */
  defaultModelId?: string;

  /**
   * Default model to use for music generation: `owner/name` (version pinned
   * when known, otherwise run as an official model), `owner/name:version`, or a
   * bare version id.
   * @default 'meta/musicgen'
   */
  defaultMusicModel?: string;

  /**
   * Default model to use for SFX generation, in the same forms as
   * {@link ReplicateAudioProviderConfig.defaultMusicModel}.
   * @default 'sepal/audiogen'
   */
  defaultSfxModel?: string;

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

  /** Generation output — typically a URL string or array of URLs. */
  output?: unknown;

  /** Error message on failure. */
  error?: string;

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
 * @param ms - Duration in milliseconds.
 * @internal
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract an audio URL from the Replicate prediction output.
 *
 * Replicate returns output in different shapes depending on the model:
 * - A plain URL string
 * - An array of URL strings (first element is the audio)
 * - An object with a `url` or `audio` property
 *
 * @param output - Raw output from the prediction.
 * @returns The audio URL string, or `undefined` if not found.
 * @internal
 */
function extractAudioUrl(output: unknown): string | undefined {
  if (typeof output === 'string') return output;

  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj.url === 'string') return obj.url;
        if (typeof obj.audio === 'string') return obj.audio;
      }
    }
    return undefined;
  }

  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    if (typeof obj.url === 'string') return obj.url;
    if (typeof obj.audio === 'string') return obj.audio;
  }

  return undefined;
}

/**
 * Pinned versions of the community audio models this provider runs by name.
 *
 * Community models on Replicate are run by version; these are the latest
 * versions listed on each model's versions page:
 * https://replicate.com/meta/musicgen/versions and
 * https://replicate.com/sepal/audiogen/versions.
 */
export const REPLICATE_AUDIO_MODEL_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  'meta/musicgen': '671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb',
  'sepal/audiogen': '154b3e5141493cb1b8cec976d9aa90f2b691137e39ad906d2421b74c2a8c52b8',
});

/** Model ids that are not published on Replicate, mapped to the one that is. */
const MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'meta/audiogen': 'sepal/audiogen',
});

/**
 * The inputs a known model takes for the request's `outputFormat` and `seed`.
 * @internal
 */
interface ModelInputs {
  /** `output_format` value for each request format the model can produce. */
  formats: Readonly<Partial<Record<'wav' | 'mp3', string>>>;
  /** Whether the model takes a `seed` input. */
  seed: boolean;
  /** Input that carries the length: `duration` in seconds or `music_length_ms`. */
  length?: 'duration' | 'music_length_ms';
}

/** `output_format` and `seed` for a model this provider has no entry for. */
const GENERIC_INPUTS: ModelInputs = { formats: { wav: 'wav', mp3: 'mp3' }, seed: true };

/**
 * The `output_format` values and `seed` support of known models, read from
 * each model's input schema (https://replicate.com/{owner}/{name}/api/schema).
 */
const KNOWN_MODEL_INPUTS: Readonly<Record<string, ModelInputs>> = Object.freeze({
  'meta/musicgen': { formats: { wav: 'wav', mp3: 'mp3' }, seed: true },
  'sepal/audiogen': { formats: { wav: 'wav', mp3: 'mp3' }, seed: false },
  'stability-ai/stable-audio-2.5': { formats: {}, seed: true },
  'elevenlabs/music': {
    formats: { wav: 'wav_cd_quality', mp3: 'mp3_standard' },
    seed: false,
    length: 'music_length_ms',
  },
});

/** A bare 64-character Replicate version id. */
const VERSION_ID = /^[0-9a-f]{64}$/;

/**
 * How a model id is sent to Replicate.
 * @internal
 */
interface ReplicateRoute {
  /** Path below the base URL. */
  path: string;
  /** `version` field of the body, when the route takes one. */
  version?: string;
  /** Model id reported in the result. */
  reportedModel: string;
}

/**
 * Resolve a model id to its Replicate route (see the module's Model routing).
 * @param model - `owner/name`, `owner/name:version`, or a bare version id.
 * @internal
 */
function resolveRoute(model: string): ReplicateRoute {
  if (VERSION_ID.test(model) || model.includes(':')) {
    // The caller chose this version, so the result names it.
    return { path: '/predictions', version: model, reportedModel: model };
  }
  const name = MODEL_ALIASES[model] ?? model;
  const pinned = REPLICATE_AUDIO_MODEL_VERSIONS[name];
  if (pinned) {
    return { path: '/predictions', version: `${name}:${pinned}`, reportedModel: name };
  }
  return { path: `/models/${name}/predictions`, reportedModel: name };
}

/**
 * Guess an audio MIME type from a file URL's extension.
 * @param url - Output URL.
 * @param requested - The output format the request asked for, if any.
 * @internal
 */
function audioMimeType(url: string, requested?: string): string {
  let ext = '';
  try {
    ext = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? '';
  } catch {
    ext = '';
  }
  const format = ['wav', 'mp3', 'flac', 'ogg', 'aac'].includes(ext) ? ext : requested;
  switch (format) {
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
 * Audio generation provider connecting to the Replicate predictions API.
 *
 * Follows the same submit-then-poll pattern as {@link ReplicateVideoProvider}:
 * create a prediction with `Prefer: wait=60`, then poll if the model takes
 * longer than the wait window.
 *
 * Routes to different default models based on whether music or SFX is requested.
 *
 * @implements {IAudioGenerator}
 *
 * @example
 * ```typescript
 * const provider = new ReplicateAudioProvider();
 * await provider.initialize({ apiKey: process.env.REPLICATE_API_TOKEN! });
 *
 * const music = await provider.generateMusic({
 *   prompt: 'Upbeat indie rock with driving guitars',
 * });
 *
 * const sfx = await provider.generateSFX({
 *   prompt: 'Glass shattering on a hard floor',
 * });
 * ```
 */
export class ReplicateAudioProvider implements IAudioGenerator {
  /** @inheritdoc */
  public readonly providerId = 'replicate-audio';

  /** @inheritdoc */
  public isInitialized = false;

  /** @inheritdoc */
  public defaultModelId?: string;

  /** Internal resolved configuration. */
  private _config!: Required<Pick<ReplicateAudioProviderConfig, 'apiKey' | 'baseURL' | 'defaultMusicModel' | 'defaultSfxModel' | 'pollIntervalMs' | 'timeoutMs'>>;
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
      throw new Error('Replicate audio provider requires apiKey (REPLICATE_API_TOKEN).');
    }

    // `defaultModelId` (what the high-level helpers pass for an explicit
    // model) replaces both capability defaults.
    const single =
      typeof config.defaultModelId === 'string' && config.defaultModelId.trim()
        ? config.defaultModelId.trim()
        : undefined;

    this._config = {
      apiKey,
      baseURL:
        typeof config.baseURL === 'string' && config.baseURL.trim()
          ? config.baseURL.trim()
          : 'https://api.replicate.com/v1',
      defaultMusicModel:
        single
        ?? (typeof config.defaultMusicModel === 'string' && config.defaultMusicModel.trim()
          ? config.defaultMusicModel.trim()
          : 'meta/musicgen'),
      defaultSfxModel:
        single
        ?? (typeof config.defaultSfxModel === 'string' && config.defaultSfxModel.trim()
          ? config.defaultSfxModel.trim()
          : 'sepal/audiogen'),
      pollIntervalMs:
        typeof config.pollIntervalMs === 'number' && config.pollIntervalMs > 0
          ? config.pollIntervalMs
          : 5000,
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
   * Generate music from a text prompt using a music model on Replicate.
   *
   * @param request - Music generation request with prompt and optional params.
   * @returns The generated audio result envelope.
   *
   * @throws {Error} If the provider is not initialized.
   * @throws {Error} If the API returns an error or times out.
   */
  async generateMusic(request: MusicGenerateRequest): Promise<AudioResult> {
    if (!this.isInitialized) {
      throw new Error('Replicate audio provider is not initialized. Call initialize() first.');
    }

    return this._generate(request, request.modelId || this._config.defaultMusicModel);
  }

  /**
   * Generate a sound effect from a text prompt using an SFX model on Replicate.
   *
   * @param request - SFX generation request with prompt and optional params.
   * @returns The generated audio result envelope.
   *
   * @throws {Error} If the provider is not initialized.
   * @throws {Error} If the API returns an error or times out.
   */
  async generateSFX(request: SFXGenerateRequest): Promise<AudioResult> {
    if (!this.isInitialized) {
      throw new Error('Replicate audio provider is not initialized. Call initialize() first.');
    }

    return this._generate(request, request.modelId || this._config.defaultSfxModel);
  }

  // -------------------------------------------------------------------------
  // Capability query
  // -------------------------------------------------------------------------

  /**
   * Replicate audio supports both music and SFX generation through
   * different model routing.
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
   * Build the model input, run the prediction and wrap its output.
   *
   * @param request - Music or SFX request.
   * @param model - Model id to run (see the module's Model routing).
   * @internal
   */
  private async _generate(
    request: MusicGenerateRequest | SFXGenerateRequest,
    model: string,
  ): Promise<AudioResult> {
    const route = resolveRoute(model);
    const input: Record<string, unknown> = {
      prompt: request.prompt,
    };

    // A format or seed the model has no input for is left to the model's default.
    const name = VERSION_ID.test(model) ? '' : (MODEL_ALIASES[model] ?? model).split(':')[0];
    const known = KNOWN_MODEL_INPUTS[name] ?? GENERIC_INPUTS;
    if (request.durationSec !== undefined) {
      if (known.length === 'music_length_ms') {
        input.music_length_ms = Math.round(request.durationSec * 1000);
      } else {
        input.duration = request.durationSec;
      }
    }
    const format =
      request.outputFormat === 'wav' || request.outputFormat === 'mp3'
        ? known.formats[request.outputFormat]
        : undefined;
    if (format) input.output_format = format;
    if (request.seed !== undefined && known.seed) input.seed = request.seed;
    // Provider options add model inputs; they never replace the fields above.
    for (const [key, value] of Object.entries(request.providerOptions ?? {})) {
      if (!(key in input)) input[key] = value;
    }

    const prediction = await this._runPrediction(route, input);
    return this._buildResult(prediction, route.reportedModel, format ? request.outputFormat : undefined);
  }

  /**
   * Create a prediction and wait for it to complete.
   *
   * Uses `Prefer: wait=60` to get synchronous completion for fast models.
   * Falls back to polling if the prediction hasn't completed within the
   * wait window.
   *
   * @param route - Resolved Replicate route for the model.
   * @param input - Model input parameters.
   * @returns The completed prediction object.
   *
   * @throws {Error} If prediction creation fails, the prediction fails,
   *   is canceled, or times out.
   * @internal
   */
  private async _runPrediction(
    route: ReplicateRoute,
    input: Record<string, unknown>,
  ): Promise<ReplicatePrediction> {
    let prediction = await this._createPrediction(route, input);

    // If the prediction hasn't reached a terminal state, poll for it.
    if (
      prediction.status
      && !['succeeded', 'failed', 'canceled'].includes(prediction.status)
      && prediction.urls?.get
    ) {
      prediction = await this._pollPrediction(prediction.urls.get);
    }

    if (prediction.status === 'failed') {
      throw new Error(`Replicate audio generation failed: ${prediction.error ?? 'unknown error'}`);
    }
    if (prediction.status === 'canceled') {
      throw new Error('Replicate audio generation was canceled.');
    }

    return prediction;
  }

  /**
   * Create a new prediction on the route the model resolved to.
   *
   * @param route - Resolved Replicate route for the model.
   * @param input - Model input parameters.
   * @returns The prediction response (may or may not be completed).
   *
   * @throws {Error} If the HTTP request fails.
   * @internal
   */
  private async _createPrediction(
    route: ReplicateRoute,
    input: Record<string, unknown>,
  ): Promise<ReplicatePrediction> {
    const body: Record<string, unknown> = route.version
      ? { version: route.version, input }
      : { input };

    const response = await fetch(`${this._config.baseURL}${route.path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.keyPool.next()}`,
        'Content-Type': 'application/json',
        Prefer: 'wait=60',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Replicate audio prediction submission failed (${response.status}): ${errorText}`);
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
          Authorization: `Bearer ${this.keyPool.next()}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Replicate audio prediction polling failed (${response.status}): ${errorText}`);
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
      `Replicate audio generation timed out after ${this._config.timeoutMs}ms.`,
    );
  }

  /**
   * Build an {@link AudioResult} from a completed Replicate prediction.
   *
   * @param prediction - The succeeded prediction object.
   * @param model - Model ID used for the generation.
   * @param outputFormat - Output format the request asked for, if any.
   * @returns Normalized audio result envelope.
   *
   * @throws {Error} If no audio URL could be extracted from the output.
   * @internal
   */
  private _buildResult(
    prediction: ReplicatePrediction,
    model: string,
    outputFormat?: string,
  ): AudioResult {
    const audioUrl = extractAudioUrl(prediction.output);

    if (!audioUrl) {
      throw new Error('Replicate audio prediction succeeded but returned no audio output.');
    }

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      audio: [{
        url: audioUrl,
        mimeType: audioMimeType(audioUrl, outputFormat),
        providerMetadata: {
          predictionId: prediction.id,
        },
      }],
      usage: {
        totalAudioClips: 1,
      },
    };
  }
}
