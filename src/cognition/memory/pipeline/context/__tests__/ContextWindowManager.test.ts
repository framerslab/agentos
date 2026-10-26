/**
 * @fileoverview The infinite context window end to end: ContextWindowManager
 * with each compaction strategy, the rolling summary chain and the compaction
 * log, with a summarizer that answers from a script (as a recorded model would),
 * one that fails, one that answers nothing, and none at all.
 */

import { describe, expect, it, vi } from 'vitest';
import { ContextWindowManager, type ContextWindowManagerConfig } from '../ContextWindowManager.js';
import { CompactionEngine } from '../CompactionEngine.js';
import type { InfiniteContextConfig } from '../types.js';
import { MemoryObserver } from '../../observation/MemoryObserver.js';
import { MemoryReflector } from '../../observation/MemoryReflector.js';
import type { MemoryTrace } from '../../../core/types.js';

/** `text` padded with dots to `length` characters: 200 characters estimate as 50 tokens. */
function sized(text: string, length = 200): string {
  return text.padEnd(length, '.');
}

/** A window of 1,000 tokens that compacts at half full and keeps the newest two turns. */
function manager(
  infiniteContext: Partial<InfiniteContextConfig> = {},
  extra: Omit<ContextWindowManagerConfig, 'maxContextTokens' | 'infiniteContext'> = {},
): ContextWindowManager {
  return new ContextWindowManager({
    maxContextTokens: 1000,
    infiniteContext: { enabled: true, compactionThreshold: 0.5, preserveRecentTurns: 2, ...infiniteContext },
    ...extra,
  });
}

/** Adds turns `from` to `to`: a user message and the assistant's reply, 50 tokens each. */
function talk(window: ContextWindowManager, from: number, to: number): void {
  for (let turn = from; turn <= to; turn++) {
    window.addMessage('user', sized(`user ${turn} asks about item ${turn}`));
    window.addMessage('assistant', sized(`assistant ${turn} answers about item ${turn}`));
  }
}

const SUMMARY = 'Ana chose Postgres for the `orders` service; the plan is in docs/plan.md.';

