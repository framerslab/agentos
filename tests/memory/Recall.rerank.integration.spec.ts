/**
 * @fileoverview `memory.recall.rerank`: the memory reranker's bounds and failures (a load in progress, an unavailable
 * model, a timeout, an error, a substituted score, a back-off), each leaving the order as it was with its reason; and
 * the rerank in a turn under `dense` and `hybrid`, on a real memory: a failed rerank leaves the block of no rerank,
 * byte for byte, and one that answers reorders the cut by the blend, a reserved line after it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { resetLoggerFactory, setLogger } from '../../src/core/logging/loggerFactory';
import type { PADState } from '../../src/cognition/memory/core/config';
import type { MemoryTrace, ScoredMemoryTrace } from '../../src/cognition/memory/core/types';
import { resetRecallLogOnce } from '../../src/cognition/memory/retrieval/recall/log';
import { RecallReranker, RERANK_DEFAULTS } from '../../src/cognition/memory/retrieval/recall/rerank';
import { FlatEmbedder, U1, WordHashEmbedder } from './helpers/recallFixtures';
import { memoryWith, plant } from './helpers/recallMemory';

const NEUTRAL: PADState = { valence: 0, arousal: 0, dominance: 0 };
const T0 = Date.UTC(2026, 10, 1);

const logged: Array<Record<string, unknown>> = [];
const events = (name: string) => logged.filter((line) => line.event === name);

/** The times of the `i`th planted trace, the same in every fixture, so two fixtures render the same lines. */
const at = (i: number): Partial<MemoryTrace> => {
  const t = T0 + i * 60_000;
  return { createdAt: t, updatedAt: t, lastAccessedAt: t, provenance: { sourceType: 'user_statement', sourceTimestamp: t, confidence: 1, verificationCount: 0 } };
};

