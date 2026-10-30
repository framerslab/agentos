/**
 * @file learning-store-and-scopes.e2e.test.ts
 * What a host sees of memory filed and kept by scope and of the learning store, driven through the package
 * root (`@framers/agentos`) the way a host imports it. The gmi() runtime runs on the repository's stub model
 * provider (helpers/stubProviders.ts, installed at the provider classes' module boundary): no network and no
 * vendor key.
 *
 * A trace keeps its reinforcement across a restart. With a Brain, `store()` and every recall write the trace's
 * stability, access count, reinforcement interval and next reinforcement time into its row's metadata under
 * `decay` (the object the `Memory` facade reads and writes too), and a manager over the reopened file loads
 * them. With no Brain, the vector index carries them. `persistAccessState: false` writes and loads as before.
 *
 * A trace deleted for good leaves nothing of what it said. `deleteScope` and `deleteTraces` take each trace from the
 * store, the Brain (with the rows that name it) and the full-text index, with its memory-graph node, its original in
 * the host's archive, the typed facts extracted from it and its episodic copy in the knowledge graph (in-memory or
 * SQL), and report `{ deleted, graph }`. With no Brain, a manager started later over the same vector index deletes a
 * scope another store filed.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
// The stub replaces the provider class alone: the package root also reads the module's other exports (its base URL).
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Brain,
  CognitiveMemoryManager,
  InMemoryVectorStore,
  KnowledgeGraph,
  Memory,
  SqlKnowledgeGraph,
  agent,
  type CognitiveMemoryConfig,
  type ICognitiveMemoryManager,
  type IKnowledgeGraph,
  type MemoryCopyFilter,
  type MemoryDeletion,
  type MemoryTrace,
  type PADState,
} from '@framers/agentos';
import { reply, script } from './helpers/stubProviders';

/** The embedding size of a common hosted model. Every text embeds as one direction, so a recall finds every trace of its scope. */
const DIMENSION = 1536;
const NEUTRAL: PADState = { valence: 0, arousal: 0, dominance: 0 };
const ONE_HOUR = 3_600_000;
const TWO_HOURS = 7_200_000;
const FOUR_HOURS = 14_400_000;

let serial = 0;
const managers: CognitiveMemoryManager[] = [];
const brains = new Set<Brain>();
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const manager of managers.splice(0)) await manager.shutdown().catch(() => undefined);
  for (const brain of brains) await brain.close().catch(() => undefined);
  brains.clear();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The host's embedding model, fixed, returning vectors of `size` values. With `reportsSize` false its manager cannot
 * report the model's size: `getEmbeddingDimension()` throws, as the package's EmbeddingManager does for a model whose
 * size is not configured.
 */
function embedder(size: number, reportsSize = true): CognitiveMemoryConfig['embeddingManager'] {
  return {
    generateEmbeddings: async (request: { texts: string | string[] }) => ({
      embeddings: (Array.isArray(request.texts) ? request.texts : [request.texts]).map(() => {
        const vector = new Array<number>(size).fill(0);
        vector[0] = 1;
        return vector;
      }),
      modelId: 'fixed',
      providerId: 'fixed',
      usage: { totalTokens: 0 },
    }),
    getEmbeddingDimension: async () => {
      if (!reportsSize) throw new Error("Embedding dimension for model 'fixed' is not configured.");
      return size;
    },
  } as unknown as CognitiveMemoryConfig['embeddingManager'];
}

/** A working memory a host supplies: the manager's contract, kept in a map. */
function workingMemory(): CognitiveMemoryConfig['workingMemory'] {
  const items = new Map<string, unknown>();
  return {
    id: `qa-working-${++serial}`,
    initialize: async () => undefined,
    set: async <T>(key: string, value: T) => {
      items.set(key, value);
    },
    get: async <T>(key: string) => items.get(key) as T | undefined,
    delete: async (key: string) => {
      items.delete(key);
    },
    getAll: async () => Object.fromEntries(items),
    clear: async () => {
      items.clear();
    },
    size: async () => items.size,
    has: async (key: string) => items.has(key),
  };
}

/** An empty in-process vector index. A second manager built over the same one stands for a restart over a durable index. */
async function vectorIndex(dimension = DIMENSION): Promise<InMemoryVectorStore> {
  const index = new InMemoryVectorStore();
  const config = { id: `qa-index-${++serial}`, type: 'in_memory', similarityMetric: 'cosine', defaultEmbeddingDimension: dimension };
  await index.initialize(config);
  return index;
}

/**
 * A memory manager as a host builds one: its knowledge graph (a new in-memory one by default; the one given is
 * initialized here), the given index (a new one by default), the given Brain, an embedding model of the given size
 * (1536 by default), whose manager reports that size unless `reportsSize` is false, and any further settings.
 */
async function manager(
  options: {
    brain?: Brain;
    index?: InMemoryVectorStore;
    persistAccessState?: boolean;
    dimension?: number;
    reportsSize?: boolean;
    knowledgeGraph?: IKnowledgeGraph;
    config?: Partial<CognitiveMemoryConfig>;
  } = {},
): Promise<CognitiveMemoryManager> {
  const knowledgeGraph = options.knowledgeGraph ?? new KnowledgeGraph();
  await knowledgeGraph.initialize();
  const config: CognitiveMemoryConfig = {
    workingMemory: workingMemory(),
    knowledgeGraph,
    vectorStore: options.index ?? (await vectorIndex(options.dimension)),
    embeddingManager: embedder(options.dimension ?? DIMENSION, options.reportsSize),
    agentId: 'qa-agent',
    traits: { honesty: 0.5, emotionality: 0.5, extraversion: 0.5, agreeableness: 0.5, conscientiousness: 0.5, openness: 0.5 },
    moodProvider: () => ({ ...NEUTRAL }),
    featureDetectionStrategy: 'keyword',
    consolidation: { enabled: false },
    ...(options.brain ? { brain: options.brain } : {}),
    ...(options.persistAccessState === undefined ? {} : { persistAccessState: options.persistAccessState }),
    ...options.config,
  };
  const built = new CognitiveMemoryManager();
  await built.initialize(config);
  managers.push(built);
  return built;
}

/** Stops a manager, and closes its Brain, as a process that exits does. */
async function stop(stopped: CognitiveMemoryManager, brain?: Brain): Promise<void> {
  const at = managers.indexOf(stopped);
  if (at >= 0) managers.splice(at, 1);
  await stopped.shutdown();
  if (brain) {
    brains.delete(brain);
    await brain.close();
  }
}

/** A Brain file in a directory of its own, removed after the test. */
function brainFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-memory-'));
  dirs.push(dir);
  return path.join(dir, 'brain.sqlite');
}

async function openBrain(file: string): Promise<Brain> {
  const brain = await Brain.openSqlite(file, { brainId: 'qa' });
  brains.add(brain);
  return brain;
}

