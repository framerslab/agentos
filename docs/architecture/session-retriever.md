# Session-Level Hierarchical Retriever

## What this is

[`SessionRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/session/SessionRetriever.ts) implements two-stage hierarchical retrieval at session granularity. It pairs with [`SessionSummarizer`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/ingest/SessionSummarizer.ts) (which generates per-session summaries at ingest time) and [`SessionSummaryStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/session/SessionSummaryStore.ts) (which indexes those summaries in a dedicated vector collection). At retrieval time, it selects top-K sessions by summary similarity, then takes top-M chunks per selected session from the standard [`MemoryStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/MemoryStore.ts).

The effect is a coverage mechanism: by construction, retrieved chunks span multiple distinct sessions. Single-stage retrieval tends to cluster on the single most-relevant session, missing multi-session evidence. This retriever forces diversity without re-ranking hacks.

## Mental model

Parallel to [`HydeRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/HydeRetriever.ts) (hypothesis-driven) and [`ProspectiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/prospective/ProspectiveMemoryManager.ts) (time/event-triggered), [`SessionRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/session/SessionRetriever.ts) is a query-time retrieval strategy under `memory/retrieval/`. All three are opt-in; callers wire them up when their use case benefits.

## Two-stage flow

1. **Stage 1**: `summaryStore.querySessions(query, topK=K)` selects the top-K sessions by cosine similarity between the query embedding and the indexed session summaries.
2. **Stage 2**: a single `memoryStore.query(query, topK=K*M*3)` over-fetches candidates so post-filtering has enough per-session representatives.
3. **Post-filter**: keep only traces whose `bench-session:<id>` tag (configurable via `sessionTagPrefix`) matches a Stage-1 session.
4. **Group by session**, take top-M chunks per session (already sorted by cognitive score).
5. **Optional rerank** over the merged pool via an injected [`RerankerService`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/reranking/RerankerService.ts) (0.7 cognitive + 0.3 neural blend, matching `CognitiveMemoryManager.retrieve`).
6. **Truncate** to `recallTopK` (default 10).

## Fallbacks

- **Stage 1 empty**: no sessions indexed for the scope. Fall through to plain `memoryStore.query` and return its top-`recallTopK`. Diagnostics tag: `escalations: ['session-retriever:stage1-empty']`.
- **Stage 2 post-filter empty**: Stage-2 pool had no chunks tagged for Stage-1 sessions. Return raw Stage-2 top-`recallTopK` without session filtering. Diagnostics tag: `escalations: ['session-retriever:stage2-empty']`.

## When to use

- Long-term conversational memory where answers span multiple sessions (LongMemEval multi-session, LOCOMO multi-hop).
- Deployments where per-session topical coherence is high and session boundaries are semantically meaningful.
- Configurations with an LLM budget for ingest-time summary generation ([`SessionSummarizer`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/ingest/SessionSummarizer.ts) call per unique session).

## When NOT to use

- Single-session question answering where `CognitiveMemoryManager.retrieve` already surfaces the right chunks.
- Deployments without ingest-time summarization (no [`SessionSummarizer`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/ingest/SessionSummarizer.ts)). SessionRetriever would fall through to plain retrieval every call.
- Very short sessions (< 5 turns) where the summary and chunks are essentially the same content.

## References

- **xMemory** ([arxiv 2602.02007v3](https://arxiv.org/abs/2602.02007v3), 2026) — four-level hierarchy (raw → episode → semantic → theme) with two-stage retrieval. Ablation on LoCoMo shows hierarchy alone beats Naive RAG BLEU 27.9→31.8, F1 36.4→40.8 before any retrieval optimization.
- **TACITREE** ([EMNLP 2025](https://aclanthology.org/2025.emnlp-main.580.pdf), UCSD) — hierarchical tree for multi-session personalized conversation. Level-based retrieval progressively refines from abstract summaries to detail.
- **Anthropic contextual retrieval** (Sep 2024) — the pattern `SessionSummarizer` implements at session granularity. [`SessionRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/session/SessionRetriever.ts) is the retrieval-time counterpart.

## Performance characteristics

- **Stage 1 cost**: one query embedding plus one vector search per query, bounded by `topK=K`.
- **Stage 2 cost**: one `MemoryStore.query` per query with `topK = K × M × 3` (over-fetch multiplier). Typical: 45 at the defaults.
- **Optional rerank cost**: one reranker call over the merged K×M pool (15 documents at the defaults).
- **Fallback cost**: Stage-1 empty → plain `MemoryStore.query` (no extra cost). Stage-2 empty → raw Stage-2 pool (no extra cost).

## Related modules

- [`src/cognition/memory/retrieval/session/SessionSummaryStore.ts`](../../src/cognition/memory/retrieval/session/SessionSummaryStore.ts)
- [`src/cognition/memory/retrieval/session/SessionRetriever.ts`](../../src/cognition/memory/retrieval/session/SessionRetriever.ts)
- [`src/cognition/memory/ingest/SessionSummarizer.ts`](../../src/cognition/memory/ingest/SessionSummarizer.ts) — summary generation (companion)
- [`src/cognition/memory/retrieval/store/MemoryStore.ts`](../../src/cognition/memory/retrieval/store/MemoryStore.ts) — underlying trace store used by Stage 2
