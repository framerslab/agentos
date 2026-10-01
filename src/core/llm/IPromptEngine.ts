// File: backend/agentos/core/llm/IPromptEngine.ts
/**
 * @fileoverview Defines the IPromptEngine interface and related types that form the core
 * of AgentOS's adaptive and contextual prompting system. The PromptEngine is responsible
 * for dynamically constructing prompts based on rich contextual information, persona
 * definitions, and runtime state. It supports contextual element selection, token budgeting,
 * content summarization, and multiple prompt template formats.
 *
 * This interface is central to the GMI (Generalized Mind Instance) architecture, enabling
 * sophisticated prompt adaptation based on user skill level, mood, task complexity,
 * conversation state, and persona-specific rules.
 *
 * Key responsibilities include:
 * - Dynamic contextual element selection based on PromptExecutionContext.
 * - Intelligent token budgeting and content truncation/summarization using an IUtilityAI helper.
 * - Multi-modal prompt component integration (text, vision, audio data references, tools).
 * - Template-based prompt formatting for different LLM providers and models.
 * - Comprehensive error handling and issue reporting within the PromptEngineResult.
 * - Performance optimization strategies such as caching.
 *
 * @module backend/agentos/core/llm/IPromptEngine
 * See `docs/PROMPTS.MD` for detailed architectural documentation.
 * @see {@link IPersonaDefinition} for persona-driven prompting.
 */

import {
  IPersonaDefinition,
  ContextualPromptElement,
  ContextualPromptElementCriteria,
} from '../../cognition/substrate/personas/IPersonaDefinition';
import { IWorkingMemory } from '../../cognition/substrate/memory/IWorkingMemory';
import { ITool } from '../tools/ITool'; // Corrected import path
import { VisionInputData, AudioInputData } from '../../cognition/substrate/IGMI';
import { ConversationMessage as Message } from '../conversation/ConversationMessage'; // Corrected import: Used alias
import { ChatMessage } from './providers/IProvider'; // Standardized ChatMessage from IProvider

/**
 * Represents different types of contextual prompt elements that can be dynamically
 * selected and integrated into prompts based on execution context.
 * These elements allow for fine-grained adaptation of prompts.
 * @enum {string}
 */
export enum ContextualElementType {
  /** Additional system-level instructions appended to base system prompt. */
  SYSTEM_INSTRUCTION_ADDON = 'system_instruction_addon',
  /** Dynamic few-shot examples selected based on context to guide the LLM. */
  FEW_SHOT_EXAMPLE = 'few_shot_example',
  /** Behavioral guidance or tone adjustments for the persona. */
  BEHAVIORAL_GUIDANCE = 'behavioral_guidance',
  /** Specific instructions or constraints related to the current task. */
  TASK_SPECIFIC_INSTRUCTION = 'task_specific_instruction',
  /** Instructions for handling errors or recovering from unexpected situations. */
  ERROR_HANDLING_GUIDANCE = 'error_handling_guidance',
  /** Adjustments to the GMI's interaction style with the user. */
  INTERACTION_STYLE_MODIFIER = 'interaction_style_modifier',
  /** Domain-specific knowledge, facts, or context relevant to the current query. */
  DOMAIN_CONTEXT = 'domain_context',
  /** Ethical guidelines or safety instructions to ensure responsible AI behavior. */
  ETHICAL_GUIDELINE = 'ethical_guideline',
  /** Specifications for the desired output format (e.g., JSON, Markdown). */
  OUTPUT_FORMAT_SPEC = 'output_format_spec',
  /** Instructions for specific reasoning protocols (e.g., chain-of-thought, tree-of-thought). */
  REASONING_PROTOCOL = 'reasoning_protocol',
  /** Dynamic content to be injected directly into the user part of the prompt. */
  USER_PROMPT_AUGMENTATION = 'user_prompt_augmentation',
  /** Content to be injected into the assistant part for few-shot or role-play setup. */
  ASSISTANT_PROMPT_AUGMENTATION = 'assistant_prompt_augmentation',
}

/**
 * Comprehensive execution context that drives dynamic prompt construction.
 * This context is assembled by the GMI and contains all relevant information
 * needed for intelligent contextual element selection and prompt adaptation.
 * @interface PromptExecutionContext
 */
