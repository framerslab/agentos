/**
 * @fileoverview Non-destructive MEMORY.md → memory/ migration. Idempotent. Nothing is made, written or read through
 * a symbolic link at the soul's folder or below it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  createFileOutsideLinksSync,
  makeFoldersOutsideLinksSync,
  readFileOutsideLinksSync,
  type OpenRefusal,
} from '../../../../core/utils/linkFreeWrite.js';

/** The line that opens the text `ensureMemoryDir` copies from a legacy `MEMORY.md` into `memory/index.md`. */
export const MIGRATED_START_MARKER = '<!-- migrated from MEMORY.md -->';

/** The line that closes that text. The catalog the wiki writes into `memory/index.md` follows it. */
export const MIGRATED_END_MARKER = '<!-- end of MEMORY.md -->';

/**
 * What {@link MIGRATED_END_MARKER} becomes where `MEMORY.md` itself holds it, so the copied text cannot close its own
 * block: a comment still, and so as unseen in rendered markdown as the one it replaces.
 */
const QUOTED_END_MARKER = '<!-- end of MEMORY.md (quoted) -->';

/**
 * The opening of an `index.md` that holds text migrated from `MEMORY.md`: the catalog's heading and the blank lines
 * under it. `ensureMemoryDir` and the wiki store put {@link MIGRATED_START_MARKER} right after them, and nowhere else.
 */
const MIGRATED_BLOCK_OPENING = /^# Memory Index[ \t]*\r?\n(?:[ \t]*\r?\n)*/;

/**
 * Where the migrated block of `index` starts and where its end marker is. The block starts only at
 * {@link MIGRATED_START_MARKER} right under the index's heading, where migration writes it: a start marker anywhere
 * else is text of the catalog, such as a page's summary taken from what a user said, and opens no block.
 *
 * @param index - The text of `memory/index.md`.
 * @returns The block's start and the index of its end marker (-1 when it has none), or null when it has no block.
 */
function migratedBlockRange(index: string): { start: number; end: number } | null {
  const opening = MIGRATED_BLOCK_OPENING.exec(index);
  if (!opening || !index.startsWith(MIGRATED_START_MARKER, opening[0].length)) return null;
  const start = opening[0].length;
  return { start, end: index.indexOf(MIGRATED_END_MARKER, start + MIGRATED_START_MARKER.length) };
}

/**
 * The text migrated from `MEMORY.md` that an `index.md` holds: everything from {@link MIGRATED_START_MARKER}, right
 * under the index's heading, through the first {@link MIGRATED_END_MARKER} after it. An index written before the end
 * marker existed (a start marker and no end marker) is read as a block that runs to the end of the file, returned
 * with its end marker added. A start marker anywhere else opens no block.
 *
 * @param index - The text of `memory/index.md`.
 * @returns The block, both markers included, or null when no start marker sits right under the index's heading.
 */
export function migratedBlockOf(index: string): string | null {
  const range = migratedBlockRange(index);
  if (!range) return null;
  if (range.end >= 0) return index.slice(range.start, range.end + MIGRATED_END_MARKER.length);
  return `${index.slice(range.start).trimEnd()}\n\n${MIGRATED_END_MARKER}`;
}

/**
 * `index` without the {@link MIGRATED_END_MARKER} that closes its migrated block, for the system prompt: the marker
 * is the wiki's own bookkeeping, and an index the wiki has not yet written a catalog into reads as it did before the
 * marker existed. An index with no migrated block (see {@link migratedBlockOf}) is returned as it is, trimmed.
 *
 * @param index - The text of `memory/index.md`.
 * @returns The text with that end marker and the blank lines around it replaced by one blank line, trimmed.
 */
export function withoutMigratedEndMarker(index: string): string {
  const at = migratedBlockRange(index)?.end ?? -1;
  if (at < 0) return index.trim();
  const before = index.slice(0, at).trimEnd();
  const after = index.slice(at + MIGRATED_END_MARKER.length).trimStart();
  return (after ? `${before}\n\n${after}` : before).trim();
}

/** The heading `renderCatalog` opens index.md with. */
const CATALOG_HEADING = '# Memory Index\n';

/**
 * An index with the migrated `MEMORY.md` block under its heading and the catalog's sections after it.
 *
 * @param catalog - The catalog `renderCatalog` wrote.
 * @param migrated - The migrated block, both markers included (see {@link migratedBlockOf}).
 * @returns The text of `memory/index.md`.
 */
export function withMigratedText(catalog: string, migrated: string): string {
  const sections = (catalog.startsWith(CATALOG_HEADING) ? catalog.slice(CATALOG_HEADING.length) : catalog).replace(/^\n+/, '');
  return `${CATALOG_HEADING}\n${migrated}\n${sections ? `\n${sections}` : ''}`;
}

/** What a new `.meta/index.json` holds. */
const META_INDEX = JSON.stringify({ lastCompiledAt: null, pages: {} }, null, 2);

