---
description: "Reranking retrieved passages in AgentOS: RerankerService and its three built-in providers, a local Transformers.js cross-encoder, Cohere's rerank API and a two-phase LLM judge on any model you call, compared side by side, plus the provider interface and where the retrievers take a reranker."
---

# Reranking

A reranker scores each retrieved passage against the query again, reading the two together, and reorders the passages a first search found. `RerankerService` holds any number of rerankers and calls the one a request names. Three ship with the package, and a host can register its own:

```typescript
import {
  RerankerService,
  LocalCrossEncoderReranker,
  CohereReranker,
  LlmJudgeReranker,
} from '@framers/agentos/cognition/rag/reranking';

// chunks: RagRetrievedChunk[]; myLlmCall: (system, user, model?) => Promise<string>
const service = new RerankerService({
  config: { providers: [{ providerId: 'local' }], defaultProviderId: 'local' },
});

// A cross-encoder run in this process. Scoring sends nothing over the network.
service.registerProvider(new LocalCrossEncoderReranker({ providerId: 'local' }));

// Cohere's rerank API: the query and every passage go to Cohere.
if (process.env.COHERE_API_KEY) {
  service.registerProvider(new CohereReranker({ providerId: 'cohere', apiKey: process.env.COHERE_API_KEY }));
}

// An LLM as the judge, on whatever model your llmCallFn calls.
service.registerProvider(new LlmJudgeReranker({ llmCallFn: myLlmCall }));

const query = 'how many days does a refund take';
const byDefault = await service.rerankChunks(query, chunks, { topN: 5 }); // 'local', the default
const byJudge = await service.rerankChunks(query, chunks, { providerId: 'llm-judge', topN: 5 });
```

The module is `@framers/agentos/cognition/rag/reranking`; the package root does not export it.

## Choosing a provider

| | `local` | `cohere` | `llm-judge` |
|---|---|---|---|
| What it is | [`LocalCrossEncoderReranker`](../../src/cognition/rag/reranking/providers/LocalCrossEncoderReranker.ts): a cross-encoder model run in process through Transformers.js | [`CohereReranker`](../../src/cognition/rag/reranking/providers/CohereReranker.ts): Cohere's hosted cross-encoder rerank models | [`LlmJudgeReranker`](../../src/cognition/rag/reranking/providers/LlmJudgeReranker.ts): a language model scores passages, then orders the best of them |
| What it sends, and where | Nothing while scoring. Transformers.js downloads the model from Hugging Face Hub on its first load and reads its cache after that | One POST to `https://api.cohere.ai/v1/rerank` (or `baseUrl`) per request, with the query and the full text of every passage | Whatever your `llmCallFn` sends: each call's prompt holds the query and the first 200 characters of each passage it judges |
| Cost | No per-call fee: CPU time and memory in your process | Billed by Cohere; each response reports its billed search units (`diagnostics.tokensUsed`) | The tokens of `ceil(min(n, 100) / 10) + 1` model calls for `n` passages at the default sizes, at your model's price |
| Latency class | In process: one model inference per passage, one after another, plus the model's load on the first call | One network round trip | Several model round trips, one after another: the slowest of the three |
| Pick it when | The passages must not leave the machine, the host runs offline, or you want no per-call bill | You want a strong hosted reranker in one call and may send the passages to Cohere | You already pay for a model provider, want the ranking judged by a language model, and can wait for several calls |

A remote provider (`cohere`, or `llm-judge` on a hosted model) receives the query and the candidate texts. The LLM judge keeps them on the machine only when its `llmCallFn` calls a local model and nothing else: `generateText` on a retryable failure falls back to the other providers whose keys are in the environment, unless the call passes `fallbackProviders: []`.

## Providers

A provider implements [`IRerankerProvider`](../../src/cognition/rag/reranking/IRerankerService.ts): a `providerId`, `isAvailable()`, and `rerank({ query, documents }, config)`, which answers `{ results }`, each result a document with its `relevanceScore`, best first.

### `local`: a cross-encoder in process

