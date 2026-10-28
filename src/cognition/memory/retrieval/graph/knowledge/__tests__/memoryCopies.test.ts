/**
 * @file memoryCopies.test.ts
 * A memory trace's episodic copy in the in-memory graph and in `SqlKnowledgeGraph`: the copy is keyed by its trace,
 * so recording the trace again replaces it and a delete by trace id finds it by key. In SQL the delete reads no
 * memory node once the graph has re-keyed, at its first delete by trace id, the copies an older release recorded
 * under a random node id. A real SQLite Brain.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../../../store/Brain.js';
import { SqlKnowledgeGraph } from '../../../store/SqlKnowledgeGraph.js';
import { KnowledgeGraph } from '../KnowledgeGraph.js';
import type { EpisodicMemory, IKnowledgeGraph } from '../IKnowledgeGraph.js';

const dirs: string[] = [];
const brains: Brain[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
