/**
 * @fileoverview Tests for CreateWorkflowTool.
 *
 * Covers:
 *  1. Create a valid workflow and get back an ID
 *  2. Run a workflow and resolve $input / $prev references
 *  3. Reject workflow exceeding maxSteps
 *  4. Block recursive create_workflow in steps
 *  5. Reject steps referencing unavailable tools
 *  6. Step timeout triggers workflow failure
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreateWorkflowTool, type CreateWorkflowDeps } from '../CreateWorkflowTool.js';
import type { ToolExecutionContext } from '../../../core/tools/ITool.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ToolExecutionContext for testing. */
function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    gmiId: 'test-gmi',
    personaId: 'test-persona',
    userContext: { userId: 'test-user' } as any,
    correlationId: 'test-session',
    ...overrides,
  };
}

/** Build default deps with sensible mocks. */
function makeDeps(overrides?: Partial<CreateWorkflowDeps>): CreateWorkflowDeps {
  return {
    config: {
      maxSteps: 5,
      allowedTools: ['web_search', 'summarize', 'translate'],
    },
    executeTool: vi.fn().mockImplementation(async (name: string, args: any) => {
      if (name === 'web_search') return { results: ['result-1', 'result-2'] };
      if (name === 'summarize') return { summary: `Summary of: ${JSON.stringify(args)}` };
      if (name === 'translate') return { translated: 'translated text' };
      return { ok: true };
    }),
    listTools: () => ['web_search', 'summarize', 'translate', 'create_workflow'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CreateWorkflowTool', () => {
  let tool: CreateWorkflowTool;
  let deps: CreateWorkflowDeps;
  const ctx = makeContext();

  beforeEach(() => {
    deps = makeDeps();
    tool = new CreateWorkflowTool(deps);
  });

  it('should create a valid workflow and return an ID', async () => {
    const result = await tool.execute(
      {
        action: 'create',
        name: 'search-summarize',
        description: 'Search and summarize.',
        steps: [
          { tool: 'web_search', args: { query: '$input' } },
          { tool: 'summarize', args: { text: '$prev' } },
        ],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output.workflowId).toBeDefined();
    expect(result.output.name).toBe('search-summarize');
    expect(result.output.stepCount).toBe(2);
  });

  it('should run a workflow and resolve $input / $prev references', async () => {
    const createCtx = makeContext({
      correlationId: 'call-1',
      sessionData: { sessionId: 'shared-session' },
    });
    const runCtx = makeContext({
      correlationId: 'call-2',
      sessionData: { sessionId: 'shared-session' },
    });

    // Create workflow
    const createResult = await tool.execute(
      {
        action: 'create',
        name: 'search-summarize',
        description: 'Search and summarize.',
        steps: [
          { tool: 'web_search', args: { query: '$input' } },
          { tool: 'summarize', args: { text: '$prev' } },
        ],
      },
      createCtx,
    );

    const workflowId = createResult.output.workflowId;

    // Run workflow
    const runResult = await tool.execute(
      { action: 'run', workflowId, input: 'climate change' },
      runCtx,
    );

    expect(runResult.success).toBe(true);
    expect(runResult.output.stepResults).toHaveLength(2);
    expect(runResult.output.finalOutput).toBeDefined();

    // Verify executeTool was called with resolved args
    expect(deps.executeTool).toHaveBeenCalledWith(
      'web_search',
      { query: 'climate change' },
      expect.objectContaining({
        correlationId: 'call-2',
        sessionData: { sessionId: 'shared-session' },
      }),
      expect.any(AbortSignal),
    );
    // The second call should have received the output of web_search as $prev
    expect(deps.executeTool).toHaveBeenCalledWith('summarize', {
      text: { results: ['result-1', 'result-2'] },
    }, expect.objectContaining({
      correlationId: 'call-2',
      sessionData: { sessionId: 'shared-session' },
    }), expect.any(AbortSignal));
  });

  it('should isolate workflows by session', async () => {
    const sessionOneCtx = makeContext({
      correlationId: 'call-1',
      sessionData: { sessionId: 'session-one' },
    });
    const sessionTwoCtx = makeContext({
      correlationId: 'call-1',
      sessionData: { sessionId: 'session-two' },
    });

    const createResult = await tool.execute(
      {
        action: 'create',
        name: 'search-summarize',
        description: 'Search and summarize.',
        steps: [
          { tool: 'web_search', args: { query: '$input' } },
          { tool: 'summarize', args: { text: '$prev' } },
        ],
      },
      sessionOneCtx,
    );

    expect(createResult.success).toBe(true);

    const otherSessionList = await tool.execute({ action: 'list' }, sessionTwoCtx);
    expect(otherSessionList.success).toBe(true);
    expect(otherSessionList.output.workflows).toHaveLength(0);

    const crossSessionRun = await tool.execute(
      {
        action: 'run',
        workflowId: createResult.output.workflowId,
        input: 'climate change',
      },
      sessionTwoCtx,
    );

    expect(crossSessionRun.success).toBe(false);
    expect(crossSessionRun.error).toContain('not found');
  });

  it('should reject workflow exceeding maxSteps', async () => {
    const result = await tool.execute(
      {
        action: 'create',
        name: 'too-many-steps',
        description: 'Exceeds limit.',
        steps: Array.from({ length: 6 }, (_, i) => ({
          tool: 'web_search',
          args: { query: `step-${i}` },
        })),
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('maxSteps');
  });

  it('should block recursive create_workflow in steps', async () => {
    const result = await tool.execute(
      {
        action: 'create',
        name: 'recursive',
        description: 'Tries to recurse.',
        steps: [
          { tool: 'web_search', args: { query: '$input' } },
          { tool: 'create_workflow', args: { action: 'create', name: 'nested' } },
        ],
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('recursion');
  });

  it('should reject steps referencing unavailable tools', async () => {
    const result = await tool.execute(
      {
        action: 'create',
        name: 'bad-tool',
        description: 'References a nonexistent tool.',
        steps: [{ tool: 'nonexistent_tool', args: {} }],
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('nonexistent_tool');
    expect(result.error).toContain('not available');
  });

  it('should reject steps that are available but not allowed by config', async () => {
    const restrictedTool = new CreateWorkflowTool(
      makeDeps({
        config: {
          maxSteps: 5,
          allowedTools: ['web_search'],
        },
        listTools: () => ['web_search', 'translate', 'create_workflow'],
      }),
    );

    const result = await restrictedTool.execute(
      {
        action: 'create',
        name: 'disallowed-step',
        description: 'Uses a blocked tool.',
        steps: [{ tool: 'translate', args: { text: '$input' } }],
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not permitted');
  });

  it('should fail the workflow when a step times out', async () => {
    // Override executeTool to hang on the second call
    const slowDeps = makeDeps({
      executeTool: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'web_search') return { results: ['r1'] };
        // Simulate a step that never resolves
        return new Promise(() => {});
      }),
    });
    const slowTool = new CreateWorkflowTool(slowDeps);

    // Create workflow
    const createResult = await slowTool.execute(
      {
        action: 'create',
        name: 'slow-workflow',
        description: 'Second step hangs.',
        steps: [
          { tool: 'web_search', args: { query: '$input' } },
          { tool: 'summarize', args: { text: '$prev' } },
        ],
      },
      ctx,
    );

    const workflowId = createResult.output.workflowId;

    // Run — step 1 ("summarize") should timeout.
    // Use a shorter timeout for the test by monkey-patching the constant via fake timers.
    // Instead, we'll use vi.useFakeTimers to fast-forward past the 30s timeout.
    vi.useFakeTimers();

    const runPromise = slowTool.execute(
      { action: 'run', workflowId, input: 'test' },
      ctx,
    );

    // Advance past the 30-second timeout
    await vi.advanceTimersByTimeAsync(31_000);

    const runResult = await runPromise;

    vi.useRealTimers();

    expect(runResult.success).toBe(false);
    expect(runResult.error).toContain('timed out');
    expect(runResult.output.completedSteps).toBe(1);
    // The expired step is reported, and whether it took effect is not known.
    expect(runResult.output.stepResults[1]).toEqual({ status: 'expired', effect: 'unknown' });
  });
});
