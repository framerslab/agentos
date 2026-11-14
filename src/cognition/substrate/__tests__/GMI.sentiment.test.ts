import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GMI } from '../GMI';
import {
  IGMI,
  GMIBaseConfig,
  GMITurnInput,
  GMIInteractionType,
  GMIPrimeState,
  GMIMood,
  GMIOutputChunkType,
} from '../IGMI';
import { IPersonaDefinition, SentimentTrackingConfig } from '../personas/IPersonaDefinition';
import { IWorkingMemory } from '../memory/IWorkingMemory';
import { IPromptEngine } from '../../../core/llm/IPromptEngine';
import { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import { IProvider, ChatMessage, ModelCompletionResponse } from '../../../core/llm/providers/IProvider';
import { IUtilityAI, SentimentResult } from '../../nlp/ai_utilities/IUtilityAI';
import { StatisticalUtilityAI } from '../../nlp/ai_utilities/StatisticalUtilityAI';
import { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';
import { IRetrievalAugmentor } from '../../rag/IRetrievalAugmentor';
import { GMIEventType, SentimentHistoryState } from '../GMIEvent';
import { resetLoggerFactory, setLogger } from '../../../core/logging/loggerFactory';
import { createConversationMessage, MessageRole } from '../../../core/conversation/ConversationMessage';
import {
  ALL_METAPROMPT_PRESETS,
  mergeMetapromptPresets,
  getPresetMetaprompt,
  isPresetMetaprompt,
} from '../personas/metaprompt_presets';

// --- Working Memory Mock with sentiment support ---
const createMockWorkingMemory = () => {
  const store = new Map<string, any>();
  return {
    id: 'wm-sentiment-mock',
    initialize: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockImplementation((key: string, value: any) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    get: vi.fn().mockImplementation((key: string) => {
      return Promise.resolve(store.get(key));
    }),
    delete: vi.fn().mockImplementation((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    getAll: vi.fn().mockImplementation(() => Promise.resolve(Object.fromEntries(store))),
    clear: vi.fn().mockImplementation(() => { store.clear(); return Promise.resolve(); }),
    size: vi.fn().mockImplementation(() => Promise.resolve(store.size)),
    has: vi.fn().mockImplementation((key: string) => Promise.resolve(store.has(key))),
    close: vi.fn().mockResolvedValue(undefined),
    _store: store, // Expose for test inspection
  };
};

// --- Sentiment-aware mock UtilityAI ---
const createMockUtilityAI = (sentimentOverride?: Partial<SentimentResult>) => ({
  utilityId: 'util-sentiment-mock',
  initialize: vi.fn().mockResolvedValue(undefined),
  summarize: vi.fn().mockResolvedValue('Mocked summary'),
  parseJsonSafe: vi.fn().mockImplementation(async (jsonString: string) => {
    try { return JSON.parse(jsonString); } catch { return null; }
  }),
  analyzeSentiment: vi.fn().mockResolvedValue({
    score: 0,
    polarity: 'neutral' as const,
    comparative: 0,
    intensity: 0,
    positiveTokens: [],
    negativeTokens: [],
    neutralTokens: [],
    ...sentimentOverride,
  }),
  classifyText: vi.fn(),
  extractKeywords: vi.fn(),
  tokenize: vi.fn(),
  stemTokens: vi.fn(),
  calculateSimilarity: vi.fn(),
  detectLanguage: vi.fn(),
  normalizeText: vi.fn(),
  generateNGrams: vi.fn(),
  calculateReadability: vi.fn(),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
});

// --- Other mock dependencies ---
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
  generateCompletion: vi.fn().mockResolvedValue({
    id: 'cmp-1', object: 'chat.completion', created: Date.now(), modelId: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Mock response' }, text: 'Mock response', finishReason: 'stop' }],
    usage: { totalTokens: 10 },
  } satisfies ModelCompletionResponse),
  generateCompletionStream: vi.fn().mockImplementation(async function* () {
    yield { responseTextDelta: 'Mock ', isFinal: false, type: GMIOutputChunkType.TEXT_DELTA, usage: { totalTokens: 3 } } as any;
    yield { responseTextDelta: 'response.', isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: 'Mock response.' }, finishReason: 'stop' }], type: GMIOutputChunkType.FINAL_RESPONSE_MARKER, usage: { totalTokens: 5 } } as any;
  }),
  generateEmbeddings: vi.fn().mockResolvedValue({ object: 'list', data: [], model: 'embed', usage: { prompt_tokens: 0, total_tokens: 0 } }),
  listAvailableModels: vi.fn().mockResolvedValue([]),
  getModelInfo: vi.fn().mockResolvedValue(undefined),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

const mockLlmProviderManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  getProvider: vi.fn().mockReturnValue(mockProvider),
  getProviderForModel: vi.fn().mockReturnValue(mockProvider),
  getModelInfo: vi.fn().mockReturnValue({
    modelId: 'mock-model',
    contextWindowSize: 4096,
    providerId: 'mock-llm-provider',
    capabilities: ['text_completion', 'tool_use'],
  }),
  listProviderIds: vi.fn().mockReturnValue(['mock-llm-provider']),
  completeChat: vi.fn().mockResolvedValue({ text: JSON.stringify({ adjustmentRationale: 'test', updatedGmiMood: 'EMPATHETIC' }), usage: { totalTokens: 10 } }),
  checkHealth: vi.fn().mockResolvedValue({ isOverallHealthy: true }),
  shutdownAll: vi.fn().mockResolvedValue(undefined),
} as any;

const mockToolOrchestrator: IToolOrchestrator = {
  orchestratorId: 'to-mock',
  initialize: vi.fn().mockResolvedValue(undefined),
  registerTool: vi.fn().mockResolvedValue(undefined),
  unregisterTool: vi.fn().mockResolvedValue(true),
  getTool: vi.fn().mockResolvedValue(undefined),
  listAvailableTools: vi.fn().mockResolvedValue([]),
  processToolCall: vi.fn().mockResolvedValue({ toolCallId: 'tc1', toolName: 'mock-tool', output: 'result', isError: false }),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

const mockRetrievalAugmentor: IRetrievalAugmentor = {
  augmenterId: 'ra-mock',
  initialize: vi.fn().mockResolvedValue(undefined),
  ingestDocuments: vi.fn().mockResolvedValue({ processedCount: 0, failedCount: 0, ingestedIds: [], errors: [] }),
  retrieveContext: vi.fn().mockResolvedValue({ queryText: '', retrievedChunks: [], augmentedContext: '', diagnostics: {} }),
  embedTexts: vi.fn().mockResolvedValue([]),
  deleteDocuments: vi.fn().mockResolvedValue({ successCount: 0, failureCount: 0, errors: [] }),
  updateDocuments: vi.fn().mockResolvedValue({ processedCount: 0, failedCount: 0, ingestedIds: [], errors: [] }),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

// --- Persona Factories ---
function createBasePersona(overrides?: Partial<IPersonaDefinition>): IPersonaDefinition {
  return {
    id: 'test-sentiment-persona',
    name: 'Sentiment Test Persona',
    description: 'A persona for sentiment testing.',
    version: '1.0.0',
    baseSystemPrompt: 'You are a test assistant.',
    defaultModelId: 'mock-model',
    defaultProviderId: 'mock-llm-provider',
    defaultModelCompletionOptions: { modelId: 'mock-model', temperature: 0.2 },
    memoryConfig: { enabled: true, ragConfig: { enabled: false } },
    personalityTraits: {},
    moodAdaptation: { enabled: false, defaultMood: 'neutral' },
    defaultLanguage: 'en',
    toolIds: [],
    allowedInputModalities: ['text'],
    allowedOutputModalities: ['text'],
    conversationContextConfig: { maxMessages: 10 },
    metaPrompts: [],
    isPublic: true,
    ...overrides,
  };
}

function createSentimentPersona(
  sentimentConfig: SentimentTrackingConfig,
  extraOverrides?: Partial<IPersonaDefinition>
): IPersonaDefinition {
  return createBasePersona({
    sentimentTracking: sentimentConfig,
    ...extraOverrides,
  });
}

// =====================================================
// TEST SUITES
// =====================================================

describe('Metaprompt Presets', () => {
  it('should define 5 preset metaprompts', () => {
    expect(ALL_METAPROMPT_PRESETS).toHaveLength(5);
    expect(ALL_METAPROMPT_PRESETS.map((p) => p.id)).toEqual([
      'gmi_frustration_recovery',
      'gmi_confusion_clarification',
      'gmi_satisfaction_reinforcement',
      'gmi_error_recovery',
      'gmi_engagement_boost',
    ]);
  });

  it('should have event_based triggers on all presets', () => {
    for (const preset of ALL_METAPROMPT_PRESETS) {
      expect(preset.trigger).toBeDefined();
      expect(preset.trigger!.type).toBe('event_based');
    }
  });

  it('getPresetMetaprompt should return preset by id', () => {
    const preset = getPresetMetaprompt('gmi_frustration_recovery');
    expect(preset).toBeDefined();
    expect(preset!.id).toBe('gmi_frustration_recovery');
  });

  it('getPresetMetaprompt should return undefined for unknown id', () => {
    expect(getPresetMetaprompt('nonexistent')).toBeUndefined();
  });

  it('isPresetMetaprompt should correctly identify presets', () => {
    expect(isPresetMetaprompt('gmi_frustration_recovery')).toBe(true);
    expect(isPresetMetaprompt('gmi_self_trait_adjustment')).toBe(false);
    expect(isPresetMetaprompt('custom_prompt')).toBe(false);
  });

  describe('mergeMetapromptPresets', () => {
    it('should return all presets when no persona metaprompts provided', () => {
      const merged = mergeMetapromptPresets();
      expect(merged).toHaveLength(5);
    });

    it('should merge persona metaprompts with presets', () => {
      const personaMetaPrompts = [
        { id: 'custom_prompt', promptTemplate: 'custom', trigger: { type: 'manual' as const } },
      ];
      const merged = mergeMetapromptPresets(personaMetaPrompts);
      expect(merged).toHaveLength(6); // 5 presets + 1 custom
    });

    it('should allow persona to override presets with same ID', () => {
      const personaMetaPrompts = [
        {
          id: 'gmi_frustration_recovery',
          promptTemplate: 'Custom frustration handler',
          trigger: { type: 'event_based' as const, eventName: 'user_frustrated' },
          temperature: 0.9, // Override
        },
      ];
      const merged = mergeMetapromptPresets(personaMetaPrompts);
      const frustrationPreset = merged.find((m) => m.id === 'gmi_frustration_recovery');
      expect(frustrationPreset!.temperature).toBe(0.9); // Should be persona's override
      expect(merged).toHaveLength(5); // Still 5 (replaced, not added)
    });

    it('should filter presets when includePresets is specified', () => {
      const merged = mergeMetapromptPresets([], ['gmi_frustration_recovery', 'gmi_error_recovery']);
      expect(merged).toHaveLength(2);
      expect(merged.map((m) => m.id)).toEqual(['gmi_frustration_recovery', 'gmi_error_recovery']);
    });
  });
});

describe('GMI Sentiment Tracking Config', () => {
  let mockWorkingMemory: ReturnType<typeof createMockWorkingMemory>;
  let mockUtilityAI: ReturnType<typeof createMockUtilityAI>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkingMemory = createMockWorkingMemory();
    mockUtilityAI = createMockUtilityAI();
  });

  function createConfig(): GMIBaseConfig {
    return {
      workingMemory: mockWorkingMemory as any,
      promptEngine: mockPromptEngine,
      llmProviderManager: mockLlmProviderManager,
      utilityAI: mockUtilityAI as any,
      toolOrchestrator: mockToolOrchestrator,
      retrievalAugmentor: mockRetrievalAugmentor,
      defaultLlmModelId: 'mock-model',
      defaultLlmProviderId: 'mock-provider',
    };
  }

  it('should NOT run sentiment analysis when sentimentTracking is undefined', async () => {
    const persona = createBasePersona(); // No sentimentTracking
    const gmi = new GMI('test-no-sentiment');
    await gmi.initialize(persona, createConfig());

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'I am very frustrated!',
    };

    // Consume the stream
    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    // analyzeSentiment should NOT have been called
    expect(mockUtilityAI.analyzeSentiment).not.toHaveBeenCalled();
  });

  it('should NOT run sentiment analysis when sentimentTracking.enabled is false', async () => {
    const persona = createSentimentPersona({ enabled: false });
    const gmi = new GMI('test-disabled-sentiment');
    await gmi.initialize(persona, createConfig());

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'I am very frustrated!',
    };

    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    expect(mockUtilityAI.analyzeSentiment).not.toHaveBeenCalled();
  });

  it('should run sentiment analysis when sentimentTracking.enabled is true', async () => {
    const persona = createSentimentPersona({ enabled: true, method: 'lexicon_based' });
    const gmi = new GMI('test-enabled-sentiment');
    await gmi.initialize(persona, createConfig());

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'Hello, how are you?',
    };

    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    expect(mockUtilityAI.analyzeSentiment).toHaveBeenCalledWith(
      'Hello, how are you?',
      expect.objectContaining({ method: 'lexicon_based' })
    );
  });

  it('should use LLM method when configured', async () => {
    const persona = createSentimentPersona({
      enabled: true,
      method: 'llm',
      modelId: 'custom-sentiment-model',
      providerId: 'custom-provider',
    });
    const gmi = new GMI('test-llm-sentiment');
    await gmi.initialize(persona, createConfig());

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'This is confusing',
    };

    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    expect(mockUtilityAI.analyzeSentiment).toHaveBeenCalledWith(
      'This is confusing',
      expect.objectContaining({
        method: 'llm',
        modelId: 'custom-sentiment-model',
        providerId: 'custom-provider',
      })
    );
  });

  it('should update UserContext.currentSentiment after analysis', async () => {
    const negativeMockUtility = createMockUtilityAI({
      score: -0.6,
      polarity: 'negative',
      intensity: 0.7,
    });

    const persona = createSentimentPersona({ enabled: true });
    const config = { ...createConfig(), utilityAI: negativeMockUtility as any };
    const gmi = new GMI('test-sentiment-update');
    await gmi.initialize(persona, config);

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'This is terrible!',
    };

    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    // Check working memory was updated with sentiment
    const setCall = (mockWorkingMemory.set as any).mock.calls.find(
      (c: any[]) => c[0] === 'currentUserContext'
    );
    // Should have been called (there may be multiple calls)
    expect(setCall).toBeDefined();
  });

  it('should store sentiment history in working memory', async () => {
    const negativeMockUtility = createMockUtilityAI({
      score: -0.5,
      polarity: 'negative',
      intensity: 0.6,
    });

    const persona = createSentimentPersona({ enabled: true });
    const wm = createMockWorkingMemory();
    const config = { ...createConfig(), workingMemory: wm as any, utilityAI: negativeMockUtility as any };
    const gmi = new GMI('test-sentiment-history');
    await gmi.initialize(persona, config);

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'I hate this!',
    };

    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    // Check that gmi_sentiment_history was stored
    const history = wm._store.get('gmi_sentiment_history') as SentimentHistoryState | undefined;
    expect(history).toBeDefined();
    expect(history!.trends).toHaveLength(1);
    expect(history!.trends[0].score).toBe(-0.5);
    expect(history!.trends[0].polarity).toBe('negative');
    expect(history!.consecutiveFrustration).toBe(1);
  });
});

