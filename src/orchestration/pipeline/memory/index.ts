/**
 * AgentOS MemoryRouter Module
 *
 * LLM-as-judge orchestrator that picks the best memory-recall architecture
 * per query, with budget-aware dispatch across {canonical-hybrid,
 * observational-memory-v10, observational-memory-v11} backends.
 *
 * **Architecture Overview:**
 * ```
 * ┌────────────────────────────────────────────────────────────────────┐
 * │                          MemoryRouter                              │
 * │   Orchestrates classification + routing-table dispatch + optional  │
 * │   backend execution (via IMemoryDispatcher)                        │
 * └────────────────────────────────────────────────────────────────────┘
 *                                │
 *         ┌──────────────────────┼────────────────────────┐
 *         ▼                      ▼                        ▼
 *  ┌───────────────┐    ┌─────────────────┐    ┌───────────────────┐
 *  │ IMemoryClassi-│    │ selectBackend   │    │ IMemoryDispatcher │
 *  │ fier          │    │ (pure, budget-  │    │ (optional exec)   │
 *  │ (LLM judge)   │    │  aware)         │    │                   │
 *  └───────────────┘    └─────────────────┘    └───────────────────┘
 *                                │
 *          ┌─────────────────────┼─────────────────────┐
 *          ▼                     ▼                     ▼
 * ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐
 * │ canonical-      │  │ observational-  │  │ observational-      │
 * │ hybrid          │  │ memory-v10      │  │ memory-v11          │
 * │ (BM25 + dense   │  │ (synth obs log  │  │ (v10 + verbatim     │
 * │  + any          │  │  + dyn router)  │  │  citation for       │
 * │  reranker)      │  │                 │  │  KU/SSU)            │
 * └─────────────────┘  └─────────────────┘  └─────────────────────┘
 * ```
 *
 * **Design principles:**
 *
 * 1. **Pure where possible.** `selectBackend` is a pure function: given a
 *    category + routing table + cost data, it produces a deterministic
 *    decision with no I/O. Suitable for use inside cache-key construction
 *    and hot dispatch loops.
 *
 * 2. **LLM-provider-agnostic.** The classifier talks to an adapter interface
 *    ({@link IMemoryClassifierLLM}) — there is NO SDK import inside this
 *    module. Wire any provider (OpenAI, Anthropic, local, mock) via the
 *    adapter.
 *
 * 3. **Dispatch is injected.** Backend execution depends on how the caller's
 *    memory state is wired (OM backends need ingest-time setup, canonical
 *    does not). The router decides; {@link IMemoryDispatcher} executes.
 *    Callers who only need canonical-hybrid can register one executor and
 *    ignore the others.
 *
 * 4. **Shipping presets.** Three routing tables (minimize-cost, balanced,
 *    maximize-accuracy) ship with costs calibrated from LongMemEval-S
 *    Phase B N=500. Consumers can override routing tables, cost-points, or
 *    per-category mappings for custom workloads.
 *
 * 5. **Budget-aware.** Optional per-query USD budget with three modes
 *    (hard / soft / cheapest-fallback) so production cost ceilings are
 *    enforceable without bespoke retry logic.
 *
 * @module @framers/agentos/memory-router
 *
 * @example Minimal usage: just decide, execute yourself.
 * ```ts
 * import {
 *   LLMMemoryClassifier,
 *   MemoryRouter,
 * } from '@framers/agentos/memory-router';
 *
 * const router = new MemoryRouter({
 *   classifier: new LLMMemoryClassifier({ llm: openaiAdapter }),
 *   preset: 'minimize-cost',
 * });
 *
 * const { classifier, routing } = await router.decide(query);
 * if (routing.chosenBackend === 'canonical-hybrid') {
 *   const traces = await mem.recall(query, { limit: 10 });
 *   // ...
 * }
 * ```
 *
 * @example Full pipeline: decide + dispatch.
 * ```ts
 * import {
 *   LLMMemoryClassifier,
 *   MemoryRouter,
 *   FunctionMemoryDispatcher,
 * } from '@framers/agentos/memory-router';
 *
 * const router = new MemoryRouter({
 *   classifier: new LLMMemoryClassifier({ llm: openaiAdapter }),
 *   preset: 'minimize-cost',
 *   budget: { perQueryUsd: 0.05, mode: 'cheapest-fallback' },
 *   dispatcher: new FunctionMemoryDispatcher<ScoredTrace, { topK: number }>({
 *     'canonical-hybrid': async (q, { topK }) =>
 *       mem.recall(q, { limit: topK }),
 *     'observational-memory-v10': async (q, p) =>
 *       await omPipelineV10.recall(q, p),
 *     'observational-memory-v11': async (q, p) =>
 *       await omPipelineV11.recall(q, p),
 *   }),
 * });
 *
 * const { decision, traces, backend } = await router.decideAndDispatch(
 *   query,
 *   { topK: 10 },
 * );
 * ```
 */

// ============================================================================
// Types (re-exported for convenience)
// ============================================================================

export type {
  MemoryQueryCategory,
  MemoryBackendId,
  MemoryRouterPreset,
  RoutingTable,
  AugmentedMemoryRouterPreset,
  AugmentedRoutingTable,
  MemoryDispatchKey,
} from './routing-tables.js';
export { MEMORY_QUERY_CATEGORIES } from './routing-tables.js';

