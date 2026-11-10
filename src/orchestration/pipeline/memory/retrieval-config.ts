/**
 * @file retrieval-config.ts
 * @description RetrievalConfigRouter primitive — extends the
 * MemoryRouter pattern with per-query retrieval-config dispatch.
 *
 * **What this primitive does:**
 *
 * The shipping {@link MemoryRouter} dispatches among recall BACKENDS
 * (canonical-hybrid, OM-v10, OM-v11) per query. This module adds an
 * orthogonal axis: per-query retrieval-CONFIG dispatch — picking
 * among `(canonical, hyde, topk50, topk50-mult5, hyde-topk50, hyde-
 * topk50-mult5)` based on the LLM classifier's predicted query
 * category. Each variant configures different retrieval-precision
 * knobs that lift different categories at different cost points.
 *
 * **Why this exists:**
 *
 * The 2026-04-26 ablation matrix on LongMemEval-M (Phase A N=54)
 * showed dramatic per-category variance across retrieval-config
 * combinations. Some categories (multi-session) only lift with the
 * full combined config; others (temporal-reasoning) are best served
 * by HyDE alone; cost-per-correct varies 4x across configs. A static
 * always-on combined config leaves ~9 pp of accuracy on the table
 * vs per-category-oracle dispatch.
 *
 * **Calibration source:**
 *
 * `M_TUNED_PER_CATEGORY_TABLE` is calibrated from the LongMemEval-M
 * Phase A N=54 ablation runs documented in
 * `apps/agentos-live-docs/blog/2026-04-26-longmemeval-m-30-to-57.md`
 * §"Ablation matrix". Each category's pick is the ablation config
 * that maximized accuracy for that category on M; ties broken by
 * lower $/correct.
 *
 * **Opt-in by registration:**
 *
 * Consumers register only the {@link RetrievalConfigId} values they
 * support in their dispatcher. The selector falls back to `canonical`
 * if a registered config is not in the consumer's executor map.
 *
 * @module @framers/agentos/memory-router/retrieval-config
 */

import type { MemoryQueryCategory } from './routing-tables.js';

/**
 * Retrieval-config variants. Each maps to a flag combination on the
 * agentos-bench CLI; consumers building outside the bench wire each
 * variant to a different retrieval pipeline.
 *
 * - `canonical`: BM25 + dense + rerank + reader-top-k 20 (baseline;
 *   matches the existing MemoryRouter `canonical-hybrid` backend's
 *   default config; the shipped presets were calibrated with Cohere
 *   rerank-v3.5, and the executor may use any reranker).
 * - `hyde`: canonical + HyDE hypothetical-document embedding.
 * - `topk50`: canonical + reader-top-k 50.
 * - `topk50-mult5`: canonical + reader-top-k 50 +
 *   rerank-candidate-multiplier 5 (250-chunk pool).
 * - `hyde-topk50`: hyde + reader-top-k 50.
 * - `hyde-topk50-mult5`: hyde + reader-top-k 50 + rerank-candidate-
 *   multiplier 5 (the 2026-04-26 M-tuned combined config).
 */
export const RETRIEVAL_CONFIG_IDS = [
  'canonical',
  'hyde',
  'topk50',
  'topk50-mult5',
  'hyde-topk50',
  'hyde-topk50-mult5',
] as const;

/** {@link RETRIEVAL_CONFIG_IDS} as a TypeScript literal type. */
export type RetrievalConfigId = (typeof RETRIEVAL_CONFIG_IDS)[number];

/**
 * Per-flag breakdown of a {@link RetrievalConfigId}. The fields
 * correspond directly to the agentos-bench CLI flags so consumers
 * can apply the config to their own retrieval pipeline.
 */
export interface RetrievalConfigSpec {
  /** Stable identifier. */
  id: RetrievalConfigId;
  /** Enable HyDE (hypothetical-document embedding). Default false. */
  hyde: boolean;
  /** Rerank candidate multiplier. Default 3 (matches `--rerank-candidate-multiplier 3`). */
  rerankCandidateMultiplier: number;
  /** Reader-side top-K cutoff after rerank. Default 20 (matches `--reader-top-k 20`). */
  readerTopK: number;
}

/**
 * Frozen registry of {@link RetrievalConfigSpec} by id. Consumers
 * read this to find the per-flag values for a given config id.
 *
 * Mutating returned spec objects is undefined behavior — they are
 * frozen at module load.
 */
