/**
 * @file pathName.test.ts
 * The rule for a file or folder name built from data, and the check that a path built from such names lies
 * inside its folder: the edge cases of each, on POSIX and Windows paths.
 */
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_PATH_NAME_BYTES, pathNameProblem, resolveInsideFolder, type PathNameProblem } from '../pathName.js';

describe('pathNameProblem', () => {
  const accepted: Array<[string, string]> = [
    ['a scope', 'user'],
    ['a memory type', 'episodic'],
    ['a trace id', 'mt_0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['spaces, capitals and a letter outside ASCII inside a name', 'Ana L\u00f3pez notes'],
    ['dots inside a name', 'v1..v2'],
    ['percent-encoded dots, which no file system decodes', '%2e%2e'],
    ['fullwidth dots, which are not dots', '\uff0e\uff0e'],
    ['a name at the byte limit', 'x'.repeat(MAX_PATH_NAME_BYTES)],
    ['two-byte letters at the byte limit', '\u00e9'.repeat(MAX_PATH_NAME_BYTES / 2)],
    ['four-byte characters at the byte limit', '\u{1F600}'.repeat(MAX_PATH_NAME_BYTES / 4)],
  ];

  it.each(accepted)('accepts %s', (_label, name) => {
    expect(pathNameProblem(name)).toBeNull();
  });

  const refused: Array<[string, string, PathNameProblem]> = [
    ['an empty name', '', 'empty'],
    ['the current folder', '.', 'dot'],
    ['the parent folder', '..', 'dot'],
    ['a hidden name', '.meta', 'dot'],
    ['a parent folder and a name', '../escaped', 'character'],
    ['a slash', 'a/b', 'character'],
    ['a backslash', 'a\\b', 'character'],
    ['a parent folder written with a backslash', '..\\escaped', 'character'],
    ['a Windows drive', 'C:', 'character'],
    ['a Windows file stream', 'notes:stream', 'character'],
    ['a NUL byte', 'a\u0000b', 'character'],
    ['a line break', 'a\nb', 'character'],
    ['a delete character', 'a\u007fb', 'character'],
    ['a leading space', ' user', 'edge'],
    ['a trailing space', 'user ', 'edge'],
    ['a trailing dot', 'user.', 'edge'],
    ['a name one byte past the limit', 'x'.repeat(MAX_PATH_NAME_BYTES + 1), 'length'],
    ['two-byte letters past the byte limit but not the character count', '\u00e9'.repeat(MAX_PATH_NAME_BYTES / 2 + 1), 'length'],
    ['four-byte characters past the byte limit', '\u{1F600}'.repeat(MAX_PATH_NAME_BYTES / 4 + 1), 'length'],
    ['a very long name', 'x'.repeat(100_000), 'length'],
  ];

  it.each(refused)('refuses %s', (_label, name, problem) => {
    expect(pathNameProblem(name)).toBe(problem);
  });
});

describe('resolveInsideFolder', () => {
  it('resolves names to a path inside the folder', () => {
    expect(resolveInsideFolder('/srv/out', ['user', 'episodic', 'mt_1.md'], path.posix)).toBe(
      '/srv/out/user/episodic/mt_1.md',
    );
    expect(resolveInsideFolder('/srv/out/', ['entities/johnny.md'], path.posix)).toBe('/srv/out/entities/johnny.md');
    expect(resolveInsideFolder('/', ['page.md'], path.posix)).toBe('/page.md');
    expect(resolveInsideFolder('C:\\out', ['user', 'mt_1.md'], path.win32)).toBe('C:\\out\\user\\mt_1.md');
  });

  it('answers null for a path outside the folder, or the folder itself', () => {
    const outside: Array<[string, string[], path.PlatformPath]> = [
      ['/srv/out', ['user', 'episodic', '../../../escaped.md'], path.posix],
      ['/srv/out', ['../../elsewhere', 'episodic', 'mt_1.md'], path.posix],
      ['/srv/out', ['/etc/passwd'], path.posix],
      // A sibling folder whose name starts with the folder's own.
      ['/srv/out', ['../out-old/mt_1.md'], path.posix],
      ['/srv/out', ['.'], path.posix],
      ['/srv/out', [], path.posix],
      ['C:\\out', ['..\\escaped.md'], path.win32],
      ['C:\\out', ['D:escaped.md'], path.win32],
      ['C:\\out', ['\\\\server\\share\\escaped.md'], path.win32],
    ];
    for (const [root, relative, paths] of outside) {
      expect(resolveInsideFolder(root, relative, paths), `${root} + ${relative.join(' + ')}`).toBeNull();
    }
  });
});
