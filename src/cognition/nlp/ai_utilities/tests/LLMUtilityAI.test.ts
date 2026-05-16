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
