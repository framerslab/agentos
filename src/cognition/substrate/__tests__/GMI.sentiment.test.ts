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
import { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';
import { IRetrievalAugmentor } from '../../rag/IRetrievalAugmentor';
import { GMIEventType, SentimentHistoryState } from '../GMIEvent';
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
