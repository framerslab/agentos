// File: backend/agentos/core/llm/providers/implementations/AtlasCloudProvider.ts

/**
 * @fileoverview Implements the IProvider interface for Atlas Cloud's
 * OpenAI-compatible LLM endpoint.
 *
 * Atlas Cloud exposes `/v1/chat/completions` with OpenAI-shaped request and
 * response payloads, so this provider reuses the OpenAIProvider transport while
 * keeping Atlas Cloud credentials, endpoint defaults, and model catalog separate
 * from OpenAI.
 *
 * @module backend/agentos/core/llm/providers/implementations/AtlasCloudProvider
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

export interface AtlasCloudProviderConfig {
  /** Atlas Cloud API key. Sourced from `ATLASCLOUD_API_KEY`. */
  apiKey: string;
  /**
   * Base URL override.
   * @default "https://api.atlascloud.ai/v1"
   */
  baseURL?: string;
  /**
   * Default model to use when none is specified.
   * @default "deepseek-ai/deepseek-v4-pro"
   */
  defaultModelId?: string;
  /** Request timeout in milliseconds. @default 60000 */
  requestTimeout?: number;
}

const ATLAS_CLOUD_MODELS: ModelInfo[] = [
  {
    modelId: 'deepseek-ai/deepseek-v4-pro',
    providerId: 'atlascloud',
    displayName: 'DeepSeek V4 Pro',
    description: 'Long-context reasoning model served through Atlas Cloud.',
    capabilities: ['chat', 'tool_use', 'json_mode', 'structured_outputs'],
    contextWindowSize: 1048576,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'qwen/qwen3.5-flash',
    providerId: 'atlascloud',
    displayName: 'Qwen3.5 Flash',
    description: 'Fast long-context chat model served through Atlas Cloud.',
    capabilities: ['chat'],
    contextWindowSize: 1000000,
    supportsStreaming: true,
    status: 'active',
  },
];

/**
 * Thin wrapper around {@link OpenAIProvider} for Atlas Cloud's
 * OpenAI-compatible LLM API.
 */
export class AtlasCloudProvider implements IProvider {
  /** @inheritdoc */
  public readonly providerId: string = 'atlascloud';
  /** @inheritdoc */
  public isInitialized: boolean = false;
  /** @inheritdoc */
  public defaultModelId?: string;

  private delegate = new OpenAIProvider();

  public async initialize(config: AtlasCloudProviderConfig): Promise<void> {
    if (!config.apiKey) {
      throw new Error('API key is required for AtlasCloudProvider. Set ATLASCLOUD_API_KEY.');
    }

    this.defaultModelId = config.defaultModelId ?? 'deepseek-ai/deepseek-v4-pro';

    await this.delegate.initialize({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? 'https://api.atlascloud.ai/v1',
      defaultModelId: this.defaultModelId,
      requestTimeout: config.requestTimeout ?? 60000,
    });

    this.isInitialized = true;
    console.log(`AtlasCloudProvider initialized. Default model: ${this.defaultModelId}.`);
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

  public async generateEmbeddings(
    _modelId: string,
    _texts: string[],
    _options?: ProviderEmbeddingOptions,
  ): Promise<ProviderEmbeddingResponse> {
    throw new Error(
      'Atlas Cloud does not currently expose embeddings in AgentOS. Use a dedicated embedding provider.',
    );
  }

  public async listAvailableModels(filter?: { capability?: string }): Promise<ModelInfo[]> {
    if (filter?.capability) {
      const { capability } = filter;
      return ATLAS_CLOUD_MODELS.filter(m => m.capabilities.includes(capability));
    }
    return [...ATLAS_CLOUD_MODELS];
  }

  /** @inheritdoc */
  public async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    return ATLAS_CLOUD_MODELS.find(m => m.modelId === modelId);
  }

  /** @inheritdoc */
  public async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    return this.delegate.checkHealth();
  }

  /** @inheritdoc */
  public async shutdown(): Promise<void> {
    await this.delegate.shutdown();
    this.isInitialized = false;
    console.log('AtlasCloudProvider shutdown complete.');
  }
}
