/**
 * @file MigrationEngine.scope-id-form.test.ts
 * The scope-id form handshake of a migration between two SQLite Brain files: a plain source holding a reserved id
 * into a re-filed target of the same brain id is refused before any table is copied, naming the record; a plain
 * source with no reserved id is copied and the target keeps its record; and a source from before `scope_id`
 * existed is copied into a target table that has the column with the column filled from each row's metadata. Where
 * AGENTOS_TEST_POSTGRES_URL is set, the same refusal and the same fill into a Postgres Brain.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MigrationEngine } from '../MigrationEngine.js';
import { Brain } from '../../../memory/retrieval/store/Brain.js';
import { refileBrainScopeIds } from '../../../memory/retrieval/store/scopeIdForm.js';

const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-form-'));
  dirs.push(dir);
  return path.join(dir, name);
}

/** Files rows as a release before the layer did: the scope id in the column and in the metadata JSON. */
async function fileRows(brain: Brain, rows: Array<[string, string, string]>): Promise<void> {
  for (const [id, scope, scopeId] of rows) {
    await brain.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata, scope_id)
       VALUES (?, ?, 'episodic', ?, ?, 1, ?, ?)`,
      [brain.brainId, id, scope, `content of ${id}`, JSON.stringify({ scopeId }), scopeId],
    );
  }
}

async function brainFile(filePath: string, rows: Array<[string, string, string]>, encoded: boolean, brainId = 'b'): Promise<void> {
  const brain = await Brain.openSqlite(filePath, { brainId });
  try {
    if (encoded) await refileBrainScopeIds(brain);
    await fileRows(brain, rows);
  } finally {
    await brain.close();
  }
}

const rowsOf = (filePath: string) => {
  const db = new Database(filePath, { readonly: true });
  try {
    return {
      traces: db.prepare('SELECT id, scope_id FROM memory_traces ORDER BY id').all(),
      record: (db.prepare("SELECT value FROM brain_meta WHERE brain_id = 'b' AND key = 'scope_id_form'").get() as { value: string } | undefined)?.value,
    };
  } finally {
    db.close();
  }
};

/** A SQLite file with the tables of a release before `memory_traces.scope_id`, holding one row of `brainId`. */
function fileBeforeScopeIds(filePath: string, brainId: string): void {
  const src = new Database(filePath);
  src.exec(`
    CREATE TABLE brain_meta (brain_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (brain_id, key));
    CREATE TABLE memory_traces (
      brain_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, scope TEXT NOT NULL, content TEXT NOT NULL,
      embedding BLOB, strength REAL NOT NULL DEFAULT 1.0, created_at INTEGER NOT NULL, last_accessed INTEGER,
      retrieval_count INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]', emotions TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (brain_id, id));
  `);
  src.prepare(`INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata) VALUES (?, 't-old', 'episodic', 'user', 'old', 1, ?)`)
    .run(brainId, JSON.stringify({ scopeId: 'ana' }));
  src.close();
}

describe('MigrationEngine scope-id form handshake', () => {
  it('refuses a plain source holding a reserved id into a re-filed target of the same brain id, before any table', async () => {
    const from = tempPath('source.sqlite');
    const to = tempPath('target.sqlite');
    await brainFile(from, [['t-a', 'user', 'team/ana']], false);
    await brainFile(to, [['t-t', 'user', 'ana']], true);

    const result = await MigrationEngine.migrate({ from: { type: 'sqlite', path: from }, to: { type: 'sqlite', path: to } });

    expect(result.verified).toBe(false);
    expect(result.tablesProcessed).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/scope_id_form/);
    expect(rowsOf(to)).toEqual({ traces: [{ id: 't-t', scope_id: 'ana' }], record: 'encoded' });
  });

  it('copies a plain source with no reserved id into a re-filed target, which keeps its record', async () => {
    const from = tempPath('source.sqlite');
    const to = tempPath('target.sqlite');
    await brainFile(from, [['t-a', 'user', 'ana']], false);
    await brainFile(to, [['t-t', 'user', 'bo']], true);

    const result = await MigrationEngine.migrate({ from: { type: 'sqlite', path: from }, to: { type: 'sqlite', path: to } });

    expect(result.errors).toEqual([]);
    expect(rowsOf(to)).toEqual({ traces: [{ id: 't-a', scope_id: 'ana' }, { id: 't-t', scope_id: 'bo' }], record: 'encoded' });
  });

  it("fills scope_id from the metadata of a source row that has none, where the target's table has the column", async () => {
    const from = tempPath('source.sqlite');
    fileBeforeScopeIds(from, 'b');
    const to = tempPath('target.sqlite');
    await brainFile(to, [], false);

    const result = await MigrationEngine.migrate({ from: { type: 'sqlite', path: from }, to: { type: 'sqlite', path: to } });

    expect(result.errors).toEqual([]);
    expect(rowsOf(to).traces).toEqual([{ id: 't-old', scope_id: 'ana' }]);
  });
});

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const describeIfPostgres = POSTGRES_URL ? describe : describe.skip;

describeIfPostgres('MigrationEngine scope-id form handshake into Postgres', () => {
  /** A Postgres Brain of a brain id of its own, whose rows are removed after the case. */
  async function postgresBrain(): Promise<Brain> {
    const brainId = `test-migrate-form-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const brain = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    cleanups.push(async () => {
      for (const table of ['memory_traces', 'brain_meta']) {
        await brain.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brainId]);
      }
      await brain.close();
    });
    return brain;
  }

  const tracesOf = async (brain: Brain) =>
    brain.all<{ id: string; scope_id: string }>('SELECT id, scope_id FROM memory_traces WHERE brain_id = ? ORDER BY id', [
      brain.brainId,
    ]);

  it('refuses a plain source holding a reserved id into a re-filed Postgres brain of the same id', async () => {
    const target = await postgresBrain();
    await refileBrainScopeIds(target);
    await fileRows(target, [['t-t', 'user', 'ana']]);
    const from = tempPath('source.sqlite');
    await brainFile(from, [['t-a', 'user', 'team/ana']], false, target.brainId);

    const result = await MigrationEngine.migrate({
      from: { type: 'sqlite', path: from },
      to: { type: 'postgres', connectionString: POSTGRES_URL! },
    });

    expect(result.verified).toBe(false);
    expect(result.tablesProcessed).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/scope_id_form/);
    expect(await tracesOf(target)).toEqual([{ id: 't-t', scope_id: 'ana' }]);
    expect(await target.getMeta('scope_id_form')).toBe('encoded');
  });

  it('fills scope_id in a Postgres brain from the metadata of a source row that has none', async () => {
    const target = await postgresBrain();
    const from = tempPath('source.sqlite');
    fileBeforeScopeIds(from, target.brainId);

    const result = await MigrationEngine.migrate({
      from: { type: 'sqlite', path: from },
      to: { type: 'postgres', connectionString: POSTGRES_URL! },
    });

    expect(result.errors).toEqual([]);
    expect(await tracesOf(target)).toEqual([{ id: 't-old', scope_id: 'ana' }]);
  });
});
