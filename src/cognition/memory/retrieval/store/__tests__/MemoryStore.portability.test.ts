import { afterEach, describe, expect, it, vi } from 'vitest';

describe('memory store portability', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('loads when WeakRef and FinalizationRegistry are unavailable', async () => {
    vi.resetModules();
    vi.stubGlobal('WeakRef', undefined);
    vi.stubGlobal('FinalizationRegistry', undefined);

    await expect(import('../Brain.js')).resolves.toHaveProperty('Brain');
    await expect(import('../MemoryStore.js')).resolves.toHaveProperty('MemoryStore');
  });
});
