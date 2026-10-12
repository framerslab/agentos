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
    ['a name with spaces, capitals and a letter outside ASCII', 'people/Ana L\u00f3pez'],
    ['dots inside a name', 'notes/v1..v2'],
    ['an id at the length limit', 'x'.repeat(MAX_WIKI_PAGE_ID_LENGTH)],
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
    ['a backslash', 'a\\b', 'character'],
    ['a parent folder written with a backslash', '..\\x', 'character'],
    ['an empty string', '', 'empty'],
    ['a NUL byte', 'page\u0000.txt', 'character'],
    ['a line break', 'a\nb', 'character'],
    ['a delete character', 'a\u007fb', 'character'],
    ['a leading slash', '/etc/x', 'segment'],
    ['a doubled slash', 'a//b', 'segment'],
    ['a trailing slash', 'a/', 'segment'],
    ['an id one character past the limit', 'x'.repeat(MAX_WIKI_PAGE_ID_LENGTH + 1), 'length'],
    ['a very long id', 'a/'.repeat(50_000) + 'b', 'length'],
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
    expect(refusalOf(() => resolveWikiPagePath('C:\\agent\\memory', '..\\outside', path.win32))?.problem).toBe(
      'character',
    );
  });

  it('refuses an id the rule accepts when its file would still land outside the folder', () => {
    // On Windows a name that opens with a drive names a file on that drive, outside the folder.
    for (const id of ['D:notes', 'C:/Windows/notes']) {
      expect(isWikiPageId(id)).toBe(true);
      expect(refusalOf(() => resolveWikiPagePath('C:\\agent\\memory', id, path.win32))?.problem).toBe('outside');
    }
  });
});
