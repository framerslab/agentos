/**
 * @fileoverview The recall capture of a real CognitiveMemoryManager over an
 * InMemoryVectorStore: 25 traces encoded with a deterministic word-hash
 * embedding, one query. The capture reports every retrieved candidate with its
 * dense rank, its score and the outcome the assembler gave its line; it holds
 * no memory text and no query text; `'off'` records nothing; and the block is
 * byte-identical whatever the capture setting. Trace ids and the clock are
 * fixed, so two managers fed the same traces assemble the same block.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock('../../src/cognition/memory/core/util/crossPlatformCrypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cognition/memory/core/util/crossPlatformCrypto.js')>();
  return { ...actual, uuid: () => `id-${String(++ids.next).padStart(4, '0')}` };
});

import { CognitiveMemoryManager } from '../../src/cognition/memory/CognitiveMemoryManager.js';
import type { CognitiveMemoryConfig, PADState } from '../../src/cognition/memory/core/config.js';
import { InMemoryVectorStore } from '../../src/cognition/rag/vector_stores/InMemoryVectorStore.js';
import type { IRerankerProvider, RerankerInput, RerankerOutput } from '../../src/cognition/rag/reranking/IRerankerService.js';
import { rerankWith } from './helpers/recallMemory.js';
import type { ICognitiveMemoryManager } from '../../src/cognition/memory/CognitiveMemoryManager.js';
import { CognitiveMemoryBridge } from '../../src/cognition/substrate/CognitiveMemoryBridge.js';
import { GMIMood } from '../../src/cognition/substrate/IGMI.js';

const NEUTRAL: PADState = { valence: 0, arousal: 0, dominance: 0 };
const SCOPES = [{ scope: 'user' as const, scopeId: 'u1' }];
const QUERY = 'which trail had the best view of the lake';
const TOPICS = ['trail', 'lake', 'kitchen', 'garden', 'piano'];

/** 25 statements; the trail and lake ones share words with the query, so they rank above the rest. */
const STATEMENTS = Array.from({ length: 25 }, (_, i) => {
  const topic = TOPICS[i % TOPICS.length];
  return `Note ${i}: the ${topic} on day ${i} had a view worth keeping, number ${i * 7}.`;
});

/** A 64-dimension embedding: each word adds 1 at the slot its hash names, then the vector is normalized. */
function wordHash(text: string): number[] {
  const vector = new Array<number>(64).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (let i = 0; i < word.length; i += 1) h = (h * 31 + word.charCodeAt(i)) >>> 0;
    vector[h % 64] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

function knowledgeGraph() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    recordMemory: vi.fn().mockResolvedValue({ id: 'm', createdAt: new Date(0).toISOString(), accessCount: 0, lastAccessedAt: new Date(0).toISOString() }),
    upsertEntity: vi.fn().mockResolvedValue({ id: 'e' }),
    getEntity: vi.fn().mockResolvedValue(undefined),
    queryEntities: vi.fn().mockResolvedValue([]),
    deleteEntity: vi.fn().mockResolvedValue(true),
    upsertRelation: vi.fn().mockResolvedValue({ id: 'r' }),
    getRelations: vi.fn().mockResolvedValue([]),
    deleteRelation: vi.fn().mockResolvedValue(true),
    getMemory: vi.fn().mockResolvedValue(undefined),
    queryMemories: vi.fn().mockResolvedValue([]),
    recallMemories: vi.fn().mockResolvedValue([]),
    traverse: vi.fn().mockResolvedValue({ root: {}, levels: [], totalEntities: 0, totalRelations: 0 }),
    findPath: vi.fn().mockResolvedValue(null),
    getNeighborhood: vi.fn().mockResolvedValue({ entities: [], relations: [] }),
    semanticSearch: vi.fn().mockResolvedValue([]),
    extractFromText: vi.fn().mockResolvedValue({ entities: [], relations: [] }),
    mergeEntities: vi.fn().mockResolvedValue({}),
    decayMemories: vi.fn().mockResolvedValue(0),
    getStats: vi.fn().mockResolvedValue({ totalEntities: 0, totalRelations: 0, totalMemories: 0 }),
    clear: vi.fn().mockResolvedValue(undefined),
  };
}

