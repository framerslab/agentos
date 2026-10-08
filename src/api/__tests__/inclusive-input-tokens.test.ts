/**
 * @fileoverview Provider-independent inclusive input-token accounting
 * (spec batch-1 C1): OpenRouter/OpenAI prompt counts are already inclusive
 * of cached tokens and pass through as-is; Anthropic adds cache reads and
 * writes back onto its exclusive input count (covered in the provider
 * suites); reported zeros are preserved (tri-state, never collapsed).
 */
import { describe, it, expect } from 'vitest';
import { mapOpenRouterUsage } from '../../core/llm/providers/implementations/OpenRouterProvider.js';

describe('mapOpenRouterUsage inclusive input accounting', () => {
  it('passes prompt_tokens through as the inclusive input total', () => {
    const usage = mapOpenRouterUsage({
      prompt_tokens: 500,
      completion_tokens: 20,
      total_tokens: 520,
      prompt_tokens_details: { cached_tokens: 400 },
    } as never);
    expect(usage?.inclusiveInputTokens).toBe(500);
    expect(usage?.cacheReadInputTokens).toBe(400);
    expect(usage?.promptTokens).toBe(500);
  });

  it('preserves a reported zero cached count instead of dropping it', () => {
    const usage = mapOpenRouterUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 0 },
    } as never);
    expect(usage?.cacheReadInputTokens).toBe(0);
    expect(usage?.inclusiveInputTokens).toBe(100);
  });

  it('leaves inclusiveInputTokens undefined when prompt_tokens is absent', () => {
    const usage = mapOpenRouterUsage({
      completion_tokens: 5,
      total_tokens: 5,
    } as never);
    expect(usage?.inclusiveInputTokens).toBeUndefined();
  });
});
