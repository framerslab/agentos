/**
 * @fileoverview OpenAIProvider routing to /v1/responses and the Responses
 * stream mapping, through a real initialize() with only fetch stubbed.
 *
 * Streamed and non-streamed calls share one routing rule: Responses-only
 * models, GPT-6 tool calls, and GPT-5/GPT-6 tool calls that carry an effort
 * go to /v1/responses. The stream mapper turns Responses SSE events into the
 * chat-chunk contract (text and tool-call deltas, exactly one final chunk),
 * sends whatever the deltas left out before that final chunk, and honours a
 * caller abort before the POST and during a pending read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { OpenAIProvider } from '../implementations/OpenAIProvider';
import { OpenAIProviderError } from '../errors/OpenAIProviderError';
import { StreamingReconstructor } from '../../streaming/StreamingReconstructor';
import type { ChatMessage, ModelCompletionResponse } from '../IProvider';

type Json = Record<string, any>;

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const USER: ChatMessage[] = [{ role: 'user', content: 'Call ping with x="ok".' }];
const pingTool: Array<Record<string, unknown>> = [
  {
    type: 'function',
    function: {
      name: 'ping',
      description: 'Ping.',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
    },
  },
];
const USAGE = {
  input_tokens: 120,
  input_tokens_details: { cached_tokens: 64 },
  output_tokens: 30,
  output_tokens_details: { reasoning_tokens: 10 },
  total_tokens: 150,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** SSE text in the /v1/responses framing: an `event:` line and a `data:` line per event. */
function sseText(events: Json[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A 200 response whose body is `body` itself, so the test sees reads and cancellation. */
function streamingResponse(body: ReadableStream<Uint8Array>): Response {
  return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), body } as unknown as Response;
}

/** Lists models on GET and answers each POST with the next queued reply. */
function serve(replies: Array<() => Response>): void {
  const queue = [...replies];
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return jsonResponse({
        object: 'list',
        data: ['gpt-6-sol', 'gpt-4o'].map((id) => ({ id, object: 'model', created: 1, owned_by: 'openai' })),
      });
    }
    const next = queue.shift();
    if (!next) throw new Error(`unexpected POST ${String(url)}`);
    return next();
  });
}

/** URL and parsed JSON body of every POST, in call order. */
function posts(): Array<{ url: string; body: Json }> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) as Json }));
}

async function initializedProvider(): Promise<OpenAIProvider> {
  const provider = new OpenAIProvider();
  await provider.initialize({ apiKey: 'sk-test', maxRetries: 1 });
  return provider;
}

