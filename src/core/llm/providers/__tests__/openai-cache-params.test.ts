/**
 * @fileoverview Capability-table tests for the fail-closed OpenAI
 * prompt-cache retention helper and the quad-mode prompt_cache_key
 * resolver (spec batch-1 C2).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveOpenAiCacheRetentionParams,
  resolvePromptCacheKey,
  type OpenAiCacheRetention,
} from '../openai-cache-params.js';
import { createHash } from 'node:crypto';

describe('resolveOpenAiCacheRetentionParams', () => {
  it.each([
    ['gpt-5.6',            '30m',       { prompt_cache_options: { ttl: '30m' } }],
    ['gpt-5.6-sol',        '30m',       { prompt_cache_options: { ttl: '30m' } }],
    ['gpt-5.6',            '24h',       null],
    ['gpt-5.6',            'in_memory', null],
    ['gpt-5.5',            '24h',       { prompt_cache_retention: '24h' }],
    ['gpt-5.5',            'in_memory', null],
    ['gpt-5.5-pro',        'in_memory', null],
    ['gpt-5.5-pro',        '24h',       { prompt_cache_retention: '24h' }],
    ['gpt-5.4',            '24h',       { prompt_cache_retention: '24h' }],
    ['gpt-5.4',            'in_memory', { prompt_cache_retention: 'in_memory' }],
    ['gpt-5',              '24h',       { prompt_cache_retention: '24h' }],
    ['gpt-5-codex',        '24h',       { prompt_cache_retention: '24h' }],
    ['gpt-5.1-codex',      'in_memory', { prompt_cache_retention: 'in_memory' }],
    ['gpt-4.1',            'in_memory', { prompt_cache_retention: 'in_memory' }],
    ['gpt-4.1-2025-04-14', '24h',       { prompt_cache_retention: '24h' }],
    ['gpt-4o',             '24h',       null],
    ['gpt-4o-mini',        'in_memory', null],
    ['gpt-6-hypothetical', '30m',       null],
    ['gpt-5.5',            '30m',       null],
    ['gpt-5.4x',           '24h',       null], // non-snapshot suffix must not match
  ] as Array<[string, OpenAiCacheRetention, unknown]>)(
    '%s + %s → %j',
    (model, requested, expected) => {
      expect(resolveOpenAiCacheRetentionParams(model, requested)).toEqual(expected);
    },
  );
});

describe('resolvePromptCacheKey', () => {
  const expectedAuto = 'agentos:' + createHash('sha256').update('s-1').digest('hex').slice(0, 16);

  it('absent and false omit the key', () => {
    expect(resolvePromptCacheKey(undefined, 's-1')).toBeUndefined();
    expect(resolvePromptCacheKey(false, 's-1')).toBeUndefined();
  });

  it('auto derives a hashed key from the session id', () => {
    expect(resolvePromptCacheKey('auto', 's-1')).toBe(expectedAuto);
    expect(resolvePromptCacheKey('auto', 's-1')).not.toContain('s-1');
  });

  it('auto without a session id omits', () => {
    expect(resolvePromptCacheKey('auto', undefined)).toBeUndefined();
    expect(resolvePromptCacheKey('auto', '   ')).toBeUndefined();
  });

  it('explicit strings pass verbatim; empty-after-trim omits', () => {
    expect(resolvePromptCacheKey('k-explicit', 's-1')).toBe('k-explicit');
    expect(resolvePromptCacheKey('  k  ', 's-1')).toBe('k');
    expect(resolvePromptCacheKey('   ', 's-1')).toBeUndefined();
  });
});
