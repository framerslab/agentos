/**
 * @fileoverview The rule for a file or folder name built from data, and the check that a path built from such
 * names lies inside its folder.
 *
 * The memory wiki builds a page's path from its id, the Markdown and Obsidian memory exporters build a trace's
 * path from its scope, type and id, and the skill exporter builds a forged tool's folder from its name. Those
 * values come from files, imports and models, so every name taken from them is checked against one rule here,
 * and every path built from them is checked to lie inside the folder it is written to.
 *
 * @module agentos/core/utils/pathName
 */

import * as path from 'node:path';

/**
 * The most bytes, in UTF-8, one name may hold. Linux allows 255 bytes in a name, and Windows usually 255 UTF-16
 * code units; a name never holds more code units than bytes, so 200 fits both and leaves room for the extension a
 * caller adds, such as `.md`.
 */
export const MAX_PATH_NAME_BYTES = 200;

/**
 * Why a name was refused:
 * - `'empty'`: the name is empty.
 * - `'character'`: it holds a slash, a backslash, a colon, one of `"`, `*`, `<`, `>`, `?` and `|`, or a control
 *   character (U+0000 to U+001F, or U+007F), a NUL byte among them. A slash or a backslash separates folders; on
 *   Windows a colon names a drive (`C:name`) or a file's stream (`name:stream`), and Windows refuses the other six
 *   in a name.
 * - `'dot'`: it starts with a dot, so it is `.`, `..` or a hidden name.
 * - `'edge'`: it starts or ends with a space, or ends with a dot. Windows drops those from a name, so the name
 *   would be another's (`notes.` is `notes` there).
 * - `'length'`: it holds more than {@link MAX_PATH_NAME_BYTES} bytes in UTF-8.
 */
export type PathNameProblem = 'empty' | 'character' | 'dot' | 'edge' | 'length';

/** The slash's code: the folder separator everywhere. */
const SLASH = 0x2f;

/** The backslash's code: a folder separator on Windows. */
const BACKSLASH = 0x5c;

/** The colon's code: on Windows it names a drive (`C:name`) or a file's stream (`name:stream`). */
const COLON = 0x3a;

/** The codes of `"`, `*`, `<`, `>`, `?` and `|`, which Windows refuses in a name. */
const WINDOWS_RESERVED = new Set([0x22, 0x2a, 0x3c, 0x3e, 0x3f, 0x7c]);

const utf8 = new TextEncoder();

/** The most characters of a refused name that an error message shows. */
const SHOWN_NAME_CHARACTERS = 64;

/**
 * A refused value as an error message shows it: a string quoted and escaped, cut to its first 64 characters, or
 * the type of any other value.
 *
 * @param value - The refused value.
 */
export function describeRefusedName(value: unknown): string {
  if (typeof value !== 'string') return `of type ${value === null ? 'null' : typeof value}`;
  return JSON.stringify(
    value.length > SHOWN_NAME_CHARACTERS ? `${value.slice(0, SHOWN_NAME_CHARACTERS)}...` : value,
  );
}

/**
 * True when the character whose UTF-16 code is `code` may appear neither in a name nor anywhere in a path whose
 * names are joined with `/`: a backslash, a colon, one of `"`, `*`, `<`, `>`, `?` and `|`, or a control character
 * (U+0000 to U+001F, or U+007F).
 */
export function isRefusedPathCharacter(code: number): boolean {
  return code <= 0x1f || code === 0x7f || code === BACKSLASH || code === COLON || WINDOWS_RESERVED.has(code);
}

/**
 * The part of the name rule `name` breaks, or null when `name` may name one file or folder. A name the rule
 * accepts holds no separator, is never `.` or `..`, and names no drive or file stream, so a path built from such
 * names stays under the folder it starts from.
 *
 * @param name - The name to check.
 */
export function pathNameProblem(name: string): PathNameProblem | null {
  if (name.length === 0) return 'empty';
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code === SLASH || isRefusedPathCharacter(code)) return 'character';
  }
  if (name.startsWith('.')) return 'dot';
  if (name.startsWith(' ') || name.endsWith(' ') || name.endsWith('.')) return 'edge';
  // A string never has more UTF-16 code units than UTF-8 bytes, so a long one is refused before it is encoded.
  if (name.length > MAX_PATH_NAME_BYTES || utf8.encode(name).byteLength > MAX_PATH_NAME_BYTES) return 'length';
  return null;
}

/**
 * The path that `relative` names under the folder `root`, resolved, or null when that path is not inside `root`.
 * The paths are compared resolved, with the separator after the folder's own path, so a sibling folder whose name
 * starts with the folder's (`/srv/memory-old` beside `/srv/memory`) is not inside it, and neither is the folder
 * itself. The check is on the path as written: a link inside the folder is not followed.
 *
 * @param root - The folder.
 * @param relative - The parts of the path under `root`, in order, as `path.resolve` takes them.
 * @param paths - The path functions to resolve with: the platform's by default, `path.win32` or `path.posix` to
 *   pick one.
 * @returns The absolute path, or null when it is outside `root`.
 */
export function resolveInsideFolder(
  root: string,
  relative: readonly string[],
  paths: Pick<path.PlatformPath, 'resolve' | 'sep'> = path,
): string | null {
  const folder = paths.resolve(root);
  const file = paths.resolve(folder, ...relative);
  const inside = folder.endsWith(paths.sep) ? folder : folder + paths.sep;
  return file.startsWith(inside) ? file : null;
}
