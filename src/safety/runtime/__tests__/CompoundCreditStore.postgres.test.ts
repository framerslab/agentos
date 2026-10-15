/**
 * The compound credit store and ledger over Postgres, where several processes share them: both contracts with their
 * concurrent cases (twenty reservations racing for the credit of five; settlements, a refund, an expiry and a dispute
 * racing on one lot). Gated on `AGENTOS_TEST_POSTGRES_URL` (CI's service container); skipped without it. Each test runs
 * on tables under a prefix of this run's own, dropped after the run.
 */
import { afterAll, describe } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SqlCompoundCreditStore } from '../SqlCompoundCreditStore.js';
import { runCompoundCreditStoreContract } from './compoundCreditStore.contract.js';
import { runCompoundCreditLedgerContract } from './compoundCreditLedger.contract.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TABLES = ['accounts', 'lots', 'holds', 'allocations', 'attempts', 'entries', 'supplier_days', 'documents'];
const made: string[] = [];
let db: StorageAdapter | undefined;

async function make() {
  if (!db) {
    db = createPostgresAdapter({ connectionString: POSTGRES_URL!, max: 25 });
    await db.open();
  }
  const prefix = `cc${RUN}_${made.length + 1}`;
  made.push(prefix);
  return { store: new SqlCompoundCreditStore({ db, tablePrefix: prefix }), id: (s: string) => s };
}

describe.skipIf(!POSTGRES_URL)('postgres', () => {
  runCompoundCreditStoreContract('postgres', make, { concurrent: true });
  runCompoundCreditLedgerContract('postgres', make, { concurrent: true });
  afterAll(async () => {
    if (!db) return;
    for (const prefix of made) for (const table of TABLES) await db.exec(`DROP TABLE IF EXISTS ${prefix}_${table}`);
    await db.close();
  });
});