function workingMemory() {
  const store = new Map<string, unknown>();
  return {
    id: 'wm',
    initialize: vi.fn().mockResolvedValue(undefined),
    set: vi.fn(async (k: string, v: unknown) => { store.set(k, v); }),
    get: vi.fn(async (k: string) => store.get(k)),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
    getAll: vi.fn(async () => Object.fromEntries(store)),
    clear: vi.fn(async () => { store.clear(); }),
    size: vi.fn(async () => store.size),
    has: vi.fn(async (k: string) => store.has(k)),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** A reranker provider under `providerId` that scores each document by its position, or throws. */
function stubReranker(providerId: string, fails = false): IRerankerProvider {
  return {
    providerId,
    isAvailable: async () => true,
    rerank: async (input: RerankerInput): Promise<RerankerOutput> => {
      if (fails) throw new Error('reranker down');
      return {
        results: input.documents.map((doc, i) => ({ id: doc.id, content: doc.content, relevanceScore: 1 - i / (input.documents.length + 1) })),
        diagnostics: { modelId: `${providerId}-model`, providerId, latencyMs: 1, documentsProcessed: input.documents.length },
      };
    },
  };
}

/**
 * A reranker provider under `providerId` that gives the last document it was sent a score of 1 and every other 0, so
 * the blend moves the dense leg's last candidate to the top; it answers after `delayMs`, or throws.
 */
function lastFirstReranker(providerId: string, options: { delayMs?: number; fails?: boolean } = {}): IRerankerProvider {
  return {
    providerId,
    isAvailable: async () => true,
    rerank: async (input: RerankerInput): Promise<RerankerOutput> => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.fails) throw new Error('reranker down');
      const last = input.documents.length - 1;
      return {
        results: input.documents.map((doc, i) => ({ id: doc.id, content: doc.content, relevanceScore: i === last ? 1 : 0 })),
        diagnostics: { modelId: `${providerId}-model`, providerId, latencyMs: 1, documentsProcessed: input.documents.length },
      };
    },
  };
}