export interface PromptExecutionContext {
  /** The currently active persona definition, guiding overall behavior and prompt structure. */
  activePersona: IPersonaDefinition;
  /** Access to the GMI's working memory for dynamic value retrieval (e.g., user preferences, GMI traits). */
  workingMemory: IWorkingMemory;
  /** Current mood state of the GMI, which can influence tone and element selection. */
  currentMood?: string;
  /** Assessed or declared user skill level (e.g., 'beginner', 'expert') relevant to the task. */
  userSkillLevel?: 'beginner' | 'intermediate' | 'advanced' | 'expert' | string;
  /** Hint about the current task type (e.g., 'coding', 'writing', 'data_analysis'). */
  taskHint?: string;
  /** Assessed complexity level of the current task (e.g., 'simple', 'complex'). */
  taskComplexity?: 'simple' | 'moderate' | 'complex' | 'highly_complex' | string;
  /** Target language for the response (BCP-47 code, e.g., 'en-US', 'fr-FR'). */
  language?: string;
  /** Signals detected in the conversation (e.g., 'user_confused', 'task_completed_successfully'). */
  conversationSignals?: string[];
  /** Custom context flags for specialized prompting scenarios or A/B testing. */
  customContext?: Record<string, unknown>;
  /** User-specific preferences that affect prompting (e.g., verbosity, preferred formats). */
  userPreferences?: Record<string, unknown>;
  /** Historical interaction patterns that inform adaptation (e.g., preferred response styles). */
  interactionHistorySummary?: {
    // Summary rather than full history to keep context lean
    successfulInteractionCount: number;
    problematicInteractionCount: number;
    commonTopics?: string[];
    lastInteractionTimestamp?: string;
  };
  /** Current session metadata (e.g., duration, number of turns). */
  sessionMetadata?: {
    sessionDurationSeconds: number;
    interactionCountInSession: number;
    userEngagementLevel?: 'low' | 'medium' | 'high'; // Assessed engagement
  };
}

/**
 * Core components that form the foundation of any prompt construction.
 * These are gathered from various sources (GMI state, user input, RAG) and then
 * augmented with dynamically selected contextual elements.
 * @interface PromptComponents
 */
export interface PromptComponents {
  /** System-level prompts with optional priority ordering. Higher priority usually means placed earlier or given more weight. */
  systemPrompts?: Array<{ content: string; priority?: number; source?: string }>;
  /** Conversation history messages, typically an array of `Message` objects. */
  conversationHistory?: Message[]; // Using Message type (aliased ConversationMessage)
  /**
   * How many messages at the end of `conversationHistory` belong to the turn
   * being answered: the current user message when it travels as history
   * (structured input), then the assistant tool calls and tool results of
   * the turn's earlier calls. Token budgeting summarizes or truncates only
   * the messages before them, so the model always receives the request it
   * answers and its own tool rounds. Defaults to 0.
   */
  currentTurnMessageCount?: number;
  /** Current user input text. */
  userInput?: string | null; // Can be null if interaction is driven by other means (e.g., tool result)
  /** Visual inputs (images) if the target model supports vision. */
  visionInputs?: VisionInputData[];
  /** Audio input data references if the model or a pre-processing step handles audio. */
  audioInput?: AudioInputData; // Reference, actual audio data handled by GMI/tools
  /** Available tools and their schemas, for models that support function/tool calling. */
  tools?: ITool[]; // ITool should define the schema in a way that can be formatted (e.g., JSON Schema)
  /**
   * Pre-formatted tool/function schemas that should be forwarded to the model as-is.
   * Useful when upstream logic has already normalized the schema definitions.
   */
  toolSchemas?: Array<Record<string, unknown>>;
  /** Retrieved context from a RAG system, to be incorporated into the prompt. */
  retrievedContext?:
    | string
    | Array<{ source: string; content: string; relevance?: number; type?: string }>;
  /** Assembled cognitive memory context (personality-affected, token-budgeted). Merged with retrievedContext by the prompt template. */
  assembledMemoryContext?: import('../../cognition/memory/core/types.js').AssembledMemoryContext;
  /** Task-specific data or parameters that need to be included in the prompt. */
  taskSpecificData?: Record<string, unknown>;
  /** Additional custom components that templates might use. */
  customComponents?: Record<string, unknown>;
}