```typescript
new LocalCrossEncoderReranker({
  providerId: 'local',
  defaultModelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2', // the default
  batchSize: 32,                                          // the default
  maxSequenceLength: 512,                                 // tokens, the default
  cacheDir: '/var/cache/agentos-models',                  // Transformers.js's own cache when unset
  device: 'cpu',                                          // the default
});
```

- Needs Transformers.js: `@huggingface/transformers`, an optional dependency of the package, else `@xenova/transformers`. `isAvailable()` answers whether one of them imports; `rerank()` throws when neither does.
- `LOCAL_RERANKER_MODELS` lists five Hugging Face model ids: `cross-encoder/ms-marco-MiniLM-L-6-v2`, `cross-encoder/ms-marco-MiniLM-L-12-v2`, `BAAI/bge-reranker-base`, `BAAI/bge-reranker-large` and `sentence-transformers/ce-ms-marco-TinyBERT-L-4`.
- The model loads on the first `rerank()` (or `initialize(modelId)`), quantized, as a `text-classification` pipeline, and serves every later request. A request's `modelId` picks the model only on that first load; `initialize(otherModelId)` loads another. `dispose()` unloads it.
- Each passage is scored as `"<query> [SEP] <passage>"`, truncated to `maxSequenceLength`. The score is the `LABEL_1`, `POSITIVE` or `1` label's score, else the first label's. A passage whose scoring throws scores 0 and logs a warning.
- No `device` value selects a GPU: the pipeline is created without a device option, so Transformers.js picks the backend. `'gpu'` sets Transformers.js's ONNX WASM backend to one thread, a process-wide setting every Transformers.js pipeline in the process shares; `'cpu'` and `'auto'` change nothing.
- It reads no `timeoutMs` and no `params`.

### `cohere`: Cohere's rerank API

```typescript
new CohereReranker({
  providerId: 'cohere',
  apiKey: process.env.COHERE_API_KEY!,
  baseUrl: 'https://api.cohere.ai',  // the default
  defaultModelId: 'rerank-v3.5',     // the default
  defaultTimeoutMs: 30_000,          // the default
});
```

- `isAvailable()` answers whether `apiKey` is not empty; `rerank()` without a key throws.
- `COHERE_RERANKER_MODELS` lists seven model ids: `rerank-v4.0-pro`, `rerank-v4.0-fast`, `rerank-v3.5`, `rerank-english-v3.0`, `rerank-multilingual-v3.0`, `rerank-english-v2.0` and `rerank-multilingual-v2.0`.
- The request body is `{ model, query, documents, top_n, return_documents: false }` with the request's `params` merged in; `top_n` is the request's `topN`, else the number of passages. The headers carry `Authorization: Bearer <apiKey>` and `X-Client-Name: agentos`.
- A response that is not 2xx throws `Cohere API error (<status>): <body>`. A request past its timeout is aborted and throws `CohereReranker: Request timed out after <ms>ms`.
- The diagnostics carry the model, the latency, Cohere's billed search units (`tokensUsed`), its request id and its API version.

### `llm-judge`: an LLM as the judge

```typescript
import { generateText, PROVIDER_DEFAULTS } from '@framers/agentos';

const provider = 'ollama'; // any provider generateText serves: 'openai', 'anthropic', 'gemini', 'ollama', ...

new LlmJudgeReranker({
  // Your function: (system, user, model?) => the model's text. It picks the provider.
  // fallbackProviders: [] keeps every call on `provider`; without it generateText falls back to the other
  // providers whose keys are in the environment, and they receive the passages too.
  llmCallFn: async (system, prompt, model) =>
    (await generateText({ provider, model, system, prompt, fallbackProviders: [] })).text,
  scoringModel: PROVIDER_DEFAULTS[provider].cheap, // passed to llmCallFn as `model` on each scoring call
  rankingModel: PROVIDER_DEFAULTS[provider].cheap, // passed to llmCallFn as `model` on the ranking call
  maxPointwiseDocuments: 100,                   // the default
  pointwiseTopK: 20,                            // the default
  batchSize: 10,                                // the default
  timeoutMs: 30_000,                            // the default, per llmCallFn call
});
```

