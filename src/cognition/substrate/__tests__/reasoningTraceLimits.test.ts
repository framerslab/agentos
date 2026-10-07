import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REASONING_TRACE_MAX_ENTRIES,
  DEFAULT_REASONING_TRACE_MAX_MESSAGE_LENGTH,
  resolveReasoningTraceLimits,
} from '../reasoningTraceLimits';

describe('resolveReasoningTraceLimits', () => {
  it('falls back to the constants', () => {
    expect(resolveReasoningTraceLimits()).toEqual({ maxEntries: DEFAULT_REASONING_TRACE_MAX_ENTRIES, maxMessageLength: DEFAULT_REASONING_TRACE_MAX_MESSAGE_LENGTH });
    expect(DEFAULT_REASONING_TRACE_MAX_ENTRIES).toBe(500);
  });
  it('prefers the persona, then the runtime default', () => {
    expect(resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: 3 } }, { defaultReasoningTraceMaxEntries: 7 }).maxEntries).toBe(3);
    expect(resolveReasoningTraceLimits({}, { defaultReasoningTraceMaxEntries: 7 }).maxEntries).toBe(7);
    expect(resolveReasoningTraceLimits({ reasoningTraceConfig: { maxMessageLength: 10 } }).maxMessageLength).toBe(10);
  });
  it('ignores values that are not positive integers', () => {
    expect(resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: 0 } }, { defaultReasoningTraceMaxEntries: 2.5 }).maxEntries).toBe(500);
    expect(resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: -1 } }, { defaultReasoningTraceMaxEntries: 9 }).maxEntries).toBe(9);
  });
});