/**
 * Information about the target AI model that affects prompt construction.
 * This guides template selection, token limits, and capability-specific formatting.
 * @interface ModelTargetInfo
 */
export interface ModelTargetInfo {
  /** Unique identifier of the target model (e.g., "gpt-4o", "ollama/llama3"). */
  modelId: string;
  /** Identifier of the provider hosting the model (e.g., "openai", "ollama"). */
  providerId: string;
  /** Maximum context length in tokens supported by the model. */
  maxContextTokens: number;
  /**
   * Optional: Optimal context length for best performance/cost-efficiency, if different from max.
   * Prompts might be targeted to this length.
   */
  optimalContextTokens?: number;
  /** A list of functional capabilities of the model (e.g., 'tool_use', 'vision_input', 'json_mode'). */
  capabilities: string[];
  /**
   * The type of prompt format the model expects.
   * 'openai_chat': Standard OpenAI chat completion format (array of messages).
   * 'anthropic_messages': Anthropic Messages API format (messages array + optional system prompt).
   * 'generic_completion': A single string prompt for older completion-style models.
   * 'custom': A custom format handled by a specific template.
   */
  promptFormatType: 'openai_chat' | 'anthropic_messages' | 'generic_completion' | 'custom' | string; // string for extensibility
  /** Configuration for tool/function calling support. */
  toolSupport: {
    supported: boolean;
    /** Format expected by the model for tool definitions and calls. */
    format: 'openai_functions' | 'anthropic_tools' | 'google_tools' | 'custom' | string;
    /** Maximum number of tools that can be defined or called in a single interaction. */
    maxToolsPerCall?: number;
  };
  /** Vision input support configuration. */
  visionSupport?: {
    supported: boolean;
    maxImages?: number;
    supportedFormats?: string[]; // e.g., ["image/jpeg", "image/png", "image/webp"]
    maxImageResolution?: string; // e.g., "2048x2048"
  };
  /** Audio input support configuration (more likely for pre-processing than direct model input). */
  audioSupport?: {
    supported: boolean; // Indicates if model can directly process audio references or requires transcription first
    requiresTranscription?: boolean;
  };
  /** Model-specific hints for optimizing prompt construction or token budgeting. */
  optimizationHints?: {
    preferredSystemPromptLength?: number; // Target length for system prompts
    optimalHistoryMessages?: number; // Ideal number of history messages
    tokenBudgetingStrategy?: 'aggressive_truncate' | 'summarize_old' | 'balanced'; // How to handle overflow
  };
}

/**
 * The final formatted prompt ready for submission to an LLM provider.
 * The structure varies based on the target model's requirements.
 * - `ChatMessage[]`: For models like OpenAI Chat.
 * - `string`: For older text completion models.
 * - `object`: For models with more complex input structures (e.g., Anthropic Messages API which takes an object with `messages` and `system`).
 * @type FormattedPrompt
 */
export type FormattedPrompt =
  | ChatMessage[]
  | string
  | {
      messages: ChatMessage[];
      system?: string; // For models like Anthropic that separate system prompt
      tools?: any[]; // Formatted tools for the specific API
      [key: string]: any; // For other provider-specific top-level fields
    };

/**
 * Comprehensive result object returned by prompt construction, containing
 * the formatted prompt, metadata, issues encountered, and optimization information.
 * @interface PromptEngineResult
 */
