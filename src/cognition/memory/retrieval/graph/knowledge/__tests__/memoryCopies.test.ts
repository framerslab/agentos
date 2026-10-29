/**
 * @file memoryCopies.test.ts
 * A memory trace's episodic copy in the in-memory graph and in `SqlKnowledgeGraph`: the copy is keyed by its trace,
 * so recording the trace again replaces it, a delete by trace id finds it by key, and the relations that name a copy go
 * with it in both. In SQL the delete reads no
 * memory node once the graph has re-keyed, at its first delete by trace id, the copies an older release recorded
 * under a random node id. A real SQLite Brain, and a Postgres one where CI provides it (`AGENTOS_TEST_POSTGRES_URL`):
 * a relation that names a copy goes with the copy and moves with it to its key, a move that fails keeps the copy for a
 * later graph and a delete by its trace id still deletes it, and a scope id that holds a quote or a backslash finds its
 * copies on both.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../../../store/Brain.js';
import { SqlKnowledgeGraph } from '../../../store/SqlKnowledgeGraph.js';
import { PORTABLE_TABLES } from '../../../store/portable-tables.js';
import { KnowledgeGraph } from '../KnowledgeGraph.js';
import type { EpisodicMemory, IKnowledgeGraph, KnowledgeSource } from '../IKnowledgeGraph.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;

const dirs: string[] = [];
const brains: Brain[] = [];
/** Postgres brains share CI's database: each test's rows are deleted by its brain id before the brain closes. */
const postgresBrains: Brain[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (postgresBrains.length) {
    const brain = postgresBrains.pop()!;
    for (const table of [...PORTABLE_TABLES].reverse()) {
      await brain.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brain.brainId]).catch(() => undefined);
    }
  }
  while (brains.length) await brains.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function openBrain(): Promise<Brain> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-copies-'));
  dirs.push(dir);
  const brain = await Brain.openSqlite(path.join(dir, 'brain.sqlite'), { brainId: 'agent-1' });
  brains.push(brain);
  return brain;
}

