/**
 * @fileoverview The registry of conversation scopes (`memory_scopes`): one row a scope, written with the scope's first
 * trace, so a scope that holds traces can be found by its subject without reading the traces.
 * @module memory/retrieval/store/conversationScopes
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { CONVERSATION_SCOPE, parseConversationScopeKey } from './conversationScopeKey.js';

/**
 * The registry row of one conversation scope, written once: a second call changes nothing.
 *
 * @param db - The adapter, the Brain, or the transaction the scope's trace is written in.
 * @param now - The row's `created_at` when this call writes it, in Unix milliseconds.
 * @throws TypeError when `scopeId` is not a key `conversationScopeKey` built.
 */
export async function ensureScopeRow(
  db: Pick<StorageAdapter, 'run'>,
  brainId: string,
  scopeId: string,
  now: number,
): Promise<void> {
  const parsed = parseConversationScopeKey(scopeId);
  if (!parsed) throw new TypeError("a trace of the 'conversation' scope needs a scope id conversationScopeKey() built");
  await db.run(
    `INSERT INTO memory_scopes (brain_id, scope, scope_id, kind, agent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (brain_id, scope, scope_id) DO NOTHING`,
    [brainId, CONVERSATION_SCOPE, scopeId, parsed.subject.kind, parsed.agentId, now],
  );
}

/**
 * Registers every conversation scope this brain holds traces under and no row for, such as one an import wrote.
 * A scope id that is not a key `conversationScopeKey` wrote gets no row.
 *
 * @returns How many rows it added.
 */
export async function registerUnregisteredConversationScopes(
  db: Pick<StorageAdapter, 'run' | 'all'>,
  brainId: string,
): Promise<number> {
  const rows = await db.all<{ scope_id: string; first_at: number | string }>(
    `SELECT t.scope_id AS scope_id, MIN(t.created_at) AS first_at
       FROM memory_traces t
      WHERE t.brain_id = ? AND t.scope = ?
        AND NOT EXISTS (
          SELECT 1 FROM memory_scopes s
           WHERE s.brain_id = t.brain_id AND s.scope = t.scope AND s.scope_id = t.scope_id)
      GROUP BY t.scope_id`,
    [brainId, CONVERSATION_SCOPE],
  );
  let added = 0;
  for (const row of rows) {
    if (!parseConversationScopeKey(row.scope_id)) continue;
    await ensureScopeRow(db, brainId, row.scope_id, Number(row.first_at));
    added += 1;
  }
  return added;
}
