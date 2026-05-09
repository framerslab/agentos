/**
 * @file generateImage.ts
 * Provider-agnostic image generation for the AgentOS high-level API.
 *
 * Parses a `provider:model` string, resolves media-provider credentials, and
 * dispatches the request to the appropriate image provider implementation
 * (e.g. OpenAI DALL-E, Stability AI, Replicate).
 *
 * When multiple image-capable providers are configured (via env vars), the
 * primary provider is wrapped in a {@link FallbackImageProxy} so that a
 * transient failure automatically retries on the next available provider.
 */
import { EventEmitter } from 'events';
import { createImageProvider, hasImageProviderFactory } from '../media/images/index.js';
import { FallbackImageProxy } from '../media/images/FallbackImageProxy.js';
import type {
  IImageProvider,
  GeneratedImage,
  ImageGenerationResult,
  ImageProviderOptionBag,
  ImageResponseFormat,
  ImageBackground,
  ImageModality,
  ImageOutputFormat,
} from '../media/images/IImageProvider.js';
import { resolveModelOption, resolveMediaProvider } from './model.js';
import {
  resolveProviderChain,
  resolveProviderOrder,
  type MediaProviderPreference,
} from '../media/ProviderPreferences.js';
import { attachUsageAttributes, toTurnMetricUsage } from './observability.js';
import { recordAgentOSUsage, type AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';
import { recordAgentOSTurnMetrics, withAgentOSSpan } from '../evaluation/observability/otel.js';

// ---------------------------------------------------------------------------
// Image provider fallback chain builder
// ---------------------------------------------------------------------------

/**
 * Env-var to provider-id mapping used to detect which image providers have
 * credentials configured in the current environment.  Order determines
 * fallback priority (first = highest priority).
 */
const IMAGE_PROVIDER_ENV_MAP: Array<{ envKey: string; providerId: string }> = [
  { envKey: 'REPLICATE_API_TOKEN', providerId: 'replicate' },
  { envKey: 'FAL_API_KEY', providerId: 'fal' },
  { envKey: 'BFL_API_KEY', providerId: 'bfl' },
  { envKey: 'OPENAI_API_KEY', providerId: 'openai' },
  { envKey: 'STABILITY_API_KEY', providerId: 'stability' },
  { envKey: 'OPENROUTER_API_KEY', providerId: 'openrouter' },
  { envKey: 'STABLE_DIFFUSION_LOCAL_BASE_URL', providerId: 'stable-diffusion-local' },
];

/** Shared emitter for image fallback events (singleton per process). */
const imageFallbackEmitter = new EventEmitter();

/**
 * Detects all image providers with valid credentials in the environment
 * and returns their provider IDs in priority order, excluding the primary.
 *
 * @param primaryProviderId - The provider that was explicitly selected; it
 *   is excluded from the fallback list since it is already the first in line.
 * @returns An array of provider IDs suitable for fallback, in priority order.
 */
function detectFallbackImageProviders(primaryProviderId: string): string[] {
  const fallbacks: string[] = [];
  for (const { envKey, providerId } of IMAGE_PROVIDER_ENV_MAP) {
    if (providerId === primaryProviderId) continue;
    if (!process.env[envKey]) continue;
    if (!hasImageProviderFactory(providerId)) continue;
    fallbacks.push(providerId);
  }
  return fallbacks;
}

/**
 * Detects all image providers with valid credentials in the environment.
 *
 * @returns Provider IDs in priority order.
 */
function detectAvailableImageProviders(): string[] {
  const available: string[] = [];
  for (const { envKey, providerId } of IMAGE_PROVIDER_ENV_MAP) {
    if (!process.env[envKey]) continue;
    if (!hasImageProviderFactory(providerId)) continue;
    available.push(providerId);
  }
  return available;
}

/**
 * Creates an {@link IImageProvider} for the resolved primary provider,
 * optionally wrapped in a {@link FallbackImageProxy} when an ordered
 * provider chain contains additional image-capable fallbacks.
 *
 * @param resolved - The primary resolved provider credentials.
 * @param providerChain - Optional ordered provider IDs with the primary first.
 * @returns An initialised image provider (possibly a fallback proxy).
 */
async function createImageProviderWithFallback(
  resolved: { providerId: string; modelId: string; apiKey?: string; baseUrl?: string },
  providerChain?: string[],
): Promise<IImageProvider> {
  const primary = createImageProvider(resolved.providerId);
  await primary.initialize({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseUrl,
    defaultModelId: resolved.modelId,
  });

  const fallbackIds = providerChain
    ? providerChain.filter((id) => id !== resolved.providerId)
    : detectFallbackImageProviders(resolved.providerId);

  if (fallbackIds.length === 0) {
    return primary;
  }

  // Build and initialise fallback providers. Failures during init are
  // silently skipped — the provider simply won't be part of the chain.
  const chain: IImageProvider[] = [primary];
  for (const fbId of fallbackIds) {
    try {
      const { modelId: fallbackModelId } = resolveModelOption({ provider: fbId }, 'image');
      const fbResolved = resolveMediaProvider(fbId, fallbackModelId);
      const fb = createImageProvider(fbId);
      await fb.initialize({
        apiKey: fbResolved.apiKey,
        baseURL: fbResolved.baseUrl,
        defaultModelId: fbResolved.modelId,
      });
      chain.push(fb);
    } catch {
      // Skip providers that fail to initialise (missing creds, etc.).
    }
  }

  if (chain.length <= 1) {
    return primary;
  }

  return new FallbackImageProxy(chain, imageFallbackEmitter);
}

/**
 * Options for a {@link generateImage} call.
 */
export interface GenerateImageOptions {
  /**
   * Provider name.  When supplied without `model`, the default image model for
   * the provider is resolved automatically from the built-in defaults registry.
   *
   * @example `"openai"`, `"stability"`, `"replicate"`
   */
  provider?: string;
  /**
   * Model in `provider:model` format (legacy) or plain model name when `provider` is set.
   * @example `"openai:dall-e-3"`, `"stability:stable-diffusion-xl-1024-v1-0"`
   *
   * Either `provider` or `model` (or an API key env var for auto-detection) is required.
   */
  model?: string;
  /** Text description of the desired image. */
  prompt: string;
  /** Output modalities requested from the provider (provider-dependent). */
  modalities?: ImageModality[];
  /** Number of images to generate. Defaults to `1` for most providers. */
  n?: number;
  /** Pixel dimensions string, e.g. `"1024x1024"`. Provider-dependent. */
  size?: string;
  /** Aspect ratio string, e.g. `"16:9"`. Used by some providers instead of `size`. */
  aspectRatio?: string;
  /** Quality hint forwarded to the provider (e.g. `"hd"` for DALL-E 3). */
  quality?: string;
  /** Background style for transparent-capable providers. */
  background?: ImageBackground;
  /** Desired output file format (e.g. `"png"`, `"jpeg"`, `"webp"`). */
  outputFormat?: ImageOutputFormat;
  /** Compression level (0–100) for lossy output formats. */
  outputCompression?: number;
  /** Whether the provider should return a URL or base64-encoded data. */
  responseFormat?: ImageResponseFormat;
  /** Override the provider API key instead of reading from environment variables. */
  apiKey?: string;
  /** Override the provider base URL. */
  baseUrl?: string;
  /** Optional user identifier forwarded to the provider for moderation tracking. */
  userId?: string;
  /** Random seed for reproducible generation (provider-dependent support). */
  seed?: number;
  /** Negative prompt describing content to avoid (provider-dependent support). */
  negativePrompt?: string;
  /** Arbitrary provider-specific options not covered by the standard fields. */
  providerOptions?: ImageProviderOptionBag | Record<string, unknown>;
  /**
   * Provider preferences for reordering or filtering the fallback chain.
   * When supplied, the available image providers are reordered according to
   * `preferred` and filtered by `blocked` before building the chain.
   */
  providerPreferences?: MediaProviderPreference;
  /**
   * Content policy tier. When mature or private-adult, the image provider
   * chain is reordered to prefer uncensored providers (Replicate, Fal)
   * over censored ones (DALL-E, Stability safe mode) and
   * `disable_safety_checker: true` is applied automatically to the
   * Replicate request so the community model's own NSFW filter does
   * not veto the prompt.
   */
  policyTier?: 'safe' | 'standard' | 'mature' | 'private-adult';
  /**
   * Required provider capabilities for mature/private-adult routing.
   * When `referenceImageUrl` is set, `'face-consistency'` is added
   * automatically so the catalog prefers an IP-Adapter or Instant-ID
   * model that actually respects the reference. Ignored for
   * safe/standard tiers.
   */
  capabilities?: string[];
  /** Optional durable usage ledger configuration for helper-level accounting. */
  usageLedger?: AgentOSUsageLedgerOptions;
  /** Reference image URL for character/face consistency. See IImageProvider docs. */
  referenceImageUrl?: string;
  /** Pre-computed 512-dim face embedding for drift detection. */
  faceEmbedding?: number[];
  /** Character consistency mode: 'strict' | 'balanced' | 'loose'. Default 'balanced'. */
  consistencyMode?: 'strict' | 'balanced' | 'loose';
}

/**
 * The result returned by {@link generateImage}.
 */
export interface GenerateImageResult {
  /** Model identifier reported by the provider. */
  model: string;
  /** Provider identifier (e.g. `"openai"`, `"stability"`). */
  provider: string;
  /** Unix timestamp (seconds) when the image was created. */
  created: number;
  /** Optional text response accompanying the images (provider-dependent). */
  text?: string;
  /** Array of generated image objects containing URLs or base64 data. */
  images: GeneratedImage[];
  /** Token / credit usage reported by the provider, when available. */
  usage?: ImageGenerationResult['usage'];
}

/**
 * Generates one or more images using a provider-agnostic `provider:model` string.
 *
 * Resolves credentials via `resolveMediaProvider()`, initialises the matching
 * image provider, and returns a normalised {@link GenerateImageResult}.
 *
 * @param opts - Image generation options including model, prompt, and optional parameters.
 * @returns A promise resolving to the generation result with image data and metadata.
 *
 * @example
 * ```ts
 * const result = await generateImage({
 *   model: 'openai:dall-e-3',
 *   prompt: 'A photorealistic red panda sitting on a moonlit rooftop.',
 *   size: '1024x1024',
 * });
 * console.log(result.images[0].url);
 * ```
 */
export async function generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
  const startedAt = Date.now();
  let metricStatus: 'ok' | 'error' = 'ok';
  let metricUsage: ImageGenerationResult['usage'];
  let metricProviderId: string | undefined;
  let metricModelId: string | undefined;

  try {
    return await withAgentOSSpan('agentos.api.generate_image', async (span) => {
      let providerChain: string[] | undefined;
      let providerId: string;
      let modelId: string;

      if (!opts.provider && !opts.model) {
        providerChain = resolveProviderChain(
          detectAvailableImageProviders(),
          opts.providerPreferences,
        );
        if (providerChain.length === 0) {
          throw new Error(
            'No image provider configured. Set OPENAI_API_KEY, STABILITY_API_KEY, REPLICATE_API_TOKEN, BFL_API_KEY, FAL_API_KEY, OPENROUTER_API_KEY, or STABLE_DIFFUSION_LOCAL_BASE_URL.',
          );
        }
        ({ providerId, modelId } = resolveModelOption({ provider: providerChain[0] }, 'image'));
      } else {
        ({ providerId, modelId } = resolveModelOption(opts, 'image'));
        let fallbackIds = detectFallbackImageProviders(providerId);
        if (opts.providerPreferences) {
          const ordered = resolveProviderOrder([providerId, ...fallbackIds], opts.providerPreferences);
          fallbackIds = ordered.filter((id) => id !== providerId);
        }
        providerChain = [providerId, ...fallbackIds];
      }

      // Policy-tier-aware provider override. Uses the explicit
      // capabilities hint when provided, else infers
      // `'face-consistency'` from the presence of a reference image so
      // character portraits keep the right face instead of drifting.
      if (opts.policyTier && (opts.policyTier === 'mature' || opts.policyTier === 'private-adult')) {
        // Caller-pin precedence: when a caller explicitly passes
        // `provider` and/or `model` for a mature-tier generate, that
        // resolution carries information the agentos catalog can't
        // (specifically: pinned version SHAs for community Replicate
        // models that 422 on the modern endpoint, and face-anchor
        // models the catalog flags as broken). Re-running the router
        // here would silently discard the substitution. Same fix
        // shape as editImage.ts.
        const callerPinnedModel =
          (typeof opts.model === 'string' && opts.model.length > 0)
          || (typeof opts.provider === 'string' && opts.provider.length > 0);

        // Always set disableSafetyChecker for Replicate on mature+
        // tiers, regardless of which model the caller pinned —
        // load-bearing for uncensored prompts to render. Caller's
        // existing explicit setting wins (allows opt-out).
        const existingReplicate =
          (opts.providerOptions?.replicate as Record<string, unknown>) ?? undefined;
        if (
          existingReplicate === undefined
          || typeof existingReplicate.disableSafetyChecker === 'undefined'
        ) {
          opts.providerOptions = {
            ...opts.providerOptions,
            replicate: {
              ...(existingReplicate ?? {}),
              disableSafetyChecker: true,
            },
          };
        }

        if (!callerPinnedModel) {
          const { PolicyAwareImageRouter } = await import('../media/images/PolicyAwareImageRouter.js');
          const { createUncensoredModelCatalog } = await import('../core/llm/routing/UncensoredModelCatalog.js');
          const imageRouter = new PolicyAwareImageRouter(createUncensoredModelCatalog());
          const inferredCaps =
            opts.capabilities
            ?? (opts.referenceImageUrl ? ['face-consistency'] : undefined);
          const pref = imageRouter.getPreferredProvider(
            opts.policyTier as 'mature' | 'private-adult',
            inferredCaps,
          );
          if (pref) {
            providerId = pref.providerId;
            modelId = pref.modelId;
          }
        }
      }

      const resolved = resolveMediaProvider(providerId, modelId, {
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
      });
      metricProviderId = resolved.providerId;
      metricModelId = resolved.modelId;

      span?.setAttribute('llm.provider', resolved.providerId);
      span?.setAttribute('llm.model', resolved.modelId);

      const provider = await createImageProviderWithFallback(resolved, providerChain);

      const result = await provider.generateImage({
        modelId:
          provider instanceof FallbackImageProxy
            ? undefined
            : resolved.modelId,
        prompt: opts.prompt,
        modalities: opts.modalities,
        n: opts.n,
        size: opts.size,
        aspectRatio: opts.aspectRatio,
        quality: opts.quality,
        background: opts.background,
        outputFormat: opts.outputFormat,
        outputCompression: opts.outputCompression,
        responseFormat: opts.responseFormat,
        userId: opts.userId,
        seed: opts.seed,
        negativePrompt: opts.negativePrompt,
        providerOptions: opts.providerOptions,
        referenceImageUrl: opts.referenceImageUrl,
        faceEmbedding: opts.faceEmbedding,
        consistencyMode: opts.consistencyMode,
      });

      metricUsage = result.usage;
      span?.setAttribute('agentos.api.images_count', result.images.length);
      attachUsageAttributes(span, {
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        totalTokens: result.usage?.totalTokens,
        totalCostUSD: result.usage?.totalCostUSD,
      });

      return {
        model: result.modelId,
        provider: result.providerId,
        created: result.created,
        text: result.text,
        images: result.images,
        usage: result.usage,
      };
    });
  } catch (error) {
    metricStatus = 'error';
    throw error;
  } finally {
    try {
      await recordAgentOSUsage({
        providerId: metricProviderId,
        modelId: metricModelId,
        usage: metricUsage
          ? {
              promptTokens: metricUsage.promptTokens,
              completionTokens: metricUsage.completionTokens,
              totalTokens: metricUsage.totalTokens,
              costUSD: metricUsage.totalCostUSD,
            }
          : undefined,
        options: {
          ...opts.usageLedger,
          source: opts.usageLedger?.source ?? 'generateImage',
        },
      });
    } catch {
      // Helper-level usage persistence is best-effort and should not break generation.
    }
    recordAgentOSTurnMetrics({
      durationMs: Date.now() - startedAt,
      status: metricStatus,
      usage: toTurnMetricUsage(
        metricUsage
          ? {
              promptTokens: metricUsage.promptTokens,
              completionTokens: metricUsage.completionTokens,
              totalTokens: metricUsage.totalTokens,
              totalCostUSD: metricUsage.totalCostUSD,
            }
          : undefined
      ),
    });
  }
}