describe('GMI Event Detection', () => {
  let wm: ReturnType<typeof createMockWorkingMemory>;

  beforeEach(() => {
    vi.clearAllMocks();
    wm = createMockWorkingMemory();
  });

  function createConfig(utilityAI: any): GMIBaseConfig {
    return {
      workingMemory: wm as any,
      promptEngine: mockPromptEngine,
      llmProviderManager: mockLlmProviderManager,
      utilityAI: utilityAI as any,
      toolOrchestrator: mockToolOrchestrator,
      retrievalAugmentor: mockRetrievalAugmentor,
      defaultLlmModelId: 'mock-model',
      defaultLlmProviderId: 'mock-provider',
    };
  }

  it('should emit USER_FRUSTRATED event on negative sentiment', async () => {
    const negativeUtility = createMockUtilityAI({
      score: -0.5,
      polarity: 'negative',
      intensity: 0.8,
    });

    const persona = createSentimentPersona({ enabled: true });
    const gmi = new GMI('test-frustration-event');
    await gmi.initialize(persona, createConfig(negativeUtility));

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'This is so frustrating!',
    };

    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    // Check internal event was emitted by checking eventHistory
    const eventHistory = (gmi as any).sentimentTracker.events as Array<{ eventType: GMIEventType }>;
    expect(eventHistory.some((e) => e.eventType === GMIEventType.USER_FRUSTRATED)).toBe(true);
  });

  it('should emit USER_CONFUSED event on confusion keywords', async () => {
    const neutralUtility = createMockUtilityAI({
      score: -0.1,
      polarity: 'neutral',
      intensity: 0.3,
    });

    const persona = createSentimentPersona({ enabled: true });
    const gmi = new GMI('test-confusion-event');
    await gmi.initialize(persona, createConfig(neutralUtility));

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: "I don't understand what you mean",
    };

    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    const eventHistory = (gmi as any).sentimentTracker.events as Array<{ eventType: GMIEventType }>;
    expect(eventHistory.some((e) => e.eventType === GMIEventType.USER_CONFUSED)).toBe(true);
  });

  it('should emit USER_SATISFIED event on positive sentiment', async () => {
    const positiveUtility = createMockUtilityAI({
      score: 0.7,
      polarity: 'positive',
      intensity: 0.8,
    });

    const persona = createSentimentPersona({ enabled: true });
    const gmi = new GMI('test-satisfaction-event');
    await gmi.initialize(persona, createConfig(positiveUtility));

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'That worked perfectly, thanks!',
    };

    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    const eventHistory = (gmi as any).sentimentTracker.events as Array<{ eventType: GMIEventType }>;
    expect(eventHistory.some((e) => e.eventType === GMIEventType.USER_SATISFIED)).toBe(true);
  });

  it('should NOT emit frustration event when score is above threshold', async () => {
    const mildNegativeUtility = createMockUtilityAI({
      score: -0.1, // Above default threshold of -0.3
      polarity: 'neutral',
      intensity: 0.2,
    });

    const persona = createSentimentPersona({ enabled: true });
    const gmi = new GMI('test-no-frustration');
    await gmi.initialize(persona, createConfig(mildNegativeUtility));

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'Hmm, okay.',
    };

    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    const eventHistory = (gmi as any).sentimentTracker.events as Array<{ eventType: GMIEventType }>;
    expect(eventHistory.some((e) => e.eventType === GMIEventType.USER_FRUSTRATED)).toBe(false);
  });

  it('should respect custom frustration threshold', async () => {
    const mildNegativeUtility = createMockUtilityAI({
      score: -0.15,
      polarity: 'negative',
      intensity: 0.7,
    });

    // Custom lower threshold that catches mild negativity
    const persona = createSentimentPersona({
      enabled: true,
      frustrationThreshold: -0.1, // Lower threshold
    });
    const gmi = new GMI('test-custom-threshold');
    await gmi.initialize(persona, createConfig(mildNegativeUtility));

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'This is a bit annoying.',
    };

    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    const eventHistory = (gmi as any).sentimentTracker.events as Array<{ eventType: GMIEventType }>;
    expect(eventHistory.some((e) => e.eventType === GMIEventType.USER_FRUSTRATED)).toBe(true);
  });
});

