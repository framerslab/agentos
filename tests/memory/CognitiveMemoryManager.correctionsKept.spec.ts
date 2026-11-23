/**
 * @fileoverview What reconsolidation and temporal gist leave alone, on the real manager, store and mechanisms engine
 * over an in-memory vector store:
 *
 * - A trace tagged `correction` keeps its emotional context when a recall reads it with reconsolidation on, and keeps
 *   its text through a consolidation cycle with temporal gist on. A trace without the tag drifts and is gisted.
 * - A recall with `skipReconsolidation` leaves the emotional context of every trace it reads, and still counts the
 *   access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CognitiveMemoryManager } from '../../src/cognition/memory/CognitiveMemoryManager.js';
import type { CognitiveMemoryConfig, PADState } from '../../src/cognition/memory/core/config.js';
import type { MemoryTrace } from '../../src/cognition/memory/core/types.js';
import type { IVectorStore, VectorDocument, QueryResult } from '../../src/cognition/rag/IVectorStore.js';
import type { IEmbeddingManager } from '../../src/cognition/rag/IEmbeddingManager.js';
import type { IKnowledgeGraph } from '../../src/cognition/memory/retrieval/graph/knowledge/IKnowledgeGraph.js';
import type { IWorkingMemory } from '../../src/cognition/substrate/memory/IWorkingMemory.js';

function createVectorStore(): IVectorStore {
  const collections = new Map<string, VectorDocument[]>();
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    createCollection: vi.fn().mockResolvedValue(undefined),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    collectionExists: vi.fn(async (n: string) => collections.has(n)),
    upsert: vi.fn(async (c: string, docs: VectorDocument[]) => {
      const existing = collections.get(c) ?? [];
      for (const d of docs) {
        const i = existing.findIndex((e) => e.id === d.id);
        if (i >= 0) existing[i] = d;
        else existing.push(d);
      }
      collections.set(c, existing);
      return { succeeded: docs.length, failed: 0 };
    }),
    query: vi.fn(async (c: string): Promise<QueryResult> => ({
      documents: (collections.get(c) ?? []).map((d) => ({ ...d, similarityScore: 0.85 })),
    })),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteByIds: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({ documentCount: 0, vectorCount: 0 }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as IVectorStore;
}

function createEmbeddingManager(): IEmbeddingManager {
  return {
    generateEmbeddings: vi.fn(async () => ({ embeddings: [[0.1, 0.2, 0.3, 0.4]], model: 'mock', tokensUsed: 10 })),
    getDimension: vi.fn().mockReturnValue(4),
  } as unknown as IEmbeddingManager;
}

function createKnowledgeGraph(): IKnowledgeGraph {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    recordMemory: vi.fn().mockResolvedValue({ id: 'mem-1', createdAt: new Date().toISOString(), accessCount: 0, lastAccessedAt: new Date().toISOString() }),
    upsertEntity: vi.fn().mockResolvedValue({ id: 'e-1' }),
    getEntity: vi.fn().mockResolvedValue(undefined),
    queryEntities: vi.fn().mockResolvedValue([]),
    deleteEntity: vi.fn().mockResolvedValue(true),
    upsertRelation: vi.fn().mockResolvedValue({ id: 'r-1' }),
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
  } as unknown as IKnowledgeGraph;
}

function createWorkingMemory(): IWorkingMemory {
  const store = new Map<string, unknown>();
  return {
    id: 'mock-wm',
    initialize: vi.fn().mockResolvedValue(undefined),
    set: vi.fn(async (k: string, v: unknown) => { store.set(k, v); }),
    get: vi.fn(async (k: string) => store.get(k)),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
    getAll: vi.fn(async () => Object.fromEntries(store)),
    clear: vi.fn(async () => { store.clear(); }),
    size: vi.fn(async () => store.size),
    has: vi.fn(async (k: string) => store.has(k)),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as IWorkingMemory;
}

/** The mood every trace is stored with. */
const NEUTRAL: PADState = { valence: 0, arousal: 0, dominance: 0 };
/** The mood a recall drifts what it reads toward. */
const ELATED: PADState = { valence: 0.9, arousal: 0.9, dominance: 0.9 };
const SCOPE = [{ scope: 'user' as const, scopeId: 'test-agent' }];
/** A text longer than the thirty words a gist keeps. */
const LONG = Array.from({ length: 48 }, (_, i) => `word${i}`).join(' ');

/** A copy of a trace's emotional context, as it stands now. */
const emotionsOf = (trace: MemoryTrace) => ({ ...trace.emotionalContext });
/** The drift record reconsolidation leaves on a trace it moved; undefined on a trace it never moved. */
const driftsOf = (trace: MemoryTrace): unknown =>
  (trace.structuredData as { mechanismMetadata?: { driftHistory?: unknown } } | undefined)?.mechanismMetadata?.driftHistory;

