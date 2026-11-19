/**
 * @fileoverview The router's classifier and generator calls carry only a key
 * of the vendor they go to.
 *
 * An OpenAI classifier or generator takes OPENAI_API_KEY, else
 * OPENROUTER_API_KEY with OpenRouter's URL, else no key. Another vendor's key
 * (Anthropic's) never reaches OpenAI's endpoint.
 *
 * These cases run the real router, the real `generateText` and the real
 * OpenAI and Anthropic providers. A stubbed `fetch` records every request and
 * answers it in the vendor's shape.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const PROVIDER_VARIABLES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'TOGETHER_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'REQUESTY_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_BASE_URL',
  'OLLAMA_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENROUTER_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'SERPER_API_KEY',
];

/** A request `fetch` was asked to send: its URL, its Authorization header, its model, and every header value and string body. */
interface SentRequest {
  url: string;
  authorization?: string;
  model?: string;
  carried: string;
}

const sent: SentRequest[] = [];
let corpusDir = '';

/** The classifier's answer: tier 0, so the generator answers with no retrieval. */
const CLASSIFIER_JSON = JSON.stringify({
  thinking: 'Pricing is in the corpus.',
  tier: 0,
  strategy: 'none',
  confidence: 0.95,
  internal_knowledge_sufficient: true,
  suggested_sources: [],
  tools_needed: [],
});

beforeAll(async () => {
  corpusDir = await fs.mkdtemp(path.join(os.tmpdir(), 'query-router-llm-keys-'));
  await fs.writeFile(path.join(corpusDir, 'pricing.md'), '# Pricing\n\nStarts at $19/month for the Starter plan.\n');
});

