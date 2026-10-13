/**
 * @file checkpoint-store.test.ts
 * @description Unit tests for ICheckpointStore / InMemoryCheckpointStore.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Checkpoint } from '../checkpoint/ICheckpointStore.js';
import { InMemoryCheckpointStore } from '../checkpoint/InMemoryCheckpointStore.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InMemoryCheckpointStore', () => {
  let store: InMemoryCheckpointStore;

  beforeEach(() => {
    store = new InMemoryCheckpointStore();
  });

  // -------------------------------------------------------------------------
  it('save and load by runId returns the saved checkpoint', async () => {
    const cp = makeCheckpoint({ id: 'cp-1', runId: 'run-1' });
    await store.save(cp);

    const loaded = await store.load('run-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('cp-1');
    expect(loaded!.runId).toBe('run-1');
  });

  // -------------------------------------------------------------------------
  it('get returns a checkpoint by exact checkpoint id', async () => {
    const cp = makeCheckpoint({ id: 'cp-direct', runId: 'run-1' });
    await store.save(cp);

    const loaded = await store.get('cp-direct');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('cp-direct');
  });

  // -------------------------------------------------------------------------
  it('load returns null for an unknown runId', async () => {
    const result = await store.load('run-missing');
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  it('load with nodeId filter returns checkpoint matching that node', async () => {
    const cpA = makeCheckpoint({ id: 'cp-a', runId: 'run-1', nodeId: 'node-a', timestamp: 1000 });
    const cpB = makeCheckpoint({ id: 'cp-b', runId: 'run-1', nodeId: 'node-b', timestamp: 2000 });
    await store.save(cpA);
    await store.save(cpB);

    const loaded = await store.load('run-1', 'node-a');
    expect(loaded!.id).toBe('cp-a');
  });

  // -------------------------------------------------------------------------
  it('latest returns the most recently timestamped checkpoint for a run', async () => {
    const older = makeCheckpoint({ id: 'cp-old', runId: 'run-1', timestamp: 1000 });
    const newer = makeCheckpoint({ id: 'cp-new', runId: 'run-1', timestamp: 9000 });
    // Save older first, then newer — order of insertion should not matter.
    await store.save(older);
    await store.save(newer);

    const result = await store.latest('run-1');
    expect(result!.id).toBe('cp-new');
  });

  // -------------------------------------------------------------------------
  it('latest, load and list put the checkpoint saved last first when timestamps are equal', async () => {
    // The runtime can save several checkpoints of a run in one millisecond.
    for (const id of ['cp-first', 'cp-second', 'cp-third']) {
      await store.save(makeCheckpoint({ id, runId: 'run-1', timestamp: 5000 }));
    }

    expect((await store.latest('run-1'))!.id).toBe('cp-third');
    expect((await store.load('run-1', 'node-a'))!.id).toBe('cp-third');
    expect((await store.list('graph-1')).map((meta) => meta.id)).toEqual(['cp-third', 'cp-second', 'cp-first']);
  });

  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  it('list with limit caps the number of results (most-recent first)', async () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await store.save(
        makeCheckpoint({ id: `cp-${i}`, graphId: 'graph-1', runId: 'run-1', timestamp: base + i }),
      );
    }

    const metas = await store.list('graph-1', { limit: 3 });
    expect(metas).toHaveLength(3);
    // Most recent first — timestamps base+4, base+3, base+2.
    expect(metas[0]!.id).toBe('cp-4');
    expect(metas[1]!.id).toBe('cp-3');
    expect(metas[2]!.id).toBe('cp-2');
  });

  // -------------------------------------------------------------------------
  it('list with runId filter returns only checkpoints for that run', async () => {
    await store.save(makeCheckpoint({ id: 'cp-1', graphId: 'graph-1', runId: 'run-A' }));
    await store.save(makeCheckpoint({ id: 'cp-2', graphId: 'graph-1', runId: 'run-B' }));

    const metas = await store.list('graph-1', { runId: 'run-A' });
    expect(metas).toHaveLength(1);
    expect(metas[0]!.id).toBe('cp-1');
  });

  // -------------------------------------------------------------------------
  it('delete removes a checkpoint so subsequent load returns null', async () => {
    const cp = makeCheckpoint({ id: 'cp-del', runId: 'run-del' });
    await store.save(cp);

    await store.delete('cp-del');

    const loaded = await store.load('run-del');
    expect(loaded).toBeNull();
  });

  // -------------------------------------------------------------------------
  it('delete is a no-op for a non-existent checkpoint id', async () => {
    // Should not throw.
    await expect(store.delete('does-not-exist')).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  it('fork creates a new runId and the forked checkpoint is queryable', async () => {
    const original = makeCheckpoint({ id: 'cp-src', runId: 'run-src', graphId: 'graph-1' });
    await store.save(original);

    const newRunId = await store.fork('cp-src');

    expect(newRunId).not.toBe('run-src');
    const forked = await store.latest(newRunId);
    expect(forked).not.toBeNull();
    expect(forked!.graphId).toBe('graph-1');
  });

  // -------------------------------------------------------------------------
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

    // Unpatched sibling fields are preserved by Object.assign merge.
    expect((forked!.state.input as Record<string, unknown>)['lang']).toBe('en');
    expect((forked!.state.scratch as Record<string, unknown>)['count']).toBe(5);

    // Artifacts unmodified.
    expect((forked!.state.artifacts as Record<string, unknown>)['result']).toBe('old');

    // Original checkpoint is unchanged.
    const src = await store.load('run-patch');
    expect((src!.state.input as Record<string, unknown>)['prompt']).toBe('hello');
  });

  // -------------------------------------------------------------------------
  it('fork throws when the source checkpointId does not exist', async () => {
    await expect(store.fork('cp-nonexistent')).rejects.toThrow(/not found/);
  });
});
