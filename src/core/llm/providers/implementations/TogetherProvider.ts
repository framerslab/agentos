// File: backend/agentos/core/llm/providers/implementations/TogetherProvider.ts

/**
 * @fileoverview Implements the IProvider interface for Together AI's inference API.
 *
 * Together AI exposes a fully OpenAI-compatible `/v1/chat/completions` endpoint,
 * so this provider delegates to the existing {@link OpenAIProvider} with Together's
 * base URL and credentials. The wrapper provides Together-specific provider ID,
 * default model catalog, and configuration.
 *
 * @module backend/agentos/core/llm/providers/implementations/TogetherProvider
 * @implements {IProvider}
 */

import {
  IProvider,
  ChatMessage,
  ModelCompletionOptions,
  ModelCompletionResponse,
  ModelInfo,
  ProviderEmbeddingOptions,
  ProviderEmbeddingResponse,
} from '../IProvider';
import { OpenAIProvider } from './OpenAIProvider';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the TogetherProvider.
 *
 * @example
 * const config: TogetherProviderConfig = {
 *   apiKey: process.env.TOGETHER_API_KEY!,
 *   defaultModelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
 * };
 */
export interface TogetherProviderConfig {
  /** Together API key. Sourced from `TOGETHER_API_KEY`. */
  apiKey: string;
  /**
   * Base URL override.
   * @default "https://api.together.xyz/v1"
   */
  baseURL?: string;
  /**
   * Default model to use when none is specified.
   * @default "meta-llama/Llama-3.3-70B-Instruct-Turbo"
   */
  defaultModelId?: string;
  /** Request timeout in milliseconds. @default 60000 */
  requestTimeout?: number;
}

// ---------------------------------------------------------------------------
// Known model catalog
// ---------------------------------------------------------------------------

/**
 * Static catalog of Together AI serverless chat models (served per Together's
 * model list, checked 2026-09-30). The Llama 3.1 Turbo and Mixtral 8x7B ids
 * were removed from serverless in February to April 2026. Llama 3.3 70B is
 * the only served chat model that neither reasons by default nor lacks
 * function calling or structured outputs, so it is the default.
 */
const TOGETHER_MODELS: ModelInfo[] = [
  {
    modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    providerId: 'together',
    displayName: 'Llama 3.3 70B Instruct Turbo',
    description: 'Meta Llama 3.3 70B on Together serverless; function calling and structured outputs.',
    capabilities: ['chat', 'tool_use'],
    contextWindowSize: 131072,
    pricePer1MTokensInput: 1.04,
    pricePer1MTokensOutput: 1.04,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'openai/gpt-oss-120b',
    providerId: 'together',
    displayName: 'GPT-OSS 120B',
    description: 'OpenAI open-weight reasoning model on Together serverless (always reasons).',
    capabilities: ['chat', 'tool_use'],
    contextWindowSize: 131072,
    pricePer1MTokensInput: 0.15,
    pricePer1MTokensOutput: 0.6,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'zai-org/GLM-5.3-Flash',
    providerId: 'together',
    displayName: 'GLM-5.3 Flash',
    description: 'Z.ai GLM-5.3 Flash on Together serverless (thinking on by default).',
    capabilities: ['chat', 'tool_use'],
    contextWindowSize: 1048575,
    pricePer1MTokensInput: 0.15,
    pricePer1MTokensOutput: 0.5,
    supportsStreaming: true,
    status: 'active',
  },
];

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * @class TogetherProvider
 * @implements {IProvider}
 *
 * Thin wrapper around {@link OpenAIProvider} that targets Together AI's
 * OpenAI-compatible API endpoint. Together hosts a wide range of open-source
 * models (Llama, Mixtral, etc.) with competitive pricing and fast inference.
 *
 * @example
 * const together = new TogetherProvider();
 * await together.initialize({ apiKey: process.env.TOGETHER_API_KEY! });
 * const res = await together.generateCompletion(
 *   'meta-llama/Llama-3.3-70B-Instruct-Turbo', messages, {},
 * );
 */
export class TogetherProvider implements IProvider {
  /** @inheritdoc */
  public readonly providerId: string = 'together';
  /** @inheritdoc */
  public isInitialized: boolean = false;
  /** @inheritdoc */
  public defaultModelId?: string;

  /**
   * Internal OpenAI provider instance that handles the actual API communication.
   * Together's API is fully OpenAI-compatible, so we reuse the OpenAI transport layer.
   */
  private delegate = new OpenAIProvider();

  constructor() {}

  /**
   * Initializes the provider by configuring the underlying OpenAI delegate
   * with Together's base URL and the caller's API key.
   *
   * @param {TogetherProviderConfig} config - Together-specific configuration.
   * @returns {Promise<void>}
   * @throws {Error} If the API key is missing.
   */
  public async initialize(config: TogetherProviderConfig): Promise<void> {
    if (!config.apiKey) {
      throw new Error('API key is required for TogetherProvider. Set TOGETHER_API_KEY.');
    }

    this.defaultModelId = config.defaultModelId ?? 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

    // Delegate to OpenAI provider with Together's endpoint
    await this.delegate.initialize({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? 'https://api.together.xyz/v1',
      defaultModelId: this.defaultModelId,
      requestTimeout: config.requestTimeout ?? 60000,
    });

    this.isInitialized = true;
    console.log(`TogetherProvider initialized. Default model: ${this.defaultModelId}.`);
  }

  /** @inheritdoc */
  public async generateCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): Promise<ModelCompletionResponse> {
    return this.delegate.generateCompletion(modelId, messages, options);
  }

  /** @inheritdoc */
  public async *generateCompletionStream(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    yield* this.delegate.generateCompletionStream(modelId, messages, options);
  }

  /**
   * Together AI supports embeddings for some models, delegated to the OpenAI-compatible endpoint.
   *
   * @param {string} modelId - Embedding model ID.
   * @param {string[]} texts - Texts to embed.
   * @param {ProviderEmbeddingOptions} [options] - Embedding options.
   * @returns {Promise<ProviderEmbeddingResponse>} Embedding response.
   */
  public async generateEmbeddings(
    modelId: string,
    texts: string[],
    options?: ProviderEmbeddingOptions,
  ): Promise<ProviderEmbeddingResponse> {
    return this.delegate.generateEmbeddings(modelId, texts, options);
  }

  /**
   * Returns a static catalog of well-known Together-hosted models.
   *
   * @param {{ capability?: string }} [filter] - Optional capability filter.
   * @returns {Promise<ModelInfo[]>} Together model catalog.
   */
  public async listAvailableModels(filter?: { capability?: string }): Promise<ModelInfo[]> {
    if (filter?.capability) {
      return TOGETHER_MODELS.filter(m => m.capabilities.includes(filter.capability!));
    }
    return [...TOGETHER_MODELS];
  }

  /** @inheritdoc */
  public async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    return TOGETHER_MODELS.find(m => m.modelId === modelId);
  }

  /** @inheritdoc */
  public async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    return this.delegate.checkHealth();
  }

  /** @inheritdoc */
  public async shutdown(): Promise<void> {
    await this.delegate.shutdown();
    this.isInitialized = false;
    console.log('TogetherProvider shutdown complete.');
  }
}
