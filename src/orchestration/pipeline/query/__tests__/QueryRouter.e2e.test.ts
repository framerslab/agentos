/**
 * @fileoverview End-to-end integration test for the QueryRouter pipeline.
 *
 * Exercises the full classify -> dispatch -> generate pipeline with a mocked
 * LLM but real TopicExtractor, KeywordFallback, and Dispatcher wiring.
 *
 * Mock strategy:
 * - `generateText` is mocked to return tier-appropriate responses based on
 *   system prompt content (classifier vs generator detection).
 * - `node:fs` is mocked to provide fake corpus files without touching disk.
 * - No real embedding API calls are made; retrieval falls back to KeywordFallback.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any module imports that depend on them
// ---------------------------------------------------------------------------

vi.mock('../../../../api/generateText.js', () => ({
  generateText: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readdirSync: vi.fn().mockReturnValue([
      { name: 'pricing.md', isDirectory: () => false, isFile: () => true },
      { name: 'security.md', isDirectory: () => false, isFile: () => true },
    ]),
    readFileSync: vi.fn().mockImplementation((path: string) => {
      if (path.includes('pricing')) return '# Pricing\n\nStarter plan costs $19/month. Pro plan costs $49/month.';
      if (path.includes('security')) return '# Security\n\nFive security tiers from dangerous to paranoid. PII redaction built-in.';
      return '';
    }),
  };
});

import { generateText } from '../../../../api/generateText.js';
import { QueryRouter } from '../QueryRouter.js';
import type {
  ClassificationResult,
  QueryResult,
  QueryRouterEventUnion,
} from '../types.js';

const mockGenerateText = vi.mocked(generateText);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a standard mock response object matching the generateText return shape.
 */
function mockResponse(text: string) {
  return {
    text,
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    toolCalls: [],
    finishReason: 'stop' as const,
  };
}

/**
 * Builds a classifier JSON response string.
 */
function classifierJson(
  tier: number,
  confidence: number,
  opts?: {
    internalKnowledgeSufficient?: boolean;
    suggestedSources?: string[];
    toolsNeeded?: string[];
  },
) {
  return JSON.stringify({
    thinking: `Test reasoning for tier ${tier}.`,
    tier,
    confidence,
    internal_knowledge_sufficient: opts?.internalKnowledgeSufficient ?? tier === 0,
    suggested_sources: opts?.suggestedSources ?? (tier === 0 ? [] : ['vector']),
    tools_needed: opts?.toolsNeeded ?? [],
  });
}

/**
 * Creates a QueryRouter with test defaults (no graph, no deep research).
 */
