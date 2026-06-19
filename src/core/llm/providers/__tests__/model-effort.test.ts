import { describe, it, expect } from 'vitest';
import { modelSupportsEffort, isEffortLevel, EFFORT_LEVELS } from '../model-effort.js';

describe('modelSupportsEffort', () => {
  it('accepts Opus 4.5-4.8, Sonnet 4.6, Fable/Mythos 5 (bare + provider-prefixed)', () => {
    for (const m of [
      'claude-opus-4-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'anthropic/claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-fable-5',
      'claude-mythos-5',
    ]) {
      expect(modelSupportsEffort(m)).toBe(true);
    }
  });

  it('rejects Sonnet 4.5, Haiku 4.5, Opus 4.1, and non-Anthropic ids', () => {
    for (const m of [
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-opus-4-1',
      'gpt-5',
      'meta-llama/llama-3.3-70b-instruct',
    ]) {
      expect(modelSupportsEffort(m)).toBe(false);
    }
  });
});

describe('isEffortLevel', () => {
  it('validates the five levels and rejects everything else', () => {
    for (const e of EFFORT_LEVELS) expect(isEffortLevel(e)).toBe(true);
    for (const e of ['ultra', '', 5, null, undefined, {}]) expect(isEffortLevel(e)).toBe(false);
  });
});
