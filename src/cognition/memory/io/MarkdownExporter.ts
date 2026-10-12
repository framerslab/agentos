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
 * file's resolved path must lie inside the export folder. A trace that fails
 * either check is left out and reported in the export's result.
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
   * Directories are created on demand (equivalent to `mkdir -p`). A trace
   * whose scope, type or id is not a safe file or folder name, or whose file
   * would lie outside `outputDir`, is not written; it is reported in the
   * result, and every other trace is written.
   *
   * @param outputDir - Root directory to write the Markdown vault into.
   * @param _options  - Optional export configuration (currently unused but
   *   accepted for API consistency with other exporters).
   * @returns The traces left out, with the reason for each.
   */
  async export(outputDir: string, _options?: ExportOptions): Promise<ExportResult> {
    const traces = await this.brain.all<TraceRow>(
      'SELECT id, type, scope, content, strength, created_at, tags FROM memory_traces WHERE deleted = 0',
    );

    // Every trace is placed before any file is written.
    const refused: RefusedExportTrace[] = [];
    const placed: Array<{ file: string; trace: TraceRow }> = [];
    for (const trace of traces) {
      const place = this._placeTrace(outputDir, trace);
      if (typeof place === 'string') {
        placed.push({ file: place, trace });
      } else {
        refused.push(place);
      }
    }
    await Promise.all(placed.map(({ file, trace }) => this._writeTrace(file, trace)));
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
   * Write a single trace to disk.
   *
   * Creates any missing parent directories before writing.
   *
   * @param file  - Absolute path of the trace's file, inside the output directory.
   * @param trace - Trace row to serialise.
   */
  private async _writeTrace(file: string, trace: TraceRow): Promise<void> {
    // Ensure parent directory exists.
    await fs.mkdir(path.dirname(file), { recursive: true });

    const content = this.buildFileContent(trace);
    await fs.writeFile(file, content, 'utf8');
  }
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