async function collect(
  stream: AsyncGenerator<ModelCompletionResponse, void, undefined>,
): Promise<ModelCompletionResponse[]> {
  const chunks: ModelCompletionResponse[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** The only final chunk, after asserting there is exactly one and it is last. */
function soleFinal(chunks: ModelCompletionResponse[]): ModelCompletionResponse {
  const finals = chunks.filter((c) => c.isFinal);
  expect(finals).toHaveLength(1);
  expect(chunks[chunks.length - 1]).toBe(finals[0]);
  return finals[0];
}

const RESPONSE_META = { id: 'resp_1', object: 'response', created_at: 1700000000, model: 'gpt-6-sol' };
const created = (model = 'gpt-6-sol'): Json => ({
  type: 'response.created',
  response: { ...RESPONSE_META, model, status: 'in_progress', output: [], usage: null },
});
const completed = (output: Json[], extra: Json = {}): Json => ({
  type: 'response.completed',
  response: { ...RESPONSE_META, status: 'completed', output, usage: USAGE, ...extra },
});
const fnItem = (fields: Json = {}): Json => ({
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'ping',
  arguments: '{"x":"ok"}',
  status: 'completed',
  ...fields,
});
const messageItem = (text: string): Json => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const textDelta = (delta: string): Json => ({
  type: 'response.output_text.delta',
  output_index: 0,
  item_id: 'msg_1',
  content_index: 0,
  delta,
});
const callAdded = (outputIndex: number, item: Json = fnItem()): Json => ({
  type: 'response.output_item.added',
  output_index: outputIndex,
  item: { ...item, arguments: '', status: 'in_progress' },
});
const argsDelta = (outputIndex: number, itemId: string, delta: string): Json => ({
  type: 'response.function_call_arguments.delta',
  output_index: outputIndex,
  item_id: itemId,
  delta,
});
const callDone = (outputIndex: number, item: Json = fnItem()): Json => ({
  type: 'response.output_item.done',
  output_index: outputIndex,
  item,
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe('OpenAIProvider routes to /v1/responses', () => {
  it('sends a non-streamed gpt-6-sol tool call with no effort to /v1/responses', async () => {
    serve([
      () =>
        jsonResponse({
          ...RESPONSE_META,
          status: 'completed',
          output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, fnItem()],
          usage: USAGE,
        }),
    ]);
    const provider = await initializedProvider();

    const result = await provider.generateCompletion('gpt-6-sol', USER, { tools: pingTool });

    const [post] = posts();
    expect(post.url).toBe(RESPONSES_URL);
    expect(post.body.tools).toEqual([
      {
        type: 'function',
        name: 'ping',
        description: 'Ping.',
        parameters: { type: 'object', properties: { x: { type: 'string' } } },
        strict: false,
      },
    ]);
    for (const key of ['reasoning', 'reasoning_effort', 'messages', 'stream']) {
      expect(post.body).not.toHaveProperty(key);
    }
    expect(result.choices[0].finishReason).toBe('tool_calls');
    expect(result.choices[0].message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{"x":"ok"}' } },
    ]);
  });

  it('sends a Responses-only model to /v1/responses with no tools and no reasoning', async () => {
    serve([
      () =>
        jsonResponse({
          ...RESPONSE_META,
          model: 'gpt-5.3-codex',
          status: 'completed',
          output: [messageItem('hi')],
          usage: USAGE,
        }),
    ]);
    const provider = await initializedProvider();

    const result = await provider.generateCompletion('gpt-5.3-codex', USER, {});

    const [post] = posts();
    expect(post.url).toBe(RESPONSES_URL);
    expect(post.body).not.toHaveProperty('tools');
    expect(post.body).not.toHaveProperty('reasoning');
    expect(post.body.input).toEqual([{ role: 'user', content: 'Call ping with x="ok".' }]);
    expect(result.choices[0].message.content).toBe('hi');
  });

  it('maps responseFormat onto text.format and never sends response_format', async () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    serve([
      () => jsonResponse({ ...RESPONSE_META, status: 'completed', output: [messageItem('{"answer":"4"}')] }),
      () => jsonResponse({ ...RESPONSE_META, status: 'completed', output: [messageItem('{}')] }),
    ]);
    const provider = await initializedProvider();

    await provider.generateCompletion('gpt-5.5-pro', USER, {
      responseFormat: { type: 'json_schema', json_schema: { name: 'Answer', strict: true, schema } },
    });
    await provider.generateCompletion('gpt-6-astra', USER, {
      tools: pingTool,
      effort: 'high',
      responseFormat: { type: 'json_object' },
    });

    const [schemaPost, jsonPost] = posts();
    expect(schemaPost.url).toBe(RESPONSES_URL);
    expect(schemaPost.body.text).toEqual({ format: { type: 'json_schema', name: 'Answer', schema, strict: true } });
    expect(jsonPost.url).toBe(RESPONSES_URL);
    expect(jsonPost.body.text).toEqual({ format: { type: 'json_object' } });
    expect(jsonPost.body.reasoning).toEqual({ effort: 'high' });
    for (const { body } of [schemaPost, jsonPost]) expect(body).not.toHaveProperty('response_format');
  });

  it('carries images on user turns and on tool results', async () => {
    serve([() => jsonResponse({ ...RESPONSE_META, model: 'gpt-6-astra', status: 'completed', output: [messageItem('ok')] })]);
    const provider = await initializedProvider();
    const conversation: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in these?' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{"x":"b"}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: [
          { type: 'text', text: 'here' },
          { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
        ],
      },
    ];

    await provider.generateCompletion('gpt-6-astra', conversation, { tools: pingTool });

    const [post] = posts();
    expect(post.url).toBe(RESPONSES_URL);
    expect(post.body.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is in these?' },
          { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'low' },
        ],
      },
      { type: 'function_call', call_id: 'call_1', name: 'ping', arguments: '{"x":"b"}' },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'here' },
          { type: 'input_image', image_url: 'https://example.com/b.png', detail: 'auto' },
        ],
      },
    ]);
  });

  it('sends max to gpt-6-luna and xhigh to gpt-6-sol (probed 2026-09-30)', async () => {
    serve([
      () => jsonResponse({ ...RESPONSE_META, status: 'completed', output: [fnItem()] }),
      () => jsonResponse({ ...RESPONSE_META, status: 'completed', output: [fnItem()] }),
    ]);
    const provider = await initializedProvider();

    await provider.generateCompletion('gpt-6-luna', USER, { tools: pingTool, effort: 'max' });
    await provider.generateCompletion('gpt-6-sol', USER, { tools: pingTool, effort: 'xhigh' });

    expect(posts().map((p) => [p.url, p.body.reasoning])).toEqual([
      [RESPONSES_URL, { effort: 'max' }],
      [RESPONSES_URL, { effort: 'xhigh' }],
    ]);
  });

  it('moves a customModelParams reasoning_effort to reasoning.effort', async () => {
    serve([() => jsonResponse({ ...RESPONSE_META, status: 'completed', output: [fnItem()] })]);
    const provider = await initializedProvider();

    await provider.generateCompletion('gpt-6-sol', USER, {
      tools: pingTool,
      customModelParams: { reasoning_effort: 'none' },
    });

    const [post] = posts();
    expect(post.url).toBe(RESPONSES_URL);
    expect(post.body.reasoning).toEqual({ effort: 'none' });
    expect(post.body).not.toHaveProperty('reasoning_effort');
  });

  it('moves chat output limits in customModelParams to max_output_tokens', async () => {
    serve([
      () => jsonResponse({ ...RESPONSE_META, status: 'completed', output: [fnItem()], usage: USAGE }),
    ]);
    const provider = await initializedProvider();

    await provider.generateCompletion('gpt-6-sol', USER, {
      tools: pingTool,
      customModelParams: { max_completion_tokens: 4096, stream_options: { include_usage: true } },
    });

    const body = posts()[0].body;
    expect(body.max_output_tokens).toBe(4096);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('stream_options');
  });

  it('reshapes chat-style overrides in customModelParams for a call moved to /v1/responses', async () => {
    serve([() => sseResponse(sseText([created('gpt-5.5'), completed([fnItem()])]))]);
    const provider = await initializedProvider();

    await collect(
      provider.generateCompletionStream('gpt-5.5', USER, {
        tools: pingTool,
        effort: 'high',
        customModelParams: {
          tool_choice: { type: 'function', function: { name: 'ping' } },
          tools: pingTool,
          response_format: { type: 'json_object' },
          verbosity: 'low',
        },
      }),
    );

    const [post] = posts();
    expect(post.url).toBe(RESPONSES_URL);
    expect(post.body.tool_choice).toEqual({ type: 'function', name: 'ping' });
    expect(post.body.tools).toEqual([expect.objectContaining({ type: 'function', name: 'ping' })]);
    expect(post.body.text).toEqual({ format: { type: 'json_object' }, verbosity: 'low' });
    expect(post.body).not.toHaveProperty('response_format');
    expect(post.body).not.toHaveProperty('verbosity');
  });

  it('reshapes a chat-style allowed-tools choice for /v1/responses', async () => {
    serve([() => sseResponse(sseText([created('gpt-5.5'), completed([fnItem()])]))]);
    const provider = await initializedProvider();

    await collect(
      provider.generateCompletionStream('gpt-5.5', USER, {
        tools: pingTool,
        effort: 'high',
        customModelParams: {
          tool_choice: {
            type: 'allowed_tools',
            allowed_tools: { mode: 'required', tools: [{ type: 'function', function: { name: 'ping' } }] },
          },
        },
      }),
    );

    const [post] = posts();
    expect(post.url).toBe(RESPONSES_URL);
    expect(post.body.tool_choice).toEqual({
      type: 'allowed_tools',
      mode: 'required',
      tools: [{ type: 'function', name: 'ping' }],
    });
  });

  it('keeps an explicit strict on a tool moved to /v1/responses', async () => {
    serve([() => sseResponse(sseText([created('gpt-5.5'), completed([fnItem()])]))]);
    const provider = await initializedProvider();
    const strictTool = {
      type: 'function',
      function: {
        name: 'strict_ping',
        description: 'Ping, strictly.',
        parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false },
        strict: true,
      },
    };

    await collect(provider.generateCompletionStream('gpt-5.5', USER, { tools: [...pingTool, strictTool], effort: 'high' }));

    const [post] = posts();
    expect(post.url).toBe(RESPONSES_URL);
    expect(post.body.tools.map((t: Json) => [t.name, t.strict])).toEqual([
      ['ping', false],
      ['strict_ping', true],
    ]);
  });

  it('rejects content /v1/responses cannot carry without sending a request', async () => {
    serve([]);
    const provider = await initializedProvider();
    const withAudio: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this.' },
          { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
        ],
      },
    ];

    await expect(provider.generateCompletion('gpt-5.3-codex', withAudio, {})).rejects.toMatchObject({
      code: 'RESPONSES_UNMAPPABLE_CONTENT',
    });
    await expect(collect(provider.generateCompletionStream('gpt-5.3-codex', withAudio, {}))).rejects.toMatchObject({
      code: 'RESPONSES_UNMAPPABLE_CONTENT',
    });
    expect(posts()).toHaveLength(0);
  });

  it('routes streamed and non-streamed calls by one rule', async () => {
    const chatStream = () =>
      sseResponse(
        `data: ${JSON.stringify({
          id: 'c',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-5.6',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        })}\n\ndata: [DONE]\n\n`,
      );
    const chatJson = () =>
      jsonResponse({
        id: 'c',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      });
    serve([
      chatJson,
      chatJson,
      () => sseResponse(sseText([created('gpt-5.5'), textDelta('ok'), completed([messageItem('ok')])])),
      chatStream,
      chatJson,
    ]);
    const provider = await initializedProvider();

    await provider.generateCompletion('gpt-5.6', USER, { tools: pingTool });
    await provider.generateCompletion('gpt-6-sol', USER, { effort: 'high' });
    await collect(provider.generateCompletionStream('gpt-5.5', USER, { tools: pingTool, effort: 'max' }));
    await collect(provider.generateCompletionStream('gpt-5.6', USER, { tools: pingTool }));
    await provider.generateCompletion('gpt-4o', USER, { tools: pingTool, effort: 'high' });

    const sent = posts();
    expect(sent.map((p) => p.url)).toEqual([CHAT_URL, CHAT_URL, RESPONSES_URL, CHAT_URL, CHAT_URL]);
    // No tools: gpt-6-sol keeps its effort on chat.
    expect(sent[1].body.reasoning_effort).toBe('high');
    // A streamed GPT-5 tool call with an effort keeps it on /v1/responses.
    expect(sent[2].body.reasoning).toEqual({ effort: 'xhigh' });
    expect(sent[2].body.stream).toBe(true);
  });
});

