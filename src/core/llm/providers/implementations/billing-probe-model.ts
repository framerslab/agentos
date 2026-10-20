/**
 * @module core/llm/providers/implementations/billing-probe-model
 *
 * The model a gateway provider's billing probe sends its smallest completion
 * to when the provider has no default model. A key the pool took out for
 * `billing` comes back only when a billable request passes, and a gateway
 * (OpenRouter, Requesty) can serve a free model to an account with no credit
 * left (OpenRouter's limits page names only a negative balance as refusing
 * free models; https://openrouter.ai/docs/api-reference/limits, read
 * 19 October 2026), so the probe must go to a model with a price.
 */
import type { ModelInfo } from '../IProvider';

/**
 * The cheapest chat model of a catalog that lists a price above zero, by its
 * listed input and output prices together. A model with either price missing,
 * not finite or negative (OpenRouter lists its auto router at -1) is skipped,
 * as is an embeddings model. Undefined when no model qualifies; a probe with
 * no model to send has no verdict.
 */
export function cheapestPricedChatModel(models: Iterable<ModelInfo>): string | undefined {
  let best: { modelId: string; price: number } | undefined;
  for (const model of models) {
    if (!model.capabilities.includes('chat') || model.capabilities.includes('embeddings')) continue;
    const input = model.pricePer1MTokensInput;
    const output = model.pricePer1MTokensOutput;
    if (typeof input !== 'number' || typeof output !== 'number') continue;
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    const price = input + output;
    if (price <= 0) continue;
    if (best === undefined || price < best.price) best = { modelId: model.modelId, price };
  }
  return best?.modelId;
}
