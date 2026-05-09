/**
 * @file editImage.ts
 * Provider-agnostic image editing for the AgentOS high-level API.
 *
 * Supports three editing modes:
 * - **img2img** — Prompt-guided transformation of a source image, controlled by a
 *   `strength` parameter (0 = keep original, 1 = completely redrawn).
 * - **inpaint** — Mask-guided regional editing where white mask regions are
 *   repainted according to the prompt while black regions are preserved.
 * - **outpaint** — Extends an image beyond its original borders (provider support varies).
 *
 * Routing and credential resolution follow the same `provider:model` pattern
 * established by {@link generateImage}.
 */
import { createImageProvider } from '../media/images/index.js';
import { ImageEditNotSupportedError } from '../media/images/ImageOperationError.js';
import { imageToBuffer } from '../media/images/imageToBuffer.js';
import type {
  GeneratedImage,
  ImageEditMode,
  ImageGenerationResult,
  ImageProviderOptionBag,
} from '../media/images/IImageProvider.js';
import { resolveModelOption, resolveMediaProvider } from './model.js';
import { attachUsageAttributes, toTurnMetricUsage } from './observability.js';
import { recordAgentOSUsage, type AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';
import { recordAgentOSTurnMetrics, withAgentOSSpan } from '../evaluation/observability/otel.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for an {@link editImage} call.
 *
 * @example
 * ```ts
 * const result = await editImage({
 *   provider: 'openai',
 *   image: 'data:image/png;base64,...',
 *   prompt: 'Add a rainbow in the sky.',
 *   mode: 'img2img',
 *   strength: 0.6,
 * });
 * ```
 */
export interface EditImageOptions {
  /**
   * Provider name (e.g. `"openai"`, `"stability"`, `"stable-diffusion-local"`).
   * When omitted, auto-detection via env vars is attempted.
   */
  provider?: string;
  /**
   * Model in `provider:model` format (legacy) or plain model name when `provider` is set.
   * @example `"openai:gpt-image-1"`, `"stability:sd3-medium"`
   */
  model?: string;
  /**
   * Source image as a base64 data URL, raw base64 string, `Buffer`,
   * local file path, or HTTP/HTTPS URL.
   */
  image: string | Buffer;
  /** Text prompt describing the desired changes. */
  prompt: string;
  /**
   * Optional mask for inpainting.  White pixels mark regions to be edited;
   * black pixels mark regions to keep.  Accepts the same formats as `image`.
   */
  mask?: string | Buffer;
  /**
   * Edit mode.
   * - `'img2img'` (default) — prompt-guided transformation.
   * - `'inpaint'` — mask-guided regional editing.
   * - `'outpaint'` — extend image borders.
   */
  mode?: ImageEditMode;
  /**
   * How much to deviate from the source image.
   * `0` = identical, `1` = completely new.  Default `0.75`.
   */
  strength?: number;
  /** Negative prompt describing content to avoid. */
  negativePrompt?: string;
  /** Output size (e.g. `"1024x1024"`). */
  size?: string;
  /** Seed for reproducibility (provider-dependent support). */
  seed?: number;
  /** Number of output images. */
  n?: number;
  /** Override the provider API key instead of reading from env vars. */
  apiKey?: string;
  /** Override the provider base URL. */
  baseUrl?: string;
  /** Arbitrary provider-specific options. */
  providerOptions?: ImageProviderOptionBag | Record<string, unknown>;
  /** Optional usage ledger configuration. */
  usageLedger?: AgentOSUsageLedgerOptions;
  /**
   * Content policy tier. When `'mature'` or `'private-adult'`, the edit is
   * rerouted through {@link PolicyAwareImageRouter} to pick an uncensored
   * community model (e.g. IP-Adapter FaceID SDXL for face-consistent
   * edits, SDXL for generic img2img) and `disable_safety_checker: true`
   * is applied automatically to the Replicate request so the model's own
   * NSFW filter does not veto the prompt.
   *
   * `'safe'` and `'standard'` tiers fall back to whatever `provider` /
   * `model` the caller supplied (or env-detected defaults), keeping the
   * existing censored path intact.
   */
  policyTier?: 'safe' | 'standard' | 'mature' | 'private-adult';
  /**
   * Required provider capabilities for mature/private-adult routing.
   * Drives {@link UncensoredModelCatalog} filtering so callers can ask
   * for `'face-consistency'` when editing a character's outfit, or
   * `'img2img'` when the source is a scene the author wants preserved.
   * Ignored for safe/standard tiers.
   */
  capabilities?: string[];
}

/**
 * Result returned by {@link editImage}.
 */
export interface EditImageResult {
  /** Array of edited image objects containing URLs or base64 data. */
  images: GeneratedImage[];
  /** Provider identifier. */
  provider: string;
  /** Model identifier. */
  model: string;
  /** Token/credit usage reported by the provider, when available. */
  usage: { costUSD?: number };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Edits an image using a provider-agnostic interface.
 *
 * Resolves credentials via `resolveMediaProvider()`, initialises the
 * matching image provider, converts the input image to a `Buffer`, and
 * dispatches to the provider's `editImage` method.
 *
 * @param opts - Image editing options.
 * @returns A promise resolving to the edit result with image data and metadata.
 *
 * @throws {ImageEditNotSupportedError} When the resolved provider does not
 *   implement image editing.
 * @throws {Error} When no provider can be determined or credentials are missing.
 *
 * @example
 * ```ts
 * // Img2img transformation
 * const result = await editImage({
 *   provider: 'stability',
 *   image: fs.readFileSync('landscape.png'),
 *   prompt: 'Convert the daytime scene to a starry night.',
 *   strength: 0.7,
 * });
 *
 * // Inpainting with mask
 * const inpainted = await editImage({
 *   provider: 'openai',
 *   image: 'data:image/png;base64,...',
 *   mask: 'data:image/png;base64,...',
 *   prompt: 'Replace the sky with aurora borealis.',
 *   mode: 'inpaint',
 * });
 * ```
 */
export async function editImage(opts: EditImageOptions): Promise<EditImageResult> {
  const startedAt = Date.now();
  let metricStatus: 'ok' | 'error' = 'ok';
  let metricUsage: ImageGenerationResult['usage'];
  let metricProviderId: string | undefined;
  let metricModelId: string | undefined;

  try {
    return await withAgentOSSpan('agentos.api.edit_image', async (span) => {
      let { providerId, modelId } = resolveModelOption(opts, 'image');
      let effectiveProviderOptions = opts.providerOptions;

      // Policy-tier-aware routing. Mirrors the generateImage flow so
      // both generate and edit surfaces of the API respect the same
      // uncensored catalog and safety-checker bypass. The router only
      // kicks in for mature/private-adult — safe/standard edits keep
      // whatever model the caller resolved above.
      if (
        opts.policyTier
        && (opts.policyTier === 'mature' || opts.policyTier === 'private-adult')
      ) {
        // Caller-pin precedence: when a caller explicitly passes
        // `provider` and/or `model` for a mature-tier edit, that
        // resolution carries information the agentos catalog can't
        // (specifically: pinned version SHAs for community Replicate
        // models that 422 on the modern endpoint without a version,
        // and face-anchor models the catalog flags as broken). The
        // wilds-ai image-jobs layer relies on this — it substitutes
        // `lucataco/ip-adapter-faceid-sdxl` (a known-broken catalog
        // entry) with `zsxkib/pulid` plus a pinned version SHA before
        // calling editImage. Re-running the router here would silently
        // discard that substitution and revert to the broken slug.
        const callerPinnedModel =
          (typeof opts.model === 'string' && opts.model.length > 0)
          || (typeof opts.provider === 'string' && opts.provider.length > 0);

        // Always set disableSafetyChecker for Replicate on mature+
        // tiers, regardless of which model the caller pinned. This is
        // load-bearing for uncensored prompts to render — Replicate's
        // default NSFW filter vetoes them otherwise. Caller's existing
        // explicit setting wins (allows opt-out for test surfaces).
        const existingReplicate =
          (effectiveProviderOptions as Record<string, unknown> | undefined)?.replicate as
            | Record<string, unknown>
            | undefined;
        if (
          existingReplicate === undefined
          || typeof existingReplicate.disableSafetyChecker === 'undefined'
        ) {
          effectiveProviderOptions = {
            ...(effectiveProviderOptions ?? {}),
            replicate: {
              ...(existingReplicate ?? {}),
              disableSafetyChecker: true,
            },
          } as ImageProviderOptionBag;
        }

        if (!callerPinnedModel) {
          const { PolicyAwareImageRouter } = await import(
            '../media/images/PolicyAwareImageRouter.js'
          );
          const { createUncensoredModelCatalog } = await import(
            '../core/llm/routing/UncensoredModelCatalog.js'
          );
          const imageRouter = new PolicyAwareImageRouter(createUncensoredModelCatalog());
          // When the caller didn't pin a capability, default to img2img so
          // the catalog never picks a txt2img-only model for an edit call.
          const capabilities = opts.capabilities ?? ['img2img'];
          const pref = imageRouter.getPreferredProvider(
            opts.policyTier as 'mature' | 'private-adult',
            capabilities,
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
      span?.setAttribute('agentos.api.edit_mode', opts.mode ?? 'img2img');

      const provider = createImageProvider(resolved.providerId);
      await provider.initialize({
        apiKey: resolved.apiKey,
        baseURL: resolved.baseUrl,
        defaultModelId: resolved.modelId,
      });

      // Guard: the provider must implement editImage.
      if (typeof provider.editImage !== 'function') {
        throw new ImageEditNotSupportedError(resolved.providerId);
      }

      // Normalise heterogeneous image input into Buffers.
      const imageBuffer = await imageToBuffer(opts.image);
      const maskBuffer = opts.mask ? await imageToBuffer(opts.mask) : undefined;

      const result = await provider.editImage({
        modelId: resolved.modelId,
        image: imageBuffer,
        prompt: opts.prompt,
        mask: maskBuffer,
        mode: opts.mode,
        strength: opts.strength,
        negativePrompt: opts.negativePrompt,
        size: opts.size,
        seed: opts.seed,
        n: opts.n,
        providerOptions: effectiveProviderOptions,
      });

      metricUsage = result.usage;
      span?.setAttribute('agentos.api.images_count', result.images.length);
      attachUsageAttributes(span, {
        totalCostUSD: result.usage?.totalCostUSD,
      });

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
        providerId: metricProviderId,
        modelId: metricModelId,
        usage: metricUsage
          ? {
              costUSD: metricUsage.totalCostUSD,
            }
          : undefined,
        options: {
          ...opts.usageLedger,
          source: opts.usageLedger?.source ?? 'editImage',
        },
      });
    } catch {
      // Best-effort — usage persistence must not break the edit operation.
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
