import { describe, it, expect } from 'vitest';
import {
  createVoiceProvidersFromEnv,
  NoVoiceProvidersAvailableError,
} from '../env-constructor.js';

describe('createVoiceProvidersFromEnv', () => {
  it('builds chains with only ELEVENLABS_API_KEY', () => {
    const { stt, tts } = createVoiceProvidersFromEnv({
      env: { ELEVENLABS_API_KEY: 'el' },
    });
    expect(stt.providers.map((p) => p.providerId)).toContain(
      'elevenlabs-streaming-stt'
    );
    expect(tts.providers.map((p) => p.providerId)).toContain(
      'elevenlabs-streaming'
    );
  });

  it('prefers Deepgram for STT when both keys present', () => {
    const { stt } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'dg', ELEVENLABS_API_KEY: 'el' },
    });
    const ids = stt.providers.map((p) => p.providerId);
    expect(ids.indexOf('deepgram-streaming')).toBeLessThan(
      ids.indexOf('elevenlabs-streaming-stt')
    );
  });

  it('throws when no viable keys', () => {
    expect(() => createVoiceProvidersFromEnv({ env: {} })).toThrow(
      NoVoiceProvidersAvailableError
    );
  });

  it('NoVoiceProvidersAvailableError names every checked env var', () => {
    try {
      createVoiceProvidersFromEnv({ env: {} });
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('DEEPGRAM_API_KEY');
      expect(msg).toContain('ELEVENLABS_API_KEY');
      expect(msg).toContain('OPENAI_API_KEY');
    }
  });

  it('shared breaker across STT + TTS chains', () => {
    const { stt, tts, breaker } = createVoiceProvidersFromEnv({
      env: { ELEVENLABS_API_KEY: 'el' },
    });
    expect(breaker).toBeDefined();
    // Internal assertion: both chains reference the same breaker instance.
    expect((stt as unknown as { opts: { breaker: unknown } }).opts.breaker).toBe(
      breaker
    );
    expect((tts as unknown as { opts: { breaker: unknown } }).opts.breaker).toBe(
      breaker
    );
  });

  it('includes OpenAI Realtime TTS + batch fallback when OPENAI_API_KEY is set', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { OPENAI_API_KEY: 'op', ELEVENLABS_API_KEY: 'el' },
    });
    const ids = tts.providers.map((p) => p.providerId);
    expect(ids).toContain('openai-realtime');
    expect(ids.some((id) => id.startsWith('openai-tts'))).toBe(true);
  });

  it('enables failover modes by default', () => {
    const { stt, tts } = createVoiceProvidersFromEnv({
      env: { ELEVENLABS_API_KEY: 'el' },
    });
    expect(
      (stt as unknown as { opts: { enableMidUtteranceFailover?: boolean } })
        .opts.enableMidUtteranceFailover
    ).toBe(true);
    expect(
      (tts as unknown as { opts: { enableMidSynthesisFailover?: boolean } })
        .opts.enableMidSynthesisFailover
    ).toBe(true);
  });

  it('puts Deepgram Aura ahead of ElevenLabs streaming TTS by default', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'dg', ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'op' },
    });
    const ids = tts.providers.map((p) => p.providerId);
    expect(ids).toContain('deepgram-aura');
    expect(ids).toContain('elevenlabs-streaming');
    expect(ids.indexOf('deepgram-aura')).toBeLessThan(ids.indexOf('elevenlabs-streaming'));
  });

  it('puts ElevenLabs streaming TTS ahead of Aura when ttsPreference is elevenlabs', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'dg', ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'op' },
      ttsPreference: 'elevenlabs',
    });
    const ids = tts.providers.map((p) => p.providerId);
    expect(ids.indexOf('elevenlabs-streaming')).toBeLessThan(ids.indexOf('deepgram-aura'));
  });

  it('omits Aura TTS when no Deepgram key is set', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'op' },
    });
    expect(tts.providers.map((p) => p.providerId)).not.toContain('deepgram-aura');
  });
});

describe('cartesia + hume env wiring', () => {
  it('adds cartesia streaming when CARTESIA_API_KEY + voice id are present', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'd', CARTESIA_API_KEY: 'c', CARTESIA_VOICE_ID: 'v1' },
    });
    expect(tts.providers.map((p) => p.providerId)).toContain('cartesia-sonic-stream');
  });

  it('skips cartesia without a voice id (provider needs one)', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'd', CARTESIA_API_KEY: 'c' },
    });
    expect(tts.providers.map((p) => p.providerId)).not.toContain('cartesia-sonic-stream');
  });

  it('adds hume streaming when HUME_API_KEY is present', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'd', HUME_API_KEY: 'h' },
    });
    expect(tts.providers.map((p) => p.providerId)).toContain('hume-octave-stream');
  });

  it('key absence = absent from chain (no throw)', () => {
    const { tts } = createVoiceProvidersFromEnv({ env: { DEEPGRAM_API_KEY: 'd' } });
    const ids = tts.providers.map((p) => p.providerId);
    expect(ids).not.toContain('cartesia-sonic-stream');
    expect(ids).not.toContain('hume-octave-stream');
  });

  it("ttsPreference 'cartesia' promotes it to first-try", () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'd', CARTESIA_API_KEY: 'c', CARTESIA_VOICE_ID: 'v1' },
      ttsPreference: 'cartesia',
    });
    expect(tts.providers[0].providerId).toBe('cartesia-sonic-stream');
  });

  it("ttsPreference 'hume' promotes it to first-try", () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'd', HUME_API_KEY: 'h' },
      ttsPreference: 'hume',
    });
    expect(tts.providers[0].providerId).toBe('hume-octave-stream');
  });

  it('default incumbent ordering is unchanged when no new keys are set', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'd', ELEVENLABS_API_KEY: 'e', OPENAI_API_KEY: 'o' },
    });
    // Byte-identical incumbent chain head — the no-regression guard.
    expect(tts.providers.slice(0, 3).map((p) => p.providerId)).toEqual([
      'deepgram-aura',
      'elevenlabs-streaming',
      'openai-realtime',
    ]);
  });
});
