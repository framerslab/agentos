/**
 * @fileoverview `SqlEmbeddingStore` on better-sqlite3 and on sql.js, each an in-memory database of its own a case.
 */
import { describe } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';

import { embeddingStoreCases } from './embeddingStoreCases.js';

for (const kind of ['better-sqlite3', 'sqljs'] as const) {
  describe(`SqlEmbeddingStore on ${kind}`, () => {
    let n = 0;
    embeddingStoreCases({
      kind,
      open: () => resolveStorageAdapter({ filePath: ':memory:', priority: [kind], quiet: true }),
      prefix: () => `emb_${kind.replace(/\W/g, '')}_${++n}`,
      columns: async (db: StorageAdapter, table: string) =>
        (await db.all<{ name: string }>(`PRAGMA table_info("${table}")`)).map((row) => row.name),
      close: (db: StorageAdapter) => db.close(),
    });
  });
}
