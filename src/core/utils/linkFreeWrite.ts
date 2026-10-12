/**
 * @fileoverview Writing below a folder whose contents another process may change: folders are made one name at a
 * time and never through a link, and a file is opened for writing never through a link, never waiting, and only
 * when it is a regular file with one name.
 *
 * The Markdown and Obsidian memory exporters write a file per trace below an export folder, and the skill exporter
 * writes a tool's files below a skills folder. Whoever can write below such a folder could put there a link that
 * leads elsewhere, a second name for a file elsewhere, or a named pipe that holds a writer up, so both write
 * through the functions here. The folder itself is the caller's and may be a link. The checks run as each folder
 * is made and each file opened; Node has no `openat`, so a process that swaps a folder for a link between a check
 * and the write is outside what they stop.
 *
 * @module agentos/core/utils/linkFreeWrite
 */

import fs, { type FileHandle } from 'node:fs/promises';
import { constants as fsConstants, type Stats } from 'node:fs';
import path from 'node:path';

/**
 * The flags a file is opened with: for writing, made when missing, and, where the platform has each flag (Windows
 * has neither), never through a symbolic link in the file's own place (`O_NOFOLLOW`) and never waiting
 * (`O_NONBLOCK`). Without `O_NONBLOCK`, an open for writing of a named pipe that no process reads waits for a
 * reader that may never come. The file is not emptied by the open: the caller empties it once the open file shows
 * it is a regular file with no second name.
 */
const OPEN_FLAGS: number =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  (fsConstants.O_NOFOLLOW !== undefined ? fsConstants.O_NOFOLLOW : 0) |
  (fsConstants.O_NONBLOCK !== undefined ? fsConstants.O_NONBLOCK : 0);

/** The codes an open with `O_NOFOLLOW` fails with when a symbolic link holds the file's place (EMLINK on FreeBSD). */
const LINK_OPEN_CODES: ReadonlySet<string> = new Set(['ELOOP', 'EMLINK']);

/**
 * The codes an open for writing fails with when something other than a regular file holds the file's place:
 * EISDIR for a folder; ENXIO for a named pipe that no process reads (under `O_NONBLOCK`), a device with no driver,
 * or, on Linux, a socket; EOPNOTSUPP for a socket on macOS.
 */
const SPECIAL_OPEN_CODES: ReadonlySet<string> = new Set(['EISDIR', 'ENXIO', 'EOPNOTSUPP']);

/**
 * Why a file was not opened: `link` when a symbolic link holds its place or the file has a second name (a hard
 * link), and `special` when something other than a regular file holds its place (a folder, a named pipe, a socket,
 * a device).
 */
export type OpenRefusal = 'link' | 'special';

/** A file open for writing and checked, and the identity of the file the open reached. */
export interface OpenedFile {
  /** The open file. Nothing has been emptied or written. */
  handle: FileHandle;
  /**
   * The file's device and inode numbers, or null when the file system reports an inode of 0, which names no file.
   * Two names that open one file give the same identity.
   */
  identity: string | null;
}

/**
 * Make the folders `relative` names under `root`, one name at a time, and stop at a link. A folder this makes is
 * never a link, so a file written into it stays under `root`.
 *
 * @param root     - The folder the others are made in. It may itself be a link.
 * @param relative - The folders' path under `root`.
 * @returns True when every folder is in place and none of them is a link.
 */
export async function makeFoldersOutsideLinks(root: string, relative: string): Promise<boolean> {
  let dir = root;
  for (const name of relative.split(path.sep).filter((part) => part.length > 0)) {
    dir = path.join(dir, name);
    const entry = await lstatOrNull(dir);
    if (entry) {
      if (entry.isSymbolicLink()) return false;
      continue;
    }
    try {
      await fs.mkdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Something was put there since the look: look again.
      if ((await fs.lstat(dir)).isSymbolicLink()) return false;
    }
  }
  return true;
}

/**
 * Look at a file's place without opening it. A caller that writes several files, all of them or none, looks at
 * every place before it opens any file, so a refusal makes no file. The look does not see a change made after it;
 * {@link openFileOutsideLinks} checks again.
 *
 * @param file - Absolute path of the file.
 * @returns `link` when a symbolic link holds the place or the file there has a second name, `special` when
 *   something other than a regular file holds it, or null when the place is free or holds a regular file with one
 *   name.
 * @throws Any error the look meets other than a missing file.
 */
export async function lookOutsideLinks(file: string): Promise<OpenRefusal | null> {
  const entry = await lstatOrNull(file);
  if (entry === null) return null;
  if (entry.isSymbolicLink()) return 'link';
  if (!entry.isFile()) return 'special';
  return entry.nlink > 1 ? 'link' : null;
}

/**
 * Open a file for writing, in a folder already made, and check what the open reached. A symbolic link in the
 * file's place is refused before the open, and where the platform has `O_NOFOLLOW` the open refuses one put there
 * since. A folder fails the open, and where the platform has `O_NONBLOCK` so does a named pipe that no process
 * reads, at once. An open file that is not a regular file (a named pipe that a process reads, a device) is refused,
 * and so is a file with a second name (a hard link), which is the same file as that name and may lie outside the
 * folder. Nothing is emptied or written here; a refused file is closed.
 *
 * @param file - Absolute path of the file.
 * @returns The open file and its identity, or the refusal.
 * @throws Any other error the look or the open meets.
 */
export async function openFileOutsideLinks(file: string): Promise<OpenedFile | OpenRefusal> {
  if ((await lstatOrNull(file))?.isSymbolicLink()) return 'link';
  const handle = await fs.open(file, OPEN_FLAGS).catch((err: unknown) => {
    const code = String((err as NodeJS.ErrnoException).code);
    if (LINK_OPEN_CODES.has(code)) return 'link' as const;
    if (SPECIAL_OPEN_CODES.has(code)) return 'special' as const;
    throw err;
  });
  if (typeof handle === 'string') return handle;
  let handedOver = false;
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return 'special';
    if (stat.nlink > 1n) return 'link';
    handedOver = true;
    return { handle, identity: stat.ino === 0n ? null : `${stat.dev}:${stat.ino}` };
  } finally {
    if (!handedOver) await handle.close();
  }
}

/** The entry at `file` itself, a link not followed, or null when there is none. */
async function lstatOrNull(file: string): Promise<Stats | null> {
  try {
    return await fs.lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
