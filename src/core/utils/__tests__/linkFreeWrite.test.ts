/**
 * @file linkFreeWrite.test.ts
 * The paths below a folder that the link-free read and folder functions take: an absolute path, or one with a `.`
 * or `..` name, is refused before anything is looked at, read or made, and a path below the folder is read.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
