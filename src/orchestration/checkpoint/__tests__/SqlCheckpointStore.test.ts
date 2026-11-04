/**
 * @file SqlCheckpointStore.test.ts
 * @description `SqlCheckpointStore` over `@framers/sql-storage-adapter`.
 *
 * The cases of `InMemoryCheckpointStore`'s own tests (`../../__tests__/checkpoint-store.test.ts`) run over sql.js,
 * better-sqlite3 and, when `AGENTOS_TEST_POSTGRES_URL` is set (CI's service container), Postgres, each with the cases a
 * SQL store adds: a checkpoint read back whole, the metadata `InMemoryCheckpointStore` lists for it, saves that
 * overlap, a fork's parent recorded, two prefixes in one database kept apart, and a second store over the same table
 * reading what the first saved. A run a human node halts is resumed by another runtime over the same SQLite file, as
 * after a restart.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPostgresAdapter,
  resolveStorageAdapter,
  type StorageAdapter,
  type StorageResolutionOptions,
} from '@framers/sql-storage-adapter';
import type { Checkpoint } from '../ICheckpointStore.js';
import { InMemoryCheckpointStore } from '../InMemoryCheckpointStore.js';
import { SqlCheckpointStore, checkpointDdl } from '../SqlCheckpointStore.js';
import { GraphRuntime } from '../../runtime/GraphRuntime.js';
import { NodeExecutor, type NodeExecutorDeps } from '../../runtime/NodeExecutor.js';
import { LoopController, type LoopChunk, type LoopOutput } from '../../runtime/LoopController.js';
import { gmiNode, humanNode } from '../../builders/nodes.js';
import { START, END } from '../../ir/types.js';
import type { CompiledExecutionGraph, GraphNode } from '../../ir/types.js';
import type { GraphEvent } from '../../events/GraphEvent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The checkpoint `checkpoint-store.test.ts` builds its cases from. */
function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: overrides.id ?? 'cp-1',
    graphId: overrides.graphId ?? 'graph-1',
    runId: overrides.runId ?? 'run-1',
    nodeId: overrides.nodeId ?? 'node-a',
    timestamp: overrides.timestamp ?? Date.now(),
    state: {
      input: {},
      scratch: {},
      artifacts: {},
      diagnostics: {
        totalTokensUsed: 0,
        totalDurationMs: 0,
        nodeTimings: {},
        discoveryResults: {},
        guardrailResults: {},
        checkpointsSaved: 0,
        memoryReads: 0,
        memoryWrites: 0,
      },
    },
    nodeResults: {},
    visitedNodes: ['node-a'],
    pendingEdges: ['e1'],
    ...overrides,
  };
}

/** A checkpoint with every optional part set, as a run halted by a human node after a branch saves one. */
function fullCheckpoint(id: string): Checkpoint {
  return makeCheckpoint({
    id,
    runId: 'run-full',
    nodeId: 'approve',
    timestamp: 1_730_000_000_123,
    state: {
      input: { release: 'v2', tags: ['importer', '日本語', '🚀'] },
      scratch: { attempt: 2, nested: { deep: [1, 2, { three: null }] } },
      artifacts: { draft: 'Draft: v2 ships the importer.' },
      diagnostics: {
        totalTokensUsed: 412,
        totalDurationMs: 1830,
        nodeTimings: { draft: { startMs: 1, endMs: 1801, tokensUsed: 412 } },
        discoveryResults: {},
        guardrailResults: {},
        checkpointsSaved: 3,
        memoryReads: 1,
        memoryWrites: 0,
      },
    },
    memorySnapshot: {
      reads: [{ traceId: 't-1', content: 'The importer reads CSV.', strength: 0.75 }],
      pendingWrites: [{ type: 'episodic', content: 'Asked to publish.', scope: 'thread' }],
    },
    nodeResults: {
      draft: { effectClass: 'read', output: 'Draft: v2 ships the importer.', durationMs: 1800 },
      route: { effectClass: 'external', output: { exit: 'approve' }, durationMs: 4, routeTarget: 'approve' },
      approve: { effectClass: 'human', output: { prompt: 'Publish these notes?' }, durationMs: 0 },
    },
    visitedNodes: ['draft', 'route'],
    skippedNodes: ['reject'],
    pendingEdges: [],
  });
}

