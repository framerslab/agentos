/**
 * Unit tests for `setProviderPriority` / `getProviderPriority` /
 * `clearProviderPriority`. Integration with `autoDetectProvider()` is
 * covered alongside global-default integration tests in the runtime
 * suite; these tests exercise the registry semantics in isolation.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearProviderPriority,
  getProviderPriority,
  setProviderPriority,
} from '../provider-priority.js';

describe('provider-priority registry', () => {
  afterEach(() => clearProviderPriority());

  it('returns undefined by default', () => {
    expect(getProviderPriority()).toBeUndefined();
  });

  it('round-trips a list of known providers', () => {
    setProviderPriority(['anthropic', 'openai', 'ollama']);
    expect(getProviderPriority()).toEqual(['anthropic', 'openai', 'ollama']);
  });

  it('clears via undefined argument', () => {
    setProviderPriority(['openai']);
    setProviderPriority(undefined);
    expect(getProviderPriority()).toBeUndefined();
  });

  it('clears via clearProviderPriority()', () => {
    setProviderPriority(['openai']);
    clearProviderPriority();
    expect(getProviderPriority()).toBeUndefined();
  });

  it('accepts an empty list (caller opts out of auto-detect)', () => {
    setProviderPriority([]);
    expect(getProviderPriority()).toEqual([]);
  });

  it('throws on unknown provider id with a helpful message', () => {
    expect(() => setProviderPriority(['anthropic', 'made-up-provider'])).toThrowError(
      /Unknown provider\(s\) in priority list: made-up-provider/
    );
  });

  it('throws on multiple unknown providers and lists all of them', () => {
    expect(() => setProviderPriority(['fake-one', 'fake-two'])).toThrowError(
      /fake-one, fake-two/
    );
  });

  it('rejects unknowns without mutating prior state', () => {
    setProviderPriority(['openai', 'anthropic']);
    expect(() => setProviderPriority(['fake'])).toThrow();
    expect(getProviderPriority()).toEqual(['openai', 'anthropic']);
  });
});