describe('GMI Metaprompt Trigger System', () => {
  let wm: ReturnType<typeof createMockWorkingMemory>;

  beforeEach(() => {
    vi.clearAllMocks();
    wm = createMockWorkingMemory();
  });

  function createConfig(utilityAI: any): GMIBaseConfig {
    return {
      workingMemory: wm as any,
      promptEngine: mockPromptEngine,
      llmProviderManager: mockLlmProviderManager,
      utilityAI: utilityAI as any,
      toolOrchestrator: mockToolOrchestrator,
      retrievalAugmentor: mockRetrievalAugmentor,
      defaultLlmModelId: 'mock-model',
      defaultLlmProviderId: 'mock-provider',
    };
  }

  it('turn_interval metaprompts should still work WITHOUT sentimentTracking', async () => {
    const persona = createBasePersona({
      metaPrompts: [{
        id: 'gmi_self_trait_adjustment',
        description: 'Self-reflection every turn',
        promptTemplate: 'Reflect: {{evidence}}',
        trigger: { type: 'turn_interval', intervalTurns: 1 },
        modelId: 'mock-model',
      }],
    });

    const neutralUtility = createMockUtilityAI();
    const gmi = new GMI('test-turn-interval');
    await gmi.initialize(persona, createConfig(neutralUtility));

    // Each user turn increments the counter; the metaprompt fires when the
    // counter reaches intervalTurns, then the counter resets. Tool
    // continuations and system turns do not count. With intervalTurns=1 it
    // fires on every user turn.

    // Process first turn (counter reaches 1, fires)
    const input1: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'Hello',
    };
    for await (const _chunk of gmi.processTurnStream(input1)) { /* consume */ }

    // Process second turn (fires again)
    const input2: GMITurnInput = {
      interactionId: 'turn-2',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'How are you?',
    };
    for await (const _chunk of gmi.processTurnStream(input2)) { /* consume */ }

    // Should NOT have called analyzeSentiment (no sentimentTracking config)
    expect(neutralUtility.analyzeSentiment).not.toHaveBeenCalled();

    // But should have triggered the turn-interval metaprompt
    const trace = (gmi as any).reasoningTrace;
    const reflectionEntry = trace.entries.find(
      (e: any) => e.type === 'SELF_REFLECTION_TRIGGERED'
    );
    expect(reflectionEntry).toBeDefined();
  });

  it('event_based metaprompt should trigger on matching event', async () => {
    const negativeUtility = createMockUtilityAI({
      score: -0.6,
      polarity: 'negative',
      intensity: 0.8,
    });

    const frustrationPreset = getPresetMetaprompt('gmi_frustration_recovery')!;

    const persona = createSentimentPersona(
      { enabled: true, presets: ['frustration_recovery'] },
      {
        metaPrompts: [frustrationPreset],
      }
    );

    const gmi = new GMI('test-event-trigger');
    await gmi.initialize(persona, createConfig(negativeUtility));

    // Verify persona has the metaprompt
    const activePersona = (gmi as any).activePersona;
    expect(activePersona.metaPrompts).toBeDefined();
    expect(activePersona.metaPrompts.length).toBeGreaterThan(0);
    expect(activePersona.metaPrompts[0].trigger.type).toBe('event_based');
    expect(activePersona.metaPrompts[0].trigger.eventName).toBe(GMIEventType.USER_FRUSTRATED);

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'This is so frustrating I hate it!',
    };

    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    // Verify event was emitted to history (diagnostic check)
    const eventHistory = (gmi as any).sentimentTracker.events;
    expect(eventHistory.some((e: any) => e.eventType === GMIEventType.USER_FRUSTRATED)).toBe(true);

    // Verify the reasoning trace shows the metaprompt was triggered
    const trace = (gmi as any).reasoningTrace;
    const triggerEntry = trace.entries.find(
      (e: any) => e.type === 'SELF_REFLECTION_TRIGGERED'
    );
    // If metaprompt triggered, it should have logged this
    expect(triggerEntry).toBeDefined();
  });

  it('manual trigger should activate when flag set in working memory', async () => {
    const persona = createBasePersona({
      metaPrompts: [{
        id: 'gmi_manual_test',
        description: 'Manual trigger test',
        promptTemplate: 'Manual: {{recent_conversation}}',
        trigger: { type: 'manual' },
        modelId: 'mock-model',
        providerId: 'mock-llm-provider',
      }],
    });

    const neutralUtility = createMockUtilityAI();
    const gmi = new GMI('test-manual-trigger');
    await gmi.initialize(persona, createConfig(neutralUtility));

    // Set the manual trigger flag via the GMI's working memory interface
    const gmiWorkingMemory = (gmi as any).workingMemory;
    await gmiWorkingMemory.set('manual_trigger_gmi_manual_test', true);

    // Verify it was set
    const flagBeforeProcess = await gmiWorkingMemory.get('manual_trigger_gmi_manual_test');
    expect(flagBeforeProcess).toBe(true);

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content: 'Test input',
    };

    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    // Flag should be consumed after checkAndTriggerMetaprompts runs
    const flagAfterProcess = await gmiWorkingMemory.get('manual_trigger_gmi_manual_test');
    expect(flagAfterProcess).toBeUndefined();
  });
});

