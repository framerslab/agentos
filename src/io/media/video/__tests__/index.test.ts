import { describe, expect, it } from 'vitest';

import {
  createVideoProvider,
  getVideoProviderOptions,
  listVideoProviderFactories,
  registerVideoProviderFactory,
} from '../index.js';

describe('media/video index', () => {
  it('lists the built-in video providers', () => {
    expect(listVideoProviderFactories()).toEqual([
      'fal',
      'gemini',
      'replicate',
      'runway',
    ]);
  });

  it('creates built-in video providers synchronously', () => {
    const provider = createVideoProvider('runway');

    expect(provider.providerId).toBe('runway');
    expect(provider.isInitialized).toBe(false);
  });

  // Registers a provider, so it runs after the listing test above.
  it('treats a registered provider id as a key of a provider-keyed options bag', () => {
    registerVideoProviderFactory('Luma', () => createVideoProvider('runway'));
    const bag = { luma: { loop: true } };

    expect(getVideoProviderOptions('fal', bag)).toBeUndefined();
    expect(getVideoProviderOptions('replicate', bag)).toBeUndefined();
    expect(getVideoProviderOptions('luma', bag)).toEqual({ loop: true });
  });

  it('reads a provider entry whatever the case of its key', () => {
    expect(getVideoProviderOptions('fal', { Fal: { end_image_url: 'u' } })).toEqual({ end_image_url: 'u' });
    expect(getVideoProviderOptions('replicate', { REPLICATE: { seed: 2 }, fal: {} })).toEqual({ seed: 2 });
  });

  it('exports the image helper custom providers normalise a request image with', async () => {
    // Read loosely so the test runs red at its assertion, not at the type check.
    const videoIndex = (await import('../index.js')) as Record<string, unknown>;
    const videoImageToUrl = videoIndex.videoImageToUrl as ((image: Buffer | string) => string) | undefined;

    expect(typeof videoImageToUrl).toBe('function');
    expect(videoImageToUrl!(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('data:image/jpeg;base64,/9j/4A==');
    expect(videoImageToUrl!('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
  });
});
