/**
 * @file anthropicCatalog.test.ts
 * The Claude price table a host's spend guard reads (`anthropicModelPricing`),
 * the long-context tier of `estimateAnthropicCostUSD`, and the re-exports that
 * keep every import of the moved catalog names working.
 */
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MODELS,
  anthropicModelPricing,
  estimateAnthropicCostUSD,
  resolveAnthropicModelEntry,
} from '../implementations/anthropicCatalog';
import {
  anthropicModelPricing as fromProvider,
  estimateAnthropicCostUSD as estimateFromProvider,
  resolveAnthropicModelEntry as resolveFromProvider,
} from '../implementations/AnthropicProvider';
import { anthropicModelPricing as fromRuntime, openAIModelPricing } from '../../../../safety/runtime';
// Type-only: the price types a host's spend guard names, from the runtime index and the package root (tsc checks them).
import type { AnthropicModelPrice, OpenAIModelPrice } from '../../../../safety/runtime';
import type {
  AnthropicModelPrice as RootAnthropicModelPrice,
  OpenAIModelPrice as RootOpenAIModelPrice,
  anthropicModelPricing as RootAnthropicModelPricing,
} from '../../../../index';

describe('anthropicModelPricing (prices for a host, USD per 1K tokens)', () => {
  it('prices Claude Sonnet 5.5 with its own cache-read rate', () => {
    expect(anthropicModelPricing('claude-sonnet-5-5')).toEqual({ input: 0.002, output: 0.01, cacheRead: 0.0001 });
  });

  it('gives a host the shape it reads for OpenAI', () => {
    const openai = openAIModelPricing('gpt-4o');
    const claude = anthropicModelPricing('claude-opus-5-5');
    expect(openai).toBeDefined();
    expect(claude).toBeDefined();
    expect(Object.keys(openai!)).toEqual(expect.arrayContaining(['input', 'output']));
    expect(claude).toMatchObject({ input: 0.004, output: 0.02, cacheRead: 0.0002 });
  });

  it('resolves a dated id and its bare alias to the same row, in both directions', () => {
    const dated = anthropicModelPricing('claude-opus-4-5-20251101');
    expect(dated).toBeDefined();
    expect(anthropicModelPricing('claude-opus-4-5')).toEqual(dated);
    expect(anthropicModelPricing('claude-haiku-4-5')).toEqual(anthropicModelPricing('claude-haiku-4-5-20251001'));
    // A dated snapshot of a bare catalog id resolves with its suffix removed.
    expect(anthropicModelPricing('claude-sonnet-5-5-20261001')).toEqual(anthropicModelPricing('claude-sonnet-5-5'));
  });

  it('never guesses by prefix: claude-opus-4 and claude are unpriced', () => {
    expect(anthropicModelPricing('claude-opus-4')).toBeUndefined();
    // The retired May 2025 snapshots price by their exact id alone: the bare family name is not their alias.
    expect(anthropicModelPricing('claude-sonnet-4')).toBeUndefined();
    expect(anthropicModelPricing('claude-opus-4-20250514')).toMatchObject({ input: 0.015, output: 0.075 });
    expect(anthropicModelPricing('claude')).toBeUndefined();
    expect(anthropicModelPricing('claude-opus')).toBeUndefined();
    expect(anthropicModelPricing(undefined)).toBeUndefined();
    expect(anthropicModelPricing('')).toBeUndefined();
  });

  it('carries the long-context tier of Claude Haiku 5.5', () => {
    expect(anthropicModelPricing('claude-haiku-5-5')).toEqual({
      input: 0.0001,
      output: 0.0005,
      cacheRead: 0.00001,
      // Over 100K prompt tokens a cache read costs 0.05 per million, five times the base rate as the input does.
      longContext: { fromTokens: 100000, input: 0.0005, output: 0.0025, cacheRead: 0.00005 },
    });
    expect(anthropicModelPricing('claude-sonnet-5-5')?.longContext).toBeUndefined();
  });

  it('is the one function behind the provider module and the safety runtime index', () => {
    expect(fromProvider).toBe(anthropicModelPricing);
    expect(fromRuntime).toBe(anthropicModelPricing);
    expect(estimateFromProvider).toBe(estimateAnthropicCostUSD);
    expect(resolveFromProvider).toBe(resolveAnthropicModelEntry);
  });

  it('names both price types where a host imports them: the runtime index and the package root', () => {
    // The annotations are the assertion: the type check fails if either export goes missing.
    const claude: AnthropicModelPrice | undefined = anthropicModelPricing('claude-sonnet-5-5');
    const openai: OpenAIModelPrice | undefined = openAIModelPricing('gpt-4o');
    const claudeAtRoot: RootAnthropicModelPrice | undefined = claude;
    const openaiAtRoot: RootOpenAIModelPrice | undefined = openai;
    const pricingAtRoot: typeof RootAnthropicModelPricing = fromRuntime;
    expect(claudeAtRoot?.cacheRead).toBe(0.0001);
    expect(openaiAtRoot?.input).toBeGreaterThan(0);
    expect(pricingAtRoot).toBe(anthropicModelPricing);
  });
});

describe('estimateAnthropicCostUSD with a long-context tier', () => {
  it('prices a Claude Haiku 5.5 call whose prompt is over 100K tokens at the long rates, and one under at the base rates', () => {
    // 200,000 input at $0.50/M + 1,000 output at $2.50/M.
    expect(estimateAnthropicCostUSD('claude-haiku-5-5', { input_tokens: 200000, output_tokens: 1000 })).toBeCloseTo(0.1025, 9);
    // 50,000 input at $0.10/M + 1,000 output at $0.50/M.
    expect(estimateAnthropicCostUSD('claude-haiku-5-5', { input_tokens: 50000, output_tokens: 1000 })).toBeCloseTo(0.0055, 9);
  });

  it('bills a prompt of exactly 100,000 tokens at the base rates: the tier starts beyond it', () => {
    // The pricing page's "up to 100K" and "beyond": 100,000 at $0.10/M + 1 output at $0.50/M.
    expect(estimateAnthropicCostUSD('claude-haiku-5-5', { input_tokens: 100000, output_tokens: 1 })).toBeCloseTo(
      (100000 * 0.1 + 1 * 0.5) / 1e6,
      12,
    );
    // One token more is the long tier: 100,001 at $0.50/M + 1 output at $2.50/M.
    expect(estimateAnthropicCostUSD('claude-haiku-5-5', { input_tokens: 100001, output_tokens: 1 })).toBeCloseTo(
      (100001 * 0.5 + 1 * 2.5) / 1e6,
      12,
    );
  });

  it('counts cached tokens toward the prompt size that picks the tier, and reads them at the tier rate', () => {
    // 1,000 uncached + 150,000 cache reads: the long tier, reads at $0.05/M.
    const cost = estimateAnthropicCostUSD('claude-haiku-5-5', { input_tokens: 1000, cache_read_input_tokens: 150000, output_tokens: 0 });
    expect(cost).toBeCloseTo((1000 * 0.5 + 150000 * 0.05) / 1e6, 12);
  });

  it('keeps the catalog row the clamp and the mapper resolve', () => {
    expect(resolveAnthropicModelEntry('claude-haiku-5-5')?.outputTokenLimit).toBe(128000);
    expect(ANTHROPIC_MODELS.some((m) => m.modelId === 'claude-haiku-5-5')).toBe(true);
    expect(ANTHROPIC_MODELS.find((m) => m.modelId === 'claude-sonnet-5-5')?.pricePer1MTokensCacheRead).toBe(0.1);
  });
});
