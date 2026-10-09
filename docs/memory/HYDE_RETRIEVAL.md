# HyDE (Hypothetical Document Embedding) Retrieval

HyDE improves RAG and memory retrieval by generating a hypothetical answer before
embedding. Instead of embedding the raw user query, HyDE first asks an LLM to
produce a plausible answer, then embeds *that* answer for vector search. The
hypothesis is semantically closer to actual stored documents than a question is,
yielding better recall.

![HyDE retrieval flow: standard retrieval embeds the question directly (large embedding-space gap to answer-style documents); HyDE retrieval embeds an LLM-generated hypothetical answer instead (small gap); benchmark sidebar shows -1.9 points on LongMemEval-S and +1.0 point on LongMemEval-M](/img/diagrams/hyde-retrieval-flow.svg)

**HyDE is opt-in (`enabled: false` by default).** The
[`agentos-bench`](https://github.com/framerslab/agentos-bench) runs measured it
both ways:

- **LongMemEval-S (115K tokens, 50 sessions)**: the 85.6% headline
  configuration runs with HyDE **off**. In a 54-case probe of the bench's
  reader-router configuration, adding HyDE scored 83.3% against 85.2% without
  it (-1.9 points).
- **LongMemEval-M (1.5M tokens, 500 sessions)**: the 70.2% headline
  configuration runs with HyDE **on**. The same run without HyDE scored 69.2%
  (-1.0 point, with overlapping confidence intervals) at an average of 35
  seconds a case against 84. By category, HyDE added 5.3 points on
  multi-session questions and cost 3.9 on knowledge-update questions.

Rule of thumb: turn HyDE on for multi-session questions over a haystack far
larger than the answer model's context window, and leave it off at S scale and
on tight-latency paths. The ablation rows are in the bench repository's
[`results/LEADERBOARD.md`](https://github.com/framerslab/agentos-bench/blob/master/results/LEADERBOARD.md)
and
[`results/eval-matrix-v1/transparency-notes.md`](https://github.com/framerslab/agentos-bench/blob/master/results/eval-matrix-v1/transparency-notes.md).

Based on:
- Gao et al. (2022). [*Precise Zero-Shot Dense Retrieval without Relevance Labels.*](https://arxiv.org/abs/2212.10496) arXiv:2212.10496.
- Lei et al. (2025). [*Never Come Up Empty: Adaptive HyDE Retrieval for Improving LLM Developer Support.*](https://arxiv.org/abs/2507.16754) arXiv:2507.16754.

## How It Works

```
Standard:  Query --> Embed(query)       --> Vector Search --> Results
HyDE:     Query --> LLM(hypothesis)    --> Embed(hypothesis) --> Vector Search --> Results
                    ^                         ^
                    Extra LLM call            Better semantic match
```

The key insight: questions and answers live in different regions of embedding
space. A question like "What causes memory leaks in Node?" is far from the
answer text "Memory leaks in Node.js are caused by...". But a hypothetical
answer *generated from the question* is much closer to the stored answer,
producing higher cosine similarity scores.

## When to Use HyDE

**Good candidates:**
- Knowledge base queries where the question phrasing differs from document style
- Vague or exploratory queries ("that thing about deployment")
- Memory recall where stored traces are statement-form, not question-form
- Background/batch processing where latency is less critical

**Avoid when:**
- Real-time chat with tight latency budgets (adds one LLM call per query)
- Simple keyword-style lookups where direct embedding already works well
- The query is already in statement/answer form

## Configuration

HyDE has no global switch: each integration turns it on per call, as shown below. [`HydeRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/HydeRetriever.ts) and its config types are exported from `@framers/agentos/cognition/rag`. A `HydeRetriever` takes this config:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Read by callers through `retriever.enabled` |
| `initialThreshold` | `number` | `0.7` | Starting similarity threshold for `retrieve()` |
| `minThreshold` | `number` | `0.3` | Lowest threshold `retrieve()` steps down to |
| `thresholdStep` | `number` | `0.1` | How much `retrieve()` lowers the threshold per step |
| `adaptiveThreshold` | `boolean` | `true` | Step down while a search returns nothing |
| `maxHypothesisTokens` | `number` | `200` | Written into the prompt as a length limit; not sent as a token cap |
| `hypothesisSystemPrompt` | `string` | a short "answer factually, with technical terms" prompt | System prompt for hypothesis generation |
| `fullAnswerGranularity` | `boolean` | `true` | Ask for prose answers rather than the shortest answer |
| `hypothesisCount` | `number` | `3` | Hypotheses per query in `retrieveMulti()` and `generateMultipleHypotheses()` |

## Programmatic API

### 1. RetrievalAugmentor (main RAG pipeline)

```typescript
import { RetrievalAugmentor } from '@framers/agentos/cognition/rag';

// Stand-ins. Replace with your real EmbeddingManager / VectorStoreManager
// instances and a RetrievalAugmentorConfig your runtime provides.
declare const config: any;
declare const embeddingManager: any;
declare const vectorStoreManager: any;
declare const openai: any;

const augmentor = new RetrievalAugmentor();
await augmentor.initialize(config, embeddingManager, vectorStoreManager);

// Register an LLM caller for hypothesis generation
augmentor.setHydeLlmCaller(async (systemPrompt, userPrompt) => {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 200,
  });
  return response.choices[0].message.content ?? '';
});

// Enable HyDE per request
const result = await augmentor.retrieveContext('What causes memory leaks?', {
  hyde: {
    enabled: true,
    // Optional: supply a hypothesis to skip the LLM call
    // hypothesis: 'Memory leaks are caused by...',
  },
});

console.log(result.diagnostics?.hyde);
// { hypothesis, hypothesisLatencyMs, effectiveThreshold: 0.7, thresholdSteps: 0 }
```

The augmentor generates one hypothesis, embeds it in place of the query and runs its normal search with that vector. It does no threshold stepping: `diagnostics.hyde` reports the configured `initialThreshold` and `thresholdSteps: 0`. A retrieval policy with `hyde: 'always'` turns HyDE on without `options.hyde`.

### 2. MultimodalIndexer (cross-modal search)

```typescript
import { MultimodalIndexer, HydeRetriever } from '@framers/agentos/cognition/rag';

// Stand-ins for the host-supplied dependencies.
declare const embeddingManager: any;
declare const vectorStore: any;
declare const visionProvider: any;
declare const myLlmCaller: any;

const indexer = new MultimodalIndexer({
  embeddingManager,
  vectorStore,
  visionProvider,
});

indexer.setHydeRetriever(new HydeRetriever({
  llmCaller: myLlmCaller,
  embeddingManager,
  config: { enabled: true },
}));

// Search with HyDE: HydeRetriever.retrieve(), with adaptive thresholds
const results = await indexer.search('architecture diagram', {
  modalities: ['image'],
  hyde: { enabled: true },
});
```

### 3. CognitiveMemoryManager (memory recall)

`initialize()` builds a memory HyDE retriever from the first LLM invoker the config has (the reflector's, the observer's, then `featureDetectionLlmInvoker`); `setHydeRetriever()` replaces it.

```typescript
import { CognitiveMemoryManager } from '@framers/agentos';

// Stand-ins for the host-supplied dependencies.
declare const config: any;
declare const currentMood: any;

const memoryManager = new CognitiveMemoryManager();
await memoryManager.initialize(config);

const result = await memoryManager.retrieve(
  'that deployment discussion',
  currentMood,
  { hyde: true },
);
```

With `hyde: true` (or a retrieval policy with `hyde: 'always'`), the manager asks for a hypothesis to "Recall a memory about: <query>" and searches with the hypothesis text in place of the query. Without a retriever, or when generation fails, it searches with the query.

### 4. Standalone HydeRetriever

```typescript
import { HydeRetriever } from '@framers/agentos/cognition/rag';

declare const embeddingManager: any;
declare const myVectorStore: any;

const retriever = new HydeRetriever({
  llmCaller: async (system, user) => {
    // Call your model with the system and user prompts; return its text.
    return 'Retrieval-augmented generation retrieves documents and adds them to the prompt...';
  },
  embeddingManager,
  config: { adaptiveThreshold: true, initialThreshold: 0.7, minThreshold: 0.3 },
});

// Generate a hypothesis only
const { hypothesis, latencyMs } = await retriever.generateHypothesis(
  'What is retrieval augmented generation?',
);

// Full retrieve cycle with adaptive thresholding
const result = await retriever.retrieve({
  query: 'What is RAG?',
  vectorStore: myVectorStore,
  collectionName: 'knowledge-base',
});

// Several hypotheses from one LLM call, searched in parallel and merged
const multi = await retriever.retrieveMulti({
  query: 'What is RAG?',
  vectorStore: myVectorStore,
  collectionName: 'knowledge-base',
});
```

`retrieveMulti()` keeps the highest score per document and returns the top
`queryOptions.topK` (5 by default). It applies no similarity threshold and
does no threshold stepping. When the model's reply does not split into the
requested number of hypotheses, the retriever makes one more call per missing
hypothesis.

### 5. Other callers

- [`UnifiedRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/unified/UnifiedRetriever.ts):
  with a `hydeRetriever` dependency, it runs HyDE when the retrieval plan has
  `hyde.enabled`. The default plans turn it on for the `moderate` strategy
  (one hypothesis) and the `complex` strategy (three).
- The memory [`HybridRetriever`](../architecture/hybrid-retriever.md): with
  the `hydeRetriever` option, a hypothesis replaces the query for the dense
  and sparse searches, and the reranker keeps the original query.
- [`QueryRouter`](../QUERY_ROUTER.md): the built-in router generates no
  hypothesis. Its T2 and T3 searches run the router's plain vector search
  unless a `UnifiedRetriever` built with a `hydeRetriever` is attached with
  `setUnifiedRetriever()`.

## Adaptive Thresholding

`HydeRetriever.retrieve()` (used directly or by `MultimodalIndexer`) steps the
similarity threshold down while a search returns nothing, until it finds
content or would pass `minThreshold`. The augmentor and the memory manager do
not step.

```
Initial threshold: 0.7  -->  No results
Step down to:      0.6  -->  No results
Step down to:      0.5  -->  Found 3 results!  (stop here)
```

`retrieve()` returns `effectiveThreshold` and `thresholdSteps`, the number of steps it took.

## Audit Trail

When `includeAudit: true` is passed to `retrieveContext()`, the augmentor's
HyDE step appears in the audit trail with operation type `'hyde'`:

```typescript
const result = await augmentor.retrieveContext(query, {
  hyde: { enabled: true },
  includeAudit: true,
});

const hydeOp = result.auditTrail?.operations.find(
  (op) => op.operationType === 'hyde',
);
// hydeOp.hydeDetails.hypothesis
// hydeOp.hydeDetails.effectiveThreshold
// hydeOp.hydeDetails.thresholdSteps
// hydeOp.tokenUsage (estimated from text length: about 4 characters a token)
```

## Performance Implications

| Metric | Without HyDE | With HyDE |
|--------|-------------|-----------|
| LLM calls per query | 0 | 1 |
| Embedding calls | 1 | 1 (hypothesis instead of query) |
| Vector searches | 1 | 1, or up to one per threshold step in `HydeRetriever.retrieve()` |
| Added latency | 0 | one LLM generation |

The model is whatever the LLM caller you register calls.

## Graceful Degradation

| Failure | RetrievalAugmentor | CognitiveMemoryManager | HydeRetriever / MultimodalIndexer |
|---|---|---|---|
| No LLM caller or retriever | direct query embedding, with a diagnostic message | raw query | (a retriever always has a caller) |
| The LLM call throws | the error propagates from `retrieveContext()` | raw query | the error propagates |
| The hypothesis embedding is empty | direct query embedding, with a diagnostic message | (the store embeds the text) | empty result |
| No results at any threshold | (no stepping) | (no stepping) | empty result |
