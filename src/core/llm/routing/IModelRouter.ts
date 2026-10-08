// File: backend/agentos/core/llm/routing/IModelRouter.ts
/**
 * @fileoverview Defines the interface for the Model Router in AgentOS.
 * The Model Router is responsible for intelligently selecting the most appropriate
 * AI model and provider for a given task or query, based on a variety of criteria
 * such as task requirements, persona preferences, user context, model capabilities,
 * cost, and performance.
 *
 * Implementations of this interface can range from simple rule-based routers
 * to more sophisticated LLM-driven or learning-based routing systems.
 * @module backend/agentos/core/llm/routing/IModelRouter
 */

import { IProvider, ModelInfo } from '../providers/IProvider';
import { IPersonaDefinition } from '../../../cognition/substrate/personas/IPersonaDefinition';
import type { ISubscriptionTier } from '../../types/auth';

/**
 * Parameters provided to the model router to aid in its selection process.
 * This context allows the router to make informed decisions.
 */
export interface ModelRouteParams {
  /** A hint or classification of the current task (e.g., "code_generation", "summarization", "general_chat"). */
  taskHint: string;
  /** The ID of the GMI or agent instance making the request. */
  requestingAgentId?: string; // GMI instance ID or a simpler agent ID
  /** The ID of the active persona guiding the interaction. */
  personaId?: string;
  /** The full active persona definition. */
  activePersona?: IPersonaDefinition; // Providing full persona for richer context
  /** The ID of the user initiating the request. */
  userId?: string;
  /** The subscription tier of the user, which might affect model availability or preference. */
  userSubscriptionTier?: ISubscriptionTier; // Providing full tier info
  /** The user's query or the primary input text for the task. */
  query?: string;
  /** The target language for the model's output (e.g., "en", "es", "ja"). */
  language?: string;
  /**
   * A preference for optimizing model selection (e.g., for speed, cost, or quality).
   * This can guide the router if multiple suitable models are found.
   */
  optimizationPreference?: 'cost' | 'speed' | 'quality' | 'balanced';
  /**
   * Explicitly required capabilities for the model (e.g., "tool_use", "vision_input", "json_mode").
   * The router must ensure the selected model supports all listed capabilities.
   */
  requiredCapabilities?: string[];
  /**
   * A list of preferred model IDs, if any. The router should try to use one of these if suitable.
   */
  preferredModelIds?: string[];
  /**
   * A list of preferred provider IDs, if any.
   */
  preferredProviderIds?: string[];
  /**
   * A list of model IDs that should be excluded from consideration.
   */
  excludedModelIds?: string[];
  /**
   * Maximum acceptable cost per 1000 input tokens (in USD), if cost is a critical factor.
   */
  maxCostPerKInputTokens?: number;
  /**
   * Maximum acceptable cost per 1000 output tokens (in USD).
   */
  maxCostPerKOutputTokens?: number;
  /** User-provided API keys for specific providers, which might enable access to certain models. */
  userApiKeys?: Record<string, string>; // ProviderId -> ApiKey
  /** Additional custom parameters or context to aid routing decisions. */
  customContext?: Record<string, any>;

  /**
   * Content policy tier governing this request. Drives model selection:
   * safe/standard use default censored models, mature/private-adult route
   * to uncensored models via PolicyAwareRouter.
   */
  policyTier?: 'safe' | 'standard' | 'mature' | 'private-adult';

  /**
   * Finer-grained content intent hint. A mature session doing combat narration
   * vs. romance has different model preferences.
   */
  contentIntent?: 'general' | 'romantic' | 'erotic' | 'violent' | 'horror';
}

/**
 * The result of a model routing decision.
 * It specifies the selected provider, model, and provides reasoning for the choice.
 */
export interface ModelRouteResult {
  /** The selected AI model provider instance. */
  provider: IProvider;
  /** The ID of the selected model on the chosen provider. */
  modelId: string;
  /** Detailed information about the selected model. */
  modelInfo: ModelInfo;
  /** A human-readable explanation of why this model and provider were chosen. */
  reasoning: string;
  /**
   * A confidence score (0.0 to 1.0) indicating the router's certainty in this selection.
   * Higher values mean higher confidence.
   */
  confidence: number;
  /** An optional classification of the estimated cost tier for this model (e.g., "low", "medium", "high"). */
  estimatedCostTier?: 'low' | 'medium' | 'high' | string;
  /** Any additional metadata related to the routing decision (e.g., matched rule ID, performance estimates). */
  metadata?: Record<string, any>;
}

/**
 * Interface for the Model Router.
 * Implementations are responsible for selecting an appropriate AI model and provider
 * based on the given parameters and context.
 */
export interface IModelRouter {
  /** A unique identifier for this specific router implementation. */
  readonly routerId: string;

  /**
   * The content policy tier this router applies when a request carries none.
   * Fallback walkers build a routed call's chain for it. Routers without a
   * default leave it undefined.
   */
  readonly policyTier?: 'safe' | 'standard' | 'mature' | 'private-adult';

  /**
   * Initializes the model router with its configuration and necessary dependencies,
   * such as the AIModelProviderManager for accessing information about available models and providers.
   *
   * @async
   * @param {Record<string, any>} config - Router-specific configuration (e.g., rules, model preferences).
   * @param {any} providerManager - An instance of AIModelProviderManager or a similar service
   * that provides access to available models and providers.
   * @param {any} [promptEngine] - Optional: An instance of PromptEngine, if the router uses LLM-based routing decisions.
   * @returns {Promise<void>} A promise that resolves upon successful initialization.
   * @throws {Error} If initialization fails (e.g., invalid configuration).
   */
  initialize(
    config: Record<string, any>,
    providerManager: any, // Should be AIModelProviderManager
    promptEngine?: any    // Should be IPromptEngine
  ): Promise<void>;

  /**
   * Selects an AI model and provider based on the provided parameters and the router's internal logic.
   *
   * @async
   * @param {ModelRouteParams} params - The parameters and context for the routing decision.
   * @param {ModelInfo[]} [availableModels] - Optional: A pre-fetched list of available models. If not provided,
   * the router may need to fetch this list from its `providerManager`.
   * @returns {Promise<ModelRouteResult | null>} A promise that resolves with the routing decision,
   * or null if no suitable model/provider could be found that meets the criteria.
   * @throws {Error} If a critical error occurs during the selection process.
   */
  selectModel(
    params: ModelRouteParams,
    availableModels?: ModelInfo[]
  ): Promise<ModelRouteResult | null>;
}
