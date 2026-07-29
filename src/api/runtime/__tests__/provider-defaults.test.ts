import { describe, it, expect, afterEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  spawnSync: vi.fn((_cmd: string, _args?: string[]) => ({ status: 1 })),
}));

vi.mock('node:child_process', () => ({
  spawnSync: hoisted.spawnSync,
}));

import { PROVIDER_DEFAULTS, autoDetectProvider } from '../provider-defaults.js';
import { resolveModelOption, resolveProvider } from '../model.js';

describe('PROVIDER_DEFAULTS', () => {
  it('has text model for all major providers', () => {
    for (const id of ['openai', 'anthropic', 'ollama', 'openrouter', 'gemini', 'requesty']) {
      expect(PROVIDER_DEFAULTS[id]?.text).toBeDefined();
    }
  });

  it('includes CLI providers with text defaults', () => {
    expect(PROVIDER_DEFAULTS['claude-code-cli']?.text).toBe('claude-sonnet-4-6');
    expect(PROVIDER_DEFAULTS['gemini-cli']?.text).toBe('gemini-2.5-flash');
  });

  it('has image model for image providers', () => {
    for (const id of ['openai', 'stability', 'replicate', 'ollama']) {
      expect(PROVIDER_DEFAULTS[id]?.image).toBeDefined();
    }
  });
});

describe('autoDetectProvider', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    hoisted.spawnSync.mockReset();
    hoisted.spawnSync.mockReturnValue({ status: 1 });

    // Restore env after each test
    for (const key of [
      'OPENROUTER_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GROQ_API_KEY',
      'TOGETHER_API_KEY',
      'MISTRAL_API_KEY',
      'XAI_API_KEY',
      'REQUESTY_API_KEY',
      'OLLAMA_BASE_URL',
      'STABILITY_API_KEY',
      'REPLICATE_API_TOKEN',
    ]) {
      if (origEnv[key] !== undefined) {
        process.env[key] = origEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('detects openai from OPENAI_API_KEY', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.OPENAI_API_KEY = 'test';
    expect(autoDetectProvider()).toBe('openai');
  });

  it('prefers openrouter over openai when both are set', () => {
    process.env.OPENROUTER_API_KEY = 'or-test';
    process.env.OPENAI_API_KEY = 'openai-test';
    expect(autoDetectProvider()).toBe('openrouter');
  });

  it('detects requesty from REQUESTY_API_KEY', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.XAI_API_KEY;
    process.env.REQUESTY_API_KEY = 'requesty-test';
    expect(autoDetectProvider()).toBe('requesty');
  });

  it('detects anthropic from ANTHROPIC_API_KEY', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test';
    expect(autoDetectProvider()).toBe('anthropic');
  });

  it('skips providers without image defaults when detecting for image tasks', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'anthropic-test';
    process.env.STABILITY_API_KEY = 'stability-test';

    expect(autoDetectProvider('image')).toBe('stability');
  });

  it('returns undefined when no keys set', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.STABILITY_API_KEY;
    delete process.env.REPLICATE_API_TOKEN;
    expect(autoDetectProvider()).toBeUndefined();
  });

  it('detects claude-code-cli from PATH when no API-key provider is configured', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.OLLAMA_BASE_URL;

    hoisted.spawnSync.mockImplementation((_cmd: string, args?: string[]) => ({
      status: args?.[0] === 'claude' ? 0 : 1,
    }));

    expect(autoDetectProvider()).toBe('claude-code-cli');
  });
});

describe('resolveModelOption', () => {
  it('resolves provider-only to default text model', () => {
    const result = resolveModelOption({ provider: 'openai' }, 'text');
    expect(result).toEqual({ providerId: 'openai', modelId: 'gpt-4o' });
  });

  it('resolves provider + explicit model override', () => {
    const result = resolveModelOption({ provider: 'openai', model: 'gpt-4o-mini' }, 'text');
    expect(result).toEqual({ providerId: 'openai', modelId: 'gpt-4o-mini' });
  });

  it('resolves legacy model string (backwards compat)', () => {
    const result = resolveModelOption({ model: 'openai:gpt-4o-mini' }, 'text');
    expect(result).toEqual({ providerId: 'openai', modelId: 'gpt-4o-mini' });
  });

  it('resolves provider-only for image task', () => {
    const result = resolveModelOption({ provider: 'stability' }, 'image');
    expect(result).toEqual({ providerId: 'stability', modelId: 'stable-diffusion-xl-1024-v1-0' });
  });

  it('resolves provider-only for Claude Code CLI', () => {
    const result = resolveModelOption({ provider: 'claude-code-cli' }, 'text');
    expect(result).toEqual({ providerId: 'claude-code-cli', modelId: 'claude-sonnet-4-6' });
  });

  it('throws for unknown provider', () => {
    expect(() => resolveModelOption({ provider: 'nonexistent' }, 'text')).toThrow(/unknown provider/i);
  });

  it('throws for provider without matching task model', () => {
    expect(() => resolveModelOption({ provider: 'stability' }, 'text')).toThrow(/no default text model/i);
  });

  it('throws when neither provider nor model given and no env', () => {
    const saved: Record<string, string | undefined> = {};
    const keys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'OLLAMA_BASE_URL'];
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      expect(() => resolveModelOption({}, 'text')).toThrow(/required/i);
    } finally {
      for (const k of keys) {
        if (saved[k] !== undefined) process.env[k] = saved[k];
      }
    }
  });

  it('uses task-aware auto-detection for plain image model names', () => {
    const saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      STABILITY_API_KEY: process.env.STABILITY_API_KEY,
    };

    process.env.ANTHROPIC_API_KEY = 'anthropic-test';
    process.env.STABILITY_API_KEY = 'stability-test';

    try {
      expect(resolveModelOption({ model: 'stable-image-core' }, 'image')).toEqual({
        providerId: 'stability',
        modelId: 'stable-image-core',
      });
    } finally {
      if (saved.ANTHROPIC_API_KEY === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
      }
      if (saved.STABILITY_API_KEY === undefined) {
        delete process.env.STABILITY_API_KEY;
      } else {
        process.env.STABILITY_API_KEY = saved.STABILITY_API_KEY;
      }
    }
  });

  it('resolves CLI providers without requiring API keys', () => {
    expect(resolveProvider('claude-code-cli', 'claude-sonnet-4-6')).toEqual({
      providerId: 'claude-code-cli',
      modelId: 'claude-sonnet-4-6',
    });
    expect(resolveProvider('gemini-cli', 'gemini-2.5-flash')).toEqual({
      providerId: 'gemini-cli',
      modelId: 'gemini-2.5-flash',
    });
  });
});
