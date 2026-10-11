import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StableDiffusionLocalProvider } from '../providers/StableDiffusionLocalProvider.js';
import type { ImageGenerationRequest } from '../IImageProvider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a mock A1111 sd-models response. */
function makeA1111ModelsResponse(models: Array<{ model_name: string; title: string; filename: string }> = []) {
  return models.length > 0
    ? models
    : [
        { model_name: 'v1-5-pruned-emaonly', title: 'v1-5-pruned-emaonly [abc123]', filename: '/models/v1-5.safetensors' },
        { model_name: 'sdxl-base-1.0', title: 'sdxl-base-1.0 [def456]', filename: '/models/sdxl.safetensors' },
      ];
}

/** Builds a mock A1111 txt2img response. */
function makeA1111Txt2ImgResponse(imageCount = 1) {
  const images = Array.from({ length: imageCount }, (_, i) => `base64data_image_${i}`);
  return { images, parameters: {}, info: '{}' };
}

/** Creates a minimal mock fetch that routes by URL. */
function makeMockFetch(routes: Record<string, { ok: boolean; status: number; body: unknown }>) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;

    for (const [pattern, response] of Object.entries(routes)) {
      if (urlStr.includes(pattern)) {
        return {
          ok: response.ok,
          status: response.status,
          json: vi.fn().mockResolvedValue(response.body),
          text: vi.fn().mockResolvedValue(typeof response.body === 'string' ? response.body : JSON.stringify(response.body)),
          arrayBuffer: vi.fn().mockResolvedValue(
            Buffer.from(typeof response.body === 'string' ? response.body : JSON.stringify(response.body)),
          ),
          headers: new Map([['content-type', 'application/json']]),
        };
      }
    }

    // Default: 404
    return {
      ok: false,
      status: 404,
      json: vi.fn().mockResolvedValue({}),
      text: vi.fn().mockResolvedValue('Not Found'),
    };
  }) as unknown as typeof fetch;
}

