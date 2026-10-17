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
 * - `health()` and a Markdown export cover the brain's own rows;
 * - a SQLite export holds the brain's own rows, and an import of a SQLite
 *   file that holds several brains is refused;
 * - a SQLite import that merges a tag into a trace the brain holds leaves the
 *   trace found by that tag, and an import that also inserts a trace rebuilds
 *   the full-text index once;
 * - an Obsidian export links the brain's own knowledge-graph nodes, though
 *   node ids repeat across brains;
 * - on Postgres, a brain's full-text rebuild re-indexes its own rows;
 * - on Postgres, a trace a cognitive `MemoryStore` stores, a revival of it and
 *   a trace `Brain.importFromSqlite` writes are found by the words they hold as
 *   soon as the write returns, and a store re-indexes its own brain's row only.
 *
 * Inside one brain, recall's filters (type, scope, scope id, strength and
 * age) bind the hybrid recall's vector candidates as they bind its full-text
 * ones.
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
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';
import { Memory, type ScoredTrace } from '../Memory.js';
import { MemorySearchTool } from '../../tools/MemorySearchTool.js';
import { Brain } from '../../../retrieval/store/Brain.js';
import { MemoryStore } from '../../../retrieval/store/MemoryStore.js';
import { PORTABLE_TABLES } from '../../../retrieval/store/portable-tables.js';
import type { IKnowledgeGraph } from '../../../retrieval/graph/knowledge/IKnowledgeGraph.js';
import type { MemoryTrace } from '../../../core/types.js';
import { InMemoryVectorStore } from '../../../../rag/vector_stores/InMemoryVectorStore.js';
import type { IEmbeddingManager } from '../../../../../core/embeddings/IEmbeddingManager.js';
import type { ToolExecutionContext } from '../../../../../core/tools/ITool.js';
import type { VectorStoreProviderConfig } from '../../../../../core/vector-store/IVectorStore.js';

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
  vi.restoreAllMocks();
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

/** A memory on brain `brainId` of the Postgres test database. */
async function openPostgres(brainId: string): Promise<Memory> {
  const memory = await Memory.createPostgres(POSTGRES_URL!, {
    brainId,
    poolSize: 2,
    graph: false,
    selfImprove: false,
  });
  memories.push(memory);
  return memory;
}

