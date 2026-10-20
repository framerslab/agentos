import { describe, expect, it } from 'vitest';
import { cheapestPricedChatModel } from '../billing-probe-model';
import type { ModelInfo } from '../../IProvider';

function model(modelId: string, input: number | undefined, output: number | undefined, capabilities: string[] = ['chat', 'completion']): ModelInfo {
  return { modelId, providerId: 'openrouter', capabilities, pricePer1MTokensInput: input, pricePer1MTokensOutput: output };
}

describe('cheapestPricedChatModel', () => {
  it('picks the cheapest chat model with a price above zero, never a free one', () => {
    const catalog = [
      model('anthropic/claude-opus-5.5', 15, 75),
      model('meta-llama/llama-3.3-8b-instruct:free', 0, 0),
      model('openai/gpt-4o-mini', 0.15, 0.6),
      model('mistralai/mistral-small', 0.2, 0.6),
    ];
    expect(cheapestPricedChatModel(catalog)).toBe('openai/gpt-4o-mini');
  });

  it('skips a negative price (an auto router), a missing or non-finite price and an embeddings model', () => {
    const catalog = [
      model('openrouter/auto', -1_000_000, -1_000_000),
      model('no/output-price', 0.01, undefined),
      model('nan/price', Number.NaN, 0.01),
      model('openai/text-embedding-3-small', 0.02, 0, ['chat', 'completion', 'embeddings']),
      model('vision/only', 0.01, 0.01, ['vision_input']),
      model('google/gemini-2.5-flash', 0.3, 2.5),
    ];
    expect(cheapestPricedChatModel(catalog)).toBe('google/gemini-2.5-flash');
  });

  it('has no model when the catalog lists none with a price', () => {
    expect(cheapestPricedChatModel([])).toBeUndefined();
    expect(cheapestPricedChatModel([model('free/one', 0, 0), model('unknown/price', undefined, undefined)])).toBeUndefined();
  });

  it('counts a model priced on one side only, as long as the sum is above zero', () => {
    expect(cheapestPricedChatModel([model('input/only', 0.5, 0), model('output/only', 0, 0.4)])).toBe('output/only');
  });
});
