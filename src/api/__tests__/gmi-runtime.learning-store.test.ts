/**
 * @file gmi-runtime.learning-store.test.ts
 * gmi() with durable memory and its learning store, end to end over the real provider manager, completion gateway, GMI,
 * memory manager, Brain and learning layer; only the provider class is stubbed (helpers/stubProviders.ts). memory.store
 * needs the learning flag and learning.agentKey, and so does a SQL learning store; a store that does not open fails a
 * session's first send naming memory.store. One SQLite file holds the agent's memory and its learning store: an agent
 * built again on the file recalls what a user said, a returning user's oldest trace among it past the brain's newest
 * 1,000 and what a session with no user filed past them, and renders the traits an operator set, and a closed agent
 * opens the file again on its next use, a forgetUser after agent.close() included, once a host call already running has
 * finished on the file. A host's own adapter is never closed. A turn with no learner files under its session's memory
 * scope, a reopened session's own, and its memory_add writes one row of no user. The agent's host calls fill in its key
 * and namespace, and reach the memory tools a host registers itself through learning.memoryTools. With the learning
 * flag off a memory_add files under the plain user id, memory_reflect is offered and runs, a tool call carries no
 * learning, and the agent has no learning member.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import type { AgentOptions } from '../agent';
import { gmi } from '../gmi';
import { InMemoryLearningStore } from '../../cognition/learning/index';
import { chainKeyOf } from '../../cognition/learning/ledger/Ledger';
import { SqlLearningStore } from '../../cognition/learning/store/SqlLearningStore';
import { closeMemory, facadeAt, liveContents, tempFile } from '../../cognition/learning/__tests__/helpers/memoryFixtures';
import { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { renderPersonalitySection } from '../../cognition/substrate/personas/personalityPrompt';
import type { ToolExecutionContext } from '../../core/tools/ITool';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { reply, script } from './helpers/stubProviders';

let n = 0;
const key = () => `k-learning-store-${++n}`;
const TRAITS = { honesty: 0.9, extraversion: 0.8, agreeableness: 0.5 };
const options = (apiKey: string, extra: Record<string, unknown> = {}) =>
  ({
    runtime: 'gmi',
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    name: 'Tutor',
    instructions: 'You teach networking.',
    personality: TRAITS,
    ...extra,
  }) as unknown as AgentOptions;
/** Cognitive memory with no mechanisms, embedding through OpenAI, on `store` when one is given. */
const memoryOn = (store?: unknown) => ({
  cognition: { memory: { ...(store === undefined ? {} : { store }), embedding: { provider: 'openai' } }, mechanisms: false },
});
/** The system text of one model call. */
const systemOf = (call: { messages: Array<{ role: string; content: unknown }> }): string =>
  call.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
/** The layer logs its manifest once, at its first session. */
const quietManifest = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
/** Memory's embeddings go to a key of their own, set as the environment's OpenAI key. */
function embeddings(): void {
  const emb = key();
  script('openai', emb, { replies: [] });
  vi.stubEnv('OPENAI_API_KEY', emb);
}
/** A tool that records the learning each call carries (`sessionData.learning`). */
function probeTool(seen: Array<Record<string, unknown> | undefined>) {
  return {
    id: 'probe-v1',
    name: 'probe',
    displayName: 'Probe',
    description: 'Records the learning its call carries.',
    inputSchema: { type: 'object', properties: {} },
    hasSideEffects: false,
    async execute(_args: unknown, context: ToolExecutionContext) {
      seen.push(context.sessionData?.learning as Record<string, unknown> | undefined);
      return { success: true, output: 'ok' };
    },
  };
}
/** The live traces of the brain `tutor` in a SQLite file under one scope id, read through a Brain of its own. */
async function liveUnder(file: string, scopeId: string): Promise<number> {
  const brain = await Brain.openSqlite(file, { brainId: 'tutor' });
  try {
    const row = await brain.get<{ n: number | string }>("SELECT count(*) AS n FROM memory_traces WHERE brain_id = 'tutor' AND scope_id = ? AND deleted = 0", [scopeId]);
    return Number(row?.n ?? 0);
  } finally {
    await brain.close();
  }
}

/**
 * Files a thousand traces of other users in the brain `tutor`, each newer than every trace there: the brain's whole-brain
 * hydration loads these and no older one. Hydration skips a row with no embedding, so they never compete in recall.
 */
