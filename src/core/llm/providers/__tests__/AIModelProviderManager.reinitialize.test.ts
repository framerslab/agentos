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
  it('takes each replaced provider out of routing, then shuts it down before it builds the new ones', async () => {
    const manager = new AIModelProviderManager();
    await manager.initialize(config);
    const first = manager.getProvider('gemini');
    expect(first).toBeDefined();
    // While a replaced provider shuts down (its pool may be waiting for a probe), no call is routed to it.
    const realShutdown = first!.shutdown.bind(first);
    let routedDuringShutdown: unknown = 'not called';
    const shutdown = vi.spyOn(first!, 'shutdown').mockImplementation(async () => {
      routedDuringShutdown = manager.getProvider('gemini');
      await realShutdown();
    });
    await manager.initialize(config);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(routedDuringShutdown).toBeUndefined();
    const second = manager.getProvider('gemini');
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    await second!.shutdown();
  });
});
