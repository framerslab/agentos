/**
 * @file anthropicCatalog.ts
 * @description Anthropic's model catalog and list prices, in a module of their
 * own: the rows AnthropicProvider lists and prices its calls with, the lookup
 * that resolves a bare or dated model id to its row, the cost of one Messages
 * API call from its usage, and {@link anthropicModelPricing}, the per-1K price
 * table a host's spend guard reads before a call is made, beside
 * `openAIModelPricing`. This module imports nothing of the provider, so
 * `@framers/agentos/safety/runtime` carries the prices without loading it.
 *
 * @module agentos/core/llm/providers/implementations/anthropicCatalog
 */
import type { ModelInfo } from '../IProvider.js';

/**
 * A catalog row. The long-context fields are set on a model Anthropic prices
 * by prompt length (Claude Haiku 5.5): a request whose prompt is over
 * `longContextFromTokens` tokens pays the long rates for its whole usage.
 */
export interface AnthropicModelInfo extends ModelInfo {
  /** Prompt size, in tokens, above which the long-context rates apply. */
  longContextFromTokens?: number;
  /** USD per 1M input tokens for a prompt over `longContextFromTokens`. */
  pricePer1MTokensInputLongContext?: number;
  /** USD per 1M output tokens for a prompt over `longContextFromTokens`. */
  pricePer1MTokensOutputLongContext?: number;
}

/**
 * Prompt-cache writes on one response, split by cache TTL: the
 * `usage.cache_creation` object of the Messages API. The two counts add up to
 * `cache_creation_input_tokens`.
 */
export interface AnthropicCacheCreationBreakdown {
  /** Tokens written with the default 5-minute TTL. */
  ephemeral_5m_input_tokens?: number;
  /** Tokens written with the 1-hour TTL (`cache_control.ttl: '1h'`). */
  ephemeral_1h_input_tokens?: number;
}

// ---------------------------------------------------------------------------
// Known model catalog — used by listAvailableModels / getModelInfo
// ---------------------------------------------------------------------------

/**
 * Static catalog of well-known Anthropic models and their metadata.
 *
 * Prices are USD per 1M tokens, verified against Anthropic's pricing page and
 * model pages on 2026-09-30; the Sonnet 5.5 cache rate and the Claude Haiku
 * 5.5 row were read from the pricing page
 * (https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-18.
 * A cache hit costs 0.1x the input price except where a row sets
 * `pricePer1MTokensCacheRead`: Opus 5.5 and Sonnet 5.5 (0.05x) and Fable 5.1
 * (0.025x) differ, and Fable 5 states its standard 0.1x rate explicitly so
 * the Fable 5.1 rate is not mistaken for it. Cache writes cost 1.25x the input
 * price at the 5-minute TTL and 2x at the 1-hour TTL on every model; see
 * {@link estimateAnthropicCostUSD}.
 *
 * `outputTokenLimit` is the model's real max output ceiling, surfaced via
 * getModelInfo for callers that want to size requests. It is informational,
 * not the per-request default: when a caller omits `maxTokens`, the request
 * falls back to `config.defaultMaxTokens`, but a per-call `maxTokens` is
 * clamped to it via `clampAnthropicMaxTokens` in AnthropicProvider. Anthropic's
 * limits: Opus 5.5, Opus 5, Opus 4.6-4.8, Fable 5.1, Fable 5, Sonnet 5.5,
 * Sonnet 5, Sonnet 4.6 and Haiku 5.5 take 128K output with a 1M context; Opus
 * 4.5, Sonnet 4.5 and Haiku 4.5 take 64K output with a 200K context.
 */
