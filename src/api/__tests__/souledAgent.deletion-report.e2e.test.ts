/**
 * A souled agent's deletion report as the receipt a host keeps, end to end over the real agent, generateText, provider
 * manager, Memory store and wiki; only the OpenAI provider class is stubbed (helpers/stubProviders.ts), at its module
 * boundary.
 *
 * - The report holds when the deletion completed, the agent's id, the library's version, the deletion's four parts in
 *   the order they run (the tombstone, the mind, the store, the open sessions), each reached with its count or missed
 *   with its reason, and who receives a person's text; it holds no id, no hash of one and no text. A souled agent on
 *   `runtime: 'gmi'` with cognitive memory off, whose memory provider files each turn, gives the same receipt.
 * - A linked session's deletion adds into the same four parts.
 * - A deletion still runs when the routes the store recorded cannot be read: the report lists the routes it knows and
 *   names the recorded ones as not reached.
 * - An incomplete deletion writes one `memory.forget_incomplete` line naming the parts it missed; a complete one writes
 *   none. A store, a page or older memory nobody attributed that the deletion left is the store part missed.
 * - On a souled agent with a learning layer, `agent.learning.forgetUser` runs the same deletion as `agent.forgetUser`
 *   and returns its report with the three fields the layer's report type requires.
 * - On `runtime: 'gmi'` a deletion empties each session the handle holds open for the person and for each linked
 *   session: its messages, and what its GMI holds of the person (its history, its reasoning trace, its sentiment trend,
 *   its working-memory slots, its metaprompts' imprints; a metaprompt still running applies nothing). Another
 *   person's session is left as it is, and an idle session is emptied whatever the deadline. A
 *   session whose turn is still running at the deadline leaves the `sessions` part missed; it is emptied once that
 *   turn ends, the turn's memory writes are refused, and the deletion made again reports the part reached. The
 *   default runtime clears each open session handle and counts it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
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
import { forgetUserMemory, type ForgetMemoryReport } from '../../cognition/memory/io/forgetUserMemory';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { UserWikiStore } from '../../cognition/substrate/memory/wiki/UserWikiStore';
import { GMI } from '../../cognition/substrate/GMI';

/** The runtime the cases run on; a case that needs what only the GMI runtime has names it. */
const RUNTIME = 'legacy' as const;

/** Why a learning layer's deletion does not reach a conversation's own history, on a souled agent. */
const HELD_ELSEWHERE = 'a session another agent object or another process holds open keeps its messages until the host closes it';

/** The count of a part the deletion reached, and the reason of one it missed. */
const deletedBy = (part: ForgetMemoryReport['parts'][number] | undefined): number | undefined => (part?.reached ? part.deleted : undefined);
const reasonOf = (part: ForgetMemoryReport['parts'][number] | undefined): string | undefined => (part && !part.reached ? part.reason : undefined);

