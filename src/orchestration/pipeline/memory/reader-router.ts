/**
 * @file reader-router.ts
 * @description ReaderRouter primitive — per-query reader-tier dispatch.
 *
 * **What this primitive does:**
 *
 * The shipping {@link MemoryRouter} dispatches per-query among recall
 * BACKENDS (canonical-hybrid, OM-v10, OM-v11). The
 * {@link RetrievalConfigRouter} dispatches per-query retrieval-CONFIG
 * (canonical, hyde, topk50-mult5, etc.). The ReaderRouter completes
 * the orchestration triplet by dispatching per-query among READER
 * MODELS (`gpt-4o`, `gpt-5`, `gpt-5-mini`) using the same
 * `gpt-5-mini` classifier output.
 *
 * **Why this exists:**
 *
 * The 2026-04-28 LongMemEval-S Phase B per-category accuracy split
 * between `gpt-4o` and `gpt-5-mini` at the canonical-hybrid retrieval
 * stack revealed dramatic per-category preference: `gpt-4o` wins TR
 * (+11.8 pp) and SSU (+4.3 pp); `gpt-5-mini` wins SSP (+23.4 pp), and
 * the rest are statistically tied with `gpt-5-mini` cheaper. A static
 * always-on reader at either tier leaves ~3 pp of accuracy on the table
 * vs per-category-oracle dispatch (which the gpt-5-mini classifier
 * already provides through the policy router and retrieval-config
 * router pipelines).
 *
 * **Calibration sources:**
 *
 * `MIN_COST_BEST_CAT_2026_04_28_TABLE` (the v1 publication preset) is
 * calibrated from LongMemEval-S Phase B N=500 runs:
 *
 *   - results/runs/2026-04-27T06-27-24-170--longmemeval-s--gpt-4o--full-cognitive--ingest.json
 *   - results/runs/2026-04-28T08-07-48-754--longmemeval-s--gpt-5-mini--full-cognitive--ingest.json
 *
 * Per-category accuracy (judge `gpt-4o-2024-08-06`, rubric 2026-04-18.1):
 *
 * | Category                  | gpt-4o | gpt-5-mini | Pick      | Δ        |
 * | ------------------------- | -----: | ---------: | :-------- | -------- |
 * | temporal-reasoning (n=133)|  84.7% |      72.9% | gpt-4o    | +11.8 pp |
 * | single-session-user (n=70)|  94.3% |      90.0% | gpt-4o    |  +4.3 pp |
 * | single-session-pref (n=30)|  63.3% |      86.7% | gpt-5-mini| +23.4 pp |
 * | single-session-asst (n=56)|  98.2% |     100.0% | gpt-5-mini|  +1.8 pp |
 * | knowledge-update    (n=78)|  85.7% |      87.2% | gpt-5-mini|  +1.5 pp |
 * | multi-session      (n=133)|  76.2% |      79.7% | gpt-5-mini|  +3.5 pp |
 *
 * Oracle aggregate at this calibration: 435/500 = 87.0% (+3.8 pp over
 * either reader alone). Realized at ~80% classifier accuracy: ~85-86%
 * (validated at 85.6% Phase B N=500 with the standalone classifier).
 *
 * `MIN_COST_BEST_CAT_GPT5_TR_2026_04_29_TABLE` (the v1.1 follow-up)
 * replaces the gpt-4o picks for TR and SSU with `gpt-5`, on Phase A
 * signal of +4 pp on TR + cheaper input pricing (gpt-5 input is half
 * gpt-4o's per-1K-token rate). Phase B at N=500 is the validation
 * gate.
 *
 * **Opt-in by registration:**
 *
 * Consumers register only the {@link ReaderRouterPreset} they support
 * in their dispatcher. The selector throws a typed error if asked for
 * a category that's missing from the active preset's table — the
 * shipped presets cover every {@link MemoryQueryCategory}.
 *
 * **Model end dates:**
 *
 * The presets are records of the runs they were calibrated on, so their
 * tiers keep the names of the models those runs used. OpenAI ends `gpt-5`
 * and `gpt-5-mini` on 2026-12-11 and the `gpt-4o` snapshots on 2027-01-14
 * (https://developers.openai.com/api/docs/deprecations, read 2026-11-17).
 * A caller that dispatches on these tiers after those days needs a preset
 * calibrated on current models; `openAIModelShutdown('gpt-5')` and
 * `openAIModelShutdown('gpt-5-mini')` give each one's end date and the
 * current model that does its job.
 *
 * @module @framers/agentos/memory-router/reader-router
 */

import type { MemoryQueryCategory } from './routing-tables.js';

/**
 * Reader tier the router can dispatch to. Restricted to OpenAI models
 * the shipped presets were calibrated against. The bench is single-
 * provider OpenAI for reader/classifier/judge by design; Cohere is
 * allowed only at the rerank stage.
 */
export type ReaderTier = 'gpt-4o' | 'gpt-5' | 'gpt-5-mini';

/**
 * Registered preset identifier. Each preset names the calibration
 * source + the date the calibration table was derived, mirroring the
 * `MINIMIZE_COST_*` preset naming convention in this package.
 */
export type ReaderRouterPreset =
  | 'min-cost-best-cat-2026-04-28'
  | 'min-cost-best-cat-gpt5-tr-2026-04-29';

/**
 * A complete reader-router calibration: every {@link MemoryQueryCategory}
 * MUST map to a {@link ReaderTier}. The runtime guard in
 * {@link selectReader} fires if a future table addition forgets a
 * category.
 */
export interface ReaderRouterTable {
  readonly preset: ReaderRouterPreset;
  /** Per-category reader assignment. */
  readonly mapping: Readonly<Record<MemoryQueryCategory, ReaderTier>>;
}

