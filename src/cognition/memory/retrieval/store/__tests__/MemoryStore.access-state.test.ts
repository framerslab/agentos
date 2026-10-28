/**
 * @file MemoryStore.access-state.test.ts
 * A trace's access state survives an access and a restart: after `recordAccess`, a fresh store over the same Brain
 * file (a restart) loads the stability, access count, reinforcement interval and next reinforcement time the access
 * left, and the provenance, entities, associated trace ids and structured data the trace was stored with. The store
 * keeps that state where the `Memory` facade keeps it, so the facade's feedback on the row between the access and the
 * restart is what the restarted store loads. With `persistAccessState: false` the store writes and loads as it did
 * before the fix. A real SQLite Brain; the vector store is the in-memory one, rebuilt for each store, as a restarted
 * process rebuilds it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../Brain.js';
import { MemoryStore, type MemoryStoreConfig } from '../MemoryStore.js';
import { Memory } from '../../../io/facade/Memory.js';
import { InMemoryVectorStore } from '../../../../rag/vector_stores/InMemoryVectorStore.js';
import type { IKnowledgeGraph } from '../../graph/knowledge/IKnowledgeGraph.js';
import type { IEmbeddingManager } from '../../../../../core/embeddings/IEmbeddingManager.js';
import type { MemoryTrace } from '../../../core/types.js';
import type { VectorStoreProviderConfig } from '../../../../../core/vector-store/IVectorStore.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function storeOver(brain: Brain, extra: Partial<MemoryStoreConfig> = {}): Promise<MemoryStore> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: `access-${Math.random()}`, type: 'in_memory', defaultEmbeddingDimension: 4, similarityMetric: 'cosine' } as VectorStoreProviderConfig);
  const store = new MemoryStore({
    vectorStore,
    embeddingManager: {
      generateEmbeddings: async (input: { texts: string | string[] }) => ({
        embeddings: (Array.isArray(input.texts) ? input.texts : [input.texts]).map(() => [1, 0, 0, 0]),
        model: 'fixed',
        usage: { promptTokens: 0, totalTokens: 0 },
      }),
    } as unknown as IEmbeddingManager,
    knowledgeGraph: { recordMemory: async () => ({}) } as unknown as IKnowledgeGraph,
    collectionPrefix: 'cogmem',
    ...extra,
  });
  store.setBrain(brain);
  return store;
}

function trace(now: number): MemoryTrace {
  return {
    id: 't-vera', type: 'episodic', scope: 'user', scopeId: 'ana', content: "Ana's sister is Vera.",
    entities: ['Vera', 'Ana'], tags: ['family'],
    provenance: { sourceType: 'user_statement', sourceTimestamp: now - 1000, confidence: 0.9, verificationCount: 2 },
    emotionalContext: { valence: 0.2, arousal: 0.1, dominance: 0, intensity: 0.4, gmiMood: 'neutral' },
    encodingStrength: 0.8, stability: 7_200_000, retrievalCount: 0, lastAccessedAt: now - 1000, accessCount: 0,
    reinforcementInterval: 3_600_000, associatedTraceIds: ['t-earlier'], structuredData: { relation: 'sister' },
    createdAt: now - 1000, updatedAt: now - 1000, isActive: true,
  } as MemoryTrace;
}

/** A Brain file in a directory of its own, removed after the test. */
function brainFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-state-'));
  dirs.push(dir);
  return path.join(dir, 'brain.sqlite');
}

/** Stores the trace in the file's Brain, accesses it once, closes the Brain, and returns the cached trace after the access. */
async function storeAndAccess(filePath: string, extra: Partial<MemoryStoreConfig> = {}): Promise<MemoryTrace> {
  const brain = await Brain.openSqlite(filePath, { brainId: 'b' });
  try {
    const store = await storeOver(brain, extra);
    await store.store(trace(Date.now()));
    expect(await store.recordAccess('t-vera')).not.toBeNull();
    return structuredClone(store.getTrace('t-vera')!);
  } finally {
    await brain.close();
  }
}

/** Opens the file again, as a restarted process does, and returns the trace a fresh store loads from it. */
async function reload(filePath: string, extra: Partial<MemoryStoreConfig> = {}): Promise<MemoryTrace> {
  const brain = await Brain.openSqlite(filePath, { brainId: 'b' });
  try {
    const store = await storeOver(brain, extra);
    const [reloaded] = await store.getByScope('user', 'ana');
    expect(reloaded).toBeDefined();
    return structuredClone(reloaded!);
  } finally {
    await brain.close();
  }
}

/** Stores the trace, accesses it once, restarts, and returns the cached trace after the access and the reloaded one. */
async function accessThenRestart(extra: Partial<MemoryStoreConfig> = {}): Promise<{ accessed: MemoryTrace; reloaded: MemoryTrace }> {
  const filePath = brainFile();
  const accessed = await storeAndAccess(filePath, extra);
  return { accessed, reloaded: await reload(filePath, extra) };
}

const storedWith = {
  provenance: { sourceType: 'user_statement', confidence: 0.9, verificationCount: 2 },
  entities: ['Vera', 'Ana'],
  associatedTraceIds: ['t-earlier'],
  structuredData: { relation: 'sister' },
};

describe('a trace after an access and a restart', () => {
  it('keeps its stability, access count and reinforcement schedule, and everything it was stored with', async () => {
    const { accessed, reloaded } = await accessThenRestart();
    expect(accessed.accessCount).toBe(1);
    expect(accessed.stability).toBeGreaterThan(7_200_000);
    expect(accessed.reinforcementInterval).toBe(7_200_000);
    expect(accessed.nextReinforcementAt).toBe(accessed.lastAccessedAt + 7_200_000);
    expect(reloaded).toMatchObject({
      stability: accessed.stability,
      accessCount: 1,
      reinforcementInterval: 7_200_000,
      nextReinforcementAt: accessed.nextReinforcementAt,
      ...storedWith,
      retrievalCount: 1,
    });
  });

  it("loads the access the Memory facade's feedback adds to the same row, on top of the store's own", async () => {
    const filePath = brainFile();
    const accessed = await storeAndAccess(filePath);
    const memory = await Memory.createSqlite(filePath, { brainId: 'b' });
    try {
      await memory.feedback('t-vera', 'used');
    } finally {
      await memory.close();
    }
    const reloaded = await reload(filePath);
    // The feedback read the state the store's access left (one access, a two-hour interval) and added one access.
    expect(reloaded).toMatchObject({ accessCount: 2, reinforcementInterval: 14_400_000, retrievalCount: 2, ...storedWith });
    expect(reloaded.stability).toBeGreaterThan(accessed.stability);
  });

  it('with persistAccessState false, loads as before the fix: no access count, a one-hour interval, the stored stability', async () => {
    const { reloaded } = await accessThenRestart({ persistAccessState: false });
    expect(reloaded).toMatchObject({ stability: 7_200_000, accessCount: 0, reinforcementInterval: 3_600_000, retrievalCount: 1 });
    expect(reloaded.nextReinforcementAt).toBeUndefined();
  });
});
