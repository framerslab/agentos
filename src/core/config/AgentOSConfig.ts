// File: backend/agentos/config/AgentOSConfig.ts
/**
 * @fileoverview Centralized configuration factory for AgentOS.
 * This module provides the `createAgentOSConfig` function that assembles
 * all required configurations and service instances needed to initialize
 * the AgentOS system. It handles environment variable reading, service
 * instantiation, and configuration validation.
 *
 * @module backend/agentos/config/AgentOSConfig
 */

import { PrismaClient } from '../storage/prismaClient.js';
import type { AgentOSConfig } from '../../api/AgentOS.js';
import type { ExternalToolRegistry } from '../../api/runtime/externalToolRegistry.js';
import type { AdaptableToolInput } from '../../api/runtime/toolAdapter.js';
import type { GMIManagerConfig } from '../../cognition/substrate/GMIManager.js';
import type { AgentOSOrchestratorConfig } from '../../api/types/OrchestratorConfig.js';
import type { PromptEngineConfig } from '../llm/IPromptEngine.js';
import { ToolOrchestratorConfig } from './ToolOrchestratorConfig';
import type { ToolPermissionManagerConfig } from '../tools/permissions/IToolPermissionManager.js';
import type { ConversationManagerConfig } from '../conversation/ConversationManager.js';
import type { StreamingManagerConfig } from '../streaming/StreamingManager.js';
import type {
  AIModelProviderManagerConfig,
  ProviderConfigEntry,
} from '../llm/providers/AIModelProviderManager.js';
import type { PersonaLoaderConfig } from '../../cognition/substrate/personas/IPersonaLoader.js';

import type { IUtilityAI } from '../../cognition/nlp/ai_utilities/IUtilityAI.js';
import type { IPromptEngineUtilityAI } from '../llm/IPromptEngine.js';

// Utility for error handling
import { GMIError, GMIErrorCode } from '../utils/errors.js';

/**
 * Environment-based configuration interface.
 * Defines expected environment variables with their types and defaults.
 */
export interface EnvironmentConfig {
  // Database
  DATABASE_URL: string;

  // OAuth Configuration
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_CALLBACK_URL?: string;

  // LLM Provider Configuration
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  SERPER_API_KEY?: string;
  OLLAMA_BASE_URL?: string;

  // LemonSqueezy Integration
  LEMONSQUEEZY_API_KEY?: string;
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  LEMONSQUEEZY_STORE_ID?: string;

  // Application Configuration
  DEFAULT_PERSONA_ID?: string;
  NODE_ENV?: string;

  // Feature Flags
  ENABLE_PERSISTENCE?: string;
  ENABLE_UTILITY_AI?: string;
  MAX_CONCURRENT_STREAMS?: string;
  MAX_TOOL_CALL_ITERATIONS?: string;
}

/**
 * Configuration validation result interface.
 */
export interface ConfigValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates the environment configuration for required variables.
 *
 * @param env - The environment configuration object
 * @returns Validation result with errors and warnings
 */
