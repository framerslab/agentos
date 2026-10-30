/**
 * @fileoverview Markdown importer for AgentOS memory brain.
 *
 * Recursively walks a directory of Markdown files and inserts each file as a
 * memory trace in the target `Brain`.  Front-matter fields (parsed via
 * `gray-matter`) are mapped to trace columns; the document body becomes the
 * trace content.
 *
 * A file's front-matter `scopeId`, when it is a string, names the scope id
 * the trace is filed under, in `memory_traces.scope_id` and in its metadata;
 * a file that names none files under `''`. `MarkdownExporter` writes it for a
 * trace filed under a scope id, so an export carries each trace's scope id
 * out and back in.
 *
 * Deduplication works inside the file's scope and scope id: a file whose body
 * a trace there holds, or whose body's SHA-256 a trace there names as
 * `metadata.import_hash` or `metadata.content_hash`, is skipped, whichever
 * writer stored that trace. So is a file whose front-matter `id` names a trace
 * there whose text, without its leading and trailing whitespace, is the body:
 * that trace's own note, as `MarkdownExporter` writes it; `ObsidianImporter`
 * adds to that trace the tags and links its note holds that the trace lacks. A
 * trace the brain forgot counts as any other, so deduplication never brings it
 * back. A trace a release older than `memory_traces.scope_id` wrote holds `''`
 * in that column whatever scope id its metadata names; the import files such
 * traces under that scope id first (`fillScopeIds`), so another scope id's
 * trace is not taken for a file's duplicate.
 *
 * A Brain a learning layer serves holds its plain `user` and `persona` scope
 * ids in the encoded form (`scopeIdForm.ts`). A note that front matter marks
 * `scopeIdForm: encoded` was written by such a Brain's export, and its scope
 * id is taken as it is written; every other note's scope id is plain. Into a
 * Brain that holds the record, a plain note's id is encoded as it is written;
 * a marked note goes into a Brain without the record, which then gets it,
 * unless that Brain holds a plain id the record would read as another, in a
 * trace or a knowledge-graph copy: then the note is not imported and `errors`
 * names the record. Each note is written in a transaction of its own, which
 * reads the Brain's form first (on Postgres under the brain's form lock), so a
 * re-file or another import of the Brain that commits first is followed.
 *
 * @module memory/io/MarkdownImporter
 */

import { sha256 } from '../core/util/crossPlatformCrypto.js';
import { v4 as uuidv4 } from 'uuid';
import type { ImportOptions, ImportResult } from './facade/types.js';
import type { Brain } from '../retrieval/store/Brain.js';
import { readFrontMatter, type FrontMatterFile } from '../../../core/utils/frontMatter.js';
import { fillScopeIds } from '../retrieval/store/migrations/v2-to-v3.js';
import {
  ENCODED_SCOPE_ID_FORM,
  encodePlainScopeId,
  importScopeIdFormDecision,
  SCOPE_ID_FORM_KEY,
  writeScopeIdFormRecord,
} from '../retrieval/store/scopeIdForm.js';
import { duplicateTraceCondition, duplicateTraceParams } from './importScope.js';

// ---------------------------------------------------------------------------
// Line breaks
// ---------------------------------------------------------------------------

/**
 * A text with each line break written as `\n`, for comparing a note with a
 * trace's text: a note an editor saved again with CRLF or CR line endings
 * reads as the note the export wrote. A note that is imported keeps the line
 * endings its file holds.
 *
 * @param text - A note's body, a trace's text or a label.
 * @returns The text with each `\r\n` and each `\r` as `\n`.
 */
export function withLfLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * A trace the brain holds whose own note an import has met: the note's
 * front-matter `id` names it, and the note holds its text.
 */
export interface HeldTrace {
  /** The trace's id, as the note's front matter names it. */
  id: string;
  /** The trace's text, as the brain holds it. */
  content: string;
  /** The trace's `tags` column, a JSON array as the brain holds it. */
  tags: string;
}

/**
 * Parsed front-matter fields extracted from a Markdown trace file.
 * All fields are optional — the importer falls back to safe defaults.
 */
interface TraceFrontmatter {
  id?: string;
  type?: string;
  scope?: string;
  strength?: number;
  tags?: string[];
  createdAt?: number;
  /** The scope id the trace is filed under; a value that is not a string is ignored. */
  scopeId?: string;
  /** `encoded` on a note an encoded Brain's export wrote: its scope id is in the encoded form already. */
  scopeIdForm?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// MarkdownImporter
// ---------------------------------------------------------------------------

/**
 * Imports Markdown files from a directory into a `Brain`.
 *
 * **Usage:**
 * ```ts
 * const importer = new MarkdownImporter(brain);
 * const result = await importer.import('/path/to/vault');
 * console.log(result.imported, result.skipped);
 * ```
 */
export class MarkdownImporter {
  /**
   * @param brain - The target `Brain` to import into.
   */
  constructor(protected readonly brain: Brain) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Recursively walk `sourceDir`, parse every `.md` file, and insert traces.
   *
   * Non-Markdown files are silently ignored.  Files that fail to parse are
   * recorded in `result.errors` and processing continues.
   *
   * @param sourceDir - Directory to recursively scan for `.md` files.
   * @returns `ImportResult` with counts of imported, skipped, and errored items.
   */
  async import(sourceDir: string, options?: Pick<ImportOptions, 'dedup'>): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, skipped: 0, errors: [] };

