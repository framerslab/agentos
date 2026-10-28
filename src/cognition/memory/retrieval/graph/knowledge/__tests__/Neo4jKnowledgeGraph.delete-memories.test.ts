/**
 * @file Neo4jKnowledgeGraph.delete-memories.test.ts
 * `deleteMemories` on Neo4j: the records whose stored context names a deleted trace, or the deleted scope, are
 * detached and deleted, and no other. CI runs no Neo4j server, so the graph runs over a recording session that
 * answers the read with stored records (an integration run needs a live database, which CI does not have).
 */
import { describe, expect, it } from 'vitest';
import { Neo4jKnowledgeGraph } from '../Neo4jKnowledgeGraph.js';

function recordingConnection(stored: Array<{ id: string; context: string | null }>) {
  const writes: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const tx = (mode: 'READ' | 'WRITE') => ({
    run: async (cypher: string, params: Record<string, unknown> = {}) => {
      if (mode === 'WRITE') writes.push({ cypher, params });
      const records = mode === 'READ' && cypher.includes('RETURN m.memoryId AS id')
        ? stored.map((row) => ({ toObject: () => row }))
        : [];
      return { records };
    },
  });
  const connectionManager = {
    session: (_mode: 'READ' | 'WRITE') => ({
      executeRead: (fn: (t: unknown) => unknown) => fn(tx('READ')),
      executeWrite: (fn: (t: unknown) => unknown) => fn(tx('WRITE')),
      close: async () => undefined,
    }),
  };
  return { connectionManager, writes };
}

describe('Neo4jKnowledgeGraph.deleteMemories', () => {
  it('deletes the records that copy the named traces or scopes', async () => {
    const { connectionManager, writes } = recordingConnection([
      { id: 'm1', context: JSON.stringify({ memoryTraceId: 't-1', scope: 'user', scopeId: 'ana' }) },
      { id: 'm2', context: JSON.stringify({ memoryTraceId: 't-2', scope: 'user', scopeId: 'ana' }) },
      { id: 'm3', context: JSON.stringify({ memoryTraceId: 't-3', scope: 'organization', scopeId: 'ana' }) },
      { id: 'm4', context: JSON.stringify({ memoryTraceId: 't-4', scope: 'user', scopeId: 'bo' }) },
      { id: 'm5', context: '{not json' },
    ]);
    const graph = new Neo4jKnowledgeGraph({ connectionManager: connectionManager as never });
    await graph.initialize();
    writes.length = 0;

    const deleted = await graph.deleteMemories({ traceIds: ['t-4'], scopes: [{ scope: 'user', scopeId: 'ana' }] });

    expect(deleted).toBe(3);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.cypher).toContain('DETACH DELETE m');
    expect([...(writes[0]!.params.ids as string[])].sort()).toEqual(['m1', 'm2', 'm4']);
  });

  it('runs nothing for an empty filter', async () => {
    const { connectionManager, writes } = recordingConnection([]);
    const graph = new Neo4jKnowledgeGraph({ connectionManager: connectionManager as never });
    await graph.initialize();
    writes.length = 0;
    expect(await graph.deleteMemories({})).toBe(0);
    expect(writes).toEqual([]);
  });
});
