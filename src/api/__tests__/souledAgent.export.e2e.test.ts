/**
 * One person's export from a souled agent, and the list of who receives a person's text, end to end over the real
 * agent, generateText, provider manager, Memory store and wiki; only the provider classes are stubbed
 * (helpers/stubProviders.ts), at their module boundary.
 *
 * - The export keeps `traces` and `pages`, and holds what the person provided (their own messages), what is held about
 *   them (each trace with its speaker, entities, filing side, emotional context and strength fields; the links between
 *   their own traces in the store's memory graph; their pages), who receives a person's text, the retention period,
 *   the profiling state, and each read that failed.
 * - Nothing of another person, and nothing of the operator's pages, is in it.
 * - `recipients()` names every provider the options send a person's text to, and a route a call took that the options
 *   do not name, after the agent is closed and opened again too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
vi.mock('../../core/llm/providers/implementations/OpenRouterProvider', async () => ({ OpenRouterProvider: (await import('./helpers/stubProviders')).stubProviderClass('openrouter') }));
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import type { MemoryRecipient } from '../runtime/memoryRecipients';
import { exportSubjectMemory, type UserMemoryExport } from '../../cognition/memory/io/userMemoryExport';
import { SqlStorageMemoryArchive } from '../../cognition/memory/archive/SqlStorageMemoryArchive';
import type { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { SqlMemoryGraph } from '../../cognition/memory/retrieval/store/SqlMemoryGraph';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { clearDefaultProvider, setDefaultProvider } from '../runtime/global-default';

/** The runtime the cases run on; a case that needs what only the GMI runtime has names it. */
const RUNTIME = 'legacy' as const;

/** What `open()`'s options send a person's text to: the agent's own model, and the compile on its route. */
const OWN_ROUTE: MemoryRecipient[] = [
  { role: 'model', provider: 'openai', model: 'stub-model' },
  { role: 'compile', provider: 'openai', model: 'stub-model' },
];

let n = 0;
let dir: string;
const opened: SouledAgent[] = [];
/** Every line the library logged in the case, parsed. */
let events: Array<Record<string, unknown>>;
beforeEach(() => {
  globalLLMProviderHealth.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-export-e2e-'));
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
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (opened.length) await opened.pop()!.close().catch(() => undefined);
  resetLoggerFactory();
  fs.rmSync(dir, { recursive: true, force: true });
});

const storeFile = () => path.join(dir, 'memory', '.store', 'memory.sqlite');
const keyOf = (subject: { kind: 'user' | 'session'; id: string }) => conversationScopeKey('aria-1', subject);
const alice = { kind: 'user' as const, id: 'alice' };
const bob = { kind: 'user' as const, id: 'bob' };

let replyNo = 0;
/** Replies to spare, each with words of its own: the store keeps one trace for a text a subject's memory already holds. */
const spare = (): ProviderScript['replies'] => Array.from({ length: 40 }, () => reply.text(`Noted ${++replyNo}.`));

/** A souled agent on the stubbed OpenAI provider; `retention` and `tombstoneKey` are set so two users may share the store. */
async function open(extra: Partial<SouledAgentOptions> = {}, apiKey = `k-souled-export-${++n}`): Promise<{ a: SouledAgent; apiKey: string }> {
  script('openai', apiKey, { whole: true, replies: spare() });
  const a = await souledAgent({
    runtime: RUNTIME,
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    soul: dir,
    retention: { traces: 'until-deletion' },
    tombstoneKey: 'k-souled-export-tombstones',
    ...extra,
  } as unknown as SouledAgentOptions);
  opened.push(a);
  return { a, apiKey };
}

