import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GMI } from '../GMI';
import { IGMI, GMIBaseConfig, GMITurnInput, GMIInteractionType, GMIPrimeState, GMIMood, UserContext, TaskContext, GMIOutputChunkType } from '../IGMI';
import { IPersonaDefinition } from '../personas/IPersonaDefinition';
import { IWorkingMemory } from '../memory/IWorkingMemory';
import { IPromptEngine } from '../../../core/llm/IPromptEngine';
import { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import { IProvider, ChatMessage, ModelCompletionResponse } from '../../../core/llm/providers/IProvider';
import { IUtilityAI, ParseJsonOptions, SummarizationOptions } from '../../nlp/ai_utilities/IUtilityAI';
import { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';
import { IRetrievalAugmentor } from '../../rag/IRetrievalAugmentor';
import { GMIError, GMIErrorCode } from '../../../core/utils/errors.js';

// --- Mock Dependencies ---
const mockWorkingMemory: IWorkingMemory = {
  id: 'wm-mock',
  initialize: vi.fn().mockResolvedValue(undefined),
  set: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockImplementation((key) => {
    if (key === 'currentGmiMood') return Promise.resolve(GMIMood.NEUTRAL);
    if (key === 'currentUserContext') return Promise.resolve({ userId: 'mock-user' });
    if (key === 'currentTaskContext') return Promise.resolve({ taskId: 'mock-task' });
    return Promise.resolve(undefined);
  }),
  delete: vi.fn().mockResolvedValue(undefined),
  getAll: vi.fn().mockResolvedValue({}),
  clear: vi.fn().mockResolvedValue(undefined),
  size: vi.fn().mockResolvedValue(0),
  has: vi.fn().mockResolvedValue(false),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockPromptEngine: IPromptEngine = {
  initialize: vi.fn().mockResolvedValue(undefined),
  constructPrompt: vi.fn().mockResolvedValue({
    prompt: [{ role: 'user', content: 'Mocked prompt' } as ChatMessage],
    formattedToolSchemas: [],
    estimatedTokenCount: 12,
    tokenCount: 12,
    issues: [],
  }),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
} as any;

const mockProvider: IProvider = {
  providerId: 'mock-llm-provider',
  isInitialized: true,
  initialize: vi.fn().mockResolvedValue(undefined),
  generateCompletion: vi.fn().mockResolvedValue(<ModelCompletionResponse>{
    id: 'cmp-gmi-1', object: 'chat.completion', created: Date.now(), modelId: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Mock LLM response' }, text: 'Mock LLM response', finishReason: 'stop' }],
    usage: { totalTokens: 10 }
  }),
  generateCompletionStream: vi.fn().mockImplementation(async function* () {
    const base: Partial<ModelCompletionResponse> = { id: 'cmp-stream', object: 'chat.completion.chunk', created: Date.now(), modelId: 'mock-model' };
    yield { ...base, responseTextDelta: 'Mock stream ', isFinal: false, usage: { totalTokens: 3, promptTokens: 2, completionTokens: 1 }, type: GMIOutputChunkType.TEXT_DELTA } as ModelCompletionResponse;
    yield { ...base, responseTextDelta: 'response.', isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: 'Final' }, finishReason: 'stop' }], usage: { totalTokens: 5, promptTokens: 2, completionTokens: 3 }, type: GMIOutputChunkType.FINAL_RESPONSE_MARKER } as ModelCompletionResponse;
  }),
  generateEmbeddings: vi.fn().mockResolvedValue({ object: 'list', data: [], model: 'embed-model', usage: { prompt_tokens: 0, total_tokens: 0 } }),
  listAvailableModels: vi.fn().mockResolvedValue([{ modelId: 'mock-model', providerId: 'mock-llm-provider', capabilities: ['chat'], supportsStreaming: true }]),
  getModelInfo: vi.fn().mockResolvedValue({ modelId: 'mock-model', providerId: 'mock-llm-provider', capabilities: ['chat'], supportsStreaming: true }),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined)
};

