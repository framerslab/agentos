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
 *
 * One scope at a time. The manager's store (`getStore()`) loads a returning user's older traces that the brain's
 * 1,000 most recent leave out (`hydrateScope`), and moves one scope id's traces to another in the Brain, the store,
 * recall and the knowledge graph's copies (`refileScope`), over a durable vector index with no Brain too. A trace a
 * second user files on another user's session carries that user's id (`turnUserId`), which `deleteScope` takes as a
 * filter. The `Memory` facade deletes by scope and by trace, and restores a trace from a snapshot a host reads with
 * `readTraceSnapshot` (the package's `cognition/memory/retrieval/store/tracePersistence` path).
 *
 * The written form of a plain id. Where a learning layer exists, a plain `user` or `persona` id that holds a `/`, a `%`
 * or a `:` is written percent-encoded (the rule of the package's `cognition/memory/retrieval/store/scopeIdForm` path),
 * and the first time a layer opens a Brain, `ensureEncodedScopeIds` on the manager or the `Memory` facade re-files the
 * Brain's plain ids to that form once, with the knowledge graph's copies, and records it in `brain_meta`. Every store
 * on the Brain follows the move: in this process when it commits, and after another process's re-file (a child Node
 * process that loads the built package, as a host's second process does) when the layer opens it; until then no read
 * returns a moved trace under the plain id, which from then on names a namespaced learner.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
// The stub replaces the provider class alone: the package root also reads the module's other exports (its base URL).
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
  type RememberOptions,
} from '@framers/agentos';
import { readTraceSnapshot, type TraceSnapshot } from '@framers/agentos/cognition/memory/retrieval/store/tracePersistence';
import {
  ENCODED_SCOPE_ID_FORM,
  SCOPE_ID_FORM_KEY,
  encodePlainId,
  encodePlainScopeId,
  encodeScopeIdPart,
  holdsReservedCharacter,
  refileBrainScopeIds,
  type BrainRefileResult,
  type ScopeIdRefile,
} from '@framers/agentos/cognition/memory/retrieval/store/scopeIdForm';
import { reply, script } from './helpers/stubProviders';

/** The embedding size of a common hosted model. Every text embeds as one direction, so a recall finds every trace of its scope. */
const DIMENSION = 1536;
const NEUTRAL: PADState = { valence: 0, arousal: 0, dominance: 0 };
const ONE_HOUR = 3_600_000;
const TWO_HOURS = 7_200_000;
const FOUR_HOURS = 14_400_000;

let serial = 0;
const managers: CognitiveMemoryManager[] = [];
const facades: Memory[] = [];
const brains = new Set<Brain>();
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const manager of managers.splice(0)) await manager.shutdown().catch(() => undefined);
  for (const facade of facades.splice(0)) await facade.close().catch(() => undefined);
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

/** Two traces under the scope id `42` and one under `7`, told to a manager. */
async function tellThree(memory: CognitiveMemoryManager): Promise<{ bees: MemoryTrace; walnuts: MemoryTrace; cello: MemoryTrace }> {
  const bees = await tellAbout(memory, '42', 'Ana keeps bees on the roof.');
  const walnuts = await tellAbout(memory, '42', 'Ana is allergic to walnuts.');
  const cello = await tellAbout(memory, '7', 'Bo plays the cello.');
  return { bees, walnuts, cello };
}

/** A recall of one scope id's traces. Every text embeds as one direction, so it finds every trace of the scope. */
const recallUnder = (memory: CognitiveMemoryManager, scopeId: string) =>
  memory.retrieve('What do you know about them?', NEUTRAL, { scopes: [{ scope: 'user', scopeId }] });

/** The ids of traces, sorted. */
const idsOf = (traces: ReadonlyArray<{ id: string }>) => traces.map((trace) => trace.id).sort();

/** A trace row's scope id, and whether it is soft-deleted. */
async function filingOf(brain: Brain, id: string): Promise<{ scopeId: string; deleted: number } | undefined> {
  const row = await brain.get<{ scope_id: string; deleted: number }>(
    'SELECT scope_id, deleted FROM memory_traces WHERE brain_id = ? AND id = ?',
    [brain.brainId, id],
  );
  return row ? { scopeId: row.scope_id, deleted: Number(row.deleted) } : undefined;
}

