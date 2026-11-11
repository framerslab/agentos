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

/** True for a trace's tags (a JSON array in text) that mark it a chunk of a wiki page. */
function isPageChunk(tags: unknown): boolean {
  if (typeof tags !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(tags);
    return Array.isArray(parsed) && parsed.includes('wiki');
  } catch {
    return false;
  }
}

/**
 * Moves the compile watermark of each scope in `held` back to just before the oldest trace `stored` files under it,
 * where the watermark is at or after that trace, so the scope's next compile reads a trace an import stored under a
 * scope that was already compiled past its time. A page chunk moves nothing; a scope the import brought in with its
 * own registry row keeps that row's watermark.
 *
 * @param held - The conversation scopes the brain registered before the import.
 * @param stored - The rows the import wrote: their `scope`, `scope_id`, `created_at` and `tags`.
 */
export async function reopenCompiledScopes(
  db: Pick<StorageAdapter, 'run'>,
  brainId: string,
  held: ReadonlySet<string>,
  stored: Iterable<{ scope?: unknown; scope_id?: unknown; created_at?: unknown; tags?: unknown }>,
): Promise<void> {
  const oldest = new Map<string, number>();
  for (const row of stored) {
    if (row.scope !== CONVERSATION_SCOPE || typeof row.scope_id !== 'string' || !held.has(row.scope_id)) continue;
    if (isPageChunk(row.tags)) continue;
    const at = Number(row.created_at);
    if (!Number.isFinite(at)) continue;
    const seen = oldest.get(row.scope_id);
    if (seen === undefined || at < seen) oldest.set(row.scope_id, at);
  }
  for (const [scopeId, at] of oldest) {
    await db.run(
      `UPDATE memory_scopes SET compiled_at = ?
        WHERE brain_id = ? AND scope = ? AND scope_id = ? AND compiled_at IS NOT NULL AND compiled_at >= ?`,
      [at - 1, brainId, CONVERSATION_SCOPE, scopeId, at],
    );
  }
}
