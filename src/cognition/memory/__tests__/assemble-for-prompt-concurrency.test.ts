/**
 * assembleForPrompt latency behavior:
 *
 * 1. The independent pre-assembly stages — retrieval (vector search), the
 *    persistent-memory read, and the prospective trigger check (query embed +
 *    check) — run CONCURRENTLY, not as stacked serial awaits. Verified by
 *    gating the vector store's query on a manual latch and asserting the
 *    sibling stages already started while retrieval is still in flight.
 * 2. The prospective stage is best-effort like every other auxiliary stage
 *    (persistent read, graph associations): a throwing prospective backend
 *    degrades to "no alerts" instead of failing the whole turn's assembly.
 * 3. A failing persistent-memory read still degrades to `undefined` (existing
 *    contract, preserved across the concurrency refactor).
 *
 * Graph associations intentionally stay AFTER retrieval — they seed from the
 * retrieved trace ids, so that edge is a real data dependency.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CognitiveMemoryManager } from '../CognitiveMemoryManager';
import type { PADState } from '../core/config.js';

const MOOD: PADState = { valence: 0, arousal: 0.3, dominance: 0 };

function makeMocks() {
  const mockKnowledgeGraph = {
    initialize: vi.fn(),
    upsertEntity: vi.fn(),
    upsertRelation: vi.fn(),
    queryEntities: vi.fn().mockResolvedValue([]),
    getNeighborhood: vi.fn().mockResolvedValue({ entities: [], relations: [] }),
    getRelations: vi.fn().mockResolvedValue([]),
    deleteEntity: vi.fn(),
    deleteRelation: vi.fn(),
    traverse: vi.fn().mockResolvedValue({
      root: {
        id: 'root',
        type: 'memory',
        label: 'root',
        properties: {},
        confidence: 1,
        source: { type: 'system', timestamp: '', method: '' },
      },
      levels: [],
      totalEntities: 0,
      totalRelations: 0,
    }),
    recordMemory: vi.fn(),
  };

  const mockVectorStore = {
    initialize: vi.fn(),
    upsert: vi.fn(),
    query: vi.fn().mockResolvedValue({ documents: [] }),
    collectionExists: vi.fn().mockResolvedValue(true),
    createCollection: vi.fn(),
  };

  const mockEmbeddingManager = {
    generateEmbeddings: vi.fn().mockResolvedValue({
      embeddings: [[0.1, 0.2, 0.3]],
      modelId: 'test',
      providerId: 'test',
      usage: { totalTokens: 0 },
    }),
    getEmbeddingDimension: vi.fn().mockResolvedValue(3),
    getEmbeddingModelInfo: vi.fn().mockResolvedValue({
      dimension: 3,
      modelId: 'test',
      providerId: 'test',
      maxInputTokens: 8192,
    }),
    initialize: vi.fn(),
    checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
    shutdown: vi.fn(),
  };

  const mockWorkingMemory = {
    capacity: 7,
    store: vi.fn(),
    retrieve: vi.fn().mockResolvedValue([]),
    clear: vi.fn(),
    getSlots: vi.fn().mockReturnValue([]),
  };

  return { mockKnowledgeGraph, mockVectorStore, mockEmbeddingManager, mockWorkingMemory };
}

describe('assembleForPrompt concurrency', () => {
  let manager: CognitiveMemoryManager;
  let mocks: ReturnType<typeof makeMocks>;
  let persistentRead: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    manager = new CognitiveMemoryManager();
    mocks = makeMocks();
    persistentRead = vi.fn().mockResolvedValue('operator notes: keep answers short');
    await manager.initialize({
      agentId: 'assemble-concurrency-test',
      traits: { emotionality: 0.5, conscientiousness: 0.5 },
      moodProvider: () => MOOD,
      featureDetectionStrategy: 'keyword',
      persistentMemory: { read: persistentRead },
      workingMemory: mocks.mockWorkingMemory as never,
      knowledgeGraph: mocks.mockKnowledgeGraph as never,
      vectorStore: mocks.mockVectorStore as never,
      embeddingManager: mocks.mockEmbeddingManager as never,
    } as never);
  });

  it('runs persistent read + prospective embed while retrieval is still in flight', async () => {
    // Latch the vector search open so retrieval cannot complete until released.
    let releaseQuery!: () => void;
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    mocks.mockVectorStore.query.mockImplementation(async () => {
      await queryGate;
      return { documents: [] };
    });

    const pending = manager.assembleForPrompt('what did we plan for friday', 2048, MOOD);

    // Let the event loop drain everything that isn't blocked on the latch.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Serial implementation: neither fires until retrieve() resolves.
    // Concurrent implementation: both have already started.
    expect(persistentRead).toHaveBeenCalledTimes(1);
    expect(
      mocks.mockEmbeddingManager.generateEmbeddings.mock.calls.length,
    ).toBeGreaterThanOrEqual(2); // store's query embed + prospective's query embed

    releaseQuery();
    const out = await pending;
    expect(out.contextText).toContain('operator notes: keep answers short');
  });

  it('a throwing prospective backend degrades to no alerts instead of failing assembly', async () => {
    (manager as unknown as { prospective: { check: unknown } }).prospective.check = vi
      .fn()
      .mockRejectedValue(new Error('prospective backend down'));

    const out = await manager.assembleForPrompt('anything scheduled?', 2048, MOOD);
    expect(typeof out.contextText).toBe('string');
    expect(out.contextText).toContain('operator notes: keep answers short');
  });

  it('a failing persistent-memory read degrades to undefined text', async () => {
    persistentRead.mockRejectedValue(new Error('backing store unreadable'));

    const out = await manager.assembleForPrompt('hello there', 2048, MOOD);
    expect(typeof out.contextText).toBe('string');
    expect(out.contextText).not.toContain('operator notes');
  });
});
