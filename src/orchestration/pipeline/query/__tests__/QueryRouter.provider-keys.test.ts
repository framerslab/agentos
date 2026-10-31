/**
 * @fileoverview The credentials QueryRouter hands its classifier and
 * generator: a route takes its own provider's key and endpoint, so one
 * vendor's key never reaches another, and a MiniMax key alone gives the
 * router MiniMax defaults.
 *
 * `generateText` is mocked to record the options of each call. The provider
 * manager the embedding step builds is mocked to record the provider and key
 * it is given and then to fail, so no case reaches the network and retrieval
 * falls back to keywords.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../api/generateText.js', () => ({
  generateText: vi.fn(),
}));

/** The provider and key each embedding step hands the provider manager, in order. */
const embeddingProviders = vi.hoisted(() => [] as Array<{ providerId: string; apiKey?: string }>);
/** The base URL each embedding step hands the provider manager, in order; undefined when it gives none. */
const embeddingBaseUrls = vi.hoisted(() => [] as Array<string | undefined>);

vi.mock('../../../../core/llm/providers/AIModelProviderManager.js', () => ({
  AIModelProviderManager: class {
    async initialize(config: { providers: Array<{ providerId: string; config: { apiKey?: string; baseUrl?: string } }> }): Promise<void> {
      for (const entry of config.providers) {
        embeddingProviders.push({ providerId: entry.providerId, apiKey: entry.config.apiKey });
        embeddingBaseUrls.push(entry.config.baseUrl);
      }
      throw new Error('embeddings are not used in these cases');
    }
  },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readdirSync: vi.fn().mockReturnValue([
      { name: 'pricing.md', isDirectory: () => false, isFile: () => true },
    ]),
    readFileSync: vi.fn().mockReturnValue('# Pricing\n\nStarts at $19/month for the Starter plan.'),
  };
});

const FLASH = 'MiniMax-M3.1-Flash';

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
];

/** The classifier's answer, with its retrieval plan: tier 0, so the generator answers with no retrieval. */
function classifierReply() {
  return {
    text: JSON.stringify({
      thinking: 'Pricing is in the corpus.',
      tier: 0,
      strategy: 'none',
      confidence: 0.95,
      internal_knowledge_sufficient: true,
      suggested_sources: [],
      tools_needed: [],
      sources: { vector: false, bm25: false, graph: false, raptor: false, memory: false, multimodal: false },
      hyde: { enabled: false, hypothesisCount: 0 },
      memoryTypes: [],
      modalities: ['text'],
      temporal: { preferRecent: false, recencyBoost: 1.0, maxAgeMs: null },
      graphConfig: { maxDepth: 2, minEdgeWeight: 0.3 },
      raptorLayers: [0],
      deepResearch: false,
      skills: [],
      tools: [],
      extensions: [],
      requires_external_calls: false,
    }),
    provider: 'minimax',
    model: FLASH,
    usage: { promptTokens: 80, completionTokens: 30, totalTokens: 110 },
    toolCalls: [],
    finishReason: 'stop' as const,
  };
}

function answerReply() {
  return {
    text: 'The Starter plan costs $19/month.',
    provider: 'minimax',
    model: FLASH,
    usage: { promptTokens: 150, completionTokens: 60, totalTokens: 210 },
    toolCalls: [],
    finishReason: 'stop' as const,
  };
}

type CallOptions = { provider?: string; model?: string; apiKey?: string; baseUrl?: string };

/**
 * Loads the router and the mocked `generateText` afresh, after the case has
 * set its environment: the router's defaults are read from the environment
 * when its module loads.
 */
async function loadRouter() {
  vi.resetModules();
  const { QueryRouter } = await import('../QueryRouter.js');
  const { generateText } = await import('../../../../api/generateText.js');
  const mockGenerateText = vi.mocked(generateText);
  mockGenerateText.mockResolvedValueOnce(classifierReply() as never).mockResolvedValueOnce(answerReply() as never);
  return { QueryRouter, mockGenerateText };
}

