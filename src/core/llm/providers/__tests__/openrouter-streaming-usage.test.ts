/**
 * @fileoverview Tests for OpenRouter provider streaming usage propagation and
 * the role of the final streamed message.
 *
 * OpenRouter follows OpenAI's streaming convention: usage is omitted unless
 * stream_options.include_usage is set, in which case a trailing usage-only
 * chunk arrives before [DONE] (empty `choices` array, populated `usage`).
 *
 * Two bugs were fixed:
 *   1. The streaming payload didn't set stream_options.include_usage, so
 *      OpenRouter never sent a usage chunk; downstream
 *      streamText({...}).usage resolved to all zeros.
 *   2. mapApiToStreamChunkResponse returned a malformed-response error when
 *      the trailing usage-only chunk arrived (because it short-circuited on
 *      the empty choices array before checking for usage).
 *
 * These tests pin the fixed behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { OpenRouterProvider } from '../implementations/OpenRouterProvider.js';
import { reconstructStream } from '../../streaming/StreamingReconstructor.js';

interface MockClient {
  request: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function makeReadableSse(lines: string[]): NodeJS.ReadableStream {
  // OpenRouter's SSE parser expects a Node Readable that yields chunks of
  // `data: <json>\n\n` blocks. Build one from a small array of pre-formed
  // lines to keep the fixture obvious.
  return Readable.from(lines.map((l) => Buffer.from(l)));
}

function makeUsageOnlyChunk(prompt: number, completion: number) {
  return {
    id: 'gen-usage-only',
    object: 'chat.completion.chunk',
    created: 1234567890,
    model: 'openai/gpt-4o',
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
  };
}

async function mountProvider(): Promise<{ provider: OpenRouterProvider; client: MockClient }> {
  const client: MockClient = {
    request: vi.fn(),
    get: vi.fn().mockResolvedValue({ data: { data: [] } }),
  };
  // Stub axios.create to return our mock client BEFORE initialize is called,
  // because initialize calls axios.create + listAvailableModels.
  const axios = (await import('axios')).default;
  vi.spyOn(axios, 'create').mockReturnValue(client as never);
  client.request.mockResolvedValueOnce({
    data: {
      data: [
        {
          id: 'openai/gpt-4o',
          name: 'GPT-4o',
          description: 'mock model',
          context_length: 128000,
          pricing: { prompt: '0.000005', completion: '0.000015' },
        },
      ],
    },
  });

  const provider = new OpenRouterProvider();
  await provider.initialize({ apiKey: 'sk-test' });
  return { provider, client };
}

describe('OpenRouterProvider streaming usage', () => {
  beforeEach(() => {
    // Each test rebuilds the mount; nothing to do here.
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends stream_options.include_usage on streaming requests', async () => {
    const { provider, client } = await mountProvider();
    // The streaming call requests responseType: stream; we return an empty
    // Readable that immediately ends, so the iterator loop exits cleanly.
    client.request.mockResolvedValueOnce({ data: makeReadableSse(['data: [DONE]\n\n']) });

    try {
      for await (const _ of provider.generateCompletionStream(
        'openai/gpt-4o',
        [{ role: 'user', content: 'hi' }],
        {},
      )) {
        // drain
      }
    } catch {
      // empty stream may throw at the parser tail; not relevant to this test
    }

    // The streaming POST call to /chat/completions is the second client
    // request (after the listModels probe in initialize).
    const streamingCall = client.request.mock.calls.find(
      (call) => call[0]?.url === '/chat/completions' && call[0]?.method === 'POST',
    );
    expect(streamingCall).toBeDefined();
    const body = streamingCall![0].data as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('omits stream_options on non-streaming requests', async () => {
    const { provider, client } = await mountProvider();
    client.request.mockResolvedValueOnce({
      data: {
        id: 'gen-1',
        object: 'chat.completion',
        created: 1,
        model: 'openai/gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'hello' },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    });

    await provider.generateCompletion(
      'openai/gpt-4o',
      [{ role: 'user', content: 'hi' }],
      {},
    );

    const nonStreamingCall = client.request.mock.calls.find(
      (call) => call[0]?.url === '/chat/completions' && call[0]?.method === 'POST',
    );
    expect(nonStreamingCall).toBeDefined();
    const body = nonStreamingCall![0].data as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.stream_options).toBeUndefined();
  });

  it('maps trailing usage-only chunk to isFinal=true with usage populated', async () => {
    const { provider, client } = await mountProvider();
    const sseLines = [
      `data: ${JSON.stringify({
        id: 'gen-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'openai/gpt-4o',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'hello' },
            finish_reason: null,
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: 'gen-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'openai/gpt-4o',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify(makeUsageOnlyChunk(7, 11))}\n\n`,
      'data: [DONE]\n\n',
    ];
    client.request.mockResolvedValueOnce({ data: makeReadableSse(sseLines) });

    const chunks: { isFinal?: boolean; usage?: { totalTokens?: number }; error?: unknown }[] = [];
    for await (const chunk of provider.generateCompletionStream(
      'openai/gpt-4o',
      [{ role: 'user', content: 'hi' }],
      {},
    )) {
      chunks.push(chunk as { isFinal?: boolean; usage?: { totalTokens?: number }; error?: unknown });
    }

    // The previous bug returned an error chunk (`Stream chunk contained no
    // choices.`) for the trailing usage-only payload. The fix swallows that
    // path and returns a clean usage chunk instead.
    const errorChunks = chunks.filter((c) => c.error);
    expect(errorChunks).toHaveLength(0);

    const usageChunk = chunks.find((c) => c.usage && c.isFinal);
    expect(usageChunk).toBeDefined();
    expect(usageChunk!.usage!.totalTokens).toBe(18);
  });
});

describe('OpenRouterProvider streaming final message', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the role the final chunk's delta names", async () => {
    // `||` binds tighter than `?:`: the role expression read as
    // `(delta.role || hasToolCalls) ? 'assistant' : ...` and replaced any
    // streamed role with 'assistant'.
    const { provider, client } = await mountProvider();
    const sseLines = [
      `data: ${JSON.stringify({
        id: 'gen-2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'openai/gpt-4o',
        choices: [{ index: 0, delta: { role: 'tool', content: 'done' }, finish_reason: 'stop' }],
      })}\n\n`,
      'data: [DONE]\n\n',
    ];
    client.request.mockResolvedValueOnce({ data: makeReadableSse(sseLines) });

    const finals: Array<{ choices: Array<{ message: { role: string } }> }> = [];
    for await (const chunk of provider.generateCompletionStream(
      'openai/gpt-4o',
      [{ role: 'user', content: 'hi' }],
      {},
    )) {
      const c = chunk as { isFinal?: boolean; choices?: Array<{ message: { role: string } }> };
      if (c.isFinal && c.choices?.length) finals.push(c as { choices: Array<{ message: { role: string } }> });
    }

    expect(finals).toHaveLength(1);
    expect(finals[0].choices[0].message.role).toBe('tool');
  });

  it('keeps the text and tool-argument fragments the finish chunk carries', async () => {
    const { provider, client } = await mountProvider();
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: 'gen-3',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'openai/gpt-4o',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const call = (args: string, first = false) => ({
      tool_calls: [
        {
          index: 0,
          ...(first ? { id: 'call_1', type: 'function' } : {}),
          function: { ...(first ? { name: 'lookup' } : {}), arguments: args },
        },
      ],
    });
    client.request.mockResolvedValueOnce({
      data: makeReadableSse([
        chunk({ role: 'assistant', content: 'Hello ' }, null),
        chunk({ content: 'world' }, 'stop'),
        'data: [DONE]\n\n',
      ]),
    });
    client.request.mockResolvedValueOnce({
      data: makeReadableSse([
        chunk({ role: 'assistant', ...call('{"q":', true) }, null),
        chunk(call('"x"}'), 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    });

    const text = await reconstructStream(
      provider.generateCompletionStream('openai/gpt-4o', [{ role: 'user', content: 'hi' }], {}),
    );
    const tools = await reconstructStream(
      provider.generateCompletionStream('openai/gpt-4o', [{ role: 'user', content: 'hi' }], {}),
    );

    expect(text.fullText).toBe('Hello world');
    expect(tools.toolCalls).toHaveLength(1);
    expect(tools.toolCalls[0].arguments).toEqual({ q: 'x' });
  });
});
