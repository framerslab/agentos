import { describe, it, expect } from 'vitest';
import { modelSupportsThinking, resolveThinkingPayload } from '../model-thinking';

describe('modelSupportsThinking', () => {
  it('is true for the reasoning-default Opus 4.7 / 4.8 family (incl. dated variants)', () => {
    expect(modelSupportsThinking('claude-opus-4-8')).toBe(true);
    expect(modelSupportsThinking('claude-opus-4-7')).toBe(true);
    expect(modelSupportsThinking('claude-opus-4-8-20260501')).toBe(true);
  });

  it('is false for sonnet, haiku, and pre-4.7 opus', () => {
    expect(modelSupportsThinking('claude-sonnet-4-6')).toBe(false);
    expect(modelSupportsThinking('claude-haiku-4-5')).toBe(false);
    expect(modelSupportsThinking('claude-opus-4-6')).toBe(false);
  });
});

describe('resolveThinkingPayload', () => {
  it('returns null when no budget is requested', () => {
    expect(resolveThinkingPayload('claude-opus-4-8', undefined, 16000)).toBeNull();
  });

  it('returns null for a non-thinking model even when a budget is passed', () => {
    expect(resolveThinkingPayload('claude-sonnet-4-6', { budgetTokens: 8000 }, 4000)).toBeNull();
  });

  it('enables thinking and floors max_tokens to budget + 8192', () => {
    const r = resolveThinkingPayload('claude-opus-4-8', { budgetTokens: 8000 }, 4000);
    expect(r).not.toBeNull();
    expect(r!.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
    // Anthropic requires max_tokens > budget_tokens; floor leaves answer room.
    expect(r!.maxTokens).toBe(8000 + 8192);
  });

  it('preserves a caller max_tokens already above the floor', () => {
    const r = resolveThinkingPayload('claude-opus-4-8', { budgetTokens: 8000 }, 32000);
    expect(r!.maxTokens).toBe(32000);
  });

  it('clamps a sub-minimum budget up to Anthropic\'s 1024-token floor', () => {
    const r = resolveThinkingPayload('claude-opus-4-8', { budgetTokens: 200 }, 0);
    expect(r!.thinking.budget_tokens).toBe(1024);
    expect(r!.maxTokens).toBe(1024 + 8192);
  });

  it('floors a fractional budget to an integer token count', () => {
    const r = resolveThinkingPayload('claude-opus-4-8', { budgetTokens: 8000.7 }, 0);
    expect(r!.thinking.budget_tokens).toBe(8000);
  });
});
