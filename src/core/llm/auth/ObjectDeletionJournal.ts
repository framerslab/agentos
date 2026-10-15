import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  ContentKeyError, contentJournalGenesis, parseContentKeyBinding,
  type ContentKeyBinding, type DeletionJournal, type JournalEntry, type JournalHead, type JournalMark,
} from './ContentKeyLifecycle.js';
/**
 * Independent durable object authority. Conditional creation is atomic and its acknowledgement means
 * durable replication. get/list are authoritative and strongly consistent or throw. list returns every
 * matching key after the exclusive cursor, in ascending order, up to limit. No overwrite/delete API exists.
 * Backend credentials and retention must enforce that same contract outside the content/key backups.
 */
export interface IObjectStore {
  putIfAbsent(key: string, value: string): Promise<boolean>;
  get(key: string): Promise<string | null>;
  list(prefix: string, after: string | null, limit: number): Promise<readonly string[]>;
}
/** Private journal service configuration; the authentication key is independent of content wrapping keys. */
export interface ObjectDeletionJournalOptions {
  objects: IObjectStore;
  journalId: string;
  authenticationKey: Uint8Array;
  maxEntries?: number;
}
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const markSchema = z.strictObject({ journalId: identity, sequence, hash });
const challengeSchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const headSchema = markSchema.extend({ challenge: challengeSchema, proof: hash });
const entrySchema = markSchema.extend({ sequence: sequence.min(1), previousHash: hash,
  binding: z.strictObject({ scopeId: identity, callId: identity, keyId: z.string().regex(/^[a-f0-9]{32}$/) }), proof: hash });
function markOf(value: JournalMark): JournalMark { return markSchema.parse({ journalId: value.journalId, sequence: value.sequence, hash: value.hash }); }
function entryData(e: Pick<JournalEntry, 'journalId' | 'sequence' | 'previousHash' | 'binding'>): string {
  return JSON.stringify(['content-tombstone-v1', e.journalId, e.sequence, e.previousHash, e.binding.scopeId, e.binding.callId, e.binding.keyId]);
}
function headData(mark: JournalMark, challenge: string): string { return JSON.stringify(['content-head-v1', mark.journalId, mark.sequence, mark.hash, challenge]); }
function same(a: ContentKeyBinding, b: ContentKeyBinding): boolean { return a.scopeId === b.scopeId && a.callId === b.callId && a.keyId === b.keyId; }
/**
 * Authenticated numbered objects, with one conditional object creation as the tombstone commit.
 * A fresh process rechecks the complete chain; callers independently supply the live minimum watermark.
 */