async function fileNewerTraces(file: string): Promise<void> {
  const brain = await Brain.openSqlite(file, { brainId: 'tutor' });
  try {
    const newest = await brain.get<{ created_at: number }>("SELECT max(created_at) AS created_at FROM memory_traces WHERE brain_id = 'tutor'");
    await brain.transaction(async (trx) => {
      for (let i = 0; i < 1_000; i += 1) {
        await trx.run(
          `INSERT INTO memory_traces (brain_id, id, type, scope, scope_id, content, embedding, strength, created_at,
             last_accessed, retrieval_count, tags, emotions, metadata, deleted)
           VALUES ('tutor', ?, 'episodic', 'user', ?, ?, NULL, 0.5, ?, NULL, 0, '[]', '{}', ?, 0)`,
          [`filler-${i}`, `other-${i}`, `Filler note ${i}.`, Number(newest!.created_at) + 1 + i, JSON.stringify({ scopeId: `other-${i}` })],
        );
      }
    });
  } finally {
    await brain.close();
  }
}

const adapters: StorageAdapter[] = [];

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (adapters.length) await adapters.pop()!.close();
  await closeMemory();
});

describe('a durable store at construction', () => {
  it('needs the learning flag and learning.agentKey; a SQL learning store needs the key; a store is a path or an adapter', async () => {
    const file = tempFile();
    expect(() => gmi(options(key(), memoryOn({ path: file })))).toThrow(/memory\.store needs the learning option/);
    expect(() => gmi(options(key(), { ...memoryOn({ path: file }), learning: true }))).toThrow(/memory\.store needs learning\.agentKey/);
    expect(() => gmi(options(key(), { ...memoryOn({ path: ' ' }), learning: { agentKey: 'tutor' } }))).toThrow(/memory\.store\.path/);
    expect(() => gmi(options(key(), { ...memoryOn({ url: file }), learning: { agentKey: 'tutor' } }))).toThrow(/memory\.store must be/);
    expect(() => gmi(options(key(), { ...memoryOn({ adapter: {} }), learning: { agentKey: 'tutor' } }))).toThrow(/memory\.store\.adapter/);
    const adapter = await resolveStorageAdapter({ filePath: tempFile(), priority: ['better-sqlite3', 'sqljs'], quiet: true });
    adapters.push(adapter);
    expect(() => gmi(options(key(), { ...memoryOn({ adapter, brainId: ' ' }), learning: { agentKey: 'tutor' } }))).toThrow(/memory\.store\.brainId/);
    expect(() => gmi(options(key(), { learning: { store: new SqlLearningStore({ adapter }) } }))).toThrow(/learning\.store needs learning\.agentKey/);
  });
});

describe('a durable store that does not open', () => {
  it("fails the session's first send naming memory.store, before any model call, and the agent still closes", async () => {
    quietManifest();
    const k = key();
    const provider = script('openai', k, { replies: [reply.text('Not sent.')] });
    const down = async () => {
      throw new Error('disk gone');
    };
    // An adapter whose every statement fails: the Brain cannot open on it.
    const adapter = {
      kind: 'better-sqlite3',
      capabilities: new Set(['transactions']),
      run: down,
      get: down,
      all: down,
      exec: down,
      transaction: down,
      close: async () => undefined,
    } as unknown as StorageAdapter;
    const tutor = gmi(options(k, { ...memoryOn({ adapter }), learning: { agentKey: 'tutor' } }));

    await expect(tutor.session('s1', { userId: 'ana' }).send('I keep bees.')).rejects.toThrow(/memory\.store did not open/);
    expect(provider.seen).toEqual([]);
    await expect(tutor.close()).resolves.toBeUndefined();
  });
});

