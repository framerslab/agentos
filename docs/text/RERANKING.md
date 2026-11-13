---
description: "Reranking retrieved passages in AgentOS: RerankerService and its three built-in providers, a local Transformers.js cross-encoder, Cohere's rerank API and a two-phase LLM judge on any model you call, compared side by side, plus the provider interface, where the retrievers take a reranker, and memory rerank, which runs on a local model or your own model call and never on a remote reranking service."
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
| Latency class | In process: one forward pass per batch of up to `batchSize` passages, batches one after another, plus the model's load on the first call | One network round trip | Several model round trips, one after another: the slowest of the three |
| Pick it when | The passages must not leave the machine, the host runs offline, or you want no per-call bill | You want a strong hosted reranker in one call and may send the passages to Cohere | You already pay for a model provider, want the ranking judged by a language model, and can wait for several calls |

A remote provider (`cohere`, or `llm-judge` on a hosted model) receives the query and the candidate texts. The LLM judge keeps them on the machine only when its `llmCallFn` calls a local model and nothing else: `generateText` on a retryable failure falls back to the other providers whose keys are in the environment, unless the call passes `fallbackProviders: []`.

## Providers

A provider implements [`IRerankerProvider`](../../src/cognition/rag/reranking/IRerankerService.ts): a `providerId`, `isAvailable()`, and `rerank({ query, documents }, config)`, which answers `{ results }`, each result a document with its `relevanceScore`, best first.

### `local`: a cross-encoder in process

```typescript
new LocalCrossEncoderReranker({
  providerId: 'local',
  defaultModelId: 'cross-encoder/ms-marco-MiniLM-L6-v2',  // the default
  revision: '233902d25c440f23af6f7d6e94d2946bac0bee0a',   // a commit of the model's repository; unset: its main
  batchSize: 32,                                          // pairs per forward pass, the default
  maxSequenceLength: 512,                                 // tokens per pair, the default
  modelFileName: 'model',                                 // onnx/model.onnx; unset: the model's default file
  cacheDir: '/var/cache/agentos-models',                  // Transformers.js's own cache when unset
  localFilesOnly: true,                                   // load from the cache alone; unset: fetch what it lacks
  device: 'cpu',                                          // the default
  intraOpNumThreads: 2,                                   // threads per operator; unset: onnxruntime sizes its pool for the machine
  pieceMaxChars: 300,                                     // score long passages by their best piece; unset: one pair per passage
});
```

