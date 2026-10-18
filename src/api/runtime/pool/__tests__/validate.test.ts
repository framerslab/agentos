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
  it('a Requesty entry is accepted: requesty is a text provider the provider manager builds', () => {
    expect(() => validatePoolOptions(opts({ modelPool: { router: { provider: 'requesty', model: 'openai/gpt-4o', apiKey: 'rq-pool-00000003' } }, agents: { a: { instructions: 'x' } } }), 'sequential')).not.toThrow();
  });
  it('an inherited customModelParams.model or .models, which no provider sends, passes on a pooled seat and on the chair; an own one is rejected', () => {
    // The providers spread customModelParams onto the request, which copies own keys only.
    const inherited = Object.create({ model: 'x', models: ['y'] }) as Record<string, unknown>;
    expect(() => validatePoolOptions(opts({ modelPool: POOL, agents: { a: { instructions: 'x', customModelParams: inherited } } }), 'sequential')).not.toThrow();
    expect(() => validatePoolOptions(opts({ modelPool: POOL, agents: { a: { instructions: 'x' } }, chair: { from: ['opus'], customModelParams: inherited } }), 'panel')).not.toThrow();
    expect(() => validatePoolOptions(opts({ modelPool: POOL, agents: { a: { instructions: 'x', customModelParams: { model: 'x' } } } }), 'sequential')).toThrow(/customModelParams/);
    expect(() => validatePoolOptions(opts({ modelPool: POOL, agents: { a: { instructions: 'x' } }, chair: { from: ['opus'], customModelParams: { models: ['x'] } } }), 'panel')).toThrow(/customModelParams/);
  });
  it("a panel whose quorum.minProviders is above the providers its seats can reach fails construction, with a pool or without one; a fixed seat reaches its own chain's providers and vendors", () => {
    const fixed = { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-oai-00000002', instructions: 'x' };
    const twoOnOpenAI = { a: fixed, b: { ...fixed, instructions: 'y' } };
    expect(() => validatePoolOptions(opts({ agents: twoOnOpenAI, chair: false, quorum: { minProviders: 2 } }), 'panel')).toThrow(/minProviders \(2\)/);
    expect(() => validatePoolOptions(opts({ modelPool: { astra: POOL.astra }, agents: twoOnOpenAI, chair: false, quorum: { minProviders: 2 } }), 'panel')).toThrow(/minProviders \(2\)/);
    // Seat a's own chain can answer for it on Anthropic: two providers and two vendors are within reach.
    const withChain = { a: { ...fixed, fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-00000001' }] }, b: { ...fixed, instructions: 'y' } };
    expect(() => validatePoolOptions(opts({ agents: withChain, chair: false, quorum: { minProviders: 2, minVendors: 2 } }), 'panel')).not.toThrow();
  });
});
