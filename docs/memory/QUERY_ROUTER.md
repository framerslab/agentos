# Query Router

AgentOS includes a `QueryRouter` that turns one user question into a three-stage pipeline:

1. classify the query into tier `0` through `3`
2. retrieve the right amount of context
3. generate a grounded answer from that context

## What Is Live Today

- Tier classification uses an LLM prompt with corpus topics, recent conversation history, and optional tool names.
- The router embeds local markdown docs into an in-memory vector store when an embedding provider is available.
- If embeddings are unavailable or vector search fails, the router falls back to keyword search automatically.
- Result metadata includes `tiersUsed` and `fallbacksUsed`.
- Lifecycle events cover classification, retrieval, research, generation, and route completion.

## Current Limitations

The QueryRouter scaffold is ahead of the wired runtime in a few places:

- `graphExpand()` is now a built-in corpus-neighborhood heuristic, not yet a true GraphRAG engine.
- `rerank()` is now a built-in lexical heuristic reranker, not yet a cross-encoder service.
- `deepResearch()` is now a built-in local-corpus heuristic synthesis pass, not yet a web-backed research runtime.
- The router is useful today for query classification, vector retrieval, keyword fallback, heuristic graph expansion, heuristic reranking, heuristic local research synthesis, and grounded answer generation, but it is not yet a full GraphRAG or web-research runtime.

## Host-Injected Runtime Hooks

You can replace the built-in heuristic branches without forking `QueryRouter`
by passing host-provided callbacks in the constructor:

- `graphExpand(seedChunks)` for GraphRAG or relationship expansion
- `rerank(query, chunks, topN)` for provider-backed reranking
- `deepResearch(query, sources)` for real multi-source research

When these hooks are supplied, `router.getCorpusStats()` will report the
corresponding runtime mode as `active` instead of the built-in `heuristic`
mode.

## Example

Runnable source: [`packages/agentos/examples/query-router.mjs`](https://github.com/framersai/agentos/blob/master/examples/query-router.mjs)

```ts
import { QueryRouter } from '@framers/agentos';

const router = new QueryRouter({
  knowledgeCorpus: ['./docs', './packages/agentos/docs'],
  availableTools: ['web_search', 'deep_research'],
});

await router.init();

console.log(router.getCorpusStats());

const result = await router.route('How does memory retrieval work?');

console.log(result.answer);
console.log(result.classification.tier);
console.log(result.tiersUsed);
console.log(result.fallbacksUsed);
console.log(result.sources);

await router.close();
```

### Host-Injected Runtime Example

Runnable source: [`packages/agentos/examples/query-router-host-hooks.mjs`](https://github.com/framersai/agentos/blob/master/examples/query-router-host-hooks.mjs)

```ts
const router = new QueryRouter({
  knowledgeCorpus: ['./docs', './packages/agentos/docs'],
  graphEnabled: true,
  deepResearchEnabled: true,
  graphExpand: async (seedChunks) => [...seedChunks, extraGraphChunk],
  rerank: async (_query, chunks, topN) => chunks.slice(0, topN),
  deepResearch: async (query, sources) => ({
    synthesis: `Host-provided research for ${query}`,
    sources: externalResearchChunks,
  }),
});

await router.init();
console.log(router.getCorpusStats()); // graph/deepResearch/rerank runtime modes become active
```

## Config Notes

- `knowledgeCorpus` is required.
- `init()` throws if `knowledgeCorpus` resolves to zero readable `.md` / `.mdx` sections.
- `availableTools` is optional and is only used to help the classifier reason about what the runtime can do.
- `apiKey` / `baseUrl` configure classifier and generator LLM calls. When omitted, QueryRouter prefers `OPENAI_API_KEY` and falls back to `OPENROUTER_API_KEY` with the OpenRouter compatibility base URL.
- `embeddingApiKey` / `embeddingBaseUrl` override only the embedding path when vector retrieval should use a different provider or credential. When omitted, embeddings fall back through `apiKey`, then `OPENAI_API_KEY`, then `OPENROUTER_API_KEY`.
- `githubRepos` optionally enables non-blocking GitHub corpus indexing after `init()`. Newly indexed repo chunks are merged back into the live corpus, keyword fallback, classifier topics, and the vector index when embeddings are active.
- `deepResearchEnabled` controls whether the tier-3 research branch is attempted; the default core implementation is a local-corpus heuristic, and hosts can still inject a real web-backed implementation.
- `onClassification` and `onRetrieval` are hooks for consumers that want lightweight runtime integration without reading the full event stream.
- `router.getCorpusStats()` returns a `QueryRouterCorpusStats` snapshot with configured path count, loaded chunk/topic/source counts, live bundled platform-knowledge category counts, whether retrieval is running in `vector+keyword-fallback` or `keyword-only` mode, the embedding health field `embeddingStatus`, and the runtime-truth fields `graphRuntimeMode`, `rerankRuntimeMode`, and `deepResearchRuntimeMode`.
- `embeddingStatus: 'active'` means the vector index initialized successfully, `'disabled-no-key'` means init stayed keyword-only because no embedding credential was available, and `'failed-init'` means embedding bootstrap was attempted but failed and the router fell back to keyword-only mode.
- `graphRuntimeMode: 'heuristic'` means the built-in same-document / heading-overlap expansion is active; `'active'` is reserved for a future wired graph expansion service or a host-injected hook.
- `rerankRuntimeMode: 'heuristic'` means the built-in lexical reranker is active; `'active'` is reserved for a future wired reranker service.
- `deepResearchRuntimeMode: 'heuristic'` means the built-in local-corpus synthesis pass is active; `'active'` is reserved for a host-injected or future provider-backed research runtime.

## Result Metadata

`QueryResult` includes:

- `classification`: the final classification result
- `sources`: citations built from retrieved chunks
- `recommendations`: optional skill/tool/extension suggestions inferred during plan-aware classification
- `tiersUsed`: the tiers actually exercised after fallbacks
- `fallbacksUsed`: retrieval/classification fallback strategy names such as `keyword-fallback` or `research-skip`
- `durationMs`: total end-to-end wall-clock time for classification, retrieval, and generation

## Events

The router records typed events for:

- `classify:start`
- `classify:complete`
- `classify:error`
- `retrieve:*`
- `research:*`
- `generate:*`
- `route:complete`

These events are intended for observability, audit trails, and future workbench/runtime inspection surfaces.