describe('OpenAIProvider /v1/responses streaming', () => {
  it('streams a gpt-6-sol tool call as ordered deltas and one final chunk with usage', async () => {
    serve([
      () =>
        sseResponse(
          sseText([
            created(),
            callAdded(0),
            argsDelta(0, 'fc_1', '{"x":'),
            argsDelta(0, 'fc_1', '"ok"}'),
            { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{"x":"ok"}' },
            callDone(0),
            completed([fnItem()], { service_tier: 'default' }),
          ]),
        ),
    ]);
    const provider = await initializedProvider();

    const chunks = await collect(provider.generateCompletionStream('gpt-6-sol', USER, { tools: pingTool }));

    const [post] = posts();
    expect(post.url).toBe(RESPONSES_URL);
    expect(post.body.stream).toBe(true);
    expect(post.body).not.toHaveProperty('stream_options');
    expect(chunks.flatMap((c) => c.toolCallsDeltas ?? [])).toEqual([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'ping' } },
      { index: 0, function: { arguments_delta: '{"x":' } },
      { index: 0, function: { arguments_delta: '"ok"}' } },
    ]);
    const final = soleFinal(chunks);
    expect(final.error).toBeUndefined();
    expect(final.choices[0].finishReason).toBe('tool_calls');
    expect(final.choices[0].message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{"x":"ok"}' } },
    ]);
    expect(final.serviceTier).toBe('default');
    expect(final.usage).toMatchObject({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cacheReadInputTokens: 64,
      inclusiveInputTokens: 120,
    });
    expect(final.usage?.costUSD).toBeGreaterThan(0);

    const rebuilt = new StreamingReconstructor();
    for (const chunk of chunks) rebuilt.push(chunk);
    expect(rebuilt.getToolCalls()).toEqual([
      expect.objectContaining({ index: 0, id: 'call_1', name: 'ping', arguments: { x: 'ok' } }),
    ]);
  });

  it('streams text from a Responses-only model and sends nothing to chat/completions', async () => {
    serve([
      () =>
        sseResponse(
          sseText([
            created('gpt-5.3-codex'),
            { type: 'response.output_item.added', output_index: 0, item: { ...messageItem(''), content: [] } },
            textDelta('Hel'),
            textDelta('lo'),
            { type: 'response.output_text.done', output_index: 0, item_id: 'msg_1', content_index: 0, text: 'Hello' },
            completed([messageItem('Hello')], { model: 'gpt-5.3-codex' }),
          ]),
        ),
    ]);
    const provider = await initializedProvider();

    const chunks = await collect(provider.generateCompletionStream('gpt-5.3-codex', USER, {}));

    expect(posts().map((p) => p.url)).toEqual([RESPONSES_URL]);
    expect(chunks.map((c) => c.responseTextDelta).filter(Boolean)).toEqual(['Hel', 'lo']);
    expect(soleFinal(chunks).choices[0].finishReason).toBe('stop');
  });

  it('gives calls dense indexes when a reasoning item comes first', async () => {
    const callA = fnItem({ id: 'fc_a', call_id: 'call_a', arguments: '{"x":"a"}' });
    const callB = fnItem({ id: 'fc_b', call_id: 'call_b', arguments: '{"x":"b"}' });
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [] };
    serve([
      () =>
        sseResponse(
          sseText([
            created(),
            { type: 'response.output_item.added', output_index: 0, item: reasoning },
            { type: 'response.output_item.done', output_index: 0, item: reasoning },
            callAdded(1, callA),
            argsDelta(1, 'fc_a', '{"x":"a"}'),
            callDone(1, callA),
            callAdded(2, callB),
            argsDelta(2, 'fc_b', '{"x":"b"}'),
            callDone(2, callB),
            completed([reasoning, callA, callB]),
          ]),
        ),
    ]);
    const provider = await initializedProvider();

    const chunks = await collect(provider.generateCompletionStream('gpt-6-sol', USER, { tools: pingTool }));

    expect(chunks.flatMap((c) => c.toolCallsDeltas ?? []).map((d) => d.index)).toEqual([0, 0, 1, 1]);
    expect(soleFinal(chunks).choices[0].message.tool_calls?.map((c) => [c.id, c.function.arguments])).toEqual([
      ['call_a', '{"x":"a"}'],
      ['call_b', '{"x":"b"}'],
    ]);
  });

  it.each<[string, Json[], string | undefined, string | undefined]>([
    [
      'response.incomplete for max_output_tokens',
      [
        created(),
        textDelta('Par'),
        {
          type: 'response.incomplete',
          response: {
            ...RESPONSE_META,
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [messageItem('Par')],
            usage: USAGE,
          },
        },
      ],
      undefined,
      'length',
    ],
    [
      'response.failed after output',
      [
        created(),
        textDelta('Par'),
        {
          type: 'response.failed',
          response: {
            ...RESPONSE_META,
            status: 'failed',
            error: { code: 'server_error', message: 'The model failed.' },
            output: [],
            usage: null,
          },
        },
      ],
      'response_failed',
      undefined,
    ],
    [
      'response.incomplete for max_output_tokens during a function call',
      [
        created(),
        callAdded(0),
        argsDelta(0, 'fc_1', '{"x":'),
        {
          type: 'response.incomplete',
          response: {
            ...RESPONSE_META,
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [fnItem({ arguments: '{"x":', status: 'incomplete' })],
            usage: USAGE,
          },
        },
      ],
      undefined,
      'length',
    ],
    [
      'an error event after output',
      [created(), textDelta('Par'), { type: 'error', code: 'server_error', message: 'Stream broke.', param: null }],
      'stream_error',
      undefined,
    ],
    ['a body with no terminal event', [created(), textDelta('Hi')], 'stream_truncated', undefined],
    ['a completed response with no output and nothing streamed', [created(), completed([])], 'invalid_response', undefined],
  ])('ends %s with exactly one final chunk', async (_label, events, errorType, finishReason) => {
    serve([() => sseResponse(sseText(events))]);
    const provider = await initializedProvider();

    const final = soleFinal(await collect(provider.generateCompletionStream('gpt-5.3-codex', USER, {})));

    expect(final.error?.type).toBe(errorType);
    if (errorType === 'response_failed') expect(final.error).toMatchObject({ code: 'server_error', message: 'The model failed.' });
    if (finishReason) expect(final.choices[0].finishReason).toBe(finishReason);
  });

  it.each<[string, Json[], Json]>([
    [
      'a failed response',
      [
        created(),
        {
          type: 'response.failed',
          response: {
            ...RESPONSE_META,
            status: 'failed',
            error: { code: 'server_error', message: 'The model failed.' },
            output: [],
            usage: USAGE,
          },
        },
      ],
      {
        code: 'RESPONSES_FAILED',
        openaiErrorCode: 'server_error',
        httpStatus: 500,
        message: 'The model failed.',
        details: expect.objectContaining({ usage: expect.objectContaining({ completionTokens: 30, totalTokens: 150 }) }),
      },
    ],
    [
      'a rate-limited error event',
      [created(), { type: 'error', code: 'rate_limit_exceeded', message: 'Slow down.', param: null }],
      { code: 'RESPONSES_STREAM_ERROR', openaiErrorCode: 'rate_limit_exceeded', httpStatus: 429 },
    ],
    [
      'a failed response for an invalid prompt',
      [
        created(),
        {
          type: 'response.failed',
          response: {
            ...RESPONSE_META,
            status: 'failed',
            error: { code: 'invalid_prompt', message: 'Invalid prompt.' },
            output: [],
            usage: null,
          },
        },
      ],
      { code: 'RESPONSES_FAILED', openaiErrorCode: 'invalid_prompt', httpStatus: undefined },
    ],
    ['a body cut off after response.created', [created()], { code: 'NETWORK_ERROR' }],
  ])('throws on %s before any output, as a failed request does', async (_label, events, expected) => {
    serve([() => sseResponse(sseText(events))]);
    const provider = await initializedProvider();

    const error = await collect(provider.generateCompletionStream('gpt-5.3-codex', USER, {})).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAIProviderError);
    expect(error).toMatchObject(expected);
  });

  it('reads a terminal event whose body ends without the closing blank line', async () => {
    const text = sseText([created(), textDelta('Hi'), completed([messageItem('Hi')])]).trimEnd();
    serve([() => sseResponse(text)]);
    const provider = await initializedProvider();

    const final = soleFinal(await collect(provider.generateCompletionStream('gpt-5.3-codex', USER, {})));

    expect(final.error).toBeUndefined();
    expect(final.choices[0].finishReason).toBe('stop');
  });
});

