import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { openSecret, sealSecret, type SealingKey } from './sealing.js';
/** Permanent identity of a call's content key. This is safe metadata, never a bearer credential. */
export interface ContentKeyBinding { scopeId: string; callId: string; keyId: string }
/** Authenticated context for one stored object; a call may have many objects under its one key. */
export interface ContentObject { purpose: 'transcript' | 'delivery'; objectId: string }
/** Wrapped material is restricted to the private key database, separate from the content database. */
export interface ContentKeyRow extends ContentKeyBinding { wrappedKey: string | null; revokedAt: number | null }
/** Immutable position in the independent append-only journal. */
export interface JournalMark { journalId: string; sequence: number; hash: string }
/** A current mark signed over a caller's fresh random challenge. */
export interface JournalHead extends JournalMark { challenge: string; proof: string }
/** Content-free tombstone; sequence is its durable revocation epoch. */
export interface JournalEntry extends JournalMark { previousHash: string; binding: ContentKeyBinding; proof: string }
/** Authority with no deletion, overwrite or rollback operation. All reads must fail when not authoritative. */
export interface DeletionJournal {
  readonly journalId: string;
  current(challenge: string): Promise<JournalHead>;
  verifyHead(head: JournalHead, challenge: string): void;
  verifyEntry(entry: JournalEntry, previous: JournalMark): void;
  read(after: JournalMark, through: JournalMark, limit: number): Promise<JournalEntry[]>;
  append(binding: ContentKeyBinding): Promise<JournalEntry>;
}
/**
 * A lease is the complete awaited withKey callback, including consumers of decrypted bytes.
 * insert and destroy serialize with leases across all processes sharing this store. Destroy retains
 * a content-free identity forever, including when the key was missing from an old restored snapshot.
 */
