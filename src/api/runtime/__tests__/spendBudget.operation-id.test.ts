/**
 * @fileoverview The operation id of a generation helper's call on a budget with a spend meter, on the wire: with
 * `AGENTOS_OPERATION_ID_HEADER` set, the id the call's reservation is under is the id its provider sends in that header,
 * on every attempt of the call, so a server in front of the provider and the meter's `resolveExpired` name the call
 * alike. Across `generateText()`, its planning and prompt-tool calls, `streamText()`, its prompt-tool call and a launched
 * seat, unstreamed and streamed, on every provider that sends the header.
 *
 * The real providers, against a local server that answers as each provider's API does (OpenRouter's axios client does
 * not go through fetch); the first case stubs fetch instead. `gmi()`, `agent()` and `generateObject()` pass the id to
 * their provider in spendBudget.helpers.test.ts.
 *
 * `embedText()` sends its own requests: on its OpenAI-compatible path (every batch), to Ollama, and through
 * GeminiProvider's batchEmbedContents, each request carries the id its reservation is under, and none carries a header
 * when the variable is unset or the call has no budget. Gemini's native path is reached only at Google's own host, so
 * its case stubs fetch.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';

import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager.js';
import type { ChatMessage, IProvider } from '../../../core/llm/providers/IProvider.js';
import { startProviderStub, type ProviderStub, type StubAnswer, type StubRequest } from '../../../core/llm/providers/__tests__/helpers/providerStub.js';
import { AnthropicProvider } from '../../../core/llm/providers/implementations/AnthropicProvider.js';
import { GroqProvider } from '../../../core/llm/providers/implementations/GroqProvider.js';
import { LiteLLMProvider } from '../../../core/llm/providers/implementations/LiteLLMProvider.js';
import { MiniMaxProvider } from '../../../core/llm/providers/implementations/MiniMaxProvider.js';
import { MistralProvider } from '../../../core/llm/providers/implementations/MistralProvider.js';
import { OpenAIProvider } from '../../../core/llm/providers/implementations/OpenAIProvider.js';
import { OpenRouterProvider } from '../../../core/llm/providers/implementations/OpenRouterProvider.js';
import { TogetherProvider } from '../../../core/llm/providers/implementations/TogetherProvider.js';
import { XAIProvider } from '../../../core/llm/providers/implementations/XAIProvider.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import { SqlSpendMeter } from '../../../safety/runtime/SqlSpendMeter.js';
import type { ISpendMeter } from '../../../safety/runtime/SpendMeter.js';
import { embedText } from '../../embedText.js';
import { generateText } from '../../generateText.js';
import { streamText } from '../../streamText.js';
import { meteredProviderManager } from '../agencyLaunch/meteredProviderManager.js';
import { registerModelPricing } from '../modelPricing.js';
import { SpendBudget } from '../spendBudget.js';

const HEADER = 'x-op';
const API_KEY = 'sk-operation-id';
const ACCOUNT = 'acct-operation-id';
const PROMPT = 'Say hello.';
const MAX_TOKENS = 100;
const MESSAGES: ChatMessage[] = [{ role: 'user', content: PROMPT }];
/** A row for every model these cases name; the built-in tables answer first where they hold one. */
const PRICE = { inputPerMTokUSD: 1, outputPerMTokUSD: 10 };

const UNAVAILABLE: StubAnswer = { status: 503, json: { error: { message: 'Service Unavailable', type: 'server_error' } } };

/** A tool the prompt-tool cases name; no answer calls it. */
const tool = {
  id: 'noop',
  name: 'noop',
  displayName: 'Noop',
  description: 'Does nothing.',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ success: true, output: {} }),
};

/** A Chat Completions answer, whole or streamed, as OpenAI's API and OpenRouter's give it. */
function chatAnswer(model: string, streamed: boolean): StubAnswer {
  const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
  if (!streamed) {
    return {
      json: { id: 'chat-1', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage },
    };
  }
  const chunk = (delta: Record<string, unknown>, finishReason: string | null, extra: Record<string, unknown> = {}) => ({
    id: 'chat-1',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  });
  return { sse: [chunk({ role: 'assistant', content: 'hi' }, null), chunk({}, 'stop', { usage }), '[DONE]'] };
}

/** A Messages API answer, which AnthropicProvider takes as a stream on both of its paths. */
function messagesAnswer(model: string): StubAnswer {
  return {
    sse: [
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ],
  };
}

