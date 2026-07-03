import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplicateImageProvider } from '../providers/ReplicateImageProvider.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockSuccess(output: unknown = ['https://example.com/img.png']) {
  return { ok: true, json: async () => ({ id: 'p1', status: 'succeeded', output }), text: async () => '', headers: new Headers() };
}

describe('ReplicateImageProvider — Character Consistency', () => {
  let provider: ReplicateImageProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new ReplicateImageProvider();
    await provider.initialize({ apiKey: 'test-key' });
  });

  it('auto-selects version-pinned Pulid when consistencyMode is strict and no model specified', async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await provider.generateImage({
      prompt: 'portrait',
      referenceImageUrl: 'https://ref.test/face.png',
      consistencyMode: 'strict',
    });

    // Community model: the auto-route must carry an inline version and take
    // the LEGACY /predictions endpoint — the modern /models endpoint 422s
    // for unversioned community models.
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/predictions');
    expect(url).not.toContain('/models/');
    const body = JSON.parse(init.body);
    expect(body.version).toContain('zsxkib/pulid:');
    expect(body.input.main_face_image).toBe('https://ref.test/face.png');
  });

  it('maps referenceImageUrl to main_face_image for Pulid models', async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await provider.generateImage({
      modelId: 'zsxkib/pulid',
      prompt: 'portrait',
      referenceImageUrl: 'https://ref.test/face.png',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input.main_face_image).toBe('https://ref.test/face.png');
  });

  it('maps referenceImageUrl to image for Flux Redux models', async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await provider.generateImage({
      modelId: 'black-forest-labs/flux-redux-dev',
      prompt: 'style transfer',
      referenceImageUrl: 'https://ref.test/style.png',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input.image).toBe('https://ref.test/style.png');
  });

  it('sets image_strength based on consistencyMode for standard Flux models', async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await provider.generateImage({
      modelId: 'black-forest-labs/flux-dev',
      prompt: 'portrait',
      referenceImageUrl: 'https://ref.test/face.png',
      consistencyMode: 'loose',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input.image).toBe('https://ref.test/face.png');
    expect(body.input.image_strength).toBe(0.3);
  });

  it('uses balanced strength (0.6) by default', async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await provider.generateImage({
      modelId: 'black-forest-labs/flux-dev',
      prompt: 'portrait',
      referenceImageUrl: 'https://ref.test/face.png',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input.image_strength).toBe(0.6);
  });

  it('maps controlImage to control_image for Canny model', async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await provider.generateImage({
      modelId: 'black-forest-labs/flux-canny-dev',
      prompt: 'guided generation',
      providerOptions: {
        replicate: { controlImage: 'https://ref.test/edges.png' },
      },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input.control_image).toBe('https://ref.test/edges.png');
  });

  it('auto-routes to Canny model when controlType is canny and no model set', async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await provider.generateImage({
      prompt: 'edge-guided',
      providerOptions: {
        replicate: {
          controlImage: 'https://ref.test/edges.png',
          controlType: 'canny' as const,
        },
      },
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('flux-canny-dev');
  });

  it('ignores referenceImageUrl when not provided', async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await provider.generateImage({ prompt: 'no ref' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input.main_face_image).toBeUndefined();
    expect(body.input.image).toBeUndefined();
    expect(body.input.image_strength).toBeUndefined();
  });

  it('maps referenceImageUrl to input_images array for Flux 2 models', async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await provider.generateImage({
      modelId: 'black-forest-labs/flux-2-pro',
      prompt: 'portrait',
      referenceImageUrl: 'https://ref.test/face.png',
      consistencyMode: 'strict',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input.input_images).toEqual(['https://ref.test/face.png']);
    // Flux 2 rejects the SDXL-style pair with a 422 — must not be emitted.
    expect(body.input.image).toBeUndefined();
    expect(body.input.image_strength).toBeUndefined();
  });

  it('respects a caller-provided input_images array for Flux 2 models', async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await provider.generateImage({
      modelId: 'black-forest-labs/flux-2-max',
      prompt: 'portrait',
      referenceImageUrl: 'https://ref.test/face.png',
      providerOptions: {
        replicate: { input: { input_images: ['https://ref.test/a.png', 'https://ref.test/b.png'] } },
      },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input.input_images).toEqual(['https://ref.test/a.png', 'https://ref.test/b.png']);
  });

  it('maps referenceImageUrl to input_image for Kontext models on generate', async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await provider.generateImage({
      modelId: 'black-forest-labs/flux-kontext-max',
      prompt: 'restyle',
      referenceImageUrl: 'https://ref.test/base.png',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input.input_image).toBe('https://ref.test/base.png');
    expect(body.input.image).toBeUndefined();
    expect(body.input.image_strength).toBeUndefined();
  });

  it('honors providerOptions.extraBody.version on generate via the legacy endpoint', async () => {
    mockFetch.mockResolvedValueOnce(mockSuccess());

    await provider.generateImage({
      modelId: 'zsxkib/pulid',
      prompt: 'portrait',
      referenceImageUrl: 'https://ref.test/face.png',
      providerOptions: {
        replicate: { extraBody: { version: 'abc123def456' } },
      },
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/predictions');
    expect(url).not.toContain('/models/');
    const body = JSON.parse(init.body);
    expect(body.version).toBe('abc123def456');
    expect(body.input.main_face_image).toBe('https://ref.test/face.png');
  });
});
