/**
 * Integration tests for `setProviderPriority` × `autoDetectProvider`.
 *
 * These verify that the module-level priority registry actually changes
 * the order in which `autoDetectProvider()` walks env vars / CLI probes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoDetectProvider } from '../provider-defaults.js';
import {
  clearProviderPriority,
  setProviderPriority,
} from '../provider-priority.js';

const ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'TOGETHER_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'OLLAMA_BASE_URL',
] as const;

describe('autoDetectProvider × setProviderPriority', () => {
  // Snapshot env vars before each test, restore after, so we can manipulate
  // process.env without leaking state between tests or sessions.
  const snapshots: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      snapshots[k] = process.env[k];
      delete process.env[k];
    }
    clearProviderPriority();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = snapshots[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearProviderPriority();
  });

  it('default order: openrouter beats openai when both keys are set', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-x';
    process.env.OPENAI_API_KEY = 'sk-x';
    expect(autoDetectProvider('text')).toBe('openrouter');
  });

  it('custom priority reorders the chain (anthropic > openai)', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    setProviderPriority(['anthropic', 'openai']);
    expect(autoDetectProvider('text')).toBe('anthropic');
  });

  it('custom priority skips providers not in the list', () => {
    // OpenAI key is set but the custom list only mentions anthropic.
    // No anthropic key set, so detection returns undefined even though
    // OPENAI_API_KEY is configured.
    process.env.OPENAI_API_KEY = 'sk-x';
    setProviderPriority(['anthropic']);
    expect(autoDetectProvider('text')).toBeUndefined();
  });

  it('custom priority falls through to the next entry when first has no key', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    setProviderPriority(['anthropic', 'gemini', 'openai']);
    expect(autoDetectProvider('text')).toBe('openai');
  });

  it('empty custom list disables auto-detection entirely', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    setProviderPriority([]);
    expect(autoDetectProvider('text')).toBeUndefined();
  });

  it('clearProviderPriority restores the default order', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    setProviderPriority(['anthropic', 'openai']);
    clearProviderPriority();
    // Default order has openrouter first, then openai, then anthropic.
    // Without OPENROUTER_API_KEY, openai (next in the default chain) wins.
    expect(autoDetectProvider('text')).toBe('openai');
  });

  it('task filter still applies to the custom order (skip providers without task default)', () => {
    // OpenRouter and Anthropic have no `embedding` default — only OpenAI
    // and Ollama do (per PROVIDER_DEFAULTS). With a custom list of
    // [anthropic, openai], an embedding lookup must skip anthropic and
    // resolve to openai.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    process.env.OPENAI_API_KEY = 'sk-x';
    setProviderPriority(['anthropic', 'openai']);
    expect(autoDetectProvider('embedding')).toBe('openai');
  });
});
