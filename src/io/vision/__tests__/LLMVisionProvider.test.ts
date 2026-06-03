/**
 * @module vision/__tests__/LLMVisionProvider.spec
 *
 * Unit tests for {@link LLMVisionProvider}.
 *
 * Validates that the provider correctly wraps `generateText()` with
 * multimodal image messages and handles various response scenarios.
 *
 * ## Test categories
 *
 * 1. **Constructor validation** — requires provider name
 * 2. **Image description** — wraps generateText with correct message format
 * 3. **Configuration** — custom prompt, model, apiKey, baseUrl
 * 4. **Error handling** — empty response, API failure
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMVisionProvider } from '../providers/LLMVisionProvider.js';

// ---------------------------------------------------------------------------
// Mock generateText
// ---------------------------------------------------------------------------

let mockGenerateText: any;

vi.mock('../../../api/generateText.js', () => {
  return {
    generateText: (...args: any[]) => mockGenerateText(...args),
  };
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGenerateText = vi.fn(async () => ({
    text: 'A golden retriever playing fetch on a sandy beach with waves in the background.',
    usage: { promptTokens: 200, completionTokens: 30, totalTokens: 230 },
    toolCalls: [],
    finishReason: 'stop',
    provider: 'openai',
    model: 'gpt-4o',
  }));
});

// ===========================================================================
// Tests
// ===========================================================================

describe('LLMVisionProvider', () => {
  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should require a provider name', () => {
      expect(() => new LLMVisionProvider({ provider: '' })).toThrow(
        'provider name is required',
      );
    });

    it('should accept valid configuration', () => {
      const provider = new LLMVisionProvider({
        provider: 'openai',
        model: 'gpt-4o',
      });
      expect(provider).toBeInstanceOf(LLMVisionProvider);
    });
  });

  // =========================================================================
  // describeImage
  // =========================================================================

  describe('describeImage()', () => {
    it('should wrap generateText correctly with image message', async () => {
      const provider = new LLMVisionProvider({ provider: 'openai' });
      const description = await provider.describeImage(
        'data:image/png;base64,iVBORw0KGgoAAAA',
      );

      expect(description).toBe(
        'A golden retriever playing fetch on a sandy beach with waves in the background.',
      );

      // Verify generateText was called with the right shape
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      const callArgs = mockGenerateText.mock.calls[0][0];
      expect(callArgs.provider).toBe('openai');
      expect(callArgs.messages).toHaveLength(1);
      expect(callArgs.messages[0].role).toBe('user');

      // Message.content is the structured MessageContentPart[] array directly —
      // no JSON.stringify wrapping (LLMVisionProvider passes the array as-is
      // because the underlying message type natively accepts the structured form).
      const contentParts = callArgs.messages[0].content;
      expect(contentParts).toHaveLength(2);
      expect(contentParts[0].type).toBe('text');
      expect(contentParts[1].type).toBe('image_url');
      expect(contentParts[1].image_url.url).toBe(
        'data:image/png;base64,iVBORw0KGgoAAAA',
      );
    });

    it('should pass image URL through unchanged', async () => {
      const provider = new LLMVisionProvider({ provider: 'openai' });
      await provider.describeImage('https://example.com/photo.jpg');

      const contentParts = mockGenerateText.mock.calls[0][0].messages[0].content;
      expect(contentParts[1].image_url.url).toBe(
        'https://example.com/photo.jpg',
      );
    });

    it('should return description text from LLM', async () => {
      const provider = new LLMVisionProvider({ provider: 'anthropic' });
      const description = await provider.describeImage('https://example.com/img.png');

      expect(description).toBeTruthy();
      expect(typeof description).toBe('string');
    });
  });

  // =========================================================================
  // Configuration forwarding
  // =========================================================================

  describe('configuration', () => {
    it('should forward model to generateText', async () => {
      const provider = new LLMVisionProvider({
        provider: 'openai',
        model: 'gpt-4o-mini',
      });
      await provider.describeImage('https://example.com/img.png');

      expect(mockGenerateText.mock.calls[0][0].model).toBe('gpt-4o-mini');
    });

    it('should forward apiKey to generateText', async () => {
      const provider = new LLMVisionProvider({
        provider: 'openai',
        apiKey: 'sk-test-key-123',
      });
      await provider.describeImage('https://example.com/img.png');

      expect(mockGenerateText.mock.calls[0][0].apiKey).toBe('sk-test-key-123');
    });

    it('should forward baseUrl to generateText', async () => {
      const provider = new LLMVisionProvider({
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
      });
      await provider.describeImage('https://example.com/img.png');

      expect(mockGenerateText.mock.calls[0][0].baseUrl).toBe(
        'http://localhost:11434',
      );
    });

    it('should use custom prompt when provided', async () => {
      const customPrompt = 'List all text visible in this image.';
      const provider = new LLMVisionProvider({
        provider: 'openai',
        prompt: customPrompt,
      });
      await provider.describeImage('https://example.com/img.png');

      const contentParts = mockGenerateText.mock.calls[0][0].messages[0].content;
      expect(contentParts[0].text).toBe(customPrompt);
    });

    it('should use default prompt when none is specified', async () => {
      const provider = new LLMVisionProvider({ provider: 'openai' });
      await provider.describeImage('https://example.com/img.png');

      const contentParts = mockGenerateText.mock.calls[0][0].messages[0].content;
      expect(contentParts[0].text).toContain('Describe this image');
      expect(contentParts[0].text).toContain('search index');
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('should throw when LLM returns empty text', async () => {
      mockGenerateText.mockResolvedValue({
        text: '',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        toolCalls: [],
        finishReason: 'stop',
        provider: 'openai',
        model: 'gpt-4o',
      });

      const provider = new LLMVisionProvider({ provider: 'openai' });
      await expect(
        provider.describeImage('https://example.com/img.png'),
      ).rejects.toThrow('empty description');
    });

    it('should throw when LLM returns whitespace-only text', async () => {
      mockGenerateText.mockResolvedValue({
        text: '   \n  ',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        toolCalls: [],
        finishReason: 'stop',
        provider: 'openai',
        model: 'gpt-4o',
      });

      const provider = new LLMVisionProvider({ provider: 'openai' });
      await expect(
        provider.describeImage('https://example.com/img.png'),
      ).rejects.toThrow('empty description');
    });

    it('should propagate API errors from generateText', async () => {
      mockGenerateText.mockRejectedValue(new Error('API rate limit exceeded'));

      const provider = new LLMVisionProvider({ provider: 'openai' });
      await expect(
        provider.describeImage('https://example.com/img.png'),
      ).rejects.toThrow('API rate limit exceeded');
    });
  });
});