/** A manager with ids from `id-0001`, the 25 statements encoded (semantic and episodic in turn) under user `u1`. */
async function managerWith(extra: Partial<CognitiveMemoryConfig> = {}): Promise<CognitiveMemoryManager> {
  ids.next = 0;
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: 'recall-capture', type: 'in_memory' } as never);
  const manager = new CognitiveMemoryManager();
  await manager.initialize({
    vectorStore,
    embeddingManager: {
      generateEmbeddings: async ({ texts }: { texts: string | string[] }) => ({
        embeddings: (Array.isArray(texts) ? texts : [texts]).map(wordHash),
        model: 'word-hash',
        usage: { promptTokens: 0, totalTokens: 0 },
      }),
    },
    knowledgeGraph: knowledgeGraph(),
    workingMemory: workingMemory(),
    agentId: 'capture-agent',
    traits: { openness: 0.5, conscientiousness: 0.9, emotionality: 0.2 },
    moodProvider: () => NEUTRAL,
    featureDetectionStrategy: 'keyword',
    collectionPrefix: 'capture',
    // No associations: every line the block shows is a retrieved trace's.
    graph: { disabled: true },
    ...extra,
  } as unknown as CognitiveMemoryConfig);
  for (const [i, text] of STATEMENTS.entries()) {
    await manager.encode(text, NEUTRAL, 'neutral', { type: i % 2 === 0 ? 'semantic' : 'episodic', scope: 'user', scopeId: 'u1' });
  }
  return manager;
}

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown): Set<string> {
  const keys = new Set<string>();
  JSON.parse(JSON.stringify(value), (k, v) => {
    keys.add(k);
    return v;
  });
  return keys;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 10, 10, 12));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the recall capture of a memory assembly', () => {
  it('every retrieved candidate has an outcome and a reason, the record carries no text, and the block is byte-identical with capture off and metadata', async () => {
    const on = await managerWith({ recall: { capture: 'metadata' } } as Partial<CognitiveMemoryConfig>);
    const off = await managerWith({ recall: { capture: 'off' } } as Partial<CognitiveMemoryConfig>);
    const unset = await managerWith();
    const a = await on.assembleForPrompt(QUERY, 1600, NEUTRAL, { scopes: SCOPES });
    const b = await off.assembleForPrompt(QUERY, 1600, NEUTRAL, { scopes: SCOPES });
    const d = await unset.assembleForPrompt(QUERY, 1600, NEUTRAL, { scopes: SCOPES });

    expect(a.contextText.length).toBeGreaterThan(0);
    expect(a.contextText).toBe(b.contextText);
    expect(d.contextText).toBe(b.contextText);
    expect(b.capture).toBeUndefined();
    // No setting means metadata.
    expect(d.capture?.version).toBe('memory-recall-capture/1');

    const c = a.capture!;
    expect(c.version).toBe('memory-recall-capture/1');
    expect(c.retrieval).toBe('dense');
    expect(c.budget).toEqual({ requested: 1600, effective: 1600 });
    expect(c.tokensUsed).toBe(a.tokensUsed);
    expect(c.allocation).toEqual(a.allocation);
    expect(c.lexicalBackend).toBe('none');
    expect(c.reranker).toEqual({ provider: 'none', reason: 'none_configured' });
    expect(c.memoryQuestionReserve).toEqual({ fired: false, added: 0 });
    expect(c.candidates.length).toBeGreaterThan(0);
    expect(c.legs).toEqual([{ leg: 'dense', ran: true, candidates: c.candidates.length, ineligible: 0, ms: expect.any(Number) }]);
    // Dense ranks are 1..n in the order recall ranked them, by falling score.
    expect(c.candidates.map((x) => x.ranks)).toEqual(c.candidates.map((_, i) => ({ dense: i + 1 })));
    for (let i = 1; i < c.candidates.length; i += 1) {
      expect(c.candidates[i - 1].fusedScore).toBeGreaterThanOrEqual(c.candidates[i].fusedScore);
    }
    for (const cand of c.candidates) {
      expect(['included', 'left_out']).toContain(cand.outcome);
      if (cand.outcome === 'left_out') expect(['budget', 'section_full']).toContain(cand.reason);
      else expect(cand.reason).toBeUndefined();
      expect(cand.tokens).toBeGreaterThan(0);
      expect(['semanticRecall', 'recentEpisodic']).toContain(cand.section);
    }
    expect(c.candidates.filter((x) => x.outcome === 'included').map((x) => x.id).sort()).toEqual([...a.includedMemoryIds].sort());
    for (const key of ['legsMs', 'fuseMs', 'dedupeMs', 'rerankMs', 'assembleMs', 'totalMs'] as const) {
      expect(Number.isInteger(c.timings[key]) && c.timings[key] >= 0).toBe(true);
    }

    const keys = keysOf(c);
    for (const forbidden of ['content', 'text', 'contextText', 'query']) expect(keys.has(forbidden)).toBe(false);
    const json = JSON.stringify(c);
    expect(json).not.toContain('view worth keeping');
    expect(json).not.toContain('best view of the lake');
  });

  it('at a budget too small for every memory, the ones left out say why, and the record still matches the block', async () => {
    const manager = await managerWith();
    const context = await manager.assembleForPrompt(QUERY, 220, NEUTRAL, { scopes: SCOPES });
    const c = context.capture!;
    const leftOut = c.candidates.filter((x) => x.outcome === 'left_out');
    expect(leftOut.length).toBeGreaterThan(0);
    for (const cand of leftOut) expect(['budget', 'section_full']).toContain(cand.reason);
    expect(c.candidates.filter((x) => x.outcome === 'included').map((x) => x.id).sort()).toEqual([...context.includedMemoryIds].sort());
    expect(c.tokensUsed).toBe(context.tokensUsed);
    expect(c.tokensUsed).toBeLessThanOrEqual(220);
  });

  it('names the reranker recall.rerank names: the LLM judge with its model, the local model with its revision, and a rerank that failed with the reason', async () => {
    // The judge through the setting: a score for each memory it is sent, then a ranking of them in the order it was given.
    const judge = async (system: string, user: string): Promise<string> =>
      system.includes('relevance scorer')
        ? JSON.stringify((user.match(/^\[\d+\]/gm) ?? []).map((_, i) => 10 - (i % 10)))
        : JSON.stringify([...user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]));
    const llm = await managerWith({ recall: { rerank: { kind: 'llm', invoke: judge, model: 'judge-ranker' } } } as Partial<CognitiveMemoryConfig>);
    const c = (await llm.assembleForPrompt(QUERY, 1600, NEUTRAL, { scopes: SCOPES })).capture!;
    expect(c.legs[0].candidates).toBeGreaterThan(0);
    expect(c.reranker).toEqual({ provider: 'llm', model: 'judge-ranker', candidates: Math.min(c.legs[0].candidates, 20), ms: expect.any(Number) });

    const local = await managerWith();
    await rerankWith(local, stubReranker('local'));
    const d = (await local.assembleForPrompt(QUERY, 1600, NEUTRAL, { scopes: SCOPES })).capture!;
    expect(d.reranker).toEqual({ provider: 'local', model: 'stub-model', revision: 'r1', candidates: Math.min(d.legs[0].candidates, 20), ms: expect.any(Number) });

    const failingJudge = async (): Promise<string> => {
      throw new Error('judge down');
    };
    const failing = await managerWith({ recall: { rerank: { kind: 'llm', invoke: failingJudge, model: 'judge-ranker' } } } as Partial<CognitiveMemoryConfig>);
    const e = (await failing.assembleForPrompt(QUERY, 1600, NEUTRAL, { scopes: SCOPES })).capture!;
    expect(e.reranker).toEqual({ provider: 'none', reason: 'error' });
    expect(e.candidates.length).toBeGreaterThan(0);
    for (const cand of e.candidates) expect('rerankScore' in cand).toBe(false);
  });

  it("a rerank that reorders the candidates leaves each one's dense rank as the dense leg gave it, with the reranker's own score beside it", async () => {
    const manager = await managerWith();
    await rerankWith(manager, lastFirstReranker('local'));
    const c = (await manager.assembleForPrompt(QUERY, 1600, NEUTRAL, { scopes: SCOPES })).capture!;
    const n = c.candidates.length;
    expect(n).toBeGreaterThan(2);
    expect(n).toBeLessThanOrEqual(20);
    // The dense leg's last candidate leads after the blend; the rest keep their dense order behind it.
    expect(c.candidates.map((x) => x.ranks.dense)).toEqual([n, ...Array.from({ length: n - 1 }, (_, i) => i + 1)]);
    expect(c.candidates.map((x) => x.rerankScore)).toEqual([1, ...Array.from({ length: n - 1 }, () => 0)]);
    for (let i = 1; i < n; i += 1) expect(c.candidates[i - 1].fusedScore).toBeGreaterThanOrEqual(c.candidates[i].fusedScore);
  });

  it("a recall of no rerank keeps rerankScore off every candidate", async () => {
    const manager = await managerWith();
    const c = (await manager.assembleForPrompt(QUERY, 1600, NEUTRAL, { scopes: SCOPES })).capture!;
    for (const cand of c.candidates) expect('rerankScore' in cand).toBe(false);
  });

  it("the dense leg's time is its own recall's, not the rerank's", async () => {
    vi.useRealTimers();
    const manager = await managerWith();
    await rerankWith(manager, lastFirstReranker('local', { delayMs: 250 }));
    const c = (await manager.assembleForPrompt(QUERY, 1600, NEUTRAL, { scopes: SCOPES })).capture!;
    expect(c.reranker.ms).toBeGreaterThanOrEqual(240);
    expect(c.timings.rerankMs).toBe(c.reranker.ms);
    expect(c.legs[0].ms).toBeLessThan(200);
    expect(c.timings.totalMs).toBeGreaterThanOrEqual(c.reranker.ms!);
  });

  it('a recall larger than maxCandidates sends the reranker its best 20, or as many as the setting names, and the rest keep their order after them', async () => {
    for (const [maxCandidates, sent] of [[undefined, 20], [5, 5]] as Array<[number | undefined, number]>) {
      const sizes: number[] = [];
      const lastFirst = lastFirstReranker('local');
      const counting: IRerankerProvider = {
        providerId: 'local',
        isAvailable: async () => true,
        rerank: async (input, config) => {
          sizes.push(input.documents.length);
          return lastFirst.rerank(input, config);
        },
      };
      const manager = await managerWith();
      await rerankWith(manager, counting, maxCandidates === undefined ? {} : { maxCandidates });
      const c = (await manager.assembleForPrompt(QUERY, 1600, NEUTRAL, { scopes: SCOPES, topK: 40 })).capture!;
      const n = c.candidates.length;
      expect(c.legs[0].candidates, `maxCandidates ${maxCandidates}`).toBeGreaterThan(20);
      expect(sizes, `maxCandidates ${maxCandidates}`).toEqual([sent]);
      expect(c.reranker.candidates, `maxCandidates ${maxCandidates}`).toBe(sent);
      // The last candidate sent leads; the others sent follow in their dense order, then the ones not sent, unscored.
      expect(c.candidates.map((x) => x.ranks.dense)).toEqual([sent, ...Array.from({ length: sent - 1 }, (_, i) => i + 1), ...Array.from({ length: n - sent }, (_, i) => sent + i + 1)]);
      expect(c.candidates.slice(sent).every((x) => !('rerankScore' in x))).toBe(true);
    }
  });

  it('a rerank that fails after the back-off began is recorded backoff, and the provider is not called', async () => {
    let calls = 0;
    const down: IRerankerProvider = {
      providerId: 'local',
      isAvailable: async () => true,
      rerank: async () => {
        calls += 1;
        throw new Error('reranker down');
      },
    };
    const manager = await managerWith();
    await rerankWith(manager, down);
    const reasons: Array<string | undefined> = [];
    for (let turn = 0; turn < 4; turn += 1) {
      reasons.push((await manager.assembleForPrompt(QUERY, 1600, NEUTRAL, { scopes: SCOPES })).capture!.reranker.reason);
    }
    expect(reasons).toEqual(['error', 'error', 'error', 'backoff']);
    expect(calls).toBe(3);
  });

  it("the dense leg's time takes in the graph's activation, which orders the dense ranks, and not the co-activation it records after", async () => {
    vi.useRealTimers();
    const manager = await managerWith();
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // A memory graph whose activation takes 150 ms and whose co-activation write takes 300 ms.
    (manager as unknown as { graph: unknown }).graph = {
      spreadingActivation: async () => {
        await wait(150);
        return [];
      },
      recordCoActivation: async () => {
        await wait(300);
      },
    };
    const c = (await manager.assembleForPrompt(QUERY, 1600, NEUTRAL, { scopes: SCOPES })).capture!;
    expect(c.legs[0].ms).toBeGreaterThanOrEqual(140);
    expect(c.legs[0].ms).toBeLessThan(400);
  });
});

