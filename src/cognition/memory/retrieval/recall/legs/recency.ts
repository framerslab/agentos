/**
 * @fileoverview The recency recall leg: the newest traces of the turn's scopes.
 *
 * @module agentos/cognition/memory/retrieval/recall/legs/recency
 */
import type { MemoryStore } from '../../store/MemoryStore.js';
import { isEligibleForRecall } from '../eligibility.js';
import { readGatedPages, scopeAndFilterSql } from './exactWords.js';
import type { LegQuery, LegResult } from './leg.js';

/**
 * The recency leg: the newest traces of the turn's scopes, newest first, equal times by id. A store with a Brain reads
 * `memory_traces` with the scopes, types and time written into the query, a page of `limit` rows at a time, and the
 * rows after a page stand in for the ones the eligibility gate drops ({@link readGatedPages}); a store without one
 * reads its cache and gates it whole. In process, `ineligible` counts the scopes' cached traces the gate dropped; on a
 * Brain, the rows of the pages read that it dropped. Never throws: a failed read answers `ran: false`.
 *
 * @param deps - The store.
 * @param q - The turn's scopes and filters, and the leg's limit (`query` is not read).
 */
export async function recencyLeg(deps: { store: MemoryStore }, q: LegQuery): Promise<LegResult> {
  const started = performance.now();
  const answer = (over: Partial<LegResult>): LegResult => ({
    leg: 'recency',
    ran: true,
    traces: [],
    ineligible: 0,
    ...over,
    ms: Math.round(performance.now() - started),
  });
  // A turn with no scopes may read no row: the leg does not run.
  if (q.scopes.length === 0) return answer({ ran: false, reason: 'no_scopes' });
  if (q.limit <= 0) return answer({});
  try {
    const brain = deps.store.getBrain();
    if (!brain) {
      const cached = q.scopes.flatMap(({ scope, scopeId }) => deps.store.listTraces({ activeOnly: true, scope, scopeId }));
      const unique = [...new Map(cached.map((trace) => [trace.id, trace])).values()].filter((trace) => !deps.store.isDeleted(trace.id));
      const eligible = unique
        .filter((trace) => isEligibleForRecall(trace, q))
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return answer({ traces: eligible.slice(0, q.limit), ineligible: unique.length - eligible.length });
    }
    const filter = scopeAndFilterSql(q);
    const gated = await readGatedPages(deps.store, q, async (offset, size) =>
      (
        await brain.all<{ id: string }>(
          `SELECT mt.id FROM memory_traces mt
            WHERE mt.brain_id = ? AND mt.deleted = 0 AND ${filter.sql}
            ORDER BY mt.created_at DESC, mt.id ASC LIMIT ? OFFSET ?`,
          [brain.brainId, ...filter.params, size, offset],
        )
      ).map((row) => row.id),
    );
    return gated === 'query_error' ? answer({ ran: false, reason: 'query_error' }) : answer(gated);
  } catch {
    return answer({ ran: false, reason: 'query_error' });
  }
}