- The judge names no model and calls no provider. It hands `scoringModel` to `llmCallFn` on each scoring call and `rankingModel` on the ranking call, and `undefined` when one is not set, so `llmCallFn` decides. Any provider `generateText` serves fits: `PROVIDER_DEFAULTS` holds a `cheap` model for each (`gpt-4o-mini` for `openai`, `claude-haiku-4-5-20251001` for `anthropic`, `gemini-2.5-flash-lite` for `gemini`, `llama3.2` for `ollama`, among others). The request's `modelId` and `params` are not read, so a chain stage's `model` does not reach the judge.
- `isAvailable()` answers whether `llmCallFn` is a function. It is not built from a config entry: register it with `registerProvider()`.
- The answer carries no `diagnostics`.

`LlmJudgeReranker.rerank(input, config)` scores the first `maxPointwiseDocuments` passages, has the ranking call order the `pointwiseTopK` best of them, and answers every passage it scored: the ones the ranking names, in its order, each once (an id the ranking repeats counts once, and an id it was not given is passed over), then the rest by score, a tie in the order the passages came. A request's `topN` cuts the answer to that many, past `pointwiseTopK` too; without one, the answer holds every scored passage, and the passages past `maxPointwiseDocuments` are left out. An answer's `relevanceScore` is `1 - i / n` for its place `i`, from 0, among the `n` it answers.

Each call of `llmCallFn` waits up to the request's `timeoutMs`, else the judge's own, 30 seconds unless given; through `RerankerService`, the request's is the call's, else the provider settings' `defaultTimeoutMs`. Past it the judge stops waiting, and the call it made runs on to its end, since `llmCallFn` takes no abort signal. A scoring call that fails, runs past it or answers no JSON array scores its batch 0, and a score that is not a number counts 0. A ranking call that fails, runs past it or answers something other than a JSON array leaves the order to the scores. The judge does not throw for a model's failure.

### A provider of your own

