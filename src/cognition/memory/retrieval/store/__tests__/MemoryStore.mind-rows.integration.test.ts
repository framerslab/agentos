/**
 * @file MemoryStore.mind-rows.integration.test.ts
 * The rows a souled agent's mind files beside the soul's own, on a real store: a `Memory` facade opened with
 * `Memory.createSqlite` (and `Memory.createPostgres` where `AGENTOS_TEST_POSTGRES_URL` is set), and a cognitive memory
 * manager built by `createAgentCognitiveMemory` on the facade's own Brain with `rows: 'mind'` and
 * `hydration: 'scopes'`. A row the mind files says who filed it, who spoke and whose it is, and keeps saying so through
 * an access write, a move to another key and a rewrite of its vector's metadata. The manager never loads or reads a row
 * it did not file, loads one person's rows alone however many rows other people hold, files nothing outside a
 * conversation key, leaves out of its index a stored vector of another size than its embedding model's without
 * sending that row's text to the model, and keeps apart two keys whose ids differ by one character.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { Memory } from '../../../io/facade/Memory.js';
import { brainOf } from '../../../io/facade/handedBrain.js';
import type { Brain } from '../Brain.js';
import { MemoryStore } from '../MemoryStore.js';
import { PORTABLE_TABLES } from '../portable-tables.js';
import { conversationScopeKey } from '../conversationScopeKey.js';
import { createAgentCognitiveMemory, type AgentCognitiveMemory } from '../../../../../api/runtime/agentCognitiveMemory.js';
import { InMemoryVectorStore } from '../../../../rag/vector_stores/InMemoryVectorStore.js';
import { KnowledgeGraph } from '../../graph/knowledge/KnowledgeGraph.js';
import type { CognitiveRetrievalResult, MemoryTrace } from '../../../core/types.js';
import { resetLoggerFactory, setLogger } from '../../../../../core/logging/loggerFactory.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const AGENT = 'aria-1';
const DIM = 8;
const MOOD = { valence: 0, arousal: 0, dominance: 0 };
const keyOf = (id: string): string => conversationScopeKey(AGENT, { kind: 'user', id });
const scopesOf = (scopeId: string) => [{ scope: 'conversation' as const, scopeId }];
const filingOf = (id: string, speaker: 'user' | 'assistant' = 'user') => ({
  filedBy: 'mind' as const,
  speaker,
  subject: { kind: 'user' as const, id },
});

/** A bag-of-words vector of `dim` numbers: texts that share a word point the same way. */
function wordVector(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    vector[h % dim] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm + 0.001);
}

/** An embedding manager of `dim`-number vectors that records every text it is sent. */
function embedder(dim: number = DIM) {
  const sent: string[] = [];
  return {
    sent,
    manager: {
      initialize: async () => undefined,
      generateEmbeddings: async (request: { texts: string | string[] }) => {
        const texts = Array.isArray(request.texts) ? request.texts : [request.texts];
        sent.push(...texts);
        return {
          embeddings: texts.map((text) => wordVector(text, dim)),
          modelId: `words-${dim}`,
          providerId: 'test',
          usage: { totalTokens: 0 },
        };
      },
      getEmbeddingModelInfo: async () => ({ modelId: `words-${dim}`, providerId: 'test', dimension: dim }),
      getEmbeddingDimension: async () => dim,
      checkHealth: async () => ({ isHealthy: true }),
      shutdown: async () => undefined,
    },
  };
}

type Store = 'sqlite' | 'postgres';
const facades: Memory[] = [];
const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

let events: Array<Record<string, unknown>> = [];
const lines = (event: string) => events.filter((line) => line.event === event);

beforeEach(() => {
  events = [];
  setLogger(
    pino(
      { level: 'debug', base: undefined },
      {
        write(line: string) {
          events.push(JSON.parse(line));
        },
      },
    ),
  );
});

