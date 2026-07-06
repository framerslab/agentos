/**
 * @file model-strict-tool-use.test.ts
 * @description Pins the strict-tool-use capability allowlist. A new Claude
 *              family must get an explicit, reviewed entry here — silently
 *              inheriting `strict: true` (or silently losing it) is how a
 *              whole model generation either 400s on every structured call
 *              or quietly drops schema enforcement.
 */
import { describe, expect, it } from 'vitest';
import { modelSupportsStrictToolUse } from '../model-strict-tool-use';

describe('modelSupportsStrictToolUse', () => {
  it('accepts the 4.5-generation launch models', () => {
    expect(modelSupportsStrictToolUse('claude-sonnet-4-5')).toBe(true);
    expect(modelSupportsStrictToolUse('claude-opus-4-5')).toBe(true);
    expect(modelSupportsStrictToolUse('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('accepts the later opus point releases and the 5.x families', () => {
    expect(modelSupportsStrictToolUse('claude-opus-4-6')).toBe(true);
    expect(modelSupportsStrictToolUse('claude-opus-4-8')).toBe(true);
    expect(modelSupportsStrictToolUse('claude-sonnet-5')).toBe(true);
    expect(modelSupportsStrictToolUse('claude-fable-5')).toBe(true);
    expect(modelSupportsStrictToolUse('claude-fable-5-20260601')).toBe(true);
  });

  it('rejects pre-4.5 models that 400 on the unknown strict field', () => {
    expect(modelSupportsStrictToolUse('claude-sonnet-4-20250514')).toBe(false);
    expect(modelSupportsStrictToolUse('claude-opus-4-1')).toBe(false);
    expect(modelSupportsStrictToolUse('claude-3-5-sonnet-20241022')).toBe(false);
    expect(modelSupportsStrictToolUse('claude-3-haiku-20240307')).toBe(false);
  });

  it('does not false-positive on lookalike ids', () => {
    expect(modelSupportsStrictToolUse('claude-sonnet-4-50')).toBe(false);
    expect(modelSupportsStrictToolUse('gpt-4o')).toBe(false);
    expect(modelSupportsStrictToolUse('')).toBe(false);
  });
});
