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
import type { NodeExecutionResult, NodeExecutorDeps } from '../runtime/NodeExecutor.js';
import { LoopController, type LoopChunk, type LoopOutput } from '../runtime/LoopController.js';
import { gmiNode, humanNode } from '../builders/nodes.js';
import type { GraphEvent } from '../events/GraphEvent.js';

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
    expect(executeMock.mock.calls.some(([n]) => n.id === 'b')).toBe(true);
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
    const aCalls = executeMock.mock.calls.filter(([n]) => n.id === 'a');
    expect(aCalls).toHaveLength(2);
    // Run should end with error.
    expect(events).toContain('error');
    // Node 'b' should NOT have run.
    expect(executeMock.mock.calls.some(([n]) => n.id === 'b')).toBe(false);
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

    const aCalls = executeMock.mock.calls.filter(([n]) => n.id === 'a');
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

// ---------------------------------------------------------------------------
// The checkpoint a halted run resumes from
// ---------------------------------------------------------------------------
//
// A human node with no decision interrupts the run, and a node that fails
// stops it. A host reading `stream()` stops at `interrupt` or `error` with
// `break`, which closes the generator at that `yield`, so the checkpoint the
// run resumes from has to be saved by then. The nodes run through the real
// NodeExecutor and LoopController; only the model's stream is scripted.

/**
 * A scripted model for GMI nodes: each node's instructions map to the text the
 * model streams back, or to the error the provider throws.
 */
function scriptedModel(replies: Record<string, string | Error>) {
  const calls: string[] = [];
  async function* providerCall(instructions: string): AsyncGenerator<LoopChunk, LoopOutput, undefined> {
    calls.push(instructions);
    const reply = replies[instructions];
    if (reply === undefined) throw new Error(`no reply scripted for "${instructions}"`);
    if (reply instanceof Error) throw reply;
    yield { type: 'text_delta', content: reply };
    return { responseText: reply, toolCalls: [], finishReason: 'stop' };
  }
  return { calls, providerCall };
}

function runtimeOver(
  store: InMemoryCheckpointStore,
  providerCall: NodeExecutorDeps['providerCall'],
): GraphRuntime {
  return new GraphRuntime({
    checkpointStore: store,
    nodeExecutor: new NodeExecutor({ loopController: new LoopController(), providerCall }),
  });
}

const DRAFT = 'Draft the release notes.';
const PUBLISH = 'Publish the release notes.';

function draftNode(): GraphNode {
  return { ...gmiNode({ instructions: DRAFT }), id: 'draft' };
}

function approveNode(): GraphNode {
  return { ...humanNode({ prompt: 'Publish these notes?' }), id: 'approve' };
}

function publishNode(): GraphNode {
  return { ...gmiNode({ instructions: PUBLISH }), id: 'publish' };
}

/** Reads `stream` up to the first event of type `stopAt`, then stops as `break` does. */
async function readUntil(
  stream: AsyncIterable<GraphEvent>,
  stopAt: GraphEvent['type'],
): Promise<GraphEvent[]> {
  const seen: GraphEvent[] = [];
  for await (const event of stream) {
    seen.push(event);
    if (event.type === stopAt) break;
  }
  return seen;
}

async function readAll(stream: AsyncIterable<GraphEvent>): Promise<GraphEvent[]> {
  const seen: GraphEvent[] = [];
  for await (const event of stream) seen.push(event);
  return seen;
}

/** Each event as `type:nodeId`, or `edge_transition:source->target`. */
function trace(events: GraphEvent[]): string[] {
  return events.map((event) => {
    if (event.type === 'edge_transition') return `edge_transition:${event.sourceId}->${event.targetId}`;
    if ('nodeId' in event && event.nodeId) return `${event.type}:${event.nodeId}`;
    return event.type;
  });
}

function runIdOf(events: GraphEvent[]): string {
  const first = events[0];
  if (first?.type !== 'run_start') throw new Error('the stream did not open with run_start');
  return first.runId;
}

