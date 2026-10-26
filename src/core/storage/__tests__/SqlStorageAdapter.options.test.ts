/**
 * @fileoverview SqlStorageAdapter's own options: `messageRetentionDays` deletes
 * the messages older than its cutoff after each stored message and when the
 * adapter opens a database, and `enableAutoMigration: false` leaves the schema
 * to the host. A setup that fails leaves the adapter uninitialized, and
 * `close()` lets its connection go, so a later `initialize()` opens a fresh one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SqlStorageAdapter } from '../SqlStorageAdapter.js';

const DAY = 86_400_000;
const dirs: string[] = [];

/** A database file in a directory of its own, removed after the suite. */
function databaseFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-sql-storage-'));
  dirs.push(dir);
  return path.join(dir, 'conversations.db');
}

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SqlStorageAdapter options', () => {
  it('deletes the messages older than messageRetentionDays after each stored message', async () => {
    const storage = new SqlStorageAdapter({
      filePath: ':memory:',
      priority: ['sqljs'],
      quiet: true,
      messageRetentionDays: 7,
    });
    await storage.initialize();
    try {
      const now = Date.now();
      await storage.createConversation({ id: 'c', userId: 'u', createdAt: now, lastActivity: now });
      await storage.storeMessage({ id: 'old', conversationId: 'c', role: 'user', content: 'old', timestamp: now - 8 * DAY });
      await storage.storeMessage({ id: 'new', conversationId: 'c', role: 'user', content: 'new', timestamp: now - 6 * DAY });

      expect(await storage.getMessage('old')).toBeNull();
      expect((await storage.getMessages('c')).map((m) => m.id)).toEqual(['new']);
      expect(await storage.getConversation('c')).not.toBeNull();
    } finally {
      await storage.close();
    }
  });

  it('deletes the expired messages of a database when it opens it', async () => {
    const file = databaseFile();
    const now = Date.now();
    const keepAll = new SqlStorageAdapter({ filePath: file, priority: ['better-sqlite3', 'sqljs'], quiet: true });
    await keepAll.initialize();
    await keepAll.createConversation({ id: 'c', userId: 'u', createdAt: now, lastActivity: now });
    await keepAll.storeMessage({ id: 'old', conversationId: 'c', role: 'user', content: 'old', timestamp: now - 40 * DAY });
    await keepAll.storeMessage({ id: 'recent', conversationId: 'c', role: 'user', content: 'recent', timestamp: now - DAY });
    await keepAll.close();

    const pruning = new SqlStorageAdapter({
      filePath: file,
      priority: ['better-sqlite3', 'sqljs'],
      quiet: true,
      messageRetentionDays: 30,
    });
    await pruning.initialize();
    try {
      expect((await pruning.getMessages('c')).map((m) => m.id)).toEqual(['recent']);
    } finally {
      await pruning.close();
    }
  });

  it('stays uninitialized when it cannot delete the expired messages as it opens, so no call runs on that failure', async () => {
    // With the schema left to the host and not yet made, deleting the expired messages fails.
    const storage = new SqlStorageAdapter({
      filePath: ':memory:',
      priority: ['sqljs'],
      quiet: true,
      messageRetentionDays: 7,
      enableAutoMigration: false,
    });
    try {
      await expect(storage.initialize()).rejects.toThrow();
      await expect(storage.getMessage('m')).rejects.toThrow(/not initialized/);
    } finally {
      await storage.close();
    }
  });

  it('opens the database again when initialize() follows close()', async () => {
    // A retry after a failed setup reuses the connection it opened; close() lets it go, so this one is fresh.
    const file = databaseFile();
    const now = Date.now();
    const storage = new SqlStorageAdapter({ filePath: file, priority: ['better-sqlite3', 'sqljs'], quiet: true });
    await storage.initialize();
    await storage.createConversation({ id: 'c', userId: 'u', createdAt: now, lastActivity: now });
    await storage.close();

    await storage.initialize();
    try {
      expect(await storage.getConversation('c')).not.toBeNull();
    } finally {
      await storage.close();
    }
  });

  it('keeps every message when messageRetentionDays is 0, the default', async () => {
    const storage = new SqlStorageAdapter({ filePath: ':memory:', priority: ['sqljs'], quiet: true });
    await storage.initialize();
    try {
      await storage.createConversation({ id: 'c', userId: 'u', createdAt: 1, lastActivity: 1 });
      await storage.storeMessage({ id: 'ancient', conversationId: 'c', role: 'user', content: 'x', timestamp: 2 });

      expect(await storage.getMessage('ancient')).not.toBeNull();
    } finally {
      await storage.close();
    }
  });

  it('creates no tables when enableAutoMigration is false', async () => {
    const storage = new SqlStorageAdapter({
      filePath: ':memory:',
      priority: ['sqljs'],
      quiet: true,
      enableAutoMigration: false,
    });
    await storage.initialize();
    try {
      await expect(
        storage.createConversation({ id: 'c', userId: 'u', createdAt: 1, lastActivity: 1 })
      ).rejects.toThrow(/no such table/i);
    } finally {
      await storage.close();
    }
  });
});