describe('OpenAIProvider /v1/responses stream: the terminal output is authoritative', () => {
  const partialArgs = [
    created(),
    callAdded(0),
    argsDelta(0, 'fc_1', '{"x":'),
    callDone(0),
    completed([fnItem()]),
  ];

  it.each<[string, Json[], string, Array<{ id: string; name: string; arguments: unknown }>]>([
    ['text that arrives only in the terminal output', [created(), completed([messageItem('Hello')])], 'Hello', []],
    ['text deltas followed by the complete answer', [created(), textDelta('Hel'), completed([messageItem('Hello')])], 'Hello', []],
    ['a call that arrives only in the terminal output', [created(), completed([fnItem()])], '', [{ id: 'call_1', name: 'ping', arguments: { x: 'ok' } }]],
    ['argument deltas that stop short of the final item', partialArgs, '', [{ id: 'call_1', name: 'ping', arguments: { x: 'ok' } }]],
  ])('%s reaches the deltas and the final chunk once', async (_label, events, text, calls) => {
    serve([() => sseResponse(sseText(events))]);
    const provider = await initializedProvider();

    const chunks = await collect(provider.generateCompletionStream('gpt-6-sol', USER, { tools: pingTool }));

    const rebuilt = new StreamingReconstructor();
    for (const chunk of chunks) rebuilt.push(chunk);
    expect(rebuilt.getFullText()).toBe(text);
    expect(rebuilt.getToolCalls().map(({ id, name, arguments: args }) => ({ id, name, arguments: args }))).toEqual(calls);
    const finalCalls = soleFinal(chunks).choices[0].message.tool_calls ?? [];
    expect(
      finalCalls.map((c) => ({ id: c.id, name: c.function.name, arguments: JSON.parse(c.function.arguments) as unknown })),
    ).toEqual(calls);
  });
});

