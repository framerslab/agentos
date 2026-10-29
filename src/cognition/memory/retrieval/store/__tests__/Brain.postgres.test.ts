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
import {
  PostgresAdapter,
  type StorageAdapter,
  type StorageCapability,
  type StorageParameters,
  type StorageRunResult,
} from '@framers/sql-storage-adapter';
import { Brain } from '../Brain.js';
import { fillScopeIds } from '../migrations/v2-to-v3.js';
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

/**
 * A schema of its own, which stands in for a fresh database, and the URL of a connection whose opens make their tables
 * there: its search path puts the schema ahead of `public`.
 */
async function freshSchema(admin: Brain): Promise<{ schema: string; url: string }> {
  const schema = `agentos_fresh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await admin.exec(`CREATE SCHEMA ${schema}`);
  const url = new URL(POSTGRES_URL!);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return { schema, url: url.toString() };
}

/** The indexes `ensureScopeIdColumn` gives `memory_traces`, in the order an open makes them. */
const SCOPE_ID_INDEXES = ['idx_memory_traces_brain_scope_id', 'idx_memory_traces_unfiled_scope_id'];

/** The index a `CREATE INDEX IF NOT EXISTS` statement makes, or `undefined` for any other statement. */
function indexCreatedBy(statement: string): string | undefined {
  return /^\s*CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)\s/i.exec(statement)?.[1];
}

/** Waits until a statement of another session waits for a lock that the session `pid` holds. */
async function waitUntilBlockedBy(observer: Brain, pid: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const row = await observer.get<{ blocked: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted AND ? = ANY (pg_blocking_pids(pid))) AS blocked',
      [pid],
    );
    if (row?.blocked === true) return;
    if (Date.now() > deadline) throw new Error(`no statement waited for session ${pid} within 15 s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Has `open`, an open's statement that makes the index `statement` makes, lose the race for that index to a session
 * of `rival`'s, as it loses to another brain's open of the same database: the session makes the index in a
 * transaction it holds open, `open` starts and waits for the session's row of the catalog, and the session commits.
 * Postgres then fails `open` with unique_violation (23505) on pg_class_relname_nsp_index.
 */
async function loseRace(
  rival: PostgresAdapter,
  observer: Brain,
  statement: string,
  open: () => Promise<void>,
): Promise<void> {
  let losing: Promise<void> | undefined;
  await rival.withConnection(async (session) => {
    await session.exec('BEGIN');
    await session.exec(statement);
    const row = await session.get<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    losing = open();
    // Awaited below, once the session has committed.
    losing.catch(() => undefined);
    await waitUntilBlockedBy(observer, Number(row?.pid));
    await session.exec('COMMIT');
  });
  await losing;
}

/** How a script of an open runs: `run` runs it, and `inTransaction` tells whether it runs in a transaction. */
type ScriptRace = (script: string, run: () => Promise<void>, inTransaction: boolean) => Promise<void>;

/** A storage adapter that runs each script of `target`'s through `race`, in a transaction of `target`'s too. */
class RacingAdapter implements StorageAdapter {
  readonly kind: string;
  readonly capabilities: ReadonlySet<StorageCapability>;

  constructor(
    private readonly target: StorageAdapter,
    private readonly race: ScriptRace,
    private readonly inTransaction = false,
  ) {
    this.kind = target.kind;
    this.capabilities = target.capabilities;
  }

  open(): Promise<void> {
    return this.target.open();
  }

  close(): Promise<void> {
    return this.target.close();
  }

  run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    return this.target.run(statement, parameters);
  }

  get<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    return this.target.get<T>(statement, parameters);
  }

  all<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    return this.target.all<T>(statement, parameters);
  }

  exec(script: string): Promise<void> {
    return this.race(script, () => this.target.exec(script), this.inTransaction);
  }

  transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    return this.target.transaction((trx) => fn(new RacingAdapter(trx, this.race, true)));
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

  it('files at the next open a trace a release without scope_id wrote to a brain at version 3', async () => {
    const brainId = uniqueBrainId();
    const brain1 = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    openedBrains.push(brain1);
    // A release without the column writes its default, '', whatever scope id the metadata names.
    await brain1.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [brainId, 'late-trace', 'episodic', 'user', 'late', Date.now(), JSON.stringify({ scopeId: 'cy' })],
    );
    await brain1.close();
    openedBrains.pop();

    const brain2 = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    openedBrains.push(brain2);
    const row = await brain2.get<{ scope_id: string }>(
      `SELECT scope_id FROM memory_traces WHERE brain_id = $1 AND id = $2`,
      [brainId, 'late-trace'],
    );
    expect(row?.scope_id).toBe('cy');
  });

  it('files at the next open a trace whose metadata spells the scopeId key with a JSON escape', async () => {
    const brainId = uniqueBrainId();
    const brain1 = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    openedBrains.push(brain1);
    // JSON.parse reads the key "\u0073copeId" as scopeId: a writer may escape any letter of a key.
    await brain1.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [brainId, 'escaped-trace', 'episodic', 'user', 'escaped', Date.now(), '{"\\u0073copeId":"cy"}'],
    );
    await brain1.close();
    openedBrains.pop();

    const brain2 = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    openedBrains.push(brain2);
    const row = await brain2.get<{ scope_id: string }>(
      `SELECT scope_id FROM memory_traces WHERE brain_id = $1 AND id = $2`,
      [brainId, 'escaped-trace'],
    );
    expect(row?.scope_id).toBe('cy');
  });

  it('files the traces of an open by a read of an index that leaves out the traces filed under a scope id', async () => {
    const brainId = uniqueBrainId();
    const brain = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    openedBrains.push(brain);
    // Traces filed under a scope id, which the fill never reads; then fresh statistics.
    await brain.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata, scope_id)
         SELECT $1, 'scoped-' || g, 'episodic', 'user', 'scoped', 1, '{"scopeId":"cy"}', 'cy' FROM generate_series(1, 200) AS g`,
      [brainId],
    );
    await brain.exec('ANALYZE memory_traces');

    const statements: Array<{ sql: string; params?: Parameters<StorageAdapter['all']>[1] }> = [];
    const reading = {
      all: (sql: string, params?: Parameters<StorageAdapter['all']>[1]) => {
        statements.push({ sql, params });
        return brain.adapter.all(sql, params);
      },
      run: (sql: string, params?: Parameters<StorageAdapter['run']>[1]) => brain.adapter.run(sql, params),
    } as unknown as StorageAdapter;
    await fillScopeIds(reading, brainId);
    expect(statements).toHaveLength(1);

    // With sequential scans priced out, the brain's other indexes would walk all 200 rows; the index the fill reads holds none.
    const plan = await brain.transaction(async (trx) => {
      await trx.exec('SET LOCAL enable_seqscan = off');
      return trx.all<Record<string, string>>(`EXPLAIN ${statements[0]!.sql}`, statements[0]!.params);
    });
    expect(plan.map((step) => Object.values(step)[0]).join('\n')).toContain('idx_memory_traces_unfiled_scope_id');
  });

  it("keeps metadata out of every index of memory_traces, so a write of a trace's metadata stays a heap-only update", async () => {
    const brain = await Brain.openPostgres(POSTGRES_URL!, { brainId: uniqueBrainId() });
    openedBrains.push(brain);
    // Postgres updates a row without a new entry in any index only when the update changes no column an index reads,
    // in its key, an expression or its predicate. A recall writes the metadata of every trace it returns.
    const readers = await brain.all<{ name: string }>(
      `SELECT i.relname AS name
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attname = 'metadata'
        WHERE x.indrelid = to_regclass('memory_traces')
          AND (a.attnum = ANY (x.indkey::int2[])
            OR coalesce(pg_get_expr(x.indexprs, x.indrelid), '') LIKE '%metadata%'
            OR coalesce(pg_get_expr(x.indpred, x.indrelid), '') LIKE '%metadata%')`,
    );
    expect(readers.map((row) => row.name)).toEqual([]);
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
    const admin = await Brain.openPostgres(POSTGRES_URL!, { brainId: uniqueBrainId() });
    openedBrains.push(admin);
    // Different brains: their CREATE ... IF NOT EXISTS statements race on the shared tables, and a create that loses
    // (pg_type_typname_nsp_index, pg_class_relname_nsp_index) runs again and finds the object. Which opens lose, and
    // for which objects, depends on how the opens interleave, so three rounds of ten first opens run, each round on a
    // fresh schema.
    for (let round = 0; round < 3; round += 1) {
      const { schema, url } = await freshSchema(admin);
      const fresh: Brain[] = [];
      try {
        const opens = await Promise.allSettled(
          Array.from({ length: 10 }, () => Brain.openPostgres(url, { brainId: uniqueBrainId() })),
        );
        const failures: string[] = [];
        for (const open of opens) {
          if (open.status === 'fulfilled') fresh.push(open.value);
          else failures.push(String(open.reason));
        }
        expect(failures).toEqual([]);
        for (const brain of fresh) {
          expect(await brain.getMeta('schema_version')).toBe('3');
        }
        const created = await admin.all<{ n: string | number }>(
          `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'memory_traces'`,
          [schema],
        );
        expect(Number(created[0]?.n)).toBe(1);
        // The fresh schema gets the table's indexes too, though public, later on the search path and set up by
        // the admin brain's open, already holds indexes of the same names.
        const indexes = await admin.all<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'memory_traces'`,
          [schema],
        );
        expect(indexes.map((row) => row.indexname)).toEqual(
          expect.arrayContaining([
            'idx_memory_traces_brain_type',
            'idx_memory_traces_brain_scope',
            ...SCOPE_ID_INDEXES,
          ]),
        );
      } finally {
        for (const brain of fresh) await brain.close().catch(() => undefined);
        await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
      }
    }
  });

  it('opens a brain whose open loses the race for each index of scope_id to another open', async () => {
    // The tables are there, memory_traces with its scope_id column, and neither index of scope_id is. Another open of
    // the database makes each index while this open makes it, and commits first, so this open loses the race for both
    // in the one step that makes them, as one of the first opens of several brains can.
    const admin = await Brain.openPostgres(POSTGRES_URL!, { brainId: uniqueBrainId() });
    openedBrains.push(admin);
    const { schema, url } = await freshSchema(admin);
    const rival = new PostgresAdapter(url);
    const store = new PostgresAdapter(url);
    let brain: Brain | undefined;
    try {
      await rival.open();
      await store.open();
      const first = await Brain.openPostgres(url, { brainId: uniqueBrainId() });
      await first.close();
      for (const index of SCOPE_ID_INDEXES) await admin.exec(`DROP INDEX ${schema}.${index}`);
      const lost: string[] = [];
      const racing = new RacingAdapter(store, async (script, run) => {
        const index = indexCreatedBy(script);
        if (index === undefined || !SCOPE_ID_INDEXES.includes(index) || lost.includes(index)) return run();
        lost.push(index);
        await loseRace(rival, admin, script, run);
      });
      brain = await Brain.openWithAdapter(racing, { brainId: uniqueBrainId() });
      expect(lost).toEqual(SCOPE_ID_INDEXES);
      expect(await brain.getMeta('schema_version')).toBe('3');
      const indexes = await admin.all<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'memory_traces'`,
        [schema],
      );
      expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining(SCOPE_ID_INDEXES));
    } finally {
      await (brain ?? store).close().catch(() => undefined);
      await rival.close().catch(() => undefined);
      await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  it('migrates a brain at version 2 whose migration loses the race for an index to another open', async () => {
    // A brain at schema version 2 runs the v2 -> v3 migration in a transaction. memory_traces has scope_id and the
    // per-scope index, and not the partial index, which another open makes while the migration makes it.
    const admin = await Brain.openPostgres(POSTGRES_URL!, { brainId: uniqueBrainId() });
    openedBrains.push(admin);
    const { schema, url } = await freshSchema(admin);
    const rival = new PostgresAdapter(url);
    const store = new PostgresAdapter(url);
    const brainId = uniqueBrainId();
    let brain: Brain | undefined;
    try {
      await rival.open();
      await store.open();
      const first = await Brain.openPostgres(url, { brainId: uniqueBrainId() });
      await first.run(`INSERT INTO brain_meta (brain_id, key, value) VALUES (?, 'schema_version', '2')`, [brainId]);
      await first.close();
      await admin.exec(`DROP INDEX ${schema}.idx_memory_traces_unfiled_scope_id`);
      // Whether each script that lost a race ran in a transaction.
      const lost: boolean[] = [];
      const racing = new RacingAdapter(store, async (script, run, inTransaction) => {
        if (indexCreatedBy(script) !== 'idx_memory_traces_unfiled_scope_id' || lost.length > 0) return run();
        lost.push(inTransaction);
        await loseRace(rival, admin, script, run);
      });
      brain = await Brain.openWithAdapter(racing, { brainId });
      expect(lost).toEqual([true]);
      expect(await brain.getMeta('schema_version')).toBe('3');
    } finally {
      await (brain ?? store).close().catch(() => undefined);
      await rival.close().catch(() => undefined);
      await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  it('gives a fresh schema the indexes of every table it makes there, though a schema later on the search path holds them', async () => {
    // One open alone, so no other open makes a table before this one looks for that table's indexes. public, later on
    // the search path and set up by the admin brain's open, holds tables and indexes of the same names.
    const schema = `agentos_fresh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = await Brain.openPostgres(POSTGRES_URL!, { brainId: uniqueBrainId() });
    openedBrains.push(admin);
    await admin.exec(`CREATE SCHEMA ${schema}`);
    const url = new URL(POSTGRES_URL!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    let fresh: Brain | undefined;
    try {
      fresh = await Brain.openPostgres(url.toString(), { brainId: uniqueBrainId() });
      const indexes = await admin.all<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [schema]);
      expect(indexes.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          'idx_memory_traces_brain_type',
          'idx_memory_traces_brain_scope',
          'idx_memory_traces_brain_scope_id',
          'idx_knowledge_nodes_brain_type',
          'idx_knowledge_edges_brain_source',
          'idx_knowledge_edges_brain_target',
          'idx_document_chunks_brain_document',
          'idx_consolidation_log_brain_time',
          'idx_retrieval_feedback_brain_trace',
          'idx_messages_brain_conversation',
          'idx_archived_traces_brain_time',
          'idx_archived_traces_brain_reason',
          'idx_archive_access_recency',
        ]),
      );
    } finally {
      await fresh?.close().catch(() => undefined);
      await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  it("indexes a session's temporary table that shadows a brain table, where each CREATE INDEX of the open lands", async () => {
    // A session's temporary table is searched before every schema on the search path, so the open's unqualified
    // CREATE INDEX ... ON knowledge_nodes indexes it, though public, set up by the admin brain's open, holds the index.
    const admin = await Brain.openPostgres(POSTGRES_URL!, { brainId: uniqueBrainId() });
    openedBrains.push(admin);
    const pool = new PostgresAdapter(POSTGRES_URL!);
    await pool.open();
    try {
      await pool.withConnection(async (session) => {
        await session.exec('CREATE TEMP TABLE knowledge_nodes (LIKE public.knowledge_nodes)');
        let brain: Brain | undefined;
        try {
          brain = await Brain.openWithAdapter(session, { brainId: uniqueBrainId() });
          const indexes = await session.all<{ indexname: string }>(
            `SELECT c.relname AS indexname FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
              WHERE x.indrelid = 'pg_temp.knowledge_nodes'::regclass`,
          );
          expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining(['idx_knowledge_nodes_brain_type']));
        } finally {
          await session.exec('DROP TABLE IF EXISTS pg_temp.knowledge_nodes');
          if (brain) {
            await cleanup(brain);
            await brain.close();
          }
        }
      });
    } finally {
      await pool.close();
    }
  });

  it('opens while another connection holds a write transaction on the shared tables', async () => {
    const writer = await Brain.openPostgres(POSTGRES_URL!, { brainId: uniqueBrainId() });
    openedBrains.push(writer);
    // The opening connection gives up on any lock after two seconds instead of waiting for the writer.
    const url = new URL(POSTGRES_URL!);
    url.searchParams.set('options', '-c lock_timeout=2000');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted!: () => void;
    const writing = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    // A write transaction left open on memory_traces, as a long import holds one.
    const transaction = writer.transaction(async (trx) => {
      await trx.run(
        `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        [writer.brainId, 'held-trace', 'episodic', 'user', 'held open', Date.now()],
      );
      inserted();
      await held;
    });
    try {
      await writing;
      const opened = await Brain.openPostgres(url.toString(), { brainId: uniqueBrainId() });
      openedBrains.push(opened);
      expect(await opened.getMeta('schema_version')).toBe('3');
    } finally {
      release();
      await transaction;
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
