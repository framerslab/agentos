/**
 * The supplier transcription credit contract over Postgres: every fixture's transactions come from one pool and queue
 * on the database's own row locks. Then the store's binding to a host transaction: an existing store gains the
 * documents table, and host and credit writes roll back together. Gated on `AGENTOS_TEST_POSTGRES_URL` (CI's service
 * container), and required in CI. Each case runs on tables under a prefix of its own, dropped after the run.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SqlCompoundCreditStore } from '../SqlCompoundCreditStore.js';
import { configureTranscriptionCredit, makeTranscriptionCreditRecord } from '../TranscriptionCredit.js';
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

describe.skipIf(!url)('supplier transaction binding', () => {
  it('upgrades existing stores and rolls back host and credit writes together', async () => {
    const database = createPostgresAdapter({ connectionString: url! });
    await database.open();
    const prefix = `tb_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const store = new SqlCompoundCreditStore({ db: database, tablePrefix: prefix });
    const marker = `${prefix}_marker`;
    try {
      await store.ensureSchema();
      await database.exec(`DROP TABLE ${prefix}_documents`);
      const upgraded = new SqlCompoundCreditStore({ db: database, tablePrefix: prefix });
      await upgraded.ensureSchema();
      await database.exec(`CREATE TABLE ${marker} (id TEXT PRIMARY KEY)`);
      const at = Date.UTC(2026, 9, 14, 12);
      const record = makeTranscriptionCreditRecord({ vendor: 'deepgram', amountMicro: 4800,
        readAtMs: at - 1000, validUntilMs: at + 86400000,
        projectId: '00000000-0000-4000-8000-000000000001', contractVersion: 'synthetic-contract' });
      await expect(database.transaction(async (adapter) => {
        await adapter.run(`INSERT INTO ${marker} (id) VALUES (?)`, ['host']);
        await upgraded.withStorageTransaction(adapter, (t) => configureTranscriptionCredit(t, {
          scopeId: 'atomic', record, at,
        }));
        throw new Error('abort both');
      })).rejects.toThrow('abort both');
      expect(await database.all(`SELECT * FROM ${marker}`)).toHaveLength(0);
      expect(await upgraded.withTransaction((t) => t.lockAccount('atomic'))).toBeUndefined();
      await upgraded.withTransaction(async (t) => {
        await t.putDocument!({ scopeId: 'cas', documentId: 'one', value: '1', version: 1 });
      });
      await expect(upgraded.withTransaction(async (t) => {
        await t.putDocument!({ scopeId: 'cas', documentId: 'one', value: 'wrong', version: 1 });
      })).rejects.toThrow('changed under');
      expect(await upgraded.withTransaction((t) => t.getDocument!('cas', 'one'))).toMatchObject({ value: '1', version: 1 });
    } finally {
      for (const suffix of ['marker', ...TABLES]) await database.exec(`DROP TABLE IF EXISTS ${prefix}_${suffix}`);
      await database.close();
    }
  });
});