describe('GraphRuntime: the checkpoint a halted run resumes from', () => {
  it('is saved before stream() yields interrupt, and a resume from it finishes the run', async () => {
    const store = new InMemoryCheckpointStore();
    const model = scriptedModel({ [DRAFT]: 'Draft: v2 ships the importer.', [PUBLISH]: 'Published.' });
    const runtime = runtimeOver(store, model.providerCall);
    const graph = makeLinearGraph('g-halt-interrupt', [draftNode(), approveNode(), publishNode()]);

    const seen = await readUntil(runtime.stream(graph, { release: 'v2' }), 'interrupt');

    expect(trace(seen)).toEqual([
      'run_start',
      'node_start:draft',
      'node_end:draft',
      'edge_transition:draft->approve',
      'node_start:approve',
      'node_end:approve',
      'interrupt:approve',
    ]);
    const runId = runIdOf(seen);
    expect(await store.latest(runId)).toMatchObject({
      graphId: 'g-halt-interrupt',
      nodeId: 'approve',
      visitedNodes: ['draft'],
      state: { artifacts: { draft: 'Draft: v2 ships the importer.' } },
      nodeResults: { approve: { effectClass: 'human', output: { prompt: 'Publish these notes?' } } },
    });

    // resume() marks the human node complete with its recorded output and runs the rest.
    const artifacts = await runtime.resume(graph, runId);
    expect(artifacts).toEqual({ draft: 'Draft: v2 ships the importer.', publish: 'Published.' });
    expect(model.calls).toEqual([DRAFT, PUBLISH]);
  });

  it('keeps the order of the events a consumer reads to the end, and invoke() returns as before', async () => {
    const model = scriptedModel({ [DRAFT]: 'Draft: v2 ships the importer.' });
    const graph = makeLinearGraph('g-halt-order', [draftNode(), approveNode(), publishNode()]);

    const streamStore = new InMemoryCheckpointStore();
    const events = await readAll(runtimeOver(streamStore, model.providerCall).stream(graph, {}));
    expect(trace(events)).toEqual([
      'run_start',
      'node_start:draft',
      'node_end:draft',
      'edge_transition:draft->approve',
      'node_start:approve',
      'node_end:approve',
      'interrupt:approve',
      'checkpoint_saved:approve',
      'run_end',
    ]);
    const saved = await streamStore.list('g-halt-order');
    expect(saved).toHaveLength(1);
    expect(events).toContainEqual({ type: 'checkpoint_saved', checkpointId: saved[0]?.id, nodeId: 'approve' });
    expect(events[events.length - 1]).toMatchObject({
      type: 'run_end',
      finalOutput: { draft: 'Draft: v2 ships the importer.' },
    });

    const invokeStore = new InMemoryCheckpointStore();
    const artifacts = await runtimeOver(invokeStore, model.providerCall).invoke(graph, {});
    expect(artifacts).toEqual({ draft: 'Draft: v2 ships the importer.' });
    expect((await invokeStore.list('g-halt-order')).map((cp) => cp.nodeId)).toEqual(['approve']);
  });

  it('is saved before stream() yields error when a node fails', async () => {
    const store = new InMemoryCheckpointStore();
    const model = scriptedModel({
      [DRAFT]: 'Draft: v2 ships the importer.',
      [PUBLISH]: new Error('provider unavailable'),
    });
    const graph = makeLinearGraph('g-halt-error', [draftNode(), publishNode()]);

    const seen = await readUntil(runtimeOver(store, model.providerCall).stream(graph, {}), 'error');

    expect(seen[seen.length - 1]).toEqual({
      type: 'error',
      nodeId: 'publish',
      error: { code: 'NODE_EXECUTION_FAILED', message: 'GMI execution failed: provider unavailable' },
    });
    expect(await store.latest(runIdOf(seen))).toMatchObject({ nodeId: 'publish', visitedNodes: ['draft'] });
  });

  it('is saved before stream() yields interrupt from a branch of a parallel batch', async () => {
    const store = new InMemoryCheckpointStore();
    const model = scriptedModel({ [DRAFT]: 'Draft: v2 ships the importer.' });
    // START fans out to draft and approve, which both lead to publish.
    const graph = makeParallelJoinGraph('g-halt-parallel', draftNode(), approveNode(), publishNode());

    const seen = await readUntil(runtimeOver(store, model.providerCall).stream(graph, {}), 'interrupt');

    expect(trace(seen)).toEqual([
      'run_start',
      'node_start:draft',
      'node_end:draft',
      'edge_transition:draft->publish',
      'node_start:approve',
      'node_end:approve',
      'interrupt:approve',
    ]);
    expect(await store.latest(runIdOf(seen))).toMatchObject({ nodeId: 'approve', visitedNodes: ['draft'] });
  });

  it('is saved before streamResume() yields interrupt', async () => {
    const store = new InMemoryCheckpointStore();
    const model = scriptedModel({ [DRAFT]: 'Draft: v2 ships the importer.', [PUBLISH]: 'Published.' });
    const runtime = runtimeOver(store, model.providerCall);
    const announce: GraphNode = { ...humanNode({ prompt: 'Announce the release?' }), id: 'announce' };
    const graph = makeLinearGraph('g-halt-resume', [draftNode(), approveNode(), publishNode(), announce]);

    const runId = runIdOf(await readAll(runtime.stream(graph, {})));
    const resumed = await readUntil(runtime.streamResume(graph, runId), 'interrupt');

    expect(trace(resumed)).toEqual([
      'run_start',
      'node_end:approve',
      'node_start:publish',
      'node_end:publish',
      'edge_transition:publish->announce',
      'node_start:announce',
      'node_end:announce',
      'interrupt:announce',
    ]);
    const saved = await store.list('g-halt-resume', { runId });
    expect(saved.map((cp) => cp.nodeId).sort()).toEqual(['announce', 'approve']);
  });
});

