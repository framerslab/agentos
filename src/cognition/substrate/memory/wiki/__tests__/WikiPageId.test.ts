import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  InvalidWikiPageIdError,
  MAX_WIKI_PAGE_ID_LENGTH,
  assertWikiPageId,
  isWikiPageId,
  resolveWikiPagePath,
  type WikiPageIdProblem,
} from '../WikiPageId.js';

/** The problem assertWikiPageId names for `id`, or null when it accepts the id. */
function problemOf(id: unknown): WikiPageIdProblem | null {
  try {
    assertWikiPageId(id);
    return null;
  } catch (err) {
    if (err instanceof InvalidWikiPageIdError) return err.problem;
    throw err;
  }
}

/** The error resolveWikiPagePath throws for `id`, or null when it resolves. */
function refusalOf(run: () => string): InvalidWikiPageIdError | null {
  try {
    run();
    return null;
  } catch (err) {
    if (err instanceof InvalidWikiPageIdError) return err;
    throw err;
  }
}

describe('wiki page id rule', () => {
  const accepted: Array<[string, string]> = [
    ['a plain name', 'ok-id'],
    ['a nested page', 'a/b'],
    ['an entity page as the compiler writes it', 'entities/johnny'],
    ['a log page', 'log/2026-10-12'],
    ['a page named index in a folder', 'entities/index'],
    ['a name with spaces, capitals and a letter outside ASCII', 'people/Ana L\u00f3pez'],
    ['dots inside a name', 'notes/v1..v2'],
    ['an id at the length limit', ['x'.repeat(170), 'x'.repeat(170), 'x'.repeat(170)].join('/')],
    ['a name at the byte limit', `concepts/${'x'.repeat(200)}`],
    ['two-byte letters at the byte limit', `people/${'\u00e9'.repeat(100)}`],
  ];

  it.each(accepted)('accepts %s', (_label, id) => {
    expect(problemOf(id)).toBeNull();
    expect(isWikiPageId(id)).toBe(true);
  });

  const refused: Array<[string, unknown, WikiPageIdProblem]> = [
    ['a parent folder', '../x', 'dot'],
    ['a parent folder after a name', 'a/../../b', 'dot'],
    ['a parent folder alone', '..', 'dot'],
    ['the current folder', './a', 'dot'],
    ['a hidden file', '.hidden', 'dot'],
    ['a hidden folder', 'notes/.meta/index', 'dot'],
    ['a name opening with a space', ' index', 'edge'],
    ['a folder name closing with a space', 'entities /johnny', 'edge'],
    ['a name closing with a space', 'johnny ', 'edge'],
    ['a folder name closing with a dot', 'entities./johnny', 'edge'],
    ['a name closing with a dot', 'v1.', 'edge'],
    ['the catalog, index.md', 'index', 'reserved'],
    ['the catalog in capitals', 'INDEX', 'reserved'],
    ['the catalog in mixed case', 'Index', 'reserved'],
    ['a backslash', 'a\\b', 'character'],
    ['a parent folder written with a backslash', '..\\x', 'character'],
    ['another drive on Windows', 'D:notes', 'character'],
    ['the same drive on Windows', 'C:page', 'character'],
    ['a file stream on Windows', 'page:stream', 'character'],
    ['an empty string', '', 'empty'],
    ['a NUL byte', 'page\u0000.txt', 'character'],
    ['a line break', 'a\nb', 'character'],
    ['a delete character', 'a\u007fb', 'character'],
    ['a leading slash', '/etc/x', 'segment'],
    ['a doubled slash', 'a//b', 'segment'],
    ['a trailing slash', 'a/', 'segment'],
    ['an id one character past the limit', 'x'.repeat(MAX_WIKI_PAGE_ID_LENGTH + 1), 'length'],
    ['a very long id', 'a/'.repeat(50_000) + 'b', 'length'],
    ['a name longer than a file system takes', `concepts/${'x'.repeat(300)}`, 'length'],
    ['a name one byte past the limit', `concepts/${'x'.repeat(201)}`, 'length'],
    ['a folder name past the limit', `${'x'.repeat(201)}/page`, 'length'],
    ['two-byte letters past the byte limit', `people/${'\u00e9'.repeat(101)}`, 'length'],
    ['a number', 42, 'type'],
    ['null', null, 'type'],
    ['undefined', undefined, 'type'],
    ['an array', ['entities', 'johnny'], 'type'],
  ];

  it.each(refused)('refuses %s', (_label, id, problem) => {
    expect(problemOf(id)).toBe(problem);
    expect(isWikiPageId(id)).toBe(false);
  });

  it('throws a typed error whose message names the rule and shows only the start of the id, escaped', () => {
    let error: unknown;
    try {
      assertWikiPageId(`\u0000${'z'.repeat(10_000)}`);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(InvalidWikiPageIdError);
    expect(error).toBeInstanceOf(Error);
    const refusal = error as InvalidWikiPageIdError;
    expect(refusal.name).toBe('InvalidWikiPageIdError');
    expect(refusal.code).toBe('INVALID_WIKI_PAGE_ID');
    expect(refusal.problem).toBe('length');
    expect(refusal.message).toContain(`at most ${MAX_WIKI_PAGE_ID_LENGTH} characters`);
    expect(refusal.message).toContain('"\\u0000zzz');
    expect(refusal.message).not.toContain('\u0000');
    expect(refusal.message.length).toBeLessThan(200);
  });
});

describe('resolveWikiPagePath', () => {
  it('resolves an accepted id to its file inside the folder', () => {
    expect(resolveWikiPagePath('/srv/agent/memory', 'entities/johnny', path.posix)).toBe(
      '/srv/agent/memory/entities/johnny.md',
    );
    expect(resolveWikiPagePath('/srv/agent/memory/', 'page', path.posix)).toBe('/srv/agent/memory/page.md');
    expect(resolveWikiPagePath('/', 'page', path.posix)).toBe('/page.md');
    expect(resolveWikiPagePath('C:\\agent\\memory', 'entities/johnny', path.win32)).toBe(
      'C:\\agent\\memory\\entities\\johnny.md',
    );
  });

  it('checks the rule before it resolves anything', () => {
    expect(refusalOf(() => resolveWikiPagePath('/srv/agent/memory', '../outside', path.posix))?.problem).toBe('dot');
    // Each of these names a file outside the folder, or another page, once Windows resolves it.
    for (const id of ['..\\outside', 'D:notes', 'C:page', 'C:/Windows/notes']) {
      expect(refusalOf(() => resolveWikiPagePath('C:\\agent\\memory', id, path.win32))?.problem, id).toBe(
        'character',
      );
    }
  });

  it('refuses a file the path functions place outside the folder, in a sibling that shares its name among them', () => {
    const placing = (file: string) => ({
      sep: '/' as const,
      resolve: (...parts: string[]) => (parts.length === 1 ? '/srv/memory' : file),
    });
    expect(refusalOf(() => resolveWikiPagePath('/srv/memory', 'page', placing('/srv/memory-old/page.md')))?.problem).toBe(
      'outside',
    );
    expect(refusalOf(() => resolveWikiPagePath('/srv/memory', 'page', placing('/srv/page.md')))?.problem).toBe('outside');
    expect(resolveWikiPagePath('/srv/memory', 'page', placing('/srv/memory/page.md'))).toBe('/srv/memory/page.md');
  });
});