/** What is wrong with a place, as a warning words it. */
const PLACE_REFUSED: Record<OpenRefusal, string> = {
  link: 'it is reached through a symbolic link',
  special: 'it is not a regular file',
};

/**
 * Guarantee a `memory/` directory exists in the workspace and return its path. Idempotent: what is already there is
 * left untouched.
 *
 * - `memory/` and `memory/.meta/` are made when missing.
 * - A missing `memory/index.md` is seeded from `MEMORY.md` when the workspace holds one, and is otherwise a stub.
 *   The copied text sits between {@link MIGRATED_START_MARKER} and {@link MIGRATED_END_MARKER}, which the wiki store
 *   keeps when it rewrites the catalog. An end marker the text itself holds is copied as
 *   `<!-- end of MEMORY.md (quoted) -->`, so it closes no block. `MEMORY.md` is left on disk as a fallback.
 * - A missing `memory/.meta/index.json` starts an empty page index.
 *
 * Never modifies or deletes `MEMORY.md`.
 *
 * The workspace's own folder, `memory/` and `memory/.meta/` are made one name at a time below the folder that holds
 * the workspace, and `index.md` and `.meta/index.json` only in a place that nothing holds, so nothing is written
 * through a symbolic link and no file already there is opened. `MEMORY.md` is read never through a link and never
 * waiting. When a link, or anything other than a folder, holds the place of the workspace's folder, `memory/` or
 * `.meta/`, nothing is made in them; when a link or anything other than a regular file holds the place of
 * `index.md`, `.meta/index.json` or `MEMORY.md`, that place is left as it is and the file that would come from it
 * is not made. Each of those writes one warning, and the path is returned all the same.
 *
 * @param workspaceDir - The per-agent workspace directory. It may not be a link; the folder that holds it may.
 * @returns The `memory/` directory's path: `memory` joined to `workspaceDir`, absolute when `workspaceDir` is.
 */
export function ensureMemoryDir(workspaceDir: string): string {
  const memoryDir = path.join(workspaceDir, 'memory');
  // Below the folder that holds the workspace, so the workspace's folder is looked at too.
  const soulDir = path.resolve(workspaceDir);
  const root = path.dirname(soulDir);
  const soul = path.basename(soulDir);
  // The folder that holds the workspace is the caller's: it is made when missing and used as it is.
  fs.mkdirSync(root, { recursive: true });
  if (!makeFoldersOutsideLinksSync(root, path.join(soul, 'memory', '.meta'))) {
    console.warn(
      `[ensureMemoryDir] Made nothing in ${memoryDir}: a symbolic link, or something other than a folder, holds the place of the workspace's folder, memory/ or memory/.meta`,
    );
    return memoryDir;
  }

  const indexPath = path.join(soulDir, 'memory', 'index.md');
  makeMissingFile(indexPath, () => {
    const legacy = readFileOutsideLinksSync(root, path.join(soul, 'MEMORY.md'));
    if (legacy === null) return '# Memory Index\n';
    if (typeof legacy === 'string') {
      console.warn(
        `[ensureMemoryDir] Did not make ${indexPath} from ${path.join(soulDir, 'MEMORY.md')}: ${PLACE_REFUSED[legacy]}`,
      );
      return null;
    }
    const text = legacy.text.trimEnd().split(MIGRATED_END_MARKER).join(QUOTED_END_MARKER);
    return `# Memory Index\n\n${MIGRATED_START_MARKER}\n\n${text}\n\n${MIGRATED_END_MARKER}\n`;
  });
  makeMissingFile(path.join(soulDir, 'memory', '.meta', 'index.json'), () => META_INDEX);

  return memoryDir;
}

/**
 * Make `file` holding what `text` gives when nothing holds its place (`createFileOutsideLinksSync`), and leave a
 * regular file there as it is. A symbolic link, one that leads nowhere among them, or anything other than a regular
 * file in the place is left as it is too, with a warning, and nothing is written.
 *
 * @param file - Absolute path of the file, in a folder already made.
 * @param text - What the file holds, asked for only when the place is free; null makes no file.
 */
function makeMissingFile(file: string, text: () => string | null): void {
  let place = placeOf(file);
  if (place === 'free') {
    const content = text();
    if (content === null || createFileOutsideLinksSync(file, content)) return;
    // Something was put in the file's place since the look: look again.
    place = placeOf(file);
  }
  if (place === 'link' || place === 'special') {
    console.warn(`[ensureMemoryDir] Left ${file} as it is and wrote nothing there: ${PLACE_REFUSED[place]}`);
  }
}

/** What holds a file's place, looked at without following a link. */
function placeOf(file: string): 'free' | 'file' | OpenRefusal {
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  if (entry === undefined) return 'free';
  if (entry.isSymbolicLink()) return 'link';
  return entry.isFile() ? 'file' : 'special';
}
