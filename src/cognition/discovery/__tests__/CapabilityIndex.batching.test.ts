import { describe, expect, it, vi } from 'vitest';

/**
 * The extensions-registry catalog the engine hydrates from on initialize(). The published
 * catalog holds 119 entries (@framers/agentos-extensions-registry 0.18.17,
 * dist/capability-catalog.json). A hosted agent boots with it, and one embeddings request per
 * entry ran past a 60-calls-a-minute proxy limit before the agent's health port answered.
 */
const catalog = vi.hoisted(() =>
  Array.from({ length: 119 }, (_, i) => ({
    id: `com.framers.fixture-${i}`,
    name: `Fixture Extension ${i}`,
    description: `Fixture capability number ${i}, used to count embedding requests.`,
    category: i % 2 === 0 ? 'productivity' : 'information',
    tools: [`fixture_tool_${i}`],
    requiredSecrets: [] as string[],
  })),
);

vi.mock('@framers/agentos-extensions-registry', () => ({ CAPABILITY_CATALOG: catalog }));

import { CapabilityDiscoveryEngine } from '../CapabilityDiscoveryEngine.js';
import { CapabilityEmbeddingStrategy } from '../CapabilityEmbeddingStrategy.js';
import { CapabilityIndex } from '../CapabilityIndex.js';
import { EmbeddingManager } from '../../rag/EmbeddingManager.js';
import { InMemoryVectorStore } from '../../rag/vector_stores/InMemoryVectorStore.js';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager.js';
import type { CapabilityDescriptor, CapabilityIndexSources } from '../types.js';

const DIMENSION = 8;
const COLLECTION = 'capability-batching-test';
const MODEL = 'fixture-embedding-model';
const PROVIDER = 'fixture-embeddings';
/** EmbeddingManager's default batch when neither the model nor the manager sets one. */
const DEFAULT_BATCH = 32;
const strategy = new CapabilityEmbeddingStrategy();

/** A vector that depends on the text alone, so a vector stored under the wrong capability shows. */
function vectorFor(text: string): number[] {
  const vector: number[] = [];
  for (let seed = 0; seed < DIMENSION; seed++) {
    let hash = 2166136261 ^ seed;
    for (let i = 0; i < text.length; i++) {
      hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    }
    vector.push(((hash >>> 0) % 2000) / 1000 - 1);
  }
  return vector;
}

/**
 * A provider that answers like OpenAI's embeddings endpoint: one request takes an array of
 * inputs and returns one vector per input, in input order. It records every request it gets.
 */
function countingProvider(failRequest?: number) {
  const requests: string[][] = [];
  const provider = {
    providerId: PROVIDER,
    generateEmbeddings: vi.fn(async (_modelId: string, texts: string[]) => {
      requests.push([...texts]);
      if (failRequest === requests.length) {
        return {
          object: 'list',
          data: [],
          model: MODEL,
          usage: { prompt_tokens: 0, total_tokens: 0 },
          error: { message: 'fixture batch failure' },
        };
      }
      return {
        object: 'list',
        data: texts.map((text, index) => ({ object: 'embedding', index, embedding: vectorFor(text) })),
        model: MODEL,
        usage: { prompt_tokens: texts.length, total_tokens: texts.length },
      };
    }),
  };
  const providerManager = { getProvider: () => provider } as unknown as AIModelProviderManager;
  return { requests, providerManager };
}

async function setup(options: { defaultBatchSize?: number; failRequest?: number } = {}) {
  const { requests, providerManager } = countingProvider(options.failRequest);
  const embeddingManager = new EmbeddingManager();
  await embeddingManager.initialize(
    {
      embeddingModels: [{ modelId: MODEL, providerId: PROVIDER, dimension: DIMENSION, isDefault: true }],
      enableCache: false,
      ...(options.defaultBatchSize ? { defaultBatchSize: options.defaultBatchSize } : {}),
    },
    providerManager,
  );
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: COLLECTION, type: 'in_memory', similarityMetric: 'cosine' } as any);
  const engine = new CapabilityDiscoveryEngine(embeddingManager, vectorStore, { collectionName: COLLECTION });
  return { engine, embeddingManager, vectorStore, requests };
}

