/**
 * @file generateMusic.ts
 * Provider-agnostic music generation for the AgentOS high-level API.
 *
 * Resolves a music generation provider from explicit `opts.provider`, or by
 * probing environment variables in priority order:
 * `SUNO_API_KEY` -> `UDIO_API_KEY` -> `STABILITY_API_KEY` -> `REPLICATE_API_TOKEN` ->
 * `FAL_API_KEY` -> `MINIMAX_API_KEY` -> (local MusicGen — no key required).
 *
 * When multiple music-capable providers are configured (via env vars), the
 * primary provider is wrapped in a {@link FallbackAudioProxy} so that a
 * transient failure automatically retries on the next available provider.
 *
 * Supports an optional {@link MediaProviderPreference} to reorder or filter
 * the fallback chain at the caller's discretion.
 */
import { EventEmitter } from 'events';
import { createAudioProvider, hasAudioProviderFactory } from '../io/media/audio/index.js';
import { FallbackAudioProxy } from '../io/media/audio/FallbackAudioProxy.js';
import type { IAudioGenerator } from '../io/media/audio/IAudioGenerator.js';
import type {
  AudioResult,
  AudioOutputFormat,
  AudioProgressEvent,
} from '../io/media/audio/types.js';
import {
  resolveProviderChain,
  resolveProviderOrder,
  type MediaProviderPreference,
} from '../io/media/ProviderPreferences.js';
import { attachUsageAttributes, toTurnMetricUsage } from './observability.js';
import { recordAgentOSUsage, type AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';
import { recordAgentOSTurnMetrics, withAgentOSSpan } from '../safety/evaluation/observability/otel.js';

// ---------------------------------------------------------------------------
// Music provider fallback chain builder
// ---------------------------------------------------------------------------

/**
 * Env-var to provider-id mapping used to detect which music providers have
 * credentials configured in the current environment. Order determines
 * fallback priority (first = highest priority).
 *
 * The final entry (`musicgen-local`) has no env key requirement — it runs
 * on the local machine via HuggingFace Transformers.js.
 */
const MUSIC_PROVIDER_ENV_MAP: Array<{ envKey: string | null; providerId: string }> = [
  { envKey: 'SUNO_API_KEY', providerId: 'suno' },
  { envKey: 'UDIO_API_KEY', providerId: 'udio' },
  { envKey: 'STABILITY_API_KEY', providerId: 'stable-audio' },
  { envKey: 'REPLICATE_API_TOKEN', providerId: 'replicate-audio' },
  { envKey: 'FAL_API_KEY', providerId: 'fal-audio' },
  { envKey: 'MINIMAX_API_KEY', providerId: 'minimax-music' },
  { envKey: null, providerId: 'musicgen-local' },
];

/** Shared emitter for music fallback events (singleton per process). */
const musicFallbackEmitter = new EventEmitter();

function emitAudioProgress(
  callback: ((event: AudioProgressEvent) => void) | undefined,
  status: AudioProgressEvent['status'],
  progress: number,
  message: string,
): void {
  if (!callback) return;
  try {
    callback({ status, progress, message });
  } catch {
    // Progress callbacks are best-effort and must not break generation.
  }
}

/**
 * Detects the first available music provider from environment variables.
 *
 * Scans the {@link MUSIC_PROVIDER_ENV_MAP} in priority order and returns
 * the first provider whose API key env var is set (or whose factory is
 * registered with no key requirement, e.g. `musicgen-local`).
 *
 * @returns The provider ID and API key, or `undefined` when no music
 *   provider is available.
 */
function autoDetectMusicProvider(): { providerId: string; apiKey: string } | undefined {
  const providerId = detectAvailableMusicProviders()[0];
  if (!providerId) return undefined;
  const entry = MUSIC_PROVIDER_ENV_MAP.find((candidate) => candidate.providerId === providerId);
  return {
    providerId,
    apiKey: entry?.envKey ? (process.env[entry.envKey] ?? '') : '',
  };
}

/**
 * Detects all music providers available in the current environment.
 *
 * @returns Provider IDs in priority order.
 */
function detectAvailableMusicProviders(): string[] {
  const available: string[] = [];
  for (const { envKey, providerId } of MUSIC_PROVIDER_ENV_MAP) {
    if (!hasAudioProviderFactory(providerId)) continue;
    if (envKey !== null && !process.env[envKey]) continue;
    available.push(providerId);
  }
  return available;
}

/**
 * Detects all music providers with valid credentials in the environment
 * and returns their provider IDs in priority order, excluding the primary.
 *
 * @param primaryProviderId - The provider that was explicitly selected; it
 *   is excluded from the fallback list since it is already first in line.
 * @returns An array of provider IDs suitable for fallback, in priority order.
 */
function detectFallbackMusicProviders(primaryProviderId: string): string[] {
  const fallbacks: string[] = [];
  for (const { envKey, providerId } of MUSIC_PROVIDER_ENV_MAP) {
    if (providerId === primaryProviderId) continue;
    if (!hasAudioProviderFactory(providerId)) continue;
    if (envKey !== null && !process.env[envKey]) continue;
    fallbacks.push(providerId);
  }
  return fallbacks;
}

/**
 * Resolves the API key environment variable name for a known music provider.
 *
 * @param providerId - The provider identifier.
 * @returns The environment variable name, or a generic fallback.
 */
function envKeyForMusicProvider(providerId: string): string {
  const entry = MUSIC_PROVIDER_ENV_MAP.find((e) => e.providerId === providerId);
  if (entry?.envKey) return entry.envKey;
  return `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/**
 * Creates an {@link IAudioGenerator} for a resolved music provider chain,
 * optionally wrapped in a {@link FallbackAudioProxy} when multiple
 * music-capable providers are available.
 *
 * @param providerChain - Ordered provider IDs with the primary first and
 *   optional fallbacks after it.
 * @param apiKey - API key for the primary provider.
 * @param modelId - Optional model identifier override.
 * @returns An initialised audio provider (possibly a fallback proxy).
 */
async function createMusicProviderWithFallback(
  providerChain: string[],
  apiKey: string,
  modelId?: string,
  timeoutMs?: number,
): Promise<IAudioGenerator> {
  if (providerChain.length === 0) {
    throw new Error('No music providers available in the resolved provider chain.');
  }

  const [providerId, ...fallbackIds] = providerChain;
  const primary = createAudioProvider(providerId);
  await primary.initialize({
    apiKey,
    ...(modelId ? { defaultModelId: modelId } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });

  if (fallbackIds.length === 0) {
    return primary;
  }

  // Build and initialise fallback providers. Failures during init are
  // silently skipped — the provider simply won't be part of the chain.
  const chain: IAudioGenerator[] = [primary];
  for (const fbId of fallbackIds) {
    try {
      const entry = MUSIC_PROVIDER_ENV_MAP.find((e) => e.providerId === fbId);
      const fbKey = entry?.envKey ? (process.env[entry.envKey] ?? '') : '';
      const fb = createAudioProvider(fbId);
      await fb.initialize({
        apiKey: fbKey,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      chain.push(fb);
    } catch {
      // Skip providers that fail to initialise (missing creds, etc.).
    }
  }

  if (chain.length <= 1) {
    return primary;
  }

  return new FallbackAudioProxy(chain, musicFallbackEmitter);
}

// ---------------------------------------------------------------------------
// Public options / result types
// ---------------------------------------------------------------------------

/**
 * Options for a {@link generateMusic} call.
 *
 * At minimum, a `prompt` is required. The provider is resolved from
 * `opts.provider`, `opts.apiKey`, or the first music-capable env var found
 * (`SUNO_API_KEY` -> `UDIO_API_KEY` -> `STABILITY_API_KEY` -> `REPLICATE_API_TOKEN` ->
 * `FAL_API_KEY` -> `MINIMAX_API_KEY` -> local MusicGen).
 */
export interface GenerateMusicOptions {
  /** Text prompt describing the desired musical composition. */
  prompt: string;

  /**
   * Explicit provider identifier (e.g. `"suno"`, `"stable-audio"`, `"musicgen-local"`).
   * When omitted, auto-detection from environment variables is used.
   */
  provider?: string;

  /**
   * Model identifier within the provider (e.g. `"suno-v3.5"`,
   * `"stable-audio-open-1.0"`). When omitted, the provider's default
   * model is used.
   */
  model?: string;

  /** Desired output duration in seconds. Provider limits vary. */
  durationSec?: number;

  /** Negative prompt describing musical elements to avoid. */
  negativePrompt?: string;

  /** Output audio format (e.g. `"mp3"`, `"wav"`). Defaults to provider default. */
  outputFormat?: AudioOutputFormat;

  /** Random seed for reproducible generation (provider-dependent). */
  seed?: number;

  /**
   * Maximum time in milliseconds to wait for generation to complete.
   * Provider-dependent — polling providers enforce this directly.
   */
  timeoutMs?: number;

  /** Number of audio clips to generate. Defaults to 1. */
  n?: number;

  /**
   * Optional progress callback invoked during long-running generation.
   * Called with an {@link AudioProgressEvent} at each status transition.
   */
  onProgress?: (event: AudioProgressEvent) => void;

  /** Override the provider API key instead of reading from env vars. */
  apiKey?: string;

  /** Optional user identifier forwarded to the provider for billing. */
  userId?: string;

  /** Arbitrary provider-specific options. */
  providerOptions?: Record<string, unknown>;

  /**
   * Provider preferences for reordering or filtering the fallback chain.
   * When supplied, the available providers are reordered according to
   * `preferred` and filtered by `blocked` before building the chain.
   */
  providerPreferences?: MediaProviderPreference;

  /** Optional durable usage ledger configuration for accounting. */
  usageLedger?: AgentOSUsageLedgerOptions;
}

/**
 * The result returned by {@link generateMusic}.
 *
 * Wraps the core {@link AudioResult} with a simpler, AI-SDK-style shape.
 */
export interface GenerateMusicResult {
  /** Model identifier reported by the provider. */
  model: string;
  /** Provider identifier (e.g. `"suno"`, `"stable-audio"`). */
  provider: string;
  /** Unix timestamp (seconds) when the audio was created. */
  created: number;
  /** Array of generated audio objects containing URLs or base64 data. */
  audio: AudioResult['audio'];
  /** Usage / billing information, if available. */
  usage?: AudioResult['usage'];
}

// ---------------------------------------------------------------------------
// Main API function
// ---------------------------------------------------------------------------

/**
 * Generates music using a provider-agnostic interface.
 *
 * Resolves provider credentials via explicit options or environment variable
 * auto-detection, initialises the matching audio provider (optionally wrapped
 * in a fallback chain), and returns a normalised {@link GenerateMusicResult}.
 *
 * @param opts - Music generation options.
 * @returns A promise resolving to the generation result with audio data and metadata.
 *
 * @example
 * ```ts
 * const result = await generateMusic({
 *   prompt: 'Upbeat lo-fi hip hop beat with vinyl crackle and mellow piano',
 *   durationSec: 60,
 * });
 * console.log(result.audio[0].url);
 * ```
 */
export async function generateMusic(opts: GenerateMusicOptions): Promise<GenerateMusicResult> {
  const startedAt = Date.now();
  let metricStatus: 'ok' | 'error' = 'ok';
  let metricUsage: AudioResult['usage'];
  let metricProviderId: string | undefined;
  let metricModelId: string | undefined;

  try {
    return await withAgentOSSpan('agentos.api.generate_music', async (span) => {
      // --- Resolve provider ---
      let providerId: string;
      let apiKey: string;
      let providerChain: string[];

      if (opts.provider) {
        providerId = opts.provider;
        apiKey =
          opts.apiKey ??
          process.env[envKeyForMusicProvider(providerId)] ??
          '';
        // Local providers don't need keys
        if (!apiKey && providerId !== 'musicgen-local') {
          throw new Error(
            `No API key for music provider "${providerId}". Set ${envKeyForMusicProvider(providerId)} or pass apiKey.`,
          );
        }
        let fallbackIds = detectFallbackMusicProviders(providerId);
        if (opts.providerPreferences) {
          const ordered = resolveProviderOrder([providerId, ...fallbackIds], opts.providerPreferences);
          fallbackIds = ordered.filter((id) => id !== providerId);
        }
        providerChain = [providerId, ...fallbackIds];
      } else if (opts.apiKey) {
        // Caller supplied a key but no provider — try auto-detect anyway
        const detected = autoDetectMusicProvider();
        providerId = detected?.providerId ?? 'suno';
        apiKey = opts.apiKey;
        let fallbackIds = detectFallbackMusicProviders(providerId);
        if (opts.providerPreferences) {
          const ordered = resolveProviderOrder([providerId, ...fallbackIds], opts.providerPreferences);
          fallbackIds = ordered.filter((id) => id !== providerId);
        }
        providerChain = [providerId, ...fallbackIds];
      } else {
        providerChain = resolveProviderChain(
          detectAvailableMusicProviders(),
          opts.providerPreferences,
        );
        if (providerChain.length === 0) {
          throw new Error(
            'No music provider configured. Set SUNO_API_KEY, UDIO_API_KEY, STABILITY_API_KEY, REPLICATE_API_TOKEN, FAL_API_KEY, or MINIMAX_API_KEY.',
          );
        }
        providerId = providerChain[0];
        apiKey = process.env[envKeyForMusicProvider(providerId)] ?? '';
      }

      metricProviderId = providerId;
      metricModelId = opts.model;
      emitAudioProgress(opts.onProgress, 'queued', 0, `Queued music generation with ${providerId}.`);

      span?.setAttribute('llm.provider', providerId);
      if (opts.model) span?.setAttribute('llm.model', opts.model);

      // --- Create provider (with fallback chain) ---
      const provider = await createMusicProviderWithFallback(
        providerChain,
        apiKey,
        opts.model,
        opts.timeoutMs,
      );

      if (!provider.supports('music')) {
        throw new Error(`Provider "${providerId}" does not support music generation.`);
      }
      emitAudioProgress(opts.onProgress, 'processing', 25, `Generating music with ${providerId}.`);

      // --- Dispatch to generateMusic ---
      const result = await provider.generateMusic({
        prompt: opts.prompt,
        modelId:
          provider instanceof FallbackAudioProxy
            ? undefined
            : (opts.model ?? provider.defaultModelId),
        durationSec: opts.durationSec,
        negativePrompt: opts.negativePrompt,
        outputFormat: opts.outputFormat,
        seed: opts.seed,
        n: opts.n,
        userId: opts.userId,
        providerOptions: opts.providerOptions,
      });

      metricUsage = result.usage;
      metricModelId = result.modelId;
      span?.setAttribute('agentos.api.audio_clips_count', result.audio.length);

      if (result.usage?.totalCostUSD !== undefined) {
        attachUsageAttributes(span, { totalCostUSD: result.usage.totalCostUSD });
      }
      emitAudioProgress(opts.onProgress, 'complete', 100, 'Music generation complete.');

      return {
        model: result.modelId,
        provider: result.providerId,
        created: result.created,
        audio: result.audio,
        usage: result.usage,
      };
    });
  } catch (error) {
    metricStatus = 'error';
    emitAudioProgress(
      opts.onProgress,
      'failed',
      100,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  } finally {
    try {
      await recordAgentOSUsage({
        providerId: metricProviderId,
        modelId: metricModelId,
        usage: metricUsage
          ? {
              totalTokens: metricUsage.totalAudioClips,
              costUSD: metricUsage.totalCostUSD,
            }
          : undefined,
        options: {
          ...opts.usageLedger,
          source: opts.usageLedger?.source ?? 'generateMusic',
        },
      });
    } catch {
      // Usage persistence is best-effort and should not break generation.
    }
    recordAgentOSTurnMetrics({
      durationMs: Date.now() - startedAt,
      status: metricStatus,
      usage: toTurnMetricUsage(
        metricUsage
          ? { totalCostUSD: metricUsage.totalCostUSD }
          : undefined,
      ),
    });
  }
}
