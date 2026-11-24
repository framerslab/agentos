/**
 * @module memory/io/retentionSweep
 *
 * The retention sweep: each subject's conversation traces older than the period are deleted for good, with the pages
 * that were compiled from them.
 */
import { memoryLog } from '../log.js';
import { CONVERSATION_SCOPE } from '../retrieval/store/conversationScopeKey.js';
import type { AgentSession } from '../../../api/agent.js';
import type { SoulMind } from '../../../api/runtime/soulStore.js';
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
  /**
   * The deletion side of a souled agent's mind, on either runtime and with cognitive memory on or off: each
   * scope's expired traces are deleted through it before the store's own delete, with what it keeps of each (its cached
   * copy, vector, memory-graph node and archived original), and dropped from the subject's open sessions
   * (`sessionsOf`) once they are gone. A delete of the mind that fails leaves the scope's traces for the next sweep and
   * is the sweep's first failure.
   *
   * @internal
   */
  mind?: Pick<SoulMind, 'deleteTraces' | 'evictTraces'>;
  /** The sessions open for one scope's subject, whose working memory `mind` drops the expired traces from. Unset: none. */
  sessionsOf?: (scopeId: string) => Iterable<AgentSession>;
}

const DAY_MS = 86_400_000;

/** The days a period holds; undefined for `'until-deletion'` and for none. */
const daysOf = (period: RetentionPeriod | undefined): number | undefined =>
  period !== undefined && period !== 'until-deletion' ? period.days : undefined;

/**
 * How many days one scope's traces are kept: the agent's period for the scope's kind (a session's falls back to the
 * users' period), shortened by an account's own policy where it gives fewer days; undefined when nothing ends them.
 */
export function retentionDaysOf(
  retention: RetentionSweepOptions['retention'],
  kind: 'user' | 'session',
  ofAccount: number | undefined,
): number | undefined {
  const ofAgent = daysOf(kind === 'session' ? (retention.sessions ?? retention.traces) : retention.traces);
  const shorter = typeof ofAccount === 'number' && Number.isFinite(ofAccount) && ofAccount > 0 ? ofAccount : undefined;
  return ofAgent === undefined ? shorter : shorter === undefined ? ofAgent : Math.min(ofAgent, shorter);
}

/** One day in milliseconds. @internal */
export const RETENTION_DAY_MS = DAY_MS;

/**
 * Deletes for good what expired, one user or session scope at a time: each page compiled from an expired trace,
 * whole, then the scope's traces stored longer ago than its period (soft-deleted rows and the document chunks they
 * were filed from included), with the text the tombstones' second copy keeps of an expired correction. With a souled
 * agent's mind (`mind`), the traces go through it first, with what it keeps of each, and leave the working memory of
 * the subject's open sessions. The pages go first: while a page is left, the expired traces it was built from are left
 * too, so a sweep that stopped is finished by the next one. With `pages: 'rebuild'` the next compile builds such a
 * page again from the traces of it that are left. A page whose sources all survive is not touched, and a page's own
 * age is no second clock. A scope left with no trace and no page loses its registry row. The operator's pages and
 * memory from before per-user scope are never swept.
 *
 * Then the vector index is written again and the store's write-ahead log emptied, for this sweep's deletes and for
 * any an earlier sweep or deletion could not finish ({@link Memory.finishErasure}), also when a scope failed. One
 * `memory.retention_swept` line counts what went, for a sweep in which at least one scope had a period.
 *
 * @returns How many traces and pages it deleted, and how many scopes it removed from the registry.
 * @throws The first error a scope, the index or the log threw, once every scope, the index and the log were tried;
 *   what the sweep did in the other scopes stands, and the next sweep finishes the scope that failed.
 */
