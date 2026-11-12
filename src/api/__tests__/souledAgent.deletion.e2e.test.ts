/**
 * A souled agent's memory of one person, deleted and kept deleted, end to end over the real agent, GMI, generateText,
 * provider manager, Memory store and wiki; only the OpenAI provider class is stubbed (helpers/stubProviders.ts), at
 * its module boundary.
 *
 * - The store opens with its forgotten-user ledger and keeps the ledger's second copy beside it, with `secure_delete`
 *   on.
 * - A forgotten user's writes are refused, or taken back when they land after the tombstone; recall and
 *   `read_memory_page` answer nothing for them, and a compile writes no page for them. A host's own memory provider
 *   is guarded the same way by `guardMemoryProvider`.
 * - `forgetUser` deletes one user for good (traces, soft-deleted rows, document chunks, pages, the registry row, the
 *   bytes in the store's files) and leaves everyone else; it waits for the user's writes in flight, goes on past its
 *   deadline and says so, and its report names every store it did not reach and never the user.
 * - Every open applies the tombstones again from a copy a restore does not replace: a store put back from before a
 *   deletion forgets again, a page a deletion could not delete goes at the next open, and a store whose copy or key
 *   is missing does not open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import type { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { ForgottenLedger } from '../../cognition/memory/suppression/ForgottenLedger';
import { canonicalJson } from '../../cognition/learning/ledger/canonical';
import { tombstoneHash } from '../../cognition/learning/ledger/Ledger';
import { UserWikiStore } from '../../cognition/substrate/memory/wiki/UserWikiStore';
import type { AgentMemoryProvider, MemoryHookContext } from '../agent';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { guardMemoryProvider } from '../../cognition/memory/suppression/guardMemoryProvider';

let n = 0;
let dir: string;
const opened: SouledAgent[] = [];
/** Every line the library logged in the test, parsed. */
let events: Array<Record<string, unknown>>;
beforeEach(() => {
  globalLLMProviderHealth.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-deletion-e2e-'));
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (opened.length) await opened.pop()!.close().catch(() => undefined);
  resetLoggerFactory();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The logged lines of one event. */
const lines = (event: string) => events.filter((line) => line.event === event);

const storeFile = () => path.join(dir, 'memory', '.store', 'memory.sqlite');
const copyFile = () => path.join(dir, 'memory', '.store', 'forgotten.sqlite');
const keyOf = (subject: { kind: 'user' | 'session'; id: string }) => conversationScopeKey('aria-1', subject);
const alice = { kind: 'user' as const, id: 'alice' };
const bob = { kind: 'user' as const, id: 'bob' };

let replyNo = 0;
/** Replies to spare, each with words of its own: the store keeps one trace for a text a subject's memory already holds. */
const spare = (): ProviderScript['replies'] => Array.from({ length: 60 }, () => reply.text(`Noted ${++replyNo}.`));

/**
 * A souled agent on the stubbed provider. The model answers `first`, then replies to spare; `retention` is set so
 * two users may share the store.
 */
async function open(
  extra: Partial<SouledAgentOptions> = {},
  first: ProviderScript['replies'] = [],
): Promise<{ a: SouledAgent; s: ProviderScript }> {
  const apiKey = `k-souled-deletion-${++n}`;
  const s = script('openai', apiKey, { whole: true, replies: [...first, ...spare()] });
  const a = await souledAgent({
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    soul: dir,
    retention: { traces: 'until-deletion' },
    ...extra,
  } as unknown as SouledAgentOptions);
  opened.push(a);
  return { a, s };
}

/** Rows of a SQLite file, read by a connection of the test's own. */
function rows<T>(file: string, sql: string, params: unknown[] = []): T[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
const tracesOf = (key: string) =>
  rows<{ id: string; content: string; deleted: number; tags: string }>(
    storeFile(),
    "SELECT id, content, deleted, tags FROM memory_traces WHERE scope = 'conversation' AND scope_id = ? ORDER BY created_at, id",
    [key],
  );
/** What a subject and the agent said to each other, as the store holds it: the subject's traces without its pages' chunks. */
const saidOf = (key: string) => tracesOf(key).filter((trace) => !(JSON.parse(trace.tags) as string[]).includes('wiki'));
/** The page rows and the registry row the store holds under one key. */
const pagesOf = (key: string) => rows<{ page_id: string }>(storeFile(), 'SELECT page_id FROM memory_pages WHERE scope_id = ?', [key]);
const registryOf = (key: string) => rows<{ scope_id: string }>(storeFile(), 'SELECT scope_id FROM memory_scopes WHERE scope_id = ?', [key]);

/** The Brain behind a souled agent's store, for the rows a case plants. */
const brainOf = (a: SouledAgent): Brain => (a.memory as unknown as { _brain: Brain })._brain;

/** Files one document with one chunk on a trace, by SQL: `Memory.ingest()` files its traces under no scope id. */
async function plantDocument(a: SouledAgent, traceId: string): Promise<void> {
  const brain = brainOf(a);
  await brain.run(
    'INSERT INTO documents (brain_id, id, path, format, content_hash, chunk_count, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [brain.brainId, 'doc_1', 'handbook.md', 'md', 'h', 1, Date.now()],
  );
  await brain.run(
    'INSERT INTO document_chunks (brain_id, id, document_id, trace_id, content, chunk_index) VALUES (?, ?, ?, ?, ?, ?)',
    [brain.brainId, 'chunk_0', 'doc_1', traceId, 'the handbook she uploaded', 0],
  );
}

/** One turn of a user, and a wait until both of its traces (the user's text and the reply) are stored. */
async function turn(a: SouledAgent, sessionId: string, userId: string | undefined, text: string): Promise<void> {
  const key = keyOf(userId ? { kind: 'user', id: userId } : { kind: 'session', id: sessionId });
  const before = tracesOf(key).length;
  await a.session(sessionId, userId ? { userId } : undefined).send(text);
  await vi.waitFor(() => expect(tracesOf(key).length).toBeGreaterThanOrEqual(before + 2), { timeout: 4_000 });
}

/** Makes every write to the agent's store wait `ms` first. */
function slowWrites(memory: NonNullable<SouledAgent['memory']>, ms: number): void {
  const remember = memory.remember.bind(memory);
  vi.spyOn(memory, 'remember').mockImplementation(async (...args: Parameters<typeof remember>) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return remember(...args);
  });
}

/** The recall block one model call was sent: the user-role message that opens with `<memory_recall>`; none when the turn recalled nothing. */
const recallBlockIn = (call: ProviderScript['seen'][number]): string | undefined => {
  const block = call.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<memory_recall>'));
  return block ? (block.content as unknown as string) : undefined;
};

/** The text of every tool message one model call was sent, joined. */
const toolAnswerIn = (call: ProviderScript['seen'][number]): string =>
  call.messages
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');

describe('a forgotten subject', () => {
  it('keeps a tombstone copy beside the store', async () => {
    const { a } = await open();
    expect(fs.existsSync(copyFile())).toBe(true);
    const brain = (a.memory as never as { _brain: { get(sql: string): Promise<Record<string, number> | null> } })._brain;
    expect(Number(Object.values((await brain.get('PRAGMA secure_delete'))!)[0])).toBe(1);
  });

  it('files nothing for a forgotten user and says so once per refused write', async () => {
    const { a } = await open({}, [reply.text('Tea it is.'), reply.text('A fine canary.')]);
    await turn(a, 's1', 'bob', 'I like tea.');
    await a.memory!.markForgotten(alice);
    const answer = await a.session('s2', { userId: 'alice' }).send('My canary is LARK-7.');
    expect(answer.text).toBe('A fine canary.');
    await a.close();

    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(rows(storeFile(), "SELECT id FROM memory_traces WHERE content LIKE '%LARK-7%'")).toEqual([]);
    const refused = lines('memory.write_refused');
    expect(refused).toHaveLength(2);
    for (const line of refused) expect(line).toMatchObject({ reason: 'forgotten' });
    expect(saidOf(keyOf(bob))).toHaveLength(2);
  });

  it('takes back a write that passed its first check before the tombstone', async () => {
    const { a } = await open();
    slowWrites(a.memory!, 300);
    await a.session('s1', { userId: 'alice' }).send('My canary is LARK-7.');
    await a.memory!.markForgotten(alice);
    await a.close();

    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(rows(storeFile(), "SELECT id FROM memory_traces WHERE content LIKE '%LARK-7%'")).toEqual([]);
    expect(lines('memory.write_refused')).toHaveLength(2);
    for (const line of lines('memory.write_refused')) expect(line).toMatchObject({ reason: 'forgotten' });
  });

  it('recalls nothing for a forgotten user', async () => {
    const { a, s } = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's2', 'bob', 'My canary is WREN-2.');
    await a.memory!.markForgotten(alice);

    await a.session('s3', { userId: 'alice' }).send('What is my canary?');
    expect(recallBlockIn(s.seen.at(-1)!)).toBeUndefined();
    expect(JSON.stringify(s.seen.at(-1)!.messages)).not.toContain('LARK-7');

    await a.session('s4', { userId: 'bob' }).send('What is my canary?');
    expect(recallBlockIn(s.seen.at(-1)!)).toContain('WREN-2');
  });

  it('answers the page tool as not found for a forgotten asker', async () => {
    const { a, s } = await open({}, [
      reply.text('Noted.'),
      reply.text('The user keeps a canary.'),
      reply.tools([{ id: 'c1', name: 'read_memory_page', args: { id: 'concepts/notes' } }]),
      reply.text('Done.'),
    ]);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await a.memory!.compileWiki();
    expect(rows(storeFile(), 'SELECT page_id FROM memory_pages WHERE scope_id = ?', [keyOf(alice)])).toEqual([
      { page_id: 'concepts/notes' },
    ]);
    await a.memory!.markForgotten(alice);

    await a.session('s5', { userId: 'alice' }).send('Read my notes.');
    const answered = toolAnswerIn(s.seen.at(-1)!);
    expect(answered).toContain('No memory page found with id');
    expect(answered).toContain('concepts/notes');
    expect(answered).not.toContain('canary');
    const refused = lines('memory.page_read_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ reason: 'forgotten' });
  });

  it('writes no page for a subject forgotten before the compile reaches it', async () => {
    const { a } = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await a.memory!.markForgotten(alice);
    await a.memory!.compileWiki();

    expect(rows(storeFile(), 'SELECT page_id FROM memory_pages WHERE scope_id = ?', [keyOf(alice)])).toEqual([]);
    expect(lines('memory.compile_skipped').map((line) => line.reason)).toContain('forgotten');
  });

  it('guards a provider a host wires itself', async () => {
    const { a } = await open();
    const calls: unknown[][] = [];
    const provider: AgentMemoryProvider = {
      observe: async (...args) => {
        calls.push(args);
      },
      getContext: async () => ({ contextText: 'x' }),
    };
    const guarded = guardMemoryProvider(provider, a.memory!.forgotten!);
    await a.memory!.markForgotten(alice);

    const forAlice: MemoryHookContext = { sessionId: 's', userId: 'alice', subject: alice, call: 'session' };
    await guarded.observe!('user', 'hello', forAlice);
    expect(calls).toEqual([]);
    expect(await guarded.getContext!('q', { context: forAlice })).toBeNull();
    expect(lines('memory.write_refused')).toHaveLength(1);
    expect(lines('memory.write_refused')[0]).toMatchObject({ reason: 'forgotten' });

    const forBob: MemoryHookContext = { sessionId: 's', userId: 'bob', subject: bob, call: 'session' };
    await guarded.observe!('user', 'hello', forBob);
    expect(calls).toEqual([['user', 'hello', forBob]]);
    expect(await guarded.getContext!('q', { context: forBob })).toEqual({ contextText: 'x' });
  });
});

describe('forgetUser', () => {
  it('deletes one user for good and leaves the other', async () => {
    const { a } = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's2', 'bob', 'My canary is WREN-2.');
    const said = tracesOf(keyOf(alice)).find((trace) => trace.content === 'My canary is LARK-7.')!;
    const replied = tracesOf(keyOf(alice)).find((trace) => trace.id !== said.id)!;
    await plantDocument(a, said.id);
    await brainOf(a).run('UPDATE memory_traces SET deleted = 1 WHERE id = ?', [replied.id]);
    await a.memory!.compileWiki();
    expect(pagesOf(keyOf(alice))).toHaveLength(1);
    expect(pagesOf(keyOf(bob))).toHaveLength(1);
    const ofBob = tracesOf(keyOf(bob));

    const report = await a.forgetUser!('alice');

    // The bytes of what she said are in neither file of the store, with the store still open.
    expect(fs.readFileSync(storeFile()).includes('LARK-7')).toBe(false);
    const log = `${storeFile()}-wal`;
    expect(fs.existsSync(log) && fs.readFileSync(log).includes('LARK-7')).toBe(false);

    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(rows(storeFile(), "SELECT id FROM memory_traces WHERE content LIKE '%LARK-7%'")).toEqual([]);
    expect(rows(storeFile(), 'SELECT id FROM document_chunks')).toEqual([]);
    expect(rows(storeFile(), 'SELECT id FROM documents')).toEqual([]);
    expect(pagesOf(keyOf(alice))).toEqual([]);
    expect(registryOf(keyOf(alice))).toEqual([]);
    expect(await a.memory!.recall('canary', { scope: 'conversation', scopeId: keyOf(alice) })).toEqual([]);

    expect(tracesOf(keyOf(bob))).toEqual(ofBob);
    expect(pagesOf(keyOf(bob))).toHaveLength(1);
    const recalled = await a.memory!.recall('canary', { scope: 'conversation', scopeId: keyOf(bob) });
    expect(recalled.some(({ trace }) => trace.content.includes('WREN-2'))).toBe(true);

    expect(report.tombstone).toEqual({ form: 'unkeyed', written: true });
    expect(report.pages).toEqual({ deleted: 1, failed: [] });
    const store = (name: string) => report.stores.find((entry) => entry.store === name);
    expect(store('conversation memory')).toMatchObject({ reached: true });
    expect((store('conversation memory') as { deleted: number }).deleted).toBeGreaterThanOrEqual(2);
    expect(store('traces that name the user under other scopes')).toMatchObject({ reached: true });
    expect(store('vector index')).toMatchObject({ reached: true });
    expect(store('write-ahead log')).toMatchObject({ reached: true });
    expect(store('learning store')).toMatchObject({ reached: false });
    expect(store("a conversation's own history")).toMatchObject({ reached: false });
    expect(store('session history in this process')).toEqual({ store: 'session history in this process', reached: true, deleted: 1 });
    expect(a.session('s1', { userId: 'alice' }).messages()).toEqual([]);
    expect(a.session('s2', { userId: 'bob' }).messages().length).toBeGreaterThanOrEqual(2);
    expect(report.pendingAtDeadline).toBe(0);
    expect(report.complete).toBe(true);
    expect(JSON.stringify(report)).not.toContain('alice');
    expect(JSON.stringify(report)).not.toContain('LARK-7');

    const done = lines('memory.forget_done');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ complete: 'yes', pages: 1, pagesFailed: 0, pendingAtDeadline: 0 });
    expect(JSON.stringify(events)).not.toContain('alice');
    expect(JSON.stringify(events)).not.toContain('LARK-7');
  });

  it('keeps the user deleted, and writes no second tombstone', async () => {
    const { a } = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    expect((await a.forgetUser!('alice')).complete).toBe(true);
    await a.session('s3', { userId: 'alice' }).send('I am back.');
    await a.close();
    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(rows(storeFile(), "SELECT id FROM memory_traces WHERE content LIKE '%I am back%'")).toEqual([]);

    const { a: again } = await open();
    const report = await again.forgetUser!('alice');
    expect(report.tombstone.written).toBe(false);
    expect(report.complete).toBe(true);
  });

  it('waits for the writes in flight', async () => {
    const { a } = await open();
    slowWrites(a.memory!, 100);
    await a.session('s1', { userId: 'alice' }).send('My canary is LARK-7.');
    const report = await a.forgetUser!('alice');
    expect(report.drained).toBeGreaterThanOrEqual(1);
    expect(report.pendingAtDeadline).toBe(0);
    expect(report.complete).toBe(true);
    await a.close();
    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(registryOf(keyOf(alice))).toEqual([]);
  });

  it('goes on past the deadline, says so, and the late write is taken back', async () => {
    const { a } = await open({ pendingWritesTimeoutMs: 50 });
    slowWrites(a.memory!, 400);
    await a.session('s1', { userId: 'alice' }).send('My canary is LARK-7.');
    const report = await a.forgetUser!('alice');
    expect(report.pendingAtDeadline).toBeGreaterThanOrEqual(1);
    expect(report.complete).toBe(false);
    expect(lines('memory.forget_done')[0]).toMatchObject({ complete: 'no' });

    // The write that was running lands after the tombstone and is taken back; the reply's write is refused.
    await vi.waitFor(() => expect(lines('memory.write_refused')).toHaveLength(2), { timeout: 4_000 });
    for (const line of lines('memory.write_refused')) expect(line).toMatchObject({ reason: 'forgotten' });
    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(registryOf(keyOf(alice))).toEqual([]);
  });

  it('reports a vector index it could not rewrite', async () => {
    const { a } = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    vi.spyOn(a.memory!, 'rebuildVectorIndex').mockRejectedValueOnce(new Error('disk full'));
    const report = await a.forgetUser!('alice');
    expect(report.stores).toContainEqual({ store: 'vector index', reached: false, reason: 'disk full' });
    expect(report.complete).toBe(false);
    expect(tracesOf(keyOf(alice))).toEqual([]);
  });

  it('keeps a user and an anonymous session of one id apart, and deletes the sessions the host links', async () => {
    const { a } = await open();
    const sessionBob = { kind: 'session' as const, id: 'bob' };
    const visitor = { kind: 'session' as const, id: 's1' };
    await turn(a, 's-user', 'bob', 'user words');
    await turn(a, 'bob', undefined, 'session words');
    await turn(a, 's1', undefined, 'visitor words');

    await a.forgetUser!('bob');
    expect(tracesOf(keyOf(bob))).toEqual([]);
    expect(tracesOf(keyOf(sessionBob))).toHaveLength(2);
    expect(tracesOf(keyOf(visitor))).toHaveLength(2);

    const report = await a.forgetUser!('bob', { linkedSessions: ['s1'] });
    expect(tracesOf(keyOf(visitor))).toEqual([]);
    expect(tracesOf(keyOf(sessionBob))).toHaveLength(2);
    expect(await a.memory!.isForgotten(visitor)).toBe(true);
    expect(await a.memory!.isForgotten(sessionBob)).toBe(false);
    expect(report.stores).toContainEqual(expect.objectContaining({ store: 'conversation memory (linked session)', reached: true }));
    expect(report.complete).toBe(true);
    expect(lines('memory.forget_done')).toHaveLength(3);
  });

  it('a compile and a deletion started together leave no page', async () => {
    const { a } = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await Promise.all([a.memory!.compileWiki(), a.forgetUser!('alice')]);
    expect(pagesOf(keyOf(alice))).toEqual([]);
    expect(tracesOf(keyOf(alice))).toEqual([]);
  });

  it('refuses an empty user id and deletes nothing', async () => {
    const { a } = await open();
    await turn(a, 's1', 'bob', 'I like tea.');
    await expect(a.forgetUser!('')).rejects.toThrow(TypeError);
    await expect(a.forgetUser!('bob', { linkedSessions: [''] })).rejects.toThrow(TypeError);
    expect(tracesOf(keyOf(bob))).toHaveLength(2);
    expect(await a.memory!.isForgotten(bob)).toBe(false);
  });

  it('shares one ledger with the learning layer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { a } = await open({ runtime: 'gmi', learning: true });
    await a.learning!.forgetUser!('alice');
    await a.session('s1', { userId: 'alice' }).send('My canary is LARK-7.');
    await a.close();
    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(lines('memory.write_refused').some((line) => line.reason === 'forgotten')).toBe(true);

    const { a: again } = await open({ runtime: 'gmi', learning: true });
    await turn(again, 's2', 'bob', 'My canary is WREN-2.');
    const report = await again.forgetUser!('bob');
    expect(report.stores).toContainEqual(expect.objectContaining({ store: 'learning store', reached: true }));
    expect(report.stores).toContainEqual(expect.objectContaining({ store: "a gmi() session's history", reached: false }));
    expect(tracesOf(keyOf(bob))).toEqual([]);
  });

  it('names legacy memory it did not reach until the host deletes it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const oldFile = path.join(dir, 'memory', 'concepts', 'old.md');
    const old = '---\nid: concepts/old\ntype: concept\nsummary: Old notes.\nsources:\n  - t-old\n---\nThe heron lives by the weir.\n';
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, old);
    const { a } = await open();
    await a.memory!.remember('old shared words', { type: 'episodic', scope: 'persona', scopeId: 'aria-1' });
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');

    const report = await a.forgetUser!('alice');
    expect(report.stores).toContainEqual({ store: 'legacy memory under the agent scope', reached: false, reason: 'unattributed' });
    expect(report.complete).toBe(false);
    expect(rows(storeFile(), "SELECT content FROM memory_traces WHERE scope = 'persona'")).toEqual([{ content: 'old shared words' }]);
    expect(fs.readFileSync(oldFile, 'utf8')).toBe(old);

    await a.memory!.deleteScope('persona', 'aria-1');
    fs.rmSync(oldFile);
    const again = await a.forgetUser!('alice');
    expect(again.complete).toBe(true);
    expect(again.stores.some((entry) => entry.store.startsWith('legacy memory'))).toBe(false);
  });
});

