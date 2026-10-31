/**
 * @fileoverview CognitiveMemoryManager's infinite context window: it is managed
 * with no model configured (extractive summaries, one log line saying so), with
 * the window's own single-prompt summarizer, and with a (system, user) invoker
 * of the reflector.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CognitiveMemoryManager } from '../CognitiveMemoryManager.js';
import { resetLoggerFactory, setLoggerFactory } from '../../../core/logging/index.js';
import type { ILogger } from '../../../core/logging/index.js';

/** The manager's required collaborators, as stand-ins: the window under test uses none of them. */
function minimalDeps() {
  return {
    workingMemory: {
      capacity: 7,
      store: vi.fn(),
      retrieve: vi.fn().mockResolvedValue([]),
      clear: vi.fn(),
      getSlots: vi.fn().mockReturnValue([]),
    } as any,
    knowledgeGraph: {
      initialize: vi.fn(),
      upsertEntity: vi.fn(),
      upsertRelation: vi.fn(),
      queryEntities: vi.fn().mockResolvedValue([]),
      getNeighborhood: vi.fn().mockResolvedValue({ entities: [], relations: [] }),
      getRelations: vi.fn().mockResolvedValue([]),
      deleteEntity: vi.fn(),
      deleteRelation: vi.fn(),
      recordMemory: vi.fn(),
    } as any,
    vectorStore: {
      initialize: vi.fn(),
      upsert: vi.fn(),
      query: vi.fn().mockResolvedValue({ documents: [] }),
      collectionExists: vi.fn().mockResolvedValue(true),
      createCollection: vi.fn(),
    } as any,
    embeddingManager: {
      generateEmbeddings: vi.fn().mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]], modelId: 'test', providerId: 'test', usage: { totalTokens: 0 } }),
      getEmbeddingDimension: vi.fn().mockResolvedValue(3),
      initialize: vi.fn(),
    } as any,
    agentId: 'infinite-context-test',
    traits: { conscientiousness: 0.5 },
    moodProvider: () => ({ valence: 0, arousal: 0.3, dominance: 0 }),
    featureDetectionStrategy: 'keyword' as const,
  };
}

/** Four turns of 50-token messages: 400 tokens, over the 200-token threshold of a 400-token window. */
function talk(manager: CognitiveMemoryManager): void {
  for (let turn = 1; turn <= 4; turn++) {
    manager.trackMessage('user', `user ${turn} asks about item ${turn}`.padEnd(200, '.'));
    manager.trackMessage('assistant', `assistant ${turn} answers about item ${turn}`.padEnd(200, '.'));
  }
}

const WINDOW = { enabled: true, compactionThreshold: 0.5, preserveRecentTurns: 1 } as const;

afterEach(() => {
  resetLoggerFactory();
});

describe('CognitiveMemoryManager: infinite context', () => {
  it('manages the window with no model configured, with extractive summaries, and logs that once', async () => {
    const lines: Array<{ component: string; level: string; message: string; meta?: Record<string, unknown> }> = [];
    setLoggerFactory((component): ILogger => {
      const record = (level: string) => (message: string, meta?: Record<string, unknown>) => {
        lines.push({ component, level, message, meta });
      };
      return { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') };
    });
    const manager = new CognitiveMemoryManager();
    await manager.initialize({ ...minimalDeps(), infiniteContext: WINDOW, maxContextTokens: 400 });

    expect(manager.getContextWindowManager()).not.toBeNull();
    talk(manager);
    const messages = await manager.compactIfNeeded(0, 0);

    expect(messages?.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(messages?.[0].compacted).toBe(true);
    expect(messages?.[0].content).toContain('Conversation started with: user 1 asks about item 1');
    expect(messages?.[0].content).toContain('Most recently discussed: user 3 asks about item 3');
    expect(manager.getCompactionHistory()).toHaveLength(1);
    expect(manager.getSummaryContext()).toContain('turns 1–3, compressed');
    expect(manager.getContextWindowStats()).toMatchObject({ totalCompactions: 1, enabled: true });
    expect(manager.getContextTransparencyReport()).toContain('Compactions: 1');
    expect(manager.searchCompactionHistory('USER 3')).toHaveLength(1);
    expect(manager.searchCompactionHistory('user 2')).toEqual([]);
    expect(lines.filter((l) => l.message.includes('extractive summaries'))).toEqual([
      {
        component: 'CognitiveMemoryManager',
        level: 'info',
        message: 'Infinite context compacts with extractive summaries: no summarizer is configured',
        meta: { strategy: 'sliding' },
      },
    ]);
  });

  it("calls the window's own summarizer with the prompt alone", async () => {
    const prompts: string[] = [];
    const manager = new CognitiveMemoryManager();
    await manager.initialize({
      ...minimalDeps(),
      infiniteContext: {
        ...WINDOW,
        llmInvoker: async (prompt) => {
          prompts.push(prompt);
          return 'Items one to three were discussed.';
        },
      },
      maxContextTokens: 400,
    });
    talk(manager);

    const messages = await manager.compactIfNeeded(0, 0);

    expect(prompts).toHaveLength(1);
    expect(prompts[0].startsWith('Summarize this conversation segment concisely')).toBe(true);
    expect(messages?.[0].content).toContain('Items one to three were discussed.');
  });

  it("wraps the reflector's (system, user) invoker as the summarizer", async () => {
    const calls: Array<[string, string]> = [];
    const manager = new CognitiveMemoryManager();
    await manager.initialize({
      ...minimalDeps(),
      reflector: {
        llmInvoker: async (system, user) => {
          calls.push([system, user]);
          return 'Items one to three were discussed.';
        },
      },
      infiniteContext: WINDOW,
      maxContextTokens: 400,
    });
    talk(manager);

    await manager.compactIfNeeded(0, 0);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('You are a conversation summarizer.');
    expect(calls[0][1].startsWith('Summarize this conversation segment concisely')).toBe(true);
  });

  it('leaves the window off unless infinite context is enabled with a window size', async () => {
    const manager = new CognitiveMemoryManager();
    await manager.initialize({ ...minimalDeps(), infiniteContext: WINDOW });

    expect(manager.getContextWindowManager()).toBeNull();
    expect(await manager.compactIfNeeded(0, 0)).toBeNull();
    expect(manager.getSummaryContext()).toBe('');
    expect(manager.getContextWindowStats()).toBeNull();
  });
});
