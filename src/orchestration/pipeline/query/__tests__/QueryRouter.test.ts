/**
 * @fileoverview Tests for QueryRouter — main orchestrator that wires together
 * QueryClassifier, QueryDispatcher, and QueryGenerator into a complete
 * classify -> dispatch -> generate pipeline.
 *
 * Mock strategy:
 * - `generateText` is mocked so no real LLM calls are made.
 * - `node:fs` is mocked so no real filesystem reads are required.
 * - The router is initialised with a minimal config pointing at a fake corpus.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any module imports that depend on them
// ---------------------------------------------------------------------------

vi.mock('../../api/generateText.js', () => ({
  generateText: vi.fn(),
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

import { generateText } from '../../../../api/generateText.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type {
  QueryRouterConfig as PublicQueryRouterConfig,
  QueryRouterCorpusStats as PublicQueryRouterCorpusStats,
  QueryRouterEmbeddingStatus,
  QueryRouterRetrievalMode,
  QueryRouterRuntimeMode,
  QueryRouterToggleableRuntimeMode,
} from '../../../../index.js';
import { QueryRouter } from '../QueryRouter.js';
import type { QueryResult, ClassificationResult } from '../types.js';

const mockGenerateText = vi.mocked(generateText);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a QueryRouter instance with sensible test defaults.
 * Points knowledgeCorpus at a single fake directory (fs is mocked).
 */
function createRouter(overrides: Record<string, unknown> = {}): QueryRouter {
  return new QueryRouter({
    knowledgeCorpus: ['/fake/docs'],
    classifierModel: 'gpt-4o-mini',
    classifierProvider: 'openai',
    confidenceThreshold: 0.7,
    maxTier: 3,
    generationModel: 'gpt-4o-mini',
    generationModelDeep: 'gpt-4o',
    generationProvider: 'openai',
    graphEnabled: false,
    deepResearchEnabled: false,
    conversationWindowSize: 5,
    maxContextTokens: 4000,
    cacheResults: false,
    ...overrides,
  });
}

/**
 * Builds a mock generateText response containing a classifier JSON payload.
 * The classifier always returns T0 with high confidence for test predictability.
 */
function classifierResponse(tier = 0, confidence = 0.95) {
  const strategy = tier === 0 ? 'none' : tier === 1 ? 'simple' : tier === 2 ? 'moderate' : 'complex';
  return {
    text: JSON.stringify({
      thinking: 'Test classification reasoning.',
      tier,
      strategy,
      confidence,
      internal_knowledge_sufficient: tier === 0,
      suggested_sources: tier === 0 ? [] : ['vector'],
      tools_needed: [],
    }),
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: { promptTokens: 80, completionTokens: 30, totalTokens: 110 },
    toolCalls: [],
    finishReason: 'stop' as const,
  };
}

function planClassifierResponse(
  tier = 0,
  confidence = 0.95,
  overrides: Record<string, unknown> = {},
) {
  const strategy = tier === 0 ? 'none' : tier === 1 ? 'simple' : tier === 2 ? 'moderate' : 'complex';
  return {
    text: JSON.stringify({
      thinking: 'Test plan-aware classification reasoning.',
      tier,
      strategy,
      confidence,
      internal_knowledge_sufficient: tier === 0,
      suggested_sources: tier === 0 ? [] : ['vector'],
      tools_needed: [],
      sources: {
        vector: tier >= 1,
        bm25: tier >= 1,
        graph: tier >= 2,
        raptor: tier >= 3,
        memory: tier >= 1,
        multimodal: false,
      },
      hyde: {
        enabled: tier >= 2,
        hypothesisCount: tier >= 3 ? 3 : tier >= 2 ? 1 : 0,
      },
      memoryTypes: tier >= 3
        ? ['episodic', 'semantic', 'procedural', 'prospective', 'relational']
        : tier >= 1
          ? ['episodic', 'semantic']
          : [],
      modalities: ['text'],
      temporal: { preferRecent: false, recencyBoost: 1.0, maxAgeMs: null },
      graphConfig: { maxDepth: 2, minEdgeWeight: 0.3 },
      raptorLayers: tier >= 3 ? [0, 1] : [0],
      deepResearch: tier >= 3,
      skills: [],
      tools: [],
      extensions: [],
      requires_external_calls: tier !== 0,
      ...overrides,
    }),
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: { promptTokens: 140, completionTokens: 50, totalTokens: 190 },
    toolCalls: [],
    finishReason: 'stop' as const,
  };
}

