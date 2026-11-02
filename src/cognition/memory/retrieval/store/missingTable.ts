/**
 * @fileoverview Whether a database error says a table or a column does not exist.
 * @module memory/retrieval/store/missingTable
 *
 * The scope-id form reads (`brain_meta`, `memory_traces`, `knowledge_nodes`) and the RAG migration's clear of a
 * record. A store without the table, or one from before brain ids (no `brain_id` column), holds no record and no
 * brain; any other failure (a locked file, a dropped connection) must stop the import, the export or the migration
 * rather than read as a store that holds nothing.
 */

/**
 * SQLite's `no such table` and `no such column`; PostgreSQL's `does not exist` for a relation or a column (SQLSTATE
 * `42P01`, `42703`).
 *
 * @param error - What a statement threw.
 */
export function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === '42P01' || code === '42703') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /no such (table|column)|does not exist/i.test(message);
}
