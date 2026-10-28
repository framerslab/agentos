/**
 * @module memory/retrieval/graph/knowledge/memoryCopies
 *
 * The rules every knowledge graph applies to a memory trace's episodic copy: the record `MemoryStore.store` writes
 * with the trace's full text and a stored context that names the trace (`memoryTraceId`), its scope and its scope id.
 * A graph keys the copy by its trace, so recording the trace again replaces the copy and a delete by trace id finds
 * it with no read; a delete by scope reads the copies whose stored context names the scope.
 */
import type { MemoryCopyFilter } from './IKnowledgeGraph.js';

/** The prefix of the key a graph files a trace's copy under ({@link copyKey}). */
export const COPY_KEY_PREFIX = 'trace:';

/** The text the stored context JSON of every trace's copy holds, as `JSON.stringify` writes it. */
export const TRACE_CONTEXT_MARKER = '"memoryTraceId":';

/** The key a graph files the copy of this trace under: one copy per trace. */
export function copyKey(traceId: string): string {
  return `${COPY_KEY_PREFIX}${traceId}`;
}

/** The trace a record with this stored context copies, or `undefined` for a record that copies no trace. */
export function copiedTraceId(context: unknown): string | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const { memoryTraceId } = context as Record<string, unknown>;
  return typeof memoryTraceId === 'string' && memoryTraceId !== '' ? memoryTraceId : undefined;
}

/** Whether a record with this stored context copies a trace the filter names, by its trace id or by its scope. */
export function isMemoryCopyOf(context: unknown, filter: MemoryCopyFilter): boolean {
  if (!context || typeof context !== 'object') return false;
  const { memoryTraceId, scope, scopeId } = context as Record<string, unknown>;
  if (typeof memoryTraceId === 'string' && filter.traceIds?.includes(memoryTraceId)) return true;
  if (typeof scope !== 'string' || typeof scopeId !== 'string') return false;
  return (filter.scopes ?? []).some((pair) => pair.scope === scope && pair.scopeId === scopeId);
}

/** Whether the filter names nothing. */
export function isEmptyCopyFilter(filter: MemoryCopyFilter): boolean {
  return !filter.traceIds?.length && !filter.scopes?.length;
}

/** The filter's trace ids, each once. */
export function filterTraceIds(filter: MemoryCopyFilter): string[] {
  return [...new Set(filter.traceIds ?? [])];
}

/**
 * Text a stored context's JSON holds when it names one of these scope ids: `"scopeId":"<id>"`, as `JSON.stringify`
 * writes it. A store narrows a scope read with it (`LIKE`, `CONTAINS`) and then applies {@link isMemoryCopyOf} to what
 * it read, so a needle that also matches elsewhere costs a row, never a wrong delete.
 */
export function scopeNeedles(scopes: NonNullable<MemoryCopyFilter['scopes']>): string[] {
  return [...new Set(scopes.map((pair) => `"scopeId":${JSON.stringify(pair.scopeId)}`))];
}
