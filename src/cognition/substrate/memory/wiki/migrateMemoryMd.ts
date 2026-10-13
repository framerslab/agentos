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
 *   `MEMORY.md` is left on disk as a fallback.
 * - A missing `memory/.meta/index.json` starts an empty page index.
 *
 * Never modifies or deletes `MEMORY.md`.
 *
 * The workspace's own folder, `memory/` and `memory/.meta/` are made one name at a time below the folder that holds
 * the workspace, and `index.md` and `.meta/index.json` only in a place that nothing holds, so nothing is written
 * through a symbolic link and no file already there is opened. `MEMORY.md` is read never through a link and never
 * waiting. When a link holds the place of the workspace's folder, `memory/` or `.meta/`, nothing is made in them;
 * when a link or anything other than a regular file holds the place of `index.md`, `.meta/index.json` or
 * `MEMORY.md`, that place is left as it is and the file that would come from it is not made. Each of those writes
 * one warning, and the path is returned all the same.
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
      `[ensureMemoryDir] Made nothing in ${memoryDir}: a symbolic link holds the place of the workspace's folder, memory/ or memory/.meta`,
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
    return `# Memory Index\n\n<!-- migrated from MEMORY.md -->\n\n${legacy.text}\n`;
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
