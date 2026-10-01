/**
 * @file agent-session-tool-replay.e2e.test.ts
 * A session replays its history on every send. After a send that ran a tool,
 * the next request must carry the assistant turn's tool calls (with Gemini
 * thought signatures), the tool results paired to them by id, and the
 * assistant's signed thinking; otherwise OpenAI, Anthropic and Gemini reject
 * the request with HTTP 400.
 *
 * Runs agent() -> session.send / session.stream -> generateText / streamText
 * -> the real provider classes, with only the HTTP layer stubbed, and asserts
 * the request bodies the providers put on the wire.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { agent } from '../../agent.js';
import { generateText } from '../../generateText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

type Json = Record<string, any>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(events: Array<unknown>): Response {
  const text = events
    .map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`)
    .join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Serves GET model listings with `models` and every POST from `posts`, in
 * order. An unexpected POST fails the test instead of hanging.
 */
function serve(posts: Array<() => Response>, models: string[] = []): void {
  const queue = [...posts];
  fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return jsonResponse({
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', created: 1, owned_by: 'test' })),
      });
    }
    const next = queue.shift();
    if (!next) throw new Error(`unexpected POST ${String(url)}`);
    return next();
  });
}

/** Consumes a text stream (streamText runs only while it is read). */
async function drain(stream: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const delta of stream) text += delta;
  return text;
}

/** Parsed bodies of every POST, in call order. */
function postedBodies(): Array<{ url: string; body: Json }> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
    .map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String((init as { body?: unknown }).body)) as Json,
    }));
}

const weatherTool = {
  get_weather: {
    description: 'Current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
    execute: async ({ city }: { city: string }) => ({ city, temp_c: 18 }),
  },
};

function geminiText(text: string): Json {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

describe('session replay after a tool round: Gemini', () => {
  const functionCallResponse = (parts: Json[]): Json => ({
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  });

  it('replays functionCall with its thought signature and the named functionResponse, on send and stream', async () => {
    serve([
      () =>
        jsonResponse(
          functionCallResponse([
            { functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-1' },
          ]),
        ),
      () => jsonResponse(geminiText('Sunny in Paris.')),
      () => jsonResponse(geminiText('You are welcome.')),
      () => sseResponse([geminiText('Bye.')]),
    ]);

    const session = agent({
      provider: 'gemini',
      model: 'gemini-3.1-pro-preview',
      apiKey: 'gemini-replay-key',
      instructions: 'You answer weather questions.',
      tools: weatherTool,
      memory: false,
      fallbackProviders: [],
    }).session('gemini-replay');

    const first = await session.send('Weather in Paris?');
    expect(first.text).toBe('Sunny in Paris.');
    await session.send('Thanks!');
    expect(await drain(session.stream('One more thing.').textStream)).toBe('Bye.');

    const bodies = postedBodies();
    expect(bodies).toHaveLength(4);
    expect(bodies[3].url).toContain(':streamGenerateContent');

    for (const { body } of [bodies[2], bodies[3]]) {
      const contents = body.contents as Json[];
      const modelCall = contents.find((c) => c.role === 'model' && c.parts.some((p: Json) => p.functionCall));
      expect(modelCall?.parts).toContainEqual({
        functionCall: { name: 'get_weather', args: { city: 'Paris' } },
        thoughtSignature: 'sig-1',
      });
      const responseTurn = contents[contents.indexOf(modelCall!) + 1];
      expect(responseTurn).toEqual({
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { city: 'Paris', temp_c: 18 } } }],
      });
      expect(contents[contents.indexOf(modelCall!) + 2]).toEqual({
        role: 'model',
        parts: [{ text: 'Sunny in Paris.' }],
      });
    }
  });

  it.each([
    ['a string', 'Sunny, 18C', { result: 'Sunny, 18C' }],
    ['an array', ['Paris', 18], { result: ['Paris', 18] }],
  ])('sends a tool result that is %s as an object, which functionResponse requires', async (_kind, output, expected) => {
    serve([
      () => jsonResponse(functionCallResponse([{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }])),
      () => jsonResponse(geminiText('Sunny in Paris.')),
    ]);

    const result = await generateText({
      provider: 'gemini',
      model: 'gemini-3.1-pro-preview',
      apiKey: 'gemini-tool-shape-key',
      prompt: 'Weather in Paris?',
      tools: { get_weather: { ...weatherTool.get_weather, execute: async () => output } },
      maxSteps: 3,
      fallbackProviders: [],
    });

    expect(result.text).toBe('Sunny in Paris.');
    const contents = postedBodies()[1].body.contents as Json[];
    expect(contents[contents.length - 1]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: expected } }],
    });
  });

  it('answers parallel function calls in one user turn, each response named after its call', async () => {
    serve([
      () =>
        jsonResponse(
          functionCallResponse([
            { functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-p' },
            { functionCall: { name: 'get_weather', args: { city: 'Oslo' } } },
          ]),
        ),
      () => jsonResponse(geminiText('Paris 18, Oslo 18.')),
      () => jsonResponse(geminiText('Noted.')),
    ]);

    const session = agent({
      provider: 'gemini',
      model: 'gemini-3.1-pro-preview',
      apiKey: 'gemini-parallel-key',
      instructions: 'You answer weather questions.',
      tools: weatherTool,
      memory: false,
      fallbackProviders: [],
    }).session('gemini-parallel');

    await session.send('Weather in Paris and Oslo?');
    await session.send('Thanks.');

    const bodies = postedBodies();
    expect(bodies).toHaveLength(3);
    // The in-call continuation (request 2) and the replay (request 3) both
    // answer the two calls in a single user turn.
    for (const { body } of [bodies[1], bodies[2]]) {
      const contents = body.contents as Json[];
      const callIndex = contents.findIndex((c) => c.role === 'model' && c.parts.some((p: Json) => p.functionCall));
      expect(contents[callIndex].parts).toHaveLength(2);
      expect(contents[callIndex + 1]).toEqual({
        role: 'user',
        parts: [
          { functionResponse: { name: 'get_weather', response: { city: 'Paris', temp_c: 18 } } },
          { functionResponse: { name: 'get_weather', response: { city: 'Oslo', temp_c: 18 } } },
        ],
      });
    }
  });
});

