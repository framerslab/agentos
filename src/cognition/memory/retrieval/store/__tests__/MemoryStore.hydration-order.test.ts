/**
 * @file MemoryStore.hydration-order.test.ts
 * The order a store loads a Brain's traces in, where several were filed in the same millisecond: newest first by
 * `created_at`, then by trace id, on SQLite and, where AGENTOS_TEST_POSTGRES_URL is set, on PostgreSQL, which leaves
 * the order of rows equal under a sort to the plan and to where updates moved them in the table. Two Brains hold the
 * same traces, filed in the same order, with a different set of rows updated since; a fresh store on each loads them
 * in one order, by the whole-brain hydration a first read runs and by `hydrateScope`, and a recall returns its equally
 * scored traces in that order.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../Brain.js';
import { MemoryStore } from '../MemoryStore.js';
import { PORTABLE_TABLES } from '../portable-tables.js';
import { InMemoryVectorStore } from '../../../../rag/vector_stores/InMemoryVectorStore.js';
import type { IKnowledgeGraph } from '../../graph/knowledge/IKnowledgeGraph.js';
import type { IEmbeddingManager } from '../../../../../core/embeddings/IEmbeddingManager.js';
import type { MemoryTrace } from '../../../core/types.js';
import type { PADState } from '../../../core/config.js';
import type { VectorStoreProviderConfig } from '../../../../../core/vector-store/IVectorStore.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;

/** One vector for every text, so every trace scores the same against any query. */
class FixedEmbedder {
  async generateEmbeddings(input: { texts: string | string[] }) {
    const texts = Array.isArray(input.texts) ? input.texts : [input.texts];
    const vec = new Array(16).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    return { embeddings: texts.map(() => vec.slice()), model: 'fixed', usage: { promptTokens: 0, totalTokens: 0 } };
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

/** The millisecond the tied traces were filed in. */
const FILED_AT = Date.UTC(2026, 10, 10, 12, 0, 0);
/** Filed in this order, which is neither the ids' order nor its reverse. */
const TIED = ['mt-c', 'mt-a', 'mt-e', 'mt-b', 'mt-f', 'mt-d'];
/** Newest first, and the traces of one millisecond by id. */
const EXPECTED = ['mt-new', 'mt-a', 'mt-b', 'mt-c', 'mt-d', 'mt-e', 'mt-f', 'mt-old'];

function trace(id: string, createdAt: number): MemoryTrace {
  return {
    id, type: 'episodic', scope: 'user', scopeId: 'u1',
    content: `Garden note ${id}: the hose was coiled by the east fence.`, entities: [], tags: [],
    provenance: { sourceType: 'user_statement', sourceTimestamp: createdAt, confidence: 1, verificationCount: 0 },
    emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: '' },
    encodingStrength: 0.5, stability: 0.5, retrievalCount: 0,
    lastAccessedAt: createdAt, accessCount: 0, reinforcementInterval: 0,
    associatedTraceIds: [], createdAt, updatedAt: createdAt, isActive: true,
  } as MemoryTrace;
}

const MOOD: PADState = { valence: 0, arousal: 0, dominance: 0 };

async function newStore(brain: Brain): Promise<MemoryStore> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({
    id: `hydration-order-${Math.random()}`, type: 'in_memory', defaultEmbeddingDimension: 16, similarityMetric: 'cosine',
  } as VectorStoreProviderConfig);
  const store = new MemoryStore({
    vectorStore,
    embeddingManager: new FixedEmbedder() as unknown as IEmbeddingManager,
    knowledgeGraph: new NoopKG() as unknown as IKnowledgeGraph,
    collectionPrefix: 'cogmem',
  });
  store.setBrain(brain);
  closers.push(async () => store.dispose());
  return store;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

type Engine = { name: 'sqlite' | 'postgres'; open: () => Promise<Brain> };

const sqlite: Engine = {
  name: 'sqlite',
  open: async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydration-order-'));
    const brain = await Brain.openSqlite(path.join(dir, 'brain.sqlite'), { brainId: 'tie' });
    closers.push(async () => {
      await brain.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return brain;
  },
};

const postgres = (url: string): Engine => ({
  name: 'postgres',
  open: async () => {
    const brainId = `hydration-order-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const brain = await Brain.openPostgres(url, { brainId });
    closers.push(async () => {
      for (const table of [...PORTABLE_TABLES].reverse()) {
        try {
          await brain.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brainId]);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/does not exist|no such table/i.test(message)) process.stderr.write(`[hydration-order cleanup] ${table}: ${message}\n`);
        }
      }
      await brain.close();
    });
    return brain;
  },
});

const ENGINES: Engine[] = [sqlite, ...(POSTGRES_URL ? [postgres(POSTGRES_URL)] : [])];

/**
 * Files the traces into `brain` through a store, the tied ones in the order of {@link TIED}, then writes each row of
 * `touched` again unchanged: PostgreSQL stores an updated row as a new version at the end of the table.
 */
async function file(brain: Brain, touched: readonly string[]): Promise<void> {
  const writer = await newStore(brain);
  await writer.store(trace('mt-old', FILED_AT - 1));
  for (const id of TIED) await writer.store(trace(id, FILED_AT));
  await writer.store(trace('mt-new', FILED_AT + 1));
  for (const id of touched) {
    await brain.run('UPDATE memory_traces SET tags = tags WHERE brain_id = ? AND id = ?', [brain.brainId, id]);
  }
}

describe.each(ENGINES)('MemoryStore loads traces of one millisecond in id order on $name', ({ open }) => {
  it('the whole-brain hydration, a scope hydration and a recall give one order on two Brains of the same traces', async () => {
    const brains = [await open(), await open()];
    await file(brains[0], ['mt-c', 'mt-e']);
    await file(brains[1], ['mt-a', 'mt-f', 'mt-c']);

    for (const brain of brains) {
      // The first read of a fresh store loads the brain's most recent traces.
      const whole = await newStore(brain);
      expect((await whole.getByScope('user', 'u1')).map((t) => t.id), 'whole-brain hydration').toEqual(EXPECTED);

      // A scope's hydration reads the scope's most recent traces by its scope id.
      const scoped = await newStore(brain);
      expect(await scoped.hydrateScope('user', 'u1')).toBe(EXPECTED.length);
      expect(scoped.listTraces({ scope: 'user', scopeId: 'u1' }).map((t) => t.id), 'scope hydration').toEqual(EXPECTED);

      // A recall returns equally scored traces in the order the store loaded them.
      const recaller = await newStore(brain);
      const { scored } = await recaller.query('where is the hose', MOOD, {
        scopes: [{ scope: 'user', scopeId: 'u1' }],
        topK: 20,
      });
      const tied = scored.map((s) => s.id).filter((id) => TIED.includes(id));
      expect(tied, 'equally scored recall').toEqual(EXPECTED.filter((id) => TIED.includes(id)));
    }
  });
});
