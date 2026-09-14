import { describe, expect, it } from 'vitest';

import { createAudioProvider, listAudioProviderFactories } from '../index.js';

describe('media/audio index', () => {
  it('lists the built-in audio providers', () => {
    expect(listAudioProviderFactories()).toEqual([
      'audiogen-local',
      'elevenlabs-sfx',
      'fal-audio',
      'minimax-music',
      'musicgen-local',
      'replicate-audio',
      'stable-audio',
      'suno',
      'udio',
    ]);
  });

  it('creates built-in audio providers synchronously', () => {
    const provider = createAudioProvider('suno');

    expect(provider.providerId).toBe('suno');
    expect(provider.isInitialized).toBe(false);
  });
});
