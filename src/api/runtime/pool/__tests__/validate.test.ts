import { describe, expect, it } from 'vitest';
import { validatePoolOptions } from '../validate.js';
import { AgencyConfigError, type AgencyOptions } from '../../../types.js';

const POOL = { opus: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-00000001' }, astra: { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-oai-00000002' } };
const opts = (o: Partial<AgencyOptions>): AgencyOptions => ({ agents: {}, ...o });

describe('validatePoolOptions', () => {
  it('an Ollama tag named after a provider is a plain id there; the same prefix on another provider is rejected', () => {
    expect(() => validatePoolOptions(opts({ modelPool: { local: { provider: 'ollama', model: 'mistral:7b', baseUrl: 'http://127.0.0.1:11434' } }, agents: { a: { instructions: 'x' } } }), 'sequential')).not.toThrow();
    expect(() => validatePoolOptions(opts({ modelPool: { bad: { provider: 'openai', model: 'anthropic:claude-opus-5-5' } }, agents: { a: { instructions: 'x' } } }), 'sequential')).toThrow(/carries a provider prefix/);
  });
  it('a pooled seat that holds apiKey, baseUrl, fallbackProviders or onFallback is rejected, even with the value undefined', () => {
    for (const k of ['apiKey', 'baseUrl', 'fallbackProviders', 'onFallback']) {
      expect(() => validatePoolOptions(opts({ modelPool: POOL, agents: { a: { instructions: 'x', [k]: undefined } } as never }), 'sequential'), k).toThrow(AgencyConfigError);
    }
  });
  it('a fixed seat in a pooled agency is resolved at construction: a model prefix that disagrees with its provider is rejected', () => {
    expect(() => validatePoolOptions(opts({ modelPool: POOL, agents: { a: { provider: 'xai', model: 'anthropic:claude-opus-5-5' } } }), 'sequential')).toThrow(/names provider "anthropic"/);
  });
});
