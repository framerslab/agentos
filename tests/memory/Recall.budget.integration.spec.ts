/**
 * @fileoverview The memory block's budget on one model: the clamp to what is left of the model's retrieved-context
 * share (`effectiveRecallBudget`), the manager's re-render of a context it returned at a lower budget
 * (`reassembleForBudget`, the assembler alone: no store query, no embedding call), and the bridge's block for one
 * model hop (`contextForHop`). A real CognitiveMemoryManager built by `createAgentCognitiveMemory` over the in-memory
 * stores, with a deterministic word-hash embedding, so texts that share words recall each other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import { createAgentCognitiveMemory } from '../../src/api/runtime/agentCognitiveMemory.js';
import { CognitiveMemoryBridge } from '../../src/cognition/substrate/CognitiveMemoryBridge.js';
import { GMIMood } from '../../src/cognition/substrate/IGMI.js';
import type { ICognitiveMemoryManager } from '../../src/cognition/memory/CognitiveMemoryManager.js';
import { effectiveRecallBudget } from '../../src/cognition/memory/retrieval/recall/budget.js';
import { MEMORY_CUT_MARKER } from '../../src/cognition/memory/core/prompt/MemoryFormatters.js';
import { resetLoggerFactory, setLogger } from '../../src/core/logging/loggerFactory.js';

const DIM = 64;

/** A deterministic bag-of-words vector: texts that share words point the same way. */
function hashEmbed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function makeEmbedder() {
  return {
    initialize: async () => undefined,
    generateEmbeddings: async (req: { texts: string | string[] }) => {
      const texts = Array.isArray(req.texts) ? req.texts : [req.texts];
      return { embeddings: texts.map(hashEmbed), modelId: 'test-embed', providerId: 'test', usage: { totalTokens: 0 } };
    },
    getEmbeddingModelInfo: async () => ({ modelId: 'test-embed', providerId: 'test', dimension: DIM }),
    getEmbeddingDimension: async () => DIM,
    checkHealth: async () => ({ isHealthy: true }),
    shutdown: async () => undefined,
  };
}

function memoryWith() {
  const persona = {
    id: 'memo', name: 'Memo', description: 'd', version: '1.0.0', baseSystemPrompt: 'x',
    personalityTraits: { conscientiousness: 0.9, openness: 0.2, emotionality: 0.2 },
  } as never;
  return createAgentCognitiveMemory({ persona, memory: {}, embeddingManager: makeEmbedder() as never });
}

const neutral = { valence: 0, arousal: 0, dominance: 0 };

const logged: Record<string, unknown>[] = [];
/** The lines written with the event `name`. */
const events = (name: string) => logged.filter((line) => line.event === name);

beforeEach(() => {
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(() => {
  resetLoggerFactory();
  vi.restoreAllMocks();
});

describe('effectiveRecallBudget', () => {
  it.each([
    [{ totalTokens: 1600, contextTokens: 128_000, otherContextTokens: 0 }, { requested: 1600, effective: 1600, promptShareTokens: 25_600, otherContextTokens: 0 }],
    [{ totalTokens: 1600, contextTokens: 3_000, otherContextTokens: 0 }, { requested: 1600, effective: 600, clampReason: 'prompt_share', promptShareTokens: 600, otherContextTokens: 0 }],
    [{ totalTokens: 1600, contextTokens: 8_000, otherContextTokens: 1_500 }, { requested: 1600, effective: 100, clampReason: 'prompt_share', promptShareTokens: 1600, otherContextTokens: 1_500 }],
    [{ totalTokens: 1600, contextTokens: 8_000, otherContextTokens: 2_000 }, { requested: 1600, effective: 0, clampReason: 'zero_remaining', promptShareTokens: 1600, otherContextTokens: 2_000 }],
    [{ totalTokens: 0, contextTokens: 8_000, otherContextTokens: 0 }, { requested: 0, effective: 0, promptShareTokens: 1600, otherContextTokens: 0 }],
  ])('%j', (input, expected) => expect(effectiveRecallBudget(input)).toEqual(expected));

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0])('a context size of %s skips the clamp and says so', (contextTokens) => {
    expect(effectiveRecallBudget({ totalTokens: 1600, contextTokens, otherContextTokens: 0 })).toEqual({ requested: 1600, effective: 1600, invalid: true });
  });

  it('a negative or unbounded other-context count skips the clamp', () => {
    expect(effectiveRecallBudget({ totalTokens: 1600, contextTokens: 8_000, otherContextTokens: -5 })).toEqual({ requested: 1600, effective: 1600, invalid: true });
    expect(effectiveRecallBudget({ totalTokens: 1600, contextTokens: 8_000, otherContextTokens: Number.NaN })).toEqual({ requested: 1600, effective: 1600, invalid: true });
  });
});