afterEach(async () => {
  resetLoggerFactory();
  while (closers.length) await closers.pop()!();
  while (facades.length) {
    const memory = facades.pop()!;
    const brain = brainOf(memory);
    if (brain.features.dialect.name === 'postgres') {
      // The database outlives the test: this brain's rows go, children before parents.
      for (const table of ['memory_legacy_owner', 'memory_pages', 'memory_scopes', ...[...PORTABLE_TABLES].reverse()]) {
        await brain.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brain.brainId]).catch(() => undefined);
      }
    }
    await memory.close();
  }
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A facade on a fresh store, embedding what it remembers. */
async function openFacade(store: Store = 'sqlite'): Promise<{ memory: Memory; brain: Brain }> {
  const options = {
    graph: false,
    selfImprove: false,
    embed: async (text: string) => wordVector(text, DIM),
    embeddings: { provider: 'test', dimensions: DIM },
  };
  let memory: Memory;
  if (store === 'postgres') {
    memory = await Memory.createPostgres(POSTGRES_URL!, {
      ...options,
      brainId: `mind-rows-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      poolSize: 2,
    });
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-rows-'));
    dirs.push(dir);
    memory = await Memory.createSqlite(path.join(dir, 'brain.sqlite'), { ...options, decay: false });
  }
  facades.push(memory);
  return { memory, brain: brainOf(memory) };
}

/** The manager a souled agent's mind runs on the facade's Brain: the mind's rows alone, loaded a key at a time. */
async function mindManager(
  brain: Brain,
  options: {
    retrieval?: 'dense' | 'hybrid';
    rows?: 'all' | 'mind';
    embedding?: ReturnType<typeof embedder>;
    mechanisms?: Record<string, unknown>;
  } = {},
): Promise<AgentCognitiveMemory> {
  const built = await createAgentCognitiveMemory({
    persona: {
      id: AGENT,
      name: 'Aria',
      description: 'd',
      version: '1.0.0',
      baseSystemPrompt: 'x',
      personalityTraits: {},
    } as never,
    memory: options.retrieval ? { recall: { retrieval: options.retrieval } } : {},
    brain,
    embeddingManager: (options.embedding ?? embedder()).manager as never,
    ...(options.mechanisms ? { mechanisms: options.mechanisms as never } : {}),
    rows: options.rows ?? 'mind',
    hydration: 'scopes',
  });
  closers.push(() => built.close());
  return built;
}

/** A plain store on the same Brain that files rows as the mind would have filed them, at the times it is given. */
async function planter(brain: Brain, dim: number = DIM): Promise<MemoryStore> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({
    id: `plant-${Math.random().toString(36).slice(2)}`,
    type: 'in_memory',
    defaultEmbeddingDimension: dim,
    similarityMetric: 'cosine',
  } as never);
  const knowledgeGraph = new KnowledgeGraph();
  await knowledgeGraph.initialize();
  const store = new MemoryStore({
    vectorStore,
    embeddingManager: embedder(dim).manager as never,
    knowledgeGraph,
    collectionPrefix: 'plant',
  });
  store.setBrain(brain);
  closers.push(() => store.dispose());
  return store;
}

/** A store on `brain` that indexes into `vectorStore`, of every row or of the mind's rows alone. */
async function storeOn(brain: Brain, vectorStore: InMemoryVectorStore, rows: 'all' | 'mind'): Promise<MemoryStore> {
  const knowledgeGraph = new KnowledgeGraph();
  await knowledgeGraph.initialize();
  const store = new MemoryStore({
    vectorStore,
    embeddingManager: embedder().manager as never,
    knowledgeGraph,
    collectionPrefix: 'shared',
    ...(rows === 'mind' ? { rows: 'mind' as const, hydration: 'scopes' as const } : {}),
  });
  store.setBrain(brain);
  closers.push(() => store.dispose());
  return store;
}

/** A trace of what `subjectId` said, filed by the mind under `scopeId` at `createdAt`. */
function mindTrace(id: string, content: string, scopeId: string, subjectId: string, createdAt: number): MemoryTrace {
  return {
    id,
    type: 'episodic',
    scope: 'conversation',
    scopeId,
    content,
    entities: [],
    tags: [],
    provenance: { sourceType: 'user_statement', sourceTimestamp: createdAt, confidence: 0.8, verificationCount: 0 },
    emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: '' },
    encodingStrength: 0.5,
    stability: 3_600_000,
    retrievalCount: 0,
    lastAccessedAt: createdAt,
    accessCount: 0,
    reinforcementInterval: 3_600_000,
    associatedTraceIds: [],
    createdAt,
    updatedAt: createdAt,
    isActive: true,
    turnUserId: subjectId,
    filing: filingOf(subjectId),
  };
}

const idsOf = (result: CognitiveRetrievalResult): string[] => [
  ...result.retrieved.map((trace) => trace.id),
  ...result.partiallyRetrieved.map((trace) => trace.traceId),
];

const metadataOf = async (brain: Brain, id: string): Promise<Record<string, unknown>> => {
  const row = await brain.get<{ metadata: string }>('SELECT metadata FROM memory_traces WHERE brain_id = ? AND id = ?', [
    brain.brainId,
    id,
  ]);
  return JSON.parse(row!.metadata) as Record<string, unknown>;
};

/** The keys the mind's filing writes into a row's metadata. */
const markerOf = (metadata: Record<string, unknown>) => ({
  filedBy: metadata.filedBy,
  speaker: metadata.speaker,
  subject: metadata.subject,
  turnUserId: metadata.turnUserId,
});

describe('the rows a mind files', () => {
  it('a mind-filed row says who filed it, who spoke and whose it is', async () => {
    const { brain } = await openFacade();
    const A = keyOf('alice');
    const moved = keyOf('alice-moved');
    const { manager } = await mindManager(brain);
    const filing = filingOf('alice');
    const trace = await manager.encode('Alice keeps bees on the roof.', MOOD, 'neutral', {
      scope: 'conversation',
      scopeId: A,
      filing,
      turnUserId: 'alice',
    });
    const marked = { ...filing, turnUserId: 'alice' };
    expect(trace.filing).toEqual(filing);
    expect(markerOf(await metadataOf(brain, trace.id))).toEqual(marked);

    // An access write: the recall records the access in the row.
    expect(idsOf(await manager.retrieve('bees on the roof', MOOD, { scopes: scopesOf(A) }))).toContain(trace.id);
    const accessed = await brain.get<{ retrieval_count: number }>(
      'SELECT retrieval_count FROM memory_traces WHERE brain_id = ? AND id = ?',
      [brain.brainId, trace.id],
    );
    expect(Number(accessed?.retrieval_count)).toBeGreaterThan(0);
    expect(markerOf(await metadataOf(brain, trace.id))).toEqual(marked);

    // The writes that rebuild a trace's metadata: its vector document's, and its row's on a move to another key.
    await manager.getStore().persistTraceMetadata(trace.id);
    expect(await manager.getStore().refileScope('conversation', A, moved)).toBe(1);
    expect(markerOf(await metadataOf(brain, trace.id))).toEqual(marked);
    expect(manager.getStore().getTrace(trace.id)?.filing).toEqual(filing);

    // A trace loaded again carries its filing.
    const fresh = await mindManager(brain);
    expect(await fresh.manager.getStore().hydrateScope('conversation', moved)).toBe(1);
    expect(fresh.manager.getStore().getTrace(trace.id)?.filing).toEqual(filing);
    expect(fresh.manager.getStore().getTrace(trace.id)?.turnUserId).toBe('alice');
  });

  it('the manager never loads or reads a row it did not file', async () => {
    const { memory, brain } = await openFacade();
    const A = keyOf('alice');
    const soul = await memory.remember('Alice keeps bees on the roof.', { scope: 'conversation', scopeId: A });
    const rowOf = () => brain.get('SELECT * FROM memory_traces WHERE brain_id = ? AND id = ?', [brain.brainId, soul.id]);
    const before = await rowOf();
    expect(before).toBeTruthy();

    for (const retrieval of ['dense', 'hybrid'] as const) {
      const { manager } = await mindManager(brain, { retrieval });
      const mind = await manager.encode(`Alice keeps bees in the garden (${retrieval}).`, MOOD, 'neutral', {
        scope: 'conversation',
        scopeId: A,
        filing: filingOf('alice'),
        turnUserId: 'alice',
      });
      await manager.getStore().hydrateScope('conversation', A);
      expect(manager.getStore().getTrace(soul.id)).toBeUndefined();

      const recalled = idsOf(await manager.retrieve('bees', MOOD, { scopes: scopesOf(A) }));
      expect(recalled).toContain(mind.id);
      expect(recalled).not.toContain(soul.id);
      expect(manager.getStore().getTrace(soul.id)).toBeUndefined();
      expect(manager.getStore().listTraces().map((trace) => trace.id)).not.toContain(soul.id);
    }
    expect(await rowOf()).toEqual(before);
  });

  it("a person's rows load alone", async () => {
    const { brain } = await openFacade();
    const A = keyOf('alice');
    const B = keyOf('bob');
    const plant = await planter(brain);
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 10; i += 1) await plant.store(mindTrace(`alice-${i}`, `Alice note ${i} about the ferry.`, A, 'alice', t0 + i));
    // Bob's rows are the newest in the store: a load of the brain's newest rows would be his alone.
    for (let i = 0; i < 1200; i += 1) {
      await plant.store(mindTrace(`bob-${i}`, `Bob note ${i} about the ferry.`, B, 'bob', t0 + 100 + i));
    }

    const { manager } = await mindManager(brain);
    await manager.retrieve('ferry', MOOD, { scopes: scopesOf(A) });
    expect(manager.getStore().listTraces().filter((trace) => trace.scopeId === B)).toEqual([]);
    expect(await manager.getStore().hydrateScope('conversation', A)).toBe(10);
    expect(manager.getStore().getTraceCount()).toBe(10);
    expect(idsOf(await manager.retrieve('ferry', MOOD, { scopes: scopesOf(A) })).every((id) => id.startsWith('alice-'))).toBe(true);
    expect(manager.getStore().listTraces().every((trace) => trace.scopeId === A)).toBe(true);

    // More than a load's 1,000 rows of one person: the oldest are recalled by their words alone.
    const second = await openFacade();
    const plantMore = await planter(second.brain);
    for (let i = 0; i < 1005; i += 1) {
      const text = i < 5 ? `Alice once saw a quokka near pier ${i}.` : `Alice note ${i} about the ferry.`;
      await plantMore.store(mindTrace(`old-${i}`, text, A, 'alice', t0 + i));
    }
    const oldest = ['old-0', 'old-1', 'old-2', 'old-3', 'old-4'];
    const dense = await mindManager(second.brain);
    expect(await dense.manager.getStore().hydrateScope('conversation', A)).toBe(1000);
    const byMeaning = idsOf(await dense.manager.retrieve('quokka', MOOD, { scopes: scopesOf(A), topK: 100 }));
    expect(byMeaning.filter((id) => oldest.includes(id))).toEqual([]);
    const hybrid = await mindManager(second.brain, { retrieval: 'hybrid' });
    expect(await hybrid.manager.getStore().hydrateScope('conversation', A)).toBe(1000);
    const byWords = idsOf(await hybrid.manager.retrieve('quokka', MOOD, { scopes: scopesOf(A), topK: 100 }));
    expect(oldest.filter((id) => byWords.includes(id))).toEqual(oldest);
  });

  it("nothing is filed outside a person's key", async () => {
    const { brain } = await openFacade();
    const A = keyOf('alice');
    const rows = async () =>
      Number((await brain.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM memory_traces WHERE brain_id = ?', [brain.brainId]))?.n ?? 0);
    const { manager } = await mindManager(brain);
    await expect(
      manager.encode('Alice keeps bees.', MOOD, 'neutral', { scope: 'user', scopeId: 'alice', filing: filingOf('alice') }),
    ).rejects.toThrow(/conversation/);
    await expect(manager.encode('Alice keeps bees.', MOOD, 'neutral', { scope: 'conversation', scopeId: A })).rejects.toThrow(
      /conversation/,
    );
    expect(await rows()).toBe(0);
    expect(manager.getStore().getTraceCount()).toBe(0);

    const { manager: plain } = await mindManager(brain, { rows: 'all' });
    await plain.encode('Alice keeps bees.', MOOD, 'neutral', { scope: 'user', scopeId: 'alice' });
    await plain.encode('Alice keeps bees.', MOOD, 'neutral', { scope: 'conversation', scopeId: A });
    expect(await rows()).toBe(2);
  });

  it("a trace refused for its key is refused before its text leaves the manager", async () => {
    const { brain } = await openFacade();
    const rows = async () =>
      Number((await brain.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM memory_traces WHERE brain_id = ?', [brain.brainId]))?.n ?? 0);
    // The mechanisms embed a trace's text at encode, before the store files it.
    const embedding = embedder();
    const { manager } = await mindManager(brain, { embedding, mechanisms: {} });
    const said = 'Alice keeps bees.';
    await expect(
      manager.encode(said, MOOD, 'neutral', { scope: 'user', scopeId: 'alice', filing: filingOf('alice') }),
    ).rejects.toThrow(/conversation/);
    // A filing with no key would file under the agent's own id, a key of no person's.
    await expect(manager.encode(said, MOOD, 'neutral', { scope: 'conversation', filing: filingOf('alice') })).rejects.toThrow(
      /conversation/,
    );
    // Another person's key.
    await expect(
      manager.encode(said, MOOD, 'neutral', { scope: 'conversation', scopeId: keyOf('bob'), filing: filingOf('alice') }),
    ).rejects.toThrow(/conversation/);
    // The key of the same id as a session's.
    await expect(
      manager.encode(said, MOOD, 'neutral', {
        scope: 'conversation',
        scopeId: conversationScopeKey(AGENT, { kind: 'session', id: 'alice' }),
        filing: filingOf('alice'),
      }),
    ).rejects.toThrow(/conversation/);
    expect(embedding.sent).not.toContain(said);
    expect(await rows()).toBe(0);
    expect(manager.getStore().getTraceCount()).toBe(0);

    // The store refuses them too, for a caller that files through it.
    const store = manager.getStore();
    await expect(store.store(mindTrace('no-key', said, AGENT, 'alice', Date.now()))).rejects.toThrow(/conversation/);
    await expect(store.store(mindTrace('other-key', said, keyOf('bob'), 'alice', Date.now()))).rejects.toThrow(/conversation/);
    expect(await rows()).toBe(0);

    // Its own key files.
    const filed = await manager.encode(said, MOOD, 'neutral', {
      scope: 'conversation',
      scopeId: keyOf('alice'),
      filing: filingOf('alice'),
      turnUserId: 'alice',
    });
    expect(filed.scopeId).toBe(keyOf('alice'));
    expect(await rows()).toBe(1);
  });

  it("a store of the mind's rows reads no other writer's document in a vector index it shares", async () => {
    const { brain } = await openFacade();
    const A = keyOf('alice');
    const shared = new InMemoryVectorStore();
    await shared.initialize({
      id: `shared-${Math.random().toString(36).slice(2)}`,
      type: 'in_memory',
      defaultEmbeddingDimension: DIM,
      similarityMetric: 'cosine',
    } as never);
    const plain = await storeOn(brain, shared, 'all');
    const mind = await storeOn(brain, shared, 'mind');
    const now = Date.now() - 2000;
    await plain.store({ ...mindTrace('plain-0', 'Alice keeps bees on the roof.', A, 'alice', now), filing: undefined });
    await mind.store(mindTrace('mind-0', 'Alice keeps bees in the garden.', A, 'alice', now + 1));
    expect((await metadataOf(brain, 'plain-0')).filedBy).toBeUndefined();

    // A query by meaning: both documents are in the key's collection of the shared index.
    const queried = await mind.query('bees', MOOD, { scopes: scopesOf(A) });
    const queriedIds = [...queried.scored.map((trace) => trace.id), ...queried.partial.map((trace) => trace.traceId)];
    expect(queriedIds).toContain('mind-0');
    expect(queriedIds).not.toContain('plain-0');
    expect(mind.getTrace('plain-0')).toBeUndefined();

    // A listing of a key the store holds nothing of reads the index.
    const fresh = await storeOn(brain, shared, 'mind');
    expect((await fresh.getByScope('conversation', A)).map((trace) => trace.id)).toEqual(['mind-0']);
    expect(fresh.getTrace('plain-0')).toBeUndefined();
    // The other writer's document stays in the index.
    expect((await plain.getByScope('conversation', A)).map((trace) => trace.id).sort()).toEqual(['mind-0', 'plain-0']);
  });

  it('a stored vector of another size stays out of the index, and its text is not sent to the embedding model', async () => {
    const { brain } = await openFacade();
    const A = keyOf('alice');
    const wide = await planter(brain, 1536);
    const texts = ['Alice keeps bees on the roof.', 'Alice plays the cello.', 'Alice once saw a quokka.'];
    for (const [i, text] of texts.entries()) await wide.store(mindTrace(`wide-${i}`, text, A, 'alice', Date.now() - 1000 + i));

    const narrow = embedder(8);
    const { manager } = await mindManager(brain, { retrieval: 'hybrid', embedding: narrow });
    events = [];
    await expect(manager.getStore().hydrateScope('conversation', A)).resolves.toBe(0);
    expect(manager.getStore().getTraceCount()).toBe(0);
    expect(lines('memory.vectors_unfit')).toEqual([expect.objectContaining({ rows: 3 })]);

    expect(idsOf(await manager.retrieve('quokka', MOOD, { scopes: scopesOf(A) }))).toContain('wide-2');
    expect(narrow.sent.filter((text) => texts.includes(text))).toEqual([]);
  });

  it('two keys whose ids differ by one character keep their own rows', async () => {
    const { brain } = await openFacade();
    const base = `o'brien%_"x\\:;😀`;
    const first = base.repeat(400 / base.length);
    const second = `${first}z`;
    expect(first.length).toBe(400);
    const K1 = keyOf(first);
    const K2 = keyOf(second);
    const plant = await planter(brain);
    const now = Date.now() - 1000;
    for (let i = 0; i < 3; i += 1) {
      await plant.store(mindTrace(`first-${i}`, `The first note ${i} about the ferry.`, K1, first, now + i));
      await plant.store(mindTrace(`second-${i}`, `The second note ${i} about the ferry.`, K2, second, now + 10 + i));
    }

    const { manager } = await mindManager(brain, { retrieval: 'hybrid' });
    const firstIds = idsOf(await manager.retrieve('ferry', MOOD, { scopes: scopesOf(K1) }));
    expect(firstIds.length).toBeGreaterThan(0);
    expect(firstIds.every((id) => id.startsWith('first-'))).toBe(true);
    expect(manager.getStore().listTraces().every((trace) => trace.scopeId === K1)).toBe(true);
    // The recall's read by words loaded what it found; the key's load brings the rest.
    const loadedByRecall = manager.getStore().listTraces({ scopeId: K1 }).length;
    expect(await manager.getStore().hydrateScope('conversation', K1)).toBe(3 - loadedByRecall);
    expect(manager.getStore().listTraces({ scopeId: K1 }).map((trace) => trace.filing)).toEqual(
      [0, 1, 2].map(() => filingOf(first)),
    );

    expect(await manager.getStore().hydrateScope('conversation', K2)).toBe(3);
    const secondIds = idsOf(await manager.retrieve('ferry', MOOD, { scopes: scopesOf(K2) }));
    expect(secondIds.length).toBeGreaterThan(0);
    expect(secondIds.every((id) => id.startsWith('second-'))).toBe(true);
    expect(manager.getStore().listTraces({ scopeId: K2 }).map((trace) => trace.filing?.subject.id)).toEqual(
      [second, second, second],
    );
  });
});

