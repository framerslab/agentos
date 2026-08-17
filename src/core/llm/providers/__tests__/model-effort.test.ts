import { describe, it, expect } from 'vitest';
import {
  modelSupportsEffort,
  isEffortLevel,
  EFFORT_LEVELS,
  mapEffortToOpenAiReasoningEffort,
  mapEffortToOpenAiReasoningEffortForModel,
  mapEffortToOpenAiResponsesEffort,
  modelAcceptsXhighResponsesEffort,
  modelAcceptsMaxResponsesEffort,
} from '../model-effort.js';

describe('modelSupportsEffort', () => {
  it('accepts Opus 4.5-4.8, Opus 5, Sonnet 5, Sonnet 4.6, Fable/Mythos 5 (bare + provider-prefixed)', () => {
    for (const m of [
      'claude-opus-4-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'anthropic/claude-opus-4-8',
      'claude-opus-5',
      'anthropic/claude-opus-5',
      'claude-sonnet-5',
      'anthropic/claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-fable-5',
      'claude-mythos-5',
    ]) {
      expect(modelSupportsEffort(m)).toBe(true);
    }
  });

  it('rejects Sonnet 4.5, Haiku 4.5, Opus 4.1, and non-Anthropic ids (sonnet-5 alt does not leak into sonnet-4-5)', () => {
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

describe('mapEffortToOpenAiReasoningEffort', () => {
  it('maps the agentos effort scale to OpenAI reasoning_effort; max -> xhigh', () => {
    expect(mapEffortToOpenAiReasoningEffort('low')).toBe('low');
    expect(mapEffortToOpenAiReasoningEffort('medium')).toBe('medium');
    expect(mapEffortToOpenAiReasoningEffort('high')).toBe('high');
    expect(mapEffortToOpenAiReasoningEffort('xhigh')).toBe('xhigh');
    // xhigh is gpt-5.x's ceiling, so `max` clamps to it (NOT `high`).
    expect(mapEffortToOpenAiReasoningEffort('max')).toBe('xhigh');
  });

  it('returns undefined for unknown / empty / non-string values', () => {
    for (const v of ['ultra', '', 5, null, undefined, {}]) {
      expect(mapEffortToOpenAiReasoningEffort(v)).toBeUndefined();
    }
  });
});

describe('mapEffortToOpenAiResponsesEffort (model-aware /v1/responses effort)', () => {
  it('allow-lists gpt-5.5 for xhigh (live-probed 2026-07-08)', () => {
    expect(modelAcceptsXhighResponsesEffort('gpt-5.5')).toBe(true);
    expect(modelAcceptsXhighResponsesEffort('gpt-5.5-pro')).toBe(true);
    expect(modelAcceptsXhighResponsesEffort('gpt-5.4')).toBe(false);
    expect(modelAcceptsXhighResponsesEffort('gpt-5-mini')).toBe(false);
  });

  it('allow-lists the gpt-5.6 family for xhigh (live-probed 2026-07-14)', () => {
    expect(modelAcceptsXhighResponsesEffort('gpt-5.6')).toBe(true);
    expect(modelAcceptsXhighResponsesEffort('gpt-5.6-sol')).toBe(true);
    // 5.4 and below stay capped — never probed clean.
    expect(modelAcceptsXhighResponsesEffort('gpt-5.4')).toBe(false);
  });

  it('passes xhigh through for gpt-5.5 (max -> xhigh, allow-listed)', () => {
    expect(mapEffortToOpenAiResponsesEffort('gpt-5.5', 'max')).toBe('xhigh');
    expect(mapEffortToOpenAiResponsesEffort('gpt-5.5', 'xhigh')).toBe('xhigh');
  });

  it('passes the real max tier through for the gpt-5.6 family (live-probed 2026-08-06)', () => {
    expect(modelAcceptsMaxResponsesEffort('gpt-5.6')).toBe(true);
    expect(modelAcceptsMaxResponsesEffort('gpt-5.6-sol')).toBe(true);
    expect(mapEffortToOpenAiResponsesEffort('gpt-5.6', 'max')).toBe('max');
    expect(mapEffortToOpenAiResponsesEffort('gpt-5.6-sol', 'max')).toBe('max');
    // xhigh stays xhigh — the unlock only touches the max tier.
    expect(mapEffortToOpenAiResponsesEffort('gpt-5.6-sol', 'xhigh')).toBe('xhigh');
  });

  it('keeps max clamped to xhigh off the allow-list (gpt-5.5) and chat-side everywhere', () => {
    expect(modelAcceptsMaxResponsesEffort('gpt-5.5')).toBe(false);
    expect(modelAcceptsMaxResponsesEffort('gpt-5.4')).toBe(false);
    // Exact-id discipline (0.10.13): unprobed 5.6 siblings stay off the max
    // list and degrade to xhigh like any other xhigh-allow-listed id.
    expect(modelAcceptsMaxResponsesEffort('gpt-5.6-luna')).toBe(false);
    expect(modelAcceptsMaxResponsesEffort('gpt-5.6-terra')).toBe(false);
    expect(modelAcceptsMaxResponsesEffort('gpt-5.6-mini')).toBe(false);
    expect(mapEffortToOpenAiResponsesEffort('gpt-5.6-luna', 'max')).toBe('xhigh');
    expect(mapEffortToOpenAiResponsesEffort('gpt-5.5', 'max')).toBe('xhigh');
    // Chat Completions rejects max for the 5.6 family (probed 2026-07-20 + 2026-08-06).
    expect(mapEffortToOpenAiReasoningEffortForModel('max', 'gpt-5.6')).toBe('xhigh');
  });

  it('caps xhigh -> high for a non-allow-listed gpt-5 model', () => {
    expect(mapEffortToOpenAiResponsesEffort('gpt-5.4', 'max')).toBe('high');
    expect(mapEffortToOpenAiResponsesEffort('gpt-5-mini', 'xhigh')).toBe('high');
  });

  it('leaves low/medium/high untouched regardless of model', () => {
    expect(mapEffortToOpenAiResponsesEffort('gpt-5.4', 'low')).toBe('low');
    expect(mapEffortToOpenAiResponsesEffort('gpt-5.4', 'medium')).toBe('medium');
    expect(mapEffortToOpenAiResponsesEffort('gpt-5.4', 'high')).toBe('high');
  });

  it('returns undefined for no/unknown effort', () => {
    expect(mapEffortToOpenAiResponsesEffort('gpt-5.5', undefined)).toBeUndefined();
    expect(mapEffortToOpenAiResponsesEffort('gpt-5.5', 'ultra')).toBeUndefined();
  });
});
