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
import { knownProviderPrefixOf, modelIsNamed, resolveModelOption, resolveMediaProvider } from './model.js';
import { OPENAI_IMAGE_EDIT_MODEL } from '../io/media/images/providers/OpenAIImageProvider.js';
import { recordAgentOSUsage, type AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';
import { recordAgentOSTurnMetrics, withAgentOSSpan } from '../safety/evaluation/observability/otel.js';

// ---------------------------------------------------------------------------
// Provider detection — ordered by style transfer capability
// ---------------------------------------------------------------------------

const STYLE_TRANSFER_PROVIDER_PRIORITY: Array<{ envKey: string; providerId: string; modelId: string }> = [
  { envKey: 'REPLICATE_API_TOKEN', providerId: 'replicate', modelId: 'black-forest-labs/flux-redux-dev' },
  { envKey: 'FAL_API_KEY', providerId: 'fal', modelId: 'fal-ai/flux/dev' },
  // The edit runs on Stability's SD3 route, whose `model` takes the sd3.5 names only.
  { envKey: 'STABILITY_API_KEY', providerId: 'stability', modelId: 'sd3.5-medium' },
  { envKey: 'OPENAI_API_KEY', providerId: 'openai', modelId: OPENAI_IMAGE_EDIT_MODEL },
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
   * API key for the provider, instead of its environment variable. The call
   * must name the provider, with `provider` or a provider-prefixed `model`
   * (`openai:gpt-image-2.5-sunburst`); a key with neither is refused.
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

      // The provider the call names: `provider`, or the prefix of `model`
      // (`openai:gpt-image-2.5-sunburst`). A key belongs to one vendor, so a call with a
      // key must name its provider: otherwise the key would go to whichever
      // provider the environment selects.
      const namedProvider = opts.provider ?? knownProviderPrefixOf(opts.model);
      if (opts.apiKey && !namedProvider) {
        throw new Error(
          'transferStyle: an apiKey needs `provider`, or a model with a provider prefix such as "openai:gpt-image-2.5-sunburst"; it is not sent to a provider chosen from the environment.',
        );
      }
      // Whether a model is chosen for the edit: named by the call or by the
      // global default, or taken from the list above.
      let modelChosen = true;
      if (namedProvider) {
        ({ providerId, modelId } = resolveModelOption(opts, 'image'));
        modelChosen = modelIsNamed(opts, 'image');
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

      const provider = createImageProvider(resolved.providerId);
      // With a provider named and no model, `resolved.modelId` is the
      // provider's text-to-image default. The edit below then gets an empty
      // id, which every provider reads as its own edit default (OpenAI
      // `gpt-image-2.5-sunburst`, Stability `sd3.5-medium`). A provider that
      // cannot edit generates, and keeps its text-to-image default.
      const operationModelId =
        modelChosen || typeof provider.editImage !== 'function' ? resolved.modelId : '';
      if (operationModelId) span?.setAttribute('llm.model', operationModelId);
      await provider.initialize({
        apiKey: resolved.apiKey,
        baseURL: resolved.baseUrl,
        defaultModelId: operationModelId || undefined,
      });

      // Convert style reference to data URL for Flux Redux
      const styleBuffer = await imageToBuffer(opts.styleReference);
      const styleDataUrl = `data:image/png;base64,${styleBuffer.toString('base64')}`;

      let result: ImageGenerationResult;

      if (resolved.providerId === 'replicate' && operationModelId.includes('flux-redux')) {
        // Flux Redux: style reference is the primary image input
        result = await provider.generateImage({
          modelId: operationModelId,
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
          modelId: operationModelId,
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
          modelId: operationModelId,
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