describe('PersonaLoader Sentiment Config Integration', () => {
  it('should not merge presets when sentimentTracking is not configured', () => {
    // Simulate PersonaLoader behavior
    const persona = createBasePersona({ metaPrompts: [] });

    // Without sentimentTracking, metaPrompts should remain empty
    expect(persona.metaPrompts).toEqual([]);
    expect(persona.sentimentTracking).toBeUndefined();
  });

  it('should only merge requested presets when specific presets are listed', () => {
    const merged = mergeMetapromptPresets(
      [], // No custom metaprompts
      ['gmi_frustration_recovery', 'gmi_confusion_clarification']
    );

    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.id)).toContain('gmi_frustration_recovery');
    expect(merged.map((m) => m.id)).toContain('gmi_confusion_clarification');
    expect(merged.map((m) => m.id)).not.toContain('gmi_error_recovery');
  });
});

describe('GMI events from a StatisticalUtilityAI', () => {
  // The utility class gmi() gives every agent: it scores each user turn by its sentiment lexicon, and the
  // GMI's SentimentTracker raises the events from that score with the default thresholds.
  async function scoreOneTurn(
    content: string,
    // persona: a code names that language; null builds a persona that names none; left out keeps the base persona's 'en'.
    languages: { utility?: string; persona?: string | null } = {},
  ): Promise<{
    events: GMIEventType[];
    trend: SentimentHistoryState['trends'][number];
  }> {
    const wm = createMockWorkingMemory();
    const utilityAI = new StatisticalUtilityAI('gmi-lexicon');
    await utilityAI.initialize({ defaultLanguage: languages.utility ?? 'en' });
    const gmi = new GMI('test-lexicon-sentiment');
    const persona = createSentimentPersona(
      { enabled: true },
      languages.persona === undefined ? undefined : { defaultLanguage: languages.persona ?? undefined },
    );
    await gmi.initialize(persona, {
      workingMemory: wm as any,
      promptEngine: mockPromptEngine,
      llmProviderManager: mockLlmProviderManager,
      utilityAI,
      toolOrchestrator: mockToolOrchestrator,
      retrievalAugmentor: mockRetrievalAugmentor,
      defaultLlmModelId: 'mock-model',
      defaultLlmProviderId: 'mock-provider',
    });

    const input: GMITurnInput = {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.TEXT,
      content,
    };
    for await (const _chunk of gmi.processTurnStream(input)) { /* consume */ }

    const history = wm._store.get('gmi_sentiment_history') as SentimentHistoryState;
    const events = (gmi as any).sentimentTracker.events as Array<{ eventType: GMIEventType }>;
    return { events: events.map((event) => event.eventType), trend: history.trends[0] };
  }

  it('raises USER_FRUSTRATED on a plainly negative turn', async () => {
    const { events, trend } = await scoreOneTurn('This is terrible, I hate it and the app is useless.');
    expect(trend.score).toBeLessThan(-0.6);
    expect(trend.polarity).toBe('negative');
    expect(events).toContain(GMIEventType.USER_FRUSTRATED);
    expect(events).not.toContain(GMIEventType.USER_SATISFIED);
  });

  it('raises USER_SATISFIED on a plainly positive turn', async () => {
    const { events, trend } = await scoreOneTurn('Thank you, that worked great and I love it.');
    expect(trend.score).toBeGreaterThan(0.5);
    expect(trend.polarity).toBe('positive');
    expect(events).toContain(GMIEventType.USER_SATISFIED);
    expect(events).not.toContain(GMIEventType.USER_FRUSTRATED);
  });

  it('raises neither on a turn with no sentiment word', async () => {
    const { events, trend } = await scoreOneTurn('The table is in the room next to the door.');
    expect(trend.score).toBe(0);
    expect(trend.polarity).toBe('neutral');
    expect(events).not.toContain(GMIEventType.USER_FRUSTRATED);
    expect(events).not.toContain(GMIEventType.USER_SATISFIED);
  });

  // gracias 2, excelente 3 and perfecto 3 are in the Spanish AFINN lexicon and none of them in the English one.
  const spanishPraise = 'Gracias, es excelente y perfecto.';

  it("scores a turn in the utility class's default language when neither the user nor the persona names one", async () => {
    const { events, trend } = await scoreOneTurn(spanishPraise, { utility: 'es', persona: null });
    expect(trend.score).toBeGreaterThan(0.5);
    expect(events).toContain(GMIEventType.USER_SATISFIED);
  });

  it("scores a turn in the persona's defaultLanguage when the user context names none", async () => {
    const { events, trend } = await scoreOneTurn(spanishPraise, { persona: 'es' });
    expect(trend.score).toBeGreaterThan(0.5);
    expect(events).toContain(GMIEventType.USER_SATISFIED);
  });
});

describe('GMI sentiment method forwarding', () => {
  it.each([undefined, 'lexicon_based'] as const)('passes method %s unchanged', async (method) => {
    const utility = createMockUtilityAI();
    const gmi = new GMI('sentiment-method');
    await gmi.initialize(createSentimentPersona({ enabled: true, ...(method ? { method } : {}) }), {
      workingMemory: createMockWorkingMemory() as any,
      promptEngine: mockPromptEngine,
      llmProviderManager: mockLlmProviderManager,
      utilityAI: utility as any,
      toolOrchestrator: mockToolOrchestrator,
      defaultLlmProviderId: 'mock-llm-provider', defaultLlmModelId: 'mock-model',
    });
    try {
      for await (const chunk of gmi.processTurnStream({
        interactionId: 'method', userId: 'user-1', type: GMIInteractionType.TEXT, content: 'Hello.',
      })) void chunk;
      expect((utility.analyzeSentiment as any).mock.calls[0]?.[1]).toMatchObject({ method });
    } finally {
      await gmi.shutdown();
    }
  });
});

