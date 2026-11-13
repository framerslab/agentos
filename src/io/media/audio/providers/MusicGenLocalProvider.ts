/**
 * @module media/audio/providers/MusicGenLocalProvider
 *
 * Local music generation provider using Meta's MusicGen model via
 * the `@huggingface/transformers` library.
 *
 * MusicGen runs entirely on the local machine without any API keys or
 * network requests. The model is loaded lazily on first use through the
 * `pipeline('text-to-audio', ...)` API from HuggingFace Transformers.js.
 *
 * ## Requirements
 *
 * - `@huggingface/transformers` must be installed as a peer dependency.
 *   If not installed, the provider throws a helpful error message.
 * - Sufficient RAM/VRAM for model inference (Xenova/musicgen-small ~1GB).
 *
 * ## Supported models
 *
 * | Model ID                   | Description                       |
 * |----------------------------|-----------------------------------|
 * | `Xenova/musicgen-small`    | MusicGen Small — default, ~1GB    |
 *
 * ## API flow (local inference)
 *
 * 1. **Load** — `pipeline('text-to-audio', modelId)` (lazy, cached).
 * 2. **Generate** — `pipeline(prompt, { max_new_tokens })` returns audio tensor.
 * 3. **Encode** — Convert raw audio data to WAV format.
 *
 * @see {@link IAudioGenerator} for the provider interface contract.
 * @see {@link AudioGenLocalProvider} for the SFX counterpart.
 */

import type { IAudioGenerator } from '../IAudioGenerator.js';
import type { MusicGenerateRequest, SFXGenerateRequest, AudioResult } from '../types.js';
import { importOptional } from '../../../../core/utils/importOptional.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the MusicGen local provider.
 *
 * @example
 * ```typescript
 * const config: MusicGenLocalProviderConfig = {
 *   modelId: 'Xenova/musicgen-small',
 * };
 * ```
 */
export interface MusicGenLocalProviderConfig {
  /**
   * HuggingFace model ID for the MusicGen model.
   * @default 'Xenova/musicgen-small'
   */
  modelId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Encode raw PCM float32 audio samples into a WAV file buffer.
 *
 * Creates a minimal WAV header (44 bytes) followed by 16-bit PCM samples
 * at the specified sample rate.
 *
 * @param samples - Float32 audio samples (range -1 to 1).
 * @param sampleRate - Sample rate in Hz (e.g. 32000).
 * @returns A Buffer containing valid WAV file data.
 * @internal
 */
function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Write 16-bit PCM samples
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    buffer.writeInt16LE(Math.round(int16), headerSize + i * 2);
  }

  return buffer;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Local music generation provider using Meta's MusicGen model.
 *
 * Runs inference entirely on the local machine via `@huggingface/transformers`.
 * The model is loaded lazily on first call to `generateMusic()` or
 * explicitly via `initialize()`.
 *
 * @implements {IAudioGenerator}
 *
 * @example
 * ```typescript
 * const provider = new MusicGenLocalProvider();
 * await provider.initialize({ modelId: 'Xenova/musicgen-small' });
 *
 * const result = await provider.generateMusic({
 *   prompt: 'A calm ambient soundscape with synth pads',
 *   durationSec: 10,
 * });
 * console.log(result.audio[0].base64?.substring(0, 50) + '...');
 * ```
 */
export class MusicGenLocalProvider implements IAudioGenerator {
  /** @inheritdoc */
  public readonly providerId = 'musicgen-local';

  /** @inheritdoc */
  public isInitialized = false;

  /** @inheritdoc */
  public defaultModelId?: string;

  /** The loaded text-to-audio pipeline instance. */
  private _pipeline: unknown = null;

