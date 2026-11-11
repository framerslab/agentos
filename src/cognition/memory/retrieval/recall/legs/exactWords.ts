/**
 * @fileoverview The exact-words recall leg: the traces of the turn's scopes whose content or tags hold the turn's
 * words, read from the Brain's full-text index through the storage adapter's engine-neutral query, or from the
 * in-process index of a store with no Brain.
 *
 * @module agentos/cognition/memory/retrieval/recall/legs/exactWords
 */
import type { MemoryTrace } from '../../../core/types.js';
import type { Brain } from '../../store/Brain.js';
import type { MemoryStore } from '../../store/MemoryStore.js';
import { bindingsFor, buildNaturalLanguageFtsQuery } from '../../store/tracePersistence.js';
import type { MemoryRecallCapture } from '../capture.js';
import { isEligibleForRecall } from '../eligibility.js';
import type { ScopedLexicalIndex } from '../lexical.js';
import type { LegQuery, LegResult } from './leg.js';

/** What the index check found for each Brain: a missing index stays missing for the Brain's life. */
const probed = new WeakMap<Brain, 'ok' | 'no_index'>();
/** A one-word query every full-text engine accepts. */
const PROBE_TERM = 'memory';

/**
 * Whether a full-text statement failed because the database has no index: SQLite's two messages for a build without
 * the module or a database the index was never made in, or Postgres's undefined `_tsv` column (SQLSTATE 42703).
 */
function indexMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('no such module: fts5') || message.includes('no such table: memory_traces_fts')) return true;
  return (error as { code?: unknown } | null)?.code === '42703' && message.includes('_tsv');
}

/**
 * Runs the leg's own query shape once per Brain. It names no table of its own, since on Postgres the index is a
 * column of `memory_traces`. Any error but a missing index answers `query_error` and is asked again on the next turn.
 */
async function probeIndex(brain: Brain): Promise<'ok' | 'no_index' | 'query_error'> {
  const known = probed.get(brain);
  if (known) return known;
  const { fts } = brain.features;
  try {
    await brain.all(
      `SELECT mt.id FROM ${fts.joinClause('memory_traces', 'mt', 'memory_traces_fts', 'memory_traces_fts')}
        WHERE ${fts.matchClause('memory_traces_fts', '?')} AND mt.brain_id = ? LIMIT 1`,
      [PROBE_TERM, brain.brainId],
    );
    probed.set(brain, 'ok');
    return 'ok';
  } catch (error) {
    if (!indexMissing(error)) return 'query_error';
    probed.set(brain, 'no_index');
    return 'no_index';
  }
}

/**
 * The index a store's exact-words leg reads: the Brain's full-text engine by the rule the storage adapter picks it
 * with (Postgres's tsvector, FTS4 on sql.js and IndexedDB, FTS5 on every other SQLite adapter), `in_process` for a
 * store with no Brain and an in-process index, and `none` when there is no index or the index check found none.
 */
export function lexicalBackendOf(store: MemoryStore, lexical: ScopedLexicalIndex | null): MemoryRecallCapture['lexicalBackend'] {
  const brain = store.getBrain();
  if (!brain) return lexical ? 'in_process' : 'none';
  if (probed.get(brain) === 'no_index') return 'none';
  if (brain.features.dialect.name === 'postgres') return 'postgres_tsvector';
  const kind = brain.adapter.kind;
  return kind === 'sqljs' || kind === 'indexeddb' ? 'fts4' : 'fts5';
}

/**
 * The scope, type and time conditions a durable leg writes into its query, with their bindings. A scope id is bound
 * as the turn passes it, the form the store writes into `scope_id`.
 */
export function scopeAndFilterSql(q: Pick<LegQuery, 'scopes' | 'types' | 'after'>): { sql: string; params: unknown[] } {
  const clauses = [`(${q.scopes.map(() => '(mt.scope = ? AND mt.scope_id = ?)').join(' OR ')})`];
  const params: unknown[] = q.scopes.flatMap((s) => [s.scope, s.scopeId]);
  if (q.types?.length) {
    clauses.push(`mt.type IN (${q.types.map(() => '?').join(', ')})`);
    params.push(...q.types);
  }
  if (q.after != null) {
    clauses.push('mt.created_at >= ?');
    params.push(q.after);
  }
  return { sql: clauses.join(' AND '), params };
}

/**
 * Loads the traces of `ids` through the store and keeps, in the ids' order, the ones the eligibility gate passes.
 * A read that failed and found nothing is the leg's `query_error`.
 */
export async function eligibleTracesOf(
  store: MemoryStore,
  ids: readonly string[],
  q: LegQuery,
): Promise<{ traces: MemoryTrace[]; ineligible: number } | 'query_error'> {
  if (ids.length === 0) return { traces: [], ineligible: 0 };
  const { traces: loaded, unread } = await store.loadTracesForRecall(ids);
  if (unread > 0 && loaded.size === 0) return 'query_error';
  const found = ids.map((id) => loaded.get(id)).filter((trace): trace is NonNullable<typeof trace> => trace !== undefined);
  const eligible = found.filter((trace) => isEligibleForRecall(trace, q));
  return { traces: eligible, ineligible: found.length - eligible.length };
}

