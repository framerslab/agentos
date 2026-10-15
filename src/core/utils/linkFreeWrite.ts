/**
 * @fileoverview Writing and reading below a folder whose contents another process may change: folders are made
 * one name at a time and never through a link, a file is opened for writing never through a link, never waiting,
 * and only when it is a regular file with one name, a file is made only in a place that nothing holds, and a file
 * is read never through a link below the folder, never waiting, and only when it is a regular file.
 *
 * The Markdown and Obsidian memory exporters write a file per trace below an export folder, and the skill exporter
 * writes a tool's files below a skills folder. Whoever can write below such a folder could put there a link that
 * leads elsewhere, a second name for a file elsewhere, or a named pipe that holds a writer up, so both write
 * through the functions here. The capability manifest scanner reads a capability's files, the skill loader a
 * skill's `SKILL.md` and the soul loader a soul's files, and the soul loader makes the soul's `memory/` folder and
 * the files that start it. A link there could lead a read or a write to a file elsewhere, and a named pipe could
 * hold a read up, so each reads and makes those files through the functions here, below the folder that holds the
 * capability's, skill's or soul's folder, so that folder is looked at too. The soul loader also loads
 * synchronously, through the synchronous forms. The folder a function is given is the caller's and may be a link.
 * The checks run as each folder is made or looked at and each file opened; Node has no `openat`, so a process that
 * swaps a folder for a link between a check and the write or read is outside what they stop, except that on Linux
 * a read also checks the path the kernel gives for the file it opened.
 *
 * A function here that takes a path below a folder refuses an absolute path, and a path with a `.` or `..` name,
 * before it looks at anything.
 *
 * @module agentos/core/utils/linkFreeWrite
 */

import fs, { type FileHandle } from 'node:fs/promises';
import fsSync, { constants as fsConstants, type Stats } from 'node:fs';
import path from 'node:path';

import { describeRefusedName } from './pathName.js';

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

/**
 * The flags a file is made with: write only, and made by this open or not opened at all (`O_CREAT` with `O_EXCL`),
 * so the open fails on anything already in the file's place, a symbolic link among them, whether or not it leads
 * anywhere, and opens nothing that is there.
 */
const CREATE_FLAGS: number = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_LINK_NO_WAIT;

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
 * The separators a path below a folder is split into names at: the slash, and on Windows the backslash too, since
 * Node's path functions read both as separators there.
 */
const NAME_SEPARATORS: RegExp = path.sep === '\\' ? /[\\/]/ : /\//;

/**
 * Why a file was not opened: `link` when a symbolic link holds its place or the file has a second name (a hard
 * link), or, for a read, when a symbolic link holds the place of a folder on the way to it; and `special` when
 * something other than a regular file holds its place (a folder, a named pipe, a socket, a device).
 */
export type OpenRefusal = 'link' | 'special';

/**
 * Why, on Linux, a file was read without the full check of the path the kernel gives for it (see
 * {@link readFileOutsideLinks}), the read standing on the looks alone or on a looser bound:
 * - `'realpath'`: a real path the check compares with could not be had. When the real path of the folder read below
 *   could be had and only that of {@link ReadOutsideLinksOptions.within} could not, the file was still checked to
 *   lie below the folder read below; otherwise it was not checked.
 * - `'proc'`: `/proc` gave no path for the open file, as when it is not mounted, so the file was not checked.
 *
 * Elsewhere than Linux no such check is made, and none is reported.
 */
export type UncheckedOpenPath = 'realpath' | 'proc';

/** A file that {@link readFileOutsideLinks} or {@link readFileOutsideLinksSync} read. */
export interface FileReadOutsideLinks {
  /** The file's text, read as UTF-8. */
  text: string;
  /** Set only on Linux, when the path of the file the open reached was not fully checked: why. */
  unchecked?: UncheckedOpenPath;
}

