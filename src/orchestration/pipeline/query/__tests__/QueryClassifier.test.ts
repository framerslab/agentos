/**
 * @fileoverview Tests for QueryClassifier — chain-of-thought LLM classifier
 * that determines retrieval depth (T0-T3) for each incoming query.
 *
 * All tests mock the `generateText` function to isolate the classification
 * logic from actual LLM calls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationMessage, QueryTier } from '../types.js';
import { QueryClassifier } from '../QueryClassifier.js';

vi.mock('../../../../api/generateText.js', () => ({
  generateText: vi.fn(),
}));

import { generateText } from '../../../../api/generateText.js';

const mockGenerateText = vi.mocked(generateText);

/** Builds a mock generateText response with the given JSON payload. */
function mockLlmResponse(payload: {
  thinking: string;
  tier: number;
  confidence: number;
  internal_knowledge_sufficient: boolean;
  suggested_sources: string[];
  tools_needed: string[];
}) {
  return {
    text: JSON.stringify(payload),
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    toolCalls: [],
    finishReason: 'stop' as const,
  };
}

/** Default classifier config used by all tests. */
function createClassifier(overrides: Partial<ConstructorParameters<typeof QueryClassifier>[0]> = {}) {
  return new QueryClassifier({
    model: 'gpt-4o-mini',
    provider: 'openai',
    confidenceThreshold: 0.7,
    maxTier: 3 as QueryTier,
    topicList: 'Authentication (docs/auth.md)\nDatabase (docs/database.md)',
    toolList: 'search_code, read_file, run_tests',
    ...overrides,
  });
}

