/**
 * @fileoverview Unit tests for AnthropicProvider.
 *
 * Validates the key structural differences between Anthropic's Messages API
 * and the OpenAI-style IProvider contract:
 * - System message extraction to top-level `system` field
 * - Tool definition conversion (`parameters` → `input_schema`)
 * - Stop reason mapping (`end_turn` → `stop`, `tool_use` → `tool_calls`)
 * - max_tokens enforcement (always present in payload)
 * - Non-streaming response mapping
 * - Streaming SSE event parsing
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock fetch globally so no real HTTP requests are made
// ---------------------------------------------------------------------------
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { AnthropicProvider } from '../implementations/AnthropicProvider';
import type { ChatMessage } from '../IProvider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a minimal successful Anthropic Messages API response. */
function makeAnthropicResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_test_123',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello from Anthropic!' }],
    model: 'claude-sonnet-4-20250514',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

/** Creates a mock fetch Response with JSON body. */
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

/** Creates a mock ReadableStream from SSE event strings. */
function createSseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Each SSE event is separated by double newline
  const fullPayload = events.join('\n\n') + '\n\n';
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

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-anthropic-key' });
  });

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  describe('initialization', () => {
    it('throws when API key is missing', async () => {
      const p = new AnthropicProvider();
      await expect(p.initialize({ apiKey: '' })).rejects.toThrow('API key is required');
    });

    it('sets providerId to "anthropic"', () => {
      expect(provider.providerId).toBe('anthropic');
    });

    it('marks provider as initialized after successful init', () => {
      expect(provider.isInitialized).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // System message extraction
  // -------------------------------------------------------------------------

  describe('system message handling', () => {
    it('extracts system messages to top-level system field (not a message role)', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));

      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hi' },
      ];

      await provider.generateCompletion('claude-sonnet-4-20250514', messages, {});

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);

      // System should be a top-level string, NOT a message with role "system"
      expect(requestBody.system).toBe('You are a helpful assistant.');

      // Messages array should NOT contain system role
      const roles = requestBody.messages.map((m: any) => m.role);
      expect(roles).not.toContain('system');
      expect(roles).toEqual(['user']);
    });

    it('concatenates multiple system messages with double newlines', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));

      const messages: ChatMessage[] = [
        { role: 'system', content: 'Rule 1: Be helpful.' },
        { role: 'system', content: 'Rule 2: Be concise.' },
        { role: 'user', content: 'Hello' },
      ];

      await provider.generateCompletion('claude-sonnet-4-20250514', messages, {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.system).toBe('Rule 1: Be helpful.\n\nRule 2: Be concise.');
    });

    it('omits system field when no system messages are present', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));

      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
      ];

      await provider.generateCompletion('claude-sonnet-4-20250514', messages, {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.system).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // max_tokens enforcement
  // -------------------------------------------------------------------------

  describe('max_tokens enforcement', () => {
    it('always includes max_tokens in the request payload (defaults to the model output ceiling)', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));

      // Do NOT pass maxTokens in options
      await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Hi' },
      ], {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      // max_tokens MUST be present — Anthropic rejects requests without it.
      // Default is the model's configured output ceiling (16000 for Sonnet).
      expect(requestBody.max_tokens).toBe(16000);
    });

    it('respects caller-provided maxTokens', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));

      await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Hi' },
      ], { maxTokens: 1024 });

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.max_tokens).toBe(1024);
    });
  });

  // -------------------------------------------------------------------------
  // Temperature deprecation for reasoning-default models (Opus 4.7)
  // -------------------------------------------------------------------------

  describe('temperature handling per model', () => {
    it('includes temperature in the payload for Claude Sonnet / Haiku / Opus <= 4.6', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-sonnet-4-6',
        [{ role: 'user', content: 'Hi' }],
        { temperature: 0.3 },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.3);
    });

    it('includes temperature for older Opus (claude-opus-4-6)', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-opus-4-6',
        [{ role: 'user', content: 'Hi' }],
        { temperature: 0.7 },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.7);
    });

    it('OMITS temperature for claude-opus-4-7 even when caller passes it', async () => {
      // Opus 4.7 deprecated temperature (reasoning-default). The Anthropic
      // API returns 400 "`temperature` is deprecated for this model" when
      // temperature is present, so the provider must silently drop it.
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-opus-4-7',
        [{ role: 'user', content: 'Hi' }],
        { temperature: 0.5 },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBeUndefined();
    });

    it('OMITS temperature for claude-opus-4-7 with provider-qualified id variations', async () => {
      // Guards against a future change that keeps the major/minor but
      // tacks on a date suffix (e.g. claude-opus-4-7-20260501).
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-opus-4-7-20260501',
        [{ role: 'user', content: 'Hi' }],
        { temperature: 0.5 },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBeUndefined();
    });

    it('passes temperature unchanged when model is not a reasoning-default family', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-haiku-4-5-20251001',
        [{ role: 'user', content: 'Hi' }],
        { temperature: 0 },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Tool calling format conversion
  // -------------------------------------------------------------------------

  describe('tool calling format', () => {
    it('converts OpenAI-style tool defs to Anthropic input_schema format', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse({
        content: [{
          type: 'tool_use',
          id: 'toolu_123',
          name: 'get_weather',
          input: { location: 'San Francisco' },
        }],
        stop_reason: 'tool_use',
      })));

      const tools = [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
          // OpenAI uses "parameters", Anthropic uses "input_schema"
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      }];

      await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Weather in SF?' },
      ], { tools });

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);

      // Verify tool was converted to Anthropic format with input_schema
      expect(requestBody.tools).toHaveLength(1);
      expect(requestBody.tools[0]).toEqual({
        name: 'get_weather',
        description: 'Get current weather',
        input_schema: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      });
    });

    it('maps tool_use response blocks to OpenAI-style tool_calls', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse({
        content: [
          { type: 'text', text: 'Let me check the weather.' },
          {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'get_weather',
            input: { location: 'NYC', unit: 'celsius' },
          },
        ],
        stop_reason: 'tool_use',
      })));

      const result = await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Weather in NYC?' },
      ], {});

      // Verify tool_calls are in OpenAI format
      const choice = result.choices[0];
      expect(choice.message.tool_calls).toHaveLength(1);
      expect(choice.message.tool_calls![0]).toEqual({
        id: 'toolu_abc',
        type: 'function',
        function: {
          name: 'get_weather',
          // Arguments should be a JSON STRING (OpenAI convention)
          arguments: '{"location":"NYC","unit":"celsius"}',
        },
      });
      expect(choice.finishReason).toBe('tool_calls');
    });
  });

  // -------------------------------------------------------------------------
  // Stop reason mapping
  // -------------------------------------------------------------------------

  describe('stop reason mapping', () => {
    it('maps end_turn to "stop"', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse({
        stop_reason: 'end_turn',
      })));

      const result = await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Hi' },
      ], {});

      expect(result.choices[0].finishReason).toBe('stop');
    });

    it('maps tool_use to "tool_calls"', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse({
        content: [{ type: 'tool_use', id: 'x', name: 'fn', input: {} }],
        stop_reason: 'tool_use',
      })));

      const result = await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Call a tool' },
      ], {});

      expect(result.choices[0].finishReason).toBe('tool_calls');
    });

    it('maps max_tokens to "length"', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse({
        stop_reason: 'max_tokens',
      })));

      const result = await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Long response' },
      ], {});

      expect(result.choices[0].finishReason).toBe('length');
    });

    it('maps stop_sequence to "stop"', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse({
        stop_reason: 'stop_sequence',
      })));

      const result = await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Hi' },
      ], {});

      expect(result.choices[0].finishReason).toBe('stop');
    });
  });

  // -------------------------------------------------------------------------
  // Streaming SSE parsing
  // -------------------------------------------------------------------------

  describe('streaming SSE parsing', () => {
    it('parses content_block_delta text events into responseTextDelta chunks', async () => {
      const sseEvents = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ];

      const stream = createSseStream(sseEvents);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        body: stream,
      });

      const chunks: any[] = [];
      for await (const chunk of provider.generateCompletionStream(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'Hi' }],
        { maxTokens: 100 },
      )) {
        chunks.push(chunk);
      }

      // Should have text delta chunks + final chunk
      const textDeltas = chunks.filter(c => c.responseTextDelta);
      expect(textDeltas).toHaveLength(2);
      expect(textDeltas[0].responseTextDelta).toBe('Hello');
      expect(textDeltas[1].responseTextDelta).toBe(' world');

      // Final chunk should have isFinal: true and usage
      const finalChunk = chunks.find(c => c.isFinal);
      expect(finalChunk).toBeDefined();
      expect(finalChunk!.choices[0].finishReason).toBe('stop');
      expect(finalChunk!.usage).toBeDefined();
      expect(finalChunk!.usage!.promptTokens).toBe(10);
      expect(finalChunk!.usage!.completionTokens).toBe(5);
    });

    it('parses streaming tool_use events with input_json_delta', async () => {
      const sseEvents = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_t1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":15,"output_tokens":0}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_stream","name":"get_weather"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"loc"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ation\\":\\"SF\\"}"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":8}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ];

      const stream = createSseStream(sseEvents);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        body: stream,
      });

      const chunks: any[] = [];
      for await (const chunk of provider.generateCompletionStream(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'Weather?' }],
        { maxTokens: 100 },
      )) {
        chunks.push(chunk);
      }

      // Should have tool call delta chunks
      const toolDeltas = chunks.filter(c => c.toolCallsDeltas);
      expect(toolDeltas.length).toBeGreaterThanOrEqual(2);

      // Final chunk should have assembled tool_calls
      const finalChunk = chunks.find(c => c.isFinal);
      expect(finalChunk).toBeDefined();
      expect(finalChunk!.choices[0].finishReason).toBe('tool_calls');
      expect(finalChunk!.choices[0].message.tool_calls).toHaveLength(1);
      expect(finalChunk!.choices[0].message.tool_calls![0].function.name).toBe('get_weather');
    });
  });

  // -------------------------------------------------------------------------
  // Authentication headers
  // -------------------------------------------------------------------------

  describe('authentication headers', () => {
    it('sends x-api-key header (not Authorization Bearer)', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));

      await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Hi' },
      ], {});

      const headers = fetchMock.mock.calls[0][1].headers;
      // Anthropic uses x-api-key, NOT Authorization: Bearer
      expect(headers['x-api-key']).toBe('test-anthropic-key');
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });
  });

  // -------------------------------------------------------------------------
  // Embeddings (not supported)
  // -------------------------------------------------------------------------

  describe('embeddings', () => {
    it('throws when embeddings are requested', async () => {
      await expect(
        provider.generateEmbeddings('any-model', ['test']),
      ).rejects.toThrow('does not provide an embeddings API');
    });
  });

  // -------------------------------------------------------------------------
  // Model catalog
  // -------------------------------------------------------------------------

  describe('model catalog', () => {
    it('lists known Anthropic models', async () => {
      const models = await provider.listAvailableModels();
      expect(models.length).toBeGreaterThanOrEqual(3);
      const ids = models.map(m => m.modelId);
      expect(ids).toContain('claude-sonnet-4-20250514');
      expect(ids).toContain('claude-opus-4-20250514');
      expect(ids).toContain('claude-haiku-4-5-20251001');
    });

    it('filters models by capability', async () => {
      const visionModels = await provider.listAvailableModels({ capability: 'vision_input' });
      expect(visionModels.length).toBeGreaterThan(0);
      for (const m of visionModels) {
        expect(m.capabilities).toContain('vision_input');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Tool result message conversion
  // -------------------------------------------------------------------------

  describe('tool result messages', () => {
    it('converts tool-role messages to user/tool_result blocks', async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));

      const messages: ChatMessage[] = [
        { role: 'user', content: 'Weather in SF?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"SF"}' },
          }],
        },
        {
          role: 'tool',
          content: '{"temp": 65, "condition": "foggy"}',
          tool_call_id: 'call_1',
        },
      ];

      await provider.generateCompletion('claude-sonnet-4-20250514', messages, {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      const toolResultMsg = requestBody.messages[2];

      // Tool results should be sent as "user" role with tool_result content block
      // (Anthropic convention — tool results go in user messages)
      expect(toolResultMsg.role).toBe('user');
      expect(toolResultMsg.content[0].type).toBe('tool_result');
      expect(toolResultMsg.content[0].tool_use_id).toBe('call_1');
    });
  });

  // -------------------------------------------------------------------------
  // Multi-key pool rotation + failover
  // -------------------------------------------------------------------------

  describe('multi-key rotation + failover', () => {
    function rateLimitedResponse(): Response {
      return {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'retry-after': '0' }),
        json: () => Promise.resolve({ error: { type: 'rate_limit_error', message: 'slow down' } }),
        body: null,
      } as unknown as Response;
    }

    it('rotates to the next key on a 429 retry instead of hammering the rate-limited key', async () => {
      const p = new AnthropicProvider();
      await p.initialize({ apiKey: 'key1,key2', maxRetries: 3 });

      fetchMock.mockResolvedValueOnce(rateLimitedResponse());
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));

      await p.generateCompletion(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'Hi' }],
        {},
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstKey = fetchMock.mock.calls[0][1].headers['x-api-key'];
      const secondKey = fetchMock.mock.calls[1][1].headers['x-api-key'];
      expect(firstKey).toBe('key1');
      // The retry must fail over to the OTHER key — the rate-limited key is
      // marked exhausted and skipped, not retried on the same throttled key.
      expect(secondKey).toBe('key2');
    });
  });
});
