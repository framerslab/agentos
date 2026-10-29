/**
 * @file Memory.delete-scope.test.ts
 * The facade's deletes and restores, which account deletion and a ledger revert call on the memory tools' Brain:
 * `deleteScope` (all of a scope, or a second user's traces in it), `deleteTraces`, `restoreTrace` (a trace brought
 * back to the state a snapshot holds) and `brainId`. A real SQLite facade.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../Memory.js';
import type { Brain } from '../../../retrieval/store/Brain.js';
import { readTraceSnapshot } from '../../../retrieval/store/tracePersistence.js';

const dirs: string[] = [];
const memories: Memory[] = [];
afterEach(async () => {
  while (memories.length) await memories.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function facade(): Promise<{ memory: Memory; brain: Brain }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-delete-'));
  dirs.push(dir);
  const memory = await Memory.createSqlite(path.join(dir, 'brain.sqlite'), { brainId: 'tools-brain' });
  memories.push(memory);
  return { memory, brain: (memory as unknown as { _brain: Brain })._brain };
}

const contents = async (brain: Brain) =>
  (await brain.all<{ content: string }>('SELECT content FROM memory_traces WHERE deleted = 0 ORDER BY content')).map((r) => r.content);

describe('Memory.deleteScope', () => {
  it("deletes a scope's rows for good and leaves the other scope's", async () => {
    const { memory, brain } = await facade();
    expect(memory.brainId).toBe('tools-brain');
    await memory.remember('Ana keeps bees.', { scope: 'user', scopeId: 'ana' });
    await memory.remember('Ana likes tea.', { scope: 'user', scopeId: 'ana' });
    await memory.remember('Bo plays cello.', { scope: 'user', scopeId: 'bo' });

    expect(await memory.deleteScope('user', 'ana')).toEqual({ deleted: 2 });
    expect(await contents(brain)).toEqual(['Bo plays cello.']);
    expect((await brain.all('SELECT id FROM memory_traces WHERE scope_id = ?', ['ana'])).length).toBe(0);
    expect((await memory.recall('bees')).length).toBe(0);
  });

  it("with turnUserId deletes only that user's traces of the scope", async () => {
    const { memory, brain } = await facade();
    await memory.remember('Owner note.', { scope: 'user', scopeId: '/s-1' });
    await memory.remember('Visitor note.', { scope: 'user', scopeId: '/s-1', metadata: { turnUserId: 'bo' } });
    expect((await memory.recall('Visitor')).map((r) => r.trace.turnUserId)).toEqual(['bo']);

    // An empty user id names no user: refused, so a caller's missing id never widens the delete to the whole scope.
    await expect(memory.deleteScope('user', '/s-1', { turnUserId: '' })).rejects.toThrow(TypeError);
    expect(await memory.deleteScope('user', '/s-1', { turnUserId: 'bo' })).toEqual({ deleted: 1 });
    expect(await contents(brain)).toEqual(['Owner note.']);
  });
});

describe('Memory.deleteTraces and restoreTrace', () => {
  it('deletes named traces, and restores a changed or forgotten trace from its snapshot', async () => {
    const { memory, brain } = await facade();
    const kept = await memory.remember('Ana keeps bees.', { scope: 'user', scopeId: 'ana' });
    const gone = await memory.remember('Ana likes tea.', { scope: 'user', scopeId: 'ana' });
    expect(await memory.deleteTraces([gone.id, 'no-such-id'])).toEqual({ deleted: 1 });

    const before = await readTraceSnapshot(brain, brain.brainId, kept.id);
    expect(before).toMatchObject({ id: kept.id, scope: 'user', scopeId: 'ana', content: 'Ana keeps bees.', deleted: 0 });
    await brain.run(`UPDATE memory_traces SET content = 'changed', scope_id = 'x' WHERE id = ?`, [kept.id]);
    await memory.restoreTrace(kept.id, before!);
    expect(await contents(brain)).toEqual(['Ana keeps bees.']);
    expect((await memory.recall('bees')).map((r) => r.trace.id)).toEqual([kept.id]);

    await memory.forget(kept.id);
    await memory.restoreTrace(kept.id, before!);
    expect(await contents(brain)).toEqual(['Ana keeps bees.']);
    await expect(memory.restoreTrace('other-id', before!)).rejects.toThrow(/snapshot of trace/);
  });
});
