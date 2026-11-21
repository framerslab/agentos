/**
 * A store that keeps the memory of more than one person or session needs a key for its tombstones, end to end over
 * the real souledAgent(), agent, generateText, provider manager, Memory store and forgotten-user ledger; only the
 * OpenAI provider class is stubbed (helpers/stubProviders.ts), at its module boundary.
 *
 * - With no `tombstoneKey` and a ledger that holds no tombstone, the second person's or session's session is refused,
 *   and so is the open of a store that already holds two subjects' memory; the refused open leaves nothing open.
 * - With no `tombstoneKey` and a ledger that already holds an unkeyed tombstone (written by an earlier deletion, by
 *   one this agent made, or past the agent through its memory or its learning layer), the second subject opens, and
 *   one `memory.tombstones_unkeyed` line an open says so, once the subject is let in.
 * - A `tombstoneKey` that holds no key (`null`) is no key.
 * - A person forgotten with no key stays forgotten once the store opens with a key, and a person forgotten under a
 *   key stays forgotten after the key is rotated.
 * - `sharedMemory` keeps one person's memory and never needs the key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import type { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

/** The runtimes every case runs on. */
const RUNTIMES = ['legacy', 'gmi'] as const;

/** The refusal of a second subject on a clean ledger with no key. */
const KEY_NEEDED = /set tombstoneKey/;

