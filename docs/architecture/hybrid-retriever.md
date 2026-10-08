# Hybrid BM25 + Dense Retriever

## What this is

[`HybridRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/hybrid/HybridRetriever.ts) fuses dense and sparse retrieval signals over memory traces. Dense side uses `MemoryStore.query` (preserving the 6-signal cognitive scoring). Sparse side uses a per-instance [`BM25Index`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/search/BM25Index.ts). Reciprocal Rank Fusion merges the two ranked lists. Optional neural rerank (Cohere `rerank-v3.5`) runs over the merged pool before truncation.

The effect: exact-term matches (names, dates, specific numbers) that pure semantic embedding misses are re-surfaced by BM25, then re-ranked by the cross-encoder for final quality.

## Mental model

Parallel to [`SessionRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/session/SessionRetriever.ts) (Step 2), [`HydeRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/HydeRetriever.ts), and [`ProspectiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/prospective/ProspectiveMemoryManager.ts). All four are query-time retrieval strategies under `memory/retrieval/`. All are opt-in; callers wire them up when their use case benefits.

## Relation to [`HybridSearcher`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/search/HybridSearcher.ts) in `rag/search/`

[`HybridSearcher`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/search/HybridSearcher.ts) is a generic document-RAG hybrid retriever: it takes a vector store + a BM25 index + an embedding manager and returns document hits. It knows nothing about memory traces, cognitive scoring, or decay.

[`HybridRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/hybrid/HybridRetriever.ts) is a memory-domain retriever: it delegates dense search to `MemoryStore.query` (inheriting cognitive scoring), owns a per-instance [`BM25Index`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/search/BM25Index.ts) for sparse, and returns [`ScoredMemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts) in a [`CognitiveRetrievalResult`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts) shape. It is NOT built on top of [`HybridSearcher`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/search/HybridSearcher.ts). They are siblings at different abstraction levels.

## Two stages

1. **Dense** (`MemoryStore.query` with over-fetched topK): returns cognitive-scored traces.
2. **Sparse** (`this.bm25.search`): returns BM25-scored trace ids.
3. **RRF merge** via [`reciprocalRankFusion`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/hybrid/reciprocalRankFusion.ts) helper. Rank-based, so metric-space mismatch between cognitive composite and BM25 scores is irrelevant.
4. **Hydrate**: sparse-only docs skipped in MVP (documented limitation; drop rate expected to be low at the default over-fetch=3).
5. **Rerank** (optional, mandatory-wired from the bench per Step 2 post-mortem): Cohere rerank over merged pool, 0.7 cognitive + 0.3 neural blend matching baseline semantics.
6. **Truncate** to `recallTopK`.

## When to use

- Deployments with a mix of semantic queries and exact-term queries (names, dates, specific values).
- LoCoMo adversarial / LongMemEval knowledge-update where specific-value extraction is the dominant failure mode.
- Any scenario where the dense embedding struggles with out-of-vocabulary or rare tokens.

## When NOT to use

- Very short corpora (< 50 traces) where BM25's IDF estimates are unreliable.
- Scenarios without an embedder (BM25 alone: use [`BM25Index`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/search/BM25Index.ts) or the generic `HybridSearcher`).
- Configurations where every trace has near-identical content (BM25 can't discriminate; rerank would do all the work).

## Performance characteristics

- **Dense cost**: one vector search at `topK = recallTopK * overFetchMultiplier` (default 30 at K=10).
- **Sparse cost**: O(query tokens * matched docs), in-memory BM25, typically sub-millisecond at 100s of docs.
- **RRF**: O(dense + sparse) pure CPU merge.
- **Rerank**: one Cohere `rerank-v3.5` call over the merged pool (typically 15-20 docs). ~$0.0001 per query.
- **Total added latency vs dense-only**: < 50ms typical.

## Mutex with [`SessionRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/session/SessionRetriever.ts)

In Step 3 MVP, [`HybridRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/hybrid/HybridRetriever.ts) and [`SessionRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/session/SessionRetriever.ts) are mutually exclusive at the bench boundary. Passing both flags throws a documented error inside `runFullCognitiveCase`. A combined path (Hybrid-over-selected-sessions) is a hypothetical Step 7 concept; not implemented.

## References

- Cormack, Clarke, Büttcher (2009): *Reciprocal rank fusion outperforms Condorcet and individual rank learning methods*.
- Anthropic Sep 2024: Contextual Retrieval. Contextual BM25 + embeddings cut retrieval failure by 49%, 67% with reranking.
- Robertson & Zaragoza (2009): *The Probabilistic Relevance Framework: BM25 and Beyond*.

## Related modules

- [`src/cognition/memory/retrieval/hybrid/HybridRetriever.ts`](../../src/cognition/memory/retrieval/hybrid/HybridRetriever.ts)
- [`src/cognition/memory/retrieval/hybrid/reciprocalRankFusion.ts`](../../src/cognition/memory/retrieval/hybrid/reciprocalRankFusion.ts)
- [`src/cognition/rag/search/BM25Index.ts`](../../src/cognition/rag/search/BM25Index.ts) — reused verbatim
- [`src/cognition/memory/retrieval/store/MemoryStore.ts`](../../src/cognition/memory/retrieval/store/MemoryStore.ts) — dense source
- [`src/cognition/rag/reranking/RerankerService.ts`](../../src/cognition/rag/reranking/RerankerService.ts) — optional reranker
