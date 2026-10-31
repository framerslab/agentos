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
 * `readTraceSnapshot` (the package root), names a new trace's id before it writes it, reads one row live or deleted
 * (`readTrace`) and counts a scope's live traces (`countScope`).
 *
 * The written form of a plain id. Where a learning layer exists, a plain `user` or `persona` id that holds a `/`, a `%`
 * or a `:` is written percent-encoded (the rule of the package's `cognition/memory/retrieval/store/scopeIdForm` path),
 * and the first time a layer opens a Brain, `ensureEncodedScopeIds` on the manager or the `Memory` facade re-files the
 * Brain's plain ids to that form once, with the knowledge graph's copies, and records it in `brain_meta`. Every store
 * on the Brain follows the move: in this process when it commits, and after another process's re-file (a child Node
 * process that loads the built package, as a host's second process does) when the layer opens it; until then no read
 * returns a moved trace under the plain id, which from then on names a namespaced learner.
 *
 * Every import, export and migration keeps a Brain's form. An import (the `Memory` facade's JSON, SQLite file,
 * Markdown and CSV imports, and `Brain.importFromSqlite`) takes its source's form from the source's own record and
 * encodes a plain source's ids as it writes them into a re-filed Brain, refuses an encoded source where the Brain holds
 * a plain id the record would read as another, naming the record, and on Postgres waits for a re-file under way. The
 * RAG `MigrationEngine` (the package's `cognition/rag` path) runs the same handshake per brain before it copies any
 * table, and fills `scope_id` from each row's metadata for a source from before the column.
 *
 * The learning store (the package's `cognition/learning/store/index` path): the in-process store and the SQL store over
 * a host's storage adapter (a SQLite file, and a schema of its own on CI's Postgres) keep one contract a host sees the
 * same on each. A learner's ledger rows read back in order, a chain's head moves only by compare-and-swap, a trait row
 * only from the version it read, a transaction that throws takes back every write and no read sees one, and a user's
 * rows in one namespace go with their tombstone kept. The SQL store makes its ten tables at its first call, keeps them
 * across a restart, leaves the host's adapter open, orders text by code unit on any collation, and takes a column a
 * later release adds into the tables an earlier one made.
 *
 * The ledger (the package's `cognition/learning/ledger/index` path) over each of those stores. A learner's candidate
 * and its verdict chain under the learner's key, each row the canonical text of its entry, hashed (SHA-256, or
 * HMAC-SHA-256 under a key the store never holds) and linked to the row before it; a change runs in its rows'
 * transaction; a row with no learner chains under the agent or the second user it names, so a user's deletion takes
 * whole chains. A head moves by compare-and-swap: a writer that lost re-reads it, and two processes on Postgres keep
 * one chain and one verdict per candidate. A forgotten user's chain takes nothing, and an append that finds the
 * tombstone once it committed deletes its rows. A freeze refuses a new candidate and lets an operator act; a verdict
 * follows the candidate's current one; and the load check names what an edit made outside the layer broke, from an
 * operator's reanchor on.
 *
 * The learning option and what a tool reads (the package's `cognition/learning/index` path). Every scope id a layer
 * files and reads has one written form: a learner's plain or namespaced with both parts encoded, a turn with no
 * learner's in its session's form, which no learner's form equals. `learning: null`, and a field set to null, read as
 * unset on agent(), gmi(), the full runtime and an agency's members; the store, ledger key, clock and memory-tools
 * fields are checked at construction. A host tool reads its turn's learner and mode from its call, and a self-change
 * and a memory write refuse by them: a freeze stops both, mode off and a turn with no learner the self-change alone.
 *
 * A learner's trait row, on gmi(), the full runtime and a host's own turn loop (`createLearningLayer`; the stores,
 * the ledger, the freeze keys and the trait bounds on the learning module's own path). A learner's first session
 * writes the row from the persona's authored traits with its creation in the ledger; each later session checks the
 * learner's chain and the row's digest, so an edit made outside the layer renders the authored traits and counts as a
 * broken chain, a ledger key's included; a persona that moved clamps each learnable trait within 0.2 of its new value,
 * and the row holds the band a trait rendered and the higher honesty-humility. Run-time freezes and suspensions another
 * process writes set each turn's mode. A host's own turn loop records its memory writes (pending, then kept or
 * rejected, taken back for a user forgotten while it runs) and guards its filing by the tombstone; a store that does
 * not open degrades the layer until a later call opens it; a session named at its first turn opens under that turn's
 * namespace and keeps a hand-over made while it could not open; and a persona's own alias beside its canonical key is
 * no role overlay.
 *
 * An operator's calls on a learner (the layer `createLearningLayer` returns, and the full runtime's), from a process of
 * its own over the host's store, SQLite and Postgres: a run-time freeze or suspension of a learner, an agent or every
 * agent is a row a serving agent reads at its next turn; operatorSet sets a learner's traits through the ledger in any
 * mode and under any freeze and re-anchors a record an edit outside the layer broke; revert takes an operator's change,
 * an import or a recorded memory write back; a learner exports as one document and imports into another deployment,
 * the four learnable traits alone; forgetUser deletes a user's memory in every manager and facade the layer holds and
 * through the host's storage adapter, and the user's rows, and names what it did not reach; a crash's pending memory
 * write is decided at the learner's next session; and a store that does not open fails every call naming it.
 */
import { afterAll, afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
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
  AgentOS,
  Brain,
  CognitiveMemoryManager,
  InMemoryVectorStore,
  KnowledgeGraph,
  Memory,
  SqlKnowledgeGraph,
  agent,
  createLearningLayer,
  gmi,
  type CognitiveMemoryConfig,
  type ICognitiveMemoryManager,
  type IKnowledgeGraph,
  type ILearnerSession,
  type ILearningLayer,
  type LearnerContext,
  type LearnerKey,
  type LearningConfig,
  type LoopManifest,
  type MemoryCopyFilter,
  type MemoryDeletion,
  type MemoryTrace,
  type PADState,
  readTraceSnapshot,
  type RememberOptions,
  type ToolLearningContext,
  type TraceSnapshot,
  type TurnInputForLearning,
} from '@framers/agentos';
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
import { JsonExporter, MarkdownExporter, ObsidianImporter } from '@framers/agentos/cognition/memory';
import { MigrationEngine } from '@framers/agentos/cognition/rag';
import {
  GENESIS_HASH,
  InMemoryLearningStore,
  LEARNABLE_TRAITS,
  LEARNING_SCHEMA_DDL,
  LEARNING_TABLES,
  LIFETIME_BAND,
  Ledger,
  SqlLearningStore,
  assertLearnerKey,
  chainKeyOf,
  couldBeSessionForm,
  deferLearnerSession,
  ensureLearningSchema,
  forgetTargets,
  freezeScopeKey,
  learnerScopeIds,
  learnerUserScopeId,
  memoryWriteRefusal,
  readToolLearningContext,
  scopeIdOf,
  selfChangeRefusal,
  sessionScopeIds,
  taggedScopeId,
  tombstoneHash,
  type CandidateInput,
  type ChainCheck,
  type ChainHead,
  type DecideResult,
  type ForgetReport,
  type ForgetTarget,
  type FreezeRow,
  type FreezeScope,
  type ImportReport,
  type LearnedStateDocument,
  type LearningColumnAddition,
  type LearningKind,
  type LearningLayerHandle,
  type LearningMemoryTools,
  type LearningStore,
  type LearningStoreTx,
  type LearningTable,
  type LedgerEntry,
  type LedgerLearner,
  type LedgerOptions,
  type LedgerVerdict,
  type OperatorSetInput,
  type OperatorTraits,
  type ProposalResult,
  type ProposeOptions,
  type ProposeResult,
  type ScopeIdPair,
  type SessionRow,
  type SessionSelfChange,
  type SqlLearningStoreOptions,
  type StoredLedgerRow,
  type StoredTraitRow,
  type TraitState,
  type TurnScopes,
} from '@framers/agentos/cognition/learning/index';
import { canonicalJson, hmacSha256Hex, sha256Hex, ulid } from '@framers/agentos/cognition/learning/ledger/index';
import { OPERATOR_ONLY_TRAITS, renderPersonalitySection } from '@framers/agentos/cognition/substrate';
import { traitOverlayPatch } from '@framers/agentos/cognition/substrate/personas/personalityPrompt';
import { HEXACO_TRAIT_ALIASES } from '@framers/agentos/cognition/substrate/personas/hexaco';
import { createPostgresAdapter, resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import Database from 'better-sqlite3';
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

/** What the user tells the agent, in the cases on imports and migrations. */
const HIKES = 'Bo hikes on Sundays.';
const TUTOR = 'The tutor knows Ana learns by drawing.';
const STANDUP = 'The stand-up moved to ten.';

/** One handle per Brain file, through which a case reads what a file holds. */
const readers = new Map<string, Brain>();

async function readerOf(file: string): Promise<Brain> {
  const held = readers.get(file);
  if (held && brains.has(held)) return held;
  const brain = await openBrain(file);
  readers.set(file, brain);
  return brain;
}

/** What the brain `qa` of a file holds: each live trace as `<scope>:<scope_id>`, sorted, and its scope-id form record. */
async function formOf(file: string): Promise<{ ids: string[]; record: string | undefined }> {
  const brain = await readerOf(file);
  const rows = await brain.all<{ scope: string; scope_id: string }>(
    'SELECT scope, scope_id FROM memory_traces WHERE brain_id = ? AND deleted = 0 ORDER BY scope, scope_id',
    [brain.brainId],
  );
  return { ids: rows.map((row) => `${row.scope}:${row.scope_id}`), record: await brain.getMeta(SCOPE_ID_FORM_KEY) };
}

/** Closes a facade, as a process that is done with its file does. */
async function closeFacade(facade: Memory): Promise<void> {
  const at = facades.indexOf(facade);
  if (at >= 0) facades.splice(at, 1);
  await facade.close();
}

/** A Brain file a learning layer has opened: what `fill` files first, re-filed once to the encoded form, with the record. */
async function refiledFacade(fill: (memory: Memory) => Promise<unknown> = async () => undefined): Promise<{ file: string; memory: Memory }> {
  const file = brainFile();
  const memory = await openFacade(file);
  await fill(memory);
  await memory.ensureEncodedScopeIds();
  return { file, memory };
}

/** A Brain file no learning layer has opened, holding what `fill` files. */
async function plainFacade(fill: (memory: Memory) => Promise<unknown> = async () => undefined): Promise<{ file: string; memory: Memory }> {
  const file = brainFile();
  const memory = await openFacade(file);
  await fill(memory);
  return { file, memory };
}

/** A directory of its own, removed after the test. */
function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-files-'));
  dirs.push(dir);
  return dir;
}

/** The Markdown notes under a folder, by path. */
function notesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) return notesUnder(at);
    return entry.name.endsWith('.md') ? [at] : [];
  });
}

