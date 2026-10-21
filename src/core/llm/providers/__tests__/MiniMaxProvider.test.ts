import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ provider: undefined as any }));
// Keep model resolution, SDK tool loops, and HTTP real; isolate unrelated providers.
vi.mock('../AIModelProviderManager', () => ({
  AIModelProviderManager: class {
    async initialize() {}
    getProvider() { return sdk.provider; }
  },
}));
import { generateText } from '../../../../api/generateText';
import { streamText } from '../../../../api/streamText';
import { MiniMaxProvider } from '../implementations/MiniMaxProvider';
import { OpenAIProvider } from '../implementations/OpenAIProvider';
import { PROVIDER_DEFAULTS } from '../../../../api/runtime/provider-defaults';
import { toProviderReplayMessage } from '../../../../api/sessionTranscript';
import { ProviderAssignmentEngine } from '../../../../orchestration/planning/ProviderAssignmentEngine';
import type { ChatMessage } from '../IProvider';

const FLASH = 'MiniMax-M3.1-Flash';
const call = { id: 'call_1', type: 'function' as const, function: { name: 'weather', arguments: '{"city":"Paris"}' } };
const tools = [{ type: 'function' as const, function: { name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];

describe('MiniMax Chat Completions transport', () => {
  let server: Server;
  let baseURL: string;
  let requests: { path: string; authorization: string | undefined; body: any }[];
  // A case that answers every request itself, such as with an error status.
  let reply: ((res: ServerResponse) => void) | undefined;

  beforeEach(async () => {
    requests = [];
    reply = undefined;
    server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: req.url!, authorization: req.headers.authorization, body });
      if (reply) {
        reply(res);
        return;
      }
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o', owned_by: 'openai' }] }));
        return;
      }
      const continuation = body.messages.some((message: ChatMessage) => message.role === 'tool');
      if (body.stream) {
        res.setHeader('content-type', 'text/event-stream');
        const deltas = continuation
          ? [{ content: 'Sunny.' }]
          : [{ reasoning_content: 'Look up ' }, { reasoning_content: 'the weather.' }, { tool_calls: [{ index: 0, ...call }] }];
        for (const delta of deltas) {
          res.write(`data: ${JSON.stringify({ id: 'stream_1', model: body.model, created: 1, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id: 'stream_1', model: body.model, created: 1, choices: [{ index: 0, delta: {}, finish_reason: continuation ? 'stop' : 'tool_calls' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'completion_1', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: continuation
          ? { role: 'assistant', content: 'Sunny.' }
          : { role: 'assistant', content: null, reasoning_content: 'Look up the weather.', tool_calls: [call] },
        finish_reason: continuation ? 'stop' : 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    baseURL = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  async function provider(defaultModelId?: string) {
    const instance = new MiniMaxProvider();
    await instance.initialize({ apiKey: 'test-key', baseURL, defaultModelId });
    return instance;
  }

  it('defaults to Flash and lists current models without requesting a /models endpoint', async () => {
    const instance = await provider();
    expect(instance.defaultModelId).toBe(FLASH);
    expect((await instance.listAvailableModels()).map(model => model.modelId)).toEqual([FLASH, 'MiniMax-M3']);
    expect((await instance.listAvailableModels({ capability: 'vision_input' })).length).toBe(2);
    expect(await instance.listAvailableModels({ capability: 'embeddings' })).toEqual([]);
    expect(await instance.getModelInfo(FLASH)).toMatchObject({ contextWindowSize: 1_000_000, isDefaultModel: true });
    expect(requests).toEqual([]);
    expect(PROVIDER_DEFAULTS.minimax).toMatchObject({ text: FLASH, cheap: FLASH, image: 'image-01' });
    expect(PROVIDER_DEFAULTS.openai.text).toBe('gpt-4o');
    const assignments = new ProviderAssignmentEngine(['minimax']).assign([{ id: 'work', type: 'agent' } as any], { strategy: 'best' });
    expect(assignments[0]).toMatchObject({ provider: 'minimax', model: FLASH });
  });

  it('guards catalog access before initialization', async () => {
    await expect(new MiniMaxProvider().listAvailableModels()).rejects.toThrow(/not initialized/i);
  });

  it('sends default requests, effort, tools, images, and reasoning history over real HTTP', async () => {
    const instance = await provider();
    const images = [
      { type: 'image_url' as const, image_url: { url: 'https://example.com/test.jpg' } },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ];
    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Weather?' }, ...images] }];
    const first = await instance.generateCompletion(instance.defaultModelId!, messages, { tools, effort: 'high', thinking: { budgetTokens: 1024 } });
    expect(requests[0]).toMatchObject({ path: '/v1/chat/completions', authorization: 'Bearer test-key', body: { model: FLASH, tools, reasoning_effort: 'high', thinking: { type: 'adaptive' } } });
    expect(requests[0].body.messages[0].content).toEqual(messages[0].content);
    expect(first.choices[0].message.reasoningText).toBe('Look up the weather.');
    const followup = await instance.generateCompletion(FLASH, [
      ...messages, toProviderReplayMessage(first.choices[0].message) as unknown as ChatMessage,
      { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
    ], {});
    expect(requests[1].body.messages[1]).toMatchObject({ reasoning_content: 'Look up the weather.', tool_calls: [call] });
    expect(requests[1].body.messages[2]).toMatchObject({ tool_call_id: 'call_1', content: 'Sunny' });
    expect(followup.choices[0].message.content).toBe('Sunny.');
    expect(requests[1].body).not.toHaveProperty('reasoning_effort');
  });

  it('preserves streaming reasoning deltas and replays a streamed tool turn', async () => {
    const instance = await provider();
    let reasoningText = '';
    const toolDeltas: unknown[] = [];
    for await (const chunk of instance.generateCompletionStream(FLASH, [{ role: 'user', content: 'Weather?' }], { tools, effort: 'max' })) {
      reasoningText += chunk.reasoningTextDelta ?? '';
      if (chunk.toolCallsDeltas) toolDeltas.push(...chunk.toolCallsDeltas);
    }
    expect(reasoningText).toBe('Look up the weather.');
    expect(toolDeltas).toEqual([{ index: 0, id: call.id, type: call.type, function: { name: 'weather', arguments_delta: call.function.arguments } }]);
    let text = '';
    for await (const chunk of instance.generateCompletionStream(FLASH, [
      { role: 'assistant', content: null, reasoningText, tool_calls: [call] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
    ], {})) text += chunk.responseTextDelta ?? '';
    expect(text).toBe('Sunny.');
    expect(requests[1].body.messages[0].reasoning_content).toBe(reasoningText);
  });

  it.each(['MiniMax-M3', 'MiniMax-M2.7', 'custom-saved-model'])('preserves explicit %s selections', async modelId => {
    const instance = await provider(modelId);
    expect(instance.defaultModelId).toBe(modelId);
    await instance.generateCompletion(modelId, [{ role: 'user', content: 'Hello' }], {});
    expect(requests[0].body.model).toBe(modelId);
  });

  it.each([undefined, 'https://api.minimaxi.com/v1'])('serializes the regional endpoint %s without live inference', async endpoint => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'regional', object: 'chat.completion', created: 1, model: FLASH,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    }), { headers: { 'content-type': 'application/json' } }));
    try {
      const instance = new MiniMaxProvider();
      await instance.initialize({ apiKey: 'test-key', baseURL: endpoint });
      await instance.generateCompletion(instance.defaultModelId!, [{ role: 'user', content: 'Hi' }], {});
      expect(fetchMock.mock.calls[0][0]).toBe(`${endpoint ?? 'https://api.minimax.io/v1'}/chat/completions`);
      expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).model).toBe(FLASH);
    } finally { fetchMock.mockRestore(); }
  });

  it('keeps M3 disabled thinking and ignores generic effort', async () => {
    const instance = await provider('MiniMax-M3');
    await instance.generateCompletion('MiniMax-M3', [{ role: 'user', content: 'Hi' }], { thinking: false, effort: 'none' });
    expect(requests[0].body.thinking).toEqual({ type: 'disabled' });
    expect(requests[0].body).not.toHaveProperty('reasoning_effort');
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('forwards Flash effort %s', async effort => {
    const instance = await provider();
    await instance.generateCompletion(FLASH, [{ role: 'user', content: 'Hello' }], { effort });
    expect(requests[0].body.reasoning_effort).toBe(effort);
  });

  it.each([
    { thinking: false },
    { effort: 'none' },
    { customModelParams: { reasoning_effort: 'minimal' } },
    { customModelParams: { reasoning_split: false } },
    { customModelParams: { service_tier: 'fast' } },
  ])('rejects unsupported Flash controls before HTTP: %j', async options => {
    const instance = await provider();
    await expect(instance.generateCompletion(FLASH, [], options as any)).rejects.toThrow(/MiniMax-M3.1-Flash/);
    expect(requests).toEqual([]);
  });

  it.each([false, true])('preserves reasoning in the high-level SDK tool loop (stream=%s)', async streaming => {
    sdk.provider = await provider();
    const options = {
      provider: 'minimax', apiKey: 'test-key', prompt: 'Weather?', maxSteps: 2,
      tools: { weather: { description: 'Get weather', parameters: tools[0].function.parameters, execute: async () => ({ weather: 'Sunny' }) } },
    };
    if (streaming) {
      const result = streamText(options);
      let text = '';
      for await (const chunk of result.textStream) text += chunk;
      expect(text).toBe('Sunny.');
    } else {
      expect((await generateText(options)).text).toBe('Sunny.');
    }
    expect(requests).toHaveLength(2);
    expect(requests[1].body.model).toBe(FLASH);
    expect(requests[1].body.messages.find((message: ChatMessage) => message.role === 'assistant'))
      .toMatchObject({ reasoning_content: 'Look up the weather.', tool_calls: [call] });
    expect(requests[1].body.messages.find((message: ChatMessage) => message.role === 'tool')).toMatchObject({ tool_call_id: 'call_1' });
  });

  function answerWith(status: number, body: string, headers: Record<string, string> = {}) {
    reply = res => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      res.end(body);
    };
  }

  it('fails an authentication error at once, without a retry', async () => {
    answerWith(401, JSON.stringify({ error: { message: 'invalid api key', type: 'authentication_error', code: 'invalid_api_key' } }));
    const instance = await provider();
    await expect(instance.generateCompletion(FLASH, [{ role: 'user', content: 'Hi' }], {}))
      .rejects.toMatchObject({ code: 'API_CLIENT_ERROR', httpStatus: 401 });
    expect(requests).toHaveLength(1);
  });

  it('retries a rate limit after its Retry-After and fails with it once the attempts run out', async () => {
    answerWith(429, JSON.stringify({ error: { message: 'rate limit reached', type: 'rate_limit_error' } }), { 'retry-after': '0' });
    const instance = new MiniMaxProvider();
    await instance.initialize({ apiKey: 'test-key', baseURL, maxRetries: 2 });
    await expect(instance.generateCompletion(FLASH, [{ role: 'user', content: 'Hi' }], {}))
      .rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', httpStatus: 429 });
    expect(requests).toHaveLength(2);
  });

  it('fails a response that is not JSON instead of returning an empty completion', async () => {
    answerWith(200, 'not json');
    const instance = new MiniMaxProvider();
    await instance.initialize({ apiKey: 'test-key', baseURL, maxRetries: 1 });
    await expect(instance.generateCompletion(FLASH, [{ role: 'user', content: 'Hi' }], {})).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it("draws its keys in the order AGENTOS_KEY_POOL_STRATEGY_MINIMAX names, never by OpenAI's variable", async () => {
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY', '');
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY_OPENAI', 'round-robin');
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY_MINIMAX', 'ordered');
    const instance = new MiniMaxProvider();
    await instance.initialize({ apiKey: 'test-key-a,test-key-b', baseURL });
    for (let i = 0; i < 3; i++) await instance.generateCompletion(FLASH, [{ role: 'user', content: 'Hi' }], {});
    // Ordered keeps the first usable key. Round-robin, which OpenAI's variable names, gives the first key two
    // rotation slots and the second one, so its third request would carry the second key.
    expect(requests.map(request => request.authorization)).toEqual(['Bearer test-key-a', 'Bearer test-key-a', 'Bearer test-key-a']);
  });

  it('refuses an embedding request before it is sent, since MiniMax publishes no embedding model', async () => {
    // A server that would answer: the refusal comes from the provider, not from MiniMax.
    answerWith(200, JSON.stringify({
      object: 'list', model: 'text-embedding-3-small',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }));
    const instance = await provider();
    await expect(instance.generateEmbeddings('text-embedding-3-small', ['hello'])).rejects.toThrow(/MiniMax publishes no embedding model/);
    expect(requests).toEqual([]);
  });

  it('leaves inherited OpenAI behavior unchanged', async () => {
    const instance = new OpenAIProvider();
    await instance.initialize({ apiKey: 'test-key', baseURL, defaultModelId: 'gpt-4o' });
    const response = await instance.generateCompletion('gpt-4o', [{ role: 'user', content: 'Hi' }], {});
    expect(requests[0].path).toBe('/v1/models');
    expect(requests[1].body.model).toBe('gpt-4o');
    expect(response.choices[0].message).not.toHaveProperty('reasoningText');
  });
});
