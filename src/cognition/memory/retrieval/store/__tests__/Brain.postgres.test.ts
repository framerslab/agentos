/**
 * @fileoverview Postgres integration tests for `Brain.openPostgres`.
 *
 * Gated on `AGENTOS_TEST_POSTGRES_URL` — when the env var is absent, every
 * test is skipped so the suite stays green for contributors without a local
 * Postgres. CI provides the env var via the `pgvector/pgvector:pg16`
 * service container declared in `.github/workflows/ci.yml`.
 *
 * Each test uses a unique `brainId` (Date.now + random suffix) so concurrent
 * runs and re-runs of this file don't collide on shared schema. The
 * `afterEach` cleanup wipes every brain-owned table for the test brainId so
 * the database stays clean for subsequent runs.
 *
 * @module memory/retrieval/store/__tests__/Brain.postgres.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Brain } from '../Brain.js';
import { PORTABLE_TABLES } from '../portable-tables.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const describeIfPostgres = POSTGRES_URL ? describe : describe.skip;

function uniqueBrainId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanup(brain: Brain): Promise<void> {
  // Order matters: child tables before parents to satisfy FKs.
  for (const table of [...PORTABLE_TABLES].reverse()) {
    try {
      await brain.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brain.brainId]);
    } catch (err) {
      // Table may not exist on first run; log non-trivial failures so CI
      // artifacts capture context if cleanup fails for an unexpected reason.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/does not exist|no such table/i.test(msg)) {
        process.stderr.write(`[Brain.postgres.test cleanup] ${table}: ${msg}\n`);
      }
    }
  }
}

describeIfPostgres('Brain.openPostgres', () => {
  const openedBrains: Brain[] = [];

  afterEach(async () => {
    while (openedBrains.length > 0) {
      const brain = openedBrains.pop()!;
      try {
        await cleanup(brain);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[Brain.postgres.test afterEach.cleanup] ${msg}\n`);
      }
      try {
        await brain.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[Brain.postgres.test afterEach.close] ${msg}\n`);
      }
    }
  });

  it('opens a Brain backed by Postgres and accepts brainId scoping', async () => {
    const brainId = uniqueBrainId();
    const brain = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    openedBrains.push(brain);

    expect(brain.brainId).toBe(brainId);

    // Schema initialised; brain_meta seeded.
    const ver = await brain.getMeta('schema_version');
    expect(ver).toBe('3');
  });

  it('throws when brainId is missing', async () => {
    await expect(
      Brain.openPostgres(POSTGRES_URL!, {} as { brainId: string }),
    ).rejects.toThrow(/brainId is required/i);
  });

  it('writes and reads memory traces scoped by brain_id', async () => {
    const brainId = uniqueBrainId();
    const brain = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    openedBrains.push(brain);

    await brain.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [brainId, 'pg-t1', 'episodic', 'user', 'hello postgres', Date.now()],
    );

    const rows = await brain.all<{ id: string; content: string }>(
      `SELECT id, content FROM memory_traces WHERE brain_id = $1`,
      [brainId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'pg-t1', content: 'hello postgres' });
  });

  it('two brains in the same Postgres database stay isolated', async () => {
    const brainAId = uniqueBrainId();
    const brainBId = uniqueBrainId();
    const brainA = await Brain.openPostgres(POSTGRES_URL!, { brainId: brainAId });
    const brainB = await Brain.openPostgres(POSTGRES_URL!, { brainId: brainBId });
    openedBrains.push(brainA, brainB);

    await brainA.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [brainAId, 'isolated-a', 'episodic', 'user', 'A-only', Date.now()],
    );
    await brainB.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [brainBId, 'isolated-b', 'episodic', 'user', 'B-only', Date.now()],
    );

    // Each brain's query scoped by its own brainId returns only its own rows.
    const aRows = await brainA.all<{ content: string }>(
      `SELECT content FROM memory_traces WHERE brain_id = $1`,
      [brainAId],
    );
    const bRows = await brainB.all<{ content: string }>(
      `SELECT content FROM memory_traces WHERE brain_id = $1`,
      [brainBId],
    );

    expect(aRows.map((r) => r.content)).toEqual(['A-only']);
    expect(bRows.map((r) => r.content)).toEqual(['B-only']);
  });

  it('migrateV1ToV2 is idempotent on Postgres (re-open is a no-op)', async () => {
    const brainId = uniqueBrainId();

    const brain1 = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    openedBrains.push(brain1);
    expect(await brain1.getMeta('schema_version')).toBe('3');
    await brain1.close();
    openedBrains.pop();

    // Second open should detect v3 and skip migration without error.
    const brain2 = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    openedBrains.push(brain2);
    expect(await brain2.getMeta('schema_version')).toBe('3');
  });

  it('serializes concurrent first-opens against the same brainId', async () => {
    const brainId = uniqueBrainId();
    // Two parallel opens against the same brainId.
    const [brainA, brainB] = await Promise.all([
      Brain.openPostgres(POSTGRES_URL!, { brainId }),
      Brain.openPostgres(POSTGRES_URL!, { brainId }),
    ]);
    openedBrains.push(brainA, brainB);

    // Both must see schema_version = '3' (latest). MigrationRunner's lock
    // and transaction let one open run the migrations while the other waits;
    // both run the schema step, where a create that loses the race to the
    // other connection runs again and finds the object.
    expect(await brainA.getMeta('schema_version')).toBe('3');
    expect(await brainB.getMeta('schema_version')).toBe('3');

    // Both must be able to write and read independently (no corruption).
    await brainA.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [brainId, 'race-trace-a', 'episodic', 'user', 'from A', Date.now()],
    );
    await brainB.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [brainId, 'race-trace-b', 'episodic', 'user', 'from B', Date.now()],
    );

    const rows = await brainA.all<{ id: string }>(
      `SELECT id FROM memory_traces WHERE brain_id = $1 ORDER BY id`,
      [brainId],
    );
    expect(rows.map((r) => r.id)).toEqual(['race-trace-a', 'race-trace-b']);
  });

  it('sets the shared schema up once when several brains first open a fresh database at once', async () => {
    // A schema of its own stands in for a fresh database: the opens below create every table in it.
    const schema = `agentos_fresh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = await Brain.openPostgres(POSTGRES_URL!, { brainId: uniqueBrainId() });
    openedBrains.push(admin);
    await admin.exec(`CREATE SCHEMA ${schema}`);
    const url = new URL(POSTGRES_URL!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    const fresh: Brain[] = [];
    try {
      // Different brains: their CREATE ... IF NOT EXISTS statements race on the shared tables, and
      // one that loses (pg_type_typname_nsp_index) runs again and finds the object.
      fresh.push(
        ...(await Promise.all(
          Array.from({ length: 6 }, () => Brain.openPostgres(url.toString(), { brainId: uniqueBrainId() })),
        )),
      );
      for (const brain of fresh) {
        expect(await brain.getMeta('schema_version')).toBe('3');
      }
      const created = await admin.all<{ n: string | number }>(
        `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'memory_traces'`,
        [schema],
      );
      expect(Number(created[0]?.n)).toBe(1);
    } finally {
      for (const brain of fresh) await brain.close().catch(() => undefined);
      await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  it('enforces FK constraints across brain-scoped tables', async () => {
    const brainId = uniqueBrainId();
    const brain = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    openedBrains.push(brain);

    // Insert a document_chunk referencing a non-existent document.
    // The composite FK (brain_id, document_id) -> documents(brain_id, id)
    // should fire and reject the insert.
    await expect(
      brain.run(
        `INSERT INTO document_chunks (brain_id, id, document_id, content, chunk_index)
           VALUES ($1, $2, $3, $4, $5)`,
        [brainId, 'orphan-chunk', 'nonexistent-doc', 'orphaned content', 0],
      ),
    ).rejects.toThrow(/foreign key|constraint|violates/i);
  });

  it('rolls back on synthetic mid-migration failure (transactional)', async () => {
    const brainId = uniqueBrainId();
    const failingBrainId = `${brainId}-failing`;

    // Use a real brain to seed brain_meta with a failing-brain row at v1, then
    // drive MigrationRunner with a synthetic Migration whose `up` throws.
    // Verify schema_version stays at '1' after the failure.
    const seedBrain = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    openedBrains.push(seedBrain);
    await seedBrain.run(
      `INSERT INTO brain_meta (brain_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (brain_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [failingBrainId, 'schema_version', '1'],
    );

    const { MigrationRunner } = await import('../migrations/index.js');
    const { createStorageFeatures } = await import('@framers/sql-storage-adapter');
    const features = createStorageFeatures(seedBrain.adapter);
    const failingMigration = {
      version: 99,
      up: async () => {
        throw new Error('synthetic mid-migration failure');
      },
    };

    await expect(
      MigrationRunner.runPending(seedBrain.adapter, features, failingBrainId, [failingMigration]),
    ).rejects.toThrow(/synthetic mid-migration failure/);

    // Verify schema_version was NOT bumped (transaction rolled back).
    const ver = await seedBrain.get<{ value: string }>(
      `SELECT value FROM brain_meta WHERE brain_id = $1 AND key = $2`,
      [failingBrainId, 'schema_version'],
    );
    expect(ver?.value).toBe('1');

    // Cleanup the test row.
    await seedBrain.run(`DELETE FROM brain_meta WHERE brain_id = $1`, [failingBrainId]);
  });

  it('importFromSqlite into Postgres rolls back fully on mid-table FK failure', async () => {
    // Reproduces the C1 bug from the post-0.3.1 code review: _bulkCopy used
    // raw `adapter.exec("BEGIN")` then `adapter.run(stmt, ...)` then
    // `adapter.exec("COMMIT")`. On Postgres the pool returns a different
    // connection per call, so each INSERT auto-committed and the BEGIN/COMMIT
    // were no-ops. The fix uses adapter.transaction() to pin all writes to
    // one pooled connection.
    //
    // Test setup: build a SQLite source with 5 valid document_chunks + 1
    // orphan chunk pointing at a nonexistent document. Importing into a
    // Postgres target with FK enforcement on must roll back document_chunks
    // entirely after the orphan fails. Without the fix, the 5 valid chunks
    // would persist (each individually committed).
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-pg-'));
    const sourcePath = path.join(tmpDir, 'rb-pg-source.sqlite');
    const brainId = uniqueBrainId();

    const source = await Brain.openSqlite(sourcePath, { brainId });
    await source.run(
      `INSERT INTO documents (brain_id, id, path, format, content_hash, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [brainId, 'parent-doc', '/x.md', 'markdown', 'hash', 1000],
    );
    // 5 valid chunks pointing at the parent doc.
    for (let i = 0; i < 5; i++) {
      await source.run(
        `INSERT INTO document_chunks (brain_id, id, document_id, content, chunk_index)
         VALUES (?, ?, ?, ?, ?)`,
        [brainId, `valid-chunk-${i}`, 'parent-doc', `chunk ${i}`, i],
      );
    }
    // 1 orphan chunk; bypass FK on source to seed it.
    await source.exec('PRAGMA foreign_keys = OFF');
    await source.run(
      `INSERT INTO document_chunks (brain_id, id, document_id, content, chunk_index)
       VALUES (?, ?, ?, ?, ?)`,
      [brainId, 'orphan-chunk', 'nonexistent-doc', 'orphan', 99],
    );
    await source.exec('PRAGMA foreign_keys = ON');
    await source.close();

    // Import into Postgres. FK enforcement is implicit in Postgres; the orphan
    // chunk INSERT must fail and trigger rollback of all 5 valid chunks.
    const target = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    openedBrains.push(target);

    await expect(target.importFromSqlite(sourcePath)).rejects.toThrow(
      /foreign key|constraint|violates/i,
    );

    // Verify document_chunks rolled back fully (zero rows for this brain).
    const chunks = await target.all<{ id: string }>(
      `SELECT id FROM document_chunks WHERE brain_id = $1`,
      [brainId],
    );
    expect(chunks).toEqual([]);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
