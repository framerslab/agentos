/**
 * @file types.ts
 * Core type definitions for the audio generation subsystem.
 *
 * These types are consumed by {@link IAudioGenerator}, {@link FallbackAudioProxy},
 * and concrete provider implementations (Suno, Udio, Stable Audio,
 * ElevenLabs SFX, etc.) to provide a unified audio pipeline across multiple
 * provider backends.
 *
 * Audio generation is split into two sub-modalities:
 *
 * - **Music** — full-length musical compositions from text prompts (Suno, Udio,
 *   Stable Audio).
 * - **SFX** — short sound effects from text descriptions (ElevenLabs, Stable
 *   Audio).
 *
 * Not all providers support both; capability negotiation is handled via
 * {@link IAudioGenerator.supports}.
 */

// ---------------------------------------------------------------------------
// Common enums / branded types
// ---------------------------------------------------------------------------

/** Well-known audio provider identifiers. Extensible via `(string & {})`. */
export type AudioProviderId =
  | 'minimax-music'
  | 'suno'
  | 'udio'
  | 'stable-audio'
  | 'elevenlabs-sfx'
  | 'replicate-audio'
  | 'fal-audio'
  | 'musicgen-local'
  | 'audiogen-local'
  | (string & {});

/** Output audio container/codec format. */
export type AudioOutputFormat = 'mp3' | 'wav' | 'flac' | 'ogg' | 'aac';

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

/**
 * Aggregated usage / billing counters for an audio generation session.
 *
 * Providers that report cost or timing information populate the optional
 * fields; the minimum required field is {@link totalAudioClips}.
 */
export interface AudioProviderUsage {
  /** Number of audio clips generated in this session. */
  totalAudioClips: number;

  /** Total cost in USD, if the provider reports it. */
  totalCostUSD?: number;

  /** Total processing time in milliseconds. */
  processingTimeMs?: number;
}

// ---------------------------------------------------------------------------
// Generation requests
// ---------------------------------------------------------------------------

/**
 * Request payload for music generation from a text prompt.
 *
 * Passed to {@link IAudioGenerator.generateMusic} by the high-level
 * orchestration layer after normalising user input.
 *
 * @example
 * ```typescript
 * const request: MusicGenerateRequest = {
 *   prompt: 'Upbeat lo-fi hip hop beat with vinyl crackle and mellow piano',
 *   durationSec: 60,
 *   outputFormat: 'mp3',
 * };
 * ```
 */
export interface MusicGenerateRequest {
  /**
   * Text prompt describing the desired musical composition.
   *
   * Quality and specificity of the prompt directly influence output quality.
   * Include genre, mood, instrumentation, and tempo for best results.
   */
  prompt: string;

  /**
   * Model identifier to use for generation.
   *
   * When omitted the provider falls back to its {@link IAudioGenerator.defaultModelId}.
   */
  modelId?: string;

  /**
   * Desired output duration in seconds.
   *
   * Provider limits vary: Suno caps at ~240s, Stable Audio at ~47s.
   * Exceeding the limit may result in truncation or an error.
   */
  durationSec?: number;

  /**
   * Negative prompt describing musical elements to avoid.
   *
   * Not all providers support negative prompts — unsupported values are
   * silently ignored by the adapter.
   */
  negativePrompt?: string;

  /**
   * Output audio format.
   *
   * @default 'mp3'
   */
  outputFormat?: AudioOutputFormat;

  /**
   * Seed for reproducible output.
   *
   * Not all providers honour seeds — check provider documentation.
   */
  seed?: number;

  /**
   * Number of audio clips to generate.
   *
   * @default 1
   */
  n?: number;

  /** Identifier of the requesting user (for billing / rate limiting). */
  userId?: string;

  /** Arbitrary provider-specific options. */
  providerOptions?: Record<string, unknown>;
}

/**
 * Request payload for sound-effect generation from a text prompt.
 *
 * Passed to {@link IAudioGenerator.generateSFX} by the high-level
 * orchestration layer after normalising user input.
 *
 * @example
 * ```typescript
 * const request: SFXGenerateRequest = {
 *   prompt: 'Thunder crack followed by heavy rain on a tin roof',
 *   durationSec: 5,
 * };
 * ```
 */
