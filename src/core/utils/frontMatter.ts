/**
 * @fileoverview Front matter read and written as data.
 *
 * gray-matter reads a front-matter block in the language named after its
 * opening delimiter (`---json`, `---js`), YAML when none is named, and its own
 * engine for `js` and `javascript` runs the block through `eval`. It also
 * reads a string it is asked to write front matter onto, so a body that opens
 * with such a block is evaluated when it is written. The files and bodies this
 * library hands it come from people and from models, so this module is the one
 * place the library calls gray-matter, and nothing handed to it is evaluated.
 *
 * @module agentos/core/utils/frontMatter
 */

import matter from 'gray-matter';

/** What {@link readFrontMatter} answers: gray-matter's file, with its `data` and its `content`. */
export type FrontMatterFile = matter.GrayMatterFile<string>;

/**
 * The engine put in place of gray-matter's `javascript` engine: it reads no
 * data from a block and evaluates nothing.
 */
function unread(): Record<string, unknown> {
  return {};
}

/**
 * gray-matter's options for every read. `js` is its other name for the
 * `javascript` engine, so the one entry covers both. Given options,
 * gray-matter also keeps no copy of what it parses: given none, it caches
 * every file by its whole text for as long as the process runs.
 */
const READ_OPTIONS = { engines: { javascript: unread } };

/**
 * Splits a Markdown file's text into its front matter and its body.
 *
 * A block in YAML (the default) or JSON is parsed into `data`. A block marked
 * as JavaScript (`---js` or `---javascript`) is not evaluated: it is taken off
 * the body like any front matter, and it gives no data.
 *
 * @param raw - The file's text.
 * @returns gray-matter's file: `data`, and `content` without the block.
 * @throws {Error} When the block is not valid in its language, or names a language with no engine.
 *
 * @example
 * ```ts
 * const { data, content } = readFrontMatter('---\ntitle: Notes\n---\n# Notes\n');
 * // data.title === 'Notes'; content === '# Notes\n'
 * ```
 */
export function readFrontMatter(raw: string): FrontMatterFile {
  return matter(raw, READ_OPTIONS);
}

/**
 * A front-matter block with no fields. {@link readFrontMatter} reads it as a
 * block that gives no data, and everything after it as the body.
 */
const EMPTY_BLOCK = '---\n---\n';

/**
 * Whether a read would change the opening of a file that opens with a text.
 * gray-matter takes a byte order mark off the start of a file, and reads a
 * front-matter block when the file opens with three dashes that a fourth does
 * not follow.
 *
 * @param text - The text a file would open with.
 * @returns `true` when `text` opens with a byte order mark, or like a block.
 */
function readChangesOpening(text: string): boolean {
  if (text.charCodeAt(0) === 0xfeff) return true;
  return text.startsWith('---') && text.charAt(3) !== '-';
}

/**
 * Writes a YAML front-matter block in front of a body.
 *
 * The body is written as it is and never read. Given a string,
 * `matter.stringify` first parses it for front matter of its own, so a body
 * that opens with a line of dashes would have its first lines read as that
 * block, and one marked as JavaScript would be evaluated.
 *
 * With no fields there is no block to write, and the body is written alone,
 * unless a read would change its opening: a body that opens like a block
 * would be read as the file's front matter, and a byte order mark at its
 * start would be taken off. Such a body is written behind an empty block,
 * which {@link readFrontMatter} reads as no data, so the body comes back whole.
 *
 * @param body - The text after the block.
 * @param data - The block's fields.
 * @returns The block, then the body, ending in a line break. With no fields,
 *   the body alone, behind an empty block when a read would change its opening.
 * @throws {Error} When a field cannot be written as YAML, such as `undefined`.
 *
 * @example
 * ```ts
 * writeFrontMatter('# Notes', { title: 'Notes' });
 * // '---\ntitle: Notes\n---\n# Notes\n'
 *
 * writeFrontMatter('---\nA rule opens this note.', {});
 * // '---\n---\n---\nA rule opens this note.\n'
 * ```
 */
export function writeFrontMatter(body: string, data: Record<string, unknown>): string {
  const written = matter.stringify({ content: body }, data);
  // gray-matter writes no block when there are no fields, and the body alone
  // is then the file's opening.
  const noFields = Object.keys(data).length === 0;
  return noFields && readChangesOpening(body) ? EMPTY_BLOCK + written : written;
}
