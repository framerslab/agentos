/**
 * @file StableDiffusionLocalProvider.ts
 * Local Stable Diffusion image provider for AgentOS.
 *
 * Supports two common local SD backends via auto-detection:
 *
 * - **Automatic1111 / Forge WebUI** -- `POST /sdapi/v1/txt2img` (most common).
 *   Detected by probing `GET /sdapi/v1/sd-models`.
 * - **ComfyUI** -- `POST /prompt` (workflow-based alternative).
 *   Detected by probing `GET /system_stats`.
 *
 * When neither probe succeeds the provider falls back to A1111 API format,
 * which works with most WebUI forks.
 *
 * Usage cost is always reported as `0` because generation is local.
 */
import {
  getImageProviderOptions,
  parseImageSize,
  type GeneratedImage,
  type IImageProvider,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ImageEditRequest,
  type ImageUpscaleRequest,
  type ImageModelInfo,
} from '../IImageProvider.js';

// ---------------------------------------------------------------------------
// Provider-specific options (exposed via ImageProviderOptionBag)
// ---------------------------------------------------------------------------

/**
 * Provider-specific options passed through
 * `request.providerOptions['stable-diffusion-local']`.
 */
export interface StableDiffusionLocalOptions {
  /** Number of inference steps (default 25). */
  steps?: number;
  /** Classifier-free guidance scale (default 7.5). */
  cfgScale?: number;
  /** Random seed (-1 for random). */
  seed?: number;
  /** Sampler name (e.g. `'Euler a'`, `'DPM++ 2M Karras'`). */
  sampler?: string;
  /** Negative prompt. */
  negativePrompt?: string;
  /** Image width in pixels (default 512). */
  width?: number;
  /** Image height in pixels (default 512). */
  height?: number;
  /** Number of images to generate (default 1). */
  batchSize?: number;
  /** ControlNet settings forwarded verbatim to the backend. */
  controlnet?: Record<string, unknown>;
  /** LoRA models to apply.  Injected into the prompt as `<lora:name:weight>`. */
  loras?: Array<{ name: string; weight?: number }>;
  /** Enable high-resolution fix (A1111 only). */
  hrFix?: boolean;
  /** Denoising strength for high-res fix or img2img (default 0.7). */
  denoisingStrength?: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Shape returned by A1111 `POST /sdapi/v1/txt2img` and `POST /sdapi/v1/img2img`. */
type A1111Txt2ImgResponse = {
  images: string[];
  parameters: Record<string, unknown>;
  info: string;
};

/**
 * The checkpoint an A1111 response says it rendered with: `sd_model_name` in
 * its `info`, which is a JSON string (stable-diffusion-webui,
 * `modules/processing.py`, `Processed.js`). `undefined` when the response
 * carries none.
 */
function renderedCheckpoint(info: unknown): string | undefined {
  if (typeof info !== 'string') return undefined;
  try {
    const name = (JSON.parse(info) as { sd_model_name?: unknown } | null)?.sd_model_name;
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Shape returned by A1111 `POST /sdapi/v1/extra-single-image`. */
type A1111ExtraSingleImageResponse = {
  image: string;
  html_info: string;
};

/** Shape returned by A1111 `GET /sdapi/v1/sd-models`. */
type A1111ModelEntry = {
  title?: string;
  model_name?: string;
  filename?: string;
};

/** Shape returned by ComfyUI `POST /prompt`. */
type ComfyUIPromptResponse = { prompt_id: string };

/** Shape returned by ComfyUI `GET /history/:promptId`. */
type ComfyUIHistoryEntry = {
  outputs?: Record<string, {
    images?: Array<{ filename: string; subfolder?: string; type?: string }>;
  }>;
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Small async delay used when polling ComfyUI history. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class StableDiffusionLocalProvider implements IImageProvider {
  public readonly providerId = 'stable-diffusion-local';
  public isInitialized = false;
  public defaultModelId?: string;

  /** Sanitised base URL of the local backend (no trailing slash). */
  private baseUrl = '';

  /** Detected backend type.  Defaults to `'automatic1111'` when detection fails. */
  private backend: 'automatic1111' | 'comfyui' = 'automatic1111';

  /** Swappable `fetch` implementation (enables deterministic testing). */
  private fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialise the provider.
   *
   * Accepts `baseURL` / `baseUrl` / `baseurl` from the config bag and
   * auto-detects the backend by probing known endpoints.
   *
   * @param config - Provider configuration.  Must contain a `baseURL` string.
   * @throws {Error} When no `baseURL` is supplied.
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    const baseUrl = (config.baseURL ?? config.baseUrl ?? config.baseurl) as string | undefined;
    if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) {
      throw new Error(
        'StableDiffusionLocalProvider requires baseURL (e.g. http://localhost:7860).',
      );
    }

    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.defaultModelId =
      typeof config.defaultModelId === 'string' && config.defaultModelId.trim()
        ? config.defaultModelId.trim()
        : undefined;

    // --- Auto-detect backend ---
    // Try A1111 first (most common).
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/sdapi/v1/sd-models`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        this.backend = 'automatic1111';
        const models = (await resp.json()) as A1111ModelEntry[];
        if (!this.defaultModelId && models.length > 0) {
          this.defaultModelId = models[0].model_name ?? models[0].title;
        }
        this.isInitialized = true;
        return;
      }
    } catch {
      // A1111 not available -- try ComfyUI.
    }

    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        this.backend = 'comfyui';
        this.isInitialized = true;
        return;
      }
    } catch {
      // ComfyUI not available either.
    }

    // Fall back to A1111 format when neither probe succeeds.
    this.backend = 'automatic1111';
    this.isInitialized = true;
  }

  // -----------------------------------------------------------------------
  // Image generation
  // -----------------------------------------------------------------------

  /**
   * Generate one or more images from a text prompt.
   *
   * Dispatches to the detected backend (A1111 or ComfyUI).
   *
   * @throws {Error} When the provider has not been initialised.
   */
  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('StableDiffusionLocalProvider is not initialized.');
    }

    const opts = getImageProviderOptions<StableDiffusionLocalOptions>(
      this.providerId,
      request.providerOptions,
    );

    if (this.backend === 'comfyui') {
      return this.generateViaComfyUI(request, opts ?? {});
    }
    return this.generateViaA1111(request, opts ?? {});
  }

  // -----------------------------------------------------------------------
  // A1111 / Forge WebUI
  // -----------------------------------------------------------------------

  /**
   * Generates images using the Automatic1111 / Forge `txt2img` REST endpoint.
   */
  private async generateViaA1111(
    request: ImageGenerationRequest,
    opts: StableDiffusionLocalOptions,
  ): Promise<ImageGenerationResult> {
    const { width: parsedW, height: parsedH } = parseImageSize(request.size);

    const body: Record<string, unknown> = {
      prompt: request.prompt,
      negative_prompt: opts.negativePrompt ?? request.negativePrompt ?? '',
      steps: opts.steps ?? 25,
      cfg_scale: opts.cfgScale ?? 7.5,
      seed: opts.seed ?? -1,
      sampler_name: opts.sampler ?? 'Euler a',
      width: opts.width ?? parsedW ?? 512,
      height: opts.height ?? parsedH ?? 512,
      batch_size: opts.batchSize ?? request.n ?? 1,
    };

    // Override checkpoint model when explicitly specified.
    if (request.modelId) {
      body.override_settings = { sd_model_checkpoint: request.modelId };
    }

    // High-resolution fix.
    if (opts.hrFix) {
      body.enable_hr = true;
      body.denoising_strength = opts.denoisingStrength ?? 0.7;
    }

    // LoRA models are injected directly into the prompt text.
    if (opts.loras?.length) {
      const loraPrompt = opts.loras.map((l) => `<lora:${l.name}:${l.weight ?? 1}>`).join(' ');
      body.prompt = `${body.prompt} ${loraPrompt}`;
    }

    // Character consistency via IP-Adapter ControlNet extension.
    // Maps referenceImageUrl + consistencyMode to A1111 ControlNet args.
    const SD_CONSISTENCY_WEIGHTS: Record<string, number> = {
      strict: 0.9,
      balanced: 0.6,
      loose: 0.3,
    };

    if (request.referenceImageUrl) {
      const weight = SD_CONSISTENCY_WEIGHTS[request.consistencyMode ?? 'balanced'];
      body.alwayson_scripts = {
        ...(body.alwayson_scripts as Record<string, unknown> ?? {}),
        controlnet: {
          args: [{
            input_image: request.referenceImageUrl,
            module: 'ip-adapter_clip_sd15',
            model: 'ip-adapter_sd15',
            weight,
          }],
        },
      };
    }

    const resp = await this.fetchImpl(`${this.baseUrl}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Stable Diffusion API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as A1111Txt2ImgResponse;

    const images: GeneratedImage[] = data.images.map((base64, i) => ({
      base64,
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${base64}`,
      revisedPrompt: request.prompt,
    }));

    return {
      created: Math.floor(Date.now() / 1000),
      // With no model named the server renders with the checkpoint it has
      // loaded, which need not be the first one it lists.
      modelId: request.modelId || renderedCheckpoint(data.info) || this.defaultModelId || 'unknown',
      providerId: this.providerId,
      images,
      usage: {
        totalImages: images.length,
        totalCostUSD: 0,
      },
    };
  }

  // -----------------------------------------------------------------------
  // ComfyUI
  // -----------------------------------------------------------------------

  /**
   * Generates images using the ComfyUI workflow-based REST endpoint.
   *
   * Builds a minimal txt2img workflow, submits it via `POST /prompt`, then
   * polls `GET /history/:promptId` until outputs are available (max 5 min).
   */
  private async generateViaComfyUI(
    request: ImageGenerationRequest,
    opts: StableDiffusionLocalOptions,
  ): Promise<ImageGenerationResult> {
    const { width: parsedW, height: parsedH } = parseImageSize(request.size);

    const workflow = {
      '1': {
        class_type: 'CheckpointLoaderSimple',
        inputs: {
          ckpt_name: request.modelId || this.defaultModelId || 'v1-5-pruned-emaonly.safetensors',
        },
      },
      '2': {
        class_type: 'CLIPTextEncode',
        inputs: { text: request.prompt, clip: ['1', 1] },
      },
      '3': {
        class_type: 'CLIPTextEncode',
        inputs: { text: opts.negativePrompt ?? '', clip: ['1', 1] },
      },
      '4': {
        class_type: 'EmptyLatentImage',
        inputs: {
          width: opts.width ?? parsedW ?? 512,
          height: opts.height ?? parsedH ?? 512,
          batch_size: opts.batchSize ?? request.n ?? 1,
        },
      },
      '5': {
        class_type: 'KSampler',
        inputs: {
          seed: opts.seed ?? Math.floor(Math.random() * 2 ** 32),
          steps: opts.steps ?? 25,
          cfg: opts.cfgScale ?? 7.5,
          sampler_name: opts.sampler ?? 'euler_ancestral',
          scheduler: 'normal',
          denoise: 1.0,
          model: ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['4', 0],
        },
      },
      '6': {
        class_type: 'VAEDecode',
        inputs: { samples: ['5', 0], vae: ['1', 2] },
      },
      '7': {
        class_type: 'SaveImage',
        inputs: { filename_prefix: 'agentos', images: ['6', 0] },
      },
    };

    // Submit prompt to ComfyUI.
    const resp = await this.fetchImpl(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`ComfyUI API error ${resp.status}: ${text}`);
    }

    const { prompt_id } = (await resp.json()) as ComfyUIPromptResponse;

    // Poll for completion (max 300 iterations x 1 s = 5 minutes).
    const images: GeneratedImage[] = [];
    for (let i = 0; i < 300; i++) {
      await sleep(1_000);

      const histResp = await this.fetchImpl(`${this.baseUrl}/history/${prompt_id}`);
      if (!histResp.ok) continue;

      const history = (await histResp.json()) as Record<string, ComfyUIHistoryEntry>;
      const run = history[prompt_id];
      if (!run?.outputs) continue;

      // Locate the SaveImage node outputs.
      for (const nodeOutput of Object.values(run.outputs)) {
        if (!nodeOutput?.images) continue;

        for (let j = 0; j < nodeOutput.images.length; j++) {
          const img = nodeOutput.images[j];
          const imgResp = await this.fetchImpl(
            `${this.baseUrl}/view?filename=${img.filename}&subfolder=${img.subfolder ?? ''}&type=${img.type ?? 'output'}`,
          );
          if (imgResp.ok) {
            const buffer = Buffer.from(await imgResp.arrayBuffer());
            const base64 = buffer.toString('base64');
            images.push({
              base64,
              mimeType: 'image/png',
              dataUrl: `data:image/png;base64,${base64}`,
              revisedPrompt: request.prompt,
            });
          }
        }

        break; // Only process first SaveImage node.
      }

      if (images.length > 0) break;
    }

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: request.modelId || this.defaultModelId || 'unknown',
      providerId: this.providerId,
      images,
      usage: {
        totalImages: images.length,
        totalCostUSD: 0,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Image editing (img2img / inpainting)
  // -----------------------------------------------------------------------

  /**
   * Edits an image using the A1111 `img2img` endpoint.
   *
   * Routes to `/sdapi/v1/img2img` which accepts `init_images` (base64 array)
   * and `denoising_strength` to control how much the output deviates from the
   * source.  When a mask is provided, A1111 performs inpainting on the white
   * regions of the mask.
   *
   * @param request - Edit request with source image buffer and prompt.
   * @returns Generation result containing the edited image(s).
   *
   * @throws {Error} When the provider is not initialised.
   * @throws {Error} When the A1111 API returns an HTTP error.
   */
  async editImage(request: ImageEditRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('StableDiffusionLocalProvider is not initialized.');
    }

    const opts = getImageProviderOptions<StableDiffusionLocalOptions>(
      'stable-diffusion-local',
      request.providerOptions,
    );

    const { width: parsedW, height: parsedH } = parseImageSize(request.size);

    const body: Record<string, unknown> = {
      // A1111 expects the source image(s) as base64 strings in an array.
      init_images: [request.image.toString('base64')],
      prompt: request.prompt,
      negative_prompt: request.negativePrompt ?? opts?.negativePrompt ?? '',
      // denoising_strength maps directly to the strength parameter.
      denoising_strength: request.strength ?? opts?.denoisingStrength ?? 0.75,
      steps: opts?.steps ?? 25,
      cfg_scale: opts?.cfgScale ?? 7.5,
      seed: request.seed ?? opts?.seed ?? -1,
      sampler_name: opts?.sampler ?? 'Euler a',
      width: opts?.width ?? parsedW ?? 512,
      height: opts?.height ?? parsedH ?? 512,
      batch_size: request.n ?? opts?.batchSize ?? 1,
    };

    // Inpainting: supply the mask as a base64 string.
    if (request.mask) {
      body.mask = request.mask.toString('base64');
    }

    // Override checkpoint model when explicitly specified.
    if (request.modelId) {
      body.override_settings = { sd_model_checkpoint: request.modelId };
    }

    const resp = await this.fetchImpl(`${this.baseUrl}/sdapi/v1/img2img`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Stable Diffusion img2img API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as A1111Txt2ImgResponse;

    const images: GeneratedImage[] = data.images.map((base64) => ({
      base64,
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${base64}`,
      revisedPrompt: request.prompt,
    }));

    return {
      created: Math.floor(Date.now() / 1000),
      // With no model named the server renders with the checkpoint it has
      // loaded, which need not be the first one it lists.
      modelId: request.modelId || renderedCheckpoint(data.info) || this.defaultModelId || 'unknown',
      providerId: this.providerId,
      images,
      usage: { totalImages: images.length, totalCostUSD: 0 },
    };
  }

  // -----------------------------------------------------------------------
  // Image upscaling (extras)
  // -----------------------------------------------------------------------

  /**
   * Upscales an image using the A1111 extras single-image endpoint.
   *
   * Routes to `/sdapi/v1/extra-single-image` which accepts a base64 image,
   * an upscaler name, and a resize factor.
   *
   * @param request - Upscale request with source image and desired scale.
   * @returns Generation result containing the upscaled image.
   *
   * @throws {Error} When the provider is not initialised.
   * @throws {Error} When the A1111 API returns an HTTP error.
   */
  async upscaleImage(request: ImageUpscaleRequest): Promise<ImageGenerationResult> {
    if (!this.isInitialized) {
      throw new Error('StableDiffusionLocalProvider is not initialized.');
    }

    const body: Record<string, unknown> = {
      image: request.image.toString('base64'),
      // Default upscaler — R-ESRGAN 4x+ is the most common bundled upscaler.
      upscaler_1: 'R-ESRGAN 4x+',
      upscaling_resize: request.scale ?? 2,
    };

    // When explicit target dimensions are provided, switch to resize-by-size mode.
    if (request.width || request.height) {
      body.upscaling_resize_w = request.width ?? 0;
      body.upscaling_resize_h = request.height ?? 0;
      body.upscaling_resize = 0; // 0 tells A1111 to use explicit w/h instead of factor.
    }

    const resp = await this.fetchImpl(`${this.baseUrl}/sdapi/v1/extra-single-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Stable Diffusion upscale API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as A1111ExtraSingleImageResponse;
    const image: GeneratedImage = {
      base64: data.image,
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${data.image}`,
    };

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: 'upscale',
      providerId: this.providerId,
      images: [image],
      usage: { totalImages: 1, totalCostUSD: 0 },
    };
  }

  // -----------------------------------------------------------------------
  // Model listing
  // -----------------------------------------------------------------------

  /**
   * Lists available checkpoint models from an A1111 backend.
   *
   * ComfyUI does not expose a simple model listing endpoint, so an empty
   * array is returned in that case.
   */
  async listAvailableModels(): Promise<ImageModelInfo[]> {
    if (!this.isInitialized) {
      throw new Error('StableDiffusionLocalProvider is not initialized.');
    }

    if (this.backend === 'automatic1111') {
      try {
        const resp = await this.fetchImpl(`${this.baseUrl}/sdapi/v1/sd-models`);
        if (resp.ok) {
          const models = (await resp.json()) as A1111ModelEntry[];
          return models.map((m) => ({
            providerId: this.providerId,
            modelId: m.model_name ?? m.title ?? 'unknown',
            displayName: m.title ?? m.model_name,
            description: `Local checkpoint: ${m.filename ?? 'unknown'}`,
          }));
        }
      } catch {
        // Network error -- fall through to empty list.
      }
    }

    return [];
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  /** Resets initialisation state.  The local backend keeps running independently. */
  async shutdown(): Promise<void> {
    this.isInitialized = false;
  }
}
