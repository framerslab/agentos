/**
 * @fileoverview Two brains in one database, through the Memory facade.
 *
 * Every row of a brain's tables carries the brain's id, so one database can
 * hold several brains. These tests open two `Memory` instances with different
 * brain ids on ONE database: a SQLite file through
 * `@framers/sql-storage-adapter` and, when `AGENTOS_TEST_POSTGRES_URL` is set
 * (CI's Test & Lint job sets it), a Postgres database. Each instance must
 * store, recall, count and export its own brain's rows only:
 *
 * - the same text stored in both brains becomes two traces, one in each;
 * - recall by text in one brain never returns the other brain's trace, with
 *   the full-text index and without it;
 * - with the HNSW index active, recall by meaning in one brain never returns
 *   the other brain's trace, a brain's index is built from its own traces, and
 *   the 1,000-trace threshold counts its own traces;
 * - a brain opened later does not load another brain's index file;
 * - `health()` and a Markdown export cover the brain's own rows.
 *
 * hnswlib-node is a native addon whose build pnpm skips in CI, so the index
 * the sidecar loads is replaced here by an exact nearest-neighbour index with
 * the same methods, written to and read from the index file as JSON.
 * Everything else is the code a host runs: Memory, HnswSidecar,
 * HnswIndexSidecar and the database.
 *
 * @module memory/facade/__tests__/Memory.brain-scope.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory, type ScoredTrace } from '../Memory.js';
import type { Brain } from '../../../retrieval/store/Brain.js';
import { PORTABLE_TABLES } from '../../../retrieval/store/portable-tables.js';

vi.mock('hnswlib-node', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');

  const cosineDistance = (a: number[], b: number[]): number => {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    return normA === 0 || normB === 0 ? 1 : 1 - dot / Math.sqrt(normA * normB);
  };

  /** Exact nearest neighbours behind hnswlib-node's HierarchicalNSW methods. */
  class HierarchicalNSW {
    private points = new Map<number, number[]>();
    private readonly removed = new Set<number>();

    constructor(_space: string, _dimensions: number) {}

    initIndex(_capacity: number, _m?: number, _efConstruction?: number): void {}

    setEf(_ef: number): void {}

    resizeIndex(_capacity: number): void {}

    addPoint(vector: number[], label: number): void {
      this.points.set(label, [...vector]);
    }

    markDelete(label: number): void {
      this.removed.add(label);
    }

    searchKnn(query: number[], k: number): { neighbors: number[]; distances: number[] } {
      const ranked = [...this.points.entries()]
        .filter(([label]) => !this.removed.has(label))
        .map(([label, vector]) => ({ label, distance: cosineDistance(query, vector) }))
        .sort((x, y) => x.distance - y.distance)
        .slice(0, k);
      return { neighbors: ranked.map((r) => r.label), distances: ranked.map((r) => r.distance) };
    }

    writeIndex(file: string): void {
      writeFileSync(file, JSON.stringify([...this.points.entries()]));
    }

    readIndex(file: string): void {
      this.points = new Map(JSON.parse(readFileSync(file, 'utf8')) as Array<[number, number[]]>);
    }
  }

  return { HierarchicalNSW, default: { HierarchicalNSW } };
});

// ---------------------------------------------------------------------------
// Embeddings: one axis per topic. A query word that names a topic without
// sharing a word with any trace reaches a trace by its vector alone.
// ---------------------------------------------------------------------------

const LOCKER = [1, 0, 0, 0];
const GARDEN = [0, 1, 0, 0];
const HARBOR = [0, 0, 1, 0];
const OTHER = [0, 0, 0, 1];

async function embed(text: string): Promise<number[]> {
  if (/locker|combination/i.test(text)) return LOCKER;
  if (/garden|seedling/i.test(text)) return GARDEN;
  if (/harbor|crossing/i.test(text)) return HARBOR;
  return OTHER;
}

// ---------------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------------

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;

const dirs: string[] = [];
const memories: Memory[] = [];

afterEach(async () => {
  while (memories.length > 0) {
    const memory = memories.pop()!;
    const brain = brainOf(memory);
    if (brain.features.dialect.name === 'postgres') {
      // The Postgres database outlives the test: remove this brain's rows, children before parents.
      for (const table of [...PORTABLE_TABLES].reverse()) {
        await brain.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brain.brainId]).catch(() => undefined);
      }
    }
    await memory.close().catch(() => undefined);
  }
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Pair {
  a: Memory;
  b: Memory;
}

function brainOf(memory: Memory): Brain {
  return (memory as unknown as { _brain: Brain })._brain;
}

/** The memory's HNSW sidecar, once its start-up has finished. */
async function indexOf(memory: Memory): Promise<{ readonly isActive: boolean; readonly size: number } | null> {
  const internals = memory as unknown as {
    _initPromise: Promise<void>;
    _hnswSidecar: { readonly isActive: boolean; readonly size: number } | null;
  };
  await internals._initPromise;
  return internals._hnswSidecar;
}