let n = 0;
let dir: string;
const opened: SouledAgent[] = [];
/** Every line the library logged in the case, parsed. */
let events: Array<Record<string, unknown>>;
beforeEach(() => {
  globalLLMProviderHealth.reset();
  recordedRoutes.fail = undefined;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-deletion-report-e2e-'));
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

/** The logged lines of one event. */
const lines = (event: string) => events.filter((line) => line.event === event);

const storeFile = () => path.join(dir, 'memory', '.store', 'memory.sqlite');
const keyOf = (subject: { kind: 'user' | 'session'; id: string }) => conversationScopeKey('aria-1', subject);
const alice = { kind: 'user' as const, id: 'alice' };
const bob = { kind: 'user' as const, id: 'bob' };

let replyNo = 0;
/** Replies to spare, each with words of its own: the store keeps one trace for a text a subject's memory already holds. */
const spare = (): ProviderScript['replies'] => Array.from({ length: 60 }, () => reply.text(`Noted ${++replyNo}.`));

/** The script the provider of the agent opened last plays: every request it served is in `seen`. */
let served: ProviderScript;

/**
 * A souled agent on the stubbed provider, which answers with `replies` in order; `retention` and `tombstoneKey` are
 * set so two people may share the store.
 */
async function open(extra: Partial<SouledAgentOptions> = {}, replies: ProviderScript['replies'] = spare()): Promise<SouledAgent> {
  const apiKey = `k-souled-deletion-report-${++n}`;
  served = script('openai', apiKey, { whole: true, replies });
  const a = await souledAgent({
    runtime: RUNTIME,
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    soul: dir,
    retention: { traces: 'until-deletion' },
    tombstoneKey: 'k-souled-deletion-report-tombstones',
    ...extra,
  } as unknown as SouledAgentOptions);
  opened.push(a);
  return a;
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
const tracesOf = (key: string) =>
  rows<{ id: string; content: string }>("SELECT id, content FROM memory_traces WHERE scope = 'conversation' AND scope_id = ?", [key]);
const pagesOf = (key: string) => rows<{ page_id: string }>('SELECT page_id FROM memory_pages WHERE scope_id = ?', [key]);
const registryOf = (key: string) => rows<{ scope_id: string }>('SELECT scope_id FROM memory_scopes WHERE scope_id = ?', [key]);

/** One turn of a user or an anonymous session, and a wait until both of its traces are stored. */
async function turn(a: SouledAgent, sessionId: string, userId: string | undefined, text: string): Promise<void> {
  const key = keyOf(userId ? { kind: 'user', id: userId } : { kind: 'session', id: sessionId });
  const before = tracesOf(key).length;
  await a.session(sessionId, userId ? { userId } : undefined).send(text);
  await vi.waitFor(() => expect(tracesOf(key).length).toBeGreaterThanOrEqual(before + 2), { timeout: 4_000 });
}

describe(`a deletion report a host can keep, on runtime ${RUNTIME}`, () => {
  it('the report is a receipt with no id and no text', async () => {
    const a = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's2', 'bob', 'My canary is WREN-2.');

    const report = await a.forgetUser!('alice');

    expect(report.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.parse(report.completedAt) - Date.now())).toBeLessThan(60_000);
    expect(report.agentId).toBe('aria-1');
    expect(report.libraryVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.parts.map((p) => p.part)).toEqual(['tombstone', 'mind', 'store', 'sessions']);
    expect(report.parts[0]).toEqual({ part: 'tombstone', reached: true, deleted: 0 });
    expect(report.parts[1]).toEqual({ part: 'mind', reached: true, deleted: 0 });
    expect(report.parts[2]).toMatchObject({ part: 'store', reached: true });
    expect(deletedBy(report.parts[2])).toBeGreaterThanOrEqual(2);
    // The one session this handle holds open for her is cleared.
    expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 1 });
    expect(report.recipients).toEqual(await a.recipients!());
    expect(report.recipients.length).toBeGreaterThan(0);
    expect(report.complete).toBe(true);

    // Neither the id, nor a hash of it, nor a word she said.
    const json = JSON.stringify(report);
    expect(json).not.toContain('alice');
    expect(json).not.toContain('LARK-7');
    expect(json).not.toMatch(/[0-9a-f]{32}/i);
    expect(lines('memory.forget_incomplete')).toEqual([]);
    expect(tracesOf(keyOf(bob)).length).toBeGreaterThanOrEqual(2);
  });

  it("a linked session's deletion adds into the same four parts", async () => {
    const a = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 'v1', undefined, 'Is the room by the weir still free?');

    const report = await a.forgetUser!('alice', { linkedSessions: ['v1'] });

    expect(report.parts.map((p) => p.part)).toEqual(['tombstone', 'mind', 'store', 'sessions']);
    expect(report.parts[2]).toMatchObject({ part: 'store', reached: true });
    // Her two traces and the visitor's two.
    expect(deletedBy(report.parts[2])).toBeGreaterThanOrEqual(4);
    // Her session and the linked one, each cleared.
    expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 2 });
    expect(report.complete).toBe(true);
    expect(tracesOf(keyOf({ kind: 'session', id: 'v1' }))).toEqual([]);
  });

  it('lists the routes it knows when the recorded ones cannot be read, and still deletes', async () => {
    const a = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    const named = await a.recipients!();
    recordedRoutes.fail = new Error('the store went away');

    const report = await a.forgetUser!('alice');

    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(report.recipients).toEqual(named);
    expect(report.stores).toContainEqual({ store: 'recipients recorded in the store', reached: false, reason: 'the store went away' });
    // The list is not a store the deletion deletes from: the deletion is complete.
    expect(report.parts.every((p) => p.reached)).toBe(true);
    expect(report.complete).toBe(true);
    expect(lines('memory.recipients_unread')).toHaveLength(1);
    expect(lines('memory.forget_incomplete')).toEqual([]);
  });

  it("lists a route the person's text took while the deletion waited for their compile", async () => {
    const envKey = `k-souled-deletion-report-env-${++n}`;
    vi.stubEnv('ANTHROPIC_API_KEY', envKey);
    const anthropic = script('anthropic', envKey, { whole: true, replies: spare() });
    /** Set while a case holds the router's next pick; `asked` is called when a pick waits on it. */
    let hold: Promise<void> | undefined;
    let asked!: () => void;
    const pickAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const router = {
      routerId: 'stub-router',
      initialize: async () => undefined,
      selectModel: async () => {
        if (hold) {
          asked();
          await hold;
        }
        return { provider: {}, modelId: 'claude-routed', modelInfo: { providerId: 'anthropic' }, reasoning: 'stub', confidence: 1 };
      },
    };
    const a = await open({ router } as unknown as Partial<SouledAgentOptions>);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's1', 'alice', 'I keep it in the attic.');
    const compiled = { role: 'compile', provider: 'anthropic', model: 'claude-routed' };
    expect(await a.recipients!()).not.toContainEqual(compiled);
    const callsBeforeCompile = anthropic.seen.length;

    // Her compile waits on the router's pick when the deletion starts; the deletion waits for her compile.
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compiling = a.memory!.compileWiki({ scopes: [keyOf(alice)] }).catch(() => undefined);
    await pickAsked;
    const deleting = a.forgetUser!('alice');
    setTimeout(release, 50);
    const report = await deleting;
    // The routed provider received her compile's prompt before the deletion ended.
    expect(anthropic.seen.length).toBeGreaterThan(callsBeforeCompile);
    await compiling;

    expect(report.recipients).toContainEqual(compiled);
    expect(report.recipients).toEqual(await a.recipients!());
    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(pagesOf(keyOf(alice))).toEqual([]);
  });
});

