// File: backend/agentos/cognitive_substrate/personas/IPersonaDefinition.ts
/**
 * @fileoverview This file defines the comprehensive structures and interfaces for Persona Definitions
 * within AgentOS.
 * @module backend/agentos/cognitive_substrate/personas/IPersonaDefinition
 */

import { ModelCompletionOptions } from '../../../core/llm/providers/IProvider';
import { PromptEngineConfig } from '../../../core/llm/IPromptEngine';
// Assuming ITool is in a subdirectory 'interfaces' under 'tools'
// The provided file structure is backend/agentos/core/tools/ITool.ts
// So the path should be ../../core/tools/ITool.ts if IPersonaDefinition.ts is in cognitive_substrate/personas
import { ITool } from '../../../core/tools/ITool'; // Corrected path assumption

// Placeholder definitions for UserContext and TaskContext if not defined elsewhere
// It's recommended to define these in appropriate domain-specific files.
// IGMI.ts already exports UserContext and TaskContext, so we can use those if they are compatible
// For now, keeping local definitions as per original file if they are intended to be distinct
// or if IPersonaDefinition.ts cannot directly import from IGMI.ts due to layering.
// Given the file structure, it *can* import. Let's assume these are specialized for persona defaults.
export interface PersonaUserContextDefaults {
  skillLevel?: string;
  preferences?: Record<string, any>;
  // Other user-specific context defaults
}

export interface PersonaTaskContextDefaults {
  domain?: string;
  complexity?: string;
  goal?: string;
  // Other task-specific context defaults
}


/**
 * Specifies the configuration for a persona's voice when generating audio output (Text-to-Speech).
 * @interface PersonaVoiceConfig
 */
export interface PersonaVoiceConfig {
  provider?: string;
  voiceId?: string;
  languageCode?: string;
  customParams?: Record<string, any>;
  moodToVoiceStyleMap?: Record<string, { voiceId?: string; customParams?: Record<string, any> }>;
}

/**
 * Defines the configuration for a persona's visual representation (avatar).
 * @interface PersonaAvatarConfig
 */
export interface PersonaAvatarConfig {
  type?: 'static_image' | 'animated_image' | 'realtime_generative_placeholder';
  sourceUrl?: string;
  descriptionForGeneration?: string;
  moodToAvatarStateMap?: Record<string, { sourceUrl?: string; generationPromptSuffix?: string }>;
}

/**
 * Configures how a persona's mood adapts based on interaction context, user feedback, or internal state.
 * @interface PersonaMoodAdaptationConfig
 */
export interface PersonaMoodAdaptationConfig {
  enabled: boolean;
  sensitivityFactor?: number;
  defaultMood: string; // Should ideally map to GMIMood enum values
  allowedMoods?: string[];
  moodPrompts?: Record<string, string>;
}

/**
 * Defines preferences for selecting AI models for various tasks or under certain conditions.
 * @interface ModelTargetPreference
 */
export interface ModelTargetPreference {
  taskHint?: string; // e.g., 'summarization', 'code_generation', 'general_chat'
  providerId?: string;
  modelId?: string; // Can be a specific model ID or a pattern/family name
  modelFamily?: string; // e.g., 'gpt-4', 'claude-3'
  minQualityTier?: 'fastest' | 'balanced' | 'best';
  maxCostPerKiloTokenInput?: number;
  maxCostPerKiloTokenOutput?: number;
  allowedModelIds?: string[]; // Explicit list of allowed models for this preference
  requiredCapabilities?: Array<'tool_use' | 'vision_input' | 'json_mode' | 'long_context' | string>;
}

/**
 * Configuration for how the persona manages and utilizes conversation history.
 * @interface PersonaConversationContextConfig
 */
export interface PersonaConversationContextConfig {
  maxMessages?: number;
  maxTokens?: number; // Max tokens for the history part of the prompt
  overflowStrategy?: 'truncate' | 'summarize' | 'hybrid'; // How to handle history exceeding limits
  summarizationTriggerTokens?: number; // When to trigger summarization if 'summarize' or 'hybrid'
  includeToolResults?: boolean; // Whether tool results messages are part of the history for LLM
  includeSystemMessages?: boolean; // Whether system messages are part of the history for LLM
}

