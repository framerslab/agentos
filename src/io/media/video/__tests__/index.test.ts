import { describe, expect, it } from 'vitest';

import { createVideoProvider, listVideoProviderFactories } from '../index.js';

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
});
