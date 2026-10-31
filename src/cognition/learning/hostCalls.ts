/**
 * @module learning/hostCalls
 *
 * What the layer's operator calls share: the key a run-time freeze or suspension is stored under, and which turns
 * it covers.
 */
import { encodeScopeIdPart } from '../memory/retrieval/store/scopeIdForm.js';
import type { FreezeRow } from './store/LearningStore.js';
import type { FreezeScope, LearnerKey } from './types.js';

/** The scope a turn's mode is read for: its agent, and its learner on a learner's turn. */
export interface FreezeTarget {
  agentKey: string;
  learner?: LearnerKey;
}

/** The key a run-time freeze or suspension is stored under: `all`, `agent|<agentKey>` or `learner|<ns>|<agent>|<user>`. */
export function freezeScopeKey(scope: FreezeScope): string {
  if ('scope' in scope) return 'all';
  if ('agentKey' in scope) return `agent|${encodeScopeIdPart(scope.agentKey)}`;
  const { namespace, agentKey, userId } = scope.learner;
  return `learner|${encodeScopeIdPart(namespace)}|${encodeScopeIdPart(agentKey)}|${encodeScopeIdPart(userId)}`;
}

/** Whether a stored freeze or suspension covers a turn of `target`. */
export function freezeCovers(row: Pick<FreezeRow, 'scopeKey'>, target: FreezeTarget): boolean {
  if (row.scopeKey === 'all') return true;
  if (row.scopeKey === freezeScopeKey({ agentKey: target.agentKey })) return true;
  return target.learner !== undefined && row.scopeKey === freezeScopeKey({ learner: target.learner });
}
