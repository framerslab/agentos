import { describe, expect, it } from 'vitest';
import { VoiceStoreConflict, type VoiceStore, type VoiceTransaction } from '../stores/types.js';

/** Runs identical isolation, rollback and uniqueness checks on each adapter. */
export function voiceStoreContract(name: string, make: () => Promise<VoiceStore>): void {
  describe(name, () => {
    it('rolls back the entire transaction and invalidates escaped handles', async () => {
      const store = await make();
      let escaped!: VoiceTransaction;
      await expect(store.withTransaction('scope-a', async (tx) => {
        escaped = tx;
        await tx.put('idempotency', 'create:a', { requestHash: 'a', callId: 'call-a', result: null }, 0);
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect(await store.withTransaction('scope-a', (tx) => tx.get('idempotency', 'create:a'))).toBeUndefined();
      await expect(escaped.get('idempotency', 'create:a')).rejects.toThrow('transaction closed');
    });
    it('isolates scopes, copies values and compares versions', async () => {
      const store = await make();
      await store.withTransaction('scope-a', (tx) => tx.put('idempotency', 'create:a', { requestHash: 'a', callId: 'call-a', result: null }, 0));
      expect(await store.withTransaction('scope-b', (tx) => tx.get('idempotency', 'create:a'))).toBeUndefined();
      const row = await store.withTransaction('scope-a', (tx) => tx.get('idempotency', 'create:a'));
      row!.value.callId = 'changed';
      await expect(store.withTransaction('scope-a', (tx) => tx.put('idempotency', 'create:a', row!.value, 0))).rejects.toBeInstanceOf(VoiceStoreConflict);
      expect((await store.withTransaction('scope-a', (tx) => tx.get('idempotency', 'create:a')))!.value.callId).toBe('call-a');
    });
    it('serializes competing first inserts and preserves the first idempotency value', async () => {
      const store = await make();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.withTransaction('scope-a', async (tx) => {
        const existing = await tx.get('idempotency', 'create:a');
        if (existing) return false;
        await tx.put('idempotency', 'create:a', { requestHash: String(i), callId: 'call-a', result: null }, 0);
        return true;
      })));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.withTransaction('scope-a', (tx) => tx.list('idempotency'))).toHaveLength(1);
    });
    it('requires a host lock for slot writes and permits only one host per transaction', async () => {
      const store = await make();
      const lease = { callId: 'call-a', hostId: 'host-a', holder: 'worker-a', generation: 1, expiresAt: 100, released: false };
      await expect(store.withTransaction('scope-a', (tx) => tx.put('slots', 'call-a', lease, 0))).rejects.toThrow('host lock');
      await store.withTransaction('scope-a', async (tx) => { await tx.lockHost('host-a'); await tx.put('slots', 'call-a', lease, 0); });
      await store.withTransaction('scope-b', async (tx) => {
        expect(await tx.lockHost('host-a')).toHaveLength(1);
        await expect(tx.lockHost('host-b')).rejects.toThrow('one host');
      });
    });
  });
}
