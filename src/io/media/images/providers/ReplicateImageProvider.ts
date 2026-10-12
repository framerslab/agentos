import {
  type GeneratedImage,
  getImageProviderOptions,
  inferAspectRatioFromSize,
  parseDataUrl,
  type IImageProvider,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ImageEditRequest,
  type ImageStyleTransferRequest,
  type ImageUpscaleRequest,
  type ImageModelInfo,
  normalizeOutputFormat,
  type ReplicateImageProviderOptions,
} from '../IImageProvider.js';
import { editPartType, imageDataUrl, imageFilePart, type ImagePartType } from '../blobPart.js';
import {
  INDEXED_IMAGE_NAMES,
  styleTransferImageTypes,
  styleTransferModelError,
  styleTransferPrompt,
} from '../styleTransfer.js';
import { ApiKeyPool } from '../../../../core/providers/ApiKeyPool.js';

/** Replicate's API, the provider's base URL unless one is configured. */
const REPLICATE_BASE_URL = 'https://api.replicate.com/v1';

/**
 * The size from which an input image goes through Replicate's Files API
 * instead of inline. Replicate recommends a data URL "only if the file is less
 * than 1MB" (https://replicate.com/docs/topics/predictions/input-files), and its
 * own client uploads every file (`POST /v1/files`, the input then naming the
 * file's `urls.get`).
 */
const MAX_INLINE_IMAGE_BYTES = 1_000_000;

/**
 * The models Replicate's style transfer runs on, FLUX.2 Pro first as the
 * default. Each takes `input_images` ("Maximum 8 images" for pro and max, 10
 * for flex, 5 for dev; "Must be jpeg, png, gif, or webp") and an
 * `aspect_ratio` of `match_input_image`
 * (https://replicate.com/black-forest-labs/flux-2-pro/llms.txt and the same
 * page of the other three, read 2026-10-12).
 */
export const REPLICATE_STYLE_TRANSFER_MODELS: readonly string[] = [
  'black-forest-labs/flux-2-pro',
  'black-forest-labs/flux-2-max',
  'black-forest-labs/flux-2-flex',
  'black-forest-labs/flux-2-dev',
];

/**
 * Pinned version for the strict-consistency Pulid auto-route. zsxkib/pulid
 * is a Replicate COMMUNITY model: calling it bare (owner/name) on the modern
 * /models endpoint returns 422 "Invalid version or not permitted", so the
 * auto-route must carry an inline version to take the legacy /predictions
 * endpoint. Face-anchored SDXL: face from main_face_image, rest from prompt.
 */
const PULID_PINNED_MODEL =
  'zsxkib/pulid:43d309c37ab4e62361e5e29b8e9e867fb2dcbcec77ae91206a8d95ac5dd451a0';

export interface ReplicateImageProviderConfig {
  apiKey: string;
  baseURL?: string;
  defaultModelId?: string;
}

