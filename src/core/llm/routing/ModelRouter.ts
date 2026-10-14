// File: backend/agentos/core/llm/routing/ModelRouter.ts

/**
 * @fileoverview Implements a rule-based model router for AgentOS.
 * This router selects an AI model and provider by evaluating a prioritized list of configurable rules
 * against the provided `ModelRouteParams`. It supports conditions based on task hints,
 * agent IDs, required capabilities, optimization preferences, language, and custom evaluators.
 * If no rules match, it falls back to a configured default model and provider.
 *
 * This implementation aims for clarity, extensibility through custom conditions, and adherence
 * to the `IModelRouter` interface.
 *
 * @module backend/agentos/core/llm/routing/ModelRouter
 * @implements {IModelRouter}
 */

import { IModelRouter, ModelRouteParams, ModelRouteResult } from './IModelRouter';
import { ModelInfo } from '../providers/IProvider';
import { AIModelProviderManager } from '../providers/AIModelProviderManager';
import { contentSafeConsole as console } from '../../logging/contentSafeConsole.js';

/**
 * Custom error class for ModelRouter specific operational errors.
 * @class ModelRouterError
 * @extends {Error}
 */
export class ModelRouterError extends Error {
  /**
   * A unique code identifying the type of error.
   * @example 'INITIALIZATION_FAILED', 'RULE_EVALUATION_ERROR', 'NO_MODEL_MATCHED'
   */
  public readonly code: string;
  /** Optional details or context about the error. */
  public readonly details?: unknown;

  /**
   * Creates an instance of ModelRouterError.
   * @param {string} message - A human-readable description of the error.
   * @param {string} code - A unique code identifying the type of error.
   * @param {unknown} [details] - Optional details or context about the error.
   */
  constructor(message: string, code: string, details?: unknown) {
    super(message);
    this.name = 'ModelRouterError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, ModelRouterError.prototype);
  }
}

/**
 * Defines a single routing rule that determines model selection based on conditions.
 * Rules are evaluated in order of priority.
 */
export interface RoutingRule {
  /** A unique identifier for the rule, useful for logging and debugging. */
  id: string;
  /** An optional description of the rule's purpose and logic. */
  description?: string;
  /**
   * Priority of the rule. Lower numbers are evaluated first.
   * @default 0
   */
  priority?: number;
  /**
   * A set of conditions that must ALL be met for this rule's action to be applied.
   * If a condition field is omitted, it is not checked.
   */
  conditions: {
    /** Keywords or regex patterns to match in `ModelRouteParams.query` or `ModelRouteParams.taskHint`. Case-insensitive. */
    queryOrTaskHintContains?: string[];
    /** Matches `ModelRouteParams.requestingAgentId`. */
    requestingAgentId?: string;
    /** Matches `ModelRouteParams.personaId`. */
    personaId?: string;
    /**
     * All specified capabilities must be present in the candidate model's `ModelInfo.capabilities`.
     * @example ["tool_use", "json_mode"]
     */
    requiredCapabilities?: string[];
    /** Matches `ModelRouteParams.optimizationPreference`. */
    optimizationPreference?: ModelRouteParams['optimizationPreference'];
    /** Matches `ModelRouteParams.language`. */
    language?: string;
    /**
     * Name of a custom condition evaluator function registered with the router.
     * Allows for complex, programmatic condition checking.
     * @example "isUserPremiumTier"
     */
    customCondition?: string;
    /** Parameters to be passed to the `customCondition` evaluator function. */
    customConditionParams?: Record<string, unknown>;
  };
  /** The action to take if all conditions are met, specifying the target model and provider. */
  action: {
    /** ID of the provider to use (must be configured in `AIModelProviderManager`). */
    providerId: string;
    /** ID of the model to use on that provider. */
    modelId: string;
    /** Optional reasoning for this choice, to be included in `ModelRouteResult.reasoning`. */
    reasoning?: string;
    /** Optional classification of the estimated cost tier (e.g., "low", "medium", "high"). */
    estimatedCostTier?: ModelRouteResult['estimatedCostTier'];
  };
}

/**
 * Configuration for the `ModelRouter`.
 */
