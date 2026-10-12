import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplicateImageProvider } from '../providers/ReplicateImageProvider.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockPredictionResponse(output: unknown, status = 'succeeded') {
  return {
    ok: true,
    json: async () => ({ id: 'pred_123', status, output }),
    text: async () => '',
    headers: new Headers(),
  };
}

describe('ReplicateImageProvider', () => {
  let provider: ReplicateImageProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new ReplicateImageProvider();
    await provider.initialize({ apiKey: 'test-key' });
  });

  describe('generateImage', () => {
    it('uses legacy /predictions endpoint for version-hash model IDs', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPredictionResponse(['https://example.com/image.png'])
      );

      await provider.generateImage({
        modelId: 'daanelson/some-model:abc123def456',
        prompt: 'a test image',
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.replicate.com/v1/predictions');
      const body = JSON.parse(opts.body);
      expect(body.version).toBe('daanelson/some-model:abc123def456');
    });

    it('uses modern /models/.../predictions endpoint for plain model IDs', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPredictionResponse(['https://example.com/image.png'])
      );

      await provider.generateImage({
        modelId: 'black-forest-labs/flux-1.1-pro',
        prompt: 'a test image',
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(
        'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions'
      );
    });

    it('defaults to flux-schnell when no model specified', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPredictionResponse(['https://example.com/image.png'])
      );

      await provider.generateImage({ prompt: 'test' });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('black-forest-labs/flux-schnell');
    });

    it('passes prompt and standard options through to input', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPredictionResponse(['https://example.com/image.png'])
      );

      await provider.generateImage({
        prompt: 'a scenic mountain',
        seed: 42,
        negativePrompt: 'blurry',
        aspectRatio: '16:9',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.input.prompt).toBe('a scenic mountain');
      expect(body.input.seed).toBe(42);
      expect(body.input.negative_prompt).toBe('blurry');
      expect(body.input.aspect_ratio).toBe('16:9');
    });

    it('returns normalized images from array output', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPredictionResponse([
          'https://example.com/img1.png',
          'https://example.com/img2.png',
        ])
      );

      const result = await provider.generateImage({ prompt: 'test' });

      expect(result.images).toHaveLength(2);
      expect(result.images[0].url).toBe('https://example.com/img1.png');
      expect(result.images[1].url).toBe('https://example.com/img2.png');
      expect(result.providerId).toBe('replicate');
    });
  });

  describe('listAvailableModels', () => {
    it('returns at least 13 models with descriptions', async () => {
      const models = await provider.listAvailableModels();
      expect(models.length).toBeGreaterThanOrEqual(13);
      for (const model of models) {
        expect(model.providerId).toBe('replicate');
        expect(model.modelId).toBeTruthy();
        expect(model.displayName).toBeTruthy();
        expect(model.description).toBeTruthy();
      }
    });

    it('includes Pulid for character consistency', async () => {
      const models = await provider.listAvailableModels();
      expect(models.some(m => m.modelId === 'zsxkib/pulid')).toBe(true);
    });

    it('lists the FLUX.2 models transferStyle runs on, and Flux Redux as a variation of one reference', async () => {
      const models = await provider.listAvailableModels();
      for (const modelId of ['black-forest-labs/flux-2-pro', 'black-forest-labs/flux-2-max', 'black-forest-labs/flux-2-flex', 'black-forest-labs/flux-2-dev']) {
        expect(models.find(m => m.modelId === modelId)?.description).toMatch(/transferStyle/);
      }
      expect(models.find(m => m.modelId === 'black-forest-labs/flux-redux-dev')?.description).toMatch(/variation of one reference image/);
    });

    it('includes Flux Fill Pro for inpainting', async () => {
      const models = await provider.listAvailableModels();
      expect(models.some(m => m.modelId === 'black-forest-labs/flux-fill-pro')).toBe(true);
    });

    it('includes ControlNet models (Canny, Depth)', async () => {
      const models = await provider.listAvailableModels();
      expect(models.some(m => m.modelId === 'black-forest-labs/flux-canny-dev')).toBe(true);
      expect(models.some(m => m.modelId === 'black-forest-labs/flux-depth-dev')).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throws on rate limit (429)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
        headers: new Headers(),
      });

      await expect(
        provider.generateImage({ prompt: 'test' })
      ).rejects.toThrow('429');
    });

    it('throws on failed prediction status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'p1', status: 'failed', error: 'content policy violation' }),
        text: async () => '',
        headers: new Headers(),
      });

      await expect(
        provider.generateImage({ prompt: 'test' })
      ).rejects.toThrow('failed');
    });

    it('throws on cancelled prediction', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'p1', status: 'canceled' }),
        text: async () => '',
        headers: new Headers(),
      });

      await expect(
        provider.generateImage({ prompt: 'test' })
      ).rejects.toThrow('canceled');
    });

    it('throws when prediction returns no images', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPredictionResponse([])
      );

      await expect(
        provider.generateImage({ prompt: 'test' })
      ).rejects.toThrow('no image');
    });

    it('throws when not initialized', async () => {
      const uninit = new ReplicateImageProvider();
      await expect(
        uninit.generateImage({ prompt: 'test' })
      ).rejects.toThrow('not initialized');
    });
  });

  describe('editImage', () => {
    // Edit calls without an inline version hash route through the modern
    // /models/{owner}/{name}/predictions endpoint, which does NOT carry
    // `version` in the body. Assert against the request URL instead.
    it('uses flux-fill-pro for inpainting when mask provided', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPredictionResponse(['https://example.com/edited.png'])
      );

      await provider.editImage({
        modelId: '',
        image: Buffer.from('fake-image'),
        prompt: 'fill the gap',
        mask: Buffer.from('fake-mask'),
      });

      const requestUrl = mockFetch.mock.calls[0][0] as string;
      expect(requestUrl).toContain('flux-fill-pro');
    });

    it('uses SDXL pinned to a version for img2img without mask, with the strength as prompt_strength', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPredictionResponse(['https://example.com/edited.png'])
      );

      await provider.editImage({
        modelId: '',
        image: Buffer.from('fake-image'),
        prompt: 'transform style',
        strength: 0.4,
      });

      // SDXL is not an official Replicate model, so it runs only by version:
      // the legacy endpoint, with the pinned version in the body.
      const [requestUrl, requestInit] = mockFetch.mock.calls[0];
      expect(requestUrl).toBe('https://api.replicate.com/v1/predictions');
      const body = JSON.parse(requestInit.body);
      expect(body.version).toMatch(/^stability-ai\/sdxl:[0-9a-f]{64}$/);
      // SDXL's input is prompt_strength; it has no strength input.
      expect(body.input.prompt_strength).toBe(0.4);
      expect(body.input.strength).toBeUndefined();
    });

    it('keeps a prompt_strength the caller set for SDXL', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPredictionResponse(['https://example.com/edited.png'])
      );

      await provider.editImage({
        modelId: '',
        image: Buffer.from('fake-image'),
        prompt: 'transform style',
        strength: 0.4,
        providerOptions: { replicate: { input: { prompt_strength: 0.9 } } },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.input.prompt_strength).toBe(0.9);
      expect(body.input.strength).toBeUndefined();
    });

    it('re-maps the source image to input_image for Kontext models', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPredictionResponse(['https://example.com/edited.png'])
      );

      await provider.editImage({
        modelId: 'black-forest-labs/flux-kontext-max',
        image: Buffer.from('fake-image'),
        prompt: 'swap the outfit',
        strength: 0.7,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Kontext takes input_image (singular) and 422s on image/strength.
      expect(body.input.input_image).toContain('data:image/png;base64,');
      expect(body.input.image).toBeUndefined();
      expect(body.input.strength).toBeUndefined();
    });

    it('respects a caller-provided input_image for Kontext models', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPredictionResponse(['https://example.com/edited.png'])
      );

      await provider.editImage({
        modelId: 'black-forest-labs/flux-kontext-pro',
        image: Buffer.from('fake-image'),
        prompt: 'swap the outfit',
        providerOptions: {
          replicate: { input: { input_image: 'https://ref.test/base.png' } },
        },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.input.input_image).toBe('https://ref.test/base.png');
      expect(body.input.image).toBeUndefined();
    });

    it('keeps image + mask untouched for flux-fill inpainting', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPredictionResponse(['https://example.com/edited.png'])
      );

      await provider.editImage({
        modelId: '',
        image: Buffer.from('fake-image'),
        prompt: 'fill the gap',
        mask: Buffer.from('fake-mask'),
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.input.image).toContain('data:image/png;base64,');
      expect(body.input.mask).toContain('data:image/png;base64,');
      expect(body.input.input_image).toBeUndefined();
    });
  });

  describe('upscaleImage', () => {
    it('uses real-esrgan by default', async () => {
      mockFetch.mockResolvedValueOnce(
        mockPredictionResponse(['https://example.com/upscaled.png'])
      );

      await provider.upscaleImage({
        modelId: '',
        image: Buffer.from('fake-image'),
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.version).toContain('real-esrgan');
    });
  });

  // Replicate recommends a data URL only under 1 MB; from 1 MB an image goes
  // through its Files API, and the input names the URL the upload answers with.
  describe('input images from 1 MB', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const large = (signature: Buffer) => Buffer.concat([signature, Buffer.alloc(1_000_000)]);
    const fileResponse = (id: string) => ({
      ok: true,
      json: async () => ({ id, urls: { get: `https://api.replicate.com/v1/files/${id}` } }),
      text: async () => '',
      headers: new Headers(),
    });
    const uploaded = (call: unknown[]) => (call[1] as RequestInit).body as FormData;

    it('uploads an edit source from 1 MB and names its URL; a small mask stays inline as its own type', async () => {
      mockFetch.mockResolvedValueOnce(fileResponse('src1'));
      mockFetch.mockResolvedValueOnce(mockPredictionResponse(['https://example.com/edited.png']));

      await provider.editImage({
        modelId: '',
        image: large(PNG),
        prompt: 'fill the gap',
        mask: Buffer.concat([JPEG, Buffer.alloc(16)]),
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [uploadUrl, uploadInit] = mockFetch.mock.calls[0];
      expect(uploadUrl).toBe('https://api.replicate.com/v1/files');
      expect(uploadInit).toMatchObject({ method: 'POST', headers: { Authorization: 'Token test-key' } });
      const content = uploaded(mockFetch.mock.calls[0]).get('content') as File;
      expect([content.name, content.type, content.size]).toEqual(['image.png', 'image/png', 1_000_008]);
      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.input.image).toBe('https://api.replicate.com/v1/files/src1');
      expect(body.input.mask).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('uploads both style transfer images from 1 MB, the source first', async () => {
      mockFetch.mockResolvedValueOnce(fileResponse('source'));
      mockFetch.mockResolvedValueOnce(fileResponse('style'));
      mockFetch.mockResolvedValueOnce(mockPredictionResponse(['https://example.com/styled.png']));

      await provider.transferStyle({ modelId: '', image: large(PNG), styleImage: large(JPEG), prompt: 'as a watercolour' });

      expect((uploaded(mockFetch.mock.calls[1]).get('content') as File).name).toBe('style.jpg');
      const body = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(body.input.input_images).toEqual([
        'https://api.replicate.com/v1/files/source',
        'https://api.replicate.com/v1/files/style',
      ]);
    });

    it('uploads nothing for an edit source the caller set in providerOptions.input', async () => {
      mockFetch.mockResolvedValueOnce(mockPredictionResponse(['https://example.com/edited.png']));

      await provider.editImage({
        modelId: 'black-forest-labs/flux-kontext-pro',
        image: large(PNG),
        prompt: 'swap the outfit',
        providerOptions: { replicate: { input: { input_image: 'https://ref.test/base.png' } } },
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).input.input_image).toBe('https://ref.test/base.png');
    });

    it('keeps a large image inline on a self-hosted base URL, which has no Files API', async () => {
      const selfHosted = new ReplicateImageProvider();
      await selfHosted.initialize({ apiKey: 'test-key', baseURL: 'http://cog.local/v1' });
      mockFetch.mockResolvedValueOnce(mockPredictionResponse(['https://example.com/upscaled.png']));

      await selfHosted.upscaleImage({ modelId: '', image: large(PNG) });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe('http://cog.local/v1/predictions');
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).input.image).toMatch(/^data:image\/png;base64,/);
    });

    it('fails the call when the upload fails, before any prediction', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 413, text: async () => 'too large', json: async () => ({}), headers: new Headers() });

      await expect(provider.upscaleImage({ modelId: '', image: large(PNG) })).rejects.toThrow(
        'Replicate file upload failed (413): too large',
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