describe('OpenAIProvider /v1/responses stream: a read that fails mid-body', () => {
  /** A body that delivers `text`, then fails its next read as a dropped connection does. */
  function bodyFailingAfter(text: string): ReadableStream<Uint8Array> {
    let sent = false;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(text));
          return;
        }
        controller.error(new TypeError('terminated'));
      },
    });
  }

  it('throws a retryable network error when nothing has gone out yet', async () => {
    serve([() => streamingResponse(bodyFailingAfter(sseText([created('gpt-5.3-codex')])))]);
    const provider = await initializedProvider();

    const error = await collect(provider.generateCompletionStream('gpt-5.3-codex', USER, {})).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAIProviderError);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', openaiErrorType: 'stream_truncated' });
    expect((error as Error).message).toContain('terminated');
  });

  it('ends with an error chunk after text has gone out', async () => {
    serve([() => streamingResponse(bodyFailingAfter(sseText([created('gpt-5.3-codex'), textDelta('Hel')])))]);
    const provider = await initializedProvider();

    const chunks = await collect(provider.generateCompletionStream('gpt-5.3-codex', USER, {}));

    expect(chunks.map((c) => c.responseTextDelta).filter(Boolean)).toEqual(['Hel']);
    expect(soleFinal(chunks).error).toMatchObject({ type: 'stream_truncated' });
  });
});