/** A front-matter field of a note as written: its value with any quotes taken off, or undefined. */
function frontMatterField(note: string, field: string): string | undefined {
  const line = new RegExp(`^${field}: (.*)$`, 'm').exec(note.split(/^---$/m)[1] ?? '');
  return line ? line[1]!.trim().replace(/^["']|["']$/g, '') : undefined;
}

/**
 * The Brain as an exporter reads it, while another opener of the same file re-files it once (`refile`), right before
 * the exporter's first read of the trace rows: a re-file that commits while the export reads.
 */
function overtakenByRefile(brain: Brain, refile: () => Promise<unknown>): { brain: Brain; refiled: () => boolean } {
  let refiled = false;
  const overtaken = new Proxy(brain, {
    get(target, property) {
      if (property === 'all') {
        return async (sql: string, params?: Parameters<Brain['all']>[1]) => {
          if (!refiled && sql.includes('FROM memory_traces')) {
            refiled = true;
            await refile();
          }
          return target.all(sql, params);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { brain: overtaken, refiled: () => refiled };
}

/** A Brain file a release older than the `scope_id` column wrote: one `user` trace of the brain, its scope id in its metadata alone. */
function olderReleaseFile(brainId: string, traceId: string, scopeId: string): string {
  const file = brainFile();
  const db = new Database(file);
  try {
    db.exec(`
      CREATE TABLE brain_meta (brain_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (brain_id, key));
      CREATE TABLE memory_traces (
        brain_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, scope TEXT NOT NULL, content TEXT NOT NULL,
        embedding BLOB, strength REAL NOT NULL DEFAULT 1.0, created_at INTEGER NOT NULL, last_accessed INTEGER,
        retrieval_count INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]', emotions TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (brain_id, id));
    `);
    db.prepare(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata) VALUES (?, ?, 'episodic', 'user', ?, 1, ?)`,
    ).run(brainId, traceId, `What ${scopeId} said.`, JSON.stringify({ scopeId }));
  } finally {
    db.close();
  }
  return file;
}

/** A refusal in an import's `errors`, by the record it names; any other message as it is. */
const refusals = (errors: readonly string[]) => errors.map((error) => (/scope_id_form/.test(error) ? 'scope_id_form' : error));

describe("an import or a migration keeps a Brain's scope-id form", () => {
  it("takes a re-filed Brain's JSON export into a fresh Brain as it is written, with the record, and recall there finds it under the encoded id", async () => {
    const source = await refiledFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' }));
    const exported = await source.memory.exportToString();
    expect((JSON.parse(exported) as { meta: Record<string, string> }).meta[SCOPE_ID_FORM_KEY]).toBe(ENCODED_SCOPE_ID_FORM);

    const target = await plainFacade();
    const result = await target.memory.importFromString(exported, 'json');

    expect(result.errors).toEqual([]);
    expect(result.imported).toBeGreaterThan(0);
    expect(await formOf(target.file)).toEqual({ ids: ['user:team%2Fana'], record: ENCODED_SCOPE_ID_FORM });
    expect((await target.memory.recall('bees', { scope: 'user', scopeId: 'team%2Fana' })).map((hit) => hit.trace.content)).toEqual([BEES]);
  });

  it("files a plain JSON export's user and persona ids encoded into a re-filed Brain, the trace's knowledge-graph copy with them, and a thread id as it is", async () => {
    const source = await plainFacade();
    const bees = await source.memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' });
    await source.memory.remember(TUTOR, { scope: 'persona', scopeId: 'team/ana::tutor' });
    await source.memory.remember(STANDUP, { scope: 'thread', scopeId: 'conv/7' });
    // The trace's episodic copy in the Brain's knowledge graph, as a memory manager over the Brain records it.
    await source.memory.graph.recordMemory(leftoverCopy(bees.id, 'team/ana', BEES));
    const exported = await source.memory.exportToString();
    expect((JSON.parse(exported) as { meta: Record<string, string> }).meta[SCOPE_ID_FORM_KEY]).toBeUndefined();

    const target = await refiledFacade();
    const result = await target.memory.importFromString(exported, 'json');

    expect(result.errors).toEqual([]);
    expect(await formOf(target.file)).toEqual({
      ids: ['persona:team%2Fana::tutor', 'thread:conv/7', 'user:team%2Fana'],
      record: ENCODED_SCOPE_ID_FORM,
    });
    // The column and the metadata name one id.
    const filed = Object.values(await filedAs(await readerOf(target.file))).map(([column, metadata]) => `${column} | ${String(metadata)}`);
    expect(filed.sort()).toEqual(['conv/7 | conv/7', 'team%2Fana | team%2Fana', 'team%2Fana::tutor | team%2Fana::tutor']);
    // The copy is filed under the plain user's encoded id: a delete of user `ana` of namespace `team` takes none of it.
    expect((await copiesIn(target.memory.graph)).map((copy) => [copy.traceId, copy.scopeId])).toEqual([[bees.id, 'team%2Fana']]);
    expect(await target.memory.graph.deleteMemories!({ scopes: [{ scope: 'user', scopeId: 'team/ana' }] })).toBe(0);
    expect(await target.memory.graph.deleteMemories!({ scopes: [{ scope: 'user', scopeId: 'team%2Fana' }] })).toBe(1);
  });

  it("refuses a re-filed Brain's export into a plain Brain holding a plain id with a slash, names the record, and changes nothing", async () => {
    const source = await refiledFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' }));
    const target = await plainFacade((memory) => memory.remember(HIKES, { scope: 'user', scopeId: 'team/bo' }));

    const result = await target.memory.importFromString(await source.memory.exportToString(), 'json');

    expect(result.imported).toBe(0);
    expect(refusals(result.errors)).toEqual(['scope_id_form']);
    expect(await formOf(target.file)).toEqual({ ids: ['user:team/bo'], record: undefined });
  });

  it("takes a re-filed Brain's export into a plain Brain whose persona ids hold none of the characters in their parts, which gets the record", async () => {
    const source = await refiledFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' }));
    // User `ana`'s persona `tutor`: the `::` between the two ids belongs to neither.
    const target = await plainFacade((memory) => memory.remember(TUTOR, { scope: 'persona', scopeId: 'ana::tutor' }));

    const result = await target.memory.importFromString(await source.memory.exportToString(), 'json');

    expect(result.errors).toEqual([]);
    expect(await formOf(target.file)).toEqual({ ids: ['persona:ana::tutor', 'user:team%2Fana'], record: ENCODED_SCOPE_ID_FORM });
  });

  it('takes a source with the record whose ids read the same in both forms as a plain one: no record comes with it, and a later re-file still files the plain ids written after it', async () => {
    const source = await refiledFacade(async (memory) => {
      await memory.remember(HIKES, { scope: 'user', scopeId: 'bo' });
      await memory.remember(TUTOR, { scope: 'persona', scopeId: 'bo::tutor' });
    });
    const exported = await source.memory.exportToString();
    expect((JSON.parse(exported) as { meta: Record<string, string> }).meta[SCOPE_ID_FORM_KEY]).toBe(ENCODED_SCOPE_ID_FORM);
    const sqliteExport = path.join(scratchDir(), 'bo.sqlite');
    await source.memory.export(sqliteExport);

    // Into a Brain without the record: a host with no learning layer goes on filing its plain ids, and the layer that
    // opens the Brain later re-files them.
    const fresh = await plainFacade();
    expect((await fresh.memory.importFromString(exported, 'json')).errors).toEqual([]);
    expect(await formOf(fresh.file)).toEqual({ ids: ['persona:bo::tutor', 'user:bo'], record: undefined });
    await fresh.memory.remember(STANDUP, { scope: 'user', scopeId: 'org:42' });
    expect(await fresh.memory.ensureEncodedScopeIds()).toBe(1);
    expect(await formOf(fresh.file)).toEqual({ ids: ['persona:bo::tutor', 'user:bo', 'user:org%3A42'], record: ENCODED_SCOPE_ID_FORM });

    // Into a plain Brain that holds a plain id with a slash, from JSON and from a SQLite file: no refusal, and it stays plain.
    for (const [name, importInto] of [
      ['JSON', (memory: Memory) => memory.importFromString(exported, 'json')],
      ['SQLite file', (memory: Memory) => memory.importFrom(sqliteExport)],
    ] as const) {
      const plain = await plainFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/bo' }));
      const result = await importInto(plain.memory);
      expect({ name, errors: result.errors, form: await formOf(plain.file) }).toEqual({
        name,
        errors: [],
        form: { ids: ['persona:bo::tutor', 'user:bo', 'user:team/bo'], record: undefined },
      });
    }
  });

  it('a SQLite file: encodes a plain source into a re-filed Brain, and refuses a re-filed one into a plain Brain holding a plain id with a slash', async () => {
    const plainSource = await plainFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' }));
    const plainFile = path.join(scratchDir(), 'plain.sqlite');
    await plainSource.memory.export(plainFile);
    const encodedSource = await refiledFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' }));
    const encodedFile = path.join(scratchDir(), 'encoded.sqlite');
    await encodedSource.memory.export(encodedFile);

    const refiled = await refiledFacade();
    expect((await refiled.memory.importFrom(plainFile)).errors).toEqual([]);
    expect(await formOf(refiled.file)).toEqual({ ids: ['user:team%2Fana'], record: ENCODED_SCOPE_ID_FORM });

    const plain = await plainFacade((memory) => memory.remember(HIKES, { scope: 'user', scopeId: 'team/bo' }));
    const refused = await plain.memory.importFrom(encodedFile);
    expect(refused.imported).toBe(0);
    expect(refusals(refused.errors)).toEqual(['scope_id_form']);
    expect(await formOf(plain.file)).toEqual({ ids: ['user:team/bo'], record: undefined });
  });

  it('Brain.importFromSqlite encodes a plain source merged into a re-filed Brain, keeps the record through a replace, and throws for a re-filed source into a plain Brain holding a plain id with a slash', async () => {
    const plainSource = await plainFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' }));
    const plainFile = path.join(scratchDir(), 'plain.sqlite');
    await plainSource.memory.export(plainFile);
    const encodedSource = await refiledFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' }));
    const encodedFile = path.join(scratchDir(), 'encoded.sqlite');
    await encodedSource.memory.export(encodedFile);

    const merged = await refiledFacade();
    await closeFacade(merged.memory);
    await (await readerOf(merged.file)).importFromSqlite(plainFile);
    expect(await formOf(merged.file)).toEqual({ ids: ['user:team%2Fana'], record: ENCODED_SCOPE_ID_FORM });

    // A replace empties the brain, its record among its brain_meta rows, and keeps the form a layer reads.
    const replaced = await refiledFacade((memory) => memory.remember(HIKES, { scope: 'user', scopeId: 'bo' }));
    await closeFacade(replaced.memory);
    await (await readerOf(replaced.file)).importFromSqlite(plainFile, { strategy: 'replace' });
    expect(await formOf(replaced.file)).toEqual({ ids: ['user:team%2Fana'], record: ENCODED_SCOPE_ID_FORM });

    const plain = await plainFacade((memory) => memory.remember(HIKES, { scope: 'user', scopeId: 'team/bo' }));
    await closeFacade(plain.memory);
    await expect((await readerOf(plain.file)).importFromSqlite(encodedFile)).rejects.toThrow(/scope_id_form/);
    expect(await formOf(plain.file)).toEqual({ ids: ['user:team/bo'], record: undefined });
  });

  it("Markdown: a re-filed Brain's export marks its notes, which come back as they were written, and a plain note goes into a re-filed Brain encoded", async () => {
    const source = await refiledFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' }));
    const notes = scratchDir();
    expect((await source.memory.export(notes, { format: 'markdown' })).refused).toEqual([]);
    const written = notesUnder(notes).map((file) => fs.readFileSync(file, 'utf8'));
    expect(written.map((note) => [frontMatterField(note, 'scopeId'), frontMatterField(note, 'scopeIdForm')])).toEqual([
      ['team%2Fana', ENCODED_SCOPE_ID_FORM],
    ]);

    const refiled = await refiledFacade();
    expect((await refiled.memory.importFrom(notes, { format: 'markdown' })).errors).toEqual([]);
    expect(await formOf(refiled.file)).toEqual({ ids: ['user:team%2Fana'], record: ENCODED_SCOPE_ID_FORM });

    const fresh = await plainFacade();
    expect((await fresh.memory.importFrom(notes, { format: 'markdown' })).errors).toEqual([]);
    expect(await formOf(fresh.file)).toEqual({ ids: ['user:team%2Fana'], record: ENCODED_SCOPE_ID_FORM });

    // A note a host writes by hand names a plain id.
    const handWritten = scratchDir();
    fs.writeFileSync(path.join(handWritten, 'bo.md'), `---\nid: n-bo\nscope: user\nscopeId: team/bo\n---\n${HIKES}\n`);
    const target = await refiledFacade();
    expect((await target.memory.importFrom(handWritten, { format: 'markdown' })).errors).toEqual([]);
    expect(await formOf(target.file)).toEqual({ ids: ['user:team%2Fbo'], record: ENCODED_SCOPE_ID_FORM });
  });

  it("CSV: files a plain row's scope id encoded into a re-filed Brain", async () => {
    const target = await refiledFacade();

    const result = await target.memory.importFromString(`content,scope,scope_id\n"${HIKES}",user,team/bo\n`, 'csv');

    expect(result.errors).toEqual([]);
    expect(await formOf(target.file)).toEqual({ ids: ['user:team%2Fbo'], record: ENCODED_SCOPE_ID_FORM });
    expect(Object.values(await filedAs(await readerOf(target.file)))).toEqual([['team%2Fbo', 'team%2Fbo']]);
  });

  it('refuses a re-filed Brain\'s export into a plain Brain whose plain id with a slash only a knowledge-graph copy, or a trace with the id "", holds', async () => {
    const source = await refiledFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' }));
    const exported = await source.memory.exportToString();

    // The copy of a trace a release before keyed copies deleted: the Brain holds no trace under `team/bo`.
    const withCopy = await plainFacade((memory) => memory.graph.recordMemory(leftoverCopy('gone-1', 'team/bo', HIKES)));
    const refusedForCopy = await withCopy.memory.importFromString(exported, 'json');
    expect(refusedForCopy.imported).toBe(0);
    expect(refusals(refusedForCopy.errors)).toEqual(['scope_id_form']);
    expect(await formOf(withCopy.file)).toEqual({ ids: [], record: undefined });

    // An import kept a record's id "".
    const withEmptyId = await plainFacade();
    await fileRow(await readerOf(withEmptyId.file), '', 'team/bo', HIKES);
    const refusedForEmptyId = await withEmptyId.memory.importFromString(exported, 'json');
    expect(refusedForEmptyId.imported).toBe(0);
    expect(refusals(refusedForEmptyId.errors)).toEqual(['scope_id_form']);
    expect(await formOf(withEmptyId.file)).toEqual({ ids: ['user:team/bo'], record: undefined });
  });

  it('two imports into one Brain at once never leave the record beside a plain id with a slash', async () => {
    const encoded = await refiledFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' }));
    const plain = await plainFacade((memory) => memory.remember(HIKES, { scope: 'user', scopeId: 'team/bo' }));
    const encodedExport = await encoded.memory.exportToString();
    const plainExport = await plain.memory.exportToString();
    const target = await plainFacade();

    const results = await Promise.all([
      target.memory.importFromString(encodedExport, 'json'),
      target.memory.importFromString(plainExport, 'json'),
    ]);

    // The one that commits second reads what the first wrote: either the record, and the plain id comes in encoded, or
    // the plain id, and the encoded export is refused.
    const outcome = { errors: results.map((result) => refusals(result.errors)), form: await formOf(target.file) };
    expect([
      { errors: [[], []], form: { ids: ['user:team%2Fana', 'user:team%2Fbo'], record: ENCODED_SCOPE_ID_FORM } },
      { errors: [['scope_id_form'], []], form: { ids: ['user:team/bo'], record: undefined } },
    ]).toContainEqual(outcome);
  });

  it('a JSON and a Markdown export that a re-file overtakes while they read hold the record, or the mark, and the ids in one form', async () => {
    const jsonSource = await plainFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' }));
    const json = overtakenByRefile(await readerOf(jsonSource.file), () => jsonSource.memory.ensureEncodedScopeIds());
    const payload = JSON.parse(await new JsonExporter(json.brain).exportToString()) as {
      meta: Record<string, string>;
      traces: Array<{ scope_id: string }>;
    };
    expect(json.refiled()).toBe(true);
    // The Brain before the re-file or the Brain after it, never the record of one with the ids of the other.
    expect([['plain', ['team/ana']], ['encoded', ['team%2Fana']]]).toContainEqual([
      payload.meta[SCOPE_ID_FORM_KEY] ?? 'plain',
      payload.traces.map((trace) => trace.scope_id),
    ]);

    const markdownSource = await plainFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' }));
    const markdown = overtakenByRefile(await readerOf(markdownSource.file), () => markdownSource.memory.ensureEncodedScopeIds());
    const notes = scratchDir();
    await new MarkdownExporter(markdown.brain).export(notes);
    expect(markdown.refiled()).toBe(true);
    const [note] = notesUnder(notes).map((file) => fs.readFileSync(file, 'utf8'));
    expect([['plain', 'team/ana'], ['encoded', 'team%2Fana']]).toContainEqual([
      frontMatterField(note!, 'scopeIdForm') ?? 'plain',
      frontMatterField(note!, 'scopeId'),
    ]);
  });

  it("MigrationEngine refuses a plain source holding a plain id with a slash into a re-filed target of the same brain before it copies any table, and copies one with none, which keeps the target's record", async () => {
    const reserved = await plainFacade((memory) => memory.remember(BEES, { scope: 'user', scopeId: 'team/ana' }));
    await closeFacade(reserved.memory);
    // User `ana` and her persona `tutor`: the `::` between the two ids belongs to neither.
    const clean = await plainFacade(async (memory) => {
      await memory.remember(WALNUTS, { scope: 'user', scopeId: 'ana' });
      await memory.remember(TUTOR, { scope: 'persona', scopeId: 'ana::tutor' });
    });
    await closeFacade(clean.memory);
    const target = await refiledFacade((memory) => memory.remember(HIKES, { scope: 'user', scopeId: 'bo' }));
    await closeFacade(target.memory);

    const refused = await MigrationEngine.migrate({ from: { type: 'sqlite', path: reserved.file }, to: { type: 'sqlite', path: target.file } });

    expect(refused.verified).toBe(false);
    expect(refused.tablesProcessed).toEqual([]);
    expect(refusals(refused.errors)).toEqual(['scope_id_form']);
    expect(await formOf(target.file)).toEqual({ ids: ['user:bo'], record: ENCODED_SCOPE_ID_FORM });

    const copied = await MigrationEngine.migrate({ from: { type: 'sqlite', path: clean.file }, to: { type: 'sqlite', path: target.file } });

    expect(copied.errors).toEqual([]);
    expect(copied.tablesProcessed).toContain('memory_traces');
    expect(await formOf(target.file)).toEqual({ ids: ['persona:ana::tutor', 'user:ana', 'user:bo'], record: ENCODED_SCOPE_ID_FORM });
  });

  it('MigrationEngine keeps the record of a target that holds only a knowledge-graph copy, copies a source with the record whose ids read the same in both forms as a plain one, and fills scope_id from the metadata of a source from before the column', async () => {
    const plainSource = await plainFacade((memory) => memory.remember(HIKES, { scope: 'user', scopeId: 'bo' }));
    await closeFacade(plainSource.memory);
    // A re-filed brain whose only memory is a copy filed under an encoded id, its trace gone.
    const copyOnly = await refiledFacade((memory) => memory.graph.recordMemory(leftoverCopy('gone-1', 'team/ana', BEES)));
    expect((await copiesIn(copyOnly.memory.graph)).map((copy) => copy.scopeId)).toEqual(['team%2Fana']);
    await closeFacade(copyOnly.memory);

    const intoCopyOnly = await MigrationEngine.migrate({ from: { type: 'sqlite', path: plainSource.file }, to: { type: 'sqlite', path: copyOnly.file } });

    expect(intoCopyOnly.errors).toEqual([]);
    expect(await formOf(copyOnly.file)).toEqual({ ids: ['user:bo'], record: ENCODED_SCOPE_ID_FORM });

    const sameInBoth = await refiledFacade((memory) => memory.remember(HIKES, { scope: 'user', scopeId: 'bo' }));
    await closeFacade(sameInBoth.memory);
    const plainTarget = await plainFacade((memory) => memory.remember(WALNUTS, { scope: 'user', scopeId: 'ana' }));
    await closeFacade(plainTarget.memory);

    const intoPlain = await MigrationEngine.migrate({ from: { type: 'sqlite', path: sameInBoth.file }, to: { type: 'sqlite', path: plainTarget.file } });

    expect(intoPlain.errors).toEqual([]);
    expect(await formOf(plainTarget.file)).toEqual({ ids: ['user:ana', 'user:bo'], record: undefined });

    const older = olderReleaseFile('qa', 't-old', 'ana');
    const filledTarget = await plainFacade();
    await closeFacade(filledTarget.memory);

    const filled = await MigrationEngine.migrate({ from: { type: 'sqlite', path: older }, to: { type: 'sqlite', path: filledTarget.file } });

    expect(filled.errors).toEqual([]);
    expect(await filedAs(await readerOf(filledTarget.file))).toEqual({ 't-old': ['ana', 'ana'] });
  });
});

describe.skipIf(!POSTGRES_URL)("an import or a migration keeps a Postgres Brain's scope-id form", () => {
  /** Removes a test's rows of one brain id from the shared database. */
  async function cleanUp(...brainIds: string[]): Promise<void> {
    for (const brainId of brainIds) {
      const cleaner = await Brain.openPostgres(POSTGRES_URL!, { brainId });
      for (const table of ['knowledge_edges', 'knowledge_nodes', 'retrieval_feedback', 'document_chunks', 'documents', 'memory_traces', 'brain_meta']) {
        await cleaner.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brainId]);
      }
      await cleaner.close();
    }
  }

  /** A handle on one brain of the database, as one process opens it: a connection pool of its own. */
  async function openPostgres(brainId: string): Promise<Brain> {
    const brain = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    brains.add(brain);
    return brain;
  }

  const newBrainId = (name: string) => `qa-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /** A brain's live trace rows, `<scope>:<scope_id>`, sorted. */
  async function idsOn(brain: Brain): Promise<string[]> {
    const rows = await brain.all<{ scope: string; scope_id: string }>(
      'SELECT scope, scope_id FROM memory_traces WHERE brain_id = ? AND deleted = 0 ORDER BY scope, scope_id',
      [brain.brainId],
    );
    return rows.map((row) => `${row.scope}:${row.scope_id}`);
  }

  it('MigrationEngine into Postgres refuses a plain source holding a plain id with a slash into a re-filed brain, and fills scope_id from the metadata of a source from before the column', async () => {
    const refiledId = newBrainId('migrate-refuse');
    const filledId = newBrainId('migrate-fill');
    try {
      // A brain of the database a learning layer has opened.
      const target = await Memory.createPostgres(POSTGRES_URL!, { brainId: refiledId });
      facades.push(target);
      await target.remember(HIKES, { scope: 'user', scopeId: 'ana' });
      await target.ensureEncodedScopeIds();
      // A file of the same brain no layer opened, holding a plain id with a slash.
      const sourceFile = brainFile();
      const source = await Memory.createSqlite(sourceFile, { brainId: refiledId });
      facades.push(source);
      await source.remember(BEES, { scope: 'user', scopeId: 'team/ana' });
      await closeFacade(source);

      const refused = await MigrationEngine.migrate({
        from: { type: 'sqlite', path: sourceFile },
        to: { type: 'postgres', connectionString: POSTGRES_URL! },
      });

      expect(refused.verified).toBe(false);
      expect(refused.tablesProcessed).toEqual([]);
      expect(refusals(refused.errors)).toEqual(['scope_id_form']);
      const refiled = await openPostgres(refiledId);
      expect(await idsOn(refiled)).toEqual(['user:ana']);
      expect(await refiled.getMeta(SCOPE_ID_FORM_KEY)).toBe(ENCODED_SCOPE_ID_FORM);

      const filled = await MigrationEngine.migrate({
        from: { type: 'sqlite', path: olderReleaseFile(filledId, 't-old', 'ana') },
        to: { type: 'postgres', connectionString: POSTGRES_URL! },
      });

      expect(filled.errors).toEqual([]);
      const filledBrain = await openPostgres(filledId);
      expect(await filledBrain.all('SELECT id, scope_id FROM memory_traces WHERE brain_id = ?', [filledId])).toEqual([
        { id: 't-old', scope_id: 'ana' },
      ]);
    } finally {
      await cleanUp(refiledId, filledId);
    }
  });

  it('an import into a brain another process is re-filing waits for the re-file, and files the plain id it brings encoded', async () => {
    const brainId = newBrainId('import-lock');
    // A plain export, from a Brain no layer serves.
    const plain = await plainFacade((memory) => memory.remember(HIKES, { scope: 'user', scopeId: 'team/bo' }));
    const plainExport = await plain.memory.exportToString();
    try {
      const layer = await openPostgres(brainId);
      const writer = await openPostgres(brainId);
      const watcher = await openPostgres(brainId);
      const memory = await manager({ brain: layer });
      const bees = await tellAbout(memory, 'team/ana', BEES);
      const importer = await Memory.createPostgres(POSTGRES_URL!, { brainId });
      facades.push(importer);
      /** The backends that wait for a lock one backend holds. */
      const waitingOn = async (blocker: number) =>
        (await watcher.all<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))', [blocker])).map(
          (row) => Number(row.pid),
        );

      // Another process holds the trace's row in a transaction it keeps open, so the layer's re-file, which holds the
      // brain, waits on the row.
      let commit!: () => void;
      const committing = new Promise<void>((resolve) => (commit = resolve));
      let writing!: (pid: number) => void;
      const writerPid = new Promise<number>((resolve) => (writing = resolve));
      const holding = writer.transaction(async (trx) => {
        await trx.run('UPDATE memory_traces SET strength = strength WHERE brain_id = ? AND id = ?', [brainId, bees.id]);
        writing((await trx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid);
        await committing;
      });
      let refiling: Promise<number> | undefined;
      let importing: Promise<Awaited<ReturnType<Memory['importFromString']>>> | undefined;
      try {
        const holder = await writerPid;
        refiling = memory.ensureEncodedScopeIds();
        let refiler = 0;
        await vi.waitFor(
          async () => {
            const [waiting] = await waitingOn(holder);
            expect(waiting).toBeTypeOf('number');
            refiler = waiting!;
          },
          { timeout: 10_000, interval: 20 },
        );
        importing = importer.importFromString(plainExport, 'json');
        let settled = false;
        void importing.then(
          () => (settled = true),
          () => (settled = true),
        );
        // The import waits for the brain the re-file holds; one that does not wait ends first.
        await vi.waitFor(
          async () => {
            expect(settled || (await waitingOn(refiler)).length > 0).toBe(true);
          },
          { timeout: 10_000, interval: 20 },
        );
      } finally {
        commit();
      }
      await holding;

      expect(await refiling).toBe(1);
      expect((await importing!).errors).toEqual([]);
      expect(await idsOn(watcher)).toEqual(['user:team%2Fana', 'user:team%2Fbo']);
      expect(await watcher.getMeta(SCOPE_ID_FORM_KEY)).toBe(ENCODED_SCOPE_ID_FORM);
    } finally {
      await cleanUp(brainId);
    }
  });

  it("an Obsidian import into a brain on a pool of one connection ends: a note reads the brain's graph in its own transaction", async () => {
    const brainId = newBrainId('import-pool');
    // One connection, which a note's transaction holds: a read outside it would wait for it, and fail after 5 seconds.
    const adapter = createPostgresAdapter({
      connectionString: POSTGRES_URL!,
      max: 1,
      connectionTimeoutMillis: 5_000,
      typeParsers: { int8: 'number' },
    });
    await adapter.open();
    const brain = await Brain.openWithAdapter(adapter, { brainId });
    brains.add(brain);
    try {
      // A trace an earlier Obsidian import filed, its knowledge-graph node linked to a label that holds a line break.
      const label = 'the hive\nby the roof';
      await brain.run(
        `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata, scope_id)
         VALUES (?, 'mt-held', 'episodic', 'user', ?, 1, '{}', '')`,
        [brainId, BEES],
      );
      await brain.run(
        `INSERT INTO knowledge_nodes (brain_id, id, type, label, properties, created_at) VALUES (?, 'kn-trace', 'trace', 'trace:mt-held', ?, 1)`,
        [brainId, JSON.stringify({ trace_id: 'mt-held' })],
      );
      await brain.run(`INSERT INTO knowledge_nodes (brain_id, id, type, label, properties, created_at) VALUES (?, 'kn-label', 'concept', ?, '{}', 1)`, [
        brainId,
        label,
      ]);
      await brain.run(
        `INSERT INTO knowledge_edges (brain_id, id, source_id, target_id, type, weight, bidirectional, metadata, created_at)
         VALUES (?, 'ke-held', 'kn-trace', 'kn-label', 'related_to', 1.0, 0, '{}', 1)`,
        [brainId],
      );
      // The trace's own note, as the export writes it: its link runs over the label's line break.
      const vault = scratchDir();
      fs.writeFileSync(path.join(vault, 'mt-held.md'), `---\nid: mt-held\nscope: user\n---\n${BEES}\n\n**Related:**\n- [[${label}]]\n`);

      expect(await new ObsidianImporter(brain).import(vault)).toEqual({ imported: 0, skipped: 1, errors: [] });
    } finally {
      await cleanUp(brainId);
    }
  });
});

/** When the learning store's rows in these cases were written. */
const LEARNED_AT = '2026-10-31T08:00:00.000Z';
const LATER = '2026-10-31T09:00:00.000Z';
const LEARNER_DOC_TABLES = ['outcomes', 'lessons', 'skills'] as const;

/** A ledger row as the ledger writes one: by default a pending candidate of learner `42` of tenant `A` on agent `tutor`. */
function ledgerRow(over: Partial<StoredLedgerRow> & Pick<StoredLedgerRow, 'id' | 'chainKey' | 'seq'>): StoredLedgerRow {
  return {
    rowType: 'candidate',
    candidateId: over.id,
    namespace: 'A',
    agentKey: 'tutor',
    userId: '42',
    turnUserId: null,
    sessionId: 's-1',
    kind: 'memory_write',
    subject: 't-1',
    verdict: 'pending',
    body: JSON.stringify({ id: over.id }),
    prevHash: '0'.repeat(64),
    hash: `hash-${over.id}`,
    stateDigest: null,
    createdAt: LEARNED_AT,
    ...over,
  };
}

/** A chain's head at one of its rows. */
const headAt = (row: StoredLedgerRow): ChainHead => ({
  chainKey: row.chainKey,
  namespace: row.namespace,
  agentKey: row.agentKey,
  userId: row.userId,
  lastId: row.id,
  lastHash: row.hash,
  seq: row.seq,
  forgotten: false,
});

const traitRowOf = (version: number, state: string, userId = '42', namespace = 'A'): StoredTraitRow => ({
  namespace,
  agentKey: 'tutor',
  userId,
  personaId: 'tutor',
  state,
  version,
  updatedAt: LEARNED_AT,
});

const freezeOf = (scopeKey: string, mode: FreezeRow['mode'], setBy = 'operator:ops', userId: string | null = null): FreezeRow => ({
  scopeKey,
  mode,
  namespace: 'A',
  agentKey: userId === null ? null : 'tutor',
  userId,
  setBy,
  createdAt: LEARNED_AT,
});

const sessionOf = (over: Partial<SessionRow> & Pick<SessionRow, 'sessionId'>): SessionRow => ({
  namespace: 'A',
  agentKey: 'tutor',
  userId: '42',
  kind: 'learner',
  personaId: 'tutor',
  conversationIds: ['c-1'],
  brainIds: ['qa'],
  startedAt: LEARNED_AT,
  version: 1,
  ...over,
});

/** A learning store as a case opens it, with what writes the learner documents a host's tables hold, where the store has tables. */
interface OpenedLearningStore {
  store: LearningStore;
  addDoc?: (table: (typeof LEARNER_DOC_TABLES)[number], id: string, userId: string, namespace: string, createdAt?: string) => Promise<void>;
  close: () => Promise<void>;
}

/** A learner document row written straight into a SQL store's table, as a later release's writer files one. */
const docWriter =
  (adapter: StorageAdapter): NonNullable<OpenedLearningStore['addDoc']> =>
  async (table, id, userId, namespace, createdAt = LEARNED_AT) => {
    await adapter.run(
      `INSERT INTO agentos_learning_${table} (id, namespace, agent_key, user_id, body, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, namespace, 'tutor', userId, JSON.stringify({ id }), 1, createdAt, createdAt],
    );
  };

/** A SQLite database file of its own, removed after the test. */
function learningFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-learning-'));
  dirs.push(dir);
  return path.join(dir, 'learning.sqlite');
}

/** The host's SQLite database, opened through the storage library a host uses. */
const openSqliteAt = (file: string): Promise<StorageAdapter> => resolveStorageAdapter({ filePath: file, priority: ['better-sqlite3'], quiet: true });

/** What every learning store does, as a host calls it, over the stores `open` makes. */
function learningStoreCases(name: string, open: () => Promise<OpenedLearningStore>): void {
  describe(name, () => {
    const opened: OpenedLearningStore[] = [];
    const fresh = async (): Promise<OpenedLearningStore> => {
      const made = await open();
      opened.push(made);
      return made;
    };
    afterEach(async () => {
      for (const made of opened.splice(0)) await made.close();
    });

    it("keeps a learner's chain: its rows read back in order, its head moved only from the place it is at, and a row at a taken id or place refused without naming the chain", async () => {
      const { store } = await fresh();
      const chain = 'u|A|tutor|42';
      const candidate = ledgerRow({ id: 'c-1', chainKey: chain, seq: 1 });
      const verdict = ledgerRow({ id: 'v-1', chainKey: chain, seq: 2, rowType: 'verdict', candidateId: 'c-1', verdict: 'kept', prevHash: 'hash-c-1' });
      // The learner's row on another of its chains, and the rows of others: another learner of the agent, the agent's
      // own chain (a visitor's turn), the same user id in another tenant.
      const persona = ledgerRow({ id: 'p-1', chainKey: 'p|A|tutor|42', seq: 1, kind: 'trait' });
      const others = [
        ledgerRow({ id: 'o-1', chainKey: 'u|A|tutor|7', seq: 1, userId: '7' }),
        ledgerRow({ id: 'a-1', chainKey: 'a|A|tutor', seq: 1, userId: null, turnUserId: '42' }),
        ledgerRow({ id: 'b-1', chainKey: 'u|B|tutor|42', seq: 1, namespace: 'B' }),
      ];

      await store.transaction(async (tx) => {
        await tx.insertLedgerRow(candidate);
        expect(await tx.insertHead(headAt(candidate))).toBe(true);
      });
      const moved = await store.transaction(async (tx) => {
        await tx.insertLedgerRow(verdict);
        return tx.advanceHead(chain, 1, { lastId: verdict.id, lastHash: verdict.hash, seq: 2 });
      });
      expect(moved).toBe(true);
      for (const row of [persona, ...others]) await store.insertLedgerRow(row);

      expect(await store.ledgerRow('c-1')).toEqual(candidate);
      expect(await store.ledgerRow('no-such-row')).toBeUndefined();
      expect(await store.chainRows(chain)).toEqual([candidate, verdict]);
      expect(await store.candidateRows('c-1')).toEqual([candidate, verdict]);
      expect((await store.learnerLedgerRows('A', 'tutor', '42')).map((row) => row.id)).toEqual(['p-1', 'c-1', 'v-1']);
      expect(await store.head(chain)).toEqual(headAt(verdict));

      expect(await store.advanceHead(chain, 1, { lastId: 'stale', lastHash: 'stale', seq: 2 })).toBe(false);
      expect(await store.advanceHead('u|A|tutor|none', 0, { lastId: 'none', lastHash: 'none', seq: 1 })).toBe(false);
      expect(await store.insertHead(headAt(candidate))).toBe(false);
      expect(await store.head(chain)).toEqual(headAt(verdict));

      for (const taken of [ledgerRow({ id: 'c-1', chainKey: chain, seq: 3 }), ledgerRow({ id: 'c-9', chainKey: chain, seq: 2 })]) {
        const refusal = await store.insertLedgerRow(taken).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(refusal).toBeInstanceOf(Error);
        expect((refusal as Error).message).not.toContain(chain);
      }
      expect(await store.chainRows(chain)).toEqual([candidate, verdict]);
    });

    it("updates a learner's trait row only from the version it read, and keeps the first of each freeze, ordered by scope and mode", async () => {
      const { store } = await fresh();
      expect(await store.insertTraitRow(traitRowOf(1, '{"current":{"openness":0.5}}'))).toBe(true);
      expect(await store.insertTraitRow(traitRowOf(1, '{"current":{"openness":0.9}}'))).toBe(false);
      expect(await store.updateTraitRow(traitRowOf(2, '{"current":{"openness":0.6}}'), 1)).toBe(true);
      // A writer that read version 1 lost the race; a learner with no row has nothing to update.
      expect(await store.updateTraitRow(traitRowOf(2, '{"current":{"openness":0.1}}'), 1)).toBe(false);
      expect(await store.updateTraitRow(traitRowOf(1, '{}', '7'), 0)).toBe(false);
      expect(await store.traitRow('A', 'tutor', '42')).toEqual(traitRowOf(2, '{"current":{"openness":0.6}}'));
      expect(await store.traitRow('A', 'tutor', '7')).toBeUndefined();

      await store.insertFreeze(freezeOf('learner|A|tutor|42', 'frozen', 'operator:ana', '42'));
      await store.insertFreeze(freezeOf('learner|A|tutor|42', 'frozen', 'operator:bo', '42'));
      await store.insertFreeze(freezeOf('all', 'off'));
      await store.insertFreeze(freezeOf('all', 'frozen'));
      await store.insertFreeze(freezeOf('agent|tutor', 'frozen'));
      expect((await store.freezeRows()).map((row) => [row.scopeKey, row.mode, row.setBy])).toEqual([
        ['agent|tutor', 'frozen', 'operator:ops'],
        ['all', 'frozen', 'operator:ops'],
        ['all', 'off', 'operator:ops'],
        ['learner|A|tutor|42', 'frozen', 'operator:ana'],
      ]);
      expect(await store.deleteFreeze('all', 'off')).toBe(true);
      expect(await store.deleteFreeze('all', 'off')).toBe(false);
      expect((await store.freezeRows()).map((row) => `${row.scopeKey} ${row.mode}`)).toEqual([
        'agent|tutor frozen',
        'all frozen',
        'learner|A|tutor|42 frozen',
      ]);
    });

    it("keeps a session row's start when it is written again, and lists one user's sessions of both kinds, every agent's, in one namespace", async () => {
      const { store } = await fresh();
      await store.putSessionRow(sessionOf({ sessionId: 's-1' }));
      await store.putSessionRow(sessionOf({ sessionId: 's-1', startedAt: LATER, conversationIds: ['c-1', 'c-2'], brainIds: ['qa', 'tools'], version: 2 }));
      expect(await store.sessionRow('A', 'tutor', 's-1', '42', 'learner')).toEqual(
        sessionOf({ sessionId: 's-1', conversationIds: ['c-1', 'c-2'], brainIds: ['qa', 'tools'], version: 2 }),
      );
      await store.putSessionRow(sessionOf({ sessionId: 's-1', kind: 'visitor', agentKey: 'coach' }));
      await store.putSessionRow(sessionOf({ sessionId: 's-0' }));
      await store.putSessionRow(sessionOf({ sessionId: 's-1', userId: '7' }));
      await store.putSessionRow(sessionOf({ sessionId: 's-1', namespace: 'B' }));

      expect((await store.sessionRowsOf('A', '42')).map((row) => [row.sessionId, row.kind, row.agentKey])).toEqual([
        ['s-0', 'learner', 'tutor'],
        ['s-1', 'learner', 'tutor'],
        ['s-1', 'visitor', 'coach'],
      ]);
      expect(await store.sessionRow('A', 'tutor', 's-1', '42', 'visitor')).toBeUndefined();
    });

    it("forgets a user in one namespace: marks the user's heads, deletes every row of theirs and counts them, and keeps the tombstone and every other user's and tenant's rows", async () => {
      const made = await fresh();
      const { store } = made;
      const chain = 'u|A|tutor|42';
      const first = ledgerRow({ id: 'c-1', chainKey: chain, seq: 1 });
      const second = ledgerRow({ id: 'v-1', chainKey: chain, seq: 2, rowType: 'verdict', candidateId: 'c-1', verdict: 'kept' });
      // The user's turn on another learner's session, on the agent's chain: its row names the user as turnUserId.
      const visit = ledgerRow({ id: 'a-1', chainKey: 'a|A|tutor', seq: 1, userId: null, turnUserId: '42' });
      const otherUser = ledgerRow({ id: 'o-1', chainKey: 'u|A|tutor|7', seq: 1, userId: '7' });
      const otherTenant = ledgerRow({ id: 'b-1', chainKey: 'u|B|tutor|42', seq: 1, namespace: 'B' });
      for (const row of [first, second, visit, otherUser, otherTenant]) await store.insertLedgerRow(row);
      for (const row of [second, visit, otherUser, otherTenant]) await store.insertHead(headAt(row));
      await store.insertTraitRow(traitRowOf(1, '{}'));
      await store.insertTraitRow(traitRowOf(1, '{}', '7'));
      await store.insertTraitRow(traitRowOf(1, '{}', '42', 'B'));
      await store.insertFreeze(freezeOf('learner|A|tutor|42', 'frozen', 'operator:ops', '42'));
      await store.insertFreeze(freezeOf('learner|A|tutor|7', 'frozen', 'operator:ops', '7'));
      await store.insertFreeze(freezeOf('all', 'frozen'));
      await store.putSessionRow(sessionOf({ sessionId: 's-1' }));
      await store.putSessionRow(sessionOf({ sessionId: 's-2', kind: 'visitor' }));
      await store.putSessionRow(sessionOf({ sessionId: 's-1', userId: '7' }));
      for (const table of LEARNER_DOC_TABLES) {
        await made.addDoc?.(table, `${table}-42`, '42', 'A');
        await made.addDoc?.(table, `${table}-7`, '7', 'A');
        await made.addDoc?.(table, `${table}-42-b`, '42', 'B');
      }
      const docs = made.addDoc ? 1 : 0;

      expect(await store.markHeadsForgotten('A', '42')).toBe(1);
      expect(await store.head(chain)).toEqual({ ...headAt(second), forgotten: true });
      expect(await store.advanceHead(chain, 2, { lastId: 'late', lastHash: 'late', seq: 3 })).toBe(false);
      expect(await store.head('u|B|tutor|42')).toEqual(headAt(otherTenant));
      await store.insertForgotten('tombstone-42', LATER);
      await store.insertForgotten('tombstone-42', LATER);
      expect(await store.isForgotten('tombstone-42')).toBe(true);
      expect(await store.isForgotten('tombstone-7')).toBe(false);

      expect(await store.deleteUserRows('A', '42')).toEqual({
        ledger: 3,
        heads: 1,
        traits: 1,
        outcomes: docs,
        lessons: docs,
        skills: docs,
        sessions: 2,
        freezes: 1,
      });

      expect(await store.learnerLedgerRows('A', 'tutor', '42')).toEqual([]);
      expect(await store.ledgerRow('a-1')).toBeUndefined();
      expect(await store.head(chain)).toBeUndefined();
      expect(await store.traitRow('A', 'tutor', '42')).toBeUndefined();
      expect(await store.sessionRowsOf('A', '42')).toEqual([]);
      expect((await store.freezeRows()).map((row) => row.scopeKey)).toEqual(['all', 'learner|A|tutor|7']);
      expect(await store.isForgotten('tombstone-42')).toBe(true);
      expect((await store.learnerLedgerRows('A', 'tutor', '7')).map((row) => row.id)).toEqual(['o-1']);
      expect((await store.learnerLedgerRows('B', 'tutor', '42')).map((row) => row.id)).toEqual(['b-1']);
      expect(await store.head('a|A|tutor')).toEqual(headAt(visit));
      expect(await store.traitRow('A', 'tutor', '7')).toEqual(traitRowOf(1, '{}', '7'));
      expect(await store.traitRow('B', 'tutor', '42')).toEqual(traitRowOf(1, '{}', '42', 'B'));
      expect((await store.sessionRowsOf('A', '7')).map((row) => row.sessionId)).toEqual(['s-1']);
      for (const table of LEARNER_DOC_TABLES) {
        expect(await store.learnerDocs(table, 'A', 'tutor', '42')).toEqual([]);
        expect((await store.learnerDocs(table, 'A', 'tutor', '7')).map((doc) => doc.id)).toEqual(made.addDoc ? [`${table}-7`] : []);
        expect((await store.learnerDocs(table, 'B', 'tutor', '42')).map((doc) => doc.id)).toEqual(made.addDoc ? [`${table}-42-b`] : []);
      }
      expect(await store.deleteUserRows('A', '42')).toEqual({ ledger: 0, heads: 0, traits: 0, outcomes: 0, lessons: 0, skills: 0, sessions: 0, freezes: 0 });
    });

    it('takes back every write of a transaction whose function throws, a deletion included, and a read made meanwhile sees none of them', async () => {
      const { store } = await fresh();
      const kept = ledgerRow({ id: 'k-1', chainKey: 'u|A|tutor|7', seq: 1, userId: '7' });
      await store.insertLedgerRow(kept);
      await store.insertTraitRow(traitRowOf(1, '{"kept":true}', '7'));
      const candidate = ledgerRow({ id: 'c-1', chainKey: 'u|A|tutor|42', seq: 1 });
      let wrote!: () => void;
      const written = new Promise<void>((resolve) => (wrote = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));

      const failing = store.transaction(async (tx) => {
        try {
          await tx.insertLedgerRow(candidate);
          await tx.insertHead(headAt(candidate));
          await tx.insertTraitRow(traitRowOf(1, '{}'));
          expect(await tx.updateTraitRow(traitRowOf(2, '{"kept":false}', '7'), 1)).toBe(true);
          await tx.insertFreeze(freezeOf('all', 'frozen'));
          await tx.putSessionRow(sessionOf({ sessionId: 's-1' }));
          await tx.insertForgotten('tombstone-7', LATER);
          expect(await tx.deleteUserRows('A', '7')).toMatchObject({ ledger: 1, traits: 1 });
          // The function reads its own writes.
          expect(await tx.ledgerRow('c-1')).toEqual(candidate);
        } finally {
          wrote();
        }
        await released;
        throw new Error('the change failed its check');
      });
      await written;
      const readMeanwhile = store.ledgerRow('c-1');
      release();

      await expect(failing).rejects.toThrow('the change failed its check');
      expect(await readMeanwhile).toBeUndefined();
      expect(await store.ledgerRow('c-1')).toBeUndefined();
      expect(await store.head('u|A|tutor|42')).toBeUndefined();
      expect(await store.traitRow('A', 'tutor', '42')).toBeUndefined();
      expect(await store.freezeRows()).toEqual([]);
      expect(await store.sessionRowsOf('A', '42')).toEqual([]);
      expect(await store.isForgotten('tombstone-7')).toBe(false);
      expect(await store.ledgerRow('k-1')).toEqual(kept);
      expect(await store.traitRow('A', 'tutor', '7')).toEqual(traitRowOf(1, '{"kept":true}', '7'));

      // A function's result is the transaction's, and a handle kept past its transaction refuses every call.
      const leaked: { tx?: LearningStoreTx } = {};
      const result = await store.transaction(async (tx) => {
        leaked.tx = tx;
        await tx.insertForgotten('in-time', LATER);
        return 'committed';
      });
      expect(result).toBe('committed');
      await expect(leaked.tx!.insertForgotten('too-late', LATER)).rejects.toThrow(/after it ended/);
      expect(await store.isForgotten('in-time')).toBe(true);
      expect(await store.isForgotten('too-late')).toBe(false);
    });

    it('keeps copies of the rows it is given, and hands out copies', async () => {
      const { store } = await fresh();
      const row = ledgerRow({ id: 'c-1', chainKey: 'u|A|tutor|42', seq: 1 });
      await store.insertLedgerRow(row);
      row.subject = 'changed after the write';
      const read = (await store.ledgerRow('c-1'))!;
      expect(read.subject).toBe('t-1');
      read.subject = 'changed after the read';
      expect((await store.ledgerRow('c-1'))!.subject).toBe('t-1');

      const session = sessionOf({ sessionId: 's-1' });
      await store.putSessionRow(session);
      session.conversationIds.push('c-9');
      (await store.sessionRowsOf('A', '42'))[0]!.brainIds.push('elsewhere');
      expect(await store.sessionRow('A', 'tutor', 's-1', '42', 'learner')).toEqual(sessionOf({ sessionId: 's-1' }));
    });
  });
}

/** What a column a later release adds does to the tables of a store an earlier release made, on the database `adapter` reaches. */
async function laterColumnReachesEarlierTables(adapter: StorageAdapter): Promise<void> {
  const earlier = new SqlLearningStore({ adapter });
  expect(await earlier.learnerDocs('outcomes', 'A', 'tutor', '42')).toEqual([]);
  await docWriter(adapter)('outcomes', 'o-1', '42', 'A');
  const later: LearningColumnAddition[] = [{ table: 'agentos_learning_outcomes', column: 'team_source', definition: 'TEXT' }];

  await ensureLearningSchema(adapter, later);
  await ensureLearningSchema(adapter, later);

  expect(await adapter.get('SELECT id, team_source FROM agentos_learning_outcomes')).toEqual({ id: 'o-1', team_source: null });
  expect((await earlier.learnerDocs('outcomes', 'A', 'tutor', '42')).map((doc) => doc.id)).toEqual(['o-1']);
  await expect(
    ensureLearningSchema(adapter, [{ table: 'agentos_learning_outcomes', column: 'team source', definition: 'TEXT' }]),
  ).rejects.toThrow();
}

describe('the learning store', () => {
  learningStoreCases('in the process', async () => ({ store: new InMemoryLearningStore(), close: async () => undefined }));

  learningStoreCases('over a SQLite file', async () => {
    const adapter = await openSqliteAt(learningFile());
    const store = new SqlLearningStore({ adapter });
    return {
      store,
      addDoc: docWriter(adapter),
      close: async () => {
        await store.close();
        await adapter.close();
      },
    };
  });

  it('over a SQLite file makes its ten tables at its first call, and a store over the same file after a restart reads what the first wrote', async () => {
    const file = learningFile();
    const adapter = await openSqliteAt(file);
    const store = new SqlLearningStore({ adapter });
    const candidate = ledgerRow({ id: 'c-1', chainKey: 'u|A|tutor|42', seq: 1 });
    expect(store.kind).toBe('sql');
    try {
      expect(await store.isForgotten('tombstone-7')).toBe(false);
      const tables = await adapter.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agentos_learning%' ORDER BY name",
      );
      expect(LEARNING_TABLES).toHaveLength(10);
      expect(tables.map((table) => table.name)).toEqual([...LEARNING_TABLES].sort());

      await store.transaction(async (tx) => {
        await tx.insertLedgerRow(candidate);
        await tx.insertHead(headAt(candidate));
        await tx.insertTraitRow(traitRowOf(1, '{"current":{"openness":0.5}}'));
        await tx.insertFreeze(freezeOf('all', 'frozen'));
        await tx.putSessionRow(sessionOf({ sessionId: 's-1' }));
        await tx.insertForgotten('tombstone-7', LATER);
      });
    } finally {
      await store.close();
      await adapter.close();
    }

    const reopened = await openSqliteAt(file);
    try {
      const again = new SqlLearningStore({ adapter: reopened });
      expect(await again.chainRows('u|A|tutor|42')).toEqual([candidate]);
      expect(await again.head('u|A|tutor|42')).toEqual(headAt(candidate));
      expect(await again.traitRow('A', 'tutor', '42')).toEqual(traitRowOf(1, '{"current":{"openness":0.5}}'));
      expect(await again.freezeRows()).toEqual([freezeOf('all', 'frozen')]);
      expect(await again.sessionRowsOf('A', '42')).toEqual([sessionOf({ sessionId: 's-1' })]);
      expect(await again.isForgotten('tombstone-7')).toBe(true);
    } finally {
      await reopened.close();
    }
  });

  it("leaves the host's adapter open when it closes, refuses an adapter without transactions by its kind, and makes no table when the product runs the DDL itself", async () => {
    const adapter = await openSqliteAt(learningFile());
    try {
      const store = new SqlLearningStore({ adapter });
      await store.insertForgotten('tombstone-42', LEARNED_AT);
      await store.close();
      expect(await adapter.get('SELECT hash, forgotten_at FROM agentos_learning_forgotten')).toEqual({ hash: 'tombstone-42', forgotten_at: LEARNED_AT });

      const without = Object.assign(Object.create(adapter) as StorageAdapter, { capabilities: new Set() });
      expect(() => new SqlLearningStore({ adapter: without })).toThrow(/transactions/);
      expect(() => new SqlLearningStore({ adapter: without })).toThrow(adapter.kind);
    } finally {
      await adapter.close();
    }

    const migrated = await openSqliteAt(learningFile());
    try {
      const store = new SqlLearningStore({ adapter: migrated, ensureSchema: false });
      await expect(store.isForgotten('tombstone-42')).rejects.toThrow(/no such table/);
      await migrated.exec(LEARNING_SCHEMA_DDL);
      expect(await store.isForgotten('tombstone-42')).toBe(false);
    } finally {
      await migrated.close();
    }
  });

  it('makes its tables at its next call when its first attempt failed', async () => {
    const adapter = await openSqliteAt(learningFile());
    try {
      let failures = 1;
      const unreachableOnce = new Proxy(adapter, {
        get(target, property) {
          if (property === 'exec' && failures > 0) {
            return async () => {
              failures -= 1;
              throw new Error('the database is not reachable');
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const store = new SqlLearningStore({ adapter: unreachableOnce });
      await expect(store.isForgotten('tombstone-42')).rejects.toThrow('the database is not reachable');
      await store.insertForgotten('tombstone-42', LEARNED_AT);
      expect(await store.isForgotten('tombstone-42')).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it('over a SQLite file takes a column a later release adds into the tables an earlier release made, with their rows, and refuses a column name that is not a plain identifier', async () => {
    const adapter = await openSqliteAt(learningFile());
    try {
      await laterColumnReachesEarlierTables(adapter);
    } finally {
      await adapter.close();
    }
  });

  it('names the store, its rows and what a ledger row records in the types a host imports', () => {
    const inProcess: LearningStore = new InMemoryLearningStore();
    expect(inProcess.kind).toBe('memory');
    expectTypeOf<LearningStore['kind']>().toEqualTypeOf<'sql' | 'memory'>();
    expectTypeOf<StoredLedgerRow['kind']>().toEqualTypeOf<LearningKind>();
    expectTypeOf<StoredLedgerRow['verdict']>().toEqualTypeOf<LedgerVerdict>();
    expectTypeOf<LedgerVerdict>().toEqualTypeOf<'pending' | 'kept' | 'reverted' | 'rejected'>();
    expectTypeOf<Extract<LearningKind, 'memory_write' | 'operator_set' | 'trait'>>().toEqualTypeOf<'memory_write' | 'operator_set' | 'trait'>();
    expectTypeOf<SqlLearningStoreOptions['ensureSchema']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Awaited<ReturnType<LearningStore['deleteUserRows']>>>().toEqualTypeOf<Record<string, number>>();
    expectTypeOf<(typeof LEARNING_TABLES)[number]>().toEqualTypeOf<LearningTable>();
  });
});

describe.skipIf(!POSTGRES_URL)('the learning store on Postgres', () => {
  /** This run's own mark, in the names of the schemas its cases make and drop. */
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const segments: string[] = [];

  /** A new schema of this run's own, dropped once the cases have run. */
  function newSegment(): string {
    const segment = `qa_learning_${run}_${segments.length}`;
    segments.push(segment);
    return segment;
  }

  /** The host's Postgres adapter, its tables in `segment`: by default a new schema of this run's own. */
  async function openPostgresAdapter(segment: string = newSegment()): Promise<StorageAdapter> {
    const adapter = createPostgresAdapter({ connectionString: POSTGRES_URL!, segment, max: 5 });
    await adapter.open();
    return adapter;
  }

  afterAll(async () => {
    if (segments.length === 0) return;
    const admin = createPostgresAdapter({ connectionString: POSTGRES_URL! });
    await admin.open();
    try {
      for (const segment of segments) await admin.exec(`DROP SCHEMA IF EXISTS "${segment}" CASCADE`);
    } finally {
      await admin.close();
    }
  });

  learningStoreCases('over a schema of its own', async () => {
    const adapter = await openPostgresAdapter();
    const store = new SqlLearningStore({ adapter });
    return {
      store,
      addDoc: docWriter(adapter),
      close: async () => {
        await store.close();
        await adapter.close();
      },
    };
  });

  it("orders what it reads by code unit, whatever order the database's collation gives text", async () => {
    const adapter = await openPostgresAdapter();
    const store = new SqlLearningStore({ adapter });
    try {
      for (const scopeKey of ['agent|b', 'agent|C', 'agent|a']) await store.insertFreeze(freezeOf(scopeKey, 'frozen'));
      expect((await store.freezeRows()).map((row) => row.scopeKey)).toEqual(['agent|C', 'agent|a', 'agent|b']);
      for (const sessionId of ['s-b', 's-C', 's-a']) await store.putSessionRow(sessionOf({ sessionId }));
      expect((await store.sessionRowsOf('A', '42')).map((row) => row.sessionId)).toEqual(['s-C', 's-a', 's-b']);
      for (const [at, chainKey] of ['u|A|tutor|42|b', 'u|A|tutor|42|C', 'u|A|tutor|42|a'].entries()) {
        await store.insertLedgerRow(ledgerRow({ id: `r-${at}`, chainKey, seq: 1 }));
      }
      expect((await store.learnerLedgerRows('A', 'tutor', '42')).map((row) => row.chainKey)).toEqual([
        'u|A|tutor|42|C',
        'u|A|tutor|42|a',
        'u|A|tutor|42|b',
      ]);
      for (const id of ['b', 'C', 'a']) await docWriter(adapter)('lessons', id, '42', 'A');
      expect((await store.learnerDocs('lessons', 'A', 'tutor', '42')).map((doc) => doc.id)).toEqual(['C', 'a', 'b']);
    } finally {
      await store.close();
      await adapter.close();
    }
  });

  it("lets one of two stores over one database, as two processes hold them, move a chain's head, and refuses the other's swap from the place it read and its row at the taken place", async () => {
    const segment = newSegment();
    const one = await openPostgresAdapter(segment);
    const two = await openPostgresAdapter(segment);
    const first = new SqlLearningStore({ adapter: one });
    const second = new SqlLearningStore({ adapter: two });
    try {
      const chain = 'u|A|tutor|42';
      const started = ledgerRow({ id: 'c-1', chainKey: chain, seq: 1 });
      await first.transaction(async (tx) => {
        await tx.insertLedgerRow(started);
        await tx.insertHead(headAt(started));
      });
      // The second process reads the head at seq 1.
      expect(await second.head(chain)).toEqual(headAt(started));
      const fromFirst = ledgerRow({ id: 'c-2', chainKey: chain, seq: 2 });
      expect(
        await first.transaction(async (tx) => {
          await tx.insertLedgerRow(fromFirst);
          return tx.advanceHead(chain, 1, { lastId: fromFirst.id, lastHash: fromFirst.hash, seq: 2 });
        }),
      ).toBe(true);

      expect(await second.advanceHead(chain, 1, { lastId: 'c-3', lastHash: 'hash-c-3', seq: 2 })).toBe(false);
      await expect(second.insertLedgerRow(ledgerRow({ id: 'c-3', chainKey: chain, seq: 2 }))).rejects.toThrow();
      expect(await second.chainRows(chain)).toEqual([started, fromFirst]);
      expect(await second.head(chain)).toEqual(headAt(fromFirst));
      expect(await first.ledgerRow('c-3')).toBeUndefined();
    } finally {
      await one.close();
      await two.close();
    }
  });

  it('takes a column a later release adds into the tables an earlier release made, with their rows, and refuses a column name that is not a plain identifier', async () => {
    const adapter = await openPostgresAdapter();
    try {
      await laterColumnReachesEarlierTables(adapter);
    } finally {
      await adapter.close();
    }
  });
});

/** The learner the ledger cases record for: user `42` of tenant `A` on agent `tutor`. */
const LEDGER_LEARNER: LedgerLearner = { namespace: 'A', agentKey: 'tutor', userId: '42' };
/** The ledger's clock in these cases: one moment, so every row a case writes was made at LEARNED_AT. */
const ledgerClock = (): number => Date.parse(LEARNED_AT);
/** The secret a host keys its ledger's hashes with. */
const LEDGER_KEY = 'qa-ledger-key-5b1c';

/** A self-change a host proposes for the learner: by default a rule's step of openness. */
const selfChange = (subject: string, over: Partial<CandidateInput> = {}): CandidateInput => ({
  learner: LEDGER_LEARNER,
  kind: 'trait',
  actor: 'rule:style.shorter@1',
  subject,
  before: { openness: 0.5 },
  after: { openness: 0.6 },
  evidence: { note: 'qa' },
  sessionId: 's-1',
  ...over,
});

/** An operator's act: a learner's traits set by hand. */
const operatorAct = (userId: string | null = '42'): CandidateInput =>
  selfChange('traits', { learner: { ...LEDGER_LEARNER, userId }, kind: 'operator_set', actor: 'operator:ops', before: null, after: { openness: 0.5 } });

/** A ledger over `store` on the cases' clock. */
const ledgerOver = (store: LearningStore, options: Omit<LedgerOptions, 'store'> = {}): Ledger =>
  new Ledger({ store, clock: ledgerClock, ...options });

/** What `propose` wrote; a failure naming its answer when it wrote nothing. */
function appended(result: ProposeResult): Extract<ProposeResult, { rows: LedgerEntry[] }> {
  if (!('rows' in result)) throw new Error(`propose answered ${result.status}`);
  return result;
}

/**
 * `store` as a writer in a race sees it: its next `times` transactions read each chain's head one row back, as it stood
 * before another writer appended, so their compare-and-swap loses.
 */
function racedStore(store: LearningStore, times: number): LearningStore {
  let left = times;
  const behind = (tx: LearningStoreTx): LearningStoreTx =>
    new Proxy(tx, {
      get(target, property) {
        if (property === 'head') {
          return async (chainKey: string) => {
            const head = await target.head(chainKey);
            return head ? { ...head, seq: head.seq - 1, lastHash: 'stale' } : head;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return new Proxy(store, {
    get(target, property) {
      if (property === 'transaction') {
        return <T>(fn: (tx: LearningStoreTx) => Promise<T>): Promise<T> =>
          target.transaction((tx) => {
            if (left <= 0) return fn(tx);
            left -= 1;
            return fn(behind(tx));
          });
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** `store` over a disk that refuses every ledger row: each transaction's `insertLedgerRow` throws. */
function refusingRows(store: LearningStore): LearningStore {
  const refusing = (tx: LearningStoreTx): LearningStoreTx =>
    new Proxy(tx, {
      get(target, property) {
        if (property === 'insertLedgerRow') {
          return async () => {
            throw new Error('the disk is full');
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return new Proxy(store, {
    get(target, property) {
      if (property === 'transaction') {
        return <T>(fn: (tx: LearningStoreTx) => Promise<T>): Promise<T> => target.transaction((tx) => fn(refusing(tx)));
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * What the ledger does over a store, as a host calls it. `oneAtATime`: the store runs one transaction at a time in this
 * process (the in-process store, a SQLite file), so appends made at once all land.
 */
function ledgerCases(name: string, open: () => Promise<OpenedLearningStore>, oneAtATime: boolean): void {
  describe(name, () => {
    const opened: OpenedLearningStore[] = [];
    const fresh = async (): Promise<LearningStore> => {
      const made = await open();
      opened.push(made);
      return made.store;
    };
    afterEach(async () => {
      for (const made of opened.splice(0)) await made.close();
    });

    it("chains a learner's candidate and its verdict: each row the canonical text of its entry, hashed and linked to the row before it, the head at the newest row, and the chain verifies", async () => {
      const store = await fresh();
      const ledger = ledgerOver(store, { versions: { model: 'stub-model' } });
      const key = chainKeyOf(LEDGER_LEARNER);
      expect(key).toBe('u|A|tutor|42');
      const version = (JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

      const proposed = appended(await ledger.propose(selfChange('openness', { versions: { rules: 'style@1' } })));
      expect(proposed.status).toBe('pending');
      expect(proposed).not.toHaveProperty('verdict');
      const candidate = proposed.candidate;
      expect(proposed.rows).toEqual([candidate]);
      expect(candidate.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(candidate).toEqual({
        id: candidate.id,
        rowType: 'candidate',
        candidateId: candidate.id,
        learner: LEDGER_LEARNER,
        kind: 'trait',
        actor: 'rule:style.shorter@1',
        subject: 'openness',
        before: { openness: 0.5 },
        after: { openness: 0.6 },
        evidence: { note: 'qa' },
        verdict: 'pending',
        reason: 'pending',
        versions: { agentos: version, rules: 'style@1', renderer: 1, probes: 'none', model: 'stub-model' },
        sessionId: 's-1',
        prevHash: GENESIS_HASH,
        seq: 1,
        createdAt: LEARNED_AT,
      });

      const decided = await ledger.decide(candidate.id, 'kept', 'no rendered change', {
        evidence: { signals: { shorter: 1 } },
        stateDigest: 'digest-1',
      });
      if (decided.status !== 'kept') throw new Error(`decide answered ${decided.status}`);
      const verdict = decided.verdict;
      expect(verdict).toEqual({
        id: verdict.id,
        rowType: 'verdict',
        candidateId: candidate.id,
        learner: LEDGER_LEARNER,
        kind: 'trait',
        actor: 'rule:style.shorter@1',
        subject: 'openness',
        before: null,
        after: null,
        evidence: { signals: { shorter: 1 } },
        verdict: 'kept',
        reason: 'no rendered change',
        versions: candidate.versions,
        sessionId: 's-1',
        prevHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        seq: 2,
        stateDigest: 'digest-1',
        createdAt: LEARNED_AT,
      });

      const rows = await store.chainRows(key);
      expect(rows.map((row) => row.id)).toEqual([candidate.id, verdict.id]);
      expect([...rows.map((row) => row.id)].sort()).toEqual(rows.map((row) => row.id));
      for (const [at, entry] of [candidate, verdict].entries()) {
        const row = rows[at]!;
        expect(row.body).toBe(canonicalJson(entry));
        expect(row.hash).toBe(await sha256Hex(row.body));
        expect(row).toMatchObject({
          chainKey: key,
          seq: entry.seq,
          rowType: entry.rowType,
          candidateId: candidate.id,
          namespace: 'A',
          agentKey: 'tutor',
          userId: '42',
          turnUserId: null,
          sessionId: 's-1',
          kind: 'trait',
          subject: 'openness',
          verdict: entry.verdict,
          prevHash: entry.prevHash,
          stateDigest: entry.stateDigest ?? null,
          createdAt: LEARNED_AT,
        });
      }
      expect(rows[1]!.prevHash).toBe(rows[0]!.hash);
      expect(await store.head(key)).toEqual({
        chainKey: key,
        namespace: 'A',
        agentKey: 'tutor',
        userId: '42',
        lastId: verdict.id,
        lastHash: rows[1]!.hash,
        seq: 2,
        forgotten: false,
      });
      expect(await ledger.latestVerdict(candidate.id)).toBe('kept');
      expect(await ledger.latestVerdict('no-such-candidate')).toBeUndefined();
      expect(await ledger.entries(key)).toEqual([candidate, verdict]);
      expect(await ledger.latestStateRow(key, ['trait'])).toEqual(verdict);
      expect(await ledger.latestStateRow(key, ['lesson'])).toBeUndefined();
      expect(ledger.keyed).toBe(false);
      expect(await ledger.verifyChain(key)).toEqual({ ok: true, keyed: false });
    });

    it("runs the change in its rows' transaction: a change that throws leaves no row, no head and none of its own writes, a value with no JSON form writes nothing, a change that returns commits with its rows, and a store error writing the rows runs no change and leaves the head where it stood", async () => {
      const store = await fresh();
      const ledger = ledgerOver(store);
      const key = chainKeyOf(LEDGER_LEARNER);
      const stepped = traitRowOf(1, '{"current":{"openness":0.6}}');
      await expect(
        ledger.propose(selfChange('openness'), {
          verdict: 'kept',
          change: async (tx) => {
            expect(await tx.insertTraitRow(stepped)).toBe(true);
            throw new Error('the rendered personality could not be written');
          },
        }),
      ).rejects.toThrow('the rendered personality could not be written');
      const contained: Record<string, unknown> = { openness: 0.6 };
      contained.again = { contained };
      await expect(ledger.propose(selfChange('openness', { after: { openness: BigInt(6) } }))).rejects.toThrow(TypeError);
      await expect(ledger.propose(selfChange('openness', { after: contained }))).rejects.toThrow(TypeError);
      expect(await store.chainRows(key)).toEqual([]);
      expect(await store.head(key)).toBeUndefined();
      expect(await store.traitRow('A', 'tutor', '42')).toBeUndefined();

      const kept = appended(
        await ledger.propose(selfChange('openness'), {
          verdict: 'kept',
          stateDigest: 'digest-1',
          change: async (tx, rows) => {
            expect(rows.map((row) => [row.rowType, row.verdict])).toEqual([
              ['candidate', 'pending'],
              ['verdict', 'kept'],
            ]);
            await tx.insertTraitRow(stepped);
          },
        }),
      );
      expect(kept.status).toBe('kept');
      expect(kept.candidate).toMatchObject({ verdict: 'pending', reason: 'kept' });
      expect(kept.candidate).not.toHaveProperty('stateDigest');
      expect(kept.verdict).toMatchObject({ rowType: 'verdict', candidateId: kept.candidate.id, verdict: 'kept', reason: 'kept', stateDigest: 'digest-1' });
      expect(kept.rows).toEqual([kept.candidate, kept.verdict]);
      expect(await store.traitRow('A', 'tutor', '42')).toEqual(stepped);
      expect(await ledger.verifyChain(key)).toEqual({ ok: true, keyed: false });

      // A store error writing the rows reaches the caller: the head the append moved first is back where it stood, and
      // the change never runs, so a change with no record does not happen.
      let ran = false;
      await expect(
        ledgerOver(refusingRows(store)).propose(selfChange('agreeableness'), {
          verdict: 'kept',
          change: async () => {
            ran = true;
          },
        }),
      ).rejects.toThrow('the disk is full');
      expect(ran).toBe(false);
      expect(await store.head(key)).toMatchObject({ seq: 2, lastId: kept.rows[1]!.id });
      expect(await store.chainRows(key)).toHaveLength(2);
      expect(await ledger.verifyChain(key)).toEqual({ ok: true, keyed: false });
    });

    it("chains a row with no learner under the agent and a second user's under that user, keeps every id's part apart, refuses a second user on a learner's row, and a user's deletion takes that user's chains whole and leaves the others verifying", async () => {
      const store = await fresh();
      const ledger = ledgerOver(store);
      const agentRow = { ...LEDGER_LEARNER, userId: null };
      const memoryWrite = (over: Partial<CandidateInput>): CandidateInput =>
        selfChange('trace-1', { kind: 'memory_write', actor: 'memory:tools', before: null, after: { content: 'Ana plays the cello.' }, ...over });

      appended(await ledger.propose(memoryWrite({}), { verdict: 'kept' }));
      appended(await ledger.propose(memoryWrite({ learner: agentRow }), { verdict: 'kept' }));
      const visitor = appended(await ledger.propose(memoryWrite({ learner: agentRow, turnUserId: 'bo' }), { verdict: 'kept' }));
      const blank = appended(await ledger.propose(memoryWrite({ learner: agentRow, turnUserId: '' }), { verdict: 'kept' }));
      appended(await ledger.propose(memoryWrite({ learner: { ...LEDGER_LEARNER, userId: 'bo' } }), { verdict: 'kept' }));

      expect(chainKeyOf(agentRow)).toBe('a|A|tutor');
      expect(chainKeyOf(agentRow, 'bo')).toBe('t|A|tutor|bo');
      expect(chainKeyOf(agentRow, '')).toBe('a|A|tutor');
      expect(visitor.candidate.turnUserId).toBe('bo');
      expect(blank.candidate).not.toHaveProperty('turnUserId');
      expect(await store.chainRows('a|A|tutor')).toHaveLength(4);
      expect((await store.chainRows('t|A|tutor|bo')).map((row) => [row.userId, row.turnUserId])).toEqual([
        [null, 'bo'],
        [null, 'bo'],
      ]);
      expect(await store.head('a|A|tutor')).toMatchObject({ userId: null, seq: 4 });
      expect(await store.head('t|A|tutor|bo')).toMatchObject({ userId: 'bo', seq: 2 });
      expect(await store.head('u|A|tutor|bo')).toMatchObject({ userId: 'bo', seq: 2 });

      // Each part of a key is percent-encoded, so no id moves the boundary between two parts.
      expect(chainKeyOf({ namespace: 'org/1', agentKey: 'tutor', userId: 'auth0|ana' })).toBe('u|org%2F1|tutor|auth0%7Cana');
      expect(chainKeyOf({ namespace: 'A', agentKey: 'tutor|auth0', userId: 'ana' })).toBe('u|A|tutor%7Cauth0|ana');
      expect(chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: 'a\uD800' })).toBe('u|A|tutor|a%uD800');
      expect(chainKeyOf({ namespace: 'A:1', agentKey: 'tutor', userId: null }, 'ana maria')).toBe('t|A%3A1|tutor|ana%20maria');

      await expect(ledger.propose(memoryWrite({ turnUserId: 'bo' }), { verdict: 'kept' })).rejects.toThrow(/turnUserId/);
      expect(await store.chainRows('u|A|tutor|42')).toHaveLength(2);

      // forgetUser's deletion for bo in the store: both of bo's chains go whole, and every other chain verifies.
      expect(await store.deleteUserRows('A', 'bo')).toMatchObject({ ledger: 4, heads: 2 });
      expect(await store.chainRows('t|A|tutor|bo')).toEqual([]);
      expect(await store.chainRows('u|A|tutor|bo')).toEqual([]);
      expect(await store.head('t|A|tutor|bo')).toBeUndefined();
      expect(await store.head('u|A|tutor|bo')).toBeUndefined();
      expect(await store.chainRows('a|A|tutor')).toHaveLength(4);
      for (const key of ['u|A|tutor|42', 'a|A|tutor', 't|A|tutor|bo', 'u|A|tutor|bo']) {
        expect(await ledger.verifyChain(key)).toEqual({ ok: true, keyed: false });
      }
    });

    it("takes nothing for a forgotten user: a head forgetUser marked, a new chain behind the user's tombstone, and an append that finds the tombstone once it committed, whose rows go with the user's others", async () => {
      const store = await fresh();
      const ledger = ledgerOver(store);
      const key = chainKeyOf(LEDGER_LEARNER);
      const pending = appended(await ledger.propose(selfChange('openness')));
      const tomb = await tombstoneHash('A', '42');
      expect(tomb).toBe(await sha256Hex('["A","42"]'));

      // forgetUser's order: the tombstone first, then the user's heads marked forgotten, then the deletion.
      await store.insertForgotten(tomb, LATER);
      expect(await store.markHeadsForgotten('A', '42')).toBe(1);
      expect(await ledger.propose(selfChange('agreeableness'), { verdict: 'kept' })).toEqual({ status: 'forgotten' });
      expect(await ledger.propose(operatorAct(), { verdict: 'kept', operator: true })).toEqual({ status: 'forgotten' });
      expect(await ledger.decide(pending.candidate.id, 'kept', 'evidence')).toEqual({ status: 'forgotten' });
      expect(await store.chainRows(key)).toHaveLength(1);

      await store.deleteUserRows('A', '42');
      expect(await ledger.propose(selfChange('openness'), { verdict: 'kept' })).toEqual({ status: 'forgotten' });
      expect(
        await ledger.propose(selfChange('trace-1', { kind: 'memory_write', learner: { ...LEDGER_LEARNER, userId: null }, turnUserId: '42' }), { verdict: 'kept' }),
      ).toEqual({ status: 'forgotten' });
      expect(await store.head(key)).toBeUndefined();
      expect(await store.head('t|A|tutor|42')).toBeUndefined();
      // The same id in another tenant is another user.
      const tenantB = { ...LEDGER_LEARNER, namespace: 'B' };
      expect(appended(await ledger.propose(selfChange('openness', { learner: tenantB }), { verdict: 'kept' })).status).toBe('kept');
      expect(await ledger.verifyChain(chainKeyOf(tenantB))).toEqual({ ok: true, keyed: false });

      // bo is forgotten while an append of theirs runs: its rows commit, then the append finds the tombstone and the
      // deletion the host gave runs again.
      const bo = { ...LEDGER_LEARNER, userId: 'bo' };
      const boTomb = await tombstoneHash('A', 'bo');
      const deletedAgain: string[] = [];
      const forgetting = ledgerOver(store, {
        onForgottenAfterCommit: async (namespace, userId) => {
          deletedAgain.push(`${namespace}/${userId}`);
          await store.deleteUserRows(namespace, userId);
        },
      });
      expect(
        await forgetting.propose(selfChange('openness', { learner: bo }), { verdict: 'kept', change: async (tx) => tx.insertForgotten(boTomb, LATER) }),
      ).toEqual({ status: 'forgotten' });
      expect(deletedAgain).toEqual(['A/bo']);
      expect(await store.chainRows(chainKeyOf(bo))).toEqual([]);
      expect(await store.head(chainKeyOf(bo))).toBeUndefined();
      expect(await store.isForgotten(boTomb)).toBe(true);

      // With no deletion given, the ledger deletes the user's rows itself.
      const cy = { ...LEDGER_LEARNER, userId: 'cy' };
      const cyTomb = await tombstoneHash('A', 'cy');
      expect(
        await ledger.propose(selfChange('openness', { learner: cy }), { verdict: 'kept', change: async (tx) => tx.insertForgotten(cyTomb, LATER) }),
      ).toEqual({ status: 'forgotten' });
      expect(await store.chainRows(chainKeyOf(cy))).toEqual([]);
      expect(await store.head(chainKeyOf(cy))).toBeUndefined();
    });

    it('refuses a new candidate while its learner is frozen and while AGENTOS_LEARNING_FREEZE=1 freezes the process, writing nothing, and lets an operator act and a verdict be written', async () => {
      const store = await fresh();
      const frozenUsers = new Set<string>(['42']);
      const asked: LedgerLearner[] = [];
      const ledger = ledgerOver(store, {
        isFrozen: (learner) => {
          asked.push(learner);
          return learner.userId !== null && frozenUsers.has(learner.userId);
        },
      });
      const key = chainKeyOf(LEDGER_LEARNER);
      const seven = { ...LEDGER_LEARNER, userId: '7' };
      expect(await ledger.propose(selfChange('openness'))).toEqual({ status: 'frozen' });
      expect(await ledger.propose(selfChange('openness'), { verdict: 'kept' })).toEqual({ status: 'frozen' });
      expect(asked).toEqual([LEDGER_LEARNER, LEDGER_LEARNER]);
      expect(await store.head(key)).toBeUndefined();
      expect(appended(await ledger.propose(selfChange('openness', { learner: seven }))).status).toBe('pending');
      expect(appended(await ledger.propose(operatorAct(), { verdict: 'kept', operator: true })).status).toBe('kept');

      frozenUsers.clear();
      const trial = appended(await ledger.propose(selfChange('agreeableness')));
      vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
      const unconfigured = ledgerOver(store);
      expect(await unconfigured.propose(selfChange('openness'))).toEqual({ status: 'frozen' });
      expect(await ledger.propose(selfChange('openness', { learner: seven }))).toEqual({ status: 'frozen' });
      expect(appended(await unconfigured.propose(operatorAct(), { verdict: 'kept', operator: true })).status).toBe('kept');
      // A verdict on a candidate proposed before the freeze, as a retirement writes one, is written under it.
      expect((await unconfigured.decide(trial.candidate.id, 'rejected', 'evidence')).status).toBe('rejected');
      vi.stubEnv('AGENTOS_LEARNING_FREEZE', '0');
      expect(appended(await unconfigured.propose(selfChange('openness'))).status).toBe('pending');

      expect((await store.chainRows(key)).map((row) => [row.rowType, row.kind, row.verdict])).toEqual([
        ['candidate', 'operator_set', 'pending'],
        ['verdict', 'operator_set', 'kept'],
        ['candidate', 'trait', 'pending'],
        ['candidate', 'operator_set', 'pending'],
        ['verdict', 'operator_set', 'kept'],
        ['verdict', 'trait', 'rejected'],
        ['candidate', 'trait', 'pending'],
      ]);
      expect(await store.chainRows(chainKeyOf(seven))).toHaveLength(1);
      expect(await ledger.verifyChain(key)).toEqual({ ok: true, keyed: false });
    });

    it("writes a verdict only where it follows the candidate's current one, on the candidate's own chain, and answers refused or unknown_candidate otherwise, writing nothing", async () => {
      const store = await fresh();
      const ledger = ledgerOver(store);
      const key = chainKeyOf(LEDGER_LEARNER);
      const one = appended(await ledger.propose(selfChange('openness')));
      const two = appended(await ledger.propose(selfChange('agreeableness')));
      expect(await ledger.latestVerdict(one.candidate.id)).toBe('pending');
      expect(await ledger.pendingCandidates(key)).toEqual([one.candidate, two.candidate]);

      expect((await ledger.decide(one.candidate.id, 'kept', 'evidence')).status).toBe('kept');
      expect(await ledger.decide(one.candidate.id, 'rejected', 'late')).toEqual({ status: 'refused', current: 'kept' });
      expect(await ledger.decide(one.candidate.id, 'kept', 'again')).toEqual({ status: 'refused', current: 'kept' });
      expect(await ledger.decide(one.candidate.id, 'pending', 'back')).toEqual({ status: 'refused', current: 'kept' });
      expect((await ledger.decide(one.candidate.id, 'reverted', 'probe')).status).toBe('reverted');
      expect(await ledger.decide(one.candidate.id, 'kept', 'again')).toEqual({ status: 'refused', current: 'reverted' });
      expect((await ledger.decide(two.candidate.id, 'rejected', 'bounds')).status).toBe('rejected');
      expect(await ledger.decide(two.candidate.id, 'reverted', 'late')).toEqual({ status: 'refused', current: 'rejected' });
      expect(await ledger.latestVerdict(one.candidate.id)).toBe('reverted');
      expect(await ledger.latestVerdict(two.candidate.id)).toBe('rejected');
      expect(await ledger.pendingCandidates(key)).toEqual([]);

      const verdictId = (await store.chainRows(key)).find((row) => row.rowType === 'verdict')!.id;
      expect(await ledger.decide('no-such-candidate', 'kept', 'x')).toEqual({ status: 'unknown_candidate' });
      expect(await ledger.decide(verdictId, 'kept', 'x')).toEqual({ status: 'unknown_candidate' });

      const three = appended(await ledger.propose(selfChange('conscientiousness')));
      await expect(
        ledger.decide(three.candidate.id, 'kept', 'evidence', {
          change: async () => {
            throw new Error('the lesson could not be activated');
          },
        }),
      ).rejects.toThrow('the lesson could not be activated');
      expect(await ledger.latestVerdict(three.candidate.id)).toBe('pending');
      expect((await store.chainRows(key)).map((row) => [row.seq, row.rowType, row.verdict])).toEqual([
        [1, 'candidate', 'pending'],
        [2, 'candidate', 'pending'],
        [3, 'verdict', 'kept'],
        [4, 'verdict', 'reverted'],
        [5, 'verdict', 'rejected'],
        [6, 'candidate', 'pending'],
      ]);

      // A second user's write on another user's session: its verdict goes on that user's chain, with the candidate's session.
      const visit = appended(
        await ledger.propose(
          selfChange('trace-9', { kind: 'memory_write', actor: 'memory:tools', learner: { ...LEDGER_LEARNER, userId: null }, turnUserId: 'bo', sessionId: 's-ana' }),
        ),
      );
      expect((await ledger.decide(visit.candidate.id, 'kept', 'write landed', { stateDigest: 'digest-9' })).status).toBe('kept');
      expect((await store.chainRows('t|A|tutor|bo')).map((row) => [row.rowType, row.turnUserId, row.sessionId, row.stateDigest])).toEqual([
        ['candidate', 'bo', 's-ana', null],
        ['verdict', 'bo', 's-ana', 'digest-9'],
      ]);
      for (const chain of [key, 't|A|tutor|bo']) expect(await ledger.verifyChain(chain)).toEqual({ ok: true, keyed: false });
    });

    it("writes a revert's verdict on the candidate it names in one append with its own candidate, and throws, writing nothing, for a candidate named twice, one of another chain, or one whose verdict cannot follow", async () => {
      const store = await fresh();
      const ledger = ledgerOver(store);
      const key = chainKeyOf(LEDGER_LEARNER);
      const step = appended(await ledger.propose(selfChange('openness'), { verdict: 'kept' }));
      const rejectedStep = appended(await ledger.propose(selfChange('agreeableness'), { verdict: 'rejected', reason: 'bounds' }));
      const elsewhere = appended(await ledger.propose(selfChange('openness', { learner: { ...LEDGER_LEARNER, userId: '7' } }), { verdict: 'kept' }));
      const revert = (alsoDecide: NonNullable<ProposeOptions['alsoDecide']>) =>
        ledger.propose(selfChange('openness', { actor: 'operator:ops', before: { openness: 0.6 }, after: { openness: 0.5 } }), {
          verdict: 'kept',
          reason: 'revert',
          operator: true,
          alsoDecide,
        });
      const reverting = (candidateId: string) => ({ candidateId, verdict: 'reverted' as const, reason: 'revert' });

      for (const wrong of [
        [reverting(step.candidate.id), reverting(step.candidate.id)],
        [reverting(elsewhere.candidate.id)],
        [reverting(rejectedStep.candidate.id)],
        [reverting('no-such-candidate')],
      ]) {
        await expect(revert(wrong)).rejects.toThrow(/learning ledger writes no/);
      }
      expect(await store.chainRows(key)).toHaveLength(4);
      expect(await ledger.latestVerdict(step.candidate.id)).toBe('kept');

      const done = appended(await revert([reverting(step.candidate.id)]));
      expect(done.status).toBe('kept');
      expect(done.rows.map((row) => [row.seq, row.rowType, row.candidateId, row.verdict])).toEqual([
        [5, 'candidate', done.candidate.id, 'pending'],
        [6, 'verdict', done.candidate.id, 'kept'],
        [7, 'verdict', step.candidate.id, 'reverted'],
      ]);
      expect(done.verdict).toEqual(done.rows[1]);
      expect(await ledger.latestVerdict(step.candidate.id)).toBe('reverted');
      await expect(revert([reverting(step.candidate.id)])).rejects.toThrow(/its verdict is reverted/);

      // A pending candidate written with a verdict on another reports no verdict of its own.
      const other = appended(await ledger.propose(selfChange('extraversion'), { verdict: 'kept' }));
      const superseding = appended(
        await ledger.propose(selfChange('extraversion'), { alsoDecide: [{ candidateId: other.candidate.id, verdict: 'reverted', reason: 'superseded' }] }),
      );
      expect(superseding.status).toBe('pending');
      expect(superseding).not.toHaveProperty('verdict');
      expect(superseding.rows.map((row) => [row.rowType, row.candidateId])).toEqual([
        ['candidate', superseding.candidate.id],
        ['verdict', other.candidate.id],
      ]);
      expect(await ledger.latestVerdict(other.candidate.id)).toBe('reverted');
      expect(await ledger.latestVerdict(superseding.candidate.id)).toBe('pending');
      expect(await ledger.verifyChain(key)).toEqual({ ok: true, keyed: false });
    });

    it('retries onto the head when another writer appended after its read, so the chain stays one line that verifies and the change runs once; after four lost swaps it answers conflict and writes nothing; and appends made at once all keep one line', async () => {
      const store = await fresh();
      const ledger = ledgerOver(store);
      const key = chainKeyOf(LEDGER_LEARNER);
      appended(await ledger.propose(selfChange('one'), { verdict: 'kept' }));

      let changes = 0;
      const counted: ProposeOptions = {
        verdict: 'kept',
        change: async () => {
          changes += 1;
        },
      };
      expect((await ledgerOver(racedStore(store, 3)).propose(selfChange('two'), counted)).status).toBe('kept');
      expect(changes).toBe(1);
      expect(await ledgerOver(racedStore(store, 4)).propose(selfChange('three'), counted)).toEqual({ status: 'conflict' });
      expect(changes).toBe(1);
      expect((await store.chainRows(key)).map((row) => [row.seq, row.subject, row.verdict])).toEqual([
        [1, 'one', 'pending'],
        [2, 'one', 'kept'],
        [3, 'two', 'pending'],
        [4, 'two', 'kept'],
      ]);
      expect(await ledger.verifyChain(key)).toEqual({ ok: true, keyed: false });

      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => ledger.propose(selfChange(`at-once-${i}`), { verdict: 'kept' })));
      if (oneAtATime) expect(results.map((result) => result.status)).toEqual(Array(6).fill('kept'));
      else expect(results.every((result) => result.status === 'kept' || result.status === 'conflict')).toBe(true);
      const kept = results.filter((result) => result.status === 'kept').length;
      expect(kept).toBeGreaterThan(0);
      const rows = await store.chainRows(key);
      expect(rows.map((row) => row.seq)).toEqual(rows.map((_, i) => i + 1));
      expect(rows).toHaveLength(4 + 2 * kept);
      expect(await ledger.verifyChain(key)).toEqual({ ok: true, keyed: false });
    });

    it('keys every hash under a ledger key the store never holds: a ledger without the key, or with another, reads the chain as broken, and a tombstone stays unkeyed', async () => {
      const store = await fresh();
      const keyed = ledgerOver(store, { ledgerKey: LEDGER_KEY });
      expect(keyed.keyed).toBe(true);
      expect(ledgerOver(store, { ledgerKey: '' }).keyed).toBe(false);
      const key = chainKeyOf(LEDGER_LEARNER);
      appended(await keyed.propose(selfChange('openness'), { verdict: 'kept' }));
      const rows = await store.chainRows(key);
      for (const row of rows) {
        expect(row.hash).toBe(await hmacSha256Hex(LEDGER_KEY, row.body));
        expect(row.hash).not.toBe(await sha256Hex(row.body));
      }
      expect(rows[1]!.prevHash).toBe(rows[0]!.hash);
      expect(await keyed.verifyChain(key)).toEqual({ ok: true, keyed: true });
      expect(await ledgerOver(store).verifyChain(key)).toEqual({ ok: false, keyed: false, reason: `row ${rows[0]!.id}: hash` });
      expect(await ledgerOver(store, { ledgerKey: 'another-key' }).verifyChain(key)).toEqual({ ok: false, keyed: true, reason: `row ${rows[0]!.id}: hash` });
      expect(JSON.stringify([rows, await store.head(key)])).not.toContain(LEDGER_KEY);

      await store.insertForgotten(await tombstoneHash('A', '7'), LATER);
      expect(await keyed.propose(selfChange('openness', { learner: { ...LEDGER_LEARNER, userId: '7' } }), { verdict: 'kept' })).toEqual({ status: 'forgotten' });
    });

    it("verifies a chain again from an operator's reanchor once a writer outside the ledger broke it, whatever the rows before the reanchor hold", async () => {
      const store = await fresh();
      const ledger = ledgerOver(store);
      const key = chainKeyOf(LEDGER_LEARNER);
      appended(await ledger.propose(selfChange('openness'), { verdict: 'kept' }));
      // A writer outside the ledger appends a row whose text is no entry, and moves the head to it.
      const junk = ledgerRow({ id: 'junk-1', chainKey: key, seq: 3, kind: 'trait', body: 'not json', prevHash: 'x', hash: 'y', stateDigest: 'digest-junk' });
      await store.transaction(async (tx) => {
        await tx.insertLedgerRow(junk);
        expect(await tx.advanceHead(key, 2, { lastId: junk.id, lastHash: junk.hash, seq: 3 })).toBe(true);
      });
      expect(await ledger.verifyChain(key)).toEqual({ ok: false, keyed: false, reason: 'row junk-1: unreadable' });
      const unreadable = "The learning ledger's row junk-1 is unreadable.";
      await expect(ledger.entries(key)).rejects.toThrow(unreadable);
      await expect(ledger.pendingCandidates(key)).rejects.toThrow(unreadable);
      await expect(ledger.latestStateRow(key, ['trait'])).rejects.toThrow(unreadable);
      await expect(ledger.decide('junk-1', 'kept', 'evidence')).rejects.toThrow(unreadable);

      // A row that is no operator_set candidate anchors nothing, whatever its reason.
      appended(await ledger.propose(selfChange('agreeableness'), { verdict: 'kept', reason: 'reanchor' }));
      expect(await ledger.verifyChain(key)).toEqual({ ok: false, keyed: false, reason: 'row junk-1: unreadable' });

      const reanchor = appended(await ledger.propose(operatorAct(), { verdict: 'kept', reason: 'reanchor', operator: true }));
      expect(reanchor.rows.map((row) => [row.seq, row.kind, row.reason])).toEqual([
        [6, 'operator_set', 'reanchor'],
        [7, 'operator_set', 'reanchor'],
      ]);
      expect(await ledger.verifyChain(key)).toEqual({ ok: true, keyed: false });
      appended(await ledger.propose(selfChange('conscientiousness'), { verdict: 'kept' }));
      expect(await ledger.verifyChain(key)).toEqual({ ok: true, keyed: false });
      expect((await store.head(key))?.seq).toBe(9);
    });
  });
}

describe('the ledger', () => {
  ledgerCases('in the process', async () => ({ store: new InMemoryLearningStore(), close: async () => undefined }), true);

  ledgerCases(
    'over a SQLite file',
    async () => {
      const adapter = await openSqliteAt(learningFile());
      const store = new SqlLearningStore({ adapter });
      return {
        store,
        close: async () => {
          await store.close();
          await adapter.close();
        },
      };
    },
    true,
  );

  it('over a SQLite file keeps its chains across a restart: a ledger over the reopened file verifies them, decides a candidate proposed before, and appends after the head', async () => {
    const file = learningFile();
    const key = chainKeyOf(LEDGER_LEARNER);
    let pendingId = '';
    let before: StoredLedgerRow[] = [];
    const first = await openSqliteAt(file);
    try {
      const store = new SqlLearningStore({ adapter: first });
      const ledger = ledgerOver(store);
      appended(await ledger.propose(selfChange('openness'), { verdict: 'kept' }));
      pendingId = appended(await ledger.propose(selfChange('agreeableness'))).candidate.id;
      appended(
        await ledger.propose(selfChange('trace-1', { kind: 'memory_write', learner: { ...LEDGER_LEARNER, userId: null }, turnUserId: 'bo' }), { verdict: 'kept' }),
      );
      before = await store.chainRows(key);
    } finally {
      await first.close();
    }

    const reopened = await openSqliteAt(file);
    try {
      const store = new SqlLearningStore({ adapter: reopened });
      const ledger = ledgerOver(store);
      expect(await store.chainRows(key)).toEqual(before);
      expect(await ledger.verifyChain(key)).toEqual({ ok: true, keyed: false });
      expect(await ledger.verifyChain('t|A|tutor|bo')).toEqual({ ok: true, keyed: false });
      expect(await ledger.latestVerdict(pendingId)).toBe('pending');
      expect((await ledger.pendingCandidates(key)).map((entry) => entry.id)).toEqual([pendingId]);
      expect((await ledger.decide(pendingId, 'kept', 'evidence')).status).toBe('kept');
      const next = appended(await ledger.propose(selfChange('conscientiousness'), { verdict: 'kept' }));
      const rows = await store.chainRows(key);
      expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(rows[3]!.prevHash).toBe(before[2]!.hash);
      expect(rows[5]!.id).toBe(next.rows[1]!.id);
      expect(await ledger.verifyChain(key)).toEqual({ ok: true, keyed: false });
    } finally {
      await reopened.close();
    }
  });

  it('over a SQLite file reads an edit made outside the layer as a broken chain and names what broke, never throws for a row that is no entry, and verifies a chain whose head row was deleted from the reanchor written after its newest row', async () => {
    const adapter = await openSqliteAt(learningFile());
    try {
      const store = new SqlLearningStore({ adapter });
      const ledger = ledgerOver(store);
      /** A learner's chain of four rows: two kept steps. */
      const chainFor = async (userId: string): Promise<{ key: string; rows: StoredLedgerRow[] }> => {
        const learner = { ...LEDGER_LEARNER, userId };
        appended(await ledger.propose(selfChange('openness', { learner }), { verdict: 'kept' }));
        appended(await ledger.propose(selfChange('agreeableness', { learner }), { verdict: 'kept' }));
        const key = chainKeyOf(learner);
        return { key, rows: await store.chainRows(key) };
      };
      const setBody = (id: string, body: string) => adapter.run('UPDATE agentos_learning_ledger SET body = ? WHERE id = ?', [body, id]);
      const deleteRow = (id: string) => adapter.run('DELETE FROM agentos_learning_ledger WHERE id = ?', [id]);
      const broken = (reason: string) => ({ ok: false, keyed: false, reason });

      const untouched = await chainFor('untouched');

      const text = await chainFor('text');
      await setBody(text.rows[0]!.id, text.rows[0]!.body.replace('"openness":0.6', '"openness":0.9'));
      expect(await ledger.verifyChain(text.key)).toEqual(broken(`row ${text.rows[0]!.id}: hash`));

      const column = await chainFor('column');
      await adapter.run('UPDATE agentos_learning_ledger SET subject = ? WHERE id = ?', ['honesty', column.rows[1]!.id]);
      expect(await ledger.verifyChain(column.key)).toEqual(broken(`row ${column.rows[1]!.id}: column subject`));

      const newest = await chainFor('newest');
      await deleteRow(newest.rows[3]!.id);
      expect(await ledger.verifyChain(newest.key)).toEqual(broken('head'));

      const middle = await chainFor('middle');
      await deleteRow(middle.rows[1]!.id);
      expect(await ledger.verifyChain(middle.key)).toEqual(broken(`row ${middle.rows[2]!.id}: link`));

      // One learner's rows moved under another learner's key, with a head made there to name them.
      const moved = await chainFor('moved');
      const into = chainKeyOf({ ...LEDGER_LEARNER, userId: 'into' });
      await adapter.run('UPDATE agentos_learning_ledger SET chain_key = ? WHERE chain_key = ?', [into, moved.key]);
      await adapter.run('UPDATE agentos_learning_heads SET chain_key = ? WHERE chain_key = ?', [into, moved.key]);
      expect(await ledger.verifyChain(into)).toEqual(broken(`row ${moved.rows[0]!.id}: column chainKey`));

      const unreadable = await chainFor('unreadable');
      await setBody(unreadable.rows[2]!.id, '[1,2]');
      await setBody(unreadable.rows[3]!.id, 'null');
      expect(await ledger.verifyChain(unreadable.key)).toEqual(broken(`row ${unreadable.rows[3]!.id}: unreadable`));
      const named = `The learning ledger's row ${unreadable.rows[2]!.id} is unreadable.`;
      await expect(ledger.entries(unreadable.key)).rejects.toThrow(named);
      await expect(ledger.decide(unreadable.rows[2]!.id, 'reverted', 'probe')).rejects.toThrow(named);

      const rowsGone = await chainFor('rows-gone');
      await adapter.run('DELETE FROM agentos_learning_ledger WHERE chain_key = ?', [rowsGone.key]);
      expect(await ledger.verifyChain(rowsGone.key)).toEqual(broken('head with no rows'));

      const headless = await chainFor('headless');
      await setBody(headless.rows[0]!.id, headless.rows[0]!.body.replace('"openness":0.6', '"openness":0.9'));
      await adapter.run('DELETE FROM agentos_learning_heads WHERE chain_key = ?', [headless.key]);
      expect(await ledger.verifyChain(headless.key)).toEqual(broken(`row ${headless.rows[0]!.id}: hash`));
      const reanchor = appended(await ledger.propose(operatorAct('headless'), { verdict: 'kept', reason: 'reanchor', operator: true }));
      expect(reanchor.rows.map((row) => row.seq)).toEqual([5, 6]);
      expect(reanchor.candidate.prevHash).toBe(headless.rows[3]!.hash);
      expect(await ledger.verifyChain(headless.key)).toEqual({ ok: true, keyed: false });

      expect(await ledger.verifyChain(untouched.key)).toEqual({ ok: true, keyed: false });
    } finally {
      await adapter.close();
    }
  });

  it('over a SQLite file with a key reads a chain a writer without the key recomputed as broken, which a ledger without a key reads as whole, unkeyed', async () => {
    const adapter = await openSqliteAt(learningFile());
    try {
      const store = new SqlLearningStore({ adapter });
      const keyed = ledgerOver(store, { ledgerKey: LEDGER_KEY });
      const key = chainKeyOf(LEDGER_LEARNER);
      appended(await keyed.propose(selfChange('openness'), { verdict: 'kept' }));
      appended(await keyed.propose(selfChange('agreeableness'), { verdict: 'kept' }));
      expect(await keyed.verifyChain(key)).toEqual({ ok: true, keyed: true });

      // The writer changes the first step's value and recomputes every hash with plain SHA-256, and the head with them.
      let prev = GENESIS_HASH;
      let last = { id: '', hash: '', seq: 0 };
      for (const row of await store.chainRows(key)) {
        const entry = JSON.parse(row.body) as Record<string, unknown>;
        const body = canonicalJson({ ...entry, prevHash: prev, ...(row.seq === 1 ? { after: { openness: 0.9 } } : {}) });
        const hash = await sha256Hex(body);
        await adapter.run('UPDATE agentos_learning_ledger SET body = ?, prev_hash = ?, hash = ? WHERE id = ?', [body, prev, hash, row.id]);
        prev = hash;
        last = { id: row.id, hash, seq: row.seq };
      }
      await adapter.run('UPDATE agentos_learning_heads SET last_id = ?, last_hash = ?, seq = ? WHERE chain_key = ?', [last.id, last.hash, last.seq, key]);
      expect(await keyed.verifyChain(key)).toMatchObject({ ok: false, keyed: true });
      expect(await ledgerOver(store).verifyChain(key)).toEqual({ ok: true, keyed: false });
    } finally {
      await adapter.close();
    }
  });

  it('keeps an append that committed when its second read of the tombstone fails, and answers forgotten when the deletion it runs again fails, saying so with the tombstone and never the user', async () => {
    const store = new InMemoryLearningStore();
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const user = { ...LEDGER_LEARNER, userId: 'ana@example.org' };
    const key = chainKeyOf(user);
    let unreachable = true;
    // The store fails a read made outside a transaction once the append has committed, as a database that went away does.
    const flaky = new Proxy(store, {
      get(target, property) {
        if (property === 'isForgotten' && unreachable) {
          return async () => {
            throw new Error('the database is not reachable');
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(appended(await ledgerOver(flaky).propose(selfChange('openness', { learner: user }), { verdict: 'kept' })).status).toBe('kept');
    expect(await store.chainRows(key)).toHaveLength(2);
    const readWarning = warned.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(readWarning).toMatch(/did not read the tombstone again/);
    expect(readWarning).toContain('the database is not reachable');
    expect(readWarning).not.toContain('ana@example.org');
    unreachable = false;
    warned.mockClear();

    const tomb = await tombstoneHash('A', 'ana@example.org');
    const failing = ledgerOver(store, {
      onForgottenAfterCommit: async () => {
        throw new Error('the deletion failed');
      },
    });
    expect(
      await failing.propose(selfChange('agreeableness', { learner: user }), { verdict: 'kept', change: async (tx) => tx.insertForgotten(tomb, LATER) }),
    ).toEqual({ status: 'forgotten' });
    const deleteWarning = warned.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(deleteWarning).toContain(`tombstone ${tomb.slice(0, 16)}`);
    expect(deleteWarning).toContain('the deletion failed');
    expect(deleteWarning).not.toContain(tomb);
    expect(deleteWarning).not.toContain('ana@example.org');
    // Its rows stand until a second forgetUser call deletes them.
    expect(await store.chainRows(key)).toHaveLength(4);
    await store.deleteUserRows('A', 'ana@example.org');
    expect(await store.chainRows(key)).toEqual([]);
  });

  it('writes the canonical text of a value with its keys in code-unit order at every depth, hashes it with SHA-256 or HMAC-SHA-256, and gives ids that sort by time', async () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"e":2,"f":1}]},"b":1}');
    expect(canonicalJson({ 10: 'ten', 9: 'nine', B: 'upper', a: 'lower', 'é': 'accent' })).toBe('{"10":"ten","9":"nine","B":"upper","a":"lower","é":"accent"}');
    expect(canonicalJson({ list: [undefined, () => 1, Symbol('s'), null], at: new Date(Date.parse(LEARNED_AT)), skip: () => 1, gone: undefined })).toBe(
      `{"at":"${LEARNED_AT}","list":[null,null,null,null]}`,
    );
    expect(canonicalJson({ toJSON: () => ({ z: 1, y: [2, { x: 3, w: 4 }] }) })).toBe('{"y":[2,{"w":4,"x":3}],"z":1}');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson('a "quoted" line\nbreak')).toBe(JSON.stringify('a "quoted" line\nbreak'));
    expect(canonicalJson(0.1 + 0.2)).toBe('0.30000000000000004');
    const shared = { n: 1 };
    expect(canonicalJson({ a: shared, b: [shared] })).toBe('{"a":{"n":1},"b":[{"n":1}]}');
    const loop: Record<string, unknown> = {};
    loop.inner = { loop };
    expect(() => canonicalJson(loop)).toThrow(TypeError);
    expect(() => canonicalJson({ big: BigInt(1) })).toThrow(TypeError);

    expect(GENESIS_HASH).toBe('0'.repeat(64));
    // FIPS 180-2's "abc", and RFC 4231's test case 2.
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');

    const ids = [ulid(1_000), ulid(1_000), ulid(1_001), ulid(999), ulid()];
    expect(ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('names the ledger, its answers and its rows in the types a host imports', () => {
    expectTypeOf<ProposeResult['status']>().toEqualTypeOf<'pending' | 'kept' | 'rejected' | 'reverted' | 'frozen' | 'forgotten' | 'conflict'>();
    expectTypeOf<DecideResult['status']>().toEqualTypeOf<'kept' | 'rejected' | 'reverted' | 'forgotten' | 'conflict' | 'unknown_candidate' | 'refused'>();
    expectTypeOf<Extract<DecideResult, { status: 'refused' }>['current']>().toEqualTypeOf<LedgerVerdict>();
    expectTypeOf<ChainCheck>().toEqualTypeOf<{ ok: true; keyed: boolean } | { ok: false; keyed: boolean; reason: string }>();
    expectTypeOf<CandidateInput['learner']>().toEqualTypeOf<LedgerLearner>();
    expectTypeOf<LedgerLearner['userId']>().toEqualTypeOf<string | null>();
    expectTypeOf<LedgerEntry['rowType']>().toEqualTypeOf<'candidate' | 'verdict'>();
    expectTypeOf<LedgerEntry['kind']>().toEqualTypeOf<LearningKind>();
    expectTypeOf<LedgerOptions['store']>().toEqualTypeOf<LearningStore>();
    expectTypeOf<NonNullable<LedgerOptions['isFrozen']>>().toEqualTypeOf<(learner: LedgerLearner) => boolean>();
    expectTypeOf<NonNullable<ProposeOptions['change']>>().parameters.toEqualTypeOf<[LearningStoreTx, LedgerEntry[]]>();
    expectTypeOf(chainKeyOf).parameter(0).toEqualTypeOf<LedgerLearner>();
    expectTypeOf(chainKeyOf).returns.toEqualTypeOf<string>();
    expectTypeOf(tombstoneHash).returns.toEqualTypeOf<Promise<string>>();
    expect(new Ledger({ store: new InMemoryLearningStore() }).keyed).toBe(false);
  });
});

describe.skipIf(!POSTGRES_URL)('the ledger on Postgres', () => {
  /** This run's own mark, in the names of the schemas its cases make and drop. */
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const segments: string[] = [];

  /** A new schema of this run's own, dropped once the cases have run. */
  function newSegment(): string {
    const segment = `qa_ledger_${run}_${segments.length}`;
    segments.push(segment);
    return segment;
  }

  /** The host's Postgres adapter, its tables in `segment`: by default a new schema of this run's own. */
  async function openPostgresAdapter(segment: string = newSegment()): Promise<StorageAdapter> {
    const adapter = createPostgresAdapter({ connectionString: POSTGRES_URL!, segment, max: 5 });
    await adapter.open();
    return adapter;
  }

  /** Two stores over one schema, as two processes hold them, each having made or found its tables before they meet. */
  async function twoProcesses(): Promise<{ first: SqlLearningStore; second: SqlLearningStore; close: () => Promise<void> }> {
    const segment = newSegment();
    const one = await openPostgresAdapter(segment);
    const two = await openPostgresAdapter(segment);
    const first = new SqlLearningStore({ adapter: one });
    const second = new SqlLearningStore({ adapter: two });
    expect(await first.isForgotten('warm-up')).toBe(false);
    expect(await second.isForgotten('warm-up')).toBe(false);
    return {
      first,
      second,
      close: async () => {
        await one.close();
        await two.close();
      },
    };
  }

  afterAll(async () => {
    if (segments.length === 0) return;
    const admin = createPostgresAdapter({ connectionString: POSTGRES_URL! });
    await admin.open();
    try {
      for (const segment of segments) await admin.exec(`DROP SCHEMA IF EXISTS "${segment}" CASCADE`);
    } finally {
      await admin.close();
    }
  });

  ledgerCases(
    'over a schema of its own',
    async () => {
      const adapter = await openPostgresAdapter();
      const store = new SqlLearningStore({ adapter });
      return {
        store,
        close: async () => {
          await store.close();
          await adapter.close();
        },
      };
    },
    false,
  );

  it("keeps one chain both of two processes read and verify when they append to a learner's chain at once", async () => {
    const { first, second, close } = await twoProcesses();
    try {
      const a = ledgerOver(first);
      const b = ledgerOver(second);
      const key = chainKeyOf(LEDGER_LEARNER);
      appended(await a.propose(selfChange('first'), { verdict: 'kept' }));
      expect(await b.verifyChain(key)).toEqual({ ok: true, keyed: false });
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? a : b).propose(selfChange(`s-${i}`), { verdict: 'kept' })));
      expect(results.every((result) => result.status === 'kept' || result.status === 'conflict')).toBe(true);
      const kept = results.filter((result) => result.status === 'kept').length;
      expect(kept).toBeGreaterThan(0);
      const rows = await second.chainRows(key);
      expect(rows.map((row) => row.seq)).toEqual(rows.map((_, i) => i + 1));
      expect(rows).toHaveLength(2 + 2 * kept);
      expect(await a.entries(key)).toEqual(await b.entries(key));
      expect(await a.verifyChain(key)).toEqual({ ok: true, keyed: false });
      expect(await b.verifyChain(key)).toEqual({ ok: true, keyed: false });
    } finally {
      await close();
    }
  });

  it('lets one of two processes write its verdict when both decide one candidate at once, and answers the other refused with that verdict', async () => {
    const { first, second, close } = await twoProcesses();
    try {
      const a = ledgerOver(first);
      const b = ledgerOver(second);
      const key = chainKeyOf(LEDGER_LEARNER);
      const proposed = appended(await a.propose(selfChange('openness')));
      expect(await b.latestVerdict(proposed.candidate.id)).toBe('pending');
      const results = await Promise.all([a.decide(proposed.candidate.id, 'kept', 'evidence'), b.decide(proposed.candidate.id, 'rejected', 'probe')]);
      const winner = results.find((result) => result.status === 'kept' || result.status === 'rejected');
      if (!winner) throw new Error(`neither verdict was written: ${JSON.stringify(results)}`);
      expect(results.filter((result) => result !== winner)).toEqual([{ status: 'refused', current: winner.status }]);
      expect((await second.chainRows(key)).map((row) => [row.seq, row.rowType, row.verdict])).toEqual([
        [1, 'candidate', 'pending'],
        [2, 'verdict', winner.status],
      ]);
      expect(await a.latestVerdict(proposed.candidate.id)).toBe(winner.status);
      expect(await b.verifyChain(key)).toEqual({ ok: true, keyed: false });
    } finally {
      await close();
    }
  });

  it('leaves nothing of an append whose user another process forgets while it runs: its rows commit, then it finds the tombstone and deletes them', async () => {
    const { first, second, close } = await twoProcesses();
    try {
      const ledger = ledgerOver(first);
      const key = chainKeyOf(LEDGER_LEARNER);
      const seven = chainKeyOf({ ...LEDGER_LEARNER, userId: '7' });
      const other = appended(await ledger.propose(selfChange('openness', { learner: { ...LEDGER_LEARNER, userId: '7' } }), { verdict: 'kept' }));
      const tomb = await tombstoneHash('A', '42');
      const result = await ledger.propose(selfChange('openness'), {
        verdict: 'kept',
        change: async () => {
          // forgetUser in the other process, between this append's check of the tombstone and its commit: the tombstone,
          // the user's heads marked forgotten, the user's rows deleted. None of them sees this append's rows.
          await second.insertForgotten(tomb, LATER);
          expect(await second.markHeadsForgotten('A', '42')).toBe(0);
          expect(await second.deleteUserRows('A', '42')).toMatchObject({ ledger: 0, heads: 0 });
        },
      });
      expect(result).toEqual({ status: 'forgotten' });
      expect(await second.chainRows(key)).toEqual([]);
      expect(await second.head(key)).toBeUndefined();
      expect(await first.isForgotten(tomb)).toBe(true);
      expect(await ledger.propose(selfChange('agreeableness'), { verdict: 'kept' })).toEqual({ status: 'forgotten' });
      expect((await second.chainRows(seven)).map((row) => row.id)).toEqual(other.rows.map((row) => row.id));
      expect(await ledgerOver(second).verifyChain(seven)).toEqual({ ok: true, keyed: false });
    } finally {
      await close();
    }
  });
});

describe('the written form of every scope id a learning layer files and reads', () => {
  it("writes a learner's scopes plain with no namespace and namespaced with both parts encoded with one, keeps the persona's ::, and writes a plain id as the Brain's re-file writes it", () => {
    expect(learnerScopeIds({ namespace: '', userId: '42' }, 'tutor')).toEqual({ userScopeId: '42', personaScopeId: '42::tutor' });
    expect(learnerScopeIds({ namespace: '', userId: 'team/ana' }, 'tutor')).toEqual({ userScopeId: 'team%2Fana', personaScopeId: 'team%2Fana::tutor' });
    expect(learnerUserScopeId({ namespace: '', userId: 'team/ana' })).toBe(encodePlainScopeId('user', 'team/ana'));
    expect(learnerScopeIds({ namespace: '', userId: 'team/ana' }, 'tutor').personaScopeId).toBe(encodePlainScopeId('persona', 'team/ana::tutor'));
    expect(learnerScopeIds({ namespace: 'A', userId: '42' }, 'tutor')).toEqual({ userScopeId: 'A/42', personaScopeId: 'A/42::tutor' });
    expect(learnerUserScopeId({ namespace: 'org one', userId: 'ana maria' })).toBe('org%20one/ana%20maria');
    expect(learnerUserScopeId({ namespace: 'A', userId: 'b/c' })).toBe('A/b%2Fc');
    expect(learnerUserScopeId({ namespace: 'A/B', userId: 'c' })).toBe('A%2FB/c');
    // The composite's :: stays its separator: a colon in either part is encoded.
    expect(learnerScopeIds({ namespace: '', userId: 'a:' }, 'x').personaScopeId).toBe('a%3A::x');
    expect(learnerScopeIds({ namespace: '', userId: 'a' }, ':x').personaScopeId).toBe('a::%3Ax');
    expect(learnerScopeIds({ namespace: 'A', userId: 'a:b' }, 'p::q').personaScopeId).toBe('A/a%3Ab::p%3A%3Aq');
  });

  it("writes a turn with no learner under its session's form, apart per namespace, and a turn's own thread ids in that form, and no session form is a learner's", () => {
    expect(sessionScopeIds('s-1', '', 'tutor')).toEqual({ userScopeId: '/s-1', personaScopeId: '/s-1::tutor' });
    expect(sessionScopeIds('s-1', 'A', 'tutor')).toEqual({ userScopeId: 'A//s-1', personaScopeId: 'A//s-1::tutor' });
    expect(sessionScopeIds('s-1', 'B', 'tutor').userScopeId).toBe('B//s-1');
    expect(sessionScopeIds('a/b', '', 'p').userScopeId).toBe('/a%2Fb');
    expect(sessionScopeIds('a%2Fb', '', 'p').userScopeId).toBe('/a%252Fb');
    expect(sessionScopeIds('s 1', 'org one', 'p').userScopeId).toBe('org%20one//s%201');
    expect(taggedScopeId('conv-1', '')).toBe('/conv-1');
    expect(taggedScopeId('conv-1', 'A')).toBe('A//conv-1');
    expect(scopeIdOf('tutor')).toBe('tutor');
    expect(scopeIdOf('a:b')).toBe('a%3Ab');
    // A plain id with no reserved character keeps its form, a lone surrogate included; an encoded one writes it %u and hex.
    expect(scopeIdOf('a\uD800')).toBe('a\uD800');
    expect(scopeIdOf('a\uD800/')).toBe('a%uD800%2F');
    for (const id of ['/s-1', 'A//s-1', 'x//y']) expect(couldBeSessionForm(id)).toBe(true);
    for (const id of ['42', 'A/42', 'team%2Fana', 'a/b/c']) expect(couldBeSessionForm(id)).toBe(false);

    const ids = ['42', 'A', 'team/ana', 'a%2Fb', '/x', 'x//y', 'a:b', ' ', 'ü', 'a\uD800'];
    const learners = new Set<string>();
    for (const namespace of ['', 'A', 'B/C']) for (const userId of ids) learners.add(learnerUserScopeId({ namespace, userId }));
    for (const namespace of ['', 'A', 'B/C']) {
      for (const sessionId of ids) {
        const { userScopeId } = sessionScopeIds(sessionId, namespace, 'p');
        expect(learners.has(userScopeId)).toBe(false);
        expect(couldBeSessionForm(userScopeId)).toBe(true);
      }
    }
  });
});

describe('what a tool reads about its turn', () => {
  const scopes = { learner: 'none', mode: 'on', userScopeId: '/s-1', personaScopeId: '/s-1::tutor', namespace: '' };

  it("keeps the turn's well-formed scopes, recorder, second user and freeze, and drops each malformed one", () => {
    const recordSelfChange = async () => ({ status: 'written' as const, result: undefined });
    const frozen = () => false;
    expect(readToolLearningContext({ learning: { learner: 'none', mode: 'on', scopes, recordSelfChange, turnUserId: 'bo', frozen } })).toEqual({
      learner: 'none',
      mode: 'on',
      scopes,
      recordSelfChange,
      turnUserId: 'bo',
      frozen,
    });
    expect(
      readToolLearningContext({ learning: { learner: 'bound', mode: 'sideways', scopes: { ...scopes, userScopeId: 7 }, recordSelfChange: 'no', turnUserId: '', frozen: true } }),
    ).toEqual({ learner: 'bound', mode: 'off' });
    expect(readToolLearningContext({ learning: { learner: 'maybe', mode: 'frozen', scopes: { ...scopes, mode: 'sideways' } } })).toEqual({ learner: 'none', mode: 'frozen' });
    expect(readToolLearningContext({ learning: { learner: 'bound', mode: 'on', scopes: { ...scopes, learner: 'yes' } } })).toEqual({ learner: 'bound', mode: 'on' });
    expect(readToolLearningContext({ learning: { learner: 'bound', mode: 'on', scopes: { ...scopes, namespace: undefined } } })).toEqual({ learner: 'bound', mode: 'on' });
    expect(readToolLearningContext({ learning: 'on' })).toEqual({ learner: 'none', mode: 'off' });
    expect(readToolLearningContext({ learning: null })).toBeUndefined();
    expect(readToolLearningContext({})).toBeUndefined();
    expect(readToolLearningContext(undefined)).toBeUndefined();
  });

  it('refuses a self-change frozen before off before no learner, reads a run-time freeze at the call, and refuses a memory write only on a freeze', () => {
    let frozenNow = false;
    const frozen = () => frozenNow;
    const call = (learning?: Record<string, unknown>): Record<string, unknown> => (learning === undefined ? {} : { learning });
    expect(selfChangeRefusal(call({ learner: 'bound', mode: 'on', frozen }), {})).toBeUndefined();
    expect(memoryWriteRefusal(call({ learner: 'bound', mode: 'on', frozen }), {})).toBeUndefined();
    expect(selfChangeRefusal(call({ learner: 'bound', mode: 'off', frozen }), {})).toBe('off');
    expect(memoryWriteRefusal(call({ learner: 'bound', mode: 'off', frozen }), {})).toBeUndefined();
    expect(selfChangeRefusal(call({ learner: 'none', mode: 'on' }), {})).toBe('no_learner');
    expect(memoryWriteRefusal(call({ learner: 'none', mode: 'on' }), {})).toBeUndefined();

    frozenNow = true;
    for (const learning of [
      { learner: 'bound', mode: 'on', frozen },
      { learner: 'bound', mode: 'off', frozen },
      { learner: 'none', mode: 'off', frozen },
    ]) {
      expect(selfChangeRefusal(call(learning), {})).toBe('frozen');
      expect(memoryWriteRefusal(call(learning), {})).toBe('frozen');
    }
    expect(selfChangeRefusal(call({ learner: 'none', mode: 'frozen' }), {})).toBe('frozen');
    expect(memoryWriteRefusal(call({ learner: 'none', mode: 'frozen' }), {})).toBe('frozen');

    // The process freeze, with a layer and without one; with neither, nothing refuses.
    const processFrozen = { AGENTOS_LEARNING_FREEZE: '1' };
    expect(selfChangeRefusal(call(), processFrozen)).toBe('frozen');
    expect(memoryWriteRefusal(call(), processFrozen)).toBe('frozen');
    expect(memoryWriteRefusal(call({ learner: 'none', mode: 'off' }), processFrozen)).toBe('frozen');
    expect(selfChangeRefusal(call(), {})).toBeUndefined();
    expect(memoryWriteRefusal(call(), {})).toBeUndefined();

    // A freeze that cannot be read makes the refusal throw, so the tool fails before it acts.
    const unreadable = {
      learner: 'bound',
      mode: 'on',
      frozen: () => {
        throw new Error('the freeze table is not reachable');
      },
    };
    expect(() => selfChangeRefusal(call(unreadable), {})).toThrow('the freeze table is not reachable');
    expect(() => memoryWriteRefusal(call(unreadable), {})).toThrow('the freeze table is not reachable');
  });
});

describe('the learning option and its fields, on gmi() and the full runtime', () => {
  let keys = 0;
  const key = () => `k-qa-learning-${++keys}`;
  const TUTOR_TRAITS = { honesty: 0.9, extraversion: 0.8 };
  const PERSONALITY_HEADING = '## Personality & Communication Style';
  /** A gmi() tutor's options, its provider the stub played under `apiKey`. */
  const tutorOptions = (apiKey: string, extra: Record<string, unknown> = {}) =>
    ({
      runtime: 'gmi',
      provider: 'openai',
      model: 'stub-model',
      apiKey,
      fallbackProviders: [],
      name: 'Tutor',
      instructions: 'You teach networking.',
      personality: TUTOR_TRAITS,
      ...extra,
    }) as never;
  /** The system text of one model call. */
  const systemOf = (call: { messages: Array<{ role: string; content: unknown }> } | undefined): string =>
    (call?.messages ?? [])
      .filter((message) => message.role === 'system')
      .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
      .join('\n');
  /** The layer logs its manifest once, at its first session. */
  const quietManifest = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
  /** The full runtime over one persona, its provider the stub played under `apiKey`. */
  const bootRuntime = (apiKey: string, extra: Record<string, unknown> = {}): Promise<AgentOS> =>
    AgentOS.create({
      modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey } }] },
      turnPlanning: { enabled: false },
      personas: [{ id: 'tutor', name: 'Tutor', description: 'A tutor.', version: '1.0.0', baseSystemPrompt: 'You teach networking.', personalityTraits: TUTOR_TRAITS }],
      ...extra,
    } as never);

  it('reads learning: null as unset: agent() and gmi() send the prompt they send with learning unset and build no layer', async () => {
    const k = key();
    const played = script('openai', k, { replies: [reply.text('Hi.'), reply.text('Hi again.'), reply.text('Hello.')] });
    const unset = agent(tutorOptions(k));
    const nulled = agent(tutorOptions(k, { learning: null }));
    const viaGmi = gmi(tutorOptions(k, { learning: null }));
    try {
      await unset.session('s1', { userId: 'ana' }).send('Hello.');
      await nulled.session('s1', { userId: 'ana' }).send('Hello.');
      await viaGmi.session('s1', { userId: 'ana' }).send('Hello.');
      expect(played.seen).toHaveLength(3);
      expect(systemOf(played.seen[1])).toBe(systemOf(played.seen[0]));
      expect(systemOf(played.seen[2])).toBe(systemOf(played.seen[0]));
      expect(nulled.learning).toBeUndefined();
      expect(viaGmi.learning).toBeUndefined();
    } finally {
      await unset.close();
      await nulled.close();
      await viaGmi.close();
    }
  });

  it('reads a field set to null as unset: gmi() runs with the layer on and every switch at its default, an agency member whose agentKey is null names none, and a layer built with a null profile, surface and host loops takes their defaults', async () => {
    quietManifest();
    const k = key();
    script('openai', k, { replies: [reply.text('1.')] });
    const nulls = {
      mode: null,
      agentKey: null,
      namespace: null,
      anonymousUserIds: null,
      traits: null,
      lessons: null,
      skills: null,
      store: null,
      ledgerKey: null,
      clock: null,
      memoryTools: null,
    };
    const tutor = gmi(tutorOptions(k, { learning: nulls }));
    try {
      await tutor.session('s1', { userId: 'ana' }).send('Hello.');
      const manifest = await tutor.learning!.manifest();
      expect(manifest).toMatchObject({ surface: 'gmi', profile: 'light', mode: 'on' });
      expect(manifest.turns).toEqual({ prepared: 1, bound: 1, none: {} });
      expect(manifest.loops.trait_changes).toEqual({ live: false, detail: 'switched off' });
    } finally {
      await tutor.close();
    }
    const coach = gmi(tutorOptions(k, { name: 'Coach', learning: { agentKey: null } }));
    expect(() => gmi(tutorOptions(k, { agencies: { members: { helper: coach } } }))).not.toThrow();

    const layer = createLearningLayer({ profile: null, surface: null, hostLoops: null, mode: null } as never);
    try {
      expect(await layer.manifest()).toMatchObject({ surface: 'custom', profile: 'custom', mode: 'on' });
    } finally {
      await layer.close();
    }
  });

  it('refuses at construction a ledger key that is not a string or is blank, a clock that is not a function, a store that is no learning store and memory tools that are not an object, naming the field, and takes well-formed ones', async () => {
    quietManifest();
    const k = key();
    script('openai', k, { replies: [reply.text('Hi.')] });
    const refusals: Array<[Record<string, unknown>, RegExp]> = [
      [{ ledgerKey: 7 }, /learning\.ledgerKey must be a string/],
      [{ ledgerKey: ' ' }, /learning\.ledgerKey must not be blank/],
      [{ ledgerKey: '' }, /learning\.ledgerKey must not be blank/],
      [{ clock: 'now' }, /learning\.clock must be a function/],
      [{ store: {} }, /learning\.store must be a LearningStore/],
      [{ store: 'sql' }, /learning\.store must be a LearningStore/],
      [{ memoryTools: 'facade' }, /learning\.memoryTools must be an object/],
    ];
    for (const [learning, named] of refusals) {
      expect(() => gmi(tutorOptions(k, { learning }))).toThrow(named);
      expect(() => createLearningLayer(learning as never)).toThrow(named);
    }
    const taken = gmi(
      tutorOptions(k, {
        learning: { store: new InMemoryLearningStore(), ledgerKey: LEDGER_KEY, clock: () => Date.parse(LEARNED_AT), memoryTools: { brainId: 'qa' } },
      }),
    );
    try {
      await taken.session('s1', { userId: 'ana' }).send('Hello.');
      expect((await taken.learning!.manifest()).mode).toBe('on');
    } finally {
      await taken.close();
    }
  });

  it('the full runtime reads learning: null as unset and a null field as unset, and refuses a blank ledger key before it starts', async () => {
    quietManifest();
    const k = key();
    const played = script('openai', k, { replies: Array.from({ length: 24 }, () => reply.text('Noted.')), whole: true });
    /** One turn of user `ana`; the system text of the turn's streamed model call. */
    const turn = async (os: AgentOS): Promise<string> => {
      for await (const _chunk of os.processRequest({ textInput: 'Hello.', userId: 'ana', sessionId: 's-ana', selectedPersonaId: 'tutor' } as never)) {
        // Drained: the turn's answer is not what is read here.
      }
      return systemOf(played.seen.filter((call) => call.streamed).at(-1));
    };

    const unset = await bootRuntime(k);
    let unsetSystem = '';
    try {
      unsetSystem = await turn(unset);
      expect(unsetSystem).toContain('You teach networking.');
      expect(unsetSystem).not.toContain(PERSONALITY_HEADING);
    } finally {
      await unset.shutdown();
    }

    const nulled = await bootRuntime(k, { learning: null });
    try {
      expect(await turn(nulled)).toBe(unsetSystem);
      expect(nulled.getLearningLayer()).toBeUndefined();
    } finally {
      await nulled.shutdown();
    }

    const nullFields = await bootRuntime(k, { learning: { namespace: null, mode: null, agentKey: null, anonymousUserIds: null, traits: null, ledgerKey: null } });
    try {
      expect(await turn(nullFields)).toContain(PERSONALITY_HEADING);
      expect(await nullFields.getLearningLayer()!.manifest()).toMatchObject({ surface: 'runtime', mode: 'on' });
    } finally {
      await nullFields.shutdown();
    }

    await expect(bootRuntime(k, { learning: { ledgerKey: ' ' } })).rejects.toThrow(/learning\.ledgerKey must not be blank/);
  });

  it("tells a host tool its turn's learner and mode, by which the self-change and memory-write refusals answer", async () => {
    quietManifest();
    const seen: Array<{ context: unknown; selfChange: unknown; memoryWrite: unknown }> = [];
    const probeLearning = {
      name: 'probe_learning',
      description: 'Reads what the turn tells its tools about learning.',
      inputSchema: { type: 'object', properties: {} },
      execute: async (_args: Record<string, unknown>, context: { sessionData?: Record<string, unknown> }) => {
        seen.push({
          context: readToolLearningContext(context.sessionData),
          selfChange: selfChangeRefusal(context.sessionData),
          memoryWrite: memoryWriteRefusal(context.sessionData),
        });
        return { success: true, output: 'read' };
      },
    };
    /** One turn whose model calls the probe once; what the probe read. */
    const probed = async (learning: unknown, userId?: string) => {
      const k = key();
      script('openai', k, { replies: [reply.tools([{ id: 'c1', name: 'probe_learning', args: {} }]), reply.text('Done.')] });
      const tutor = gmi(tutorOptions(k, { ...(learning === undefined ? {} : { learning }), tools: [probeLearning] }));
      seen.length = 0;
      try {
        await tutor.session('s1', userId === undefined ? undefined : { userId }).send('Read it.');
      } finally {
        await tutor.close();
      }
      expect(seen).toHaveLength(1);
      return seen[0];
    };

    expect(await probed(true, 'ana')).toEqual({ context: { learner: 'bound', mode: 'on' }, selfChange: undefined, memoryWrite: undefined });
    expect(await probed({ mode: 'off' }, 'ana')).toEqual({ context: { learner: 'bound', mode: 'off' }, selfChange: 'off', memoryWrite: undefined });
    expect(await probed(true)).toEqual({ context: { learner: 'none', mode: 'on' }, selfChange: 'no_learner', memoryWrite: undefined });
    expect(await probed(undefined, 'ana')).toEqual({ context: undefined, selfChange: undefined, memoryWrite: undefined });
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    expect(await probed(true, 'ana')).toEqual({ context: { learner: 'bound', mode: 'frozen' }, selfChange: 'frozen', memoryWrite: 'frozen' });
    expect(await probed(undefined, 'ana')).toEqual({ context: undefined, selfChange: 'frozen', memoryWrite: 'frozen' });
  });

  it('names the config fields, the turn and write types and the host calls in the types a host imports, every new member of an interface a host builds optional', () => {
    expectTypeOf<LearningConfig['ledgerKey']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<LearningConfig['clock']>().toEqualTypeOf<(() => number) | undefined>();
    expectTypeOf<LearningConfig['store']>().toEqualTypeOf<LearningStore | undefined>();
    expectTypeOf<LearningConfig['memoryTools']>().toEqualTypeOf<LearningMemoryTools | undefined>();
    expectTypeOf<ScopeIdPair>().toEqualTypeOf<{ userScopeId: string; personaScopeId: string }>();
    expectTypeOf<TurnScopes['learner']>().toEqualTypeOf<'bound' | 'none'>();
    expectTypeOf<SessionSelfChange['kind']>().toEqualTypeOf<'memory_write'>();
    expectTypeOf<ProposalResult['status']>().toEqualTypeOf<'kept' | 'written' | 'rejected'>();
    expectTypeOf<Extract<FreezeScope, { scope: 'all' }>>().toEqualTypeOf<{ scope: 'all' }>();
    type HostCalls = 'freeze' | 'unfreeze' | 'suspend' | 'unsuspend' | 'operatorSet' | 'revert' | 'exportLearnedState' | 'importLearnedState' | 'forgetUser';
    expectTypeOf<{} extends Pick<ILearningLayer, HostCalls> ? true : false>().toEqualTypeOf<true>();
    expectTypeOf<undefined extends LearningLayerHandle['forgetUser'] ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<{} extends Pick<ILearnerSession, 'scopesFor' | 'recordSelfChange' | 'guardMemoryWrite' | 'isFrozen'> ? true : false>().toEqualTypeOf<true>();
    expectTypeOf<{} extends Pick<ToolLearningContext, 'scopes' | 'recordSelfChange' | 'turnUserId' | 'frozen'> ? true : false>().toEqualTypeOf<true>();
    expect(couldBeSessionForm('/s')).toBe(true);
  });

  it('describe a learning option or field set to null where a host reads about learning', () => {
    const gmiDoc = fs.readFileSync(path.join(PACKAGE_ROOT, 'docs', 'GMI.md'), 'utf8');
    expect(gmiDoc).toContain('| unset, `false` or `null` (the default) | No layer |');
    expect(gmiDoc).toContain('A field set to `null` reads as unset, as a config read from JSON or YAML writes one');
    expect(gmiDoc).toContain('a member of `agencies.members` whose `learning.agentKey` is `null` names no key of its own');
  });
});