/** Two new brains in the Postgres test database. */
async function postgresPair(): Promise<Pair> {
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { a: await openPostgres(`brain-scope-a-${run}`), b: await openPostgres(`brain-scope-b-${run}`) };
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

/**
 * A graph node for `traceId` linked to a node labelled `label`, in the brain's
 * own graph. The node and edge ids are the same in every brain, as two brains
 * that imported one file hold them.
 */
async function linkTrace(memory: Memory, traceId: string, label: string): Promise<void> {
  const brain = brainOf(memory);
  const now = Date.now();
  const node = `INSERT INTO knowledge_nodes (brain_id, id, type, label, properties, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`;
  await brain.run(node, [brain.brainId, 'kn-trace', 'memory', 'trace', JSON.stringify({ trace_id: traceId }), now]);
  await brain.run(node, [brain.brainId, 'kn-label', 'concept', label, '{}', now]);
  await brain.run(
    `INSERT INTO knowledge_edges (brain_id, id, source_id, target_id, type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [brain.brainId, 'ke-trace-label', 'kn-trace', 'kn-label', 'related_to', now],
  );
}

/**
 * A cognitive `MemoryStore` that writes through `brain`, as `CognitiveMemoryManager` attaches one: its vectors in
 * memory, embedded by `embed`, and no knowledge graph.
 */
async function cognitiveStore(brain: Brain): Promise<MemoryStore> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({
    id: `cognitive-${brain.brainId}`,
    type: 'in_memory',
    defaultEmbeddingDimension: 4,
    similarityMetric: 'cosine',
  } as VectorStoreProviderConfig);
  const embeddingManager = {
    async generateEmbeddings(input: { texts: string | string[] }) {
      const texts = Array.isArray(input.texts) ? input.texts : [input.texts];
      return {
        embeddings: await Promise.all(texts.map(embed)),
        model: 'test',
        usage: { promptTokens: 0, totalTokens: 0 },
      };
    },
  };
  const store = new MemoryStore({
    vectorStore,
    embeddingManager: embeddingManager as unknown as IEmbeddingManager,
    knowledgeGraph: { recordMemory: async () => 'noop' } as unknown as IKnowledgeGraph,
    collectionPrefix: 'cogmem',
  });
  store.setBrain(brain);
  return store;
}

/** A trace for `MemoryStore.store`, with no tags. */
function storedTrace(id: string, content: string): MemoryTrace {
  const now = Date.now();
  return {
    id,
    type: 'semantic',
    scope: 'user',
    scopeId: 'u1',
    content,
    entities: [],
    tags: [],
    provenance: { sourceType: 'user_statement', sourceTimestamp: now, confidence: 1, verificationCount: 0 },
    emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: '' },
    encodingStrength: 0.5,
    stability: 0.5,
    retrievalCount: 0,
    lastAccessedAt: now,
    accessCount: 0,
    reinforcementInterval: 0,
    associatedTraceIds: [],
    createdAt: now,
    updatedAt: now,
    isActive: true,
  } as MemoryTrace;
}

const toolContext: ToolExecutionContext = {
  gmiId: 'test-gmi',
  personaId: 'test-persona',
  userContext: { userId: 'default-user' } as ToolExecutionContext['userContext'],
};

/** The ids the `memory_search` tool returns from `brain` for `query`. */
async function searchIds(brain: Brain, query: string): Promise<string[]> {
  const result = await new MemorySearchTool(brain).execute({ query }, toolContext);
  expect(result.error).toBeUndefined();
  return ((result.output as { results?: Array<{ id: string }> } | undefined)?.results ?? []).map((row) => row.id);
}

/** A new SQLite file under brain id `brainId` holding `traces`, each an id and its text, as an export holds them. */
async function portableFile(brainId: string, traces: Array<[id: string, content: string]>): Promise<string> {
  const file = path.join(newDir('agentos-brain-portable-'), 'portable.sqlite');
  const brain = await Brain.openSqlite(file, { brainId });
  try {
    for (const [id, content] of traces) {
      await brain.run(
        `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
         VALUES (?, ?, 'semantic', 'user', ?, ?)`,
        [brainId, id, content, Date.now()],
      );
    }
  } finally {
    await brain.close();
  }
  return file;
}

/** A new, empty folder under the system's temporary folder. */
function newDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
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

  it.skipIf(skip)('writes its own rows to a SQLite export', async () => {
    const { a, b } = await open();
    await a.remember('Ana keeps the locker key in the blue tin');
    await b.remember('The garden beds get water every Friday');
    const out = path.join(newDir('agentos-brain-export-'), 'brain-a.sqlite');

    const result = await a.export(out, { format: 'sqlite' });

    expect(result.refused).toEqual([]);
    const file = await resolveStorageAdapter({ filePath: out, priority: ['better-sqlite3', 'sqljs'], quiet: true });
    try {
      const traces = await file.all<{ brain_id: string; content: string }>(
        'SELECT brain_id, content FROM memory_traces',
      );
      expect(traces).toEqual([{ brain_id: brainOf(a).brainId, content: 'Ana keeps the locker key in the blue tin' }]);
      const brains = await file.all<{ brain_id: string }>('SELECT DISTINCT brain_id FROM brain_meta');
      expect(brains.map((row) => row.brain_id)).toEqual([brainOf(a).brainId]);
    } finally {
      await file.close();
    }
  });

  it.skipIf(skip)('finds a trace by a tag a SQLite import merged into it', async () => {
    const { a } = await open();
    const text = 'We took the night train along the coast';
    const held = await a.remember(text, { tags: ['travel'] });
    // Another brain's SQLite export holds the same text, tagged 'vacation'.
    const source = await openSqlite(path.join(newDir('agentos-brain-tags-'), 'source.sqlite'), 'brain-source');
    await source.remember(text, { tags: ['vacation'] });
    const file = path.join(newDir('agentos-brain-tags-export-'), 'source.sqlite');
    await source.export(file, { format: 'sqlite' });

    const result = await a.importFrom(file, { format: 'sqlite' });

    // The record is a duplicate of the trace the brain holds: its tag is merged into that trace, and the
    // full-text index covers the tags.
    expect(result).toMatchObject({ imported: 0, skipped: 1, errors: [] });
    expect(await searchIds(brainOf(a), 'vacation')).toEqual([held.id]);
    expect(await searchIds(brainOf(a), 'travel')).toEqual([held.id]);
  });

  it.skipIf(skip)('rebuilds the full-text index once for a SQLite import that inserts a trace and merges a tag', async () => {
    const { a } = await open();
    const text = 'We took the night train along the coast';
    const held = await a.remember(text, { tags: ['travel'] });
    // The export holds the same text tagged 'vacation', and a trace the brain does not hold.
    const source = await openSqlite(path.join(newDir('agentos-brain-mixed-'), 'source.sqlite'), 'brain-source');
    await source.remember(text, { tags: ['vacation'] });
    const fresh = await source.remember('The ferry I take is called the Vastrelle.');
    const file = path.join(newDir('agentos-brain-mixed-export-'), 'source.sqlite');
    await source.export(file, { format: 'sqlite' });
    const brain = brainOf(a);
    const rebuild = brain.fullTextRebuild().sql;
    const run = vi.spyOn(brain, 'run');

    const result = await a.importFrom(file, { format: 'sqlite' });

    expect(result).toMatchObject({ imported: 1, skipped: 1, errors: [] });
    expect(run.mock.calls.filter(([sql]) => sql === rebuild)).toHaveLength(1);
    expect(await searchIds(brain, 'vacation')).toEqual([held.id]);
    expect(await searchIds(brain, 'Vastrelle')).toEqual([fresh.id]);
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

  it("links its own knowledge graph's nodes in an Obsidian export", async () => {
    const { a, b, file } = await sqlitePair();
    const trace = await a.remember('Ana keeps the locker key in the blue tin');
    // Brain B's graph uses the same node ids and names brain A's trace id.
    await linkTrace(a, trace.id, 'Blue tin');
    await linkTrace(b, trace.id, 'Harbor gate code');

    const out = path.join(path.dirname(file), 'vault-a');
    const result = await a.export(out, { format: 'obsidian' });

    expect(result.refused).toEqual([]);
    const written = filesUnder(out).join('\n');
    expect(written).toContain('[[Blue tin]]');
    expect(written).not.toContain('Harbor gate code');
  });

  it('refuses to import a SQLite file that holds several brains, and imports a single-brain export', async () => {
    const { a, b, file } = await sqlitePair();
    await a.remember('Ana keeps the locker key in the blue tin');
    await b.remember('The garden beds get water every Friday');
    const c = await openSqlite(path.join(path.dirname(file), 'brain-c.sqlite'), 'brain-c');
    const tracesOfC = async (): Promise<string[]> =>
      (await brainOf(c).all<{ content: string }>('SELECT content FROM memory_traces WHERE brain_id = ?', ['brain-c'])).map(
        (row) => row.content,
      );

    const shared = await c.importFrom(file, { format: 'sqlite' });

    expect(shared.imported).toBe(0);
    expect(shared.errors).toHaveLength(1);
    expect(shared.errors[0]).toContain('brain-a');
    expect(shared.errors[0]).toContain('brain-b');
    expect(await tracesOfC()).toEqual([]);

    // Brain A's own SQLite export holds brain A alone.
    const exported = path.join(path.dirname(file), 'brain-a-export.sqlite');
    await a.export(exported, { format: 'sqlite' });
    const single = await c.importFrom(exported, { format: 'sqlite' });

    expect(single.errors).toEqual([]);
    expect(single.imported).toBe(1);
    expect(await tracesOfC()).toEqual(['Ana keeps the locker key in the blue tin']);
  });
});

// ---------------------------------------------------------------------------
// One brain: recall's filters bind the vector candidates
// ---------------------------------------------------------------------------

describe('one brain with its HNSW index active', () => {
  it("applies recall's filters to the vector candidates as to the full-text ones", async () => {
    const { b } = await sqlitePair();
    const home = await b.remember('Ana keeps the locker key in the blue tin', { type: 'semantic', scopeId: 'home' });
    const gym = await b.remember('The gym locker has a new padlock', { type: 'episodic', scope: 'team', scopeId: 'gym' });
    // An import builds the brain's index from its traces that carry an embedding: the two above.
    await b.importFromString(JSON.stringify({ traces: [{ content: 'Bo moved the bike rack to the yard' }] }), 'json');
    expect((await indexOf(b))?.size).toBe(2);
    const brain = brainOf(b);

    // "combination" shares no word with any trace; its vector is the locker axis, so both
    // traces reach the recall as vector candidates only.
    expect(idsOf(await b.recall('combination')).sort()).toEqual([home.id, gym.id].sort());

    // A recall moves the strength of what it returns, so the weak trace is set just before.
    await brain.run('UPDATE memory_traces SET strength = 0.2 WHERE brain_id = ? AND id = ?', [brain.brainId, home.id]);
    expect(idsOf(await b.recall('combination', { minStrength: 0.5 }))).toEqual([gym.id]);

    expect(idsOf(await b.recall('combination', { type: 'episodic' }))).toEqual([gym.id]);
    expect(idsOf(await b.recall('combination', { type: 'semantic' }))).toEqual([home.id]);
    expect(idsOf(await b.recall('combination', { scope: 'team' }))).toEqual([gym.id]);
    expect(idsOf(await b.recall('combination', { scopeId: 'home' }))).toEqual([home.id]);
    expect(idsOf(await b.recall('combination', { after: Date.now() + 60_000 }))).toEqual([]);
    expect(idsOf(await b.recall('combination', { before: 1 }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Postgres: the full-text rebuild
// ---------------------------------------------------------------------------

describe('two brains in a Postgres database', () => {
  it.skipIf(!POSTGRES_URL)("rebuilds the full-text index of its own rows only", async () => {
    const { a, b } = await postgresPair();
    const inB = await b.remember('The ferry leaves at noon');
    const brainB = brainOf(b);
    // Brain B's trace carries a marker in its full-text column; a rebuild in brain A leaves brain B's
    // rows as they are. (Not a null: a brain opening meanwhile fills a null in, whoever owns the row.)
    await brainB.run(`UPDATE memory_traces SET _tsv = to_tsvector('simple', 'untouched') WHERE brain_id = ? AND id = ?`, [
      brainB.brainId,
      inB.id,
    ]);

    // An import rebuilds the importing brain's full-text index.
    await a.importFromString(
      JSON.stringify({ traces: [{ content: 'Ana keeps the locker key in the blue tin' }] }),
      'json',
    );

    const marked = await brainB.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM memory_traces WHERE brain_id = ? AND id = ? AND _tsv = to_tsvector('simple', 'untouched')`,
      [brainB.brainId, inB.id],
    );
    expect(Number(marked?.n)).toBe(1);
    expect(idsOf(await a.recall('locker blue tin'))).toHaveLength(1);
  });

  it.skipIf(!POSTGRES_URL)('searches its own brain through the search tool, the best match first', async () => {
    const { a, b } = await postgresPair();
    const once = await a.remember('A ferry crossed the bay');
    const thrice = await a.remember('The ferry, the night ferry and the morning ferry');
    await b.remember('The ferry timetable is pinned by the door');

    const context: ToolExecutionContext = {
      gmiId: 'test-gmi',
      personaId: 'test-persona',
      userContext: { userId: 'default-user' } as ToolExecutionContext['userContext'],
    };
    const result = await new MemorySearchTool(brainOf(a)).execute({ query: 'ferry' }, context);
    const ids = ((result.output as { results?: Array<{ id: string }> } | undefined)?.results ?? []).map((row) => row.id);
    // ts_rank grows with the matches it counts, so the trace that names the ferry three times leads.
    expect(ids).toEqual([thrice.id, once.id]);
  });

  it.skipIf(!POSTGRES_URL)('finds a trace a cognitive MemoryStore stores as soon as it is stored', async () => {
    const { a } = await postgresPair();
    const store = await cognitiveStore(brainOf(a));

    await store.store(storedTrace('t-plain', 'The ferry I take is called the Vastrelle.'));

    expect(await searchIds(brainOf(a), 'Vastrelle')).toEqual(['t-plain']);
  });

  it.skipIf(!POSTGRES_URL)('finds a revived trace by its new words only, before and after a reopen', async () => {
    const { a } = await postgresPair();
    const brain = brainOf(a);
    const store = await cognitiveStore(brain);
    await store.store(storedTrace('t-revived', 'The street I grew up on was Thornquay Lane.'));
    expect(await searchIds(brain, 'Thornquay')).toEqual(['t-revived']);

    // The upsert's SET list names the columns it writes; the full-text column holds the old words unless the
    // store re-indexes the row, and an open fills only a column that is null.
    await store.store(storedTrace('t-revived', 'My childhood parakeet was named Silverpip.'));

    expect(await searchIds(brain, 'Silverpip')).toEqual(['t-revived']);
    expect(await searchIds(brain, 'Thornquay')).toEqual([]);
    const reopened = brainOf(await openPostgres(brain.brainId));
    expect(await searchIds(reopened, 'Silverpip')).toEqual(['t-revived']);
    expect(await searchIds(reopened, 'Thornquay')).toEqual([]);
  });

  it.skipIf(!POSTGRES_URL)("re-indexes the storing brain's row only when another brain holds the same trace id", async () => {
    const { a, b } = await postgresPair();
    const brainB = brainOf(b);
    await (await cognitiveStore(brainB)).store(storedTrace('t-shared', 'bananas from the market'));
    // Brain B's row carries a marker in its full-text column; a store in brain A leaves it as it is.
    await brainB.run(`UPDATE memory_traces SET _tsv = to_tsvector('simple', 'untouched') WHERE brain_id = ? AND id = ?`, [
      brainB.brainId,
      't-shared',
    ]);

    await (await cognitiveStore(brainOf(a))).store(storedTrace('t-shared', 'apples from the orchard'));

    expect(await searchIds(brainOf(a), 'apples')).toEqual(['t-shared']);
    expect(await searchIds(brainB, 'apples')).toEqual([]);
    const marked = await brainB.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM memory_traces WHERE brain_id = ? AND id = ? AND _tsv = to_tsvector('simple', 'untouched')`,
      [brainB.brainId, 't-shared'],
    );
    expect(Number(marked?.n)).toBe(1);
  });

  it.skipIf(!POSTGRES_URL)('finds the traces Brain.importFromSqlite writes by the words they hold, without a reopen', async () => {
    const { a } = await postgresPair();
    const brain = brainOf(a);
    const held = await a.remember('The street I grew up on was Thornquay Lane.');
    expect(await searchIds(brain, 'Thornquay')).toEqual([held.id]);
    // The file holds the trace the brain holds, with new words, and a trace the brain does not hold.
    const file = await portableFile('portable', [
      [held.id, 'My childhood parakeet was named Silverpip.'],
      ['t-new', 'The ferry I take is called the Vastrelle.'],
    ]);

    await brain.importFromSqlite(file);

    expect(await searchIds(brain, 'Silverpip')).toEqual([held.id]);
    expect(await searchIds(brain, 'Thornquay')).toEqual([]);
    expect(await searchIds(brain, 'Vastrelle')).toEqual(['t-new']);
  });
});
