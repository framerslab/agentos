# Ingest Router

Input-stage smart orchestrator. Classifies incoming content and picks an ingest strategy: `raw-chunks`, `summarized`, `observational`, `fact-graph`, `hybrid`, or `skip`. The first stage of the [Cognitive Pipeline](./COGNITIVE_PIPELINE.md).

## What it actually does

Every piece of content entering memory (a new conversation turn, a long article, a code file, a CSV) goes through one classifier call:

1. A `gpt-5-mini`-style classifier reads the content (truncated to ~1k chars for the kind detection) and emits an [`IngestContentKind`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/routing-tables.ts) (short-conversation, long-conversation, long-article, code, structured-data, multimodal).
2. The routing table picks an ingest strategy for that kind.
3. The dispatcher invokes a registered executor that actually writes to memory in the chosen format.

Why this matters: a 3-turn chat snippet doesn't justify the LLM cost of observation extraction; a 50-turn customer support thread does. A long-form article benefits from session-summarized contextual retrieval; structured CSV data doesn't. Picking the wrong strategy at ingest costs accuracy or money downstream.

## Six content kinds

| Kind | Examples |
|---|---|
| `short-conversation` | 1-3 turn chats, brief Q&A |
| `long-conversation` | extended chat sessions, support threads |
| `long-article` | blog posts, paper sections, long emails |
| `code` | source files, configs, schemas |
| `structured-data` | CSV, JSON record lists, table dumps |
| `multimodal` | content with images, video frames, audio |

## Six ingest strategies

| Strategy | What it writes | Cost (illustrative) |
|---|---|---:|
| `raw-chunks` | turn/chunk traces with embeddings | $0.0001/ingest |
| `summarized` | session/document summary prefixed to every chunk | $0.005/ingest |
| `observational` | structured observation log replacing raw turns | $0.020/ingest |
| `fact-graph` | extracted fact triples + entity-relation graph | $0.015/ingest |
| `hybrid` | parallel raw + summarized + observational | $0.030/ingest |
| `skip` | content discarded; nothing written | $0 |

The `summarized` strategy implements Anthropic's "contextual retrieval" pattern (every chunk prepended with a dense session/document summary before embedding). The `observational` strategy implements Mastra's Observational Memory pattern (LLM-extracted observation log). The `fact-graph` strategy stores extracted typed facts plus an entity-relation graph at retrieval time — used by Hindsight (typed network of World, Experience, Opinion, Observation) and the original Mem0 v2 design. Mem0 v3 (Mar 2026) dropped its graph store in favor of single-pass ADD-only extraction with multi-signal hybrid search; the `fact-graph` ID here remains valid for systems that still want a queryable fact graph.

## Four shipping presets

| Preset | Strategy mix | When to use |
|---|---|---|
| `raw-chunks` (default) | every kind → raw-chunks | high-volume / cost-sensitive workloads; retrieval does the work |
| `summarized` | long-* and code → summarized; short stays raw | documents/conversations with global context that aids recall |
| `observational` | long-conversation → observational; long-article → summarized | conversational workloads with multi-session synthesis questions |
| `hybrid` | long-* → hybrid; short stays raw | cost-tolerant workloads with heterogeneous retrieval needs |

## Quickstart

```ts
import {
  LLMIngestClassifier,
  IngestRouter,
  FunctionIngestDispatcher,
} from '@framers/agentos/ingest-router';

// Stand-ins for the host-side dispatchers and the LLM adapter the
// classifier delegates to. Replace `openaiAdapter` with whatever LLM
// adapter your runtime exposes (`OpenAIProviderAdapter`, etc.) and
// implement each dispatch fn against your real ingest pipelines.
declare const openaiAdapter: any;
declare const content: string;
async function rawIngest(_c: string)        { return 0; }
async function summarizedIngest(_c: string) { return 0; }
async function omIngest(_c: string)         { return 0; }
async function factGraphIngest(_c: string)  { return 0; }
async function hybridIngest(_c: string)     { return 0; }

const router = new IngestRouter({
  classifier: new LLMIngestClassifier({ llm: openaiAdapter }),
  preset: 'summarized',
  budget: { perIngestUsd: 0.01, mode: 'cheapest-fallback' },
  dispatcher: new FunctionIngestDispatcher<{ writtenTraces: number }>({
    'raw-chunks': async (content) => ({ writtenTraces: await rawIngest(content) }),
    summarized: async (content) => ({ writtenTraces: await summarizedIngest(content) }),
    observational: async (content) => ({ writtenTraces: await omIngest(content) }),
    'fact-graph': async (content) => ({ writtenTraces: await factGraphIngest(content) }),
    hybrid: async (content) => ({ writtenTraces: await hybridIngest(content) }),
    skip: async () => ({ writtenTraces: 0 }),
  }),
});

const { decision, outcome } = await router.decideAndDispatch(content);
console.log(decision.classifier.kind);          // 'long-conversation'
console.log(decision.routing.chosenStrategy);   // 'observational'
console.log(decision.routing.estimatedCostUsd); // 0.020
console.log(outcome.writtenTraces);             // 47
```

