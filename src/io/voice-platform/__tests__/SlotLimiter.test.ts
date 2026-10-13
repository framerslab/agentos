import { describe, expect, it } from 'vitest';
import { InMemoryVoiceStore } from '../stores/memory.js';
import { SlotLimiter } from '../SlotLimiter.js';
import { slotLimiterContract, slotRequest } from './slotLimiter.contract.js';

slotLimiterContract('memory slots', async () => { const store = new InMemoryVoiceStore(); return [store, store]; });
describe('initialization deadlines', () => {
  it('aborts a stalled initializer, confirms its fence and releases both shares', async () => {
    const store = new InMemoryVoiceStore(); const limiter = new SlotLimiter({ store, now: () => 1000 }); let aborted = false;
    await expect(limiter.initialize(slotRequest(), {
      timeoutMs: 10,
      initialize: async (_lease, signal) => new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }); }),
      fence: async (lease) => ({ generation: lease.generation, stopped: aborted, evidenceRef: 'native-abort-a' }),
    })).rejects.toThrow();
    expect(aborted).toBe(true);
    expect((await store.withTransaction('scope-a', (tx) => tx.list('slots'))).every((r) => r.value.released)).toBe(true);
  });
});
