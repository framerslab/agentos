/**
 * @file AIModelProviderManager.providerEntry.test.ts
 * The entry a provider is served from: of the enabled entries that name it, in any letter case, the last whose provider
 * started. Uses the real GeminiProvider, which starts without a request and refuses an entry with no key.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { AIModelProviderManager } from '../AIModelProviderManager';

let manager: AIModelProviderManager | undefined;
afterEach(async () => {
  await manager?.shutdown();
  manager = undefined;
});

describe('AIModelProviderManager.getProviderEntry', () => {
  it('serves a provider from the last enabled entry that names it in any letter case, a disabled one passed over', async () => {
    manager = new AIModelProviderManager();
    const last = { providerId: 'GEMINI', enabled: true, config: { apiKey: 'test-gemini-key-b' } };
    await manager.initialize({
      providers: [
        { providerId: 'gemini', enabled: true, config: { apiKey: 'test-gemini-key-a' } },
        last,
        { providerId: 'gemini', enabled: false, config: { apiKey: 'test-gemini-key-c' } },
      ],
    });
    expect(manager.getProvider('gemini')).toBeDefined();
    expect(manager.getProviderEntry('gemini')).toBe(last);
    expect(manager.getProviderEntry('Gemini')).toBe(last);
  });

  it('keeps the entry served before one whose provider fails to start, and names none for a provider it does not serve', async () => {
    manager = new AIModelProviderManager();
    const first = { providerId: 'gemini', enabled: true, config: { apiKey: 'test-gemini-key-a' } };
    // GeminiProvider refuses to start without a key.
    await manager.initialize({ providers: [first, { providerId: 'gemini', enabled: true, config: {} }] });
    expect(manager.getProviderInitError('gemini')).toBeDefined();
    expect(manager.getProviderEntry('gemini')).toBe(first);
    expect(manager.getProviderEntry('openai')).toBeUndefined();
  });
});
