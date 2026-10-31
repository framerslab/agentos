/**
 * The outbox over the library's SQL key-value store on better-sqlite3, in a file: what one connection holds, the next
 * reads. The same suite runs on the IndexedDB adapter in Outbox.sql.browser.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBetterSqliteAdapter } from '@framers/sql-storage-adapter';
import { afterAll } from 'vitest';

import { outboxOverSqlStore } from './outboxOverSql.js';

const dir = mkdtempSync(join(tmpdir(), 'agentos-outbox-sql-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

outboxOverSqlStore('better-sqlite3', async () => {
  const adapter = createBetterSqliteAdapter(join(dir, 'outbox.sqlite3'));
  await adapter.open();
  return adapter;
});
