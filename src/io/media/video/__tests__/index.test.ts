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
});
