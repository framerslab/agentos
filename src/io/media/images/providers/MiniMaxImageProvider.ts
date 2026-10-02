import {
  type IImageProvider,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ImageModelInfo,
  type MiniMaxImageProviderOptions,
  getImageProviderOptions,
  parseDataUrl,
  parseImageSize,
} from "../IImageProvider.js";

const DEFAULT_BASE_URL = "https://api.minimax.io/v1";
const MODELS = ["image-01", "image-01-live"];

interface MiniMaxImageResponse {
  data?: { image_urls?: string[]; image_base64?: string[] };
  metadata?: {
    success_count?: number | string;
    failed_count?: number | string;
  };
  base_resp?: { status_code?: number; status_msg?: string };
}

/**
 * MiniMax text-to-image generation with URL or base64 output.
 * Set baseURL to the regional API root when using a regional API key.
 */
export class MiniMaxImageProvider implements IImageProvider {
  readonly providerId = "minimax";
  isInitialized = false;
  defaultModelId = "image-01";
  private apiKey = "";
  private baseURL = DEFAULT_BASE_URL;

  async initialize(config: Record<string, unknown>): Promise<void> {
    this.isInitialized = false;
    this.apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
    if (!this.apiKey) {
      throw new Error("MiniMax image provider requires apiKey.");
    }
    this.baseURL =
      typeof config.baseURL === "string" && config.baseURL.trim()
        ? config.baseURL.trim().replace(/\/+$/, "")
        : DEFAULT_BASE_URL;
    this.defaultModelId =
      typeof config.defaultModelId === "string" && config.defaultModelId
        ? config.defaultModelId
        : "image-01";
    this.isInitialized = true;
  }

  async listAvailableModels(): Promise<ImageModelInfo[]> {
    return MODELS.map((modelId) => ({ modelId, providerId: this.providerId }));
  }

  async generateImage(
    request: ImageGenerationRequest,
  ): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error("MiniMax image provider is not initialized.");
    }
    const options = getImageProviderOptions<MiniMaxImageProviderOptions>(
      this.providerId,
      request.providerOptions,
    );
    const dimensions = parseImageSize(request.size);
    const modelId = request.modelId ?? this.defaultModelId;
    const responseFormat =
      request.responseFormat === "b64_json" ? "base64" : "url";
    const response = await fetch(`${this.baseURL}/image_generation`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        prompt: request.prompt,
        n: request.n,
        aspect_ratio: request.aspectRatio,
        width: options?.width ?? dimensions.width,
        height: options?.height ?? dimensions.height,
        response_format: responseFormat,
        seed: request.seed,
        prompt_optimizer: options?.promptOptimizer,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(
        `MiniMax image request failed (HTTP ${response.status}).`,
      );
    }
    const payload = (await response.json()) as MiniMaxImageResponse | null;
    if (!payload || payload.base_resp?.status_code !== 0) {
      throw new Error(
        `MiniMax image request failed (status ${payload?.base_resp?.status_code ?? "missing"}).`,
      );
    }
    const values =
      responseFormat === "base64"
        ? payload.data?.image_base64
        : payload.data?.image_urls;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) => typeof value !== "string" || !value.trim())
    ) {
      throw new Error("MiniMax image response contained no valid images.");
    }
    return {
      created: Math.floor(Date.now() / 1000),
      modelId,
      providerId: this.providerId,
      images: values.map((value) => ({
        ...(responseFormat === "url"
          ? { url: value }
          : value.startsWith("data:")
            ? parseDataUrl(value)
            : { base64: value }),
        providerMetadata: { ...payload.metadata },
      })),
      usage: { totalImages: values.length },
    };
  }

  async shutdown(): Promise<void> {
    this.apiKey = "";
    this.isInitialized = false;
  }
}
