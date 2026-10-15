import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { ContentKeyError, parseContentKeyBinding, type ContentKeyBinding, type ContentKeyRow, type ContentKeyStore } from './ContentKeyLifecycle.js';
const prefixPattern = /^[a-z][a-z0-9_]{0,37}$/;
function prefixOf(value = 'agentos_content'): string { if (!prefixPattern.test(value)) throw new ContentKeyError('invalid'); return value; }
/**
 * Portable DDL for a separate private key-service database. The singleton row serializes leases and
 * tombstones, including identities absent from a restored snapshot. No readiness flag is persisted.
 */
export function contentKeyStoreDdl(tablePrefix?: string): string {
  const p = prefixOf(tablePrefix);
  return `
CREATE TABLE IF NOT EXISTS ${p}_gate (
  gate_id INTEGER PRIMARY KEY CHECK (gate_id = 1),
  fence BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ${p}_keys (
  key_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  wrapped_key TEXT,
  revoked_at BIGINT,
  UNIQUE (scope_id, call_id),
  CHECK ((revoked_at IS NULL AND wrapped_key IS NOT NULL) OR (revoked_at IS NOT NULL AND revoked_at >= 1 AND wrapped_key IS NULL))
);
`;
}
/** Default private key-store DDL; hosts may copy a custom prefix into their own migrations. */
export const CONTENT_KEY_STORE_DDL = contentKeyStoreDdl();
/** A dedicated adapter/pool, separate from the product database and its credentials/backups. */
export interface SqlContentKeyStoreOptions {
  db: StorageAdapter;
  tablePrefix?: string;
  ensureSchema?: boolean;
  requireShared?: boolean;
}
function decode(row: Record<string, unknown>): ContentKeyRow {
  const binding = parseContentKeyBinding({ scopeId: row.scope_id, callId: row.call_id, keyId: row.key_id });
  const revokedAt = row.revoked_at === null ? null : Number(row.revoked_at);
  const wrappedKey = row.wrapped_key === null ? null : String(row.wrapped_key);
  if ((revokedAt === null && !wrappedKey) || (revokedAt !== null && (!Number.isSafeInteger(revokedAt) || revokedAt < 1 || wrappedKey !== null))) throw new ContentKeyError('invalid');
  return { ...binding, wrappedKey, revokedAt };
}
/** Cross-process lease barriers over SQL. It stores only wrapped keys, never wrapping-key custody. */
export class SqlContentKeyStore implements ContentKeyStore {
  private readonly prefix: string; private schema?: Promise<void>;
  constructor(private readonly options: SqlContentKeyStoreOptions) {
    this.prefix = prefixOf(options.tablePrefix); const caps = options.db.capabilities;
    if (!caps.has('transactions')) throw new Error('SqlContentKeyStore requires transactions');
    if (options.requireShared !== false && (!caps.has('persistence') || !caps.has('concurrent'))) throw new Error('SqlContentKeyStore needs a store several processes share');
  }
  /** Creates both tables once, or leaves schema entirely to host migrations when disabled. */
  ensureSchema(): Promise<void> {
    if (this.options.ensureSchema === false) return Promise.resolve();
    this.schema ??= this.options.db.exec(contentKeyStoreDdl(this.prefix)).then(() => undefined).catch((error) => { this.schema = undefined; throw error; }); return this.schema;
  }
  /** Recovers a scoped permanent reference without exporting wrapped material. */ findByCall(scopeId: string, callId: string): Promise<ContentKeyBinding | undefined> { parseContentKeyBinding({ scopeId, callId, keyId: '0'.repeat(32) }); return this.transaction(async (db) => { const raw = await db.get<Record<string, unknown>>(`SELECT * FROM ${this.prefix}_keys WHERE scope_id = ? AND call_id = ?`, [scopeId, callId]); if (!raw) return undefined; const row = decode(raw); return { scopeId: row.scopeId, callId: row.callId, keyId: row.keyId }; }); }
  private async transaction<T>(work: (db: StorageAdapter) => Promise<T>): Promise<T> {
    await this.ensureSchema();
    return this.options.db.transaction(async (db) => {
      await db.run(`INSERT INTO ${this.prefix}_gate (gate_id, fence) VALUES (1, 0) ON CONFLICT DO NOTHING`);
      const locked = await db.run(`UPDATE ${this.prefix}_gate SET fence = fence WHERE gate_id = 1`);
      if (locked.changes !== 1) throw new ContentKeyError('unavailable'); return work(db);
    });
  }
  /** Allocates both key id and scope/call once; a conflict cannot reactivate a destroyed key. */
  insert(input: ContentKeyRow): Promise<boolean> {
    const row = structuredClone(input); const b = parseContentKeyBinding({ scopeId: row.scopeId, callId: row.callId, keyId: row.keyId });
    if (row.revokedAt !== null || typeof row.wrappedKey !== 'string' || !row.wrappedKey || row.wrappedKey.length > 4096) throw new ContentKeyError('invalid');
    return this.transaction(async (db) => {
      const result = await db.run(`INSERT INTO ${this.prefix}_keys (key_id, scope_id, call_id, wrapped_key, revoked_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT DO NOTHING`, [b.keyId, b.scopeId, b.callId, row.wrappedKey]);
      return result.changes === 1;
    });
  }
  /** Keeps the gate's transaction open until every awaited use of the bytes finishes or aborts. */
  withKey<T>(input: ContentKeyBinding, work: (row: Readonly<ContentKeyRow> | undefined) => Promise<T>): Promise<T> {
    const b = parseContentKeyBinding(input);
    return this.transaction(async (db) => {
      const row = await db.get<Record<string, unknown>>(`SELECT * FROM ${this.prefix}_keys WHERE key_id = ? AND scope_id = ? AND call_id = ?`, [b.keyId, b.scopeId, b.callId]);
      return work(row ? decode(row) : undefined);
    });
  }
  /** Erases wrapped bytes under the lease barrier, preserving a monotonic content-free tombstone. */
  destroy(input: ContentKeyBinding, sequence: number): Promise<void> {
    const b = parseContentKeyBinding(input); if (!Number.isSafeInteger(sequence) || sequence < 1) throw new ContentKeyError('invalid');
    return this.transaction(async (db) => {
      await db.run(`INSERT INTO ${this.prefix}_keys (key_id, scope_id, call_id, wrapped_key, revoked_at) VALUES (?, ?, ?, NULL, ?) ON CONFLICT DO NOTHING`, [b.keyId, b.scopeId, b.callId, sequence]);
      const raw = await db.get<Record<string, unknown>>(`SELECT * FROM ${this.prefix}_keys WHERE key_id = ?`, [b.keyId]);
      if (!raw) throw new ContentKeyError('conflict'); const row = decode(raw);
      if (row.scopeId !== b.scopeId || row.callId !== b.callId) throw new ContentKeyError('conflict');
      const result = await db.run(`UPDATE ${this.prefix}_keys SET wrapped_key = NULL, revoked_at = ? WHERE key_id = ? AND scope_id = ? AND call_id = ?`, [Math.max(sequence, row.revokedAt ?? 0), b.keyId, b.scopeId, b.callId]);
      if (result.changes !== 1) throw new ContentKeyError('conflict');
    });
  }
  /** Redacts the adapter and connection details. */
  toJSON(): string { return '[SqlContentKeyStore]'; }
}