export interface PromptEngineResult {
  /** The final formatted prompt ready for LLM consumption. */
  prompt: FormattedPrompt;
  /**
   * Formatted tool schemas compatible with the target model's API, if tools are used.
   * The structure of `any[]` depends on `ModelTargetInfo.toolSupport.format`.
   */
  formattedToolSchemas?: any[];
  /** Estimated token count of the constructed prompt before precise provider counting. */
  estimatedTokenCount?: number;
  /** Precise token count, if available from a tokenizer or after construction. */
  tokenCount?: number;
  /** Any issues (errors, warnings, info) encountered during prompt construction. */
  issues?: Array<{
    type: 'error' | 'warning' | 'info';
    code: string; // e.g., 'TOKEN_LIMIT_EXCEEDED', 'MISSING_COMPONENT', 'UNSUPPORTED_MODALITY'
    message: string;
    details?: unknown; // Additional context about the issue
    suggestion?: string; // Suggested fix or action
    component?: string; // Component related to the issue (e.g., 'history', 'rag_context')
  }>;
  /** Indicates if content was truncated or summarized to fit token limits. */
  wasTruncatedOrSummarized: boolean;
  /** Details about modifications made during construction (e.g., which components were truncated). */
  modificationDetails?: {
    originalEstimatedTokenCount?: number;
    truncatedComponents?: string[]; // List of component names that were truncated
    summarizedComponents?: string[]; // List of component names that were summarized
    removedComponents?: string[]; // List of components entirely removed
    addedContextualElementIds?: string[]; // IDs of contextual elements incorporated
  };
  /** Performance metrics and metadata related to the prompt construction process. */
  metadata: {
    // Made non-optional
    constructionTimeMs: number;
    selectedContextualElementIds: string[]; // IDs of ContextualPromptElements used
    templateUsed: string; // Name of the prompt template function used
    totalSystemPromptsApplied: number;
    historyMessagesIncluded: number;
    ragContextTokensUsed?: number; // Tokens from retrievedContext
    [key: string]: unknown; // For other arbitrary metadata
  };
  /** An optional cache key if the result was retrieved from or stored in a cache. */
  cacheKey?: string;
}

/**
 * Configuration options for the PromptEngine's behavior, optimization strategies,
 * and integration with other services like IUtilityAI.
 * @interface PromptEngineConfig
 */
export interface PromptEngineConfig {
  /** Default template name (from `availableTemplates`) to use if none is specified or inferable. */
  defaultTemplateName: string;
  /** A record of available prompt template functions, keyed by template name. */
  availableTemplates: Record<string, PromptTemplateFunction>;
  /** Configuration for token counting strategies. */
  tokenCounting: {
    strategy: 'estimated' | 'precise' | 'hybrid'; // 'hybrid' might use precise for small, estimate for large
    estimationModel?: 'gpt-3.5-turbo' | 'gpt-4' | 'claude-3' | 'generic'; // Basis for heuristic estimation
    // Precise counting would typically rely on provider-specific tokenizers or a universal one like tiktoken.
    // This config doesn't directly include tokenizer instances but guides behavior.
  };
  /** Configuration for managing conversation history within prompts. */
  historyManagement: {
    defaultMaxMessages: number; // Default max number of messages from history to include
    maxTokensForHistory: number; // Overall token budget for the history section
    summarizationTriggerRatio: number; // Ratio of maxTokensForHistory (e.g., 0.8) to trigger summarization
    preserveImportantMessages: boolean; // Attempt to identify and always keep "important" messages
  };
  /** Configuration for managing retrieved context (e.g., from RAG). */
  contextManagement: {
    maxRAGContextTokens: number; // Max tokens allowed for RAG context
    summarizationQualityTier: 'fast' | 'balanced' | 'high_quality'; // Quality for summarizing RAG context
    preserveSourceAttributionInSummary: boolean; // Whether to try and keep source links in summaries
    minContextRelevanceThreshold?: number; // Optional: relevance score to filter RAG snippets
  };
  /** Configuration for selecting and applying contextual elements. */
  contextualElementSelection: {
    /** Max number of elements to apply per type. */
    maxElementsPerType: Partial<Record<ContextualElementType, number>>; // Use Partial if not all types need explicit limits
    defaultMaxElementsPerType: number; // Fallback if a type isn't in maxElementsPerType
    priorityResolutionStrategy: 'highest_first' | 'weighted_random' | 'persona_preference'; // How to pick among high-priority elements
    conflictResolutionStrategy: 'skip_conflicting' | 'merge_compatible' | 'error_on_conflict'; // How to handle conflicting elements
  };
  /** Performance optimization settings. */
  performance: {
    enableCaching: boolean; // Whether to cache prompt construction results
    cacheTimeoutSeconds: number; // How long to keep items in cache
    maxCacheSizeBytes?: number; // Max size of the cache (e.g., in MB or number of entries)
    // parallelProcessing: boolean; // Placeholder for future parallelization of sub-tasks
  };
  /** Debugging and logging settings. */
  debugging?: {
    logConstructionSteps?: boolean;
    includeDebugMetadataInResult?: boolean; // If true, adds more verbose debug info to PromptEngineResult.metadata
    logSelectedContextualElements?: boolean;
  };
  /**
   * Optional tool schema registration manifest enabling per-persona and per-model enable/disable semantics.
   *
   * Structure:
   * ```ts
   * {
   *   [personaId: string]: {
   *     enabledToolIds: string[];
   *     disabledToolIds?: string[];
   *     modelOverrides?: {
   *       [modelId: string]: string[];
   *     };
   *   };
   * }
   * ```
   *
   * Resolution Order when filtering tools for prompt construction:
   *   1. If personaId present in manifest:
   *      a. If modelOverrides[modelId] exists => allowed set = that array (disabledToolIds still removes).
   *      b. Else allowed base = enabledToolIds (if defined) else all runtime tools.
   *      c. Remove any disabledToolIds from allowed set.
   *   2. If personaId absent => all runtime tools (no filtering).
   * Note: Unknown tool IDs in manifest are ignored gracefully.
   */
  toolSchemaManifest?: Record<
    string,
    {
      enabledToolIds?: string[];
      disabledToolIds?: string[];
      modelOverrides?: Record<string, string[]>;
    }
  >;
}