/**
 * Per-persona limits for the GMI's reasoning trace: the ring buffer of decision
 * entries the turn loop writes and the self-reflection metaprompt reads as
 * evidence. Omitted values fall back to the runtime's `GMIBaseConfig` defaults
 * (`defaultReasoningTraceMaxEntries`, `defaultReasoningTraceMaxMessageLength`),
 * then to 500 entries and 1000 characters per message.
 */
export interface PersonaReasoningTraceConfig {
  /** Entries kept; the oldest is dropped when the next arrives. A positive integer. */
  maxEntries?: number;
  /** Characters kept per entry message; longer messages are truncated. A positive integer. */
  maxMessageLength?: number;
}

/**
 * Configuration for a specific RAG (Retrieval Augmented Generation) data source
 * @interface PersonaRagDataSourceConfig
 */
export interface PersonaRagDataSourceConfig {
  id: string; // Unique ID for this data source configuration entry
  dataSourceNameOrId: string; // Actual ID/name of the data source in the RAG system
  isEnabled: boolean;
  displayName?: string; // User-friendly name for this source in persona context
  defaultTopK?: number; // How many results to fetch from this source by default
  defaultFilterMetadata?: Record<string, any>; // Default metadata filters for this source
  priority?: number; // Retrieval priority for this source
  relevanceThreshold?: number; // Minimum relevance score to consider results from this source
}

/**
 * Configuration for how memory (e.g., conversation history, retrieved documents) is processed by utility AI.
 * @interface PersonaUtilityProcessingConfig
 */
export interface PersonaUtilityProcessingConfig {
  engine: 'llm' | 'statistical' | 'none'; // Which engine to use for processing
  llmConfig?: {
    providerId?: string;
    modelId?: string;
    promptTemplateName?: string; // Specific prompt template for this utility task
    maxOutputTokens?: number;
  };
  statisticalConfig?: {
    summarizationMethod?: string; // e.g., 'textrank', 'lexrank'
    summarizationLength?: 'short' | 'medium' | 'long' | number; // Target length/number of sentences
    keywordExtractionMethod?: string;
    maxKeywords?: number;
  };
}

/**
 * Defines triggers for RAG retrieval.
 * @interface PersonaRagConfigRetrievalTrigger
 */
export interface PersonaRagConfigRetrievalTrigger {
    onUserQuery?: boolean; // Trigger RAG on every user query
    onIntentDetected?: string[]; // Trigger if specific intents are detected
    onToolFailure?: string[]; // Trigger if specific tools fail
    onMissingContextKeywords?: string[]; // Trigger if query contains keywords but context seems lacking
    customLogicFunctionName?: string; // For more complex custom trigger logic
}

/**
 * Defines triggers for RAG ingestion (e.g., summarizing turns into RAG).
 * @interface PersonaRagConfigIngestionTrigger
 */
export interface PersonaRagConfigIngestionTrigger {
    onTurnSummary?: boolean; // Trigger ingestion of turn summary
    onExplicitUserCommand?: string; // e.g., "remember this for later"
    customLogicFunctionName?: string;
}


/**
 * Configuration for RAG ingestion processing.
 * @interface PersonaRagIngestionProcessingConfig
 */
export interface PersonaRagIngestionProcessingConfig {
    summarization?: {
        enabled: boolean;
        targetLength?: 'short' | 'medium' | 'long' | number; // Number of words/sentences or category
        method?: 'extractive' | 'abstractive_llm';
        modelId?: string; // For abstractive_llm
        providerId?: string; // For abstractive_llm
    };
    keywordExtraction?: {
        enabled: boolean;
        maxKeywords?: number;
    };
}


/**
 * Configuration for the persona's memory systems.
 * @interface PersonaMemoryConfig
 */