interface TraceRow {
  metadata: string | null;
  retrieval_count: number;
  last_accessed: number | null;
  strength: number;
}

/** A trace's row as a host reads it from the Brain. */
async function rowOf(brain: Brain, id: string): Promise<TraceRow> {
  const found = await brain.get<TraceRow>(
    'SELECT metadata, retrieval_count, last_accessed, strength FROM memory_traces WHERE brain_id = ? AND id = ?',
    [brain.brainId, id],
  );
  if (!found) throw new Error(`no row for trace ${id}`);
  return found;
}

async function metadataOf(brain: Brain, id: string): Promise<Record<string, unknown>> {
  return JSON.parse((await rowOf(brain, id)).metadata ?? '{}') as Record<string, unknown>;
}

/** How many reads of a trace's metadata another writer races, and how many writes it has made. */
interface Races {
  left: number;
  written: number;
}

/**
 * The Brain, with another writer (another process on the same database) that changes a trace's row right after
 * a recall reads its metadata, while `races.left` is above zero. It keeps the row's keys and adds `otherWriter`.
 */
function contendedBy(brain: Brain, races: Races): Brain {
  return new Proxy(brain, {
    get(target, property) {
      if (property === 'get') {
        return async (sql: string, params?: Parameters<Brain['get']>[1]) => {
          const read = await target.get(sql, params);
          if (races.left > 0 && sql.startsWith('SELECT metadata FROM memory_traces')) {
            races.left -= 1;
            races.written += 1;
            const id = (params as unknown as string[])[1]!;
            const current = await metadataOf(target, id);
            await target.run('UPDATE memory_traces SET metadata = ? WHERE brain_id = ? AND id = ?', [
              JSON.stringify({ ...current, otherWriter: races.written }),
              target.brainId,
              id,
            ]);
          }
          return read;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** What the user tells the agent about Ana. */
const tell = (memory: CognitiveMemoryManager) =>
  memory.encode("Ana's sister is Vera.", NEUTRAL, 'neutral', {
    scope: 'user',
    scopeId: 'ana',
    entities: ['Vera', 'Ana'],
    tags: ['family'],
    sourceType: 'user_statement',
  });

/** A recall of Ana's memories; the manager records an access for each trace it returns. */
const recall = (memory: CognitiveMemoryManager) =>
  memory.retrieve("Who is Ana's sister?", NEUTRAL, { scopes: [{ scope: 'user', scopeId: 'ana' }] });

/** A trace a host files through the manager's store, with associations and structured data of its own. */
function linkedTrace(associatedTo: string): MemoryTrace {
  const at = Date.now() - 1000;
  return {
    id: 'qa-linked',
    type: 'semantic',
    scope: 'user',
    scopeId: 'ana',
    content: 'Vera lives in Lisbon.',
    entities: ['Vera'],
    tags: ['family', 'place'],
    provenance: { sourceType: 'user_statement', sourceTimestamp: at, confidence: 0.9, verificationCount: 2 },
    emotionalContext: { valence: 0.2, arousal: 0.1, dominance: 0, intensity: 0.4, gmiMood: 'neutral' },
    encodingStrength: 0.8,
    stability: TWO_HOURS,
    retrievalCount: 0,
    lastAccessedAt: at,
    accessCount: 0,
    reinforcementInterval: ONE_HOUR,
    associatedTraceIds: [associatedTo],
    structuredData: { relation: 'sister', city: 'Lisbon' },
    createdAt: at,
    updatedAt: at,
    isActive: true,
  } as MemoryTrace;
}

/** Something the user tells the agent, filed under the user scope with this scope id. */
const tellAbout = (memory: Pick<ICognitiveMemoryManager, 'encode'>, scopeId: string, text: string) =>
  memory.encode(text, NEUTRAL, 'neutral', { scope: 'user', scopeId });

/** A trace's episodic copy in a knowledge graph: its node id, the trace and scope id its context names, its text. */
interface Copy {
  id: string;
  traceId: unknown;
  scopeId: unknown;
  text: string | undefined;
}

/** The episodic copies of memory traces a knowledge graph holds (the records whose context names a trace), by text. */
async function copiesIn(graph: IKnowledgeGraph): Promise<Copy[]> {
  const memories = await graph.queryMemories({ limit: 1000 });
  return memories
    .filter((memory) => typeof memory.context?.memoryTraceId === 'string')
    .map((memory) => ({
      id: memory.id,
      traceId: memory.context!.memoryTraceId,
      scopeId: memory.context!.scopeId,
      text: memory.description,
    }))
    .sort((a, b) => String(a.text).localeCompare(String(b.text)));
}

/** The record `MemoryStore.store()` writes of a trace, left in the graph after an older release deleted its trace. */
function leftoverCopy(traceId: string, scopeId: string, text: string): Parameters<IKnowledgeGraph['recordMemory']>[0] {
  return {
    type: 'discovery',
    summary: text,
    description: text,
    participants: [scopeId],
    importance: 0.5,
    entityIds: [],
    occurredAt: new Date().toISOString(),
    outcome: 'unknown',
    context: { memoryTraceId: traceId, scope: 'user', scopeId, type: 'semantic' },
  };
}

const HOST_SOURCE = { type: 'user_input', timestamp: '2026-10-29T00:00:00.000Z' } as const;

/** A relation the host makes in its knowledge graph, from one node to another. */
const relate = (graph: IKnowledgeGraph, sourceId: string, targetId: string) =>
  graph.upsertRelation({
    sourceId,
    targetId,
    type: 'related_to',
    label: 'mentions',
    weight: 1,
    bidirectional: false,
    confidence: 1,
    source: HOST_SOURCE,
  });

/** How many rows the Brain's full-text index finds for a word. */
async function fullTextHits(brain: Brain, word: string): Promise<number> {
  const found = await brain.get<{ n: number }>('SELECT count(*) AS n FROM memory_traces_fts WHERE memory_traces_fts MATCH ?', [word]);
  return Number(found?.n ?? 0);
}

/** The ids of a brain's trace rows. */
async function traceRowIds(brain: Brain): Promise<string[]> {
  const rows = await brain.all<{ id: string }>('SELECT id FROM memory_traces WHERE brain_id = ? ORDER BY id', [brain.brainId]);
  return rows.map((row) => row.id);
}

/** An archive a host supplies (`CognitiveMemoryConfig.archive`), holding each trace's original in a map. */
function hostArchive(): { archive: NonNullable<CognitiveMemoryConfig['archive']>; held: Map<string, string> } {
  const held = new Map<string, string>();
  const archive: NonNullable<CognitiveMemoryConfig['archive']> = {
    initialize: async () => undefined,
    store: async (trace) => {
      held.set(trace.traceId, trace.verbatimContent);
      return { success: true, traceId: trace.traceId, bytesWritten: trace.verbatimContent.length };
    },
    rehydrate: async (traceId) => {
      const verbatimContent = held.get(traceId);
      return verbatimContent === undefined
        ? null
        : { traceId, verbatimContent, contentHash: `hash-${traceId}`, archivedAt: 0, archiveReason: 'temporal_gist' };
    },
    drop: async (traceId) => {
      held.delete(traceId);
    },
    list: async () => [],
    lastAccessedAt: async () => null,
  };
  return { archive, held };
}

/** The original a gist mechanism writes to the archive before it shortens a trace. */
function originalOf(trace: MemoryTrace): Parameters<NonNullable<CognitiveMemoryConfig['archive']>['store']>[0] {
  return {
    traceId: trace.id,
    agentId: 'qa-agent',
    verbatimContent: trace.content,
    contentHash: `hash-${trace.id}`,
    traceType: trace.type,
    emotionalContext: trace.emotionalContext,
    entities: trace.entities,
    tags: trace.tags,
    createdAt: trace.createdAt,
    archivedAt: Date.now(),
    archiveReason: 'temporal_gist',
  };
}

describe('a trace keeps its reinforcement across a restart, with a Brain file', () => {
  it('a recalled trace loads after a restart with the stability, access count and reinforcement schedule the recall left, and everything it was stored with', async () => {
    const file = brainFile();
    const firstBrain = await openBrain(file);
    const first = await manager({ brain: firstBrain });
    const told = await tell(first);
    const toldId = told.id;
    const storedStability = told.stability;
    await first.getStore().store(linkedTrace(toldId));
    const ids = [toldId, 'qa-linked'].sort();

    expect((await recall(first)).retrieved.map((hit) => hit.id).sort()).toEqual(ids);
    const accessed = new Map(ids.map((id) => [id, structuredClone(first.getStore().getTrace(id)!)]));
    for (const trace of accessed.values()) {
      expect(trace).toMatchObject({ accessCount: 1, reinforcementInterval: TWO_HOURS, retrievalCount: 1 });
      expect(trace.nextReinforcementAt).toBe(trace.lastAccessedAt + TWO_HOURS);
    }
    expect(accessed.get(toldId)!.stability).toBeGreaterThan(storedStability);
    await stop(first, firstBrain);

    const secondBrain = await openBrain(file);
    const second = await manager({ brain: secondBrain });
    const loaded = new Map((await recall(second)).retrieved.map((hit) => [hit.id, hit]));
    expect([...loaded.keys()].sort()).toEqual(ids);
    for (const [id, before] of accessed) {
      expect(loaded.get(id)).toMatchObject({
        stability: before.stability,
        accessCount: 1,
        reinforcementInterval: TWO_HOURS,
        nextReinforcementAt: before.nextReinforcementAt,
        retrievalCount: 1,
        provenance: before.provenance,
        entities: before.entities,
        tags: before.tags,
        associatedTraceIds: before.associatedTraceIds,
      });
    }
    expect(loaded.get('qa-linked')).toMatchObject({
      associatedTraceIds: [toldId],
      structuredData: { relation: 'sister', city: 'Lisbon' },
      provenance: { sourceType: 'user_statement', confidence: 0.9, verificationCount: 2 },
    });
    // The restarted manager's own recall reinforces from the loaded state.
    expect(second.getStore().getTrace(toldId)).toMatchObject({ accessCount: 2, reinforcementInterval: FOUR_HOURS });
  });

  it("writes the decay state into the row's metadata under decay at store and at each recall, and keeps the row's other keys", async () => {
    const brain = await openBrain(brainFile());
    const memory = await manager({ brain });
    const told = await tell(memory);
    const id = told.id;
    const storedStability = told.stability;

    const stored = await metadataOf(brain, id);
    expect(stored).toMatchObject({
      scopeId: 'ana',
      entities: ['Vera', 'Ana'],
      decay: { stability: storedStability, accessCount: 0, reinforcementInterval: ONE_HOUR },
    });
    expect(stored.decay).not.toHaveProperty('nextReinforcementAt');
    // A key the host keeps in the row survives the recall's write.
    await brain.run('UPDATE memory_traces SET metadata = ? WHERE brain_id = ? AND id = ?', [
      JSON.stringify({ ...stored, hostNote: 'kept' }),
      brain.brainId,
      id,
    ]);

    await recall(memory);
    const accessed = memory.getStore().getTrace(id)!;
    expect(await metadataOf(brain, id)).toMatchObject({
      hostNote: 'kept',
      scopeId: 'ana',
      entities: ['Vera', 'Ana'],
      provenance: { sourceType: 'user_statement' },
      decay: {
        stability: accessed.stability,
        accessCount: 1,
        reinforcementInterval: TWO_HOURS,
        nextReinforcementAt: accessed.nextReinforcementAt,
      },
    });
    expect((await rowOf(brain, id)).retrieval_count).toBe(1);
  });

  it("a recall that loses the row to another writer reads it again and keeps that writer's keys; after a second lost race it writes the access columns alone", async () => {
    const brain = await openBrain(brainFile());
    const races: Races = { left: 0, written: 0 };
    const memory = await manager({ brain: contendedBy(brain, races) });
    const id = (await tell(memory)).id;

    races.left = 1;
    await recall(memory);
    expect(await metadataOf(brain, id)).toMatchObject({ otherWriter: 1, decay: { accessCount: 1, reinforcementInterval: TWO_HOURS } });
    expect((await rowOf(brain, id)).retrieval_count).toBe(1);

    races.left = 2;
    await recall(memory);
    expect(memory.getStore().getTrace(id)).toMatchObject({ accessCount: 2, reinforcementInterval: FOUR_HOURS });
    // The other writer's row stands as it wrote it: its keys, and the decay state the first recall merged.
    expect(await metadataOf(brain, id)).toMatchObject({ otherWriter: 3, decay: { accessCount: 1, reinforcementInterval: TWO_HOURS } });
    expect((await rowOf(brain, id)).retrieval_count).toBe(2);
  });

  it('leaves a row whose metadata is not a JSON object as it is, and writes the access columns', async () => {
    const brain = await openBrain(brainFile());
    const memory = await manager({ brain });
    const id = (await tell(memory)).id;
    await brain.run('UPDATE memory_traces SET metadata = ? WHERE brain_id = ? AND id = ?', [
      '["not","an","object"]',
      brain.brainId,
      id,
    ]);

    await recall(memory);
    const accessed = memory.getStore().getTrace(id)!;
    const after = await rowOf(brain, id);
    expect(after.metadata).toBe('["not","an","object"]');
    expect(after).toMatchObject({
      retrieval_count: 1,
      last_accessed: accessed.lastAccessedAt,
      strength: accessed.encodingStrength,
    });
  });

  it("loads the reinforcement the Memory facade's feedback adds to the row between a recall and the restart", async () => {
    const file = brainFile();
    const firstBrain = await openBrain(file);
    const first = await manager({ brain: firstBrain });
    const id = (await tell(first)).id;
    await recall(first);
    const accessed = structuredClone(first.getStore().getTrace(id)!);
    await stop(first, firstBrain);

    const facade = await Memory.createSqlite(file, { brainId: 'qa', selfImprove: true });
    try {
      await facade.feedback(id, 'used');
    } finally {
      await facade.close();
    }

    const secondBrain = await openBrain(file);
    const second = await manager({ brain: secondBrain });
    const [loaded] = (await recall(second)).retrieved;
    // The feedback read the state the recall left (one access, a two-hour interval) and added one access.
    expect(loaded).toMatchObject({ id, accessCount: 2, reinforcementInterval: FOUR_HOURS, retrievalCount: 2 });
    expect(loaded!.stability).toBeGreaterThan(accessed.stability);
  });

  it('loads a row written without the decay object with the stability it was stored with, no access count and a one-hour interval, and its first recall adds the object', async () => {
    const file = brainFile();
    // The switch off writes the row the way an earlier release did: no decay object.
    const earlierBrain = await openBrain(file);
    const earlier = await manager({ brain: earlierBrain, persistAccessState: false });
    const told = await tell(earlier);
    const id = told.id;
    const storedStability = told.stability;
    await stop(earlier, earlierBrain);

    const brain = await openBrain(file);
    const memory = await manager({ brain });
    const [loaded] = (await recall(memory)).retrieved;
    expect(loaded).toMatchObject({ id, stability: storedStability, accessCount: 0, reinforcementInterval: ONE_HOUR });
    expect(loaded!.nextReinforcementAt).toBeUndefined();
    const accessed = memory.getStore().getTrace(id)!;
    expect(await metadataOf(brain, id)).toMatchObject({
      decay: {
        stability: accessed.stability,
        accessCount: 1,
        reinforcementInterval: TWO_HOURS,
        nextReinforcementAt: accessed.nextReinforcementAt,
      },
    });
  });

  it('with persistAccessState false, a recall writes the access columns alone, and a restart loads the trace as before: no access count, a one-hour interval, the stability it was stored with', async () => {
    const file = brainFile();
    const firstBrain = await openBrain(file);
    const first = await manager({ brain: firstBrain, persistAccessState: false });
    const told = await tell(first);
    const id = told.id;
    const storedStability = told.stability;
    expect(await metadataOf(firstBrain, id)).not.toHaveProperty('decay');

    await recall(first);
    // In the process the recall reinforces the trace as it always did.
    expect(first.getStore().getTrace(id)).toMatchObject({ accessCount: 1, reinforcementInterval: TWO_HOURS });
    const accessedRow = await rowOf(firstBrain, id);
    expect(accessedRow.retrieval_count).toBe(1);
    expect(JSON.parse(accessedRow.metadata ?? '{}')).not.toHaveProperty('decay');
    await stop(first, firstBrain);

    const secondBrain = await openBrain(file);
    const second = await manager({ brain: secondBrain, persistAccessState: false });
    const [loaded] = (await recall(second)).retrieved;
    expect(loaded).toMatchObject({
      id,
      stability: storedStability,
      accessCount: 0,
      reinforcementInterval: ONE_HOUR,
      retrievalCount: 1,
    });
    expect(loaded!.nextReinforcementAt).toBeUndefined();
  });
});

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('a trace keeps its reinforcement across a restart, with a Postgres Brain', () => {
  it("a recall that loses the row to another writer merges its decay state on the second read and keeps that writer's keys; a manager over a new connection loads the trace, and it and the Memory facade count on from the row", async () => {
    const brainId = `qa-access-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const firstBrain = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    brains.add(firstBrain);
    try {
      const races: Races = { left: 0, written: 0 };
      const first = await manager({ brain: contendedBy(firstBrain, races) });
      const id = (await tell(first)).id;
      expect(await metadataOf(firstBrain, id)).toMatchObject({ decay: { accessCount: 0, reinforcementInterval: ONE_HOUR } });

      races.left = 1;
      await recall(first);
      const accessed = structuredClone(first.getStore().getTrace(id)!);
      expect(await metadataOf(firstBrain, id)).toMatchObject({
        otherWriter: 1,
        decay: {
          stability: accessed.stability,
          accessCount: 1,
          reinforcementInterval: TWO_HOURS,
          nextReinforcementAt: accessed.nextReinforcementAt,
        },
      });
      await stop(first, firstBrain);

      const secondBrain = await Brain.openPostgres(POSTGRES_URL!, { brainId });
      brains.add(secondBrain);
      const second = await manager({ brain: secondBrain });
      const [loaded] = (await recall(second)).retrieved;
      expect(loaded).toMatchObject({
        id,
        stability: accessed.stability,
        accessCount: 1,
        reinforcementInterval: TWO_HOURS,
        nextReinforcementAt: accessed.nextReinforcementAt,
        retrievalCount: 1,
        lastAccessedAt: accessed.lastAccessedAt,
        createdAt: accessed.createdAt,
        entities: ['Vera', 'Ana'],
      });
      // The restarted manager's recall counts on from the loaded state, in the trace and in the row.
      expect(second.getStore().getTrace(id)).toMatchObject({ accessCount: 2, retrievalCount: 2, reinforcementInterval: FOUR_HOURS });
      expect(Number((await rowOf(secondBrain, id)).retrieval_count)).toBe(2);
      await stop(second, secondBrain);

      // The Memory facade's feedback on the same database counts on from the row as well.
      const facade = await Memory.createPostgres(POSTGRES_URL!, { brainId, selfImprove: true });
      try {
        await facade.feedback(id, 'used');
      } finally {
        await facade.close();
      }
      const reader = await Brain.openPostgres(POSTGRES_URL!, { brainId });
      brains.add(reader);
      expect(Number((await rowOf(reader, id)).retrieval_count)).toBe(3);
      expect(await metadataOf(reader, id)).toMatchObject({ decay: { accessCount: 3, reinforcementInterval: 2 * FOUR_HOURS } });
    } finally {
      const cleaner = await Brain.openPostgres(POSTGRES_URL!, { brainId });
      await cleaner.run('DELETE FROM retrieval_feedback WHERE brain_id = ?', [brainId]);
      await cleaner.run('DELETE FROM memory_traces WHERE brain_id = ?', [brainId]);
      await cleaner.close();
    }
  });
});

describe('a trace keeps its reinforcement schedule across a restart, with no Brain, in the vector index', () => {
  it('a manager started later over the same index restores the stability, access count and schedule a recall left, through getByScope and through a recall', async () => {
    const index = await vectorIndex();
    const first = await manager({ index });
    const id = (await tell(first)).id;
    await recall(first);
    const accessed = structuredClone(first.getStore().getTrace(id)!);
    const schedule = {
      id,
      stability: accessed.stability,
      accessCount: 1,
      reinforcementInterval: TWO_HOURS,
      nextReinforcementAt: accessed.nextReinforcementAt,
    };
    expect(accessed.nextReinforcementAt).toBe(accessed.lastAccessedAt + TWO_HOURS);
    await stop(first);

    const listing = await manager({ index });
    const [listed] = await listing.getStore().getByScope('user', 'ana');
    expect(listed).toMatchObject(schedule);
    await stop(listing);

    const recalling = await manager({ index });
    const [recalled] = (await recall(recalling)).retrieved;
    expect(recalled).toMatchObject(schedule);
  });

  it("restores them through getByScope when the host's embedding model returns 768 values, as nomic-embed-text does", async () => {
    const index = await vectorIndex(768);
    const first = await manager({ index, dimension: 768 });
    const id = (await tell(first)).id;
    await recall(first);
    const accessed = structuredClone(first.getStore().getTrace(id)!);
    await stop(first);

    const listing = await manager({ index, dimension: 768 });
    const [listed] = await listing.getStore().getByScope('user', 'ana');
    expect(listed).toMatchObject({
      id,
      content: "Ana's sister is Vera.",
      stability: accessed.stability,
      accessCount: 1,
      reinforcementInterval: TWO_HOURS,
      nextReinforcementAt: accessed.nextReinforcementAt,
    });
  });

  it("restores them through getByScope when the embedding manager cannot report the model's size, from the length of one embedding", async () => {
    const index = await vectorIndex(768);
    const first = await manager({ index, dimension: 768, reportsSize: false });
    const id = (await tell(first)).id;
    await recall(first);
    const accessed = structuredClone(first.getStore().getTrace(id)!);
    await stop(first);

    const listing = await manager({ index, dimension: 768, reportsSize: false });
    const [listed] = await listing.getStore().getByScope('user', 'ana');
    expect(listed).toMatchObject({
      id,
      content: "Ana's sister is Vera.",
      accessCount: 1,
      reinforcementInterval: TWO_HOURS,
      nextReinforcementAt: accessed.nextReinforcementAt,
    });
  });

  it('restores a trace whose index entry holds no schedule with a one-hour interval, which its next recall doubles', async () => {
    const index = await vectorIndex();
    // The switch off files the entry the way an earlier release did: no schedule.
    const earlier = await manager({ index, persistAccessState: false });
    const id = (await tell(earlier)).id;
    await stop(earlier);

    const later = await manager({ index });
    const [listed] = await later.getStore().getByScope('user', 'ana');
    expect(listed).toMatchObject({ id, reinforcementInterval: ONE_HOUR });
    await recall(later);
    expect(later.getStore().getTrace(id)).toMatchObject({ accessCount: 1, reinforcementInterval: TWO_HOURS });
  });

  it('with persistAccessState false, the index carries no schedule: no next reinforcement time, the interval 0 through getByScope and one hour through a recall', async () => {
    const index = await vectorIndex();
    const first = await manager({ index, persistAccessState: false });
    const id = (await tell(first)).id;
    await recall(first);
    await stop(first);

    const listing = await manager({ index, persistAccessState: false });
    const [listed] = await listing.getStore().getByScope('user', 'ana');
    expect(listed).toMatchObject({ id, reinforcementInterval: 0 });
    expect(listed!.nextReinforcementAt).toBeUndefined();
    await stop(listing);

    const recalling = await manager({ index, persistAccessState: false });
    const [recalled] = (await recall(recalling)).retrieved;
    expect(recalled).toMatchObject({ id, reinforcementInterval: ONE_HOUR });
    expect(recalled!.nextReinforcementAt).toBeUndefined();
  });
});

describe.each([
  ['the in-memory knowledge graph', (_brain: Brain): IKnowledgeGraph => new KnowledgeGraph()],
  ['SqlKnowledgeGraph over the Brain', (brain: Brain): IKnowledgeGraph => new SqlKnowledgeGraph(brain)],
])('deleting memory for good, with a Brain file and %s', (_name, graphOver) => {
  it("deleteScope takes one scope's traces from the store, the Brain and the full-text index, with their memory-graph nodes and episodic copies; another scope's stay, and a call made again counts none", async () => {
    const brain = await openBrain(brainFile());
    const graph = graphOver(brain);
    const memory = await manager({ brain, knowledgeGraph: graph });
    const bees = await tellAbout(memory, 'ana', 'Ana keeps bees on the roof.');
    const walnuts = await tellAbout(memory, 'ana', 'Ana is allergic to walnuts.');
    const cello = await tellAbout(memory, 'bo', 'Bo plays the cello.');
    expect((await copiesIn(graph)).map((copy) => copy.traceId)).toEqual([walnuts.id, bees.id, cello.id]);
    expect([bees.id, walnuts.id, cello.id].map((id) => memory.getGraph()!.hasNode(id))).toEqual([true, true, true]);
    expect(await fullTextHits(brain, 'walnuts')).toBe(1);

    const deletion: MemoryDeletion = await memory.deleteScope('user', 'ana');

    expect(deletion).toEqual({ deleted: 2, graph: 'reached' });
    expect(await memory.getStore().getByScope('user', 'ana')).toEqual([]);
    expect((await memory.getStore().getByScope('user', 'bo')).map((trace) => trace.content)).toEqual(['Bo plays the cello.']);
    expect(await traceRowIds(brain)).toEqual([cello.id]);
    expect(await copiesIn(graph)).toEqual([expect.objectContaining({ traceId: cello.id, scopeId: 'bo', text: 'Bo plays the cello.' })]);
    expect([bees.id, walnuts.id, cello.id].map((id) => memory.getGraph()!.hasNode(id))).toEqual([false, false, true]);
    expect(await graph.getEntity(bees.id)).toBeUndefined();
    expect(await fullTextHits(brain, 'walnuts')).toBe(0);
    expect(await fullTextHits(brain, 'cello')).toBe(1);

    expect(await memory.deleteScope('user', 'ana')).toEqual({ deleted: 0, graph: 'reached' });
    expect(await memory.deleteTraces([bees.id, walnuts.id])).toEqual({ deleted: 0, graph: 'reached' });
  });

  it('leaves nothing of the scope a manager over the reopened file recalls or loads', async () => {
    const file = brainFile();
    const firstBrain = await openBrain(file);
    const first = await manager({ brain: firstBrain, knowledgeGraph: graphOver(firstBrain) });
    await tellAbout(first, 'ana', 'Ana keeps bees on the roof.');
    await tellAbout(first, 'bo', 'Bo keeps bees too.');
    await first.deleteScope('user', 'ana');
    await stop(first, firstBrain);

    const brain = await openBrain(file);
    const later = await manager({ brain, knowledgeGraph: graphOver(brain) });
    expect((await recall(later)).retrieved).toEqual([]);
    expect(await later.getStore().getByScope('user', 'ana')).toEqual([]);
    const bo = await later.retrieve('Who keeps bees?', NEUTRAL, { scopes: [{ scope: 'user', scopeId: 'bo' }] });
    expect(bo.retrieved.map((trace) => trace.content)).toEqual(['Bo keeps bees too.']);
  });

  it('deleteTraces takes one trace with its copy; a soft delete takes the copy and keeps the row as a tombstone', async () => {
    const brain = await openBrain(brainFile());
    const graph = graphOver(brain);
    const memory = await manager({ brain, knowledgeGraph: graph });
    const keep = await tellAbout(memory, 'ana', 'Ana keeps bees on the roof.');
    const gone = await tellAbout(memory, 'ana', 'Ana is allergic to walnuts.');
    const superseded = await tellAbout(memory, 'ana', 'Ana lives in Lyon.');

    expect(await memory.deleteTraces([gone.id])).toEqual({ deleted: 1, graph: 'reached' });
    await memory.getStore().softDelete(superseded.id);

    const rows = await brain.all<{ id: string; deleted: number }>('SELECT id, deleted FROM memory_traces WHERE brain_id = ? ORDER BY id', [
      brain.brainId,
    ]);
    expect(rows).toEqual([{ id: keep.id, deleted: 0 }, { id: superseded.id, deleted: 1 }].sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect((await copiesIn(graph)).map((copy) => copy.text)).toEqual(['Ana keeps bees on the roof.']);
  });

  it("keeps one copy of a trace, keyed by the trace: storing the trace again replaces it", async () => {
    const brain = await openBrain(brainFile());
    const graph = graphOver(brain);
    const memory = await manager({ brain, knowledgeGraph: graph });
    const told = await tell(memory);
    expect(await copiesIn(graph)).toEqual([expect.objectContaining({ id: `trace:${told.id}`, traceId: told.id })]);

    await memory.getStore().store({ ...memory.getStore().getTrace(told.id)!, content: "Ana's sister is Vera Lopes." });

    expect(await copiesIn(graph)).toEqual([
      { id: `trace:${told.id}`, traceId: told.id, scopeId: 'ana', text: "Ana's sister is Vera Lopes." },
    ]);
  });

  it('deletes a relation the host made to a trace\'s copy with the copy, by trace id and by scope, and keeps the entity it named', async () => {
    const brain = await openBrain(brainFile());
    const graph = graphOver(brain);
    const memory = await manager({ brain, knowledgeGraph: graph });
    const bees = await graph.upsertEntity({ type: 'concept', label: 'bees', properties: {}, confidence: 1, source: HOST_SOURCE });
    const kept = await tellAbout(memory, 'ana', 'Ana keeps bees on the roof.');
    const sold = await tellAbout(memory, 'ana', 'Ana sells honey from her bees.');
    await relate(graph, `trace:${kept.id}`, bees.id);
    await relate(graph, `trace:${sold.id}`, bees.id);
    expect(await graph.getRelations(bees.id)).toHaveLength(2);

    await memory.deleteTraces([kept.id]);
    expect((await graph.getRelations(bees.id)).map((relation) => relation.sourceId)).toEqual([`trace:${sold.id}`]);
    await memory.deleteScope('user', 'ana');

    expect(await graph.getRelations(bees.id)).toEqual([]);
    expect(await graph.getRelations(`trace:${sold.id}`)).toEqual([]);
    expect(await graph.getEntity(bees.id)).toMatchObject({ label: 'bees' });
  });
});

describe('deleting memory for good, with a Brain file', () => {
  it('reports a knowledge graph without deleteMemories as not reached, and deletes the traces all the same', async () => {
    const brain = await openBrain(brainFile());
    // A host's own graph, written before the method existed.
    const graph = new KnowledgeGraph() as IKnowledgeGraph & { deleteMemories?: unknown };
    graph.deleteMemories = undefined;
    const memory = await manager({ brain, knowledgeGraph: graph });
    await tell(memory);

    expect(await memory.deleteScope('user', 'ana')).toEqual({ deleted: 1, graph: 'not_supported' });
    expect(await memory.getStore().getByScope('user', 'ana')).toEqual([]);
    expect(await traceRowIds(brain)).toEqual([]);
  });

  it("deletes a trace the Memory facade gave feedback on and traces it ingested from a document: the feedback goes, and each chunk keeps its text and lets go of its trace", async () => {
    const file = brainFile();
    const firstBrain = await openBrain(file);
    const first = await manager({ brain: firstBrain });
    const walnuts = await tellAbout(first, 'ana', 'Ana is allergic to walnuts.');
    await stop(first, firstBrain);

    const notes = path.join(path.dirname(file), 'notes.txt');
    fs.writeFileSync(notes, 'Ana takes the night train to Lyon every spring. '.repeat(30), 'utf8');
    const facade = await Memory.createSqlite(file, { brainId: 'qa', selfImprove: true });
    try {
      await facade.feedback(walnuts.id, 'used', 'What is Ana allergic to?');
      expect((await facade.ingest(notes)).tracesCreated).toBeGreaterThan(0);
    } finally {
      await facade.close();
    }

    const brain = await openBrain(file);
    const later = await manager({ brain });
    const chunks = await brain.all<{ id: string; trace_id: string | null; content: string }>(
      'SELECT id, trace_id, content FROM document_chunks WHERE brain_id = ? ORDER BY chunk_index',
      [brain.brainId],
    );
    const chunkTraceIds = chunks.map((chunk) => chunk.trace_id).filter((id): id is string => typeof id === 'string');
    expect(chunkTraceIds.length).toBeGreaterThan(0);
    expect(await brain.all('SELECT trace_id FROM retrieval_feedback WHERE brain_id = ?', [brain.brainId])).toEqual([
      { trace_id: walnuts.id },
    ]);

    expect(await later.deleteScope('user', 'ana')).toEqual({ deleted: 1, graph: 'reached' });
    expect(await later.deleteTraces(chunkTraceIds)).toEqual({ deleted: chunkTraceIds.length, graph: 'reached' });

    expect(await brain.all('SELECT trace_id FROM retrieval_feedback WHERE brain_id = ?', [brain.brainId])).toEqual([]);
    expect(
      await brain.all('SELECT id, trace_id, content FROM document_chunks WHERE brain_id = ? ORDER BY chunk_index', [brain.brainId]),
    ).toEqual(chunks.map((chunk) => ({ ...chunk, trace_id: null })));
    expect(await traceRowIds(brain)).toEqual([]);
  });

  it("removes each deleted trace's original from the host's archive and the typed facts extracted from it at encode, and keeps another scope's", async () => {
    const { archive, held } = hostArchive();
    const brain = await openBrain(brainFile());
    const memory = await manager({
      brain,
      config: {
        archive,
        typedNetwork: {
          variant: 'minimal',
          extractAtEncode: true,
          observerLLM: { invoke: async () => JSON.stringify({ facts: [{ text: 'The user told the agent something.', bank: 'WORLD' }] }) },
        },
      },
    });
    const ana = await tell(memory);
    const bo = await tellAbout(memory, 'bo', 'Bo plays the cello.');
    for (const trace of [ana, bo]) await archive.store(originalOf(trace));
    const facts = memory.getTypedNetworkStore()!;
    expect(await memory.rehydrate(ana.id)).toBe("Ana's sister is Vera.");
    expect(facts.getFact(`${ana.id}-fact-0`)).toBeDefined();

    await memory.deleteScope('user', 'ana');

    expect(await memory.rehydrate(ana.id)).toBeNull();
    expect([...held.keys()]).toEqual([bo.id]);
    expect(await memory.rehydrate(bo.id)).toBe('Bo plays the cello.');
    expect(facts.getFact(`${ana.id}-fact-0`)).toBeUndefined();
    expect(facts.getFact(`${bo.id}-fact-0`)).toBeDefined();
  });

  it("leaves another manager on the same Brain the deleted trace's place and none of its words", async () => {
    const brain = await openBrain(brainFile());
    const deleting = await manager({ brain });
    const other = await manager({ brain });
    const told = await tell(deleting);
    expect((await recall(other)).retrieved.map((hit) => hit.content)).toEqual(["Ana's sister is Vera."]);

    expect(await deleting.deleteTraces([told.id])).toEqual({ deleted: 1, graph: 'reached' });

    for (const store of [deleting.getStore(), other.getStore()]) {
      expect(store.getTrace(told.id)).toMatchObject({ id: told.id, scope: 'user', scopeId: 'ana', content: '', entities: [], tags: [], isActive: false });
      expect(store.listTraces({ scopeId: 'ana' }).map((trace) => trace.content)).toEqual(['']);
    }
    expect((await recall(other)).retrieved).toEqual([]);
  });

  it('a session view of the manager deletes as the manager does', async () => {
    const brain = await openBrain(brainFile());
    const memory = await manager({ brain });
    const view: ICognitiveMemoryManager = memory.forSession();
    const told = await tellAbout(view, 'ana', "Ana's sister is Vera.");
    await tellAbout(view, 'ana', 'Ana keeps bees on the roof.');

    expect(await view.deleteTraces?.([told.id])).toEqual({ deleted: 1, graph: 'reached' });
    expect(await view.deleteScope?.('user', 'ana')).toEqual({ deleted: 1, graph: 'reached' });
    expect(await traceRowIds(brain)).toEqual([]);
  });

  it('deletes a row an older release wrote with no scope_id, by the scope id its metadata names', async () => {
    const brain = await openBrain(brainFile());
    const first = await manager({ brain });
    const told = await tell(first);
    await stop(first);
    // A release older than the column, writing to this open brain, leaves scope_id empty.
    await brain.run("UPDATE memory_traces SET scope_id = '' WHERE brain_id = ? AND id = ?", [brain.brainId, told.id]);

    const later = await manager({ brain });
    expect(await later.deleteScope('user', 'ana')).toEqual({ deleted: 1, graph: 'reached' });
    expect(await traceRowIds(brain)).toEqual([]);
  });

  it("names its results and options in the types a host imports from the package root", () => {
    expectTypeOf<MemoryDeletion>().toEqualTypeOf<{ deleted: number; graph: 'reached' | 'not_supported' }>();
    expectTypeOf<Awaited<ReturnType<NonNullable<ICognitiveMemoryManager['deleteTraces']>>>>().toEqualTypeOf<MemoryDeletion>();
    expectTypeOf<Parameters<NonNullable<ICognitiveMemoryManager['deleteTraces']>>[0]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Awaited<ReturnType<NonNullable<ICognitiveMemoryManager['deleteScope']>>>>().toEqualTypeOf<MemoryDeletion>();
    expectTypeOf<Parameters<NonNullable<IKnowledgeGraph['deleteMemories']>>[0]>().toEqualTypeOf<MemoryCopyFilter>();
    expectTypeOf<MemoryCopyFilter>().toEqualTypeOf<{
      traceIds?: readonly string[];
      scopes?: ReadonlyArray<{ scope: string; scopeId: string }>;
    }>();
  });
});

describe('deleting memory for good, with a Brain file and SqlKnowledgeGraph', () => {
  it('deletes, through a graph started later, a copy an older release recorded under a node id of its own', async () => {
    const file = brainFile();
    const firstBrain = await openBrain(file);
    const first = await manager({ brain: firstBrain, knowledgeGraph: new SqlKnowledgeGraph(firstBrain) });
    const told = await tell(first);
    // An older release recorded the copy under a random node id.
    await firstBrain.run('UPDATE knowledge_nodes SET id = ? WHERE brain_id = ? AND id = ?', [
      'older-copy-1',
      firstBrain.brainId,
      `trace:${told.id}`,
    ]);
    await stop(first, firstBrain);

    const brain = await openBrain(file);
    const graph = new SqlKnowledgeGraph(brain);
    const later = await manager({ brain, knowledgeGraph: graph });
    expect(await copiesIn(graph)).toEqual([expect.objectContaining({ id: 'older-copy-1', traceId: told.id })]);

    expect(await later.deleteTraces([told.id])).toEqual({ deleted: 1, graph: 'reached' });
    expect(await copiesIn(graph)).toEqual([]);
  });

  it('finds the copies filed under a scope id by its exact text, whatever it holds: a quote, a backslash, % or _, or another letter case', async () => {
    const brain = await openBrain(brainFile());
    const graph = new SqlKnowledgeGraph(brain);
    const memory = await manager({ brain, knowledgeGraph: graph });
    const scopeIds = ["o'hara", 'o"neil', 'CORP\\ana', '100%', 'a_b', 'axb', 'Ana', 'ana'];
    for (const [n, scopeId] of scopeIds.entries()) await graph.recordMemory(leftoverCopy(`gone-${n}`, scopeId, `Copy ${n}.`));

    for (const scopeId of ["o'hara", 'o"neil', 'CORP\\ana', '100%', 'a_b', 'ana']) {
      expect(await memory.deleteScope('user', scopeId)).toEqual({ deleted: 0, graph: 'reached' });
    }

    expect((await copiesIn(graph)).map((copy) => copy.scopeId).sort()).toEqual(['Ana', 'axb']);
  });

  it("keeps each brain's copies apart: a delete on one brain leaves another brain's traces and copies in the same file", async () => {
    const file = brainFile();
    const mine = await openBrain(file);
    const theirs = await Brain.openSqlite(file, { brainId: 'qa-other' });
    brains.add(theirs);
    const myGraph = new SqlKnowledgeGraph(mine);
    const theirGraph = new SqlKnowledgeGraph(theirs);
    const me = await manager({ brain: mine, knowledgeGraph: myGraph });
    const them = await manager({ brain: theirs, knowledgeGraph: theirGraph });
    await tell(me);
    const theirTrace = await tell(them);
    expect(await fullTextHits(mine, 'Vera')).toBe(2);

    expect(await me.deleteScope('user', 'ana')).toEqual({ deleted: 1, graph: 'reached' });

    expect(await copiesIn(myGraph)).toEqual([]);
    expect((await copiesIn(theirGraph)).map((copy) => copy.traceId)).toEqual([theirTrace.id]);
    expect(await traceRowIds(theirs)).toEqual([theirTrace.id]);
    // The full-text index is the file's: the other brain's words stay findable.
    expect(await fullTextHits(mine, 'Vera')).toBe(1);
  });
});

describe('deleting memory for good, with no Brain', () => {
  it("a manager started later over the same index deletes a scope's traces another store filed, which deleteTraces alone does not reach; another scope's stay", async () => {
    const index = await vectorIndex(768);
    const first = await manager({ index, dimension: 768 });
    const bees = await tellAbout(first, 'ana', 'Ana keeps bees on the roof.');
    await tellAbout(first, 'ana', 'Ana is allergic to walnuts.');
    await tellAbout(first, 'ana', 'Ana lives in Lyon.');
    const cello = await tellAbout(first, 'bo', 'Bo plays the cello.');
    await stop(first);

    const later = await manager({ index, dimension: 768 });
    // An id alone names no collection: a trace this store never loaded is reached through its scope.
    expect(await later.deleteTraces([bees.id])).toEqual({ deleted: 0, graph: 'reached' });
    expect(await later.deleteScope('user', 'ana')).toEqual({ deleted: 3, graph: 'reached' });

    expect(await later.getStore().getByScope('user', 'ana')).toEqual([]);
    expect((await recall(later)).retrieved).toEqual([]);
    expect((await later.getStore().getByScope('user', 'bo')).map((trace) => trace.id)).toEqual([cello.id]);
    expect(await later.deleteScope('user', 'ana')).toEqual({ deleted: 0, graph: 'reached' });

    const restarted = await manager({ index, dimension: 768 });
    expect(await restarted.getStore().getByScope('user', 'ana')).toEqual([]);
  });
});

describe.skipIf(!POSTGRES_URL)('deleting memory for good, with a Postgres Brain', () => {
  it('deletes a trace the Memory facade gave feedback on, with the feedback and its copy, and finds the copies of a scope id that holds a quote', async () => {
    const brainId = `qa-delete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const brain = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    brains.add(brain);
    try {
      const graph = new SqlKnowledgeGraph(brain);
      const memory = await manager({ brain, knowledgeGraph: graph });
      const walnuts = await tellAbout(memory, 'ana', 'Ana is allergic to walnuts.');
      await tellAbout(memory, "o'hara", "O'Hara keeps bees.");
      await graph.recordMemory(leftoverCopy('gone-1', "o'hara", "O'Hara sold honey."));
      const facade = await Memory.createPostgres(POSTGRES_URL!, { brainId, selfImprove: true });
      try {
        await facade.feedback(walnuts.id, 'used', 'What is Ana allergic to?');
      } finally {
        await facade.close();
      }
      expect(await brain.all('SELECT trace_id FROM retrieval_feedback WHERE brain_id = ?', [brainId])).toEqual([{ trace_id: walnuts.id }]);

      expect(await memory.deleteScope('user', 'ana')).toEqual({ deleted: 1, graph: 'reached' });
      expect(await brain.all('SELECT trace_id FROM retrieval_feedback WHERE brain_id = ?', [brainId])).toEqual([]);
      expect((await copiesIn(graph)).map((copy) => copy.scopeId)).toEqual(["o'hara", "o'hara"]);

      expect(await memory.deleteScope('user', "o'hara")).toEqual({ deleted: 1, graph: 'reached' });
      expect(await copiesIn(graph)).toEqual([]);
      expect(await traceRowIds(brain)).toEqual([]);
    } finally {
      const cleaner = await Brain.openPostgres(POSTGRES_URL!, { brainId });
      for (const table of ['knowledge_edges', 'knowledge_nodes', 'retrieval_feedback', 'memory_traces']) {
        await cleaner.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brainId]);
      }
      await cleaner.close();
    }
  });
});

describe("gmi(): memory.persistAccessState", () => {
  let keys = 0;
  const key = () => `k-qa-scopes-${++keys}`;

  it('false reaches the memory manager the agent builds, unset leaves the default, and a session with false still recalls what it was told', async () => {
    const built = vi.spyOn(CognitiveMemoryManager.prototype, 'initialize');
    const embeddingKey = key();
    script('openai', embeddingKey, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', embeddingKey);
    const embedding = { provider: 'openai', model: 'text-embedding-3-small' };

    const offKey = key();
    const chat = script('openai', offKey, { replies: [reply.text('Noted.'), reply.text('It is in the vault.')] });
    const off = agent({
      runtime: 'gmi',
      provider: 'openai',
      model: 'stub-model',
      apiKey: offKey,
      fallbackProviders: [],
      cognition: 'full',
      memory: { embedding, persistAccessState: false },
    });
    const session = off.session('s');
    await session.send('The deploy key lives in the vault under ops/deploy.');
    session.clear();
    await session.send('Where does the deploy key live?');
    // The cleared history cannot carry it: the fact reaches the prompt through recall.
    expect(JSON.stringify(chat.seen[1]?.messages)).toContain('vault');
    const offConfigs = built.mock.calls.map(([config]) => config);
    expect(offConfigs.length).toBeGreaterThan(0);
    for (const config of offConfigs) expect(config).toMatchObject({ persistAccessState: false });
    await off.close();

    const onKey = key();
    script('openai', onKey, { replies: [reply.text('Hi.')] });
    const on = agent({
      runtime: 'gmi',
      provider: 'openai',
      model: 'stub-model',
      apiKey: onKey,
      fallbackProviders: [],
      cognition: 'full',
      memory: { embedding },
    });
    await on.session('t').send('hi');
    const onConfigs = built.mock.calls.slice(offConfigs.length).map(([config]) => config);
    expect(onConfigs.length).toBeGreaterThan(0);
    for (const config of onConfigs) expect(config).not.toHaveProperty('persistAccessState');
    await on.close();
  });
});

describe('the docs a host reads about it', () => {
  /** A file of the package, by its path from the package root. */
  const doc = (relative: string) => fs.readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8');

  it('describe persistAccessState and the decay object where a host reads about memory', () => {
    const cognitive = doc('docs/memory/COGNITIVE_MEMORY.md');
    expect(cognitive).toMatch(/^#+ Access state across restarts$/m);
    expect(cognitive).toMatch(/persistAccessState\?: boolean;.*Default: true/);
    expect(doc('docs/memory/MEMORY_STORAGE.md')).toContain('metadata.decay');
    expect(doc('docs/GMI.md')).toContain('memory.persistAccessState');
    expect(doc('docs/getting-started/HIGH_LEVEL_API.md')).toMatch(/this path reads [^.]*`persistAccessState`/);
  });
});
