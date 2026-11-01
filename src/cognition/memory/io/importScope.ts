/**
 * @fileoverview The scope id an imported trace is filed under, and the trace an imported record duplicates.
 *
 * An importer files each trace under its scope and scope id and deduplicates inside that pair and the trace's user
 * (`metadata.turnUserId`, which a second user's trace on another user's session carries): a record whose text a trace
 * of another scope id holds (another tenant's, user's or session's) is imported, and so is a record whose text another
 * user's trace of its scope id holds, as `remember()` keeps them apart; a record whose text a trace of its own scope,
 * scope id and user holds is a duplicate, whichever writer stored that trace. The Markdown export writes the scope id,
 * and a second user's id, into a trace's front matter, so a note carries them out of one brain and into another. An
 * importer whose source marks forgotten traces reads the source's live records before its forgotten ones, so a text the
 * source holds both forgotten and live arrives live. A trace's memory-graph node comes in with its trace alone, under
 * its trace's id, so a record merged into another trace leaves no node behind that stands for a trace the brain does
 * not hold.
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
 * An importer reads a source's live records before its forgotten ones (see {@link liveRecordsFirst}), so a forgotten
 * trace the same import writes is never what makes a live record of its text a duplicate.
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

/**
 * The `knowledge_nodes.type` of a memory-graph node (`SqlMemoryGraph`): the node of the trace whose id it carries as
 * its own.
 */
export const MEMORY_GRAPH_NODE_TYPE = 'memory_graph';

/** How an import takes a memory-graph node its file holds (see {@link memoryGraphNodeImport}). */
export type MemoryGraphNodeImport = { action: 'write' | 'duplicate'; id: string } | { action: 'skip' };

/**
 * How an import takes a memory-graph node its file holds, the node of the trace whose id it carries. The node comes in
 * with its trace alone and under that id. It is skipped, and so are the edges that name it, when the file holds its
 * trace and the import did not write that trace, or match it as a duplicate, under that id (the record merged into a
 * trace of another id, was written under a new id, or failed), or when the brain holds no trace of that id; written
 * there, the node would stand for a trace the brain does not hold. A node the brain holds under that id is the
 * record's duplicate, and the edges that name the record's node name it; a node of another type under that id makes
 * the record's node a skip, as it cannot take that id. Otherwise the node is written under that id.
 *
 * A record merged into a trace of another id brings no node and no edges: the brain's node of that trace keeps its own
 * edges, and the record merged is most often a forgotten one (see {@link liveRecordsFirst}), whose edges its source no
 * longer reads.
 *
 * @param trx - The import's transaction.
 * @param brainId - The brain the import writes.
 * @param nodeId - The node record's id, which is its trace's id.
 * @param unfiled - Whether the file holds the trace of an id that the import did not write, or match as a duplicate,
 *   under that id.
 * @returns `write` or `duplicate` with the id, or `skip`.
 */
export async function memoryGraphNodeImport(
  trx: Pick<Brain, 'get'>,
  brainId: string,
  nodeId: unknown,
  unfiled: (traceId: string) => boolean,
): Promise<MemoryGraphNodeImport> {
  if (typeof nodeId !== 'string' || unfiled(nodeId)) return { action: 'skip' };
  const trace = await trx.get<{ id: string }>('SELECT id FROM memory_traces WHERE brain_id = ? AND id = ? LIMIT 1', [
    brainId,
    nodeId,
  ]);
  if (!trace) return { action: 'skip' };
  const held = await trx.get<{ type: string }>('SELECT type FROM knowledge_nodes WHERE brain_id = ? AND id = ? LIMIT 1', [
    brainId,
    nodeId,
  ]);
  if (!held) return { action: 'write', id: nodeId };
  return held.type === MEMORY_GRAPH_NODE_TYPE ? { action: 'duplicate', id: nodeId } : { action: 'skip' };
}
