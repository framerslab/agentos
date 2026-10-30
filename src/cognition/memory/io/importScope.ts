/**
 * @fileoverview The scope id an imported trace is filed under, and the trace an imported record duplicates.
 *
 * An importer files each trace under its scope and scope id and deduplicates inside that pair: a record whose text a
 * trace of another scope id holds (another tenant's, user's or session's) is imported, and a record whose text a trace
 * of its own scope and scope id holds is a duplicate, whichever writer stored that trace. The Markdown export writes
 * the same scope id into a trace's front matter, so a note carries it out of one brain and into another. An importer
 * whose source marks forgotten traces reads the source's live records before its forgotten ones, so a text the source
 * holds both forgotten and live arrives live.
 *
 * @module memory/io/importScope
 */

import type { Brain } from '../retrieval/store/Brain.js';

/**
 * The scope id an imported trace files under: its metadata's `scopeId` when that is a string, else the record's own
 * `scope_id` (an export of a schema-3 Brain carries both, and a CSV row may carry a `scope_id` cell), else `''`. A
 * scope id taken from `scope_id` is written into the metadata too, since a trace loaded from the Brain reads its scope
 * id there. An importer hands it a metadata object: a record whose metadata is an array, `null` or another value that
 * is not an object is stored with an object of its own (JSON, SQLite) or is an error (CSV), since such a value cannot
 * hold the scope id and the import hash.
 *
 * @param metadata - The record's parsed metadata. A value that is not an object, an array included, yields the
 *   `scope_id` or `''` and is not written to.
 * @param scopeIdColumn - The record's `scope_id`, when it carries one.
 * @returns The value for the trace's `scope_id` column.
 */
export function importedScopeId(metadata: unknown, scopeIdColumn?: unknown): string {
  const record =
    metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : undefined;
  if (typeof record?.scopeId === 'string') return record.scopeId;
  if (typeof scopeIdColumn !== 'string' || scopeIdColumn === '') return '';
  if (record) record.scopeId = scopeIdColumn;
  return scopeIdColumn;
}

/**
 * The SQL condition that finds the trace an imported record duplicates, beside the conditions that name the brain,
 * the scope and the scope id: a trace whose text is the record's, or whose metadata names the SHA-256 of that text as
 * `import_hash` (an import stores it) or `content_hash` (`remember()`, `ingest()` and `memory_add` store it). A trace
 * the cognitive memory store wrote carries neither hash, and its text finds it. A trace the brain forgot counts as any
 * other, so an import does not bring it back: a forgotten row stays a record of what the brain let go, and a JSON or
 * SQLite export carries it, so leaving it out would add another forgotten copy at each import of such a file. An
 * importer reads a source's live records before its forgotten ones (see {@link liveRecordsFirst}), so a forgotten trace
 * the same import writes is never what makes a live record of its text a duplicate.
 *
 * @param brain - The brain the query runs on; its dialect reads the metadata.
 * @returns A parenthesised condition on `memory_traces` with the three placeholders {@link duplicateTraceParams}
 *   fills, in its order.
 */
export function duplicateTraceCondition(brain: Pick<Brain, 'features'>): string {
  const { dialect } = brain.features;
  return `(${dialect.jsonExtract('metadata', '$.import_hash')} = ?
              OR ${dialect.jsonExtract('metadata', '$.content_hash')} = ?
              OR content = ?)`;
}

/**
 * The values of {@link duplicateTraceCondition}'s placeholders.
 *
 * @param hash - The SHA-256 of the record's text.
 * @param content - The record's text, as the import would store it.
 * @returns The hash twice, then the text.
 */
export function duplicateTraceParams(hash: string, content: string): [string, string, string] {
  return [hash, hash, content];
}

/**
 * A source's trace records in the order an importer reads them: its live records, then its forgotten ones, each group
 * in the source's order. A source can hold a forgotten and a live trace of one text in one scope and scope id:
 * `forget()` and then `remember()` of the text leave them, and so does a consolidation merge of two traces of it. An
 * export holds its rows in no set order. Read first, the live record is imported and the forgotten one is its
 * duplicate, so the text arrives live; read the other way round, the live record would be the duplicate of the
 * forgotten trace the same import had just written, and the text would arrive forgotten.
 *
 * @param records - The source's trace records, in its order.
 * @param isForgotten - Whether a record is of a trace its source forgot.
 * @returns The live records, then the forgotten ones.
 */
export function liveRecordsFirst<T>(records: readonly T[], isForgotten: (record: T) => boolean): T[] {
  const live: T[] = [];
  const forgotten: T[] = [];
  for (const record of records) (isForgotten(record) ? forgotten : live).push(record);
  return live.concat(forgotten);
}

/**
 * Whether a JSON or SQLite trace record is of a trace its source forgot: its `deleted` is present and not zero. A
 * record whose `deleted` is absent or `null` is stored as live, as one whose `deleted` is `0` is.
 *
 * @param record - A trace record as its source holds it; a value that is not an object is not forgotten.
 * @returns `true` when the record's `deleted` is present and not zero.
 */
export function isForgottenRecord(record: unknown): boolean {
  if (typeof record !== 'object' || record === null) return false;
  const deleted = (record as { deleted?: unknown }).deleted;
  return deleted !== undefined && deleted !== null && Number(deleted) !== 0;
}