const idsOf = (results: ScoredTrace[]): string[] => results.map((result) => result.trace.id);

async function openSqlite(file: string, brainId: string): Promise<Memory> {
  const memory = await Memory.createSqlite(file, {
    brainId,
    embed,
    embeddings: { provider: 'test', dimensions: 4 },
    graph: false,
    selfImprove: false,
  });
  memories.push(memory);
  return memory;
}

/** Brains `brain-a` and `brain-b` in one new SQLite file. */
async function sqlitePair(): Promise<Pair & { file: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-brain-scope-'));
  dirs.push(dir);
  const file = path.join(dir, 'brain.sqlite');
  return { a: await openSqlite(file, 'brain-a'), b: await openSqlite(file, 'brain-b'), file };
}

/** Two new brains in the Postgres test database. */
async function postgresPair(): Promise<Pair> {
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const open = async (brainId: string): Promise<Memory> => {
    const memory = await Memory.createPostgres(POSTGRES_URL!, {
      brainId,
      poolSize: 2,
      graph: false,
      selfImprove: false,
    });
    memories.push(memory);
    return memory;
  };
  return { a: await open(`brain-scope-a-${run}`), b: await open(`brain-scope-b-${run}`) };
}

/** Rows written straight to the brain's table, each with `vector` as its embedding. */
async function seedEmbedded(memory: Memory, count: number, vector: number[]): Promise<void> {
  const brain = brainOf(memory);
  const embedding = brain.features.blobCodec.encode(vector);
  await brain.transaction(async (trx) => {
    for (let i = 0; i < count; i++) {
      await trx.run(
        `INSERT INTO memory_traces (brain_id, id, type, scope, content, embedding, created_at)
         VALUES (?, ?, 'episodic', 'user', ?, ?, ?)`,
        [brain.brainId, `seed-${brain.brainId}-${i}`, `Seed note ${i}`, embedding, Date.now()],
      );
    }
  });
}