describe("an agent's memory and learned state in one SQLite file", () => {
  it('are recalled and rendered by an agent built again on the file, and a closed agent opens the file again', async () => {
    quietManifest();
    embeddings();
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('It is in the vault.')] });
    const opts = options(k, { ...memoryOn({ path: tempFile() }), learning: { agentKey: 'tutor' } });

    const first = gmi(opts);
    await first.session('s1', { userId: 'ana' }).send('The deploy key lives in the vault under ops/deploy.');
    await first.learning!.operatorSet!({ userId: 'ana', traits: { openness: 0.7 }, by: 'ops' });
    await first.close();
    expect((await first.learning!.manifest()).loops.ledger).toMatchObject({ live: true, detail: expect.stringContaining("sql store over the agent's memory store") });
    await first.close();

    const second = gmi(opts);
    await second.session('s2', { userId: 'ana' }).send('Where does the deploy key live?');
    expect(JSON.stringify(s.seen[1].messages)).toContain('vault');
    expect(systemOf(s.seen[1])).toContain(renderPersonalitySection({ ...TRAITS, openness: 0.7 })!);
    await second.close();
  });

  it("recall a returning user's oldest trace past the brain's newest 1,000, in an agent built again on the file", async () => {
    quietManifest();
    embeddings();
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('It is in the vault.')] });
    const file = tempFile();
    const opts = options(k, { ...memoryOn({ path: file }), learning: { agentKey: 'tutor' } });
    const first = gmi(opts);
    await first.session('s1', { userId: 'ana' }).send('The deploy key lives in the vault under ops/deploy.');
    await first.close();

    // A thousand newer traces of other users: the brain's whole-brain hydration loads these and leaves out ana's.
    await fileNewerTraces(file);

    const second = gmi(opts);
    await second.session('s2', { userId: 'ana' }).send('Where does the deploy key live?');
    expect(JSON.stringify(s.seen[1].messages)).toContain('vault');
    await second.close();
  });

  it("recall what a session with no user filed past the brain's newest 1,000, when its id opens in an agent built again on the file", async () => {
    quietManifest();
    embeddings();
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('It is in the vault.')] });
    const file = tempFile();
    const opts = options(k, { ...memoryOn({ path: file }), learning: { agentKey: 'tutor' } });
    const first = gmi(opts);
    await first.session('x').send('The deploy key lives in the vault under ops/deploy.');
    await first.close();

    await fileNewerTraces(file);

    const second = gmi(opts);
    await second.session('x').send('Where does the deploy key live?');
    expect(JSON.stringify(s.seen[1].messages)).toContain('vault');
    await second.close();
  });

  it("are forgotten after agent.close(): the user's traces in the file and the learned rows", async () => {
    quietManifest();
    embeddings();
    const k = key();
    script('openai', k, { replies: [reply.text('Noted.')] });
    const file = tempFile();
    const tutor = gmi(options(k, { ...memoryOn({ path: file }), learning: { agentKey: 'tutor' } }));
    await tutor.session('s1', { userId: 'ana' }).send('The deploy key lives in the vault under ops/deploy.');
    await tutor.close();
    expect(await liveUnder(file, 'ana')).toBeGreaterThan(0);

    // No session is open: the call reaches the file through the agent's memory, opened again for it.
    const report = await tutor.learning!.forgetUser!('ana');
    expect(report.stores.filter((entry) => !entry.reached && /memory manager|learning store/.test(entry.store))).toEqual([]);
    expect(report.stores).toContainEqual(expect.objectContaining({ store: 'memory manager of brain tutor', reached: true }));
    await tutor.close();

    expect(await liveUnder(file, 'ana')).toBe(0);
    const brain = await Brain.openSqlite(file, { brainId: 'tutor' });
    try {
      expect(await brain.all('SELECT session_id FROM agentos_learning_sessions')).toEqual([]);
    } finally {
      await brain.close();
    }
  });

  it('keep no learning store a host call was opening when agent.close() closed the file: the next call opens it again', async () => {
    quietManifest();
    const file = tempFile();
    const tutor = gmi(options(key(), { ...memoryOn({ path: file }), learning: { agentKey: 'tutor' } }));
    // The call opens the file's Brain and the learning store on it while close() lets them go.
    const opening = tutor.learning!.manifest();
    await tutor.close();
    await opening.catch(() => undefined);

    await tutor.learning!.freeze!({ userId: 'ana' }, 'ops');
    expect((await tutor.learning!.manifest()).loops.ledger).toMatchObject({ live: true });
    await tutor.close();
    const brain = await Brain.openSqlite(file, { brainId: 'tutor' });
    try {
      expect(await brain.all('SELECT mode FROM agentos_learning_freezes')).toEqual([{ mode: 'frozen' }]);
    } finally {
      await brain.close();
    }
  });

  it('let a host call that holds the learning store finish on the file before agent.close() closes it', async () => {
    quietManifest();
    const file = tempFile();
    const tutor = gmi(options(key(), { ...memoryOn({ path: file }), learning: { agentKey: 'tutor' } }));
    // The first call opens the file's Brain and the learning store on it.
    await tutor.learning!.freeze!({ userId: 'ana' }, 'ops');
    // The next transaction waits until the test lets it go: the unfreeze holds the store while close() runs.
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const transaction = SqlLearningStore.prototype.transaction;
    vi.spyOn(SqlLearningStore.prototype, 'transaction').mockImplementationOnce(async function (this: SqlLearningStore, ...args: Parameters<SqlLearningStore['transaction']>) {
      await held;
      return transaction.apply(this, args);
    } as SqlLearningStore['transaction']);
    const unfreezing = tutor.learning!.unfreeze!({ userId: 'ana' });
    const closing = tutor.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    letGo();

    await expect(unfreezing).resolves.toBeUndefined();
    await closing;
    const brain = await Brain.openSqlite(file, { brainId: 'tutor' });
    try {
      expect(await brain.all('SELECT mode FROM agentos_learning_freezes')).toEqual([]);
    } finally {
      await brain.close();
    }
  });

  it("run on a host's own adapter, which the agent never closes", async () => {
    quietManifest();
    embeddings();
    const k = key();
    script('openai', k, { replies: [reply.text('Hi.')] });
    const adapter = await resolveStorageAdapter({ filePath: tempFile(), priority: ['better-sqlite3', 'sqljs'], quiet: true });
    adapters.push(adapter);
    const tutor = gmi(options(k, { ...memoryOn({ adapter }), learning: { agentKey: 'tutor' } }));
    await tutor.session('s1', { userId: 'ana' }).send('I keep bees.');
    await tutor.close();

    const traces = await adapter.get<{ n: number | string }>("SELECT count(*) AS n FROM memory_traces WHERE brain_id = 'tutor' AND scope_id = 'ana'");
    expect(Number(traces?.n)).toBeGreaterThan(0);
    expect(await adapter.all('SELECT session_id FROM agentos_learning_sessions')).toEqual([{ session_id: 's1' }]);
  });
});

