import { afterEach, describe, expect, it, vi } from 'vitest';
import { vendorOf, makerOfHostedModel, sameModelId, normalizeVendor } from '../vendor.js';

afterEach(() => vi.unstubAllEnvs());

describe('vendorOf', () => {
  it.each([
    ['anthropic', 'claude-opus-5-5', 'anthropic'], ['claude-code-cli', 'claude-sonnet-4-6', 'anthropic'], ['openai', 'gpt-6-astra', 'openai'],
    ['gemini', 'gemini-3.1-pro-preview', 'google'], ['gemini', 'models/gemini-2.5-flash', 'google'], ['gemini-cli', 'gemini-3.5-flash', 'google'],
    ['xai', 'grok-4', 'xai'], ['mistral', 'mistral-large-latest', 'mistral'],
    ['openrouter', 'anthropic/claude-opus-5-5', 'anthropic'], ['openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 'meta'], ['openrouter', 'x-ai/grok-4', 'xai'],
    ['together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta'], ['together', 'mistralai/Mixtral-8x7B', 'mistral'], ['groq', 'openai/gpt-oss-120b', 'openai'],
  ])('%s %s is %s', (provider, model, vendor) => {
    expect(vendorOf(provider, model)).toBe(vendor);
  });
  it.each([['openrouter', 'openrouter/auto'], ['openrouter', 'gpt-4o'], ['groq', 'llama-3.3-70b-versatile'], ['ollama', 'llama3.2'], ['ollama', 'mistral:7b']])('%s %s is unknown', (provider, model) => {
    expect(vendorOf(provider, model)).toBeUndefined();
  });
  it('a declared vendor wins, in any letter case and through the alias table', () => {
    expect(vendorOf('ollama', 'llama3.2', { vendor: 'Meta' })).toBe('meta');
    expect(vendorOf('together', 'meta-llama/x', { vendor: 'meta-llama' })).toBe('meta');
    expect(vendorOf('groq', 'x', { vendor: 'Alibaba' })).toBe('alibaba');
  });
  it('a custom base URL, from the config or from the provider URL variable, makes a native provider unknown', () => {
    expect(vendorOf('openai', 'gpt-4.1', { baseUrl: 'https://proxy.local/v1' })).toBeUndefined();
    expect(vendorOf('openai', 'gpt-4.1', { baseUrl: 'https://api.openai.com/v1' })).toBe('openai');
    vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.local/v1');
    expect(vendorOf('openai', 'gpt-4.1')).toBeUndefined();
    expect(vendorOf('anthropic', 'claude-opus-5-5')).toBe('anthropic');
  });
});

describe('helpers', () => {
  it('reads the maker prefix of a hosted model', () => {
    expect(makerOfHostedModel('mistralai/mistral-large')).toBe('mistral');
    expect(makerOfHostedModel('openrouter/auto')).toBeUndefined();
    expect(makerOfHostedModel('plain')).toBeUndefined();
  });
  it('equates model ids by the text after the last slash, ignoring case', () => {
    expect(sameModelId('gpt-6-astra', 'openai/gpt-6-astra')).toBe(true);
    expect(sameModelId('GPT-6-Astra', 'gpt-6-astra')).toBe(true);
    expect(sameModelId('gpt-6-astra', 'gpt-6-luna')).toBe(false);
  });
  it('normalizes vendor names', () => {
    expect(normalizeVendor('X-AI')).toBe('xai');
    expect(normalizeVendor('Google')).toBe('google');
  });
});
