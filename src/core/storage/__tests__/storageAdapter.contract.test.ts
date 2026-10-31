/**
 * @fileoverview Runs the `IStorageAdapter` contract against the in-memory
 * adapter and against `SqlStorageAdapter` on sql.js and on better-sqlite3 (sql.js
 * where the native module does not load). sql.js leaves SQLite's foreign keys
 * off, so a deleted conversation's messages go only by the adapter's own delete;
 * better-sqlite3 turns them on. The PostgreSQL run is in
 * SqlStorageAdapter.postgres.test.ts.
 */

import { InMemoryStorageAdapter } from '../InMemoryStorageAdapter.js';
import { SqlStorageAdapter } from '../SqlStorageAdapter.js';
import { runStorageAdapterContract } from './storageAdapter.contract.js';

runStorageAdapterContract('InMemoryStorageAdapter', {
  create: () => new InMemoryStorageAdapter(),
});

runStorageAdapterContract('SqlStorageAdapter on sql.js', {
  create: () => new SqlStorageAdapter({ filePath: ':memory:', priority: ['sqljs'], quiet: true }),
});

runStorageAdapterContract('SqlStorageAdapter on better-sqlite3', {
  create: () => new SqlStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true }),
});
