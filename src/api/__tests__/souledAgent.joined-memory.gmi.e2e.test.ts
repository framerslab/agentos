/**
 * One memory for a souled agent on the GMI runtime with cognitive memory on, end to end over the real souledAgent(),
 * gmi(), GMI, cognitive memory manager, Memory store and Brain; only the OpenAI provider class is stubbed
 * (helpers/stubProviders.ts), at its module boundary, and it embeds with a deterministic word hash.
 *
 * - The mind files each session turn once, in the soul's own store, under the person's key, marked as the mind's: a
 *   turn writes two rows, and a new agent on the same folder, the same SQLite adapter or the same PostgreSQL database
 *   recalls them.
 * - Two recall paths: the soul's provider reads the rows of the person's key the mind did not file, the mind reads the
 *   rows it filed, and neither reads another person's.
 * - A person's first turn of a session loads their rows alone, however many rows other people hold.
 * - A one-shot call files nothing and recalls the operator's pages.
 * - A new embedding model of another vector size serves, files and recalls; the stored rows of the old size stay out
 *   of the mind's index, and a load counts them in one line.
 * - Two sessions of one person sending at once file four rows, each turn's record naming its own two.
 * - A turn that fails, or that `session.close()` or the caller's signal stops, files neither side, and the next turn
 *   files as usual; so does a structured send whose answer does not parse, which the session refuses before its GMI
 *   commits the turn. A structured send repaired inside its turn files the question and the accepted answer once. An
 *   id no memory key can be built from files nothing.
 * - `close()` waits for the mind's writes before the mind's memory shuts down, and the soul's store is closed once.
 * - A memory that does not build fails the turn, and the next turn builds it again.
 *
 * The PostgreSQL case runs where AGENTOS_TEST_POSTGRES_URL is set, in a schema of its own.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import { z } from 'zod';
import { createPostgresAdapter, resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import { ObjectGenerationError } from '../generateObject';
import { brainOf } from '../../cognition/memory/io/facade/handedBrain';
import type { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { MemoryStore } from '../../cognition/memory/retrieval/store/MemoryStore';
import { CognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager';
import { InMemoryVectorStore } from '../../cognition/rag/vector_stores/InMemoryVectorStore';
import { KnowledgeGraph } from '../../cognition/memory/retrieval/graph/knowledge/KnowledgeGraph';
import type { MemoryTrace } from '../../cognition/memory/core/types';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import type { MemoryWriteRecord } from '../runtime/memoryWriteRecord';

/**
 * The runtimes every case runs on, each as the options that select it: `runtime: 'gmi'`, and no `runtime` at all,
 * which is souledAgent()'s default.
 */
const RUNTIMES = [
  ["runtime: 'gmi'", { runtime: 'gmi' }],
  ['no runtime set', {}],
] as const;
/** The runtime options of the suite that is running: each suite of the runtimes sets them before its cases. */
let RUNTIME: (typeof RUNTIMES)[number][1] = RUNTIMES[0][1];
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-joined-memory-e2e-'));
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
  const embeddingKey = `k-souled-joined-embed-${++n}`;
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
 * A souled agent on the GMI runtime with cognitive memory on, on the stubbed provider, which answers with `replies` in
 * order; `retention` and `tombstoneKey` are set so two people may share the store.
 */
async function open(extra: Record<string, unknown> = {}, replies: ProviderScript['replies'] = spare()): Promise<SouledAgent> {
  const apiKey = `k-souled-joined-${++n}`;
  served = script('openai', apiKey, { whole: true, replies });
  const a = await souledAgent({
    ...RUNTIME,
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    soul: dir,
    retention: { traces: 'until-deletion' },
    tombstoneKey: 'k-souled-joined-tombstones',
    ...COGNITIVE,
    ...extra,
  } as unknown as SouledAgentOptions);
  opened.push(a);
  return a;
}
/** Takes an agent out of the ones the case's end closes: the case closes it itself. */
const ownClose = (a: SouledAgent): void => {
  const at = opened.indexOf(a);
  if (at >= 0) opened.splice(at, 1);
};
/** Closes an agent the case is done with, before the next open on the same store. */
async function closed(a: SouledAgent): Promise<void> {
  ownClose(a);
  await a.close();
}

