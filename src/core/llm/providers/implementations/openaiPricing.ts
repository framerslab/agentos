/**
 * @file openaiPricing.ts
 * @description OpenAI's list prices: per 1K tokens, the table OpenAIProvider
 * prices its calls with, and per minute of audio for its transcription models,
 * in a module of their own so that a caller can price a call before it is made
 * (the spend budget, a day's spend reservations) without loading the provider.
 */

import { isOpenAIReasoningModel, openAiReasoningContextWindow } from './openaiModelFamilies.js';

/**
 * USD per 1K tokens: `input` for prompt tokens (an embedding model's whole count), `output` for completion tokens and
 * `cachedInput` for prompt tokens read from the prompt cache, where OpenAI's pricing page lists a cached-input rate for
 * the model. A model without one is billed its reads at `input`.
 */
export interface OpenAIModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cachedInput?: number;
}

/**
 * The table with each of its rows frozen, and the table itself. OpenAIProvider, every spend budget and every caller
 * read the same rows, so a caller that changed one would change what every call in the process is priced at.
 */
function frozenRows(rows: Record<string, OpenAIModelPrice>): Readonly<Record<string, OpenAIModelPrice>> {
  for (const row of Object.values(rows)) Object.freeze(row);
  return Object.freeze(rows);
}

// Known pricing for common OpenAI models (USD per 1K tokens).
// Verified against openai.com/api/pricing and developers.openai.com/api/docs/pricing
// on 2026-04-16. Values are standard (non-batch, non-regional) rates.
// Input: cost for prompt tokens. Output: cost for completion tokens.
// For embedding models, 'input' is total tokens.
// cachedInput: the "Cached input" column of the standard tier on
// https://developers.openai.com/api/docs/pricing, read 2026-11-04. A row
// without it is either a model the page lists no cached-input rate for (the
// pro models, marked "-") or one the page does not list at all, marked
// UNVERIFIED below; either way its reads are billed at the input rate, which
// can overcount a call and never undercounts it.
// A prompt of more than 272,000 input tokens on a 1.05M-context model bills
// the whole call at 2x input and 1.5x output
// (developers.openai.com/api/docs/pricing, 2026-09-30). Rows hold the rates
// below that threshold, and calculateCost applies the tier from
// openAiHasLongContextPricing.
/**
 * The rows, moved here unchanged from OpenAIProvider's `modelPricing`, comments and sources included. The table and
 * each of its rows are frozen.
 */