function tools(prefix: string, count: number): NonNullable<CapabilityIndexSources['tools']> {
  return Array.from({ length: count }, (_, i) => ({
    id: `tool:${prefix}-${i}`,
    name: `${prefix}-${i}`,
    displayName: `${prefix} tool ${i}`,
    description: `The ${prefix} tool number ${i}.`,
    category: 'information',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  }));
}

function emergentTools(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `emergent-${i}`,
    name: `forged-${i}`,
    description: `A forged tool number ${i}.`,
    inputSchema: { type: 'object', properties: {} },
    tier: 'agent',
    implementation: { mode: 'compose' },
  })) as any[];
}

async function storedDocuments(store: InMemoryVectorStore) {
  const { documents } = await store.scanByMetadata(COLLECTION, {
    limit: 10_000,
    includeEmbedding: true,
    includeTextContent: true,
  });
  return new Map(documents.map((doc) => [doc.id, doc]));
}

/** Every stored vector is the vector of its own capability's embedding text. */
async function expectVectorsMapToTheirCapabilities(
  engine: CapabilityDiscoveryEngine,
  store: InMemoryVectorStore,
) {
  const stored = await storedDocuments(store);
  for (const [id, doc] of stored) {
    const descriptor = engine.getCapabilityDetail(id) as CapabilityDescriptor;
    expect(descriptor, id).toBeDefined();
    const text = strategy.buildEmbeddingText(descriptor);
    expect(doc.textContent, id).toBe(text);
    expect(doc.embedding, id).toEqual(vectorFor(text));
  }
  return stored;
}