export interface SFXGenerateRequest {
  /**
   * Text prompt describing the desired sound effect.
   *
   * Be specific about the sound, its environment, and any layering
   * (e.g. "glass breaking on a marble floor in a large hall with reverb").
   */
  prompt: string;

  /**
   * Model identifier to use for generation.
   *
   * When omitted the provider falls back to its {@link IAudioGenerator.defaultModelId}.
   */
  modelId?: string;

  /**
   * Desired output duration in seconds.
   *
   * SFX clips are typically short (1-15 seconds). Providers may enforce
   * their own limits.
   */
  durationSec?: number;

  /**
   * Output audio format.
   *
   * @default 'mp3'
   */
  outputFormat?: AudioOutputFormat;

  /**
   * Seed for reproducible output.
   *
   * Not all providers honour seeds — check provider documentation.
   */
  seed?: number;

  /**
   * Number of audio clips to generate.
   *
   * @default 1
   */
  n?: number;

  /** Identifier of the requesting user (for billing / rate limiting). */
  userId?: string;

  /** Arbitrary provider-specific options. */
  providerOptions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Generation results
// ---------------------------------------------------------------------------

/**
 * A single generated audio artifact.
 *
 * At least one of {@link url} or {@link base64} will be populated depending
 * on the provider's response format.
 */
export interface GeneratedAudio {
  /** Public URL where the audio can be downloaded. */
  url?: string;

  /** Base64-encoded audio data. */
  base64?: string;

  /** MIME type of the audio (e.g. `'audio/mpeg'`, `'audio/wav'`). */
  mimeType?: string;

  /** Duration of the generated audio in seconds. */
  durationSec?: number;

  /** Sample rate in Hz (e.g. `44100`, `48000`). */
  sampleRate?: number;

  /** Provider-specific metadata (job ID, generation params, etc.). */
  providerMetadata?: Record<string, unknown>;
}

/**
 * Result envelope returned by {@link IAudioGenerator.generateMusic} and
 * {@link IAudioGenerator.generateSFX}.
 *
 * Follows the same envelope pattern used by {@link VideoResult} in the video
 * subsystem: a timestamp, model/provider IDs, the generated artifact(s), and
 * optional usage/billing information.
 *
 * @example
 * ```typescript
 * const result: AudioResult = {
 *   created: Math.floor(Date.now() / 1000),
 *   modelId: 'suno-v3.5',
 *   providerId: 'suno',
 *   audio: [{ url: 'https://cdn.suno.ai/abc123.mp3', mimeType: 'audio/mpeg' }],
 *   usage: { totalAudioClips: 1 },
 * };
 * ```
 */
export interface AudioResult {
  /** Unix timestamp (seconds) when the result was created. */
  created: number;

  /** Model identifier that produced the result. */
  modelId: string;

  /** Provider identifier that produced the result. */
  providerId: string;

  /** The generated audio clip(s). */
  audio: GeneratedAudio[];

  /** Usage / billing information, if available. */
  usage?: AudioProviderUsage;
}

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------

/**
 * Typed progress event emitted during audio generation.
 *
 * The generation lifecycle flows through these statuses in order:
 * `queued` -> `processing` -> `downloading` -> `complete` (or `failed`
 * at any point).
 *
 * Not all providers emit all statuses — synchronous providers (Stable Audio,
 * ElevenLabs) may jump directly from `processing` to `complete`.
 *
 * @example
 * ```typescript
 * emitter.on('audio:progress', (evt: AudioProgressEvent) => {
 *   console.log(`[${evt.status}] ${evt.progress ?? '?'}% — ${evt.message}`);
 * });
 * ```
 */
export interface AudioProgressEvent {
  /**
   * Current status of the generation job.
   *
   * - `'queued'`      — Request accepted, waiting for processing slot
   * - `'processing'`  — Actively generating audio
   * - `'downloading'` — Generation complete, downloading result
   * - `'complete'`    — Fully done, result available
   * - `'failed'`      — Terminal error, see {@link message}
   */
  status: 'queued' | 'processing' | 'downloading' | 'complete' | 'failed';

  /**
   * Estimated progress percentage (0-100).
   *
   * Not all providers report granular progress; may remain `undefined`
   * until the final status transition.
   */
  progress?: number;

  /**
   * Estimated time remaining in milliseconds.
   *
   * Only available when the provider reports ETA information.
   */
  estimatedRemainingMs?: number;

  /** Human-readable status message or error description. */
  message?: string;
}
