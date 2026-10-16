import { describe, expect, it, vi } from 'vitest';
import { createContentKey, sealContent, openContent, revokeContentKey, restoreContentKeys, type ContentKeyRow, type ContentKeyStore } from '../ContentKeyLifecycle.js';
import { contentFixture } from './contentKeyFixtures.js';
import { objectJournal } from './objectJournalFixtures.js';
/** One isolated SQL partition and an independent adapter instance over that same partition. */
export interface ContentStoreHarness {
  store: ContentKeyStore; peer: ContentKeyStore;
  backup(): Promise<ContentKeyRow[]>;
  restore(snapshot: readonly ContentKeyRow[]): Promise<ContentKeyStore>;
}
const row = (n: number): ContentKeyRow => ({ scopeId: 'scope-a', callId: `call-${n}`, keyId: n.toString(16).padStart(32, '0'), wrappedKey: 'plainly-fake-wrapped-test-value', revokedAt: null });
/** Runs identical real-store behavior on both SQL engines, with cross-connection cases on PostgreSQL. */
export function runContentKeyStoreContract(label: string, make: () => Promise<ContentStoreHarness>, concurrent: boolean): void {
  describe(label, () => {
    it('preserves both permanent identities, scopes reads and releases a rejected callback lock', async () => {
      const f = await make(); const a = row(1); const ref = { scopeId: a.scopeId, callId: a.callId, keyId: a.keyId };
      expect(await f.store.insert(a)).toBe(true); expect(await f.peer.insert(a)).toBe(false);
      expect(await f.peer.findByCall(a.scopeId, a.callId)).toEqual(ref); expect(await f.peer.findByCall('scope-b', a.callId)).toBeUndefined();
      expect(await f.store.insert({ ...a, keyId: 'f'.repeat(32) })).toBe(false);
      expect(await f.store.withKey({ ...ref, scopeId: 'scope-b' }, async (value) => value)).toBeUndefined();
      await expect(f.store.withKey(ref, async () => { throw new Error('consumer failed'); })).rejects.toThrow('consumer failed');
      expect(await f.peer.withKey(ref, async (value) => value?.wrappedKey)).toBe(a.wrappedKey);
      await f.peer.destroy(ref, 3); await f.store.destroy(ref, 2);
      expect(await f.store.withKey(ref, async (value) => value)).toEqual({ ...a, wrappedKey: null, revokedAt: 3 });
      expect(await f.store.insert(a)).toBe(false);
    });
    it('creates a tombstone for a key absent from the restored snapshot and never resurrects it', async () => {
      const f = await make(); const a = row(1); const ref = { scopeId: a.scopeId, callId: a.callId, keyId: a.keyId };
      await f.store.destroy(ref, 1); expect(await f.peer.insert(a)).toBe(false);
      expect(await f.store.withKey(ref, async (value) => value?.wrappedKey)).toBeNull();
      await expect(f.peer.destroy({ ...ref, scopeId: 'scope-b' }, 2)).rejects.toThrow('conflict');
    });
    it('restores old content and key snapshots against the same independent object journal', async () => {
      const f = await make(); const journal = objectJournal().journal; const live = contentFixture(f.store, journal); await restoreContentKeys(live.service);
      const deleted = await createContentKey(live.service, 'scope-a', 'call-a'); const kept = await createContentKey(live.service, 'scope-a', 'call-b');
      const object = { purpose: 'transcript' as const, objectId: 'item-a' }; const bytes = new TextEncoder().encode('fixture');
      const contentBackup = { deleted: await sealContent(live.service, deleted, object, bytes), kept: await sealContent(live.service, kept, object, bytes) };
      const keysBackup = await f.backup(); await revokeContentKey(live.service, deleted);
      const restored = contentFixture(await f.restore(keysBackup), journal);
      await expect(openContent(restored.service, kept, object, contentBackup.kept, async () => {})).rejects.toThrow('sealed');
      await restoreContentKeys(restored.service);
      expect(await restored.store.withKey(deleted, async (value) => value?.wrappedKey)).toBeNull();
      await expect(openContent(restored.service, deleted, object, contentBackup.deleted, async () => {})).rejects.toThrow('revoked');
      await openContent(restored.service, kept, object, contentBackup.kept, async (plain) => { expect(plain).toEqual(bytes); });
    });
    if (concurrent) {
      it('waits for another connection holding a decrypt lease and commits a permanent tombstone after release', async () => {
        const f = await make(); const a = row(1); const ref = { scopeId: a.scopeId, callId: a.callId, keyId: a.keyId }; await f.store.insert(a);
        let release!: () => void; let entered = false; const gate = new Promise<void>((resolve) => { release = resolve; });
        const reading = f.store.withKey(ref, async (value) => { expect(value?.wrappedKey).toBe(a.wrappedKey); entered = true; await gate; });
        await vi.waitFor(() => expect(entered).toBe(true)); let done = false; const destroying = f.peer.destroy(ref, 1).then(() => { done = true; });
        try { await new Promise<void>((resolve) => setTimeout(resolve, 30)); expect(done).toBe(false); } finally { release(); }
        await reading; await destroying; expect(done).toBe(true); expect(await f.store.insert(a)).toBe(false);
      });
      it('races first insertion and destruction on a missing key without leaving readable material', async () => {
        const f = await make(); const a = row(1); const ref = { scopeId: a.scopeId, callId: a.callId, keyId: a.keyId };
        await Promise.all([f.store.insert(a), f.peer.destroy(ref, 1)]);
        expect(await f.store.withKey(ref, async (value) => value)).toEqual({ ...a, wrappedKey: null, revokedAt: 1 });
        const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? f.store : f.peer).insert(row(2))));
        expect(attempts.filter(Boolean)).toHaveLength(1);
      });
    }
  });
}