/** What {@link readFileOutsideLinks} and {@link readFileOutsideLinksSync} check the file the open reached against. */
export interface ReadOutsideLinksOptions {
  /**
   * The folder that, on Linux, the file the open reached must lie below: the folder read below, or a folder on the
   * way to the file; the folder read below when not given. A caller that reads the files of many folders below one
   * folder, such as each capability's files below the folder that holds every capability's folder, names the
   * file's own folder here, so a folder on the way swapped for a link into a sibling folder is refused too. Its real
   * path is taken before the looks and must be the real path of the folder read below followed by the names on the
   * way to it, so a link at any of those names is refused before any look.
   */
  within?: string;
}

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
 * @throws TypeError when `relative` is absolute or a name in it is `.` or `..`; nothing is looked at or made.
 */
export async function makeFoldersOutsideLinks(root: string, relative: string): Promise<boolean> {
  let dir = root;
  for (const name of namesBelow('makeFoldersOutsideLinks', relative)) {
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
 * The synchronous form of {@link makeFoldersOutsideLinks}, for a caller that cannot wait on a promise. It also stops
 * at anything other than a folder in a folder's place, such as a regular file or a named pipe, so that when it
 * returns true every folder is in place; {@link makeFoldersOutsideLinks} goes on past such an entry and leaves the
 * open of a file below it to fail.
 *
 * @param root     - The folder the others are made in. It may itself be a link.
 * @param relative - The folders' path under `root`.
 * @returns True when every folder is in place and none of them is a link; false when a link, or anything other than
 *   a folder, holds a folder's place.
 * @throws TypeError when `relative` is absolute or a name in it is `.` or `..`; nothing is looked at or made.
 */
export function makeFoldersOutsideLinksSync(root: string, relative: string): boolean {
  let dir = root;
  for (const name of namesBelow('makeFoldersOutsideLinksSync', relative)) {
    dir = path.join(dir, name);
    const entry = lstatOrNullSync(dir);
    if (entry) {
      // A link not followed is no folder, so this stops at a link too.
      if (!entry.isDirectory()) return false;
      continue;
    }
    try {
      fsSync.mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Something was put there since the look: look again.
      if (!fsSync.lstatSync(dir).isDirectory()) return false;
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
 * Make a file in a place that nothing holds, in a folder already made, and write `text` into it. The open makes
 * the file or fails (`O_CREAT` with `O_EXCL`), so it never opens what is already in the file's place: a symbolic
 * link there, one that leads nowhere among them, is never followed, and a named pipe or a device is never opened.
 * Nothing already in the place is changed. Synchronous, for a caller that cannot wait on a promise.
 *
 * @param file - Absolute path of the file.
 * @param text - What the file holds, written as UTF-8.
 * @returns True when the file was made and written; false when an entry of any kind was already in its place, which
 *   is left as it is.
 * @throws Any other error the open or the write meets.
 */
export function createFileOutsideLinksSync(file: string, text: string): boolean {
  let fd: number;
  try {
    fd = fsSync.openSync(file, CREATE_FLAGS, 0o666);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    fsSync.writeFileSync(fd, text);
  } finally {
    fsSync.closeSync(fd);
  }
  return true;
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
 * path that `options.within`, or `root` when it is not given, had before the looks, so a folder on the way that is
 * swapped for a link after its look and before the open is refused too. When a real path or the open file's path
 * cannot be had there, the file is read without that check, or checked against `root` alone, and the result's
 * `unchecked` says why. Elsewhere Node can neither open a file relative to a folder held open nor ask an open file
 * for its path, and such a swap is outside what the looks stop.
 *
 * @param root - The folder the file is read below. It may itself be a link.
 * @param relative - The file's path under `root`, its names joined by the platform's separator, as `path.relative`
 *   gives it. An absolute path, or one with a name that is `.` or `..`, is refused before any look, since the walk
 *   would start elsewhere or leave `root`.
 * @param options - The folder the file must lie below on Linux ({@link ReadOutsideLinksOptions}).
 * @returns The file's text, read as UTF-8, with `unchecked` when the check of its path did not run in full; `link`
 *   when a symbolic link holds the file's place or a folder's on the way, or, on Linux, when the file the open
 *   reached lies outside the folder it must lie below or a link is on the way from `root` to `options.within`;
 *   `special` when something other than a regular file holds the file's place; or null when no file is there.
 * @throws TypeError when `relative` is absolute or a name in it is `.` or `..`, or when `options.within` is neither
 *   `root` nor a folder on the way to the file; nothing is looked at or read.
 * @throws Any other error the looks, the open or the read meet.
 */
export async function readFileOutsideLinks(
  root: string,
  relative: string,
  options: ReadOutsideLinksOptions = {},
): Promise<FileReadOutsideLinks | OpenRefusal | null> {
  const names = namesBelow('readFileOutsideLinks', relative);
  // With no name, the path is the root itself, a folder.
  if (names.length === 0) return 'special';
  const toWithin = namesToWithin('readFileOutsideLinks', root, names, options.within);
  // Taken before the looks: a link put on the way after them does not move it.
  const bound = await openPathBound(root, toWithin);
  if (bound === 'link') return 'link';
  let place = root;
  for (let index = 0; index < names.length; index++) {
    place = path.join(place, names[index]);
    const step = readStep(await lstatOrNull(place), index === names.length - 1);
    if (step !== 'on') return step;
  }
  const handle = await fs.open(place, READ_FLAGS).catch(readOpenRefusal);
  if (handle === null || typeof handle === 'string') return handle;
  try {
    // Something put in the file's place since the look is refused here, before it is read.
    if (!(await handle.stat()).isFile()) return 'special';
    // So is a file the open reached through a folder swapped for a link since its look.
    const check = checkOpenedPath(bound, bound.real === null ? null : await openedPath(handle));
    if (check === 'link') return 'link';
    return readResult(await handle.readFile('utf8'), check);
  } finally {
    await handle.close();
  }
}

/**
 * The synchronous form of {@link readFileOutsideLinks}, for a caller that cannot wait on a promise. It looks, opens
 * and checks the same way, so a named pipe is refused at once rather than holding the thread up.
 *
 * @param root - The folder the file is read below. It may itself be a link.
 * @param relative - The file's path under `root`, as {@link readFileOutsideLinks} takes it.
 * @param options - The folder the file must lie below on Linux, as {@link readFileOutsideLinks} takes it.
 * @returns What {@link readFileOutsideLinks} returns.
 * @throws TypeError when `relative` is absolute or a name in it is `.` or `..`, or when `options.within` is neither
 *   `root` nor a folder on the way to the file; nothing is looked at or read.
 * @throws Any other error the looks, the open or the read meet.
 */
export function readFileOutsideLinksSync(
  root: string,
  relative: string,
  options: ReadOutsideLinksOptions = {},
): FileReadOutsideLinks | OpenRefusal | null {
  const names = namesBelow('readFileOutsideLinksSync', relative);
  // With no name, the path is the root itself, a folder.
  if (names.length === 0) return 'special';
  const toWithin = namesToWithin('readFileOutsideLinksSync', root, names, options.within);
  // Taken before the looks: a link put on the way after them does not move it.
  const bound = openPathBoundSync(root, toWithin);
  if (bound === 'link') return 'link';
  let place = root;
  for (let index = 0; index < names.length; index++) {
    place = path.join(place, names[index]);
    const step = readStep(lstatOrNullSync(place), index === names.length - 1);
    if (step !== 'on') return step;
  }
  let fd: number;
  try {
    fd = fsSync.openSync(place, READ_FLAGS);
  } catch (err) {
    return readOpenRefusal(err);
  }
  try {
    // Something put in the file's place since the look is refused here, before it is read.
    if (!fsSync.fstatSync(fd).isFile()) return 'special';
    // So is a file the open reached through a folder swapped for a link since its look.
    const check = checkOpenedPath(bound, bound.real === null ? null : openedPathSync(fd));
    if (check === 'link') return 'link';
    return readResult(fsSync.readFileSync(fd, 'utf8'), check);
  } finally {
    fsSync.closeSync(fd);
  }
}

/**
 * The names of `relative`, a path below a folder, in order, with empty names left out (`a//b` is `a` then `b`).
 *
 * @param caller - The function given the path, for the error message.
 * @param relative - The path below the folder.
 * @throws TypeError when `relative` is absolute, or when a name in it is `.` or `..`: the names are walked from the
 *   folder one at a time, and such a path would start the walk elsewhere, or lead it off the folder or above it.
 */
function namesBelow(caller: string, relative: string): string[] {
  if (path.isAbsolute(relative)) {
    throw new TypeError(`${caller}: the path ${describeRefusedName(relative)} is absolute; give a path below the folder`);
  }
  const names = relative.split(NAME_SEPARATORS).filter((name) => name.length > 0);
  const dots = names.find((name) => name === '.' || name === '..');
  if (dots !== undefined) {
    throw new TypeError(
      `${caller}: the path ${describeRefusedName(relative)} holds the name ${dots}; give a path below the folder with no . or .. name`,
    );
  }
  return names;
}

/**
 * The first of `names`, the names on the way to a file below `root`, that lead from `root` to the folder `within`:
 * none when `within` is not given or is `root` itself.
 *
 * @param caller - The function given the folder, for the error message.
 * @param root - The folder the file is read below.
 * @param names - The names from `root` to the file, the file's own name last.
 * @param within - The folder the file must lie below, when the caller names one.
 * @throws TypeError when `within` is neither `root` nor a folder on the way to the file.
 */
function namesToWithin(
  caller: string,
  root: string,
  names: readonly string[],
  within: string | undefined,
): string[] {
  if (within === undefined) return [];
  const relative = path.relative(path.resolve(root), path.resolve(within));
  const withinNames = relative.split(NAME_SEPARATORS).filter((name) => name.length > 0);
  // The file's own name is not a folder on the way to it.
  if (withinNames.length < names.length && withinNames.every((name, index) => name === names[index])) {
    return names.slice(0, withinNames.length);
  }
  throw new TypeError(
    `${caller}: the folder ${describeRefusedName(within)} is neither the folder read below nor a folder on the way ` +
      'to the file',
  );
}

/**
 * What the entry at one name on the way to a file means for a read: `on` to go on to the next name, null when no
 * file is there, or the refusal.
 *
 * @param entry - The entry at the name, a link not followed, or null when there is none.
 * @param last - True for the file's own name, false for a folder on the way to it.
 */
function readStep(entry: Stats | null, last: boolean): 'on' | OpenRefusal | null {
  if (entry === null) return null;
  if (entry.isSymbolicLink()) return 'link';
  if (last) return entry.isFile() ? 'on' : 'special';
  // Something other than a folder on the way: no file is there.
  return entry.isDirectory() ? 'on' : null;
}

/**
 * What a failed open for reading means: null when the file was taken away since the look, or the refusal for a link
 * or something other than a regular file in its place.
 *
 * @param err - The error the open failed with.
 * @throws `err` itself when it means anything else.
 */
function readOpenRefusal(err: unknown): OpenRefusal | null {
  const code = String((err as NodeJS.ErrnoException).code);
  // Taken away since the look.
  if (code === 'ENOENT') return null;
  if (LINK_OPEN_CODES.has(code)) return 'link';
  if (SPECIAL_OPEN_CODES.has(code)) return 'special';
  throw err;
}

/** The folder whose entries name each open file of this process by its descriptor, on Linux; null elsewhere. */
const OPEN_FILE_PATHS: string | null = process.platform === 'linux' ? '/proc/self/fd' : null;

/**
 * What a read checks the file its open reached against: the real path, as bytes, of the folder the file must lie
 * below, or null when the file is not checked; and, when the check is not the one asked for, why.
 */
interface OpenPathBound {
  real: Buffer | null;
  unchecked?: UncheckedOpenPath;
}

/**
 * The real paths a read below `root` checks the file its open reached against, taken before the looks, where the
 * path of an open file can be had (Linux): `root`'s, and that of the folder the names `toWithin` lead to below it.
 * `link` when the latter is not the former followed by those names, as when a link holds the place of one of them.
 */
async function openPathBound(root: string, toWithin: readonly string[]): Promise<OpenPathBound | 'link'> {
  if (OPEN_FILE_PATHS === null) return { real: null };
  const realRoot = await realPathOrNull(root);
  const realWithin =
    realRoot === null || toWithin.length === 0 ? null : await realPathOrNull(path.join(root, ...toWithin));
  return boundFromRealPaths(realRoot, realWithin, toWithin);
}

/** The synchronous form of {@link openPathBound}. */
function openPathBoundSync(root: string, toWithin: readonly string[]): OpenPathBound | 'link' {
  if (OPEN_FILE_PATHS === null) return { real: null };
  const realRoot = realPathOrNullSync(root);
  const realWithin =
    realRoot === null || toWithin.length === 0 ? null : realPathOrNullSync(path.join(root, ...toWithin));
  return boundFromRealPaths(realRoot, realWithin, toWithin);
}

/**
 * The bound from the real path of the folder read below and that of the folder the names `toWithin` lead to below
 * it, each null when it could not be had: the latter's when it is the former followed by those names, `link` when it
 * is anything else, and the former's, or none, when a real path could not be had.
 */
function boundFromRealPaths(
  realRoot: Buffer | null,
  realWithin: Buffer | null,
  toWithin: readonly string[],
): OpenPathBound | 'link' {
  if (realRoot === null) return { real: null, unchecked: 'realpath' };
  if (toWithin.length === 0) return { real: realRoot };
  // The inner folder's real path could not be had: the file is still checked against the outer one.
  if (realWithin === null) return { real: realRoot, unchecked: 'realpath' };
  const expected = Buffer.concat([withSeparator(realRoot), Buffer.from(toWithin.join(path.sep))]);
  return realWithin.equals(expected) ? { real: realWithin } : 'link';
}

/** The real path of `folder`, as bytes, or null when it cannot be had. */
async function realPathOrNull(folder: string): Promise<Buffer | null> {
  try {
    return await fs.realpath(folder, { encoding: 'buffer' });
  } catch {
    return null;
  }
}

/** The synchronous form of {@link realPathOrNull}. */
function realPathOrNullSync(folder: string): Buffer | null {
  try {
    return fsSync.realpathSync(folder, { encoding: 'buffer' });
  } catch {
    return null;
  }
}

/** The path the kernel gives for the open file `handle`, as bytes, or null when it gives none (no `/proc` mounted). */
async function openedPath(handle: FileHandle): Promise<Buffer | null> {
  try {
    return await fs.readlink(`${OPEN_FILE_PATHS}/${handle.fd}`, { encoding: 'buffer' });
  } catch {
    return null;
  }
}

/** The synchronous form of {@link openedPath}, for the open file descriptor `fd`. */
function openedPathSync(fd: number): Buffer | null {
  try {
    return fsSync.readlinkSync(`${OPEN_FILE_PATHS}/${fd}`, { encoding: 'buffer' });
  } catch {
    return null;
  }
}

/**
 * What the path the kernel gave for an open file means for a read checked against `bound`: `link` when the file lies
 * outside the folder it must lie below; otherwise why the check did not run in full, or undefined when it did or
 * none is made here. `opened` is null when the kernel gave no path, or when `bound` asks for no check.
 */
function checkOpenedPath(bound: OpenPathBound, opened: Buffer | null): 'link' | UncheckedOpenPath | undefined {
  if (bound.real === null) return bound.unchecked;
  // The looks alone stand.
  if (opened === null) return 'proc';
  return liesBelow(opened, bound.real) ? bound.unchecked : 'link';
}

/** A read's result: the file's text, and why the check of its path did not run in full when it did not. */
function readResult(text: string, unchecked: UncheckedOpenPath | undefined): FileReadOutsideLinks {
  return unchecked === undefined ? { text } : { text, unchecked };
}

/** `folder`, a path as bytes, ending with the separator. */
function withSeparator(folder: Buffer): Buffer {
  const separator = Buffer.from(path.sep);
  return folder.subarray(folder.length - separator.length).equals(separator)
    ? folder
    : Buffer.concat([folder, separator]);
}

/** True when the path `opened` lies below the folder whose real path is `real`, both as bytes; that folder is not. */
function liesBelow(opened: Buffer, real: Buffer): boolean {
  const below = withSeparator(real);
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

/** The synchronous form of {@link lstatOrNull}. */
function lstatOrNullSync(file: string): Stats | null {
  return fsSync.lstatSync(file, { throwIfNoEntry: false }) ?? null;
}
