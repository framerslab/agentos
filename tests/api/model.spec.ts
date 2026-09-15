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

  it('resolves atlascloud from ATLASCLOUD_API_KEY and ATLASCLOUD_BASE_URL', () => {
    process.env.ATLASCLOUD_API_KEY = 'atlas-test';
    process.env.ATLASCLOUD_BASE_URL = 'https://proxy.example.com/v1';
    const config = resolveProvider('atlascloud', 'deepseek-ai/deepseek-v4-pro');
    expect(config.providerId).toBe('atlascloud');
    expect(config.apiKey).toBe('atlas-test');
    expect(config.baseUrl).toBe('https://proxy.example.com/v1');
    expect(config.modelId).toBe('deepseek-ai/deepseek-v4-pro');
  });

  it('throws when no API key found', () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => resolveProvider('openai', 'gpt-4o')).toThrow('No API key');
  });
});
