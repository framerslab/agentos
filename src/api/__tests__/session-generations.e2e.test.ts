/**
 * @file session-generations.e2e.test.ts
 * What a gmi() session id recalls under `memory.store` across `session.close()`, `agent.close()` and a restart, driven
 * through the package root (`@framers/agentos`) the way a host imports it, on a SQLite file and on CI's Postgres, each
 * process through an adapter of its own. The model is the repository's stub provider (helpers/stubProviders.ts): no
 * network and no vendor key.
 *
 * A session id's memory survives `agent.close()` and a restart. `session.close()` ends it for good: the id's next
 * opening, on this agent, after a restart or in another process, files and recalls under a scope id of its own, and
 * what the closed session filed stays in the store under the closed session's. Two processes that close one opening
 * of an id land on one next generation, and a close of an opening already ended changes nothing. An id no close has
 * ended files under its plain session form, as a file written before generations were recorded holds it, and
 * `forgetUser` reaches what a user's session filed in each of its generations.
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
import { gmi, type Agent, type AgentSession } from '@framers/agentos';
import { LEARNING_TABLES, taggedScopeId } from '@framers/agentos/cognition/learning/index';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import Database from 'better-sqlite3';
import { reply, script } from './helpers/stubProviders';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;

/** A stub key no other case of the file uses: the stub provider keeps one script per key. */
let keys = 0;
const key = () => `k-session-gen-${++keys}`;

/** What person A tells session `x`, and the word that shows it was recalled. */
const A_LINE = 'The deploy key lives in the vault under ops/deploy.';
const A_WORD = 'vault';
/** What person B tells session `x` once it is handed over, and its word. */
const B_LINE = 'The deploy key lives in the locker under ops/keys.';
const B_WORD = 'locker';
const QUESTION = 'Where does the deploy key live?';

/** One durable store a test's processes share. */
interface SharedStore {
  /** `memory.store` for one process: the SQLite file, which agentos opens, or a Postgres adapter of the process's own. */
  forProcess(): Promise<unknown>;
  /** The learning option of every process: the agent's key, and on Postgres a namespace of the test's own. */
  learning: { agentKey: string; namespace?: string };
  /** The namespace the scope ids are written under. */
  namespace: string;
  /** The text of the agent's live traces, read by a connection of the test's own. */
  liveTexts(): Promise<string[]>;
  /** The scope ids of the live `user`-scope traces that hold `text`. */
  userScopeIdsOf(text: string): Promise<string[]>;
  /** The session generation records of the agent's brain (`brain_meta`). */
  generationRecords(): Promise<Array<{ key: string; value: string }>>;
  /** Removes what the test wrote; every process is closed first. */
  close(): Promise<void>;
}

const GENERATION_RECORDS = "SELECT key, value FROM brain_meta WHERE brain_id = ? AND key LIKE 'session_generation:%' ORDER BY key";
const LIVE_TEXTS = 'SELECT content FROM memory_traces WHERE brain_id = ? AND deleted = 0 ORDER BY content';
const USER_SCOPE_IDS = "SELECT DISTINCT scope_id FROM memory_traces WHERE brain_id = ? AND scope = 'user' AND content = ? AND deleted = 0 ORDER BY scope_id";

