/**
 * coordinatorRoute: the route a launched team's manager and synthesizers call generateText on, on the full runtime.
 * Unless the host's coordinator names a key or a base URL of its own, it takes the key of the entry the runtime serves
 * its provider from, sent where the runtime's provider sends it, so generateText adds no key or base URL of its own to
 * either. Pure logic over a lookup of the served entry.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfigEntry } from '../../../../core/llm/providers/AIModelProviderManager.js';
import { MISTRAL_DEFAULT_BASE_URL } from '../../../../core/llm/providers/implementations/MistralProvider.js';
import { OPENAI_DEFAULT_BASE_URL } from '../../../../core/llm/providers/implementations/OpenAIProvider.js';
import { OPENROUTER_DEFAULT_BASE_URL } from '../../../../core/llm/providers/implementations/OpenRouterProvider.js';
import { REQUESTY_DEFAULT_BASE_URL } from '../../../../core/llm/providers/implementations/RequestyProvider.js';
import { coordinatorRoute } from '../runtimeLaunchTool.js';

const entry = (providerId: string, config: Record<string, unknown>): ProviderConfigEntry => ({ providerId, enabled: true, config });
/** The lookup of the entry the runtime serves a provider from, over the entries it serves, one per provider. */
const served = (...entries: ProviderConfigEntry[]) => (providerId: string): ProviderConfigEntry | undefined =>
  entries.find((candidate) => candidate.providerId.toLowerCase() === providerId.toLowerCase());
const persona = { provider: 'openai', model: 'gpt-x' };

describe('coordinatorRoute', () => {
  it('takes the key and base URL of the entry the runtime serves the route\'s provider from', () => {
    const entryOf = vi.fn(served(entry('anthropic', { apiKey: 'a-key' }), entry('openai', { apiKey: 'o-key', baseURL: 'https://proxy.example/v1' })));
    expect(coordinatorRoute(undefined, persona, entryOf)).toEqual({ provider: 'openai', model: 'gpt-x', apiKey: 'o-key', baseUrl: 'https://proxy.example/v1' });
    expect(entryOf).toHaveBeenCalledWith('openai');
  });

  it("sends an entry's key that names no base URL to the provider's own endpoint, where the runtime's provider sends it", () => {
    const route = (provider: string) => coordinatorRoute(undefined, { provider, model: 'm' }, served(entry(provider, { apiKey: 'k' })));
    expect(route('openai')).toEqual({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: OPENAI_DEFAULT_BASE_URL });
    expect(route('openrouter').baseUrl).toBe(OPENROUTER_DEFAULT_BASE_URL);
    expect(route('requesty').baseUrl).toBe(REQUESTY_DEFAULT_BASE_URL);
    expect(route('mistral').baseUrl).toBe(MISTRAL_DEFAULT_BASE_URL);
    expect(route('anthropic').baseUrl).toBe('https://api.anthropic.com');
    expect(route('gemini').baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
    // The route's provider names the endpoint in any letter case, as the runtime's provider manager matches ids.
    expect(coordinatorRoute(undefined, { provider: 'OpenAI', model: 'm' }, served(entry('openai', { apiKey: 'k' })))).toMatchObject({ apiKey: 'k', baseUrl: OPENAI_DEFAULT_BASE_URL });
  });

  it("takes nothing of an entry whose key's endpoint it does not know, or that names a base URL and no key, but Ollama's", () => {
    // A key with no endpoint the runtime is known to send it to goes nowhere.
    expect(coordinatorRoute(undefined, { provider: 'custom-llm', model: 'c' }, served(entry('custom-llm', { apiKey: 'c-key' })))).toEqual({ provider: 'custom-llm', model: 'c' });
    // A base URL without the entry's key would be sent a key generateText resolves on its own.
    expect(coordinatorRoute(undefined, persona, served(entry('openai', { baseURL: 'https://corp.example/v1', oauthFlow: {} })))).toEqual(persona);
    // Ollama sends no key: its entry's base URL alone is where its requests go.
    expect(coordinatorRoute(undefined, { provider: 'ollama', model: 'llama3' }, served(entry('ollama', { baseURL: 'http://gpu:11434' })))).toEqual({
      provider: 'ollama',
      model: 'llama3',
      baseUrl: 'http://gpu:11434',
    });
  });

  it('leaves out a blank key or base URL, and takes nothing when the runtime serves no entry for the provider', () => {
    expect(coordinatorRoute(undefined, persona, served(entry('openai', { apiKey: '', baseURL: '  ' })))).toEqual(persona);
    // A blank base URL is unset: the key goes to the provider's own endpoint.
    expect(coordinatorRoute(undefined, persona, served(entry('openai', { apiKey: 'o-key', baseURL: ' ' })))).toEqual({ ...persona, apiKey: 'o-key', baseUrl: OPENAI_DEFAULT_BASE_URL });
    expect(coordinatorRoute(undefined, { provider: 'groq', model: 'g' }, served(entry('openai', { apiKey: 'o-key' })))).toEqual({ provider: 'groq', model: 'g' });
    // A route with no provider reads no entry.
    const entryOf = vi.fn(served(entry('openai', { apiKey: 'o-key' })));
    expect(coordinatorRoute(undefined, { model: 'gpt-x' }, entryOf)).toEqual({ model: 'gpt-x' });
    expect(entryOf).not.toHaveBeenCalled();
  });

  it("reads an Ollama entry's baseUrl as the Ollama provider does, and no other provider's", () => {
    expect(coordinatorRoute(undefined, { provider: 'ollama', model: 'llama3' }, served(entry('ollama', { baseUrl: 'http://gpu:11434' })))).toEqual({
      provider: 'ollama',
      model: 'llama3',
      baseUrl: 'http://gpu:11434',
    });
    // The OpenAI provider reads baseURL alone, so it sends the entry's key to its own endpoint, not to the entry's baseUrl.
    expect(coordinatorRoute(undefined, persona, served(entry('openai', { apiKey: 'o-key', baseUrl: 'https://elsewhere.example/v1' })))).toEqual({
      ...persona,
      apiKey: 'o-key',
      baseUrl: OPENAI_DEFAULT_BASE_URL,
    });
  });

  it("a coordinator that names no key and no base URL takes its provider's entry; one that names either keeps what it names", () => {
    const entryOf = served(entry('openai', { apiKey: 'o-key', baseURL: 'https://proxy.example/v1' }));
    // The coordinator's provider and model, not the persona's.
    expect(coordinatorRoute({ provider: 'openai', model: 'small' }, { provider: 'anthropic', model: 'big' }, entryOf)).toEqual({
      provider: 'openai',
      model: 'small',
      apiKey: 'o-key',
      baseUrl: 'https://proxy.example/v1',
    });
    // Its own key goes to no base URL of the entry's, and its own base URL gets no key of the entry's.
    expect(coordinatorRoute({ provider: 'openai', model: 'small', apiKey: 'c-key' }, {}, entryOf)).toEqual({ provider: 'openai', model: 'small', apiKey: 'c-key' });
    expect(coordinatorRoute({ provider: 'openai', model: 'small', baseUrl: 'https://mine.example/v1' }, {}, entryOf)).toEqual({
      provider: 'openai',
      model: 'small',
      baseUrl: 'https://mine.example/v1',
    });
    // A blank key or base URL is not one it names.
    expect(coordinatorRoute({ provider: 'openai', model: 'small', apiKey: '', baseUrl: ' ' }, {}, entryOf)).toEqual({
      provider: 'openai',
      model: 'small',
      apiKey: 'o-key',
      baseUrl: 'https://proxy.example/v1',
    });
  });
});