describe("a deletion report a host can keep, on runtime 'gmi' with cognitive memory off", () => {
  it('the report is the same receipt as on the default runtime: its time, version, four parts and recipients, with no id and no text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = await open({ runtime: 'gmi' } as Partial<SouledAgentOptions>);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's2', 'bob', 'My canary is WREN-2.');
    await a.memory!.compileWiki();
    expect(pagesOf(keyOf(alice))).toHaveLength(1);

    const report = await a.forgetUser!('alice');

    expect(report.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.parse(report.completedAt) - Date.now())).toBeLessThan(60_000);
    expect(report.agentId).toBe('aria-1');
    expect(report.libraryVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.parts.map((p) => p.part)).toEqual(['tombstone', 'mind', 'store', 'sessions']);
    expect(report.parts[0]).toEqual({ part: 'tombstone', reached: true, deleted: 0 });
    // With cognitive memory off the mind holds nothing of her.
    expect(report.parts[1]).toEqual({ part: 'mind', reached: true, deleted: 0 });
    expect(report.parts[2]).toMatchObject({ part: 'store', reached: true });
    // Her two traces and the chunks of her page, all filed by the provider.
    expect(deletedBy(report.parts[2])).toBeGreaterThanOrEqual(2);
    // The one session this handle holds open for her is emptied.
    expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 1 });
    expect(report.stores).toContainEqual({ store: 'session history in this process', reached: true, deleted: 1 });
    expect(report.recipients).toEqual(await a.recipients!());
    expect(report.recipients).toContainEqual({ role: 'model', provider: 'openai', model: 'stub-model' });
    expect(report.complete).toBe(true);

    // Neither the id, nor a hash of it, nor a word she said.
    const json = JSON.stringify(report);
    expect(json).not.toContain('alice');
    expect(json).not.toContain('LARK-7');
    expect(json).not.toMatch(/[0-9a-f]{32}/i);
    expect(lines('memory.forget_incomplete')).toEqual([]);
    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(pagesOf(keyOf(alice))).toEqual([]);
    expect(tracesOf(keyOf(bob)).length).toBeGreaterThanOrEqual(2);
  });
});

describe(`an incomplete deletion says so in one line, on runtime ${RUNTIME}`, () => {
  it('a write held past the deadline', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = await open({
      pendingWritesTimeoutMs: 0,
      screen: async (text: string) => {
        await held;
        return text;
      },
    } as Partial<SouledAgentOptions>);
    try {
      await a.session('s1', { userId: 'alice' }).send('My canary is LARK-7.');
      const report = await a.forgetUser!('alice');

      expect(report.complete).toBe(false);
      expect(report.pendingAtDeadline).toBeGreaterThanOrEqual(1);
      const said = lines('memory.forget_incomplete');
      expect(said).toHaveLength(1);
      expect(said[0]).toMatchObject({
        level: 40,
        tombstone: 'reached',
        mind: 'reached',
        store: 'reached',
        sessions: 'reached',
        pendingAtDeadline: report.pendingAtDeadline,
        pagesFailed: 0,
      });
      expect(JSON.stringify(said)).not.toContain('alice');
    } finally {
      release();
    }
    // The write that was held lands after the tombstone and is taken back.
    await vi.waitFor(() => expect(lines('memory.write_refused').some((line) => line.reason === 'forgotten')).toBe(true), { timeout: 4_000 });
    await a.close();
    expect(tracesOf(keyOf(alice))).toEqual([]);
  });

  it('a store it could not reach names the store part as missed', async () => {
    const a = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    vi.spyOn(a.memory!, 'rebuildVectorIndex').mockRejectedValueOnce(new Error('disk full'));

    const report = await a.forgetUser!('alice');

    expect(report.complete).toBe(false);
    expect(report.parts[2]).toMatchObject({ part: 'store', reached: false });
    expect(reasonOf(report.parts[2])).toContain('disk full');
    expect(lines('memory.forget_incomplete')).toEqual([
      expect.objectContaining({ tombstone: 'reached', mind: 'reached', store: 'missed', sessions: 'reached', pendingAtDeadline: 0, pagesFailed: 0 }),
    ]);
  });

  it('a page it could not delete names the store part as missed, and the deletion made again finishes it', async () => {
    const a = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await a.memory!.compileWiki();
    expect(pagesOf(keyOf(alice))).toHaveLength(1);
    vi.spyOn(UserWikiStore.prototype, 'deletePage').mockRejectedValueOnce(new Error('disk I/O error'));

    const report = await a.forgetUser!('alice');

    expect(report.complete).toBe(false);
    expect(report.parts[2]).toEqual({ part: 'store', reached: false, reason: '1 page not deleted' });
    expect(lines('memory.forget_incomplete')).toEqual([
      expect.objectContaining({ tombstone: 'reached', mind: 'reached', store: 'missed', sessions: 'reached', pendingAtDeadline: 0, pagesFailed: 1 }),
    ]);

    events.length = 0;
    const again = await a.forgetUser!('alice');
    expect(again.complete).toBe(true);
    expect(again.parts.every((p) => p.reached)).toBe(true);
    expect(pagesOf(keyOf(alice))).toEqual([]);
    expect(lines('memory.forget_incomplete')).toEqual([]);
  });

  it('older memory nobody attributed names the store part as missed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = await open();
    await a.memory!.remember('old shared words', { type: 'episodic', scope: 'persona', scopeId: 'aria-1' });
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');

    const report = await a.forgetUser!('alice');

    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(report.complete).toBe(false);
    expect(report.parts[2]).toEqual({ part: 'store', reached: false, reason: 'legacy memory under the agent scope: unattributed' });
    expect(lines('memory.forget_incomplete')).toEqual([
      expect.objectContaining({ tombstone: 'reached', mind: 'reached', store: 'missed', sessions: 'reached', pendingAtDeadline: 0, pagesFailed: 0 }),
    ]);
  });
});