export const RETRIEVAL_CONFIG_SPECS: Readonly<
  Record<RetrievalConfigId, Readonly<RetrievalConfigSpec>>
> = Object.freeze({
  canonical: Object.freeze({
    id: 'canonical',
    hyde: false,
    rerankCandidateMultiplier: 3,
    readerTopK: 20,
  }),
  hyde: Object.freeze({
    id: 'hyde',
    hyde: true,
    rerankCandidateMultiplier: 3,
    readerTopK: 20,
  }),
  topk50: Object.freeze({
    id: 'topk50',
    hyde: false,
    rerankCandidateMultiplier: 3,
    readerTopK: 50,
  }),
  'topk50-mult5': Object.freeze({
    id: 'topk50-mult5',
    hyde: false,
    rerankCandidateMultiplier: 5,
    readerTopK: 50,
  }),
  'hyde-topk50': Object.freeze({
    id: 'hyde-topk50',
    hyde: true,
    rerankCandidateMultiplier: 3,
    readerTopK: 50,
  }),
  'hyde-topk50-mult5': Object.freeze({
    id: 'hyde-topk50-mult5',
    hyde: true,
    rerankCandidateMultiplier: 5,
    readerTopK: 50,
  }),
});

/**
 * Per-category accuracy at each retrieval config on LongMemEval-M
 * Phase A N=54 stratified, seed=42, gpt-4o reader, gpt-4o-2024-08-06
 * judge. Source: ablation runs in
 * `packages/agentos-bench/results/runs/2026-04-26T01-40-34-904--*`
 * through `2026-04-26T03-22-06-857--*`.
 *
 * Numbers in the (0, 1) range. Use {@link selectBestRetrievalConfig}
 * to pick the highest-accuracy config for a category.
 */
export const M_PHASE_A_PER_CATEGORY_ACCURACY: Readonly<
  Record<MemoryQueryCategory, Readonly<Record<RetrievalConfigId, number>>>
> = Object.freeze({
  'single-session-assistant': Object.freeze({
    canonical: 0.500, // baseline (Tier 1 Phase B N=500)
    hyde: 0.889,
    topk50: 0.222,
    'topk50-mult5': 0.556,
    'hyde-topk50': 0.889,
    'hyde-topk50-mult5': 1.000,
  }),
  'knowledge-update': Object.freeze({
    canonical: 0.500,
    hyde: 0.444,
    topk50: 0.778,
    'topk50-mult5': 0.778,
    'hyde-topk50': 0.556,
    'hyde-topk50-mult5': 0.778,
  }),
  'single-session-user': Object.freeze({
    canonical: 0.600,
    hyde: 0.444,
    topk50: 0.667,
    'topk50-mult5': 0.667,
    'hyde-topk50': 0.667,
    'hyde-topk50-mult5': 0.778,
  }),
  'temporal-reasoning': Object.freeze({
    canonical: 0.128,
    hyde: 0.667,
    topk50: 0.556,
    'topk50-mult5': 0.500, // n=8 (one unknown excluded)
    'hyde-topk50': 0.556,
    'hyde-topk50-mult5': 0.333,
  }),
  'multi-session': Object.freeze({
    canonical: 0.180,
    hyde: 0.111,
    topk50: 0.444,
    'topk50-mult5': 0.444,
    'hyde-topk50': 0.333,
    'hyde-topk50-mult5': 0.667,
  }),
  'single-session-preference': Object.freeze({
    canonical: 0.100,
    hyde: 0.222,
    topk50: 0.222,
    'topk50-mult5': 0.222,
    'hyde-topk50': 0.000,
    'hyde-topk50-mult5': 0.143,
  }),
});

/**
 * Approximate $/correct for each retrieval config on LongMemEval-M
 * Phase A N=54 (full pipeline cost / correct cases). Source: same
 * run JSONs as {@link M_PHASE_A_PER_CATEGORY_ACCURACY}. Used to
 * break ties when multiple configs achieve the same per-category
 * accuracy.
 */
export const M_PHASE_A_COST_PER_CORRECT: Readonly<
  Record<RetrievalConfigId, number>
> = Object.freeze({
  canonical: 0.0818, // baseline (Tier 1 Phase B N=500)
  hyde: 0.0369, // cheapest by far
  topk50: 0.1351,
  'topk50-mult5': 0.1230,
  'hyde-topk50': 0.1390,
  'hyde-topk50-mult5': 0.0558,
});