/** A persona's traits as a host writes them: honesty-humility and extraversion high, the other four left out (0.5). */
const TUTOR_PERSONA = { honesty: 0.9, extraversion: 0.8 };
/** The chain of learner `ana` of the gmi() agent named `Tutor` (persona id `tutor`) or the runtime's persona `tutor`. */
const ANA_CHAIN = chainKeyOf({ namespace: '', agentKey: 'tutor', userId: 'ana' });
const LEARNER_42: LearnerKey = { namespace: 'A', agentKey: 'tutor', userId: '42' };
const IN_PROCESS_STORE = 'in process: the ledger and the state it records end with the process';

/** The line a trait renders in the personality section at `value`, a value of its high or its low band. */
function directiveFor(trait: string, value: number): string {
  const section = renderPersonalitySection({ [trait]: value });
  if (!section) throw new Error(`${trait} at ${value} renders no directive`);
  return section.split('\n').at(-1)!;
}

/** The system text of one model call. */
const systemTextOf = (call: { messages: Array<{ role: string; content: unknown }> } | undefined): string =>
  (call?.messages ?? [])
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n');

/** The digest a ledger row carries for a trait row's state: SHA-256 of the canonical text of the fields a change sets. */
const stateDigestOf = (state: TraitState): Promise<string> =>
  sha256Hex(canonicalJson({ baseline: state.baseline, current: state.current, bands: state.bands, honestyAtLastLoad: state.honestyAtLastLoad }));

