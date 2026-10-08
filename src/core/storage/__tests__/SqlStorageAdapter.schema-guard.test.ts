/**
 * @fileoverview Tests for SqlStorageAdapter's back-compat column guard.
 *
 * The guard adds cacheReadTokens and cacheCreationTokens to a `messages`
 * table created before those columns existed. It reads the columns first and
 * alters the table only when that read fails: on Postgres an ALTER TABLE takes
 * an ACCESS EXCLUSIVE lock even when the column exists, the lock waits behind
 * every open reader of the table (a pg_dump reads it for its whole run), and
 * later queries queue behind it.
 *
 * `resolveStorageAdapter` is wrapped so each test can see the statements the
 * adapter executes and, for the legacy case, seed the old table first.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  execCalls: [] as string[],
  seedLegacySchema: false,
}));

/** The `messages` table as it shipped before the cache-token columns. */
const LEGACY_SCHEMA = `
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

vi.mock('@framers/sql-storage-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@framers/sql-storage-adapter')>();
  return {
    ...actual,
    resolveStorageAdapter: async (
      ...args: Parameters<typeof actual.resolveStorageAdapter>
    ) => {
      const adapter = await actual.resolveStorageAdapter(...args);
      if (harness.seedLegacySchema) {
        await adapter.exec(LEGACY_SCHEMA);
      }
      const exec = adapter.exec.bind(adapter);
      adapter.exec = async (script: string) => {
        harness.execCalls.push(script);
        return exec(script);
      };
      return adapter;
    },
  };
});

import { SqlStorageAdapter } from '../SqlStorageAdapter.js';

async function openAdapter(): Promise<SqlStorageAdapter> {
  const adapter = new SqlStorageAdapter({
    filePath: ':memory:',
    priority: ['better-sqlite3', 'sqljs'],
    quiet: true,
  });
  await adapter.initialize();
  return adapter;
}

describe('SqlStorageAdapter — cache-token column guard', () => {
  let adapter: SqlStorageAdapter | undefined;

  afterEach(async () => {
    await adapter?.close?.();
    adapter = undefined;
    harness.execCalls.length = 0;
    harness.seedLegacySchema = false;
  });

  it('issues no ALTER TABLE when the messages table already has both columns', async () => {
    adapter = await openAdapter();

    expect(harness.execCalls.length).toBeGreaterThan(0);
    expect(harness.execCalls.filter((sql) => /ALTER\s+TABLE/i.test(sql))).toEqual([]);
  });

  it('adds both columns to a messages table created before them', async () => {
    harness.seedLegacySchema = true;
    adapter = await openAdapter();

    expect(harness.execCalls.filter((sql) => /ALTER\s+TABLE/i.test(sql))).toEqual([
      'ALTER TABLE messages ADD COLUMN cacheReadTokens INTEGER;',
      'ALTER TABLE messages ADD COLUMN cacheCreationTokens INTEGER;',
    ]);

    await adapter.createConversation({
      id: 'conv-1',
      userId: 'user-1',
      createdAt: 1,
      lastActivity: 1,
    });
    await adapter.storeMessage({
      id: 'msg-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'hello',
      timestamp: 10,
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cacheReadTokens: 80,
        cacheCreationTokens: 15,
      },
    });

    const message = await adapter.getMessage('msg-1');
    expect(message?.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 80,
      cacheCreationTokens: 15,
    });
  });
});
