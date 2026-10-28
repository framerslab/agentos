/**
 * @module memory/retrieval/graph/knowledge/memoryCopies
 *
 * The one rule every knowledge graph applies to find a memory trace's episodic copy: the record's stored context
 * names the trace (`memoryTraceId`), or its scope and scope id, as `MemoryStore.store` writes them.
 */
import type { MemoryCopyFilter } from './IKnowledgeGraph.js';

/** Whether a record with this stored context copies a trace the filter names. */
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

/**
 * Substrings a stored context's JSON holds when it can match the filter: `"memoryTraceId":"<id>"` and
 * `"scopeId":"<id>"`, as `JSON.stringify` writes them. A store narrows its read with them (`LIKE`, `CONTAINS`) and
 * then applies {@link isMemoryCopyOf} to what it read, so a needle that also matches elsewhere costs a row, never a
 * wrong delete.
 */
export function copyNeedles(filter: MemoryCopyFilter): string[] {
  return [
    ...(filter.traceIds ?? []).map((id) => `"memoryTraceId":${JSON.stringify(id)}`),
    ...(filter.scopes ?? []).map((pair) => `"scopeId":${JSON.stringify(pair.scopeId)}`),
  ];
}