describe('capability discovery embeds its index in batches', () => {
  it('embeds a boot index of 3 tools and the 119-entry catalog in ceil(N / 32) requests, not one per capability', async () => {
    const { engine, vectorStore, requests } = await setup();

    await engine.initialize({ tools: tools('boot', 3) });

    expect(requests).toHaveLength(Math.ceil(3 / DEFAULT_BATCH) + Math.ceil(catalog.length / DEFAULT_BATCH));
    expect(requests.every((inputs) => inputs.length >= 1 && inputs.length <= DEFAULT_BATCH)).toBe(true);
    expect(requests.flat()).toHaveLength(3 + catalog.length);

    const stored = await expectVectorsMapToTheirCapabilities(engine, vectorStore);
    expect(stored.size).toBe(3 + catalog.length);
    expect(engine.listCapabilityIds()).toHaveLength(3 + catalog.length);
    expect(stored.has('extension:com.framers.fixture-118')).toBe(true);
  });

  it('follows the configured batch size for emergent tools and refreshes', async () => {
    const { engine, vectorStore, requests } = await setup({ defaultBatchSize: 10 });

    await engine.initialize({ tools: tools('boot', 3) });
    expect(requests).toHaveLength(Math.ceil(3 / 10) + Math.ceil(catalog.length / 10));

    requests.length = 0;
    const indexed = await engine.indexEmergentTools([
      ...emergentTools(25),
      { ...emergentTools(1)[0], id: 'session-only', name: 'session-only', tier: 'session' },
    ]);
    expect(indexed).toBe(25);
    expect(requests).toHaveLength(Math.ceil(25 / 10));
    expect(requests.map((inputs) => inputs.length)).toEqual([10, 10, 5]);

    requests.length = 0;
    await engine.refreshIndex({ tools: tools('late', 7) });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveLength(7);

    const stored = await expectVectorsMapToTheirCapabilities(engine, vectorStore);
    expect(stored.has('emergent-tool:forged-24')).toBe(true);
    expect(stored.has('emergent-tool:session-only')).toBe(false);
    expect(stored.has('tool:late-6')).toBe(true);
    expect(stored.size).toBe(3 + catalog.length + 25 + 7);
  });

  it('keeps each vector on its own capability when one request of the batch fails', async () => {
    // Request 1 embeds the 3 tools; requests 2 to 5 embed catalog entries 0-31, 32-63, 64-95 and 96-118.
    const { engine, vectorStore, requests } = await setup({ failRequest: 3 });

    await engine.initialize({ tools: tools('boot', 3) });

    expect(requests).toHaveLength(1 + Math.ceil(catalog.length / DEFAULT_BATCH));
    const stored = await expectVectorsMapToTheirCapabilities(engine, vectorStore);
    expect(stored.size).toBe(3 + catalog.length - DEFAULT_BATCH);
    for (let i = 0; i < catalog.length; i++) {
      const failed = i >= DEFAULT_BATCH && i < 2 * DEFAULT_BATCH;
      expect(stored.has(`extension:com.framers.fixture-${i}`), `entry ${i}`).toBe(!failed);
    }
    // A capability without a vector stays known to the index, as a single upsert leaves it.
    expect(engine.listCapabilityIds()).toHaveLength(3 + catalog.length);
  });

  it('skips a capability with no embedding text without shifting the vectors after it', async () => {
    const { engine, vectorStore } = await setup();
    const manifest = (id: string, name: string, description: string, category: string): CapabilityDescriptor => ({
      id,
      kind: 'extension',
      name,
      displayName: name,
      description,
      category,
      tags: [],
      requiredSecrets: [],
      requiredTools: [],
      available: true,
      sourceRef: { type: 'extension', packageName: id, extensionId: id },
    });

    await engine.initialize({
      tools: tools('boot', 2),
      manifests: [
        manifest('extension:first', 'first', 'The first manifest.', 'information'),
        manifest('extension:blank', '', '', ''),
        manifest('extension:last', 'last', 'The last manifest.', 'information'),
      ],
    });

    const stored = await expectVectorsMapToTheirCapabilities(engine, vectorStore);
    expect(stored.has('extension:first')).toBe(true);
    expect(stored.has('extension:last')).toBe(true);
    expect(stored.has('extension:blank')).toBe(false);
  });

  it('counts only the capabilities the vector store accepted', async () => {
    const { embeddingManager, vectorStore, requests } = await setup();
    // A collection of another dimension: the store refuses every document in its result
    // rather than by throwing, as the Qdrant and HNSW stores report a refused document.
    await vectorStore.createCollection(COLLECTION, DIMENSION + 1, { similarityMetric: 'cosine' });
    const index = new CapabilityIndex(embeddingManager, vectorStore, COLLECTION);
    const caps = index.normalizeSources({ tools: tools('refused', 3) });

    const written = await index.upsertCapabilities(caps);

    expect(requests).toHaveLength(1);
    expect(written).toBe(0);
    expect(index.listIds()).toHaveLength(3);
  });

  it('keeps the vector an earlier copy of an id got when a later copy has no embedding text, as single upserts in order would', async () => {
    const { embeddingManager, vectorStore } = await setup();
    await vectorStore.createCollection(COLLECTION, DIMENSION, { similarityMetric: 'cosine' });
    const index = new CapabilityIndex(embeddingManager, vectorStore, COLLECTION);
    const [first] = index.normalizeSources({ tools: tools('dup', 1) });
    const blank: CapabilityDescriptor = { ...first, name: '', displayName: '', description: '', category: '', fullSchema: undefined };
    expect(strategy.buildEmbeddingText(blank)).toBe('');

    const written = await index.upsertCapabilities([first, blank]);

    expect(written).toBe(1);
    expect(index.getCapability(first.id)).toBe(blank);
    const stored = await storedDocuments(vectorStore);
    expect(stored.get(first.id)?.embedding).toEqual(vectorFor(strategy.buildEmbeddingText(first)));
  });
});
