/**
 * coordinatorRoute: the route a launched team's manager and synthesizers call generateText on, on the full runtime.
 * Its key and base URL are those of the runtime's provider entry, read as the runtime reads it, unless the host's
 * coordinator names its own. Pure logic.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderConfigEntry } from '../../../../core/llm/providers/AIModelProviderManager.js';
import { coordinatorRoute } from '../runtimeLaunchTool.js';

const entry = (providerId: string, config: Record<string, unknown>, enabled = true): ProviderConfigEntry => ({ providerId, enabled, config });
const persona = { provider: 'openai', model: 'gpt-x' };

describe('coordinatorRoute', () => {
  it("takes the key and base URL of the runtime's entry for the persona's provider", () => {
    const providers = [entry('anthropic', { apiKey: 'a-key' }), entry('openai', { apiKey: 'o-key', baseURL: 'https://proxy.example/v1' })];
    expect(coordinatorRoute(undefined, persona, providers)).toEqual({ provider: 'openai', model: 'gpt-x', apiKey: 'o-key', baseUrl: 'https://proxy.example/v1' });
  });

  it('reads the entry the runtime serves the provider from: an enabled one, its id in any case, the last of several', () => {
    const providers = [entry('openai', { apiKey: 'first' }), entry('OpenAI', { apiKey: 'last' }), entry('openai', { apiKey: 'disabled' }, false)];
    expect(coordinatorRoute(undefined, persona, providers)).toEqual({ ...persona, apiKey: 'last' });
  });

  it('leaves out what the entry does not set, a blank key or base URL included, for generateText to resolve', () => {
    expect(coordinatorRoute(undefined, persona, [entry('openai', { apiKey: '', baseURL: '  ' })])).toEqual(persona);
    expect(coordinatorRoute(undefined, persona, [entry('openai', { apiKey: 'o-key' }, false)])).toEqual(persona);
    expect(coordinatorRoute(undefined, { provider: 'groq', model: 'g' }, [entry('openai', { apiKey: 'o-key' })])).toEqual({ provider: 'groq', model: 'g' });
    // A route with no provider reads no entry.
    expect(coordinatorRoute(undefined, { model: 'gpt-x' }, [entry('openai', { apiKey: 'o-key' })])).toEqual({ model: 'gpt-x' });
  });

  it("reads an Ollama entry's baseUrl as the Ollama provider does, and no other provider's", () => {
    expect(coordinatorRoute(undefined, { provider: 'ollama', model: 'llama3' }, [entry('ollama', { baseUrl: 'http://gpu:11434' })])).toEqual({
      provider: 'ollama',
      model: 'llama3',
      baseUrl: 'http://gpu:11434',
    });
    // The OpenAI provider reads baseURL alone, so its entry's baseUrl is not where the runtime sends the entry's key.
    expect(coordinatorRoute(undefined, persona, [entry('openai', { apiKey: 'o-key', baseUrl: 'https://elsewhere.example/v1' })])).toEqual({ ...persona, apiKey: 'o-key' });
  });

  it("a coordinator that names no key and no base URL takes its provider's entry; one that names either keeps what it names", () => {
    const providers = [entry('openai', { apiKey: 'o-key', baseURL: 'https://proxy.example/v1' })];
    // The coordinator's provider and model, not the persona's.
    expect(coordinatorRoute({ provider: 'openai', model: 'small' }, { provider: 'anthropic', model: 'big' }, providers)).toEqual({
      provider: 'openai',
      model: 'small',
      apiKey: 'o-key',
      baseUrl: 'https://proxy.example/v1',
    });
    // Its own key goes to no base URL of the entry's, and its own base URL gets no key of the entry's.
    expect(coordinatorRoute({ provider: 'openai', model: 'small', apiKey: 'c-key' }, {}, providers)).toEqual({ provider: 'openai', model: 'small', apiKey: 'c-key' });
    expect(coordinatorRoute({ provider: 'openai', model: 'small', baseUrl: 'https://mine.example/v1' }, {}, providers)).toEqual({
      provider: 'openai',
      model: 'small',
      baseUrl: 'https://mine.example/v1',
    });
    // A blank key or base URL is not one it names.
    expect(coordinatorRoute({ provider: 'openai', model: 'small', apiKey: '', baseUrl: ' ' }, {}, providers)).toEqual({
      provider: 'openai',
      model: 'small',
      apiKey: 'o-key',
      baseUrl: 'https://proxy.example/v1',
    });
  });
});
