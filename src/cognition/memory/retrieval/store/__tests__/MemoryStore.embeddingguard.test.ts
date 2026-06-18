import { describe, it, expect, vi } from 'vitest';
import { MemoryStore, isUsableEmbedding } from '../MemoryStore.js';
import { InMemoryVectorStore } from '../../../../rag/vector_stores/InMemoryVectorStore.js';
import type { IKnowledgeGraph } from '../../graph/knowledge/IKnowledgeGraph.js';
import type { IEmbeddingManager } from '../../../../../core/embeddings/IEmbeddingManager.js';
import type { MemoryTrace, MemoryScope } from '../../../core/types.js';
import type { PADState } from '../../../core/config.js';
import type { VectorStoreProviderConfig } from '../../../../../core/vector-store/IVectorStore.js';

// CR4: the real cognition EmbeddingManager returns `[]` for any text it fails
// to embed (per-text fallback). Storing or querying with that zero-length
// vector silently corrupts recall — the vector-store collection dimension
// collapses to 0 and cosine similarity degenerates. MemoryStore must refuse it.
//
// `fail` toggles the failure so a test can store a real vector first, then
// make a later query embedding come back empty.
class FlakyEmbedder {
  fail = false;
  async generateEmbeddings(input: { texts: string | string[] }) {
    const texts = Array.isArray(input.texts) ? input.texts : [input.texts];
    const embeddings = texts.map((t) => {
      if (this.fail) return [] as number[];
      const seed = [...t].reduce((a, c, i) => a + c.charCodeAt(0) * (i + 1), 0);
      const vec = new Array(16).fill(0).map((_, i) => Math.sin(seed * (i + 1)) * 0.5 + 0.5);
      const mag = Math.hypot(...vec);
      return vec.map((x) => x / (mag || 1));
    });
    return { embeddings, model: 'flaky', usage: { promptTokens: 0, totalTokens: 0 } };
  }
}

class NoopKG {
  async recordMemory() { return 'noop'; }
  async findRelatedMemories() { return []; }
  async findEntityRelationships() { return []; }
  async linkMemories() { /* no-op */ }
  async getEntityContext() { return { entities: [], memories: [], relationships: [] }; }
  async getMemoryById() { return null; }
  async updateMemory() { /* no-op */ }
  async removeMemory() { /* no-op */ }
}

function mkTrace(id: string, content: string): MemoryTrace {
  return {
    id, type: 'episodic', scope: 'user', scopeId: 'u1',
    content, entities: [], tags: [],
    provenance: { sourceType: 'user_statement', sourceTimestamp: Date.now(), confidence: 1, verificationCount: 0 },
    emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: '' },
    encodingStrength: 0.5, stability: 0.5, retrievalCount: 0,
    lastAccessedAt: Date.now(), accessCount: 0, reinforcementInterval: 0,
    associatedTraceIds: [], createdAt: Date.now(), updatedAt: Date.now(), isActive: true,
  } as MemoryTrace;
}

const neutralMood: PADState = { valence: 0, arousal: 0, dominance: 0 };

async function mkVectorStore(): Promise<InMemoryVectorStore> {
  const vs = new InMemoryVectorStore();
  await vs.initialize({
    id: 'embeddingguard-test', type: 'in_memory',
    defaultEmbeddingDimension: 16, similarityMetric: 'cosine',
  } as VectorStoreProviderConfig);
  return vs;
}

function mkStore(vectorStore: InMemoryVectorStore, embedder: FlakyEmbedder): MemoryStore {
  return new MemoryStore({
    vectorStore,
    embeddingManager: embedder as unknown as IEmbeddingManager,
    knowledgeGraph: new NoopKG() as unknown as IKnowledgeGraph,
    collectionPrefix: 'cogmem',
  });
}

describe('isUsableEmbedding (CR4 predicate)', () => {
  it('rejects empty and missing vectors', () => {
    expect(isUsableEmbedding([])).toBe(false);
    expect(isUsableEmbedding(undefined)).toBe(false);
  });

  it('accepts a non-empty numeric vector', () => {
    expect(isUsableEmbedding([0.1])).toBe(true);
    expect(isUsableEmbedding([0, 0, 0])).toBe(true); // non-empty is usable; zero-norm is a separate concern
  });
});

describe('MemoryStore — empty-embedding guard (CR4)', () => {
  it('store() refuses to persist a zero-vector instead of silently corrupting recall', async () => {
    const embedder = new FlakyEmbedder();
    embedder.fail = true;
    const store = mkStore(await mkVectorStore(), embedder);
    await expect(store.store(mkTrace('t1', 'my name is Alice'))).rejects.toThrow(
      /refusing to persist an empty embedding/i,
    );
  });

  it('query() warns and degrades to empty rather than issuing a corrupt similarity search when the query embedding is empty', async () => {
    const embedder = new FlakyEmbedder();
    const store = mkStore(await mkVectorStore(), embedder);
    // Store a real, well-formed trace first (valid 16-dim vector).
    await store.store(mkTrace('t1', 'my name is Alice'));
    // Now the embedding manager starts returning empty vectors.
    embedder.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await store.query('what is my name', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });
      expect(result.scored).toEqual([]);
      expect(result.partial).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/MemoryStore\.query.*empty query vector/i));
    } finally {
      warn.mockRestore();
    }
  });
});
