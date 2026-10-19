import { afterEach, describe, expect, it, vi } from 'vitest';
import { validatePoolOptions } from '../validate.js';
import { AgencyConfigError, type AgencyOptions } from '../../../types.js';

const POOL = { opus: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-00000001' }, astra: { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-oai-00000002' } };
const opts = (o: Partial<AgencyOptions>): AgencyOptions => ({ agents: {}, ...o });
afterEach(() => vi.unstubAllEnvs());

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
  it('a panel whose quorum.minProviders is above its seat count fails construction: a seat answers with one provider, however many hops its chain holds; a hop with no key anywhere is dropped at seating and is not counted', () => {
    const openai = { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-oai-00000002', instructions: 'x' };
    const anthropicHop = { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-00000001' };
    // One seat, two providers within its reach: one answer per run, so two distinct providers can never answer.
    expect(() => validatePoolOptions(opts({ agents: { a: { ...openai, fallbackProviders: [anthropicHop] } }, chair: false, quorum: { minProviders: 2 } }), 'panel')).toThrow(/minProviders \(2\) is above the 1 /);
    // Two seats on OpenAI; Anthropic is within reach only through a hop with no key, which seating drops.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const keyless = { a: { ...openai, fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }] }, b: { ...openai, instructions: 'y' } };
    expect(() => validatePoolOptions(opts({ agents: keyless, chair: false, quorum: { minProviders: 2 } }), 'panel')).toThrow(/minProviders \(2\) is above the 1 /);
    // The same hop with its key: two seats, two providers.
    expect(() => validatePoolOptions(opts({ agents: { ...keyless, a: { ...openai, fallbackProviders: [anthropicHop] } }, chair: false, quorum: { minProviders: 2 } }), 'panel')).not.toThrow();
  });
  it('the bound is what one assignment of the seats can answer with: a seat that reaches three providers beside two seats on one does not make three, and a hop on the second seat does; the vendors the same way', () => {
    const openai = { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-oai-00000002', instructions: 'x' };
    const anthropicHop = { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-00000001' };
    const geminiHop = { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'gem-00000003' };
    // Three providers within reach and three seats, yet seat a answers with one of them: at most two distinct providers in a run.
    const wide = { a: { ...openai, fallbackProviders: [anthropicHop, geminiHop] }, b: { ...openai, instructions: 'y' }, c: { ...openai, instructions: 'z' } };
    expect(() => validatePoolOptions(opts({ agents: wide, chair: false, quorum: { minProviders: 3 } }), 'panel')).toThrow(/minProviders \(3\) is above the 2 /);
    expect(() => validatePoolOptions(opts({ agents: wide, chair: false, quorum: { minVendors: 3 } }), 'panel')).toThrow(/minVendors \(3\) is above the 2 /);
    expect(() => validatePoolOptions(opts({ agents: wide, chair: false, quorum: { minProviders: 2, minVendors: 2 } }), 'panel')).not.toThrow();
    // Seat b's own hop lets a answer on Gemini, b on Anthropic and c on OpenAI.
    const assignable = { ...wide, b: { ...openai, instructions: 'y', fallbackProviders: [anthropicHop] } };
    expect(() => validatePoolOptions(opts({ agents: assignable, chair: false, quorum: { minProviders: 3, minVendors: 3 } }), 'panel')).not.toThrow();
  });
  it('with both floors set, one assignment of the seats must meet both: a fixed seat answers with its own model or one hop, each with its own vendor, and a hop of unknown vendor adds its provider alone', () => {
    const orKey = 'sk-or-00000016';
    const tgKey = 'tog-00000017';
    // Seat a answers on OpenRouter for Meta or through its hop on Together for Mistral, seat b on OpenRouter for Mistral
    // or through its hop on Together for Meta: two providers, or two vendors, in one run, never both.
    const crossed = {
      a: { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct', apiKey: orKey, instructions: 'x', fallbackProviders: [{ provider: 'together', model: 'mistralai/Mixtral-8x7B-Instruct-v0.1', apiKey: tgKey }] },
      b: { provider: 'openrouter', model: 'mistralai/mistral-large-2411', apiKey: orKey, instructions: 'y', fallbackProviders: [{ provider: 'together', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', apiKey: tgKey }] },
    };
    expect(() => validatePoolOptions(opts({ agents: crossed, chair: false, quorum: { minProviders: 2, minVendors: 2 } }), 'panel')).toThrow(/minProviders \(2\) and quorum\.minVendors \(2\) cannot both be met/);
    // Each floor alone is met by some assignment.
    expect(() => validatePoolOptions(opts({ agents: crossed, chair: false, quorum: { minProviders: 2 } }), 'panel')).not.toThrow();
    expect(() => validatePoolOptions(opts({ agents: crossed, chair: false, quorum: { minVendors: 2 } }), 'panel')).not.toThrow();
    // Seat a's hop is a local Ollama model, whose vendor is unknown: a answers on a second provider with no vendor, or for
    // Meta beside b on OpenRouter for Mistral.
    const localHop = { ...crossed, a: { ...crossed.a, fallbackProviders: [{ provider: 'ollama', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434' }] }, b: { ...crossed.b, fallbackProviders: [] } };
    expect(() => validatePoolOptions(opts({ agents: localHop, chair: false, quorum: { minProviders: 2, minVendors: 2 } }), 'panel')).toThrow(/cannot both be met/);
  });
});