/** A learner's trait row's state, as the store holds it. */
async function traitStateOf(store: LearningStore, userId = 'ana', namespace = ''): Promise<TraitState> {
  const row = await store.traitRow(namespace, 'tutor', userId);
  if (!row) throw new Error(`no trait row for '${userId}' in '${namespace}'`);
  return JSON.parse(row.state) as TraitState;
}

/** A memory write a host makes through its learner session, watched: what it took back, and why. */
function watchedWrite(subject: string, apply: () => Promise<string> = async () => subject) {
  const undone: Array<[string, string]> = [];
  const input: SessionSelfChange<string> = {
    kind: 'memory_write',
    actor: 'tool:memory_add',
    subject,
    before: null,
    after: { created: [subject], changed: [], deleted: [] },
    brainId: 'brain-1',
    apply,
    undo: async (result, reason) => {
      undone.push([result, reason]);
    },
  };
  return { input, undone };
}

/** A turn of a host's own turn loop: by default user `42` of tenant `A`. */
const productTurn = (over: Partial<TurnInputForLearning> = {}): TurnInputForLearning => ({
  turnId: 't-1',
  userId: '42',
  namespace: 'A',
  text: 'Hello.',
  modelIds: ['stub-model'],
  workflowSeat: false,
  ...over,
});

