import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SqlVoiceStore, voicePlatformDdl, VOICE_PLATFORM_TABLES } from '../stores/sql.js';
import { voiceStoreContract } from './voiceStore.contract.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
const prefixes: string[] = [];
const pools: StorageAdapter[] = [];
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function makePair() {
  const prefix = `vp_${run}_${prefixes.length}`;
  prefixes.push(prefix);
  const a = createPostgresAdapter({ connectionString: url!, max: 12 });
  const b = createPostgresAdapter({ connectionString: url!, max: 12 });
  pools.push(a, b);
  await a.open(); await b.open();
  await a.exec(voicePlatformDdl(prefix));
  return [new SqlVoiceStore({ db: a, tablePrefix: prefix, ensureSchema: false }), new SqlVoiceStore({ db: b, tablePrefix: prefix, ensureSchema: false })] as const;
}
describe.skipIf(!url)('PostgreSQL voice transactions', () => {
  voiceStoreContract('PostgreSQL voice store', async () => (await makePair())[0]);
  it('locks a scope across independent pools, then re-reads the committed value', async () => {
    const [a, b] = await makePair();
    await a.withTransaction('scope-a', (tx) => tx.put('idempotency', 'counter', { requestHash: '0', callId: 'call-a', result: null }, 0));
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).withTransaction('scope-a', async (tx) => {
      const row = (await tx.get('idempotency', 'counter'))!;
      await tx.put('idempotency', row.id, { ...row.value, requestHash: String(Number(row.value.requestHash) + 1) }, row.version);
    })));
    expect((await a.withTransaction('scope-a', (tx) => tx.get('idempotency', 'counter')))!.value.requestHash).toBe('20');
  });
  afterAll(async () => {
    if (pools[0]) for (const prefix of prefixes) for (const table of VOICE_PLATFORM_TABLES) await pools[0].exec(`DROP TABLE IF EXISTS ${prefix}_${table}`);
    for (const pool of pools) await pool.close();
  });
});