/** Rows of the store's SQLite file, read by a connection of the test's own. */
function rows<T>(sql: string, params: unknown[] = []): T[] {
  const db = new Database(storeFile(), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
/** What a subject and the agent said to each other, oldest first, as the store holds it: no page's chunks. */
const saidOf = (key: string) =>
  rows<{ id: string; content: string; tags: string }>(
    "SELECT id, content, tags FROM memory_traces WHERE scope = 'conversation' AND scope_id = ? AND deleted = 0 ORDER BY created_at, rowid",
    [key],
  ).filter((trace) => !(JSON.parse(trace.tags) as string[]).includes('wiki'));

/** One turn of a user, and a wait until both of its traces (the user's text and the reply) are stored. */
async function turn(a: SouledAgent, sessionId: string, userId: string, text: string): Promise<void> {
  const key = keyOf({ kind: 'user', id: userId });
  const before = saidOf(key).length;
  await a.session(sessionId, { userId }).send(text);
  await vi.waitFor(() => expect(saidOf(key).length).toBeGreaterThanOrEqual(before + 2), { timeout: 4_000 });
}

/** The Brain behind a souled agent's store, for the rows a case plants. */
const brainBehind = (a: SouledAgent): Brain => (a.memory as unknown as { _brain: Brain })._brain;

/** Plants a link between two traces in the store's memory graph, each trace a node of it. */
async function link(a: SouledAgent, from: { id: string; key: string }, to: { id: string; key: string }, weight: number): Promise<void> {
  const graph = new SqlMemoryGraph(brainBehind(a));
  await graph.initialize();
  for (const end of [from, to]) {
    await graph.addNode(end.id, { type: 'episodic', scope: 'conversation', scopeId: end.key, strength: 1, createdAt: Date.now() });
  }
  await graph.addEdge({ sourceId: from.id, targetId: to.id, type: 'SAME_TOPIC', weight, createdAt: Date.now() });
}

const exportOf = (a: SouledAgent, userId: string): Promise<UserMemoryExport> => a.exportUserMemory!(userId);
const recipientsOf = (a: SouledAgent): Promise<MemoryRecipient[]> => a.recipients!();

/** Writes one operator page under memory/. */
function writeOperatorPage(text: string): void {
  const file = path.join(dir, 'memory', 'concepts', 'house.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nid: concepts/house\ntype: concept\nsummary: House rules.\n---\n${text}\n`);
}

describe(`one person's export, on runtime ${RUNTIME}`, () => {
  it('the export holds what the person provided and what is held about them', async () => {
    const { a } = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's1', 'alice', 'I keep it in the attic.');
    await turn(a, 's2', 'bob', 'My canary is WREN-2.');
    await a.memory!.compileWiki();
    const said = saidOf(keyOf(alice));
    expect(said).toHaveLength(4);
    const [bobs] = saidOf(keyOf(bob));
    await link(a, { id: said[0].id, key: keyOf(alice) }, { id: said[2].id, key: keyOf(alice) }, 0.8);
    await link(a, { id: said[1].id, key: keyOf(alice) }, { id: bobs.id, key: keyOf(bob) }, 0.5);

    const doc = await exportOf(a, 'alice');

    // What an existing caller reads, as before.
    expect(doc.agentId).toBe('aria-1');
    expect(doc.subject).toEqual({ kind: 'user' });
    expect(doc.traces.map((trace) => trace.id).sort()).toEqual(said.map((trace) => trace.id).sort());
    expect(doc.traces.map((trace) => trace.speaker)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(doc.pages).toHaveLength(1);

    // What the person provided: their own two messages, and nothing the agent said.
    expect(doc.provided.messages.map((message) => message.text)).toEqual(['My canary is LARK-7.', 'I keep it in the attic.']);
    expect(doc.provided.messages.map((message) => message.id)).toEqual(
      doc.traces.filter((trace) => trace.speaker === 'user').map((trace) => trace.id),
    );
    for (const message of doc.provided.messages) {
      expect(Object.keys(message).sort()).toEqual(['createdAt', 'id', 'text']);
      expect(new Date(message.createdAt).toISOString()).toBe(message.createdAt);
    }

    // What is held about them: every trace with its fields, filed by the soul.
    expect(doc.held.traces.map((trace) => trace.id)).toEqual(doc.traces.map((trace) => trace.id));
    expect(doc.held.traces.map((trace) => trace.text)).toEqual(doc.traces.map((trace) => trace.text));
    expect(doc.held.traces.map((trace) => trace.speaker)).toEqual(doc.traces.map((trace) => trace.speaker));
    for (const trace of doc.held.traces) {
      expect(['user', 'assistant']).toContain(trace.speaker);
      expect(Array.isArray(trace.tags)).toBe(true);
      expect(trace.tags).not.toContain('wiki');
      expect(Array.isArray(trace.entities)).toBe(true);
      expect(trace.filedBy).toBe('soul');
      for (const field of ['valence', 'arousal', 'dominance', 'intensity'] as const) {
        expect(Number.isFinite(trace.emotionalContext[field])).toBe(true);
      }
      expect(typeof trace.emotionalContext.gmiMood).toBe('string');
      expect(Number.isFinite(trace.encodingStrength)).toBe(true);
      expect(Number.isFinite(trace.stability)).toBe(true);
      expect(Number.isInteger(trace.retrievalCount)).toBe(true);
      expect(new Date(trace.lastAccessedAt).toISOString()).toBe(trace.lastAccessedAt);
      expect(new Date(trace.createdAt).toISOString()).toBe(trace.createdAt);
    }
    expect(doc.held.typedFacts).toEqual([]);
    expect(doc.held.archivedOriginals).toEqual([]);
    expect(doc.held.restoreCopies).toEqual([]);
    expect(doc.held.pages).toEqual(doc.pages);
    // The link between two of the person's traces; the one to another person's trace is left out.
    expect(doc.held.graphLinks).toEqual([{ from: said[0].id, to: said[2].id, type: 'SAME_TOPIC', weight: 0.8 }]);

    expect(doc.recipients).toEqual(OWN_ROUTE);
    expect(doc.retention).toEqual({ period: 'until-deletion' });
    // The default runtime scores no sentiment, and the soul files every trace with a neutral emotional context.
    expect(doc.profiling).toEqual({ sentiment: 'off', moodStamps: 0 });
    expect(doc.unread).toEqual([]);
  });

  it("nothing of another person or of the operator's pages is in it", async () => {
    writeOperatorPage('Guests check out by HERON-5 hours.');
    const { a } = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's2', 'bob', 'My canary is WREN-2.');
    await a.memory!.compileWiki();
    const [alices] = saidOf(keyOf(alice));
    const [bobs] = saidOf(keyOf(bob));
    await link(a, { id: bobs.id, key: keyOf(bob) }, { id: alices.id, key: keyOf(alice) }, 0.9);

    const text = JSON.stringify(await exportOf(a, 'alice'));

    expect(text).toContain('LARK-7');
    expect(text).not.toContain('WREN-2');
    expect(text).not.toContain('HERON-5');
    expect(text).not.toContain(bobs.id);
    expect(text).not.toContain('alice');
  });

  it("a forgotten person's export is empty, and a read that fails is named", async () => {
    const { a } = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's2', 'bob', 'My canary is WREN-2.');
    await a.memory!.compileWiki();

    const memory = a.memory!;
    const listPageRows = memory.listPageRows.bind(memory);
    const pagesRead = vi.spyOn(memory, 'listPageRows').mockImplementation(async (scopeId: string) => {
      if (scopeId === keyOf(alice)) throw new Error('the page store went away while reading LARK-7');
      return listPageRows(scopeId);
    });
    const doc = await exportOf(a, 'alice');
    pagesRead.mockRestore();
    expect(doc.unread).toHaveLength(1);
    expect(doc.unread[0].store).toBe('compiled pages');
    expect(typeof doc.unread[0].reason).toBe('string');
    // The reason never repeats what the store said.
    expect(doc.unread[0].reason).not.toContain('LARK-7');
    expect(doc.pages).toEqual([]);
    expect(doc.held.pages).toEqual([]);
    expect(doc.traces.map((trace) => trace.text)).toContain('My canary is LARK-7.');
    // One line tells the operator which store went unread, with the error's kind and no text.
    const unread = events.filter((line) => line.event === 'memory.export_unread');
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({ store: 'compiled pages', type: expect.any(String), code: expect.any(String) });
    expect(JSON.stringify(unread)).not.toContain('LARK-7');
    expect(JSON.stringify(unread)).not.toContain('alice');

    await a.forgetUser!('bob');
    const gone = await exportOf(a, 'bob');
    expect(gone.traces).toEqual([]);
    expect(gone.pages).toEqual([]);
    expect(gone.provided.messages).toEqual([]);
    expect(gone.held.traces).toEqual([]);
    expect(gone.held.graphLinks).toEqual([]);
    expect(gone.held.pages).toEqual([]);
    expect(gone.unread).toEqual([]);
    expect(gone.recipients).toEqual(OWN_ROUTE);
  });
});

describe(`a read that fails partway, on runtime ${RUNTIME}`, () => {
  it('leaves its whole section out, not the part read before the failure', async () => {
    const { a } = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's1', 'alice', 'I keep it in the attic.');

    const memory = a.memory!;
    const readTrace = memory.readTrace.bind(memory);
    let reads = 0;
    vi.spyOn(memory, 'readTrace').mockImplementation(async (traceId: string) => {
      reads += 1;
      if (reads === 2) throw new Error('the store went away');
      return readTrace(traceId);
    });
    const doc = await exportOf(a, 'alice');

    expect(reads).toBe(2);
    expect(doc.unread.map((entry) => entry.store)).toEqual(['conversation traces']);
    expect(doc.traces).toEqual([]);
    expect(doc.provided.messages).toEqual([]);
    expect(doc.held.traces).toEqual([]);
    expect(doc.held.graphLinks).toEqual([]);
    expect(doc.profiling.moodStamps).toBe(0);
  });
});

