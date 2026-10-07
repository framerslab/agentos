/**
 * @fileoverview Integration tests for EmergentCapabilityEngine.
 *
 * Covers:
 *  1. Full compose flow: forge → tests pass → judge approves → registered at session tier
 *  2. Full sandbox flow: forge → sandbox runs → judge approves → registered
 *  3. Rejection flow: judge rejects → tool NOT registered, error returned
 *  4. Sandbox code validation failure: invalid code → not submitted to judge
 *  5. Test case failure: test fails → judge sees failure in results
 *  6. Session cleanup removes forged tools
 *  7. checkPromotion: tool with 5 uses + confidence 0.8 → promotion panel called
 *  8. checkPromotion: tool below threshold → returns null
 *  9. forge() returns error when engine is disabled
 * 10. getSessionTools returns only tools for the requested session
 * 11. getAgentTools delegates to registry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmergentCapabilityEngine } from '../EmergentCapabilityEngine.js';
import { ComposableToolBuilder } from '../ComposableToolBuilder.js';
import { SandboxedToolForge } from '../SandboxedToolForge.js';
import { EmergentJudge } from '../EmergentJudge.js';
import { EmergentToolRegistry } from '../EmergentToolRegistry.js';
import { DEFAULT_SELF_IMPROVEMENT_CONFIG } from '../SelfImprovementConfig.js';
import type {
  EmergentConfig,
  ForgeToolRequest,
  ComposableToolSpec,
  SandboxedToolSpec,
} from '../types.js';
import type { ToolExecutionResult, ToolExecutionContext } from '../../../core/tools/ITool.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid EmergentConfig with sensible test defaults. */
function makeConfig(overrides?: Partial<EmergentConfig>): EmergentConfig {
  return {
    enabled: true,
    maxSessionTools: 10,
    maxAgentTools: 50,
    allowSandboxTools: true,
    persistSandboxSource: false,
    sandboxMemoryMB: 128,
    sandboxTimeoutMs: 5000,
    promotionThreshold: { uses: 5, confidence: 0.8 },
    judgeModel: 'gpt-4o-mini',
    promotionJudgeModel: 'gpt-4o',
    ...overrides,
  };
}

/** Build a compose-mode forge request. */
function makeComposeRequest(overrides?: Partial<ForgeToolRequest>): ForgeToolRequest {
  return {
    name: 'search_and_summarise',
    description: 'Search the web then summarise results.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
    },
    implementation: {
      mode: 'compose',
      steps: [
        { name: 'search', tool: 'web_search', inputMapping: { q: '$input.query' } },
        { name: 'summarise', tool: 'summarise', inputMapping: { text: '$prev.snippet' } },
      ],
    } as ComposableToolSpec,
    testCases: [
      { input: { query: 'quantum computing' }, expectedOutput: { summary: 'A summary.' } },
    ],
    ...overrides,
  };
}

/** Build a sandbox-mode forge request. */
function makeSandboxRequest(overrides?: Partial<ForgeToolRequest>): ForgeToolRequest {
  return {
    name: 'add_numbers',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    outputSchema: {
      type: 'object',
      properties: { sum: { type: 'number' } },
    },
    implementation: {
      mode: 'sandbox',
      code: 'function execute(input) { return { sum: input.a + input.b }; }',
      allowlist: [],
    } as SandboxedToolSpec,
    testCases: [
      { input: { a: 2, b: 3 }, expectedOutput: { sum: 5 } },
    ],
    ...overrides,
  };
}

/** Build an approved CreationVerdict JSON response. */
function approvedVerdictJson(): string {
  return JSON.stringify({
    safety: { passed: true, concerns: [] },
    correctness: { passed: true, failedTests: [] },
    determinism: { likely: true, reasoning: 'Deterministic.' },
    bounded: { likely: true, reasoning: 'Bounded.' },
    confidence: 0.95,
    approved: true,
    reasoning: 'Tool is safe and correct.',
  });
}

/** Build a rejected CreationVerdict JSON response. */
function rejectedVerdictJson(): string {
  return JSON.stringify({
    safety: { passed: false, concerns: ['Unsafe pattern detected.'] },
    correctness: { passed: true, failedTests: [] },
    determinism: { likely: true, reasoning: 'Deterministic.' },
    bounded: { likely: true, reasoning: 'Bounded.' },
    confidence: 0.3,
    approved: false,
    reasoning: 'Tool contains unsafe patterns.',
  });
}