describe("recall capture 'off'", () => {
  /**
   * A GMI's bridge over `manager`, its user `u1`, with each assembly asked at `budget` tokens instead of the bridge's
   * 1600; returns the details of each "Cognitive memory context assembled." entry the bridge traces.
   */
  function bridgeOver(manager: CognitiveMemoryManager, budget: number) {
    const entries: Array<Record<string, unknown>> = [];
    const atBudget = {
      getConfig: () => manager.getConfig(),
      assembleForPrompt: (query: string, _budget: number, mood: PADState, options: unknown) =>
        manager.assembleForPrompt(query, budget, mood, options as never),
    } as unknown as ICognitiveMemoryManager;
    const bridge = new CognitiveMemoryBridge(
      atBudget,
      () => GMIMood.NEUTRAL,
      () => ({ userId: 'u1' }) as never,
      () => 'capture-persona',
      () => 'capture-gmi',
      (_type, message, details) => {
        if (message === 'Cognitive memory context assembled.') entries.push(details ?? {});
      },
    );
    return { bridge, entries };
  }

  it("the bridge's trace entry counts the lines the block left out, as it does with the capture on", async () => {
    const off = await managerWith({ recall: { capture: 'off' } } as Partial<CognitiveMemoryConfig>);
    const on = await managerWith({ recall: { capture: 'metadata' } } as Partial<CognitiveMemoryConfig>);
    const offBridge = bridgeOver(off, 220);
    const onBridge = bridgeOver(on, 220);
    const offContext = await offBridge.bridge.assembleContext(QUERY);
    const onContext = await onBridge.bridge.assembleContext(QUERY);
    expect(offContext?.capture).toBeUndefined();
    expect(offContext?.contextText).toBe(onContext?.contextText);

    const lines = offContext!.lineOutcomes ?? [];
    const leftOutLines = lines.filter((line) => line.outcome === 'left_out').length;
    expect(leftOutLines).toBeGreaterThan(0);
    expect(offBridge.entries).toHaveLength(1);
    const entry = offBridge.entries[0];
    expect(entry.candidates).toBe(lines.length);
    expect(entry.included).toBe(offContext!.includedMemoryIds.length);
    expect(entry.leftOut).toBe(leftOutLines);
    expect((entry.included as number) + (entry.leftOut as number)).toBe(entry.candidates);
    // The same counts the capture gives the entry when it is on.
    const onEntry = onBridge.entries[0];
    expect({ candidates: entry.candidates, included: entry.included, leftOut: entry.leftOut }).toEqual({
      candidates: onEntry.candidates,
      included: onEntry.included,
      leftOut: onEntry.leftOut,
    });
  });

  it("the bridge's trace entry names the hybrid recall the manager is set to run, with no record to read it from", async () => {
    const off = await managerWith({ recall: { capture: 'off', retrieval: 'hybrid' } } as Partial<CognitiveMemoryConfig>);
    const offBridge = bridgeOver(off, 1600);
    const context = await offBridge.bridge.assembleContext(QUERY);
    expect(context?.capture).toBeUndefined();
    expect(offBridge.entries).toHaveLength(1);
    expect(offBridge.entries[0].retrieval).toBe('hybrid');
  });

  it('a retrieval builds no recall report and no rerank record, and the rerank still orders the traces', async () => {
    const on = await managerWith({ recall: { capture: 'metadata' } } as Partial<CognitiveMemoryConfig>);
    await rerankWith(on, lastFirstReranker('local'));
    const off = await managerWith({ recall: { capture: 'off' } } as Partial<CognitiveMemoryConfig>);
    await rerankWith(off, lastFirstReranker('local'));
    const a = await on.retrieve(QUERY, NEUTRAL, { scopes: SCOPES });
    const b = await off.retrieve(QUERY, NEUTRAL, { scopes: SCOPES });
    expect(a.diagnostics.recall).toBeDefined();
    expect(a.diagnostics.reranker).toBeDefined();
    expect(b.retrieved.length).toBeGreaterThan(2);
    expect(b.retrieved.map((trace) => trace.id)).toEqual(a.retrieved.map((trace) => trace.id));
    expect(b.diagnostics.recall).toBeUndefined();
    expect(b.diagnostics.reranker).toBeUndefined();
  });
});
