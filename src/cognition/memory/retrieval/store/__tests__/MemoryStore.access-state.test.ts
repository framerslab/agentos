/**
 * @file MemoryStore.access-state.test.ts
 * A trace's access state survives an access and a restart: after `recordAccess`, a fresh store over the same Brain
 * file (a restart) loads the stability, access count, reinforcement interval and next reinforcement time the access
 * left, and the provenance, entities, associated trace ids and structured data the trace was stored with. The store
 * keeps that state where the `Memory` facade keeps it, so the facade's feedback on the row between the access and the
 * restart is what the restarted store loads, and an access another writer gives the row while the store holds the trace
 * (the facade's feedback, another store on the same file) is kept by the store's next access, which counts on top of
 * it. With `persistAccessState: false` the store writes and loads as it did
 * before the fix. A real SQLite Brain; the vector store is the in-memory one, rebuilt for each store, as a restarted
 * process rebuilds it. With no Brain, a store started later over the same vector store restores the reinforcement
 * schedule from the document's metadata.
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
import type { PADState } from '../../../core/config.js';
import type { VectorStoreProviderConfig } from '../../../../../core/vector-store/IVectorStore.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** An empty in-memory vector store of four dimensions. */
async function vectorStoreOf4(): Promise<InMemoryVectorStore> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: `access-${Math.random()}`, type: 'in_memory', defaultEmbeddingDimension: 4, similarityMetric: 'cosine' } as VectorStoreProviderConfig);
  return vectorStore;
}

/** A store over the vector store, with no Brain, embedding every text as one fixed vector. */
function storeWith(vectorStore: InMemoryVectorStore, extra: Partial<MemoryStoreConfig> = {}): MemoryStore {
  return new MemoryStore({
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
    embeddingDimension: 4,
    ...extra,
  });
}