    const files = await this._collectMarkdownFiles(sourceDir);

    // A trace an older release wrote holds scope_id '': filed under its scope id first, it is not read as ''.
    if (options?.dedup ?? true) await fillScopeIds(this.brain.adapter, this.brain.brainId);

    // What one note's handshake found in a Brain without the record, shared with the notes after it.
    const reserved: { found?: boolean } = {};
    for (const filePath of files) {
      await this._processFile(filePath, result, reserved, options);
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Protected helpers (overridden by ObsidianImporter)
  // -------------------------------------------------------------------------

  /**
   * Post-process a parsed file before it is inserted into the database.
   *
   * The base implementation is a no-op.  `ObsidianImporter` overrides this
   * to extract `[[wikilinks]]` and `#tags`.
   *
   * @param _filePath   - Absolute path of the source file.
   * @param _frontmatter - Parsed front-matter data.
   * @param _body       - Markdown body content.
   * @param _result     - Mutable result accumulator.
   * @param _traceId    - The ID assigned (or taken from front-matter) for this trace.
   */
  protected async postProcess(
    _filePath: string,
    _frontmatter: TraceFrontmatter,
    _body: string,
    _result: ImportResult,
    _traceId: string,
  ): Promise<void> {
    // No-op in base class.
  }

  /**
   * Whether a note's body holds a trace's text: the text without its leading
   * and trailing whitespace, which the import takes off a body, is the body,
   * each line break in both read as `\n` (see {@link withLfLineBreaks}).
   * A note whose front-matter `id` names a trace of its scope and scope id
   * that it holds is that trace's own note, and so its duplicate, also when
   * the trace's text begins or ends with whitespace. `ObsidianImporter` also
   * reads past the tag line and the links `ObsidianExporter` writes after the
   * text, and may read the brain's graph to do so, so an override may answer
   * with a promise.
   *
   * @param text - The text of the trace the note's `id` names.
   * @param body - The note's body, without its leading and trailing whitespace.
   * @returns `true` when the note holds the trace's text, or a promise of the answer.
   */
  protected holdsTraceText(text: string, body: string): boolean | Promise<boolean> {
    return withLfLineBreaks(text).trim() === withLfLineBreaks(body);
  }

  /**
   * Add to a trace what its own note holds beyond the trace, once the import
   * has found the note to be that trace's own note; the note then counts as
   * skipped. The base implementation adds nothing: a Markdown note holds only
   * the trace's text. `ObsidianImporter` adds the tags of the note's tag line
   * and the links of its **Related:** list that the trace does not hold yet.
   *
   * @param _trace  - The trace the note is the note of.
   * @param _body   - The note's body, without its leading and trailing whitespace.
   * @param _result - Mutable result accumulator.
   */
  protected async addNoteToHeldTrace(_trace: HeldTrace, _body: string, _result: ImportResult): Promise<void> {
    // No-op in base class.
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Recursively collect all `.md` file paths under `dir`.
   *
   * @param dir - Root directory to scan.
   * @returns Sorted list of absolute file paths.
   */
  private async _collectMarkdownFiles(dir: string): Promise<string[]> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const results: string[] = [];

    async function walk(current: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return; // Directory not readable — skip.
      }

      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(full);
        }
      }
    }

    await walk(dir);
    return results.sort();
  }

  /**
   * Parse and insert a single Markdown file.
   *
   * @param filePath - Absolute path to the `.md` file.
   * @param result   - Mutable `ImportResult` accumulator.
   * @param reserved - What the import's handshakes have found in a Brain
   *   without the record.
   */
  private async _processFile(
    filePath: string,
    result: ImportResult,
    reserved: { found?: boolean },
    options?: Pick<ImportOptions, 'dedup'>,
  ): Promise<void> {
    const fs = await import('node:fs/promises');
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      result.errors.push(`Cannot read ${filePath}: ${String(err)}`);
      return;
    }

    // Read as data: a block marked as JavaScript is dropped, never evaluated.
    let parsed: FrontMatterFile;
    try {
      parsed = readFrontMatter(raw);
    } catch (err) {
      result.errors.push(`Cannot parse front-matter in ${filePath}: ${String(err)}`);
      return;
    }

    const fm = parsed.data as TraceFrontmatter;
    const body = parsed.content.trim();

    if (!body) {
      result.skipped++;
      return;
    }

    const hash = await sha256(body);
    const scope = typeof fm.scope === 'string' ? fm.scope : 'user';
    // The front matter names the scope id; a file that names none, or names one that is not a string, files under ''.
    const namedScopeId = typeof fm.scopeId === 'string' ? fm.scopeId : '';
    const tags: string[] = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];

    // The note is written in a transaction of its own, which reads the Brain's scope-id form first.
    let written: { traceId: string } | { held: HeldTrace } | 'skipped' | 'refused';
    try {
      written = await this.brain.transaction(async (trx) => {
        const decision = await importScopeIdFormDecision(
          trx,
          this.brain,
          { encoded: fm.scopeIdForm === ENCODED_SCOPE_ID_FORM },
          { reserved },
        );
        if (decision.action === 'refuse') {
          result.errors.push(`${filePath}: ${SCOPE_ID_FORM_KEY}: ${decision.reason}`);
          return 'refused' as const;
        }
        const scopeId = decision.action === 'encode' ? encodePlainScopeId(scope, namedScopeId) : namedScopeId;

        // Dedup check, inside the file's scope and scope id.
        if (options?.dedup ?? true) {
          const existing = await trx.get<{ id: string }>(
            `SELECT id FROM memory_traces
              WHERE brain_id = ? AND scope = ? AND scope_id = ?
                AND ${duplicateTraceCondition(this.brain)}
              LIMIT 1`,
            [this.brain.brainId, scope, scopeId, ...duplicateTraceParams(hash, body)],
          );
          if (existing) return 'skipped' as const;
          const held = await this._heldTraceOfNote(trx, fm, scope, scopeId, body);
          if (held) return { held };
        }

        if (decision.action === 'record') await writeScopeIdFormRecord(trx, this.brain);
        const traceId = await this._resolveTraceId(trx, (typeof fm.id === 'string' && fm.id) ? fm.id : `mt_${uuidv4()}`);
        const meta: Record<string, unknown> = { import_hash: hash, source_file: filePath };
        // A trace loaded from the Brain reads its scope id in its metadata, so the metadata names it as the column does.
        if (scopeId !== '') meta.scopeId = scopeId;
        await trx.run(
          `INSERT INTO memory_traces
               (brain_id, id, type, scope, content, embedding, strength, created_at, last_accessed,
                retrieval_count, tags, emotions, metadata, deleted, scope_id)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, ?, '{}', ?, 0, ?)`,
          [
            this.brain.brainId,
            traceId,
            typeof fm.type === 'string' ? fm.type : 'episodic',
            scope,
            body,
            typeof fm.strength === 'number' ? fm.strength : 1.0,
            typeof fm.createdAt === 'number' ? fm.createdAt : Date.now(),
            JSON.stringify(tags),
            JSON.stringify(meta),
            scopeId,
          ],
        );
        return { traceId };
      });
    } catch (err) {
      result.errors.push(`Insert error for ${filePath}: ${String(err)}`);
      return;
    }
    if (written === 'refused') return;
    if (written === 'skipped') {
      result.skipped++;
      return;
    }
    if ('held' in written) {
      // The trace's own note: what it holds beyond the trace is added once the note's transaction has ended.
      await this.addNoteToHeldTrace(written.held, body, result);
      result.skipped++;
      return;
    }

    try {
      // Give subclasses a chance to handle wikilinks, extra tags, etc.
      await this.postProcess(filePath, fm, body, result, written.traceId);

      result.imported++;
    } catch (err) {
      result.errors.push(`Insert error for ${filePath}: ${String(err)}`);
    }
  }

  /**
   * The trace the brain holds whose own note a note is: its front-matter `id`
   * names a trace of the note's scope and scope id, and the note holds that
   * trace's text (see {@link holdsTraceText}). An export writes each trace's
   * id, so its import into the brain it came from adds nothing, whatever
   * whitespace surrounds a trace's text.
   *
   * @param trx     - The note's transaction.
   * @param fm      - The note's front matter.
   * @param scope   - The scope the note files under.
   * @param scopeId - The scope id the note files under.
   * @param body    - The note's body, without its leading and trailing whitespace.
   * @returns The trace, or `undefined` when the note is not the note of a trace the brain holds.
   */
  private async _heldTraceOfNote(
    trx: { get: Brain['get'] },
    fm: TraceFrontmatter,
    scope: string,
    scopeId: string,
    body: string,
  ): Promise<HeldTrace | undefined> {
    if (typeof fm.id !== 'string' || !fm.id) return undefined;
    const named = await trx.get<{ content: string; tags: string }>(
      'SELECT content, tags FROM memory_traces WHERE brain_id = ? AND id = ? AND scope = ? AND scope_id = ? LIMIT 1',
      [this.brain.brainId, fm.id, scope, scopeId],
    );
    if (!named || !(await this.holdsTraceText(named.content, body))) return undefined;
    return { id: fm.id, content: named.content, tags: named.tags };
  }

  private async _resolveTraceId(trx: { get: Brain['get'] }, preferredId: string): Promise<string> {
    const existing = await trx.get<{ id: string }>(
      'SELECT id FROM memory_traces WHERE brain_id = ? AND id = ? LIMIT 1',
      [this.brain.brainId, preferredId],
    );
    return existing ? `mt_${uuidv4()}` : preferredId;
  }
}