type ReplicatePrediction = {
  id?: string;
  status?: string;
  version?: string;
  output?: unknown;
  error?: string;
  metrics?: Record<string, unknown>;
  urls?: {
    get?: string;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeReplicateOutput(output: unknown): GeneratedImage[] {
  const items = Array.isArray(output) ? output : [output];
  const images: GeneratedImage[] = [];

  for (const item of items) {
    if (typeof item === 'string') {
      const parsed = parseDataUrl(item);
      images.push({
        ...parsed,
        url: parsed.dataUrl?.startsWith('data:') ? undefined : parsed.dataUrl,
      });
      continue;
    }

    if (item && typeof item === 'object') {
      const candidate = item as Record<string, unknown>;
      const value =
        (typeof candidate.url === 'string' && candidate.url)
        || (typeof candidate.uri === 'string' && candidate.uri)
        || (typeof candidate.output === 'string' && candidate.output);
      if (!value) {
        continue;
      }

      const parsed = parseDataUrl(value);
      images.push({
        ...parsed,
        url: parsed.dataUrl?.startsWith('data:') ? undefined : parsed.dataUrl,
        providerMetadata: candidate,
      });
    }
  }

  return images;
}

/**
 * Replicate's img2img default: Stable Diffusion XL, pinned to a version.
 * Replicate runs a model by its name alone only when it is an official model;
 * "for all other models, the specific version is required" (the `version`
 * field of POST /v1/predictions in https://api.replicate.com/openapi.json),
 * and stability-ai/sdxl is not in the official collection. This is its
 * current version on https://replicate.com/stability-ai/sdxl/versions (read
 * 2026-10-10).
 */
const SDXL_IMG2IMG = 'stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc';

export class ReplicateImageProvider implements IImageProvider {
  public readonly providerId = 'replicate';
  public isInitialized = false;
  public defaultModelId?: string;

  private config!: Required<Pick<ReplicateImageProviderConfig, 'apiKey'>> & ReplicateImageProviderConfig;
  private keyPool!: ApiKeyPool;

  async initialize(config: Record<string, unknown>): Promise<void> {
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (!apiKey) {
      throw new Error('Replicate image provider requires apiKey.');
    }

    this.config = {
      apiKey,
      baseURL:
        typeof config.baseURL === 'string' && config.baseURL.trim()
          ? config.baseURL.trim()
          : REPLICATE_BASE_URL,
      defaultModelId:
        typeof config.defaultModelId === 'string' && config.defaultModelId.trim()
          ? config.defaultModelId.trim()
          : 'black-forest-labs/flux-schnell',
    };
    this.defaultModelId = this.config.defaultModelId;
    this.keyPool = new ApiKeyPool(apiKey);
    this.isInitialized = true;
  }

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('Replicate image provider is not initialized.');
    }

    const providerOptions = getImageProviderOptions<ReplicateImageProviderOptions>(
      this.providerId,
      request.providerOptions,
    );
    const input: Record<string, unknown> = {
      prompt: request.prompt,
      ...(providerOptions?.input ?? {}),
    };

    const aspectRatio = providerOptions?.aspectRatio ?? request.aspectRatio ?? inferAspectRatioFromSize(request.size);
    if (aspectRatio && input.aspect_ratio === undefined) input.aspect_ratio = aspectRatio;
    if (request.n && input.num_outputs === undefined) input.num_outputs = request.n;
    if (providerOptions?.numOutputs !== undefined) input.num_outputs = providerOptions.numOutputs;
    if (request.seed !== undefined && input.seed === undefined) input.seed = request.seed;
    if (providerOptions?.seed !== undefined) input.seed = providerOptions.seed;
    if (request.negativePrompt && input.negative_prompt === undefined) input.negative_prompt = request.negativePrompt;
    if (providerOptions?.negativePrompt !== undefined) input.negative_prompt = providerOptions.negativePrompt;
    if (request.outputFormat && input.output_format === undefined) {
      input.output_format = normalizeOutputFormat(providerOptions?.outputFormat ?? request.outputFormat);
    }
    if (providerOptions?.outputFormat !== undefined) {
      input.output_format = normalizeOutputFormat(providerOptions.outputFormat);
    }
    if (providerOptions?.outputQuality !== undefined) input.output_quality = providerOptions.outputQuality;
    if (providerOptions?.disableSafetyChecker !== undefined) {
      input.disable_safety_checker = providerOptions.disableSafetyChecker;
    }
    if (providerOptions?.goFast !== undefined) input.go_fast = providerOptions.goFast;
    if (providerOptions?.megapixels !== undefined) input.megapixels = providerOptions.megapixels;

    // --- Character consistency + ControlNet mapping ---
    const CONSISTENCY_STRENGTHS: Record<string, number> = {
      strict: 0.85,
      balanced: 0.6,
      loose: 0.3,
    };

    const refUrl = request.referenceImageUrl ?? providerOptions?.referenceImageUrl;
    const consistencyMode = request.consistencyMode ?? 'balanced';

    // Resolve model ID with auto-routing for consistency and ControlNet
    let modelId = request.modelId || this.defaultModelId || 'black-forest-labs/flux-schnell';

    // Auto-select Pulid for strict consistency when no model explicitly set.
    // The version is pinned inline: zsxkib/pulid is a community model, and
    // the modern /models/{owner}/{name}/predictions endpoint returns 422
    // "Invalid version or not permitted" for community models called
    // without a version. The inline owner/name:SHA form routes through the
    // legacy /predictions endpoint below, which honors the pin.
    if (refUrl && consistencyMode === 'strict' && !request.modelId) {
      modelId = PULID_PINNED_MODEL;
    }

    // Auto-route by controlType when controlImage is set and no model specified
    if (providerOptions?.controlImage && providerOptions.controlType && !request.modelId) {
      const controlRoutes: Record<string, string> = {
        canny: 'black-forest-labs/flux-canny-dev',
        depth: 'black-forest-labs/flux-depth-dev',
      };
      const routed = controlRoutes[providerOptions.controlType];
      if (routed) modelId = routed;
    }

    // Map reference image to model-specific input field
    if (refUrl) {
      if (modelId.includes('pulid')) {
        input.main_face_image = refUrl;
      } else if (modelId.includes('flux-2')) {
        // Flux 2 family (flux-2-pro / flux-2-max / flux-2-flex) takes an
        // input_images ARRAY (max 8) for reference-anchored generation and
        // rejects the SDXL-style image/image_strength pair with a 422.
        // Respect a caller-provided array (providerOptions.input) verbatim.
        if (input.input_images === undefined) {
          input.input_images = [refUrl];
        }
      } else if (modelId.includes('kontext')) {
        // Kontext editing models take input_image (singular) and reject
        // unknown image/image_strength fields.
        if (input.input_image === undefined) {
          input.input_image = refUrl;
        }
      } else if (modelId.includes('flux-redux')) {
        // The reference goes as redux_image (see the prompt rule below).
        if (input.redux_image === undefined) input.redux_image = refUrl;
      } else {
        input.image = refUrl;
        input.image_strength = CONSISTENCY_STRENGTHS[consistencyMode];
      }
    }

    // FLUX.1 Redux takes its reference as redux_image, which "replaces
    // prompt": its input has no image, prompt or negative_prompt
    // (https://replicate.com/black-forest-labs/flux-redux-dev/api/schema).
    // The prompt this provider adds is dropped however the reference came; a
    // caller's own providerOptions.input is sent as given.
    if (modelId.includes('flux-redux')) {
      const raw = providerOptions?.input ?? {};
      if (!('prompt' in raw)) delete input.prompt;
      if (!('negative_prompt' in raw)) delete input.negative_prompt;
    }

    // Map control image for ControlNet models
    if (providerOptions?.controlImage) {
      input.control_image = providerOptions.controlImage;
    }

    // Dual-endpoint routing, mirroring editImage:
    //
    //   A) modelId contains a colon (owner/name:SHA) → legacy /predictions
    //      with the SHA in body.version.
    //   B) providerOptions.extraBody.version is set → the caller pinned a
    //      community-model version out-of-band. Also use the legacy
    //      endpoint so Replicate honors the pin. Before this branch
    //      existed, generateImage silently DROPPED the out-of-band pin on
    //      the modern endpoint and community models 422'd ("Invalid
    //      version or not permitted") — editImage already handled this.
    //   C) Otherwise → official model, modern /models/.../predictions.
    const hasVersionHash = modelId.includes(':');
    const generateExtraBodyVersion =
      typeof (providerOptions?.extraBody as Record<string, unknown> | undefined)?.version === 'string'
        ? ((providerOptions?.extraBody as Record<string, unknown>).version as string)
        : undefined;
    const waitSeconds = providerOptions?.wait ?? 60;
    let prediction: ReplicatePrediction;

    // A Redux model makes a variation of its reference image and nothing
    // else. Checked on the input the request sends: the legacy endpoint's
    // branches put extraBody over the body, so an extraBody.input replaces
    // the input whole.
    const extraInput = (providerOptions?.extraBody as { input?: Record<string, unknown> } | undefined)?.input;
    const sentInput = (hasVersionHash || generateExtraBodyVersion) && extraInput ? extraInput : input;
    if (modelId.includes('flux-redux') && sentInput.redux_image === undefined) {
      throw new Error(
        `Replicate ${modelId} makes a variation of a reference image: pass referenceImageUrl, which it takes as redux_image.`,
      );
    }

    if (hasVersionHash) {
      // Legacy endpoint: POST /predictions with { version, input }
      const body: Record<string, unknown> = { version: modelId, input };
      if (providerOptions?.webhook) body.webhook = providerOptions.webhook;
      if (providerOptions?.webhookEventsFilter) body.webhook_events_filter = providerOptions.webhookEventsFilter;
      if (providerOptions?.extraBody) Object.assign(body, providerOptions.extraBody);
      prediction = await this.createPrediction(body, waitSeconds);
    } else if (generateExtraBodyVersion) {
      // Legacy endpoint with the out-of-band version pin. Merge the rest
      // of extraBody (minus version, already placed) so webhook overrides
      // etc. keep working.
      const body: Record<string, unknown> = { version: generateExtraBodyVersion, input };
      if (providerOptions?.webhook) body.webhook = providerOptions.webhook;
      if (providerOptions?.webhookEventsFilter) body.webhook_events_filter = providerOptions.webhookEventsFilter;
      const { version: _v, ...restExtraBody } = (providerOptions?.extraBody ?? {}) as Record<string, unknown>;
      Object.assign(body, restExtraBody);
      prediction = await this.createPrediction(body, waitSeconds);
    } else {
      // Modern endpoint: POST /models/{owner}/{name}/predictions with { input }
      const slashIndex = modelId.indexOf('/');
      const owner = modelId.substring(0, slashIndex);
      const name = modelId.substring(slashIndex + 1);
      prediction = await this.createModelPrediction(owner, name, input, waitSeconds);
    }

    prediction = await this.finishedPrediction(prediction, 'image generation');

    const images = normalizeReplicateOutput(prediction.output).filter((image) => image.url || image.base64);
    if (images.length === 0) {
      throw new Error('Replicate returned no image output.');
    }

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: modelId,
      providerId: this.providerId,
      images,
      usage: {
        totalImages: images.length,
      },
    };
  }

  /**
   * Edits an image using a Replicate model that supports image-to-image input.
   *
   * Uses `black-forest-labs/flux-fill` for inpainting (when a mask is provided)
   * or falls back to `stability-ai/sdxl` for generic img2img transforms.
   * The source image goes in the model input as a data URL of its type, or,
   * from 1 MB, as a file uploaded to Replicate's Files API.
   *
   * @param request - Edit request with source image, prompt, and optional mask.
   * @returns Generation result with the edited image(s).
   *
   * @throws {Error} When the provider is not initialised or the API fails.
   */
  async editImage(request: ImageEditRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('Replicate image provider is not initialized.');
    }

    const providerOptions = getImageProviderOptions<ReplicateImageProviderOptions>(
      this.providerId,
      request.providerOptions,
    );

    // Choose the model based on whether inpainting is requested.
    const hasInpaintingMask = !!request.mask;
    const defaultModel = hasInpaintingMask
      ? 'black-forest-labs/flux-fill-pro'  // Flux Fill Pro for production inpainting.
      : SDXL_IMG2IMG;                     // SDXL supports generic img2img via image input.
    const model = request.modelId || defaultModel;

    // One key for the uploads, the prediction and its polling: Replicate lets
    // only the account that uploaded a file pass it as an input.
    const apiKey = this.keyPool.next();

    // The source goes as `image` (a Kontext model's `input_image`, below), as
    // its own type; one the caller set in providerOptions.input wins and is not
    // uploaded.
    const callerInput = providerOptions?.input ?? {};
    const callerSource =
      callerInput.image !== undefined || (model.includes('kontext') && callerInput.input_image !== undefined);
    const input: Record<string, unknown> = {
      prompt: request.prompt,
      ...(callerSource ? {} : { image: await this.inputImage(request.image, editPartType(request.image), 'image', apiKey) }),
      ...callerInput,
    };

    if (hasInpaintingMask) {
      input.mask = await this.inputImage(request.mask!, editPartType(request.mask!), 'mask', apiKey);
    }

    if (request.strength !== undefined) input.strength = request.strength;
    if (request.negativePrompt) input.negative_prompt = request.negativePrompt;
    if (request.seed !== undefined) input.seed = request.seed;
    if (request.n) input.num_outputs = request.n;
    // Mirror the generateImage handling so mature/private-adult edits can
    // bypass the community-model NSFW filter. Without this, policy-aware
    // routing picks an uncensored model but the model's own safety flag
    // still rejects the prompt, returning a placeholder gradient.
    if (providerOptions?.disableSafetyChecker !== undefined) {
      input.disable_safety_checker = providerOptions.disableSafetyChecker;
    }

    // SDXL takes the edit strength as prompt_strength and has no `strength`
    // input. A prompt_strength the caller put in providerOptions.input wins.
    if (model.startsWith('stability-ai/sdxl') && input.strength !== undefined) {
      if (input.prompt_strength === undefined) input.prompt_strength = input.strength;
      delete input.strength;
    }

    // Kontext editing models (flux-kontext-pro/-max/-dev) take input_image
    // (singular) and 422 on the SDXL-style image/strength fields. Re-map the
    // auto-added source image unless the caller already supplied
    // input_image via providerOptions.input. flux-fill (the mask branch)
    // is NOT kontext-named and keeps image+mask untouched.
    if (model.includes('kontext')) {
      if (input.input_image === undefined && input.image !== undefined) {
        input.input_image = input.image;
      }
      delete input.image;
      delete input.strength;
    }
    const waitSeconds = providerOptions?.wait ?? 60;

    // Dual-endpoint routing, mirroring generateImage.
    //
    //   A) modelId contains a colon (owner/name:SHA) → the caller pinned
    //      a community-model version inline. Use the legacy
    //      `/predictions` endpoint; the SHA goes into `body.version`.
    //   B) providerOptions.extraBody.version is set → the caller pinned
    //      a version out-of-band (e.g. wilds-ai's broken-catalog
    //      substitution forwards the SHA via providerOptions rather
    //      than mutating the modelId). Also use the legacy endpoint so
    //      Replicate honors the pin.
    //   C) Otherwise → official model with no pin. Use the modern
    //      `/models/{owner}/{name}/predictions` endpoint which accepts
    //      `{ input }` directly. Passing a bare owner/name as `version`
    //      to the legacy endpoint returns 422 "Invalid version or not
    //      permitted" — this was the silent-422 bug that blocked every
    //      wilds-ai outfit / avatar / selfie edit.
    //
    // Before this patch editImage unconditionally hit the legacy
    // endpoint so path C always 422'd; generateImage already had this
    // split and worked correctly.
    const extraBodyVersion =
      typeof (providerOptions?.extraBody as Record<string, unknown> | undefined)?.version === 'string'
        ? ((providerOptions?.extraBody as Record<string, unknown>).version as string)
        : undefined;
    const hasInlineVersionHash = model.includes(':');
    let prediction: ReplicatePrediction;

    if (hasInlineVersionHash) {
      const body: Record<string, unknown> = {
        version: model,
        input,
      };
      if (providerOptions?.extraBody) Object.assign(body, providerOptions.extraBody);
      prediction = await this.createPrediction(body, waitSeconds, apiKey);
    } else if (extraBodyVersion) {
      // Version supplied via providerOptions.extraBody.version. Build
      // the legacy body so the SHA ends up on `version` rather than
      // being dropped by the modern endpoint.
      const body: Record<string, unknown> = {
        version: extraBodyVersion,
        input,
      };
      const { version: _v, ...rest } = providerOptions?.extraBody ?? {};
      if (Object.keys(rest).length > 0) Object.assign(body, rest);
      prediction = await this.createPrediction(body, waitSeconds, apiKey);
    } else {
      const slashIndex = model.indexOf('/');
      if (slashIndex === -1) {
        throw new Error(
          `Replicate edit modelId must be "owner/name" or "owner/name:version" (got "${model}")`,
        );
      }
      const owner = model.substring(0, slashIndex);
      const name = model.substring(slashIndex + 1);
      prediction = await this.createModelPrediction(owner, name, input, waitSeconds, apiKey);
    }

    prediction = await this.finishedPrediction(prediction, 'image edit', apiKey);

    const images = normalizeReplicateOutput(prediction.output).filter((image) => image.url || image.base64);
    if (images.length === 0) {
      throw new Error('Replicate edit returned no image output.');
    }

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      images,
      usage: { totalImages: images.length },
    };
  }

  /**
   * Upscales an image using a Replicate upscaling model.
   *
   * Defaults to `nightmareai/real-esrgan` which supports 2x and 4x upscaling
   * via the `scale` input parameter.
   *
   * @param request - Upscale request with source image and desired scale factor.
   * @returns Generation result with the upscaled image.
   *
   * @throws {Error} When the provider is not initialised or the API fails.
   */
  async upscaleImage(request: ImageUpscaleRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('Replicate image provider is not initialized.');
    }

    const providerOptions = getImageProviderOptions<ReplicateImageProviderOptions>(
      this.providerId,
      request.providerOptions,
    );

    // One key for the upload, the prediction and its polling (see editImage).
    const apiKey = this.keyPool.next();
    const callerInput = providerOptions?.input ?? {};
    const input: Record<string, unknown> = {
      ...(callerInput.image !== undefined ? {} : { image: await this.inputImage(request.image, editPartType(request.image), 'image', apiKey) }),
      scale: request.scale ?? 2,
      ...callerInput,
    };

    const model = request.modelId || 'nightmareai/real-esrgan';
    const body: Record<string, unknown> = {
      version: model,
      input,
    };

    const waitSeconds = providerOptions?.wait ?? 60;
    const prediction = await this.finishedPrediction(await this.createPrediction(body, waitSeconds, apiKey), 'image upscale', apiKey);

    const images = normalizeReplicateOutput(prediction.output).filter((image) => image.url || image.base64);
    if (images.length === 0) {
      throw new Error('Replicate upscale returned no image output.');
    }

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      images,
      usage: { totalImages: images.length },
    };
  }

  /**
   * The model a style transfer runs on for `modelId`, or a refusal. An empty
   * id takes the configured default when it is one of
   * {@link REPLICATE_STYLE_TRANSFER_MODELS}, else FLUX.2 Pro. A named model
   * must be one of them, unless the provider's base URL is not Replicate's;
   * it is run by its name on the model endpoint, so a pinned version
   * (`owner/name:version`) is refused.
   *
   * @param modelId - The model the call names, or an empty string.
   * @throws {Error} For a model the style transfer does not run.
   */
  styleTransferModel(modelId: string): string {
    if (!modelId) {
      return this.defaultModelId && REPLICATE_STYLE_TRANSFER_MODELS.includes(this.defaultModelId)
        ? this.defaultModelId
        : REPLICATE_STYLE_TRANSFER_MODELS[0];
    }
    if (!/^[^/:\s]+\/[^/:\s]+$/.test(modelId)) {
      throw new Error(
        `Replicate's style transfer runs a model by its name, "owner/name", on the model endpoint; ${modelId} is not one (a pinned version is not taken).`,
      );
    }
    if (REPLICATE_STYLE_TRANSFER_MODELS.includes(modelId) || this.hasCustomEndpoint()) return modelId;
    throw styleTransferModelError('Replicate', modelId, REPLICATE_STYLE_TRANSFER_MODELS, 'A custom baseUrl takes another "owner/name" model.');
  }

  /**
   * Restyles an image after a style reference on a FLUX.2 model, which takes
   * both as `input_images`, the source first, with an instruction that names
   * them by index ("point to other reference images by their index number",
   * https://replicate.com/black-forest-labs/flux-2-pro). FLUX.2 takes no
   * strength and no negative prompt: `strength` picks the instruction (see
   * `styleTransfer.ts`), and the output keeps the source's aspect ratio
   * (`match_input_image`) unless `providerOptions.input` sets another.
   *
   * The call's prompt and its two images are what it sends, so a
   * `providerOptions.input` naming `prompt`, `input_images`, `image` or
   * `input_image` is refused, and so is `providerOptions.extraBody`, which
   * could pin another version or replace the input. The prediction must end
   * `succeeded`; a failed, canceled or unfinished one throws.
   *
   * @param request - The source, the reference and the prompt.
   * @returns Generation result with the restyled image(s).
   *
   * @throws {Error} When the provider is not initialised, the model, an image
   *   or an option is refused, the API fails, the prediction does not
   *   succeed, or its output holds no image.
   */
  async transferStyle(request: ImageStyleTransferRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('Replicate image provider is not initialized.');
    }
    const model = this.styleTransferModel(request.modelId);
    const providerOptions = getImageProviderOptions<ReplicateImageProviderOptions>(
      this.providerId,
      request.providerOptions,
    );
    const callerInput = providerOptions?.input ?? {};
    const reserved = ['prompt', 'input_images', 'image', 'input_image'].filter((key) => callerInput[key] !== undefined);
    if (reserved.length > 0) {
      throw new Error(
        `Replicate's style transfer sends the call's prompt and its two images; providerOptions.input may not set ${reserved.join(', ')}.`,
      );
    }
    if (providerOptions?.extraBody !== undefined) {
      throw new Error(
        "Replicate's style transfer runs the model it names; providerOptions.extraBody, which can pin another version or replace the input, is not taken.",
      );
    }
    const types = styleTransferImageTypes(
      'Replicate',
      ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
      request.image,
      request.styleImage,
    );

    // One key for the uploads, the prediction and its polling (see editImage).
    const apiKey = this.keyPool.next();
    const input: Record<string, unknown> = {
      ...callerInput,
      prompt: styleTransferPrompt(request.prompt, request.strength, INDEXED_IMAGE_NAMES),
      input_images: [
        await this.inputImage(request.image, types.image, 'image', apiKey),
        await this.inputImage(request.styleImage, types.style, 'style', apiKey),
      ],
    };
    if (input.aspect_ratio === undefined) input.aspect_ratio = 'match_input_image';
    const seed = request.seed ?? providerOptions?.seed;
    if (seed !== undefined) input.seed = seed;
    // FLUX.2's examples write JPEG as `jpg` (https://replicate.com/black-forest-labs/flux-2-pro).
    if (providerOptions?.outputFormat !== undefined) {
      const format = normalizeOutputFormat(providerOptions.outputFormat);
      input.output_format = format === 'jpeg' ? 'jpg' : format;
    }
    if (providerOptions?.outputQuality !== undefined) input.output_quality = providerOptions.outputQuality;

    const slash = model.indexOf('/');
    const prediction = await this.finishedPrediction(
      await this.createModelPrediction(model.slice(0, slash), model.slice(slash + 1), input, providerOptions?.wait ?? 60, apiKey),
      'style transfer',
      apiKey,
    );

    const images = normalizeReplicateOutput(prediction.output).filter((image) => image.url || image.base64);
    if (images.length === 0) {
      throw new Error('Replicate style transfer returned no image.');
    }

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      images,
      usage: { totalImages: images.length },
    };
  }

  /**
   * A prediction run to its end: polled at its `urls.get` while it runs, and
   * returned only once it has succeeded.
   *
   * @param prediction - The prediction as created.
   * @param what - The operation's name, for the errors.
   * @param apiKey - The key that created it, which then polls it; the pool's
   *   next key when not given.
   * @throws {Error} When it fails, is canceled, runs with no URL to poll, or
   *   ends without a status.
   */
  private async finishedPrediction(prediction: ReplicatePrediction, what: string, apiKey?: string): Promise<ReplicatePrediction> {
    let current = prediction;
    if (current.status && !['succeeded', 'failed', 'canceled'].includes(current.status)) {
      if (!current.urls?.get) {
        throw new Error(`Replicate ${what} is ${current.status} and gave no URL to poll.`);
      }
      current = await this.pollPrediction(current.urls.get, 60_000, 1_000, apiKey);
    }
    switch (current.status) {
      case 'succeeded':
        return current;
      case 'failed':
        throw new Error(`Replicate ${what} failed: ${current.error ?? 'unknown error'}`);
      case 'canceled':
        throw new Error(`Replicate ${what} was canceled.`);
      default:
        throw new Error(`Replicate ${what} ended without a status.`);
    }
  }

  /** Whether the provider's base URL is not Replicate's own. */
  private hasCustomEndpoint(): boolean {
    const baseURL = this.config?.baseURL;
    return typeof baseURL === 'string' && baseURL.replace(/\/+$/, '') !== REPLICATE_BASE_URL;
  }

  async listAvailableModels(): Promise<ImageModelInfo[]> {
    return [
      // Generation
      { providerId: this.providerId, modelId: 'black-forest-labs/flux-schnell', displayName: 'Flux Schnell', description: 'Fast generation, 4 steps' },
      { providerId: this.providerId, modelId: 'black-forest-labs/flux-dev', displayName: 'Flux Dev', description: 'Open-weight development model' },
      { providerId: this.providerId, modelId: 'black-forest-labs/flux-pro', displayName: 'Flux Pro', description: 'Highest quality commercial' },
      { providerId: this.providerId, modelId: 'black-forest-labs/flux-1.1-pro', displayName: 'Flux 1.1 Pro', description: 'Latest pro generation' },
      { providerId: this.providerId, modelId: 'black-forest-labs/flux-1.1-pro-ultra', displayName: 'Flux 1.1 Pro Ultra', description: 'Ultra-high resolution' },
      { providerId: this.providerId, modelId: 'bytedance/sdxl-lightning-4step', displayName: 'SDXL Lightning', description: '4-step fast SDXL' },
      { providerId: this.providerId, modelId: 'stability-ai/sdxl', displayName: 'SDXL', description: 'Classic Stable Diffusion XL' },
      // Style transfer: the FLUX.2 models, which take the source and the style reference
      ...REPLICATE_STYLE_TRANSFER_MODELS.map((modelId) => ({
        providerId: this.providerId,
        modelId,
        displayName: `FLUX.2 ${modelId.slice('black-forest-labs/flux-2-'.length)}`,
        description: 'Generation and editing from several reference images; transferStyle runs on it',
      })),
      // Variation of a reference image
      { providerId: this.providerId, modelId: 'black-forest-labs/flux-redux-dev', displayName: 'Flux Redux Dev', description: 'A variation of one reference image (referenceImageUrl); it takes no prompt' },
      // ControlNet
      { providerId: this.providerId, modelId: 'black-forest-labs/flux-canny-dev', displayName: 'Flux Canny', description: 'Edge-guided generation' },
      { providerId: this.providerId, modelId: 'black-forest-labs/flux-depth-dev', displayName: 'Flux Depth', description: 'Depth-guided generation' },
      // Character consistency
      { providerId: this.providerId, modelId: 'zsxkib/pulid', displayName: 'Pulid', description: 'Face-consistent generation from reference' },
      // Inpainting
      { providerId: this.providerId, modelId: 'black-forest-labs/flux-fill-pro', displayName: 'Flux Fill Pro', description: 'Production inpainting' },
      // Upscaling
      { providerId: this.providerId, modelId: 'nightmareai/real-esrgan', displayName: 'Real-ESRGAN', description: '2x/4x image upscaling' },
    ];
  }

  /**
   * An input image as Replicate takes it: inline as a data URL of its type when
   * it is under {@link MAX_INLINE_IMAGE_BYTES}, or when the base URL is not
   * Replicate's (a self-hosted model has no Files API); else uploaded to the
   * Files API and named by the file's URL.
   *
   * @param bytes - The image.
   * @param type - Its format.
   * @param name - The upload's file name, without its extension.
   * @param apiKey - The key of the prediction the image is for: Replicate
   *   lets only the account that uploaded a file pass it as an input.
   * @throws {Error} When the upload fails or answers without the file's URL.
   */
  private async inputImage(bytes: Buffer, type: ImagePartType, name: string, apiKey: string): Promise<string> {
    if (bytes.byteLength < MAX_INLINE_IMAGE_BYTES || this.hasCustomEndpoint()) return imageDataUrl(bytes, type);
    const { blob, filename } = imageFilePart(bytes, type, name);
    const form = new FormData();
    form.append('content', blob, filename);
    const response = await fetch(`${this.config.baseURL}/files`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}` },
      body: form,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Replicate file upload failed (${response.status}): ${errorText}`);
    }
    const file = (await response.json()) as { urls?: { get?: unknown } };
    if (typeof file.urls?.get !== 'string') {
      throw new Error('Replicate file upload answered without the file URL (urls.get).');
    }
    return file.urls.get;
  }

  /**
   * Creates a prediction using the modern model-based endpoint.
   *
   * Official models on Replicate (e.g. `black-forest-labs/flux-1.1-pro`)
   * use `/models/{owner}/{name}/predictions` which accepts `{ input }`
   * directly without a `version` field.
   *
   * @param owner - Model owner (e.g. `'black-forest-labs'`).
   * @param name - Model name (e.g. `'flux-1.1-pro'`).
   * @param input - Model input parameters.
   * @param waitSeconds - Maximum seconds to wait for synchronous completion.
   * @returns The prediction response, possibly still in progress.
   */
  private async createModelPrediction(
    owner: string,
    name: string,
    input: Record<string, unknown>,
    waitSeconds: number,
    apiKey: string = this.keyPool.next(),
  ): Promise<ReplicatePrediction> {
    const response = await fetch(
      `${this.config.baseURL}/models/${owner}/${name}/predictions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'application/json',
          Prefer: `wait=${waitSeconds}`,
        },
        body: JSON.stringify({ input }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Replicate model prediction failed (${response.status}): ${errorText}`,
      );
    }

    return (await response.json()) as ReplicatePrediction;
  }

  private async createPrediction(
    body: Record<string, unknown>,
    waitSeconds: number,
    apiKey: string = this.keyPool.next(),
  ): Promise<ReplicatePrediction> {
    const response = await fetch(`${this.config.baseURL}/predictions`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
        Prefer: `wait=${waitSeconds}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Replicate image generation failed (${response.status}): ${errorText}`);
    }

    return (await response.json()) as ReplicatePrediction;
  }

  private async pollPrediction(url: string, timeoutMs: number, pollIntervalMs: number, apiKey?: string): Promise<ReplicatePrediction> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Token ${apiKey ?? this.keyPool.next()}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Replicate prediction polling failed (${response.status}): ${errorText}`);
      }

      const prediction = (await response.json()) as ReplicatePrediction;
      if (!prediction.status || ['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
        return prediction;
      }

      await sleep(pollIntervalMs);
    }

    throw new Error('Replicate image generation timed out while waiting for prediction output.');
  }
}
