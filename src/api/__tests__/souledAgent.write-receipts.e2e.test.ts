/**
 * A receipt for each memory write of a session turn, where the agent's memory provider files the turn, end to end
 * over the real agent, generateText, GMI, provider manager and Memory store; only the OpenAI provider class is stubbed
 * (helpers/stubProviders.ts), at its module boundary.
 *
 * - A session's `send()` and `stream()` carry `memoryWrite`, a promise of the turn's write record: one entry a side
 *   that had text, the user's first, each `written` with the id of the trace it filed, `skipped` with its reason, or
 *   `failed` with the error's class name. The record holds ids and outcomes, never text, and its promise never rejects.
 * - The turn never waits for its write: with the person's writes held behind a compile, `send()` resolves first and
 *   the record settles once the compile ends.
 * - A stream's record settles after the stream ends. A stream its caller aborts mid-reply files neither side, and its
 *   record holds no entry.
 * - A turn whose model call fails rejects and files neither side; a turn with an empty reply files the user's message
 *   alone.
 * - A write the agent's rules refuse says why: the account's policy, a hook that failed, the screen, a forgotten
 *   person, a user id no memory key can be built from.
 * - A host's own provider: an `observe` that resolves with nothing gives a record with no entry, and one that rejects
 *   gives `failed` entries while the log keeps its sparse `memory.hook_failed` line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { agent, type AgentMemoryProvider, type AgentOptions } from '../agent';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import { Memory } from '../../cognition/memory/io/facade/Memory';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import type { MemoryWriteEntry, MemoryWriteRecord } from '../runtime/memoryWriteRecord';

/** The runtimes the cases run on: the default one, and the GMI runtime with cognitive memory off. */
const RUNTIMES = ['legacy', 'gmi'] as const;
type Runtime = (typeof RUNTIMES)[number];

/** An entry's outcome, without the side it is the entry of. */
type WithoutRole<Entry> = Entry extends unknown ? Omit<Entry, 'role'> : never;
type Outcome = WithoutRole<MemoryWriteEntry>;
/** Why a side was not filed. */
type SkipReason = Extract<MemoryWriteEntry, { outcome: 'skipped' }>['reason'];

