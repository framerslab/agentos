import { createHash, createHmac } from 'node:crypto';
import { vi } from 'vitest';
import {
  ContentKeyService, InMemoryContentKeyStore, contentJournalGenesis,
  type ContentKeyBinding, type ContentKeyStore, type DeletionJournal, type JournalEntry, type JournalHead, type JournalMark,
} from '../ContentKeyLifecycle.js';
const copy = <T>(value: T): T => structuredClone(value);
/** Test authority only; production object durability is exercised separately. */
export class MemoryDeletionJournal implements DeletionJournal {
  readonly journalId = 'journal-a';
  readonly entries: JournalEntry[] = [];
  online = true;
  stale: JournalHead | undefined;
  private mac(value: unknown): string { return createHmac('sha256', new Uint8Array(32).fill(2)).update(JSON.stringify(value)).digest('hex'); }
  private check(): void { if (!this.online) throw new Error('journal unavailable'); }
  mark(): JournalMark { const e = this.entries[this.entries.length - 1]; return e ? { journalId: e.journalId, sequence: e.sequence, hash: e.hash } : contentJournalGenesis(this.journalId); }
  async current(challenge: string): Promise<JournalHead> {
    this.check(); if (this.stale) return copy(this.stale);
    const mark = this.mark(); return { ...mark, challenge, proof: this.mac([mark, challenge]) };
  }
  verifyHead(head: JournalHead, challenge: string): void {
    const mark = { journalId: head.journalId, sequence: head.sequence, hash: head.hash };
    if (head.challenge !== challenge || head.proof !== this.mac([mark, challenge])) throw new Error('head authentication');
  }
  verifyEntry(entry: JournalEntry, previous: JournalMark): void {
    const data = [entry.journalId, entry.sequence, entry.previousHash, entry.binding];
    if (entry.previousHash !== previous.hash || entry.sequence !== previous.sequence + 1 || entry.hash !== createHash('sha256').update(JSON.stringify(data)).digest('hex') || entry.proof !== this.mac(data)) throw new Error('entry authentication');
  }
  async read(after: JournalMark, through: JournalMark, limit: number): Promise<JournalEntry[]> {
    this.check(); return copy(this.entries.slice(after.sequence, Math.min(through.sequence, after.sequence + limit)));
  }
  async append(binding: ContentKeyBinding): Promise<JournalEntry> {
    this.check(); const old = this.entries.find((e) => e.binding.keyId === binding.keyId || (e.binding.scopeId === binding.scopeId && e.binding.callId === binding.callId));
    if (old) { if (JSON.stringify(old.binding) !== JSON.stringify(binding)) throw new Error('binding conflict'); return copy(old); }
    const prev = this.mark(); const data = [this.journalId, prev.sequence + 1, prev.hash, binding];
    const entry = { journalId: this.journalId, sequence: prev.sequence + 1, previousHash: prev.hash, binding: copy(binding), hash: createHash('sha256').update(JSON.stringify(data)).digest('hex'), proof: this.mac(data) };
    this.entries.push(entry); return copy(entry);
  }
}
/** All bytes are fake test keys. Hooks represent already fenced test consumers. */
export function contentFixture(store: ContentKeyStore = new InMemoryContentKeyStore(), journal: DeletionJournal = new MemoryDeletionJournal()) {
  const fenceAll = vi.fn(async () => ({ completed: true as const, evidenceRef: 'all-workers-stopped' }));
  const fenceContent = vi.fn(async () => ({ completed: true as const, evidenceRef: 'content-fenced' }));
  const cleanupContent = vi.fn(async () => ({ completed: true as const, evidenceRef: 'content-scrubbed' }));
  const minimumJournalMark = async (): Promise<JournalMark> => {
    const nonce = 'fixture-control-plane'; const head = await journal.current(nonce); journal.verifyHead(head, nonce);
    return { journalId: head.journalId, sequence: head.sequence, hash: head.hash };
  };
  const options = { store, journal, minimumJournalMark,
    wrappingKeys: async () => ({ active: { id: 'wrap-a', key: new Uint8Array(32).fill(1) }, previous: [] }),
    hooks: { fenceAll, fenceContent, cleanupContent } };
  return { store, journal, options, service: new ContentKeyService(options), fenceAll, fenceContent, cleanupContent };
}
