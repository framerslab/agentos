/**
 * Deleting or correcting one memory of a person on a souled agent whose memory provider files its turns, end to end
 * over the real agent, generateText, GMI, provider manager, Memory store and wiki; only the OpenAI provider class is
 * stubbed (helpers/stubProviders.ts), at its module boundary.
 *
 * - `correctUserMemory(userId, { traceIds })` with no `text` deletes the named traces for good and files nothing in
 *   their place: the page built from them goes, the next compile builds it again from what is left, and the export
 *   and a new session's recall hold the person's other memories and never the deleted one.
 * - A deletion and a correction both name who received a person's text (`recipients`), and still run when the routes
 *   the store recorded cannot be read.
 * - A turn that recalled a memory which a correction or a single deletion took away while the turn's model call was
 *   open, or that began while the call was still deleting, does not file its reply (`skipped`, `corrected`): the reply
 *   can restate what was just deleted. The person's
 *   own message of that turn is filed, and so is the whole of the session's next turn.
 * - Another person's running turn is filed whole, and so is a turn that overlapped a call the agent rejected. A call
 *   that fails after its ownership check keeps the running turn's reply out too, and is finished when made again.
 * - An id that is not one of the person's own traces rejects the call, with or without `text`, and changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
/** The read of the routes a store recorded: it throws `fail` while a case sets one. */
const recordedRoutes = vi.hoisted(() => ({ fail: undefined as Error | undefined }));
vi.mock('../runtime/memoryRecipients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/memoryRecipients')>();
  return {
    ...actual,
    recordedRecipients: async (...args: Parameters<typeof actual.recordedRecipients>) => {
      if (recordedRoutes.fail) throw recordedRoutes.fail;
      return actual.recordedRecipients(...args);
    },
  };
});
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import type { MemoryRecipient } from '../runtime/memoryRecipients';
import type { MemoryWriteRecord } from '../runtime/memoryWriteRecord';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';

/** The runtimes the cases run on: the default one, and the GMI runtime with cognitive memory off. */
const RUNTIMES = ['legacy', 'gmi'] as const;
type Runtime = (typeof RUNTIMES)[number];

