> **Live run**: see the QueryRouter initialize a 1,720-chunk corpus across 50 topics and 333 sources on the [agentos.sh demo gallery](https://agentos.sh/#live-demo). Source: [`examples/query-router.mjs`](https://github.com/framerslab/agentos/blob/master/examples/query-router.mjs).

[`QueryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/QueryRouter.ts) is the one-call grounded Q&A pipeline. Point it at your markdown directories, ask a question, get back a fully-attributed answer:

```ts
import { QueryRouter } from '@framers/agentos';

const router = new QueryRouter({
  knowledgeCorpus: ['./docs'],
  verifyCitations: true,
});
await router.init();

const result = await router.route('how do I configure a guardrail?');
//   result.answer          → grounded answer text
//   result.sources         → citations with title, URI, snippet
//   result.classification  → { tier, strategy, confidence, reasoning }
//   result.tiersUsed       → which tiers actually fired
//   result.fallbacksUsed   → e.g. ['keyword-fallback']
//   result.grounding       → per-claim verdicts when verifyCitations is on
```

## When To Use It

Reach for [`QueryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/QueryRouter.ts) when you're building any of these on top of a documentation corpus or knowledge base:

- An in-product help / "ask the docs" feature
- A support copilot that answers from internal runbooks
- An agent tool that needs to ground responses in a specific corpus before answering
- A test harness that needs reproducible classify-retrieve-answer triples for evals

It replaces the boilerplate of chunker + vector store + tier classifier + retriever + LLM call + citation collector with a single object whose `route()` returns a result you can hand straight to a UI. The result is intentionally provenance-oriented — the answer always comes with the sources it was drawn from, the tier path it took, and any fallback strategies that activated.

## How It Works

Each call to `route()` runs three stages in sequence:

1. **Classify** the query into one of four tiers (T0 trivial → T3 deep research) using an LLM prompt that sees the corpus topics, recent conversation history, and any registered tool names.
2. **Retrieve** the right amount of context for that tier — vector search for T1, HyDE for T2, multi-source decomposition for T3, nothing at all for T0.
3. **Generate** a grounded answer from the retrieved context, attaching `SourceCitation[]` entries that point back at the chunks the answer was drawn from.

If no embedding provider is configured, the router degrades cleanly to keyword search instead of failing. 260 platform-knowledge entries (tools, skills, FAQ, API, troubleshooting) ship with `@framers/agentos` and are merged into your corpus automatically — no extra configuration.

## What Is Live Today

- Tier classification uses an LLM prompt with corpus topics, recent conversation history, and optional tool names.
- The router embeds local markdown docs into an in-memory vector store when an embedding provider is available.
- If embeddings are unavailable or vector search fails, the router falls back to keyword search automatically.
- `cacheResults` backs an in-memory `route()` result cache and is enabled by default.
- `verifyCitations: true` runs post-generation citation verification when retrieved chunks and embeddings are available; the verdicts land on `result.grounding`.
- Result metadata includes `tiersUsed` and `fallbacksUsed`.
- Lifecycle events cover classification, retrieval, research, generation, and route completion.

## Execution Paths

- Default path: `route()` classifies the query, then dispatches retrieval through the legacy [`QueryDispatcher`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/QueryDispatcher.ts).
- Opt-in path: if a host calls `setUnifiedRetriever(...)`, `route()` switches to plan-aware retrieval through [`UnifiedRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/unified/UnifiedRetriever.ts).

This matters because [`UnifiedRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/unified/UnifiedRetriever.ts) is implemented and usable today, but it is not the default QueryRouter/runtime retrieval path yet.

## Current Limitations

The QueryRouter scaffold is ahead of the wired runtime in a few places:

- `graphExpand()` is now a built-in corpus-neighborhood heuristic, not yet a true GraphRAG engine.
- `rerank()` is now a built-in lexical heuristic reranker, not yet a cross-encoder service.
- `deepResearch()` is now a built-in local-corpus heuristic synthesis pass, not yet a web-backed research runtime.
- The router is useful today for query classification, vector retrieval, keyword fallback, heuristic graph expansion, heuristic reranking, heuristic local research synthesis, and grounded answer generation, but it is not yet a full GraphRAG or web-research runtime.

## Host-Injected Runtime Hooks

You can replace the built-in heuristic branches without forking [`QueryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/QueryRouter.ts)
by passing host-provided callbacks in the constructor:

- `graphExpand(seedChunks)` for GraphRAG or relationship expansion
- `rerank(query, chunks, topN)` for provider-backed reranking
- `deepResearch(query, sources)` for real multi-source research

When these hooks are supplied, `router.getCorpusStats()` will report the
corresponding runtime mode as `active` instead of the built-in `heuristic`
mode.

## Example

Runnable source: [`packages/agentos/examples/query-router.mjs`](https://github.com/framerslab/agentos/blob/master/examples/query-router.mjs)

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

Runnable source: [`packages/agentos/examples/query-router-host-hooks.mjs`](https://github.com/framerslab/agentos/blob/master/examples/query-router-host-hooks.mjs)

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

## Bundled Platform Knowledge

The QueryRouter ships with **260 pre-built knowledge entries** that cover the entire AgentOS platform surface. These entries are auto-loaded at startup and merged into the corpus alongside your project docs — no configuration required.

### What's Included

| Category | Count | Examples |
|----------|-------|---------|
| **Tools** | 110 | All channel adapters, productivity tools, orchestration tools |
| **Skills** | 82 | Every curated skill from the skills registry |
| **FAQ** | 38 | "How do I add voice?", "What models are supported?", "Does AgentOS support streaming?" |
| **API** | 15 | generateText(), streamText(), agent(), agency(), embedText(), generateImage() |
| **Troubleshooting** | 15 | Missing API keys, model not found, embedding init failures |

### How It Works

Platform knowledge is loaded from `knowledge/platform-corpus.json` inside the `@framers/agentos` package. During `init()`, these entries are converted to [`CorpusChunk`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/types.ts) objects and appended to the user corpus. Both the vector index and the keyword fallback index cover platform entries, so they work regardless of whether an embedding API key is available.

The platform knowledge layer sits beneath your project documentation:

```
User project docs     (your ./docs, ./guides, etc.)
  + Platform knowledge  (bundled tools, skills, FAQ, API, troubleshooting)
  + GitHub repos        (optional — indexed asynchronously after init)
  = Complete corpus
```

This means an agent can answer questions like "What vector stores does AgentOS support?" or "How do I set up a Bluesky channel?" without any project-specific documentation — the answer comes from the bundled platform knowledge.

### Agentic Credential Discovery

A key application of platform knowledge is **agentic credential setup**. The corpus includes dedicated FAQ entries for:

- **Gmail setup** (`faq:setup-gmail`): Step-by-step instructions for creating a Google Cloud project, enabling the Gmail API, downloading the `client_secret_*.json` file, and running the OAuth flow.
- **General credential setup** (`faq:setup-credentials-general`): The universal pattern for helping users configure any extension — discover what's needed via `discover_capabilities`, find files via `shell_execute`, parse them via `file_read`, and persist credentials.
- **Extension credentials reference** (`faq:extension-credentials`): Complete listing of what environment variables each extension requires (GITHUB_TOKEN, DISCORD_BOT_TOKEN, ELEVENLABS_API_KEY, etc.).
- **File discovery** (`faq:find-credential-files`): How to locate downloaded credential files on the user's system (checking ~/Downloads, ~/Desktop, ~/.aws, ~/.ssh).
- **Connect reference** (`faq:connect-flow`): Reference for the OAuth-based connect flow with all supported services and the `--credentials` flag.

When a user asks "help me set up Gmail" or "I downloaded a credentials file", the NL intent classifier routes to the connect flow, and the agent uses these knowledge entries combined with agentic tools (`shell_execute`, `file_read`) to guide the user through credential setup without any hard-coded logic in the CLI itself.

### Configuration

Platform knowledge is enabled by default. To disable it:

```typescript
const router = new QueryRouter({
  knowledgeCorpus: ['./docs'],
  includePlatformKnowledge: false,
});
```

### Regenerating Platform Knowledge

If you are contributing to AgentOS and need to update the bundled knowledge:

```bash
npm run build:knowledge
```

This regenerates `knowledge/platform-corpus.json` from the current tool manifests, skill registry, FAQ sources, and API documentation.

## Config Notes

- `knowledgeCorpus` is required.
- `init()` throws if `knowledgeCorpus` resolves to zero readable `.md` / `.mdx` sections.
- `availableTools` is optional and is only used to help the classifier reason about what the runtime can do.
- `apiKey` / `baseUrl` configure classifier and generator LLM calls. When omitted, QueryRouter prefers `OPENAI_API_KEY` and falls back to `OPENROUTER_API_KEY` with the OpenRouter compatibility base URL.
- `embeddingApiKey` / `embeddingBaseUrl` override only the embedding path when vector retrieval should use a different provider or credential. When omitted, embeddings fall back through `apiKey`, then `OPENAI_API_KEY`, then `OPENROUTER_API_KEY`.
- `githubRepos` optionally enables non-blocking GitHub corpus indexing after `init()`. Newly indexed repo chunks are merged back into the live corpus, keyword fallback, classifier topics, and the vector index when embeddings are active.
- `deepResearchEnabled` controls whether the tier-3 research branch is attempted; the default core implementation is a local-corpus heuristic, and hosts can still inject a real web-backed implementation.
- `onClassification` and `onRetrieval` are hooks for consumers that want lightweight runtime integration without reading the full event stream.
- `cacheResults` controls an in-memory cache of completed `route()` results. QueryRouter clears that cache when indexed corpus chunks change and when retrieval-planning dependencies such as [`UnifiedRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/unified/UnifiedRetriever.ts) or the capability-discovery engine are swapped.
- `verifyCitations` enables post-generation [`CitationVerifier`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/citation/CitationVerifier.ts) runs against the retrieved chunks for a route. When verification runs successfully, the result is attached to `QueryResult.grounding`; if embeddings are unavailable or no chunks were retrieved, verification is skipped gracefully.
- `router.getCorpusStats()` returns a [`QueryRouterCorpusStats`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/types.ts) snapshot with configured path count, loaded chunk/topic/source counts, live bundled platform-knowledge category counts, whether retrieval is running in `vector+keyword-fallback` or `keyword-only` mode, the embedding health field `embeddingStatus`, and the runtime-truth fields `graphRuntimeMode`, `rerankRuntimeMode`, and `deepResearchRuntimeMode`.
- `embeddingStatus: 'active'` means the vector index initialized successfully, `'disabled-no-key'` means init stayed keyword-only because no embedding credential was available, and `'failed-init'` means embedding bootstrap was attempted but failed and the router fell back to keyword-only mode.
- `graphRuntimeMode: 'heuristic'` means the built-in same-document / heading-overlap expansion is active; `'active'` is reserved for a future wired graph expansion service or a host-injected hook.
- `rerankRuntimeMode: 'heuristic'` means the built-in lexical reranker is active; `'active'` is reserved for a future wired reranker service.
- `deepResearchRuntimeMode: 'heuristic'` means the built-in local-corpus synthesis pass is active; `'active'` is reserved for a host-injected or future provider-backed research runtime.

## Result Metadata

[`QueryResult`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/types.ts) includes:

- `classification`: the final classification result
- `sources`: citations built from retrieved chunks
- `grounding`: optional [`VerifiedResponse`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/citation/types.ts) from post-generation citation verification
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