describe('session replay after a tool round: OpenAI chat/completions', () => {
  const completion = (message: Json, finishReason: string): Json => ({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4.1',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  it('replays the assistant tool_calls and the tool message tool_call_id, on send and stream', async () => {
    serve(
      [
        () =>
          jsonResponse(
            completion(
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
                  },
                ],
              },
              'tool_calls',
            ),
          ),
        () => jsonResponse(completion({ role: 'assistant', content: 'Sunny in Paris.' }, 'stop')),
        () => jsonResponse(completion({ role: 'assistant', content: 'You are welcome.' }, 'stop')),
        () =>
          sseResponse([
            {
              id: 'c',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-4.1',
              choices: [{ index: 0, delta: { role: 'assistant', content: 'Bye.' }, finish_reason: null }],
            },
            {
              id: 'c',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-4.1',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            },
            '[DONE]',
          ]),
      ],
      ['gpt-4.1'],
    );

    const session = agent({
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: 'sk-openai-replay',
      instructions: 'You answer weather questions.',
      tools: weatherTool,
      memory: false,
      fallbackProviders: [],
    }).session('openai-replay');

    await session.send('Weather in Paris?');
    await session.send('Thanks!');
    expect(await drain(session.stream('One more thing.').textStream)).toBe('Bye.');

    const bodies = postedBodies();
    expect(bodies).toHaveLength(4);
    expect(bodies[3].body.stream).toBe(true);

    for (const { body } of [bodies[2], bodies[3]]) {
      const messages = body.messages as Json[];
      const callIndex = messages.findIndex((m) => m.role === 'assistant' && m.tool_calls);
      expect(callIndex).toBeGreaterThan(0);
      expect(messages[callIndex].tool_calls).toEqual([
        { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      ]);
      expect(messages[callIndex + 1]).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_1',
        content: JSON.stringify({ city: 'Paris', temp_c: 18 }),
      });
      expect(messages[callIndex + 2]).toMatchObject({ role: 'assistant', content: 'Sunny in Paris.' });
    }
  });
});

