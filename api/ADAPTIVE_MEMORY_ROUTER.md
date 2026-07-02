# Adaptive Memory Router

Self-calibrating extension of [Memory Router](./MEMORY_ROUTER.md). Derives the routing table from a workload-specific calibration dataset instead of relying on the LongMemEval-S Phase B presets.

## When to use this

Use [`MemoryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/MemoryRouter.ts) directly with a shipping preset (`minimize-cost`, `balanced`, `maximize-accuracy`) when your workload is similar to LongMemEval-S — conversational memory with the six standard categories.

Use [`AdaptiveMemoryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/adaptive.ts) when:

1. Your category distribution diverges from LongMemEval-S (e.g., heavy on temporal, light on multi-session).
2. Your reader / judge / cost profile differs (different LLM, different judge rubric, different per-call cost).
3. You want the router to optimize for YOUR per-category cost-accuracy points instead of a static table baked from someone else's measurement.
4. You have a calibration dataset (or can collect one) — even ~50-200 samples per (category, backend) cell is enough.

## How it works

The adaptive router takes a list of calibration samples and a preset rule, then derives a routing table:

```ts
interface CalibrationSample {
  category: MemoryQueryCategory;
  backend: MemoryBackendId;
  costUsd: number;
  correct: number;  // 1 = correct, 0 = incorrect (or score in [0,1])
}
```

Three steps:

1. **Aggregate**: roll samples up by `(category, backend)` into mean cost + mean accuracy + sample count.
2. **Per-category select**: apply a preset rule per category to pick a backend.
3. **Build table**: assemble the per-category picks into a frozen [`RoutingTable`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/routing-tables.ts). Categories with insufficient calibration fall back to the static preset's default.

Three preset rules:

| Rule | What it picks |
|---|---|
| `minimize-cost` | cheapest backend within `accuracyTolerance` (default 2pp) of the best meanAccuracy on this category. If no backend is within tolerance, picks the best-accuracy backend (the gap exceeds tolerance, so accuracy gain justifies cost). |
| `balanced` | best $/correct ratio (meanCost / meanAccuracy). Backends with zero meanAccuracy are skipped to avoid div-by-zero. |
| `maximize-accuracy` | highest meanAccuracy backend; ties broken by lower meanCost. |

## Quickstart

```ts
import {
  AdaptiveMemoryRouter,
  LLMMemoryClassifier,
  FunctionMemoryDispatcher,
} from '@framers/agentos/memory-router';

// Collect calibration data from a Phase A sweep across your workload
// (sample queries dispatched to each candidate backend, scoring outcomes
// with your judge of choice).
const samples = [
  { category: 'multi-session', backend: 'canonical-hybrid', costUsd: 0.020, correct: 1 },
  { category: 'multi-session', backend: 'canonical-hybrid', costUsd: 0.020, correct: 0 },
  // ... ~50-200 per (category, backend) cell
];

// Stand-ins. Replace `openaiAdapter` with whatever LLM adapter your runtime
// exposes; replace each `myXxx` with the real per-backend retrieval impl.
declare const openaiAdapter: any;
async function myHybridRetrieve(_q: string, _p: any) { return [] as any[]; }
async function myOmV10Recall(_q: string, _p: any)    { return [] as any[]; }
async function myOmV11Recall(_q: string, _p: any)    { return [] as any[]; }

const router = new AdaptiveMemoryRouter({
  classifier: new LLMMemoryClassifier({ llm: openaiAdapter }),
  calibrationSamples: samples,
  preset: 'minimize-cost',
  minSamplesPerCell: 10,       // require at least 10 samples to use calibration; below that fall back to static preset
  accuracyTolerance: 0.02,     // for minimize-cost: 2pp accuracy gap tolerated when picking the cheaper alternative
  dispatcher: new FunctionMemoryDispatcher({
    'canonical-hybrid': async (q, p) => myHybridRetrieve(q, p),
    'observational-memory-v10': async (q, p) => myOmV10Recall(q, p),
    'observational-memory-v11': async (q, p) => myOmV11Recall(q, p),
  }),
});

// Inspect the derived table:
const derivedTable = router.getRoutingTable();
console.log(derivedTable.defaultMapping);
// {
//   'multi-session': 'observational-memory-v11',  // calibration-driven
//   'single-session-user': 'canonical-hybrid',    // calibration-driven
//   'single-session-assistant': 'canonical-hybrid',  // preset fallback (no data)
//   ...
// }

// Use it like any MemoryRouter:
const decision = await router.decide(query);
```

## Calibration data collection

For each candidate backend, run your workload through it on a Phase A subset:

1. Sample N queries from your workload (typically N ≈ 100-300 per category — stratified if some categories are rare).
2. Dispatch each query to each candidate backend.
3. Score each outcome with your judge.
4. Emit one [`CalibrationSample`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/adaptive.ts) per (query × backend × outcome) tuple.

Total spend: roughly N × 3 × per-backend-cost-per-query. For LongMemEval-S Phase A this was ~$30 per backend.

## Pure functions exposed

For consumers who want to do calibration analysis outside the router:

```ts
import {
  aggregateCalibration,
  selectByPreset,
  buildAdaptiveRoutingTable,
} from '@framers/agentos/memory-router';

// 1. Roll samples up.
const agg = aggregateCalibration(samples);
console.log(agg['multi-session']?.['canonical-hybrid']);
// { n: 156, meanCost: 0.0203, meanAccuracy: 0.547 }

// 2. Pick per category.
const backend = selectByPreset({
  category: 'multi-session',
  agg,
  preset: 'balanced',
  minSamplesPerCell: 10,
});

// 3. Build the full table directly.
const table = buildAdaptiveRoutingTable({
  samples,
  preset: 'maximize-accuracy',
  minSamplesPerCell: 20,
  accuracyTolerance: 0.025,
});
```

## API surface

- [`CalibrationSample`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/adaptive.ts), [`CalibrationCell`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/adaptive.ts), [`AggregatedCalibration`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/adaptive.ts)
- `AdaptivePresetRule = 'minimize-cost' | 'balanced' | 'maximize-accuracy'`
- [`aggregateCalibration`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/adaptive.ts) — pure aggregator
- [`selectByPreset`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/adaptive.ts) — pure per-category selector
- [`buildAdaptiveRoutingTable`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/adaptive.ts) — pure full-table constructor
- [`AdaptiveMemoryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/adaptive.ts) — class extending [`MemoryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/MemoryRouter.ts) with calibration-derived table
- [`AdaptiveMemoryRouterOptions`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/adaptive.ts), [`SelectByPresetArgs`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/adaptive.ts), [`BuildAdaptiveRoutingTableArgs`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/adaptive.ts)

## Related

- [Memory Router](./MEMORY_ROUTER.md) — base primitive
- [Cognitive Pipeline](./COGNITIVE_PIPELINE.md) — composition that uses MemoryRouter as the recall stage
- [Evaluation Framework](./EVALUATION_FRAMEWORK.md) — for collecting calibration data via your existing eval harness
