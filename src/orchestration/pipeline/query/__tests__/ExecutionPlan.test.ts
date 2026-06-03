/**
 * @fileoverview Tests for ExecutionPlan — the extended retrieval plan that
 * includes skill, tool, and extension recommendations alongside the
 * retrieval configuration.
 *
 * Tests cover:
 * - ExecutionPlan type structure and defaults
 * - buildDefaultExecutionPlan factory function
 * - Classifier producing ExecutionPlan with capability recommendations
 * - Heuristic capability selection fallback
 * - Router emitting capabilities:activate events
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildDefaultExecutionPlan,
  buildDefaultPlan,
} from '../../../../cognition/rag/unified/types.js';
import type {
  ExecutionPlan,
  SkillRecommendation,
  ToolRecommendation,
  ExtensionRecommendation,
} from '../../../../cognition/rag/unified/types.js';
import { QueryClassifier, heuristicCapabilitySelect, heuristicClassify } from '../QueryClassifier.js';
import type { ConversationMessage, QueryTier } from '../types.js';

// ============================================================================
// Mock generateText
// ============================================================================

vi.mock('../../../../api/generateText.js', () => ({
  generateText: vi.fn(),
}));

import { generateText } from '../../../../api/generateText.js';

const mockGenerateText = vi.mocked(generateText);

/** Builds a mock generateText response for plan-aware classification. */
function mockPlanLlmResponse(payload: Record<string, unknown>) {
  return {
    text: JSON.stringify(payload),
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
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

// ============================================================================
// buildDefaultExecutionPlan
// ============================================================================

describe('buildDefaultExecutionPlan', () => {
  it('returns empty skill/tool/extension arrays by default', () => {
    const plan = buildDefaultExecutionPlan('simple');

    expect(plan.skills).toEqual([]);
    expect(plan.tools).toEqual([]);
    expect(plan.extensions).toEqual([]);
  });

  it('sets requiresExternalCalls=false for none strategy', () => {
    const plan = buildDefaultExecutionPlan('none');

    expect(plan.requiresExternalCalls).toBe(false);
    expect(plan.internalKnowledgeSufficient).toBe(true);
  });

  it('sets requiresExternalCalls=true for non-none strategies', () => {
    for (const strategy of ['simple', 'moderate', 'complex'] as const) {
      const plan = buildDefaultExecutionPlan(strategy);

      expect(plan.requiresExternalCalls).toBe(true);
      expect(plan.internalKnowledgeSufficient).toBe(false);
    }
  });

  it('inherits all RetrievalPlan fields from buildDefaultPlan', () => {
    const plan = buildDefaultExecutionPlan('moderate');
    const basePlan = buildDefaultPlan('moderate');

    expect(plan.strategy).toBe(basePlan.strategy);
    expect(plan.sources).toEqual(basePlan.sources);
    expect(plan.hyde).toEqual(basePlan.hyde);
    expect(plan.memoryTypes).toEqual(basePlan.memoryTypes);
    expect(plan.modalities).toEqual(basePlan.modalities);
    expect(plan.temporal).toEqual(basePlan.temporal);
    expect(plan.graphConfig).toEqual(basePlan.graphConfig);
    expect(plan.raptorLayers).toEqual(basePlan.raptorLayers);
    expect(plan.deepResearch).toBe(basePlan.deepResearch);
  });

  it('applies overrides for capability recommendations', () => {
    const skills: SkillRecommendation[] = [
      { skillId: 'web-search', reasoning: 'Need web data', confidence: 0.9, priority: 0 },
    ];

    const plan = buildDefaultExecutionPlan('moderate', {
      skills,
      requiresExternalCalls: true,
    });

    expect(plan.skills).toEqual(skills);
    expect(plan.requiresExternalCalls).toBe(true);
    // Other fields remain default
    expect(plan.tools).toEqual([]);
    expect(plan.extensions).toEqual([]);
  });

  it('correctly merges nested overrides', () => {
    const plan = buildDefaultExecutionPlan('simple', {
      sources: { graph: true },
      temporal: { preferRecent: true },
    } as Partial<ExecutionPlan>);

    // Override was applied
    expect(plan.sources.graph).toBe(true);
    expect(plan.temporal.preferRecent).toBe(true);
    // Non-overridden fields retained from base
    expect(plan.sources.vector).toBe(true);
    expect(plan.temporal.recencyBoost).toBe(1.0);
  });
});

// ============================================================================
// heuristicCapabilitySelect
// ============================================================================

describe('heuristicCapabilitySelect', () => {
  it('recommends web-search skill for search queries', () => {
    const result = heuristicCapabilitySelect('Search for recent AI papers');

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].skillId).toBe('web-search');
    expect(result.skills[0].confidence).toBe(0.6);
    expect(result.skills[0].priority).toBe(0);
  });

  it('recommends coding-agent skill for code queries', () => {
    const result = heuristicCapabilitySelect('Debug this function please');

    expect(result.skills.some(s => s.skillId === 'coding-agent')).toBe(true);
  });

  it('recommends generateImage tool for image queries', () => {
    const result = heuristicCapabilitySelect('Generate an image of a sunset');

    expect(result.tools.some(t => t.toolId === 'generateImage')).toBe(true);
  });

  it('recommends calendar tool for scheduling queries', () => {
    const result = heuristicCapabilitySelect('Schedule a meeting for tomorrow');

    expect(result.tools.some(t => t.toolId === 'calendar')).toBe(true);
  });

  it('returns empty arrays for queries with no matching patterns', () => {
    const result = heuristicCapabilitySelect('Hello, how are you?');

    expect(result.skills).toEqual([]);
    expect(result.tools).toEqual([]);
  });

  it('recommends multiple capabilities for complex queries', () => {
    const result = heuristicCapabilitySelect(
      'Search the web for AI news and generate an image summary',
    );

    expect(result.skills.length).toBeGreaterThanOrEqual(1);
    expect(result.tools.length).toBeGreaterThanOrEqual(1);
    expect(result.skills.some(s => s.skillId === 'web-search')).toBe(true);
    expect(result.tools.some(t => t.toolId === 'generateImage')).toBe(true);
  });

  it('assigns incrementing priorities to multiple matches', () => {
    const result = heuristicCapabilitySelect(
      'Search online and then summarize the findings',
    );

    // Should match web-search and summarize
    expect(result.skills.length).toBeGreaterThanOrEqual(2);

    // Priorities should be incrementing from 0
    for (let i = 0; i < result.skills.length; i++) {
      expect(result.skills[i].priority).toBe(i);
    }
  });

  it('recommends email skill for email-related queries', () => {
    const result = heuristicCapabilitySelect('Send an email to the team about the release');

    expect(result.skills.some(s => s.skillId === 'email-intelligence')).toBe(true);
  });

  it('recommends social-broadcast skill for social media queries', () => {
    const result = heuristicCapabilitySelect('Post this update to social media');

    expect(result.skills.some(s => s.skillId === 'social-broadcast')).toBe(true);
  });

  it('respects excluded capability ids for heuristic skill recommendations', () => {
    const result = heuristicCapabilitySelect('Search for recent AI papers', {
      excludedCapabilityIds: ['web-search'],
    });

    expect(result.skills.some((s) => s.skillId === 'web-search')).toBe(false);
  });

  it('treats skill-prefixed exclusions as aliases for heuristic skill recommendations', () => {
    const result = heuristicCapabilitySelect('Search for recent AI papers', {
      excludedCapabilityIds: ['skill:web-search'],
    });

    expect(result.skills.some((s) => s.skillId === 'web-search')).toBe(false);
  });
});