describe('QueryClassifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies a greeting as T0', async () => {
    mockGenerateText.mockResolvedValue(
      mockLlmResponse({
        thinking: 'This is a simple greeting, no retrieval needed.',
        tier: 0,
        confidence: 0.95,
        internal_knowledge_sufficient: true,
        suggested_sources: [],
        tools_needed: [],
      }),
    );

    const classifier = createClassifier();
    const result = await classifier.classify('Hello!');

    expect(result.tier).toBe(0);
    expect(result.confidence).toBe(0.95);
    expect(result.internalKnowledgeSufficient).toBe(true);
    expect(result.suggestedSources).toEqual([]);
    expect(result.toolsNeeded).toEqual([]);
    expect(result.reasoning).toBe('This is a simple greeting, no retrieval needed.');
  });

  it('classifies a docs question as T1', async () => {
    mockGenerateText.mockResolvedValue(
      mockLlmResponse({
        thinking: 'User is asking about a specific config value. Single doc lookup should suffice.',
        tier: 1,
        confidence: 0.88,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: [],
      }),
    );

    const classifier = createClassifier();
    const result = await classifier.classify('What port does the API server run on?');

    expect(result.tier).toBe(1);
    expect(result.confidence).toBe(0.88);
    expect(result.internalKnowledgeSufficient).toBe(false);
    expect(result.suggestedSources).toEqual(['vector']);
  });

  it('bumps tier when confidence is below threshold', async () => {
    mockGenerateText.mockResolvedValue(
      mockLlmResponse({
        thinking: 'Uncertain whether this needs retrieval.',
        tier: 0,
        confidence: 0.5, // Below 0.7 threshold
        internal_knowledge_sufficient: true,
        suggested_sources: [],
        tools_needed: [],
      }),
    );

    const classifier = createClassifier({ confidenceThreshold: 0.7 });
    const result = await classifier.classify('Tell me about the system.');

    // tier 0 + bump = tier 1
    expect(result.tier).toBe(1);
    expect(result.confidence).toBe(0.5);
    expect(result.strategy).toBe('simple');
    expect(result.suggestedSources).toEqual(['vector']);
    expect(result.internalKnowledgeSufficient).toBe(false);
  });

  it('clamps invalid tier and confidence values before returning classification', async () => {
    mockGenerateText.mockResolvedValue(
      mockLlmResponse({
        thinking: 'The model returned out-of-range values.',
        tier: -5,
        confidence: 1.4,
        internal_knowledge_sufficient: true,
        suggested_sources: [],
        tools_needed: [],
      }),
    );

    const classifier = createClassifier();
    const result = await classifier.classify('Hello again');

    expect(result.tier).toBe(0);
    expect(result.confidence).toBe(1);
  });

  it('caps tier at maxTier', async () => {
    mockGenerateText.mockResolvedValue(
      mockLlmResponse({
        thinking: 'This is a research-level question.',
        tier: 3,
        confidence: 0.9,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector', 'graph', 'research'],
        tools_needed: ['search_code'],
      }),
    );

    // maxTier set to 1 — should cap tier 3 down to 1
    const classifier = createClassifier({ maxTier: 1 as QueryTier });
    const result = await classifier.classify('Compare all caching strategies in the codebase.');

    expect(result.tier).toBe(1);
  });

  it('upgrades strategy when the model returns a tier-strategy mismatch', async () => {
    mockGenerateText.mockResolvedValue(
      mockLlmResponse({
        thinking: 'Research-level query, but strategy came back too weak.',
        tier: 3,
        confidence: 0.95,
        internal_knowledge_sufficient: false,
        suggested_sources: [],
        tools_needed: [],
        strategy: 'simple',
      } as any),
    );

    const classifier = createClassifier();
    const result = await classifier.classify('Compare all caching strategies in the codebase');

    expect(result.tier).toBe(3);
    expect(result.strategy).toBe('complex');
    expect(result.suggestedSources).toEqual(['vector', 'graph', 'research']);
  });

  it('falls back to T1 on LLM error', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limited'));

    const classifier = createClassifier();
    const result = await classifier.classify('What is the auth flow?');

    expect(result.tier).toBe(1);
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain('Classification failed');
    expect(result.internalKnowledgeSufficient).toBe(false);
    expect(result.suggestedSources).toEqual(['vector']);
    expect(result.toolsNeeded).toEqual([]);
  });

  it('passes conversation history to the LLM prompt', async () => {
    mockGenerateText.mockResolvedValue(
      mockLlmResponse({
        thinking: 'Follow-up to previous auth discussion.',
        tier: 1,
        confidence: 0.85,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: [],
      }),
    );

    const classifier = createClassifier();
    const history: ConversationMessage[] = [
      { role: 'user', content: 'How does auth work?' },
      { role: 'assistant', content: 'Auth uses JWT tokens...' },
    ];

    await classifier.classify('What about refresh tokens?', history);

    // Verify generateText was called and the system prompt includes conversation context
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.system).toBeDefined();
    expect(callArgs.system).toContain('How does auth work?');
    expect(callArgs.system).toContain('Auth uses JWT tokens...');
  });

  it('normalizes and deduplicates tools_needed ids', async () => {
    mockGenerateText.mockResolvedValue(
      mockLlmResponse({
        thinking: 'Need one tool, but the model used mixed identifier forms.',
        tier: 1,
        confidence: 0.9,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: ['tool:webSearch', 'webSearch'],
      }),
    );

    const classifier = createClassifier();
    const result = await classifier.classify('Search the web for pricing');

    expect(result.toolsNeeded).toEqual(['webSearch']);
  });

  it('filters and deduplicates suggested_sources to valid router values', async () => {
    mockGenerateText.mockResolvedValue(
      mockLlmResponse({
        thinking: 'The model returned mixed source hints.',
        tier: 2,
        confidence: 0.9,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector', 'GRAPH', 'vector', 'web', 'unknown', 'research'],
        tools_needed: [],
      }),
    );

    const classifier = createClassifier();
    const result = await classifier.classify('Compare auth and billing flows');

    expect(result.suggestedSources).toEqual(['vector', 'graph', 'research']);
  });

  it('adds default suggested sources for the chosen strategy when the model omits them', async () => {
    mockGenerateText.mockResolvedValue(
      mockLlmResponse({
        thinking: 'Complex query but missing explicit source hints.',
        tier: 3,
        confidence: 0.95,
        internal_knowledge_sufficient: false,
        suggested_sources: [],
        tools_needed: [],
      }),
    );

    const classifier = createClassifier();
    const result = await classifier.classify('Compare all caching strategies in the codebase');

    expect(result.strategy).toBe('complex');
    expect(result.suggestedSources).toEqual(['vector', 'graph', 'research']);
  });
});

