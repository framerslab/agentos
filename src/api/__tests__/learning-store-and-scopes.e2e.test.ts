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
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  agent,
  type CognitiveMemoryConfig,
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

/** The host's embedding model, fixed, returning vectors of `size` values. */
function embedder(size: number): CognitiveMemoryConfig['embeddingManager'] {
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
    getEmbeddingDimension: async () => size,
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
 * A memory manager as a host builds one: its own knowledge graph, the given index (a new one by default), the given
 * Brain, and an embedding model of the given size (1536 by default).
 */
async function manager(
  options: { brain?: Brain; index?: InMemoryVectorStore; persistAccessState?: boolean; dimension?: number } = {},
): Promise<CognitiveMemoryManager> {
  const knowledgeGraph = new KnowledgeGraph();
  await knowledgeGraph.initialize();
  const config: CognitiveMemoryConfig = {
    workingMemory: workingMemory(),
    knowledgeGraph,
    vectorStore: options.index ?? (await vectorIndex(options.dimension)),
    embeddingManager: embedder(options.dimension ?? DIMENSION),
    agentId: 'qa-agent',
    traits: { honesty: 0.5, emotionality: 0.5, extraversion: 0.5, agreeableness: 0.5, conscientiousness: 0.5, openness: 0.5 },
    moodProvider: () => ({ ...NEUTRAL }),
    featureDetectionStrategy: 'keyword',
    consolidation: { enabled: false },
    ...(options.brain ? { brain: options.brain } : {}),
    ...(options.persistAccessState === undefined ? {} : { persistAccessState: options.persistAccessState }),
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
