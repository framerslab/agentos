/**
 * @file mission-integration.test.ts
 * @description End-to-end integration test: plan → assign → expand pipeline.
 */
import { describe, it, expect, vi } from 'vitest';
import { MissionPlanner } from '../planning/MissionPlanner.js';
import { ProviderAssignmentEngine } from '../planning/ProviderAssignmentEngine.js';
import { GraphExpander } from '../planning/GraphExpander.js';
import { DEFAULT_THRESHOLDS } from '../planning/types.js';
import type { PlannerConfig, GraphPatch } from '../planning/types.js';
import { RequestExpansionTool } from '../tools/RequestExpansionTool.js';
import { ManageGraphTool } from '../tools/ManageGraphTool.js';

describe('Mission Orchestrator Integration', () => {
  it('plans a mission, assigns providers, expands the graph, and tools work', async () => {
    // -----------------------------------------------------------------------
    // Mock LLM responses for the three planning phases
    // -----------------------------------------------------------------------

    const branchResponse = JSON.stringify({
      strategy: 'parallel',
      summary: 'Parallel research with merge',
      nodes: [
        {
          id: 'researcher_1',
          type: 'gmi',
          role: 'Researcher 1',
          executorConfig: { type: 'gmi', instructions: 'Research topic A' },
          complexity: 0.7,
          estimatedTokens: 2000,
        },
        {
          id: 'researcher_2',
          type: 'gmi',
          role: 'Researcher 2',
          executorConfig: { type: 'gmi', instructions: 'Research topic B' },
          complexity: 0.7,
          estimatedTokens: 2000,
        },
        {
          id: 'merger',
          type: 'gmi',
          role: 'Merger',
          executorConfig: { type: 'gmi', instructions: 'Merge findings' },
          complexity: 0.3,
          estimatedTokens: 500,
        },
      ],
      edges: [
        { source: '__START__', target: 'researcher_1', type: 'static' },
        { source: '__START__', target: 'researcher_2', type: 'static' },
        { source: 'researcher_1', target: 'merger', type: 'static' },
        { source: 'researcher_2', target: 'merger', type: 'static' },
        { source: 'merger', target: '__END__', type: 'static' },
      ],
      estimatedCost: 2.0,
      estimatedLatencyMs: 90000,
    });

    const evalResponse = JSON.stringify({
      evaluations: [
        {
          branchId: 'branch_0',
          scores: {
            feasibility: 0.9,
            costEfficiency: 0.7,
            latency: 0.8,
            robustness: 0.6,
            overall: 0.75,
          },
          reasoning: 'Good parallel approach',
        },
      ],
      recommendation: { selectedBranchId: 'branch_0', reason: 'Only candidate' },
    });

    const refineResponse = JSON.stringify({
      refinements: [],
      toolGaps: [],
      finalEstimatedCost: 2.0,
      finalEstimatedLatencyMs: 90000,
    });

    let callIndex = 0;
    const llmCaller = vi.fn(async () => {
      const responses = [
        branchResponse,
        branchResponse,
        branchResponse,
        evalResponse,
        refineResponse,
      ];
      return responses[callIndex++] ?? '{}';
    });

    const plannerConfig: PlannerConfig = {
      branchCount: 3,
      autonomy: 'guardrailed',
      providerStrategy: { strategy: 'balanced' },
      thresholds: { ...DEFAULT_THRESHOLDS },
      costCap: 10.0,
      maxAgents: 10,
      maxToolForges: 5,
      maxExpansions: 8,
      maxDepth: 3,
      reevalInterval: 3,
      llmCaller,
    };

    // -----------------------------------------------------------------------
    // Phase 1-3: Plan
    // -----------------------------------------------------------------------

    const planner = new MissionPlanner(plannerConfig);
    const events: Array<{ type: string }> = [];
    const result = await planner.plan(
      'Research AI frameworks and compare them',
      {
        tools: [{ name: 'web_search', description: 'Search the web' }],
        providers: ['openai', 'anthropic'],
      },
      (e) => events.push(e),
    );

    expect(result.compiledGraph.nodes.length).toBe(3);
    expect(events.some((e) => e.type === 'mission:planning_start')).toBe(true);
    expect(events.some((e) => e.type === 'mission:graph_compiled')).toBe(true);
    expect(result.selectedBranch.providerAssignments).toHaveLength(3);
    expect(result.compiledGraph.nodes.every((node) => node.llm)).toBe(true);

    // -----------------------------------------------------------------------
    // Provider assignment
    // -----------------------------------------------------------------------

    const engine = new ProviderAssignmentEngine(['openai', 'anthropic']);
    const nodesWithComplexity = result.compiledGraph.nodes.map((n) => ({
      ...n,
      complexity: n.id === 'merger' ? 0.2 : 0.7,
    }));
    const assignments = engine.assign(nodesWithComplexity, { strategy: 'balanced' });

    expect(assignments).toHaveLength(3);
    const merger = assignments.find((a) => a.nodeId === 'merger')!;
    expect(merger.model).toBe('gpt-4o-mini');

    const researcher = assignments.find((a) => a.nodeId === 'researcher_1')!;
    expect(researcher.provider).toBe('anthropic');
    expect(researcher.model).toBe('claude-sonnet-4-6');

    // Availability check
    const availability = engine.checkAvailability(assignments);
    expect(availability.available).toBe(true);

    // -----------------------------------------------------------------------
    // Graph expansion
    // -----------------------------------------------------------------------

    const expander = new GraphExpander({ ...DEFAULT_THRESHOLDS });
    const patch: GraphPatch = {
      addNodes: [
        {
          id: 'fact_checker',
          type: 'gmi',
          executorConfig: { type: 'gmi', instructions: 'Verify claims' },
          executionMode: 'single_turn',
          effectClass: 'read',
          checkpoint: 'after',
        },
      ],
      addEdges: [{ id: 'e_new', source: 'merger', target: 'fact_checker', type: 'static' }],
      reason: 'Need fact verification after merge',
      estimatedCostDelta: 0.5,
      estimatedLatencyDelta: 30000,
    };

    // Guardrailed mode: should auto-approve (below all thresholds)
    const shouldApprove = expander.shouldAutoApprove('guardrailed', {
      currentCost: 2.0,
      currentAgentCount: 3,
      currentExpansions: 0,
      currentToolForges: 0,
      patchCostDelta: 0.5,
      patchAgentDelta: 1,
    });
    expect(shouldApprove).toBe(true);

    const expanded = expander.applyPatch(result.compiledGraph, patch);
    expect(expanded.nodes.length).toBe(4);
    expect(expanded.nodes.find((n) => n.id === 'fact_checker')).toBeDefined();
    expect(expanded.edges.find((e) => e.source === 'merger' && e.target === 'fact_checker')).toBeDefined();

    // -----------------------------------------------------------------------
    // Expansion tools
    // -----------------------------------------------------------------------

    const requestTool = new RequestExpansionTool();
    const requestResult = await requestTool.execute(
      { need: 'Web scraper for changelog parsing', urgency: 'blocking' },
      { gmiId: 'gmi-1', personaId: 'p-1', userContext: {} as any },
    );
    expect(requestResult.success).toBe(true);
    expect(requestResult.output?.acknowledged).toBe(true);

    const manageTool = new ManageGraphTool();
    const manageResult = await manageTool.execute(
      {
        action: 'spawn_agent',
        spec: { role: 'fact_checker', instructions: 'Verify all claims' },
        reason: 'Quality assurance needed',
      },
      { gmiId: 'gmi-1', personaId: 'p-1', userContext: {} as any },
    );
    expect(manageResult.success).toBe(true);
    expect(manageResult.output?.acknowledged).toBe(true);
  });

  it('blocks expansion when guardrail thresholds are exceeded', () => {
    const expander = new GraphExpander({
      ...DEFAULT_THRESHOLDS,
      maxTotalCost: 5.0,
      maxAgentCount: 4,
    });

    // Cost exceeds cap
    expect(
      expander.shouldAutoApprove('guardrailed', {
        currentCost: 4.8,
        currentAgentCount: 2,
        currentExpansions: 0,
        currentToolForges: 0,
        patchCostDelta: 0.5,
        patchAgentDelta: 1,
      }),
    ).toBe(false);

    const exceeded = expander.getExceededThreshold({
      currentCost: 4.8,
      currentAgentCount: 2,
      currentExpansions: 0,
      currentToolForges: 0,
      patchCostDelta: 0.5,
      patchAgentDelta: 1,
    });
    expect(exceeded?.threshold).toBe('maxTotalCost');

    // Agent count exceeds cap
    expect(
      expander.shouldAutoApprove('guardrailed', {
        currentCost: 1.0,
        currentAgentCount: 4,
        currentExpansions: 0,
        currentToolForges: 0,
        patchCostDelta: 0.5,
        patchAgentDelta: 1,
      }),
    ).toBe(false);

    // Autonomous mode ignores thresholds
    expect(
      expander.shouldAutoApprove('autonomous', {
        currentCost: 999,
        currentAgentCount: 999,
        currentExpansions: 999,
        currentToolForges: 999,
        patchCostDelta: 999,
        patchAgentDelta: 999,
      }),
    ).toBe(true);
  });
});
