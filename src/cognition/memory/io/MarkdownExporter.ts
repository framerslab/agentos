/**
 * @fileoverview Markdown exporter for AgentOS memory brain.
 *
 * Creates a directory of Markdown files — one per memory trace — organised
 * into a `{output}/{scope}/{type}/` folder hierarchy.  Each file contains
 * YAML front-matter (id, type, scope, strength, tags, createdAt) followed
 * by the plain-text trace content.
 *
 * The `gray-matter` library is used to serialise the front-matter block so
 * that the same library can later round-trip back via `MarkdownImporter`.
 *
 * A trace's scope, type and id name its folders and its file, so each is held
 * to the name rule in `core/utils/pathName` before anything is written, and the
 * file's resolved path must lie inside the export folder. Below the export
 * folder no folder or file is made or written through a link, symbolic or
 * hard, nothing but a regular file is written (a named pipe at a file's
 * place is refused at once, never waited on), and two traces whose
 * files would be one, where names ignore case or by the file system's own
 * reckoning, are not both written. A trace that fails any of these is left
 * out and reported in the export's result. The checks run as each folder is
 * made and each file opened; Node has no `openat`, so a process that swaps a
 * folder below the export folder for a link while the export runs is outside
 * what they stop.
 *
 * ## Folder layout
 * ```
 * {outputDir}/
 *   user/
 *     episodic/
 *       mt_abc123.md
 *       mt_def456.md
 *     semantic/
 *       mt_789.md
 *   thread/
 *     procedural/
 *       ...
 * ```
 *
 * @module memory/io/MarkdownExporter
 */

import fs, { type FileHandle } from 'node:fs/promises';
import { constants as fsConstants, type Stats } from 'node:fs';
import path from 'node:path';
import type { ExportOptions, ExportResult, RefusedExportTrace } from './facade/types.js';
import type { Brain } from '../retrieval/store/Brain.js';
import { writeFrontMatter } from '../../../core/utils/frontMatter.js';
import { pathNameProblem, resolveInsideFolder, type PathNameProblem } from '../../../core/utils/pathName.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Raw row shape from the `memory_traces` table. */
interface TraceRow {
  id: string;
  type: string;
  scope: string;
  content: string;
  strength: number;
  created_at: number;
  tags: string;
}

/** The trace fields a file's path is built from. */
type TracePathField = 'scope' | 'type' | 'id';

/**
 * The flags a trace's file is opened with: for writing, made when missing, and, where the platform has each flag
 * (Windows has neither), never through a symbolic link in the file's own place (`O_NOFOLLOW`) and never waiting
 * (`O_NONBLOCK`). Without `O_NONBLOCK`, an open for writing of a named pipe that no process reads waits for a
 * reader that may never come, and the export with it. The file is emptied only once the open file shows it is a
 * regular file with no second name.
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
 * The most trace files one export holds open at once. The files are opened, checked and written a batch of this many
 * at a time, in export order, so a large export does not run out of file descriptors.
 */
export const MAX_OPEN_TRACE_FILES = 64;

/** A trace's file, open for writing and checked, and the identity of the file the open reached. */
interface OpenedTraceFile {
  handle: FileHandle;
  /** The file's device and inode numbers, or null when the file system reports an inode of 0, which names no file. */
  identity: string | null;
}

/** Thrown by `traceRelativePath` for a trace whose scope, type or id is not a safe name; the export reports it. */
class RefusedTraceName extends Error {
  constructor(
    readonly field: TracePathField,
    readonly problem: PathNameProblem,
  ) {
    super(`the trace's ${field} is not a safe file or folder name (${problem})`);
    this.name = 'RefusedTraceName';
  }
}

// ---------------------------------------------------------------------------
// MarkdownExporter
// ---------------------------------------------------------------------------

/**
 * Exports memory traces as Markdown files with YAML front-matter.
 *
 * **Usage:**
 * ```ts
 * const exporter = new MarkdownExporter(brain);
 * await exporter.export('/path/to/vault');
 * ```
 */
