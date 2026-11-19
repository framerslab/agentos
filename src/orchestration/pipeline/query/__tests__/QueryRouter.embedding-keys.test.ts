/**
 * @fileoverview The router's corpus embeddings carry only a key of the vendor
 * they go to.
 *
 * An OpenAI embedding provider, named or the default, takes OPENAI_API_KEY,
 * else OPENROUTER_API_KEY with OpenRouter's URL, else no key, and retrieval
 * stays on keywords. Another vendor's key (Anthropic's,
 * Gemini's) never reaches OpenAI's endpoint, a key given for the router's
 * classifier and generator never reaches another vendor's embedding
 * endpoint, and Ollama, which has no key variable, is sent none.
 *
 * These cases run the real router, the real provider manager and the real
 * providers. A stubbed `fetch` records every request OpenAI's provider makes
 * and answers it; Ollama's provider, which sends with axios, reaches an
 * Ollama stand-in on 127.0.0.1 that records the requests it gets.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
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
];

/** A request `fetch` was asked to send: its URL, its Authorization header, and every header value and string body. */
interface SentRequest {
  url: string;
  authorization?: string;
  carried: string;
}

/** Requests `fetch` was asked to send anywhere but the Ollama stand-in. */
const sent: SentRequest[] = [];
/** Requests the Ollama stand-in received: path and Authorization header. */
const ollamaSeen: Array<{ url: string; authorization?: string }> = [];

let server: Server;
let ollamaUrl = '';
let corpusDir = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = req.url ?? '/';
      ollamaSeen.push({ url, authorization: req.headers.authorization });
      if (url === '/') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('Ollama is running');
        return;
      }
      const answer = url.endsWith('/embeddings') ? { embedding: new Array(768).fill(0.1) } : { models: [] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  ollamaUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  corpusDir = await fs.mkdtemp(path.join(os.tmpdir(), 'query-router-embedding-keys-'));
  await fs.writeFile(path.join(corpusDir, 'pricing.md'), '# Pricing\n\nStarts at $19/month for the Starter plan.\n');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(corpusDir, { recursive: true, force: true });
});

/** Answers an OpenAI-shaped API: a model list, and an embedding for each input. */
function openAiAnswer(url: string, body: unknown): Response {
  let answer: unknown;
  if (url.endsWith('/embeddings')) {
    const parsed = JSON.parse(typeof body === 'string' ? body : '{}') as { input?: string | string[]; model?: string };
    const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input ?? ''];
    answer = {
      object: 'list',
      model: parsed.model,
      data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: new Array(1536).fill(0.1) })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    };
  } else {
    answer = {
      object: 'list',
      data: [{ id: 'text-embedding-3-small', object: 'model', created: 0, owned_by: 'test' }],
    };
  }
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  for (const name of PROVIDER_VARIABLES) vi.stubEnv(name, '');
  sent.length = 0;
  ollamaSeen.length = 0;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(ollamaUrl)) return realFetch(input as RequestInfo, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const values: string[] = [];
    headers.forEach((value) => values.push(value));
    const body = init?.body;
    sent.push({
      url,
      authorization: headers.get('authorization') ?? undefined,
      carried: [url, ...values, typeof body === 'string' ? body : ''].join('\n'),
    });
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
 * (an OpenAI classifier, generator and embedding provider) do not depend on
 * the environment the suite runs in. A case sets its keys after this.
 */
async function loadRouter() {
  vi.resetModules();
  const { QueryRouter } = await import('../QueryRouter.js');
  return QueryRouter;
}

/** Builds the router on the corpus, initialises it (which embeds the corpus), and returns its embedding status. */
async function initRouter(QueryRouter: Awaited<ReturnType<typeof loadRouter>>, overrides: Record<string, unknown> = {}) {
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
    return router.getCorpusStats().embeddingStatus;
  } finally {
    await router.close();
  }
}

const toOpenAi = (r: SentRequest) => new URL(r.url).hostname === 'api.openai.com';

