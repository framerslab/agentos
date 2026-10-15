/**
 * @fileoverview Markdown importer for AgentOS memory brain.
 *
 * Recursively walks a directory of Markdown files and inserts each file as a
 * memory trace in the target `Brain`.  Front-matter fields (parsed via
 * `gray-matter`) are mapped to trace columns; the document body becomes the
 * trace content.
 *
 * Deduplication uses SHA-256 of the content body — files already present in
 * the target brain (same hash in `metadata.import_hash`) are skipped.
 *
 * @module memory/io/MarkdownImporter
 */

import { sha256 } from '../core/util/crossPlatformCrypto.js';
import { v4 as uuidv4 } from 'uuid';
import type { ImportOptions, ImportResult } from './facade/types.js';
import type { Brain } from '../retrieval/store/Brain.js';
import { readFrontMatter, type FrontMatterFile } from '../../../core/utils/frontMatter.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

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

    for (const filePath of files) {
      await this._processFile(filePath, result, options);
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
   */
  private async _processFile(
    filePath: string,
    result: ImportResult,
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

    // Dedup check.
    const { dialect } = this.brain.features;
    if (options?.dedup ?? true) {
      const existing = await this.brain.get<{ id: string }>(
        `SELECT id FROM memory_traces WHERE brain_id = ? AND ${dialect.jsonExtract('metadata', '$.import_hash')} = ? LIMIT 1`,
        [this.brain.brainId, hash],
      );

      if (existing) {
        result.skipped++;
        return;
      }
    }

    const traceId = await this._resolveTraceId(
      (typeof fm.id === 'string' && fm.id) ? fm.id : `mt_${uuidv4()}`,
    );

    const tags: string[] = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
    const meta: Record<string, unknown> = { import_hash: hash, source_file: filePath };

    try {
      await this.brain.run(
        `INSERT INTO memory_traces
             (brain_id, id, type, scope, content, embedding, strength, created_at, last_accessed,
              retrieval_count, tags, emotions, metadata, deleted)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, ?, '{}', ?, 0)`,
        [
          this.brain.brainId,
          traceId,
          typeof fm.type === 'string' ? fm.type : 'episodic',
          typeof fm.scope === 'string' ? fm.scope : 'user',
          body,
          typeof fm.strength === 'number' ? fm.strength : 1.0,
          typeof fm.createdAt === 'number' ? fm.createdAt : Date.now(),
          JSON.stringify(tags),
          JSON.stringify(meta),
        ],
      );

      // Give subclasses a chance to handle wikilinks, extra tags, etc.
      await this.postProcess(filePath, fm, body, result, traceId);

      result.imported++;
    } catch (err) {
      result.errors.push(`Insert error for ${filePath}: ${String(err)}`);
    }
  }

  private async _resolveTraceId(preferredId: string): Promise<string> {
    const existing = await this.brain.get<{ id: string }>(
      'SELECT id FROM memory_traces WHERE brain_id = ? AND id = ? LIMIT 1',
      [this.brain.brainId, preferredId],
    );
    return existing ? `mt_${uuidv4()}` : preferredId;
  }
}
