import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplicateSegmentationProvider } from '../providers/ReplicateSegmentationProvider.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** A 12x10 black PNG with a white 4x3 rect at (2,1), as a data-URL mask ref. */
async function maskDataUrl(): Promise<string> {
  const sharp = (await import('sharp')).default;
  const overlay = await sharp({ create: { width: 4, height: 3, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const png = await sharp({ create: { width: 12, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: overlay, left: 2, top: 1 }]).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** A 12x10 source image (so width/height come back correctly). */
async function sourceImage(): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width: 12, height: 10, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => '' };
}

/** Mock for the GET /models/{owner}/{name} version-resolution lookup. */
function modelVersion(id: string) {
  return ok({ latest_version: { id } });
}

describe('ReplicateSegmentationProvider', () => {
  let provider: ReplicateSegmentationProvider;
  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new ReplicateSegmentationProvider();
    await provider.initialize({ apiKey: 'test-key' });
  });

  it('supports text and automatic modes', () => {
    expect(provider.supportedModes()).toEqual(['text', 'automatic']);
  });

  it('rejects modelIds that are not exactly "owner/name" before any request', async () => {
    const image = await sourceImage();
    for (const modelId of ['sam2', 'owner/', '/name', 'a/b/c']) {
      await expect(
        provider.segment({ modelId, image, mode: 'automatic' }),
      ).rejects.toMatchObject({ name: 'SegmentationProviderError', code: 'invalid_request' });
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('automatic mode: resolves version, posts to /predictions, decodes individual_masks', async () => {
    const url = await maskDataUrl();
    mockFetch
      .mockResolvedValueOnce(modelVersion('ver-sam2'))
      .mockResolvedValueOnce(ok({ id: 'p1', status: 'succeeded', output: { combined_mask: url, individual_masks: [url, url] } }));

    const result = await provider.segment({ modelId: 'meta/sam-2', image: await sourceImage(), mode: 'automatic' });

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.replicate.com/v1/models/meta/sam-2');
    const [predUrl, opts] = mockFetch.mock.calls[1];
    expect(predUrl).toBe('https://api.replicate.com/v1/predictions');
    expect(opts.headers.Authorization).toBe('Token test-key');
    const body = JSON.parse(opts.body);
    expect(body.version).toBe('ver-sam2');
    expect(typeof body.input.image).toBe('string');
    expect(body.input.mask_prompt).toBeUndefined();

    expect(result.width).toBe(12);
    expect(result.height).toBe(10);
    expect(result.promptMode).toBe('automatic');
    expect(result.masks).toHaveLength(2);
    expect(result.masks[0].bbox).toEqual({ x: 2, y: 1, width: 4, height: 3 });
    expect(result.masks[1].index).toBe(1);
  });

  it('text mode: sends mask_prompt and labels masks with the phrase', async () => {
    const url = await maskDataUrl();
    mockFetch
      .mockResolvedValueOnce(modelVersion('ver-gsam'))
      .mockResolvedValueOnce(ok({ id: 'p2', status: 'succeeded', output: [url] }));

    const result = await provider.segment({
      modelId: 'schananas/grounded_sam', image: await sourceImage(), mode: 'text', prompt: 'chair',
    });

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.version).toBe('ver-gsam');
    expect(body.input.mask_prompt).toBe('chair');
    expect(body.input.text_prompt).toBeUndefined();
    expect(result.masks).toHaveLength(1);
    expect(result.masks[0].label).toBe('chair');
    expect(result.masks[0].score).toBe(1);
  });

  it('uses an explicit version pin directly without a model lookup', async () => {
    const url = await maskDataUrl();
    mockFetch.mockResolvedValueOnce(ok({ id: 'p', status: 'succeeded', output: [url] }));

    await provider.segment({ modelId: 'owner/model:abc123', image: await sourceImage(), mode: 'automatic' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [predUrl, opts] = mockFetch.mock.calls[0];
    expect(predUrl).toBe('https://api.replicate.com/v1/predictions');
    expect(JSON.parse(opts.body).version).toBe('abc123');
  });

  it('rejects coordinate modes (box/points) as unsupported before any fetch', async () => {
    await expect(
      provider.segment({
        modelId: 'meta/sam-2', image: await sourceImage(), mode: 'box',
        box: { x: 0, y: 0, width: 4, height: 4 },
      }),
    ).rejects.toMatchObject({ name: 'SegmentationModeNotSupportedError', mode: 'box' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('ReplicateSegmentationProvider — polling and errors', () => {
  let provider: ReplicateSegmentationProvider;
  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new ReplicateSegmentationProvider();
    await provider.initialize({ apiKey: 'test-key', defaultModelId: 'meta/sam-2' });
  });

  it('polls urls.get until the prediction succeeds', async () => {
    const url = await maskDataUrl();
    mockFetch
      .mockResolvedValueOnce(modelVersion('v'))
      .mockResolvedValueOnce(ok({ id: 'p', status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/p' } }))
      .mockResolvedValueOnce(ok({ id: 'p', status: 'succeeded', output: [url] }));

    const result = await provider.segment({
      modelId: 'meta/sam-2', image: await sourceImage(), mode: 'automatic',
      providerOptions: { replicate: { pollIntervalMs: 1 } },
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.masks).toHaveLength(1);
  });

  it('throws SegmentationProviderError with code provider_failed on failed status', async () => {
    mockFetch
      .mockResolvedValueOnce(modelVersion('v'))
      .mockResolvedValueOnce(ok({ id: 'p', status: 'failed', error: 'bad input' }));
    await expect(
      provider.segment({ modelId: 'meta/sam-2', image: await sourceImage(), mode: 'automatic' }),
    ).rejects.toMatchObject({ name: 'SegmentationProviderError', code: 'provider_failed' });
  });

  it('applies minScore and maxMasks filtering', async () => {
    const url = await maskDataUrl();
    mockFetch
      .mockResolvedValueOnce(modelVersion('v'))
      .mockResolvedValueOnce(ok({
        id: 'p', status: 'succeeded',
        output: { masks: [{ mask: url, score: 0.9 }, { mask: url, score: 0.2 }, { mask: url, score: 0.95 }] },
      }));
    const result = await provider.segment({
      modelId: 'meta/sam-2', image: await sourceImage(), mode: 'automatic', minScore: 0.5, maxMasks: 1,
    });
    expect(result.masks).toHaveLength(1);
    expect(result.masks[0].score).toBeCloseTo(0.9);
    expect(result.masks[0].index).toBe(0);
  });

  it('rejects a modelId without an owner/name slash before any fetch', async () => {
    await expect(
      provider.segment({ modelId: 'sam2', image: await sourceImage(), mode: 'automatic' }),
    ).rejects.toMatchObject({ name: 'SegmentationProviderError', code: 'invalid_request' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
