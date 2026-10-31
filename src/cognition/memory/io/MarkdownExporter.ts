/**
 * @fileoverview Markdown exporter for AgentOS memory brain.
 *
 * Creates a directory of Markdown files — one per live memory trace of the
 * brain, never another brain's in the same database — organised into a
 * `{output}/{scope}/{type}/` folder hierarchy.  Each file contains
 * YAML front-matter (id, type, scope, scopeId when the trace is filed under
 * one, turnUserId when a second user filed it on another user's session,
 * strength, tags, createdAt) followed by the plain-text trace content.
 * A Brain a learning layer serves holds its plain `user` and `persona` scope
 * ids in the encoded form (`scopeIdForm.ts`); each note it exports says so
 * (`scopeIdForm: encoded`), so an import takes the note's scope id as it is
 * written. The brain's record of its form is read before and after its traces,
 * and the traces are read again when a re-file committed in between, so a
 * note's mark and its scope id agree.
 *
 * The `gray-matter` library is used to serialise the front-matter block so
 * that the same library can later round-trip back via `MarkdownImporter`.
 *
 * A trace's scope, type and id name its folders and its file, so each is held
 * to the name rule in `core/utils/pathName` before anything is written, and the
 * file's resolved path must lie inside the export folder. Below the export
 * folder no folder or file is made or written through a link, symbolic or
 * hard, and nothing but a regular file is written, a named pipe at a file's
 * place refused at once, never waited on (`core/utils/linkFreeWrite`). Two
 * traces whose files would be one, where names ignore case or by the file
 * system's own reckoning, are not both written. A trace that fails any of these is left
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
import path from 'node:path';
import type { ExportOptions, ExportResult, RefusedExportTrace } from './facade/types.js';
import type { Brain } from '../retrieval/store/Brain.js';
import { writeFrontMatter } from '../../../core/utils/frontMatter.js';
import { makeFoldersOutsideLinks, openFileOutsideLinks } from '../../../core/utils/linkFreeWrite.js';
import { pathNameProblem, resolveInsideFolder, type PathNameProblem } from '../../../core/utils/pathName.js';
import { parseTraceMetadata } from '../retrieval/store/tracePersistence.js';
import {
  brainHoldsScopeIdFormRecord,
  ENCODED_SCOPE_ID_FORM,
  readInOneScopeIdForm,
} from '../retrieval/store/scopeIdForm.js';
import { importedScopeId, importedTurnUserId } from './importScope.js';

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
  /**
   * The trace's scope id, as an import of its JSON row reads it: its metadata's `scopeId`, else its `scope_id`
   * column; `''` for a trace filed under none.
   */
  scope_id: string;
  /** `encoded` for a trace of a Brain that holds the encoded scope-id form, whose note says so. */
  scopeIdForm?: string;
  /** The second user who filed the trace on another user's session (its metadata's `turnUserId`), when one did. */
  turnUserId?: string;
}

/** The trace fields a file's path is built from. */
type TracePathField = 'scope' | 'type' | 'id';

/**
 * The most trace files one export holds open at once. The files are opened, checked and written a batch of this many
 * at a time, in export order, so a large export does not run out of file descriptors.
 */