describe("agent.learning.forgetUser on a souled agent, on runtime 'gmi'", () => {
  it('deletes everything agent.forgetUser deletes, at once, and returns the report', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = await open({ runtime: 'gmi', learning: true } as Partial<SouledAgentOptions>);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's2', 'bob', 'My canary is WREN-2.');
    await a.memory!.compileWiki();
    expect(pagesOf(keyOf(alice))).toHaveLength(1);
    const ofBob = tracesOf(keyOf(bob));

    const report = await a.learning!.forgetUser!('alice');

    // No row and no page under her key, before any open or applyTombstones().
    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(pagesOf(keyOf(alice))).toEqual([]);
    expect(registryOf(keyOf(alice))).toEqual([]);
    expect(rows("SELECT id FROM memory_traces WHERE content LIKE '%LARK-7%'")).toEqual([]);
    expect(tracesOf(keyOf(bob))).toEqual(ofBob);

    // The deletion report, with the three fields the layer's report type requires.
    expect(report).toMatchObject({ userId: 'alice', namespace: '', plainFormLeft: 0 });
    // The call's declared type is the layer's report: the deletion's fields are read through the deletion's own.
    const receipt = report as unknown as ForgetMemoryReport;
    expect(receipt.agentId).toBe('aria-1');
    expect(receipt.parts.map((p) => p.part)).toEqual(['tombstone', 'mind', 'store', 'sessions']);
    expect(receipt.parts[2]).toMatchObject({ part: 'store', reached: true });
    expect(receipt.stores).toContainEqual(expect.objectContaining({ store: 'learning store', reached: true }));
    // The layer's own count of what it deleted, table by table, as its own call returns it.
    expect(report.stores.find((entry) => entry.store === 'learning store')).toMatchObject({
      reached: true,
      deleted: { ledger: expect.any(Number), traits: expect.any(Number) },
    });
    expect(receipt.stores).toContainEqual(expect.objectContaining({ store: 'conversation memory', reached: true }));
    // The session the handle holds open for her is emptied with the rest.
    expect(receipt.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 1 });
    expect(receipt.complete).toBe(true);
    // What the layer does not reach names a session held elsewhere, never the sessions the handle emptied.
    expect(receipt.stores).toContainEqual({ store: "a conversation's own history", reached: false, reason: HELD_ELSEWHERE });
    expect(JSON.stringify(receipt.stores)).not.toContain("gmi() session's history");

    // agent.forgetUser's own report names nobody.
    const plain = await a.forgetUser!('bob');
    expect(JSON.stringify(plain.stores)).not.toContain("gmi() session's history");
    expect(plain).not.toHaveProperty('userId');
    expect(plain).not.toHaveProperty('namespace');
    expect(JSON.stringify(plain)).not.toContain('bob');
    expect(tracesOf(keyOf(bob))).toEqual([]);
  });
});

describe("a souled agent's deletion after close, on runtime 'gmi'", () => {
  it('deletes nothing, on either call, and says the agent was closed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = await open({ runtime: 'gmi', learning: true } as Partial<SouledAgentOptions>);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await a.close();

    await expect(a.learning!.forgetUser!('alice')).rejects.toThrow('souledAgent: the agent was closed');
    await expect(a.forgetUser!('alice')).rejects.toThrow('souledAgent: the agent was closed');
    // Her rows stand for the deletion made on the agent opened again.
    expect(tracesOf(keyOf(alice)).length).toBeGreaterThanOrEqual(2);
    expect(lines('memory.forget_done')).toEqual([]);
  });
});