export function validateEnvironmentConfig(env: Partial<EnvironmentConfig>): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required variables
  if (!env.DATABASE_URL) {
    errors.push('Missing required environment variable: DATABASE_URL');
  }

  // Warnings for missing optional but recommended variables
  if (
    !env.OPENAI_API_KEY &&
    !env.ANTHROPIC_API_KEY &&
    !env.OPENROUTER_API_KEY &&
    !env.OLLAMA_BASE_URL
  ) {
    warnings.push('No LLM provider API keys configured. AgentOS will have limited functionality.');
  }

  if (!env.DEFAULT_PERSONA_ID) {
    warnings.push('DEFAULT_PERSONA_ID not set. Will use fallback default.');
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Reads and validates environment configuration.
 *
 * @returns Validated environment configuration
 * @throws GMIError if required environment variables are missing
 */
export function getEnvironmentConfig(): EnvironmentConfig {
  const env: Partial<EnvironmentConfig> = {
    DATABASE_URL: process.env.DATABASE_URL,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_CALLBACK_URL: process.env.GOOGLE_CALLBACK_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    LEMONSQUEEZY_API_KEY: process.env.LEMONSQUEEZY_API_KEY,
    LEMONSQUEEZY_WEBHOOK_SECRET: process.env.LEMONSQUEEZY_WEBHOOK_SECRET,
    LEMONSQUEEZY_STORE_ID: process.env.LEMONSQUEEZY_STORE_ID,
    // Prefer V by default; fall back to Nerf if V not present in a deployment
    DEFAULT_PERSONA_ID: process.env.DEFAULT_PERSONA_ID || 'v_researcher',
    NODE_ENV: process.env.NODE_ENV || 'development',
    ENABLE_PERSISTENCE: process.env.ENABLE_PERSISTENCE || 'true',
    ENABLE_UTILITY_AI: process.env.ENABLE_UTILITY_AI || 'false',
    MAX_CONCURRENT_STREAMS: process.env.MAX_CONCURRENT_STREAMS || '1000',
    MAX_TOOL_CALL_ITERATIONS: process.env.MAX_TOOL_CALL_ITERATIONS || '5',
  };

  // If DATABASE_URL isn't set, fall back to a local SQLite file so the
  // out-of-the-box `AgentOS.create()` factory works in scratch / scripting
  // contexts without forcing the user to wire a database first. Production
  // deployments should still set DATABASE_URL explicitly; this default only
  // kicks in when nothing else has been configured.
  if (!env.DATABASE_URL) {
    env.DATABASE_URL = 'file:./agentos.sqlite';
    process.env.DATABASE_URL = env.DATABASE_URL;
  }

  const validation = validateEnvironmentConfig(env);

  // Log warnings
  if (validation.warnings.length > 0) {
    console.warn('AgentOS Configuration Warnings:');
    validation.warnings.forEach((warning) => console.warn(`  - ${warning}`));
  }

  // Throw error if validation fails
  if (!validation.isValid) {
    const errorMessage = `AgentOS Configuration Errors:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`;
    throw new GMIError(errorMessage, GMIErrorCode.CONFIGURATION_ERROR, {
      errors: validation.errors,
      warnings: validation.warnings,
    });
  }

  return env as EnvironmentConfig;
}

/**
 * Creates the Persona Loader configuration.
 *
 * @param env - Environment configuration
 * @returns PersonaLoaderConfig
 */
function createPersonaLoaderConfig(env: EnvironmentConfig): PersonaLoaderConfig {
  return {
    personaSource: './personas',
    loaderType: 'file_system',
    options: {
      enableFileWatching: env.NODE_ENV === 'development',
      validationLevel: 'strict',
      defaultPersonaId: env.DEFAULT_PERSONA_ID || 'v_researcher',
      cachePersonaDefinitions: true,
    },
  };
}

/**
 * Creates the AI Model Provider Manager configuration.
 *
 * @param env - Environment configuration
 * @returns AIModelProviderManagerConfig
 */
function createModelProviderManagerConfig(env: EnvironmentConfig): AIModelProviderManagerConfig {
  const providers: ProviderConfigEntry[] = [];

  // OpenAI Provider
  if (env.OPENAI_API_KEY) {
    providers.push({
      providerId: 'openai',
      enabled: true,
      isDefault: true, // Make OpenAI default if available
      config: {
        apiKey: env.OPENAI_API_KEY,
        baseURL: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o',
        maxRetries: 3,
        timeout: 60000,
      },
    });
  }

  // OpenRouter Provider
  if (env.OPENROUTER_API_KEY) {
    providers.push({
      providerId: 'openrouter',
      enabled: true,
      isDefault: !env.OPENAI_API_KEY, // Default to OpenRouter if OpenAI not available
      config: {
        apiKey: env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
        // Mini, deliberately: any model-less OpenRouter resolution (bare
        // chain entries, null-router fallthroughs) lands on this default,
        // and 'openai/gpt-4o' made that silent path the top LLM spend
        // twice (2026-06-07, 2026-07-02). Callers that want a stronger
        // model must name it explicitly.
        defaultModel: 'openai/gpt-4o-mini',
        maxRetries: 3,
        timeout: 60000,
      },
    });
  }

  // Ollama Provider (local)
  if (env.OLLAMA_BASE_URL) {
    providers.push({
      providerId: 'ollama',
      enabled: true,
      isDefault: !env.OPENAI_API_KEY && !env.OPENROUTER_API_KEY,
      config: {
        baseURL: env.OLLAMA_BASE_URL,
        defaultModel: 'llama3.2',
        timeout: 120000, // Longer timeout for local models
      },
    });
  }

  // Ensure at least one provider is marked as default
  if (providers.length > 0 && !providers.some((p) => p.isDefault)) {
    providers[0].isDefault = true;
  }

  return { providers };
}

/**
 * Creates a LemonSqueezy service instance (stub for now).
 * In a real implementation, this would be a proper service class.
 */
function _createLemonSqueezyService(_env: EnvironmentConfig) {
  return {
    initialize: async () => {
      /* implementation */
    },
    verifyWebhookSignature: (_rawBody: string, _signature: string) => true,
    processWebhookEvent: async (_eventName: string, _data: any) => {
      /* implementation */
    },
  };
}

/**
 * Creates a utility AI service instance if enabled.
 * This is a placeholder - implement based on your UtilityAI implementation.
 *
 * @param env - Environment configuration
 * @returns UtilityAI service or undefined
 */
async function createUtilityAIService(
  env: EnvironmentConfig
): Promise<(IUtilityAI & IPromptEngineUtilityAI) | undefined> {
  if (env.ENABLE_UTILITY_AI === 'true') {
    try {
      const { StatisticalUtilityAI } = await import('../../cognition/nlp/ai_utilities/StatisticalUtilityAI.js');
      const utilityAI = new StatisticalUtilityAI();
      return utilityAI as unknown as IUtilityAI & IPromptEngineUtilityAI;
    } catch {
      console.warn('[AgentOS] ENABLE_UTILITY_AI=true but StatisticalUtilityAI failed to load');
    }
  }
  return undefined;
}

export interface CreateAgentOSConfigOptions {
  /**
   * Optional runtime-level registered tools to place on `AgentOSConfig.tools`.
   * These will be registered into the shared `ToolOrchestrator` during
   * `AgentOS.initialize(...)`.
   */
  tools?: AdaptableToolInput;

  /**
   * Optional stable host-managed tool registry to place on
   * `AgentOSConfig.externalTools`.
   */
  externalTools?: ExternalToolRegistry;
}

/**
 * Main function to create the complete AgentOS configuration.
 *
 * @param options - Optional runtime tool inputs to apply to the generated config.
 * @returns Promise resolving to a complete AgentOSConfig
 * @throws GMIError if configuration creation fails
 */
export async function createAgentOSConfig(
  options: CreateAgentOSConfigOptions = {}
): Promise<AgentOSConfig> {
  console.log('AgentOS Config: Starting configuration creation...');

  try {
    // Load and validate environment
    const env = getEnvironmentConfig();

    // Create Prisma client
    const prisma = new PrismaClient();
    console.log('AgentOS Config: Prisma client stub initialized');

    const defaultPersonaId = env.DEFAULT_PERSONA_ID || 'v_researcher';

    // Create and initialize services
    const utilityAIService = await createUtilityAIService(env);

    // Create individual component configurations
    const gmiManagerConfig: GMIManagerConfig = {
      personaLoaderConfig: createPersonaLoaderConfig(env),
      defaultGMIInactivityCleanupMinutes: 60,
      defaultWorkingMemoryType: 'in_memory',
      defaultGMIBaseConfigDefaults: {
        defaultLlmProviderId: 'openai',
        defaultLlmModelId: 'gpt-4o',
      },
    };

    const orchestratorConfig: AgentOSOrchestratorConfig = {
      maxToolCallIterations: parseInt(env.MAX_TOOL_CALL_ITERATIONS || '5'),
      defaultAgentTurnTimeoutMs: 120000,
      enableConversationalPersistence: env.ENABLE_PERSISTENCE === 'true',
    };

    const promptEngineConfig: PromptEngineConfig = {
      defaultTemplateName: 'openai_chat',
      availableTemplates: {},
      tokenCounting: {
        strategy: 'estimated',
        estimationModel: 'gpt-3.5-turbo',
      },
      historyManagement: {
        defaultMaxMessages: 40,
        maxTokensForHistory: 4000,
        summarizationTriggerRatio: 0.8,
        preserveImportantMessages: true,
      },
      contextManagement: {
        maxRAGContextTokens: 1500,
        summarizationQualityTier: 'balanced',
        preserveSourceAttributionInSummary: true,
      },
      contextualElementSelection: {
        maxElementsPerType: {},
        defaultMaxElementsPerType: 3,
        priorityResolutionStrategy: 'highest_first',
        conflictResolutionStrategy: 'skip_conflicting',
      },
      performance: {
        enableCaching: true,
        cacheTimeoutSeconds: 120,
      },
    };

    const toolOrchestratorConfig: ToolOrchestratorConfig = {
      orchestratorId: 'default-tool-orchestrator',
      defaultToolCallTimeoutMs: 30000,
      maxConcurrentToolCalls: 10,
      logToolCalls: env.NODE_ENV === 'development',
      globalDisabledTools: [],
      toolRegistrySettings: {
        allowDynamicRegistration: true,
        persistRegistry: false,
      },
    };

    const toolPermissionManagerConfig: ToolPermissionManagerConfig = {
      strictCapabilityChecking: true,
      logToolCalls: env.NODE_ENV === 'development',
      toolToSubscriptionFeatures: {
        // Example: map specific tools to subscription features
        advanced_search_tool: [
          {
            flag: 'FEATURE_ADVANCED_SEARCH',
            description: 'Access to advanced search capabilities',
          },
        ],
      },
    };

    const turnPlanning = {
      enabled: true,
      defaultToolFailureMode: 'fail_open' as const,
      allowRequestOverrides: true,
      discovery: {
        enabled: true,
        autoInitializeEngine: true,
        registerMetaTool: true,
        onlyAvailable: true,
        defaultKind: 'any' as const,
        includePromptContext: true,
        defaultToolSelectionMode: 'discovered' as const,
        maxRetries: 1,
        retryBackoffMs: 150,
      },
    };

    const conversationManagerConfig: ConversationManagerConfig = {
      defaultConversationContextConfig: {
        maxHistoryLengthMessages: 100,
        enableAutomaticSummarization: true,
        messagesToKeepVerbatimTail: 5,
        messagesToKeepVerbatimHead: 2,
      },
      maxActiveConversationsInMemory: 1000,
      inactivityTimeoutMs: 3600000,
      persistenceEnabled: env.ENABLE_PERSISTENCE === 'true',
    };

    const streamingManagerConfig: StreamingManagerConfig = {
      maxConcurrentStreams: parseInt(env.MAX_CONCURRENT_STREAMS || '1000'),
      defaultStreamInactivityTimeoutMs: 300000, // 5 minutes
      maxClientsPerStream: 10,
      onClientSendErrorBehavior: 'log_and_continue',
    };

    const modelProviderManagerConfig = createModelProviderManagerConfig(env);

    // Assemble final configuration
    const extensionSecrets: Record<string, string> = {};
    if (env.OPENAI_API_KEY) extensionSecrets['openai.apiKey'] = env.OPENAI_API_KEY;
    if (env.OPENROUTER_API_KEY) extensionSecrets['openrouter.apiKey'] = env.OPENROUTER_API_KEY;
    if (env.ANTHROPIC_API_KEY) extensionSecrets['anthropic.apiKey'] = env.ANTHROPIC_API_KEY;
    if (env.SERPER_API_KEY) extensionSecrets['serper.apiKey'] = env.SERPER_API_KEY;

    const config: AgentOSConfig = {
      gmiManagerConfig,
      orchestratorConfig,
      promptEngineConfig,
      toolOrchestratorConfig,
      toolPermissionManagerConfig,
      conversationManagerConfig,
      streamingManagerConfig,
      modelProviderManagerConfig,
      defaultPersonaId,
      prisma,
      utilityAIService,
      turnPlanning,
      extensionSecrets: Object.keys(extensionSecrets).length ? extensionSecrets : undefined,
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.externalTools ? { externalTools: options.externalTools } : {}),
    };

    console.log('AgentOS Config: Configuration created successfully');
    console.log(`AgentOS Config: Environment: ${env.NODE_ENV}`);
    console.log(`AgentOS Config: Persistence enabled: ${env.ENABLE_PERSISTENCE}`);
    console.log(
      `AgentOS Config: LLM providers configured: ${modelProviderManagerConfig.providers.length}`
    );
    console.log(`AgentOS Config: Default persona: ${defaultPersonaId}`);

    return config;
  } catch (error: any) {
    console.error('AgentOS Config: Failed to create configuration:', error);

    if (error instanceof GMIError) {
      throw error;
    }

    throw new GMIError(
      `Failed to create AgentOS configuration: ${error.message}`,
      GMIErrorCode.CONFIGURATION_ERROR,
      { originalError: error }
    );
  }
}

/**
 * Helper function to create a test configuration for development/testing.
 * This bypasses some environment requirements and uses sensible defaults.
 *
 * @param options - Optional runtime tool inputs to apply to the generated config.
 * @returns Promise resolving to a test AgentOSConfig
 */
export async function createTestAgentOSConfig(
  options: CreateAgentOSConfigOptions = {}
): Promise<AgentOSConfig> {
  // Set minimal test environment
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'file:./test.db';
  }

  return createAgentOSConfig(options);
}
