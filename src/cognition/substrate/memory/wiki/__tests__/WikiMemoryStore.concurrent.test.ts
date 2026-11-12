/**
 * Two wiki stores over one memory/ folder, as two agents on one workspace, writing pages at once. Writing a file in
 * place empties it when it is opened and fills it after, so a store that reads index.md in between finds no text
 * migrated from MEMORY.md. The file system is the real one: only a write of a file named index.md through
 * fs/promises' writeFile is held, after it has emptied the file as its open does, until the test lets it finish.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const held = vi.hoisted(() => ({ on: false, writes: [] as Array<() => void> }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const { basename } = await import('node:path');
  const writeFile = (async (file: unknown, data: unknown, options?: unknown) => {
    if (held.on && typeof file === 'string' && basename(file) === 'index.md') {
      await real.writeFile(file, '');
      await new Promise<void>((resolve) => held.writes.push(resolve));
    }
    return real.writeFile(file as never, data as never, options as never);
  }) as typeof real.writeFile;
  return { ...real, writeFile, default: { ...real, writeFile } };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WikiMemoryStore } from '../WikiMemoryStore.js';
import { ensureMemoryDir } from '../migrateMemoryMd.js';

const noopPort = {
  remember: async () => ({ id: 'x' }),
  forget: async () => {},
  deleteTraces: async () => ({ deleted: 0 }),
  chunk: (t: string) => [{ text: t }],
};
const page = (id: string, summary: string) => ({ id, type: 'concept' as const, summary, updated: '', sources: [], body: 'b', links: [] });

let dir: string;
let memoryDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wikistore-concurrent-'));
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'The user prefers concise answers.\n');
  memoryDir = ensureMemoryDir(dir);
});
afterEach(() => {
  held.on = false;
  for (const finish of held.writes.splice(0)) finish();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('WikiMemoryStore index.md written by two stores at once', () => {
  it('keeps the text migrated from MEMORY.md when one store reads the index while the other writes it', async () => {
    const first = new WikiMemoryStore({ memoryDir, port: noopPort, agentId: 'a1' });
    const second = new WikiMemoryStore({ memoryDir, port: noopPort, agentId: 'a1' });
    held.on = true;

    let firstDone = false;
    const firstWrite = first.writePage(page('concepts/billing', 'How billing works.')).then(() => {
      firstDone = true;
    });
    // The first store is writing index.md, or has written it when it does not write the file in place.
    await vi.waitFor(() => expect(held.writes.length === 1 || firstDone).toBe(true));

    let secondDone = false;
    const secondWrite = second.writePage(page('concepts/tone', 'How to talk.')).then(() => {
      secondDone = true;
    });
    await vi.waitFor(() => expect(held.writes.length === 2 || secondDone).toBe(true));

    // The first write finishes, then the second.
    held.writes.shift()?.();
    await firstWrite;
    held.writes.shift()?.();
    await secondWrite;

    const index = fs.readFileSync(path.join(memoryDir, 'index.md'), 'utf8');
    expect(index).toContain('The user prefers concise answers.');
    expect(index).toContain('[tone](concepts/tone.md)');
    expect(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8')).toBe('The user prefers concise answers.\n');
  });
});
