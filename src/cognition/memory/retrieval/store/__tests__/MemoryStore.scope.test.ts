/**
 * @file MemoryStore.scope.test.ts
 * One scope at a time: `hydrateScope` loads a returning user's oldest trace that the whole-brain hydration (the
 * 1,000 most recent traces) leaves out; `refileScope` moves a scope's traces to another scope id in the Brain, the
 * cache, the vector index and the knowledge graph's copy, its soft-deleted rows, a trace held with no embedding and,
 * with no Brain, the documents another store filed into a durable index included, and recall under the old id finds
 * none of them though the index failed to delete an old document; a trace's `turnUserId` survives a restart, and
 * `deleteScope` with `turnUserId` deletes only that user's traces of the scope. Real SQLite Brains.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../Brain.js';
import { MemoryStore } from '../MemoryStore.js';
import { InMemoryVectorStore } from '../../../../rag/vector_stores/InMemoryVectorStore.js';
import { KnowledgeGraph } from '../../graph/knowledge/KnowledgeGraph.js';
import type { IEmbeddingManager } from '../../../../../core/embeddings/IEmbeddingManager.js';
import type { MemoryTrace } from '../../../core/types.js';
import type { VectorStoreProviderConfig } from '../../../../../core/vector-store/IVectorStore.js';

const dirs: string[] = [];
const brains: Brain[] = [];
afterEach(async () => {
  while (brains.length) await brains.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const VECTOR = [1, 0, 0, 0];
const MOOD = { valence: 0, arousal: 0, dominance: 0 };

const fixedEmbedder = {
  generateEmbeddings: async (input: { texts: string | string[] }) => ({
    embeddings: (Array.isArray(input.texts) ? input.texts : [input.texts]).map(() => VECTOR),
    model: 'fixed',
    usage: { promptTokens: 0, totalTokens: 0 },
  }),
} as unknown as IEmbeddingManager;

/** An empty in-memory vector store of four dimensions. */
async function vectorStoreOf4(): Promise<InMemoryVectorStore> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: `scope-${Math.random()}`, type: 'in_memory', defaultEmbeddingDimension: 4, similarityMetric: 'cosine' } as VectorStoreProviderConfig);
  return vectorStore;
}

/** A store with no Brain over a vector index and a graph that outlive it, as a host restarts one over a durable index. */
function storeWithoutBrain(vectorStore: InMemoryVectorStore, graph: KnowledgeGraph): MemoryStore {
  return new MemoryStore({ vectorStore, embeddingManager: fixedEmbedder, knowledgeGraph: graph, collectionPrefix: 'cogmem' });
}

/** The ids of the documents one collection of the index holds. */
async function idsIn(vectorStore: InMemoryVectorStore, collection: string): Promise<string[]> {
  return (await vectorStore.scanByMetadata(collection, { limit: 100 })).documents.map((document) => document.id).sort();
}

async function openBrain(filePath: string): Promise<Brain> {
  const brain = await Brain.openSqlite(filePath, { brainId: 'b' });
  brains.push(brain);
  return brain;
}

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-scope-'));
  dirs.push(dir);
  return path.join(dir, 'brain.sqlite');
}

async function storeOver(brain: Brain, graph = new KnowledgeGraph(), vectorStore?: InMemoryVectorStore): Promise<MemoryStore> {
  const store = new MemoryStore({
    vectorStore: vectorStore ?? (await vectorStoreOf4()),
    embeddingManager: fixedEmbedder,
    knowledgeGraph: graph,
    collectionPrefix: 'cogmem',
  });
  store.setBrain(brain);
  return store;
}

function trace(id: string, scopeId: string, createdAt: number, extra: Partial<MemoryTrace> = {}): MemoryTrace {
  return {
    id, type: 'episodic', scope: 'user', scopeId, content: `content of ${id}`, entities: [], tags: [],
    provenance: { sourceType: 'user_statement', sourceTimestamp: createdAt, confidence: 1, verificationCount: 0 },
    emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: '' },
    encodingStrength: 1, stability: 3_600_000, retrievalCount: 0, lastAccessedAt: createdAt, accessCount: 0,
    reinforcementInterval: 3_600_000, associatedTraceIds: [], createdAt, updatedAt: createdAt, isActive: true,
    ...extra,
  } as MemoryTrace;
}

