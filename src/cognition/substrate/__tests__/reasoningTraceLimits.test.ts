import { describe, expect, it } from 'vitest';
import type { IPersonaDefinition } from '../personas/IPersonaDefinition';
import {
  DEFAULT_REASONING_TRACE_MAX_ENTRIES,
  DEFAULT_REASONING_TRACE_MAX_MESSAGE_LENGTH,
  REASONING_TRACE_MAX_ENTRIES_CEILING,
  REASONING_TRACE_MAX_MESSAGE_LENGTH_CEILING,
  REASONING_TRACE_MIN_ENTRIES,
  resolveReasoningTraceLimits,
  toJsonSafe,
} from '../reasoningTraceLimits';

type TraceField = IPersonaDefinition['reasoningTraceConfig'];

describe('resolveReasoningTraceLimits', () => {
  it('falls back to the constants', () => {
    expect(resolveReasoningTraceLimits()).toEqual({ maxEntries: DEFAULT_REASONING_TRACE_MAX_ENTRIES, maxMessageLength: DEFAULT_REASONING_TRACE_MAX_MESSAGE_LENGTH, ignored: [] });
    expect(DEFAULT_REASONING_TRACE_MAX_ENTRIES).toBe(500);
  });
  it('prefers the persona, then the runtime default', () => {
    expect(resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: 25 } }, { defaultReasoningTraceMaxEntries: 40 }).maxEntries).toBe(25);
    expect(resolveReasoningTraceLimits({}, { defaultReasoningTraceMaxEntries: 40 }).maxEntries).toBe(40);
    expect(resolveReasoningTraceLimits({ reasoningTraceConfig: { maxMessageLength: 10 } }).maxMessageLength).toBe(10);
  });
  it('ignores values that are not positive integers and lists them', () => {
    const r = resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: 0 } }, { defaultReasoningTraceMaxEntries: 2.5 });
    expect(r.maxEntries).toBe(500);
    expect(r.ignored.map((i) => `${i.source}.${i.key}:${i.reason}`)).toEqual(['persona.maxEntries:not_a_positive_integer', 'config.maxEntries:not_a_positive_integer']);
    expect(resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: -1 } }, { defaultReasoningTraceMaxEntries: 30 }).maxEntries).toBe(30);
  });
  it('raises an entry cap below the floor and records it', () => {
    const r = resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: 1 } });
    expect(r.maxEntries).toBe(REASONING_TRACE_MIN_ENTRIES);
    expect(r.ignored).toEqual([{ source: 'persona', key: 'maxEntries', value: 1, reason: 'below_floor' }]);
    expect(resolveReasoningTraceLimits({ reasoningTraceConfig: { maxMessageLength: 1 } }).ignored).toEqual([]);
  });
  it('clamps to the ceilings', () => {
    const r = resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: 1_000_000, maxMessageLength: 1_000_000 } });
    expect(r.maxEntries).toBe(REASONING_TRACE_MAX_ENTRIES_CEILING);
    expect(r.maxMessageLength).toBe(REASONING_TRACE_MAX_MESSAGE_LENGTH_CEILING);
    expect(r.ignored.map((i) => i.reason)).toEqual(['above_ceiling', 'above_ceiling']);
  });
  it('reports an overridden runtime value that is above the ceiling', () => {
    const r = resolveReasoningTraceLimits({ reasoningTraceConfig: { maxEntries: 25 } }, { defaultReasoningTraceMaxEntries: 50_000 });
    expect(r.maxEntries).toBe(25);
    expect(r.ignored).toEqual([{ source: 'config', key: 'maxEntries', value: 50_000, reason: 'above_ceiling' }]);
  });
  it('reports a persona field that is not an object and falls through to the runtime default', () => {
    for (const bad of [200, '200', null, [25]]) {
      const r = resolveReasoningTraceLimits({ reasoningTraceConfig: bad as unknown as TraceField }, { defaultReasoningTraceMaxEntries: 30 });
      expect(r.maxEntries).toBe(30);
      expect(r.ignored).toEqual([{ source: 'persona', key: 'reasoningTraceConfig', value: toJsonSafe(bad), reason: 'not_an_object' }]);
    }
  });
  it('reports unknown keys', () => {
    const r = resolveReasoningTraceLimits({ reasoningTraceConfig: { max_entries: 50 } as unknown as TraceField });
    expect(r.maxEntries).toBe(500);
    expect(r.ignored).toEqual([{ source: 'persona', key: 'max_entries', value: 50, reason: 'unknown_key' }]);
  });
  it('records every value in a JSON-safe form', () => {
    expect(toJsonSafe(1n)).toBe('1');
    expect(toJsonSafe(Number.NaN)).toBe('NaN');
    expect(toJsonSafe(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(toJsonSafe(Object.create(null))).toBe('[unserializable]');
    expect(toJsonSafe(Symbol('s'))).toBe('Symbol(s)');
    const r = resolveReasoningTraceLimits(
      { reasoningTraceConfig: { maxEntries: Number.NaN, maxMessageLength: Object.create(null) } as unknown as TraceField },
      { defaultReasoningTraceMaxEntries: Number.POSITIVE_INFINITY },
    );
    expect(r.ignored.map((i) => i.value)).toEqual(['NaN', 'Infinity', '[unserializable]']);
    expect(() => JSON.stringify(r.ignored)).not.toThrow();
  });
});
