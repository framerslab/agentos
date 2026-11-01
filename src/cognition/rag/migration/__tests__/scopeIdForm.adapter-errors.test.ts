/**
 * @file scopeIdForm.adapter-errors.test.ts
 * The migration adapters' scope-id form reads and clears fail closed. A target's clear of a brain's record that the
 * database refuses (here a trigger, as a locked file or a dropped connection would) fails the call, so the migration
 * reports it rather than copy plain ids under the record; a target with no `brain_meta` table holds no record, and
 * its clear passes. A Qdrant sidecar's read that fails for another reason than a missing `brain_meta` stops the
 * handshake; a missing table reads as no brain.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { QdrantTargetAdapter } from '../adapters/QdrantTargetAdapter.js';
import { SqliteTargetAdapter } from '../adapters/SqliteTargetAdapter.js';
import { sidecarScopeIdForms } from '../adapters/sidecarScopeIdForms.js';
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

    const empty = tempPath('empty.sqlite');
    const db = new Database(empty);
    try {
      expect(await sidecarScopeIdForms(db, ['b'])).toEqual(new Map([['b', { encoded: false, rows: false, reserved: false }]]));
    } finally {
      db.close();
    }
  });
});
