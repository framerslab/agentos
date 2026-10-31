/**
 * @fileoverview Tests for LLMUtilityAI.analyzeSentiment — validates parsing of
 * structured sentiment JSON from the mocked LLM provider for positive and
 * negative inputs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMUtilityAI, LLMUtilityAIConfig } from '../LLMUtilityAI';
import type { IUtilityAI } from '../IUtilityAI';
import type { AIModelProviderManager } from '../../../../core/llm/providers/AIModelProviderManager';
import type { IProvider, ModelCompletionResponse } from '../../../../core/llm/providers/IProvider';

const mockProvider: IProvider = {
  providerId: 'mock-llm-provider',
  isInitialized: true,
  initialize: vi.fn().mockResolvedValue(undefined),
  generateCompletion: vi.fn().mockResolvedValue(<ModelCompletionResponse>{
    id: 'cmp-1', object: 'chat.completion', created: Date.now(), modelId: 'default-llm-model',
    choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, text: '{}', finishReason: 'stop' }],
    usage: { totalTokens: 10 },
  }),
  generateCompletionStream: vi.fn().mockImplementation(async function* () {
    yield { id: 'cmp-s', object: 'chat.completion.chunk', created: Date.now(), modelId: 'default-llm-model', responseTextDelta: '', isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finishReason: 'stop' }], usage: { totalTokens: 1 } } as ModelCompletionResponse;
  }),
  generateEmbeddings: vi.fn().mockResolvedValue({ object: 'list', data: [], model: 'embed-model', usage: { prompt_tokens: 0, total_tokens: 0 } }),
  listAvailableModels: vi.fn().mockResolvedValue([]),
  getModelInfo: vi.fn().mockResolvedValue({ modelId: 'default-llm-model', providerId: 'mock-llm-provider', capabilities: ['chat'], supportsStreaming: true }),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

const mockLlmProviderManager: AIModelProviderManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  getProvider: vi.fn().mockReturnValue(mockProvider),
  listProviderIds: vi.fn().mockReturnValue(['mock-llm-provider']),
  checkHealth: vi.fn().mockResolvedValue({ isOverallHealthy: true, providerStatus: { 'mock-llm-provider': { isHealthy: true } } }),
  shutdownAll: vi.fn().mockResolvedValue(undefined),
} as any;

const defaultConfig: LLMUtilityAIConfig = {
  utilityId: 'test-llm-sentiment',
  llmProviderManager: mockLlmProviderManager,
  defaultModelId: 'default-llm-model',
  defaultProviderId: 'mock-llm-provider',
};

describe('LLMUtilityAI — analyzeSentiment', () => {
  let llmUtility: IUtilityAI;

  beforeEach(async () => {
    vi.clearAllMocks();
    llmUtility = new LLMUtilityAI();
    await llmUtility.initialize(defaultConfig);
  });

  it('parses structured positive sentiment JSON from LLM', async () => {
    const sentimentJson = JSON.stringify({
      score: 0.85,
      polarity: 'positive',
      intensity: 0.8,
      positiveTokens: ['wonderful', 'amazing', 'love'],
      negativeTokens: [],
    });

    (mockProvider.generateCompletion as any).mockResolvedValueOnce(<ModelCompletionResponse>{
      id: 'cmp-sent-pos', object: 'chat.completion', created: Date.now(), modelId: 'default-llm-model',
      choices: [{ index: 0, message: { role: 'assistant', content: sentimentJson }, text: sentimentJson, finishReason: 'stop' }],
      usage: { totalTokens: 40 },
    });

    const result = await llmUtility.analyzeSentiment('This is wonderful and amazing, I love it so much');

    expect(result.score).toBe(0.85);
    expect(result.polarity).toBe('positive');
    expect(result.intensity).toBe(0.8);
    expect(Array.isArray(result.positiveTokens)).toBe(true);
    expect(result.positiveTokens!.length).toBeGreaterThan(0);
    expect(result.negativeTokens).toEqual([]);
  });

  it('parses structured negative sentiment JSON from LLM', async () => {
    const sentimentJson = JSON.stringify({
      score: -0.75,
      polarity: 'negative',
      intensity: 0.7,
      positiveTokens: [],
      negativeTokens: ['terrible', 'awful', 'hate'],
    });

    (mockProvider.generateCompletion as any).mockResolvedValueOnce(<ModelCompletionResponse>{
      id: 'cmp-sent-neg', object: 'chat.completion', created: Date.now(), modelId: 'default-llm-model',
      choices: [{ index: 0, message: { role: 'assistant', content: sentimentJson }, text: sentimentJson, finishReason: 'stop' }],
      usage: { totalTokens: 40 },
    });

    const result = await llmUtility.analyzeSentiment('This is terrible and awful, I hate everything');

    expect(result.score).toBe(-0.75);
    expect(result.polarity).toBe('negative');
    expect(result.intensity).toBe(0.7);
    expect(result.positiveTokens).toEqual([]);
    expect(Array.isArray(result.negativeTokens)).toBe(true);
    expect(result.negativeTokens!.length).toBeGreaterThan(0);
  });

  it('fills in defaults for optional sentiment fields', async () => {
    const minimalJson = JSON.stringify({
      score: 0.1,
      polarity: 'neutral',
    });

    (mockProvider.generateCompletion as any).mockResolvedValueOnce(<ModelCompletionResponse>{
      id: 'cmp-sent-min', object: 'chat.completion', created: Date.now(), modelId: 'default-llm-model',
      choices: [{ index: 0, message: { role: 'assistant', content: minimalJson }, text: minimalJson, finishReason: 'stop' }],
      usage: { totalTokens: 20 },
    });

    const result = await llmUtility.analyzeSentiment('The table is in the room.');

    expect(result.score).toBe(0.1);
    expect(result.polarity).toBe('neutral');
    // The implementation defaults comparative to score and intensity to abs(score)
    expect(result.comparative).toBe(0.1);
    expect(result.intensity).toBeCloseTo(0.1);
    expect(result.positiveTokens).toEqual([]);
    expect(result.negativeTokens).toEqual([]);
  });

  it('reads a sentiment reply inside a Markdown code fence with no repair call', async () => {
    // claude-haiku-4-5's answer to the sentiment prompt.
    const fencedReply =
      '```json\n{\n  "score": 0.6,\n  "polarity": "positive",\n  "intensity": 0.6,\n  "positiveTokens": ["glad", "helpful"],\n  "negativeTokens": []\n}\n```';

    (mockProvider.generateCompletion as any).mockResolvedValueOnce(<ModelCompletionResponse>{
      id: 'cmp-sent-fenced', object: 'chat.completion', created: Date.now(), modelId: 'default-llm-model',
      choices: [{ index: 0, message: { role: 'assistant', content: fencedReply }, text: fencedReply, finishReason: 'stop' }],
      usage: { totalTokens: 60 },
    });

    const result = await llmUtility.analyzeSentiment('I am glad this was so helpful.');

    expect(result).toEqual({
      score: 0.6,
      polarity: 'positive',
      comparative: 0.6,
      intensity: 0.6,
      positiveTokens: [{ token: 'glad' }, { token: 'helpful' }],
      negativeTokens: [],
      neutralTokens: [],
    });
    expect(mockProvider.generateCompletion).toHaveBeenCalledTimes(1);
  });
});
