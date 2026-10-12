import {
  type GeneratedImage,
  getImageProviderOptions,
  inferAspectRatioFromSize,
  normalizeOutputFormat,
  parseDataUrl,
  type IImageProvider,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ImageEditRequest,
  type ImageStyleTransferRequest,
  type ImageUpscaleRequest,
  type ImageModelInfo,
  type StabilityImageProviderOptions,
} from '../IImageProvider.js';
import { bufferToBlobPart } from '../imageToBuffer.js';
import { editPartType, imageFilePart } from '../blobPart.js';
import { styleTransferImageTypes } from '../styleTransfer.js';
import { ApiKeyPool } from '../../../../core/providers/ApiKeyPool.js';

export interface StabilityImageProviderConfig {
  apiKey: string;
  baseURL?: string;
  defaultModelId?: string;
}

type StabilityJsonResponse = {
  image?: string;
  seed?: number;
  finish_reason?: string;
  warnings?: unknown[];
  artifacts?: Array<{
    base64?: string;
    finishReason?: string;
    seed?: number;
  }>;
};

type StabilityRoute = {
  path: string;
  responseModelId: string;
  requestModel?: string;
};

const STABILITY_ROUTE_ALIASES: Record<string, StabilityRoute> = {
  core: {
    path: '/v2beta/stable-image/generate/core',
    responseModelId: 'stable-image-core',
  },
  'stable-image-core': {
    path: '/v2beta/stable-image/generate/core',
    responseModelId: 'stable-image-core',
  },
  ultra: {
    path: '/v2beta/stable-image/generate/ultra',
    responseModelId: 'stable-image-ultra',
  },
  'stable-image-ultra': {
    path: '/v2beta/stable-image/generate/ultra',
    responseModelId: 'stable-image-ultra',
  },
  sd3: {
    path: '/v2beta/stable-image/generate/sd3',
    responseModelId: 'sd3-medium',
    requestModel: 'sd3-medium',
  },
  'sd3-medium': {
    path: '/v2beta/stable-image/generate/sd3',
    responseModelId: 'sd3-medium',
    requestModel: 'sd3-medium',
  },
  'sd3-large': {
    path: '/v2beta/stable-image/generate/sd3',
    responseModelId: 'sd3-large',
    requestModel: 'sd3-large',
  },
  'sd3-large-turbo': {
    path: '/v2beta/stable-image/generate/sd3',
    responseModelId: 'sd3-large-turbo',
    requestModel: 'sd3-large-turbo',
  },
  'sd3.5-medium': {
    path: '/v2beta/stable-image/generate/sd3',
    responseModelId: 'sd3.5-medium',
    requestModel: 'sd3.5-medium',
  },
  'sd3.5-large': {
    path: '/v2beta/stable-image/generate/sd3',
    responseModelId: 'sd3.5-large',
    requestModel: 'sd3.5-large',
  },
  'sd3.5-large-turbo': {
    path: '/v2beta/stable-image/generate/sd3',
    responseModelId: 'sd3.5-large-turbo',
    requestModel: 'sd3.5-large-turbo',
  },
};

function resolveStabilityRoute(
  modelId: string,
  providerOptions?: StabilityImageProviderOptions
): StabilityRoute {
  const normalizedModelId = providerOptions?.engine?.trim() || modelId.trim();
  return (
    STABILITY_ROUTE_ALIASES[normalizedModelId] ?? {
      path: '/v2beta/stable-image/generate/core',
      responseModelId: normalizedModelId,
    }
  );
}

function appendIfDefined(
  formData: FormData,
  key: string,
  value: string | number | boolean | undefined
): void {
  if (value === undefined) {
    return;
  }
  formData.append(key, String(value));
}

/**
 * The model of an image-to-image edit when the request names none: the SD3
 * route's `model` takes sd3.5-large, sd3.5-large-turbo and sd3.5-medium, and
 * routes the older sd3-* names to them.
 */
const SD3_EDIT_MODEL = 'sd3.5-medium';

/** The model id reported for an inpaint, whose endpoint takes no model. */
const INPAINT_MODEL_ID = 'stable-image-inpaint';

/** The model id reported for an upscale by the fast upscaler, whose endpoint takes no model. */
const UPSCALE_MODEL_ID = 'stable-image-upscale-fast';

/** Whether a model id is one the SD3 route takes. */
function isSd3Model(modelId: string | undefined): modelId is string {
  return typeof modelId === 'string' && /^sd3/i.test(modelId);
}

/** The model id reported for a style transfer, whose endpoint takes no model. */
export const STABILITY_STYLE_TRANSFER_MODEL = 'stable-image-style-transfer';