describe('reassembleForBudget', () => {
  it('re-renders the block from the same candidates: no store query, no embedding call, whole memories only', async () => {
    const mem = await memoryWith();
    try {
      for (let i = 0; i < 13; i++) {
        await mem.manager.encode(
          `Hiking day ${i + 1}: we wrote in the trail journal that the overlook had the best view of the season, counted the switchbacks on the way down and packed the map with the gear list for the next camping weekend.`,
          neutral,
          'neutral',
          { type: 'episodic' },
        );
      }
      const first = await mem.manager.assembleForPrompt('what did we write in the trail journal about the view', 1600, neutral);
      const query = vi.spyOn(mem.manager.getStore(), 'query');
      const embed = vi.spyOn(mem.manager.getConfig().embeddingManager, 'generateEmbeddings');
      const reassemble = mem.manager.reassembleForBudget!.bind(mem.manager);

      const same = await reassemble(first, 1600);
      // The assembler is pure over the kept input.
      expect(same.contextText).toBe(first.contextText);

      const lower = await reassemble(first, 600);
      expect(query).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      expect(lower.tokensUsed).toBeLessThanOrEqual(600);
      expect(lower.contextText).not.toContain(MEMORY_CUT_MARKER);
      const firstLines = new Set(first.contextText.split('\n'));
      for (const line of lower.contextText.split('\n').filter((l) => l.startsWith('- ['))) expect(firstLines.has(line), line).toBe(true);
      expect(lower.capture?.budget).toMatchObject({ requested: 1600, effective: 600, reassembled: true });
      expect(lower.capture?.tokensUsed).toBe(lower.tokensUsed);
      expect(lower.capture?.candidates.map((c) => c.id)).toEqual(first.capture?.candidates.map((c) => c.id));
      const leftOut = (c: typeof first) => c.capture!.candidates.filter((candidate) => candidate.outcome === 'left_out').length;
      expect(leftOut(lower)).toBeGreaterThan(leftOut(first));
      // The first rendering's record is never changed.
      expect(first.capture?.budget).toEqual({ requested: 1600, effective: 1600 });

      // A context the re-render returned can be rendered again: from the same kept input, at the same request.
      const again = await reassemble(lower, 1600);
      expect(again.contextText).toBe(first.contextText);
      expect(again.capture?.budget).toMatchObject({ requested: 1600, effective: 1600, reassembled: true });

      const zero = await reassemble(first, 0);
      expect(zero.contextText).toBe('');
      expect(zero.capture!.candidates.length).toBeGreaterThan(0);
      for (const c of zero.capture!.candidates) expect(c).toMatchObject({ outcome: 'left_out', reason: 'budget' });

      // A context this manager did not return.
      await expect(reassemble({ ...first }, 600)).rejects.toThrow('reassembleForBudget');
    } finally {
      await mem.close();
    }
  });

  it("the session view re-renders the contexts the view's assembleForPrompt returned", async () => {
    const mem = await memoryWith();
    try {
      for (let i = 0; i < 6; i++) await mem.manager.encode(`Trail journal entry ${i}: the overlook had the best view of the season and the map was packed.`, neutral, 'neutral', { type: 'episodic' });
      const view = mem.manager.forSession();
      const first = await view.assembleForPrompt('the trail journal overlook view', 1600, neutral);
      const lower = await view.reassembleForBudget!(first, 120);
      expect(lower.tokensUsed).toBeLessThanOrEqual(120);
      expect(lower.capture?.budget).toMatchObject({ requested: 1600, effective: 120, reassembled: true });
    } finally {
      await mem.close();
    }
  });
});