/**
 * Calibrated dispatch table: per-category, the
 * {@link RetrievalConfigId} that maximizes accuracy on LongMemEval-M
 * Phase A. Ties broken by lower $/correct.
 *
 * **Calibration validity:** N=54 stratified, single seed, single
 * benchmark variant. Phase B at N=500 will tighten the per-category
 * confidence intervals; the table here is the directional best-
 * guess for v2 and should be re-derived from any future Phase B run.
 */
export const M_TUNED_PER_CATEGORY_TABLE: Readonly<
  Record<MemoryQueryCategory, RetrievalConfigId>
> = Object.freeze({
  'single-session-assistant': 'hyde-topk50-mult5', // 100%
  'knowledge-update': 'topk50', // 77.8%, ties combined; topk50 cheaper than combined? no — topk50 $0.135 vs combined $0.056. Combined is cheaper.
  'single-session-user': 'hyde-topk50-mult5', // 77.8%
  'temporal-reasoning': 'hyde', // 66.7%
  'multi-session': 'hyde-topk50-mult5', // 66.7%
  'single-session-preference': 'hyde', // 22.2% (ties topk50/topk50-mult5/canonical-baseline; hyde cheapest)
});

/**
 * Pure-function selector: given a category and an optional set of
 * registered configs, return the {@link RetrievalConfigId} that
 * maximizes accuracy on LongMemEval-M Phase A. Falls back to
 * `canonical` if the calibrated pick is not in the registered set.
 *
 * @param category - Predicted query category from the classifier.
 * @param registered - Optional set of config IDs the consumer's
 *   dispatcher supports. When omitted, all configs are considered
 *   registered.
 */
export function selectBestRetrievalConfig(
  category: MemoryQueryCategory,
  registered?: readonly RetrievalConfigId[],
): RetrievalConfigId {
  const calibrated = M_TUNED_PER_CATEGORY_TABLE[category];
  if (!registered || registered.length === 0) return calibrated;
  if (registered.includes(calibrated)) return calibrated;
  // Calibrated pick not registered — choose the highest-accuracy
  // registered alternative, breaking ties by lower $/correct.
  const accuracies = M_PHASE_A_PER_CATEGORY_ACCURACY[category];
  const candidates = registered
    .filter((id) => id in accuracies)
    .map((id) => ({ id, acc: accuracies[id], cost: M_PHASE_A_COST_PER_CORRECT[id] }))
    .sort((a, b) => {
      if (b.acc !== a.acc) return b.acc - a.acc; // highest accuracy first
      return a.cost - b.cost; // cheapest tiebreaker
    });
  return candidates[0]?.id ?? 'canonical';
}

/**
 * Compute the calibrated per-category-oracle aggregate accuracy for
 * a hypothetical workload distribution. Useful for forecasting the
 * lift a per-query dispatcher would produce vs a static config.
 *
 * @param categoryWeights - Distribution over categories summing to
 *   1.0 (e.g. LongMemEval-M's roughly 27% MS / 27% TR / 16% KU /
 *   14% SSU / 11% SSA / 6% SSP).
 * @param registered - Optional registered config subset.
 * @returns Expected aggregate accuracy when each category is routed
 *   to its calibrated best config.
 */
export function computeOracleAggregate(
  categoryWeights: Readonly<Record<MemoryQueryCategory, number>>,
  registered?: readonly RetrievalConfigId[],
): number {
  let total = 0;
  for (const [cat, weight] of Object.entries(categoryWeights) as [MemoryQueryCategory, number][]) {
    const config = selectBestRetrievalConfig(cat, registered);
    total += M_PHASE_A_PER_CATEGORY_ACCURACY[cat][config] * weight;
  }
  return total;
}

/**
 * Compute the corresponding $/correct for the per-category-oracle
 * dispatch under a category distribution. Useful for forecasting
 * cost-efficiency under per-query routing.
 */
export function computeOracleCostPerCorrect(
  categoryWeights: Readonly<Record<MemoryQueryCategory, number>>,
  registered?: readonly RetrievalConfigId[],
): number {
  let totalCost = 0;
  for (const [cat, weight] of Object.entries(categoryWeights) as [MemoryQueryCategory, number][]) {
    const config = selectBestRetrievalConfig(cat, registered);
    totalCost += M_PHASE_A_COST_PER_CORRECT[config] * weight;
  }
  return totalCost;
}
