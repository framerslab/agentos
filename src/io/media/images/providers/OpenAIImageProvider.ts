import {
  type GeneratedImage,
  getImageProviderOptions,
  type IImageProvider,
  normalizeOutputFormat,
  parseDataUrl,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ImageEditRequest,
  type ImageStyleTransferRequest,
  type ImageVariateRequest,
  type ImageModelInfo,
  type OpenAIImageProviderOptions,
} from '../IImageProvider.js';
import { bufferToBlobPart } from '../imageToBuffer.js';
import { editPartType, imageFilePart } from '../blobPart.js';
import {
  ORDINAL_IMAGE_NAMES,
  styleTransferImageTypes,
  styleTransferModelError,
  styleTransferPrompt,
} from '../styleTransfer.js';
import { ApiKeyPool } from '../../../../core/providers/ApiKeyPool.js';

/** OpenAI's API, the provider's base URL unless one is configured. */
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * OpenAI's model for making an image from a prompt: "our fastest model for
 * high-quality, everyday image generation"
 * (https://developers.openai.com/api/docs/models/gpt-image-2.5-flare).
 *
 * OpenAI retired `dall-e-2` and `dall-e-3` on 2026-05-12, retires
 * `gpt-image-1` on 2026-10-23, and `gpt-image-1.5`, `gpt-image-1-mini` and
 * `chatgpt-image-latest` on 2026-12-01; its replacement for each is one of the
 * two GPT Image 2.5 models (https://developers.openai.com/api/docs/deprecations).
 */
export const OPENAI_IMAGE_GENERATION_MODEL = 'gpt-image-2.5-flare';

/**
 * OpenAI's model for changing an image: "Use it for workflows where editing
 * precision matters most"
 * (https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst).
 * Edits, variations and style transfer use it.
 */
export const OPENAI_IMAGE_EDIT_MODEL = 'gpt-image-2.5-sunburst';

/**
 * The models OpenAI's style transfer runs on, Sunburst first as the default:
 * the GPT Image models, for which the edits endpoint takes "up to 16 images"
 * (openai-node 7.32.0, `src/resources/images.ts`, `ImageEditParamsBase.image`).
 */
export const OPENAI_STYLE_TRANSFER_MODELS: readonly string[] = [
  OPENAI_IMAGE_EDIT_MODEL,
  'gpt-image-2.5-sunburst-2026-09-08',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-flare-2026-09-08',
  'gpt-image-2',
  'gpt-image-2-2026-04-21',
  'gpt-image-1.5',
  'gpt-image-1',
  'gpt-image-1-mini',
  'chatgpt-image-latest',
];

/** "each image should be a `png`, `webp`, or `jpg` file less than 50MB" (openai-node 7.32.0). */
const OPENAI_EDIT_IMAGE_BYTES = 50_000_000;

/** "The maximum length is 32000 characters for the GPT image models" (openai-node 7.32.0). */
const OPENAI_EDIT_PROMPT_CHARACTERS = 32_000;

/**
 * The quality a GPT Image model is sent for `quality`. The GPT Image models
 * take `low`, `medium`, `high` and `auto`, and the 2.5 models also `xhigh` and
 * `max`; `standard` and `hd` were DALL·E 3's (openai-node,
 * `src/resources/images.ts`, `ImageGenerateParams.quality`), and go as
 * `medium` and `high`.
 */
function gptImageQuality(quality: string): string {
  return quality === 'standard' ? 'medium' : quality === 'hd' ? 'high' : quality;
}

/** Whether `modelId` names one of OpenAI's GPT Image models. */
function isGptImageModel(modelId: string): boolean {
  return /^(gpt-image-|chatgpt-image-)/.test(modelId);
}

export interface OpenAIImageProviderConfig {
  apiKey: string;
  baseURL?: string;
  defaultModelId?: string;
  organizationId?: string;
}

type OpenAIImageResponse = {
  created: number;
  data?: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
};

export class OpenAIImageProvider implements IImageProvider {
  public readonly providerId = 'openai';
  public isInitialized = false;
  public defaultModelId?: string;

  private config!: Required<Pick<OpenAIImageProviderConfig, 'apiKey'>> & OpenAIImageProviderConfig;
  private keyPool!: ApiKeyPool;

  async initialize(config: Record<string, unknown>): Promise<void> {
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (!apiKey) {
      throw new Error('OpenAI image provider requires apiKey.');
    }

    this.keyPool = new ApiKeyPool(apiKey);
    this.config = {
      apiKey,
      baseURL:
        typeof config.baseURL === 'string' && config.baseURL.trim()
          ? config.baseURL.trim()
          : OPENAI_BASE_URL,
      defaultModelId:
        typeof config.defaultModelId === 'string' && config.defaultModelId.trim()
          ? config.defaultModelId.trim()
          : undefined,
      organizationId:
        typeof config.organizationId === 'string' && config.organizationId.trim()
          ? config.organizationId.trim()
          : undefined,
    };
    this.defaultModelId = this.config.defaultModelId;
    this.isInitialized = true;
  }

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('OpenAI image provider is not initialized.');
    }

    if (request.referenceImageUrl) {
      console.debug(
        '[openai] referenceImageUrl is not natively supported — ' +
        'field ignored. Use Replicate (Pulid), Fal, or SD-Local for character consistency.'
      );
    }

    const providerOptions = getImageProviderOptions<OpenAIImageProviderOptions>(
      this.providerId,
      request.providerOptions
    );
    const body: Record<string, unknown> = {
      model: request.modelId || this.defaultModelId || OPENAI_IMAGE_GENERATION_MODEL,
      prompt: request.prompt,
    };
    // A GPT Image model gets DALL·E 3's quality names rewritten and no
    // `style`, which it does not take.
    const gptImage = isGptImageModel(String(body.model));

    if (typeof request.n === 'number') body.n = request.n;
    if (request.size) body.size = request.size;
    if (request.quality) body.quality = gptImage ? gptImageQuality(request.quality) : request.quality;
    if (request.background) body.background = request.background;
    if (request.outputFormat) body.output_format = normalizeOutputFormat(request.outputFormat);
    if (typeof request.outputCompression === 'number')
      body.output_compression = request.outputCompression;
    // response_format is only supported by dall-e models, not gpt-image-*
    const modelId = String(body.model);
    if (request.responseFormat && modelId.startsWith('dall-e')) {
      body.response_format = request.responseFormat;
    }
    if (request.userId) body.user = request.userId;
    if (providerOptions) {
      const { style, moderation, extraBody, ...passthrough } = providerOptions;
      if (style && !gptImage) body.style = style;
      if (moderation) body.moderation = moderation;
      if (Object.keys(passthrough).length > 0) Object.assign(body, passthrough);
      if (extraBody) Object.assign(body, extraBody);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.keyPool.next()}`,
      'Content-Type': 'application/json',
    };
    if (this.config.organizationId) headers['OpenAI-Organization'] = this.config.organizationId;

    const response = await fetch(`${this.config.baseURL}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI image generation failed (${response.status}): ${errorText}`);
    }

    const json = (await response.json()) as OpenAIImageResponse;
    const images: GeneratedImage[] = (json.data ?? []).map((item) => {
      if (item.b64_json) {
        const dataUrl = `data:image/${normalizeOutputFormat(request.outputFormat) ?? 'png'};base64,${item.b64_json}`;
        const parsed = parseDataUrl(dataUrl);
        return {
          ...parsed,
          revisedPrompt: item.revised_prompt,
        };
      }
      return {
        url: item.url,
        revisedPrompt: item.revised_prompt,
      };
    });

    return {
      created: json.created ?? Math.floor(Date.now() / 1000),
      modelId: String(body.model),
      providerId: this.providerId,
      images,
      usage: { totalImages: images.length },
    };
  }

  /**
   * Edits an image using the OpenAI `/v1/images/edits` endpoint.
   *
   * Supports both img2img (prompt-guided transformation) and inpainting
   * (mask-guided regional editing).  The endpoint expects multipart form
   * data with the source image and an optional mask.
   *
   * @param request - Edit request with source image buffer and prompt.
   * @returns Generation result containing the edited image(s).
   *
   * @throws {Error} When the provider is not initialised.
   * @throws {Error} When the API returns an HTTP error status.
   *
   * @see https://platform.openai.com/docs/api-reference/images/createEdit
   */
  async editImage(request: ImageEditRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('OpenAI image provider is not initialized.');
    }

    const formData = new FormData();

    // OpenAI expects the image as a file-like Blob in the multipart payload,
    // of its own type: a JPEG or WebP is sent as one, anything else as PNG.
    const source = imageFilePart(request.image, editPartType(request.image), 'image');
    formData.append('image', source.blob, source.filename);
    formData.append('prompt', request.prompt);

    // Mask is only used for inpainting — white regions are edited.
    if (request.mask) {
      formData.append(
        'mask',
        new Blob([bufferToBlobPart(request.mask)], { type: 'image/png' }),
        'mask.png'
      );
    }

    const model = request.modelId || this.defaultModelId || OPENAI_IMAGE_EDIT_MODEL;
    formData.append('model', model);

    if (typeof request.n === 'number') formData.append('n', String(request.n));
    if (request.size) formData.append('size', request.size);

    const result = await this.postEdit(formData, model, 'OpenAI image edit');
    const images = result.images.filter((image) => image.base64 || image.url);
    if (images.length === 0) throw new Error('OpenAI image edit returned no image.');
    return { ...result, images, usage: { totalImages: images.length } };
  }

  /**
   * The model a style transfer runs on for `modelId`, or a refusal. An empty
   * id takes the configured default when it is one of
   * {@link OPENAI_STYLE_TRANSFER_MODELS}, else Sunburst. A named model must be
   * one of them, unless the provider's base URL is not OpenAI's: a custom
   * endpoint may serve any name.
   *
   * @param modelId - The model the call names, or an empty string.
   * @throws {Error} For a model the style transfer does not run.
   */
  styleTransferModel(modelId: string): string {
    if (!modelId) {
      return this.defaultModelId && OPENAI_STYLE_TRANSFER_MODELS.includes(this.defaultModelId)
        ? this.defaultModelId
        : OPENAI_IMAGE_EDIT_MODEL;
    }
    if (OPENAI_STYLE_TRANSFER_MODELS.includes(modelId) || this.hasCustomEndpoint()) return modelId;
    throw styleTransferModelError('OpenAI', modelId, OPENAI_STYLE_TRANSFER_MODELS);
  }

  /**
   * Restyles an image after a style reference through `/v1/images/edits`,
   * which takes "up to 16 images" for the GPT Image models (openai-node,
   * `src/resources/images.ts`): the source and the reference go as two
   * `image[]` parts, the source first, with an instruction that names them.
   *
   * The endpoint has no strength, seed or negative prompt: `strength` picks
   * the instruction (see `styleTransfer.ts`), and the others are not sent.
   * Before the request, the images are checked to be PNG, WebP or JPEG files
   * under 50 MB each, and the prompt as sent to be at most 32,000 characters.
   *
   * @param request - The source, the reference and the prompt.
   * @returns Generation result with the restyled image(s).
   *
   * @throws {Error} When the provider is not initialised, the model, an image
   *   or the prompt is refused, the API returns an HTTP error status, or the
   *   answer holds no image.
   */
  async transferStyle(request: ImageStyleTransferRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('OpenAI image provider is not initialized.');
    }
    const model = this.styleTransferModel(request.modelId);
    const types = styleTransferImageTypes(
      'OpenAI',
      ['image/png', 'image/webp', 'image/jpeg'],
      request.image,
      request.styleImage,
    );
    for (const [bytes, which] of [[request.image, 'source'], [request.styleImage, 'style reference']] as const) {
      if (bytes.length >= OPENAI_EDIT_IMAGE_BYTES) {
        throw new Error(`OpenAI's edits take images under 50 MB; the ${which} is ${bytes.length} bytes.`);
      }
    }
    const prompt = styleTransferPrompt(request.prompt, request.strength, ORDINAL_IMAGE_NAMES);
    if (prompt.length > OPENAI_EDIT_PROMPT_CHARACTERS) {
      throw new Error(
        `OpenAI's edits take a prompt of at most 32,000 characters; with the style transfer instruction it is ${prompt.length}.`,
      );
    }

    const formData = new FormData();
    const source = imageFilePart(request.image, types.image, 'image');
    const style = imageFilePart(request.styleImage, types.style, 'style');
    formData.append('image[]', source.blob, source.filename);
    formData.append('image[]', style.blob, style.filename);
    formData.append('prompt', prompt);
    formData.append('model', model);
    if (request.size) formData.append('size', request.size);

    const result = await this.postEdit(formData, model, 'OpenAI style transfer');
    const images = result.images.filter((image) => image.base64 || image.url);
    if (images.length === 0) throw new Error('OpenAI style transfer returned no image.');
    return { ...result, images, usage: { totalImages: images.length } };
  }

  /** Whether the provider's base URL is not OpenAI's own. */
  private hasCustomEndpoint(): boolean {
    const baseURL = this.config?.baseURL;
    return typeof baseURL === 'string' && baseURL.replace(/\/+$/, '') !== OPENAI_BASE_URL;
  }

  /**
   * Sends a multipart request to `/v1/images/edits` and reads its images.
   *
   * @param formData - The edit's fields and image parts.
   * @param model - The model the request names, reported in the result.
   * @param what - The operation's name, for the error of a failed request.
   */
  private async postEdit(formData: FormData, model: string, what: string): Promise<ImageGenerationResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.keyPool.next()}`,
      // Content-Type is NOT set manually — the browser/Node runtime sets the
      // correct multipart boundary when FormData is used as the body.
    };
    if (this.config.organizationId) headers['OpenAI-Organization'] = this.config.organizationId;

    const response = await fetch(`${this.config.baseURL}/images/edits`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${what} failed (${response.status}): ${errorText}`);
    }

    const json = (await response.json()) as OpenAIImageResponse;
    const images: GeneratedImage[] = (json.data ?? []).map((item) => {
      if (item.b64_json) {
        const dataUrl = `data:image/png;base64,${item.b64_json}`;
        const parsed = parseDataUrl(dataUrl);
        return { ...parsed, revisedPrompt: item.revised_prompt };
      }
      return { url: item.url, revisedPrompt: item.revised_prompt };
    });

    return {
      created: json.created ?? Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      images,
      usage: { totalImages: images.length },
    };
  }

  /**
   * Makes variations of an image through the `/v1/images/edits` endpoint, with
   * a GPT image model and a prompt that asks for a variation. OpenAI retired
   * `/v1/images/variations` and the DALL·E models it served: "Use the image
   * edits endpoint with a GPT Image model and a prompt to create a variation
   * of an image" (openai-node, `src/resources/images.ts`).
   *
   * The edits endpoint has no strength parameter, so `variance` picks the
   * prompt: below 0.5 asks for a close variation, otherwise a looser one.
   *
   * @param request - Variation request with the source image buffer.
   * @returns Generation result containing the variation image(s).
   *
   * @throws {Error} When the provider is not initialised.
   * @throws {Error} When the API returns an HTTP error status.
   *
   * @see https://github.com/openai/openai-node/blob/master/src/resources/images.ts
   */
  async variateImage(request: ImageVariateRequest): Promise<ImageGenerationResult> {
    return this.editImage({
      modelId: request.modelId,
      image: request.image,
      prompt: variationPrompt(request.variance),
      n: request.n,
      size: request.size,
      providerOptions: request.providerOptions,
    });
  }

  async listAvailableModels(): Promise<ImageModelInfo[]> {
    return [
      { providerId: this.providerId, modelId: OPENAI_IMAGE_GENERATION_MODEL, displayName: 'GPT Image 2.5 Flare' },
      { providerId: this.providerId, modelId: OPENAI_IMAGE_EDIT_MODEL, displayName: 'GPT Image 2.5 Sunburst' },
      { providerId: this.providerId, modelId: 'gpt-image-2', displayName: 'GPT Image 2' },
    ];
  }
}

/**
 * The prompt that asks the edits endpoint for a variation: a close one below a
 * `variance` of 0.5, a looser one otherwise (default 0.5).
 */
function variationPrompt(variance = 0.5): string {
  return variance < 0.5
    ? 'Make a close variation of this image: keep its subject, composition, colours and style, and change only small details.'
    : 'Make a variation of this image: keep its subject and style, and vary the composition, pose, lighting and details.';
}