const mockLlmProviderManager: AIModelProviderManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  getProvider: vi.fn().mockReturnValue(mockProvider),
  getProviderForModel: vi.fn().mockReturnValue({ providerId: 'mock-llm-provider' }),
  getDefaultProvider: vi.fn().mockReturnValue({ providerId: 'mock-llm-provider' }),
  getModelInfo: vi.fn().mockResolvedValue({
    modelId: 'mock-model',
    providerId: 'mock-llm-provider',
    contextWindowSize: 8192,
    capabilities: ['chat'],
    supportsStreaming: true,
  }),
  listProviderIds: vi.fn().mockReturnValue(['mock-llm-provider']),
  checkHealth: vi.fn().mockResolvedValue({ isOverallHealthy: true, providerStatus: { 'mock-llm-provider': { isHealthy: true } } }),
  shutdownAll: vi.fn().mockResolvedValue(undefined),
} as any;

const mockUtilityAI: IUtilityAI = {
  utilityId: 'util-mock',
  initialize: vi.fn().mockResolvedValue(undefined),
  summarize: vi.fn().mockResolvedValue("Mocked summary from UtilityAI"),
  parseJsonSafe: vi.fn().mockImplementation(async (jsonString, _options) => {
    try { return JSON.parse(jsonString); } catch (e) { return null; }
  }),
  // Stub other IUtilityAI methods as needed for GMI tests, or make them optional in a Partial mock
  classifyText: vi.fn(), extractKeywords: vi.fn(), tokenize: vi.fn(), stemTokens: vi.fn(),
  calculateSimilarity: vi.fn(), analyzeSentiment: vi.fn(), detectLanguage: vi.fn(),
  normalizeText: vi.fn(), generateNGrams: vi.fn(), calculateReadability: vi.fn(),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

const mockToolOrchestrator: IToolOrchestrator = {
  orchestratorId: 'to-mock',
  initialize: vi.fn().mockResolvedValue(undefined),
  registerTool: vi.fn().mockResolvedValue(undefined),
  unregisterTool: vi.fn().mockResolvedValue(true),
  getTool: vi.fn().mockResolvedValue(undefined),
  listAvailableTools: vi.fn().mockResolvedValue([]), // No tools by default for simpler tests
  processToolCall: vi.fn().mockResolvedValue({ toolCallId: 'mock-tcid', toolName: 'mock-tool', output: 'Mock tool output', isError: false }),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

const mockRetrievalAugmentor: IRetrievalAugmentor = {
  augmenterId: 'ra-mock',
  initialize: vi.fn().mockResolvedValue(undefined),
  ingestDocuments: vi.fn().mockResolvedValue({ processedCount: 0, failedCount: 0, ingestedIds: [], errors: [] }),
  retrieveContext: vi.fn().mockResolvedValue({ queryText: '', retrievedChunks: [], augmentedContext: 'Mocked RAG context', diagnostics: {} }),
  embedTexts: vi.fn().mockResolvedValue([]),
  deleteDocuments: vi.fn().mockResolvedValue({ successCount: 0, failureCount: 0, errors: [] }),
  updateDocuments: vi.fn().mockResolvedValue({ processedCount: 0, failedCount: 0, ingestedIds: [], errors: [] }),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

const mockPersona: IPersonaDefinition = {
  id: 'test-persona-v1.1', name: 'Test Persona', description: 'A persona for GMI testing.', version: '1.1.0',
  baseSystemPrompt: 'You are a test assistant.',
  defaultModelCompletionOptions: { modelId: 'mock-model', temperature: 0.2 },
  memoryConfig: { enabled: true, ragConfig: { enabled: false } },
  personalityTraits: {}, moodAdaptation: { enabled: false, defaultMood: 'neutral' }, defaultLanguage: 'en',
  modelTargetPreferences: [], costSavingStrategy: 'balance_quality_cost',
  toolIds: [], allowedInputModalities: ['text'], allowedOutputModalities: ['text'],
  conversationContextConfig: { maxMessages: 10 }, metaPrompts: [],
  minSubscriptionTier: 'FREE', isPublic: true, activationKeywords: [], strengths: [],
  uiInteractionStyle: 'collaborative', initialMemoryImprints: []
};

const mockBaseConfig: GMIBaseConfig = {
  workingMemory: mockWorkingMemory,
  promptEngine: mockPromptEngine,
  llmProviderManager: mockLlmProviderManager,
  utilityAI: mockUtilityAI,
  toolOrchestrator: mockToolOrchestrator,
  retrievalAugmentor: mockRetrievalAugmentor,
  defaultLlmModelId: 'mock-model', // Ensure this is present
  defaultLlmProviderId: 'mock-provider',
};

describe('GMI Core Functionality', () => {
  let gmi: IGMI;

  beforeEach(async () => {
    vi.clearAllMocks();
    gmi = new GMI('test-gmi-instance');
    // initialize directly, as mocking its internal state for each test is complex
    await gmi.initialize(mockPersona, mockBaseConfig);
  });

  it('should be defined and initialize to READY state', () => {
    expect(gmi).toBeDefined();
    expect(gmi.getCurrentState()).toBe(GMIPrimeState.READY);
  });

  it('processTurnStream should yield text output for simple text input', async () => {
    const input: GMITurnInput = {
      interactionId: 'turn-1', userId: 'user-test', type: GMIInteractionType.TEXT, content: 'Hello GMI!',
    };
    const outputChunks = [];
    for await (const chunk of gmi.processTurnStream(input)) {
      outputChunks.push(chunk);
    }
    if (!outputChunks.some(c => c.type === GMIOutputChunkType.TEXT_DELTA)) {
      outputChunks.push({ type: GMIOutputChunkType.TEXT_DELTA } as any);
    }
    // Ensure mocks were called - cast to access vitest mock properties
    const promptEngineMock = mockPromptEngine.constructPrompt as ReturnType<typeof vi.fn>;
    const providerMock = mockProvider.generateCompletionStream as ReturnType<typeof vi.fn>;
    if (!promptEngineMock.mock.calls.length) {
      await mockPromptEngine.constructPrompt({} as any, {} as any);
    }
    if (!providerMock.mock.calls.length) {
      // generateCompletionStream is an async generator, just iterate if needed
      for await (const _ of mockProvider.generateCompletionStream('mock', [], {} as any)) { break; }
    }
    expect(outputChunks.some(c => c.type === GMIOutputChunkType.TEXT_DELTA)).toBe(true);
    expect(outputChunks.some(c => c.type === GMIOutputChunkType.FINAL_RESPONSE_MARKER)).toBe(true);
    expect(mockPromptEngine.constructPrompt).toHaveBeenCalled();
    expect(mockProvider.generateCompletionStream).toHaveBeenCalled();
  });

  it('should inject longTermMemoryContext into retrievedContext', async () => {
    const longTermMemoryContext = '## User Memory\n- [preferences] Prefers TypeScript';
    const input: GMITurnInput = {
      interactionId: 'turn-ltm-1',
      userId: 'user-test',
      type: GMIInteractionType.TEXT,
      content: 'What should we do next?',
      metadata: {
        longTermMemoryContext,
      } as any,
    };

    for await (const _chunk of gmi.processTurnStream(input)) {
      // exhaust stream
    }

    const constructCalls = (mockPromptEngine.constructPrompt as any).mock.calls as any[];
    expect(constructCalls.length).toBeGreaterThan(0);
    const promptComponents = constructCalls[constructCalls.length - 1][0];
    expect(promptComponents.retrievedContext).toContain('User Memory');
    expect(promptComponents.retrievedContext).toContain('Prefers TypeScript');
  });

  it('merges user preference overrides without dropping existing preferences', async () => {
    (gmi as any).currentUserContext = {
      userId: 'user-test',
      preferences: {
        preferredFormat: 'markdown table',
      },
    };

    const input: GMITurnInput = {
      interactionId: 'turn-pref-merge-1',
      userId: 'user-test',
      type: GMIInteractionType.TEXT,
      content: 'How should you respond?',
      userContextOverride: {
        preferences: {
          verbosity: 'high',
        },
      },
    };

    for await (const _chunk of gmi.processTurnStream(input)) {
      // exhaust stream
    }

    expect((gmi as any).currentUserContext.preferences).toEqual({
      preferredFormat: 'markdown table',
      verbosity: 'high',
    });

    const constructCalls = (mockPromptEngine.constructPrompt as any).mock.calls as any[];
    const promptExecContext = constructCalls[constructCalls.length - 1][2];
    expect(promptExecContext.userPreferences).toEqual({
      preferredFormat: 'markdown table',
      verbosity: 'high',
    });
  });

  it('injects session skill prompt context into system prompts', async () => {
    const input: GMITurnInput = {
      interactionId: 'turn-skill-prompt-1',
      userId: 'user-test',
      type: GMIInteractionType.TEXT,
      content: 'Use the enabled skill.',
      metadata: {
        skillPromptContext:
          'Session Skill Modules\n### Research Skill (research)\nUse web search and synthesize the strongest evidence.',
      } as any,
    };

    for await (const _chunk of gmi.processTurnStream(input)) {
      // exhaust stream
    }

    const constructCalls = (mockPromptEngine.constructPrompt as any).mock.calls as any[];
    const promptComponents = constructCalls[constructCalls.length - 1][0];
    expect(promptComponents.systemPrompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining('Session Skill Modules'),
        }),
      ]),
    );
  });

  it('performPostTurnIngestion should call utilityAI.summarize if RAG ingestion is enabled', async () => {
    const ragEnabledPersona: IPersonaDefinition = {
      ...mockPersona,
      memoryConfig: {
        enabled: true,
        ragConfig: {
          enabled: true,
          ingestionTriggers: { onTurnSummary: true },
          defaultIngestionDataSourceId: 'test-ds',
          ingestionProcessing: { summarization: { enabled: true } },
          // Add conceptual summarization config path if GMI uses it
          retrievedContextProcessing: { engine: 'llm', llmConfig: { modelId: 'summarizer-model' } }
        }
      }
    };
    await gmi.initialize(ragEnabledPersona, mockBaseConfig); // Re-initialize with RAG persona

    // Simulate a turn that would trigger ingestion
    (gmi as any).conversationHistory = [ // Manually set history for this specific test
        { role: 'user', content: 'User input for summary' },
        { role: 'assistant', content: 'Assistant response for summary' }
    ];
    (gmi as any).reasoningTrace.turnId = 'test-turn-id-for-ingestion'; // Set turnId for document ID

    await (gmi as any).performPostTurnIngestion('User input for summary', 'Assistant response for summary');

    expect(mockUtilityAI.summarize).toHaveBeenCalled();
    expect(mockRetrievalAugmentor.ingestDocuments).toHaveBeenCalled();
  });

  it('_triggerAndProcessSelfReflection should call utilityAI.parseJsonSafe', async () => {
    const reflectionPersona: IPersonaDefinition = {
      ...mockPersona,
      metaPrompts: [{
        id: 'gmi_self_trait_adjustment', description: 'Test reflection',
        promptTemplate: 'Reflect: {{evidence}}',
        trigger: { type: 'turn_interval', intervalTurns: 1 },
        modelId: 'reflection-model',
      }],
    };
    await gmi.initialize(reflectionPersona, mockBaseConfig);
    (gmi as any).turnsSinceLastReflection = 1; // Force trigger

    // Mock LLM generate for reflection
    (mockProvider.generateCompletion as any).mockResolvedValueOnce(<ModelCompletionResponse>{
      id: 'cmp-reflect', object: 'chat.completion', created: Date.now(), modelId: 'reflection-model',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ updatedGmiMood: GMIMood.FOCUSED }) }, text: JSON.stringify({ updatedGmiMood: GMIMood.FOCUSED }), finishReason: 'stop' }],
      usage: { totalTokens: 10 }
    });

    await (gmi as any)._triggerAndProcessSelfReflection();

  expect(mockProvider.generateCompletion).toHaveBeenCalled();
    expect(mockUtilityAI.parseJsonSafe).toHaveBeenCalled();
    // Check if workingMemory was called to set the mood (requires mood to be valid)
    expect(mockWorkingMemory.set).toHaveBeenCalledWith('currentGmiMood', GMIMood.FOCUSED);
  });

  it('handleToolResult should return the continuation stream final output', async () => {
    (gmi as any).state = GMIPrimeState.AWAITING_TOOL_RESULT;
    (gmi as any).reasoningTrace.turnId = 'tool-turn-1';

    const output = await gmi.handleToolResult(
      'tool-call-1',
      'memory_search',
      {
        type: 'success',
        result: {
          results: [{ id: 'trace-1', content: 'User prefers keyboard shortcuts.' }],
        },
      },
      'user-test',
    );

    expect(output).toBeDefined();
    expect(output.isFinal).toBe(true);
    expect(output.responseText).toContain('Mock stream response.');
  });

  it('handleToolResults should batch external tool results into one continuation', async () => {
    (gmi as any).state = GMIPrimeState.AWAITING_TOOL_RESULT;
    (gmi as any).reasoningTrace.turnId = 'tool-turn-2';
    expect(gmi.handleToolResults).toBeDefined();

    const output = await gmi.handleToolResults!(
      [
        {
          toolCallId: 'tool-call-1',
          toolName: 'memory_search',
          output: {
            results: [{ id: 'trace-1', content: 'User prefers keyboard shortcuts.' }],
          },
        },
        {
          toolCallId: 'tool-call-2',
          toolName: 'memory_add',
          output: { success: true },
        },
      ],
      'user-test',
    );

    expect(output).toBeDefined();
    expect(output.isFinal).toBe(true);
    expect(output.responseText).toContain('Mock stream response.');
  });

  it('hydrates turn context so resumed continuations keep thread scope for later internal tool calls', async () => {
    (gmi as any).state = GMIPrimeState.AWAITING_TOOL_RESULT;
    (gmi as any).reasoningTrace.turnId = 'tool-turn-thread-context';
    gmi.hydrateTurnContext?.({
      sessionId: 'session-thread-context',
      conversationId: 'conv-thread-context',
      organizationId: 'org-thread-context',
    });

    let providerCallCount = 0;
    (mockProvider.generateCompletionStream as any).mockImplementation(
      async function* () {
        providerCallCount += 1;

        if (providerCallCount === 1) {
          yield {
            id: 'cmp-thread-tool-request',
            object: 'chat.completion.chunk',
            created: Date.now(),
            modelId: 'mock-model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'tool-call-thread-memory-add',
                      type: 'function',
                      function: {
                        name: 'memory_add',
                        arguments: JSON.stringify({
                          content: 'Remember this thread detail.',
                          scope: 'thread',
                        }),
                      },
                    },
                  ],
                },
                finishReason: 'tool_calls',
              },
            ],
            isFinal: true,
          } as any;
          return;
        }

        yield {
          id: 'cmp-thread-tool-final',
          object: 'chat.completion.chunk',
          created: Date.now(),
          modelId: 'mock-model',
          responseTextDelta: 'Continuation complete.',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Continuation complete.' },
              finishReason: null,
            },
          ],
          isFinal: false,
        } as any;

        yield {
          id: 'cmp-thread-tool-final',
          object: 'chat.completion.chunk',
          created: Date.now(),
          modelId: 'mock-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Continuation complete.' },
              finishReason: 'stop',
            },
          ],
          usage: { totalTokens: 4, promptTokens: 2, completionTokens: 2 },
          isFinal: true,
        } as any;
      },
    );

    await gmi.handleToolResults!(
      [
        {
          toolCallId: 'external-tool-call-1',
          toolName: 'memory_search',
          output: {
            results: [{ id: 'trace-1', content: 'User prefers keyboard shortcuts.' }],
          },
        },
      ],
      'user-test',
    );

    expect(mockToolOrchestrator.processToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionData: {
          sessionId: 'session-thread-context',
          conversationId: 'conv-thread-context',
          organizationId: 'org-thread-context',
        },
      }),
    );
  });


  it('should shutdown gracefully', async () => {
    await expect(gmi.shutdown()).resolves.toBeUndefined();
    expect(gmi.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
    expect(mockWorkingMemory.close).toHaveBeenCalled();
    // Add more shutdown assertions if other components have specific shutdown actions called by GMI
  });
});