export interface PersonaMemoryConfig {
  enabled: boolean;
  conversationContext?: PersonaConversationContextConfig; // Configuration specific to history management
  ragConfig?: {
    enabled: boolean;
    defaultRetrievalStrategy?: 'similarity' | 'mmr' | 'hybrid_search';
    defaultRetrievalTopK?: number;
    dataSources?: PersonaRagDataSourceConfig[]; // Define how this persona uses specific RAG data sources
    rerankerConfig?: {
      enabled: boolean;
      provider: 'cohere' | 'jina' | 'custom_llm' | string; // e.g., specific model for reranking
      modelName?: string;
      apiKeyEnvVar?: string; // Env var name for API key if needed
      topN?: number; // Number of results to pass to reranker and expect back
    };
    queryAugmentationPromptName?: string; // Name of a prompt template for query expansion/rewriting
    resultSynthesizerPromptName?: string; // Name of a prompt template to synthesize final answer from RAG results
    retrievedContextProcessing?: PersonaUtilityProcessingConfig; // How to process/summarize retrieved context before injection
    retrievalTriggers?: PersonaRagConfigRetrievalTrigger; // When to trigger RAG retrieval
    ingestionTriggers?: PersonaRagConfigIngestionTrigger; // ADDED: When to trigger ingestion into RAG
    ingestionProcessing?: PersonaRagIngestionProcessingConfig; // How to process content before RAG ingestion
    defaultIngestionDataSourceId?: string; // Default RAG source to ingest persona-related memories
  };
  workingMemoryProcessing?: {
    adaptationRules?: Array<{
      triggerEvent: string; // e.g., 'user_feedback_positive', 'task_completed_successfully'
      action: 'update_trait' | 'log_preference' | 'trigger_self_reflection' | string;
      parameters?: any; // Parameters for the action
      processingEngine?: PersonaUtilityProcessingConfig; // Engine to process event data for action
    }>;
  };
  lifecycleConfig?: { // Configuration for memory lifecycle management interactions
    negotiationEnabled?: boolean; // Can GMI negotiate memory lifecycle events?
    // Potentially add rules here like "always_retain_user_explicit_memory"
  };
}

/**
 * Configuration for sentiment-aware metaprompt tracking.
 * Controls whether the GMI analyzes user sentiment and triggers
 * event-based metaprompts in response to detected emotional states.
 *
 * @interface SentimentTrackingConfig
 *
 * @example
 * // Minimal: enable with defaults
 * sentimentTracking: { enabled: true }
 *
 * @example
 * // Full: LLM-based analysis with custom thresholds
 * sentimentTracking: {
 *   enabled: true,
 *   method: 'llm',
 *   historyWindow: 10,
 *   frustrationThreshold: -0.3,
 *   satisfactionThreshold: 0.3,
 *   consecutiveTurnsForTrigger: 2,
 *   presets: ['frustration_recovery', 'confusion_clarification'],
 * }
 */
export interface SentimentTrackingConfig {
    /**
     * Master switch: enables/disables sentiment analysis on user input.
     * When false (default), no sentiment analysis runs and no events are emitted.
     * Turn_interval metaprompts (like gmi_self_trait_adjustment) still work regardless.
     * @default false
     */
    enabled: boolean;

    /**
     * Sentiment analysis method.
     * - 'lexicon_based': Fast (~10-50ms), no LLM cost, basic accuracy (VADER-style)
     * - 'llm': Uses LLM call, higher accuracy, ~500-1000ms latency, costs tokens
     * - 'trained_classifier': Uses trained ML model (if available)
     * @default 'lexicon_based'
     */
    method?: 'lexicon_based' | 'llm' | 'trained_classifier';

    /**
     * Model ID for LLM-based or trained_classifier methods.
     * Falls back to persona defaultModelId if not specified.
     */
    modelId?: string;

    /**
     * Provider ID for LLM-based methods.
     * Falls back to persona defaultProviderId if not specified.
     */
    providerId?: string;

    /**
     * Number of recent turns to keep in sentiment history (sliding window).
     * Higher = better pattern detection, slightly more memory.
     * @default 10
     */
    historyWindow?: number;

    /**
     * Sentiment score threshold below which frustration is detected.
     * Score range: -1 (very negative) to 1 (very positive).
     * @default -0.3
     */
    frustrationThreshold?: number;

    /**
     * Sentiment score threshold above which satisfaction is detected.
     * @default 0.3
     */
    satisfactionThreshold?: number;

    /**
     * Number of consecutive turns with same sentiment pattern before triggering event.
     * Prevents over-triggering on single outlier messages.
     * @default 2
     */
    consecutiveTurnsForTrigger?: number;

    /**
     * Which preset metaprompts to enable. Options:
     * - 'frustration_recovery': Responds to user frustration
     * - 'confusion_clarification': Responds to user confusion
     * - 'satisfaction_reinforcement': Responds to user satisfaction
     * - 'error_recovery': Responds to error accumulation
     * - 'engagement_boost': Responds to low engagement
     * - 'all': Enables all presets
     *
     * Only listed presets will be merged. Omit to enable none (use custom metaPrompts instead).
     * @default [] (no presets auto-merged)
     */
    presets?: Array<
      | 'frustration_recovery'
      | 'confusion_clarification'
      | 'satisfaction_reinforcement'
      | 'error_recovery'
      | 'engagement_boost'
      | 'all'
    >;
}

