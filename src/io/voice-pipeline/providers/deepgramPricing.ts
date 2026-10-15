/**
 * @module voice-pipeline/providers/deepgramPricing
 * US dollars a minute of audio for Deepgram's models, pay as you go, one language, no add-on, from Deepgram's pricing
 * page (https://deepgram.com/pricing). Deepgram prices streamed and pre-recorded audio separately, so each has a table
 * of its own, and a live entry reads only the streaming table. A row that is added or changed names its source and the
 * day it was read here. Both tables are frozen, as the other price tables are.
 *
 * Neither table establishes the price of a request sent with `mip_opt_out=true`. Deepgram's API reference asks callers
 * to check the pricing impact of opting out of its Model Improvement Program before sending it, and neither the pricing
 * page nor the programme's page
 * (https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program), read 15 October 2026,
 * states that price. A host that opts out verifies its account's tariff for those requests before it bounds their spend
 * with a row.
 */

/**
 * Deepgram's streaming models and the regular price a minute of each, in US dollars, pay as you go, one language. The
 * pricing page, read 15 October 2026, lists Nova-3 Monolingual streaming as "Current price $0.0048/min Regular price
 * $0.0077/min", the current price a limited-time promotional rate: the row holds the regular price, so a spending bound
 * read from it holds when the lower current price ends.
 */
export const DEEPGRAM_STREAMING_PRICING: Readonly<Record<string, number>> = Object.freeze<Record<string, number>>({
  'nova-3': 0.0077,
});

/**
 * Deepgram's pre-recorded models and the price a minute of each, in US dollars, pay as you go, one language. The pricing
 * page, read 15 October 2026, lists Nova-3 Monolingual pre-recorded at $0.0043/min. A row here prices a batch request
 * and never a streamed session.
 */
export const DEEPGRAM_PRE_RECORDED_PRICING: Readonly<Record<string, number>> = Object.freeze<Record<string, number>>({
  'nova-3': 0.0043,
});

/**
 * A streaming model's price a minute, read from the table's own rows only.
 * @param modelId - The exact model id, or undefined when no model was chosen.
 * @returns US dollars a minute of streamed audio, or undefined when there is no row (a model named like an inherited
 *   member, such as `constructor`, included).
 */
export function deepgramStreamingPricing(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  return Object.prototype.hasOwnProperty.call(DEEPGRAM_STREAMING_PRICING, modelId) ? DEEPGRAM_STREAMING_PRICING[modelId] : undefined;
}

/**
 * A pre-recorded model's price a minute, read from the table's own rows only.
 * @param modelId - The exact model id, or undefined when no model was chosen.
 * @returns US dollars a minute of pre-recorded audio, or undefined when there is no row (a model named like an
 *   inherited member, such as `constructor`, included).
 */
export function deepgramPreRecordedPricing(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  return Object.prototype.hasOwnProperty.call(DEEPGRAM_PRE_RECORDED_PRICING, modelId)
    ? DEEPGRAM_PRE_RECORDED_PRICING[modelId]
    : undefined;
}
