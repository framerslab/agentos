/**
 * @file routing-tables.ts
 * @description Preset routing tables for {@link MemoryRouter}.
 *
 * The MemoryRouter dispatches each query to one of the available
 * {@link MemoryBackendId} backends based on the classifier-predicted
 * {@link MemoryQueryCategory}. The mapping from category to backend is a
 * "routing table" — a frozen object that callers can pass through unchanged
 * for the shipping defaults, or override per-category for custom workloads.
 *
 * Three preset tables ship out of the box, each calibrated from Phase B
 * N=500 LongMemEval-S measurements:
 *
 * - {@link MINIMIZE_COST_TABLE}: cheapest Pareto-dominant backend per
 *   category. Pays the OM premium only on multi-session and
 *   single-session-preference (the categories where the architectural lift
 *   exceeds the cost premium).
 * - {@link BALANCED_TABLE}: trades modest cost for large latency wins on
 *   knowledge-update and temporal-reasoning.
 * - {@link MAXIMIZE_ACCURACY_TABLE}: highest-accuracy backend per category;
 *   ties broken by cost. v2 (post-Phase-B-2026-04-24) routes
 *   temporal-reasoning back to canonical-hybrid after Phase B revealed the
 *   v1 routing's accuracy gain was within CI noise but paid OM ingest cost.
 *
 * **Augmented routing (2026-04-26):** The {@link AugmentedRoutingTable}
 * extends the basic dispatch contract with an orthogonal axis — a
 * per-category {@link RetrievalConfigId} pick — so the router can
 * dispatch on (backend × retrieval-config) rather than backend alone.
 * The {@link MINIMIZE_COST_AUGMENTED_TABLE} preset is calibrated from
 * the LongMemEval-M Phase A N=54 ablation matrix (2026-04-26).
 *
 * @module @framers/agentos/memory-router/routing-tables
 */

import type { RetrievalConfigId } from './retrieval-config.js';

// ============================================================================
// Public types
// ============================================================================

/**
 * The six question categories the LLM-as-judge classifier produces.
 * Calibrated from LongMemEval-S categories; mappings to other benchmark
 * taxonomies (e.g. LOCOMO single-hop / multi-hop / temporal /
 * open-domain / adversarial) are handled at adapter boundaries.
 */
export const MEMORY_QUERY_CATEGORIES = [
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'knowledge-update',
  'multi-session',
  'temporal-reasoning',
] as const;

/**
 * The six question categories the LLM-as-judge classifier produces.
 */
export type MemoryQueryCategory = (typeof MEMORY_QUERY_CATEGORIES)[number];

/**
 * The retrieval architecture identifiers the router can dispatch to.
 *
 * - `canonical-hybrid`: BM25 + dense + RRF fusion + rerank over the raw
 *   memory traces, run by the executor the host passes the dispatcher
 *   (the shipped presets were calibrated with Cohere rerank-v3.5; any
 *   reranker fits). The default cheapest-and-fastest path.
 * - `observational-memory-v10`: synthesized observation log fed to the
 *   reader, with classifier-driven routing inside the OM pipeline. No
 *   verbatim citation rule.
 * - `observational-memory-v11`: same as v10 but with conditional
 *   verbatim citation appended for knowledge-update and
 *   single-session-user categories. Wins on multi-session and
 *   single-session-preference.
 *
 * Backend execution itself lives in {@link MemoryDispatcher}; this type
 * is the contract between the routing decision and the dispatcher.
 */
export type MemoryBackendId =
  | 'canonical-hybrid'
  | 'observational-memory-v10'
  | 'observational-memory-v11';

/**
 * The three shipping presets. Each preset corresponds to a distinct point
 * on the Phase B-measured cost-accuracy Pareto frontier.
 */
export type MemoryRouterPreset =
  | 'minimize-cost'
  | 'balanced'
  | 'maximize-accuracy';

/**
 * A routing table maps every {@link MemoryQueryCategory} to its preferred
 * {@link MemoryBackendId} for the given preset. Tables ship frozen so
 * consumers cannot mutate the routing surface from outside the module.
 */
export interface RoutingTable {
  readonly preset: MemoryRouterPreset;
  readonly defaultMapping: Readonly<Record<MemoryQueryCategory, MemoryBackendId>>;
}

// ============================================================================
// Preset tables
// ============================================================================

