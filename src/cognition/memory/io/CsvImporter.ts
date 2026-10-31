/**
 * @fileoverview CSV importer for AgentOS memory brain.
 *
 * Imports flat CSV files into a target `Brain`. A header row is
 * required and must include a `content` column. Optional columns map onto
 * `memory_traces` fields when present.
 *
 * Supported optional columns:
 * - `id`
 * - `type`
 * - `scope`
 * - `strength`
 * - `created_at` / `createdAt`
 * - `last_accessed`
 * - `retrieval_count`
 * - `deleted`
 * - `tags` (JSON array, comma-separated, or pipe-separated)
 * - `metadata` (JSON object; its `scopeId` names the trace's scope id). A cell
 *   that is not valid JSON, or whose JSON is not an object, makes its row an
 *   error.
 * - `scope_id` (the trace's scope id when the metadata names none; the
 *   metadata is given it too)
 *
 * Deduplication works inside the row's scope and scope id: a trace there that
 * holds the row's `content`, or names its SHA-256 as `metadata.import_hash` or
 * `metadata.content_hash`, makes the row a duplicate, whichever writer stored
 * it. An imported row stores the hash in `metadata.import_hash`. A trace a
 * release older than `memory_traces.scope_id` wrote holds `''` in that column
 * whatever scope id its metadata names; the import files such traces under
 * that scope id before its first duplicate check (`fillScopeIds`). The import
 * reads the rows whose `deleted` cell is blank or zero before the others
 * (`liveRecordsFirst`), so a text the file holds both forgotten and live
 * arrives live.
 *
 * @module memory/io/CsvImporter
 */

import { sha256 } from '../core/util/crossPlatformCrypto.js';
import { v4 as uuidv4 } from 'uuid';
import type { ImportOptions, ImportResult } from './facade/types.js';
import type { Brain } from '../retrieval/store/Brain.js';
import { duplicateTraceCondition, duplicateTraceParams, importedScopeId, liveRecordsFirst } from './importScope.js';
import { fillScopeIds } from '../retrieval/store/migrations/v2-to-v3.js';

/**
 * Imports a flat CSV file into a `Brain`.
 */
export class CsvImporter {
  constructor(private readonly brain: Brain) {}