/** Every file under `dir`, read as text. */
function filesUnder(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .map((entry) => path.join(dir, entry))
    .filter((file) => fs.statSync(file).isFile())
    .map((file) => fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Both backends
// ---------------------------------------------------------------------------

describe.each([
  { backend: 'a SQLite file', open: sqlitePair, skip: false },
  { backend: 'a Postgres database', open: postgresPair, skip: !POSTGRES_URL },
])('two brains in $backend', ({ open, skip }) => {
  it.skipIf(skip)('stores the same text as two traces, one in each brain', async () => {
    const { a, b } = await open();
    const text = 'Ana keeps the locker key in the blue tin';

    const inA = await a.remember(text);
    const inB = await b.remember(text);

    expect(inB.id).not.toBe(inA.id);
    expect(inB.content).toBe(text);
    for (const [memory, trace] of [[a, inA], [b, inB]] as const) {
      const brain = brainOf(memory);
      const rows = await brain.all<{ id: string }>(
        'SELECT id FROM memory_traces WHERE brain_id = ? AND deleted = 0',
        [brain.brainId],
      );
      expect(rows.map((row) => row.id)).toEqual([trace.id]);
    }
    // Inside one brain the text is still stored once.
    expect((await b.remember(text)).id).toBe(inB.id);
  });

  it.skipIf(skip)('recalls by text from its own brain only', async () => {
    const { a, b } = await open();
    const inA = await a.remember('The lighthouse keeper counts pelicans at dawn');
    const inB = await b.remember('The orchard ladder leans against the barn');

    expect(idsOf(await b.recall('lighthouse pelicans'))).toEqual([]);
    expect(idsOf(await a.recall('orchard ladder'))).toEqual([]);
    expect(idsOf(await a.recall('lighthouse pelicans'))).toEqual([inA.id]);
    expect(idsOf(await b.recall('orchard ladder'))).toEqual([inB.id]);
    // A filter binds beside the brain id.
    expect(idsOf(await b.recall('orchard ladder', { type: 'episodic' }))).toEqual([inB.id]);
    expect(idsOf(await b.recall('orchard ladder', { type: 'semantic' }))).toEqual([]);
  });

  it.skipIf(skip)('reports health for its own brain', async () => {
    const { a, b } = await open();
    await a.remember('The shed key hangs by the door');
    await b.remember('The ferry leaves at noon');
    await b.remember('The ferry returns at six');

    const healthA = await a.health();
    const healthB = await b.health();

    expect(healthA.totalTraces).toBe(1);
    expect(healthA.activeTraces).toBe(1);
    expect(healthA.tracesPerScope).toEqual({ user: 1 });
    expect(healthB.totalTraces).toBe(2);
    expect(healthB.activeTraces).toBe(2);
    expect(healthB.tracesPerType).toEqual({ episodic: 2 });
    expect(healthB.documentsIngested).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SQLite: the full-text fallback, the HNSW index and the Markdown export
// ---------------------------------------------------------------------------

describe('two brains in a SQLite file', () => {
  it('recalls by text from its own brain only when the database has no full-text index', async () => {
    const { a, b } = await sqlitePair();
    // A SQLite build without FTS5 has no index; recall falls back to LIKE matching.
    await brainOf(a).exec('DROP TABLE memory_traces_fts');
    const inA = await a.remember('The lighthouse keeper counts pelicans at dawn');
    const inB = await b.remember('The orchard ladder leans against the barn');

    expect(idsOf(await b.recall('lighthouse pelicans'))).toEqual([]);
    expect(idsOf(await a.recall('lighthouse pelicans'))).toEqual([inA.id]);
    expect(idsOf(await b.recall('orchard ladder', { type: 'episodic' }))).toEqual([inB.id]);
  });

  it("builds a brain's HNSW index from its own traces and recalls by meaning from it", async () => {
    const { a, b } = await sqlitePair();
    const lockerInA = await a.remember('Ana keeps the locker key in the blue tin');
    const gardenInB = await b.remember('The garden beds get water every Friday');

    // An import rebuilds the brain's index from its traces that carry an embedding, at any count.
    const imported = await b.importFromString(
      JSON.stringify({ traces: [{ content: 'Bo moved the bike rack to the yard' }] }),
      'json',
    );
    expect(imported.imported).toBe(1);

    const indexB = await indexOf(b);
    expect(indexB).not.toBeNull();
    expect(indexB!.isActive).toBe(true);
    expect(indexB!.size).toBe(1);

    // "combination" shares no word with any trace; its vector is the locker axis.
    expect(idsOf(await b.recall('combination'))).toEqual([gardenInB.id]);
    // The lexical half of the hybrid recall reads brain B's traces only, too.
    expect(idsOf(await b.recall('locker blue tin'))).not.toContain(lockerInA.id);
  });

  it("does not load another brain's index file when a brain opens", async () => {
    const { a, b, file } = await sqlitePair();
    await a.remember('Ana keeps the locker key in the blue tin');
    const gardenInB = await b.remember('The garden beds get water every Friday');
    await b.importFromString(JSON.stringify({ traces: [{ content: 'Bo moved the bike rack to the yard' }] }), 'json');
    // Brain B's index is built, and written beside the database file.
    expect((await indexOf(b))?.isActive).toBe(true);

    const aLater = await openSqlite(file, 'brain-a');

    // Brain A has built no index of its own.
    expect((await indexOf(aLater))?.isActive).toBe(false);
    // "seedling" shares no word with any trace; its vector is the garden axis.
    expect(idsOf(await aLater.recall('seedling'))).not.toContain(gardenInB.id);
  });

  it('counts and indexes its own traces at the 1,000-trace threshold', async () => {
    const { a, b } = await sqlitePair();
    const harbor = Buffer.from(brainOf(b).features.blobCodec.encode(HARBOR)).toString('base64');
    const traces = Array.from({ length: 1000 }, (_, i) => ({ content: `Harbor log entry ${i}`, embedding: harbor }));
    expect((await b.importFromString(JSON.stringify({ traces }), 'json')).imported).toBe(1000);
    const bIds = new Set(
      (await brainOf(b).all<{ id: string }>('SELECT id FROM memory_traces WHERE brain_id = ?', ['brain-b'])).map(
        (row) => row.id,
      ),
    );
    expect(bIds.size).toBe(1000);

    // Brain A's first store: one trace of its own, below the threshold however many brain B holds.
    await a.remember('Ana keeps the locker key in the blue tin');
    expect((await indexOf(a))?.isActive).toBe(false);
    // "crossing" shares no word with any trace; its vector is the harbor axis.
    expect(idsOf(await a.recall('crossing'))).toEqual([]);

    // Brain A reaches 1,000 traces of its own; that store builds A's index from A's vectors.
    await seedEmbedded(a, 998, GARDEN);
    await a.remember('The garden beds get water every Friday');
    const indexA = await indexOf(a);
    expect(indexA?.isActive).toBe(true);
    expect(indexA?.size).toBe(1000);
    const byMeaning = idsOf(await a.recall('crossing'));
    expect(byMeaning.length).toBeGreaterThan(0);
    expect(byMeaning.filter((id) => bIds.has(id))).toEqual([]);
  });

  it('writes its own traces to a Markdown export', async () => {
    const { a, b, file } = await sqlitePair();
    await a.remember('Ana keeps the locker key in the blue tin');
    await b.remember('The garden beds get water every Friday');

    const out = path.join(path.dirname(file), 'export-b');
    const result = await b.export(out, { format: 'markdown' });

    expect(result.refused).toEqual([]);
    const written = filesUnder(out);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('The garden beds get water every Friday');
  });
});
