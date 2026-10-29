/**
 * @fileoverview Shared helpers for persisting trace metadata in SQLite-first
 * memory paths.
 *
 * The Phase 1 memory facade stores core retrieval counters in dedicated
 * columns, but richer decay state is persisted inside `memory_traces.metadata`
 * to avoid a schema expansion. These helpers keep that JSON contract
 * consistent across the facade, consolidation loop, feedback loop, and
 * agent-facing memory tools.
 *
 * @module memory/store/tracePersistence
 */

import { sha256 } from '../../core/util/crossPlatformCrypto.js';

/**
 * Default stability for traces that do not yet have an explicit persisted
 * decay state.
 */
export const DEFAULT_TRACE_STABILITY_MS = 86_400_000;

/**
 * Default reinforcement interval for traces that do not yet have an explicit
 * persisted decay state.
 */
export const DEFAULT_TRACE_REINFORCEMENT_INTERVAL_MS = 86_400_000;

/**
 * Persisted decay state stored under `metadata.decay`.
 */
export interface PersistedDecayState {
  stability: number;
  accessCount: number;
  reinforcementInterval: number;
  nextReinforcementAt?: number;
}

const FTS_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'the',
  'to',
  'us',
  'we',
  'what',
  'when',
  'where',
  'who',
  'why',
  'with',
  'you',
  'your',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse a raw `metadata` JSON string into a plain object.
 */
export function parseTraceMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Read the decay fields persisted under `metadata.decay`, each one only where
 * it holds a finite number, so a reader with defaults of its own fills the
 * rest (`MemoryStore` loads an absent access count as 0 and an absent
 * interval as one hour, where {@link readPersistedDecayState} gives the
 * retrieval count and one day).
 */
export function readPersistedDecayFields(
  metadata: Record<string, unknown>,
): Partial<PersistedDecayState> {
  const decay = isRecord(metadata.decay) ? metadata.decay : {};
  const stability = finiteNumber(decay.stability);
  const accessCount = finiteNumber(decay.accessCount);
  const reinforcementInterval = finiteNumber(decay.reinforcementInterval);
  const nextReinforcementAt = finiteNumber(decay.nextReinforcementAt);

  return {
    ...(stability !== undefined ? { stability } : {}),
    ...(accessCount !== undefined ? { accessCount } : {}),
    ...(reinforcementInterval !== undefined ? { reinforcementInterval } : {}),
    ...(nextReinforcementAt !== undefined ? { nextReinforcementAt } : {}),
  };
}

/**
 * Read the persisted decay state from a metadata object, applying defaults
 * when fields are absent.
 */
export function readPersistedDecayState(
  metadata: Record<string, unknown>,
  retrievalCount = 0,
): PersistedDecayState {
  const fields = readPersistedDecayFields(metadata);

  return {
    stability: fields.stability ?? DEFAULT_TRACE_STABILITY_MS,
    accessCount: fields.accessCount ?? retrievalCount,
    reinforcementInterval:
      fields.reinforcementInterval ?? DEFAULT_TRACE_REINFORCEMENT_INTERVAL_MS,
    ...(fields.nextReinforcementAt !== undefined
      ? { nextReinforcementAt: fields.nextReinforcementAt }
      : {}),
  };
}

/**
 * Merge a decay state payload into an existing metadata object.
 */
export function withPersistedDecayState(
  metadata: Record<string, unknown>,
  state: PersistedDecayState,
): Record<string, unknown> {
  const nextDecay: Record<string, unknown> = {
    stability: state.stability,
    accessCount: state.accessCount,
    reinforcementInterval: state.reinforcementInterval,
  };

  if (state.nextReinforcementAt !== undefined) {
    nextDecay.nextReinforcementAt = state.nextReinforcementAt;
  }

  return {
    ...metadata,
    decay: nextDecay,
  };
}

/**
 * Build initial metadata for a newly inserted memory trace.
 */
export function buildInitialTraceMetadata(
  baseMetadata: Record<string, unknown> = {},
  options?: {
    contentHash?: string;
    entities?: string[];
    scopeId?: string;
    stability?: number;
    accessCount?: number;
    reinforcementInterval?: number;
    nextReinforcementAt?: number;
  },
): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...baseMetadata };

  if (options?.contentHash !== undefined) {
    metadata.content_hash = options.contentHash;
  }
  if (options?.entities !== undefined) {
    metadata.entities = options.entities;
  }
  if (options?.scopeId !== undefined) {
    metadata.scopeId = options.scopeId;
  }

  return withPersistedDecayState(metadata, {
    stability: options?.stability ?? DEFAULT_TRACE_STABILITY_MS,
    accessCount: options?.accessCount ?? 0,
    reinforcementInterval:
      options?.reinforcementInterval ?? DEFAULT_TRACE_REINFORCEMENT_INTERVAL_MS,
    ...(options?.nextReinforcementAt !== undefined
      ? { nextReinforcementAt: options.nextReinforcementAt }
      : {}),
  });
}

/**
 * Compute a SHA-256 hex digest for trace content.
 */
export async function sha256Hex(content: string): Promise<string> {
  return sha256(content);
}

/**
 * Convert free-form natural language into a conservative FTS5 query.
 *
 * This avoids syntax errors when callers pass punctuation-heavy questions such
 * as "What are my workflow preferences?" into a raw `MATCH` clause.
 */