describe('hydrateScope', () => {
  it("loads a returning user's oldest trace that the 1,000 most recent of the brain leave out", async () => {
    const filePath = tempFile();
    const brain = await openBrain(filePath);
    await (await storeOver(brain)).store(trace('t-ana', 'ana', 1_000));
    const blob = Buffer.from(Float32Array.from(VECTOR).buffer);
    await brain.transaction(async (trx) => {
      for (let i = 0; i < 1_200; i += 1) {
        await trx.run(
          `INSERT INTO memory_traces (brain_id, id, type, scope, content, embedding, strength, created_at, tags, emotions, metadata, deleted, scope_id)
           VALUES ('b', ?, 'episodic', 'user', ?, ?, 1, ?, '[]', '{}', ?, 0, ?)`,
          [`t-${i}`, `note ${i}`, blob, 2_000 + i, JSON.stringify({ scopeId: `u-${i}` }), `u-${i}`],
        );
      }
    });

    const plain = await storeOver(brain);
    expect(await plain.getByScope('user', 'ana')).toEqual([]);

    const scoped = await storeOver(brain);
    expect(await scoped.hydrateScope('user', 'ana')).toBe(1);
    expect((await scoped.getByScope('user', 'ana')).map((t) => t.id)).toEqual(['t-ana']);
    expect(await scoped.hydrateScope('user', 'ana')).toBe(0);
  });
});

