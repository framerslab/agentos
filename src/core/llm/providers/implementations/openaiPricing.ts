/**
 * @file openaiPricing.ts
 * @description OpenAI's list prices: per 1K tokens, the table OpenAIProvider
 * prices its calls with, and per minute of audio for its transcription models,
 * in a module of their own so that a caller can price a call before it is made
 * (the spend budget, a day's spend reservations) without loading the provider.
 */

/** USD per 1K tokens: `input` for prompt tokens (an embedding model's whole count), `output` for completion tokens. */
export interface OpenAIModelPrice {
  readonly input: number;
  readonly output: number;
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
  'gpt-6-astra': { input: 0.01, output: 0.05 },
  'gpt-6-sol': { input: 0.002, output: 0.01 },
  'gpt-6-luna': { input: 0.0001, output: 0.0005 },
  // gpt-6.1-sol (developers.openai.com/api/docs/changelog, 2026-09-29): $2
  // input and $10 output per 1M like gpt-6-sol, with cached input at $0.10
  // (5% of input, where the other GPT-6 models charge 10%) and cache writes
  // at $2.50. This table carries no cached or cache-write column.
  'gpt-6.1-sol': { input: 0.002, output: 0.01 },
  // GPT-5.5 family (previous flagship, Jun 2026 — $5 / $30 per 1M tokens, a 2x
  // increase over gpt-5.4; verified against OpenAI's published pricing 2026-06-27)
  'gpt-5.5': { input: 0.005, output: 0.03 },
  'gpt-5.5-pro': { input: 0.03, output: 0.18 },
  // GPT-5.6 family (Aug 2026), per the first-party model pages on
  // 2026-09-23: Sol $4/$20 (promotional through at least 2026-11-21),
  // Terra $2/$12 and Luna $0.20/$1.20 per 1M. OpenRouter's listing carries
  // OpenRouter's resale rates, which differ, so first-party providers are
  // priced from first-party pages. The bare `gpt-5.6` alias routes to Sol and
  // is priced with it. It is absent from the 2026-09-23 /v1/models listing,
  // but aliases are often unlisted and this repo records a direct HTTP 200 on
  // it from 2026-08-06 (see RESPONSES_MAX_EFFORT_MODELS), so it stays until an
  // inference probe shows it gone.
  'gpt-5.6': { input: 0.004, output: 0.02 },
  'gpt-5.6-sol': { input: 0.004, output: 0.02 },
  'gpt-5.6-terra': { input: 0.002, output: 0.012 },
  'gpt-5.6-luna': { input: 0.0002, output: 0.0012 },
  // GPT-5.4 family (previous flagship and siblings, Mar 2026)
  'gpt-5.4': { input: 0.0025, output: 0.015 },
  'gpt-5.4-mini': { input: 0.00075, output: 0.0045 },
  'gpt-5.4-nano': { input: 0.0002, output: 0.00125 },
  'gpt-5.4-pro': { input: 0.030, output: 0.180 },
  // GPT-5.3 family (ChatGPT / Codex variants, priced per Azure/OpenAI listings)
  'gpt-5.3-chat-latest': { input: 0.00175, output: 0.014 },
  'gpt-5.3-codex': { input: 0.00175, output: 0.014 },
  // GPT-5.2 family
  'gpt-5.2': { input: 0.00175, output: 0.014 },
  // GPT-5.1 and GPT-5 base (legacy, same tier pricing)
  'gpt-5': { input: 0.00125, output: 0.010 },
  'gpt-5.1': { input: 0.00125, output: 0.010 },
  'gpt-5-mini': { input: 0.00025, output: 0.002 },
  'gpt-5-nano': { input: 0.00005, output: 0.0004 },
  // GPT-4.1 family (legacy but still in rotation)
  'gpt-4.1': { input: 0.002, output: 0.008 },
  'gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
  'gpt-4.1-nano': { input: 0.0001, output: 0.0004 },
  // GPT-4o family (legacy, repriced to current list at $2.50/$10 per 1M)
  'gpt-4o': { input: 0.0025, output: 0.010 },
  // The first GPT-4o snapshot kept its $5 / $15 launch price. Without this
  // row the dated-snapshot fallback would price it at the gpt-4o alias rate.
  'gpt-4o-2024-05-13': { input: 0.005, output: 0.015 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  // Deprecated but still potentially referenced
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'gpt-4-turbo-preview': { input: 0.01, output: 0.03 },
  'gpt-4-vision-preview': { input: 0.01, output: 0.03 },
  'gpt-4': { input: 0.03, output: 0.06 },
  'gpt-4-32k': { input: 0.06, output: 0.12 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  'gpt-3.5-turbo-16k': { input: 0.001, output: 0.002 },
  // o-series reasoning models
  'o3': { input: 0.002, output: 0.008 },
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