export const OPENAI_MODEL_PRICING: Readonly<Record<string, OpenAIModelPrice>> = frozenRows({
  // GPT-6 family (current flagship, Sep 2026). Astra $10/$50, Sol $2/$10,
  // Luna $0.10/$0.50 per 1M, from developers.openai.com/api/docs/models on
  // 2026-09-23; all three ids are on the first-party GET /v1/models listing.
  // A model with no row here gets costUSD undefined from calculateCost, so
  // its calls go unmetered. "GPT-6 Pro" is a ChatGPT plan tier, and the
  // first-party pro tier is `reasoning.mode: 'pro'` on Sol, so neither has an
  // id here.
  'gpt-6-astra': { input: 0.01, output: 0.05, cachedInput: 0.001 },
  'gpt-6-sol': { input: 0.002, output: 0.01, cachedInput: 0.0002 },
  'gpt-6-luna': { input: 0.0001, output: 0.0005, cachedInput: 0.00001 },
  // gpt-6.1-sol (developers.openai.com/api/docs/changelog, 2026-09-29): $2
  // input and $10 output per 1M like gpt-6-sol, with cached input at $0.10
  // (5% of input, where the other GPT-6 models charge 10%) and cache writes
  // at $2.50. The cache-write rates are multipliers of input
  // (OPENAI_CACHE_WRITE_MULTIPLIER, OPENAI_EXTENDED_CACHE_WRITE_MULTIPLIER).
  'gpt-6.1-sol': { input: 0.002, output: 0.01, cachedInput: 0.0001 },
  // GPT-5.5 family (previous flagship, Jun 2026 — $5 / $30 per 1M tokens, a 2x
  // increase over gpt-5.4; verified against OpenAI's published pricing 2026-06-27)
  'gpt-5.5': { input: 0.005, output: 0.03, cachedInput: 0.0005 },
  'gpt-5.5-pro': { input: 0.03, output: 0.18 },
  // GPT-5.6 family (Aug 2026), per the first-party model pages on
  // 2026-09-23: Sol $4/$20 (promotional through at least 2026-11-21),
  // Terra $2/$12 and Luna $0.20/$1.20 per 1M. OpenRouter's listing carries
  // OpenRouter's resale rates, which differ, so first-party providers are
  // priced from first-party pages. The bare `gpt-5.6` alias routes to Sol and
  // is priced with it. It is absent from the 2026-09-23 /v1/models listing,
  // but aliases are often unlisted and this repo records a direct HTTP 200 on
  // it from 2026-08-06 (see RESPONSES_MAX_EFFORT_MODELS), so it stays until an
  // inference probe shows it gone. Its cached-input rate is Sol's, the
  // model it routes to.
  'gpt-5.6': { input: 0.004, output: 0.02, cachedInput: 0.0004 },
  'gpt-5.6-sol': { input: 0.004, output: 0.02, cachedInput: 0.0004 },
  'gpt-5.6-terra': { input: 0.002, output: 0.012, cachedInput: 0.0002 },
  'gpt-5.6-luna': { input: 0.0002, output: 0.0012, cachedInput: 0.00002 },
  // GPT-5.4 family (previous flagship and siblings, Mar 2026)
  'gpt-5.4': { input: 0.0025, output: 0.015, cachedInput: 0.00025 },
  'gpt-5.4-mini': { input: 0.00075, output: 0.0045, cachedInput: 0.000075 },
  'gpt-5.4-nano': { input: 0.0002, output: 0.00125, cachedInput: 0.00002 },
  'gpt-5.4-pro': { input: 0.030, output: 0.180 },
  // GPT-5.3 family (ChatGPT / Codex variants, priced per Azure/OpenAI listings).
  // UNVERIFIED cached input for gpt-5.3-chat-latest: the pricing page lists
  // `chat-latest`, not this id.
  'gpt-5.3-chat-latest': { input: 0.00175, output: 0.014 },
  'gpt-5.3-codex': { input: 0.00175, output: 0.014, cachedInput: 0.000175 },
  // GPT-5.2 family
  'gpt-5.2': { input: 0.00175, output: 0.014, cachedInput: 0.000175 },
  // GPT-5.1 and GPT-5 base (legacy, same tier pricing)
  'gpt-5': { input: 0.00125, output: 0.010, cachedInput: 0.000125 },
  'gpt-5.1': { input: 0.00125, output: 0.010, cachedInput: 0.000125 },
  'gpt-5-mini': { input: 0.00025, output: 0.002, cachedInput: 0.000025 },
  'gpt-5-nano': { input: 0.00005, output: 0.0004, cachedInput: 0.000005 },
  // GPT-4.1 family (legacy but still in rotation). UNVERIFIED cached input
  // for gpt-4.1-nano: the pricing page no longer lists it.
  'gpt-4.1': { input: 0.002, output: 0.008, cachedInput: 0.0005 },
  'gpt-4.1-mini': { input: 0.0004, output: 0.0016, cachedInput: 0.0001 },
  'gpt-4.1-nano': { input: 0.0001, output: 0.0004 },
  // GPT-4o family (legacy, repriced to current list at $2.50/$10 per 1M)
  'gpt-4o': { input: 0.0025, output: 0.010, cachedInput: 0.00125 },
  // The first GPT-4o snapshot kept its $5 / $15 launch price. Without this
  // row the dated-snapshot fallback would price it at the gpt-4o alias rate.
  // UNVERIFIED cached input: the pricing page does not list the snapshot.
  'gpt-4o-2024-05-13': { input: 0.005, output: 0.015 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006, cachedInput: 0.000075 },
  // Deprecated but still potentially referenced. UNVERIFIED cached input: the
  // pricing page no longer lists these models.
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'gpt-4-turbo-preview': { input: 0.01, output: 0.03 },
  'gpt-4-vision-preview': { input: 0.01, output: 0.03 },
  'gpt-4': { input: 0.03, output: 0.06 },
  'gpt-4-32k': { input: 0.06, output: 0.12 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  'gpt-3.5-turbo-16k': { input: 0.001, output: 0.002 },
  // o-series reasoning models. The pricing page lists o3's cached input and
  // none for o3-pro; o3-mini, o4-mini, o1 and o1-pro: UNVERIFIED cached
  // input, the page no longer lists them.
  'o3': { input: 0.002, output: 0.008, cachedInput: 0.0005 },
  'o3-mini': { input: 0.0011, output: 0.0044 },
  'o3-pro': { input: 0.020, output: 0.080 },
  'o3-pro-2025-06-10': { input: 0.020, output: 0.080 },
  'o4-mini': { input: 0.0011, output: 0.0044 },
  'o1': { input: 0.015, output: 0.060 },
  'o1-pro': { input: 0.150, output: 0.600 },
  // Embedding models (per 1K tokens, input only)
  'text-embedding-3-large': { input: 0.00013, output: 0 },
  'text-embedding-3-small': { input: 0.00002, output: 0 },
  'text-embedding-ada-002': { input: 0.0001, output: 0 },
});

/**
 * The row a table holds under `key` itself. Read as a plain key, a model named after a member every object inherits
 * (`constructor`, `toString`, `__proto__`) would find that member and be priced at NaN; it has no row.
 */
function ownRow<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** A model's row; a dated snapshot without its own row takes its base model's, as OpenAIProvider resolves it. */
export function openAIModelPricing(modelId: string | undefined): OpenAIModelPrice | undefined {
  if (!modelId) return undefined;
  return ownRow(OPENAI_MODEL_PRICING, modelId) ?? ownRow(OPENAI_MODEL_PRICING, modelId.replace(/-\d{4}-\d{2}-\d{2}$/, ''));
}

/**
 * USD per minute of audio for OpenAI's transcription models: the cost per minute that OpenAI's pricing page lists for
 * each (https://developers.openai.com/api/docs/pricing, "Transcription models", read 8 October 2026). gpt-4o-transcribe
 * and gpt-4o-mini-transcribe are billed by token, so their rows are the page's estimate of a minute's cost. A row that
 * is added or changed names its source and the day it was read here. The table is frozen, as the token prices are.
 */
export const OPENAI_TRANSCRIPTION_PRICING: Readonly<Record<string, number>> = Object.freeze<Record<string, number>>({
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-realtime-whisper': 0.017,
  'gpt-4o-transcribe': 0.006,
  'gpt-transcribe': 0.0045,
  'gpt-live-transcribe': 0.017,
});

/** A transcription model's price per minute; a dated snapshot without its own row takes its base model's. */
export function openAITranscriptionPricing(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  return (
    ownRow(OPENAI_TRANSCRIPTION_PRICING, modelId) ??
    ownRow(OPENAI_TRANSCRIPTION_PRICING, modelId.replace(/-\d{4}-\d{2}-\d{2}$/, ''))
  );
}

/**
 * Prompt size, in input tokens, above which OpenAI bills a call on a
 * long-context model at the long-context rates. The pricing page splits its
 * flagship table into "<=272K" and ">272K" input tokens, and the comparison is
 * strict: a prompt of exactly 272,000 tokens bills at the standard rates. The
 * count includes cached tokens, and output size never triggers the tier.
 */
export const OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

/**
 * Factor OpenAI applies to the input rate of a long-context call. The cached
 * input and cache write rates double as well.
 */
export const OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER = 2;

/** Factor OpenAI applies to the output rate of a long-context call. */
export const OPENAI_LONG_CONTEXT_OUTPUT_MULTIPLIER = 1.5;

/**
 * Whether OpenAI bills `modelId` at the long-context rates when a prompt
 * exceeds {@link OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS} input tokens. Such a
 * call bills its whole input at {@link OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER}
 * times the input rate and its whole output at
 * {@link OPENAI_LONG_CONTEXT_OUTPUT_MULTIPLIER} times the output rate.
 *
 * OpenAI states the rule for its models with a 1.05M context window, so this
 * reuses {@link openAiReasoningContextWindow}. That covers the GPT-6 family
 * (`gpt-6.1-sol` included), the GPT-5.6 family except `gpt-5.6-cyber`,
 * `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4` and `gpt-5.4-pro`, bare or dated.
 * Everything else bills flat at every prompt size: the GPT-5 models with a
 * smaller window (`gpt-5.6-cyber`, which the pricing page lists without a
 * long-context rate, `gpt-5.4-mini` / `-nano`, `gpt-5.3` and older, and the
 * chat-latest snapshots), the o-series, and the pre-GPT-5 models, `gpt-4.1`
 * included despite its 1M window. Checked against
 * developers.openai.com/api/docs/pricing and the model pages on 2026-09-30.
 *
 * @param modelId Model id as requested or as echoed by the API.
 * @returns `true` when a prompt above the threshold bills at the long-context rates.
 */
export function openAiHasLongContextPricing(modelId: string): boolean {
  return isOpenAIReasoningModel(modelId) && openAiReasoningContextWindow(modelId) === 1050000;
}

/**
 * Factor OpenAI applies to the input rate for a prompt-cache write with the default 30-minute lifetime, on a model that
 * bills cache writes ({@link openAiBillsCacheWrites}). OpenAI caches a prompt by default, so a call that sends no
 * cache setting still writes at this rate: "Omitting both settings preserves the default "30m" behavior"
 * (https://developers.openai.com/api/docs/guides/prompt-caching, read 2026-11-04). The pricing page lists the same
 * rates per model (https://developers.openai.com/api/docs/pricing, read 2026-11-04: GPT-6 Astra $12.50 on a $10
 * input, GPT-6 Sol $2.50 on $2). The long-context tier doubles them as it doubles the input rate.
 */
export const OPENAI_CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Factor OpenAI applies to the input rate for a prompt-cache write with the 12-hour lifetime, which a request asks for
 * with its cache settings (`prompt_cache_options.ttl`, or a breakpoint's own `ttl`): 2.5x on the pricing page and the
 * prompt-caching guide, read 2026-11-04 (GPT-6 Astra $25 on a $10 input).
 */
export const OPENAI_EXTENDED_CACHE_WRITE_MULTIPLIER = 2.5;

/**
 * Whether OpenAI bills prompt-cache writes on `modelId`: the GPT-5.6 family and later ("Writes cost more than ordinary
 * input ... on GPT-5.6 and later"; earlier models: "No additional cache-write charge", the prompt-caching guide read
 * 2026-11-04). Bare or dated, case-insensitive.
 */
export function openAiBillsCacheWrites(modelId: string): boolean {
  return /^gpt-(5\.6|6)(?![0-9])/i.test(modelId);
}

/** The token counts of an OpenAI response's usage that {@link estimateOpenAICostUSD} prices. */
export interface OpenAIUsageForCost {
  /** `prompt_tokens` (`input_tokens` on the Responses API): every input token, cache reads and writes included. */
  promptTokens: number;
  /** `completion_tokens` (`output_tokens`), reasoning tokens included. */
  completionTokens: number;
  /** `cached_tokens`: input read from the prompt cache. */
  cachedTokens?: number;
  /** `cache_write_tokens`: input written to the prompt cache, none of it counted in `cachedTokens`. */
  cacheWriteTokens?: number;
  /** `cache_write_tokens_details.ttl_12h_tokens`: of the writes, those made with the 12-hour lifetime. */
  cacheWriteExtendedTokens?: number;
}

/** A count from a report: a finite number, zero or more, else 0. */
function countOf(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The cost in USD of an OpenAI response, from its usage and the model's row, as the prompt-caching guide prices one
 * (https://developers.openai.com/api/docs/guides/prompt-caching, "Calculate input cost", read 2026-11-04):
 *
 * | Tokens | Rate |
 * |---|---|
 * | ordinary input: `promptTokens - cachedTokens - cacheWriteTokens` | `input` |
 * | `cachedTokens` | `cachedInput`, else `input` |
 * | writes with the 30-minute lifetime | {@link OPENAI_CACHE_WRITE_MULTIPLIER} times `input` |
 * | `cacheWriteExtendedTokens`, written for 12 hours | {@link OPENAI_EXTENDED_CACHE_WRITE_MULTIPLIER} times `input` |
 * | `completionTokens` | `output` |
 *
 * A write the usage gives no lifetime for is a 30-minute one, the lifetime a request with no cache setting writes
 * with. On a model that bills no writes ({@link openAiBillsCacheWrites}: before GPT-5.6) a write is billed as input. A
 * call whose prompt is over {@link OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS} on a model with long-context pricing bills
 * every input rate at {@link OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER} times and the output at
 * {@link OPENAI_LONG_CONTEXT_OUTPUT_MULTIPLIER} times. The cache counts are held within the prompt: the reads to it,
 * the writes to what the reads leave, the 12-hour writes to the writes.
 *
 * @returns The cost in USD, or undefined when the model has no row.
 */
export function estimateOpenAICostUSD(modelId: string, usage: OpenAIUsageForCost): number | undefined {
  const row = openAIModelPricing(modelId);
  if (!row) return undefined;
  const prompt = countOf(usage.promptTokens);
  const long = prompt > OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS && openAiHasLongContextPricing(modelId);
  const inputScale = long ? OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER : 1;
  const input = row.input * inputScale;
  const output = row.output * (long ? OPENAI_LONG_CONTEXT_OUTPUT_MULTIPLIER : 1);
  const read = Math.min(countOf(usage.cachedTokens), prompt);
  const written = Math.min(countOf(usage.cacheWriteTokens), prompt - read);
  const writtenExtended = Math.min(countOf(usage.cacheWriteExtendedTokens), written);
  const bills = openAiBillsCacheWrites(modelId);
  const readRate = row.cachedInput !== undefined ? row.cachedInput * inputScale : input;
  const writeRate = bills ? input * OPENAI_CACHE_WRITE_MULTIPLIER : input;
  const extendedWriteRate = bills ? input * OPENAI_EXTENDED_CACHE_WRITE_MULTIPLIER : input;
  return (
    ((prompt - read - written) / 1000) * input +
    (read / 1000) * readRate +
    ((written - writtenExtended) / 1000) * writeRate +
    (writtenExtended / 1000) * extendedWriteRate +
    (countOf(usage.completionTokens) / 1000) * output
  );
}
