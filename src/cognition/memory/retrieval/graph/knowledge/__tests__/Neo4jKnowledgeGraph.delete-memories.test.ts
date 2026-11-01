/**
 * @file Neo4jKnowledgeGraph.delete-memories.test.ts
 * A memory trace's episodic copy on Neo4j: the copy carries its trace id (`traceId`, indexed), recording the trace
 * again replaces it, and `deleteMemories` finds a trace's copies through that id and a scope's by their stored
 * context, then detaches and deletes them and no other. A copy an older release recorded with no `traceId` gets one,
 * once per graph, at the first delete by trace id; when that write fails, the delete still finds the trace's older
 * copy by its stored context. CI runs no Neo4j server, so the graph runs over a session that
 * records each statement and answers the three reads `deleteMemories` makes from stored nodes (an integration run
 * needs a live database, which CI does not have).
 */
import { describe, expect, it } from 'vitest';
import { Neo4jKnowledgeGraph } from '../Neo4jKnowledgeGraph.js';

interface StoredCopy {
  id: string;
  traceId?: string;
  context: string | null;
}

function recordingConnection(stored: StoredCopy[], options: { failingBackfills?: number } = {}) {
  let failingBackfills = options.failingBackfills ?? 0;
  const writes: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const reads: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const answer = (cypher: string, params: Record<string, unknown>) => {
    if (cypher.includes('m.traceId IN $traceIds')) {
      const traceIds = params.traceIds as string[];
      return stored.filter((copy) => copy.traceId !== undefined && traceIds.includes(copy.traceId)).map((copy) => ({ id: copy.id }));
    }
    if (cypher.includes('m.traceId IS NULL')) {
      return stored.filter((copy) => copy.traceId === undefined && copy.context !== null).map(({ id, context }) => ({ id, context }));
    }
    if (cypher.includes('CONTAINS needle')) {
      const needles = params.needles as string[];
      return stored
        .filter((copy) => copy.context !== null && needles.some((needle) => copy.context!.includes(needle)))
        .map(({ id, context }) => ({ id, context }));
    }
    return [];
  };
  const tx = (mode: 'READ' | 'WRITE') => ({
    run: async (cypher: string, params: Record<string, unknown> = {}) => {
      if (mode === 'WRITE') {
        if (params.copies !== undefined && failingBackfills > 0) {
          failingBackfills -= 1;
          throw new Error('Neo.TransientError.Transaction.LockClientStopped');
        }
        writes.push({ cypher, params });
        // The backfill's write: each listed copy gets its trace id.
        for (const copy of (params.copies as Array<{ id: string; traceId: string }> | undefined) ?? []) {
          const node = stored.find((candidate) => candidate.id === copy.id);
          if (node) node.traceId = copy.traceId;
        }
        return { records: [] };
      }
      reads.push({ cypher, params });
      return { records: answer(cypher, params).map((row) => ({ toObject: () => row })) };
    },
  });
  const connectionManager = {
    session: (_mode: 'READ' | 'WRITE') => ({
      executeRead: (fn: (t: unknown) => unknown) => fn(tx('READ')),
      executeWrite: (fn: (t: unknown) => unknown) => fn(tx('WRITE')),
      close: async () => undefined,
    }),
  };
  return { connectionManager, writes, reads };
}

const context = (traceId: string, scope: string, scopeId: string) => JSON.stringify({ memoryTraceId: traceId, scope, scopeId });