/**
 * Function signature for prompt template implementations.
 * Templates are responsible for taking all processed prompt components and
 * formatting them into the final `FormattedPrompt` structure required by a specific
 * LLM provider or model type.
 * @type PromptTemplateFunction
 * @param {PromptComponents} components - The core and augmented prompt components.
 * @param {ModelTargetInfo} modelInfo - Information about the target AI model.
 * @param {ContextualPromptElement[]} selectedContextualElements - Contextual elements chosen for this prompt.
 * @param {Readonly<PromptEngineConfig>} config - A read-only view of the PromptEngine's current configuration.
 * @param {TokenEstimator} estimateTokenCountFn - A function to estimate token counts, useful within templates.
 * @returns {Promise<FormattedPrompt>} A promise that resolves to the final, formatted prompt.
 */
export type PromptTemplateFunction = (
  components: Readonly<PromptComponents>,
  modelInfo: Readonly<ModelTargetInfo>,
  selectedContextualElements: ReadonlyArray<ContextualPromptElement>,
  config: Readonly<PromptEngineConfig>,
  estimateTokenCountFn: (content: string, modelId?: string) => Promise<number>
) => Promise<FormattedPrompt>;

/**
 * Function signature for estimating token counts.
 * This is passed to templates to allow them to make token-aware decisions.
 * @type TokenEstimator
 */
export type TokenEstimator = (content: string, modelId?: string) => Promise<number>;

/**
 * Interface for utility AI services that assist the PromptEngine with complex
 * content processing tasks like summarization and relevance analysis, specifically
 * tailored for prompt construction needs.
 * This is a focused interface used internally by the PromptEngine.
 * @interface IPromptEngineUtilityAI
 */
export interface IPromptEngineUtilityAI {
  /**
   * Summarizes conversation history to fit within token constraints, attempting to preserve key information.
   * @param {Message[]} messages - The array of conversation messages to summarize.
   * @param {number} targetTokenCount - The desired maximum token count for the summary.
   * @param {Readonly<ModelTargetInfo>} modelInfo - Information about the model for which the summary is being prepared.
   * @param {boolean} [preserveImportantMessages] - If true, attempt to identify and keep important messages verbatim.
   * @returns {Promise<{ summaryMessages: Message[]; originalTokenCount: number; finalTokenCount: number; messagesSummarized: number }>}
   * A summary (which might be a single system message or a condensed list of messages),
   * and metadata about the summarization.
   */
  summarizeConversationHistory(
    messages: ReadonlyArray<Message>,
    targetTokenCount: number,
    modelInfo: Readonly<ModelTargetInfo>,
    preserveImportantMessages?: boolean
  ): Promise<{
    summaryMessages: Message[];
    originalTokenCount: number;
    finalTokenCount: number;
    messagesSummarized: number;
  }>;