/** One database the cases' stores share, with a prefix no other store of the run has taken. */
interface OpenDatabase {
  db: StorageAdapter;
  prefix(): string;
  close(): Promise<void>;
}

/** A fresh SQLite database in memory for each case, opened by the adapters `priority` names. */
function sqlite(priority: StorageResolutionOptions['priority']): () => Promise<OpenDatabase> {
  return async () => {
    const db = await resolveStorageAdapter({ filePath: ':memory:', priority, quiet: true });
    let n = 0;
    return { db, prefix: () => `checkpoints_${(n += 1)}`, close: () => db.close() };
  };
}

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
/** This run's own start of every Postgres prefix, so a run's tables never meet another run's. */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const postgresPrefixes: string[] = [];
let postgres: StorageAdapter | undefined;

/** One Postgres pool for the run, and a prefix of this run's own for each store; the tables are dropped after it. */
async function openPostgres(): Promise<OpenDatabase> {
  if (!postgres) {
    postgres = createPostgresAdapter({ connectionString: POSTGRES_URL!, max: 10 });
    await postgres.open();
  }
  return {
    db: postgres,
    prefix: () => {
      const prefix = `ck${RUN}_${postgresPrefixes.length + 1}`;
      postgresPrefixes.push(prefix);
      return prefix;
    },
    close: async () => {},
  };
}

// ---------------------------------------------------------------------------
// The cases, on every backend
// ---------------------------------------------------------------------------