// ---------------------------------------------------------------------------
// A parallel batch keeps the artifacts of every branch
// ---------------------------------------------------------------------------
//
// Nodes that become ready together run as one batch, each branch on its own
// copy of the state. What each branch writes to `artifacts` has to reach the
// nodes after the batch and the result. The nodes run through the real
// NodeExecutor and LoopController; only the model's stream is scripted.

const NOTES = 'Write the notes for the importer.';
const DRAFTED = 'Draft: v2 ships the importer.';
const NOTED = 'Notes: the importer reads CSV.';

function notesNode(): GraphNode {
  return { ...gmiNode({ instructions: NOTES }), id: 'notes' };
}

/**
 * A scripted model, as `scriptedModel`, that also records the state each GMI
 * node's model call received. A reply listed in `late` waits a moment first,
 * so a branch declared early in a batch can finish after the ones declared
 * after it.
 */
function recordingModel(replies: Record<string, string>, late: string[] = []) {
  const calls: Array<{ instructions: string; scratch: unknown; artifacts: unknown }> = [];
  async function* providerCall(
    instructions: string,
    state: Partial<GraphState>,
  ): AsyncGenerator<LoopChunk, LoopOutput, undefined> {
    calls.push({ instructions, scratch: state.scratch, artifacts: state.artifacts });
    const reply = replies[instructions];
    if (reply === undefined) throw new Error(`no reply scripted for "${instructions}"`);
    if (late.includes(instructions)) await new Promise((resolve) => setTimeout(resolve, 20));
    yield { type: 'text_delta', content: reply };
    return { responseText: reply, toolCalls: [], finishReason: 'stop' };
  }
  /** The state the model call for `instructions` received. */
  function stateSeenBy(instructions: string): { scratch: unknown; artifacts: unknown } | undefined {
    const call = calls.find((entry) => entry.instructions === instructions);
    return call && { scratch: call.scratch, artifacts: call.artifacts };
  }
  return { providerCall, stateSeenBy };
}

/** A graph of static edges, one per `[source, target]` pair. */
function graphOf(
  id: string,
  nodes: GraphNode[],
  links: Array<[string, string]>,
  options: Partial<CompiledExecutionGraph> = {},
): CompiledExecutionGraph {
  return {
    id,
    name: id,
    nodes,
    edges: links.map(([source, target], i) => ({ id: `e${i}`, source, target, type: 'static' as const })),
    stateSchema: { input: {}, scratch: {}, artifacts: {} },
    reducers: {},
    checkpointPolicy: 'explicit',
    memoryConsistency: 'live',
    ...options,
  };
}