/** A provider that sends the header, as these cases reach it. */
interface Wire {
  provider: 'openai' | 'anthropic' | 'openrouter';
  model: string;
  /** The API's path under the server's origin. */
  base: string;
  /** The stub's key for its completion route. */
  route: string;
  answer(request: StubRequest): StubAnswer;
  /** A real provider against the stub, as a seat's provider manager holds it. */
  start(baseURL: string): Promise<IProvider>;
}

const WIRES: Wire[] = [
  {
    provider: 'openai',
    model: 'gpt-4o',
    base: '/v1',
    route: 'POST /v1/chat/completions',
    answer: (request) => chatAnswer('gpt-4o', request.json.stream === true),
    async start(baseURL) {
      const created = new OpenAIProvider();
      await created.initialize({ apiKey: API_KEY, baseURL });
      return created;
    },
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    base: '',
    route: 'POST /v1/messages',
    answer: () => messagesAnswer('claude-opus-5-5'),
    async start(baseURL) {
      const created = new AnthropicProvider();
      await created.initialize({ apiKey: API_KEY, baseURL });
      return created;
    },
  },
  {
    provider: 'openrouter',
    model: 'openai/gpt-4o',
    base: '/api/v1',
    route: 'POST /api/v1/chat/completions',
    answer: (request) => chatAnswer('openai/gpt-4o', request.json.stream === true),
    async start(baseURL) {
      const created = new OpenRouterProvider();
      await created.initialize({ apiKey: API_KEY, baseURL });
      return created;
    },
  },
];

/** Reads a stream of parts to its end, throwing the error its error part carries. */
async function readParts(parts: AsyncIterable<{ type: string; error?: unknown }>): Promise<void> {
  for await (const part of parts) {
    if (part.type === 'error') throw part.error;
  }
}

/** The options of a helper's call to `wire` on the stub. */
const helperOptions = (wire: Wire, budget: SpendBudget) =>
  ({ provider: wire.provider, model: wire.model, apiKey: API_KEY, baseUrl: `${stub.origin}${wire.base}`, prompt: PROMPT, maxTokens: MAX_TOKENS, budget, fallbackProviders: [] });

/** A launched seat's provider on `budget`, over the real provider. */
async function seat(wire: Wire, budget: SpendBudget): Promise<IProvider> {
  const provider = await wire.start(`${stub.origin}${wire.base}`);
  const base = { getProvider: () => provider, getDefaultProvider: () => provider, getProviderForModel: () => provider } as unknown as AIModelProviderManager;
  return meteredProviderManager(base, budget).getProvider(wire.provider) as IProvider;
}

/** One way a call reaches its provider. */
interface Way {
  name: string;
  /** How many reservations the call makes. */
  reservations: number;
  run(wire: Wire, budget: SpendBudget): Promise<unknown>;
}

const WAYS: Way[] = [
  { name: 'generateText', reservations: 1, run: (wire, budget) => generateText(helperOptions(wire, budget)) },
  { name: 'streamText', reservations: 1, run: (wire, budget) => readParts(streamText(helperOptions(wire, budget)).fullStream) },
  { name: "generateText's planning call and its step", reservations: 2, run: (wire, budget) => generateText({ ...helperOptions(wire, budget), planning: true }) },
  {
    name: "generateText's prompt-tool call",
    reservations: 1,
    run: (wire, budget) => generateText({ ...helperOptions(wire, budget), tools: [tool] as never, toolMode: 'prompt' }),
  },
  {
    name: "streamText's prompt-tool call",
    reservations: 1,
    run: (wire, budget) => readParts(streamText({ ...helperOptions(wire, budget), tools: [tool] as never, toolMode: 'prompt' }).fullStream),
  },
  {
    name: "a seat's call",
    reservations: 1,
    run: async (wire, budget) => (await seat(wire, budget)).generateCompletion(wire.model, MESSAGES, { maxTokens: MAX_TOKENS }),
  },
  {
    name: "a seat's stream",
    reservations: 1,
    run: async (wire, budget) => {
      for await (const _chunk of (await seat(wire, budget)).generateCompletionStream(wire.model, MESSAGES, { maxTokens: MAX_TOKENS })) {
        // read and dropped
      }
    },
  },
];

let stub: ProviderStub;
let meter: SqlSpendMeter;
let closeMeter: () => Promise<unknown>;

const metered = (): SpendBudget => new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, meter, accountId: ACCOUNT });

