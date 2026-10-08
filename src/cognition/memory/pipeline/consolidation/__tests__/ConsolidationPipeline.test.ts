import { describe, expect, it, vi } from 'vitest';

import { ConsolidationPipeline } from '../ConsolidationPipeline.js';

describe('ConsolidationPipeline', () => {
  it('uses unique schema IDs across overlapping cycles in the same millisecond', async () => {
    const storedIds: string[] = [];
    const store = {
      getTrace: vi.fn(() => ({ content: 'a durable memory' })),
      store: vi.fn(async (trace: { id: string }) => {
        storedIds.push(trace.id);
      }),
    };
    const graph = {
      detectClusters: vi.fn(async () => [{
        clusterId: 'cluster',
        memberIds: ['trace'],
        density: 1,
      }]),
      addNode: vi.fn(async () => undefined),
      hasNode: vi.fn(() => false),
      addEdge: vi.fn(async () => undefined),
    };
    const pipeline = new ConsolidationPipeline({
      store: store as never,
      graph: graph as never,
      traits: {} as never,
      agentId: 'agent',
      consolidation: { minClusterSize: 1 },
      llmInvoker: vi.fn(async () => 'a stable semantic schema'),
    });
    const integrate = (
      pipeline as unknown as { schemaIntegration(): Promise<number> }
    ).schemaIntegration.bind(pipeline);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    try {
      await Promise.all([integrate(), integrate()]);
    } finally {
      nowSpy.mockRestore();
    }

    expect(storedIds).toHaveLength(2);
    expect(new Set(storedIds).size).toBe(2);
    expect(storedIds.every((id) => id.startsWith('schema_1700000000000_0_'))).toBe(true);
  });
});
