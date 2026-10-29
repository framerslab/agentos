/**
 * @file CognitiveMemoryManager.delete-scope.test.ts
 * Deleting memory: `deleteScope` removes every trace of one scope from the cache, the vector index and the Brain
 * (a reload brings none back), the knowledge graph's episodic copy of each, in the in-memory graph and in
 * `SqlKnowledgeGraph`, and the memory graph's node of each; another scope's traces, copies and nodes stay.
 * `deleteTraces` does the same for the traces it names, and `deleteScope` with `turnUserId` for the traces a second
 * user filed on another user's session (`encode`'s `turnUserId`); an empty scope id is refused. The rows that name a deleted trace go or let go of it (its
 * retrieval feedback, the document chunk it was filed from), and a scope deleted again counts nothing. A soft delete
 * (a supersede, a prune) takes the trace's copy with it and keeps the Brain row as a tombstone. A real manager over a
 * real SQLite Brain; with no Brain, a manager started over a vector index another manager filed into finds the scope's
 * traces in the index, a second user's alone with `turnUserId`, whether it lists a collection a page at a time, pages
 * it by position, or answers similarity queries alone. A trace deleted for good leaves none of its words in this
 * process or the Brain: not in the cache of any store over the Brain, the archive's original, or the typed facts the
 * manager extracted from it; a row an older release wrote under the scope is found too, an id that names no trace is
 * skipped, and a document a scope's collection still holds of a trace filed under another scope since is neither read
 * nor deleted under the scope.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CognitiveMemoryManager } from '../CognitiveMemoryManager.js';
import { Brain } from '../retrieval/store/Brain.js';
import { SqlKnowledgeGraph } from '../retrieval/store/SqlKnowledgeGraph.js';
import { KnowledgeGraph } from '../retrieval/graph/knowledge/KnowledgeGraph.js';
import type { IKnowledgeGraph } from '../retrieval/graph/knowledge/IKnowledgeGraph.js';
import { SqlStorageMemoryArchive } from '../archive/SqlStorageMemoryArchive.js';
import { sha256Hex } from '../retrieval/store/tracePersistence.js';
import { InMemoryVectorStore } from '../../rag/vector_stores/InMemoryVectorStore.js';
import { InMemoryWorkingMemory } from '../../substrate/memory/InMemoryWorkingMemory.js';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const MOOD = { valence: 0, arousal: 0, dominance: 0 };

/** A deterministic 8-dimension embedding of a text: equal texts embed equally. */
function embed(text: string): number[] {
  const vector = new Array<number>(8).fill(0);
  for (let i = 0; i < text.length; i += 1) vector[i % 8] += text.charCodeAt(i) / 1000;
  return vector.map((value) => value + 0.01);
}

/**
 * A manager over the file's Brain. `extra` adds to its config what a case needs (an archive, the typed network), and
 * may read the Brain.
 */
async function managerOver(
  filePath: string,
  graph: (brain: Brain) => IKnowledgeGraph,
  extra: (brain: Brain) => Promise<Record<string, unknown>> | Record<string, unknown> = () => ({}),
): Promise<{ manager: CognitiveMemoryManager; brain: Brain; graph: IKnowledgeGraph }> {
  const brain = await Brain.openSqlite(filePath, { brainId: 'agent-1' });
  const knowledgeGraph = graph(brain);
  await knowledgeGraph.initialize();
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: `delete-scope-${Math.random()}`, type: 'in_memory' });
  const manager = new CognitiveMemoryManager();
  await manager.initialize({
    agentId: 'agent-1',
    traits: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, emotionality: 0.5, honesty: 0.5 },
    moodProvider: () => MOOD,
    featureDetectionStrategy: 'keyword',
    workingMemory: new InMemoryWorkingMemory(),
    knowledgeGraph,
    vectorStore,
    embeddingManager: {
      generateEmbeddings: async ({ texts }: { texts: string | string[] }) => ({
        embeddings: (Array.isArray(texts) ? texts : [texts]).map(embed),
      }),
    },
    encoding: { baseStrength: 0.5, flashbulbThreshold: 0.8, flashbulbStrengthMultiplier: 2, flashbulbStabilityMultiplier: 5, baseStabilityMs: 3_600_000 },
    brain,
    ...(await extra(brain)),
  } as never);
  closers.push(async () => {
    await manager.shutdown();
    await brain.close();
  });
  return { manager, brain, graph: knowledgeGraph };
}

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delete-scope-'));
  dirs.push(dir);
  return path.join(dir, 'brain.sqlite');
}