/**
 * Preset: minimize-cost.
 *
 * Pareto-dominant cheapest backend per category. Pays the OM premium only
 * on the two categories where the architectural lift earns it
 * (multi-session +6.8pp, single-session-preference +3.3pp). Every other
 * category routes to canonical-hybrid where Phase B measurements show the
 * cheaper backend either dominates or matches within CI noise.
 *
 * Phase B simulation: 73.9% accuracy at $0.092/correct; oracle ceiling
 * 76.0% at $0.157/correct. **Pareto-dominates the all-Tier-2b flat
 * baseline by 4.77x cost reduction at +0.5pp accuracy** on the
 * LongMemEval-S Phase B distribution.
 *
 * Recommended default for cost-sensitive workloads.
 */
export const MINIMIZE_COST_TABLE: RoutingTable = Object.freeze({
  preset: 'minimize-cost' as const,
  defaultMapping: Object.freeze({
    'single-session-assistant': 'canonical-hybrid',
    'single-session-user': 'canonical-hybrid',
    'temporal-reasoning': 'canonical-hybrid',
    'knowledge-update': 'canonical-hybrid',
    'multi-session': 'observational-memory-v11',
    'single-session-preference': 'observational-memory-v11',
  }),
}) as RoutingTable;

/**
 * Preset: balanced.
 *
 * Trades 1.6x cost for >10x latency reductions on knowledge-update and
 * temporal-reasoning. Phase B measurements show Tier 2a v10 ties Tier 1
 * canonical on accuracy for these two categories at much lower latency
 * (4-19s vs 80-100s) — the latency win comes from skipping per-turn
 * cognitive replay in favor of synthesized observations.
 *
 * Phase B simulation: 74.5% accuracy at $0.205/correct; 2.12x cheaper
 * than Tier 2b flat with comparable accuracy.
 *
 * Recommended for interactive workloads where latency matters and the
 * cost premium over minimize-cost is acceptable.
 */
export const BALANCED_TABLE: RoutingTable = Object.freeze({
  preset: 'balanced' as const,
  defaultMapping: Object.freeze({
    'single-session-assistant': 'canonical-hybrid',
    'single-session-user': 'canonical-hybrid',
    'temporal-reasoning': 'observational-memory-v10',
    'knowledge-update': 'observational-memory-v10',
    'multi-session': 'observational-memory-v11',
    'single-session-preference': 'observational-memory-v11',
  }),
}) as RoutingTable;

/**
 * Preset: maximize-accuracy (v2).
 *
 * Highest-accuracy backend per category, ties broken by cost. v2
 * (2026-04-24, post-Phase-B) routes temporal-reasoning back to
 * canonical-hybrid after Phase B revealed:
 *   - v1 routing (TR -> Tier 2a) paid OM ingest cost for a within-CI
 *     accuracy gain (71.0% Tier 2a vs 70.2% Tier 1) on a hold-out slice;
 *   - combined with classifier misroutes the aggregate fell below the
 *     74% acceptance floor at 73.8%.
 * v2 keeps TR on canonical-hybrid where it's cheapest and
 * accuracy-equivalent.
 *
 * Phase B measured: 75.6% [71.8, 79.2] at $0.2434/correct, 65.6s avg
 * latency.
 */
export const MAXIMIZE_ACCURACY_TABLE: RoutingTable = Object.freeze({
  preset: 'maximize-accuracy' as const,
  defaultMapping: Object.freeze({
    'single-session-assistant': 'canonical-hybrid',
    'single-session-user': 'observational-memory-v11',
    'temporal-reasoning': 'canonical-hybrid',
    'knowledge-update': 'observational-memory-v11',
    'multi-session': 'observational-memory-v11',
    'single-session-preference': 'observational-memory-v11',
  }),
}) as RoutingTable;

/**
 * Convenience registry of all three preset tables, keyed by preset name.
 * Useful when surfacing presets through a CLI flag or config field where
 * the preset name is a string and the consumer needs the table object.
 */
export const PRESET_TABLES: Readonly<Record<MemoryRouterPreset, RoutingTable>> =
  Object.freeze({
    'minimize-cost': MINIMIZE_COST_TABLE,
    'balanced': BALANCED_TABLE,
    'maximize-accuracy': MAXIMIZE_ACCURACY_TABLE,
  });

// ============================================================================
// Augmented routing: (backend × retrieval-config) dispatch
// ============================================================================

/**
 * The cheapest-and-safest {@link MemoryBackendId} the router can ever
 * pick. Used by {@link SAFE_FALLBACK_DISPATCH_KEY} when an augmented
 * lookup misses (e.g. the predicted category is not in the table or
 * the table is malformed). Matches the existing behavior of
 * {@link MINIMIZE_COST_TABLE} for unknown categories: degrade to the
 * cheap path rather than the OM-premium path.
 */
