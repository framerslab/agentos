/**
 * @fileoverview A real CognitiveMemoryManager's recall through its recall pipeline, on the dense leg: the ranking is
 * the one the manager returned before the pipeline, id for id and score for score; a query the embedder answers with
 * no vector records the dense leg absent with `no_embedder` and writes one line for the process; an embedding call
 * that throws rejects `retrieve()` as before and is known as an embedding failure; and the trust-policy drops are
 * counted on the leg.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { CognitiveMemoryManager } from '../../src/cognition/memory/CognitiveMemoryManager.js';
import type { CognitiveMemoryConfig, PADState } from '../../src/cognition/memory/core/config.js';
import { InMemoryVectorStore } from '../../src/cognition/rag/vector_stores/InMemoryVectorStore.js';
import { isQueryEmbeddingFailure } from '../../src/cognition/memory/retrieval/store/MemoryStore.js';
import { resetRecallLogOnce } from '../../src/cognition/memory/retrieval/recall/log.js';
import { resetLoggerFactory, setLogger } from '../../src/core/logging/loggerFactory.js';
import { U1, WordHashEmbedder, trace } from './helpers/recallFixtures';

const NEUTRAL: PADState = { valence: 0, arousal: 0, dominance: 0 };

/**
 * The ranking `retrieve()` returned at the commit before the recall pipeline (read from that run's failure), for the
 * 25 trail notes below: each trace's content prefix and its retrieval score to six places.
 */
const RANKING_BEFORE_THE_PIPELINE: Array<[string, number]> = [
  ['Trail note 15', 0.482209],
  ['Trail note 16', 0.474071],
  ['Trail note 11', 0.466319],
  ['Trail note 12', 0.466319],
  ['Trail note 13', 0.466319],
  ['Trail note 18', 0.466319],
  ['Trail note 19', 0.466319],
  ['Trail note 20', 0.466319],
  ['Trail note 21', 0.466319],
  ['Trail note 8:', 0.464362],
  ['Trail note 22', 0.464362],
  ['Trail note 1:', 0.458398],
  ['Trail note 0:', 0.455227],
  ['Trail note 4:', 0.455227],
  ['Trail note 5:', 0.455227],
  ['Trail note 6:', 0.455227],
  ['Trail note 7:', 0.455227],
  ['Trail note 9:', 0.455227],
  ['Trail note 10', 0.455227],
  ['Trail note 14', 0.455227],
];

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
  const held = new Map<string, unknown>();
  return {
    id: 'wm',
    initialize: vi.fn().mockResolvedValue(undefined),
    set: vi.fn(async (k: string, v: unknown) => {
      held.set(k, v);
    }),
    get: vi.fn(async (k: string) => held.get(k)),
    delete: vi.fn(async (k: string) => {
      held.delete(k);
    }),
    getAll: vi.fn(async () => Object.fromEntries(held)),
    clear: vi.fn(async () => {
      held.clear();
    }),
    size: vi.fn(async () => held.size),
    has: vi.fn(async (k: string) => held.has(k)),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** A manager over an InMemoryVectorStore with `embedder` and no graph. */
async function managerWith(extra: Partial<CognitiveMemoryConfig>, embedder: WordHashEmbedder): Promise<CognitiveMemoryManager> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: `recall-pipeline-${Math.random().toString(36).slice(2)}`, type: 'in_memory' } as never);
  const manager = new CognitiveMemoryManager();
  await manager.initialize({
    vectorStore,
    embeddingManager: embedder,
    knowledgeGraph: knowledgeGraph(),
    workingMemory: workingMemory(),
    agentId: 'pipeline-agent',
    traits: { openness: 0.5, conscientiousness: 0.9, emotionality: 0.2 },
    moodProvider: () => NEUTRAL,
    featureDetectionStrategy: 'keyword',
    collectionPrefix: 'pipeline',
    graph: { disabled: true },
    ...extra,
  } as unknown as CognitiveMemoryConfig);
  return manager;
}