beforeAll(async () => {
  stub = await startProviderStub({
    'GET /v1/models': { json: { object: 'list', data: [{ id: 'gpt-4o', object: 'model', created: 1, owned_by: 'openai' }] } },
    'GET /api/v1/models': {
      json: { data: [{ id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' } }] },
    },
    'POST /v1/chat/completions': (request) => chatAnswer(String(request.json.model), request.json.stream === true),
    ...Object.fromEntries(WIRES.filter((wire) => wire.provider !== 'openai').map((wire) => [wire.route, (request: StubRequest) => wire.answer(request)])),
  });
  for (const wire of WIRES) registerModelPricing(wire.provider, (modelId) => (modelId === wire.model ? PRICE : undefined));
});

afterAll(async () => {
  for (const wire of WIRES) registerModelPricing(wire.provider, () => undefined);
  await stub.close();
});

beforeEach(async () => {
  stub.reset();
  globalLLMProviderHealth.reset();
  vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', HEADER);
  const db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
  meter = new SqlSpendMeter({
    db,
    allowanceFor: () => 1_000_000,
    periodOf: () => '2026-11',
    requireShared: false,
    resolveExpired: () => ({ outcome: 'deferred', retryAt: Date.now() + 1_000 }),
  });
  closeMeter = () => db.close();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await closeMeter();
});

describe("a metered call's operation id", () => {
  it('sends in the header the id meter.reserve was given, for generateText over a stubbed fetch', async () => {
    const sent: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith('/models')) return new Response(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o', object: 'model', created: 1, owned_by: 'openai' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
        sent.push(new Headers(init?.headers).get(HEADER));
        return new Response(JSON.stringify(chatAnswer('gpt-4o', false).json), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const reserve = vi.spyOn(meter, 'reserve');
    await generateText({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-operation-id-fetch', prompt: PROMPT, maxTokens: MAX_TOKENS, budget: metered(), fallbackProviders: [] });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([reserve.mock.calls[0]![0].operationId]);
  });

  describe.each(WIRES)('on $provider', (wire) => {
    it.each(WAYS)('is the id its reservation is under: $name', async (way) => {
      const reserve = vi.spyOn(meter, 'reserve');
      await way.run(wire, metered());
      const reserved = reserve.mock.calls.map(([request]) => request.operationId);
      expect(reserved).toHaveLength(way.reservations);
      expect(stub.sent(wire.route).map((request) => request.headers[HEADER])).toEqual(reserved);
    });

    it("is sent again on the provider's retry of the call, and takes one reservation", async () => {
      stub.queue(wire.route, UNAVAILABLE);
      const reserve = vi.spyOn(meter, 'reserve');
      await generateText(helperOptions(wire, metered()));
      expect(reserve).toHaveBeenCalledTimes(1);
      const { operationId } = reserve.mock.calls[0]![0];
      expect(stub.sent(wire.route).map((request) => request.headers[HEADER])).toEqual([operationId, operationId]);
    });
  });

  it.each([
    ['groq', () => new GroqProvider()],
    ['litellm', () => new LiteLLMProvider()],
    ['minimax', () => new MiniMaxProvider()],
    ['mistral', () => new MistralProvider()],
    ['together', () => new TogetherProvider()],
    ['xai', () => new XAIProvider()],
  ] as const)('goes through %s, which sends through the OpenAI provider', async (_name, make) => {
    const provider: IProvider = make();
    await provider.initialize({ apiKey: API_KEY, baseURL: `${stub.origin}/v1` });
    await provider.generateCompletion('gpt-4o', MESSAGES, { operationId: 'op-whole' });
    for await (const _chunk of provider.generateCompletionStream('gpt-4o', MESSAGES, { operationId: 'op-stream' })) {
      // read and dropped
    }
    expect(stub.sent('POST /v1/chat/completions').map((request) => request.headers[HEADER])).toEqual(['op-whole', 'op-stream']);
  });
});

/** An embeddings answer as OpenAI's API gives it, one vector for each input. */
function embeddingsAnswer(request: StubRequest): StubAnswer {
  const input: unknown[] = Array.isArray(request.json.input) ? request.json.input : [request.json.input];
  return {
    json: {
      object: 'list',
      data: input.map((_text, index) => ({ object: 'embedding', index, embedding: [0.1, 0.2] })),
      model: String(request.json.model),
      usage: { prompt_tokens: input.length, total_tokens: input.length },
    },
  };
}

/** One path embedText sends its own requests on. */
interface EmbedPath {
  name: string;
  /** One embedText call on `budget`, or on none. */
  run(budget: SpendBudget | undefined): Promise<unknown>;
  /** The operation id header's value on each request the call sent, in order; undefined where it carried none. */
  sent(): Array<string | undefined>;
}

/** Each path's requests as fetch saw them, for the path whose host the stub server cannot stand in for. */
let fetched: Array<string | undefined> = [];

const EMBED_PATHS: EmbedPath[] = [
  {
    name: 'the OpenAI-compatible path, one request a batch',
    run: (budget) =>
      embedText({ provider: 'openai', model: 'text-embedding-3-small', apiKey: API_KEY, baseUrl: `${stub.origin}/v1`, input: ['first', 'second'], maxInputsPerRequest: 1, ...(budget ? { budget } : {}) }),
    sent: () => stub.sent('POST /v1/embeddings').map((request) => request.headers[HEADER] as string | undefined),
  },
  {
    name: 'Ollama',
    run: (budget) => embedText({ provider: 'ollama', model: 'nomic-embed-text', baseUrl: stub.origin, input: 'first', ...(budget ? { budget } : {}) }),
    sent: () => stub.sent('POST /api/embed').map((request) => request.headers[HEADER] as string | undefined),
  },
  {
    name: "Gemini's batchEmbedContents",
    run: (budget) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          if (!String(url).includes(':batchEmbedContents')) throw new Error(`a request the case did not script: ${String(url)}`);
          fetched.push(new Headers(init?.headers).get(HEADER) ?? undefined);
          const { requests } = JSON.parse(String(init?.body)) as { requests: unknown[] };
          return new Response(JSON.stringify({ embeddings: requests.map(() => ({ values: [0.1, 0.2] })), usageMetadata: { promptTokenCount: requests.length } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }),
      );
      return embedText({ provider: 'gemini', model: 'gemini-embedding-2', apiKey: API_KEY, input: 'first', ...(budget ? { budget } : {}) });
    },
    sent: () => fetched,
  },
];

describe("embedText's own requests", () => {
  beforeAll(() => {
    registerModelPricing('ollama', (modelId) => (modelId === 'nomic-embed-text' ? PRICE : undefined));
    registerModelPricing('gemini', (modelId) => (modelId === 'gemini-embedding-2' ? PRICE : undefined));
  });
  afterAll(() => {
    registerModelPricing('ollama', () => undefined);
    registerModelPricing('gemini', () => undefined);
  });
  beforeEach(() => {
    fetched = [];
    stub.queue('POST /v1/embeddings', embeddingsAnswer, embeddingsAnswer);
    stub.queue('POST /api/embed', { json: { model: 'nomic-embed-text', embeddings: [[0.1, 0.2]] } });
  });

  it.each(EMBED_PATHS)('send the id their reservation is under: $name', async (path) => {
    const reserve = vi.spyOn(meter, 'reserve');
    await path.run(metered());
    expect(reserve).toHaveBeenCalledTimes(1);
    const { operationId } = reserve.mock.calls[0]![0];
    expect(operationId).toBeTruthy();
    const sent = path.sent();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).toEqual(sent.map(() => operationId));
  });

  it.each(EMBED_PATHS)('send no header when the call has no budget: $name', async (path) => {
    await path.run(undefined);
    const sent = path.sent();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((value) => value === undefined)).toBe(true);
  });

  // The name is read once, before the reservation: a variable changed while the meter reserves moves no header.
  it.each(EMBED_PATHS)('keep the header named before the reservation when the variable changes during it: $name', async (path) => {
    const reserved: string[] = [];
    const inner = meter;
    const shifting: ISpendMeter = {
      reserve: async (request) => {
        reserved.push(request.operationId);
        vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', 'x-other');
        return inner.reserve(request);
      },
      settle: (request) => inner.settle(request),
      heartbeat: (operationId, now) => inner.heartbeat(operationId, now),
      reconcile: (options) => inner.reconcile(options),
      snapshot: (accountId, now) => inner.snapshot(accountId, now),
      setAllowance: (accountId, allowance, now) => inner.setAllowance(accountId, allowance, now),
    };
    await path.run(new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, meter: shifting, accountId: ACCOUNT }));
    expect(reserved).toHaveLength(1);
    const sent = path.sent();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).toEqual(sent.map(() => reserved[0]));
  });

  // Gemini sends its key in x-goog-api-key: an id there would take the key's place.
  it.each(['x goog', 'x-goog-api-key', 'Authorization'])('refuse the header name %s before anything is reserved or sent', async (name) => {
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', name);
    const reserve = vi.spyOn(meter, 'reserve');
    const gemini = EMBED_PATHS[2]!;
    await expect(gemini.run(metered())).rejects.toThrow(RangeError);
    expect(reserve).not.toHaveBeenCalled();
    expect(gemini.sent()).toEqual([]);
  });

  it.each(EMBED_PATHS)('send no header when the variable is unset: $name', async (path) => {
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', '');
    const reserve = vi.spyOn(meter, 'reserve');
    await path.run(metered());
    expect(reserve).toHaveBeenCalledTimes(1);
    const sent = path.sent();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((value) => value === undefined)).toBe(true);
  });
});