export type { MemoryBackendCostPoint } from './backend-costs.js';

export type {
  MemoryBudgetMode,
  MemoryRouterConfig,
  MemoryRoutingDecision,
} from './select-backend.js';

export type {
  IMemoryClassifier,
  IMemoryClassifierLLM,
  MemoryClassifierLLMRequest,
  MemoryClassifierLLMResponse,
  MemoryClassifierClassifyOptions,
  MemoryClassifierResult,
  LLMMemoryClassifierOptions,
} from './classifier.js';

export type {
  IMemoryDispatcher,
  MemoryDispatchArgs,
  MemoryDispatchResult,
  MemoryBackendExecutor,
  MemoryBackendExecutorContext,
  MemoryBackendRegistry,
} from './dispatcher.js';

export type {
  MemoryBudgetPolicy,
  MemoryRouterOptions,
  MemoryRouterDecideOptions,
  MemoryRouterDecision,
  MemoryRouterDispatchedDecision,
  MemoryRouterAugmentedDecision,
  MemoryRouterAugmentedDispatchedDecision,
} from './MemoryRouter.js';

// ============================================================================
// Values
// ============================================================================

export {
  MINIMIZE_COST_TABLE,
  BALANCED_TABLE,
  MAXIMIZE_ACCURACY_TABLE,
  PRESET_TABLES,
  MINIMIZE_COST_AUGMENTED_TABLE,
  S_BEST_CAT_HYDE_MS_2026_04_28_TABLE,
  S_BEST_CAT_TOPK50_MULT5_MS_2026_04_29_TABLE,
  AUGMENTED_PRESET_TABLES,
  SAFE_FALLBACK_BACKEND,
  SAFE_FALLBACK_DISPATCH_KEY,
  selectAugmentedDispatch,
} from './routing-tables.js';

export {
  TIER_1_CANONICAL_COSTS,
  TIER_2A_V10_COSTS,
  TIER_2B_V11_COSTS,
  DEFAULT_MEMORY_BACKEND_COSTS,
} from './backend-costs.js';

export {
  selectBackend,
  MemoryRouterUnknownCategoryError,
  MemoryRouterBudgetExceededError,
} from './select-backend.js';

export {
  CLASSIFIER_SYSTEM_PROMPT,
  CLASSIFIER_SYSTEM_PROMPT_FEWSHOT,
  SAFE_FALLBACK_CATEGORY,
  LLMMemoryClassifier,
  normalizeClassifierOutput,
  parseClassifierOutput,
} from './classifier.js';

export {
  FunctionMemoryDispatcher,
  UnsupportedMemoryBackendError,
} from './dispatcher.js';

export {
  MemoryRouter,
  MemoryRouterDispatcherMissingError,
  MemoryRouterAugmentedTableMissingError,
} from './MemoryRouter.js';

// ============================================================================
// Self-calibrating adaptive router
// ============================================================================

export type {
  CalibrationSample,
  CalibrationCell,
  AggregatedCalibration,
  AdaptivePresetRule,
  SelectByPresetArgs,
  BuildAdaptiveRoutingTableArgs,
  AdaptiveMemoryRouterOptions,
} from './adaptive.js';

export {
  aggregateCalibration,
  selectByPreset,
  buildAdaptiveRoutingTable,
  AdaptiveMemoryRouter,
} from './adaptive.js';

// ============================================================================
// Reference recall-stage backends (Stage I: Mem0-v3-style entity-linking)
// ============================================================================

export {
  EntityRetrievalRanker,
  createEntityRetrievalRanker,
} from './backends/index.js';
export type {
  RankedCandidate,
  RankedCandidateWithBoost,
  EntityRetrievalRankerOptions,
} from './backends/index.js';

// ============================================================================
// RetrievalConfigRouter (per-query retrieval-config dispatch, calibrated
// from 2026-04-26 LongMemEval-M Phase A N=54 ablation matrix)
// ============================================================================

export {
  RETRIEVAL_CONFIG_IDS,
  RETRIEVAL_CONFIG_SPECS,
  M_PHASE_A_PER_CATEGORY_ACCURACY,
  M_PHASE_A_COST_PER_CORRECT,
  M_TUNED_PER_CATEGORY_TABLE,
  selectBestRetrievalConfig,
  computeOracleAggregate,
  computeOracleCostPerCorrect,
} from './retrieval-config.js';

export type {
  RetrievalConfigId,
  RetrievalConfigSpec,
} from './retrieval-config.js';

// ============================================================================
// ReaderRouter (per-query reader-tier dispatch, calibrated from
// 2026-04-28 LongMemEval-S Phase B N=500 per-category gpt-4o vs
// gpt-5-mini split)
// ============================================================================

export {
  MIN_COST_BEST_CAT_2026_04_28_TABLE as READER_MIN_COST_BEST_CAT_2026_04_28_TABLE,
  MIN_COST_BEST_CAT_GPT5_TR_2026_04_29_TABLE as READER_MIN_COST_BEST_CAT_GPT5_TR_2026_04_29_TABLE,
  READER_ROUTER_PRESET_TABLES,
  ReaderRouterUnknownCategoryError,
  ReaderRouterUnknownPresetError,
  selectReader,
} from './reader-router.js';

export type {
  ReaderTier,
  ReaderRouterPreset,
  ReaderRouterTable,
} from './reader-router.js';
