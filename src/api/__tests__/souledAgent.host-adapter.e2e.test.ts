/**
 * A souled agent whose store lives on the host's own adapter (`soulStore: { adapter }`), end to end over the real
 * souledAgent(), agent, generateText, provider manager, Memory store and forgotten-user ledger; only the OpenAI
 * provider class is stubbed (helpers/stubProviders.ts), at its module boundary. The SQLite adapters are opened by the
 * test, as a host opens its own; the PostgreSQL cases run where AGENTOS_TEST_POSTGRES_URL is set, each in a schema of
 * its own.
 *
 * - Each person files and recalls their own turns in the host's database, nothing is written under `memory/.store/`,
 *   and a deletion of one person leaves the other's rows.
 * - An open with no `tombstoneCopy`, with a copy on the store's own adapter, on a database that holds another agent's
 *   memory, or beside a store file left in `memory/.store/` is refused, and the host's adapter stays open and usable.
 *   Another agent's database is refused before anything is written to it; a refusal for any other reason takes
 *   nothing back from the database.
 * - A `tombstoneCopy` whose `adapter` key holds no adapter is refused even beside a `path`: the open would read it as
 *   an adapter's and run with no second copy.
 * - A store on the host's adapter needs `retention` and `tombstoneKey` unless `sharedMemory` makes it one person's: the
 *   agent counts the people it holds memory of in its own process, and other processes serve the same database.
 * - `close()` leaves the host's adapters open, and a SQLite adapter deletes securely. A write that reaches the store
 *   once the agent is closed is not stored, though the adapter it would run on is still open.
 * - A PostgreSQL adapter that reads BIGINT as text is refused before anything opens.
 * - Two agents opened at once on one empty database: at least one open is refused, and the database is left holding
 *   one agent's rows at most. On PostgreSQL, a retention sweep of one person, a deletion of another and a third's turn
 *   run at once on one adapter: each leaves the rows it should, and the agent's transactions on the adapter run one
 *   at a time.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import { createPostgresAdapter, resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

/** The runtime every case runs on. */
const RUNTIME = 'legacy' as const;

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
/** This run's own mark, in the names of the schemas its PostgreSQL cases make and drop. */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** The schemas this run's PostgreSQL cases made. */
const schemas: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;
/** The refusal of a database that holds another agent's memory. */
const ANOTHER_AGENT = /soulStore[\s\S]*another agent/;