/** Build an approved promotion response. */
function approvedPromotionJson(): string {
  return JSON.stringify({
    approved: true,
    confidence: 0.9,
    reasoning: 'Looks good.',
  });
}

/** Build a rejected promotion response. */
function rejectedPromotionJson(): string {
  return JSON.stringify({
    approved: false,
    confidence: 0.4,
    reasoning: 'Concerns remain.',
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('EmergentCapabilityEngine', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let generateText: any;
  let executeTool: ReturnType<typeof vi.fn>;
  let composableBuilder: ComposableToolBuilder;
  let sandboxForge: SandboxedToolForge;
  let judge: EmergentJudge;
  let registry: EmergentToolRegistry;
  let engine: EmergentCapabilityEngine;

  const agentId = 'agent-42';
  const sessionId = 'sess-abc';

  beforeEach(() => {
    generateText = vi.fn();
    executeTool = vi.fn();

    composableBuilder = new ComposableToolBuilder(executeTool as any);
    sandboxForge = new SandboxedToolForge({ timeoutMs: 3000 });
    judge = new EmergentJudge({
      judgeModel: 'gpt-4o-mini',
      promotionModel: 'gpt-4o',
      generateText,
    });
    registry = new EmergentToolRegistry({ enabled: true, maxSessionTools: 10, maxAgentTools: 50 });

    engine = new EmergentCapabilityEngine({
      config: makeConfig(),
      composableBuilder,
      sandboxForge,
      judge,
      registry,
    });
  });

  // =========================================================================
  // 1. Full compose flow
  // =========================================================================

  it('createSelfImprovementTools wires all four tools and supports session-only personality mode', async () => {
    const personality: Record<string, number> = {
      openness: 0.5,
      conscientiousness: 0.5,
      emotionality: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      honesty: 0.5,
    };

    engine = new EmergentCapabilityEngine({
      config: makeConfig({
        selfImprovement: {
          ...DEFAULT_SELF_IMPROVEMENT_CONFIG,
          enabled: true,
          personality: {
            ...DEFAULT_SELF_IMPROVEMENT_CONFIG.personality,
            persistWithDecay: false,
          },
          selfEval: {
            ...DEFAULT_SELF_IMPROVEMENT_CONFIG.selfEval,
            adjustableParams: ['personality'],
          },
        },
      }),
      composableBuilder,
      sandboxForge,
      judge,
      registry,
    });

    const tools = await engine.createSelfImprovementTools({
      getPersonality: () => personality,
      setPersonality: (trait, value) => {
        personality[trait] = value;
      },
      getActiveSkills: () => [],
      getLockedSkills: () => [],
      loadSkill: async (id) => ({ skillId: id, name: id, category: 'test' }),
      unloadSkill: vi.fn(),
      searchSkills: () => [],
      executeTool: vi.fn().mockResolvedValue({ ok: true }),
      listTools: () => ['web_search', 'summarize'],
    });

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'adapt_personality',
      'create_workflow',
      'manage_skills',
      'self_evaluate',
    ]);

    const selfEvaluate = tools.find((tool) => tool.name === 'self_evaluate')!;
    const adjustResult = await selfEvaluate.execute(
      {
        action: 'adjust',
        param: 'personality',
        value: { trait: 'openness', delta: 0.1 },
      },
      {
        gmiId: agentId,
        personaId: 'persona',
        userContext: { userId: 'user' } as any,
        correlationId: sessionId,
      },
    );

    expect(adjustResult.success).toBe(true);
    expect(personality.openness).toBeCloseTo(0.6);
  });

  it('forge (compose): builds, tests, judges, and registers at session tier', async () => {
    // Mock the executeTool callback for both compose steps.
    executeTool
      .mockResolvedValueOnce({ success: true, output: { snippet: 'Quantum is cool.' } })
      .mockResolvedValueOnce({ success: true, output: { summary: 'A summary.' } });

    // Mock the judge to approve.
    generateText.mockResolvedValueOnce(approvedVerdictJson());

    const result = await engine.forge(makeComposeRequest(), { agentId, sessionId });

    expect(result.success).toBe(true);
    expect(result.toolId).toBeDefined();
    expect(result.toolId).toMatch(/^emergent_/);
    expect(result.tool).toBeDefined();
    expect(result.tool!.name).toBe('search_and_summarise');
    expect(result.tool!.tier).toBe('session');
    expect(result.tool!.createdBy).toBe(agentId);
    expect(result.verdict).toBeDefined();
    expect(result.verdict!.approved).toBe(true);

    // Verify tool is in the registry.
    const registered = registry.get(result.toolId!);
    expect(registered).toBeDefined();
    expect(registered!.tier).toBe('session');
  });

  // =========================================================================
  // 2. Full sandbox flow
  // =========================================================================

  it('forge (sandbox): validates, executes tests, judges, and registers', async () => {
    // Mock the judge to approve.
    generateText.mockResolvedValueOnce(approvedVerdictJson());

    const result = await engine.forge(makeSandboxRequest(), { agentId, sessionId });

    expect(result.success).toBe(true);
    expect(result.toolId).toBeDefined();
    expect(result.tool).toBeDefined();
    expect(result.tool!.name).toBe('add_numbers');
    expect(result.tool!.implementation.mode).toBe('sandbox');

    // Verify it was registered.
    const registered = registry.get(result.toolId!);
    expect(registered).toBeDefined();
  });

  it('forge (sandbox): rejects sandbox mode when sandbox forging is disabled', async () => {
    engine = new EmergentCapabilityEngine({
      config: makeConfig({ allowSandboxTools: false }),
      composableBuilder,
      sandboxForge,
      judge,
      registry,
    });

    const result = await engine.forge(makeSandboxRequest(), { agentId, sessionId });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Sandboxed emergent tools are disabled/i);
    expect(generateText).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 3. Rejection flow
  // =========================================================================

  it('forge: returns failure when judge rejects', async () => {
    // Sandbox test passes but judge rejects.
    generateText.mockResolvedValueOnce(rejectedVerdictJson());

    const result = await engine.forge(makeSandboxRequest(), { agentId, sessionId });

    expect(result.success).toBe(false);
    expect(result.verdict).toBeDefined();
    expect(result.verdict!.approved).toBe(false);
    expect(result.error).toContain('unsafe patterns');

    // No tool should be in the registry (check session tools).
    const sessionTools = registry.getByTier('session');
    expect(sessionTools).toHaveLength(0);
  });

  // =========================================================================
  // 4. Sandbox code validation failure
  // =========================================================================

  it('forge (sandbox): rejects early when code validation fails', async () => {
    const request = makeSandboxRequest({
      implementation: {
        mode: 'sandbox',
        code: 'const x = eval("exploit");', // eval is banned
        allowlist: [],
      },
    });

    const result = await engine.forge(request, { agentId, sessionId });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Code validation failed');
    expect(result.error).toContain('eval');

    // Judge should NOT have been called.
    expect(generateText).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 5. Test case failure visible to judge
  // =========================================================================

  it('forge (compose): test case failure is passed to judge in candidate', async () => {
    // First test case: step fails.
    executeTool.mockResolvedValueOnce({ success: false, error: 'tool not found' });

    // Judge still called — it sees the test failure in the candidate.
    generateText.mockResolvedValueOnce(rejectedVerdictJson());

    const result = await engine.forge(makeComposeRequest(), { agentId, sessionId });

    // Verify judge was called.
    expect(generateText).toHaveBeenCalledTimes(1);

    // The prompt should include the test failure.
    const prompt = generateText.mock.calls[0][1] as string;
    expect(prompt).toContain('success=false');

    expect(result.success).toBe(false);
  });

  // =========================================================================
  // 6. Session cleanup
  // =========================================================================

  it('cleanupSession removes forged tools from registry', async () => {
    // Forge a tool first.
    generateText.mockResolvedValueOnce(approvedVerdictJson());

    const result = await engine.forge(makeSandboxRequest(), { agentId, sessionId });
    expect(result.success).toBe(true);

    // Verify tool exists.
    expect(registry.get(result.toolId!)).toBeDefined();
    expect(engine.getSessionTools(sessionId)).toHaveLength(1);

    // Cleanup.
    engine.cleanupSession(sessionId);

    // Session index should be cleared.
    expect(engine.getSessionTools(sessionId)).toHaveLength(0);
  });

  // =========================================================================
  // 7. checkPromotion: eligible tool → promotion panel called
  // =========================================================================

  it('checkPromotion promotes when threshold met and panel approves', async () => {
    // Forge a tool.
    generateText.mockResolvedValueOnce(approvedVerdictJson());
    const forgeResult = await engine.forge(makeSandboxRequest(), { agentId, sessionId });
    expect(forgeResult.success).toBe(true);
    const toolId = forgeResult.toolId!;

    // Simulate 5 successful uses to meet the threshold.
    for (let i = 0; i < 5; i++) {
      registry.recordUse(toolId, { a: i, b: i }, { sum: i * 2 }, true, 10);
    }

    // Verify stats meet threshold.
    const stats = registry.getUsageStats(toolId);
    expect(stats!.totalUses).toBe(5);
    expect(stats!.confidenceScore).toBe(1.0); // 5/5 success

    // Mock promotion panel — both reviewers approve.
    generateText
      .mockResolvedValueOnce(approvedPromotionJson())
      .mockResolvedValueOnce(approvedPromotionJson());

    const promotion = await engine.checkPromotion(toolId);

    expect(promotion).not.toBeNull();
    expect(promotion!.success).toBe(true);
    expect(promotion!.verdict).toBeDefined();
    expect(promotion!.verdict!.approved).toBe(true);

    // Tool should now be at agent tier.
    const tool = registry.get(toolId);
    expect(tool!.tier).toBe('agent');
  });

  it('checkPromotion leaves a tool whose owner has the reserved instance-id prefix at the session tier', async () => {
    generateText.mockResolvedValueOnce(approvedVerdictJson());
    const forgeResult = await engine.forge(makeSandboxRequest(), { agentId: 'gmi-instance-0b7e3c1a', sessionId });
    expect(forgeResult.success).toBe(true);
    const toolId = forgeResult.toolId!;
    for (let i = 0; i < 5; i++) {
      registry.recordUse(toolId, { a: i, b: i }, { sum: i * 2 }, true, 10);
    }
    const judgeCalls = generateText.mock.calls.length;

    expect(await engine.checkPromotion(toolId)).toBeNull();
    // The panel is not asked, and the tool stays at the session tier.
    expect(generateText.mock.calls.length).toBe(judgeCalls);
    expect(registry.get(toolId)!.tier).toBe('session');
  });

  // =========================================================================
  // 8. checkPromotion: below threshold → returns null
  // =========================================================================

  it('checkPromotion returns null when tool is below threshold', async () => {
    // Forge a tool.
    generateText.mockResolvedValueOnce(approvedVerdictJson());
    const forgeResult = await engine.forge(makeSandboxRequest(), { agentId, sessionId });
    expect(forgeResult.success).toBe(true);

    // Only 2 uses — below threshold of 5.
    registry.recordUse(forgeResult.toolId!, { a: 1, b: 2 }, { sum: 3 }, true, 10);
    registry.recordUse(forgeResult.toolId!, { a: 3, b: 4 }, { sum: 7 }, true, 10);

    const promotion = await engine.checkPromotion(forgeResult.toolId!);

    expect(promotion).toBeNull();

    // Judge should NOT have been called for promotion.
    // The first call was for forge; no additional calls expected.
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // 9. Engine disabled
  // =========================================================================

  it('forge returns error when engine is disabled', async () => {
    const disabledEngine = new EmergentCapabilityEngine({
      config: makeConfig({ enabled: false }),
      composableBuilder,
      sandboxForge,
      judge,
      registry,
    });

    const result = await disabledEngine.forge(makeSandboxRequest(), { agentId, sessionId });

    expect(result.success).toBe(false);
    expect(result.error).toContain('disabled');
  });

  // =========================================================================
  // 10. getSessionTools returns only the requested session's tools
  // =========================================================================

  it('getSessionTools returns tools only for the given session', async () => {
    // Forge tools in two different sessions.
    generateText
      .mockResolvedValueOnce(approvedVerdictJson())
      .mockResolvedValueOnce(approvedVerdictJson());

    const r1 = await engine.forge(makeSandboxRequest(), { agentId, sessionId: 'sess-1' });
    const r2 = await engine.forge(
      makeSandboxRequest({ name: 'multiply_numbers' }),
      { agentId, sessionId: 'sess-2' },
    );

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    expect(engine.getSessionTools('sess-1')).toHaveLength(1);
    expect(engine.getSessionTools('sess-2')).toHaveLength(1);
    expect(engine.getSessionTools('sess-nonexistent')).toHaveLength(0);
  });

  // =========================================================================
  // 11. getAgentTools delegates to registry
  // =========================================================================

  it('getAgentTools returns agent-tier tools', async () => {
    // Initially no agent tools.
    expect(engine.getAgentTools(agentId)).toHaveLength(0);

    // Forge and promote a tool.
    generateText.mockResolvedValueOnce(approvedVerdictJson());
    const forgeResult = await engine.forge(makeSandboxRequest(), { agentId, sessionId });
    expect(forgeResult.success).toBe(true);

    // Simulate uses to meet threshold.
    for (let i = 0; i < 5; i++) {
      registry.recordUse(forgeResult.toolId!, { a: i, b: i }, { sum: i * 2 }, true, 10);
    }

    // Promote.
    generateText
      .mockResolvedValueOnce(approvedPromotionJson())
      .mockResolvedValueOnce(approvedPromotionJson());

    await engine.checkPromotion(forgeResult.toolId!);

    const agentTools = engine.getAgentTools(agentId);
    expect(agentTools).toHaveLength(1);
    expect(agentTools[0].name).toBe('add_numbers');
  });

  // =========================================================================
  // 12. checkPromotion returns null for unknown tool
  // =========================================================================

  it('checkPromotion returns null for unknown tool ID', async () => {
    const result = await engine.checkPromotion('nonexistent-id');
    expect(result).toBeNull();
  });

  // =========================================================================
  // 13. checkPromotion returns rejection when panel rejects
  // =========================================================================

  it('checkPromotion returns failure when promotion panel rejects', async () => {
    // Forge a tool.
    generateText.mockResolvedValueOnce(approvedVerdictJson());
    const forgeResult = await engine.forge(makeSandboxRequest(), { agentId, sessionId });
    expect(forgeResult.success).toBe(true);
    const toolId = forgeResult.toolId!;

    // Meet threshold.
    for (let i = 0; i < 5; i++) {
      registry.recordUse(toolId, { a: i, b: i }, { sum: i * 2 }, true, 10);
    }

    // Promotion panel rejects.
    generateText
      .mockResolvedValueOnce(rejectedPromotionJson())
      .mockResolvedValueOnce(rejectedPromotionJson());

    const promotion = await engine.checkPromotion(toolId);

    expect(promotion).not.toBeNull();
    expect(promotion!.success).toBe(false);
    expect(promotion!.verdict!.approved).toBe(false);

    // Tool should remain at session tier.
    const tool = registry.get(toolId);
    expect(tool!.tier).toBe('session');
  });

  // =========================================================================
  // 14. Tool with failed validation should NOT be promoted
  // =========================================================================

  it('does not promote a tool when output validation fails despite high use count', async () => {
    // Forge a tool whose outputSchema expects { sum: number } with minimum 0.
    generateText.mockResolvedValueOnce(approvedVerdictJson());

    const request = makeSandboxRequest({
      outputSchema: {
        type: 'object',
        properties: { sum: { type: 'number', minimum: 0 } },
        required: ['sum'],
      },
    });

    const forgeResult = await engine.forge(request, { agentId, sessionId });
    expect(forgeResult.success).toBe(true);
    const toolId = forgeResult.toolId!;

    // Create an executable tool wrapper (this is what tracks usage + promotion).
    const executable = engine.createExecutableTool(forgeResult.tool!);
    const mockContext: ToolExecutionContext = {
      gmiId: agentId,
      personaId: 'test',
      userContext: { userId: 'system' } as any,
      correlationId: sessionId,
    };

    // Simulate 6 uses that succeed at execution but produce schema-invalid output.
    // The sandbox returns { sum: -1 } which violates minimum: 0.
    for (let i = 0; i < 6; i++) {
      await executable.execute({ a: -5, b: 4 }, mockContext);
    }

    // Even though we had 6 uses, all had validation failures so success rate = 0.
    // The promotion panel should never have been called (only the 1 forge call).
    // forge = 1 call. Promotion panel = 0 calls.
    expect(generateText).toHaveBeenCalledTimes(1);

    // Tool should still be at session tier.
    const tool = registry.get(toolId);
    expect(tool!.tier).toBe('session');
  });

  // =========================================================================
  // 15. Two concurrent forge requests for same name don't create duplicates
  // =========================================================================

  it('concurrent forge requests for same name create separate tool IDs', async () => {
    // Both forge calls should complete without colliding on tool IDs because
    // IDs include timestamps and random suffixes.
    generateText
      .mockResolvedValueOnce(approvedVerdictJson())
      .mockResolvedValueOnce(approvedVerdictJson());

    const [r1, r2] = await Promise.all([
      engine.forge(makeSandboxRequest(), { agentId, sessionId: 'sess-concurrent-1' }),
      engine.forge(makeSandboxRequest(), { agentId, sessionId: 'sess-concurrent-2' }),
    ]);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    // Tool IDs should be distinct.
    expect(r1.toolId).not.toBe(r2.toolId);

    // Both should be registered.
    expect(registry.get(r1.toolId!)).toBeDefined();
    expect(registry.get(r2.toolId!)).toBeDefined();
  });
});
