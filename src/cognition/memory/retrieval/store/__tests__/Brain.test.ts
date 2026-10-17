/**
 * @fileoverview Tests for Brain — unified SQLite connection manager.
 *
 * Verifies schema initialisation, WAL mode, brain_meta helpers,
 * and embedding dimension compatibility checks.
 *
 * @module memory/store/__tests__/Brain.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../Brain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a unique temp file path for each test so tests are fully isolated.
 * The file is NOT created — Brain creates it on open.
 */
function tempDbPath(): string {
  return path.join(os.tmpdir(), `agentos-test-brain-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

/** Tracks brains opened during each test so afterEach can close + delete them. */
const openBrains: Array<{ brain: Brain; dbPath: string }> = [];

async function openBrain(dbPath?: string): Promise<{ brain: Brain; dbPath: string }> {
  const p = dbPath ?? tempDbPath();
  const brain = await Brain.openSqlite(p);
  openBrains.push({ brain, dbPath: p });
  return { brain, dbPath: p };
}

afterEach(async () => {
  // Close all brains opened in this test and delete the temp files.
  while (openBrains.length > 0) {
    const entry = openBrains.pop()!;
    try {
      await entry.brain.close();
    } catch {
      // Already closed — ignore.
    }
    try {
      // Delete the main db file and any WAL / SHM sidecars.
      for (const suffix of ['', '-wal', '-shm']) {
        const p = entry.dbPath + suffix;
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
        }
      }
    } catch {
      // Best-effort cleanup.
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Brain', () => {
  // -------------------------------------------------------------------------
  // Schema initialisation
  // -------------------------------------------------------------------------

  describe('schema initialisation', () => {
    it('creates all expected tables', async () => {
      const { brain } = await openBrain();

      // Query sqlite_master for all user-created tables and virtual tables.
      const rows = await brain.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type IN ('table', 'shadow') ORDER BY name`,
      );

      const tableNames = new Set(rows.map((r) => r.name));

      const expectedTables = [
        'brain_meta',
        'consolidation_log',
        'conversations',
        'document_chunks',
        'document_images',
        'documents',
        'knowledge_edges',
        'knowledge_nodes',
        'memory_traces',
        'messages',
        'retrieval_feedback',
      ];

      for (const table of expectedTables) {
        expect(tableNames.has(table), `Expected table "${table}" to exist`).toBe(true);
      }
    });

    it('creates the memory_traces_fts virtual table', async () => {
      const { brain } = await openBrain();

      const row = await brain.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_traces_fts'`,
      );

      expect(row).toBeDefined();
      expect(row?.name).toBe('memory_traces_fts');
    });

    it('is idempotent — re-opening the same file does not throw', async () => {
      const dbPath = tempDbPath();
      const { brain: first } = await openBrain(dbPath);
      await first.close();

      // Open again — should not throw (CREATE TABLE IF NOT EXISTS).
      const brain2 = await Brain.openSqlite(dbPath);
      openBrains.push({ brain: brain2, dbPath });
    });
  });

  // -------------------------------------------------------------------------
  // brain_meta helpers
  // -------------------------------------------------------------------------

  describe('getMeta / setMeta', () => {
    it('returns undefined for unknown keys', async () => {
      const { brain } = await openBrain();
      expect(await brain.getMeta('nonexistent_key')).toBeUndefined();
    });

    it('stores and retrieves a value', async () => {
      const { brain } = await openBrain();
      await brain.setMeta('test_key', 'hello_world');
      expect(await brain.getMeta('test_key')).toBe('hello_world');
    });

    it('overwrites an existing value (upsert semantics)', async () => {
      const { brain } = await openBrain();
      await brain.setMeta('overwrite_me', 'first');
      await brain.setMeta('overwrite_me', 'second');
      expect(await brain.getMeta('overwrite_me')).toBe('second');
    });

    it('preserves independent keys', async () => {
      const { brain } = await openBrain();
      await brain.setMeta('key_a', 'alpha');
      await brain.setMeta('key_b', 'beta');
      expect(await brain.getMeta('key_a')).toBe('alpha');
      expect(await brain.getMeta('key_b')).toBe('beta');
    });
  });

  // -------------------------------------------------------------------------
  // Schema version seeded on first creation
  // -------------------------------------------------------------------------

  describe('schema version', () => {
    it('sets schema_version to "3" on first creation', async () => {
      const { brain } = await openBrain();
      expect(await brain.getMeta('schema_version')).toBe('3');
    });

    it('sets created_at on first creation', async () => {
      const before = Date.now();
      const { brain } = await openBrain();
      const after = Date.now();

      const raw = await brain.getMeta('created_at');
      expect(raw).toBeDefined();

      const ts = parseInt(raw!, 10);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('does not overwrite schema_version on re-open', async () => {
      const dbPath = tempDbPath();
      const { brain: first } = await openBrain(dbPath);
      await first.close();

      // Re-open — schema_version must still be '3' (INSERT OR IGNORE in _seedMeta).
      const brain2 = await Brain.openSqlite(dbPath);
      openBrains.push({ brain: brain2, dbPath });
      expect(await brain2.getMeta('schema_version')).toBe('3');
    });
  });

  // -------------------------------------------------------------------------
  // checkEmbeddingCompat
  // -------------------------------------------------------------------------

  describe('checkEmbeddingCompat', () => {
    it('returns true when no embedding_dimensions stored yet', async () => {
      const { brain } = await openBrain();
      // No prior call — should accept any dimension.
      expect(await brain.checkEmbeddingCompat(1536)).toBe(true);
    });

    it('stores the dimension after the first call', async () => {
      const { brain } = await openBrain();
      await brain.checkEmbeddingCompat(768);
      expect(await brain.getMeta('embedding_dimensions')).toBe('768');
    });

    it('returns true when dimensions match the stored value', async () => {
      const { brain } = await openBrain();
      await brain.checkEmbeddingCompat(1536);      // stores 1536
      expect(await brain.checkEmbeddingCompat(1536)).toBe(true);
    });

    it('returns false on dimension mismatch', async () => {
      const { brain } = await openBrain();
      await brain.checkEmbeddingCompat(1536);      // stores 1536
      expect(await brain.checkEmbeddingCompat(768)).toBe(false);
    });

    it('does not overwrite the stored dimension on mismatch', async () => {
      const { brain } = await openBrain();
      await brain.checkEmbeddingCompat(1536);
      await brain.checkEmbeddingCompat(768);       // mismatch — should NOT update stored value
      expect(await brain.getMeta('embedding_dimensions')).toBe('1536');
    });
  });

  // -------------------------------------------------------------------------
  // Foreign key enforcement
  // -------------------------------------------------------------------------

  describe('foreign key enforcement', () => {
    it('enforces foreign keys (inserting edge with missing node throws)', async () => {
      const { brain } = await openBrain();

      await expect(
        brain.run(
          `INSERT INTO knowledge_edges (id, source_id, target_id, type, created_at)
           VALUES ('e1', 'missing-node', 'also-missing', 'RELATED_TO', ?)`,
          [Date.now()],
        ),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  describe('close()', () => {
    it('closes the database without throwing', async () => {
      const dbPath = tempDbPath();
      const brain = await Brain.openSqlite(dbPath);
      await brain.close();
      // Manually clean up since we bypassed openBrain().
      for (const suffix of ['', '-wal', '-shm']) {
        const p = dbPath + suffix;
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    });
  });
});
