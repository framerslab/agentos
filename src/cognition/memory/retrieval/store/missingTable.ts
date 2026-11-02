/**
 * @fileoverview Whether a database error says a table or a column does not exist.
 * @module memory/retrieval/store/missingTable
 *
 * The scope-id form reads (`brain_meta`, `memory_traces`, `knowledge_nodes`) and the RAG migration's clear of a
 * record. A store without the table, or one from before brain ids (no `brain_id` column), holds no record and no
 * brain; any other failure (a locked file, a dropped connection) must stop the import, the export or the migration
 * rather than read as a store that holds nothing.
 */

/** A PostgreSQL SQLSTATE: five digits or upper-case letters (`42P01`). SQLite's codes are words (`SQLITE_ERROR`). */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * SQLite's `no such table` and `no such column`; PostgreSQL's missing relation or column (SQLSTATE `42P01`, `42703`).
 * An error that carries a PostgreSQL SQLSTATE is read by its code alone, so a database, a role or a connection that
 * does not exist is no missing table. One without (sql.js, or an adapter that drops the code) is read by its words:
 * `relation "..." does not exist` or `column "..." does not exist`.
 *
 * @param error - What a statement threw.
 */
export function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && SQLSTATE.test(code)) return code === '42P01' || code === '42703';
  const message = error instanceof Error ? error.message : String(error);
  return /no such (table|column)\b/i.test(message) || /\b(relation|column) "[^"]*"( of relation "[^"]*")? does not exist/i.test(message);
}
