/**
 * @file CognitiveMemoryManager.delete-scope.test.ts
 * Deleting memory: `deleteScope` removes every trace of one scope from the cache, the vector index and the Brain
 * (a reload brings none back), the knowledge graph's episodic copy of each, in the in-memory graph and in
 * `SqlKnowledgeGraph`, and the memory graph's node of each; another scope's traces, copies and nodes stay.
 * `deleteTraces` does the same for the traces it names. A soft delete (a supersede, a prune) takes the trace's copy
 * with it and keeps the Brain row as a tombstone. A real manager over a real SQLite Brain.
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
