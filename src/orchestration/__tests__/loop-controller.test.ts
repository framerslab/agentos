/**
 * @file loop-controller.test.ts
 * @description Unit tests for LoopController — the configurable ReAct loop primitive.
 *
 * Each test exercises a distinct behaviour axis:
 *   1. Single-turn (no tools) — text_delta + loop_complete
 *   2. Multi-turn tool loop — correct iteration count
 *   3. maxIterations cap — emits max_iterations_reached
 *   4. fail_closed — throws on tool error
 *   5. fail_open — emits tool_error and continues
 *   6. Parallel tools — Promise.allSettled dispatch with multiple calls per iteration
 */

import { describe, it, expect, vi } from 'vitest';
import { LoopController } from '../runtime/LoopController.js';
import type {
  LoopConfig,
  LoopContext,
  LoopChunk,
  LoopEvent,
  LoopOutput,
  LoopToolCallRequest,
  LoopToolCallResult,
} from '../runtime/LoopController.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collects all events from the LoopController generator into an array.
 * Propagates any thrown errors so individual tests can assert on them.
 */
async function collectEvents(
  config: LoopConfig,
  context: LoopContext,
): Promise<ReturnType<LoopController['execute']> extends AsyncGenerator<infer E> ? E[] : never> {
  const controller = new LoopController();
  const events: any[] = [];
  for await (const event of controller.execute(config, context)) {
    events.push(event);
  }
  return events as any;
}

/**
 * Base config used across tests; individual tests override specific fields.
 */
function baseConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    maxIterations: 10,
    parallelTools: false,
    failureMode: 'fail_open',
    ...overrides,
  };
}

/**
 * Creates a mock LoopContext where `generateStream` requests tool calls for
 * the first `toolCallIterations` invocations, then emits a final text delta
 * and terminates cleanly.
 *
 * @param toolCallIterations - How many iterations should request a tool call.
 * @param toolCallsPerIteration - Number of tool calls to include per iteration.
 */