function runCheckpointStoreCases(open: () => Promise<OpenDatabase>): void {
  let database: OpenDatabase;
  /** The prefix of the case's store, which is its table's name. */
  let table: string;
  let store: SqlCheckpointStore;

  beforeEach(async () => {
    database = await open();
    table = database.prefix();
    store = new SqlCheckpointStore({ db: database.db, tablePrefix: table });
  });

  afterEach(async () => {
    await database.close();
  });

  // InMemoryCheckpointStore's own cases --------------------------------------

  it('save and load by runId returns the saved checkpoint', async () => {
    const cp = makeCheckpoint({ id: 'cp-1', runId: 'run-1' });
    await store.save(cp);

    const loaded = await store.load('run-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('cp-1');
    expect(loaded!.runId).toBe('run-1');
  });

  it('get returns a checkpoint by exact checkpoint id', async () => {
    const cp = makeCheckpoint({ id: 'cp-direct', runId: 'run-1' });
    await store.save(cp);

    const loaded = await store.get('cp-direct');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('cp-direct');
  });

  it('load returns null for an unknown runId', async () => {
    const result = await store.load('run-missing');
    expect(result).toBeNull();
  });

  it('load with nodeId filter returns checkpoint matching that node', async () => {
    const cpA = makeCheckpoint({ id: 'cp-a', runId: 'run-1', nodeId: 'node-a', timestamp: 1000 });
    const cpB = makeCheckpoint({ id: 'cp-b', runId: 'run-1', nodeId: 'node-b', timestamp: 2000 });
    await store.save(cpA);
    await store.save(cpB);

    const loaded = await store.load('run-1', 'node-a');
    expect(loaded!.id).toBe('cp-a');
  });

  it('latest returns the most recently timestamped checkpoint for a run', async () => {
    const older = makeCheckpoint({ id: 'cp-old', runId: 'run-1', timestamp: 1000 });
    const newer = makeCheckpoint({ id: 'cp-new', runId: 'run-1', timestamp: 9000 });
    // Save older first, then newer; the order of insertion does not matter.
    await store.save(older);
    await store.save(newer);
    // Saved last, the older one is still not the latest.
    await store.save(makeCheckpoint({ id: 'cp-older', runId: 'run-1', timestamp: 500 }));

    const result = await store.latest('run-1');
    expect(result!.id).toBe('cp-new');
  });

  it('latest, load and list put the checkpoint saved last first when timestamps are equal', async () => {
    // The runtime can save several checkpoints of a run in one millisecond.
    for (const id of ['cp-first', 'cp-second', 'cp-third']) {
      await store.save(makeCheckpoint({ id, runId: 'run-1', timestamp: 5000 }));
    }

    expect((await store.latest('run-1'))!.id).toBe('cp-third');
    expect((await store.load('run-1', 'node-a'))!.id).toBe('cp-third');
    expect((await store.list('graph-1')).map((meta) => meta.id)).toEqual(['cp-third', 'cp-second', 'cp-first']);
  });

  it('counts a checkpoint saved again under its id as the one saved last', async () => {
    await store.save(makeCheckpoint({ id: 'cp-a', runId: 'run-1', timestamp: 5000 }));
    await store.save(makeCheckpoint({ id: 'cp-b', runId: 'run-1', timestamp: 5000 }));
    await store.save(makeCheckpoint({ id: 'cp-a', runId: 'run-1', timestamp: 5000 }));

    expect((await store.latest('run-1'))!.id).toBe('cp-a');
    expect((await store.list('graph-1')).map((meta) => meta.id)).toEqual(['cp-a', 'cp-b']);
  });

  it('list returns metadata for all checkpoints of a graphId', async () => {
    await store.save(makeCheckpoint({ id: 'cp-1', graphId: 'graph-1', runId: 'run-1' }));
    await store.save(makeCheckpoint({ id: 'cp-2', graphId: 'graph-1', runId: 'run-2' }));
    await store.save(makeCheckpoint({ id: 'cp-x', graphId: 'graph-other', runId: 'run-3' }));

    const metas = await store.list('graph-1');
    expect(metas).toHaveLength(2);
    const ids = metas.map((m) => m.id);
    expect(ids).toContain('cp-1');
    expect(ids).toContain('cp-2');
  });

  it('list with limit caps the number of results (most-recent first)', async () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await store.save(makeCheckpoint({ id: `cp-${i}`, graphId: 'graph-1', runId: 'run-1', timestamp: base + i }));
    }

    const metas = await store.list('graph-1', { limit: 3 });
    expect(metas).toHaveLength(3);
    // Most recent first: timestamps base+4, base+3, base+2.
    expect(metas[0]!.id).toBe('cp-4');
    expect(metas[1]!.id).toBe('cp-3');
    expect(metas[2]!.id).toBe('cp-2');
    // A limit that is not above zero leaves the list whole, as InMemoryCheckpointStore's does.
    expect(await store.list('graph-1', { limit: 0 })).toHaveLength(5);
  });

  it('list with a limit beyond any whole number the database binds leaves the list whole, as InMemoryCheckpointStore does', async () => {
    const memory = new InMemoryCheckpointStore();
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      const checkpoint = makeCheckpoint({ id: `cp-${i}`, graphId: 'graph-1', runId: 'run-1', timestamp: base + i });
      await store.save(checkpoint);
      await memory.save(checkpoint);
    }

    // SQLite refuses a LIMIT it cannot hold as a 64-bit integer, and Postgres a BIGINT out of range.
    for (const limit of [1e21, Number.MAX_VALUE, Number.POSITIVE_INFINITY]) {
      expect((await store.list('graph-1', { limit })).map((m) => m.id)).toEqual(
        (await memory.list('graph-1', { limit })).map((m) => m.id),
      );
    }
    expect(await store.list('graph-1', { limit: Number.MAX_SAFE_INTEGER })).toHaveLength(3);
  });

  it('list with runId filter returns only checkpoints for that run', async () => {
    await store.save(makeCheckpoint({ id: 'cp-1', graphId: 'graph-1', runId: 'run-A' }));
    await store.save(makeCheckpoint({ id: 'cp-2', graphId: 'graph-1', runId: 'run-B' }));

    const metas = await store.list('graph-1', { runId: 'run-A' });
    expect(metas).toHaveLength(1);
    expect(metas[0]!.id).toBe('cp-1');
  });

  it('delete removes a checkpoint so subsequent load returns null', async () => {
    const cp = makeCheckpoint({ id: 'cp-del', runId: 'run-del' });
    await store.save(cp);

    await store.delete('cp-del');

    const loaded = await store.load('run-del');
    expect(loaded).toBeNull();
    expect(await store.get('cp-del')).toBeNull();
  });

  it('delete is a no-op for a non-existent checkpoint id', async () => {
    await expect(store.delete('does-not-exist')).resolves.toBeUndefined();
  });

  it('fork creates a new runId and the forked checkpoint is queryable', async () => {
    const original = makeCheckpoint({ id: 'cp-src', runId: 'run-src', graphId: 'graph-1' });
    await store.save(original);

    const newRunId = await store.fork('cp-src');

    expect(newRunId).not.toBe('run-src');
    const forked = await store.latest(newRunId);
    expect(forked).not.toBeNull();
    expect(forked!.graphId).toBe('graph-1');
    expect(forked!.id).not.toBe('cp-src');
  });

  it('fork with patchState applies patches and preserves unpatched fields', async () => {
    const original = makeCheckpoint({
      id: 'cp-patch',
      runId: 'run-patch',
      state: {
        input: { prompt: 'hello', lang: 'en' },
        scratch: { step: 1, count: 5 },
        artifacts: { result: 'old' },
        diagnostics: {
          totalTokensUsed: 0,
          totalDurationMs: 0,
          nodeTimings: {},
          discoveryResults: {},
          guardrailResults: {},
          checkpointsSaved: 0,
          memoryReads: 0,
          memoryWrites: 0,
        },
      },
      nodeResults: {},
      visitedNodes: ['node-a'],
      pendingEdges: ['e1'],
    });
    await store.save(original);

    const newRunId = await store.fork('cp-patch', {
      input: { prompt: 'patched' } as unknown,
      scratch: { step: 99 } as unknown,
    } as never);

    const forked = await store.latest(newRunId);
    expect(forked).not.toBeNull();

    // Patched fields are updated.
    expect((forked!.state.input as Record<string, unknown>)['prompt']).toBe('patched');
    expect((forked!.state.scratch as Record<string, unknown>)['step']).toBe(99);

    // Unpatched sibling fields are preserved by the merge.
    expect((forked!.state.input as Record<string, unknown>)['lang']).toBe('en');
    expect((forked!.state.scratch as Record<string, unknown>)['count']).toBe(5);

    // Artifacts unmodified.
    expect((forked!.state.artifacts as Record<string, unknown>)['result']).toBe('old');

    // Original checkpoint is unchanged.
    const src = await store.load('run-patch');
    expect((src!.state.input as Record<string, unknown>)['prompt']).toBe('hello');
  });

  it('fork throws when the source checkpointId does not exist', async () => {
    await expect(store.fork('cp-nonexistent')).rejects.toThrow(/not found/);
  });

  // What a SQL store adds ---------------------------------------------------

  it('reads a checkpoint back whole, and lists the metadata InMemoryCheckpointStore lists for it', async () => {
    const memory = new InMemoryCheckpointStore();
    for (const cp of [fullCheckpoint('cp-full'), makeCheckpoint({ id: 'cp-plain', runId: 'run-full', timestamp: 1 })]) {
      await store.save(structuredClone(cp));
      await memory.save(structuredClone(cp));
    }

    expect(await store.get('cp-full')).toEqual(fullCheckpoint('cp-full'));
    expect(await store.latest('run-full')).toEqual(fullCheckpoint('cp-full'));
    const listed = await store.list('graph-1');
    expect(listed).toEqual(await memory.list('graph-1'));
    expect(listed[0]).toEqual({
      id: 'cp-full',
      runId: 'run-full',
      graphId: 'graph-1',
      nodeId: 'approve',
      timestamp: 1_730_000_000_123,
      stateSize: JSON.stringify(fullCheckpoint('cp-full').state).length,
      hasMemorySnapshot: true,
    });
    expect(listed[1]!.hasMemorySnapshot).toBe(false);
  });

  it('a change to a checkpoint it returned, or to one it saved, changes nothing stored', async () => {
    const cp = fullCheckpoint('cp-full');
    await store.save(cp);
    (cp.state.scratch as Record<string, unknown>)['attempt'] = 99;
    const read = await store.get('cp-full');
    (read!.state.artifacts as Record<string, unknown>)['draft'] = 'changed';

    expect(await store.get('cp-full')).toEqual(fullCheckpoint('cp-full'));
  });

  it('keeps every checkpoint of saves that overlap, as a parallel batch makes them', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `cp-batch-${i}`);
    await Promise.all(ids.map((id) => store.save(makeCheckpoint({ id, runId: 'run-batch', timestamp: 7000 }))));

    const listed = (await store.list('graph-1', { runId: 'run-batch' })).map((meta) => meta.id);
    // One store runs its saves in the order they were called, so the save called last is the most recent.
    expect(listed).toEqual([...ids].reverse());
    expect((await store.latest('run-batch'))!.id).toBe('cp-batch-11');
  });

  it('a slow save called first stays older than a save called after it, as a parallel batch\'s branch saves need', async () => {
    // Branch A's save is slow to reach the database; branch B, done after A, saves what both wrote. A process that
    // stops before the batch's merged checkpoint resumes from the latest, which has to be B's, or B runs again.
    let inserts = 0;
    const slowFirstInsert = new Proxy(database.db, {
      get(target, key, receiver) {
        if (key === 'run') {
          return async (statement: string, parameters?: unknown[]) => {
            if (statement.startsWith('INSERT') && (inserts += 1) === 1) await new Promise((resolve) => setTimeout(resolve, 50));
            return target.run(statement, parameters);
          };
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const batch = new SqlCheckpointStore({ db: slowFirstInsert, tablePrefix: table });
    const memory = new InMemoryCheckpointStore();
    const branchA = makeCheckpoint({ id: 'cp-z-branch-a', runId: 'run-par', nodeId: 'a', timestamp: 9000, visitedNodes: ['a'] });
    const branchB = makeCheckpoint({ id: 'cp-a-branch-b', runId: 'run-par', nodeId: 'b', timestamp: 9000, visitedNodes: ['a', 'b'] });

    await Promise.all([batch.save(branchA), batch.save(branchB)]);
    await Promise.all([memory.save(branchA), memory.save(branchB)]);

    expect((await batch.latest('run-par'))!.visitedNodes).toEqual(['a', 'b']);
    expect((await batch.latest('run-par'))!.id).toBe((await memory.latest('run-par'))!.id);
    expect((await batch.list('graph-1', { runId: 'run-par' })).map((meta) => meta.id)).toEqual(
      (await memory.list('graph-1', { runId: 'run-par' })).map((meta) => meta.id),
    );
  });

  it('a save the database fails does not stop the saves queued behind it', async () => {
    let inserts = 0;
    const firstInsertFails = new Proxy(database.db, {
      get(target, key, receiver) {
        if (key === 'run') {
          return async (statement: string, parameters?: unknown[]) => {
            if (statement.startsWith('INSERT') && (inserts += 1) === 1) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              throw new Error('connection reset');
            }
            return target.run(statement, parameters);
          };
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const queued = new SqlCheckpointStore({ db: firstInsertFails, tablePrefix: table });

    const failed = queued.save(makeCheckpoint({ id: 'cp-lost', runId: 'run-queue' }));
    const saved = queued.save(makeCheckpoint({ id: 'cp-kept', runId: 'run-queue' }));
    await expect(failed).rejects.toThrow('connection reset');
    await saved;
    expect(await queued.get('cp-lost')).toBeNull();
    expect((await queued.latest('run-queue'))!.id).toBe('cp-kept');
  });

  it('keeps checkpoints under a prefix that is an SQL keyword', async () => {
    for (const keyword of ['check', 'order', 'select']) {
      await database.db.exec(`DROP TABLE IF EXISTS "${keyword}"`);
      try {
        const keywordStore = new SqlCheckpointStore({ db: database.db, tablePrefix: keyword });
        await keywordStore.save(makeCheckpoint({ id: 'cp-1', runId: 'run-kw', timestamp: 1000 }));
        await keywordStore.save(makeCheckpoint({ id: 'cp-2', runId: 'run-kw', timestamp: 2000 }));
        await keywordStore.save((await keywordStore.get('cp-1'))!);

        expect((await keywordStore.latest('run-kw'))!.id).toBe('cp-2');
        expect((await keywordStore.load('run-kw', 'node-a'))!.id).toBe('cp-2');
        expect((await keywordStore.list('graph-1', { limit: 1 })).map((meta) => meta.id)).toEqual(['cp-2']);
        const forkRun = await keywordStore.fork('cp-1');
        expect((await keywordStore.latest(forkRun))!.runId).toBe(forkRun);
        await keywordStore.delete('cp-2');
        expect(await keywordStore.get('cp-2')).toBeNull();
      } finally {
        await database.db.exec(`DROP TABLE IF EXISTS "${keyword}"`);
      }
    }
  });

  it('records the checkpoint a fork was made from, and none for a checkpoint saved', async () => {
    await store.save(makeCheckpoint({ id: 'cp-src', runId: 'run-src' }));
    const forkRunId = await store.fork('cp-src');
    const forkId = (await store.latest(forkRunId))!.id;

    const parentOf = async (id: string) =>
      (await database.db.get<{ parent_id: string | null }>(`SELECT parent_id FROM ${table} WHERE id = ?`, [id]))!.parent_id;
    expect(await parentOf(forkId)).toBe('cp-src');
    expect(await parentOf('cp-src')).toBeNull();

    // A save again under the fork's id keeps the record.
    await store.save((await store.get(forkId))!);
    expect(await parentOf(forkId)).toBe('cp-src');
  });

  it('keeps the checkpoints of a store under another prefix in the same database apart', async () => {
    const other = new SqlCheckpointStore({ db: database.db, tablePrefix: database.prefix() });
    await store.save(makeCheckpoint({ id: 'cp-1', runId: 'run-1' }));

    expect(await other.get('cp-1')).toBeNull();
    expect(await other.load('run-1')).toBeNull();
    expect(await other.load('run-1', 'node-a')).toBeNull();
    expect(await other.latest('run-1')).toBeNull();
    expect(await other.list('graph-1')).toEqual([]);
    await expect(other.fork('cp-1')).rejects.toThrow(/not found/);

    await other.delete('cp-1');
    await other.save(makeCheckpoint({ id: 'cp-1', runId: 'run-1', nodeId: 'node-b' }));
    expect((await store.get('cp-1'))!.nodeId).toBe('node-a');
    expect((await other.get('cp-1'))!.nodeId).toBe('node-b');
  });

  it('a second store over the same table reads what the first saved', async () => {
    await store.save(fullCheckpoint('cp-full'));

    const again = new SqlCheckpointStore({ db: database.db, tablePrefix: table });
    expect(await again.latest('run-full')).toEqual(fullCheckpoint('cp-full'));
  });
}

describe('SqlCheckpointStore over sql.js', () => {
  runCheckpointStoreCases(sqlite(['sqljs']));
});

describe('SqlCheckpointStore over better-sqlite3', () => {
  runCheckpointStoreCases(sqlite(['better-sqlite3']));
});

describe.skipIf(!POSTGRES_URL)('SqlCheckpointStore over Postgres', () => {
  runCheckpointStoreCases(openPostgres);

  afterAll(async () => {
    if (!postgres) return;
    for (const prefix of postgresPrefixes) await postgres.exec(`DROP TABLE IF EXISTS "${prefix}"`);
    await postgres.close();
  });
});

// ---------------------------------------------------------------------------
// The table, its name and its schema
// ---------------------------------------------------------------------------

describe('SqlCheckpointStore: its table', () => {
  let db: StorageAdapter;

  beforeEach(async () => {
    db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['sqljs'], quiet: true });
  });

  afterEach(async () => {
    await db.close();
  });

  it('checkpointDdl names one table and its indexes under a prefix, and refuses a prefix that does not fit an identifier', () => {
    const ddl = checkpointDdl('acme_checkpoints');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "acme_checkpoints" (');
    for (const column of ['id', 'graph_id', 'run_id', 'node_id', 'parent_id', 'created_at', 'save_seq', 'state_json', 'metadata_json']) {
      expect(ddl).toMatch(new RegExp(`\\n  ${column} `));
    }
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS "idx_acme_checkpoints_run" ON "acme_checkpoints"');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS "idx_acme_checkpoints_graph" ON "acme_checkpoints"');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS "idx_acme_checkpoints_seq" ON "acme_checkpoints"');
    // The Postgres adapter rewrites every question mark to a numbered parameter.
    expect(ddl).not.toContain('?');
    expect(checkpointDdl()).toBe(checkpointDdl('agentos_checkpoints'));

    // idx_<prefix>_graph fits the 63 bytes of a Postgres identifier at 53 characters, and not at 54.
    expect(() => checkpointDdl('a'.repeat(53))).not.toThrow();
    for (const bad of ['a'.repeat(54), '9bad', 'Bad', 'bad-name', 'bad name', '', 'x; DROP TABLE y']) {
      expect(() => checkpointDdl(bad)).toThrow(/tablePrefix/);
      expect(() => new SqlCheckpointStore({ db, tablePrefix: bad })).toThrow(/tablePrefix/);
    }
  });

  it('a store without a prefix keeps its checkpoints in agentos_checkpoints, which it makes on first use', async () => {
    const store = new SqlCheckpointStore({ db });
    await store.save(makeCheckpoint());

    const made = await db.all<{ type: string; name: string }>(
      `SELECT type, name FROM sqlite_master WHERE tbl_name = 'agentos_checkpoints' ORDER BY type, name`,
    );
    expect(made).toEqual([
      { type: 'index', name: 'idx_agentos_checkpoints_graph' },
      { type: 'index', name: 'idx_agentos_checkpoints_run' },
      { type: 'index', name: 'idx_agentos_checkpoints_seq' },
      { type: 'index', name: 'sqlite_autoindex_agentos_checkpoints_1' },
      { type: 'table', name: 'agentos_checkpoints' },
    ]);
  });

  it('with ensureSchema false runs no DDL: the product makes the table from checkpointDdl', async () => {
    const store = new SqlCheckpointStore({ db, tablePrefix: 'product_checkpoints', ensureSchema: false });
    await expect(store.save(makeCheckpoint())).rejects.toThrow(/product_checkpoints/);

    await db.exec(checkpointDdl('product_checkpoints'));
    await store.save(makeCheckpoint({ id: 'cp-migrated' }));
    expect((await store.get('cp-migrated'))!.id).toBe('cp-migrated');
  });

  it('refuses a checkpoint whose timestamp is not a whole number of milliseconds', async () => {
    const store = new SqlCheckpointStore({ db });
    await expect(store.save(makeCheckpoint({ timestamp: 1.5 }))).rejects.toThrow(/timestamp/);
    await expect(store.save(makeCheckpoint({ timestamp: Number.NaN }))).rejects.toThrow(/timestamp/);
    expect(await store.get('cp-1')).toBeNull();
  });

  it('rejects a save the database reports writing no row, so a lost checkpoint ends the run instead of passing', async () => {
    // A wrapper whose writes do nothing, as a write hook that drops them would.
    const dropsWrites = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'run') {
          return async (statement: string, parameters?: unknown[]) =>
            statement.startsWith('INSERT') ? { changes: 0, lastInsertRowid: null } : target.run(statement, parameters);
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const store = new SqlCheckpointStore({ db: dropsWrites });

    await expect(store.save(makeCheckpoint())).rejects.toThrow(/no row/);
  });

  it('saves when another session made the table between its read and its DDL, and makes the indexes that session had not', async () => {
    // Two stores start on an empty database: both reads find no table, the other session commits the table first,
    // and this one's CREATE TABLE IF NOT EXISTS fails on the catalogue's unique index, as Postgres fails it.
    let ddlRuns = 0;
    const losesTheRace = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'exec') {
          return async (script: string) => {
            ddlRuns += 1;
            if (ddlRuns > 1) return target.exec(script);
            await target.exec(checkpointDdl('raced_checkpoints').split(';')[0]!);
            throw Object.assign(new Error('duplicate key value violates unique constraint "pg_type_typname_nsp_index"'), {
              code: '23505',
              schema: 'pg_catalog',
            });
          };
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const store = new SqlCheckpointStore({ db: losesTheRace, tablePrefix: 'raced_checkpoints' });

    await store.save(makeCheckpoint({ id: 'cp-raced' }));
    expect((await store.get('cp-raced'))!.id).toBe('cp-raced');
    expect(ddlRuns).toBe(2);
    const indexes = await db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'raced_checkpoints' AND name LIKE 'idx_%' ORDER BY name`,
    );
    expect(indexes.map((index) => index.name)).toEqual([
      'idx_raced_checkpoints_graph',
      'idx_raced_checkpoints_run',
      'idx_raced_checkpoints_seq',
    ]);
  });

  it('rejects with the DDL error when the DDL fails for any other reason, and tries again on the next call', async () => {
    let failNext = true;
    const failsOnce = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'exec') {
          return async (script: string) => {
            if (failNext) {
              failNext = false;
              throw new Error('disk I/O error');
            }
            return target.exec(script);
          };
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const store = new SqlCheckpointStore({ db: failsOnce, tablePrefix: 'flaky_checkpoints' });

    await expect(store.save(makeCheckpoint({ id: 'cp-first' }))).rejects.toThrow('disk I/O error');
    await store.save(makeCheckpoint({ id: 'cp-second' }));
    expect((await store.get('cp-second'))!.id).toBe('cp-second');
  });

  it('serialises to a marker, never its adapter', () => {
    expect(JSON.stringify({ store: new SqlCheckpointStore({ db }) })).toBe('{"store":"[SqlCheckpointStore]"}');
  });
});

// ---------------------------------------------------------------------------
// A halted run resumed after a restart
// ---------------------------------------------------------------------------

const DRAFT = 'Draft the release notes.';
const PUBLISH = 'Publish the release notes.';

/** A scripted model for GMI nodes: each node's instructions map to the text the model streams back. */
function scriptedModel(replies: Record<string, string>) {
  const calls: string[] = [];
  async function* providerCall(instructions: string): AsyncGenerator<LoopChunk, LoopOutput, undefined> {
    calls.push(instructions);
    const reply = replies[instructions];
    if (reply === undefined) throw new Error(`no reply scripted for "${instructions}"`);
    yield { type: 'text_delta', content: reply };
    return { responseText: reply, toolCalls: [], finishReason: 'stop' };
  }
  return { calls, providerCall };
}

function runtimeOver(store: SqlCheckpointStore, providerCall: NodeExecutorDeps['providerCall']): GraphRuntime {
  return new GraphRuntime({
    checkpointStore: store,
    nodeExecutor: new NodeExecutor({ loopController: new LoopController(), providerCall }),
  });
}

/** draft (a model node), then approve (a human node), then publish (a model node). */
function releaseGraph(): CompiledExecutionGraph {
  const nodes: GraphNode[] = [
    { ...gmiNode({ instructions: DRAFT }), id: 'draft' },
    { ...humanNode({ prompt: 'Publish these notes?' }), id: 'approve' },
    { ...gmiNode({ instructions: PUBLISH }), id: 'publish' },
  ];
  return {
    id: 'g-release',
    name: 'g-release',
    nodes,
    edges: [
      { id: 'e0', source: START, target: 'draft', type: 'static' },
      { id: 'e1', source: 'draft', target: 'approve', type: 'static' },
      { id: 'e2', source: 'approve', target: 'publish', type: 'static' },
      { id: 'e3', source: 'publish', target: END, type: 'static' },
    ],
    stateSchema: { input: {}, scratch: {}, artifacts: {} },
    reducers: {},
    checkpointPolicy: 'explicit',
    memoryConsistency: 'live',
  };
}

/** Reads `stream` up to the first event of type `stopAt`, then stops as `break` does. */
async function readUntil(stream: AsyncIterable<GraphEvent>, stopAt: GraphEvent['type']): Promise<GraphEvent[]> {
  const seen: GraphEvent[] = [];
  for await (const event of stream) {
    seen.push(event);
    if (event.type === stopAt) break;
  }
  return seen;
}

describe('SqlCheckpointStore: a run halted for a person resumes after a restart', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-checkpoint-store-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a runtime over a new store on the same SQLite file resumes the run by its id and finishes it', async () => {
    const file = path.join(dir, 'checkpoints.sqlite');
    const open = () => resolveStorageAdapter({ filePath: file, priority: ['better-sqlite3', 'sqljs'], quiet: true });
    const model = scriptedModel({ [DRAFT]: 'Draft: v2 ships the importer.', [PUBLISH]: 'Published.' });
    const graph = releaseGraph();

    // The first process runs to the human node, which halts the run, and stops.
    const before = await open();
    const seen = await readUntil(runtimeOver(new SqlCheckpointStore({ db: before }), model.providerCall).stream(graph, { release: 'v2' }), 'interrupt');
    expect(seen[seen.length - 1]).toMatchObject({ type: 'interrupt', nodeId: 'approve' });
    const first = seen[0];
    if (first?.type !== 'run_start') throw new Error('the stream did not open with run_start');
    await before.close();

    // The next process opens the file again, with a store and a runtime of its own.
    const after = await open();
    try {
      const store = new SqlCheckpointStore({ db: after });
      expect(await store.latest(first.runId)).toMatchObject({
        graphId: 'g-release',
        nodeId: 'approve',
        visitedNodes: ['draft'],
        state: { input: { release: 'v2' }, artifacts: { draft: 'Draft: v2 ships the importer.' } },
        nodeResults: { approve: { effectClass: 'human', output: { prompt: 'Publish these notes?' } } },
      });

      const artifacts = await runtimeOver(store, model.providerCall).resume(graph, first.runId);
      expect(artifacts).toEqual({ draft: 'Draft: v2 ships the importer.', publish: 'Published.' });
      // The draft ran once, in the first process; the resumed run published.
      expect(model.calls).toEqual([DRAFT, PUBLISH]);
    } finally {
      await after.close();
    }
  });
});