describe('GraphRuntime: a parallel batch keeps the artifacts of every branch', () => {
  it('returns the artifact of each branch from invoke(), and the node after the batch finds them', async () => {
    const model = recordingModel({ [DRAFT]: DRAFTED, [NOTES]: NOTED, [PUBLISH]: 'Published.' });
    // START fans out to draft and notes, which both lead to publish.
    const graph = makeParallelJoinGraph('g-batch-artifacts', draftNode(), notesNode(), publishNode());

    const artifacts = await runtimeOver(new InMemoryCheckpointStore(), model.providerCall).invoke(graph, {});

    expect(artifacts).toEqual({ draft: DRAFTED, notes: NOTED, publish: 'Published.' });
    expect(model.stateSeenBy(PUBLISH)?.artifacts).toEqual({ draft: DRAFTED, notes: NOTED });
  });

  it('gives a key both branches write to the branch declared later, or to the reducer registered for it', async () => {
    // draft and notes both write `summary`; draft is declared first and finishes last.
    const asSummary = (node: GraphNode): GraphNode => ({ ...node, metadata: { outputAs: 'summary' } });
    const replies = { [DRAFT]: DRAFTED, [NOTES]: NOTED, [PUBLISH]: 'Published.' };
    const run = (reducers: CompiledExecutionGraph['reducers']) =>
      runtimeOver(new InMemoryCheckpointStore(), recordingModel(replies, [DRAFT]).providerCall).invoke(
        makeParallelJoinGraph('g-batch-summary', asSummary(draftNode()), asSummary(notesNode()), publishNode(), {
          reducers,
        }),
        {},
      );

    expect(await run({})).toEqual({ summary: NOTED, publish: 'Published.' });
    expect(await run({ 'artifacts.summary': (existing, incoming) => [existing, incoming].join(' + ') })).toEqual({
      summary: `${DRAFTED} + ${NOTED}`,
      publish: 'Published.',
    });
  });

  it('keeps what one branch writes over the value another branch only carried from before the batch', async () => {
    // prep writes `summary`; then draft rewrites it in a batch with notes, which leaves it alone.
    const PREP = 'Outline the release notes.';
    const model = recordingModel({
      [PREP]: 'Outline: the importer.',
      [DRAFT]: DRAFTED,
      [NOTES]: NOTED,
      [PUBLISH]: 'Published.',
    });
    const prep: GraphNode = { ...gmiNode({ instructions: PREP }), id: 'prep', metadata: { outputAs: 'summary' } };
    const draft: GraphNode = { ...draftNode(), metadata: { outputAs: 'summary' } };
    const graph = graphOf('g-batch-carried', [prep, draft, notesNode(), publishNode()], [
      [START, 'prep'],
      ['prep', 'draft'],
      ['prep', 'notes'],
      ['draft', 'publish'],
      ['notes', 'publish'],
      ['publish', END],
    ]);

    const artifacts = await runtimeOver(new InMemoryCheckpointStore(), model.providerCall).invoke(graph, {});

    expect(artifacts).toEqual({ summary: DRAFTED, notes: NOTED, publish: 'Published.' });
  });
});

// ---------------------------------------------------------------------------
// The checkpoint of a parallel batch that halts
// ---------------------------------------------------------------------------
//
// When a branch of a batch interrupts or fails, the run stops there, and the
// branches that completed are in the checkpoint's `visitedNodes`, so a resume
// does not run them again: the checkpoint has to hold their state too. The
// search extension's executor, like the model, is the host's and is scripted.

const SOURCES = ['CHANGELOG.md', 'docs/importer.md'];

/** An extension node whose output object the runtime merges into `scratch`. */
function searchNode(): GraphNode {
  return {
    id: 'search',
    type: 'extension',
    executorConfig: { type: 'extension', extensionId: 'search', method: 'sources' },
    executionMode: 'single_turn',
    effectClass: 'read',
    checkpoint: 'none',
  };
}