const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, content: `memory ${i}`, score: 1 - i / 100 }));
type Docs = { documents: Array<{ id: string; content: string }> };
/** A provider whose `rerank` is the given function; `initialize` and `isAvailable` as given. */
const provider = (rerank: (input: Docs) => Promise<unknown>, over: Record<string, unknown> = {}) => ({
  providerId: 'local',
  isAvailable: async () => true,
  initialize: async () => undefined,
  rerank,
  ...over,
});
/** Answers the documents in reverse order, each scored by its new place. */
const reversed = async (input: Docs) => ({
  results: [...input.documents].reverse().map((d, i) => ({ id: d.id, content: d.content, relevanceScore: 1 - i / input.documents.length })),
  diagnostics: { modelId: 'stub', providerId: 'local', latencyMs: 1, documentsProcessed: input.documents.length, providerMetrics: {} },
});
const LOCAL = { kind: 'local' as const, model: 'cross-encoder/ms-marco-MiniLM-L6-v2', revision: '233902d25c440f23af6f7d6e94d2946bac0bee0a' };
/** Lets the promise jobs queued so far run (a load's steps), with no timer moved. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  logged.length = 0;
  resetRecallLogOnce();
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(() => {
  vi.useRealTimers();
  resetLoggerFactory();
  resetRecallLogOnce();
});

describe('RecallReranker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('scores at most maxCandidates and records provider, model, revision, candidates and time', async () => {
    const seen: number[] = [];
    const r = new RecallReranker(LOCAL, { createProvider: () => provider(async (input) => { seen.push(input.documents.length); return reversed(input); }) as never });
    r.start();
    await r.ready();
    const out = await r.rerank('q', docs(35));
    expect(seen).toEqual([20]);
    expect(out.record).toEqual({ provider: 'local', model: LOCAL.model, revision: LOCAL.revision, candidates: 20, ms: expect.any(Number) });
    expect(out.scores.size).toBe(20);
  });

  it('until the load settles turns run unreranked with reason loading; a load that fails marks local unavailable once and is never tried again', async () => {
    let fail: ((e: Error) => void) | undefined;
    let loads = 0;
    const r = new RecallReranker(LOCAL, {
      createProvider: () =>
        provider(reversed, {
          initialize: () => {
            loads += 1;
            return new Promise<void>((_, reject) => {
              fail = reject;
            });
          },
        }) as never,
    });
    r.start();
    expect((await r.rerank('q', docs(3))).record).toEqual({ provider: 'none', reason: 'loading' });
    await flush();
    expect(fail, 'the load started').toBeDefined();
    fail!(new Error('fetch failed: 503'));
    await r.ready();
    for (let i = 0; i < 3; i++) expect((await r.rerank('q', docs(3))).record).toEqual({ provider: 'none', reason: 'unavailable' });
    expect(loads).toBe(1);
    expect(events('memory.recall.rerank_unavailable')).toEqual([expect.objectContaining({ provider: 'local', reason: 'load_failed' })]);
    expect(events('memory.recall.rerank_skipped').map((e) => e.reason)).toEqual(['loading']);
  });

  it('a missing dependency marks local unavailable with missing_dependency and loads nothing', async () => {
    let loads = 0;
    const r = new RecallReranker(LOCAL, {
      createProvider: () => provider(reversed, { isAvailable: async () => false, initialize: async () => { loads += 1; } }) as never,
    });
    r.start();
    await r.ready();
    expect((await r.rerank('q', docs(3))).record).toEqual({ provider: 'none', reason: 'unavailable' });
    expect(loads).toBe(0);
    expect(events('memory.recall.rerank_unavailable')).toEqual([expect.objectContaining({ reason: 'missing_dependency' })]);
  });

  it('a call past the timeout is skipped; three failures in a row back off for 60 seconds with one line; a success in between resets the count', async () => {
    let mode: 'hang' | 'ok' | 'throw' = 'hang';
    let calls = 0;
    const r = new RecallReranker(LOCAL, {
      createProvider: () =>
        provider(async (input) => {
          calls += 1;
          if (mode === 'hang') return new Promise(() => undefined);
          if (mode === 'throw') throw new Error('inference failed');
          return reversed(input);
        }) as never,
    });
    r.start();
    await r.ready();
    const timedOut = r.rerank('q', docs(3));
    await vi.advanceTimersByTimeAsync(RERANK_DEFAULTS.localTimeoutMs);
    expect((await timedOut).record).toEqual({ provider: 'none', reason: 'timeout' });
    mode = 'ok';
    expect((await r.rerank('q', docs(3))).record.provider).toBe('local'); // resets the count
    mode = 'throw';
    for (let i = 0; i < 3; i++) expect((await r.rerank('q', docs(3))).record).toEqual({ provider: 'none', reason: 'error' });
    const before = calls;
    expect((await r.rerank('q', docs(3))).record).toEqual({ provider: 'none', reason: 'backoff' });
    expect(calls).toBe(before); // the provider is not called while backed off
    expect(events('memory.recall.rerank_skipped').filter((e) => e.reason === 'backoff')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RERANK_DEFAULTS.backoffMs);
    mode = 'ok';
    expect((await r.rerank('q', docs(3))).record.provider).toBe('local');
  });

  it('a provider that substituted a score reports it, and the output is discarded as an error', async () => {
    const r = new RecallReranker(LOCAL, {
      createProvider: () =>
        provider(async (input) => {
          const out = await reversed(input);
          (out.diagnostics.providerMetrics as Record<string, unknown>).scoringFailures = 2;
          return out;
        }) as never,
    });
    r.start();
    await r.ready();
    const out = await r.rerank('q', docs(3));
    expect(out).toEqual({ record: { provider: 'none', reason: 'error' }, scores: new Map() });
    expect(events('memory.recall.rerank_failed_scoring')).toEqual([expect.objectContaining({ provider: 'local', failures: 2 })]);
  });

  it("the judge calls the host's invoke with the named model, in two phases, and a rejected invoke keeps the order with reason error", async () => {
    const calls: Array<{ system: string; model?: string }> = [];
    const invoke = async (system: string, user: string, model?: string) => {
      calls.push({ system, model });
      return system.includes('relevance scorer')
        ? JSON.stringify(Array.from({ length: (user.match(/^\[\d+\]/gm) ?? []).length }, (_, i) => i))
        : JSON.stringify(['m2', 'm1', 'm0']);
    };
    const r = new RecallReranker({ kind: 'llm', invoke, model: 'judge-model' });
    r.start();
    await r.ready();
    const out = await r.rerank('q', docs(3));
    expect(out.record).toMatchObject({ provider: 'llm', model: 'judge-model', candidates: 3 });
    expect(new Set(calls.map((c) => c.model))).toEqual(new Set(['judge-model']));
    expect(calls).toHaveLength(2);
    expect(out.scores.get('m2')).toBeGreaterThan(out.scores.get('m0')!);

    const failing = new RecallReranker({ kind: 'llm', invoke: async () => { throw new Error('provider down'); }, model: 'judge-model' });
    failing.start();
    await failing.ready();
    expect((await failing.rerank('q', docs(3))).record).toEqual({ provider: 'none', reason: 'error' });
    expect(events('memory.recall.rerank_failed_scoring').at(-1)).toMatchObject({ provider: 'llm' });
  });
});

/**
 * A judge whose scores and ranking put one trace first, the others in the order they were sent. `first` names it by its
 * id (`t7`, `n40`: the number in its text), read at each call, so a case can pick it after a run with no rerank.
 */
