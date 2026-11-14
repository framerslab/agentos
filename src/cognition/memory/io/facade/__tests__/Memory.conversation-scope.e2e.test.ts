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
 *
 * The paths that could cross scopes, and the export: `memory_search` reads no conversation trace; a recall of the
 * conversation scope with no key is refused; consolidation merges no subject's trace into another's; a scope keeps
 * its registry row while one of its pages remains; a message never becomes one with a page chunk of the same text;
 * two writes of one page at once leave one page's chunks; and a SQLite export carries the pages and the registry,
 * which an import brings back and a replace import removes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../Memory.js';
import type { AttachedWiki } from '../Memory.js';
import type { Brain } from '../../../retrieval/store/Brain.js';
import { PORTABLE_TABLES } from '../../../retrieval/store/portable-tables.js';
import { conversationScopeKey } from '../../../retrieval/store/conversationScopeKey.js';
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import pino from 'pino';
import { InvalidWikiPageIdError, UserWikiStore, WikiCompiler } from '../../../../substrate/memory/wiki/index.js';
import type { CompileResult, UserWikiPagesPort, WikiPage } from '../../../../substrate/memory/wiki/index.js';
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
      for (const table of ['memory_legacy_owner', 'memory_pages', 'memory_scopes', ...[...PORTABLE_TABLES].reverse()]) {
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
      // Once armed, the page row's write (its insert, or the update of a row read) is refused inside the transaction.
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
                  const statement = sql.trimStart();
                  if (armed && (statement.startsWith('INSERT INTO memory_pages') || statement.startsWith('UPDATE memory_pages'))) {
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
type CompileHooks = Pick<AttachedWiki, 'beforeScopeCompile' | 'compileSkipReasonOf'>;

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
    llm: async (prompt) => {
      prompts.push(prompt);
      return llm ? llm(prompt) : 'Merged notes.';
    },
    cluster: async (traces) => [{ pageId: 'concepts/notes', traceIds: traces.map((t) => t.id) }],
  });
  memory.attachWiki({
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

    const result = await memory.compileWiki();

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

  it('two compiles at once send the traces of a scope to the model once', async () => {
    const { memory } = await open(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompts = attachRows(memory, {
      llm: async () => {
        await gate;
        return 'Merged notes.';
      },
    });
    await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    await memory.remember('Alice has a cat.', { scope: 'conversation', scopeId: A });

    // The second compile reads the scopes to compile while the first one's model call is held.
    const first = memory.compileWiki();
    const second = memory.compileWiki();
    for (let i = 0; i < 400 && prompts.length < 1; i += 1) await pause(5);
    await pause(50);
    release();
    await Promise.all([first, second]);

    expect(prompts).toHaveLength(1);
  });

  it('compiles nothing a second time, and only the scope with a new trace the third', async () => {
    const { memory } = await open(store);
    const prompts = attachRows(memory);
    await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    await memory.remember('Bob plays cello.', { scope: 'conversation', scopeId: B });
    await memory.compileWiki();
    expect(prompts).toHaveLength(2);

    expect(await memory.compileWiki()).toEqual(NOTHING_COMPILED);
    expect(prompts).toHaveLength(2);

    await pause(5);
    await memory.remember('Bob has a dog.', { scope: 'conversation', scopeId: B });
    const third = await memory.compileWiki();

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
    await memory.compileWiki();
    expect(prompts).toHaveLength(1);
    expect((await watermarks(memory)).get(A)).toBe(fact.createdAt);
    // The page's chunks were stored after the trace the compile read.
    const newest = await newestTraceAt(brain, A);
    expect(newest).toBeGreaterThan(fact.createdAt);

    expect(await memory.compileWiki()).toEqual(NOTHING_COMPILED);

    expect(prompts).toHaveLength(1);
    expect((await watermarks(memory)).get(A)).toBe(newest);
  });

  it('never compiles the operator scope', async () => {
    const { memory, brain } = await open(store);
    const prompts = attachRows(memory);
    await memory.remember('Open nine to five.', { scope: 'conversation', scopeId: OPERATOR });

    expect(await memory.compileWiki()).toEqual(NOTHING_COMPILED);
    expect(await memory.compileWiki({ scopes: [OPERATOR] })).toEqual(NOTHING_COMPILED);

    expect(prompts).toEqual([]);
    expect(await pageRows(brain)).toEqual([]);
    expect((await watermarks(memory)).get(OPERATOR)).toBeNull();
  });

  it('compileWiki({ scopes }) compiles the named scopes alone, and none for an empty list', async () => {
    const { memory, brain } = await open(store);
    const prompts = attachRows(memory);
    await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    await memory.remember('Bob plays cello.', { scope: 'conversation', scopeId: B });

    expect(await memory.compileWiki({ scopes: [] })).toEqual(NOTHING_COMPILED);
    expect(prompts).toEqual([]);

    // A scope with no registry row is left out, and a scope named twice is compiled once.
    const result = await memory.compileWiki({ scopes: [B, C, B] });

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

    const result = await memory.compileWiki();

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

    await expect(memory.compileWiki()).rejects.toThrow('the model answered nothing');

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

    const result = await memory.compileWiki();

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

  it('compiles every trace of a millisecond that more traces share than one batch holds', async () => {
    const { memory, brain } = await open(store);
    attachRows(memory);
    for (let i = 0; i < 501; i += 1) await memory.remember(`Alice fact ${i}.`, { scope: 'conversation', scopeId: A });
    // Stored in one millisecond, as an import can store them.
    await brain.run(`UPDATE memory_traces SET created_at = ? WHERE brain_id = ? AND scope = 'conversation' AND scope_id = ?`, [
      1_700_000_000_000,
      brain.brainId,
      A,
    ]);

    const result = await memory.compileWiki();

    expect(result.tracesConsumed).toBe(501);
    expect((await memory.compileWiki()).tracesConsumed).toBe(0);
  });

  it('a trace whose write is still being made when a compile reads is compiled by the next compile', async () => {
    const { memory } = await open(store);
    const prompts = attachRows(memory);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The trace's embedding is made after its time is stamped and before its row is stored: held here, it is stored
    // after a trace stamped later.
    const facade = memory as unknown as { _embeddingBlobOf: (text: string) => Promise<unknown> };
    let entered!: () => void;
    const stamped = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const embed = facade._embeddingBlobOf.bind(memory);
    facade._embeddingBlobOf = async (text: string) => {
      if (text.includes('kestrel')) {
        // The trace is stamped and counted as not yet stored by now.
        entered();
        await gate;
      }
      return embed(text);
    };
    const late = memory.remember('Alice keeps a kestrel.', { scope: 'conversation', scopeId: A });
    await stamped;
    await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });

    await memory.compileWiki();
    release();
    await late;
    await memory.compileWiki();

    const merged = prompts.join('\n');
    expect(merged).toContain('Alice keeps a kestrel.');
    expect(merged).toContain('Alice likes tea.');
  });
});

/** The ids of the traces of a scope that are chunks of a wiki page. */
const chunkTraceIdsUnder = async (brain: Brain, scopeId: string): Promise<string[]> =>
  (
    await brain.all<{ id: string; tags: string }>(
      `SELECT id, tags FROM memory_traces WHERE brain_id = ? AND scope = 'conversation' AND scope_id = ?`,
      [brain.brainId, scopeId],
    )
  )
    .filter((row) => (JSON.parse(row.tags) as string[]).includes('wiki'))
    .map((row) => row.id)
    .sort();
/** The text of every trace of a scope. */
const contentsUnder = async (brain: Brain, scopeId: string): Promise<string[]> =>
  (
    await brain.all<{ content: string }>(
      `SELECT content FROM memory_traces WHERE brain_id = ? AND scope = 'conversation' AND scope_id = ?`,
      [brain.brainId, scopeId],
    )
  )
    .map((row) => row.content)
    .sort();
/** How many traces of exactly `text` a scope holds that are not page chunks. */
const messagesUnder = async (brain: Brain, scopeId: string, text: string): Promise<number> =>
  (
    await brain.all<{ tags: string }>(
      `SELECT tags FROM memory_traces WHERE brain_id = ? AND scope = 'conversation' AND scope_id = ? AND content = ?`,
      [brain.brainId, scopeId, text],
    )
  ).filter((row) => !(JSON.parse(row.tags) as string[]).includes('wiki')).length;
/** A tool context with no user and no turn of a learning layer. */
const NO_TURN = { gmiId: 'g', personaId: 'p', userContext: { userId: 'system' } } as never;

describe.each(STORES)('scopes kept apart on every path, on %s', (store) => {
  it('memory_search reads no conversation trace, and refuses a search that names the conversation scope', async () => {
    const { memory } = await open(store);
    await memory.remember('Zorblat is my cat.', { scope: 'conversation', scopeId: A });
    await memory.remember('Zorblat is a town.', { scope: 'user', scopeId: 'ana' });
    const search = memory.createTools().find((tool) => tool.name === 'memory_search')!;

    const found = await search.execute({ query: 'Zorblat' } as never, NO_TURN);
    expect(found.success).toBe(true);
    expect((found.output as { results: Array<{ content: string }> }).results.map((result) => result.content)).toEqual([
      'Zorblat is a town.',
    ]);

    const named = await search.execute({ query: 'Zorblat', scope: 'conversation' } as never, NO_TURN);
    expect(named.success).toBe(false);
    expect(named.error).toContain('conversation');
    expect(JSON.stringify(named)).not.toContain('Zorblat is my cat.');
  });

  it('a recall or a listing of the conversation scope with no key is refused', async () => {
    const { memory } = await open(store);
    await memory.remember('Zorblat is my cat.', { scope: 'conversation', scopeId: A });

    await expect(memory.recall('Zorblat', { scope: 'conversation' })).rejects.toThrow(TypeError);
    await expect(memory.recall('Zorblat', { scope: 'conversation', scopeId: '' })).rejects.toThrow(TypeError);
    await expect(memory.recentTraces(0, { scope: 'conversation' })).rejects.toThrow(TypeError);
    // With its key the scope is read as before.
    expect(contentsOf((await memory.recall('Zorblat', { scope: 'conversation', scopeId: A })).map((r) => r.trace))).toEqual([
      'Zorblat is my cat.',
    ]);
    expect(contentsOf(await memory.recentTraces(0, { scope: 'conversation', scopeId: A }))).toEqual(['Zorblat is my cat.']);
  });

  it("deleteScope keeps the scope's registry row while a page of the scope remains", async () => {
    const { memory, brain } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    await pages.writePage(P('Alice likes tea.'));
    await memory.remember('Alice said she likes tea.', { scope: 'conversation', scopeId: A });

    await memory.deleteScope('conversation', A);

    // The traces are gone; the page is still a row of the scope, so the registry still names the scope.
    expect(await traceIdsUnder(brain, A)).toEqual([]);
    expect((await pageRows(brain)).map((row) => row.scope_id)).toEqual([A]);
    expect((await scopeRows(brain)).map((row) => row.scope_id)).toEqual([A]);

    await pages.deleteAll();
    await memory.deleteScope('conversation', A);

    expect(await pageRows(brain)).toEqual([]);
    expect(await scopeRows(brain)).toEqual([]);
  });

  it("a message with the text of one of its scope's page chunks is stored as a trace of its own", async () => {
    const { memory, brain } = await open(store);
    const session = conversationScopeKey('aria-1', { kind: 'session', id: 's1' });
    const pages = new UserWikiStore({ scopeId: session, pages: memory, chunk });
    const log: WikiPage = { ...P('We met on Tuesday.'), id: 'log/2026-01-01', type: 'log' };
    await pages.writePage(log);
    const chunks = await chunkTraceIdsUnder(brain, session);
    expect(chunks).toHaveLength(1);

    const said = await memory.remember('We met on Tuesday.', { type: 'episodic', scope: 'conversation', scopeId: session });

    expect(chunks).not.toContain(said.id);
    expect(await contentsUnder(brain, session)).toEqual(['We met on Tuesday.', 'We met on Tuesday.']);
    // The page's next rewrite takes its own chunk and leaves the message.
    await pages.writePage({ ...log, body: 'We met on Wednesday.' });
    expect(await contentsUnder(brain, session)).toEqual(['We met on Tuesday.', 'We met on Wednesday.']);
    expect((await traceIdsUnder(brain, session)).includes(said.id)).toBe(true);
  });

  it("two writes of one page at once leave the chunks of the page that is kept, and no other's", async () => {
    const { memory, brain } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    await pages.writePage(P('Alice likes tea.'));

    await Promise.all([pages.writePage(P('Alice drinks espresso.')), pages.writePage(P('Alice keeps a ferret.'))]);

    const rows = await pageRows(brain);
    expect(rows).toHaveLength(1);
    expect(await traceIdsUnder(brain, A)).toEqual(chunkIdsOf(rows[0]!));
    const body = bodyOf(await pages.readPage('concepts/notes'));
    expect(['Alice drinks espresso.', 'Alice keeps a ferret.']).toContain(body);
    expect(await contentsUnder(brain, A)).toEqual([body]);
  });

  it('a message stored again is one trace, though more page chunks of its text than one read takes come first', async () => {
    const { memory, brain } = await open(store);
    const log: WikiPage = { ...P(Array.from({ length: 51 }, () => 'We met on Tuesday.').join('\n\n')), id: 'log/2026-01-01', type: 'log' };
    await new UserWikiStore({ scopeId: A, pages: memory, chunk }).writePage(log);
    expect(await chunkTraceIdsUnder(brain, A)).toHaveLength(51);

    await memory.remember('We met on Tuesday.', { type: 'episodic', scope: 'conversation', scopeId: A });
    await memory.remember('We met on Tuesday.', { type: 'episodic', scope: 'conversation', scopeId: A });

    expect(await messagesUnder(brain, A, 'We met on Tuesday.')).toBe(1);
  });

  it('a forced re-index never writes back a page that a write of the scope changed meanwhile', async () => {
    const { memory } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    await pages.writePage({ ...P('Alice likes tea.'), id: 'concepts/a' });
    await pages.writePage({ ...P('Alice has a cat.'), id: 'concepts/b' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    // The re-index of the first page waits in its chunks' embedding, inside the scope's serialized write.
    const facade = memory as unknown as { _embeddingBlobOf: (text: string) => Promise<unknown> };
    const embed = facade._embeddingBlobOf.bind(memory);
    facade._embeddingBlobOf = async (text: string) => {
      if (!held && text.includes('tea')) {
        held = true;
        await gate;
      }
      return embed(text);
    };

    const reindexed = pages.index({ force: true });
    for (let i = 0; i < 400 && !held; i += 1) await pause(5);
    expect(held).toBe(true);
    const rewritten = pages.writePage({ ...P('Alice keeps a ferret.'), id: 'concepts/b' });
    release();
    await reindexed;
    await rewritten;

    expect(bodyOf(await pages.readPage('concepts/b'))).toBe('Alice keeps a ferret.');
    expect(bodyOf(await pages.readPage('concepts/a'))).toBe('Alice likes tea.');
  });

  it('a forced re-index keeps the summary a write of the scope gave a page meanwhile', async () => {
    const { memory } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    await pages.writePage({ ...P('Alice likes tea.'), id: 'concepts/a' });
    await pages.writePage({ ...P('Alice has a cat.'), id: 'concepts/b' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const facade = memory as unknown as { _embeddingBlobOf: (text: string) => Promise<unknown> };
    const embed = facade._embeddingBlobOf.bind(memory);
    facade._embeddingBlobOf = async (text: string) => {
      if (!held && text.includes('tea')) {
        held = true;
        await gate;
      }
      return embed(text);
    };

    const reindexed = pages.index({ force: true });
    for (let i = 0; i < 400 && !held; i += 1) await pause(5);
    expect(held).toBe(true);
    // The body the re-index listed, with a new summary.
    const resummarized = pages.writePage({ ...P('Alice has a cat.'), id: 'concepts/b', summary: 'What Alice keeps at home' });
    release();
    await reindexed;
    await resummarized;

    const b = await pages.readPage('concepts/b');
    expect(b?.summary).toBe('What Alice keeps at home');
    expect(bodyOf(b)).toBe('Alice has a cat.');
  });

  it('a page write leaves no chunk its row does not list when another process rewrites the page meanwhile', async () => {
    const { memory, brain } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    await pages.writePage(P('Alice likes tea.'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const facade = memory as unknown as {
      _embeddingBlobOf: (text: string) => Promise<unknown>;
      _writePageRow: UserWikiPagesPort['writePageRow'];
    };
    const embed = facade._embeddingBlobOf.bind(memory);
    facade._embeddingBlobOf = async (text: string) => {
      if (!held && text.includes('espresso')) {
        held = true;
        await gate;
      }
      return embed(text);
    };
    // A writer in another process: the same rows, and none of this process's ordering of page writes.
    const otherProcess = new UserWikiStore({
      scopeId: A,
      chunk,
      pages: {
        readPageRow: (scopeId, pageId) => memory.readPageRow(scopeId, pageId),
        listPageRows: (scopeId) => memory.listPageRows(scopeId),
        writePageRow: (scopeId, page) => facade._writePageRow.call(memory, scopeId, page),
        reindexPageRow: (scopeId, pageId, chunksOf) => memory.reindexPageRow(scopeId, pageId, chunksOf),
        deletePageRows: (scopeId, pageId) => memory.deletePageRows(scopeId, pageId),
      },
    });

    const written = pages.writePage(P('Alice drinks espresso.'));
    for (let i = 0; i < 400 && !held; i += 1) await pause(5);
    expect(held).toBe(true);
    await otherProcess.writePage(P('Alice keeps a ferret.'));
    release();
    await written;

    const rows = await pageRows(brain);
    expect(rows).toHaveLength(1);
    expect(await traceIdsUnder(brain, A)).toEqual(chunkIdsOf(rows[0]!));
  });

  it('a page delete leaves no chunk of the page when another process rewrites it meanwhile', async () => {
    const { memory, brain } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    await pages.writePage(P('Alice likes tea.'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const facade = memory as unknown as {
      deleteTraces: Memory['deleteTraces'];
      _writePageRow: UserWikiPagesPort['writePageRow'];
    };
    const deleteTraces = memory.deleteTraces.bind(memory);
    // The delete's first chunk delete waits: the row it read is rewritten before it deletes the row.
    facade.deleteTraces = async (ids) => {
      if (!held) {
        held = true;
        await gate;
      }
      return deleteTraces(ids);
    };
    // A writer in another process: the same rows, and none of this process's ordering of page writes.
    const otherProcess = new UserWikiStore({
      scopeId: A,
      chunk,
      pages: {
        readPageRow: (scopeId, pageId) => memory.readPageRow(scopeId, pageId),
        listPageRows: (scopeId) => memory.listPageRows(scopeId),
        writePageRow: (scopeId, page) => facade._writePageRow.call(memory, scopeId, page),
        reindexPageRow: (scopeId, pageId, chunksOf) => memory.reindexPageRow(scopeId, pageId, chunksOf),
        deletePageRows: (scopeId, pageId) => memory.deletePageRows(scopeId, pageId),
      },
    });

    const deleting = memory.deletePageRows(A, 'concepts/notes');
    for (let i = 0; i < 400 && !held; i += 1) await pause(5);
    expect(held).toBe(true);
    await otherProcess.writePage(P('Alice keeps a ferret.'));
    release();
    await deleting;

    expect(await pageRows(brain)).toEqual([]);
    expect(await traceIdsUnder(brain, A)).toEqual([]);
  });

  it('deleteScope keeps the registry row of a scope a message is stored under while it deletes', async () => {
    const { memory, brain } = await open(store);
    await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deleted = false;
    const facade = memory as unknown as { deleteTraces: (ids: readonly string[]) => Promise<{ deleted: number }> };
    const deleteTraces = facade.deleteTraces.bind(memory);
    facade.deleteTraces = async (ids) => {
      const result = await deleteTraces(ids);
      deleted = true;
      await gate;
      return result;
    };

    const deleting = memory.deleteScope('conversation', A);
    for (let i = 0; i < 400 && !deleted; i += 1) await pause(5);
    expect(deleted).toBe(true);
    // Stored once the delete has read the scope's traces, before it comes to the registry row.
    await memory.remember('Alice keeps a kestrel.', { scope: 'conversation', scopeId: A });
    release();
    await deleting;

    expect(await contentsUnder(brain, A)).toEqual(['Alice keeps a kestrel.']);
    expect((await scopeRows(brain)).map((row) => row.scope_id)).toEqual([A]);
  });

  it("a scope's pages and traces deleted while its compile runs leave nothing of the scope", async () => {
    const { memory, brain } = await open(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompts = attachRows(memory, {
      llm: async () => {
        await gate;
        return 'Merged notes.';
      },
    });
    await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    const compiling = memory.compileWiki();
    for (let i = 0; i < 400 && prompts.length < 1; i += 1) await pause(5);
    expect(prompts).toHaveLength(1);

    // The scope deleted as an account's deletion deletes it: its pages, then its traces.
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    const forgotten = pages.deleteAll().then(() => memory.deleteScope('conversation', A));
    await pause(20);
    release();
    await compiling;
    await forgotten;

    expect(await pageRows(brain)).toEqual([]);
    expect(await traceIdsUnder(brain, A)).toEqual([]);
    expect(await scopeRows(brain)).toEqual([]);
  });

  if (store === 'postgres') {
    /** A second facade on the brain of `memory`, as a second handle of one process opens it. */
    const sameBrain = async (memory: Memory): Promise<Memory> => {
      const second = await Memory.createPostgres(POSTGRES_URL!, {
        brainId: brainOf(memory).brainId,
        poolSize: 2,
        graph: false,
        selfImprove: false,
      });
      memories.push(second);
      return second;
    };

    it("two facades of one brain, writing one page at once, leave the kept page's chunks and no other's", async () => {
      const { memory, brain } = await open(store);
      const second = await sameBrain(memory);
      const one = new UserWikiStore({ scopeId: A, pages: memory, chunk });
      const two = new UserWikiStore({ scopeId: A, pages: second, chunk });
      await one.writePage(P('Alice likes tea.'));

      await Promise.all([one.writePage(P('Alice drinks espresso.')), two.writePage(P('Alice keeps a ferret.'))]);

      const rows = await pageRows(brain);
      expect(rows).toHaveLength(1);
      expect(await traceIdsUnder(brain, A)).toEqual(chunkIdsOf(rows[0]!));
    });

    it('a trace one facade is still storing when another facade of the brain compiles is compiled by the next compile', async () => {
      const { memory } = await open(store);
      const second = await sameBrain(memory);
      const prompts = attachRows(second);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const stamped = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const facade = memory as unknown as { _embeddingBlobOf: (text: string) => Promise<unknown> };
      const embed = facade._embeddingBlobOf.bind(memory);
      facade._embeddingBlobOf = async (text: string) => {
        if (text.includes('kestrel')) {
          // The trace is stamped and counted as not yet stored by now.
          entered();
          await gate;
        }
        return embed(text);
      };
      const late = memory.remember('Alice keeps a kestrel.', { scope: 'conversation', scopeId: A });
      await stamped;
      await second.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });

      await second.compileWiki();
      release();
      await late;
      await second.compileWiki();

      expect(prompts.join('\n')).toContain('Alice keeps a kestrel.');
    });
  }

  it("a write of the body a page holds, made while another write changes it, leaves that body's chunks", async () => {
    const { memory, brain } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    await pages.writePage(P('Alice likes tea.'));

    // Both writes read the stored page before either is made; the second one's body is the one stored.
    await Promise.all([pages.writePage(P('Alice drinks espresso.')), pages.writePage(P('Alice likes tea.'))]);

    const rows = await pageRows(brain);
    expect(rows).toHaveLength(1);
    expect(bodyOf(await pages.readPage('concepts/notes'))).toBe('Alice likes tea.');
    expect(await contentsUnder(brain, A)).toEqual(['Alice likes tea.']);
    expect(await traceIdsUnder(brain, A)).toEqual(chunkIdsOf(rows[0]!));
  });

  /** A brain that holds alice's page, one message of hers and a compile watermark, exported as JSON text. */
  const exportedJson = async (): Promise<{ json: string; scopes: Awaited<ReturnType<Memory['listScopes']>> }> => {
    const { memory, brain } = await open(store);
    await new UserWikiStore({ scopeId: A, pages: memory, chunk }).writePage(P('Alice likes tea.\n\nAlice has a cat.', ['t1']));
    await memory.remember('Alice said she likes tea.', { scope: 'conversation', scopeId: A });
    await brain.run('UPDATE memory_scopes SET compiled_at = ? WHERE brain_id = ? AND scope_id = ?', [1_700_000_000_000, brain.brainId, A]);
    return { json: await memory.exportToString(), scopes: await memory.listScopes() };
  };

  it("a JSON export carries each subject's pages and the scope registry, and an import brings them back", async () => {
    const { json, scopes } = await exportedJson();
    const { memory, brain } = await open(store);

    const result = await memory.importFromString(json, 'json');

    expect(result.errors).toEqual([]);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    const page = await pages.readPage('concepts/notes');
    expect(bodyOf(page)).toBe('Alice likes tea.\n\nAlice has a cat.');
    expect(page?.sources).toEqual(['t1']);
    // The row lists the chunks the import wrote, so no chunk is left that no row lists.
    const rows = await pageRows(brain);
    expect(rows).toHaveLength(1);
    expect(chunkIdsOf(rows[0]!)).toEqual(await chunkTraceIdsUnder(brain, A));
    expect(chunkIdsOf(rows[0]!)).toHaveLength(2);
    expect(await contentsUnder(brain, A)).toEqual(['Alice has a cat.', 'Alice likes tea.', 'Alice said she likes tea.']);
    // The scope comes with its watermark, so its next compile does not read the same traces again.
    expect(await memory.listScopes()).toEqual(scopes);
    expect(scopes.map((row) => row.compiledAt)).toEqual([1_700_000_000_000]);

    // The page's next rewrite takes the chunks the import wrote, and leaves what alice said.
    await pages.writePage(P('Alice drinks espresso.'));
    expect(await contentsUnder(brain, A)).toEqual(['Alice drinks espresso.', 'Alice said she likes tea.']);
  });

  it('a JSON export made while a page is rewritten lists, for each page, chunks it carries', async () => {
    const { memory, brain } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    await pages.writePage(P('Alice likes tea.'));
    // Right after the export has read the traces, the page is rewritten: new chunks, a new row.
    const TRACES = 'SELECT * FROM memory_traces WHERE brain_id = ?';
    let fired = false;
    const rewriteAfterTraces = (all: Brain['all']): Brain['all'] =>
      (async (sql: string, params?: unknown) => {
        const rows = await all(sql, params as never);
        if (!fired && sql.trim() === TRACES) {
          fired = true;
          await pages.writePage(P('Alice keeps a ferret.'));
        }
        return rows;
      }) as unknown as Brain['all'];
    const handle = brain as unknown as {
      all: Brain['all'];
      readConsistently?: <T>(read: (source: { all: Brain['all'] }) => Promise<T>) => Promise<T>;
    };
    handle.all = rewriteAfterTraces(brain.all.bind(brain));
    const readConsistently = handle.readConsistently?.bind(brain);
    if (readConsistently) {
      handle.readConsistently = (read) =>
        readConsistently((source) =>
          read(
            new Proxy(source, {
              get(target, property) {
                if (property === 'all') return rewriteAfterTraces(target.all.bind(target));
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ),
        );
    }

    const exported = JSON.parse(await memory.exportToString()) as {
      traces: Array<{ id: string }>;
      pages: Array<{ chunk_ids: string }>;
    };

    expect(fired).toBe(true);
    const traceIds = new Set(exported.traces.map((trace) => trace.id));
    expect(exported.pages).toHaveLength(1);
    for (const page of exported.pages) {
      for (const id of JSON.parse(page.chunk_ids) as string[]) expect(traceIds.has(id)).toBe(true);
    }
  });

  it("a JSON import keeps a page the brain already holds, and brings none of the file's chunks for it", async () => {
    const { json } = await exportedJson();
    const { memory, brain } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    await pages.writePage(P('Alice drinks espresso.'));
    const held = await chunkTraceIdsUnder(brain, A);

    const result = await memory.importFromString(json, 'json');

    expect(result.errors).toEqual([]);
    expect(bodyOf(await pages.readPage('concepts/notes'))).toBe('Alice drinks espresso.');
    expect(await chunkTraceIdsUnder(brain, A)).toEqual(held);
    expect(chunkIdsOf((await pageRows(brain))[0]!)).toEqual(held);
    expect(await contentsUnder(brain, A)).toEqual(['Alice drinks espresso.', 'Alice said she likes tea.']);
    // The brain keeps its own watermark for a scope it already holds.
    expect((await memory.listScopes()).map((row) => [row.scopeId, row.compiledAt])).toEqual([[A, null]]);
  });

  it('a JSON export carries the owner of older memory, and its import brings the owner back', async () => {
    const source = await open(store);
    await source.memory.remember('old shared words about a heron', { scope: 'persona', scopeId: 'aria-1' });
    await source.memory.setLegacyOwner('aria-1', A);
    const json = await source.memory.exportToString();
    const { memory } = await open(store);

    const result = await memory.importFromString(json, 'json');

    expect(result.errors).toEqual([]);
    // Without the owner, the older memory is withheld again, and a deletion of its owner would not reach it.
    expect(await memory.legacyOwner('aria-1')).toBe(A);
  });

  it("a JSON-imported message with the text of one of the brain's page chunks is stored as a trace of its own", async () => {
    const source = await open(store);
    await source.memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
    const json = await source.memory.exportToString();
    const { memory, brain } = await open(store);
    const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
    await pages.writePage(P('Alice likes tea.'));

    const result = await memory.importFromString(json, 'json');

    expect(result.errors).toEqual([]);
    expect(await contentsUnder(brain, A)).toEqual(['Alice likes tea.', 'Alice likes tea.']);
    await pages.writePage(P('Alice drinks espresso.'));
    expect(await contentsUnder(brain, A)).toEqual(['Alice drinks espresso.', 'Alice likes tea.']);
  });

  // These run the consolidation loop on a store of its own, or write and read a SQLite export file.
  if (store === 'sqlite') {
    /** A facade on a fresh SQLite file, with the options given. */
    const openWith = async (config: Record<string, unknown>): Promise<{ memory: Memory; brain: Brain; dir: string }> => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-scope-'));
      dirs.push(dir);
      const memory = await Memory.createSqlite(path.join(dir, 'brain.sqlite'), { graph: false, decay: false, ...config } as never);
      memories.push(memory);
      return { memory, brain: brainOf(memory), dir };
    };

    it("consolidation merges no trace of one subject into another's", async () => {
      const { memory, brain } = await openWith({ selfImprove: true });
      await memory.remember('I like tea.', { scope: 'conversation', scopeId: A });
      await memory.remember('I like tea.', { scope: 'conversation', scopeId: B });
      // Two traces of the same text outside the conversation scope are merged, as before.
      await memory.remember('I like tea.', { scope: 'thread', scopeId: 't1' });
      await memory.remember('I like tea.', { scope: 'thread', scopeId: 't2' });

      const result = await memory.consolidate();

      expect(result.merged).toBe(1);
      const live = await brain.all<{ scope: string; scope_id: string }>(
        `SELECT scope, scope_id FROM memory_traces WHERE brain_id = ? AND deleted = 0 AND scope = 'conversation'`,
        [brain.brainId],
      );
      expect(live.map((row) => row.scope_id).sort()).toEqual([A, B].sort());
    });

    /** A brain that holds alice's page, one message of hers and a compile watermark, exported to a SQLite file. */
    const exported = async (): Promise<{ file: string; createdAt: number }> => {
      const { memory, brain, dir } = await openWith({ selfImprove: false });
      await new UserWikiStore({ scopeId: A, pages: memory, chunk }).writePage(P('Alice likes tea.\n\nAlice has a cat.', ['t1']));
      await memory.remember('Alice said she likes tea.', { scope: 'conversation', scopeId: A });
      await brain.run('UPDATE memory_scopes SET compiled_at = ? WHERE brain_id = ? AND scope_id = ?', [1_700_000_000_000, brain.brainId, A]);
      const [{ createdAt }] = await memory.listScopes();
      const file = path.join(dir, 'export.sqlite');
      await memory.export(file, { format: 'sqlite' });
      return { file, createdAt };
    };

    it("a SQLite export carries each subject's pages and the scope registry, and an import brings them back", async () => {
      const { file, createdAt } = await exported();
      const { memory, brain } = await openWith({ selfImprove: false });

      const result = await memory.importFrom(file, { format: 'sqlite' });

      expect(result.errors).toEqual([]);
      const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
      const page = await pages.readPage('concepts/notes');
      expect(bodyOf(page)).toBe('Alice likes tea.\n\nAlice has a cat.');
      expect(page?.sources).toEqual(['t1']);
      // The row lists the chunks the import wrote, and recall reads them under alice's key.
      const rows = await pageRows(brain);
      expect(rows).toHaveLength(1);
      expect(chunkIdsOf(rows[0]!)).toEqual(await chunkTraceIdsUnder(brain, A));
      expect(chunkIdsOf(rows[0]!)).toHaveLength(2);
      expect((await memory.recall('cat', { scope: 'conversation', scopeId: A })).map((r) => r.trace.content)).toEqual(['Alice has a cat.']);
      expect(await contentsUnder(brain, A)).toEqual(['Alice has a cat.', 'Alice likes tea.', 'Alice said she likes tea.']);
      // The scope comes with its watermark, so its next compile does not read the same traces again.
      expect(await memory.listScopes()).toEqual([{ scopeId: A, kind: 'user', agentId: 'aria-1', createdAt, compiledAt: 1_700_000_000_000 }]);
    });

    it("an import keeps a page the brain already holds, and brings none of the file's chunks for it", async () => {
      const { file } = await exported();
      const { memory, brain } = await openWith({ selfImprove: false });
      const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
      await pages.writePage(P('Alice drinks espresso.'));
      const held = await chunkTraceIdsUnder(brain, A);

      const result = await memory.importFrom(file, { format: 'sqlite' });

      expect(result.errors).toEqual([]);
      expect(bodyOf(await pages.readPage('concepts/notes'))).toBe('Alice drinks espresso.');
      expect(await chunkTraceIdsUnder(brain, A)).toEqual(held);
      expect(chunkIdsOf((await pageRows(brain))[0]!)).toEqual(held);
      // What alice said comes in as a trace; the chunks of the file's page do not.
      expect(await contentsUnder(brain, A)).toEqual(['Alice drinks espresso.', 'Alice said she likes tea.']);
      // The brain keeps its own watermark for a scope it already holds.
      expect((await memory.listScopes()).map((row) => [row.scopeId, row.compiledAt])).toEqual([[A, null]]);
    });

    it('a replace import removes the pages and the registry rows the brain held', async () => {
      const { file } = await exported();
      const { memory, brain } = await openWith({ selfImprove: false });
      await new UserWikiStore({ scopeId: B, pages: memory, chunk }).writePage(P('Bob plays cello.'));
      await memory.remember('Bob said he plays cello.', { scope: 'conversation', scopeId: B });

      await brain.importFromSqlite(file, { strategy: 'replace' });

      expect((await pageRows(brain)).map((row) => row.scope_id)).toEqual([A]);
      expect((await scopeRows(brain)).map((row) => [row.scope_id, Number(row.compiled_at)])).toEqual([[A, 1_700_000_000_000]]);
      expect(await traceIdsUnder(brain, B)).toEqual([]);
      const rows = await pageRows(brain);
      expect(chunkIdsOf(rows[0]!)).toEqual(await chunkTraceIdsUnder(brain, A));
      expect(bodyOf(await new UserWikiStore({ scopeId: A, pages: memory, chunk }).readPage('concepts/notes'))).toBe(
        'Alice likes tea.\n\nAlice has a cat.',
      );
    });

    /** Runs `edit` on a SQLite file through an adapter of its own, then closes it. */
    const editFile = async (file: string, edit: (db: StorageAdapter) => Promise<unknown>): Promise<void> => {
      const db = await resolveStorageAdapter({ filePath: file, quiet: true });
      try {
        await edit(db);
      } finally {
        await db.close();
      }
    };

    it('an import of a file whose pages cannot be read is refused, and brings nothing in', async () => {
      const { file } = await exported();
      await editFile(file, (db) => db.run('ALTER TABLE memory_pages RENAME COLUMN brain_id TO owner_id'));
      const { memory, brain } = await openWith({ selfImprove: false });

      const result = await memory.importFrom(file, { format: 'sqlite' });

      expect(result.errors.join('\n')).toContain('memory_pages');
      expect(await contentsUnder(brain, A)).toEqual([]);
      expect(await pageRows(brain)).toEqual([]);
    });

    it('an import of a file whose pages are of two brains is refused, though the file holds no trace', async () => {
      const { memory: source, dir } = await openWith({ selfImprove: false });
      await source.writePageRow(A, { pageId: 'concepts/notes', content: 'Alice likes tea.\n', contentHash: 'h-alice' });
      const file = path.join(dir, 'pages.sqlite');
      await source.export(file, { format: 'sqlite' });
      await editFile(file, (db) =>
        db.run(
          `INSERT INTO memory_pages (brain_id, scope, scope_id, page_id, content, content_hash, chunk_ids, updated_at)
           VALUES ('another-brain', 'conversation', ?, 'concepts/notes', 'Bob plays cello.', 'h-bob', '[]', 1)`,
          [B],
        ),
      );
      const { memory, brain } = await openWith({ selfImprove: false });

      const result = await memory.importFrom(file, { format: 'sqlite' });

      expect(result.errors.join('\n')).toContain('several brains');
      expect(await pageRows(brain)).toEqual([]);
    });

    it('a merge of a brain file whose pages and registry rows name another brain than its meta is refused', async () => {
      const { memory: source, dir } = await openWith({ selfImprove: false });
      await source.writePageRow(A, { pageId: 'concepts/notes', content: 'Alice likes tea.\n', contentHash: 'h-alice' });
      const file = path.join(dir, 'pages.sqlite');
      await source.export(file, { format: 'sqlite' });
      await editFile(file, async (db) => {
        await db.run(
          `INSERT INTO memory_scopes (brain_id, scope, scope_id, kind, agent_id, created_at)
           VALUES ('another-brain', 'conversation', ?, 'user', 'aria-1', 1)`,
          [B],
        );
        await db.run(
          `INSERT INTO memory_pages (brain_id, scope, scope_id, page_id, content, content_hash, chunk_ids, updated_at)
           VALUES ('another-brain', 'conversation', ?, 'concepts/notes', 'Bob plays cello.', 'h-bob', '[]', 1)`,
          [B],
        );
      });
      const { brain } = await openWith({ selfImprove: false });

      await expect(brain.importFromSqlite(file, { strategy: 'merge' })).rejects.toThrow('multiple brain_ids');

      expect(await pageRows(brain)).toEqual([]);
      expect(await scopeRows(brain)).toEqual([]);
    });

    it("an imported message with the text of one of the brain's page chunks is stored as a trace of its own", async () => {
      const source = await openWith({ selfImprove: false });
      await source.memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
      const file = path.join(source.dir, 'message.sqlite');
      await source.memory.export(file, { format: 'sqlite' });
      const { memory, brain } = await openWith({ selfImprove: false });
      const pages = new UserWikiStore({ scopeId: A, pages: memory, chunk });
      await pages.writePage(P('Alice likes tea.'));

      const result = await memory.importFrom(file, { format: 'sqlite' });

      expect(result.errors).toEqual([]);
      expect(await contentsUnder(brain, A)).toEqual(['Alice likes tea.', 'Alice likes tea.']);
      // The page's next rewrite takes its own chunk and leaves the message.
      await pages.writePage(P('Alice drinks espresso.'));
      expect(await contentsUnder(brain, A)).toEqual(['Alice drinks espresso.', 'Alice likes tea.']);
    });

    it('an imported message is matched to the message the brain holds, though more page chunks of its text come first', async () => {
      const source = await openWith({ selfImprove: false });
      await source.memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
      const file = path.join(source.dir, 'many.sqlite');
      await source.memory.export(file, { format: 'sqlite' });
      const { memory, brain } = await openWith({ selfImprove: false });
      // A page of 51 chunks of that text, stored before the message.
      await new UserWikiStore({ scopeId: A, pages: memory, chunk }).writePage(
        P(Array.from({ length: 51 }, () => 'Alice likes tea.').join('\n\n')),
      );
      await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });

      const result = await memory.importFrom(file, { format: 'sqlite' });

      expect(result.errors).toEqual([]);
      expect(await messagesUnder(brain, A, 'Alice likes tea.')).toBe(1);
    });

    /** A brain file that holds one message of alice's, stored long before anything the test stores. */
    const olderMessage = async (): Promise<string> => {
      const source = await openWith({ selfImprove: false });
      await source.memory.remember('Alice keeps a kestrel.', { scope: 'conversation', scopeId: A });
      await source.brain.run('UPDATE memory_traces SET created_at = ? WHERE brain_id = ?', [1_000, source.brain.brainId]);
      const file = path.join(source.dir, 'older.sqlite');
      await source.memory.export(file, { format: 'sqlite' });
      return file;
    };

    it('a message an import brings in while a compile of its scope runs is compiled by the next compile', async () => {
      const file = await olderMessage();
      const { memory } = await openWith({ selfImprove: false });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding = false;
      const prompts = attachRows(memory, {
        llm: async () => {
          if (holding) await gate;
          return 'Merged notes.';
        },
      });
      await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
      await memory.compileWiki();
      await pause(5);
      await memory.remember('Alice has a cat.', { scope: 'conversation', scopeId: A });

      holding = true;
      const compiling = memory.compileWiki();
      for (let i = 0; i < 400 && prompts.length < 2; i += 1) await pause(5);
      expect(prompts).toHaveLength(2);
      const result = await memory.importFrom(file, { format: 'sqlite' });
      expect(result.errors).toEqual([]);
      release();
      await compiling;
      holding = false;
      await memory.compileWiki();

      expect(prompts.slice(2).join('\n')).toContain('Alice keeps a kestrel.');
    });

    it.each<[string, (memory: Memory, brain: Brain, file: string) => Promise<unknown>]>([
      ['an import', (memory, _brain, file) => memory.importFrom(file, { format: 'sqlite' })],
      ['a merge of the brain file', (_memory, brain, file) => brain.importFromSqlite(file, { strategy: 'merge' })],
    ])("a message %s brings in, older than its scope's compile, is compiled by the next compile", async (_case, bringIn) => {
      const file = await olderMessage();
      const { memory, brain } = await openWith({ selfImprove: false });
      const prompts = attachRows(memory);
      await memory.remember('Alice likes tea.', { scope: 'conversation', scopeId: A });
      await memory.compileWiki();
      expect(prompts).toHaveLength(1);

      await bringIn(memory, brain, file);
      await memory.compileWiki();

      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('Alice keeps a kestrel.');
    });

    /** A SQLite export of a brain whose older memory is attributed to alice. */
    const exportedOwner = async (): Promise<string> => {
      const { memory: source, dir } = await openWith({ selfImprove: false });
      await source.remember('old shared words about a heron', { scope: 'persona', scopeId: 'aria-1' });
      await source.setLegacyOwner('aria-1', A);
      const file = path.join(dir, 'export.sqlite');
      await source.export(file, { format: 'sqlite' });
      return file;
    };

    it.each<[string, (memory: Memory, brain: Brain, file: string) => Promise<unknown>]>([
      ['an import', (memory, _brain, file) => memory.importFrom(file, { format: 'sqlite' })],
      ['a merge of the brain file', (_memory, brain, file) => brain.importFromSqlite(file, { strategy: 'merge' })],
      ['a replace from the brain file', (_memory, brain, file) => brain.importFromSqlite(file, { strategy: 'replace' })],
    ])('a SQLite export carries the owner of older memory, and %s brings the owner back', async (_case, bringIn) => {
      const file = await exportedOwner();
      const { memory, brain } = await openWith({ selfImprove: false });

      await bringIn(memory, brain, file);

      expect(await memory.legacyOwner('aria-1')).toBe(A);
    });

    it('a merge keeps the owner this brain records, and a replace keeps none the file lacks', async () => {
      const file = await exportedOwner();
      const kept = await openWith({ selfImprove: false });
      await kept.memory.setLegacyOwner('aria-1', B);
      await kept.memory.importFrom(file, { format: 'sqlite' });
      // An attribution is never moved.
      expect(await kept.memory.legacyOwner('aria-1')).toBe(B);

      const { memory: bare, dir } = await openWith({ selfImprove: false });
      const ownerless = path.join(dir, 'ownerless.sqlite');
      await bare.export(ownerless, { format: 'sqlite' });
      const replaced = await openWith({ selfImprove: false });
      await replaced.memory.setLegacyOwner('aria-1', B);
      await replaced.brain.importFromSqlite(ownerless, { strategy: 'replace' });
      expect(await replaced.memory.legacyOwner('aria-1')).toBeUndefined();
    });
  }
});