export class ObjectDeletionJournal implements DeletionJournal {
  readonly journalId: string;
  private readonly key: Uint8Array;
  private readonly prefix: string;
  private readonly maxEntries: number;
  private observed: JournalMark; private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: ObjectDeletionJournalOptions) {
    this.journalId = identity.parse(options.journalId); this.key = new Uint8Array(options.authenticationKey);
    if (this.key.length !== 32) throw new ContentKeyError('invalid'); this.maxEntries = options.maxEntries ?? 1000000;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > Number.MAX_SAFE_INTEGER - 1) throw new ContentKeyError('invalid');
    this.prefix = `content-journal/${this.journalId}/`; this.observed = contentJournalGenesis(this.journalId);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> { const result = this.tail.then(work); this.tail = result.catch(() => {}); return result; }
  private objectKey(n: number): string { return `${this.prefix}${String(n).padStart(16, '0')}.json`; }
  private mac(data: string): string { return createHmac('sha256', this.key).update(data).digest('hex'); }
  private authentic(data: string, proof: string): void {
    if (!/^[a-f0-9]{64}$/.test(proof) || !timingSafeEqual(Buffer.from(this.mac(data), 'hex'), Buffer.from(proof, 'hex'))) throw new ContentKeyError('unavailable');
  }
  private namespace(mark: JournalMark): void { markSchema.parse(mark); if (mark.journalId !== this.journalId || mark.sequence > this.maxEntries) throw new ContentKeyError('unavailable'); }
  private async load(n: number): Promise<JournalEntry> {
    const text = await this.options.objects.get(this.objectKey(n)); if (text === null || text.length > 4096) throw new ContentKeyError('unavailable');
    const value = entrySchema.parse(JSON.parse(text)); if (value.sequence !== n || value.journalId !== this.journalId) throw new ContentKeyError('unavailable'); return value;
  }
  /** Checks exact closed fields, signature, journal identity and the caller's challenge. */
  verifyHead(input: JournalHead, challenge: string): void {
    const head = headSchema.parse(input); const mark = markOf(head); this.namespace(mark);
    if (head.challenge !== challenge || (mark.sequence === 0 && mark.hash !== contentJournalGenesis(this.journalId).hash)) throw new ContentKeyError('unavailable');
    this.authentic(headData(mark, challenge), head.proof);
  }
  /** Verifies both the authenticated record and its exact predecessor in the chain. */
  verifyEntry(input: JournalEntry, previous: JournalMark): void {
    const entry = entrySchema.parse(input); this.namespace(previous);
    if (entry.journalId !== this.journalId || entry.sequence !== previous.sequence + 1 || entry.sequence > this.maxEntries || entry.previousHash !== previous.hash) throw new ContentKeyError('unavailable');
    const data = entryData(entry); this.authentic(data, entry.proof);
    if (createHash('sha256').update(data).digest('hex') !== entry.hash) throw new ContentKeyError('unavailable');
  }
  /** Reads and authenticates a bounded page after an already authenticated mark. */
  async read(after: JournalMark, through: JournalMark, limit: number): Promise<JournalEntry[]> {
    const start = markOf(after); const end = markOf(through); this.namespace(start); this.namespace(end);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 || end.sequence < start.sequence) throw new ContentKeyError('invalid');
    if (start.sequence === 0) { if (start.hash !== contentJournalGenesis(this.journalId).hash) throw new ContentKeyError('unavailable'); }
    else {
      const anchor = await this.load(start.sequence); this.verifyEntry(anchor, { journalId: this.journalId, sequence: anchor.sequence - 1, hash: anchor.previousHash });
      if (anchor.hash !== start.hash) throw new ContentKeyError('unavailable');
    }
    const rows: JournalEntry[] = []; let cursor = start;
    for (let n = start.sequence + 1; n <= Math.min(end.sequence, start.sequence + limit); n++) {
      const entry = await this.load(n); this.verifyEntry(entry, cursor); rows.push(entry); cursor = markOf(entry);
    }
    if (cursor.sequence === end.sequence && cursor.hash !== end.hash) throw new ContentKeyError('unavailable'); return rows;
  }
  /** Produces a challenge-bound high-water mark only after reading the complete authoritative chain. */
  current(input: string): Promise<JournalHead> { return this.serial(() => this.scanCurrent(input)); } private async scanCurrent(input: string): Promise<JournalHead> {
    const challenge = challengeSchema.parse(input); let cursor = contentJournalGenesis(this.journalId); let after: string | null = null;
    for (;;) {
      const keys = await this.options.objects.list(this.prefix, after, 256); if (keys.length > 256) throw new ContentKeyError('unavailable');
      for (const key of keys) {
        if (cursor.sequence >= this.maxEntries || key !== this.objectKey(cursor.sequence + 1)) throw new ContentKeyError('unavailable');
        const entry = await this.load(cursor.sequence + 1); this.verifyEntry(entry, cursor); cursor = markOf(entry); after = key; if (cursor.sequence === this.observed.sequence && cursor.hash !== this.observed.hash) throw new ContentKeyError('unavailable');
      }
      if (keys.length < 256) {
        // An incomplete listing cannot quietly hide the next committed object.
        if (await this.options.objects.get(this.objectKey(cursor.sequence + 1)) !== null) { const entry = await this.load(cursor.sequence + 1); this.verifyEntry(entry, cursor); cursor = markOf(entry); after = this.objectKey(cursor.sequence); if (cursor.sequence === this.observed.sequence && cursor.hash !== this.observed.hash) throw new ContentKeyError('unavailable'); continue; }
        break;
      }
    }
    if (cursor.sequence < this.observed.sequence || (cursor.sequence === this.observed.sequence && cursor.hash !== this.observed.hash)) throw new ContentKeyError('unavailable');
    this.observed = cursor; return { ...cursor, challenge, proof: this.mac(headData(cursor, challenge)) };
  }
  private async existing(binding: ContentKeyBinding, end: JournalMark): Promise<JournalEntry | undefined> {
    let cursor = contentJournalGenesis(this.journalId);
    while (cursor.sequence < end.sequence) {
      const entries = await this.read(cursor, end, 256); if (!entries.length) throw new ContentKeyError('unavailable');
      for (const entry of entries) {
        const b = entry.binding;
        if (b.keyId === binding.keyId || (b.scopeId === binding.scopeId && b.callId === binding.callId)) { if (!same(b, binding)) throw new ContentKeyError('conflict'); return entry; }
        cursor = markOf(entry);
      }
    }
    return undefined;
  }
  /** Appends once, retrying sequence collisions. A lost acknowledgement is recovered by the same binding. */
  append(input: ContentKeyBinding): Promise<JournalEntry> { const binding = parseContentKeyBinding(input); return this.serial(() => this.appendOnce(binding)); } private async appendOnce(input: ContentKeyBinding): Promise<JournalEntry> {
    const binding = parseContentKeyBinding(input);
    for (let attempt = 0; attempt < 32; attempt++) {
      const head = await this.scanCurrent(randomBytes(32).toString('hex')); const mark = markOf(head);
      const old = await this.existing(binding, mark); if (old) return old;
      if (mark.sequence >= this.maxEntries) throw new ContentKeyError('unavailable');
      const value = { journalId: this.journalId, sequence: mark.sequence + 1, previousHash: mark.hash, binding };
      const data = entryData(value); const entry: JournalEntry = { ...value, hash: createHash('sha256').update(data).digest('hex'), proof: this.mac(data) };
      const encoded = JSON.stringify(entry); const key = this.objectKey(entry.sequence);
      if (!await this.options.objects.putIfAbsent(key, encoded)) continue;
      if (await this.options.objects.get(key) !== encoded) throw new ContentKeyError('unavailable');
      if (entry.sequence > this.observed.sequence) this.observed = markOf(entry); return structuredClone(entry);
    }
    throw new ContentKeyError('unavailable');
  }
  /** Never exposes the journal authentication key or storage credentials during serialization. */
  toJSON(): string { return '[ObjectDeletionJournal]'; }
}
