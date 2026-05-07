/**
 * @file graph-runtime.test.ts
 * @description Integration tests for `GraphRuntime`.
 *
 * Covers:
 * 1. Linear graph end-to-end — START→a→b→END with mock executor returns defined output.
 * 2. Streaming events — correct event types emitted in causal order.
 * 3. Checkpoints saved — graph with `checkpointPolicy='every_node'` creates checkpoint entries.
 * 4. Conditional edges — routing to 'b' or 'c' based on `state.scratch.goToB`.
 * 5. Resume from checkpoint — fork a checkpoint with patched state, resume, verify completion.
 */

import { describe, it, expect, vi } from 'vitest';
import { GraphRuntime } from '../runtime/GraphRuntime.js';
import { NodeExecutor } from '../runtime/NodeExecutor.js';
import { InMemoryCheckpointStore } from '../checkpoint/InMemoryCheckpointStore.js';
import type { CompiledExecutionGraph, GraphNode, GraphState } from '../ir/types.js';
import { START, END } from '../ir/types.js';
import type { NodeExecutionResult } from '../runtime/NodeExecutor.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal `GraphNode` with sensible defaults.
 *
 * @param id          - Unique node identifier.
 * @param overrides   - Optional field overrides.
 */
function makeNode(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type: 'gmi',
    executorConfig: { type: 'gmi', instructions: `node-${id}` },
    executionMode: 'single_turn',
    effectClass: 'pure',
    checkpoint: 'none',
    ...overrides,
  };
}

/**
 * Build a `CompiledExecutionGraph` with START→[nodeIds in order]→END edges.
 *
 * The helper adds static edges START→first, last→END, and consecutive node→node edges.
 *
 * @param id      - Graph identifier.
 * @param nodes   - Array of nodes to include (order determines static edge chain).
 * @param options - Optional overrides for the graph-level fields.
 */
function makeLinearGraph(
  id: string,
  nodes: GraphNode[],
  options: Partial<CompiledExecutionGraph> = {},
): CompiledExecutionGraph {
  const edges = nodes.map((n, i) => ({
    id: `e${i}`,
    source: i === 0 ? START : nodes[i - 1]!.id,
    target: n.id,
    type: 'static' as const,
  }));
  edges.push({
    id: `e${nodes.length}`,
    source: nodes[nodes.length - 1]!.id,
    target: END,
    type: 'static' as const,
  });

  return {
    id,
    name: id,
    nodes,
    edges,
    stateSchema: { input: {}, scratch: {}, artifacts: {} },
    reducers: {},
    checkpointPolicy: 'explicit',
    memoryConsistency: 'live',
    ...options,
  };
}

function makeParallelJoinGraph(
  id: string,
  left: GraphNode,
  right: GraphNode,
  join: GraphNode,
  options: Partial<CompiledExecutionGraph> = {},
): CompiledExecutionGraph {
  return {
    id,
    name: id,
    nodes: [left, right, join],
    edges: [
      { id: 'start-left', source: START, target: left.id, type: 'static' as const },
      { id: 'start-right', source: START, target: right.id, type: 'static' as const },
      { id: 'left-join', source: left.id, target: join.id, type: 'static' as const },
      { id: 'right-join', source: right.id, target: join.id, type: 'static' as const },
      { id: 'join-end', source: join.id, target: END, type: 'static' as const },
    ],
    stateSchema: { input: {}, scratch: {}, artifacts: {} },
    reducers: {},
    checkpointPolicy: 'explicit',
    memoryConsistency: 'live',
    ...options,
  };
}

function makeWideParallelJoinGraph(
  id: string,
  branches: GraphNode[],
  join: GraphNode,
  options: Partial<CompiledExecutionGraph> = {},
): CompiledExecutionGraph {
  return {
    id,
    name: id,
    nodes: [...branches, join],
    edges: [
      ...branches.map((branch) => ({
        id: `start-${branch.id}`,
        source: START,
        target: branch.id,
        type: 'static' as const,
      })),
      ...branches.map((branch) => ({
        id: `${branch.id}-join`,
        source: branch.id,
        target: join.id,
        type: 'static' as const,
      })),
      { id: 'join-end', source: join.id, target: END, type: 'static' as const },
    ],
    stateSchema: { input: {}, scratch: {}, artifacts: {} },
    reducers: {},
    checkpointPolicy: 'explicit',
    memoryConsistency: 'live',
    ...options,
  };
}

/**
 * Create a `NodeExecutor` whose `execute()` is fully controlled by the supplied mock.
 *
 * @param mockFn - `vi.fn()` (or similar) that replaces `execute()`.
 */
