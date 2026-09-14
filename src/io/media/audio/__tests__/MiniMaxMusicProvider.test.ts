import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MiniMaxMusicProvider } from '../providers/MiniMaxMusicProvider.js';

function mockResponse(body: unknown, ok = true, status = 200, statusText = 'OK') {
  return {
    ok,
    status,
    statusText,
    json: vi.fn(async () => body),
  };
}

describe('MiniMaxMusicProvider', () => {
  let provider: MiniMaxMusicProvider;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new MiniMaxMusicProvider();
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('generates Music 3.0 with the global endpoint and URL output', async () => {
    await provider.initialize({ apiKey: 'minimax-test-key' });
    fetchSpy.mockResolvedValueOnce(mockResponse({
      data: { audio: 'https://cdn.example.com/music.mp3', status: 2 },
      trace_id: 'trace-global',
      extra_info: { music_duration: 12_500, music_sample_rate: 44_100 },
    }));

    const result = await provider.generateMusic({ prompt: 'Cinematic ambient music' });

    expect(result.modelId).toBe('music-3.0');
    expect(result.audio[0]).toMatchObject({
      url: 'https://cdn.example.com/music.mp3',
      mimeType: 'audio/mpeg',
      durationSec: 12.5,
      sampleRate: 44_100,
    });

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.minimax.io/v1/music_generation');
    expect(options.headers.Authorization).toBe('Bearer minimax-test-key');
    expect(JSON.parse(options.body)).toMatchObject({
      model: 'music-3.0',
      prompt: 'Cinematic ambient music',
      stream: false,
      output_format: 'url',
      lyrics_optimizer: true,
      is_instrumental: false,
      audio_setting: { format: 'mp3' },
    });
  });

  it('uses the China endpoint and converts hex audio to base64', async () => {
    await provider.initialize({ apiKey: 'minimax-test-key' });
    fetchSpy.mockResolvedValueOnce(mockResponse({
      data: { audio: '000102ff', status: 2 },
      base_resp: { status_code: 0, status_msg: 'success' },
    }));

    const result = await provider.generateMusic({
      prompt: 'Bright pop song',
      outputFormat: 'wav',
      providerOptions: {
        region: 'china',
        responseFormat: 'hex',
        lyrics: '[Verse]\nA new day begins',
        lyricsOptimizer: false,
        aigcWatermark: true,
        audioSetting: { sample_rate: 44_100, bitrate: 256_000 },
      },
    });

    expect(result.audio[0]).toMatchObject({
      base64: 'AAEC/w==',
      mimeType: 'audio/wav',
    });

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.minimaxi.com/v1/music_generation');
    expect(JSON.parse(options.body)).toMatchObject({
      output_format: 'hex',
      lyrics: '[Verse]\nA new day begins',
      lyrics_optimizer: false,
      aigc_watermark: true,
      audio_setting: { sample_rate: 44_100, bitrate: 256_000, format: 'wav' },
    });
  });

  it('passes exactly one reference input for music cover generation', async () => {
    await provider.initialize({ apiKey: 'minimax-test-key', defaultModelId: 'music-cover' });
    fetchSpy.mockResolvedValueOnce(mockResponse({
      data: { audio: 'https://cdn.example.com/cover.mp3', status: 2 },
      base_resp: { status_code: 0, status_msg: 'success' },
    }));

    await provider.generateMusic({
      prompt: 'Acoustic folk cover',
      providerOptions: { audioUrl: 'https://example.com/reference.wav' },
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: 'music-cover',
      audio_url: 'https://example.com/reference.wav',
    });
    expect(body).not.toHaveProperty('lyrics_optimizer');
    expect(body).not.toHaveProperty('is_instrumental');
  });

  it('requires lyrics when music cover uses a coverFeatureId', async () => {
    await provider.initialize({ apiKey: 'minimax-test-key', defaultModelId: 'music-cover' });

    await expect(provider.generateMusic({
      prompt: 'Acoustic folk cover',
      providerOptions: { coverFeatureId: 'feature-123' },
    })).rejects.toThrow(
      'MiniMax music coverFeatureId requires lyrics between 10 and 1000 characters.',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only cover references', async () => {
    await provider.initialize({ apiKey: 'minimax-test-key', defaultModelId: 'music-cover' });

    await expect(provider.generateMusic({
      prompt: 'Acoustic folk cover',
      providerOptions: { audioUrl: '   ' },
    })).rejects.toThrow(
      'MiniMax music cover requires exactly one of audioUrl, audioBase64, or coverFeatureId.',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not optimize lyrics for instrumental generation', async () => {
    await provider.initialize({ apiKey: 'minimax-test-key' });
    fetchSpy.mockResolvedValueOnce(mockResponse({
      data: { audio: 'https://cdn.example.com/instrumental.mp3', status: 2 },
      base_resp: { status_code: 0, status_msg: 'success' },
    }));

    await provider.generateMusic({
      prompt: 'Instrumental post-rock crescendo',
      providerOptions: { isInstrumental: true },
    });

    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({
      lyrics_optimizer: false,
      is_instrumental: true,
    });
  });

  it('surfaces API errors from base_resp', async () => {
    await provider.initialize({ apiKey: 'minimax-test-key' });
    fetchSpy.mockResolvedValueOnce(mockResponse({
      base_resp: { status_code: 1002, status_msg: 'invalid request' },
    }));

    await expect(provider.generateMusic({ prompt: 'test' }))
      .rejects.toThrow('MiniMax music generation failed (200): invalid request');
  });

  it('preserves HTTP diagnostics for non-JSON error responses', async () => {
    await provider.initialize({ apiKey: 'minimax-test-key' });
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: vi.fn(async () => { throw new Error('not JSON'); }),
    });

    await expect(provider.generateMusic({ prompt: 'test' }))
      .rejects.toThrow('MiniMax music generation failed (502): Bad Gateway');
  });

  it('rejects unsupported audio formats before sending a request', async () => {
    await provider.initialize({ apiKey: 'minimax-test-key' });

    await expect(provider.generateMusic({ prompt: 'test', outputFormat: 'flac' }))
      .rejects.toThrow('MiniMax music audio format must be "mp3", "wav", or "pcm".');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects unsupported response formats before sending a request', async () => {
    await provider.initialize({ apiKey: 'minimax-test-key' });

    await expect(provider.generateMusic({
      prompt: 'test',
      providerOptions: { responseFormat: 'foo' },
    })).rejects.toThrow('MiniMax music responseFormat must be "url" or "hex".');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects unsupported regions before resolving an endpoint', async () => {
    await provider.initialize({ apiKey: 'minimax-test-key', baseURL: 'https://proxy.example.com' });

    await expect(provider.generateMusic({
      prompt: 'test',
      providerOptions: { region: 'cn' },
    })).rejects.toThrow('MiniMax music region must be "global" or "china".');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
