/**
 * A souled agent's deletion report as the receipt a host keeps, end to end over the real agent, generateText, provider
 * manager, Memory store and wiki; only the OpenAI provider class is stubbed (helpers/stubProviders.ts), at its module
 * boundary.
 *
 * - The report holds when the deletion completed, the agent's id, the library's version, the deletion's four parts in
 *   the order they run (the tombstone, the mind, the store, the open sessions), each reached with its count or missed
 *   with its reason, and who receives a person's text; it holds no id, no hash of one and no text.
 * - A linked session's deletion adds into the same four parts.
 * - An incomplete deletion writes one `memory.forget_incomplete` line naming the parts it missed; a complete one writes
 *   none.
 * - On a souled agent with a learning layer, `agent.learning.forgetUser` runs the same deletion as `agent.forgetUser`
 *   and returns its report with the three fields the layer's report type requires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';

/** The runtime the cases run on; a case that needs what only the GMI runtime has names it. */
const RUNTIME = 'legacy' as const;

/** The receipt's fields, read through `unknown` while the report's type does not declare them. */
type Part = { part: string; reached: boolean; deleted?: number; reason?: string };
type Receipt = {
  completedAt: string;
  agentId: string;
  libraryVersion: string;
  parts: Part[];
  recipients: unknown[];
  complete: boolean;
  pendingAtDeadline: number;
  stores: Array<{ store: string; reached: boolean }>;
};
const receiptOf = (report: unknown): Receipt => report as Receipt;

let n = 0;
let dir: string;
const opened: SouledAgent[] = [];
/** Every line the library logged in the case, parsed. */
let events: Array<Record<string, unknown>>;
beforeEach(() => {
  globalLLMProviderHealth.reset();
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

/** A souled agent on the stubbed provider; `retention` and `tombstoneKey` are set so two people may share the store. */
async function open(extra: Partial<SouledAgentOptions> = {}): Promise<SouledAgent> {
  const apiKey = `k-souled-deletion-report-${++n}`;
  script('openai', apiKey, { whole: true, replies: spare() });
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

    const report = receiptOf(await a.forgetUser!('alice'));

    expect(report.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.parse(report.completedAt) - Date.now())).toBeLessThan(60_000);
    expect(report.agentId).toBe('aria-1');
    expect(report.libraryVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.parts.map((p) => p.part)).toEqual(['tombstone', 'mind', 'store', 'sessions']);
    expect(report.parts[0]).toEqual({ part: 'tombstone', reached: true, deleted: 0 });
    expect(report.parts[1]).toEqual({ part: 'mind', reached: true, deleted: 0 });
    expect(report.parts[2]).toMatchObject({ part: 'store', reached: true });
    expect(report.parts[2]!.deleted).toBeGreaterThanOrEqual(2);
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

    const report = receiptOf(await a.forgetUser!('alice', { linkedSessions: ['v1'] }));

    expect(report.parts.map((p) => p.part)).toEqual(['tombstone', 'mind', 'store', 'sessions']);
    expect(report.parts[2]).toMatchObject({ part: 'store', reached: true });
    // Her two traces and the visitor's two.
    expect(report.parts[2]!.deleted).toBeGreaterThanOrEqual(4);
    // Her session and the linked one, each cleared.
    expect(report.parts[3]).toEqual({ part: 'sessions', reached: true, deleted: 2 });
    expect(report.complete).toBe(true);
    expect(tracesOf(keyOf({ kind: 'session', id: 'v1' }))).toEqual([]);
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
      const report = receiptOf(await a.forgetUser!('alice'));

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

    const report = receiptOf(await a.forgetUser!('alice'));

    expect(report.complete).toBe(false);
    expect(report.parts[2]).toMatchObject({ part: 'store', reached: false });
    expect(report.parts[2]!.reason).toContain('disk full');
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
    const receipt = receiptOf(report);
    expect(receipt.agentId).toBe('aria-1');
    expect(receipt.parts.map((p) => p.part)).toEqual(['tombstone', 'mind', 'store', 'sessions']);
    expect(receipt.parts[2]).toMatchObject({ part: 'store', reached: true });
    expect(receipt.stores).toContainEqual(expect.objectContaining({ store: 'learning store', reached: true }));
    expect(receipt.stores).toContainEqual(expect.objectContaining({ store: 'conversation memory', reached: true }));
    // A gmi() session keeps its messages: her open session is a part the deletion did not reach.
    expect(receipt.parts[3]).toMatchObject({ part: 'sessions', reached: false });
    expect(receipt.complete).toBe(false);

    // agent.forgetUser's own report names nobody.
    const plain = await a.forgetUser!('bob');
    expect(plain).not.toHaveProperty('userId');
    expect(plain).not.toHaveProperty('namespace');
    expect(JSON.stringify(plain)).not.toContain('bob');
    expect(tracesOf(keyOf(bob))).toEqual([]);
  });
});