const logged: Array<Record<string, unknown>> = [];
const events = (name: string) => logged.filter((line) => line.event === name);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 10, 10, 12));
  resetRecallLogOnce();
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(() => {
  vi.useRealTimers();
  resetLoggerFactory();
  resetRecallLogOnce();
});

describe('recall through the pipeline, dense', () => {
  it('returns the ranking the manager returned before the pipeline, id for id and score for score', async () => {
    const manager = await managerWith({}, new WordHashEmbedder());
    for (let i = 0; i < 25; i++) {
      await manager.encode(`Trail note ${i}: the overlook above switchback ${i % 7} had the best view of the season.`, NEUTRAL, 'neutral', {
        type: i % 2 ? 'episodic' : 'semantic',
        scope: 'user',
        scopeId: 'u1',
      });
    }
    const result = await manager.retrieve('which switchback had the best view', NEUTRAL, { scopes: U1 });
    const ranking = result.retrieved.map((t) => [t.content.slice(0, 13), Number(t.retrievalScore.toFixed(6))]);
    expect(ranking, JSON.stringify(ranking)).toEqual(RANKING_BEFORE_THE_PIPELINE);
    expect(result.diagnostics.recall).toMatchObject({
      legs: [{ leg: 'dense', ran: true, candidates: result.retrieved.length, ineligible: 0 }],
    });
    expect(result.retrieved.map((t) => result.diagnostics.recall!.denseRanks[t.id])).toEqual(result.retrieved.map((_, i) => i + 1));
  });

  it('a query the embedder returns no vector for: no results, the dense leg absent with no_embedder in the capture, one line for the process', async () => {
    const embedder = new WordHashEmbedder();
    const manager = await managerWith({}, embedder);
    await manager.encode('The ferry leaves from pier 3.', NEUTRAL, 'neutral', { scope: 'user', scopeId: 'u1' });
    embedder.empty = true;
    const first = await manager.assembleForPrompt('which pier', 1600, NEUTRAL, { scopes: U1 });
    await manager.assembleForPrompt('which pier', 1600, NEUTRAL, { scopes: U1 });
    expect(first.capture!.legs).toEqual([{ leg: 'dense', ran: false, reason: 'no_embedder', candidates: 0, ineligible: 0, ms: expect.any(Number) }]);
    expect(first.capture!.candidates).toEqual([]);
    // Two turns, one line.
    expect(events('memory.recall.leg_absent')).toEqual([expect.objectContaining({ leg: 'dense', reason: 'no_embedder' })]);
  });

  it('an embedding call that throws rejects retrieve() as before, and is known as an embedding failure', async () => {
    const embedder = new WordHashEmbedder();
    const manager = await managerWith({}, embedder);
    await manager.encode('The ferry leaves from pier 3.', NEUTRAL, 'neutral', { scope: 'user', scopeId: 'u1' });
    embedder.fail = true;
    const error = await manager.retrieve('which pier', NEUTRAL, { scopes: U1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('embedding provider down');
    expect(isQueryEmbeddingFailure(error)).toBe(true);
    expect(isQueryEmbeddingFailure(new Error('embedding provider down'))).toBe(false);
  });

  it('usableFor drops are counted on the dense leg', async () => {
    const manager = await managerWith({}, new WordHashEmbedder());
    await manager.getStore().store(trace('open', 'The harbor pass is in the blue folder.'));
    await manager
      .getStore()
      .store(trace('closed', 'The harbor pass number is 7781.', { policy: { usableForAuthorization: false, usableForPersonalization: true, usableForFactClaim: true } }));
    const result = await manager.retrieve('harbor pass', NEUTRAL, { scopes: U1, usableFor: 'authorization' });
    expect(result.retrieved.map((t) => t.id)).toEqual(['open']);
    expect(result.diagnostics.recall!.legs).toEqual([{ leg: 'dense', ran: true, candidates: 1, ineligible: 1, ms: expect.any(Number) }]);
  });
});