type Row = { id: string; scope: string; scope_id: string; content: string; metadata: string; emotions: string; strength: number; tags: string };
/**
 * Every live trace of the agent's store, oldest first. The two sides of one turn can be stored in the same millisecond,
 * and the person's message is filed before the reply: within a millisecond a row the mind filed for the person comes
 * before one it filed for the agent, and other rows keep their id order.
 */
async function rowsOf(brain: Brain): Promise<Row[]> {
  const rows = await brain.all<Row & { created_at: number | string }>(
    'SELECT id, scope, scope_id, content, metadata, emotions, strength, tags, created_at FROM memory_traces WHERE brain_id = ? AND deleted = 0 ORDER BY created_at, id',
    [brain.brainId],
  );
  const speakerRank = (row: Row): number => (metaOf(row).speaker === 'user' ? 0 : 1);
  return rows
    .sort((a, b) => Number(a.created_at) - Number(b.created_at) || speakerRank(a) - speakerRank(b))
    .map(({ created_at: _createdAt, ...row }) => row);
}
/** The live traces under one key. */
const rowsUnder = async (brain: Brain, key: string): Promise<Row[]> => (await rowsOf(brain)).filter((row) => row.scope === 'conversation' && row.scope_id === key);
/** A row's metadata, read as the store wrote it. */
const metaOf = (row: Row): Record<string, unknown> => JSON.parse(row.metadata || '{}') as Record<string, unknown>;
/**
 * A row without the record of its reads: the store's own recall writes each read of a row it returns on that row (its
 * strength, and the decay state in its metadata), and nothing else of it.
 */
function apartFromReads(row: Row): Omit<Row, 'strength' | 'metadata'> & { metadata: Record<string, unknown> } {
  const { strength: _strength, metadata: _metadata, ...rest } = row;
  const { decay: _decay, ...metadata } = metaOf(row);
  return { ...rest, metadata };
}
/** How many reads a row's own record holds. */
const readsOf = (row: Row): number => (metaOf(row).decay as { accessCount?: number } | undefined)?.accessCount ?? 0;
const storeBrain = (a: SouledAgent): Brain => brainOf(a.memory!);

/** The promise of a turn's write record, as the turn's result carries it. */
function writeOf(result: { memoryWrite?: Promise<MemoryWriteRecord> }): Promise<MemoryWriteRecord> {
  expect(result.memoryWrite).toBeInstanceOf(Promise);
  return result.memoryWrite!;
}
/** The ids a record says were written, in its order. */
const writtenIds = (record: MemoryWriteRecord): string[] =>
  record.entries.flatMap((entry) => (entry.outcome === 'written' ? [entry.traceId] : []));

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
/** The soul's provider block of one model call, its texts' spaces restored: the user-role message that opens with `<memory_recall>`; '' when absent. */
const providerBlockOf = (call: ModelCall): string => {
  const block = call.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<memory_recall>'));
  // The block writes `^` in place of each run of whitespace in a text: read back as one space.
  return block ? (block.content as unknown as string).replace(/\^/g, ' ') : '';
};
/** The last model call the agent's provider served. */
const lastCall = (): ModelCall => served.seen[served.seen.length - 1];
/** The model calls that merged a person's traces into their wiki page. */
const merges = (): ModelCall[] => served.seen.filter((call) => JSON.stringify(call.messages).includes('You maintain a knowledge wiki page'));