let n = 0;
let dir: string;
const opened: SouledAgent[] = [];
const adapters: StorageAdapter[] = [];
/** Every line the library logged in the test, parsed. */
let events: Array<Record<string, unknown>>;
beforeEach(() => {
  globalLLMProviderHealth.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-host-adapter-e2e-'));
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
});
afterEach(async () => {
  vi.restoreAllMocks();
  while (opened.length) await opened.pop()!.close().catch(() => undefined);
  while (adapters.length) await adapters.pop()!.close().catch(() => undefined);
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

/** A soul folder of its own for the agent `agentId`. */
function soulOf(agentId: string): string {
  const folder = path.join(dir, agentId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SOUL.md'), `---\nname: ${agentId}\nagentId: ${agentId}\n---\nYou are ${agentId}.`);
  return folder;
}
/** The store file a souled agent with no `soulStore` keeps in its soul folder. */
const storeFileOf = (agentId: string) => path.join(dir, agentId, 'memory', '.store', 'memory.sqlite');
/** A tombstone copy on a SQLite file of the test's own, outside the store. */
const copyAt = (name: string) => ({ path: path.join(dir, `${name}.forgotten.sqlite`) });

/** A SQLite adapter on a file of the test's folder, opened as a host opens its own. */
async function sqliteAdapter(name = 'host.sqlite'): Promise<StorageAdapter> {
  const adapter = await resolveStorageAdapter({ filePath: path.join(dir, name), priority: ['better-sqlite3', 'sqljs'], quiet: true });
  adapters.push(adapter);
  return adapter;
}
/** The name of a new schema of this run's own, dropped once the cases have run. */
function newSchema(): string {
  const schema = `souled_host_adapter_${RUN}_${schemas.length}`;
  schemas.push(schema);
  return schema;
}
/** A PostgreSQL adapter whose tables go in `schema`; it reads BIGINT as numbers unless `bigintAsText`. */
async function postgresAdapter(schema: string, bigintAsText = false): Promise<StorageAdapter> {
  const adapter = createPostgresAdapter({
    connectionString: POSTGRES_URL!,
    segment: schema,
    max: 5,
    ...(bigintAsText ? {} : { typeParsers: { int8: 'number' as const } }),
  });
  await adapter.open();
  adapters.push(adapter);
  return adapter;
}

/** What {@link countingTransactions} saw: the transactions opened on the adapter, and the most that were open at once. */
interface TransactionCount {
  started: number;
  mostAtOnce: number;
}
/**
 * `adapter` with its transactions counted. Each transaction opened through the returned handle is held for a moment
 * before its statements run, so two opened together overlap, and the count keeps the most that were open at once.
 * Every other call reaches the adapter as it is.
 */
function countingTransactions(adapter: StorageAdapter): { adapter: StorageAdapter; count: TransactionCount } {
  const count: TransactionCount = { started: 0, mostAtOnce: 0 };
  let open = 0;
  const transaction = async <T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> => {
    count.started += 1;
    open += 1;
    count.mostAtOnce = Math.max(count.mostAtOnce, open);
    try {
      return await adapter.transaction(async (trx) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return fn(trx);
      });
    } finally {
      open -= 1;
    }
  };
  const counted = new Proxy(adapter, {
    get(target, property) {
      if (property === 'transaction') return transaction;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { adapter: counted, count };
}

/**
 * `adapter` with its statements recorded: the SQL of each read (`get`, `all`) and of everything else (`run`, `exec`,
 * and `transaction`, recorded as `BEGIN`). Every call reaches the adapter as it is.
 */
function recordingStatements(adapter: StorageAdapter): { adapter: StorageAdapter; read: string[]; written: string[] } {
  const read: string[] = [];
  const written: string[] = [];
  const recorded = new Proxy(adapter, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const call = (value as (...args: unknown[]) => unknown).bind(target);
      const into =
        property === 'get' || property === 'all'
          ? read
          : property === 'run' || property === 'exec' || property === 'transaction'
            ? written
            : undefined;
      if (!into) return call;
      return (...args: unknown[]) => {
        into.push(property === 'transaction' ? 'BEGIN' : String(args[0]));
        return call(...args);
      };
    },
  });
  return { adapter: recorded, read, written };
}

/** A souled agent on the stubbed provider that may keep several people's memory. */
async function open(agentId: string, extra: Partial<SouledAgentOptions> = {}): Promise<{ a: SouledAgent; s: ProviderScript }> {
  const apiKey = `k-souled-host-adapter-${++n}`;
  const s = script('openai', apiKey, { whole: true, replies: Array.from({ length: 40 }, (_, i) => reply.text(`Noted ${n}-${i}.`)) });
  const a = await souledAgent({
    runtime: RUNTIME,
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    soul: soulOf(agentId),
    retention: { traces: 'until-deletion' },
    tombstoneKey: 'k-souled-host-adapter',
    ...extra,
  } as unknown as SouledAgentOptions);
  opened.push(a);
  return { a, s };
}
/** Closes an agent the case is done with, before the next open on the same database. */
async function closed(a: SouledAgent): Promise<void> {
  opened.splice(opened.indexOf(a), 1);
  await a.close();
}

const userKey = (id: string) => conversationScopeKey('aria-1', { kind: 'user', id });
/** The live conversation traces of agent aria-1 under one key, read through the host's adapter. */
const tracesUnder = (adapter: StorageAdapter, key: string) =>
  adapter.all<{ id: string; content: string }>(
    "SELECT id, content FROM memory_traces WHERE brain_id = ? AND scope = 'conversation' AND scope_id = ? AND deleted = 0",
    ['aria-1', key],
  );
/** The brain ids the database's `brain_meta` holds, sorted; none while the table does not exist. */
async function brainsIn(adapter: StorageAdapter): Promise<string[]> {
  let rows: Array<{ brain_id: string }>;
  try {
    rows = await adapter.all<{ brain_id: string }>('SELECT DISTINCT brain_id FROM brain_meta');
  } catch {
    return [];
  }
  return rows.map((row) => row.brain_id).sort();
}
/** The host's adapter still answers. */
async function answers(adapter: StorageAdapter): Promise<void> {
  expect(Number((await adapter.get<{ n: number | string }>('SELECT 1 AS n'))?.n)).toBe(1);
}

/** One turn of a user, and a wait until both of its traces (the user's text and the reply) are stored. */
async function turn(a: SouledAgent, adapter: StorageAdapter, sessionId: string, userId: string, text: string): Promise<void> {
  const before = (await tracesUnder(adapter, userKey(userId))).length;
  await a.session(sessionId, { userId }).send(text);
  await vi.waitFor(async () => expect((await tracesUnder(adapter, userKey(userId))).length).toBeGreaterThanOrEqual(before + 2), {
    timeout: 8_000,
  });
}

/** The recall block one model call was sent: the user-role message that opens with `<memory_recall>`; none when the turn recalled nothing. */
const recallBlockIn = (call: ProviderScript['seen'][number]): string => {
  const block = call.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<memory_recall>'));
  return block ? (block.content as unknown as string) : '';
};

/**
 * Two people on agent aria-1 with its store on `adapter`: each files and recalls their own turns there, a deletion of
 * one leaves the other's rows, and a new agent on the same adapter recalls what is left.
 */
async function keepsEachPersonsMemory(adapter: StorageAdapter): Promise<void> {
  const { a, s } = await open('aria-1', { soulStore: { adapter }, tombstoneCopy: copyAt('aria') });
  await turn(a, adapter, 's1', 'alice', 'My canary is LARK-7.');
  await turn(a, adapter, 's2', 'bob', 'My canary is WREN-2.');
  // The store is the host's database: nothing is written under memory/.store/.
  expect(fs.existsSync(storeFileOf('aria-1'))).toBe(false);
  expect(JSON.stringify(await tracesUnder(adapter, userKey('alice')))).toContain('LARK-7');
  expect(JSON.stringify(await tracesUnder(adapter, userKey('bob')))).toContain('WREN-2');

  await a.session('s3', { userId: 'alice' }).send('What is my canary?');
  expect(recallBlockIn(s.seen.at(-1)!)).toContain('LARK-7');
  expect(recallBlockIn(s.seen.at(-1)!)).not.toContain('WREN-2');
  await a.session('s4', { userId: 'bob' }).send('What is my canary?');
  expect(recallBlockIn(s.seen.at(-1)!)).toContain('WREN-2');
  expect(recallBlockIn(s.seen.at(-1)!)).not.toContain('LARK-7');

  expect((await a.forgetUser!('alice')).complete).toBe(true);
  await closed(a);
  await answers(adapter);
  expect(await tracesUnder(adapter, userKey('alice'))).toEqual([]);
  expect(JSON.stringify(await adapter.all('SELECT content FROM memory_traces WHERE brain_id = ?', ['aria-1']))).not.toContain('LARK-7');
  expect(JSON.stringify(await tracesUnder(adapter, userKey('bob')))).toContain('WREN-2');

  // The memory outlives the agent: the next one on the same database recalls what is left.
  const { a: again, s: next } = await open('aria-1', { soulStore: { adapter }, tombstoneCopy: copyAt('aria') });
  await again.session('s5', { userId: 'bob' }).send('What is my canary?');
  expect(recallBlockIn(next.seen.at(-1)!)).toContain('WREN-2');
  await again.session('s6', { userId: 'alice' }).send('What is my canary?');
  expect(recallBlockIn(next.seen.at(-1)!)).not.toContain('LARK-7');
}

/**
 * Two agents with different ids opened at once on one empty database, through `first` and `second`: at least one open
 * is refused, both adapters still answer, and the database holds the brain of the agent that opened, or none.
 */
async function refusesOneOfTwoAtOnce(first: StorageAdapter, second: StorageAdapter): Promise<void> {
  const ids = ['aria-1', 'juno-2'] as const;
  const outcomes = await Promise.allSettled([
    open(ids[0], { soulStore: { adapter: first }, tombstoneCopy: copyAt(ids[0]) }),
    open(ids[1], { soulStore: { adapter: second }, tombstoneCopy: copyAt(ids[1]) }),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'rejected').length).toBeGreaterThanOrEqual(1);
  await answers(first);
  await answers(second);
  const survivors = ids.filter((_, at) => outcomes[at].status === 'fulfilled');
  // A refused open leaves no row of its own behind: the agent that opened is the database's one agent.
  expect(await brainsIn(first)).toEqual(survivors);
}

describe(`a souled agent's store on the host's adapter, on runtime ${RUNTIME}`, () => {
  it("keeps each person's memory on the host's SQLite adapter, and a deletion of one leaves the other's", async () => {
    await keepsEachPersonsMemory(await sqliteAdapter());
  });

  it("refuses each bad open and leaves the host's adapter open", async () => {
    const adapter = await sqliteAdapter();

    // No tombstone copy: the default copy is a file on one machine, and a store on an adapter usually serves several.
    await expect(open('aria-1', { soulStore: { adapter } })).rejects.toThrow(TypeError);
    await expect(open('aria-1', { soulStore: { adapter } })).rejects.toThrow(/tombstoneCopy/);
    // A copy option that names neither a file nor an adapter is no copy either: the store never opens with none.
    await expect(open('aria-1', { soulStore: { adapter }, tombstoneCopy: {} as never })).rejects.toThrow(TypeError);
    await expect(open('aria-1', { soulStore: { adapter }, tombstoneCopy: { adapter: undefined } as never })).rejects.toThrow(TypeError);
    await expect(open('aria-1', { soulStore: { adapter }, tombstoneCopy: { path: '' } })).rejects.toThrow(TypeError);
    await answers(adapter);
    expect(await brainsIn(adapter)).toEqual([]);

    // A copy on the store's own adapter is no second copy.
    const own = await sqliteAdapter('own.sqlite');
    await expect(open('aria-1', { soulStore: { adapter: own }, tombstoneCopy: { adapter: own } })).rejects.toMatchObject({ code: 'COPY_UNAVAILABLE' });
    await answers(own);
    // The database is still this agent's: the refused open took back nothing, so an open of the same agent that is
    // live on it at that moment keeps the rows of its brain. The agent opens there once its copy is a second one.
    expect(await brainsIn(own)).toEqual(['aria-1']);
    const { a: retried } = await open('aria-1', { soulStore: { adapter: own }, tombstoneCopy: copyAt('own') });
    await closed(retried);

    // A database that holds another agent's memory: the tombstone ledger is database-wide.
    const { a: other } = await open('juno-2', { soulStore: { adapter }, tombstoneCopy: copyAt('juno') });
    await other.session('j1', { userId: 'carol' }).send('My canary is TERN-4.');
    await closed(other);
    await answers(adapter);
    const statements = recordingStatements(adapter);
    await expect(open('aria-1', { soulStore: { adapter: statements.adapter }, tombstoneCopy: copyAt('aria') })).rejects.toThrow(ANOTHER_AGENT);
    await answers(adapter);
    expect(await brainsIn(adapter)).toEqual(['juno-2']);
    // Refused before anything opened: the other agent's database was read and never written, no transaction was
    // opened on it, and no copy file was made for the refused agent.
    expect(statements.written).toEqual([]);
    expect(statements.read.length).toBeGreaterThan(0);
    expect(fs.existsSync(copyAt('aria').path)).toBe(false);
    // The agent whose database it is opens again.
    const { a: owner } = await open('juno-2', { soulStore: { adapter }, tombstoneCopy: copyAt('juno') });
    await closed(owner);

    // A store file left in memory/.store/: the memory it holds would be out of reach of every call on the new store.
    const { a: onFile } = await open('kira-3');
    await onFile.session('k1', { userId: 'dana' }).send('My canary is SWIFT-9.');
    await closed(onFile);
    expect(fs.existsSync(storeFileOf('kira-3'))).toBe(true);
    const fresh = await sqliteAdapter('fresh.sqlite');
    await expect(open('kira-3', { soulStore: { adapter: fresh }, tombstoneCopy: copyAt('kira') })).rejects.toThrow(storeFileOf('kira-3'));
    await answers(fresh);
    // Refused before anything opened: no table was made on the host's adapter, and no copy file.
    expect(await fresh.all("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([]);
    expect(fs.existsSync(copyAt('kira').path)).toBe(false);
  });

  it("closes nothing of the host's: close() leaves its adapters open, and a SQLite adapter deletes securely", async () => {
    const adapter = await sqliteAdapter();
    const copy = await sqliteAdapter('copy.sqlite');
    await adapter.exec('PRAGMA secure_delete = OFF');
    const { a } = await open('aria-1', { soulStore: { adapter }, tombstoneCopy: { adapter: copy } });
    await turn(a, adapter, 's1', 'alice', 'My canary is LARK-7.');
    expect(Number(Object.values((await adapter.get<Record<string, number>>('PRAGMA secure_delete'))!)[0])).toBe(1);
    await closed(a);

    await answers(adapter);
    await answers(copy);
    // The host goes on using its database: the store's rows are there to read, and a write lands.
    expect(JSON.stringify(await tracesUnder(adapter, userKey('alice')))).toContain('LARK-7');
    await adapter.exec('CREATE TABLE host_owned (id INTEGER)');
    await adapter.run('INSERT INTO host_owned (id) VALUES (?)', [1]);
    expect(await adapter.all('SELECT id FROM host_owned')).toEqual([{ id: 1 }]);
  });

  it('refuses a PostgreSQL adapter that reads BIGINT as text, before anything opens', async () => {
    const statements: string[] = [];
    const record = (sql: string) => {
      statements.push(sql);
    };
    const textIntegers = {
      kind: 'postgres',
      capabilities: new Set(['transactions']),
      open: async () => undefined,
      close: async () => undefined,
      get: async (sql: string) => {
        record(sql);
        return { n: '1' };
      },
      all: async (sql: string) => {
        record(sql);
        return [];
      },
      run: async (sql: string) => {
        record(sql);
        return { changes: 0 };
      },
      exec: async (sql: string) => {
        record(sql);
      },
      transaction: async () => {
        throw new Error('no transaction was expected');
      },
    } as unknown as StorageAdapter;

    await expect(open('aria-1', { soulStore: { adapter: textIntegers }, tombstoneCopy: copyAt('aria') })).rejects.toThrow(
      /soulStore[\s\S]*typeParsers: \{ int8: 'number' \}/,
    );
    // The probe is the one statement the refused adapter ran, and no copy file was made.
    expect(statements).toHaveLength(1);
    expect(fs.existsSync(copyAt('aria').path)).toBe(false);
    expect(fs.existsSync(storeFileOf('aria-1'))).toBe(false);
  });

  it('refuses at least one of two agents opened at once on one empty SQLite database', async () => {
    // Two connections on one file, as two processes hold them.
    await refusesOneOfTwoAtOnce(await sqliteAdapter('shared.sqlite'), await sqliteAdapter('shared.sqlite'));
  });

  it('refuses a tombstoneCopy whose adapter key holds no adapter, even beside a path, before anything opens', async () => {
    const adapter = await sqliteAdapter();
    const beside = copyAt('aria').path;

    // The open reads an option that has an `adapter` key as an adapter's, whatever else it holds: with none there,
    // the store would open with no second copy of its tombstones, though a path was named.
    await expect(open('aria-1', { soulStore: { adapter }, tombstoneCopy: { path: beside, adapter: undefined } as never })).rejects.toThrow(TypeError);
    await expect(open('aria-1', { soulStore: { adapter }, tombstoneCopy: { path: beside, adapter: null } as never })).rejects.toThrow(/tombstoneCopy/);
    await answers(adapter);
    // Refused before anything opened: no table on the host's adapter, and no copy file.
    expect(await adapter.all("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([]);
    expect(fs.existsSync(beside)).toBe(false);

    // An option that holds an adapter is an adapter's, with or without a path beside it.
    const copy = await sqliteAdapter('copy.sqlite');
    const { a } = await open('aria-1', { soulStore: { adapter }, tombstoneCopy: { path: beside, adapter: copy } as never });
    await closed(a);
    expect(fs.existsSync(beside)).toBe(false);
    await answers(copy);
  });

  it("needs retention and tombstoneKey on the host's adapter, unless sharedMemory makes the store one person's", async () => {
    const adapter = await sqliteAdapter();
    const onHost = { soulStore: { adapter }, tombstoneCopy: copyAt('aria') };

    // The agent counts the people it holds memory of in its own process. A store in the host's database is served by
    // several processes, and each would let its own first person in with no retention period and no tombstone key.
    await expect(open('aria-1', { ...onHost, retention: undefined })).rejects.toThrow(TypeError);
    await expect(open('aria-1', { ...onHost, retention: undefined })).rejects.toThrow(/soulStore[\s\S]*retention/);
    await expect(open('aria-1', { ...onHost, tombstoneKey: undefined })).rejects.toThrow(TypeError);
    await expect(open('aria-1', { ...onHost, tombstoneKey: undefined })).rejects.toThrow(/soulStore[\s\S]*tombstoneKey/);
    await expect(open('aria-1', { ...onHost, retention: undefined, tombstoneKey: undefined })).rejects.toThrow(TypeError);
    await answers(adapter);
    // Refused before anything opened: no table on the host's adapter, and no copy file.
    expect(await adapter.all("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([]);
    expect(fs.existsSync(copyAt('aria').path)).toBe(false);

    // One person's own store needs neither: every session of every process runs as that one user.
    const { a } = await open('aria-1', { ...onHost, retention: undefined, tombstoneKey: undefined, sharedMemory: { as: 'owner' } });
    await turn(a, adapter, 's1', 'owner', 'My canary is LARK-7.');
    expect(JSON.stringify(await tracesUnder(adapter, userKey('owner')))).toContain('LARK-7');
  });

  it("stores nothing once the agent is closed: a write its screen hook held past close() is not stored, and the host's adapters still answer", async () => {
    const adapter = await sqliteAdapter();
    const copy = await sqliteAdapter('copy.sqlite');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { a } = await open('aria-1', {
      soulStore: { adapter },
      tombstoneCopy: { adapter: copy },
      pendingWritesTimeoutMs: 50,
      screen: async (text: string) => {
        await held;
        return text;
      },
    });
    const remember = vi.spyOn(a.memory!, 'remember');
    await a.session('s1', { userId: 'alice' }).send('My canary is LARK-7.');
    await closed(a);
    // close() waited 50 ms for the turn's two writes, which the hook still holds, and went on without them.
    expect(remember).not.toHaveBeenCalled();
    expect(await tracesUnder(adapter, userKey('alice'))).toEqual([]);

    // The hook answers once the agent is closed, and both writes reach the store. Its adapter is the host's and still
    // open, so nothing but the closed store itself stops them: it stores neither.
    release();
    await vi.waitFor(() => expect(remember).toHaveBeenCalledTimes(2), { timeout: 8_000 });
    await Promise.allSettled(remember.mock.results.map((result) => result.value as Promise<unknown>));
    expect(await tracesUnder(adapter, userKey('alice'))).toEqual([]);
    expect(JSON.stringify(await adapter.all('SELECT content FROM memory_traces WHERE brain_id = ?', ['aria-1']))).not.toContain('LARK-7');
    await answers(adapter);
    await answers(copy);
  });
});

describe.skipIf(!POSTGRES_URL)(`a souled agent's store on a PostgreSQL adapter, on runtime ${RUNTIME}`, () => {
  it("keeps each person's memory on the host's PostgreSQL adapter, and a deletion of one leaves the other's", async () => {
    await keepsEachPersonsMemory(await postgresAdapter(newSchema()));
  });

  it('refuses an adapter opened without the int8 parser, and leaves it open', async () => {
    const adapter = await postgresAdapter(newSchema(), true);
    await expect(open('aria-1', { soulStore: { adapter }, tombstoneCopy: copyAt('aria') })).rejects.toThrow(/typeParsers/);
    await answers(adapter);
  });

  it('refuses at least one of two agents opened at once on one empty database', async () => {
    const schema = newSchema();
    await refusesOneOfTwoAtOnce(await postgresAdapter(schema), await postgresAdapter(schema));
  });

  it('runs a sweep of one person, a deletion of another and a turn of a third at once, one transaction at a time, and each leaves the rows it should', async () => {
    const { adapter, count } = countingTransactions(await postgresAdapter(newSchema()));
    const { a } = await open('aria-1', { soulStore: { adapter }, tombstoneCopy: copyAt('aria'), retention: { traces: { days: 1 } } });
    await turn(a, adapter, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, adapter, 's2', 'bob', 'My canary is WREN-2.');
    // Alice's memory from three days ago, past the one-day period.
    for (let i = 0; i < 3; i += 1) {
      await adapter.run(
        `INSERT INTO memory_traces
           (brain_id, id, type, scope, content, embedding, strength, created_at,
            last_accessed, retrieval_count, tags, emotions, metadata, deleted, scope_id)
         VALUES (?, ?, 'episodic', 'conversation', ?, NULL, 1.0, ?, NULL, 0, '[]', '{}', '{}', 0, ?)`,
        ['aria-1', `old-${i}`, `My old boat was HERON-${i}.`, Date.now() - 3 * DAY_MS, userKey('alice')],
      );
    }

    count.started = 0;
    count.mostAtOnce = 0;
    const [swept, report] = await Promise.all([
      a.sweepRetention!(),
      a.forgetUser!('bob'),
      turn(a, adapter, 's3', 'carol', 'My canary is TERN-4.'),
    ]);
    expect(swept.traces).toBeGreaterThanOrEqual(3);
    expect(report.complete).toBe(true);
    expect(await tracesUnder(adapter, userKey('bob'))).toEqual([]);
    const alice = JSON.stringify(await tracesUnder(adapter, userKey('alice')));
    expect(alice).toContain('LARK-7');
    expect(alice).not.toContain('HERON');
    expect(JSON.stringify(await tracesUnder(adapter, userKey('carol')))).toContain('TERN-4');
    await closed(a);
    await answers(adapter);
    // The sweep, the deletion, the turn and the close each opened transactions on the adapter, and no two were open
    // at once: the agent runs its own one after another.
    expect(count.started).toBeGreaterThanOrEqual(3);
    expect(count.mostAtOnce).toBe(1);

    // The count sees an overlap where there is one: two transactions the host opens itself on the same adapter object
    // are outside the agent's order.
    count.mostAtOnce = 0;
    await Promise.all([
      adapter.transaction((trx) => trx.get('SELECT 1 AS n')),
      adapter.transaction((trx) => trx.get('SELECT 1 AS n')),
    ]);
    expect(count.mostAtOnce).toBe(2);
  });
});
