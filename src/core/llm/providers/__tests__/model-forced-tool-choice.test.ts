import { describe, it, expect } from 'vitest';
import { modelSupportsForcedToolChoice } from '../model-forced-tool-choice';

/**
 * Regression pin for the Claude models that reject a forced `tool_choice`
 * (`{type:'any'}` or `{type:'tool'}`).
 *
 * The boundary that matters is `claude-opus-5`, which accepts a forced choice,
 * against `claude-opus-5-5`, which returns HTTP 400. They are separate models
 * with different contracts, so a family prefix such as `/^claude-opus-5\b/`
 * would wrongly deny Opus 5 too, and these cases fail if the pattern is ever
 * widened that way. The Opus 5, Opus 5.5 and Fable 5.1 expectations match a
 * live probe of the Messages API on 2026-09-29.
 */
describe('modelSupportsForcedToolChoice', () => {
  it('denies Claude Fable 5 and 5.1, including dated variants', () => {
    expect(modelSupportsForcedToolChoice('claude-fable-5')).toBe(false);
    expect(modelSupportsForcedToolChoice('claude-fable-5-20260601')).toBe(false);
    expect(modelSupportsForcedToolChoice('claude-fable-5-1')).toBe(false);
    expect(modelSupportsForcedToolChoice('claude-fable-5-1-20260901')).toBe(false);
  });

  it('denies Claude Opus 5.5', () => {
    expect(modelSupportsForcedToolChoice('claude-opus-5-5')).toBe(false);
    expect(modelSupportsForcedToolChoice('claude-opus-5-5-20260901')).toBe(false);
  });

  it('allows Claude Opus 5, which Opus 5.5 must stay distinct from', () => {
    expect(modelSupportsForcedToolChoice('claude-opus-5')).toBe(true);
    expect(modelSupportsForcedToolChoice('claude-opus-5-20260701')).toBe(true);
  });

  // Sonnet 5.5 returns HTTP 400 on {type:'tool'} and {type:'any'} (probed
  // 2026-09-30) while Sonnet 5 accepts both, so the same boundary applies.
  it('denies Claude Sonnet 5.5 and Claude Mythos 5.1 and still allows Claude Sonnet 5', () => {
    expect(modelSupportsForcedToolChoice('claude-sonnet-5-5')).toBe(false);
    expect(modelSupportsForcedToolChoice('claude-sonnet-5-5-20261001')).toBe(false);
    expect(modelSupportsForcedToolChoice('CLAUDE-SONNET-5-5')).toBe(false);
    expect(modelSupportsForcedToolChoice('claude-mythos-5-1')).toBe(false);
    expect(modelSupportsForcedToolChoice('claude-sonnet-5')).toBe(true);
    expect(modelSupportsForcedToolChoice('claude-sonnet-5-20260101')).toBe(true);
  });

  it('allows every other current family', () => {
    for (const id of [
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-haiku-4-5-20251001',
    ]) {
      expect(modelSupportsForcedToolChoice(id)).toBe(true);
    }
  });

  it('is case-insensitive and anchored at the start', () => {
    expect(modelSupportsForcedToolChoice('CLAUDE-OPUS-5-5')).toBe(false);
    expect(modelSupportsForcedToolChoice('CLAUDE-FABLE-5-1')).toBe(false);
    // Both call sites pass a bare Anthropic-side id: AnthropicProvider reads
    // its own modelId, and buildResponseFormatForProvider reaches this guard
    // only inside its providerId === 'anthropic' branch. An OpenRouter-routed
    // Claude model takes the 'openrouter' branch and never arrives here. This
    // case documents the anchor so a future caller passing a prefixed id
    // fails a test first.
    expect(modelSupportsForcedToolChoice('anthropic/claude-opus-5-5')).toBe(true);
  });
});
