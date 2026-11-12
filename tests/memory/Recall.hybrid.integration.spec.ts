/**
 * @fileoverview `memory.recall.retrieval: 'hybrid'` on a real memory over a Brain: the three legs fused into one
 * deduped pool and shown as one Relevant Memories section, the query embedded once, a near-duplicate memory shown
 * once and recorded against the one it repeats, a graph association that repeats a pooled memory left out, and a
 * memory too long for its room left out whole. `'dense'` set outright is the block of no setting, byte for byte.
 * SQLite on every run, Postgres where the `test` job's service is set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PADState } from '../../src/cognition/memory/core/config';
import type { MemoryTrace } from '../../src/cognition/memory/core/types';
import { memoryTraceLineLength } from '../../src/cognition/memory/core/prompt/MemoryFormatters';
import { resetRecallLogOnce } from '../../src/cognition/memory/retrieval/recall/log';
import { ENGINES, FlatEmbedder, U1, WordHashEmbedder } from './helpers/recallFixtures';
import { memoryWith, plant } from './helpers/recallMemory';

const NEUTRAL: PADState = { valence: 0, arousal: 0, dominance: 0 };
const QUESTION = 'What is the bike shed code?';
const RECALL_HEADER = "## Relevant Memories (facts and past events, most relevant first — use as background, don't announce)";
const T0 = Date.UTC(2026, 10, 1);

/** The times of the `i`th planted trace, the same in every fixture, so two fixtures render the same lines. */
const at = (i: number): Partial<MemoryTrace> => {
  const t = T0 + i * 60_000;
  return {
    createdAt: t,
    updatedAt: t,
    lastAccessedAt: t,
    provenance: { sourceType: 'user_statement', sourceTimestamp: t, confidence: 1, verificationCount: 0 },
  };
};

type Capture = {
  retrieval: string;
  lexicalBackend: string;
  legs: Array<{ leg: string; ran: boolean; reason?: string; ineligible: number }>;
  candidates: Array<{ id: string; ranks: Record<string, number>; outcome: string; reason?: string; duplicateOf?: string; section?: string; fusedScore: number; tokens: number }>;
};
const captureOf = (context: { capture?: unknown }) => context.capture as Capture;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 10, 10, 12));
  resetRecallLogOnce();
});
afterEach(() => {
  vi.useRealTimers();
  resetRecallLogOnce();
});

