/**
 * @fileoverview The words of a text as the exact-words leg reads them, and the in-process exact-words index of a
 * store with no Brain.
 *
 * @module agentos/cognition/memory/retrieval/recall/lexical
 */
import { LexicalIndex } from '../../../rag/search/LexicalIndex.js';
import type { MemoryScope, MemoryTrace } from '../../core/types.js';
import type { MemoryStore } from '../store/MemoryStore.js';
import { FTS_STOP_WORDS } from '../store/tracePersistence.js';

/**
 * A text's words as the exact-words leg reads them: runs of letters, digits and `_`, lower-cased, with stop words and
 * one-letter words dropped unless nothing else is left. The same words the Brain's natural-language full-text query
 * is written from.
 */
export function recallTokens(text: string): string[] {
  const raw = (text.match(/[\p{L}\p{N}_]+/gu) ?? []).map((token) => token.toLowerCase());
  const kept = raw.filter((token) => token.length > 1 && !FTS_STOP_WORDS.has(token));
  return kept.length > 0 ? kept : raw;
}

/**
 * The in-process exact-words index of a store with no Brain: one BM25 index per scope, as the store keeps one vector
 * collection per scope, so a search reads only the scopes asked and the scope applies before the limit. It holds a
 * trace's content and tags, the columns the Brain's index holds, and follows the store through
 * {@link MemoryStore.addTraceListener}. It holds the traces this process stored or loaded: with a vector store that
 * outlives the process and no Brain, exact words find those only. A query word matches the words that begin with it,
 * as the Brain's query puts a prefix star on each word on SQLite; there is no stemming.
 */
export class ScopedLexicalIndex {
  private readonly byScope = new Map<string, LexicalIndex>();
  private readonly scopeOf = new Map<string, string>();
  private readonly unsubscribe: () => void;

  /** Seeds the index with the active traces `store` holds, then follows its writes and deletes. */
  constructor(store: MemoryStore) {
    for (const trace of store.listTraces({ activeOnly: true })) {
      if (!store.isDeleted(trace.id)) this.file(trace);
    }
    this.unsubscribe = store.addTraceListener((event) => {
      if (event.kind === 'filed') this.file(event.trace);
      else this.remove(event.traceId);
    });
  }

  private file(trace: MemoryTrace): void {
    this.remove(trace.id);
    const text = [trace.content, ...(trace.tags ?? [])].join(' ').trim();
    if (!trace.isActive || !trace.scope || !trace.scopeId || !text) return;
    const key = `${trace.scope}:${trace.scopeId}`;
    let index = this.byScope.get(key);
    if (!index) {
      index = new LexicalIndex({ tokenize: recallTokens });
      this.byScope.set(key, index);
    }
    index.addDocument(trace.id, text);
    this.scopeOf.set(trace.id, key);
  }

  private remove(traceId: string): void {
    const key = this.scopeOf.get(traceId);
    if (!key) return;
    this.byScope.get(key)?.removeDocument(traceId);
    this.scopeOf.delete(traceId);
  }

  /**
   * The best `limit` matches among `scopes`, best first, equal scores by id. Each scope's index scores its own
   * documents; the scores of two scopes are compared as they are.
   */
  search(query: string, scopes: ReadonlyArray<{ scope: MemoryScope; scopeId: string }>, limit: number): Array<{ id: string; score: number }> {
    if (limit <= 0) return [];
    const hits: Array<{ id: string; score: number }> = [];
    for (const { scope, scopeId } of scopes) {
      const index = this.byScope.get(`${scope}:${scopeId}`);
      if (!index) continue;
      for (const hit of index.search(query, limit, { prefix: true })) hits.push({ id: hit.id, score: hit.score });
    }
    return hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit);
  }

  /** Stops following the store and drops what the index holds. */
  dispose(): void {
    this.unsubscribe();
    this.byScope.clear();
    this.scopeOf.clear();
  }
}
