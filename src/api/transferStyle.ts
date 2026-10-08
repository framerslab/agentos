/**
 * @file transferStyle.ts
 * Provider-agnostic style transfer for the AgentOS high-level API.
 *
 * Applies the visual aesthetic of a reference image to a source image,
 * guided by a text prompt. Internally routes to the best available
 * provider for style transfer:
 *
 * - **Replicate** (preferred): Flux Redux — purpose-built for image-guided generation
 * - **Fal**: Flux Dev img2img with style reference in prompt
 * - **Stability**: img2img with strength control
 * - **OpenAI**: editImage with descriptive prompt
 *
 * @module agentos/api/transferStyle
 *
 * @example
 * ```typescript
 * import { transferStyle } from '@framers/agentos/api/transferStyle';
 *
 * const result = await transferStyle({
 *   image: './photo.jpg',
 *   styleReference: './monet-painting.jpg',
 *   prompt: 'Impressionist oil painting with warm golden light',
 *   strength: 0.7,
 * });
 * console.log(result.images[0].url);
 * ```
 */

import { createImageProvider, hasImageProviderFactory } from '../io/media/images/index.js';
import { imageToBuffer } from '../io/media/images/imageToBuffer.js';
import type {
  GeneratedImage,
  ImageGenerationResult,
} from '../io/media/images/IImageProvider.js';
import { resolveModelOption, resolveMediaProvider } from './model.js';
import { recordAgentOSUsage, type AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';
import { recordAgentOSTurnMetrics, withAgentOSSpan } from '../safety/evaluation/observability/otel.js';

// ---------------------------------------------------------------------------
// Provider detection — ordered by style transfer capability
// ---------------------------------------------------------------------------

const STYLE_TRANSFER_PROVIDER_PRIORITY: Array<{ envKey: string; providerId: string; modelId: string }> = [
  { envKey: 'REPLICATE_API_TOKEN', providerId: 'replicate', modelId: 'black-forest-labs/flux-redux-dev' },
  { envKey: 'FAL_API_KEY', providerId: 'fal', modelId: 'fal-ai/flux/dev' },
  { envKey: 'STABILITY_API_KEY', providerId: 'stability', modelId: 'stable-image-core' },
  { envKey: 'OPENAI_API_KEY', providerId: 'openai', modelId: 'gpt-image-1' },
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for a {@link transferStyle} call.
 */
export interface TransferStyleOptions {
  /** Source image to transform (Buffer, file path, URL, or data URI). */
  image: string | Buffer;
  /** Reference image whose visual aesthetic to apply. */
  styleReference: string | Buffer;
  /** Text prompt guiding the transfer direction. */
  prompt: string;
  /**
   * Transfer strength. Controls how much of the reference style to apply.
   * `0.0` = source unchanged, `1.0` = fully adopts reference style.
   * @default 0.7
   */
  strength?: number;
  /** Provider override. Auto-detects from env vars if omitted. */
  provider?: string;
  /** Model override. Provider-specific. */
  model?: string;
  /** Output size (e.g. `'1024x1024'`). */
  size?: string;
  /** Negative prompt describing content to avoid. */
  negativePrompt?: string;
  /** Seed for reproducible output. */
  seed?: number;
  /** Policy tier for provider routing. */
  policyTier?: 'safe' | 'standard' | 'mature' | 'private-adult';
  /** Provider-specific options passthrough. */
  providerOptions?: Record<string, unknown>;
  /**
   * API key for the provider, instead of its environment variable. It applies
   * to the provider named in `provider` (or `model`), or to the one detected
   * from the environment when neither is set.
   */
  apiKey?: string;
  /** Base URL for the provider, instead of its default or its environment variable. */
  baseUrl?: string;
  /** Usage ledger configuration. */
  usageLedger?: AgentOSUsageLedgerOptions;
}

/**
 * Result returned by {@link transferStyle}.
 */
export interface TransferStyleResult {
  /** Generated images with transferred style. */
  images: GeneratedImage[];
  /** Provider that served the request. */
  provider: string;
  /** Model used for the transfer. */
  model: string;
  /** Usage/cost metadata. */
  usage: { costUSD?: number };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Transfers the visual aesthetic of a reference image onto a source image.
 *
 * Routes to the best available provider:
 * - **Replicate** (Flux Redux): purpose-built for image-guided style transfer
 * - **Fal** (Flux Dev): img2img with style guidance
 * - **Stability** (img2img): strength-controlled transformation
 * - **OpenAI** (edit): prompt-guided editing
 *
 * @param opts - Style transfer options.
 * @returns Promise resolving to the transfer result with styled image(s).
 *
 * @throws {Error} When no style transfer provider is available.
 *
 * @example
 * ```typescript
 * // Photo to oil painting
 * const result = await transferStyle({
 *   image: photoBuffer,
 *   styleReference: './monet.jpg',
 *   prompt: 'Impressionist oil painting, warm golden light, visible brushstrokes',
 *   strength: 0.7,
 * });
 * ```
 */
export async function transferStyle(opts: TransferStyleOptions): Promise<TransferStyleResult> {
  const startedAt = Date.now();
  let metricStatus: 'ok' | 'error' = 'ok';
  let metricUsage: ImageGenerationResult['usage'];

  try {
    return await withAgentOSSpan('agentos.api.transfer_style', async (span) => {
      // Resolve provider
      let providerId: string;
      let modelId: string;

      if (opts.provider) {
        ({ providerId, modelId } = resolveModelOption(opts, 'image'));
      } else {
        // Auto-detect best available style transfer provider
        const match = STYLE_TRANSFER_PROVIDER_PRIORITY.find(
          (p) => process.env[p.envKey] && hasImageProviderFactory(p.providerId),
        );
        if (!match) {
          throw new Error(
            'No style transfer provider configured. Set REPLICATE_API_TOKEN, FAL_API_KEY, STABILITY_API_KEY, or OPENAI_API_KEY.',
          );
        }
        providerId = match.providerId;
        modelId = opts.model ?? match.modelId;
      }

      const resolved = resolveMediaProvider(providerId, modelId, {
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
      });
      span?.setAttribute('llm.provider', resolved.providerId);
      span?.setAttribute('llm.model', resolved.modelId);

      const provider = createImageProvider(resolved.providerId);
      await provider.initialize({
        apiKey: resolved.apiKey,
        baseURL: resolved.baseUrl,
        defaultModelId: resolved.modelId,
      });

      // Convert style reference to data URL for Flux Redux
      const styleBuffer = await imageToBuffer(opts.styleReference);
      const styleDataUrl = `data:image/png;base64,${styleBuffer.toString('base64')}`;

      let result: ImageGenerationResult;

      if (resolved.providerId === 'replicate' && resolved.modelId.includes('flux-redux')) {
        // Flux Redux: style reference is the primary image input
        result = await provider.generateImage({
          modelId: resolved.modelId,
          prompt: opts.prompt,
          size: opts.size,
          seed: opts.seed,
          negativePrompt: opts.negativePrompt,
          referenceImageUrl: styleDataUrl,
          providerOptions: opts.providerOptions,
        });
      } else if (typeof provider.editImage === 'function') {
        // Providers with editImage: use img2img
        const imageBuffer = await imageToBuffer(opts.image);
        result = await provider.editImage({
          modelId: resolved.modelId,
          image: imageBuffer,
          prompt: opts.prompt,
          strength: opts.strength ?? 0.7,
          size: opts.size,
          seed: opts.seed,
          negativePrompt: opts.negativePrompt,
          providerOptions: opts.providerOptions,
        });
      } else {
        // Fallback: generate with style description in prompt
        result = await provider.generateImage({
          modelId: resolved.modelId,
          prompt: `${opts.prompt}. Apply the visual style and aesthetic of the reference.`,
          size: opts.size,
          seed: opts.seed,
          negativePrompt: opts.negativePrompt,
          providerOptions: opts.providerOptions,
        });
      }

      metricUsage = result.usage;

      return {
        images: result.images,
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
        usage: metricUsage ? { costUSD: metricUsage.totalCostUSD } : undefined,
        options: { ...opts.usageLedger, source: opts.usageLedger?.source ?? 'transferStyle' },
      });
    } catch { /* best-effort */ }
    recordAgentOSTurnMetrics({
      durationMs: Date.now() - startedAt,
      status: metricStatus,
    });
  }
}
