---
description: "Reranking retrieved passages in AgentOS: RerankerService, the reranker provider interface, the local Transformers.js cross-encoder, Cohere's rerank API, the two-phase LLM judge, and where the retrievers take a reranker."
---

# Reranking

A reranker scores each retrieved passage against the query again, reading the two together, and reorders the passages a first search found. `RerankerService` holds the rerankers and calls the one a request names.

```typescript
import { lexicalTokens } from '@framers/agentos/cognition/library';
import { RerankerService, type IRerankerProvider } from '@framers/agentos/cognition/rag/reranking';

// A provider of your own: a passage scores the share of the query's words it holds.
const wordOverlap: IRerankerProvider = {
  providerId: 'word-overlap',
  isAvailable: async () => true,
  rerank: async ({ query, documents }) => {
    const wanted = new Set(lexicalTokens(query));
    const results = documents
      .map((doc) => {
        const words = new Set(lexicalTokens(doc.content));
        const shared = [...wanted].filter((word) => words.has(word)).length;
        return { ...doc, relevanceScore: wanted.size > 0 ? shared / wanted.size : 0 };
      })
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
    return { results };
  },
};

const service = new RerankerService({ config: { providers: [], defaultProviderId: 'word-overlap' } });
service.registerProvider(wordOverlap);

const { results } = await service.rerank(
  {
    query: 'refund days',
    documents: [
      { id: 'ship', content: 'Orders ship within two days of payment.' },
      { id: 'refund', content: 'A refund takes five to ten business days.' },
    ],
  },
  { topN: 1 },
);
// [{ id: 'refund', content: 'A refund takes five to ten business days.', relevanceScore: 1 }]
```

The module is `@framers/agentos/cognition/rag/reranking`; the package root does not export it.

## Providers

A provider implements [`IRerankerProvider`](../../src/cognition/rag/reranking/IRerankerService.ts): a `providerId`, `isAvailable()`, and `rerank({ query, documents }, config)`, which answers `{ results }`, each result a document with its `relevanceScore`, best first. Three ship with the package:

