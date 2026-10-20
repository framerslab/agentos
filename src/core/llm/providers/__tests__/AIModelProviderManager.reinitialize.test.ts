/**
 * @file AIModelProviderManager.reinitialize.test.ts
 * A manager initialized again shuts down the providers it replaces, so their key pools close (their recheck
 * intervals stop and what their probes found is written) before the new providers read the same store. Uses the
 * real GeminiProvider, whose initialize makes no request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AIModelProviderManager } from '../AIModelProviderManager';
import type { KeyState } from '../../../providers/KeyPoolStateStore';

const config = { providers: [{ providerId: 'gemini', enabled: true, config: { apiKey: 'test-gemini-key-a,test-gemini-key-b' } }] };

describe('AIModelProviderManager re-initialize', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("completes when a replaced provider's store never answers: the pool's close waits at most storeTimeoutMs", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A database that takes the write and never answers (a dead connection with no query timeout set).
    const store = { load: async (): Promise<KeyState[] | null> => null, save: () => new Promise<void>(() => undefined) };
    const hanging = {
      providers: [{ providerId: 'gemini', enabled: true, config: { apiKey: 'test-gemini-key-a,test-gemini-key-b', keyPool: { id: 'gemini:hang', store, storeTimeoutMs: 1000 } } }],
    };
    const manager = new AIModelProviderManager();
    await manager.initialize(hanging);
    const first = manager.getProvider('gemini')!;
    (first as unknown as { keyPool: { markFailed(key: string, kind: 'auth'): void } }).keyPool.markFailed('test-gemini-key-a', 'auth');
    let done = false;
    const again = manager.initialize(hanging).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await again;
    const second = manager.getProvider('gemini');
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    await second!.shutdown();
  });

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