export const ANTHROPIC_MODELS: AnthropicModelInfo[] = [
  {
    modelId: 'claude-opus-5-5',
    providerId: 'anthropic',
    displayName: 'Claude Opus 5.5',
    description: "Anthropic's recommended starting model for most workloads. Frontier Opus for agents and coding, priced below Claude Opus 5.",
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 4,
    pricePer1MTokensOutput: 20,
    // Cache hits and refreshes bill at 0.05x the input price.
    pricePer1MTokensCacheRead: 0.2,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-fable-5-1',
    providerId: 'anthropic',
    displayName: 'Claude Fable 5.1',
    description: "Anthropic's most capable model, for demanding reasoning and long-horizon agentic work.",
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 10,
    pricePer1MTokensOutput: 50,
    // Cache hits and refreshes bill at 0.025x the input price.
    pricePer1MTokensCacheRead: 0.25,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-fable-5',
    providerId: 'anthropic',
    displayName: 'Claude Fable 5',
    description: 'Previous Fable generation, superseded by Claude Fable 5.1.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 10,
    pricePer1MTokensOutput: 50,
    // The standard 0.1x rate. Fable 5.1's 0.025x does not apply to Fable 5.
    pricePer1MTokensCacheRead: 1,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-opus-5',
    providerId: 'anthropic',
    displayName: 'Claude Opus 5',
    description: 'Frontier Opus for agents and coding; drop-in successor to Claude Opus 4.8 at the same pricing.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 5,
    pricePer1MTokensOutput: 25,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-opus-4-8',
    providerId: 'anthropic',
    displayName: 'Claude Opus 4.8',
    description: 'Most intelligent model for agents and coding.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 5,
    pricePer1MTokensOutput: 25,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-opus-4-7',
    providerId: 'anthropic',
    displayName: 'Claude Opus 4.7',
    description: 'Prior Opus generation.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 5,
    pricePer1MTokensOutput: 25,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-opus-4-6',
    providerId: 'anthropic',
    displayName: 'Claude Opus 4.6',
    description: 'Previous-generation Opus with same pricing as 4.7.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 5,
    pricePer1MTokensOutput: 25,
    supportsStreaming: true,
    status: 'active',
  },
  {
    // The dated id is the canonical row: the bare alias `claude-opus-4-5`
    // resolves to it through the prefix fallback in resolveModelCatalogEntry
    // and through the dated-suffix rule of anthropicModelPricing, as
    // `claude-haiku-4-5` resolves to the dated Haiku row.
    modelId: 'claude-opus-4-5-20251101',
    providerId: 'anthropic',
    displayName: 'Claude Opus 4.5',
    description: 'Legacy Opus, still served. Superseded by Claude Opus 5.5.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 200000,
    outputTokenLimit: 64000,
    pricePer1MTokensInput: 5,
    pricePer1MTokensOutput: 25,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-sonnet-5-5',
    providerId: 'anthropic',
    displayName: 'Claude Sonnet 5.5',
    description: 'Current Sonnet for everyday coding, agent and enterprise work; adaptive thinking on by default.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 2,
    pricePer1MTokensOutput: 10,
    // Cache hits and refreshes bill at 0.05x the input price, $0.10 per MTok
    // (pricing page, "Cache read (hit) ... 0.05x on Claude Opus 5.5 and Claude
    // Sonnet 5.5", read 2026-10-18). Without this row the standard 0.1x
    // priced every cache hit on Sonnet 5.5 at twice its rate.
    pricePer1MTokensCacheRead: 0.1,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-sonnet-5',
    providerId: 'anthropic',
    displayName: 'Claude Sonnet 5',
    description: 'Near-Opus coding/agentic Sonnet; adaptive thinking on by default.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    // $2/$10 is the standard price: Anthropic kept its launch pricing and
    // cancelled the increase to $3/$15 scheduled for 2026-09-01 (pricing
    // page, 2026-09-30). The row must stay in this table: without it the
    // model prices as costUSD undefined, which turned the 2026-07-20..26
    // quota-outage fallback traffic (thousands of sonnet-5 leg calls a day)
    // into unmetered spend.
    pricePer1MTokensInput: 2,
    pricePer1MTokensOutput: 10,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-sonnet-4-6',
    providerId: 'anthropic',
    displayName: 'Claude Sonnet 4.6',
    description: 'Optimal balance of intelligence, cost, and speed.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    // 128K per current Anthropic specs (every current-generation model
    // streams to 128K; only Haiku 4.5 and legacy Sonnet 4.5 cap at 64K).
    // The old 64000 silently halved caller budgets via the clamp.
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 3,
    pricePer1MTokensOutput: 15,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-sonnet-4-5',
    providerId: 'anthropic',
    displayName: 'Claude Sonnet 4.5',
    description: 'Previous-generation Sonnet with same pricing as 4.6.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 200000,
    outputTokenLimit: 64000,
    pricePer1MTokensInput: 3,
    pricePer1MTokensOutput: 15,
    supportsStreaming: true,
    status: 'active',
  },
  {
    // Two rate cards, chosen by prompt length (pricing page,
    // https://platform.claude.com/docs/en/about-claude/pricing, "Long context
    // pricing" and the model table, read 2026-10-18): $0.10 / $0.50 per MTok
    // with cache hits at $0.01 for a prompt up to 100,000 tokens; $0.50 / $2.50
    // with cache hits at $0.05 for a prompt over 100,000 tokens. The 1M
    // context and 128K output are the model page's (Claude API reference of
    // 2026-10-06). Adaptive thinking is on by default.
    modelId: 'claude-haiku-5-5',
    providerId: 'anthropic',
    displayName: 'Claude Haiku 5.5',
    description: 'Current Haiku for high-volume, latency-sensitive work; adaptive thinking on by default. Priced by prompt length.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 0.1,
    pricePer1MTokensOutput: 0.5,
    pricePer1MTokensCacheRead: 0.01,
    longContextFromTokens: 100000,
    pricePer1MTokensInputLongContext: 0.5,
    pricePer1MTokensOutputLongContext: 2.5,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-haiku-4-5-20251001',
    providerId: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    description: 'Fastest, most cost-efficient model for lightweight tasks.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 200000,
    outputTokenLimit: 64000,
    pricePer1MTokensInput: 1,
    pricePer1MTokensOutput: 5,
    supportsStreaming: true,
    status: 'active',
  },
  // Legacy entries retained for model-ID back-compat. Prices reflect the
  // original rate card for those specific snapshots.
  // Claude Opus 4 and Claude Sonnet 4 (the 2025-05-14 snapshots) were retired
  // by Anthropic on 2026-06-15. Both ids return HTTP 404 not_found_error on the
  // Messages API (probed 2026-09-29, with a claude-sonnet-5 control returning
  // 200). They stay in the catalog as `deprecated` so a caller still holding
  // one of them gets limits, a price and a status from the catalog. Anthropic's
  // documented replacements are claude-opus-4-8 and claude-sonnet-4-6.
  {
    modelId: 'claude-opus-4-20250514',
    providerId: 'anthropic',
    displayName: 'Claude Opus 4 (2025-05-14)',
    description: 'Retired 2026-06-15 and no longer served. Use claude-opus-4-8.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 200000,
    outputTokenLimit: 32000,
    pricePer1MTokensInput: 15,
    pricePer1MTokensOutput: 75,
    supportsStreaming: true,
    status: 'deprecated',
  },
  {
    modelId: 'claude-sonnet-4-20250514',
    providerId: 'anthropic',
    displayName: 'Claude Sonnet 4 (2025-05-14)',
    description: 'Retired 2026-06-15 and no longer served. Use claude-sonnet-4-6.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 200000,
    outputTokenLimit: 64000,
    pricePer1MTokensInput: 3,
    pricePer1MTokensOutput: 15,
    supportsStreaming: true,
    status: 'deprecated',
  },
];

