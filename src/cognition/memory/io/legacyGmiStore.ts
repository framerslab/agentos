/** @internal The passed GMI store's reads and deletion operations. */
import { learnerUserScopeId } from '../../learning/scopes.js';
import type { Brain } from '../retrieval/store/Brain.js';

/** The label used in a deletion report or an export's unread entries. */
export const LEGACY_GMI_STORE = 'legacy GMI store';

/** A passed store with its own Brain and the manager route that takes its traces and their copies. */
export interface LegacyGmiStore {
  brain: Brain;
  namespace: string;
  deleteTraces(ids: readonly string[], options?: { withoutEmbeddings?: true }): Promise<{ deleted: number }>;
}

/** Counts the live rows under each scope without reading their words. */
export function countLegacyGmiScopes({ brain }: LegacyGmiStore) {
  return brain.all<{ scope: string; scope_id: string; traces: number | string }>(
    `SELECT scope, scope_id, COUNT(*) AS traces FROM memory_traces
      WHERE brain_id = ? AND deleted = 0 GROUP BY scope, scope_id ORDER BY scope, scope_id`,
    [brain.brainId],
  );
}

/** The named learner's rows in creation order. A move also reads rows a failed deletion left soft-deleted. */
export function readLegacyGmiRows(store: LegacyGmiStore, userId: string, includeSoftDeleted = false) {
  const scopeId = learnerUserScopeId({ namespace: store.namespace, userId });
  return store.brain.all<{ id: string; type: string; content: string; created_at: number; tags: string; deleted: number }>(
    `SELECT id, type, content, created_at, tags, deleted FROM memory_traces
      WHERE brain_id = ? AND scope = 'user' AND scope_id = ? ${includeSoftDeleted ? '' : 'AND deleted = 0'}
      ORDER BY created_at, id`,
    [store.brain.brainId, scopeId],
  );
}
