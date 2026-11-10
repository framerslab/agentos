/**
 * @file Memory.conversation-scope.e2e.test.ts
 * The conversation scope on a real store: SQLite on a file, and Postgres when `AGENTOS_TEST_POSTGRES_URL` is set (as
 * CI's Test & Lint job sets it). A scope is registered in `memory_scopes` with its first trace and once only, a trace
 * whose scope id is not a key `conversationScopeKey` built is refused before anything is stored, `recall` and
 * `recentTraces` read one scope by equality on the `scope_id` column (never by the metadata), `deleteScope` takes the
 * scope's registry row with its traces, a scope another writer filed without a row is registered at the next open,
 * and no other scope gets a registry row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../Memory.js';
import type { Brain } from '../../../retrieval/store/Brain.js';
import { PORTABLE_TABLES } from '../../../retrieval/store/portable-tables.js';
import { conversationScopeKey } from '../../../retrieval/store/conversationScopeKey.js';

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
