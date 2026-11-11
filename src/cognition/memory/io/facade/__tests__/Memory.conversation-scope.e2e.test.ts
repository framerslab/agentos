/**
 * @file Memory.conversation-scope.e2e.test.ts
 * The conversation scope on a real store: SQLite on a file, and Postgres when `AGENTOS_TEST_POSTGRES_URL` is set (as
 * CI's Test & Lint job sets it). A scope is registered in `memory_scopes` with its first trace and once only, a trace
 * whose scope id is not a key `conversationScopeKey` built is refused before anything is stored, `recall` and
 * `recentTraces` read one scope by equality on the `scope_id` column (never by the metadata), `deleteScope` takes the
 * scope's registry row with its traces, a scope another writer filed without a row is registered at the next open,
 * and no other scope gets a registry row.
 *
 * Per-user wiki pages on the same stores: a subject's page is one row of `memory_pages` with its chunks filed under the
 * subject's key, two subjects' pages of one id stay apart, a rewritten page's old chunks are deleted for good, an
 * unchanged body keeps its chunks, ids are kept as given (case, Unicode form, dots, length), a refused page id or a
 * key that names no user or session is refused, a page outlives a close, and a page write that fails changes nothing.
 *
 * The wiki compile on the same stores: one compile a scope with new traces, into that scope's own rows, with a
 * watermark a scope in its registry row; a scope whose only new traces are its own page chunks runs no call; the
 * operator's scope is never compiled; `compileWiki({ scopes })` compiles the named scopes alone; a scope a spend
 * budget refuses, or a hook skips, keeps its watermark while the others compile; any other failure rejects the call
 * once every scope has run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../Memory.js';
import type { Brain } from '../../../retrieval/store/Brain.js';
import { PORTABLE_TABLES } from '../../../retrieval/store/portable-tables.js';
import { conversationScopeKey } from '../../../retrieval/store/conversationScopeKey.js';
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import pino from 'pino';
import { InvalidWikiPageIdError, UserWikiStore, WikiCompiler } from '../../../../substrate/memory/wiki/index.js';
import type { CompileResult, WikiPage } from '../../../../substrate/memory/wiki/index.js';
import type { MemoryTrace } from '../../../core/types.js';
import { resetLoggerFactory, setLogger } from '../../../../../core/logging/loggerFactory.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;

type Store = 'sqlite' | 'postgres';
const STORES: Store[] = POSTGRES_URL ? ['sqlite', 'postgres'] : ['sqlite'];

const brainOf = (memory: Memory): Brain => (memory as unknown as { _brain: Brain })._brain;

const dirs: string[] = [];
const memories: Memory[] = [];

afterEach(async () => {
  while (memories.length) {
    const memory = memories.pop()!;
    const brain = brainOf(memory);
    if (brain.features.dialect.name === 'postgres') {
      // The Postgres database outlives the test: remove this brain's rows, children before parents.
      for (const table of ['memory_pages', 'memory_scopes', ...[...PORTABLE_TABLES].reverse()]) {
        await brain.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brain.brainId]).catch(() => undefined);
      }
    }
    await memory.close();
  }
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A facade on a fresh store; `file` reopens a SQLite file an earlier facade of the test wrote. */
async function open(store: Store, file?: string): Promise<{ memory: Memory; brain: Brain; file: string }> {
  if (store === 'postgres') {
    const memory = await Memory.createPostgres(POSTGRES_URL!, {
      brainId: `conv-scope-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      poolSize: 2,
      graph: false,
      selfImprove: false,
    });
    memories.push(memory);
    return { memory, brain: brainOf(memory), file: '' };
  }
  let target = file;
  if (target === undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-scope-'));
    dirs.push(dir);
    target = path.join(dir, 'brain.sqlite');
  }
  const memory = await Memory.createSqlite(target, { graph: false, selfImprove: false, decay: false });
  memories.push(memory);
  return { memory, brain: brainOf(memory), file: target };
}

/** Closes a facade in the middle of a test, so `afterEach` does not close it again. */
async function closeNow(memory: Memory): Promise<void> {
  memories.splice(memories.indexOf(memory), 1);
  await memory.close();
}

const count = async (brain: Brain, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await brain.get<{ n: number | string }>(sql, [brain.brainId, ...params]))?.n ?? 0);

interface ScopeRow {
  scope_id: string;
  kind: string;
  agent_id: string;
  compiled_at: number | string | null;
}
const scopeRows = async (brain: Brain): Promise<ScopeRow[]> =>
  (
    await brain.all<ScopeRow>('SELECT scope_id, kind, agent_id, compiled_at FROM memory_scopes WHERE brain_id = ?', [
      brain.brainId,
    ])
  ).sort((a, b) => (a.scope_id < b.scope_id ? -1 : 1));

const A = conversationScopeKey('aria-1', { kind: 'user', id: 'alice' });
const B = conversationScopeKey('aria-1', { kind: 'user', id: 'bob' });
const contentsOf = (traces: Array<{ content: string }>): string[] => traces.map((trace) => trace.content).sort();

describe.each(STORES)('conversation scopes on %s', (store) => {
  it('registers a scope with its first trace and once only', async () => {
    const { memory, brain } = await open(store);
    await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    await memory.remember('Alice has a cat.', { scope: 'conversation', scopeId: A });
    await memory.remember('Bob plays cello.', { scope: 'conversation', scopeId: B });

    expect(await scopeRows(brain)).toEqual(
      [
        { scope_id: A, kind: 'user', agent_id: 'aria-1', compiled_at: null },
        { scope_id: B, kind: 'user', agent_id: 'aria-1', compiled_at: null },
      ].sort((a, b) => (a.scope_id < b.scope_id ? -1 : 1)),
    );

    const listed = await memory.listScopes();
    expect(listed.map((row) => row.scopeId).sort()).toEqual([A, B].sort());
    for (const row of listed) {
      expect(row.kind).toBe('user');
      expect(row.agentId).toBe('aria-1');
      expect(typeof row.createdAt).toBe('number');
      expect(row.createdAt).toBeGreaterThan(0);
      expect(row.compiledAt).toBeNull();
    }
    expect(await memory.listScopes({ kind: 'session' })).toEqual([]);
  });

  it('refuses a conversation trace whose scope id is not a key, and stores nothing', async () => {
    const { memory, brain } = await open(store);

    await expect(memory.remember('x', { scope: 'conversation', scopeId: 'aria-1' })).rejects.toThrow(TypeError);
    await expect(memory.remember('y', { scope: 'conversation' })).rejects.toThrow(TypeError);

    expect(await count(brain, 'SELECT count(*) AS n FROM memory_traces WHERE brain_id = ?')).toBe(0);
    expect(await scopeRows(brain)).toEqual([]);
  });

  it('registers the same text filed twice under one key', async () => {
    const { memory, brain } = await open(store);
    const first = await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    const second = await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    expect(second.id).toBe(first.id);
    await brain.run('DELETE FROM memory_scopes WHERE brain_id = ? AND scope_id = ?', [brain.brainId, A]);
    expect(await scopeRows(brain)).toEqual([]);

    const third = await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });

    expect(third.id).toBe(first.id);
    expect((await scopeRows(brain)).map((row) => row.scope_id)).toEqual([A]);
    expect(await count(brain, 'SELECT count(*) AS n FROM memory_traces WHERE brain_id = ?')).toBe(1);
  });

  it('recalls and lists one scope by its key alone', async () => {
    const { memory } = await open(store);
    await memory.remember('Zorblat is my cat', { scope: 'conversation', scopeId: A });
    await memory.remember('Zorblat is my dog', { scope: 'conversation', scopeId: B });

    const recalled = await memory.recall('Zorblat', { scope: 'conversation', scopeId: A });
    expect(recalled.map((result) => result.trace.content)).toEqual(['Zorblat is my cat']);

    const listed = await memory.recentTraces(0, { scope: 'conversation', scopeId: B });
    expect(contentsOf(listed)).toEqual(['Zorblat is my dog']);

    // One character away from alice's key: equality, never a prefix or a pattern.
    const near = conversationScopeKey('aria-1', { kind: 'user', id: 'alicf' });
    expect(await memory.recall('Zorblat', { scope: 'conversation', scopeId: near })).toEqual([]);
    expect(await memory.recentTraces(0, { scope: 'conversation', scopeId: near })).toEqual([]);
    expect(await memory.recall('Zorblat', { scope: 'conversation', scopeId: A.slice(0, -1) })).toEqual([]);
    expect(await memory.recentTraces(0, { scope: 'conversation', scopeId: A.slice(0, -1) })).toEqual([]);
  });

  it('recalls by the column, not by the metadata', async () => {
    const { memory, brain } = await open(store);
    await memory.remember('Zorblat is my cat', { scope: 'conversation', scopeId: A });
    await memory.remember('Zorblat is my dog', { scope: 'conversation', scopeId: B });
    await brain.run(`UPDATE memory_traces SET metadata = '{}' WHERE brain_id = ?`, [brain.brainId]);

    const recalled = await memory.recall('Zorblat', { scope: 'conversation', scopeId: A });

    expect(recalled.map((result) => result.trace.content)).toEqual(['Zorblat is my cat']);
  });

  it("deleteScope takes the scope's registry row and leaves the other scope whole", async () => {
    const { memory, brain } = await open(store);
    await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    await memory.remember('Alice has a cat.', { scope: 'conversation', scopeId: A });
    await memory.remember('Bob plays cello.', { scope: 'conversation', scopeId: B });

    expect(await memory.deleteScope('conversation', A)).toEqual({ deleted: 2 });

    expect(await count(brain, 'SELECT count(*) AS n FROM memory_traces WHERE brain_id = ? AND scope_id = ?', [A])).toBe(0);
    expect((await scopeRows(brain)).map((row) => row.scope_id)).toEqual([B]);
    expect(await count(brain, 'SELECT count(*) AS n FROM memory_traces WHERE brain_id = ? AND scope_id = ?', [B])).toBe(1);
    expect(contentsOf(await memory.recentTraces(0, { scope: 'conversation', scopeId: B }))).toEqual([
      'Bob plays cello.',
    ]);
  });

  it('leaves every other scope without a registry row', async () => {
    const { memory, brain } = await open(store);

    await memory.remember('x', { scope: 'user', scopeId: 'ana' });
    await memory.remember('y', { scope: 'persona', scopeId: 'aria-1' });

    expect(await scopeRows(brain)).toEqual([]);
  });

  // The test reopens the store's file, which the Postgres leg does not have.
  if (store === 'sqlite') {
    it('registers a scope an import or another writer filed without a row, at the next open', async () => {
      const first = await open(store);
      const carol = conversationScopeKey('aria-1', { kind: 'user', id: 'carol' });
      const insert = `INSERT INTO memory_traces
           (brain_id, id, type, scope, content, strength, created_at, tags, emotions, metadata, deleted, scope_id)
         VALUES (?, ?, 'episodic', 'conversation', ?, 1.0, ?, '[]', '{}', ?, 0, ?)`;
      await first.brain.run(insert, [
        first.brain.brainId,
        'hand-1',
        'Carol rides horses.',
        1_700_000_000_000,
        JSON.stringify({ scopeId: carol }),
        carol,
      ]);
      await first.brain.run(insert, [
        first.brain.brainId,
        'hand-2',
        'Filed under no key.',
        1_700_000_000_001,
        JSON.stringify({ scopeId: 'not-a-key' }),
        'not-a-key',
      ]);
      await closeNow(first.memory);

      const second = await open(store, first.file);

      expect(await scopeRows(second.brain)).toEqual([
        { scope_id: carol, kind: 'user', agent_id: 'aria-1', compiled_at: null },
      ]);
      const listed = await second.memory.listScopes();
      expect(listed).toEqual([
        { scopeId: carol, kind: 'user', agentId: 'aria-1', createdAt: 1_700_000_000_000, compiledAt: null },
      ]);
    });
  }
});

const chunk = (text: string): Array<{ text: string }> => text.split('\n\n').map((part) => ({ text: part }));
const P = (body: string, sources: string[] = []): WikiPage => ({
  id: 'concepts/notes',
  type: 'concept',
  summary: 'Notes compiled from conversations',
  updated: '2026-01-01T00:00:00.000Z',
  sources,
  body,
  links: [],
});

interface PageRow {
  scope_id: string;
  page_id: string;
  content: string;
  chunk_ids: string;
}
const pageRows = async (brain: Brain): Promise<PageRow[]> =>
  brain.all<PageRow>('SELECT scope_id, page_id, content, chunk_ids FROM memory_pages WHERE brain_id = ?', [brain.brainId]);
const traceIdsUnder = async (brain: Brain, scopeId: string): Promise<string[]> =>
  (
    await brain.all<{ id: string }>(
      `SELECT id FROM memory_traces WHERE brain_id = ? AND scope = 'conversation' AND scope_id = ?`,
      [brain.brainId, scopeId],
    )
  )
    .map((row) => row.id)
    .sort();
const chunkIdsOf = (row: PageRow): string[] => (JSON.parse(row.chunk_ids) as string[]).slice().sort();
const bodyOf = (page: WikiPage | null): string | undefined => page?.body.trim();

describe.each(STORES)('per-user pages on %s', (store) => {
  it("writes a subject's page as one row with its chunks under the subject's key", async () => {
    const { memory, brain } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });

    await pages.writePage(P('Alice likes tea.\n\nAlice has a cat.', ['t1']));

    const rows = await pageRows(brain);
    expect(rows.map((row) => [row.scope_id, row.page_id])).toEqual([[A, 'concepts/notes']]);
    const chunks = await brain.all<{ id: string; tags: string; content: string }>(
      `SELECT id, tags, content FROM memory_traces WHERE brain_id = ? AND scope = 'conversation' AND scope_id = ?`,
      [brain.brainId, A],
    );
    expect(chunks.map((row) => row.content).sort()).toEqual(['Alice has a cat.', 'Alice likes tea.']);
    expect(chunkIdsOf(rows[0]!)).toEqual(chunks.map((row) => row.id).sort());
    for (const row of chunks) expect(JSON.parse(row.tags)).toEqual(['wiki', 'page:concepts/notes']);

    const read = await pages.readPage('concepts/notes');
    expect(bodyOf(read)).toBe('Alice likes tea.\n\nAlice has a cat.');
    expect(read?.sources).toEqual(['t1']);
    expect(read?.summary).toBe('Notes compiled from conversations');
    expect((await pages.listPages()).map((page) => page.id)).toEqual(['concepts/notes']);
    expect((await scopeRows(brain)).map((row) => row.scope_id)).toEqual([A]);
    expect(await pages.index()).toEqual({ indexed: [], skipped: ['concepts/notes'], removed: [] });
  });

  it("keeps two subjects' pages of one id apart", async () => {
    const { memory, brain } = await open(store);
    const alice = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    const bob = new UserWikiStore({ scopeId: B, pages: memory, chunk });
    const carol = new UserWikiStore({
      scopeId: conversationScopeKey('aria-1', { kind: 'user', id: 'carol' }),
      pages: memory,
      chunk,
    });
    await alice.writePage(P('Alice likes tea.\n\nAlice has a cat.'));
    await bob.writePage(P('Bob plays cello.\n\nBob has a dog.'));

    expect(bodyOf(await alice.readPage('concepts/notes'))).toBe('Alice likes tea.\n\nAlice has a cat.');
    expect(bodyOf(await bob.readPage('concepts/notes'))).toBe('Bob plays cello.\n\nBob has a dog.');
    expect(await carol.readPage('concepts/notes')).toBeNull();
    expect(await carol.listPages()).toEqual([]);

    expect(await alice.deleteAll()).toEqual({ pages: 1, chunks: 2 });

    expect(await alice.readPage('concepts/notes')).toBeNull();
    expect(await traceIdsUnder(brain, A)).toEqual([]);
    expect((await pageRows(brain)).map((row) => row.scope_id)).toEqual([B]);
    expect((await traceIdsUnder(brain, B)).length).toBe(2);
    expect(bodyOf(await bob.readPage('concepts/notes'))).toBe('Bob plays cello.\n\nBob has a dog.');
    expect(await bob.deletePage('concepts/nope')).toBe(false);
    expect(await bob.deletePage('concepts/notes')).toBe(true);
    expect(await pageRows(brain)).toEqual([]);
    expect(await traceIdsUnder(brain, B)).toEqual([]);
  });

  it('rewriting a page deletes its old chunks for good', async () => {
    const { memory, brain } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    await pages.writePage(P('Alice likes oolong.\n\nAlice has a parrot.'));
    const old = await traceIdsUnder(brain, A);
    expect(old.length).toBe(2);

    await pages.writePage(P('Alice drinks espresso.\n\nAlice keeps a ferret.'));

    expect(await count(brain, 'SELECT count(*) AS n FROM memory_traces WHERE brain_id = ? AND deleted = 1')).toBe(0);
    const now = await traceIdsUnder(brain, A);
    expect(now.length).toBe(2);
    for (const id of old) expect(now).not.toContain(id);
    expect(chunkIdsOf((await pageRows(brain))[0]!)).toEqual(now);
    expect(await memory.recall('oolong', { scope: 'conversation', scopeId: A })).toEqual([]);
    expect(
      (await memory.recall('espresso', { scope: 'conversation', scopeId: A })).map((result) => result.trace.content),
    ).toEqual(['Alice drinks espresso.']);
  });

  it('leaves the chunks of a page whose body did not change', async () => {
    const { memory, brain } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    await pages.writePage(P('Alice likes tea.\n\nAlice has a cat.', ['t1']));
    const first = chunkIdsOf((await pageRows(brain))[0]!);

    await pages.writePage(P('Alice likes tea.\n\nAlice has a cat.', ['t1', 't2']));

    const row = (await pageRows(brain))[0]!;
    expect(chunkIdsOf(row)).toEqual(first);
    expect(await traceIdsUnder(brain, A)).toEqual(first);
    expect(row.content).toContain('t2');
    expect((await pages.readPage('concepts/notes'))?.sources).toEqual(['t1', 't2']);

    // A forced index writes the chunks again from the body, and the old ones go for good.
    const forced = await pages.index({ force: true });
    expect(forced.indexed).toEqual(['concepts/notes']);
    expect(forced.removed.slice().sort()).toEqual(first);
    const after = await traceIdsUnder(brain, A);
    expect(after.length).toBe(2);
    for (const id of first) expect(after).not.toContain(id);
  });

  it('keeps ids as given', async () => {
    const { memory, brain } = await open(store);
    // Two cases of one name, the two Unicode forms of one letter, a dotted id and a long one.
    const ids = ['Alice', 'alice', '\u00e9', 'e\u0301', '..', 'x'.repeat(300)];
    const stores = ids.map(
      (id) => new UserWikiStore({ scopeId: conversationScopeKey('aria-1', { kind: 'user', id }), pages: memory, chunk }),
    );
    for (const [n, pages] of stores.entries()) await pages.writePage(P(`Body number ${n}.`));

    for (const [n, pages] of stores.entries()) {
      expect(bodyOf(await pages.readPage('concepts/notes'))).toBe(`Body number ${n}.`);
      expect((await pages.listPages()).length).toBe(1);
    }
    expect(new Set((await pageRows(brain)).map((row) => row.scope_id)).size).toBe(ids.length);
  });

  it("refuses a refused page id and a key that is no subject's", async () => {
    const { memory, brain } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });

    await expect(pages.writePage({ ...P('x'), id: '../x' })).rejects.toThrow(InvalidWikiPageIdError);
    await expect(pages.readPage('../x')).rejects.toThrow(InvalidWikiPageIdError);
    expect(await pageRows(brain)).toEqual([]);
    expect(await traceIdsUnder(brain, A)).toEqual([]);

    const operator = conversationScopeKey('aria-1', { kind: 'operator' });
    expect(() => new UserWikiStore({ scopeId: operator, pages: memory, chunk })).toThrow(TypeError);
    expect(() => new UserWikiStore({ scopeId: 'aria-1', pages: memory, chunk })).toThrow(TypeError);
  });

  it('gives an id with a lone surrogate no key, so it never reaches the pages of the id the store would write', async () => {
    const { memory, brain } = await open(store);
    // The store writes text as UTF-8, where a lone surrogate becomes U+FFFD: a key holding 'm\uD800' is stored, and
    // matched, as the key holding 'm�'.
    const stored = conversationScopeKey('aria-1', { kind: 'user', id: 'm�' });
    await new UserWikiStore({ scopeId: stored, pages: memory, chunk }).writePage(P('Mallory keeps a ledger.'));
    const lone = 'c1:u:6:aria-1:2:m\uD800;';

    let read: string | undefined = 'refused';
    try {
      read = bodyOf(await new UserWikiStore({ scopeId: lone, pages: memory, chunk }).readPage('concepts/notes'));
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
    }
    expect(read).toBe('refused');
    expect(() => conversationScopeKey('aria-1', { kind: 'user', id: 'm\uD800' })).toThrow(TypeError);
    await expect(
      memory.remember('A note filed under the lone key.', { scope: 'conversation', scopeId: lone }),
    ).rejects.toThrow(TypeError);
    expect((await scopeRows(brain)).map((row) => row.scope_id)).toEqual([stored]);
    expect((await traceIdsUnder(brain, stored)).length).toBe(1);
    expect((await pageRows(brain)).map((row) => row.scope_id)).toEqual([stored]);
  });

  // These two reopen or wrap the store's own SQLite file, which the Postgres leg does not have.
  if (store === 'sqlite') {
    it('a page is there after the store closes and reopens', async () => {
      const first = await open(store);
      await new UserWikiStore({ scopeId: A, pages: first.memory, chunk }).writePage(
        P('Alice likes tea.\n\nAlice has a cat.', ['t1']),
      );
      await closeNow(first.memory);

      const second = await open(store, first.file);
      const pages = new UserWikiStore({ scopeId: A, pages: second.memory, chunk });

      expect(bodyOf(await pages.readPage('concepts/notes'))).toBe('Alice likes tea.\n\nAlice has a cat.');
      expect(
        (await second.memory.recall('cat', { scope: 'conversation', scopeId: A })).map((result) => result.trace.content),
      ).toEqual(['Alice has a cat.']);
    });

    it('a page write that fails changes nothing', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-scope-'));
      dirs.push(dir);
      const adapter = await resolveStorageAdapter({
        filePath: path.join(dir, 'brain.sqlite'),
        priority: ['better-sqlite3', 'sqljs'],
        quiet: true,
      });
      // Once armed, the page row's insert is refused inside the write's transaction.
      let armed = false;
      const through = <T extends object>(target: T, overrides: Partial<Record<keyof T, unknown>>): T =>
        new Proxy(target, {
          get(inner, prop) {
            if (prop in overrides) return overrides[prop as keyof T];
            const value = Reflect.get(inner, prop, inner);
            return typeof value === 'function' ? value.bind(inner) : value;
          },
        });
      const wrapped = through(adapter, {
        transaction: <T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> =>
          adapter.transaction((trx) =>
            fn(
              through(trx, {
                run: (sql: string, params?: unknown[]) => {
                  if (armed && sql.trimStart().startsWith('INSERT INTO memory_pages')) {
                    return Promise.reject(new Error('the page row could not be written'));
                  }
                  return trx.run(sql, params);
                },
              }),
            ),
          ),
      });
      const memory = await Memory.createWithAdapter(wrapped, { graph: false, selfImprove: false });
      memories.push(memory);
      const brain = brainOf(memory);
      const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
      await pages.writePage(P('Alice likes tea.\n\nAlice has a cat.'));
      const first = chunkIdsOf((await pageRows(brain))[0]!);
      expect(first.length).toBe(2);

      armed = true;
      await expect(pages.writePage(P('Alice drinks espresso.\n\nAlice keeps a ferret.'))).rejects.toThrow(
        'the page row could not be written',
      );
      armed = false;

      const row = (await pageRows(brain))[0]!;
      expect(row.content).toContain('Alice likes tea.');
      expect(row.content).not.toContain('espresso');
      expect(chunkIdsOf(row)).toEqual(first);
      expect(await traceIdsUnder(brain, A)).toEqual(first);
      expect(bodyOf(await pages.readPage('concepts/notes'))).toBe('Alice likes tea.\n\nAlice has a cat.');
    });
  }
});

const C = conversationScopeKey('aria-1', { kind: 'user', id: 'carol' });
const OPERATOR = conversationScopeKey('aria-1', { kind: 'operator' });
const NOTHING_COMPILED: CompileResult = { pagesWritten: [], tracesConsumed: 0, conflicts: [] };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The hooks a wiki may be attached with. */
interface CompileHooks {
  beforeScopeCompile?: (
    scopeId: string,
    traces: MemoryTrace[],
  ) => Promise<{ traces: MemoryTrace[] } | { skip: 'policy_raw' | 'screen_failed' }>;
  compileSkipReasonOf?: (error: unknown) => 'budget' | undefined;
}

/** The compile members of the facade, as a wiki kept per scope is attached and compiled. */
interface Compiling {
  attachWiki(
    wiki: CompileHooks & {
      storeFor(scopeId: string): UserWikiStore;
      compiler: WikiCompiler;
    },
  ): void;
  compileWiki(opts?: {
    reason?: 'consolidation' | 'session-end' | 'explicit';
    scopes?: readonly string[];
  }): Promise<CompileResult>;
}
const compiling = (memory: Memory): Compiling => memory as unknown as Compiling;

/**
 * Attaches a wiki whose pages are rows of `memory`, one page (`concepts/notes`) a scope, and returns every merge
 * prompt its compiles send, in order. `llm` answers a prompt; a prompt is recorded before it is answered.
 */
function attachRows(
  memory: Memory,
  extra: CompileHooks & { llm?: (prompt: string) => Promise<string> } = {},
): string[] {
  const prompts: string[] = [];
  const { llm, ...hooks } = extra;
  const compiler = new WikiCompiler({
    llm: async (prompt: string) => {
      prompts.push(prompt);
      return llm ? llm(prompt) : 'Merged notes.';
    },
    cluster: async (traces: Array<{ id: string }>) => [{ pageId: 'concepts/notes', traceIds: traces.map((t) => t.id) }],
  } as never);
  compiling(memory).attachWiki({
    storeFor: (scopeId) => new UserWikiStore({ scopeId, pages: memory, chunk }),
    compiler,
    ...hooks,
  });
  return prompts;
}

/** Each registered scope's compile watermark, by scope id. */
const watermarks = async (memory: Memory): Promise<Map<string, number | null>> =>
  new Map((await memory.listScopes()).map((row) => [row.scopeId, row.compiledAt]));

/** When the newest trace of a scope was stored, its page chunks among them. */
const newestTraceAt = async (brain: Brain, scopeId: string): Promise<number> =>
  Number(
    (
      await brain.get<{ at: number | string }>(
        `SELECT max(created_at) AS at FROM memory_traces WHERE brain_id = ? AND scope = 'conversation' AND scope_id = ?`,
        [brain.brainId, scopeId],
      )
    )?.at,
  );

/** An error a spend budget's refusal throws, by its name. */
const refusedByBudget = () => Object.assign(new Error('the budget allows no further call'), { name: 'CostCapExceededError' });
const budgetReasonOf = (error: unknown): 'budget' | undefined =>
  (error as { name?: unknown } | null)?.name === 'CostCapExceededError' ? 'budget' : undefined;

describe.each(STORES)('the compile per scope on %s', (store) => {
  /** Every line the library logged in the test, parsed. */
  let events: Array<Record<string, unknown>>;
  const lines = (event: string) => events.filter((line) => line.event === event);
  beforeEach(() => {
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
  afterEach(() => resetLoggerFactory());

  it('compiles each scope with new traces into its own rows, one call a scope', async () => {
    const { memory, brain } = await open(store);
    const prompts = attachRows(memory);
    const a1 = await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    const a2 = await memory.remember('Alice has a cat.', { scope: 'conversation', scopeId: A });
    const b1 = await memory.remember('Bob plays cello.', { scope: 'conversation', scopeId: B });

    const result = await compiling(memory).compileWiki();

    expect(result.pagesWritten).toEqual(['concepts/notes', 'concepts/notes']);
    expect(result.tracesConsumed).toBe(3);
    expect(prompts).toHaveLength(2);
    const ofAlice = prompts.find((prompt) => prompt.includes('Alice likes tea.'));
    expect(ofAlice).toContain('Alice has a cat.');
    expect(ofAlice).not.toContain('Bob plays cello.');
    const ofBob = prompts.find((prompt) => prompt.includes('Bob plays cello.'));
    expect(ofBob).toBeDefined();
    expect(ofBob).not.toContain('Alice');

    expect((await pageRows(brain)).map((row) => [row.scope_id, row.page_id]).sort()).toEqual(
      [
        [A, 'concepts/notes'],
        [B, 'concepts/notes'],
      ].sort(),
    );
    const compiledAt = await watermarks(memory);
    expect(compiledAt.get(A)).toBe(Math.max(a1.createdAt, a2.createdAt));
    expect(compiledAt.get(B)).toBe(b1.createdAt);
  });

  it('compiles nothing a second time, and only the scope with a new trace the third', async () => {
    const { memory } = await open(store);
    const prompts = attachRows(memory);
    await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    await memory.remember('Bob plays cello.', { scope: 'conversation', scopeId: B });
    await compiling(memory).compileWiki();
    expect(prompts).toHaveLength(2);

    expect(await compiling(memory).compileWiki()).toEqual(NOTHING_COMPILED);
    expect(prompts).toHaveLength(2);

    await pause(5);
    await memory.remember('Bob has a dog.', { scope: 'conversation', scopeId: B });
    const third = await compiling(memory).compileWiki();

    expect(third.pagesWritten).toEqual(['concepts/notes']);
    expect(third.tracesConsumed).toBe(1);
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('Bob has a dog.');
    expect(prompts[2]).not.toContain('Alice');
    // The merge starts from the page the scope already has.
    expect(prompts[2]).toContain('Merged notes.');
  });

  it('a scope whose only new traces are its own page chunks runs no call and moves its watermark', async () => {
    const { memory, brain } = await open(store);
    const prompts = attachRows(memory);
    const fact = await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    await pause(5);
    await compiling(memory).compileWiki();
    expect(prompts).toHaveLength(1);
    expect((await watermarks(memory)).get(A)).toBe(fact.createdAt);
    // The page's chunks were stored after the trace the compile read.
    const newest = await newestTraceAt(brain, A);
    expect(newest).toBeGreaterThan(fact.createdAt);

    expect(await compiling(memory).compileWiki()).toEqual(NOTHING_COMPILED);

    expect(prompts).toHaveLength(1);
    expect((await watermarks(memory)).get(A)).toBe(newest);
  });

  it('never compiles the operator scope', async () => {
    const { memory, brain } = await open(store);
    const prompts = attachRows(memory);
    await memory.remember('Open nine to five.', { scope: 'conversation', scopeId: OPERATOR });

    expect(await compiling(memory).compileWiki()).toEqual(NOTHING_COMPILED);
    expect(await compiling(memory).compileWiki({ scopes: [OPERATOR] })).toEqual(NOTHING_COMPILED);

    expect(prompts).toEqual([]);
    expect(await pageRows(brain)).toEqual([]);
    expect((await watermarks(memory)).get(OPERATOR)).toBeNull();
  });

  it('compileWiki({ scopes }) compiles the named scopes alone, and none for an empty list', async () => {
    const { memory, brain } = await open(store);
    const prompts = attachRows(memory);
    await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    await memory.remember('Bob plays cello.', { scope: 'conversation', scopeId: B });

    expect(await compiling(memory).compileWiki({ scopes: [] })).toEqual(NOTHING_COMPILED);
    expect(prompts).toEqual([]);

    // A scope with no registry row is left out, and a scope named twice is compiled once.
    const result = await compiling(memory).compileWiki({ scopes: [B, C, B] });

    expect(result.pagesWritten).toEqual(['concepts/notes']);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Bob plays cello.');
    expect(prompts[0]).not.toContain('Alice');
    expect((await pageRows(brain)).map((row) => row.scope_id)).toEqual([B]);
    const compiledAt = await watermarks(memory);
    expect(compiledAt.get(A)).toBeNull();
    expect(compiledAt.get(B)).not.toBeNull();
    expect(compiledAt.has(C)).toBe(false);
  });

  it('a refused scope keeps its watermark and the others compile', async () => {
    const { memory, brain } = await open(store);
    const prompts = attachRows(memory, {
      llm: async (prompt) => {
        if (prompt.includes('Alice likes tea.')) throw refusedByBudget();
        return 'Merged notes.';
      },
      compileSkipReasonOf: budgetReasonOf,
    });
    await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    await memory.remember('Bob plays cello.', { scope: 'conversation', scopeId: B });
    await memory.remember('Carol keeps bees.', { scope: 'conversation', scopeId: C });

    const result = await compiling(memory).compileWiki();

    expect(result.pagesWritten).toEqual(['concepts/notes', 'concepts/notes']);
    expect(prompts).toHaveLength(3);
    expect((await pageRows(brain)).map((row) => row.scope_id).sort()).toEqual([B, C].sort());
    const compiledAt = await watermarks(memory);
    expect(compiledAt.get(A)).toBeNull();
    expect(compiledAt.get(B)).not.toBeNull();
    expect(compiledAt.get(C)).not.toBeNull();
    expect(lines('memory.compile_skipped')).toHaveLength(1);
    expect(lines('memory.compile_skipped')[0]).toMatchObject({ reason: 'budget' });
    // The line names no scope.
    expect(JSON.stringify(lines('memory.compile_skipped')[0])).not.toContain('alice');
  });

  it('a scope that fails for another reason keeps its watermark, the others compile, and the call rejects', async () => {
    const { memory, brain } = await open(store);
    const prompts = attachRows(memory, {
      llm: async (prompt) => {
        if (prompt.includes('Alice likes tea.')) throw new Error('the model answered nothing');
        return 'Merged notes.';
      },
      compileSkipReasonOf: budgetReasonOf,
    });
    await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    await memory.remember('Bob plays cello.', { scope: 'conversation', scopeId: B });
    await memory.remember('Carol keeps bees.', { scope: 'conversation', scopeId: C });

    await expect(compiling(memory).compileWiki()).rejects.toThrow('the model answered nothing');

    expect(prompts).toHaveLength(3);
    expect((await pageRows(brain)).map((row) => row.scope_id).sort()).toEqual([B, C].sort());
    const compiledAt = await watermarks(memory);
    expect(compiledAt.get(A)).toBeNull();
    expect(compiledAt.get(B)).not.toBeNull();
    expect(compiledAt.get(C)).not.toBeNull();
    expect(lines('memory.compile_skipped')).toEqual([]);
  });

  it('beforeScopeCompile skips a scope or changes what is compiled', async () => {
    const { memory, brain } = await open(store);
    const asked: string[] = [];
    const prompts = attachRows(memory, {
      beforeScopeCompile: async (scopeId, traces) => {
        asked.push(scopeId);
        return scopeId === A ? { skip: 'policy_raw' } : { traces: traces.slice(0, 1) };
      },
    });
    await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    await memory.remember('Bob plays cello.', { scope: 'conversation', scopeId: B });
    await pause(5);
    const later = await memory.remember('Bob has a dog.', { scope: 'conversation', scopeId: B });

    const result = await compiling(memory).compileWiki();

    expect(asked.sort()).toEqual([A, B].sort());
    expect(result.pagesWritten).toEqual(['concepts/notes']);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Bob plays cello.');
    expect(prompts[0]).not.toContain('Bob has a dog.');
    expect(prompts[0]).not.toContain('Alice');
    expect((await pageRows(brain)).map((row) => row.scope_id)).toEqual([B]);
    const compiledAt = await watermarks(memory);
    expect(compiledAt.get(A)).toBeNull();
    // The watermark moves past the whole batch that was read, whatever the hook kept of it.
    expect(compiledAt.get(B)).toBe(later.createdAt);
    expect(lines('memory.compile_skipped')).toHaveLength(1);
    expect(lines('memory.compile_skipped')[0]).toMatchObject({ reason: 'policy_raw' });
  });
});
