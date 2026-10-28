/**
 * @file CognitiveMemoryManager.delete-scope.test.ts
 * Deleting memory: `deleteScope` removes every trace of one scope from the cache, the vector index and the Brain
 * (a reload brings none back), the knowledge graph's episodic copy of each, in the in-memory graph and in
 * `SqlKnowledgeGraph`, and the memory graph's node of each; another scope's traces, copies and nodes stay.
 * `deleteTraces` does the same for the traces it names. The rows that name a deleted trace go or let go of it (its
 * retrieval feedback, the document chunk it was filed from), and a scope deleted again counts nothing. A soft delete
 * (a supersede, a prune) takes the trace's copy with it and keeps the Brain row as a tombstone. A real manager over a
 * real SQLite Brain; with no Brain, a manager started over a vector index another manager filed into finds the scope's
 * traces in the index, whether it lists a collection a page at a time or answers similarity queries alone.
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

async function managerOver(filePath: string, graph: (brain: Brain) => IKnowledgeGraph): Promise<{ manager: CognitiveMemoryManager; brain: Brain; graph: IKnowledgeGraph }> {
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

/** An in-memory index with no metadata scan, as a host's store that answers similarity queries alone. */
function answeringQueriesAlone(store: InMemoryVectorStore): InMemoryVectorStore {
  (store as { scanByMetadata?: unknown }).scanByMetadata = undefined;
  return store;
}

describe.each([
  ['an index that lists a collection two documents a read', scanningTwoAtATime],
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
