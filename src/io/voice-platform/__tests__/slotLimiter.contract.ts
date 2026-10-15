import { describe, expect, it } from 'vitest';
import { SlotLimiter, type SlotRequest, type SlotLeaseHandle } from '../SlotLimiter.js';
import type { VoiceStore } from '../stores/types.js';

/** One capacity fixture, selected by a host after verifying its bench artifact. */
export function slotRequest(over: Partial<SlotRequest> = {}): SlotRequest {
  return { scopeId: 'scope-a', callId: 'call-a', hostId: 'host-a', holder: 'worker-a', ttlMs: 100,
    capacity: { version: 'bench-a', validUntil: 100000, scopeSlots: 2, hostSlots: 3 }, ...over };
}
/** Identical atomicity and fencing cases on memory and real PostgreSQL. */
export function slotLimiterContract(name: string, make: () => Promise<readonly [VoiceStore, VoiceStore]>): void {
  describe(name, () => {
    it('admits at most the scope limit across hosts and the host limit across scopes', async () => {
      const [a, b] = await make();
      const limiters = [new SlotLimiter({ store: a, now: () => 1000 }), new SlotLimiter({ store: b, now: () => 1000 })];
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => limiters[i % 2]!.acquire(slotRequest({ scopeId: `scope-${i % 2}`, callId: `call-${i}`, holder: `worker-${i}` }))));
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      const counts = new Map<string, number>();
      for (const r of results) if (r.ok) counts.set(r.lease.scopeId, (counts.get(r.lease.scopeId) ?? 0) + 1);
      expect([...counts.values()].every((n) => n <= 2)).toBe(true);
      const [c, d] = await make(); const x = new SlotLimiter({ store: c, now: () => 1000 }); const y = new SlotLimiter({ store: d, now: () => 1000 });
      const across = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? x : y).acquire(slotRequest({ hostId: `host-${i % 2}`, callId: `call-${i}` }))));
      expect(across.filter((r) => r.ok)).toHaveLength(2);
    });
    it('denies missing, expired or zero capacity without retaining half a lease', async () => {
      const [store] = await make(); const limiter = new SlotLimiter({ store, now: () => 1000 });
      for (const capacity of [undefined, { version: 'bench-a', validUntil: 999, scopeSlots: 2, hostSlots: 3 }, { version: 'bench-a', validUntil: 9000, scopeSlots: 0, hostSlots: 3 }]) {
        expect((await limiter.acquire(slotRequest({ capacity }))).ok).toBe(false);
      }
      expect(await store.withTransaction('scope-a', (tx) => tx.list('slots'))).toEqual([]);
      const accepted = await limiter.acquire(slotRequest()); expect(accepted.ok).toBe(true);
      expect(await store.withTransaction('scope-a', (tx) => tx.list('slots'))).toHaveLength(1);
    });
    it('does not recycle expired work and fences renewals/releases by generation', async () => {
      const [store] = await make(); let now = 1000; const limiter = new SlotLimiter({ store, now: () => now });
      const first = await limiter.acquire(slotRequest()); if (!first.ok) throw new Error('admission failed');
      const retry = await limiter.acquire(slotRequest()); expect(retry).toEqual(first);
      now = 1100;
      expect(await limiter.renew(first.lease, 100)).toBeUndefined();
      expect((await limiter.acquire(slotRequest({ holder: 'worker-b' }))).ok).toBe(false);
      expect(await limiter.release(first.lease, { generation: first.lease.generation, stopped: false, evidenceRef: 'pending' })).toBe(false);
      expect(await limiter.release(first.lease, { generation: first.lease.generation, stopped: true, evidenceRef: 'exit-a' })).toBe(true);
      const second = await limiter.acquire(slotRequest({ holder: 'worker-b', hostId: 'host-b' })); if (!second.ok) throw new Error('replacement failed');
      expect(second.lease.generation).toBe(first.lease.generation + 1);
      expect(await limiter.renew(first.lease, 100)).toBeUndefined();
      expect(await limiter.release(first.lease, { generation: first.lease.generation, stopped: true, evidenceRef: 'exit-a' })).toBe(false);
      expect(await limiter.renew(second.lease, 200)).toMatchObject({ generation: second.lease.generation, expiresAt: 1300 });
    });
    it('releases both limits after failed initialization and confirmed cancellation', async () => {
      const [store] = await make(); const limiter = new SlotLimiter({ store, now: () => 1000 });
      const fence = async (lease: SlotLeaseHandle) => ({ generation: lease.generation, stopped: true, evidenceRef: 'exit-a' });
      await expect(limiter.initialize(slotRequest(), { timeoutMs: 1000, initialize: async () => { throw new Error('init failed'); }, fence })).rejects.toThrow('init failed');
      const after = await limiter.acquire(slotRequest({ callId: 'call-b', capacity: { version: 'bench-a', validUntil: 9000, scopeSlots: 1, hostSlots: 1 } }));
      expect(after.ok).toBe(true);
      if (after.ok) await limiter.release(after.lease, await fence(after.lease));
      const controller = new AbortController(); controller.abort();
      await expect(limiter.initialize(slotRequest({ callId: 'call-c' }), { timeoutMs: 1000, signal: controller.signal, initialize: async () => 'unused', fence })).rejects.toThrow('initialization cancelled');
      expect((await store.withTransaction('scope-a', (tx) => tx.list('slots'))).filter((r) => !r.value.released)).toHaveLength(0);
    });
    it('holds expired capacity across a failed fence and reconciles it exactly once', async () => {
      const [store] = await make(); let now = 1000; const limiter = new SlotLimiter({ store, now: () => now });
      await expect(limiter.initialize(slotRequest(), { timeoutMs: 1000, initialize: async () => { throw new Error('failed'); }, fence: async (lease) => ({ generation: lease.generation, stopped: false, evidenceRef: 'pending' }) })).rejects.toThrow('slot cleanup deferred');
      now = 1200;
      expect(await limiter.reconcileExpired('scope-a', async () => undefined, 10)).toEqual({ released: 0, pending: 1 });
      expect(await limiter.reconcileExpired('scope-a', async (lease) => ({ generation: lease.generation, stopped: true, evidenceRef: 'exit-a' }), 10)).toEqual({ released: 1, pending: 0 });
      expect(await limiter.reconcileExpired('scope-a', async () => { throw new Error('not called'); }, 10)).toEqual({ released: 0, pending: 0 });
    });
  });
}