export const MAX_OPEN_TRACE_FILES = 64;

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
   * Export the brain's live memory traces as `.md` files into `outputDir`.
   * Another brain's traces in the same database are not read.
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
    // Oldest first, so of two traces whose files would be one, the older is written. The brain's record of its
    // scope-id form is read with the rows, in one form.
    const { value: rows, encoded } = await readInOneScopeIdForm(
      () => brainHoldsScopeIdFormRecord(this.brain),
      () =>
        this.brain.all<TraceRow & { metadata: string | null }>(
          `SELECT id, type, scope, content, strength, created_at, tags, scope_id, metadata FROM memory_traces
           WHERE brain_id = ? AND deleted = 0 ORDER BY created_at, id`,
          [this.brain.brainId],
        ),
    );
    // The metadata is read for the scope id and a second user's id alone: a row a release older than the column wrote
    // after this brain opened holds '' there and names its scope id in the metadata, where reads find it.
    const traces: TraceRow[] = rows.map(({ metadata, ...trace }) => {
      const meta = parseTraceMetadata(metadata);
      const turnUserId = importedTurnUserId(meta);
      return {
        ...trace,
        scope_id: importedScopeId(meta, trace.scope_id),
        ...(encoded ? { scopeIdForm: ENCODED_SCOPE_ID_FORM } : {}),
        ...(turnUserId !== '' ? { turnUserId } : {}),
      };
    });

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
      const opened = await Promise.allSettled(batch.map(({ file }) => openFileOutsideLinks(file)));
      const handles: FileHandle[] = [];
      for (const outcome of opened) {
        if (outcome.status !== 'fulfilled') continue;
        const value = outcome.value;
        if (typeof value !== 'string') handles.push(value.handle);
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
          if (typeof value === 'string') {
            refused.push({ id: String(trace.id), field: 'path', problem: value });
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
        // A file whose close fails may not hold what was written, so that fails the export too.
        for (const closed of await Promise.allSettled(handles.map((handle) => handle.close()))) {
          if (closed.status === 'rejected') failure ??= { error: closed.reason };
        }
      }
    }
    // A file that could not be opened, written or closed for a reason other than a refusal, such as a full disk,
    // fails the export once every other trace has been tried.
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
    return writeFrontMatter(trace.content, this.frontMatterOf(trace, tags));
  }

  /**
   * The front-matter fields of a trace's file, which `MarkdownImporter` reads
   * back: its id, type, scope, strength, tags and creation time, and its scope
   * id as `scopeId` when the trace is filed under one. A trace filed under
   * `''` writes no `scopeId`, and its import files it under `''`. A trace of a
   * Brain that holds the encoded scope-id form writes `scopeIdForm: encoded`,
   * so an import takes its scope id as it is written. A trace a second user
   * filed on another user's session writes that user's id as `turnUserId`, so
   * its import files it as that user's trace, which a delete of the user's
   * traces finds.
   *
   * @param trace - The trace row.
   * @param tags  - The trace's tags, parsed.
   */
  protected frontMatterOf(trace: TraceRow, tags: string[]): Record<string, unknown> {
    return {
      id: trace.id,
      type: trace.type,
      scope: trace.scope,
      ...(trace.scope_id ? { scopeId: trace.scope_id } : {}),
      ...(trace.scopeIdForm ? { scopeIdForm: trace.scopeIdForm } : {}),
      ...(trace.turnUserId ? { turnUserId: trace.turnUserId } : {}),
      strength: trace.strength,
      tags,
      createdAt: trace.created_at,
    };
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
   * Write a trace into its file, opened and checked by `openFileOutsideLinks`
   * and claimed for this trace alone: the content is built, then the file is
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
 * The key two places share when a file system that ignores case and Unicode form (macOS, Windows) makes them one
 * file. Each character is lower-cased, then, when its upper case is one character, upper-cased and lower-cased
 * again. Lower-casing first joins every pair that lower-casing alone joins, and the round through upper case joins
 * letters that lower-casing alone keeps apart but such a file system folds together, such as the long s and s, the
 * final sigma and sigma, and the micro sign and mu. A letter whose upper case is longer, such as ß (SS), keeps its
 * lower case, so ß and ss stay apart, as those file systems keep them.
 *
 * @param place - The absolute path of a trace's file.
 */
function caseFoldKey(place: string): string {
  let key = '';
  for (const character of place.normalize('NFC')) {
    const lower = character.toLowerCase();
    const upper = lower.toUpperCase();
    key += [...upper].length === 1 ? upper.toLowerCase() : lower;
  }
  return key.normalize('NFC');
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
