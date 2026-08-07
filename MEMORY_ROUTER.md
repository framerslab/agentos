# Memory Router

Stage 2 of the [Classifier-Driven Memory Pipeline](./COGNITIVE_PIPELINE.md). Recall-stage smart orchestrator. Picks the best memory-recall architecture per query, classifier-driven dispatch across `canonical-hybrid`, `observational-memory-v10`, and `observational-memory-v11` backends. Sibling primitives: [Query Classifier](./QUERY_ROUTER.md) (Stage 1, the memory-or-not gate), [Reader Router](./READ_ROUTER.md) (Stage 3, the reader-tier dispatch), [Ingest Router](./INGEST_ROUTER.md) (input stage).

The 2026-04-28 v1 publication's validated deployed-config headline pairs MemoryRouter (Stage 2) with the [ReaderRouter](./READ_ROUTER.md) (Stage 3) and the `text-embedding-3-small` embedder: **85.6% [82.4%, 88.6%] at $0.0090/correct, 4 second avg latency on LongMemEval-S Phase B N=500**. Beats Mastra OM gpt-4o (84.2% published) on accuracy. Beats EmergenceMem Simple Fast (80.6% measured apples-to-apples in our harness — public reference repo at `github.com/EmergenceAI/emergence_simple_fast` ships with no LICENSE) by +5.0 pp accuracy at 6.5× lower cost-per-correct. Statistically tied with EmergenceMem **Internal** (86.0% point estimate, sitting inside our 95% CI), but Emergence's 86.0% number is produced by **closed-source SaaS at [emergence.ai/web-automation-api](https://www.emergence.ai/web-automation-api) — it is not a library you can install**. AgentOS ships the full architecture under [Apache-2.0](https://github.com/framerslab/agentos/blob/master/LICENSE).

The MemoryRouter primitive itself ships three calibrated presets (`maximize-accuracy`, `balanced`, `minimize-cost`). The earlier shipping headline at 76.6% [72.8, 80.2] / $0.058/correct ran against `CharHashEmbedder` (the bench's "no embedder configured" fallback). The +9 pp lift to the current 85.6% number came from (1) wiring `text-embedding-3-small` as the embedder, the documented production path, and (2) dropping the `minimize-cost` preset's MS+SSP → OM-v11 routing in favor of canonical-hybrid for all categories paired with ReaderRouter (see [Tier 3 minimize-cost staleness for sem-embed deployments](#tier-3-minimize-cost-staleness-for-sem-embed-deployments) below).

## What it actually does

Every memory-recall query goes through three steps:

1. A `gpt-5-mini`-style classifier reads the query and emits a [`MemoryQueryCategory`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/routing-tables.ts) (one of six: single-session-user, single-session-assistant, single-session-preference, knowledge-update, multi-session, temporal-reasoning).
2. The pure [`selectBackend`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/select-backend.ts) function maps that category to a backend choice using the configured routing table (one of three shipping presets, or your own).
3. An optional dispatcher executes the backend against your `Memory` instance.

The classifier call is ~$0.0002 per query. The routing decision saves dollars by picking canonical-hybrid (cheap, accurate on most categories) instead of paying the OM premium on every query, while still routing multi-session synthesis questions to the OM backends where the architectural lift earns the cost.

## Why route at all

Per-category Phase B N=500 measurements show different memory architectures dominate different categories:

| Category | canonical-hybrid | OM-v10 | OM-v11 |
|---|---:|---:|---:|
| single-session-user | 97.1% / $0.019 | 97.1% / $0.021 | 98.6% / $0.021 |
| single-session-assistant | 89.3% / $0.018 | 83.9% / $0.020 | 83.9% / $0.019 |
| single-session-preference | 60.0% / $0.021 | 60.0% / $0.021 | 63.3% / $0.021 |
| knowledge-update | 86.8% / $0.019 | 85.9% / $0.031 | 87.2% / $0.031 |
| multi-session | 54.9% / $0.020 | 60.2% / $0.031 | **61.7% / $0.034** |
| temporal-reasoning | 70.2% / $0.020 | 71.0% / $0.021 | 69.2% / $0.021 |

Numbers above are accuracy / per-call USD. The flat "always canonical" pipeline costs accuracy on multi-session (-6.8pp). The flat "always OM-v11" pipeline costs accuracy on single-session-assistant (-5.4pp) and pays a 1.7-1.8x cost premium on every other category. Per-query routing extracts the best of both.

## Six query categories

```ts
type MemoryQueryCategory =
  | 'single-session-user'
  | 'single-session-assistant'
  | 'single-session-preference'
  | 'knowledge-update'
  | 'multi-session'
  | 'temporal-reasoning';
```

The taxonomy is calibrated from LongMemEval-S. Each category captures a distinct memory-recall pattern; the classifier is trained to discriminate between them via a discriminator prompt (with optional few-shot variant for harder cases like SSU-vs-SSA confusion).

## Three backend identifiers

```ts
type MemoryBackendId =
  | 'canonical-hybrid'              // BM25 + dense + Cohere rerank-v3.5
  | 'observational-memory-v10'      // synthesized observation log + dynamic OM router
  | 'observational-memory-v11';     // v10 + conditional verbatim citation rule
```

Backend execution itself lives in the dispatcher (consumer-supplied). MemoryRouter only DECIDES; it doesn't execute. This split lets you wire the dispatcher to your existing HybridRetriever / OM pipeline / custom retriever without touching this module.

## Three shipping presets

| Preset | Strategy | Phase B Result | When to use |
|---|---|---|---|
| `minimize-cost` (default) | Cheapest Pareto-dominant per category. Pay OM premium only on MS + SSP. | 76.6% [72.8, 80.2] at **$0.0580/correct**, 16s avg | Cost-sensitive workloads. The shipping default. |
| `balanced` | Trade 1.6x cost for 10x latency wins on KU/TR | 74.5% / $0.205/correct (sim) | Interactive UX where latency matters |
| `maximize-accuracy` | Highest-accuracy backend per category | 75.6% [71.8, 79.2] at $0.2434/correct, 66s avg | Accuracy-sensitive with moderate cost tolerance |

## Quickstart

```ts
import {
  LLMMemoryClassifier,
  MemoryRouter,
  FunctionMemoryDispatcher,
} from '@framers/agentos/memory-router';
import type { ScoredTrace } from '@framers/agentos/memory';

// Stand-ins. Replace `openaiAdapter` with whatever LLM adapter your runtime
// exposes; replace `memory` / `omV10` / `omV11` / `query` with the real
// memory backends and the user query string.
declare const openaiAdapter: any;
declare const memory: any;
declare const omV10: any;
declare const omV11: any;
declare const query: string;

const router = new MemoryRouter({
  classifier: new LLMMemoryClassifier({ llm: openaiAdapter }),
  preset: 'minimize-cost',
  budget: { perQueryUsd: 0.05, mode: 'cheapest-fallback' },
  dispatcher: new FunctionMemoryDispatcher<ScoredTrace, { topK: number }>({
    'canonical-hybrid': async (q, { topK }) =>
      memory.recall(q, { limit: topK }),
    'observational-memory-v10': async (q, { topK }) =>
      omV10.recall(q, { limit: topK }),
    'observational-memory-v11': async (q, { topK }) =>
      omV11.recall(q, { limit: topK }),
  }),
});

const { decision, traces, backend } = await router.decideAndDispatch(
  query,
  { topK: 10 },
);
console.log(decision.classifier.category);          // 'multi-session'
console.log(backend);                               // 'observational-memory-v11'
console.log(decision.routing.estimatedCostUsd);     // 0.0336
console.log(decision.routing.chosenBackendReason);  // 'routing-table pick fits budget'
```

## Decision-only flow

If you'd rather execute the backend yourself, use `decide()`:

```ts
const { classifier, routing } = await router.decide(query);

if (routing.chosenBackend === 'canonical-hybrid') {
  const traces = await memory.recall(query, { limit: 10 });
  // your custom logic
}
```

## Budget-aware dispatch

```ts
const router = new MemoryRouter({
  classifier,
  preset: 'maximize-accuracy',
  budget: {
    perQueryUsd: 0.025,
    mode: 'cheapest-fallback',
  },
});
```

Three modes:

- **hard**: throw [`MemoryRouterBudgetExceededError`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/select-backend.ts) when the routing-table pick exceeds the ceiling. Production code catches and escalates.
- **soft**: keep the picked backend when it has better $/correct than the cheapest backend that fits, even if it exceeds the budget. Prefers accuracy-economical overruns.
- **cheapest-fallback** (default): silently downgrade to the cheapest backend that fits. If no backend fits, pick the globally cheapest and flag `budgetExceeded: true` in the decision.

## Custom routing table or per-category override

```ts
const router = new MemoryRouter({
  classifier,
  preset: 'balanced',
  routingTable: {
    preset: 'balanced',
    defaultMapping: {
      'single-session-assistant': 'canonical-hybrid',
      'single-session-user': 'canonical-hybrid',
      'single-session-preference': 'canonical-hybrid',
      'knowledge-update': 'canonical-hybrid',
      'multi-session': 'canonical-hybrid',  // override: skip OM premium
      'temporal-reasoning': 'canonical-hybrid',
    },
  },
});

// Or patch a single category:
const router2 = new MemoryRouter({
  classifier,
  preset: 'maximize-accuracy',
  mapping: {
    'single-session-preference': 'canonical-hybrid',
  },
});
```

## Few-shot classifier prompt

For deployments where SSU-vs-SSA, SSP-vs-SSA, MS-vs-KU confusion costs accuracy, use the few-shot variant:

```ts
const router = new MemoryRouter({
  classifier,
  preset: 'minimize-cost',
  useFewShotPrompt: true,
});

// or per-call
await router.decide(query, { useFewShotPrompt: true });
```

## API surface

- [`MemoryQueryCategory`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/routing-tables.ts), [`MemoryBackendId`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/routing-tables.ts), [`MemoryRouterPreset`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/routing-tables.ts), [`RoutingTable`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/routing-tables.ts)
- [`MEMORY_QUERY_CATEGORIES`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/routing-tables.ts) — the six-category tuple
- [`MINIMIZE_COST_TABLE`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/routing-tables.ts), [`BALANCED_TABLE`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/routing-tables.ts), [`MAXIMIZE_ACCURACY_TABLE`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/routing-tables.ts), [`PRESET_TABLES`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/routing-tables.ts)
- [`MemoryBackendCostPoint`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/backend-costs.ts), [`DEFAULT_MEMORY_BACKEND_COSTS`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/backend-costs.ts), [`TIER_1_CANONICAL_COSTS`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/backend-costs.ts), [`TIER_2A_V10_COSTS`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/backend-costs.ts), [`TIER_2B_V11_COSTS`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/backend-costs.ts)
- [`selectBackend`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/select-backend.ts) (pure function)
- [`MemoryRoutingDecision`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/select-backend.ts), [`MemoryRouterConfig`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/select-backend.ts), [`MemoryBudgetMode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/select-backend.ts)
- [`IMemoryClassifier`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/classifier.ts), [`IMemoryClassifierLLM`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/classifier.ts), [`LLMMemoryClassifier`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/classifier.ts)
- [`CLASSIFIER_SYSTEM_PROMPT`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/classifier.ts), [`CLASSIFIER_SYSTEM_PROMPT_FEWSHOT`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/classifier.ts), [`SAFE_FALLBACK_CATEGORY`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/classifier.ts)
- [`IMemoryDispatcher`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/dispatcher.ts), [`FunctionMemoryDispatcher`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/dispatcher.ts)
- [`MemoryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/MemoryRouter.ts), [`MemoryRouterOptions`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/MemoryRouter.ts), [`MemoryRouterDecideOptions`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/MemoryRouter.ts), [`MemoryRouterDecision`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/MemoryRouter.ts), [`MemoryRouterDispatchedDecision`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/MemoryRouter.ts)
- Errors: [`MemoryRouterUnknownCategoryError`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/select-backend.ts), [`MemoryRouterBudgetExceededError`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/select-backend.ts), [`MemoryRouterDispatcherMissingError`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/MemoryRouter.ts), [`UnsupportedMemoryBackendError`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/dispatcher.ts)

## Methodology + numbers

The shipping cost-points in [`DEFAULT_MEMORY_BACKEND_COSTS`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/backend-costs.ts) come from LongMemEval-S Phase B N=500 run JSONs in `packages/agentos-bench/results/runs/`. Each entry's per-category accuracy/cost/latency is from a real benchmark sweep at `gpt-4o` reader, `gpt-4o-2024-08-06` judge, `rubricVersion 2026-04-18.1`, seed=42, with bootstrap 95% CIs and a published 1% [0%, 3%] judge false-positive rate.

For workloads whose cost/accuracy profile diverges from LongMemEval-S, see [Adaptive Memory Router](./ADAPTIVE_MEMORY_ROUTER.md) — derives the routing table from your own calibration data instead of relying on Phase B presets.

## Tier 3 minimize-cost staleness for sem-embed deployments

The `minimize-cost` preset's routing table sends `multi-session` and `single-session-preference` cases to the `observational-memory-v11` backend. That table was calibrated on Phase B data measured against `CharHashEmbedder` (recall@10 around 0.62 on canonical-hybrid). With `text-embedding-3-small` the canonical-hybrid recall@10 lifts to 0.981, and the per-category accuracy story changes:

At gpt-4o reader, dropping the OM-v11 routing produces a +1.0 pp aggregate lift (SSP gains 13.4 pp on canonical, MS loses 4 pp, case-weighted aggregate favors canonical). At gpt-5-mini reader (via [ReaderRouter](./READ_ROUTER.md)), OM-v11 routing for MS/SSP is statistically tied with canonical, but OM-v11 imposes a 60-120 second observer pipeline per OM-routed case (p95 latency 111 sec with the routing on, 7 sec with it off, a 15× tail-latency reduction by dropping it).

For new sem-embed deployments, the recommended config is **canonical-hybrid for all categories + [ReaderRouter](./READ_ROUTER.md) per-category reader-tier dispatch + `text-embedding-3-small` embedder**. This is the validated 85.6% headline. The `minimize-cost` preset's table will be re-derived from sem-embed Phase B data in v2.

Existing CharHash-era deployments using `minimize-cost` continue to work (no breaking change in the API), but the 76.6% headline they validate against is the older bench-default-fallback number. Migrating to sem-embed embedder + dropping the policy-router preset (using canonical-hybrid directly) + adding ReaderRouter is a +9 pp accuracy lift at lower cost and faster latency.

## Related

- [Cognitive Pipeline](./COGNITIVE_PIPELINE.md) - the three-stage classifier dispatch this fits inside
- [Query Router](./QUERY_ROUTER.md) - Stage 1, the memory-or-not gate
- [Reader Router](./READ_ROUTER.md) - Stage 3, the reader-tier dispatch
- [Ingest Router](./INGEST_ROUTER.md) - input stage sibling
- [Read Router](./READ_ROUTER.md) - read stage sibling
- [Adaptive Memory Router](./ADAPTIVE_MEMORY_ROUTER.md) - self-calibrating extension
- [Cognitive Memory](./COGNITIVE_MEMORY.md) - the storage substrate canonical-hybrid retrieves from
- [HyDE Retrieval](./HYDE_RETRIEVAL.md) - alternate retrieval strategy MemoryRouter can dispatch to
- [agentos-bench](https://github.com/framerslab/agentos-bench) - reproducible run JSONs, full transparency stack