describe('the deletion core, called by a host of its own', () => {
  it("a callback of the host's that rejects leaves the store part missed, and the report still comes back", async () => {
    const a = await open();
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');

    const report = await forgetUserMemory({
      memory: a.memory!,
      agentId: 'aria-1',
      subject: alice,
      wiki: {
        storeFor: () => {
          throw new Error('she has no pages');
        },
      } as never,
      extraStores: async () => {
        throw new Error('the host store went away');
      },
    });

    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(report.complete).toBe(false);
    expect(report.stores).toContainEqual({ store: "the caller's own stores", reached: false, reason: 'the host store went away' });
    expect(report.parts[2]).toMatchObject({ part: 'store', reached: false });
    expect(reasonOf(report.parts[2])).toContain('the host store went away');
    expect(lines('memory.forget_done')).toHaveLength(1);
    expect(lines('memory.forget_incomplete')).toEqual([
      expect.objectContaining({ tombstone: 'reached', mind: 'reached', store: 'missed', sessions: 'reached' }),
    ]);
  });
});

describe("a person deleted while a turn of her gmi() session still runs, on runtime 'gmi'", () => {
  it('no longer counts as a person the store holds once the store part is reached', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // No retention choice: the store may hold one person's memory.
    const a = await open({ runtime: 'gmi', retention: undefined, pendingWritesTimeoutMs: 50 } as Partial<SouledAgentOptions>, [
      reply.text('Noted.'),
      reply.hold([], gate, reply.text('Noted, held.')),
      ...spare(),
    ]);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    // Her next turn waits for the model when the deletion comes.
    const calls = served.seen.length;
    const running = a.session('s1', { userId: 'alice' }).send('I keep it in the attic.');
    await vi.waitFor(() => expect(served.seen.length).toBeGreaterThan(calls), { timeout: 4_000 });
    try {
      const report = await a.forgetUser!('alice');

      expect(report.parts[2]).toMatchObject({ part: 'store', reached: true });
      expect(report.parts[3]).toMatchObject({ part: 'sessions', reached: false });
      expect(report.complete).toBe(false);
      expect(tracesOf(keyOf(alice))).toEqual([]);
      // The store holds nothing of her: another person's session opens with no retention choice made.
      expect(() => a.session('s2', { userId: 'bob' })).not.toThrow();
    } finally {
      release();
    }
    await running;
  });
});

describe("open sessions that keep no history, on runtime 'gmi'", () => {
  it('a session opened with history off holds nothing to empty: the sessions part is reached', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = await open({ runtime: 'gmi', history: false } as Partial<SouledAgentOptions>);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');

    const report = await a.forgetUser!('alice');

    expect(tracesOf(keyOf(alice))).toEqual([]);
    expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 0 });
    expect(report.complete).toBe(true);
    expect(lines('memory.forget_incomplete')).toEqual([]);
  });
});

/** The GMIs built in the case, in order: a session that keeps history builds one, with its first turn. */
function builtGmis(): GMI[] {
  const built: GMI[] = [];
  const initialize = GMI.prototype.initialize;
  vi.spyOn(GMI.prototype, 'initialize').mockImplementation(async function (this: GMI, ...args) {
    built.push(this);
    return initialize.apply(this, args);
  });
  return built;
}

