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
import { RerankerService } from '../../src/cognition/rag/reranking/RerankerService.js';
import type { IRerankerProvider, RerankerInput, RerankerOutput } from '../../src/cognition/rag/reranking/IRerankerService.js';

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

  it("names the reranker of a manager's rerankerService: the LLM judge, the local cross-encoder, any other provider, and a rerank that failed", async () => {
    const cases: Array<[string, boolean, Record<string, unknown>]> = [
      ['llm-judge', false, { provider: 'llm', model: 'llm-judge-model' }],
      ['local', false, { provider: 'local', model: 'local-model' }],
      ['cohere', false, { provider: 'other', model: 'cohere-model' }],
      ['llm-judge', true, { provider: 'none', reason: 'error' }],
    ];
    for (const [providerId, fails, expected] of cases) {
      const rerankerService = new RerankerService({ config: { providers: [{ providerId }], defaultProviderId: providerId } });
      rerankerService.registerProvider(stubReranker(providerId, fails));
      const manager = await managerWith({ rerankerService } as Partial<CognitiveMemoryConfig>);
      const c = (await manager.assembleForPrompt(QUERY, 1600, NEUTRAL, { scopes: SCOPES })).capture!;
      expect(c.reranker, `${providerId}${fails ? ' failing' : ''}`).toEqual({ ...expected, candidates: expect.any(Number), ms: expect.any(Number) });
      expect(c.reranker.candidates).toBeGreaterThan(0);
    }
  });
});
