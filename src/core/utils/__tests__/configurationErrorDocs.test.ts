/**
 * @file configurationErrorDocs.test.ts
 * The docs, and the source comments the API reference is built from, name the code a host reads when the runtime
 * refuses a configuration. The error's `code` is the string `SYS_CONFIGURATION_ERROR`, the value of
 * `GMIErrorCode.CONFIGURATION_ERROR`; a host that compares `err.code` with the member's name never matches. A page or a
 * comment names the member only with the string beside it, as `CONFIGURATION_ERROR` (`SYS_CONFIGURATION_ERROR`), or
 * qualified, as `GMIErrorCode.CONFIGURATION_ERROR`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GMIErrorCode } from '../errors';

/** The repository's root, which holds docs/ and src/. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The Markdown pages under docs/. */
const DOCS = path.join(ROOT, 'docs');

/** The source the package and its API reference are built from. */
const SRC = path.join(ROOT, 'src');

/** Every file under `dir` whose name ends with `suffix`, less the directories `skip` names. */
function files(dir: string, suffix: string, skip: (full: string, name: string) => boolean): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return skip(full, entry.name) ? [] : files(full, suffix, skip);
    return entry.name.endsWith(suffix) ? [full] : [];
  });
}

/** Every Markdown page under docs/, with the generated API reference left out. */
const pages = (): string[] => files(DOCS, '.md', (full) => full === path.join(DOCS, 'api'));

/** Every source file under src/, with the tests left out. */
const sources = (): string[] =>
  files(SRC, '.ts', (_full, name) => name === '__tests__').filter((file) => !/\.(test|spec)\.ts$/.test(file));

/**
 * The member's name, in backticks or not, where no qualifier comes before it and the string a host reads does not
 * follow it.
 */
const BARE_MEMBER = /(?<![\w.])CONFIGURATION_ERROR(?!\w)(?!`? \(`SYS_CONFIGURATION_ERROR`\))/g;

/** A source line that is a comment: a TSDoc or block comment's line, or a line comment. */
const COMMENT_LINE = /^\s*(\*|\/\*|\/\/)/;

/** Where `BARE_MEMBER` matches in `file`, on the lines `keep` takes, as "path line n". */
function bareIn(file: string, keep: (line: string) => boolean = () => true): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => (keep(line) ? [...line.matchAll(BARE_MEMBER)].map(() => `${path.relative(ROOT, file)} line ${index + 1}`) : []));
}

/** Each page that describes a configuration refusal, with the clause that names the string a host reads beside the call that refuses. */
const REFUSALS: Array<[page: string, words: string]> = [
  ['docs/AGENCIES.md', 'initialization fails with the code `SYS_CONFIGURATION_ERROR`'],
  ['docs/GMI.md', 'from `AgentOS.initialize()` with the code `SYS_CONFIGURATION_ERROR`'],
  ['docs/PERSONAS.md', '`create()` rejects with the code `SYS_CONFIGURATION_ERROR` when the value is not an array'],
  ['docs/getting-started/SQL_STORAGE_QUICKSTART.md', "with an error whose `code` is `'SYS_CONFIGURATION_ERROR'`"],
  ['docs/safety/PROVENANCE.md', "`AgentOS.initialize()` refuses to start with an error whose `code` is `'SYS_CONFIGURATION_ERROR'`"],
  ['docs/safety/GUARDRAILS_USAGE.md', '`initialize()` throws `SYS_CONFIGURATION_ERROR`'],
];

describe('the docs on a configuration refusal', () => {
  it('name the string a host reads in err.code, never the member alone', () => {
    expect(GMIErrorCode.CONFIGURATION_ERROR).toBe('SYS_CONFIGURATION_ERROR');
    expect(pages().flatMap((file) => bareIn(file))).toEqual([]);
  });

  it.each(REFUSALS)('name the string on %s, where it describes the refusal', (page, words) => {
    expect(fs.readFileSync(path.join(ROOT, page), 'utf8')).toContain(words);
  });

  it('name the string in the source comments the API reference is built from', () => {
    expect(sources().flatMap((file) => bareIn(file, (line) => COMMENT_LINE.test(line)))).toEqual([]);
  });

  it('match the member alone, in backticks or not, and leave its paired and qualified forms', () => {
    const matches = (text: string) => [...text.matchAll(BARE_MEMBER)].length;
    expect(matches('fails with `CONFIGURATION_ERROR` naming the field')).toBe(1);
    expect(matches('@throws GMIError CONFIGURATION_ERROR naming the index')).toBe(1);
    expect(matches('the code `CONFIGURATION_ERROR` (`SYS_CONFIGURATION_ERROR`).')).toBe(0);
    expect(matches('code: GMIErrorCode.CONFIGURATION_ERROR')).toBe(0);
    expect(matches('the code `SYS_CONFIGURATION_ERROR`')).toBe(0);
  });

  it('read the pages under docs/ and the source under src/', () => {
    expect(pages()).toContain(path.join(DOCS, 'GMI.md'));
    expect(pages().some((file) => file.startsWith(path.join(DOCS, 'api') + path.sep))).toBe(false);
    expect(sources()).toContain(path.join(SRC, 'core/conversation/ConversationManager.ts'));
    expect(sources().some((file) => file.includes(`${path.sep}__tests__${path.sep}`))).toBe(false);
  });
});