export const SAFE_FALLBACK_BACKEND: MemoryBackendId = 'canonical-hybrid';

/**
 * Composite dispatch key that the augmented router emits per query.
 * Carries both the recall-backend axis (existing
 * {@link MemoryBackendId}) and the retrieval-config axis (new
 * {@link RetrievalConfigId}). Wider than the legacy single-axis key
 * but the legacy key is recoverable via the `backend` field.
 *
 * **Backwards compatibility,** consumers using only the existing
 * routing tables continue to dispatch on `MemoryBackendId` alone;
 * the augmented router maps each augmented key to the same backend
 * with `retrievalConfig: 'canonical'` implicitly when the consumer
 * has not opted into augmented dispatch.
 */
export interface MemoryDispatchKey {
  readonly backend: MemoryBackendId;
  readonly retrievalConfig: RetrievalConfigId;
}

/**
 * Default {@link MemoryDispatchKey} used when an augmented lookup
 * misses. Matches the cheap-and-safe path: canonical-hybrid backend
 * with the canonical retrieval config (no HyDE, default rerank,
 * default reader top-K).
 *
 * Frozen at module load.
 */
export const SAFE_FALLBACK_DISPATCH_KEY: MemoryDispatchKey = Object.freeze({
  backend: SAFE_FALLBACK_BACKEND,
  retrievalConfig: 'canonical' as const,
});

/**
 * The augmented preset names.
 *
 * Shipping presets:
 *
 * - `minimize-cost-augmented` (2026-04-26 v2) — composite per-category
 *   dispatch derived from the LongMemEval-S Phase B backend choices and
 *   the LongMemEval-M Phase A retrieval-config ablation matrix.
 * - `s-best-cat-hyde-ms-2026-04-28` — surgical-MS-only S-tuned preset.
 *   Holds canonical retrieval everywhere except multi-session, which
 *   switches to HyDE on the bet that paraphrase-rich multi-hop bridge
 *   queries benefit from hypothetical-document expansion. Calibration
 *   anchors against the 2026-04-28 canonical+RR Phase B headline (85.6%
 *   aggregate, MS at 76.9% — the only weak category at S scale).
 *   **REFUTED at Phase A 2026-04-29** — MS dropped to 22.2% (vs Phase B
 *   baseline 74.4%, a -52.2 pp catastrophic regression). The dispatch
 *   primitive itself ships; this specific preset value is documented
 *   as a refuted hypothesis in the bench LEADERBOARD.
 * - `s-best-cat-topk50-mult5-ms-2026-04-29` — surgical-MS-only S-tuned
 *   preset using a wider rerank candidate pool (rerank-candidate-
 *   multiplier 5) + larger reader-top-K (50) on MS only, on the bet
 *   that S-scale MS bridge queries are pool-size-bound rather than
 *   paraphrase-bound. The M Phase A ablation matrix supports this
 *   direction: `topk50-mult5` lifts M's MS from 18.0% canonical to
 *   44.4%, while HyDE alone hurts (11.1%). This preset replaces the
 *   HyDE pick with topk50-mult5; SSA/SSU/KU/SSP/TR keep canonical.
 *
 * Reserved for v3 calibration alongside Stage E:
 *
 * - `balanced-augmented`, `maximize-accuracy-augmented` — table values
 *   and selector wiring will land when the calibration data exists.
 */
export type AugmentedMemoryRouterPreset =
  | 'minimize-cost-augmented'
  | 's-best-cat-hyde-ms-2026-04-28'
  | 's-best-cat-topk50-mult5-ms-2026-04-29'
  | 'balanced-augmented'
  | 'maximize-accuracy-augmented';

/**
 * An augmented routing table maps every {@link MemoryQueryCategory}
 * to a {@link MemoryDispatchKey} (backend × retrieval-config). The
 * shape is parallel to {@link RoutingTable} but every value is a
 * composite key rather than a backend id.
 *
 * Tables ship frozen so consumers cannot mutate the routing surface
 * from outside the module.
 */
export interface AugmentedRoutingTable {
  readonly preset: AugmentedMemoryRouterPreset;
  readonly defaultMapping: Readonly<Record<MemoryQueryCategory, MemoryDispatchKey>>;
}

