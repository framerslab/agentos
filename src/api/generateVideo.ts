/**
 * @file generateVideo.ts
 * Provider-agnostic video generation for the AgentOS high-level API.
 *
 * Resolves a video generation provider from explicit `opts.provider`, or by
 * probing environment variables in priority order:
 * `RUNWAY_API_KEY` -> `REPLICATE_API_TOKEN` -> `FAL_API_KEY`. The `gemini`
 * provider (`GEMINI_API_KEY`) runs only when `opts.provider` names it, so a
 * Gemini key set for text never starts a video job on its own.
 *
 * When multiple video-capable providers are configured (via env vars), the
 * primary provider is wrapped in a {@link FallbackVideoProxy} so that a
 * transient failure automatically retries on the next available provider.
 *
 * Supports both text-to-video and image-to-video: when `opts.image` is
 * provided, the request is dispatched to {@link IVideoGenerator.imageToVideo};
 * otherwise {@link IVideoGenerator.generateVideo} is used.
 */
import { EventEmitter } from 'events';
import { createVideoProvider, hasVideoProviderFactory } from '../io/media/video/index.js';
import { FallbackVideoProxy } from '../io/media/video/FallbackVideoProxy.js';
import type {
  IVideoGenerator,
  VideoResult,
  VideoProgressEvent,
  VideoAspectRatio,
  VideoImageInput,
  VideoProviderOptionBag,
} from '../io/media/video/index.js';
import { hasVideoImage } from '../io/media/video/videoInputs.js';
import {
  resolveProviderChain,
  resolveProviderOrder,
  type MediaProviderPreference,
} from '../io/media/ProviderPreferences.js';
import { attachUsageAttributes, toTurnMetricUsage } from './observability.js';
import { recordAgentOSUsage, type AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';
import { recordAgentOSTurnMetrics, withAgentOSSpan } from '../safety/evaluation/observability/otel.js';

// ---------------------------------------------------------------------------
// Video provider fallback chain builder
// ---------------------------------------------------------------------------

/**
 * Env-var to provider-id mapping used to detect which video providers have
 * credentials configured in the current environment. Order determines
 * fallback priority (first = highest priority).
 */
const VIDEO_PROVIDER_ENV_MAP: Array<{ envKey: string; providerId: string }> = [
  { envKey: 'RUNWAY_API_KEY', providerId: 'runway' },
  { envKey: 'REPLICATE_API_TOKEN', providerId: 'replicate' },
  { envKey: 'FAL_API_KEY', providerId: 'fal' },
];

/**
 * Providers that run only when the call names them, with the env var their
 * key is read from. They never join auto-detection or a fallback chain.
 */
const EXPLICIT_VIDEO_PROVIDER_ENV_MAP: Array<{ envKey: string; providerId: string }> = [
  { envKey: 'GEMINI_API_KEY', providerId: 'gemini' },
];

/** Shared emitter for video fallback events (singleton per process). */
const videoFallbackEmitter = new EventEmitter();

function emitVideoProgress(
  callback: GenerateVideoOptions['onProgress'],
  status: VideoProgressEvent['status'],
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
 * Detects the first available video provider from environment variables.
 *
 * Scans the {@link VIDEO_PROVIDER_ENV_MAP} in priority order and returns
 * the first provider whose API key env var is set and whose factory is
 * registered.
 *
 * @returns The provider ID and API key, or `undefined` when no video
 *   provider credentials are found.
 */
function autoDetectVideoProvider(): { providerId: string; apiKey: string } | undefined {
  const providerId = detectAvailableVideoProviders()[0];
  if (!providerId) return undefined;
  return {
    providerId,
    apiKey: process.env[envKeyForProvider(providerId)] ?? '',
  };
}

/**
 * Detects all video providers with valid credentials in the environment.
 *
 * @returns Provider IDs in priority order.
 */
function detectAvailableVideoProviders(): string[] {
  const available: string[] = [];
  for (const { envKey, providerId } of VIDEO_PROVIDER_ENV_MAP) {
    if (!process.env[envKey]) continue;
    if (!hasVideoProviderFactory(providerId)) continue;
    available.push(providerId);
  }
  return available;
}

/**
 * Detects all video providers with valid credentials in the environment
 * and returns their provider IDs in priority order, excluding the primary.
 *
 * @param primaryProviderId - The provider that was explicitly selected; it
 *   is excluded from the fallback list since it is already first in line.
 * @returns An array of provider IDs suitable for fallback, in priority order.
 */
function detectFallbackVideoProviders(primaryProviderId: string): string[] {
  const fallbacks: string[] = [];
  for (const { envKey, providerId } of VIDEO_PROVIDER_ENV_MAP) {
    if (providerId === primaryProviderId) continue;
    if (!process.env[envKey]) continue;
    if (!hasVideoProviderFactory(providerId)) continue;
    fallbacks.push(providerId);
  }
  return fallbacks;
}

/**
 * Resolves the API key environment variable name for a known video provider.
 *
 * @param providerId - The provider identifier.
 * @returns The environment variable name, or a generic fallback.
 */
function envKeyForProvider(providerId: string): string {
  const entry = [...VIDEO_PROVIDER_ENV_MAP, ...EXPLICIT_VIDEO_PROVIDER_ENV_MAP].find(
    (e) => e.providerId === providerId,
  );
  return entry?.envKey ?? `${providerId.toUpperCase()}_API_KEY`;
}

/**
 * Creates an {@link IVideoGenerator} for a resolved provider chain,
 * optionally wrapped in a {@link FallbackVideoProxy} when multiple
 * video-capable providers are available.
 *
 * @param providerChain - Ordered provider IDs with the primary first and
 *   optional fallbacks after it.
 * @param apiKey - API key for the primary provider.
 * @param modelId - Optional model identifier override.
 * @param baseUrl - Optional base URL override.
 * @returns An initialised video provider (possibly a fallback proxy).
 */
async function createVideoProviderWithFallback(
  providerChain: string[],
  apiKey: string,
  modelId?: string,
  baseUrl?: string,
  timeoutMs?: number,
): Promise<IVideoGenerator> {
  if (providerChain.length === 0) {
    throw new Error('No video providers available in the resolved provider chain.');
  }

  const [providerId, ...fallbackIds] = providerChain;
  const primary = createVideoProvider(providerId);
  await primary.initialize({
    apiKey,
    ...(modelId ? { defaultModelId: modelId } : {}),
    ...(baseUrl ? { baseURL: baseUrl, baseUrl } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });

  if (fallbackIds.length === 0) {
    return primary;
  }

  // Build and initialise fallback providers. Failures during init are
  // silently skipped — the provider simply won't be part of the chain.
  const chain: IVideoGenerator[] = [primary];
  for (const fbId of fallbackIds) {
    try {
      const fbKey = process.env[envKeyForProvider(fbId)];
      if (!fbKey) continue;
      const fb = createVideoProvider(fbId);
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

  return new FallbackVideoProxy(chain, videoFallbackEmitter);
}

// ---------------------------------------------------------------------------
// Public options / result types
// ---------------------------------------------------------------------------

/**
 * Options for a {@link generateVideo} call.
 *
 * At minimum, a `prompt` is required. The provider is resolved from
 * `opts.provider`, `opts.apiKey`, or the first video-capable env var
 * found (`RUNWAY_API_KEY` -> `REPLICATE_API_TOKEN` -> `FAL_API_KEY`).
 */
export interface GenerateVideoOptions {
  /** Text prompt describing the desired video content. */
  prompt: string;

  /**
   * Source image (the first frame) for image-to-video generation. When
   * provided, the request is dispatched to `imageToVideo()` instead of
   * `generateVideo()`.
   *
   * Accepts a `Buffer`, an `https://` URL or a `data:` URL. fal, Replicate and
   * Runway receive a URL as given and a `Buffer` as a `data:` URL; the Gemini
   * provider fetches an `https://` URL itself through the checked egress
   * path (public addresses on port 443, each redirect checked) and sends the
   * bytes inline.
   */
  image?: VideoImageInput;

  /**
   * Images of subjects or assets the video must keep consistent
   * (reference-to-video), in the same forms as `image`. Sent as fal's
   * `reference_image_urls`, Replicate's `reference_images`, or Gemini image
   * parts after the source image.
   */
  referenceImages?: VideoImageInput[];

  /**
   * Explicit provider identifier (`"runway"`, `"replicate"`, `"fal"` or
   * `"gemini"`). When omitted, auto-detection from environment variables is
   * used; `"gemini"` runs only when named here.
   */
  provider?: string;

  /**
   * Model identifier within the provider (e.g.
   * `"fal-ai/minimax/hailuo-02/standard/image-to-video"`, `"google/veo-3.1"`,
   * `"gemini-omni-1.1-flash"`). When omitted, the provider picks its default,
   * which on fal is a text-to-video or an image-to-video endpoint as the call
   * needs.
   */
  model?: string;

  /** Desired output duration in seconds. */
  durationSec?: number;

  /** Desired aspect ratio (e.g. `"16:9"`, `"9:16"`). */
  aspectRatio?: VideoAspectRatio;

  /**
   * Desired output resolution, in the model's own vocabulary (e.g. `"720p"`,
   * `"1080p"`, or `"768P"` for MiniMax on fal). Sent as given, for
   * text-to-video and image-to-video.
   */
  resolution?: string;

  /** Negative prompt describing content to avoid. */
  negativePrompt?: string;

  /** Random seed for reproducible generation (provider-dependent). */
  seed?: number;

  /**
   * Maximum time in milliseconds to wait for generation to complete, given to
   * each provider at `initialize()`: the polling budget on fal, Replicate and
   * Runway, and the deadline of every request on Gemini.
   */
  timeoutMs?: number;

  /**
   * Provider-specific model inputs the typed fields do not cover, such as
   * fal's `end_image_url` or Replicate's `last_frame`.
   *
   * Key them by provider id (`{ fal: {...}, replicate: {...} }`) so each
   * provider in a fallback chain receives only its own entry; a bag with no
   * provider-id key goes whole to fal, Replicate and Gemini. They add inputs
   * and never replace a field the call sets: to send a model-specific value
   * for such a field, leave the typed field unset and put the value here.
   * Runway sends no provider options.
   */
  providerOptions?: VideoProviderOptionBag | Record<string, unknown>;

  /**
   * Optional progress callback invoked during long-running generation.
   * Called with a {@link VideoProgressEvent} at each status transition.
   */
  onProgress?: (event: VideoProgressEvent) => void;

  /** Override the provider API key instead of reading from env vars. */
  apiKey?: string;

  /** Override the provider base URL. */
  baseUrl?: string;

  /**
   * Provider preferences for reordering or filtering the fallback chain.
   * When supplied, the available video providers are reordered according to
   * `preferred` and filtered by `blocked` before building the chain.
   */
  providerPreferences?: MediaProviderPreference;

  /** Optional durable usage ledger configuration for accounting. */
  usageLedger?: AgentOSUsageLedgerOptions;
}

/**
 * The result returned by {@link generateVideo}.
 *
 * Wraps the core {@link VideoResult} with a simpler, AI-SDK-style shape.
 */
export interface GenerateVideoResult {
  /** Model identifier reported by the provider. */
  model: string;
  /** Provider identifier (`"runway"`, `"replicate"`, `"fal"` or `"gemini"`). */
  provider: string;
  /** Unix timestamp (seconds) when the video was created, as every media result reports it. */
  created: number;
  /** Array of generated video objects containing URLs or base64 data. */
  videos: VideoResult['videos'];
  /** Usage / billing information, if available. */
  usage?: VideoResult['usage'];
}

// ---------------------------------------------------------------------------
// Main API function
// ---------------------------------------------------------------------------

/**
 * Generates a video using a provider-agnostic interface.
 *
 * Resolves provider credentials via explicit options or environment variable
 * auto-detection, initialises the matching video provider (optionally wrapped
 * in a fallback chain), and returns a normalised {@link GenerateVideoResult}.
 *
 * When `opts.image` is provided (a `Buffer` or a non-empty URL), the request
 * is routed to {@link IVideoGenerator.imageToVideo} for image-to-video
 * generation.
 * Otherwise, {@link IVideoGenerator.generateVideo} is used for text-to-video.
 *
 * @param opts - Video generation options.
 * @returns A promise resolving to the generation result with video data and metadata.
 *
 * @example
 * ```ts
 * // Text-to-video
 * const result = await generateVideo({
 *   prompt: 'A drone flying over a misty forest at sunrise',
 *   provider: 'runway',
 *   durationSec: 5,
 * });
 * console.log(result.videos[0].url);
 *
 * // Image-to-video
 * const i2v = await generateVideo({
 *   prompt: 'Camera slowly zooms out',
 *   image: fs.readFileSync('input.png'),
 * });
 *
 * // Image by URL, with resolution, reference images and a model input
 * const clip = await generateVideo({
 *   provider: 'fal',
 *   model: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
 *   prompt: 'The lantern swings',
 *   image: 'https://cdn.example.com/start.png',
 *   resolution: '768P',
 *   providerOptions: { fal: { end_image_url: 'https://cdn.example.com/end.png' } },
 * });
 * ```
 */
export async function generateVideo(opts: GenerateVideoOptions): Promise<GenerateVideoResult> {
  const startedAt = Date.now();
  let metricStatus: 'ok' | 'error' = 'ok';
  let metricUsage: VideoResult['usage'];
  let metricProviderId: string | undefined;
  let metricModelId: string | undefined;

  try {
    return await withAgentOSSpan('agentos.api.generate_video', async (span) => {
      // --- Resolve provider ---
      let providerId: string;
      let apiKey: string;
      let providerChain: string[];

      if (opts.provider) {
        providerId = opts.provider;
        apiKey =
          opts.apiKey ??
          process.env[envKeyForProvider(providerId)] ??
          '';
        if (!apiKey) {
          throw new Error(
            `No API key for video provider "${providerId}". Set ${envKeyForProvider(providerId)} or pass apiKey.`,
          );
        }
        let fallbackIds = detectFallbackVideoProviders(providerId);
        if (opts.providerPreferences) {
          const ordered = resolveProviderOrder([providerId, ...fallbackIds], opts.providerPreferences);
          fallbackIds = ordered.filter((id) => id !== providerId);
        }
        providerChain = [providerId, ...fallbackIds];
      } else if (opts.apiKey) {
        // Caller supplied a key but no provider — try auto-detect anyway
        const detected = autoDetectVideoProvider();
        providerId = detected?.providerId ?? 'runway';
        apiKey = opts.apiKey;
        let fallbackIds = detectFallbackVideoProviders(providerId);
        if (opts.providerPreferences) {
          const ordered = resolveProviderOrder([providerId, ...fallbackIds], opts.providerPreferences);
          fallbackIds = ordered.filter((id) => id !== providerId);
        }
        providerChain = [providerId, ...fallbackIds];
      } else {
        providerChain = resolveProviderChain(
          detectAvailableVideoProviders(),
          opts.providerPreferences,
        );
        if (providerChain.length === 0) {
          throw new Error(
            'No video provider configured. Set RUNWAY_API_KEY, REPLICATE_API_TOKEN, or FAL_API_KEY, or pass provider: "gemini" with GEMINI_API_KEY set.',
          );
        }
        providerId = providerChain[0];
        apiKey = process.env[envKeyForProvider(providerId)] ?? '';
      }

      metricProviderId = providerId;
      metricModelId = opts.model;
      emitVideoProgress(opts.onProgress, 'queued', 0, `Queued video generation with ${providerId}.`);

      span?.setAttribute('llm.provider', providerId);
      if (opts.model) span?.setAttribute('llm.model', opts.model);

      // --- Create provider (with fallback chain) ---
      const provider = await createVideoProviderWithFallback(
        providerChain,
        apiKey,
        opts.model,
        opts.baseUrl,
        opts.timeoutMs,
      );
      emitVideoProgress(opts.onProgress, 'processing', 25, `Generating video with ${providerId}.`);

      // --- Dispatch to text-to-video or image-to-video ---
      let result: VideoResult;

      // The model goes to the primary only (it was also its defaultModelId at
      // initialize()); with none named, each provider picks its own default
      // for the capability. The timeout went to initialize() as well.
      const modelId = provider instanceof FallbackVideoProxy ? undefined : opts.model;

      if (hasVideoImage(opts.image)) {
        if (!provider.supports('image-to-video') || typeof provider.imageToVideo !== 'function') {
          throw new Error(`Provider "${providerId}" does not support image-to-video generation.`);
        }
        // Image-to-video
        result = await provider.imageToVideo({
          modelId,
          image: opts.image,
          prompt: opts.prompt,
          negativePrompt: opts.negativePrompt,
          durationSec: opts.durationSec,
          aspectRatio: opts.aspectRatio,
          resolution: opts.resolution,
          referenceImages: opts.referenceImages,
          seed: opts.seed,
          providerOptions: opts.providerOptions,
        });
      } else {
        // Text-to-video
        result = await provider.generateVideo({
          modelId,
          prompt: opts.prompt,
          negativePrompt: opts.negativePrompt,
          durationSec: opts.durationSec,
          aspectRatio: opts.aspectRatio,
          resolution: opts.resolution,
          referenceImages: opts.referenceImages,
          seed: opts.seed,
          providerOptions: opts.providerOptions,
        });
      }

      metricUsage = result.usage;
      metricModelId = result.modelId;
      span?.setAttribute('agentos.api.videos_count', result.videos.length);

      if (result.usage?.totalCostUSD !== undefined) {
        attachUsageAttributes(span, { totalCostUSD: result.usage.totalCostUSD });
      }
      emitVideoProgress(opts.onProgress, 'complete', 100, 'Video generation complete.');

      return {
        model: result.modelId,
        provider: result.providerId,
        created: result.created,
        videos: result.videos,
        usage: result.usage,
      };
    });
  } catch (error) {
    metricStatus = 'error';
    emitVideoProgress(
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
              totalTokens: metricUsage.totalVideos,
              costUSD: metricUsage.totalCostUSD,
            }
          : undefined,
        options: {
          ...opts.usageLedger,
          source: opts.usageLedger?.source ?? 'generateVideo',
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