describe('refileScope', () => {
  it("moves a scope's traces to another scope id in the Brain, the cache, recall and the graph copy", async () => {
    const filePath = tempFile();
    const brain = await openBrain(filePath);
    const graph = new KnowledgeGraph();
    const store = await storeOver(brain, graph);
    await store.store(trace('t-1', '42', 1_000));
    await store.store(trace('t-2', '42', 1_001));
    await store.store(trace('t-3', '7', 1_002));

    expect(await store.refileScope('user', '42', 'A/42')).toBe(2);

    const rows = await brain.all<{ id: string; scope_id: string; metadata: string }>('SELECT id, scope_id, metadata FROM memory_traces ORDER BY id');
    expect(rows.map((r) => [r.id, r.scope_id, JSON.parse(r.metadata).scopeId])).toEqual([
      ['t-1', 'A/42', 'A/42'], ['t-2', 'A/42', 'A/42'], ['t-3', '7', '7'],
    ]);
    expect((await store.getByScope('user', 'A/42')).map((t) => t.id).sort()).toEqual(['t-1', 't-2']);
    expect(await store.getByScope('user', '42')).toEqual([]);
    const copies = await graph.queryMemories({ limit: 100 });
    expect(copies.map((c) => [c.context?.memoryTraceId, c.context?.scopeId]).sort()).toEqual([
      ['t-1', 'A/42'], ['t-2', 'A/42'], ['t-3', '7'],
    ]);
    const restarted = await storeOver(brain);
    expect(await restarted.hydrateScope('user', 'A/42')).toBe(2);
  });

  it("moves the scope's soft-deleted rows too, so a delete of the new id finds every row", async () => {
    const brain = await openBrain(tempFile());
    const store = await storeOver(brain);
    await store.store(trace('t-1', '42', 1_000));
    await store.store(trace('t-2', '42', 1_001));
    await store.softDelete('t-2');

    expect(await store.refileScope('user', '42', 'A/42')).toBe(2);

    const rows = await brain.all<{ id: string; scope_id: string; deleted: number }>('SELECT id, scope_id, deleted FROM memory_traces ORDER BY id');
    expect(rows).toEqual([{ id: 't-1', scope_id: 'A/42', deleted: 0 }, { id: 't-2', scope_id: 'A/42', deleted: 1 }]);
    expect(await store.deleteScope('user', 'A/42')).toBe(2);
    expect(await brain.all('SELECT id FROM memory_traces')).toEqual([]);
  });

  it('moves the vector document of a trace it holds with no embedding cached', async () => {
    const vectorStore = await vectorStoreOf4();
    const graph = new KnowledgeGraph();
    const first = storeWithoutBrain(vectorStore, graph);
    await first.store(trace('t-1', '42', 1_000));
    const second = storeWithoutBrain(vectorStore, graph);
    // Read from the index, the trace is held with no embedding.
    expect((await second.getByScope('user', '42')).map((t) => t.id)).toEqual(['t-1']);

    expect(await second.refileScope('user', '42', 'A/42')).toBe(1);

    expect(await idsIn(vectorStore, 'cogmem_user_42')).toEqual([]);
    expect(await idsIn(vectorStore, 'cogmem_user_A/42')).toEqual(['t-1']);
    const recalled = await second.query('content of t-1', MOOD, { scopes: [{ scope: 'user', scopeId: 'A/42' }] });
    expect(recalled.scored.map((s) => s.id)).toEqual(['t-1']);
  });

  it('with no Brain moves the traces another store filed into the vector index before a restart', async () => {
    const vectorStore = await vectorStoreOf4();
    const graph = new KnowledgeGraph();
    const first = storeWithoutBrain(vectorStore, graph);
    await first.store(trace('t-1', '42', 1_000));
    await first.store(trace('t-2', '42', 1_001));
    await first.store(trace('t-3', '7', 1_002));
    first.dispose();
    const second = storeWithoutBrain(vectorStore, graph);

    expect(await second.refileScope('user', '42', 'A/42')).toBe(2);

    expect(await idsIn(vectorStore, 'cogmem_user_42')).toEqual([]);
    expect(await idsIn(vectorStore, 'cogmem_user_A/42')).toEqual(['t-1', 't-2']);
    expect((await second.getByScope('user', 'A/42')).map((t) => t.id).sort()).toEqual(['t-1', 't-2']);
    const later = storeWithoutBrain(vectorStore, graph);
    expect((await later.getByScope('user', 'A/42')).map((t) => [t.id, t.scopeId]).sort()).toEqual([['t-1', 'A/42'], ['t-2', 'A/42']]);
    expect(await later.getByScope('user', '42')).toEqual([]);
    const copies = await graph.queryMemories({ limit: 100 });
    expect(copies.map((c) => [c.context?.memoryTraceId, c.context?.scopeId]).sort()).toEqual([
      ['t-1', 'A/42'], ['t-2', 'A/42'], ['t-3', '7'],
    ]);
  });

  it('keeps recall under the old id from a trace whose old document the index failed to delete', async () => {
    const brain = await openBrain(tempFile());
    const vectorStore = await vectorStoreOf4();
    const store = await storeOver(brain, new KnowledgeGraph(), vectorStore);
    await store.store(trace('t-1', '42', 1_000));
    const remove = vectorStore.delete.bind(vectorStore);
    vectorStore.delete = async (name, ids, options) => {
      if (name === 'cogmem_user_42') throw new Error('index unavailable');
      return remove(name, ids, options);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await store.refileScope('user', '42', 'A/42')).toBe(1);

      expect(await idsIn(vectorStore, 'cogmem_user_42')).toEqual(['t-1']);
      const underOld = await store.query('content of t-1', MOOD, { scopes: [{ scope: 'user', scopeId: '42' }] });
      expect(underOld.scored).toEqual([]);
      expect(await store.getByScope('user', '42')).toEqual([]);
      const underNew = await store.query('content of t-1', MOOD, { scopes: [{ scope: 'user', scopeId: 'A/42' }] });
      expect(underNew.scored.map((s) => [s.id, s.scopeId])).toEqual([['t-1', 'A/42']]);
      expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('refileScope'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('turnUserId', () => {
  it('survives a restart, and deleteScope with it deletes only that user\'s traces of the scope', async () => {
    const filePath = tempFile();
    const brain = await openBrain(filePath);
    const store = await storeOver(brain);
    await store.store(trace('t-owner', '/s-1', 1_000));
    await store.store(trace('t-visitor', '/s-1', 1_001, { turnUserId: 'bo' } as Partial<MemoryTrace>));

    const restarted = await storeOver(brain);
    const loaded = await restarted.getByScope('user', '/s-1');
    expect(loaded.find((t) => t.id === 't-visitor')?.turnUserId).toBe('bo');
    expect(loaded.find((t) => t.id === 't-owner')?.turnUserId).toBeUndefined();

    // An empty user id names no user: refused, so a caller's missing id never widens the delete to the whole scope.
    await expect(restarted.deleteScope('user', '/s-1', { turnUserId: '' })).rejects.toThrow(TypeError);
    expect(await restarted.deleteScope('user', '/s-1', { turnUserId: 'bo' })).toBe(1);
    const rows = await brain.all<{ id: string }>('SELECT id FROM memory_traces ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual(['t-owner']);
  });
});