function createMockContext(
  toolCallIterations: number,
  toolCallsPerIteration = 1,
) {
  let calls = 0;
  const addedResults: LoopToolCallResult[][] = [];

  const context: LoopContext = {
    generateStream: async function* () {
      calls++;

      if (calls <= toolCallIterations) {
        // Build N tool calls for this iteration.
        const tc: LoopToolCallRequest[] = Array.from(
          { length: toolCallsPerIteration },
          (_, j) => ({
            id: `tc-${calls}-${j}`,
            name: 'test_tool',
            arguments: {},
          }),
        );
        yield { type: 'tool_call_request' as const, toolCalls: tc } satisfies LoopChunk;
        return {
          responseText: '',
          toolCalls: tc,
          finishReason: 'tool_calls',
        } satisfies LoopOutput;
      }

      // Final iteration — emit text and terminate.
      yield { type: 'text_delta' as const, content: 'Final answer' } satisfies LoopChunk;
      return {
        responseText: 'Final answer',
        toolCalls: [],
        finishReason: 'stop',
      } satisfies LoopOutput;
    },

    executeTool: vi.fn<(tc: LoopToolCallRequest) => Promise<LoopToolCallResult>>().mockImplementation(
      async (tc) => ({
        id: tc.id,
        name: tc.name,
        success: true,
        output: 'result',
      }),
    ),

    addToolResults: vi.fn((results: LoopToolCallResult[]) => {
      addedResults.push(results);
    }),
  };

  return {
    context,
    getCallCount: () => calls,
    addedResults,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LoopController', () => {
  // -------------------------------------------------------------------------
  // 1. Single turn — no tool calls
  // -------------------------------------------------------------------------
  it('single turn (0 tool calls) emits text_delta and loop_complete; executeTool is never called', async () => {
    const { context } = createMockContext(0); // 0 tool-call iterations → goes straight to final text
    const events = await collectEvents(baseConfig(), context);

    const types = events.map((e) => e.type);
    expect(types).toContain('text_delta');
    expect(types).toContain('loop_complete');
    expect(types).not.toContain('tool_call_request');
    expect(types).not.toContain('tool_result');

    expect(context.executeTool).not.toHaveBeenCalled();

    const complete = events.find((e) => e.type === 'loop_complete');
    expect(complete?.totalIterations).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. Multi-turn tool loop
  // -------------------------------------------------------------------------
  it('loops through tool calls for N iterations then terminates', async () => {
    const { context, getCallCount } = createMockContext(2);
    const events = await collectEvents(baseConfig(), context);

    // generateStream should have been called 3 times (2 tool + 1 final)
    expect(getCallCount()).toBe(3);

    // executeTool should have been called once per tool-call iteration
    expect(context.executeTool).toHaveBeenCalledTimes(2);

    // addToolResults should have been called after each tool iteration
    expect(context.addToolResults).toHaveBeenCalledTimes(2);

    // Final event is loop_complete
    const lastEvent = events[events.length - 1] as Extract<LoopEvent, { type: 'loop_complete' }>;
    expect(lastEvent.type).toBe('loop_complete');
    expect(lastEvent.totalIterations).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 3. maxIterations cap
  // -------------------------------------------------------------------------
  it('stops at maxIterations and emits max_iterations_reached', async () => {
    // Mock wants 10 iterations of tool calls; cap at 3
    const { context, getCallCount } = createMockContext(10);
    const events = await collectEvents(baseConfig({ maxIterations: 3 }), context);

    const lastEvent = events[events.length - 1] as Extract<LoopEvent, { type: 'max_iterations_reached' }>;
    expect(lastEvent.type).toBe('max_iterations_reached');
    expect(lastEvent.iteration).toBe(3);

    // generateStream called exactly maxIterations times
    expect(getCallCount()).toBe(3);

    // executeTool called once per capped iteration
    expect(context.executeTool).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // 4. fail_closed — throws on tool error
  // -------------------------------------------------------------------------
  it('throws when failureMode is fail_closed and a tool fails', async () => {
    const { context } = createMockContext(5);

    // Override executeTool to return a failure
    (context.executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'tc-1-0',
      name: 'test_tool',
      success: false,
      error: 'something went wrong',
    } satisfies LoopToolCallResult);

    const controller = new LoopController();
    const config = baseConfig({ failureMode: 'fail_closed' });

    await expect(async () => {
      for await (const _ of controller.execute(config, context)) {
        // consume
      }
    }).rejects.toThrow('fail_closed');
  });

  // -------------------------------------------------------------------------
  // 5. fail_open — emits tool_error and continues
  // -------------------------------------------------------------------------
  it('emits tool_error and continues when failureMode is fail_open', async () => {
    const { context } = createMockContext(1); // 1 tool iteration, then stop

    (context.executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'tc-1-0',
      name: 'test_tool',
      success: false,
      error: 'transient error',
    } satisfies LoopToolCallResult);

    const events = await collectEvents(baseConfig({ failureMode: 'fail_open' }), context);

    const errorEvent = events.find((e) => e.type === 'tool_error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error).toBe('transient error');

    // Loop should still complete after the error
    const completeEvent = events.find((e) => e.type === 'loop_complete');
    expect(completeEvent).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 6. Parallel tool dispatch
  // -------------------------------------------------------------------------
  it('dispatches multiple tool calls in parallel when parallelTools is true', async () => {
    // 1 iteration, 2 tool calls per iteration, then stop
    const { context } = createMockContext(1, 2);

    const dispatchOrder: number[] = [];
    let resolveFns: Array<() => void> = [];

    // Override executeTool to track concurrent invocations
    (context.executeTool as ReturnType<typeof vi.fn>).mockImplementation(
      async (tc: LoopToolCallRequest): Promise<LoopToolCallResult> => {
        const idx = dispatchOrder.length;
        dispatchOrder.push(idx);

        // Both calls should be in-flight simultaneously when parallel=true
        await new Promise<void>((resolve) => {
          resolveFns.push(resolve);
          // Resolve all once both are registered
          if (resolveFns.length === 2) {
            resolveFns.forEach((fn) => fn());
          }
        });

        return { id: tc.id, name: tc.name, success: true, output: 'ok' };
      },
    );

    const events = await collectEvents(
      baseConfig({ parallelTools: true }),
      context,
    );

    // Both calls should have been dispatched (2 calls in 1 tool iteration)
    expect(context.executeTool).toHaveBeenCalledTimes(2);

    // Both were dispatched before either resolved (i.e., truly concurrent)
    expect(dispatchOrder).toEqual([0, 1]);

    // We should still get 2 tool_result events
    const resultEvents = events.filter((e) => e.type === 'tool_result');
    expect(resultEvents).toHaveLength(2);

    // Loop completes normally
    const completeEvent = events.find((e) => e.type === 'loop_complete');
    expect(completeEvent).toBeDefined();
  });
});