describe("QueryRouter: an embedding call carries only its own vendor's key", () => {
  it.each([
    ['ANTHROPIC_API_KEY'],
    ['GEMINI_API_KEY'],
    ['GROQ_API_KEY'],
    ['TOGETHER_API_KEY'],
    ['MISTRAL_API_KEY'],
    ['XAI_API_KEY'],
  ])('with only %s set, an OpenAI embedding provider sends nothing and that key goes nowhere', async (variable) => {
    const QueryRouter = await loadRouter();
    vi.stubEnv(variable, 'test-other-vendor-key');

    const status = await initRouter(QueryRouter, { embeddingProvider: 'openai' });

    expect(sent.filter(toOpenAi)).toEqual([]);
    expect(sent.filter((r) => r.carried.includes('test-other-vendor-key'))).toEqual([]);
    expect(status).toBe('disabled-no-key');
  });

  it("with no embedding provider named and only Anthropic's key set, sends that key nowhere", async () => {
    // The module loaded before the key was set, so the default embedding provider is OpenAI.
    const QueryRouter = await loadRouter();
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');

    const status = await initRouter(QueryRouter);

    expect(sent.filter(toOpenAi)).toEqual([]);
    expect(sent.filter((r) => r.carried.includes('test-anthropic-key'))).toEqual([]);
    expect(status).toBe('disabled-no-key');
  });

  it("with only OpenRouter's key set, embeds through OpenRouter's URL with that key", async () => {
    const QueryRouter = await loadRouter();
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');

    await initRouter(QueryRouter, { embeddingProvider: 'openai' });

    expect(sent.filter(toOpenAi)).toEqual([]);
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) {
      expect(r.url.startsWith('https://openrouter.ai/api/v1/')).toBe(true);
      expect(r.authorization).toBe('Bearer test-openrouter-key');
    }
    expect(sent.map((r) => r.url)).toContain('https://openrouter.ai/api/v1/embeddings');
  });

  it("with an empty embeddingApiKey and only OpenRouter's key set, embeds through OpenRouter's URL, never OpenAI's", async () => {
    const QueryRouter = await loadRouter();
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');

    // An empty key is unset: the environment's key applies, and its URL with it.
    await initRouter(QueryRouter, { embeddingProvider: 'openai', embeddingApiKey: '' });

    expect(sent.filter(toOpenAi)).toEqual([]);
    expect(sent.map((r) => r.url)).toContain('https://openrouter.ai/api/v1/embeddings');
    for (const r of sent) expect(r.authorization).toBe('Bearer test-openrouter-key');
  });

  it("with an empty router apiKey shared with OpenAI embeddings and only OpenRouter's key set, embeds through OpenRouter's URL", async () => {
    const QueryRouter = await loadRouter();
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');

    // The classifier's provider is the embedding provider, so the router's apiKey applies to embeddings; empty, it is unset.
    await initRouter(QueryRouter, {
      embeddingProvider: 'openai',
      classifierProvider: 'openai',
      generationProvider: 'openai',
      apiKey: '',
    });

    expect(sent.filter(toOpenAi)).toEqual([]);
    expect(sent.map((r) => r.url)).toContain('https://openrouter.ai/api/v1/embeddings');
    for (const r of sent) expect(r.authorization).toBe('Bearer test-openrouter-key');
  });

  it("with OpenAI's key set, embeds through OpenAI with that key and no other vendor's", async () => {
    const QueryRouter = await loadRouter();
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');

    await initRouter(QueryRouter, { embeddingProvider: 'openai' });

    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) {
      expect(toOpenAi(r)).toBe(true);
      expect(r.authorization).toBe('Bearer test-openai-key');
    }
    expect(sent.map((r) => r.url)).toContain('https://api.openai.com/v1/embeddings');
    expect(sent.filter((r) => r.carried.includes('test-anthropic-key') || r.carried.includes('test-openrouter-key'))).toEqual([]);
  });

  it("keeps a router apiKey given for an Anthropic classifier and generator off the default embedding provider", async () => {
    const QueryRouter = await loadRouter();

    // No embedding provider is named: the default is OpenAI, which is not the provider this key is for.
    const status = await initRouter(QueryRouter, {
      classifierProvider: 'anthropic',
      classifierModel: 'claude-haiku-4-5-20251001',
      generationProvider: 'anthropic',
      generationModel: 'claude-haiku-4-5-20251001',
      generationModelDeep: 'claude-sonnet-4-6',
      apiKey: 'test-anthropic-inline-key',
    });

    expect(sent.filter((r) => r.carried.includes('test-anthropic-inline-key'))).toEqual([]);
    expect(status).toBe('disabled-no-key');
  });

  it("sends an Ollama embedding provider no key, never OpenAI's", async () => {
    const QueryRouter = await loadRouter();
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');

    await initRouter(QueryRouter, {
      embeddingProvider: 'ollama',
      embeddingModel: 'nomic-embed-text',
      embeddingBaseUrl: ollamaUrl,
    });

    // The provider reached the stand-in's API, so a key it was given would have gone with these requests.
    expect(ollamaSeen.some((r) => r.url.startsWith('/api/'))).toBe(true);
    expect(ollamaSeen.filter((r) => r.authorization !== undefined)).toEqual([]);
    expect(sent.filter((r) => r.carried.includes('test-openai-key'))).toEqual([]);
  });
});

