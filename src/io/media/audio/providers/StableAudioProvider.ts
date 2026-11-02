/**
 * @module media/audio/providers/StableAudioProvider
 *
 * Audio generation provider for the Stability AI Stable Audio API.
 *
 * Stable Audio generates both music and sound effects from text prompts
 * through Stability's Stable Audio 2 text-to-audio endpoint. The endpoint is
 * synchronous: a single POST returns the audio bytes (no queue or polling).
 *
 * ## Supported models
 *
 * | Model ID            | Description                                   |
 * |---------------------|-----------------------------------------------|
 * | `stable-audio-2.5`  | Stable Audio 2.5, up to 190 s; default        |
 * | `stable-audio-2`    | Stable Audio 2.0, up to 190 s                 |
 *
 * ## API flow (synchronous)
 *
 * 1. **Generate**: `POST ${baseURL}/audio/stable-audio-2/text-to-audio` with a
 *    `multipart/form-data` body (`prompt`, `model`, `output_format`, and the
 *    optional `duration`, `seed`, `steps`, `cfg_scale`) and `Accept: audio/*`.
 *    The response body is the audio in the requested format (`mp3` or `wav`).
 *
 * Request fields are documented at
 * https://docs.stability.ai/api-reference/stable-audio-2/text-to-audio.
 * Primitive values in `providerOptions` (for example `steps` or `cfg_scale`)
 * are appended to the form as-is.
 *
 * ## Authentication
 *
 * Requires a `STABILITY_API_KEY`. Sent as `Authorization: Bearer ${apiKey}`.
 *
 * @see {@link IAudioGenerator} for the provider interface contract.
 */

import type { IAudioGenerator } from '../IAudioGenerator.js';
import { ApiKeyPool } from '../../../../core/providers/ApiKeyPool.js';
import type { MusicGenerateRequest, SFXGenerateRequest, AudioResult } from '../types.js';

/** Model used when neither the request nor the config names one. */
const DEFAULT_MODEL_ID = 'stable-audio-2.5';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Stability AI audio generation provider.
 *
 * @example
 * ```typescript
 * const config: StableAudioProviderConfig = {
 *   apiKey: process.env.STABILITY_API_KEY!,
 *   defaultModelId: 'stable-audio-2.5',
 * };
 * ```
 */
export interface StableAudioProviderConfig {
  /** Stability AI API key. Sent as `Authorization: Bearer ${apiKey}`. */
  apiKey: string;

  /**
   * Base URL for the Stability AI API. Override for testing or proxy setups.
   * @default 'https://api.stability.ai/v2beta'
   */
  baseURL?: string;

  /**
   * Default model to use when the request doesn't specify one
   * (`stable-audio-2.5` or `stable-audio-2`).
   * @default 'stable-audio-2.5'
   */
  defaultModelId?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Audio generation provider connecting to the Stability AI Stable Audio API.
 *
 * Implements a synchronous request pattern: a single POST request returns
 * the generated audio data directly. Supports both music and SFX generation.
 *
 * @implements {IAudioGenerator}
 *
 * @example
 * ```typescript
 * const provider = new StableAudioProvider();
 * await provider.initialize({ apiKey: process.env.STABILITY_API_KEY! });
 *
 * const result = await provider.generateMusic({
 *   prompt: 'Upbeat electronic dance track with heavy bass',
 *   durationSec: 30,
 * });
 * console.log(result.audio[0].url);
 * ```
 */
export class StableAudioProvider implements IAudioGenerator {
  /** @inheritdoc */
  public readonly providerId = 'stable-audio';

  /** @inheritdoc */
  public isInitialized = false;

  /** @inheritdoc */
  public defaultModelId?: string;

  /** Internal resolved configuration. */
  private _config!: Required<Pick<StableAudioProviderConfig, 'apiKey' | 'baseURL'>> & StableAudioProviderConfig;
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
      throw new Error('Stable Audio provider requires apiKey (STABILITY_API_KEY).');
    }

    this._config = {
      apiKey,
      baseURL:
        typeof config.baseURL === 'string' && config.baseURL.trim()
          ? config.baseURL.trim()
          : 'https://api.stability.ai/v2beta',
      defaultModelId:
        typeof config.defaultModelId === 'string' && config.defaultModelId.trim()
          ? config.defaultModelId.trim()
          : DEFAULT_MODEL_ID,
    };

    this.defaultModelId = this._config.defaultModelId;
    this.keyPool = new ApiKeyPool(apiKey);
    this.isInitialized = true;
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  /**
   * Generate music from a text prompt using the Stability AI audio endpoint.
   *
   * @param request - Music generation request with prompt and optional params.
   * @returns The generated audio result envelope.
   *
   * @throws {Error} If the provider is not initialized.
   * @throws {Error} If the API returns an error.
   */
  async generateMusic(request: MusicGenerateRequest): Promise<AudioResult> {
    if (!this.isInitialized) {
      throw new Error('Stable Audio provider is not initialized. Call initialize() first.');
    }

    return this._generate(request);
  }

  /**
   * Generate a sound effect from a text prompt using the Stability AI audio endpoint.
   *
   * @param request - SFX generation request with prompt and optional params.
   * @returns The generated audio result envelope.
   *
   * @throws {Error} If the provider is not initialized.
   * @throws {Error} If the API returns an error.
   */
  async generateSFX(request: SFXGenerateRequest): Promise<AudioResult> {
    if (!this.isInitialized) {
      throw new Error('Stable Audio provider is not initialized. Call initialize() first.');
    }

    return this._generate(request);
  }

  // -------------------------------------------------------------------------
  // Capability query
  // -------------------------------------------------------------------------

  /**
   * Stable Audio supports both music and SFX generation.
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
   * Send a synchronous request to the Stable Audio 2 text-to-audio endpoint.
   *
   * The body is `multipart/form-data`; `fetch` sets the `Content-Type` header
   * with its boundary, so none is set here. With `Accept: audio/*` the
   * response body is the audio bytes, converted to base64 for the envelope.
   *
   * @param request - Music or SFX request (prompt, duration, model, format,
   *   seed and provider options).
   * @returns Normalized audio result envelope.
   *
   * @throws {Error} If the HTTP request fails.
   * @internal
   */
  private async _generate(
    request: MusicGenerateRequest | SFXGenerateRequest,
  ): Promise<AudioResult> {
    const model = request.modelId || this.defaultModelId || DEFAULT_MODEL_ID;
    const outputFormat = request.outputFormat === 'wav' ? 'wav' : 'mp3';
    const durationSec = request.durationSec;
    const url = `${this._config.baseURL}/audio/stable-audio-2/text-to-audio`;

    const form = new FormData();
    form.append('prompt', request.prompt);
    form.append('model', model);
    form.append('output_format', outputFormat);
    if (durationSec !== undefined) form.append('duration', String(durationSec));
    if (request.seed !== undefined) form.append('seed', String(request.seed));
    for (const [key, value] of Object.entries(request.providerOptions ?? {})) {
      if (form.has(key)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        form.append(key, String(value));
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.keyPool.next()}`,
        Accept: 'audio/*',
      },
      body: form,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Stable Audio generation failed (${response.status}): ${errorText}`);
    }

    // The API returns raw audio bytes. Convert to base64 for the result envelope.
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      audio: [{
        base64,
        mimeType: outputFormat === 'wav' ? 'audio/wav' : 'audio/mpeg',
        durationSec,
        providerMetadata: {},
      }],
      usage: {
        totalAudioClips: 1,
      },
    };
  }
}
