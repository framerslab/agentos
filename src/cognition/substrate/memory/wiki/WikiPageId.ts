/** @fileoverview The id rule for wiki pages: an id names a file inside memory/, checked before any file is touched. */
import * as path from 'node:path';
import {
  MAX_PATH_NAME_BYTES,
  isRefusedPathCharacter,
  pathNameProblem,
  resolveInsideFolder,
} from '../../../../core/utils/pathName.js';

/** The most characters a wiki page id may hold. */
export const MAX_WIKI_PAGE_ID_LENGTH = 512;

/** The id of the catalog file, `index.md`, which the store writes itself and never lists as a page. */
const CATALOG_ID = 'index';

/**
 * Why a wiki page id was refused:
 * - `'type'`: the id is not a string.
 * - `'empty'`: the id is an empty string.
 * - `'length'`: the id is longer than {@link MAX_WIKI_PAGE_ID_LENGTH} characters, or a name in it holds more than
 *   200 bytes in UTF-8, the most a name built from data may hold (`MAX_PATH_NAME_BYTES` in `core/utils/pathName`).
 * - `'character'`: the id holds a backslash, a colon, one of `"`, `*`, `<`, `>`, `?` and `|`, or a control
 *   character (U+0000 to U+001F, or U+007F), a NUL byte among them. On Windows a backslash separates folders, a
 *   colon names a drive or a file's stream, and the other six are refused in a name.
 * - `'segment'`: a name between slashes is empty: the id starts or ends with `/`, or holds `//`.
 * - `'dot'`: a name starts with a dot, `.` and `..` among them.
 * - `'edge'`: a name starts or ends with a space, or ends with a dot. Windows drops those from a name, so the
 *   name would be another's (`entities./x` is `entities/x` there).
 * - `'reserved'`: the id is `index` in any case, which names the catalog, `index.md` (on a filesystem that
 *   ignores case, `INDEX.md` is the same file).
 * - `'outside'`: the page's file would not be inside the memory folder.
 */
export type WikiPageIdProblem =
  | 'type'
  | 'empty'
  | 'length'
  | 'character'
  | 'segment'
  | 'dot'
  | 'edge'
  | 'reserved'
  | 'outside';

/** The part of the rule each problem breaks, as the error message words it. */
const RULE_BROKEN: Record<WikiPageIdProblem, string> = {
  type: 'a page id is a string',
  empty: 'a page id is not empty',
  length:
    `a page id is at most ${MAX_WIKI_PAGE_ID_LENGTH} characters, ` +
    `and each name in it at most ${MAX_PATH_NAME_BYTES} bytes in UTF-8`,
  character: 'a page id holds no backslash, no colon, none of " * < > ? | and no control character',
  segment: 'a page id is names joined by single slashes, with no slash at its start or end',
  dot: 'no name in a page id starts with a dot',
  edge: 'no name in a page id starts or ends with a space or ends with a dot',
  reserved: 'the id index, in any case, names the catalog, index.md, which is not a page',
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

/**
 * The part of the id rule `id` breaks, or null when the rule accepts it. Each name between slashes is held to the
 * rule every name built from data is held to (`pathNameProblem`), after the whole id is checked.
 */
function problemOf(id: unknown): WikiPageIdProblem | null {
  if (typeof id !== 'string') return 'type';
  if (id.length === 0) return 'empty';
  if (id.length > MAX_WIKI_PAGE_ID_LENGTH) return 'length';
  for (let i = 0; i < id.length; i++) {
    if (isRefusedPathCharacter(id.charCodeAt(i))) return 'character';
  }
  for (const name of id.split('/')) {
    const problem = pathNameProblem(name);
    // An empty name sits between two slashes, or at the id's start or end.
    if (problem) return problem === 'empty' ? 'segment' : problem;
  }
  return id.toLowerCase() === CATALOG_ID ? 'reserved' : null;
}

/**
 * True when `id` has the wiki's id form: the page's path under `memory/` without `.md`, one or more names
 * joined by `/` (`entities/johnny` is `memory/entities/johnny.md`). No name is empty or starts with a dot,
 * so `.` and `..` are never names, and no name starts or ends with a space or ends with a dot, which
 * Windows drops from a name; the id holds no backslash, no colon, none of `"`, `*`, `<`, `>`, `?` and `|`,
 * and no control character, a NUL byte among them; it is at most {@link MAX_WIKI_PAGE_ID_LENGTH} characters,
 * and each name in it at most 200 bytes in UTF-8; and it is not `index` in any case, the catalog's own id.
 * Every id the store lists, and every id the default clusterer of `attachMemoryWiki` makes, has this form.
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
 * file must lie inside the resolved folder, a second guard should a platform's path rules ever place the
 * file of an accepted id elsewhere.
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
  const file = resolveInsideFolder(memoryDir, [`${id}.md`], paths);
  if (file === null) throw new InvalidWikiPageIdError('outside', id);
  return file;
}