export class MarkdownExporter {
  /**
   * @param brain - The `Brain` instance to read from.
   */
  constructor(protected readonly brain: Brain) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Export all memory traces as `.md` files into `outputDir`.
   *
   * Directories are created on demand, one name at a time. A trace is not
   * written, and is reported in the result, when its scope, type or id is not
   * a safe file or folder name, when its file would lie outside `outputDir`,
   * when a folder or file in its place under `outputDir` is a symbolic link or
   * its file has a second name (a hard link), when something other than a
   * regular file holds its file's place (a folder, a named pipe, a socket, a
   * device), or when an older trace's file is the same file, where names
   * ignore case or by the file system's own reckoning. Every other trace is
   * written. At most {@link MAX_OPEN_TRACE_FILES} files are open at once.
   *
   * @param outputDir - Root directory to write the Markdown vault into.
   * @param _options  - Optional export configuration (currently unused but
   *   accepted for API consistency with other exporters).
   * @returns The traces left out, with the reason for each.
   * @throws The first error met opening or writing a file for a reason other
   *   than the refusals above, such as a full disk, once every other trace has
   *   been tried.
   */
  async export(outputDir: string, _options?: ExportOptions): Promise<ExportResult> {
    // Oldest first, so of two traces whose files would be one, the older is written.
    const traces = await this.brain.all<TraceRow>(
      'SELECT id, type, scope, content, strength, created_at, tags FROM memory_traces WHERE deleted = 0 ORDER BY created_at, id',
    );

    // Every trace is placed before any folder is made or file written.
    const refused: RefusedExportTrace[] = [];
    const placed: Array<{ file: string; trace: TraceRow }> = [];
    const taken = new Set<string>();
    for (const trace of traces) {
      const place = this._placeTrace(outputDir, trace);
      if (typeof place !== 'string') {
        refused.push(place);
        continue;
      }
      // Paths that differ only in case or in Unicode form name one file where names ignore case (macOS, Windows).
      const key = caseFoldKey(place);
      if (taken.has(key)) {
        refused.push({ id: String(trace.id), field: 'path', problem: 'collision' });
        continue;
      }
      taken.add(key);
      placed.push({ file: place, trace });
    }

    // The export folder is the caller's: it is made when missing and used as it is, even when it is a link. Below
    // it, every folder is made one name at a time, and no folder or file is written through a link.
    await fs.mkdir(outputDir, { recursive: true });
    const root = path.resolve(outputDir);
    const linkFree = new Map<string, boolean>();
    const writable: Array<{ file: string; trace: TraceRow }> = [];
    for (const entry of placed) {
      const folder = path.dirname(entry.file);
      let free = linkFree.get(folder);
      if (free === undefined) {
        free = await makeFoldersOutsideLinks(root, path.relative(root, folder));
        linkFree.set(folder, free);
      }
      if (free) {
        writable.push(entry);
      } else {
        refused.push({ id: String(entry.trace.id), field: 'path', problem: 'link' });
      }
    }

    // The files are opened, checked and written a batch at a time, in export order, oldest first. In a batch every
    // file is opened and checked before any is emptied, and each open file's identity is claimed in export order; the
    // claims hold from batch to batch, since a written file keeps its identity once closed. Of two traces whose files
    // the file system made one in a way the key above does not foresee, such as a fold by a table of its own or a
    // Windows short name, the older is written and the newer left out as a collision.
    const claimed = new Set<string>();
    let failure: { error: unknown } | undefined;
    for (let start = 0; start < writable.length; start += MAX_OPEN_TRACE_FILES) {
      const batch = writable.slice(start, start + MAX_OPEN_TRACE_FILES);
      const opened = await Promise.allSettled(batch.map(({ file, trace }) => openTraceFile(file, String(trace.id))));
      const handles: FileHandle[] = [];
      for (const outcome of opened) {
        if (outcome.status !== 'fulfilled') continue;
        const value = outcome.value;
        if ('handle' in value) handles.push(value.handle);
      }
      try {
        const writes: Array<Promise<void>> = [];
        for (let index = 0; index < batch.length; index++) {
          const outcome = opened[index];
          const { trace } = batch[index];
          if (outcome.status === 'rejected') {
            failure ??= { error: outcome.reason };
            continue;
          }
          const value = outcome.value;
          if (!('handle' in value)) {
            refused.push(value);
            continue;
          }
          if (value.identity !== null) {
            if (claimed.has(value.identity)) {
              refused.push({ id: String(trace.id), field: 'path', problem: 'collision' });
              continue;
            }
            claimed.add(value.identity);
          }
          writes.push(this._fillTrace(value.handle, trace));
        }
        for (const written of await Promise.allSettled(writes)) {
          if (written.status === 'rejected') failure ??= { error: written.reason };
        }
      } finally {
        await Promise.allSettled(handles.map((handle) => handle.close()));
      }
    }
    // A file that could not be opened or written for a reason other than a refusal, such as a full disk, fails the
    // export once every other trace has been tried.
    if (failure) throw failure.error;
    return { refused };
  }

  // -------------------------------------------------------------------------
  // Protected helpers (overridden by ObsidianExporter)
  // -------------------------------------------------------------------------

  /**
   * Build the Markdown content for a single trace.
   *
   * Subclasses (e.g. `ObsidianExporter`) override this to inject wiki-links
   * and `#tag` decorations into the body.
   *
   * @param trace - Parsed trace row from the database.
   * @returns Full Markdown file content (front-matter + body).
   */
  protected buildFileContent(trace: TraceRow): string {
    let tags: string[] = [];
    try {
      tags = JSON.parse(trace.tags) as string[];
    } catch {
      tags = [];
    }

    // gray-matter writes the YAML block. The trace's content is written as it
    // is and never read for front matter of its own.
    return writeFrontMatter(trace.content, {
      id: trace.id,
      type: trace.type,
      scope: trace.scope,
      strength: trace.strength,
      tags,
      createdAt: trace.created_at,
    });
  }

  /**
   * Determine the relative file path for a trace within the output directory.
   *
   * Default: `{scope}/{type}/{id}.md`. Each of the three must be a safe file
   * or folder name (see `pathNameProblem`), or the trace is refused. Whatever
   * a subclass returns, the export writes the file only when its resolved
   * path lies inside the output directory.
   *
   * @param trace - The trace row.
   * @returns Relative path string (no leading slash).
   * @throws When the trace's scope, type or id is not a safe name; the export
   *   reports such a trace in its result instead of writing it.
   */
  protected traceRelativePath(trace: TraceRow): string {
    return path.join(traceName(trace, 'scope'), traceName(trace, 'type'), `${traceName(trace, 'id')}.md`);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * The absolute path of a trace's file inside `outputDir`, or the reason the
   * trace is refused: a scope, type or id that is not a safe name, or a path
   * outside `outputDir`.
   *
   * @param outputDir - Root output directory.
   * @param trace     - The trace row.
   */
  private _placeTrace(outputDir: string, trace: TraceRow): string | RefusedExportTrace {
    let relPath: string;
    try {
      relPath = this.traceRelativePath(trace);
    } catch (err) {
      if (!(err instanceof RefusedTraceName)) throw err;
      return { id: String(trace.id), field: err.field, problem: err.problem };
    }
    return resolveInsideFolder(outputDir, [relPath]) ?? { id: String(trace.id), field: 'path', problem: 'outside' };
  }

  /**
   * Write a trace into its file, opened and checked by `openTraceFile` and
   * claimed for this trace alone: the content is built, then the file is
   * emptied and written.
   *
   * @param handle - The trace's open file.
   * @param trace  - Trace row to serialise.
   */
  private async _fillTrace(handle: FileHandle, trace: TraceRow): Promise<void> {
    const content = this.buildFileContent(trace);
    await handle.truncate(0);
    await handle.writeFile(content, 'utf8');
  }
}