function runtimeWithSearch(
  store: InMemoryCheckpointStore,
  providerCall: NodeExecutorDeps['providerCall'],
): GraphRuntime {
  return new GraphRuntime({
    checkpointStore: store,
    nodeExecutor: new NodeExecutor({
      loopController: new LoopController(),
      providerCall,
      extensionExecutor: async () => ({ success: true, output: { sources: SOURCES } }),
    }),
  });
}

describe('GraphRuntime: the checkpoint of a parallel batch that halts', () => {
  // START fans out to draft, approve and search, which all lead to publish.
  // approve waits for a person; draft, declared before it, and search,
  // declared after it, complete.
  const haltingBatch = (id: string) =>
    makeWideParallelJoinGraph(id, [draftNode(), approveNode(), searchNode()], publishNode());
  const completed = {
    scratch: { sources: SOURCES },
    artifacts: { draft: DRAFTED, search: { sources: SOURCES } },
  };

  it('holds every branch that completed with the halting one, and a resume continues from all of them', async () => {
    const store = new InMemoryCheckpointStore();
    const model = recordingModel({ [DRAFT]: DRAFTED, [PUBLISH]: 'Published.' });
    const runtime = runtimeWithSearch(store, model.providerCall);
    const graph = haltingBatch('g-batch-halt');

    const runId = runIdOf(await readUntil(runtime.stream(graph, {}), 'interrupt'));

    const checkpoint = await store.latest(runId);
    expect(checkpoint?.nodeId).toBe('approve');
    expect([...(checkpoint?.visitedNodes ?? [])].sort()).toEqual(['draft', 'search']);
    expect({ scratch: checkpoint?.state.scratch, artifacts: checkpoint?.state.artifacts }).toEqual(completed);

    const artifacts = await runtime.resume(graph, runId);
    expect(model.stateSeenBy(PUBLISH)).toEqual(completed);
    expect(artifacts).toEqual({ ...completed.artifacts, publish: 'Published.' });
  });

  it('ends the run with those artifacts when invoke() reads it to the end', async () => {
    const model = recordingModel({ [DRAFT]: DRAFTED });
    const runtime = runtimeWithSearch(new InMemoryCheckpointStore(), model.providerCall);

    expect(await runtime.invoke(haltingBatch('g-batch-halt-invoke'), {})).toEqual(completed.artifacts);
  });
});

// ---------------------------------------------------------------------------
// The events of a parallel branch that halts the run
// ---------------------------------------------------------------------------
//
// A host opens one approval per `interrupt` event, so a branch that waits for
// a person reports it once, with the events a node outside a batch yields.

describe('GraphRuntime: the events of a parallel branch that halts the run', () => {
  it('yields interrupt once when the branch waits for a person, in the order a node outside a batch does', async () => {
    const model = scriptedModel({ [DRAFT]: DRAFTED });
    // START fans out to draft and approve, which both lead to publish.
    const batch = makeParallelJoinGraph('g-batch-interrupt', draftNode(), approveNode(), publishNode());
    const line = makeLinearGraph('g-line-interrupt', [draftNode(), approveNode(), publishNode()]);

    const inBatch = trace(await readAll(runtimeOver(new InMemoryCheckpointStore(), model.providerCall).stream(batch, {})));
    const inLine = trace(await readAll(runtimeOver(new InMemoryCheckpointStore(), model.providerCall).stream(line, {})));

    expect(inBatch.filter((step) => step.startsWith('interrupt'))).toEqual(['interrupt:approve']);
    expect(inBatch).toEqual([
      'run_start',
      'node_start:draft',
      'node_end:draft',
      'edge_transition:draft->publish',
      'node_start:approve',
      'node_end:approve',
      'interrupt:approve',
      'checkpoint_saved:approve',
      'run_end',
    ]);
    expect(inBatch.slice(-4)).toEqual(inLine.slice(-4));
  });

  it('yields error, checkpoint_saved and one interrupt when the branch fails, as a node outside a batch does', async () => {
    const model = scriptedModel({ [DRAFT]: DRAFTED, [NOTES]: new Error('provider unavailable') });
    const batch = makeParallelJoinGraph('g-batch-error', draftNode(), notesNode(), publishNode());
    const line = makeLinearGraph('g-line-error', [draftNode(), notesNode(), publishNode()]);

    const inBatch = trace(await readAll(runtimeOver(new InMemoryCheckpointStore(), model.providerCall).stream(batch, {})));
    const inLine = trace(await readAll(runtimeOver(new InMemoryCheckpointStore(), model.providerCall).stream(line, {})));

    expect(inBatch).toEqual([
      'run_start',
      'node_start:draft',
      'node_end:draft',
      'edge_transition:draft->publish',
      'node_start:notes',
      'error:notes',
      'checkpoint_saved:notes',
      'interrupt:notes',
      'run_end',
    ]);
    expect(inBatch.slice(-4)).toEqual(inLine.slice(-4));
  });
});

