/**
 * @file transferStyle.ts
 * Provider-agnostic style transfer for the AgentOS high-level API.
 *
 * Restyles a source image after a style reference, guided by a text prompt,
 * and sends the provider both images. Four providers have a call that takes
 * both:
 *
 * - **Replicate**: FLUX.2 (`black-forest-labs/flux-2-pro` by default), the
 *   two images as `input_images` with an instruction that names them
 * - **Fal**: FLUX.2's edit endpoints (`fal-ai/flux-2-pro/edit` by default),
 *   the two images as `image_urls`
 * - **Stability**: its style-transfer endpoint, the source as `init_image`
 *   and the reference as `style_image`
 * - **OpenAI**: the edits endpoint with two `image[]` parts
 *   (`gpt-image-2.5-sunburst` by default)
 *
 * Any other provider is refused: `variateImage` makes a variation of the
 * reference, and `editImage` changes the source by prompt.
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
import { knownProviderPrefixOf, resolveModelOption, resolveMediaProvider } from './model.js';
import { OPENAI_IMAGE_EDIT_MODEL } from '../io/media/images/providers/OpenAIImageProvider.js';
import { REPLICATE_STYLE_TRANSFER_MODELS } from '../io/media/images/providers/ReplicateImageProvider.js';
import { FAL_STYLE_TRANSFER_MODELS } from '../io/media/images/providers/FalImageProvider.js';
import { STABILITY_STYLE_TRANSFER_MODEL } from '../io/media/images/providers/StabilityImageProvider.js';
import { STYLE_TRANSFER_DEFAULT_STRENGTH } from '../io/media/images/styleTransfer.js';
import { recordAgentOSUsage, type AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';
import { recordAgentOSTurnMetrics, withAgentOSSpan } from '../safety/evaluation/observability/otel.js';

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

/**
 * The providers a call that names none is sent to: the first whose key is
 * set and that has a factory, each on its style-transfer default.
 */
