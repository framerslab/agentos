/**
 * @fileoverview The scope id an imported trace is filed under.
 *
 * An importer files each trace under its scope and scope id and deduplicates inside that pair: a record whose text a
 * trace of another scope id holds (another tenant's, user's or session's) is imported, and a record whose text a trace
 * of its own scope and scope id holds is a duplicate. The Markdown export writes the same scope id into a trace's
 * front matter, so a note carries it out of one brain and into another.
 *
 * @module memory/io/importScope
 */

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