describe(`who receives a person's text, on runtime ${RUNTIME}`, () => {
  it('recipients() names every provider the options send text to, and the export carries the list', async () => {
    const { a } = await open({
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-fallback' }, { provider: 'openrouter' }],
      compile: { provider: 'anthropic', model: 'claude-compile', minors: { provider: 'openai', model: 'minor-model' } },
    });

    const listed = await recipientsOf(a);

    expect(listed).toEqual([
      { role: 'model', provider: 'openai', model: 'stub-model' },
      { role: 'fallback-model', provider: 'anthropic', model: 'claude-fallback' },
      { role: 'fallback-model', provider: 'openrouter' },
      { role: 'compile', provider: 'anthropic', model: 'claude-compile' },
      { role: 'compile-minors', provider: 'openai', model: 'minor-model' },
    ]);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    expect((await exportOf(a, 'alice')).recipients).toEqual(listed);
  });

  it('with compile off no compile is named, and with no fallback list the automatic chain is', async () => {
    const { a } = await open({ compile: false, fallbackProviders: undefined });

    expect(await recipientsOf(a)).toEqual([
      { role: 'model', provider: 'openai', model: 'stub-model' },
      { role: 'fallback-model', provider: 'the automatic fallback chain' },
    ]);
  });

  it('a per-call route is still named after a restart', async () => {
    const envKey = `k-souled-export-env-${++n}`;
    vi.stubEnv('ANTHROPIC_API_KEY', envKey);
    const anthropic = script('anthropic', envKey, { whole: true, replies: [reply.text('From the other provider.')] });
    const apiKey = `k-souled-export-${++n}`;
    const { a } = await open({}, apiKey);

    const r = await a.generate('What is the weather like?', { provider: 'anthropic', model: 'claude-x' });
    expect(r.text).toBe('From the other provider.');
    expect(anthropic.seen.map((call) => call.modelId)).toEqual(['claude-x']);
    const route: MemoryRecipient = { role: 'model', provider: 'anthropic', model: 'claude-x' };
    expect(await recipientsOf(a)).toContainEqual(route);
    await a.close();

    // The store records the route alone: no person, no text, no time.
    const recorded = rows<{ key: string; value: string }>("SELECT key, value FROM brain_meta WHERE key LIKE 'recipient:%'");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].value).toBe('1');
    expect(recorded[0].key).not.toContain('weather');

    const { a: again } = await open({}, apiKey);
    const listed = await recipientsOf(again);
    expect(listed[0]).toEqual({ role: 'model', provider: 'openai', model: 'stub-model' });
    expect(listed).toContainEqual(route);
  });
});

