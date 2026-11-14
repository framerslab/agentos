/**
 * @fileoverview The one eligibility gate of the recall legs that read outside the vector index.
 *
 * @module agentos/cognition/memory/retrieval/recall/eligibility
 */
import { canUseFor, type MemoryTrace } from '../../core/types.js';
import type { LegQuery } from './legs/leg.js';

/**
 * Whether a trace a recall leg found may enter the turn's recall: active, in one of the turn's scopes, of a requested
 * type, at or above `minConfidence` (on `provenance.confidence`), created at or after `timeRange.after`, and usable for
 * every requested capability under its trust policy at the turn's `now`. These are the conditions the dense recall
 * applies through the vector store's filter and the manager's trust-policy check. Deleted, tombstoned and
 * delete-pending traces never reach it: `MemoryStore.loadTracesForRecall` leaves them out.
 *
 * @param trace - The trace, as the store loaded it.
 * @param q - The turn's scopes, filters and clock.
 */
export function isEligibleForRecall(
  trace: MemoryTrace,
  q: Pick<LegQuery, 'scopes' | 'types' | 'minConfidence' | 'after' | 'usableFor' | 'now'>,
): boolean {
  if (!trace.isActive) return false;
  if (!q.scopes.some((s) => s.scope === trace.scope && s.scopeId === trace.scopeId)) return false;
  if (q.types?.length && !q.types.includes(trace.type)) return false;
  if (q.minConfidence != null && !((trace.provenance?.confidence ?? 0) >= q.minConfidence)) return false;
  if (q.after != null && !(trace.createdAt >= q.after)) return false;
  if (q.usableFor?.length && !q.usableFor.every((capability) => canUseFor(trace, capability, q.now))) return false;
  return true;
}