  /**
   * Summarizes retrieved RAG context to fit token limits, ideally preserving source attribution if possible.
   * @param {string | Array<{ source: string; content: string; relevance?: number }>} context - The RAG context to summarize.
   * @param {number} targetTokenCount - The desired maximum token count for the summarized context.
   * @param {Readonly<ModelTargetInfo>} modelInfo - Information about the model.
   * @param {boolean} [preserveSourceAttribution] - If true, attempt to retain source information in the summary.
   * @returns {Promise<{ summary: string; originalTokenCount: number; finalTokenCount: number; preservedSources?: string[] }>}
   * The summarized text and metadata.
   */
  summarizeRAGContext(
    context: string | ReadonlyArray<{ source: string; content: string; relevance?: number }>,
    targetTokenCount: number,
    modelInfo: Readonly<ModelTargetInfo>,
    preserveSourceAttribution?: boolean
  ): Promise<{
    summary: string;
    originalTokenCount: number;
    finalTokenCount: number;
    preservedSources?: string[];
  }>;

  /**
   * Analyzes a piece of content for its relevance and importance within the current execution context.
   * This can be used to prioritize which content to include or how to emphasize it.
   * @param {string} content - The text content to analyze.
   * @param {Readonly<PromptExecutionContext>} executionContext - The current execution context.
   * @param {Readonly<ModelTargetInfo>} modelInfo - Information about the model.
   * @returns {Promise<{ relevanceScore: number; importanceScore: number; keywords?: string[]; topics?: string[] }>}
   * Scores and extracted metadata.
   */
  analyzeContentRelevance?(
    content: string,
    executionContext: Readonly<PromptExecutionContext>,
    modelInfo: Readonly<ModelTargetInfo>
  ): Promise<{
    relevanceScore: number;
    importanceScore: number;
    keywords?: string[];
    topics?: string[];
  }>;
}

/**
 * Core interface for the PromptEngine, responsible for intelligent and adaptive
 * prompt construction based on rich contextual information and persona definitions.
 *
 * The PromptEngine serves as the central orchestrator for AgentOS's sophisticated
 * prompting system, capable of dynamically selecting contextual elements,
 * managing token budgets, integrating multi-modal content, and optimizing
 * prompts for different AI models and interaction patterns.
 *
 * @interface IPromptEngine
 */
export interface IPromptEngine {
  /**
   * Initializes the PromptEngine with its configuration and an optional utility AI service.
   * This method must be called successfully before any prompt construction.
   *
   * @async
   * @param {PromptEngineConfig} config - The comprehensive configuration for the engine,
   * including template definitions, token counting strategies, history management rules,
   * contextual element selection parameters, performance settings, and debugging options.
   * @param {IPromptEngineUtilityAI} [utilityAI] - An optional utility AI service instance, conforming to
   * `IPromptEngineUtilityAI`, used for advanced content processing tasks like summarization
   * of conversation history or RAG context within the prompt construction pipeline.
   * @returns {Promise<void>} A promise that resolves when the engine is fully initialized and ready.
   * @throws {PromptEngineError} If the provided configuration is invalid or if a critical
   * initialization step fails (e.g., loading default templates).
   *
   * @example
   * const engine = new PromptEngine();
   * await engine.initialize(myAppConfig.promptEngine, myUtilityAIService);
   */
  initialize(config: PromptEngineConfig, utilityAI?: IPromptEngineUtilityAI): Promise<void>;

