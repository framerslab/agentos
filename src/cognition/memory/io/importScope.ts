/**
 * @fileoverview The scope id an imported trace is filed under.
 *
 * An importer files each trace under its scope and scope id and deduplicates inside that pair: a record whose text a
 * trace of another scope id holds (another tenant's, user's or session's) is imported, and a record whose text a trace
 * of its own scope and scope id holds is a duplicate.
 *
 * @module memory/io/importScope
 */

/**
 * The scope id an imported trace files under: its metadata's `scopeId` when that is a string, else the record's own
 * `scope_id` (an export of a schema-3 Brain carries both), else `''`. A scope id taken from `scope_id` is written into
 * the metadata too, since a trace loaded from the Brain reads its scope id there.
 *
 * @param metadata - The record's parsed metadata. A value that is not an object yields the `scope_id` or `''`.
 * @param scopeIdColumn - The record's `scope_id`, when it carries one.
 * @returns The value for the trace's `scope_id` column.
 */
export function importedScopeId(metadata: unknown, scopeIdColumn?: unknown): string {
  const record = metadata !== null && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : undefined;
  if (typeof record?.scopeId === 'string') return record.scopeId;
  if (typeof scopeIdColumn !== 'string' || scopeIdColumn === '') return '';
  if (record) record.scopeId = scopeIdColumn;
  return scopeIdColumn;
}
