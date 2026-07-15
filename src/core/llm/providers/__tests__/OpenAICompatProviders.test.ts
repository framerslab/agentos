/**
 * @fileoverview Unit tests for the OpenAI-compatible provider wrappers.
 *
 * Validates that Groq, Together, Mistral, xAI, and Atlas Cloud providers:
 * - Initialize correctly with proper base URLs
 * - Delegate to the underlying OpenAI provider
 * - Have correct model defaults in their catalogs
 * - Are properly registered in PROVIDER_DEFAULTS and auto-detection
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the OpenAI provider's initialize method so we can capture config
// without making real network calls. The OpenAI provider's init validates
// the API key and calls /models which would fail in a test environment.
// ---------------------------------------------------------------------------

const initializeMock = vi.fn().mockResolvedValue(undefined);
const generateCompletionMock = vi.fn();
const generateCompletionStreamMock = vi.fn();
const shutdownMock = vi.fn().mockResolvedValue(undefined);
const checkHealthMock = vi.fn().mockResolvedValue({ isHealthy: true });

vi.mock('../implementations/OpenAIProvider', () => ({
  OpenAIProvider: vi.fn().mockImplementation(() => ({
    providerId: 'openai',
    isInitialized: true,
    initialize: initializeMock,
    generateCompletion: generateCompletionMock,
    generateCompletionStream: generateCompletionStreamMock,
    shutdown: shutdownMock,
    checkHealth: checkHealthMock,
    listAvailableModels: vi.fn().mockResolvedValue([]),
    getModelInfo: vi.fn().mockResolvedValue(undefined),
    generateEmbeddings: vi.fn(),
  })),
}));

import { GroqProvider } from '../implementations/GroqProvider';
import { TogetherProvider } from '../implementations/TogetherProvider';
import { MistralProvider } from '../implementations/MistralProvider';
import { XAIProvider } from '../implementations/XAIProvider';
import { AtlasCloudProvider } from '../implementations/AtlasCloudProvider';
import { PROVIDER_DEFAULTS, autoDetectProvider } from '../../../../api/runtime/provider-defaults';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAI-compatible provider wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // GroqProvider
  // =========================================================================

  describe('GroqProvider', () => {
    it('has providerId "groq"', () => {
      const provider = new GroqProvider();
      expect(provider.providerId).toBe('groq');
    });

    it('initializes with Groq base URL', async () => {
      const provider = new GroqProvider();
      await provider.initialize({ apiKey: 'gsk-test-key' });

      expect(initializeMock).toHaveBeenCalledTimes(1);
      const config = initializeMock.mock.calls[0][0];
      expect(config.apiKey).toBe('gsk-test-key');
      expect(config.baseURL).toBe('https://api.groq.com/openai/v1');
    });

    it('throws when API key is missing', async () => {
      const provider = new GroqProvider();
      await expect(provider.initialize({ apiKey: '' })).rejects.toThrow('API key is required');
    });

    it('defaults to llama-3.3-70b-versatile model', async () => {
      const provider = new GroqProvider();
      await provider.initialize({ apiKey: 'gsk-test' });
      expect(provider.defaultModelId).toBe('llama-3.3-70b-versatile');
    });

    it('lists known Groq models', async () => {
      const provider = new GroqProvider();
      await provider.initialize({ apiKey: 'gsk-test' });
      const models = await provider.listAvailableModels();
      expect(models.length).toBeGreaterThanOrEqual(3);
      const ids = models.map(m => m.modelId);
      expect(ids).toContain('llama-3.3-70b-versatile');
      expect(ids).toContain('mixtral-8x7b-32768');
      expect(ids).toContain('gemma2-9b-it');
      // All models should have providerId "groq"
      for (const m of models) {
        expect(m.providerId).toBe('groq');
      }
    });

    it('delegates generateCompletion to OpenAI provider', async () => {
      const provider = new GroqProvider();
      await provider.initialize({ apiKey: 'gsk-test' });
      await provider.generateCompletion('test-model', [], {});
      expect(generateCompletionMock).toHaveBeenCalledTimes(1);
    });

    it('rejects embeddings (not supported)', async () => {
      const provider = new GroqProvider();
      await provider.initialize({ apiKey: 'gsk-test' });
      await expect(provider.generateEmbeddings('model', ['text'])).rejects.toThrow('embeddings');
    });
  });

  // =========================================================================
  // TogetherProvider
  // =========================================================================

  describe('TogetherProvider', () => {
    it('has providerId "together"', () => {
      const provider = new TogetherProvider();
      expect(provider.providerId).toBe('together');
    });

    it('initializes with Together base URL', async () => {
      const provider = new TogetherProvider();
      await provider.initialize({ apiKey: 'tog-test-key' });

      expect(initializeMock).toHaveBeenCalledTimes(1);
      const config = initializeMock.mock.calls[0][0];
      expect(config.apiKey).toBe('tog-test-key');
      expect(config.baseURL).toBe('https://api.together.xyz/v1');
    });

    it('throws when API key is missing', async () => {
      const provider = new TogetherProvider();
      await expect(provider.initialize({ apiKey: '' })).rejects.toThrow('API key is required');
    });

    it('defaults to Llama 3.1 70B Instruct Turbo', async () => {
      const provider = new TogetherProvider();
      await provider.initialize({ apiKey: 'tog-test' });
      expect(provider.defaultModelId).toBe('meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo');
    });

    it('lists known Together models', async () => {
      const provider = new TogetherProvider();
      await provider.initialize({ apiKey: 'tog-test' });
      const models = await provider.listAvailableModels();
      expect(models.length).toBeGreaterThanOrEqual(3);
      const ids = models.map(m => m.modelId);
      expect(ids).toContain('meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo');
      expect(ids).toContain('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo');
      expect(ids).toContain('mistralai/Mixtral-8x7B-Instruct-v0.1');
    });
  });

  // =========================================================================
  // MistralProvider
  // =========================================================================

  describe('MistralProvider', () => {
    it('has providerId "mistral"', () => {
      const provider = new MistralProvider();
      expect(provider.providerId).toBe('mistral');
    });

    it('initializes with Mistral base URL', async () => {
      const provider = new MistralProvider();
      await provider.initialize({ apiKey: 'mistral-test-key' });

      expect(initializeMock).toHaveBeenCalledTimes(1);
      const config = initializeMock.mock.calls[0][0];
      expect(config.apiKey).toBe('mistral-test-key');
      expect(config.baseURL).toBe('https://api.mistral.ai/v1');
    });

    it('throws when API key is missing', async () => {
      const provider = new MistralProvider();
      await expect(provider.initialize({ apiKey: '' })).rejects.toThrow('API key is required');
    });

    it('defaults to mistral-large-latest model', async () => {
      const provider = new MistralProvider();
      await provider.initialize({ apiKey: 'mistral-test' });
      expect(provider.defaultModelId).toBe('mistral-large-latest');
    });

    it('lists known Mistral models including Codestral', async () => {
      const provider = new MistralProvider();
      await provider.initialize({ apiKey: 'mistral-test' });
      const models = await provider.listAvailableModels();
      expect(models.length).toBeGreaterThanOrEqual(4);
      const ids = models.map(m => m.modelId);
      expect(ids).toContain('mistral-large-latest');
      expect(ids).toContain('mistral-medium-latest');
      expect(ids).toContain('mistral-small-latest');
      expect(ids).toContain('codestral-latest');
    });
  });

  // =========================================================================
  // XAIProvider
  // =========================================================================

  describe('XAIProvider', () => {
    it('has providerId "xai"', () => {
      const provider = new XAIProvider();
      expect(provider.providerId).toBe('xai');
    });

    it('initializes with xAI base URL', async () => {
      const provider = new XAIProvider();
      await provider.initialize({ apiKey: 'xai-test-key' });

      expect(initializeMock).toHaveBeenCalledTimes(1);
      const config = initializeMock.mock.calls[0][0];
      expect(config.apiKey).toBe('xai-test-key');
      expect(config.baseURL).toBe('https://api.x.ai/v1');
    });

    it('throws when API key is missing', async () => {
      const provider = new XAIProvider();
      await expect(provider.initialize({ apiKey: '' })).rejects.toThrow('API key is required');
    });

    it('defaults to grok-2 model', async () => {
      const provider = new XAIProvider();
      await provider.initialize({ apiKey: 'xai-test' });
      expect(provider.defaultModelId).toBe('grok-2');
    });

    it('lists known xAI Grok models', async () => {
      const provider = new XAIProvider();
      await provider.initialize({ apiKey: 'xai-test' });
      const models = await provider.listAvailableModels();
      expect(models.length).toBeGreaterThanOrEqual(2);
      const ids = models.map(m => m.modelId);
      expect(ids).toContain('grok-2');
      expect(ids).toContain('grok-2-mini');
    });

    it('rejects embeddings (not supported)', async () => {
      const provider = new XAIProvider();
      await provider.initialize({ apiKey: 'xai-test' });
      await expect(provider.generateEmbeddings('model', ['text'])).rejects.toThrow('embeddings');
    });
  });

  // =========================================================================
  // AtlasCloudProvider
  // =========================================================================

  describe('AtlasCloudProvider', () => {
    it('has providerId "atlascloud"', () => {
      const provider = new AtlasCloudProvider();
      expect(provider.providerId).toBe('atlascloud');
    });

    it('initializes with Atlas Cloud base URL', async () => {
      const provider = new AtlasCloudProvider();
      await provider.initialize({ apiKey: 'atlas-test-key' });

      expect(initializeMock).toHaveBeenCalledTimes(1);
      const config = initializeMock.mock.calls[0][0];
      expect(config.apiKey).toBe('atlas-test-key');
      expect(config.baseURL).toBe('https://api.atlascloud.ai/v1');
    });

    it('throws when API key is missing', async () => {
      const provider = new AtlasCloudProvider();
      await expect(provider.initialize({ apiKey: '' })).rejects.toThrow('API key is required');
    });

    it('defaults to deepseek-ai/deepseek-v4-pro model', async () => {
      const provider = new AtlasCloudProvider();
      await provider.initialize({ apiKey: 'atlas-test' });
      expect(provider.defaultModelId).toBe('deepseek-ai/deepseek-v4-pro');
    });

    it('lists known Atlas Cloud models', async () => {
      const provider = new AtlasCloudProvider();
      await provider.initialize({ apiKey: 'atlas-test' });
      const models = await provider.listAvailableModels();
      const ids = models.map(m => m.modelId);
      expect(ids).toContain('deepseek-ai/deepseek-v4-pro');
      expect(ids).toContain('qwen/qwen3.5-flash');
      for (const m of models) {
        expect(m.providerId).toBe('atlascloud');
      }
    });

    it('delegates generateCompletion to OpenAI provider', async () => {
      const provider = new AtlasCloudProvider();
      await provider.initialize({ apiKey: 'atlas-test' });
      await provider.generateCompletion('test-model', [], {});
      expect(generateCompletionMock).toHaveBeenCalledTimes(1);
    });

    it('rejects embeddings (not supported)', async () => {
      const provider = new AtlasCloudProvider();
      await provider.initialize({ apiKey: 'atlas-test' });
      await expect(provider.generateEmbeddings('model', ['text'])).rejects.toThrow('embeddings');
    });
  });

  // =========================================================================
  // PROVIDER_DEFAULTS registration
  // =========================================================================

  describe('PROVIDER_DEFAULTS registration', () => {
    it('includes groq with correct defaults', () => {
      expect(PROVIDER_DEFAULTS.groq).toBeDefined();
      expect(PROVIDER_DEFAULTS.groq.text).toBe('llama-3.3-70b-versatile');
      expect(PROVIDER_DEFAULTS.groq.cheap).toBe('gemma2-9b-it');
    });

    it('includes together with correct defaults', () => {
      expect(PROVIDER_DEFAULTS.together).toBeDefined();
      expect(PROVIDER_DEFAULTS.together.text).toBe('meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo');
      expect(PROVIDER_DEFAULTS.together.cheap).toBe('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo');
    });

    it('includes mistral with correct defaults', () => {
      expect(PROVIDER_DEFAULTS.mistral).toBeDefined();
      expect(PROVIDER_DEFAULTS.mistral.text).toBe('mistral-large-latest');
      expect(PROVIDER_DEFAULTS.mistral.cheap).toBe('mistral-small-latest');
    });

    it('includes xai with correct defaults', () => {
      expect(PROVIDER_DEFAULTS.xai).toBeDefined();
      expect(PROVIDER_DEFAULTS.xai.text).toBe('grok-2');
      expect(PROVIDER_DEFAULTS.xai.cheap).toBe('grok-2-mini');
    });

    it('includes atlascloud with correct defaults', () => {
      expect(PROVIDER_DEFAULTS.atlascloud).toBeDefined();
      expect(PROVIDER_DEFAULTS.atlascloud.text).toBe('deepseek-ai/deepseek-v4-pro');
      expect(PROVIDER_DEFAULTS.atlascloud.cheap).toBe('qwen/qwen3.5-flash');
    });

    it('still has anthropic defaults', () => {
      expect(PROVIDER_DEFAULTS.anthropic).toBeDefined();
      expect(PROVIDER_DEFAULTS.anthropic.text).toBe('claude-sonnet-4-6');
      expect(PROVIDER_DEFAULTS.anthropic.cheap).toBe('claude-haiku-4-5-20251001');
    });
  });

  // =========================================================================
  // Auto-detection order
  // =========================================================================

  describe('autoDetectProvider includes new providers', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      // Clear all provider env vars so auto-detect starts clean
      process.env = { ...originalEnv };
      delete process.env.OPENAI_API_KEY;
      delete process.env.ATLASCLOUD_API_KEY;
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
      delete process.env.STABLE_DIFFUSION_LOCAL_BASE_URL;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('detects groq when GROQ_API_KEY is set', () => {
      process.env.GROQ_API_KEY = 'gsk-test';
      expect(autoDetectProvider()).toBe('groq');
    });

    it('detects together when TOGETHER_API_KEY is set', () => {
      process.env.TOGETHER_API_KEY = 'tog-test';
      expect(autoDetectProvider()).toBe('together');
    });

    it('detects mistral when MISTRAL_API_KEY is set', () => {
      process.env.MISTRAL_API_KEY = 'mis-test';
      expect(autoDetectProvider()).toBe('mistral');
    });

    it('detects xai when XAI_API_KEY is set', () => {
      process.env.XAI_API_KEY = 'xai-test';
      expect(autoDetectProvider()).toBe('xai');
    });

    it('detects atlascloud when ATLASCLOUD_API_KEY is set', () => {
      process.env.ATLASCLOUD_API_KEY = 'atlas-test';
      expect(autoDetectProvider()).toBe('atlascloud');
    });

    it('prefers openai over groq when both are set', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.GROQ_API_KEY = 'gsk-test';
      expect(autoDetectProvider()).toBe('openai');
    });
  });
});