describe('a turn with no learner', () => {
  it("files under its session's memory scope, a session opened again after close() under its own", async () => {
    quietManifest();
    embeddings();
    const k = key();
    script('openai', k, {
      replies: [reply.tools([{ id: 'p1', name: 'probe', args: {} }]), reply.text('One.'), reply.tools([{ id: 'p2', name: 'probe', args: {} }]), reply.text('Two.')],
    });
    const seen: Array<Record<string, unknown> | undefined> = [];
    const tutor = gmi(options(k, { ...memoryOn(), learning: true, tools: { probe: probeTool(seen) } }));
    const first = tutor.session('s1');
    await first.send('Probe.');
    await first.close();
    await tutor.session('s1').send('Probe.');

    expect(seen[0]).toMatchObject({ learner: 'none', scopes: { learner: 'none', userScopeId: '/s1' } });
    expect((seen[1]?.scopes as { userScopeId: string }).userScopeId).toMatch(/^\/s1%3A[0-9a-f-]{36}$/);
    await tutor.close();
  });

  it("files a memory_add on a session opened without a user id under the session's form, with a row of no user", async () => {
    quietManifest();
    const k = key();
    script('openai', k, { replies: [reply.tools([{ id: 'c1', name: 'memory_add', args: { content: 'Canary GMI-7.' } }]), reply.text('Saved.')] });
    const { memory, brain } = await facadeAt(tempFile(), 'tools-brain');
    const store = new InMemoryLearningStore();
    const tools = Object.fromEntries(memory.createTools({ includeReflect: false }).map((tool) => [tool.name, tool]));
    const tutor = gmi(options(k, { tools, learning: { agentKey: 'tutor', store, memoryTools: memory } }));
    await tutor.session('s1').send('Remember this.');

    expect(await brain.all('SELECT scope_id, content FROM memory_traces WHERE deleted = 0')).toEqual([{ scope_id: '/s1', content: 'Canary GMI-7.' }]);
    const rows = (await store.chainRows(chainKeyOf({ namespace: '', agentKey: 'tutor', userId: null }))).filter((row) => row.kind === 'memory_write');
    expect(rows.map((row) => [row.rowType, row.verdict, row.userId, row.turnUserId])).toEqual([
      ['candidate', 'pending', null, null],
      ['verdict', 'kept', null, null],
    ]);
    await tutor.close();
  });
});