const STYLE_TRANSFER_PROVIDER_PRIORITY: Array<{ envKey: string; providerId: string; modelId: string }> = [
  { envKey: 'REPLICATE_API_TOKEN', providerId: 'replicate', modelId: REPLICATE_STYLE_TRANSFER_MODELS[0] },
  { envKey: 'FAL_API_KEY', providerId: 'fal', modelId: FAL_STYLE_TRANSFER_MODELS[0] },
  { envKey: 'STABILITY_API_KEY', providerId: 'stability', modelId: STABILITY_STYLE_TRANSFER_MODEL },
  { envKey: 'OPENAI_API_KEY', providerId: 'openai', modelId: OPENAI_IMAGE_EDIT_MODEL },
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for a {@link transferStyle} call.
 */
export interface TransferStyleOptions {
  /** Source image to restyle (Buffer, file path, URL, or data URI): its subject and composition are kept. */
  image: string | Buffer;
  /** Reference image whose style is applied (Buffer, file path, URL, or data URI). */
  styleReference: string | Buffer;
  /** Text guiding the result. It may be empty: Stability takes none, and the editing models get an instruction. */
  prompt: string;
  /**
   * How much of the reference's style to apply, from 0 to 1. On Stability it
   * is `style_strength`, where 0 leaves the source as it is. OpenAI and the
   * FLUX.2 models take no strength: below 0.5 they are told to restyle
   * lightly, from 0.5 fully, so 0 still restyles there.
   * @default 0.7
   */
  strength?: number;
  /** Provider override. Auto-detects from env vars if omitted. */
  provider?: string;
  /**
   * Model override. Each provider runs the models its style transfer lists.
   * With a custom `baseUrl`, OpenAI and Fal take any name and Replicate any
   * `owner/name`; Stability's endpoint takes no model.
   */
  model?: string;
  /** Output size (e.g. `'1024x1024'`). Sent to OpenAI only. */
  size?: string;
  /** Negative prompt describing content to avoid. Sent to Stability only. */
  negativePrompt?: string;
  /** Seed for reproducible output. OpenAI takes none. */
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
  /**
   * Base URL for the provider, instead of its default or its environment
   * variable. Like `apiKey`, it needs `provider` or a provider-prefixed `model`:
   * it is not sent to a provider chosen from the environment, with that
   * provider's key.
   */
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
 * Restyles a source image after a style reference, sending the provider both.
 *
 * With no provider named, the first provider whose key is set serves:
 * Replicate (`REPLICATE_API_TOKEN`), Fal (`FAL_API_KEY`), Stability
 * (`STABILITY_API_KEY`), then OpenAI (`OPENAI_API_KEY`). A named provider
 * without a style transfer that takes both images is refused, and so is a
 * model its style transfer does not run, both before either image is read.
 *
 * @param opts - Style transfer options.
 * @returns Promise resolving to the transfer result with styled image(s).
 *
 * @throws {Error} When the arguments are refused, no style transfer provider
 *   is configured, the provider or model cannot run one, an image or option
 *   is refused, or the provider fails.
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
      if (typeof opts.prompt !== 'string') {
        throw new Error('transferStyle: prompt must be a string (it may be empty).');
      }
      if (
        opts.strength !== undefined &&
        !(typeof opts.strength === 'number' && Number.isFinite(opts.strength) && opts.strength >= 0 && opts.strength <= 1)
      ) {
        throw new Error(`transferStyle: strength must be a number from 0 to 1; it is ${String(opts.strength)}.`);
      }

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
      // A base URL belongs to one vendor too: with no provider named it would
      // receive whichever provider the environment selects, with its key.
      if (opts.baseUrl && !namedProvider) {
        throw new Error(
          'transferStyle: a baseUrl needs `provider`, or a model with a provider prefix such as "openai:gpt-image-2.5-sunburst"; it is not sent to a provider chosen from the environment, with that provider\'s key.',
        );
      }

      // The provider, and the model the call names ('' for the provider's
      // style-transfer default). The global default's model is not used: it
      // is a generation default.
      let providerId: string;
      let callModel = '';
      if (namedProvider) {
        if (opts.model) {
          // resolveModelOption's rules: a known `provider:` prefix wins over
          // `provider`, and `provider` over another provider's slash path.
          ({ providerId, modelId: callModel } = resolveModelOption(opts, 'image'));
        } else {
          providerId = namedProvider;
        }
      } else {
        const match = STYLE_TRANSFER_PROVIDER_PRIORITY.find(
          (p) => process.env[p.envKey] && hasImageProviderFactory(p.providerId),
        );
        if (!match) {
          throw new Error(
            'No style transfer provider configured. Set REPLICATE_API_TOKEN, FAL_API_KEY, STABILITY_API_KEY, or OPENAI_API_KEY.',
          );
        }
        providerId = match.providerId;
        callModel = opts.model ?? match.modelId;
      }

      // A provider with no two-image call is refused before its key or base
      // URL is looked for: the refusal does not depend on its credentials.
      const provider = createImageProvider(providerId);
      if (typeof provider.transferStyle !== 'function' || typeof provider.styleTransferModel !== 'function') {
        throw new Error(
          `transferStyle: ${providerId} has no style transfer that sends both images. Use replicate, fal, stability or openai; variateImage makes a variation of the reference, and editImage changes the source by prompt.`,
        );
      }
      const resolved = resolveMediaProvider(providerId, callModel, {
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
      });
      span?.setAttribute('llm.provider', resolved.providerId);
      // initialize makes no request, and the model is checked before either
      // image is read or fetched.
      await provider.initialize({ apiKey: resolved.apiKey, baseURL: resolved.baseUrl });
      const model = provider.styleTransferModel(callModel);
      span?.setAttribute('llm.model', model);

      const image = await imageToBuffer(opts.image);
      const styleImage = await imageToBuffer(opts.styleReference);

      const result = await provider.transferStyle({
        modelId: model,
        image,
        styleImage,
        prompt: opts.prompt,
        strength: opts.strength ?? STYLE_TRANSFER_DEFAULT_STRENGTH,
        negativePrompt: opts.negativePrompt,
        size: opts.size,
        seed: opts.seed,
        providerOptions: opts.providerOptions,
      });

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
