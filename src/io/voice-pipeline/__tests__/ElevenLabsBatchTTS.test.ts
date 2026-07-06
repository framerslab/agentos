import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { ElevenLabsBatchTTS } from '../providers/ElevenLabsBatchTTS.js';

describe('ElevenLabsBatchTTS', () => {
  let tts: ElevenLabsBatchTTS;

  beforeEach(() => {
    mockFetch.mockReset();
    tts = new ElevenLabsBatchTTS({ apiKey: 'test-key', voiceId: 'voice-123' });
  });

  it('has correct providerId', () => {
    expect(tts.providerId).toBe('elevenlabs-batch');
  });

  it('synthesize calls ElevenLabs REST endpoint', async () => {
    const fakeAudio = Buffer.from('fake-audio');
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio.buffer),
    });

    const result = await tts.synthesize('Hello world');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-123');
    expect(opts.headers['xi-api-key']).toBe('test-key');
    const body = JSON.parse(opts.body);
    expect(body.text).toBe('Hello world');
    expect(body.model_id).toBe('eleven_multilingual_v2');
    expect(result.provider).toBe('elevenlabs-batch');
    expect(result.format).toBe('mp3');
  });

  it('passes voice settings from providerOptions', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from('audio').buffer),
    });

    await tts.synthesize('Test', {
      providerOptions: { stability: 0.8, similarityBoost: 0.9 },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.voice_settings.stability).toBe(0.8);
    expect(body.voice_settings.similarity_boost).toBe(0.9);
  });

  it('overrides voiceId from config.voice', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from('a').buffer),
    });

    await tts.synthesize('Hi', { voice: 'other-voice' });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/other-voice');
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    await expect(tts.synthesize('Test')).rejects.toThrow('ElevenLabs TTS failed: 401');
  });

  it('passes an AbortSignal to fetch so hung calls cannot block forever', async () => {
    // Regression for 2026-05-18: a slow / unhealthy ElevenLabs response
    // wedged the SentenceChunkedTTSManager's flush for ~5 minutes,
    // which in turn blocked the narrator turn pipeline (every
    // generation took 5+ minutes for affected sessions). The fix
    // attaches an AbortSignal.timeout(...) to the synthesize fetch
    // so a single hung call aborts in bounded time and the fallback
    // chain can take over.
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from('a').buffer),
    });

    await tts.synthesize('Hi');

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps the first-class expressiveness field into voice_settings (speed included) and reports what it applied', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from('audio').buffer),
    });

    const result = await tts.synthesize('Test', {
      expressiveness: { stability: 0.3, similarityBoost: 0.9, style: 0.6, speed: 1.15 },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.voice_settings.stability).toBe(0.3);
    expect(body.voice_settings.similarity_boost).toBe(0.9);
    expect(body.voice_settings.style).toBe(0.6);
    expect(body.voice_settings.speed).toBe(1.15);
    expect(result.appliedExpressiveness).toEqual(
      expect.arrayContaining(['stability', 'similarityBoost', 'style', 'speed'])
    );
  });

  it('clamps expressiveness speed into the ElevenLabs-supported band (0.7-1.2)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from('audio').buffer),
    });

    await tts.synthesize('Fast', { expressiveness: { speed: 1.5 } });
    await tts.synthesize('Slow', { expressiveness: { speed: 0.4 } });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).voice_settings.speed).toBe(1.2);
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).voice_settings.speed).toBe(0.7);
  });

  it('prefers explicit top-level speed, then expressiveness, then providerOptions', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from('audio').buffer),
    });

    await tts.synthesize('A', {
      speed: 1.1,
      expressiveness: { speed: 0.9 },
      providerOptions: { speed: 0.8 },
    });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).voice_settings.speed).toBe(1.1);
  });

  it('omits voice_settings.speed and reports nothing when no caller values are provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from('audio').buffer),
    });

    const result = await tts.synthesize('Plain');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.voice_settings.speed).toBeUndefined();
    expect(result.appliedExpressiveness).toBeUndefined();
  });
});
