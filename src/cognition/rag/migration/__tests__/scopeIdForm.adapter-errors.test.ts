/**
 * @file scopeIdForm.adapter-errors.test.ts
 * The migration adapters' scope-id form reads and clears fail closed. A target's clear of a brain's record that the
 * database refuses (here a trigger, as a locked file or a dropped connection would) fails the call, so the migration
 * reports it rather than copy plain ids under the record; a target with no `brain_meta` table holds no record, and
 * its clear passes. A Qdrant sidecar's read that fails for another reason than a missing `brain_meta` stops the
 * handshake, whether it names the brains or lists them; a missing table reads as no brain. The reads every SQLite and
 * PostgreSQL adapter runs (a brain's record and rows, the list of brains a store holds) fail the same way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { QdrantTargetAdapter } from '../adapters/QdrantTargetAdapter.js';
import { SqliteTargetAdapter } from '../adapters/SqliteTargetAdapter.js';
import { sidecarScopeIdForms } from '../adapters/sidecarScopeIdForms.js';
import { ABSENT_BRAIN, readBrainScopeIdForm, readScopeIdForms, type ScopeIdFormReader } from '../../../memory/retrieval/store/scopeIdForm.js';
import { isMissingTableError } from '../../../memory/retrieval/store/missingTable.js';
import type { IMigrationTarget } from '../types.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-errors-'));
  dirs.push(dir);
  return path.join(dir, name);
}

/** A SQLite file whose `brain_meta` holds brain `b`'s record and refuses every delete. */
function lockedRecord(filePath: string): void {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE brain_meta (brain_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (brain_id, key));
    INSERT INTO brain_meta VALUES ('b', 'scope_id_form', 'encoded');
    CREATE TRIGGER keep_record BEFORE DELETE ON brain_meta BEGIN SELECT RAISE(ABORT, 'brain_meta is locked'); END;
  `);
  db.close();
}

function recordOf(filePath: string): unknown {
  const db = new Database(filePath, { readonly: true });
  try {
    return db.prepare("SELECT value FROM brain_meta WHERE brain_id = 'b' AND key = 'scope_id_form'").get();
  } finally {
    db.close();
  }
}

describe("a target's clear of a brain's scope-id form record", () => {
  it.each([
    ['a Qdrant target with a sidecar', (file: string): IMigrationTarget => new QdrantTargetAdapter('http://127.0.0.1:1', undefined, file)],
    ['a SQLite target', (file: string): IMigrationTarget => new SqliteTargetAdapter(file)],
  ])('on %s fails when the database refuses the delete, and passes where brain_meta does not exist', async (_name, open) => {
    const locked = tempPath('locked.sqlite');
    lockedRecord(locked);
    const target = open(locked);
    try {
      await expect(target.clearScopeIdForm!('b')).rejects.toThrow(/brain_meta is locked/);
    } finally {
      await target.close();
    }
    expect(recordOf(locked)).toEqual({ value: 'encoded' });

    const empty = tempPath('empty.sqlite');
    new Database(empty).close();
    const bare = open(empty);
    try {
      await expect(bare.clearScopeIdForm!('b')).resolves.toBeUndefined();
    } finally {
      await bare.close();
    }
  });
});

describe("a Qdrant sidecar's brains", () => {
  it('stop the handshake on a brain_meta read that fails for another reason than a missing table, and a missing table holds no brain', async () => {
    const busy = (): never => {
      throw new Error('database is locked');
    };
    const failing = { prepare: () => ({ get: busy, all: busy }) } as unknown as Database.Database;
    await expect(sidecarScopeIdForms(failing, ['b'])).rejects.toThrow(/database is locked/);
    // A Qdrant source lists the brains its sidecar names: a list that fails stops the handshake too.
    await expect(sidecarScopeIdForms(failing)).rejects.toThrow(/database is locked/);

    const empty = tempPath('empty.sqlite');
    const db = new Database(empty);
    try {
      expect(await sidecarScopeIdForms(db, ['b'])).toEqual(new Map([['b', { encoded: false, rows: false, reserved: false }]]));
    } finally {
      db.close();
    }
  });
});

describe("the scope-id form reads of a SQLite or PostgreSQL store", () => {
  /** A reader whose statements fail as a locked file or a dropped connection does, except those `passes` lets through. */
  const failingReader = (passes: (sql: string) => boolean = () => false): ScopeIdFormReader => {
    const fail = (): never => {
      throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' });
    };
    return {
      get: async <T>(sql: string): Promise<T | undefined> => (passes(sql) ? undefined : fail()),
      all: async <T>(sql: string): Promise<T[]> => (passes(sql) ? [] : fail()),
    };
  };

  it("fail on a brain's record or rows that cannot be read, rather than read as a brain without the record", async () => {
    await expect(readBrainScopeIdForm(failingReader(), 'b')).rejects.toThrow(/Connection terminated/);
    // The record reads, and the rows do not.
    await expect(readBrainScopeIdForm(failingReader((sql) => sql.includes('brain_meta')), 'b')).rejects.toThrow(/Connection terminated/);
    await expect(readScopeIdForms(failingReader(), ['b'])).rejects.toThrow(/Connection terminated/);
  });

  it('fail on a list of the brains a store holds that cannot be read, rather than list none', async () => {
    await expect(readScopeIdForms(failingReader())).rejects.toThrow(/Connection terminated/);
    // A database that is gone says "does not exist" too, of the database: that is no missing table.
    const gone = (): never => {
      throw Object.assign(new Error('database "brains" does not exist'), { code: '3D000' });
    };
    await expect(readScopeIdForms({ get: async () => gone(), all: async () => gone() })).rejects.toThrow(/database "brains"/);
  });

  it("fail on a trace scan that fails for another reason than a table without scope_id, rather than read the metadata alone", async () => {
    let scans = 0;
    const reader: ScopeIdFormReader = {
      get: async <T>(sql: string): Promise<T | undefined> => (sql.includes('memory_traces') ? ({ id: 't-a' } as T) : undefined),
      all: async <T>(sql: string): Promise<T[]> => {
        if (!sql.includes('memory_traces')) return [];
        scans += 1;
        // The first scan reads scope_id and fails once on the connection; the column exists.
        if (scans === 1) throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' });
        return [{ id: 't-a', scope: 'user', metadata: '{}' }] as T[];
      },
    };
    await expect(readBrainScopeIdForm(reader, 'b')).rejects.toThrow(/Connection terminated/);
  });

  it('read a store without the tables, or from before brain ids, as holding no brain', async () => {
    const empty = tempPath('empty.sqlite');
    const db = new Database(empty);
    db.exec('CREATE TABLE memory_traces (id TEXT PRIMARY KEY, scope TEXT, content TEXT)');
    const reader: ScopeIdFormReader = {
      get: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
      all: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
    };
    try {
      expect(await readScopeIdForms(reader)).toEqual(new Map());
      expect(await readBrainScopeIdForm(reader, 'b')).toEqual(ABSENT_BRAIN);
    } finally {
      db.close();
    }
  });
});

describe('a missing table or column, as the scope-id form reads tell it apart', () => {
  it.each([
    ['SQLite, a table', Object.assign(new Error('no such table: brain_meta'), { code: 'SQLITE_ERROR' })],
    ['SQLite, a column', Object.assign(new Error('no such column: brain_id'), { code: 'SQLITE_ERROR' })],
    ['sql.js, a table', new Error('no such table: knowledge_nodes')],
    ['PostgreSQL, a relation', Object.assign(new Error('relation "brain_meta" does not exist'), { code: '42P01' })],
    ['PostgreSQL, a column', Object.assign(new Error('column "brain_id" does not exist'), { code: '42703' })],
    ['PostgreSQL through an adapter that drops the code', new Error('relation "knowledge_nodes" does not exist')],
  ])('is %s', (_name, error) => {
    expect(isMissingTableError(error)).toBe(true);
  });

  it.each([
    ['a database that is gone', Object.assign(new Error('database "brains" does not exist'), { code: '3D000' })],
    ['a role that is gone', Object.assign(new Error('role "agent" does not exist'), { code: '28000' })],
    ['a connection that is gone', new Error('connection does not exist')],
    ['a locked file', Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })],
    ['a PostgreSQL code that names something else, whatever its words', Object.assign(new Error('relation "brain_meta" does not exist'), { code: '57P01' })],
  ])('is not %s', (_name, error) => {
    expect(isMissingTableError(error)).toBe(false);
  });
});
