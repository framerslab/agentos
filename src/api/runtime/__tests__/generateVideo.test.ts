import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateVideo } from '../generateVideo.js';

vi.mock('../../../io/media/video/index.js', () => {
  const providers = new Map<string, any>();

  const defaultModelFor = (providerId: string): string => {
    switch (providerId) {
      case 'replicate':
        return 'klingai/kling-v1';
      case 'fal':
        return 'kling-video/v1';
      case 'runway':
      default:
        return 'gen3a_turbo';
    }
  };

  const getMockProvider = (providerId: string): any => {
    const existing = providers.get(providerId);
    if (existing) {
      return existing;
    }

    const provider: any = {
      providerId,
      isInitialized: true,
      defaultModelId: defaultModelFor(providerId),
      initialize: vi.fn().mockImplementation(async (config: Record<string, unknown>) => {
        if (typeof config.defaultModelId === 'string' && config.defaultModelId) {
          provider.defaultModelId = config.defaultModelId;
        }
      }),
      generateVideo: vi.fn().mockImplementation(async (request: Record<string, unknown>) => ({
        created: Date.now(),
        modelId: (request.modelId as string | undefined) ?? provider.defaultModelId,
        providerId,
        videos: [
          {
            url: `https://${providerId}.example.com/video.mp4`,
            durationSec: 5,
            mimeType: 'video/mp4',
          },
        ],
        usage: { totalVideos: 1, totalCostUSD: 0.25 },
      })),
      imageToVideo: vi.fn().mockImplementation(async (request: Record<string, unknown>) => ({
        created: Date.now(),
        modelId: (request.modelId as string | undefined) ?? provider.defaultModelId,
        providerId,
        videos: [
          {
            url: `https://${providerId}.example.com/i2v.mp4`,
            durationSec: 4,
            mimeType: 'video/mp4',
          },
        ],
        usage: { totalVideos: 1, totalCostUSD: 0.30 },
      })),
      supports: vi.fn((capability: 'text-to-video' | 'image-to-video') => {
        if (capability === 'text-to-video') {
          return true;
        }
        return typeof provider.imageToVideo === 'function';
      }),
    };

    providers.set(providerId, provider);
    return provider;
  };

  return {
    createVideoProvider: vi.fn((providerId: string) => getMockProvider(providerId)),
    hasVideoProviderFactory: vi.fn().mockReturnValue(true),
    __getMockProvider: getMockProvider,
    __resetMockProviders: () => providers.clear(),
  };
});

vi.mock('../../observability.js', () => ({
  attachUsageAttributes: vi.fn(),
  attachGenAiAttributes: vi.fn(),
  toTurnMetricUsage: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../../safety/evaluation/observability/otel.js', () => ({
  withAgentOSSpan: vi.fn((_name: string, fn: (span: null) => unknown) => fn(null)),
  recordAgentOSTurnMetrics: vi.fn(),
}));

vi.mock('../usageLedger.js', () => ({
  recordAgentOSUsage: vi.fn().mockResolvedValue(undefined),
}));