describe('OpenAIProvider stream cancellation', () => {
  it('sends no request for a signal that is already aborted', async () => {
    serve([]);
    const provider = await initializedProvider();
    const controller = new AbortController();
    controller.abort();

    const chunks = await collect(
      provider.generateCompletionStream('gpt-6-sol', USER, { tools: pingTool, abortSignal: controller.signal }),
    );

    expect(chunks).toEqual([
      expect.objectContaining({ isFinal: true, error: { message: 'Stream aborted prior to first chunk', type: 'abort' } }),
    ]);
    expect(posts()).toHaveLength(0);
  });

  const chatFirstChunk = `data: ${JSON.stringify({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-4o',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }],
  })}\n\n`;

  it.each<[string, string, string]>([
    ['/v1/responses', 'gpt-5.3-codex', sseText([created('gpt-5.3-codex'), textDelta('Hel')])],
    ['/v1/chat/completions', 'gpt-4o', chatFirstChunk],
  ])('cancels the %s body when the caller aborts during a pending read', async (_endpoint, model, firstBytes) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // One event, then nothing: the next read waits on the network.
        controller.enqueue(new TextEncoder().encode(firstBytes));
      },
      cancel() {
        cancelled = true;
      },
    });
    serve([() => streamingResponse(body)]);
    const provider = await initializedProvider();
    const controller = new AbortController();

    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of provider.generateCompletionStream(model, USER, { abortSignal: controller.signal })) {
      chunks.push(chunk);
      if (chunk.responseTextDelta === 'Hel') setTimeout(() => controller.abort(), 10);
    }

    expect(cancelled).toBe(true);
    expect(soleFinal(chunks).error).toEqual({ message: 'Stream aborted by caller', type: 'abort' });
  }, 5000);
});