// ============================================================================
// QueryClassifier.classifyWithPlan (ExecutionPlan output)
// ============================================================================

describe('QueryClassifier.classifyWithPlan — ExecutionPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ExecutionPlan with skill/tool/extension recommendations from LLM', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'User wants to search the web. Need web-search skill.',
        strategy: 'moderate',
        tier: 2,
        confidence: 0.9,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: ['webSearch'],
        sources: { vector: true, bm25: true, graph: false, raptor: false, memory: true, multimodal: false },
        skills: [
          { skillId: 'web-search', reasoning: 'User asked to search', confidence: 0.95, priority: 0 },
        ],
        tools: [
          { toolId: 'webSearch', reasoning: 'Need web search tool', confidence: 0.9, priority: 0 },
        ],
        extensions: [],
        requires_external_calls: true,
      }),
    );

    const classifier = createClassifier();
    const [classification, plan] = await classifier.classifyWithPlan('Search the web for AI news');

    expect(classification.tier).toBe(2);
    expect(classification.strategy).toBe('moderate');

    // ExecutionPlan fields
    expect(plan.skills).toHaveLength(1);
    expect(plan.skills[0].skillId).toBe('web-search');
    expect(plan.skills[0].confidence).toBe(0.95);

    expect(plan.tools).toHaveLength(1);
    expect(plan.tools[0].toolId).toBe('webSearch');

    expect(plan.extensions).toHaveLength(0);
    expect(plan.requiresExternalCalls).toBe(true);
    expect(plan.internalKnowledgeSufficient).toBe(false);
  });

  it('returns empty capability arrays when LLM omits them', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'Simple factual question.',
        strategy: 'simple',
        tier: 1,
        confidence: 0.85,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: [],
        sources: { vector: true, bm25: true },
        // No skills, tools, or extensions fields
      }),
    );

    const classifier = createClassifier();
    const [, plan] = await classifier.classifyWithPlan('What port does the API use?');

    expect(plan.skills).toEqual([]);
    expect(plan.tools).toEqual([]);
    expect(plan.extensions).toEqual([]);
  });

  it('upgrades the execution plan to broader strategy defaults when low confidence escalates strategy', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'Maybe internal knowledge is enough, but I am not sure.',
        strategy: 'none',
        tier: 0,
        confidence: 0.2,
        internal_knowledge_sufficient: true,
        suggested_sources: [],
        tools_needed: [],
        sources: {
          vector: false,
          bm25: false,
          graph: false,
          raptor: false,
          memory: false,
          multimodal: false,
        },
        hyde: {
          enabled: false,
          hypothesisCount: 0,
        },
        memoryTypes: [],
        modalities: [],
        deepResearch: false,
        skills: [],
        tools: [],
        extensions: [],
        requires_external_calls: false,
      }),
    );

    const classifier = createClassifier({ confidenceThreshold: 0.7 });
    const [classification, plan] = await classifier.classifyWithPlan('Tell me about the system');

    expect(classification.tier).toBe(1);
    expect(classification.strategy).toBe('simple');
    expect(classification.internalKnowledgeSufficient).toBe(false);
    expect(plan.strategy).toBe('simple');
    expect(plan.sources).toEqual({
      vector: true,
      bm25: true,
      graph: false,
      raptor: false,
      memory: true,
      multimodal: false,
    });
    expect(plan.hyde).toEqual({ enabled: false, hypothesisCount: 0 });
    expect(plan.memoryTypes).toEqual(['episodic', 'semantic']);
    expect(plan.modalities).toEqual(['text']);
    expect(plan.requiresExternalCalls).toBe(true);
    expect(plan.internalKnowledgeSufficient).toBe(false);
  });

  it('upgrades the execution plan when the model returns a tier-strategy mismatch', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'Research-level query, but the strategy came back too weak.',
        strategy: 'simple',
        tier: 3,
        confidence: 0.95,
        internal_knowledge_sufficient: false,
        suggested_sources: [],
        tools_needed: [],
        sources: {
          vector: true,
          bm25: true,
          graph: false,
          raptor: false,
          memory: true,
          multimodal: false,
        },
        hyde: {
          enabled: false,
          hypothesisCount: 0,
        },
        memoryTypes: ['semantic'],
        modalities: ['text'],
        deepResearch: false,
        skills: [],
        tools: [],
        extensions: [],
      }),
    );

    const classifier = createClassifier();
    const [classification, plan] = await classifier.classifyWithPlan(
      'Compare all caching strategies in the codebase',
    );

    expect(classification.tier).toBe(3);
    expect(classification.strategy).toBe('complex');
    expect(classification.suggestedSources).toEqual(['vector', 'graph', 'research']);
    expect(plan.strategy).toBe('complex');
    expect(plan.sources).toEqual({
      vector: true,
      bm25: true,
      graph: true,
      raptor: true,
      memory: true,
      multimodal: false,
    });
    expect(plan.hyde).toEqual({ enabled: true, hypothesisCount: 3 });
    expect(plan.memoryTypes).toEqual([
      'episodic',
      'semantic',
      'procedural',
      'prospective',
      'relational',
    ]);
    expect(plan.deepResearch).toBe(true);
  });

  it('treats extension-only recommendations as requiring external calls', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'Need an extension, but no direct tools or skills.',
        strategy: 'none',
        tier: 0,
        confidence: 0.95,
        internal_knowledge_sufficient: false,
        suggested_sources: [],
        tools_needed: [],
        skills: [],
        tools: [],
        extensions: [
          { extensionId: 'browser-automation', reasoning: 'Need browser automation', confidence: 0.8, priority: 0 },
        ],
      }),
    );

    const classifier = createClassifier();
    const [, plan] = await classifier.classifyWithPlan('Use browser automation only');

    expect(plan.extensions).toHaveLength(1);
    expect(plan.requiresExternalCalls).toBe(true);
  });

  it('falls back to heuristic capability selection on LLM error', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limited'));

    const classifier = createClassifier();
    const [classification, plan] = await classifier.classifyWithPlan(
      'Search the web for recent papers on RAG',
    );

    // Fallback classification
    expect(classification.tier).toBe(1);
    expect(classification.confidence).toBe(0);

    // Heuristic should detect "Search" and recommend web-search
    expect(plan.skills.some(s => s.skillId === 'web-search')).toBe(true);
    expect(plan.requiresExternalCalls).toBe(true);
    expect(plan.internalKnowledgeSufficient).toBe(false);
  });

  it('respects excluded capability ids in heuristic fallback on LLM error', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limited'));

    const classifier = createClassifier();
    const [, plan] = await classifier.classifyWithPlan(
      'Search the web for recent papers on RAG',
      undefined,
      { excludedCapabilityIds: ['web-search'] },
    );

    expect(plan.skills.some((s) => s.skillId === 'web-search')).toBe(false);
    expect(plan.requiresExternalCalls).toBe(false);
  });

  it('filters excluded skills from successful LLM plans and reindexes remaining priorities', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'Search is disabled, keep only coding help.',
        strategy: 'none',
        tier: 0,
        confidence: 0.91,
        internal_knowledge_sufficient: true,
        suggested_sources: [],
        tools_needed: [],
        skills: [
          { skillId: 'skill:web-search', reasoning: 'Would browse the web', confidence: 0.9, priority: 0 },
          { skillId: 'coding-agent', reasoning: 'Can reason locally', confidence: 0.8, priority: 1 },
        ],
        tools: [],
        extensions: [],
        requires_external_calls: true,
      }),
    );

    const classifier = createClassifier();
    const [, plan] = await classifier.classifyWithPlan(
      'Help me debug this without browsing',
      undefined,
      { excludedCapabilityIds: ['web-search'] },
    );

    expect(plan.skills).toHaveLength(1);
    expect(plan.skills[0].skillId).toBe('coding-agent');
    expect(plan.skills[0].priority).toBe(0);
    expect(plan.requiresExternalCalls).toBe(true);
  });

  it('clears requiresExternalCalls when exclusions remove the only recommended skill', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'Browsing is disabled, so no capability should remain.',
        strategy: 'none',
        tier: 0,
        confidence: 0.91,
        internal_knowledge_sufficient: true,
        suggested_sources: [],
        tools_needed: [],
        skills: [
          { skillId: 'skill:web-search', reasoning: 'Would browse the web', confidence: 0.9, priority: 0 },
        ],
        tools: [],
        extensions: [],
        requires_external_calls: true,
      }),
    );

    const classifier = createClassifier();
    const [, plan] = await classifier.classifyWithPlan(
      'Answer locally without browsing',
      undefined,
      { excludedCapabilityIds: ['web-search'] },
    );

    expect(plan.skills).toEqual([]);
    expect(plan.requiresExternalCalls).toBe(false);
  });

  it('falls back to empty capabilities on LLM error for trivial query', async () => {
    mockGenerateText.mockRejectedValue(new Error('API rate limited'));

    const classifier = createClassifier();
    const [, plan] = await classifier.classifyWithPlan('Hello!');

    // Heuristic should not match any capabilities for a greeting
    expect(plan.skills).toEqual([]);
    expect(plan.tools).toEqual([]);
  });

  it('filters out entries with missing skillId/toolId/extensionId', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'Test incomplete entries.',
        strategy: 'simple',
        tier: 1,
        confidence: 0.8,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: [],
        skills: [
          { skillId: 'valid-skill', reasoning: 'needed', confidence: 0.9, priority: 0 },
          { reasoning: 'missing skillId', confidence: 0.5, priority: 1 },
        ],
        tools: [
          { reasoning: 'missing toolId', confidence: 0.5, priority: 0 },
        ],
      }),
    );

    const classifier = createClassifier();
    const [, plan] = await classifier.classifyWithPlan('Test query');

    expect(plan.skills).toHaveLength(1);
    expect(plan.skills[0].skillId).toBe('valid-skill');
    expect(plan.tools).toHaveLength(0);
  });

  it('clamps confidence to 0-1 range', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'Test confidence clamping.',
        strategy: 'simple',
        tier: 1,
        confidence: 0.8,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: [],
        skills: [
          { skillId: 'over-confident', reasoning: 'test', confidence: 1.5, priority: 0 },
          { skillId: 'negative', reasoning: 'test', confidence: -0.3, priority: 1 },
        ],
      }),
    );

    const classifier = createClassifier();
    const [, plan] = await classifier.classifyWithPlan('Test clamping');

    expect(plan.skills[0].confidence).toBe(1);
    expect(plan.skills[1].confidence).toBe(0);
  });

  it('clamps top-level tier and confidence in successful LLM plans', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'Returned out-of-range classifier metadata.',
        strategy: 'simple',
        tier: 99,
        confidence: -0.5,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: [],
        skills: [],
        tools: [],
        extensions: [],
      }),
    );

    const classifier = createClassifier();
    const [classification, plan] = await classifier.classifyWithPlan('Investigate auth flow');

    expect(classification.tier).toBe(3);
    expect(classification.confidence).toBe(0);
    expect(plan.confidence).toBe(0);
  });

  it('sorts recommendations by priority', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'Multi-skill query.',
        strategy: 'complex',
        tier: 3,
        confidence: 0.9,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector', 'graph'],
        tools_needed: [],
        skills: [
          { skillId: 'low-priority', reasoning: 'secondary', confidence: 0.7, priority: 2 },
          { skillId: 'high-priority', reasoning: 'primary', confidence: 0.95, priority: 0 },
          { skillId: 'mid-priority', reasoning: 'supporting', confidence: 0.8, priority: 1 },
        ],
      }),
    );

    const classifier = createClassifier();
    const [, plan] = await classifier.classifyWithPlan('Complex multi-step research');

    expect(plan.skills[0].skillId).toBe('high-priority');
    expect(plan.skills[1].skillId).toBe('mid-priority');
    expect(plan.skills[2].skillId).toBe('low-priority');
  });

  it('normalizes and deduplicates prefixed capability ids from successful LLM plans', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'The model returned discovery-style capability ids.',
        strategy: 'moderate',
        tier: 2,
        confidence: 0.88,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: ['webSearch'],
        skills: [
          { skillId: 'skill:web-search', reasoning: 'Need web access', confidence: 0.9, priority: 0 },
          { skillId: 'web-search', reasoning: 'Duplicate plain id', confidence: 0.7, priority: 1 },
        ],
        tools: [
          { toolId: 'tool:webSearch', reasoning: 'Need the web tool', confidence: 0.85, priority: 0 },
          { toolId: 'webSearch', reasoning: 'Duplicate plain tool id', confidence: 0.6, priority: 1 },
        ],
        extensions: [
          { extensionId: 'extension:browser-automation', reasoning: 'Need browser automation', confidence: 0.8, priority: 0 },
          { extensionId: 'ext:browser-automation', reasoning: 'Duplicate ext alias', confidence: 0.5, priority: 1 },
        ],
        requires_external_calls: true,
      }),
    );

    const classifier = createClassifier();
    const [classification, plan] = await classifier.classifyWithPlan('Search the web with browser automation');

    expect(classification.toolsNeeded).toEqual(['webSearch']);

    expect(plan.skills).toEqual([
      { skillId: 'web-search', reasoning: 'Need web access', confidence: 0.9, priority: 0 },
    ]);
    expect(plan.tools).toEqual([
      { toolId: 'webSearch', reasoning: 'Need the web tool', confidence: 0.85, priority: 0 },
    ]);
    expect(plan.extensions).toEqual([
      {
        extensionId: 'browser-automation',
        reasoning: 'Need browser automation',
        confidence: 0.8,
        priority: 0,
      },
    ]);
  });

  it('normalizes retrieval enum lists and enables multimodal source for non-text modalities', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'The model returned mixed retrieval enum values.',
        strategy: 'moderate',
        tier: 2,
        confidence: 0.87,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: [],
        sources: {
          vector: true,
          bm25: true,
          graph: true,
          raptor: false,
          memory: true,
          multimodal: false,
        },
        memoryTypes: ['semantic', 'SEMANTIC', 'invalid-memory', 'procedural'],
        modalities: ['text', 'IMAGE', 'invalid-modality', 'image'],
        skills: [],
        tools: [],
        extensions: [],
      }),
    );

    const classifier = createClassifier();
    const [, plan] = await classifier.classifyWithPlan('Analyze the screenshot and related notes');

    expect(plan.memoryTypes).toEqual(['semantic', 'procedural']);
    expect(plan.modalities).toEqual(['text', 'image']);
    expect(plan.sources.multimodal).toBe(true);
  });

  it('falls back to strategy defaults when retrieval enum lists are invalid-only', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'The model returned only invalid retrieval enum values.',
        strategy: 'simple',
        tier: 1,
        confidence: 0.82,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: [],
        memoryTypes: ['bad-memory-type'],
        modalities: ['bad-modality'],
        skills: [],
        tools: [],
        extensions: [],
      }),
    );

    const classifier = createClassifier();
    const [, plan] = await classifier.classifyWithPlan('What port does the API use?');

    expect(plan.memoryTypes).toEqual(['episodic', 'semantic']);
    expect(plan.modalities).toEqual(['text']);
    expect(plan.sources.multimodal).toBe(false);
  });

  it('falls back to sane defaults for malformed boolean and numeric plan metadata', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'The model returned malformed plan metadata.',
        strategy: 'simple',
        tier: 1,
        confidence: 0.82,
        internal_knowledge_sufficient: 'yes',
        suggested_sources: ['vector'],
        tools_needed: [],
        sources: {
          vector: 'yes',
          bm25: 1,
          graph: 'no',
          raptor: 'no',
          memory: 'yes',
          multimodal: 'yes',
        },
        hyde: {
          enabled: 'no',
          hypothesisCount: -3,
        },
        temporal: {
          preferRecent: 'yes',
          recencyBoost: -5,
          maxAgeMs: 'never',
        },
        graphConfig: {
          maxDepth: -4,
          minEdgeWeight: 3,
        },
        raptorLayers: ['bad', -1, 1.9, 1, 2],
        deepResearch: 'no',
        requires_external_calls: 'yes',
        skills: [],
        tools: [],
        extensions: [],
      }),
    );

    const classifier = createClassifier();
    const [classification, plan] = await classifier.classifyWithPlan('What port does the API use?');

    expect(classification.internalKnowledgeSufficient).toBe(false);
    expect(plan.sources).toEqual({
      vector: true,
      bm25: true,
      graph: false,
      raptor: false,
      memory: true,
      multimodal: false,
    });
    expect(plan.hyde).toEqual({ enabled: false, hypothesisCount: 0 });
    expect(plan.temporal).toEqual({
      preferRecent: false,
      recencyBoost: 1,
      maxAgeMs: null,
    });
    expect(plan.graphConfig).toEqual({ maxDepth: 0, minEdgeWeight: 1 });
    expect(plan.raptorLayers).toEqual([1, 2]);
    expect(plan.deepResearch).toBe(false);
    expect(plan.requiresExternalCalls).toBe(true);
    expect(plan.internalKnowledgeSufficient).toBe(false);
  });

  it('complex queries recommend more capabilities than simple ones', async () => {
    // Simple query — no capabilities
    mockGenerateText.mockResolvedValueOnce(
      mockPlanLlmResponse({
        thinking: 'Simple greeting.',
        strategy: 'none',
        tier: 0,
        confidence: 0.95,
        internal_knowledge_sufficient: true,
        suggested_sources: [],
        tools_needed: [],
        skills: [],
        tools: [],
        extensions: [],
        requires_external_calls: false,
      }),
    );

    const classifier = createClassifier();
    const [, simplePlan] = await classifier.classifyWithPlan('Hello!');

    // Complex query — multiple capabilities
    mockGenerateText.mockResolvedValueOnce(
      mockPlanLlmResponse({
        thinking: 'Complex research with multiple tools needed.',
        strategy: 'complex',
        tier: 3,
        confidence: 0.85,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector', 'graph', 'research'],
        tools_needed: ['webSearch', 'generateImage'],
        skills: [
          { skillId: 'deep-research', reasoning: 'needs research', confidence: 0.9, priority: 0 },
          { skillId: 'web-search', reasoning: 'needs web data', confidence: 0.85, priority: 1 },
        ],
        tools: [
          { toolId: 'webSearch', reasoning: 'web tool', confidence: 0.9, priority: 0 },
        ],
        extensions: [
          { extensionId: 'browser-automation', reasoning: 'scraping', confidence: 0.7, priority: 0 },
        ],
        requires_external_calls: true,
      }),
    );

    const [, complexPlan] = await classifier.classifyWithPlan(
      'Research all RAG techniques, compare them, and create a visual summary',
    );

    const simpleTotal = simplePlan.skills.length + simplePlan.tools.length + simplePlan.extensions.length;
    const complexTotal = complexPlan.skills.length + complexPlan.tools.length + complexPlan.extensions.length;

    expect(complexTotal).toBeGreaterThan(simpleTotal);
  });
});