  /**
   * The primary method for constructing an adaptive and contextually relevant prompt.
   * This orchestrates the entire pipeline: contextual element evaluation and selection,
   * augmentation of base components, token budget management (including truncation and
   * summarization), and final formatting using a model-appropriate template.
   *
   * @async
   * @param {Readonly<PromptComponents>} baseComponents - The core, static components of the prompt,
   * such as system instructions, conversation history, and current user input. These are read-only
   * to prevent unintended modification by the method.
   * @param {Readonly<ModelTargetInfo>} modelTargetInfo - Detailed information about the target AI model,
   * including its ID, provider, capabilities, token limits, and expected prompt format. This is crucial
   * for tailoring the prompt effectively.
   * @param {Readonly<PromptExecutionContext>} [executionContext] - Optional. The rich runtime context,
   * including active persona, working memory, user state, and task details. This drives the
   * dynamic selection and application of contextual prompt elements.
   * @param {string} [templateName] - Optional. The explicit name of a prompt template to use.
   * If not provided, the engine selects a default template based on `modelTargetInfo.promptFormatType`
   * or the `defaultTemplateName` from its configuration.
   * @returns {Promise<PromptEngineResult>} A promise resolving to a `PromptEngineResult` object,
   * which contains the final formatted prompt, along with metadata about its construction,
   * token counts, any issues encountered, and modifications made.
   * @throws {PromptEngineError} If a non-recoverable error occurs during any stage of prompt
   * construction (e.g., template not found, critical component missing, tokenization failure).
   */
  constructPrompt(
    baseComponents: Readonly<PromptComponents>,
    modelTargetInfo: Readonly<ModelTargetInfo>,
    executionContext?: Readonly<PromptExecutionContext>,
    templateName?: string
  ): Promise<PromptEngineResult>;

  /**
   * Evaluates whether a given set of `ContextualPromptElementCriteria` is satisfied by the current
   * `PromptExecutionContext`. This method is the core of the dynamic adaptation logic, determining
   * which contextual elements are relevant and should be incorporated into the prompt.
   * It supports checking various context aspects like mood, user skill, task hints, working memory values, etc.
   *
   * @async
   * @param {Readonly<ContextualPromptElementCriteria>} criteria - The criteria defined within a `ContextualPromptElement`
   * from the persona definition. These criteria specify the conditions under which the element applies.
   * @param {Readonly<PromptExecutionContext>} context - The current execution context against which
   * the criteria are evaluated.
   * @returns {Promise<boolean>} A promise resolving to `true` if all conditions within the criteria
   * are met (respecting logical operators like AND/OR if defined in criteria), `false` otherwise.
   * @throws {PromptEngineError} If criteria evaluation encounters an unexpected error (e.g., accessing
   * a non-existent working memory key specified in a query).
   */
  evaluateCriteria(
    criteria: Readonly<ContextualPromptElementCriteria>,
    context: Readonly<PromptExecutionContext>
  ): Promise<boolean>;

  /**
   * Estimates the token count for a given piece of text, optionally using a specific model ID
   * to inform a more precise estimation if available (e.g., using a model-specific tokenizer).
   * This is used internally for token budgeting and can also be exposed as a utility.
   *
   * @async
   * @param {string} content - The text content for which to estimate token count.
   * @param {string} [modelId] - Optional. The ID of the target model. If provided, the engine may
   * attempt a more precise tokenization based on this model's characteristics.
   * @returns {Promise<number>} A promise resolving to the estimated number of tokens.
   */
  estimateTokenCount(content: string, modelId?: string): Promise<number>;

  /**
   * Registers a new prompt template function with the engine. This allows for extending
   * the engine's capabilities to support new LLM providers, model families, or specialized
   * prompt formatting requirements dynamically at runtime.
   *
   * @async
   * @param {string} templateName - A unique name to identify the template. If a template with
   * this name already exists, it will be overwritten (a warning may be logged).
   * @param {PromptTemplateFunction} templateFunction - The function that implements the template logic.
   * It receives `PromptComponents`, `ModelTargetInfo`, selected `ContextualPromptElement[]`,
   * engine `config`, and a `tokenEstimatorFn`, and must return a `FormattedPrompt`.
   * @returns {Promise<void>} A promise that resolves when the template is successfully registered.
   * @throws {PromptEngineError} If the `templateName` is invalid or `templateFunction` is not a function.
   */
  registerTemplate(templateName: string, templateFunction: PromptTemplateFunction): Promise<void>;

