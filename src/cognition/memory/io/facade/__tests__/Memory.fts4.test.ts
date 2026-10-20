/**
 * @fileoverview A brain whose full-text index is SQLite's FTS4: sql.js and the IndexedDB adapter.
 *
 * `@framers/sql-storage-adapter` gives an adapter of kind `sqljs` or `indexeddb` an FTS4 index (their
 * SQLite builds have FTS3 and FTS4 and no FTS5) and every other SQLite adapter FTS5. `Brain.openSqlite`
 * falls back to sql.js when better-sqlite3 is not installed, so a Node host can land on FTS4 as well.
 * These tests open a better-sqlite3 adapter that reports itself as sql.js: its SQLite has FTS4 too, so
 * the brain creates a real FTS4 table and runs the statements a sql.js brain runs.
 *
 * - recall by text reads the FTS4 index;
 * - memory_search finds a trace in it, the best match first, and takes its natural-language fallback
 *   when the engine's error carries no SQLite code, as sql.js's errors do not;
 * - an open repairs an FTS4 index that missed a row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { Memory, type ScoredTrace } from '../Memory.js';
import { MemorySearchTool } from '../../tools/MemorySearchTool.js';
import type { Brain } from '../../../retrieval/store/Brain.js';
import type { ToolExecutionContext } from '../../../../../core/tools/ITool.js';

const dirs: string[] = [];
const memories: Memory[] = [];

afterEach(async () => {
  while (memories.length > 0) await memories.pop()!.close().catch(() => undefined);
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const context: ToolExecutionContext = {
  gmiId: 'test-gmi',
  personaId: 'test-persona',
  userContext: { userId: 'default-user' } as ToolExecutionContext['userContext'],
};

/**
 * A better-sqlite3 adapter that reports itself as sql.js, so the brain's features pick FTS4. With
 * `codeless`, a failed statement throws an Error that carries only its message, as sql.js's do.
 */
async function fts4Adapter(file: string, codeless = false): Promise<StorageAdapter> {
  const raw = await resolveStorageAdapter({ filePath: file, priority: ['better-sqlite3'], quiet: true });
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === 'kind') return 'sqljs';
      const value = Reflect.get(target, prop, receiver);
      if (!codeless || typeof value !== 'function' || !['all', 'get', 'run'].includes(String(prop))) return value;
      return async (...args: unknown[]) => {
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(receiver, args);
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : String(error));
        }
      };
    },
  });
}

async function open(file: string, codeless = false): Promise<Memory> {
  const memory = await Memory.createWithAdapter(await fts4Adapter(file, codeless), {
    brainId: 'fts4-brain',
    graph: false,
    selfImprove: false,
  });
  memories.push(memory);
  return memory;
}

function newFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-fts4-'));
  dirs.push(dir);
  return path.join(dir, 'brain.sqlite');
}

const brainOf = (memory: Memory): Brain => (memory as unknown as { _brain: Brain })._brain;
const idsOf = (results: ScoredTrace[]): string[] => results.map((result) => result.trace.id);
const searchIds = (result: { output?: unknown }): string[] =>
  ((result.output as { results?: Array<{ id: string }> } | undefined)?.results ?? []).map((row) => row.id);

describe('a brain with an FTS4 index (sql.js, IndexedDB)', () => {
  it('creates an FTS4 index and recalls by text from it', async () => {
    const memory = await open(newFile());
    const ddl = await brainOf(memory).get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE name = 'memory_traces_fts'",
    );
    expect(ddl?.sql).toMatch(/USING fts4/i);

    const ferry = await memory.remember('A ferry crossed the bay at dawn');
    await memory.remember('The orchard ladder leans against the barn');
    expect(idsOf(await memory.recall('ferry'))).toEqual([ferry.id]);
  });

  it('finds a trace through memory_search, the best match first', async () => {
    const memory = await open(newFile());
    const once = await memory.remember('A ferry crossed the bay');
    const thrice = await memory.remember('The ferry, the night ferry and the morning ferry');
    await memory.remember('The orchard ladder leans against the barn');

    const result = await new MemorySearchTool(brainOf(memory)).execute({ query: 'ferry' }, context);
    expect(result.success).toBe(true);
    // FTS4 orders by the length of offsets(), which grows with the matches.
    expect(searchIds(result)).toEqual([thrice.id, once.id]);
  });

  it("takes memory_search's natural-language fallback when the engine's error carries no code", async () => {
    const memory = await open(newFile(), true);
    const ferry = await memory.remember('A ferry crossed the bay');
    // An unbalanced quote is a syntax error in a MATCH expression; the converted query finds the word.
    const result = await new MemorySearchTool(brainOf(memory)).execute({ query: 'ferry"' }, context);
    expect(result.success).toBe(true);
    expect(searchIds(result)).toEqual([ferry.id]);
  });

  it('repairs on open an FTS4 index that missed a row', async () => {
    const file = newFile();
    const memory = await open(file);
    const brain = brainOf(memory);
    // A row written straight to the table, which no sync put in the index.
    await brain.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
       VALUES (?, ?, 'episodic', 'user', ?, ?)`,
      [brain.brainId, 'legacy-1', 'The street I grew up on was Thornquay Lane', Date.now()],
    );
    await memories.pop()!.close();

    const reopened = await open(file);
    expect(idsOf(await reopened.recall('Thornquay'))).toEqual(['legacy-1']);
  });
});
