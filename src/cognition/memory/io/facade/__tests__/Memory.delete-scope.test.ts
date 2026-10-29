/**
 * @file Memory.delete-scope.test.ts
 * The facade's deletes and restores, which account deletion and a ledger revert call on the memory tools' Brain:
 * `deleteScope` (all of a scope, or a second user's traces in it), `deleteTraces`, `restoreTrace` (a trace brought
 * back to the state a snapshot holds, its vector kept where its content is) and `brainId`. A delete takes the rows that
 * name a trace (its feedback, the chunk it was filed from) and its memory-graph node and edges, whichever facade on
 * the Brain wrote them; a second user's words stay a trace of their own beside the same words of the session's owner.
 * `deleteScope` finds the rows a release older than the `scope_id` column wrote under the scope after the facade
 * opened, and refuses an empty scope id. A real SQLite facade, and on Postgres (when `AGENTOS_TEST_POSTGRES_URL` is
 * set, as CI's Test & Lint job sets it) a restore re-indexes the restored row alone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../Memory.js';
import type { Brain } from '../../../retrieval/store/Brain.js';
import { PORTABLE_TABLES } from '../../../retrieval/store/portable-tables.js';
import { readTraceSnapshot } from '../../../retrieval/store/tracePersistence.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;

const dirs: string[] = [];
const memories: Memory[] = [];
afterEach(async () => {
  while (memories.length) {
    const memory = memories.pop()!;
    const brain = (memory as unknown as { _brain: Brain })._brain;
    if (brain.features.dialect.name === 'postgres') {
      // The Postgres database outlives the test: remove this brain's rows, children before parents.
      for (const table of [...PORTABLE_TABLES].reverse()) {
        await brain.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brain.brainId]).catch(() => undefined);
      }
    }
    await memory.close();
  }
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function facade(): Promise<{ memory: Memory; brain: Brain; file: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-delete-'));
  dirs.push(dir);
  const file = path.join(dir, 'brain.sqlite');
  const memory = await Memory.createSqlite(file, { brainId: 'tools-brain' });
  memories.push(memory);
  return { memory, brain: (memory as unknown as { _brain: Brain })._brain, file };
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

  it('deletes the rows a release older than the scope_id column wrote under the scope after the facade opened', async () => {
    const { memory, brain } = await facade();
    await memory.remember('Ana keeps bees.', { scope: 'user', scopeId: 'ana' });
    await memory.remember('Bo plays cello.', { scope: 'user', scopeId: 'bo' });
    // Such a release names the scope id in the metadata alone, and the column keeps its default.
    await brain.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, strength, created_at, tags, emotions, metadata, deleted)
       VALUES (?, 'older-1', 'episodic', 'user', 'Ana likes tea.', 1, ?, '[]', '{}', ?, 0)`,
      [brain.brainId, Date.now(), JSON.stringify({ scopeId: 'ana' })],
    );

    expect(await memory.deleteScope('user', 'ana')).toEqual({ deleted: 2 });
    expect(await contents(brain)).toEqual(['Bo plays cello.']);
  });

  it('refuses an empty scope id, so a missing id never deletes the traces filed under none', async () => {
    const { memory, brain } = await facade();
    await memory.remember('A note filed under no scope id.', { scope: 'user' });

    await expect(memory.deleteScope('user', '')).rejects.toThrow(TypeError);

    expect(await contents(brain)).toEqual(['A note filed under no scope id.']);
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

  it("keeps a second user's words a trace of their own beside the same words of the session's owner", async () => {
    const { memory, brain } = await facade();
    const visitor = await memory.remember('Same words.', { scope: 'user', scopeId: '/s-1', metadata: { turnUserId: 'bo' } });
    const owner = await memory.remember('Same words.', { scope: 'user', scopeId: '/s-1' });
    expect(owner.id).not.toBe(visitor.id);
    expect(owner.turnUserId).toBeUndefined();
    const again = await memory.remember('Same words.', { scope: 'user', scopeId: '/s-1', metadata: { turnUserId: 'bo' } });
    expect(again.id).toBe(visitor.id);

    expect(await memory.deleteScope('user', '/s-1', { turnUserId: 'bo' })).toEqual({ deleted: 1 });
    expect(await contents(brain)).toEqual(['Same words.']);
    expect((await memory.recall('words')).map((r) => r.trace.id)).toEqual([owner.id]);
  });
});

describe('Memory.deleteTraces with rows that name a trace', () => {
  it('deletes a trace that a feedback row or a document chunk names, and keeps the chunk', async () => {
    const { memory, brain } = await facade();
    const bees = await memory.remember('Ana keeps bees.', { scope: 'user', scopeId: 'ana' });
    const tea = await memory.remember('Ana likes tea.', { scope: 'user', scopeId: 'ana' });
    const cello = await memory.remember('Bo plays cello.', { scope: 'user', scopeId: 'bo' });
    await memory.feedback(bees.id, 'used', 'what does Ana keep');
    await memory.feedback(cello.id, 'used', 'what does Bo play');
    expect((await brain.all('SELECT trace_id FROM retrieval_feedback')).length).toBe(2);
    await brain.run(
      `INSERT INTO documents (brain_id, id, path, format, content_hash, ingested_at) VALUES (?, 'doc-1', 'notes.md', 'md', 'hash', ?)`,
      [brain.brainId, Date.now()],
    );
    await brain.run(
      `INSERT INTO document_chunks (brain_id, id, document_id, trace_id, content, chunk_index) VALUES (?, 'chunk-1', 'doc-1', ?, 'Ana likes tea.', 0)`,
      [brain.brainId, tea.id],
    );

    expect(await memory.deleteTraces([bees.id])).toEqual({ deleted: 1 });
    expect(await memory.deleteScope('user', 'ana')).toEqual({ deleted: 1 });

    expect(await contents(brain)).toEqual(['Bo plays cello.']);
    expect(await brain.all('SELECT trace_id FROM retrieval_feedback')).toEqual([{ trace_id: cello.id }]);
    expect(await brain.all('SELECT id, trace_id, content FROM document_chunks')).toEqual([
      { id: 'chunk-1', trace_id: null, content: 'Ana likes tea.' },
    ]);
  });

  it('deletes the memory-graph node and edges of a trace when another facade on the Brain wrote the edge', async () => {
    const { memory: writer, brain, file } = await facade();
    // Opened before the edge exists, as a second facade of the runtime or another process is.
    const deleter = await Memory.createSqlite(file, { brainId: 'tools-brain' });
    memories.push(deleter);
    const bees = await writer.remember('Ana keeps bees.', { scope: 'user', scopeId: 'ana' });
    const tea = await writer.remember('Ana likes tea.', { scope: 'user', scopeId: 'ana' });
    await (writer as unknown as { _memoryGraph: { recordCoActivation(ids: string[]): Promise<void> } })._memoryGraph.recordCoActivation([bees.id, tea.id]);
    expect((await brain.all('SELECT id FROM knowledge_edges')).length).toBe(1);

    expect(await deleter.deleteScope('user', 'ana')).toEqual({ deleted: 2 });

    expect(await brain.all('SELECT id FROM knowledge_nodes WHERE id IN (?, ?)', [bees.id, tea.id])).toEqual([]);
    expect(await brain.all('SELECT id FROM knowledge_edges')).toEqual([]);
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

  it("keeps the vector of a trace it restores to the content its row holds, and drops it for other content", async () => {
    const { memory, brain } = await facade();
    const kept = await memory.remember('Ana keeps bees.', { scope: 'user', scopeId: 'ana' });
    const vector = Buffer.from(Float32Array.from([1, 0, 0, 0]).buffer);
    await brain.run('UPDATE memory_traces SET embedding = ? WHERE brain_id = ? AND id = ?', [vector, brain.brainId, kept.id]);
    const before = (await readTraceSnapshot(brain, brain.brainId, kept.id))!;
    const embeddingOf = async () => {
      const row = await brain.get<{ embedding: Uint8Array | null }>('SELECT embedding FROM memory_traces WHERE id = ?', [kept.id]);
      return row?.embedding ? Buffer.from(row.embedding) : null;
    };

    // A reverted delete: the content is the snapshot's, so the vector still holds it.
    await memory.forget(kept.id);
    await memory.restoreTrace(kept.id, before);
    expect(await embeddingOf()).toEqual(vector);

    // A reverted update: the row holds other content, whose vector is not the snapshot's.
    await brain.run(`UPDATE memory_traces SET content = 'changed' WHERE id = ?`, [kept.id]);
    await memory.restoreTrace(kept.id, before);
    expect(await embeddingOf()).toBeNull();
    expect(await contents(brain)).toEqual(['Ana keeps bees.']);
  });
});

describe('Memory.restoreTrace on Postgres', () => {
  it.skipIf(!POSTGRES_URL)('re-indexes the restored row alone, which is found by the words it holds again', async () => {
    const memory = await Memory.createPostgres(POSTGRES_URL!, {
      brainId: `delete-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      poolSize: 2,
      graph: false,
      selfImprove: false,
    });
    memories.push(memory);
    const brain = (memory as unknown as { _brain: Brain })._brain;
    const kept = await memory.remember('The street I grew up on was Thornquay Lane.', { scope: 'user', scopeId: 'ana' });
    const other = await memory.remember('Bo plays cello.', { scope: 'user', scopeId: 'bo' });
    const before = (await readTraceSnapshot(brain, brain.brainId, kept.id))!;
    // An update the restore takes back: the row and its full-text column hold other words.
    await brain.run(
      `UPDATE memory_traces SET content = 'My childhood parakeet was named Silverpip.' WHERE brain_id = ? AND id = ?`,
      [brain.brainId, kept.id],
    );
    const rebuild = brain.fullTextRebuild();
    await brain.run(`${rebuild.sql} AND id = ?`, [...rebuild.params, kept.id]);
    // The other trace's full-text column carries a marker; a restore of one trace leaves it as it is.
    await brain.run(`UPDATE memory_traces SET _tsv = to_tsvector('simple', 'untouched') WHERE brain_id = ? AND id = ?`, [
      brain.brainId,
      other.id,
    ]);

    await memory.restoreTrace(kept.id, before);

    expect((await memory.recall('Thornquay')).map((result) => result.trace.id)).toEqual([kept.id]);
    expect(await memory.recall('Silverpip')).toEqual([]);
    const marked = await brain.get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM memory_traces WHERE brain_id = ? AND id = ? AND _tsv = to_tsvector('simple', 'untouched')`,
      [brain.brainId, other.id],
    );
    expect(Number(marked?.n)).toBe(1);
  });
});