describe(`where a route's text goes, on runtime ${RUNTIME}`, () => {
  it("names the provider a hop's model prefix sends it to, not the hop's own provider", async () => {
    const { a } = await open({ fallbackProviders: [{ provider: 'anthropic', model: 'openrouter:anthropic/claude-hop' }] });

    const listed = await recipientsOf(a);

    expect(listed).toContainEqual({ role: 'fallback-model', provider: 'openrouter', model: 'anthropic/claude-hop' });
    expect(listed.filter((entry) => entry.provider === 'anthropic')).toEqual([]);
  });

  it('names OpenRouter for an Anthropic hop the credential layer sends there, and still after a restart with an Anthropic key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', `k-souled-export-or-${++n}`);
    const apiKey = `k-souled-export-${++n}`;
    const hop = { provider: 'anthropic', model: 'claude-hop' };
    const { a } = await open({ fallbackProviders: [hop] }, apiKey);
    const rerouted: MemoryRecipient = { role: 'fallback-model', provider: 'openrouter', model: 'anthropic/claude-hop' };

    expect(await recipientsOf(a)).toEqual([...OWN_ROUTE.slice(0, 1), rerouted, ...OWN_ROUTE.slice(1)]);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await a.close();

    vi.stubEnv('ANTHROPIC_API_KEY', `k-souled-export-anthropic-${++n}`);
    const { a: again } = await open({ fallbackProviders: [hop] }, apiKey);
    const listed = await recipientsOf(again);
    // The hop goes to Anthropic now; the store still names where it went before.
    expect(listed).toContainEqual({ role: 'fallback-model', provider: 'anthropic', model: 'claude-hop' });
    expect(listed).toContainEqual(rerouted);
  });

  it("names a call's own model router, after a restart too", async () => {
    const apiKey = `k-souled-export-${++n}`;
    const { a } = await open({}, apiKey);
    const router = { routerId: 'stub-router', initialize: async () => undefined, selectModel: async () => null };

    await a.generate('Hello.', { router } as never);

    const routed: MemoryRecipient = { role: 'model', provider: 'picked by the model router at each call' };
    expect(await recipientsOf(a)).toEqual([...OWN_ROUTE, routed]);
    await a.close();
    const { a: again } = await open({}, apiKey);
    expect(await recipientsOf(again)).toEqual([...OWN_ROUTE, routed]);
  });
});

