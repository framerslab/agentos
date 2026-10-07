import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REASONING_TRACE_MAX_ENTRIES,
  DEFAULT_REASONING_TRACE_MAX_MESSAGE_LENGTH,
  REASONING_TRACE_MAX_ENTRIES_CEILING,
  REASONING_TRACE_MAX_MESSAGE_LENGTH_CEILING,
  resolveReasoningTraceLimits,
} from '../reasoningTraceLimits';

describe('resolveReasoningTraceLimits', () => {
  it('falls back to the constants', () => {
    expect(resolveReasoningTraceLimits()).toEqual({ maxEntries: DEFAULT_REASONING_TRACE_MAX_ENTRIES, maxMessageLength: DEFAULT_REASONING_TRACE_MAX_MESSAGE_LENGTH, ignored: [] });
    expect(DEFAULT_REASONING_TRACE_MAX_ENTRIES).toBe(500);
  });
  it('prefers the persona, then the runtime default', () => {
    expect(resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: 3 } }, { defaultReasoningTraceMaxEntries: 7 }).maxEntries).toBe(3);
    expect(resolveReasoningTraceLimits({}, { defaultReasoningTraceMaxEntries: 7 }).maxEntries).toBe(7);
    expect(resolveReasoningTraceLimits({ reasoningTraceConfig: { maxMessageLength: 10 } }).maxMessageLength).toBe(10);
  });
  it('ignores values that are not positive integers and lists them', () => {
    const r = resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: 0 } }, { defaultReasoningTraceMaxEntries: 2.5 });
    expect(r.maxEntries).toBe(500);
    expect(r.ignored.map((i) => `${i.source}.${i.key}:${i.reason}`)).toEqual(['persona.maxEntries:not_a_positive_integer', 'config.maxEntries:not_a_positive_integer']);
    expect(resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: -1 } }, { defaultReasoningTraceMaxEntries: 9 }).maxEntries).toBe(9);
  });
  it('records a non-serialisable value in a JSON-safe form', () => {
    const r = resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: 1n as unknown as number } });
    expect(r.maxEntries).toBe(500);
    expect(r.ignored[0]?.value).toBe('1');
    expect(() => JSON.stringify(r.ignored)).not.toThrow();
  });
  it('clamps to the ceilings', () => {
    const r = resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: 1_000_000, maxMessageLength: 1_000_000 } });
    expect(r.maxEntries).toBe(REASONING_TRACE_MAX_ENTRIES_CEILING);
    expect(r.maxMessageLength).toBe(REASONING_TRACE_MAX_MESSAGE_LENGTH_CEILING);
    expect(r.ignored.every((i) => i.reason === 'above_ceiling')).toBe(true);
  });
});