describe('ContextWindowManager', () => {
  it('numbers turns from each user message, with the messages before the first one in turn 0', () => {
    const window = manager();
    window.addMessage('system', 'You are helpful.');
    window.addMessage('user', 'hello');
    window.addMessage('assistant', 'hi');
    window.addMessage('tool', '{"ok":true}');
    window.addMessage('user', 'thanks');

    expect(window.getMessages().map((m) => m.turnIndex)).toEqual([0, 1, 1, 1, 2]);
    expect(window.getCurrentTurn()).toBe(2);
  });

  it('leaves the messages alone below the threshold and when it is disabled', async () => {
    const summarize = vi.fn(async () => SUMMARY);
    const below = manager({}, { llmInvoker: summarize });
    talk(below, 1, 4); // 400 tokens of a 500-token threshold
    expect(await below.beforeTurn(0, 0)).toHaveLength(8);

    const disabled = manager({ enabled: false }, { llmInvoker: summarize });
    talk(disabled, 1, 10);
    expect(await disabled.beforeTurn(0, 0)).toHaveLength(20);

    expect(summarize).not.toHaveBeenCalled();
    expect(below.getCompactionHistory()).toEqual([]);
    expect(disabled.enabled).toBe(false);
  });

  it('counts the system prompt and the memory budget toward the threshold', async () => {
    const window = manager({}, { llmInvoker: async () => SUMMARY });
    talk(window, 1, 4); // 400 tokens

    expect(await window.beforeTurn(50, 49)).toHaveLength(8);
    expect(await window.beforeTurn(50, 50)).toHaveLength(5);
  });

  it('summarizes the oldest turns into one message, keeps the newest, and logs what it did', async () => {
    const prompts: string[] = [];
    const window = manager({ transparencyLevel: 'full' }, {
      llmInvoker: async (prompt) => {
        prompts.push(prompt);
        return `  ${SUMMARY}\n`;
      },
    });
    talk(window, 1, 10); // 1,000 tokens

    const messages = await window.beforeTurn(0, 0);

    // Turns 1 to 8 went into the summary; turns 9 and 10 stay as they were.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Conversation (turns 1–8):');
    expect(prompts[0]).toContain('[user] user 1 asks about item 1');
    expect(prompts[0]).toContain('[assistant] assistant 8 answers about item 8');
    expect(prompts[0]).not.toContain('item 9');
    expect(messages).toHaveLength(5);
    expect(messages[0]).toMatchObject({ role: 'system', compacted: true, turnIndex: 1 });
    expect(messages[0].content).toContain('turns 1–8, 800 tokens compressed to');
    expect(messages[0].content).toContain(SUMMARY);
    expect(messages.slice(1).map((m) => m.content.replace(/\.+$/, ''))).toEqual([
      'user 9 asks about item 9',
      'assistant 9 answers about item 9',
      'user 10 asks about item 10',
      'assistant 10 answers about item 10',
    ]);

    const [entry] = window.getCompactionHistory();
    expect(entry).toMatchObject({
      strategy: 'sliding',
      turnRange: [1, 8],
      inputTokens: 800,
      outputTokens: Math.ceil(SUMMARY.length / 4),
      summary: SUMMARY,
    });
    expect(entry.preservedEntities).toEqual(expect.arrayContaining(['docs/plan.md', 'orders']));
    // The user messages whose first sentence the summary does not hold.
    expect(entry.droppedContent).toHaveLength(8);
    expect(entry.droppedContent[0]).toBe('Turn 1: "user 1 asks about item 1"');

    expect(window.getSummaryContext()).toBe(`[Conversation history — turns 1–8, compressed]\n${SUMMARY}`);
    expect(window.findTurnHistory(3)).toEqual([entry]);
    expect(window.findTurnHistory(9)).toEqual([]);
    expect(window.searchHistory('POSTGRES')).toEqual([entry]);
    expect(window.getLog().findByEntity('plan.md')).toEqual([entry]);
    expect(window.getRawMessages()).toHaveLength(4);
    expect(window.getStats()).toMatchObject({
      totalCompactions: 1,
      totalInputTokens: 800,
      messageCount: 5,
      compactedMessageCount: 1,
      summaryChainNodes: 1,
      currentTurn: 10,
      strategy: 'sliding',
      enabled: true,
    });
    const report = window.formatTransparencyReport();
    expect(report).toContain('Strategy: sliding, Compactions: 1');
    expect(report).toContain('--- Recent Compactions ---');
    expect(report).toContain('--- Summary Chain ---');

    // Under the threshold again, the next turn compacts nothing.
    expect(await window.beforeTurn(0, 0)).toHaveLength(5);
    expect(prompts).toHaveLength(1);

    window.clear();
    expect(window.getMessages()).toEqual([]);
    expect(window.getCompactionHistory()).toEqual([]);
    expect(window.getSummaryChain()).toEqual([]);
    expect(window.getCurrentTurn()).toBe(0);
  });

  const withoutASummary: Array<[string, ContextWindowManagerConfig['llmInvoker']]> = [
    ['no summarizer', undefined],
    ['a summarizer that fails', async () => { throw new Error('model unavailable'); }],
    ['a summarizer that answers nothing', async () => '   '],
  ];

  it.each(withoutASummary)('compacts with an extractive summary given %s', async (_label, llmInvoker) => {
    const window = manager({ transparencyLevel: 'full' }, { llmInvoker });
    talk(window, 1, 10);

    const messages = await window.beforeTurn(0, 0);

    expect(messages).toHaveLength(5);
    expect(messages[0].content).toContain('Conversation started with: user 1 asks about item 1');
    expect(messages[0].content).toContain('Most recently discussed: user 8 asks about item 8');
    const [entry] = window.getCompactionHistory();
    expect(entry).toMatchObject({ strategy: 'sliding', turnRange: [1, 8], droppedContent: [] });
  });

  it.each(['sliding', 'hybrid'] as const)('carries the earlier summary into the next one with the %s strategy and no summarizer', async (strategy) => {
    const window = manager({ strategy });
    talk(window, 1, 10);
    const [first] = await window.beforeTurn(0, 0);
    talk(window, 11, 20);
    const [second] = await window.beforeTurn(0, 0);

    // The first summary stands for turns 1 to 8; the second, which replaces it in the window, still holds it.
    expect(first.content).toContain('user 1 asks about item 1');
    expect(second.content).toContain('user 1 asks about item 1');
    expect(second.content).toContain('user 9 asks about item 9');
  });

  it('keeps the summary from the observation notes within the segment it replaces when the hybrid strategy has no summarizer', async () => {
    // Ten long notes: joined whole, they would take more tokens than the turns they summarize.
    const long = (n: number): string => JSON.stringify({ type: 'fact', content: sized(`note ${n}`, 2_000), importance: 0.5 });
    const observer = new MemoryObserver({}, { llmInvoker: async () => Array.from({ length: 10 }, (_, n) => long(n)).join('\n') });
    const window = manager({ strategy: 'hybrid' }, { observer });
    talk(window, 1, 10);

    const [summary] = await window.beforeTurn(0, 0);
    const [entry] = window.getCompactionHistory();
    expect(entry.outputTokens).toBeLessThanOrEqual(entry.inputTokens);
    expect(summary.tokenEstimate).toBeLessThanOrEqual(entry.inputTokens);
    expect(summary.content).toContain('[fact] note');
  });

  it('never summarizes the newest message, and logs no compaction when nothing older is left', async () => {
    const summarize = vi.fn(async () => SUMMARY);
    const window = new ContextWindowManager({
      maxContextTokens: 100,
      infiniteContext: { enabled: true },
      llmInvoker: summarize,
    });
    window.addMessage('user', sized('one long question', 400)); // 100 tokens

    const alone = await window.beforeTurn(0, 0);

    expect(alone).toHaveLength(1);
    expect(alone[0].content.startsWith('one long question')).toBe(true);
    expect(summarize).not.toHaveBeenCalled();
    expect(window.getCompactionHistory()).toEqual([]);
    expect(window.getStats().totalCompactions).toBe(0);

    window.addMessage('assistant', 'a short answer');
    window.addMessage('user', sized('a second long question', 400));
    const after = await window.beforeTurn(0, 0);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(after).toHaveLength(2);
    expect(after[0].compacted).toBe(true);
    expect(after[1].content.startsWith('a second long question')).toBe(true);
  });

  it('merges six segment summaries into a level-1 summary with the hierarchical strategy', async () => {
    let segments = 0;
    const prompts: string[] = [];
    const window = manager({ strategy: 'hierarchical', preserveRecentTurns: 1 }, {
      llmInvoker: async (prompt) => {
        prompts.push(prompt);
        if (prompt.startsWith('Merge these L0')) return 'the first thirty turns, merged';
        segments += 1;
        return `segment summary ${segments}`;
      },
    });

    let turn = 0;
    for (let round = 1; round <= 6; round++) {
      const count = round === 1 ? 6 : 5;
      talk(window, turn + 1, turn + count);
      turn += count;
      await window.beforeTurn(0, 0);
      expect(window.getCompactionHistory()).toHaveLength(round);
    }

    expect(segments).toBe(6);
    expect(prompts.filter((p) => p.startsWith('Merge these L0'))).toHaveLength(1);
    const nodes = window.getSummaryChain();
    const merged = nodes.find((n) => n.level === 1);
    expect(merged).toBeDefined();
    expect(merged!.childIds).toHaveLength(6);
    expect(nodes.filter((n) => n.level === 0 && n.parentId === merged!.id)).toHaveLength(6);
    const [summaryMessage] = window.getMessages();
    expect(summaryMessage.content).toContain('(L1 summary)]\nthe first thirty turns, merged');
    expect(window.getCompactionHistory()[5].strategy).toBe('hierarchical');
  });

  it('extracts notes and traces with the hybrid strategy, and logs the ids the store gave the traces', async () => {
    const traits = { conscientiousness: 0.8 };
    const observed: string[] = [];
    const observer = new MemoryObserver(traits, {
      llmInvoker: async (_system, conversation) => {
        observed.push(conversation);
        return [
          JSON.stringify({ type: 'commitment', content: 'User will send the contract on Friday', importance: 0.9, entities: ['contract'] }),
          'not a note',
          JSON.stringify({ type: 'preference', content: 'User prefers short answers', importance: 0.4, entities: [] }),
        ].join('\n');
      },
    });
    const reflector = new MemoryReflector(traits, {
      llmInvoker: async () =>
        JSON.stringify({ type: 'prospective', scope: 'user', content: 'Send the contract on Friday', entities: ['contract'], tags: ['deadline'], confidence: 0.9 }),
    });
    const encoded: Partial<MemoryTrace>[][] = [];
    const window = manager({ strategy: 'hybrid', transparencyLevel: 'full' }, {
      llmInvoker: async () => 'The user will send the contract on Friday.',
      observer,
      reflector,
      onTracesCreated: async (traces) => {
        encoded.push(traces);
        return ['trace-1'];
      },
    });
    talk(window, 1, 10);

    const messages = await window.beforeTurn(0, 0);

    expect(observed).toHaveLength(1);
    expect(observed[0]).toContain('[user] user 1 asks about item 1');
    expect(messages[0].content).toContain('2 observations, 1 traces created');
    expect(messages[0].content).toContain('The user will send the contract on Friday.');
    expect(encoded).toHaveLength(1);
    expect(encoded[0][0]).toMatchObject({ type: 'prospective', content: 'Send the contract on Friday' });
    const [entry] = window.getCompactionHistory();
    expect(entry.strategy).toBe('hybrid');
    expect(entry.observationNotes?.map((n) => n.type)).toEqual(['commitment', 'preference']);
    expect(entry.preservedEntities).toContain('contract');
    await vi.waitFor(() => expect(window.getCompactionHistory()[0].tracesCreated).toEqual(['trace-1']));
    expect(window.getStats().totalTracesCreated).toBe(1);
  });

  it('summarizes from the observation notes when the hybrid strategy has no summarizer', async () => {
    const observer = new MemoryObserver({}, {
      llmInvoker: async () =>
        [
          JSON.stringify({ type: 'preference', content: 'User prefers short answers', importance: 0.4 }),
          JSON.stringify({ type: 'commitment', content: 'User will send the contract on Friday', importance: 0.9 }),
        ].join('\n'),
    });
    const withNotes = manager({ strategy: 'hybrid' }, { observer });
    talk(withNotes, 1, 10);
    const [summary] = await withNotes.beforeTurn(0, 0);
    expect(summary.content).toContain(
      '[commitment] User will send the contract on Friday\n[preference] User prefers short answers'
    );

    const withNothing = manager({ strategy: 'hybrid' });
    talk(withNothing, 1, 10);
    const [plain] = await withNothing.beforeTurn(0, 0);
    expect(plain.content).toContain(
      'Conversation turns 1–8: user 1 asks about item 1'
    );
    expect(plain.content).toContain('0 observations, 0 traces created');
  });

  it('refuses a strategy it does not know', async () => {
    const engine = new CompactionEngine();
    expect(engine.getAvailableStrategies()).toEqual(['sliding', 'hierarchical', 'hybrid']);
    expect(engine.getStrategy('sliding')?.name).toBe('sliding');
    await expect(
      engine.compact(
        { messages: [], maxContextTokens: 100, currentTokens: 0, summaryChain: [] },
        { ...manager().getConfig(), strategy: 'unknown' as InfiniteContextConfig['strategy'] },
      ),
    ).rejects.toThrow(/Unknown compaction strategy/);
  });
});