describe(`a call's own fallback hops, on runtime ${RUNTIME}`, () => {
  it("names each hop a call's own fallbackProviders name, and stores it once", async () => {
    const { a } = await open();

    await a.generate('Hello.', { fallbackProviders: [{ provider: 'anthropic', model: 'claude-hop' }] });
    await a.generate('Hello again.', { fallbackProviders: [{ provider: 'anthropic', model: 'claude-hop' }] });

    expect(await recipientsOf(a)).toEqual([...OWN_ROUTE, { role: 'fallback-model', provider: 'anthropic', model: 'claude-hop' }]);
    await a.close();
    expect(rows<{ key: string }>("SELECT key FROM brain_meta WHERE key LIKE 'recipient:%'")).toEqual([
      { key: 'recipient:fallback-model:anthropic:claude-hop' },
    ]);
  });
});

describe("who receives a person's text, on the GMI runtime with cognitive memory on", () => {
  it('recipients() names the embedding provider', async () => {
    const { a } = await open({
      runtime: 'gmi',
      memory: { embedding: { provider: 'openai', model: 'text-embedding-3-small' } },
    } as Partial<SouledAgentOptions>);

    expect(await recipientsOf(a)).toEqual([
      { role: 'model', provider: 'openai', model: 'stub-model' },
      { role: 'compile', provider: 'openai', model: 'stub-model' },
      { role: 'embedding', provider: 'openai', model: 'text-embedding-3-small' },
    ]);
  });
});

/** A model router whose every pick is `model` on `provider`. */
const routerPicking = (provider: string, model: string) => ({
  routerId: 'stub-router',
  initialize: async () => undefined,
  selectModel: async () => ({ provider: {}, modelId: model, modelInfo: { providerId: provider }, reasoning: 'stub', confidence: 1 }),
});