// =============================================================================
// classifyWithPlan() — plan-aware classification with capability recommendations
// =============================================================================

/** Builds a mock generateText response for the plan-aware classifier. */
function mockPlanLlmResponse(payload: {
  thinking: string;
  tier: number;
  strategy: string;
  confidence: number;
  internal_knowledge_sufficient: boolean;
  suggested_sources: string[];
  tools_needed: string[];
  skills?: Array<{ skillId: string; reasoning: string; confidence: number; priority: number }>;
  tools?: Array<{ toolId: string; reasoning: string; confidence: number; priority: number }>;
  extensions?: Array<{ extensionId: string; reasoning: string; confidence: number; priority: number }>;
  requires_external_calls?: boolean;
}) {
  return {
    text: JSON.stringify({
      sources: { vector: true, bm25: false, graph: false, raptor: false, memory: false, multimodal: false },
      hyde: { enabled: false, hypothesisCount: 1 },
      memoryTypes: ['semantic'],
      modalities: ['text'],
      temporal: { preferRecent: false, recencyBoost: 1.0, maxAgeMs: null },
      graphConfig: { maxDepth: 2, minEdgeWeight: 0.3 },
      raptorLayers: [0],
      deepResearch: false,
      reasoning: payload.thinking,
      ...payload,
    }),
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    toolCalls: [],
    finishReason: 'stop' as const,
  };
}

describe('QueryClassifier.classifyWithPlan()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns skill/tool/extension recommendations when the LLM recommends them', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'User wants to search the web and generate an image.',
        tier: 1,
        strategy: 'simple',
        confidence: 0.9,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: ['webSearch'],
        skills: [
          { skillId: 'web-search', reasoning: 'Need web access', confidence: 0.9, priority: 0 },
        ],
        tools: [
          { toolId: 'generateImage', reasoning: 'Need image generation', confidence: 0.85, priority: 0 },
        ],
        extensions: [
          { extensionId: 'browser-automation', reasoning: 'Need browser', confidence: 0.8, priority: 0 },
        ],
        requires_external_calls: true,
      }),
    );

    const classifier = createClassifier();
    const [classification, plan] = await classifier.classifyWithPlan(
      'Search the web for AI news and generate an image',
    );

    expect(classification.tier).toBe(1);
    expect(classification.strategy).toBe('simple');
    expect(plan.skills).toHaveLength(1);
    expect(plan.skills[0].skillId).toBe('web-search');
    expect(plan.tools).toHaveLength(1);
    expect(plan.tools[0].toolId).toBe('generateImage');
    expect(plan.extensions).toHaveLength(1);
    expect(plan.extensions[0].extensionId).toBe('browser-automation');
  });

  it('returns empty recommendation arrays when the LLM omits them', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'Simple greeting, no capabilities needed.',
        tier: 0,
        strategy: 'none',
        confidence: 0.95,
        internal_knowledge_sufficient: true,
        suggested_sources: [],
        tools_needed: [],
      }),
    );

    const classifier = createClassifier();
    const [classification, plan] = await classifier.classifyWithPlan('Hello!');

    expect(classification.tier).toBe(0);
    expect(plan.skills).toEqual([]);
    expect(plan.tools).toEqual([]);
    expect(plan.extensions).toEqual([]);
  });

  it('falls back to default plan with empty recommendations on LLM error', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limited'));

    const classifier = createClassifier();
    const [classification, plan] = await classifier.classifyWithPlan('What is the auth flow?');

    expect(classification.tier).toBe(1);
    expect(classification.confidence).toBe(0);
    expect(plan.skills).toEqual([]);
    expect(plan.tools).toEqual([]);
    expect(plan.extensions).toEqual([]);
  });

  it('injects catalog summaries into the plan prompt when no discovery engine is attached', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'Classified with catalog summaries.',
        tier: 1,
        strategy: 'simple',
        confidence: 0.88,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: [],
      }),
    );

    const classifier = createClassifier();
    // No discovery engine attached — should trigger getCatalogSummaries() fallback
    await classifier.classifyWithPlan('How do extensions work?');

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.system).toBeDefined();
    expect(callArgs.system).toContain('## channel');
    expect(callArgs.system).toContain('Authentication & Subscription');
  });
});