describe('Neo4jKnowledgeGraph.deleteMemories', () => {
  it('indexes the trace id of a copy', async () => {
    const { connectionManager, writes } = recordingConnection([]);
    const graph = new Neo4jKnowledgeGraph({ connectionManager: connectionManager as never });
    await graph.initialize();
    expect(writes.some((write) => write.cypher.includes('CREATE INDEX') && write.cypher.includes('(n.traceId)'))).toBe(true);
  });

  it('records the trace id on a copy and replaces the copy recorded for the trace before', async () => {
    const { connectionManager, writes } = recordingConnection([]);
    const graph = new Neo4jKnowledgeGraph({ connectionManager: connectionManager as never });
    await graph.initialize();
    writes.length = 0;

    await graph.recordMemory({
      type: 'conversation',
      summary: 'Ana keeps bees.',
      participants: ['ana'],
      importance: 0.5,
      entityIds: [],
      occurredAt: new Date().toISOString(),
      context: { memoryTraceId: 't-1', scope: 'user', scopeId: 'ana', type: 'episodic' },
    });
    await graph.recordMemory({
      type: 'conversation',
      summary: 'A note with no trace.',
      participants: [],
      importance: 0.5,
      entityIds: [],
      occurredAt: new Date().toISOString(),
    });

    expect(writes).toHaveLength(3);
    expect(writes[0]!.cypher).toContain('DETACH DELETE');
    expect(writes[0]!.params).toEqual({ traceId: 't-1' });
    expect(writes[1]!.cypher).toContain('traceId: $traceId');
    expect(writes[1]!.params.traceId).toBe('t-1');
    expect(writes[2]!.cypher).toContain('CREATE');
    expect(writes[2]!.params.traceId).toBeNull();
  });

  it("deletes the named traces' copies through their trace id and a scope's through their context", async () => {
    const { connectionManager, writes } = recordingConnection([
      { id: 'm1', traceId: 't-1', context: context('t-1', 'user', 'ana') },
      { id: 'm2', context: context('t-2', 'user', 'ana') },
      { id: 'm3', traceId: 't-3', context: context('t-3', 'organization', 'ana') },
      { id: 'm4', traceId: 't-4', context: context('t-4', 'user', 'bo') },
      { id: 'm5', context: '{not json' },
      { id: 'm6', context: context('t-6', 'user', 'bo') },
    ]);
    const graph = new Neo4jKnowledgeGraph({ connectionManager: connectionManager as never });
    await graph.initialize();
    writes.length = 0;

    const deleted = await graph.deleteMemories({ traceIds: ['t-4', 't-6'], scopes: [{ scope: 'user', scopeId: 'ana' }] });

    expect(deleted).toBe(4);
    expect(writes).toHaveLength(2);
    expect(writes[0]!.cypher).toContain('SET m.traceId = copy.traceId');
    expect(writes[0]!.params.copies).toEqual([
      { id: 'm2', traceId: 't-2' },
      { id: 'm6', traceId: 't-6' },
    ]);
    expect(writes[1]!.cypher).toContain('DETACH DELETE m');
    expect([...(writes[1]!.params.ids as string[])].sort()).toEqual(['m1', 'm2', 'm4', 'm6']);
  });

  it('gives older copies their trace id once per graph', async () => {
    const { connectionManager, writes, reads } = recordingConnection([
      { id: 'm1', context: context('t-1', 'user', 'ana') },
      { id: 'm2', context: context('t-2', 'user', 'ana') },
    ]);
    const graph = new Neo4jKnowledgeGraph({ connectionManager: connectionManager as never });
    await graph.initialize();
    expect(await graph.deleteMemories({ traceIds: ['t-1'] })).toBe(1);
    writes.length = 0;
    reads.length = 0;

    expect(await graph.deleteMemories({ traceIds: ['t-2'] })).toBe(1);

    expect(reads.map((read) => read.cypher.includes('m.traceId IN $traceIds'))).toEqual([true]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.params.ids).toEqual(['m2']);
  });

  it("deletes a trace's older copy through its stored context when giving older copies their trace id fails", async () => {
    const { connectionManager, writes } = recordingConnection(
      [
        { id: 'm1', context: context('t-1', 'user', 'ana') },
        { id: 'm2', context: context('t-2', 'user', 'ana') },
      ],
      { failingBackfills: 1 },
    );
    const graph = new Neo4jKnowledgeGraph({ connectionManager: connectionManager as never });
    await graph.initialize();
    writes.length = 0;

    expect(await graph.deleteMemories({ traceIds: ['t-1'] })).toBe(1);

    expect(writes).toHaveLength(1);
    expect(writes[0]!.cypher).toContain('DETACH DELETE m');
    expect(writes[0]!.params.ids).toEqual(['m1']);
    // The next delete by trace id gives the older copies left their trace id.
    expect(await graph.deleteMemories({ traceIds: ['t-2'] })).toBe(1);
    expect(writes.at(-1)!.params.ids).toEqual(['m2']);
  });

  it('runs nothing for an empty filter', async () => {
    const { connectionManager, writes, reads } = recordingConnection([]);
    const graph = new Neo4jKnowledgeGraph({ connectionManager: connectionManager as never });
    await graph.initialize();
    writes.length = 0;
    expect(await graph.deleteMemories({})).toBe(0);
    expect(writes).toEqual([]);
    expect(reads).toEqual([]);
  });
});
