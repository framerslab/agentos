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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import type { MemoryRecipient } from '../runtime/memoryRecipients';
import type { UserMemoryExport } from '../../cognition/memory/io/userMemoryExport';
import type { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { SqlMemoryGraph } from '../../cognition/memory/retrieval/store/SqlMemoryGraph';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

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
beforeEach(() => {
  globalLLMProviderHealth.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-export-e2e-'));
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\nagentId: aria-1\n---\nYou are Aria.');
  setLogger(pino({ level: 'debug', base: undefined }, { write: () => undefined }));
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
    expect(doc.traces.map((trace) => trace.text)).toContain('My canary is LARK-7.');

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
