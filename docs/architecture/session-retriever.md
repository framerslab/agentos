# Session-Level Hierarchical Retriever

## What this is

[`SessionRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/session/SessionRetriever.ts) implements two-stage hierarchical retrieval at session granularity. It pairs with [`SessionSummarizer`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/ingest/SessionSummarizer.ts) (which generates per-session summaries at ingest time) and [`SessionSummaryStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/session/SessionSummaryStore.ts) (which indexes those summaries in a vector collection of their own per scope, `cogmem_sessions_<scope>_<scopeId>`). At retrieval time, it selects top-K sessions by summary similarity, then takes top-M chunks per selected session from the standard [`MemoryStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/MemoryStore.ts).

Each selected session contributes at most M chunks, so one session cannot fill the result the way it can in a single-stage search, and a question whose evidence spans sessions gets chunks from several of them. The chunks come from one `MemoryStore.query` pool, so a selected session with no chunk in that pool contributes nothing.

## Wiring

All three classes are exported from `@framers/agentos/memory`. The caller builds them next to a `CognitiveMemoryManager` (whose own `retrieve()` does not use them), summarizes each session once, and tags each trace with the session it came from:

```ts
import { SessionRetriever, SessionSummarizer, SessionSummaryStore } from '@framers/agentos/memory';

const summarizer = new SessionSummarizer({ invoker, modelId: 'gpt-5-mini', cacheDir: './.session-summaries' });
const summaryStore = new SessionSummaryStore({ vectorStore, embeddingManager });
const mood = { valence: 0, arousal: 0, dominance: 0 };

// Ingest: one summary per session, and the session id on each of its traces.
const summary = await summarizer.summarize('s-7', sessionText);
await summaryStore.indexSession({ scope: 'user', scopeId: 'u42', sessionId: 's-7', summary });
for (const turn of sessionTurns) {
  await manager.encode(turn, mood, 'neutral', { scope: 'user', scopeId: 'u42', tags: ['bench-session:s-7'] });
}

// Query time:
const retriever = new SessionRetriever({
  summaryStore,
  memoryStore: manager.getStore(),
  embeddingManager,
  rerankerService: manager.getRerankerService() ?? undefined,
});
const result = await retriever.retrieve(
  'What did the user say about their rescue dog?',
  mood,
  { scope: 'user', scopeId: 'u42' },
  { recallTopK: 10 },
);
```

`invoker` is a function `(system, user) => Promise<{ text, tokensIn, tokensOut, model }>` that calls your summarization model. The summarizer returns the summary only; storing it, and prepending it to the session's chunks before embedding if you want contextual embeddings, is up to the caller.

## Two-stage flow

1. **Stage 1**: `summaryStore.querySessions(query, topK=K)` embeds the query and selects the top-K sessions by the vector store's similarity between the query embedding and the indexed session summaries. K is `topSessions`, default 5 (`defaultTopSessions`).
2. **Stage 2**: a single `memoryStore.query(query, topK=K*M*3)` over-fetches candidates so post-filtering has enough per-session representatives. M is `chunksPerSession`, default 3 (`defaultChunksPerSession`).
3. **Post-filter**: keep only traces whose `bench-session:<id>` tag (configurable via `sessionTagPrefix`) matches a Stage-1 session.
4. **Group by session**, take top-M chunks per session (already sorted by cognitive score).
5. **Optional rerank** over the merged pool via an injected [`RerankerService`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/reranking/RerankerService.ts) (0.7 cognitive + 0.3 neural blend, matching `CognitiveMemoryManager.retrieve`), then a sort by the blended score. Without a reranker the pool is sorted by cognitive score; when the reranker throws, the pool keeps its session-by-session order.
6. **Truncate** to `recallTopK` (default 10).

## Fallbacks

- **Stage 1 empty**: no sessions indexed for the scope (or the summary query failed). Fall through to plain `memoryStore.query` and return its top-`recallTopK`, with no rerank. Diagnostics tag: `escalations: ['session-retriever:stage1-empty']`.
- **Stage 2 post-filter empty**: Stage-2 pool had no chunks tagged for Stage-1 sessions. Return raw Stage-2 top-`recallTopK` without session filtering or rerank. Diagnostics tag: `escalations: ['session-retriever:stage2-empty']`.

## When to use

- Long-term conversational memory where answers span multiple sessions (LongMemEval multi-session, LoCoMo multi-hop).
- Deployments where per-session topical coherence is high and session boundaries are semantically meaningful.
- Configurations with an LLM budget for ingest-time summary generation (one [`SessionSummarizer`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/ingest/SessionSummarizer.ts) call per unique session; with `cacheDir`, a summary already on disk costs nothing).

## When NOT to use

- Single-session question answering where `CognitiveMemoryManager.retrieve` already surfaces the right chunks.
- Deployments without ingest-time summaries in a `SessionSummaryStore`. SessionRetriever would fall through to plain retrieval every call.
- Very short sessions, where a session's summary says little more than its chunks.

## References

- **xMemory**: Hu et al., *Beyond RAG for Agent Memory: Retrieval by Decoupling and Aggregation* ([arXiv 2602.02007](https://arxiv.org/abs/2602.02007v3), 2026). A four-level hierarchy (messages, episodes, semantics, themes) retrieved top-down. In its LoCoMo ablation with Qwen3-8B, the hierarchy alone raises average BLEU from 27.92 to 31.81 and F1 from 36.42 to 40.77 over naive RAG.
- **TaciTree**: Li et al., *Toward Multi-Session Personalized Conversation: A Large-Scale Dataset and Hierarchical Tree Framework for Implicit Reasoning* ([EMNLP 2025](https://aclanthology.org/2025.emnlp-main.580/)). A tree of summaries over multi-session conversation history, searched level by level from abstract summaries down to details.
- **Contextual Retrieval**: Anthropic, *Introducing Contextual Retrieval* ([September 19, 2024](https://www.anthropic.com/news/contextual-retrieval)), which prepends chunk-specific context to each chunk before embedding and BM25 indexing. `SessionSummarizer` writes one summary per session for the same purpose, and `SessionRetriever` uses those summaries at query time.

## Performance characteristics

- **Stage 1 cost**: one query embedding plus one vector search per query, bounded by `topK=K`. When the vector store reports no summary collection for the scope, both are skipped.
- **Stage 2 cost**: one `MemoryStore.query` per query (a second query embedding and a vector search) with `topK = K × M × 3` (over-fetch multiplier): 45 at the defaults.
- **Optional rerank cost**: one reranker call over the merged pool of at most K×M traces (15 at the defaults).
- **Fallback cost**: Stage-1 empty → one plain `MemoryStore.query` with `topK = recallTopK`. Stage-2 empty → the Stage-2 pool already fetched (no extra call).

## Related modules

- [`src/cognition/memory/retrieval/session/SessionSummaryStore.ts`](../../src/cognition/memory/retrieval/session/SessionSummaryStore.ts)
- [`src/cognition/memory/retrieval/session/SessionRetriever.ts`](../../src/cognition/memory/retrieval/session/SessionRetriever.ts)
- [`src/cognition/memory/ingest/SessionSummarizer.ts`](../../src/cognition/memory/ingest/SessionSummarizer.ts): summary generation
- [`src/cognition/memory/retrieval/store/MemoryStore.ts`](../../src/cognition/memory/retrieval/store/MemoryStore.ts): the trace store Stage 2 queries