describe('generateVideo', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    const mod = await import('../../../io/media/video/index.js') as any;
    mod.__resetMockProviders();
    mod.hasVideoProviderFactory.mockReturnValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('generates a text-to-video with explicit provider and API key', async () => {
    const onProgress = vi.fn();
    const result = await generateVideo({
      prompt: 'A drone flying over a misty forest at sunrise',
      provider: 'runway',
      apiKey: 'test-runway-key',
      durationSec: 5,
      timeoutMs: 12_345,
      onProgress,
    });

    const { __getMockProvider } = await import('../../../io/media/video/index.js') as any;
    expect(result.provider).toBe('runway');
    expect(result.model).toBe('gen3a_turbo');
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0].url).toContain('runway.example.com');
    expect(result.usage).toEqual({ totalVideos: 1, totalCostUSD: 0.25 });
    expect(__getMockProvider('runway').initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-runway-key',
        timeoutMs: 12_345,
      }),
    );
    expect(onProgress.mock.calls.map(([event]) => event.status)).toEqual([
      'queued',
      'processing',
      'complete',
    ]);
  });

  it('generates an image-to-video when opts.image is provided', async () => {
    const imageBuffer = Buffer.from('fake-image-data');

    const result = await generateVideo({
      prompt: 'Camera slowly zooms out',
      image: imageBuffer,
      provider: 'runway',
      apiKey: 'test-runway-key',
    });

    expect(result.provider).toBe('runway');
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0].url).toContain('i2v.mp4');
    expect(result.usage?.totalCostUSD).toBe(0.30);

    const { __getMockProvider } = await import('../../../io/media/video/index.js') as any;
    expect(__getMockProvider('runway').imageToVideo).toHaveBeenCalled();
  });

  it('sends an image given as a URL to image-to-video with resolution, reference images and provider options', async () => {
    const providerOptions = { fal: { end_image_url: 'https://cdn.example.com/end.png' } };

    await generateVideo({
      prompt: 'The lantern swings',
      image: 'https://cdn.example.com/start.png',
      resolution: '768P',
      referenceImages: ['https://cdn.example.com/ref.png'],
      providerOptions,
      provider: 'fal',
      apiKey: 'test-fal-key',
      timeoutMs: 90_000,
    } as any);

    const { __getMockProvider } = await import('../../../io/media/video/index.js') as any;
    const fal = __getMockProvider('fal');
    expect(fal.generateVideo).not.toHaveBeenCalled();
    expect(fal.imageToVideo).toHaveBeenCalledTimes(1);
    const request = fal.imageToVideo.mock.calls[0][0];
    expect(request).toMatchObject({
      prompt: 'The lantern swings',
      image: 'https://cdn.example.com/start.png',
      resolution: '768P',
      referenceImages: ['https://cdn.example.com/ref.png'],
      providerOptions,
    });
    // The call names no model, so the provider picks its image-to-video default.
    expect(request.modelId).toBeUndefined();
    // The timeout goes to initialize(), never into the model inputs.
    expect(fal.initialize).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 90_000 }));
  });

  it('passes reference images and provider options to text-to-video and keeps the timeout out of the provider options', async () => {
    const reference = Buffer.from('ref-bytes');

    await generateVideo({
      prompt: 'The same cat in three rooms',
      model: 'google/veo-3.1',
      referenceImages: [reference],
      providerOptions: { generate_audio: false },
      provider: 'replicate',
      apiKey: 'test-replicate-key',
      timeoutMs: 9_000,
    } as any);

    const { __getMockProvider } = await import('../../../io/media/video/index.js') as any;
    const request = __getMockProvider('replicate').generateVideo.mock.calls[0][0];
    expect(request.modelId).toBe('google/veo-3.1');
    expect(request.referenceImages).toEqual([reference]);
    expect(request.providerOptions).toEqual({ generate_audio: false });
  });

  it('reads GEMINI_API_KEY for provider "gemini" and never picks gemini from the environment alone', async () => {
    delete process.env.RUNWAY_API_KEY;
    delete process.env.REPLICATE_API_TOKEN;
    delete process.env.FAL_API_KEY;
    process.env.GEMINI_API_KEY = 'env-gemini-key';

    const result = await generateVideo({ prompt: 'A marble rolls', provider: 'gemini' });

    const { __getMockProvider } = await import('../../../io/media/video/index.js') as any;
    expect(result.provider).toBe('gemini');
    expect(__getMockProvider('gemini').initialize).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'env-gemini-key' }),
    );

    await expect(generateVideo({ prompt: 'A marble rolls' })).rejects.toThrow(/No video provider configured/);
  });

  it('uses provider preferences to select the weighted auto-detected primary provider', async () => {
    process.env.RUNWAY_API_KEY = 'env-runway-key';
    process.env.REPLICATE_API_TOKEN = 'env-replicate-key';

    const result = await generateVideo({
      prompt: 'A sunset over the ocean',
      providerPreferences: {
        weights: {
          runway: 0,
          replicate: 1,
        },
      },
    });

    expect(result.provider).toBe('replicate');
    expect(result.videos[0].url).toContain('replicate.example.com');
  });

  it('throws a friendly error when image-to-video is unsupported', async () => {
    const mod = await import('../../../io/media/video/index.js') as any;
    const provider = mod.__getMockProvider('runway');
    provider.imageToVideo = undefined;
    provider.supports.mockImplementation((capability: 'text-to-video' | 'image-to-video') => {
      return capability === 'text-to-video';
    });

    await expect(
      generateVideo({
        prompt: 'Camera slowly zooms out',
        image: Buffer.from('fake-image-data'),
        provider: 'runway',
        apiKey: 'test-runway-key',
      }),
    ).rejects.toThrow(/does not support image-to-video generation/);
  });

  it('throws when no provider is configured', async () => {
    delete process.env.RUNWAY_API_KEY;
    delete process.env.REPLICATE_API_TOKEN;
    delete process.env.FAL_API_KEY;

    const mod = await import('../../../io/media/video/index.js') as any;
    mod.hasVideoProviderFactory.mockReturnValue(false);

    await expect(
      generateVideo({ prompt: 'This should fail' }),
    ).rejects.toThrow(/No video provider configured/);
  });
});