/**
 * Preset: minimize-cost-augmented (2026-04-26 v2).
 *
 * Combines two calibrations into one dispatch table:
 *
 * - **Backend axis** from the LongMemEval-S Phase B N=500
 *   {@link MINIMIZE_COST_TABLE}: SSP and MS pay the OM-v11 premium
 *   (architectural lift earns it); every other category routes to
 *   canonical-hybrid (cheapest Pareto-dominant).
 * - **Retrieval-config axis** from the LongMemEval-M Phase A N=54
 *   ablation matrix (per-category-oracle picks): SSA + SSU + MS use
 *   the full combined `hyde-topk50-mult5`; KU uses `topk50` (top-K
 *   alone is sufficient and cheaper); TR + SSP use `hyde` alone (the
 *   wider rerank pool actively hurts these categories).
 *
 * The 2026-04-26 forecasted aggregate at this dispatch table on
 * LongMemEval-M is **68.5%** (per-category-oracle empirical from the
 * ablation matrix), vs **57.4%** static M-tuned (`hyde-topk50-mult5`
 * everywhere) and **30.6%** baseline (`canonical` everywhere).
 * Phase A validation at this preset is the next gate (see
 * `2026-04-26-retrieval-config-router-productionization-plan.md`).
 *
 * **Calibration validity,** N=54 single-seed Phase A on M plus N=500
 * Phase B on S. Phase B at full N=500 on M will tighten per-category
 * confidence intervals; the table here is the directional best-guess
 * for v2 and SHOULD be re-derived from any future Phase B run.
 */
export const MINIMIZE_COST_AUGMENTED_TABLE: AugmentedRoutingTable = Object.freeze({
  preset: 'minimize-cost-augmented' as const,
  defaultMapping: Object.freeze({
    'single-session-assistant': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'hyde-topk50-mult5' as const,
    }),
    'single-session-user': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'hyde-topk50-mult5' as const,
    }),
    'single-session-preference': Object.freeze({
      backend: 'observational-memory-v11' as const,
      retrievalConfig: 'hyde' as const,
    }),
    'knowledge-update': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'topk50' as const,
    }),
    'multi-session': Object.freeze({
      backend: 'observational-memory-v11' as const,
      retrievalConfig: 'hyde-topk50-mult5' as const,
    }),
    'temporal-reasoning': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'hyde' as const,
    }),
  }),
}) as AugmentedRoutingTable;

/**
 * Preset: s-best-cat-hyde-ms-2026-04-28.
 *
 * Surgical-MS-only S-tuned preset. Anchors against the 2026-04-28
 * canonical+RR Phase B headline on LongMemEval-S (85.6% aggregate,
 * MS at 76.9% [69.2%, 84.6%] — the only category with double-digit
 * headroom in the run). Holds the canonical retrieval-config for every
 * other category and switches multi-session alone to HyDE.
 *
 * **Why this design:** the M Phase A ablation matrix (Phase A N=54)
 * showed HyDE alone _hurts_ MS at M scale (multi-session canonical
 * 0.180 → hyde 0.111), but at S scale the haystack is 50 sessions
 * versus 500. The hypothesis is that S-scale multi-session bridge
 * queries are paraphrase-bound, not pool-size-bound — exactly the
 * regime where HyDE expansion lifts retrieval. Phase A probe at
 * S N=54 is the validation gate.
 *
 * Backend axis: every category routes to canonical-hybrid (the
 * 85.6% headline runs canonical end-to-end; the OM-v11 dispatches
 * from MINIMIZE_COST_AUGMENTED_TABLE were calibrated against the
 * stale CharHash-era backend matrix and regressed on the sem-embed
 * + reader-router stack).
 *
 * **Calibration validity:** PRE-VALIDATION HYPOTHESIS. The MS → HyDE
 * pick is data-driven against the M Phase A intuition (HyDE expands
 * bridge-query coverage) but has not been measured at S scale. Phase
 * A probe at LongMemEval-S N=54 stratified is the next gate; Phase B
 * at N=500 is the publication gate. Update this table from any future
 * S Phase B per-category ablation rather than trusting the pre-
 * validation hypothesis once data lands.
 */
export const S_BEST_CAT_HYDE_MS_2026_04_28_TABLE: AugmentedRoutingTable = Object.freeze({
  preset: 's-best-cat-hyde-ms-2026-04-28' as const,
  defaultMapping: Object.freeze({
    'single-session-assistant': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'canonical' as const,
    }),
    'single-session-user': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'canonical' as const,
    }),
    'single-session-preference': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'canonical' as const,
    }),
    'knowledge-update': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'canonical' as const,
    }),
    'multi-session': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'hyde' as const,
    }),
    'temporal-reasoning': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'canonical' as const,
    }),
  }),
}) as AugmentedRoutingTable;

