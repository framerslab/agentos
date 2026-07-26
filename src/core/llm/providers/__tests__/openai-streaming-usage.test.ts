/**
 * @fileoverview Tests for OpenAI provider streaming usage propagation.
 *
 * Bug context: OpenAI's streaming API omits the `usage` object by default.
 * Without `stream_options.include_usage: true`, the provider's final SSE
 * chunk carries `finish_reason` but no token counts, so downstream
 * `streamText({...}).usage` resolves to zeros even on successful runs.
 *
 * The fix flips on `include_usage` for every streaming request and adds
 * a separate code path in `mapApiToStreamChunkResponse` to recognize the
 * trailing usage-only chunk OpenAI sends after the last content chunk
 * (empty `choices` array, populated `usage`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from '../implementations/OpenAIProvider.js';

function makeUsageOnlyChunk(
  promptTokens: number,
  completionTokens: number,
  promptTokensDetails?: { cached_tokens?: number; cache_write_tokens?: number },
) {
  return {
    id: 'chatcmpl-usage-only',
    object: 'chat.completion.chunk',
    created: 1234567890,
    model: 'gpt-4o',
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...(promptTokensDetails ? { prompt_tokens_details: promptTokensDetails } : {}),
    },
  };
}

describe('OpenAIProvider streaming usage', () => {
  let provider: OpenAIProvider;

  beforeEach(async () => {
    // Mock fetch for the initialize() call's listAvailableModels probe so
    // initialize doesn't reach the real OpenAI API. Each test that needs
    // its own response shape mocks fetch again afterwards (mockResolvedValue
    // overwrites the prior implementation).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-4o', object: 'model', created: 1, owned_by: 'openai' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-test', maxRetries: 1 });
    vi.spyOn(globalThis, 'fetch').mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends stream_options.include_usage on streaming requests', async () => {
    // Capture the request payload by mocking fetch. We only care about
    // the body; the response body is irrelevant for this assertion.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    try {
      // Iterate the stream; we don't care about the chunks here, only
      // that the request body opts into usage reporting.
      for await (const _ of provider.generateCompletionStream(
        'gpt-4o',
        [{ role: 'user', content: 'hi' }],
        {},
      )) {
        // drain
      }
    } catch {
      // Provider may throw on the malformed empty stream — that's fine.
    }

    expect(fetchSpy).toHaveBeenCalled();
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('omits stream_options.include_usage on non-streaming requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-x',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello' },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await provider.generateCompletion('gpt-4o', [{ role: 'user', content: 'hi' }], {});

    expect(fetchSpy).toHaveBeenCalled();
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
    expect(body.stream_options).toBeUndefined();
  });

  it('maps trailing usage-only chunk to isFinal=true with usage populated', async () => {
    // Simulated SSE stream:
    //   1. content chunk with text delta
    //   2. content chunk with finish_reason and empty content
    //   3. usage-only chunk (empty choices, populated usage) -- the one
    //      OpenAI emits when stream_options.include_usage is true
    //   4. [DONE]
    const sse = [
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'hello' },
            finish_reason: null,
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify(makeUsageOnlyChunk(12, 34))}\n\n`,
      'data: [DONE]\n\n',
    ].join('');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const chunks: { isFinal?: boolean; usage?: { totalTokens?: number } }[] = [];
    for await (const chunk of provider.generateCompletionStream(
      'gpt-4o',
      [{ role: 'user', content: 'hi' }],
      {},
    )) {
      chunks.push(chunk as { isFinal?: boolean; usage?: { totalTokens?: number } });
    }

    const usageChunk = chunks.find((c) => c.usage && c.isFinal);
    expect(usageChunk).toBeDefined();
    expect(usageChunk!.usage!.totalTokens).toBe(46);
  });
});

describe('OpenAIProvider cached-token normalization (automatic prompt caching)', () => {
  let provider: OpenAIProvider;

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-4o', object: 'model', created: 1, owned_by: 'openai' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-test', maxRetries: 1 });
    vi.spyOn(globalThis, 'fetch').mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes prompt_tokens_details.cached_tokens on non-streaming completions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-cached',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello' },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 40,
            total_tokens: 1240,
            prompt_tokens_details: { cached_tokens: 1024 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await provider.generateCompletion(
      'gpt-4o',
      [{ role: 'user', content: 'hi' }],
      {},
    );
    // Cached tokens surface on the same normalized field the Anthropic and
    // OpenRouter providers use; prompt_tokens stays INCLUSIVE of them
    // (OpenAI accounting), so promptTokens is unchanged.
    expect(result.usage?.cacheReadInputTokens).toBe(1024);
    expect(result.usage?.promptTokens).toBe(1200);
  });

  it('normalizes cached_tokens on the trailing streaming usage-only chunk', async () => {
    const usageOnly = {
      ...makeUsageOnlyChunk(500, 20),
      usage: {
        prompt_tokens: 500,
        completion_tokens: 20,
        total_tokens: 520,
        prompt_tokens_details: { cached_tokens: 384 },
      },
    };
    const sse = [
      `data: ${JSON.stringify({
        id: 'chatcmpl-2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: 'chatcmpl-2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`,
      `data: ${JSON.stringify(usageOnly)}\n\n`,
      'data: [DONE]\n\n',
    ].join('');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );

    const chunks: { isFinal?: boolean; usage?: { cacheReadInputTokens?: number } }[] = [];
    for await (const chunk of provider.generateCompletionStream(
      'gpt-4o',
      [{ role: 'user', content: 'hi' }],
      {},
    )) {
      chunks.push(chunk as { isFinal?: boolean; usage?: { cacheReadInputTokens?: number } });
    }

    const usageChunk = chunks.find((c) => c.usage && c.isFinal);
    expect(usageChunk?.usage?.cacheReadInputTokens).toBe(384);
  });
});

describe('OpenAIProvider streaming cache-write usage (spec batch-1 C2)', () => {
  let provider: OpenAIProvider;

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-4o', object: 'model', created: 1, owned_by: 'openai' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-test', maxRetries: 1 });
    vi.spyOn(globalThis, 'fetch').mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes cached_tokens + cache_write_tokens from the trailing usage-only chunk', async () => {
    const sentinel = makeUsageOnlyChunk(120, 5, { cached_tokens: 64, cache_write_tokens: 40 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`data: ${JSON.stringify(sentinel)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    let finalUsage: { cacheReadInputTokens?: number; cacheCreationInputTokens?: number; inclusiveInputTokens?: number } | undefined;
    for await (const chunk of provider.generateCompletionStream(
      'gpt-4o',
      [{ role: 'user', content: 'hi' }],
      {},
    )) {
      if (chunk.usage) finalUsage = chunk.usage;
    }

    expect(finalUsage?.cacheReadInputTokens).toBe(64);
    expect(finalUsage?.cacheCreationInputTokens).toBe(40);
    expect(finalUsage?.inclusiveInputTokens).toBe(120);
  });
});