/**
 * Resolves a caller-supplied model id to its ANTHROPIC_MODELS catalog row.
 * Exact id match wins; otherwise a dated snapshot (`claude-sonnet-5-20260101`)
 * or bare alias is matched by prefix — the SAME resolution the max-tokens
 * clamp uses, shared so pricing ({@link estimateAnthropicCostUSD}) and
 * clamping can never disagree about which row a model id means (an
 * exact-only match prices every dated snapshot id as costUSD undefined:
 * unmetered spend).
 *
 * The longest catalog id that prefixes `modelId` wins. Catalog ids nest:
 * `claude-opus-5` is a prefix of `claude-opus-5-5`. A first-match scan makes
 * the answer depend on array order and can resolve a dated
 * `claude-opus-5-5-…` snapshot to Opus 5's row, pricing it at $5/$25 instead
 * of $4/$20. An id that is itself a prefix of a catalog id, such as the bare
 * alias `claude-haiku-4-5`, resolves to the first catalog id it prefixes.
 */
export function resolveAnthropicModelEntry(modelId: string): AnthropicModelInfo | undefined {
  return resolveModelCatalogEntry(ANTHROPIC_MODELS, modelId);
}

/**
 * Catalog lookup behind {@link resolveAnthropicModelEntry}, taking the catalog
 * as a parameter so the ordering behavior can be tested against a catalog
 * whose shorter id comes first.
 *
 * @param catalog Model rows to search, in any order.
 * @param modelId Caller-supplied model id, bare or dated.
 * @returns The exact row, else the row with the longest id that prefixes
 *   `modelId`, else the first row whose id starts with `modelId`. An empty id
 *   resolves to nothing: every catalog id starts with `''`, so the last rule
 *   would otherwise price a response with no model echo as the first row.
 */