/**
 * Error thrown when {@link selectReader} is called with a category
 * that is not present in the active routing table. Should never fire
 * in production (TypeScript guards exhaustive {@link MemoryQueryCategory}
 * at compile time), but the runtime check protects against structural
 * casts and future table refactors that introduce a partial mapping.
 */
export class ReaderRouterUnknownCategoryError extends Error {
  constructor(category: string, preset: string) {
    super(
      `ReaderRouter: category '${category}' not in routing table for preset '${preset}'`,
    );
    this.name = 'ReaderRouterUnknownCategoryError';
  }
}

/**
 * Error thrown when {@link selectReader} is called with a preset that
 * is not registered in {@link READER_ROUTER_PRESET_TABLES}. Guards
 * against typos in CLI flag passthrough — `min-cost-best-cat-2026-04-27`
 * (off-by-one date) would fail fast here rather than silently routing
 * every case to a default reader.
 */
export class ReaderRouterUnknownPresetError extends Error {
  constructor(preset: string) {
    super(
      `ReaderRouter: preset '${preset}' is not registered. ` +
        `Known presets: ${Object.keys(READER_ROUTER_PRESET_TABLES).join(', ')}`,
    );
    this.name = 'ReaderRouterUnknownPresetError';
  }
}

/**
 * The MIN_COST_BEST_CAT_2026_04_28 calibration. See file header for
 * the derivation table and source runs.
 */
export const MIN_COST_BEST_CAT_2026_04_28_TABLE: ReaderRouterTable = Object.freeze({
  preset: 'min-cost-best-cat-2026-04-28' as const,
  mapping: Object.freeze({
    'temporal-reasoning': 'gpt-4o' as const,
    'single-session-user': 'gpt-4o' as const,
    'single-session-preference': 'gpt-5-mini' as const,
    'single-session-assistant': 'gpt-5-mini' as const,
    'knowledge-update': 'gpt-5-mini' as const,
    'multi-session': 'gpt-5-mini' as const,
  }),
}) as ReaderRouterTable;

/**
 * The MIN_COST_BEST_CAT_GPT5_TR_2026_04_29 calibration. Replaces the
 * gpt-4o picks for `temporal-reasoning` and `single-session-user`
 * with `gpt-5` (cheaper input than gpt-4o + Phase A signal of +4 pp
 * on TR). Keeps the gpt-5-mini picks for `single-session-assistant`,
 * `single-session-preference`, `knowledge-update`, and `multi-session`
 * unchanged.
 *
 * **Calibration source:** Phase A N=54 stratified probe at
 * canonical+RR + `--reader gpt-5` (no router) measured TR 88.9%
 * [66.7%, 100%] vs the gpt-4o Phase B baseline 84.7% — a +4.2 pp
 * point estimate at small sample. SSU was 100% at N=9 vs 94.3%
 * baseline. Phase A only; Phase B at N=500 is the validation gate.
 *
 * **Why ship as a preset rather than defaulting:** preset is opt-in
 * via the bench's `--reader-router min-cost-best-cat-gpt5-tr-2026-04-29`
 * flag. Phase B may show the gpt-5 lift collapses (Phase A → Phase B
 * compressions have happened repeatedly in this benchmark on small
 * samples).
 */
export const MIN_COST_BEST_CAT_GPT5_TR_2026_04_29_TABLE: ReaderRouterTable = Object.freeze({
  preset: 'min-cost-best-cat-gpt5-tr-2026-04-29' as const,
  mapping: Object.freeze({
    'temporal-reasoning': 'gpt-5' as const,
    'single-session-user': 'gpt-5' as const,
    'single-session-preference': 'gpt-5-mini' as const,
    'single-session-assistant': 'gpt-5-mini' as const,
    'knowledge-update': 'gpt-5-mini' as const,
    'multi-session': 'gpt-5-mini' as const,
  }),
}) as ReaderRouterTable;

/**
 * Registry of all calibrated reader-router tables. Adding a new
 * preset means (a) extending {@link ReaderRouterPreset}, (b) defining
 * a `*_TABLE` const with the calibration, (c) adding the entry here.
 * Frozen at module load.
 */
export const READER_ROUTER_PRESET_TABLES: Readonly<
  Record<ReaderRouterPreset, ReaderRouterTable>
> = Object.freeze({
  'min-cost-best-cat-2026-04-28': MIN_COST_BEST_CAT_2026_04_28_TABLE,
  'min-cost-best-cat-gpt5-tr-2026-04-29': MIN_COST_BEST_CAT_GPT5_TR_2026_04_29_TABLE,
});

/**
 * Pick a reader tier for a given predicted category under a calibration
 * preset. Stateless. Deterministic. No I/O. Suitable for use inside
 * cache-key construction and hot dispatch loops.
 *
 * @throws {ReaderRouterUnknownPresetError} when `preset` is not in
 *   {@link READER_ROUTER_PRESET_TABLES}.
 * @throws {ReaderRouterUnknownCategoryError} when the table for
 *   `preset` is missing an entry for `category`. (Defensive runtime
 *   guard; not reachable through the type system on a properly-
 *   constructed table.)
 */
export function selectReader(
  category: MemoryQueryCategory,
  preset: ReaderRouterPreset,
): ReaderTier {
  const table = READER_ROUTER_PRESET_TABLES[preset];
  if (!table) {
    throw new ReaderRouterUnknownPresetError(preset);
  }
  const reader = table.mapping[category];
  if (!reader) {
    throw new ReaderRouterUnknownCategoryError(category, preset);
  }
  return reader;
}