export interface ContentKeyStore {
  insert(row: ContentKeyRow): Promise<boolean>;
  findByCall(scopeId: string, callId: string): Promise<ContentKeyBinding | undefined>;
  withKey<T>(binding: ContentKeyBinding, work: (row: Readonly<ContentKeyRow> | undefined) => Promise<T>): Promise<T>;
  destroy(binding: ContentKeyBinding, sequence: number): Promise<void>;
}
/** Positive evidence from a trusted host hook, with no content in the reference. */
export interface ContentAcknowledgement { completed: true; evidenceRef: string }
/** Application effects use existing call/outbox fences, with idempotency keyed by binding and journal sequence. */
export interface ContentKeyHooks {
  fenceAll(): Promise<ContentAcknowledgement>;
  fenceContent(binding: ContentKeyBinding, mark: JournalMark): Promise<ContentAcknowledgement>;
  cleanupContent(binding: ContentKeyBinding, mark: JournalMark): Promise<ContentAcknowledgement>;
}
/** Private service dependencies. Wrapping custody and the current journal minimum are outside both backups. */
export interface ContentKeyServiceOptions {
  store: ContentKeyStore; journal: DeletionJournal; hooks: ContentKeyHooks;
  minimumJournalMark(): Promise<JournalMark>;
  wrappingKeys(): Promise<{ active: SealingKey; previous: readonly SealingKey[] }>;
  maxLeases?: number;
  maxTombstones?: number;
}
/** Content-free error suitable for an authenticated host's error mapping. */
export class ContentKeyError extends Error {
  constructor(readonly code: 'sealed' | 'revoked' | 'unavailable' | 'conflict' | 'invalid' | 'incomplete') { super(`content key ${code}`); this.name = 'ContentKeyError'; }
}
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const bindingSchema = z.strictObject({ scopeId: id, callId: id, keyId: z.string().regex(/^[a-f0-9]{32}$/) });
const objectSchema = z.strictObject({ purpose: z.enum(['transcript', 'delivery']), objectId: id });
const markSchema = z.strictObject({ journalId: id, sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), hash: z.string().regex(/^[a-f0-9]{64}$/) });
const copy = <T>(value: T): T => structuredClone(value);
const callKey = (b: Pick<ContentKeyBinding, 'scopeId' | 'callId'>): string => JSON.stringify([b.scopeId, b.callId]);
const sameBinding = (a: ContentKeyBinding, b: ContentKeyBinding): boolean => a.scopeId === b.scopeId && a.callId === b.callId && a.keyId === b.keyId;
const markOf = (e: JournalMark): JournalMark => markSchema.parse({ journalId: e.journalId, sequence: e.sequence, hash: e.hash });
/** Validates a copied identity before a storage adapter uses its values. */
export function parseContentKeyBinding(value: unknown): ContentKeyBinding { try { return bindingSchema.parse(value); } catch { throw new ContentKeyError('invalid'); } }
/** The fixed start of a journal's authenticated chain. It is not evidence that an existing journal is empty. */
export function contentJournalGenesis(journalId: string): JournalMark {
  id.parse(journalId); return { journalId, sequence: 0, hash: createHash('sha256').update(JSON.stringify(['content-journal-v1', journalId])).digest('hex') };
}
function acknowledge(value: ContentAcknowledgement): void { if (value?.completed !== true || typeof value.evidenceRef !== 'string' || !value.evidenceRef || value.evidenceRef.length > 256) throw new ContentKeyError('incomplete'); }
function context(kind: 'wrap' | 'object', b: ContentKeyBinding, object?: ContentObject): string { return JSON.stringify(['content-key-v1', kind, b.scopeId, b.callId, b.keyId, object?.purpose ?? null, object?.objectId ?? null]); }
/** Memory implementation for a single private service or tests. Use the SQL adapter across processes. */
export class InMemoryContentKeyStore implements ContentKeyStore {
  private readonly rows = new Map<string, ContentKeyRow>(); private tail: Promise<void> = Promise.resolve();
  constructor(snapshot: readonly ContentKeyRow[] = []) {
    for (const raw of snapshot) { const b = parseContentKeyBinding({ scopeId: raw.scopeId, callId: raw.callId, keyId: raw.keyId }); if (this.rows.has(b.keyId) || [...this.rows.values()].some((r) => callKey(r) === callKey(b))) throw new ContentKeyError('conflict'); this.rows.set(b.keyId, copy(raw)); }
  }
  private async lock<T>(fn: () => Promise<T>): Promise<T> {
    const before = this.tail; let release!: () => void; this.tail = new Promise<void>((resolve) => { release = resolve; }); await before;
    try { return await fn(); } finally { release(); }
  }
  /** Inserts once; even a tombstone reserves both the key id and the call forever. */
  insert(raw: ContentKeyRow): Promise<boolean> {
    const row = copy(raw); parseContentKeyBinding({ scopeId: row.scopeId, callId: row.callId, keyId: row.keyId }); if (row.revokedAt !== null || typeof row.wrappedKey !== 'string' || !row.wrappedKey || row.wrappedKey.length > 4096) throw new ContentKeyError('invalid');
    return this.lock(async () => { if (this.rows.has(row.keyId) || [...this.rows.values()].some((r) => callKey(r) === callKey(row))) return false; this.rows.set(row.keyId, row); return true; });
  }
  /** Holds the exclusive key-service barrier until the consumer finishes, including a rejected consumer. */
  withKey<T>(raw: ContentKeyBinding, work: (row: Readonly<ContentKeyRow> | undefined) => Promise<T>): Promise<T> {
    const binding = parseContentKeyBinding(raw); return this.lock(async () => { const row = this.rows.get(binding.keyId); return work(row && sameBinding(row, binding) ? copy(row) : undefined); });
  }
  /** Waits for readers, removes wrapped bytes and permanently keeps the largest revocation epoch. */
  destroy(raw: ContentKeyBinding, sequence: number): Promise<void> {
    const b = parseContentKeyBinding(raw); if (!Number.isSafeInteger(sequence) || sequence < 1) throw new ContentKeyError('invalid');
    return this.lock(async () => { const old = this.rows.get(b.keyId); if ((old && !sameBinding(old, b)) || [...this.rows.values()].some((r) => callKey(r) === callKey(b) && r.keyId !== b.keyId)) throw new ContentKeyError('conflict'); this.rows.set(b.keyId, { ...b, wrappedKey: null, revokedAt: Math.max(sequence, old?.revokedAt ?? 0) }); });
  }
  /** Copies encrypted rows for single-process fixtures; never a production backup authority. */
  snapshot(): ContentKeyRow[] { return [...this.rows.values()].map(copy); }
  /** Recovers a permanent reference by its scoped call, including after a lost creation response. */ findByCall(scopeId: string, callId: string): Promise<ContentKeyBinding | undefined> { id.parse(scopeId); id.parse(callId); return this.lock(async () => { const row = [...this.rows.values()].find((r) => r.scopeId === scopeId && r.callId === callId); return row ? { scopeId, callId, keyId: row.keyId } : undefined; }); }
  /** Redacts private storage when a host serializes this object. */
  toJSON(): string { return '[InMemoryContentKeyStore]'; }
}
interface Lease { binding: ContentKeyBinding; abort: AbortController; done: Promise<void>; finish(): void }
/** Mediates all content encryption and decryption; constructed sealed, with no plaintext-key cache. */
export class ContentKeyService {
  private enabled = false; private restoring?: Promise<JournalMark>; private refreshTail: Promise<unknown> = Promise.resolve();
  private mark: JournalMark; private readonly revoked = new Map<string, JournalEntry>(); private readonly leases = new Set<Lease>();
  private readonly maxLeases: number; private readonly maxTombstones: number;
  constructor(private readonly options: ContentKeyServiceOptions) {
    this.mark = contentJournalGenesis(options.journal.journalId); this.maxLeases = options.maxLeases ?? 128; this.maxTombstones = options.maxTombstones ?? 1000000;
    for (const n of [this.maxLeases, this.maxTombstones]) if (!Number.isSafeInteger(n) || n < 1) throw new ContentKeyError('invalid');
  }
  /** Hosts enable workers only after successful restore; an authoritative-read failure turns this false. */
  get ready(): boolean { return this.enabled; }
  private seal(): void { this.enabled = false; for (const lease of this.leases) lease.abort.abort(); }
  private requireReady(): void { if (!this.enabled) throw new ContentKeyError('sealed'); }
  private refused(binding: ContentKeyBinding): void { if (this.revoked.has(callKey(binding)) || [...this.revoked.values()].some((e) => e.binding.keyId === binding.keyId)) throw new ContentKeyError('revoked'); }
  private refresh(): Promise<JournalMark> {
    const run = this.refreshTail.then(async () => {
      try {
        const minimum = markOf(await this.options.minimumJournalMark()); const challenge = randomBytes(32).toString('hex');
        const head = copy(await this.options.journal.current(challenge)); this.options.journal.verifyHead(head, challenge); const target = markOf(head);
        if (minimum.journalId !== this.mark.journalId || target.journalId !== this.mark.journalId || target.sequence < Math.max(this.mark.sequence, minimum.sequence) || (minimum.sequence === this.mark.sequence && minimum.hash !== this.mark.hash) || (target.sequence === minimum.sequence && target.hash !== minimum.hash)) throw new Error('journal floor');
        while (this.mark.sequence < target.sequence) {
          const batch = await this.options.journal.read(copy(this.mark), target, Math.min(256, target.sequence - this.mark.sequence));
          if (!batch.length || batch.length > 256) throw new Error('journal gap');
          for (const raw of batch) {
            const entry = copy(raw); const next = markOf(entry); const binding = parseContentKeyBinding(entry.binding);
            if (next.journalId !== this.mark.journalId || next.sequence !== this.mark.sequence + 1 || next.sequence > target.sequence || entry.previousHash !== this.mark.hash) throw new Error('journal chain');
            this.options.journal.verifyEntry(entry, this.mark);
            if (next.sequence === minimum.sequence && next.hash !== minimum.hash) throw new Error('journal floor hash');
            const old = this.revoked.get(callKey(binding)); if (old && !sameBinding(old.binding, binding)) throw new Error('journal identity');
            if (!old && this.revoked.size >= this.maxTombstones) throw new Error('journal capacity');
            this.revoked.set(callKey(binding), entry); this.mark = next;
            for (const lease of this.leases) if (sameBinding(lease.binding, binding)) lease.abort.abort();
          }
        }
        if (this.mark.hash !== target.hash) throw new Error('journal final hash'); return copy(this.mark);
      } catch { this.seal(); throw new ContentKeyError('unavailable'); }
    }); this.refreshTail = run.catch(() => {}); return run;
  }
  private async keys(): Promise<{ active: SealingKey; all: SealingKey[] }> {
    const input = await this.options.wrappingKeys(); const all = [input.active, ...input.previous].map((key) => ({ id: key.id, key: new Uint8Array(key.key) }));
    if (all.some((key) => !/^[A-Za-z0-9_-]{1,32}$/.test(key.id) || key.key.length !== 32) || new Set(all.map((key) => key.id)).size !== all.length) { all.forEach((key) => key.key.fill(0)); throw new ContentKeyError('invalid'); }
    return { active: all[0]!, all };
  }
  /** Recovers an existing live scope/call reference after rechecking journal authority. */
  private async recover(scopeId: string, callId: string): Promise<ContentKeyBinding | undefined> { const found = await this.options.store.findByCall(scopeId, callId); if (!found) return undefined; const binding = parseContentKeyBinding(found); if (binding.scopeId !== scopeId || binding.callId !== callId) throw new ContentKeyError('invalid'); await this.options.store.withKey(binding, async (row) => { if (!row || row.revokedAt !== null || !row.wrappedKey) throw new ContentKeyError('revoked'); }); await this.refresh(); this.requireReady(); this.refused(binding); return Object.freeze(binding); }
  /** Creates or recovers one permanent live key reference for this scoped call. */ async create(scopeId: string, callId: string): Promise<ContentKeyBinding> {
    this.requireReady(); const binding = parseContentKeyBinding({ scopeId, callId, keyId: randomBytes(16).toString('hex') });
    await this.refresh(); this.requireReady(); this.refused(binding); const old = await this.recover(scopeId, callId); if (old) return old; const keys = await this.keys(); const raw = randomBytes(32);
    try {
      const wrappedKey = sealSecret(raw, keys.active.key, keys.active.id, context('wrap', binding));
      if (!await this.options.store.insert({ ...binding, wrappedKey, revokedAt: null })) { const found = await this.recover(scopeId, callId); if (found) return found; throw new ContentKeyError('conflict'); }
      await this.refresh(); this.requireReady(); this.refused(binding); return Object.freeze(binding);
    } finally { raw.fill(0); keys.all.forEach((key) => key.key.fill(0)); }
  }
  private async use<T>(binding: ContentKeyBinding, work: (key: Uint8Array, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.requireReady(); await this.refresh(); this.requireReady(); this.refused(binding);
    if (this.leases.size >= this.maxLeases) throw new ContentKeyError('unavailable');
    let finish!: () => void; const lease: Lease = { binding, abort: new AbortController(), done: new Promise<void>((resolve) => { finish = resolve; }), finish: () => finish() }; this.leases.add(lease);
    try {
      return await this.options.store.withKey(binding, async (row) => {
        this.requireReady(); await this.refresh(); this.refused(binding); lease.abort.signal.throwIfAborted();
        if (!row || row.revokedAt !== null || !row.wrappedKey) throw new ContentKeyError('revoked');
        const keys = await this.keys(); let key: Uint8Array | undefined;
        try {
          key = openSecret(row.wrappedKey, keys.all, context('wrap', binding)); if (key.length !== 32) throw new ContentKeyError('invalid');
          lease.abort.signal.throwIfAborted(); const result = await work(key, lease.abort.signal);
          await this.refresh(); this.requireReady(); this.refused(binding); lease.abort.signal.throwIfAborted(); return result;
        } finally { key?.fill(0); keys.all.forEach((value) => value.key.fill(0)); }
      });
    } catch (error) { if (error instanceof ContentKeyError) throw error; throw new ContentKeyError('incomplete'); }
    finally { this.leases.delete(lease); lease.finish(); }
  }
  /** Encrypts a bounded object under its own context without exposing the content key. */
  async encrypt(raw: ContentKeyBinding, input: ContentObject, bytes: Uint8Array): Promise<string> {
    const binding = parseContentKeyBinding(raw); const object = objectSchema.parse(input); if (bytes.byteLength > 1048576) throw new ContentKeyError('invalid'); const plain = new Uint8Array(bytes);
    try { return await this.use(binding, async (key) => sealSecret(plain, key, binding.keyId, context('object', binding, object))); } finally { plain.fill(0); }
  }
  /** Decrypts only during the awaited consumer. The consumer must finish sends or abort before returning. */
  async open(raw: ContentKeyBinding, input: ContentObject, sealed: string, consume: (bytes: Uint8Array, signal: AbortSignal) => Promise<void>): Promise<void> {
    const binding = parseContentKeyBinding(raw); const object = objectSchema.parse(input); if (typeof sealed !== 'string' || sealed.length > 1500000) throw new ContentKeyError('invalid');
    await this.use(binding, async (key, signal) => { const plain = openSecret(sealed, [{ id: binding.keyId, key }], context('object', binding, object)); try { if (plain.length > 1048576) throw new ContentKeyError('invalid'); await consume(plain, signal); } finally { plain.fill(0); } });
  }
  private async finishRevocation(entry: JournalEntry): Promise<void> {
    for (const lease of this.leases) if (sameBinding(lease.binding, entry.binding)) lease.abort.abort();
    try {
      acknowledge(await this.options.hooks.fenceContent(copy(entry.binding), markOf(entry)));
      await this.options.store.destroy(entry.binding, entry.sequence);
      acknowledge(await this.options.hooks.cleanupContent(copy(entry.binding), markOf(entry)));
    } catch { this.seal(); throw new ContentKeyError('incomplete'); }
  }
  /** Commits the tombstone first, then fences consumers, destroys wrapped material and awaits content cleanup. */
  async revoke(raw: ContentKeyBinding): Promise<JournalMark> {
    const binding = parseContentKeyBinding(raw);
    try { await this.options.journal.append(binding); } catch { this.seal(); throw new ContentKeyError('unavailable'); }
    await this.refresh(); const entry = this.revoked.get(callKey(binding)); if (!entry || !sameBinding(entry.binding, binding)) { this.seal(); throw new ContentKeyError('unavailable'); }
    await this.finishRevocation(entry); return markOf(entry);
  }
  /** Restores only while sealed. All journal tombstones are reapplied, including absent rows in older snapshots. */
  restore(): Promise<JournalMark> {
    if (this.restoring) return this.restoring; this.seal();
    this.restoring = (async () => {
      try {
        acknowledge(await this.options.hooks.fenceAll()); await Promise.all([...this.leases].map((lease) => lease.done));
        const applied = new Set<string>();
        for (let pass = 0; pass < 32; pass++) {
          const before = await this.refresh();
          for (const entry of this.revoked.values()) if (!applied.has(entry.hash)) { await this.finishRevocation(entry); applied.add(entry.hash); }
          const after = await this.refresh(); if (before.sequence === after.sequence && before.hash === after.hash) { this.enabled = true; return after; }
        }
        throw new ContentKeyError('unavailable');
      } catch (error) { this.seal(); if (error instanceof ContentKeyError) throw error; throw new ContentKeyError('incomplete'); }
    })().finally(() => { this.restoring = undefined; }); return this.restoring;
  }
  /** Redacts dependencies and key custody when a host serializes the service. */
  toJSON(): string { return '[ContentKeyService]'; }
}
/** Creates a never-reused key reference in a restored private key service. */
export function createContentKey(service: ContentKeyService, scopeId: string, callId: string): Promise<ContentKeyBinding> { return service.create(scopeId, callId); }
/** Seals one text/delivery object without exporting key material. */
export function sealContent(service: ContentKeyService, binding: ContentKeyBinding, object: ContentObject, bytes: Uint8Array): Promise<string> { return service.encrypt(binding, object, bytes); }
/** Mediates a decrypt for the duration of one awaited consumer lease. */
export function openContent(service: ContentKeyService, binding: ContentKeyBinding, object: ContentObject, sealed: string, consume: (bytes: Uint8Array, signal: AbortSignal) => Promise<void>): Promise<void> { return service.open(binding, object, sealed, consume); }
/** Completes deletion only after journal, lease, key and content acknowledgements. */
export function revokeContentKey(service: ContentKeyService, binding: ContentKeyBinding): Promise<JournalMark> { return service.revoke(binding); }
/** Replays the independently current deletion authority before permitting decrypts or workers. */
export function restoreContentKeys(service: ContentKeyService): Promise<JournalMark> { return service.restore(); }