/** A host's vector index that runs `before`, with the ids the call names, ahead of each call of one of its methods. */
function hookedIndex(
  index: InMemoryVectorStore,
  method: 'upsert' | 'delete',
  before: (collection: string, ids: string[]) => Promise<void>,
): InMemoryVectorStore {
  return new Proxy(index, {
    get(target, property) {
      if (property === method) {
        return async (collection: string, items: Array<string | { id: string }> | undefined, ...rest: unknown[]) => {
          await before(collection, (items ?? []).map((item) => (typeof item === 'string' ? item : item.id)));
          return (Reflect.get(target, property, target) as (...args: unknown[]) => unknown).call(target, collection, items, ...rest);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('one scope at a time, with a Brain file', () => {
  it("hydrateScope loads a returning user's older trace that the brain's 1,000 most recent leave out, and a call made again loads none", async () => {
    const file = brainFile();
    const firstBrain = await openBrain(file);
    const first = await manager({ brain: firstBrain, dimension: 8 });
    const told = await tellAbout(first, 'ana', "Ana's sister is Vera.");
    await stop(first, firstBrain);

    const brain = await openBrain(file);
    // Other users' traces since: 1,200 rows newer than Ana's.
    const blob = Buffer.from(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]).buffer);
    const since = Date.now() + 1_000;
    await brain.transaction(async (trx) => {
      for (let n = 0; n < 1_200; n += 1) {
        await trx.run(
          `INSERT INTO memory_traces (brain_id, id, type, scope, content, embedding, created_at, metadata, scope_id)
           VALUES (?, ?, 'episodic', 'user', ?, ?, ?, ?, ?)`,
          [brain.brainId, `other-${n}`, `Note ${n}.`, blob, since + n, JSON.stringify({ scopeId: `u-${n}` }), `u-${n}`],
        );
      }
    });

    const later = await manager({ brain, dimension: 8 });
    expect(await later.getStore().getByScope('user', 'ana')).toEqual([]);
    expect((await recall(later)).retrieved).toEqual([]);

    expect(await later.getStore().hydrateScope('user', 'ana')).toBe(1);

    expect(idsOf(await later.getStore().getByScope('user', 'ana'))).toEqual([told.id]);
    expect((await recall(later)).retrieved.map((hit) => hit.content)).toEqual(["Ana's sister is Vera."]);
    expect(await later.getStore().hydrateScope('user', 'ana')).toBe(0);
  });

  it('hydrateScope refuses a limit that is not a positive integer', async () => {
    const brain = await openBrain(brainFile());
    const memory = await manager({ brain });
    await tell(memory);
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(memory.getStore().hydrateScope('user', 'ana', limit)).rejects.toThrow(RangeError);
    }
  });

  it("refileScope moves a scope id's traces to another in the Brain rows, the store, recall and the graph copies; another scope's stay, and a manager over the reopened file finds them under the new id", async () => {
    const file = brainFile();
    const brain = await openBrain(file);
    const graph = new SqlKnowledgeGraph(brain);
    const memory = await manager({ brain, knowledgeGraph: graph });
    const { bees, walnuts, cello } = await tellThree(memory);

    expect(await memory.getStore().refileScope('user', '42', 'A/42')).toBe(2);

    const rows = await brain.all<{ id: string; scope_id: string; metadata: string }>(
      'SELECT id, scope_id, metadata FROM memory_traces WHERE brain_id = ?',
      [brain.brainId],
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, [row.scope_id, JSON.parse(row.metadata).scopeId]]))).toEqual({
      [bees.id]: ['A/42', 'A/42'],
      [walnuts.id]: ['A/42', 'A/42'],
      [cello.id]: ['7', '7'],
    });
    expect(idsOf(await memory.getStore().getByScope('user', 'A/42'))).toEqual(idsOf([bees, walnuts]));
    expect(await memory.getStore().getByScope('user', '42')).toEqual([]);
    expect(idsOf((await recallUnder(memory, 'A/42')).retrieved)).toEqual(idsOf([bees, walnuts]));
    expect((await recallUnder(memory, '42')).retrieved).toEqual([]);
    expect((await copiesIn(graph)).map((copy) => [copy.traceId, copy.scopeId])).toEqual([
      [walnuts.id, 'A/42'],
      [bees.id, 'A/42'],
      [cello.id, '7'],
    ]);
    await stop(memory, brain);

    const reopened = await openBrain(file);
    const later = await manager({ brain: reopened, knowledgeGraph: new SqlKnowledgeGraph(reopened) });
    expect(idsOf(await later.getStore().getByScope('user', 'A/42'))).toEqual(idsOf([bees, walnuts]));
    expect(await later.getStore().getByScope('user', '42')).toEqual([]);
    expect(idsOf((await recallUnder(later, 'A/42')).retrieved)).toEqual(idsOf([bees, walnuts]));
    expect(idsOf((await recallUnder(later, '7')).retrieved)).toEqual([cello.id]);
  });

  it('refileScope moves a soft-deleted row too, so a delete of the new id takes its words', async () => {
    const brain = await openBrain(brainFile());
    const memory = await manager({ brain });
    const kept = await tellAbout(memory, '42', 'Ana keeps bees on the roof.');
    const superseded = await tellAbout(memory, '42', 'Ana lives in Lyon.');
    await memory.getStore().softDelete(superseded.id);

    expect(await memory.getStore().refileScope('user', '42', 'A/42')).toBe(2);

    expect(await filingOf(brain, kept.id)).toEqual({ scopeId: 'A/42', deleted: 0 });
    expect(await filingOf(brain, superseded.id)).toEqual({ scopeId: 'A/42', deleted: 1 });
    expect(await memory.deleteScope('user', '42')).toEqual({ deleted: 0, graph: 'reached' });
    expect(await memory.deleteScope('user', 'A/42')).toEqual({ deleted: 2, graph: 'reached' });
    expect(await traceRowIds(brain)).toEqual([]);
  });

  it('refileScope refuses an empty scope id on either side, and moves nothing', async () => {
    const brain = await openBrain(brainFile());
    const memory = await manager({ brain });
    const told = await tellAbout(memory, '42', 'Ana keeps bees on the roof.');

    await expect(memory.getStore().refileScope('user', '', 'A/42')).rejects.toThrow(TypeError);
    await expect(memory.getStore().refileScope('user', '42', '')).rejects.toThrow(TypeError);

    expect(await filingOf(brain, told.id)).toEqual({ scopeId: '42', deleted: 0 });
    expect(idsOf(await memory.getStore().getByScope('user', '42'))).toEqual([told.id]);
  });

  it('refileScope keeps a write another writer makes to a row while the move is under way', async () => {
    const brain = await openBrain(brainFile());
    let armed = false;
    // Another writer (a Memory facade's recall, another process) changes the row while the move writes the vector.
    const index = hookedIndex(await vectorIndex(), 'upsert', async (_collection, ids) => {
      if (!armed) return;
      armed = false;
      await brain.run(
        "UPDATE memory_traces SET metadata = json_set(metadata, '$.recalledBy', 'facade') WHERE brain_id = ? AND id = ?",
        [brain.brainId, ids[0]],
      );
    });
    const memory = await manager({ brain, index });
    const told = await tellAbout(memory, '42', 'Ana keeps bees on the roof.');

    armed = true;
    expect(await memory.getStore().refileScope('user', '42', 'A/42')).toBe(1);

    expect(armed).toBe(false);
    expect(await metadataOf(brain, told.id)).toMatchObject({ scopeId: 'A/42', recalledBy: 'facade' });
    expect(await filingOf(brain, told.id)).toEqual({ scopeId: 'A/42', deleted: 0 });
  });

  it('refileScope leaves a document the index fails to delete in the old collection, with a warning, and recall under the old id does not return its trace', async () => {
    const brain = await openBrain(brainFile());
    let failing = false;
    const index = hookedIndex(await vectorIndex(), 'delete', async () => {
      if (failing) throw new Error('the index is unavailable');
    });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const memory = await manager({ brain, index });
    const told = await tellAbout(memory, '42', 'Ana keeps bees on the roof.');

    failing = true;
    expect(await memory.getStore().refileScope('user', '42', 'A/42')).toBe(1);
    failing = false;

    expect(warned.mock.calls.some(([line]) => String(line).includes('refileScope could not delete'))).toBe(true);
    expect(await memory.getStore().getByScope('user', '42')).toEqual([]);
    expect((await recallUnder(memory, '42')).retrieved).toEqual([]);
    expect(idsOf((await recallUnder(memory, 'A/42')).retrieved)).toEqual([told.id]);
  });
});

describe('one scope at a time, with no Brain', () => {
  it('refileScope on a manager started later over the same index moves the traces another store filed before the restart', async () => {
    const index = await vectorIndex(768);
    const first = await manager({ index, dimension: 768 });
    const { bees, walnuts, cello } = await tellThree(first);
    await stop(first);

    const later = await manager({ index, dimension: 768 });
    expect(await later.getStore().refileScope('user', '42', 'A/42')).toBe(2);

    expect(idsOf(await later.getStore().getByScope('user', 'A/42'))).toEqual(idsOf([bees, walnuts]));
    expect(await later.getStore().getByScope('user', '42')).toEqual([]);
    expect(idsOf((await recallUnder(later, 'A/42')).retrieved)).toEqual(idsOf([bees, walnuts]));

    const restarted = await manager({ index, dimension: 768 });
    expect(idsOf(await restarted.getStore().getByScope('user', 'A/42'))).toEqual(idsOf([bees, walnuts]));
    expect(await restarted.getStore().getByScope('user', '42')).toEqual([]);
    expect(idsOf(await restarted.getStore().getByScope('user', '7'))).toEqual([cello.id]);
  });

  it('refileScope moves the documents of traces a read loaded with no vector, so recall finds them under the new id alone', async () => {
    const index = await vectorIndex(768);
    const first = await manager({ index, dimension: 768 });
    const { bees, walnuts } = await tellThree(first);
    await stop(first);

    const later = await manager({ index, dimension: 768 });
    expect(idsOf(await later.getStore().getByScope('user', '42'))).toEqual(idsOf([bees, walnuts]));
    expect(await later.getStore().refileScope('user', '42', 'A/42')).toBe(2);

    expect(idsOf((await recallUnder(later, 'A/42')).retrieved)).toEqual(idsOf([bees, walnuts]));
    expect((await recallUnder(later, '42')).retrieved).toEqual([]);
    const restarted = await manager({ index, dimension: 768 });
    expect(await restarted.getStore().getByScope('user', '42')).toEqual([]);
    expect(idsOf(await restarted.getStore().getByScope('user', 'A/42'))).toEqual(idsOf([bees, walnuts]));
  });
});

