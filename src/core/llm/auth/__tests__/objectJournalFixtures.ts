import { ObjectDeletionJournal, type IObjectStore } from '../ObjectDeletionJournal.js';
/** In-memory, atomic create-only fake; its map is exposed only for explicit corruption and rollback tests. */
export class MemoryJournalObjects implements IObjectStore {
  readonly objects = new Map<string, string>();
  online = true;
  private check(): void { if (!this.online) throw new Error('object authority unavailable'); }
  async putIfAbsent(key: string, value: string): Promise<boolean> {
    this.check(); if (this.objects.has(key)) return false; this.objects.set(key, value); return true;
  }
  async get(key: string): Promise<string | null> { this.check(); return this.objects.get(key) ?? null; }
  async list(prefix: string, after: string | null, limit: number): Promise<readonly string[]> {
    this.check(); return [...this.objects.keys()].filter((key) => key.startsWith(prefix) && (after === null || key > after)).sort().slice(0, limit);
  }
}
/** Separate fake journal authentication key; it is never the fixture's wrapping key. */
export function objectJournal(objects = new MemoryJournalObjects(), journalId = 'journal-a'): { objects: MemoryJournalObjects; journal: ObjectDeletionJournal } {
  return { objects, journal: new ObjectDeletionJournal({ objects, journalId, authenticationKey: new Uint8Array(32).fill(2) }) };
}