describe(`what a model router picks, on runtime ${RUNTIME}`, () => {
  it("names the provider and model a call's own router sends the text to, after a restart too", async () => {
    const envKey = `k-souled-export-env-${++n}`;
    vi.stubEnv('ANTHROPIC_API_KEY', envKey);
    const anthropic = script('anthropic', envKey, { whole: true, replies: [reply.text('Routed.')] });
    const apiKey = `k-souled-export-${++n}`;
    const { a } = await open({}, apiKey);

    const r = await a.generate('Hello.', { router: routerPicking('anthropic', 'claude-routed') } as never);

    expect(r.text).toBe('Routed.');
    expect(anthropic.seen.map((call) => call.modelId)).toEqual(['claude-routed']);
    const picked: MemoryRecipient = { role: 'model', provider: 'anthropic', model: 'claude-routed' };
    expect(await recipientsOf(a)).toContainEqual(picked);
    await a.close();
    const { a: again } = await open({}, apiKey);
    expect(await recipientsOf(again)).toContainEqual(picked);
  });

  it("names what the agent's own router picks for a turn and for the compile, and close() waits for the compile's", async () => {
    const envKey = `k-souled-export-env-${++n}`;
    vi.stubEnv('ANTHROPIC_API_KEY', envKey);
    const anthropic = script('anthropic', envKey, { whole: true, replies: spare() });
    const { a } = await open({ router: routerPicking('anthropic', 'claude-routed') as never });
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's1', 'alice', 'I keep it in the attic.');
    expect(await recipientsOf(a)).toContainEqual({ role: 'model', provider: 'anthropic', model: 'claude-routed' });

    // The store is slow to write the compile's route: close() compiles, and must not close the store under the write.
    const brain = brainBehind(a);
    const setMeta = brain.setMeta.bind(brain);
    vi.spyOn(brain, 'setMeta').mockImplementation(async (key: string, value: string) => {
      if (key.startsWith('recipient:compile:')) await new Promise((resolve) => setTimeout(resolve, 2_000));
      return setMeta(key, value);
    });
    const callsBeforeClose = anthropic.seen.length;
    await a.close();

    expect(anthropic.seen.length).toBeGreaterThan(callsBeforeClose);
    expect(rows<{ key: string }>("SELECT key FROM brain_meta WHERE key LIKE 'recipient:%' ORDER BY key")).toEqual([
      { key: 'recipient:compile:anthropic:claude-routed' },
      { key: 'recipient:model:anthropic:claude-routed' },
    ]);
  });
});

describe(`a tombstone ledger the export cannot read, on runtime ${RUNTIME}`, () => {
  it('is named in unread, and the export holds nothing of the person', async () => {
    const { a } = await open({ memoryPolicy: () => ({ longTerm: 'compiled', retentionDays: 7 }) });
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await a.memory!.compileWiki();
    // What the host's policy answered for the person is in a readable export.
    expect((await exportOf(a, 'alice')).retention).toEqual({ period: 'until-deletion', policyDays: 7 });
    vi.spyOn(a.memory!, 'isForgotten').mockRejectedValue(new Error('the ledger went away while reading LARK-7'));

    const doc = await exportOf(a, 'alice');

    expect(doc.unread.map((entry) => entry.store)).toEqual(['tombstone ledger']);
    expect(doc.unread[0].reason).not.toContain('LARK-7');
    expect(doc.traces).toEqual([]);
    expect(doc.pages).toEqual([]);
    expect(doc.provided.messages).toEqual([]);
    expect(doc.held.traces).toEqual([]);
    expect(doc.held.pages).toEqual([]);
    expect(doc.recipients).toEqual(OWN_ROUTE);
    // Nothing the host answered for the person: the agent's period alone.
    expect(doc.retention).toEqual({ period: 'until-deletion' });
    expect(doc.profiling).toEqual({ sentiment: 'off', moodStamps: 0 });
    expect(JSON.stringify(doc)).not.toContain('LARK-7');
    const unread = events.filter((line) => line.event === 'memory.export_unread');
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({ store: 'tombstone ledger' });
  });
});

describe("the embedding provider, on the GMI runtime with cognitive memory on", () => {
  it('is named as the embedding call resolves it: a prefixed model, and a provider named alone', async () => {
    const { a } = await open({
      runtime: 'gmi',
      memory: { embedding: { provider: 'openai', model: 'openai:text-embedding-3-small' } },
    } as Partial<SouledAgentOptions>);
    expect((await recipientsOf(a)).filter((entry) => entry.role === 'embedding')).toEqual([
      { role: 'embedding', provider: 'openai', model: 'text-embedding-3-small' },
    ]);
    await a.close();

    const { a: second } = await open({ runtime: 'gmi', memory: { embedding: { provider: 'openai' } } } as Partial<SouledAgentOptions>);
    expect((await recipientsOf(second)).filter((entry) => entry.role === 'embedding')).toEqual([
      { role: 'embedding', provider: 'openai', model: 'text-embedding-3-small' },
    ]);
  });
});