/** A SQLite file in a directory of its own; every process opens the file through agentos. */
async function sqliteStore(): Promise<SharedStore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-generations-'));
  const file = path.join(dir, 'agent.sqlite');
  const brainId = 'tutor';
  const rows = <T>(sql: string, params: unknown[]): T[] => {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      return db.prepare(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  };
  return {
    forProcess: async () => ({ path: file }),
    learning: { agentKey: brainId },
    namespace: '',
    liveTexts: async () => rows<{ content: string }>(LIVE_TEXTS, [brainId]).map((row) => row.content),
    userScopeIdsOf: async (text) => rows<{ scope_id: string }>(USER_SCOPE_IDS, [brainId, text]).map((row) => row.scope_id),
    generationRecords: async () => rows<{ key: string; value: string }>(GENERATION_RECORDS, [brainId]),
    close: async () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** CI's Postgres: a brain id and a namespace of the test's own; each process opens an adapter of its own. */
async function postgresStore(): Promise<SharedStore> {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const brainId = `session-gen-${run}`;
  const adapters: StorageAdapter[] = [];
  const open = async (): Promise<StorageAdapter> => {
    const adapter = createPostgresAdapter({ connectionString: POSTGRES_URL!, typeParsers: { int8: 'number' } });
    await adapter.open();
    adapters.push(adapter);
    return adapter;
  };
  const reader = await open();
  return {
    forProcess: async () => ({ adapter: await open(), brainId }),
    learning: { agentKey: `session-gen-tutor-${run}`, namespace: run },
    namespace: run,
    liveTexts: async () => (await reader.all<{ content: string }>(LIVE_TEXTS, [brainId])).map((row) => row.content),
    userScopeIdsOf: async (text) => (await reader.all<{ scope_id: string }>(USER_SCOPE_IDS, [brainId, text])).map((row) => row.scope_id),
    generationRecords: async () => reader.all<{ key: string; value: string }>(GENERATION_RECORDS, [brainId]),
    close: async () => {
      for (const table of ['memory_traces', 'brain_meta']) await reader.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brainId]).catch(() => undefined);
      for (const table of LEARNING_TABLES) await reader.run(`DELETE FROM ${table} WHERE namespace = ?`, [run]).catch(() => undefined);
      for (const adapter of adapters.splice(0)) await adapter.close().catch(() => undefined);
    },
  };
}

