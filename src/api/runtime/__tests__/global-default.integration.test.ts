/**
 * @file global-default.integration.test.ts
 * Verifies that `setDefaultProvider()` flows through `resolveProvider()`
 * and `resolveModelOption()` with the documented priority:
 *   inline override > global default > env var.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setDefaultProvider, clearDefaultProvider } from '../global-default.js';
import { resolveModelOption, resolveProvider } from '../../model.js';

const KEYS_TO_RESTORE = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'OLLAMA_BASE_URL',
] as const;

const savedEnv: Record<string, string | undefined> = {};

describe('setDefaultProvider flows into resolveModelOption + resolveProvider', () => {
  beforeEach(() => {
    for (const key of KEYS_TO_RESTORE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    clearDefaultProvider();
  });

  afterEach(() => {
    clearDefaultProvider();
    for (const key of KEYS_TO_RESTORE) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('uses the global default provider when no opts are inlined', () => {
    setDefaultProvider({ provider: 'openai', apiKey: 'sk-default' });
    const parsed = resolveModelOption({}, 'text');
    expect(parsed.providerId).toBe('openai');
    expect(parsed.modelId).toBe('gpt-4o');
  });

  it('uses the global default model alongside provider', () => {
    setDefaultProvider({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-default' });
    const parsed = resolveModelOption({}, 'text');
    expect(parsed.providerId).toBe('openai');
    expect(parsed.modelId).toBe('gpt-4o-mini');
  });

  it('prefers inline opts over the global default', () => {
    setDefaultProvider({ provider: 'openai', apiKey: 'sk-default' });
    const parsed = resolveModelOption({ provider: 'anthropic' }, 'text');
    expect(parsed.providerId).toBe('anthropic');
  });

  it('global default apiKey beats env-var apiKey for the matching provider', () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    setDefaultProvider({ provider: 'openai', apiKey: 'sk-default' });
    const resolved = resolveProvider('openai', 'gpt-4o');
    expect(resolved.apiKey).toBe('sk-default');
  });

  it('inline apiKey beats both global default and env var', () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    setDefaultProvider({ provider: 'openai', apiKey: 'sk-default' });
    const resolved = resolveProvider('openai', 'gpt-4o', { apiKey: 'sk-inline' });
    expect(resolved.apiKey).toBe('sk-inline');
  });

  it('falls back to env var when global default is for a different provider', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    setDefaultProvider({ provider: 'openai', apiKey: 'sk-openai-default' });
    const resolved = resolveProvider('anthropic', 'claude-sonnet-4-20250514');
    expect(resolved.apiKey).toBe('sk-ant-env');
  });

  it('uses global default baseUrl for ollama', () => {
    setDefaultProvider({ provider: 'ollama', baseUrl: 'http://my-gpu:11434' });
    const resolved = resolveProvider('ollama', 'llama3.2');
    expect(resolved.baseUrl).toBe('http://my-gpu:11434');
  });
});
