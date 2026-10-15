import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Atomically replaces one private state file and syncs both its bytes and directory entry. A failure before the rename
 * (a value JSON cannot hold, a full disk, a rename refused) removes the temporary file it made and throws that error,
 * so no copy of the state is left beside the file.
 */
export function writeDurableJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, path);
  } catch (error) {
    // the temporary holds the state and its name is unique, so nothing else would remove it; the first error is the one thrown
    try { unlinkSync(temporary); } catch { /* already gone */ }
    throw error;
  }
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** Removes acknowledged state durably. Missing state is already removed. */
export function removeDurableJson(path: string): void {
  try { unlinkSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return;
  }
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