/** The cases, on one kind of store. */
function sessionGenerationCases(openStore: () => Promise<SharedStore>): void {
  const agents: Agent[] = [];
  const stores: SharedStore[] = [];

  afterEach(async () => {
    for (const opened of agents.splice(0)) await opened.close().catch(() => undefined);
    for (const store of stores.splice(0)) await store.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** A store for the test, the console quiet, and memory's embeddings on a stub key of their own. */
  async function setUp(): Promise<SharedStore> {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const embeddingKey = key();
    script('openai', embeddingKey, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', embeddingKey);
    const store = await openStore();
    stores.push(store);
    return store;
  }

  /** The model's script: `count` turns, each answered `Noted.`, which names neither person's word. */
  function model(count: number) {
    const apiKey = key();
    const played = script('openai', apiKey, { replies: Array.from({ length: count }, () => reply.text('Noted.')) });
    return { apiKey, asked: () => JSON.stringify(played.seen.at(-1)?.messages ?? []) };
  }

  /** One process: gmi() named `Tutor`, memory with no mechanisms on the shared store. */
  async function processOn(store: SharedStore, apiKey: string): Promise<Agent> {
    const opened = gmi({
      runtime: 'gmi',
      provider: 'openai',
      model: 'stub-model',
      apiKey,
      fallbackProviders: [],
      name: 'Tutor',
      instructions: 'You teach networking.',
      cognition: { mechanisms: false },
      memory: { embedding: { provider: 'openai' }, store: await store.forProcess() },
      learning: store.learning,
    } as never);
    agents.push(opened);
    return opened;
  }

  it('recalls what the person the id was handed to filed, and never what the closed session filed, once the agent restarts', async () => {
    const store = await setUp();
    const { apiKey, asked } = model(3);

    const first = await processOn(store, apiKey);
    const a = first.session('x');
    await a.send(A_LINE);
    await a.close();
    // The host hands x to person B, who files on it.
    await first.session('x').send(B_LINE);
    expect(asked()).not.toContain(A_WORD);
    await first.close();

    const second = await processOn(store, apiKey);
    await second.session('x').send(QUESTION);
    expect(asked()).toContain(B_WORD);
    expect(asked()).not.toContain(A_WORD);
    await second.close();
    // The closed session's trace stays in the store, under its own scope id.
    expect(await store.liveTexts()).toContain(A_LINE);
    expect(await store.userScopeIdsOf(A_LINE)).not.toEqual(await store.userScopeIdsOf(B_LINE));
  });

  it('recalls what a session filed after a restart with no close, from a process that never closed anything', async () => {
    const store = await setUp();
    const { apiKey, asked } = model(2);

    // The first process stops without closing its session or itself, as a crash leaves it.
    const crashed = await processOn(store, apiKey);
    await crashed.session('x').send(A_LINE);

    const restarted = await processOn(store, apiKey);
    await restarted.session('x').send(QUESTION);
    expect(asked()).toContain(A_WORD);
  });

  it('recalls nothing a closed session filed when the same agent opens its id again, nor after agent.close() and a restart', async () => {
    const store = await setUp();
    const { apiKey, asked } = model(3);

    const first = await processOn(store, apiKey);
    const a = first.session('x');
    await a.send(A_LINE);
    await a.close();
    await first.session('x').send(QUESTION);
    expect(asked()).not.toContain(A_WORD);
    // The reopened session stays open: agent.close() ends no session's memory.
    await first.close();

    const second = await processOn(store, apiKey);
    await second.session('x').send(QUESTION);
    expect(asked()).not.toContain(A_WORD);
    await second.close();
    expect(await store.liveTexts()).toContain(A_LINE);
  });

  it('lands two processes that close one opening of an id at once on one next generation, which a later close of that opening leaves open', async () => {
    const store = await setUp();
    const { apiKey, asked } = model(5);

    // Three processes open x before anyone closes it, and each files on it. Each opens its store in turn, as three
    // processes started one after another do: two SQLite connections in one Node process cannot wait on each other.
    const sessions: AgentSession[] = [];
    for (let started = 0; started < 3; started += 1) {
      const session = (await processOn(store, apiKey)).session('x');
      await session.send(A_LINE);
      sessions.push(session);
    }
    const [s1, s2, s3] = sessions as [AgentSession, AgentSession, AgentSession];

    await Promise.all([s1.close(), s2.close()]);
    const records = await store.generationRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.key).toBe(`session_generation:${taggedScopeId('x', store.namespace)}`);
    expect(JSON.parse(records[0]!.value)).toMatchObject({ generation: 1 });

    // A fourth process opens x after the closes, and person B files on it.
    const four = await processOn(store, apiKey);
    await four.session('x').send(B_LINE);
    expect(asked()).not.toContain(A_WORD);

    // The third process's session opened the generation the first two ended: its close ends nothing more.
    await s3.close();
    expect(await store.generationRecords()).toEqual(records);

    const five = await processOn(store, apiKey);
    await five.session('x').send(QUESTION);
    expect(asked()).toContain(B_WORD);
    expect(asked()).not.toContain(A_WORD);
  });

  it("recalls on open what a file holds under an id's plain session form with no generation record, and its first session.close() ends it across a restart", async () => {
    const store = await setUp();
    const { apiKey, asked } = model(3);

    const first = await processOn(store, apiKey);
    await first.session('x').send(A_LINE);
    await first.close();
    // What a file written before generations were recorded holds: the trace under the id's plain session form, no record.
    expect(await store.userScopeIdsOf(A_LINE)).toEqual([taggedScopeId('x', store.namespace)]);
    expect(await store.generationRecords()).toEqual([]);

    const second = await processOn(store, apiKey);
    const opened = second.session('x');
    await opened.send(QUESTION);
    expect(asked()).toContain(A_WORD);
    await opened.close();
    await second.close();

    const third = await processOn(store, apiKey);
    await third.session('x').send(QUESTION);
    expect(asked()).not.toContain(A_WORD);
  });

  it("deletes with forgetUser what a user's session filed in each of its generations, across a close and a restart", async () => {
    const store = await setUp();
    const { apiKey } = model(2);

    const first = await processOn(store, apiKey);
    const a = first.session('x', { userId: 'ana' });
    await a.send(A_LINE);
    await a.close();
    await first.close();

    const second = await processOn(store, apiKey);
    await second.session('x', { userId: 'ana' }).send(B_LINE);
    await second.learning!.forgetUser!('ana');
    await second.close();

    const live = await store.liveTexts();
    expect(live.filter((text) => text.includes(A_WORD) || text.includes(B_WORD))).toEqual([]);
  });
}

describe('a gmi() session id under memory.store, on a SQLite file', () => {
  sessionGenerationCases(sqliteStore);
});

describe.skipIf(!POSTGRES_URL)("a gmi() session id under memory.store, on CI's Postgres, each process through an adapter of its own", () => {
  sessionGenerationCases(postgresStore);
});
