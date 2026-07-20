import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateSFX } from '../generateSFX.js';

vi.mock('../../../media/audio/index.js', () => {
  const providers = new Map<string, any>();

  const defaultModelFor = (providerId: string): string => {
    switch (providerId) {
      case 'stable-audio':
        return 'stable-audio-open-1.0';
      case 'audiogen-local':
        return 'Xenova/audiogen-medium';
      case 'replicate-audio':
        return 'meta/audiogen';
      case 'fal-audio':
        return 'fal-ai/stable-audio';
      case 'elevenlabs-sfx':
      default:
        return 'eleven_sound_generation';
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
      generateMusic: supportsMusic
        ? vi.fn().mockImplementation(async (request: Record<string, unknown>) => ({
            created: Math.floor(Date.now() / 1000),
            modelId: (request.modelId as string | undefined) ?? provider.defaultModelId,
            providerId,
            audio: [{ url: `https://${providerId}.example.com/music.mp3`, mimeType: 'audio/mpeg' }],
            usage: { totalAudioClips: 1 },
          }))
        : vi.fn(),
      generateSFX: supportsSFX
        ? vi.fn().mockImplementation(async (request: Record<string, unknown>) => ({
            created: Math.floor(Date.now() / 1000),
            modelId: (request.modelId as string | undefined) ?? provider.defaultModelId,
            providerId,
            audio: [
              {
                url: `https://${providerId}.example.com/sfx.mp3`,
                mimeType: 'audio/mpeg',
                durationSec: 3,
              },
            ],
            usage: { totalAudioClips: 1, totalCostUSD: 0.01 },
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

describe('generateSFX', () => {
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

  it('generates an SFX clip with explicit provider and API key', async () => {
    const onProgress = vi.fn();
    const result = await generateSFX({
      prompt: 'Thunder crack followed by heavy rain on a tin roof',
      provider: 'elevenlabs-sfx',
      apiKey: 'test-elevenlabs-key',
      durationSec: 5,
      timeoutMs: 12_345,
      onProgress,
    });

    const { __getMockProvider } = await import('../../../io/media/audio/index.js') as any;
    expect(result.provider).toBe('elevenlabs-sfx');
    expect(result.model).toBe('eleven_sound_generation');
    expect(result.audio).toHaveLength(1);
    expect(result.audio[0].url).toContain('elevenlabs-sfx.example.com');
    expect(result.usage).toEqual({ totalAudioClips: 1, totalCostUSD: 0.01 });
    expect(__getMockProvider('elevenlabs-sfx').initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-elevenlabs-key',
        timeoutMs: 12_345,
      }),
    );
    expect(onProgress.mock.calls.map(([event]) => event.status)).toEqual([
      'queued',
      'processing',
      'complete',
    ]);
  });

  it('uses provider preferences to block the default SFX provider during auto-detection', async () => {
    process.env.ELEVENLABS_API_KEY = 'env-elevenlabs-key';
    process.env.STABILITY_API_KEY = 'env-stability-key';

    const result = await generateSFX({
      prompt: 'Glass shattering on marble floor',
      providerPreferences: {
        blocked: ['elevenlabs-sfx'],
      },
    });

    expect(result.provider).toBe('stable-audio');
    expect(result.audio[0].url).toContain('stable-audio.example.com');
  });

  it('auto-detects provider from ELEVENLABS_API_KEY env var', async () => {
    process.env.ELEVENLABS_API_KEY = 'env-elevenlabs-key';

    const result = await generateSFX({
      prompt: 'Door creaking open slowly',
    });

    expect(result.provider).toBe('elevenlabs-sfx');
    expect(result.audio).toHaveLength(1);
  });

  it('throws when no provider is configured', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.STABILITY_API_KEY;
    delete process.env.REPLICATE_API_TOKEN;
    delete process.env.FAL_API_KEY;

    const mod = await import('../../../io/media/audio/index.js') as any;
    mod.hasAudioProviderFactory.mockReturnValue(false);

    await expect(
      generateSFX({ prompt: 'This should fail' }),
    ).rejects.toThrow(/No SFX provider configured/);
  });
});
