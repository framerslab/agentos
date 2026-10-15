/**
 * The supplier transcription credit contract over Postgres: every fixture's transactions come from one pool and queue
 * on the database's own row locks. Gated on `AGENTOS_TEST_POSTGRES_URL` (CI's service container), and required in CI.
 * Each fixture runs on tables under a prefix of its own, dropped after the run.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SqlCompoundCreditStore } from '../SqlCompoundCreditStore.js';
import { runTranscriptionCreditContract } from './transcriptionCredit.contract.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
if (process.env.CI && !url) throw new Error('supplier credit PostgreSQL CI service is required');
const TABLES = ['documents', 'allocations', 'attempts', 'entries', 'holds', 'lots', 'supplier_days', 'accounts'];
const made: string[] = [];
let db: StorageAdapter | undefined;

describe.skipIf(!url)('postgres supplier credit', () => {
  runTranscriptionCreditContract('shared transactions', async () => {
    if (!db) {
      db = createPostgresAdapter({ connectionString: url!, max: 16 });
      await db.open();
    }
    const prefix = `tc_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    made.push(prefix);
    const store = new SqlCompoundCreditStore({ db, tablePrefix: prefix });
    await store.ensureSchema();
    return store;
  });
  afterAll(async () => {
    if (!db) return;
    for (const prefix of made) for (const suffix of TABLES) await db.exec(`DROP TABLE IF EXISTS ${prefix}_${suffix}`);
    await db.close();
  });
});
