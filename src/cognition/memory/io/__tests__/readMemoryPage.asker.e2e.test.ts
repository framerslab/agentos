/**
 * @file readMemoryPage.asker.e2e.test.ts
 * Who `read_memory_page` answers: the real tool from the real `attachMemoryWiki`, over a real `Memory` on a SQLite
 * file and an operator folder on disk.
 *
 * The asker is the subject of the turn the call runs in, read from the tool context the runtime built and never from
 * the call's arguments. A subject reads its own pages and the operator's. Another subject's page answers exactly as a
 * page that does not exist. A call that names a scope or a user is refused and reads nothing. With no user (the
 * operator running the agent itself) the tool reads the operator's pages and the pages an earlier version compiled
 * into the folder, and no user's page. Each refusal writes one log line that carries its reason and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import { attachMemoryWiki } from '../attachMemoryWiki.js';
import { Memory } from '../facade/Memory.js';
import { ReadMemoryPageTool } from '../tools/ReadMemoryPageTool.js';
import { conversationScopeKey } from '../../retrieval/store/conversationScopeKey.js';
import { ensureMemoryDir, UserWikiStore, type WikiPage } from '../../../substrate/memory/wiki/index.js';
import { resetLoggerFactory, setLogger } from '../../../../core/logging/loggerFactory.js';

/** What the tool answers, as the test reads it. */
interface Answer {
  success: boolean;
  error?: string;
  details?: { code?: string };
  output?: { id?: string; body?: string; pages?: Array<{ id: string; summary: string; owner: string }> };
}

type Subject = { kind: 'user' | 'session'; id: string };

const AGENT = 'aria-1';
const chunk = (t: string) => [{ text: t }];
const keyOf = (subject: Subject) => conversationScopeKey(AGENT, subject);
const ALICE: Subject = { kind: 'user', id: 'alice' };
const BOB: Subject = { kind: 'user', id: 'bob' };
const SESSION: Subject = { kind: 'session', id: 's1' };

/** A page compiled for one subject, as a compile names and dates it. */
const P = (body: string, sources: string[]): WikiPage => ({
  id: 'concepts/notes',
  type: 'concept',
  summary: 'Notes compiled from conversations',
  updated: '2026-01-01T00:00:00.000Z',
  sources,
  body,
  links: [],
});

/** The context a runtime hands the tool: the turn's user, and the subject its memory is keyed by when it names one. */
const ctx = (userId?: string, memorySubject?: Subject) => ({
  gmiId: 'g',
  personaId: 'p',
  userContext: { userId: userId ?? 'system', ...(memorySubject ? { memorySubject } : {}) },
});

const notFound = (id: string) => ({ success: false, error: `No memory page found with id "${id}".` });

let dir: string;
let memoryDir: string;
let memory: Memory;
let tool: ReadMemoryPageTool;
/** Every line the library logged in the test, parsed. */
let events: Array<Record<string, unknown>>;

/** The refusal lines logged so far, each as its reason. */
const refusals = () => events.filter((line) => line.event === 'memory.page_read_refused').map((line) => line.reason);

/** Calls the tool as a runtime does: any arguments a model wrote, and the context of the turn. */
const call = (args: Record<string, unknown>, context: unknown): Promise<Answer> =>
  (tool as unknown as { execute(a: unknown, c: unknown): Promise<Answer> }).execute(args, context);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-memory-page-asker-'));
  memoryDir = ensureMemoryDir(dir);
  fs.mkdirSync(path.join(memoryDir, 'concepts'), { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, 'concepts', 'ops.md'),
    '---\nid: concepts/ops\ntype: concept\nsummary: Opening hours\n---\nOpen nine to five.\n',
  );
  // A page an earlier version compiled into the folder: its front matter lists the traces it was made from.
  fs.writeFileSync(
    path.join(memoryDir, 'concepts', 'old.md'),
    '---\nid: concepts/old\ntype: concept\nsummary: Earlier notes\nsources:\n  - t-1\n---\nZanzibar.\n',
  );
  memory = await Memory.createSqlite(path.join(dir, 'memory.sqlite'), { graph: false, selfImprove: false, decay: false });
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
  const { tools } = await attachMemoryWiki({ memory, memoryDir, agentId: AGENT, llm: async () => 'x', chunk });
  const found = tools.find((t): t is ReadMemoryPageTool => t instanceof ReadMemoryPageTool);
  if (!found) throw new Error('attachMemoryWiki added no read_memory_page tool');
  tool = found;
  await new UserWikiStore({ scopeId: keyOf(ALICE), pages: memory, chunk }).writePage(P('Alice likes tea.', ['t1']));
  await new UserWikiStore({ scopeId: keyOf(SESSION), pages: memory, chunk }).writePage(P('The session likes coffee.', ['t2']));
});

