import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveModelOption, knownProviderPrefixOf } from '../../model.js';
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
  it('an unknown prefix with no provider auto-detects', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-x');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(resolveModelOption({ model: 'ft:gpt-4.1:org:suffix' })).toEqual({ providerId: 'openai', modelId: 'ft:gpt-4.1:org:suffix' });
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