/**
 * Defines a meta-prompt for GMI self-regulation.
 * @interface MetaPromptDefinition
 */
export interface MetaPromptDefinition {
    id: string; // Unique ID for this meta-prompt (e.g., 'gmi_self_trait_adjustment')
    description?: string;
    promptTemplate: string | { template: string; variables?: string[] }; // The template itself
    modelId?: string; // Specific model to use for this meta-prompt
    providerId?: string; // Specific provider
    maxOutputTokens?: number;
    temperature?: number;
    outputSchema?: Record<string, any>; // Expected JSON schema of the output, for validation/parsing
    /**
     * How this meta-prompt is triggered. The executor fires only these three
     * types; PersonaValidation warns about any other type, an intervalTurns
     * below 1, or an eventName that is not a GMIEventType value.
     */
    trigger?:
      | { type: 'turn_interval'; intervalTurns: number } // Fires on every intervalTurns-th user turn
      | { type: 'event_based'; eventName: string } // A GMIEventType value, e.g. 'user_frustrated' or 'error_threshold_exceeded'
      | { type: 'manual' }; // Triggered explicitly by system or user
}

/**
 * Defines contextual elements that can be dynamically injected into prompts.
 * @interface ContextualPromptElement
 */
export interface ContextualPromptElement {
    id: string;
    type: string; // e.g., 'SYSTEM_INSTRUCTION_ADDON', 'FEW_SHOT_EXAMPLE' (maps to ContextualElementType in IPromptEngine)
    content: string | object; // The actual content to inject. Can be structured.
    criteria: ContextualPromptElementCriteria; // Conditions for activation
    priority?: number; // For resolving conflicts or ordering
    metadata?: Record<string, any>; // e.g., source, language
}

/**
 * Defines criteria for activating a contextual prompt element.
 * @interface ContextualPromptElementCriteria
 */
export interface ContextualPromptElementCriteria {
    // Define specific criteria fields, e.g.,
    // currentMood?: string[]; // Activates if GMI mood is one of these
    // userSkillLevel?: string[]; // Activates for these user skill levels
    // taskHint?: string[]; // Activates for these task types
    // customConditions?: Array<{ type: 'workingMemoryQuery', query: string, expectedValue: any } | { type: 'jsExpression', expression: string }>;
    // This structure needs to be defined based on what IPromptEngine.evaluateCriteria can handle.
    [key: string]: any; // Placeholder for actual criteria structure
}


/**
 * The primary interface defining a complete Persona for a Generalized Mind Instance (GMI).
 * @interface IPersonaDefinition
 */
export interface IPersonaDefinition {
  /** Stable unique identifier for the persona (used for activation & persistence). */
  id: string;
  /** Human-readable name surfaced in UI selection lists. */
  name: string;
  /** Optional short label (e.g., abbreviation) for compact UI contexts. */
  label?: string;
  /** Rich description of goals, domain focus, and behavioral nuance. */
  description: string;
  /** Semantic version of persona definition; bump on behavioral / config changes (e.g., '1.2.0'). */
  version: string;

  /**
   * Base system prompt (or structured template) establishing foundational directives.
   * Supports:
   *  - Raw string
   *  - Templated object { template, variables[] }
   *  - Ordered array of prompt fragments with priority for deterministic merging.
   */
  baseSystemPrompt: string | { template: string; variables?: string[] } | Array<{ content: string; priority?: number }>;

  /** Default model id to target for this persona's typical tasks (can be routed or overridden). */
  defaultModelId?: string;
  /** Preferred provider if same model family exists across vendors (helps routing heuristics). */
  defaultProviderId?: string;
  /** Baseline completion option overrides (temperature, maxTokens, presence penalties, etc.). */
  defaultModelCompletionOptions?: Partial<ModelCompletionOptions>;
  /** Ordered preferences describing desired model traits (cost/perf/latency) for dynamic selection. */
  modelTargetPreferences?: ModelTargetPreference[];
  /** High-level cost strategy guiding router decisions. */
  costSavingStrategy?: 'always_cheapest' | 'balance_quality_cost' | 'prioritize_quality' | 'user_preference';

