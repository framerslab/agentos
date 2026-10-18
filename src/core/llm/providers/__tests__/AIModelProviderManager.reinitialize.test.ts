/**
 * @file AIModelProviderManager.reinitialize.test.ts
 * A manager initialized again shuts down the providers it replaces, so their key pools close (their recheck
 * intervals stop and what their probes found is written) before the new providers read the same store. Uses the
 * real GeminiProvider, whose initialize makes no request.
 */
import { describe, expect, it, vi } from 'vitest';

import { AIModelProviderManager } from '../AIModelProviderManager';

const config = { providers: [{ providerId: 'gemini', enabled: true, config: { apiKey: 'test-gemini-key-a,test-gemini-key-b' } }] };

describe('AIModelProviderManager re-initialize', () => {
  it('shuts down each replaced provider before it builds the new ones', async () => {
    const manager = new AIModelProviderManager();
    await manager.initialize(config);
    const first = manager.getProvider('gemini');
    expect(first).toBeDefined();
    const shutdown = vi.spyOn(first!, 'shutdown');
    await manager.initialize(config);
    expect(shutdown).toHaveBeenCalledTimes(1);
    const second = manager.getProvider('gemini');
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    await second!.shutdown();
  });
});