export function resolveModelCatalogEntry<T extends ModelInfo>(
  catalog: readonly T[],
  modelId: string,
): T | undefined {
  if (!modelId) return undefined;
  const exact = catalog.find((m) => m.modelId === modelId);
  if (exact) return exact;
  let longest: T | undefined;
  for (const m of catalog) {
    if (modelId.startsWith(m.modelId) && (!longest || m.modelId.length > longest.modelId.length)) {
      longest = m;
    }
  }
  return longest ?? catalog.find((m) => m.modelId.startsWith(modelId));
}

/**
 * Token counts that decide what one Messages API call costs, under the API's
 * own `usage` field names.
 */
export interface AnthropicUsageForCost {
  /** Input tokens billed at the full input price (cache reads and writes excluded). */
  input_tokens: number;
  /** Output tokens, thinking included. */
  output_tokens: number;
  /** Tokens read from the prompt cache. */
  cache_read_input_tokens?: number;
  /** Tokens written to the prompt cache, both TTLs together. */
  cache_creation_input_tokens?: number;
  /** The same writes split by TTL, when the response reports the split. */
  cache_creation?: AnthropicCacheCreationBreakdown | null;
}

/** The rates one call is priced at, in USD per 1M tokens, after the prompt-length tier is chosen. */
interface TierRates {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * The rates a row bills a call at. A row with long-context fields bills a
 * prompt over `longContextFromTokens` tokens at its long input and output
 * rates; the cache-read rate keeps the row's ratio to its input price (the
 * standard 0.1x, or the row's own), so Claude Haiku 5.5's hits cost $0.01 per
 * MTok under 100K tokens and $0.05 over, as the pricing page lists them.
 *
 * @param promptTokens The whole prompt: uncached input plus cache reads and
 *   writes. The pricing page sizes the tier by the prompt, and cached tokens
 *   are part of it.
 */
function tierRates(info: AnthropicModelInfo, promptTokens: number): TierRates | undefined {
  const input = info.pricePer1MTokensInput;
  const output = info.pricePer1MTokensOutput;
  if (!input || !output) return undefined;
  const long =
    info.longContextFromTokens !== undefined &&
    info.pricePer1MTokensInputLongContext !== undefined &&
    info.pricePer1MTokensOutputLongContext !== undefined &&
    promptTokens > info.longContextFromTokens;
  const tierInput = long ? info.pricePer1MTokensInputLongContext! : input;
  const tierOutput = long ? info.pricePer1MTokensOutputLongContext! : output;
  const cacheRead =
    info.pricePer1MTokensCacheRead !== undefined
      ? info.pricePer1MTokensCacheRead * (tierInput / input)
      : tierInput * 0.1;
  return { input: tierInput, output: tierOutput, cacheRead };
}

/**
 * Estimates the USD cost of one Anthropic Messages API call from its usage.
 *
 * | Tokens | Price |
 * | --- | --- |
 * | `input_tokens` | the input price |
 * | `cache_read_input_tokens` | the row's `pricePer1MTokensCacheRead`, else 0.1x the input price |
 * | 5-minute cache writes | 1.25x the input price |
 * | 1-hour cache writes | 2x the input price |
 * | `output_tokens` | the output price |
 *
 * `input_tokens` excludes cached tokens, so the input components add up
 * without double counting. The 1-hour share of the writes comes from
 * `cache_creation.ephemeral_1h_input_tokens`: a response without that split
 * is priced as 5-minute writes only, and a 1-hour count above the write total
 * is capped at the total.
 *
 * A model priced by prompt length (Claude Haiku 5.5) bills a call whose prompt,
 * cached tokens included, is over the row's `longContextFromTokens` at the
 * row's long rates for every component, as OpenAI's `calculateCost` applies
 * its long-context tier.
 *
 * @param modelId Model id, bare or dated, resolved with
 *   {@link resolveAnthropicModelEntry}.
 * @param usage Token counts from the response.
 * @returns The cost in USD, or `undefined` when the catalog has no price for
 *   the model (unknown, empty or unpriced id).
 */
export function estimateAnthropicCostUSD(
  modelId: string,
  usage: AnthropicUsageForCost,
): number | undefined {
  const info = resolveAnthropicModelEntry(modelId);
  if (!info) return undefined;
  const split = usage.cache_creation ?? undefined;
  const written =
    usage.cache_creation_input_tokens
    ?? ((split?.ephemeral_5m_input_tokens ?? 0) + (split?.ephemeral_1h_input_tokens ?? 0));
  const writtenOneHour = Math.min(Math.max(split?.ephemeral_1h_input_tokens ?? 0, 0), written);
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const rates = tierRates(info, usage.input_tokens + cacheRead + written);
  if (!rates) return undefined;
  // Tokens times USD per 1M tokens: the sum is in millionths of a dollar.
  const microDollars =
    usage.input_tokens * rates.input
    + cacheRead * rates.cacheRead
    + (written - writtenOneHour) * rates.input * 1.25
    + writtenOneHour * rates.input * 2
    + usage.output_tokens * rates.output;
  return microDollars / 1_000_000;
}

/**
 * A Claude model's list prices in USD per 1K tokens, the shape a host's spend
 * guard reads for OpenAI from `openAIModelPricing`: `input` for prompt tokens,
 * `output` for completion tokens, `cacheRead` for prompt-cache hits, and
 * `longContext` on a model Anthropic prices by prompt length, with the prompt
 * size above which its `input` and `output` rates apply.
 */
export interface AnthropicModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly longContext?: {
    readonly fromTokens: number;
    readonly input: number;
    readonly output: number;
  };
}