describe("a deletion and the open sessions, on runtime 'gmi' with sentiment on and cognitive memory off", () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  /** A souled agent on `runtime: 'gmi'` with the full profile's sentiment and no cognitive memory. */
  const openGmi = (extra: Partial<SouledAgentOptions> = {}, replies: ProviderScript['replies'] = spare()): Promise<SouledAgent> =>
    open({ runtime: 'gmi', cognition: 'full', memory: false, ...extra } as unknown as Partial<SouledAgentOptions>, replies);

  it('a deletion empties an idle open session', async () => {
    const gmis = builtGmis();
    const forgetPerson = vi.spyOn(GMI.prototype, 'forgetPerson');
    const a = await openGmi();
    const session = a.session('s1', { userId: 'alice' });
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's1', 'alice', 'I keep it in the attic.');
    expect(session.messages().length).toBeGreaterThanOrEqual(4);
    expect(gmis).toHaveLength(1);
    const gmi = gmis[0];
    // Her session's GMI holds her turns, her sentiment trend with an excerpt of each message, and her last sentiment.
    await vi.waitFor(
      async () => {
        const held = await gmi.getWorkingMemorySnapshot();
        expect(held.gmi_sentiment_history?.trends?.length).toBeGreaterThan(0);
        expect(held.currentUserContext?.currentSentiment).toBeDefined();
        expect(JSON.stringify(held)).toContain('LARK-7');
      },
      { timeout: 4_000 },
    );
    expect(gmi.getConversationHistory().length).toBeGreaterThanOrEqual(4);

    const report = await a.forgetUser!('alice');

    expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 1 });
    expect(report.complete).toBe(true);
    expect(report.stores.map((entry) => entry.store)).not.toContain("a gmi() session's history");
    expect(report.stores).toContainEqual({ store: 'session history in this process', reached: true, deleted: 1 });
    expect(lines('memory.forget_incomplete')).toEqual([]);
    expect(session.messages()).toEqual([]);
    // The session's GMI was asked once, and holds nothing more of her.
    expect(forgetPerson).toHaveBeenCalledTimes(1);
    expect(gmi.getConversationHistory()).toEqual([]);
    const held = await gmi.getWorkingMemorySnapshot();
    expect(held).not.toHaveProperty('gmi_sentiment_history');
    expect(held.currentUserContext).not.toHaveProperty('currentSentiment');
    expect(JSON.stringify([held, gmi.getReasoningTrace()])).not.toContain('LARK-7');

    // Her next turn on the session sends none of her earlier words.
    const calls = served.seen.length;
    await session.send('Is the shop open today?');
    const sent = JSON.stringify(served.seen.slice(calls).map((call) => call.messages));
    expect(served.seen.length).toBeGreaterThan(calls);
    expect(sent).toContain('Is the shop open today?');
    expect(sent).not.toContain('LARK-7');
    expect(sent).not.toContain('attic');
  });

  it("empties each session open for the person and each linked session, and leaves another person's as it is", async () => {
    const forgetPerson = vi.spyOn(GMI.prototype, 'forgetPerson');
    const a = await openGmi();
    const first = a.session('s1', { userId: 'alice' });
    const second = a.session('s2', { userId: 'alice' });
    const visitor = a.session('v1');
    const other = a.session('s3', { userId: 'bob' });
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await turn(a, 's2', 'alice', 'I keep it in the attic.');
    await turn(a, 'v1', undefined, 'Is the room by the weir still free?');
    await turn(a, 's3', 'bob', 'My canary is WREN-2.');
    const ofBob = other.messages();
    expect(ofBob.length).toBeGreaterThanOrEqual(2);

    const report = await a.forgetUser!('alice', { linkedSessions: ['v1'] });

    // Her two sessions and the linked one.
    expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 3 });
    expect(report.complete).toBe(true);
    expect(first.messages()).toEqual([]);
    expect(second.messages()).toEqual([]);
    expect(visitor.messages()).toEqual([]);
    expect(forgetPerson).toHaveBeenCalledTimes(3);
    expect(other.messages()).toEqual(ofBob);
    expect(tracesOf(keyOf(bob)).length).toBeGreaterThanOrEqual(2);
  });

  it('an idle open session is emptied when the deadline is 0', async () => {
    const forgetPerson = vi.spyOn(GMI.prototype, 'forgetPerson');
    const a = await openGmi({ pendingWritesTimeoutMs: 0 });
    const session = a.session('s1', { userId: 'alice' });
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');

    const report = await a.forgetUser!('alice');

    // No turn of the session runs, so nothing is waited for: the session is emptied, not counted as running.
    expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 1 });
    expect(session.messages()).toEqual([]);
    expect(forgetPerson).toHaveBeenCalledTimes(1);
  });

  it('drops what a metaprompt imprinted of the person, and a metaprompt still running when she is forgotten applies nothing', async () => {
    const gmis = builtGmis();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A metaprompt's answer: one memory imprint, under a working-memory key of its own.
    const imprint = (key: string, value: string) =>
      reply.text(JSON.stringify({ adjustmentRationale: 'The user asked twice.', newMemoryImprints: [{ key, value, description: 'what the user said' }] }));
    const a = await openGmi({}, [
      reply.text('Noted first.'),
      imprint('canary_note', 'Her canary is LARK-7.'),
      reply.text('Noted second.'),
      reply.hold([], gate, imprint('attic_note', 'She keeps it in the attic.')),
      ...spare(),
    ]);
    const session = a.session('s1', { userId: 'alice' });
    // A doubled question mark reads as confusion: the GMI's confusion metaprompt runs once the turn has ended.
    await session.send('My canary is LARK-7??');
    const gmi = gmis[0];
    await vi.waitFor(async () => expect(await gmi.getWorkingMemorySnapshot()).toHaveProperty('canary_note', 'Her canary is LARK-7.'), {
      timeout: 4_000,
    });
    const calls = served.seen.length;
    await session.send('I keep it in the attic??');
    // Her second turn's metaprompt waits for the model when the deletion comes.
    await vi.waitFor(() => expect(served.seen.length).toBeGreaterThanOrEqual(calls + 2), { timeout: 4_000 });
    try {
      const report = await a.forgetUser!('alice');

      expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 1 });
      expect(report.complete).toBe(true);
      expect(await gmi.getWorkingMemorySnapshot()).not.toHaveProperty('canary_note');
    } finally {
      release();
    }
    // The metaprompt that was waiting ends, and its results are discarded.
    await vi.waitFor(
      () => expect(gmi.getReasoningTrace().entries.some((entry) => entry.message.startsWith('Discarded late results'))).toBe(true),
      { timeout: 4_000 },
    );
    const held = await gmi.getWorkingMemorySnapshot();
    expect(held).not.toHaveProperty('attic_note');
    expect(JSON.stringify([held, gmi.getReasoningTrace()])).not.toMatch(/LARK-7|attic/);
  });

  it('keeps nothing of a metaprompt that fails once the person is forgotten', async () => {
    const gmis = builtGmis();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The provider's error quotes what the metaprompt sent it.
    const refusal = new Error('The provider refused a request holding "My canary is LARK-7??"') as unknown as Record<string, unknown>;
    const a = await openGmi({}, [reply.text('Noted first.'), reply.hold([], gate, [refusal]), ...spare()]);
    const session = a.session('s1', { userId: 'alice' });
    const calls = served.seen.length;
    await session.send('My canary is LARK-7??');
    const gmi = gmis[0];
    // Her turn's confusion metaprompt waits for the model when the deletion comes.
    await vi.waitFor(() => expect(served.seen.length).toBeGreaterThanOrEqual(calls + 2), { timeout: 4_000 });
    try {
      const report = await a.forgetUser!('alice');
      expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 1 });
    } finally {
      release();
    }
    // The metaprompt ends: its failure is either discarded or traced.
    const ended = (message: string) => message.startsWith('Discarded late results') || message.startsWith("Metaprompt 'gmi_confusion_clarification' failed");
    await vi.waitFor(() => expect(gmi.getReasoningTrace().entries.some((entry) => ended(entry.message))).toBe(true), { timeout: 4_000 });
    expect(JSON.stringify(gmi.getReasoningTrace())).not.toContain('LARK-7');
  });

  it("drops the GMI's trace of her turns, a failed turn's error that quotes her words included", async () => {
    const gmis = builtGmis();
    const a = await openGmi({}, [reply.text('Noted first.'), new Error('The provider refused a request holding "My canary is LARK-7."'), ...spare()]);
    const session = a.session('s1', { userId: 'alice' });
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    await session.send('Where should it sleep tonight').catch(() => undefined);
    const gmi = gmis[0];
    // The failed turn's error is in the trace, in the entry's message, with her words.
    expect(gmi.getReasoningTrace().entries.some((entry) => entry.message.includes('LARK-7'))).toBe(true);

    const report = await a.forgetUser!('alice');

    expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 1 });
    expect(JSON.stringify(gmi.getReasoningTrace())).not.toContain('LARK-7');
  });

  it('a deletion during a running turn misses the sessions part, empties the session once the turn ends, and finishes when made again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gmis = builtGmis();
    const forgetPerson = vi.spyOn(GMI.prototype, 'forgetPerson');
    const a = await openGmi({ pendingWritesTimeoutMs: 50 }, [reply.text('Noted first.'), reply.hold([], gate, reply.text('Noted, held.')), ...spare()]);
    const session = a.session('s1', { userId: 'alice' });
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    // Her next turn waits for the model when the deletion comes.
    const calls = served.seen.length;
    const running = session.send('I keep it in the attic.');
    await vi.waitFor(() => expect(served.seen.length).toBeGreaterThan(calls), { timeout: 4_000 });
    try {
      const report = await a.forgetUser!('alice');

      expect(report.parts[2]).toMatchObject({ part: 'store', reached: true });
      expect(report.parts[3]).toEqual({ part: 'sessions', reached: false, reason: '1 open session was still running a turn at the deadline' });
      expect(report.complete).toBe(false);
      expect(lines('memory.forget_incomplete')).toEqual([
        expect.objectContaining({ tombstone: 'reached', mind: 'reached', store: 'reached', sessions: 'missed' }),
      ]);
      // The messages are gone at once; the turn still running writes none into the session.
      expect(session.messages()).toEqual([]);
    } finally {
      release();
    }
    expect((await running).text).toBe('Noted, held.');
    expect(session.messages()).toEqual([]);
    // Both memory writes of the turn that ran through the deletion are refused.
    await vi.waitFor(() => expect(lines('memory.write_refused').filter((line) => line.reason === 'forgotten').length).toBeGreaterThanOrEqual(2), {
      timeout: 4_000,
    });
    expect(tracesOf(keyOf(alice))).toEqual([]);
    // Once that turn ended, the session's GMI was emptied too, before any second call.
    await vi.waitFor(
      async () => {
        expect(forgetPerson).toHaveBeenCalledTimes(1);
        expect(gmis[0].getConversationHistory()).toEqual([]);
        expect(await gmis[0].getWorkingMemorySnapshot()).not.toHaveProperty('gmi_sentiment_history');
      },
      { timeout: 4_000 },
    );
    // Her next turn sends none of her earlier words, the running turn's included.
    const before = served.seen.length;
    await session.send('Is the shop open today?');
    const sent = JSON.stringify(served.seen.slice(before).map((call) => call.messages));
    expect(sent).toContain('Is the shop open today?');
    expect(sent).not.toContain('LARK-7');
    expect(sent).not.toContain('attic');

    events.length = 0;
    const again = await a.forgetUser!('alice');
    expect(again.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 1 });
    expect(again.complete).toBe(true);
    expect(lines('memory.forget_incomplete')).toEqual([]);
    expect(session.messages()).toEqual([]);
    expect(tracesOf(keyOf(alice))).toEqual([]);
  });

  it("a deletion called from a hook of the person's own turn does not wait for that turn, and empties the session once it ends", async () => {
    const gmis = builtGmis();
    let asked = 0;
    let report: ForgetMemoryReport | undefined;
    let forget: () => Promise<ForgetMemoryReport> = () => Promise.reject(new Error('not set'));
    const a = await openGmi({
      // Far past the hook's timeout: a deletion that waited for the turn it is called from would outlast the hook.
      pendingWritesTimeoutMs: 30_000,
      memoryProviderOptions: { timeoutMs: 3_000 },
      memoryPolicy: async () => {
        asked += 1;
        if (asked === 1) report = await forget();
        return { longTerm: 'compiled' };
      },
    } as unknown as Partial<SouledAgentOptions>);
    forget = () => a.forgetUser!('alice');
    const session = a.session('s1', { userId: 'alice' });

    // Her turn's hook forgets her while the turn holds the session.
    const startedAt = Date.now();
    await session.send('My canary is LARK-7.');

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(lines('memory.hook_failed')).toEqual([]);
    expect(report?.parts[2]).toMatchObject({ part: 'store', reached: true });
    expect(report?.parts[3]).toEqual({ part: 'sessions', reached: false, reason: '1 open session was still running a turn at the deadline' });
    expect(report?.complete).toBe(false);
    // Once that turn ended, the session and its GMI hold nothing of her.
    await vi.waitFor(
      () => {
        expect(session.messages()).toEqual([]);
        expect(gmis[0].getConversationHistory()).toEqual([]);
      },
      { timeout: 4_000 },
    );
    const again = await a.forgetUser!('alice');
    expect(again.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 1 });
    expect(again.complete).toBe(true);
    await vi.waitFor(() => expect(tracesOf(keyOf(alice))).toEqual([]), { timeout: 4_000 });
  });
});

