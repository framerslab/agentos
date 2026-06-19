import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Brain } from '../Brain.js';
import { MemoryStore } from '../MemoryStore.js';
import { InMemoryVectorStore } from '../../../../rag/vector_stores/InMemoryVectorStore.js';
import type { IKnowledgeGraph } from '../../graph/knowledge/IKnowledgeGraph.js';
import type { IEmbeddingManager } from '../../../../../core/embeddings/IEmbeddingManager.js';
import type { MemoryTrace, MemoryScope } from '../../../core/types.js';
import type { PADState } from '../../../core/config.js';
import type { VectorStoreProviderConfig } from '../../../../../core/vector-store/IVectorStore.js';

// Durable-recall hydration (the companion memory-cliff root cause):
//
// `MemoryStore.store()` write-through persists trace CONTENT to the Brain but,
// before this fix, wrote the embedding column as `null` — so the vectors lived
// only in the per-instance `InMemoryVectorStore`. wilds opens a FRESH facade
// (hence a fresh MemoryStore + fresh empty vector store) on every API request,
// so `query()` searched an empty index and semantic recall returned nothing.
//
// The fix: persist the embedding durably AND hydrate the in-memory vector store
// (+ knownScopes) from the attached Brain on the first query of a cold instance.
// These tests model the production scenario: instance #1 stores, a SEPARATE
// instance #2 (cold vector store, same Brain) must still recall.

// Deterministic embedder: a single fixed unit vector for every text, so the
// stored trace and the query share cosine 1.0. This isolates the test to "did
// the cold instance load the durable trace into its vector store" — not to the
// quality of similarity scoring.
class FixedEmbedder {
  async generateEmbeddings(input: { texts: string | string[] }) {
    const texts = Array.isArray(input.texts) ? input.texts : [input.texts];
    const vec = new Array(16).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    return {
      embeddings: texts.map(() => vec.slice()),
      model: 'fixed',
      usage: { promptTokens: 0, totalTokens: 0 },
    };
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
    id: 'brainhydration-test', type: 'in_memory',
    defaultEmbeddingDimension: 16, similarityMetric: 'cosine',
  } as VectorStoreProviderConfig);
  return vs;
}

function mkStore(vectorStore: InMemoryVectorStore): MemoryStore {
  return new MemoryStore({
    vectorStore,
    embeddingManager: new FixedEmbedder() as unknown as IEmbeddingManager,
    knowledgeGraph: new NoopKG() as unknown as IKnowledgeGraph,
    collectionPrefix: 'cogmem',
  });
}

describe('MemoryStore — durable recall hydration from Brain', () => {
  it('a fresh store instance recalls a trace stored by a prior instance sharing the same Brain (explicit scope)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dbPath = path.join(tmpDir, 'brain.sqlite');
    const brain = await Brain.openSqlite(dbPath);
    try {
      // Instance #1 — store a trace; write-through persists it (with embedding) to the Brain.
      const store1 = mkStore(await mkVectorStore());
      store1.setBrain(brain);
      await store1.store(mkTrace('t1', 'my sister is named Vera'));

      // Instance #2 — FRESH, cold InMemoryVectorStore, SAME Brain (models a new API request).
      const store2 = mkStore(await mkVectorStore());
      store2.setBrain(brain);

      const result = await store2.query("what is my sister's name", neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });
      expect(result.scored.map((s) => s.id)).toContain('t1');
    } finally {
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('hydration also works when the caller passes no scopes (registers known scopes from the Brain)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dbPath = path.join(tmpDir, 'brain.sqlite');
    const brain = await Brain.openSqlite(dbPath);
    try {
      const store1 = mkStore(await mkVectorStore());
      store1.setBrain(brain);
      await store1.store(mkTrace('t1', 'my sister is named Vera'));

      const store2 = mkStore(await mkVectorStore());
      store2.setBrain(brain);

      // No `scopes` option — mirrors wilds' facade.recall(), which passes none.
      // Hydration must populate knownScopes so query does not short-circuit.
      const result = await store2.query("what is my sister's name", neutralMood, {});
      expect(result.scored.map((s) => s.id)).toContain('t1');
    } finally {
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