/** Another writer's row under the key whose metadata is not JSON: the mind's load and its read by words still run. */
async function malformedNeighbour(store: Store): Promise<void> {
  const { memory, brain } = await openFacade(store);
  const A = keyOf('alice');
  const soul = await memory.remember('Alice keeps bees on the roof.', { scope: 'conversation', scopeId: A });
  const { manager } = await mindManager(brain);
  const mind = await manager.encode('Alice keeps bees in the garden.', MOOD, 'neutral', {
    scope: 'conversation',
    scopeId: A,
    filing: filingOf('alice'),
    turnUserId: 'alice',
  });
  await brain.run('UPDATE memory_traces SET metadata = ? WHERE brain_id = ? AND id = ?', ['{not json', brain.brainId, soul.id]);

  // A manager that holds none of the key's rows reads them by their words.
  const hybrid = await mindManager(brain, { retrieval: 'hybrid' });
  const recalled = idsOf(await hybrid.manager.retrieve('bees', MOOD, { scopes: scopesOf(A) }));
  expect(recalled).toContain(mind.id);
  expect(recalled).not.toContain(soul.id);
  // The key's load.
  const loading = await mindManager(brain);
  await expect(loading.manager.getStore().hydrateScope('conversation', A)).resolves.toBe(1);
  expect(loading.manager.getStore().getTrace(soul.id)).toBeUndefined();
}

