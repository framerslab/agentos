/**
 * @file StructuredOutputManager.repeated-keys.test.ts
 * A reply that repeats a key in one object is refused by the manager, never
 * returned as the object `JSON.parse` would make of it, which keeps only the
 * key's last value. Under `function_calling` the reply is the forced tool
 * call's arguments: on Anthropic they are the input as the stream delivered
 * it (the real AnthropicProvider, only fetch stubbed), and a provider that
 * hands the arguments over as text (OpenAI's shape) is refused the same way.
 * `generateFunctionCalls()` marks such arguments invalid and runs no handler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { AnthropicProvider } from '../../../../core/llm/providers/implementations/AnthropicProvider';
import { StructuredOutputManager } from '../StructuredOutputManager';
import { StructuredOutputError, type JSONSchema } from '../IStructuredOutputManager';

/** The forced call's input with `items` written twice: `JSON.parse` keeps only `[{"id":"c"}]`. */
const REPEATED = '{"items":[{"id":"a"},{"id":"b"}],"items":[{"id":"c"}]}';
const CLEAN = '{"items":[{"id":"a"},{"id":"b"},{"id":"c"}]}';

const ITEMS: JSONSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  required: ['items'],
};

const d = (o: unknown) => `data: ${JSON.stringify(o)}`;

/** A streamed Messages response whose one block is a call to `name`, its input delivered as `chunks`. */
function toolCallStream(name: string, chunks: string[]): Response {
  const events = [
    d({
      type: 'message_start',
      message: {
        id: 'msg_items',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    }),
    d({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_items', name, input: {} } }),
    ...chunks.map((partial_json) => d({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } })),
    d({ type: 'content_block_stop', index: 0 }),
    d({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 24 } }),
    d({ type: 'message_stop' }),
  ];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(events.join('\n\n') + '\n\n'));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: () => Promise.reject(new Error('SSE body, not JSON')),
    body,
  } as unknown as Response;
}

/** Answers the Messages requests in turn, each with a call to `record_items` delivered as the given chunks; the last answers every request after it. */
function serveCalls(...replies: string[][]): void {
  let next = 0;
  fetchMock.mockImplementation(async (url: unknown) => {
    if (!/\/v1\/messages/.test(String(url))) throw new Error(`unexpected request ${String(url)}`);
    const chunks = replies[Math.min(next++, replies.length - 1)];
    return toolCallStream('record_items', chunks);
  });
}

/** The bodies of the Messages requests the stub answered. */
const messageBodies = (): Array<Record<string, unknown>> =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as { body?: unknown }).body)) as Record<string, unknown>);

