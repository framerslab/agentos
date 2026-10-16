import { describe, expect, it, vi } from 'vitest';
import { ContentKeyService, InMemoryContentKeyStore, createContentKey, sealContent, openContent, revokeContentKey, restoreContentKeys } from '../ContentKeyLifecycle.js';
import { contentFixture, MemoryDeletionJournal } from './contentKeyFixtures.js';
const object = { purpose: 'transcript' as const, objectId: 'item-a' };
const text = () => new TextEncoder().encode('neutral fixture text');
describe('content-key lifetime', () => {
  it('starts sealed, binds scope/call/object/purpose and never returns key material', async () => {
    const f = contentFixture(); await expect(createContentKey(f.service, 'scope-a', 'call-a')).rejects.toThrow('sealed');
    await restoreContentKeys(f.service); const ref = await createContentKey(f.service, 'scope-a', 'call-a');
    expect(Object.keys(ref).sort()).toEqual(['callId', 'keyId', 'scopeId']); expect(ref.keyId).toMatch(/^[a-f0-9]{32}$/);
    expect(await createContentKey(f.service, 'scope-a', 'call-a')).toEqual(ref); const pair = await Promise.all([createContentKey(f.service, 'scope-a', 'call-race'), createContentKey(f.service, 'scope-a', 'call-race')]); expect(pair[0]).toEqual(pair[1]);
    const cipher = await sealContent(f.service, ref, object, text()); let retained!: Uint8Array;
    await openContent(f.service, ref, object, cipher, async (bytes) => { expect(new TextDecoder().decode(bytes)).toBe('neutral fixture text'); retained = bytes; });
    expect([...retained]).toEqual(new Array(text().length).fill(0));
    for (const changed of [{ ...ref, scopeId: 'scope-b' }, { ...ref, callId: 'call-b' }]) await expect(openContent(f.service, changed, object, cipher, async () => {})).rejects.toThrow();
    await expect(openContent(f.service, ref, { ...object, purpose: 'delivery' }, cipher, async () => {})).rejects.toThrow();
    await expect(openContent(f.service, ref, { ...object, objectId: 'item-b' }, cipher, async () => {})).rejects.toThrow();
    expect(JSON.stringify(f.service)).toBe('"[ContentKeyService]"');
  });
  it('recovers the same permanent key when its creation response is lost', async () => { const store = new InMemoryContentKeyStore(); const f = contentFixture(store); await restoreContentKeys(f.service); const insert = store.insert.bind(store); vi.spyOn(store, 'insert').mockImplementationOnce(async (row) => { await insert(row); throw new Error('lost response'); }); await expect(createContentKey(f.service, 'scope-a', 'call-a')).rejects.toThrow('lost response'); const recovered = await createContentKey(f.service, 'scope-a', 'call-a'); expect(store.snapshot()).toHaveLength(1); expect(recovered.keyId).toBe(store.snapshot()[0]!.keyId); });
  it('records the tombstone before fencing, destroys before cleanup, and refuses key or call reuse', async () => {
    const store = new InMemoryContentKeyStore(); const journal = new MemoryDeletionJournal(); const f = contentFixture(store, journal);
    await restoreContentKeys(f.service); const ref = await createContentKey(f.service, 'scope-a', 'call-a');
    f.fenceContent.mockImplementationOnce(async () => { expect(journal.entries).toHaveLength(1); expect(store.snapshot()[0]!.wrappedKey).not.toBeNull(); return { completed: true, evidenceRef: 'content-fenced' }; });
    f.cleanupContent.mockImplementation(async () => { expect(store.snapshot()[0]!.wrappedKey).toBeNull(); return { completed: true, evidenceRef: 'content-scrubbed' }; });
    await revokeContentKey(f.service, ref); await revokeContentKey(f.service, ref); expect(journal.entries).toHaveLength(1);
    await expect(createContentKey(f.service, 'scope-a', 'call-a')).rejects.toThrow('revoked');
    expect(await store.insert({ ...ref, wrappedKey: 'fake', revokedAt: null })).toBe(false);
  });
  it('aborts an outstanding lease and waits for its callback before acknowledging deletion', async () => {
    const f = contentFixture(); await restoreContentKeys(f.service); const ref = await createContentKey(f.service, 'scope-a', 'call-a');
    const cipher = await sealContent(f.service, ref, object, text()); let release!: () => void; let signal!: AbortSignal;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const work = openContent(f.service, ref, object, cipher, async (_bytes, current) => { signal = current; await gate; }); const refused = expect(work).rejects.toThrow();
    await vi.waitFor(() => expect(signal).toBeDefined()); let done = false;
    const revoke = revokeContentKey(f.service, ref).then(() => { done = true; });
    await vi.waitFor(() => expect(signal.aborted).toBe(true)); expect(done).toBe(false); expect(f.cleanupContent).not.toHaveBeenCalled();
    release(); await refused; await revoke; expect(done).toBe(true);
  });
  it('restores old ciphertext and wrapped-key snapshots sealed, then erases deleted keys while recovering a live call', async () => {
    const store = new InMemoryContentKeyStore(); const journal = new MemoryDeletionJournal(); const f = contentFixture(store, journal);
    await restoreContentKeys(f.service); const deleted = await createContentKey(f.service, 'scope-a', 'call-a'); const live = await createContentKey(f.service, 'scope-a', 'call-b');
    const productBackup = { deleted: await sealContent(f.service, deleted, object, text()), live: await sealContent(f.service, live, object, text()) };
    const keyBackup = store.snapshot(); await revokeContentKey(f.service, deleted);
    const restoredStore = new InMemoryContentKeyStore(keyBackup); const r = contentFixture(restoredStore, journal);
    await expect(openContent(r.service, live, object, productBackup.live, async () => {})).rejects.toThrow('sealed');
    await restoreContentKeys(r.service); expect(restoredStore.snapshot().find((row) => row.keyId === deleted.keyId)!.wrappedKey).toBeNull();
    await expect(openContent(r.service, deleted, object, productBackup.deleted, async () => {})).rejects.toThrow('revoked');
    await openContent(r.service, live, object, productBackup.live, async (bytes) => { expect(bytes).toEqual(text()); });
    expect(r.fenceAll).toHaveBeenCalledOnce(); expect(r.cleanupContent).toHaveBeenCalledOnce();
  });
  it('seals on journal outage and rejects a replayed head or a freshly signed head below the independent floor', async () => {
    const journal = new MemoryDeletionJournal(); const f = contentFixture(undefined, journal); await restoreContentKeys(f.service);
    const ref = await createContentKey(f.service, 'scope-a', 'call-a'); const cipher = await sealContent(f.service, ref, object, text());
    journal.online = false; await expect(openContent(f.service, ref, object, cipher, async () => {})).rejects.toThrow('unavailable'); expect(f.service.ready).toBe(false);
    journal.online = true; journal.stale = await journal.current('old-challenge'); await expect(restoreContentKeys(f.service)).rejects.toThrow('unavailable'); journal.stale = undefined;
    await journal.append(ref); const floor = journal.mark(); const empty = new MemoryDeletionJournal();
    const stale = new ContentKeyService({ ...f.options, journal: empty, minimumJournalMark: async () => floor });
    await expect(restoreContentKeys(stale)).rejects.toThrow('unavailable'); expect(stale.ready).toBe(false);
  });
  it('keeps deletion pending across a failed fence and retries the same journal entry', async () => {
    const store = new InMemoryContentKeyStore(); const journal = new MemoryDeletionJournal(); const f = contentFixture(store, journal);
    await restoreContentKeys(f.service); const ref = await createContentKey(f.service, 'scope-a', 'call-a');
    f.fenceContent.mockRejectedValueOnce(new Error('offline')); await expect(revokeContentKey(f.service, ref)).rejects.toThrow('incomplete');
    expect(store.snapshot()[0]!.wrappedKey).not.toBeNull(); expect(f.cleanupContent).not.toHaveBeenCalled();
    await revokeContentKey(f.service, ref); expect(store.snapshot()[0]!.wrappedKey).toBeNull(); expect(journal.entries).toHaveLength(1);
  });
  it('never enables restore when replay has a gap, cleanup fails or the journal advances beyond the replayed cut', async () => {
    const journal = new MemoryDeletionJournal(); const seed = { scopeId: 'scope-a', callId: 'call-a', keyId: 'a'.repeat(32) }; await journal.append(seed);
    const gap = contentFixture(undefined, journal); vi.spyOn(journal, 'read').mockResolvedValueOnce([]);
    await expect(restoreContentKeys(gap.service)).rejects.toThrow('unavailable'); expect(gap.service.ready).toBe(false);
    const fail = contentFixture(undefined, journal); fail.cleanupContent.mockRejectedValueOnce(new Error('cleanup'));
    await expect(restoreContentKeys(fail.service)).rejects.toThrow('incomplete'); expect(fail.service.ready).toBe(false);
    const catchup = contentFixture(undefined, journal); catchup.cleanupContent.mockImplementationOnce(async () => { await journal.append({ ...seed, callId: 'call-b', keyId: 'b'.repeat(32) }); return { completed: true, evidenceRef: 'content-scrubbed' }; });
    const mark = await restoreContentKeys(catchup.service); expect(mark.sequence).toBe(2); expect(catchup.service.ready).toBe(true);
  });
  it('retains a revocation at another service while a read is already in progress', async () => {
    const store = new InMemoryContentKeyStore(); const journal = new MemoryDeletionJournal(); const a = contentFixture(store, journal); const b = contentFixture(store, journal);
    await restoreContentKeys(a.service); await restoreContentKeys(b.service); const ref = await createContentKey(a.service, 'scope-a', 'call-a'); const cipher = await sealContent(a.service, ref, object, text());
    let release!: () => void; let entered = false; const gate = new Promise<void>((resolve) => { release = resolve; });
    const open = openContent(a.service, ref, object, cipher, async () => { entered = true; await gate; }); const rejected = expect(open).rejects.toThrow();
    await vi.waitFor(() => expect(entered).toBe(true)); let done = false; const revoked = revokeContentKey(b.service, ref).then(() => { done = true; });
    await vi.waitFor(() => expect(journal.entries).toHaveLength(1)); expect(done).toBe(false); release(); await rejected; await revoked;
    await expect(openContent(a.service, ref, object, cipher, async () => {})).rejects.toThrow('revoked');
  });
});