let n = 0;
let dir: string;
const closers: Array<() => Promise<unknown>> = [];
/** Every line the library logged in the case, parsed. */
let events: Array<Record<string, unknown>>;
beforeEach(() => {
  globalLLMProviderHealth.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-write-receipts-e2e-'));
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
  while (closers.length) await closers.pop()!().catch(() => undefined);
  resetLoggerFactory();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The logged lines about a memory provider whose `observe` failed. */
const observeFailures = () => events.filter((line) => line.event === 'memory.hook_failed' && line.hook === 'observe');

const storeFile = () => path.join(dir, 'memory', '.store', 'memory.sqlite');
const keyOf = (subject: { kind: 'user' | 'session'; id: string }) => conversationScopeKey('aria-1', subject);
const alice = { kind: 'user' as const, id: 'alice' };

let replyNo = 0;
/** Replies to spare, each with words of its own: the store keeps one trace for a text a subject's memory already holds. */
const spare = (): ProviderScript['replies'] => Array.from({ length: 12 }, () => reply.text(`Noted ${++replyNo}.`));

/** The script the provider of the agent opened last plays: every request it served is in `seen`. */
let served: ProviderScript;

/**
 * A souled agent on the stubbed provider, which answers with `replies` in order; `retention` and `tombstoneKey` are
 * set so two people may share the store.
 */
async function open(runtime: Runtime, extra: Partial<SouledAgentOptions> = {}, replies: ProviderScript['replies'] = spare()): Promise<SouledAgent> {
  const apiKey = `k-souled-write-receipts-${++n}`;
  served = script('openai', apiKey, { whole: true, replies });
  const a = await souledAgent({
    runtime,
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    soul: dir,
    retention: { traces: 'until-deletion' },
    tombstoneKey: 'k-souled-write-receipts-tombstones',
    ...extra,
  } as unknown as SouledAgentOptions);
  closers.push(() => a.close());
  return a;
}

/** The traces filed under `key` in the store's SQLite file, read by a connection of the test's own. */
function tracesOf(key: string): Array<{ id: string; content: string }> {
  const db = new Database(storeFile(), { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT id, content FROM memory_traces WHERE scope = 'conversation' AND scope_id = ?").all(key) as Array<{ id: string; content: string }>;
  } finally {
    db.close();
  }
}
/** The id of the stored trace whose text holds `words`. */
const idOf = (stored: Array<{ id: string; content: string }>, words: string): string | undefined => stored.find((row) => row.content.includes(words))?.id;

/** The promise of a turn's write record, as the turn's result carries it. */
function writeOf(result: { memoryWrite?: Promise<MemoryWriteRecord> }): Promise<MemoryWriteRecord> {
  expect(result.memoryWrite).toBeInstanceOf(Promise);
  return result.memoryWrite!;
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

/** Reads a stream to its end, whichever way it ends. */
async function drain(reader: AsyncIterator<string>): Promise<void> {
  for (;;) {
    try {
      if ((await reader.next()).done) return;
    } catch {
      return;
    }
  }
}

/** A gate a held reply waits on, and its opener. */
function gated(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/** The record of a turn whose two sides had the same outcome. */
const both = (outcome: Outcome): MemoryWriteRecord => ({
  entries: (['user', 'assistant'] as const).map((role) => ({ role, ...outcome }) as MemoryWriteEntry),
});

describe.each(RUNTIMES)('a receipt for each memory write, on runtime %s', (runtime) => {
  it("a turn's result names the traces it filed", async () => {
    const a = await open(runtime, {}, [reply.text('A canary, lovely.'), ...spare()]);

    const result = await a.session('s1', { userId: 'alice' }).send('My canary is LARK-7.');
    const record = await writeOf(result);

    const stored = tracesOf(keyOf(alice));
    expect(stored).toHaveLength(2);
    expect(record).toEqual({
      entries: [
        { role: 'user', outcome: 'written', traceId: idOf(stored, 'LARK-7') },
        { role: 'assistant', outcome: 'written', traceId: idOf(stored, 'lovely') },
      ],
    });
    expect(new Set(record.entries.map((entry) => (entry.outcome === 'written' ? entry.traceId : undefined))).size).toBe(2);
    // Ids and outcomes, never text.
    expect(JSON.stringify(record)).not.toMatch(/LARK-7|lovely/);
    // A one-shot call is no session turn: its result carries no record.
    expect((await a.generate('Hello.')).memoryWrite).toBeUndefined();
  });

  it('a turn the screen drops says so for each side', async () => {
    const a = await open(runtime, { screen: () => null } as unknown as Partial<SouledAgentOptions>);

    const result = await a.session('s1', { userId: 'alice' }).send('My canary is LARK-7.');

    expect(await writeOf(result)).toEqual(both({ outcome: 'skipped', reason: 'screened' }));
    expect(tracesOf(keyOf(alice))).toEqual([]);
  });

  it('a write that fails reaches the record, with no text', async () => {
    const a = await open(runtime, {}, [reply.text('A canary, lovely.'), ...spare()]);
    vi.spyOn(Memory.prototype, 'remember').mockImplementation(async (text) => {
      throw new Error(`the store refused "${String(text)}"`);
    });

    const result = await a.session('s1', { userId: 'alice' }).send('My canary is LARK-7.');
    // The turn is answered whatever its write does.
    expect(result.text).toBe('A canary, lovely.');
    const record = await writeOf(result);

    expect(record).toEqual(both({ outcome: 'failed', errorName: 'Error' }));
    expect(JSON.stringify(record)).not.toMatch(/LARK-7|lovely|refused/);
    // The log keeps its sparse line: the provider's first failure, with the error's type and never its message.
    expect(observeFailures()).toHaveLength(1);
    expect(observeFailures()[0]).toMatchObject({ type: 'Error' });
    expect(JSON.stringify(observeFailures())).not.toMatch(/LARK-7|refused/);
  });

  it('the turn never waits for its write', async () => {
    const { gate, release } = gated();
    const a = await open(runtime, {}, [
      reply.text('A canary, lovely.'),
      reply.hold([], gate, reply.text('Alice keeps a canary named LARK-7.')),
      reply.text('In the attic, noted.'),
      ...spare(),
    ]);
    try {
      const session = a.session('s1', { userId: 'alice' });
      await writeOf(await session.send('My canary is LARK-7.'));
      // Her compile holds her writes behind it for as long as its model call is open.
      const calls = served.seen.length;
      const compiling = a.memory!.compileWiki({ scopes: [keyOf(alice)] });
      await vi.waitFor(() => expect(served.seen).toHaveLength(calls + 1), { timeout: 4_000 });

      const result = await session.send('I keep it in the attic.');
      expect(result.text).toBe('In the attic, noted.');
      const write = writeOf(result);
      expect(await settledWithin(write, 200)).toBe(false);

      release();
      await compiling;
      const record = await write;
      const stored = tracesOf(keyOf(alice));
      expect(record).toEqual({
        entries: [
          { role: 'user', outcome: 'written', traceId: idOf(stored, 'I keep it in the attic.') },
          { role: 'assistant', outcome: 'written', traceId: idOf(stored, 'In the attic, noted.') },
        ],
      });
    } finally {
      release();
    }
  });

  it("a stream's record settles after the stream ends, with the two traces it filed", async () => {
    const { gate, release } = gated();
    const [first, ...rest] = reply.text('A canary, lovely.');
    const a = await open(runtime, {}, [reply.hold([first], gate, rest), ...spare()]);
    try {
      const result = a.session('s1', { userId: 'alice' }).stream('My canary is LARK-7.');
      const write = writeOf(result);
      const reader = result.textStream[Symbol.asyncIterator]();
      expect((await reader.next()).done).toBe(false);
      // The reply is still open: the record waits for the stream's end.
      expect(await settledWithin(write, 200)).toBe(false);

      release();
      await drain(reader);
      expect(await result.text).toBe('A canary, lovely.');
      const record = await write;
      const stored = tracesOf(keyOf(alice));
      expect(stored).toHaveLength(2);
      expect(record).toEqual({
        entries: [
          { role: 'user', outcome: 'written', traceId: idOf(stored, 'LARK-7') },
          { role: 'assistant', outcome: 'written', traceId: idOf(stored, 'lovely') },
        ],
      });
    } finally {
      release();
    }
  });

  it('a stream its caller aborts mid-reply files neither side', async () => {
    const stop = new AbortController();
    const [first, ...rest] = reply.text('A canary, lovely.');
    const a = await open(runtime, {}, [reply.hold([first], new Promise<void>(() => undefined), rest), ...spare()]);
    try {
      const result = a.session('s1', { userId: 'alice' }).stream('My canary is LARK-7.', { abortSignal: stop.signal });
      const write = writeOf(result);
      const reader = result.textStream[Symbol.asyncIterator]();
      expect((await reader.next()).done).toBe(false);

      stop.abort();
      await drain(reader);
      expect(await write).toEqual({ entries: [] });
      expect(tracesOf(keyOf(alice))).toEqual([]);
    } finally {
      stop.abort();
    }
  });

  it('a turn whose model call fails rejects and files neither side', async () => {
    const a = await open(runtime, {}, [Object.assign(new Error('bad request'), { httpStatus: 400 }), reply.text('In the attic, noted.'), ...spare()]);
    const session = a.session('s1', { userId: 'alice' });

    await expect(session.send('My canary is LARK-7.')).rejects.toThrow();

    // The session's next turn files its own two sides; nothing of the failed turn is in the store.
    const record = await writeOf(await session.send('I keep it in the attic.'));
    expect(record.entries.map((entry) => entry.outcome)).toEqual(['written', 'written']);
    const stored = tracesOf(keyOf(alice));
    expect(stored).toHaveLength(2);
    expect(stored.filter((row) => row.content.includes('LARK-7'))).toEqual([]);
  });

  it("a turn with an empty reply files the user's message alone", async () => {
    const a = await open(runtime, {}, [reply.text(''), ...spare()]);

    const result = await a.session('s1', { userId: 'alice' }).send('My canary is LARK-7.');
    expect(result.text).toBe('');
    const record = await writeOf(result);

    const stored = tracesOf(keyOf(alice));
    expect(stored).toHaveLength(1);
    expect(record).toEqual({ entries: [{ role: 'user', outcome: 'written', traceId: idOf(stored, 'LARK-7') }] });
  });

  it.each<[string, Partial<SouledAgentOptions>, SkipReason]>([
    ['an account that keeps no memory', { memoryPolicy: () => ({ longTerm: 'off' }) } as unknown as Partial<SouledAgentOptions>, 'policy_off'],
    [
      'a policy hook that fails',
      {
        memoryPolicy: () => {
          throw new Error('the account service is down');
        },
      } as unknown as Partial<SouledAgentOptions>,
      'policy_failed',
    ],
    [
      'a child, on a store that keeps memory until deletion',
      { memoryPolicy: () => ({ longTerm: 'compiled', minor: true }) } as unknown as Partial<SouledAgentOptions>,
      'minor_no_retention',
    ],
    [
      'a screen hook that fails',
      {
        screen: () => {
          throw new Error('the screen is down');
        },
      } as unknown as Partial<SouledAgentOptions>,
      'screen_failed',
    ],
  ])('%s is skipped with its reason', async (_name, extra, reason) => {
    const a = await open(runtime, extra);

    const result = await a.session('s1', { userId: 'alice' }).send('My canary is LARK-7.');

    expect(await writeOf(result)).toEqual(both({ outcome: 'skipped', reason }));
    expect(tracesOf(keyOf(alice))).toEqual([]);
  });

  it("a forgotten person's turn is skipped as forgotten", async () => {
    const a = await open(runtime);
    expect((await a.forgetUser!('alice')).complete).toBe(true);

    const result = await a.session('s1', { userId: 'alice' }).send('My canary is LARK-7.');

    expect(await writeOf(result)).toEqual(both({ outcome: 'skipped', reason: 'forgotten' }));
    expect(tracesOf(keyOf(alice))).toEqual([]);
  });

  it('a user id no memory key can be built from is skipped as no subject', async () => {
    const a = await open(runtime);

    const result = await a.session('sx', { userId: 'm\uD800' }).send('Are we open from nine?');

    expect(await writeOf(result)).toEqual(both({ outcome: 'skipped', reason: 'no_subject' }));
  });
});

describe.each(RUNTIMES)("a host's own memory provider, on runtime %s", (runtime) => {
  /** A session of a plain agent on the stubbed provider, with the host's `memoryProvider`. */
  function sessionWith(memoryProvider: AgentMemoryProvider) {
    const apiKey = `k-write-receipts-host-${++n}`;
    script('openai', apiKey, { whole: true, replies: [reply.text('Done.')] });
    const a = agent({ runtime, provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [], memoryProvider } as unknown as AgentOptions);
    closers.push(() => a.close());
    return a.session('s');
  }

  it('an observe that resolves with nothing gives a record with no entry', async () => {
    const observed: string[] = [];
    const session = sessionWith({
      observe: async (role) => {
        observed.push(role);
      },
    });

    const result = await session.send('hi');

    expect(await writeOf(result)).toEqual({ entries: [] });
    expect(observed).toEqual(['user', 'assistant']);
  });

  it('an observe that rejects gives failed entries, and the sparse log line stays', async () => {
    const session = sessionWith({
      observe: async (_role, text) => {
        throw new RangeError(`store down while filing "${text}"`);
      },
    });

    const result = await session.send('hi there');
    expect(result.text).toBe('Done.');
    const record = await writeOf(result);

    expect(record).toEqual(both({ outcome: 'failed', errorName: 'RangeError' }));
    expect(JSON.stringify(record)).not.toMatch(/store down|hi there/);
    expect(observeFailures()).toHaveLength(1);
    expect(JSON.stringify(observeFailures())).not.toMatch(/store down|hi there/);
  });
});