  /** The resolved model ID. */
  private _modelId = 'Xenova/musicgen-small';

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the provider and optionally pre-load the model.
   *
   * The model is loaded lazily on first generation call. Calling initialize
   * sets the configuration but does not load the model unless the pipeline
   * was already created.
   *
   * @param config - Configuration object with optional `modelId`.
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    if (typeof config.modelId === 'string' && config.modelId.trim()) {
      this._modelId = config.modelId.trim();
    }

    this.defaultModelId = this._modelId;
    this.isInitialized = true;
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  /**
   * Generate music from a text prompt using the local MusicGen model.
   *
   * On first call, loads the model pipeline (may take several seconds).
   * Subsequent calls reuse the cached pipeline instance.
   *
   * @param request - Music generation request with prompt and optional params.
   * @returns The generated audio result envelope with base64-encoded WAV data.
   *
   * @throws {Error} If the provider is not initialized.
   * @throws {Error} If `@huggingface/transformers` is not installed.
   */
  async generateMusic(request: MusicGenerateRequest): Promise<AudioResult> {
    if (!this.isInitialized) {
      throw new Error('MusicGen local provider is not initialized. Call initialize() first.');
    }

    const pipe = await this._ensurePipeline();
    const modelId = request.modelId || this._modelId;

    // Estimate max_new_tokens from duration. MusicGen generates at ~50 tokens/second.
    const durationSec = request.durationSec ?? 10;
    const maxNewTokens = Math.ceil(durationSec * 50);

    const output = await (pipe as CallableFunction)(request.prompt, { max_new_tokens: maxNewTokens });

    // The pipeline returns { audio: Float32Array, sampling_rate: number }
    const audioData = output as { audio: Float32Array; sampling_rate: number };
    const wavBuffer = encodeWav(audioData.audio, audioData.sampling_rate);
    const base64 = wavBuffer.toString('base64');

    return {
      created: Math.floor(Date.now() / 1000),
      modelId,
      providerId: this.providerId,
      audio: [{
        base64,
        mimeType: 'audio/wav',
        durationSec,
        providerMetadata: {
          sampleRate: audioData.sampling_rate,
          totalSamples: audioData.audio.length,
        },
      }],
      usage: {
        totalAudioClips: 1,
      },
    };
  }

  /**
   * SFX generation is not supported by MusicGen.
   *
   * @throws {Error} Always throws — use {@link AudioGenLocalProvider} instead.
   */
  async generateSFX(_request: SFXGenerateRequest): Promise<AudioResult> {
    throw new Error(
      'MusicGen local provider does not support SFX generation. Use AudioGenLocalProvider instead.',
    );
  }

  // -------------------------------------------------------------------------
  // Capability query
  // -------------------------------------------------------------------------

  /**
   * MusicGen supports music generation only.
   *
   * @param capability - The capability to check.
   * @returns `true` only for `'music'`; `false` for `'sfx'`.
   */
  supports(capability: 'music' | 'sfx'): boolean {
    return capability === 'music';
  }

  /**
   * Release model resources and reset initialization state.
   */
  async shutdown(): Promise<void> {
    this._pipeline = null;
    this.isInitialized = false;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Ensure the text-to-audio pipeline is loaded, creating it lazily if needed.
   *
   * Uses dynamic `import()` to load `@huggingface/transformers` as an optional
   * peer dependency. Throws a helpful error if the package is not installed.
   *
   * @returns The loaded pipeline callable.
   *
   * @throws {Error} If `@huggingface/transformers` is not installed.
   * @internal
   */
  private async _ensurePipeline(): Promise<unknown> {
    if (this._pipeline) return this._pipeline;

    let transformers: { pipeline: (...args: unknown[]) => Promise<unknown> };
    try {
      transformers = await importOptional('@huggingface/transformers');
    } catch {
      throw new Error(
        'MusicGen local provider requires @huggingface/transformers. '
        + 'Install it with: npm install @huggingface/transformers',
      );
    }

    this._pipeline = await transformers.pipeline('text-to-audio', this._modelId);
    return this._pipeline;
  }
}