describe(`a call that names its own provider under the agent's router, on runtime ${RUNTIME}`, () => {
  it("names where the router's pick goes without the agent's key", async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const routedKey = `k-souled-export-or-${++n}`;
    vi.stubEnv('OPENROUTER_API_KEY', routedKey);
    const openrouter = script('openrouter', routedKey, { whole: true, replies: [reply.text('Via the gateway.')] });
    // An Anthropic agent with a key of its own: a call on another provider takes none of it to the router's pick.
    const { a } = await open({ provider: 'anthropic', model: 'claude-agent', router: routerPicking('anthropic', 'claude-routed') as never });

    const r = await a.generate('Hello.', { provider: 'openai' });

    expect(r.text).toBe('Via the gateway.');
    expect(openrouter.seen).toHaveLength(1);
    const listed = await recipientsOf(a);
    expect(listed).toContainEqual({ role: 'model', provider: 'openrouter', model: openrouter.seen[0].modelId });
  });
});

describe("a call that names its own provider under the agent's router, on the GMI runtime", () => {
  it("names where the router's pick went, and not the agent's own provider, which received nothing", async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const routedKey = `k-souled-export-or-${++n}`;
    vi.stubEnv('OPENROUTER_API_KEY', routedKey);
    const openrouter = script('openrouter', routedKey, { whole: true, replies: [reply.text('Via the gateway.')] });
    // An Anthropic agent with a key of its own: a call on another provider takes none of it to the router's pick.
    const { a } = await open({
      runtime: 'gmi',
      provider: 'anthropic',
      model: 'claude-agent',
      router: routerPicking('anthropic', 'claude-routed') as never,
    } as Partial<SouledAgentOptions>);

    const r = await a.generate('Hello.', { provider: 'openai' });

    expect(r.text).toBe('Via the gateway.');
    expect(openrouter.seen).toHaveLength(1);
    const listed = await recipientsOf(a);
    expect(listed).toContainEqual({ role: 'model', provider: 'openrouter', model: openrouter.seen[0].modelId });
    expect(listed).not.toContainEqual({ role: 'model', provider: 'anthropic', model: 'claude-routed' });
  });
});