function judgeFirst(first: string | (() => string), seen: string[] = []) {
  const favourite = () => (typeof first === 'function' ? first() : first);
  return async (system: string, user: string): Promise<string> => {
    seen.push(user);
    if (system.includes('relevance scorer')) {
      const lines = user.split('\n').filter((line) => /^\[\d+\]/.test(line));
      return JSON.stringify(lines.map((line) => (line.includes(`note ${favourite().slice(1)}:`) ? 10 : 1)));
    }
    const ids = [...user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);
    return JSON.stringify([...ids.filter((id) => id === favourite()), ...ids.filter((id) => id !== favourite())]);
  };
}

describe('rerank in a turn', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 10, 12));
  });

  const NOTE = (i: number) => `Trail note ${i}: the overlook above switchback ${i} had the best view.`;

  it.each(['dense', 'hybrid'] as const)('under %s a rerank that fails leaves the block of rerank none, byte for byte, and the capture says why', async (retrieval) => {
    const plain = await memoryWith({ retrieval }, new WordHashEmbedder());
    const judged = await memoryWith(
      { retrieval, rerank: { kind: 'llm', invoke: async () => { throw new Error('provider down'); }, model: 'judge-model' } },
      new WordHashEmbedder(),
    );
    for (const mem of [plain, judged]) for (let i = 0; i < 8; i++) await plant(mem, `t${i}`, NOTE(i), at(i));
    const a = await plain.manager.assembleForPrompt('which switchback had the best view', 1600, NEUTRAL, { scopes: U1 });
    const b = await judged.manager.assembleForPrompt('which switchback had the best view', 1600, NEUTRAL, { scopes: U1 });
    expect(a.contextText).toContain('switchback');
    expect(b.contextText).toBe(a.contextText);
    expect(a.capture!.reranker).toEqual({ provider: 'none', reason: 'none_configured' });
    expect(b.capture!.reranker).toEqual({ provider: 'none', reason: 'error' });
    await plain.close();
    await judged.close();
  });

  it('under dense a rerank that answers blends each recalled score with its rerank score at 0.7 and 0.3, and orders the recall by the blend', async () => {
    // The judge's favourite is the trace the plain recall ranks last, named once that recall has run.
    let favourite = '';
    const plain = await memoryWith({ retrieval: 'dense' }, new WordHashEmbedder());
    const judged = await memoryWith({ retrieval: 'dense', rerank: { kind: 'llm', invoke: judgeFirst(() => favourite), model: 'judge-model' } }, new WordHashEmbedder());
    for (const mem of [plain, judged]) for (let i = 0; i < 8; i++) await plant(mem, `t${i}`, NOTE(i), at(i));
    const a = await plain.manager.retrieve('which switchback had the best view', NEUTRAL, { scopes: U1 });
    expect(a.retrieved.length).toBeGreaterThan(2);
    favourite = a.retrieved.at(-1)!.id;
    const b = await judged.manager.retrieve('which switchback had the best view', NEUTRAL, { scopes: U1 });
    expect(b.diagnostics.reranker).toMatchObject({ provider: 'llm', model: 'judge-model', candidates: a.retrieved.length });
    const rerankScores = b.diagnostics.recall!.rerankScores!;
    const before = new Map(a.retrieved.map((t) => [t.id, t.retrievalScore]));
    expect(Object.keys(rerankScores).sort()).toEqual([...before.keys()].sort());
    expect(rerankScores[favourite]).toBe(1);
    for (const trace of b.retrieved) {
      expect(trace.retrievalScore).toBeCloseTo(0.7 * before.get(trace.id)! + 0.3 * rerankScores[trace.id], 9);
    }
    const scores = b.retrieved.map((t) => t.retrievalScore);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    // The favourite, last without the rerank, moved up.
    const place = (list: ScoredMemoryTrace[]) => list.findIndex((t) => t.id === favourite);
    expect(place(b.retrieved)).toBeLessThan(place(a.retrieved));
    // The dense ranks are the dense leg's, as without the rerank.
    expect(b.diagnostics.recall!.denseRanks).toEqual(a.diagnostics.recall!.denseRanks);
    const context = await judged.manager.assembleForPrompt('which switchback had the best view', 1600, NEUTRAL, { scopes: U1 });
    expect(context.capture!.reranker).toMatchObject({ provider: 'llm', model: 'judge-model' });
    expect(context.capture!.candidates.filter((c) => c.ranks.dense !== undefined).every((c) => typeof c.rerankScore === 'number')).toBe(true);
    expect(context.capture!.timings.rerankMs).toBeGreaterThanOrEqual(0);
    await plain.close();
    await judged.close();
  });

  it('under hybrid a rerank that answers orders the cut by 0.7 x fused / best fused + 0.3 x rerank score, keeps each fused score and relevance, and puts a reserved line after it unscored', async () => {
    // A flat embedder: the dense leg cannot tell the notes apart, so the oldest, which holds the answer, is outside the
    // dense leg's sixty and only its words find it; on a memory question it is reserved past the cut.
    let favourite = '';
    const plain = await memoryWith({ retrieval: 'hybrid' }, new FlatEmbedder());
    const judged = await memoryWith({ retrieval: 'hybrid', rerank: { kind: 'llm', invoke: judgeFirst(() => favourite), model: 'judge-model' } }, new FlatEmbedder());
    for (const mem of [plain, judged]) {
      await plant(mem, 'gold', 'The bike shed code is XQ7Z, set in March.', at(0));
      for (let i = 0; i < 65; i++) await plant(mem, `n${i}`, `Garden note ${i}: the tomatoes on row ${i} were watered.`, at(i + 1));
    }

    const a = await plain.manager.retrieve('What is the bike shed code?', NEUTRAL, { scopes: U1 });
    const plainCut = a.retrieved.map((t: ScoredMemoryTrace) => t.id);
    expect(plainCut.length).toBe(20);
    // The judge's favourite is the last candidate of the cut.
    favourite = plainCut.at(-1)!;
    const run = await judged.manager.retrieve('What is the bike shed code?', NEUTRAL, { scopes: U1 });
    const ranked = run.diagnostics.recall!.ranked!;
    const rerankScores = run.diagnostics.recall!.rerankScores!;
    const cut = run.retrieved.map((t: ScoredMemoryTrace) => t.id);
    // The same candidates as without the rerank, in another order.
    expect([...cut].sort()).toEqual([...plainCut].sort());
    expect(cut).not.toEqual(plainCut);
    expect(Object.keys(rerankScores).sort()).toEqual([...cut].sort());
    expect(Object.keys(rerankScores).length).toBe(RERANK_DEFAULTS.maxCandidates);
    const fused = new Map(ranked.map((c) => [c.id, c.fusedScore]));
    const best = Math.max(...cut.map((id) => fused.get(id)!));
    const blend = (id: string) => 0.7 * (fused.get(id)! / best) + 0.3 * rerankScores[id];
    expect(cut).toEqual([...cut].sort((x, y) => blend(y) - blend(x)));
    expect(cut.indexOf(favourite)).toBeLessThan(plainCut.indexOf(favourite));
    // The fused scores stand: the pool's order and scores are those of the recall with no rerank, each scored
    // candidate carries its rerank score, and each trace keeps the relevance its line shows.
    expect(ranked.map((c) => [c.id, c.fusedScore])).toEqual(a.diagnostics.recall!.ranked!.map((c) => [c.id, c.fusedScore]));
    for (const id of cut) expect(ranked.find((c) => c.id === id)!.rerankScore).toBe(rerankScores[id]);
    const relevance = new Map(a.retrieved.map((t) => [t.id, t.retrievalScore]));
    for (const trace of run.retrieved) expect(trace.retrievalScore).toBe(relevance.get(trace.id));
    expect(run.diagnostics.reranker).toMatchObject({ provider: 'llm', model: 'judge-model', candidates: 20 });

    const asked = await judged.manager.retrieve('Do you remember the bike shed code?', NEUTRAL, { scopes: U1 });
    expect(asked.diagnostics.recall!.reserve).toEqual({ fired: true, ids: ['gold'] });
    expect(asked.retrieved.at(-1)!.id).toBe('gold');
    expect(asked.diagnostics.recall!.rerankScores!.gold).toBeUndefined();
    expect(asked.diagnostics.recall!.ranked!.find((c) => c.id === 'gold')!.rerankScore).toBeUndefined();
    await plain.close();
    await judged.close();
  });

  it('with the capture off a rerank still orders the recall, and the retrieval carries no rerank record', async () => {
    let favourite = '';
    const recorded = await memoryWith({ rerank: { kind: 'llm', invoke: judgeFirst(() => favourite), model: 'judge-model' } }, new WordHashEmbedder());
    const off = await memoryWith({ capture: 'off', rerank: { kind: 'llm', invoke: judgeFirst(() => favourite), model: 'judge-model' } }, new WordHashEmbedder());
    const plain = await memoryWith(undefined, new WordHashEmbedder());
    for (const mem of [recorded, off, plain]) for (let i = 0; i < 8; i++) await plant(mem, `t${i}`, NOTE(i), at(i));
    const p = await plain.manager.retrieve('which switchback had the best view', NEUTRAL, { scopes: U1 });
    favourite = p.retrieved.at(-1)!.id;
    const a = await recorded.manager.retrieve('which switchback had the best view', NEUTRAL, { scopes: U1 });
    const b = await off.manager.retrieve('which switchback had the best view', NEUTRAL, { scopes: U1 });
    expect(a.diagnostics.reranker).toBeDefined();
    expect(b.diagnostics.reranker).toBeUndefined();
    expect(b.diagnostics.recall).toBeUndefined();
    expect(b.retrieved.map((t) => t.id)).toEqual(a.retrieved.map((t) => t.id));
    expect(b.retrieved.map((t) => t.id)).not.toEqual(p.retrieved.map((t) => t.id));
    for (const mem of [recorded, off, plain]) await mem.close();
  });

  it('a rerank applied to a built manager reaches the next turn, and one taken away stops', async () => {
    const mem = await memoryWith(undefined, new WordHashEmbedder());
    for (let i = 0; i < 4; i++) await plant(mem, `t${i}`, NOTE(i), at(i));
    let calls = 0;
    const invoke = async (system: string, user: string) => {
      calls += 1;
      return judgeFirst('t3')(system, user);
    };
    await mem.manager.applyRecallConfig!({ rerank: { kind: 'llm', invoke, model: 'judge-model' } });
    const on = await mem.manager.assembleForPrompt('which switchback had the best view', 1600, NEUTRAL, { scopes: U1 });
    expect(on.capture!.reranker.provider).toBe('llm');
    expect(calls).toBeGreaterThan(0);
    // A call that names another setting leaves the reranker as it is.
    await mem.manager.applyRecallConfig!({ budget: { totalTokens: 1200 } });
    expect(mem.manager.getConfig().recall).toMatchObject({ budget: { totalTokens: 1200 }, rerank: { kind: 'llm', model: 'judge-model' } });
    const kept = calls;
    const still = await mem.manager.assembleForPrompt('which switchback had the best view', 1600, NEUTRAL, { scopes: U1 });
    expect(still.capture!.reranker.provider).toBe('llm');
    expect(calls).toBeGreaterThan(kept);
    const after = calls;
    await mem.manager.applyRecallConfig!({ rerank: 'none' });
    const off = await mem.manager.assembleForPrompt('which switchback had the best view', 1600, NEUTRAL, { scopes: U1 });
    expect(off.capture!.reranker).toEqual({ provider: 'none', reason: 'none_configured' });
    expect(calls).toBe(after);
    await expect(mem.manager.applyRecallConfig!({ rerank: { kind: 'cohere' } } as never)).rejects.toThrow('memory.recall.rerank');
    expect(mem.manager.getConfig().recall?.rerank).toBe('none');
    await mem.close();
  });

  it("a persona's recall.rerank reaches the manager, and the agent's own memory.recall.rerank replaces it", async () => {
    let personaCalls = 0;
    const personaRerank = {
      kind: 'llm' as const,
      model: 'persona-judge',
      invoke: async (system: string, user: string) => {
        personaCalls += 1;
        return judgeFirst('t0')(system, user);
      },
    };
    const fromPersona = await memoryWith(undefined, new WordHashEmbedder(), undefined, { recall: { rerank: personaRerank } });
    const replaced = await memoryWith({ rerank: 'none' }, new WordHashEmbedder(), undefined, { recall: { rerank: personaRerank } });
    for (const mem of [fromPersona, replaced]) for (let i = 0; i < 4; i++) await plant(mem, `t${i}`, NOTE(i), at(i));
    const a = await fromPersona.manager.assembleForPrompt('which switchback had the best view', 1600, NEUTRAL, { scopes: U1 });
    expect(a.capture!.reranker).toMatchObject({ provider: 'llm', model: 'persona-judge' });
    const seen = personaCalls;
    expect(seen).toBeGreaterThan(0);
    const b = await replaced.manager.assembleForPrompt('which switchback had the best view', 1600, NEUTRAL, { scopes: U1 });
    expect(b.capture!.reranker).toEqual({ provider: 'none', reason: 'none_configured' });
    expect(personaCalls).toBe(seen);
    await fromPersona.close();
    await replaced.close();
  });

  it("a session's view of the manager reranks as the manager does, and shutting the manager down stops the reranker", async () => {
    const seen: string[] = [];
    const mem = await memoryWith({ rerank: { kind: 'llm', invoke: judgeFirst('t0', seen), model: 'judge-model' } }, new WordHashEmbedder());
    for (let i = 0; i < 4; i++) await plant(mem, `t${i}`, NOTE(i), at(i));
    const session = mem.manager.forSession();
    const context = await session.assembleForPrompt('which switchback had the best view', 1600, NEUTRAL, { scopes: U1 });
    expect(context.capture!.reranker).toMatchObject({ provider: 'llm', model: 'judge-model' });
    expect(seen.length).toBeGreaterThan(0);
    await expect(session.recallReady!()).resolves.toBeUndefined();
    const pipeline = (mem.manager as unknown as { recall: { reranker: unknown } }).recall;
    expect(pipeline.reranker).not.toBeNull();
    await mem.close();
    expect(pipeline.reranker).toBeNull();
    await expect(mem.manager.retrieve('which switchback had the best view', NEUTRAL, { scopes: U1 })).rejects.toThrow('not initialized');
  });

  it('supplying an invoker for rerank attaches no HyDE retriever', async () => {
    const mem = await memoryWith({ rerank: { kind: 'llm', invoke: async () => '[]', model: 'judge-model' } }, new WordHashEmbedder());
    expect(mem.manager.getHydeRetriever()).toBeNull();
    await mem.close();
  });
});
