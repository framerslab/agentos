import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMUtilityAI, LLMUtilityAIConfig } from '../LLMUtilityAI';
import { IUtilityAI, SummarizationOptions } from '../IUtilityAI';
import { AIModelProviderManager } from '../../../../core/llm/providers/AIModelProviderManager';
import { IProvider, ChatMessage, ModelCompletionResponse } from '../../../../core/llm/providers/IProvider';
import { GMIError, GMIErrorCode } from '../../../../core/utils/errors.js';

// Updated mock provider aligned with new IProvider interface
const mockProvider: IProvider = {
  providerId: 'mock-llm-provider',
  isInitialized: true,
  initialize: vi.fn().mockResolvedValue(undefined),
  generateCompletion: vi.fn().mockResolvedValue(<ModelCompletionResponse>{
    id: 'cmp-1', object: 'chat.completion', created: Date.now(), modelId: 'default-llm-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Mocked LLM summary' }, text: 'Mocked LLM summary', finishReason: 'stop' }],
    usage: { totalTokens: 10 }
  }),
  generateCompletionStream: vi.fn().mockImplementation(async function* () {
    const base: Partial<ModelCompletionResponse> = { id: 'cmp-stream', object: 'chat.completion.chunk', created: Date.now(), modelId: 'default-llm-model' };
    yield { ...base, responseTextDelta: 'Mocked stream ', isFinal: false } as ModelCompletionResponse;
    yield { ...base, responseTextDelta: 'response.', isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finishReason: 'stop' }], usage: { totalTokens: 5 } } as ModelCompletionResponse;
  }),
  generateEmbeddings: vi.fn().mockResolvedValue({ object: 'list', data: [], model: 'embed-model', usage: { prompt_tokens: 0, total_tokens: 0 } }),
  listAvailableModels: vi.fn().mockResolvedValue([{ modelId: 'default-llm-model', providerId: 'mock-llm-provider', capabilities: ['chat'], supportsStreaming: true }]),
  getModelInfo: vi.fn().mockResolvedValue({ modelId: 'default-llm-model', providerId: 'mock-llm-provider', capabilities: ['chat'], supportsStreaming: true }),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined)
};

const mockLlmProviderManager: AIModelProviderManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  getProvider: vi.fn().mockReturnValue(mockProvider),
  listProviderIds: vi.fn().mockReturnValue(['mock-llm-provider']),
  checkHealth: vi.fn().mockResolvedValue({ isOverallHealthy: true, providerStatus: { 'mock-llm-provider': { isHealthy: true}}}),
  shutdownAll: vi.fn().mockResolvedValue(undefined),
} as any;

const defaultConfig: LLMUtilityAIConfig = {
  utilityId: 'test-llm-utility',
  llmProviderManager: mockLlmProviderManager,
  defaultModelId: 'default-llm-model',
  defaultProviderId: 'mock-llm-provider', // Optional if modelId implies it
};