afterAll(async () => {
  await fs.rm(corpusDir, { recursive: true, force: true });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Answers an OpenAI-shaped API (OpenAI's, or OpenRouter's compatibility URL): models, embeddings and chat completions. */
function openAiAnswer(url: string, body: Record<string, any>): Response {
  if (url.endsWith('/embeddings')) {
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
    return json({
      object: 'list',
      model: body.model,
      data: inputs.map((_: unknown, index: number) => ({ object: 'embedding', index, embedding: new Array(1536).fill(0.1) })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  }
  if (url.endsWith('/chat/completions')) {
    return json({
      id: 'chatcmpl-router',
      object: 'chat.completion',
      created: 1,
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: CLASSIFIER_JSON }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
  }
  return json({
    object: 'list',
    data: ['gpt-4o-mini', 'gpt-4.1-mini', 'text-embedding-3-small'].map((id) => ({ id, object: 'model', created: 0, owned_by: 'test' })),
  });
}

/** Answers Anthropic's Messages API with a streamed text turn holding the classifier's answer. */
function anthropicAnswer(body: Record<string, any>): Response {
  const model = String(body.model);
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_${model}`, type: 'message', role: 'assistant', content: [], model,
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: CLASSIFIER_JSON } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

beforeEach(() => {
  for (const name of PROVIDER_VARIABLES) vi.stubEnv(name, '');
  sent.length = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const values: string[] = [];
    headers.forEach((value) => values.push(value));
    const raw = typeof init?.body === 'string' ? init.body : '';
    let body: Record<string, any> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, any>) : {};
    } catch {
      body = {};
    }
    sent.push({
      url,
      authorization: headers.get('authorization') ?? undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      carried: [url, ...values, raw].join('\n'),
    });
    if (new URL(url).hostname === 'api.anthropic.com') {
      return init?.method === 'POST' ? anthropicAnswer(body) : json({ data: [], has_more: false });
    }
    return openAiAnswer(url, body);
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * The router module loaded afresh with no provider key set, so its defaults
 * do not depend on the environment the suite runs in. A case sets its keys
 * after this.
 */
async function loadRouter() {
  vi.resetModules();
  const { QueryRouter } = await import('../QueryRouter.js');
  return QueryRouter;
}

/** Builds the router on the corpus and routes one question through the classifier and the generator. */
async function routeOnce(QueryRouter: Awaited<ReturnType<typeof loadRouter>>, overrides: Record<string, unknown>): Promise<void> {
  const router = new QueryRouter({
    knowledgeCorpus: [corpusDir],
    includePlatformKnowledge: false,
    graphEnabled: false,
    deepResearchEnabled: false,
    cacheResults: false,
    ...overrides,
  } as ConstructorParameters<typeof QueryRouter>[0]);
  try {
    await router.init();
    // A call with no key fails; what was sent is what these cases read.
    await router.route('How much does the Starter plan cost?').catch(() => undefined);
  } finally {
    await router.close();
  }
}

const hostOf = (r: SentRequest) => new URL(r.url).hostname;

/** Both calls were sent: the classifier's (gpt-4o-mini) and the generator's (gpt-4.1-mini), a gateway prefix allowed. */
function expectClassifierAndGenerator(calls: SentRequest[]): void {
  const models = calls.map((r) => r.model ?? '');
  expect(models.some((m) => m.endsWith('gpt-4o-mini'))).toBe(true);
  expect(models.some((m) => m.endsWith('gpt-4.1-mini'))).toBe(true);
}
const OPENAI_CLASSIFIER = { classifierProvider: 'openai', classifierModel: 'gpt-4o-mini' };
const OPENAI_GENERATOR = { generationProvider: 'openai', generationModel: 'gpt-4.1-mini', generationModelDeep: 'gpt-4.1-mini' };
const ANTHROPIC_CLASSIFIER = { classifierProvider: 'anthropic', classifierModel: 'claude-haiku-4-5-20251001' };
const ANTHROPIC_GENERATOR = {
  generationProvider: 'anthropic',
  generationModel: 'claude-haiku-4-5-20251001',
  generationModelDeep: 'claude-haiku-4-5-20251001',
};

describe("QueryRouter: a classifier or generator call carries only its own vendor's key", () => {
  it("with only Anthropic's key set, an OpenAI classifier sends that key to no host but Anthropic's", async () => {
    const QueryRouter = await loadRouter();
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');

    await routeOnce(QueryRouter, { ...OPENAI_CLASSIFIER, ...ANTHROPIC_GENERATOR });

    expect(sent.filter((r) => hostOf(r) === 'api.openai.com')).toEqual([]);
    expect(sent.filter((r) => r.carried.includes('test-anthropic-key') && hostOf(r) !== 'api.anthropic.com')).toEqual([]);
  });

  it("with only Anthropic's key set, an OpenAI generator sends that key to no host but Anthropic's", async () => {
    const QueryRouter = await loadRouter();
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');

    await routeOnce(QueryRouter, { ...ANTHROPIC_CLASSIFIER, ...OPENAI_GENERATOR });

    // The Anthropic classifier ran, so the route reached the generator.
    expect(sent.some((r) => hostOf(r) === 'api.anthropic.com' && r.model === 'claude-haiku-4-5-20251001')).toBe(true);
    expect(sent.filter((r) => hostOf(r) === 'api.openai.com')).toEqual([]);
    expect(sent.filter((r) => r.carried.includes('test-anthropic-key') && hostOf(r) !== 'api.anthropic.com')).toEqual([]);
  });

  it("with Anthropic's and OpenRouter's keys set, an OpenAI classifier and generator go to OpenRouter's URL with OpenRouter's key", async () => {
    const QueryRouter = await loadRouter();
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');

    await routeOnce(QueryRouter, { ...OPENAI_CLASSIFIER, ...OPENAI_GENERATOR });

    expectClassifierAndGenerator(sent.filter((r) => r.url.endsWith('/chat/completions')));
    expect(sent.filter((r) => hostOf(r) === 'api.openai.com')).toEqual([]);
    for (const r of sent.filter((s) => s.url.endsWith('/chat/completions'))) {
      expect(r.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(r.authorization).toBe('Bearer test-openrouter-key');
    }
    expect(sent.filter((r) => r.carried.includes('test-anthropic-key'))).toEqual([]);
  });

  it("with a router apiKey of '' and only OpenRouter's key set, an OpenAI classifier and generator go to OpenRouter's URL, never OpenAI's", async () => {
    const QueryRouter = await loadRouter();
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');

    // Embeddings go to MiniMax, whose key is unset, so this case reads the classifier and the generator alone.
    await routeOnce(QueryRouter, { ...OPENAI_CLASSIFIER, ...OPENAI_GENERATOR, apiKey: '', embeddingProvider: 'minimax' });

    const calls = sent.filter((r) => r.url.endsWith('/chat/completions'));
    expectClassifierAndGenerator(calls);
    for (const r of calls) {
      expect(r.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(r.authorization).toBe('Bearer test-openrouter-key');
    }
    expect(sent.filter((r) => hostOf(r) === 'api.openai.com' && r.carried.includes('test-openrouter-key'))).toEqual([]);
  });

  it("with OpenAI's key set beside others, an OpenAI classifier and generator go to OpenAI with OpenAI's key alone", async () => {
    const QueryRouter = await loadRouter();
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');

    await routeOnce(QueryRouter, { ...OPENAI_CLASSIFIER, ...OPENAI_GENERATOR });

    const calls = sent.filter((r) => r.url.endsWith('/chat/completions'));
    expectClassifierAndGenerator(calls);
    for (const r of calls) {
      expect(r.url).toBe('https://api.openai.com/v1/chat/completions');
      expect(r.authorization).toBe('Bearer test-openai-key');
    }
    expect(sent.filter((r) => r.carried.includes('test-anthropic-key') || r.carried.includes('test-openrouter-key'))).toEqual([]);
  });
});
