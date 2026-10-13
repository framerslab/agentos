/**
 * @fileoverview Writing and reading below a folder whose contents another process may change: folders are made
 * one name at a time and never through a link, a file is opened for writing never through a link, never waiting,
 * and only when it is a regular file with one name, and a file is read never through a link below the folder,
 * never waiting, and only when it is a regular file.
 *
 * The Markdown and Obsidian memory exporters write a file per trace below an export folder, and the skill exporter
 * writes a tool's files below a skills folder. Whoever can write below such a folder could put there a link that
 * leads elsewhere, a second name for a file elsewhere, or a named pipe that holds a writer up, so both write
 * through the functions here. The capability manifest scanner reads a capability's files below its folder, where
 * a link could lead a read to a file elsewhere and a named pipe could hold the read up, so it reads through
 * {@link readFileOutsideLinks}. The folder itself is the caller's and may be a link. The checks run as each folder
 * is made or looked at and each file opened; Node has no `openat`, so a process that swaps a folder for a link
 * between a check and the write or read is outside what they stop, except that on Linux a read also checks the
 * path the kernel gives for the file it opened.
 *
 * @module agentos/core/utils/linkFreeWrite
 */

import fs, { type FileHandle } from 'node:fs/promises';
import { constants as fsConstants, type Stats } from 'node:fs';
import path from 'node:path';

/**
 * Where the platform has each flag (Windows has neither): open never through a symbolic link in the file's own
 * place (`O_NOFOLLOW`) and never waiting (`O_NONBLOCK`). Without `O_NONBLOCK`, an open for writing of a named pipe
 * that no process reads waits for a reader, and an open for reading of one that no process writes waits for a
 * writer, and either may never come.
 */
const NO_LINK_NO_WAIT: number =
  (fsConstants.O_NOFOLLOW !== undefined ? fsConstants.O_NOFOLLOW : 0) |
  (fsConstants.O_NONBLOCK !== undefined ? fsConstants.O_NONBLOCK : 0);

/**
 * The flags a file is opened with for writing: write only, made when missing, never through a link in its own place
 * and never waiting ({@link NO_LINK_NO_WAIT}). The file is not emptied by the open: the caller empties it once the
 * open file shows it is a regular file with no second name.
 */
const OPEN_FLAGS: number = fsConstants.O_WRONLY | fsConstants.O_CREAT | NO_LINK_NO_WAIT;

/** The flags a file is opened with for reading: read only, never through a link in its own place and never waiting. */
const READ_FLAGS: number = fsConstants.O_RDONLY | NO_LINK_NO_WAIT;

/** The codes an open with `O_NOFOLLOW` fails with when a symbolic link holds the file's place (EMLINK on FreeBSD). */
const LINK_OPEN_CODES: ReadonlySet<string> = new Set(['ELOOP', 'EMLINK']);

/**
 * The codes an open fails with when something other than a regular file holds the file's place: EISDIR for a
 * folder opened for writing; ENXIO for a named pipe that no process reads opened for writing (under `O_NONBLOCK`),
 * a device with no driver, or, on Linux, a socket; EOPNOTSUPP for a socket on macOS.
 */
const SPECIAL_OPEN_CODES: ReadonlySet<string> = new Set(['EISDIR', 'ENXIO', 'EOPNOTSUPP']);

