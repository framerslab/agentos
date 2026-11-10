/**
 * @file Memory.erasure.e2e.test.ts
 * What the facade does so that a deleted row is gone from the store's file. A SQLite store the library opens from a
 * file path has `secure_delete` on, so the bytes of a deleted row are overwritten; a store on an adapter the host
 * opened keeps the setting the host gave it.
 *
 * `secure_delete` is a setting of a connection, not of the file, so each case reads it through the connection the
 * store itself uses. A real SQLite facade on a file in a folder of the case's own.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';
import { Memory } from '../Memory.js';
import type { Brain } from '../../../retrieval/store/Brain.js';

const dirs: string[] = [];
const memories: Memory[] = [];
afterEach(async () => {
  while (memories.length) await memories.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A new folder of this case's own, removed after it. */
function folder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-erasure-'));
  dirs.push(dir);
  return dir;
}

const brainOf = (memory: Memory): Brain => (memory as unknown as { _brain: Brain })._brain;

/** A facade on a SQLite file the library opens from its path. */
async function facade(): Promise<{ memory: Memory; brain: Brain; file: string; dir: string }> {
  const dir = folder();
  const file = path.join(dir, 'brain.sqlite');
  const memory = await Memory.createSqlite(file, { brainId: 'tools-brain' });
  memories.push(memory);
  return { memory, brain: brainOf(memory), file, dir };
}

/** What `PRAGMA secure_delete` answers on a connection: 0 off, 1 on. */
async function secureDeleteOf(connection: { get<T>(sql: string): Promise<T | null> }): Promise<number> {
  const row = await connection.get<Record<string, number>>('PRAGMA secure_delete');
  return Object.values(row!)[0];
}

describe('secure_delete on a SQLite memory store', () => {
  it('opens a SQLite store from a path with secure_delete on', async () => {
    const { brain } = await facade();
    expect(await secureDeleteOf(brain)).toBe(1);
  });

  it('leaves a store on an adapter the host passed as the host opened it', async () => {
    const adapter = await resolveStorageAdapter({
      filePath: path.join(folder(), 'host.sqlite'),
      priority: ['better-sqlite3'],
      quiet: true,
    });
    const before = await secureDeleteOf(adapter);
    // The driver opens a file with the setting off; the host did not turn it on.
    expect(before).toBe(0);

    const memory = await Memory.createWithAdapter(adapter, { brainId: 'host' });
    memories.push(memory);

    expect(await secureDeleteOf(adapter)).toBe(before);
    expect(await secureDeleteOf(brainOf(memory))).toBe(before);
  });
});
