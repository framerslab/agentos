import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Mock the bridge so we never spawn real subprocesses */
const bridgeMocks = vi.hoisted(() => ({
  checkBinaryInstalled: vi.fn(),
  checkAuthenticated: vi.fn(),
  execute: vi.fn(),
  stream: vi.fn(),
}));

vi.mock('../implementations/ClaudeCodeCLIBridge', () => ({
  ClaudeCodeCLIBridge: vi.fn().mockImplementation(() => bridgeMocks),
}));

import { ClaudeCodeProvider } from '../implementations/ClaudeCodeProvider';
import type { ChatMessage, ModelCompletionOptions } from '../IProvider';

describe('ClaudeCodeProvider', () => {
  let provider: ClaudeCodeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeCodeProvider();

    /* Default: CLI is installed and authenticated */
    bridgeMocks.checkBinaryInstalled.mockResolvedValue({
      installed: true, binaryPath: '/usr/local/bin/claude', version: '1.5.0',
    });
    bridgeMocks.checkAuthenticated.mockResolvedValue(true);
  });

  describe('initialize()', () => {
    it('sets isInitialized to true when CLI is installed and authenticated', async () => {
      await provider.initialize({});
      expect(provider.isInitialized).toBe(true);
      expect(provider.providerId).toBe('claude-code-cli');
    });

    it('throws CLI_NOT_FOUND when claude is not installed', async () => {
      bridgeMocks.checkBinaryInstalled.mockResolvedValue({ installed: false });
      await expect(provider.initialize({})).rejects.toThrow('not installed');
    });

    it('throws CLI_NOT_AUTHENTICATED when not logged in', async () => {
      bridgeMocks.checkAuthenticated.mockResolvedValue(false);
      await expect(provider.initialize({})).rejects.toThrow('not logged in');
    });
  });

  describe('generateCompletion()', () => {
    const systemMsg: ChatMessage = { role: 'system', content: 'You are helpful.' };
    const userMsg: ChatMessage = { role: 'user', content: 'Hello' };

    beforeEach(async () => {
      await provider.initialize({});
    });

    it('returns a valid ModelCompletionResponse for a text-only call', async () => {
      bridgeMocks.execute.mockResolvedValue({
        result: 'Hi there!',
        sessionId: 's1',
        usage: { input_tokens: 10, output_tokens: 5 },
        isError: false,
        durationMs: 1500,
      });

      const response = await provider.generateCompletion(
        'claude-sonnet-4-20250514',
        [systemMsg, userMsg],
        {},
      );

      expect(response.choices[0].message.role).toBe('assistant');
      expect(response.choices[0].message.content).toBe('Hi there!');
      expect(response.choices[0].finishReason).toBe('stop');
      expect(response.modelId).toBe('claude-sonnet-4-20250514');
      expect(response.usage?.totalTokens).toBe(15);
      expect(response.usage?.costUSD).toBe(0);

      /* Verify system message was extracted to systemPrompt */
      const callOpts = bridgeMocks.execute.mock.calls[0][0];
      expect(callOpts.systemPrompt).toContain('You are helpful.');
      /* Verify remaining messages are in the prompt as XML */
      expect(callOpts.prompt).toContain('Hello');
    });

    it('injects tool schemas and uses --json-schema when tools are provided', async () => {
      const tools = [{
        type: 'function' as const,
        function: {
          name: 'web_search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      }];

      bridgeMocks.execute.mockResolvedValue({
        result: JSON.stringify({ response_type: 'tool_calls', tool_calls: [{ id: 'tc1', name: 'web_search', arguments: { query: 'weather' } }] }),
        sessionId: 's2',
        usage: { input_tokens: 20, output_tokens: 15 },
        isError: false,
        durationMs: 2000,
      });

      const response = await provider.generateCompletion(
        'claude-sonnet-4-20250514',
        [userMsg],
        { tools } as ModelCompletionOptions,
      );

      expect(response.choices[0].finishReason).toBe('tool_calls');
      expect(response.choices[0].message.tool_calls).toHaveLength(1);
      expect(response.choices[0].message.tool_calls![0].function.name).toBe('web_search');

      /* Verify jsonSchema was passed to the bridge */
      const callOpts = bridgeMocks.execute.mock.calls[0][0];
      expect(callOpts.jsonSchema).toBeDefined();
      /* Verify tool schemas were injected into systemPrompt */
      expect(callOpts.systemPrompt).toContain('web_search');
    });

    it('retries without --json-schema on SCHEMA_PARSE_FAILED', async () => {
      /* First call: returns garbage for structured output */
      bridgeMocks.execute
        .mockResolvedValueOnce({
          result: 'not valid json at all{{{',
          isError: false,
          durationMs: 1000,
        })
        /* Second call: returns plain text */
        .mockResolvedValueOnce({
          result: 'I could not call the tool. Here is a text answer.',
          isError: false,
          durationMs: 1000,
        });

      const tools = [{
        type: 'function' as const,
        function: { name: 'test', description: 'test', parameters: { type: 'object' } },
      }];

      const response = await provider.generateCompletion(
        'claude-sonnet-4-20250514',
        [userMsg],
        { tools } as ModelCompletionOptions,
      );

      /* Should have been called twice: first with schema, then without */
      expect(bridgeMocks.execute).toHaveBeenCalledTimes(2);
      expect(bridgeMocks.execute.mock.calls[1][0].jsonSchema).toBeUndefined();
      /* Falls back to text response */
      expect(response.choices[0].finishReason).toBe('stop');
      expect(response.choices[0].message.content).toContain('text answer');
    });

    it('handles single user message without XML wrapper', async () => {
      bridgeMocks.execute.mockResolvedValue({
        result: 'response',
        isError: false,
        durationMs: 500,
      });

      await provider.generateCompletion(
        'claude-sonnet-4-20250514',
        [userMsg],
        {},
      );

      const callOpts = bridgeMocks.execute.mock.calls[0][0];
      /* Single user message should be passed as plain text, no <conversation> */
      expect(callOpts.prompt).toBe('Hello');
      expect(callOpts.prompt).not.toContain('<conversation>');
    });

    it('serializes multi-turn conversation as XML', async () => {
      bridgeMocks.execute.mockResolvedValue({
        result: 'response',
        isError: false,
        durationMs: 500,
      });

      const messages: ChatMessage[] = [
        systemMsg,
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'How are you?' },
      ];

      await provider.generateCompletion('claude-sonnet-4-20250514', messages, {});

      const callOpts = bridgeMocks.execute.mock.calls[0][0];
      expect(callOpts.prompt).toContain('<conversation>');
      expect(callOpts.prompt).toContain('role="user"');
      expect(callOpts.prompt).toContain('role="assistant"');
      expect(callOpts.prompt).toContain('</conversation>');
      expect(callOpts.systemPrompt).toContain('You are helpful.');
    });
  });

  describe('listAvailableModels()', () => {
    beforeEach(async () => {
      await provider.initialize({});
    });

    it('returns the static Claude model catalog', async () => {
      const models = await provider.listAvailableModels();
      expect(models.length).toBe(4);
      const ids = models.map(m => m.modelId);
      expect(ids).toContain('claude-fable-5');
      expect(ids).toContain('claude-opus-4-20250514');
      expect(ids).toContain('claude-sonnet-4-20250514');
      expect(ids).toContain('claude-haiku-4-5-20251001');
      expect(models.every(m => m.pricePer1MTokensInput === 0)).toBe(true);
    });
  });

  describe('generateEmbeddings()', () => {
    beforeEach(async () => {
      await provider.initialize({});
    });

    it('throws EMBEDDINGS_NOT_SUPPORTED', async () => {
      await expect(provider.generateEmbeddings('any', ['text'])).rejects.toThrow('does not support embeddings');
    });
  });

  describe('checkHealth()', () => {
    it('returns healthy when installed and authenticated', async () => {
      await provider.initialize({});
      const health = await provider.checkHealth();
      expect(health.isHealthy).toBe(true);
      expect((health.details as any).cliInstalled).toBe(true);
      expect((health.details as any).authenticated).toBe(true);
    });

    it('reports unhealthy when CLI is not installed', async () => {
      bridgeMocks.checkBinaryInstalled.mockResolvedValue({ installed: false });
      const health = await provider.checkHealth();
      expect(health.isHealthy).toBe(false);
      expect((health.details as any).cliInstalled).toBe(false);
      expect((health.details as any).guidance).toContain('Install Claude Code');
    });
  });

  describe('generateCompletionStream()', () => {
    beforeEach(async () => {
      await provider.initialize({});
    });

    it('synthesizes a final chunk when the bridge only emits text deltas', async () => {
      bridgeMocks.stream.mockImplementation(async function* () {
        yield { type: 'text_delta', text: 'Hello' };
        yield { type: 'text_delta', text: ' world' };
      });

      const chunks: any[] = [];
      for await (const chunk of provider.generateCompletionStream(
        'claude-opus-4-20250514',
        [{ role: 'user', content: 'Hello' }],
        {},
      )) {
        chunks.push(chunk);
      }

      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.isFinal).toBe(true);
      expect(finalChunk.modelId).toBe('claude-opus-4-20250514');
      expect(finalChunk.choices[0].message.content).toBe('Hello world');
    });

    it('emits a terminal error chunk instead of throwing on stream errors', async () => {
      bridgeMocks.stream.mockImplementation(async function* () {
        yield { type: 'error', error: 'stream blew up' };
      });

      const chunks: any[] = [];
      for await (const chunk of provider.generateCompletionStream(
        'claude-haiku-4-5-20251001',
        [{ role: 'user', content: 'Hello' }],
        {},
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        isFinal: true,
        modelId: 'claude-haiku-4-5-20251001',
        error: { message: expect.stringContaining('stream blew up') },
      });
    });
  });
});