describe("a deletion and the open sessions, on runtime 'gmi' with cognitive memory on", () => {
  it("empties the working-memory slots of the person's session", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gmis = builtGmis();
    // The embedding provider reads its key from the environment.
    const embeddings = `k-souled-deletion-report-embeddings-${++n}`;
    script('openai', embeddings, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', embeddings);
    const a = await open({
      runtime: 'gmi',
      cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false },
    } as unknown as Partial<SouledAgentOptions>);
    await turn(a, 's1', 'alice', 'My canary is LARK-7.');
    expect(gmis).toHaveLength(1);
    // The session's view of cognitive memory holds a slot for each trace its turn filed.
    const view = gmis[0].getCognitiveMemoryManager()!.getWorkingMemory();
    expect(view.getSlotCount()).toBeGreaterThan(0);

    const report = await a.forgetUser!('alice');

    expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 1 });
    expect(view.getSlotCount()).toBe(0);
    expect(view.formatForPrompt()).toBe('');
  });
});

describe(`a deletion and the open sessions, on runtime ${RUNTIME}`, () => {
  it('clears each session handle open for the person and counts it', async () => {
    const a = await open();
    // One handle a session: the default runtime hands out a new one at each session() call, and each is counted.
    const first = a.session('s1', { userId: 'alice' });
    const second = a.session('s2', { userId: 'alice' });
    const other = a.session('s3', { userId: 'bob' });
    await first.send('My canary is LARK-7.');
    await second.send('I keep it in the attic.');
    await other.send('My canary is WREN-2.');
    await vi.waitFor(
      () => {
        expect(tracesOf(keyOf(alice)).length).toBeGreaterThanOrEqual(4);
        expect(tracesOf(keyOf(bob)).length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 4_000 },
    );
    const ofBob = other.messages();
    expect(first.messages().length).toBeGreaterThanOrEqual(2);
    expect(second.messages().length).toBeGreaterThanOrEqual(2);

    const report = await a.forgetUser!('alice');

    expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 2 });
    expect(report.stores).toContainEqual({ store: 'session history in this process', reached: true, deleted: 2 });
    expect(report.complete).toBe(true);
    expect(first.messages()).toEqual([]);
    expect(second.messages()).toEqual([]);
    expect(other.messages()).toEqual(ofBob);
  });
});