describe('tombstones after a restore', () => {
  /** Puts a copy of the store's file back in its place, as a restore does; every agent on the folder is closed first. */
  function swapStore(from: string): void {
    fs.copyFileSync(from, storeFile());
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${storeFile()}${suffix}`, { force: true });
  }
  const ledgerRows = () => rows<{ hash: string }>(storeFile(), 'SELECT hash FROM agentos_learning_forgotten').map((row) => row.hash);

  it('cleans a store put back from before the deletion, at the next open', async () => {
    const { a } = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's2', 'bob', 'My canary is WREN-2.');
    await a.memory!.compileWiki();
    await a.close();
    const backup = path.join(dir, 'backup.sqlite');
    fs.copyFileSync(storeFile(), backup);

    const { a: second } = await open();
    expect((await second.forgetUser!('alice')).complete).toBe(true);
    await second.close();
    swapStore(backup);
    expect(saidOf(keyOf(alice))).toHaveLength(2);
    expect(ledgerRows()).not.toContain(await ForgottenLedger.hash('', alice));

    events.length = 0;
    await open();
    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(pagesOf(keyOf(alice))).toEqual([]);
    expect(registryOf(keyOf(alice))).toEqual([]);
    expect(saidOf(keyOf(bob))).toHaveLength(2);
    expect(pagesOf(keyOf(bob))).toHaveLength(1);
    expect(ledgerRows()).toContain(await ForgottenLedger.hash('', alice));
    expect(lines('memory.tombstone_reapplied')).toHaveLength(1);
    expect(lines('memory.tombstone_reapplied')[0]).toMatchObject({ subjects: 1, reconciled: 1 });
  });

  it('applies tombstones on demand, and does nothing on a clean store', async () => {
    const { a } = await open();
    await turn(a, 's1', 'bob', 'I like tea.');
    expect(await a.applyTombstones!()).toEqual([]);
    expect(lines('memory.tombstone_reapplied')).toEqual([]);

    await a.memory!.markForgotten(alice);
    // A trace another process stored after the tombstone.
    const brain = brainOf(a);
    await brain.run(
      `INSERT INTO memory_traces
         (brain_id, id, type, scope, content, embedding, strength, created_at,
          last_accessed, retrieval_count, tags, emotions, metadata, deleted, scope_id)
       VALUES (?, ?, 'episodic', 'conversation', ?, NULL, 1.0, ?, NULL, 0, '[]', '{}', '{}', 0, ?)`,
      [brain.brainId, 'late-1', 'late words', Date.now(), keyOf(alice)],
    );
    expect(tracesOf(keyOf(alice))).toHaveLength(1);

    const reports = await a.applyTombstones!();
    expect(reports).toHaveLength(1);
    expect(reports[0].tombstone.written).toBe(false);
    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(saidOf(keyOf(bob))).toHaveLength(2);
    expect(lines('memory.tombstone_reapplied')).toHaveLength(1);
    expect(lines('memory.tombstone_reapplied')[0]).toMatchObject({ subjects: 1, reconciled: 0 });
  });

  it('does not open without its tombstone copy', async () => {
    const { a } = await open();
    await a.close();
    fs.rmSync(copyFile());
    await expect(open()).rejects.toMatchObject({ name: 'ForgottenLedgerError', code: 'COPY_UNAVAILABLE' });
    expect(fs.existsSync(copyFile())).toBe(false);

    fs.writeFileSync(copyFile(), 'not a database');
    await expect(open()).rejects.toMatchObject({ name: 'ForgottenLedgerError', code: 'COPY_UNAVAILABLE' });
  });

  it('keys the tombstones, keeps the old ones in force, and stays closed without the key', async () => {
    const users = ['alice', 'bob', 'carol'];
    const first = await open();
    await first.a.forgetUser!('bob');
    await first.a.close();

    const { a } = await open({ tombstoneKey: 'k-one' });
    await a.forgetUser!('alice');
    // A tombstone in the learning layer's own form, as a release before the shared ledger wrote it.
    await brainOf(a).run('INSERT INTO agentos_learning_forgotten (hash, namespace, forgotten_at) VALUES (?, ?, ?)', [
      await tombstoneHash('', 'carol'),
      '',
      new Date().toISOString(),
    ]);
    const stored = ledgerRows();
    expect(stored).toContain(createHmac('sha256', 'k-one').update(canonicalJson(['', 'user', 'alice'])).digest('hex'));
    expect(stored.filter((hash) => hash.startsWith('k1:'))).toHaveLength(1);
    for (const user of users) await a.session(`s-${user}`, { userId: user }).send(`I am ${user}.`);
    await a.close();
    for (const user of users) expect(tracesOf(keyOf({ kind: 'user', id: user }))).toEqual([]);

    await expect(open()).rejects.toMatchObject({
      name: 'ForgottenLedgerError',
      code: 'KEY_REQUIRED',
      message: expect.stringMatching(/tombstoneKey/),
    });

    const { a: rotated } = await open({ tombstoneKey: { current: 'k-two', previous: ['k-one'] } });
    for (const user of users) await rotated.session(`t-${user}`, { userId: user }).send(`It is ${user} again.`);
    await rotated.close();
    for (const user of users) expect(tracesOf(keyOf({ kind: 'user', id: user }))).toEqual([]);
  });

  it('keeps a page it could not delete away from its user, and removes it at the next open', async () => {
    const { a, s } = await open({}, [
      reply.text('Noted.'),
      reply.text('The user keeps a canary.'),
      reply.tools([{ id: 'c1', name: 'read_memory_page', args: { id: 'concepts/notes' } }]),
      reply.text('Done.'),
    ]);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await a.memory!.compileWiki();
    vi.spyOn(UserWikiStore.prototype, 'deletePage').mockRejectedValueOnce(new Error('disk I/O error'));

    const report = await a.forgetUser!('alice');
    expect(report.pages.failed).toEqual([{ id: 'concepts/notes', reason: expect.any(String) }]);
    expect(report.complete).toBe(false);
    expect(pagesOf(keyOf(alice))).toHaveLength(1);

    await a.session('s5', { userId: 'alice' }).send('Read my notes.');
    expect(toolAnswerIn(s.seen.at(-1)!)).toContain('No memory page found with id');
    expect(lines('memory.page_read_refused')).toHaveLength(1);
    expect(lines('memory.page_read_refused')[0]).toMatchObject({ reason: 'forgotten' });
    await a.close();

    events.length = 0;
    await open();
    expect(pagesOf(keyOf(alice))).toEqual([]);
    expect(registryOf(keyOf(alice))).toEqual([]);
    expect(lines('memory.tombstone_reapplied')).toHaveLength(1);
    expect(lines('memory.tombstone_reapplied')[0]).toMatchObject({ subjects: 1 });
  });
});
