import { describe, it, expect } from 'vitest';
import { modelSupportsThinking, resolveThinkingPayload } from '../model-thinking';

describe('modelSupportsThinking', () => {
  it('is true for the reasoning-default Opus 4.7 / 4.8 family and Fable 5 (incl. dated variants)', () => {
    expect(modelSupportsThinking('claude-opus-4-8')).toBe(true);
    expect(modelSupportsThinking('claude-opus-4-7')).toBe(true);
    expect(modelSupportsThinking('claude-opus-4-8-20260501')).toBe(true);
    expect(modelSupportsThinking('claude-fable-5')).toBe(true);
    expect(modelSupportsThinking('claude-fable-5-20260609')).toBe(true);
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

  it('emits the adaptive shape for opus-4-8 — enabled/budget_tokens is rejected by the API', () => {
    // Opus 4.7/4.8 removed `thinking: {type:'enabled', budget_tokens}` (400:
    // '"thinking.type.enabled" is not supported for this model'). Adaptive is
    // the only on-mode; the caller's budgetTokens is just the on-switch.
    const r = resolveThinkingPayload('claude-opus-4-8', { budgetTokens: 8000 }, 4000);
    expect(r).not.toBeNull();
    expect(r!.thinking).toEqual({ type: 'adaptive' });
    expect(r!.thinking).not.toHaveProperty('budget_tokens');
  });

  it('leaves max_tokens untouched — adaptive has no budget to floor against', () => {
    expect(resolveThinkingPayload('claude-opus-4-8', { budgetTokens: 8000 }, 4000)!.maxTokens).toBe(4000);
    expect(resolveThinkingPayload('claude-opus-4-8', { budgetTokens: 8000 }, 32000)!.maxTokens).toBe(32000);
  });

  it('emits adaptive for dated variants and opus-4-7 too', () => {
    expect(resolveThinkingPayload('claude-opus-4-7', { budgetTokens: 1 }, 16000)!.thinking).toEqual({ type: 'adaptive' });
    expect(resolveThinkingPayload('claude-opus-4-8-20260501', { budgetTokens: 200 }, 16000)!.thinking).toEqual({ type: 'adaptive' });
  });
});
