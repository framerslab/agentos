import { afterAll, describe, expect, it } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { CONTENT_KEY_STORE_DDL, contentKeyStoreDdl, SqlContentKeyStore } from '../SqlContentKeyStore.js';
import type { ContentKeyRow } from '../ContentKeyLifecycle.js';
import { runContentKeyStoreContract, type ContentStoreHarness } from './contentKeyStore.contract.js';
const databases: StorageAdapter[] = []; let serial = 0;
async function make(): Promise<ContentStoreHarness> {
  const db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true }); databases.push(db);
  const prefix = `content_${++serial}`; const options = { db, tablePrefix: prefix, requireShared: false };
  const store = new SqlContentKeyStore(options); await store.ensureSchema();
  return { store, peer: new SqlContentKeyStore({ ...options, ensureSchema: false }),
    backup: async () => (await db.all<Record<string, unknown>>(`SELECT * FROM ${prefix}_keys`)).map((r): ContentKeyRow => ({ scopeId: String(r.scope_id), callId: String(r.call_id), keyId: String(r.key_id), wrappedKey: r.wrapped_key === null ? null : String(r.wrapped_key), revokedAt: r.revoked_at === null ? null : Number(r.revoked_at) })),
    restore: async (snapshot) => { const target = await make(); for (const row of snapshot) if (!await target.store.insert(row)) throw new Error('snapshot conflict'); return target.store; } };
}
runContentKeyStoreContract('sqlite content keys', make, false);
afterAll(async () => { for (const db of databases) await db.close(); });
describe('content key SQL configuration', () => {
  it('exports portable checked-prefix DDL and respects host-managed migrations', async () => {
    expect(contentKeyStoreDdl()).toBe(CONTENT_KEY_STORE_DDL); expect(contentKeyStoreDdl('private_keys')).toContain('CREATE TABLE IF NOT EXISTS private_keys_gate');
    expect(() => contentKeyStoreDdl('9bad')).toThrow(); expect(() => contentKeyStoreDdl('x'.repeat(39))).toThrow();
    const db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true }); databases.push(db);
    expect(() => new SqlContentKeyStore({ db })).toThrow('several processes');
    const store = new SqlContentKeyStore({ db, tablePrefix: 'manual', ensureSchema: false, requireShared: false });
    await store.ensureSchema(); await expect(db.get('SELECT 1 FROM manual_keys')).rejects.toThrow();
    await db.exec(contentKeyStoreDdl('manual')); expect(JSON.stringify(store)).toBe('"[SqlContentKeyStore]"');
  });
});
