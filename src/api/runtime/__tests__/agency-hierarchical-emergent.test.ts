/**
 * @fileoverview Integration tests for the emergent extension to the
 * hierarchical strategy: when `agencyConfig.emergent.enabled === true`,
 * the manager gets a `spawn_specialist` tool that mints new sub-agents
 * at runtime via EmergentAgentForge.
 *
 * Tests drive the spawned `spawn_specialist` tool directly through the
 * `buildHierarchicalTools` helper rather than spinning up a manager LLM.
 * This keeps assertions deterministic and fast.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildHierarchicalTools } from '../strategies/hierarchical.js';
import type { AgencyOptions, BaseAgentConfig, ForgeEvent } from '../types.js';

function buildAgencyConfig(overrides: Partial<AgencyOptions> = {}): AgencyOptions {
  return {
    model: 'gpt-4o',
    provider: 'openai',
    agents: {},
    ...overrides,
  } as AgencyOptions;
}

interface SpawnTool {
  execute: (args: {
    role: string;
    instructions: string;
    justification?: string;
  }) => Promise<{ success: boolean; output?: string; error?: string }>;
}

describe('hierarchical strategy with emergent.enabled', () => {
  it('does NOT inject spawn_specialist when emergent is disabled', () => {
    const { tools } = buildHierarchicalTools(
      { researcher: { instructions: 'Find sources.' } as BaseAgentConfig },
      buildAgencyConfig({ emergent: { enabled: false } }),
    );

    expect(Object.keys(tools)).toContain('delegate_to_researcher');
    expect(Object.keys(tools)).not.toContain('spawn_specialist');
  });

  it('injects spawn_specialist when emergent.enabled is true', () => {
    const { tools } = buildHierarchicalTools(
      { researcher: { instructions: 'Find sources.' } as BaseAgentConfig },
      buildAgencyConfig({ emergent: { enabled: true } }),
    );

    expect(Object.keys(tools)).toContain('spawn_specialist');
    expect(Object.keys(tools)).toContain('delegate_to_researcher');
  });

  it('spawn_specialist synthesizes a new agent and adds delegate_to_<role>', async () => {
    const { tools, roster, spawnedCount } = buildHierarchicalTools(
      { researcher: { instructions: 'Find sources.' } as BaseAgentConfig },
      buildAgencyConfig({ emergent: { enabled: true, judge: false } }),
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;
    const result = await spawnTool.execute({
      role: 'fact_checker',
      instructions: 'Verify claims against cited sources.',
    });

    expect(result.success).toBe(true);
    expect(roster.fact_checker).toBeDefined();
    expect(Object.keys(tools)).toContain('delegate_to_fact_checker');
    expect(spawnedCount.value).toBe(1);
  });

  it('respects maxSpecialists cap', async () => {
    const { tools } = buildHierarchicalTools(
      {},
      buildAgencyConfig({
        emergent: {
          enabled: true,
          judge: false,
          planner: { maxSpecialists: 1 },
        },
      }),
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;
    const first = await spawnTool.execute({ role: 'a', instructions: 'X.' });
    const second = await spawnTool.execute({ role: 'b', instructions: 'Y.' });

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(second.output).toMatch(/maxSpecialists|cap/i);
  });

  it('rejects spawn when requireJustification=true and justification missing', async () => {
    const { tools } = buildHierarchicalTools(
      {},
      buildAgencyConfig({
        emergent: {
          enabled: true,
          judge: false,
          planner: { requireJustification: true },
        },
      }),
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;
    const result = await spawnTool.execute({
      role: 'fact_checker',
      instructions: 'Verify.',
    });

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/justification/i);
  });

  it('rejects spawn when role collides with existing roster entry', async () => {
    const { tools } = buildHierarchicalTools(
      { researcher: { instructions: 'Find sources.' } as BaseAgentConfig },
      buildAgencyConfig({ emergent: { enabled: true, judge: false } }),
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;
    const result = await spawnTool.execute({
      role: 'researcher',
      instructions: 'A duplicate.',
    });

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/already exists|delegate_to_researcher/i);
  });

  it('rejects spawn when forge validation fails (reserved role name)', async () => {
    const { tools } = buildHierarchicalTools(
      {},
      buildAgencyConfig({ emergent: { enabled: true, judge: false } }),
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;
    const result = await spawnTool.execute({
      role: 'spawn_specialist', // reserved
      instructions: 'Try to overwrite the spawner.',
    });

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/reserved|forge rejected/i);
  });

  it('emits a ForgeEvent through the emergentForge callback on successful spawn', async () => {
    const events: ForgeEvent[] = [];

    const { tools } = buildHierarchicalTools(
      {},
      buildAgencyConfig({
        emergent: { enabled: true, judge: false },
        on: {
          emergentForge: (e) => {
            events.push(e);
          },
        },
      }),
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;
    await spawnTool.execute({
      role: 'event_test',
      instructions: 'Test agent.',
      justification: 'For the test.',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentName: 'event_test',
      instructions: 'Test agent.',
      approved: true,
    });
    expect(typeof events[0]!.timestamp).toBe('number');
  });

  it('does NOT emit ForgeEvent when forge rejects the spec', async () => {
    const events: ForgeEvent[] = [];

    const { tools } = buildHierarchicalTools(
      {},
      buildAgencyConfig({
        emergent: { enabled: true, judge: false },
        on: { emergentForge: (e) => events.push(e) },
      }),
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;
    await spawnTool.execute({
      role: 'spawn_specialist',
      instructions: 'Reserved name should reject.',
    });

    expect(events).toHaveLength(0);
  });

});

// ----------------------------------------------------------------------------
// Judge gating tests live in a separate describe block so the vi.mock for
// generateText doesn't bleed into the no-judge tests above. vi.hoisted is
// used so the per-test response variable is in scope when the hoisted
// vi.mock factory runs.
// ----------------------------------------------------------------------------

const judgeMocks = vi.hoisted(() => ({
  response: { current: JSON.stringify({ approved: true, reasoning: 'OK' }) },
}));

vi.mock('../../generateText.js', () => ({
  generateText: vi.fn(async () => ({ text: judgeMocks.response.current })),
}));

describe('hierarchical strategy with emergent.enabled — judge gating', () => {
  beforeEach(() => {
    judgeMocks.response.current = JSON.stringify({ approved: true, reasoning: 'OK' });
  });

  it('blocks spawn when emergent.judge=true and the judge returns reject', async () => {
    judgeMocks.response.current = JSON.stringify({
      approved: false,
      reasoning: 'mocked judge rejection — unsafe scope',
    });

    const events: ForgeEvent[] = [];
    const { tools, roster, spawnedCount } = buildHierarchicalTools(
      {},
      buildAgencyConfig({
        emergent: { enabled: true, judge: true },
        on: { emergentForge: (e) => events.push(e) },
      }),
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;
    const result = await spawnTool.execute({
      role: 'rejected_specialist',
      instructions: 'Do something the judge will block.',
    });

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/judge rejected|unsafe scope/i);
    expect(roster.rejected_specialist).toBeUndefined();
    expect(Object.keys(tools)).not.toContain('delegate_to_rejected_specialist');
    expect(spawnedCount.value).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('allows spawn when emergent.judge=true and the judge returns approve', async () => {
    judgeMocks.response.current = JSON.stringify({
      approved: true,
      reasoning: 'mocked judge approval — well-scoped',
    });

    const { tools, roster, spawnedCount } = buildHierarchicalTools(
      {},
      buildAgencyConfig({
        emergent: { enabled: true, judge: true },
      }),
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;
    const result = await spawnTool.execute({
      role: 'approved_specialist',
      instructions: 'Do something the judge will allow.',
    });

    expect(result.success).toBe(true);
    expect(roster.approved_specialist).toBeDefined();
    expect(Object.keys(tools)).toContain('delegate_to_approved_specialist');
    expect(spawnedCount.value).toBe(1);
  });

  it('blocks spawn when hitl.approvals.beforeEmergent rejects', async () => {
    const { tools, roster, spawnedCount } = buildHierarchicalTools(
      {},
      buildAgencyConfig({
        emergent: { enabled: true, judge: false },
        hitl: {
          approvals: { beforeEmergent: true },
          handler: async () => ({ approved: false, reason: 'manual reject for test' }),
        },
      }),
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;
    const result = await spawnTool.execute({
      role: 'hitl_blocked',
      instructions: 'Should be HITL-rejected.',
    });

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/HITL rejected|manual reject/i);
    expect(roster.hitl_blocked).toBeUndefined();
    expect(spawnedCount.value).toBe(0);
  });

  it('allows spawn when hitl.approvals.beforeEmergent approves', async () => {
    const { tools, roster, spawnedCount } = buildHierarchicalTools(
      {},
      buildAgencyConfig({
        emergent: { enabled: true, judge: false },
        hitl: {
          approvals: { beforeEmergent: true },
          handler: async () => ({ approved: true }),
        },
      }),
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;
    const result = await spawnTool.execute({
      role: 'hitl_approved',
      instructions: 'Should pass HITL.',
    });

    expect(result.success).toBe(true);
    expect(roster.hitl_approved).toBeDefined();
    expect(spawnedCount.value).toBe(1);
  });

  it('does not invoke HITL handler when beforeEmergent is not set', async () => {
    const handler = vi.fn(async () => ({ approved: false, reason: 'should not fire' }));

    const { tools } = buildHierarchicalTools(
      {},
      buildAgencyConfig({
        emergent: { enabled: true, judge: false },
        hitl: {
          // beforeEmergent omitted — handler should never be called
          // even though a handler is configured for other approvals
          approvals: { beforeAgent: ['some_other_agent'] },
          handler,
        },
      }),
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;
    await spawnTool.execute({
      role: 'no_hitl',
      instructions: 'Spawn freely.',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('respects maxJudgeCalls cap independently of maxSpecialists', async () => {
    judgeMocks.response.current = JSON.stringify({
      approved: false,
      reasoning: 'mocked rejection so spawnedCount stays 0',
    });

    const { tools, spawnedCount } = buildHierarchicalTools(
      {},
      buildAgencyConfig({
        emergent: {
          enabled: true,
          judge: true,
          planner: { maxSpecialists: 5, maxJudgeCalls: 2 },
        },
      }),
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;

    const first = await spawnTool.execute({ role: 'a', instructions: 'X.' });
    const second = await spawnTool.execute({ role: 'b', instructions: 'Y.' });
    const third = await spawnTool.execute({ role: 'c', instructions: 'Z.' });

    // First two get rejected by the judge (judge ran, judgeCallsUsed reached 2)
    expect(first.success).toBe(false);
    expect(first.output).toMatch(/judge rejected/i);
    expect(second.success).toBe(false);
    expect(second.output).toMatch(/judge rejected/i);
    // Third hits maxJudgeCalls cap before the judge runs
    expect(third.success).toBe(false);
    expect(third.output).toMatch(/maxJudgeCalls|cap/i);
    expect(spawnedCount.value).toBe(0);
  });
});