describe('GMI sentiment beside the first model call', () => {
  it('replaceHistory before each turn never joins a held sentiment analysis', async () => {
    vi.useFakeTimers();
    let release!: (value: SentimentResult) => void;
    const utility = createMockUtilityAI();
    utility.analyzeSentiment.mockImplementationOnce(() => new Promise<SentimentResult>((resolve) => { release = resolve; }));
    const gmi = new GMI('replace-held');
    const wm = createMockWorkingMemory();
    await gmi.initialize(createSentimentPersona({ enabled: true }), {
      workingMemory: wm as any, utilityAI: utility as any, promptEngine: mockPromptEngine,
      llmProviderManager: mockLlmProviderManager, toolOrchestrator: mockToolOrchestrator,
    });
    const drain = async (id: string) => {
      for await (const chunk of gmi.processTurnStream({ interactionId: id, userId: 'user-1', type: GMIInteractionType.TEXT, content: id })) void chunk;
    };
    try {
      gmi.replaceHistory([]);
      const before = vi.mocked(mockProvider.generateCompletionStream).mock.calls.length;
      const first = drain('first');
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      // A bounded assertion before any wait on the turn, so the red run names the ordering instead of timing out.
      await vi.waitFor(() => expect(vi.mocked(mockProvider.generateCompletionStream).mock.calls.length,
        'main call must start while sentiment is held').toBeGreaterThan(before), { timeout: 500, interval: 10 });
      await vi.advanceTimersByTimeAsync(2000); await first;
      const calls = vi.mocked(mockProvider.generateCompletionStream).mock.calls.length;
      gmi.replaceHistory([]);
      const second = drain('second');
      await vi.waitFor(() => expect(vi.mocked(mockProvider.generateCompletionStream).mock.calls.length).toBeGreaterThan(calls));
      await second;
      release({ score: -0.9, polarity: 'negative', intensity: 0.9 });
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.stringify(wm._store.get('gmi_sentiment_history'))).not.toContain('first');
    } finally {
      release?.({ score: 0, polarity: 'neutral' });
      await gmi.shutdown(); vi.useRealTimers();
    }
  });

  it('finishes an analysis whose writes began inside the budget instead of dropping half of it', async () => {
    vi.useFakeTimers();
    const utility = createMockUtilityAI({ score: -0.9, polarity: 'negative', intensity: 0.9 });
    const wm = createMockWorkingMemory();
    const write = wm.set.getMockImplementation()!;
    let releaseWrite: (() => void) | undefined;
    wm.set.mockImplementation((key: string, value: any) => key === 'gmi_sentiment_history'
      ? new Promise<void>((resolve) => { releaseWrite = () => { void write(key, value); resolve(); }; })
      : write(key, value));
    const gmi = new GMI('committed-sentiment');
    await gmi.initialize(createSentimentPersona({ enabled: true }), {
      workingMemory: wm as any, utilityAI: utility as any, promptEngine: mockPromptEngine,
      llmProviderManager: mockLlmProviderManager, toolOrchestrator: mockToolOrchestrator,
    });
    try {
      const before = vi.mocked(mockProvider.generateCompletionStream).mock.calls.length;
      const turn = (async () => {
        for await (const chunk of gmi.processTurnStream({ interactionId: 'committed', userId: 'user-1', type: GMIInteractionType.TEXT, content: 'This is terrible.' })) void chunk;
      })();
      await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));
      await vi.waitFor(() => expect(vi.mocked(mockProvider.generateCompletionStream).mock.calls.length,
        'main call must start while the history write is held').toBeGreaterThan(before), { timeout: 500, interval: 10 });
      await vi.advanceTimersByTimeAsync(2500);
      releaseWrite!();
      await turn;
      expect(wm._store.get('gmi_sentiment_history')?.trends).toHaveLength(1);
      expect((gmi as any).sentimentTracker.events.map((event: any) => event.eventType)).toContain(GMIEventType.USER_FRUSTRATED);
    } finally {
      releaseWrite?.();
      await gmi.shutdown(); vi.useRealTimers();
    }
  });

  it('lets the first tool round read a committed sentiment while its store writes outlast the budget', async () => {
    vi.useFakeTimers();
    const utility = createMockUtilityAI();
    const wm = createMockWorkingMemory();
    const write = wm.set.getMockImplementation()!;
    // From the analysis start on, the host store takes 2,500 ms for each sentiment write, longer than the budget.
    let slow = false;
    utility.analyzeSentiment.mockImplementation(async () => {
      slow = true;
      return { score: -0.9, polarity: 'negative', intensity: 0.9 } as SentimentResult;
    });
    wm.set.mockImplementation((key: string, value: any) => slow && (key === 'currentUserContext' || key === 'gmi_sentiment_history')
      ? new Promise<void>((resolve) => { setTimeout(() => { void write(key, value); resolve(); }, 2500); })
      : write(key, value));
    let toolSaw: unknown;
    let historyAtTool: unknown = 'unread';
    vi.mocked(mockToolOrchestrator.processToolCall).mockImplementationOnce((async (details: any) => {
      toolSaw = details.userContext?.currentSentiment;
      historyAtTool = wm._store.get('gmi_sentiment_history');
      return { toolCallId: 'sentiment-tool', toolName: 'readSentiment', output: 'read', isError: false };
    }) as any);
    vi.mocked(mockProvider.generateCompletionStream).mockImplementationOnce((async function* () {
      yield { isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'sentiment-tool', type: 'function', function: { name: 'readSentiment', arguments: '{}' } }] },
      finishReason: 'tool_calls' }] };
    }) as any);
    const gmi = new GMI('committed-tool-read');
    await gmi.initialize(createSentimentPersona({ enabled: true }), {
      workingMemory: wm as any, utilityAI: utility as any, promptEngine: mockPromptEngine,
      llmProviderManager: mockLlmProviderManager, toolOrchestrator: mockToolOrchestrator,
    });
    try {
      const turn = (async () => {
        for await (const chunk of gmi.processTurnStream({ interactionId: 'committed-tool', userId: 'user-1', type: GMIInteractionType.TEXT, content: 'This is terrible.' })) void chunk;
      })();
      await vi.waitFor(() => expect(slow).toBe(true));
      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => expect(historyAtTool, 'the first tool round must run').not.toBe('unread'));
      // The tool ran before the sentiment writes landed.
      expect(historyAtTool).toBeUndefined();
      expect(toolSaw, 'the first tool round reads the committed sentiment').toBe('negative');
      await vi.advanceTimersByTimeAsync(5000);
      await turn;
      expect(wm._store.get('gmi_sentiment_history')?.trends).toHaveLength(1);
    } finally {
      await gmi.shutdown(); vi.useRealTimers();
    }
  });

  it('takes back an abandoned analysis whose history write lands after its turn was forgotten', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const capture: Record<string, unknown> = { child: () => capture };
    for (const level of ['debug', 'info', 'warn', 'error', 'fatal']) {
      capture[level] = (line: Record<string, unknown>) => { lines.push(line); };
    }
    setLogger(capture as any);
    const utility = createMockUtilityAI({ score: -0.9, polarity: 'negative', intensity: 0.9 });
    utility.analyzeSentiment.mockResolvedValueOnce({ score: 0, polarity: 'neutral', intensity: 0 } as SentimentResult);
    const wm = createMockWorkingMemory();
    const write = wm.set.getMockImplementation()!;
    let holdHistory = false;
    let releaseWrite: (() => void) | undefined;
    // The host store holds the second turn's history write until the test releases it, past the shutdown bound.
    wm.set.mockImplementation((key: string, value: any) => holdHistory && key === 'gmi_sentiment_history' && !releaseWrite
      ? new Promise<void>((resolve) => { releaseWrite = () => { void write(key, value); resolve(); }; })
      : write(key, value));
    const gmi = new GMI('abandoned-write');
    await gmi.initialize(createSentimentPersona({ enabled: true }), {
      workingMemory: wm as any, utilityAI: utility as any, promptEngine: mockPromptEngine,
      llmProviderManager: mockLlmProviderManager, toolOrchestrator: mockToolOrchestrator, shutdownTimeoutMs: 1000,
    });
    const drain = async (id: string, content: string) => {
      for await (const chunk of gmi.processTurnStream({ interactionId: id, userId: 'user-1', type: GMIInteractionType.TEXT, content })) void chunk;
    };
    try {
      await drain('kept', 'Hello there.');
      const afterKept = structuredClone(wm._store.get('gmi_sentiment_history'));
      expect(afterKept?.trends).toHaveLength(1);
      vi.useFakeTimers();
      holdHistory = true;
      const dropped = drain('dropped', 'Forget-me: this is terrible.');
      await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));
      // The budget, then the shutdown bound: the post-turn check drops the analysis while its write is held.
      await vi.advanceTimersByTimeAsync(3500);
      await dropped;
      gmi.replaceHistory([createConversationMessage(MessageRole.USER, 'Hello there.')]);
      await vi.advanceTimersByTimeAsync(0);
      releaseWrite!();
      await vi.waitFor(() => expect(wm._store.get('gmi_sentiment_history'),
        'an abandoned analysis leaves no trend and moves no counter').toEqual(afterKept), { timeout: 500, interval: 10 });
      const recorded = JSON.stringify([
        (gmi as any).reasoningTrace.entries,
        (gmi as any).sentimentTracker.events,
        wm._store.get('gmi_sentiment_history'),
        (gmi as any).conversationHistoryManager.history,
      ]);
      expect(recorded).not.toContain('Forget-me');
      expect(lines.filter((line) => line.event === 'gmi.sentiment_late')).toHaveLength(1);
      expect(JSON.stringify(lines)).not.toContain('Forget-me');
    } finally {
      releaseWrite?.();
      resetLoggerFactory();
      await gmi.shutdown(); vi.useRealTimers();
    }
  });
});