- Needs Transformers.js: `@huggingface/transformers` 3.x, an optional dependency of the package, else `@xenova/transformers` 2.x. `isAvailable()` answers whether one of them imports; `rerank()` throws when neither does.
- `LOCAL_RERANKER_MODELS` lists three Hugging Face model ids, each with the licence its repository states (read on 13 November 2026):

  | Model | Licence |
  |---|---|
  | [`cross-encoder/ms-marco-MiniLM-L6-v2`](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2) (the default) | apache-2.0 |
  | [`cross-encoder/ms-marco-MiniLM-L12-v2`](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L12-v2) | apache-2.0 |
  | [`BAAI/bge-reranker-base`](https://huggingface.co/BAAI/bge-reranker-base) | mit |

  The provider loads any other id a host passes; checking that model's licence is then the host's. The two MiniLM repositories' earlier ids, `cross-encoder/ms-marco-MiniLM-L-6-v2` and `cross-encoder/ms-marco-MiniLM-L-12-v2`, redirect to these and load as before. No Jina reranker is listed or a default: `jinaai/jina-reranker-v2-base-multilingual` is under a non-commercial licence ([cc-by-nc-4.0](https://huggingface.co/jinaai/jina-reranker-v2-base-multilingual), read on 13 November 2026).
- `revision` pins what each load reads to a branch, a tag or a commit of the model's repository; unset, a load reads `main`. `localFilesOnly` loads from the cache alone and fails when a file is missing, so a process that must not download at run time fetches the files when it is built. Transformers.js keeps a pinned revision's files under `<cache>/<model id>/<revision>/` and `main`'s under `<cache>/<model id>/` ([`getModelFile`](https://github.com/huggingface/transformers.js/blob/3.8.1/src/utils/hub.js#L467-L489)), so files fetched ahead for a pinned revision go in the folder named for it.
- The model loads on the first `rerank()` (or `initialize(modelId)`) as a tokenizer (`AutoTokenizer`) and a sequence-classification model (`AutoModelForSequenceClassification`), and serves every later request. A request's `modelId` picks the model only on that first load; `initialize(otherModelId)` loads another, and `initialize()` with no id loads `defaultModelId` in place of any other model loaded. `dispose()` unloads it. Loads and unloads run one at a time in the order asked, so concurrent `initialize()` calls never load two models at once and the last one asked for stays loaded. A `rerank()` already running scores all its batches with the model it started with; a model replaced or unloaded meanwhile is disposed when the last rerank using it ends.
- What loads: the model's `config.json`, `tokenizer.json` and `tokenizer_config.json`, and one ONNX file from its `onnx/` folder, `onnx/<modelFileName><dtype suffix>.onnx`. `modelFileName` takes the bare name (`'model_quint8_avx2'`), a path in that folder (`'onnx/model_quint8_avx2.onnx'`) or the name with `.onnx`; all three load `onnx/model_quint8_avx2.onnx`. With neither `modelFileName` nor `dtype` set, a model listed in `LOCAL_RERANKER_DEFAULT_WEIGHTS` loads the file named there and any other model loads `onnx/model.onnx` (full precision). The default model loads `onnx/model_quint8_avx2.onnx`, the repository's 8-bit dynamically quantized file (22 MB, against 87 MB for `onnx/model.onnx`): it ranks as the full-precision file does and scores a batch in about half the time on a 2-vCPU x86 host. It loads and runs on ARM hosts too; the repository also holds `onnx/model_qint8_arm64.onnx`, the file quantized for ARM, which `modelFileName: 'model_qint8_arm64'` names. For full precision, name `model`.
- `dtype` (Transformers.js 3.x) adds a suffix to the file name: `'fp32'` (the default) none, `'q8'` `_quantized`, `'fp16'` `_fp16`, `'int8'` `_int8`, `'uint8'` `_uint8`, `'q4'` `_q4`, `'bnb4'` `_bnb4`, `'q4f16'` `_q4f16`. The `cross-encoder/*` repositories hold no `onnx/model_quantized.onnx`, so `dtype: 'q8'` fails to load there; name their quantized files with `modelFileName`. The provider always passes a dtype (`'fp32'` when unset), and an explicit dtype overrides Transformers.js's browser default: in a browser, where Transformers.js 3.x would load a model on its WASM backend at `'q8'` when given none ([`DEFAULT_DEVICE_DTYPE_MAPPING`](https://github.com/huggingface/transformers.js/blob/3.8.1/src/utils/dtypes.js#L48-L51)), the file is still `onnx/<modelFileName>.onnx`. Transformers.js 2.x reads `quantized` and no dtype, so there `'q8'` loads `onnx/<modelFileName>_quantized.onnx` and every other value loads `onnx/<modelFileName>.onnx`.
- Each batch of up to `batchSize` passages is tokenized as (query, passage) pairs, padded and cut to `maxSequenceLength` tokens, and scored in one forward pass: 20 passages at the default `batchSize` are one pass. A pair longer than `maxSequenceLength` loses the end of its passage and its closing separator token, since Transformers.js truncates the pair's token arrays at the limit ([`truncateHelper`](https://github.com/huggingface/transformers.js/blob/3.8.1/src/tokenizers.js#L2580-L2586)); an answer late in a long passage is never read.
- `pieceMaxChars` scores long passages by their best piece, and is off unless set. A passage longer than it is split into pieces of at most that many characters (UTF-16 units, as `String.length` counts them; a character outside the Basic Multilingual Plane is never split, so at 1 it is a piece of 2): its sentences in order (a sentence ends at `.`, `!` or `?` before a space, and at a line break), packed together while they fit and joined by one space; a sentence longer than a piece is split between words, and only a word longer than a piece is cut. Every piece of every passage is a (query, piece) pair in the same batches of `batchSize`, and a passage scores its best piece's score; its `content` in the answer is the whole passage. Pick a length at which a piece and the query fit in `maxSequenceLength` tokens. Each piece is a pair, so the pairs grow with the passages' length: 20 passages of 1,024 characters at `pieceMaxChars: 300` are at least 80 pairs, at least three forward passes at the default `batchSize`, against one pass for 20 whole passages, and one passage of 100,000 characters is at least 334 pairs. Cut passages that can run that long before reranking them.
- `intraOpNumThreads` sets the threads onnxruntime runs one operator on, passed to the ONNX session as `session_options.intraOpNumThreads`. Unset, the session gets no thread count and onnxruntime sizes its pool itself: onnxruntime-node 1.21 sizes it to the physical cores of the whole machine and, on Linux, pins a thread to each core ([`CreateThreadPoolHelper`](https://github.com/microsoft/onnxruntime/blob/v1.21.0/onnxruntime/core/util/thread_utils.cc#L92-L125)), whatever CPU limit the process runs under. Inside a container's cpuset or CPU quota, or on a host other processes share, those threads contend for the cores the process has, so a host on a CPU limit sets `intraOpNumThreads` to the cores it may use (`1` runs each operator on the calling thread). `interOpNumThreads` reaches the session too, but onnxruntime creates that pool only in its parallel execution mode ([`inference_session.cc`](https://github.com/microsoft/onnxruntime/blob/v1.21.0/onnxruntime/core/session/inference_session.cc#L457)) and Transformers.js runs sessions in the default sequential mode. onnxruntime-node reads both (Transformers.js 3.x on Node); onnxruntime-web and Transformers.js 2.x do not. A value that is not a whole number from 1 leaves the count unset, and a fraction is rounded down.
- Scores: a model with one logit (the `cross-encoder/*` and `BAAI/bge-reranker-*` models) scores a passage with the sigmoid of its raw logit; a model with two or more logits, with the softmax probability of its relevant class (a `LABEL_1`, `POSITIVE`, `relevant` or similar label in the model's `id2label`, else class 1). Scores sit between 0 and 1 and keep the logits' order; they compare passages within one model, not across models.
- A failed load or forward pass, or a NaN or infinite logit, throws, so `rerankChain()` and `RetrievalAugmentor` keep the order they had; a `rerankChunks()` caller keeps its order only if it catches ([When a provider fails](#when-a-provider-fails)). A load throws as soon as the tokenizer or the model fails. A model that loads after its tokenizer failed finishes in the background, and the provider then calls its `dispose()` and drops any error the disposal throws; the next load, unload or retry waits for that, so two loads never overlap. A failed load is not remembered. With no model loaded, the next `rerank()` tries the load once more and fetches any file the cache lacks. When `initialize(otherModelId)` fails while a model is loaded, reranks go on with the loaded model; call `initialize(otherModelId)` again to retry the replacement.
- `diagnostics.providerMetrics` reports `batchSize`, `forwardPasses`, `pairsScored` (the (query, text) pairs scored: one per passage, or one per piece with `pieceMaxChars`), `pieceMaxChars` when it is set, `modelFile` and `device`. `modelFile` is the file the installed Transformers.js loads by its naming rule: under 3.x `onnx/<modelFileName><dtype suffix>.onnx`, under 2.x `onnx/<modelFileName>.onnx`, or `onnx/<modelFileName>_quantized.onnx` for `dtype: 'q8'`.
- No `device` value selects a GPU: the model is loaded without a device option, so Transformers.js picks the backend. `'gpu'` sets Transformers.js's ONNX WASM backend to one thread, a process-wide setting every Transformers.js model in the process shares; `'cpu'` and `'auto'` change nothing.
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
- A response that is not 2xx throws `Cohere API error (<status>): <body>`. The timeout covers the wait for the response's headers: a request with no response by then is aborted and throws `CohereReranker: Request timed out after <ms>ms`. The timer is cleared once the response arrives, so reading its body has no limit.
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
- The answer's `diagnostics` name the provider (`llm-judge`), the model (`rankingModel`, else `''`, since `llmCallFn` then picks the ranking call's model), the latency and the passages it scored (`documentsProcessed`); no token count, since `llmCallFn` returns text alone. `diagnostics.providerMetrics` counts what the judge put in for an answer the model did not give: `scoringFailures`, the passages scored 0 because their batch's call failed, ran past the timeout or answered no JSON array, or because their own entry was missing or not a number; and `listwiseFailed`, true when the ranking call failed or named none of the passages it was given, so the scores ordered the answer.

`LlmJudgeReranker.rerank(input, config)` scores the first `maxPointwiseDocuments` passages, has the ranking call order the `pointwiseTopK` best of them, and answers every passage it scored: the ones the ranking names, in its order, each once (an id the ranking repeats counts once, and an id it was not given is passed over), then the rest by score, a tie in the order the passages came. A request's `topN` cuts the answer to that many, past `pointwiseTopK` too; without one, the answer holds every scored passage, and the passages past `maxPointwiseDocuments` are left out. An answer's `relevanceScore` is `1 - i / n` for its place `i`, from 0, among the `n` it answers.

Each call of `llmCallFn` waits up to the request's `timeoutMs`, else the judge's own, 30 seconds unless given; through `RerankerService`, the request's is the call's, else the provider settings' `defaultTimeoutMs`. Past it the judge stops waiting, and the call it made runs on to its end, since `llmCallFn` takes no abort signal. A scoring call that fails, runs past it or answers no JSON array scores its batch 0, and a score that is not a number counts 0. A ranking call that fails, runs past it, answers something other than a JSON array or names none of the passages it was given leaves the order to the scores. The judge does not throw for a model's failure.

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
| `RerankerService.rerank()`, `rerankChunks()` | Logs the provider's error to the service's `logger` when it has one, then throws it; it also throws when no provider is named and none is the default, or the provider is not registered. The caller keeps its order only if it catches |
| `LocalCrossEncoderReranker` | Throws when Transformers.js or the model cannot be loaded, and when a forward pass fails. After a failed load, the next call loads again only when no model is loaded; a model loaded before keeps serving |
| `CohereReranker` | Throws without an `apiKey`, on a status that is not 2xx and when no response arrives within the timeout |
| `LlmJudgeReranker` | Does not throw for a model's failure: a failed scoring batch scores 0, a failed ranking call leaves the order to the scores |
| `rerankChain()` | Skips the stage and keeps the order it was given |
| `RetrievalAugmentor` | Returns the chunks without reranking and adds the error to `diagnostics.messages` |
| `HybridRetriever`, `SessionRetriever` | Keep the scores they had before reranking and write no log line of their own; the service logs a provider's error to its `logger`. They call the service's default provider, so a service without `defaultProviderId` fails every call this way, logged nowhere |
| Memory rerank (`recall.rerank` on `CognitiveMemoryManager`) | Keeps the order the recall had; the turn's capture records `reranker: { provider: 'none', reason }` and a `memory.recall.rerank_skipped`, `rerank_unavailable` or `rerank_failed_scoring` line is written ([Memory rerank](#memory-rerank)) |
| `WebSearchService` | Keeps the fused order |

A host that calls `rerankChunks()` keeps its order on a failure by catching, and records the error there. The service logs a provider's error only when it was built with a `logger`, and never logs its own errors: no provider named and no default, a provider not registered, a result id that is not among the chunks.

```typescript
const ranked = await service.rerankChunks(query, chunks).catch((error) => {
  logger.warn('rerank failed; keeping the retrieved order', { error: String(error) });
  return chunks;
});
```

`rerankChain()` does the same for every stage: a stage that throws, a local model that fails to load included, leaves the chunks in the order it was given, with their scores, and its id is missing from `_rerankerChainStages`.

## Where a reranker plugs in

- `RetrievalAugmentor` builds a `RerankerService` from `rerankerServiceConfig`. It registers the `cohere` provider (when its entry has an `apiKey`) and the `local` one for the entries that config names; register `llm-judge` and providers of your own with `registerRerankerProvider()`. It reranks a request that sets `rerankerConfig.enabled`, with `rerankerConfig.providerId` (else `defaultRerankerProviderId`) picking the provider, or one with no `rerankerConfig` whose retrieval `policy` sets `reranker: 'always'` ([RAG Memory Configuration](../memory/RAG_MEMORY_CONFIGURATION.md#reranker-chain)). Its reranker serves document retrieval and is never used for memory recall.
- `CognitiveMemoryManager` reranks recalled memories with the provider its `recall.rerank` names, in a service of its own: [Memory rerank](#memory-rerank). It never calls a `rerankerService` passed on its configuration; `getRerankerService()` returns that service for a retriever the caller builds.
- `HybridRetriever` and `SessionRetriever` take a `rerankerService`, call its default provider over their pool and blend the scores the same way ([Hybrid BM25 + Dense Retriever](../architecture/hybrid-retriever.md), [Session Retriever](../architecture/session-retriever.md)).
- `WebSearchService` takes `reranker` and `rerankChain` and runs the chain over its fused results, unless a search passes `rerank: false`.

## Memory rerank

A memory rerank reorders what a turn's recall found: the vector recall's list or, under `retrieval: 'hybrid'`, the cut of the one pool that meaning, exact words and recency are fused into ([Recall](../memory/COGNITIVE_MEMORY.md#recall); [Lexical and Hybrid Search](./LEXICAL_AND_HYBRID_SEARCH.md#other-lexical-search-in-the-package) sets the exact-words leg beside the package's other lexical search).

Memory recall (`CognitiveMemoryManager`, and through it a `gmi()` or `agent({ runtime: 'gmi' })` agent's memory block) reranks with `recall.rerank`, on `memory.recall` of `agent()` and `gmi()` and on a manager's `recall`:

```typescript
import { agent, generateText } from '@framers/agentos';

// No reranker: the default.
agent({ runtime: 'gmi', provider: 'openai', memory: { recall: { rerank: 'none' } } });

// A cross-encoder in this process, at a pinned commit of its repository. The memories never leave the process.
agent({
  runtime: 'gmi',
  provider: 'openai',
  memory: {
    recall: {
      rerank: { kind: 'local', model: 'cross-encoder/ms-marco-MiniLM-L6-v2', revision: '233902d25c440f23af6f7d6e94d2946bac0bee0a' },
    },
  },
});

// Your own model call as the judge. The candidate memories go to that model's provider.
agent({
  runtime: 'gmi',
  provider: 'openai',
  memory: {
    recall: {
      rerank: {
        kind: 'llm',
        model: 'gpt-4o-mini',
        invoke: async (system, prompt, model) => (await generateText({ provider: 'openai', model, system, prompt, fallbackProviders: [] })).text,
      },
    },
  },
});
```

| | `'none'` (default) | `{ kind: 'local' }` | `{ kind: 'llm' }` |
|---|---|---|---|
| Provider | none | [`LocalCrossEncoderReranker`](#local-a-cross-encoder-in-process) on `model` at `revision`, both required | [`LlmJudgeReranker`](#llm-judge-an-llm-as-the-judge) over `invoke`, called with `model` for both phases; both required |
| What leaves the process | nothing | nothing while scoring; the model's files are downloaded from Hugging Face Hub on the first load unless Transformers.js's cache holds them | the turn's text and the first 200 characters of each candidate memory, to the provider `invoke` calls |
| `timeoutMs` (one rerank) | | 1,500 | 10,000 |
| `maxCandidates` (the recall's best) | | 20 | 20 |

No other `kind` exists: a remote reranking service is not offered for memories, and `agent()`, `gmi()` and `CognitiveMemoryManager.initialize()` refuse one at construction (`memory.recall.rerank`, reason `unsupported_provider`). A blank `model`, a `local` whose `revision` is not a whole commit id (40 hexadecimal characters; a branch, a tag or a shortened id can name other weights later, so it pins nothing), an `llm` without an `invoke`, and a `timeoutMs` or `maxCandidates` that is not a positive integer are refused the same way, naming the field. No environment variable turns memory rerank on, and a `rerankerService` on the manager's configuration is not read for it (one `memory.recall.option_ignored` line, `option: 'remote_provider'`, when the manager initialises). On `agent()` without `runtime: 'gmi'` the setting is refused: that agent's memory comes from its `memoryProvider`.

**What a turn does.** The reranker scores the recall's best `maxCandidates` candidates against the turn's own text, never a HyDE hypothesis, and they are reordered by `0.7 × the score each holds + 0.3 × its rerank score`; candidates past `maxCandidates` keep their order after them. Under `retrieval: 'dense'` the score is the trace's retrieval score, and the blend replaces it. Under `'hybrid'` it is the candidate's fused score as a share of the best fused score among the cut's recalled candidates, at most 1, so both terms run from 0 to 1; the fused scores and each line's relevance stay, and a memory question's reserved candidates follow the reranked cut, unscored. A supplied candidate in the cut is scored with the rest, and its score, which is on the caller's own scale, is never read as the best. A memory deleted while the reranker runs leaves the recall and its record. The turn's capture names the reranker (`reranker: { provider, model, revision, candidates, ms }`) and each scored candidate's `rerankScore` ([Recall Capture](../memory/COGNITIVE_MEMORY.md#recall-capture)).

**A rerank never fails a turn.** When it does not answer, the order stands and the capture says why:

| `reranker.reason` | When | Log line |
|---|---|---|
| `none_configured` | `rerank` is `'none'` or unset | none |
| `loading` | The local model's load has not settled. It starts once, when the manager initialises, and no turn waits for it; `recallReady()` resolves when it has settled, for a deploy step that warms the model before the process reports healthy. A `gmi()` or `agent({ runtime: 'gmi' })` agent builds its manager inside its first session's first turn and has no `recallReady()`: each agent loads the model for itself, so a host of the facade keeps one agent per process, and the turns whose recall ends before the load has settled record `loading` | `memory.recall.rerank_skipped` |
| `unavailable` | The load failed, or Transformers.js is not installed: the load is not tried again and nothing else is downloaded. Also a rerank whose reranker was stopped while it ran, by `applyRecallConfig()` or the manager's shutdown | `memory.recall.rerank_unavailable` (`load_failed` or `missing_dependency`), once per process for each; none for a stopped reranker |
| `timeout` | The rerank ran past `timeoutMs`. Its answer is dropped when it arrives: Transformers.js offers no cancellation, and the judge's `invoke` takes no abort signal, so a call already made runs to its end. The judge starts no further model call for that rerank | `memory.recall.rerank_skipped` |
| `error` | The provider threw, left out a candidate it was sent, or put a score in for one it could not compute (the judge's `scoringFailures`, or `listwiseFailed` for a ranking call that failed or named none of the candidates) | `memory.recall.rerank_skipped`; `memory.recall.rerank_failed_scoring` with the count for a substituted score |
| `backoff` | Three failures or timeouts in a row: the provider is not called for 60 seconds | one `memory.recall.rerank_skipped` when the back-off begins |

The lines carry the provider, the reason and a count, never a memory's text, the turn's text or an id.

**On a built manager**, change the setting with `applyRecallConfig({ rerank })`: the provider is built once, so a value written to the manager's configuration is not read. It resolves when the new model's load has settled. A rerank the earlier reranker was running is dropped at once, without waiting for its provider or its deadline, and that turn's order stands.

**The local model's files.** The setting takes no cache folder: the model loads through Transformers.js's own cache (`env.cacheDir` of `@huggingface/transformers`), which holds a pinned revision's files under `<cache>/<model id>/<revision>/`. A host that must not download at run time fetches the files when it is built (`config.json`, `tokenizer.json`, `tokenizer_config.json` and the weights file, for the default model `onnx/model_quint8_avx2.onnx`), puts them in that folder, and sets `env.cacheDir` and `env.allowRemoteModels = false` before the manager initialises. Both are process-wide: every Transformers.js model in the process reads them.

**The judge's load.** With the defaults, 20 candidates are two scoring calls of ten and one ranking call of twenty, each holding the turn's text and the first 200 characters of every candidate it judges, on every turn that recalls. A larger `maxCandidates` adds a scoring call for every ten candidates; the ranking call orders the 20 best-scored. Size `maxCandidates` and the model to that, and prefer `local` where the latency of three model calls a turn is too much.

## Memories and remote rerankers

AgentOS offers no remote reranker for memories. A person's stored memories are personal data, and a host that sends them to a reranking service itself (through a `RerankerService` of its own over the traces it retrieved) checks these first:

- **The service's terms may forbid it.** Cohere's standard SaaS agreement, for one, does not allow personal information other than business contact details to be sent without a separate agreement (section 5(b), "Prohibited Data"), and its grant lets Cohere use what it receives to improve its services and share it with third parties (section 3(a)(iii)) ([Cohere SaaS Agreement](https://cohere.com/saas-agreement), read on 9 November 2026). Memories need an agreement that covers them before they go to such a service.
- **The host is the controller.** Under the GDPR the host decides why its users' memories are processed, so a vendor that ranks them is its processor and needs a written agreement with the terms Article 28(3) lists ([GDPR, Article 28](https://eur-lex.europa.eu/eli/reg/2016/679/oj)).
- **Users are told.** The host's privacy notice names the vendor, the purpose ("ranking which of your stored memories to include in a reply"), the data sent (the message and the candidate memories), and the vendor's location and retention.
- **Special categories stay local.** A host whose memories can hold health data or data about a person's sex life keeps memory rerank in the process (`kind: 'local'`); Article 9 of the GDPR forbids processing such data without one of its conditions.

`{ kind: 'llm' }` sends the candidates to the model provider `invoke` calls, so the same points apply to that provider, which a host that already sends its users' turns there has answered.

## Where it runs

None of the reranking modules imports a Node module. `CohereReranker` sends its requests with the global `fetch`. `LocalCrossEncoderReranker` imports Transformers.js on its first call. `LlmJudgeReranker` calls only the function you give it.

## Examples

One runnable file per provider, each through `RerankerService`:

| File | Provider | Needs |
|---|---|---|
| [`examples/rerank-local-cross-encoder.mjs`](../../examples/rerank-local-cross-encoder.mjs) | `local` | Transformers.js; the network once, for the model's first download |
| [`examples/rerank-cohere.mjs`](../../examples/rerank-cohere.mjs) | `cohere` | `COHERE_API_KEY` |
| [`examples/rerank-llm-judge.mjs`](../../examples/rerank-llm-judge.mjs) | `llm-judge` | Nothing: a stand-in judge runs by default. With `RERANK_JUDGE_PROVIDER` (`openai`, `anthropic`, `gemini`, `ollama`, ...) and that provider's key, it calls the provider's cheap model through `generateText` |

[`examples/query-router-host-hooks.mjs`](../../examples/query-router-host-hooks.mjs) passes a host's own rerank hook to the `QueryRouter`.
