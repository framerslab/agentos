/**
 * @file memoryFixtures.ts
 * Real memory for the learning layer's tests: a CognitiveMemoryManager over a SQLite Brain with a deterministic
 * embedding and a SQL knowledge graph, and a Memory facade over a SQLite file of its own. `closeMemory()`, called in a
 * test file's `afterEach`, closes each and removes its directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CognitiveMemoryManager } from '../../../memory/CognitiveMemoryManager.js';
import { Memory } from '../../../memory/io/facade/Memory.js';
import { Brain } from '../../../memory/retrieval/store/Brain.js';
import { SqlKnowledgeGraph } from '../../../memory/retrieval/store/SqlKnowledgeGraph.js';
import { InMemoryVectorStore } from '../../../rag/vector_stores/InMemoryVectorStore.js';
import { InMemoryWorkingMemory } from '../../../substrate/memory/InMemoryWorkingMemory.js';

export const MOOD = { valence: 0, arousal: 0, dominance: 0 };

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

/** Closes every manager and facade the fixtures opened, newest first, and removes their directories. */
export async function closeMemory(): Promise<void> {
  while (closers.length) await closers.pop()!();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
}

/** A SQLite file in a directory of its own. */
export function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-memory-'));
  dirs.push(dir);
  return path.join(dir, 'brain.sqlite');
}

/** A deterministic 8-dimension embedding: equal texts embed equally. */
function embed(text: string): number[] {
  const vector = new Array<number>(8).fill(0);
  for (let i = 0; i < text.length; i += 1) vector[i % 8] += text.charCodeAt(i) / 1000;
  return vector.map((value) => value + 0.01);
}

/** A memory manager over a SQLite Brain, as a GMI's. */
export async function managerOver(filePath: string, brainId: string): Promise<{ manager: CognitiveMemoryManager; brain: Brain }> {
  const brain = await Brain.openSqlite(filePath, { brainId });
  const knowledgeGraph = new SqlKnowledgeGraph(brain);
  await knowledgeGraph.initialize();
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: `learning-${brainId}-${Math.random()}`, type: 'in_memory' });
  const manager = new CognitiveMemoryManager();
  await manager.initialize({
    agentId: brainId,
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
  return { manager, brain };
}

/** A Memory facade over a SQLite file of its own, as a host's memory tools are built over. */
export async function facadeAt(filePath: string, brainId: string): Promise<{ memory: Memory; brain: Brain }> {
  const memory = await Memory.createSqlite(filePath, { brainId });
  closers.push(() => memory.close());
  return { memory, brain: (memory as unknown as { _brain: Brain })._brain };
}

/** The text of every live trace of a Brain, sorted. */
export async function liveContents(brain: Brain): Promise<string[]> {
  return (await brain.all<{ content: string }>('SELECT content FROM memory_traces WHERE deleted = 0 ORDER BY content')).map((row) => row.content);
}
