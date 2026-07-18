/**
 * @fileoverview Tests for the LiteLLMProvider.
 *
 * LiteLLMProvider delegates to OpenAIProvider with a custom baseURL,
 * same pattern as GroqProvider. Tests verify initialization, delegation,
 * dynamic model discovery, and error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LiteLLMProvider } from '../implementations/LiteLLMProvider.js';
import { OpenAIProvider } from '../implementations/OpenAIProvider.js';

// Mock OpenAIProvider to avoid real HTTP calls
vi.mock('../implementations/OpenAIProvider.js', () => {
  const MockOpenAIProvider = vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    generateCompletion: vi.fn().mockResolvedValue({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      modelId: 'anthropic/claude-sonnet-4-6',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'OK' },
          finishReason: 'stop',
        },
      ],
      usage: { promptTokens: 13, completionTokens: 4, totalTokens: 17 },
    }),
    generateCompletionStream: vi.fn().mockImplementation(async function* () {
      yield {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 0,
        modelId: 'anthropic/claude-sonnet-4-6',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '' },
            finishReason: 'stop',
          },
        ],
        responseTextDelta: 'OK',
        isFinal: true,
        usage: { promptTokens: 13, completionTokens: 4, totalTokens: 17 },
      };
    }),
    generateEmbeddings: vi.fn().mockResolvedValue({
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.1, 0.2, 0.3], index: 0 }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 5, total_tokens: 5 },
    }),
    checkHealth: vi
      .fn()
      .mockResolvedValue({ isHealthy: true, details: 'OK' }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }));
  return { OpenAIProvider: MockOpenAIProvider };
});

describe('LiteLLMProvider', () => {
  let provider: LiteLLMProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LiteLLMProvider();
  });

  describe('initialization', () => {
    it('throws when API key is missing', async () => {
      await expect(
        provider.initialize({ apiKey: '' }),
      ).rejects.toThrow('API key is required');
    });

    it('initializes with valid config', async () => {
      await provider.initialize({
        apiKey: 'sk-test',
        baseURL: 'http://localhost:4000/v1',
      });

      expect(provider.isInitialized).toBe(true);
      expect(provider.providerId).toBe('litellm');
      expect(provider.defaultModelId).toBe('gpt-4o-mini');
    });

    it('uses custom default model', async () => {
      await provider.initialize({
        apiKey: 'sk-test',
        defaultModelId: 'anthropic/claude-sonnet-4-6',
      });

      expect(provider.defaultModelId).toBe('anthropic/claude-sonnet-4-6');
    });

    it('delegates to OpenAIProvider with proxy baseURL', async () => {
      await provider.initialize({
        apiKey: 'sk-test',
        baseURL: 'http://proxy:4000/v1',
      });

      const mockInstance = (OpenAIProvider as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(mockInstance.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'sk-test',
          baseURL: 'http://proxy:4000/v1',
        }),
      );
    });
  });

  describe('generateCompletion', () => {
    it('delegates to OpenAIProvider', async () => {
      await provider.initialize({ apiKey: 'sk-test' });

      const res = await provider.generateCompletion(
        'anthropic/claude-sonnet-4-6',
        [{ role: 'user', content: 'Say OK' }],
        { temperature: 0 },
      );

      expect(res.choices[0].message.content).toBe('OK');
      expect(res.choices[0].finishReason).toBe('stop');
      expect(res.usage?.totalTokens).toBe(17);
    });
  });

  describe('generateCompletionStream', () => {
    it('yields streamed chunks from delegate', async () => {
      await provider.initialize({ apiKey: 'sk-test' });

      const chunks: any[] = [];
      for await (const chunk of provider.generateCompletionStream(
        'anthropic/claude-sonnet-4-6',
        [{ role: 'user', content: 'Say OK' }],
        {},
      )) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[chunks.length - 1].isFinal).toBe(true);
    });
  });

  describe('generateEmbeddings', () => {
    it('delegates to OpenAIProvider', async () => {
      await provider.initialize({ apiKey: 'sk-test' });

      const res = await provider.generateEmbeddings(
        'text-embedding-3-small',
        ['hello'],
      );

      expect(res.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe('listAvailableModels', () => {
    it('fetches models from proxy /v1/models', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4o-mini' },
            { id: 'anthropic/claude-sonnet-4-6' },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await provider.initialize({ apiKey: 'sk-test' });
      const models = await provider.listAvailableModels();

      expect(models).toHaveLength(2);
      expect(models[0].modelId).toBe('gpt-4o-mini');
      expect(models[1].modelId).toBe('anthropic/claude-sonnet-4-6');

      vi.unstubAllGlobals();
    });

    it('returns empty array on fetch error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false });
      vi.stubGlobal('fetch', mockFetch);

      await provider.initialize({ apiKey: 'sk-test' });
      const models = await provider.listAvailableModels();

      expect(models).toEqual([]);

      vi.unstubAllGlobals();
    });

    it('returns empty array on network failure', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', mockFetch);

      await provider.initialize({ apiKey: 'sk-test' });
      const models = await provider.listAvailableModels();

      expect(models).toEqual([]);

      vi.unstubAllGlobals();
    });
  });

  describe('checkHealth', () => {
    it('delegates to OpenAIProvider', async () => {
      await provider.initialize({ apiKey: 'sk-test' });

      const health = await provider.checkHealth();
      expect(health.isHealthy).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('delegates and resets state', async () => {
      await provider.initialize({ apiKey: 'sk-test' });
      await provider.shutdown();

      expect(provider.isInitialized).toBe(false);
    });
  });
});
