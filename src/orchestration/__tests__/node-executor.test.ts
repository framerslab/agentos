/**
 * @file node-executor.test.ts
 * @description Unit tests for `NodeExecutor`.
 *
 * Covers:
 * 1. Tool node — successful invocation via `ToolOrchestrator`.
 * 2. Router node — function condition resolves to `routeTarget`.
 * 3. Guardrail node — passes when engine returns `passed: true`.
 * 4. Timeout — node that takes 5000 ms is aborted by a 50 ms timeout.
 * 5. Human node — always resolves with `interrupt: true`.
 * 6. No ToolOrchestrator — tool node returns `success: false` with error message.
 */

import { describe, it, expect, vi } from 'vitest';
import { NodeExecutor } from '../runtime/NodeExecutor.js';
import type { GraphNode, GraphState } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal `GraphNode` for a `tool` executor.
 *
 * @param toolName - Registered tool name.
 */
function makeToolNode(toolName: string): GraphNode {
  return {
    id: `node-${toolName}`,
    type: 'tool',
    executorConfig: { type: 'tool', toolName },
    executionMode: 'single_turn',
    effectClass: 'external',
    checkpoint: 'none',
  };
}

/**
 * Builds a minimal `GraphNode` for a `router` executor using a function condition.
 *
 * @param fn - Routing function receiving `GraphState` and returning the next node id.
 */
function makeRouterNode(fn: (state: GraphState) => string): GraphNode {
  return {
    id: 'node-router',
    type: 'router',
    executorConfig: { type: 'router', condition: { type: 'function', fn } },
    executionMode: 'single_turn',
    effectClass: 'pure',
    checkpoint: 'none',
  };
}

/**
 * Builds a minimal `GraphNode` for a `guardrail` executor.
 *
 * @param guardrailIds  - Guardrail identifiers to evaluate.
 * @param onViolation   - Action taken on violation.
 * @param rerouteTarget - Optional reroute destination.
 */
function makeGuardrailNode(
  guardrailIds: string[],
  onViolation: 'block' | 'reroute' | 'warn' | 'sanitize' = 'block',
  rerouteTarget?: string,
): GraphNode {
  return {
    id: 'node-guardrail',
    type: 'guardrail',
    executorConfig: { type: 'guardrail', guardrailIds, onViolation, rerouteTarget },
    executionMode: 'single_turn',
    effectClass: 'pure',
    checkpoint: 'none',
  };
}

/**
 * Builds a minimal `GraphNode` for a `human` executor.
 *
 * @param prompt - Message surfaced to the human operator.
 */
function makeHumanNode(prompt: string): GraphNode {
  return {
    id: 'node-human',
    type: 'human',
    executorConfig: { type: 'human', prompt },
    executionMode: 'single_turn',
    effectClass: 'human',
    checkpoint: 'none',
  };
}