/** Builds a base ImageGenerationRequest for tests. */
function makeRequest(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    modelId: 'v1-5-pruned-emaonly',
    prompt: 'A red panda sitting on a moonlit rooftop',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StableDiffusionLocalProvider', () => {
  let provider: StableDiffusionLocalProvider;

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  describe('initialize()', () => {
    it('detects Automatic1111 backend via /sdapi/v1/sd-models', async () => {
      const mockFetch = makeMockFetch({
        '/sdapi/v1/sd-models': { ok: true, status: 200, body: makeA1111ModelsResponse() },
      });
      provider = new StableDiffusionLocalProvider(mockFetch);

      await provider.initialize({ baseURL: 'http://localhost:7860' });

      expect(provider.isInitialized).toBe(true);
      expect(provider.defaultModelId).toBe('v1-5-pruned-emaonly');
    });

    it('detects ComfyUI backend via /system_stats when A1111 is unavailable', async () => {
      const mockFetch = makeMockFetch({
        '/system_stats': { ok: true, status: 200, body: { system: {} } },
      });
      provider = new StableDiffusionLocalProvider(mockFetch);

      await provider.initialize({ baseURL: 'http://localhost:8188' });

      expect(provider.isInitialized).toBe(true);
    });

    it('falls back to A1111 when neither backend is detected', async () => {
      const mockFetch = makeMockFetch({});
      provider = new StableDiffusionLocalProvider(mockFetch);

      await provider.initialize({ baseURL: 'http://localhost:7860' });

      expect(provider.isInitialized).toBe(true);
    });

    it('throws without baseURL', async () => {
      provider = new StableDiffusionLocalProvider();
      await expect(provider.initialize({})).rejects.toThrow('requires baseURL');
    });

    it('throws with empty baseURL string', async () => {
      provider = new StableDiffusionLocalProvider();
      await expect(provider.initialize({ baseURL: '  ' })).rejects.toThrow('requires baseURL');
    });

    it('strips trailing slashes from baseURL', async () => {
      const mockFetch = makeMockFetch({
        '/sdapi/v1/sd-models': { ok: true, status: 200, body: makeA1111ModelsResponse() },
      });
      provider = new StableDiffusionLocalProvider(mockFetch);

      await provider.initialize({ baseURL: 'http://localhost:7860///' });

      // Verify that subsequent calls don't have double slashes.
      // The sd-models probe should have been called with the trimmed URL.
      const calledUrl = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toBe('http://localhost:7860/sdapi/v1/sd-models');
    });

    it('accepts baseUrl and baseurl variants', async () => {
      const mockFetch = makeMockFetch({
        '/sdapi/v1/sd-models': { ok: true, status: 200, body: makeA1111ModelsResponse() },
      });

      const p1 = new StableDiffusionLocalProvider(mockFetch);
      await p1.initialize({ baseUrl: 'http://localhost:7860' });
      expect(p1.isInitialized).toBe(true);

      const p2 = new StableDiffusionLocalProvider(mockFetch);
      await p2.initialize({ baseurl: 'http://localhost:7860' });
      expect(p2.isInitialized).toBe(true);
    });

    it('uses explicit defaultModelId from config instead of auto-detected', async () => {
      const mockFetch = makeMockFetch({
        '/sdapi/v1/sd-models': { ok: true, status: 200, body: makeA1111ModelsResponse() },
      });
      provider = new StableDiffusionLocalProvider(mockFetch);

      await provider.initialize({ baseURL: 'http://localhost:7860', defaultModelId: 'my-custom-model' });

      expect(provider.defaultModelId).toBe('my-custom-model');
    });
  });

  // -----------------------------------------------------------------------
  // A1111 generation
  // -----------------------------------------------------------------------

  describe('generateImage() — A1111 backend', () => {
    let mockFetch: typeof fetch;

    beforeEach(async () => {
      mockFetch = makeMockFetch({
        '/sdapi/v1/sd-models': { ok: true, status: 200, body: makeA1111ModelsResponse() },
        '/sdapi/v1/txt2img': { ok: true, status: 200, body: makeA1111Txt2ImgResponse(2) },
      });
      provider = new StableDiffusionLocalProvider(mockFetch);
      await provider.initialize({ baseURL: 'http://localhost:7860' });
    });

    it('calls the correct A1111 endpoint with proper headers and body', async () => {
      await provider.generateImage(makeRequest());

      const calls = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const txt2imgCall = calls.find((c: unknown[]) => (c[0] as string).includes('/sdapi/v1/txt2img'));
      expect(txt2imgCall).toBeDefined();

      const [url, init] = txt2imgCall as [string, RequestInit];
      expect(url).toBe('http://localhost:7860/sdapi/v1/txt2img');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

      const body = JSON.parse(init.body as string);
      expect(body.prompt).toBe('A red panda sitting on a moonlit rooftop');
      expect(body.steps).toBe(25);
      expect(body.cfg_scale).toBe(7.5);
      expect(body.seed).toBe(-1);
      expect(body.sampler_name).toBe('Euler a');
      expect(body.width).toBe(512);
      expect(body.height).toBe(512);
      expect(body.batch_size).toBe(1);
    });

    it('returns images with base64 data and metadata', async () => {
      const result = await provider.generateImage(makeRequest());

      expect(result.providerId).toBe('stable-diffusion-local');
      expect(result.images).toHaveLength(2);
      expect(result.images[0].base64).toBe('base64data_image_0');
      expect(result.images[0].mimeType).toBe('image/png');
      expect(result.images[0].dataUrl).toContain('data:image/png;base64,');
      expect(result.images[1].base64).toBe('base64data_image_1');
      expect(result.usage?.totalImages).toBe(2);
      expect(result.usage?.totalCostUSD).toBe(0);
    });

    it('passes through providerOptions (seed, sampler, steps, cfgScale)', async () => {
      await provider.generateImage(
        makeRequest({
          providerOptions: {
            'stable-diffusion-local': {
              seed: 42,
              sampler: 'DPM++ 2M Karras',
              steps: 50,
              cfgScale: 12,
              width: 768,
              height: 768,
              batchSize: 3,
              negativePrompt: 'blurry, low quality',
            },
          },
        }),
      );

      const calls = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const txt2imgCall = calls.find((c: unknown[]) => (c[0] as string).includes('/sdapi/v1/txt2img'));
      const body = JSON.parse((txt2imgCall as [string, RequestInit])[1].body as string);

      expect(body.seed).toBe(42);
      expect(body.sampler_name).toBe('DPM++ 2M Karras');
      expect(body.steps).toBe(50);
      expect(body.cfg_scale).toBe(12);
      expect(body.width).toBe(768);
      expect(body.height).toBe(768);
      expect(body.batch_size).toBe(3);
      expect(body.negative_prompt).toBe('blurry, low quality');
    });

    it('injects LoRA models into the prompt', async () => {
      await provider.generateImage(
        makeRequest({
          providerOptions: {
            'stable-diffusion-local': {
              loras: [
                { name: 'detailed_eyes', weight: 0.8 },
                { name: 'anime_style' },
              ],
            },
          },
        }),
      );

      const calls = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const txt2imgCall = calls.find((c: unknown[]) => (c[0] as string).includes('/sdapi/v1/txt2img'));
      const body = JSON.parse((txt2imgCall as [string, RequestInit])[1].body as string);

      expect(body.prompt).toContain('<lora:detailed_eyes:0.8>');
      expect(body.prompt).toContain('<lora:anime_style:1>');
    });

    it('enables high-res fix when hrFix is true', async () => {
      await provider.generateImage(
        makeRequest({
          providerOptions: {
            'stable-diffusion-local': {
              hrFix: true,
              denoisingStrength: 0.5,
            },
          },
        }),
      );

      const calls = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const txt2imgCall = calls.find((c: unknown[]) => (c[0] as string).includes('/sdapi/v1/txt2img'));
      const body = JSON.parse((txt2imgCall as [string, RequestInit])[1].body as string);

      expect(body.enable_hr).toBe(true);
      expect(body.denoising_strength).toBe(0.5);
    });

    it('uses default denoising_strength of 0.7 for hrFix', async () => {
      await provider.generateImage(
        makeRequest({
          providerOptions: {
            'stable-diffusion-local': { hrFix: true },
          },
        }),
      );

      const calls = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const txt2imgCall = calls.find((c: unknown[]) => (c[0] as string).includes('/sdapi/v1/txt2img'));
      const body = JSON.parse((txt2imgCall as [string, RequestInit])[1].body as string);

      expect(body.denoising_strength).toBe(0.7);
    });

    it('sets override_settings when modelId is provided', async () => {
      await provider.generateImage(makeRequest({ modelId: 'sdxl-base-1.0' }));

      const calls = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const txt2imgCall = calls.find((c: unknown[]) => (c[0] as string).includes('/sdapi/v1/txt2img'));
      const body = JSON.parse((txt2imgCall as [string, RequestInit])[1].body as string);

      expect(body.override_settings).toEqual({ sd_model_checkpoint: 'sdxl-base-1.0' });
    });

    it('reports the checkpoint the server says it rendered with when the request names no model', async () => {
      // The second listed checkpoint is the one loaded; the first is only first in the list.
      const rendered = { images: ['base64data'], parameters: {}, info: JSON.stringify({ sd_model_name: 'sdxl-base-1.0' }) };
      const fetchImpl = makeMockFetch({
        '/sdapi/v1/sd-models': { ok: true, status: 200, body: makeA1111ModelsResponse() },
        '/sdapi/v1/txt2img': { ok: true, status: 200, body: rendered },
      });
      const local = new StableDiffusionLocalProvider(fetchImpl);
      await local.initialize({ baseURL: 'http://localhost:7860' });

      expect((await local.generateImage(makeRequest({ modelId: '' }))).modelId).toBe('sdxl-base-1.0');
      // A model the request names is reported as named.
      expect((await local.generateImage(makeRequest({ modelId: 'v1-5-pruned-emaonly' }))).modelId).toBe('v1-5-pruned-emaonly');
    });

    it('reports the first listed checkpoint when the response names none', async () => {
      const fetchImpl = makeMockFetch({
        '/sdapi/v1/sd-models': { ok: true, status: 200, body: makeA1111ModelsResponse() },
        '/sdapi/v1/txt2img': { ok: true, status: 200, body: makeA1111Txt2ImgResponse() },
      });
      const local = new StableDiffusionLocalProvider(fetchImpl);
      await local.initialize({ baseURL: 'http://localhost:7860' });

      expect((await local.generateImage(makeRequest({ modelId: '' }))).modelId).toBe('v1-5-pruned-emaonly');
    });

    it('parses size string into width and height', async () => {
      await provider.generateImage(makeRequest({ size: '1024x768' }));

      const calls = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const txt2imgCall = calls.find((c: unknown[]) => (c[0] as string).includes('/sdapi/v1/txt2img'));
      const body = JSON.parse((txt2imgCall as [string, RequestInit])[1].body as string);

      expect(body.width).toBe(1024);
      expect(body.height).toBe(768);
    });

    it('uses negativePrompt from the top-level request when not in providerOptions', async () => {
      await provider.generateImage(makeRequest({ negativePrompt: 'ugly, deformed' }));

      const calls = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const txt2imgCall = calls.find((c: unknown[]) => (c[0] as string).includes('/sdapi/v1/txt2img'));
      const body = JSON.parse((txt2imgCall as [string, RequestInit])[1].body as string);

      expect(body.negative_prompt).toBe('ugly, deformed');
    });

    it('throws on HTTP error response', async () => {
      const errorFetch = makeMockFetch({
        '/sdapi/v1/sd-models': { ok: true, status: 200, body: makeA1111ModelsResponse() },
        '/sdapi/v1/txt2img': { ok: false, status: 500, body: 'Internal Server Error' },
      });
      const p = new StableDiffusionLocalProvider(errorFetch);
      await p.initialize({ baseURL: 'http://localhost:7860' });

      await expect(p.generateImage(makeRequest())).rejects.toThrow('Stable Diffusion API error 500');
    });

    it('throws when not initialized', async () => {
      const p = new StableDiffusionLocalProvider();
      await expect(p.generateImage(makeRequest())).rejects.toThrow('not initialized');
    });
  });

  // -----------------------------------------------------------------------
  // listAvailableModels
  // -----------------------------------------------------------------------

  describe('listAvailableModels()', () => {
    it('returns models from A1111 backend', async () => {
      const mockFetch = makeMockFetch({
        '/sdapi/v1/sd-models': { ok: true, status: 200, body: makeA1111ModelsResponse() },
      });
      provider = new StableDiffusionLocalProvider(mockFetch);
      await provider.initialize({ baseURL: 'http://localhost:7860' });

      const models = await provider.listAvailableModels();

      expect(models).toHaveLength(2);
      expect(models[0].modelId).toBe('v1-5-pruned-emaonly');
      expect(models[0].providerId).toBe('stable-diffusion-local');
      expect(models[0].displayName).toBe('v1-5-pruned-emaonly [abc123]');
      expect(models[0].description).toContain('/models/v1-5.safetensors');
      expect(models[1].modelId).toBe('sdxl-base-1.0');
    });

    it('returns empty array for ComfyUI backend', async () => {
      const mockFetch = makeMockFetch({
        '/system_stats': { ok: true, status: 200, body: { system: {} } },
      });
      provider = new StableDiffusionLocalProvider(mockFetch);
      await provider.initialize({ baseURL: 'http://localhost:8188' });

      const models = await provider.listAvailableModels();

      expect(models).toEqual([]);
    });

    it('throws when not initialized', async () => {
      provider = new StableDiffusionLocalProvider();
      await expect(provider.listAvailableModels()).rejects.toThrow('not initialized');
    });
  });

  // -----------------------------------------------------------------------
  // shutdown
  // -----------------------------------------------------------------------

  describe('shutdown()', () => {
    it('resets initialization state', async () => {
      const mockFetch = makeMockFetch({
        '/sdapi/v1/sd-models': { ok: true, status: 200, body: makeA1111ModelsResponse() },
      });
      provider = new StableDiffusionLocalProvider(mockFetch);
      await provider.initialize({ baseURL: 'http://localhost:7860' });
      expect(provider.isInitialized).toBe(true);

      await provider.shutdown();

      expect(provider.isInitialized).toBe(false);
    });

    it('causes generateImage to throw after shutdown', async () => {
      const mockFetch = makeMockFetch({
        '/sdapi/v1/sd-models': { ok: true, status: 200, body: makeA1111ModelsResponse() },
        '/sdapi/v1/txt2img': { ok: true, status: 200, body: makeA1111Txt2ImgResponse() },
      });
      provider = new StableDiffusionLocalProvider(mockFetch);
      await provider.initialize({ baseURL: 'http://localhost:7860' });
      await provider.shutdown();

      await expect(provider.generateImage(makeRequest())).rejects.toThrow('not initialized');
    });
  });
});