## Decision-only flow

```ts
const { classifier, routing } = await router.decide(content);

if (routing.chosenStrategy === 'summarized') {
  await mySummarizeAndStore(content);
} else if (routing.chosenStrategy === 'skip') {
  return; // content not worth storing
}
```

## Manual kind override

When the caller already knows the content kind (file extension determines code, payload metadata says it's structured data), skip the classifier:

```ts
const decision = await router.decide(content, {
  manualKind: 'code',
});
// classifier is not invoked; routing table consulted with 'code' directly.
```

## Budget-aware dispatch

```ts
const router = new IngestRouter({
  classifier,
  preset: 'observational',
  budget: {
    perIngestUsd: 0.005,
    mode: 'cheapest-fallback',  // silently fall back to summarized or raw-chunks
  },
});
```

Three modes (same as MemoryRouter): `hard` / `soft` / `cheapest-fallback`. The default is `cheapest-fallback` for production safety.

## Few-shot classifier prompt

For ambiguous content (a long email vs a long article; structured data vs code), use the few-shot variant:

```ts
const router = new IngestRouter({
  classifier,
  preset: 'observational',
  useFewShotPrompt: true,
});
```

## API surface

- [`IngestContentKind`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/routing-tables.ts), [`IngestStrategyId`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/routing-tables.ts), [`IngestRouterPreset`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/routing-tables.ts), [`IngestRoutingTable`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/routing-tables.ts)
- [`INGEST_CONTENT_KINDS`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/routing-tables.ts)
- [`RAW_CHUNKS_TABLE`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/routing-tables.ts), [`SUMMARIZED_TABLE`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/routing-tables.ts), [`OBSERVATIONAL_TABLE`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/routing-tables.ts), [`HYBRID_TABLE`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/routing-tables.ts), [`PRESET_INGEST_TABLES`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/routing-tables.ts)
- [`IngestStrategyCostPoint`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/costs.ts), [`DEFAULT_INGEST_COSTS`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/costs.ts), plus per-strategy constants
- [`selectIngestStrategy`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/select-strategy.ts) (pure function)
- [`IngestRoutingDecision`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/select-strategy.ts), [`IngestRouterConfig`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/select-strategy.ts), [`IngestBudgetMode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/select-strategy.ts)
- [`IIngestClassifier`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/classifier.ts), [`IIngestClassifierLLM`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/classifier.ts), [`LLMIngestClassifier`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/classifier.ts)
- [`INGEST_CLASSIFIER_SYSTEM_PROMPT`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/classifier.ts), [`INGEST_CLASSIFIER_SYSTEM_PROMPT_FEWSHOT`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/classifier.ts)
- [`IIngestDispatcher`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/dispatcher.ts), [`FunctionIngestDispatcher`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/dispatcher.ts)
- [`IngestRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/IngestRouter.ts), [`IngestRouterOptions`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/IngestRouter.ts), [`IngestRouterDecideOptions`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/IngestRouter.ts), [`IngestRouterDispatchedResult`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/IngestRouter.ts)
- Errors: [`IngestRouterUnknownKindError`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/select-strategy.ts), [`IngestRouterBudgetExceededError`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/select-strategy.ts), [`UnsupportedIngestStrategyError`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/dispatcher.ts), [`IngestRouterDispatcherMissingError`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/ingest/IngestRouter.ts)

## Calibration

The shipping cost-points are illustrative averages on a typical OpenAI stack. For workloads with very different ingest profiles (heavy observation extraction, custom triple-extraction LLM), supply your own `strategyCosts` map at construction.

## Related

- [Cognitive Pipeline](./COGNITIVE_PIPELINE.md) — composition primitive
- [Memory Router](./MEMORY_ROUTER.md) — recall stage sibling
- [Read Router](./READ_ROUTER.md) — read stage sibling
- [Memory Operations](./MEMORY_OPERATIONS.md#auto-ingest-pipeline) — the underlying auto-ingest primitives this router orchestrates
- [Memory Document Ingestion](./MEMORY_DOCUMENT_INGESTION.md) — document-mode ingest pipeline
