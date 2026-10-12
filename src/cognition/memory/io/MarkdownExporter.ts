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
 * hard, and two traces whose files would be one where names ignore case are
 * not both written. A trace that fails any of these is left out and reported
 * in the export's result. The checks run as each folder is made and each file
 * opened; Node has no `openat`, so a process that swaps a folder below the
 * export folder for a link while the export runs is outside what they stop.
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

import fs from 'node:fs/promises';
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
 * The flags a trace's file is opened with: for writing, made when missing, and, where the platform has the flag
 * (`O_NOFOLLOW`, which Windows lacks), never through a symbolic link in the file's own place. The file is emptied
 * only once the open file shows it has no second name.
 */
const OPEN_FLAGS: number =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  (fsConstants.O_NOFOLLOW !== undefined ? fsConstants.O_NOFOLLOW : 0);

/** The codes an open with `O_NOFOLLOW` fails with when a symbolic link holds the file's place (EMLINK on FreeBSD). */
const LINK_OPEN_CODES: ReadonlySet<string> = new Set(['ELOOP', 'EMLINK']);

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
   * its file has a second name (a hard link), or when an older trace's file is
   * the same file where names ignore case. Every other trace is written.
   *
   * @param outputDir - Root directory to write the Markdown vault into.
   * @param _options  - Optional export configuration (currently unused but
   *   accepted for API consistency with other exporters).
   * @returns The traces left out, with the reason for each.
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
      const key = place.normalize('NFC').toLowerCase();
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
    const written = await Promise.all(writable.map(({ file, trace }) => this._writeTrace(file, trace)));
    for (const refusal of written) {
      if (refusal) refused.push(refusal);
    }
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
   * Write a single trace to disk, into a folder already made, and never
   * through a link. A symbolic link in the file's place is refused before the
   * open, and where the platform has `O_NOFOLLOW` the open refuses one put
   * there since. A file with a second name (a hard link) is the same file as
   * that name, which may be outside the export folder, so the open file is
   * refused before it is emptied.
   *
   * @param file  - Absolute path of the trace's file, inside the output directory.
   * @param trace - Trace row to serialise.
   * @returns The refusal when a link holds the file's place, or null once the file is written.
   */
  private async _writeTrace(file: string, trace: TraceRow): Promise<RefusedExportTrace | null> {
    const linked: RefusedExportTrace = { id: String(trace.id), field: 'path', problem: 'link' };
    if ((await lstatOrNull(file))?.isSymbolicLink()) return linked;
    const handle = await fs.open(file, OPEN_FLAGS).catch((err: unknown) => {
      if (LINK_OPEN_CODES.has(String((err as NodeJS.ErrnoException).code))) return null;
      throw err;
    });
    if (handle === null) return linked;
    try {
      if ((await handle.stat()).nlink > 1) return linked;
      await handle.truncate(0);
      await handle.writeFile(this.buildFileContent(trace), 'utf8');
      return null;
    } finally {
      await handle.close();
    }
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
