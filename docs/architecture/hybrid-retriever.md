# Hybrid BM25 + Dense Retriever

## What this is

[`HybridRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/hybrid/HybridRetriever.ts) fuses dense and sparse retrieval over memory traces. The dense side is `MemoryStore.query`, which keeps the store's cognitive scoring. The sparse side is a [`BM25Index`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/search/BM25Index.ts) the retriever owns. Reciprocal Rank Fusion merges the two ranked lists, and an optional reranker rescores the merged pool before truncation.

Exact-term matches (names, dates, specific numbers) that an embedding ranks low are surfaced by BM25, then reranked with the semantic candidates.

```ts
import { HybridRetriever } from '@framers/agentos/memory';

const hybrid = new HybridRetriever({ memoryStore, rerankerService });

// The caller indexes each trace's text in the BM25 index as it stores the trace:
hybrid.bm25.addDocument(trace.id, trace.content);

const result = await hybrid.retrieve(
  'What did the user say about their mortgage?',
  { valence: 0, arousal: 0, dominance: 0 },  // current mood
  { scope: 'user', scopeId: 'u1' },
  { recallTopK: 10 },
);
```

The BM25 index starts empty and is not filled from the store: traces the caller does not add are found by the dense side only.

## Relation to [`HybridSearcher`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/search/HybridSearcher.ts) in `rag/search/`

[`HybridSearcher`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/search/HybridSearcher.ts) is a document-RAG hybrid retriever: it takes a vector store, a BM25 index and an embedding manager and returns document hits. It knows nothing about memory traces, cognitive scoring or decay.

`HybridRetriever` is the memory-domain sibling: it delegates dense search to `MemoryStore.query`, owns its BM25 index, and returns [`ScoredMemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts) results in a [`CognitiveRetrievalResult`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts). It is not built on `HybridSearcher`.

[`SessionRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/session/SessionRetriever.ts), [`HydeRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/HydeRetriever.ts) and [`ProspectiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/prospective/ProspectiveMemoryManager.ts) are the other opt-in query-time strategies; `CognitiveMemoryManager` uses none of them on its own.

## Steps of `retrieve()`

1. **HyDE (optional).** With `hydeRetriever`, a hypothetical answer replaces the query for the dense and sparse searches; the reranker keeps the original query. A generation failure falls back to the original query.
2. **Dense.** `MemoryStore.query` with `topK = recallTopK × overFetchMultiplier` (30 at the defaults of 10 and 3), scoped to the call's scope.
3. **Sparse.** `bm25.search` with the same `topK`. When it returns nothing, the retriever returns the dense results alone and adds `hybrid-retriever:sparse-empty` to `diagnostics.escalations`.
4. **Merge.** [`reciprocalRankFusion`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/hybrid/reciprocalRankFusion.ts) with weights 0.7 dense and 0.3 sparse and `k` = 60 (`defaultDenseWeight`, `defaultSparseWeight`, `defaultRrfK`, and per call `denseWeight`, `sparseWeight`, `rrfK`). Fusion uses ranks, so the two score scales need not match.
5. **Hydrate.** Each merged id is resolved to its dense-side trace. A trace that only BM25 found is dropped.
6. **Fact graph (optional).** With `factStore`, the facts that match `(subject, predicate)` pairs in the query are added at the top of the pool as synthetic traces with `retrievalScore` 1.0: the latest fact per pair, or every fact for the subject when the query is temporal. `factGraphQueryClassifier` replaces the keyword classifier that extracts the pairs.
7. **Rerank (optional).** With `rerankerService`, each trace's score becomes `0.7 × retrievalScore + 0.3 × rerank score`, and the pool is re-sorted. With `splitAmbiguousThreshold` in (0, 1], each trace in that lowest-scoring fraction is split in two at the sentence boundary nearest its middle, the halves are reranked, and the trace's content becomes its better half when that half scores higher than the whole trace did. A reranker error keeps the merged order.
8. **Truncate** to `recallTopK` (default 10).

`diagnostics.stageIds` lists the trace ids at each step (`dense`, `sparse`, `merged`, `reranked`, `final`).

## When to use

- A mix of semantic queries and exact-term queries (names, dates, specific values).
- Corpora where the embedding ranks rare or out-of-vocabulary tokens poorly.

## When not to use

- Very small corpora, where BM25's document-frequency statistics carry little signal.
- No embedder at all: use [`BM25Index`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/search/BM25Index.ts) or `HybridSearcher` directly.

## Cost

- One dense search and one in-memory BM25 search per query, plus one HyDE generation call when `hydeRetriever` is set.
- One reranker call over the merged pool when `rerankerService` is set, and a second over the split halves when `splitAmbiguousThreshold` is set.

## References

- Cormack, Clarke and Büttcher (2009): *Reciprocal rank fusion outperforms Condorcet and individual rank learning methods*.
- Robertson and Zaragoza (2009): *The Probabilistic Relevance Framework: BM25 and Beyond*.

## Related modules

- [`src/cognition/memory/retrieval/hybrid/HybridRetriever.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/hybrid/HybridRetriever.ts)
- [`src/cognition/memory/retrieval/hybrid/reciprocalRankFusion.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/hybrid/reciprocalRankFusion.ts)
- [`src/cognition/rag/search/BM25Index.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/search/BM25Index.ts)
- [`src/cognition/memory/retrieval/store/MemoryStore.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/MemoryStore.ts): the dense source
- [`src/cognition/rag/reranking/RerankerService.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/reranking/RerankerService.ts): the optional reranker
