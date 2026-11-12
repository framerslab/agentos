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
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
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
  rows<{ id: string; content: string; deleted: number }>(
    storeFile(),
    "SELECT id, content, deleted FROM memory_traces WHERE scope = 'conversation' AND scope_id = ?",
    [key],
  );

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
    expect(tracesOf(keyOf(bob))).toHaveLength(2);
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
    const forAlice = JSON.stringify(s.seen.at(-1)!.messages);
    expect(forAlice).not.toContain('memory_recall');
    expect(forAlice).not.toContain('LARK-7');

    await a.session('s4', { userId: 'bob' }).send('What is my canary?');
    const forBob = JSON.stringify(s.seen.at(-1)!.messages);
    expect(forBob).toContain('memory_recall');
    expect(forBob).toContain('WREN-2');
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