describe("another writer's row whose metadata is not JSON", () => {
  it("hides none of the mind's rows", async () => {
    await malformedNeighbour('sqlite');
  });

  it.skipIf(!POSTGRES_URL)("hides none of the mind's rows, on PostgreSQL", async () => {
    await malformedNeighbour('postgres');
  });
});

describe('the rows a mind files, on PostgreSQL', () => {
  it.skipIf(!POSTGRES_URL)('the manager loads and recalls the rows it filed alone', async () => {
    const { memory, brain } = await openFacade('postgres');
    const A = keyOf('alice');
    const soul = await memory.remember('Alice keeps bees on the roof.', { scope: 'conversation', scopeId: A });
    const { manager } = await mindManager(brain, { retrieval: 'hybrid' });
    const filing = filingOf('alice');
    const mind = await manager.encode('Alice keeps bees in the garden.', MOOD, 'neutral', {
      scope: 'conversation',
      scopeId: A,
      filing,
      turnUserId: 'alice',
    });
    expect(markerOf(await metadataOf(brain, mind.id))).toEqual({ ...filing, turnUserId: 'alice' });

    const fresh = await mindManager(brain, { retrieval: 'hybrid' });
    expect(await fresh.manager.getStore().hydrateScope('conversation', A)).toBe(1);
    expect(fresh.manager.getStore().getTrace(soul.id)).toBeUndefined();
    const recalled = idsOf(await fresh.manager.retrieve('bees', MOOD, { scopes: scopesOf(A) }));
    expect(recalled).toContain(mind.id);
    expect(recalled).not.toContain(soul.id);
  });
});