| Id | Class | Needs | Defaults |
|---|---|---|---|
| `local` | [`LocalCrossEncoderReranker`](../../src/cognition/rag/reranking/providers/LocalCrossEncoderReranker.ts) `({ providerId: 'local', defaultModelId, batchSize, maxSequenceLength, cacheDir, device })` | Transformers.js: `@huggingface/transformers`, an optional dependency of the package, or `@xenova/transformers`. It loads the model on its first call. | Model `cross-encoder/ms-marco-MiniLM-L-6-v2`, batches of 32, sequences of 512 tokens; `LOCAL_RERANKER_MODELS` lists five model ids |
| `cohere` | [`CohereReranker`](../../src/cognition/rag/reranking/providers/CohereReranker.ts) `({ providerId: 'cohere', apiKey, baseUrl, defaultModelId, defaultTimeoutMs })` | A Cohere API key; without one `isAvailable()` answers false and `rerank()` throws. | Model `rerank-v3.5`, requests to `https://api.cohere.ai/v1/rerank`, 30 seconds before a request is abandoned (a `timeoutMs` in the request, which `RerankerService` always sets, comes first); `COHERE_RERANKER_MODELS` lists seven model ids |
| `llm-judge` | [`LlmJudgeReranker`](../../src/cognition/rag/reranking/providers/LlmJudgeReranker.ts) `({ llmCallFn, scoringModel, rankingModel, maxPointwiseDocuments, pointwiseTopK, batchSize, timeoutMs })` | Your `llmCallFn(system, user, model?)`, which answers the model's text | Scores up to 100 passages from 0 to 10 in batches of 10 with `scoringModel`, reading each passage's first 200 characters, then has `rankingModel` order the best 20; see [The LLM judge](#the-llm-judge) |

### The LLM judge

`LlmJudgeReranker.rerank(input, config)` scores the first `maxPointwiseDocuments` passages, has the ranking call order the `pointwiseTopK` best of them, and answers every passage it scored: the ones the ranking names, in its order, each once (an id the ranking repeats counts once, and an id it was not given is passed over), then the rest by score, a tie in the order the passages came. A request's `topN` cuts the answer to that many, past `pointwiseTopK` too; without one, the answer holds every scored passage, and the passages past `maxPointwiseDocuments` are left out. An answer's `relevanceScore` is `1 - i / n` for its place `i`, from 0, among the `n` it answers.

Each call of `llmCallFn` waits up to the request's `timeoutMs`, else the judge's own, 30 seconds unless given; `RerankerService.rerank()` always sets the request's. A scoring call that fails, runs past it or answers no JSON array scores its batch 0, and a score that is not a number counts 0. A ranking call that fails, runs past it or answers something other than a JSON array leaves the order to the scores.

## RerankerService

| Member | What it does |
|---|---|
| `new RerankerService({ config, logger })` | `config` holds `providers`, a settings entry per provider id, `defaultProviderId` and `defaultModelId`. The service reads each entry's `defaultModelId` and `defaultTimeoutMs` and creates no provider from it: register each one. |
| `registerProvider(provider)`, `getProvider(id)`, `getProviderConfig(id)`, `listProviders()`, `isProviderAvailable(id)` | The providers the service holds, and the settings entry of each. |
| `rerank(input, { providerId, modelId, topN, maxDocuments, timeoutMs, params })` | Sends the first `maxDocuments` documents (100 unless given) to the provider named, else the default one, and keeps the best `topN`. The model is the one given, else the provider's `defaultModelId` in the config, else the service's; the timeout is the one given, else the provider's `defaultTimeoutMs`, else 30 seconds. It throws when no provider is named and none is the default, or when the provider is not registered, and passes on a provider's error. |
| `rerankChunks(query, chunks, config)` | `rerank()` over retrieved chunks (`RagRetrievedChunk`): each chunk comes back with the new `relevanceScore`, and its metadata records the provider (`_rerankerProviderId`) and the old score (`_rerankerOriginalScore`) when the provider hands it back, as the three built-in providers do. A result whose id is not among the chunks throws. |
| `rerankChain(query, chunks, stages)` | Runs providers one after another, each keeping its `topK`. A stage asks for its `model`, else, as `rerank()` does, the provider's `defaultModelId` in the config, else the service's, else the provider's own default. A stage whose provider is not registered or not available is skipped, a stage that throws leaves the order it was given, and each chunk's metadata lists the stages that ran (`_rerankerChainStages`); see [Reranking and the Reranker Chain](../memory/RAG_MEMORY_CONFIGURATION.md#reranker-chain). |

## Where a reranker plugs in

- `RetrievalAugmentor` builds a `RerankerService` from `rerankerServiceConfig`, registers the `cohere` provider (when its entry has an `apiKey`) and the `local` one that config names, and reranks a request that sets `rerankerConfig.enabled`, or one with no `rerankerConfig` whose retrieval `policy` sets `reranker: 'always'` ([RAG Memory Configuration](../memory/RAG_MEMORY_CONFIGURATION.md#reranker-chain)).
- `CognitiveMemoryManager` takes a `rerankerService` and blends 0.7 of each trace's cognitive score with 0.3 of the rerank score ([Memory retrieval reranking](../memory/RAG_MEMORY_CONFIGURATION.md#memory-retrieval-reranking)).
- `HybridRetriever` takes a `rerankerService` and reranks the fused pool before it truncates ([Hybrid BM25 + Dense Retriever](../architecture/hybrid-retriever.md)).
- `WebSearchService` takes `reranker` and `rerankChain` and runs the chain over its fused results, unless a search passes `rerank: false`; a reranking error leaves the fused order.

## Where it runs

None of the reranking modules imports a Node module. `CohereReranker` sends its requests with the global `fetch`. `LocalCrossEncoderReranker` imports Transformers.js on its first call and throws when neither package can be loaded. `LlmJudgeReranker` calls only the function you give it.

## Examples

[`examples/query-router-host-hooks.mjs`](../../examples/query-router-host-hooks.mjs) passes a host's own rerank hook to the `QueryRouter`.
