/**
 * @fileoverview `SqlStorageAdapter` on PostgreSQL, run when
 * `AGENTOS_TEST_POSTGRES_URL` names a database (CI's Test & Lint job sets it).
 * The adapter's tables go in a schema of their own for each run (the storage
 * library's `segment`), dropped when the suite ends.
 *
 * PostgreSQL folds unquoted names to lower case, reads a BIGINT as a string
 * through the driver and keeps an INTEGER in four bytes; the contract suite
 * reads every field back under those rules, and the last test opens a table
 * made with INTEGER timestamps.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter } from '@framers/sql-storage-adapter';
import { SqlStorageAdapter } from '../SqlStorageAdapter.js';
import { runStorageAdapterContract } from './storageAdapter.contract.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const segments: string[] = [];

function postgresStorage(segment: string): SqlStorageAdapter {
  return new SqlStorageAdapter({
    priority: ['postgres'],
    postgres: { connectionString: url! },
    segment,
    strict: true,
    quiet: true,
  });
}

/** The tables as they were made before the timestamps were BIGINT and before the cache-token columns. */
const INTEGER_TIMESTAMP_TABLES = `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    agentId TEXT,
    createdAt INTEGER NOT NULL,
    lastActivity INTEGER NOT NULL,
    title TEXT,
    metadata TEXT
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversationId TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    model TEXT,
    promptTokens INTEGER,
    completionTokens INTEGER,
    totalTokens INTEGER,
    toolCalls TEXT,
    toolCallId TEXT,
    name TEXT,
    metadata TEXT,
    FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
  );
`;

describe.skipIf(!url)('SqlStorageAdapter on PostgreSQL', () => {
  const contractSegment = `agentos_conv_${run}`;
  segments.push(contractSegment);
  runStorageAdapterContract('SqlStorageAdapter on PostgreSQL', { create: () => postgresStorage(contractSegment) });

  it('widens the INTEGER timestamps of tables made before BIGINT, adds the cache columns, then stores a millisecond time', async () => {
    const segment = `agentos_conv_${run}_old`;
    segments.push(segment);
    const db = createPostgresAdapter({ connectionString: url!, segment });
    await db.open();
    try {
      await db.exec(INTEGER_TIMESTAMP_TABLES);
    } finally {
      await db.close();
    }

    const storage = postgresStorage(segment);
    await storage.initialize();
    try {
      const now = 1_760_000_000_000;
      await storage.createConversation({ id: 'c', userId: 'u', createdAt: now, lastActivity: now });
      await storage.storeMessage({
        id: 'm',
        conversationId: 'c',
        role: 'assistant',
        content: 'hi',
        timestamp: now + 1,
        usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4, cacheReadTokens: 2 },
      });

      expect(await storage.getConversation('c')).toMatchObject({ userId: 'u', createdAt: now, lastActivity: now + 1 });
      expect(await storage.getMessage('m')).toMatchObject({
        timestamp: now + 1,
        usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4, cacheReadTokens: 2 },
      });
    } finally {
      await storage.close();
    }
  });

  afterAll(async () => {
    const db = createPostgresAdapter({ connectionString: url! });
    await db.open();
    try {
      for (const segment of segments) await db.exec(`DROP SCHEMA IF EXISTS "${segment}" CASCADE`);
    } finally {
      await db.close();
    }
  });
});
