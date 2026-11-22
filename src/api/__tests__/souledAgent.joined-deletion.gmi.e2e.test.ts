/**
 * `forgetUser` on a souled agent on the GMI runtime with cognitive memory on and learning off, end to end over the real
 * souledAgent(), gmi(), GMI, cognitive memory manager, Memory store and Brain; only the OpenAI provider class is stubbed
 * (helpers/stubProviders.ts), at its module boundary, and it embeds with a deterministic word hash.
 *
 * - Forgetting one of two people deletes every row under their key, whichever side filed it, with what the mind keeps
 *   of each (its cached trace, its vector, its graph node, an archived original), the store's graph nodes and the
 *   full-text index's words; the other person's rows, original and nodes stand; a reopened agent recalls nothing of
 *   the person forgotten. On the agent's own file, a SQLite adapter of the host, and PostgreSQL where
 *   AGENTOS_TEST_POSTGRES_URL is set.
 * - An open session of the person is emptied: an idle one's working-memory slots and messages go, and its next turn
 *   recalls nothing; a turn running at the deletion files nothing, and its reply still reaches its caller.
 * - A mind whose delete fails leaves the person's rows, names the mind's part as missed, writes one
 *   `memory.forget_incomplete` line, and `applyTombstones()` finishes the deletion.
 * - With no cognitive memory built yet, the deletion builds none and sends nothing to the embedding provider, and an
 *   archived original of the person's still goes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import { createPostgresAdapter, resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import { brainOf } from '../../cognition/memory/io/facade/handedBrain';
import type { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { MemoryStore } from '../../cognition/memory/retrieval/store/MemoryStore';
import { CognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager';
import { SqlStorageMemoryArchive } from '../../cognition/memory/archive/SqlStorageMemoryArchive';
import type { IMemoryArchive } from '../../cognition/memory/archive/IMemoryArchive';
import { InMemoryVectorStore } from '../../cognition/rag/vector_stores/InMemoryVectorStore';
import { KnowledgeGraph } from '../../cognition/memory/retrieval/graph/knowledge/KnowledgeGraph';
import type { MemoryTrace } from '../../cognition/memory/core/types';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { GMI } from '../../cognition/substrate/GMI';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import type { MemoryWriteRecord } from '../runtime/memoryWriteRecord';

/** The runtime every case runs on. */
const RUNTIME = 'gmi' as const;
/** Cognitive memory on, embedding through OpenAI, with no mechanism that rewrites a stored row. */
const COGNITIVE = { cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false } };

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
/** This run's own mark, in the names of the schemas its PostgreSQL case makes and drops. */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const schemas: string[] = [];

/** Starts the mind's memory block: the assembler's preamble. */
const MIND_BLOCK = '## How To Use Your Memories';