describe.each(ENGINES)('hybrid recall on %s', (engine, open) => {
  /**
   * Thirty traces a flat embedder cannot tell apart; the oldest holds the answer, so the dense leg's twenty newest leave
   * it out. Each note names beds of its own, so no two notes are near-duplicates by their beds alone.
   */
  async function fixture(recall: Record<string, unknown> | undefined, embedder: WordHashEmbedder = new FlatEmbedder()) {
    const db = await open();
    const mem = await memoryWith(recall, embedder, db.brain);
    await plant(mem, 'gold', 'The bike shed code is XQ7Z, set in March.', at(0));
    for (let i = 0; i < 29; i++) {
      await plant(mem, `n${i}`, `Garden note ${i}: beds g${i}a, g${i}b, g${i}c and g${i}d were watered by the east fence.`, at(i + 1));
    }
    return { db, mem, embedder };
  }

  it('finds by exact words what the dense leg left out, in one Relevant Memories section, with no more embedding calls than dense', async () => {
    const dense = await fixture(undefined);
    const before = dense.embedder.calls;
    const d = await dense.mem.manager.assembleForPrompt(QUESTION, 1600, NEUTRAL, { scopes: U1 });
    const denseCalls = dense.embedder.calls - before;
    expect(d.contextText).not.toContain('XQ7Z');

    const hybrid = await fixture({ retrieval: 'hybrid' });
    const start = hybrid.embedder.calls;
    const h = await hybrid.mem.manager.assembleForPrompt(QUESTION, 1600, NEUTRAL, { scopes: U1 });
    expect(hybrid.embedder.calls - start).toBe(denseCalls);
    expect(h.contextText).toContain('XQ7Z');
    expect(h.contextText.match(/^## Relevant Memories/gm)).toHaveLength(1);
    expect(h.contextText).toContain(RECALL_HEADER);
    expect(h.contextText).not.toContain('## Recent Experiences');

    const c = captureOf(h);
    expect(c.retrieval).toBe('hybrid');
    expect(c.legs.map((l) => [l.leg, l.ran])).toEqual([['dense', true], ['exact_words', true], ['recency', true]]);
    expect(c.lexicalBackend).toBe(engine === 'postgres' ? 'postgres_tsvector' : 'fts5');
    expect(c.candidates[0]).toMatchObject({ id: 'gold', ranks: { dense: expect.any(Number), exact_words: 1 }, outcome: 'included', section: 'recall' });
    expect(h.allocation.semanticRecall).toBe(0);
    expect(h.allocation.recentEpisodic).toBe(0);
    expect(h.allocation.recall).toBeCloseTo(0.65, 12);
    // The whole pool is recorded: thirty traces, the twenty the cut kept and the ten after it.
    expect(c.candidates.filter((x) => x.ranks.dense !== undefined || x.ranks.exact_words !== undefined || x.ranks.recency !== undefined)).toHaveLength(30);
    for (const x of c.candidates) if (x.outcome === 'left_out') expect(['budget', 'section_full', 'dedupe']).toContain(x.reason);
    expect(c.candidates.filter((x) => x.outcome === 'included').map((x) => x.id).sort()).toEqual([...h.includedMemoryIds].sort());

    const result = await hybrid.mem.manager.retrieve(QUESTION, NEUTRAL, { scopes: U1 });
    const recall = result.diagnostics.recall as unknown as { retrieval: string; ranked: Array<{ id: string }> };
    expect(recall.retrieval).toBe('hybrid');
    expect(recall.ranked[0].id).toBe('gold');
    expect(result.retrieved.map((t) => t.id)).toContain('gold');

    await dense.mem.close();
    await dense.db.close();
    await hybrid.mem.close();
    await hybrid.db.close();
  });

  it("retrieval 'dense' set outright gives the block of no setting, byte for byte", async () => {
    const a = await fixture(undefined, new WordHashEmbedder());
    const b = await fixture({ retrieval: 'dense' }, new WordHashEmbedder());
    const unset = await a.mem.manager.assembleForPrompt(QUESTION, 1600, NEUTRAL, { scopes: U1 });
    const set = await b.mem.manager.assembleForPrompt(QUESTION, 1600, NEUTRAL, { scopes: U1 });
    expect(set.contextText).toBe(unset.contextText);
    expect(captureOf(set).retrieval).toBe('dense');
    expect(captureOf(set).legs.map((l) => l.leg)).toEqual(['dense']);
    await a.mem.close();
    await a.db.close();
    await b.mem.close();
    await b.db.close();
  });

  it('near-duplicate memories are one: the dropped one is recorded with the id it duplicated, and a re-render keeps the record', async () => {
    const { db, mem } = await fixture({ retrieval: 'hybrid' });
    await plant(mem, 'gold-again', 'The bike shed code is XQ7Z, set in March!', at(40));
    const h = await mem.manager.assembleForPrompt(QUESTION, 1600, NEUTRAL, { scopes: U1 });
    const dropped = captureOf(h).candidates.filter((x) => x.reason === 'dedupe');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ outcome: 'left_out', tokens: 0 });
    expect(['gold', 'gold-again']).toContain(dropped[0].duplicateOf);
    expect(['gold', 'gold-again']).toContain(dropped[0].id);
    expect(dropped[0].duplicateOf).not.toBe(dropped[0].id);
    expect(h.contextText.match(/XQ7Z/g)).toHaveLength(1);
    const lower = await mem.manager.reassembleForBudget!(h, 600);
    expect(captureOf(lower).candidates.filter((x) => x.reason === 'dedupe')).toEqual(dropped);
    await mem.close();
    await db.close();
  });

  it('a correction that changes a one-digit value is shown beside the memory it corrects, never dropped as its duplicate', async () => {
    const db = await open();
    const mem = await memoryWith({ retrieval: 'hybrid' }, new FlatEmbedder(), db.brain);
    await plant(mem, 'locker-old', 'My locker number is 7.', at(0));
    await plant(mem, 'locker-new', 'My locker number is 9.', at(1));
    const h = await mem.manager.assembleForPrompt('What is my locker number?', 1600, NEUTRAL, { scopes: U1 });
    expect(h.contextText).toContain('number is 7');
    expect(h.contextText).toContain('number is 9');
    expect(captureOf(h).candidates.filter((x) => x.reason === 'dedupe')).toEqual([]);
    await mem.close();
    await db.close();
  });

  it('a correction that changes a number in a long memory is shown beside the memory it corrects, never dropped as its duplicate', async () => {
    const db = await open();
    const mem = await memoryWith({ retrieval: 'hybrid' }, new FlatEmbedder(), db.brain);
    // Ten words shared and the number apart: by the Jaccard index alone (10 / 12) the two would be one memory.
    const office = 'The locker number for the downtown office beside the reception desk near the east entrance is';
    await plant(mem, 'locker-old', `${office} 7.`, at(0));
    await plant(mem, 'locker-new', `${office} 9.`, at(1));
    const h = await mem.manager.assembleForPrompt('What is the locker number for the downtown office?', 1600, NEUTRAL, { scopes: U1 });
    expect(h.contextText).toContain('entrance is 7');
    expect(h.contextText).toContain('entrance is 9');
    expect(captureOf(h).candidates.filter((x) => x.reason === 'dedupe')).toEqual([]);
    await mem.close();
    await db.close();
  });

  it('a graph association that repeats a pooled memory is not shown twice', async () => {
    const { db, mem } = await fixture({ retrieval: 'hybrid' });
    // The association's trace is below the turn's minConfidence, so no leg returns it; the graph leads to it.
    await plant(mem, 'assoc', 'The bike shed code is XQ7Z, set in March!', {
      ...at(41),
      provenance: { sourceType: 'agent_inference', sourceTimestamp: T0, confidence: 0.2, verificationCount: 0 },
    });
    (mem.manager as unknown as { graph: unknown }).graph = {
      spreadingActivation: async () => [{ memoryId: 'assoc', activation: 0.9, depth: 1, activatedBy: [] }],
      recordCoActivation: async () => undefined,
      shutdown: async () => undefined,
    };
    const h = await mem.manager.assembleForPrompt(QUESTION, 1600, NEUTRAL, { scopes: U1, minConfidence: 0.5 });
    expect(h.contextText).toContain('XQ7Z');
    expect(h.contextText.match(/XQ7Z/g)).toHaveLength(1);
    expect(h.contextText).not.toContain('## Related Context');
    await mem.close();
    await db.close();
  });

  it('a memory the dedupe dropped that Related Context shows is recorded as shown, with its line', async () => {
    const db = await open();
    const mem = await memoryWith({ retrieval: 'hybrid' }, new FlatEmbedder(), db.brain);
    // Only the answer holds the question's words, so its exact-words term puts it first whatever its dense rank:
    // 0.7 / 63 + 0.3 / 61 at worst against 0.7 / 61. The two hose notes are one memory to the dedupe, so the cut at
    // topK 1 leaves the kept one out and the graph can still lead to either.
    await plant(mem, 'key-a', 'Garden hose hangs on north wall hook.', at(0));
    await plant(mem, 'key-b', 'Garden hose hangs on north wall hook!', at(1));
    await plant(mem, 'gold', 'The bike shed code is XQ7Z.', at(2));
    (mem.manager as unknown as { graph: unknown }).graph = {
      spreadingActivation: async () => [
        { memoryId: 'key-a', activation: 0.9, depth: 1, activatedBy: [] },
        { memoryId: 'key-b', activation: 0.8, depth: 1, activatedBy: [] },
      ],
      recordCoActivation: async () => undefined,
      shutdown: async () => undefined,
    };
    const h = await mem.manager.assembleForPrompt(QUESTION, 1600, NEUTRAL, { scopes: U1, topK: 1 });
    expect(h.includedMemoryIds).toEqual(['gold']);
    const dropped = captureOf(h).candidates.filter((x) => x.duplicateOf !== undefined);
    expect(dropped).toHaveLength(1);
    const line = (h.lineOutcomes ?? []).find((l) => l.id === dropped[0].id);
    // Related Context shows the dropped memory through its association.
    expect(line).toMatchObject({ outcome: 'included', section: 'graphAssociations' });
    expect(dropped[0]).toMatchObject({ outcome: 'included', section: 'graphAssociations', tokens: line!.tokens });
    expect(dropped[0].reason).toBeUndefined();
    // Every line the block shows is an included candidate.
    for (const shown of (h.lineOutcomes ?? []).filter((l) => l.outcome === 'included')) {
      expect(captureOf(h).candidates.find((x) => x.id === shown.id)).toMatchObject({ outcome: 'included', section: shown.section });
    }
    await mem.close();
    await db.close();
  });

  it("a manager's reranker scores the pool and leaves its fused order, in the block and the record", async () => {
    const { db, mem } = await fixture({ retrieval: 'hybrid' });
    // A reranker that ranks the answer last: blended and re-sorted, it would sink the exact-words hit.
    (mem.manager as unknown as { rerankerService: unknown }).rerankerService = {
      rerank: async ({ documents }: { documents: Array<{ id: string; originalScore?: number }> }) => ({
        results: documents.map((d) => ({ id: d.id, content: '', relevanceScore: d.id === 'gold' ? 0 : 1, originalScore: d.originalScore })),
        diagnostics: { providerId: 'stub', modelId: 'stub-model', documentsProcessed: documents.length },
      }),
    };
    const h = await mem.manager.assembleForPrompt(QUESTION, 1600, NEUTRAL, { scopes: U1 });
    const c = captureOf(h);
    expect(c.candidates[0]).toMatchObject({ id: 'gold', outcome: 'included', rerankScore: 0 });
    expect(h.includedMemoryIds[0]).toBe('gold');
    expect(h.contextText.indexOf('XQ7Z')).toBeLessThan(h.contextText.indexOf('Garden note'));
    await mem.close();
    await db.close();
  });

  it('a recall the retrieval policy suppressed records no candidate, as under dense', async () => {
    const { db, mem } = await fixture({ retrieval: 'hybrid' });
    const h = await mem.manager.assembleForPrompt(QUESTION, 1600, NEUTRAL, { scopes: U1, policy: { minScore: 0.99 } });
    expect(h.contextText).not.toContain('XQ7Z');
    expect(captureOf(h).candidates).toEqual([]);
    await mem.close();
    await db.close();
  });

  it('a trace deleted while the legs run is not in the pool, the ranking or the result', async () => {
    const { db, mem } = await fixture({ retrieval: 'hybrid' });
    const store = mem.manager.getStore();
    const load = store.loadTracesForRecall.bind(store);
    let deleted = false;
    vi.spyOn(store, 'loadTracesForRecall').mockImplementation(async (ids) => {
      const out = await load(ids);
      // The first leg that loads the answer returns it; the delete lands before the other legs are done.
      if (!deleted && out.traces.has('gold')) {
        deleted = true;
        await store.softDelete('gold');
      }
      return out;
    });
    const result = await mem.manager.retrieve(QUESTION, NEUTRAL, { scopes: U1 });
    expect(deleted).toBe(true);
    expect(result.retrieved.map((t) => t.id)).not.toContain('gold');
    expect((result.diagnostics.recall as unknown as { ranked: Array<{ id: string }> }).ranked.map((r) => r.id)).not.toContain('gold');
    vi.restoreAllMocks();
    await mem.close();
    await db.close();
  });

  it.each(['dense', 'hybrid'] as const)(
    'under %s the 500-character memory with no room for it is left out whole, and the 150-character one after it is shown whole',
    async (retrieval) => {
      const db = await open();
      // Every section but recall's off, so the budget below is the recall section's room.
      const shares = { workingMemory: 0, semanticRecall: 1, recentEpisodic: 0, prospectiveAlerts: 0, graphAssociations: 0, observationNotes: 0, persistentMemory: 0 };
      const mem = await memoryWith({ retrieval }, new FlatEmbedder(), db.brain, { tokenBudget: shares });
      const words = 'bike shed code';
      const short = `The ${words} is XQ7Z. ${'Short note. '.repeat(20)}`.slice(0, 150);
      const long = `The ${words} was XQ7A before March. ${'A long, long note about the shed. '.repeat(20)}`.slice(0, 500);
      // The long one is newer, so the flat dense leg ranks it first.
      await plant(mem, 'short', short, at(0));
      await plant(mem, 'long', long, at(1));
      const store = mem.manager.getStore();
      const lineOf = (id: string) => memoryTraceLineLength(store.getTrace(id)!, 'structured', { now: Date.now() });
      // Room for the header and the short line with a little to spare, never the long line.
      const budget = Math.ceil((2 + RECALL_HEADER.length + 1 + lineOf('short')) / 4) + 4;
      expect(budget * 4).toBeLessThan(2 + 60 + 1 + lineOf('long'));

      const out = await mem.manager.assembleForPrompt(QUESTION, budget, NEUTRAL, { scopes: U1 });
      expect(out.contextText).not.toContain(' …[cut]');
      expect(out.contextText).toContain('XQ7Z');
      expect(out.contextText).not.toContain('XQ7A');
      const c = captureOf(out);
      expect(c.candidates.find((x) => x.id === 'long')).toMatchObject({ outcome: 'left_out', reason: 'section_full' });
      expect(c.candidates.find((x) => x.id === 'short')).toMatchObject({ outcome: 'included', section: retrieval === 'hybrid' ? 'recall' : 'semanticRecall' });
      await mem.close();
      await db.close();
    },
  );
});