let n = 0;
let dir: string;
const closers: Array<() => Promise<unknown>> = [];
/** Every line the library logged in the case, parsed. */
let events: Array<Record<string, unknown>>;
beforeEach(() => {
  globalLLMProviderHealth.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-correction-e2e-'));
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
  recordedRoutes.fail = undefined;
  vi.restoreAllMocks();
  while (closers.length) await closers.pop()!().catch(() => undefined);
  resetLoggerFactory();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The logged lines of one event. */
const lines = (event: string) => events.filter((line) => line.event === event);

const storeFile = () => path.join(dir, 'memory', '.store', 'memory.sqlite');
const keyOf = (subject: { kind: 'user' | 'session'; id: string }) => conversationScopeKey('aria-1', subject);
const alice = { kind: 'user' as const, id: 'alice' };
const bob = { kind: 'user' as const, id: 'bob' };

let replyNo = 0;
/** Replies to spare, each with words of its own: the store keeps one trace for a text a subject's memory already holds. */
const spare = (): ProviderScript['replies'] => Array.from({ length: 12 }, () => reply.text(`Noted ${++replyNo}.`));

/** The script the provider of the agent opened last plays: every request it served is in `seen`. */
let served: ProviderScript;

/**
 * A souled agent on the stubbed provider, which answers with `replies` in order; `retention` and `tombstoneKey` are
 * set so two people may share the store.
 */
async function open(runtime: Runtime, replies: ProviderScript['replies'] = spare()): Promise<SouledAgent> {
  const apiKey = `k-souled-correction-${++n}`;
  served = script('openai', apiKey, { whole: true, replies });
  const a = await souledAgent({
    runtime,
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    soul: dir,
    retention: { traces: 'until-deletion' },
    tombstoneKey: 'k-souled-correction-tombstones',
  } as unknown as SouledAgentOptions);
  closers.push(() => a.close());
  return a;
}

interface StoredTrace {
  id: string;
  content: string;
  tags: string;
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
/** What a person and the agent said to each other, as the store holds it under `key`: its traces without its pages' chunks. */
const saidOf = (key: string): StoredTrace[] =>
  rows<StoredTrace>("SELECT id, content, tags FROM memory_traces WHERE scope = 'conversation' AND scope_id = ? ORDER BY created_at, id", [key]).filter(
    (row) => !(JSON.parse(row.tags) as string[]).includes('wiki'),
  );
/** The id of the stored trace whose text holds `words`. */
const idOf = (stored: StoredTrace[], words: string): string | undefined => stored.find((row) => row.content.includes(words))?.id;
/** Every row of the store, of anyone, whose text holds `words`: a trace or a page's chunk. */
const holding = (words: string) => rows<{ id: string }>("SELECT id FROM memory_traces WHERE content LIKE '%' || ? || '%'", [words]);
/** The page rows the store holds under one key. */
const pagesOf = (key: string) => rows<{ page_id: string }>('SELECT page_id FROM memory_pages WHERE scope_id = ?', [key]);

/** A turn's write record, as the turn's result carries it. */
function writeOf(result: { memoryWrite?: Promise<MemoryWriteRecord> }): Promise<MemoryWriteRecord> {
  expect(result.memoryWrite).toBeInstanceOf(Promise);
  return result.memoryWrite!;
}

/** One turn of a user, and a wait until its memory writes have settled. */
async function turn(a: SouledAgent, sessionId: string, userId: string, text: string): Promise<MemoryWriteRecord> {
  return writeOf(await a.session(sessionId, { userId }).send(text));
}

/** A gate a held reply waits on, and its opener. */
function gated(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/** Corrects the named traces with `text`, or deletes them with no replacement when there is none. */
const correct = (a: SouledAgent, userId: string, traceIds: readonly string[], text?: string) =>
  a.correctUserMemory!(userId, text === undefined ? { traceIds } : { traceIds, text });

describe.each(RUNTIMES)('deleting or correcting one memory, on runtime %s', (runtime) => {
  it('one of two memories is deleted, and nothing is filed', async () => {
    const a = await open(runtime, [
      reply.text('A canary, lovely.'),
      reply.text('A parrot too, noted.'),
      reply.text('The user keeps a canary named LARK-7 and a parrot named KITE-4.'),
      reply.text('You keep a parrot.'),
      reply.text('The user keeps a parrot named KITE-4.'),
      ...spare(),
    ]);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's1', 'alice', 'My parrot is KITE-4.');
    await a.memory!.compileWiki();
    expect(pagesOf(keyOf(alice))).toHaveLength(1);
    const before = saidOf(keyOf(alice));
    expect(before).toHaveLength(4);
    const first = idOf(before, 'LARK-7')!;

    const result = await a.correctUserMemory!('alice', { traceIds: [first] });

    // The trace and the page built from it are gone; nothing takes their place, and the result names no correction.
    const listed: MemoryRecipient[] = result.recipients;
    expect(listed).toEqual(await a.recipients!());
    expect(result).toEqual({ deleted: 1, pagesDeleted: 1, recipients: listed });
    expect(Object.keys(result).sort()).toEqual(['deleted', 'pagesDeleted', 'recipients']);
    expect(result.recipients.length).toBeGreaterThan(0);
    const after = saidOf(keyOf(alice));
    expect(after.map((row) => row.id)).toEqual(before.filter((row) => row.id !== first).map((row) => row.id));
    expect(after.filter((row) => (JSON.parse(row.tags) as string[]).includes('correction'))).toEqual([]);
    expect(holding('LARK-7')).toEqual([]);
    expect(pagesOf(keyOf(alice))).toEqual([]);

    // The export holds the second memory and never the first.
    const doc = await a.exportUserMemory!('alice');
    expect(doc.traces.map((trace) => trace.text)).toContain('My parrot is KITE-4.');
    expect(doc.traces.map((trace) => trace.id)).not.toContain(first);
    expect(JSON.stringify(doc)).not.toContain('LARK-7');

    // So does a new session's recall.
    const calls = served.seen.length;
    await turn(a, 's2', 'alice', 'What do I keep, a canary or a parrot?');
    const asked = JSON.stringify(served.seen[calls].messages);
    expect(asked).toContain('KITE-4');
    expect(asked).not.toContain('LARK-7');

    // The next compile builds the page again from the traces that are left.
    const merges = served.seen.length;
    await a.memory!.compileWiki();
    expect(served.seen.length).toBeGreaterThan(merges);
    const merged = JSON.stringify(served.seen.slice(merges).map((call) => call.messages));
    expect(merged).toContain('KITE-4');
    expect(merged).not.toContain('LARK-7');
    expect(pagesOf(keyOf(alice))).toHaveLength(1);
  });

  it('a correction names who received the text, beside the trace it filed', async () => {
    const a = await open(runtime, [reply.text('A canary, lovely.'), ...spare()]);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    const wrong = idOf(saidOf(keyOf(alice)), 'LARK-7')!;

    const result = await a.correctUserMemory!('alice', { traceIds: [wrong], text: 'My canary is WREN-9.' });

    expect(result.deleted).toBe(1);
    expect(result.recipients.length).toBeGreaterThan(0);
    expect(result.recipients).toEqual(await a.recipients!());
    const said = saidOf(keyOf(alice));
    // A correction's result always names its trace.
    const filed: string = result.correctionTraceId;
    expect(filed).toBe(idOf(said, 'WREN-9'));
    expect(JSON.parse(said.find((row) => row.id === filed)!.tags) as string[]).toContain('correction');
    expect(holding('LARK-7')).toEqual([]);
  });

  it('a deletion still runs when the routes the store recorded cannot be read', async () => {
    const a = await open(runtime, [reply.text('A canary, lovely.'), ...spare()]);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    const first = idOf(saidOf(keyOf(alice)), 'LARK-7')!;
    const named = await a.recipients!();
    recordedRoutes.fail = new Error('the store went away');

    const result = await correct(a, 'alice', [first]);

    // The list holds the routes the options name; one line says the recorded ones were not read.
    expect(result.deleted).toBe(1);
    expect(result.recipients).toEqual(named);
    expect(holding('LARK-7')).toEqual([]);
    expect(lines('memory.recipients_unread')).toHaveLength(1);
  });

  it.each<[string, string | undefined]>([
    ['a correction', 'My canary is WREN-9.'],
    ['a deletion with no replacement', undefined],
  ])('a reply that restates a memory which %s took away during its turn is not filed', async (_name, text) => {
    const { gate, release } = gated();
    const a = await open(runtime, [
      reply.text('A canary, lovely.'),
      reply.hold([], gate, reply.text('Your canary is LARK-7.')),
      reply.text('You are welcome.'),
      ...spare(),
    ]);
    try {
      await turn(a, 's1', 'alice', 'My canary is LARK-7.');
      const x = idOf(saidOf(keyOf(alice)), 'LARK-7')!;

      // A turn of a new session recalls x, and its model call stays open.
      const calls = served.seen.length;
      const session = a.session('s2', { userId: 'alice' });
      const running = session.send('What is my canary called?');
      await vi.waitFor(() => expect(served.seen).toHaveLength(calls + 1), { timeout: 4_000 });
      expect(JSON.stringify(served.seen[calls].messages)).toContain('LARK-7');

      // x goes while the model is still answering.
      expect((await correct(a, 'alice', [x], text)).deleted).toBe(1);
      expect(holding('LARK-7')).toEqual([]);

      // The model then answers with what x said.
      release();
      const result = await running;
      expect(result.text).toBe('Your canary is LARK-7.');
      const record = await writeOf(result);

      // What the person said is filed; the reply is not, and no row holds x's text.
      expect(record).toEqual({
        entries: [
          { role: 'user', outcome: 'written', traceId: idOf(saidOf(keyOf(alice)), 'What is my canary called?') },
          { role: 'assistant', outcome: 'skipped', reason: 'corrected' },
        ],
      });
      expect(record.entries[0]).toMatchObject({ traceId: expect.any(String) });
      expect(holding('LARK-7')).toEqual([]);
      expect(lines('memory.write_refused').filter((line) => line.reason === 'corrected')).toHaveLength(1);

      // The session's next turn began after the change: both of its sides are filed.
      const next = await writeOf(await session.send('Thank you.'));
      expect(next.entries.map((entry) => entry.outcome)).toEqual(['written', 'written']);
    } finally {
      release();
    }
  });

  it('a turn that recalls a memory while a deletion of it is under way does not file its reply', async () => {
    const { gate, release } = gated();
    const a = await open(runtime, [reply.text('A canary, lovely.'), reply.text('Your canary is LARK-7.'), ...spare()]);
    try {
      await turn(a, 's1', 'alice', 'My canary is LARK-7.');
      const x = idOf(saidOf(keyOf(alice)), 'LARK-7')!;

      // The call has passed its ownership check and waits at its delete of x.
      const entered = gated();
      const original = a.memory!.deleteTraces.bind(a.memory!);
      vi.spyOn(a.memory!, 'deleteTraces').mockImplementation(async (...args) => {
        if (args[0].includes(x)) {
          entered.release();
          await gate;
        }
        return original(...args);
      });
      const deleting = correct(a, 'alice', [x]);
      await entered.gate;

      // A turn of a new session starts now, recalls x, which is still stored, and the model restates it.
      const calls = served.seen.length;
      const running = a.session('s2', { userId: 'alice' }).send('What is my canary called?');
      await vi.waitFor(() => expect(served.seen).toHaveLength(calls + 1), { timeout: 4_000 });
      expect(JSON.stringify(served.seen[calls].messages)).toContain('LARK-7');

      // The delete finishes; the turn's writes, queued behind it, come after.
      release();
      expect((await deleting).deleted).toBe(1);
      const result = await running;
      expect(result.text).toBe('Your canary is LARK-7.');
      const record = await writeOf(result);
      expect(record.entries).toEqual([
        { role: 'user', outcome: 'written', traceId: idOf(saidOf(keyOf(alice)), 'What is my canary called?') },
        { role: 'assistant', outcome: 'skipped', reason: 'corrected' },
      ]);
      expect(holding('LARK-7')).toEqual([]);
    } finally {
      release();
    }
  });

  it('a deletion that fails partway keeps the reply of the running turn out too, and finishes when made again', async () => {
    const { gate, release } = gated();
    const a = await open(runtime, [reply.text('A canary, lovely.'), reply.hold([], gate, reply.text('Your canary is LARK-7.')), ...spare()]);
    try {
      await turn(a, 's1', 'alice', 'My canary is LARK-7.');
      const x = idOf(saidOf(keyOf(alice)), 'LARK-7')!;
      const calls = served.seen.length;
      const running = a.session('s2', { userId: 'alice' }).send('What is my canary called?');
      await vi.waitFor(() => expect(served.seen).toHaveLength(calls + 1), { timeout: 4_000 });

      // The store refuses the delete once: the call rejects, and x is still stored.
      vi.spyOn(a.memory!, 'deleteTraces').mockRejectedValueOnce(new Error('the store is busy'));
      await expect(correct(a, 'alice', [x])).rejects.toThrow('the store is busy');
      expect(holding('LARK-7').map((row) => row.id)).toEqual([x]);

      release();
      const record = await writeOf(await running);
      expect(record.entries).toEqual([
        { role: 'user', outcome: 'written', traceId: idOf(saidOf(keyOf(alice)), 'What is my canary called?') },
        { role: 'assistant', outcome: 'skipped', reason: 'corrected' },
      ]);

      // The same call made again deletes x, and no row holds what it said.
      expect((await correct(a, 'alice', [x])).deleted).toBe(1);
      expect(holding('LARK-7')).toEqual([]);
    } finally {
      release();
    }
  });

  it("a turn is filed whole when the change made meanwhile was to another person's memory, or was rejected", async () => {
    const { gate, release } = gated();
    const a = await open(runtime, [
      reply.text('A canary, lovely.'),
      reply.text('A wren, noted.'),
      reply.hold([], gate, reply.text('Your wren is WREN-2.')),
      ...spare(),
    ]);
    try {
      await turn(a, 's1', 'alice', 'My canary is LARK-7.');
      await turn(a, 's2', 'bob', 'My wren is WREN-2.');
      const ofAlice = idOf(saidOf(keyOf(alice)), 'LARK-7')!;

      const calls = served.seen.length;
      const running = a.session('s3', { userId: 'bob' }).send('What is my wren called?');
      await vi.waitFor(() => expect(served.seen).toHaveLength(calls + 1), { timeout: 4_000 });

      // Alice's memory is changed, and a call that names her trace as Bob's is rejected, while Bob's turn runs.
      await expect(correct(a, 'bob', [ofAlice], 'x')).rejects.toThrow("correctUserMemory: 1 of 1 trace ids are not this user's live traces");
      expect((await correct(a, 'alice', [ofAlice])).deleted).toBe(1);

      release();
      const record = await writeOf(await running);
      const said = saidOf(keyOf(bob));
      expect(record).toEqual({
        entries: [
          { role: 'user', outcome: 'written', traceId: idOf(said, 'What is my wren called?') },
          { role: 'assistant', outcome: 'written', traceId: idOf(said, 'Your wren is WREN-2.') },
        ],
      });
    } finally {
      release();
    }
  });

  it("an id that is not the person's rejects the call and changes nothing", async () => {
    const a = await open(runtime);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's2', 'bob', 'My canary is WREN-2.');
    const all = () => rows<{ id: string; content: string }>('SELECT id, content FROM memory_traces ORDER BY id');
    const before = all();
    const ofBob = idOf(saidOf(keyOf(bob)), 'WREN-2')!;
    const ofAlice = idOf(saidOf(keyOf(alice)), 'LARK-7')!;

    const one = correct(a, 'alice', [ofBob], 'x');
    await expect(one).rejects.toThrow("correctUserMemory: 1 of 1 trace ids are not this user's live traces");
    const two = correct(a, 'alice', [ofAlice, ofBob], 'x');
    await expect(two).rejects.toThrow("correctUserMemory: 1 of 2 trace ids are not this user's live traces");
    for (const attempt of [one, two]) {
      expect(await attempt.catch((error: Error) => error.message)).not.toContain(ofBob);
    }
    // A text that is empty is no correction, and no request to delete either.
    await expect(correct(a, 'alice', [ofAlice], '')).rejects.toThrow(TypeError);
    await expect(correct(a, 'alice', [], 'x')).rejects.toThrow(TypeError);

    expect(all()).toEqual(before);
    const refused = lines('memory.write_refused');
    expect(refused).toHaveLength(2);
    for (const line of refused) expect(line).toMatchObject({ reason: 'foreign_trace' });
  });

  it("a deletion that names a trace that is not the person's rejects the call and changes nothing", async () => {
    const a = await open(runtime);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's2', 'bob', 'My canary is WREN-2.');
    const all = () => rows<{ id: string; content: string }>('SELECT id, content FROM memory_traces ORDER BY id');
    const before = all();
    const ofBob = idOf(saidOf(keyOf(bob)), 'WREN-2')!;
    const ofAlice = idOf(saidOf(keyOf(alice)), 'LARK-7')!;

    await expect(correct(a, 'alice', [ofBob])).rejects.toThrow("correctUserMemory: 1 of 1 trace ids are not this user's live traces");
    await expect(correct(a, 'alice', [ofAlice, ofBob])).rejects.toThrow("correctUserMemory: 1 of 2 trace ids are not this user's live traces");
    await expect(correct(a, 'alice', [])).rejects.toThrow(TypeError);

    expect(all()).toEqual(before);
    expect(lines('memory.write_refused').map((line) => line.reason)).toEqual(['foreign_trace', 'foreign_trace']);
  });
});
