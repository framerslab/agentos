/**
 * @fileoverview Unit tests for GeminiProvider.
 *
 * Validates the key structural differences between the Gemini REST API
 * and the OpenAI-style IProvider contract:
 * - System message extraction to `systemInstruction` field
 * - Role mapping (`assistant` -> `model`)
 * - Tool definition conversion (OpenAI functions -> `functionDeclarations`)
 * - Tool call response mapping (`functionCall` -> `tool_calls`)
 * - Finish reason mapping (`STOP`/`MAX_TOKENS`/`SAFETY`/`RECITATION`)
 * - Auth via query parameter (`?key=`) not header
 * - Usage metadata extraction (`usageMetadata` -> `ModelUsage`)
 * - Streaming SSE parsing
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock fetch globally so no real HTTP requests are made
// ---------------------------------------------------------------------------
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { GeminiProvider } from '../implementations/GeminiProvider';
import type { ChatMessage } from '../IProvider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal successful Gemini generateContent response.
 *
 * @param overrides - Fields to override in the default response.
 * @returns A mock Gemini API response object.
 */
function makeGeminiResponse(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [{
      content: {
        role: 'model',
        parts: [{ text: 'Hello from Gemini!' }],
      },
      finishReason: 'STOP',
    }],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
    ...overrides,
  };
}

/**
 * Creates a mock fetch Response with JSON body.
 *
 * @param data - The response payload.
 * @param status - HTTP status code.
 * @returns A mock Response object.
 */
function mockJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: () => Promise.resolve(data),
    body: null,
  } as unknown as Response;
}

/**
 * Creates a mock ReadableStream from SSE event strings.
 *
 * @param events - Array of SSE data payloads (without the "data: " prefix).
 * @returns A ReadableStream simulating SSE.
 */
function createSseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Each SSE event gets a "data: " prefix and is separated by double newlines
  const fullPayload = events.map(e => `data: ${e}`).join('\n\n') + '\n\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(fullPayload));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GeminiProvider', () => {
  let provider: GeminiProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'test-gemini-key' });
  });

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  describe('initialization', () => {
    it('throws when API key is missing', async () => {
      const p = new GeminiProvider();
      await expect(p.initialize({ apiKey: '' })).rejects.toThrow('API key is required');
    });

    it('sets providerId to "gemini"', () => {
      expect(provider.providerId).toBe('gemini');
    });

    it('marks provider as initialized after successful init', () => {
      expect(provider.isInitialized).toBe(true);
    });

    it('sets default model to gemini-2.5-flash', () => {
      expect(provider.defaultModelId).toBe('gemini-2.5-flash');
    });
  });

  // -------------------------------------------------------------------------
  // Auth: query parameter (not header)
  // -------------------------------------------------------------------------

  describe('authentication', () => {
    it('passes API key as query parameter, not as Authorization header', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse()));

      await provider.generateCompletion('gemini-2.5-flash', [
        { role: 'user', content: 'Hi' },
      ], {});

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];

      // API key should be in the URL as a query parameter
      expect(url).toContain('?key=test-gemini-key');

      // Should NOT have an Authorization header
      expect(options.headers['Authorization']).toBeUndefined();
      // Should NOT have an x-api-key header
      expect(options.headers['x-api-key']).toBeUndefined();
    });

    it('uses model-scoped endpoint URL', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse()));

      await provider.generateCompletion('gemini-2.5-flash', [
        { role: 'user', content: 'Hi' },
      ], {});

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/models/gemini-2.5-flash:generateContent');
    });
  });

  // -------------------------------------------------------------------------
  // System instruction handling
  // -------------------------------------------------------------------------

  describe('system instruction handling', () => {
    it('extracts system messages to systemInstruction field (not a role in contents)', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse()));

      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hi' },
      ];

      await provider.generateCompletion('gemini-2.5-flash', messages, {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);

      // System instruction should be a separate top-level field with parts array
      expect(requestBody.systemInstruction).toEqual({
        parts: [{ text: 'You are a helpful assistant.' }],
      });

      // Contents array should NOT contain any system role messages
      const roles = requestBody.contents.map((c: any) => c.role);
      expect(roles).not.toContain('system');
      expect(roles).toEqual(['user']);
    });

    it('concatenates multiple system messages', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse()));

      const messages: ChatMessage[] = [
        { role: 'system', content: 'Rule 1: Be helpful.' },
        { role: 'system', content: 'Rule 2: Be concise.' },
        { role: 'user', content: 'Hello' },
      ];

      await provider.generateCompletion('gemini-2.5-flash', messages, {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.systemInstruction).toEqual({
        parts: [{ text: 'Rule 1: Be helpful.\n\nRule 2: Be concise.' }],
      });
    });

    it('omits systemInstruction when no system messages are present', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse()));

      await provider.generateCompletion('gemini-2.5-flash', [
        { role: 'user', content: 'Hello' },
      ], {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.systemInstruction).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Message format / role mapping
  // -------------------------------------------------------------------------

  describe('message format', () => {
    it('maps assistant role to "model" (Gemini convention)', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse()));

      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];

      await provider.generateCompletion('gemini-2.5-flash', messages, {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);

      // assistant should become "model"
      expect(requestBody.contents[0].role).toBe('user');
      expect(requestBody.contents[1].role).toBe('model');
      expect(requestBody.contents[2].role).toBe('user');
    });

    it('wraps message content in parts array with text field', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse()));

      await provider.generateCompletion('gemini-2.5-flash', [
        { role: 'user', content: 'Hello world' },
      ], {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.contents[0].parts).toEqual([{ text: 'Hello world' }]);
    });

    it('maps generation config fields correctly', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse()));

      await provider.generateCompletion('gemini-2.5-flash', [
        { role: 'user', content: 'Hi' },
      ], {
        temperature: 0.7,
        maxTokens: 512,
        topP: 0.9,
        stopSequences: ['END'],
      });

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.generationConfig).toEqual({
        temperature: 0.7,
        maxOutputTokens: 512,
        topP: 0.9,
        stopSequences: ['END'],
      });
    });
  });

  // -------------------------------------------------------------------------
  // Tool calling
  // -------------------------------------------------------------------------

  describe('tool calling', () => {
    it('converts OpenAI-style tool defs to Gemini functionDeclarations format', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse({
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              functionCall: { name: 'get_weather', args: { location: 'San Francisco' } },
            }],
          },
          finishReason: 'STOP',
        }],
      })));

      const tools = [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      }];

      await provider.generateCompletion('gemini-2.5-flash', [
        { role: 'user', content: 'Weather in SF?' },
      ], { tools });

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);

      // Tools should be wrapped in { functionDeclarations: [...] }
      expect(requestBody.tools).toHaveLength(1);
      expect(requestBody.tools[0].functionDeclarations).toHaveLength(1);
      expect(requestBody.tools[0].functionDeclarations[0]).toEqual({
        name: 'get_weather',
        description: 'Get current weather',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      });
    });

    it('maps functionCall response to OpenAI-style tool_calls', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse({
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              functionCall: {
                name: 'get_weather',
                args: { location: 'NYC', unit: 'celsius' },
              },
            }],
          },
          finishReason: 'STOP',
        }],
      })));

      const result = await provider.generateCompletion('gemini-2.5-flash', [
        { role: 'user', content: 'Weather in NYC?' },
      ], {});

      const choice = result.choices[0];
      expect(choice.message.tool_calls).toHaveLength(1);
      expect(choice.message.tool_calls![0].type).toBe('function');
      expect(choice.message.tool_calls![0].function.name).toBe('get_weather');
      // Arguments should be a JSON STRING (OpenAI convention)
      expect(choice.message.tool_calls![0].function.arguments).toBe(
        '{"location":"NYC","unit":"celsius"}',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Finish reason mapping
  // -------------------------------------------------------------------------

  describe('finish reason mapping', () => {
    it('maps STOP to "stop"', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }],
      })));

      const result = await provider.generateCompletion('gemini-2.5-flash', [
        { role: 'user', content: 'Hi' },
      ], {});

      expect(result.choices[0].finishReason).toBe('stop');
    });

    it('maps MAX_TOKENS to "length"', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] }, finishReason: 'MAX_TOKENS' }],
      })));

      const result = await provider.generateCompletion('gemini-2.5-flash', [
        { role: 'user', content: 'Write a very long story' },
      ], {});

      expect(result.choices[0].finishReason).toBe('length');
    });

    it('maps SAFETY to "content_filter"', async () => {
      // Partial text present so this exercises the finishReason mapping; the
      // empty-content SAFETY case now throws a content-policy error (see
      // GeminiProvider.safety.test.ts) so the fallback chain can engage.
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse({
        candidates: [{ content: { role: 'model', parts: [{ text: 'partial output' }] }, finishReason: 'SAFETY' }],
      })));

      const result = await provider.generateCompletion('gemini-2.5-flash', [
        { role: 'user', content: 'test' },
      ], {});

      expect(result.choices[0].finishReason).toBe('content_filter');
    });

    it('maps RECITATION to "content_filter"', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse({
        candidates: [{ content: { role: 'model', parts: [{ text: 'partial output' }] }, finishReason: 'RECITATION' }],
      })));

      const result = await provider.generateCompletion('gemini-2.5-flash', [
        { role: 'user', content: 'test' },
      ], {});

      expect(result.choices[0].finishReason).toBe('content_filter');
    });
  });

  // -------------------------------------------------------------------------
  // Usage extraction
  // -------------------------------------------------------------------------

  describe('usage extraction', () => {
    it('maps usageMetadata to IProvider ModelUsage format', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse({
        usageMetadata: {
          promptTokenCount: 42,
          candidatesTokenCount: 17,
          totalTokenCount: 59,
        },
      })));

      const result = await provider.generateCompletion('gemini-2.5-flash', [
        { role: 'user', content: 'Hi' },
      ], {});

      expect(result.usage).toBeDefined();
      expect(result.usage!.promptTokens).toBe(42);
      expect(result.usage!.completionTokens).toBe(17);
      expect(result.usage!.totalTokens).toBe(59);
    });

    it('includes cost estimation for known models', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeGeminiResponse({
        usageMetadata: {
          promptTokenCount: 1000000,
          candidatesTokenCount: 1000000,
          totalTokenCount: 2000000,
        },
      })));

      const result = await provider.generateCompletion('gemini-2.5-flash', [
        { role: 'user', content: 'Hi' },
      ], {});

      // gemini-2.5-flash: $0.15/1M input + $0.60/1M output
      expect(result.usage!.costUSD).toBeCloseTo(0.75, 2);
    });
  });

  // -------------------------------------------------------------------------
  // Streaming SSE
  // -------------------------------------------------------------------------

  describe('streaming', () => {
    it('parses SSE stream with text deltas', async () => {
      const sseEvents = [
        JSON.stringify({
          candidates: [{
            content: { role: 'model', parts: [{ text: 'Hello' }] },
          }],
        }),
        JSON.stringify({
          candidates: [{
            content: { role: 'model', parts: [{ text: ' world' }] },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        }),
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: createSseStream(sseEvents),
      } as unknown as Response);

      const chunks: any[] = [];
      for await (const chunk of provider.generateCompletionStream('gemini-2.5-flash', [
        { role: 'user', content: 'Hi' },
      ], {})) {
        chunks.push(chunk);
      }

      // Should have text delta chunks plus a final chunk
      expect(chunks.length).toBeGreaterThanOrEqual(3);

      // First text delta
      expect(chunks[0].responseTextDelta).toBe('Hello');

      // Second text delta
      expect(chunks[1].responseTextDelta).toBe(' world');

      // Final chunk should have isFinal: true and usage
      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.isFinal).toBe(true);
      expect(finalChunk.usage).toBeDefined();
      expect(finalChunk.usage.totalTokens).toBe(7);
    });

    it('uses alt=sse query parameter for streaming endpoint', async () => {
      const sseEvents = [
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: createSseStream(sseEvents),
      } as unknown as Response);

      // Consume the stream
      for await (const _chunk of provider.generateCompletionStream('gemini-2.5-flash', [
        { role: 'user', content: 'Hi' },
      ], {})) {
        // just consume
      }

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('streamGenerateContent');
      expect(url).toContain('alt=sse');
      expect(url).toContain('key=test-gemini-key');
    });

    it('emits abort chunk when abortSignal is pre-aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const chunks: any[] = [];
      for await (const chunk of provider.generateCompletionStream('gemini-2.5-flash', [
        { role: 'user', content: 'Hi' },
      ], { abortSignal: controller.signal })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0].isFinal).toBe(true);
      expect(chunks[0].error?.type).toBe('abort');
    });
  });

  // -------------------------------------------------------------------------
  // Model introspection
  // -------------------------------------------------------------------------

  describe('model introspection', () => {
    it('lists all known Gemini models', async () => {
      const models = await provider.listAvailableModels();
      expect(models.length).toBeGreaterThanOrEqual(4);

      const ids = models.map(m => m.modelId);
      expect(ids).toContain('gemini-2.5-flash');
      expect(ids).toContain('gemini-2.5-pro');
      expect(ids).toContain('gemini-2.0-flash');
      expect(ids).toContain('gemini-1.5-pro');
    });

    it('filters models by capability', async () => {
      const models = await provider.listAvailableModels({ capability: 'tool_use' });
      // All Gemini models support tool_use
      expect(models.length).toBeGreaterThanOrEqual(4);
    });

    it('returns model info for known model', async () => {
      const info = await provider.getModelInfo('gemini-2.5-flash');
      expect(info).toBeDefined();
      expect(info!.providerId).toBe('gemini');
      expect(info!.capabilities).toContain('chat');
    });

    it('returns undefined for unknown model', async () => {
      const info = await provider.getModelInfo('gemini-nonexistent');
      expect(info).toBeUndefined();
    });
  });
});