function createTestRouter(overrides: Record<string, unknown> = {}): QueryRouter {
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
 * Smart mock for generateText that inspects the system prompt to determine
 * whether it is a classifier call or a generator call, and returns the
 * appropriate response.
 *
 * - If the system prompt contains "query" and "classifier" (case-insensitive),
 *   it is a classifier call -- returns the classifierPayload.
 * - Otherwise it is a generator call -- returns the generatorAnswer.
 */
function setupSmartMock(
  classifierPayload: string,
  generatorAnswer: string,
) {
  mockGenerateText.mockImplementation(async (opts: any) => {
    const system = (opts.system ?? '').toLowerCase();
    if (system.includes('query') && system.includes('classifier')) {
      return mockResponse(classifierPayload);
    }
    return mockResponse(generatorAnswer);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueryRouter E2E', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Test 1: T0 query -- classifies as conversational, generates without retrieval
  // =========================================================================
  it('T0 query: classifies as conversational and generates without retrieval', async () => {
    setupSmartMock(
      classifierJson(0, 0.95, { internalKnowledgeSufficient: true }),
      'Hello! How can I help you today?',
    );

    const router = createTestRouter();
    await router.init();

    const result = await router.route('hello');

    // Classification should be T0
    expect(result.classification.tier).toBe(0);
    expect(result.classification.confidence).toBe(0.95);
    expect(result.classification.internalKnowledgeSufficient).toBe(true);

    // Answer should come from the generator (no retrieval context injected)
    expect(result.answer).toBe('Hello! How can I help you today?');

    // No sources because T0 performs no retrieval
    expect(result.sources).toHaveLength(0);

    // Only T0 was used
    expect(result.tiersUsed).toContain(0);

    await router.close();
  });

  // =========================================================================
  // Test 2: T1 query -- retrieves from keyword fallback, generates with context
  // =========================================================================
  it('T1 query: retrieves via keyword fallback and generates with context', async () => {
    setupSmartMock(
      classifierJson(1, 0.88, { suggestedSources: ['vector'] }),
      'The Starter plan costs $19/month and the Pro plan costs $49/month.',
    );

    const router = createTestRouter();
    await router.init();

    const result = await router.route('what is pricing');

    // Classification should be T1
    expect(result.classification.tier).toBe(1);
    expect(result.classification.confidence).toBe(0.88);

    // Answer should be generated
    expect(result.answer).toContain('$19/month');

    // Sources should be populated from keyword fallback retrieval
    // (the keyword "pricing" matches the heading in pricing.md)
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.some((s) => s.path.includes('pricing'))).toBe(true);

    // Keyword fallback should have been used (no real embeddings)
    expect(result.fallbacksUsed).toContain('keyword-fallback');

    // The generator call should have received documentation context in the system prompt
    const generatorCall = mockGenerateText.mock.calls.find((call) => {
      const system = ((call[0] as any).system ?? '').toLowerCase();
      return !system.includes('classifier');
    });
    expect(generatorCall).toBeDefined();
    expect((generatorCall![0] as any).system).toContain('Documentation context');

    await router.close();
  });

  // =========================================================================
  // Test 3: Full route() returns QueryResult with all fields populated
  // =========================================================================
  it('route() returns QueryResult with all fields populated', async () => {
    setupSmartMock(
      classifierJson(1, 0.90),
      'Security tiers range from dangerous to paranoid.',
    );

    const router = createTestRouter();
    await router.init();

    const result: QueryResult = await router.route('Tell me about security tiers');

    // All top-level fields present
    expect(typeof result.answer).toBe('string');
    expect(result.answer.length).toBeGreaterThan(0);

    expect(result.classification).toBeDefined();
    expect(typeof result.classification.tier).toBe('number');
    expect(typeof result.classification.confidence).toBe('number');
    expect(typeof result.classification.reasoning).toBe('string');
    expect(typeof result.classification.internalKnowledgeSufficient).toBe('boolean');
    expect(Array.isArray(result.classification.suggestedSources)).toBe(true);
    expect(Array.isArray(result.classification.toolsNeeded)).toBe(true);

    expect(Array.isArray(result.sources)).toBe(true);

    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    expect(Array.isArray(result.tiersUsed)).toBe(true);
    expect(result.tiersUsed.length).toBeGreaterThan(0);

    expect(Array.isArray(result.fallbacksUsed)).toBe(true);

    await router.close();
  });

  // =========================================================================
  // Test 4: Classifier error defaults to T1, still generates an answer
  // =========================================================================
  it('classifier error defaults to T1 and still generates an answer', async () => {
    // First call (classifier) throws, second call (generator) succeeds
    mockGenerateText
      .mockRejectedValueOnce(new Error('LLM service unavailable'))
      .mockResolvedValueOnce(mockResponse('Here is a fallback answer about pricing.'));

    const router = createTestRouter();
    await router.init();

    const result = await router.route('what is the pricing?');

    // Classifier fallback should produce T1 with confidence 0
    expect(result.classification.tier).toBe(1);
    expect(result.classification.confidence).toBe(0);
    expect(result.classification.reasoning).toContain('Classification failed');

    // Answer should still be generated
    expect(result.answer).toBe('Here is a fallback answer about pricing.');
    expect(typeof result.durationMs).toBe('number');

    await router.close();
  });

  // =========================================================================
  // Test 5: Events -- route() emits expected lifecycle events via hooks
  // =========================================================================
  it('route() emits lifecycle events observable via onClassification hook', async () => {
    setupSmartMock(
      classifierJson(1, 0.85),
      'Answer from the generator.',
    );

    const classificationEvents: ClassificationResult[] = [];

    const router = createTestRouter({
      onClassification: (result: ClassificationResult) => {
        classificationEvents.push(result);
      },
    });
    await router.init();

    const result = await router.route('what is pricing');

    // onClassification hook should have fired exactly once
    expect(classificationEvents).toHaveLength(1);
    expect(classificationEvents[0].tier).toBe(1);
    expect(classificationEvents[0].confidence).toBe(0.85);

    // The full pipeline should have completed
    expect(result.answer).toBe('Answer from the generator.');

    // Verify the pipeline exercised the expected tiers
    expect(result.tiersUsed).toContain(1);

    await router.close();
  });

  // =========================================================================
  // Test 6: Events -- onRetrieval hook fires with retrieval result
  // =========================================================================
  it('route() emits retrieval events observable via onRetrieval hook', async () => {
    setupSmartMock(
      classifierJson(1, 0.90),
      'Answer with retrieval context.',
    );

    let retrievalChunkCount = -1;

    const router = createTestRouter({
      onRetrieval: (result: any) => {
        retrievalChunkCount = result.chunks.length;
      },
    });
    await router.init();

    await router.route('what is pricing');

    // onRetrieval should have fired and provided chunks
    expect(retrievalChunkCount).toBeGreaterThanOrEqual(0);

    await router.close();
  });

  // =========================================================================
  // Test 7: Multiple sequential queries maintain correct state
  // =========================================================================
  it('handles multiple sequential queries correctly', async () => {
    const router = createTestRouter();
    await router.init();

    // Query 1: T0 greeting
    setupSmartMock(
      classifierJson(0, 0.98, { internalKnowledgeSufficient: true }),
      'Hi there!',
    );
    const r1 = await router.route('hey');
    expect(r1.classification.tier).toBe(0);
    expect(r1.sources).toHaveLength(0);

    // Query 2: T1 factual question
    setupSmartMock(
      classifierJson(1, 0.88),
      'Pricing starts at $19/month.',
    );
    const r2 = await router.route('what is the pricing');
    expect(r2.classification.tier).toBe(1);
    expect(r2.sources.length).toBeGreaterThan(0);

    // Both results should have valid timing
    expect(r1.durationMs).toBeGreaterThanOrEqual(0);
    expect(r2.durationMs).toBeGreaterThanOrEqual(0);

    await router.close();
  });
});
