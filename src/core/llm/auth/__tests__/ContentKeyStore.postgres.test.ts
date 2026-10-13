import { afterAll, describe } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SqlContentKeyStore } from '../SqlContentKeyStore.js';
import type { ContentKeyRow } from '../ContentKeyLifecycle.js';
import { runContentKeyStoreContract, type ContentStoreHarness } from './contentKeyStore.contract.js';
const url = process.env.AGENTOS_TEST_POSTGRES_URL;
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const prefixes: string[] = []; let db: StorageAdapter | undefined;
async function make(): Promise<ContentStoreHarness> {
  if (!db) { db = createPostgresAdapter({ connectionString: url!, max: 16 }); await db.open(); }
  const connection = db; const prefix = `ck${run}_${prefixes.length + 1}`; prefixes.push(prefix);
  const store = new SqlContentKeyStore({ db: connection, tablePrefix: prefix }); await store.ensureSchema();
  const peer = new SqlContentKeyStore({ db: connection, tablePrefix: prefix, ensureSchema: false });
  return { store, peer,
    backup: async () => (await connection.all<Record<string, unknown>>(`SELECT * FROM ${prefix}_keys`)).map((r): ContentKeyRow => ({ scopeId: String(r.scope_id), callId: String(r.call_id), keyId: String(r.key_id), wrappedKey: r.wrapped_key === null ? null : String(r.wrapped_key), revokedAt: r.revoked_at === null ? null : Number(r.revoked_at) })),
    restore: async (snapshot) => { const target = await make(); for (const row of snapshot) if (!await target.store.insert(row)) throw new Error('snapshot conflict'); return target.store; } };
}
describe.skipIf(!url)('postgres content keys', () => {
  runContentKeyStoreContract('separate transaction connections', make, true);
  afterAll(async () => { if (!db) return; for (const prefix of prefixes) { await db.exec(`DROP TABLE IF EXISTS ${prefix}_keys`); await db.exec(`DROP TABLE IF EXISTS ${prefix}_gate`); } await db.close(); });
});