describe("a second user's traces on another user's session", () => {
  /** What a second user, Bo, has the agent remember on the session `/s-1`. */
  const visit = (memory: Pick<ICognitiveMemoryManager, 'encode'>, text: string) =>
    memory.encode(text, NEUTRAL, 'neutral', { scope: 'user', scopeId: '/s-1', turnUserId: 'bo' });

  it("carry the second user's id across a restart and on a recalled trace, and deleteScope with it takes only that user's traces and copies", async () => {
    const file = brainFile();
    const firstBrain = await openBrain(file);
    const first = await manager({ brain: firstBrain, knowledgeGraph: new SqlKnowledgeGraph(firstBrain) });
    const owner = await tellAbout(first, '/s-1', 'The owner keeps bees on the roof.');
    const visitor = await visit(first, 'Bo keeps bees in the garden.');
    expect(visitor.turnUserId).toBe('bo');
    expect(owner.turnUserId).toBeUndefined();
    await stop(first, firstBrain);

    const brain = await openBrain(file);
    const graph = new SqlKnowledgeGraph(brain);
    const later = await manager({ brain, knowledgeGraph: graph });
    const loaded = await later.getStore().getByScope('user', '/s-1');
    expect(Object.fromEntries(loaded.map((trace) => [trace.id, trace.turnUserId ?? null]))).toEqual({
      [owner.id]: null,
      [visitor.id]: 'bo',
    });
    const recalled = (await recallUnder(later, '/s-1')).retrieved;
    expect(recalled.find((hit) => hit.id === visitor.id)?.turnUserId).toBe('bo');

    expect(await later.deleteScope('user', '/s-1', { turnUserId: 'bo' })).toEqual({ deleted: 1, graph: 'reached' });

    expect(await traceRowIds(brain)).toEqual([owner.id]);
    expect(idsOf(await later.getStore().getByScope('user', '/s-1'))).toEqual([owner.id]);
    expect((await copiesIn(graph)).map((copy) => copy.traceId)).toEqual([owner.id]);
  });

  it("with no Brain, a manager started later over the same index deletes that user's traces of the scope and keeps the owner's", async () => {
    const index = await vectorIndex(768);
    const first = await manager({ index, dimension: 768 });
    const owner = await tellAbout(first, '/s-1', 'The owner keeps bees on the roof.');
    await visit(first, 'Bo keeps bees in the garden.');
    await stop(first);

    const later = await manager({ index, dimension: 768 });
    expect(await later.deleteScope('user', '/s-1', { turnUserId: 'bo' })).toEqual({ deleted: 1, graph: 'reached' });

    const restarted = await manager({ index, dimension: 768 });
    expect(idsOf(await restarted.getStore().getByScope('user', '/s-1'))).toEqual([owner.id]);
  });

  it('deleteScope refuses an empty scope id and an empty turnUserId, and deletes nothing', async () => {
    const brain = await openBrain(brainFile());
    const memory = await manager({ brain });
    const owner = await tellAbout(memory, '/s-1', 'The owner keeps bees on the roof.');
    const visitor = await visit(memory, 'Bo keeps bees in the garden.');

    await expect(memory.deleteScope('user', '')).rejects.toThrow(TypeError);
    await expect(memory.deleteScope('user', '/s-1', { turnUserId: '' })).rejects.toThrow(TypeError);

    expect(await traceRowIds(brain)).toEqual([owner.id, visitor.id].sort());
  });
});

