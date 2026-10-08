import { describe, it, expect } from 'vitest';
import { ProviderAssignmentEngine } from '../planning/ProviderAssignmentEngine.js';
import type { GraphNode } from '../ir/types.js';

function makeGmiNode(id: string, complexity: number): GraphNode & { complexity: number } {
  return {
    id,
    type: 'gmi',
    executorConfig: { type: 'gmi' as const, instructions: `Do ${id}` },
    executionMode: 'single_turn',
    effectClass: 'read',
    checkpoint: 'after',
    complexity,
  };
}

describe('ProviderAssignmentEngine', () => {
  describe('cheapest strategy', () => {
    it('assigns cheapest models to all nodes, rotating across available providers', () => {
      const engine = new ProviderAssignmentEngine(['openai', 'anthropic']);
      const nodes = [makeGmiNode('researcher', 0.8), makeGmiNode('summarizer', 0.2)];
      const assignments = engine.assign(nodes, { strategy: 'cheapest' });

      expect(assignments).toHaveLength(2);
      expect(assignments[0]).toMatchObject({
        provider: 'openai',
        model: 'gpt-4o-mini',
      });
      expect(assignments[1]).toMatchObject({
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
      });
    });
  });

  describe('best strategy', () => {
    it('assigns top models to all nodes', () => {
      const engine = new ProviderAssignmentEngine(['openai']);
      const nodes = [makeGmiNode('researcher', 0.8)];
      const assignments = engine.assign(nodes, { strategy: 'best' });

      expect(assignments[0]!.model).toBe('gpt-4o');
    });

    it('prefers stronger providers when multiple are available', () => {
      const engine = new ProviderAssignmentEngine(['openai', 'anthropic']);
      const nodes = [makeGmiNode('researcher', 0.8)];
      const assignments = engine.assign(nodes, { strategy: 'best' });

      expect(assignments[0]!.provider).toBe('anthropic');
      expect(assignments[0]!.model).toBe('claude-sonnet-4-6');
    });
  });

  describe('balanced strategy', () => {
    it('assigns by complexity — cheap for low, standard for high', () => {
      const engine = new ProviderAssignmentEngine(['openai']);
      const nodes = [makeGmiNode('hard', 0.9), makeGmiNode('easy', 0.1)];
      const assignments = engine.assign(nodes, { strategy: 'balanced' });

      const hard = assignments.find((a) => a.nodeId === 'hard')!;
      const easy = assignments.find((a) => a.nodeId === 'easy')!;
      expect(hard.model).toBe('gpt-4o');
      expect(easy.model).toBe('gpt-4o-mini');
    });

    it('uses 0.3 as the complexity threshold', () => {
      const engine = new ProviderAssignmentEngine(['openai']);
      const borderLow = makeGmiNode('border_low', 0.29);
      const borderHigh = makeGmiNode('border_high', 0.31);
      const assignments = engine.assign([borderLow, borderHigh], { strategy: 'balanced' });

      expect(assignments.find((a) => a.nodeId === 'border_low')!.model).toBe('gpt-4o-mini');
      expect(assignments.find((a) => a.nodeId === 'border_high')!.model).toBe('gpt-4o');
    });
  });

  describe('explicit strategy', () => {
    it('respects per-node assignments', () => {
      const engine = new ProviderAssignmentEngine(['openai', 'anthropic']);
      const nodes = [makeGmiNode('writer', 0.5)];
      const assignments = engine.assign(nodes, {
        strategy: 'explicit',
        assignments: { writer: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' } },
      });

      expect(assignments[0]!.provider).toBe('anthropic');
      expect(assignments[0]!.model).toBe('claude-sonnet-4-20250514');
    });

    it('uses _default for unmatched nodes', () => {
      const engine = new ProviderAssignmentEngine(['openai', 'anthropic']);
      const nodes = [makeGmiNode('random', 0.5)];
      const assignments = engine.assign(nodes, {
        strategy: 'explicit',
        assignments: { _default: { provider: 'anthropic' } },
      });

      expect(assignments[0]!.provider).toBe('anthropic');
    });

    it('falls back to balanced for completely unmatched nodes', () => {
      const engine = new ProviderAssignmentEngine(['openai']);
      const nodes = [makeGmiNode('orphan', 0.5)];
      const assignments = engine.assign(nodes, {
        strategy: 'explicit',
        assignments: { writer: { provider: 'anthropic' } },
      });

      // Should get balanced fallback (openai, standard model)
      expect(assignments[0]!.provider).toBe('openai');
    });
  });

  describe('mixed strategy', () => {
    it('uses explicit for matched nodes, fallback for others', () => {
      const engine = new ProviderAssignmentEngine(['openai', 'anthropic']);
      const nodes = [makeGmiNode('writer', 0.5), makeGmiNode('helper', 0.1)];
      const assignments = engine.assign(nodes, {
        strategy: 'mixed',
        assignments: { writer: { provider: 'anthropic' } },
        fallback: 'cheapest',
      });

      const writer = assignments.find((a) => a.nodeId === 'writer')!;
      const helper = assignments.find((a) => a.nodeId === 'helper')!;
      expect(writer.provider).toBe('anthropic');
      expect(helper.model).toBe('gpt-4o-mini'); // cheapest fallback
    });

    it('applies _default before falling back to the named strategy', () => {
      const engine = new ProviderAssignmentEngine(['openai', 'anthropic']);
      const nodes = [makeGmiNode('helper', 0.1)];
      const assignments = engine.assign(nodes, {
        strategy: 'mixed',
        assignments: { _default: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' } },
        fallback: 'cheapest',
      });

      expect(assignments[0]).toMatchObject({
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
      });
    });
  });

  describe('availability check', () => {
    it('reports missing providers', () => {
      const engine = new ProviderAssignmentEngine(['openai']);
      const result = engine.checkAvailability([
        { nodeId: 'a', provider: 'openai', model: 'gpt-4o', complexity: 0.5, reason: '' },
        { nodeId: 'b', provider: 'anthropic', model: 'claude', complexity: 0.5, reason: '' },
      ]);

      expect(result.available).toBe(false);
      expect(result.missing).toContain('anthropic');
    });

    it('passes when all providers are available', () => {
      const engine = new ProviderAssignmentEngine(['openai', 'anthropic']);
      const result = engine.checkAvailability([
        { nodeId: 'a', provider: 'openai', model: 'gpt-4o', complexity: 0.5, reason: '' },
        { nodeId: 'b', provider: 'anthropic', model: 'claude', complexity: 0.5, reason: '' },
      ]);

      expect(result.available).toBe(true);
      expect(result.missing).toHaveLength(0);
    });
  });
});