async function storeOver(brain: Brain, extra: Partial<MemoryStoreConfig> = {}): Promise<MemoryStore> {
  const store = storeWith(await vectorStoreOf4(), extra);
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

/** Gives the row of `t-vera` in the file the `Memory` facade's feedback, through a second handle on the file. */
async function facadeFeedback(filePath: string, signal: 'used' | 'ignored'): Promise<void> {
  const memory = await Memory.createSqlite(filePath, { brainId: 'b' });
  try {
    await memory.feedback('t-vera', signal);
  } finally {
    await memory.close();
  }
}

// Another writer can change the row while a store holds the trace: the Memory facade on the same
// file (its recall and feedback), or another store over the file, as another process is. The
// store's next access counts on top of what the row holds then.
describe('an access after another writer changed the row the store holds the trace of', () => {
  it("keeps the access the Memory facade's feedback gave the row, and adds its own", async () => {
    const filePath = brainFile();
    const brain = await Brain.openSqlite(filePath, { brainId: 'b' });
    try {
      const store = await storeOver(brain);
      await store.store(trace(Date.now()));
      await facadeFeedback(filePath, 'used');
      expect(await store.recordAccess('t-vera')).not.toBeNull();
      // The feedback took the interval from one hour to two; the store's access doubles that.
      expect(store.getTrace('t-vera')).toMatchObject({ accessCount: 2, reinforcementInterval: 14_400_000, retrievalCount: 2 });
    } finally {
      await brain.close();
    }
    expect(await reload(filePath)).toMatchObject({
      accessCount: 2, reinforcementInterval: 14_400_000, retrievalCount: 2, ...storedWith,
    });
  });

  it("keeps the penalty the Memory facade's 'ignored' feedback gave the row", async () => {
    const now = Date.now();
    const accessed = async (feedback: boolean): Promise<MemoryTrace> => {
      const filePath = brainFile();
      const brain = await Brain.openSqlite(filePath, { brainId: 'b' });
      try {
        const store = await storeOver(brain);
        await store.store(trace(now));
        if (feedback) await facadeFeedback(filePath, 'ignored');
        expect(await store.recordAccess('t-vera')).not.toBeNull();
      } finally {
        await brain.close();
      }
      return reload(filePath);
    };
    const plain = await accessed(false);
    const penalized = await accessed(true);
    // The penalty halves the stability the access then grows.
    expect(penalized.stability).toBeLessThan(plain.stability * 0.75);
    expect(penalized.accessCount).toBe(1);
  });

  it('keeps the access another store on the same file made, and adds its own', async () => {
    const filePath = brainFile();
    const first = await Brain.openSqlite(filePath, { brainId: 'b' });
    const second = await Brain.openSqlite(filePath, { brainId: 'b' });
    try {
      const writer = await storeOver(first);
      await writer.store(trace(Date.now()));
      const reader = await storeOver(second);
      // The second store loads the trace from its row.
      expect((await reader.getByScope('user', 'ana')).map((held) => held.id)).toEqual(['t-vera']);
      expect(await writer.recordAccess('t-vera')).not.toBeNull();
      expect(await reader.recordAccess('t-vera')).not.toBeNull();
      expect(reader.getTrace('t-vera')).toMatchObject({ accessCount: 2, reinforcementInterval: 14_400_000, retrievalCount: 2 });
    } finally {
      await second.close();
      await first.close();
    }
    expect(await reload(filePath)).toMatchObject({ accessCount: 2, reinforcementInterval: 14_400_000, retrievalCount: 2 });
  });

  it('keeps the accesses the row holds beyond those of a trace the store restored from the vector store', async () => {
    const filePath = brainFile();
    const first = await Brain.openSqlite(filePath, { brainId: 'b' });
    const second = await Brain.openSqlite(filePath, { brainId: 'b' });
    try {
      const vectorStore = await vectorStoreOf4();
      const writer = storeWith(vectorStore);
      writer.setBrain(first);
      const reader = storeWith(vectorStore);
      reader.setBrain(second);
      // The reader loads its Brain while it is empty, so it later restores the trace from the index.
      expect(await reader.getByScope('user', 'ana')).toEqual([]);
      await writer.store(trace(Date.now()));
      expect((await reader.getByScope('user', 'ana')).map((held) => held.accessCount)).toEqual([0]);
      await facadeFeedback(filePath, 'used');
      expect(await reader.recordAccess('t-vera')).not.toBeNull();
      expect(reader.getTrace('t-vera')).toMatchObject({ accessCount: 2, reinforcementInterval: 14_400_000, retrievalCount: 2 });
    } finally {
      await second.close();
      await first.close();
    }
    expect(await reload(filePath)).toMatchObject({ accessCount: 2, reinforcementInterval: 14_400_000, retrievalCount: 2 });
  });
});

// With no Brain, the vector store is a store's only record: a store started later over the same
// vector store stands for a restarted process over a durable index, and restores each trace from
// the document's metadata.
describe('a trace restored from the vector store by a store with no Brain', () => {
  const neutralMood: PADState = { valence: 0, arousal: 0, dominance: 0 };

  it('keeps the reinforcement schedule an access left, through getByScope and through query', async () => {
    const vectorStore = await vectorStoreOf4();
    const first = storeWith(vectorStore);
    await first.store(trace(Date.now()));
    expect(await first.recordAccess('t-vera')).not.toBeNull();
    const accessed = structuredClone(first.getTrace('t-vera')!);
    const schedule = {
      stability: accessed.stability,
      accessCount: 1,
      reinforcementInterval: 7_200_000,
      nextReinforcementAt: accessed.nextReinforcementAt,
    };

    const [restored] = await storeWith(vectorStore).getByScope('user', 'ana');
    expect(restored).toMatchObject(schedule);

    const querying = storeWith(vectorStore);
    const { scored } = await querying.query("Who is Ana's sister?", neutralMood, {
      scopes: [{ scope: 'user', scopeId: 'ana' }],
    });
    expect(scored.map((hit) => hit.id)).toEqual(['t-vera']);
    expect(querying.getTrace('t-vera')).toMatchObject(schedule);
  });

  it('restores a trace whose metadata holds no schedule with a one-hour interval, which its next access doubles', async () => {
    const vectorStore = await vectorStoreOf4();
    await storeWith(vectorStore, { persistAccessState: false }).store(trace(Date.now()));
    const store = storeWith(vectorStore);
    const [restored] = await store.getByScope('user', 'ana');
    expect(restored!.reinforcementInterval).toBe(3_600_000);
    expect(await store.recordAccess('t-vera')).not.toBeNull();
    expect(store.getTrace('t-vera')!.reinforcementInterval).toBe(7_200_000);
  });

  it('with persistAccessState false, restores as before the fix: no schedule from the vector metadata', async () => {
    const vectorStore = await vectorStoreOf4();
    const first = storeWith(vectorStore, { persistAccessState: false });
    await first.store(trace(Date.now()));
    expect(await first.recordAccess('t-vera')).not.toBeNull();
    const [restored] = await storeWith(vectorStore, { persistAccessState: false }).getByScope('user', 'ana');
    expect(restored!.reinforcementInterval).toBe(0);
    expect(restored!.nextReinforcementAt).toBeUndefined();
  });
});