/**
 * Preset: s-best-cat-topk50-mult5-ms-2026-04-29.
 *
 * Surgical-MS-only S-tuned preset that follows on from the refuted
 * `s-best-cat-hyde-ms-2026-04-28` HyDE-on-MS hypothesis. Switches
 * multi-session to `topk50-mult5` (rerank candidate multiplier 5 +
 * reader-top-K 50, no HyDE) and keeps every other category on
 * canonical. Anchors against the 2026-04-28 canonical+RR Phase B
 * headline (85.6% aggregate, MS at 76.9%).
 *
 * **Why this design:** The 2026-04-26 LongMemEval-M Phase A ablation
 * matrix showed `topk50-mult5` lifts M's MS from canonical 18.0% to
 * 44.4%, the second-best lift after the combined `hyde-topk50-mult5`
 * config (66.7%). The HyDE-only variant HURT MS at every scale tested
 * (M canonical 18% → HyDE 11.1%; S Phase B 74.4% → Phase A HyDE 22.2%).
 * The reading: MS bridge queries are pool-size-bound, not paraphrase-
 * bound. A wider Cohere rerank candidate pool gives the cross-encoder
 * more candidate sessions to disambiguate among, without adding the
 * hallucinated-document noise HyDE introduces. This preset isolates
 * that variable on MS only.
 *
 * Backend axis: every category routes to canonical-hybrid (the 85.6%
 * headline runs canonical end-to-end).
 *
 * **Calibration validity:** PRE-VALIDATION HYPOTHESIS. Anchored on
 * the M Phase A ablation matrix's MS column. The transfer to S scale
 * is the hypothesis to validate. Phase A probe at LongMemEval-S N=54
 * is the next gate; Phase B at N=500 is the publication gate.
 */
export const S_BEST_CAT_TOPK50_MULT5_MS_2026_04_29_TABLE: AugmentedRoutingTable = Object.freeze({
  preset: 's-best-cat-topk50-mult5-ms-2026-04-29' as const,
  defaultMapping: Object.freeze({
    'single-session-assistant': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'canonical' as const,
    }),
    'single-session-user': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'canonical' as const,
    }),
    'single-session-preference': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'canonical' as const,
    }),
    'knowledge-update': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'canonical' as const,
    }),
    'multi-session': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'topk50-mult5' as const,
    }),
    'temporal-reasoning': Object.freeze({
      backend: 'canonical-hybrid' as const,
      retrievalConfig: 'canonical' as const,
    }),
  }),
}) as AugmentedRoutingTable;

/**
 * Convenience registry of augmented preset tables, keyed by preset
 * name. Three presets ship: `minimize-cost-augmented` (v2 calibration),
 * `s-best-cat-hyde-ms-2026-04-28` (S Pareto-win HyDE-on-MS — refuted
 * at Phase A), and `s-best-cat-topk50-mult5-ms-2026-04-29` (the
 * follow-up topk50-mult5-on-MS hypothesis). The `balanced-augmented`
 * and `maximize-accuracy-augmented` slots are reserved for v3
 * calibration alongside Stage E.
 */
export const AUGMENTED_PRESET_TABLES: Readonly<
  Partial<Record<AugmentedMemoryRouterPreset, AugmentedRoutingTable>>
> = Object.freeze({
  'minimize-cost-augmented': MINIMIZE_COST_AUGMENTED_TABLE,
  's-best-cat-hyde-ms-2026-04-28': S_BEST_CAT_HYDE_MS_2026_04_28_TABLE,
  's-best-cat-topk50-mult5-ms-2026-04-29': S_BEST_CAT_TOPK50_MULT5_MS_2026_04_29_TABLE,
});

/**
 * Pure-function selector: given a category and an
 * {@link AugmentedRoutingTable}, return the calibrated
 * {@link MemoryDispatchKey}. Falls back to
 * {@link SAFE_FALLBACK_DISPATCH_KEY} when the table is missing the
 * category (a defensive guard for custom-table misuse; the shipping
 * presets cover every category).
 *
 * Stateless. Deterministic. No I/O. Suitable for use inside
 * cache-key construction and hot dispatch loops.
 *
 * @param category - The classifier-predicted query category.
 * @param table - The augmented routing table to consult.
 * @returns A frozen {@link MemoryDispatchKey} for the category.
 */
export function selectAugmentedDispatch(
  category: MemoryQueryCategory,
  table: AugmentedRoutingTable,
): MemoryDispatchKey {
  return table.defaultMapping[category] ?? SAFE_FALLBACK_DISPATCH_KEY;
}