afterEach(async () => {
  resetLoggerFactory();
  await memory.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('read_memory_page and who asks', () => {
  it("answers the asker's own page and the operator's", async () => {
    const own = await call({ id: 'concepts/notes' }, ctx('alice', ALICE));
    expect(own.success).toBe(true);
    expect(own.output).toMatchObject({ id: 'concepts/notes', body: 'Alice likes tea.\n' });

    const shared = await call({ id: 'concepts/ops' }, ctx('alice', ALICE));
    expect(shared.success).toBe(true);
    expect(shared.output).toMatchObject({ id: 'concepts/ops', body: 'Open nine to five.\n' });
    expect(refusals()).toEqual([]);
  });

  it("answers another subject's page exactly as a page that does not exist", async () => {
    const theirs = await call({ id: 'concepts/notes' }, ctx('bob', BOB));
    expect(theirs).toEqual(notFound('concepts/notes'));
    expect(refusals()).toEqual(['other_user']);

    const none = await call({ id: 'concepts/nope' }, ctx('bob', BOB));
    expect(none).toEqual(notFound('concepts/nope'));
    // The two answers differ by the id in their text alone, and a page nobody has writes no line.
    expect(JSON.stringify(theirs).split('concepts/notes').join('concepts/nope')).toBe(JSON.stringify(none));
    expect(refusals()).toEqual(['other_user']);
    // A refusal line carries its reason and no id, no user and no text of a page.
    const line = JSON.stringify(events.filter((e) => e.event === 'memory.page_read_refused'));
    for (const word of ['alice', 'bob', 'concepts', 'tea']) expect(line).not.toContain(word);
  });

  it('a session reads its own pages by its session id, and a user of the same id does not', async () => {
    const own = await call({ id: 'concepts/notes' }, ctx('s1', SESSION));
    expect(own.output).toMatchObject({ body: 'The session likes coffee.\n' });

    const user = await call({ id: 'concepts/notes' }, ctx('s1', { kind: 'user', id: 's1' }));
    expect(user).toEqual(notFound('concepts/notes'));
    expect(refusals()).toEqual(['other_user']);
  });

  it('a context with a user id and no subject is read as that user', async () => {
    const own = await call({ id: 'concepts/notes' }, ctx('alice'));
    expect(own.output).toMatchObject({ body: 'Alice likes tea.\n' });
    expect(refusals()).toEqual([]);

    // So a user is never served a page an earlier version compiled, which may hold what someone else said.
    const earlier = await call({ id: 'concepts/old' }, ctx('bob'));
    expect(earlier).toEqual(notFound('concepts/old'));
    expect(refusals()).toEqual(['legacy']);
  });

  it("with no user it reads operator pages and earlier compiled pages, and no user's page", async () => {
    for (const context of [ctx(), ctx('guest'), ctx('anonymous'), ctx(''), {}, undefined]) {
      events.length = 0;
      expect((await call({ id: 'concepts/ops' }, context)).output).toMatchObject({ body: 'Open nine to five.\n' });
      expect((await call({ id: 'concepts/old' }, context)).output).toMatchObject({ body: 'Zanzibar.\n' });
      expect(refusals()).toEqual([]);
      expect(await call({ id: 'concepts/notes' }, context)).toEqual(notFound('concepts/notes'));
      expect(refusals()).toEqual(['no_user']);
      expect(await call({ id: 'concepts/nope' }, context)).toEqual(notFound('concepts/nope'));
      expect(refusals()).toEqual(['no_user']);
    }
  });

  it('a subject the runtime names is the asker even when the user id is an anonymous word', async () => {
    // A session named with one of the anonymous words, whose user id is its session id, and a session opened with an
    // anonymous user id whose runtime kept that id beside the session subject: each is a subject, never nobody.
    const askers: Array<[string, Subject]> = [
      ['guest', { kind: 'session', id: 'guest' }],
      ['system', { kind: 'session', id: 'system' }],
      ['anonymous', { kind: 'session', id: 'v1' }],
    ];
    for (const [userId, subject] of askers) {
      await new UserWikiStore({ scopeId: keyOf(subject), pages: memory, chunk }).writePage(
        P(`Visitor ${subject.id} likes juice.`, ['t3']),
      );
      events.length = 0;
      const own = await call({ id: 'concepts/notes' }, ctx(userId, subject));
      expect(own.output).toMatchObject({ body: `Visitor ${subject.id} likes juice.\n` });
      expect(refusals()).toEqual([]);

      // A page an earlier version compiled may hold what someone else said: a subject is never served it.
      expect(await call({ id: 'concepts/old' }, ctx(userId, subject))).toEqual(notFound('concepts/old'));
      expect(refusals()).toEqual(['legacy']);

      expect((await call({ list: true }, ctx(userId, subject))).output?.pages).toEqual([
        { id: 'concepts/notes', summary: 'Notes compiled from conversations', owner: 'own' },
        { id: 'concepts/ops', summary: 'Opening hours', owner: 'operator' },
      ]);
    }
  });

  it('never serves a subject whose id holds a lone surrogate the pages of the id the store would write', async () => {
    // The store writes text as UTF-8, where a lone surrogate becomes U+FFFD: 'm\uD800' would be read as 'm�'.
    await new UserWikiStore({ scopeId: keyOf({ kind: 'user', id: 'm�' }), pages: memory, chunk }).writePage(
      P('Mallory keeps a ledger.', ['t9']),
    );
    const lone: Subject = { kind: 'user', id: 'm\uD800' };
    const answered = async (args: Record<string, unknown>, context: unknown): Promise<string> =>
      JSON.stringify(await call(args, context).catch((err: unknown) => ({ thrown: String(err) })));

    expect(await answered({ id: 'concepts/notes' }, ctx('m\uD800', lone))).not.toContain('Mallory');
    expect(await answered({ id: 'concepts/notes' }, ctx('m\uD800'))).not.toContain('Mallory');
    expect(await answered({ list: true }, ctx('m\uD800', lone))).not.toContain('"owner":"own"');
  });

  it('refuses a call that carries a scope or user argument, and reads nothing', async () => {
    const calls: Array<Record<string, unknown>> = [
      { id: 'concepts/notes', scopeId: keyOf(ALICE) },
      { id: 'concepts/notes', userId: 'alice' },
      { id: 'concepts/notes', turnUserId: 'alice' },
      { id: 'concepts/notes', scope: 'conversation' },
      { list: true, subject: ALICE },
    ];
    for (const args of calls) {
      events.length = 0;
      const answer = await call(args, ctx('bob', BOB));
      expect(answer.success).toBe(false);
      expect(answer.details?.code).toBe('INVALID_ARGS');
      expect(answer.output).toBeUndefined();
      expect(JSON.stringify(answer)).not.toContain('Alice likes tea');
      expect(refusals()).toEqual(['caller_filter']);
    }
    // The same arguments from alice herself are refused too: the keys are the runtime's, whoever asks.
    events.length = 0;
    const own = await call({ id: 'concepts/notes', userId: 'alice' }, ctx('alice', ALICE));
    expect(own.details?.code).toBe('INVALID_ARGS');
    expect(refusals()).toEqual(['caller_filter']);
  });

  it("lists the asker's pages and the operator's, and nobody else's", async () => {
    const ops = { id: 'concepts/ops', summary: 'Opening hours', owner: 'operator' };
    const alice = await call({ list: true }, ctx('alice', ALICE));
    expect(alice.success).toBe(true);
    expect(alice.output?.pages).toEqual([
      { id: 'concepts/notes', summary: 'Notes compiled from conversations', owner: 'own' },
      ops,
    ]);

    expect((await call({ list: true }, ctx('bob', BOB))).output?.pages).toEqual([ops]);

    // With no user: the operator's pages, the pages an earlier version compiled among them.
    expect((await call({ list: true }, ctx())).output?.pages).toEqual([
      { id: 'concepts/old', summary: 'Earlier notes', owner: 'operator' },
      ops,
    ]);
    expect(refusals()).toEqual([]);
  });

  it('a call with neither an id nor list is invalid', async () => {
    for (const args of [{}, { list: false }, { list: 'yes' }, { other: 1 }]) {
      const answer = await call(args, ctx('alice', ALICE));
      expect(answer.success).toBe(false);
      expect(answer.details?.code).toBe('INVALID_ARGS');
    }
    expect(refusals()).toEqual([]);
    // Any other unknown property is ignored.
    expect((await call({ id: 'concepts/notes', verbose: true }, ctx('alice', ALICE))).output).toMatchObject({
      body: 'Alice likes tea.\n',
    });
  });

  it('attaches no wiki for an agent with no id', async () => {
    await expect(
      attachMemoryWiki({ memory, memoryDir, agentId: '', llm: async () => 'x', chunk }),
    ).rejects.toThrow(TypeError);
  });
});
