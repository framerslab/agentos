import { randomUUID } from 'node:crypto';
import { describe } from 'vitest';
import { createPostgresAdapter } from '@framers/sql-storage-adapter';
import { SqlTelephonyCallStore, telephonyCallStoreDdl } from '../TelephonyCallStore.js';
import { carrierStoreContract } from './carrier-store.contract.js';
const url = process.env.AGENTOS_TEST_POSTGRES_URL;
if (process.env.CI && !url) throw new Error('carrier PostgreSQL CI service required');
// Outside CI, a run without the variable reports these cases as skipped, as the other Postgres suites do.
describe.skipIf(!url)('carrier store on PostgreSQL', () => carrierStoreContract('PostgreSQL carrier transactions', async () => {
  const prefix = `tc_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const a = createPostgresAdapter({ connectionString: url, max: 5 }); const b = createPostgresAdapter({ connectionString: url, max: 5 });
  await a.open(); await b.open(); await a.exec(telephonyCallStoreDdl(prefix));
  return { first: new SqlTelephonyCallStore(a, prefix), second: new SqlTelephonyCallStore(b, prefix), close: async () => {
    for (const suffix of ['aliases', 'calls', 'anchors']) await a.exec(`DROP TABLE IF EXISTS ${prefix}_${suffix}`);
    await a.close(); await b.close();
  } };
}));