describe('StructuredOutputManager on a forced Anthropic tool call', () => {
  let manager: StructuredOutputManager;

  beforeEach(async () => {
    fetchMock.mockReset();
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-anthropic-key' });
    manager = new StructuredOutputManager({
      llmProviderManager: { getProvider: () => provider } as never,
      defaultProviderId: 'anthropic',
      defaultModelId: 'claude-sonnet-4-6',
    });
  });

  it('refuses a call whose input repeats a key and reports the input as the model wrote it', async () => {
    serveCalls(['{"items":[{"id":"a"},{"id":"b"}],', '"items":[{"id":"c"}]}']);
    const run = manager.generate({
      prompt: 'List the items.',
      schema: ITEMS,
      schemaName: 'record_items',
      strategy: 'function_calling',
      maxRetries: 0,
    });
    await expect(run).rejects.toBeInstanceOf(StructuredOutputError);
    await expect(run).rejects.toMatchObject({ rawOutput: REPEATED });
    // The request forced the tool by name: its arguments are the answer.
    const [body] = messageBodies();
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_items' });
  });

  it('asks again after a call that repeats a key, and returns the next call that keeps its keys distinct', async () => {
    serveCalls([REPEATED], [CLEAN]);
    const result = await manager.generate({
      prompt: 'List the items.',
      schema: ITEMS,
      schemaName: 'record_items',
      strategy: 'function_calling',
      maxRetries: 1,
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    expect(result.retryCount).toBe(1);
    expect(messageBodies()).toHaveLength(2);
  });

  it('returns a clean call with its input, the raw output byte for byte as the stream delivered it', async () => {
    const chunks = ['{ "items": [ {"id":"a"},', ' {"id":"b"} ] }'];
    serveCalls(chunks);
    const result = await manager.generate({
      prompt: 'List the items.',
      schema: ITEMS,
      schemaName: 'record_items',
      strategy: 'function_calling',
      maxRetries: 0,
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ items: [{ id: 'a' }, { id: 'b' }] });
    expect(result.rawOutput).toBe(chunks.join(''));
  });
});

describe('StructuredOutputManager on arguments a provider hands over as text', () => {
  /** A manager whose one provider answers every request with a call to `record_items` carrying `args`. */
  function managerAnswering(args: string) {
    const generateCompletion = vi.fn(async () => ({
      id: 'c',
      object: 'chat.completion',
      created: 1,
      modelId: 'gpt-4.1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'record_items', arguments: args } }],
          },
          finishReason: 'tool_calls',
        },
      ],
      usage: { promptTokens: 5, completionTokens: 9, totalTokens: 14 },
    }));
    const manager = new StructuredOutputManager({
      llmProviderManager: { getProvider: () => ({ generateCompletion }) } as never,
      defaultProviderId: 'openai',
      defaultModelId: 'gpt-4.1',
    });
    return { manager, generateCompletion };
  }

  it('generate() refuses arguments that repeat a key, on every attempt', async () => {
    const { manager, generateCompletion } = managerAnswering(REPEATED);
    const run = manager.generate({
      prompt: 'List the items.',
      schema: ITEMS,
      schemaName: 'record_items',
      strategy: 'function_calling',
      maxRetries: 1,
    });
    await expect(run).rejects.toMatchObject({ name: 'StructuredOutputError', rawOutput: REPEATED });
    expect(generateCompletion).toHaveBeenCalledTimes(2);
  });

  it('generateFunctionCalls() marks arguments that repeat a key invalid and runs no handler', async () => {
    const { manager } = managerAnswering(REPEATED);
    const handler = vi.fn();
    const result = await manager.generateFunctionCalls({
      prompt: 'Record the items.',
      functions: [{ name: 'record_items', description: 'Records items.', parameters: { type: 'object', properties: { items: { type: 'array' } } }, handler }],
      toolChoice: { type: 'function', function: { name: 'record_items' } },
    });
    expect(result.success).toBe(false);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].argumentsValid).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('generateFunctionCalls() runs the handler with arguments that keep their keys distinct', async () => {
    const { manager } = managerAnswering(CLEAN);
    const handler = vi.fn(async () => 'ok');
    const result = await manager.generateFunctionCalls({
      prompt: 'Record the items.',
      functions: [{ name: 'record_items', description: 'Records items.', parameters: { type: 'object', properties: { items: { type: 'array' } } }, handler }],
    });
    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledWith({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  });

  it('parseJSON() refuses a repeated key wherever the JSON sits, and parses the rest as before', () => {
    const { manager } = managerAnswering(CLEAN);
    expect(manager.parseJSON(REPEATED)).toBeNull();
    expect(manager.parseJSON('```json\n{"a":{"b":1,"b":2}}\n```')).toBeNull();
    expect(manager.parseJSON(`Here it is: ${REPEATED}`)).toBeNull();
    expect(manager.parseJSON('{"a":1,"b":{"a":2},"c":"{\\"a\\":1,\\"a\\":2}"}')).toEqual({ a: 1, b: { a: 2 }, c: '{"a":1,"a":2}' });
    expect(manager.parseJSON('```json\n{"a": 1, "b": 2,}\n```')).toEqual({ a: 1, b: 2 });
  });
});
