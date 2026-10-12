// packages/agentos/tests/api/model.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseModelString, resolveProvider } from '../../src/api/model.js';

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