/** What a host's own turn loop tells the layer of a session of persona `tutor`. */
const productContext = (sessionId: string, over: Partial<LearnerContext> = {}): LearnerContext => ({
  sessionId,
  personaId: 'tutor',
  authoredTraits: TUTOR_PERSONA,
  ...over,
});

describe("a learner's trait row and its ledger, on gmi(), the full runtime and a host's own turn loop", () => {
  let keys = 0;
  const key = () => `k-qa-traits-${++keys}`;
  const adapters: StorageAdapter[] = [];
  afterEach(async () => {
    for (const adapter of adapters.splice(0).reverse()) await adapter.close().catch(() => undefined);
  });

  /** A process over the host's SQLite file: the file opened (again) and a learning store over it. */
  async function processOver(file: string): Promise<{ adapter: StorageAdapter; store: SqlLearningStore }> {
    const adapter = await openSqliteAt(file);
    adapters.push(adapter);
    return { adapter, store: new SqlLearningStore({ adapter }) };
  }

  /** A gmi() agent named `Tutor` (persona id `tutor`), its provider the stub played under `apiKey`. */
  const tutorAgent = (apiKey: string, personality: Record<string, number>, learning: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    gmi({
      runtime: 'gmi',
      provider: 'openai',
      model: 'stub-model',
      apiKey,
      fallbackProviders: [],
      name: 'Tutor',
      instructions: 'You teach networking.',
      personality,
      learning,
      ...extra,
    } as never);

  /** One session of one turn of `userId` on a new gmi() tutor: the system text its model was sent, and its layer's manifest. */
  async function oneTurn(
    personality: Record<string, number>,
    learning: Record<string, unknown>,
    sessionId = 's1',
    userId = 'ana',
  ): Promise<{ system: string; manifest: LoopManifest }> {
    const k = key();
    const played = script('openai', k, { replies: [reply.text('Noted.')] });
    const tutor = tutorAgent(k, personality, learning);
    try {
      await tutor.session(sessionId, { userId }).send('Hello.');
      return { system: systemTextOf(played.seen.at(-1)), manifest: await tutor.learning!.manifest() };
    } finally {
      await tutor.close();
    }
  }

  /** The full runtime over one persona `tutor` with `traits`, its provider the stub played under `apiKey`. */
  const bootRuntime = (apiKey: string, traits: Record<string, number>, learning: unknown): Promise<AgentOS> =>
    AgentOS.create({
      modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey } }] },
      turnPlanning: { enabled: false },
      personas: [{ id: 'tutor', name: 'Tutor', description: 'A tutor.', version: '1.0.0', baseSystemPrompt: 'You teach networking.', personalityTraits: traits }],
      learning,
    } as never);

  /** One turn of user `ana` on the full runtime: the system text of the turn's streamed model call. */
  async function runtimeTurn(os: AgentOS, played: ReturnType<typeof script>): Promise<string> {
    for await (const _chunk of os.processRequest({ textInput: 'Hello.', userId: 'ana', sessionId: 's-ana', selectedPersonaId: 'tutor' } as never)) {
      // Drained: the turn's answer is not what is read here.
    }
    return systemTextOf(played.seen.filter((call) => call.streamed).at(-1));
  }

  it("writes a learner's trait row at the first session with its creation in the ledger, and across restarts moves its baseline with the persona, keeps each learnable trait within 0.2 of it, holds the band it rendered and the higher honesty-humility", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const file = learningFile();

    // The first session: the row is the persona's authored traits, 0.5 where it leaves one out.
    const first = await processOver(file);
    const one = await oneTurn(TUTOR_PERSONA, { store: first.store });
    expect(one.system).toContain(renderPersonalitySection(TUTOR_PERSONA)!);
    expect(await first.store.traitRow('', 'tutor', 'ana')).toMatchObject({ personaId: 'tutor', version: 1 });
    const created = await traitStateOf(first.store);
    expect(created.baseline).toEqual({ honesty: 0.9, emotionality: 0.5, extraversion: 0.8, agreeableness: 0.5, conscientiousness: 0.5, openness: 0.5 });
    expect(created.current).toEqual({ extraversion: 0.8, agreeableness: 0.5, conscientiousness: 0.5, openness: 0.5 });
    expect(created.honestyAtLastLoad).toBe(0.9);
    const createdRows = await first.store.chainRows(ANA_CHAIN);
    expect(createdRows.map((row) => [row.rowType, row.kind, row.verdict, row.sessionId])).toEqual([
      ['candidate', 'operator_set', 'pending', 's1'],
      ['verdict', 'operator_set', 'kept', 's1'],
    ]);
    expect(JSON.parse(createdRows[0].body)).toMatchObject({
      actor: 'operator:persona',
      subject: 'traits',
      reason: 'created',
      before: null,
      after: { baseline: created.baseline, current: created.current, honestyAtLastLoad: 0.9, operatorTraits: {} },
    });
    expect(createdRows[1].stateDigest).toBe(await stateDigestOf(created));
    expect(one.manifest.loops.ledger).toEqual({ live: true, detail: 'sql store the host passed; unkeyed' });
    expect(one.manifest.loops.personality_rendering).toEqual({ live: true });
    expect((await first.store.sessionRowsOf('', 'ana')).map((row) => [row.sessionId, row.kind, row.agentKey, row.personaId])).toEqual([
      ['s1', 'learner', 'tutor', 'tutor'],
    ]);

    // A restart with the same persona reads the row: no ledger row, one more session row.
    const second = await processOver(file);
    const two = await oneTurn(TUTOR_PERSONA, { store: second.store }, 's2');
    expect(two.system).toContain(renderPersonalitySection(TUTOR_PERSONA)!);
    expect(await second.store.chainRows(ANA_CHAIN)).toHaveLength(2);
    expect((await second.store.traitRow('', 'tutor', 'ana'))!.version).toBe(1);
    expect((await second.store.sessionRowsOf('', 'ana')).map((row) => row.sessionId)).toEqual(['s1', 's2']);

    // The persona moves extraversion to 0.44: the kept 0.8 is clamped to 0.64, within 0.2 of it, and keeps the band it
    // rendered (high, until it falls past 0.63), where the persona alone renders it moderate.
    const nudged = { honesty: 0.9, extraversion: 0.44 };
    const third = await processOver(file);
    const three = await oneTurn(nudged, { store: third.store }, 's3');
    expect(three.system).toContain(directiveFor('extraversion', 0.8));
    expect(renderPersonalitySection(nudged)).not.toContain(directiveFor('extraversion', 0.8));
    const held = await traitStateOf(third.store);
    expect(held.baseline.extraversion).toBe(0.44);
    expect(held.current.extraversion).toBeCloseTo(0.64, 10);
    expect(held.bands.extraversion).toBe('high');
    const movedRows = await third.store.chainRows(ANA_CHAIN);
    expect(movedRows.map((row) => row.verdict)).toEqual(['pending', 'kept', 'pending', 'kept']);
    expect(JSON.parse(movedRows[2].body)).toMatchObject({
      actor: 'operator:persona',
      reason: 'persona_changed',
      before: { baseline: { extraversion: 0.8 }, current: { extraversion: 0.8 } },
      after: { baseline: { extraversion: 0.44 }, bands: { extraversion: 'high' } },
    });
    expect(movedRows[3].stateDigest).toBe(await stateDigestOf(held));

    // The persona lowers honesty-humility to 0.2 and sets emotionality 0.1 and extraversion 0.3: honesty-humility keeps
    // rendering the 0.9 the learner had, emotionality renders the persona's, and extraversion is clamped to 0.5
    // (moderate, no directive), where the persona alone renders it low.
    const lowered = { honesty: 0.2, emotionality: 0.1, extraversion: 0.3 };
    const fourth = await processOver(file);
    const four = await oneTurn(lowered, { store: fourth.store }, 's4');
    expect(four.system).toContain(renderPersonalitySection({ honesty: 0.9, emotionality: 0.1, extraversion: 0.5 })!);
    expect(four.system).not.toContain(directiveFor('honesty', 0.2));
    expect(four.system).not.toContain(directiveFor('extraversion', 0.3));
    const floored = await traitStateOf(fourth.store);
    expect(floored.baseline).toMatchObject({ honesty: 0.2, emotionality: 0.1, extraversion: 0.3 });
    expect(floored.honestyAtLastLoad).toBe(0.9);
    expect(floored.current.extraversion).toBeCloseTo(0.5, 10);
    expect(await fourth.store.chainRows(ANA_CHAIN)).toHaveLength(6);
    expect(await new Ledger({ store: fourth.store }).verifyChain(ANA_CHAIN)).toEqual({ ok: true, keyed: false });
    expect(four.manifest.loops.ledger).toEqual({ live: true, detail: 'sql store the host passed; unkeyed' });
  });

  it("stamps the trait row and its ledger rows with the layer's clock, and keeps a learnable trait inside [0.05, 0.95] whatever the persona sets", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = new InMemoryLearningStore();
    await oneTurn({ honesty: 0.9, extraversion: 0.99, openness: 0.01 }, { store, clock: () => Date.parse(LEARNED_AT) });
    expect(await store.traitRow('', 'tutor', 'ana')).toMatchObject({ updatedAt: LEARNED_AT });
    const state = await traitStateOf(store);
    expect(state.day).toBe(LEARNED_AT.slice(0, 10));
    expect(state.baseline).toMatchObject({ extraversion: 0.99, openness: 0.01 });
    expect(state.current).toMatchObject({ extraversion: 0.95, openness: 0.05 });
    expect((await store.chainRows(ANA_CHAIN)).map((row) => row.createdAt)).toEqual([LEARNED_AT, LEARNED_AT]);
  });

  it('writes the trait row at a first session in mode frozen and under the process freeze, and none in mode off, where the session row is still written', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const frozen = new InMemoryLearningStore();
    expect((await oneTurn(TUTOR_PERSONA, { store: frozen, mode: 'frozen' })).manifest.mode).toBe('frozen');
    expect(await frozen.traitRow('', 'tutor', 'ana')).toMatchObject({ personaId: 'tutor', version: 1 });

    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    const processFrozen = new InMemoryLearningStore();
    await oneTurn(TUTOR_PERSONA, { store: processFrozen });
    expect(await processFrozen.traitRow('', 'tutor', 'ana')).toMatchObject({ version: 1 });
    vi.unstubAllEnvs();

    const off = new InMemoryLearningStore();
    const offTurn = await oneTurn(TUTOR_PERSONA, { store: off, mode: 'off' });
    expect(offTurn.system).toContain(renderPersonalitySection(TUTOR_PERSONA)!);
    expect(await off.traitRow('', 'tutor', 'ana')).toBeUndefined();
    expect(await off.chainRows(ANA_CHAIN)).toEqual([]);
    expect((await off.sessionRowsOf('', 'ana')).map((row) => [row.sessionId, row.kind])).toEqual([['s1', 'learner']]);
  });

  it("renders the persona's authored traits, writes nothing and counts the learner as chain broken when an edit made outside the layer breaks the learner's record", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const doesNotVerify = (reason: string) =>
      warn.mock.calls.some((call) =>
        String(call[0]).includes(`the learning record of learner 'ana' of agent 'tutor' in namespace '' does not verify (${reason})`),
      );

    // The trait row edited inside its band: the edited 0.6 would render extraversion moderate.
    const edits = learningFile();
    const before = await processOver(edits);
    await oneTurn(TUTOR_PERSONA, { store: before.store });
    const edited = await traitStateOf(before.store);
    edited.current.extraversion = 0.6;
    edited.bands.extraversion = 'moderate';
    await before.adapter.run('UPDATE agentos_learning_traits SET state = ? WHERE agent_key = ? AND user_id = ?', [JSON.stringify(edited), 'tutor', 'ana']);
    const after = await processOver(edits);
    const read = await oneTurn(TUTOR_PERSONA, { store: after.store }, 's2');
    expect(read.system).toContain(renderPersonalitySection(TUTOR_PERSONA)!);
    expect(read.manifest.loops.ledger).toEqual({ live: true, detail: 'sql store the host passed; unkeyed; chain broken for 1 learner' });
    expect(doesNotVerify('its trait row does not match its newest ledger row')).toBe(true);
    expect(await after.store.chainRows(ANA_CHAIN)).toHaveLength(2);
    expect((await traitStateOf(after.store)).current.extraversion).toBe(0.6);

    // The newest ledger rows deleted with the head set back: every remaining row verifies, but the row holds the moved
    // state, which no remaining row's digest names.
    warn.mockClear();
    const rollback = learningFile();
    const moved = { honesty: 0.9, extraversion: 0.3 };
    await oneTurn(TUTOR_PERSONA, { store: (await processOver(rollback)).store });
    const later = await processOver(rollback);
    await oneTurn(moved, { store: later.store }, 's2');
    const rows = await later.adapter.all<{ id: string; hash: string }>('SELECT id, hash FROM agentos_learning_ledger WHERE chain_key = ? ORDER BY seq', [ANA_CHAIN]);
    expect(rows).toHaveLength(4);
    await later.adapter.run('DELETE FROM agentos_learning_ledger WHERE chain_key = ? AND seq > 2', [ANA_CHAIN]);
    await later.adapter.run('UPDATE agentos_learning_heads SET last_id = ?, last_hash = ?, seq = 2 WHERE chain_key = ?', [rows[1].id, rows[1].hash, ANA_CHAIN]);
    const rolled = await processOver(rollback);
    const back = await oneTurn(moved, { store: rolled.store }, 's3');
    // The persona's own extraversion (0.3, low) renders, where the row's 0.5 renders none.
    expect(back.system).toContain(renderPersonalitySection(moved)!);
    expect(back.manifest.loops.ledger.detail).toBe('sql store the host passed; unkeyed; chain broken for 1 learner');
    expect(doesNotVerify('its trait row does not match its newest ledger row')).toBe(true);
    expect(await rolled.store.chainRows(ANA_CHAIN)).toHaveLength(2);
  });

  it('with learning.ledgerKey, reads a chain hashed without the key as broken, and keys every hash of a learner it starts, which verifies across a restart', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const file = learningFile();
    const moved = { honesty: 0.9, extraversion: 0.3 };
    const unkeyed = await oneTurn(TUTOR_PERSONA, { store: (await processOver(file)).store });
    expect(unkeyed.manifest.loops.ledger.detail).toBe('sql store the host passed; unkeyed');

    // A layer that holds the key reads ana's chain, hashed without it, as broken: the moved persona's own traits render.
    const keyed = await processOver(file);
    const brokenUnderKey = await oneTurn(moved, { store: keyed.store, ledgerKey: LEDGER_KEY }, 's2');
    expect(brokenUnderKey.system).toContain(renderPersonalitySection(moved)!);
    expect(brokenUnderKey.manifest.loops.ledger).toEqual({ live: true, detail: 'sql store the host passed; keyed; chain broken for 1 learner' });
    expect(await keyed.store.chainRows(ANA_CHAIN)).toHaveLength(2);

    // A learner the keyed layer starts: every hash is HMAC-SHA-256 of its row's text under the key.
    const boChain = chainKeyOf({ namespace: '', agentKey: 'tutor', userId: 'bo' });
    const started = await oneTurn(TUTOR_PERSONA, { store: keyed.store, ledgerKey: LEDGER_KEY }, 's3', 'bo');
    expect(started.manifest.loops.ledger.detail).toBe('sql store the host passed; keyed');
    const boRows = await keyed.store.chainRows(boChain);
    expect(boRows).toHaveLength(2);
    for (const row of boRows) expect(row.hash).toBe(await hmacSha256Hex(LEDGER_KEY, row.body));

    // Across a restart under the same key, bo's chain verifies and the persona's move renders the clamped value.
    const restarted = await processOver(file);
    const again = await oneTurn(moved, { store: restarted.store, ledgerKey: LEDGER_KEY }, 's4', 'bo');
    expect(again.system).toContain(renderPersonalitySection({ honesty: 0.9, extraversion: 0.5 })!);
    expect(again.system).not.toContain(directiveFor('extraversion', 0.3));
    expect(again.manifest.loops.ledger.detail).toBe('sql store the host passed; keyed');
    expect(await new Ledger({ store: restarted.store, ledgerKey: LEDGER_KEY }).verifyChain(boChain)).toEqual({ ok: true, keyed: true });
    // The store holds no copy of the key.
    for (const table of LEARNING_TABLES) {
      expect(JSON.stringify(await restarted.adapter.all<Record<string, unknown>>(`SELECT * FROM ${table}`))).not.toContain(LEDGER_KEY);
    }
  });

  it("reads the run-time freezes and suspensions another process writes into the store at each turn: a learner's freeze and every agent's freeze make the turn frozen, an agent's suspension makes it off, and a host tool's refusals answer by them", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const file = learningFile();
    // The learner's row first, so the row (extraversion clamped to 0.5) and the persona's own traits (0.3, low) render apart.
    await oneTurn(TUTOR_PERSONA, { store: (await processOver(file)).store });
    const agentProcess = await processOver(file);
    const operator = await processOver(file);
    const learnerScope = freezeScopeKey({ learner: { namespace: '', agentKey: 'tutor', userId: 'ana' } });
    const agentScope = freezeScopeKey({ agentKey: 'tutor' });
    const freezeRow = (scopeKey: string, mode: FreezeRow['mode']): FreezeRow => ({
      scopeKey,
      mode,
      namespace: '',
      agentKey: scopeKey === 'all' ? null : 'tutor',
      userId: scopeKey === learnerScope ? 'ana' : null,
      setBy: 'operator:ops',
      createdAt: LEARNED_AT,
    });

    const seen: Array<{ context: unknown; selfChange: unknown; memoryWrite: unknown }> = [];
    const probe = {
      name: 'probe_learning',
      description: 'Reads what the turn tells its tools about learning.',
      inputSchema: { type: 'object', properties: {} },
      execute: async (_args: Record<string, unknown>, context: { sessionData?: Record<string, unknown> }) => {
        seen.push({
          context: readToolLearningContext(context.sessionData),
          selfChange: selfChangeRefusal(context.sessionData),
          memoryWrite: memoryWriteRefusal(context.sessionData),
        });
        return { success: true, output: 'read' };
      },
    };
    const k = key();
    const played = script('openai', k, {
      replies: Array.from({ length: 5 }, (_, at) => [reply.tools([{ id: `c${at}`, name: 'probe_learning', args: {} }]), reply.text('Done.')]).flat(),
    });
    const moved = { honesty: 0.9, extraversion: 0.3 };
    const tutor = tutorAgent(k, moved, { store: agentProcess.store }, { tools: [probe] });
    const session = tutor.session('s1', { userId: 'ana' });
    /** One turn: the system text it sent, and what the probe read. */
    const probed = async () => {
      seen.length = 0;
      await session.send('Read it.');
      expect(seen).toHaveLength(1);
      return { system: systemTextOf(played.seen.at(-1)), read: seen[0] };
    };
    const rowSection = renderPersonalitySection({ honesty: 0.9, extraversion: 0.5 })!;
    const lowExtraversion = directiveFor('extraversion', 0.3);
    try {
      const on = await probed();
      expect(on.read).toEqual({ context: { learner: 'bound', mode: 'on' }, selfChange: undefined, memoryWrite: undefined });
      expect(on.system).toContain(rowSection);
      expect(on.system).not.toContain(lowExtraversion);

      await operator.store.insertFreeze(freezeRow(learnerScope, 'frozen'));
      const frozen = await probed();
      expect(frozen.read).toEqual({ context: { learner: 'bound', mode: 'frozen' }, selfChange: 'frozen', memoryWrite: 'frozen' });
      expect(frozen.system).toContain(rowSection);
      expect(frozen.system).not.toContain(lowExtraversion);

      await operator.store.deleteFreeze(learnerScope, 'frozen');
      await operator.store.insertFreeze(freezeRow(agentScope, 'off'));
      const suspended = await probed();
      expect(suspended.read).toEqual({ context: { learner: 'bound', mode: 'off' }, selfChange: 'off', memoryWrite: undefined });
      expect(suspended.system).toContain(renderPersonalitySection(moved)!);

      await operator.store.deleteFreeze(agentScope, 'off');
      await operator.store.insertFreeze(freezeRow('all', 'frozen'));
      expect((await probed()).read).toEqual({ context: { learner: 'bound', mode: 'frozen' }, selfChange: 'frozen', memoryWrite: 'frozen' });

      await operator.store.deleteFreeze('all', 'frozen');
      expect((await probed()).read).toEqual({ context: { learner: 'bound', mode: 'on' }, selfChange: undefined, memoryWrite: undefined });
    } finally {
      await tutor.close();
    }
  });

  it("records a host's memory writes through its own turn loop over its storage adapter: pending while the write runs, then kept, rejected when it fails, taken back when its user is forgotten, and a second user's under the agent", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { adapter } = await processOver(learningFile());
    const layer = createLearningLayer({ storageAdapter: adapter });
    // The host reads what the layer wrote through a store of its own over the same adapter.
    const store = new SqlLearningStore({ adapter });
    const chain = chainKeyOf(LEARNER_42);
    try {
      expect((await layer.manifest()).loops.ledger).toEqual({ live: true, detail: "sql store over the host's storage adapter; unkeyed" });
      const session = await layer.forLearner(LEARNER_42, productContext('s-1'));
      const prepared = await session.prepareTurn(productTurn());
      expect(prepared).toMatchObject({
        learner: 'bound',
        mode: 'on',
        scopes: { learner: 'bound', mode: 'on', userScopeId: 'A/42', personaScopeId: 'A/42::tutor', namespace: 'A' },
      });
      expect(prepared.systemPrompts).toEqual([{ content: renderPersonalitySection(TUTOR_PERSONA), priority: 2, source: 'learning:personality' }]);

      // While the write runs its candidate is pending; then its verdict is kept.
      const verdictsSeen: string[] = [];
      const kept = watchedWrite('mt-1', async () => {
        verdictsSeen.push((await store.chainRows(chain)).at(-1)!.verdict);
        return 'mt-1';
      });
      const keptResult = await session.recordSelfChange!(kept.input, { learner: 'bound', namespace: 'A', conversationId: 'conv-1' });
      expect(keptResult).toMatchObject({ status: 'kept', result: 'mt-1' });
      expect(verdictsSeen).toEqual(['pending']);
      const written = (await store.chainRows(chain)).filter((row) => row.kind === 'memory_write');
      expect(written.map((row) => [row.rowType, row.subject, row.verdict, row.sessionId])).toEqual([
        ['candidate', 'mt-1', 'pending', 's-1'],
        ['verdict', 'mt-1', 'kept', 's-1'],
      ]);
      expect(keptResult.status === 'kept' ? keptResult.ledgerId : undefined).toBe(written[0].id);
      expect(JSON.parse(written[0].body)).toMatchObject({
        actor: 'tool:memory_add',
        subject: 'mt-1',
        before: null,
        after: { brainId: 'brain-1', created: ['mt-1'], changed: [], deleted: [] },
      });
      expect(await store.sessionRowsOf('A', '42')).toMatchObject([{ sessionId: 's-1', kind: 'learner', conversationIds: ['conv-1'], brainIds: ['brain-1'] }]);

      // A write that throws: rejected, its verdict rejected with the reason write_failed, nothing taken back.
      const failing = watchedWrite('mt-2', async () => {
        throw new Error('disk full');
      });
      expect(await session.recordSelfChange!(failing.input, { learner: 'bound', namespace: 'A' })).toMatchObject({ status: 'rejected', reason: 'write_failed' });
      const failedRows = (await store.chainRows(chain)).filter((row) => row.subject === 'mt-2');
      expect(failedRows.map((row) => [row.rowType, row.verdict])).toEqual([
        ['candidate', 'pending'],
        ['verdict', 'rejected'],
      ]);
      expect(JSON.parse(failedRows[1].body).reason).toBe('write_failed');
      expect(failing.undone).toEqual([]);

      // Two writes of one user started at once run one after another: the second waits for the first's verdict.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = watchedWrite('mt-s1', async () => {
        await gate;
        return 'mt-s1';
      });
      const quickApply = vi.fn(async () => 'mt-s2');
      const slowResult = session.recordSelfChange!(slow.input, { learner: 'bound', namespace: 'A' });
      const quickResult = session.recordSelfChange!(watchedWrite('mt-s2', quickApply).input, { learner: 'bound', namespace: 'A' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(quickApply).not.toHaveBeenCalled();
      release();
      expect(await slowResult).toMatchObject({ status: 'kept' });
      expect(await quickResult).toMatchObject({ status: 'kept' });
      expect(
        (await store.chainRows(chain)).filter((row) => row.subject.startsWith('mt-s')).map((row) => [row.subject, row.rowType]),
      ).toEqual([
        ['mt-s1', 'candidate'],
        ['mt-s1', 'verdict'],
        ['mt-s2', 'candidate'],
        ['mt-s2', 'verdict'],
      ]);
      expect(await new Ledger({ store }).verifyChain(chain)).toEqual({ ok: true, keyed: false });

      // A second user's turn on 42's session has no learner; its write chains under the agent with that user's id.
      const visitorTurn = await session.prepareTurn(productTurn({ userId: 'bo' }));
      expect(visitorTurn).toMatchObject({
        learner: 'none',
        noLearnerReason: 'other_user',
        turnUserId: 'bo',
        mode: 'on',
        scopes: { learner: 'none', userScopeId: 'A//s-1', personaScopeId: 'A//s-1::tutor', namespace: 'A' },
      });
      expect(visitorTurn.systemPrompts[0]?.content).toBe(renderPersonalitySection(TUTOR_PERSONA));
      const visitor = watchedWrite('mt-3');
      expect(await session.recordSelfChange!(visitor.input, { learner: 'none', namespace: 'A', turnUserId: 'bo', conversationId: 'conv-9' })).toMatchObject({
        status: 'kept',
      });
      const visitorChain = chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: null }, 'bo');
      expect((await store.chainRows(visitorChain)).map((row) => [row.userId, row.turnUserId, row.sessionId, row.verdict])).toEqual([
        [null, 'bo', 's-1', 'pending'],
        [null, 'bo', 's-1', 'kept'],
      ]);
      expect(await store.sessionRowsOf('A', 'bo')).toMatchObject([{ sessionId: 's-1', kind: 'visitor', conversationIds: ['conv-9'], brainIds: ['brain-1'] }]);
      const learnerAgain = await session.prepareTurn(productTurn());
      expect(learnerAgain).toMatchObject({ learner: 'none', noLearnerReason: 'other_user' });
      expect(learnerAgain.turnUserId).toBeUndefined();

      // 42 is forgotten while a write runs: the write is taken back for good and 42's learning rows go; bo's stay.
      const racing = watchedWrite('mt-4', async () => {
        await store.insertForgotten(await tombstoneHash('A', '42'), LEARNED_AT);
        return 'mt-4';
      });
      expect(await session.recordSelfChange!(racing.input, { learner: 'bound', namespace: 'A' })).toEqual({ status: 'rejected', reason: 'forgotten' });
      expect(racing.undone).toEqual([['mt-4', 'forgotten']]);
      expect(await store.chainRows(chain)).toEqual([]);
      expect(await store.traitRow('A', 'tutor', '42')).toBeUndefined();
      expect(await store.sessionRowsOf('A', '42')).toEqual([]);
      expect(await store.chainRows(visitorChain)).toHaveLength(2);
      // A later write of 42's is refused before it runs.
      const late = vi.fn(async () => 'mt-5');
      expect(await session.recordSelfChange!(watchedWrite('mt-5', late).input, { learner: 'bound', namespace: 'A' })).toEqual({
        status: 'rejected',
        reason: 'forgotten',
      });
      expect(late).not.toHaveBeenCalled();
    } finally {
      await layer.close();
    }
  });

  it("takes a write back as unrecorded when the tombstone cannot be read again, leaving its candidate pending, and names a forgotten user's tombstone, never the user, when a write cannot be taken back", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    /** A store whose tombstones cannot be read while `unreadable` is set, as a store whose connection dropped. */
    class FlakyTombstones extends InMemoryLearningStore {
      unreadable = false;
      async isForgotten(hash: string): Promise<boolean> {
        if (this.unreadable) throw new Error('tombstones unreadable');
        return super.isForgotten(hash);
      }
    }
    const store = new FlakyTombstones();
    const layer = createLearningLayer({ store });
    try {
      const session = await layer.forLearner(LEARNER_42, productContext('s-1'));
      await session.prepareTurn(productTurn());
      const unread = watchedWrite('mt-u', async () => {
        store.unreadable = true;
        return 'mt-u';
      });
      const result = await session.recordSelfChange!(unread.input);
      store.unreadable = false;
      expect(result).toMatchObject({ status: 'rejected', reason: 'store_unavailable' });
      expect(unread.undone).toEqual([['mt-u', 'unrecorded']]);
      const pending = (await store.chainRows(chainKeyOf(LEARNER_42))).filter((row) => row.subject === 'mt-u');
      expect(pending.map((row) => [row.rowType, row.verdict])).toEqual([['candidate', 'pending']]);
      expect(result.status === 'rejected' ? result.ledgerId : undefined).toBe(pending[0].id);

      // A forgotten user's write whose undo fails: the warning names the tombstone's first 16 hex digits, never the user.
      const zed: LearnerKey = { namespace: 'A', agentKey: 'tutor', userId: 'zed-private' };
      const zedSession = await layer.forLearner(zed, productContext('s-2'));
      await zedSession.prepareTurn(productTurn({ userId: 'zed-private' }));
      const hash = await tombstoneHash('A', 'zed-private');
      const stuck: SessionSelfChange<string> = {
        ...watchedWrite('mt-z').input,
        apply: async () => {
          await store.insertForgotten(hash, LEARNED_AT);
          return 'mt-z';
        },
        undo: async () => {
          throw new Error('the trace is locked');
        },
      };
      expect(await zedSession.recordSelfChange!(stuck)).toEqual({ status: 'rejected', reason: 'forgotten' });
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes(`(tombstone ${hash.slice(0, 16)}) was not taken back (the trace is locked)`))).toBe(true);
      expect(lines.some((line) => line.includes('zed-private'))).toBe(false);
      expect(await store.traitRow('A', 'tutor', 'zed-private')).toBeUndefined();
      expect(await store.chainRows(chainKeyOf(zed))).toEqual([]);
    } finally {
      await layer.close();
    }
  });

  it("files a session with no learner under the session's own form, records its writes under the agent, and a named user's turn on it under that user", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { adapter } = await processOver(learningFile());
    const layer = createLearningLayer({ storageAdapter: adapter });
    const store = new SqlLearningStore({ adapter });
    try {
      const placeholder = await layer.forLearner({ namespace: '', agentKey: 'tutor', userId: 'anonymous' }, productContext('s-9'));
      const placeholderTurn = await placeholder.prepareTurn(productTurn({ userId: 'anonymous', namespace: '' }));
      expect(placeholderTurn).toMatchObject({
        learner: 'none',
        noLearnerReason: 'placeholder_user',
        scopes: { learner: 'none', userScopeId: '/s-9', personaScopeId: '/s-9::tutor', namespace: '' },
      });
      expect(placeholderTurn.turnUserId).toBeUndefined();
      expect(placeholderTurn.systemPrompts[0]?.content).toBe(renderPersonalitySection(TUTOR_PERSONA));
      expect(await store.traitRow('', 'tutor', 'anonymous')).toBeUndefined();
      expect(await placeholder.recordSelfChange!(watchedWrite('mt-p1').input, { learner: 'none', namespace: '' })).toMatchObject({ status: 'kept' });
      expect(
        (await store.chainRows(chainKeyOf({ namespace: '', agentKey: 'tutor', userId: null }))).map((row) => [row.userId, row.turnUserId, row.sessionId, row.verdict]),
      ).toEqual([
        [null, null, 's-9', 'pending'],
        [null, null, 's-9', 'kept'],
      ]);
      // A named user's turn on it records that user.
      expect((await placeholder.prepareTurn(productTurn({ userId: 'ana', namespace: '' }))).turnUserId).toBe('ana');
      expect(await placeholder.recordSelfChange!(watchedWrite('mt-p2').input, { learner: 'none', namespace: '', turnUserId: 'ana' })).toMatchObject({ status: 'kept' });
      expect((await store.chainRows(chainKeyOf({ namespace: '', agentKey: 'tutor', userId: null }, 'ana'))).map((row) => row.turnUserId)).toEqual(['ana', 'ana']);
      expect(await store.sessionRowsOf('', 'ana')).toMatchObject([{ sessionId: 's-9', kind: 'visitor' }]);
      expect(placeholder.scopesFor!({ userId: 'ana', namespace: '', workflowSeat: false })).toMatchObject({ learner: 'none', userScopeId: '/s-9' });
      // A session opened with no key at all is the same.
      const keyless = await layer.forLearner(null, productContext('s-10'));
      expect(await keyless.prepareTurn(productTurn({ userId: null, namespace: '' }))).toMatchObject({
        learner: 'none',
        noLearnerReason: 'no_user_id',
        scopes: { learner: 'none', userScopeId: '/s-10', personaScopeId: '/s-10::tutor' },
      });
      expect((await layer.manifest()).turns).toEqual({ prepared: 3, bound: 0, none: { placeholder_user: 2, no_user_id: 1 } });
    } finally {
      await layer.close();
    }
  });

  it("guards a host's own filing between two reads of the tombstone, refuses a recorded write under a freeze with a suspension beside it, writes no learned state in mode off, and refuses the writes of an id the store cannot hold", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { adapter } = await processOver(learningFile());
    const layer = createLearningLayer({ storageAdapter: adapter });
    const store = new SqlLearningStore({ adapter });
    const learner7: LearnerKey = { namespace: 'A', agentKey: 'tutor', userId: '7' };
    const operatorRow = (scopeKey: string, mode: FreezeRow['mode'], userId: string | null): FreezeRow => ({
      scopeKey,
      mode,
      namespace: 'A',
      agentKey: 'tutor',
      userId,
      setBy: 'operator:ops',
      createdAt: LEARNED_AT,
    });
    try {
      const session = await layer.forLearner(learner7, productContext('s-2'));
      expect((await session.prepareTurn(productTurn({ userId: '7' }))).mode).toBe('on');

      // A freeze on the learner refuses a recorded write before it runs, with the agent suspended beside it.
      await store.insertFreeze(operatorRow(freezeScopeKey({ agentKey: 'tutor' }), 'off', null));
      await store.insertFreeze(operatorRow(freezeScopeKey({ learner: learner7 }), 'frozen', '7'));
      expect((await session.prepareTurn(productTurn({ userId: '7' }))).mode).toBe('off');
      expect(session.isFrozen!()).toBe(true);
      const blocked = vi.fn(async () => 'mt-7');
      expect(await session.recordSelfChange!(watchedWrite('mt-7', blocked).input)).toEqual({ status: 'rejected', reason: 'frozen' });
      expect(blocked).not.toHaveBeenCalled();

      // The suspension alone: the write is made with no ledger row.
      await store.deleteFreeze(freezeScopeKey({ learner: learner7 }), 'frozen');
      expect((await session.prepareTurn(productTurn({ userId: '7' }))).mode).toBe('off');
      expect(session.isFrozen!()).toBe(false);
      expect(await session.recordSelfChange!(watchedWrite('mt-8').input)).toEqual({ status: 'written', result: 'mt-8' });
      expect((await store.chainRows(chainKeyOf(learner7))).filter((row) => row.kind === 'memory_write')).toEqual([]);

      // The process freeze is read at the call.
      await store.deleteFreeze(freezeScopeKey({ agentKey: 'tutor' }), 'off');
      expect((await session.prepareTurn(productTurn({ userId: '7' }))).mode).toBe('on');
      expect(session.isFrozen!()).toBe(false);
      vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
      expect(session.isFrozen!()).toBe(true);
      vi.unstubAllEnvs();

      // The guard: a write between two reads of the tombstone, taken back when the tombstone lands while it runs, and
      // refused before it runs once the user is forgotten.
      expect(await session.guardMemoryWrite!({ apply: async () => 'trace-1', undo: async () => undefined })).toEqual({ status: 'written', result: 'trace-1' });
      const takenBack: string[] = [];
      expect(
        await session.guardMemoryWrite!({
          apply: async () => {
            await store.insertForgotten(await tombstoneHash('A', '7'), LEARNED_AT);
            return 'trace-2';
          },
          undo: async (id) => {
            takenBack.push(id);
          },
        }),
      ).toEqual({ status: 'rejected', reason: 'forgotten' });
      expect(takenBack).toEqual(['trace-2']);
      const never = vi.fn(async () => 'trace-3');
      expect(await session.guardMemoryWrite!({ apply: never, undo: async () => undefined })).toEqual({ status: 'rejected', reason: 'forgotten' });
      expect(never).not.toHaveBeenCalled();

      // Mode off: no trait row read or written; the learner's session row and the scopes stay; a write has no row.
      const off = createLearningLayer({ storageAdapter: adapter, mode: 'off' });
      try {
        const offSession = await off.forLearner({ namespace: 'B', agentKey: 'tutor', userId: '42' }, productContext('s-3'));
        const offTurn = await offSession.prepareTurn(productTurn({ namespace: 'B' }));
        expect(offTurn).toMatchObject({
          learner: 'bound',
          mode: 'off',
          scopes: { learner: 'bound', mode: 'off', userScopeId: 'B/42', personaScopeId: 'B/42::tutor', namespace: 'B' },
        });
        expect(offTurn.systemPrompts[0]?.content).toBe(renderPersonalitySection(TUTOR_PERSONA));
        expect(await store.traitRow('B', 'tutor', '42')).toBeUndefined();
        expect((await store.sessionRowsOf('B', '42')).map((row) => [row.sessionId, row.kind])).toEqual([['s-3', 'learner']]);
        expect(await offSession.recordSelfChange!(watchedWrite('mt-9').input)).toEqual({ status: 'written', result: 'mt-9' });
        expect(await store.chainRows(chainKeyOf({ namespace: 'B', agentKey: 'tutor', userId: '42' }))).toEqual([]);
      } finally {
        await off.close();
      }

      // A user id a SQL text column cannot hold (a lone surrogate): the authored traits render, and the writes that
      // need the store are refused.
      const lone = await layer.forLearner({ namespace: 'A', agentKey: 'tutor', userId: 'a\uD800' }, productContext('s-4'));
      const loneTurn = await lone.prepareTurn(productTurn({ userId: 'a\uD800' }));
      expect(loneTurn).toMatchObject({ learner: 'bound', mode: 'on' });
      expect(loneTurn.systemPrompts[0]?.content).toBe(renderPersonalitySection(TUTOR_PERSONA));
      const refused = vi.fn(async () => 'mt-10');
      expect(await lone.recordSelfChange!(watchedWrite('mt-10', refused).input)).toMatchObject({ status: 'rejected', reason: 'store_unavailable' });
      expect(await lone.guardMemoryWrite!({ apply: refused, undo: async () => undefined })).toEqual({ status: 'rejected', reason: 'store_unavailable' });
      expect(refused).not.toHaveBeenCalled();
      expect(warn.mock.calls.some((call) => String(call[0]).includes("a learner's trait row could not be read"))).toBe(true);
    } finally {
      await layer.close();
    }
  });

  it("degrades while its store does not open: the persona's traits render, the writes that need the store are refused, the manifest says why, and a later call opens it", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    /** An in-process store whose first read fails until the host unlocks it, as a store over a locked file does. */
    class LockedStore extends InMemoryLearningStore {
      locked = true;
      reads = 0;
      async freezeRows(): Promise<FreezeRow[]> {
        this.reads += 1;
        if (this.locked) throw new Error('brain file locked');
        return super.freezeRows();
      }
    }

    // gmi() with learning.store.
    const locked = new LockedStore();
    const k = key();
    const played = script('openai', k, { replies: [reply.text('One.'), reply.text('Two.')] });
    const tutor = tutorAgent(k, TUTOR_PERSONA, { store: locked });
    try {
      const session = tutor.session('s1', { userId: 'ana' });
      await session.send('Hello.');
      expect(systemTextOf(played.seen[0])).toContain(renderPersonalitySection(TUTOR_PERSONA)!);
      const degraded = await tutor.learning!.manifest();
      expect(degraded.loops.ledger).toEqual({ live: false, detail: 'store unavailable: brain file locked' });
      expect(degraded.loops.personality_rendering).toEqual({ live: true, detail: 'traits: degraded (brain file locked)' });
      expect(await locked.traitRow('', 'tutor', 'ana')).toBeUndefined();
      expect(locked.reads).toBeGreaterThan(1);
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('the learning store did not open (brain file locked)'))).toHaveLength(1);
      locked.locked = false;
      await session.send('Again.');
      expect(await locked.traitRow('', 'tutor', 'ana')).toMatchObject({ personaId: 'tutor', version: 1 });
      const opened = await tutor.learning!.manifest();
      expect(opened.loops.ledger).toEqual({ live: true, detail: `${IN_PROCESS_STORE}; unkeyed` });
      expect(opened.loops.personality_rendering).toEqual({ live: true });
    } finally {
      await tutor.close();
    }

    // A host's own turn loop that opens its store on first use.
    const { adapter } = await processOver(learningFile());
    const sql = new SqlLearningStore({ adapter });
    let unlocked = false;
    let opens = 0;
    const layer = createLearningLayer({
      openStore: async () => {
        opens += 1;
        if (!unlocked) throw new Error('brain file locked');
        return sql;
      },
    });
    try {
      const session = await layer.forLearner(LEARNER_42, productContext('s-1'));
      const prepared = await session.prepareTurn(productTurn());
      expect(prepared.systemPrompts[0]?.content).toBe(renderPersonalitySection(TUTOR_PERSONA));
      expect(prepared.scopes).toMatchObject({ learner: 'bound', userScopeId: 'A/42' });
      const refused = vi.fn(async () => 'mt-1');
      expect(await session.recordSelfChange!(watchedWrite('mt-1', refused).input)).toMatchObject({ status: 'rejected', reason: 'store_unavailable' });
      expect(await session.guardMemoryWrite!({ apply: refused, undo: async () => undefined })).toEqual({ status: 'rejected', reason: 'store_unavailable' });
      expect(refused).not.toHaveBeenCalled();
      expect((await layer.manifest()).loops.ledger).toEqual({ live: false, detail: 'store unavailable: brain file locked' });
      unlocked = true;
      await session.prepareTurn(productTurn());
      expect((await layer.manifest()).loops.ledger).toEqual({ live: true, detail: "sql store over the agent's memory store; unkeyed" });
      expect(await sql.traitRow('A', 'tutor', '42')).toMatchObject({ version: 1 });
      expect(await session.recordSelfChange!(watchedWrite('mt-2').input)).toMatchObject({ status: 'kept', result: 'mt-2' });
      expect(opens).toBeGreaterThan(2);
    } finally {
      await layer.close();
    }
  });

  it("says in the manifest where its store lives and whether its hashes are keyed: the store the host passed, SQL over the host's adapter, in process for an adapter without transactions or none", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { adapter } = await processOver(learningFile());
    const ledgerLoop = async (options: Parameters<typeof createLearningLayer>[0]) => {
      const layer = createLearningLayer(options);
      try {
        return (await layer.manifest()).loops.ledger;
      } finally {
        await layer.close();
      }
    };
    expect(await ledgerLoop({})).toEqual({ live: true, detail: `${IN_PROCESS_STORE}; unkeyed` });
    expect(await ledgerLoop({ storageAdapter: adapter })).toEqual({ live: true, detail: "sql store over the host's storage adapter; unkeyed" });
    expect(await ledgerLoop({ storageAdapter: adapter, ledgerKey: LEDGER_KEY })).toEqual({ live: true, detail: "sql store over the host's storage adapter; keyed" });
    const noTransactions = { kind: 'kv', capabilities: new Set<string>() } as unknown as StorageAdapter;
    expect(await ledgerLoop({ storageAdapter: noTransactions })).toEqual({
      live: true,
      detail: 'in process: the storage adapter has no transactions; the ledger and the state it records end with the process; unkeyed',
    });
    expect(await ledgerLoop({ store: new SqlLearningStore({ adapter }) })).toEqual({ live: true, detail: 'sql store the host passed; unkeyed' });
    expect(await ledgerLoop({ store: new InMemoryLearningStore(), ledgerKey: LEDGER_KEY })).toEqual({ live: true, detail: `${IN_PROCESS_STORE}; keyed` });
    // The store the host passed wins over its adapter.
    expect(await ledgerLoop({ store: new InMemoryLearningStore(), storageAdapter: adapter })).toEqual({ live: true, detail: `${IN_PROCESS_STORE}; unkeyed` });
    // gmi() with no store keeps its ledger in process.
    expect((await oneTurn(TUTOR_PERSONA, {})).manifest.loops.ledger).toEqual({ live: true, detail: `${IN_PROCESS_STORE}; unkeyed` });
  });

  it("opens a learner session named at its first turn under that turn's namespace on every attempt, keeps a hand-over made while it could not open, and answers and refuses before it opens", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const layer = createLearningLayer();
    const openLearner = (namespace: string): Promise<ILearnerSession> =>
      layer.forLearner({ namespace, agentKey: 'tutor', userId: 'ana' }, productContext('s-1'));
    /** A session named at its first turn whose first `failures` opens fail, and the namespaces it opened under. */
    const namedAtFirstTurn = (
      failures: number,
      openSession: (namespace: string) => Promise<ILearnerSession> = openLearner,
      extra: { defaultNamespace?: string; mode?: () => 'on' | 'off' | 'frozen' } = {},
    ) => {
      const opened: string[] = [];
      let left = failures;
      const session = deferLearnerSession({
        traits: TUTOR_PERSONA,
        sessionId: 's-1',
        personaId: 'tutor',
        ...extra,
        open: async (namespace) => {
          opened.push(namespace);
          if (left-- > 0) throw new Error('store offline');
          return openSession(namespace);
        },
      });
      return { session, opened };
    };
    const anaTurn = (namespace: string, userId = 'ana') => productTurn({ userId, namespace });
    try {
      // The first open fails: the next turn opens under the first turn's namespace and is read against it.
      const one = namedAtFirstTurn(1);
      await expect(one.session.prepareTurn(anaTurn('A'))).rejects.toThrow('store offline');
      expect(await one.session.prepareTurn(anaTurn('B'))).toMatchObject({ learner: 'none', noLearnerReason: 'other_namespace' });
      expect(one.opened).toEqual(['A', 'A']);

      // A hand-over to another user while it could not open holds once it opens.
      const two = namedAtFirstTurn(2);
      await expect(two.session.prepareTurn(anaTurn('A'))).rejects.toThrow('store offline');
      await expect(two.session.prepareTurn(anaTurn('A', 'bo'))).rejects.toThrow('store offline');
      expect(await two.session.prepareTurn(anaTurn('A'))).toMatchObject({ learner: 'none', noLearnerReason: 'other_user' });

      // An open that succeeds at the first turn: a learner's turn.
      expect(await namedAtFirstTurn(0).session.prepareTurn(anaTurn('A'))).toMatchObject({ learner: 'bound', mode: 'on', scopes: { userScopeId: 'A/ana' } });

      // Before it opens: the session's own form with no learner, under the agent's namespace for a turn with none, and
      // the writes that need the store refused.
      const down = namedAtFirstTurn(Number.POSITIVE_INFINITY, openLearner, { defaultNamespace: 'A' });
      expect(down.session.scopesFor!({ userId: 'ana', namespace: '', workflowSeat: false })).toEqual({
        learner: 'none',
        mode: 'on',
        userScopeId: 'A//s-1',
        personaScopeId: 'A//s-1::tutor',
        namespace: 'A',
      });
      const refused = vi.fn(async () => 'mt-1');
      expect(await down.session.recordSelfChange!(watchedWrite('mt-1', refused).input)).toMatchObject({ status: 'rejected', reason: 'store_unavailable' });
      expect(await down.session.guardMemoryWrite!({ apply: refused, undo: async () => undefined })).toEqual({ status: 'rejected', reason: 'store_unavailable' });
      expect(refused).not.toHaveBeenCalled();
      expect(down.session.currentTraits()).toEqual(TUTOR_PERSONA);
      expect(down.session.isFrozen!()).toBe(false);
      vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
      expect(down.session.isFrozen!()).toBe(true);
      vi.unstubAllEnvs();
      const frozenDown = namedAtFirstTurn(Number.POSITIVE_INFINITY, openLearner, { mode: () => 'frozen' });
      expect(frozenDown.session.scopesFor!({ userId: 'ana', namespace: '', workflowSeat: false })).toMatchObject({ learner: 'none', mode: 'frozen', userScopeId: '/s-1' });
      expect(frozenDown.session.isFrozen!()).toBe(true);

      // A host's own session, which cannot take the loss: the turns after a hand-over made while it could not open have
      // no learner, render the persona's traits and file under the session's own form.
      const hostSession = async (): Promise<ILearnerSession> => ({
        prepareTurn: async () => ({ systemPrompts: [], learner: 'bound', mode: 'on' }),
        endSession: async () => undefined,
        currentTraits: () => ({}),
      });
      const own = namedAtFirstTurn(2, hostSession);
      await expect(own.session.prepareTurn(anaTurn('A'))).rejects.toThrow('store offline');
      await expect(own.session.prepareTurn(anaTurn('A', 'bo'))).rejects.toThrow('store offline');
      expect(await own.session.prepareTurn(anaTurn('A'))).toEqual({
        systemPrompts: [{ content: renderPersonalitySection(TUTOR_PERSONA), priority: 2, source: 'learning:personality' }],
        learner: 'none',
        noLearnerReason: 'other_user',
        mode: 'on',
        scopes: { learner: 'none', mode: 'on', userScopeId: 'A//s-1', personaScopeId: 'A//s-1::tutor', namespace: 'A' },
      });
      expect(await own.session.prepareTurn(anaTurn('A'))).toMatchObject({ learner: 'none', noLearnerReason: 'other_user' });
      expect(own.session.scopesFor!({ userId: 'ana', namespace: 'A', workflowSeat: false })).toMatchObject({ learner: 'none', userScopeId: 'A//s-1' });
    } finally {
      await layer.close();
    }
  });

  it("reads a band only by one of its three names from the map's own property, an overlay's patch written under an alias, and one list of the operator's traits", () => {
    // A stored row is read at run time, so a band is not checked by the compiler.
    expect(renderPersonalitySection({}, { bands: { openness: 'HIGH' as never } })).toBeNull();
    expect(renderPersonalitySection({}, { bands: { openness: 'toString' as never } })).toBeNull();
    expect(renderPersonalitySection({}, { bands: Object.create({ openness: 'high' }) })).toBeNull();
    expect(renderPersonalitySection({ openness: 0.9 }, { bands: { openness: 'nonsense' as never } })).toBe(renderPersonalitySection({ openness: 0.9 }));
    expect(renderPersonalitySection({}, { bands: { openness: 'high' } })).toBe(renderPersonalitySection({ openness: 0.9 }));
    expect(traitOverlayPatch({ honesty: 0.8 }, { honesty: 0.8, honestyHumility: 0.1 })).toEqual({ honesty: 0.1 });
    expect(traitOverlayPatch({ openness: 0.4 }, { openness: 0.4, opennessToExperience: 0.9 })).toEqual({ openness: 0.9 });
    expect(traitOverlayPatch({ openness: 0.4, opennessToExperience: 0.9 }, { openness: 0.4, opennessToExperience: 0.9 })).toBeUndefined();
    expect(HEXACO_TRAIT_ALIASES).toEqual([
      ['honestyHumility', 'honesty'],
      ['honesty_humility', 'honesty'],
      ['opennessToExperience', 'openness'],
    ]);
    expect(OPERATOR_ONLY_TRAITS).toEqual(['honesty', 'emotionality']);
    expect(LEARNABLE_TRAITS).toEqual(['extraversion', 'agreeableness', 'conscientiousness', 'openness']);
    expect(LIFETIME_BAND).toBe(0.2);
  });

  it('renders a trait a persona writes under its canonical key and an alias by the canonical key, with no role overlay, on gmi() and the full runtime', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const both = { honesty: 0.9, openness: 0.4, opennessToExperience: 0.9 };
    // The canonical key wins, as the normalizer reads it: openness 0.4 renders no directive.
    const expected = renderPersonalitySection({ honesty: 0.9, openness: 0.4 })!;
    const highOpenness = directiveFor('openness', 0.9);
    const viaGmi = await oneTurn(both, { store: new InMemoryLearningStore() });
    expect(viaGmi.system).toContain(expected);
    expect(viaGmi.system).not.toContain(highOpenness);

    const k = key();
    const played = script('openai', k, { replies: Array.from({ length: 8 }, () => reply.text('Noted.')), whole: true });
    const os = await bootRuntime(k, both, true);
    try {
      const system = await runtimeTurn(os, played);
      expect(system).toContain(expected);
      expect(system).not.toContain(highOpenness);
    } finally {
      await os.shutdown();
    }
  });

  it("keeps the full runtime's learners in the store its learning option names, under its key: across a restart a persona's move renders the clamped value and the chain verifies", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const file = learningFile();
    const k = key();
    const played = script('openai', k, { replies: Array.from({ length: 16 }, () => reply.text('Noted.')), whole: true });

    const first = await processOver(file);
    const booted = await bootRuntime(k, TUTOR_PERSONA, { store: first.store, ledgerKey: LEDGER_KEY });
    try {
      expect(await runtimeTurn(booted, played)).toContain(renderPersonalitySection(TUTOR_PERSONA)!);
      expect((await booted.getLearningLayer()!.manifest()).loops.ledger).toEqual({ live: true, detail: 'sql store the host passed; keyed' });
    } finally {
      await booted.shutdown();
    }
    expect(await first.store.traitRow('', 'tutor', 'ana')).toMatchObject({ personaId: 'tutor', version: 1 });

    const moved = { honesty: 0.9, extraversion: 0.3 };
    const second = await processOver(file);
    const rebooted = await bootRuntime(k, moved, { store: second.store, ledgerKey: LEDGER_KEY });
    try {
      const system = await runtimeTurn(rebooted, played);
      expect(system).toContain(renderPersonalitySection({ honesty: 0.9, extraversion: 0.5 })!);
      expect(system).not.toContain(directiveFor('extraversion', 0.3));
      expect((await rebooted.getLearningLayer()!.manifest()).loops.ledger.detail).toBe('sql store the host passed; keyed');
    } finally {
      await rebooted.shutdown();
    }
    expect((await second.store.chainRows(ANA_CHAIN)).map((row) => JSON.parse(row.body).reason)).toEqual(['created', 'created', 'persona_changed', 'persona_changed']);
    expect(await new Ledger({ store: second.store, ledgerKey: LEDGER_KEY }).verifyChain(ANA_CHAIN)).toEqual({ ok: true, keyed: true });
  });

  it("names the stores, the ledger, the freeze keys and a trait's bounds on the learning module's own path, as the same objects their own paths hold", async () => {
    const storePath = await import('@framers/agentos/cognition/learning/store/index');
    const ledgerPath = await import('@framers/agentos/cognition/learning/ledger/index');
    expect(InMemoryLearningStore).toBe(storePath.InMemoryLearningStore);
    expect(SqlLearningStore).toBe(storePath.SqlLearningStore);
    expect(ensureLearningSchema).toBe(storePath.ensureLearningSchema);
    expect(LEARNING_TABLES).toBe(storePath.LEARNING_TABLES);
    expect(LEARNING_SCHEMA_DDL).toBe(storePath.LEARNING_SCHEMA_DDL);
    expect(Ledger).toBe(ledgerPath.Ledger);
    expect(chainKeyOf).toBe(ledgerPath.chainKeyOf);
    expect(tombstoneHash).toBe(ledgerPath.tombstoneHash);
    expect(GENESIS_HASH).toBe(ledgerPath.GENESIS_HASH);
    expect(freezeScopeKey({ scope: 'all' })).toBe('all');
    expect(freezeScopeKey({ agentKey: 'tutor' })).toBe('agent|tutor');
    expect(freezeScopeKey({ learner: { namespace: 'A', agentKey: 'tutor', userId: '42' } })).toBe('learner|A|tutor|42');
    expect(freezeScopeKey({ learner: { namespace: '', agentKey: 'tutor', userId: 'ana' } })).toBe('learner||tutor|ana');
    // Each part encoded, so no id moves a part's boundary.
    expect(freezeScopeKey({ learner: { namespace: 'org one', agentKey: 'tu|tor', userId: 'a/b' } })).toBe('learner|org%20one|tu%7Ctor|a%2Fb');
    expect(freezeScopeKey({ agentKey: 'a|b' })).not.toBe(freezeScopeKey({ learner: { namespace: 'a', agentKey: 'b', userId: '' } }));
    expectTypeOf<OperatorTraits>().toEqualTypeOf<Partial<Record<'honesty' | 'emotionality', number>>>();
    expectTypeOf<TraitState['honestyAtLastLoad']>().toEqualTypeOf<number>();
    expectTypeOf<TraitState['rendererVersion']>().toEqualTypeOf<1>();
  });
});

