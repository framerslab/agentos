/**
 * @file mindFiled.ts
 * The marker a souled agent's mind writes into the metadata of each Brain row it files (`MemoryTrace.filing`), and the
 * SQL that reads it. The cognitive memory store that loads the mind's rows alone (`MemoryStoreConfig.rows` `'mind'`)
 * reads the rows that name the mind; the `Memory` facade's recall for the soul's side (`RecallOptions.filedBy`
 * `'soul'`) and its vector index read the rows that do not.
 *
 * @internal
 */
import type { StorageFeatures } from '@framers/sql-storage-adapter';

/** The value of a row's top-level metadata key `filedBy` that names a souled agent's mind as the row's filer. */
export const MIND_FILER = 'mind';

/** The dialect calls the conditions are written with, so they run on SQLite and PostgreSQL. */
type Dialect = Pick<StorageFeatures['dialect'], 'jsonExtract' | 'ifnull'>;

/** A condition of a `WHERE` clause with the bindings of its placeholders, in order. */
export interface SqlCondition {
  sql: string;
  params: unknown[];
}

/**
 * The filer a row's metadata names in its top-level `filedBy` key, as SQL; NULL for a row that names none. Only a row
 * whose metadata text holds the key is read as JSON: a SQL read of JSON raises on metadata that is not JSON
 * (`json_extract` on SQLite, the `::jsonb` cast on PostgreSQL), so one such row of another writer would fail the read
 * of every row beside it. A key's own text holds the key in quotes; a string that holds it escapes them.
 */
function filerOf(dialect: Dialect, metadataColumn: string): SqlCondition {
  return {
    sql: `(CASE WHEN ${metadataColumn} LIKE ? THEN ${dialect.jsonExtract(metadataColumn, '$.filedBy')} END)`,
    params: ['%"filedBy"%'],
  };
}

/**
 * The condition that a row's metadata names a souled agent's mind as its filer (`filedBy: 'mind'`).
 *
 * @param metadataColumn - The metadata column as the read names it (`metadata`, `t.metadata`).
 */
export function filedByMindCondition(dialect: Dialect, metadataColumn: string): SqlCondition {
  const filer = filerOf(dialect, metadataColumn);
  return { sql: `${filer.sql} = ?`, params: [...filer.params, MIND_FILER] };
}

/**
 * The condition that a row's metadata does not name a souled agent's mind as its filer: a row whose metadata names no
 * filer or another one, a row with no metadata, and a row whose metadata is text that is not JSON and does not hold the
 * key. The exact complement of {@link filedByMindCondition}.
 *
 * @param metadataColumn - The metadata column as the read names it (`metadata`, `t.metadata`).
 */
export function notFiledByMindCondition(dialect: Dialect, metadataColumn: string): SqlCondition {
  const filer = filerOf(dialect, metadataColumn);
  return { sql: `${dialect.ifnull(filer.sql, "''")} <> ?`, params: [...filer.params, MIND_FILER] };
}
