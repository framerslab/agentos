/**
 * @fileoverview Single source of truth for the list of brain-owned tables that
 * are exported, imported, and migrated as a portable artifact.
 *
 * Three call sites import from here:
 * 1. `Brain.exportToSqlite` / `importFromSqlite` (export/import row copies)
 * 2. `migrations/v1-to-v2.ts` (migration walk order: parents before children for FKs)
 * 3. `__tests__/Brain.postgres.test.ts` (cleanup between tests)
 *
 * Adding a new portable table requires editing only this file. The two tables of the conversation scopes
 * (`CONVERSATION_SCOPE_TABLES`) and the owners of older memory (`LEGACY_OWNER_TABLE`) are exported and imported with
 * them.
 *
 * @module memory/retrieval/store/portable-tables
 */

/**
 * Order matters: parents before children to satisfy FK constraints during import.
 */
export const PORTABLE_TABLES = [
  'brain_meta',
  'memory_traces',
  'knowledge_nodes',
  'knowledge_edges',
  'documents',
  'document_chunks',
  'document_images',
  'consolidation_log',
  'retrieval_feedback',
  'conversations',
  'messages',
  'prospective_items',
  'archived_traces',
  'archive_access_log',
] as const;

/**
 * The tables of the conversation scopes, which a SQLite export and import carry beside the portable tables: the
 * registry of scopes, then each subject's wiki pages. They are a list of their own because the v1-to-v2 migration
 * walks `PORTABLE_TABLES` and they are newer than the schema it migrates.
 */
export const CONVERSATION_SCOPE_TABLES = ['memory_scopes', 'memory_pages'] as const;

/**
 * The owner of each agent's memory from before per-user scope, a row an agent, which a SQLite export and import carry
 * beside the conversation scopes: without it an imported store withholds that memory again, and a deletion of its
 * owner would not reach it.
 */
export const LEGACY_OWNER_TABLE = 'memory_legacy_owner';

/**
 * Composite primary key columns for each portable table, used by
 * `dialect.insertOrReplace` as the conflict target during merge import.
 *
 * Tables with `INTEGER PRIMARY KEY AUTOINCREMENT` (consolidation_log,
 * retrieval_feedback) use `id` alone since their PK is system-generated.
 */
export const PORTABLE_TABLE_PRIMARY_KEYS: Record<string, string> = {
  brain_meta: 'brain_id, key',
  memory_traces: 'brain_id, id',
  knowledge_nodes: 'brain_id, id',
  knowledge_edges: 'brain_id, id',
  documents: 'brain_id, id',
  document_chunks: 'brain_id, id',
  document_images: 'brain_id, id',
  consolidation_log: 'id',
  retrieval_feedback: 'id',
  conversations: 'brain_id, id',
  messages: 'brain_id, id',
  prospective_items: 'brain_id, id',
  archived_traces: 'brain_id, trace_id',
  archive_access_log: 'brain_id, trace_id, accessed_at',
  memory_scopes: 'brain_id, scope, scope_id',
  memory_pages: 'brain_id, scope, scope_id, page_id',
  memory_legacy_owner: 'brain_id, agent_id',
};

export type PortableTable = typeof PORTABLE_TABLES[number];
