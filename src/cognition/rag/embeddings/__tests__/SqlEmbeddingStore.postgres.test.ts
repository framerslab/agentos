/**
 * @fileoverview `SqlEmbeddingStore` on a real PostgreSQL, a table of its own a case. Gated on
 * AGENTOS_TEST_POSTGRES_URL, as the other Postgres tests are.
 */
import { randomUUID } from 'node:crypto';
import { describe } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';

import { embeddingStoreTables } from '../SqlEmbeddingStore.js';
import { embeddingStoreCases } from './embeddingStoreCases.js';

const URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const RUN = randomUUID().replaceAll('-', '').slice(0, 10);

describe.skipIf(!URL)('SqlEmbeddingStore on Postgres', () => {
  let n = 0;
  embeddingStoreCases({
    kind: 'postgres',
    open: async () => {
      const db = createPostgresAdapter({ connectionString: URL!, max: 4 });
      await db.open();
      return db;
    },
    prefix: () => `emb_${RUN}_${++n}`,
    columns: async (db: StorageAdapter, table: string) =>
      (await db.all<{ name: string }>(
        `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
        [table],
      )).map((row) => row.name),
    close: async (db: StorageAdapter, prefix: string) => {
      await db.run(`DROP TABLE IF EXISTS ${embeddingStoreTables(prefix).vectors}`);
      await db.close();
    },
  });
});
