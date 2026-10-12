// packages/agentos/tests/api/model.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MAX_CACHED_PROVIDER_MANAGERS,
  cachedProviderManagerCount,
  createProviderManager,
  parseModelString,
  resolveModelOption,
  resolveProvider,
  type ModelOption,
} from '../../src/api/model.js';

describe('parseModelString', () => {
  it('parses openai:gpt-4o', () => {
    const result = parseModelString('openai:gpt-4o');
    expect(result.providerId).toBe('openai');
    expect(result.modelId).toBe('gpt-4o');
  });

  it('parses anthropic:claude-sonnet-4-5-20250929', () => {
    const result = parseModelString('anthropic:claude-sonnet-4-5-20250929');
    expect(result.providerId).toBe('anthropic');
    expect(result.modelId).toBe('claude-sonnet-4-5-20250929');
  });

  it('parses ollama:llama3.2', () => {
    const result = parseModelString('ollama:llama3.2');
    expect(result.providerId).toBe('ollama');
    expect(result.modelId).toBe('llama3.2');
  });

  it('parses openrouter with slash in model', () => {
    const result = parseModelString('openrouter:anthropic/claude-sonnet-4-5-20250929');
    expect(result.providerId).toBe('openrouter');
    expect(result.modelId).toBe('anthropic/claude-sonnet-4-5-20250929');
  });

  it('throws on invalid format', () => {
    expect(() => parseModelString('invalid')).toThrow('Invalid model');
    expect(() => parseModelString('')).toThrow('Invalid model');
  });
});

describe('resolveProvider', () => {
  const origEnv = { ...process.env };
  afterEach(() => { process.env = { ...origEnv }; });

  it('resolves openai from OPENAI_API_KEY env', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const config = resolveProvider('openai', 'gpt-4o');
    expect(config.providerId).toBe('openai');
    expect(config.apiKey).toBe('sk-test');
    expect(config.modelId).toBe('gpt-4o');
  });

  it('uses explicit apiKey over env', () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    const config = resolveProvider('openai', 'gpt-4o', { apiKey: 'sk-explicit' });
    expect(config.apiKey).toBe('sk-explicit');
  });

  it('resolves ollama from OLLAMA_BASE_URL', () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const config = resolveProvider('ollama', 'llama3.2');
    expect(config.baseUrl).toBe('http://localhost:11434');
  });

  it('throws when no API key found', () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => resolveProvider('openai', 'gpt-4o')).toThrow('No API key');
  });

  it('serves anthropic through OpenRouter with no Anthropic key, but not when a base URL was given', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveProvider('anthropic', 'claude-opus-5-5')).toMatchObject({
      providerId: 'openrouter',
      modelId: 'anthropic/claude-opus-5-5',
    });
    // A gateway the caller named: OpenRouter in its place would drop it.
    expect(() => resolveProvider('anthropic', 'claude-opus-5-5', { baseUrl: 'https://llm-gw.example/anthropic' })).toThrow(
      'No API key for anthropic',
    );
    vi.restoreAllMocks();
  });
});

describe('resolveModelOption with a key or base URL of its own', () => {
  const origEnv = { ...process.env };
  afterEach(() => { process.env = { ...origEnv }; });
  const keyed = (opts: Record<string, string>) => opts as ModelOption;

  it('refuses one that a model prefix would send to another provider than the one named', () => {
    expect(() => resolveModelOption(keyed({ provider: 'openai', model: 'anthropic:claude-opus-5-5', apiKey: 'sk-openai' }))).toThrow(
      "names provider 'anthropic', not 'openai'",
    );
    expect(() => resolveModelOption(keyed({ provider: 'openrouter', model: 'openai:gpt-4o', baseUrl: 'https://gw.example/v1' }))).toThrow(
      "names provider 'openai', not 'openrouter'",
    );
  });

  it('lets it through with its own provider, a prefix that agrees, under ollama, or for a text call left to detection', () => {
    for (const name of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY']) delete process.env[name];
    process.env.OPENAI_API_KEY = 'sk-env';

    expect(resolveModelOption(keyed({ provider: 'anthropic', model: 'anthropic:claude-opus-5-5', apiKey: 'k' }))).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-opus-5-5',
    });
    // Under ollama a colon is a tag, never a prefix.
    expect(resolveModelOption(keyed({ provider: 'ollama', model: 'openai:thing', baseUrl: 'http://localhost:11434' }))).toEqual({
      providerId: 'ollama',
      modelId: 'openai:thing',
    });
    expect(resolveModelOption(keyed({ apiKey: 'k' }), 'text').providerId).toBe('openai');
  });

  it('refuses one on an image call whose provider detection would pick', () => {
    process.env.REPLICATE_API_TOKEN = 'r8-env';

    expect(() => resolveModelOption(keyed({ apiKey: 'sk-tenant' }), 'image')).toThrow('needs provider');
    expect(() => resolveModelOption(keyed({ model: 'gpt-image-2.5-flare', apiKey: 'sk-tenant' }), 'image')).toThrow('needs provider');
    expect(resolveModelOption(keyed({ model: 'openai:gpt-image-2.5-flare', apiKey: 'sk-tenant' }), 'image')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-image-2.5-flare',
    });
  });
});

describe('createProviderManager cache', () => {
  it('keeps at most MAX_CACHED_PROVIDER_MANAGERS, dropping the one used least recently', async () => {
    // AnthropicProvider makes no request when it initializes.
    const make = (n: number) =>
      createProviderManager({ providerId: 'anthropic', modelId: 'claude-opus-5-5', apiKey: `sk-ant-cache-${n}` });
    const first = await make(0);
    const second = await make(1);
    for (let n = 2; n < MAX_CACHED_PROVIDER_MANAGERS; n += 1) await make(n);
    expect(cachedProviderManagerCount()).toBe(MAX_CACHED_PROVIDER_MANAGERS);

    // Used again, the first key becomes the most recent; the next new key drops the second.
    expect(await make(0)).toBe(first);
    await make(MAX_CACHED_PROVIDER_MANAGERS);

    expect(cachedProviderManagerCount()).toBe(MAX_CACHED_PROVIDER_MANAGERS);
    expect(await make(0)).toBe(first);
    expect(await make(1)).not.toBe(second);
  });
});