let n = 0;
let dir: string;
const opened: SouledAgent[] = [];
const closers: Array<() => Promise<unknown>> = [];
const adapters: StorageAdapter[] = [];
/** Every line the library logged in the case, parsed. */
let events: Array<Record<string, unknown>>;
/** The embedding provider's script: every text the mind sent to be embedded. */
let embeddings: ProviderScript;
beforeEach(() => {
  globalLLMProviderHealth.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-joined-deletion-e2e-'));
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\nagentId: aria-1\n---\nYou are Aria.');
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
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const embeddingKey = `k-souled-joined-deletion-embed-${++n}`;
  embeddings = script('openai', embeddingKey, { replies: [] });
  vi.stubEnv('OPENAI_API_KEY', embeddingKey);
});
afterEach(async () => {
  while (opened.length) await opened.pop()!.close().catch(() => undefined);
  while (closers.length) await closers.pop()!().catch(() => undefined);
  while (adapters.length) await adapters.pop()!.close().catch(() => undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetLoggerFactory();
  fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => {
  if (!POSTGRES_URL || schemas.length === 0) return;
  const admin = createPostgresAdapter({ connectionString: POSTGRES_URL });
  await admin.open();
  try {
    for (const schema of schemas) await admin.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.close();
  }
});

/** The logged lines of one event. */
const lines = (event: string) => events.filter((line) => line.event === event);

const keyOf = (id: string) => conversationScopeKey('aria-1', { kind: 'user', id });

let replyNo = 0;
/** Replies to spare, each with words of its own: the store keeps one trace for a text a person's memory already holds. */
const spare = (count = 16): ProviderScript['replies'] => Array.from({ length: count }, () => reply.text(`Noted ${++replyNo}.`));

/** The script the provider of the agent opened last plays: every request it served is in `seen`. */
let served: ProviderScript;

/**
 * A souled agent on the GMI runtime with cognitive memory on and learning off, on the stubbed provider, which answers
 * with `replies` in order; `retention` and `tombstoneKey` are set so two people may share the store.
 */
async function open(extra: Record<string, unknown> = {}, replies: ProviderScript['replies'] = spare()): Promise<SouledAgent> {
  const apiKey = `k-souled-joined-deletion-${++n}`;
  served = script('openai', apiKey, { whole: true, replies });
  const a = await souledAgent({
    runtime: RUNTIME,
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    soul: dir,
    retention: { traces: 'until-deletion' },
    tombstoneKey: 'k-souled-joined-deletion-tombstones',
    ...COGNITIVE,
    ...extra,
  } as unknown as SouledAgentOptions);
  opened.push(a);
  return a;
}
/** Closes an agent the case is done with, before the next open on the same store. */
async function closed(a: SouledAgent): Promise<void> {
  const at = opened.indexOf(a);
  if (at >= 0) opened.splice(at, 1);
  await a.close();
}

type Row = { id: string; scope: string; scope_id: string; content: string; metadata: string };
/** Every trace row under one key, soft-deleted ones included, in id order. */
async function rowsUnder(brain: Brain, key: string): Promise<Row[]> {
  return brain.all<Row>(
    "SELECT id, scope, scope_id, content, metadata FROM memory_traces WHERE brain_id = ? AND scope = 'conversation' AND scope_id = ? ORDER BY id",
    [brain.brainId, key],
  );
}
/** A row's metadata, read as the store wrote it. */
const metaOf = (row: Row): Record<string, unknown> => JSON.parse(row.metadata || '{}') as Record<string, unknown>;
const storeBrain = (a: SouledAgent): Brain => brainOf(a.memory!);

/** The trace ids among `ids` that hold an archived original in the store. */
async function archivedAmong(brain: Brain, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await brain.all<{ trace_id: string }>(
    `SELECT trace_id FROM archived_traces WHERE brain_id = ? AND trace_id IN (${ids.map(() => '?').join(', ')})`,
    [brain.brainId, ...ids],
  );
  return rows.map((row) => row.trace_id).sort();
}
/** The ids among `ids` that hold a node in the store's own graph tables. */
async function graphNodesAmong(brain: Brain, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await brain.all<{ id: string }>(
    `SELECT id FROM knowledge_nodes WHERE brain_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
    [brain.brainId, ...ids],
  );
  return rows.map((row) => row.id).sort();
}
/**
 * How many entries of the store's full-text index hold a word, read from the index itself, without the traces: on
 * SQLite a word stays in it until the index is rebuilt. PostgreSQL keeps the index in each row, which goes with the
 * row, so there it is the rows that hold the word.
 */
async function fullTextHits(brain: Brain, word: string): Promise<number> {
  if (brain.features.dialect.name === 'postgres') {
    const rows = await brain.all<{ id: string }>('SELECT id FROM memory_traces WHERE brain_id = ? AND LOWER(content) LIKE ?', [
      brain.brainId,
      `%${word.toLowerCase()}%`,
    ]);
    return rows.length;
  }
  return (await brain.all<{ rowid: number }>('SELECT rowid FROM memory_traces_fts WHERE memory_traces_fts MATCH ?', [word])).length;
}

/** Plants an archived original of a trace, as a gist would have left it, through `archive`. */
async function plantOriginal(archive: IMemoryArchive, traceId: string, text: string): Promise<void> {
  await archive.store({
    traceId,
    agentId: 'aria-1',
    verbatimContent: text,
    contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    traceType: 'episodic',
    emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: 'neutral' },
    entities: [],
    tags: [],
    createdAt: Date.now(),
    archivedAt: Date.now(),
    archiveReason: 'temporal_gist',
  });
}

/** The promise of a turn's write record, as the turn's result carries it. */
function writeOf(result: { memoryWrite?: Promise<MemoryWriteRecord> }): Promise<MemoryWriteRecord> {
  expect(result.memoryWrite).toBeInstanceOf(Promise);
  return result.memoryWrite!;
}
/** A record whose two entries were both skipped for `reason`. */
const bothSkipped = (reason: string): MemoryWriteRecord =>
  ({
    entries: [
      { role: 'user', outcome: 'skipped', reason },
      { role: 'assistant', outcome: 'skipped', reason },
    ],
  }) as unknown as MemoryWriteRecord;

type ModelCall = ProviderScript['seen'][number];
/** The texts of a message: its one string, or the text of each of its text parts. */
function textPartsOf(message: ModelCall['messages'][number]): string[] {
  const content = message.content as unknown;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []));
}
/** The mind's memory block of one model call: the text part that carries the assembler's preamble; '' when absent. */
const mindBlockOf = (call: ModelCall): string => call.messages.flatMap(textPartsOf).find((part) => part.includes(MIND_BLOCK)) ?? '';
/** The last model call the agent's provider served. */
const lastCall = (): ModelCall => served.seen[served.seen.length - 1];

/** A gate a held reply waits on, and its opener. */
function gated(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/** The cognitive memory managers the agent's sessions built, in the order they were built. */
function managersBuilt(): () => CognitiveMemoryManager[] {
  const built = vi.spyOn(CognitiveMemoryManager.prototype, 'initialize');
  return () => built.mock.contexts as unknown as CognitiveMemoryManager[];
}
/** The GMIs built in the case, in order: a session that keeps history builds one, with its first turn. */
function builtGmis(): GMI[] {
  const built: GMI[] = [];
  const initialize = GMI.prototype.initialize;
  vi.spyOn(GMI.prototype, 'initialize').mockImplementation(async function (this: GMI, ...args) {
    built.push(this);
    return initialize.apply(this, args);
  });
  return built;
}
/** What a manager still holds of a set of traces: the live ones of its cache, and those its graph has a node of. */
function heldBy(manager: CognitiveMemoryManager, ids: readonly string[]): { cached: string[]; nodes: string[]; words: boolean } {
  const cache = manager.getStore().listTraces();
  const wanted = new Set(ids);
  return {
    cached: cache.filter((trace) => trace.isActive && wanted.has(trace.id)).map((trace) => trace.id).sort(),
    nodes: ids.filter((id) => manager.getGraph()?.hasNode(id) === true).sort(),
    words: cache.some((trace) => wanted.has(trace.id) && trace.content !== ''),
  };
}
/**
 * The ids among `ids` that hold a vector in a manager's vector index, in any of its collections: the in-process index
 * the GMI's cognitive memory builds, read through its own collections, since it offers no read by id.
 */
function vectorsAmong(manager: CognitiveMemoryManager, ids: readonly string[]): string[] {
  const index = manager.getConfig().vectorStore as unknown as { collections: Map<string, { documents: Map<string, unknown> }> };
  const wanted = new Set(ids);
  const found = new Set<string>();
  for (const collection of index.collections.values()) {
    for (const id of collection.documents.keys()) if (wanted.has(id)) found.add(id);
  }
  return [...found].sort();
}

/** A bag-of-words vector, as the stubbed provider embeds: texts that share a word point the same way. */
function wordVector(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    vector[h % dim] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}
/** A store on the agent's Brain that files rows as the mind would have filed them. */
async function planter(brain: Brain): Promise<MemoryStore> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: `plant-${Math.random().toString(36).slice(2)}`, type: 'in_memory', defaultEmbeddingDimension: 1536, similarityMetric: 'cosine' } as never);
  const knowledgeGraph = new KnowledgeGraph();
  await knowledgeGraph.initialize();
  const store = new MemoryStore({
    vectorStore,
    embeddingManager: {
      initialize: async () => undefined,
      generateEmbeddings: async (request: { texts: string | string[] }) => {
        const texts = Array.isArray(request.texts) ? request.texts : [request.texts];
        return { embeddings: texts.map((text) => wordVector(text, 1536)), modelId: 'words', providerId: 'test', usage: { totalTokens: 0 } };
      },
      getEmbeddingModelInfo: async () => ({ modelId: 'words', providerId: 'test', dimension: 1536 }),
      getEmbeddingDimension: async () => 1536,
      checkHealth: async () => ({ isHealthy: true }),
      shutdown: async () => undefined,
    } as never,
    knowledgeGraph,
    collectionPrefix: 'plant',
  });
  store.setBrain(brain);
  closers.push(async () => store.dispose());
  return store;
}
/** A trace of what `subjectId` said, filed by the mind under their key at `createdAt`. */
function mindTrace(id: string, content: string, subjectId: string, createdAt: number): MemoryTrace {
  return {
    id,
    type: 'episodic',
    scope: 'conversation',
    scopeId: keyOf(subjectId),
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
    filing: { filedBy: 'mind', speaker: 'user', subject: { kind: 'user', id: subjectId } },
  } as MemoryTrace;
}

/** A SQLite adapter on a file of the case's folder, opened as a host opens its own. */
async function sqliteAdapter(): Promise<StorageAdapter> {
  const adapter = await resolveStorageAdapter({ filePath: path.join(dir, 'host.sqlite'), priority: ['better-sqlite3', 'sqljs'], quiet: true });
  adapters.push(adapter);
  return adapter;
}
/** A PostgreSQL adapter whose tables go in a schema of this run's own. */
async function postgresAdapter(): Promise<StorageAdapter> {
  const schema = `souled_joined_del_${RUN}_${schemas.length}`;
  schemas.push(schema);
  const adapter = createPostgresAdapter({ connectionString: POSTGRES_URL!, segment: schema, max: 5, typeParsers: { int8: 'number' as const } });
  await adapter.open();
  adapters.push(adapter);
  return adapter;
}

/** Where a case keeps the soul's store: its own file, or a host adapter handed in through `soulStore`. */
const STORES: Array<[string, () => Promise<Record<string, unknown>>, boolean]> = [
  ['its own file', async () => ({}), true],
  ['a SQLite adapter of the host', async () => ({ soulStore: { adapter: await sqliteAdapter() }, tombstoneCopy: { path: path.join(dir, 'forgotten.sqlite') } }), true],
  ['a PostgreSQL adapter of the host', async () => ({ soulStore: { adapter: await postgresAdapter() }, tombstoneCopy: { path: path.join(dir, 'forgotten.sqlite') } }), Boolean(POSTGRES_URL)],
];

describe.each(STORES)('forgetUser on a souled agent on the GMI runtime with learning off, its store on %s', (_store, storeOptions, runs) => {
  it.runIf(runs)("reaches every copy of one person's memory and leaves the other person's", async () => {
    const options = await storeOptions();
    const managers = managersBuilt();
    const a = await open(options, [reply.text('A canary, lovely.'), reply.text('A finch, lovely.'), ...spare()]);
    const brain = storeBrain(a);
    await writeOf(await a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.'));
    await writeOf(await a.session('s2', { userId: 'bob' }).send('My finch is named WREN-2.'));
    // What she told the soul's provider before the join: a row of her key with no mark of the mind.
    const told = await a.memory!.remember('Alice keeps a ferret named QUILL-9.', { type: 'episodic', scope: 'conversation', scopeId: keyOf('alice') });
    expect(managers()).toHaveLength(1);
    const manager = managers()[0];
    const hers = await rowsUnder(brain, keyOf('alice'));
    const his = await rowsUnder(brain, keyOf('bob'));
    const herIds = hers.map((row) => row.id);
    const herMindIds = hers.filter((row) => metaOf(row).filedBy === 'mind').map((row) => row.id);
    const hisIds = his.map((row) => row.id);
    // An original of one trace of each, planted through the mind's own archive, as a gist leaves one.
    const archive = manager.getConfig().archive!;
    await plantOriginal(archive, herMindIds[0], 'My canary is named LARK-7, the yellow one.');
    await plantOriginal(archive, hisIds[0], 'My finch is named WREN-2, the brown one.');

    // What the store and the mind hold of her before the deletion.
    expect(hers).toHaveLength(3);
    expect(herMindIds).toHaveLength(2);
    expect(herIds).toContain(told.id);
    expect(heldBy(manager, herMindIds)).toEqual({ cached: [...herMindIds].sort(), nodes: [...herMindIds].sort(), words: true });
    expect(vectorsAmong(manager, herMindIds)).not.toEqual([]);
    const hisVectors = vectorsAmong(manager, hisIds);
    expect(hisVectors).not.toEqual([]);
    expect(await manager.getStore().getByScope('conversation', keyOf('alice'))).not.toEqual([]);
    expect(await archivedAmong(brain, herIds)).toEqual([herMindIds[0]]);
    expect(await graphNodesAmong(brain, [told.id])).toEqual([told.id]);
    for (const word of ['lark', 'quill']) expect(await fullTextHits(brain, word)).toBeGreaterThan(0);

    const report = await a.forgetUser!('alice');

    // No row of hers, by either side, live or soft-deleted.
    expect(await rowsUnder(brain, keyOf('alice'))).toEqual([]);
    expect(await archivedAmong(brain, herIds)).toEqual([]);
    expect(await graphNodesAmong(brain, herIds)).toEqual([]);
    for (const word of ['lark', 'quill']) expect(await fullTextHits(brain, word)).toBe(0);
    // Nothing of hers in the mind: no live trace in its cache, no words in what it keeps, no graph node, no vector.
    expect(heldBy(manager, herIds)).toEqual({ cached: [], nodes: [], words: false });
    expect(vectorsAmong(manager, herIds)).toEqual([]);
    expect(await manager.getStore().getByScope('conversation', keyOf('alice'))).toEqual([]);
    // Every row of his stands, with his original, his graph nodes and his vectors.
    expect((await rowsUnder(brain, keyOf('bob'))).map((row) => row.id)).toEqual(hisIds);
    expect(await archivedAmong(brain, hisIds)).toEqual([hisIds[0]]);
    expect(heldBy(manager, hisIds).nodes).toEqual([...hisIds].sort());
    expect(vectorsAmong(manager, hisIds)).toEqual(hisVectors);
    expect(await fullTextHits(brain, 'wren')).toBeGreaterThan(0);
    // The receipt: complete, and the mind's part counts each row of hers it deleted.
    expect(report.complete).toBe(true);
    expect(report.parts.map((part) => part.part)).toEqual(['tombstone', 'mind', 'store', 'sessions']);
    expect(report.parts[1]).toEqual({ part: 'mind', reached: true, deleted: hers.length });
    expect(report.stores).toContainEqual({ store: 'cognitive memory', reached: true, deleted: hers.length });
    expect(lines('memory.forget_incomplete')).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(/alice|LARK-7|QUILL-9/);

    // A new agent on the same store recalls nothing of her, and still recalls him.
    await closed(a);
    const again = await open(options, [reply.text('I do not know.'), reply.text('It is WREN-2.'), ...spare()]);
    await again.session('s3', { userId: 'alice' }).send('What are my pets named?');
    const asked = JSON.stringify(lastCall().messages);
    for (const word of ['LARK-7', 'QUILL-9']) expect(asked).not.toContain(word);
    await again.session('s4', { userId: 'bob' }).send('What is my finch named?');
    expect(mindBlockOf(lastCall())).toContain('WREN-2');
  });
});

describe('forgetUser and the open sessions of the person, on the GMI runtime with cognitive memory on', () => {
  it('empties an idle session of the person, whose next turn recalls nothing and files nothing', async () => {
    const gmis = builtGmis();
    const a = await open({}, [reply.text('A canary, lovely.'), reply.text('I do not know.'), ...spare()]);
    const session = a.session('s1', { userId: 'alice' });
    await writeOf(await session.send('My canary is named LARK-7.'));
    expect(gmis).toHaveLength(1);
    const view = gmis[0].getCognitiveMemoryManager()!.getWorkingMemory();
    expect(view.getSlotCount()).toBeGreaterThan(0);
    expect(session.messages().length).toBeGreaterThan(0);

    const report = await a.forgetUser!('alice');

    expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 1 });
    expect(report.complete).toBe(true);
    expect(view.getSlotCount()).toBe(0);
    expect(session.messages()).toEqual([]);
    const record = await writeOf(await session.send('What is my canary named?'));
    expect(JSON.stringify(lastCall().messages)).not.toContain('LARK-7');
    expect(mindBlockOf(lastCall())).not.toContain('canary');
    expect(record).toEqual(bothSkipped('forgotten'));
    expect(await rowsUnder(storeBrain(a), keyOf('alice'))).toEqual([]);
  });

  it("files nothing of a turn running at the deletion, and the turn's reply reaches its caller", async () => {
    const { gate, release } = gated();
    const a = await open({ pendingWritesTimeoutMs: 100 }, [reply.text('A canary, lovely.'), reply.hold([], gate, reply.text('In the attic, noted.')), ...spare()]);
    const session = a.session('s1', { userId: 'alice' });
    await writeOf(await session.send('My canary is named LARK-7.'));
    const calls = served.seen.length;
    const running = session.send('I keep it in the attic.');
    try {
      await vi.waitFor(() => expect(served.seen.length).toBeGreaterThan(calls), { timeout: 4_000 });

      const report = await a.forgetUser!('alice');

      expect(report.parts[3]).toMatchObject({ part: 'sessions', reached: false });
      expect(report.parts[1]).toMatchObject({ part: 'mind', reached: true });
      expect(await rowsUnder(storeBrain(a), keyOf('alice'))).toEqual([]);
    } finally {
      release();
    }
    const result = await running;
    expect(result.text).toBe('In the attic, noted.');
    expect(await writeOf(result)).toEqual(bothSkipped('forgotten'));
    expect(await rowsUnder(storeBrain(a), keyOf('alice'))).toEqual([]);
  });
});

describe("forgetUser when the mind's delete fails", () => {
  it("keeps the person's rows, names the mind's part, says so in one line, and applyTombstones() finishes it", async () => {
    const managers = managersBuilt();
    const a = await open({}, [reply.text('A canary, lovely.'), reply.text('A finch, lovely.'), ...spare()]);
    const brain = storeBrain(a);
    await writeOf(await a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.'));
    await writeOf(await a.session('s2', { userId: 'bob' }).send('My finch is named WREN-2.'));
    const hers = (await rowsUnder(brain, keyOf('alice'))).map((row) => row.id);
    const his = (await rowsUnder(brain, keyOf('bob'))).map((row) => row.id);
    expect(hers).toHaveLength(2);
    vi.spyOn(CognitiveMemoryManager.prototype, 'deleteScope').mockRejectedValueOnce(new Error('the mind is busy'));

    const report = await a.forgetUser!('alice');

    expect(report.parts[1]).toEqual({ part: 'mind', reached: false, reason: 'the mind is busy' });
    expect(report.complete).toBe(false);
    expect(report.stores).toContainEqual({ store: 'cognitive memory', reached: false, reason: 'the mind is busy' });
    const said = lines('memory.forget_incomplete');
    expect(said).toEqual([expect.objectContaining({ tombstone: 'reached', mind: 'missed' })]);
    expect(JSON.stringify(said)).not.toMatch(/alice|LARK-7|busy/);
    // Her rows stand, so the deletion made again finds them.
    expect((await rowsUnder(brain, keyOf('alice'))).map((row) => row.id)).toEqual(hers);

    const [again, ...more] = await a.applyTombstones!();

    expect(more).toEqual([]);
    expect(again.complete).toBe(true);
    expect(again.parts[1]).toEqual({ part: 'mind', reached: true, deleted: hers.length });
    expect(await rowsUnder(brain, keyOf('alice'))).toEqual([]);
    expect(heldBy(managers()[0], hers)).toEqual({ cached: [], nodes: [], words: false });
    expect(vectorsAmong(managers()[0], hers)).toEqual([]);
    expect((await rowsUnder(brain, keyOf('bob'))).map((row) => row.id)).toEqual(his);
  });
});

describe('an erasure never waits for an embedding provider', () => {
  it('with no cognitive memory built yet, deletes the person and their archived original, builds none and embeds nothing', async () => {
    const a = await open();
    const brain = storeBrain(a);
    const t0 = Date.now() - 60_000;
    const plant = await planter(brain);
    await plant.store(mindTrace('alice-1', 'My canary is named LARK-7.', 'alice', t0));
    await plant.store(mindTrace('bob-1', 'My finch is named WREN-2.', 'bob', t0 + 1));
    const archive = new SqlStorageMemoryArchive(brain.adapter, brain.features, brain.brainId);
    await archive.initialize();
    await plantOriginal(archive, 'alice-1', 'My canary is named LARK-7, the yellow one.');
    await plantOriginal(archive, 'bob-1', 'My finch is named WREN-2, the brown one.');
    const managers = managersBuilt();
    // The embedding provider is down: a deletion that built the mind's memory would fail at its test embedding.
    embeddings.failEmbedding = () => true;
    embeddings.embedded.length = 0;

    const report = await a.forgetUser!('alice');

    expect(report.complete).toBe(true);
    expect(await rowsUnder(brain, keyOf('alice'))).toEqual([]);
    expect(await archivedAmong(brain, ['alice-1', 'bob-1'])).toEqual(['bob-1']);
    expect((await rowsUnder(brain, keyOf('bob'))).map((row) => row.id)).toEqual(['bob-1']);
    expect(managers()).toEqual([]);
    expect(embeddings.embedded).toEqual([]);
  });
});