/** Every call an operator makes on a learning layer, by its name. */
const HOST_CALLS = ['freeze', 'unfreeze', 'suspend', 'unsuspend', 'operatorSet', 'revert', 'exportLearnedState', 'importLearnedState', 'forgetUser'] as const;

/** A recorded write's ledger id; throws when the write was not kept. */
function ledgerIdOf(result: ProposalResult): string {
  if (result.status !== 'kept') throw new Error(`the write was ${result.status}`);
  return result.ledgerId;
}

/** A memory_add as a host's memory tool makes it: the trace's id named first, the write made through the session's recorder. */
function addThrough(memory: Memory, content: string, scope: 'user' | 'persona' | 'thread', scopeId: string, metadata?: Record<string, unknown>): SessionSelfChange<string> {
  const id = `mt-qa-${++serial}`;
  return {
    kind: 'memory_write',
    actor: 'tool:memory_add',
    subject: id,
    before: null,
    after: { created: [id], changed: [], deleted: [] },
    brainId: memory.brainId,
    apply: async () => (await memory.remember(content, { id, scope, scopeId, ...(metadata ? { metadata } : {}) })).id,
    undo: async (traceId) => {
      await memory.deleteTraces([traceId]);
    },
  };
}

/** The text of every live trace a Brain file holds, sorted, as a host's own reader of the file sees it. */
function liveContents(file: string): string[] {
  const db = new Database(file);
  try {
    return (db.prepare('SELECT content FROM memory_traces WHERE deleted = 0 ORDER BY content').all() as Array<{ content: string }>).map((row) => row.content);
  } finally {
    db.close();
  }
}

/** A chain's candidates, as a host reads their entries back. */
async function candidatesOf(store: LearningStore, chainKey: string): Promise<LedgerEntry[]> {
  return (await store.chainRows(chainKey)).filter((row) => row.rowType === 'candidate').map((row) => JSON.parse(row.body) as LedgerEntry);
}

/** A candidate's rows in order: its own and each verdict, with the verdict and the reason each records. */
async function verdictsOf(store: LearningStore, candidateId: string): Promise<Array<[string, string]>> {
  return (await store.candidateRows(candidateId)).map((row): [string, string] => [row.verdict, (JSON.parse(row.body) as LedgerEntry).reason]);
}