/** Builds a mock generateText response for the generation phase. */
function generatorResponse(answer = 'The Starter plan costs $19/month.') {
  return {
    text: answer,
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: { promptTokens: 150, completionTokens: 60, totalTokens: 210 },
    toolCalls: [],
    finishReason: 'stop' as const,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueryRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateText.mockReset();
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: 'pricing.md', isDirectory: () => false, isFile: () => true },
    ] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync.mockReturnValue(
      '# Pricing\n\nStarts at $19/month for the Starter plan.'
    );
  });

  it('public QueryRouterConfig matches the constructor surface', () => {
    const config: PublicQueryRouterConfig = {
      knowledgeCorpus: ['/fake/docs'],
      availableTools: ['web_search'],
      generationModel: 'gpt-4o-mini',
      embeddingApiKey: 'test-embedding-key',
      rerank: async (_query, chunks) => chunks,
    };

    expect(config.knowledgeCorpus).toEqual(['/fake/docs']);
    expect(config.availableTools).toEqual(['web_search']);
    expect(config.embeddingApiKey).toBe('test-embedding-key');
    expect(typeof config.rerank).toBe('function');
  });

  it('public QueryRouterCorpusStats matches getCorpusStats()', async () => {
    const router = createRouter({ graphEnabled: true, deepResearchEnabled: true });

    await router.init();

    const stats: PublicQueryRouterCorpusStats = router.getCorpusStats();
    const embeddingStatus: QueryRouterEmbeddingStatus = stats.embeddingStatus;
    const retrievalMode: QueryRouterRetrievalMode = stats.retrievalMode;
    const rerankRuntimeMode: QueryRouterRuntimeMode = stats.rerankRuntimeMode;
    const graphRuntimeMode: QueryRouterToggleableRuntimeMode = stats.graphRuntimeMode;
    const deepResearchRuntimeMode: QueryRouterToggleableRuntimeMode = stats.deepResearchRuntimeMode;

    expect(stats.initialized).toBe(true);
    expect(embeddingStatus).toBe('disabled-no-key');
    expect(retrievalMode).toBe('keyword-only');
    expect(rerankRuntimeMode).toBe('heuristic');
    expect(graphRuntimeMode).toBe('heuristic');
    expect(deepResearchRuntimeMode).toBe('heuristic');
  });

  it('resolves OpenRouter env defaults for LLM and embedding paths when OpenAI is absent', () => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

    const router = createRouter();

    expect((router as any).getLlmApiKey()).toBe('test-openrouter-key');
    expect((router as any).getLlmBaseUrl()).toBe('https://openrouter.ai/api/v1');
    expect((router as any).getEmbeddingApiKey()).toBe('test-openrouter-key');
    expect((router as any).getEmbeddingBaseUrl()).toBe('https://openrouter.ai/api/v1');
  });

  it('prefers OpenAI env defaults over OpenRouter when both are present', () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

    const router = createRouter();

    expect((router as any).getLlmApiKey()).toBe('test-openai-key');
    expect((router as any).getLlmBaseUrl()).toBeUndefined();
    expect((router as any).getEmbeddingApiKey()).toBe('test-openai-key');
    expect((router as any).getEmbeddingBaseUrl()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 1: classify() returns a ClassificationResult
  // -------------------------------------------------------------------------
  it('classify() returns a ClassificationResult', async () => {
    mockGenerateText.mockResolvedValueOnce(classifierResponse(1, 0.88));

    const router = createRouter();
    await router.init();

    const result = await router.classify('What is the pricing?');

    expect(result).toBeDefined();
    expect(result.tier).toBe(1);
    expect(result.confidence).toBe(0.88);
    expect(typeof result.reasoning).toBe('string');
    expect(Array.isArray(result.suggestedSources)).toBe(true);
    expect(Array.isArray(result.toolsNeeded)).toBe(true);
  });

  it('init() fails loudly when no readable markdown corpus chunks are loaded', async () => {
    mockExistsSync.mockReturnValue(false);

    const router = createRouter();

    await expect(router.init()).rejects.toThrow(
      /no readable markdown corpus chunks were loaded/i
    );
    await expect(router.init()).rejects.toThrow(/\/fake\/docs/);
  });

  // -------------------------------------------------------------------------
  // Test 2: route() returns QueryResult with answer and classification
  // -------------------------------------------------------------------------
  it('route() returns a QueryResult with answer and classification', async () => {
    // First call = classifier, second call = generator
    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(0, 0.95))
      .mockResolvedValueOnce(generatorResponse());

    const router = createRouter();
    await router.init();

    const result: QueryResult = await router.route('How much does it cost?');

    expect(result.answer).toBe('The Starter plan costs $19/month.');
    expect(result.classification).toBeDefined();
    expect(result.classification.tier).toBe(0);
    expect(result.classification.confidence).toBe(0.95);
    expect(Array.isArray(result.sources)).toBe(true);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.tiersUsed)).toBe(true);
    expect(result.tiersUsed).toContain(0);
  });

  it('route() forwards request exclusions to plan-aware classification', async () => {
    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(0, 0.95))
      .mockResolvedValueOnce(generatorResponse('Filtered answer.'));

    const router = createRouter();
    await router.init();

    const classifier = (router as any).classifier;
    const classifyWithPlanSpy = vi
      .spyOn(classifier, 'classifyWithPlan')
      .mockResolvedValue([
        {
          tier: 0,
          strategy: 'none',
          confidence: 0.95,
          reasoning: 'Plan-aware classification.',
          internalKnowledgeSufficient: true,
          suggestedSources: [],
          toolsNeeded: [],
        },
        {
          strategy: 'none',
          confidence: 0.95,
          shouldRetrieve: false,
          retrieval: {
            sources: [],
            mode: 'keyword-only',
          },
          graph: { expand: false, maxHops: 0 },
          rerank: { enabled: false },
          memory: { enabled: false },
          modalities: { includeText: true, includeCode: false, includeImages: false },
          planning: { decompose: false, steps: [] },
          answer: { style: 'concise', includeCitations: true, includeCodeExamples: false },
          skills: [],
          tools: [],
          extensions: [],
        },
      ] as any);

    await router.route('How much does it cost?', undefined, {
      excludedCapabilityIds: ['research-skill'],
    });

    expect(classifyWithPlanSpy).toHaveBeenCalledWith(
      'How much does it cost?',
      undefined,
      { excludedCapabilityIds: ['research-skill'] },
    );
  });

  it('route() does not emit excluded skills in capabilities:activate events', async () => {
    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(0, 0.92, {
          thinking: 'Browsing is excluded, so do not activate it.',
          skills: [
            { skillId: 'skill:web-search', reasoning: 'Would browse externally', confidence: 0.9, priority: 0 },
          ],
          requires_external_calls: true,
        }))
      .mockResolvedValueOnce(generatorResponse('Handled without external skills.'));

    const router = createRouter();
    await router.init();

    await router.route('Help without browsing', undefined, {
      excludedCapabilityIds: ['web-search'],
    });

    const activationEvent = (router as any).events.find(
      (event: any) => event.type === 'capabilities:activate',
    );

    expect(activationEvent).toBeUndefined();
  });

  it('route() emits normalized capability ids in capabilities:activate events', async () => {
    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(1, 0.9, {
          thinking: 'Use discovery-style ids but normalize them before emission.',
          tools_needed: ['webSearch'],
          skills: [
            { skillId: 'skill:web-search', reasoning: 'Need web access', confidence: 0.9, priority: 0 },
          ],
          tools: [
            { toolId: 'tool:webSearch', reasoning: 'Need the web tool', confidence: 0.85, priority: 0 },
          ],
          extensions: [
            { extensionId: 'extension:browser-automation', reasoning: 'Need browser automation', confidence: 0.8, priority: 0 },
          ],
          requires_external_calls: true,
        }))
      .mockResolvedValueOnce(generatorResponse('Handled with normalized capability ids.'));

    const router = createRouter();
    await router.init();

    await router.route('Search the web', undefined);

    const activationEvent = (router as any).events.find(
      (event: any) => event.type === 'capabilities:activate',
    );

    expect(activationEvent).toMatchObject({
      skills: [
        { skillId: 'web-search', reasoning: 'Need web access', confidence: 0.9, priority: 0 },
      ],
      tools: [
        { toolId: 'webSearch', reasoning: 'Need the web tool', confidence: 0.85, priority: 0 },
      ],
      extensions: [
        {
          extensionId: 'browser-automation',
          reasoning: 'Need browser automation',
          confidence: 0.8,
          priority: 0,
        },
      ],
    });
  });

  it('getCorpusStats() reports loaded chunk, topic, and source counts after init', async () => {
    const router = createRouter();

    await router.init();

    expect(router.getCorpusStats()).toEqual({
      initialized: true,
      configuredPathCount: 1,
      chunkCount: 1,
      topicCount: 1,
      sourceCount: 1,
      platformKnowledge: {
        total: 0,
        tools: 0,
        skills: 0,
        faq: 0,
        api: 0,
        troubleshooting: 0,
      },
      retrievalMode: 'keyword-only',
      embeddingStatus: 'disabled-no-key',
      embeddingDimension: 0,
      graphEnabled: false,
      deepResearchEnabled: false,
      graphRuntimeMode: 'disabled',
      rerankRuntimeMode: 'heuristic',
      deepResearchRuntimeMode: 'disabled',
    });
  });

  it('getCorpusStats() distinguishes config flags from placeholder runtime branches', async () => {
    const router = createRouter({ graphEnabled: true, deepResearchEnabled: true });

    await router.init();

    expect(router.getCorpusStats()).toMatchObject({
      graphEnabled: true,
      deepResearchEnabled: true,
      graphRuntimeMode: 'heuristic',
      rerankRuntimeMode: 'heuristic',
      deepResearchRuntimeMode: 'heuristic',
    });
  });

  it('getCorpusStats() reports active runtime modes when host hooks are injected', async () => {
    const router = createRouter({
      graphEnabled: true,
      deepResearchEnabled: true,
      graphExpand: async (seedChunks: any[]) => seedChunks,
      rerank: async (_query: string, chunks: any[], topN: number) => chunks.slice(0, topN),
      deepResearch: async () => ({ synthesis: 'Live research', sources: [] }),
    });

    await router.init();

    expect(router.getCorpusStats()).toMatchObject({
      graphRuntimeMode: 'active',
      rerankRuntimeMode: 'active',
      deepResearchRuntimeMode: 'active',
    });
  });

  it('syncIndexedCorpusChunks() refreshes fallback search and classifier topics', async () => {
    const router = createRouter();

    await router.init();
    await (router as any).syncIndexedCorpusChunks([
      {
        heading: 'Memory',
        content: 'Multimodal memory routing details for GitHub-indexed docs.',
        sourcePath: '/github/docs/memory.md',
      },
      {
        heading: 'Memory',
        content: 'Multimodal memory routing details for GitHub-indexed docs.',
        sourcePath: '/github/docs/memory.md',
      },
      {
        heading: 'Tiny',
        content: 'short',
        sourcePath: '/github/docs/tiny.md',
      },
    ]);

    expect(router.getCorpusStats()).toMatchObject({
      chunkCount: 2,
      topicCount: 2,
      sourceCount: 2,
      retrievalMode: 'keyword-only',
    });

    const searchResults = await (router as any).vectorSearch('multimodal memory routing', 5);

    expect(searchResults.some((chunk: { sourcePath: string }) => chunk.sourcePath === '/github/docs/memory.md')).toBe(true);
    expect(((router as any).classifier as any).config.topicList).toContain('Memory');
  });

  it('getCorpusStats() reports failed embedding init separately from missing credentials', async () => {
    const router = createRouter();

    (router as any).embeddingStatus = 'failed-init';

    expect(router.getCorpusStats()).toMatchObject({
      retrievalMode: 'keyword-only',
      embeddingStatus: 'failed-init',
      embeddingDimension: 0,
    });
  });

  it('rerank() promotes chunks with stronger lexical query overlap', async () => {
    const router = createRouter();

    const reranked = await (router as any).rerank(
      'http cache invalidation strategy',
      [
        {
          id: 'generic',
          heading: 'Overview',
          content: 'General networking concepts without the key terms.',
          sourcePath: '/docs/overview.md',
          relevanceScore: 0.9,
          matchType: 'vector',
        },
        {
          id: 'specific',
          heading: 'HTTP cache invalidation strategy',
          content: 'This section explains cache invalidation strategy for HTTP systems.',
          sourcePath: '/docs/cache.md',
          relevanceScore: 0.6,
          matchType: 'vector',
        },
      ],
      2,
    );

    expect(reranked.map((chunk: { id: string }) => chunk.id)).toEqual(['specific', 'generic']);
  });

  it('graphExpand() finds related chunks from the same source corpus neighborhood', async () => {
    mockReadFileSync.mockReturnValue(
      [
        '# Memory Retrieval',
        '',
        'Memory retrieval context assembly and recall scoring are important for answer quality.',
        '',
        '## Recall Pipeline',
        '',
        'Recall pipeline context assembly for memory retrieval includes scoring, ranking, and prompt injection.',
      ].join('\n'),
    );

    const router = createRouter({ graphEnabled: true });
    await router.init();

    const corpus = (router as any).corpus as Array<{ id: string }>;
    const expanded = await (router as any).graphExpand([corpus[0]]);

    expect(expanded.length).toBeGreaterThan(0);
    expect(expanded[0]).toMatchObject({
      id: corpus[1].id,
      matchType: 'graph',
    });
  });

  it('deepResearch() produces local-corpus synthesis and research chunks when enabled', async () => {
    mockReadFileSync.mockReturnValue(
      [
        '# Memory Retrieval',
        '',
        'Memory retrieval context assembly improves answer quality.',
        '',
        '## Recall Pipeline',
        '',
        'The recall pipeline ranks chunks and assembles prompt context.',
      ].join('\n'),
    );

    const router = createRouter({ deepResearchEnabled: true });
    await router.init();

    const result = await (router as any).deepResearch('memory retrieval context', ['docs']);

    expect(result.synthesis).toContain('Memory Retrieval');
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0]).toMatchObject({
      matchType: 'research',
    });
  });

  it('route() uses host-provided rerank hook when supplied', async () => {
    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(2, 0.95, {
        suggested_sources: ['vector', 'graph'],
      }))
      .mockResolvedValueOnce(generatorResponse('Custom rerank answer.'));

    const customRerank = vi.fn(async (_query: string, chunks: any[], topN: number) =>
      [...chunks].reverse().slice(0, topN)
    );

    const router = createRouter({
      graphEnabled: false,
      rerank: customRerank,
    });

    await router.init();
    await router.route('How does pricing work?');

    expect(customRerank).toHaveBeenCalledTimes(1);
  });

  it('route() uses host-provided graph and deep research hooks when supplied', async () => {
    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(3, 0.95, {
        suggested_sources: ['vector', 'graph', 'research'],
      }))
      .mockResolvedValueOnce(generatorResponse('Custom research answer.'));

    const customGraphExpand = vi.fn(async (seedChunks: any[]) => [
      ...seedChunks,
      {
        id: 'graph-1',
        heading: 'Related Architecture',
        content: 'Graph expansion added this related architecture chunk.',
        sourcePath: '/docs/graph.md',
        relevanceScore: 0.72,
        matchType: 'graph',
      },
    ]);
    const customDeepResearch = vi.fn(async () => ({
      synthesis: 'Host-provided deep research synthesis.',
      sources: [
        {
          id: 'research-1',
          heading: 'External research',
          content: 'A host-provided research result.',
          sourcePath: '/docs/research.md',
          relevanceScore: 0.81,
          matchType: 'research' as const,
        },
      ],
    }));

    const router = createRouter({
      graphEnabled: true,
      deepResearchEnabled: true,
      graphExpand: customGraphExpand,
      deepResearch: customDeepResearch,
    });

    await router.init();
    const result = await router.route('Compare the architecture to competing frameworks.');

    expect(customGraphExpand).toHaveBeenCalledTimes(1);
    expect(customDeepResearch).toHaveBeenCalledTimes(1);
    expect(result.researchSynthesis).toBe('Host-provided deep research synthesis.');
    expect(result.sources.some((source) => source.path === '/docs/research.md')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: onClassification hook fires during route()
  // -------------------------------------------------------------------------
  it('onClassification hook fires during route()', async () => {
    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(0, 0.9))
      .mockResolvedValueOnce(generatorResponse());

    const onClassification = vi.fn();
    const router = createRouter({ onClassification });
    await router.init();

    await router.route('Tell me about pricing.');

    expect(onClassification).toHaveBeenCalledTimes(1);
    const hookArg: ClassificationResult = onClassification.mock.calls[0][0];
    expect(hookArg.tier).toBe(0);
    expect(hookArg.confidence).toBe(0.9);
  });

  it('includes available tools in the classifier prompt', async () => {
    mockGenerateText.mockResolvedValueOnce(classifierResponse(1, 0.88));

    const router = createRouter({
      availableTools: ['web_search', 'deep_research'],
    });
    await router.init();

    await router.classify('What can you look up?');

    const classifierCall = mockGenerateText.mock.calls[0][0];
    expect(classifierCall.system).toContain('web_search, deep_research');
  });

  it('records retrieval fallbacks and exercised tiers in route()', async () => {
    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(2, 0.92, {
        suggested_sources: ['vector', 'graph'],
      }))
      .mockResolvedValueOnce(generatorResponse('Pricing starts at $19/month.'));

    const router = createRouter({ graphEnabled: false });
    await router.init();

    const result = await router.route('Compare pricing docs across the product tiers.');

    expect(result.fallbacksUsed).toContain('keyword-fallback');
    expect(result.tiersUsed).toEqual([1, 2]);
  });

  it('records research fallback when tier 3 downgrades to tier 2', async () => {
    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(3, 0.95, {
        suggested_sources: ['vector', 'graph', 'research'],
      }))
      .mockResolvedValueOnce(generatorResponse('Fallback research answer.'));

    const router = createRouter({ graphEnabled: true, deepResearchEnabled: true });
    await router.init();

    vi.spyOn(router as any, 'deepResearch')
      .mockRejectedValue(new Error('Research backend unavailable'));

    const result = await router.route('Compare the architecture to competing frameworks.');

    expect(result.fallbacksUsed).toContain('research-skip');
    expect(result.tiersUsed).toEqual([1, 2, 3]);
  });

  it('route() surfaces capability recommendations in QueryResult when plan has them', async () => {
    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(1, 0.9, {
          thinking: 'Need web search and image generation.',
          tools_needed: ['webSearch'],
          memoryTypes: ['semantic'],
          skills: [
            { skillId: 'web-search', reasoning: 'Need web access', confidence: 0.9, priority: 0 },
          ],
          tools: [
            { toolId: 'generateImage', reasoning: 'Image generation needed', confidence: 0.85, priority: 0 },
          ],
          extensions: [],
          requires_external_calls: true,
        }))
      .mockResolvedValueOnce(generatorResponse('Here are the search results and generated image.'));

    const router = createRouter();
    await router.init();

    const result = await router.route('Search the web for AI news and generate an image');

    expect(result.recommendations).toBeDefined();
    expect(result.recommendations!.skills).toHaveLength(1);
    expect(result.recommendations!.skills[0]).toMatchObject({
      skillId: 'web-search',
      reasoning: 'Need web access',
      confidence: 0.9,
    });
    expect(result.recommendations!.tools).toHaveLength(1);
    expect(result.recommendations!.tools[0]).toMatchObject({
      toolId: 'generateImage',
      reasoning: 'Image generation needed',
      confidence: 0.85,
    });
    expect(result.recommendations!.extensions).toEqual([]);
  });

  it('setCapabilityDiscoveryEngine() persists engines attached before init()', async () => {
    const router = createRouter();
    const mockEngine = {
      isInitialized: vi.fn().mockReturnValue(true),
      getTier0SummariesByKind: vi.fn().mockReturnValue({
        skills: '## research\nweb-search',
        tools: '## tool\nwebSearch',
        extensions: '## extension\nbrowser-automation',
      }),
    } as any;

    router.setCapabilityDiscoveryEngine(mockEngine);
    await router.init();

    expect((router as any).classifier.getCapabilityDiscoveryEngine()).toBe(mockEngine);
  });

  it('route() returns undefined recommendations when no plan capabilities are recommended', async () => {
    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(0, 0.95))
      .mockResolvedValueOnce(generatorResponse());

    const router = createRouter();
    await router.init();

    const result = await router.route('How much does it cost?');

    // No UnifiedRetriever attached, so plan-based path is not exercised
    expect(result.recommendations).toBeUndefined();
  });

  it('route() reuses cached results for repeated identical queries when cacheResults is enabled', async () => {
    const router = createRouter({ cacheResults: true });

    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(1))
      .mockResolvedValueOnce(generatorResponse('The Starter plan costs $19/month.'));

    await router.init();

    const first = await router.route('How much does it cost?');
    const second = await router.route('How much does it cost?');

    expect(first.answer).toBe('The Starter plan costs $19/month.');
    expect(second).toEqual(first);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it('route() clears cached results when indexed corpus chunks change', async () => {
    const router = createRouter({ cacheResults: true });

    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(1))
      .mockResolvedValueOnce(generatorResponse('The Starter plan costs $19/month.'))
      .mockResolvedValueOnce(planClassifierResponse(1))
      .mockResolvedValueOnce(generatorResponse('The Starter plan still costs $19/month.'));

    await router.init();

    const first = await router.route('How much does it cost?');

    await (router as any).syncIndexedCorpusChunks([
      {
        heading: 'Pricing Addendum',
        content: 'Cached query results must be invalidated after corpus changes.',
        sourcePath: '/docs/pricing-addendum.md',
      },
    ]);

    const second = await router.route('How much does it cost?');

    expect(first.answer).toBe('The Starter plan costs $19/month.');
    expect(second.answer).toBe('The Starter plan still costs $19/month.');
    expect(mockGenerateText).toHaveBeenCalledTimes(4);
  });

  it('route() populates grounding when verifyCitations is enabled and embeddings are available', async () => {
    const router = createRouter({ verifyCitations: true, cacheResults: false });

    mockGenerateText
      .mockResolvedValueOnce(planClassifierResponse(1))
      .mockResolvedValueOnce(generatorResponse('The Starter plan costs $19/month.'));

    await router.init();

    (router as any).embeddingManager = {
      generateEmbeddings: vi.fn().mockImplementation(async ({ texts }: { texts: string[] }) => ({
        embeddings: texts.map((text) => {
          const normalized = text.toLowerCase();
          if (normalized.includes('starter') || normalized.includes('19/month') || normalized.includes('$19')) {
            return [1, 0];
          }
          return [0, 1];
        }),
      })),
    };

    const result = await router.route('What does the Starter plan start at?');

    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.grounding).toBeDefined();
    expect(result.grounding?.totalClaims).toBeGreaterThan(0);
    expect(result.grounding?.supportedCount).toBeGreaterThan(0);
    expect(result.grounding?.claims[0]?.verdict).toBe('supported');
  });

  // -------------------------------------------------------------------------
  // Test 7: close() doesn't throw
  // -------------------------------------------------------------------------
  it('close() does not throw', async () => {
    const router = createRouter();
    await router.init();

    await expect(router.close()).resolves.not.toThrow();
  });
});
