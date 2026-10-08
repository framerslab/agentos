import { describe, it, expect } from 'vitest';
import { modelSupportsThinking, resolveThinkingOff, resolveThinkingPayload } from '../model-thinking';

describe('modelSupportsThinking', () => {
  it('is true for the reasoning-default Opus 4.7 / 4.8 family, Sonnet 5, and Fable 5 (incl. dated variants)', () => {
    expect(modelSupportsThinking('claude-opus-4-8')).toBe(true);
    expect(modelSupportsThinking('claude-opus-4-7')).toBe(true);
    expect(modelSupportsThinking('claude-opus-4-8-20260501')).toBe(true);
    expect(modelSupportsThinking('claude-opus-5')).toBe(true);
    expect(modelSupportsThinking('claude-opus-5-20260701')).toBe(true);
    expect(modelSupportsThinking('claude-sonnet-5')).toBe(true);
    expect(modelSupportsThinking('claude-sonnet-5-20260101')).toBe(true);
    expect(modelSupportsThinking('claude-fable-5')).toBe(true);
    expect(modelSupportsThinking('claude-fable-5-20260609')).toBe(true);
  });

  // Opus 5.5 and Fable 5.1 match the existing `opus-5` and `fable-5`
  // alternatives because `\b` matches at the hyphen before the trailing
  // version digit. Pinned so a re-anchoring such as `opus-5$` fails here.
  it('is true for Opus 5.5 and Fable 5.1, including dated variants', () => {
    expect(modelSupportsThinking('claude-opus-5-5')).toBe(true);
    expect(modelSupportsThinking('claude-opus-5-5-20260901')).toBe(true);
    expect(modelSupportsThinking('claude-fable-5-1')).toBe(true);
    expect(modelSupportsThinking('claude-fable-5-1-20260901')).toBe(true);
  });

  // Opus 5.5 and Fable 5.1 reject both `{type:'disabled'}` and
  // `{type:'enabled', budget_tokens}` with HTTP 400 (probed 2026-09-29), so the
  // adaptive form is the only thinking payload they accept.
  it('emits only the adaptive shape for Opus 5.5 and Fable 5.1', () => {
    for (const id of ['claude-opus-5-5', 'claude-fable-5-1']) {
      const r = resolveThinkingPayload(id, { budgetTokens: 8000 }, 4000);
      expect(r!.thinking).toEqual({ type: 'adaptive' });
    }
  });

  it('is false for Sonnet 4.6 and earlier, haiku, and pre-4.7 opus', () => {
    expect(modelSupportsThinking('claude-sonnet-4-6')).toBe(false);
    expect(modelSupportsThinking('claude-sonnet-4-5')).toBe(false);
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
    // Opus 5 rides the same adaptive-only shape (budget_tokens 400s there too).
    const r5 = resolveThinkingPayload('claude-opus-5', { budgetTokens: 8000 }, 4000);
    expect(r5!.thinking).toEqual({ type: 'adaptive' });
  });

  it('leaves max_tokens untouched — adaptive has no budget to floor against', () => {
    expect(resolveThinkingPayload('claude-opus-4-8', { budgetTokens: 8000 }, 4000)!.maxTokens).toBe(4000);
    expect(resolveThinkingPayload('claude-opus-4-8', { budgetTokens: 8000 }, 32000)!.maxTokens).toBe(32000);
  });

  it('emits adaptive for dated variants, opus-4-7, and sonnet-5 too', () => {
    expect(resolveThinkingPayload('claude-opus-4-7', { budgetTokens: 1 }, 16000)!.thinking).toEqual({ type: 'adaptive' });
    expect(resolveThinkingPayload('claude-opus-4-8-20260501', { budgetTokens: 200 }, 16000)!.thinking).toEqual({ type: 'adaptive' });
    expect(resolveThinkingPayload('claude-sonnet-5', { budgetTokens: 8000 }, 16000)!.thinking).toEqual({ type: 'adaptive' });
  });
});

describe('resolveThinkingOff', () => {
  it('turns Sonnet 5.5 off with between_tools at effort high or below', () => {
    for (const id of ['claude-sonnet-5-5', 'CLAUDE-SONNET-5-5', 'claude-sonnet-5-5-20261001']) {
      expect(resolveThinkingOff(id)).toEqual({ kind: 'send', thinking: { type: 'between_tools' }, maxEffort: 'high' });
    }
  });

  it('turns Opus 5 off with disabled at effort high or below, and Sonnet 5 with disabled at any effort', () => {
    for (const id of ['claude-opus-5', 'claude-opus-5-20260701']) {
      expect(resolveThinkingOff(id)).toEqual({ kind: 'send', thinking: { type: 'disabled' }, maxEffort: 'high' });
    }
    for (const id of ['claude-sonnet-5', 'claude-sonnet-5-20260101']) {
      expect(resolveThinkingOff(id)).toEqual({ kind: 'send', thinking: { type: 'disabled' } });
    }
  });

  it('reports Opus 5.5, Fable and Mythos as always thinking', () => {
    for (const id of ['claude-opus-5-5', 'claude-opus-5-5-20260901', 'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5-1']) {
      expect(resolveThinkingOff(id)).toEqual({ kind: 'always_on' });
    }
  });

  it('omits the field for models that think only when asked, and for unknown ids', () => {
    for (const id of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-nova-9']) {
      expect(resolveThinkingOff(id)).toEqual({ kind: 'omit' });
    }
  });

  it('never builds a thinking-on payload for thinking: false', () => {
    expect(resolveThinkingPayload('claude-opus-5', false, 1000)).toBeNull();
  });
});