describe('CognitiveMemoryBridge.contextForHop', () => {
  const ALLOCATION = { workingMemory: 0.15, semanticRecall: 0.4, recentEpisodic: 0.25, prospectiveAlerts: 0.05, graphAssociations: 0.05, observationNotes: 0.05, persistentMemory: 0.05 };
  type Entry = { type: string; message: string; details?: Record<string, unknown> };
  const bridgeOver = (manager: unknown, trace: Entry[] = []) =>
    new CognitiveMemoryBridge(
      manager as ICognitiveMemoryManager,
      () => GMIMood.NEUTRAL,
      () => ({ userId: 'memo' }),
      () => 'memo',
      () => 'gmi-1',
      (type, message, details) => { trace.push({ type, message, details }); },
    );

  it('a manager without reassembleForBudget is asked again through assembleForPrompt at the lower budget, with the same query and scopes', async () => {
    const calls: Array<{ query: string; budget: number; scopes: unknown }> = [];
    const custom = {
      getConfig: () => ({ agentId: 'memo' }),
      assembleForPrompt: async (query: string, budget: number, _mood: unknown, options: { scopes?: unknown }) => {
        calls.push({ query, budget, scopes: options.scopes });
        const text = 'x'.repeat(Math.min(1000, budget) * 4);
        return { contextText: text, tokensUsed: Math.min(1000, budget), allocation: ALLOCATION, includedMemoryIds: [] };
      },
    };
    const bridge = bridgeOver(custom);
    const first = (await bridge.assembleContext('the trail journal'))!;
    const hop = await bridge.contextForHop(first, effectiveRecallBudget({ totalTokens: 1600, contextTokens: 3_000, otherContextTokens: 0 }), 1);
    expect(calls.map((c) => c.budget)).toEqual([1600, 600]);
    expect(calls[1].query).toBe('the trail journal');
    expect(calls[1].scopes).toEqual(calls[0].scopes);
    expect(hop?.tokensUsed).toBe(600);
  });

  it('a hop whose share holds the block takes it as assembled; an invalid input skips the clamp with one line; a remainder of 0 sends no block with one line', async () => {
    const mem = await memoryWith();
    try {
      for (let i = 0; i < 6; i++) await mem.manager.encode(`Trail journal entry ${i}: the overlook had the best view.`, neutral, 'neutral', { type: 'episodic' });
      const bridge = bridgeOver(mem.manager);
      const first = (await bridge.assembleContext('the trail journal overlook view'))!;
      expect(first.capture).toBeDefined();

      const held = await bridge.contextForHop(first, effectiveRecallBudget({ totalTokens: 1600, contextTokens: 128_000, otherContextTokens: 0 }), 0);
      expect(held!.contextText).toBe(first.contextText);
      expect(held!.capture?.budget).toMatchObject({ requested: 1600, effective: 1600, hop: 0 });
      expect(held!.capture?.budget.reassembled).toBeUndefined();
      expect(events('memory.recall.budget_clamped')).toEqual([]);

      const invalid = await bridge.contextForHop(first, effectiveRecallBudget({ totalTokens: 1600, contextTokens: Number.NaN, otherContextTokens: 0 }), 0);
      expect(invalid!.contextText).toBe(first.contextText);
      expect(invalid!.capture?.budget.clampReason).toBeUndefined();
      expect(events('memory.recall.budget_clamped')).toEqual([expect.objectContaining({ requested: 1600, effective: 1600, hop: 0, reason: 'invalid' })]);

      const none = await bridge.contextForHop(first, effectiveRecallBudget({ totalTokens: 1600, contextTokens: 8_000, otherContextTokens: 2_000 }), 2);
      expect(none!.contextText).toBe('');
      expect(none!.capture?.budget).toMatchObject({ requested: 1600, effective: 0, clampReason: 'zero_remaining', promptShareTokens: 1600, otherContextTokens: 2_000, hop: 2, reassembled: true });
      for (const c of none!.capture!.candidates) expect(c).toMatchObject({ outcome: 'left_out', reason: 'budget' });
      expect(events('memory.recall.budget_clamped').at(-1)).toMatchObject({ requested: 1600, effective: 0, hop: 2, reason: 'zero_remaining' });
      expect(events('memory.recall.allocation_exhausted')).toEqual([expect.objectContaining({ requested: 1600, candidates: first.capture!.candidates.length })]);

      // The turn's first rendering is never changed.
      expect(first.capture?.budget.hop).toBeUndefined();
      expect(first.capture?.budget).toEqual({ requested: 1600, effective: 1600 });
    } finally {
      await mem.close();
    }
  });

  it("a failed re-render sends the hop no block, and the bridge's trace entries name the error's class, never its message", async () => {
    const trace: Entry[] = [];
    let call = 0;
    const custom = {
      getConfig: () => ({ agentId: 'memo' }),
      assembleForPrompt: async (_query: string, budget: number) => {
        call += 1;
        if (call > 1) throw new Error('query=What is my diagnosis? trace=patient-4471');
        return { contextText: 'x'.repeat(4000), tokensUsed: Math.min(1000, budget), allocation: ALLOCATION, includedMemoryIds: [] };
      },
    };
    const bridge = bridgeOver(custom, trace);
    const first = (await bridge.assembleContext('What is my diagnosis?'))!;
    const hop = await bridge.contextForHop(first, effectiveRecallBudget({ totalTokens: 1600, contextTokens: 3_000, otherContextTokens: 0 }), 1);
    expect(hop).toBeNull();
    const failed = trace.filter((entry) => entry.type === 'WARNING');
    expect(failed).toHaveLength(1);
    expect(failed[0].details).toEqual({ errorName: 'Error' });
    expect(JSON.stringify(trace)).not.toMatch(/diagnosis|patient-4471/);
  });

  it('a reassembleForBudget that rejects sends the hop no block and starts no second recall; the trace entry names the error class', async () => {
    const trace: Entry[] = [];
    let assemblies = 0;
    const custom = {
      getConfig: () => ({ agentId: 'memo' }),
      assembleForPrompt: async (_query: string, budget: number) => {
        assemblies += 1;
        return { contextText: 'x'.repeat(4000), tokensUsed: Math.min(1000, budget), allocation: ALLOCATION, includedMemoryIds: [] };
      },
      reassembleForBudget: async () => { throw new RangeError('query=What is my diagnosis? trace=patient-4471'); },
    };
    const bridge = bridgeOver(custom, trace);
    const first = (await bridge.assembleContext('What is my diagnosis?'))!;
    const hop = await bridge.contextForHop(first, effectiveRecallBudget({ totalTokens: 1600, contextTokens: 3_000, otherContextTokens: 0 }), 1);
    expect(hop).toBeNull();
    // The turn's one recall: the rejection does not start another, which would embed and retrieve again.
    expect(assemblies).toBe(1);
    expect(trace.filter((entry) => entry.type === 'WARNING')).toEqual([
      { type: 'WARNING', message: 'Cognitive memory re-render for a model hop failed.', details: { errorName: 'RangeError' } },
    ]);
    expect(JSON.stringify(trace)).not.toMatch(/diagnosis|patient-4471/);
  });

  it("a failed assembly writes the error's class to the trace entry, never its message", async () => {
    const trace: Entry[] = [];
    const custom = {
      getConfig: () => ({ agentId: 'memo' }),
      assembleForPrompt: async () => { throw new TypeError('vector store said: no row for "What is my diagnosis?" (patient-4471)'); },
    };
    const bridge = bridgeOver(custom, trace);
    expect(await bridge.assembleContext('What is my diagnosis?')).toBeNull();
    expect(trace).toEqual([{ type: 'WARNING', message: 'Cognitive memory assembly failed.', details: { errorName: 'TypeError' } }]);
  });
});