describe('LLMUtilityAI', () => {
  let llmUtility: IUtilityAI;

  beforeEach(async () => {
    vi.clearAllMocks(); // Clear mocks before each test
    llmUtility = new LLMUtilityAI();
    await llmUtility.initialize(defaultConfig);
  });

  it('should be defined and initialize without errors', () => {
    expect(llmUtility).toBeDefined();
    expect(llmUtility.utilityId).toContain('llm-utility');
  });

  it('should call llmProviderManager for summarization', async () => {
    const textToSummarize = "This is a long text that needs summarization.";
    const options: SummarizationOptions = { method: 'abstractive_llm', desiredLength: 'short' };
    
    const summary = await llmUtility.summarize(textToSummarize, options);

    expect(summary).toBe('Mocked LLM summary');
    expect(mockProvider.generateCompletion).toHaveBeenCalled();
    const callArgs = (mockProvider.generateCompletion as any).mock.calls[0];
    expect(callArgs[0]).toBe(defaultConfig.defaultModelId);
    const messages: ChatMessage[] = callArgs[1];
    const aggregated = messages.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
    expect(aggregated).toContain(textToSummarize);
  });

  it('parseJsonSafe should parse valid JSON', async () => {
    const jsonString = '{ "key": "value", "number": 123 }';
    const result = await llmUtility.parseJsonSafe(jsonString);
    expect(result).toEqual({ key: 'value', number: 123 });
  });

  it('parseJsonSafe should attempt LLM fix for invalid JSON if configured', async () => {
    const invalidJsonString = '{ "key": "value", "number": 123'; // Missing closing brace
    const fixedJsonString = '{ "key": "value", "number": 123 }';
    
    // Mock the LLM call for fixing JSON
    (mockProvider.generateCompletion as any).mockResolvedValueOnce(<ModelCompletionResponse>{
      id: 'cmp-fix', object: 'chat.completion', created: Date.now(), modelId: 'json-fixer-model',
      choices: [{ index: 0, message: { role: 'assistant', content: fixedJsonString }, text: fixedJsonString, finishReason: 'stop' }],
      usage: { totalTokens: 5 }
    });

    const result = await llmUtility.parseJsonSafe(invalidJsonString, { 
      attemptFixWithLLM: true, 
      llmModelIdForFix: 'json-fixer-model' // This model would be configured
    });
    
    expect(result).toEqual({ key: 'value', number: 123 });
    expect(mockProvider.generateCompletion).toHaveBeenCalledWith(
      'json-fixer-model',
      expect.any(Array),
      expect.any(Object)
    );
  });

  // claude-haiku-4-5's answer to the sentiment prompt: the JSON inside a Markdown code fence.
  const fencedSentiment =
    '```json\n{\n  "score": 0.6,\n  "polarity": "positive",\n  "intensity": 0.6,\n  "positiveTokens": ["glad", "helpful"],\n  "negativeTokens": []\n}\n```';
  const sentiment = { score: 0.6, polarity: 'positive', intensity: 0.6, positiveTokens: ['glad', 'helpful'], negativeTokens: [] };

  it.each<[string, string, unknown]>([
    ['a json fence', fencedSentiment, sentiment],
    ['a fence with no language tag', '```\n{"ok": true}\n```', { ok: true }],
    ['a fence with words before and after it', 'Here is the analysis:\n\n```json\n{"ok": true}\n```\n\nThe text reads as positive.', { ok: true }],
    ['plain JSON whose string holds a fence', JSON.stringify({ note: '```json\n{"ok": true}\n```' }), { note: '```json\n{"ok": true}\n```' }],
  ])('parseJsonSafe reads %s with no repair call', async (_name, reply, expected) => {
    expect(await llmUtility.parseJsonSafe(reply, { attemptFixWithLLM: true })).toEqual(expected);
    expect(mockProvider.generateCompletion).not.toHaveBeenCalled();
  });

  it('parseJsonSafe reads a repair answered inside a code fence', async () => {
    vi.mocked(mockProvider.generateCompletion).mockResolvedValueOnce({
      id: 'reply-1', object: 'chat.completion', created: 1, modelId: 'model-1',
      choices: [{ index: 0, message: { role: 'assistant', content: '```json\n{"ok": true}\n```' }, finishReason: 'stop' }],
    });
    expect(await llmUtility.parseJsonSafe('{"ok": tr', { attemptFixWithLLM: true })).toEqual({ ok: true });
    expect(mockProvider.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it('parseJsonSafe answers null at once for a reply that opens a fence and never closes it', async () => {
    // A model that repeats itself up to its token limit. A pattern that backtracks over the run would not finish
    // within the test's time limit.
    const unclosed = '```json\n' + ' \n'.repeat(200_000) + 'x';
    expect(await llmUtility.parseJsonSafe(unclosed)).toBeNull();
  });

  it('keeps malformed input and repaired model text out of parsing diagnostics', async () => {
    const sentinel = 'sentinel-words-7731';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await llmUtility.parseJsonSafe(sentinel)).toBeNull();
      vi.mocked(mockProvider.generateCompletion).mockResolvedValueOnce({
        id: 'reply-1', object: 'chat.completion', created: 1, modelId: 'model-1',
        choices: [{ index: 0, message: { role: 'assistant', content: sentinel }, finishReason: 'stop' }],
      });
      expect(await llmUtility.parseJsonSafe(sentinel, { attemptFixWithLLM: true })).toBeNull();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('JSON parsing failed'), { textLength: sentinel.length });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to parse LLM-fixed JSON'), { textLength: sentinel.length });
      expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(sentinel);
    } finally {
      log.mockRestore(); warn.mockRestore(); error.mockRestore();
    }
  });

  it.each(['extractKeywords', 'detectLanguage'] as const)('logs only model text length when %s returns no array', async (method) => {
    const sentinel = 'sentinel-words-7731';
    const response = JSON.stringify({ text: sentinel });
    vi.mocked(mockProvider.generateCompletion).mockResolvedValueOnce({
      id: 'reply-1', object: 'chat.completion', created: 1, modelId: 'model-1',
      choices: [{ index: 0, message: { role: 'assistant', content: response }, finishReason: 'stop' }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await llmUtility[method](sentinel);
      expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('array'), { textLength: response.length });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
    } finally {
      warn.mockRestore();
    }
  });

  it('checkHealth should report as healthy if initialized and provider manager is healthy', async () => {
    const health = await llmUtility.checkHealth();
    expect(health.isHealthy).toBe(true);
    expect(health.details).toHaveProperty('status', 'Initialized');
    expect(health.dependencies?.[0].name).toBe('AIModelProviderManager');
    expect(health.dependencies?.[0].isHealthy).toBe(true);
  });

  it('should allow shutdown', async () => {
    await expect(llmUtility.shutdown?.()).resolves.toBeUndefined();
    // Add any assertions about state after shutdown if applicable
  });
});