describe('GMI sentiment writes that land after their turn dropped them', () => {
  const startGmi = async (
    id: string,
    utility: ReturnType<typeof createMockUtilityAI>,
    wm: ReturnType<typeof createMockWorkingMemory>,
  ): Promise<GMI> => {
    const gmi = new GMI(id);
    await gmi.initialize(createSentimentPersona({ enabled: true }), {
      workingMemory: wm as any, utilityAI: utility as any, promptEngine: mockPromptEngine,
      llmProviderManager: mockLlmProviderManager, toolOrchestrator: mockToolOrchestrator, shutdownTimeoutMs: 1000,
    });
    return gmi;
  };
  const drainTurn = async (gmi: GMI, id: string, content: string, extra: Record<string, unknown> = {}) => {
    for await (const chunk of gmi.processTurnStream({
      interactionId: id, userId: 'user-1', type: GMIInteractionType.TEXT, content, ...extra,
    } as any)) void chunk;
  };
  // Runs a turn whose sentiment write the host store holds, past the budget and the shutdown bound, so the
  // post-turn check drops the analysis while that write is still in flight.
  const dropWhileHeld = async (gmi: GMI, id: string, content: string, held: () => boolean) => {
    vi.useFakeTimers();
    const turn = drainTurn(gmi, id, content);
    await vi.waitFor(() => expect(held()).toBe(true));
    await vi.advanceTimersByTimeAsync(3500);
    await turn;
    vi.useRealTimers();
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const negative = { score: -0.9, polarity: 'negative', intensity: 0.9 } as SentimentResult;

  it("keeps the next turn's analysis when a dropped history write lands over it", async () => {
    const utility = createMockUtilityAI();
    utility.analyzeSentiment.mockResolvedValueOnce(negative);
    const wm = createMockWorkingMemory();
    const write = wm.set.getMockImplementation()!;
    let releaseWrite: (() => void) | undefined;
    // The host store holds the first sentiment history write until the test releases it.
    wm.set.mockImplementation((key: string, value: any) => key === 'gmi_sentiment_history' && !releaseWrite
      ? new Promise<void>((resolve) => { releaseWrite = () => { void write(key, value); resolve(); }; })
      : write(key, value));
    const gmi = await startGmi('late-over-newer', utility, wm);
    try {
      await dropWhileHeld(gmi, 'dropped', 'This is terrible.', () => releaseWrite !== undefined);
      await drainTurn(gmi, 'next', 'Fine, thanks.');
      const afterNext = structuredClone(wm._store.get('gmi_sentiment_history'));
      expect(afterNext?.lastAnalyzedTurnId).toBe('next');
      releaseWrite!();
      await settle(); await settle();
      expect(wm._store.get('gmi_sentiment_history'), "a dropped history write keeps the next turn's analysis")
        .toEqual(afterNext);
    } finally {
      releaseWrite?.();
      vi.useRealTimers();
      await gmi.shutdown();
    }
  });

  it('keeps a forgotten excerpt cleared when the write that takes a dropped analysis back lands after the forget', async () => {
    const utility = createMockUtilityAI(negative);
    const wm = createMockWorkingMemory();
    const write = wm.set.getMockImplementation()!;
    let hold = false;
    const releases: Array<() => void> = [];
    // Once holding starts, the host store holds two sentiment history writes: the dropped turn's, then the one
    // that takes it back.
    wm.set.mockImplementation((key: string, value: any) => hold && key === 'gmi_sentiment_history' && releases.length < 2
      ? new Promise<void>((resolve) => { releases.push(() => { void write(key, value); resolve(); }); })
      : write(key, value));
    const gmi = await startGmi('take-back-after-forget', utility, wm);
    try {
      await drainTurn(gmi, 'pin', 'My PIN is 1234.');
      expect(JSON.stringify(wm._store.get('gmi_sentiment_history'))).toContain('1234');
      hold = true;
      await dropWhileHeld(gmi, 'dropped', 'This is terrible.', () => releases.length === 1);
      releases[0]();
      await vi.waitFor(() => expect(releases, 'the dropped write is taken back').toHaveLength(2), { timeout: 500, interval: 10 });
      gmi.clearHistory();
      await vi.waitFor(() => expect(JSON.stringify(wm._store.get('gmi_sentiment_history'))).not.toContain('1234'),
        { timeout: 500, interval: 10 });
      releases[1]();
      await settle(); await settle();
      expect(JSON.stringify(wm._store.get('gmi_sentiment_history')),
        'a take-back that lands after a forget leaves the forgotten excerpt cleared').not.toContain('1234');
    } finally {
      for (const release of releases) release();
      vi.useRealTimers();
      await gmi.shutdown();
    }
  });

  it('saves the newer user context again when a dropped context write lands after it', async () => {
    const utility = createMockUtilityAI();
    utility.analyzeSentiment.mockResolvedValueOnce(negative);
    const wm = createMockWorkingMemory();
    const write = wm.set.getMockImplementation()!;
    let releaseWrite: (() => void) | undefined;
    // The host store holds the dropped turn's sentiment write of the user context until the test releases it.
    wm.set.mockImplementation((key: string, value: any) =>
      key === 'currentUserContext' && value?.currentSentiment === 'negative' && !releaseWrite
        ? new Promise<void>((resolve) => { releaseWrite = () => { void write(key, value); resolve(); }; })
        : write(key, value));
    const gmi = await startGmi('late-context', utility, wm);
    try {
      await dropWhileHeld(gmi, 'dropped', 'This is terrible.', () => releaseWrite !== undefined);
      await drainTurn(gmi, 'next', 'Bonjour.', {
        userContextOverride: { language: 'fr', preferences: { verbosity: 'detailed' } },
      });
      expect(wm._store.get('currentUserContext')).toMatchObject({ language: 'fr' });
      releaseWrite!();
      await settle(); await settle();
      expect(wm._store.get('currentUserContext'), 'a dropped context write must not leave the store older than the GMI')
        .toMatchObject({ language: 'fr', preferences: { verbosity: 'detailed' }, currentSentiment: 'neutral' });
    } finally {
      releaseWrite?.();
      vi.useRealTimers();
      await gmi.shutdown();
    }
  });

  it("applies nothing of a failed turn's analysis when the host starts the next turn at the error chunk", async () => {
    let release: ((value: SentimentResult) => void) | undefined;
    const utility = createMockUtilityAI();
    utility.analyzeSentiment.mockImplementationOnce(() => new Promise<SentimentResult>((resolve) => { release = resolve; }));
    const wm = createMockWorkingMemory();
    const gmi = await startGmi('failed-stream', utility, wm);
    vi.mocked(mockProvider.generateCompletionStream).mockImplementationOnce((async function* () {
      throw new Error('scripted main failure');
    }) as any);
    const failed = gmi.processTurnStream({
      interactionId: 'failed', userId: 'user-1', type: GMIInteractionType.TEXT, content: "My PIN is 1234; I'm confused",
    });
    try {
      // The host reads the failed turn's stream up to its error chunk and leaves it there.
      let chunk = await failed.next();
      for (let read = 0; read < 50 && !chunk.done && (chunk.value as any)?.type !== GMIOutputChunkType.ERROR; read += 1) {
        chunk = await failed.next();
      }
      expect((chunk.value as any)?.type).toBe(GMIOutputChunkType.ERROR);
      expect(release).toBeTypeOf('function');
      await drainTurn(gmi, 'next', 'Next question.');
      release!(negative);
      await settle(); await settle();
      expect((gmi as any).currentUserContext.currentSentiment,
        "a failed turn's late analysis must not apply after the next turn").toBe('neutral');
      gmi.replaceHistory([createConversationMessage(MessageRole.USER, 'Next question.')]);
      await settle(); await settle();
      const recorded = JSON.stringify([
        (gmi as any).reasoningTrace.entries,
        (gmi as any).sentimentTracker.events,
        wm._store.get('gmi_sentiment_history'),
      ]);
      expect(recorded, "the failed turn's input reaches no record the next turn keeps").not.toContain('1234');
    } finally {
      release?.(negative);
      for await (const rest of failed) void rest;
      await gmi.shutdown();
    }
  });

  it('logs a take-back write that fails, with no message text', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const capture: Record<string, unknown> = { child: () => capture };
    for (const level of ['debug', 'info', 'warn', 'error', 'fatal']) {
      capture[level] = (line: Record<string, unknown>) => { lines.push(line); };
    }
    setLogger(capture as any);
    const utility = createMockUtilityAI(negative);
    const wm = createMockWorkingMemory();
    const write = wm.set.getMockImplementation()!;
    let hold = false;
    let releaseWrite: (() => void) | undefined;
    // Once holding starts, the host store holds the next sentiment history write, and every later one fails.
    wm.set.mockImplementation((key: string, value: any) => {
      if (!hold || key !== 'gmi_sentiment_history') return write(key, value);
      if (!releaseWrite) return new Promise<void>((resolve) => { releaseWrite = () => { void write(key, value); resolve(); }; });
      return Promise.reject(new Error('Forget-me store failure'));
    });
    wm.delete.mockImplementation(() => Promise.reject(new Error('Forget-me store failure')));
    const gmi = await startGmi('take-back-fails', utility, wm);
    try {
      await drainTurn(gmi, 'kept', 'Hello there.');
      hold = true;
      await dropWhileHeld(gmi, 'dropped', 'This is terrible.', () => releaseWrite !== undefined);
      gmi.replaceHistory([createConversationMessage(MessageRole.USER, 'Hello there.')]);
      await settle();
      releaseWrite!();
      await settle(); await settle();
      expect(lines.filter((line) => line.event === 'gmi.sentiment_take_back_failed'),
        'a take-back that fails writes one line').toHaveLength(1);
      expect(JSON.stringify(lines)).not.toContain('Forget-me');
    } finally {
      releaseWrite?.();
      resetLoggerFactory();
      vi.useRealTimers();
      await gmi.shutdown();
    }
  });

  it("keeps a dropped turn's trend out of a newer write that read the store before the take-back landed", async () => {
    const utility = createMockUtilityAI(negative);
    const wm = createMockWorkingMemory();
    const write = wm.set.getMockImplementation()!;
    let holds = 0;
    const releases: Array<() => void> = [];
    // The host store holds the next `holds` sentiment history writes, each until the test releases it.
    wm.set.mockImplementation((key: string, value: any) => {
      if (key !== 'gmi_sentiment_history' || holds === 0) return write(key, value);
      holds -= 1;
      return new Promise<void>((resolve) => { releases.push(() => { void write(key, value); resolve(); }); });
    });
    const gmi = await startGmi('newer-reads-dropped', utility, wm);
    try {
      await drainTurn(gmi, 'kept', 'Hello there.');
      holds = 1;
      await dropWhileHeld(gmi, 'dropped', 'My PIN is 1234.', () => releases.length === 1);
      gmi.replaceHistory([createConversationMessage(MessageRole.USER, 'Hello there.')]);
      await settle();
      // The dropped write lands; the write that takes it back is held.
      holds = 1;
      releases[0]();
      await vi.waitFor(() => expect(releases, 'the dropped write is taken back').toHaveLength(2), { timeout: 500, interval: 10 });
      // The next turn reads the store while it holds the dropped write. Its own write lands after the take-back, as
      // it does on a store that applies writes in order.
      holds = 1;
      const next = drainTurn(gmi, 'next', 'Next question.');
      await vi.waitFor(() => expect(releases, 'the next turn writes').toHaveLength(3), { timeout: 500, interval: 10 });
      releases[1]();
      releases[2]();
      await next;
      const stored = wm._store.get('gmi_sentiment_history');
      expect(JSON.stringify(stored), "a newer write keeps a dropped turn's text out of the store").not.toContain('1234');
      expect(stored?.trends.map((trend: any) => trend.turnId)).toEqual(['kept', 'next']);
    } finally {
      for (const release of releases) release();
      vi.useRealTimers();
      await gmi.shutdown();
    }
  });

  it('moves no counter when two dropped analyses take their writes back in turn', async () => {
    const utility = createMockUtilityAI();
    // Below the frustration threshold, with too little intensity to raise an event on its own.
    utility.analyzeSentiment.mockResolvedValue({ score: -0.5, polarity: 'negative', intensity: 0.3 } as SentimentResult);
    const wm = createMockWorkingMemory();
    const write = wm.set.getMockImplementation()!;
    let holds = 0;
    const releases: Array<() => void> = [];
    // The host store holds the next `holds` sentiment history writes, each until the test releases it.
    wm.set.mockImplementation((key: string, value: any) => {
      if (key !== 'gmi_sentiment_history' || holds === 0) return write(key, value);
      holds -= 1;
      return new Promise<void>((resolve) => { releases.push(() => { void write(key, value); resolve(); }); });
    });
    const gmi = await startGmi('two-dropped', utility, wm);
    try {
      holds = 1;
      await dropWhileHeld(gmi, 'first', 'This is bad.', () => releases.length === 1);
      holds = 1;
      await dropWhileHeld(gmi, 'second', 'This is bad too.', () => releases.length === 2);
      releases[0]();
      await settle(); await settle();
      releases[1]();
      await settle(); await settle();
      const stored = wm._store.get('gmi_sentiment_history');
      expect(stored?.consecutiveFrustration ?? 0, 'two dropped analyses move no counter').toBe(0);
      expect(stored?.trends ?? []).toEqual([]);
      await drainTurn(gmi, 'third', 'Bad again.');
      expect((gmi as any).sentimentTracker.events.map((event: any) => event.eventType),
        'a turn after two dropped ones counts one frustrated turn').not.toContain(GMIEventType.USER_FRUSTRATED);
    } finally {
      for (const release of releases) release();
      vi.useRealTimers();
      await gmi.shutdown();
    }
  });

  it('logs a scrub that runs again after a forget and fails once its own turn is forgotten', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const capture: Record<string, unknown> = { child: () => capture };
    for (const level of ['debug', 'info', 'warn', 'error', 'fatal']) {
      capture[level] = (line: Record<string, unknown>) => { lines.push(line); };
    }
    setLogger(capture as any);
    const utility = createMockUtilityAI(negative);
    const wm = createMockWorkingMemory();
    const write = wm.set.getMockImplementation()!;
    let holds = 0;
    const held: Array<{ release: () => void; fail: () => void }> = [];
    // The host store holds the next `holds` sentiment history writes, each until the test lands or fails it.
    wm.set.mockImplementation((key: string, value: any) => {
      if (key !== 'gmi_sentiment_history' || holds === 0) return write(key, value);
      holds -= 1;
      return new Promise<void>((resolve, reject) => {
        held.push({
          release: () => { void write(key, value); resolve(); },
          fail: () => reject(new Error('Forget-me store failure')),
        });
      });
    });
    const gmi = await startGmi('rescrub-fails', utility, wm);
    let turn: Promise<void> | undefined;
    try {
      await drainTurn(gmi, 'pin', 'My PIN is 1234.');
      holds = 1;
      turn = drainTurn(gmi, 'live', 'This is terrible.');
      await vi.waitFor(() => expect(held, 'the live analysis writes').toHaveLength(1), { timeout: 500, interval: 10 });
      // A forget the analysis did not see: it keeps the live turn and drops the PIN turn.
      gmi.replaceHistory([createConversationMessage(MessageRole.USER, 'This is terrible.')]);
      await vi.waitFor(() => expect(JSON.stringify(wm._store.get('gmi_sentiment_history'))).not.toContain('1234'),
        { timeout: 500, interval: 10 });
      await settle();
      // The analysis' write lands with the excerpt it read, so the scrub runs again; the store holds that write.
      holds = 1;
      held[0].release();
      await vi.waitFor(() => expect(held, 'the scrub runs again').toHaveLength(2), { timeout: 500, interval: 10 });
      // The live turn is forgotten as well, and the store then fails the scrub write it held.
      gmi.clearHistory();
      await settle(); await settle();
      held[1].fail();
      // The turn ends once the result is applied; the scrub that runs again finishes after it.
      await turn;
      await settle(); await settle();
      expect(lines.filter((line) => line.event === 'gmi.sentiment_take_back_failed'),
        'a scrub run again that fails after its turn was forgotten writes one line').toHaveLength(1);
      expect(JSON.stringify(lines)).not.toContain('Forget-me');
    } finally {
      for (const entry of held) entry.release();
      await turn?.catch(() => undefined);
      resetLoggerFactory();
      await gmi.shutdown();
    }
  });

  it('keeps a forgotten excerpt out of a take-back whose base is a history write the store rejected', async () => {
    const utility = createMockUtilityAI(negative);
    const wm = createMockWorkingMemory();
    const write = wm.set.getMockImplementation()!;
    let mode: 'pass' | 'reject' | 'hold' = 'reject';
    let releaseWrite: (() => void) | undefined;
    // The host store rejects the first sentiment history write, then holds the next one until the test releases it.
    wm.set.mockImplementation((key: string, value: any) => {
      if (key !== 'gmi_sentiment_history' || mode === 'pass') return write(key, value);
      if (mode === 'reject') return Promise.reject(new Error('store failure'));
      mode = 'pass';
      return new Promise<void>((resolve) => { releaseWrite = () => { void write(key, value); resolve(); }; });
    });
    const gmi = await startGmi('rejected-base', utility, wm);
    try {
      await drainTurn(gmi, 'pin', 'My PIN is 1234.');
      expect(wm._store.get('gmi_sentiment_history'), 'the store rejected the first history write').toBeUndefined();
      gmi.clearHistory();
      await settle();
      mode = 'hold';
      await dropWhileHeld(gmi, 'next', 'This is terrible.', () => releaseWrite !== undefined);
      releaseWrite!();
      await settle(); await settle();
      expect(JSON.stringify(wm._store.get('gmi_sentiment_history') ?? null),
        'a take-back writes no forgotten excerpt back').not.toContain('1234');
    } finally {
      releaseWrite?.();
      vi.useRealTimers();
      await gmi.shutdown();
    }
  });

  it('does not drop an applied analysis whose second scrub outlasts the post-turn wait', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const capture: Record<string, unknown> = { child: () => capture };
    for (const level of ['debug', 'info', 'warn', 'error', 'fatal']) {
      capture[level] = (line: Record<string, unknown>) => { lines.push(line); };
    }
    setLogger(capture as any);
    const utility = createMockUtilityAI(negative);
    const wm = createMockWorkingMemory();
    const write = wm.set.getMockImplementation()!;
    let holds = 0;
    const releases: Array<() => void> = [];
    // The host store holds the next `holds` sentiment history writes, each until the test releases it.
    wm.set.mockImplementation((key: string, value: any) => {
      if (key !== 'gmi_sentiment_history' || holds === 0) return write(key, value);
      holds -= 1;
      return new Promise<void>((resolve) => { releases.push(() => { void write(key, value); resolve(); }); });
    });
    const gmi = await startGmi('slow-second-scrub', utility, wm);
    let turn: Promise<void> | undefined;
    try {
      await drainTurn(gmi, 'pin', 'My PIN is 1234.');
      vi.useFakeTimers();
      holds = 1;
      turn = drainTurn(gmi, 'live', 'This is terrible.');
      await vi.waitFor(() => expect(releases, 'the live analysis writes').toHaveLength(1), { timeout: 500, interval: 10 });
      // A forget the analysis did not see: it keeps the live turn and drops the PIN turn.
      gmi.replaceHistory([createConversationMessage(MessageRole.USER, 'This is terrible.')]);
      await vi.advanceTimersByTimeAsync(0);
      // The analysis' write lands and its result is applied; the scrub that runs again is held past both bounds.
      holds = 1;
      releases[0]();
      await vi.waitFor(() => expect(releases, 'the scrub runs again').toHaveLength(2), { timeout: 500, interval: 10 });
      await vi.advanceTimersByTimeAsync(3500);
      await turn;
      expect(lines.filter((line) => line.event === 'gmi.sentiment_late'),
        'an analysis that applied its result is not reported late').toHaveLength(0);
      releases[1]();
      await vi.advanceTimersByTimeAsync(0);
      const stored = wm._store.get('gmi_sentiment_history');
      expect(stored?.trends.map((trend: any) => trend.turnId)).toContain('live');
      expect(JSON.stringify(stored)).not.toContain('1234');
    } finally {
      for (const release of releases) release();
      await turn?.catch(() => undefined);
      resetLoggerFactory();
      vi.useRealTimers();
      await gmi.shutdown();
    }
  });

  it('keeps a forgotten excerpt out of a later write that read the store before the second scrub landed', async () => {
    const utility = createMockUtilityAI(negative);
    utility.analyzeSentiment.mockResolvedValueOnce({ score: 0, polarity: 'neutral', intensity: 0 } as SentimentResult);
    const wm = createMockWorkingMemory();
    const write = wm.set.getMockImplementation()!;
    let holdContext = false;
    let releaseContext: (() => void) | undefined;
    let skipHistory = 0;
    let holdHistory = 0;
    const releases: Array<{ turn: unknown; release: () => void }> = [];
    // The host store applies writes in call order. It can hold the first negative user-context write, and, after
    // letting `skipHistory` sentiment history writes through, the next `holdHistory` ones.
    wm.set.mockImplementation((key: string, value: any) => {
      if (key === 'currentUserContext' && holdContext && !releaseContext && value?.currentSentiment === 'negative') {
        return new Promise<void>((resolve) => { releaseContext = () => { void write(key, value); resolve(); }; });
      }
      if (key === 'gmi_sentiment_history' && holdHistory > 0) {
        if (skipHistory > 0) { skipHistory -= 1; return write(key, value); }
        holdHistory -= 1;
        return new Promise<void>((resolve) => {
          releases.push({ turn: value?.lastAnalyzedTurnId, release: () => { void write(key, value); resolve(); } });
        });
      }
      return write(key, value);
    });
    const gmi = await startGmi('later-write-after-forget', utility, wm);
    let turnB: Promise<void> | undefined;
    try {
      await drainTurn(gmi, 'pin', 'My PIN is 1234.');
      expect(JSON.stringify(wm._store.get('gmi_sentiment_history'))).toContain('1234');
      holdContext = true;
      const turnA = drainTurn(gmi, 'a', 'This is terrible.');
      // Turn A's analysis has read the history and waits for its user-context write.
      await vi.waitFor(() => expect(releaseContext, "turn A's context write is held").toBeTypeOf('function'),
        { timeout: 500, interval: 10 });
      // A forget the analysis did not see: it keeps turn A and drops the PIN turn.
      gmi.replaceHistory([createConversationMessage(MessageRole.USER, 'This is terrible.')]);
      await vi.waitFor(() => expect(JSON.stringify(wm._store.get('gmi_sentiment_history'))).not.toContain('1234'),
        { timeout: 500, interval: 10 });
      await settle();
      // A's history write lands with what it read. The history writes after it are held: a scrub run again for the
      // excerpt it brought back, then turn B's write.
      skipHistory = 1;
      holdHistory = 2;
      releaseContext!();
      await turnA;
      // Turn B reads the store before any held write lands; its write is called after them, so it lands after them.
      turnB = drainTurn(gmi, 'b', 'Next question.');
      await vi.waitFor(() => expect(releases.map((held) => held.turn), "turn B's history write is held").toContain('b'),
        { timeout: 500, interval: 10 });
      for (const held of releases) {
        held.release();
        await settle();
      }
      await turnB;
      await settle(); await settle();
      expect(JSON.stringify(wm._store.get('gmi_sentiment_history')),
        'a later write keeps a forgotten excerpt cleared').not.toContain('1234');
    } finally {
      releaseContext?.();
      for (const held of releases) held.release();
      await turnB?.catch(() => undefined);
      await gmi.shutdown();
    }
  });

  it("ends the first tool round's sentiment wait when the caller aborts during it", async () => {
    let release: ((value: SentimentResult) => void) | undefined;
    const utility = createMockUtilityAI();
    utility.analyzeSentiment.mockImplementationOnce(() => new Promise<SentimentResult>((resolve) => { release = resolve; }));
    const wm = createMockWorkingMemory();
    let mainDone = false;
    vi.mocked(mockProvider.generateCompletionStream).mockImplementationOnce((async function* () {
      try {
        yield { isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: null,
          tool_calls: [{ id: 'abort-tool', type: 'function', function: { name: 'readSentiment', arguments: '{}' } }] },
        finishReason: 'tool_calls' }] };
      } finally {
        mainDone = true;
      }
    }) as any);
    const gmi = await startGmi('abort-in-wait', utility, wm);
    const caller = new AbortController();
    let ended = false;
    vi.useFakeTimers();
    const turn = drainTurn(gmi, 'aborted', 'This is terrible.', { metadata: { options: { abortSignal: caller.signal } } })
      .catch(() => undefined)
      .finally(() => { ended = true; });
    try {
      await vi.waitFor(() => expect(mainDone, 'the first model call asks for a tool').toBe(true), { timeout: 500, interval: 10 });
      await vi.advanceTimersByTimeAsync(10);
      expect(ended, 'the first tool round waits for the held analysis').toBe(false);
      caller.abort();
      await vi.advanceTimersByTimeAsync(1000);
      expect(ended, "an abort ends the first tool round's sentiment wait").toBe(true);
    } finally {
      release?.(negative);
      await vi.advanceTimersByTimeAsync(10_000);
      await turn;
      vi.useRealTimers();
      await gmi.shutdown();
    }
  });
});
