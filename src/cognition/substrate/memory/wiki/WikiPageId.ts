/** @fileoverview The id rule for wiki pages: an id names a file inside memory/, checked before any file is touched. */
import * as path from 'node:path';

/** The most characters a wiki page id may hold. */
export const MAX_WIKI_PAGE_ID_LENGTH = 512;

/**
 * Why a wiki page id was refused:
 * - `'type'`: the id is not a string.
 * - `'empty'`: the id is an empty string.
 * - `'length'`: the id is longer than {@link MAX_WIKI_PAGE_ID_LENGTH} characters.
 * - `'character'`: the id holds a backslash or a control character (U+0000 to U+001F, or U+007F), a NUL byte among them.
 * - `'segment'`: a name between slashes is empty: the id starts or ends with `/`, or holds `//`.
 * - `'dot'`: a name starts with a dot, `.` and `..` among them.
 * - `'outside'`: the page's file would not be inside the memory folder.
 */
export type WikiPageIdProblem = 'type' | 'empty' | 'length' | 'character' | 'segment' | 'dot' | 'outside';

/** The part of the rule each problem breaks, as the error message words it. */
const RULE_BROKEN: Record<WikiPageIdProblem, string> = {
  type: 'a page id is a string',
  empty: 'a page id is not empty',
  length: `a page id is at most ${MAX_WIKI_PAGE_ID_LENGTH} characters`,
  character: 'a page id holds no backslash and no control character',
  segment: 'a page id is names joined by single slashes, with no slash at its start or end',
  dot: 'no name in a page id starts with a dot',
  outside: "the page's file would be outside the memory folder",
};

/** The most characters of a refused id that its error message shows. */
const SHOWN_ID_CHARACTERS = 64;

/** The refused id as the message shows it: quoted and escaped, cut to its first characters. */
function describeId(id: unknown): string {
  if (typeof id !== 'string') return `of type ${id === null ? 'null' : typeof id}`;
  return JSON.stringify(id.length > SHOWN_ID_CHARACTERS ? `${id.slice(0, SHOWN_ID_CHARACTERS)}...` : id);
}

/** Thrown when a wiki page id is refused. Nothing is read or written for the refused id. */
export class InvalidWikiPageIdError extends Error {
  /** A stable code for callers that branch on the kind of failure. */
  readonly code = 'INVALID_WIKI_PAGE_ID';

  /**
   * @param problem - The part of the id rule the id breaks.
   * @param id - The refused id. The message shows at most its first 64 characters, escaped.
   */
  constructor(
    readonly problem: WikiPageIdProblem,
    id: unknown,
  ) {
    super(`wiki page id ${describeId(id)} refused: ${RULE_BROKEN[problem]}`);
    this.name = 'InvalidWikiPageIdError';
  }
}

/** The part of the id rule `id` breaks, or null when the rule accepts it. */
function problemOf(id: unknown): WikiPageIdProblem | null {
  if (typeof id !== 'string') return 'type';
  if (id.length === 0) return 'empty';
  if (id.length > MAX_WIKI_PAGE_ID_LENGTH) return 'length';
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    // 0x5c is the backslash, a folder separator on Windows.
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return 'character';
  }
  for (const name of id.split('/')) {
    if (name.length === 0) return 'segment';
    if (name.startsWith('.')) return 'dot';
  }
  return null;
}

/**
 * True when `id` has the wiki's id form: the page's path under `memory/` without `.md`, one or more names
 * joined by `/` (`entities/johnny` is `memory/entities/johnny.md`). No name is empty or starts with a dot,
 * so `.` and `..` are never names; the id holds no backslash and no control character, a NUL byte among
 * them; and it is at most {@link MAX_WIKI_PAGE_ID_LENGTH} characters. Every id the store lists, and every
 * id the default clusterer of `attachMemoryWiki` makes, has this form.
 */
export function isWikiPageId(id: unknown): id is string {
  return problemOf(id) === null;
}

/**
 * Throws an {@link InvalidWikiPageIdError} unless `id` has the wiki's id form (see {@link isWikiPageId}).
 *
 * @param id - The page id to check.
 * @throws InvalidWikiPageIdError naming the part of the rule the id breaks.
 */
export function assertWikiPageId(id: unknown): asserts id is string {
  const problem = problemOf(id);
  if (problem) throw new InvalidWikiPageIdError(problem, id);
}

/**
 * The file that holds page `id` in `memoryDir`. The id is checked against the rule first; then the resolved
 * file must lie inside the resolved folder, a second guard that holds whatever a platform's path rules make
 * of an id the rule accepts (on Windows, `D:notes` names a file on another drive).
 *
 * @param memoryDir - The wiki's folder.
 * @param id - The page id.
 * @param paths - The path functions to resolve with: the platform's by default, `path.win32` or `path.posix` to pick one.
 * @returns The absolute path of the page's `.md` file.
 * @throws InvalidWikiPageIdError when the id is refused or its file would be outside `memoryDir`.
 */
export function resolveWikiPagePath(
  memoryDir: string,
  id: unknown,
  paths: Pick<path.PlatformPath, 'resolve' | 'sep'> = path,
): string {
  assertWikiPageId(id);
  const root = paths.resolve(memoryDir);
  const file = paths.resolve(root, `${id}.md`);
  const inside = root.endsWith(paths.sep) ? root : root + paths.sep;
  if (!file.startsWith(inside)) throw new InvalidWikiPageIdError('outside', id);
  return file;
}