export interface ModelRouterConfig {
  /**
   * An array of routing rules. These are sorted by priority before evaluation.
   * @see {@link RoutingRule}
   */
  rules: RoutingRule[];
  /**
   * Default provider ID to use if no rules match or if a matched rule's provider is unavailable.
   * This provider must be configured in the `AIModelProviderManager`.
   */
  defaultProviderId: string;
  /**
   * Default model ID to use if no rules match.
   * This model must be available on the `defaultProviderId`.
   */
  defaultModelId: string;
  /** Optional reasoning to use when the default model is selected. */
  defaultReasoning?: string;
  /**
   * A map of custom condition evaluator functions.
   * The key is the `customCondition` string specified in a rule's conditions,
   * and the value is the evaluator function.
   * The function receives `ModelRouteParams` and the rule's `customConditionParams`,
   * and should return `true` if the condition is met, `false` otherwise.
   * @example
   * customConditionEvaluators: {
   * "isUserPremiumTier": async (params, ruleParams) => params.userSubscriptionTier?.isPremium || false
   * }
   */
  customConditionEvaluators?: Record<
    string,
    (params: ModelRouteParams, conditionParams: Record<string, unknown>) => Promise<boolean> | boolean
  >;
}

/**
 * @class ModelRouter
 * @implements {IModelRouter}
 * A rule-based implementation of `IModelRouter`. It selects an AI model by evaluating
 * a configured set of rules in order of priority. This router is designed to be
 * flexible and extensible through declarative rules and custom condition evaluators.
 */
export class ModelRouter implements IModelRouter {
  /** @inheritdoc */
  public readonly routerId = 'rule_based_router_v1.1'; // Version incremented
  private config!: ModelRouterConfig; // Marked as definitely assigned due to initialize
  private providerManager!: AIModelProviderManager;
  private isInitialized: boolean = false;

  /**
   * Constructs a ModelRouter instance.
   * The router must be initialized via `initialize()` before use.
   */
  constructor() {}

  /**
   * Ensures the router has been properly initialized.
   * @private
   * @throws {ModelRouterError} If not initialized.
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new ModelRouterError(
        'ModelRouter is not initialized. Call initialize() first.',
        'NOT_INITIALIZED'
      );
    }
  }

  /** @inheritdoc */
  public async initialize(
    config: ModelRouterConfig, // Using the more specific ModelRouterConfig
    providerManager: AIModelProviderManager,
    // PromptEngine is not used by this rule-based router implementation, but kept for interface compliance if needed elsewhere.
    _promptEngine?: any
  ): Promise<void> {
    if (!config) {
      throw new ModelRouterError("Configuration object is required for ModelRouter initialization.", 'INIT_CONFIG_MISSING');
    }
    if (!config.rules || !Array.isArray(config.rules)) {
      throw new ModelRouterError("Configuration 'rules' array is required.", 'INIT_RULES_MISSING');
    }
    if (!config.defaultProviderId || !config.defaultModelId) {
      throw new ModelRouterError(
        "Configuration requires 'defaultProviderId' and 'defaultModelId'.",
        'INIT_DEFAULTS_MISSING'
      );
    }
    if (!providerManager) {
      throw new ModelRouterError(
        'AIModelProviderManager instance is required for ModelRouter initialization.',
        'INIT_PROVIDER_MANAGER_MISSING'
      );
    }

    this.config = {
      ...config,
      rules: [...config.rules].sort((a, b) => (a.priority || 0) - (b.priority || 0)), // Sort rules by priority
      customConditionEvaluators: config.customConditionEvaluators || {},
      defaultReasoning: config.defaultReasoning || 'Default model selection as no specific rules matched.',
    };
    this.providerManager = providerManager;
    this.isInitialized = true;
    console.log(`ModelRouter (${this.routerId}) initialized with ${this.config.rules.length} rules.`);
  }