describe("the agent's host calls", () => {
  it("fill in the agent's key and namespace, and reach the memory tools a host registers itself through learning.memoryTools", async () => {
    quietManifest();
    const k = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([{ id: 'c1', name: 'memory_add', args: { content: 'Canary KITE-3.' } }]),
        reply.text('Not saved.'),
        reply.tools([{ id: 'c2', name: 'memory_add', args: { content: 'Canary KITE-3.' } }]),
        reply.text('Saved.'),
      ],
    });
    const { memory, brain } = await facadeAt(tempFile(), 'tools-brain');
    const tools = Object.fromEntries(memory.createTools({ includeReflect: false }).map((tool) => [tool.name, tool]));
    const tutor = gmi(options(k, { tools, learning: { agentKey: 'tutor', namespace: 'A', memoryTools: memory } }));
    const session = tutor.session('s1', { userId: 'ana' });

    await tutor.learning!.freeze!({ userId: 'ana' }, 'ops');
    await session.send('Remember the kite.');
    expect(await liveContents(brain)).toEqual([]);
    expect(JSON.stringify(s.seen[1].messages)).toContain('frozen');

    await tutor.learning!.unfreeze!({ userId: 'ana' });
    await session.send('Remember the kite.');
    expect(await brain.all('SELECT scope, scope_id, content FROM memory_traces WHERE deleted = 0')).toEqual([
      { scope: 'user', scope_id: 'A/ana', content: 'Canary KITE-3.' },
    ]);
    const exported = await tutor.learning!.exportLearnedState!('ana');
    expect(exported.learner).toEqual({ namespace: 'A', agentKey: 'tutor', userId: 'ana' });

    expect(await tutor.learning!.forgetUser!('ana')).toMatchObject({ userId: 'ana', namespace: 'A' });
    expect(await liveContents(brain)).toEqual([]);
    await tutor.close();
  });

  it('refuse a call that names a learner on an agent with no key, naming learning.agentKey', async () => {
    quietManifest();
    const tutor = gmi(options(key(), { name: undefined, learning: true }));
    await expect(tutor.learning!.exportLearnedState!('ana')).rejects.toThrow(/learning\.agentKey/);
    await expect(tutor.learning!.operatorSet!({ userId: 'ana', traits: 'baseline', by: 'ops' })).rejects.toThrow(/learning\.agentKey/);
    await tutor.learning!.freeze!();
    expect((await tutor.learning!.manifest()).mode).toBe('on');
    await tutor.learning!.unfreeze!();
  });
});

describe('with the learning flag off', () => {
  it('files a memory_add under the plain user id, offers memory_reflect and runs it, and builds nothing of the layer', async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([{ id: 'c1', name: 'memory_add', args: { content: 'Canary OFF-1.' } }]),
        reply.tools([{ id: 'p1', name: 'probe', args: {} }]),
        reply.text('Saved.'),
        reply.tools([{ id: 'c2', name: 'memory_reflect', args: {} }]),
        reply.text('Tidied.'),
      ],
    });
    // Self-improvement on (the facade's default), so the facade has memory_reflect to offer.
    const { memory, brain } = await facadeAt(tempFile(), 'tools-brain');
    const seen: Array<Record<string, unknown> | undefined> = [];
    const tools = Object.fromEntries([...memory.createTools(), probeTool(seen)].map((tool) => [tool.name, tool]));
    const tutor = gmi(options(k, { tools }));
    expect(tutor.learning).toBeUndefined();
    const session = tutor.session('s1', { userId: 'ana' });
    await session.send('Remember this.');

    expect(await brain.all('SELECT scope_id, content FROM memory_traces WHERE deleted = 0')).toEqual([{ scope_id: 'ana', content: 'Canary OFF-1.' }]);
    // The GMI puts no learning on a tool call.
    expect(seen).toEqual([undefined]);
    const offered = ((s.seen[0].options.tools as Array<{ function: { name: string } }> | undefined) ?? []).map((tool) => tool.function.name);
    expect(offered).toContain('memory_reflect');

    // A call to memory_reflect runs a consolidation and returns its counts.
    await session.send('Tidy your memory.');
    const reflected = s.seen[4].messages.filter((message) => message.role === 'tool' && message.name === 'memory_reflect');
    expect(reflected).toHaveLength(1);
    expect(String(reflected[0]!.content)).toContain('"pruned"');
    expect(String(reflected[0]!.content)).not.toContain('withdrawn');
    // SQLite's own catalog: no table of the learning store. GLOB reads `_` as itself.
    expect(await brain.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'agentos_learning_*'")).toEqual([]);
    await tutor.close();
  });
});