/**
 * Open a trace's file for writing, in a folder already made, and check what the open reached. A symbolic link in
 * the file's place is refused before the open, and where the platform has `O_NOFOLLOW` the open refuses one put
 * there since. A folder fails the open, and where the platform has `O_NONBLOCK` so does a named pipe that no process
 * reads, at once. An open file that is not a regular file (a named pipe that a process reads, a device) is refused,
 * and so is a file with a second name (a hard link), which is the same file as that name and may lie outside the
 * export folder. Nothing is emptied or written here.
 *
 * @param file - Absolute path of the trace's file, inside the output directory.
 * @param id   - The trace's id, as a refusal names it.
 * @returns The open file and its identity, or the refusal: `link` or `special`.
 */
async function openTraceFile(file: string, id: string): Promise<OpenedTraceFile | RefusedExportTrace> {
  const refusal = (problem: 'link' | 'special'): RefusedExportTrace => ({ id, field: 'path', problem });
  if ((await lstatOrNull(file))?.isSymbolicLink()) return refusal('link');
  const handle = await fs.open(file, OPEN_FLAGS).catch((err: unknown) => {
    const code = String((err as NodeJS.ErrnoException).code);
    if (LINK_OPEN_CODES.has(code)) return 'link' as const;
    if (SPECIAL_OPEN_CODES.has(code)) return 'special' as const;
    throw err;
  });
  if (typeof handle === 'string') return refusal(handle);
  let handedOver = false;
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return refusal('special');
    if (stat.nlink > 1n) return refusal('link');
    handedOver = true;
    return { handle, identity: stat.ino === 0n ? null : `${stat.dev}:${stat.ino}` };
  } finally {
    if (!handedOver) await handle.close();
  }
}

/**
 * The key two places share when a file system that ignores case and Unicode form (macOS, Windows) makes them one
 * file. Lower case, then upper, then lower again: lower-casing first keeps every pair that lower-casing alone joins,
 * and the round through upper case joins letters that lower-casing alone keeps apart but such a file system folds
 * together, such as the long s and s, the final sigma and sigma, and the micro sign and mu. The key also joins a
 * few names those file systems keep apart, such as ß and ss; the newer of two such traces is left out.
 *
 * @param place - The absolute path of a trace's file.
 */
function caseFoldKey(place: string): string {
  return place.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC');
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

/**
 * Make the folders `relative` names under `root`, one name at a time, and stop at a link. A folder this makes is
 * never a link, so a file written into it stays under `root`.
 *
 * @param root     - The export folder.
 * @param relative - The folder's path under `root`.
 * @returns True when every folder is in place and none of them is a link.
 */
async function makeFoldersOutsideLinks(root: string, relative: string): Promise<boolean> {
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
 * The trace's `field` as one file or folder name: its value as text, once the
 * name rule accepts it.
 *
 * @throws RefusedTraceName when the value is not a safe name.
 */
function traceName(trace: TraceRow, field: TracePathField): string {
  const name = String(trace[field]);
  const problem = pathNameProblem(name);
  if (problem) throw new RefusedTraceName(field, problem);
  return name;
}
