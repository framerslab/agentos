import { describe, it, expect } from 'vitest';
import {
  defaultOpenRouterProviderPrefs,
  mapOpenRouterUsage,
} from '../OpenRouterProvider';

describe('defaultOpenRouterProviderPrefs', () => {
  it('returns undefined when neither env is set (default routing stays byte-identical)', () => {
    expect(defaultOpenRouterProviderPrefs({})).toBeUndefined();
    expect(
      defaultOpenRouterProviderPrefs({
        OPENROUTER_PROVIDER_SORT: '',
        OPENROUTER_PROVIDER_ORDER: '  ',
      }),
    ).toBeUndefined();
  });

  it('returns a sort-only preference when only OPENROUTER_PROVIDER_SORT is set', () => {
    expect(
      defaultOpenRouterProviderPrefs({ OPENROUTER_PROVIDER_SORT: 'throughput' }),
    ).toEqual({ sort: 'throughput' });
  });

  it('pins an order with allow_fallbacks when OPENROUTER_PROVIDER_ORDER is set', () => {
    expect(
      defaultOpenRouterProviderPrefs({ OPENROUTER_PROVIDER_ORDER: 'Groq' }),
    ).toEqual({ order: ['Groq'], allow_fallbacks: true });
  });

  it('accepts each documented sort value', () => {
    for (const sort of ['price', 'throughput', 'latency']) {
      expect(defaultOpenRouterProviderPrefs({ OPENROUTER_PROVIDER_SORT: sort })).toEqual({
        sort,
      });
    }
  });

  it('ignores an unrecognized OPENROUTER_PROVIDER_SORT value', () => {
    expect(
      defaultOpenRouterProviderPrefs({ OPENROUTER_PROVIDER_SORT: 'cheapest' }),
    ).toBeUndefined();
  });

  it('keeps the order pin when the sort value is unrecognized', () => {
    expect(
      defaultOpenRouterProviderPrefs({
        OPENROUTER_PROVIDER_ORDER: 'Groq',
        OPENROUTER_PROVIDER_SORT: 'cheapest',
      }),
    ).toEqual({ order: ['Groq'], allow_fallbacks: true });
  });

  it('combines order and sort, trimming and dropping empty CSV entries', () => {
    expect(
      defaultOpenRouterProviderPrefs({
        OPENROUTER_PROVIDER_ORDER: ' Groq , DeepInfra ,, ',
        OPENROUTER_PROVIDER_SORT: 'throughput',
      }),
    ).toEqual({
      order: ['Groq', 'DeepInfra'],
      allow_fallbacks: true,
      sort: 'throughput',
    });
  });
});

describe('mapOpenRouterUsage', () => {
  it('returns undefined when the API response carries no usage', () => {
    expect(mapOpenRouterUsage(undefined)).toBeUndefined();
  });

  it('maps base token counts and cost without cache details', () => {
    expect(
      mapOpenRouterUsage({
        prompt_tokens: 1200,
        completion_tokens: 300,
        total_tokens: 1500,
        cost: 0.0042,
      }),
    ).toEqual({
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      costUSD: 0.0042,
    });
  });

  it('surfaces prompt_tokens_details.cached_tokens as cacheReadInputTokens', () => {
    const usage = mapOpenRouterUsage({
      prompt_tokens: 2000,
      completion_tokens: 150,
      total_tokens: 2150,
      cost: 0.003,
      prompt_tokens_details: { cached_tokens: 1800 },
    });
    expect(usage?.cacheReadInputTokens).toBe(1800);
    expect(usage?.promptTokens).toBe(2000);
  });

  it('omits cacheReadInputTokens when details are present but cached_tokens is absent', () => {
    const usage = mapOpenRouterUsage({
      prompt_tokens: 500,
      completion_tokens: 50,
      total_tokens: 550,
      prompt_tokens_details: {},
    });
    expect(usage).not.toHaveProperty('cacheReadInputTokens');
  });
});