describe("an operator's calls on a learner: freezes and suspensions, operatorSet, revert, export and import, forgetUser and a crash's pending write", () => {
  let keys = 0;
  const key = () => `k-qa-operator-${++keys}`;
  const adapters: StorageAdapter[] = [];
  afterEach(async () => {
    for (const adapter of adapters.splice(0).reverse()) await adapter.close().catch(() => undefined);
  });

  /** The learner `ana` of the gmi() agent named `Tutor` (persona id `tutor`) and of the runtime's persona `tutor`. */
  const ANA: LearnerKey = { namespace: '', agentKey: 'tutor', userId: 'ana' };

  /** A process over the host's SQLite file: the file opened (again) and a learning store over it. */
  async function processOver(file: string): Promise<{ adapter: StorageAdapter; store: SqlLearningStore }> {
    const adapter = await openSqliteAt(file);
    adapters.push(adapter);
    return { adapter, store: new SqlLearningStore({ adapter }) };
  }

  /** A `Memory` facade over a SQLite file of its own, as a host's memory tools are built over; closed after the test. */
  async function toolsFacade(brainId = 'tools-brain'): Promise<{ memory: Memory; file: string }> {
    const file = brainFile();
    const memory = await Memory.createSqlite(file, { brainId });
    facades.push(memory);
    return { memory, file };
  }

  /** A gmi() agent named `Tutor` (persona id `tutor`), its provider the stub played under `apiKey`. */
  const tutorAgent = (apiKey: string, personality: Record<string, number>, learning: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    gmi({
      runtime: 'gmi',
      provider: 'openai',
      model: 'stub-model',
      apiKey,
      fallbackProviders: [],
      name: 'Tutor',
      instructions: 'You teach networking.',
      personality,
      learning,
      ...extra,
    } as never);

  /** One session of one turn of `ana` on a new gmi() tutor: the system text its model was sent. */
  async function oneTurn(personality: Record<string, number>, learning: Record<string, unknown>, sessionId = 's1'): Promise<string> {
    const k = key();
    const played = script('openai', k, { replies: [reply.text('Noted.')] });
    const tutor = tutorAgent(k, personality, learning);
    try {
      await tutor.session(sessionId, { userId: 'ana' }).send('Hello.');
      return systemTextOf(played.seen.at(-1));
    } finally {
      await tutor.close();
    }
  }

  /** The full runtime over one persona `tutor` with `traits`, its provider the stub played under `apiKey`. */
  const bootRuntime = (apiKey: string, traits: Record<string, number>, learning: unknown): Promise<AgentOS> =>
    AgentOS.create({
      modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey } }] },
      turnPlanning: { enabled: false },
      personas: [{ id: 'tutor', name: 'Tutor', description: 'A tutor.', version: '1.0.0', baseSystemPrompt: 'You teach networking.', personalityTraits: traits }],
      learning,
    } as never);

  /** One turn of `ana` on the full runtime: the system text of the turn's streamed model call. */
  async function runtimeTurn(os: AgentOS, played: ReturnType<typeof script>): Promise<string> {
    for await (const _chunk of os.processRequest({ textInput: 'Hello.', userId: 'ana', sessionId: 's-ana', selectedPersonaId: 'tutor' } as never)) {
      // Drained: the turn's answer is not what is read here.
    }
    return systemTextOf(played.seen.filter((call) => call.streamed).at(-1));
  }

  /** The personality section a host's own turn loop gets for a turn of learner 42 of tenant A. */
  const sectionOf = async (session: ILearnerSession): Promise<string | null> => (await session.prepareTurn(productTurn())).systemPrompts[0]?.content ?? null;

  it("names the nine operator calls on the layer a host builds, every one required on its type, and on the full runtime's layer at run time, and reads a trace's snapshot from the package root", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const layer: LearningLayerHandle = createLearningLayer();
    expectTypeOf(createLearningLayer).returns.toEqualTypeOf<LearningLayerHandle>();
    expectTypeOf(layer.freeze).parameter(0).toEqualTypeOf<FreezeScope>();
    expectTypeOf(layer.operatorSet).parameter(0).toEqualTypeOf<OperatorSetInput>();
    expectTypeOf(layer.exportLearnedState).returns.toEqualTypeOf<Promise<LearnedStateDocument>>();
    expectTypeOf(layer.importLearnedState).returns.toEqualTypeOf<Promise<ImportReport>>();
    expectTypeOf(layer.forgetUser).returns.toEqualTypeOf<Promise<ForgetReport>>();
    for (const call of HOST_CALLS) expect(typeof layer[call]).toBe('function');

    const k = key();
    script('openai', k, { replies: [reply.text('Noted.')] });
    const booted = await bootRuntime(k, TUTOR_PERSONA, { store: new InMemoryLearningStore() });
    try {
      const runtimeLayer = booted.getLearningLayer();
      expectTypeOf(runtimeLayer).toEqualTypeOf<ILearningLayer | undefined>();
      for (const call of HOST_CALLS) expect(typeof runtimeLayer?.[call]).toBe('function');
    } finally {
      await booted.shutdown();
    }

    // The snapshot a host reads to restore a trace (Memory.restoreTrace): one reader, on the root, the memory module and its own path.
    const memoryModule = await import('@framers/agentos/cognition/memory');
    const ownPath = await import('@framers/agentos/cognition/memory/retrieval/store/tracePersistence');
    expect(readTraceSnapshot).toBe(memoryModule.readTraceSnapshot);
    expect(readTraceSnapshot).toBe(ownPath.readTraceSnapshot);
    expectTypeOf<TraceSnapshot>().toEqualTypeOf<import('@framers/agentos/cognition/memory/retrieval/store/tracePersistence').TraceSnapshot>();

    // The learning module names the check of a learner key and the scopes a deletion takes.
    expect(() => assertLearnerKey({ namespace: 'A', agentKey: 'tutor' }, 'host')).toThrow(TypeError);
    expect(() => assertLearnerKey({ namespace: 'A', agentKey: 'tutor' }, 'host')).toThrow('host: learner.userId must be a non-blank string.');
    const row = (sessionId: string, kind: SessionRow['kind'], conversationIds: string[]): SessionRow => ({
      namespace: 'A',
      agentKey: 'tutor',
      sessionId,
      userId: '42',
      kind,
      personaId: 'tutor',
      conversationIds,
      brainIds: ['qa'],
      startedAt: LEARNED_AT,
      version: 1,
    });
    const targets: ForgetTarget[] = forgetTargets('A', '42', [row('s-1', 'learner', ['conv-1']), row('s-2', 'visitor', [])]);
    expect(targets).toEqual([
      { scope: 'user', scopeId: 'A/42' },
      { scope: 'persona', scopeId: 'A/42::tutor' },
      { scope: 'user', scopeId: 'A//s-1' },
      { scope: 'persona', scopeId: 'A//s-1::tutor' },
      { scope: 'thread', scopeId: 'A//conv-1' },
      { scope: 'thread', scopeId: 'A//s-1' },
      { scope: 'user', scopeId: 'A//s-2', turnUserId: '42' },
      { scope: 'persona', scopeId: 'A//s-2::tutor', turnUserId: '42' },
      { scope: 'thread', scopeId: 'A//s-2', turnUserId: '42' },
    ]);
  });

  it("freezes and suspends a learner, its agent or every agent from an operator's process: each is a row of the host's store a serving agent reads at its next turn and a later layer at its first, lifting it deletes the row, and a forget there stops the agent rendering the learner's traits", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const file = learningFile();
    let now = Date.UTC(2026, 9, 31, 9);
    const at = () => new Date(now).toISOString();
    // The learner's first session writes the row; an operator, in a process of its own, sets extraversion to 0.62,
    // under the persona's high band.
    await oneTurn(TUTOR_PERSONA, { store: (await processOver(file)).store });
    const operator = createLearningLayer({ store: (await processOver(file)).store, clock: () => now });
    expect(await operator.operatorSet({ learner: ANA, traits: { extraversion: 0.62 }, by: 'ops' })).toMatchObject({ actor: 'operator:ops', reason: 'set' });
    const learned = renderPersonalitySection({ honesty: 0.9, extraversion: 0.62 })!;
    const authored = renderPersonalitySection(TUTOR_PERSONA)!;

    const seen: Array<{ context: unknown; selfChange: unknown; memoryWrite: unknown }> = [];
    const probe = {
      name: 'probe_learning',
      description: 'Reads what the turn tells its tools about learning.',
      inputSchema: { type: 'object', properties: {} },
      execute: async (_args: Record<string, unknown>, context: { sessionData?: Record<string, unknown> }) => {
        seen.push({
          context: readToolLearningContext(context.sessionData),
          selfChange: selfChangeRefusal(context.sessionData),
          memoryWrite: memoryWriteRefusal(context.sessionData),
        });
        return { success: true, output: 'read' };
      },
    };
    const k = key();
    const played = script('openai', k, {
      replies: Array.from({ length: 6 }, (_, turn) => [reply.tools([{ id: `c${turn}`, name: 'probe_learning', args: {} }]), reply.text('Done.')]).flat(),
    });
    const serving = await processOver(file);
    const tutor = tutorAgent(k, TUTOR_PERSONA, { store: serving.store }, { tools: [probe] });
    const session = tutor.session('s2', { userId: 'ana' });
    /** One turn: the system text it sent, and what the probe read. */
    const probed = async () => {
      seen.length = 0;
      await session.send('Read it.');
      expect(seen).toHaveLength(1);
      return { system: systemTextOf(played.seen.at(-1)), read: seen[0] };
    };
    try {
      const on = await probed();
      expect(on.read).toMatchObject({ context: { learner: 'bound', mode: 'on' }, selfChange: undefined, memoryWrite: undefined });
      expect(on.system).toContain(learned);
      expect(on.system).not.toContain(directiveFor('extraversion', 0.8));

      await operator.freeze({ learner: ANA }, 'ops');
      expect(await serving.store.freezeRows()).toEqual([
        { scopeKey: 'learner||tutor|ana', mode: 'frozen', namespace: '', agentKey: 'tutor', userId: 'ana', setBy: 'operator:ops', createdAt: at() },
      ]);
      const frozen = await probed();
      expect(frozen.read).toMatchObject({ context: { learner: 'bound', mode: 'frozen' }, selfChange: 'frozen', memoryWrite: 'frozen' });
      expect(frozen.system).toContain(learned);
      // A layer that starts on the store afterwards reads the freeze at its learner's first turn.
      const later = await createLearningLayer({ store: (await processOver(file)).store }).forLearner(ANA, productContext('s-later'));
      expect((await later.prepareTurn(productTurn({ userId: 'ana', namespace: '' }))).mode).toBe('frozen');

      await operator.unfreeze({ learner: ANA });
      now += 60_000;
      await operator.suspend({ agentKey: 'tutor' });
      expect(await serving.store.freezeRows()).toEqual([
        { scopeKey: 'agent|tutor', mode: 'off', namespace: '', agentKey: 'tutor', userId: null, setBy: 'operator:unnamed', createdAt: at() },
      ]);
      const suspended = await probed();
      expect(suspended.read).toMatchObject({ context: { learner: 'bound', mode: 'off' }, selfChange: 'off', memoryWrite: undefined });
      expect(suspended.system).toContain(authored);

      await operator.unsuspend({ agentKey: 'tutor' });
      await operator.freeze({ scope: 'all' }, ' ops ');
      expect(await serving.store.freezeRows()).toEqual([
        { scopeKey: 'all', mode: 'frozen', namespace: '', agentKey: null, userId: null, setBy: 'operator:ops', createdAt: at() },
      ]);
      expect((await probed()).read).toMatchObject({ context: { learner: 'bound', mode: 'frozen' }, selfChange: 'frozen', memoryWrite: 'frozen' });

      await operator.unfreeze({ scope: 'all' });
      expect(await serving.store.freezeRows()).toEqual([]);
      const lifted = await probed();
      expect(lifted.read).toMatchObject({ context: { learner: 'bound', mode: 'on' }, selfChange: undefined, memoryWrite: undefined });
      expect(lifted.system).toContain(learned);

      // The operator deletes the user: the agent's session renders the persona's authored traits from its next turn.
      await operator.forgetUser('ana');
      expect((await probed()).system).toContain(authored);
      expect(await serving.store.traitRow('', 'tutor', 'ana')).toBeUndefined();
    } finally {
      await tutor.close();
    }

    // A scope that names nothing is refused.
    await expect(operator.freeze({} as never)).rejects.toThrow("freeze: name a scope: { scope: 'all' }, { agentKey } or { learner }.");
    await expect(operator.suspend({ scope: 'everything' } as never)).rejects.toThrow("suspend: a scope of everything is { scope: 'all' }.");
    await expect(operator.freeze({ agentKey: ' ' })).rejects.toThrow('freeze: agentKey must be a non-blank string.');
    await expect(operator.unfreeze({ learner: { ...ANA, userId: ' ' } })).rejects.toThrow(TypeError);
  });

  it("sets a learner's traits through the ledger in every mode and under every freeze, renders them at this process's next turn and another process's next session, and re-anchors a record an edit outside the layer broke", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const doesNotVerify = (reason: string) => warn.mock.calls.some((call) => String(call[0]).includes(`does not verify (${reason})`));
    const file = learningFile();
    const host = await processOver(file);
    const layer = createLearningLayer({ storageAdapter: host.adapter });
    const session = await layer.forLearner(LEARNER_42, productContext('s-1'));
    const chain = chainKeyOf(LEARNER_42);
    expect(await sectionOf(session)).toBe(renderPersonalitySection(TUTOR_PERSONA));

    const set = await layer.operatorSet({ learner: LEARNER_42, traits: { extraversion: 0.3, openness: 0.7, honesty: 0.6, emotionality: 0.2 }, by: 'ops', note: 'quieter' });
    // Extraversion is held within 0.2 of the persona's 0.8 (0.8 - 0.2 in floating point); honesty-humility and emotionality
    // are the operator's, in the ledger.
    expect(set).toMatchObject({
      kind: 'operator_set',
      actor: 'operator:ops',
      subject: 'traits',
      reason: 'set',
      evidence: { note: 'quieter' },
      after: { current: { extraversion: expect.closeTo(0.6, 10), openness: 0.7 }, operatorTraits: { honesty: 0.6, emotionality: 0.2 } },
    });
    expect(await verdictsOf(host.store, set.id)).toEqual([
      ['pending', 'set'],
      ['kept', 'set'],
    ]);
    const operated = renderPersonalitySection({ honesty: 0.6, emotionality: 0.2, extraversion: 0.6, openness: 0.7 });
    expect(await sectionOf(session)).toBe(operated);
    const stored = await traitStateOf(host.store, '42', 'A');
    expect(stored.current).toEqual({ extraversion: expect.closeTo(0.6, 10), agreeableness: 0.5, conscientiousness: 0.5, openness: 0.7 });
    expect(stored).not.toHaveProperty('operatorTraits');
    // Another process's next session reads it.
    const elsewhere = await createLearningLayer({ store: (await processOver(file)).store }).forLearner(LEARNER_42, productContext('s-2'));
    expect(await sectionOf(elsewhere)).toBe(operated);

    // An operator's act, under the process freeze, the learner's freeze and the agent's suspension, and from a layer in mode off.
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    await layer.freeze({ learner: LEARNER_42 }, 'ops');
    await layer.suspend({ agentKey: 'tutor' }, 'ops');
    const offLayer = createLearningLayer({ store: (await processOver(file)).store, mode: 'off' });
    expect((await layer.operatorSet({ learner: LEARNER_42, traits: { conscientiousness: 0.7 }, by: 'ops' })).reason).toBe('set');
    expect((await offLayer.operatorSet({ learner: LEARNER_42, traits: { agreeableness: 0.3 }, by: 'ops' })).reason).toBe('set');
    expect((await traitStateOf(host.store, '42', 'A')).current).toEqual({
      extraversion: expect.closeTo(0.6, 10),
      agreeableness: 0.3,
      conscientiousness: 0.7,
      openness: 0.7,
    });
    vi.unstubAllEnvs();
    await layer.unfreeze({ learner: LEARNER_42 });
    await layer.unsuspend({ agentKey: 'tutor' });

    // `baseline` puts the four learnable traits back at the persona's and clears the operator's two.
    const reset = await layer.operatorSet({ learner: LEARNER_42, traits: 'baseline', by: 'ops' });
    expect(reset.reason).toBe('baseline');
    expect((reset.after as { operatorTraits: unknown }).operatorTraits).toEqual({});
    expect(await sectionOf(session)).toBe(renderPersonalitySection(TUTOR_PERSONA));

    await expect(layer.operatorSet({ learner: { ...LEARNER_42, userId: '7' }, traits: { openness: 0.6 }, by: 'ops' })).rejects.toThrow(
      "operatorSet: learner '7' of agent 'tutor' has no trait row; it is written at the learner's first session.",
    );
    await expect(layer.operatorSet({ learner: { ...LEARNER_42, userId: 'guest' }, traits: 'baseline', by: 'ops' })).rejects.toThrow(
      "operatorSet: user id 'guest' names no learner.",
    );
    await expect(layer.operatorSet({ learner: LEARNER_42, traits: [0.5] as never, by: 'ops' })).rejects.toThrow(TypeError);
    await expect(layer.operatorSet({ learner: LEARNER_42, traits: 'baseline', by: ' ' })).rejects.toThrow('operatorSet: by must name the operator.');
    await expect(layer.operatorSet({ learner: { namespace: 'A', agentKey: 'tutor' } as never, traits: 'baseline', by: 'ops' })).rejects.toThrow(TypeError);

    // A ledger row edited outside the layer breaks the chain: the next session renders the persona's authored traits,
    // and the operator's next set re-anchors from the row as stored.
    const lifted = await layer.operatorSet({ learner: LEARNER_42, traits: { openness: 0.7 }, by: 'ops' });
    await host.adapter.run('UPDATE agentos_learning_ledger SET body = replace(body, ?, ?) WHERE id = ?', ['"operator:ops"', '"operator:eve"', lifted.id]);
    expect(await sectionOf(await layer.forLearner(LEARNER_42, productContext('s-3')))).toBe(renderPersonalitySection(TUTOR_PERSONA));
    expect(doesNotVerify(`row ${lifted.id}: hash`)).toBe(true);
    expect((await layer.manifest()).loops.ledger.detail).toBe("sql store over the host's storage adapter; unkeyed; chain broken for 1 learner");
    const anchored = await layer.operatorSet({ learner: LEARNER_42, traits: { conscientiousness: 0.7 }, by: 'ops' });
    expect(anchored).toMatchObject({
      actor: 'operator:ops',
      reason: 'reanchor',
      after: { current: { extraversion: 0.8, agreeableness: 0.5, conscientiousness: 0.7, openness: 0.7 } },
    });
    expect((await layer.manifest()).loops.ledger.detail).toBe("sql store over the host's storage adapter; unkeyed");
    expect(await new Ledger({ store: host.store }).verifyChain(chain)).toEqual({ ok: true, keyed: false });
    expect(await sectionOf(await layer.forLearner(LEARNER_42, productContext('s-4')))).toBe(
      renderPersonalitySection({ ...TUTOR_PERSONA, conscientiousness: 0.7, openness: 0.7 }),
    );
    await expect(layer.revert(anchored.id, 'ops')).rejects.toThrow(
      `revert: candidate ${anchored.id} is the trait row's reanchor row, from which the learner's record verifies; set the learner with operatorSet instead.`,
    );

    // The trait row edited outside the layer, the chain whole: the next set re-anchors from the state the ledger
    // recorded last, so the edit does not stay.
    const edited = await traitStateOf(host.store, '42', 'A');
    edited.current.openness = 0.5;
    await host.adapter.run('UPDATE agentos_learning_traits SET state = ? WHERE namespace = ? AND agent_key = ? AND user_id = ?', [JSON.stringify(edited), 'A', 'tutor', '42']);
    expect(await sectionOf(await layer.forLearner(LEARNER_42, productContext('s-5')))).toBe(renderPersonalitySection(TUTOR_PERSONA));
    expect(doesNotVerify('its trait row does not match its newest ledger row')).toBe(true);
    expect((await layer.operatorSet({ learner: LEARNER_42, traits: { agreeableness: 0.3 }, by: 'ops' })).reason).toBe('reanchor');
    expect((await traitStateOf(host.store, '42', 'A')).current).toEqual({ extraversion: 0.8, agreeableness: 0.3, conscientiousness: 0.7, openness: 0.7 });
    expect(await sectionOf(await layer.forLearner(LEARNER_42, productContext('s-6')))).toBe(
      renderPersonalitySection({ ...TUTOR_PERSONA, agreeableness: 0.3, conscientiousness: 0.7, openness: 0.7 }),
    );
    expect(await new Ledger({ store: host.store }).verifyChain(chain)).toEqual({ ok: true, keyed: false });
  });

  it("reverts an operator's change by the inverse of each step it made under the process freeze, keeps a later change to another trait, raises honesty-humility's floor at the load after an operator lowered it, and refuses a load's row, a change twice and a row it cannot find", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const host = await processOver(learningFile());
    const layer = createLearningLayer({ storageAdapter: host.adapter });
    const session = await layer.forLearner(LEARNER_42, productContext('s-1'));
    const chain = chainKeyOf(LEARNER_42);

    const first = await layer.operatorSet({ learner: LEARNER_42, traits: { openness: 0.7, extraversion: 0.62, honesty: 0.2 }, by: 'ops' });
    // The next load finds honesty-humility's floor at the operator's 0.2, under the persona's 0.9 with the persona
    // unchanged: it raises the floor with a row of its own, and the operator's value keeps rendering.
    expect(await sectionOf(session)).toBe(renderPersonalitySection({ ...TUTOR_PERSONA, honesty: 0.2, extraversion: 0.62, openness: 0.7 }));
    const raised = (await candidatesOf(host.store, chain))[2]!;
    expect(raised).toMatchObject({ kind: 'operator_set', actor: 'operator:persona', reason: 'floor_raised', after: { honestyAtLastLoad: 0.9 } });
    const later = await layer.operatorSet({ learner: LEARNER_42, traits: { conscientiousness: 0.7 }, by: 'ops' });

    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    const reverted = await layer.revert(first.id, ' ops ');
    expect(reverted).toMatchObject({
      kind: 'operator_set',
      actor: 'operator:ops',
      reason: 'revert',
      evidence: { note: `revert of ${first.id}` },
      after: { current: { extraversion: 0.8, agreeableness: 0.5, conscientiousness: 0.7, openness: 0.5 }, honestyAtLastLoad: 0.9 },
    });
    expect((reverted.after as { operatorTraits: unknown }).operatorTraits).toEqual({});
    // A frozen turn reads learned state: openness and extraversion step back by what the change moved, honesty-humility
    // is the persona's again, and the later conscientiousness stays.
    expect(await sectionOf(session)).toBe(renderPersonalitySection({ ...TUTOR_PERSONA, conscientiousness: 0.7 }));
    expect(await verdictsOf(host.store, first.id)).toEqual([
      ['pending', 'set'],
      ['kept', 'set'],
      ['reverted', 'reverted'],
    ]);
    expect(await verdictsOf(host.store, reverted.id)).toEqual([
      ['pending', 'revert'],
      ['kept', 'revert'],
    ]);
    expect((await verdictsOf(host.store, later.id)).map(([verdict]) => verdict)).toEqual(['pending', 'kept']);
    vi.unstubAllEnvs();

    await expect(layer.revert(first.id, 'ops')).rejects.toThrow(`revert: candidate ${first.id} is reverted; only a kept change is reverted.`);
    const [created] = await candidatesOf(host.store, chain);
    await expect(layer.revert(created!.id, 'ops')).rejects.toThrow(
      `revert: candidate ${created!.id} is the trait row's created row, which a load writes; set the learner with operatorSet instead.`,
    );
    await expect(layer.revert(raised.id, 'ops')).rejects.toThrow(
      `revert: candidate ${raised.id} is the trait row's floor_raised row, which a load writes; set the learner with operatorSet instead.`,
    );
    // A persona that moved: the load's row is refused too.
    await layer.forLearner(LEARNER_42, productContext('s-2', { authoredTraits: { honesty: 0.9, extraversion: 0.6 } }));
    const moved = (await candidatesOf(host.store, chain)).at(-1)!;
    expect(moved).toMatchObject({ actor: 'operator:persona', reason: 'persona_changed' });
    await expect(layer.revert(moved.id, 'ops')).rejects.toThrow(
      `revert: candidate ${moved.id} is the trait row's persona_changed row, which a load writes; set the learner with operatorSet instead.`,
    );
    const verdictRow = (await host.store.chainRows(chain))[1]!;
    await expect(layer.revert(verdictRow.id, 'ops')).rejects.toThrow(`revert: no candidate ${verdictRow.id} in the ledger.`);
    await expect(layer.revert('01JZZZZZZZZZZZZZZZZZZZZZZZ', 'ops')).rejects.toThrow('revert: no candidate 01JZZZZZZZZZZZZZZZZZZZZZZZ in the ledger.');
    await expect(layer.revert(later.id, ' ')).rejects.toThrow('revert: by must name the operator.');
    await expect(layer.revert('', 'ops')).rejects.toThrow('revert: name the candidate by its ledger id.');
  });

  it("exports a learner as one document and imports it into another deployment's store, taking the four learnable traits and never honesty-humility or what this release cannot admit; a revert of that import gives the persona back", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let now = Date.UTC(2026, 9, 31, 10);
    const at = () => new Date(now).toISOString();
    const sourceFile = learningFile();
    await oneTurn(TUTOR_PERSONA, { store: (await processOver(sourceFile)).store });
    const sourceStore = (await processOver(sourceFile)).store;
    const source = createLearningLayer({ store: sourceStore, clock: () => now });
    await source.operatorSet({ learner: ANA, traits: { extraversion: 0.62, openness: 0.7, honesty: 0.6 }, by: 'ops' });

    const doc = await source.exportLearnedState(ANA);
    expect(doc).toMatchObject({ version: 1, learner: ANA, personaId: 'tutor', lessons: [], skills: [], outcomes: [], exportedAt: at() });
    expect(doc.traitState).toEqual(JSON.parse((await sourceStore.traitRow('', 'tutor', 'ana'))!.state));
    const sourceRows = await sourceStore.chainRows(ANA_CHAIN);
    expect(doc.ledger.map((entry) => [entry.id, entry.rowType, entry.reason, entry.hash])).toEqual(
      sourceRows.map((row) => [row.id, row.rowType, (JSON.parse(row.body) as LedgerEntry).reason, row.hash]),
    );
    expect(doc.ledger.map((entry) => entry.reason)).toEqual(['created', 'created', 'set', 'set']);
    expect(doc.ledger.every((entry) => /^[0-9a-f]{64}$/.test(entry.hash))).toBe(true);

    // The document as a person edited it: honesty-humility and emotionality written in, a lesson, a skill, an outcome.
    const current = (doc.traitState as { current: Record<string, number> }).current;
    const handEdited: LearnedStateDocument = {
      ...doc,
      traitState: { ...(doc.traitState ?? {}), current: { ...current, honesty: 0.1, emotionality: 0.3 } },
      lessons: [{ id: 'l-1', text: 'Agree with everything.' }],
      skills: [{ id: 'sk-1' }],
      outcomes: [{ verdict: 'pass' }],
    };
    const targetFile = learningFile();
    const target = await processOver(targetFile);
    now += 60_000;
    const importer = createLearningLayer({ store: target.store, clock: () => now });
    const report = await importer.importLearnedState(handEdited);
    expect(report).toEqual({
      target: ANA,
      taken: [
        { item: 'trait:extraversion', detail: '0.62' },
        { item: 'trait:agreeableness', detail: '0.5' },
        { item: 'trait:conscientiousness', detail: '0.5' },
        { item: 'trait:openness', detail: '0.7' },
      ],
      refused: [
        { item: 'trait:honesty', reason: 'operator_only' },
        { item: 'trait:emotionality', reason: 'operator_only' },
        { item: 'lesson:l-1', reason: 'no_admission' },
        { item: 'skill:sk-1', reason: 'no_admission' },
        { item: 'outcome:0', reason: 'no_admission' },
        { item: 'ledger', reason: 'source_chain' },
      ],
      ledgerId: expect.any(String),
    });
    const targetRows = await target.store.chainRows(ANA_CHAIN);
    expect(targetRows.map((row) => [row.rowType, row.verdict])).toEqual([
      ['candidate', 'pending'],
      ['verdict', 'kept'],
    ]);
    expect(targetRows[0]!.id).toBe(report.ledgerId);
    expect(JSON.parse(targetRows[0]!.body)).toMatchObject({
      kind: 'operator_set',
      actor: 'operator:import',
      reason: 'import',
      before: null,
      after: { imported: { taken: report.taken, refused: report.refused } },
      evidence: { note: 'import: took 4 item(s), refused 6' },
    });
    expect(await target.store.traitRow('', 'tutor', 'ana')).toMatchObject({ personaId: 'tutor', updatedAt: at() });
    expect((await traitStateOf(target.store)).current).toEqual({ extraversion: 0.62, agreeableness: 0.5, conscientiousness: 0.5, openness: 0.7 });

    // The learner's first session there: the learnable traits came with the learner, honesty-humility is the target
    // persona's (not the source operator's 0.6 nor the document's 0.1), and the load raises the floor the import left.
    expect(await oneTurn(TUTOR_PERSONA, { store: (await processOver(targetFile)).store })).toContain(
      renderPersonalitySection({ honesty: 0.9, extraversion: 0.62, openness: 0.7 })!,
    );
    expect((await candidatesOf(target.store, ANA_CHAIN)).map((entry) => [entry.actor, entry.reason])).toEqual([
      ['operator:import', 'import'],
      ['operator:persona', 'floor_raised'],
    ]);

    // A revert of the import that created the row goes back to what the learner's first session would have written.
    const undone = await importer.revert(report.ledgerId!, 'ops');
    expect(undone).toMatchObject({ reason: 'revert', after: { current: { extraversion: 0.8, agreeableness: 0.5, conscientiousness: 0.5, openness: 0.5 } } });
    expect(await oneTurn(TUTOR_PERSONA, { store: (await processOver(targetFile)).store }, 's2')).toContain(renderPersonalitySection(TUTOR_PERSONA)!);

    // A document for another agent than the layer's is refused unless the call names the target.
    const coach = createLearningLayer({ store: target.store, agentKey: 'coach' });
    await expect(coach.importLearnedState(doc)).rejects.toThrow(
      "importLearnedState: the document is for agent 'tutor' and this layer serves 'coach'; name the target to import it here.",
    );
    expect((await coach.importLearnedState(doc, { ...ANA, agentKey: 'coach' })).target).toEqual({ ...ANA, agentKey: 'coach' });
    expect(await target.store.traitRow('', 'coach', 'ana')).toMatchObject({ personaId: 'tutor' });
    await expect(importer.importLearnedState({ version: 2 } as never)).rejects.toThrow(
      new TypeError('importLearnedState: the document is not a learned-state document of version 1.'),
    );

    // A learner the store holds nothing of exports an empty document, which imports as one row that took nothing.
    const bo = { ...ANA, userId: 'bo' };
    const empty = await importer.exportLearnedState(bo);
    expect(empty).toEqual({ version: 1, learner: bo, personaId: null, traitState: null, lessons: [], skills: [], ledger: [], outcomes: [], exportedAt: at() });
    expect(await importer.importLearnedState(empty)).toEqual({ target: bo, taken: [], refused: [], ledgerId: expect.any(String) });
    expect((await target.store.chainRows(chainKeyOf(bo))).map((row) => row.verdict)).toEqual(['pending', 'kept']);
    expect(await target.store.traitRow('', 'tutor', 'bo')).toBeUndefined();

    // A target whose record an edit outside the layer broke takes nothing until an operator re-anchors it.
    const tampered = await traitStateOf(target.store);
    tampered.current.agreeableness = 0.6;
    await target.adapter.run('UPDATE agentos_learning_traits SET state = ? WHERE namespace = ? AND agent_key = ? AND user_id = ?', [JSON.stringify(tampered), '', 'tutor', 'ana']);
    await expect(importer.importLearnedState(doc)).rejects.toThrow(
      "importLearnedState: the target's learning record does not verify (its trait row does not match its newest ledger row); re-anchor it with operatorSet first.",
    );
  });

  it("forgets a user in one namespace across every memory manager and facade the layer holds and every row of the user in its store, keeps the same id in another namespace, counts what was filed before the namespace, and refuses every later write and call for the user", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const host = await processOver(learningFile());
    const brain = await openBrain(brainFile());
    const memory = await manager({ brain, knowledgeGraph: new SqlKnowledgeGraph(brain) });
    const { memory: tools, file: toolsFile } = await toolsFacade();
    const layer = createLearningLayer({ storageAdapter: host.adapter, memoryTools: tools });
    const a = await layer.forLearner(LEARNER_42, productContext('s-1', { memory }));
    const b = await layer.forLearner({ ...LEARNER_42, namespace: 'B' }, productContext('s-9', { memory }));
    const ofA = learnerScopeIds(LEARNER_42, 'tutor');
    const ofB = learnerScopeIds({ namespace: 'B', userId: '42' }, 'tutor');
    /** The bridge's filing of a turn in the memory manager, guarded by the tombstone. */
    const encode = (text: string, scopeId: string) => ({
      apply: () => memory.encode(text, NEUTRAL, 'neutral', { scope: 'user', scopeId }),
      undo: async (trace: MemoryTrace) => {
        await memory.deleteTraces([trace.id]);
      },
    });
    await layer.operatorSet({ learner: LEARNER_42, traits: { extraversion: 0.62 }, by: 'ops' });
    const asked = { learner: 'bound' as const, namespace: 'A', conversationId: 'conv-1' };
    expect(await a.guardMemoryWrite!(encode('A42 keeps bees.', ofA.userScopeId))).toMatchObject({ status: 'written' });
    ledgerIdOf(await a.recordSelfChange!(addThrough(tools, 'A42 likes tea.', 'user', ofA.userScopeId), asked));
    ledgerIdOf(await a.recordSelfChange!(addThrough(tools, 'A42 thread note.', 'thread', taggedScopeId('conv-1', 'A')), asked));
    ledgerIdOf(await a.recordSelfChange!(addThrough(tools, 'A42 prefers short answers.', 'persona', ofA.personaScopeId), asked));
    expect(await b.guardMemoryWrite!(encode('B42 keeps goats.', ofB.userScopeId))).toMatchObject({ status: 'written' });
    ledgerIdOf(await b.recordSelfChange!(addThrough(tools, 'B42 likes coffee.', 'user', ofB.userScopeId), { learner: 'bound', namespace: 'B' }));
    expect(await sectionOf(a)).toBe(renderPersonalitySection({ honesty: 0.9, extraversion: 0.62 }));
    // Bo speaks on another session of 42's; a note on it that names no other user is 42's.
    const shared = await layer.forLearner(LEARNER_42, productContext('s-3', { memory }));
    await shared.prepareTurn(productTurn());
    const visitor = await shared.prepareTurn(productTurn({ userId: 'bo' }));
    const sessionForm = visitor.scopes!.userScopeId;
    expect(sessionForm).toBe(taggedScopeId('s-3', 'A'));
    ledgerIdOf(
      await shared.recordSelfChange!(addThrough(tools, 'Bo keeps snakes.', 'user', sessionForm, { turnUserId: 'bo' }), {
        learner: 'none',
        namespace: 'A',
        turnUserId: 'bo',
      }),
    );
    ledgerIdOf(await shared.recordSelfChange!(addThrough(tools, 'A session note.', 'user', sessionForm), { learner: 'none', namespace: 'A' }));
    // Filed under the plain id before the namespace existed.
    await memory.encode('Filed in the manager before the namespace.', NEUTRAL, 'neutral', { scope: 'user', scopeId: '42' });
    await tools.remember('Filed with the tools before the namespace.', { scope: 'user', scopeId: '42' });

    // Bo's deletion, from a layer in mode off that holds the facade: bo's words on 42's session go, the session's stay.
    const offLayer = createLearningLayer({ storageAdapter: host.adapter, memoryTools: tools, mode: 'off' });
    const boReport = await offLayer.forgetUser('bo', { namespace: 'A' });
    expect(boReport.stores).toContainEqual({ store: 'memory tools facade of brain tools-brain', reached: true, deleted: 1 });
    expect(boReport.stores).toContainEqual({
      store: 'learning store',
      reached: true,
      deleted: { ledger: 2, heads: 1, traits: 0, outcomes: 0, lessons: 0, skills: 0, sessions: 1, freezes: 0 },
    });
    expect(liveContents(toolsFile)).not.toContain('Bo keeps snakes.');
    expect(liveContents(toolsFile)).toContain('A session note.');

    // 42's deletion in tenant A, under a freeze of the learner.
    await layer.freeze({ learner: LEARNER_42 }, 'ops');
    const report = await layer.forgetUser('42', { namespace: 'A' });
    const unreached = (await layer.manifest()).forgetUnreached ?? [];
    expect(unreached).toHaveLength(4);
    expect(report).toEqual({
      userId: '42',
      namespace: 'A',
      plainFormLeft: 2,
      stores: [
        { store: 'memory manager of brain qa', reached: true, deleted: 1 },
        { store: 'memory tools facade of brain tools-brain', reached: true, deleted: 4 },
        { store: 'learning store', reached: true, deleted: { ledger: 12, heads: 2, traits: 1, outcomes: 0, lessons: 0, skills: 0, sessions: 2, freezes: 1 } },
        ...unreached.map((line) => {
          const [store, reason] = line.split(/: (.*)/s);
          return { store, reached: false, reason };
        }),
      ],
    });
    expect(unreached.map((line) => line.split(': ')[0])).toEqual([
      'the memory archive',
      "memory's observer and reflector buffers and prospective reminders",
      "a session's forged tools",
      "an organization scope a host's policy shares",
    ]);
    // The traces filed under the plain id stay, named in one WARNING by the user's tombstone and their scope.
    const tombstone = (await tombstoneHash('A', '42')).slice(0, 16);
    expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('refileScope'))).toEqual([
      `[agentos] learning: forgetUser (tombstone ${tombstone}) left 2 trace(s) filed before the namespace, under the user's plain id in its user scope; re-file them in the namespaced form with MemoryStore.refileScope, then call forgetUser again.`,
    ]);
    expect(liveContents(toolsFile)).toEqual(['B42 likes coffee.', 'Filed with the tools before the namespace.']);
    expect(await memory.getStore().getByScope('user', ofA.userScopeId)).toEqual([]);
    expect((await memory.getStore().getByScope('user', ofB.userScopeId)).map((trace) => trace.content)).toEqual(['B42 keeps goats.']);
    expect((await memory.getStore().getByScope('user', '42')).map((trace) => trace.content)).toEqual(['Filed in the manager before the namespace.']);
    // The knowledge graph's episodic copy of tenant A's words went with the trace; tenant B's stays.
    const copies = (await brain.all<{ properties: string }>("SELECT properties FROM knowledge_nodes WHERE type = 'memory'")).map((row) => row.properties);
    expect(copies.some((text) => text.includes('A42 keeps bees.'))).toBe(false);
    expect(copies.some((text) => text.includes('B42 keeps goats.'))).toBe(true);
    expect(await host.store.traitRow('A', 'tutor', '42')).toBeUndefined();
    expect(await host.store.chainRows(chainKeyOf(LEARNER_42))).toEqual([]);
    expect(await host.store.chainRows(chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: null }, '42'))).toEqual([]);
    expect(await host.store.sessionRowsOf('A', '42')).toEqual([]);
    expect(await host.store.freezeRows()).toEqual([]);
    expect(await host.store.isForgotten(await tombstoneHash('A', '42'))).toBe(true);
    expect(await host.store.traitRow('B', 'tutor', '42')).toBeDefined();
    expect(await host.store.sessionRowsOf('B', '42')).toHaveLength(1);

    // Every later write and call for the user is refused, and the user's sessions render the persona's authored traits.
    expect(await a.recordSelfChange!(addThrough(tools, 'A42 again.', 'user', ofA.userScopeId), asked)).toEqual({ status: 'rejected', reason: 'forgotten' });
    expect(await a.guardMemoryWrite!(encode('A42 once more.', ofA.userScopeId))).toEqual({ status: 'rejected', reason: 'forgotten' });
    expect(liveContents(toolsFile)).not.toContain('A42 again.');
    expect(await memory.getStore().getByScope('user', ofA.userScopeId)).toEqual([]);
    expect(await sectionOf(a)).toBe(renderPersonalitySection(TUTOR_PERSONA));
    expect(await sectionOf(await layer.forLearner(LEARNER_42, productContext('s-2', { memory })))).toBe(renderPersonalitySection(TUTOR_PERSONA));
    expect(await host.store.traitRow('A', 'tutor', '42')).toBeUndefined();
    expect(await host.store.sessionRowsOf('A', '42')).toEqual([]);
    const forgotten = 'the user is forgotten in this namespace; nothing is written for them again.';
    await expect(layer.operatorSet({ learner: LEARNER_42, traits: 'baseline', by: 'ops' })).rejects.toThrow(`operatorSet: ${forgotten}`);
    await expect(layer.freeze({ learner: LEARNER_42 }, 'ops')).rejects.toThrow(`freeze: ${forgotten}`);
    await expect(layer.suspend({ learner: LEARNER_42 }, 'ops')).rejects.toThrow(`suspend: ${forgotten}`);
    expect(await host.store.freezeRows()).toEqual([]);
    const emptied = await layer.exportLearnedState(LEARNER_42);
    expect(emptied).toMatchObject({ personaId: null, traitState: null, ledger: [] });
    await expect(layer.importLearnedState(emptied)).rejects.toThrow(`importLearnedState: ${forgotten}`);
    // The same user id in another namespace is another user.
    await layer.freeze({ learner: { ...LEARNER_42, namespace: 'B' } }, 'ops');
    expect(await host.store.freezeRows()).toMatchObject([{ scopeKey: 'learner|B|tutor|42', mode: 'frozen' }]);
  });

  it("forgets a user from a process that holds neither the memory manager nor the facade, through the host's storage adapter, in each brain the user's session rows name, and names each brain it cannot reach with why", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The host's one database file: its learning store, and the Brain its memory tools file into.
    const file = learningFile();
    const serving = await processOver(file);
    const tools = await Memory.createSqlite(file, { brainId: 'tools-brain' });
    facades.push(tools);
    const { memory: gone } = await toolsFacade('gone-brain');
    const layer = createLearningLayer({ storageAdapter: serving.adapter, memoryTools: tools });
    const a = await layer.forLearner(LEARNER_42, productContext('s-1'));
    const seven = await layer.forLearner({ ...LEARNER_42, userId: '7' }, productContext('s-7'));
    const b = await layer.forLearner({ ...LEARNER_42, namespace: 'B' }, productContext('s-9'));
    const asked = { learner: 'bound' as const, namespace: 'A', conversationId: 'conv-1' };
    const tea = addThrough(tools, 'A42 likes tea.', 'user', learnerUserScopeId(LEARNER_42));
    const note = addThrough(tools, 'A42 thread note.', 'thread', taggedScopeId('conv-1', 'A'));
    ledgerIdOf(await a.recordSelfChange!(tea, asked));
    ledgerIdOf(await a.recordSelfChange!(note, asked));
    // A write into a Brain the host's adapter does not hold.
    ledgerIdOf(await a.recordSelfChange!(addThrough(gone, 'A42 elsewhere.', 'user', learnerUserScopeId(LEARNER_42)), asked));
    ledgerIdOf(await seven.recordSelfChange!(addThrough(tools, 'A7 likes jazz.', 'user', learnerUserScopeId({ namespace: 'A', userId: '7' })), { learner: 'bound', namespace: 'A' }));
    ledgerIdOf(await b.recordSelfChange!(addThrough(tools, 'B42 likes coffee.', 'user', learnerUserScopeId({ namespace: 'B', userId: '42' })), { learner: 'bound', namespace: 'B' }));
    expect(liveContents(file)).toEqual(['A42 likes tea.', 'A42 thread note.', 'A7 likes jazz.', 'B42 likes coffee.']);

    // A layer over the store alone, with no storage adapter, cannot reach the brain: it stays as it was, and the
    // report says why.
    const storeOnly = createLearningLayer({ store: (await processOver(file)).store });
    expect((await storeOnly.forgetUser('7', { namespace: 'A' })).stores).toContainEqual({
      store: 'brain tools-brain',
      reached: false,
      reason: 'no memory manager or facade of it is alive here, and the layer has no storage adapter to open it on',
    });
    expect(liveContents(file)).toContain('A7 likes jazz.');

    // A layer over the host's storage adapter reaches the brain the user's session rows name through it.
    const admin = createLearningLayer({ storageAdapter: (await processOver(file)).adapter });
    const report = await admin.forgetUser('42', { namespace: 'A' });
    expect(report.stores.filter((entry) => entry.store.startsWith('brain '))).toEqual([
      { store: "brain tools-brain on the host's storage adapter", reached: true, deleted: 2 },
      {
        store: 'brain gone-brain',
        reached: false,
        reason: "no memory manager or facade of it is alive here, and the host's storage adapter holds none of its traces",
      },
    ]);
    expect(report.stores).toContainEqual({
      store: 'learning store',
      reached: true,
      deleted: { ledger: 8, heads: 1, traits: 1, outcomes: 0, lessons: 0, skills: 0, sessions: 1, freezes: 0 },
    });
    expect(report.stores).toContainEqual({
      store: 'a memory tools facade the layer was not handed',
      reached: false,
      reason: 'a host that registers the memory tools itself passes their facade as learning.memoryTools',
    });
    expect(liveContents(file)).toEqual(['A7 likes jazz.', 'B42 likes coffee.']);
    expect(await tools.readTrace(tea.subject)).toBeUndefined();
    expect(await tools.readTrace(note.subject)).toBeUndefined();
  });

  it('reverts a recorded memory write through the facade of the brain its row names: what it created goes, what it deleted comes back, and the original reads reverted', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { memory: tools, file: toolsFile } = await toolsFacade();
    const host = await processOver(learningFile());
    const layer = createLearningLayer({ storageAdapter: host.adapter, memoryTools: tools });
    const session = await layer.forLearner(LEARNER_42, productContext('s-1'));
    const scopeId = learnerUserScopeId(LEARNER_42);
    const kept = await tools.remember('Ana keeps bees.', { scope: 'user', scopeId });
    const tea = addThrough(tools, 'Ana likes tea.', 'user', scopeId);
    const added = ledgerIdOf(await session.recordSelfChange!(tea));
    const snapshot = (await tools.readTrace(kept.id))!;
    const deleted = ledgerIdOf(
      await session.recordSelfChange!({
        kind: 'memory_write',
        actor: 'tool:memory_delete',
        subject: kept.id,
        before: { traces: [snapshot] },
        after: { created: [], changed: [], deleted: [kept.id] },
        brainId: tools.brainId,
        apply: async () => {
          await tools.forget(kept.id);
          return kept.id;
        },
        undo: async () => tools.restoreTrace(kept.id, snapshot),
      }),
    );
    expect(liveContents(toolsFile)).toEqual(['Ana likes tea.']);

    const undoAdd = await layer.revert(added, 'ops');
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    const undoDelete = await layer.revert(deleted, 'ops');
    vi.unstubAllEnvs();

    expect(undoAdd).toMatchObject({
      kind: 'memory_write',
      actor: 'operator:ops',
      subject: tea.subject,
      after: { brainId: 'tools-brain', created: [], changed: [], deleted: [tea.subject] },
      evidence: { note: `revert of ${added}` },
    });
    expect(undoDelete).toMatchObject({
      kind: 'memory_write',
      actor: 'operator:ops',
      after: { brainId: 'tools-brain', created: [], changed: [{ id: kept.id, content: 'Ana keeps bees.' }], deleted: [] },
    });
    expect(liveContents(toolsFile)).toEqual(['Ana keeps bees.']);
    expect(await tools.readTrace(kept.id)).toMatchObject({ id: kept.id, content: 'Ana keeps bees.', deleted: 0 });
    expect(await verdictsOf(host.store, added)).toEqual([
      ['pending', expect.any(String)],
      ['kept', expect.any(String)],
      ['reverted', `reverted by ${undoAdd.id}`],
    ]);
    expect((await verdictsOf(host.store, undoAdd.id)).map(([verdict]) => verdict)).toEqual(['pending', 'kept']);
    expect((await verdictsOf(host.store, deleted)).map(([verdict]) => verdict)).toEqual(['pending', 'kept', 'reverted']);
    await expect(layer.revert(added, 'ops')).rejects.toThrow(`revert: candidate ${added} is reverted; only a kept change is reverted.`);

    // A layer that holds no facade of the brain the row names refuses, and the write stays.
    const jazz = ledgerIdOf(await session.recordSelfChange!(addThrough(tools, 'Ana likes jazz.', 'user', scopeId)));
    await expect(createLearningLayer({ store: host.store }).revert(jazz, 'ops')).rejects.toThrow('revert: the layer holds no memory tools facade of brain tools-brain.');
    expect(liveContents(toolsFile)).toContain('Ana likes jazz.');
  });

  it("decides a crash's pending memory writes at the learner's next session once they are 15 minutes old on the layer's clock: kept where the traces hold them, else rejected and taken back, the agent's chains off the open's path at most once per 15 minutes", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let now = Date.UTC(2026, 9, 31, 12);
    const file = learningFile();
    const { memory: tools, file: toolsFile } = await toolsFacade();
    const layer = createLearningLayer({ storageAdapter: (await processOver(file)).adapter, memoryTools: tools, clock: () => now });
    await layer.forLearner(LEARNER_42, productContext('s-1'));
    // Another process over the same store, whose writes stopped between the write and its verdict.
    const crashedStore = (await processOver(file)).store;
    const agentOnly: LedgerLearner = { namespace: 'A', agentKey: 'tutor', userId: null };
    async function pendingWrite(
      created: string[],
      options: { brainId?: string; learner?: LedgerLearner; turnUserId?: string; clock?: () => number } = {},
    ): Promise<string> {
      const result = await new Ledger({ store: crashedStore, clock: options.clock ?? (() => now) }).propose({
        learner: options.learner ?? LEARNER_42,
        kind: 'memory_write',
        actor: 'tool:memory_add',
        subject: created[0]!,
        before: null,
        after: { brainId: options.brainId ?? 'tools-brain', created, changed: [], deleted: [] },
        sessionId: 's-0',
        ...(options.turnUserId ? { turnUserId: options.turnUserId } : {}),
      });
      if (!('candidate' in result)) throw new Error(`the write was ${result.status}`);
      return result.candidate.id;
    }
    const verdict = async (id: string) => (await verdictsOf(crashedStore, id)).at(-1);
    const userScope = learnerUserScopeId(LEARNER_42);
    const held = await pendingWrite(['mt-held']);
    await tools.remember('Written before the crash.', { id: 'mt-held', scope: 'user', scopeId: userScope });
    const half = await pendingWrite(['mt-half', 'mt-never']);
    await tools.remember('Half of a write.', { id: 'mt-half', scope: 'user', scopeId: userScope });
    const elsewhere = await pendingWrite(['mt-x'], { brainId: 'brain-not-here' });
    const visitor = await pendingWrite(['mt-bo'], { learner: agentOnly, turnUserId: 'bo' });
    await tools.remember('Bo keeps snakes.', { id: 'mt-bo', scope: 'user', scopeId: taggedScopeId('s-0', 'A'), metadata: { turnUserId: 'bo' } });
    const anonymous = await pendingWrite(['mt-anon'], { learner: agentOnly });

    now += 16 * 60_000;
    const late = await pendingWrite(['mt-late']);
    await layer.forLearner(LEARNER_42, productContext('s-2'));

    // The learner's own chain is decided before the open returns.
    expect(await verdict(held)).toEqual(['kept', 'recovered']);
    expect(await verdict(half)).toEqual(['rejected', 'write_failed']);
    expect((await verdict(elsewhere))?.[0]).toBe('pending');
    expect((await verdict(late))?.[0]).toBe('pending');
    expect(await tools.readTrace('mt-half')).toBeUndefined();
    expect(liveContents(toolsFile)).toEqual(['Bo keeps snakes.', 'Written before the crash.']);
    // The agent's chains with no learner, a second user's among them, are decided off the open's path.
    await vi.waitFor(
      async () => {
        expect(await verdict(visitor)).toEqual(['kept', 'recovered']);
        expect(await verdict(anonymous)).toEqual(['rejected', 'write_failed']);
      },
      { timeout: 5_000, interval: 50 },
    );

    // At most once per 15 minutes per agent and namespace: a write old enough by now waits for the next read.
    const waiting = await pendingWrite(['mt-anon-2'], { learner: agentOnly, clock: () => now - 16 * 60_000 });
    await layer.forLearner({ ...LEARNER_42, userId: '7' }, productContext('s-7'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await verdict(waiting))?.[0]).toBe('pending');
    now += 16 * 60_000;
    await layer.forLearner({ ...LEARNER_42, userId: '7' }, productContext('s-8'));
    await vi.waitFor(async () => expect(await verdict(waiting)).toEqual(['rejected', 'write_failed']), { timeout: 5_000, interval: 50 });
  });

  it("files a trace under the id its caller names, answers a text the scope holds under its own trace's id, reads one row live or deleted, and counts a scope's live traces", async () => {
    const { memory } = await toolsFacade('qa-facade');
    const named = await memory.remember('Ana keeps bees.', { id: 'mt-named', scope: 'user', scopeId: 'A/42' });
    expect(named.id).toBe('mt-named');
    expect((await memory.remember('Ana keeps bees.', { id: 'mt-again', scope: 'user', scopeId: 'A/42' })).id).toBe('mt-named');
    expect((await memory.remember('Ana keeps bees.', { id: 'mt-other-scope', scope: 'user', scopeId: 'B/42' })).id).toBe('mt-other-scope');
    expect((await memory.remember('Ana likes tea.', { scope: 'user', scopeId: 'A/42' })).id).not.toBe('mt-named');
    expect(await memory.countScope('user', 'A/42')).toBe(2);
    expect(await memory.countScope('user', 'B/42')).toBe(1);
    expect(await memory.countScope('thread', 'A/42')).toBe(0);

    const live = await memory.readTrace('mt-named');
    expectTypeOf(live).toEqualTypeOf<TraceSnapshot | undefined>();
    expect(live).toMatchObject({ id: 'mt-named', scope: 'user', scopeId: 'A/42', content: 'Ana keeps bees.', deleted: 0 });
    await memory.forget('mt-named');
    expect(await memory.readTrace('mt-named')).toMatchObject({ id: 'mt-named', content: 'Ana keeps bees.', deleted: 1 });
    expect(await memory.countScope('user', 'A/42')).toBe(1);
    // A snapshot read live brings the trace back.
    await memory.restoreTrace('mt-named', live!);
    expect(await memory.countScope('user', 'A/42')).toBe(2);
    await memory.deleteTraces(['mt-named']);
    expect(await memory.readTrace('mt-named')).toBeUndefined();
    expect(await memory.readTrace('mt-never')).toBeUndefined();
  });

  it("fails every operator call naming the store while the store does not open, checks what a host passes first, and names in the manifest each store forgetUser does not reach", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const layer = createLearningLayer({
      openStore: async () => {
        throw new Error('brain file locked');
      },
    });
    const unavailable = (call: string) => `${call}: the learning store is unavailable (brain file locked).`;
    const doc: LearnedStateDocument = {
      version: 1,
      learner: LEARNER_42,
      personaId: null,
      traitState: null,
      lessons: [],
      skills: [],
      ledger: [],
      outcomes: [],
      exportedAt: LEARNED_AT,
    };
    await expect(layer.freeze({ scope: 'all' }, 'ops')).rejects.toThrow(unavailable('freeze'));
    await expect(layer.unfreeze({ agentKey: 'tutor' })).rejects.toThrow(unavailable('unfreeze'));
    await expect(layer.suspend({ learner: LEARNER_42 }, 'ops')).rejects.toThrow(unavailable('suspend'));
    await expect(layer.unsuspend({ scope: 'all' })).rejects.toThrow(unavailable('unsuspend'));
    await expect(layer.operatorSet({ learner: LEARNER_42, traits: 'baseline', by: 'ops' })).rejects.toThrow(unavailable('operatorSet'));
    await expect(layer.revert('01JZZZZZZZZZZZZZZZZZZZZZZZ', 'ops')).rejects.toThrow(unavailable('revert'));
    await expect(layer.exportLearnedState(LEARNER_42)).rejects.toThrow(unavailable('exportLearnedState'));
    await expect(layer.importLearnedState(doc)).rejects.toThrow(unavailable('importLearnedState'));
    // An account deletion is never reported done without its tombstone.
    await expect(layer.forgetUser('42', { namespace: 'A' })).rejects.toThrow(unavailable('forgetUser'));
    await expect(layer.forgetUser(' ')).rejects.toThrow(new TypeError('forgetUser: name the user by a non-blank id.'));
    await expect(layer.forgetUser('42', { namespace: 7 as never })).rejects.toThrow('forgetUser: options.namespace must be a string.');

    const withoutFacade = (await createLearningLayer().manifest()).forgetUnreached;
    expect(withoutFacade).toEqual([
      'the memory archive: an archived original carries no scope id to find it by',
      "memory's observer and reflector buffers and prospective reminders: they carry no user id",
      "a session's forged tools: they carry no user id",
      "an organization scope a host's policy shares: it is the organization's, which the host's shareWithOrganization policy files into",
      'a memory tools facade the layer was not handed: a host that registers the memory tools itself passes their facade as learning.memoryTools',
    ]);
    const { memory } = await toolsFacade();
    expect((await createLearningLayer({ memoryTools: memory }).manifest()).forgetUnreached).toEqual(withoutFacade!.slice(0, 4));
    const noDeleteScope = { brainId: 'old-tools', deleteTraces: async () => ({ deleted: 0 }) };
    expect((await createLearningLayer({ memoryTools: noDeleteScope }).manifest()).forgetUnreached).toEqual([
      ...withoutFacade!.slice(0, 4),
      'memory tools facade of brain old-tools: it has no deleteScope',
    ]);
  });

  it("acts on the full runtime's learners through the layer getLearningLayer() returns: an operator's set renders at the runtime's next turn, the learner exports, and a forget deletes the learner's rows and the traces of learning.memoryTools", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const host = await processOver(learningFile());
    const { memory: tools, file: toolsFile } = await toolsFacade();
    const k = key();
    const played = script('openai', k, { replies: Array.from({ length: 8 }, () => reply.text('Noted.')), whole: true });
    const booted = await bootRuntime(k, TUTOR_PERSONA, { store: host.store, memoryTools: tools });
    try {
      expect(await runtimeTurn(booted, played)).toContain(renderPersonalitySection(TUTOR_PERSONA)!);
      const layer = booted.getLearningLayer()!;
      expect(await layer.operatorSet!({ learner: ANA, traits: { extraversion: 0.62, openness: 0.7 }, by: 'ops' })).toMatchObject({
        actor: 'operator:ops',
        reason: 'set',
      });
      const learned = await runtimeTurn(booted, played);
      expect(learned).toContain(renderPersonalitySection({ honesty: 0.9, extraversion: 0.62, openness: 0.7 })!);
      expect(learned).not.toContain(directiveFor('extraversion', 0.8));
      expect(await layer.exportLearnedState!(ANA)).toMatchObject({ learner: ANA, personaId: 'tutor', traitState: { current: { extraversion: 0.62, openness: 0.7 } } });

      await tools.remember('Ana keeps bees.', { scope: 'user', scopeId: learnerUserScopeId(ANA) });
      const report = await layer.forgetUser!('ana');
      expect(report).toMatchObject({ userId: 'ana', namespace: '' });
      expect(report.stores).toContainEqual({ store: 'memory tools facade of brain tools-brain', reached: true, deleted: 1 });
      expect(liveContents(toolsFile)).toEqual([]);
      expect(await host.store.traitRow('', 'tutor', 'ana')).toBeUndefined();
      // The runtime's session renders the persona's authored traits from its next turn, and writes no row again.
      const after = await runtimeTurn(booted, played);
      expect(after).toContain(renderPersonalitySection(TUTOR_PERSONA)!);
      expect(after).not.toContain(directiveFor('openness', 0.7));
      expect(await host.store.traitRow('', 'tutor', 'ana')).toBeUndefined();
    } finally {
      await booted.shutdown();
    }
  });
});

