/**
 * @module memory/io/retentionSweep
 *
 * The retention sweep: each subject's conversation traces older than the period are deleted for good, with the pages
 * that were compiled from them.
 */
import { memoryLog } from '../log.js';
import { CONVERSATION_SCOPE } from '../retrieval/store/conversationScopeKey.js';
import type { Memory } from './facade/Memory.js';
import type { SubjectPages } from './forgetUserMemory.js';

/** How long a subject's traces are kept: a number of days from the time each was stored, or until the subject's deletion. */
export type RetentionPeriod = { days: number } | 'until-deletion';

export interface RetentionSweepOptions {
  /** The store. */
  memory: Memory;
  /** The page store of one subject, by its conversation key. */
  wiki: { storeFor(scopeId: string): SubjectPages };
  retention: {
    /** The period of a user's traces, and of a session's when `sessions` is unset. */
    traces: RetentionPeriod;
    /** The period of the traces of sessions that named no user. */
    sessions?: RetentionPeriod;
    /**
     * What happens to a page when a trace it was compiled from expires: deleted whole (the default), or deleted and
     * rebuilt by the next compile from the traces that are left.
     */
    pages?: 'delete-whole' | 'rebuild';
  };
  /** A shorter period, in days, for one scope: an account's own policy. It never lengthens the agent's period. */
  daysFor?: (scopeId: string) => number | undefined;
  /** Runs one scope's sweep in that subject's turn, after its writes and compiles. Unset: at once. */
  onChain?: <T>(scopeId: string, work: () => Promise<T>) => Promise<T>;
  /** The clock, in Unix ms. Default `Date.now`. */
  now?: () => number;
}

const DAY_MS = 86_400_000;

/** The days a period holds; undefined for `'until-deletion'` and for none. */
const daysOf = (period: RetentionPeriod | undefined): number | undefined =>
  period !== undefined && period !== 'until-deletion' ? period.days : undefined;

/**
 * Deletes for good what expired, one user or session scope at a time: the scope's traces stored longer ago than its
 * period (soft-deleted rows and the document chunks they were filed from included), and each page compiled from one
 * of them, whole. With `pages: 'rebuild'` the next compile builds such a page again from the traces of it that are
 * left. A page whose sources all survive is not touched, and a page's own age is no second clock. A scope left with
 * no trace and no page loses its registry row. The operator's pages and memory from before per-user scope are never
 * swept.
 *
 * Once a trace was deleted the vector index is written again and the store's write-ahead log emptied. One
 * `memory.retention_swept` line counts what went, for a sweep in which at least one scope had a period.
 *
 * @returns How many traces and pages it deleted, and how many scopes it removed from the registry.
 * @throws What the store throws; the scopes swept before it keep what the sweep did.
 */
export async function sweepRetention(options: RetentionSweepOptions): Promise<{ traces: number; pages: number; scopes: number }> {
  const { memory, retention } = options;
  const now = options.now ?? Date.now;
  const swept = { traces: 0, pages: 0, scopes: 0 };
  let anyPeriod = false;

  for (const row of await memory.listScopes({ scope: CONVERSATION_SCOPE })) {
    if (row.kind !== 'user' && row.kind !== 'session') continue;
    const scopeId = row.scopeId;
    const ofAgent = daysOf(row.kind === 'session' ? (retention.sessions ?? retention.traces) : retention.traces);
    const ofAccount = options.daysFor?.(scopeId);
    const shorter = typeof ofAccount === 'number' && Number.isFinite(ofAccount) && ofAccount > 0 ? ofAccount : undefined;
    const days = ofAgent === undefined ? shorter : shorter === undefined ? ofAgent : Math.min(ofAgent, shorter);
    if (days === undefined) continue;
    anyPeriod = true;

    const sweepScope = async (): Promise<void> => {
      const expired = await memory.tracesStoredBefore(CONVERSATION_SCOPE, scopeId, now() - days * DAY_MS);
      if (expired.length > 0) swept.traces += (await memory.deleteTraces(expired, { documentChunks: 'delete' })).deleted;
      const store = options.wiki.storeFor(scopeId);
      const gone = new Set(expired);
      for (const page of gone.size > 0 ? await store.listPages() : []) {
        if (!page.sources.some((id) => gone.has(id))) continue;
        await store.deletePage(page.id);
        swept.pages += 1;
        if (retention.pages === 'rebuild') {
          await memory.addRebuildSources(
            scopeId,
            page.sources.filter((id) => !gone.has(id)),
          );
        }
      }
      // A scope that holds nothing more is no longer named by the registry.
      const left = await memory.tracesStoredBefore(CONVERSATION_SCOPE, scopeId, Number.MAX_SAFE_INTEGER);
      if (left.length === 0 && (await memory.listPageRows(scopeId)).length === 0) {
        await memory.deleteScope(CONVERSATION_SCOPE, scopeId);
        swept.scopes += 1;
      }
    };
    await (options.onChain ? options.onChain(scopeId, sweepScope) : sweepScope());
  }

  if (swept.traces > 0) {
    // A delete only marks a vector in the index, and the log still holds the pages written before the deletes.
    await memory.rebuildVectorIndex();
    await memory.checkpointLog();
  }
  if (anyPeriod) memoryLog.info('memory.retention_swept', { traces: swept.traces, pages: swept.pages, scopes: swept.scopes });
  return swept;
}
