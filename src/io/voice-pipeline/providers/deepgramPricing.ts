/**
 * @module voice-pipeline/providers/deepgramPricing
 * US dollars a minute of streamed audio for Deepgram's models, pay as you go, one language: the regular price
 * Deepgram's pricing page lists (https://deepgram.com/pricing, read 12 October 2026: Nova-3 Monolingual, "Current price
 * $0.0048/min Regular price $0.0077/min"), so a spending bound read from it holds when a lower current price ends. A row
 * that is added or changed names its source and the day it was read here. Frozen, as the other price tables are.
 */

/** Deepgram's streaming models and the regular price a minute of each, in US dollars, pay as you go, one language. */
export const DEEPGRAM_STREAMING_PRICING: Readonly<Record<string, number>> = Object.freeze<Record<string, number>>({
  'nova-3': 0.0077,
});

/** A streaming model's price a minute, or undefined when there is no row (a model named like an inherited member included). */
export function deepgramStreamingPricing(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  return Object.prototype.hasOwnProperty.call(DEEPGRAM_STREAMING_PRICING, modelId) ? DEEPGRAM_STREAMING_PRICING[modelId] : undefined;
}
