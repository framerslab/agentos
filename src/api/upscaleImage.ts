/**
 * @file upscaleImage.ts
 * Provider-agnostic image upscaling (super-resolution) for the AgentOS high-level API.
 *
 * Increases the resolution of an existing image using specialised upscaling
 * models.  Callers can request either a fixed scale factor (2x, 4x) or
 * explicit target dimensions.
 *
 * Provider support:
 * - **Stability AI** — `/v2beta/stable-image/upscale/conservative`
 * - **Stable Diffusion Local (A1111)** — `/sdapi/v1/extra-single-image`
 * - **Replicate** — `nightmareai/real-esrgan` (or caller-specified model)
 * - **OpenAI** — not supported (throws {@link ImageUpscaleNotSupportedError})
 */
import { createImageProvider } from '../io/media/images/index.js';
import { ImageUpscaleNotSupportedError } from '../io/media/images/ImageOperationError.js';
import { imageToBuffer } from '../io/media/images/imageToBuffer.js';
import type {
  GeneratedImage,
  ImageGenerationResult,
  ImageProviderOptionBag,
} from '../io/media/images/IImageProvider.js';
import { modelIsNamed, resolveModelOption, resolveMediaProvider } from './model.js';
import { attachUsageAttributes, toTurnMetricUsage } from './observability.js';
import { recordAgentOSUsage, type AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';
import { recordAgentOSTurnMetrics, withAgentOSSpan } from '../safety/evaluation/observability/otel.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for an {@link upscaleImage} call.
 *
 * @example
 * ```ts
 * const result = await upscaleImage({
 *   provider: 'stability',
 *   image: fs.readFileSync('lowres.png'),
 *   scale: 4,
 * });
 * ```
 */
export interface UpscaleImageOptions {
  /**
   * Provider name (e.g. `"stability"`, `"replicate"`, `"stable-diffusion-local"`).
   * When omitted, auto-detection via env vars is attempted.
   */
  provider?: string;
  /**
   * Model identifier, usually left unset: the provider's own upscale default
   * then applies (Replicate `nightmareai/real-esrgan`), not its text-to-image
   * default.
   */
  model?: string;
  /**
   * Source image as a base64 data URL, raw base64 string, `Buffer`,
   * local file path, or HTTP/HTTPS URL.
   */
  image: string | Buffer;
  /**
   * Integer scale factor.  `2` doubles each dimension; `4` quadruples them.
   * When both `scale` and `width`/`height` are provided, explicit dimensions
   * take precedence.
   *
   * @default 2
   */
  scale?: 2 | 4;
  /** Target width in pixels (alternative to `scale`). */
  width?: number;
  /** Target height in pixels (alternative to `scale`). */
  height?: number;
  /** Override the provider API key instead of reading from env vars. */
  apiKey?: string;
  /** Override the provider base URL. */
  baseUrl?: string;
  /** Arbitrary provider-specific options. */
  providerOptions?: ImageProviderOptionBag | Record<string, unknown>;
  /** Optional usage ledger configuration. */
  usageLedger?: AgentOSUsageLedgerOptions;
}

/**
 * Result returned by {@link upscaleImage}.
 */
export interface UpscaleImageResult {
  /** The upscaled image. */
  image: GeneratedImage;
  /** Provider identifier. */
  provider: string;
  /** Model identifier. */
  model: string;
  /** Token/credit usage reported by the provider. */
  usage: { costUSD?: number };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Upscales an image using a provider-agnostic interface.
 *
 * Resolves credentials via `resolveMediaProvider()`, initialises the
 * matching image provider, converts the input image to a `Buffer`, and
 * dispatches to the provider's `upscaleImage` method.
 *
 * @param opts - Upscale options including the source image and desired scale.
 * @returns A promise resolving to the upscale result with the higher-resolution image.
 *
 * @throws {ImageUpscaleNotSupportedError} When the resolved provider does not
 *   implement image upscaling.
 * @throws {Error} When no provider can be determined or credentials are missing.
 *
 * @example
 * ```ts
 * const result = await upscaleImage({
 *   provider: 'stability',
 *   image: 'https://example.com/lowres.jpg',
 *   scale: 4,
 * });
 * console.log(result.image.dataUrl);
 * ```
 */
export async function upscaleImage(opts: UpscaleImageOptions): Promise<UpscaleImageResult> {
  const startedAt = Date.now();
  let metricStatus: 'ok' | 'error' = 'ok';
  let metricUsage: ImageGenerationResult['usage'];
  let metricProviderId: string | undefined;
  let metricModelId: string | undefined;

  try {
    return await withAgentOSSpan('agentos.api.upscale_image', async (span) => {
      const { providerId, modelId } = resolveModelOption(opts, 'image');
      // Whether a model is named, by the call or the global default. Without one, the provider's own
      // default for upscales applies, not the text-to-image default that
      // `resolveModelOption` gives a named provider: Replicate would otherwise
      // run every upscale on black-forest-labs/flux-1.1-pro instead of
      // nightmareai/real-esrgan.
      const modelChosen = modelIsNamed(opts, 'image');
      const resolved = resolveMediaProvider(providerId, modelId, {
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
      });
      // An empty model id asks the provider for its own default for the operation.
      const operationModelId = modelChosen ? resolved.modelId : '';
      metricProviderId = resolved.providerId;
      metricModelId = operationModelId || undefined;

      span?.setAttribute('llm.provider', resolved.providerId);
      if (operationModelId) span?.setAttribute('llm.model', operationModelId);
      span?.setAttribute('agentos.api.upscale_factor', opts.scale ?? 2);

      const provider = createImageProvider(resolved.providerId);
      await provider.initialize({
        apiKey: resolved.apiKey,
        baseURL: resolved.baseUrl,
        defaultModelId: operationModelId || undefined,
      });

      // Guard: the provider must implement upscaleImage.
      if (typeof provider.upscaleImage !== 'function') {
        throw new ImageUpscaleNotSupportedError(resolved.providerId);
      }

      const imageBuffer = await imageToBuffer(opts.image);

      const result = await provider.upscaleImage({
        modelId: operationModelId,
        image: imageBuffer,
        scale: opts.scale,
        width: opts.width,
        height: opts.height,
        providerOptions: opts.providerOptions,
      });

      metricUsage = result.usage;
      metricModelId = result.modelId || metricModelId;
      if (result.modelId) span?.setAttribute('llm.model', result.modelId);
      span?.setAttribute('agentos.api.images_count', result.images.length);
      attachUsageAttributes(span, {
        totalCostUSD: result.usage?.totalCostUSD,
      });

      return {
        image: result.images[0],
        provider: result.providerId,
        model: result.modelId,
        usage: { costUSD: result.usage?.totalCostUSD },
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
              costUSD: metricUsage.totalCostUSD,
            }
          : undefined,
        options: {
          ...opts.usageLedger,
          source: opts.usageLedger?.source ?? 'upscaleImage',
        },
      });
    } catch {
      // Best-effort — usage persistence must not break the upscale operation.
    }
    recordAgentOSTurnMetrics({
      durationMs: Date.now() - startedAt,
      status: metricStatus,
      usage: toTurnMetricUsage(
        metricUsage
          ? {
              totalCostUSD: metricUsage.totalCostUSD,
            }
          : undefined
      ),
    });
  }
}