export async function sweepRetention(options: RetentionSweepOptions): Promise<{ traces: number; pages: number; scopes: number }> {
  const { memory, retention } = options;
  const now = options.now ?? Date.now;
  const swept = { traces: 0, pages: 0, scopes: 0 };
  let anyPeriod = false;

  /** Sweeps one registry row's scope, when it is a user's or a session's and has a period. */
  const sweepOne = async (row: { kind: string; scopeId: string }): Promise<void> => {
    if (row.kind !== 'user' && row.kind !== 'session') return;
    const scopeId = row.scopeId;
    const days = retentionDaysOf(retention, row.kind as 'user' | 'session', options.daysFor?.(scopeId));
    if (days === undefined) return;
    anyPeriod = true;

    const sweepScope = async (): Promise<void> => {
      const cutoff = now() - days * DAY_MS;
      const expired = await memory.tracesStoredBefore(CONVERSATION_SCOPE, scopeId, cutoff);
      const store = options.wiki.storeFor(scopeId);
      const gone = new Set(expired);
      // The pages first: a page is found by the expired traces it was built from, so they stay until it is gone.
      for (const page of gone.size > 0 ? await store.listPages() : []) {
        if (!page.sources.some((id) => gone.has(id))) continue;
        if (retention.pages === 'rebuild') {
          // Named before the page goes, so a page deleted is always rebuilt; a sweep made again names them once.
          await memory.addRebuildSources(
            scopeId,
            page.sources.filter((id) => !gone.has(id)),
          );
        }
        await store.deletePage(page.id);
        swept.pages += 1;
      }
      const mind = options.mind;
      if (expired.length > 0 && mind) {
        // What the store finds of each trace by its row alone goes while the rows still name it: the document chunks
        // the traces were filed from, with their text, and each trace's knowledge-graph copy and memory-graph node.
        // Then the mind takes the rows, with what it keeps of each. A delete of the mind that fails leaves the rows it
        // did not take for the next sweep, which finds them by their age.
        await memory.deleteDocumentChunksOf(expired);
        await memory.deleteGraphRecordsOf(expired);
        try {
          const { deleted } = await mind.deleteTraces(expired);
          swept.traces += deleted;
          if (deleted > 0) memory.markErasureOwed();
        } catch (error) {
          // A delete that failed part way may have deleted rows: their words leave the indexes with this sweep's rewrite.
          memory.markErasureOwed();
          throw error;
        }
      }
      if (expired.length > 0) {
        try {
          swept.traces += (await memory.deleteTraces(expired, { documentChunks: 'delete' })).deleted;
        } catch (error) {
          // Once the mind has taken every expired row, the store owes them its indexes alone, which this sweep's rewrite
          // makes, and the next sweep would find none of them by their age. With a row left, the next sweep finds it.
          if (!mind || (await memory.storedTracesAmong(expired)).length > 0) throw error;
          memory.markErasureOwed();
        }
      }
      // A slot of an open session holds a trace's id and no words: it goes once the traces are gone.
      if (expired.length > 0 && mind) await mind.evictTraces(expired, options.sessionsOf?.(scopeId) ?? []);
      // A correction that expired goes from the tombstones' second copy too, so no restore files it again: by the
      // traces deleted now, and by its own time, so a sweep made again after a drop that failed still finds it once
      // the store no longer holds the trace.
      const ledger = memory.forgotten;
      if (ledger) {
        const stale = new Set(expired);
        for (const row of await ledger.keptCorrections(scopeId)) if (row.createdAt < cutoff) stale.add(row.traceId);
        if (stale.size > 0) await ledger.dropCorrections([...stale]);
      }
      // A scope that holds nothing more is no longer named by the registry.
      const left = await memory.tracesStoredBefore(CONVERSATION_SCOPE, scopeId, Number.MAX_SAFE_INTEGER);
      if (left.length === 0 && (await memory.listPageRows(scopeId)).length === 0) {
        await memory.deleteScope(CONVERSATION_SCOPE, scopeId);
        swept.scopes += 1;
      }
    };
    await (options.onChain ? options.onChain(scopeId, sweepScope) : sweepScope());
  };

  let failure: unknown;
  try {
    // Each scope is swept on its own: one that fails leaves the scopes after it to this sweep, not to the next.
    for (const row of await memory.listScopes({ scope: CONVERSATION_SCOPE })) {
      try {
        await sweepOne(row);
      } catch (error) {
        failure ??= error;
      }
    }
  } catch (error) {
    failure ??= error;
  }
  try {
    // A delete only marks a vector in the index, and the log still holds the pages written before the deletes: both
    // are written out for this sweep's deletes, and for those an earlier sweep or deletion left unfinished.
    await memory.finishErasure();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
  if (anyPeriod) memoryLog.info('memory.retention_swept', { traces: swept.traces, pages: swept.pages, scopes: swept.scopes });
  return swept;
}