```typescript
import { lexicalTokens } from '@framers/agentos/cognition/library';
import { RerankerService, type IRerankerProvider } from '@framers/agentos/cognition/rag/reranking';

// A passage scores the share of the query's words it holds.
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

## RerankerService

| Member | What it does |
|---|---|
| `new RerankerService({ config, logger })` | `config` holds `providers`, a settings entry per provider id, `defaultProviderId` and `defaultModelId`. The service reads each entry's `defaultModelId` and `defaultTimeoutMs` and creates no provider from it: register each one. |
| `registerProvider(provider)`, `getProvider(id)`, `getProviderConfig(id)`, `listProviders()`, `isProviderAvailable(id)` | The providers the service holds, and the settings entry of each. A provider registered under an id that is taken replaces the first. |
| `rerank(input, { providerId, modelId, topN, maxDocuments, timeoutMs, params })` | Sends the first `maxDocuments` documents (100 unless given) to the provider named, else the default one, and keeps the best `topN`. The model is the one given, else the provider's `defaultModelId` in the config, else the service's, else the provider's own; the timeout is the one given, else the provider's `defaultTimeoutMs` in the config, else the provider's own, 30 seconds for Cohere and the LLM judge. It throws when no provider is named and none is the default, or when the provider is not registered, and logs and passes on a provider's error. |
| `rerankChunks(query, chunks, config)` | `rerank()` over retrieved chunks (`RagRetrievedChunk`): each chunk comes back with the new `relevanceScore`, and its metadata records the provider (`_rerankerProviderId`) and the old score (`_rerankerOriginalScore`) when the provider hands it back, as the three built-in providers do. A result whose id is not among the chunks throws. |
| `rerankChain(query, chunks, stages)` | Runs providers one after another, each keeping its `topK`, for example a fast `local` stage that keeps 20 and an `llm-judge` stage that keeps 5. A stage asks for its `model`, else, as `rerank()` does, the provider's `defaultModelId` in the config, else the service's, else the provider's own default. A stage whose provider is not registered or not available is skipped, a stage that throws leaves the order it was given, and each chunk's metadata lists the stages that ran (`_rerankerChainStages`); see [Reranking and the Reranker Chain](../memory/RAG_MEMORY_CONFIGURATION.md#reranker-chain). |

## When a provider fails

| Where | What happens |
|---|---|
| `RerankerService.rerank()`, `rerankChunks()` | Throws: no provider named and no default, a provider not registered, or the provider's own error |
| `LocalCrossEncoderReranker` | Throws when Transformers.js cannot be loaded; a passage whose scoring throws scores 0 |
| `CohereReranker` | Throws without an `apiKey`, on a status that is not 2xx and on a timeout |
| `LlmJudgeReranker` | Does not throw for a model's failure: a failed scoring batch scores 0, a failed ranking call leaves the order to the scores |
| `rerankChain()` | Skips the stage and keeps the order it was given |
| `RetrievalAugmentor` | Returns the chunks without reranking and adds the error to `diagnostics.messages` |
| `CognitiveMemoryManager`, `HybridRetriever`, `SessionRetriever` | Keep the scores they had before reranking and write no log line of their own; the service logs a provider's error to its `logger`. They call the service's default provider, so a service without `defaultProviderId` fails every call this way, logged nowhere |
| `WebSearchService` | Keeps the fused order |

## Where a reranker plugs in

- `RetrievalAugmentor` builds a `RerankerService` from `rerankerServiceConfig`. It registers the `cohere` provider (when its entry has an `apiKey`) and the `local` one for the entries that config names; register `llm-judge` and providers of your own with `registerRerankerProvider()`. It reranks a request that sets `rerankerConfig.enabled`, with `rerankerConfig.providerId` (else `defaultRerankerProviderId`) picking the provider, or one with no `rerankerConfig` whose retrieval `policy` sets `reranker: 'always'` ([RAG Memory Configuration](../memory/RAG_MEMORY_CONFIGURATION.md#reranker-chain)).
- `CognitiveMemoryManager` takes a `rerankerService` and calls it with no provider id, so the service's `defaultProviderId` picks one; without a `defaultProviderId` every call throws and retrieval runs without reranking, with no log line. It blends 0.7 of each trace's cognitive score with 0.3 of the rerank score ([Memory retrieval reranking](../memory/RAG_MEMORY_CONFIGURATION.md#memory-retrieval-reranking)).
- `HybridRetriever` and `SessionRetriever` take a `rerankerService`, call its default provider over their pool and blend the scores the same way ([Hybrid BM25 + Dense Retriever](../architecture/hybrid-retriever.md), [Session Retriever](../architecture/session-retriever.md)).
- `WebSearchService` takes `reranker` and `rerankChain` and runs the chain over its fused results, unless a search passes `rerank: false`.

## Where it runs

None of the reranking modules imports a Node module. `CohereReranker` sends its requests with the global `fetch`. `LocalCrossEncoderReranker` imports Transformers.js on its first call. `LlmJudgeReranker` calls only the function you give it.

## Examples

One runnable file per provider, each through `RerankerService`:

| File | Provider | Needs |
|---|---|---|
| [`examples/rerank-local-cross-encoder.mjs`](../../examples/rerank-local-cross-encoder.mjs) | `local` | Transformers.js; the network once, for the model's first download |
| [`examples/rerank-cohere.mjs`](../../examples/rerank-cohere.mjs) | `cohere` | `COHERE_API_KEY` |
| [`examples/rerank-llm-judge.mjs`](../../examples/rerank-llm-judge.mjs) | `llm-judge` | Nothing: a stand-in judge runs by default. With `RERANK_JUDGE_PROVIDER` (`gemini`, `openai`, ...) and that provider's key, it calls the provider's cheap model through `generateText` |

[`examples/query-router-host-hooks.mjs`](../../examples/query-router-host-hooks.mjs) passes a host's own rerank hook to the `QueryRouter`.
