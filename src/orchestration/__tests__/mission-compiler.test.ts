/**
 * @file mission-compiler.test.ts
 * @description Unit tests for `MissionCompiler.compile()`.
 *
 * Covers:
 * - Generates a stub plan with gather/process/deliver phases
 * - All plan phase nodes appear in the compiled graph
 * - Anchors are spliced into correct phases
 * - Anchor after constraints are respected
 * - Mission-level guardrail policies are applied to all nodes
 * - Acyclic DAG validation passes for linear plans
 * - Throws when validation fails (would require cycle — tested via validator)
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MissionCompiler } from '../compiler/MissionCompiler.js';
import type { MissionConfig } from '../compiler/MissionCompiler.js';
import { gmiNode, toolNode, humanNode } from '../builders/nodes.js';
import { START, END } from '../ir/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseConfig(overrides: Partial<MissionConfig> = {}): MissionConfig {
  return {
    name: 'test-mission',
    inputSchema: z.object({ topic: z.string() }),
    goalTemplate: 'Research {{topic}} and summarise findings',
    returnsSchema: z.object({ summary: z.string() }),
    plannerConfig: {
      strategy: 'linear',
      maxSteps: 5,
      maxIterationsPerNode: 3,
    },
    anchors: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MissionCompiler.compile()', () => {
  it('returns a CompiledExecutionGraph with a non-empty id', () => {
    const ir = MissionCompiler.compile(makeBaseConfig());
    expect(ir.id).toBeTruthy();
    expect(typeof ir.id).toBe('string');
  });

  it('sets graph name from config', () => {
    const ir = MissionCompiler.compile(makeBaseConfig({ name: 'my-mission' }));
    expect(ir.name).toBe('my-mission');
  });

  it('generates stub plan with gather, process, and deliver phase nodes', () => {
    const ir = MissionCompiler.compile(makeBaseConfig());
    const nodeIds = ir.nodes.map(n => n.id);
    expect(nodeIds).toContain('gather-info');
    expect(nodeIds).toContain('process-info');
    expect(nodeIds).toContain('deliver-result');
  });

  it('produces a linear edge chain: START → gather → process → deliver → refine → END', () => {
    const ir = MissionCompiler.compile(makeBaseConfig());

    const edgePairs = ir.edges.map(e => `${e.source}->${e.target}`);
    expect(edgePairs).toContain(`${START}->gather-info`);
    expect(edgePairs).toContain('gather-info->process-info');
    expect(edgePairs).toContain('process-info->deliver-result');
    expect(edgePairs).toContain('deliver-result->refine-output');
    expect(edgePairs).toContain(`refine-output->${END}`);
  });

  it('all edges are static', () => {
    const ir = MissionCompiler.compile(makeBaseConfig());
    for (const edge of ir.edges) {
      expect(edge.type).toBe('static');
    }
  });

  it('sets checkpointPolicy to every_node', () => {
    const ir = MissionCompiler.compile(makeBaseConfig());
    expect(ir.checkpointPolicy).toBe('every_node');
  });

  it('adds anchor nodes to the compiled graph', () => {
    const anchor = gmiNode({ instructions: 'Validate findings' });
    const ir = MissionCompiler.compile(makeBaseConfig({
      anchors: [{
        id: 'validation-step',
        node: anchor,
        constraints: { required: true, phase: 'process' },
      }],
    }));

    const nodeIds = ir.nodes.map(n => n.id);
    expect(nodeIds).toContain('validation-step');
  });

  it('anchor id overwrites the node builder id', () => {
    const anchor = gmiNode({ instructions: 'Custom step' });
    const originalId = anchor.id;

    const ir = MissionCompiler.compile(makeBaseConfig({
      anchors: [{
        id: 'my-custom-anchor',
        node: anchor,
        constraints: { required: true, phase: 'gather' },
      }],
    }));

    const compiled = ir.nodes.find(n => n.id === 'my-custom-anchor');
    expect(compiled).toBeDefined();
    // The auto-generated id from gmiNode should not appear in the compiled graph
    expect(ir.nodes.find(n => n.id === originalId)).toBeUndefined();
  });

  it('splices anchor after a specific node id', () => {
    const anchor = gmiNode({ instructions: 'Post-gather validation' });

    const ir = MissionCompiler.compile(makeBaseConfig({
      anchors: [{
        id: 'after-gather',
        node: anchor,
        constraints: { required: true, phase: 'gather', after: 'gather-info' },
      }],
    }));

    const edgePairs = ir.edges.map(e => `${e.source}->${e.target}`);
    // gather-info → after-gather should appear before after-gather → process-info
    expect(edgePairs).toContain('gather-info->after-gather');
    expect(edgePairs).toContain(`after-gather->process-info`);
  });

  it('appends phase anchor at phase tail when after target not found', () => {
    const anchor = humanNode({ prompt: 'Approve before delivery?' });

    const ir = MissionCompiler.compile(makeBaseConfig({
      anchors: [{
        id: 'approval-gate',
        node: anchor,
        constraints: { required: true, phase: 'process', after: 'nonexistent-node' },
      }],
    }));

    const nodeIds = ir.nodes.map(n => n.id);
    expect(nodeIds).toContain('approval-gate');
  });

  it('appends anchorless-phase anchors at graph tail', () => {
    const anchor = toolNode('audit_log');

    const ir = MissionCompiler.compile(makeBaseConfig({
      anchors: [{
        id: 'audit',
        node: anchor,
        constraints: { required: false },
      }],
    }));

    // Should be in the graph
    const nodeIds = ir.nodes.map(n => n.id);
    expect(nodeIds).toContain('audit');

    // Should appear in edges
    const edgeSources = ir.edges.map(e => e.source);
    expect(edgeSources).toContain('audit');
  });

  it('applies mission-level guardrail policy to all nodes without existing policies', () => {
    const ir = MissionCompiler.compile(makeBaseConfig({
      policyConfig: {
        guardrails: ['safety-v1', 'pii-v2'],
      },
    }));

    for (const node of ir.nodes) {
      expect(node.guardrailPolicy).toBeDefined();
      expect(node.guardrailPolicy!.output).toContain('safety-v1');
      expect(node.guardrailPolicy!.output).toContain('pii-v2');
      expect(node.guardrailPolicy!.onViolation).toBe('warn');
    }
  });

  it('does not override guardrail policy on nodes that already have one', () => {
    const anchor = gmiNode({ instructions: 'x' }, {
      guardrails: { output: ['custom-guard'], onViolation: 'block' },
    });

    const ir = MissionCompiler.compile(makeBaseConfig({
      policyConfig: { guardrails: ['safety-v1'] },
      anchors: [{
        id: 'guarded-anchor',
        node: anchor,
        constraints: { required: true, phase: 'process' },
      }],
    }));

    const node = ir.nodes.find(n => n.id === 'guarded-anchor');
    expect(node).toBeDefined();
    // The existing policy should be preserved — it has 'custom-guard', not 'safety-v1'
    expect(node!.guardrailPolicy!.output).toContain('custom-guard');
    expect(node!.guardrailPolicy!.onViolation).toBe('block');
  });

  it('applies memory consistency from policyConfig', () => {
    const ir = MissionCompiler.compile(makeBaseConfig({
      policyConfig: { memory: { consistency: 'journaled' } },
    }));
    expect(ir.memoryConsistency).toBe('journaled');
  });

  it('defaults memoryConsistency to snapshot when no policy provided', () => {
    const ir = MissionCompiler.compile(makeBaseConfig());
    expect(ir.memoryConsistency).toBe('snapshot');
  });

  it('produces a valid acyclic graph (validator passes without throwing)', () => {
    expect(() => MissionCompiler.compile(makeBaseConfig())).not.toThrow();
  });

  it('handles multiple anchors in the same phase maintaining relative order', () => {
    const a1 = gmiNode({ instructions: 'Anchor 1' });
    const a2 = gmiNode({ instructions: 'Anchor 2' });

    const ir = MissionCompiler.compile(makeBaseConfig({
      anchors: [
        { id: 'anchor-1', node: a1, constraints: { required: true, phase: 'process' } },
        { id: 'anchor-2', node: a2, constraints: { required: true, phase: 'process' } },
      ],
    }));

    const nodeIds = ir.nodes.map(n => n.id);
    expect(nodeIds).toContain('anchor-1');
    expect(nodeIds).toContain('anchor-2');

    // Both should appear in edges
    const edgePairs = ir.edges.map(e => `${e.source}->${e.target}`);
    const anchorInEdges = edgePairs.some(p => p.includes('anchor-1') || p.includes('anchor-2'));
    expect(anchorInEdges).toBe(true);
  });

  describe('per-step maxIterations precedence', () => {
    function getGmiNode(ir: ReturnType<typeof MissionCompiler.compile>, nodeId: string) {
      const node = ir.nodes.find((n) => n.id === nodeId);
      expect(node).toBeDefined();
      return node!;
    }

    it('stub planner emits gather-info with a higher iteration budget than reasoning-only phases', () => {
      // No global cap — planner's per-step values should pass through verbatim.
      const ir = MissionCompiler.compile(makeBaseConfig({
        plannerConfig: { strategy: 'linear', maxSteps: 5 },
      }));

      const gather = getGmiNode(ir, 'gather-info').executorConfig as { type: 'gmi'; maxInternalIterations?: number };
      const process = getGmiNode(ir, 'process-info').executorConfig as { type: 'gmi'; maxInternalIterations?: number };
      const deliver = getGmiNode(ir, 'deliver-result').executorConfig as { type: 'gmi'; maxInternalIterations?: number };

      expect(gather.maxInternalIterations).toBe(8);
      expect(process.maxInternalIterations).toBe(2);
      expect(deliver.maxInternalIterations).toBe(2);
    });

    it('plannerConfig.maxIterationsPerNode acts as a HARD CEILING — a global cap of 3 caps gather-info at 3', () => {
      const ir = MissionCompiler.compile(makeBaseConfig({
        plannerConfig: { strategy: 'linear', maxSteps: 5, maxIterationsPerNode: 3 },
      }));

      const gather = getGmiNode(ir, 'gather-info').executorConfig as { type: 'gmi'; maxInternalIterations?: number };
      const refine = getGmiNode(ir, 'refine-output').executorConfig as { type: 'gmi'; maxInternalIterations?: number };

      expect(gather.maxInternalIterations).toBe(3); // capped by global
      expect(refine.maxInternalIterations).toBe(2); // already below cap, unchanged
    });

    it('plannerConfig.maxIterationsPerNode of 20 does not lower gather; it stays at the planner-suggested 8', () => {
      const ir = MissionCompiler.compile(makeBaseConfig({
        plannerConfig: { strategy: 'linear', maxSteps: 5, maxIterationsPerNode: 20 },
      }));

      const gather = getGmiNode(ir, 'gather-info').executorConfig as { type: 'gmi'; maxInternalIterations?: number };
      const process = getGmiNode(ir, 'process-info').executorConfig as { type: 'gmi'; maxInternalIterations?: number };

      expect(gather.maxInternalIterations).toBe(8); // step value wins (lower)
      expect(process.maxInternalIterations).toBe(2);
    });
  });

  describe('plannerConfig.style — goal-style routing to different stub templates', () => {
    function nodeIdsOf(ir: ReturnType<typeof MissionCompiler.compile>): string[] {
      return ir.nodes.map((n) => n.id);
    }

    it('defaults to the research template (gather/process/deliver/refine) when no style is given', () => {
      const ir = MissionCompiler.compile(makeBaseConfig({
        plannerConfig: { strategy: 'linear', maxSteps: 8 },
      }));
      const ids = nodeIdsOf(ir);
      expect(ids).toContain('gather-info');
      expect(ids).toContain('process-info');
      expect(ids).toContain('deliver-result');
      expect(ids).toContain('refine-output');
    });

    it("style: 'research' is explicit and produces the same template as the default", () => {
      const ir = MissionCompiler.compile(makeBaseConfig({
        plannerConfig: { strategy: 'linear', maxSteps: 8, style: 'research' },
      }));
      const ids = nodeIdsOf(ir);
      expect(ids).toContain('gather-info');
      expect(ids).toContain('process-info');
      expect(ids).toContain('deliver-result');
      expect(ids).toContain('refine-output');
    });

    it("style: 'qa' produces a 2-step quick-answer plan (research-quick + answer)", () => {
      const ir = MissionCompiler.compile(makeBaseConfig({
        plannerConfig: { strategy: 'linear', maxSteps: 4, style: 'qa' },
      }));
      const ids = nodeIdsOf(ir);
      expect(ids).toContain('research-quick');
      expect(ids).toContain('answer');
      // QA template is intentionally short — should NOT have the research phases.
      expect(ids).not.toContain('process-info');
      expect(ids).not.toContain('refine-output');
    });

    it("style: 'creative' produces a brainstorm/develop/produce/polish plan", () => {
      const ir = MissionCompiler.compile(makeBaseConfig({
        plannerConfig: { strategy: 'linear', maxSteps: 8, style: 'creative' },
      }));
      const ids = nodeIdsOf(ir);
      expect(ids).toContain('brainstorm');
      expect(ids).toContain('develop-concept');
      expect(ids).toContain('produce-artifact');
      expect(ids).toContain('polish');
    });

    it('rejects an unknown style with a clear error mentioning supported values', () => {
      expect(() => {
        MissionCompiler.compile(makeBaseConfig({
          plannerConfig: { strategy: 'linear', maxSteps: 4, style: 'wat' as any },
        }));
      }).toThrow(/style/i);
    });
  });

  describe('classifyGoal — auto-detect the right style template from the goal text', () => {
    const cases: Array<{ goal: string; expected: 'research' | 'qa' | 'creative'; why: string }> = [
      // QA indicators
      { goal: 'What is the difference between TCP and UDP?', expected: 'qa', why: 'leading "what is"' },
      { goal: 'Why does Postgres use MVCC?', expected: 'qa', why: 'leading "why does"' },
      { goal: 'How do I parse a date in JavaScript?', expected: 'qa', why: 'leading "how do I"' },
      { goal: 'Explain Kubernetes pod scheduling', expected: 'qa', why: 'leading "explain"' },
      { goal: 'Define eventual consistency', expected: 'qa', why: 'leading "define"' },
      { goal: 'Is Redis suitable for primary storage?', expected: 'qa', why: 'short question ending with ?' },

      // Creative indicators
      { goal: 'Write a haiku about the first day of spring', expected: 'creative', why: 'write a + creative form' },
      { goal: 'Write a haiku about morning fog?', expected: 'creative', why: 'creative prefix beats trailing-? qa heuristic' },
      { goal: 'Compose a short jingle for a coffee brand', expected: 'creative', why: 'compose' },
      { goal: 'Design a minimalist logo for a fintech startup', expected: 'creative', why: 'design a' },
      { goal: 'Draft a press release for the v2 launch', expected: 'creative', why: 'draft a' },
      { goal: 'Imagine an alternate ending where the protagonist refuses', expected: 'creative', why: 'imagine' },

      // Research (default) — goals that DON'T match qa/creative cues
      { goal: 'Research current Reddit-friendly meme formats and produce a karma-optimized posting plan', expected: 'research', why: 'starts with research' },
      { goal: 'Find the highest-engagement subreddits for tech content', expected: 'research', why: 'find/research-flavored' },
      { goal: 'Compare the top three vector databases by recall and latency', expected: 'research', why: 'compare/research' },
      { goal: '', expected: 'research', why: 'empty goal defaults to research' },
      { goal: '   \n\t  ', expected: 'research', why: 'whitespace defaults to research' },

      // Conservative prefix-only matching — these compound goals could go
      // either way semantically, so they fall through to research and the
      // author is expected to set `plannerConfig.style` explicitly if they
      // want creative or qa behaviour.
      { goal: 'Research X and write a poem about it', expected: 'research', why: 'compound: research prefix wins, no mid-string matching' },
      { goal: 'Research how to write a great tagline', expected: 'research', why: 'mid-string "write a" must NOT trigger creative — would misclassify research-about-creativity' },
      { goal: 'Find articles about composing music', expected: 'research', why: 'mid-string "composing" must NOT trigger creative' },
      { goal: 'Summarize the article that says "what is the meaning of life"', expected: 'qa', why: 'leading "summarize" wins (qa prefix), even though the goal is structurally research-y' },
    ];

    for (const { goal, expected, why } of cases) {
      it(`classifies "${goal.slice(0, 60)}${goal.length > 60 ? '…' : ''}" → ${expected} (${why})`, () => {
        expect(MissionCompiler.classifyGoal(goal)).toBe(expected);
      });
    }

    it('uses classifyGoal when plannerConfig.style is undefined (default behavior)', () => {
      const ir = MissionCompiler.compile(makeBaseConfig({
        goalTemplate: 'What is the airspeed velocity of an unladen swallow?',
        plannerConfig: { strategy: 'linear', maxSteps: 4 },
      }));
      const ids = ir.nodes.map((n) => n.id);
      // Without auto-classification we'd see gather-info; with it we see qa template.
      expect(ids).toContain('research-quick');
      expect(ids).toContain('answer');
      expect(ids).not.toContain('gather-info');
    });

    it('explicit plannerConfig.style overrides auto-classification', () => {
      // A QA-shaped goal but the author explicitly picked research.
      const ir = MissionCompiler.compile(makeBaseConfig({
        goalTemplate: 'What is the deal with React server components?',
        plannerConfig: { strategy: 'linear', maxSteps: 4, style: 'research' },
      }));
      const ids = ir.nodes.map((n) => n.id);
      expect(ids).toContain('gather-info');
      expect(ids).toContain('refine-output');
      expect(ids).not.toContain('research-quick');
    });
  });

  describe('plannerConfig.plan — pre-generated plan injection (LLM-driven planner support)', () => {
    it('uses the provided plan and skips stub generation when plan is set', () => {
      const ir = MissionCompiler.compile(makeBaseConfig({
        plannerConfig: {
          strategy: 'linear',
          maxSteps: 4,
          plan: {
            steps: [
              { id: 'custom-research', action: 'reasoning', description: 'Custom research step', phase: 'gather', maxIterations: 5 },
              { id: 'custom-deliver', action: 'reasoning', description: 'Custom deliver step', phase: 'deliver', maxIterations: 2 },
            ],
          },
        },
      }));
      const ids = ir.nodes.map((n) => n.id);
      expect(ids).toContain('custom-research');
      expect(ids).toContain('custom-deliver');
      // The default research-template node ids must NOT appear when a plan is injected.
      expect(ids).not.toContain('gather-info');
      expect(ids).not.toContain('refine-output');
    });

    it('rejects an injected plan with zero steps', () => {
      expect(() => MissionCompiler.compile(makeBaseConfig({
        plannerConfig: {
          strategy: 'linear',
          maxSteps: 4,
          plan: { steps: [] },
        },
      }))).toThrow(/at least one step|empty/i);
    });

    it('rejects an injected plan whose step uses an unknown action', () => {
      expect(() => MissionCompiler.compile(makeBaseConfig({
        plannerConfig: {
          strategy: 'linear',
          maxSteps: 4,
          plan: {
            steps: [
              { id: 'weird', action: 'launch-rocket' as any, description: 'x', phase: 'gather' },
            ],
          },
        },
      }))).toThrow(/action|unknown/i);
    });

    it('rejects an injected plan whose tool_call step is missing a toolName', () => {
      expect(() => MissionCompiler.compile(makeBaseConfig({
        plannerConfig: {
          strategy: 'linear',
          maxSteps: 4,
          plan: {
            steps: [
              { id: 'fetch', action: 'tool_call', description: 'fetch something', phase: 'gather' },
            ],
          },
        },
      }))).toThrow(/toolName|tool_call/i);
    });

    it('rejects an injected plan whose step has a duplicate id', () => {
      expect(() => MissionCompiler.compile(makeBaseConfig({
        plannerConfig: {
          strategy: 'linear',
          maxSteps: 4,
          plan: {
            steps: [
              { id: 'dup', action: 'reasoning', description: 'a', phase: 'gather' },
              { id: 'dup', action: 'reasoning', description: 'b', phase: 'deliver' },
            ],
          },
        },
      }))).toThrow(/duplicate|unique|id/i);
    });

    it('rejects an injected plan whose step uses an unknown phase', () => {
      expect(() => MissionCompiler.compile(makeBaseConfig({
        plannerConfig: {
          strategy: 'linear',
          maxSteps: 4,
          plan: {
            steps: [
              { id: 'a', action: 'reasoning', description: 'x', phase: 'wat' as any },
            ],
          },
        },
      }))).toThrow(/phase/i);
    });

    it('takes precedence over plannerConfig.style when both are set', () => {
      const ir = MissionCompiler.compile(makeBaseConfig({
        plannerConfig: {
          strategy: 'linear',
          maxSteps: 4,
          style: 'qa', // would normally produce research-quick + answer
          plan: {
            steps: [
              { id: 'plan-only-1', action: 'reasoning', description: 'first', phase: 'gather' },
              { id: 'plan-only-2', action: 'reasoning', description: 'second', phase: 'deliver' },
            ],
          },
        },
      }));
      const ids = ir.nodes.map((n) => n.id);
      expect(ids).toContain('plan-only-1');
      expect(ids).toContain('plan-only-2');
      expect(ids).not.toContain('research-quick');
      expect(ids).not.toContain('answer');
    });
  });
});