async function routeOnce(
  QueryRouter: Awaited<ReturnType<typeof loadRouter>>['QueryRouter'],
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const router = new QueryRouter({
    knowledgeCorpus: ['/fake/docs'],
    graphEnabled: false,
    deepResearchEnabled: false,
    cacheResults: false,
    ...overrides,
  });
  await router.init();
  await router.route('How much does it cost?');
}

function callsOf(mockGenerateText: Awaited<ReturnType<typeof loadRouter>>['mockGenerateText']): CallOptions[] {
  return mockGenerateText.mock.calls.map(([options]) => options as CallOptions);
}

const MINIMAX_ROUTE = {
  classifierProvider: 'minimax',
  classifierModel: FLASH,
  generationProvider: 'minimax',
  generationModel: FLASH,
  generationModelDeep: FLASH,
};

describe('QueryRouter credentials per route', () => {
  beforeEach(() => {
    for (const name of PROVIDER_VARIABLES) vi.stubEnv(name, '');
    embeddingProviders.length = 0;
    embeddingBaseUrls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults the classifier and the generator to MiniMax when its key is the only one set', async () => {
    vi.stubEnv('MINIMAX_API_KEY', 'test-minimax-key');
    vi.stubEnv('OLLAMA_BASE_URL', 'http://127.0.0.1:11434');
    const { QueryRouter, mockGenerateText } = await loadRouter();

    await routeOnce(QueryRouter);

    const calls = callsOf(mockGenerateText);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatchObject({ provider: 'minimax', model: FLASH, apiKey: 'test-minimax-key' });
      // Ollama's URL is not MiniMax's endpoint.
      expect(call.baseUrl).toBeUndefined();
    }
  });

  it("sends a MiniMax route MiniMax's key, never another vendor's", async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('MINIMAX_API_KEY', 'test-minimax-key');
    const { QueryRouter, mockGenerateText } = await loadRouter();

    await routeOnce(QueryRouter, MINIMAX_ROUTE);

    const calls = callsOf(mockGenerateText);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatchObject({ provider: 'minimax', apiKey: 'test-minimax-key' });
      expect(call.baseUrl).toBeUndefined();
    }
  });

  it("gives a MiniMax route no key of another vendor's when MiniMax has none", async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
    const { QueryRouter, mockGenerateText } = await loadRouter();

    await routeOnce(QueryRouter, MINIMAX_ROUTE);

    const calls = callsOf(mockGenerateText);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.provider).toBe('minimax');
      expect(call.apiKey).toBeUndefined();
      expect(call.baseUrl).toBeUndefined();
    }
  });

  it('keeps the OpenRouter fallback of an OpenAI route', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
    vi.stubEnv('MINIMAX_API_KEY', 'test-minimax-key');
    const { QueryRouter, mockGenerateText } = await loadRouter();

    await routeOnce(QueryRouter, {
      classifierProvider: 'openai',
      classifierModel: 'gpt-4o-mini',
      generationProvider: 'openai',
      generationModel: 'gpt-4o-mini',
      generationModelDeep: 'gpt-4o',
    });

    const calls = callsOf(mockGenerateText);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatchObject({
        provider: 'openai',
        apiKey: 'test-openrouter-key',
        baseUrl: 'https://openrouter.ai/api/v1',
      });
    }
  });

  it("keeps a caller's embedding key on OpenAI when MiniMax's key is the only one set", async () => {
    vi.stubEnv('MINIMAX_API_KEY', 'test-minimax-key');
    const { QueryRouter } = await loadRouter();

    // The default embedding model is OpenAI's text-embedding-3-small; MiniMax publishes no embedding model.
    await routeOnce(QueryRouter, { embeddingApiKey: 'test-openai-embedding-key' });

    expect(embeddingProviders).toEqual([{ providerId: 'openai', apiKey: 'test-openai-embedding-key' }]);
  });

  it("gives an embedding provider its own key, never another vendor's", async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
    const { QueryRouter } = await loadRouter();

    await routeOnce(QueryRouter, { embeddingProvider: 'gemini', embeddingModel: 'gemini-embedding-2' });

    expect(embeddingProviders).toEqual([{ providerId: 'gemini', apiKey: 'test-gemini-key' }]);
  });

  it('builds no MiniMax embedding provider from an OpenAI key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    const { QueryRouter } = await loadRouter();

    await routeOnce(QueryRouter, { embeddingProvider: 'minimax' });

    // MiniMax's own key is unset, so the embedding step has no key and retrieval stays on keywords.
    expect(embeddingProviders).toEqual([]);
  });

  it("keeps the router's apiKey off an embedding provider of another vendor", async () => {
    vi.stubEnv('MINIMAX_API_KEY', 'test-minimax-key');
    const { QueryRouter } = await loadRouter();

    // The classifier and the generator default to MiniMax and take this key; embeddings default to OpenAI.
    await routeOnce(QueryRouter, { apiKey: 'test-minimax-inline-key' });

    expect(embeddingProviders).toEqual([]);
  });

  it("gives embeddings the router's apiKey when they use the classifier's provider", async () => {
    const { QueryRouter } = await loadRouter();

    await routeOnce(QueryRouter, { apiKey: 'test-openai-inline-key' });

    expect(embeddingProviders).toEqual([{ providerId: 'openai', apiKey: 'test-openai-inline-key' }]);
  });

  it("gives an embedding provider other than OpenAI no URL from the router, never OpenRouter's", async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
    const { QueryRouter } = await loadRouter();

    await routeOnce(QueryRouter, { embeddingProvider: 'gemini', embeddingModel: 'gemini-embedding-2' });

    expect(embeddingProviders).toEqual([{ providerId: 'gemini', apiKey: 'test-gemini-key' }]);
    expect(embeddingBaseUrls).toEqual([undefined]);
  });

  it("keeps OpenRouter's URL for an OpenAI embedding provider on the OpenRouter key", async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
    const { QueryRouter } = await loadRouter();

    await routeOnce(QueryRouter, { embeddingProvider: 'openai' });

    expect(embeddingProviders).toEqual([{ providerId: 'openai', apiKey: 'test-openrouter-key' }]);
    expect(embeddingBaseUrls).toEqual(['https://openrouter.ai/api/v1']);
  });

  it.each(['', ' \t\n '])(
    'keeps the OpenRouter fallback of an OpenAI route, and its URL for OpenAI embeddings, for a router baseUrl of %j, as with none',
    async (baseUrl) => {
      vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
      const { QueryRouter, mockGenerateText } = await loadRouter();

      await routeOnce(QueryRouter, {
        classifierProvider: 'openai',
        classifierModel: 'gpt-4o-mini',
        generationProvider: 'openai',
        generationModel: 'gpt-4o-mini',
        generationModelDeep: 'gpt-4o',
        embeddingProvider: 'openai',
        baseUrl,
      });

      const calls = callsOf(mockGenerateText);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        // generateText reads a blank URL as unset, so a blank one here would send the OpenRouter key to OpenAI.
        expect(call).toMatchObject({ provider: 'openai', apiKey: 'test-openrouter-key', baseUrl: 'https://openrouter.ai/api/v1' });
      }
      expect(embeddingProviders).toEqual([{ providerId: 'openai', apiKey: 'test-openrouter-key' }]);
      expect(embeddingBaseUrls).toEqual(['https://openrouter.ai/api/v1']);
    },
  );

  it.each(['', ' \t\n '])(
    "keeps OpenRouter's URL for an OpenAI embedding provider on the OpenRouter key for an embeddingBaseUrl of %j, as with none",
    async (embeddingBaseUrl) => {
      vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
      const { QueryRouter } = await loadRouter();

      await routeOnce(QueryRouter, { embeddingProvider: 'openai', embeddingBaseUrl });

      expect(embeddingProviders).toEqual([{ providerId: 'openai', apiKey: 'test-openrouter-key' }]);
      expect(embeddingBaseUrls).toEqual(['https://openrouter.ai/api/v1']);
    },
  );
});