// ---------------------------------------------------------------------------
// A value a branch only carried never replaces what a sibling wrote
// ---------------------------------------------------------------------------
//
// Each branch of a batch starts from a copy of the state before the batch, so
// it also holds every key it did not write. A branch that leaves a key alone
// must not undo a sibling's write to it, in the state the nodes after the
// batch read and in the checkpoint of a batch that halts. The search
// extension's executor, like the model, is the host's and is scripted.

const REFINED = ['docs/importer.md'];

/** A node that calls `method` on the search extension. */
function extensionNode(id: string, method: string): GraphNode {
  return { ...searchNode(), id, executorConfig: { type: 'extension', extensionId: 'search', method } };
}

/** A runtime whose search extension answers each method with the output listed for it. */
function runtimeWithExtension(
  store: InMemoryCheckpointStore,
  providerCall: NodeExecutorDeps['providerCall'],
  outputs: Record<string, unknown>,
): GraphRuntime {
  return new GraphRuntime({
    checkpointStore: store,
    nodeExecutor: new NodeExecutor({
      loopController: new LoopController(),
      providerCall,
      extensionExecutor: async (_extensionId, method) => ({ success: true, output: outputs[method] }),
    }),
  });
}

describe('GraphRuntime: a value a branch only carried never replaces what a sibling wrote', () => {
  // outline writes `sources`; refine rewrites it in a batch with a sibling
  // declared after it, which leaves it alone.
  const searches = { list: { sources: SOURCES }, refine: { sources: REFINED } };
  const outlineThenBatch = (id: string, sibling: GraphNode) =>
    graphOf(id, [extensionNode('outline', 'list'), extensionNode('refine', 'refine'), sibling, publishNode()], [
      [START, 'outline'],
      ['outline', 'refine'],
      ['outline', sibling.id],
      ['refine', 'publish'],
      [sibling.id, 'publish'],
      ['publish', END],
    ]);

  it('gives the node after the batch the scratch a branch wrote', async () => {
    const model = recordingModel({ [NOTES]: NOTED, [PUBLISH]: 'Published.' });
    const runtime = runtimeWithExtension(new InMemoryCheckpointStore(), model.providerCall, searches);

    await runtime.invoke(outlineThenBatch('g-batch-carried-scratch', notesNode()), {});

    expect(model.stateSeenBy(PUBLISH)?.scratch).toEqual({ sources: REFINED });
  });

  it('keeps the scratch a branch wrote in the checkpoint when the sibling halts, and a resume reads it', async () => {
    const store = new InMemoryCheckpointStore();
    const model = recordingModel({ [PUBLISH]: 'Published.' });
    const runtime = runtimeWithExtension(store, model.providerCall, searches);
    const graph = outlineThenBatch('g-batch-halt-carried-scratch', approveNode());

    const runId = runIdOf(await readUntil(runtime.stream(graph, {}), 'interrupt'));

    expect((await store.latest(runId))?.state.scratch).toEqual({ sources: REFINED });
    await runtime.resume(graph, runId);
    expect(model.stateSeenBy(PUBLISH)?.scratch).toEqual({ sources: REFINED });
  });
});
