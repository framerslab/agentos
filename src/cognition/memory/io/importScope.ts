/**
 * @fileoverview The scope id an imported trace is filed under, and the trace an imported record duplicates.
 *
 * An importer files each trace under its scope and scope id and deduplicates inside that pair and the trace's user
 * (`metadata.turnUserId`, which a second user's trace on another user's session carries): a record whose text a trace
 * of another scope id holds (another tenant's, user's or session's) is imported, and so is a record whose text another
 * user's trace of its scope id holds, as `remember()` keeps them apart; a record whose text a trace of its own scope,
 * scope id and user holds is a duplicate, whichever writer stored that trace. The Markdown export writes the scope id,
 * and a second user's id, into a trace's front matter, so a note carries them out of one brain and into another.
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
 * The second user an imported trace is filed for: its metadata's `turnUserId` when that is a string (a second user's
 * trace on another user's session), else `''`, the session owner's, as `remember()` reads it.
 *
 * @param metadata - The record's parsed metadata; a value that is not an object names no user.
 * @returns The user the record's trace is filed for, or `''`.
 */
export function importedTurnUserId(metadata: unknown): string {
  const record =
    metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : undefined;
  return typeof record?.turnUserId === 'string' ? record.turnUserId : '';
}

/**
 * The SQL condition that finds the trace an imported record duplicates, beside the conditions that name the brain,
 * the scope and the scope id: a trace of the record's user (its metadata's `turnUserId`, or none for the session
 * owner's) whose text is the record's, or whose metadata names the SHA-256 of that text as `import_hash` (an import
 * stores it) or `content_hash` (`remember()`, `ingest()` and `memory_add` store it). A second user's trace is no
 * duplicate of the session owner's record, nor the reverse, so a delete of either user's traces leaves the other's. A
 * trace the cognitive memory store wrote carries neither hash, and its text finds it. A trace the brain forgot counts
 * as any other, so an import does not bring it back: a forgotten row stays a record of what the brain let go, and a
 * JSON or SQLite export carries it, so leaving it out would add another forgotten copy at each import of such a file.
 *
 * @param brain - The brain the query runs on; its dialect reads the metadata.
 * @returns A parenthesised condition on `memory_traces` with the four placeholders {@link duplicateTraceParams}
 *   fills, in its order.
 */
export function duplicateTraceCondition(brain: Pick<Brain, 'features'>): string {
  const { dialect } = brain.features;
  return `(${dialect.ifnull(dialect.jsonExtract('metadata', '$.turnUserId'), "''")} = ?
              AND (${dialect.jsonExtract('metadata', '$.import_hash')} = ?
                OR ${dialect.jsonExtract('metadata', '$.content_hash')} = ?
                OR content = ?))`;
}

/**
 * The values of {@link duplicateTraceCondition}'s placeholders.
 *
 * @param hash - The SHA-256 of the record's text.
 * @param content - The record's text, as the import would store it.
 * @param turnUserId - The user the record's trace is filed for ({@link importedTurnUserId}), `''` for the session
 *   owner's.
 * @returns The user, the hash twice, then the text.
 */
export function duplicateTraceParams(
  hash: string,
  content: string,
  turnUserId: string,
): [string, string, string, string] {
  return [turnUserId, hash, hash, content];
}