describe.skipIf(!POSTGRES_URL)("a learner's trait row on Postgres", () => {
  /** This run's own mark, in the names of the schemas its cases make and drop. */
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const segments: string[] = [];
  const adapters: StorageAdapter[] = [];

  /** The host's Postgres adapter over `segment`, a schema of this run's own. */
  async function openPostgresAdapter(segment: string): Promise<StorageAdapter> {
    const adapter = createPostgresAdapter({ connectionString: POSTGRES_URL!, segment, max: 5 });
    await adapter.open();
    adapters.push(adapter);
    return adapter;
  }

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) await adapter.close().catch(() => undefined);
  });

  afterAll(async () => {
    if (segments.length === 0) return;
    const admin = createPostgresAdapter({ connectionString: POSTGRES_URL! });
    await admin.open();
    try {
      for (const segment of segments) await admin.exec(`DROP SCHEMA IF EXISTS "${segment}" CASCADE`);
    } finally {
      await admin.close();
    }
  });

  it("keeps a host's learners in SQL over its Postgres adapter, and of two processes that open one learner's first session at once writes one trait row and one creation, which verifies", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const segment = `qa_traits_${run}_${segments.length}`;
    segments.push(segment);
    const one = await openPostgresAdapter(segment);
    const two = await openPostgresAdapter(segment);
    // Each process has made or found the tables before they meet.
    const first = new SqlLearningStore({ adapter: one });
    const second = new SqlLearningStore({ adapter: two });
    expect(await first.isForgotten('warm-up')).toBe(false);
    expect(await second.isForgotten('warm-up')).toBe(false);
    const layerOne = createLearningLayer({ storageAdapter: one });
    const layerTwo = createLearningLayer({ storageAdapter: two });
    try {
      expect((await layerOne.manifest()).loops.ledger).toEqual({ live: true, detail: "sql store over the host's storage adapter; unkeyed" });
      const [a, b] = await Promise.all([
        layerOne.forLearner(LEARNER_42, productContext('s-1')),
        layerTwo.forLearner(LEARNER_42, productContext('s-2')),
      ]);
      const [turnA, turnB] = await Promise.all([a.prepareTurn(productTurn()), b.prepareTurn(productTurn())]);
      expect(turnA.systemPrompts[0]?.content).toBe(renderPersonalitySection(TUTOR_PERSONA));
      expect(turnB.systemPrompts[0]?.content).toBe(renderPersonalitySection(TUTOR_PERSONA));
      expect(await second.traitRow('A', 'tutor', '42')).toMatchObject({ personaId: 'tutor', version: 1 });
      const rows = await first.chainRows(chainKeyOf(LEARNER_42));
      expect(rows.map((row) => [row.rowType, row.kind, row.verdict])).toEqual([
        ['candidate', 'operator_set', 'pending'],
        ['verdict', 'operator_set', 'kept'],
      ]);
      expect(await new Ledger({ store: second }).verifyChain(chainKeyOf(LEARNER_42))).toEqual({ ok: true, keyed: false });
      expect((await first.sessionRowsOf('A', '42')).map((row) => row.sessionId)).toEqual(['s-1', 's-2']);
      expect((await layerTwo.manifest()).loops.ledger).toEqual({ live: true, detail: "sql store over the host's storage adapter; unkeyed" });
      // Each process records its own writes on the one chain.
      expect(await a.recordSelfChange!(watchedWrite('mt-a').input)).toMatchObject({ status: 'kept' });
      expect(await b.recordSelfChange!(watchedWrite('mt-b').input)).toMatchObject({ status: 'kept' });
      expect(await new Ledger({ store: first }).verifyChain(chainKeyOf(LEARNER_42))).toEqual({ ok: true, keyed: false });
    } finally {
      await layerOne.close();
      await layerTwo.close();
    }
  });
});

describe.skipIf(!POSTGRES_URL)("an operator's calls on Postgres", () => {
  /** This run's own mark, in the names of the schemas its cases make and drop. */
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const segments: string[] = [];
  const adapters: StorageAdapter[] = [];

  /** The host's Postgres adapter over `segment`, a schema of this run's own. */
  async function openPostgresAdapter(segment: string): Promise<StorageAdapter> {
    const adapter = createPostgresAdapter({ connectionString: POSTGRES_URL!, segment, max: 5 });
    await adapter.open();
    adapters.push(adapter);
    return adapter;
  }

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) await adapter.close().catch(() => undefined);
  });

  afterAll(async () => {
    if (segments.length === 0) return;
    const admin = createPostgresAdapter({ connectionString: POSTGRES_URL! });
    await admin.open();
    try {
      for (const segment of segments) await admin.exec(`DROP SCHEMA IF EXISTS "${segment}" CASCADE`);
    } finally {
      await admin.close();
    }
  });

  it("sets a learner's traits from an operator's process, which the serving process renders at its next session and freezes at its next turn, exports the learner, and forgets the user across the store's tables, over a host's Postgres adapter", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const segment = `qa_operator_${run}_${segments.length}`;
    segments.push(segment);
    const serving = createLearningLayer({ storageAdapter: await openPostgresAdapter(segment) });
    const operatorAdapter = await openPostgresAdapter(segment);
    const operator = createLearningLayer({ storageAdapter: operatorAdapter });
    const store = new SqlLearningStore({ adapter: operatorAdapter });
    try {
      const first = await serving.forLearner(LEARNER_42, productContext('s-1'));
      expect((await first.prepareTurn(productTurn())).systemPrompts[0]?.content).toBe(renderPersonalitySection(TUTOR_PERSONA));
      expect(await operator.operatorSet({ learner: LEARNER_42, traits: { extraversion: 0.62, openness: 0.7 }, by: 'ops' })).toMatchObject({
        actor: 'operator:ops',
        reason: 'set',
      });
      const learned = renderPersonalitySection({ honesty: 0.9, extraversion: 0.62, openness: 0.7 });
      const next = await serving.forLearner(LEARNER_42, productContext('s-2'));
      expect((await next.prepareTurn(productTurn())).systemPrompts[0]?.content).toBe(learned);

      await operator.freeze({ learner: LEARNER_42 }, 'ops');
      expect(await store.freezeRows()).toMatchObject([{ scopeKey: 'learner|A|tutor|42', mode: 'frozen', setBy: 'operator:ops' }]);
      const frozen = await next.prepareTurn(productTurn());
      expect([frozen.mode, frozen.systemPrompts[0]?.content]).toEqual(['frozen', learned]);

      const doc = await operator.exportLearnedState(LEARNER_42);
      expect(doc.ledger.map((entry) => [entry.rowType, entry.reason])).toEqual([
        ['candidate', 'created'],
        ['verdict', 'created'],
        ['candidate', 'set'],
        ['verdict', 'set'],
      ]);
      expect(doc.traitState).toMatchObject({ current: { extraversion: 0.62, openness: 0.7 } });

      const report = await operator.forgetUser('42', { namespace: 'A' });
      expect(report.stores).toContainEqual({
        store: 'learning store',
        reached: true,
        deleted: { ledger: 4, heads: 1, traits: 1, outcomes: 0, lessons: 0, skills: 0, sessions: 2, freezes: 1 },
      });
      expect(await store.traitRow('A', 'tutor', '42')).toBeUndefined();
      expect(await store.chainRows(chainKeyOf(LEARNER_42))).toEqual([]);
      expect(await store.sessionRowsOf('A', '42')).toEqual([]);
      expect(await store.freezeRows()).toEqual([]);
      expect(await store.isForgotten(await tombstoneHash('A', '42'))).toBe(true);
      // The serving process's session reads the tombstone at its next turn.
      const after = await next.prepareTurn(productTurn());
      expect([after.mode, after.systemPrompts[0]?.content]).toEqual(['on', renderPersonalitySection(TUTOR_PERSONA)]);
      await expect(operator.importLearnedState(doc)).rejects.toThrow(
        'importLearnedState: the user is forgotten in this namespace; nothing is written for them again.',
      );
    } finally {
      await serving.close();
      await operator.close();
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

  it("describe how an import, an export and a migration keep a Brain's scope-id form", () => {
    const operations = doc('docs/MEMORY_OPERATIONS.md');
    expect(operations).toMatch(/^### A Brain's scope-id form$/m);
    expect(operations).toContain('| JSON export | encoded when its `meta` holds the record |');
    expect(operations).toContain('| SQLite file | encoded when the brain it holds has the record in `brain_meta` |');
    expect(operations).toContain('| Markdown or Obsidian note | encoded when its front matter says `scopeIdForm: encoded` |');
    expect(operations).toContain('| CSV file, ChatGPT export | plain |');
    expect(operations).toContain('reads the same in both forms, and an import takes it as a plain one');
    expect(operations).toContain("On Postgres the import first takes the brain's advisory lock, as a re-file does.");
    expect(operations).toContain('An export reads its Brain\'s record and its rows in one form');
    expect(operations).toContain("that the Brain's scope-id form refuses");
    expect(doc('docs/getting-started/SQL_STORAGE_QUICKSTART.md')).toContain(
      'Before it copies any table, the engine compares each brain the source holds with the same brain id in the target',
    );
    expect(doc('docs/memory/MEMORY_STORAGE.md')).toContain("Its `brain_meta` rows carry the brain's scope-id form record where the brain has one");
  });

  it("describe a learner's trait row, where the ledger lives and its key, and what a host's own turn loop records", () => {
    const gmiDoc = doc('docs/GMI.md');
    expect(gmiDoc).toMatch(/^### The trait row and the ledger$/m);
    expect(gmiDoc).toContain('| `store` | Where the trait rows, the ledger and the run-time freezes live');
    expect(gmiDoc).toContain('| `ledgerKey` | A secret that keys every ledger hash (HMAC-SHA-256)');
    expect(gmiDoc).toContain("| `clock` | The layer's clock in milliseconds since the epoch");
    expect(gmiDoc).toContain("| `memoryTools` | The `Memory` facade the host's memory tools are built over.");
    expect(gmiDoc).toContain("with an `operator_set` ledger row (actor `operator:persona`, reason `created`) whose verdict carries the row's digest");
    expect(gmiDoc).toContain('so a learner who had extraversion 0.8 renders 0.5 once the persona sets 0.3');
    expect(gmiDoc).toContain("Each trait keeps the band it rendered last until its value passes the band's threshold by 0.02.");
    expect(gmiDoc).toContain("| `on` | The learner's trait row; the authored traits on a turn with no learner |");
    expect(gmiDoc).toContain('(`chain broken for 1 learner`)');
    expect(gmiDoc).toContain('`traits: degraded (<reason>)`');
    expect(gmiDoc).toContain('A session records a memory write the product makes (`recordSelfChange`)');
    expect(doc('docs/memory/HEXACO_PERSONALITY.md')).toContain("the section renders the learner's trait row, which the tool does not change");
  });

  it("describe the operator's calls on a learner, what forgetUser reaches and what it leaves, and a crash's pending write", () => {
    const gmiDoc = doc('docs/GMI.md');
    expect(gmiDoc).toContain(
      "The layer `createLearningLayer()` returns carries the operator's calls, and so does the layer the full runtime builds from its `learning` option (`AgentOS.getLearningLayer()`).",
    );
    expect(gmiDoc).toContain('| `freeze(scope, by?)`, `unfreeze(scope)` | A run-time freeze of every agent');
    expect(gmiDoc).toContain('| `suspend(scope, by?)`, `unsuspend(scope)` | Mode `off` for the scope\'s turns');
    expect(gmiDoc).toContain('| `operatorSet({ learner, traits, by, note? })` | Sets a learner\'s traits');
    expect(gmiDoc).toContain('| `revert(ledgerId, by)` | Takes back a kept change');
    expect(gmiDoc).toContain("An import that created the trait row goes back to the values the learner's first session would have written.");
    expect(gmiDoc).toContain('| `exportLearnedState(learner)` | One JSON document');
    expect(gmiDoc).toContain('| `importLearnedState(doc, target?)` | Takes the four learnable traits');
    expect(gmiDoc).toContain("`forgetUser` takes the user's write chain, so every write this process admitted for the user reaches its verdict first.");
    expect(gmiDoc).toContain("A brain a session row names that neither reaches is reached through the host's storage adapter when it holds that brain's traces.");
    expect(gmiDoc).toContain("names the first 16 hexadecimal digits of the user's tombstone, never the user id");
    expect(gmiDoc).toContain("A recorded memory write that a crash left `pending` (its verdict never written) is decided at the learner's next session");
    expect(gmiDoc).toContain('(reason `floor_raised`)');
    expect(gmiDoc).toContain('- `forgetUnreached`: the stores `forgetUser` does not reach, each with why.');
  });
});
