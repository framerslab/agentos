import { describe, it, expect } from 'vitest';
import { ttsProviderFamily } from '../provider-family.js';

describe('ttsProviderFamily', () => {
  it('collapses granular deepgram ids to the deepgram family', () => {
    expect(ttsProviderFamily('deepgram-aura')).toBe('deepgram');
    expect(ttsProviderFamily('deepgram')).toBe('deepgram');
    expect(ttsProviderFamily('deepgram-prerecorded')).toBe('deepgram');
  });

  it('collapses granular openai ids to the openai family', () => {
    expect(ttsProviderFamily('openai-tts-1')).toBe('openai');
    expect(ttsProviderFamily('openai-tts-1-hd')).toBe('openai');
    expect(ttsProviderFamily('openai-whisper')).toBe('openai');
    expect(ttsProviderFamily('openai')).toBe('openai');
  });

  it('collapses granular elevenlabs ids to the elevenlabs family', () => {
    expect(ttsProviderFamily('elevenlabs-batch')).toBe('elevenlabs');
    expect(ttsProviderFamily('elevenlabs')).toBe('elevenlabs');
  });

  it('is case-insensitive', () => {
    expect(ttsProviderFamily('Deepgram-Aura')).toBe('deepgram');
    expect(ttsProviderFamily('OpenAI-TTS-1')).toBe('openai');
  });

  it('passes unknown labels through verbatim so they never collide', () => {
    expect(ttsProviderFamily('cache')).toBe('cache');
    expect(ttsProviderFamily('fallback')).toBe('fallback');
    expect(ttsProviderFamily('some-new-vendor')).toBe('some-new-vendor');
  });
});
