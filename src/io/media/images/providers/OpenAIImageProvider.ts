import {
  type GeneratedImage,
  getImageProviderOptions,
  type IImageProvider,
  normalizeOutputFormat,
  parseDataUrl,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ImageEditRequest,
  type ImageVariateRequest,
  type ImageModelInfo,
  type OpenAIImageProviderOptions,
} from '../IImageProvider.js';
import { bufferToBlobPart } from '../imageToBuffer.js';
import { ApiKeyPool } from '../../../../core/providers/ApiKeyPool.js';

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
          : 'https://api.openai.com/v1',
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
      model: request.modelId || this.defaultModelId || 'gpt-image-1.5',
      prompt: request.prompt,
    };

    if (typeof request.n === 'number') body.n = request.n;
    if (request.size) body.size = request.size;
    if (request.quality) body.quality = request.quality;
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
      if (style) body.style = style;
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

    // OpenAI expects the image as a file-like Blob in the multipart payload.
    formData.append(
      'image',
      new Blob([bufferToBlobPart(request.image)], { type: 'image/png' }),
      'image.png'
    );
    formData.append('prompt', request.prompt);

    // Mask is only used for inpainting — white regions are edited.
    if (request.mask) {
      formData.append(
        'mask',
        new Blob([bufferToBlobPart(request.mask)], { type: 'image/png' }),
        'mask.png'
      );
    }

    const model = request.modelId || this.defaultModelId || 'gpt-image-1';
    formData.append('model', model);

    if (typeof request.n === 'number') formData.append('n', String(request.n));
    if (request.size) formData.append('size', request.size);

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
      throw new Error(`OpenAI image edit failed (${response.status}): ${errorText}`);
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
      { providerId: this.providerId, modelId: 'gpt-image-1.5', displayName: 'GPT Image 1.5' },
      { providerId: this.providerId, modelId: 'gpt-image-1', displayName: 'GPT Image 1' },
      { providerId: this.providerId, modelId: 'gpt-image-1-mini', displayName: 'GPT Image 1 Mini' },
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
