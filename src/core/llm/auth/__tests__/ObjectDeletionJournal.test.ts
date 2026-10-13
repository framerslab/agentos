import { describe, expect, it, vi } from 'vitest';
import { ObjectDeletionJournal } from '../ObjectDeletionJournal.js';
import { ContentKeyService, contentJournalGenesis, createContentKey, sealContent, openContent, restoreContentKeys, revokeContentKey } from '../ContentKeyLifecycle.js';
import { objectJournal, MemoryJournalObjects } from './objectJournalFixtures.js';
import { contentFixture } from './contentKeyFixtures.js';
const binding = (n: number) => ({ scopeId: 'scope-a', callId: `call-${n}`, keyId: n.toString(16).padStart(32, '0') });
const challenge = 'a'.repeat(64);
describe('independent object deletion journal', () => {
  it('serializes competing writers without overwrites and makes an identical revoke idempotent', async () => {
    const { objects, journal: a } = objectJournal(); const b = objectJournal(objects).journal;
    const entries = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).append(binding(i + 1))));
    expect(new Set(entries.map((entry) => entry.sequence)).size).toBe(20);
    const again = await Promise.all([a.append(binding(1)), b.append(binding(1))]); expect(again[0]).toEqual(again[1]);
    expect(objects.objects.size).toBe(20); expect((await a.current(challenge)).sequence).toBe(20);
    await expect(a.append({ ...binding(1), keyId: 'f'.repeat(32) })).rejects.toThrow('conflict');
    await expect(a.append({ ...binding(1), scopeId: 'scope-b' })).rejects.toThrow('conflict');
  });
  it('recovers the committed tombstone when the conditional-write acknowledgement was lost', async () => {
    const { objects, journal } = objectJournal(); const put = objects.putIfAbsent.bind(objects);
    vi.spyOn(objects, 'putIfAbsent').mockImplementationOnce(async (key, value) => { await put(key, value); throw new Error('lost response'); });
    await expect(journal.append(binding(1))).rejects.toThrow(); const recovered = await journal.append(binding(1));
    expect(recovered.sequence).toBe(1); expect(objects.objects.size).toBe(1);
  });
  it('authenticates the head challenge, journal identity, exact fields and every chain entry', async () => {
    const { objects, journal } = objectJournal(); await journal.append(binding(1)); const head = await journal.current(challenge);
    expect(() => journal.verifyHead(head, challenge)).not.toThrow();
    expect(() => journal.verifyHead(head, 'b'.repeat(64))).toThrow();
    expect(() => journal.verifyHead({ ...head, sequence: 0 }, challenge)).toThrow();
    expect(() => objectJournal(new MemoryJournalObjects(), 'journal-b').journal.verifyHead(head, challenge)).toThrow();
    const key = [...objects.objects.keys()][0]!; const raw = JSON.parse(objects.objects.get(key)!); raw.binding.scopeId = 'scope-b'; objects.objects.set(key, JSON.stringify(raw));
    await expect(journal.current(challenge)).rejects.toThrow();
  });
  it('refuses missing, reordered or malformed objects and an observed high-water rollback', async () => {
    const { objects, journal } = objectJournal(); await journal.append(binding(1)); await journal.append(binding(2));
    const saved = new Map(objects.objects); const first = [...saved.keys()].sort()[0]!; objects.objects.delete(first);
    await expect(journal.current(challenge)).rejects.toThrow(); objects.objects.set(first, saved.get(first)!);
    vi.spyOn(objects, 'list').mockImplementationOnce(async () => [...saved.keys()].sort().reverse()); await expect(journal.current(challenge)).rejects.toThrow();
    objects.objects.set(first, '{broken'); await expect(journal.current(challenge)).rejects.toThrow(); objects.objects.set(first, saved.get(first)!);
    await journal.current(challenge); objects.objects.clear(); await expect(journal.current(challenge)).rejects.toThrow();
  });
  it('replays more than one page and refuses a false terminal hash', async () => {
    const { journal } = objectJournal(); for (let n = 1; n <= 260; n++) await journal.append(binding(n));
    const head = await journal.current(challenge); const mark = { journalId: head.journalId, sequence: head.sequence, hash: head.hash };
    const first = await journal.read(contentJournalGenesis(journal.journalId), mark, 256); expect(first).toHaveLength(256);
    const last = first[first.length - 1]!; const after = { journalId: last.journalId, sequence: last.sequence, hash: last.hash };
    expect(await journal.read(after, mark, 256)).toHaveLength(4);
    await expect(journal.read(after, { ...mark, hash: '0'.repeat(64) }, 256)).rejects.toThrow();
  }, 20000);
  it('rejects a freshly signed stale backend on a cold service through its independently current floor', async () => {
    const f = objectJournal(); const app = contentFixture(undefined, f.journal); await restoreContentKeys(app.service);
    const ref = await createContentKey(app.service, 'scope-a', 'call-a'); const bytes = new TextEncoder().encode('fixture'); const object = { purpose: 'delivery' as const, objectId: 'delivery-a' };
    const ciphertext = await sealContent(app.service, ref, object, bytes); await revokeContentKey(app.service, ref);
    const floorHead = await f.journal.current(challenge); const floor = { journalId: floorHead.journalId, sequence: floorHead.sequence, hash: floorHead.hash };
    const stale = objectJournal().journal; const restored = new ContentKeyService({ ...app.options, journal: stale, minimumJournalMark: async () => floor });
    await expect(restoreContentKeys(restored)).rejects.toThrow('unavailable');
    await expect(openContent(restored, ref, object, ciphertext, async () => {})).rejects.toThrow('sealed');
  });
  it('fails closed during object-store outage and redacts both adapters', async () => {
    const f = objectJournal(); const app = contentFixture(undefined, f.journal); await restoreContentKeys(app.service);
    const ref = await createContentKey(app.service, 'scope-a', 'call-a'); f.objects.online = false;
    await expect(revokeContentKey(app.service, ref)).rejects.toThrow('unavailable'); expect(app.service.ready).toBe(false);
    expect(JSON.stringify(f.journal)).toBe('"[ObjectDeletionJournal]"');
    expect(() => new ObjectDeletionJournal({ objects: f.objects, journalId: '../bad', authenticationKey: new Uint8Array(32) })).toThrow();
    expect(() => new ObjectDeletionJournal({ objects: f.objects, journalId: 'journal-a', authenticationKey: new Uint8Array(1) })).toThrow();
  });
});
