import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  resolveStorageAdapter,
  type StorageParameters,
} from '@framers/sql-storage-adapter';
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
    const deleting = store.softDelete('t1');
    releaseRefresh?.();

    const [accessResult] = await Promise.all([access, deleting]);
    expect(accessResult).toBeNull();
    const vectorResult = await vectorStore.query(
      'cogmem_user_u1',
      new Array(16).fill(0).map((_, index) => (index === 0 ? 1 : 0)),
      { topK: 10, includeMetadata: true },
    );
    expect(vectorResult.documents.map((document) => document.id)).not.toContain('t1');
  });

  it('softDelete waits for an in-flight store of the same trace and wins last', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dbPath = path.join(tmpDir, 'brain.sqlite');
    const brain = await Brain.openSqlite(dbPath);
    let releaseStore: (() => void) | undefined;
    try {
      const vectorStore = await mkVectorStore();
      const originalUpsert = vectorStore.upsert.bind(vectorStore);
      let signalStoreStarted: (() => void) | undefined;
      const storeStarted = new Promise<void>((resolve) => {
        signalStoreStarted = resolve;
      });
      const storeGate = new Promise<void>((resolve) => {
        releaseStore = resolve;
      });
      vi.spyOn(vectorStore, 'upsert').mockImplementation(async (collection, documents) => {
        signalStoreStarted?.();
        await storeGate;
        return originalUpsert(collection, documents);
      });

      const store = mkStore(vectorStore);
      store.setBrain(brain);
      const storing = store.store(mkTrace('t1', 'remember this detail'));
      await storeStarted;
      const deleting = store.softDelete('t1');
      releaseStore?.();
      await Promise.all([storing, deleting]);

      const vectorResult = await vectorStore.query(
        'cogmem_user_u1',
        new Array(16).fill(0).map((_, index) => (index === 0 ? 1 : 0)),
        { topK: 10, includeMetadata: true },
      );
      expect(vectorResult.documents.map((document) => document.id)).not.toContain('t1');
      expect(
        await brain.get<{ deleted: number }>(
          'SELECT deleted FROM memory_traces WHERE brain_id = ? AND id = ?',
          [brain.brainId, 't1'],
        ),
      ).toEqual({ deleted: 1 });
    } finally {
      releaseStore?.();
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('softDelete wins against an in-flight metadata refresh', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const brain = await Brain.openSqlite(path.join(tmpDir, 'brain.sqlite'));
    let releaseRefresh: (() => void) | undefined;
    try {
      const writer = mkStore(await mkVectorStore());
      writer.setBrain(brain);
      await writer.store(mkTrace('t1', 'remember this detail'));

      const siblingVector = await mkVectorStore();
      const sibling = mkStore(siblingVector);
      sibling.setBrain(brain);
      await sibling.query('remember this detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });

      const originalUpsert = siblingVector.upsert.bind(siblingVector);
      let signalRefreshStarted: (() => void) | undefined;
      const refreshStarted = new Promise<void>((resolve) => {
        signalRefreshStarted = resolve;
      });
      const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      vi.spyOn(siblingVector, 'upsert').mockImplementation(async (collection, documents) => {
        signalRefreshStarted?.();
        await refreshGate;
        return originalUpsert(collection, documents);
      });

      const refreshing = sibling.persistTraceMetadata('t1');
      await refreshStarted;
      const deleting = writer.softDelete('t1');
      releaseRefresh?.();
      await Promise.all([refreshing, deleting]);

      const vectorResult = await siblingVector.query(
        'cogmem_user_u1',
        new Array(16).fill(0).map((_, index) => (index === 0 ? 1 : 0)),
        { topK: 10, includeMetadata: true },
      );
      expect(vectorResult.documents.map((document) => document.id)).not.toContain('t1');
    } finally {
      releaseRefresh?.();
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('softDelete invalidates sibling stores opened on the same SQLite file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dbPath = path.join(tmpDir, 'brain.sqlite');
    const brainA = await Brain.openSqlite(dbPath);
    const brainB = await Brain.openSqlite(dbPath);
    try {
      expect(brainA.coordinationToken).toBe(brainB.coordinationToken);
      const vectorA = await mkVectorStore();
      const vectorB = await mkVectorStore();
      const storeA = mkStore(vectorA);
      const storeB = mkStore(vectorB);
      storeA.setBrain(brainA);
      storeB.setBrain(brainB);
      await storeA.store(mkTrace('t1', 'remember this detail'));
      expect((await storeB.query('remember this detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      })).scored.map((trace) => trace.id)).toContain('t1');

      await storeA.softDelete('t1');

      expect((await storeB.query('remember this detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      })).scored).toEqual([]);
      expect(await storeB.getByScope('user', 'u1')).toEqual([]);
      expect(await storeB.recordAccess('t1')).toBeNull();
      const vectorResult = await vectorB.query(
        'cogmem_user_u1',
        new Array(16).fill(0).map((_, index) => (index === 0 ? 1 : 0)),
        { topK: 10, includeMetadata: true },
      );
      expect(vectorResult.documents.map((document) => document.id)).not.toContain('t1');
    } finally {
      await brainB.close();
      await brainA.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('dispose unregisters a retained sibling from future invalidation fan-out', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const brain = await Brain.openSqlite(path.join(tmpDir, 'brain.sqlite'));
    try {
      const writer = mkStore(await mkVectorStore());
      writer.setBrain(brain);
      await writer.store(mkTrace('t1', 'remember this detail'));

      const retiredVector = await mkVectorStore();
      const retired = mkStore(retiredVector);
      retired.setBrain(brain);
      await retired.query('remember this detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });
      const deleteSpy = vi.spyOn(retiredVector, 'delete');

      retired.dispose();
      await writer.softDelete('t1');

      expect(deleteSpy).not.toHaveBeenCalled();
      await expect(retired.query('remember this detail', neutralMood)).rejects.toThrow(
        'operation attempted after dispose',
      );
    } finally {
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not coordinate distinct SQLite files that share a basename', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    const brainA = await Brain.openSqlite(path.join(dirA, 'brain.sqlite'));
    const brainB = await Brain.openSqlite(path.join(dirB, 'brain.sqlite'));
    let releaseDelete: (() => void) | undefined;
    try {
      expect(brainA.brainId).toBe(brainB.brainId);
      expect(brainA.coordinationToken).not.toBe(brainB.coordinationToken);
      const vectorA = await mkVectorStore();
      const vectorB = await mkVectorStore();
      const storeA = mkStore(vectorA);
      const storeB = mkStore(vectorB);
      storeA.setBrain(brainA);
      storeB.setBrain(brainB);
      await storeA.store(mkTrace('t1', 'memory A'));
      await storeB.store(mkTrace('t1', 'memory B'));

      const originalDelete = vectorA.delete.bind(vectorA);
      let signalDeleteStarted: (() => void) | undefined;
      const deleteStarted = new Promise<void>((resolve) => {
        signalDeleteStarted = resolve;
      });
      const deleteGate = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      vi.spyOn(vectorA, 'delete').mockImplementation(async (collection, ids) => {
        signalDeleteStarted?.();
        await deleteGate;
        return originalDelete(collection, ids);
      });

      const deletingA = storeA.softDelete('t1');
      await deleteStarted;
      const storingB = storeB.store(mkTrace('t1', 'updated memory B'));
      releaseDelete?.();
      await Promise.all([deletingA, storingB]);

      expect(
        await brainB.get<{ deleted: number }>(
          'SELECT deleted FROM memory_traces WHERE brain_id = ? AND id = ?',
          [brainB.brainId, 't1'],
        ),
      ).toEqual({ deleted: 0 });
      expect((await storeB.query('updated memory B', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      })).scored.map((trace) => trace.id)).toContain('t1');
    } finally {
      releaseDelete?.();
      await brainB.close();
      await brainA.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('gives independent in-memory Brains distinct coordination keys', async () => {
    const brainA = await Brain.openSqlite(':memory:');
    const brainB = await Brain.openSqlite(':memory:');
    try {
      expect(brainA.brainId).toBe(brainB.brainId);
      expect(brainA.coordinationToken).not.toBe(brainB.coordinationToken);
    } finally {
      await brainB.close();
      await brainA.close();
    }
  });

  it('reuses the coordination token for wrappers around the same adapter', async () => {
    const owner = await Brain.openSqlite(':memory:');
    try {
      const wrapperA = await Brain.openWithAdapter(owner.adapter, { brainId: owner.brainId });
      const wrapperB = await Brain.openWithAdapter(owner.adapter, { brainId: owner.brainId });
      expect(wrapperA.coordinationToken).toBe(owner.coordinationToken);
      expect(wrapperB.coordinationToken).toBe(owner.coordinationToken);

      const explicitToken = {};
      await expect(Brain.openWithAdapter(owner.adapter, {
        brainId: owner.brainId,
        coordinationToken: explicitToken,
      })).rejects.toThrow('coordinationToken conflicts');
      const afterExplicit = await Brain.openWithAdapter(owner.adapter, {
        brainId: owner.brainId,
      });
      expect(afterExplicit.coordinationToken).toBe(owner.coordinationToken);
    } finally {
      await owner.close();
    }
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
      const deleting = writer.softDelete('t1');
      releaseHydration?.();

      const [recallResult] = await Promise.all([recall, deleting]);
      expect(recallResult.scored).toEqual([]);
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

  it('a result-reported vector delete failure stays retryable from a cold instance', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dbPath = path.join(tmpDir, 'brain.sqlite');
    const brain = await Brain.openSqlite(dbPath);
    try {
      // ONE shared vector store (the persistent-collection analogue): a failed
      // eviction leaves a live document behind for every future process.
      const vectorStore = await mkVectorStore();
      const writer = mkStore(vectorStore);
      writer.setBrain(brain);
      await writer.store(mkTrace('t1', 'remember this detail'));

      // First delete: the provider reports failure through the RESULT (the
      // Qdrant contract) instead of throwing. The SQL row tombstones; the
      // vector document survives.
      const deleteSpy = vi.spyOn(vectorStore, 'delete').mockResolvedValueOnce({
        deletedCount: 0,
        failedCount: 1,
        errors: [{ id: 't1', message: 'simulated provider failure' }],
      });
      await writer.softDelete('t1');
      expect(deleteSpy).toHaveBeenCalledWith('cogmem_user_u1', ['t1']);
      const probe = new Array(16).fill(0).map((_, index) => (index === 0 ? 1 : 0));
      const survivor = await vectorStore.query('cogmem_user_u1', probe, {
        topK: 10,
        includeMetadata: true,
      });
      expect(survivor.documents.map((document) => document.id)).toContain('t1');

      // Retry from a COLD instance: the tombstoned durable row must still
      // derive the vector collection (loaded for cleanup only — never
      // recached), so the second eviction actually lands.
      const coldStore = mkStore(vectorStore);
      coldStore.setBrain(brain);
      await coldStore.softDelete('t1');

      expect(coldStore.getTrace('t1')).toBeUndefined();
      const evicted = await vectorStore.query('cogmem_user_u1', probe, {
        topK: 10,
        includeMetadata: true,
      });
      expect(evicted.documents.map((document) => document.id)).not.toContain('t1');
    } finally {
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('durable tombstones fence stale provider results in a fresh store', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dbPath = path.join(tmpDir, 'brain.sqlite');
    const brain = await Brain.openSqlite(dbPath);
    try {
      const vectorStore = await mkVectorStore();
      const writer = mkStore(vectorStore);
      writer.setBrain(brain);
      await writer.store(mkTrace('t1', 'remember this detail'));
      vi.spyOn(vectorStore, 'delete').mockResolvedValueOnce({
        deletedCount: 0,
        failedCount: 1,
        errors: [{ id: 't1', message: 'simulated provider failure' }],
      });
      await writer.softDelete('t1');

      const coldStore = mkStore(vectorStore);
      coldStore.setBrain(brain);
      const recall = await coldStore.query('remember this detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });

      expect(recall.scored).toEqual([]);
      expect(await coldStore.getByScope('user', 'u1')).toEqual([]);
      const probe = new Array(16).fill(0).map((_, index) => (index === 0 ? 1 : 0));
      const fencedProviderDocument = await vectorStore.query('cogmem_user_u1', probe, {
        topK: 10,
        includeMetadata: true,
      });
      // Durable validation fences recall without destructively racing a
      // possible cross-process revival. Explicit softDelete retry owns cleanup.
      expect(fencedProviderDocument.documents.map((document) => document.id)).toContain('t1');
    } finally {
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each(['query', 'getByScope'] as const)(
    'a stale durable tombstone cannot erase an in-flight revival during %s',
    async (readPath) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
      const brain = await Brain.openSqlite(path.join(tmpDir, 'brain.sqlite'));
      let releaseStoreWrite: (() => void) | undefined;
      try {
        const vectorStore = await mkVectorStore();
        const store = mkStore(vectorStore);
        store.setBrain(brain);
        const trace = mkTrace('t1', 'remember this detail');
        await store.store(trace);
        await store.softDelete('t1');
        expect(trace.isActive).toBe(false);

        const originalRun = brain.run.bind(brain);
        let signalStoreWriteStarted: (() => void) | undefined;
        const storeWriteStarted = new Promise<void>((resolve) => {
          signalStoreWriteStarted = resolve;
        });
        const storeWriteGate = new Promise<void>((resolve) => {
          releaseStoreWrite = resolve;
        });
        vi.spyOn(brain, 'run').mockImplementation(async (sql, params) => {
          if (sql.includes('memory_traces') && Array.isArray(params) && params.length > 10) {
            signalStoreWriteStarted?.();
            await storeWriteGate;
          }
          return originalRun(sql, params);
        });

        const originalAll = brain.all.bind(brain) as typeof brain.all;
        let signalTombstoneRead: (() => void) | undefined;
        const tombstoneRead = new Promise<void>((resolve) => {
          signalTombstoneRead = resolve;
        });
        vi.spyOn(brain, 'all').mockImplementation(async <T = unknown>(
          sql: string,
          params?: StorageParameters,
        ) => {
          const rows = await originalAll<T>(sql, params);
          if (sql.includes('id IN') && Array.isArray(params) && params.includes('t1')) {
            signalTombstoneRead?.();
          }
          return rows;
        });
        const vectorQuery = vi.spyOn(vectorStore, 'query');

        const storing = store.store(trace);
        await storeWriteStarted;
        const reading = readPath === 'query'
          ? store.query('remember this detail', neutralMood, {
              scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
            })
          : store.getByScope('user', 'u1');
        await tombstoneRead;
        releaseStoreWrite?.();
        const [, result] = await Promise.all([storing, reading]);

        const ids = Array.isArray(result)
          ? result.map((item) => item.id)
          : result.scored.map((item) => item.id);
        expect(ids).toContain('t1');
        expect(store.isDeleted('t1')).toBe(false);
        expect(store.getTrace('t1')?.isActive).toBe(true);
        if (readPath === 'getByScope') {
          expect(vectorQuery).not.toHaveBeenCalled();
        }
      } finally {
        releaseStoreWrite?.();
        await brain.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it('a lifecycle isActive flip cannot resurrect a soft-deleted trace via recordAccess', async () => {
    const vectorStore = await mkVectorStore();
    const store = mkStore(vectorStore);
    await store.store(mkTrace('t1', 'remember this detail'));
    await store.softDelete('t1');

    // The working-memory eviction hook used to re-activate ANY inactive
    // cached trace, flipping tombstones back to live and letting the
    // reinforcement sweep re-embed + re-upsert the deleted document.
    const zombie = store.getTrace('t1');
    if (zombie) zombie.isActive = true;
    expect(store.isDeleted('t1')).toBe(true);

    const upsertSpy = vi.spyOn(vectorStore, 'upsert');
    expect(await store.recordAccess('t1')).toBeNull();
    expect(upsertSpy).not.toHaveBeenCalled();

    // Re-storing the same cached tombstone object is an explicit revival.
    if (!zombie) throw new Error('expected cached tombstone');
    zombie.isActive = false;
    await store.store(zombie);
    expect(store.isDeleted('t1')).toBe(false);
    expect(store.getTrace('t1')?.isActive).toBe(true);
    expect((await store.query('remember this detail', neutralMood, {
      scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
    })).scored.map((trace) => trace.id)).toContain('t1');
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

  it('does not report a revival successful when the vector provider reports failure', async () => {
    const vectorStore = await mkVectorStore();
    const store = mkStore(vectorStore);
    const trace = mkTrace('t1', 'remember this detail');
    await store.store(trace);
    await store.softDelete(trace.id);
    expect(trace.isActive).toBe(false);

    vi.spyOn(vectorStore, 'upsert').mockResolvedValueOnce({
      upsertedCount: 0,
      failedCount: 1,
      errors: [{ id: trace.id, message: 'simulated provider failure' }],
    });

    await expect(store.store(trace)).rejects.toThrow('vector provider rejected');
    expect(trace.isActive).toBe(false);
    expect(store.isDeleted(trace.id)).toBe(true);
  });

  it.each(['throw', 'zero'] as const)(
    'fails closed when a durable store write returns %s after vector upsert',
    async (failureMode) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
      const brain = await Brain.openSqlite(path.join(tmpDir, 'brain.sqlite'));
      try {
        const vectorStore = await mkVectorStore();
        const store = mkStore(vectorStore);
        store.setBrain(brain);
        const trace = mkTrace('t1', 'durable detail');
        const originalRun = brain.run.bind(brain);
        const runSpy = vi.spyOn(brain, 'run').mockImplementation(async (sql, params) => {
          if (sql.includes('memory_traces') && Array.isArray(params) && params.length > 10) {
            if (failureMode === 'throw') {
              throw new Error('simulated durable write outage');
            }
            return { changes: 0 };
          }
          return originalRun(sql, params);
        });

        await expect(store.store(trace)).rejects.toThrow('durable trace write failed');
        expect(trace.isActive).toBe(false);
        expect(store.isDeleted(trace.id)).toBe(true);
        const probe = new Array(16).fill(0).map((_, index) => (index === 0 ? 1 : 0));
        const providerResult = await vectorStore.query('cogmem_user_u1', probe, {
          topK: 10,
          includeMetadata: true,
        });
        // The SQL outcome is ambiguous, so rollback must not destructively
        // erase a vector that could belong to a concurrent successful writer.
        // Durable validation, rather than provider deletion, fences recall.
        expect(providerResult.documents.map((document) => document.id)).toContain('t1');
        expect((await store.query('durable detail', neutralMood, {
          scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
        })).scored).toEqual([]);
        expect(await store.getByScope('user', 'u1')).toEqual([]);

        runSpy.mockRestore();
        await store.store(trace);
        expect(store.isDeleted(trace.id)).toBe(false);
        expect((await store.query('durable detail', neutralMood, {
          scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
        })).scored.map((item) => item.id)).toContain('t1');
      } finally {
        await brain.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it('does not erase a concurrent cross-token writer after an ambiguous durable failure', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dbPath = path.join(tmpDir, 'brain.sqlite');
    let brainA: Brain | undefined;
    let brainB: Brain | undefined;
    let releaseFailure: (() => void) | undefined;
    try {
      brainA = await Brain.openSqlite(dbPath, {
        brainId: 'brain',
        coordinationToken: {},
      });
      brainB = await Brain.openSqlite(dbPath, {
        brainId: 'brain',
        coordinationToken: {},
      });
      const vectorStore = await mkVectorStore();
      const failingStore = mkStore(vectorStore);
      const successfulStore = mkStore(vectorStore);
      failingStore.setBrain(brainA);
      successfulStore.setBrain(brainB);

      let signalFailureStarted: (() => void) | undefined;
      const failureStarted = new Promise<void>((resolve) => {
        signalFailureStarted = resolve;
      });
      const failureGate = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
      const originalRun = brainA.run.bind(brainA);
      vi.spyOn(brainA, 'run').mockImplementation(async (sql, params) => {
        if (sql.includes('memory_traces') && Array.isArray(params) && params.length > 10) {
          signalFailureStarted?.();
          await failureGate;
          throw new Error('ambiguous durable failure');
        }
        return originalRun(sql, params);
      });

      const failedWrite = failingStore.store(mkTrace('shared-id', 'failed detail'));
      await failureStarted;
      await successfulStore.store(mkTrace('shared-id', 'committed detail'));
      releaseFailure?.();
      await expect(failedWrite).rejects.toThrow('durable trace write failed');

      const recall = await successfulStore.query('committed detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });
      expect(recall.scored.map((item) => item.content)).toContain('committed detail');
      const probe = new Array(16).fill(0).map((_, index) => (index === 0 ? 1 : 0));
      const providerResult = await vectorStore.query('cogmem_user_u1', probe, {
        topK: 10,
        includeMetadata: true,
        includeTextContent: true,
      });
      expect(providerResult.documents.find((document) => document.id === 'shared-id')?.textContent)
        .toBe('committed detail');
    } finally {
      releaseFailure?.();
      await brainB?.close();
      await brainA?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails recall closed when durable tombstone validation is unavailable', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const brain = await Brain.openSqlite(path.join(tmpDir, 'brain.sqlite'));
    try {
      const vectorStore = await mkVectorStore();
      const writer = mkStore(vectorStore);
      writer.setBrain(brain);
      await writer.store(mkTrace('t1', 'remember this detail'));

      const coldStore = mkStore(vectorStore);
      coldStore.setBrain(brain);
      const originalAll = brain.all.bind(brain) as typeof brain.all;
      vi.spyOn(brain, 'all').mockImplementation(async <T = unknown>(
        sql: string,
        params?: StorageParameters,
      ) => {
        if (sql.includes('id IN')) throw new Error('simulated durable read outage');
        return originalAll<T>(sql, params);
      });

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

  it('fails every scope closed when global tombstone validation is unavailable', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const brain = await Brain.openSqlite(path.join(tmpDir, 'brain.sqlite'));
    try {
      const vectorStore = await mkVectorStore();
      const writer = mkStore(vectorStore);
      writer.setBrain(brain);
      const reader = mkStore(vectorStore);
      reader.setBrain(brain);
      await writer.store(mkTrace('t1', 'remember this detail'));
      await writer.softDelete('t1');
      expect(reader.isDeleted('t1')).toBe(true);

      const originalAll = brain.all.bind(brain) as typeof brain.all;
      let durableReads = 0;
      vi.spyOn(brain, 'all').mockImplementation(async <T = unknown>(
        sql: string,
        params?: StorageParameters,
      ) => {
        if (sql.includes('id IN')) {
          durableReads += 1;
          if (durableReads === 1) throw new Error('simulated durable read outage');
        }
        return originalAll<T>(sql, params);
      });
      const vectorQuery = vi.spyOn(vectorStore, 'query');

      const recall = await reader.query('remember this detail', neutralMood, {
        scopes: [
          { scope: 'user' as MemoryScope, scopeId: 'u1' },
          { scope: 'organization' as MemoryScope, scopeId: 'o1' },
        ],
      });
      expect(recall.scored).toEqual([]);
      expect(durableReads).toBe(1);
      expect(vectorQuery).not.toHaveBeenCalled();
    } finally {
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fences provider documents that have no durable Brain row', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const brain = await Brain.openSqlite(path.join(tmpDir, 'brain.sqlite'));
    try {
      const vectorStore = await mkVectorStore();
      const providerOnlyStore = mkStore(vectorStore);
      await providerOnlyStore.store(mkTrace('t1', 'provider-only detail'));

      const durableStore = mkStore(vectorStore);
      durableStore.setBrain(brain);
      const recall = await durableStore.query('provider-only detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });

      expect(recall.scored).toEqual([]);
      expect(durableStore.isDeleted('t1')).toBe(true);
    } finally {
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rechecks a missing durable row after an in-flight store leaves the trace queue', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const brain = await Brain.openSqlite(path.join(tmpDir, 'brain.sqlite'));
    let releaseStoreWrite: (() => void) | undefined;
    try {
      const vectorStore = await mkVectorStore();
      const writer = mkStore(vectorStore);
      writer.setBrain(brain);
      const reader = mkStore(vectorStore);
      reader.setBrain(brain);

      const originalRun = brain.run.bind(brain);
      let signalStoreWriteStarted: (() => void) | undefined;
      const storeWriteStarted = new Promise<void>((resolve) => {
        signalStoreWriteStarted = resolve;
      });
      const storeWriteGate = new Promise<void>((resolve) => {
        releaseStoreWrite = resolve;
      });
      vi.spyOn(brain, 'run').mockImplementation(async (sql, params) => {
        if (sql.includes('memory_traces') && Array.isArray(params) && params.length > 10) {
          signalStoreWriteStarted?.();
          await storeWriteGate;
        }
        return originalRun(sql, params);
      });

      const storing = writer.store(mkTrace('t1', 'new durable detail'));
      await storeWriteStarted;

      const originalAll = brain.all.bind(brain) as typeof brain.all;
      let signalMissingRead: (() => void) | undefined;
      const missingRead = new Promise<void>((resolve) => {
        signalMissingRead = resolve;
      });
      vi.spyOn(brain, 'all').mockImplementation(async <T = unknown>(
        sql: string,
        params?: StorageParameters,
      ) => {
        const rows = await originalAll<T>(sql, params);
        if (
          sql.includes('id IN') &&
          Array.isArray(params) &&
          params.includes('t1') &&
          rows.length === 0
        ) {
          signalMissingRead?.();
        }
        return rows;
      });

      const reading = reader.query('new durable detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });
      await missingRead;
      releaseStoreWrite?.();
      const [, recall] = await Promise.all([storing, reading]);

      expect(recall.scored.map((trace) => trace.id)).toContain('t1');
      expect(reader.isDeleted('t1')).toBe(false);
      expect(reader.getTrace('t1')?.isActive).toBe(true);
    } finally {
      releaseStoreWrite?.();
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reconciles a durable revival made outside the local coordination namespace', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dbPath = path.join(tmpDir, 'brain.sqlite');
    const brain = await Brain.openSqlite(dbPath);
    let externalBrain: Brain | undefined;
    try {
      const externalAdapter = await resolveStorageAdapter({
        filePath: dbPath,
        priority: ['better-sqlite3'],
        quiet: true,
      });
      externalBrain = await Brain.openWithAdapter(externalAdapter, {
        brainId: brain.brainId,
        coordinationToken: {},
      });
      expect(externalBrain.coordinationToken).not.toBe(brain.coordinationToken);

      const localStore = mkStore(await mkVectorStore());
      localStore.setBrain(brain);
      await localStore.store(mkTrace('t1', 'original detail'));
      await localStore.softDelete('t1');

      const externalStore = mkStore(await mkVectorStore());
      externalStore.setBrain(externalBrain);
      await externalStore.store(mkTrace('t1', 'revived detail'));

      const recall = await localStore.query('revived detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });
      expect(recall.scored.map((trace) => trace.id)).toContain('t1');
      expect(localStore.getTrace('t1')?.content).toBe('revived detail');
      expect(localStore.isDeleted('t1')).toBe(false);
    } finally {
      await externalBrain?.close();
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('durable validation does not erase a concurrent cross-namespace revival vector', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dbPath = path.join(tmpDir, 'brain.sqlite');
    const brain = await Brain.openSqlite(dbPath);
    let externalBrain: Brain | undefined;
    let releaseRevivalWrite: (() => void) | undefined;
    try {
      const externalAdapter = await resolveStorageAdapter({
        filePath: dbPath,
        priority: ['better-sqlite3'],
        quiet: true,
      });
      externalBrain = await Brain.openWithAdapter(externalAdapter, {
        brainId: brain.brainId,
        coordinationToken: {},
      });
      const vectorStore = await mkVectorStore();
      const localStore = mkStore(vectorStore);
      localStore.setBrain(brain);
      await localStore.store(mkTrace('t1', 'original detail'));
      await localStore.softDelete('t1');

      const originalRun = externalBrain.run.bind(externalBrain);
      let signalRevivalWrite: (() => void) | undefined;
      const revivalWriteStarted = new Promise<void>((resolve) => {
        signalRevivalWrite = resolve;
      });
      const revivalWriteGate = new Promise<void>((resolve) => {
        releaseRevivalWrite = resolve;
      });
      vi.spyOn(externalBrain, 'run').mockImplementation(async (sql, params) => {
        if (sql.includes('memory_traces') && Array.isArray(params) && params.length > 10) {
          signalRevivalWrite?.();
          await revivalWriteGate;
        }
        return originalRun(sql, params);
      });

      const externalStore = mkStore(vectorStore);
      externalStore.setBrain(externalBrain);
      const reviving = externalStore.store(mkTrace('t1', 'revived detail'));
      await revivalWriteStarted;

      const duringRevival = await localStore.query('revived detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });
      expect(duringRevival.scored).toEqual([]);
      const probe = new Array(16).fill(0).map((_, index) => (index === 0 ? 1 : 0));
      expect((await vectorStore.query('cogmem_user_u1', probe, {
        topK: 10,
        includeMetadata: true,
      })).documents.map((document) => document.id)).toContain('t1');

      releaseRevivalWrite?.();
      await reviving;
      expect((await localStore.query('revived detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      })).scored.map((trace) => trace.id)).toContain('t1');
    } finally {
      releaseRevivalWrite?.();
      await externalBrain?.close();
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('filters a graph candidate deleted outside the local coordination namespace', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const dbPath = path.join(tmpDir, 'brain.sqlite');
    const brain = await Brain.openSqlite(dbPath);
    let externalBrain: Brain | undefined;
    try {
      const externalAdapter = await resolveStorageAdapter({
        filePath: dbPath,
        priority: ['better-sqlite3'],
        quiet: true,
      });
      externalBrain = await Brain.openWithAdapter(externalAdapter, {
        brainId: brain.brainId,
        coordinationToken: {},
      });
      const localStore = mkStore(await mkVectorStore());
      localStore.setBrain(brain);
      await localStore.store(mkTrace('t1', 'private deleted detail'));

      const externalStore = mkStore(await mkVectorStore());
      externalStore.setBrain(externalBrain);
      await externalStore.softDelete('t1');

      expect(await localStore.filterRecallableTraceIds(['t1'])).toEqual(new Set());
      expect(localStore.isDeleted('t1')).toBe(true);
    } finally {
      await externalBrain?.close();
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps a failed durable delete authoritative until an explicit revival', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const brain = await Brain.openSqlite(path.join(tmpDir, 'brain.sqlite'));
    try {
      const store = mkStore(await mkVectorStore());
      store.setBrain(brain);
      const trace = mkTrace('t1', 'remember this detail');
      await store.store(trace);

      const originalRun = brain.run.bind(brain);
      vi.spyOn(brain, 'run').mockImplementation(async (sql, params) => {
        if (sql.startsWith('UPDATE memory_traces SET deleted = 1')) {
          throw new Error('simulated durable write outage');
        }
        return originalRun(sql, params);
      });

      await expect(store.softDelete(trace.id)).rejects.toThrow(
        'durable tombstone write failed',
      );
      expect(store.isDeleted(trace.id)).toBe(true);
      expect((await store.query('remember this detail', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      })).scored).toEqual([]);

      vi.restoreAllMocks();
      await store.store(trace);
      expect(store.isDeleted(trace.id)).toBe(false);
    } finally {
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('an in-flight delete still evicts its source after the store is disposed', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const brain = await Brain.openSqlite(path.join(tmpDir, 'brain.sqlite'));
    let releaseDeleteWrite: (() => void) | undefined;
    try {
      const vectorStore = await mkVectorStore();
      const store = mkStore(vectorStore);
      store.setBrain(brain);
      await store.store(mkTrace('t1', 'remember this detail'));

      const originalRun = brain.run.bind(brain);
      let signalDeleteWrite: (() => void) | undefined;
      const deleteWriteStarted = new Promise<void>((resolve) => {
        signalDeleteWrite = resolve;
      });
      const deleteWriteGate = new Promise<void>((resolve) => {
        releaseDeleteWrite = resolve;
      });
      vi.spyOn(brain, 'run').mockImplementation(async (sql, params) => {
        if (sql.startsWith('UPDATE memory_traces SET deleted = 1')) {
          signalDeleteWrite?.();
          await deleteWriteGate;
        }
        return originalRun(sql, params);
      });

      const deleting = store.softDelete('t1');
      await deleteWriteStarted;
      store.dispose();
      releaseDeleteWrite?.();
      await deleting;

      const probe = new Array(16).fill(0).map((_, index) => (index === 0 ? 1 : 0));
      const vectorResult = await vectorStore.query('cogmem_user_u1', probe, {
        topK: 10,
        includeMetadata: true,
      });
      expect(vectorResult.documents.map((document) => document.id)).not.toContain('t1');
    } finally {
      releaseDeleteWrite?.();
      await brain.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses unambiguous coordination identities and resolves SQLite symlinks', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    const pathA = path.join(tmpDir, 'a');
    const pathB = path.join(tmpDir, 'a:b');
    const alias = path.join(tmpDir, 'alias.sqlite');
    let brainA: Brain | undefined;
    let brainB: Brain | undefined;
    let aliasBrain: Brain | undefined;
    try {
      brainA = await Brain.openSqlite(pathA, { brainId: 'b:c' });
      brainB = await Brain.openSqlite(pathB, { brainId: 'c' });
      fs.symlinkSync(pathA, alias);
      aliasBrain = await Brain.openSqlite(alias, { brainId: 'b:c' });
      expect(brainA.coordinationToken).not.toBe(brainB.coordinationToken);
      expect(brainA.coordinationToken).toBe(aliasBrain.coordinationToken);
    } finally {
      await aliasBrain?.close();
      await brainB?.close();
      await brainA?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('matches better-sqlite3 file identities to its runtime URI setting', async () => {
    const stem = `.brainhydration-uri-${process.pid}-${Date.now()}.sqlite`;
    const dbPath = path.resolve(stem);
    const uriPath = `file:${stem}`;
    let pathBrain: Brain | undefined;
    let uriBrain: Brain | undefined;
    try {
      pathBrain = await Brain.openSqlite(dbPath, { priority: ['better-sqlite3'] });
      uriBrain = await Brain.openSqlite(uriPath, {
        priority: ['better-sqlite3'],
      });
      await pathBrain.exec(
        'CREATE TABLE uri_identity_probe (id TEXT PRIMARY KEY)',
      );
      await pathBrain.run(
        'INSERT INTO uri_identity_probe (id) VALUES (?)',
        ['shared-resource'],
      );
      const sharesBackingResource = await uriBrain
        .get<{ id: string }>(
          'SELECT id FROM uri_identity_probe WHERE id = ?',
          ['shared-resource'],
        )
        .then((row) => row?.id === 'shared-resource')
        .catch(() => false);

      if (sharesBackingResource) {
        expect(pathBrain.brainId).toBe(uriBrain.brainId);
        expect(pathBrain.coordinationToken).toBe(uriBrain.coordinationToken);
      } else {
        expect(pathBrain.brainId).not.toBe(uriBrain.brainId);
        expect(pathBrain.coordinationToken).not.toBe(uriBrain.coordinationToken);
      }
    } finally {
      await uriBrain?.close();
      await pathBrain?.close();
      fs.rmSync(path.resolve(uriPath), { force: true });
      fs.rmSync(dbPath, { force: true });
    }
  });

  it('normalizes equivalent shared-memory URI names', async () => {
    const memoryName = `agentos-memory-${process.pid}-${Date.now()}`;
    const probeStem = `.brainhydration-uri-probe-${process.pid}-${Date.now()}.sqlite`;
    const probePath = path.resolve(probeStem);
    const probeUriPath = `file:${probeStem}`;
    let pathProbe: Brain | undefined;
    let uriProbe: Brain | undefined;
    let singleSlashBrain: Brain | undefined;
    let tripleSlashBrain: Brain | undefined;
    try {
      pathProbe = await Brain.openSqlite(probePath, { priority: ['better-sqlite3'] });
      uriProbe = await Brain.openSqlite(probeUriPath, { priority: ['better-sqlite3'] });
      await pathProbe.exec('CREATE TABLE uri_mode_probe (id TEXT PRIMARY KEY)');
      await pathProbe.run('INSERT INTO uri_mode_probe (id) VALUES (?)', ['recognized']);
      const uriModeEnabled = await uriProbe
        .get<{ id: string }>('SELECT id FROM uri_mode_probe WHERE id = ?', ['recognized'])
        .then((row) => row?.id === 'recognized')
        .catch(() => false);
      if (!uriModeEnabled) return;

      singleSlashBrain = await Brain.openSqlite(
        `file:/${memoryName}?mode=memory&cache=shared`,
        { brainId: 'brain', priority: ['better-sqlite3'] },
      );
      tripleSlashBrain = await Brain.openSqlite(
        `file:///${memoryName}?mode=memory&cache=shared`,
        { brainId: 'brain', priority: ['better-sqlite3'] },
      );
      await singleSlashBrain.exec(
        'CREATE TABLE shared_memory_identity_probe (id TEXT PRIMARY KEY)',
      );
      await singleSlashBrain.run(
        'INSERT INTO shared_memory_identity_probe (id) VALUES (?)',
        ['shared-memory'],
      );
      const sharedRow = await tripleSlashBrain
        .get<{ id: string }>(
          'SELECT id FROM shared_memory_identity_probe WHERE id = ?',
          ['shared-memory'],
        )
        .catch(() => undefined);
      if (!sharedRow) {
        expect(singleSlashBrain.coordinationToken).not.toBe(
          tripleSlashBrain.coordinationToken,
        );
        return;
      }
      expect(sharedRow).toEqual({ id: 'shared-memory' });
      expect(singleSlashBrain.coordinationToken).toBe(
        tripleSlashBrain.coordinationToken,
      );
    } finally {
      await tripleSlashBrain?.close();
      await singleSlashBrain?.close();
      await uriProbe?.close();
      await pathProbe?.close();
      fs.rmSync(path.resolve(probeUriPath), { force: true });
      fs.rmSync(probePath, { force: true });
    }
  });

  it('keeps temporary SQLite handles in separate coordination namespaces', async () => {
    const brainA = await Brain.openSqlite('', { priority: ['better-sqlite3'] });
    const brainB = await Brain.openSqlite('', { priority: ['better-sqlite3'] });
    try {
      expect(brainA.brainId).toBe('default');
      expect(brainB.brainId).toBe('default');
      expect(brainA.coordinationToken).not.toBe(brainB.coordinationToken);
    } finally {
      await brainB.close();
      await brainA.close();
    }
  });

  it('matches private memory URI coordination to actual backing state', async () => {
    const name = `.brainhydration-private-${process.pid}-${Date.now()}`;
    const uriPath = `file:${name}?mode=memory&cache=private`;
    let brainA: Brain | undefined;
    let brainB: Brain | undefined;
    try {
      brainA = await Brain.openSqlite(uriPath, { priority: ['better-sqlite3'] });
      brainB = await Brain.openSqlite(uriPath, { priority: ['better-sqlite3'] });
      await brainA.exec('CREATE TABLE private_identity_probe (id TEXT PRIMARY KEY)');
      await brainA.run('INSERT INTO private_identity_probe (id) VALUES (?)', ['probe']);
      const sharesBackingResource = await brainB
        .get<{ id: string }>('SELECT id FROM private_identity_probe WHERE id = ?', ['probe'])
        .then((row) => row?.id === 'probe')
        .catch(() => false);

      if (sharesBackingResource) {
        expect(brainA.coordinationToken).toBe(brainB.coordinationToken);
      } else {
        expect(brainA.coordinationToken).not.toBe(brainB.coordinationToken);
      }
    } finally {
      await brainB?.close();
      await brainA?.close();
      fs.rmSync(path.resolve(uriPath), { force: true });
    }
  });

  it('keeps sql.js literal file names distinct from better-sqlite3 URI aliases', async () => {
    const ordinaryDir = fs.mkdtempSync(
      path.join(process.cwd(), '.brainhydration-sqljs-'),
    );
    const relativeDir = path.basename(ordinaryDir);
    const uriLiteralDir = path.resolve(`file:${relativeDir}`);
    const ordinaryPath = path.join(ordinaryDir, 'brain.sqlite');
    const uriLiteralPath = `file:${relativeDir}/brain.sqlite`;
    let ordinaryBrain: Brain | undefined;
    let uriLiteralBrain: Brain | undefined;
    try {
      ordinaryBrain = await Brain.openSqlite(ordinaryPath, {
        brainId: 'brain',
        priority: ['sqljs'],
      });
      uriLiteralBrain = await Brain.openSqlite(uriLiteralPath, {
        brainId: 'brain',
        priority: ['sqljs'],
      });
      expect(ordinaryBrain.coordinationToken).not.toBe(
        uriLiteralBrain.coordinationToken,
      );
    } finally {
      await uriLiteralBrain?.close();
      await ordinaryBrain?.close();
      fs.rmSync(uriLiteralDir, { recursive: true, force: true });
      fs.rmSync(ordinaryDir, { recursive: true, force: true });
    }
  });

  it('locks Brain attachment after passive sibling deletion or revival', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    let targetBrain: Brain | undefined;
    let source: MemoryStore | undefined;
    let deletePassive: MemoryStore | undefined;
    let revivePassive: MemoryStore | undefined;
    try {
      targetBrain = await Brain.openSqlite(path.join(tmpDir, 'target.sqlite'));
      const vectorStore = await mkVectorStore();
      source = mkStore(vectorStore);
      const trace = mkTrace('t1', 'shared vector detail');
      await source.store(trace);

      deletePassive = mkStore(vectorStore);
      await source.softDelete(trace.id);
      expect(deletePassive.isDeleted(trace.id)).toBe(true);
      expect(() => deletePassive!.setBrain(targetBrain!)).toThrow(
        'attach a Brain before starting memory operations',
      );

      revivePassive = mkStore(vectorStore);
      await source.store(trace);
      expect(revivePassive.getTrace(trace.id)?.content).toBe(trace.content);
      expect(() => revivePassive!.setBrain(targetBrain!)).toThrow(
        'attach a Brain before starting memory operations',
      );
    } finally {
      revivePassive?.dispose();
      deletePassive?.dispose();
      source?.dispose();
      await targetBrain?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('binds a Brain before use and rejects backing-resource migration', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainhydration-'));
    let brainA: Brain | undefined;
    let brainAlias: Brain | undefined;
    let brainB: Brain | undefined;
    let boundStore: MemoryStore | undefined;
    let lateStore: MemoryStore | undefined;
    try {
      const pathA = path.join(tmpDir, 'a.sqlite');
      brainA = await Brain.openSqlite(pathA, { brainId: 'brain' });
      brainAlias = await Brain.openSqlite(pathA, { brainId: 'brain' });
      brainB = await Brain.openSqlite(path.join(tmpDir, 'b.sqlite'), {
        brainId: 'brain',
      });

      boundStore = mkStore(await mkVectorStore());
      boundStore.setBrain(brainA);
      await boundStore.query('nothing yet', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });
      expect(() => boundStore!.setBrain(brainAlias!)).not.toThrow();
      expect(() => boundStore!.setBrain(brainB!)).toThrow(
        'cannot switch to a different backing resource',
      );

      lateStore = mkStore(await mkVectorStore());
      await lateStore.query('nothing yet', neutralMood, {
        scopes: [{ scope: 'user' as MemoryScope, scopeId: 'u1' }],
      });
      expect(() => lateStore!.setBrain(brainA!)).toThrow(
        'attach a Brain before starting memory operations',
      );
    } finally {
      lateStore?.dispose();
      boundStore?.dispose();
      await brainB?.close();
      await brainAlias?.close();
      await brainA?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