/** How many pages of `limit` rows a durable leg reads, at most, to fill its limit with traces the gate passes. */
export const MAX_GATED_PAGES = 4;

/**
 * Reads a durable leg's rows a page of `q.limit` at a time, in the query's order, and keeps the traces the eligibility
 * gate passes, until the limit is filled, the rows run out, or {@link MAX_GATED_PAGES} pages are read. Scope, type and
 * time are in the query; confidence and the trust policy live in a row's metadata, so a page's rows can fail them, and
 * the rows after them stand in. `ineligible` counts every row the gate dropped. A first page that fails is the leg's
 * failure; a later one ends the read with what the pages before it found.
 *
 * @param page - Reads `size` ids from `offset` in the leg's order.
 */
export async function readGatedPages(
  store: MemoryStore,
  q: LegQuery,
  page: (offset: number, size: number) => Promise<string[]>,
): Promise<{ traces: MemoryTrace[]; ineligible: number } | 'query_error'> {
  const traces: MemoryTrace[] = [];
  const seen = new Set<string>();
  let ineligible = 0;
  let offset = 0;
  for (let read = 0; read < MAX_GATED_PAGES && traces.length < q.limit; read += 1) {
    let ids: string[];
    try {
      ids = await page(offset, q.limit);
    } catch (error) {
      if (read === 0) throw error;
      break;
    }
    offset += ids.length;
    const fresh = ids.filter((id) => !seen.has(id));
    for (const id of fresh) seen.add(id);
    const gated = await eligibleTracesOf(store, fresh, q);
    if (gated === 'query_error') {
      if (read === 0) return 'query_error';
      break;
    }
    traces.push(...gated.traces);
    ineligible += gated.ineligible;
    if (ids.length < q.limit) break;
  }
  return { traces: traces.slice(0, q.limit), ineligible };
}

/**
 * The exact-words leg: the traces of the turn's scopes whose content or tags hold the turn's words, best match first.
 * A store with a Brain reads the Brain's full-text index through the adapter's engine-neutral query, with the scopes,
 * types and time written into the query; the rest of the eligibility gate (confidence, trust policy) runs on each
 * page of rows, and the rows after a page stand in for the ones it drops ({@link readGatedPages}). A store without
 * one reads the in-process index and runs the whole gate on every match before the limit. Never throws: an absent or
 * failing index answers `ran: false` with the reason.
 *
 * @param deps - The store, and the in-process index for a store with no Brain.
 * @param q - The turn's text, scopes and filters, and the leg's limit.
 */
export async function exactWordsLeg(deps: { store: MemoryStore; lexical: ScopedLexicalIndex | null }, q: LegQuery): Promise<LegResult> {
  const started = performance.now();
  const answer = (over: Partial<LegResult>): LegResult => ({
    leg: 'exact_words',
    ran: true,
    traces: [],
    ineligible: 0,
    ...over,
    ms: Math.round(performance.now() - started),
  });
  if (q.scopes.length === 0 || q.limit <= 0) return answer({});
  try {
    const brain = deps.store.getBrain();
    if (brain) {
      const index = await probeIndex(brain);
      if (index !== 'ok') return answer({ ran: false, reason: index });
      const words = buildNaturalLanguageFtsQuery(q.query);
      if (!words) return answer({});
      const { fts } = brain.features;
      const order = fts.relevanceOrder('memory_traces_fts', '?');
      const filter = scopeAndFilterSql(q);
      // Equal relevance by id, so each page continues the one before it.
      const gated = await readGatedPages(deps.store, q, async (offset, size) =>
        (
          await brain.all<{ id: string }>(
            `SELECT mt.id FROM ${fts.joinClause('memory_traces', 'mt', 'memory_traces_fts', 'memory_traces_fts')}
              WHERE ${fts.matchClause('memory_traces_fts', '?')} AND mt.deleted = 0 AND mt.brain_id = ? AND ${filter.sql}
              ORDER BY ${order}, mt.id ASC LIMIT ? OFFSET ?`,
            [words, brain.brainId, ...filter.params, ...bindingsFor(order, words), size, offset],
          )
        ).map((row) => row.id),
      );
      return gated === 'query_error' ? answer({ ran: false, reason: 'query_error' }) : answer(gated);
    }
    if (deps.lexical) {
      // In process every match is at hand: the gate runs on all of them before the limit, as the in-process recency
      // leg's does, so a better match the gate drops takes no slot.
      const matches = deps.lexical.search(q.query, q.scopes, Number.POSITIVE_INFINITY).map((hit) => hit.id);
      const gated = await eligibleTracesOf(deps.store, matches, q);
      if (gated === 'query_error') return answer({ ran: false, reason: 'query_error' });
      return answer({ traces: gated.traces.slice(0, q.limit), ineligible: gated.ineligible });
    }
    return answer({ ran: false, reason: 'no_store' });
  } catch {
    return answer({ ran: false, reason: 'query_error' });
  }
}
