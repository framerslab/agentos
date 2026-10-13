/**
 * @file linkFreeWrite.test.ts
 * The paths below a folder that the link-free read and folder functions take: an absolute path, or one with a `.`
 * or `..` name, is refused before anything is looked at, read or made, and a path below the folder is read. The
 * folder a read names as the one its file must lie below is the folder read below or one on the way to the file,
 * and on Linux a file reached through a folder swapped for a link into a sibling folder is refused.
 */
import * as fs from 'node:fs';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeFoldersOutsideLinks,
  makeFoldersOutsideLinksSync,
  readFileOutsideLinks,
  readFileOutsideLinksSync,
} from '../linkFreeWrite.js';

// The functions are given <base>/root; <base>/secret.txt sits beside it.
let base: string;
let root: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'link-free-names-'));
  root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes', 'a.txt'), 'inside');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'outside');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** Names joined by the platform's separator as written, with no `.` or `..` taken out as `path.join` would. */
function joined(...names: string[]): string {
  return names.join(path.sep);
}

describe('a path below the folder', () => {
  it('is refused when it is absolute or a name in it is . or .., before anything is read or made', async () => {
    const refused = [
      joined('..', 'secret.txt'),
      joined('notes', '..', '..', 'secret.txt'),
      '..',
      joined('.', 'notes', 'a.txt'),
      joined('notes', '.', 'a.txt'),
      // The slash separates names on every platform.
      '../secret.txt',
      path.join(base, 'secret.txt'),
    ];

    for (const relative of refused) {
      await expect(readFileOutsideLinks(root, relative)).rejects.toThrow(TypeError);
      expect(() => readFileOutsideLinksSync(root, relative)).toThrow(TypeError);
      const folders = joined(relative, 'made');
      await expect(makeFoldersOutsideLinks(root, folders)).rejects.toThrow(TypeError);
      expect(() => makeFoldersOutsideLinksSync(root, folders)).toThrow(TypeError);
    }
    // No folder was made above the folder, beside it or in it.
    expect(fs.readdirSync(base).sort()).toEqual(['root', 'secret.txt']);
    expect(fs.readdirSync(root)).toEqual(['notes']);
    expect(fs.readdirSync(path.join(root, 'notes'))).toEqual(['a.txt']);

    // A path whose names are below the folder is read, and its folders made; dots inside a name are no `..`.
    await expect(readFileOutsideLinks(root, joined('notes', 'a.txt'))).resolves.toEqual({ text: 'inside' });
    expect(readFileOutsideLinksSync(root, joined('notes', 'a.txt'))).toEqual({ text: 'inside' });
    expect(readFileOutsideLinksSync(root, joined('notes', '..a.txt'))).toBeNull();
    await expect(makeFoldersOutsideLinks(root, joined('notes', 'deeper'))).resolves.toBe(true);
    expect(makeFoldersOutsideLinksSync(root, joined('notes', 'deeper', 'still'))).toBe(true);
    expect(fs.statSync(path.join(root, 'notes', 'deeper', 'still')).isDirectory()).toBe(true);
  });
});

describe('the folder a read names as the one its file must lie below', () => {
  it('is refused when it is neither the folder read below nor a folder on the way to the file, before anything is read', async () => {
    fs.mkdirSync(path.join(root, 'other'));
    const file = joined('notes', 'a.txt');
    // Above the folder, beside the file's folder, the file itself, and a folder below the file's folder.
    const refused = [base, path.join(root, 'other'), path.join(root, 'notes', 'a.txt'), path.join(root, 'notes', 'x')];

    for (const within of refused) {
      await expect(readFileOutsideLinks(root, file, { within })).rejects.toThrow(TypeError);
      expect(() => readFileOutsideLinksSync(root, file, { within })).toThrow(TypeError);
    }
    // The folder read below and the file's own folder are on the way, and the file is read.
    for (const within of [root, path.join(root, 'notes')]) {
      await expect(readFileOutsideLinks(root, file, { within })).resolves.toEqual({ text: 'inside' });
      expect(readFileOutsideLinksSync(root, file, { within })).toEqual({ text: 'inside' });
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'on Linux, a file reached through a folder swapped for a link into a sibling folder after its look is refused by both reads',
    async () => {
      const notes = path.join(root, 'notes');
      const sibling = path.join(root, 'sibling');
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(sibling, 'a.txt'), 'sibling');
      const opened = path.join(notes, 'a.txt');
      // Just before the file is opened, notes moves aside and a link to the sibling folder takes its place, so the
      // open reaches the sibling's file, which lies below the folder read below but not below notes.
      const swaps: string[] = [];
      const swap = (file: unknown): void => {
        if (String(file) !== opened || fs.lstatSync(notes).isSymbolicLink()) return;
        swaps.push(String(file));
        fs.renameSync(notes, path.join(root, 'notes-before'));
        fs.symlinkSync(sibling, notes, 'dir');
      };
      const realOpen = fsp.open.bind(fsp);
      const open = vi.spyOn(fsp, 'open').mockImplementation((file, flags, mode) => {
        swap(file);
        return realOpen(file, flags, mode);
      });
      const realOpenSync = fsSync.openSync.bind(fsSync);
      const openSync = vi.spyOn(fsSync, 'openSync').mockImplementation((file, flags, mode) => {
        swap(file);
        return realOpenSync(file, flags, mode);
      });

      try {
        await expect(readFileOutsideLinks(root, joined('notes', 'a.txt'), { within: notes })).resolves.toBe('link');
        // notes is a folder again for the synchronous read.
        fs.unlinkSync(notes);
        fs.renameSync(path.join(root, 'notes-before'), notes);
        expect(readFileOutsideLinksSync(root, joined('notes', 'a.txt'), { within: notes })).toBe('link');
      } finally {
        open.mockRestore();
        openSync.mockRestore();
      }
      expect(swaps).toEqual([opened, opened]);
    },
  );
});