let n = 0;
let dir: string;
const opened: SouledAgent[] = [];
/** Every line the library logged in the test, parsed. */
let events: Array<Record<string, unknown>>;
beforeEach(() => {
  globalLLMProviderHealth.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-tombstone-key-e2e-'));
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
  while (opened.length) await opened.pop()!.close().catch(() => undefined);
  resetLoggerFactory();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The logged lines of one event. */
const lines = (event: string) => events.filter((line) => line.event === event);

const storeFile = () => path.join(dir, 'memory', '.store', 'memory.sqlite');
const keyOf = (subject: { kind: 'user' | 'session'; id: string }) => conversationScopeKey('aria-1', subject);
const userKey = (id: string) => keyOf({ kind: 'user', id });

/** Rows of the store's file, read by a connection of the test's own once every agent on it is closed. */
function rows<T>(sql: string, params: unknown[] = []): T[] {
  const db = new Database(storeFile(), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
/** The ids of the store's traces whose text holds `words`. */
const tracesHolding = (words: string) => rows<{ id: string }>('SELECT id FROM memory_traces WHERE content LIKE ?', [`%${words}%`]);
/** The ids of the conversation traces the store holds under one key. */
const tracesUnder = (key: string) =>
  rows<{ id: string }>("SELECT id FROM memory_traces WHERE scope = 'conversation' AND scope_id = ? AND deleted = 0", [key]);

/** The Brain behind a souled agent's store, for a row a case plants. */
const brainOf = (a: SouledAgent): Brain => (a.memory as unknown as { _brain: Brain })._brain;

/** The words every model call was sent, joined. */
const sentIn = (call: ProviderScript['seen'][number]): string => JSON.stringify(call.messages);

describe.each(RUNTIMES)('the tombstone key, on runtime %s', (runtime) => {
  /** A souled agent on the stubbed provider that may keep several people's memory (`retention` is set). */
  async function open(extra: Partial<SouledAgentOptions> = {}): Promise<{ a: SouledAgent; s: ProviderScript }> {
    const apiKey = `k-souled-tombstone-key-${++n}`;
    const s = script('openai', apiKey, { whole: true, replies: Array.from({ length: 40 }, (_, i) => reply.text(`Noted ${i}.`)) });
    const a = await souledAgent({
      runtime,
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
  /** Closes an agent the case is done with, before the next open of the same folder. */
  async function closed(a: SouledAgent): Promise<void> {
    opened.splice(opened.indexOf(a), 1);
    await a.close();
  }
  /** One turn of a user's session. */
  const say = (a: SouledAgent, session: string, userId: string, text: string) => a.session(session, { userId }).send(text);

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('refuses a second person or session on a clean ledger with no key', async () => {
    const { a } = await open();
    expect(a.session('s1', { userId: 'alice' }).id).toBe('s1');
    // The same person in another session, and her session asked for again, are one subject.
    expect(a.session('s9', { userId: 'alice' }).id).toBe('s9');
    expect(a.session('s1').id).toBe('s1');
    expect(() => a.session('s2', { userId: 'bob' })).toThrow(KEY_NEEDED);
    expect(() => a.session('s3')).toThrow(KEY_NEEDED);
    expect(() => a.session()).toThrow(KEY_NEEDED);
    try {
      a.session('s2', { userId: 'bob' });
    } catch (err) {
      // The refusal says what an unkeyed tombstone allows, and never names who.
      expect((err as Error).message).toMatch(/guessed id/);
      expect((err as Error).message).not.toMatch(/set retention/);
      expect((err as Error).message).not.toContain('bob');
    }
    expect(lines('memory.tombstones_unkeyed')).toEqual([]);
  });

  it('refuses the open of a store that holds two subjects on a clean ledger with no key, and opens it with a key', async () => {
    // Two people's memory, filed by an agent that had a key and forgot nobody: its ledger holds no tombstone.
    const { a } = await open({ tombstoneKey: 'k-plant' });
    await say(a, 's1', 'alice', 'My canary is LARK-7.');
    await say(a, 's2', 'bob', 'My canary is WREN-2.');
    await closed(a);
    expect(tracesUnder(userKey('alice')).length).toBeGreaterThanOrEqual(1);
    expect(tracesUnder(userKey('bob')).length).toBeGreaterThanOrEqual(1);

    await expect(open()).rejects.toThrow(KEY_NEEDED);
    // The refused open left no handle: the next open of the folder, with a key, serves both people.
    const { a: keyed } = await open({ tombstoneKey: 'k-plant' });
    expect(keyed.session('s1', { userId: 'alice' }).id).toBe('s1');
    expect(keyed.session('s2', { userId: 'bob' }).id).toBe('s2');
    await closed(keyed);
    expect(tracesHolding('LARK-7').length).toBeGreaterThanOrEqual(1);
    expect(lines('memory.tombstones_unkeyed')).toEqual([]);
  });

  it('lets a second person in once a deletion wrote an unkeyed tombstone, with one line an open', async () => {
    const { a } = await open();
    expect((await a.forgetUser!('carol')).tombstone).toEqual({ form: 'unkeyed', written: true });
    await say(a, 's1', 'alice', 'My canary is LARK-7.');
    await say(a, 's2', 'bob', 'My canary is WREN-2.');
    expect(a.session('s3').id).toBe('s3');
    expect(lines('memory.tombstones_unkeyed')).toHaveLength(1);
    expect(JSON.stringify(lines('memory.tombstones_unkeyed'))).not.toMatch(/alice|bob|carol|LARK|WREN/);
    await closed(a);

    // The next open finds the tombstone in the ledger and two people in the store: one line, at the open.
    events.length = 0;
    const { a: again } = await open();
    expect(lines('memory.tombstones_unkeyed')).toHaveLength(1);
    expect(again.session('s4', { userId: 'dave' }).id).toBe('s4');
    await say(again, 's1', 'alice', 'I am back.');
    expect(lines('memory.tombstones_unkeyed')).toHaveLength(1);
  });

  it('opens with one line a store whose ledger holds an unkeyed tombstone and whose memory is of two people', async () => {
    const { a } = await open();
    await say(a, 's1', 'alice', 'My canary is LARK-7.');
    expect((await a.forgetUser!('carol')).complete).toBe(true);
    await say(a, 's2', 'bob', 'My canary is WREN-2.');
    await closed(a);

    events.length = 0;
    const { a: again } = await open();
    expect(lines('memory.tombstones_unkeyed')).toHaveLength(1);
    expect(again.session('s3', { userId: 'erin' }).id).toBe('s3');
    expect(lines('memory.tombstones_unkeyed')).toHaveLength(1);
  });

  it('lets a second person in once a tombstone is written past the agent, through its memory or its learning layer', async () => {
    // The GMI runtime runs the learning layer, which writes to the store's ledger; the default runtime runs none.
    const { a } = await open(runtime === 'gmi' ? ({ learning: true } as Partial<SouledAgentOptions>) : {});
    expect(a.session('s1', { userId: 'alice' }).id).toBe('s1');
    expect(() => a.session('s2', { userId: 'bob' })).toThrow(KEY_NEEDED);
    if (runtime === 'gmi') await a.learning!.forgetUser!('carol');
    else expect(await a.memory!.markForgotten({ kind: 'user', id: 'carol' })).toEqual({ form: 'unkeyed', written: true });
    expect(a.session('s2', { userId: 'bob' }).id).toBe('s2');
    expect(lines('memory.tombstones_unkeyed')).toHaveLength(1);
  });

  it('writes the line only once a second subject is let in, never for a session the runtime refuses', async () => {
    const { a } = await open();
    expect(a.session('s1', { userId: 'alice' }).id).toBe('s1');
    expect((await a.forgetUser!('carol')).tombstone).toEqual({ form: 'unkeyed', written: true });
    // Alice's open session asked for as another user is refused by the runtime: nobody new is let in.
    expect(() => a.session('s1', { userId: 'bob' })).toThrow(/already runs as user/);
    expect(lines('memory.tombstones_unkeyed')).toEqual([]);
    expect(a.session('s2', { userId: 'bob' }).id).toBe('s2');
    expect(lines('memory.tombstones_unkeyed')).toHaveLength(1);
  });

  it('treats a tombstoneKey that holds no key as none', async () => {
    const { a } = await open({ tombstoneKey: null } as unknown as Partial<SouledAgentOptions>);
    expect(a.session('s1', { userId: 'alice' }).id).toBe('s1');
    expect(() => a.session('s2', { userId: 'bob' })).toThrow(KEY_NEEDED);
    // Its deletions write unkeyed tombstones, which then let the second person in.
    expect((await a.forgetUser!('carol')).tombstone).toEqual({ form: 'unkeyed', written: true });
    expect(a.session('s2', { userId: 'bob' }).id).toBe('s2');
    expect(lines('memory.tombstones_unkeyed')).toHaveLength(1);
  });

  it('keeps a person forgotten with no key forgotten once the store opens with a key, and after the key is rotated', async () => {
    const { a } = await open();
    await say(a, 's1', 'alice', 'My canary is LARK-7.');
    expect((await a.forgetUser!('alice')).tombstone).toEqual({ form: 'unkeyed', written: true });
    await closed(a);

    /** One forgotten person's turn: nothing of it is filed, and a fresh session of theirs recalls nothing planted. */
    const staysForgotten = async (agent: SouledAgent, s: ProviderScript, userId: string, tag: string) => {
      // A trace of the person another process stored after the tombstone.
      const brain = brainOf(agent);
      await brain.run(
        `INSERT INTO memory_traces
           (brain_id, id, type, scope, content, embedding, strength, created_at,
            last_accessed, retrieval_count, tags, emotions, metadata, deleted, scope_id)
         VALUES (?, ?, 'episodic', 'conversation', ?, NULL, 1.0, ?, NULL, 0, '[]', '{}', '{}', 0, ?)`,
        [brain.brainId, `late-${tag}`, `My boat is PLANTED-${tag}.`, Date.now(), userKey(userId)],
      );
      await say(agent, `${tag}-a`, userId, `My canary is SAID-${tag}.`);
      const question = `What is my canary, and my boat? (${tag})`;
      await say(agent, `${tag}-b`, userId, question);
      // The model call of the question's turn.
      const asked = s.seen.filter((call) => sentIn(call).includes(question)).at(-1);
      expect(asked).toBeDefined();
      expect(sentIn(asked!)).not.toContain(`SAID-${tag}`);
      expect(sentIn(asked!)).not.toContain(`PLANTED-${tag}`);
    };

    events.length = 0;
    const keyed = await open({ tombstoneKey: 'k-one' });
    await staysForgotten(keyed.a, keyed.s, 'alice', 'one');
    expect((await keyed.a.forgetUser!('bob')).tombstone).toEqual({ form: 'keyed', written: true });
    await closed(keyed.a);
    expect(tracesHolding('SAID-one')).toEqual([]);
    expect(lines('memory.write_refused').length).toBeGreaterThanOrEqual(1);
    for (const line of lines('memory.write_refused')) expect(line).toMatchObject({ reason: 'forgotten' });

    events.length = 0;
    const rotated = await open({ tombstoneKey: { current: 'k-two', previous: ['k-one'] } });
    await staysForgotten(rotated.a, rotated.s, 'alice', 'two');
    await staysForgotten(rotated.a, rotated.s, 'bob', 'three');
    await closed(rotated.a);
    expect(tracesHolding('SAID-two')).toEqual([]);
    expect(tracesHolding('SAID-three')).toEqual([]);
    expect(lines('memory.write_refused').length).toBeGreaterThanOrEqual(2);
    for (const line of lines('memory.write_refused')) expect(line).toMatchObject({ reason: 'forgotten' });
    expect(lines('memory.tombstones_unkeyed')).toEqual([]);
  });

  it('never needs the key for sharedMemory, which keeps one person', async () => {
    const { a } = await open({ retention: undefined, sharedMemory: { as: 'me', reason: 'one-persons-machine' } });
    await a.session('s1').send('My canary is LARK-7.');
    await a.session('s2').send('My boat is the Heron.');
    await a.session('s3', { userId: 'me' }).send('Hello again.');
    await closed(a);
    expect(tracesUnder(userKey('me')).length).toBeGreaterThanOrEqual(3);

    const { a: again } = await open({ retention: undefined, sharedMemory: { as: 'me', reason: 'one-persons-machine' } });
    expect(again.session('s4').id).toBe('s4');
    expect(lines('memory.tombstones_unkeyed')).toEqual([]);
  });
});
