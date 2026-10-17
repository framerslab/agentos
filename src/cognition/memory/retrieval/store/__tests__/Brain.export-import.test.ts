/**
 * @fileoverview Tests for Brain.exportToSqlite + Brain.importFromSqlite.
 *
 * Verifies the portable-artifact contract:
 * - Export materialises a Brain to a fresh SQLite file regardless of the
 *   source backend.
 * - Import loads a portable SQLite file into the receiving Brain's
 *   storage, rewriting `brain_id` to the receiving Brain's identity
 *   (forking semantics).
 * - Round-trip preserves row counts and content across all 14 tables.
 * - Idempotent merge import: re-importing the same file is a no-op
 *   under merge strategy (PK conflict → upsert with same data).
 * - Replace strategy wipes the receiving brain's existing rows for
 *   every brain-owned table before re-populating.
 * - Export reads one consistent view: a document and its chunk stored
 *   while the export runs are wholly out of the file (SQLite and Postgres).
 * - A failed export leaves nothing at the target path, and a retry runs; a
 *   file that appears at the target while the export runs is kept.
 *
 * @module memory/retrieval/store/__tests__/Brain.export-import.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../Brain.js';

describe('Brain.exportToSqlite + importFromSqlite', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-export-import-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('exports a populated brain to SQLite and round-trips into a fresh brain (forking)', async () => {
    const sourcePath = path.join(tmpDir, 'source.sqlite');
    const exportPath = path.join(tmpDir, 'alice-export.sqlite');
    const targetPath = path.join(tmpDir, 'target.sqlite');

    // Populate the source brain.
    const source = await Brain.openSqlite(sourcePath, { brainId: 'alice' });
    await source.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['alice', 't1', 'episodic', 'user', 'first memory', 1700000001],
    );
    await source.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['alice', 't2', 'semantic', 'user', 'second memory', 1700000002],
    );
    await source.run(
      `INSERT INTO knowledge_nodes (brain_id, id, type, label, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['alice', 'n1', 'concept', 'Berlin', 1700000003],
    );

    // Export.
    const result = await source.exportToSqlite(exportPath);
    expect(result.bytesWritten).toBeGreaterThan(0);
    await source.close();

    // Verify the export file is a valid SQLite Brain at v2 with the
    // SAME brainId as the source.
    // Specify brainId to avoid polluting brain_meta with a path-derived id
    // (which would break subsequent importFromSqlite single-brain validation).
    const exportBrain = await Brain.openSqlite(exportPath, { brainId: 'alice' });
    expect(exportBrain.brainId).toBe('alice');
    const exportedTraces = await exportBrain.all<{ brain_id: string; id: string }>(
      `SELECT brain_id, id FROM memory_traces ORDER BY id`,
    );
    // Exported rows still carry the source brainId (alice).
    expect(exportedTraces).toHaveLength(2);
    expect(exportedTraces.every((r) => r.brain_id === 'alice')).toBe(true);
    await exportBrain.close();

    // Import into a fresh brain with a different brainId (forking).
    const target = await Brain.openSqlite(targetPath, { brainId: 'alice-fork' });
    const importResult = await target.importFromSqlite(exportPath);
    expect(importResult.tablesImported.memory_traces).toBe(2);
    expect(importResult.tablesImported.knowledge_nodes).toBe(1);

    const targetTraces = await target.all<{ brain_id: string; id: string; content: string }>(
      `SELECT brain_id, id, content FROM memory_traces ORDER BY created_at`,
    );
    expect(targetTraces).toHaveLength(2);
    // Forking: every imported row gets the target's brainId, not the source's.
    expect(targetTraces.every((t) => t.brain_id === 'alice-fork')).toBe(true);
    expect(targetTraces[0]).toMatchObject({ id: 't1', content: 'first memory' });
    expect(targetTraces[1]).toMatchObject({ id: 't2', content: 'second memory' });

    const targetNodes = await target.all<{ brain_id: string; id: string; label: string }>(
      `SELECT brain_id, id, label FROM knowledge_nodes`,
    );
    expect(targetNodes).toHaveLength(1);
    expect(targetNodes[0]).toMatchObject({ brain_id: 'alice-fork', id: 'n1', label: 'Berlin' });

    await target.close();
  });

  it('refuses to overwrite an existing target file on export', async () => {
    const sourcePath = path.join(tmpDir, 's.sqlite');
    const exportPath = path.join(tmpDir, 'collision.sqlite');

    const source = await Brain.openSqlite(sourcePath, { brainId: 'alice' });
    // Create a placeholder at the export path.
    await fs.writeFile(exportPath, 'not a database');

    await expect(source.exportToSqlite(exportPath)).rejects.toThrow(
      /already exists/i,
    );

    await source.close();
  });

  /** A document and its one chunk in `brainId`'s tables. */
  async function addDocument(brain: Brain, brainId: string, id: string): Promise<void> {
    await brain.run(
      `INSERT INTO documents (brain_id, id, path, format, content_hash, chunk_count, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [brainId, id, `/docs/${id}.md`, 'markdown', `hash-${id}`, 1, 1700000100],
    );
    await brain.run(
      `INSERT INTO document_chunks (brain_id, id, document_id, content, chunk_index)
       VALUES (?, ?, ?, ?, ?)`,
      [brainId, `${id}-chunk`, id, `text of ${id}`, 0],
    );
  }

  /** Runs `write` against the source once, right after the export has copied its `documents` rows. */
  function writeAfterDocumentsCopy(source: Brain, write: () => Promise<void>): { wrote: () => boolean } {
    const internals = source as unknown as { _bulkCopy: (...args: unknown[]) => Promise<void> };
    const copy = internals._bulkCopy.bind(source);
    let done = false;
    internals._bulkCopy = async (...args: unknown[]) => {
      await copy(...args);
      if (args[1] === 'documents' && !done) {
        done = true;
        await write();
      }
    };
    return { wrote: () => done };
  }

  /** The ids in `table` of `brainId`, in order. */
  async function idsIn(brain: Brain, table: string, brainId: string): Promise<string[]> {
    const rows = await brain.all<{ id: string }>(`SELECT id FROM ${table} WHERE brain_id = ? ORDER BY id`, [brainId]);
    return rows.map((row) => row.id);
  }

  it('exports one consistent view while the brain keeps writing', async () => {
    const source = await Brain.openSqlite(path.join(tmpDir, 'live.sqlite'), { brainId: 'alice' });
    const exportPath = path.join(tmpDir, 'live-export.sqlite');
    await addDocument(source, 'alice', 'd1');
    // The brain stores a second document and its chunk after the export has copied the documents table.
    const hook = writeAfterDocumentsCopy(source, () => addDocument(source, 'alice', 'd2'));

    await source.exportToSqlite(exportPath);

    expect(hook.wrote()).toBe(true);
    const exported = await Brain.openSqlite(exportPath, { brainId: 'alice' });
    expect(await idsIn(exported, 'documents', 'alice')).toEqual(['d1']);
    expect(await idsIn(exported, 'document_chunks', 'alice')).toEqual(['d1-chunk']);
    await exported.close();
    // The source holds both documents.
    expect(await idsIn(source, 'documents', 'alice')).toEqual(['d1', 'd2']);
    await source.close();
  });

  it('leaves nothing at the target when an export fails, and a retry runs', async () => {
    const source = await Brain.openSqlite(path.join(tmpDir, 'orphan.sqlite'), { brainId: 'alice' });
    const exportPath = path.join(tmpDir, 'orphan-export.sqlite');
    const exportFiles = async (): Promise<string[]> =>
      (await fs.readdir(tmpDir)).filter((name) => name.startsWith('orphan-export')).sort();
    // A chunk whose document is missing, written with the source's foreign keys off; the
    // export's file enforces them, so its copy of document_chunks fails.
    await source.exec('PRAGMA foreign_keys = OFF');
    await source.run(
      `INSERT INTO document_chunks (brain_id, id, document_id, content, chunk_index)
       VALUES (?, ?, ?, ?, ?)`,
      ['alice', 'orphan-chunk', 'no-such-document', 'orphan text', 0],
    );
    await source.exec('PRAGMA foreign_keys = ON');

    await expect(source.exportToSqlite(exportPath)).rejects.toThrow();
    expect(await exportFiles()).toEqual([]);

    await source.run('DELETE FROM document_chunks WHERE brain_id = ? AND id = ?', ['alice', 'orphan-chunk']);
    expect((await source.exportToSqlite(exportPath)).bytesWritten).toBeGreaterThan(0);
    // One self-contained file: its write-ahead log was folded in before it moved into place.
    expect(await exportFiles()).toEqual(['orphan-export.sqlite']);
    await source.close();
  });

  it('keeps a file that appears at the target while the export runs, and fails', async () => {
    const source = await Brain.openSqlite(path.join(tmpDir, 'race.sqlite'), { brainId: 'alice' });
    const exportPath = path.join(tmpDir, 'race-export.sqlite');
    await addDocument(source, 'alice', 'd1');
    // Another export, or anything else, writes the target after this one has started.
    writeAfterDocumentsCopy(source, () => fs.writeFile(exportPath, 'the other export'));

    await expect(source.exportToSqlite(exportPath)).rejects.toThrow(/already exists/i);

    expect(await fs.readFile(exportPath, 'utf8')).toBe('the other export');
    expect((await fs.readdir(tmpDir)).filter((name) => name.startsWith('race-export')).sort()).toEqual(['race-export.sqlite']);
    await source.close();
  });

  it('merge import upserts on PK collision (idempotent re-import)', async () => {
    const sourcePath = path.join(tmpDir, 'src.sqlite');
    const exportPath = path.join(tmpDir, 'export.sqlite');
    const targetPath = path.join(tmpDir, 'tgt.sqlite');

    const source = await Brain.openSqlite(sourcePath, { brainId: 'src' });
    await source.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['src', 't1', 'episodic', 'user', 'data', 1700000001],
    );
    await source.exportToSqlite(exportPath);
    await source.close();

    const target = await Brain.openSqlite(targetPath, { brainId: 'tgt' });
    await target.importFromSqlite(exportPath, { strategy: 'merge' });
    // Second import — must succeed without throwing PK collision.
    await target.importFromSqlite(exportPath, { strategy: 'merge' });

    const traces = await target.all<{ id: string }>(
      `SELECT id FROM memory_traces WHERE brain_id = ?`,
      ['tgt'],
    );
    expect(traces).toHaveLength(1);

    await target.close();
  });

  it('replace import wipes existing rows for the receiving brainId before importing', async () => {
    const sourcePath = path.join(tmpDir, 'src.sqlite');
    const exportPath = path.join(tmpDir, 'export.sqlite');
    const targetPath = path.join(tmpDir, 'tgt.sqlite');

    const source = await Brain.openSqlite(sourcePath, { brainId: 'src' });
    await source.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['src', 'imported', 'episodic', 'user', 'imported content', 1700000001],
    );
    await source.exportToSqlite(exportPath);
    await source.close();

    const target = await Brain.openSqlite(targetPath, { brainId: 'tgt' });
    // Pre-existing row in target that should be wiped on replace import.
    await target.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['tgt', 'preexisting', 'episodic', 'user', 'will be wiped', 1700000099],
    );

    await target.importFromSqlite(exportPath, { strategy: 'replace' });

    const traces = await target.all<{ id: string; content: string }>(
      `SELECT id, content FROM memory_traces WHERE brain_id = ?`,
      ['tgt'],
    );
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ id: 'imported', content: 'imported content' });

    await target.close();
  });

  // Gated on AGENTOS_TEST_POSTGRES_URL: skipped without a Postgres instance.
  const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
  const itIfPostgres = POSTGRES_URL ? it : it.skip;

  itIfPostgres('exports one consistent view of a Postgres brain while it keeps writing', async () => {
    const brainId = `snapshot-${Date.now()}`;
    const exportPath = path.join(tmpDir, 'pg-live-export.sqlite');
    const source = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    try {
      await addDocument(source, brainId, 'd1');
      // Another pooled connection stores a second document after the documents table was copied.
      const hook = writeAfterDocumentsCopy(source, () => addDocument(source, brainId, 'd2'));

      await source.exportToSqlite(exportPath);

      expect(hook.wrote()).toBe(true);
      const exported = await Brain.openSqlite(exportPath, { brainId });
      expect(await idsIn(exported, 'documents', brainId)).toEqual(['d1']);
      expect(await idsIn(exported, 'document_chunks', brainId)).toEqual(['d1-chunk']);
      await exported.close();
    } finally {
      for (const table of ['document_chunks', 'documents', 'brain_meta']) {
        await source.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brainId]);
      }
      await source.close();
    }
  });

  itIfPostgres('round-trips a brain through sqlite -> postgres -> sqlite', async () => {
    const brainId = `roundtrip-${Date.now()}`;
    const sqliteSourcePath = path.join(tmpDir, 'roundtrip-source.sqlite');
    const sqliteFinalPath = path.join(tmpDir, 'roundtrip-final.sqlite');

    // 1. Create a SQLite brain and populate with a few traces + a document.
    const source = await Brain.openSqlite(sqliteSourcePath, { brainId });
    await source.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [brainId, 'rt-trace-1', 'episodic', 'user', 'first trace', 1000],
    );
    await source.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [brainId, 'rt-trace-2', 'semantic', 'world', 'second trace', 2000],
    );
    await source.run(
      `INSERT INTO documents (brain_id, id, path, format, content_hash, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [brainId, 'rt-doc-1', '/test/doc.md', 'markdown', 'hash-abc', 3000],
    );
    await source.close();

    // 2. Open a Postgres brain and import from SQLite.
    const pgBrain = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    await pgBrain.importFromSqlite(sqliteSourcePath, { strategy: 'replace' });

    // 3. Export the Postgres brain back to a fresh SQLite file.
    await pgBrain.exportToSqlite(sqliteFinalPath);
    await pgBrain.close();

    // 4. Open the final SQLite file and verify all rows came through.
    const final = await Brain.openSqlite(sqliteFinalPath, { brainId });

    const traces = await final.all<{ id: string; content: string }>(
      `SELECT id, content FROM memory_traces WHERE brain_id = ? ORDER BY id`,
      [brainId],
    );
    expect(traces).toEqual([
      { id: 'rt-trace-1', content: 'first trace' },
      { id: 'rt-trace-2', content: 'second trace' },
    ]);

    const docs = await final.all<{ id: string; path: string }>(
      `SELECT id, path FROM documents WHERE brain_id = ? ORDER BY id`,
      [brainId],
    );
    expect(docs).toEqual([{ id: 'rt-doc-1', path: '/test/doc.md' }]);

    await final.close();

    // 5. Cleanup Postgres rows.
    const cleanup = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    for (const table of ['memory_traces', 'documents', 'brain_meta']) {
      await cleanup.run(`DELETE FROM ${table} WHERE brain_id = $1`, [brainId]);
    }
    await cleanup.close();
  });

  it('importFromSqlite rolls back fully on mid-table failure (no partial row persistence)', async () => {
    // Set up a source brain with valid data that will provoke a FK violation
    // when imported into the target. Specifically: a document_chunk row whose
    // document_id does not exist in the source's documents table. The source
    // can hold this row directly because we'll bypass FK checks when seeding.
    const sourcePath = path.join(tmpDir, 'rollback-source.sqlite');
    const targetPath = path.join(tmpDir, 'rollback-target.sqlite');

    const source = await Brain.openSqlite(sourcePath, { brainId: 'rb' });
    // Insert a valid trace + a document.
    await source.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['rb', 'trace-1', 'episodic', 'user', 'good trace', 1000],
    );
    await source.run(
      `INSERT INTO documents (brain_id, id, path, format, content_hash, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['rb', 'doc-1', '/x.md', 'markdown', 'hash', 2000],
    );
    // Insert a document_chunk WITHOUT its parent document by bypassing FK
    // (PRAGMA foreign_keys is OFF by default in this raw insert path; agentos
    // turns it on at Brain init, so we have to disable for this seed only).
    await source.exec('PRAGMA foreign_keys = OFF');
    await source.run(
      `INSERT INTO document_chunks (brain_id, id, document_id, content, chunk_index)
       VALUES (?, ?, ?, ?, ?)`,
      ['rb', 'orphan-chunk', 'nonexistent-doc', 'orphaned', 0],
    );
    await source.exec('PRAGMA foreign_keys = ON');
    await source.close();

    // Target brain. FK enforcement is on (set by Brain._initialize). When
    // importFromSqlite tries to copy the orphan chunk, the FK fails. _bulkCopy
    // must roll back the entire document_chunks table, leaving no rows.
    const target = await Brain.openSqlite(targetPath, { brainId: 'rb' });

    await expect(target.importFromSqlite(sourcePath)).rejects.toThrow(
      /FOREIGN KEY|constraint/i,
    );

    // Verify no orphan chunk made it into the target.
    const chunks = await target.all<{ id: string }>(
      `SELECT id FROM document_chunks WHERE brain_id = ?`,
      ['rb'],
    );
    expect(chunks).toEqual([]);

    await target.close();
  });

  it('importFromSqlite handles a v1 source file (no brain_id column in brain_meta)', async () => {
    // Synthesize a v1-shaped SQLite file: brain_meta has key/value but no
    // brain_id column. The peek SELECT should not throw "no such column"; it
    // should fall through to opening the source via Brain.openSqlite (which
    // auto-runs v1 to v2 migration in place), then import normally.
    const sourcePath = path.join(tmpDir, 'v1-source.sqlite');

    // Create v1 schema directly (single connection raw SQL, bypassing Brain).
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(sourcePath);
    db.exec(`
      CREATE TABLE brain_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE memory_traces (
        id              TEXT PRIMARY KEY,
        type            TEXT NOT NULL,
        scope           TEXT NOT NULL,
        content         TEXT NOT NULL,
        embedding       BLOB,
        strength        REAL NOT NULL DEFAULT 1.0,
        created_at      INTEGER NOT NULL,
        last_accessed   INTEGER,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        tags            TEXT NOT NULL DEFAULT '[]',
        emotions        TEXT NOT NULL DEFAULT '{}',
        metadata        TEXT NOT NULL DEFAULT '{}',
        deleted         INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO brain_meta (key, value) VALUES ('schema_version', '1');
      INSERT INTO memory_traces (id, type, scope, content, created_at)
        VALUES ('legacy-trace', 'episodic', 'user', 'pre-0.3.0 trace', 1700000000);
    `);
    db.close();

    // Import into a fresh target. Should NOT throw "no such column: brain_id".
    const target = await Brain.openSqlite(':memory:', { brainId: 'v1-import-target' });
    const result = await target.importFromSqlite(sourcePath);

    // Verify the legacy trace got imported under the receiving brain's id.
    expect(result.tablesImported.memory_traces).toBeGreaterThanOrEqual(1);
    const traces = await target.all<{ brain_id: string; id: string; content: string }>(
      `SELECT brain_id, id, content FROM memory_traces WHERE brain_id = ?`,
      ['v1-import-target'],
    );
    const legacy = traces.find((t) => t.id === 'legacy-trace');
    expect(legacy?.content).toBe('pre-0.3.0 trace');

    await target.close();
  });

  it('importFromSqlite rejects a multi-brain source file', async () => {
    // Synthesize a multi-brain SQLite file by manually inserting brain_meta
    // rows for two distinct brain_ids.
    const sourcePath = path.join(tmpDir, 'multi-brain.sqlite');
    const setup = await Brain.openSqlite(sourcePath, { brainId: 'brain-a' });
    // Inject a second brain's meta row.
    await setup.run(
      `INSERT INTO brain_meta (brain_id, key, value) VALUES (?, ?, ?)`,
      ['brain-b', 'schema_version', '2'],
    );
    await setup.close();

    // Open a target brain and try to import the multi-brain source.
    const target = await Brain.openSqlite(':memory:', { brainId: 'brain-target' });
    await expect(target.importFromSqlite(sourcePath)).rejects.toThrow(
      /multiple brain_ids|brain-a|brain-b/i,
    );
    await target.close();
  });
});
