import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveModelOption, knownProviderPrefixOf, routedProviderOf } from '../../model.js';
import { mergeDefaults } from '../strategies/shared.js';
import type { AgencyOptions } from '../../types.js';

afterEach(() => vi.unstubAllEnvs());

describe('a colon in a model id', () => {
  it('never splits under provider ollama', () => {
    expect(resolveModelOption({ provider: 'ollama', model: 'qwen2.5:7b' })).toEqual({ providerId: 'ollama', modelId: 'qwen2.5:7b' });
    expect(resolveModelOption({ provider: 'ollama', model: 'mistral:7b' })).toEqual({ providerId: 'ollama', modelId: 'mistral:7b' });
    expect(resolveModelOption({ provider: 'ollama', model: 'anthropic:claude' })).toEqual({ providerId: 'ollama', modelId: 'anthropic:claude' });
  });
  it('keeps an OpenRouter id with a :free suffix whole', () => {
    expect(resolveModelOption({ provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' })).toEqual({ providerId: 'openrouter', modelId: 'meta-llama/llama-3.3-70b-instruct:free' });
  });
  it('drops a slash prefix that repeats the explicit provider, from a colon id too', () => {
    expect(resolveModelOption({ provider: 'openrouter', model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free' })).toEqual({ providerId: 'openrouter', modelId: 'meta-llama/llama-3.3-70b-instruct:free' });
    expect(resolveModelOption({ provider: 'ollama', model: 'ollama/qwen2.5:7b' })).toEqual({ providerId: 'ollama', modelId: 'qwen2.5:7b' });
    expect(routedProviderOf({ provider: 'openrouter', model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free' })).toBe('openrouter');
  });
  it('splits a known provider prefix with no provider, and whatever provider says', () => {
    expect(resolveModelOption({ model: 'openai:gpt-6-astra' })).toEqual({ providerId: 'openai', modelId: 'gpt-6-astra' });
    expect(resolveModelOption({ provider: 'openai', model: 'anthropic:claude-opus-5-5' })).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-5-5' });
  });
  it('splits a media provider prefix on an image call', () => {
    expect(resolveModelOption({ model: 'stability:stable-image-core' }, 'image')).toEqual({ providerId: 'stability', modelId: 'stable-image-core' });
  });
  it('keeps an unknown prefix whole and takes the explicit provider', () => {
    expect(resolveModelOption({ provider: 'openai', model: 'ft:gpt-4.1:org:suffix' })).toEqual({ providerId: 'openai', modelId: 'ft:gpt-4.1:org:suffix' });
  });
  it('an unknown prefix with no provider is rejected, never auto-detected', () => {
    // Auto-detection would send an Ollama tag, and the detected vendor's key, to that vendor.
    vi.stubEnv('OPENAI_API_KEY', 'sk-x');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(() => resolveModelOption({ model: 'ft:gpt-4.1:org:suffix' })).toThrow(/not a provider agentos knows/);
    expect(() => resolveModelOption({ model: 'qwen2.5:7b' })).toThrow(/provider: 'ollama'/);
    // A slash id with an unknown colon suffix stays whole, so it is rejected
    // without a provider and goes to the gateway with one.
    expect(() => resolveModelOption({ model: 'openai/gpt-4o:free' })).toThrow(/not a provider agentos knows/);
    expect(resolveModelOption({ provider: 'openrouter', model: 'openai/gpt-4o:free' })).toEqual({ providerId: 'openrouter', modelId: 'openai/gpt-4o:free' });
    expect(routedProviderOf({ model: 'openai/gpt-4o:free' })).toBeUndefined();
  });
  it('routedProviderOf names the provider a call goes to, without auto-detection', () => {
    expect(routedProviderOf({ model: 'anthropic:claude-opus-5-5' })).toBe('anthropic');
    expect(routedProviderOf({ provider: 'openai', model: 'anthropic:claude-opus-5-5' })).toBe('anthropic');
    expect(routedProviderOf({ model: 'anthropic/claude-sonnet-5-5' })).toBe('anthropic');
    expect(routedProviderOf({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5-5' })).toBe('openrouter');
    expect(routedProviderOf({ provider: 'ollama', model: 'mistral:7b' })).toBe('ollama');
    expect(routedProviderOf({ provider: 'gemini', model: 'gemini-3.1-pro' })).toBe('gemini');
    expect(routedProviderOf({ model: 'gpt-4.1' })).toBeUndefined();
  });
  it('rejects a colon with nothing on one side, except under ollama', () => {
    expect(() => resolveModelOption({ provider: 'openai', model: 'openai:' })).toThrow(/Invalid model/);
    expect(() => resolveModelOption({ provider: 'openai', model: ':gpt-4.1' })).toThrow(/Invalid model/);
    expect(resolveModelOption({ provider: 'ollama', model: 'llama3:' })).toEqual({ providerId: 'ollama', modelId: 'llama3:' });
  });
  it('knownProviderPrefixOf reads the table', () => {
    expect(knownProviderPrefixOf('anthropic:claude-opus-5-5')).toBe('anthropic');
    expect(knownProviderPrefixOf('qwen2.5:7b')).toBeUndefined();
    expect(knownProviderPrefixOf('gpt-4.1')).toBeUndefined();
  });
});

describe('mergeDefaults and a prefixed seat model', () => {
  const agencyOpts = (provider: string) => ({ agents: {}, provider, model: 'x' }) as unknown as AgencyOptions;
  it('does not hand the agency provider to a seat whose model names a provider', () => {
    const merged = mergeDefaults({ model: 'anthropic:claude-opus-5-5' }, agencyOpts('ollama'));
    expect(merged.provider).toBeUndefined();
    expect(merged.model).toBe('anthropic:claude-opus-5-5');
    expect(resolveModelOption(merged)).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-5-5' });
  });
  it('still hands it to a seat with a plain or unknown-prefix model', () => {
    expect(mergeDefaults({ model: 'qwen2.5:7b' }, agencyOpts('ollama')).provider).toBe('ollama');
    expect(mergeDefaults({ model: 'gpt-4.1' }, agencyOpts('openai')).provider).toBe('openai');
    expect(mergeDefaults({ provider: 'xai', model: 'anthropic:x' }, agencyOpts('openai')).provider).toBe('xai');
  });
  it("does not hand the agency's key or URL to a seat whose model names another provider", () => {
    const openaiAgency = { agents: {}, provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-openai', baseUrl: 'https://proxy.local/v1' } as unknown as AgencyOptions;
    const other = mergeDefaults({ model: 'anthropic:claude-opus-5-5' }, openaiAgency);
    expect(other.apiKey).toBeUndefined();
    expect(other.baseUrl).toBeUndefined();
    // The seat's own key and URL always win.
    expect(mergeDefaults({ model: 'anthropic:claude-opus-5-5', apiKey: 'sk-ant' }, openaiAgency).apiKey).toBe('sk-ant');
    // The same provider, or an agency whose provider is unknown, still shares its key and URL.
    const anthropicAgency = { agents: {}, provider: 'anthropic', apiKey: 'sk-ant-agency' } as unknown as AgencyOptions;
    expect(mergeDefaults({ model: 'anthropic:claude-opus-5-5' }, anthropicAgency).apiKey).toBe('sk-ant-agency');
    const keyOnly = { agents: {}, apiKey: 'sk-any' } as unknown as AgencyOptions;
    expect(mergeDefaults({ model: 'openai:gpt-4.1' }, keyOnly).apiKey).toBe('sk-any');
  });
  it('withholds the agency key from a seat whose own provider or slash prefix goes elsewhere, and keeps it for a gateway id', () => {
    const openaiAgency = { agents: {}, provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-openai', baseUrl: 'https://proxy.local/v1' } as unknown as AgencyOptions;
    const explicit = mergeDefaults({ provider: 'anthropic', model: 'claude-opus-5-5' }, openaiAgency);
    expect(explicit.apiKey).toBeUndefined();
    expect(explicit.baseUrl).toBeUndefined();
    expect(mergeDefaults({ provider: 'openai', model: 'gpt-4.1-mini' }, openaiAgency).apiKey).toBe('sk-openai');
    const routerAgency = { agents: {}, model: 'openrouter:openai/gpt-4o', apiKey: 'sk-or' } as unknown as AgencyOptions;
    expect(mergeDefaults({ model: 'anthropic/claude-sonnet-5-5' }, routerAgency).apiKey).toBeUndefined();
    const gateway = { agents: {}, provider: 'openrouter', apiKey: 'sk-or' } as unknown as AgencyOptions;
    const viaGateway = mergeDefaults({ model: 'anthropic/claude-sonnet-5-5' }, gateway);
    expect(viaGateway.provider).toBe('openrouter');
    expect(viaGateway.apiKey).toBe('sk-or');
  });
  it('reads a seat provider set explicitly to undefined as set, as the merged config does', () => {
    const openaiAgency = { agents: {}, provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-openai', baseUrl: 'https://proxy.local/v1' } as unknown as AgencyOptions;
    const merged = mergeDefaults({ model: 'claude-opus-5-5', provider: undefined } as never, openaiAgency);
    // The spread keeps the explicit undefined, so the seat goes to auto-detection, which may pick any vendor.
    expect(merged.provider).toBeUndefined();
    expect(merged.apiKey).toBeUndefined();
    expect(merged.baseUrl).toBeUndefined();
  });
  it('withholds the agency key from a plain-model seat when the agency names its provider only by a model prefix', () => {
    const prefixAgency = { agents: {}, model: 'openai:gpt-4.1', apiKey: 'sk-openai', baseUrl: 'https://proxy.local/v1' } as unknown as AgencyOptions;
    // The plain model goes to auto-detection, which may pick another vendor.
    const plain = mergeDefaults({ model: 'gpt-4.1-mini' }, prefixAgency);
    expect(plain.provider).toBeUndefined();
    expect(plain.apiKey).toBeUndefined();
    expect(plain.baseUrl).toBeUndefined();
    // A seat that names the agency's provider, by prefix or by `provider`, shares the key.
    expect(mergeDefaults({ model: 'openai:gpt-4.1-mini' }, prefixAgency).apiKey).toBe('sk-openai');
    expect(mergeDefaults({ provider: 'openai', model: 'gpt-4.1-mini' }, prefixAgency).apiKey).toBe('sk-openai');
    // A seat with no model of its own runs the agency's model, and keeps its key.
    expect(mergeDefaults({}, prefixAgency).apiKey).toBe('sk-openai');
  });
  it('compares the providers resolveModelOption picks: a model prefix wins over provider, except under ollama', () => {
    const openaiAgency = { agents: {}, provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-openai' } as unknown as AgencyOptions;
    // The seat says openai but its model routes to Anthropic: the OpenAI key stays behind.
    expect(mergeDefaults({ provider: 'openai', model: 'anthropic:claude-opus-5-5' }, openaiAgency).apiKey).toBeUndefined();
    // An agency whose own model routes to Anthropic shares its key with an Anthropic seat.
    const routedAgency = { agents: {}, provider: 'openai', model: 'anthropic:claude-opus-5-5', apiKey: 'sk-ant-agency' } as unknown as AgencyOptions;
    expect(mergeDefaults({ model: 'anthropic:claude-opus-5-5' }, routedAgency).apiKey).toBe('sk-ant-agency');
    // Under ollama a colon never splits, so the seat stays on ollama and keeps the agency's URL.
    const ollamaAgency = { agents: {}, provider: 'ollama', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434' } as unknown as AgencyOptions;
    expect(mergeDefaults({ provider: 'ollama', model: 'mistral:7b' }, ollamaAgency).baseUrl).toBe('http://127.0.0.1:11434');
  });
});
