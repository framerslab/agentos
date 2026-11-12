/**
 * @fileoverview Shared fixtures for the recall leg tests: deterministic embedders, a trace builder, a MemoryStore over
 * an InMemoryVectorStore with an optional Brain, and the engines a durable test runs on (SQLite on every run,
 * Postgres where the `test` job's service sets `AGENTOS_TEST_POSTGRES_URL`).
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Brain } from '../../../src/cognition/memory/retrieval/store/Brain';
import { MemoryStore } from '../../../src/cognition/memory/retrieval/store/MemoryStore';
import { PORTABLE_TABLES } from '../../../src/cognition/memory/retrieval/store/portable-tables';
import { InMemoryVectorStore } from '../../../src/cognition/rag/vector_stores/InMemoryVectorStore';
import type { MemoryTrace } from '../../../src/cognition/memory/core/types';

/** Embeds a text as counts of its words hashed into 32 buckets, so texts that share words are near; `empty` and `fail` break it on demand. */
export class WordHashEmbedder {
  calls = 0;
  empty = false;
  fail = false;
  async generateEmbeddings(input: { texts: string | string[] }) {
    this.calls += 1;
    if (this.fail) throw new Error('embedding provider down');
    const texts = Array.isArray(input.texts) ? input.texts : [input.texts];
    const embed = (text: string) => {
      const v = new Array<number>(32).fill(0);
      for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 0;
        for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 32;
        v[h] += 1;
      }
      return v.some((x) => x !== 0) ? v : v.map((_, i) => (i === 0 ? 1 : 0));
    };
    return {
      embeddings: texts.map((t) => (this.empty ? [] : embed(t))),
      model: 'word-hash',
      usage: { promptTokens: 0, totalTokens: 0 },
    };
  }
}

/** Every text gets the same vector: the dense leg cannot tell one trace from another, so only words or time can. */
export class FlatEmbedder extends WordHashEmbedder {
  override async generateEmbeddings(input: { texts: string | string[] }) {
    this.calls += 1;
    const texts = Array.isArray(input.texts) ? input.texts : [input.texts];
    return {
      embeddings: texts.map(() => [1, ...new Array<number>(31).fill(0)]),
      model: 'flat',
      usage: { promptTokens: 0, totalTokens: 0 },
    };
  }
}

export const NOOP_GRAPH = {
  recordMemory: async () => 'noop',
  findRelatedMemories: async () => [],
  findEntityRelationships: async () => [],
  linkMemories: async () => undefined,
  getEntityContext: async () => ({ entities: [], memories: [], relationships: [] }),
  getMemoryById: async () => null,
  updateMemory: async () => undefined,
  removeMemory: async () => undefined,
};

let n = 0;
/** A semantic trace of user `u1`, created one minute after the previous one built in this process. */
export function trace(id: string, content: string, over: Partial<MemoryTrace> = {}): MemoryTrace {
  const at = Date.UTC(2026, 10, 1) + n++ * 60_000;
  return {
    id,
    type: 'semantic',
    scope: 'user',
    scopeId: 'u1',
    content,
    entities: [],
    tags: [],
    provenance: { sourceType: 'user_statement', sourceTimestamp: at, confidence: 1, verificationCount: 0 },
    emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: '' },
    encodingStrength: 0.5,
    stability: 0.5,
    retrievalCount: 0,
    lastAccessedAt: at,
    accessCount: 0,
    reinforcementInterval: 0,
    associatedTraceIds: [],
    createdAt: at,
    updatedAt: at,
    isActive: true,
    ...over,
  } as MemoryTrace;
}

/** A MemoryStore over a fresh InMemoryVectorStore, on `brain` when one is given. */
export async function storeOver(brain: Brain | null, embedder: WordHashEmbedder = new WordHashEmbedder()): Promise<MemoryStore> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({
    id: `recall-${Math.random().toString(36).slice(2)}`,
    type: 'in_memory',
    defaultEmbeddingDimension: 32,
    similarityMetric: 'cosine',
  } as never);
  const store = new MemoryStore({
    vectorStore,
    embeddingManager: embedder as never,
    knowledgeGraph: NOOP_GRAPH as never,
    collectionPrefix: 'cogmem',
  });
  if (brain) store.setBrain(brain);
  return store;
}

export interface OpenedBrain {
  brain: Brain;
  /** A second Brain on the same database. */
  reopen(): Promise<Brain>;
  close(): Promise<void>;
}

async function sqlite(): Promise<OpenedBrain> {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-')), 'brain.sqlite');
  const opened: Brain[] = [await Brain.openSqlite(file, { brainId: 'recall' })];
  return {
    brain: opened[0],
    reopen: async () => {
      const b = await Brain.openSqlite(file, { brainId: 'recall' });
      opened.push(b);
      return b;
    },
    close: async () => {
      for (const b of opened) await b.close().catch(() => undefined);
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    },
  };
}

/** Deletes this Brain's rows from every brain-owned table, children first (the cleanup of `Brain.postgres.test.ts`). */
export async function wipeBrain(brain: Brain): Promise<void> {
  for (const table of [...PORTABLE_TABLES].reverse()) {
    try {
      await brain.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brain.brainId]);
    } catch {
      // A table an older schema lacks.
    }
  }
}

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;

async function postgres(): Promise<OpenedBrain> {
  const brainId = `recall-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const opened: Brain[] = [await Brain.openPostgres(POSTGRES_URL!, { brainId })];
  return {
    brain: opened[0],
    reopen: async () => {
      const b = await Brain.openPostgres(POSTGRES_URL!, { brainId });
      opened.push(b);
      return b;
    },
    close: async () => {
      await wipeBrain(opened[0]).catch(() => undefined);
      for (const b of opened) await b.close().catch(() => undefined);
    },
  };
}

/** SQLite on every run; Postgres where the `test` job's service is set. */
export const ENGINES: Array<[string, () => Promise<OpenedBrain>]> = [
  ['sqlite', sqlite],
  ...(POSTGRES_URL ? [['postgres', postgres] as [string, () => Promise<OpenedBrain>]] : []),
];

export const U1 = [{ scope: 'user' as const, scopeId: 'u1' }];