// ============================================================================
// QueryClassifier.setCapabilityDiscoveryEngine
// ============================================================================

describe('QueryClassifier.setCapabilityDiscoveryEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('can attach and detach a discovery engine', () => {
    const classifier = createClassifier();

    // Initially null
    expect(classifier.getCapabilityDiscoveryEngine()).toBeNull();

    // Create a mock discovery engine
    const mockEngine = {
      isInitialized: vi.fn().mockReturnValue(true),
      getTier0SummariesByKind: vi.fn().mockReturnValue({
        skills: 'Available: web-search, coding-agent',
        tools: 'Available: generateImage, webSearch',
        extensions: 'Available: browser-automation',
      }),
    } as unknown as import('../../../../cognition/discovery/CapabilityDiscoveryEngine.js').CapabilityDiscoveryEngine;

    classifier.setCapabilityDiscoveryEngine(mockEngine);
    expect(classifier.getCapabilityDiscoveryEngine()).toBe(mockEngine);

    // Detach
    classifier.setCapabilityDiscoveryEngine(null);
    expect(classifier.getCapabilityDiscoveryEngine()).toBeNull();
  });

  it('injects Tier 0 summaries into the plan prompt when engine is attached', async () => {
    const mockEngine = {
      isInitialized: vi.fn().mockReturnValue(true),
      getTier0SummariesByKind: vi.fn().mockReturnValue({
        skills: 'Skills: web-search (information), coding-agent (developer)',
        tools: 'Tools: generateImage (creative), webSearch (information)',
        extensions: 'Extensions: browser-automation (automation)',
      }),
    } as unknown as import('../../../../cognition/discovery/CapabilityDiscoveryEngine.js').CapabilityDiscoveryEngine;

    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'Using discovered capabilities.',
        strategy: 'simple',
        tier: 1,
        confidence: 0.85,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: [],
      }),
    );

    const classifier = createClassifier();
    classifier.setCapabilityDiscoveryEngine(mockEngine);

    await classifier.classifyWithPlan('Find recent AI papers', undefined, {
      excludedCapabilityIds: ['research-skill'],
    });

    // Verify the system prompt includes the summaries
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockEngine.getTier0SummariesByKind).toHaveBeenCalledWith(['research-skill']);
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.system).toContain('Skills: web-search (information)');
    expect(callArgs.system).toContain('Tools: generateImage (creative)');
    expect(callArgs.system).toContain('Extensions: browser-automation (automation)');
  });

  it('uses fallback text when no discovery engine is attached', async () => {
    mockGenerateText.mockResolvedValue(
      mockPlanLlmResponse({
        thinking: 'No discovery engine.',
        strategy: 'simple',
        tier: 1,
        confidence: 0.85,
        internal_knowledge_sufficient: false,
        suggested_sources: ['vector'],
        tools_needed: [],
      }),
    );

    const classifier = createClassifier();
    // No engine attached

    await classifier.classifyWithPlan('What is the API port?');

    const callArgs = mockGenerateText.mock.calls[0][0];
    // Skill summaries still use the default fallback text (not replaced by catalog)
    expect(callArgs.system).toContain('No skill categories available.');
    // Tool and extension summaries fall back to the capability catalog.
    // When the catalog package is loadable, they contain category-grouped entries.
    // When the catalog package is not installed (test environment), they fall back
    // to "Not available". Either way, "No tool categories available." is replaced.
    expect(callArgs.system).not.toContain('No tool categories available.');
    expect(callArgs.system).not.toContain('No extension categories available.');
  });
});