describe('the embedding a GMI agent resolves at its first turn', () => {
  it('is named as it resolved then, after a restart too, when the default provider changed after the agent opened', async () => {
    const embeddings = `k-souled-export-embed-${++n}`;
    script('openai', embeddings, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', embeddings);
    const apiKey = `k-souled-export-${++n}`;
    // The stub embeds in 1536 values for either model; declared, so text-embedding-3-large builds on it too.
    const options = { runtime: 'gmi', memory: { embedding: { dimension: 1536 } } } as Partial<SouledAgentOptions>;
    const large: MemoryRecipient = { role: 'embedding', provider: 'openai', model: 'text-embedding-3-large' };
    try {
      const { a } = await open(options, apiKey);
      expect((await recipientsOf(a)).filter((entry) => entry.role === 'embedding')).toEqual([
        { role: 'embedding', provider: 'openai', model: 'text-embedding-3-small' },
      ]);

      setDefaultProvider({ provider: 'openai', model: 'text-embedding-3-large' });
      await turn(a, 's1', 'alice', 'My canary is LARK-7.');

      expect(await recipientsOf(a)).toContainEqual(large);
      await a.close();
    } finally {
      clearDefaultProvider();
    }
    const { a: again } = await open(options, apiKey);
    expect(await recipientsOf(again)).toContainEqual(large);
  });
});

describe('the embedding a GMI agent built, when the default provider changes after its first turn', () => {
  it('names the embedding the memory was built with, and not the later default, which received nothing', async () => {
    const embeddings = `k-souled-export-embed-${++n}`;
    const embedder = script('openai', embeddings, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', embeddings);
    const apiKey = `k-souled-export-${++n}`;
    const options = { runtime: 'gmi', memory: { embedding: { dimension: 1536 } } } as Partial<SouledAgentOptions>;
    try {
      const { a } = await open(options, apiKey);
      await turn(a, 's1', 'alice', 'My canary is LARK-7.');
      // The memory was built at the first turn, and embedded the person's words there.
      await vi.waitFor(() => expect(embedder.embedded.some((text) => text.includes('LARK-7'))).toBe(true), { timeout: 4_000 });

      setDefaultProvider({ provider: 'openai', model: 'text-embedding-3-large' });
      await turn(a, 's1', 'alice', 'I keep it in the attic.');

      expect((await recipientsOf(a)).filter((entry) => entry.role === 'embedding')).toEqual([
        { role: 'embedding', provider: 'openai', model: 'text-embedding-3-small' },
      ]);
    } finally {
      clearDefaultProvider();
    }
  });
});

describe('the embedding a GMI agent built, when the store fails to record it once', () => {
  it('is recorded again at the next turn, and named after a restart', async () => {
    const embeddings = `k-souled-export-embed-${++n}`;
    script('openai', embeddings, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', embeddings);
    const apiKey = `k-souled-export-${++n}`;
    const options = { runtime: 'gmi', memory: { embedding: { dimension: 1536 } } } as Partial<SouledAgentOptions>;
    const large: MemoryRecipient = { role: 'embedding', provider: 'openai', model: 'text-embedding-3-large' };
    try {
      const { a } = await open(options, apiKey);
      const brain = brainBehind(a);
      const setMeta = brain.setMeta.bind(brain);
      let refused = 0;
      vi.spyOn(brain, 'setMeta').mockImplementation(async (key: string, value: string) => {
        if (key.startsWith('recipient:embedding:') && refused === 0) {
          refused += 1;
          throw new Error('the store is busy');
        }
        return setMeta(key, value);
      });
      // The memory is built at the first turn on the default changed since the agent opened; its route's write fails.
      setDefaultProvider({ provider: 'openai', model: 'text-embedding-3-large' });
      await turn(a, 's1', 'alice', 'My canary is LARK-7.');
      await vi.waitFor(() => expect(events.some((line) => line.event === 'memory.recipient_unrecorded')).toBe(true));
      expect(refused).toBe(1);

      await turn(a, 's1', 'alice', 'I keep it in the attic.');
      await a.close();
    } finally {
      clearDefaultProvider();
    }
    const { a: again } = await open(options, apiKey);
    expect(await recipientsOf(again)).toContainEqual(large);
  });
});

describe('the export over an archive and a live memory graph', () => {
  it("holds each held trace's archived original and a live graph's links between the person's own traces", async () => {
    const { a } = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's2', 'bob', 'My canary is WREN-2.');
    const said = saidOf(keyOf(alice));
    const [bobs] = saidOf(keyOf(bob));
    // Originals planted through a real archive on the store's own database: one of the person's, one of another's.
    const brain = brainBehind(a);
    const archive = new SqlStorageMemoryArchive(brain.adapter, brain.features, brain.brainId);
    await archive.initialize();
    const original = 'My canary is LARK-7, the yellow one with a ring.';
    for (const [traceId, text] of [
      [said[0].id, original],
      [bobs.id, 'WREN-2, the original words.'],
    ] as const) {
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
    const asked: Array<string | undefined> = [];

    const doc = await exportSubjectMemory({
      memory: a.memory!,
      wiki: { storeFor: () => ({ listPages: async () => [] }) },
      agentId: 'aria-1',
      subject: alice,
      archive: {
        rehydrate: (traceId, context) => {
          asked.push(context);
          return archive.rehydrate(traceId, context);
        },
      },
      liveGraph: {
        getEdges: (memoryId) =>
          memoryId === said[0].id
            ? [
                { sourceId: said[0].id, targetId: said[1].id, type: 'TEMPORAL_SEQUENCE', weight: 0.4 },
                { sourceId: said[0].id, targetId: bobs.id, type: 'SAME_TOPIC', weight: 0.9 },
              ]
            : [],
      },
    });

    expect(doc.held.archivedOriginals).toEqual([{ traceId: said[0].id, text: original }]);
    // Each held trace is asked for once, as an export's read.
    expect(asked).toEqual(said.map(() => 'user_export'));
    expect(doc.held.graphLinks).toEqual([{ from: said[0].id, to: said[1].id, type: 'TEMPORAL_SEQUENCE', weight: 0.4 }]);
    expect(JSON.stringify(doc)).not.toContain('WREN-2');
    expect(JSON.stringify(doc)).not.toContain(bobs.id);
  });
});
