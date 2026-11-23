/** @internal The passed GMI store's reads and deletion operations. */
import { learnerScopeIds, learnerUserScopeId, sessionScopeIds, taggedScopeId } from '../../learning/scopes.js';
import type { Brain } from '../retrieval/store/Brain.js';
import { isMissingTableError } from '../retrieval/store/missingTable.js';

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

/** A JSON list of strings as the learning tables store one; anything else reads as an empty list. */
function listOf(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The ids of every row the passed store holds of the named learner, whatever its deleted flag: under the learner's
 * user scope and every persona scope of it, under the scopes of the learner's own sessions that the store's own
 * learning tables index, and the rows a turn filed for them as a second user (`turnUserId`). A deletion records them
 * before it deletes, so a restore of that store alone is undone at the next open even when the learning tables that
 * name the person live in another store, and it deletes those the learning layer's index did not reach.
 */
export async function legacyGmiTraceIdsOf(store: LegacyGmiStore, userId: string): Promise<string[]> {
  const { brain, namespace } = store;
  const user = { namespace, userId };
  const userScope = learnerUserScopeId(user);
  const scopes = new Map<string, { scope: string; scopeId: string }>();
  const add = (scope: string, scopeId: string): void => {
    scopes.set(`${scope}\u0000${scopeId}`, { scope, scopeId });
  };
  add('user', userScope);
  type SessionIndexRow = { session_id: unknown; kind: unknown; persona_id: unknown; conversation_ids: unknown };
  let sessions: SessionIndexRow[] = [];
  try {
    sessions = await brain.all<SessionIndexRow>(
      'SELECT session_id, kind, persona_id, conversation_ids FROM agentos_learning_sessions WHERE namespace = ? AND user_id = ?',
      [namespace, userId],
    );
  } catch (error) {
    // A store whose database holds no learning tables indexes no session of the learner.
    if (!isMissingTableError(error)) throw error;
  }
  for (const row of sessions) {
    // A session the person spoke on as a second user is another learner's: its rows of theirs carry `turnUserId`.
    if (row.kind !== 'learner') continue;
    const sessionId = String(row.session_id);
    const personaId = String(row.persona_id);
    add('persona', learnerScopeIds(user, personaId).personaScopeId);
    const session = sessionScopeIds(sessionId, namespace, personaId);
    add('user', session.userScopeId);
    add('persona', session.personaScopeId);
    for (const id of [...listOf(row.conversation_ids), sessionId]) add('thread', taggedScopeId(id, namespace));
  }

  const ids = new Set<string>();
  for (const { scope, scopeId } of scopes.values()) {
    const rows = await brain.all<{ id: string }>(
      'SELECT id FROM memory_traces WHERE brain_id = ? AND scope = ? AND scope_id = ?',
      [brain.brainId, scope, scopeId],
    );
    for (const row of rows) ids.add(row.id);
  }
  // Persona scopes of personas no table of the store names: `<u>::<persona>`. LIKE narrows the read, and the exact
  // prefix is compared here, since SQLite's LIKE ignores the case of ASCII letters.
  const prefix = `${userScope}::`;
  const personaRows = await brain.all<{ id: string; scope_id: string | null }>(
    `SELECT id, scope_id FROM memory_traces WHERE brain_id = ? AND scope = 'persona' AND scope_id LIKE ? ESCAPE '!'`,
    [brain.brainId, `${prefix.replace(/[!%_]/g, (character) => `!${character}`)}%`],
  );
  for (const row of personaRows) if (row.scope_id?.startsWith(prefix)) ids.add(row.id);
  // Only a row whose metadata text holds the key is read as JSON, so one row of another writer that is not JSON never
  // fails the read.
  const { dialect } = brain.features;
  const isJson = dialect.name === 'sqlite' ? ' AND json_valid(metadata)' : '';
  const named = await brain.all<{ id: string }>(
    `SELECT id FROM memory_traces WHERE brain_id = ?
      AND (CASE WHEN metadata LIKE ?${isJson} THEN ${dialect.jsonExtract('metadata', '$.turnUserId')} END) = ?`,
    [brain.brainId, '%"turnUserId"%', userId],
  );
  for (const row of named) ids.add(row.id);
  return [...ids];
}

/**
 * Moves the passed store's write-ahead log into its file and empties the log, so neither file holds the text a
 * deletion removed (a file the agent opened by its path deletes with `secure_delete` on).
 *
 * @returns `'emptied'`; `'busy'` when another connection held the log, which keeps the deleted text until a later
 *   checkpoint; `'none'` for a database that keeps no such log (PostgreSQL).
 */
export async function checkpointLegacyGmiStore(store: LegacyGmiStore): Promise<'emptied' | 'busy' | 'none'> {
  const checkpoint = store.brain.features.dialect.pragma('wal_checkpoint', 'TRUNCATE');
  if (!checkpoint) return 'none';
  const row = await store.brain.get<{ busy?: number | string | null }>(checkpoint);
  return Number(row?.busy ?? 0) === 0 ? 'emptied' : 'busy';
}
