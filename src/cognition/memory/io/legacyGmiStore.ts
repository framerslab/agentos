/** @internal The passed GMI store's reads and deletion operations. */
import { learnerUserScopeId } from '../../learning/scopes.js';
import type { Brain } from '../retrieval/store/Brain.js';

/** The label used in a deletion report or an export's unread entries. */
export const LEGACY_GMI_STORE = 'legacy GMI store';

/** A passed store with its own Brain and the manager route that takes its traces and their copies. */
export interface LegacyGmiStore {
  brain: Brain;
  namespace: string;
  deleteTraces(ids: readonly string[]): Promise<{ deleted: number }>;
}

/** Live rows of the named learner alone, in creation order. */
export function readLegacyGmiRows(store: LegacyGmiStore, userId: string) {
  const scopeId = learnerUserScopeId({ namespace: store.namespace, userId });
  return store.brain.all<{ id: string; content: string; created_at: number; tags: string }>(
    `SELECT id, content, created_at, tags FROM memory_traces
      WHERE brain_id = ? AND scope = 'user' AND scope_id = ? AND deleted = 0 ORDER BY created_at, id`,
    [store.brain.brainId, scopeId],
  );
}
