/**
 * @fileoverview The manager's `extraction` setting is reserved: whatever it
 * holds, the manager builds the observer, the reflector and the typed-network
 * encode trigger from the same fields it reads when the setting is omitted.
 *
 * @module memory/__tests__/CognitiveMemoryManager.extraction-reserved.test
 */

import { describe, expect, it, vi } from 'vitest';
import { CognitiveMemoryManager } from '../CognitiveMemoryManager.js';
import type { CognitiveMemoryConfig } from '../core/config.js';
import { MemoryObserver } from '../pipeline/observation/MemoryObserver.js';
import { MemoryReflector } from '../pipeline/observation/MemoryReflector.js';
import { TypedNetworkObserver, TypedNetworkStore } from '../retrieval/typed-network/index.js';

const mood = { valence: 0, arousal: 0.3, dominance: 0 };

function makeDeps() {
  const knowledgeGraph = {
    initialize: vi.fn(),
    upsertEntity: vi.fn(),
    upsertRelation: vi.fn(),
    queryEntities: vi.fn().mockResolvedValue([]),
    getNeighborhood: vi.fn().mockResolvedValue({ entities: [], relations: [] }),
    getRelations: vi.fn().mockResolvedValue([]),
    deleteEntity: vi.fn(),
    deleteRelation: vi.fn(),
    recordMemory: vi.fn(),
  };
  const vectorStore = {
    initialize: vi.fn(),
    upsert: vi.fn(),
    query: vi.fn().mockResolvedValue({ documents: [] }),
    collectionExists: vi.fn().mockResolvedValue(true),
    createCollection: vi.fn(),
  };
  const embeddingManager = {
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
  const workingMemory = {
    capacity: 7,
    store: vi.fn(),
    retrieve: vi.fn().mockResolvedValue([]),
    clear: vi.fn(),
    getSlots: vi.fn().mockReturnValue([]),
  };
  return {
    workingMemory: workingMemory as unknown as CognitiveMemoryConfig['workingMemory'],
    knowledgeGraph: knowledgeGraph as unknown as CognitiveMemoryConfig['knowledgeGraph'],
    vectorStore: vectorStore as unknown as CognitiveMemoryConfig['vectorStore'],
    embeddingManager: embeddingManager as unknown as CognitiveMemoryConfig['embeddingManager'],
    agentId: 'extraction-reserved-test',
    traits: { emotionality: 0.5, conscientiousness: 0.5 },
    moodProvider: () => mood,
    featureDetectionStrategy: 'keyword' as const,
  } satisfies CognitiveMemoryConfig;
}

const settings: Array<[string, Pick<CognitiveMemoryConfig, 'extraction'>]> = [
  ['omitted', {}],
  ['true', { extraction: true }],
  ['an empty options object', { extraction: {} }],
  [
    'an options object that names every stage',
    {
      extraction: {
        mode: 'classical',
        typedNetwork: false,
        observer: false,
        reflector: false,
        maxCallsPerTurn: 0,
        timeoutMs: 0,
      },
    },
  ],
  ['false', { extraction: false }],
];

describe('CognitiveMemoryManager: the extraction setting is reserved', () => {
  it.each(settings)(
    'builds the observer, the reflector and the encode trigger as before when extraction is %s',
    async (_label, setting) => {
      const observerInvoker = vi.fn(async () =>
        JSON.stringify({
          type: 'factual',
          content: 'The user prints on matte paper.',
          importance: 0.4,
          entities: ['matte paper'],
        }),
      );
      const reflectorInvoker = vi.fn(async () => '{}');
      const typedInvoke = vi.fn(async () =>
        JSON.stringify({
          facts: [
            {
              text: 'Berlin is in Germany',
              bank: 'WORLD',
              temporal: { mention: '2026-04-25T12:00:00Z' },
              participants: [],
              reasoning_markers: [],
              entities: ['Berlin', 'Germany'],
              confidence: 1.0,
            },
          ],
        }),
      );

      const manager = new CognitiveMemoryManager();
      try {
        await manager.initialize({
          ...makeDeps(),
          ...setting,
          // One buffered message reaches the observer's model callback.
          observer: { llmInvoker: observerInvoker, activationThresholdMessages: 1 },
          reflector: { llmInvoker: reflectorInvoker },
          typedNetwork: {
            variant: 'minimal',
            extractAtEncode: true,
            observerLLM: { invoke: typedInvoke },
          },
        });

        expect(manager.getObserver()).toBeInstanceOf(MemoryObserver);
        expect(manager.getReflector()).toBeInstanceOf(MemoryReflector);
        expect(manager.getTypedNetworkObserver()).toBeInstanceOf(TypedNetworkObserver);
        expect(manager.getTypedNetworkStore()).toBeInstanceOf(TypedNetworkStore);

        // The observer buffers the message and returns the notes its callback produced.
        const notes = await manager.observe('user', 'I print on matte paper.', mood);
        expect(notes?.map((note) => note.content)).toEqual(['The user prints on matte paper.']);
        expect(observerInvoker).toHaveBeenCalledOnce();

        // The encode trigger sends the input to the typed-network callback and files its fact.
        const trace = await manager.encode('Berlin is in Germany.', mood, 'neutral');
        expect(typedInvoke).toHaveBeenCalledOnce();
        const store = manager.getTypedNetworkStore();
        expect(store?.getBank('WORLD').size).toBe(1);
        expect(store?.getFact(`${trace.id}-fact-0`)?.text).toBe('Berlin is in Germany');
      } finally {
        await manager.shutdown();
      }
    },
  );
});