describe('session replay after a tool round: Anthropic', () => {
  const d = (o: unknown) => o;
  const toolTurn = () =>
    sseResponse([
      d({
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 1 },
        },
      }),
      d({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      d({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Use the weather tool.' } }),
      d({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-anthropic-1' } }),
      d({ type: 'content_block_stop', index: 0 }),
      d({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
      }),
      d({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' } }),
      d({ type: 'content_block_stop', index: 1 }),
      d({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } }),
      d({ type: 'message_stop' }),
    ]);
  const textTurn = (text: string) => () =>
    sseResponse([
      d({
        type: 'message_start',
        message: {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 30, output_tokens: 1 },
        },
      }),
      d({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      d({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
      d({ type: 'content_block_stop', index: 0 }),
      d({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }),
      d({ type: 'message_stop' }),
    ]);

  const thinkingTextTurn = (thinking: string, signature: string, text: string) => () =>
    sseResponse([
      d({
        type: 'message_start',
        message: {
          id: 'msg_3',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 25, output_tokens: 1 },
        },
      }),
      d({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      d({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } }),
      d({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } }),
      d({ type: 'content_block_stop', index: 0 }),
      d({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      d({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }),
      d({ type: 'content_block_stop', index: 1 }),
      d({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } }),
      d({ type: 'message_stop' }),
    ]);

  const blocksOf = (message: Json): Json[] =>
    Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];

  function expectReplayedToolRound(messages: Json[], signature: string, thinking: string): void {
    const callIndex = messages.findIndex(
      (m) => m.role === 'assistant' && blocksOf(m).some((b) => b.type === 'tool_use'),
    );
    expect(callIndex).toBeGreaterThan(0);
    const blocks = blocksOf(messages[callIndex]);
    expect(blocks[0]).toMatchObject({ type: 'thinking', thinking, signature });
    expect(blocks.find((b) => b.type === 'tool_use')).toMatchObject({
      id: 'toolu_1',
      name: 'get_weather',
      input: { city: 'Paris' },
    });
    expect(blocksOf(messages[callIndex + 1]).find((b) => b.type === 'tool_result')).toMatchObject({
      tool_use_id: 'toolu_1',
    });
  }

  it('replays the signed thinking block, tool_use and paired tool_result, on send and stream', async () => {
    serve([toolTurn, textTurn('Sunny in Paris.'), textTurn('You are welcome.'), textTurn('Bye.')]);

    const session = agent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      apiKey: 'sk-ant-replay',
      instructions: 'You answer weather questions.',
      tools: weatherTool,
      memory: false,
      fallbackProviders: [],
    }).session('anthropic-replay');

    await session.send('Weather in Paris?');
    await session.send('Thanks!');
    expect(await drain(session.stream('One more thing.').textStream)).toBe('Bye.');

    const bodies = postedBodies();
    expect(bodies).toHaveLength(4);
    for (const { body } of [bodies[2], bodies[3]]) {
      expectReplayedToolRound(body.messages as Json[], 'sig-anthropic-1', 'Use the weather tool.');
    }
  });

  it('keeps the tool turn\'s signed thinking on the continuation request of a streamed tool round', async () => {
    serve([toolTurn, textTurn('Sunny in Paris.')]);

    const session = agent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      apiKey: 'sk-ant-stream-round',
      instructions: 'You answer weather questions.',
      tools: weatherTool,
      memory: false,
      fallbackProviders: [],
    }).session('anthropic-stream-round');

    expect(await drain(session.stream('Weather in Paris?').textStream)).toBe('Sunny in Paris.');

    const bodies = postedBodies();
    expect(bodies).toHaveLength(2);
    expectReplayedToolRound(bodies[1].body.messages as Json[], 'sig-anthropic-1', 'Use the weather tool.');
  });

  it('records a final answer\'s signed thinking and replays it ahead of the text on the next send', async () => {
    serve([thinkingTextTurn('Plan the reply.', 'sig-final', 'Hello there.'), textTurn('Sure.')]);

    const session = agent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      apiKey: 'sk-ant-final-thinking',
      instructions: 'You are brief.',
      memory: false,
      fallbackProviders: [],
    }).session('anthropic-final-thinking');

    await session.send('Hi');
    const recorded = session.messages().find((m) => m.role === 'assistant') as unknown as Json;
    expect(recorded.thinkingBlocks).toEqual([
      { type: 'thinking', thinking: 'Plan the reply.', signature: 'sig-final' },
    ]);
    await session.send('And again?');

    const messages = postedBodies()[1].body.messages as Json[];
    const reply = messages.find((m) => m.role === 'assistant')!;
    const blocks = blocksOf(reply);
    expect(blocks[0]).toMatchObject({ type: 'thinking', thinking: 'Plan the reply.', signature: 'sig-final' });
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'Hello there.' });
  });

  it('keeps a caller cache breakpoint on the text parts of a thinking-bearing answer', async () => {
    serve([textTurn('Noted.')]);

    const session = agent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      apiKey: 'sk-ant-cache-marker',
      instructions: 'You are brief.',
      memory: false,
      fallbackProviders: [],
    }).session('anthropic-cache-marker');

    session.reseed([
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello there.', cache_control: { type: 'ephemeral' } }],
        thinking: { text: 'Plan the reply.', signature: 'sig-cached' },
      },
    ]);
    await session.send('And again?');

    const messages = postedBodies()[0].body.messages as Json[];
    const blocks = blocksOf(messages.find((m) => m.role === 'assistant')!);
    expect(blocks[0]).toMatchObject({ type: 'thinking', signature: 'sig-cached' });
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'Hello there.', cache_control: { type: 'ephemeral' } });
  });

  it('replays thinking from a reseeded transcript that uses the documented thinking shape', async () => {
    serve([textTurn('Noted.')]);

    const session = agent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      apiKey: 'sk-ant-reseed',
      instructions: 'You answer weather questions.',
      tools: weatherTool,
      memory: false,
      fallbackProviders: [],
    }).session('anthropic-reseed');

    session.reseed([
      { role: 'user', content: 'Weather in Paris?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
        ],
        thinking: { text: 'Checkpointed reasoning.', signature: 'sig-checkpoint' },
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: '{"city":"Paris","temp_c":18}' },
      { role: 'assistant', content: 'Sunny in Paris.' },
    ]);
    await session.send('Thanks!');

    const [request] = postedBodies();
    expectReplayedToolRound(request.body.messages as Json[], 'sig-checkpoint', 'Checkpointed reasoning.');
  });
});