  /** Partial overrides merged onto global PromptEngine configuration for persona specialization. */
  promptEngineConfigOverrides?: Partial<PromptEngineConfig>;

  /** Referenced tool identifiers persona is permitted to invoke. */
  toolIds?: string[];
  /** Abstract capability flags enabling conditional UI / workflow features (e.g., 'web_search'). */
  allowedCapabilities?: string[];
  /** Inline tool instances embedded directly (rare; typically tools live in registry). */
  embeddedTools?: ITool[];

  /** Whitelisted input modalities persona accepts (driver for validation in interaction layer). */
  allowedInputModalities?: Array<'text' | 'audio_transcription' | 'vision_image_url' | 'vision_image_base64'>;
  /** Output modalities persona can produce (text, TTS synthesized, image generation results). */
  allowedOutputModalities?: Array<'text' | 'audio_tts' | 'image_generation_tool_result'>;
  /** Voice synthesis configuration (preferred voice id, style, speed). */
  voiceConfig?: PersonaVoiceConfig;
  /** Visual avatar / representation metadata (image URL, animation style). */
  avatarConfig?: PersonaAvatarConfig;

  /** Arbitrary personality trait map (e.g., { humor_level: 0.7, pedagogical_style: 'socratic' }). */
  personalityTraits?: Record<string, any>;
  /** Rules controlling adaptive mood shifts & modulation of tone. */
  moodAdaptation?: PersonaMoodAdaptationConfig;
  /** Default output language (BCP‑47) used when user preference unspecified. */
  defaultLanguage?: string;
  /** High-level interaction posture for UI behaviors (suggestive hints vs directive instructions). */
  uiInteractionStyle?: 'suggestive' | 'directive' | 'collaborative' | 'silent';

  /** Memory subsystem tuning (retention horizons, summarization cadence, pinning rules). */
  memoryConfig?: PersonaMemoryConfig;
  /** Cognitive memory system per-persona overrides (encoding, decay, working memory capacity, etc.). */
  cognitiveMemoryConfig?: import('../../memory/core/config.js').CognitiveMemoryPersonaConfig;
  /** Conversation context override strategy (message importance heuristics, summarization triggers). */
  conversationContextConfig?: PersonaConversationContextConfig;
  /** Reasoning-trace limits for GMIs built from this persona; see PersonaReasoningTraceConfig. */
  reasoningTraceConfig?: PersonaReasoningTraceConfig;

  /** System or self-reflective prompts guiding meta-cognition, self-correction, or planning loops. */
  metaPrompts?: MetaPromptDefinition[];
  /**
   * Sentiment tracking configuration. Controls whether the GMI analyzes user emotional state
   * and triggers event-based metaprompts (frustration recovery, confusion clarification, etc.).
   * Opt-in: disabled by default. Turn_interval metaprompts (like self-reflection) always work regardless.
   */
  sentimentTracking?: SentimentTrackingConfig;
  /** Dynamic contextual prompt elements evaluated per turn for fine-grained adaptation. */
  contextualPromptElements?: ContextualPromptElement[];

  /** Allows persona to perform privileged creation/update of other personas. */
  isCreatorPersona?: boolean;
  /** If true persona is globally discoverable subject to subscription tier gating. */
  isPublic?: boolean;
  /** Natural language keywords enabling auto-activation in multi-persona environments. */
  activationKeywords?: string[];
  /** Strength tag list aiding search & recommendation (e.g., ['typescript', 'design_reviews']). */
  strengths?: string[];
  /** Minimum subscription tier required to access persona (e.g., 'pro', 'enterprise'). */
  minSubscriptionTier?: string;

  /** Seed working memory imprints establishing initial context (preferences, calibration data). */
  initialMemoryImprints?: Array<{ key: string; value: any; description?: string }>;
  /** Arbitrary extension fields and structured defaults for user/task contexts. */
  customFields?: Record<string, any> & {
    /** Working memory default config attached at GMI instantiation time. */
    defaultWorkingMemoryConfig?: any;
    /** Initial inferred or declared user context values. */
    initialUserContext?: Partial<PersonaUserContextDefaults>;
    /** Initial task framing values (e.g., domain, complexity baseline). */
    initialTaskContext?: Partial<PersonaTaskContextDefaults>;
  };
  /** Named secrets (API keys, credentials) this persona depends on. */
  requiredSecrets?: string[];
}