/**
 * Why a file was not opened: `link` when a symbolic link holds its place or the file has a second name (a hard
 * link), or, for a read, when a symbolic link holds the place of a folder on the way to it; and `special` when
 * something other than a regular file holds its place (a folder, a named pipe, a socket, a device).
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

/**
 * Read the file that `relative` names under `root`, never through a symbolic link below `root`. Each folder on the
 * way is looked at, and so is the file's place before the file is opened, so a link or something other than a
 * regular file is refused before any open. The file is then opened never through a link in its own place and,
 * where the platform has `O_NONBLOCK`, never waiting, and it is read only when the open file is a regular file. A
 * regular file with a second name (a hard link) is read: a read changes nothing through the other name, and pnpm,
 * by default on Linux, installs a package's files as hard links to its store, so each of them has a second name.
 *
 * On Linux, where `/proc` reports the path of an open file, the file the open reached must also lie below the real
 * path `root` had before the looks, so a folder on the way that is swapped for a link after its look and before the
 * open is refused too. Elsewhere Node can neither open a file relative to a folder held open nor ask an open file
 * for its path, and such a swap is outside what the looks stop.
 *
 * @param root - The folder the file is read below. It may itself be a link.
 * @param relative - The file's path under `root`, its names joined by the platform's separator, as `path.relative`
 *   gives it. The caller checks that the path stays under `root` (`resolveInsideFolder`).
 * @returns The file's text, read as UTF-8; `link` when a symbolic link holds the file's place or a folder's on the
 *   way, or, on Linux, when the file the open reached lies outside `root`; `special` when something other than a
 *   regular file holds the file's place; or null when no file is there.
 * @throws Any other error the looks, the open or the read meet.
 */
export async function readFileOutsideLinks(
  root: string,
  relative: string,
): Promise<{ text: string } | OpenRefusal | null> {
  const names = relative.split(path.sep).filter((part) => part.length > 0);
  // With no name, the path is the root itself, a folder.
  if (names.length === 0) return 'special';
  // Taken before the looks: a link put on the way after them does not move it.
  const realRoot = await realPathWhereOpenPathsShow(root);
  let place = root;
  for (let index = 0; index < names.length; index++) {
    place = path.join(place, names[index]);
    const entry = await lstatOrNull(place);
    if (entry === null) return null;
    if (entry.isSymbolicLink()) return 'link';
    if (index === names.length - 1) {
      if (!entry.isFile()) return 'special';
    } else if (!entry.isDirectory()) {
      // Something other than a folder on the way: no file is there.
      return null;
    }
  }
  const handle = await fs.open(place, READ_FLAGS).catch((err: unknown) => {
    const code = String((err as NodeJS.ErrnoException).code);
    // Taken away since the look.
    if (code === 'ENOENT') return null;
    if (LINK_OPEN_CODES.has(code)) return 'link' as const;
    if (SPECIAL_OPEN_CODES.has(code)) return 'special' as const;
    throw err;
  });
  if (handle === null || typeof handle === 'string') return handle;
  try {
    // Something put in the file's place since the look is refused here, before it is read.
    if (!(await handle.stat()).isFile()) return 'special';
    // So is a file the open reached through a folder swapped for a link since its look.
    if (realRoot !== null && !(await openedBelow(handle, realRoot))) return 'link';
    return { text: await handle.readFile('utf8') };
  } finally {
    await handle.close();
  }
}

/** The folder whose entries name each open file of this process by its descriptor, on Linux; null elsewhere. */
const OPEN_FILE_PATHS: string | null = process.platform === 'linux' ? '/proc/self/fd' : null;

/**
 * The real path of `root`, as bytes, where the path of an open file can be had (Linux); null elsewhere, or when
 * the real path cannot be had.
 */
async function realPathWhereOpenPathsShow(root: string): Promise<Buffer | null> {
  if (OPEN_FILE_PATHS === null) return null;
  try {
    return await fs.realpath(root, { encoding: 'buffer' });
  } catch {
    return null;
  }
}

/**
 * True when the path the kernel gives for the open file `handle` lies below `realRoot`, or when it gives none (no
 * `/proc` mounted), where the looks alone stand; false when it lies anywhere else.
 */
async function openedBelow(handle: FileHandle, realRoot: Buffer): Promise<boolean> {
  let opened: Buffer;
  try {
    opened = await fs.readlink(`${OPEN_FILE_PATHS}/${handle.fd}`, { encoding: 'buffer' });
  } catch {
    return true;
  }
  const separator = Buffer.from(path.sep);
  const below = realRoot.subarray(realRoot.length - separator.length).equals(separator)
    ? realRoot
    : Buffer.concat([realRoot, separator]);
  return opened.length > below.length && opened.subarray(0, below.length).equals(below);
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