  /**
   * Validates a given set of prompt components and model information against the engine's
   * understanding of best practices and potential issues. Useful for development, debugging
   * persona definitions, or providing feedback to users designing prompts.
   *
   * @async
   * @param {Readonly<PromptComponents>} components - The prompt components to validate.
   * @param {Readonly<ModelTargetInfo>} modelTargetInfo - Information about the target model.
   * @param {Readonly<PromptExecutionContext>} [executionContext] - Optional. The context in which these
   * components would be used, allowing for context-aware validation.
   * @returns {Promise<{ isValid: boolean; issues: Array<{ type: 'error' | 'warning'; message: string; suggestion?: string }>; recommendations: string[]; }>}
   * An object containing a boolean `isValid` (true if no errors), a list of `issues` found
   * (errors or warnings with messages and suggestions), and a list of `recommendations` for improvement.
   */
  validatePromptConfiguration(
    components: Readonly<PromptComponents>,
    modelTargetInfo: Readonly<ModelTargetInfo>,
    executionContext?: Readonly<PromptExecutionContext>
  ): Promise<{
    isValid: boolean;
    issues: Array<{
      type: 'error' | 'warning';
      code: string;
      message: string;
      suggestion?: string;
      component?: string;
    }>;
    recommendations?: string[];
  }>;

  /**
   * Clears internal caches used by the PromptEngine (e.g., for prompt construction results
   * or token counts). This can be used to free memory or to force re-computation for
   * debugging or after configuration changes.
   *
   * @async
   * @param {string} [selectivePattern] - Optional. A pattern or key to clear only specific
   * cache entries (e.g., "modelId:gpt-4o*"). If omitted, the entire cache is cleared.
   * The exact format of the pattern is implementation-dependent.
   * @returns {Promise<void>} A promise that resolves when the cache clearing operation is complete.
   */
  clearCache(selectivePattern?: string): Promise<void>;

  /**
   * Retrieves current performance and usage statistics from the PromptEngine.
   * This data can be used for monitoring, optimization, and understanding engine behavior.
   *
   * @async
   * @returns {Promise<PromptEngineStats>} A promise resolving to an object containing
   * various statistics like total prompts constructed, average construction time,
   * cache hit rate, error rates, and usage of contextual elements.
   */
  getEngineStatistics(): Promise<{
    totalPromptsConstructed: number;
    averageConstructionTimeMs: number;
    cacheStats: {
      hits: number;
      misses: number;
      currentSize: number;
      maxSize?: number;
      effectivenessRatio: number;
    };
    tokenCountingStats: { operations: number; averageAccuracy?: number }; // Accuracy might be hard to track without ground truth
    contextualElementUsage: Record<string, { count: number; averageEvaluationTimeMs?: number }>;
    errorRatePerType: Record<string, number>; // Errors per error code or type
    performanceTimers: Record<
      string,
      { count: number; totalTimeMs: number; averageTimeMs: number }
    >; // e.g., timers for evaluateCriteria, templateFormatting
  }>;
}

/**
 * Custom error class for all errors originating from the PromptEngine.
 * This allows for specific catching and handling of prompt construction failures.
 * @class PromptEngineError
 * @extends {Error}
 */
export class PromptEngineError extends Error {
  /**
   * A specific error code for programmatic handling (e.g., 'TEMPLATE_NOT_FOUND', 'TOKEN_LIMIT_EXCEEDED_IRRECOVERABLY').
   * @public
   * @readonly
   * @type {string}
   */
  public readonly code: string;

  /**
   * Optional: The specific component or operation within the PromptEngine where the error occurred
   * (e.g., 'TokenBudgeting', 'TemplateFormatting', 'ContextualElementSelection').
   * @public
   * @readonly
   * @type {string | undefined}
   */
  public readonly component?: string;

  /**
   * Optional: Additional structured details about the error, which might include relevant
   * data like modelId, offending component, or configuration issue.
   * @public
   * @readonly
   * @type {unknown | undefined}
   */
  public readonly details?: unknown;

  /**
   * Creates an instance of PromptEngineError.
   * @param {string} message - A human-readable description of the error.
   * @param {string} code - A specific error code (e.g., 'TEMPLATE_NOT_FOUND').
   * @param {string} [component] - The engine component where the error originated.
   * @param {unknown} [details] - Additional context or the underlying error.
   */
  constructor(message: string, code: string, component?: string, details?: unknown) {
    super(message);
    this.name = 'PromptEngineError';
    this.code = code;
    this.component = component;
    this.details = details;
    Object.setPrototypeOf(this, PromptEngineError.prototype); // Ensure instanceof works correctly
  }
}
export type { VisionInputData, AudioInputData };