describe('the Memory facade deletes and restores by scope and by trace', () => {
  /** The facade a host opens on a Brain file, with the brain id the file's other handles use. */
  async function facadeOn(file: string, config: Parameters<typeof Memory.createSqlite>[1] = {}): Promise<Memory> {
    const facade = await Memory.createSqlite(file, { brainId: 'qa', ...config });
    facades.push(facade);
    return facade;
  }

  it("deleteScope deletes a scope's traces for good: recall finds none of them, another scope's stays, and a call made again counts none", async () => {
    const file = brainFile();
    const memory = await facadeOn(file);
    expect(memory.brainId).toBe('qa');
    const bees = await memory.remember('Ana keeps bees on the roof.', { scope: 'user', scopeId: 'ana' });
    const tea = await memory.remember('Ana likes green tea.', { scope: 'user', scopeId: 'ana' });
    const cello = await memory.remember('Bo plays the cello.', { scope: 'user', scopeId: 'bo' });
    expect((await memory.recall('bees')).map((hit) => hit.trace.id)).toEqual([bees.id]);
    expect((await memory.recall('tea')).map((hit) => hit.trace.id)).toEqual([tea.id]);

    expect(await memory.deleteScope('user', 'ana')).toEqual({ deleted: 2 });

    expect(await memory.recall('bees')).toEqual([]);
    expect(await memory.recall('tea')).toEqual([]);
    expect((await memory.recall('cello')).map((hit) => hit.trace.id)).toEqual([cello.id]);
    expect(await traceRowIds(await openBrain(file))).toEqual([cello.id]);
    expect(await memory.deleteScope('user', 'ana')).toEqual({ deleted: 0 });
  });

  it("files a second user's words as a trace of their own, and deleteScope with turnUserId takes only that user's", async () => {
    const memory = await facadeOn(brainFile());
    const owner = await memory.remember('We meet at noon on Friday.', { scope: 'user', scopeId: '/s-1' });
    const visitor = await memory.remember('We meet at noon on Friday.', {
      scope: 'user',
      scopeId: '/s-1',
      metadata: { turnUserId: 'bo' },
    });
    expect(visitor.id).not.toBe(owner.id);
    expect(visitor.turnUserId).toBe('bo');
    expect(owner.turnUserId).toBeUndefined();
    expect(idsOf((await memory.recall('noon')).map((hit) => hit.trace))).toEqual(idsOf([owner, visitor]));

    expect(await memory.deleteScope('user', '/s-1', { turnUserId: 'bo' })).toEqual({ deleted: 1 });

    expect((await memory.recall('noon')).map((hit) => hit.trace.id)).toEqual([owner.id]);
  });

  it("remember stores a host's extra metadata keys, and the facade's own keys win", async () => {
    const file = brainFile();
    const memory = await facadeOn(file);
    const told = await memory.remember('Ana keeps bees on the roof.', {
      scope: 'user',
      scopeId: 'ana',
      metadata: { source: 'crm', scopeId: 'someone-else' },
    });

    const brain = await openBrain(file);
    expect(await metadataOf(brain, told.id)).toMatchObject({ source: 'crm', scopeId: 'ana' });
    expect(await filingOf(brain, told.id)).toEqual({ scopeId: 'ana', deleted: 0 });
  });

  it('deleteTraces deletes the named traces, skips an id it holds no trace of, and a call made again counts none', async () => {
    const memory = await facadeOn(brainFile());
    const kept = await memory.remember('Ana keeps bees on the roof.', { scope: 'user', scopeId: 'ana' });
    const gone = await memory.remember('Ana likes green tea.', { scope: 'user', scopeId: 'ana' });
    expect((await memory.recall('tea')).map((hit) => hit.trace.id)).toEqual([gone.id]);

    expect(await memory.deleteTraces([gone.id, 'no-such-id'])).toEqual({ deleted: 1 });
    expect(await memory.deleteTraces([gone.id])).toEqual({ deleted: 0 });

    expect(await memory.recall('tea')).toEqual([]);
    expect((await memory.recall('bees')).map((hit) => hit.trace.id)).toEqual([kept.id]);
  });

  it('deletes a trace it gave feedback on and the traces it ingested from a document: the feedback goes, and each chunk keeps its text and lets go of its trace', async () => {
    const file = brainFile();
    const memory = await facadeOn(file, { selfImprove: true });
    const walnuts = await memory.remember('Ana is allergic to walnuts.', { scope: 'user', scopeId: 'ana' });
    await memory.feedback(walnuts.id, 'used', 'What is Ana allergic to?');
    const notes = path.join(path.dirname(file), 'notes.txt');
    fs.writeFileSync(notes, 'Ana takes the night train to Lyon every spring. '.repeat(30), 'utf8');
    expect((await memory.ingest(notes)).tracesCreated).toBeGreaterThan(0);

    const brain = await openBrain(file);
    const chunks = await brain.all<{ id: string; trace_id: string | null; content: string }>(
      'SELECT id, trace_id, content FROM document_chunks WHERE brain_id = ? ORDER BY chunk_index',
      [brain.brainId],
    );
    const chunkTraceIds = chunks.map((chunk) => chunk.trace_id).filter((id): id is string => typeof id === 'string');
    expect(chunkTraceIds.length).toBeGreaterThan(0);
    expect(await brain.all('SELECT trace_id FROM retrieval_feedback WHERE brain_id = ?', [brain.brainId])).toEqual([
      { trace_id: walnuts.id },
    ]);

    expect(await memory.deleteTraces([walnuts.id, ...chunkTraceIds])).toEqual({ deleted: 1 + chunkTraceIds.length });

    expect(await brain.all('SELECT trace_id FROM retrieval_feedback WHERE brain_id = ?', [brain.brainId])).toEqual([]);
    expect(
      await brain.all('SELECT id, trace_id, content FROM document_chunks WHERE brain_id = ? ORDER BY chunk_index', [brain.brainId]),
    ).toEqual(chunks.map((chunk) => ({ ...chunk, trace_id: null })));
    expect(await traceRowIds(brain)).toEqual([]);
  });

  it('deleteScope deletes a row an older release wrote after the facade opened, with no scope_id and the scope id in its metadata', async () => {
    const file = brainFile();
    const memory = await facadeOn(file);
    await memory.remember('Ana keeps bees on the roof.', { scope: 'user', scopeId: 'ana' });
    const older = await memory.remember('Ana likes green tea.', { scope: 'user', scopeId: 'ana' });
    const brain = await openBrain(file);
    // A release older than the column, writing to the open brain, leaves scope_id empty.
    await brain.run("UPDATE memory_traces SET scope_id = '' WHERE brain_id = ? AND id = ?", [brain.brainId, older.id]);

    expect(await memory.deleteScope('user', 'ana')).toEqual({ deleted: 2 });

    expect(await traceRowIds(brain)).toEqual([]);
  });

  it('deleteScope refuses an empty scope id and an empty turnUserId, and deletes nothing', async () => {
    const file = brainFile();
    const memory = await facadeOn(file);
    await memory.remember('Ana keeps bees on the roof.', { scope: 'user', scopeId: 'ana' });
    await memory.remember('A note filed under no scope id.', { scope: 'user' });

    await expect(memory.deleteScope('user', '')).rejects.toThrow(TypeError);
    await expect(memory.deleteScope('user', 'ana', { turnUserId: '' })).rejects.toThrow(TypeError);

    expect(await traceRowIds(await openBrain(file))).toHaveLength(2);
  });

  it('restoreTrace brings back a trace a host changed and one it forgot from a snapshot read before, and refuses a snapshot of another trace', async () => {
    const file = brainFile();
    const memory = await facadeOn(file);
    const kept = await memory.remember('Ana keeps bees on the roof.', { scope: 'user', scopeId: 'ana' });
    const brain = await openBrain(file);
    const before = await readTraceSnapshot(brain, memory.brainId, kept.id);
    expect(before).toMatchObject({ id: kept.id, scope: 'user', scopeId: 'ana', content: 'Ana keeps bees on the roof.', deleted: 0 });

    await brain.run("UPDATE memory_traces SET content = 'changed', scope_id = 'x' WHERE brain_id = ? AND id = ?", [
      brain.brainId,
      kept.id,
    ]);
    await memory.restoreTrace(kept.id, before!);
    expect(await readTraceSnapshot(brain, memory.brainId, kept.id)).toEqual(before);
    expect((await memory.recall('bees')).map((hit) => hit.trace.id)).toEqual([kept.id]);

    await memory.forget(kept.id);
    expect(await memory.recall('bees')).toEqual([]);
    await memory.restoreTrace(kept.id, before!);
    expect((await memory.recall('bees')).map((hit) => hit.trace.id)).toEqual([kept.id]);

    await expect(memory.restoreTrace('other-id', before!)).rejects.toThrow(/snapshot of trace/);
  });

  it('a trace it forgot and then restored keeps its vector, so a memory manager over the file recalls it', async () => {
    const file = brainFile();
    const firstBrain = await openBrain(file);
    const first = await manager({ brain: firstBrain });
    const told = await tell(first);
    await stop(first, firstBrain);

    const memory = await facadeOn(file);
    const brain = await openBrain(file);
    const before = await readTraceSnapshot(brain, memory.brainId, told.id);
    await memory.forget(told.id);
    await memory.restoreTrace(told.id, before!);

    const later = await manager({ brain });
    expect((await recall(later)).retrieved.map((hit) => hit.id)).toEqual([told.id]);
  });

  it('names the second user, the scope calls and their results in the types a host imports from the package', () => {
    type Store = ReturnType<CognitiveMemoryManager['getStore']>;
    expectTypeOf<MemoryTrace['turnUserId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NonNullable<Parameters<ICognitiveMemoryManager['encode']>[3]>['turnUserId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Parameters<NonNullable<ICognitiveMemoryManager['deleteScope']>>[2]>().toEqualTypeOf<{ turnUserId?: string } | undefined>();
    expectTypeOf<Awaited<ReturnType<Store['hydrateScope']>>>().toEqualTypeOf<number>();
    expectTypeOf<Awaited<ReturnType<Store['refileScope']>>>().toEqualTypeOf<number>();
    expectTypeOf<NonNullable<RememberOptions['metadata']>>().toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf<Memory['brainId']>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<Memory['deleteScope']>[2]>().toEqualTypeOf<{ turnUserId?: string } | undefined>();
    expectTypeOf<Awaited<ReturnType<Memory['deleteScope']>>>().toEqualTypeOf<{ deleted: number }>();
    expectTypeOf<Awaited<ReturnType<Memory['deleteTraces']>>>().toEqualTypeOf<{ deleted: number }>();
    expectTypeOf<Parameters<Memory['restoreTrace']>[1]>().toEqualTypeOf<TraceSnapshot>();
  });
});

/** What the user tells the agent about Ana, in the cases on the written form of a plain id. */
const BEES = 'Ana keeps bees on the roof.';
const WALNUTS = 'Ana is allergic to walnuts.';

/** Each trace row of a brain, by trace id: its `scope_id` column and its metadata's `scopeId`. */
async function filedAs(brain: Brain): Promise<Record<string, [string, unknown]>> {
  const rows = await brain.all<{ id: string; scope_id: string; metadata: string | null }>(
    'SELECT id, scope_id, metadata FROM memory_traces WHERE brain_id = ?',
    [brain.brainId],
  );
  return Object.fromEntries(rows.map((row) => [row.id, [row.scope_id, JSON.parse(row.metadata ?? '{}').scopeId]]));
}

/** A `user` row another writer files straight into the Brain: the scope id in the column and in the metadata. */
async function fileRow(brain: Brain, id: string, scopeId: string, content: string): Promise<void> {
  await brain.run(
    `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata, scope_id)
     VALUES (?, ?, 'episodic', 'user', ?, ?, ?, ?)`,
    [brain.brainId, id, content, Date.now(), JSON.stringify({ scopeId }), scopeId],
  );
}

/** The texts a vector index holds in one collection, sorted: none when it holds no such collection. */
async function textsIn(index: InMemoryVectorStore, collection: string): Promise<string[]> {
  if (!(await index.collectionExists(collection))) return [];
  const scanned = await index.scanByMetadata(collection, { includeTextContent: true, limit: 1000 });
  return scanned.documents.map((document) => document.textContent ?? '').sort();
}

/** The `Memory` facade a host opens on a Brain file, under the brain id the file's other handles use. */
async function openFacade(file: string): Promise<Memory> {
  const facade = await Memory.createSqlite(file, { brainId: 'qa' });
  facades.push(facade);
  return facade;
}

/** The Brain as a host hands it to a manager, with one method in place of the Brain's own; every other member is the Brain's. */
function withMethod(brain: Brain, method: 'all' | 'transaction', replacement: (...args: never[]) => Promise<unknown>): Brain {
  return new Proxy(brain, {
    get(target, property) {
      if (property === method) return replacement;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * A Brain file's trace, filed by an earlier process into the Brain and into the vector index the host keeps across
 * restarts, whose row a release before rows kept their vectors wrote: no load brings it into a store, so a process
 * holds it only as the index's document.
 */
async function fileUnheldTrace(brain: Brain, index: InMemoryVectorStore, scopeId: string, text: string): Promise<MemoryTrace> {
  const earlier = await manager({ brain, index });
  const told = await tellAbout(earlier, scopeId, text);
  await stop(earlier);
  await brain.run('UPDATE memory_traces SET embedding = NULL WHERE brain_id = ? AND id = ?', [brain.brainId, told.id]);
  return told;
}

/** The package's root folder, from which a host's process imports `@framers/agentos`. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** The built memory module a host's second process loads; CI builds before it tests. */
const BUILT_MEMORY = path.join(PACKAGE_ROOT, 'dist', 'cognition', 'memory', 'index.js');
/** The other process prints its answer on a line of its own, after this mark. */
const OTHER_PROCESS_MARK = 'QA_OTHER_PROCESS ';
const runNode = promisify(execFile);

/**
 * Another process on the same Brain file: a plain Node process that loads the built package as a host does
 * (`@framers/agentos/cognition/memory`), opens the file through the `Memory` facade and re-files it, as a learning
 * layer that first opens that facade there does.
 *
 * @returns How many traces its re-file moved.
 */
async function refileInAnotherProcess(file: string): Promise<number> {
  const source = [
    "import { Memory } from '@framers/agentos/cognition/memory';",
    `const memory = await Memory.createSqlite(${JSON.stringify(file)}, { brainId: 'qa' });`,
    'const moved = await memory.ensureEncodedScopeIds();',
    'await memory.close();',
    `console.log(${JSON.stringify(OTHER_PROCESS_MARK)} + JSON.stringify({ moved }));`,
  ].join('\n');
  const { stdout } = await runNode(process.execPath, ['--input-type=module', '-e', source], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: undefined },
  });
  const line = stdout.split('\n').find((entry) => entry.startsWith(OTHER_PROCESS_MARK));
  if (!line) throw new Error(`no answer in the other process's output:\n${stdout}`);
  return (JSON.parse(line.slice(OTHER_PROCESS_MARK.length)) as { moved: number }).moved;
}

describe('the written form of a plain id', () => {
  it('writes a user or persona id that holds a slash, a percent sign or a colon percent-encoded, and every other id as it is', () => {
    expect(encodePlainScopeId('user', 'team/ana')).toBe('team%2Fana');
    expect(encodePlainScopeId('user', 'a%2Fb')).toBe('a%252Fb');
    expect(encodePlainScopeId('user', 'a:b')).toBe('a%3Ab');
    expect(encodePlainScopeId('user', 'ana')).toBe('ana');
    expect(encodePlainScopeId('user', 'ana maria')).toBe('ana maria');
    expect(encodePlainScopeId('user', 'Zoë')).toBe('Zoë');
    expect(encodePlainScopeId('thread', 'conv/7')).toBe('conv/7');
    expect(encodePlainScopeId('organization', 'org/1')).toBe('org/1');
    // A persona id is split at its last `::`, and each part is written on its own.
    expect(encodePlainScopeId('persona', 'team/ana::tutor')).toBe('team%2Fana::tutor');
    expect(encodePlainScopeId('persona', 'a:::x')).toBe('a%3A::x');
    expect(encodePlainScopeId('persona', 'ana::tu/tor')).toBe('ana::tu%2Ftor');
    // A lone surrogate, on which encodeURIComponent throws, is written %u and four uppercase hexadecimal digits.
    expect(encodeScopeIdPart('a\uD800b')).toBe('a%uD800b');
    expect(encodeScopeIdPart('\uDC0F/')).toBe('%uDC0F%2F');
    expect(encodeScopeIdPart('😀/')).toBe('%F0%9F%98%80%2F');
    expect(encodeScopeIdPart('%uD800')).toBe('%25uD800');
    expect(encodePlainId('a\uD800/')).toBe('a%uD800%2F');
    expect(() => encodePlainScopeId('persona', '\uDBFF:x::\uDC00')).not.toThrow();

    // One to one: an encoded id holds a `%` and a kept one none, so no two ids share a written form.
    const ids = ['team/ana', 'team%2Fana', 'a:b', 'a%3Ab', 'ana', 'ana maria', 'a\uD800', 'a%uD800', 'a\uD800/', '%', '/', ':'];
    const written = ids.map((id) => encodePlainScopeId('user', id));
    expect(new Set(written).size).toBe(ids.length);
    ids.forEach((id, at) => expect(written[at]!.includes('%')).toBe(holdsReservedCharacter(id)));
  });
});

describe("a Brain's re-file when a learning layer first opens it", () => {
  it('ensureEncodedScopeIds re-files the plain ids a manager filed and records it; a manager over the reopened file recalls them under the encoded id', async () => {
    const file = brainFile();
    const brain = await openBrain(file);
    const memory = await manager({ brain });
    const bees = await tellAbout(memory, 'team/ana', BEES);
    const tea = await tellAbout(memory, 'ana', 'Ana likes green tea.');

    // A session's view of the manager, which a GMI holds, forwards the call.
    expect(await memory.forSession().ensureEncodedScopeIds?.()).toBe(1);

    expect(await brain.getMeta(SCOPE_ID_FORM_KEY)).toBe(ENCODED_SCOPE_ID_FORM);
    expect(await filedAs(brain)).toEqual({ [bees.id]: ['team%2Fana', 'team%2Fana'], [tea.id]: ['ana', 'ana'] });
    expect(idsOf((await recallUnder(memory, 'team%2Fana')).retrieved)).toEqual([bees.id]);
    expect((await recallUnder(memory, 'team/ana')).retrieved).toEqual([]);
    expect(idsOf((await recallUnder(memory, 'ana')).retrieved)).toEqual([tea.id]);
    expect(await memory.ensureEncodedScopeIds()).toBe(0);
    await stop(memory, brain);

    const reopened = await openBrain(file);
    const later = await manager({ brain: reopened });
    expect(await later.ensureEncodedScopeIds()).toBe(0);
    expect(idsOf((await recallUnder(later, 'team%2Fana')).retrieved)).toEqual([bees.id]);
    expect((await recallUnder(later, 'team/ana')).retrieved).toEqual([]);
    expect(idsOf(await later.getStore().getByScope('user', 'team%2Fana'))).toEqual([bees.id]);
  });

  it('moves user and persona ids that hold a reserved character, a persona id split at its last ::, and no other id; refileBrainScopeIds names each pair it moved, once', async () => {
    const brain = await openBrain(brainFile());
    const memory = await manager({ brain });
    const encode = (scope: 'persona' | 'thread' | 'organization', scopeId: string, text: string) =>
      memory.encode(text, NEUTRAL, 'neutral', { scope, scopeId });
    const user = await tellAbout(memory, 'team/ana', BEES);
    const plainUser = await tellAbout(memory, 'ana', 'Ana likes green tea.');
    const persona = await encode('persona', 'team/ana::tutor', 'Ana asked the tutor about fractions.');
    const colon = await encode('persona', 'a:b::x', 'A:B wants shorter answers.');
    const thread = await encode('thread', 'conv/7', 'The thread is about the roof.');
    const organization = await encode('organization', 'org/1', 'The team meets on Fridays.');

    const result: BrainRefileResult = await refileBrainScopeIds(brain);

    expect(result).toEqual({
      alreadyEncoded: false,
      moved: [
        { scope: 'persona', from: 'a:b::x', to: 'a%3Ab::x', traces: 1 },
        { scope: 'persona', from: 'team/ana::tutor', to: 'team%2Fana::tutor', traces: 1 },
        { scope: 'user', from: 'team/ana', to: 'team%2Fana', traces: 1 },
      ],
    });
    expect(await filedAs(brain)).toEqual({
      [user.id]: ['team%2Fana', 'team%2Fana'],
      [plainUser.id]: ['ana', 'ana'],
      [persona.id]: ['team%2Fana::tutor', 'team%2Fana::tutor'],
      [colon.id]: ['a%3Ab::x', 'a%3Ab::x'],
      [thread.id]: ['conv/7', 'conv/7'],
      [organization.id]: ['org/1', 'org/1'],
    });
    expect(await refileBrainScopeIds(brain)).toEqual({ alreadyEncoded: true, moved: [] });

    // The manager on the Brain moved what it holds when the re-file committed: its own call moves nothing more.
    expect(await memory.ensureEncodedScopeIds()).toBe(0);
    const under = async (scope: 'persona' | 'thread', scopeId: string) =>
      idsOf((await memory.retrieve('What do you know?', NEUTRAL, { scopes: [{ scope, scopeId }] })).retrieved);
    expect(await under('persona', 'team%2Fana::tutor')).toEqual([persona.id]);
    expect(await under('persona', 'team/ana::tutor')).toEqual([]);
    expect(await under('persona', 'a%3Ab::x')).toEqual([colon.id]);
    expect(await under('thread', 'conv/7')).toEqual([thread.id]);
  });

  it("writes the record on a Brain that holds nothing, and leaves another brain of the same file as it is", async () => {
    const file = brainFile();
    const other = await Brain.openSqlite(file, { brainId: 'other' });
    brains.add(other);
    const otherMemory = await manager({ brain: other });
    const cello = await tellAbout(otherMemory, 'team/bo', 'Bo plays the cello.');
    const brain = await openBrain(file);
    const memory = await manager({ brain });

    expect(await memory.ensureEncodedScopeIds()).toBe(0);

    expect(await brain.getMeta(SCOPE_ID_FORM_KEY)).toBe(ENCODED_SCOPE_ID_FORM);
    expect(await other.getMeta(SCOPE_ID_FORM_KEY)).toBeUndefined();
    expect(await filedAs(other)).toEqual({ [cello.id]: ['team/bo', 'team/bo'] });
    expect(idsOf((await recallUnder(otherMemory, 'team/bo')).retrieved)).toEqual([cello.id]);
  });

  it("Memory.ensureEncodedScopeIds re-files the facade's Brain once, and the facade's recall finds the trace under the encoded id alone", async () => {
    const file = brainFile();
    const facade = await openFacade(file);
    const bees = await facade.remember(BEES, { scope: 'user', scopeId: 'team/ana' });
    const cello = await facade.remember('Bo plays the cello.', { scope: 'user', scopeId: 'bo' });

    expect(await facade.ensureEncodedScopeIds()).toBe(1);

    expect((await facade.recall('bees', { scope: 'user', scopeId: 'team%2Fana' })).map((hit) => hit.trace.id)).toEqual([bees.id]);
    expect(await facade.recall('bees', { scope: 'user', scopeId: 'team/ana' })).toEqual([]);
    expect((await facade.recall('cello', { scope: 'user', scopeId: 'bo' })).map((hit) => hit.trace.id)).toEqual([cello.id]);
    expect(await facade.ensureEncodedScopeIds()).toBe(0);
    const reader = await openBrain(file);
    expect(await reader.getMeta(SCOPE_ID_FORM_KEY)).toBe(ENCODED_SCOPE_ID_FORM);
    expect(await filedAs(reader)).toEqual({ [bees.id]: ['team%2Fana', 'team%2Fana'], [cello.id]: ['bo', 'bo'] });
  });

  it('the facade re-files first, as the layer does: a manager on the same file in this process has moved what it holds by then, and the old collection keeps no document of a moved trace', async () => {
    const file = brainFile();
    const brain = await openBrain(file);
    const index = await vectorIndex();
    const walnuts = await fileUnheldTrace(brain, index, 'team/ana', WALNUTS);
    const memory = await manager({ brain, index });
    const bees = await tellAbout(memory, 'team/ana', BEES);
    expect(await textsIn(index, 'cogmem_user_team/ana')).toEqual([BEES, WALNUTS].sort());
    const facade = await openFacade(file);

    expect(await facade.ensureEncodedScopeIds()).toBe(2);

    expect(await textsIn(index, 'cogmem_user_team/ana')).toEqual([]);
    expect(await textsIn(index, 'cogmem_user_team%2Fana')).toEqual([BEES]);
    expect(idsOf((await recallUnder(memory, 'team%2Fana')).retrieved)).toEqual([bees.id]);
    expect((await recallUnder(memory, 'team/ana')).retrieved).toEqual([]);
    expect(await memory.ensureEncodedScopeIds()).toBe(0);
    expect(await filedAs(brain)).toEqual({ [bees.id]: ['team%2Fana', 'team%2Fana'], [walnuts.id]: ['team%2Fana', 'team%2Fana'] });
  });

  it('re-files once when the facade and the manager on one file in this process re-file it together: one moves the rows and the other finds the record', async () => {
    const file = brainFile();
    const brain = await openBrain(file);
    const memory = await manager({ brain });
    const bees = await tellAbout(memory, 'team/ana', BEES);
    const colon = await tellAbout(memory, 'a:b', 'A:B wants shorter answers.');
    const facade = await openFacade(file);

    const moved = await Promise.all([facade.ensureEncodedScopeIds(), memory.ensureEncodedScopeIds()]);

    expect([...moved].sort((a, b) => a - b)).toEqual([0, 2]);
    expect(await filedAs(brain)).toEqual({ [bees.id]: ['team%2Fana', 'team%2Fana'], [colon.id]: ['a%3Ab', 'a%3Ab'] });
    expect(idsOf((await recallUnder(memory, 'team%2Fana')).retrieved)).toEqual([bees.id]);
    expect(idsOf((await recallUnder(memory, 'a%3Ab')).retrieved)).toEqual([colon.id]);
  });

  it('re-files a soft-deleted row too, so a delete of the encoded id takes its words', async () => {
    const brain = await openBrain(brainFile());
    const memory = await manager({ brain });
    const kept = await tellAbout(memory, 'team/ana', BEES);
    const superseded = await tellAbout(memory, 'team/ana', 'Ana lives in Lyon.');
    await memory.getStore().softDelete(superseded.id);

    expect(await memory.ensureEncodedScopeIds()).toBe(2);

    expect(await filingOf(brain, kept.id)).toEqual({ scopeId: 'team%2Fana', deleted: 0 });
    expect(await filingOf(brain, superseded.id)).toEqual({ scopeId: 'team%2Fana', deleted: 1 });
    expect(await memory.deleteScope('user', 'team/ana')).toEqual({ deleted: 0, graph: 'reached' });
    expect(await memory.deleteScope('user', 'team%2Fana')).toEqual({ deleted: 2, graph: 'reached' });
    expect(await traceRowIds(brain)).toEqual([]);
    expect(await fullTextHits(brain, 'Lyon')).toBe(0);
  });

  it('re-files a row an older release wrote after the open, which holds no scope_id yet, and a trace whose id is the empty string', async () => {
    const file = brainFile();
    const facade = await openFacade(file);
    const writer = await openBrain(file);
    // A release older than the scope_id column files a row after the facade opened; an import kept a record's id "".
    await writer.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata)
       VALUES (?, 'older-1', 'episodic', 'user', 'Ana sold honey.', ?, ?)`,
      [writer.brainId, Date.now(), JSON.stringify({ scopeId: 'team/ana' })],
    );
    await fileRow(writer, '', 'team/bo', 'Bo plays the cello.');

    expect(await facade.ensureEncodedScopeIds()).toBe(2);

    expect(await filedAs(writer)).toEqual({ 'older-1': ['team%2Fana', 'team%2Fana'], '': ['team%2Fbo', 'team%2Fbo'] });
  });

  it("moves the Brain's knowledge-graph copies with the rows, a copy whose trace is gone and a host's relation included; a delete of the encoded id takes them, of the plain id nothing", async () => {
    const brain = await openBrain(brainFile());
    const graph = new SqlKnowledgeGraph(brain);
    const memory = await manager({ brain, knowledgeGraph: graph });
    const bees = await tellAbout(memory, 'team/ana', BEES);
    const cello = await tellAbout(memory, 'bo', 'Bo plays the cello.');
    await graph.recordMemory(leftoverCopy('gone-1', 'team/ana', 'Ana sold honey.'));
    const hive = await graph.upsertEntity({ type: 'concept', label: 'hive', properties: {}, confidence: 1, source: HOST_SOURCE });
    await relate(graph, `trace:${bees.id}`, hive.id);

    expect(await memory.ensureEncodedScopeIds()).toBe(1);

    expect((await copiesIn(graph)).map((copy) => [copy.traceId, copy.scopeId])).toEqual([
      [bees.id, 'team%2Fana'],
      ['gone-1', 'team%2Fana'],
      [cello.id, 'bo'],
    ]);
    expect((await graph.getMemory(`trace:${bees.id}`))?.participants).toEqual(['team%2Fana']);
    expect((await graph.getRelations(hive.id)).map((relation) => relation.sourceId)).toEqual([`trace:${bees.id}`]);

    // `team/ana` names user `ana` of namespace `team` now: a delete of that learner takes none of the plain user's.
    expect(await memory.deleteScope('user', 'team/ana')).toEqual({ deleted: 0, graph: 'reached' });
    expect(await copiesIn(graph)).toHaveLength(3);
    expect(await memory.deleteScope('user', 'team%2Fana')).toEqual({ deleted: 1, graph: 'reached' });
    expect((await copiesIn(graph)).map((copy) => copy.traceId)).toEqual([cello.id]);
    expect(await graph.getRelations(hive.id)).toEqual([]);
  });

  it("records a trace's copy again under the encoded id in the in-memory knowledge graph; a delete of the plain id leaves it, of the encoded id takes it", async () => {
    const brain = await openBrain(brainFile());
    const graph = new KnowledgeGraph();
    const memory = await manager({ brain, knowledgeGraph: graph });
    const bees = await tellAbout(memory, 'team/ana', BEES);

    expect(await memory.ensureEncodedScopeIds()).toBe(1);

    expect((await copiesIn(graph)).map((copy) => [copy.traceId, copy.scopeId])).toEqual([[bees.id, 'team%2Fana']]);
    expect(await memory.deleteScope('user', 'team/ana')).toEqual({ deleted: 0, graph: 'reached' });
    expect(await copiesIn(graph)).toHaveLength(1);
    expect(await memory.deleteScope('user', 'team%2Fana')).toEqual({ deleted: 1, graph: 'reached' });
    expect(await copiesIn(graph)).toEqual([]);
  });

  it("leaves where it is a trace filed under a plain id with a slash after the re-file, a namespaced learner's, even one filed between the re-file's commit and the store's follow", async () => {
    const file = brainFile();
    const brain = await openBrain(file);
    // Another process's learner, user `ana` of namespace `team`, files under `team/ana` the moment the re-file commits.
    let learnerFiled = false;
    const watched = withMethod(brain, 'transaction', async (run: Parameters<Brain['transaction']>[0]) => {
      const result = await brain.transaction(run);
      if (!learnerFiled && (await brain.getMeta(SCOPE_ID_FORM_KEY)) === ENCODED_SCOPE_ID_FORM) {
        learnerFiled = true;
        await fileRow(brain, 'learner-1', 'team/ana', 'Ana of team prefers mornings.');
      }
      return result;
    });
    const memory = await manager({ brain: watched });
    const plain = await tellAbout(memory, 'team/ana', BEES);

    expect(await memory.ensureEncodedScopeIds()).toBe(1);

    expect(learnerFiled).toBe(true);
    expect(await filedAs(brain)).toEqual({ [plain.id]: ['team%2Fana', 'team%2Fana'], 'learner-1': ['team/ana', 'team/ana'] });
    // The layer files the namespaced learner's words under `team/ana`: they stay there, and a later call moves nothing.
    const namespaced = await tellAbout(memory, 'team/ana', 'Ana of team runs at dawn.');
    expect(await memory.ensureEncodedScopeIds()).toBe(0);
    expect(await filingOf(brain, namespaced.id)).toEqual({ scopeId: 'team/ana', deleted: 0 });
    expect(idsOf((await recallUnder(memory, 'team/ana')).retrieved)).toEqual([namespaced.id]);
    expect(idsOf((await recallUnder(memory, 'team%2Fana')).retrieved)).toEqual([plain.id]);
    await stop(memory);

    const later = await manager({ brain: await openBrain(file) });
    expect(await later.ensureEncodedScopeIds()).toBe(0);
    expect(idsOf((await recallUnder(later, 'team/ana')).retrieved)).toEqual([namespaced.id]);
    expect(idsOf((await recallUnder(later, 'team%2Fana')).retrieved)).toEqual([plain.id]);
    expect((await filedAs(brain))['learner-1']).toEqual(['team/ana', 'team/ana']);
  });

  it('loads under the encoded id the rows a recall in flight read before the re-file committed', async () => {
    const file = brainFile();
    const firstBrain = await openBrain(file);
    const first = await manager({ brain: firstBrain });
    const bees = await tellAbout(first, 'team/ana', BEES);
    await stop(first, firstBrain);

    const brain = await openBrain(file);
    // The Brain answers the first read of the trace's whole row late, as a busy disk does: the first recall's load has
    // read the row when the layer's re-file commits, and loads it after.
    let readDone!: () => void;
    const read = new Promise<void>((resolve) => (readDone = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let armed = false;
    const slow = withMethod(brain, 'all', async (sql: string, params?: Parameters<Brain['all']>[1]) => {
      const rows = await brain.all<Record<string, unknown>>(sql, params);
      if (armed && rows.some((row) => row.id === bees.id && 'content' in row && 'embedding' in row)) {
        armed = false;
        readDone();
        await released;
      }
      return rows;
    });
    const memory = await manager({ brain: slow });
    armed = true;
    const firstRecall = recallUnder(memory, 'team%2Fana');
    await read;

    const refiled = memory.ensureEncodedScopeIds();
    try {
      await vi.waitFor(async () => expect(await brain.getMeta(SCOPE_ID_FORM_KEY)).toBe(ENCODED_SCOPE_ID_FORM), {
        timeout: 10_000,
        interval: 10,
      });
    } finally {
      release();
    }
    expect(await refiled).toBe(1);
    await firstRecall;

    expect(idsOf((await recallUnder(memory, 'team%2Fana')).retrieved)).toEqual([bees.id]);
    expect((await recallUnder(memory, 'team/ana')).retrieved).toEqual([]);
  });

  it('a manager with no Brain has nothing to re-file, and its index keeps what it holds', async () => {
    const index = await vectorIndex();
    const memory = await manager({ index });
    const bees = await tellAbout(memory, 'team/ana', BEES);

    expect(await memory.ensureEncodedScopeIds()).toBe(0);
    expect(await memory.forSession().ensureEncodedScopeIds?.()).toBe(0);

    expect(idsOf((await recallUnder(memory, 'team/ana')).retrieved)).toEqual([bees.id]);
    expect(await textsIn(index, 'cogmem_user_team/ana')).toEqual([BEES]);
  });

  it('leaves a Brain no layer opens as it is: a manager and a facade that never call it keep its plain ids and write no record', async () => {
    const file = brainFile();
    const brain = await openBrain(file);
    const memory = await manager({ brain });
    const bees = await tellAbout(memory, 'team/ana', BEES);
    expect(idsOf((await recallUnder(memory, 'team/ana')).retrieved)).toEqual([bees.id]);
    const facade = await openFacade(file);
    const tea = await facade.remember('Ana likes green tea.', { scope: 'user', scopeId: 'team/ana' });
    expect((await facade.recall('tea', { scope: 'user', scopeId: 'team/ana' })).map((hit) => hit.trace.id)).toEqual([tea.id]);
    await stop(memory, brain);

    const reopened = await openBrain(file);
    expect(await reopened.getMeta(SCOPE_ID_FORM_KEY)).toBeUndefined();
    expect(await filedAs(reopened)).toEqual({ [bees.id]: ['team/ana', 'team/ana'], [tea.id]: ['team/ana', 'team/ana'] });
    const later = await manager({ brain: reopened });
    expect(idsOf((await recallUnder(later, 'team/ana')).retrieved)).toEqual([bees.id]);
  });

  it('names the re-file and its result in the types a host imports', () => {
    expectTypeOf<ICognitiveMemoryManager['ensureEncodedScopeIds']>().toEqualTypeOf<(() => Promise<number>) | undefined>();
    expectTypeOf<CognitiveMemoryManager['ensureEncodedScopeIds']>().toEqualTypeOf<() => Promise<number>>();
    expectTypeOf<Memory['ensureEncodedScopeIds']>().toEqualTypeOf<() => Promise<number>>();
    expectTypeOf<Brain>().toExtend<Parameters<typeof refileBrainScopeIds>[0]>();
    expectTypeOf<Awaited<ReturnType<typeof refileBrainScopeIds>>>().toEqualTypeOf<BrainRefileResult>();
    expectTypeOf<BrainRefileResult>().toEqualTypeOf<{ alreadyEncoded: boolean; moved: ScopeIdRefile[] }>();
    expectTypeOf<ScopeIdRefile>().toEqualTypeOf<{ scope: string; from: string; to: string; traces: number }>();
  });
});

describe.skipIf(!process.env.CI && !fs.existsSync(BUILT_MEMORY))('a Brain another process re-filed first', () => {
  it('reads nothing under the plain id until this process follows the move, and then recalls the trace under the encoded id', async () => {
    const file = brainFile();
    const brain = await openBrain(file);
    const memory = await manager({ brain });
    const bees = await tellAbout(memory, 'team/ana', BEES);
    expect(idsOf((await recallUnder(memory, 'team/ana')).retrieved)).toEqual([bees.id]);

    expect(await refileInAnotherProcess(file)).toBe(1);

    // User `ana` of namespace `team` reads `team/ana` now: the plain user's words are not hers.
    expect((await recallUnder(memory, 'team/ana')).retrieved).toEqual([]);
    expect(await memory.getStore().getByScope('user', 'team/ana')).toEqual([]);
    expect(await memory.getStore().filterRecallableTraceIds([bees.id], [{ scope: 'user', scopeId: 'team/ana' }])).toEqual(new Set());

    expect(await memory.ensureEncodedScopeIds()).toBe(0);

    expect(idsOf((await recallUnder(memory, 'team%2Fana')).retrieved)).toEqual([bees.id]);
    expect((await recallUnder(memory, 'team/ana')).retrieved).toEqual([]);
    expect(idsOf(await memory.getStore().getByScope('user', 'team%2Fana'))).toEqual([bees.id]);
    expect(await memory.getStore().filterRecallableTraceIds([bees.id], [{ scope: 'user', scopeId: 'team%2Fana' }])).toEqual(
      new Set([bees.id]),
    );
  });

  it("returns under the plain id none of the documents of moved traces it does not hold, and deletes each from the index, whether a recall or a scope listing reads it", async () => {
    for (const read of ['recall', 'getByScope'] as const) {
      const file = brainFile();
      const brain = await openBrain(file);
      const index = await vectorIndex();
      const walnuts = await fileUnheldTrace(brain, index, 'team/ana', WALNUTS);
      const memory = await manager({ brain, index });
      expect(await textsIn(index, 'cogmem_user_team/ana')).toEqual([WALNUTS]);

      expect(await refileInAnotherProcess(file)).toBe(1);

      if (read === 'recall') expect((await recallUnder(memory, 'team/ana')).retrieved).toEqual([]);
      else expect(await memory.getStore().getByScope('user', 'team/ana')).toEqual([]);
      expect(await textsIn(index, 'cogmem_user_team/ana')).toEqual([]);
      expect(await filingOf(brain, walnuts.id)).toEqual({ scopeId: 'team%2Fana', deleted: 0 });
    }
  });
});

describe.skipIf(!POSTGRES_URL)("a Brain's re-file on Postgres", () => {
  /** Removes a test's rows of one brain id from the shared database. */
  async function cleanUp(brainId: string): Promise<void> {
    const cleaner = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    for (const table of ['knowledge_edges', 'knowledge_nodes', 'retrieval_feedback', 'memory_traces', 'brain_meta']) {
      await cleaner.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brainId]);
    }
    await cleaner.close();
  }

  /** A handle on one brain of the database, as one process opens it: a connection pool of its own. */
  async function openPostgres(brainId: string): Promise<Brain> {
    const brain = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    brains.add(brain);
    return brain;
  }

  it('re-files a brain once when two processes first open it together: one moves every row, three pages of them, and the other finds the record', async () => {
    const brainId = `qa-refile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const one = await openPostgres(brainId);
      const two = await openPostgres(brainId);
      // Rows a release before the layer filed under plain ids that hold a slash.
      await one.transaction(async (trx) => {
        for (let n = 0; n < 1_200; n += 1) {
          await trx.run(
            `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata, scope_id)
             VALUES (?, ?, 'episodic', 'user', ?, ?, ?, ?)`,
            [brainId, `t-${String(n).padStart(4, '0')}`, `Note ${n}.`, n + 1, JSON.stringify({ scopeId: `team/u${n}` }), `team/u${n}`],
          );
        }
      });
      const first = await manager({ brain: one });
      const second = await manager({ brain: two });

      const moved = await Promise.all([first.ensureEncodedScopeIds(), second.ensureEncodedScopeIds()]);

      expect([...moved].sort((a, b) => a - b)).toEqual([0, 1_200]);
      const rows = await one.all<{ scope_id: string; metadata: string }>('SELECT scope_id, metadata FROM memory_traces WHERE brain_id = ?', [brainId]);
      expect(rows).toHaveLength(1_200);
      expect(rows.filter((row) => !/^team%2Fu\d+$/.test(row.scope_id) || JSON.parse(row.metadata).scopeId !== row.scope_id)).toEqual([]);
      expect(await two.getMeta(SCOPE_ID_FORM_KEY)).toBe(ENCODED_SCOPE_ID_FORM);
    } finally {
      await cleanUp(brainId);
    }
  });

  it('keeps a metadata write another process commits while the re-file waits on the row', async () => {
    const brainId = `qa-refile-cas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const one = await openPostgres(brainId);
      const two = await openPostgres(brainId);
      const memory = await manager({ brain: one });
      const bees = await tellAbout(memory, 'team/ana', BEES);

      // The other process adds a key to the row's metadata in a transaction it holds open until the re-file waits on the row.
      let commit!: () => void;
      const committing = new Promise<void>((resolve) => (commit = resolve));
      let writing!: (pid: number) => void;
      const writerPid = new Promise<number>((resolve) => (writing = resolve));
      const writer = two.transaction(async (trx) => {
        const current = await trx.get<{ metadata: string }>('SELECT metadata FROM memory_traces WHERE brain_id = ? AND id = ?', [brainId, bees.id]);
        await trx.run('UPDATE memory_traces SET metadata = ? WHERE brain_id = ? AND id = ?', [
          JSON.stringify({ ...JSON.parse(current!.metadata), note: 'kept' }),
          brainId,
          bees.id,
        ]);
        writing((await trx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid);
        await committing;
      });
      const pid = await writerPid;
      const refiling = memory.ensureEncodedScopeIds();
      try {
        await vi.waitFor(
          async () => {
            const blocked = await one.get<{ count: number }>(
              'SELECT count(*)::int AS count FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))',
              [pid],
            );
            expect(blocked?.count).toBe(1);
          },
          { timeout: 10_000, interval: 20 },
        );
      } finally {
        commit();
      }
      await writer;

      expect(await refiling).toBe(1);
      expect(await metadataOf(one, bees.id)).toMatchObject({ scopeId: 'team%2Fana', note: 'kept' });
      expect(await filingOf(one, bees.id)).toEqual({ scopeId: 'team%2Fana', deleted: 0 });
      expect(idsOf((await recallUnder(memory, 'team%2Fana')).retrieved)).toEqual([bees.id]);
    } finally {
      await cleanUp(brainId);
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

  it("describe deleting traces for good and the key of a trace's episodic copy", () => {
    const cognitive = doc('docs/memory/COGNITIVE_MEMORY.md');
    expect(cognitive).toMatch(/^### Deleting traces$/m);
    expect(cognitive).toContain('`CognitiveMemoryManager.deleteTraces(traceIds)` and `deleteScope(scope, scopeId)` delete for good.');
    expect(cognitive).toContain("`graph` is `'not_supported'` when the knowledge graph has no `deleteMemories`");
    expect(doc('docs/memory/MEMORY_STORAGE.md')).toContain('under the node id `trace:<traceId>`');
  });

  it("describe loading and moving one scope, a second user's traces, and the facade's deletes and restores", () => {
    const cognitive = doc('docs/memory/COGNITIVE_MEMORY.md');
    expect(cognitive).toMatch(/^### Loading and moving one scope$/m);
    expect(cognitive).toContain('`MemoryStore.hydrateScope(scope, scopeId, limit?)`');
    expect(cognitive).toContain('`MemoryStore.refileScope(scope, fromScopeId, toScopeId)`');
    expect(cognitive).toContain('`MemoryTrace.turnUserId`');
    expect(cognitive).toContain('`deleteScope(scope, scopeId, { turnUserId })`');
    const storage = doc('docs/memory/MEMORY_STORAGE.md');
    expect(storage).toMatch(/^## Deleting and restoring traces$/m);
    expect(storage).toContain('`Memory.deleteScope(scope, scopeId, { turnUserId? })`');
    expect(storage).toContain('`Memory.restoreTrace(traceId, snapshot)`');
    expect(storage).toContain('`readTraceSnapshot(brain, brainId, traceId)`');
    expect(storage).toContain('`Memory.brainId`');
    expect(storage).toContain('`remember(content, { metadata })`');
  });

  it("describe the written form of a plain id and a Brain's re-file when a layer first opens it", () => {
    const cognitive = doc('docs/memory/COGNITIVE_MEMORY.md');
    expect(cognitive).toMatch(/^### The written form of a plain id, and a Brain's re-file$/m);
    expect(cognitive).toContain('`team/ana` is written `team%2Fana`');
    expect(cognitive).toContain('(`CognitiveMemoryManager.ensureEncodedScopeIds`, `Memory.ensureEncodedScopeIds`)');
    expect(cognitive).toContain("`brain_meta (brain_id, 'scope_id_form', 'encoded')`");
    expect(cognitive).toContain("a scope id that holds a `/` is a layer's namespaced id");
    expect(cognitive).toMatch(/Until a store follows a move, its reads skip/);
    expect(cognitive).toContain('Two limits hold.');
  });
});
