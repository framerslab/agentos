import { describe, it, expect, vi } from 'vitest';
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

  it('softDelete removes a cached trace from vector recall and scope listings', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dbPath = path.join(tmpDir, 'brain.sqlite');
    const brain = await Brain.openSqlite(dbPath);
    try {
      const vectorStore = await mkVectorStore();
      const deleteSpy = vi.spyOn(vectorStore, 'delete');
      const store = mkStore(vectorStore);
      store.setBrain(brain);
      await store.store(mkTrace('t1', 'remember this detail'));

      await store.softDelete('t1');

      const vectorResult = await vectorStore.query(
        'cogmem_user_u1',
        new Array(16).fill(0).map((_, index) => (index === 0 ? 1 : 0)),
        { topK: 10, includeMetadata: true },
      );
      const recall = await store.query('remember this detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });
      expect(vectorResult.documents.map((document) => document.id)).not.toContain('t1');
      expect(recall.scored.map((trace) => trace.id)).not.toContain('t1');
      expect(await store.getByScope('user', 'u1')).toEqual([]);
      expect(deleteSpy).toHaveBeenCalledWith('cogmem_user_u1', ['t1']);
      expect(
        await brain.get<{ deleted: number }>(
          'SELECT deleted FROM memory_traces WHERE brain_id = ? AND id = ?',
          [brain.brainId, 't1'],
        ),
      ).toEqual({ deleted: 1 });
    } finally {
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('recordAccess cannot restore a trace deleted during its vector refresh', async () => {
    const vectorStore = await mkVectorStore();
    const store = mkStore(vectorStore);
    await store.store(mkTrace('t1', 'remember this detail'));

    const originalUpsert = vectorStore.upsert.bind(vectorStore);
    let signalRefreshStarted: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.spyOn(vectorStore, 'upsert').mockImplementation(async (collection, documents) => {
      signalRefreshStarted?.();
      await refreshGate;
      return originalUpsert(collection, documents);
    });

    const access = store.recordAccess('t1');
    await refreshStarted;
    await store.softDelete('t1');
    releaseRefresh?.();

    expect(await access).toBeNull();
    const vectorResult = await vectorStore.query(
      'cogmem_user_u1',
      new Array(16).fill(0).map((_, index) => (index === 0 ? 1 : 0)),
      { topK: 10, includeMetadata: true },
    );
    expect(vectorResult.documents.map((document) => document.id)).not.toContain('t1');
  });

  it('softDelete tombstones a durable trace before a cold store hydrates', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dbPath = path.join(tmpDir, 'brain.sqlite');
    const brain = await Brain.openSqlite(dbPath);
    try {
      const writer = mkStore(await mkVectorStore());
      writer.setBrain(brain);
      await writer.store(mkTrace('t1', 'remember this detail'));

      const coldStore = mkStore(await mkVectorStore());
      coldStore.setBrain(brain);
      await coldStore.softDelete('t1');

      const recall = await coldStore.query('remember this detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });
      expect(recall.scored).toEqual([]);
      expect(await coldStore.getByScope('user', 'u1')).toEqual([]);
    } finally {
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('hydration cannot restore a trace deleted while its vector upsert is in flight', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dbPath = path.join(tmpDir, 'brain.sqlite');
    const brain = await Brain.openSqlite(dbPath);
    let releaseHydration: (() => void) | undefined;
    try {
      const writer = mkStore(await mkVectorStore());
      writer.setBrain(brain);
      await writer.store(mkTrace('t1', 'remember this detail'));

      const vectorStore = await mkVectorStore();
      const originalUpsert = vectorStore.upsert.bind(vectorStore);
      let signalHydrationStarted: (() => void) | undefined;
      const hydrationStarted = new Promise<void>((resolve) => {
        signalHydrationStarted = resolve;
      });
      const hydrationGate = new Promise<void>((resolve) => {
        releaseHydration = resolve;
      });
      vi.spyOn(vectorStore, 'upsert').mockImplementation(async (collection, documents) => {
        signalHydrationStarted?.();
        await hydrationGate;
        return originalUpsert(collection, documents);
      });

      const coldStore = mkStore(vectorStore);
      coldStore.setBrain(brain);
      const recall = coldStore.query('remember this detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });

      await hydrationStarted;
      await coldStore.softDelete('t1');
      releaseHydration?.();

      expect((await recall).scored).toEqual([]);
      expect(await coldStore.getByScope('user', 'u1')).toEqual([]);
      const vectorResult = await vectorStore.query(
        'cogmem_user_u1',
        new Array(16).fill(0).map((_, index) => (index === 0 ? 1 : 0)),
        { topK: 10, includeMetadata: true },
      );
      expect(vectorResult.documents.map((document) => document.id)).not.toContain('t1');
    } finally {
      releaseHydration?.();
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('filters a cached tombstone when vector deletion reports failure', async () => {
    const vectorStore = await mkVectorStore();
    const store = mkStore(vectorStore);
    await store.store(mkTrace('t1', 'remember this detail'));
    vi.spyOn(vectorStore, 'delete').mockResolvedValue({
      deletedCount: 0,
      failedCount: 1,
      errors: [{ id: 't1', message: 'simulated provider failure' }],
    });

    await store.softDelete('t1');

    const recall = await store.query('remember this detail', neutralMood, {
      scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
    });
    expect(recall.scored).toEqual([]);
    expect(await store.getByScope('user', 'u1')).toEqual([]);
  });
});