  /** @inheritdoc */
  public async selectModel(
    params: ModelRouteParams,
    availableModels?: ModelInfo[] // Router can use this or fetch its own
  ): Promise<ModelRouteResult | null> {
    this.ensureInitialized();

    const allKnownModels = availableModels || await this.providerManager.listAllAvailableModels();
    if (allKnownModels.length === 0) {
        console.warn("ModelRouter: No models available from AIModelProviderManager. Cannot route.");
        return null;
    }

    const contextQuery = params.query?.toLowerCase() || '';
    const contextTaskHint = params.taskHint?.toLowerCase() || '';
    const combinedSearchText = `${contextQuery} ${contextTaskHint}`.trim();

    for (const rule of this.config.rules) {
      let conditionsMet = true;

      // Check queryOrTaskHintContains
      if (rule.conditions.queryOrTaskHintContains) {
        if (!combinedSearchText || !rule.conditions.queryOrTaskHintContains.some(keyword => combinedSearchText.includes(keyword.toLowerCase()))) {
          conditionsMet = false;
        }
      }

      // Check requestingAgentId
      if (conditionsMet && rule.conditions.requestingAgentId && rule.conditions.requestingAgentId !== params.requestingAgentId) {
        conditionsMet = false;
      }

      // Check personaId
      if (conditionsMet && rule.conditions.personaId && rule.conditions.personaId !== params.personaId) {
        conditionsMet = false;
      }

      // Check optimizationPreference
      if (conditionsMet && rule.conditions.optimizationPreference && rule.conditions.optimizationPreference !== params.optimizationPreference) {
        conditionsMet = false;
      }

      // Check language
      if (conditionsMet && rule.conditions.language && rule.conditions.language.toLowerCase() !== params.language?.toLowerCase()) {
        conditionsMet = false;
      }

      // If basic conditions met, fetch target model info to check capabilities
      let targetModelInfo: ModelInfo | undefined;
      if (conditionsMet) {
          targetModelInfo = allKnownModels.find(m => m.modelId === rule.action.modelId && m.providerId === rule.action.providerId);
          if (!targetModelInfo) {
              conditionsMet = false; // Target model specified in rule not found/available
          }
      }

      // Check requiredCapabilities against the targetModelInfo
      if (conditionsMet && targetModelInfo && rule.conditions.requiredCapabilities) {
        if (!rule.conditions.requiredCapabilities.every(reqCap => targetModelInfo!.capabilities.includes(reqCap))) {
          conditionsMet = false;
        }
      }

      // Check customCondition
      if (conditionsMet && rule.conditions.customCondition) {
        const evaluator = this.config.customConditionEvaluators![rule.conditions.customCondition];
        if (evaluator) {
          try {
            if (!(await evaluator(params, rule.conditions.customConditionParams || {}))) {
              conditionsMet = false;
            }
          } catch (evalError: unknown) {
            console.error(`ModelRouter: Error evaluating custom condition '${rule.conditions.customCondition}' for rule '${rule.id}':`, evalError);
            conditionsMet = false; // Treat evaluation error as condition not met
          }
        } else {
          console.warn(`ModelRouter: Custom condition evaluator '${rule.conditions.customCondition}' not found for rule '${rule.id}'. Rule skipped.`);
          conditionsMet = false; // Skip rule if evaluator is missing
        }
      }

      if (conditionsMet && targetModelInfo) {
        const provider = this.providerManager.getProvider(targetModelInfo.providerId);
        if (provider?.isInitialized) {
          console.log(`ModelRouter (${this.routerId}): Rule '${rule.id}' matched. Selecting model '${targetModelInfo.modelId}' on provider '${targetModelInfo.providerId}'.`);
          return {
            provider: provider,
            modelId: targetModelInfo.modelId,
            modelInfo: targetModelInfo,
            reasoning: rule.action.reasoning || rule.description || `Matched rule '${rule.id}'`,
            estimatedCostTier: rule.action.estimatedCostTier,
            confidence: 0.9, // High confidence for explicit rule match
            metadata: { matchedRuleId: rule.id, source: this.routerId },
          };
        } else {
          console.warn(`ModelRouter (${this.routerId}): Rule '${rule.id}' matched, but provider '${targetModelInfo.providerId}' for model '${targetModelInfo.modelId}' is not available or initialized.`);
        }
      }
    }

    // If no rules matched, use defaults
    const defaultProvider = this.providerManager.getProvider(this.config.defaultProviderId);
    if (defaultProvider?.isInitialized) {
      const defaultModelInfo = allKnownModels.find(m => m.modelId === this.config.defaultModelId && m.providerId === this.config.defaultProviderId);
      if (defaultModelInfo) {
        console.log(`ModelRouter (${this.routerId}): No specific rules matched. Using default model '${defaultModelInfo.modelId}' on provider '${defaultModelInfo.providerId}'.`);
        return {
          provider: defaultProvider,
          modelId: defaultModelInfo.modelId,
          modelInfo: defaultModelInfo,
          reasoning: this.config.defaultReasoning!,
          confidence: 0.5, // Lower confidence for default
          metadata: { usingDefaults: true, source: this.routerId },
        };
      } else {
          console.warn(`ModelRouter (${this.routerId}): Default model '${this.config.defaultModelId}' on provider '${this.config.defaultProviderId}' not found in available models.`);
      }
    } else {
        console.warn(`ModelRouter (${this.routerId}): Default provider '${this.config.defaultProviderId}' not found or not initialized.`);
    }

    console.error(`ModelRouter (${this.routerId}): No rules matched AND default model/provider configuration is invalid or unavailable. Cannot select a model.`);
    return null; // No model could be selected
  }
}