async function openPostgresBrain(): Promise<Brain> {
  const brain = await Brain.openPostgres(POSTGRES_URL!, {
    brainId: `memory-copies-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  brains.push(brain);
  postgresBrains.push(brain);
  return brain;
}

const SOURCE: KnowledgeSource = { type: 'system', timestamp: new Date().toISOString() };

/** A copy as an older release recorded it: a random node id, the trace named only in the stored context. */
async function insertOlderCopy(brain: Brain, id: string, traceId: string, scopeId: string, text: string): Promise<void> {
  const properties = {
    _props: {},
    _memoryType: 'conversation',
    _summary: text,
    _description: text,
    _participants: [scopeId],
    _context: { memoryTraceId: traceId, scope: 'user', scopeId, type: 'episodic' },
  };
  await brain.run(
    `INSERT INTO knowledge_nodes (brain_id, id, type, label, properties, embedding, confidence, source, created_at)
     VALUES (?, ?, 'memory', ?, ?, NULL, 0.5, '{}', ?)`,
    [brain.brainId, id, text, JSON.stringify(properties), Date.now()],
  );
}

/** A relation from a node to an entity of the graph, as a host links an episodic memory (`Memory.addRelation`). */
async function relate(graph: SqlKnowledgeGraph, sourceId: string, targetId: string): Promise<void> {
  await graph.upsertRelation({
    sourceId,
    targetId,
    type: 'related_to',
    label: 'mentions',
    weight: 1,
    bidirectional: false,
    confidence: 1,
    source: SOURCE,
  });
}

/** A copy as `MemoryStore.store` records it. */
function copyOf(traceId: string, scopeId: string, text: string): Omit<EpisodicMemory, 'id' | 'createdAt' | 'accessCount' | 'lastAccessedAt'> {
  return {
    type: 'conversation',
    summary: text,
    description: text,
    participants: [scopeId],
    importance: 0.5,
    entityIds: [],
    occurredAt: new Date().toISOString(),
    outcome: 'unknown',
    context: { memoryTraceId: traceId, scope: 'user', scopeId, type: 'episodic' },
  };
}

async function textsOf(graph: IKnowledgeGraph): Promise<Array<string | undefined>> {
  const memories = await graph.queryMemories({ limit: 100 });
  return memories.map((memory) => memory.description).sort();
}

describe.each([
  ['the in-memory graph', async () => new KnowledgeGraph() as IKnowledgeGraph],
  ['SqlKnowledgeGraph', async () => new SqlKnowledgeGraph(await openBrain()) as IKnowledgeGraph],
])('a trace copy in %s', (_name, graphOf) => {
  it('is keyed by its trace, so recording the trace again replaces it', async () => {
    const graph = await graphOf();
    await graph.initialize();
    const first = await graph.recordMemory(copyOf('mt_1', 'ana', 'Ana keeps bees.'));
    const again = await graph.recordMemory(copyOf('mt_1', 'ana', 'Ana keeps bees on the roof.'));
    const other = await graph.recordMemory({ ...copyOf('mt_2', 'ana', 'A note with no trace.'), context: undefined });

    expect(first.id).toBe('trace:mt_1');
    expect(again.id).toBe('trace:mt_1');
    expect(other.id).not.toMatch(/^trace:/);
    expect(await textsOf(graph)).toEqual(['A note with no trace.', 'Ana keeps bees on the roof.']);
  });

  it('is deleted by its trace id, and a scope delete takes the copies filed under the scope', async () => {
    const graph = await graphOf();
    await graph.initialize();
    await graph.recordMemory(copyOf('mt_1', 'ana', 'Ana keeps bees.'));
    await graph.recordMemory(copyOf('mt_2', 'ana', 'Ana is allergic to walnuts.'));
    await graph.recordMemory(copyOf('mt_3', 'bo', 'Bo plays the cello.'));

    expect(await graph.deleteMemories!({ traceIds: ['mt_1', 'mt_1', 'mt_unknown'] })).toBe(1);
    expect(await textsOf(graph)).toEqual(['Ana is allergic to walnuts.', 'Bo plays the cello.']);
    expect(await graph.deleteMemories!({ scopes: [{ scope: 'user', scopeId: 'ana' }] })).toBe(1);
    expect(await textsOf(graph)).toEqual(['Bo plays the cello.']);
  });

  it('takes the relations that name it with it, by trace id and by scope', async () => {
    const graph = await graphOf();
    await graph.initialize();
    const entity = (label: string) =>
      graph.upsertEntity({ type: 'concept', label, properties: {}, confidence: 1, source: SOURCE });
    const relation = (sourceId: string, targetId: string) =>
      graph.upsertRelation({
        sourceId,
        targetId,
        type: 'related_to',
        label: 'mentions',
        weight: 1,
        bidirectional: false,
        confidence: 1,
        source: SOURCE,
      });
    const bees = await entity('bees');
    const honey = await entity('honey');
    // A host relates an episodic memory to what it mentions (`upsertRelation` takes any node id).
    await relation((await graph.recordMemory(copyOf('mt_1', 'ana', 'Ana keeps bees.'))).id, bees.id);
    await relation(bees.id, (await graph.recordMemory(copyOf('mt_2', 'ana', 'Ana sells honey.'))).id);
    await relation(honey.id, bees.id);

    expect(await graph.deleteMemories!({ traceIds: ['mt_1'] })).toBe(1);
    expect(await graph.deleteMemories!({ scopes: [{ scope: 'user', scopeId: 'ana' }] })).toBe(1);

    const left = await graph.getRelations(bees.id);
    expect(left.map((kept) => [kept.sourceId, kept.targetId])).toEqual([[honey.id, bees.id]]);
    expect(await graph.getEntity(bees.id)).toBeDefined();
  });
});

describe('SqlKnowledgeGraph.deleteMemories by trace id', () => {
  it('reads no memory node once its first delete has looked for older copies', async () => {
    const brain = await openBrain();
    const graph = new SqlKnowledgeGraph(brain);
    await graph.recordMemory(copyOf('mt_1', 'ana', 'Ana keeps bees.'));
    await graph.recordMemory(copyOf('mt_2', 'ana', 'Ana is allergic to walnuts.'));
    await graph.recordMemory(copyOf('mt_3', 'bo', 'Bo plays the cello.'));
    expect(await graph.deleteMemories({ traceIds: ['mt_1'] })).toBe(1);

    const reads: string[] = [];
    const all = brain.all.bind(brain);
    vi.spyOn(brain, 'all').mockImplementation(((sql: string, params?: unknown[]) => {
      reads.push(sql);
      return all(sql, params as never);
    }) as never);
    const get = brain.get.bind(brain);
    vi.spyOn(brain, 'get').mockImplementation(((sql: string, params?: unknown[]) => {
      reads.push(sql);
      return get(sql, params as never);
    }) as never);

    expect(await graph.deleteMemories({ traceIds: ['mt_2', 'mt_unknown'] })).toBe(1);
    expect(reads).toEqual([]);
    vi.restoreAllMocks();
    expect((await graph.queryMemories({ limit: 10 })).map((memory) => memory.description)).toEqual(['Bo plays the cello.']);
  });

  it('re-keys the copies an older release recorded under a random node id, and deletes a second copy of one trace', async () => {
    const brain = await openBrain();
    const graph = new SqlKnowledgeGraph(brain);
    // As an older release recorded them: a random node id, the trace named only in the stored context.
    const older: Array<[string, string, string]> = [
      ['5d2c0f4e-1111-4a6b-9c1d-000000000001', 'mt_old1', 'Ana keeps bees.'],
      ['9a1b7c3d-2222-4a6b-9c1d-000000000002', 'mt_old2', 'Bo plays the cello.'],
      ['77aa5e6f-3333-4a6b-9c1d-000000000003', 'mt_old2', 'Bo plays the viola.'],
    ];
    for (const [id, traceId, text] of older) {
      const properties = {
        _props: {},
        _memoryType: 'conversation',
        _summary: text,
        _description: text,
        _participants: ['ana'],
        _context: { memoryTraceId: traceId, scope: 'user', scopeId: 'ana', type: 'episodic' },
      };
      await brain.run(
        `INSERT INTO knowledge_nodes (brain_id, id, type, label, properties, embedding, confidence, source, created_at)
         VALUES (?, ?, 'memory', ?, ?, NULL, 0.5, '{}', ?)`,
        [brain.brainId, id, text, JSON.stringify(properties), Date.now()],
      );
    }
    await graph.recordMemory(copyOf('mt_new', 'ana', 'Ana lives in Lyon.'));

    expect(await graph.deleteMemories({ traceIds: ['mt_old1'] })).toBe(1);

    const rows = await brain.all<{ id: string }>(`SELECT id FROM knowledge_nodes WHERE type = 'memory' ORDER BY id`);
    expect(rows.map((row) => row.id)).toEqual(['trace:mt_new', 'trace:mt_old2']);
    expect(await graph.deleteMemories({ traceIds: ['mt_old2'] })).toBe(1);
    expect((await graph.queryMemories({ limit: 10 })).map((memory) => memory.description)).toEqual(['Ana lives in Lyon.']);
  });
});

const sqlBrains: Array<[string, () => Promise<Brain>]> = [['SQLite', openBrain]];
if (POSTGRES_URL) sqlBrains.push(['Postgres', openPostgresBrain]);

describe.each(sqlBrains)('SqlKnowledgeGraph over %s', (_name, open) => {
  it('finds by scope the copies filed under a scope id that holds a quote or a backslash', async () => {
    const graph = new SqlKnowledgeGraph(await open());
    await graph.recordMemory(copyOf('mt_1', 'CORP\\ana', 'Ana keeps bees.'));
    await graph.recordMemory(copyOf('mt_2', 'o"neil', 'Ann keeps goats.'));
    await graph.recordMemory(copyOf('mt_3', 'CORPana', 'Another Ana keeps hens.'));

    expect(await graph.deleteMemories({ scopes: [{ scope: 'user', scopeId: 'CORP\\ana' }] })).toBe(1);
    expect(await graph.deleteMemories({ scopes: [{ scope: 'user', scopeId: 'o"neil' }] })).toBe(1);
    expect(await textsOf(graph)).toEqual(['Another Ana keeps hens.']);
  });

  it('deletes a copy a relation names, and the relation, by trace id and by scope', async () => {
    const brain = await open();
    const graph = new SqlKnowledgeGraph(brain);
    const bees = await graph.upsertEntity({ type: 'concept', label: 'bees', properties: {}, confidence: 1, source: SOURCE });
    await graph.recordMemory(copyOf('mt_1', 'ana', 'Ana keeps bees.'));
    await graph.recordMemory(copyOf('mt_2', 'ana', 'Ana sells honey.'));
    await relate(graph, 'trace:mt_1', bees.id);
    await relate(graph, 'trace:mt_2', bees.id);

    expect(await graph.deleteMemories({ traceIds: ['mt_1'] })).toBe(1);
    expect(await graph.deleteMemories({ scopes: [{ scope: 'user', scopeId: 'ana' }] })).toBe(1);

    expect(await textsOf(graph)).toEqual([]);
    expect(await brain.all('SELECT id FROM knowledge_edges WHERE brain_id = ?', [brain.brainId])).toEqual([]);
    expect(await graph.getEntity(bees.id)).toBeDefined();
  });

  it("moves a copy an older release recorded to its trace's key with the relation that names it", async () => {
    const brain = await open();
    const graph = new SqlKnowledgeGraph(brain);
    const bees = await graph.upsertEntity({ type: 'concept', label: 'bees', properties: {}, confidence: 1, source: SOURCE });
    await insertOlderCopy(brain, '5d2c0f4e-1111-4a6b-9c1d-000000000001', 'mt_old1', 'ana', 'Ana keeps bees.');
    await insertOlderCopy(brain, '9a1b7c3d-2222-4a6b-9c1d-000000000002', 'mt_old2', 'ana', 'Ana sells honey.');
    await relate(graph, '5d2c0f4e-1111-4a6b-9c1d-000000000001', bees.id);
    await relate(graph, '9a1b7c3d-2222-4a6b-9c1d-000000000002', bees.id);

    expect(await graph.deleteMemories({ traceIds: ['mt_old1'] })).toBe(1);

    const edges = await brain.all<{ source_id: string; target_id: string }>(
      'SELECT source_id, target_id FROM knowledge_edges WHERE brain_id = ?',
      [brain.brainId],
    );
    expect(edges).toEqual([{ source_id: 'trace:mt_old2', target_id: bees.id }]);
    expect((await graph.queryMemories({ limit: 10 })).map((memory) => memory.id)).toEqual(['trace:mt_old2']);
  });

  it('keeps a copy an older release recorded when its move fails, and a later graph moves it', async () => {
    const brain = await open();
    await insertOlderCopy(brain, '5d2c0f4e-1111-4a6b-9c1d-000000000001', 'mt_old1', 'ana', 'Ana keeps bees.');
    const graph = new SqlKnowledgeGraph(brain);
    // The first statement that writes a memory node fails, as one does while another connection holds the lock.
    const run = brain.run.bind(brain);
    let failed = false;
    vi.spyOn(brain, 'run').mockImplementation(((sql: string, params?: unknown[]) => {
      if (!failed && /^\s*(INSERT INTO|UPDATE) knowledge_nodes\b/.test(sql)) {
        failed = true;
        return Promise.reject(new Error('database is locked'));
      }
      return run(sql, params as never);
    }) as never);

    expect(await graph.deleteMemories({ traceIds: ['mt_unrelated'] })).toBe(0);
    vi.restoreAllMocks();

    expect(failed).toBe(true);
    expect(await textsOf(graph)).toEqual(['Ana keeps bees.']);
    expect(await new SqlKnowledgeGraph(brain).deleteMemories({ traceIds: ['mt_old1'] })).toBe(1);
    expect(await textsOf(graph)).toEqual([]);
  });

  it('deletes by its trace id a copy an older release recorded whose move to its key failed, with its relation', async () => {
    const brain = await open();
    const graph = new SqlKnowledgeGraph(brain);
    const bees = await graph.upsertEntity({ type: 'concept', label: 'bees', properties: {}, confidence: 1, source: SOURCE });
    await insertOlderCopy(brain, '5d2c0f4e-1111-4a6b-9c1d-000000000001', 'mt_old1', 'ana', 'Ana keeps bees.');
    await relate(graph, '5d2c0f4e-1111-4a6b-9c1d-000000000001', bees.id);
    // The move's write fails, as one does while another connection holds the lock, in the delete of that same trace.
    const run = brain.run.bind(brain);
    let failed = false;
    vi.spyOn(brain, 'run').mockImplementation(((sql: string, params?: unknown[]) => {
      if (!failed && /^\s*INSERT INTO knowledge_nodes\b/.test(sql)) {
        failed = true;
        return Promise.reject(new Error('database is locked'));
      }
      return run(sql, params as never);
    }) as never);

    expect(await graph.deleteMemories({ traceIds: ['mt_old1'] })).toBe(1);
    vi.restoreAllMocks();

    expect(failed).toBe(true);
    expect(await textsOf(graph)).toEqual([]);
    expect(await brain.all('SELECT id FROM knowledge_edges WHERE brain_id = ?', [brain.brainId])).toEqual([]);
    expect(await graph.getEntity(bees.id)).toBeDefined();
  });
});
