/**
 * @fileoverview Integration tests for ToolOrchestrator + Emergent Capability Engine.
 *
 * Covers:
 *  1. When `emergent` is disabled (default), `forge_tool` is NOT in the tool list.
 *  2. When `emergent` is enabled, `forge_tool` IS in the tool list.
 *  3. The emergent engine is accessible via `getEmergentEngine()`.
 *  4. `cleanupEmergentSession()` delegates to the engine without throwing.
 *  5. `getEmergentEngine()` returns `undefined` when emergent is disabled.
 *
 * These tests mock the orchestrator's dependencies (ToolExecutor, PermissionManager)
 * rather than testing the full forge pipeline — that is already covered by
 * engine-integration.spec.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolOrchestrator } from '../../../core/tools/ToolOrchestrator';
import type { IToolPermissionManager } from '../../../core/tools/permissions/IToolPermissionManager';
import { ToolExecutor } from '../../../core/tools/ToolExecutor';
import type { ITool } from '../../../core/tools/ITool';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock of the ToolPermissionManager.
 * Always allows execution so we can focus on tool list checks.
 */
function makeMockPermissionManager(): IToolPermissionManager {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    isExecutionAllowed: vi.fn().mockResolvedValue({ isAllowed: true }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as IToolPermissionManager;
}

/**
 * Build a minimal mock of the ToolExecutor.
 *
 * Maintains an internal registry map so `registerTool`, `getTool`, and
 * `listAvailableTools` work correctly during initialization.
 */
function makeMockToolExecutor(): ToolExecutor {
  const registry = new Map<string, ITool>();

  return {
    registerTool: vi.fn(async (tool: ITool) => {
      registry.set(tool.name, tool);
    }),
    unregisterTool: vi.fn(async (name: string) => {
      return registry.delete(name);
    }),
    getTool: vi.fn((name: string) => {
      return registry.get(name);
    }),
    listAvailableTools: vi.fn(() => {
      return Array.from(registry.values()).map((t) => ({
        name: t.name,
        description: t.description,
      }));
    }),
    executeTool: vi.fn().mockResolvedValue({ success: true, output: {} }),
    shutdownAllTools: vi.fn().mockResolvedValue(undefined),
  } as unknown as ToolExecutor;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolOrchestrator — emergent engine integration', () => {
  let orchestrator: ToolOrchestrator;
  let permissionManager: IToolPermissionManager;
  let toolExecutor: ToolExecutor;

  beforeEach(() => {
    orchestrator = new ToolOrchestrator();
    permissionManager = makeMockPermissionManager();
    toolExecutor = makeMockToolExecutor();
  });

  // -------------------------------------------------------------------------
  // 1. Emergent disabled (default behaviour)
  // -------------------------------------------------------------------------

  it('does NOT register forge_tool when emergent is disabled (default)', async () => {
    await orchestrator.initialize(
      undefined,
      permissionManager,
      toolExecutor,
    );

    const tools = await orchestrator.listAvailableTools();
    const forgeToolDef = tools.find((t) => t.name === 'forge_tool');

    expect(forgeToolDef).toBeUndefined();
  });

  it('returns undefined from getEmergentEngine() when emergent is disabled', async () => {
    await orchestrator.initialize(
      undefined,
      permissionManager,
      toolExecutor,
    );

    expect(orchestrator.getEmergentEngine()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 2. Emergent enabled
  // -------------------------------------------------------------------------

  it('registers forge_tool when emergent is enabled', async () => {
    await orchestrator.initialize(
      undefined,
      permissionManager,
      toolExecutor,
      undefined, // initialTools
      undefined, // hitlManager
      {
        enabled: true,
        generateText: vi.fn().mockResolvedValue('{}'),
      },
    );

    const tools = await orchestrator.listAvailableTools();
    const forgeToolDef = tools.find((t) => t.name === 'forge_tool');

    expect(forgeToolDef).toBeDefined();
    expect(forgeToolDef!.name).toBe('forge_tool');
    expect(forgeToolDef!.description).toContain('Create a new tool');
  });

  it('registers self-improvement tools when enabled and deps are provided', async () => {
    const executeTool = vi.fn(async (name: string, args: unknown) => ({
      name,
      args,
      ok: true,
    }));

    await orchestrator.initialize(
      undefined,
      permissionManager,
      toolExecutor,
      undefined,
      undefined,
      {
        enabled: true,
        config: {
          selfImprovement: {
            enabled: true,
          } as any,
        },
        selfImprovementDeps: {
          getPersonality: () => ({
            openness: 0.5,
            conscientiousness: 0.5,
            emotionality: 0.5,
            extraversion: 0.5,
            agreeableness: 0.5,
            honesty: 0.5,
          }),
          setPersonality: vi.fn(),
          getActiveSkills: () => [],
          getLockedSkills: () => [],
          loadSkill: async (id) => ({ skillId: id, name: id, category: 'test' }),
          unloadSkill: vi.fn(),
          searchSkills: () => [],
          executeTool,
          listTools: () => ['lookup', 'summarize', 'create_workflow'],
        },
      },
    );

    const tools = await orchestrator.listAvailableTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'forge_tool',
        'adapt_personality',
        'manage_skills',
        'create_workflow',
        'self_evaluate',
      ]),
    );

    const workflowTool = await orchestrator.getTool('create_workflow');
    expect(workflowTool).toBeDefined();

    // The workflow's steps resolve to tools that declare no side effects.
    const pureTool = (name: string): ITool => ({
      id: `${name}-v1`,
      name,
      displayName: name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: async () => ({ success: true, output: {} }),
    });
    await toolExecutor.registerTool(pureTool('lookup'));
    await toolExecutor.registerTool(pureTool('summarize'));

    const createResult = await workflowTool!.execute(
      {
        action: 'create',
        name: 'lookup-and-summarize',
        description: 'Look up a topic and summarize it.',
        steps: [
          { tool: 'lookup', args: { query: '$input' } },
          { tool: 'summarize', args: { text: '$prev' } },
        ],
      } as any,
      {
        gmiId: 'agent-1',
        personaId: 'persona-1',
        userContext: { userId: 'user-1' } as any,
        correlationId: 'sess-1',
      },
    );

    expect(createResult.success).toBe(true);

    const runResult = await workflowTool!.execute(
      {
        action: 'run',
        workflowId: createResult.output.workflowId,
        input: 'QUIC',
      } as any,
      {
        gmiId: 'agent-1',
        personaId: 'persona-1',
        userContext: { userId: 'user-1' } as any,
        correlationId: 'sess-1',
      },
    );

    expect(runResult.success).toBe(true);
    expect(executeTool).toHaveBeenNthCalledWith(
      1,
      'lookup',
      { query: 'QUIC' },
      expect.objectContaining({
        correlationId: 'sess-1',
      }),
      expect.any(AbortSignal),
      // The instance the step's check resolved.
      expect.objectContaining({ name: 'lookup' }),
    );
    expect(executeTool).toHaveBeenNthCalledWith(
      2,
      'summarize',
      {
        text: { name: 'lookup', args: { query: 'QUIC' }, ok: true },
      },
      expect.objectContaining({
        correlationId: 'sess-1',
      }),
      expect.any(AbortSignal),
      expect.objectContaining({ name: 'summarize' }),
    );

    const otherSessionList = await workflowTool!.execute(
      { action: 'list' } as any,
      {
        gmiId: 'agent-2',
        personaId: 'persona-2',
        userContext: { userId: 'user-2' } as any,
        correlationId: 'sess-2',
        sessionData: { sessionId: 'sess-2' },
      },
    );

    expect(otherSessionList.success).toBe(true);
    expect(otherSessionList.output.workflows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. Engine is accessible
  // -------------------------------------------------------------------------

  it('returns the EmergentCapabilityEngine from getEmergentEngine()', async () => {
    await orchestrator.initialize(
      undefined,
      permissionManager,
      toolExecutor,
      undefined,
      undefined,
      { enabled: true, config: { allowSandboxTools: true } },
    );

    const engine = orchestrator.getEmergentEngine();
    expect(engine).toBeDefined();
    // Verify it has the expected public methods.
    expect(typeof engine!.forge).toBe('function');
    expect(typeof engine!.cleanupSession).toBe('function');
    expect(typeof engine!.getSessionTools).toBe('function');
  });

  // -------------------------------------------------------------------------
  // 4. Session cleanup delegates correctly
  // -------------------------------------------------------------------------

  it('cleanupEmergentSession is a no-op when emergent is disabled', async () => {
    await orchestrator.initialize(
      undefined,
      permissionManager,
      toolExecutor,
    );

    // Should not throw.
    expect(() => orchestrator.cleanupEmergentSession('sess-abc')).not.toThrow();
  });

  it('cleanupEmergentSession delegates to engine when emergent is enabled', async () => {
    await orchestrator.initialize(
      undefined,
      permissionManager,
      toolExecutor,
      undefined,
      undefined,
      { enabled: true, config: { allowSandboxTools: true } },
    );

    const engine = orchestrator.getEmergentEngine()!;
    const cleanupSpy = vi.spyOn(engine, 'cleanupSession');

    orchestrator.cleanupEmergentSession('sess-xyz');

    expect(cleanupSpy).toHaveBeenCalledWith('sess-xyz');
  });

  // -------------------------------------------------------------------------
  // 5. Custom emergent config is merged with defaults
  // -------------------------------------------------------------------------

  it('merges custom emergentConfig with defaults', async () => {
    await orchestrator.initialize(
      undefined,
      permissionManager,
      toolExecutor,
      undefined,
      undefined,
      {
        enabled: true,
        config: { maxSessionTools: 3, sandboxTimeoutMs: 1000 },
      },
    );

    const engine = orchestrator.getEmergentEngine();
    expect(engine).toBeDefined();
    // Engine exists and forge_tool is registered — config was accepted.
    const tools = await orchestrator.listAvailableTools();
    expect(tools.find((t) => t.name === 'forge_tool')).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 6. No LLM fallback — judge rejects when no generateText is provided
  // -------------------------------------------------------------------------

  it('uses a reject-all judge stub when no generateText callback is provided', async () => {
    await orchestrator.initialize(
      undefined,
      permissionManager,
      toolExecutor,
      undefined,
      undefined,
      { enabled: true, config: { allowSandboxTools: true } },
    );

    const engine = orchestrator.getEmergentEngine()!;

    // Attempt to forge a tool. Since no LLM is configured, the judge should
    // fail and the forge result should indicate failure.
    const result = await engine.forge(
      {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: {} },
        implementation: {
          mode: 'sandbox',
          code: 'function execute(input) { return {}; }',
          allowlist: [],
        },
        testCases: [{ input: {}, expectedOutput: {} }],
      },
      { agentId: 'agent-1', sessionId: 'sess-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/LLM call failed during creation review/i);
    expect(result.verdict?.approved).toBe(false);
  });

  it('registers a forged tool with the orchestrator and removes it on session cleanup', async () => {
    await orchestrator.initialize(
      undefined,
      permissionManager,
      toolExecutor,
      undefined,
      undefined,
      {
        enabled: true,
        config: { allowSandboxTools: true },
        generateText: vi.fn().mockResolvedValue(
          JSON.stringify({
            safety: { passed: true, concerns: [] },
            correctness: { passed: true, failedTests: [] },
            determinism: { likely: true, reasoning: 'deterministic' },
            bounded: { likely: true, reasoning: 'bounded' },
            confidence: 0.91,
            approved: true,
            reasoning: 'safe and correct',
          }),
        ),
      },
    );

    const engine = orchestrator.getEmergentEngine()!;
    const forgeResult = await engine.forge(
      {
        name: 'add_numbers_runtime',
        description: 'Adds two numbers',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
        outputSchema: {
          type: 'object',
          properties: { sum: { type: 'number' } },
          required: ['sum'],
        },
        implementation: {
          mode: 'sandbox',
          code: 'function execute(input) { return { sum: input.a + input.b }; }',
          allowlist: [],
        },
        testCases: [{ input: { a: 2, b: 3 }, expectedOutput: { sum: 5 } }],
      },
      { agentId: 'agent-1', sessionId: 'sess-1' },
    );

    expect(forgeResult.success).toBe(true);

    const forgedTool = await orchestrator.getTool('add_numbers_runtime');
    expect(forgedTool).toBeDefined();

    const execution = await forgedTool!.execute(
      { a: 7, b: 8 },
      {
        gmiId: 'agent-1',
        personaId: 'persona-1',
        userContext: { userId: 'user-1' } as any,
        correlationId: 'sess-1',
      },
    );
    expect(execution.success).toBe(true);
    expect(execution.output).toEqual({ sum: 15 });

    orchestrator.cleanupEmergentSession('sess-1');
    expect(await orchestrator.getTool('add_numbers_runtime')).toBeUndefined();
  });
});