function makeExecutorWithMock(
  mockFn: (node: GraphNode, state: Partial<GraphState>) => Promise<NodeExecutionResult>,
): NodeExecutor {
  const executor = new NodeExecutor({});
  // Replace the public method directly so we don't need to subclass.
  executor.execute = mockFn as typeof executor.execute;
  return executor;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GraphRuntime', () => {
  // ── 1. Linear graph end-to-end ─────────────────────────────────────────────

  it('executes a linear START→a→b→END graph and returns defined output', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockResolvedValue({
      success: true,
      output: 'ok',
      artifactsUpdate: { result: 'final' },
    } satisfies NodeExecutionResult);

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const graph = makeLinearGraph('g-linear', [makeNode('a'), makeNode('b')]);
    const result = await runtime.invoke(graph, { query: 'hello' });

    // Both nodes were executed.
    expect(executeMock).toHaveBeenCalledTimes(2);
    // Final output should be defined (artifacts object).
    expect(result).toBeDefined();
  });

  // ── 2. Streaming events in correct order ───────────────────────────────────

  it('streams events in correct causal order for a linear graph', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockResolvedValue({
      success: true,
      output: 'step-output',
    } satisfies NodeExecutionResult);

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const graph = makeLinearGraph('g-events', [makeNode('a'), makeNode('b')]);
    const events: string[] = [];

    for await (const event of runtime.stream(graph, {})) {
      events.push(event.type);
    }

    // Verify run_start appears first and run_end appears last.
    expect(events[0]).toBe('run_start');
    expect(events[events.length - 1]).toBe('run_end');

    // node_start and node_end must each appear twice (once per node).
    expect(events.filter(t => t === 'node_start')).toHaveLength(2);
    expect(events.filter(t => t === 'node_end')).toHaveLength(2);

    // Every node_start must be immediately followed by node_end (linear graph, no checkpoints).
    for (let i = 0; i < events.length; i++) {
      if (events[i] === 'node_start') {
        expect(events[i + 1]).toBe('node_end');
      }
    }
  });

  it('emits node-supplied execution events before node_end', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockResolvedValue({
      success: true,
      output: 'step-output',
      events: [
        { type: 'text_delta', nodeId: 'a', content: 'thinking...' },
        { type: 'tool_call', nodeId: 'a', toolName: 'web_search', args: { q: 'agent graphs' } },
        { type: 'tool_result', nodeId: 'a', toolName: 'web_search', result: { success: true } },
      ],
    } satisfies NodeExecutionResult);

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const graph = makeLinearGraph('g-node-events', [makeNode('a')]);
    const events = [];

    for await (const event of runtime.stream(graph, {})) {
      events.push(event.type);
    }

    expect(events).toEqual([
      'run_start',
      'node_start',
      'text_delta',
      'tool_call',
      'tool_result',
      'node_end',
      'run_end',
    ]);
  });

  // ── 3. Checkpoints saved ───────────────────────────────────────────────────

  it('saves checkpoints after every node when checkpointPolicy is every_node', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockResolvedValue({
      success: true,
      output: 'cp-output',
    } satisfies NodeExecutionResult);

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const graph = makeLinearGraph(
      'g-checkpoint',
      [makeNode('a'), makeNode('b')],
      { checkpointPolicy: 'every_node' },
    );

    await runtime.invoke(graph, {});

    // There should be at least one checkpoint per node (a + b = 2).
    const checkpoints = await store.list('g-checkpoint');
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
  });

  // ── 4. Conditional edges ───────────────────────────────────────────────────

  it('routes to node b when condition fn returns b based on scratch.goToB', async () => {
    const store = new InMemoryCheckpointStore();

    /**
     * Node 'a' sets `scratch.goToB = true`.
     * Nodes 'b' and 'c' are passive — they just return success.
     */
    const executeMock = vi.fn().mockImplementation(
      async (node: GraphNode): Promise<NodeExecutionResult> => {
        if (node.id === 'a') {
          return { success: true, output: 'a-done', scratchUpdate: { goToB: true } };
        }
        return { success: true, output: `${node.id}-done` };
      },
    );

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const nodeA = makeNode('a');
    const nodeB = makeNode('b');
    const nodeC = makeNode('c');

    /**
     * Graph topology:
     *   START ──static──► a ──conditional──► b (if goToB)
     *                       └──conditional──► c (if !goToB)
     *   b ──static──► END
     *   c ──static──► END
     */
    const graph: CompiledExecutionGraph = {
      id: 'g-conditional',
      name: 'conditional-test',
      nodes: [nodeA, nodeB, nodeC],
      edges: [
        { id: 'e0', source: START, target: 'a', type: 'static' },
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          type: 'conditional',
          condition: {
            type: 'function',
            fn: (state: GraphState) =>
              (state.scratch as Record<string, unknown>).goToB ? 'b' : 'c',
          },
        },
        {
          id: 'e2',
          source: 'a',
          target: 'c',
          type: 'conditional',
          condition: {
            type: 'function',
            fn: (state: GraphState) =>
              (state.scratch as Record<string, unknown>).goToB ? 'b' : 'c',
          },
        },
        { id: 'e3', source: 'b', target: END, type: 'static' },
        { id: 'e4', source: 'c', target: END, type: 'static' },
      ],
      stateSchema: { input: {}, scratch: {}, artifacts: {} },
      reducers: {},
      checkpointPolicy: 'explicit',
      memoryConsistency: 'live',
    };

    const visitedIds: string[] = [];
    for await (const event of runtime.stream(graph, {})) {
      if (event.type === 'node_start') visitedIds.push(event.nodeId);
    }

    // Node 'a' and 'b' should have run; 'c' should have been skipped.
    expect(visitedIds).toContain('a');
    expect(visitedIds).toContain('b');
    expect(visitedIds).not.toContain('c');
  });

  it('routes expression-based conditional edges using boolean evaluation', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockImplementation(
      async (node: GraphNode): Promise<NodeExecutionResult> => {
        if (node.id === 'a') {
          return { success: true, output: 'a-done', scratchUpdate: { score: 8 } };
        }
        return { success: true, output: `${node.id}-done` };
      },
    );

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const graph: CompiledExecutionGraph = {
      id: 'g-expression-conditional',
      name: 'expression-conditional-test',
      nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
      edges: [
        { id: 'e0', source: START, target: 'a', type: 'static' },
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          type: 'conditional',
          condition: { type: 'expression', expr: 'scratch.score > 5' },
        },
        {
          id: 'e2',
          source: 'a',
          target: 'c',
          type: 'conditional',
          condition: { type: 'expression', expr: 'scratch.score <= 5' },
        },
        { id: 'e3', source: 'b', target: END, type: 'static' },
        { id: 'e4', source: 'c', target: END, type: 'static' },
      ],
      stateSchema: { input: {}, scratch: {}, artifacts: {} },
      reducers: {},
      checkpointPolicy: 'explicit',
      memoryConsistency: 'live',
    };

    const visitedIds: string[] = [];
    for await (const event of runtime.stream(graph, {})) {
      if (event.type === 'node_start') visitedIds.push(event.nodeId);
    }

    expect(visitedIds).toContain('a');
    expect(visitedIds).toContain('b');
    expect(visitedIds).not.toContain('c');
  });

  // ── 5. Resume from checkpoint ──────────────────────────────────────────────

  it('resumes a run from a forked checkpoint and completes successfully', async () => {
    const store = new InMemoryCheckpointStore();

    /**
     * Node 'a' runs first, then 'b'. We'll interrupt after 'a', fork the checkpoint,
     * and resume — verifying 'b' executes on resume.
     */
    const executeMock = vi.fn().mockResolvedValue({
      success: true,
      output: 'resume-output',
    } satisfies NodeExecutionResult);

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const graph = makeLinearGraph(
      'g-resume',
      [makeNode('a'), makeNode('b')],
      { checkpointPolicy: 'every_node' },
    );

    // First: run to completion so checkpoints are created.
    await runtime.invoke(graph, { seed: 42 });

    // Find the checkpoint for node 'a'.
    const allCheckpoints = await store.list('g-resume');
    expect(allCheckpoints.length).toBeGreaterThan(0);

    const cpForA = allCheckpoints.find(cp => cp.nodeId === 'a');
    expect(cpForA).toBeDefined();

    // Fork the checkpoint — this simulates restarting from after node 'a'.
    const forkedRunId = await store.fork(cpForA!.id);

    // Reset mock call count to measure only the resumed execution.
    executeMock.mockClear();

    // Resume the forked run.
    const resumeResult = await runtime.resume(graph, forkedRunId);

    // The resume should complete without throwing.
    expect(resumeResult).toBeDefined();
  });

  it('accepts an exact checkpoint id in resume()', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockResolvedValue({
      success: true,
      output: 'resume-output',
    } satisfies NodeExecutionResult);

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const graph = makeLinearGraph(
      'g-resume-checkpoint-id',
      [makeNode('a'), makeNode('b')],
      { checkpointPolicy: 'every_node' },
    );

    await runtime.invoke(graph, { seed: 7 });
    const checkpoints = await store.list('g-resume-checkpoint-id');
    const checkpointForA = checkpoints.find((cp) => cp.nodeId === 'a');
    expect(checkpointForA).toBeDefined();

    executeMock.mockClear();
    const resumeResult = await runtime.resume(graph, checkpointForA!.id);

    expect(resumeResult).toBeDefined();
    expect(executeMock).toHaveBeenCalled();
  });

  it('streams resumed events from the checkpoint forward', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockImplementation(async (node: GraphNode): Promise<NodeExecutionResult> => ({
      success: true,
      output: `${node.id}-done`,
    }));

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const graph = makeLinearGraph(
      'g-stream-resume',
      [makeNode('a'), makeNode('b')],
      { checkpointPolicy: 'every_node' },
    );

    await runtime.invoke(graph, { seed: 9 });
    const checkpoints = await store.list('g-stream-resume');
    const checkpointForA = checkpoints.find((cp) => cp.nodeId === 'a');
    expect(checkpointForA).toBeDefined();

    executeMock.mockClear();
    const resumedNodeIds: string[] = [];
    for await (const event of runtime.streamResume(graph, checkpointForA!.id)) {
      if (event.type === 'node_start') {
        resumedNodeIds.push(event.nodeId);
      }
    }

    expect(resumedNodeIds).toEqual(['b']);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('halts on node failure and emits error/interruption events', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockImplementation(async (node: GraphNode): Promise<NodeExecutionResult> => {
      if (node.id === 'a') {
        return { success: false, error: 'boom' };
      }
      return { success: true, output: `${node.id}-done` };
    });

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const graph = makeLinearGraph('g-failure', [makeNode('a'), makeNode('b')]);
    const events = [];
    for await (const event of runtime.stream(graph, {})) {
      events.push(event);
    }

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'interrupt')).toBe(true);
    expect(events.some((event) => event.type === 'run_end')).toBe(true);
    expect(events.some((event) => event.type === 'node_start' && event.nodeId === 'b')).toBe(false);
  });

  it('persists skipped conditional branches so resume does not execute the bypassed arm', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockImplementation(async (node: GraphNode): Promise<NodeExecutionResult> => {
      if (node.id === 'a') {
        return { success: true, output: 'a-done', scratchUpdate: { goToB: true } };
      }
      return { success: true, output: `${node.id}-done` };
    });

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const nodeA = makeNode('a');
    const nodeB = makeNode('b');
    const nodeC = makeNode('c');

    const graph: CompiledExecutionGraph = {
      id: 'g-conditional-resume',
      name: 'conditional-resume-test',
      nodes: [nodeA, nodeB, nodeC],
      edges: [
        { id: 'e0', source: START, target: 'a', type: 'static' },
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          type: 'conditional',
          condition: {
            type: 'function',
            fn: (state: GraphState) =>
              (state.scratch as Record<string, unknown>).goToB ? 'b' : 'c',
          },
        },
        {
          id: 'e2',
          source: 'a',
          target: 'c',
          type: 'conditional',
          condition: {
            type: 'function',
            fn: (state: GraphState) =>
              (state.scratch as Record<string, unknown>).goToB ? 'b' : 'c',
          },
        },
        { id: 'e3', source: 'b', target: END, type: 'static' },
        { id: 'e4', source: 'c', target: END, type: 'static' },
      ],
      stateSchema: { input: {}, scratch: {}, artifacts: {} },
      reducers: {},
      checkpointPolicy: 'every_node',
      memoryConsistency: 'snapshot',
    };

    await runtime.invoke(graph, {});

    const checkpoints = await store.list('g-conditional-resume');
    const checkpointForA = checkpoints.find((cp) => cp.nodeId === 'a');
    expect(checkpointForA).toBeDefined();

    const forkedRunId = await store.fork(checkpointForA!.id);
    executeMock.mockClear();

    await runtime.resume(graph, forkedRunId);

    const executedNodeIds = executeMock.mock.calls.map(([node]) => (node as GraphNode).id);
    expect(executedNodeIds).toContain('b');
    expect(executedNodeIds).not.toContain('c');
  });

  // ── 9. Personality edge routes to 'below' when trait < threshold ──────────

  it('routes to below branch when personality trait is below threshold', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockResolvedValue({
      success: true,
      output: 'done',
    } satisfies NodeExecutionResult);

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
      personaTraits: { openness: 0.3 },
    });

    const nodeA = makeNode('a');
    const nodeB = makeNode('b');
    const nodeC = makeNode('c');

    const graph: CompiledExecutionGraph = {
      id: 'g-personality-below',
      name: 'personality-below-test',
      nodes: [nodeA, nodeB, nodeC],
      edges: [
        { id: 'e0', source: START, target: 'a', type: 'static' },
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          type: 'personality',
          personalityCondition: { trait: 'openness', threshold: 0.5, above: 'b', below: 'c' },
        },
        {
          id: 'e1b',
          source: 'a',
          target: 'c',
          type: 'personality',
          personalityCondition: { trait: 'openness', threshold: 0.5, above: 'b', below: 'c' },
        },
        { id: 'e2', source: 'b', target: END, type: 'static' },
        { id: 'e3', source: 'c', target: END, type: 'static' },
      ],
      stateSchema: { input: {}, scratch: {}, artifacts: {} },
      reducers: {},
      checkpointPolicy: 'explicit',
      memoryConsistency: 'live',
    };

    const visitedIds: string[] = [];
    for await (const event of runtime.stream(graph, {})) {
      if (event.type === 'node_start') visitedIds.push(event.nodeId);
    }

    expect(visitedIds).toContain('a');
    expect(visitedIds).toContain('c');
    expect(visitedIds).not.toContain('b');
  });

  // ── 10. Personality edge routes to 'above' when trait >= threshold ─────────

  it('routes to above branch when personality trait is at or above threshold', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockResolvedValue({
      success: true,
      output: 'done',
    } satisfies NodeExecutionResult);

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
      personaTraits: { openness: 0.7 },
    });

    const nodeA = makeNode('a');
    const nodeB = makeNode('b');
    const nodeC = makeNode('c');

    const graph: CompiledExecutionGraph = {
      id: 'g-personality-above',
      name: 'personality-above-test',
      nodes: [nodeA, nodeB, nodeC],
      edges: [
        { id: 'e0', source: START, target: 'a', type: 'static' },
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          type: 'personality',
          personalityCondition: { trait: 'openness', threshold: 0.5, above: 'b', below: 'c' },
        },
        {
          id: 'e1b',
          source: 'a',
          target: 'c',
          type: 'personality',
          personalityCondition: { trait: 'openness', threshold: 0.5, above: 'b', below: 'c' },
        },
        { id: 'e2', source: 'b', target: END, type: 'static' },
        { id: 'e3', source: 'c', target: END, type: 'static' },
      ],
      stateSchema: { input: {}, scratch: {}, artifacts: {} },
      reducers: {},
      checkpointPolicy: 'explicit',
      memoryConsistency: 'live',
    };

    const visitedIds: string[] = [];
    for await (const event of runtime.stream(graph, {})) {
      if (event.type === 'node_start') visitedIds.push(event.nodeId);
    }

    expect(visitedIds).toContain('a');
    expect(visitedIds).toContain('b');
    expect(visitedIds).not.toContain('c');
  });

  // ── 11. Discovery edge calls discoveryEngine.discover() ───────────────────

  it('calls discoveryEngine.discover() for discovery edges', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockResolvedValue({
      success: true,
      output: 'done',
    } satisfies NodeExecutionResult);

    const discoverMock = vi.fn().mockResolvedValue({
      results: [{ id: 'found-tool', name: 'found-tool' }],
    });

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
      discoveryEngine: { discover: discoverMock },
    });

    const nodeA = makeNode('a');
    const nodeB = makeNode('b');

    const graph: CompiledExecutionGraph = {
      id: 'g-discovery',
      name: 'discovery-test',
      nodes: [nodeA, nodeB],
      edges: [
        { id: 'e0', source: START, target: 'a', type: 'static' },
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          type: 'discovery',
          discoveryQuery: 'find a summarizer',
          discoveryFallback: 'b',
        },
        { id: 'e2', source: 'b', target: END, type: 'static' },
      ],
      stateSchema: { input: {}, scratch: {}, artifacts: {} },
      reducers: {},
      checkpointPolicy: 'explicit',
      memoryConsistency: 'live',
    };

    await runtime.invoke(graph, {});
    expect(discoverMock).toHaveBeenCalledWith('find a summarizer', { kind: undefined });
  });

  // ── 12. Retry policy retries on failure then succeeds ─────────────────────

  it('retries a failing node and succeeds on a subsequent attempt', async () => {
    const store = new InMemoryCheckpointStore();
    let callCount = 0;
    const executeMock = vi.fn().mockImplementation(async (node: GraphNode): Promise<NodeExecutionResult> => {
      if (node.id === 'a') {
        callCount++;
        if (callCount < 3) return { success: false, error: 'transient' };
        return { success: true, output: 'recovered' };
      }
      return { success: true, output: `${node.id}-done` };
    });

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const nodeA: GraphNode = {
      ...makeNode('a'),
      retryPolicy: { maxAttempts: 3, backoff: 'fixed', backoffMs: 1 },
    };

    const graph = makeLinearGraph('g-retry-success', [nodeA, makeNode('b')]);
    const events: string[] = [];
    for await (const event of runtime.stream(graph, {})) {
      events.push(event.type);
    }

    // Node 'a' should have been called 3 times (2 failures + 1 success).
    expect(callCount).toBe(3);
    // The run should complete successfully (no error event).
    expect(events).not.toContain('error');
    expect(events[events.length - 1]).toBe('run_end');
    // Node 'b' should have run.
    expect(executeMock.mock.calls.some(([n]: [GraphNode]) => n.id === 'b')).toBe(true);
  });

  // ── 13. Retry policy exhausts retries then fails ──────────────────────────

  it('exhausts retry attempts and then fails the run', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockImplementation(async (node: GraphNode): Promise<NodeExecutionResult> => {
      if (node.id === 'a') return { success: false, error: 'permanent' };
      return { success: true, output: `${node.id}-done` };
    });

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const nodeA: GraphNode = {
      ...makeNode('a'),
      retryPolicy: { maxAttempts: 2, backoff: 'fixed', backoffMs: 1 },
    };

    const graph = makeLinearGraph('g-retry-fail', [nodeA, makeNode('b')]);
    const events: string[] = [];
    for await (const event of runtime.stream(graph, {})) {
      events.push(event.type);
    }

    // Node 'a' should have been called 2 times total (initial + 1 retry).
    const aCalls = executeMock.mock.calls.filter(([n]: [GraphNode]) => n.id === 'a');
    expect(aCalls).toHaveLength(2);
    // Run should end with error.
    expect(events).toContain('error');
    // Node 'b' should NOT have run.
    expect(executeMock.mock.calls.some(([n]: [GraphNode]) => n.id === 'b')).toBe(false);
  });

  it('applies retry policy when resuming from a checkpoint', async () => {
    const store = new InMemoryCheckpointStore();
    let resumeMode = false;
    let resumedBCalls = 0;
    const executeMock = vi.fn().mockImplementation(async (node: GraphNode): Promise<NodeExecutionResult> => {
      if (!resumeMode) {
        return { success: true, output: `${node.id}-initial` };
      }
      if (node.id === 'b') {
        resumedBCalls++;
        if (resumedBCalls === 1) return { success: false, error: 'transient retryable' };
        return { success: true, output: 'b-recovered' };
      }
      return { success: true, output: `${node.id}-resume` };
    });

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const graph = makeLinearGraph(
      'g-resume-retry',
      [
        makeNode('a'),
        {
          ...makeNode('b'),
          retryPolicy: { maxAttempts: 2, backoff: 'fixed', backoffMs: 1, retryOn: ['retryable'] },
        },
      ],
      { checkpointPolicy: 'every_node' },
    );

    await runtime.invoke(graph, {});
    const checkpoints = await store.list('g-resume-retry');
    const checkpointForA = checkpoints.find((cp) => cp.nodeId === 'a');
    expect(checkpointForA).toBeDefined();

    const forkedRunId = await store.fork(checkpointForA!.id);
    executeMock.mockClear();
    resumeMode = true;

    const result = await runtime.resume(graph, forkedRunId);

    expect(result).toBeDefined();
    expect(resumedBCalls).toBe(2);
  });

  it('does not retry when retryOn does not match the error', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockImplementation(async (node: GraphNode): Promise<NodeExecutionResult> => {
      if (node.id === 'a') return { success: false, error: 'fatal' };
      return { success: true, output: `${node.id}-done` };
    });

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
    });

    const graph = makeLinearGraph('g-retry-filter', [
      {
        ...makeNode('a'),
        retryPolicy: { maxAttempts: 3, backoff: 'fixed', backoffMs: 1, retryOn: ['retryable'] },
      },
      makeNode('b'),
    ]);

    const events: string[] = [];
    for await (const event of runtime.stream(graph, {})) {
      events.push(event.type);
    }

    const aCalls = executeMock.mock.calls.filter(([n]: [GraphNode]) => n.id === 'a');
    expect(aCalls).toHaveLength(1);
    expect(events).toContain('error');
  });

  it('applies approved expansion patches between node executions', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockImplementation(async (node: GraphNode): Promise<NodeExecutionResult> => {
      if (node.id === 'a') {
        return {
          success: true,
          output: 'a-done',
          expansionRequests: [
            {
              trigger: 'agent_request',
              reason: 'Need a verifier',
              request: { need: 'Need a verifier', urgency: 'blocking' },
            },
          ],
        };
      }

      return {
        success: true,
        output: `${node.id}-done`,
      };
    });

    const expansionHandler = {
      handle: vi.fn(async (context: {
        graph: CompiledExecutionGraph;
      }) => ({
        graph: {
          ...context.graph,
          nodes: [
            ...context.graph.nodes,
            makeNode('verifier', {
              executorConfig: { type: 'gmi', instructions: 'Verify the prior result' },
            }),
          ],
          edges: [
            { id: 'start-a', source: START, target: 'a', type: 'static' as const },
            { id: 'a-verifier', source: 'a', target: 'verifier', type: 'static' as const },
            { id: 'verifier-end', source: 'verifier', target: END, type: 'static' as const },
          ],
        },
        events: [
          {
            type: 'mission:expansion_proposed' as const,
            patch: {
              addNodes: [makeNode('verifier')],
              addEdges: [{ id: 'a-verifier', source: 'a', target: 'verifier', type: 'static' as const }],
              removeNodes: [],
              rewireEdges: [{ from: 'a', to: END, newTarget: 'verifier' }],
              reason: 'Need a verifier',
              estimatedCostDelta: 0.25,
              estimatedLatencyDelta: 500,
            },
            trigger: 'agent_request' as const,
            reason: 'Need a verifier',
          },
          { type: 'mission:expansion_approved' as const, by: 'auto' as const },
          { type: 'mission:expansion_applied' as const, nodesAdded: 1, edgesAdded: 2 },
        ],
      })),
    };

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
      expansionHandler,
    });

    const graph = makeLinearGraph('g-expansion-approved', [makeNode('a')]);
    const visitedIds: string[] = [];
    const eventTypes: string[] = [];

    for await (const event of runtime.stream(graph, {})) {
      eventTypes.push(event.type);
      if (event.type === 'node_start') {
        visitedIds.push(event.nodeId);
      }
    }

    expect(expansionHandler.handle).toHaveBeenCalledTimes(1);
    expect(visitedIds).toEqual(['a', 'verifier']);
    expect(eventTypes).toContain('mission:checkpoint_saved');
    expect(eventTypes).toContain('mission:expansion_proposed');
    expect(eventTypes).toContain('mission:expansion_applied');
  });

  it('keeps executing the original graph when an expansion still needs approval', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockImplementation(async (node: GraphNode): Promise<NodeExecutionResult> => {
      if (node.id === 'a') {
        return {
          success: true,
          output: 'a-done',
          expansionRequests: [
            {
              trigger: 'agent_request',
              reason: 'Need a verifier',
              request: { need: 'Need a verifier', urgency: 'blocking' },
            },
          ],
        };
      }

      return {
        success: true,
        output: `${node.id}-done`,
      };
    });

    const expansionHandler = {
      handle: vi.fn(async () => ({
        events: [
          {
            type: 'mission:expansion_proposed' as const,
            patch: {
              addNodes: [makeNode('verifier')],
              addEdges: [{ id: 'a-verifier', source: 'a', target: 'verifier', type: 'static' as const }],
              removeNodes: [],
              rewireEdges: [{ from: 'a', to: END, newTarget: 'verifier' }],
              reason: 'Need a verifier',
              estimatedCostDelta: 0.25,
              estimatedLatencyDelta: 500,
            },
            trigger: 'agent_request' as const,
            reason: 'Need a verifier',
          },
          {
            type: 'mission:approval_required' as const,
            action: 'apply_graph_patch',
            details: { requesterNodeId: 'a' },
          },
        ],
      })),
    };

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
      expansionHandler,
    });

    const graph = makeLinearGraph('g-expansion-guided', [makeNode('a')]);
    const visitedIds: string[] = [];
    const eventTypes: string[] = [];

    for await (const event of runtime.stream(graph, {})) {
      eventTypes.push(event.type);
      if (event.type === 'node_start') {
        visitedIds.push(event.nodeId);
      }
    }

    expect(expansionHandler.handle).toHaveBeenCalledTimes(1);
    expect(visitedIds).toEqual(['a']);
    expect(eventTypes).toContain('mission:approval_required');
    expect(eventTypes).not.toContain('mission:expansion_applied');
  });

  it('processes expansion requests after a parallel batch when reevaluation is not crossed', async () => {
    const store = new InMemoryCheckpointStore();
    let activeExecutions = 0;
    let maxConcurrentExecutions = 0;

    const executeMock = vi.fn().mockImplementation(async (node: GraphNode): Promise<NodeExecutionResult> => {
      activeExecutions += 1;
      maxConcurrentExecutions = Math.max(maxConcurrentExecutions, activeExecutions);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeExecutions -= 1;

      if (node.id === 'a') {
        return {
          success: true,
          output: 'a-done',
          expansionRequests: [
            {
              trigger: 'agent_request',
              reason: 'Need verifier after parallel work',
              request: { need: 'verifier' },
            },
          ],
        };
      }

      return {
        success: true,
        output: `${node.id}-done`,
      };
    });

    const expansionHandler = {
      handle: vi.fn(async () => null),
    };

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
      expansionHandler,
      reevalInterval: 5,
    });

    const graph = makeParallelJoinGraph(
      'g-expansion-parallel-batch',
      makeNode('a'),
      makeNode('b'),
      makeNode('join'),
    );

    const visitedIds: string[] = [];
    for await (const event of runtime.stream(graph, {})) {
      if (event.type === 'node_start') {
        visitedIds.push(event.nodeId);
      }
    }

    expect(maxConcurrentExecutions).toBe(2);
    expect(expansionHandler.handle).toHaveBeenCalledTimes(1);
    expect(expansionHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'a',
        request: expect.objectContaining({
          trigger: 'agent_request',
        }),
      }),
    );
    expect(visitedIds).toEqual(expect.arrayContaining(['a', 'b', 'join']));
  });

  it('keeps a full parallel batch when it lands exactly on a reevaluation boundary', async () => {
    const store = new InMemoryCheckpointStore();
    let activeExecutions = 0;
    let maxConcurrentExecutions = 0;

    const executeMock = vi.fn().mockImplementation(async (node: GraphNode): Promise<NodeExecutionResult> => {
      activeExecutions += 1;
      maxConcurrentExecutions = Math.max(maxConcurrentExecutions, activeExecutions);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeExecutions -= 1;
      return {
        success: true,
        output: `${node.id}-done`,
      };
    });

    const expansionHandler = {
      handle: vi.fn(async () => null),
    };

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
      expansionHandler,
      reevalInterval: 2,
    });

    const graph = makeParallelJoinGraph(
      'g-expansion-sequential-reeval-boundary',
      makeNode('a'),
      makeNode('b'),
      makeNode('join'),
    );

    for await (const _event of runtime.stream(graph, {})) {
      // Consume the full stream.
    }

    expect(maxConcurrentExecutions).toBe(2);
    expect(expansionHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'b',
        request: expect.objectContaining({
          trigger: 'planner_reeval',
        }),
      }),
    );
  });

  it('splits a wide parallel fan-out at the next reevaluation boundary instead of fully serializing it', async () => {
    const store = new InMemoryCheckpointStore();
    let activeExecutions = 0;
    let maxConcurrentExecutions = 0;

    const executeMock = vi.fn().mockImplementation(async (node: GraphNode): Promise<NodeExecutionResult> => {
      activeExecutions += 1;
      maxConcurrentExecutions = Math.max(maxConcurrentExecutions, activeExecutions);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeExecutions -= 1;
      return {
        success: true,
        output: `${node.id}-done`,
      };
    });

    const expansionHandler = {
      handle: vi.fn(async () => null),
    };

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
      expansionHandler,
      reevalInterval: 2,
    });

    const graph = makeWideParallelJoinGraph(
      'g-expansion-partial-parallel-reeval-boundary',
      [makeNode('a'), makeNode('b'), makeNode('c')],
      makeNode('join'),
    );

    const visitedIds: string[] = [];
    for await (const event of runtime.stream(graph, {})) {
      if (event.type === 'node_start') {
        visitedIds.push(event.nodeId);
      }
    }

    expect(maxConcurrentExecutions).toBe(2);
    expect(expansionHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          trigger: 'planner_reeval',
        }),
      }),
    );
    expect(visitedIds).toEqual(expect.arrayContaining(['a', 'b', 'c', 'join']));
  });

  it('triggers periodic planner reevaluation after the configured number of completed nodes', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockImplementation(async (node: GraphNode): Promise<NodeExecutionResult> => ({
      success: true,
      output: `${node.id}-done`,
    }));

    const expansionHandler = {
      handle: vi.fn(async (context: { graph: CompiledExecutionGraph; request: { trigger: string } }) => ({
        graph: {
          ...context.graph,
          nodes: [
            ...context.graph.nodes,
            makeNode('verifier', {
              executorConfig: { type: 'gmi', instructions: 'Verify after reevaluation' },
            }),
          ],
          edges: [
            { id: 'start-a', source: START, target: 'a', type: 'static' as const },
            { id: 'a-verifier', source: 'a', target: 'verifier', type: 'static' as const },
            { id: 'verifier-end', source: 'verifier', target: END, type: 'static' as const },
          ],
        },
        events: [
          {
            type: 'mission:expansion_proposed' as const,
            patch: {
              addNodes: [makeNode('verifier')],
              addEdges: [{ id: 'a-verifier', source: 'a', target: 'verifier', type: 'static' as const }],
              removeNodes: [],
              rewireEdges: [{ from: 'a', to: END, newTarget: 'verifier' }],
              reason: 'Planner reevaluation inserted a verifier',
              estimatedCostDelta: 0.1,
              estimatedLatencyDelta: 200,
            },
            trigger: 'planner_reeval' as const,
            reason: 'Planner reevaluation inserted a verifier',
          },
          { type: 'mission:expansion_applied' as const, nodesAdded: 1, edgesAdded: 2 },
        ],
      })),
    };

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
      expansionHandler,
      reevalInterval: 2,
    });

    const graph = makeLinearGraph('g-planner-reeval', [makeNode('a'), makeNode('b')]);
    const visitedIds: string[] = [];

    for await (const event of runtime.stream(graph, {})) {
      if (event.type === 'node_start') {
        visitedIds.push(event.nodeId);
      }
    }

    expect(expansionHandler.handle).toHaveBeenCalledTimes(1);
    expect(expansionHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          trigger: 'planner_reeval',
        }),
      }),
    );
    expect(visitedIds).toEqual(['a', 'b', 'verifier']);
  });

  // ── Telemetry forwarding through parallel + sequential branches ───────────
  //
  // The runtime emits `node_end` events from six different code paths
  // (parallel-branch resolver, sequential, retry, interrupt, error, resume).
  // Each path forwards `result.metadata` into the event's `telemetry` field
  // so per-node iteration / tool-call counters reach streamGraph consumers
  // identically regardless of execution mode. This test pins the parallel
  // path specifically — the sequential path is exercised across most other
  // tests in this suite.

  it('forwards result.metadata as node_end.telemetry for both branches in a parallel batch', async () => {
    const store = new InMemoryCheckpointStore();
    const executeMock = vi.fn().mockImplementation(
      async (node: GraphNode): Promise<NodeExecutionResult> => ({
        success: true,
        output: `${node.id}-done`,
        // Per-node telemetry varies by branch so we can verify each event
        // carries the metadata of its own node, not a shared/empty value.
        metadata: node.id === 'left'
          ? { iterations: 3, toolCalls: 2, toolErrors: 0, iterationsExhausted: false }
          : node.id === 'right'
            ? { iterations: 5, toolCalls: 4, toolErrors: 1, iterationsExhausted: true }
            : { iterations: 1, toolCalls: 0, toolErrors: 0, iterationsExhausted: false },
      }),
    );

    const runtime = new GraphRuntime({
      checkpointStore: store,
      nodeExecutor: makeExecutorWithMock(executeMock),
      // No expansion handler / reevaluation — keeps the parallel batch intact
      // so left+right resolve via the parallel branch resolver.
    });

    const graph = makeParallelJoinGraph(
      'g-parallel-telemetry',
      makeNode('left'),
      makeNode('right'),
      makeNode('join'),
    );

    const nodeEnds: Record<string, unknown> = {};
    for await (const event of runtime.stream(graph, {})) {
      if (event.type === 'node_end') {
        nodeEnds[event.nodeId] = (event as { telemetry?: unknown }).telemetry;
      }
    }

    expect(nodeEnds.left).toEqual({
      iterations: 3, toolCalls: 2, toolErrors: 0, iterationsExhausted: false,
    });
    expect(nodeEnds.right).toEqual({
      iterations: 5, toolCalls: 4, toolErrors: 1, iterationsExhausted: true,
    });
    expect(nodeEnds.join).toEqual({
      iterations: 1, toolCalls: 0, toolErrors: 0, iterationsExhausted: false,
    });
  });
});