/**
 * The text of every episodic copy of a memory trace the graph holds, with the scope id it was filed under. The
 * manager's memory graph files each trace as an entity of type `memory` in the same graph, and
 * `SqlKnowledgeGraph.queryMemories` lists those rows too; a copy is the record whose context names its trace.
 */
async function copiesOf(graph: IKnowledgeGraph): Promise<Array<{ scopeId: unknown; text: string | undefined }>> {
  const memories = await graph.queryMemories({ limit: 1000 });
  return memories
    .filter((memory) => typeof memory.context?.memoryTraceId === 'string')
    .map((memory) => ({ scopeId: memory.context?.scopeId, text: memory.description }));
}

describe.each([
  ['the in-memory graph', (_brain: Brain) => new KnowledgeGraph() as IKnowledgeGraph],
  ['SqlKnowledgeGraph', (brain: Brain) => new SqlKnowledgeGraph(brain) as IKnowledgeGraph],
])('deleteScope with %s', (_name, graph) => {
  it("removes one scope's traces, their graph copies and their graph nodes everywhere, and leaves the other scope's", async () => {
    const { manager, brain, graph: knowledgeGraph } = await managerOver(tempFile(), graph);
    const bees = await manager.encode('Ana keeps bees on the roof.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    const walnuts = await manager.encode('Ana is allergic to walnuts.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    const cello = await manager.encode('Bo plays the cello.', MOOD, 'neutral', { scope: 'user', scopeId: 'bo' });
    expect((await copiesOf(knowledgeGraph)).length).toBe(3);
    expect(await knowledgeGraph.getEntity(bees.id)).toBeDefined();

    const result = await manager.deleteScope('user', 'ana');

    expect(result).toEqual({ deleted: 2, graph: 'reached' });
    expect(await manager.getStore().getByScope('user', 'ana')).toEqual([]);
    expect((await manager.getStore().getByScope('user', 'bo')).map((trace) => trace.content)).toEqual(['Bo plays the cello.']);
    const rows = await brain.all<{ scope_id: string }>('SELECT scope_id FROM memory_traces ORDER BY scope_id');
    expect(rows).toEqual([{ scope_id: 'bo' }]);
    expect(await copiesOf(knowledgeGraph)).toEqual([{ scopeId: 'bo', text: 'Bo plays the cello.' }]);
    expect(await knowledgeGraph.getEntity(bees.id)).toBeUndefined();
    expect(await knowledgeGraph.getEntity(walnuts.id)).toBeUndefined();
    expect(await knowledgeGraph.getEntity(cello.id)).toBeDefined();
  });

  it('leaves nothing a fresh manager over the same file can recall', async () => {
    const filePath = tempFile();
    const first = await managerOver(filePath, graph);
    await first.manager.encode('Ana keeps bees on the roof.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    await first.manager.deleteScope('user', 'ana');
    await closers.pop()!();
    const second = await managerOver(filePath, graph);
    const recalled = await second.manager.retrieve('bees on the roof', MOOD, { scopes: [{ scope: 'user', scopeId: 'ana' }] } as never);
    expect(recalled.retrieved.map((trace) => trace.content)).toEqual([]);
    expect(await copiesOf(second.graph)).toEqual([]);
  });

  it('deleteTraces removes one trace, its copy and its graph node; a soft delete removes the copy and keeps the tombstone', async () => {
    const { manager, brain, graph: knowledgeGraph } = await managerOver(tempFile(), graph);
    const keep = await manager.encode('Ana keeps bees on the roof.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    const gone = await manager.encode('Ana is allergic to walnuts.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    const superseded = await manager.encode('Ana lives in Lyon.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });

    expect(await manager.deleteTraces([gone.id, gone.id, 'mt_unknown'])).toEqual({ deleted: 1, graph: 'reached' });
    await manager.getStore().softDelete(superseded.id);

    const rows = await brain.all<{ id: string; deleted: number }>('SELECT id, deleted FROM memory_traces ORDER BY id');
    expect(rows).toEqual([{ id: keep.id, deleted: 0 }, { id: superseded.id, deleted: 1 }].sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect((await copiesOf(knowledgeGraph)).map((copy) => copy.text)).toEqual(['Ana keeps bees on the roof.']);
    expect(await knowledgeGraph.getEntity(gone.id)).toBeUndefined();
    expect(await knowledgeGraph.getEntity(keep.id)).toBeDefined();
  });

  it("with turnUserId deletes only the traces that user filed on the session, with their copies and nodes", async () => {
    const { manager, brain, graph: knowledgeGraph } = await managerOver(tempFile(), graph);
    const owner = await manager.encode('The owner keeps notes.', MOOD, 'neutral', { scope: 'user', scopeId: '/s-1' });
    const visitor = await manager.encode('Bo keeps snakes.', MOOD, 'neutral', { scope: 'user', scopeId: '/s-1', turnUserId: 'bo' });
    expect(visitor.turnUserId).toBe('bo');
    expect(owner.turnUserId).toBeUndefined();

    await expect(manager.deleteScope('user', '/s-1', { turnUserId: '' })).rejects.toThrow(TypeError);
    expect(await manager.deleteScope('user', '/s-1', { turnUserId: 'bo' })).toEqual({ deleted: 1, graph: 'reached' });

    expect(await brain.all('SELECT id FROM memory_traces')).toEqual([{ id: owner.id }]);
    expect((await manager.getStore().getByScope('user', '/s-1')).map((trace) => trace.id)).toEqual([owner.id]);
    expect(await copiesOf(knowledgeGraph)).toEqual([{ scopeId: '/s-1', text: 'The owner keeps notes.' }]);
    expect(await knowledgeGraph.getEntity(visitor.id)).toBeUndefined();
    expect(await knowledgeGraph.getEntity(owner.id)).toBeDefined();
  });

  it('refuses an empty scope id, so a missing id never deletes the traces filed under none', async () => {
    const { manager, brain } = await managerOver(tempFile(), graph);
    const unfiled = await manager.encode('A note filed under no scope id.', MOOD, 'neutral', { scope: 'user', scopeId: '' });

    await expect(manager.deleteScope('user', '')).rejects.toThrow(TypeError);

    expect(await brain.all('SELECT id FROM memory_traces')).toEqual([{ id: unfiled.id }]);
  });
});

describe('deleting traces other rows name', () => {
  it('deletes their feedback rows and unlinks their document chunks, so the trace rows can go', async () => {
    const { manager, brain } = await managerOver(tempFile(), (brainOf) => new SqlKnowledgeGraph(brainOf));
    const bees = await manager.encode('Ana keeps bees on the roof.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    const walnuts = await manager.encode('Ana is allergic to walnuts.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    const cello = await manager.encode('Bo plays the cello.', MOOD, 'neutral', { scope: 'user', scopeId: 'bo' });
    // The rows `Memory.feedback` writes for a recalled trace, and the chunk an ingest links to the trace it filed.
    for (const trace of [bees, walnuts, cello]) {
      await brain.run(
        'INSERT INTO retrieval_feedback (brain_id, trace_id, signal, query, created_at) VALUES (?, ?, ?, ?, ?)',
        ['agent-1', trace.id, 'used', 'what does Ana keep', Date.now()],
      );
    }
    await brain.run(
      `INSERT INTO documents (brain_id, id, path, format, content_hash, ingested_at) VALUES ('agent-1', 'doc-1', 'notes.md', 'md', 'hash', ?)`,
      [Date.now()],
    );
    await brain.run(
      `INSERT INTO document_chunks (brain_id, id, document_id, trace_id, content, chunk_index) VALUES ('agent-1', 'chunk-1', 'doc-1', ?, 'Ana keeps bees on the roof.', 0)`,
      [bees.id],
    );

    expect(await manager.deleteTraces([walnuts.id])).toEqual({ deleted: 1, graph: 'reached' });
    expect(await manager.deleteScope('user', 'ana')).toEqual({ deleted: 1, graph: 'reached' });

    expect(await brain.all('SELECT id FROM memory_traces')).toEqual([{ id: cello.id }]);
    expect(await brain.all('SELECT trace_id FROM retrieval_feedback')).toEqual([{ trace_id: cello.id }]);
    expect(await brain.all('SELECT id, trace_id FROM document_chunks')).toEqual([{ id: 'chunk-1', trace_id: null }]);
  });

  it('counts nothing when a scope is deleted again', async () => {
    const { manager } = await managerOver(tempFile(), (brainOf) => new SqlKnowledgeGraph(brainOf));
    await manager.encode('Ana keeps bees on the roof.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    await manager.encode('Ana is allergic to walnuts.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });

    expect(await manager.deleteScope('user', 'ana')).toEqual({ deleted: 2, graph: 'reached' });
    expect(await manager.deleteScope('user', 'ana')).toEqual({ deleted: 0, graph: 'reached' });
  });
});

/** A manager with no Brain over a vector index and a knowledge graph that outlive it, as a host restarts one over a durable index. */
async function managerWithoutBrain(vectorStore: InMemoryVectorStore, knowledgeGraph: IKnowledgeGraph): Promise<CognitiveMemoryManager> {
  const manager = new CognitiveMemoryManager();
  await manager.initialize({
    agentId: 'agent-1',
    traits: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, emotionality: 0.5, honesty: 0.5 },
    moodProvider: () => MOOD,
    featureDetectionStrategy: 'keyword',
    workingMemory: new InMemoryWorkingMemory(),
    knowledgeGraph,
    vectorStore,
    embeddingManager: {
      generateEmbeddings: async ({ texts }: { texts: string | string[] }) => ({
        embeddings: (Array.isArray(texts) ? texts : [texts]).map(embed),
      }),
    },
    encoding: { baseStrength: 0.5, flashbulbThreshold: 0.8, flashbulbStrengthMultiplier: 2, flashbulbStabilityMultiplier: 5, baseStabilityMs: 3_600_000 },
  } as never);
  return manager;
}

/** An in-memory index whose metadata scan returns at most two documents a read, as a store that pages a scan does. */
function scanningTwoAtATime(store: InMemoryVectorStore): InMemoryVectorStore {
  const scan = store.scanByMetadata.bind(store);
  store.scanByMetadata = (name, options) => scan(name, { ...options, limit: Math.min(options?.limit ?? 100, 2) });
  return store;
}

/**
 * An in-memory index whose metadata scan pages by position, as a host's store with an offset cursor does: two
 * documents a read from the cursor's offset, and the offset of the next page while documents remain past it. A delete
 * moves the documents after it forward, past a cursor taken before it.
 */
function pagingByPosition(store: InMemoryVectorStore): InMemoryVectorStore {
  const scan = store.scanByMetadata.bind(store);
  store.scanByMetadata = async (name, options) => {
    const start = Number(options?.cursor ?? 0);
    const { documents } = await scan(name, { ...options, limit: Number.MAX_SAFE_INTEGER });
    const page = documents.slice(start, start + 2);
    const next = start + page.length;
    return next < documents.length ? { documents: page, nextCursor: String(next) } : { documents: page };
  };
  return store;
}

/** An in-memory index with no metadata scan, as a host's store that answers similarity queries alone. */
function answeringQueriesAlone(store: InMemoryVectorStore): InMemoryVectorStore {
  (store as { scanByMetadata?: unknown }).scanByMetadata = undefined;
  return store;
}

describe.each([
  ['an index that lists a collection two documents a read', scanningTwoAtATime],
  ['an index that pages a collection by position, two documents a page', pagingByPosition],
  ['an index that answers similarity queries alone', answeringQueriesAlone],
])('deleteScope with no Brain, over %s', (_name, shape) => {
  it('finds in the vector index the traces another store filed before a restart, and deletes them, their copies and their nodes', async () => {
    const vectorStore = shape(new InMemoryVectorStore());
    await vectorStore.initialize({ id: `delete-scope-${Math.random()}`, type: 'in_memory' });
    const knowledgeGraph = new KnowledgeGraph() as IKnowledgeGraph;
    const first = await managerWithoutBrain(vectorStore, knowledgeGraph);
    const bees = await first.encode('Ana keeps bees on the roof.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    const walnuts = await first.encode('Ana is allergic to walnuts.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    const lyon = await first.encode('Ana lives in Lyon.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    const cello = await first.encode('Bo plays the cello.', MOOD, 'neutral', { scope: 'user', scopeId: 'bo' });
    await first.shutdown();
    const second = await managerWithoutBrain(vectorStore, knowledgeGraph);
    closers.push(() => second.shutdown());

    expect(await second.deleteScope('user', 'ana')).toEqual({ deleted: 3, graph: 'reached' });

    expect(await second.getStore().getByScope('user', 'ana')).toEqual([]);
    expect((await second.getStore().getByScope('user', 'bo')).map((trace) => trace.content)).toEqual(['Bo plays the cello.']);
    const recalled = await second.retrieve('bees on the roof', MOOD, { scopes: [{ scope: 'user', scopeId: 'ana' }] } as never);
    expect(recalled.retrieved).toEqual([]);
    expect(await copiesOf(knowledgeGraph)).toEqual([{ scopeId: 'bo', text: 'Bo plays the cello.' }]);
    for (const gone of [bees, walnuts, lyon]) expect(await knowledgeGraph.getEntity(gone.id)).toBeUndefined();
    expect(await knowledgeGraph.getEntity(cello.id)).toBeDefined();
    expect(await second.deleteScope('user', 'ana')).toEqual({ deleted: 0, graph: 'reached' });
  });

  it('with turnUserId deletes only the traces that user filed, among those another store filed before a restart', async () => {
    const vectorStore = shape(new InMemoryVectorStore());
    await vectorStore.initialize({ id: `delete-scope-${Math.random()}`, type: 'in_memory' });
    const knowledgeGraph = new KnowledgeGraph() as IKnowledgeGraph;
    const first = await managerWithoutBrain(vectorStore, knowledgeGraph);
    const notes = await first.encode('The owner keeps notes.', MOOD, 'neutral', { scope: 'user', scopeId: '/s-1' });
    const snakes = await first.encode('Bo keeps snakes.', MOOD, 'neutral', { scope: 'user', scopeId: '/s-1', turnUserId: 'bo' });
    const lizards = await first.encode('Bo keeps lizards.', MOOD, 'neutral', { scope: 'user', scopeId: '/s-1', turnUserId: 'bo' });
    await first.shutdown();
    const second = await managerWithoutBrain(vectorStore, knowledgeGraph);
    closers.push(() => second.shutdown());

    expect(await second.deleteScope('user', '/s-1', { turnUserId: 'bo' })).toEqual({ deleted: 2, graph: 'reached' });

    expect((await second.getStore().getByScope('user', '/s-1')).map((trace) => trace.content)).toEqual(['The owner keeps notes.']);
    expect(await copiesOf(knowledgeGraph)).toEqual([{ scopeId: '/s-1', text: 'The owner keeps notes.' }]);
    for (const gone of [snakes, lizards]) expect(await knowledgeGraph.getEntity(gone.id)).toBeUndefined();
    expect(await knowledgeGraph.getEntity(notes.id)).toBeDefined();
  });
});

describe('a graph without deleteMemories', () => {
  it('is reported, and the traces are deleted all the same', async () => {
    const { manager, brain } = await managerOver(tempFile(), () => {
      const graph = new KnowledgeGraph() as IKnowledgeGraph & { deleteMemories?: unknown };
      graph.deleteMemories = undefined;
      return graph;
    });
    await manager.encode('Ana keeps bees on the roof.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    expect(await manager.deleteScope('user', 'ana')).toEqual({ deleted: 1, graph: 'not_supported' });
    expect(await brain.all('SELECT id FROM memory_traces')).toEqual([]);
  });
});

describe('a trace deleted for good', () => {
  const sqlGraph = (brain: Brain) => new SqlKnowledgeGraph(brain) as IKnowledgeGraph;

  it("leaves none of its words in the cache of a store over the Brain, the deleting store's or another's", async () => {
    const filePath = tempFile();
    const { manager } = await managerOver(filePath, sqlGraph);
    // A second manager over the same file, as a second facade or a request-scoped store of the host opens one.
    const reader = await managerOver(filePath, sqlGraph);
    const walnuts = await manager.encode('Ana is allergic to walnuts.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    expect((await reader.manager.getStore().getByScope('user', 'ana')).map((trace) => trace.id)).toEqual([walnuts.id]);

    expect(await manager.deleteScope('user', 'ana')).toEqual({ deleted: 1, graph: 'reached' });

    for (const store of [manager.getStore(), reader.manager.getStore()]) {
      expect(JSON.stringify(store.listTraces())).not.toContain('walnuts');
      expect(store.getTrace(walnuts.id)?.content ?? '').toBe('');
      expect(await store.getByScope('user', 'ana')).toEqual([]);
    }
  });

  it("takes its archived original with it, so rehydrate finds nothing of it", async () => {
    let archive!: SqlStorageMemoryArchive;
    const { manager, brain } = await managerOver(tempFile(), sqlGraph, async (brainOf) => {
      archive = new SqlStorageMemoryArchive(brainOf.adapter, brainOf.features, brainOf.brainId);
      await archive.initialize();
      return { archive };
    });
    const walnuts = await manager.encode('Ana is allergic to walnuts.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    const cello = await manager.encode('Bo plays the cello.', MOOD, 'neutral', { scope: 'user', scopeId: 'bo' });
    // The originals a host's archive keeps of traces it gists, under the trace ids.
    for (const trace of [walnuts, cello]) {
      await archive.store({
        traceId: trace.id,
        agentId: 'agent-1',
        verbatimContent: trace.content,
        contentHash: await sha256Hex(trace.content),
        traceType: trace.type,
        emotionalContext: trace.emotionalContext,
        entities: trace.entities,
        tags: trace.tags,
        createdAt: trace.createdAt,
        archivedAt: Date.now(),
        archiveReason: 'temporal_gist',
      });
    }
    expect(await manager.rehydrate(walnuts.id)).toBe('Ana is allergic to walnuts.');

    await manager.deleteScope('user', 'ana');
    expect(await manager.rehydrate(walnuts.id)).toBeNull();
    expect(await manager.rehydrate(cello.id)).toBe('Bo plays the cello.');
    await manager.deleteTraces([cello.id]);
    expect(await manager.rehydrate(cello.id)).toBeNull();
    expect(await brain.all('SELECT trace_id FROM archived_traces')).toEqual([]);
    expect(await brain.all('SELECT trace_id FROM archive_access_log')).toEqual([]);
  });

  it('takes the typed facts the manager extracted from it, and leaves those of another trace', async () => {
    // The typed network's model, answering each encode with one fact of the text it was given.
    const observerLLM = {
      invoke: async ({ user }: { user: string }) =>
        JSON.stringify({
          facts: [user.includes('walnuts')
            ? { text: 'Ana is allergic to walnuts', bank: 'WORLD', entities: ['Ana'] }
            : { text: 'Bo plays the cello', bank: 'WORLD', entities: ['Bo'] }],
        }),
    };
    const { manager } = await managerOver(tempFile(), sqlGraph, () => ({
      typedNetwork: { variant: 'minimal', extractAtEncode: true, observerLLM },
    }));
    await manager.encode('Ana is allergic to walnuts.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    const cello = await manager.encode('Bo plays the cello.', MOOD, 'neutral', { scope: 'user', scopeId: 'bo' });
    const factTexts = () => [...manager.getTypedNetworkStore()!.iterateFacts()].map((fact) => fact.text).sort();
    expect(factTexts()).toEqual(['Ana is allergic to walnuts', 'Bo plays the cello']);

    await manager.deleteScope('user', 'ana');
    expect(factTexts()).toEqual(['Bo plays the cello']);
    await manager.deleteTraces([cello.id]);
    expect(factTexts()).toEqual([]);
  });

  it('is found under its scope when an older release wrote it to the Brain after the Brain opened', async () => {
    const { manager, brain } = await managerOver(tempFile(), sqlGraph);
    await manager.encode('Ana keeps bees on the roof.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    // A release older than the scope_id column names no such column: its row gets the column's default.
    await brain.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, strength, created_at, tags, emotions, metadata)
       VALUES ('agent-1', 'mt_older_release', 'episodic', 'user', 'Ana is allergic to walnuts.', 0.5, ?, '[]', '{}', ?)`,
      [Date.now(), JSON.stringify({ scopeId: 'ana' })],
    );

    expect(await manager.deleteScope('user', 'ana')).toEqual({ deleted: 2, graph: 'reached' });
    expect(await brain.all('SELECT id FROM memory_traces')).toEqual([]);
  });
});

describe('deleteTraces given an id that names no trace', () => {
  it('skips it, and leaves the knowledge-graph entity that has that id', async () => {
    const { manager, graph } = await managerOver(tempFile(), (brain) => new SqlKnowledgeGraph(brain));
    await graph.upsertEntity({
      id: 'vera',
      type: 'person',
      label: 'Vera',
      properties: {},
      confidence: 1,
      source: { type: 'system', timestamp: new Date().toISOString() },
    });

    expect(await manager.deleteTraces(['vera'])).toEqual({ deleted: 0, graph: 'reached' });
    expect(await graph.getEntity('vera')).toBeDefined();
  });
});

describe('a scope whose collection still holds the document of a trace filed under another scope since', () => {
  it('neither reads nor deletes that trace under the scope, with no Brain', async () => {
    const vectorStore = new InMemoryVectorStore();
    await vectorStore.initialize({ id: `delete-scope-${Math.random()}`, type: 'in_memory' });
    const manager = await managerWithoutBrain(vectorStore, new KnowledgeGraph() as IKnowledgeGraph);
    closers.push(() => manager.shutdown());
    const bees = await manager.encode('Ana keeps bees on the roof.', MOOD, 'neutral', { scope: 'user', scopeId: 'ana' });
    // Stored again under another scope id, the trace's document in Ana's collection stays there, as it does when a
    // move's delete from the old collection fails.
    await manager.getStore().store({ ...manager.getStore().getTrace(bees.id)!, scopeId: 'cy' });

    expect(await manager.getStore().getByScope('user', 'ana')).toEqual([]);
    const recalled = await manager.retrieve('bees on the roof', MOOD, { scopes: [{ scope: 'user', scopeId: 'ana' }] } as never);
    expect(recalled.retrieved).toEqual([]);
    expect(await manager.deleteScope('user', 'ana')).toEqual({ deleted: 0, graph: 'reached' });
    expect((await manager.getStore().getByScope('user', 'cy')).map((trace) => trace.id)).toEqual([bees.id]);
  });
});