  /**
   * Read, parse, and import a CSV file.
   *
   * @param sourcePath - Absolute or relative path to the CSV file.
   * @returns Import summary with imported/skipped/error counts.
   */
  async import(sourcePath: string, options?: Pick<ImportOptions, 'dedup'>): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, skipped: 0, errors: [] };

    let raw: string;
    try {
      const fs = await import('node:fs/promises');
      raw = await fs.readFile(sourcePath, 'utf8');
    } catch (err) {
      result.errors.push(`Failed to read file: ${String(err)}`);
      return result;
    }

    return this._importCsvContent(raw, result, options);
  }

  /**
   * Import a CSV string directly into the target brain without filesystem access.
   *
   * @param csvContent - The raw CSV string to parse and import.
   * @returns Import summary with imported/skipped/error counts.
   */
  async importFromString(
    csvContent: string,
    options?: Pick<ImportOptions, 'dedup'>,
  ): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, skipped: 0, errors: [] };
    return this._importCsvContent(csvContent, result, options);
  }

  /**
   * Parse raw CSV content and import its rows into the brain.
   *
   * @param raw    - The raw CSV string (may include BOM).
   * @param result - Mutable `ImportResult` to accumulate counts.
   * @returns The populated `ImportResult`.
   */
  private async _importCsvContent(
    raw: string,
    result: ImportResult,
    options?: Pick<ImportOptions, 'dedup'>,
  ): Promise<ImportResult> {
    const rows = this._parseCsv(raw.replace(/^\uFEFF/, ''));
    if (rows.length === 0) {
      result.errors.push('CSV import failed: file is empty.');
      return result;
    }

    const [headerRow, ...dataRows] = rows;
    const header = headerRow.map((cell) => cell.trim().toLowerCase());
    const contentIndex = header.indexOf('content');

    if (contentIndex === -1) {
      result.errors.push('CSV import failed: missing required "content" column.');
      return result;
    }

    const indexOf = (name: string): number => header.indexOf(name);
    const idIndex = indexOf('id');
    const typeIndex = indexOf('type');
    const scopeIndex = indexOf('scope');
    const strengthIndex = indexOf('strength');
    const createdAtIndex = Math.max(indexOf('created_at'), indexOf('createdat'));
    const lastAccessedIndex = indexOf('last_accessed');
    const retrievalCountIndex = indexOf('retrieval_count');
    const deletedIndex = indexOf('deleted');
    const tagsIndex = indexOf('tags');
    const metadataIndex = indexOf('metadata');
    const scopeIdIndex = indexOf('scope_id');

    // A row's `deleted` cell as the trace stores it: blank or not a number is 0, a live trace.
    const deletedOf = (row: string[]): number =>
      this._toInteger(deletedIndex >= 0 ? row[deletedIndex] ?? '' : '') ?? 0;

    const brainId = this.brain.brainId;
    const checkSql = `SELECT id
       FROM memory_traces
       WHERE brain_id = ? AND scope = ? AND scope_id = ?
         AND ${duplicateTraceCondition(this.brain)}
       LIMIT 1`;

    const insertSql = `INSERT INTO memory_traces
         (brain_id, id, type, scope, content, embedding, strength, created_at, last_accessed,
          retrieval_count, tags, emotions, metadata, deleted, scope_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`;

    await this.brain.transaction(async (trx) => {
      // A trace an older release wrote holds scope_id '': filed under its scope id first, it is found there.
      if (options?.dedup ?? true) await fillScopeIds(trx, brainId);
      // The live rows first, so of two rows of one text, the forgotten one is the duplicate of the live one, never the reverse.
      for (const row of liveRecordsFirst(dataRows, (candidate) => deletedOf(candidate) !== 0)) {
        try {
          const content = (row[contentIndex] ?? '').trim();
          if (!content) {
            result.skipped++;
            continue;
          }

          const hash = await this._sha256(content);
          const scope = this._readCell(row, scopeIndex) || 'user';

          // The metadata cell names the scope id, so it is read before the dedup check.
          let metadata: Record<string, unknown> = {};
          const rawMetadata = metadataIndex >= 0 ? row[metadataIndex] ?? '' : '';
          if (rawMetadata.trim()) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(rawMetadata);
            } catch {
              result.errors.push(`CSV metadata parse error for content "${content.slice(0, 40)}..."`);
              continue;
            }
            // An array, null or a lone value cannot hold the row's scope id and import hash.
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              result.errors.push(`CSV metadata is not a JSON object for content "${content.slice(0, 40)}..."`);
              continue;
            }
            metadata = parsed as Record<string, unknown>;
          }
          // The metadata's scopeId comes first, then the scope_id cell, as for a JSON or SQLite record.
          const scopeId = importedScopeId(metadata, this._readCell(row, scopeIdIndex));

          if (options?.dedup ?? true) {
            const existing = await trx.get<{ id: string }>(checkSql, [
              brainId, scope, scopeId, ...duplicateTraceParams(hash, content),
            ]);
            if (existing) {
              result.skipped++;
              continue;
            }
          }

          metadata.import_hash = hash;

          const rawCreatedAt = createdAtIndex >= 0 ? row[createdAtIndex] ?? '' : '';
          const rawLastAccessed = lastAccessedIndex >= 0 ? row[lastAccessedIndex] ?? '' : '';
          const rawRetrievalCount = retrievalCountIndex >= 0 ? row[retrievalCountIndex] ?? '' : '';
          const rawStrength = strengthIndex >= 0 ? row[strengthIndex] ?? '' : '';

          const preferredId = this._readCell(row, idIndex) || `mt_${uuidv4()}`;
          const traceId = await this._resolveTraceId(trx, preferredId);

          await trx.run(insertSql, [
            brainId,
            traceId,
            this._readCell(row, typeIndex) || 'episodic',
            scope,
            content,
            this._toNumber(rawStrength) ?? 1.0,
            this._toInteger(rawCreatedAt) ?? Date.now(),
            this._toInteger(rawLastAccessed) ?? null,
            this._toInteger(rawRetrievalCount) ?? 0,
            JSON.stringify(this._parseTags(tagsIndex >= 0 ? row[tagsIndex] ?? '' : '')),
            JSON.stringify(metadata),
            deletedOf(row),
            scopeId,
          ]);

          result.imported++;
        } catch (err) {
          result.errors.push(`CSV trace import error: ${String(err)}`);
        }
      }
    });

    return result;
  }

  private async _sha256(content: string): Promise<string> {
    return sha256(content);
  }

  private async _resolveTraceId(
    trx: { get: Brain['get'] },
    preferredId: string,
  ): Promise<string> {
    const existing = await trx.get<{ id: string }>(
      'SELECT id FROM memory_traces WHERE brain_id = ? AND id = ? LIMIT 1',
      [this.brain.brainId, preferredId],
    );
    return existing ? `mt_${uuidv4()}` : preferredId;
  }

  private _readCell(row: string[], index: number): string {
    if (index < 0) return '';
    return (row[index] ?? '').trim();
  }

  private _toNumber(value: string): number | null {
    if (!value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private _toInteger(value: string): number | null {
    const parsed = this._toNumber(value);
    return parsed === null ? null : Math.trunc(parsed);
  }

  private _parseTags(raw: string): string[] {
    const value = raw.trim();
    if (!value) return [];

    if (value.startsWith('[')) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.filter((tag): tag is string => typeof tag === 'string');
        }
      } catch {
        return [];
      }
    }

    const separator = value.includes('|') ? '|' : ',';
    return value
      .split(separator)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  /**
   * Small RFC4180-ish CSV parser that supports quoted fields, escaped quotes,
   * and embedded newlines inside quoted cells.
   */
  private _parseCsv(input: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;

    const pushField = (): void => {
      row.push(field);
      field = '';
    };

    const pushRow = (): void => {
      if (row.length === 1 && row[0] === '' && rows.length > 0) {
        row = [];
        return;
      }
      rows.push(row);
      row = [];
    };

    for (let i = 0; i < input.length; i++) {
      const char = input[i]!;

      if (inQuotes) {
        if (char === '"') {
          if (input[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += char;
        }
        continue;
      }

      if (char === '"') {
        inQuotes = true;
        continue;
      }

      if (char === ',') {
        pushField();
        continue;
      }

      if (char === '\r') {
        if (input[i + 1] === '\n') i++;
        pushField();
        pushRow();
        continue;
      }

      if (char === '\n') {
        pushField();
        pushRow();
        continue;
      }

      field += char;
    }

    pushField();
    if (row.length > 0) {
      pushRow();
    }

    return rows;
  }
}
