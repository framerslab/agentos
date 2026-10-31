/**
 * @fileoverview RollingSummaryChain's collapse: over its token budget it merges
 * its oldest summaries into a higher-level one, with a merger, with a merger
 * that fails, and with none, where it joins and cuts the summaries itself.
 */

import { describe, expect, it } from 'vitest';
import { RollingSummaryChain } from '../RollingSummaryChain.js';
import type { SummaryChainNode } from '../types.js';

/** A level-0 summary of turns `from` to `to`, `chars` characters long (four characters a token). */
function leaf(id: string, from: number, to: number, chars = 160): SummaryChainNode {
  const summary = `turns ${from} to ${to} `.padEnd(chars, 'x');
  return {
    id,
    level: 0,
    turnRange: [from, to],
    summary,
    tokenEstimate: Math.ceil(chars / 4),
    createdAt: from,
    childIds: [],
    entities: [`entity-${id}`],
    compactionEntryId: `entry-${id}`,
  };
}

function fourLeaves(): SummaryChainNode[] {
  return [leaf('a', 1, 10), leaf('b', 11, 20), leaf('c', 21, 30), leaf('d', 31, 40)];
}

describe('RollingSummaryChain', () => {
  it('lists its summaries for the prompt, oldest first, while under budget', async () => {
    const chain = new RollingSummaryChain(1000);
    chain.addNodes([leaf('b', 11, 20, 40), leaf('a', 1, 10, 40)]);

    expect(await chain.collapse()).toEqual([]);
    expect(chain.getCoveredRange()).toEqual([1, 20]);
    expect(chain.getTotalTokens()).toBe(20);
    expect(chain.formatForPrompt()).toBe(
      [
        '[Conversation history — turns 1–20, compressed]',
        '--- Turns 1–10 ---',
        leaf('a', 1, 10, 40).summary,
        '--- Turns 11–20 ---',
        leaf('b', 11, 20, 40).summary,
      ].join('\n'),
    );
  });

  it('joins and cuts its oldest summaries into one when it has no merger', async () => {
    const chain = new RollingSummaryChain(100);
    chain.addNodes(fourLeaves()); // 160 tokens over a budget of 100

    const created = await chain.collapse();

    expect(created).toHaveLength(1);
    const [parent] = created;
    expect(parent).toMatchObject({ level: 1, turnRange: [1, 40], childIds: ['a', 'b', 'c', 'd'] });
    // Half the budget, in characters, then an ellipsis.
    expect(parent.summary).toHaveLength(200 + 3);
    expect(parent.summary.endsWith('...')).toBe(true);
    expect(parent.entities).toEqual(['entity-a', 'entity-b', 'entity-c', 'entity-d']);
    expect(chain.getActiveChain()).toEqual([parent]);
    expect(chain.getAllNodes().filter((n) => n.parentId === parent.id)).toHaveLength(4);
    expect(chain.size).toBe(5);
    expect(chain.formatForPrompt().split('\n')[0]).toBe('[Conversation history — turns 1–40, compressed]');
  });

  it('asks the merger for one summary of the oldest four, and falls back to joining when it fails', async () => {
    const prompts: string[] = [];
    const merging = new RollingSummaryChain(100, async (prompt) => {
      prompts.push(prompt);
      return ' the first forty turns ';
    });
    merging.addNodes(fourLeaves());
    const [merged] = await merging.collapse();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('These summaries cover turns 1–40:');
    expect(merged).toMatchObject({ level: 1, summary: 'the first forty turns', tokenEstimate: 6 });

    const failing = new RollingSummaryChain(100, async () => {
      throw new Error('model unavailable');
    });
    failing.addNodes(fourLeaves());
    const [joined] = await failing.collapse();
    expect(joined.summary.endsWith('...')).toBe(true);
  });

  it('stops when one summary alone is over budget, and clears', async () => {
    const chain = new RollingSummaryChain(10);
    chain.addNodes([leaf('a', 1, 10)]);

    expect(await chain.collapse()).toEqual([]);
    expect(chain.getActiveChain()).toHaveLength(1);

    chain.clear();
    expect(chain.size).toBe(0);
    expect(chain.formatForPrompt()).toBe('');
    expect(chain.getCoveredRange()).toBeNull();
  });
});