/** Minimal stub of `GraphState` sufficient for routing and guardrail tests. */
const emptyState: Partial<GraphState> = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NodeExecutor', () => {
  // -------------------------------------------------------------------------
  // Test 1 — tool node executes via ToolOrchestrator
  // -------------------------------------------------------------------------

  it('executes a tool node via ToolOrchestrator and returns its output', async () => {
    const processToolCall = vi.fn().mockResolvedValue({
      success: true,
      output: { result: 'hello from tool' },
    });

    const executor = new NodeExecutor({ toolOrchestrator: { processToolCall } });
    const result = await executor.execute(makeToolNode('greet'), emptyState);

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ result: 'hello from tool' });
    expect(processToolCall).toHaveBeenCalledOnce();
    expect(processToolCall).toHaveBeenCalledWith({
      toolCallRequest: { toolName: 'greet', arguments: {} },
    });
  });

  // -------------------------------------------------------------------------
  // Test 2 — router node with function condition resolves routeTarget
  // -------------------------------------------------------------------------

  it('executes a router node with a function condition and returns routeTarget', async () => {
    const routeFn = vi.fn().mockReturnValue('branch-approved');
    const executor = new NodeExecutor({});
    const result = await executor.execute(makeRouterNode(routeFn), emptyState);

    expect(result.success).toBe(true);
    expect(result.routeTarget).toBe('branch-approved');
    expect(routeFn).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Test 3 — guardrail node passes when engine returns passed: true
  // -------------------------------------------------------------------------

  it('executes a guardrail node and returns passed:true when engine passes', async () => {
    const evaluate = vi.fn().mockResolvedValue({ passed: true, results: [] });

    const executor = new NodeExecutor({
      guardrailEngine: { evaluate },
    });

    const result = await executor.execute(
      makeGuardrailNode(['safe-content', 'no-pii']),
      emptyState,
    );

    expect(result.success).toBe(true);
    expect((result.output as { passed: boolean }).passed).toBe(true);
    expect(evaluate).toHaveBeenCalledWith(undefined, ['safe-content', 'no-pii']);
  });

  // -------------------------------------------------------------------------
  // Test 4 — timeout aborts a slow tool node
  // -------------------------------------------------------------------------

  it('aborts execution and returns success:false when node.timeout is exceeded', async () => {
    // Tool that never resolves within the test window (5 000 ms).
    const processToolCall = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 5_000)),
    );

    const executor = new NodeExecutor({ toolOrchestrator: { processToolCall } });

    // Clone makeToolNode and inject a 50 ms timeout.
    const node: GraphNode = { ...makeToolNode('slow-tool'), timeout: 50 };

    const result = await executor.execute(node, emptyState);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timeout after 50ms/);
  }, 2_000 /* test-level timeout: 2 s — well above the 50 ms node timeout */);

  // -------------------------------------------------------------------------
  // Test 5 — human node suspends execution with interrupt flag
  // -------------------------------------------------------------------------

  it('executes a human node and returns interrupt:true with the configured prompt', async () => {
    const executor = new NodeExecutor({});
    const result = await executor.execute(
      makeHumanNode('Please approve the generated content.'),
      emptyState,
    );

    expect(result.interrupt).toBe(true);
    expect(result.success).toBe(false);
    expect((result.output as { prompt: string }).prompt).toBe(
      'Please approve the generated content.',
    );
  });

  // -------------------------------------------------------------------------
  // Test 6 — tool node without ToolOrchestrator returns graceful error
  // -------------------------------------------------------------------------

  it('returns success:false when no ToolOrchestrator is configured', async () => {
    // Executor created with empty deps — no toolOrchestrator.
    const executor = new NodeExecutor({});
    const result = await executor.execute(makeToolNode('any-tool'), emptyState);

    expect(result.success).toBe(false);
    expect(result.error).toBe('No ToolOrchestrator configured');
  });

  // -------------------------------------------------------------------------
  // Test 7 — GMI node with mock LoopController accumulates text
  // -------------------------------------------------------------------------

  it('executes a gmi node with LoopController and returns accumulated text', async () => {
    const mockLoopController = {
      async *execute(_config: unknown, context: { generateStream: () => AsyncGenerator<unknown, unknown, undefined> }) {
        const gen = context.generateStream();
        while (true) {
          const { value, done } = await gen.next();
          if (done) break;
          const chunk = value as { type: string; content?: string };
          if (chunk.type === 'text_delta' && chunk.content) {
            yield { type: 'text_delta' as const, content: chunk.content };
          }
        }
        yield { type: 'loop_complete' as const, totalIterations: 1 };
      },
    };

    async function* mockProviderCall() {
      yield { type: 'text_delta' as const, content: 'Hello ' };
      yield { type: 'text_delta' as const, content: 'World' };
      return { responseText: 'Hello World', toolCalls: [], finishReason: 'stop' };
    }

    const executor = new NodeExecutor({
      loopController: mockLoopController as any,
      providerCall: () => mockProviderCall(),
    });

    const node: GraphNode = {
      id: 'node-gmi',
      type: 'gmi',
      executorConfig: { type: 'gmi', instructions: 'Say hello' },
      executionMode: 'single_turn',
      effectClass: 'pure',
      checkpoint: 'none',
    };

    const result = await executor.execute(node, emptyState);
    expect(result.success).toBe(true);
    expect(result.output).toBe('Hello World');
  });

  // -------------------------------------------------------------------------
  // Test 8 — Subgraph node with mock resolver invokes recursively
  // -------------------------------------------------------------------------

  it('executes a subgraph node by delegating to a child runtime', async () => {
    const childGraph = {
      id: 'child-graph',
      name: 'child',
      nodes: [],
      edges: [],
      stateSchema: { input: {}, scratch: {}, artifacts: {} },
      reducers: {},
      checkpointPolicy: 'none' as const,
      memoryConsistency: 'live' as const,
    };

    const mockRuntime = {
      invoke: vi.fn().mockResolvedValue({ answer: 42 }),
    };

    const executor = new NodeExecutor({
      subgraphResolver: (id: string) => id === 'child-graph' ? childGraph : undefined,
      createSubgraphRuntime: () => mockRuntime,
    });

    const node: GraphNode = {
      id: 'node-subgraph',
      type: 'subgraph',
      executorConfig: {
        type: 'subgraph',
        graphId: 'child-graph',
        inputMapping: { 'query': 'q' },
        outputMapping: { 'answer': 'result' },
      },
      executionMode: 'single_turn',
      effectClass: 'pure',
      checkpoint: 'none',
    };

    const state: Partial<GraphState> = { scratch: { query: 'hello' } } as any;
    const result = await executor.execute(node, state);

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ answer: 42 });
    expect(result.scratchUpdate).toEqual({ result: 42 });
    expect(mockRuntime.invoke).toHaveBeenCalledWith(childGraph, { q: 'hello' });
  });

  // -------------------------------------------------------------------------
  // Test 9 — Expression evaluator: scratch.x > 5
  // -------------------------------------------------------------------------

  it('evaluates expression "scratch.x > 5 ? \'yes\' : \'no\'" correctly', async () => {
    const executor = new NodeExecutor({});
    const node: GraphNode = {
      id: 'node-expr',
      type: 'router',
      executorConfig: {
        type: 'router',
        condition: { type: 'expression', expr: "scratch.x > 5 ? 'yes' : 'no'" },
      },
      executionMode: 'single_turn',
      effectClass: 'pure',
      checkpoint: 'none',
    };

    const state: Partial<GraphState> = { scratch: { x: 10 } } as any;
    const result = await executor.execute(node, state);

    expect(result.success).toBe(true);
    expect(result.routeTarget).toBe('yes');
  });

  // -------------------------------------------------------------------------
  // Test 10 — Expression evaluator: scratch.name == 'pro'
  // -------------------------------------------------------------------------

  it('evaluates expression "scratch.name == \'pro\' ? \'a\' : \'b\'" correctly', async () => {
    const executor = new NodeExecutor({});
    const node: GraphNode = {
      id: 'node-expr2',
      type: 'router',
      executorConfig: {
        type: 'router',
        condition: { type: 'expression', expr: "scratch.name == 'pro' ? 'a' : 'b'" },
      },
      executionMode: 'single_turn',
      effectClass: 'pure',
      checkpoint: 'none',
    };

    const state: Partial<GraphState> = { scratch: { name: 'pro' } } as any;
    const result = await executor.execute(node, state);

    expect(result.success).toBe(true);
    expect(result.routeTarget).toBe('a');
  });

  // -------------------------------------------------------------------------
  // Test 11 — Expression evaluator returns 'false' on invalid expression
  // -------------------------------------------------------------------------

  it('returns "false" when expression evaluation fails', async () => {
    const executor = new NodeExecutor({});
    const node: GraphNode = {
      id: 'node-expr-bad',
      type: 'router',
      executorConfig: {
        type: 'router',
        condition: { type: 'expression', expr: '{{invalid syntax' },
      },
      executionMode: 'single_turn',
      effectClass: 'pure',
      checkpoint: 'none',
    };

    const result = await executor.execute(node, emptyState);

    expect(result.success).toBe(true);
    expect(result.routeTarget).toBe('false');
  });

  // -------------------------------------------------------------------------
  // Test 12 — GMI node: max_iterations_reached with tool results but no
  // text_delta events should fall back to formatted tool results, not return
  // an empty string.
  //
  // Repro for the regression observed when a low maxIterationsPerNode (e.g. 4)
  // exhausts before the LLM emits its final summary. With OpenAI tool calling,
  // an iteration can be 100% tool_calls with empty content, so accumulatedText
  // remains '' across the whole loop. Returning '' propagates an empty output
  // to downstream nodes, breaking the mission.
  // -------------------------------------------------------------------------
  it('falls back to formatted tool results when iterations exhaust without text_delta', async () => {
    const mockLoopController = {
      // Yields two successful tool_results then max_iterations_reached, never
      // a text_delta.
      async *execute(_config: unknown, _context: unknown) {
        yield {
          type: 'tool_result' as const,
          toolName: 'web_search',
          result: { id: 'tc1', name: 'web_search', success: true, output: 'Two relevant URLs found about meme research.' },
        };
        yield {
          type: 'tool_result' as const,
          toolName: 'web_fetch',
          result: { id: 'tc2', name: 'web_fetch', success: true, output: { title: 'Trending memes 2026', url: 'https://example.com/memes' } },
        };
        yield { type: 'max_iterations_reached' as const, iteration: 4 };
      },
    };

    async function* mockProviderCall() {
      // Provider isn't actually consulted by this mock loop, so an empty stream
      // is fine.
      return { responseText: '', toolCalls: [], finishReason: 'stop' };
    }

    const executor = new NodeExecutor({
      loopController: mockLoopController as any,
      providerCall: () => mockProviderCall(),
    });

    const node: GraphNode = {
      id: 'gather-info',
      type: 'gmi',
      executorConfig: { type: 'gmi', instructions: 'Research memes', maxInternalIterations: 4 },
      executionMode: 'single_turn',
      effectClass: 'pure',
      checkpoint: 'none',
    };

    const result = await executor.execute(node, {} as Partial<GraphState>);

    expect(result.success).toBe(true);
    // Output must NOT be empty when tool results were produced.
    expect(typeof result.output).toBe('string');
    const output = String(result.output ?? '');
    expect(output.length).toBeGreaterThan(0);
    // Should reference the tool names so subsequent nodes can use the data.
    expect(output).toContain('web_search');
    expect(output).toContain('web_fetch');
    // Should contain content from the tool outputs.
    expect(output).toContain('Two relevant URLs');
    expect(output).toContain('Trending memes 2026');
  });

  // -------------------------------------------------------------------------
  // Test 13 — GMI node: when only tool errors fired (no text, no successful
  // results), the fallback still surfaces the error info so subsequent nodes
  // and the user can see what went wrong, instead of an empty string.
  // -------------------------------------------------------------------------
  it('surfaces tool errors as fallback when no text and no successful results', async () => {
    const mockLoopController = {
      async *execute(_config: unknown, _context: unknown) {
        yield { type: 'tool_error' as const, toolName: 'web_search', error: 'rate limit exceeded' };
        yield { type: 'tool_error' as const, toolName: 'image_search', error: 'auth failed' };
        yield { type: 'max_iterations_reached' as const, iteration: 4 };
      },
    };

    async function* mockProviderCall() {
      return { responseText: '', toolCalls: [], finishReason: 'stop' };
    }

    const executor = new NodeExecutor({
      loopController: mockLoopController as any,
      providerCall: () => mockProviderCall(),
    });

    const node: GraphNode = {
      id: 'gather-info',
      type: 'gmi',
      executorConfig: { type: 'gmi', instructions: 'Search', maxInternalIterations: 4 },
      executionMode: 'single_turn',
      effectClass: 'pure',
      checkpoint: 'none',
    };

    const result = await executor.execute(node, {} as Partial<GraphState>);

    expect(result.success).toBe(true);
    const output = String(result.output ?? '');
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain('web_search');
    expect(output).toContain('rate limit exceeded');
    expect(output).toContain('image_search');
    expect(output).toContain('auth failed');
  });

  // -------------------------------------------------------------------------
  // Test 14 — GMI fallback truncates total output when many large tool
  // results exceed the safety cap (16000 chars). Prevents a single empty-
  // response node from blowing up downstream prompts.
  // -------------------------------------------------------------------------
  it('caps the empty-output fallback at the total size limit', async () => {
    const bigResult = 'x'.repeat(4000);
    const mockLoopController = {
      async *execute(_config: unknown, _context: unknown) {
        // 10 results × ~4000 chars each = ~40KB raw, well past the 16KB cap.
        for (let i = 0; i < 10; i++) {
          yield {
            type: 'tool_result' as const,
            toolName: `tool_${i}`,
            result: { id: `tc${i}`, name: `tool_${i}`, success: true, output: bigResult },
          };
        }
        yield { type: 'max_iterations_reached' as const, iteration: 10 };
      },
    };

    async function* mockProviderCall() {
      return { responseText: '', toolCalls: [], finishReason: 'stop' };
    }

    const executor = new NodeExecutor({
      loopController: mockLoopController as any,
      providerCall: () => mockProviderCall(),
    });

    const node: GraphNode = {
      id: 'gather-info',
      type: 'gmi',
      executorConfig: { type: 'gmi', instructions: 'Search', maxInternalIterations: 10 },
      executionMode: 'single_turn',
      effectClass: 'pure',
      checkpoint: 'none',
    };

    const result = await executor.execute(node, {} as Partial<GraphState>);

    expect(result.success).toBe(true);
    const output = String(result.output ?? '');
    // Generous slack so we don't depend on exact join overhead.
    expect(output.length).toBeLessThan(20000);
    expect(output).toContain('[fallback truncated]');
  });

  // -------------------------------------------------------------------------
  // Test 15 — GMI fallback handles non-serializable tool outputs (BigInt)
  // without crashing. JSON.stringify throws TypeError on BigInt; the executor
  // must catch and fall back to String(out).
  // -------------------------------------------------------------------------
  it('serialises BigInt and other non-JSON-safe tool outputs via String() fallback', async () => {
    const mockLoopController = {
      async *execute(_config: unknown, _context: unknown) {
        yield {
          type: 'tool_result' as const,
          toolName: 'count_rows',
          result: { id: 'tc1', name: 'count_rows', success: true, output: 9007199254740993n },
        };
        yield { type: 'max_iterations_reached' as const, iteration: 4 };
      },
    };

    async function* mockProviderCall() {
      return { responseText: '', toolCalls: [], finishReason: 'stop' };
    }

    const executor = new NodeExecutor({
      loopController: mockLoopController as any,
      providerCall: () => mockProviderCall(),
    });

    const node: GraphNode = {
      id: 'gather-info',
      type: 'gmi',
      executorConfig: { type: 'gmi', instructions: 'Count rows', maxInternalIterations: 4 },
      executionMode: 'single_turn',
      effectClass: 'pure',
      checkpoint: 'none',
    };

    const result = await executor.execute(node, {} as Partial<GraphState>);

    expect(result.success).toBe(true);
    const output = String(result.output ?? '');
    // Fallback fired and serialised the BigInt safely.
    expect(output).toContain('count_rows');
    expect(output).toContain('9007199254740993');
  });

  // -------------------------------------------------------------------------
  // Test 16 — GMI fallback sanitises tool names so a registry tool with weird
  // chars (newlines, backticks, control chars) can't break the markdown
  // structure when the host renders the fallback as a code block in a report.
  // -------------------------------------------------------------------------
  it('sanitises tool names with newlines/backticks before interpolating into the fallback', async () => {
    const mockLoopController = {
      async *execute(_config: unknown, _context: unknown) {
        yield {
          type: 'tool_result' as const,
          toolName: 'evil`tool\n# fake-heading',
          result: { id: 'tc1', name: 'evil`tool\n# fake-heading', success: true, output: 'data' },
        };
        yield { type: 'max_iterations_reached' as const, iteration: 4 };
      },
    };

    async function* mockProviderCall() {
      return { responseText: '', toolCalls: [], finishReason: 'stop' };
    }

    const executor = new NodeExecutor({
      loopController: mockLoopController as any,
      providerCall: () => mockProviderCall(),
    });

    const node: GraphNode = {
      id: 'gather-info',
      type: 'gmi',
      executorConfig: { type: 'gmi', instructions: 'Run', maxInternalIterations: 4 },
      executionMode: 'single_turn',
      effectClass: 'pure',
      checkpoint: 'none',
    };

    const result = await executor.execute(node, {} as Partial<GraphState>);

    const output = String(result.output ?? '');
    // The sanitiser must strip newlines and backticks from the tool name
    // since they would break a markdown code-fence rendering of the report.
    // The `Tool: ` line should be a single line with no backticks; the
    // raw `# fake-heading` text is fine mid-line (markdown headings only
    // fire at the start of a line).
    const toolLines = output.split('\n').filter((l) => l.startsWith('Tool: '));
    expect(toolLines).toHaveLength(1);
    expect(toolLines[0]).not.toContain('`');
    // The dangerous case (newline-promoted heading) is structurally
    // impossible after sanitising newlines.
    expect(output.match(/^# fake-heading/m)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 17 — GMI executor populates per-node telemetry (iteration count,
  // tool calls, tool errors, iterationsExhausted) so the runtime can surface
  // it on `node_end` events for mission report telemetry.
  // -------------------------------------------------------------------------
  it('returns iteration / tool-call telemetry as result.metadata', async () => {
    const mockLoopController = {
      async *execute(_config: unknown, _context: unknown) {
        yield { type: 'text_delta' as const, content: 'thinking' };
        yield {
          type: 'tool_result' as const,
          toolName: 'web_search',
          result: { id: 'tc1', name: 'web_search', success: true, output: 'urls' },
        };
        yield {
          type: 'tool_result' as const,
          toolName: 'image_search',
          result: { id: 'tc2', name: 'image_search', success: true, output: 'images' },
        };
        yield { type: 'tool_error' as const, toolName: 'web_scrape', error: 'timeout' };
        yield { type: 'loop_complete' as const, totalIterations: 3 };
      },
    };

    async function* mockProviderCall() {
      return { responseText: '', toolCalls: [], finishReason: 'stop' };
    }

    const executor = new NodeExecutor({
      loopController: mockLoopController as any,
      providerCall: () => mockProviderCall(),
    });

    const node: GraphNode = {
      id: 'gather-info',
      type: 'gmi',
      executorConfig: { type: 'gmi', instructions: 'Research', maxInternalIterations: 5 },
      executionMode: 'single_turn',
      effectClass: 'pure',
      checkpoint: 'none',
    };

    const result = await executor.execute(node, {} as Partial<GraphState>);

    expect(result.success).toBe(true);
    expect(result.metadata).toEqual({
      iterations: 3,
      toolCalls: 2,
      toolErrors: 1,
      iterationsExhausted: false,
    });
  });

  // -------------------------------------------------------------------------
  // Test 18 — Telemetry marks iterationsExhausted=true when the loop hits
  // max_iterations_reached (so mission reports can show users that the
  // budget capped, not that the model finished naturally).
  // -------------------------------------------------------------------------
  it('marks iterationsExhausted in telemetry when max_iterations_reached fires', async () => {
    const mockLoopController = {
      async *execute(_config: unknown, _context: unknown) {
        yield { type: 'text_delta' as const, content: 'partial' };
        yield { type: 'max_iterations_reached' as const, iteration: 4 };
      },
    };

    async function* mockProviderCall() {
      return { responseText: '', toolCalls: [], finishReason: 'stop' };
    }

    const executor = new NodeExecutor({
      loopController: mockLoopController as any,
      providerCall: () => mockProviderCall(),
    });

    const node: GraphNode = {
      id: 'gather-info',
      type: 'gmi',
      executorConfig: { type: 'gmi', instructions: 'Research', maxInternalIterations: 4 },
      executionMode: 'single_turn',
      effectClass: 'pure',
      checkpoint: 'none',
    };

    const result = await executor.execute(node, {} as Partial<GraphState>);

    expect(result.metadata).toMatchObject({
      iterations: 4,
      iterationsExhausted: true,
    });
  });
});