/** A gate a held reply waits on, and its opener. */
function gated(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}
/** Whether `work` settles within `ms`. */
const settledWithin = (work: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([
    work.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

/** The cognitive memory managers the agent's sessions built, in the order they were built. */
function managersBuilt(): () => CognitiveMemoryManager[] {
  const built = vi.spyOn(CognitiveMemoryManager.prototype, 'initialize');
  return () => built.mock.contexts as unknown as CognitiveMemoryManager[];
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
/** A store on the agent's Brain that files rows as the mind would have filed them, at the times it is given. */
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
  const schema = `souled_joined_${RUN}_${schemas.length}`;
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

describe.each(RUNTIMES)('with %s', (_name, runtime) => {
  beforeAll(() => {
    RUNTIME = runtime;
  });

  describe.each(STORES)("one memory for a souled agent on the GMI runtime, its store on %s", (_store, storeOptions, runs) => {
    it.runIf(runs)('memory survives a restart in the soul\'s store', async () => {
      const options = await storeOptions();
      const first = await open(options, [reply.text('A canary, lovely.'), reply.text('Dawn songs, noted.'), ...spare()]);
      const session = first.session('s1', { userId: 'alice' });
      await writeOf(await session.send('My canary is named LARK-7.'));
      await writeOf(await session.send('My canary sings at dawn.'));
      const filed = await rowsUnder(storeBrain(first), keyOf('alice'));
      await closed(first);

      const again = await open(options, [reply.text('It is LARK-7.'), ...spare()]);
      await again.session('s2', { userId: 'alice' }).send('What is my canary named?');
      // A new session of a new agent: the turns reach the prompt through the mind's recall, not through history.
      expect(mindBlockOf(lastCall())).toContain('LARK-7');
      // The four rows of the two turns, under her key, each the mind's, with who spoke.
      expect(filed).toHaveLength(4);
      expect(filed.map(metaOf)).toEqual([
        expect.objectContaining({ filedBy: 'mind', speaker: 'user', subject: { kind: 'user', id: 'alice' } }),
        expect.objectContaining({ filedBy: 'mind', speaker: 'assistant', subject: { kind: 'user', id: 'alice' } }),
        expect.objectContaining({ filedBy: 'mind', speaker: 'user', subject: { kind: 'user', id: 'alice' } }),
        expect.objectContaining({ filedBy: 'mind', speaker: 'assistant', subject: { kind: 'user', id: 'alice' } }),
      ]);
    });

    it.runIf(runs)('two people never meet', async () => {
      const a = await open(await storeOptions(), [reply.text('Corn, noted.'), reply.text('Kale, noted.'), reply.text('It eats kale.'), ...spare()]);
      // What each person told the soul's provider before the join: rows of their key with no mark of the mind.
      await a.memory!.remember('Alice keeps a ferret named Quill.', { type: 'episodic', scope: 'conversation', scopeId: keyOf('alice') });
      await a.memory!.remember('Bob keeps a ferret named Pike.', { type: 'episodic', scope: 'conversation', scopeId: keyOf('bob') });

      const bobs = writtenIds(await writeOf(await a.session('b1', { userId: 'bob' }).send('My ferret eats corn.')));
      await writeOf(await a.session('a1', { userId: 'alice' }).send('My ferret eats kale.'));
      const result = await a.session('a2', { userId: 'alice' }).send('What does my ferret eat?');
      const call = lastCall();

      // The soul's provider reads her row it filed, and none the mind filed.
      expect(providerBlockOf(call)).toContain('Quill');
      expect(providerBlockOf(call)).not.toContain('kale');
      // The mind reads her row it filed, and none the soul's provider filed.
      expect(mindBlockOf(call)).toContain('kale');
      expect(mindBlockOf(call)).not.toContain('Quill');
      // Nothing of Bob reaches her turn, by either path or in what the turn's recall reports.
      const request = JSON.stringify(call.messages);
      for (const his of ['Pike', 'corn']) expect(request).not.toContain(his);
      expect(bobs).toHaveLength(2);
      for (const id of bobs) expect(JSON.stringify(result.memoryRecall ?? {})).not.toContain(id);
    });
  });

  describe('one memory for a souled agent on the GMI runtime', () => {
    it('one turn writes two rows', async () => {
      const a = await open({}, [reply.text('A canary, lovely.'), ...spare()]);
      const brain = storeBrain(a);
      const before = (await rowsOf(brain)).length;

      const record = await writeOf(await a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.'));

      const after = await rowsOf(brain);
      expect(after).toHaveLength(before + 2);
      const hers = await rowsUnder(brain, keyOf('alice'));
      expect(hers.map((row) => row.content)).toEqual(['My canary is named LARK-7.', 'A canary, lovely.']);
      expect(hers.map((row) => metaOf(row).filedBy)).toEqual(['mind', 'mind']);
      // The record names the two rows, the user's first.
      expect(record).toEqual({
        entries: [
          { role: 'user', outcome: 'written', traceId: hers[0].id },
          { role: 'assistant', outcome: 'written', traceId: hers[1].id },
        ],
      });
    });

    it('memory filed before the join keeps its recall', async () => {
      const managers = managersBuilt();
      const a = await open({}, [reply.text('Quill, noted.'), ...spare()]);
      const brain = storeBrain(a);
      const planted = await a.memory!.remember('Alice keeps a ferret named Quill.', { type: 'episodic', scope: 'conversation', scopeId: keyOf('alice') });
      const rowBefore = (await rowsOf(brain)).find((row) => row.id === planted.id)!;

      await writeOf(await a.session('s1', { userId: 'alice' }).send('Tell me about my ferret Quill.'));

      expect(providerBlockOf(lastCall())).toContain('Alice keeps a ferret named Quill.');
      expect(mindBlockOf(lastCall())).not.toContain('Alice keeps a ferret named Quill.');
      expect(managers().at(-1)!.getStore().listTraces().map((trace) => trace.id)).not.toContain(planted.id);
      const rowAfter = (await rowsOf(brain)).find((row) => row.id === planted.id)!;
      // The row is as it was planted, with no mark of the mind: all the turn wrote on it is the provider's one read.
      expect(apartFromReads(rowAfter)).toEqual(apartFromReads(rowBefore));
      expect(metaOf(rowAfter)).not.toHaveProperty('filedBy');
      expect(readsOf(rowBefore)).toBe(0);
      expect(readsOf(rowAfter)).toBe(1);
    });

    it("a person's first turn loads their rows alone", async () => {
      const managers = managersBuilt();
      const a = await open({}, [reply.text('The ferry, noted.'), ...spare()]);
      const brain = storeBrain(a);
      const plant = await planter(brain);
      const t0 = Date.now() - 600_000;
      const hers: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        hers.push(`alice-${i}`);
        await plant.store(mindTrace(`alice-${i}`, `Alice note ${i} about the ferry.`, 'alice', t0 + i));
      }
      // Bob's rows are the newest in the store: a load of the brain's newest rows would be his alone.
      for (let i = 0; i < 1200; i += 1) await plant.store(mindTrace(`bob-${i}`, `Bob note ${i} about the ferry.`, 'bob', t0 + 100 + i));

      await writeOf(await a.session('s1', { userId: 'alice' }).send('When does the ferry leave?'));

      const store = managers().at(-1)!.getStore();
      const cached = store.listTraces();
      for (const id of hers) expect(cached.map((trace) => trace.id)).toContain(id);
      expect(cached.filter((trace) => trace.scopeId === keyOf('bob'))).toEqual([]);
      // Nor does the mind's vector collection: a listing of his key, which the cache holds nothing of, reads it.
      expect(await store.getByScope('conversation', keyOf('bob'))).toEqual([]);
      expect(mindBlockOf(lastCall())).toContain('Alice note');
      expect(mindBlockOf(lastCall())).not.toContain('Bob note');
    });

    it("a one-shot call files nothing and recalls the operator's pages", async () => {
      fs.mkdirSync(path.join(dir, 'memory', 'concepts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'memory', 'concepts', 'ops.md'), '---\nid: concepts/ops\ntype: concept\nsummary: Opening hours\n---\nZorblat opens at nine.\n');
      const a = await open({}, [reply.text('At nine.'), ...spare()]);
      const brain = storeBrain(a);
      const before = await rowsOf(brain);

      const result = await a.generate('When does Zorblat open?');

      expect(providerBlockOf(lastCall())).toContain('Zorblat opens at nine.');
      expect(result.memoryWrite).toBeUndefined();
      // No row is added, and none is rewritten: the call leaves its read of the page on the page's row, and no more.
      const after = await rowsOf(brain);
      expect(after.map(apartFromReads)).toEqual(before.map(apartFromReads));
      expect(after.map((row) => metaOf(row).filedBy)).toEqual(before.map(() => undefined));
    });

    it('an embedding model of another vector size serves the next agent, and the old rows stay out of its index', async () => {
      const first = await open({}, [reply.text('A canary, lovely.'), ...spare()]);
      await writeOf(await first.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.'));
      await closed(first);

      // The host moves to a model of eight values a vector.
      const smallKey = `k-souled-joined-small-${++n}`;
      const small = script('openai', smallKey, { replies: [], dimension: 8 });
      vi.stubEnv('OPENAI_API_KEY', smallKey);
      const again = await open(
        { cognition: { memory: { embedding: { provider: 'openai', model: 'text-embedding-3-small', dimension: 8 } }, mechanisms: false } },
        [reply.text('Hello again.'), reply.text('Tea, noted.'), ...spare()],
      );
      const session = again.session('s2', { userId: 'alice' });
      const record = await writeOf(await session.send('My canary is named LARK-7, remember?'));
      expect(record.entries.map((entry) => entry.outcome)).toEqual(['written', 'written']);
      // One line a load, with the count of the rows of the old size; their text was never sent again.
      expect(lines('memory.vectors_unfit')).toEqual([expect.objectContaining({ rows: 2 })]);
      expect(small.embedded).not.toContain('A canary, lovely.');
      await writeOf(await session.send('I drink tea.'));
      expect(lines('memory.vectors_unfit')).toHaveLength(1);
      // The rows the mind filed: two of the first agent, four of this one. Her key also holds the page the first agent's
      // close compiled, which the mind did not file.
      const rows = (await rowsUnder(storeBrain(again), keyOf('alice'))).filter((row) => metaOf(row).filedBy === 'mind');
      expect(rows).toHaveLength(6);
    });

    it('two sessions of one person sending at once file four rows, each record naming its own two', async () => {
      const { gate, release } = gated();
      const a = await open({}, [
        reply.hold([], gate, reply.text('First reply, noted.')),
        reply.hold([], gate, reply.text('Second reply, noted.')),
        ...spare(),
      ]);
      try {
        const one = a.session('s1', { userId: 'alice' }).send('From the first session.');
        const two = a.session('s2', { userId: 'alice' }).send('From the second session.');
        await vi.waitFor(() => expect(served.seen).toHaveLength(2), { timeout: 4_000 });
        release();
        const records = await Promise.all([one, two].map(async (sent) => writeOf(await sent)));

        const rows = await rowsUnder(storeBrain(a), keyOf('alice'));
        expect(rows).toHaveLength(4);
        expect(rows.every((row) => metaOf(row).filedBy === 'mind')).toBe(true);
        const ids = records.map(writtenIds);
        expect(ids.map((pair) => pair.length)).toEqual([2, 2]);
        expect(new Set(ids.flat())).toEqual(new Set(rows.map((row) => row.id)));
        const contentOf = (id: string) => rows.find((row) => row.id === id)?.content;
        // Each record names its own message first, then a reply; the two replies are the two the model gave.
        expect(contentOf(ids[0][0])).toBe('From the first session.');
        expect(contentOf(ids[1][0])).toBe('From the second session.');
        expect(new Set([contentOf(ids[0][1]), contentOf(ids[1][1])])).toEqual(new Set(['First reply, noted.', 'Second reply, noted.']));
      } finally {
        release();
      }
    });

    it.each<[string, (session: ReturnType<SouledAgent['session']>, stop: AbortController) => Promise<unknown>]>([
      ['whose model call fails', (session) => session.send('My canary is named LARK-7.')],
      ['that session.close() stops', async (session) => {
        const sent = session.send('My canary is named LARK-7.');
        await vi.waitFor(() => expect(served.seen.length).toBeGreaterThan(0), { timeout: 4_000 });
        await session.close();
        return sent;
      }],
      ["that the caller's signal stops", async (session, stop) => {
        const sent = session.send('My canary is named LARK-7.', { abortSignal: stop.signal });
        await vi.waitFor(() => expect(served.seen.length).toBeGreaterThan(0), { timeout: 4_000 });
        stop.abort();
        return sent;
      }],
    ])('a turn %s files neither side, and the next turn files as usual', async (name, run) => {
      const failing = name === 'whose model call fails';
      const a = await open({}, [
        failing ? Object.assign(new Error('bad request'), { httpStatus: 400 }) : reply.hold([], new Promise<void>(() => undefined), reply.text('Never sent.')),
        reply.text('Tea, noted.'),
        ...spare(),
      ]);
      const stop = new AbortController();
      const session = a.session('s1', { userId: 'alice' });
      await expect(run(session, stop)).rejects.toBeDefined();
      expect(await rowsUnder(storeBrain(a), keyOf('alice'))).toEqual([]);

      const next = await a.session('s1', { userId: 'alice' }).send('I drink tea.');
      const record = await writeOf(next);
      const rows = await rowsUnder(storeBrain(a), keyOf('alice'));
      expect(rows.map((row) => row.content)).toEqual(['I drink tea.', 'Tea, noted.']);
      expect(rows.map((row) => metaOf(row).filedBy)).toEqual(['mind', 'mind']);
      expect(writtenIds(record)).toEqual(rows.map((row) => row.id));
    });

    it('a structured send whose answer does not parse files neither side, and the next turn files as usual', async () => {
      const a = await open({}, [reply.text('Lyon'), reply.text('Tea, noted.'), ...spare()]);
      const session = a.session('s1', { userId: 'alice' });
      // Not JSON: the session refuses the reply before its GMI commits the turn, and keeps nothing of the exchange.
      await expect(session.send('Where does my canary LARK-7 live?', { responseSchema: z.object({ city: z.string() }) })).rejects.toBeInstanceOf(ObjectGenerationError);
      expect(session.messages()).toEqual([]);

      const record = await writeOf(await session.send('I drink tea.'));
      // Her writes run one after another: once this turn's two have landed, a filing of the refused turn would have.
      const rows = await rowsUnder(storeBrain(a), keyOf('alice'));
      expect(rows.map((row) => row.content)).toEqual(['I drink tea.', 'Tea, noted.']);
      expect(rows.map((row) => metaOf(row).filedBy)).toEqual(['mind', 'mind']);
      expect(writtenIds(record)).toEqual(rows.map((row) => row.id));
      // The refused reply was never sent to the embedding provider for a filing.
      expect(embeddings.embedded).not.toContain('Lyon');
    });

    it('a structured send repaired inside its turn files the question and the accepted answer once', async () => {
      const a = await open({}, [reply.text('Lyon'), reply.text('{"city":"Lyon"}'), ...spare()]);
      const session = a.session('s1', { userId: 'alice' });
      const question = 'Where does my canary LARK-7 live?';
      // The first answer is not JSON: its repair is a further step of the same turn, which commits on the accepted answer.
      const result = await session.send(question, { responseSchema: z.object({ city: z.string() }), maxValidationRetries: 1 });

      expect(result.object).toEqual({ city: 'Lyon' });
      expect(session.messages()).toEqual([
        { role: 'user', content: question },
        { role: 'assistant', content: '{"city":"Lyon"}' },
      ]);
      const record = await writeOf(result);
      const rows = await rowsUnder(storeBrain(a), keyOf('alice'));
      expect(rows.map((row) => row.content)).toEqual([question, '{"city":"Lyon"}']);
      expect(rows.map((row) => metaOf(row).filedBy)).toEqual(['mind', 'mind']);
      expect(writtenIds(record)).toEqual(rows.map((row) => row.id));
      // The rejected first answer was never sent to the embedding provider for a filing.
      expect(embeddings.embedded).not.toContain('Lyon');
    });

    it('a turn with an empty reply files the user\'s message alone', async () => {
      const a = await open({}, [reply.text(''), ...spare()]);
      const record = await writeOf(await a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.'));
      const rows = await rowsUnder(storeBrain(a), keyOf('alice'));
      expect(rows.map((row) => row.content)).toEqual(['My canary is named LARK-7.']);
      expect(metaOf(rows[0]).filedBy).toBe('mind');
      expect(record).toEqual({ entries: [{ role: 'user', outcome: 'written', traceId: rows[0].id }] });
    });

    it('a reply an onAfterGeneration hook rewrites is filed as the session keeps it', async () => {
      const a = await open(
        { onAfterGeneration: async (step: { text: string }) => ({ ...step, text: step.text.replace('LARK-7', 'your bird') }) },
        [reply.text('Your canary LARK-7, lovely.'), ...spare()],
      );

      const result = await a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.');

      expect(result.text).toBe('Your canary your bird, lovely.');
      const record = await writeOf(result);
      const rows = await rowsUnder(storeBrain(a), keyOf('alice'));
      expect(rows.map((row) => row.content)).toEqual(['My canary is named LARK-7.', 'Your canary your bird, lovely.']);
      expect(writtenIds(record)).toEqual(rows.map((row) => row.id));
      // The model's own words, which the hook took out, were never sent to be embedded for a filing.
      expect(embeddings.embedded).not.toContain('Your canary LARK-7, lovely.');
    });

    it("a reply an onAfterGeneration hook empties files the user's message alone", async () => {
      const a = await open({ onAfterGeneration: async (step: { text: string }) => ({ ...step, text: '' }) }, [reply.text('A canary, lovely.'), ...spare()]);

      const record = await writeOf(await a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.'));

      const rows = await rowsUnder(storeBrain(a), keyOf('alice'));
      expect(rows.map((row) => row.content)).toEqual(['My canary is named LARK-7.']);
      expect(record).toEqual({ entries: [{ role: 'user', outcome: 'written', traceId: rows[0].id }] });
      expect(embeddings.embedded).not.toContain('A canary, lovely.');
    });

    it('a reply an onAfterGeneration hook gives a turn whose model wrote nothing is filed as the session keeps it', async () => {
      const a = await open(
        { onAfterGeneration: async (step: { text: string }) => ({ ...step, text: step.text || 'Your canary is noted.' }) },
        [reply.text(''), ...spare()],
      );

      const result = await a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.');

      expect(result.text).toBe('Your canary is noted.');
      const record = await writeOf(result);
      const rows = await rowsUnder(storeBrain(a), keyOf('alice'));
      expect(rows.map((row) => row.content)).toEqual(['My canary is named LARK-7.', 'Your canary is noted.']);
      expect(record.entries.map((entry) => entry.role)).toEqual(['user', 'assistant']);
      expect(writtenIds(record)).toEqual(rows.map((row) => row.id));
    });

    it("a turn its session's close() stops while an onAfterGeneration hook runs files neither side", async () => {
      let session: { close(): Promise<void> } | undefined;
      let closing: Promise<void> | undefined;
      const a = await open(
        {
          onAfterGeneration: async (step: { text: string }) => {
            closing = session!.close();
            return step;
          },
        },
        [reply.text('A canary, lovely.'), ...spare()],
      );
      const s = a.session('s1', { userId: 'alice' });
      session = s;

      await expect(s.send('My canary is named LARK-7.')).rejects.toThrow();
      await closing;
      // Long enough for a filing the turn had let through to land.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(await rowsUnder(storeBrain(a), keyOf('alice'))).toEqual([]);
    });

    it("a registry row that cannot be written again once the trace is stored leaves the side written, and is the mind's failure", async () => {
      const a = await open({}, [reply.text('A canary, lovely.'), ...spare()]);
      const brain = storeBrain(a);
      const key = keyOf('alice');
      const run = brain.run.bind(brain);
      let registryWrites = 0;
      // The second write of her key's registry row, the one after her message's trace is stored, fails once.
      vi.spyOn(brain, 'run').mockImplementation(((sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO memory_scopes') && Array.isArray(params) && params.includes(key) && ++registryWrites === 2) {
          return Promise.reject(new Error('registry write failed'));
        }
        return run(sql, params as never);
      }) as typeof brain.run);

      const record = await writeOf(await a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.'));

      const rows = await rowsUnder(brain, key);
      expect(rows.map((row) => row.content)).toEqual(['My canary is named LARK-7.', 'A canary, lovely.']);
      expect(record).toEqual({
        entries: [
          { role: 'user', outcome: 'written', traceId: rows[0].id },
          { role: 'assistant', outcome: 'written', traceId: rows[1].id },
        ],
      });
      const failures = lines('memory.hook_failed').filter((line) => line.hook === 'soulMemory');
      expect(failures).toHaveLength(1);
      expect(JSON.stringify(failures)).not.toMatch(/LARK-7|registry write failed/);
    });

    it("a turn filed at a time its key's last compile read past is compiled by the next compile", async () => {
      const a = await open();
      const key = keyOf('alice');
      const session = a.session('s1', { userId: 'alice' });
      await writeOf(await session.send('My canary is named LARK-7.'));
      await a.memory!.compileWiki({ scopes: [key] });
      const compiledAt = (await a.memory!.listScopes()).find((row) => row.scopeId === key)?.compiledAt;
      expect(typeof compiledAt).toBe('number');

      // The clock is set back to the watermark: the next turn's two rows are stamped at a time the compile read past.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(compiledAt as number);
      try {
        await writeOf(await session.send('My canary sings at dawn.'));
      } finally {
        clock.mockRestore();
      }
      const before = merges().length;
      await a.memory!.compileWiki({ scopes: [key] });

      expect(merges()).toHaveLength(before + 1);
      expect(JSON.stringify(merges().at(-1)!.messages)).toContain('sings at dawn');
    });

    it('a session whose user id no memory key can be built from files nothing', async () => {
      const managers = managersBuilt();
      const a = await open({}, [reply.text('Hello.'), ...spare()]);
      const brain = storeBrain(a);
      const before = await rowsOf(brain);

      const result = await a.session('s1', { userId: 'odd\uD800id' }).send('My canary is named LARK-7.');

      expect(result.text).toBe('Hello.');
      expect(await writeOf(result)).toEqual({
        entries: [
          { role: 'user', outcome: 'skipped', reason: 'no_subject' },
          { role: 'assistant', outcome: 'skipped', reason: 'no_subject' },
        ],
      });
      expect(await rowsOf(brain)).toEqual(before);
      // The mind holds nothing of the turn either.
      for (const manager of managers()) expect(manager.getStore().listTraces()).toEqual([]);
    });

    it("close() waits for the mind's writes, and the soul's store is closed once", async () => {
      const { gate, release } = gated();
      const a = await open({ pendingWritesTimeoutMs: 10_000 }, [
        reply.hold([], gate, reply.text('Alice keeps a canary named LARK-7.')),
        reply.text('In the attic, noted.'),
        ...spare(),
      ]);
      try {
        const brain = storeBrain(a);
        const brainClose = vi.spyOn(brain, 'close');
        const shutDown = vi.spyOn(CognitiveMemoryManager.prototype, 'shutdown');
        // Something of hers for a compile to fold: its model call holds her chain, and her writes wait behind it.
        await a.memory!.remember('Alice keeps a canary named LARK-7.', { type: 'episodic', scope: 'conversation', scopeId: keyOf('alice') });
        const compiling = a.memory!.compileWiki({ scopes: [keyOf('alice')] });
        await vi.waitFor(() => expect(served.seen).toHaveLength(1), { timeout: 4_000 });

        const result = await a.session('s1', { userId: 'alice' }).send('I keep it in the attic.');
        expect(result.text).toBe('In the attic, noted.');
        const write = writeOf(result);
        expect(await settledWithin(write, 200)).toBe(false);

        ownClose(a);
        const closing = a.close();
        // The mind's memory does not shut down while the mind's writes wait.
        expect(await settledWithin(closing, 300)).toBe(false);
        expect(shutDown).not.toHaveBeenCalled();
        release();
        await compiling;
        await closing;

        const record = await write;
        expect(record.entries.map((entry) => entry.outcome)).toEqual(['written', 'written']);
        expect(shutDown).toHaveBeenCalled();
        expect(brainClose).toHaveBeenCalledTimes(1);
      } finally {
        release();
      }
    });

    it('a memory that does not build fails the turn, and the next turn builds it again', async () => {
      const a = await open({}, [reply.text('Tea, noted.'), ...spare()]);
      embeddings.initThrows = new Error('embedding provider unavailable');

      await expect(a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.')).rejects.toThrow(/memory\.embedding/);
      expect(await rowsUnder(storeBrain(a), keyOf('alice'))).toEqual([]);

      embeddings.initThrows = undefined;
      const record = await writeOf(await a.session('s1', { userId: 'alice' }).send('I drink tea.'));
      expect(record.entries.map((entry) => entry.outcome)).toEqual(['written', 'written']);
      const rows = await rowsUnder(storeBrain(a), keyOf('alice'));
      expect(rows.map((row) => metaOf(row).filedBy)).toEqual(['mind', 'mind']);
    });
  });
});
