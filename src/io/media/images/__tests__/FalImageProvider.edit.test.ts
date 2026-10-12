import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FalImageProvider } from '../providers/FalImageProvider.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockSubmit() {
  return { ok: true, json: async () => ({ request_id: 'req_123' }), text: async () => '' };
}
function mockStatus(status = 'COMPLETED') {
  return { ok: true, json: async () => ({ status }), text: async () => '' };
}
function mockResult(images = [{ url: 'https://fal.test/out.png', width: 1024, height: 1024 }]) {
  return { ok: true, json: async () => ({ images }), text: async () => '' };
}

describe('FalImageProvider — editImage', () => {
  let provider: FalImageProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new FalImageProvider();
    await provider.initialize({ apiKey: 'fal_test', pollIntervalMs: 1, timeoutMs: 5000 });
  });

  it('runs an edit on fal-ai/flux/dev, which is text-to-image, on its image-to-image endpoint', async () => {
    mockFetch
      .mockResolvedValueOnce(mockSubmit())
      .mockResolvedValueOnce(mockStatus())
      .mockResolvedValueOnce(mockResult());

    const result = await provider.editImage({
      modelId: 'fal-ai/flux/dev',
      image: Buffer.from('fake'),
      prompt: 'oil painting style',
      strength: 0.65,
      negativePrompt: 'blur',
    });

    expect(result.images).toHaveLength(1);
    expect(result.providerId).toBe('fal');
    expect(result.modelId).toBe('fal-ai/flux/dev/image-to-image');
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toMatch(/\/fal-ai\/flux\/dev\/image-to-image$/);
    const submitBody = JSON.parse(init.body);
    // The endpoint's own fields: image_url and strength, no image and no negative prompt.
    expect(submitBody.image_url).toMatch(/^data:image\/png;base64,/);
    expect(submitBody.strength).toBe(0.65);
    expect(submitBody).not.toHaveProperty('image');
    expect(submitBody).not.toHaveProperty('negative_prompt');
  });

  it('edits on the image-to-image endpoint when no model is named, the source typed by its bytes', async () => {
    mockFetch
      .mockResolvedValueOnce(mockSubmit())
      .mockResolvedValueOnce(mockStatus())
      .mockResolvedValueOnce(mockResult());
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

    await provider.editImage({ modelId: '', image: jpeg, prompt: 'warmer light' });

    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toMatch(/\/fal-ai\/flux\/dev\/image-to-image$/);
    expect(JSON.parse(init.body).image_url).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
  });

  it('defaults strength to 0.75 when not specified', async () => {
    mockFetch
      .mockResolvedValueOnce(mockSubmit())
      .mockResolvedValueOnce(mockStatus())
      .mockResolvedValueOnce(mockResult());

    await provider.editImage({
      modelId: 'fal-ai/flux/dev',
      image: Buffer.from('fake'),
      prompt: 'test',
    });

    const submitBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(submitBody.strength).toBe(0.75);
  });

  it('inpaints on the FLUX.1 dev inpainting endpoint, with the mask as mask_url', async () => {
    mockFetch
      .mockResolvedValueOnce(mockSubmit())
      .mockResolvedValueOnce(mockStatus())
      .mockResolvedValueOnce(mockResult());

    const result = await provider.editImage({
      modelId: 'fal-ai/flux/dev',
      image: Buffer.from('fake-image'),
      prompt: 'fill area',
      mask: Buffer.from('fake-mask'),
    });

    expect(result.modelId).toBe('fal-ai/flux-lora/inpainting');
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toMatch(/\/fal-ai\/flux-lora\/inpainting$/);
    const submitBody = JSON.parse(init.body);
    expect(submitBody.image_url).toContain('data:image/png;base64,');
    expect(submitBody.mask_url).toBe(`data:image/png;base64,${Buffer.from('fake-mask').toString('base64')}`);
    expect(submitBody).not.toHaveProperty('mask');
  });

  it('throws when not initialized', async () => {
    const uninit = new FalImageProvider();
    await expect(
      uninit.editImage({ modelId: '', image: Buffer.from('x'), prompt: 'test' })
    ).rejects.toThrow('not initialized');
  });

  it('polls + fetches the status_url/response_url Fal returns (multi-segment edit model)', async () => {
    // Regression: reconstructing `${base}/${model}/requests/${id}/status` 405s for
    // multi-segment edit-model slugs (e.g. fal-ai/flux-pro/kontext/max), which broke
    // every companion selfie + outfit preview. Fal returns the correct status_url /
    // response_url on submit — use them instead of reconstructing.
    const statusUrl = 'https://queue.fal.run/fal-ai/flux-pro/requests/req_xyz/status';
    const responseUrl = 'https://queue.fal.run/fal-ai/flux-pro/requests/req_xyz';
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ request_id: 'req_xyz', status_url: statusUrl, response_url: responseUrl }),
        text: async () => '',
      })
      .mockResolvedValueOnce(mockStatus())
      .mockResolvedValueOnce(mockResult());

    await provider.editImage({
      modelId: 'fal-ai/flux-pro/kontext/max',
      image: Buffer.from('fake'),
      prompt: 'selfie',
    });

    // 2nd fetch = poll, 3rd = result — both must use Fal's returned URLs, not the
    // reconstructed `${base}/fal-ai/flux-pro/kontext/max/requests/...` (which 405s).
    expect(mockFetch.mock.calls[1][0]).toBe(statusUrl);
    expect(mockFetch.mock.calls[2][0]).toBe(responseUrl);
  });

  describe('listAvailableModels', () => {
    it('returns at least 7 models with descriptions', async () => {
      const models = await provider.listAvailableModels();
      expect(models.length).toBeGreaterThanOrEqual(7);
      expect(models.every(m => m.providerId === 'fal')).toBe(true);
      expect(models.every(m => !!m.description)).toBe(true);
    });
  });

  describe('model-aware source mapping (FLUX.2 + Kontext)', () => {
    it('kontext edits send image_url (no strength, no image)', async () => {
      mockFetch
        .mockResolvedValueOnce(mockSubmit())
        .mockResolvedValueOnce(mockStatus())
        .mockResolvedValueOnce(mockResult());
      await provider.editImage({
        modelId: 'fal-ai/flux-pro/kontext/max',
        image: Buffer.from('img'),
        prompt: 'swap the outfit',
        strength: 0.7,
      });
      const [url, init] = mockFetch.mock.calls[0];
      expect(String(url)).toContain('fal-ai/flux-pro/kontext/max');
      const body = JSON.parse(init.body);
      expect(body.image_url).toContain('data:image/png;base64,');
      expect(body.image).toBeUndefined();
      expect(body.strength).toBeUndefined();
    });

    it('FLUX.2 edit endpoints send an image_urls array (no strength)', async () => {
      mockFetch
        .mockResolvedValueOnce(mockSubmit())
        .mockResolvedValueOnce(mockStatus())
        .mockResolvedValueOnce(mockResult());
      await provider.editImage({
        modelId: 'fal-ai/flux-2-pro/edit',
        image: Buffer.from('img'),
        prompt: 'reference-anchored render',
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(Array.isArray(body.image_urls)).toBe(true);
      expect(body.image_urls[0]).toContain('data:image/png;base64,');
      expect(body.image).toBeUndefined();
      expect(body.strength).toBeUndefined();
    });

    it('image-to-image and inpainting endpoints take image_url + strength, as their schemas name them', async () => {
      for (const modelId of ['fal-ai/flux/dev/image-to-image', 'fal-ai/flux-general/inpainting']) {
        mockFetch
          .mockResolvedValueOnce(mockSubmit())
          .mockResolvedValueOnce(mockStatus())
          .mockResolvedValueOnce(mockResult());
        await provider.editImage({ modelId, image: Buffer.from('img'), prompt: 'edit it', strength: 0.6 });
      }
      for (const [, init] of [mockFetch.mock.calls[0], mockFetch.mock.calls[3]]) {
        const body = JSON.parse(init.body);
        expect(body.image_url).toContain('data:image/png;base64,');
        expect(body.strength).toBe(0.6);
        expect(body.image).toBeUndefined();
        expect(body.image_urls).toBeUndefined();
      }
    });

    it('any other model keeps the image + strength pair this provider has always sent', async () => {
      mockFetch
        .mockResolvedValueOnce(mockSubmit())
        .mockResolvedValueOnce(mockStatus())
        .mockResolvedValueOnce(mockResult());
      await provider.editImage({ modelId: 'acme/custom-img2img', image: Buffer.from('img'), prompt: 'edit it', strength: 0.6 });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.image).toContain('data:image/png;base64,');
      expect(body.strength).toBe(0.6);
      expect(body.image_url).toBeUndefined();
    });
  });

  describe('generate reference + aspect mapping (FLUX.2 + Kontext)', () => {
    it('flux-2 + referenceImageUrl upgrades to the /edit endpoint with image_urls', async () => {
      mockFetch
        .mockResolvedValueOnce(mockSubmit())
        .mockResolvedValueOnce(mockStatus())
        .mockResolvedValueOnce(mockResult());
      await provider.generateImage({
        modelId: 'fal-ai/flux-2-pro',
        prompt: 'portrait',
        referenceImageUrl: 'https://ref.test/face.png',
      });
      const [url, init] = mockFetch.mock.calls[0];
      expect(String(url)).toContain('fal-ai/flux-2-pro/edit');
      const body = JSON.parse(init.body);
      expect(body.image_urls).toEqual(['https://ref.test/face.png']);
      expect(body.ip_adapter_image).toBeUndefined();
    });

    it('kontext generate maps referenceImageUrl to image_url', async () => {
      mockFetch
        .mockResolvedValueOnce(mockSubmit())
        .mockResolvedValueOnce(mockStatus())
        .mockResolvedValueOnce(mockResult());
      await provider.generateImage({
        modelId: 'fal-ai/flux-pro/kontext',
        prompt: 'restyle',
        referenceImageUrl: 'https://ref.test/base.png',
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.image_url).toBe('https://ref.test/base.png');
      expect(body.ip_adapter_image).toBeUndefined();
    });

    it('flux-2 aspectRatio 16:9 maps to the landscape_16_9 image_size preset', async () => {
      mockFetch
        .mockResolvedValueOnce(mockSubmit())
        .mockResolvedValueOnce(mockStatus())
        .mockResolvedValueOnce(mockResult());
      await provider.generateImage({
        modelId: 'fal-ai/flux-2-max',
        prompt: 'hero cover',
        aspectRatio: '16:9',
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.image_size).toBe('landscape_16_9');
    });
  });

  describe('failure detail', () => {
    it('includes the provider error payload when a request FAILS', async () => {
      mockFetch
        .mockResolvedValueOnce(mockSubmit())
        .mockResolvedValueOnce(mockStatus('FAILED'))
        // Best-effort detail fetch against the response endpoint.
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({}),
          text: async () => '{"detail":"NSFW content detected in image"}',
        });

      await expect(
        provider.editImage({
          modelId: 'fal-ai/flux/dev/image-to-image',
          image: Buffer.from('fake-image'),
          prompt: 'edit it',
        }),
      ).rejects.toThrow(/NSFW content detected/);
    });

    it('falls back to the bare message when the detail fetch itself fails', async () => {
      mockFetch
        .mockResolvedValueOnce(mockSubmit())
        .mockResolvedValueOnce(mockStatus('FAILED'))
        .mockRejectedValueOnce(new Error('network down'));

      await expect(
        provider.editImage({
          modelId: 'fal-ai/flux/dev/image-to-image',
          image: Buffer.from('fake-image'),
          prompt: 'edit it',
        }),
      ).rejects.toThrow(/image generation failed for request req_123/);
    });
  });
});