/**
 * USD per 1K tokens from USD per 1M, rounded to twelve significant digits so a
 * rate the pricing page gives in dollars per million compares equal to its
 * decimal per thousand (0.1 per million is 0.0001 per thousand, not the
 * binary quotient a step away from it).
 */
function perThousand(perMillion: number): number {
  return Number((perMillion / 1000).toPrecision(12));
}

/**
 * The catalog row a host's model id names, by an exact id, else by the id with
 * its dated suffix (`-YYYYMMDD`) removed, else the row that is the id plus a
 * dated suffix (the bare alias `claude-opus-4-5` names the row
 * `claude-opus-4-5-20251101`; with two such rows the newest wins). Never a
 * prefix guess: `claude-opus-4` is not priced as Opus 4.8, and `claude` is not
 * priced at all.
 */
function catalogRowForPricing(modelId: string): AnthropicModelInfo | undefined {
  const exact = ANTHROPIC_MODELS.find((m) => m.modelId === modelId);
  if (exact) return exact;
  const bare = modelId.replace(/-\d{8}$/, '');
  if (bare !== modelId) {
    const byBare = ANTHROPIC_MODELS.find((m) => m.modelId === bare);
    if (byBare) return byBare;
  }
  const dated = ANTHROPIC_MODELS.filter((m) => m.modelId.startsWith(`${modelId}-`) && /^-\d{8}$/.test(m.modelId.slice(modelId.length)));
  if (dated.length === 0) return undefined;
  return dated.sort((a, b) => (a.modelId < b.modelId ? 1 : a.modelId > b.modelId ? -1 : 0))[0];
}

/**
 * A Claude model's prices for a host that admits a call before it is made, as
 * `openAIModelPricing` prices an OpenAI call: the host strips any
 * `anthropic:` prefix first, as it does for OpenAI. Resolution is by an exact
 * catalog id, else the id with its dated suffix removed, else the catalog row
 * that is the id plus a dated suffix; an id the catalog does not name this way
 * (`claude-opus-4`, `claude`) is `undefined`, never the provider's prefix
 * guess, so a spend guard refuses what it cannot price instead of pricing it
 * as another model.
 *
 * @returns Prices in USD per 1K tokens, `cacheRead` being the row's cache-read
 *   rate or 0.1x its input price, and `longContext` on a model priced by
 *   prompt length; `undefined` for an empty, unknown or unpriced id.
 */
export function anthropicModelPricing(modelId: string | undefined): AnthropicModelPrice | undefined {
  if (!modelId) return undefined;
  const row = catalogRowForPricing(modelId);
  if (!row?.pricePer1MTokensInput || !row.pricePer1MTokensOutput) return undefined;
  const price: AnthropicModelPrice = {
    input: perThousand(row.pricePer1MTokensInput),
    output: perThousand(row.pricePer1MTokensOutput),
    cacheRead: perThousand(row.pricePer1MTokensCacheRead ?? row.pricePer1MTokensInput * 0.1),
    ...(row.longContextFromTokens !== undefined &&
    row.pricePer1MTokensInputLongContext !== undefined &&
    row.pricePer1MTokensOutputLongContext !== undefined
      ? {
          longContext: {
            fromTokens: row.longContextFromTokens,
            input: perThousand(row.pricePer1MTokensInputLongContext),
            output: perThousand(row.pricePer1MTokensOutputLongContext),
          },
        }
      : {}),
  };
  return Object.freeze(price);
}