/** "Your request was larger than 10MiB" is the style-transfer endpoint's 413 (Stability's API reference). */
const STYLE_TRANSFER_REQUEST_BYTES = 10 * 1024 * 1024;

/** What a style-transfer form adds to its fields: boundaries and part headers, rounded up. */
const MULTIPART_OVERHEAD_BYTES = 4096;

/** The longest prompt and negative prompt the style-transfer endpoint takes. */
const STYLE_TRANSFER_TEXT_CHARACTERS = 10_000;

/** The largest seed the style-transfer endpoint takes. */
const STYLE_TRANSFER_MAX_SEED = 4_294_967_294;

/** Throws unless `value` is undefined or a finite number from `min` to `max`. */
function checkRange(name: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) return;
  if (!(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)) {
    throw new Error(`Stability's style transfer takes ${name} from ${min} to ${max}; it is ${value}.`);
  }
}

export class StabilityImageProvider implements IImageProvider {
  public readonly providerId = 'stability';
  public isInitialized = false;
  public defaultModelId?: string;

  private config!: Required<Pick<StabilityImageProviderConfig, 'apiKey'>> &
    StabilityImageProviderConfig;
  private keyPool!: ApiKeyPool;

  async initialize(config: Record<string, unknown>): Promise<void> {
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (!apiKey) {
      throw new Error('Stability image provider requires apiKey.');
    }

    this.config = {
      apiKey,
      baseURL:
        typeof config.baseURL === 'string' && config.baseURL.trim()
          ? config.baseURL.trim()
          : 'https://api.stability.ai',
      defaultModelId:
        typeof config.defaultModelId === 'string' && config.defaultModelId.trim()
          ? config.defaultModelId.trim()
          : 'stable-image-core',
    };
    this.defaultModelId = this.config.defaultModelId;
    this.keyPool = new ApiKeyPool(apiKey);
    this.isInitialized = true;
  }

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('Stability image provider is not initialized.');
    }

    if (request.referenceImageUrl) {
      console.debug(
        '[stability] referenceImageUrl is not natively supported — ' +
        'field ignored. Use Replicate (Pulid), Fal, or SD-Local for character consistency.'
      );
    }

    const providerOptions = getImageProviderOptions<StabilityImageProviderOptions>(
      this.providerId,
      request.providerOptions
    );
    const route = resolveStabilityRoute(
      request.modelId || this.defaultModelId || 'stable-image-core',
      providerOptions
    );

    const formData = new FormData();
    formData.append('prompt', request.prompt);
    appendIfDefined(
      formData,
      'negative_prompt',
      providerOptions?.negativePrompt ?? request.negativePrompt
    );
    appendIfDefined(
      formData,
      'aspect_ratio',
      providerOptions?.aspectRatio ?? request.aspectRatio ?? inferAspectRatioFromSize(request.size)
    );
    appendIfDefined(formData, 'seed', providerOptions?.seed ?? request.seed);
    appendIfDefined(
      formData,
      'output_format',
      normalizeOutputFormat(providerOptions?.outputFormat ?? request.outputFormat)
    );
    appendIfDefined(formData, 'style_preset', providerOptions?.stylePreset);
    appendIfDefined(formData, 'cfg_scale', providerOptions?.cfgScale);
    appendIfDefined(formData, 'steps', providerOptions?.steps);
    appendIfDefined(formData, 'strength', providerOptions?.strength);
    if (!route.path.endsWith('/ultra')) {
      appendIfDefined(formData, 'samples', providerOptions?.samples ?? request.n);
    }
    if (route.requestModel) {
      appendIfDefined(formData, 'model', route.requestModel);
    }
    if (providerOptions?.extraFields) {
      for (const [key, value] of Object.entries(providerOptions.extraFields)) {
        appendIfDefined(formData, key, value);
      }
    }

    const response = await fetch(`${this.config.baseURL}${route.path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.keyPool.next()}`,
        Accept: 'application/json',
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Stability image generation failed (${response.status}): ${errorText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const images: GeneratedImage[] = [];
    let usageImages = 0;

    if (contentType.includes('application/json')) {
      const json = (await response.json()) as StabilityJsonResponse;
      if (json.image) {
        const mimeType = `image/${normalizeOutputFormat(providerOptions?.outputFormat ?? request.outputFormat) ?? 'png'}`;
        images.push({
          mimeType,
          base64: json.image,
          dataUrl: `data:${mimeType};base64,${json.image}`,
          providerMetadata: {
            seed: json.seed,
            finishReason: json.finish_reason,
            warnings: json.warnings,
          },
        });
      }

      for (const artifact of json.artifacts ?? []) {
        if (!artifact.base64) {
          continue;
        }
        const mimeType = `image/${normalizeOutputFormat(providerOptions?.outputFormat ?? request.outputFormat) ?? 'png'}`;
        images.push({
          mimeType,
          base64: artifact.base64,
          dataUrl: `data:${mimeType};base64,${artifact.base64}`,
          providerMetadata: {
            seed: artifact.seed,
            finishReason: artifact.finishReason,
          },
        });
      }
      usageImages = images.length;
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      // The media type alone: `image/png; charset=binary` would make a data
      // URL that parseDataUrl does not read.
      const mimeType = contentType.split(';')[0].trim() || 'image/png';
      const base64 = buffer.toString('base64');
      const parsed = parseDataUrl(`data:${mimeType};base64,${base64}`);
      images.push(parsed);
      usageImages = 1;
    }

    if (images.length === 0) {
      throw new Error('Stability returned no image data.');
    }

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: route.responseModelId,
      providerId: this.providerId,
      images,
      usage: {
        totalImages: usageImages,
      },
    };
  }

  /**
   * Edits an image with Stability AI, on the endpoint the request needs
   * (Stability's API specification, https://api.stability.ai/v2alpha/openapi):
   * - without a mask, image-to-image: `/v2beta/stable-image/generate/sd3`
   *   with `mode=image-to-image`, `image` and `strength`. The route takes the
   *   SD3 models only, and its `image` and `strength` are valid in that mode
   *   only;
   * - with a mask, inpainting: `/v2beta/stable-image/edit/inpaint` with
   *   `image` and `mask` (white is repainted, black kept). It takes no model
   *   and no strength.
   *
   * The request's `mode` is not read: `'outpaint'` runs as image-to-image.
   *
   * @param request - Edit request containing the source image, prompt, and optional mask.
   * @returns Generation result with the edited image(s).
   *
   * @throws {Error} When the provider is not initialised.
   * @throws {Error} When the Stability API returns an HTTP error status.
   */
  async editImage(request: ImageEditRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('Stability image provider is not initialized.');
    }

    const providerOptions = getImageProviderOptions<StabilityImageProviderOptions>(
      this.providerId,
      request.providerOptions
    );

    const formData = new FormData();

    // Source image — sent as a Blob of its own type (a JPEG or WebP as one,
    // anything else as PNG) so the multipart encoder assigns a filename.
    const source = imageFilePart(request.image, editPartType(request.image), 'image');
    formData.append('image', source.blob, source.filename);
    formData.append('prompt', request.prompt);
    appendIfDefined(
      formData,
      'negative_prompt',
      request.negativePrompt ?? providerOptions?.negativePrompt
    );
    appendIfDefined(formData, 'seed', request.seed ?? providerOptions?.seed);
    appendIfDefined(
      formData,
      'output_format',
      normalizeOutputFormat(providerOptions?.outputFormat)
    );
    appendIfDefined(formData, 'style_preset', providerOptions?.stylePreset);

    let endpoint: string;
    let model: string;
    if (request.mask) {
      // Inpainting has an endpoint of its own, which takes the mask as `mask`
      // and no model, mode or strength.
      formData.append(
        'mask',
        new Blob([bufferToBlobPart(request.mask)], { type: 'image/png' }),
        'mask.png'
      );
      endpoint = '/v2beta/stable-image/edit/inpaint';
      model = INPAINT_MODEL_ID;
    } else {
      // Strength controls how much the output deviates from the source:
      // 0 keeps the original, 1 is as if no image were passed.
      formData.append('mode', 'image-to-image');
      appendIfDefined(formData, 'strength', request.strength ?? providerOptions?.strength ?? 0.75);
      appendIfDefined(formData, 'cfg_scale', providerOptions?.cfgScale);
      // The provider's default model serves text-to-image (stable-image-core
      // unless configured), which this route refuses; only an SD3 default applies.
      model = request.modelId || (isSd3Model(this.defaultModelId) ? this.defaultModelId : SD3_EDIT_MODEL);
      formData.append('model', model);
      endpoint = '/v2beta/stable-image/generate/sd3';
    }

    const response = await fetch(`${this.config.baseURL}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.keyPool.next()}`,
        Accept: 'application/json',
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Stability image edit failed (${response.status}): ${errorText}`);
    }

    const images = (await this.parseStabilityResponse(response, providerOptions)).filter((image) => image.base64);
    if (images.length === 0) {
      throw new Error('Stability returned no image data.');
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
   * Upscales an image with Stability AI's fast upscaler,
   * `/v2beta/stable-image/upscale/fast`, which takes the image alone and
   * returns it at four times its resolution. The request's `scale`, `width`
   * and `height` are not used: no Stability upscaler takes a target size,
   * and the conservative and creative upscalers require a prompt, which an
   * upscale request does not carry (Stability's API specification,
   * https://api.stability.ai/v2alpha/openapi).
   *
   * @param request - Upscale request with the source image.
   * @returns Generation result with the upscaled image.
   *
   * @throws {Error} When the provider is not initialised.
   * @throws {Error} When the Stability API returns an HTTP error status.
   */
  async upscaleImage(request: ImageUpscaleRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('Stability image provider is not initialized.');
    }

    const providerOptions = getImageProviderOptions<StabilityImageProviderOptions>(
      this.providerId,
      request.providerOptions
    );

    const formData = new FormData();
    const source = imageFilePart(request.image, editPartType(request.image), 'image');
    formData.append('image', source.blob, source.filename);

    appendIfDefined(
      formData,
      'output_format',
      normalizeOutputFormat(providerOptions?.outputFormat)
    );

    const response = await fetch(
      `${this.config.baseURL}/v2beta/stable-image/upscale/fast`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.keyPool.next()}`,
          Accept: 'application/json',
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Stability image upscale failed (${response.status}): ${errorText}`);
    }

    const images = (await this.parseStabilityResponse(response, providerOptions)).filter((image) => image.base64);
    if (images.length === 0) {
      throw new Error('Stability returned no image data.');
    }

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: UPSCALE_MODEL_ID,
      providerId: this.providerId,
      images,
      usage: { totalImages: images.length },
    };
  }

  /**
   * The model a style transfer reports: Stability's style-transfer endpoint
   * takes no model, so an empty id and {@link STABILITY_STYLE_TRANSFER_MODEL}
   * are the only ones accepted.
   *
   * @param modelId - The model the call names, or an empty string.
   * @throws {Error} For any other model.
   */
  styleTransferModel(modelId: string): string {
    if (!modelId || modelId === STABILITY_STYLE_TRANSFER_MODEL) return STABILITY_STYLE_TRANSFER_MODEL;
    throw new Error(`Stability's style transfer endpoint takes no model; leave model unset (it reports ${STABILITY_STYLE_TRANSFER_MODEL}).`);
  }

  /**
   * Restyles an image after a style reference with Stability AI's style
   * transfer, `/v2beta/stable-image/control/style-transfer`, which takes the
   * source as `init_image` and the reference as `style_image` and answers
   * with one image of 1 MP at the source's aspect ratio (Stability's API
   * reference). `strength` is sent as `style_strength`, where 0 leaves the
   * source as it is; the endpoint takes no model and no size.
   *
   * Before the request: both images must be JPEG, PNG or WebP, the request
   * within 10 MiB, the prompt and negative prompt at most 10,000 characters,
   * the seed an integer from 0 to 4,294,967,294, `compositionFidelity` from 0
   * to 1 and `changeStrength` from 0.1 to 1.
   *
   * @param request - The source, the reference and the prompt.
   * @returns Generation result with the restyled image.
   *
   * @throws {Error} When the provider is not initialised, the model or an
   *   argument is refused, the API returns an HTTP error status, or the answer
   *   holds no image.
   */
  async transferStyle(request: ImageStyleTransferRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('Stability image provider is not initialized.');
    }
    const model = this.styleTransferModel(request.modelId);
    const providerOptions = getImageProviderOptions<StabilityImageProviderOptions>(
      this.providerId,
      request.providerOptions
    );
    const types = styleTransferImageTypes(
      'Stability',
      ['image/jpeg', 'image/png', 'image/webp'],
      request.image,
      request.styleImage,
    );

    const negativePrompt = request.negativePrompt ?? providerOptions?.negativePrompt;
    const seed = request.seed ?? providerOptions?.seed;
    const outputFormat = normalizeOutputFormat(providerOptions?.outputFormat);
    for (const [text, name] of [[request.prompt, 'prompt'], [negativePrompt, 'negative prompt']] as const) {
      if (text !== undefined && text.length > STYLE_TRANSFER_TEXT_CHARACTERS) {
        throw new Error(`Stability's style transfer takes a ${name} of at most 10,000 characters; it is ${text.length}.`);
      }
    }
    if (seed !== undefined && !(Number.isInteger(seed) && seed >= 0 && seed <= STYLE_TRANSFER_MAX_SEED)) {
      throw new Error(`Stability's style transfer takes a seed that is an integer from 0 to 4,294,967,294; it is ${seed}.`);
    }
    checkRange('compositionFidelity', providerOptions?.compositionFidelity, 0, 1);
    checkRange('changeStrength', providerOptions?.changeStrength, 0.1, 1);
    if (outputFormat !== undefined && !['jpeg', 'png', 'webp'].includes(outputFormat)) {
      throw new Error(`Stability's style transfer returns jpeg, png or webp; outputFormat is ${outputFormat}.`);
    }
    const textBytes = Buffer.byteLength(request.prompt) + Buffer.byteLength(negativePrompt ?? '');
    const requestBytes = request.image.length + request.styleImage.length + textBytes + MULTIPART_OVERHEAD_BYTES;
    if (requestBytes > STYLE_TRANSFER_REQUEST_BYTES) {
      throw new Error(
        `Stability takes a request of up to 10 MiB; the two images and the text are ${requestBytes} bytes with the form's own fields.`,
      );
    }

    const formData = new FormData();
    const source = imageFilePart(request.image, types.image, 'image');
    const style = imageFilePart(request.styleImage, types.style, 'style');
    formData.append('init_image', source.blob, source.filename);
    formData.append('style_image', style.blob, style.filename);
    if (request.prompt.trim()) formData.append('prompt', request.prompt);
    appendIfDefined(formData, 'negative_prompt', negativePrompt);
    appendIfDefined(formData, 'seed', seed);
    appendIfDefined(formData, 'style_strength', request.strength);
    appendIfDefined(formData, 'composition_fidelity', providerOptions?.compositionFidelity);
    appendIfDefined(formData, 'change_strength', providerOptions?.changeStrength);
    appendIfDefined(formData, 'output_format', outputFormat);

    const response = await fetch(`${this.config.baseURL}/v2beta/stable-image/control/style-transfer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.keyPool.next()}`,
        Accept: 'application/json',
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Stability style transfer failed (${response.status}): ${errorText}`);
    }

    const images = (await this.parseStabilityResponse(response, providerOptions)).filter((image) => image.base64);
    if (images.length === 0) {
      throw new Error('Stability returned no image data.');
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
   * Parses a Stability API response into an array of {@link GeneratedImage} objects.
   *
   * Handles both JSON envelope responses (with `image` or `artifacts` fields)
   * and raw binary responses (identified by non-JSON content types).
   */
  private async parseStabilityResponse(
    response: Response,
    providerOptions?: StabilityImageProviderOptions
  ): Promise<GeneratedImage[]> {
    const contentType = response.headers.get('content-type') ?? '';
    const images: GeneratedImage[] = [];

    if (contentType.includes('application/json')) {
      const json = (await response.json()) as StabilityJsonResponse;
      if (json.image) {
        const mimeType = `image/${normalizeOutputFormat(providerOptions?.outputFormat) ?? 'png'}`;
        images.push({
          mimeType,
          base64: json.image,
          dataUrl: `data:${mimeType};base64,${json.image}`,
          providerMetadata: { seed: json.seed, finishReason: json.finish_reason },
        });
      }
      for (const artifact of json.artifacts ?? []) {
        if (!artifact.base64) continue;
        const mimeType = `image/${normalizeOutputFormat(providerOptions?.outputFormat) ?? 'png'}`;
        images.push({
          mimeType,
          base64: artifact.base64,
          dataUrl: `data:${mimeType};base64,${artifact.base64}`,
          providerMetadata: { seed: artifact.seed, finishReason: artifact.finishReason },
        });
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      // The media type alone: `image/png; charset=binary` would make a data
      // URL that parseDataUrl does not read.
      const mimeType = contentType.split(';')[0].trim() || 'image/png';
      const base64 = buffer.toString('base64');
      const parsed = parseDataUrl(`data:${mimeType};base64,${base64}`);
      images.push(parsed);
    }

    return images;
  }

  async listAvailableModels(): Promise<ImageModelInfo[]> {
    return [
      {
        providerId: this.providerId,
        modelId: 'stable-image-core',
        displayName: 'Stable Image Core',
      },
      {
        providerId: this.providerId,
        modelId: 'stable-image-ultra',
        displayName: 'Stable Image Ultra',
      },
      {
        providerId: this.providerId,
        modelId: 'sd3-medium',
        displayName: 'Stable Diffusion 3 Medium',
      },
      {
        providerId: this.providerId,
        modelId: 'sd3-large',
        displayName: 'Stable Diffusion 3 Large',
      },
      {
        providerId: this.providerId,
        modelId: 'sd3-large-turbo',
        displayName: 'Stable Diffusion 3 Large Turbo',
      },
    ];
  }
}