export function buildNaturalLanguageFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return '';

  const rawTokens = Array.from(
    new Set(
      (trimmed.match(/[\p{L}\p{N}_]+/gu) ?? [])
        .map((token) => token.toLowerCase())
        .filter(Boolean),
    ),
  );

  if (rawTokens.length === 0) {
    return '';
  }

  const filteredTokens = rawTokens.filter(
    (token) => token.length > 1 && !FTS_STOP_WORDS.has(token),
  );
  const tokens = filteredTokens.length > 0 ? filteredTokens : rawTokens;

  return tokens.map((token) => `${token}*`).join(' OR ');
}

/**
 * One binding of `value` for each `?` in an SQL fragment the full-text helpers
 * made with `?` as their query placeholder. Postgres's rank and relevance order
 * read the query text through a placeholder of their own; SQLite's read the
 * match and hold none, so a statement binds the query text once per fragment
 * on one engine and not at all on the other.
 */
export function bindingsFor(fragment: string, value: unknown): unknown[] {
  return Array.from({ length: (fragment.match(/\?/g) ?? []).length }, () => value);
}

/**
 * A `memory_traces` row as a ledger row's before-state holds it: every column but the embedding. A restore keeps the
 * row's embedding where the row holds the snapshot's content ({@link writeTraceSnapshot}); a trace restored to other
 * content regains a vector when it is next written (as `memory_update` clears it when the content changes).
 */
export interface TraceSnapshot {
  id: string;
  type: string;
  scope: string;
  scopeId: string;
  content: string;
  strength: number;
  createdAt: number;
  lastAccessed: number | null;
  retrievalCount: number;
  tags: string;
  emotions: string;
  metadata: string;
  deleted: 0 | 1;
}

/** The two calls of a storage adapter, a Brain or a transaction the snapshot helpers use. */
export interface SnapshotDb {
  get<T>(sql: string, params?: unknown[]): Promise<T | null | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

/**
 * Deletes trace rows of one brain for good, 400 ids a statement, with the rows that name them first, as the Brain's
 * foreign keys require: a trace's `retrieval_feedback` rows, each holding the query that recalled it, are deleted, and
 * a `document_chunks` row the trace was filed from lets go of it (`trace_id` set to NULL) and keeps its text, which
 * belongs to its document.
 *
 * @returns How many trace rows it deleted.
 */
export async function deleteTraceRows(db: Pick<SnapshotDb, 'run'>, brainId: string, traceIds: readonly string[]): Promise<number> {
  const ids = [...new Set(traceIds)];
  let deleted = 0;
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const placeholders = chunk.map(() => '?').join(', ');
    const params = [brainId, ...chunk];
    await db.run(`DELETE FROM retrieval_feedback WHERE brain_id = ? AND trace_id IN (${placeholders})`, params);
    await db.run(`UPDATE document_chunks SET trace_id = NULL WHERE brain_id = ? AND trace_id IN (${placeholders})`, params);
    deleted += (await db.run(`DELETE FROM memory_traces WHERE brain_id = ? AND id IN (${placeholders})`, params)).changes;
  }
  return deleted;
}

/** Reads one row of a brain as a snapshot; `undefined` when there is no such row. */
export async function readTraceSnapshot(db: SnapshotDb, brainId: string, traceId: string): Promise<TraceSnapshot | undefined> {
  const row = await db.get<{
    id: string; type: string; scope: string; scope_id: string | null; content: string; strength: number;
    created_at: number; last_accessed: number | null; retrieval_count: number; tags: string; emotions: string;
    metadata: string; deleted: number;
  }>(
    `SELECT id, type, scope, scope_id, content, strength, created_at, last_accessed, retrieval_count, tags, emotions, metadata, deleted
       FROM memory_traces WHERE brain_id = ? AND id = ?`,
    [brainId, traceId],
  );
  if (!row) return undefined;
  return {
    id: row.id,
    type: row.type,
    scope: row.scope,
    scopeId: row.scope_id ?? '',
    content: row.content,
    strength: row.strength,
    createdAt: row.created_at,
    lastAccessed: row.last_accessed ?? null,
    retrievalCount: row.retrieval_count ?? 0,
    tags: row.tags,
    emotions: row.emotions,
    metadata: row.metadata,
    deleted: row.deleted === 1 ? 1 : 0,
  };
}

/**
 * Writes a snapshot back as the row's whole state, live (`deleted = 0`). The row keeps its embedding when it holds
 * the snapshot's content (a delete taken back), so a store over the Brain loads and recalls the trace again; any other
 * row is written with no embedding, since its vector is of other text.
 *
 * @param insertOrReplace - The dialect's `insertOrReplace` (`brain.features.dialect.insertOrReplace`).
 */
export async function writeTraceSnapshot(
  db: SnapshotDb,
  insertOrReplace: (table: string, columns: string[], values: string[], conflict: string) => string,
  brainId: string,
  snapshot: TraceSnapshot,
): Promise<void> {
  const current = await db.get<{ content: string; embedding: unknown }>(
    'SELECT content, embedding FROM memory_traces WHERE brain_id = ? AND id = ?',
    [brainId, snapshot.id],
  );
  const embedding = current && current.content === snapshot.content ? current.embedding ?? null : null;
  const columns = ['brain_id', 'id', 'type', 'scope', 'content', 'embedding', 'strength', 'created_at', 'last_accessed', 'retrieval_count', 'tags', 'emotions', 'metadata', 'deleted', 'scope_id'];
  const sql = insertOrReplace('memory_traces', columns, columns.map((column) => (column === 'deleted' ? '0' : '?')), 'brain_id, id');
  await db.run(sql, [
    brainId, snapshot.id, snapshot.type, snapshot.scope, snapshot.content, embedding, snapshot.strength,
    snapshot.createdAt, snapshot.lastAccessed, snapshot.retrievalCount, snapshot.tags, snapshot.emotions,
    snapshot.metadata, snapshot.scopeId,
  ]);
}
