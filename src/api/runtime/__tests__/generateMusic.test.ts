import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateMusic } from '../generateMusic.js';

vi.mock('../../../media/audio/index.js', () => {
  const providers = new Map<string, any>();

  const defaultModelFor = (providerId: string): string => {
    switch (providerId) {
      case 'minimax-music':
        return 'music-3.0';
      case 'stable-audio':
        return 'stable-audio-open-1.0';
      case 'udio':
        return 'udio/udio';
      case 'musicgen-local':
        return 'Xenova/musicgen-small';
      case 'replicate-audio':
        return 'meta/musicgen';
      case 'fal-audio':
        return 'fal-ai/stable-audio';
      case 'suno':
      default:
        return 'suno-ai/suno';
    }
  };

  const getMockProvider = (providerId: string): any => {
    const existing = providers.get(providerId);
    if (existing) {
      return existing;
    }

    const supportsMusic = providerId !== 'audiogen-local' && providerId !== 'elevenlabs-sfx';
    const supportsSFX = providerId !== 'suno' && providerId !== 'udio' && providerId !== 'musicgen-local';

    const provider: any = {
      providerId,
      isInitialized: true,
      defaultModelId: defaultModelFor(providerId),
      initialize: vi.fn().mockImplementation(async (config: Record<string, unknown>) => {
        if (typeof config.defaultModelId === 'string' && config.defaultModelId) {
          provider.defaultModelId = config.defaultModelId;
        }
      }),
      generateMusic: vi.fn().mockImplementation(async (request: Record<string, unknown>) => ({
        created: Math.floor(Date.now() / 1000),
        modelId: (request.modelId as string | undefined) ?? provider.defaultModelId,
        providerId,
        audio: [
          {
            url: `https://${providerId}.example.com/audio.mp3`,
            mimeType: 'audio/mpeg',
            durationSec: 60,
          },
        ],
        usage: { totalAudioClips: 1, totalCostUSD: 0.05 },
      })),
      generateSFX: supportsSFX
        ? vi.fn().mockImplementation(async (request: Record<string, unknown>) => ({
            created: Math.floor(Date.now() / 1000),
            modelId: (request.modelId as string | undefined) ?? provider.defaultModelId,
            providerId,
            audio: [{ url: `https://${providerId}.example.com/sfx.mp3`, mimeType: 'audio/mpeg' }],
            usage: { totalAudioClips: 1 },
          }))
        : undefined,
      supports: vi.fn((capability: 'music' | 'sfx') => {
        return capability === 'music' ? supportsMusic : supportsSFX;
      }),
    };

    providers.set(providerId, provider);
    return provider;
  };

  return {
    createAudioProvider: vi.fn((providerId: string) => getMockProvider(providerId)),
    hasAudioProviderFactory: vi.fn().mockReturnValue(true),
    __getMockProvider: getMockProvider,
    __resetMockProviders: () => providers.clear(),
  };
});

vi.mock('../../observability.js', () => ({
  attachUsageAttributes: vi.fn(),
  attachGenAiAttributes: vi.fn(),
  toTurnMetricUsage: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../../evaluation/observability/otel.js', () => ({
  withAgentOSSpan: vi.fn((_name: string, fn: (span: null) => unknown) => fn(null)),
  recordAgentOSTurnMetrics: vi.fn(),
}));

vi.mock('../usageLedger.js', () => ({
  recordAgentOSUsage: vi.fn().mockResolvedValue(undefined),
}));

describe('generateMusic', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    const mod = await import('../../../io/media/audio/index.js') as any;
    mod.__resetMockProviders();
    mod.hasAudioProviderFactory.mockReturnValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('generates music with explicit provider and API key', async () => {
    const onProgress = vi.fn();
    const result = await generateMusic({
      prompt: 'Upbeat lo-fi hip hop beat with vinyl crackle and mellow piano',
      provider: 'suno',
      apiKey: 'test-suno-key',
      durationSec: 60,
      timeoutMs: 12_345,
      onProgress,
    });

    const { __getMockProvider } = await import('../../../io/media/audio/index.js') as any;
    expect(result.provider).toBe('suno');
    expect(result.model).toBe('suno-ai/suno');
    expect(result.audio).toHaveLength(1);
    expect(result.audio[0].url).toContain('suno.example.com');
    expect(result.usage).toEqual({ totalAudioClips: 1, totalCostUSD: 0.05 });
    expect(__getMockProvider('suno').initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-suno-key',
        timeoutMs: 12_345,
      }),
    );
    expect(onProgress.mock.calls.map(([event]) => event.status)).toEqual([
      'queued',
      'processing',
      'complete',
    ]);
  });

  it('uses provider preferences to block the default auto-detected primary provider', async () => {
    process.env.SUNO_API_KEY = 'env-suno-key';
    process.env.STABILITY_API_KEY = 'env-stability-key';

    const result = await generateMusic({
      prompt: 'Ambient piano loop',
      providerPreferences: {
        blocked: ['suno'],
      },
    });

    expect(result.provider).toBe('stable-audio');
    expect(result.audio[0].url).toContain('stable-audio.example.com');
  });

  it('auto-detects provider from SUNO_API_KEY env var', async () => {
    process.env.SUNO_API_KEY = 'env-suno-key';

    const result = await generateMusic({
      prompt: 'Electronic dance music',
    });

    expect(result.provider).toBe('suno');
    expect(result.audio).toHaveLength(1);
  });

  it('auto-detects provider from MINIMAX_API_KEY env var', async () => {
    process.env.MINIMAX_API_KEY = 'env-minimax-key';

    const result = await generateMusic({
      prompt: 'Cinematic electronic music',
    });

    expect(result.provider).toBe('minimax-music');
    expect(result.model).toBe('music-3.0');
  });

  it('throws when no provider is configured', async () => {
    delete process.env.SUNO_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.UDIO_API_KEY;
    delete process.env.STABILITY_API_KEY;
    delete process.env.REPLICATE_API_TOKEN;
    delete process.env.FAL_API_KEY;

    const mod = await import('../../../io/media/audio/index.js') as any;
    mod.hasAudioProviderFactory.mockReturnValue(false);

    await expect(
      generateMusic({ prompt: 'This should fail' }),
    ).rejects.toThrow(/No music provider configured/);
  });
});