describe('what reconsolidation and temporal gist leave alone', () => {
  let manager: CognitiveMemoryManager;

  beforeEach(async () => {
    manager = new CognitiveMemoryManager();
    await manager.initialize({
      vectorStore: createVectorStore(),
      embeddingManager: createEmbeddingManager(),
      knowledgeGraph: createKnowledgeGraph(),
      workingMemory: createWorkingMemory(),
      agentId: 'test-agent',
      traits: { openness: 0.7, conscientiousness: 0.6, emotionality: 0.5 },
      moodProvider: () => ELATED,
      featureDetectionStrategy: 'keyword',
      collectionPrefix: 'test',
      // The pipeline is built for a cycle run by hand; no timer is armed.
      consolidation: { enabled: false },
      // Both mechanisms forced on, each set to act on the first trace it is shown.
      cognitiveMechanisms: {
        reconsolidation: { enabled: true, driftRate: 1, maxDriftPerTrace: 10 },
        temporalGist: { enabled: true, ageThresholdDays: 0, minRetrievalCount: 99 },
      },
    } as CognitiveMemoryConfig);
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  /** The trace as the manager's store holds it. */
  const stored = (id: string): MemoryTrace => manager.getStore().getTrace(id)!;

  it('a trace tagged correction keeps its emotional context when a recall reads it; another trace drifts', async () => {
    const correction = await manager.encode('The canary is named LARK-7.', NEUTRAL, 'neutral', { tags: ['correction'] });
    const plain = await manager.encode('The canary sings in the morning.', NEUTRAL, 'neutral', { tags: ['note'] });
    const before = emotionsOf(stored(correction.id));
    const plainBefore = emotionsOf(stored(plain.id));

    const result = await manager.retrieve('canary', NEUTRAL, { scopes: SCOPE });

    expect(result.retrieved.map((trace) => trace.id).sort()).toEqual([correction.id, plain.id].sort());
    expect(emotionsOf(stored(correction.id))).toEqual(before);
    expect(driftsOf(stored(correction.id))).toBeUndefined();
    // The access is counted all the same.
    expect(stored(correction.id).accessCount).toBe(1);
    // Reconsolidation is on: the trace without the tag moved toward the mood of the recall.
    expect(emotionsOf(stored(plain.id))).not.toEqual(plainBefore);
    expect(driftsOf(stored(plain.id))).toHaveLength(1);
  });

  it('a trace tagged correction keeps its text through a consolidation cycle; another trace is gisted', async () => {
    const correction = await manager.encode(`Corrected: ${LONG}`, NEUTRAL, 'neutral', { tags: ['correction'] });
    const plain = await manager.encode(`Noted: ${LONG}`, NEUTRAL, 'neutral', { tags: ['note'] });

    await manager.runConsolidation();

    expect(stored(correction.id).content).toBe(`Corrected: ${LONG}`);
    // Temporal gist is on: the trace without the tag was cut to its first words.
    expect(stored(plain.id).content).not.toBe(`Noted: ${LONG}`);
    expect(stored(plain.id).content.length).toBeLessThan(`Noted: ${LONG}`.length);
  });

  it('a recall that skips reconsolidation leaves the emotional context of what it reads, and counts the access', async () => {
    const first = await manager.encode('The canary is named LARK-7.', NEUTRAL, 'neutral', { tags: ['note'] });
    const second = await manager.encode('The canary sings in the morning.', NEUTRAL, 'neutral', { tags: ['note'] });
    const before = [first, second].map((trace) => emotionsOf(stored(trace.id)));
    const stabilityBefore = stored(first.id).stability;

    const result = await manager.retrieve('canary', NEUTRAL, { scopes: SCOPE, skipReconsolidation: true });

    expect(result.retrieved).toHaveLength(2);
    expect([first, second].map((trace) => emotionsOf(stored(trace.id)))).toEqual(before);
    for (const trace of [first, second]) {
      expect(driftsOf(stored(trace.id))).toBeUndefined();
      expect(stored(trace.id).accessCount).toBe(1);
      expect(stored(trace.id).retrievalCount).toBe(1);
    }
    // The spaced-repetition update of the access still ran.
    expect(stored(first.id).stability).toBeGreaterThan(stabilityBefore);

    // The next recall, with no skip, drifts them.
    await manager.retrieve('canary', NEUTRAL, { scopes: SCOPE });
    expect(driftsOf(stored(first.id))).toHaveLength(1);
  });
});
