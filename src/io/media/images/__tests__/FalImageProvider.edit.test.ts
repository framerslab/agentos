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

  it('performs img2img with strength parameter', async () => {
    mockFetch
      .mockResolvedValueOnce(mockSubmit())
      .mockResolvedValueOnce(mockStatus())
      .mockResolvedValueOnce(mockResult());

    const result = await provider.editImage({
      modelId: 'fal-ai/flux/dev',
      image: Buffer.from('fake'),
      prompt: 'oil painting style',
      strength: 0.65,
    });

    expect(result.images).toHaveLength(1);
    expect(result.providerId).toBe('fal');
    const submitBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(submitBody.image).toBeDefined();
    expect(submitBody.strength).toBe(0.65);
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

  it('passes mask as base64 data URL when provided', async () => {
    mockFetch
      .mockResolvedValueOnce(mockSubmit())
      .mockResolvedValueOnce(mockStatus())
      .mockResolvedValueOnce(mockResult());

    await provider.editImage({
      modelId: 'fal-ai/flux/dev',
      image: Buffer.from('fake-image'),
      prompt: 'fill area',
      mask: Buffer.from('fake-mask'),
    });

    const submitBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(submitBody.mask).toContain('data:image/png;base64,');
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
